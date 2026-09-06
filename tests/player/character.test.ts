/**
 * Walk character controller tests (Phase 3 groundwork — headless mechanics only).
 *
 * Synthetic geometry only: flat slabs, tilted ramps, a step box. NO .bake
 * meshes are read (terrain-glb integration is later Phase-3 work) and the
 * human Phase-3 exit criterion ("walk Stone Town seafront at 60 fps") is NOT
 * claimable from this suite — it validates controller mechanics, the f64
 * canonical pattern (ADR-002 Laws P-1/P-6) and the Rapier KCC's documented
 * slope/step/snap gates.
 *
 * Cadence (the production one, documented in character.ts): each simulated
 * tick is `char.update(DT_SECONDS)` followed by exactly one `LocalScene.step()`
 * — the scene owns the world step and the character refuses to run twice
 * without one (in-sync guard). All thresholds below carry the measured value
 * they were pinned from [MEASURED 2026-09-06, this suite, fixed dt = 1/60,
 * deterministic — no randomness, no wall-clock].
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { DT_SECONDS, LocalScene, initLocalSceneRuntime, type SceneAnchor } from '../../client/src/engine/localScene';
import { worldTimeTtFromUtcMillis } from '../../client/src/engine/ephemeris';
import { f32Spacing } from '../../client/src/engine/precision';
import { quatRotate, quatY, type Quat, type Vec3 } from '../../client/src/engine/vec3';
import { CharacterController } from '../../client/src/player/character';

const SITE = { latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 };
const T0 = worldTimeTtFromUtcMillis(Date.UTC(2026, 8, 5, 0, 0, 0));

function anchorAt(yawRad = 0): SceneAnchor {
  return { parentBody: 'Earth', geodetic: { ...SITE }, yawRad, referenceWorldTimeTtSeconds: T0 };
}

const WALK_SPEED = 2.0; // m/s — a brisk walk; 3 s of it must land in the brief's [5, 7] m band
const RUN_SPEED = 4.0; // m/s

const BASE_OPTIONS = {
  radiusMetres: 0.4,
  halfHeightMetres: 0.5, // capsule total height 2·(0.5+0.4) = 1.8 m
  walkSpeedMetresPerSecond: WALK_SPEED,
  runSpeedMetresPerSecond: RUN_SPEED,
};

/**
 * Flat ground slab, top surface at local z = 0 (bubble-local ENU, Z-up).
 *
 * Orientation law: `addBox` takes the CANONICAL PlanetFixed orientation, and a
 * box that is axis-aligned in the bubble-local ENU frame carries the PlanetFixed
 * orientation `planetFixedOrientationFromLocal(identity)` — the ENU basis
 * rotation at this site (the thin axis of a PlanetFixed-identity cuboid points
 * (0, cosφ, sinφ) in local axes, a ~96.8° "wall" at lat −6.79°, [MEASURED
 * 2026-09-06, this suite's geometry probe]). The engine's own suite builds
 * every box this way (tests/engine/localScene.test.ts makeScene).
 */
function flatScene(): LocalScene {
  const scene = new LocalScene(anchorAt());
  const qLocalFlat: Quat = { x: 0, y: 0, z: 0, w: 1 };
  scene.addBox({
    id: 'ground',
    kind: 'fixed',
    planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: -0.5 }),
    planetFixedOrientationQuat: scene.planetFixedOrientationFromLocal(qLocalFlat),
    halfExtentsMetres: { x: 30, y: 30, z: 0.5 },
  });
  return scene;
}

/** One production tick: avatar update, then the scene's single world step. */
function tick(char: CharacterController, scene: LocalScene, n: number): void {
  for (let i = 0; i < n; i++) {
    char.update(DT_SECONDS);
    scene.step();
  }
}

beforeAll(async () => {
  await initLocalSceneRuntime();
  await initLocalSceneRuntime(); // idempotent
});

