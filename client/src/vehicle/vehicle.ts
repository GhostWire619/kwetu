/**
 * Kwetu vehicle — `VehicleController`: a renderer-independent, headless car
 * controller wrapping Rapier's `DynamicRayCastVehicleController` (Phase 4
 * groundwork; VEHICLES_AND_FLIGHT.md owns the subsystem's capabilities — the
 * tuning here is placeholder-grade groundwork, NOT the Phase-4 exit state).
 *
 * Solver and precision (COORDINATE_SYSTEM.md Laws P-1/P-6, ADR-002):
 *   - The caller's `RAPIER.World` is the one bounded f32 contact-bubble solver
 *     (Law PH-1: one world per bubble). This controller binds to exactly one
 *     world and never creates another.
 *   - Canonical vehicle state is f64 (Law P-1): `positionMetres` is an f64
 *     integrator of the solver's per-tick f32 deltas — each delta is the exact
 *     difference of two f32 solver readings, accumulated in f64, so the
 *     canonical position is exact along the solver's own f32 path without
 *     claiming the solver's lost precision back. `velocityMetresPerSecond` and
 *     `orientationQuat` are the solver's f32 values widened to f64 at read
 *     time (the same promotion class `LocalScene.step()` performs at tick
 *     boundaries). Bubble-local coordinates only: mapping to
 *     `Frame.PlanetFixed(Earth)` through a scene anchor stays with the caller
 *     (Phase 4 wires this to `LocalScene`).
 *   - The f64 integrator is rebase-coherent by construction (Law P-6): a
 *     `LocalScene.rebase` re-derives solver transforms, and any solver-space
 *     teleport the caller applies is absorbed exactly as a delta — the
 *     canonical state follows without a shift vector ever touching it.
 *
 * Axes (COORDINATE_SYSTEM.md §8, Z-up ENU): the world is Z-up with gravity
 * (0, 0, −g). The chassis body-local axes are x = forward, y = left, z = up;
 * the controller sets `indexUpAxis = 2` and forward axis index 0. One
 * subtlety measured against Rapier 0.20.0: the tyre forward direction the
 * solver drives along is `contact_normal × axle` (≈ up × axle), so the axle
 * must be chassis-local −y for the car to drive toward its local +x — with a
 * +y axle a positive engine force drives the car BACKWARD.
 * [MEASURED 2026-09-06, probe: +1500 N per wheel with axle (0,1,0) produced
 * −6.38 m/s along +x_local in 1 s; axle (0,−1,0) produced +6.38 m/s.]
 *
 * Drive/brake semantics (Bullet-derived solver model, verified against the
 * Rapier 0.20.0 Rust source `src/control/ray_cast_vehicle_controller.rs`):
 *   - Per wheel, the forward impulse is `engine_force · dt` when the engine
 *     force is nonzero; only when the engine force is ZERO does the wheel's
 *     brake act, as a rolling-friction impulse clamped to ±brake (N·s).
 *     Engine force and brake are therefore mutually exclusive per wheel.
 *   - This controller resolves the conflict in favour of brake (and
 *     handbrake): while a brake input is active the engine force is zeroed.
 *   - The friction-circle cap is `suspension_force · dt · friction_slip` per
 *     wheel — with the default tuning it never binds (≈ 386 N·s/wheel at
 *     static load vs a 25 N·s/wheel engine impulse).
 *   - `updateVehicle(dt, …)` applies impulses to the chassis directly and
 *     must be called once per tick BEFORE `world.step()`; `world.step()` does
 *     NOT update vehicle controllers itself.
 *   - The wheel raycasts do NOT exclude the chassis automatically (verified in
 *     the same source) — this controller passes a filter predicate that
 *     excludes every collider attached to the chassis body.
 *
 * Sleeping (ADR-002 caveat: never trust sleeping as a health signal): with no
 * active controls and a sleeping chassis, `preStep` skips `updateVehicle`
 * entirely — the solver's impulses are applied with wakeUp=false and must not
 * poke a sleeping body. Any active control wakes the chassis first.
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { addV, dot3, quatRotate, quatZ, subV, type Quat, type Vec3 } from '../engine/vec3';

/** Wheel order and indices. Front wheels (0, 1) steer; rear wheels (2, 3) take the handbrake. */
export const VEHICLE_WHEEL_ORDER = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'] as const;

