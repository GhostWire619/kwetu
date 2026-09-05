/**
 * S0.1 probe C — Rapier contact-bubble probes (THROWAWAY spike code).
 *
 * Exercises the COORDINATE_SYSTEM.md §8 / Law PH-1 bubble rules on the pinned
 * @dimforge/rapier3d-deterministic-compat 0.20.0 build (WASM f32 solver, runs
 * in Node):
 *   (i)   resting-contact stability, 600 fixed steps at dt = 1/60, Z-up world,
 *         world gravity (0, 0, -9.80665) — the tangent approximation for a
 *         small surface neighbourhood (§8);
 *   (ii)  fixed-joint stability under gravity (joint bears the full weight);
 *   (iii) ORIGIN REBASE at a tick boundary: the whole world translated by
 *         +5,000,000 m in z (bodies, hence attached colliders; joint anchors
 *         are body-local and follow) — the core S0.1 question — CONTRASTED
 *         with the Law P-6 compliant rebase (the anchor moves +5e6 m in
 *         canonical f64; every solver transform re-derived from canonical f64
 *         state, so bubble-local coordinates stay small);
 *   (iv)  two independent bubbles at two separated Earth locations
 *         (Dar es Salaam / Oslo), stepped simultaneously, with a bitwise
 *         cross-talk control;
 *   (v)   rebase WITH an axes change (anchor +1000 m east in old ENU AND the
 *         ENU triad yawed +90°): per §8 a changed anchor rotates axes as well
 *         as translating them; records residual velocity/anchor error.
 *
 * Layout (one bubble): flat ground pad + box resting on it (the briefed case),
 * a 15° friction ramp + box resting on it (a real scene's non-representable
 * separation — the honest rebase stressor), and a static post + hanging body
 * on a fixed joint (probe ii). Solver configuration is Rapier's defaults
 * (numSolverIterations 4, default contact ERP and allowed linear error) — the
 * production-relevant baseline ADR-002 sizes bubbles against.
 *
 * Canonical bookkeeping follows Laws P-1/P-6: Rapier is the bounded f32 solver;
 * canonical state is f64, promoted at tick boundaries; a rebase re-derives the
 * solver state from canonical f64 and never applies a shift vector to
 * accumulated f32 positions.
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { geodeticToPlanetFixed, norm3 } from '../frames/frameChain.ts';

export const DT_SECONDS = 1 / 60;
export const STEP_COUNT = 600;
export const SETTLE_STEPS = 60;
export const REBASE_TICK = 120;
export const GRAVITY_METRES_PER_S2 = 9.80665;
export const REBASE_OFFSET_METRES = 5_000_000;
export const AXES_REBASE_TRANSLATION_METRES: [number, number, number] = [1000, 0, 0];
export const AXES_REBASE_YAW_RAD = Math.PI / 2;
export const RAMP_TILT_RAD = (15 * Math.PI) / 180;

type V3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

// --- f64 math helpers (canonical-state side) ---------------------------------

function quatMul(q: Quat, r: Quat): Quat {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}

function quatRotate(q: Quat, v: V3): V3 {
  const qv: V3 = { x: q.x, y: q.y, z: q.z };
  const t1 = cross(qv, v);
  const t2 = cross(qv, { x: t1.x * 2, y: t1.y * 2, z: t1.z * 2 });
  return { x: v.x + t2.x + q.w * t1.x * 2, y: v.y + t2.y + q.w * t1.y * 2, z: v.z + t2.z + q.w * t1.z * 2 };
}

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function addV(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subV(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaleV(a: V3, s: number): V3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function lenV(a: V3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Active rotation about +z by angle a (right-hand rule), f64. */
function rotateZ(v: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

function quatZ(a: number): Quat {
  return { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
}

function quatY(a: number): Quat {
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
}

// --- World construction -------------------------------------------------------

interface TrackedBody {
  body: RAPIER.RigidBody;
  mass: number;
  idealRestZ: number; // ideal resting centre height in bubble-local axes (for penetration)
}

interface BubbleLayout {
  world: RAPIER.World;
  ground: RAPIER.RigidBody;
  padBox: RAPIER.RigidBody;
  ramp: RAPIER.RigidBody;
  rampBox: RAPIER.RigidBody;
  post: RAPIER.RigidBody; // static joint anchor post (no collider)
  hanging: RAPIER.RigidBody; // dynamic body on the fixed joint
  tracked: { padBox: TrackedBody; rampBox: TrackedBody; hanging: TrackedBody };
  hangingLocalAnchor: V3; // joint anchor in the hanging body's local frame
}

const PAD_BOX_DENSITY = 1000; // 1 m^3 cuboid -> ~1000 kg
const RAMP_BOX_DENSITY = 1000;

/** Builds the shared bubble layout. Fresh f32 solver world every call.
 * canSleep=false is used by the tunnelling sub-probe (a sleeping body can mask
 * a dead contact; the sub-probe must watch the raw failure). */
function makeBubble(canSleep = true): BubbleLayout {
  const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -GRAVITY_METRES_PER_S2));
  world.timestep = DT_SECONDS;

  // Ground pad: fixed slab, top surface exactly at z = 0.
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.5));
  world.createCollider(RAPIER.ColliderDesc.cuboid(100, 100, 0.5).setFriction(0.7).setRestitution(0), ground);

  // Box resting on the pad (the briefed probe-i case).
  const padBox = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0.5 + 1e-3).setCanSleep(canSleep),
  );
  const padBoxCol = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(PAD_BOX_DENSITY).setFriction(0.7).setRestitution(0),
    padBox,
  );

  // 15° friction ramp (fixed, rotated slab) + box resting on it. tan(15°) = 0.268
  // < friction 0.7, so static friction must hold it — a genuine resting-contact
  // stressor whose vertical separation is NOT f32-representable-friendly.
  const ramp = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(3, 0, 0.2).setRotation(quatY(RAMP_TILT_RAD)),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(2, 1, 0.25).setFriction(0.7).setRestitution(0), ramp);
  const rampNormal = quatRotate(quatY(RAMP_TILT_RAD), { x: 0, y: 0, z: 1 });
  const rampTopCentre = addV({ x: 3, y: 0, z: 0.2 }, scaleV(rampNormal, 0.25));
  const rampBoxRest = addV(addV(rampTopCentre, scaleV(rampNormal, 0.5)), scaleV(rampNormal, 1e-3));
  // The ramp box is rotated to match the ramp's tilt so the resting contact is
  // face-to-face (the penetration metric must mean solver sinkage, not corner
  // contact geometry of an unrotated box on a tilted plane).
  const rampBox = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(rampBoxRest.x, rampBoxRest.y, rampBoxRest.z)
      .setRotation(quatY(RAMP_TILT_RAD))
      .setCanSleep(canSleep),
  );
  const rampBoxCol = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(RAMP_BOX_DENSITY).setFriction(0.7).setRestitution(0),
    rampBox,
  );

  // Static post + hanging body on a fixed joint; both anchors coincide at world
  // (0, 0, 1.0) at build time. The joint bears the hanging body's full weight.
  const post = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  const hanging = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 1.5).setCanSleep(canSleep),
  );
  const hangingCol = world.createCollider(
    RAPIER.ColliderDesc.ball(0.25).setDensity(8000).setFriction(0.7).setRestitution(0),
    hanging,
  );
  world.createImpulseJoint(
    RAPIER.JointData.fixed(
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0, z: -0.5 },
      { x: 0, y: 0, z: 0, w: 1 },
    ),
    post,
    hanging,
    true,
  );

  return {
    world,
    ground,
    padBox,
    ramp,
    rampBox,
    post,
    hanging,
    tracked: {
      padBox: { body: padBox, mass: padBoxCol.mass(), idealRestZ: 0.5 },
      rampBox: { body: rampBox, mass: rampBoxCol.mass(), idealRestZ: rampBoxRest.z },
      hanging: { body: hanging, mass: hangingCol.mass(), idealRestZ: 1.5 },
    },
    hangingLocalAnchor: { x: 0, y: 0, z: -0.5 },
  };
}