describe('player/character — flat ground: settle, grounding, z stability', () => {
  it('spawns 0.1 m above a flat slab, settles grounded, and holds z over 120 fixed steps', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20); // settle: 0.1 m free fall ≈ 9 ticks [derived]
    expect(char.isGrounded).toBe(true);
    const settled = char.position;
    // Standing height: capsule centre = floor top + halfHeight + radius + controller
    // gap (0.9 + 0.02 = 0.92). The gap is the controller's own maintenance — asserted
    // as a band, pinned by the measured value.
    // [MEASURED 2026-09-06: 0.9200154 m — the 0.02 m offset gap plus the standing
    // limit-cycle offset, held to the ~1e-4 maintenance class.]
    expect(settled.z).toBeGreaterThan(0.85);
    expect(settled.z).toBeLessThan(0.99);

    let maxDrift = 0;
    let maxCreep = 0;
    let allGrounded = true;
    for (let i = 0; i < 120; i++) {
      tick(char, scene, 1);
      const p = char.position;
      maxDrift = Math.max(maxDrift, Math.abs(p.z - settled.z));
      maxCreep = Math.max(maxCreep, Math.hypot(p.x - settled.x, p.y - settled.y));
      allGrounded = allGrounded && char.isGrounded;
    }
    expect(allGrounded).toBe(true);
    // Standing is NOT frozen: the grounded maintenance probe (−g·dt² per tick,
    // clipped by the controller's offset maintenance) produces a small limit
    // cycle around the rest height. [MEASURED 2026-09-06: maxDrift 8.2e-5 m and
    // maxCreep 3.8e-7 m over 120 ticks — a ~1e-4 m band, the KCC's gap-maintenance
    // class at offset 0.02 m, ~1.4e3 f32 ULPs at 0.92 m but 5 orders below the
    // 1e4 m bubble bound.]
    expect(maxDrift).toBeLessThan(2e-4);
    expect(maxCreep).toBeLessThan(1e-3);
    // The canonical f64 position and the f32 solver pose agree bitwise (the
    // solver pose is re-derived from canonical f64 every tick — Law P-6);
    // asserted to one f32 ULP at the current local magnitude.
    const p = char.position;
    const b = char.rapierBody.translation();
    const ulp = f32Spacing(Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)));
    expect(Math.abs(b.x - Math.fround(p.x))).toBeLessThanOrEqual(ulp);
    expect(Math.abs(b.y - Math.fround(p.y))).toBeLessThanOrEqual(ulp);
    expect(Math.abs(b.z - Math.fround(p.z))).toBeLessThanOrEqual(ulp);
    char.dispose();
  });

  it('configures the §8-required controller up explicitly (Z-up ENU)', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, BASE_OPTIONS);
    const up = char.rapierController.up();
    expect(Math.hypot(up.x, up.y, up.z - 1)).toBeLessThan(1e-6);
    char.dispose();
  });
});

describe('player/character — walking', () => {
  it('walks 3 simulated seconds at walk speed: displacement in [5, 7] m, grounded, z stable', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    const start = char.position;
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 180); // exactly 3.00 s at dt = 1/60
    const end = char.position;
    const d = Math.hypot(end.x - start.x, end.y - start.y);
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(7);
    expect(char.isGrounded).toBe(true);
    expect(char.speed).toBeGreaterThan(1.9); // actual achieved speed ≈ commanded
    expect(Math.abs(end.z - start.z)).toBeLessThan(0.02);

    // f64 canonical tracking vs the exact kinematic expectation (speed·time, no
    // obstacles): the deviation is dominated by the KCC's contact maintenance,
    // NOT by f32 quantisation (the per-tick movement delta's f32 spacing is
    // 3.7e-9 m → ~7e-7 m over 180 ticks [derived] — three orders below what is
    // measured). The f64 tracker itself adds nothing: it is the exact f64 sum of
    // the solver's f32 movements. A pure-f32 POSITION accumulator would round at
    // the position magnitude (9.5e-7 m at 12 m) per tick — the B-PREC-01
    // mechanism [DERIVED].
    // [MEASURED 2026-09-06: deviation 7.48e-4 m over 180 ticks — the bounded
    // mm-class maintenance transient documented in character.ts's header.]
    expect(Math.abs(d - WALK_SPEED * 3)).toBeLessThan(1e-3);
    char.dispose();
  });

  it('runs at run speed when running=true', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, true);
    tick(char, scene, 60); // 1 s
    const end = char.position;
    // [MEASURED 2026-09-06: 3.9997 m over 60 ticks at 4 m/s — the same mm-class
    // maintenance transient as the walk test]
    expect(Math.hypot(end.x, end.y)).toBeGreaterThan(3.9);
    expect(Math.hypot(end.x, end.y)).toBeLessThan(4.1);
    char.dispose();
  });
});

