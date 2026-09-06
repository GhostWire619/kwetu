/**
 * Kwetu engine — `LocalScene`: the floating-origin scene layer and its contact
 * bubble (COORDINATE_SYSTEM.md §1/§8, ADR-002 Decision 2/3).
 *
 * The renderer and Rapier see ONLY this frame (Law P-2); its axes are the
 * anchor's ENU triad (+x east, +y north, +z up), optionally yawed about Up by
 * the anchor's `yawRad` (§8: "a changed ENU anchor rotates axes as well as
 * translating them").
 *
 * Canonical state and rebase (Law P-6, ADR-002 Decision 2 — measured):
 *   - Every entity's ground truth is its `Frame.PlanetFixed(Earth)` state in
 *     f64. Bubble-local coordinates are *derived* from it through the anchor.
 *   - `rebase(newAnchor, mode)` NEVER applies a shift vector to accumulated
 *     f32 solver state — that is the measured contact-killer (ADR-002
 *     evidence C: a naive whole-world f32 translation of +5e6 m injects
 *     −1.0e−3 m / +0.27 m separation errors and silently kills resting
 *     contact). It re-derives every solver transform from canonical f64
 *     state under the new anchor:
 *       p' = Rz(−Δyaw)·(p − t),   v' = Rz(−Δyaw)·v,   q' = q_frame ⊗ q
 *     (the ADR-002 axes form; Δt and Δyaw are the old→new anchor change
 *     expressed in the old local axes — an identity this module is tested
 *     against in f64).
 *   - Modes:
 *       're-derive' — bodies keep their PlanetFixed ground truth (the anchor
 *         moved through the world; the classic floating-origin rebase).
 *       'ride'      — the scene relocates: canonical PlanetFixed states are
 *         shifted by exactly the anchor delta in f64 (the anchor "absorbs"
 *         the delta), so bubble-local coordinates stay small. This is the
 *         ADR-002 measured compliant case (anchor absorbed 5e6 m; local
 *         coordinates stayed ≤ 3.33 m; stability identical to pre-rebase).
 *
 * Physics (Law PH-1, ADR-002 Decision 5): one Rapier world per active local
 * contact bubble — this class holds exactly one; independent locations use
 * independent instances (zero cross-talk by construction, bitwise-verified in
 * ADR-002 evidence C). Z-up, world gravity (0, 0, −9.80665), dt = 1/60,
 * Rapier default solver. Rapier is the bounded f32 solver (Law P-1): its
 * results are promoted to canonical f64 at tick boundaries by `step()`,
 * without claiming lost precision is recovered.
 *
 * Bubble-extent bound: 1e4 m (ADR-002 Decision 4 — the tangent (0,0,−g) model
 * errs 1.57e−3 rad / 0.0154 m/s² laterally at 10 km). Assert in code (Law P-5).
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import {
  TANGENT_G_METRES_PER_S2,
  ecefToEnu,
  enuToEcef,
  ecefToGeodetic,
  geodeticToEcef,
  type GeodeticCoord,
} from './geodesy';
import { f32Downcast } from './precision';
import { addV, quatConjugate, quatDifference, quatMul, quatNorm, quatZ, rotateZ, subV, type Quat, type Vec3 } from './vec3';

/** Physics tick, seconds (ADR-002 Decision 5 solver baseline). */
export const DT_SECONDS = 1 / 60;

/** Bubble extent bound, metres. [MEASURED 2026-09-05 — ADR-002 Decision 4] */
export const BUBBLE_EXTENT_BOUND_METRES = 1e4;

// --- measured acceptance classes (ADR-002 evidence C; the review numbers) ------------

