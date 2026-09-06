/**
 * S0.6 spike — session generator (throwaway probe, no deps; CLAUDE.md spike carve-out).
 *
 * Emits two recorded car-path session captures under sessions/:
 *
 *   legal.json    — a physically-legal 60 s loop: 250 m-radius circle, accel-limited ramp
 *                   0 -> 20 m/s at 5 m/s^2 (1 m/s^2 inside the server's 6 m/s^2 clamp,
 *                   240 ticks), then constant speed. Integrated client-side exactly at
 *                   dt = 1/60: midpoint scheme while accelerating, exact circular chord
 *                   (ds = 2R sin(w dt/2)) while at constant speed.
 *   tampered.json — the SAME loop with ONE documented tamper: a mid-session SPEED HACK.
 *                   Ticks 1201-1500 (5 s): reported speed ramps 20 -> 80 m/s (4x cruise,
 *                   72 m/s^2 = 12x the accel clamp), holds 80 m/s for 200 ticks, ramps
 *                   back down. The tamper stays on the same circle (yaw rate 0.32 rad/s,
 *                   inside the 2.5 rad/s clamp), so it exercises exactly the speed/accel
 *                   clamps and nothing else. Ticks 1-1200 are bitwise identical to legal.
 *
 * Wire realism: every reported number (init and per-tick pos/yaw/speed) is quantized to
 * float32 (Math.fround) — the Phase-5 snapshot encoding per the f32-at-upload rule
 * (CLAUDE.md / MASTER_PROMPT §13) — so the validator consumes exactly what a real client
 * would put on the wire. The validator's drift therefore includes f32 input quantization.
 *
 * Session format (owned by this spike, proposed to NETWORKING.md §6):
 *   { dt: 1/60, ticks: 3600,
 *     init:   { pos: [x,y,z], yaw, speed },          // tick 0, f32 on the wire
 *     states: [ { t, pos: [x,y,z], yaw, speed } ] }  // t = tick index 1..ticks
 *                                                    // (seconds = t * dt)
 *
 * All model constants are SPIKE PARAMETERS chosen for this probe, not project budgets —
 * the server-side clamps they must respect (6 m/s^2, 2.5 rad/s, 55 m/s) live in
 * ts-mirror.mjs / go-validator/main.go and ADR-007.
 *
 * Usage: node gen-session.mjs [outDir]   (default: ./sessions next to this file)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Spike parameters — one place, exported for the tests and the report. */
export const PARAMS = {
  dt: 1 / 60,
  ticks: 3600, // 60 s at 60 Hz
  radius: 250, // m, circle radius
  vCruise: 20, // m/s (~72 km/h)
  aAccel: 5, // m/s^2 legal ramp (server clamp is 6)
  accelTicks: 240, // 5 m/s^2 * 4 s = 20 m/s
  start: { pos: [250, 0, 0], yaw: Math.PI / 2, speed: 0 }, // on-circle, tangent CCW
  tamper: {
    kind: 'speed-hack',
    startTick: 1201, // first hacked tick
    endTick: 1500, // last hacked tick (300 ticks = 5 s)
    rampTicks: 50, // 20 -> 80 at +72 m/s^2
    holdTicks: 200, // hold 80 m/s (4x cruise)
    hackAccel: 72, // m/s^2 — 12x the server clamp; the client is cheating
    hackFactor: 4, // 80 / 20
  },
};

const f32 = Math.fround;

/**
 * One client-side integration step. `a` is the longitudinal accel for this tick.
 * Accelerating: midpoint scheme (speed and heading at mid-step).
 * Constant speed: exact circular chord — the closed-form step a client can take when
 * it knows it is on a fixed-radius arc. Both are O(dt^3)-exact at dt = 1/60.
 */
function stepClient(st, a) {
  const { dt, radius } = PARAMS;
  if (a !== 0) {
    const vMid = st.v + a * dt * 0.5;
    const w = vMid / radius;
    const yawMid = st.yaw + w * dt * 0.5;
    return {
      x: st.x + vMid * dt * Math.cos(yawMid),
      y: st.y + vMid * dt * Math.sin(yawMid),
      yaw: st.yaw + w * dt,
      v: st.v + a * dt,
    };
  }
  const w = st.v / radius;
  const ds = 2 * radius * Math.sin(w * dt * 0.5); // exact chord for a constant-speed arc
  const yawMid = st.yaw + w * dt * 0.5;
  return {
    x: st.x + ds * Math.cos(yawMid),
    y: st.y + ds * Math.sin(yawMid),
    yaw: st.yaw + w * dt,
    v: st.v,
  };
}

/** Longitudinal accel schedule for the tampered capture (cruise elsewhere). */
function tamperAccel(tick) {
  const T = PARAMS.tamper;
  if (tick < T.startTick) return 0; // cruise — identical code path to the legal capture
  if (tick < T.startTick + T.rampTicks) return T.hackAccel; // 1201..1250 ramp up
  if (tick < T.startTick + T.rampTicks + T.holdTicks) return 0; // 1251..1450 hold 80
  if (tick <= T.endTick) return -T.hackAccel; // 1451..1500 ramp down
  return 0; // back to (hacked-position) cruise
}

/**
 * Build one session. `tampered=false` -> the pure legal loop.
 * Ticks 1..1200 of both captures are bitwise identical by construction.
 */
export function buildSession(tampered) {
  const P = PARAMS;
  let st = { x: P.start.pos[0], y: P.start.pos[1], yaw: P.start.yaw, v: P.start.speed };
  const init = { pos: [f32(st.x), f32(st.y), 0], yaw: f32(st.yaw), speed: f32(st.v) };
  const states = new Array(P.ticks);
  for (let tick = 1; tick <= P.ticks; tick++) {
    let a;
    if (tick <= P.accelTicks) {
      a = P.aAccel; // shared legal ramp, both captures
    } else if (tampered) {
      a = tamperAccel(tick);
    } else {
      a = 0;
    }
    st = stepClient(st, a);
    states[tick - 1] = {
      t: tick,
      pos: [f32(st.x), f32(st.y), 0],
      yaw: f32(st.yaw),
      speed: f32(st.v),
    };
  }
  return { dt: P.dt, ticks: P.ticks, init, states };
}

export function generateLegal() {
  return buildSession(false);
}
export function generateTampered() {
  return buildSession(true);
}

/** CLI: write both captures. */
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const outDir = process.argv[2] ? join(process.argv[2]) : join(here, 'sessions');
  mkdirSync(outDir, { recursive: true });
  for (const [name, session] of [
    ['legal.json', generateLegal()],
    ['tampered.json', generateTampered()],
  ]) {
    const p = join(outDir, name);
    writeFileSync(p, JSON.stringify(session));
    console.log(`${p}  ${Buffer.byteLength(JSON.stringify(session))} B  states=${session.states.length}`);
  }
}