describe('player/character — slopes (maxSlopeClimbAngle = 45°, set explicitly)', () => {
  /**
   * A wide tilted slab whose TOP face is an inclined plane rising toward +x:
   * surface z(x) = x·tan(angle) + halfThick/cos(angle) [derived — tilted-cuboid
   * geometry; quatY(−angle) tilts the up-normal toward −x].
   */
  function rampScene(angleRad: number): { scene: LocalScene; surfaceZ(x: number): number } {
    const scene = new LocalScene(anchorAt());
    const qRamp = scene.planetFixedOrientationFromLocal(quatY(-angleRad));
    scene.addBox({
      id: 'ramp',
      kind: 'fixed',
      planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 0, y: 0, z: 0 }),
      planetFixedOrientationQuat: qRamp,
      halfExtentsMetres: { x: 6, y: 2, z: 0.3 },
    });
    return { scene, surfaceZ: (x: number) => x * Math.tan(angleRad) + 0.3 / Math.cos(angleRad) };
  }

  it('climbs a 30° ramp: grounded throughout, ≥ 2 m of vertical gain in 3 s', () => {
    const { scene, surfaceZ } = rampScene(Math.PI / 6);
    const spawnX = -5;
    const char = new CharacterController(scene.solverWorld, {
      ...BASE_OPTIONS,
      spawnPositionMetres: { x: spawnX, y: 0, z: surfaceZ(spawnX) + 1.0 },
    });
    tick(char, scene, 20); // settle onto the slope
    expect(char.isGrounded).toBe(true); // 30° ≤ 45° climb gate → counts as ground
    const start = char.position;
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 180);
    const end = char.position;
    expect(end.z - start.z).toBeGreaterThan(2.0); // climbed
    expect(end.x - start.x).toBeGreaterThan(4.0); // kept moving uphill
    expect(char.isGrounded).toBe(true);
    // [MEASURED 2026-09-06: Δz +2.476 m, Δx +4.288 m in 3 s. Δz/Δx = 0.577 =
    // tan 30° — the movement is redirected exactly along the slope, and the
    // along-slope distance 4.947 m matches the tangential projection of the
    // per-tick desired movement (0.0333·cos30° − g·dt²·sin30° = 0.0275 m/tick
    // [DERIVED, measured to 8e-4]): the projected-away part is the grounded
    // maintenance probe pressing into the slope, by design (see the walk test
    // and character.ts's header).]
    char.dispose();
  });

  it('is blocked by a 60° ramp (steeper than the 45° climb gate): no climb, stays grounded', () => {
    const scene = flatScene();
    // Wedge whose upper face passes through (6, 0, 0) rising at 60° toward +x:
    // centre = face point − n·halfThick with n = (−sin60°, 0, cos60°) [derived].
    const qWedge = scene.planetFixedOrientationFromLocal(quatY(-Math.PI / 3));
    scene.addBox({
      id: 'wedge',
      kind: 'fixed',
      planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 6 + 0.5 * Math.sin(Math.PI / 3), y: 0, z: -0.5 * Math.cos(Math.PI / 3) }),
      planetFixedOrientationQuat: qWedge,
      halfExtentsMetres: { x: 6, y: 3, z: 0.5 },
    });
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    expect(char.isGrounded).toBe(true);
    const start = char.position;
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 180);
    const end = char.position;
    expect(char.isGrounded).toBe(true);
    expect(end.z - start.z).toBeLessThan(0.05); // never climbed
    expect(end.x).toBeLessThan(6.0); // never passed onto/through the steep face
    // It walked up to the wedge and stopped at the exact capsule-to-plane
    // contact point: the closest capsule point to a 60° face is the low end of
    // its axis segment (z = 0.42), and setting its perpendicular distance to the
    // face equal to radius + offset gives
    // xc = 6 − (0.4 + 0.02)·(1 − cos60°)/sin60° = 5.7575 m
    // [DERIVED — capsule-segment plane contact; matches the measurement to 1e-9].
    // [MEASURED 2026-09-06: final x +5.757 m, Δz −0.001 m — blocked, no
    // slide-back, no creep up the face.]
    expect(end.x - start.x).toBeGreaterThan(4.5);
    char.dispose();
  });

  it('exposes the configured slope gates (config-explicit assertions)', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, BASE_OPTIONS);
    expect(char.tuningSnapshot.maxSlopeClimbAngleRad).toBe(Math.PI / 4);
    expect(char.tuningSnapshot.minSlopeSlideAngleRad).toBe(Math.PI / 3);
    // Rapier readback (f32 storage class on the raw side).
    expect(Math.abs(char.rapierController.maxSlopeClimbAngle() - Math.PI / 4)).toBeLessThan(1e-6);
    expect(Math.abs(char.rapierController.minSlopeSlideAngle() - Math.PI / 3)).toBeLessThan(1e-6);
    char.dispose();
  });
});

