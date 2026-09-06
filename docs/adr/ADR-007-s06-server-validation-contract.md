# ADR-007: S0.6 — server-validation contract: bounded kinematic replay in the Go runtime

- **Status**: accepted (measured 2026-09-06; the S0.6 exit criterion is met against a synthetic recorded car path. The production accept threshold and per-vehicle clamps are proposals that Phase 4 must re-measure and ratify against the real Rapier vehicle before NETWORKING.md §6 cites them — see Consequences and Open items)
- **Date**: 2026-09-06
- **Deciders**: S0.6 keystone spike (orchestrated Phase-0 agent wave); probes and report at `tools/spikes/s0.6/` (`report.json`, regenerable via the command block in `tools/spikes/s0.6/write-report.mjs`; host: Windows 11 dev box — Ryzen 7 7445HS, RTX 4050 Laptop 6 GB, 15.2 GB RAM; Node 24.13.0, Go `golang:1.24-alpine` in Docker 29.4.2)

## Context

ROADMAP §5 S0.6 asks whether a Go-runtime validator can accept or reject client positions
without full physics, and with how much drift. ADR-001 Decision 5 fixed the architecture:
server-owned outcomes with **bounded movement validation**, no full server-authoritative
contact physics. NETWORKING.md §6 fixes the boundaries (versioned movement replay, drift
thresholds trigger reject/snap/flag; "never write server-authoritative physics") and
defers the contract itself — models, thresholds, actions — to this spike. The risk
register (ROADMAP §6 #5) names the cost of skipping it: docs promising physics the Go
runtime cannot run, shipping as either cheating or rubber-banding. Phase 4's scripted-loop
harness supplies the real recorded path; Phase 5's Nakama `MatchLoop` implements this
contract in Go.

## Evidence

All values [MEASURED 2026-09-06, `tools/spikes/s0.6/report.json` — 3600-tick (60 s,
dt = 1/60) synthetic recorded car path: 250 m-radius circle, accel-limited ramp 0 → 20 m/s
at 5 m/s² over 240 ticks, then constant speed; the client integrates exactly at dt
(midpoint scheme while accelerating, exact circular chord ds = 2R·sin(ω·dt/2) at cruise)
and reports **f32-quantized** pos/yaw/speed per tick, the Phase-5 wire encoding per the
f32-at-upload rule. The validator runs twice over the same session files: Go
(`go-validator/main.go`, pure stdlib, in the `golang:1.24-alpine` container) and a TS
mirror (`ts-mirror.mjs`) with identical f64 operation order. 9 vitest probe tests pass
(`npx vitest run tools/spikes/s0.6`).]

- **Replay model v1 (rejected)**: stepping with the reported end-of-tick speed biased
  every accelerating tick by a·dt²/2 — legal-path drift grew at 6.929e-4 m/tick during the
  240-tick ramp (predicted 6.944e-4), plateauing at **0.1665 m** max drift. A systematic
  model bias, not noise — the tuning work this spike exists to catch.
- **Replay model v2 (adopted, trapezoidal)**: step speed = (v_prev + v)/2 of consecutive
  clamped speeds. Legal-path max cumulative drift over the 60 s session: **4.524e-5 m
  (45 µm)**; distribution p50 2.92e-5 / p95 4.12e-5 / p99 4.36e-5 m, no coherent
  accumulation — pure f32-wire-quantization + exact-chord-vs-midpoint-Euler scheme noise
  (the noise floor of the replay machinery itself). Heading drift: **exactly 0 rad** — the
  heading re-sync (replay yaw follows the reported yaw through an exact f64 delta) is
  bitwise; the yaw-rate clamp never binds on a legal path.
- **Tamper detected** (one documented tamper: **speed hack** — ticks 1201–1500 report 4×
  cruise, 80 m/s, with 72 m/s² ramp accel = 12× the clamp, staying on-circle at a legal
  0.32 rad/s yaw rate, so exactly the speed/accel clamps are exercised): max cumulative
  drift **169.018 m** at tick 1477, verdict `reject`, exit code 1. Detection margin
  **3.736e6×** the legal bound (B-VAL-02).
- **Cross-language agreement**: Go and the TS mirror produced **byte-identical result
  lines** `{maxDrift, maxHeadingDrift, tickOfMax, verdict}` for both sessions after
  newline normalization. A measured observation for one host pair and one workload — not a
  universal bitwise claim (ADR-001 Decision 5 declines exactly that promise).
- **Replay cost**: 81.9 ns/tick (Go, in-container, 2000 repeats), 140.7–149.8 ns/tick
  (TS on host) — a 3600-tick session validates in ~0.3–0.5 ms of trivial arithmetic.
  Per-tick cost only; **no capacity figure is extrapolated** (ROADMAP §1.3; capacity rows
  are B-AOI-03 / B-SIM-01 and are gated elsewhere).
- **Session shape**: a full 60 s capture is 340 KB JSON (~94.5 B per state, unpacked); a
  per-tick state on the wire is one such state, far inside the 1500 B cap (CLAUDE.md).
- **NETWORKING.md consistency check**: §6 already promises no more than this contract
  (replay + thresholds; explicit no-server-Rapier statement). No edit required, and none
  made — NETWORKING.md is not owned by this spike.

## Decision

1. **The validator contract is versioned kinematic replay, as measured above.** Inputs:
   the trusted init state plus per-tick client-reported `{t, pos[3], yaw, speed}` states at
   a pinned dt (t = tick index; seconds = t·dt), numbers at wire precision (f32). Replay,
   per tick, with the client's claims **clamped to legal limits**:
   - `w = clamp(wrapAngle(reportedYaw − replayYaw)/dt, ±maxYawRate)`
   - `v = clamp(reportedSpeed, v_prev ± maxAccel·dt)`, then `clamp(v, minSpeed, maxSpeed)`
   - `vStep = (v_prev + v)/2` (trapezoidal — Decision 2), `yawMid = yaw + w·dt/2`
   - `pos += vStep·dt·[cos yawMid, sin yawMid]`, `yaw += w·dt`
   Drift per tick = |pos_replay − pos_reported| (3D); heading drift =
   |wrapAngle(yaw_replay − yaw_reported)|. Verdict compares **max cumulative position
   drift** over the replay window against the threshold.
2. **The trapezoidal step speed is part of the contract.** End-of-tick-speed stepping is a
   proven defect: a·dt²/2 per accelerating tick (0.1665 m per 4 s ramp at 5 m/s²).
3. **Clamps** (prototype values for a road car; [PLACEHOLDER — gate: Phase 4 ratify
   per-vehicle-class]): maxAccel 6 m/s² symmetric, maxYawRate 2.5 rad/s, maxSpeed 55 m/s,
   minSpeed 0 (no reverse in this model revision). The spike's contribution is the method
   and the measured drift, not these values.
4. **Thresholds**: the spike's built-in pass threshold stays 5.0 m (placeholder). The
   **proposed production accept threshold is 1.0 m max cumulative drift per 60 s replay
   window** [MEASURED 2026-09-06, 4.524e-5 m legal bound × 2.2e4 safety factor,
   `tools/spikes/s0.6/report.json`] [PLACEHOLDER — gate: Phase 4/5 ratify against the real
   vehicle path]. Rejection (drift ≥ threshold) means the server keeps its replayed state
   and flags/resyncs; the reject/snap/flag action vocabulary stays NETWORKING.md §6's, and
   tuning actions per tier is Phase 5 work.
5. **What the Nakama Go runtime will own in Phase 5 — and what it will NOT** (ADR-001
   Decision 5, now with a measured prototype): it owns per-region match loops that replay
   reported movement through this contract, sanction-rate discontinuity events, and
   authoritative flags. It does **not** own: server-side Rapier or any contact solver; a
   server-side crash/collision outcome (contact resolution stays client-visual); input
   re-simulation (it only follows clamped client-reported speed/heading); any claim of
   "server-authoritative physics".
6. **Heading channel**: replay heading re-syncs from the reported yaw with the rate clamp
   as the only obstacle — a second detector (spin-class cheats) that this spike's tamper
   does not exercise (it measured exactly 0 rad heading drift on both captures).

## Consequences

Fills ROADMAP §Budgets **B-VAL-01** = 4.524e-5 m and **B-VAL-02** = 3.736e6 **(dimensionless —
tamper detection margin, i.e. 3.736e6× the legal drift; a 2026-09-06 audit relabeled the row
and split the replay CPU cost into B-VAL-03)** [MEASURED
2026-09-06, `tools/spikes/s0.6/report.json`]; Phase 4/5 gates reference these rows. The
Go runtime's validator needs no WASM, no engine, no per-tick solver — measured at ~82 ns
per tick in the container. Harder / locked out: **legitimate discontinuities will trip the
decel clamp** — a 20 m/s → 0 wall stop decelerating at the 6 m/s² clamp floor needs
v²/(2a) = 33.3 m of replay travel (arithmetic from the clamp, not a gameplay measurement),
so crashes, lifts and sanctioned teleports need a server-sanctioned discontinuity-event
class in the contract before shared vehicles ship. The 45 µm bound is the **noise floor of
the replay machinery itself**, measured against a closed-form-ish synthetic client; a real
Rapier vehicle path will drift more (suspension/surface dynamics vs the kinematic model),
so B-VAL-01 is a floor, not the production threshold — Phase 4's recorded loop must
re-measure, and only that measurement ratifies the threshold NETWORKING.md §6 will cite.
The synthetic session generator found one real model defect (v1 bias) and one generator
bug (a falsy-accel path that broke pre-tamper bitwise equality), both caught by the probe
suite — evidence the harness works as a regression gate. Probe files are throwaway under
`tools/spikes/s0.6/`; the durable assets are this contract, `report.json`, and the two
budget rows.

**Open items** (each blocks the named gate, not this ADR):

1. Phase 4: re-measure legal drift against the real Rapier `DynamicRayCastVehicleController`
   scripted-loop capture; ratify the 1.0 m proposal and the per-vehicle clamp table
   (reverse, boost, aircraft classes).
2. Adversarial coverage: spin-hack (illegal yaw rate — exercises the heading-drift channel)
   and the 25 m lateral-teleport-over-2-ticks case were specified as alternatives and not
   probed; the speed hack alone cannot prove the heading channel trips.
3. Sanctioned-discontinuity event design (crashes, lifts, teleports) so legitimate impacts
   are not rejected — Phase 4/5.
4. ROADMAP §9's "Shared vehicle authority" matrix row names two evidence items this spike
   did not produce (its synthetic capture covers neither): powered-flight recorded-input
   replay, and forged thrust/fuel/stage/seat request rejection. Both are owed before that
   matrix row can be accepted — owning gates Phase 4/5.
4. Out-of-order, late and missing states, and snapshot/reconnect interaction with the
   replay window — Phase 5 (with S0.7's clock semantics).
5. Cross-language bitwise agreement is measured for one host pair and one workload; CI
   should re-assert it per S0.11's determinism harness rather than assume it.
