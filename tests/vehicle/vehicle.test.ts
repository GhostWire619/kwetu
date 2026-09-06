/**
 * VehicleController tests — synthetic flat-ground driving, fully deterministic
 * (fixed dt = 1/60, programmatic trimesh ground, no randomness, no wall-clock).
 *
 * The ground is a programmatic trimesh grid (2000 m × 2000 m, 20 m cells, top
 * plane z = 0) so the wheel raycasts exercise the terrain collision path.
 * World gravity is the §8 tangent (0, 0, −9.80665); solver baseline per
 * ADR-002 Decision 5 (dt 1/60, friction 0.7, restitution 0).
 *
 * Numeric thresholds carry provenance tags: [MEASURED 2026-09-06] values are
 * this suite's own deterministic runs on rapier3d-deterministic-compat 0.20.0;
 * [DERIVED] values are computed from the tuning constants by the stated
 * formula. Provenance audit, 2026-09-06: earlier quoted drive/brake and
 * steering figures came from an out-of-repo harness variant — no 60-tick
 * settle, and steering probes that fed the raw `setSteer` input to the solver
 * as the wheel angle before the × maxSteerAngleRadians mapping was finalized
 * — so every [MEASURED] number below has been re-measured against the suite
 * as committed. All tuning is [PLACEHOLDER — tune at Phase 4]: these tests
 * pin the placeholder behaviour, they do NOT claim Phase-4 exit criteria
 * (suspension feel, the scripted Dar street loop are human criteria).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { DT_SECONDS, initLocalSceneRuntime } from '../../client/src/engine/localScene';
import { TANGENT_G_METRES_PER_S2 } from '../../client/src/engine/geodesy';
import { quatRotate } from '../../client/src/engine/vec3';
import { makeDefaultVehicleParams, VehicleController } from '../../client/src/vehicle/vehicle';

const SETTLE_TICKS = 60; // 1 s — enough for the suspension to settle and sleep [MEASURED: parked z frozen from tick ≤ 60]
const PARK_TICKS = 300; // 5 s observation window

/**
 * One bounded bubble world (Law PH-1: one world per bubble — each car gets
 * its own) with a programmatic flat trimesh ground, top plane at z = 0.
 */
function makeCar(): VehicleController {
  const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -TANGENT_G_METRES_PER_S2));
  world.timestep = DT_SECONDS;

  const half = 1000; // m — full-throttle runs travel ≤ ~240 m; 2 km keeps every test on the mesh
  const cell = 20; // m
  const n = (2 * half) / cell;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      verts.push(-half + i * cell, -half + j * cell, 0);
    }
  }
  const stride = n + 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + j + 1;
      const d = i * stride + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setFriction(0.7).setRestitution(0),
    ground,
  );

  // Spawn 3 cm below the just-touching height (|conn z| 0.15 + rest 0.5 +
  // radius 0.4 = 1.05 m) so the suspension starts pre-compressed and settles
  // without a drop bounce. [DERIVED from makeDefaultVehicleParams geometry]
  return new VehicleController(makeDefaultVehicleParams(world, { x: 0, y: 0, z: 1.02 }));
}

function runTicks(car: VehicleController, n: number): void {
  for (let t = 0; t < n; t++) car.update(DT_SECONDS);
}

/** Full throttle until the signed forward speed reaches `target` (≤ maxTicks). Returns the tick, −1 if never. */
function throttleTo(car: VehicleController, target: number, maxTicks: number): number {
  for (let t = 0; t < maxTicks; t++) {
    car.setThrottle(1);
    car.update(DT_SECONDS);
    if (car.speedMetresPerSecond >= target) return t;
  }
  return -1;
}

/**
 * Steers at a constant input for `ticks` ticks, accumulating the per-tick
 * heading deltas UNWRAPPED (each delta wrapped to ±π before summing) so a
 * turn through ±180° stays monotonic in the accumulator.
 */
function steerAndAccumulateHeading(
  car: VehicleController,
  steer: number,
  ticks: number,
): { perTickDeltas: number[]; totalRadians: number } {
  let prev = car.headingRadians;
  const perTickDeltas: number[] = [];
  for (let t = 0; t < ticks; t++) {
    car.setSteer(steer);
    car.update(DT_SECONDS);
    const h = car.headingRadians;
    let d = h - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    perTickDeltas.push(d);
    prev = h;
  }
  return { perTickDeltas, totalRadians: perTickDeltas.reduce((a, b) => a + b, 0) };
}

function allWheelsInContact(car: VehicleController): boolean {
  return [0, 1, 2, 3].every((i) => car.wheelInContact(i));
}

beforeAll(async () => {
  await initLocalSceneRuntime();
  await initLocalSceneRuntime(); // idempotent
});