describe('player/character — autostep', () => {
  it('steps onto a 0.3 m box at walk speed and walks on (autostep 0.4 m / 0.3 m, dynamic bodies excluded)', () => {
    const scene = flatScene();
    // Box top at z = 0.3, spanning x ∈ [−0.5, 4.5] — under the 0.4 m autostep gate.
    // Axis-aligned in LOCAL ENU (see flatScene's orientation law).
    scene.addBox({
      id: 'step',
      kind: 'fixed',
      planetFixedPositionMetres: scene.planetFixedFromLocal({ x: 2, y: 0, z: 0.15 }),
      planetFixedOrientationQuat: scene.planetFixedOrientationFromLocal({ x: 0, y: 0, z: 0, w: 1 }),
      halfExtentsMetres: { x: 2.5, y: 1.5, z: 0.15 },
    });
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: -4, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    expect(char.isGrounded).toBe(true);
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 180);
    const end = char.position;
    expect(char.isGrounded).toBe(true);
    // On top: standing height over the box = 0.3 + 0.9 + gap ≈ 1.22 — well above
    // the ground-level 0.92, which proves it is not stuck beside the box.
    expect(end.z).toBeGreaterThan(1.15);
    expect(end.z).toBeLessThan(1.3);
    expect(end.x).toBeGreaterThan(0.5); // walked onto the box top region
    // [MEASURED 2026-09-06: final (1.8173, 0.0002, 1.2200914) — stepped up onto
    // the box (z = 0.3 + 0.9 + gap, the box-top standing height). The step-up
    // maneuver costs ~0.18 m of the 6.0 m walk (~5 ticks of reduced horizontal
    // movement while climbing the riser) — the KCC's autostep transient class.]
    expect(char.tuningSnapshot.autostepMaxHeightMetres).toBe(0.4);
    expect(char.tuningSnapshot.autostepIncludeDynamicBodies).toBe(false);
    char.dispose();
  });
});

