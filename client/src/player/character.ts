/**
 * Kwetu player — the walk character controller (Phase 3 groundwork).
 *
 * Renderer-independent, headless avatar movement inside ONE bounded local
 * contact bubble (MASTER_PROMPT §25 "Walk" row, §14 `KinematicCharacterController`;
 * COORDINATE_SYSTEM.md §8, Laws PH-1/P-1/P-6; ADR-002 Decisions 2/4/5). The
 * renderer, terrain-glb colliders, input mapping and yaw-facing are later
 * Phase-3 work; this module validates the controller mechanics only. The human
 * Phase-3 exit criterion ("walk Stone Town seafront at 60 fps") is NOT
 * claimable from here — no renderer, no real terrain.
 *
 * Wiring choice (recorded): the constructor takes a `RAPIER.World` — the caller
 * hands it `someLocalScene.solverWorld` and builds ground/props through the
 * scene, so one Rapier world per bubble (Law PH-1) is preserved and the scene
 * keeps owning its entities. `LocalScene`'s entity registry is cuboid-only
 * today (no capsule/kinematic registration path), so the avatar's canonical
 * state lives HERE, not in the scene registry; {@link rebaseAxes} re-derives
 * the avatar's solver pose with the same ADR-002 axes form the scene's rebase
 * uses, and must be driven by the caller with the same (translation, yawDelta)
 * parameters as `LocalScene.rebase`.
 *
 * Precision law (Laws P-1/P-6, ADR-002 — the B-PREC-01 mechanism, applied to
 * the avatar): the CANONICAL position is a bubble-local f64 `Vec3`, integrated
 * from the KinematicCharacterController's f32 `computedMovement` offsets each
 * tick. The solver body pose is re-derived from canonical f64 every tick (the
 * single lawful f32 downcast) — never accumulated in f32, never shifted. Two
 * distinct error classes must not be conflated [DERIVED 2026-09-06,
 * tests/player/character.test.ts]:
 *   - TRACKING error (canonical f64 vs the sum of the solver's f32 movements):
 *     none beyond f64 addition rounding (~1e-15 m class) — the tracker IS the
 *     exact f64 sum of the f32 offsets;
 *   - CONTROLLER deviation (walked distance vs the kinematic ideal): 7.5e-4 m
 *     over a 180-tick walk — the KCC's per-tick contact maintenance (the
 *     grounded probe presses −g·dt² into the floor and the offset maintenance
 *     clips it back), a bounded mm-class transient, NOT a precision loss.
 *   A pure-f32 position accumulator would additionally round per tick at the
 *   POSITION magnitude (f32 ULP 9.5e-7 m at a 12 m coordinate → ~5.7e-4 m
 *   burned over 600 ticks [DERIVED — the B-PREC-01 mechanism]).
 * The only f32 uses in this module are the three named Rapier boundaries:
 *   1. the desired-movement delta handed to `computeColliderMovement`,
 *   2. the f32 movement/ground results widened OUT of the solver (no recovered
 *      precision is claimed — the f32 result IS what the bounded solver achieved),
 *   3. the solver body pose re-derived from canonical f64 each tick / at rebase.
 *
 * Gravity: the avatar is a kinematic-position body — world gravity does not
 * move it (COORDINATE_SYSTEM.md §8: "Kinematic avatars need explicitly
 * integrated desired movement"), so this module integrates gravity itself in
 * f64, sourced through the `NormalGravitySource` seam (geodesy.ts). Default row:
 * `TANGENT_NORMAL_GRAVITY` (the §8-permitted constant inside a small surface
 * bubble, ADR-002 Decision 4 bound 1e4 m), evaluated once at spawn — constant
 * within the bubble. Moon/Mars walk later passes a body-specific source.
 *
 * Tick cadence (enforced in code, not hoped for — Law P-5 spirit): exactly one
 * `world.step()` (e.g. `LocalScene.step()`) must run between two `update(dt)`
 * calls, and anchor changes must go through {@link rebaseAxes}. `update()`
 * asserts the solver body still matches the canonical f64 pose and throws with
 * a diagnostic otherwise.
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { TANGENT_NORMAL_GRAVITY, type NormalGravitySource } from '../engine/geodesy';
import { f32Downcast, f32Spacing } from '../engine/precision';
import { addV, norm3, quatMul, quatZ, rotateZ, scaleV, subV, type Quat, type Vec3 } from '../engine/vec3';

// --- resolved tuning defaults ---------------------------------------------------
// All gameplay-feel numbers below are [PLACEHOLDER — Phase 3 tuning on real
// terrain; no measured basis yet]. The slope/step/snap semantics they configure
// are Rapier's documented KinematicCharacterController behaviour (control/
// character_controller.d.ts, read 2026-09-06, compat 0.20.0).

/** Max floor-normal tilt from up the character can climb. Rapier-documented gate. */
export const DEFAULT_MAX_SLOPE_CLIMB_ANGLE_RAD = Math.PI / 4;
/** Floor tilt at/above which the controller may slide the character down. */
export const DEFAULT_MIN_SLOPE_SLIDE_ANGLE_RAD = Math.PI / 3;
/** Max ledge height the controller may autostep onto. */
export const DEFAULT_AUTOSTEP_MAX_HEIGHT_METRES = 0.4;
/** Free space required on top of a ledge for the autostep to engage. */
export const DEFAULT_AUTOSTEP_MIN_WIDTH_METRES = 0.3;
/** Snap-to-ground window (keeps contact when walking down slopes/steps). */
export const DEFAULT_SNAP_TO_GROUND_DISTANCE_METRES = 0.25;
/** Gap preserved between the character and its surroundings (must be > 0). */
export const DEFAULT_CONTROLLER_OFFSET_METRES = 0.02;