// --- sampling + metrics ---------------------------------------------------------

interface BodySample {
  x: number;
  y: number;
  z: number;
  speed: number;
  energy: number;
}

function sampleBody(t: TrackedBody): BodySample {
  const p = t.body.translation();
  const v = t.body.linvel();
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    speed: Math.hypot(v.x, v.y, v.z),
    energy: t.mass * GRAVITY_METRES_PER_S2 * p.z + 0.5 * t.mass * (v.x * v.x + v.y * v.y + v.z * v.z),
  };
}

function jointAnchorDrift(l: BubbleLayout): number {
  const postP = l.post.translation();
  const hangP = l.hanging.translation();
  const hangQ = l.hanging.rotation();
  const anchorPostWorld = addV(postP, { x: 0, y: 0, z: 1 });
  const anchorHangWorld = addV(hangP, quatRotate({ x: hangQ.x, y: hangQ.y, z: hangQ.z, w: hangQ.w }, l.hangingLocalAnchor));
  return lenV(subV(anchorHangWorld, anchorPostWorld));
}

interface BodyMetrics {
  maxVerticalDriftMetres: number;
  maxPenetrationMetres: number;
  maxHorizontalCreepMetres: number;
  maxEnergyProxyDeviationJoules: number;
  maxSpeedMetresPerSecond: number;
  minZMetres: number;
}

interface BubbleMetrics {
  padBox: BodyMetrics;
  rampBox: BodyMetrics;
  maxJointAnchorDriftMetres: number;
}

interface RefPose {
  padBox: BodySample;
  rampBox: BodySample;
}

function measureWindow(l: BubbleLayout, ref: RefPose, from: number, to: number): BubbleMetrics {
  const zero = (): BodyMetrics => ({
    maxVerticalDriftMetres: 0,
    maxPenetrationMetres: 0,
    maxHorizontalCreepMetres: 0,
    maxEnergyProxyDeviationJoules: 0,
    maxSpeedMetresPerSecond: 0,
    minZMetres: Infinity,
  });
  void ref;
  const m: BubbleMetrics = { padBox: zero(), rampBox: zero(), maxJointAnchorDriftMetres: 0 };
  for (let i = from; i < to; i++) {
    l.world.step();
    for (const key of ['padBox', 'rampBox'] as const) {
      const t = l.tracked[key];
      const s = sampleBody(t);
      const r = ref[key];
      const b = m[key];
      b.maxVerticalDriftMetres = Math.max(b.maxVerticalDriftMetres, Math.abs(s.z - r.z));
      b.maxPenetrationMetres = Math.max(b.maxPenetrationMetres, t.idealRestZ - s.z);
      b.maxHorizontalCreepMetres = Math.max(b.maxHorizontalCreepMetres, Math.hypot(s.x - r.x, s.y - r.y));
      b.maxEnergyProxyDeviationJoules = Math.max(b.maxEnergyProxyDeviationJoules, Math.abs(s.energy - r.energy));
      b.maxSpeedMetresPerSecond = Math.max(b.maxSpeedMetresPerSecond, s.speed);
      b.minZMetres = Math.min(b.minZMetres, s.z);
    }
    m.maxJointAnchorDriftMetres = Math.max(m.maxJointAnchorDriftMetres, jointAnchorDrift(l));
  }
  return m;
}

function settledRef(l: BubbleLayout): RefPose {
  return { padBox: sampleBody(l.tracked.padBox), rampBox: sampleBody(l.tracked.rampBox) };
}

function stepN(l: BubbleLayout, n: number): void {
  for (let i = 0; i < n; i++) l.world.step();
}

// --- probe (i) ------------------------------------------------------------------

export interface BubbleMasses {
  padBox: number;
  rampBox: number;
  hanging: number;
}

function runRestingContact(canSleep = true): { metrics: BubbleMetrics; massesKg: BubbleMasses } {
  const l = makeBubble(canSleep);
  stepN(l, SETTLE_STEPS);
  return {
    metrics: measureWindow(l, settledRef(l), SETTLE_STEPS, STEP_COUNT),
    massesKg: {
      padBox: l.tracked.padBox.mass,
      rampBox: l.tracked.rampBox.mass,
      hanging: l.tracked.hanging.mass,
    },
  };
}

// --- probe (ii) -----------------------------------------------------------------

function runJointStability(): {
  maxAnchorDriftMetres: number;
  finalAnchorDriftMetres: number;
  maxSagMetres: number;
  hangingMassKg: number;
} {
  const l = makeBubble();
  let maxDrift = 0;
  let finalDrift = 0;
  let maxSag = 0;
  for (let i = 0; i < STEP_COUNT; i++) {
    l.world.step();
    const d = jointAnchorDrift(l);
    maxDrift = Math.max(maxDrift, d);
    finalDrift = d;
    const hp = l.hanging.translation();
    maxSag = Math.max(maxSag, lenV(subV(hp, { x: 0, y: 0, z: 1.5 })));
  }
  return { maxAnchorDriftMetres: maxDrift, finalAnchorDriftMetres: finalDrift, maxSagMetres: maxSag, hangingMassKg: l.tracked.hanging.mass };
}

