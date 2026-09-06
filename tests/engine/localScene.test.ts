/**
 * Engine `LocalScene` tests — the floating-origin scene layer and its contact
 * bubble (COORDINATE_SYSTEM.md §1/§8, Laws P-6/PH-1; ADR-002 Decisions 2–5).
 *
 * Thresholds are the S0.1/ADR-002 measured classes, re-measured on THIS module
 * with the spike's exact layout [MEASURED 2026-09-06, values in the comments]:
 * resting penetration 6.8754e-5 m (ADR-002: 6.875e-5), ride-rebase stability
 * identical to pre-rebase, pure-yaw re-derivation EXACT in f64 against the
 * ADR-002 closed form, axes-change joint drift 2.38e-7 m (ADR-002: 2.38e-7),
 * and bitwise zero cross-talk between independent bubbles. Layout note: the
 * hanging joint body is a cuboid here (LocalScene's collider primitive today),
 * not the spike's ball — same clearance from the pad box, same joint classes.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  BUBBLE_EXTENT_BOUND_METRES,
  DT_SECONDS,
  LocalScene,
  initLocalSceneRuntime,
  type CanonicalBodyState,
  type SceneAnchor,
} from '../../client/src/engine/localScene';
import { ecefToGeodetic, enuBasis, type GeodeticCoord } from '../../client/src/engine/geodesy';
import { addV, quatDifference, quatRotate, quatY, quatZ, scaleV, subV, type Vec3 } from '../../client/src/engine/vec3';
import { worldTimeTtFromUtcMillis } from '../../client/src/engine/ephemeris';

const SITE: GeodeticCoord = { latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 };
const T0 = worldTimeTtFromUtcMillis(Date.UTC(2026, 8, 5, 0, 0, 0));
const TILT_RAD = (15 * Math.PI) / 180;
const REBASE_TICK = 120;
const TOTAL_TICKS = 600;
const SETTLE_TICKS = 60;
const YAW_90 = Math.PI / 2;

function anchorAt(geodetic: GeodeticCoord, yawRad = 0): SceneAnchor {
  return { parentBody: 'Earth', geodetic, yawRad, referenceWorldTimeTtSeconds: T0 };
}

/**
 * The S0.1 spike layout, expressed entirely in CANONICAL PlanetFixed poses
 * through the scene's own anchor mapping: ground slab with its TOP at local
 * z = 0, pad box resting on it (1 mm drop), 15° ramp + tilted box held by
 * friction, and a colliderless post + jointed hanging body (1000 kg).
 */
function makeScene(anchor: SceneAnchor = anchorAt(SITE)): LocalScene {
  const scene = new LocalScene(anchor);
  const qId = scene.planetFixedOrientationFromLocal({ x: 0, y: 0, z: 0, w: 1 });
  scene.addBox({ id: 'ground', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: -0.5 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 100, y: 100, z: 0.5 } });
  scene.addBox({ id: 'pad', kind: 'dynamic', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: 0.501 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 0.5, y: 0.5, z: 0.5 }, densityKgPerM3: 1000 });
  const qTiltPf = scene.planetFixedOrientationFromLocal(quatY(TILT_RAD));
  const n = quatRotate(quatY(TILT_RAD), { x: 0, y: 0, z: 1 });
  scene.addBox({ id: 'ramp', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 3, y: 0, z: 0.2 }), planetFixedOrientationQuat: qTiltPf, halfExtentsMetres: { x: 2, y: 1, z: 0.25 } });
  const rampBoxRest = addV(addV({ x: 3, y: 0, z: 0.2 }, scaleV(n, 0.25)), scaleV(n, 0.501));
  scene.addBox({ id: 'rampBox', kind: 'dynamic', planetFixedPositionMetres: scene.planetFixedFromLocal(rampBoxRest), planetFixedOrientationQuat: qTiltPf, halfExtentsMetres: { x: 0.5, y: 0.5, z: 0.5 }, densityKgPerM3: 1000 });
  scene.addBox({ id: 'post', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: 0 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 0.1, y: 0.1, z: 0.1 }, withCollider: false });
  scene.addBox({ id: 'hang', kind: 'dynamic', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: 1.5 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 0.25, y: 0.25, z: 0.25 }, densityKgPerM3: 8000 });
  scene.addFixedJoint({ id: 'joint', bodyAId: 'post', bodyBId: 'hang', anchorLocalAMetres: { x: 0, y: 0, z: 1 }, anchorLocalBMetres: { x: 0, y: 0, z: -0.5 } });
  return scene;
}