/**
 * Rapier's capsule primitive is Y-aligned (ColliderDesc.capsule doc). The
 * bubble is Z-up ENU (§8), so the avatar body carries a fixed +90°-about-+X
 * quaternion: body-local +Y (capsule axis) → bubble-local +Z (up). [derived —
 * geometry; the capsule never yaws here, facing is a renderer concern]
 */
const CAPSULE_UPRIGHT_QUAT: Quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

/** Collider surface baseline of the bubble (ADR-002 Decision 5): friction 0.7, restitution 0. */
const COLLIDER_FRICTION = 0.7;
const COLLIDER_RESTITUTION = 0;

// --- options and resolved tuning --------------------------------------------------

export interface CharacterOptions {
  /** Capsule radius, metres. */
  radiusMetres: number;
  /** Capsule cylindrical half-height (between the hemispheres), metres. */
  halfHeightMetres: number;
  /** Walk speed, m/s (horizontal intent magnitude). */
  walkSpeedMetresPerSecond: number;
  /** Run speed, m/s (horizontal intent magnitude while `running`). */
  runSpeedMetresPerSecond: number;
  /** Bubble-local ENU spawn of the capsule CENTRE. Default: 0.1 m above rest over (0, 0). */
  spawnPositionMetres?: Vec3;
  /** Normal-gravity seam (geodesy.ts). Default: the §8 tangent constant row. */
  gravitySource?: NormalGravitySource;
  /** Latitude the gravity seam is evaluated at, degrees. Default 0. */
  gravityLatitudeDeg?: number;
  /** Ellipsoidal height the gravity seam is evaluated at, metres. Default 0. */
  gravityHeightMetres?: number;
  /** Controller up in bubble-local axes (§8: configured explicitly, never defaulted silently). Default +z. */
  upLocal?: Vec3;
  maxSlopeClimbAngleRad?: number;
  minSlopeSlideAngleRad?: number;
  autostepMaxHeightMetres?: number;
  autostepMinWidthMetres?: number;
  /** Whether the autostep may step onto DYNAMIC bodies. Default false. */
  autostepIncludeDynamicBodies?: boolean;
  snapToGroundDistanceMetres?: number;
  controllerOffsetMetres?: number;
}

/** The resolved controller configuration (what the Rapier controller was set to). */
export interface CharacterTuning {
  readonly radiusMetres: number;
  readonly halfHeightMetres: number;
  readonly walkSpeedMetresPerSecond: number;
  readonly runSpeedMetresPerSecond: number;
  readonly maxSlopeClimbAngleRad: number;
  readonly minSlopeSlideAngleRad: number;
  readonly autostepMaxHeightMetres: number;
  readonly autostepMinWidthMetres: number;
  readonly autostepIncludeDynamicBodies: boolean;
  readonly snapToGroundDistanceMetres: number;
  readonly controllerOffsetMetres: number;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`CharacterController: ${name} must be finite and > 0 (got ${value})`);
  }
  return value;
}