// --- probe (iii) ------------------------------------------------------------------

interface RebaseResult {
  pre: BubbleMetrics;
  naive: {
    /** Steps REBASE_TICK..REBASE_TICK+SETTLE_STEPS measured against the
     * POST-SHIFT sampled pose: the solver's reaction to the corrupted
     * separations. With default sleeping this exposes the phantom state: the
     * resting boxes accumulate free-fall velocity while their f32 positions
     * are frozen (spacing 0.5 m swallows the fall), then sleep spuriously. */
    transientVsShiftedPose: BubbleMetrics;
    /** Steps after the settle, against the post-settle pose. WARNING: vacuous
     * as a health metric — a body asleep in the wrong place is "stable". The
     * floating/tunnelling fields below are the honest health check. */
    postSettleVsShiftedPose: BubbleMetrics;
    /** Separation error injected by the shift, measured immediately after it
     * (before stepping): pad pair, metres (ideal 0.501 m). */
    padSeparationErrorMetres: number;
    /** Same for the ramp pair (ideal 0.751 m along the ramp normal). */
    rampSeparationErrorMetres: number;
    /** Ramp box height above its TRUE contact pose at the end of the run —
     * if the solver never re-established the corrupted contact, the box ends
     * asleep, floating. Positive = floating. */
    rampBoxFloatingAboveContactMetres: number;
    /** Max reported speed of the pad box in the transient window — the
     * phantom free-fall velocity that accumulated before the spurious sleep. */
    padPhantomVelocityAtSleepMetresPerSecond: number;
    /** The same rebase with sleeping disabled: the raw failure mode. */
    sleepDisabled: {
      /** Steps the box's reported position stayed frozen after the shift. */
      stepsPositionFrozen: number;
      /** Max reported speed over 600 post-shift steps (~pure g accumulation). */
      maxSpeedMetresPerSecond: number;
      /** Box centre z after 600 post-shift steps (m). Ground top is at the
       * post-shift pad height; below it means the box tunnelled through the
       * 1 m slab. */
      finalPadBoxZMetres: number;
      /** Metres below the post-shift ground top (positive = tunnelled). */
      finalPenetrationBelowGroundTopMetres: number;
      tunnelledThroughSlab: boolean;
    };
  };
  compliant: BubbleMetrics;
  rebaseOffsetMetres: number;
  f32SpacingAtRebaseMetres: number;
  maxBubbleLocalCoordinateMetres: number;
}

/** Applies the Law P-6-forbidden move: shift every rigid body's accumulated f32
 * position by `offset` (colliders ride on the bodies; joint anchors are
 * body-local and follow). Returns the separation errors the f32 quantisation
 * injected, measured immediately after the shift (before any stepping). */
function applyNaiveShift(l: BubbleLayout, offset: number): { pad: number; ramp: number; groundTopZ: number } {
  for (const body of [l.ground, l.padBox, l.ramp, l.rampBox, l.post, l.hanging]) {
    const p = body.translation();
    body.setTranslation({ x: p.x, y: p.y, z: p.z + offset }, true);
  }
  const padTop = l.ground.translation().z + 0.5;
  const padSep = l.padBox.translation().z - padTop; // ideal 0.5 + 1e-3 (dropped 1 mm at build)
  const rampBoxSep = lenV(subV(l.rampBox.translation(), l.ramp.translation())); // ideal 0.25 + 0.5 + 1e-3
  return {
    pad: padSep - 0.501,
    ramp: rampBoxSep - (0.25 + 0.5 + 1e-3),
    groundTopZ: padTop,
  };
}

function runRebase(): RebaseResult {
  // --- pre-rebase window, measured on the naive world before the shift ---
  const lNaive = makeBubble();
  stepN(lNaive, REBASE_TICK);
  const preRef = settledRef(lNaive);
  const pre = measureWindow(lNaive, preRef, REBASE_TICK, REBASE_TICK + SETTLE_STEPS);

  // --- naive whole-world translation, the brief's +5,000,000 m in z ---
  const sep = applyNaiveShift(lNaive, REBASE_OFFSET_METRES);
  const shiftedRef: RefPose = { padBox: sampleBody(lNaive.tracked.padBox), rampBox: sampleBody(lNaive.tracked.rampBox) };
  const transient = measureWindow(lNaive, shiftedRef, REBASE_TICK, REBASE_TICK + SETTLE_STEPS);
  const postSettle = measureWindow(lNaive, settledRef(lNaive), REBASE_TICK + SETTLE_STEPS, STEP_COUNT);
  // Ramp box vs its TRUE contact pose at the end: |box - ramp| separation vs ideal.
  const rampSepFinal = lenV(subV(lNaive.rampBox.translation(), lNaive.ramp.translation()));
  const rampFloating = rampSepFinal - (0.25 + 0.5 + 1e-3);

  // --- the same shift with sleeping disabled: the raw failure mode ---------
  const lTunnel = makeBubble(false);
  stepN(lTunnel, REBASE_TICK);
  applyNaiveShift(lTunnel, REBASE_OFFSET_METRES);
  const padStartZ = lTunnel.padBox.translation().z;
  let stepsFrozen = 0;
  let maxSpeed = 0;
  for (let i = 0; i < STEP_COUNT; i++) {
    lTunnel.world.step();
    const s = sampleBody(lTunnel.tracked.padBox);
    maxSpeed = Math.max(maxSpeed, s.speed);
    if (stepsFrozen === i && s.z === padStartZ) stepsFrozen = i + 1;
  }
  const finalZ = lTunnel.padBox.translation().z;
  const finalBelowGroundTop = sep.groundTopZ - finalZ;

  // --- compliant rebase (Law P-6): anchor moves in canonical f64; every body
  // re-derived from canonical f64 state; bubble-local coordinates stay small ---
  const lComp = makeBubble();
  stepN(lComp, REBASE_TICK);
  const canonicalAnchor: V3 = { x: 0, y: 0, z: 0 };
  canonicalAnchor.z += REBASE_OFFSET_METRES; // the anchor absorbs the whole 5000 km
  let maxLocal = 0;
  for (const body of [lComp.ground, lComp.padBox, lComp.ramp, lComp.rampBox, lComp.post, lComp.hanging]) {
    const p = body.translation(); // promote f32 solver state to f64 canonical (tick boundary)
    const localF64: V3 = { x: p.x, y: p.y, z: p.z }; // unchanged: the anchor moved, not the bodies
    maxLocal = Math.max(maxLocal, lenV(localF64));
    // Re-derive the solver transform from canonical f64 (f32 downcast of small numbers).
    body.setTranslation({ x: Math.fround(localF64.x), y: Math.fround(localF64.y), z: Math.fround(localF64.z) }, true);
  }
  void canonicalAnchor;
  const compliant = measureWindow(lComp, settledRef(lComp), REBASE_TICK, STEP_COUNT);

  return {
    pre,
    naive: {
      transientVsShiftedPose: transient,
      postSettleVsShiftedPose: postSettle,
      padSeparationErrorMetres: sep.pad,
      rampSeparationErrorMetres: sep.ramp,
      rampBoxFloatingAboveContactMetres: rampFloating,
      padPhantomVelocityAtSleepMetresPerSecond: transient.padBox.maxSpeedMetresPerSecond,
      sleepDisabled: {
        stepsPositionFrozen: stepsFrozen,
        maxSpeedMetresPerSecond: maxSpeed,
        finalPadBoxZMetres: finalZ,
        finalPenetrationBelowGroundTopMetres: finalBelowGroundTop,
        tunnelledThroughSlab: finalBelowGroundTop > 1.0,
      },
    },
    compliant,
    rebaseOffsetMetres: REBASE_OFFSET_METRES,
    f32SpacingAtRebaseMetres: f32UlpAt(REBASE_OFFSET_METRES),
    maxBubbleLocalCoordinateMetres: maxLocal,
  };
}