describe('vehicle/VehicleController — parked on flat ground', () => {
  it('rests stably for 5 simulated seconds: bounded vertical variance, no fall-through, all wheels down', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    const zs: number[] = [];
    let minZ = Infinity;
    for (let t = 0; t < PARK_TICKS; t++) {
      car.update(DT_SECONDS);
      const z = car.positionMetres.z;
      zs.push(z);
      minZ = Math.min(minZ, z);
    }
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    const variance = zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length;
    // [MEASURED 2026-09-06: variance 0.0 m² — the chassis settles and sleeps;
    // bound stays 1e-4 m² so an awake-but-stable suspension also passes.]
    expect(variance).toBeLessThanOrEqual(1e-4);
    // Ride height [MEASURED 2026-09-06: 0.97309 m; DERIVED static-sag
    // equilibrium 0.968 m — the difference is the settle/sleep state].
    expect(Math.abs(mean - 0.97309)).toBeLessThan(0.02);
    // No fall-through — the chassis never sinks below 0.9 m (the fall-through
    // signature is z → −∞, ADR-002 evidence C).
    expect(minZ).toBeGreaterThan(0.9);
    // [MEASURED 2026-09-06: 4/4 wheels in contact at the end of the window.]
    expect(allWheelsInContact(car)).toBe(true);
    // No spontaneous yaw while parked [MEASURED 2026-09-06: heading stays 0].
    expect(Math.abs(car.headingRadians)).toBeLessThan(0.05);
  });
});

describe('vehicle/VehicleController — full throttle on flat ground', () => {
  it('exceeds 8 m/s within 3 s and 25 m/s within 6 s, staying on its wheels', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    car.setThrottle(1);
    let speed3s = 0;
    for (let t = 1; t <= 360; t++) {
      car.update(DT_SECONDS);
      if (t === 180) speed3s = car.speedMetresPerSecond;
    }
    // Acceleration under the placeholder tuning: a = 4 × maxEngineForceN /
    // massKg = 4 × 1500 / 900 = 6.67 m/s² [DERIVED] → 20 m/s at 3 s, 40 m/s at
    // 6 s. [MEASURED 2026-09-06: 19.985 m/s at 3 s, 39.972 m/s at 6 s.] The
    // 8 m/s bar sits far inside the derived curve; the 25 m/s bar at 6 s is a
    // regression tripwire — a rear-wheel-drive-only mapping would model 20 m/s
    // and fail it.
    expect(speed3s).toBeGreaterThan(8);
    expect(car.speedMetresPerSecond).toBeGreaterThan(25);
    // Stays on the ground and on its wheels [MEASURED 2026-09-06: z 0.972,
    // 4/4 contact throughout].
    const z = car.positionMetres.z;
    expect(z).toBeGreaterThan(0.9);
    expect(z).toBeLessThan(1.1);
    expect(allWheelsInContact(car)).toBe(true);
  });
});

describe('vehicle/VehicleController — braking from speed', () => {
  it('stops from ≥ 15 m/s to < 1 m/s within 2.5 s without pitching over', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    const rampTick = throttleTo(car, 15, 240);
    expect(rampTick).toBeGreaterThanOrEqual(0); // ramp completes [MEASURED 2026-09-06: tick 135 = 2.25 s]

    car.setThrottle(0);
    car.setBrake(1);
    let stopTick = -1;
    let maxPitch = 0;
    for (let t = 0; t < 150; t++) {
      car.update(DT_SECONDS);
      const f = car.forwardVector;
      maxPitch = Math.max(maxPitch, Math.abs(Math.asin(Math.max(-1, Math.min(1, f.z)))));
      if (Math.abs(car.speedMetresPerSecond) < 1) {
        stopTick = t;
        break;
      }
    }
    // Deceleration ≈ 4 × maxBrakeImpulseNs × tickRate / mass = 4 × 45 × 60 /
    // 900 = 12 m/s² [DERIVED] → ~1.2 s. [MEASURED 2026-09-06: 1.317 s from
    // 15 m/s to < 1 m/s.] The 2.5 s bar leaves ~1.9× margin.
    expect(stopTick).toBeGreaterThanOrEqual(0);
    expect((stopTick + 1) / 60).toBeLessThan(2.5);
    // No brake-dive pitch-over [MEASURED 2026-09-06: max pitch 0.062 rad].
    expect(maxPitch).toBeLessThan(0.2);
    expect(car.positionMetres.z).toBeGreaterThan(0.9);
  });
});