describe('player/character — gravity, drop and jump (seam-sourced g)', () => {
  it('falls 2 m under the tangent-gravity seam and lands grounded at the standing height', () => {
    const scene = flatScene();
    // Feet 2.0 m above the floor: capsule centre = 2.0 + 0.9 + gap.
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 2.92 } });
    expect(char.gravityMetresPerSecond).toBe(9.80665); // [EXTERNAL — ISO 80000-3 standard gravity, via TANGENT_NORMAL_GRAVITY]
    let landed = -1;
    for (let i = 0; i < 120 && landed < 0; i++) {
      tick(char, scene, 1);
      if (char.isGrounded) landed = i + 1;
    }
    // 2 m free fall ≈ 0.64 s ≈ 38 ticks [derived]; snap-to-ground may shorten
    // the last decimetres, but not by an order of magnitude.
    expect(landed).toBeGreaterThan(14);
    expect(landed).toBeLessThan(70);
    expect(char.verticalVelocityMetresPerSecond).toBe(0); // zeroed on landing
    const zLand = char.position.z;
    expect(zLand).toBeGreaterThan(0.85);
    expect(zLand).toBeLessThan(0.99);
    let maxDrift = 0;
    for (let i = 0; i < 30; i++) {
      tick(char, scene, 1);
      maxDrift = Math.max(maxDrift, Math.abs(char.position.z - zLand));
    }
    expect(maxDrift).toBeLessThan(1e-4);
    char.dispose();
  });

  it('jump(3.5) leaves the ground, rises the discrete semi-implicit peak, and lands again', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    const z0 = char.position.z;
    char.jump(3.5);
    let peak = z0;
    let airborneSeen = false;
    let groundedTicks = 0;
    for (let i = 0; i < 120; i++) {
      tick(char, scene, 1);
      peak = Math.max(peak, char.position.z);
      if (!char.isGrounded) {
        airborneSeen = true;
      } else if (airborneSeen) {
        groundedTicks++;
        if (groundedTicks >= 5) break; // landed and re-settled into the standing band
      }
    }
    expect(airborneSeen).toBe(true);
    // Analytic continuous peak v²/2g = 0.6246 m (g = 9.80665) [derived]; the
    // discrete semi-implicit sum over 21 positive-velocity ticks is 0.5957 m
    // [DERIVED — and measured exactly: peak 0.5957 m, 21 rise ticks]. Snap is
    // disabled while rising (velocity gate), so nothing yanks the jump down.
    expect(peak - z0).toBeGreaterThan(0.5);
    expect(peak - z0).toBeLessThan(0.7);
    expect(char.isGrounded).toBe(true);
    // The FIRST grounded tick sits high (snap-to-ground flags the floor within
    // its window during descent before the pose has closed the gap) — [MEASURED
    // 2026-09-06: landing tick 0.0462 m above rest, rest re-established one tick
    // later]. Five ticks put it back inside the standing band.
    expect(Math.abs(char.position.z - z0)).toBeLessThan(5e-4);
    char.dispose();
  });
});