interface BubbleMetrics {
  padPenetrationMetres: number;
  padCreepXYMetres: number;
  padSpeedMetresPerSecond: number;
  rampBoxDriftMetres: number;
  jointAnchorDriftMetres: number;
}

/** Contact-stability metrics, measured bubble-locally through canonical f64 state. */
function measure(scene: LocalScene): BubbleMetrics {
  const pad = scene.localStateOf('pad');
  const rampBox = scene.localStateOf('rampBox');
  const post = scene.localStateOf('post');
  const hang = scene.localStateOf('hang');
  // The ramp box's rest pose in the CURRENT local axes: the ideal offset is
  // re-derived through the ramp body's ACTUAL local orientation so the metric
  // stays valid under yawed anchors (rotation invariance of the contact pose).
  const ramp = scene.localStateOf('ramp');
  const nNew = quatRotate(ramp.orientationQuat, { x: 0, y: 0, z: 1 });
  const rampBoxOffset = subV(rampBox.positionMetres, ramp.positionMetres);
  const idealRampOffset = addV(scaleV(nNew, 0.25), scaleV(nNew, 0.5));
  const drift = subV(rampBoxOffset, idealRampOffset);
  const jointDrift = subV(
    addV(hang.positionMetres, quatRotate(hang.orientationQuat, { x: 0, y: 0, z: -0.5 })),
    addV(post.positionMetres, { x: 0, y: 0, z: 1 }),
  );
  return {
    padPenetrationMetres: 0.5 - pad.positionMetres.z,
    padCreepXYMetres: Math.hypot(pad.positionMetres.x, pad.positionMetres.y),
    padSpeedMetresPerSecond: Math.hypot(pad.velocityMetresPerSecond.x, pad.velocityMetresPerSecond.y, pad.velocityMetresPerSecond.z),
    rampBoxDriftMetres: Math.hypot(drift.x, drift.y, drift.z),
    jointAnchorDriftMetres: Math.hypot(jointDrift.x, jointDrift.y, jointDrift.z),
  };
}

function worst(a: BubbleMetrics, b: BubbleMetrics): BubbleMetrics {
  return {
    padPenetrationMetres: Math.max(a.padPenetrationMetres, b.padPenetrationMetres),
    padCreepXYMetres: Math.max(a.padCreepXYMetres, b.padCreepXYMetres),
    padSpeedMetresPerSecond: Math.max(a.padSpeedMetresPerSecond, b.padSpeedMetresPerSecond),
    rampBoxDriftMetres: Math.max(a.rampBoxDriftMetres, b.rampBoxDriftMetres),
    jointAnchorDriftMetres: Math.max(a.jointAnchorDriftMetres, b.jointAnchorDriftMetres),
  };
}

function runWindow(scene: LocalScene, from: number, to: number): BubbleMetrics {
  let w = measure(scene);
  for (let i = from; i < to; i++) {
    scene.step();
    w = worst(w, measure(scene));
  }
  return w;
}

beforeAll(async () => {
  await initLocalSceneRuntime();
  await initLocalSceneRuntime(); // idempotent
});

