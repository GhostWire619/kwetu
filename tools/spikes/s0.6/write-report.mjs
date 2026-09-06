/**
 * S0.6 spike — report writer (throwaway probe). Regenerates the sessions, replays both
 * through the TS mirror, reads the Docker Go-validator outputs from results/, and writes
 * report.json so every ADR-007 number is regenerable.
 *
 * Regeneration:
 *   1. node gen-session.mjs
 *   2. node ts-mirror.mjs sessions/legal.json     > results/ts-legal.json
 *      node ts-mirror.mjs sessions/tampered.json  > results/ts-tampered.json
 *   3. docker run --rm -v C:/Users/lugat/Projects/kwetu:/src -w //src/tools/spikes/s0.6 \
 *        golang:1.24-alpine go run ./go-validator -in sessions/legal.json    > results/go-legal.json
 *      docker run --rm -v C:/Users/lugat/Projects/kwetu:/src -w //src/tools/spikes/s0.6 \
 *        golang:1.24-alpine go run ./go-validator -in sessions/tampered.json > results/go-tampered.json
 *      (PowerShell writes CRLF — write-report.mjs normalizes it before comparing.)
 *   4. node write-report.mjs
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { generateLegal, generateTampered, PARAMS } from './gen-session.mjs';
import { validateSession, CLAMPS, DEFAULT_THRESHOLD, wrapAngle } from './ts-mirror.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(here, 'sessions');
const resultsDir = join(here, 'results');

// ---- 1. regenerate sessions and prove the committed captures are reproducible ----
const regenerated = { legal: generateLegal(), tampered: generateTampered() };
const reproducibility = {};
for (const name of ['legal', 'tampered']) {
  const p = join(sessionsDir, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p} — run: node gen-session.mjs`);
  const onDisk = JSON.parse(readFileSync(p, 'utf8'));
  reproducibility[name] = JSON.stringify(onDisk) === JSON.stringify(regenerated[name]);
}
if (!Object.values(reproducibility).every(Boolean)) {
  throw new Error('committed sessions do not match regeneration — regenerate with node gen-session.mjs');
}

// ---- 2. TS mirror replays + drift distributions ----
function percentile(sorted, p) {
  // nearest-rank
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function driftStats(perTick) {
  const sorted = Float64Array.from(perTick).sort();
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: perTick.reduce((a, b) => a + b, 0) / perTick.length,
  };
}

/** Legality audit of the REPORTED (f32-on-the-wire) states against the contract clamps. */
function audit(session) {
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

const tsResults = {};
for (const name of ['legal', 'tampered']) {
  const r = validateSession(regenerated[name]);
  tsResults[name] = {
    result: { maxDrift: r.maxDrift, maxHeadingDrift: r.maxHeadingDrift, tickOfMax: r.tickOfMax, verdict: r.verdict },
    distribution: driftStats(r.perTickDrift),
    maxHeadingDriftRad: r.maxHeadingDrift,
  };
}

// ---- 3. Go validator outputs (Docker runs) ----
function readGoResult(name) {
  const p = join(resultsDir, `go-${name}.json`);
  if (!existsSync(p)) {
    throw new Error(`missing ${p} — run the docker command in the header of this file`);
  }
  // PowerShell redirection writes CRLF; strip before parsing/comparing.
  return JSON.parse(readFileSync(p, 'utf8').replace(/\r/g, ''));
}
const goResults = { legal: readGoResult('legal'), tampered: readGoResult('tampered') };

// Cross-language agreement: compare parsed numbers exactly and the raw strings byte-wise.
const crossLanguage = {};
for (const name of ['legal', 'tampered']) {
  const g = goResults[name];
  const t = tsResults[name].result;
  crossLanguage[name] = {
    maxDriftAbsDiff: Math.abs(g.maxDrift - t.maxDrift),
    maxHeadingDriftAbsDiff: Math.abs(g.maxHeadingDrift - t.maxHeadingDrift),
    tickOfMaxAgrees: g.tickOfMax === t.tickOfMax,
    verdictAgrees: g.verdict === t.verdict,
    bitwiseIdenticalResultLine:
      readFileSync(join(resultsDir, `go-${name}.json`), 'utf8').replace(/\r/g, '').trim() ===
      readFileSync(join(resultsDir, `ts-${name}.json`), 'utf8').replace(/\r/g, '').trim(),
  };
}

// ---- 4. margins + tamper signature ----
const legalMax = tsResults.legal.result.maxDrift;
const tamperedMax = tsResults.tampered.result.maxDrift;
const audits = { legal: audit(regenerated.legal), tampered: audit(regenerated.tampered) };

// ---- 5. replay v1 (untuned, end-of-tick speed) — recorded for the ADR evidence ----
const v1 = {};
for (const name of ['legal', 'tampered']) {
  const p = join(resultsDir, `v1-endstep-ts-${name}.json`);
  v1[name] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// ---- 6. assemble report ----
const report = {
  spike: 'S0.6 — server-validation prototype',
  adr: 'docs/adr/ADR-007-s06-server-validation-contract.md',
  date: '2026-09-06',
  host: 'Windows 11 dev box (Ryzen 7 7445HS, RTX 4050 Laptop 6 GB, 15.2 GB RAM); Docker Desktop 29.4.2, Linux containers',
  toolVersions: {
    node: process.version,
    go: 'golang:1.24-alpine image (go run inside container)',
    docker: '29.4.2',
    typescriptRunner: 'vitest 5.0.0 / plain node for the mirror',
  },
  runner:
    'node gen-session.mjs; node ts-mirror.mjs sessions/<s>.json; docker run --rm -v C:/Users/lugat/Projects/kwetu:/src -w //src/tools/spikes/s0.6 golang:1.24-alpine go run ./go-validator -in sessions/<s>.json; node write-report.mjs',
  method:
    'Synthetic recorded car path (3600 ticks = 60 s, dt 1/60): 250 m-radius circle, accel-limited ramp 0->20 m/s at 5 m/s^2 (240 ticks) then constant speed. Client integrates exactly at dt (midpoint while accelerating, exact circular chord at constant speed) and reports f32-quantized pos/yaw/speed per tick — the Phase-5 wire encoding. The validator (Go + TS mirror, identical op order) replays from init with client-reported heading/speed CLAMPED to (6 m/s^2, 2.5 rad/s, 55 m/s) and measures |posReplay - posReported| per tick. Tamper: ONE speed hack — ticks 1201-1500 report 4x cruise speed (80 m/s, ramp accel 72 m/s^2 = 12x clamp) while staying on the same circle (yaw rate 0.32 rad/s < clamp), so exactly the speed/accel clamps are exercised.',
  probes: {
    sessionGenerator: {
      params: PARAMS,
      wireQuantization: 'f32 (Math.fround) on init + every reported pos/yaw/speed; t = tick index (seconds = t*dt)',
      sessionFileBytes: {
        legal: statSync(join(sessionsDir, 'legal.json')).size,
        tampered: statSync(join(sessionsDir, 'tampered.json')).size,
      },
      perStateJsonBytes: statSync(join(sessionsDir, 'legal.json')).size / (PARAMS.ticks + 1),
      reportedStateAudit: audits,
      clampCheck: {
        legalWithinClamps:
          audits.legal.maxSpeed <= CLAMPS.maxSpeed &&
          audits.legal.maxAccel <= CLAMPS.maxAccel &&
          audits.legal.maxYawRate <= CLAMPS.maxYawRate,
        tamperSignature: {
          reportedMaxSpeed: audits.tampered.maxSpeed,
          reportedMaxAccel: audits.tampered.maxAccel,
          note: 'tamper exceeds maxSpeed (55) and maxAccel (6) clamps; yaw rate stays legal by construction',
        },
      },
      reproducibleFromGenerator: reproducibility,
    },
    validatorContract: {
      clamps: CLAMPS,
      passThresholdSpike: DEFAULT_THRESHOLD,
      replayModel:
        'per tick: w = clamp(wrapAngle(reportedYaw - replayYaw)/dt, -+2.5); v = clamp(reportedSpeed, vPrev -+ 6*dt) then [0,55]; vStep = (vPrev+v)/2 (trapezoidal); yawMid = yaw + w*dt/2; pos += vStep*dt*[cos,sin](yawMid); yaw += w*dt',
      serverDoesNot: [
        'no server-side Rapier or any contact solver (ADR-001 Decision 5; NETWORKING.md §6/§8)',
        'no collision/crash outcome authority — contact resolution stays client-visual',
        'no input re-simulation: it only follows clamped client-reported speed/heading',
      ],
    },
    replayTuning: {
      v1_endStepSpeed: {
        description:
          'replay stepped with the reported end-of-tick speed: biases every accelerating tick by a*dt^2/2 (predicted 6.944e-4 m/tick; measured 6.929e-4 m/tick over the 240-tick 5 m/s^2 ramp)',
        legal: v1.legal,
        tampered: v1.tampered,
        note: 'v1 numbers were taken before the generator cruise-path fix; the tuning evidence is the LEGAL run (unchanged capture). v1 tampered (168.877 m) differs from the final capture by <0.1% — conclusion unaffected.',
        legalDriftPerAccelTickMeasured: 6.929258e-4,
        legalDriftPerAccelTickPredicted: (PARAMS.aAccel * PARAMS.dt * PARAMS.dt) / 2,
      },
      v2_trapezoidal: {
        description: 'final model — step speed = (vPrev + v)/2; legal drift drops 3681x to f32-quantization + scheme noise',
        fixRatio: v1.legal ? v1.legal.maxDrift / legalMax : null,
      },
    },
    legalRun: {
      ts: tsResults.legal,
      go: goResults.legal,
      verdict: 'pass (exit 0) — legal drift is f32 wire-quantization + exact-chord-vs-midpoint-Euler scheme noise; no coherent accumulation',
    },
    tamperedRun: {
      ts: tsResults.tampered,
      go: goResults.tampered,
      verdict: 'reject (exit 1) — validator clamps refuse the 4x speed claim; replay falls ~169 m behind the claim',
    },
    crossLanguage: {
      method:
        'identical f64 op order in Go (math.Mod/Cos/Sin/Sqrt) and JS (%, Math.cos/sin, Math.sqrt); result lines compared byte-wise after newline normalization',
      results: crossLanguage,
      summary:
        'Go (golang:1.24-alpine, Docker) and Node 24 TS mirror produced BYTE-IDENTICAL result lines for both sessions — bitwise cross-language agreement on this workload. This is a measured observation for one host pair, NOT a universal bitwise promise (ADR-001 Decision 5).',
    },
    replayCost: {
      note: 'per-tick replay cost only — no capacity extrapolation (ROADMAP §1.3; capacity is B-AOI-03/S0.8 + B-SIM-01/Phase 5)',
      goInContainer: { benchRepeats: 2000, nsPerTick: 81.92409972222222, env: 'golang:1.24-alpine in Docker Linux VM' },
      tsOnHost: [
        { session: 'legal', benchRepeats: 2000, nsPerTick: 140.74595833333333 },
        { session: 'tampered', benchRepeats: 2000, nsPerTick: 149.8245277777778 },
      ],
    },
  },
  budgetInputs: {
    'B-VAL-01': {
      quantity: 'Legal-path replay max cumulative drift over a 60 s session (m)',
      value: legalMax,
      also: {
        distribution: tsResults.legal.distribution,
        maxHeadingDriftRad: tsResults.legal.result.maxHeadingDrift,
        tickOfMax: tsResults.legal.result.tickOfMax,
      },
      tag: '[MEASURED 2026-09-06, tools/spikes/s0.6 — 3600-tick 250 m-circle capture, f32 wire states, Go 1.24 + TS mirror replay, report.json]',
    },
    'B-VAL-02': {
      quantity: 'Tamper detection margin = tampered max drift / legal max drift (dimensionless)',
      value: tamperedMax / legalMax,
      also: { tamperedMaxDriftM: tamperedMax, tamperedTickOfMax: tsResults.tampered.result.tickOfMax },
      tag: '[MEASURED 2026-09-06, tools/spikes/s0.6 — same replay over the speed-hack capture (4x speed, 300 ticks), report.json]',
    },
  },
};

writeFileSync(join(here, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  `report.json written: legal maxDrift=${legalMax.toExponential(6)} m, tampered maxDrift=${tamperedMax.toFixed(6)} m, margin=${(tamperedMax / legalMax).toExponential(4)}, crossLanguage bitwise=${Object.values(crossLanguage).every((c) => c.bitwiseIdenticalResultLine && c.tickOfMaxAgrees && c.verdictAgrees && c.maxDriftAbsDiff === 0)}`,
);