describe('vehicle/VehicleController — steering at moderate speed', () => {
  it('turns monotonically left for positive steer, ≈ 1.1 rad over 3 s, staying upright', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    const rampTick = throttleTo(car, 6, 180);
    expect(rampTick).toBeGreaterThanOrEqual(0);
    car.setThrottle(0); // coast — the solver model has no drag/rolling resistance, so speed holds ≈ 6 m/s

    // Positive steer = LEFT turn (heading increases) [MEASURED 2026-09-06].
    // Kinematic bicycle check under the SHIPPED input mapping — setSteer takes
    // a NORMALIZED input and the front-wheel angle is
    // input × maxSteerAngleRadians, so setSteer(0.3) commands δ = 0.15 rad:
    //   R = wheelbase/δ = 2.5/0.15 ≈ 16.67 m → yaw rate ≈ v/R = 6/16.67 ≈
    //   0.36 rad/s → ≈ 1.08 rad over the 3 s window. [DERIVED]
    // [MEASURED 2026-09-06: 1.0813 rad over 3 s, mean yaw rate 0.3604 rad/s —
    // matches the derivation; monotonic per tick, body-up · z = 0.999996, no
    // spin-out. An earlier harness applied the raw input as the wheel angle
    // (δ = 0.3 rad → R = 2.5/0.3 = 8.33 m → '≈ 2.2 rad over 3 s'), and its
    // '~10 m/s: 1.05 rad/s' probe was made the same way (kinematic v/R =
    // 10/8.33 = 1.2 rad/s at δ = 0.3 rad). Re-measured at the shipped mapping,
    // ~10 m/s coast: 0.594 rad/s ≈ v/R = 10/16.67 = 0.60 rad/s.]
    const { perTickDeltas, totalRadians } = steerAndAccumulateHeading(car, 0.3, 180);
    for (const d of perTickDeltas) {
      expect(d).toBeGreaterThanOrEqual(-1e-3); // monotonic within solver noise
    }
    // Bounds bracket the corrected derivation: 1.08 rad derived [DERIVED],
    // 1.0813 rad measured [MEASURED 2026-09-06]. Deliberately loose while the
    // tuning is placeholder (Phase 4 tightens): the floor catches under-steer
    // (a ×0.5 mapping regression turns 0.54 rad and fails); the ceiling only
    // catches gross spin-out — a ×2 regression to ~2.2 rad would still pass,
    // so the derivation above is the provenance of record for the magnitude.
    expect(totalRadians).toBeGreaterThan(1.0);
    expect(totalRadians).toBeLessThan(3.5);

    // Upright and planted through the whole turn.
    const up = quatRotate(car.orientationQuat, { x: 0, y: 0, z: 1 });
    expect(up.z).toBeGreaterThan(0.9);
    expect(allWheelsInContact(car)).toBe(true);
    const z = car.positionMetres.z;
    expect(z).toBeGreaterThan(0.9);
    expect(z).toBeLessThan(1.1);
  });
});

describe('vehicle/VehicleController — reverse', () => {
  it('drives backward to < −2 m/s within 3 s in a straight line', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    car.setThrottle(-1);
    for (let t = 0; t < 180; t++) car.update(DT_SECONDS);
    // [MEASURED 2026-09-06: −19.985 m/s at 3 s under the placeholder tuning.]
    expect(car.speedMetresPerSecond).toBeLessThan(-2);
    expect(Math.abs(car.headingRadians)).toBeLessThan(0.2); // straight-line reverse [MEASURED: 0]
    expect(car.positionMetres.z).toBeGreaterThan(0.9);
  });
});

describe('vehicle/VehicleController — determinism (deterministic-compat, fixed dt)', () => {
  it('two identically-scripted cars in two worlds land bitwise-equal', () => {
    const a = makeCar();
    const b = makeCar();
    for (let t = 0; t < 180; t++) {
      for (const car of [a, b]) {
        if (t < 60) {
          car.setThrottle(1);
        } else if (t < 120) {
          car.setThrottle(0);
          car.setSteer(0.3);
        } else {
          car.setSteer(0);
          car.setBrake(1);
        }
        car.update(DT_SECONDS);
      }
    }
    // [MEASURED 2026-09-06: bitwise identical across two worlds — the
    // deterministic-compat build holds under the vehicle impulse path too.]
    const pa = a.positionMetres;
    const pb = b.positionMetres;
    expect(pa.x).toBe(pb.x);
    expect(pa.y).toBe(pb.y);
    expect(pa.z).toBe(pb.z);
    expect(a.headingRadians).toBe(b.headingRadians);
    expect(a.speedMetresPerSecond).toBe(b.speedMetresPerSecond);
  });
});