describe('engine/localScene — construction and the canonical↔local mapping', () => {
  it('configures the Law PH-1/§8 world: Z-up, gravity (0,0,−9.80665), dt 1/60', () => {
    const scene = makeScene();
    expect(scene.solverWorld.gravity.x).toBe(0);
    expect(scene.solverWorld.gravity.y).toBe(0);
    expect(scene.solverWorld.gravity.z).toBe(-9.80665);
    // The solver stores its own config in f32 (Law P-1: Rapier IS the f32
    // boundary) — dt 1/60 survives as 0.016666668, exact to the f32 class.
    expect(Math.abs(scene.solverWorld.timestep - DT_SECONDS)).toBeLessThan(1e-8);
    expect(BUBBLE_EXTENT_BOUND_METRES).toBe(1e4); // ADR-002 Decision 4
  });

  it('spawn-from-canonical round trips: localStateOf re-derives the spawned local pose', () => {
    const scene = makeScene();
    for (const [id, local] of [
      ['ground', { x: 0, y: 0, z: -0.5 }],
      ['pad', { x: 0, y: 0, z: 0.501 }],
      ['ramp', { x: 3, y: 0, z: 0.2 }],
    ] as const) {
      const s = scene.localStateOf(id);
      expect(Math.abs(s.positionMetres.x - local.x)).toBeLessThan(1e-9);
      expect(Math.abs(s.positionMetres.y - local.y)).toBeLessThan(1e-9);
      expect(Math.abs(s.positionMetres.z - local.z)).toBeLessThan(1e-9);
    }
    expect(scene.canonicalStateOf('pad').id).toBe('pad');
  });

  it('canonical ↔ local pose round trips exactly under a yawed anchor', () => {
    const yaw = Math.PI / 5;
    const scene = makeScene(anchorAt(SITE, yaw));
    const localSpawn: Vec3 = { x: 12.3, y: -4.5, z: 2.1 };
    // A deliberately non-identity LOCAL orientation: the canonical form is the
    // anchor map's image (body-local → PlanetFixed), and localStateOf must
    // re-derive exactly the local quaternion we spawned with.
    const qLocalSpawn = quatZ(yaw * 0.5);
    scene.addBox({ id: 'marker', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal(localSpawn), planetFixedOrientationQuat: scene.planetFixedOrientationFromLocal(qLocalSpawn), halfExtentsMetres: { x: 0.5, y: 0.5, z: 0.5 } });
    const s = scene.localStateOf('marker');
    expect(Math.abs(s.positionMetres.x - localSpawn.x)).toBeLessThan(1e-8);
    expect(Math.abs(s.positionMetres.y - localSpawn.y)).toBeLessThan(1e-8);
    expect(Math.abs(s.positionMetres.z - localSpawn.z)).toBeLessThan(1e-8);
    // Orientation round trip through the canonical PlanetFixed form (f64 exact;
    // the residual is the quaternion-algebra rounding class).
    expect(quatDifference(s.orientationQuat, qLocalSpawn)).toBeLessThan(1e-12);
  });

  it('step() promotes solver state to canonical f64 at the tick boundary (Law P-1)', () => {
    const scene = makeScene();
    scene.step();
    const canonical: CanonicalBodyState = scene.canonicalStateOf('pad');
    // The promoted canonical state maps back onto the solver's own local pose.
    const local = scene.localStateOf('pad');
    expect(Math.abs(local.positionMetres.z - 0.5)).toBeLessThan(0.01); // settling 1 mm drop
    // Canonical orientation is a widened f32 quaternion: unit norm within f32 class.
    expect(Math.abs(Math.hypot(canonical.orientationQuat.x, canonical.orientationQuat.y, canonical.orientationQuat.z, canonical.orientationQuat.w) - 1)).toBeLessThan(1e-6);
  });

  it('rejects duplicate entity ids and unknown ids', () => {
    const scene = makeScene();
    expect(() => scene.localStateOf('nope')).toThrow(/Unknown entity/);
    expect(() =>
      scene.addBox({ id: 'pad', kind: 'dynamic', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: 5 }), halfExtentsMetres: { x: 0.1, y: 0.1, z: 0.1 } }),
    ).toThrow(/already exists/);
  });
});

describe('engine/localScene — resting contacts and joints (ADR-002 evidence C classes)', () => {
  it('holds pad + ramp resting contact over 600 ticks', () => {
    const scene = makeScene();
    scene.stepN(SETTLE_TICKS);
    const w = runWindow(scene, SETTLE_TICKS, TOTAL_TICKS);
    // [MEASURED 2026-09-06: pad 6.8754e-5 m — the ADR-002 6.875e-5 class]
    expect(w.padPenetrationMetres).toBeLessThan(2e-4);
    // [MEASURED 2026-09-06: 1.65e-4 m settle-in creep; ADR-002 awake creep ≤ 6.7e-6]
    expect(w.padCreepXYMetres).toBeLessThan(1e-3);
    expect(w.padSpeedMetresPerSecond).toBeLessThan(1e-3);
    // [MEASURED 2026-09-06: 1.44e-4 m drift-from-ideal; ADR-002 ramp penetration 1.056e-3]
    expect(w.rampBoxDriftMetres).toBeLessThan(5e-3);
  });

  it('holds the fixed joint to the ADR-002 zero-drift class over 600 ticks', () => {
    const scene = makeScene();
    scene.stepN(SETTLE_TICKS);
    const w = runWindow(scene, SETTLE_TICKS, TOTAL_TICKS);
    // [MEASURED 2026-09-06: 3.96e-10 m; ADR-002: 0 m]
    expect(w.jointAnchorDriftMetres).toBeLessThan(1e-6);
  });

  it('stays inside the bubble-extent bound and asserts it in code (Law P-5, ADR-002 Decision 4)', () => {
    const scene = makeScene();
    scene.stepN(SETTLE_TICKS);
    // [MEASURED 2026-09-06: 3.3253 m; the spike's ≤ 3.33 m]
    expect(scene.maxLocalCoordinateMetres()).toBeLessThan(3.5);
    expect(() => scene.assertBubbleExtent()).not.toThrow();
  });

  it('throws when a body lands outside the 1e4 m bubble bound', () => {
    const scene = makeScene();
    scene.addBox({ id: 'far', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 20000, y: 0, z: 0 }), halfExtentsMetres: { x: 1, y: 1, z: 1 } });
    expect(() => scene.assertBubbleExtent()).toThrow(/Bubble extent bound/);
  });
});

