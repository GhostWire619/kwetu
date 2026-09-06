/**
 * S0.11 — bitwise determinism regression (vitest, node environment).
 *
 * ROADMAP S0.11 / B-EPH-02: "same inputs -> identical state hashes". Runs the
 * same seeded 600-step Rapier contact-bubble simulation twice in-process and
 * requires the serialized body-state stream to be BITWISE identical.
 *
 * Sim layout mirrors the S0.1 probe family (tools/spikes/s0.1/bubble/):
 * Z-up world, world gravity (0,0,-9.80665), dt = 1/60, 600 fixed steps,
 * Rapier defaults (numSolverIterations 4, default ERP/allowed linear error),
 * friction 0.7 / restitution 0 — flat pad + resting box, 15-degree ramp +
 * resting box, static post + hanging body on a fixed joint.
 *
 * Seeding: Rapier has no RNG, so the run is seeded by deriving a fixed
 * impulse schedule from an LCG with a pinned seed. Both runs build a FRESH
 * world from the same seed and replay the same schedule.
 *
 * Hashing: tracked scalars are the solver's f32 values promoted to f64
 * (Rapier JS returns f32-quantized numbers exactly representable in f64).
 * The canonical hash is sha256 over the raw IEEE-754 bit patterns
 * (big-endian) of those promoted values — no float FORMATTING is involved,
 * so the hash cannot drift with serialization changes. A secondary
 * JSON.stringify hash (shortest-round-trip f64 text) is recorded for
 * readability. Run equality is asserted bitwise on the canonical hash.
 *
 * SCOPE (ADR-011): this proves same-host, same-engine bitwise stability.
 * Cross-platform (Windows/Linux CI matrix) bitwise agreement is a
 * [PLACEHOLDER — gate: CI matrix, out of scope tonight] — the WASM f32
 * solver is expected to hold bitwise across x86-64/ARM64 platforms because
 * the same wasm module ships everywhere, but that is CI's job to prove,
 * not this host test's.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';

const DT_SECONDS = 1 / 60;
const STEP_COUNT = 600;
const SAMPLE_EVERY = 30;
const GRAVITY = 9.80665;
const SEED = 0x4b574554; // "KWET"
const TAN_RAMP = (15 * Math.PI) / 180;

/** Tiny deterministic LCG (same 32-bit recurrence in every JS engine). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Scripted deterministic input schedule derived from the seed. */
interface ImpulseSchedule {
  tick: number;
  bodyIndex: number; // 0 = padBox, 1 = rampBox
  dx: number;
  dy: number;
  dz: number;
}

function buildSchedule(seed: number): ImpulseSchedule[] {
  const rand = lcg(seed);
  const out: ImpulseSchedule[] = [];
  for (let tick = 60; tick < STEP_COUNT; tick += 97) {
    out.push({
      tick,
      bodyIndex: Math.floor(rand() * 2),
      // ~1000 kg boxes: impulses scaled to give 0.05-0.7 m/s velocity kicks,
      // enough to slide boxes and re-form contacts across the 600 steps.
      dx: (rand() - 0.5) * 200,
      dy: (rand() - 0.5) * 200,
      dz: rand() * 500 + 200, // always an upward knock so contacts re-form
    });
  }
  return out;
}

function quatY(a: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
}

interface RunResult {
  config: Record<string, unknown>;
  finalStates: Record<string, unknown>;
  canonicalSha256: string;
  jsonSha256: string;
  sampledSteps: number;
}