/**
 * Vehicle tuning — the SINGLE home of the drive/suspension constants.
 *
 * Every value here is [PLACEHOLDER — tune at Phase 4]: chosen tonight to be
 * physically sane for a 900 kg car (derivations below) and to pass the
 * synthetic flat-ground tests, not yet tuned for feel, grip limits or the Dar
 * street network. The solver's parameter semantics (verified in the Rapier
 * 0.20.0 source) are what the derivations assume:
 *   - suspension spring force per wheel = `suspensionStiffness · compression ·
 *     chassisMass` → the effective per-wheel spring rate is
 *     `suspensionStiffness · chassisMass` N/m;
 *   - damper force per wheel = `damping · projectedRelativeVelocity ·
 *     chassisMass` (damping is a direct N/(m·s) figure scaled by chassis
 *     mass, NOT Bullet's dimensionless 0.83-class ratio);
 *   - damping ratio ζ = damping / √stiffness (per-mass terms cancel).
 */
export interface VehicleTuning {
  /** Per-mass suspension spring rate; k_wheel = value × chassisMass. 30 → k = 27 000 N/m, static sag ≈ 0.082 m at 900 kg [DERIVED]. */
  readonly suspensionStiffness: number;
  /** Compression-damper coefficient (ζ = value/√suspensionStiffness ≈ 0.35 [DERIVED]). */
  readonly suspensionDampingCompression: number;
  /** Rebound-damper coefficient (ζ ≈ 0.48 [DERIVED]; rebound ≥ compression keeps the car from floating on extension). */
  readonly suspensionDampingRelaxation: number;
  /** Suspension force clamp per wheel (N); must sit well above 4× the static per-wheel load (≈ 2 207 N). */
  readonly maxSuspensionForceNewtons: number;
  /** Suspension travel either side of the rest length (m), solver-clamped. */
  readonly maxSuspensionTravelMetres: number;
  /** Tyre traction parameter; friction-circle cap = suspensionForce · dt · value per wheel. Rapier default 10.5. */
  readonly frictionSlip: number;
  /** Lateral tyre friction multiplier (1 = solver's unilateral/bilateral impulse unchanged). */
  readonly sideFrictionStiffness: number;
  /** Side-impulse application-point shift toward the COM (0 = at contact, 1 = at COM); tames body roll. Inert tonight: the 0.20.0 JS bindings do not expose a setter, so the solver's Rust default 0.1 applies. */
  readonly rollInfluence: number;
  /** Drive force per wheel (N), all four wheels driven (AWD). */
  readonly maxEngineForceNewtons: number;
  /** Full-brake impulse clamp per wheel (N·s); a = 4·brakeImpulse·tickRate/mass ≈ 12 m/s² at 45. */
  readonly maxBrakeImpulseNewtonSeconds: number;
  /** Handbrake impulse clamp on the REAR wheels only (N·s). */
  readonly handbrakeImpulseNewtonSeconds: number;
  /** Maximum steering angle (rad) at steer input 1, front wheels only. */
  readonly maxSteerAngleRadians: number;
}

/**
 * [PLACEHOLDER — tune at Phase 4] The derivations behind the values:
 *   - Spring: k = 30 × 900 = 27 000 N/m per wheel; static per-wheel load
 *     900/4 × 9.80665 = 2 206.5 N → sag 0.0817 m inside the 0.3 m travel
 *     [DERIVED]; measured equilibrium chassis height 0.973 m for the default
 *     geometry [MEASURED 2026-09-06].
 *   - Damping: ζ_compression = 1.9/√30 = 0.35, ζ_relaxation = 2.6/√30 = 0.47
 *     [DERIVED] — underdamped but stable; the parked car settles and sleeps
 *     within the 1 s settle window [MEASURED 2026-09-06].
 *   - Drive: a = 4 × 1500/900 = 6.67 m/s² [DERIVED]; measured 19.985 m/s at
 *     3 s and 39.972 m/s at 6 s from rest [MEASURED 2026-09-06, the committed
 *     vehicle suite].
 *   - Brake: deceleration ≈ 4 × 45 × 60/900 = 12 m/s² [DERIVED]; measured
 *     15 m/s → <1 m/s in 1.317 s with 0.062 rad max pitch [MEASURED
 *     2026-09-06, the committed vehicle suite].
 *   - No aero drag, no rolling resistance, no top-speed limiter: full throttle
 *     accelerates without bound (a solver-model property, not a bug).
 */