function requireSlopeAngle(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > Math.PI / 2) {
    throw new Error(`CharacterController: ${name} must be finite and in (0, pi/2] radians (got ${value})`);
  }
  return value;
}

// --- the character controller -----------------------------------------------------

/**
 * The walk avatar: a kinematic-position Rapier body with an upright capsule,
 * moved through Rapier's `KinematicCharacterController` (hit & slide, slope
 * gates, autostep, snap-to-ground), with its canonical state kept in f64
 * (Laws P-1/P-6) and the solver pose re-derived from it every tick.
 *
 * Canonical state owned here (bubble-local ENU axes, f64):
 *   - `position` — the capsule centre, metres;
 *   - vertical velocity (up-axis scalar; the only stored velocity, invariant
 *     under the ADR-002 z-yaw rebase form);
 *   - the body orientation (the fixed capsule-upright tilt, transformed at rebase).
 */
export class CharacterController {
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly tuning: CharacterTuning;
  private readonly gravityMetresPerSecond2: number;
  private readonly standingOffsetMetres: number;

  /** CANONICAL bubble-local position of the capsule centre, f64 (Law P-1). */
  private positionMetres: Vec3;
  /** CANONICAL body-local → bubble-local orientation, f64. */
  private orientationQuat: Quat;
  /** Controller up in bubble-local axes, f64 (re-derived at rebase). */
  private upLocal: Vec3;
  /** Up-axis vertical velocity, m/s (f64; integrated, not solver-owned). */
  private verticalVelocity: number;
  /** Horizontal intent in bubble-local axes (unit vector) or null for "stand". */
  private desiredDir: Vec3 | null = null;
  private running = false;
  private grounded = false;
  private lastHorizontalSpeed = 0;
  private disposed = false;