describe('engine/localScene — ride rebase: the anchor absorbs the delta (Law P-6, ADR-002 Decision 2)', () => {
  it('shifts every canonical PlanetFixed state by the anchor delta in f64 and keeps local coordinates', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const before = new Map(['ground', 'pad', 'ramp', 'rampBox', 'post', 'hang'].map((id) => [id, scene.canonicalStateOf(id)]));
    const oldPf = scene.anchorPlanetFixed();
    const up = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).up;
    const delta = scaleV(up, 5e6);
    const newGeo = ecefToGeodetic(addV(oldPf, delta));
    scene.rebase(anchorAt(newGeo), 'ride');
    // Every canonical state (fixed bodies included) rides by the delta — the
    // anchor absorbed the 5000 km [MEASURED 2026-09-06: max deviation 1e-9 m
    // class, the Bowring-inverse round trip of the new anchor geodetic].
    for (const [id, beforeState] of before) {
      const after = scene.canonicalStateOf(id);
      const moved = subV(after.positionMetres, beforeState.positionMetres);
      expect(Math.abs(moved.x - delta.x)).toBeLessThan(1e-4);
      expect(Math.abs(moved.y - delta.y)).toBeLessThan(1e-4);
      expect(Math.abs(moved.z - delta.z)).toBeLessThan(1e-4);
    }
    // Bubble-local coordinates stay small and unchanged [MEASURED 2026-09-06:
    // maxLocal 3.325252 m, pad local z 0.499931245 m before and after].
    expect(scene.maxLocalCoordinateMetres()).toBeLessThan(3.5);
    const padLocal = scene.localStateOf('pad').positionMetres;
    expect(Math.abs(padLocal.z - 0.499931245)).toBeLessThan(1e-6);
  });

  it('leaves resting contacts and the joint as stable as pre-rebase (the measured verdict)', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const pre = measure(scene);
    const oldPf = scene.anchorPlanetFixed();
    const up = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).up;
    scene.rebase(anchorAt(ecefToGeodetic(addV(oldPf, scaleV(up, 5e6)))), 'ride');
    const w = runWindow(scene, REBASE_TICK, TOTAL_TICKS);
    // [MEASURED 2026-09-06: pad penetration 6.8755e-5 m post vs 6.875e-5 pre —
    // identical to 1.1e-9 m; ADR-002: "stability identical to pre-rebase"]
    expect(w.padPenetrationMetres).toBeLessThan(2e-4);
    expect(Math.abs(w.padPenetrationMetres - pre.padPenetrationMetres)).toBeLessThan(1e-7);
    expect(w.padCreepXYMetres).toBeLessThan(1e-3);
    // No phantom free-fall velocity (the naive-shift signature was 4.9 m/s).
    expect(w.padSpeedMetresPerSecond).toBeLessThan(1e-3);
    // [MEASURED 2026-09-06: 7.7e-10 m]
    expect(w.jointAnchorDriftMetres).toBeLessThan(1e-6);
  });
});