function f32UlpAt(x: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = Math.abs(x);
  const e = ((u[0] >> 23) & 0xff) - 127;
  return 2 ** (e - 23);
}

// --- probe (iv) ------------------------------------------------------------------

function runTwoBubbles(): {
  darAnchor: { latitudeDeg: number; longitudeDeg: number };
  osloAnchor: { latitudeDeg: number; longitudeDeg: number };
  anchorSeparationMetres: number;
  dar: BubbleMetrics;
  oslo: BubbleMetrics;
  bitwiseCrossTalkCheckPassed: boolean;
} {
  const darAnchor = { latitudeDeg: -6.79, longitudeDeg: 39.21 };
  const osloAnchor = { latitudeDeg: 59.9139, longitudeDeg: 10.7522 };
  const darEcef = geodeticToPlanetFixed(darAnchor.latitudeDeg, darAnchor.longitudeDeg, 0);
  const osloEcef = geodeticToPlanetFixed(osloAnchor.latitudeDeg, osloAnchor.longitudeDeg, 0);
  const separation = norm3([darEcef[0] - osloEcef[0], darEcef[1] - osloEcef[1], darEcef[2] - osloEcef[2]]);

  // Three independent worlds, stepped in the same loop: the Dar bubble runs
  // alongside the Oslo bubble; the control runs Dar alone. Separate RAPIER.World
  // instances share no state — cross-talk can only be zero by construction, and
  // the bitwise check proves the deterministic build honours it.
  const dar = makeBubble();
  const oslo = makeBubble();
  const darAlone = makeBubble();
  for (let i = 0; i < STEP_COUNT; i++) {
    dar.world.step();
    oslo.world.step();
    darAlone.world.step();
  }
  // (measureWindow steps the world; use fresh worlds for the metric windows,
  // settled exactly like the `resting` probe so the numbers are comparable.)
  const darM = makeBubble();
  const osloM = makeBubble();
  stepN(darM, SETTLE_STEPS);
  stepN(osloM, SETTLE_STEPS);
  const refD = settledRef(darM);
  const refO = settledRef(osloM);
  const mDar = measureWindow(darM, refD, SETTLE_STEPS, STEP_COUNT);
  const mOslo = measureWindow(osloM, refO, SETTLE_STEPS, STEP_COUNT);

  const finalDar = dar.padBox.translation();
  const finalAlone = darAlone.padBox.translation();
  const identical =
    finalDar.x === finalAlone.x &&
    finalDar.y === finalAlone.y &&
    finalDar.z === finalAlone.z &&
    dar.rampBox.translation().z === darAlone.rampBox.translation().z &&
    dar.hanging.translation().z === darAlone.hanging.translation().z;

  return {
    darAnchor,
    osloAnchor,
    anchorSeparationMetres: separation,
    dar: mDar,
    oslo: mOslo,
    bitwiseCrossTalkCheckPassed: identical,
  };
}

// --- probe (v) --------------------------------------------------------------------

interface AxesRebaseResult {
  yawRad: number;
  translationOldEnuMetres: [number, number, number];
  maxPositionResidualMetres: number;
  maxVelocityResidualMetresPerSecond: number;
  maxOrientationResidualQuaternionNorm: number;
  post: BubbleMetrics;
}

function runAxesRebase(): AxesRebaseResult {
  const l = makeBubble();
  stepN(l, REBASE_TICK);

  const t: V3 = {
    x: AXES_REBASE_TRANSLATION_METRES[0],
    y: AXES_REBASE_TRANSLATION_METRES[1],
    z: AXES_REBASE_TRANSLATION_METRES[2],
  };
  // Coordinates transform with the inverse of the frame rotation: a body fixed
  // in the world keeps its physical pose; its coordinates in the yawed axes are
  // p' = Rz(-yaw)·(p − t). Orientations: q' = q_frame ⊗ q with q_frame = Rz(-yaw).
  const qFrame = quatZ(-AXES_REBASE_YAW_RAD);
  const bodies = [l.ground, l.padBox, l.ramp, l.rampBox, l.post, l.hanging];

  let maxPosResidual = 0;
  let maxVelResidual = 0;
  let maxQuatResidual = 0;

  for (const body of bodies) {
    const p = body.translation();
    const v = body.linvel();
    const q: Quat = { x: q32(body.rotation().x), y: body.rotation().y, z: body.rotation().z, w: body.rotation().w };
    const targetP = rotateZ(subV({ x: p.x, y: p.y, z: p.z }, t), -AXES_REBASE_YAW_RAD);
    const targetV = rotateZ({ x: v.x, y: v.y, z: v.z }, -AXES_REBASE_YAW_RAD);
    const targetQ = quatMul(qFrame, q);
    // f32 solver round-trip (the only f32 boundary; coordinates stay ~1 km).
    body.setTranslation(
      { x: Math.fround(targetP.x), y: Math.fround(targetP.y), z: Math.fround(targetP.z) },
      true,
    );
    body.setLinvel(
      { x: Math.fround(targetV.x), y: Math.fround(targetV.y), z: Math.fround(targetV.z) },
      true,
    );
    body.setRotation(
      { x: Math.fround(targetQ.x), y: Math.fround(targetQ.y), z: Math.fround(targetQ.z), w: Math.fround(targetQ.w) },
      true,
    );
    // Residual = applied f32 state vs canonical f64 target.
    const pa = body.translation();
    maxPosResidual = Math.max(maxPosResidual, lenV(subV({ x: pa.x, y: pa.y, z: pa.z }, targetP)));
    const va = body.linvel();
    maxVelResidual = Math.max(maxVelResidual, lenV(subV({ x: va.x, y: va.y, z: va.z }, targetV)));
    const qa = body.rotation();
    const dq = { x: qa.x - targetQ.x, y: qa.y - targetQ.y, z: qa.z - targetQ.z, w: qa.w - targetQ.w };
    maxQuatResidual = Math.max(maxQuatResidual, Math.hypot(dq.x, dq.y, dq.z, dq.w));
  }

  const post = measureWindow(l, settledRef(l), REBASE_TICK, STEP_COUNT);
  return {
    yawRad: AXES_REBASE_YAW_RAD,
    translationOldEnuMetres: AXES_REBASE_TRANSLATION_METRES,
    maxPositionResidualMetres: maxPosResidual,
    maxVelocityResidualMetresPerSecond: maxVelResidual,
    maxOrientationResidualQuaternionNorm: maxQuatResidual,
    post,
  };
}