/** One full deterministic run: fresh world, fixed steps, scripted impulses. */
async function runSeededSim(seed: number): Promise<RunResult> {
  await RAPIER.init();
  const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -GRAVITY));
  world.timestep = DT_SECONDS;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.5));
  world.createCollider(RAPIER.ColliderDesc.cuboid(100, 100, 0.5).setFriction(0.7).setRestitution(0), ground);

  const padBox = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0.5 + 1e-3).setCanSleep(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(1000).setFriction(0.7).setRestitution(0),
    padBox,
  );

  const ramp = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(3, 0, 0.2).setRotation(quatY(TAN_RAMP)),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(2, 1, 0.25).setFriction(0.7).setRestitution(0), ramp);
  // Ramp box rests face-to-face on the tilted slab, matching the ramp tilt.
  // Rotating +z about +y by 15 deg tips the normal into the XZ plane:
  // n = (sin 15deg, 0, cos 15deg) — same construction as the S0.1 probe.
  const nx = Math.sin(TAN_RAMP);
  const nz = Math.cos(TAN_RAMP);
  const drop = 0.25 + 0.5 + 1e-3; // half slab + half box + 1 mm drop-in
  const restX = 3 + drop * nx;
  const restY = 0;
  const restZ = 0.2 + drop * nz;
  const rampBox = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(restX, restY, restZ)
      .setRotation(quatY(TAN_RAMP))
      .setCanSleep(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(1000).setFriction(0.7).setRestitution(0),
    rampBox,
  );

  const post = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  const hanging = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 1.5).setCanSleep(true),
  );
  world.createCollider(
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

  const schedule = buildSchedule(seed);
  const bodies = [padBox, rampBox];

  // --- bit-exact state capture -------------------------------------------------
  // Hash input: for every SAMPLE_EVERY-th step, for each tracked body, the
  // f64 bit patterns of [tx,ty,tz, vx,vy,vz, qx,qy,qz,qw] plus the step index.
  const hasher = createHash('sha256');
  const scratch = new ArrayBuffer(8);
  const view = new DataView(scratch);
  const textChunks: string[] = [];
  let sampledSteps = 0;

  const putF64 = (v: number): void => {
    view.setFloat64(0, v, false); // big-endian, exact f64 bit pattern
    hasher.update(new Uint8Array(scratch));
  };

  const capture = (step: number): void => {
    putF64(step);
    const tracked: Array<{ name: string; body: RAPIER.RigidBody }> = [
      { name: 'padBox', body: padBox },
      { name: 'rampBox', body: rampBox },
      { name: 'hanging', body: hanging },
    ];
    for (const { name, body: b } of tracked) {
      const p = b.translation();
      const v = b.linvel();
      const q = b.rotation();
      const tuple = [p.x, p.y, p.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w];
      for (const value of tuple) {
        putF64(value);
      }
      textChunks.push(`${name}:${tuple.join(',')}`);
    }
    sampledSteps++;
  };

  let nextImpulse = 0;
  for (let step = 0; step < STEP_COUNT; step++) {
    for (;;) {
      const imp = schedule[nextImpulse];
      if (!imp || imp.tick !== step) break;
      bodies[imp.bodyIndex]?.applyImpulse({ x: imp.dx, y: imp.dy, z: imp.dz }, true);
      nextImpulse++;
    }
    world.step();
    if (step % SAMPLE_EVERY === 0 || step === STEP_COUNT - 1) capture(step);
  }

  const state = (b: RAPIER.RigidBody): Record<string, number | number[]> => {
    const p = b.translation();
    const v = b.linvel();
    const q = b.rotation();
    return {
      translation: [p.x, p.y, p.z],
      linvel: [v.x, v.y, v.z],
      rotation: [q.x, q.y, q.z, q.w],
    };
  };

  return {
    config: {
      seed,
      stepCount: STEP_COUNT,
      dtSeconds: DT_SECONDS,
      gravity: [0, 0, -GRAVITY],
      solver: 'Rapier defaults (numSolverIterations 4, default ERP/allowed linear error)',
      friction: 0.7,
      restitution: 0,
      impulses: schedule,
      rapierBuild: 'deterministic-compat (WASM f32 solver)',
    },
    finalStates: {
      padBox: state(padBox),
      rampBox: state(rampBox),
      hanging: state(hanging),
    },
    canonicalSha256: hasher.digest('hex'),
    jsonSha256: createHash('sha256').update(textChunks.join('|')).digest('hex'),
    sampledSteps,
  };
}

describe('S0.11 B-EPH-02: bitwise determinism regression (same seed -> identical state hash)', () => {
  it('two in-process runs of the same seeded 600-step sim produce bitwise-identical state hashes', async () => {
    const runA = await runSeededSim(SEED);
    const runB = await runSeededSim(SEED);

    expect(runA.sampledSteps).toBe(21); // steps 0,30,...,570 plus 599
    expect(runA.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);

    // The claim under test: bitwise equality of the full state stream.
    expect(runB.canonicalSha256).toBe(runA.canonicalSha256);
    expect(runB.jsonSha256).toBe(runA.jsonSha256);
    expect(JSON.stringify(runB.finalStates)).toBe(JSON.stringify(runA.finalStates));

    // And the sim was not trivially static: the scripted knocks moved bodies
    // (measured pad-box displacement 2.5e-3 m under friction from rest).
    const pad = runA.finalStates.padBox as { translation: number[] };
    expect(Math.abs(pad.translation[0] as number)).toBeGreaterThan(1e-3);

    console.log(
      '[B-EPH-02 measured]',
      JSON.stringify(
        {
          canonicalSha256: runA.canonicalSha256,
          jsonSha256: runA.jsonSha256,
          finalStates: runA.finalStates,
          config: runA.config,
          scope: 'same host, same engine; cross-platform CI matrix out of scope tonight',
        },
        null,
        2,
      ),
    );
  });

  it('a different seed produces a different hash (the hash is sensitive to inputs)', async () => {
    const runA = await runSeededSim(SEED);
    const runOther = await runSeededSim(SEED ^ 0x1);
    expect(runOther.canonicalSha256).not.toBe(runA.canonicalSha256);
  });
});