/** Flat resting-contact penetration, metres. [MEASURED 2026-09-05] */
export const RESTING_PENETRATION_FLAT_MEASURED_M = 6.875e-5;
/** 15°-ramp resting-contact penetration, metres. [MEASURED 2026-09-05] */
export const RESTING_PENETRATION_RAMP_MEASURED_M = 1.056e-3;
/** Axes-change rebase: max f32-downcast position residual, metres. [MEASURED 2026-09-05] */
export const REBASE_AXES_POSITION_RESIDUAL_MEASURED_M = 2.44e-5;
/** Axes-change rebase: max orientation residual (quaternion component norm). [MEASURED 2026-09-05] */
export const REBASE_AXES_QUATERNION_RESIDUAL_MEASURED = 6.72e-8;
/** Axes-change rebase: fixed-joint anchor drift afterwards, metres. [MEASURED 2026-09-05] */
export const REBASE_AXES_JOINT_DRIFT_MEASURED_M = 2.38e-7;

// --- anchor ---------------------------------------------------------------------------

/**
 * A typed ENU anchor, its parent body and reference instant — what a
 * `LocalScene` is relative to (COORDINATE_SYSTEM.md §13). All values f64
 * canonical; `yawRad` is the scene's yaw about Up relative to due East
 * (+x scene = East rotated by `yawRad`).
 */
export interface SceneAnchor {
  readonly parentBody: 'Earth';
  readonly geodetic: GeodeticCoord;
  /** Scene yaw about Up, radians, relative to due East (0 = scene +x is East). */
  readonly yawRad: number;
  /** Reference instant of the anchor definition, TT seconds since J2000 TT (§4). */
  readonly referenceWorldTimeTtSeconds: number;
}

// --- canonical state -------------------------------------------------------------------

/**
 * An entity's ground-truth state in `Frame.PlanetFixed(Earth)`, f64 (Law P-1).
 * `orientationQuat` rotates body-local axes into PlanetFixed axes
 * (v_pf = quatRotate(q, v_body)).
 */
export interface CanonicalBodyState {
  readonly id: string;
  /** Planet-fixed position, metres. */
  positionMetres: Vec3;
  /** Planet-fixed velocity, metres/second. */
  velocityMetresPerSecond: Vec3;
  /** Body-local → PlanetFixed orientation. */
  orientationQuat: Quat;
  /** Angular velocity, PlanetFixed axes, radians/second. */
  angularVelocityRadPerSecond: Vec3;
}

/** An entity's bubble-local state in `LocalScene` axes, f64, derived from canonical. */
export interface LocalBodyState {
  readonly id: string;
  /** Bubble-local position, metres. */
  positionMetres: Vec3;
  /** Bubble-local velocity, metres/second. */
  velocityMetresPerSecond: Vec3;
  /** Body-local → LocalScene orientation. */
  orientationQuat: Quat;
}

/** How a rebase treats the canonical ground truth (see {@link LocalScene.rebase}). */
export type RebaseMode = 're-derive' | 'ride';

interface EntityRecord {
  kind: 'dynamic' | 'fixed';
  body: RAPIER.RigidBody;
  canonical: CanonicalBodyState;
}

// --- quaternion from basis rows (private) -----------------------------------------------

type RowMatrix = [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }];

/**
 * Quaternion q with `quatRotate(q, v) = R·v` for the row-matrix R (column-vector
 * convention, rows as given). Standard trace method; requires a proper
 * orthonormal R. Used to turn the anchor's ENU basis into the orientation
 * algebra of the rebase.
 */
function quatFromRowMatrix(rows: RowMatrix): Quat {
  const [r0, r1, r2] = rows;
  const trace = r0.x + r1.y + r2.z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    return { x: (r2.y - r1.z) / s, y: (r0.z - r2.x) / s, z: (r1.x - r0.y) / s, w: 0.25 * s };
  }
  if (r0.x > r1.y && r0.x > r2.z) {
    const s = Math.sqrt(1.0 + r0.x - r1.y - r2.z) * 2;
    return { x: 0.25 * s, y: (r0.y + r1.x) / s, z: (r0.z + r2.x) / s, w: (r2.y - r1.z) / s };
  }
  if (r1.y > r2.z) {
    const s = Math.sqrt(1.0 + r1.y - r0.x - r2.z) * 2;
    return { x: (r0.y + r1.x) / s, y: 0.25 * s, z: (r1.z + r2.y) / s, w: (r0.z - r2.x) / s };
  }
  const s = Math.sqrt(1.0 + r2.z - r0.x - r1.y) * 2;
  return { x: (r0.z + r2.x) / s, y: (r1.z + r2.y) / s, z: 0.25 * s, w: (r1.x - r0.y) / s };
}