  constructor(world: RAPIER.World, options: CharacterOptions) {
    this.world = world;
    const radius = requirePositive(options.radiusMetres, 'radiusMetres');
    const halfHeight = requirePositive(options.halfHeightMetres, 'halfHeightMetres');
    const walk = requirePositive(options.walkSpeedMetresPerSecond, 'walkSpeedMetresPerSecond');
    const run = requirePositive(options.runSpeedMetresPerSecond, 'runSpeedMetresPerSecond');
    const maxClimb = requireSlopeAngle(options.maxSlopeClimbAngleRad ?? DEFAULT_MAX_SLOPE_CLIMB_ANGLE_RAD, 'maxSlopeClimbAngleRad');
    const minSlide = options.minSlopeSlideAngleRad ?? DEFAULT_MIN_SLOPE_SLIDE_ANGLE_RAD;
    if (!Number.isFinite(minSlide) || minSlide < 0 || minSlide > Math.PI / 2) {
      throw new Error(`CharacterController: minSlopeSlideAngleRad must be finite and in [0, pi/2] radians (got ${minSlide})`);
    }
    const autostepMax = requirePositive(options.autostepMaxHeightMetres ?? DEFAULT_AUTOSTEP_MAX_HEIGHT_METRES, 'autostepMaxHeightMetres');
    const autostepMin = requirePositive(options.autostepMinWidthMetres ?? DEFAULT_AUTOSTEP_MIN_WIDTH_METRES, 'autostepMinWidthMetres');
    const snap = requirePositive(options.snapToGroundDistanceMetres ?? DEFAULT_SNAP_TO_GROUND_DISTANCE_METRES, 'snapToGroundDistanceMetres');
    const offset = requirePositive(options.controllerOffsetMetres ?? DEFAULT_CONTROLLER_OFFSET_METRES, 'controllerOffsetMetres');
    this.tuning = {
      radiusMetres: radius,
      halfHeightMetres: halfHeight,
      walkSpeedMetresPerSecond: walk,
      runSpeedMetresPerSecond: run,
      maxSlopeClimbAngleRad: maxClimb,
      minSlopeSlideAngleRad: minSlide,
      autostepMaxHeightMetres: autostepMax,
      autostepMinWidthMetres: autostepMin,
      autostepIncludeDynamicBodies: options.autostepIncludeDynamicBodies ?? false,
      snapToGroundDistanceMetres: snap,
      controllerOffsetMetres: offset,
    };

    // Gravity through the geodesy seam (ADR-002 Decision 6 seam; §8 tangent model
    // default), evaluated ONCE — constant inside a small surface bubble.
    const gravitySource: NormalGravitySource = options.gravitySource ?? TANGENT_NORMAL_GRAVITY;
    this.gravityMetresPerSecond2 = gravitySource.at(options.gravityLatitudeDeg ?? 0, options.gravityHeightMetres ?? 0);

    // The up axis is configured explicitly (§8). Normalised defensively.
    const up = options.upLocal ?? { x: 0, y: 0, z: 1 };
    const upNorm = norm3(up);
    if (!(upNorm > 0)) throw new Error('CharacterController: upLocal must be a non-zero vector');
    this.upLocal = scaleV(up, 1 / upNorm);

    // Rest height of the capsule centre above a floor: halfHeight + radius, plus
    // the controller's preserved gap. [derived — capsule geometry + offset]
    this.standingOffsetMetres = halfHeight + radius + offset;
    const spawn = options.spawnPositionMetres ?? { x: 0, y: 0, z: this.standingOffsetMetres + 0.1 };

    // Canonical f64 state is born from the spawn; the solver gets the lawful f32 downcast.
    this.positionMetres = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.orientationQuat = { ...CAPSULE_UPRIGHT_QUAT };
    this.verticalVelocity = 0;

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(f32Downcast(spawn.x), f32Downcast(spawn.y), f32Downcast(spawn.z))
      .setRotation({
        x: f32Downcast(this.orientationQuat.x),
        y: f32Downcast(this.orientationQuat.y),
        z: f32Downcast(this.orientationQuat.z),
        w: f32Downcast(this.orientationQuat.w),
      });
    this.body = world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setFriction(COLLIDER_FRICTION)
      .setRestitution(COLLIDER_RESTITUTION);
    this.collider = world.createCollider(colliderDesc, this.body);

    this.controller = world.createCharacterController(offset);
    this.controller.setUp({ x: this.upLocal.x, y: this.upLocal.y, z: this.upLocal.z });
    this.controller.setMaxSlopeClimbAngle(maxClimb);
    this.controller.setMinSlopeSlideAngle(minSlide);
    this.controller.enableAutostep(autostepMax, autostepMin, this.tuning.autostepIncludeDynamicBodies);
    this.controller.enableSnapToGround(snap);
    // The avatar does not shove dynamic props in this groundwork phase.
    this.controller.setApplyImpulsesToDynamicBodies(false);
  }

  // --- intent -------------------------------------------------------------------

  /**
   * Sets the horizontal movement intent, in bubble-local ENU axes (this is the
   * frame the caller's input mapping lives in). `dir` is normalised — only its
   * direction matters; pass a zero vector (or `{x:0,y:0,z:0}`) to stand. The
   * speed comes from the tuning (`running ? runSpeed : walkSpeed`). Vertical
   * motion is NOT part of the intent: gravity/jump own the up axis.
   * Must be re-issued after a {@link rebaseAxes} (the axes changed).
   */
  setDesiredMove(dir: Vec3, running: boolean): void {
    this.assertUsable();
    const n = norm3(dir);
    this.desiredDir = n > 0 ? scaleV(dir, 1 / n) : null;
    this.running = running;
  }

  /**
   * Jumps by setting the up-axis velocity to `upwardSpeedMetresPerSecond`
   * (f64). Rapier's KinematicCharacterController has NO jump API (verified in
   * its .d.ts) — the jump lives in this module's own f64 vertical integration.
   * No-op while airborne (jump buffering / coyote time is later Phase-3 work).
   */
  jump(upwardSpeedMetresPerSecond: number): void {
    this.assertUsable();
    if (!Number.isFinite(upwardSpeedMetresPerSecond) || upwardSpeedMetresPerSecond <= 0) {
      throw new Error(`CharacterController.jump requires a finite upward speed > 0 (got ${upwardSpeedMetresPerSecond})`);
    }
    if (!this.grounded) return;
    this.verticalVelocity = upwardSpeedMetresPerSecond;
  }

  // --- the tick -------------------------------------------------------------------

