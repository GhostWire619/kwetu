/**
 * S0.6 spike — TypeScript mirror of the Go kinematic validator (throwaway probe).
 *
 * Implements the IDENTICAL replay model as go-validator/main.go, in the identical
 * f64 operation order, so that running both over the same session JSON measures
 * cross-language (Go vs V8) agreement — itself a recorded result of this spike
 * (ADR-001 Decision 5 explicitly declines to promise bitwise cross-language equality;
 * this spike quantifies the actual gap for the kinematic replay).
 *
 * REPLAY MODEL (the proposed validator contract, ADR-007):
 *   The server never re-simulates inputs. From the trusted init state it replays
 *   tick-by-tick, following the client-reported heading and speed CLAMPED to legal
 *   limits, and integrates bicycle-ish kinematics:
 *     wReq   = wrapAngle(reportedYaw - replayYaw) / dt          // heading rate the client claims
 *     w      = clamp(wReq, -2.5, +2.5)                          // rad/s
 *     v      = clamp(reportedSpeed, vPrev -+ 6*dt) then [0, 55] // m/s (accel + absolute clamps)
 *     vStep  = (vPrev + v) / 2                                  // trapezoidal step speed
 *     yawMid = replayYaw + w*dt/2
 *     pos   += vStep*dt*[cos(yawMid), sin(yawMid)]              // midpoint-heading Euler
 *     yaw   += w*dt
 *   The trapezoidal step speed is REQUIRED, not cosmetic: stepping with the reported
 *   end-of-tick speed alone biases every accelerating tick by a*dt^2/2 (measured
 *   0.1665 m over one 240-tick 5 m/s^2 ramp — see ADR-007 Evidence, replay v1).
 *   Drift per tick = |posReplay - posReported| (3D, m); heading drift = |wrapAngle(yawReplay - yawReported)|.
 *   Legal play keeps drift at integration-scheme + f32-wire-quantization noise; an illegal
 *   claim (speed hack, teleport, spin) diverges because the clamps refuse to follow it.
 *
 * Only stdlib is used. Numbers the clamps/threshold come from are tagged in ADR-007.
 *
 * CLI:  node ts-mirror.mjs <session.json> [--threshold M]     -> compact result JSON on stdout
 *       node ts-mirror.mjs <session.json> --bench <repeats>   -> ns/tick line on stderr
 */
import { readFileSync } from 'node:fs';

/** Server-side legal limits (the contract's clamps; rationale in ADR-007). */
export const CLAMPS = {
  maxAccel: 6.0, // m/s^2, symmetric accel/decel
  maxYawRate: 2.5, // rad/s
  maxSpeed: 55.0, // m/s (~198 km/h)
  minSpeed: 0.0, // m/s, no reverse in this model revision
};

/** Spike pass threshold placeholder — the ADR proposes the production value. */
export const DEFAULT_THRESHOLD = 5.0; // m, max cumulative position drift

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Wrap to (-pi, pi]. Same formula as Go's wrapAngle (math.Mod and JS % are both
 * IEEE fmod — sign of the dividend — so the two languages agree bitwise here).
 */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/**
 * Replay one session. Returns the compact contract result plus the per-tick drift
 * series (the drift distribution is an S0.6 exit-criterion deliverable).
 *
 * @param {{dt:number, ticks:number, init:{pos:number[],yaw:number,speed:number}, states:{t:number,pos:number[],yaw:number,speed:number}[]}} session
 * @param {{threshold?:number}} [opts]
 */
export function validateSession(session, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const dt = session.dt;
  if (!(dt > 0)) throw new Error('session.dt must be > 0');
  const states = session.states;
  if (!Array.isArray(states) || states.length === 0) throw new Error('session.states must be non-empty');
  if (states.length !== session.ticks) throw new Error(`states length ${states.length} != ticks ${session.ticks}`);

  let px = session.init.pos[0];
  let py = session.init.pos[1];
  let pz = session.init.pos[2];
  let yaw = session.init.yaw;
  let v = session.init.speed;

  let maxDrift = 0;
  let maxHeadingDrift = 0;
  let tickOfMax = 0;
  const perTickDrift = new Float64Array(states.length);
  const perTickHeading = new Float64Array(states.length);

  const aMaxDt = CLAMPS.maxAccel * dt;
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const vPrev = v;
    const wReq = wrapAngle(s.yaw - yaw) / dt;
    const w = clamp(wReq, -CLAMPS.maxYawRate, CLAMPS.maxYawRate);
    const vReq = clamp(s.speed, vPrev - aMaxDt, vPrev + aMaxDt);
    v = clamp(vReq, CLAMPS.minSpeed, CLAMPS.maxSpeed);
    const vStep = (vPrev + v) * 0.5; // trapezoidal — see replay-model note above
    const yawMid = yaw + w * dt * 0.5;
    const step = vStep * dt;
    px += step * Math.cos(yawMid);
    py += step * Math.sin(yawMid);
    yaw += w * dt;
    const dx = px - s.pos[0];
    const dy = py - s.pos[1];
    const dz = pz - s.pos[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz); // plain sqrt: correctly rounded in JS and Go
    const h = Math.abs(wrapAngle(yaw - s.yaw));
    perTickDrift[i] = d;
    perTickHeading[i] = h;
    if (d > maxDrift) {
      maxDrift = d;
      tickOfMax = i + 1; // 1-based tick index
    }
    if (h > maxHeadingDrift) maxHeadingDrift = h;
  }

  return {
    maxDrift,
    maxHeadingDrift,
    tickOfMax,
    verdict: maxDrift < threshold ? 'pass' : 'reject',
    perTickDrift,
    perTickHeading,
  };
}

/** Compact result shape printed by BOTH implementations (the contract's stdout). */
export function compactResult(r) {
  return { maxDrift: r.maxDrift, maxHeadingDrift: r.maxHeadingDrift, tickOfMax: r.tickOfMax, verdict: r.verdict };
}

/** Mean wall-clock cost of one full-session replay, ns per tick. */
export function benchValidate(session, repeats) {
  // warmup
  validateSession(session);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < repeats; i++) validateSession(session);
  const t1 = process.hrtime.bigint();
  const nsPerSession = Number(t1 - t0) / repeats;
  return { repeats, nsPerSession, nsPerTick: nsPerSession / session.ticks };
}

/** CLI. */
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node ts-mirror.mjs <session.json> [--threshold M] [--bench N]');
    process.exit(2);
  }
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : DEFAULT_THRESHOLD;
  const session = JSON.parse(readFileSync(file, 'utf8'));
  const benchIdx = args.indexOf('--bench');
  if (benchIdx >= 0) {
    const b = benchValidate(session, Number(args[benchIdx + 1]));
    console.error(JSON.stringify({ benchRepeats: b.repeats, nsPerSession: b.nsPerSession, nsPerTick: b.nsPerTick }));
  }
  process.stdout.write(JSON.stringify(compactResult(validateSession(session, { threshold }))) + '\n');
}