// --- runtime init ------------------------------------------------------------------------

let runtimeReady = false;

/**
 * Initialises the deterministic Rapier WASM runtime. Idempotent; must be
 * awaited once before constructing any `LocalScene` (the compat build embeds
 * its WASM, so no fetch is involved).
 */
export async function initLocalSceneRuntime(): Promise<void> {
  if (!runtimeReady) {
    await RAPIER.init();
    runtimeReady = true;
  }
}

// --- LocalScene ---------------------------------------------------------------------------

/**
 * One floating-origin local scene: the canonical f64 registry, its ENU anchor,
 * and the one bounded f32 Rapier world of its contact bubble (Law PH-1).
 */
export class LocalScene {
  private anchor: SceneAnchor;
  private readonly entities = new Map<string, EntityRecord>();
  private readonly world: RAPIER.World;

  constructor(anchor: SceneAnchor) {
    if (!runtimeReady) {
      throw new Error('LocalScene requires initLocalSceneRuntime() to be awaited first (Rapier WASM init)');
    }
    this.anchor = { ...anchor, geodetic: { ...anchor.geodetic } };
    // Law PH-1 / §8: Z-up, tangent gravity (0, 0, −g), dt 1/60 (ADR-002 Decision 5).
    this.world = new RAPIER.World(new RAPIER.Vector3(0, 0, -TANGENT_G_METRES_PER_S2));
    this.world.timestep = DT_SECONDS;
  }

  /** The current anchor (f64 canonical). Mutated only by {@link rebase}. */
  get currentAnchor(): SceneAnchor {
    return this.anchor;
  }

  /** The bounded f32 solver world (Law P-1). One per bubble — never shared. */
  get solverWorld(): RAPIER.World {
    return this.world;
  }

  // --- anchor mapping (the re-derivable hop) ----------------------------------------

  /** `Frame.PlanetFixed(Earth)` → `LocalScene` axes under the CURRENT anchor: p_local = Rz(−yaw)·ENU(p_pf). */
  private pfToLocal(pPf: Vec3, anchor: SceneAnchor): Vec3 {
    return rotateZ(ecefToEnu(pPf, anchor.geodetic), -anchor.yawRad);
  }

  /** `LocalScene` axes → `Frame.PlanetFixed(Earth)` under the CURRENT anchor: p_pf = anchor + Bᵀ·Rz(yaw)·p_local. */
  private localToPf(pLocal: Vec3, anchor: SceneAnchor): Vec3 {
    return enuToEcef(rotateZ(pLocal, anchor.yawRad), anchor.geodetic);
  }

  /** Rows of the §5 ENU basis (east, north, up) in ECEF components at the anchor. */
  private enuBasisRows(anchor: SceneAnchor): RowMatrix {
    const phi = (anchor.geodetic.latitudeDeg * Math.PI) / 180;
    const lam = (anchor.geodetic.longitudeDeg * Math.PI) / 180;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const sl = Math.sin(lam);
    const cl = Math.cos(lam);
    return [
      { x: -sl, y: cl, z: 0 },
      { x: -sp * cl, y: -sp * sl, z: cp },
      { x: cp * cl, y: cp * sl, z: sp },
    ];
  }

  /**
   * The ENU basis quaternion at the anchor: q_B rotates PlanetFixed vectors
   * into ENU components (v_enu = quatRotate(q_B, v_pf)); combined with the
   * anchor yaw this gives the full pf→local orientation map.
   */
  private basisQuaternion(anchor: SceneAnchor): Quat {
    return quatFromRowMatrix(this.enuBasisRows(anchor));
  }