export const DEFAULT_VEHICLE_TUNING: VehicleTuning = {
  suspensionStiffness: 30,
  suspensionDampingCompression: 1.9,
  suspensionDampingRelaxation: 2.6,
  maxSuspensionForceNewtons: 25000,
  maxSuspensionTravelMetres: 0.3,
  frictionSlip: 10.5,
  sideFrictionStiffness: 1.0,
  rollInfluence: 0.1,
  maxEngineForceNewtons: 1500,
  maxBrakeImpulseNewtonSeconds: 45,
  handbrakeImpulseNewtonSeconds: 60,
  maxSteerAngleRadians: 0.5,
};

/** Chassis collider and spawn parameters (bubble-local, f64). */
export interface VehicleChassisParams {
  /** Chassis cuboid half extents, body-local metres: x forward, y left, z up. */
  readonly halfExtentsMetres: Vec3;
  /** Chassis mass (kg); set on the cuboid collider, so Rapier derives the inertia from the shape. */
  readonly massKg: number;
  /** Chassis collider friction (scrape-only in normal driving; wheels are raycasts, not colliders). */
  readonly friction: number;
  /** Spawn position, bubble-local metres, f64 (the canonical state's birth value). */
  readonly spawnPositionMetres: Vec3;
  /** Spawn heading about +z (radians; 0 = facing local +x). */
  readonly spawnYawAboutUpRad: number;
}

/** Wheel placement and geometry (bubble-local, body-relative metres). */
export interface VehicleWheelGeometryParams {
  /** Front axle x offset from the chassis centre (+ = forward). */
  readonly frontAxleOffsetMetres: number;
  /** Rear axle x offset from the chassis centre (negative). */
  readonly rearAxleOffsetMetres: number;
  /** Half the track width: wheels sit at y = ±trackHalfWidthMetres. */
  readonly trackHalfWidthMetres: number;
  /** z offset of the suspension connection points (negative = below the chassis centre). */
  readonly connectionHeightOffsetMetres: number;
  /** Wheel radius (m) — the raycast wheel is virtual; there are no wheel colliders. */
  readonly wheelRadiusMetres: number;
  /** Suspension rest length (m), measured connection point → wheel centre. */
  readonly suspensionRestLengthMetres: number;
}

/** Everything a caller wires to build one car in one bounded bubble world. */
export interface VehicleControllerParams {
  /** The ONE Rapier world of the contact bubble this car lives in (Law PH-1). Its timestep is the vehicle's tick. */
  readonly world: RAPIER.World;
  readonly chassis: VehicleChassisParams;
  readonly wheels: VehicleWheelGeometryParams;
  /** See {@link DEFAULT_VEHICLE_TUNING} for the placeholder-grade default. */
  readonly tuning: VehicleTuning;
}

/**
 * Default Phase-4-groundwork geometry: a 4.0 × 1.7 × 0.7 m, 900 kg car with a
 * 2.5 m wheelbase, 1.7 m track, 0.4 m wheels and 0.5 m suspension, at the
 * {@link DEFAULT_VEHICLE_TUNING} tuning. `spawnPositionMetres` is exact f64;
 * for a ground plane at z = 0 the wheels just touch at
 * z_spawn = |connectionHeightOffset| + restLength + radius = 1.05 m — spawn a
 * few centimetres below that (e.g. 1.02) so the suspension starts
 * pre-compressed and settles without a drop bounce.
 */
export function makeDefaultVehicleParams(world: RAPIER.World, spawnPositionMetres: Vec3): VehicleControllerParams {
  return {
    world,
    chassis: {
      halfExtentsMetres: { x: 2.0, y: 0.85, z: 0.35 },
      massKg: 900,
      friction: 0.7, // ADR-002 Decision 5 solver baseline
      spawnPositionMetres: { ...spawnPositionMetres },
      spawnYawAboutUpRad: 0,
    },
    wheels: {
      frontAxleOffsetMetres: 1.25,
      rearAxleOffsetMetres: -1.25,
      trackHalfWidthMetres: 0.85,
      connectionHeightOffsetMetres: -0.15,
      wheelRadiusMetres: 0.4,
      suspensionRestLengthMetres: 0.5,
    },
    tuning: DEFAULT_VEHICLE_TUNING,
  };
}