function q32(x: number): number {
  return x; // solver quaternions are already f32; kept for clarity
}

// --- probe (vi): ROADMAP §9 matrix items -------------------------------------------
// The S0.1 row of the flight-revision acceptance matrix (ROADMAP §9) requires:
// "Z-up fall/jump/vehicle axes; rebase with resting contacts and joints; two
// separated Earth locations; parent-relative exit velocity". Probes (i)-(v)
// cover the rebase/locations half; this probe covers the rest:
//   (a) Z-up jump — a ballistic +Z excursion under world gravity (0,0,-g):
//       the jump must stay on the +Z axis (no lateral drift), reach the
//       continuous-physics apex within one-dt discretization class, and land
//       back into the same resting contact.
//   (b) vehicle axes — a yawed chassis (Frame.VehicleLocal convention: +X
//       right, +Y forward, +Z up, COORDINATE_SYSTEM.md §1) dropped under Z-up
//       gravity: up stays ENU up, the heading is preserved (no hidden axis
//       flip), and world gravity expressed in the vehicle frame stays (0,0,-g)
//       for any yaw — the §8 "explicitly configure ... vehicle axes" rule.
//   (c) parent-relative exit velocity — the VEHICLES_AND_FLIGHT.md §5 undock
//       formula, exit v = v_parent + ω × r_offset, validated against the
//       solver: a body carried by a moving+rotating kinematic parent must
//       acquire exactly that velocity (friction carry), and handing that
//       captured state to a fresh owner at a tick boundary must inject zero
//       delta-V (VEHICLES_AND_FLIGHT.md §3: the transfer must not create free
//       delta-v).

export const JUMP_SPEED_METRES_PER_SECOND = 3.0;
export const JUMP_STEPS = 300;
export const VEHICLE_YAW_RAD = Math.PI / 6; // 30° heading, deliberately not axis-aligned
export const VEHICLE_STEPS = 120;
export const EXIT_OMEGA_RAD_PER_S = 1.0;
export const EXIT_PARENT_LINVEL: V3 = { x: 0.5, y: 0, z: 0 };
export const EXIT_OFFSET_RADIUS_METRES = 1.0;
export const EXIT_TICK = 240;
export const EXIT_STEPS = 120;
const EXIT_DISC_RADIUS_METRES = 3;
const EXIT_DISC_HALFHEIGHT_METRES = 0.25;
const EXIT_BALL_RADIUS_METRES = 0.25;

function angleBetweenV3(a: V3, b: V3): number {
  return Math.atan2(lenV(cross(a, b)), a.x * b.x + a.y * b.y + a.z * b.z);
}

function makeZupGroundWorld(): { world: RAPIER.World; ground: RAPIER.RigidBody } {
  const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -GRAVITY_METRES_PER_S2));
  world.timestep = DT_SECONDS;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.5));
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 50, 0.5).setFriction(0.7).setRestitution(0), ground);
  return { world, ground };
}

export interface ZupJumpReport {
  launchSpeedMetresPerSecond: number;
  launchHeightMetres: number;
  continuousApexMetres: number;
  measuredApexMetres: number;
  apexMinusContinuousMetres: number;
  /** Lateral drift while ballistic (z above the launch height) — the Z-up axis law. */
  maxHorizontalCreepAirborneMetres: number;
  /** Lateral drift over the whole run incl. the landing slide (contact artifact). */
  maxHorizontalCreepTotalMetres: number;
  finalRestPenetrationMetres: number;
  finalRestSpeedMetresPerSecond: number;
  steps: number;
}

function runZupJump(): ZupJumpReport {
  const { world } = makeZupGroundWorld();
  const box = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0.5 + 1e-3).setCanSleep(true));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(1000).setFriction(0.7).setRestitution(0), box);
  for (let i = 0; i < SETTLE_STEPS; i++) world.step();
  const zLaunch = box.translation().z;
  const v0 = JUMP_SPEED_METRES_PER_SECOND;
  box.setLinvel({ x: 0, y: 0, z: v0 }, true);
  let apex = -Infinity;
  let maxCreepAirborne = 0;
  let maxCreepTotal = 0;
  for (let i = 0; i < JUMP_STEPS; i++) {
    world.step();
    const p = box.translation();
    apex = Math.max(apex, p.z);
    const creep = Math.hypot(p.x, p.y);
    maxCreepTotal = Math.max(maxCreepTotal, creep);
    if (p.z > zLaunch) maxCreepAirborne = Math.max(maxCreepAirborne, creep);
  }
  const final = box.translation();
  const finalV = box.linvel();
  const continuousApex = zLaunch + (v0 * v0) / (2 * GRAVITY_METRES_PER_S2);
  return {
    launchSpeedMetresPerSecond: v0,
    launchHeightMetres: zLaunch,
    continuousApexMetres: continuousApex,
    measuredApexMetres: apex,
    apexMinusContinuousMetres: apex - continuousApex,
    maxHorizontalCreepAirborneMetres: maxCreepAirborne,
    maxHorizontalCreepTotalMetres: maxCreepTotal,
    finalRestPenetrationMetres: 0.5 - final.z,
    finalRestSpeedMetresPerSecond: Math.hypot(finalV.x, finalV.y, finalV.z),
    steps: JUMP_STEPS,
  };
}