  /** Basis velocity map PlanetFixed → LocalScene: v_local = Rz(−yaw)·(B·v_pf) (Law V-1-free: the anchor triad is fixed). */
  private pfVelocityToLocal(vPf: Vec3, anchor: SceneAnchor): Vec3 {
    const [e, n, u] = this.enuBasisRows(anchor);
    const vEnu = { x: e.x * vPf.x + e.y * vPf.y + e.z * vPf.z, y: n.x * vPf.x + n.y * vPf.y + n.z * vPf.z, z: u.x * vPf.x + u.y * vPf.y + u.z * vPf.z };
    return rotateZ(vEnu, -anchor.yawRad);
  }

  /** Basis velocity map LocalScene → PlanetFixed: v_pf = Bᵀ·Rz(yaw)·v_local. */
  private localVelocityToPf(vLocal: Vec3, anchor: SceneAnchor): Vec3 {
    const [e, n, u] = this.enuBasisRows(anchor);
    const w = rotateZ(vLocal, anchor.yawRad);
    return { x: e.x * w.x + n.x * w.y + u.x * w.z, y: e.y * w.x + n.y * w.y + u.y * w.z, z: e.z * w.x + n.z * w.y + u.z * w.z };
  }

  /** Orientation map PlanetFixed → LocalScene: q_local = q_z(−yaw) ⊗ q_B ⊗ q_pf. */
  private pfOrientationToLocal(qPf: Quat, anchor: SceneAnchor): Quat {
    return quatMul(quatZ(-anchor.yawRad), quatMul(this.basisQuaternion(anchor), qPf));
  }

  /** Orientation map LocalScene → PlanetFixed (inverse of {@link pfOrientationToLocal}). */
  private localOrientationToPf(qLocal: Quat, anchor: SceneAnchor): Quat {
    return quatMul(quatConjugate(this.basisQuaternion(anchor)), quatMul(quatZ(anchor.yawRad), qLocal));
  }

  /** Derives the full bubble-local state of an entity from its canonical f64 state (always re-derived). */
  localStateOf(id: string): LocalBodyState {
    const e = this.entities.get(id);
    if (!e) throw new Error(`Unknown entity "${id}"`);
    return this.deriveLocalState(e.canonical);
  }

  private deriveLocalState(canonical: CanonicalBodyState): LocalBodyState {
    const anchor = this.anchor;
    return {
      id: canonical.id,
      positionMetres: this.pfToLocal(canonical.positionMetres, anchor),
      velocityMetresPerSecond: this.pfVelocityToLocal(canonical.velocityMetresPerSecond, anchor),
      orientationQuat: this.pfOrientationToLocal(canonical.orientationQuat, anchor),
    };
  }

  /**
   * The canonical f64 ground truth of an entity (Law P-1), as a defensive
   * copy. The registry owns the live canonical record; handing it out by
   * reference would let a caller mutate the ground truth outside the
   * tick-boundary promotion path (Law P-1) and desynchronise every
   * re-derivation. Snapshots taken from this method are therefore stable
   * across a rebase.
   */
  canonicalStateOf(id: string): CanonicalBodyState {
    const e = this.entities.get(id);
    if (!e) throw new Error(`Unknown entity "${id}"`);
    const c = e.canonical;
    return {
      id: c.id,
      positionMetres: { ...c.positionMetres },
      velocityMetresPerSecond: { ...c.velocityMetresPerSecond },
      orientationQuat: { ...c.orientationQuat },
      angularVelocityRadPerSecond: { ...c.angularVelocityRadPerSecond },
    };
  }

  /** Spawning helper: bubble-local point → canonical PlanetFixed metres (f64, through the current anchor). */
  planetFixedFromLocal(pLocal: Vec3): Vec3 {
    return this.localToPf(pLocal, this.anchor);
  }

  /** Spawning helper: bubble-local orientation (body-local → LocalScene) → body-local → PlanetFixed. */
  planetFixedOrientationFromLocal(qLocal: Quat): Quat {
    return this.localOrientationToPf(qLocal, this.anchor);
  }