describe('engine/localScene — yaw-only re-derivation is the ADR-002 axes form, EXACTLY', () => {
  it('matches p′ = Rz(−Δyaw)(p − t), v′ = Rz(−Δyaw)v, q′ = q_frame ⊗ q to f64 zero', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const before = new Map(['ground', 'pad', 'ramp', 'rampBox', 'post', 'hang'].map((id) => [id, scene.localStateOf(id)]));
    scene.rebase(anchorAt(SITE, YAW_90), 're-derive');
    const residual = scene.closedFormAxesResidual(before, { x: 0, y: 0, z: 0 }, YAW_90);
    // [MEASURED 2026-09-06: exactly 0 / 0 / 0 in f64 — the re-derivation IS
    // the closed form when the anchor point does not move on the ellipsoid.]
    expect(residual.maxPositionResidualMetres).toBeLessThan(1e-12);
    expect(residual.maxVelocityResidualMetresPerSecond).toBeLessThan(1e-12);
    expect(residual.maxOrientationResidual).toBeLessThan(1e-12);
  });

  it('rotates local coordinates the short way: a body due East lands due South of the yawed axes', () => {
    const scene = makeScene(anchorAt(SITE, 0));
    scene.addBox({ id: 'marker', kind: 'fixed', planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 100, y: 0, z: 0 }), halfExtentsMetres: { x: 0.5, y: 0.5, z: 0.5 } });
    scene.rebase(anchorAt(SITE, YAW_90), 're-derive');
    const p = scene.localStateOf('marker').positionMetres;
    // p′ = Rz(−90°)·(100, 0, 0) = (≈0, −100, 0) — exact in f64 up to cos(π/2) = 6.1e-17.
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
    expect(Math.abs(p.y + 100)).toBeLessThan(1e-9);
    expect(Math.abs(p.z)).toBeLessThan(1e-9);
  });

  it('keeps contacts and the fixed joint in the ADR-002 axes-rebase class after a 90° yaw', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    scene.rebase(anchorAt(SITE, YAW_90), 're-derive');
    const w = runWindow(scene, REBASE_TICK, TOTAL_TICKS);
    expect(w.padPenetrationMetres).toBeLessThan(2e-4); // [MEASURED 2026-09-06: 6.8755e-5 m]
    // [MEASURED 2026-09-06: 2.3828e-7 m — ADR-002's measured 2.38e-7 class]
    expect(w.jointAnchorDriftMetres).toBeLessThan(1e-6);
    expect(w.padSpeedMetresPerSecond).toBeLessThan(1e-3); // [MEASURED 7.6e-7]
  });

  it('re-derive mode never mutates the canonical PlanetFixed ground truth', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const snap = new Map(['ground', 'pad', 'hang'].map((id) => [id, scene.canonicalStateOf(id)]));
    scene.rebase(anchorAt(SITE, YAW_90), 're-derive');
    for (const [id, s] of snap) {
      const now = scene.canonicalStateOf(id);
      expect(now.positionMetres.x).toBe(s.positionMetres.x);
      expect(now.positionMetres.y).toBe(s.positionMetres.y);
      expect(now.positionMetres.z).toBe(s.positionMetres.z);
      expect(now.velocityMetresPerSecond.x).toBe(s.velocityMetresPerSecond.x);
      expect(now.orientationQuat.w).toBe(s.orientationQuat.w);
    }
  });
});

describe('engine/localScene — axes rebase across the ellipsoid (+1 km east, +90° yaw)', () => {
  it('differs from the flat closed form only by the ENU-tilt term (d/R lever, ~1.57e-4 rad/km)', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const before = new Map(['ground', 'pad', 'ramp', 'rampBox', 'post', 'hang'].map((id) => [id, scene.localStateOf(id)]));
    const oldPf = scene.anchorPlanetFixed();
    const east = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).east;
    scene.rebase(anchorAt(ecefToGeodetic(addV(oldPf, scaleV(east, 1000))), YAW_90), 're-derive');
    const residual = scene.closedFormAxesResidual(before, { x: 1000, y: 0, z: 0 }, YAW_90);
    // [MEASURED 2026-09-06: 0.1579 m / 0 m/s / 7.9e-5 — the documented tilt
    // class: 1 km of anchor displacement tilts the ENU plane by d/R ≈ 1.57e-4
    // rad, which over the ~1 km lever is the 0.157 m position term. The flat
    // closed form omits it by construction; the re-derivation carries it.]
    expect(residual.maxPositionResidualMetres).toBeLessThan(0.2);
    expect(residual.maxVelocityResidualMetresPerSecond).toBeLessThan(1e-12);
    expect(residual.maxOrientationResidual).toBeLessThan(1e-4);
  });

  it('preserves relative body geometry (contacts survive the tilt)', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const relBefore = subV(scene.localStateOf('pad').positionMetres, scene.localStateOf('ground').positionMetres);
    const oldPf = scene.anchorPlanetFixed();
    const east = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).east;
    scene.rebase(anchorAt(ecefToGeodetic(addV(oldPf, scaleV(east, 1000))), YAW_90), 're-derive');
    const relAfter = subV(scene.localStateOf('pad').positionMetres, scene.localStateOf('ground').positionMetres);
    const d = subV(relAfter, relBefore);
    // [MEASURED 2026-09-06: 2.2e-4 / 2.3e-4 / 3.5e-8 m — tilt differential over
    // the ~0.5 m pad/ground separation]
    expect(Math.hypot(d.x, d.y, d.z)).toBeLessThan(1e-3);
  });

  it('re-holds the contacts and the joint after the axes change', () => {
    const scene = makeScene();
    scene.stepN(REBASE_TICK);
    const oldPf = scene.anchorPlanetFixed();
    const east = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).east;
    scene.rebase(anchorAt(ecefToGeodetic(addV(oldPf, scaleV(east, 1000))), YAW_90), 're-derive');
    const w = runWindow(scene, REBASE_TICK, TOTAL_TICKS);
    // The joint reconciles the tilt-distorted anchors then holds:
    // [MEASURED 2026-09-06: 1.78e-4 m — the tilt class at 1.5 m joint lever]
    expect(w.jointAnchorDriftMetres).toBeLessThan(1e-3);
    // The pad box stays asleep-stable [MEASURED 2026-09-06: 1.7e-6 m/s].
    expect(w.padSpeedMetresPerSecond).toBeLessThan(1e-4);
    expect(w.rampBoxDriftMetres).toBeLessThan(0.01); // [MEASURED 2026-09-06: settle ≤ 2.4e-3 m/s class]
  });
});