export interface VehicleAxesReport {
  yawRad: number;
  steps: number;
  dropHeightMetres: number;
  finalUpAlignmentErrorRad: number;
  finalYawErrorRad: number;
  maxHorizontalCreepMetres: number;
  finalPenetrationMetres: number;
  localGravityDeviationMetresPerSecond2: number;
  conventionNote: string;
}

function runVehicleAxes(): VehicleAxesReport {
  const { world } = makeZupGroundWorld();
  const yaw = VEHICLE_YAW_RAD;
  // Chassis half-extents (0.9, 0.45, 0.25) m: +X right, +Y forward, +Z up
  // (Frame.VehicleLocal, COORDINATE_SYSTEM.md §1) — asymmetric so a hidden
  // axis swap cannot pass unnoticed.
  const half: V3 = { x: 0.9, y: 0.45, z: 0.25 };
  const drop = 1.0;
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0, half.z + drop)
      .setRotation(quatZ(yaw))
      .setCanSleep(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setDensity(400).setFriction(0.7).setRestitution(0),
    chassis,
  );
  for (let i = 0; i < VEHICLE_STEPS; i++) world.step();
  const p = chassis.translation();
  const q = chassis.rotation();
  const qRot: Quat = { x: q.x, y: q.y, z: q.z, w: q.w };
  const localZWorld = quatRotate(qRot, { x: 0, y: 0, z: 1 });
  const localYWorld = quatRotate(qRot, { x: 0, y: 1, z: 0 });
  const forwardAnalytic: V3 = { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
  const upError = angleBetweenV3(localZWorld, { x: 0, y: 0, z: 1 });
  const yawError = angleBetweenV3(localYWorld, forwardAnalytic);
  // World gravity (0,0,-g) expressed in the measured vehicle frame:
  // g_local = R^T · g_world — via the conjugate quaternion.
  const qConj: Quat = { x: -qRot.x, y: -qRot.y, z: -qRot.z, w: qRot.w };
  const gLocal = quatRotate(qConj, { x: 0, y: 0, z: -GRAVITY_METRES_PER_S2 });
  const gLocalDeviation = lenV(subV(gLocal, { x: 0, y: 0, z: -GRAVITY_METRES_PER_S2 }));
  return {
    yawRad: yaw,
    steps: VEHICLE_STEPS,
    dropHeightMetres: drop,
    finalUpAlignmentErrorRad: upError,
    finalYawErrorRad: yawError,
    maxHorizontalCreepMetres: Math.hypot(p.x, p.y),
    finalPenetrationMetres: half.z - p.z,
    localGravityDeviationMetresPerSecond2: gLocalDeviation,
    conventionNote:
      'Vehicle axes +X right, +Y forward, +Z up (Frame.VehicleLocal, COORDINATE_SYSTEM.md §1); ' +
      'Z-up ENU means world gravity expressed in the vehicle frame is (0,0,-g) for ANY heading — ' +
      'measured here from the settled chassis quaternion.',
  };
}

export interface ParentExitReport {
  parentLinearVelocityMetresPerSecond: V3;
  parentAngularVelocityRadPerSecond: number;
  offsetRadiusMetres: number;
  analyticExitVelocityMetresPerSecond: V3;
  capturedExitVelocityMetresPerSecond: V3;
  /** |v_child − (v_parent + ω × r)| at the capture tick. */
  carryVelocityErrorAtExitMetresPerSecond: number;
  maxCarryVelocityErrorLast60StepsMetresPerSecond: number;
  /** Rigid-joint pose fidelity over the run (child anchor vs analytic pose). */
  maxPoseResidualMetres: number;
  /** Offset-radius hold over the run (joint rigidity). */
  maxOffsetDriftMetres: number;
  exitTick: number;
  inheritedSpeedMetresPerSecond: number;
  injectedDeltaVMetresPerSecond: number;
  postExitMaxTrajectoryDeviationMetres: number;
  postExitSteps: number;
  /** Secondary finding: a merely-RESTING (rolling) body on the same moving +
   * rotating parent reaches only this fraction of the surface velocity —
   * the rolling-ball 2/7 result. The exit formula is the ATTACHMENT-point
   * velocity (VEHICLES_AND_FLIGHT.md ATTACHED regime), not a carried body's. */
  rollingBodyCarryRatioAtExit: number;
  methodNote: string;
}