  /**
   * One avatar tick at fixed `dtSeconds` (the ADR-002 solver baseline is 1/60).
   * Integrates gravity in f64, queries the character controller at the body's
   * current (f32) pose, integrates the controller's f32 movement into the
   * canonical f64 position, and re-derives the solver pose from canonical f64.
   *
   * Does NOT step the world: the caller runs exactly one `world.step()`
   * (`LocalScene.step()`) after each `update()` — enforced by the in-sync guard.
   */
  update(dtSeconds: number): void {
    this.assertUsable();
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new Error(`CharacterController.update requires a finite dtSeconds > 0 (got ${dtSeconds})`);
    }
    this.assertSolverInSync();

    // Horizontal intent → f64 delta (bubble-local ENU).
    const speed = this.running ? this.tuning.runSpeedMetresPerSecond : this.tuning.walkSpeedMetresPerSecond;
    const dir = this.desiredDir;
    const dx = dir !== null ? dir.x * speed * dtSeconds : 0;
    const dy = dir !== null ? dir.y * speed * dtSeconds : 0;

    // Gravity, semi-implicit Euler, f64: velocity first, then the displacement.
    this.verticalVelocity -= this.gravityMetresPerSecond2 * dtSeconds;
    const dz = this.verticalVelocity * dtSeconds;

    // Snap-to-ground only ever pulls DOWN; while rising it would yank a jump
    // back to the floor, so it is gated on the velocity sign (per-query state).
    if (this.verticalVelocity > 0) {
      this.controller.disableSnapToGround();
    } else {
      this.controller.enableSnapToGround(this.tuning.snapToGroundDistanceMetres);
    }

    // Rapier f32 boundary #1: the desired delta crosses as f32.
    this.controller.computeColliderMovement(this.collider, {
      x: f32Downcast(dx),
      y: f32Downcast(dy),
      z: f32Downcast(dz),
    });