describe('engine/localScene — one world per bubble, zero cross-talk (Law PH-1, ADR-002 Decision 3)', () => {
  it('a neighbour bubble at Oslo changes the Dar bubble bitwise-not-at-all', () => {
    const dar = makeScene();
    const oslo = new LocalScene(anchorAt({ latitudeDeg: 59.9139, longitudeDeg: 10.7522, heightMetres: 0 }));
    const qId = oslo.planetFixedOrientationFromLocal({ x: 0, y: 0, z: 0, w: 1 });
    oslo.addBox({ id: 'ground', kind: 'fixed', planetFixedPositionMetres: oslo.planetFixedFromLocal({ x: 0, y: 0, z: -0.5 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 100, y: 100, z: 0.5 } });
    oslo.addBox({ id: 'pad', kind: 'dynamic', planetFixedPositionMetres: oslo.planetFixedFromLocal({ x: 0, y: 0, z: 0.501 }), planetFixedOrientationQuat: qId, halfExtentsMetres: { x: 0.5, y: 0.5, z: 0.5 }, densityKgPerM3: 1000 });
    const darAlone = makeScene();
    for (let i = 0; i < TOTAL_TICKS; i++) {
      dar.step();
      oslo.step();
      darAlone.step();
    }
    const withNeighbour: CanonicalBodyState = dar.canonicalStateOf('pad');
    const alone: CanonicalBodyState = darAlone.canonicalStateOf('pad');
    // [MEASURED 2026-09-06: bitwise identical — zero cross-talk by construction]
    expect(withNeighbour.positionMetres.x).toBe(alone.positionMetres.x);
    expect(withNeighbour.positionMetres.y).toBe(alone.positionMetres.y);
    expect(withNeighbour.positionMetres.z).toBe(alone.positionMetres.z);
    expect(withNeighbour.velocityMetresPerSecond.x).toBe(alone.velocityMetresPerSecond.x);
    expect(withNeighbour.velocityMetresPerSecond.y).toBe(alone.velocityMetresPerSecond.y);
    expect(withNeighbour.velocityMetresPerSecond.z).toBe(alone.velocityMetresPerSecond.z);
    // The Oslo bubble independently holds its own resting contact
    // [MEASURED 2026-09-06: local z 0.499931246 m].
    expect(oslo.localStateOf('pad').positionMetres.z).toBeGreaterThan(0.4);
    expect(oslo.localStateOf('pad').positionMetres.z).toBeLessThan(0.6);
    // Anchor separation sanity: Dar ↔ Oslo is thousands of km apart.
    const sep = Math.hypot(
      dar.anchorPlanetFixed().x - oslo.anchorPlanetFixed().x,
      dar.anchorPlanetFixed().y - oslo.anchorPlanetFixed().y,
      dar.anchorPlanetFixed().z - oslo.anchorPlanetFixed().z,
    );
    expect(sep).toBeGreaterThan(7e6); // [MEASURED 2026-09-05: 7327.3 km]
  });
});