  // --- entity construction ------------------------------------------------------------

  /** Shared collider surface baseline (ADR-002 Decision 5 solver baseline): friction 0.7, restitution 0. */
  private static collider(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
    return desc.setFriction(0.7).setRestitution(0);
  }

  private register(id: string, kind: 'dynamic' | 'fixed', body: RAPIER.RigidBody, canonical: CanonicalBodyState): void {
    if (this.entities.has(id)) throw new Error(`Entity id "${id}" already exists in this bubble`);
    this.entities.set(id, { kind, body, canonical });
  }

  /**
   * Adds a cuboid entity (dynamic or fixed) from its CANONICAL planet-fixed
   * pose. The solver transform is derived from canonical state (f32 downcast
   * at the boundary — Law P-1) — canonical is the ground truth from birth.
   */
  addBox(params: {
    id: string;
    kind: 'dynamic' | 'fixed';
    /** Canonical PlanetFixed centre, metres. */
    planetFixedPositionMetres: Vec3;
    /** Canonical PlanetFixed orientation (body-local → PlanetFixed). */
    planetFixedOrientationQuat?: Quat;
    halfExtentsMetres: Vec3;
    densityKgPerM3?: number;
    /** False adds a colliderless rigid body (e.g. a joint anchor post). Default true. */
    withCollider?: boolean;
  }): void {
    const q = params.planetFixedOrientationQuat ?? { x: 0, y: 0, z: 0, w: 1 };
    const canonical: CanonicalBodyState = {
      id: params.id,
      positionMetres: { ...params.planetFixedPositionMetres },
      velocityMetresPerSecond: { x: 0, y: 0, z: 0 },
      orientationQuat: { ...q },
      angularVelocityRadPerSecond: { x: 0, y: 0, z: 0 },
    };
    const local = this.deriveLocalState(canonical);
    const desc =
      params.kind === 'dynamic'
        ? RAPIER.RigidBodyDesc.dynamic()
        : RAPIER.RigidBodyDesc.fixed();
    const body = this.world.createRigidBody(
      desc
        .setTranslation(local.positionMetres.x, local.positionMetres.y, local.positionMetres.z)
        .setRotation({
          x: f32Downcast(local.orientationQuat.x),
          y: f32Downcast(local.orientationQuat.y),
          z: f32Downcast(local.orientationQuat.z),
          w: f32Downcast(local.orientationQuat.w),
        }),
    );
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      f32Downcast(params.halfExtentsMetres.x),
      f32Downcast(params.halfExtentsMetres.y),
      f32Downcast(params.halfExtentsMetres.z),
    );
    if (params.densityKgPerM3 !== undefined) colliderDesc.setDensity(params.densityKgPerM3);
    if (params.withCollider !== false) {
      this.world.createCollider(LocalScene.collider(colliderDesc), body);
    }
    this.register(params.id, params.kind, body, canonical);
  }

  /**
   * Adds a fixed (rigid) impulse joint between two entities. Joint anchors are
   * body-local (they follow the bodies; ADR-002 evidence C), given in
   * body-local offsets. No joint may span two solvers (Law PH-1) — both ids
   * must live in this scene.
   */
  addFixedJoint(params: { id: string; bodyAId: string; bodyBId: string; anchorLocalAMetres: Vec3; anchorLocalBMetres: Vec3 }): void {
    const a = this.entities.get(params.bodyAId);
    const b = this.entities.get(params.bodyBId);
    if (!a || !b) throw new Error('addFixedJoint: both bodies must exist in this bubble (no joint may span two solvers, Law PH-1)');
    this.world.createImpulseJoint(
      RAPIER.JointData.fixed(
        { x: params.anchorLocalAMetres.x, y: params.anchorLocalAMetres.y, z: params.anchorLocalAMetres.z },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: params.anchorLocalBMetres.x, y: params.anchorLocalBMetres.y, z: params.anchorLocalBMetres.z },
        { x: 0, y: 0, z: 0, w: 1 },
      ),
      a.body,
      b.body,
      true,
    );
  }

  // --- stepping + tick-boundary promotion ----------------------------------------------

  /**
   * Steps the bounded f32 solver once (dt = 1/60), then promotes every dynamic
   * entity's solver state to canonical f64 (Law P-1: promotion at tick
   * boundaries, without claiming lost precision is recovered — the promoted
   * values are exactly the solver's f32 values widened to f64, mapped through
   * the anchor into `Frame.PlanetFixed(Earth)`).
   */
  step(): void {
    this.world.step();
    for (const e of this.entities.values()) {
      if (e.kind !== 'dynamic') continue;
      const p = e.body.translation();
      const v = e.body.linvel();
      const q = e.body.rotation();
      const anchor = this.anchor;
      // Solver f32 state widened to f64, then mapped local → PlanetFixed in f64.
      const pLocal = { x: p.x, y: p.y, z: p.z };
      const qLocal: Quat = { x: q.x, y: q.y, z: q.z, w: q.w };
      e.canonical.positionMetres = this.localToPf(pLocal, anchor);
      e.canonical.velocityMetresPerSecond = this.localVelocityToPf({ x: v.x, y: v.y, z: v.z }, anchor);
      e.canonical.orientationQuat = this.localOrientationToPf(qLocal, anchor);
    }
  }

  /** Steps n ticks. */
  stepN(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  // --- rebase (Law P-6: re-derivation, never translation) -------------------------------

  /**
   * Moves the anchor to `newAnchor` and RE-DERIVES every entity's solver
   * transform from canonical f64 state (Law P-6; ADR-002 Decision 2). The
   * canonical f64 ground truth is updated coherently — in `ride` mode by
   * shifting it by exactly the anchor delta in f64 ("the anchor absorbs the
   * delta"), in `re-derive` mode by leaving it fixed — and then every local
   * transform is recomputed under the new anchor axes and pushed to the solver
   * as the single lawful f32 downcast. A shift vector applied to accumulated
   * f32 solver state is a bug by measurement (ADR-002 evidence C).
   *
   * The axes-change form falls out of the re-derivation: for a yaw change at
   * a fixed anchor it is EXACT in f64 — p' = Rz(−Δyaw)·(p − t), v' =
   * Rz(−Δyaw)·v, q' = q_frame ⊗ q (asserted against the closed form in
   * tests). For an anchor displaced across the ellipsoid the re-derivation
   * additionally carries the ENU-basis tilt between the two anchor points
   * (~1.57e−4 rad per km of displacement [derived — the ADR-002 evidence D
   * direction-error rate d/R]), which the flat closed form omits; the
   * solver's residual against the f64 re-derivation is then the f32 downcast
   * class at the local coordinate magnitude [MEASURED 2.44e−5 m / 0 m/s /
   * 6.72e−8 quat — ADR-002 evidence C, flat local-axes form at ~1 km].
   */
  rebase(newAnchor: SceneAnchor, mode: RebaseMode = 're-derive'): void {
    const old = this.anchor;
    const oldPf = geodeticToEcef(old.geodetic);
    const newPf = geodeticToEcef(newAnchor.geodetic);
    const anchorDelta = subV(newPf, oldPf); // f64 — the anchor's parent-frame move

    if (mode === 'ride') {
      // The scene relocates: every entity rides by the anchor delta, in f64.
      for (const e of this.entities.values()) {
        e.canonical.positionMetres = addV(e.canonical.positionMetres, anchorDelta);
      }
    }
    // (re-derive mode: canonical PlanetFixed ground truth is unchanged.)

    this.anchor = { ...newAnchor, geodetic: { ...newAnchor.geodetic } };

    // Re-derive every solver transform from canonical f64 under the new axes.
    for (const e of this.entities.values()) {
      const local = this.deriveLocalState(e.canonical);
      e.body.setTranslation(
        {
          x: f32Downcast(local.positionMetres.x),
          y: f32Downcast(local.positionMetres.y),
          z: f32Downcast(local.positionMetres.z),
        },
        true,
      );
      e.body.setLinvel(
        {
          x: f32Downcast(local.velocityMetresPerSecond.x),
          y: f32Downcast(local.velocityMetresPerSecond.y),
          z: f32Downcast(local.velocityMetresPerSecond.z),
        },
        true,
      );
      e.body.setRotation(
        {
          x: f32Downcast(local.orientationQuat.x),
          y: f32Downcast(local.orientationQuat.y),
          z: f32Downcast(local.orientationQuat.z),
          w: f32Downcast(local.orientationQuat.w),
        },
        true,
      );
    }
  }

  /**
   * The f64 re-derivation residual against the closed-form axes transform
   * p' = Rz(−Δyaw)·(p − t), v' = Rz(−Δyaw)·v, q' = q_frame ⊗ q (ADR-002
   * Decision 2), built from a pre-rebase local snapshot the caller supplies.
   * For testing and diagnostics — not part of the runtime path.
   */
  closedFormAxesResidual(
    beforeLocal: Map<string, LocalBodyState>,
    translationOldLocalMetres: Vec3,
    yawDeltaRad: number,
  ): { maxPositionResidualMetres: number; maxVelocityResidualMetresPerSecond: number; maxOrientationResidual: number } {
    let maxP = 0;
    let maxV = 0;
    let maxQ = 0;
    for (const e of this.entities.values()) {
      const before = beforeLocal.get(e.canonical.id);
      if (!before) continue;
      const targetP = rotateZ(subV(before.positionMetres, translationOldLocalMetres), -yawDeltaRad);
      const targetV = rotateZ(before.velocityMetresPerSecond, -yawDeltaRad);
      const targetQ = quatMul(quatZ(-yawDeltaRad), before.orientationQuat);
      const now = this.deriveLocalState(e.canonical);
      maxP = Math.max(maxP, Math.hypot(now.positionMetres.x - targetP.x, now.positionMetres.y - targetP.y, now.positionMetres.z - targetP.z));
      maxV = Math.max(
        maxV,
        Math.hypot(
          now.velocityMetresPerSecond.x - targetV.x,
          now.velocityMetresPerSecond.y - targetV.y,
          now.velocityMetresPerSecond.z - targetV.z,
        ),
      );
      maxQ = Math.max(maxQ, quatDifference(now.orientationQuat, targetQ));
    }
    return { maxPositionResidualMetres: maxP, maxVelocityResidualMetresPerSecond: maxV, maxOrientationResidual: maxQ };
  }

  // --- diagnostics ------------------------------------------------------------------------

  /** Largest |bubble-local coordinate| across all entities (the Law P-6 smallness check). */
  maxLocalCoordinateMetres(): number {
    let max = 0;
    for (const e of this.entities.values()) {
      const p = this.deriveLocalState(e.canonical).positionMetres;
      max = Math.max(max, Math.hypot(p.x, p.y, p.z));
    }
    return max;
  }

  /** Asserts the Law P-5 / ADR-002 Decision 4 bubble-extent bound. Throws when violated. */
  assertBubbleExtent(): void {
    const max = this.maxLocalCoordinateMetres();
    if (max > BUBBLE_EXTENT_BOUND_METRES) {
      throw new Error(`Bubble extent bound violated: max local coordinate ${max} m > ${BUBBLE_EXTENT_BOUND_METRES} m (ADR-002 Decision 4, Law P-5)`);
    }
  }

  /** Geodetic position of a bubble-local point (diagnostics/handoff; f64). */
  localToGeodetic(pLocal: Vec3): GeodeticCoord {
    return ecefToGeodetic(this.localToPf(pLocal, this.anchor));
  }

  /** The anchor's PlanetFixed origin, metres (f64). */
  anchorPlanetFixed(): Vec3 {
    return geodeticToEcef(this.anchor.geodetic);
  }

  /** Unit-quaternion sanity for an entity's canonical orientation. */
  canonicalOrientationNorm(id: string): number {
    return quatNorm(this.canonicalStateOf(id).orientationQuat);
  }
}