/** Timestep-mismatch tolerance for the fixed-step guard (s). */
const DT_EPSILON = 1e-9;

/**
 * One car in one bounded bubble world: controls, tick stepping, and the f64
 * canonical state (position integrated in f64 over the solver's f32 deltas;
 * velocity and orientation widened at read).
 *
 * Tick contract: exactly ONE of
 *   - `update(dt)` — this controller owns the tick (preStep + world.step), or
 *   - `preStep(dt)` called by the caller immediately before ITS OWN
 *     `world.step()` (the Phase-4 `LocalScene` integration path, where the
 *     scene owns stepping).
 * may drive a given world per tick; `dt` must equal the world timestep.
 */
export class VehicleController {
  private readonly world: RAPIER.World;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly chassisBody: RAPIER.RigidBody;
  private readonly tuning: VehicleTuning;

  private throttle = 0; // −1..1 (reverse..full forward)
  private steer = 0; // −1..1 (right..left — positive steer turns LEFT, heading increases [MEASURED 2026-09-06])
  private brake = 0; // 0..1
  private handbrake = false;

  /** Canonical f64 position (bubble-local metres) — the ground truth. */
  private canonicalPositionMetres: Vec3;
  /** The solver's last seen position (f32 widened); the delta source for the integrator. */
  private lastSolverPositionMetres: Vec3;

  constructor(params: VehicleControllerParams) {
    this.world = params.world;
    this.tuning = params.tuning;
    const chassis = params.chassis;
    const wheels = params.wheels;

    const qSpawn = quatZ(chassis.spawnYawAboutUpRad);
    this.chassisBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(chassis.spawnPositionMetres.x, chassis.spawnPositionMetres.y, chassis.spawnPositionMetres.z)
        .setRotation(qSpawn),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(chassis.halfExtentsMetres.x, chassis.halfExtentsMetres.y, chassis.halfExtentsMetres.z)
        .setMass(chassis.massKg)
        .setFriction(chassis.friction)
        .setRestitution(0),
      this.chassisBody,
    );

    this.vehicle = this.world.createVehicleController(this.chassisBody);
    // Z-up chassis (§8): local up = +z (axis index 2), forward = local ±x —
    // the SIGN of forward is set by the axle choice below, not by this index.
    this.vehicle.indexUpAxis = 2;
    this.vehicle.setIndexForwardAxis = 0; // the 0.20.0 .d.ts names this setter `setIndexForwardAxis`

