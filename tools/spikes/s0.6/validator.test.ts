/**
 * S0.6 probe — validator-contract tests (throwaway spike, vitest).
 *
 * Pins the ADR-007 measured bounds: the tuned replay model holds the legal capture at
 * f32-quantization noise, rejects the speed-hack capture by ~6 orders, regenerates the
 * sessions deterministically, and agrees bitwise with the Docker Go validator.
 * Regenerate artifacts: gen-session.mjs -> ts-mirror.mjs -> docker go run -> write-report.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLegal, generateTampered, PARAMS } from './gen-session.mjs';
import { validateSession, CLAMPS, DEFAULT_THRESHOLD, wrapAngle } from './ts-mirror.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Measured 2026-09-06 (report.json). Pinned with headroom so the suite fails on model
// regressions, not on f64 noise: legal bound 4.524e-5 m -> pinned 1e-4; margin 3.74e6 -> pinned 1e3.
const PINNED_LEGAL_MAX_DRIFT_M = 1e-4;
const PINNED_MIN_TAMPER_MARGIN = 1e3;
const PINNED_LEGAL_MAX_HEADING_DRIFT_RAD = 1e-12; // measured exactly 0 (heading re-sync is bitwise)

function readSession(name: string) {
  return JSON.parse(readFileSync(join(here, 'sessions', `${name}.json`), 'utf8'));
}
function readGoResult(name: string) {
  const p = join(here, 'results', `go-${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/\r/g, '')) : null;
}

/** Legality audit of reported (f32-on-the-wire) states against the contract clamps. */
function audit(session: ReturnType<typeof generateLegal>) {
  let maxSpeed = 0;
  let maxAccel = 0;
  let maxYawRate = 0;
  let prevSpeed = session.init.speed;
  let prevYaw = session.init.yaw;
  for (const s of session.states) {
    maxSpeed = Math.max(maxSpeed, s.speed);
    maxAccel = Math.max(maxAccel, Math.abs(s.speed - prevSpeed) / session.dt);
    maxYawRate = Math.max(maxYawRate, Math.abs(wrapAngle(s.yaw - prevYaw)) / session.dt);
    prevSpeed = s.speed;
    prevYaw = s.yaw;
  }
  return { maxSpeed, maxAccel, maxYawRate };
}