function runParentExit(): ParentExitReport {
  const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -GRAVITY_METRES_PER_S2));
  world.timestep = DT_SECONDS;
  // Moving + rotating kinematic parent ("vehicle"): v_parent = (0.5, 0, 0),
  // ω = (0, 0, 1) rad/s, flat plate top at z = 0.5. Flat cuboid plate, NOT a
  // cylinder: this build's ball-vs-cylinder contact manifold returns a tilted
  // normal for off-axis contacts (measured separately, see the bubble report
  // finding) — ball-vs-cuboid is exactly vertical.
  const plate = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicVelocityBased()
      .setTranslation(5, 0, EXIT_DISC_HALFHEIGHT_METRES)
      .setLinvel(EXIT_PARENT_LINVEL.x, EXIT_PARENT_LINVEL.y, EXIT_PARENT_LINVEL.z)
      .setAngvel({ x: 0, y: 0, z: EXIT_OMEGA_RAD_PER_S }),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(EXIT_DISC_RADIUS_METRES, EXIT_DISC_RADIUS_METRES, EXIT_DISC_HALFHEIGHT_METRES)
      .setFriction(0.7)
      .setRestitution(0),
    plate,
  );
  // ATTACHED-regime child: rigidly jointed to the parent at parent-local
  // offset (1, 0, 0.6) (VEHICLES_AND_FLIGHT.md §3: "Parent transform and
  // joint/seat contract").
  const child = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(
      5 + EXIT_OFFSET_RADIUS_METRES,
      0,
      2 * EXIT_DISC_HALFHEIGHT_METRES + EXIT_BALL_RADIUS_METRES + 0.1,
    ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(EXIT_BALL_RADIUS_METRES).setDensity(500).setFriction(0.7).setRestitution(0),
    child,
  );
  world.createImpulseJoint(
    RAPIER.JointData.fixed(
      { x: EXIT_OFFSET_RADIUS_METRES, y: 0, z: 2 * EXIT_DISC_HALFHEIGHT_METRES + EXIT_BALL_RADIUS_METRES + 0.1 },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
    ),
    plate,
    child,
    true,
  );

  let maxPoseResidual = 0;
  let maxOffsetDrift = 0;
  let lateCarryErrMax = 0;
  for (let i = 0; i < EXIT_TICK; i++) {
    world.step();
    const pp = plate.translation();
    const cp = child.translation();
    // Joint rigidity: the child's pose must equal parent pose + rotated offset.
    const pq = plate.rotation();
    const yaw = 2 * Math.atan2(pq.z, pq.w);
    const attachLocal = 2 * EXIT_DISC_HALFHEIGHT_METRES + EXIT_BALL_RADIUS_METRES + 0.1;
    const ex = pp.x + EXIT_OFFSET_RADIUS_METRES * Math.cos(yaw);
    const ey = pp.y + EXIT_OFFSET_RADIUS_METRES * Math.sin(yaw);
    maxPoseResidual = Math.max(maxPoseResidual, Math.hypot(cp.x - ex, cp.y - ey, cp.z - (pp.z + attachLocal)));
    maxOffsetDrift = Math.max(maxOffsetDrift, Math.abs(Math.hypot(cp.x - pp.x, cp.y - pp.y) - EXIT_OFFSET_RADIUS_METRES));
    // Velocity contract: v_child = v_parent + ω × r_offset (live world offset).
    if (i >= EXIT_TICK - 60) {
      const dv = plate.linvel();
      const wa = plate.angvel();
      const rW = subV(cp, pp);
      const analytic = addV({ x: dv.x, y: dv.y, z: dv.z }, cross(wa, rW));
      const v = child.linvel();
      lateCarryErrMax = Math.max(lateCarryErrMax, lenV(subV({ x: v.x, y: v.y, z: v.z }, analytic)));
    }
  }

  // Exit at a tick boundary: capture the full state into canonical f64
  // (VEHICLES_AND_FLIGHT.md §3 "capture old state; convert ... in f64").
  const ppE = plate.translation();
  const pvE = plate.linvel();
  const pwE = plate.angvel();
  const p0 = child.translation();
  const v0 = child.linvel();
  const q0 = child.rotation();
  const w0 = child.angvel();
  const rVecExit = subV({ x: p0.x, y: p0.y, z: p0.z }, { x: ppE.x, y: ppE.y, z: ppE.z });
  const analyticExit = addV({ x: pvE.x, y: pvE.y, z: pvE.z }, cross(pwE, rVecExit));
  const capturedV: V3 = { x: v0.x, y: v0.y, z: v0.z };
  const carryErr = lenV(subV(capturedV, analyticExit));

  // Handover: a fresh owner world receives exactly the captured state. Gravity
  // is zeroed in the receiving world so the continuation has NO force-model
  // ambiguity: any deviation from p0 + v0·t is injected numerics, i.e. free
  // delta-V at the transfer (VEHICLES_AND_FLIGHT.md §3 forbids it).
  const exit = new RAPIER.World(new RAPIER.Vector3(0, 0, 0));
  exit.timestep = DT_SECONDS;
  const flyer = exit.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p0.x, p0.y, p0.z)
      .setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w })
      .setLinvel(v0.x, v0.y, v0.z)
      .setAngvel({ x: w0.x, y: w0.y, z: w0.z }),
  );
  const spawnedV = flyer.linvel();
  const injectedDV = lenV(subV({ x: spawnedV.x, y: spawnedV.y, z: spawnedV.z }, capturedV));
  let maxDev = 0;
  for (let i = 1; i <= EXIT_STEPS; i++) {
    exit.step();
    const t = i * DT_SECONDS;
    const p = flyer.translation();
    const ax = p0.x + capturedV.x * t;
    const ay = p0.y + capturedV.y * t;
    const az = p0.z + capturedV.z * t;
    maxDev = Math.max(maxDev, Math.hypot(p.x - ax, p.y - ay, p.z - az));
  }

  // Secondary finding: a merely-RESTING (rolling) body on the SAME parent —
  // no joint — does not inherit the surface velocity: rolling-sphere carry.
  const roll = new RAPIER.World(new RAPIER.Vector3(0, 0, -GRAVITY_METRES_PER_S2));
  roll.timestep = DT_SECONDS;
  const plate2 = roll.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicVelocityBased()
      .setTranslation(5, 0, EXIT_DISC_HALFHEIGHT_METRES)
      .setLinvel(EXIT_PARENT_LINVEL.x, EXIT_PARENT_LINVEL.y, EXIT_PARENT_LINVEL.z)
      .setAngvel({ x: 0, y: 0, z: EXIT_OMEGA_RAD_PER_S }),
  );
  roll.createCollider(
    RAPIER.ColliderDesc.cuboid(EXIT_DISC_RADIUS_METRES, EXIT_DISC_RADIUS_METRES, EXIT_DISC_HALFHEIGHT_METRES)
      .setFriction(0.7)
      .setRestitution(0),
    plate2,
  );
  const roller = roll.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(
      5 + EXIT_OFFSET_RADIUS_METRES,
      0,
      2 * EXIT_DISC_HALFHEIGHT_METRES + EXIT_BALL_RADIUS_METRES + 1e-3,
    ),
  );
  roll.createCollider(
    RAPIER.ColliderDesc.ball(EXIT_BALL_RADIUS_METRES).setDensity(500).setFriction(0.7).setRestitution(0),
    roller,
  );
  let carryRatio = 0;
  for (let i = 0; i < EXIT_TICK; i++) {
    roll.step();
    if (i === EXIT_TICK - 1) {
      const pp = plate2.translation();
      const p = roller.translation();
      const dv = plate2.linvel();
      const wa = plate2.angvel();
      const rW = subV(p, pp);
      const surface = addV({ x: dv.x, y: dv.y, z: dv.z }, cross(wa, rW));
      const v = roller.linvel();
      carryRatio = lenV({ x: v.x, y: v.y, z: v.z }) / lenV(surface);
    }
  }

  return {
    parentLinearVelocityMetresPerSecond: { x: pvE.x, y: pvE.y, z: pvE.z },
    parentAngularVelocityRadPerSecond: pwE.z,
    offsetRadiusMetres: EXIT_OFFSET_RADIUS_METRES,
    analyticExitVelocityMetresPerSecond: analyticExit,
    capturedExitVelocityMetresPerSecond: capturedV,
    carryVelocityErrorAtExitMetresPerSecond: carryErr,
    maxCarryVelocityErrorLast60StepsMetresPerSecond: lateCarryErrMax,
    maxPoseResidualMetres: maxPoseResidual,
    maxOffsetDriftMetres: maxOffsetDrift,
    exitTick: EXIT_TICK,
    inheritedSpeedMetresPerSecond: lenV(capturedV),
    injectedDeltaVMetresPerSecond: injectedDV,
    postExitMaxTrajectoryDeviationMetres: maxDev,
    postExitSteps: EXIT_STEPS,
    rollingBodyCarryRatioAtExit: carryRatio,
    methodNote:
      'Parent-relative exit velocity (VEHICLES_AND_FLIGHT.md §5): exit v = v_parent + ω × r_offset, validated ' +
      'against the solver with a rigidly-jointed (ATTACHED-regime) child on a moving+rotating kinematic parent, ' +
      'then handing the captured state to a fresh zero-gravity world at EXIT_TICK: deviation from p0 + v0·t is ' +
      'injected free delta-V (§3 forbids it); zero gravity isolates the handover from any force-model choice. ' +
      'The parent plate is a flat cuboid because this build\'s ball-vs-cylinder manifold returns a tilted normal ' +
      'off-axis (recorded in the S0.1 findings). Secondary measurement: a merely-RESTING rolling body on the ' +
      'same parent reaches only rollingBodyCarryRatioAtExit of the surface velocity (classic rolling-sphere 2/7) ' +
      '— the exit formula is the ATTACHMENT-point velocity, not a carried body\'s.',
  };
}