    // [FL, FR, RL, RR] — front wheels steer, rear wheels take the handbrake.
    // Axle = (0, −1, 0): the solver drives along ≈ up × axle, so −y axle makes
    // the car drive toward its local +x [MEASURED 2026-09-06 — see module doc].
    const connections: ReadonlyArray<readonly [number, number]> = [
      [wheels.frontAxleOffsetMetres, wheels.trackHalfWidthMetres],
      [wheels.frontAxleOffsetMetres, -wheels.trackHalfWidthMetres],
      [wheels.rearAxleOffsetMetres, wheels.trackHalfWidthMetres],
      [wheels.rearAxleOffsetMetres, -wheels.trackHalfWidthMetres],
    ];
    for (const [x, y] of connections) {
      this.vehicle.addWheel(
        { x, y, z: wheels.connectionHeightOffsetMetres },
        { x: 0, y: 0, z: -1 }, // suspension direction: chassis-local down
        { x: 0, y: -1, z: 0 }, // axle: −y (see above)
        wheels.suspensionRestLengthMetres,
        wheels.wheelRadiusMetres,
      );
    }
    if (this.vehicle.numWheels() !== 4) {
      throw new Error(`VehicleController: expected 4 wheels, got ${this.vehicle.numWheels()}`);
    }
    for (let i = 0; i < 4; i++) {
      this.vehicle.setWheelSuspensionStiffness(i, this.tuning.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, this.tuning.suspensionDampingCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, this.tuning.suspensionDampingRelaxation);
      this.vehicle.setWheelMaxSuspensionForce(i, this.tuning.maxSuspensionForceNewtons);
      this.vehicle.setWheelMaxSuspensionTravel(i, this.tuning.maxSuspensionTravelMetres);
      this.vehicle.setWheelFrictionSlip(i, this.tuning.frictionSlip);
      this.vehicle.setWheelSideFrictionStiffness(i, this.tuning.sideFrictionStiffness);
      // rollInfluence: NOT exposed by the 0.20.0 JS bindings — the solver uses
      // its Rust default 0.1 (Wheel::new). The tuning field is kept as the
      // Phase-4 reminder; it is inert until the binding gains a setter.
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, 0);
      this.vehicle.setWheelSteering(i, 0);
    }

    this.canonicalPositionMetres = { ...chassis.spawnPositionMetres };
    // Baseline the integrator NOW, while the solver still holds the spawn
    // pose: the f32 image of the f64 spawn. Basing lazily at the first read
    // instead would silently absorb every tick of motion before that read
    // into the baseline — the canonical state would lie (measured exactly
    // that way: a 5 s drive read 83.6 m off, and a parked car reported its
    // spawn height for the whole window). The permanent canonical-vs-solver
    // offset left behind is the f64-spawn−f32-spawn downcast class (~1e-7 m
    // at metre scale — sanctioned by Law P-2/P-1 at the boundary).
    const t0 = this.chassisBody.translation();
    this.lastSolverPositionMetres = { x: t0.x, y: t0.y, z: t0.z };
  }

  // --- controls -----------------------------------------------------------------

  /** Throttle, clamped to −1..1 (negative = reverse). */
  setThrottle(value: number): void {
    this.throttle = Math.min(1, Math.max(-1, value));
  }

  /**
   * Steering, clamped to −1..1. The input is NORMALIZED, not radians: the
   * front-wheel steer angle is `value × maxSteerAngleRadians` (0.5 rad at
   * full lock under {@link DEFAULT_VEHICLE_TUNING}; rear wheels unsteered).
   * Positive = LEFT turn (heading increases) [MEASURED 2026-09-06].
   * Heading response under that mapping at wheel angle 0.1 rad
   * (`setSteer(0.2)`), entering at ~19.1 m/s: +49.5° in 1 s with throttle
   * held (speed climbs through the turn), +42.7° in 1 s coasting [MEASURED
   * 2026-09-06]. (An early probe quoting +85.7° in 1 s had applied 0.2 rad
   * as the wheel angle directly, before the × maxSteerAngleRadians mapping
   * was finalized — it does not describe `setSteer(0.2)`.)
   */
  setSteer(value: number): void {
    this.steer = Math.min(1, Math.max(-1, value));
  }

  /** Brake, clamped to 0..1. Overrides throttle (the solver's per-wheel engine/brake exclusivity — see module doc). */
  setBrake(value: number): void {
    this.brake = Math.min(1, Math.max(0, value));
  }

  /** Handbrake: locks the REAR wheels and (like the brake) cuts the engine force. */
  setHandbrake(engaged: boolean): void {
    this.handbrake = engaged;
  }

  // --- tick stepping --------------------------------------------------------------

  /**
   * Applies the controls to the wheels and runs the solver's vehicle update
   * (impulses onto the chassis) for this tick — WITHOUT stepping the world.
   * For callers that own the world step (the Phase-4 `LocalScene` path):
   * call this immediately before your single `world.step()`.
   */
  preStep(dt: number): void {
    if (Math.abs(dt - this.world.timestep) > DT_EPSILON) {
      throw new Error(
        `VehicleController: dt ${dt} must equal the world timestep ${this.world.timestep} (fixed-step integration, ADR-002 Decision 5)`,
      );
    }
    const controlsActive = this.throttle !== 0 || this.steer !== 0 || this.brake > 0 || this.handbrake;
    if (controlsActive) {
      this.chassisBody.wakeUp(); // solver impulses apply with wakeUp=false — waking is on us
    } else if (this.chassisBody.isSleeping()) {
      return; // never poke a sleeping body (ADR-002 sleeping caveat); nothing to simulate
    }

    const braking = this.brake > 0 || this.handbrake;
    const engineForce = braking ? 0 : this.throttle * this.tuning.maxEngineForceNewtons;
    const brakeImpulse = this.brake > 0 ? this.brake * this.tuning.maxBrakeImpulseNewtonSeconds : 0;
    const steerAngle = this.steer * this.tuning.maxSteerAngleRadians;
    for (let i = 0; i < 4; i++) {
      const isFront = i === 0 || i === 1;
      const isRear = i === 2 || i === 3;
      this.vehicle.setWheelEngineForce(i, engineForce);
      const wheelBrakeImpulse =
        isRear && this.handbrake ? Math.max(brakeImpulse, this.tuning.handbrakeImpulseNewtonSeconds) : brakeImpulse;
      this.vehicle.setWheelBrake(i, wheelBrakeImpulse);
      this.vehicle.setWheelSteering(i, isFront ? steerAngle : 0);
    }
    // Exclude the chassis from its own wheel raycasts — the solver does NOT do
    // this itself (verified in the Rapier 0.20.0 source), and the connection
    // points sit inside the chassis cuboid.
    this.vehicle.updateVehicle(dt, undefined, undefined, this.wheelRayFilter);
  }

  /** Convenience tick for callers that let the vehicle own stepping: preStep + one `world.step()`. */
  update(dt: number): void {
    this.preStep(dt);
    this.world.step();
  }

  /** Excludes the chassis body's own colliders from the wheel raycasts. */
  private readonly wheelRayFilter = (collider: RAPIER.Collider): boolean => {
    const parent = collider.parent();
    return parent === null || parent.handle !== this.chassisBody.handle;
  };

  // --- canonical f64 state (Law P-1) ------------------------------------------------

  /**
   * Advances the f64 canonical position by the solver's f32 delta since the
   * last sync. Each delta is the difference of two f32 readings — exact in
   * f64 — so the accumulator is exact along the solver's own path. Lazy: any
   * read after ANY number of world steps (or a caller-side teleport, or a
   * scene-owned re-derivation) picks up exactly the accumulated delta, which
   * is what makes the canonical state rebase-coherent (Law P-6) without any
   * shift vector. The baseline is recorded in the constructor (see there).
   */
  private syncCanonicalPosition(): void {
    const t = this.chassisBody.translation();
    const delta = subV({ x: t.x, y: t.y, z: t.z }, this.lastSolverPositionMetres);
    this.canonicalPositionMetres = addV(this.canonicalPositionMetres, delta);
    this.lastSolverPositionMetres = { x: t.x, y: t.y, z: t.z };
  }

  /** Canonical position, bubble-local metres, f64 (defensive copy). */
  get positionMetres(): Vec3 {
    this.syncCanonicalPosition();
    return { ...this.canonicalPositionMetres };
  }

  /** Solver velocity widened to f64, bubble-local metres/second (fresh object). */
  get velocityMetresPerSecond(): Vec3 {
    const v = this.chassisBody.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Solver orientation widened to f64 (body-local → bubble-local axes; fresh object). */
  get orientationQuat(): Quat {
    const r = this.chassisBody.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  /** The chassis's forward axis (+x body-local) in bubble-local axes, f64. */
  get forwardVector(): Vec3 {
    return quatRotate(this.orientationQuat, { x: 1, y: 0, z: 0 });
  }

  /** Signed forward speed, m/s, f64: velocity · forwardVector (negative = reversing). */
  get speedMetresPerSecond(): number {
    return dot3(this.velocityMetresPerSecond, this.forwardVector);
  }

  /** Heading about +z, radians, f64: atan2(forward.y, forward.x). 0 = local +x; increases turning left. */
  get headingRadians(): number {
    const f = this.forwardVector;
    return Math.atan2(f.y, f.x);
  }

  // --- wiring + wheel diagnostics ------------------------------------------------

  /** The chassis rigid body (for meshes, joints, cargo — one bubble, no joints across solvers). */
  get chassisRigidBody(): RAPIER.RigidBody {
    return this.chassisBody;
  }

  /** The underlying Rapier vehicle controller (wheel diagnostics beyond {@link wheelInContact}). */
  get rapierVehicleController(): RAPIER.DynamicRayCastVehicleController {
    return this.vehicle;
  }

  /** Is wheel i (in {@link VEHICLE_WHEEL_ORDER} order) in contact with the ground? */
  wheelInContact(i: number): boolean {
    return this.vehicle.wheelIsInContact(i);
  }
}