describe('vehicle/VehicleController — canonical f64 state (Law P-1 pattern)', () => {
  it('the f64 position integrator tracks the f32 solver path to the downcast class', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    car.setThrottle(1);
    for (let t = 0; t < 300; t++) car.update(DT_SECONDS); // ~5 s → ~33 m
    const p = car.positionMetres;
    const solver = car.chassisRigidBody.translation();
    // The integrator sums exact f64 differences of f32 readings, so it agrees
    // with the solver's own f32 position up to that position's f32 ULP
    // (~3.8e-6 m at ~33 m; bound 1e-4 m). [MEASURED 2026-09-06: within 1e-7.]
    expect(Math.abs(p.x - solver.x)).toBeLessThan(1e-4);
    expect(Math.abs(p.y - solver.y)).toBeLessThan(1e-4);
    expect(Math.abs(p.z - solver.z)).toBeLessThan(1e-4);
  });

  it('absorbs a caller-side solver teleport exactly (rebase-coherent by construction, Law P-6)', () => {
    const car = makeCar();
    runTicks(car, SETTLE_TICKS);
    car.setThrottle(1);
    for (let t = 0; t < 120; t++) car.update(DT_SECONDS);
    // Stop, then RELEASE every control and let the car SLEEP — the parked run
    // proves a zero-control car reaches exact stillness (variance 0.0 m², and
    // the preStep skip never pokes a sleeping body). Braking to quiescence does
    // NOT work as a stillness tool: a held brake wakes the chassis every tick
    // and its residual stick-slip oscillation decays only slowly (measured
    // 2.6e-2 m/s 60 ticks after the stop, 3.8e-4 m/s after 150 — never an exact
    // zero), contaminating the measurement with up to |v|·dt of real motion. A
    // sleeping body is frozen, so the only motion under measurement is the
    // teleport itself.
    car.setThrottle(0);
    car.setBrake(1);
    for (let t = 0; t < 150 && Math.abs(car.speedMetresPerSecond) > 0.1; t++) car.update(DT_SECONDS);
    car.setBrake(0);
    let sleptTick = -1;
    for (let t = 0; t < 300; t++) {
      car.update(DT_SECONDS);
      if (car.chassisRigidBody.isSleeping()) {
        sleptTick = t;
        break;
      }
    }
    expect(sleptTick).toBeGreaterThanOrEqual(0); // reached sleep after the stop
    const before = car.positionMetres;
    car.chassisRigidBody.setTranslation({ x: before.x + 50, y: before.y, z: before.z }, true);
    // The canonical read absorbs the teleport WITHOUT any physics step: the
    // lazy f64 sync integrates the solver-side jump as an exact delta of two
    // f32 readings — no shift vector anywhere (Law P-6). Residual budget
    // [DERIVED]: the f32 rounding of the teleport target, |fround(x) − x| ≤
    // ULP/2 ≤ 3.9e-6 m for targets ≤ 128 m. [MEASURED 2026-09-06: 1.9e-6 m in
    // x — exactly the target rounding — and 0 in y and z.]
    const afterTeleport = car.positionMetres;
    expect(Math.abs(afterTeleport.x - before.x - 50)).toBeLessThan(1e-5);
    expect(Math.abs(afterTeleport.y - before.y)).toBeLessThan(1e-5);
    expect(Math.abs(afterTeleport.z - before.z)).toBeLessThan(1e-5);
    // And the canonical state keeps tracking the solver bit-for-bit-coherently
    // through the wake-and-settle ticks that follow: canonical − solver is a
    // constant offset (the f64-spawn − f32-spawn downcast class, ≤ ~2e-8 m at
    // metre scale [DERIVED]), because every tick delta is integrated exactly.
    for (let t = 0; t < 60; t++) car.update(DT_SECONDS);
    const s = car.chassisRigidBody.translation();
    expect(Math.abs(car.positionMetres.x - s.x)).toBeLessThan(1e-4);
    expect(Math.abs(car.positionMetres.y - s.y)).toBeLessThan(1e-4);
    expect(Math.abs(car.positionMetres.z - s.z)).toBeLessThan(1e-4);
  });
});

describe('vehicle/VehicleController — control clamping', () => {
  it('clamped inputs are bitwise-indistinguishable from their clamped values', () => {
    const a = makeCar();
    const b = makeCar();
    for (let t = 0; t < 120; t++) {
      a.setThrottle(1.5); // clamps to 1
      b.setThrottle(1);
      a.update(DT_SECONDS);
      b.update(DT_SECONDS);
    }
    expect(a.positionMetres.x).toBe(b.positionMetres.x); // bitwise
    expect(a.speedMetresPerSecond).toBe(b.speedMetresPerSecond);
    // Negative brake clamps to 0: bitwise-equal to an unbraked car.
    const c = makeCar();
    const d = makeCar();
    for (let t = 0; t < 60; t++) {
      c.setThrottle(0.5);
      c.setBrake(-0.5); // clamps to 0
      d.setThrottle(0.5);
      c.update(DT_SECONDS);
      d.update(DT_SECONDS);
    }
    expect(c.positionMetres.x).toBe(d.positionMetres.x);
    expect(c.speedMetresPerSecond).toBe(d.speedMetresPerSecond);
  });
});