    // Rapier f32 boundary #2: the solver's f32 answer, widened to f64 (no
    // recovered precision is claimed).
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    }

    // Canonical f64 integration of the f32 movement offsets (Law P-6): the
    // ground truth accumulates in f64; the solver pose below is re-derived.
    this.positionMetres = addV(this.positionMetres, { x: m.x, y: m.y, z: m.z });
    this.lastHorizontalSpeed = Math.hypot(m.x, m.y) / dtSeconds;

    // Rapier f32 boundary #3: re-derive the solver pose from canonical f64.
    this.body.setNextKinematicTranslation({
      x: f32Downcast(this.positionMetres.x),
      y: f32Downcast(this.positionMetres.y),
      z: f32Downcast(this.positionMetres.z),
    });
  }

  // --- rebase (Law P-6 / ADR-002 Decision 2, avatar side) --------------------------

  /**
   * Applies the ADR-002 axes rebase to the avatar's canonical f64 state —
   * p' = Rz(−Δyaw)·(p − t), q' = q_frame ⊗ q — and re-derives the solver pose
   * (the single lawful f32 downcast) plus the controller's up vector. The only
   * stored velocity is the up-axis vertical velocity, invariant under Rz.
   *
   * MUST be driven by the caller at a tick boundary (between update() calls)
   * with the SAME (translation, yawDelta) parameters as the matching
   * `LocalScene.rebase(newAnchor, 're-derive')` of the shared bubble — the
   * avatar is not registered in the scene's entity registry, so the scene
   * cannot move it. In `ride` mode the avatar's local state is unchanged and
   * this method must NOT be called (local coordinates are what it stores).
   * The stored horizontal intent was expressed in the OLD local axes and is
   * cleared; the caller re-issues `setDesiredMove` in the new axes.
   */
  rebaseAxes(translationOldLocalMetres: Vec3, yawDeltaRad: number): void {
    this.assertUsable();
    this.positionMetres = rotateZ(subV(this.positionMetres, translationOldLocalMetres), -yawDeltaRad);
    this.orientationQuat = quatMul(quatZ(-yawDeltaRad), this.orientationQuat);
    this.upLocal = rotateZ(this.upLocal, -yawDeltaRad);
    this.desiredDir = null;

    // Re-derive the solver transforms from canonical f64 (never shift solver state).
    this.body.setTranslation(
      {
        x: f32Downcast(this.positionMetres.x),
        y: f32Downcast(this.positionMetres.y),
        z: f32Downcast(this.positionMetres.z),
      },
      true,
    );
    this.body.setRotation(
      {
        x: f32Downcast(this.orientationQuat.x),
        y: f32Downcast(this.orientationQuat.y),
        z: f32Downcast(this.orientationQuat.z),
        w: f32Downcast(this.orientationQuat.w),
      },
      true,
    );
    this.controller.setUp({ x: this.upLocal.x, y: this.upLocal.y, z: this.upLocal.z });
    // setTranslation/setRotation leave collider poses stale until the next step;
    // the NEXT tick's query runs BEFORE any step, so propagate now (this covers
    // every modified body in the world, including scene entities rebased just
    // before this call).
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  // --- reads ----------------------------------------------------------------------

  /** The CANONICAL bubble-local f64 position of the capsule centre (defensive copy). */
  get position(): Vec3 {
    return { x: this.positionMetres.x, y: this.positionMetres.y, z: this.positionMetres.z };
  }

  /** Ground state reported by the last update's controller query. */
  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Horizontal speed ACTUALLY achieved by the last update (movement/dt), m/s — 0 against a wall. */
  get speed(): number {
    return this.lastHorizontalSpeed;
  }

  /** Up-axis vertical velocity, m/s (f64; 0 while grounded). */
  get verticalVelocityMetresPerSecond(): number {
    return this.verticalVelocity;
  }

  /** The gravity magnitude in use, m/s² (from the NormalGravitySource seam). */
  get gravityMetresPerSecond(): number {
    return this.gravityMetresPerSecond2;
  }

  /** Rest height of the capsule centre above a floor: halfHeight + radius + offset. [derived] */
  get standingHeightMetres(): number {
    return this.standingOffsetMetres;
  }

  /** The resolved configuration (what the Rapier controller was set to). */
  get tuningSnapshot(): CharacterTuning {
    return this.tuning;
  }

  /** The Rapier kinematic body (for tests/diagnostics — the f32 boundary side). */
  get rapierBody(): RAPIER.RigidBody {
    return this.body;
  }

  /** The Rapier capsule collider (for tests/diagnostics). */
  get rapierCollider(): RAPIER.Collider {
    return this.collider;
  }

  /** The underlying Rapier KinematicCharacterController (for tests/diagnostics). */
  get rapierController(): RAPIER.KinematicCharacterController {
    return this.controller;
  }

  /** Capsule bottom (feet) in bubble-local axes, derived from canonical f64. */
  get feetPosition(): Vec3 {
    return { x: this.positionMetres.x, y: this.positionMetres.y, z: this.positionMetres.z - (this.tuning.halfHeightMetres + this.tuning.radiusMetres) };
  }

  // --- lifecycle ------------------------------------------------------------------

  /** Removes the controller and body from the world (bubble teardown). Unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.removeCharacterController(this.controller);
    this.world.removeRigidBody(this.body);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('CharacterController used after dispose()');
  }

  /**
   * The cadence guard: the solver body must sit exactly at the f32 downcast of
   * the canonical f64 position whenever a query is about to run. A mismatch
   * means the caller skipped the world.step() after the previous update() (or
   * moved the body behind this module's back) — the movement would then be
   * computed from a stale pose and silently desync the avatar. Asserted, not
   * hoped for (Law P-5 spirit); tolerance is 2 f32 ULP at the local magnitude.
   */
  private assertSolverInSync(): void {
    const t = this.body.translation();
    const px = f32Downcast(this.positionMetres.x);
    const py = f32Downcast(this.positionMetres.y);
    const pz = f32Downcast(this.positionMetres.z);
    const tol = 2 * Math.max(f32Spacing(px), f32Spacing(py), f32Spacing(pz));
    if (Math.abs(t.x - px) > tol || Math.abs(t.y - py) > tol || Math.abs(t.z - pz) > tol) {
      throw new Error(
        'CharacterController: solver body pose is out of sync with the canonical f64 position. ' +
          'Exactly one world.step() (e.g. LocalScene.step()) must run between update() calls, ' +
          'and anchor changes must go through rebaseAxes (Law P-6: re-derivation, never a shift).',
      );
    }
  }
}