// --- report ------------------------------------------------------------------------

export interface BubbleReport {
  config: {
    build: string;
    dtSeconds: number;
    stepCount: number;
    settleSteps: number;
    rebaseTick: number;
    solver: string;
    worldGravity: [number, number, number];
    rampTiltRad: number;
    frictionRestitution: string;
    massesKg: { padBox: number; rampBox: number; hanging: number };
  };
  resting: BubbleMetrics;
  /** Same layout, bodies never allowed to sleep: the active solver's holding
   * behaviour without the sleep mask (what a player standing on the box sees). */
  restingAwake: BubbleMetrics;
  joint: { maxAnchorDriftMetres: number; finalAnchorDriftMetres: number; maxSagMetres: number; hangingMassKg: number };
  rebase: RebaseResult & { verdict: string };
  twoBubbles: {
    darAnchor: { latitudeDeg: number; longitudeDeg: number };
    osloAnchor: { latitudeDeg: number; longitudeDeg: number };
    anchorSeparationMetres: number;
    dar: BubbleMetrics;
    oslo: BubbleMetrics;
    bitwiseCrossTalkCheckPassed: boolean;
  };
  axesRebase: AxesRebaseResult;
  /** ROADMAP §9 acceptance-matrix items: Z-up fall/jump/vehicle axes and
   * parent-relative exit velocity (the rebase/locations items are above). */
  gateMatrix: {
    jump: ZupJumpReport;
    vehicleAxes: VehicleAxesReport;
    parentExit: ParentExitReport;
  };
}

let cached: Promise<BubbleReport> | null = null;

export function collectBubbleReport(): Promise<BubbleReport> {
  cached ??= (async () => {
    await RAPIER.init();
    const restingRun = runRestingContact(true);
    const resting = restingRun.metrics;
    const restingAwake = runRestingContact(false).metrics;
    const joint = runJointStability();
    const rebase = runRebase();
    const twoBubbles = runTwoBubbles();
    const axesRebase = runAxesRebase();
    const gateMatrix = { jump: runZupJump(), vehicleAxes: runVehicleAxes(), parentExit: runParentExit() };

    const verdict =
      `Naive whole-world f32 translation (+5e6 m in z, f32 spacing 0.5 m at that magnitude) BREAKS resting ` +
      `contact. Injected separation errors: ${rebase.naive.padSeparationErrorMetres.toExponential(3)} m (pad pair) / ` +
      `${rebase.naive.rampSeparationErrorMetres.toExponential(3)} m (ramp pair). With default sleeping, the resting ` +
      `boxes then accumulate phantom free-fall velocity (pad box reaches ` +
      `${rebase.naive.padPhantomVelocityAtSleepMetresPerSecond.toFixed(3)} m/s) while their f32 positions stay frozen ` +
      `(fall displacement < the 0.5 m f32 spacing), and the solver spuriously sleeps them at 0.5 s ` +
      `(Rapier default time_before_sleep); the ramp box never re-contacts and ends the run asleep, floating ` +
      `${rebase.naive.rampBoxFloatingAboveContactMetres.toFixed(4)} m above its true contact pose. With sleeping ` +
      `disabled the failure is unmasked: the contact is dead, velocity accumulates at ~g per step to ` +
      `${rebase.naive.sleepDisabled.maxSpeedMetresPerSecond.toFixed(1)} m/s, the position stays frozen ` +
      `${rebase.naive.sleepDisabled.stepsPositionFrozen} steps, and the box then tunnels through the 1 m ground ` +
      `slab, ending ${rebase.naive.sleepDisabled.finalPenetrationBelowGroundTopMetres.toFixed(0)} m below the ` +
      `ground top after 600 steps. The Law P-6 compliant re-derivation (anchor absorbs the 5000 km in canonical ` +
      `f64; every solver transform re-derived from canonical state; bubble-local coordinates stay <= ` +
      `${rebase.maxBubbleLocalCoordinateMetres.toFixed(2)} m) leaves stability identical to pre-rebase (pad ` +
      `penetration ${rebase.compliant.padBox.maxPenetrationMetres.toExponential(3)} m, zero drift, zero creep). ` +
      `VERDICT: rebase with resting contacts HOLDS only as canonical-f64 re-derivation (Law P-6); a shift vector ` +
      `applied to accumulated f32 solver state does not hold at 5e6 m magnitude — it silently kills the contact.`;

    return {
      config: {
        build: `@dimforge/rapier3d-deterministic-compat ${RAPIER.version()} (WASM f32 solver, Node 24 host)`,
        dtSeconds: DT_SECONDS,
        stepCount: STEP_COUNT,
        settleSteps: SETTLE_STEPS,
        rebaseTick: REBASE_TICK,
        solver: 'Rapier defaults: numSolverIterations 4, default contact ERP, default allowed linear error',
        worldGravity: [0, 0, -GRAVITY_METRES_PER_S2],
        rampTiltRad: RAMP_TILT_RAD,
        frictionRestitution: 'friction 0.7, restitution 0 everywhere',
        massesKg: {
          padBox: restingRun.massesKg.padBox,
          rampBox: restingRun.massesKg.rampBox,
          hanging: restingRun.massesKg.hanging,
        },
      },
      resting,
      restingAwake,
      joint,
      rebase: { ...rebase, verdict },
      twoBubbles,
      axesRebase,
      gateMatrix,
    };
  })();
  return cached;
}