describe('S0.6: server-side kinematic validator (Go-contract replay, TS mirror)', () => {
  const legal = readSession('legal');
  const tampered = readSession('tampered');

  it('generates both captures deterministically (committed sessions == regeneration)', () => {
    for (const [regen, onDisk] of [
      [generateLegal(), legal],
      [generateTampered(), tampered],
    ] as const) {
      expect(JSON.stringify(onDisk)).toBe(JSON.stringify(regen));
    }
    expect(legal.states.length).toBeGreaterThanOrEqual(3600);
    expect(legal.dt).toBeCloseTo(1 / 60, 15);
  });

  it('legal capture is inside every contract clamp after f32 wire quantization', () => {
    const a = audit(legal);
    expect(a.maxSpeed).toBeLessThanOrEqual(CLAMPS.maxSpeed);
    expect(a.maxAccel).toBeLessThanOrEqual(CLAMPS.maxAccel);
    expect(a.maxYawRate).toBeLessThanOrEqual(CLAMPS.maxYawRate);
  });

  it('tampered capture is the same loop with exactly one speed-hack signature (ticks 1201-1500)', () => {
    // bitwise-identical legal ticks before the tamper
    for (let i = 0; i < PARAMS.tamper.startTick - 1; i++) {
      expect(tampered.states[i]).toEqual(legal.states[i]);
    }
    const a = audit(tampered);
    expect(a.maxSpeed).toBeGreaterThan(CLAMPS.maxSpeed); // 80 vs 55 clamp
    expect(a.maxAccel).toBeGreaterThan(CLAMPS.maxAccel); // 72 vs 6 clamp
    expect(a.maxYawRate).toBeLessThanOrEqual(CLAMPS.maxYawRate); // tamper stays on-circle
    // after the hack window the reported speeds are legal again — only the position claim diverges
    const tail = tampered.states.slice(PARAMS.tamper.endTick);
    expect(Math.max(...tail.map((s: { speed: number }) => s.speed))).toBeLessThanOrEqual(CLAMPS.maxSpeed);
  });

  it('legal replay drift stays at quantization noise (pass, pinned 1e-4 m; measured 4.524e-5)', () => {
    const r = validateSession(legal);
    expect(r.verdict).toBe('pass');
    expect(r.maxDrift).toBeLessThan(PINNED_LEGAL_MAX_DRIFT_M);
    expect(r.maxDrift).toBeLessThan(DEFAULT_THRESHOLD);
    expect(r.maxHeadingDrift).toBeLessThanOrEqual(PINNED_LEGAL_MAX_HEADING_DRIFT_RAD);
  });

  it('replay v1 regression guard: end-of-tick-speed stepping is NOT what ships (trapezoidal fix)', () => {
    // The tuned model must not re-acquire the a*dt^2/2 per-tick accel bias (v1 measured 0.1665 m).
    // Guard: drift after the accel phase (tick 240) must stay far below the v1 plateau.
    const d = validateSession(legal).perTickDrift;
    expect(d[239]).toBeLessThan(PINNED_LEGAL_MAX_DRIFT_M); // v1 was already 1.66e-1 here
  });

  it('speed-hack capture is rejected with a margin over 1e3x the legal bound (measured 3.74e6)', () => {
    const legalR = validateSession(legal);
    const tamperedR = validateSession(tampered);
    expect(tamperedR.verdict).toBe('reject');
    expect(tamperedR.maxDrift).toBeGreaterThan(DEFAULT_THRESHOLD);
    expect(tamperedR.maxDrift / legalR.maxDrift).toBeGreaterThan(PINNED_MIN_TAMPER_MARGIN);
    // drift peaks inside/just after the hack window, then plateaus (constant angular gap)
    expect(tamperedR.tickOfMax).toBeGreaterThanOrEqual(PARAMS.tamper.startTick);
    expect(tamperedR.tickOfMax).toBeLessThanOrEqual(PARAMS.tamper.endTick + 600);
  });

  it('threshold contract: exit semantics follow maxDrift vs threshold, overridable', () => {
    expect(validateSession(legal, { threshold: DEFAULT_THRESHOLD }).verdict).toBe('pass');
    expect(validateSession(legal, { threshold: 1e-6 }).verdict).toBe('reject'); // below legal noise
    expect(validateSession(tampered, { threshold: 100 }).verdict).toBe('reject');
  });

  it('cross-language: Docker Go validator result lines are bitwise-identical to the TS mirror', () => {
    for (const name of ['legal', 'tampered'] as const) {
      const go = readGoResult(name);
      if (!go) throw new Error(`results/go-${name}.json missing — run the docker command in write-report.mjs`);
      const ts = validateSession(name === 'legal' ? legal : tampered);
      expect(go.maxDrift).toBe(ts.maxDrift); // exact f64 equality, not closeTo
      expect(go.maxHeadingDrift).toBe(ts.maxHeadingDrift);
      expect(go.tickOfMax).toBe(ts.tickOfMax);
      expect(go.verdict).toBe(ts.verdict);
    }
  });

  it('drift distribution is recorded (exit criterion: drift distribution measured and recorded)', () => {
    const report = JSON.parse(readFileSync(join(here, 'report.json'), 'utf8'));
    for (const name of ['legalRun', 'tamperedRun'] as const) {
      const dist = report.probes[name].ts.distribution;
      for (const key of ['p50', 'p95', 'p99', 'max', 'mean'] as const) {
        expect(typeof dist[key]).toBe('number');
        expect(dist[key]).toBeGreaterThanOrEqual(0);
      }
      expect(dist.p50).toBeLessThanOrEqual(dist.p95);
      expect(dist.p95).toBeLessThanOrEqual(dist.p99);
      expect(dist.p99).toBeLessThanOrEqual(dist.max);
    }
    expect(report.budgetInputs['B-VAL-01'].value).toBeCloseTo(validateSession(legal).maxDrift, 18);
    expect(report.budgetInputs['B-VAL-02'].value).toBeGreaterThan(PINNED_MIN_TAMPER_MARGIN);
  });
});