describe('player/character — rebase survival (Law P-6 on the avatar)', () => {
  const TRANSLATION: Vec3 = { x: 10, y: 0, z: 0 };
  const YAW_DELTA = Math.PI / 2;

  it('applies the ADR-002 axes form exactly in f64 and re-derives the solver pose bitwise', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 360); // 6 s at 2 m/s → ~12 m: far enough for f32 position ULPs to matter
    const before = char.position;

    char.rebaseAxes(TRANSLATION, YAW_DELTA);

    // Independent closed form: p' = Rz(−Δyaw)·(p − t), computed HERE (not by the
    // module under test). f64 rounding class of one subtraction + one rotation at
    // a ~12 m lever: ≤ 1e-12 m [derived — f64 ULP 1.8e-15 m at 16 m, a few ops].
    const dx = before.x - TRANSLATION.x;
    const dy = before.y - TRANSLATION.y;
    const c = Math.cos(-YAW_DELTA);
    const s = Math.sin(-YAW_DELTA);
    const after = char.position;
    expect(Math.abs(after.x - (dx * c - dy * s))).toBeLessThan(1e-12);
    expect(Math.abs(after.y - (dx * s + dy * c))).toBeLessThan(1e-12);
    expect(after.z).toBe(before.z); // Rz preserves the up axis exactly
    // Local coordinates got SMALLER (the point of the rebase): |p'| ≈ 2 m
    // (12 m walked minus the 10 m anchor translation).
    expect(Math.hypot(after.x, after.y)).toBeLessThan(3);

    // The solver pose is the BITWISE f32 downcast of canonical f64 — never a
    // shifted accumulation.
    const b = char.rapierBody.translation();
    expect(b.x).toBe(Math.fround(after.x));
    expect(b.y).toBe(Math.fround(after.y));
    expect(b.z).toBe(Math.fround(after.z));
    // Canonical − solver residual bounded by one f32 ULP at the new local
    // magnitude. [derived + asserted: f32 ULP at ~2.2 m = 2.4e-7 m]
    const ulp = f32Spacing(Math.max(Math.abs(after.x), Math.abs(after.y), Math.abs(after.z)));
    expect(Math.hypot(b.x - after.x, b.y - after.y, b.z - after.z)).toBeLessThanOrEqual(ulp);

    // The capsule is still upright: the body orientation re-derived as
    // q' = q_z(−Δyaw) ⊗ q keeps the CAPSULE AXIS on +Z. The capsule's axis is
    // its body-local +Y (ColliderDesc.capsule is Y-aligned, stood upright by
    // the +90°-about-X body quat), so the probe vector is (0, 1, 0), NOT the
    // body-local +Z a naive reading suggests.
    const q = char.rapierBody.rotation();
    const axis = quatRotate({ x: q.x, y: q.y, z: q.z, w: q.w }, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(axis.x, axis.y, axis.z - 1)).toBeLessThan(1e-6);
    // And the facing rotates WITH the frame change (the body is frozen in the
    // world; its local-frame representation picks up the Rz(−Δyaw)):
    // body-local +X → Rz(−90°)·Rx(90°)·(1,0,0) = (0, −1, 0), the f32 quat class.
    const facing = quatRotate({ x: q.x, y: q.y, z: q.z, w: q.w }, { x: 1, y: 0, z: 0 });
    expect(Math.hypot(facing.x, facing.y + 1, facing.z)).toBeLessThan(1e-6);

    // Walking continues at full speed after the rebase (intent is re-issued in
    // the NEW local axes — rebaseAxes clears the stale-axes intent by design).
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    const resume = char.position;
    tick(char, scene, 60); // 1 s
    const walked = Math.hypot(char.position.x - resume.x, char.position.y - resume.y);
    expect(walked).toBeGreaterThan(1.9);
    expect(walked).toBeLessThan(2.1);
    expect(char.isGrounded).toBe(true);
    char.dispose();
  });

  it('stays in contact with a LocalScene-rebased bubble across a 90° anchor yaw', () => {
    const scene = flatScene();
    const char = new CharacterController(scene.solverWorld, { ...BASE_OPTIONS, spawnPositionMetres: { x: 0, y: 0, z: 1.0 } });
    tick(char, scene, 20);
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 600);
    const before = char.position;
    const zBefore = before.z;

    // The shared bubble re-derives (the square slab rotates 90° about the anchor
    // — coverage under the avatar is unchanged), then the avatar applies the
    // SAME axes form with the same parameters, in this order, at a tick boundary.
    scene.rebase(anchorAt(YAW_DELTA), 're-derive');
    char.rebaseAxes({ x: 0, y: 0, z: 0 }, YAW_DELTA);

    const after = char.position;
    // Same law, independently computed: (20, 0, z) → (≈0, −20, z) under Rz(−90°).
    expect(Math.abs(after.x - (before.x * Math.cos(-YAW_DELTA) - before.y * Math.sin(-YAW_DELTA)))).toBeLessThan(1e-12);
    expect(Math.abs(after.y - (before.x * Math.sin(-YAW_DELTA) + before.y * Math.cos(-YAW_DELTA)))).toBeLessThan(1e-12);
    // Contact survives the re-derivation on both sides: the avatar is grounded on
    // the re-derived slab and its standing height re-establishes to the f32
    // contact-re-establishment class — the ground's and avatar's rebased solver
    // poses are the lawful f32 downcasts, and the KCC rebuilds its maintained
    // gap against them. [MEASURED 2026-09-06: −1.0e-4 m on the first tick — the
    // same class as the un-rebased stand, ~20× the ADR-002 point-body axes
    // residual (2.44e-5 m) and 7 orders below the bubble bound.]
    tick(char, scene, 1);
    expect(char.isGrounded).toBe(true);
    expect(Math.abs(char.position.z - zBefore)).toBeLessThan(3e-4);
    // And it keeps walking grounded on the rebased world. WALKING z is noisier
    // than STANDING z: the KCC's gap-maintenance/autostep transient produces
    // mm-scale single-tick z excursions while walking — measured on BOTH sides
    // of a rebase [MEASURED 2026-09-06: max |z − rest| over a 600-tick walk
    // 4.2e-3 m pre-rebase vs 6.0e-3 m post-rebase, same class — the rebase adds
    // nothing]. The 60-tick walk here measured 1.91e-3 m; pinned at 1e-2.
    char.setDesiredMove({ x: 1, y: 0, z: 0 }, false);
    tick(char, scene, 60);
    expect(char.isGrounded).toBe(true);
    expect(Math.abs(char.position.z - zBefore)).toBeLessThan(1e-2);
    // The bubble-bound law still holds for the scene's own entities.
    expect(() => scene.assertBubbleExtent()).not.toThrow();
    char.dispose();
  });
});
