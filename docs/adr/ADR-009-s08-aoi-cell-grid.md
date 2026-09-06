# ADR-009: S0.8 — AoI cell grid: 250 m cells, rebuild-per-tick interest, and the 1500 B thresholds for the Phase-5 Go port

- **Status**: accepted (measured 2026-09-06 for tick cost and populations — B-AOI-01/B-AOI-02. B-AOI-03, the live Nakama-node measurement, is explicitly **not** filled by this spike, and the production AoI radius is still gated — see Open items)
- **Date**: 2026-09-06
- **Deciders**: S0.8 keystone spike (orchestrated Phase-0 agent wave); benchmark, probe tests and report at `tools/spikes/s0.8/` (`report.json`, regenerable via `node tools/spikes/s0.8/bench.mjs`; host: Windows 11 dev box — Ryzen 7 7445HS, RTX 4050 Laptop 6 GB, 15.2 GB RAM; Node v24.13.0, single process)

## Context

ARCHITECTURE.md §6 fixes the interest-management design and demands this measurement: a static cell grid per region match; per tick the runtime computes each client's AoI as a set of cells (own cell + radius) and streams only entities in those cells; voice proximity is subscription culling on the same grid; and "cell sizing is a Phase-0 measurement, not a guess". NETWORKING.md §4 adds the hard rules (≤1500 B per message; ~1 message per tick per presence, coalesced; coalescing beats splitting) and §9 adds per-presence priority tiers under an explicit no-capacity-promises rule. ROADMAP §5 S0.8 asks what interest management costs per tick at candidate cell sizes; §3.4 restricts the spike to **tick cost and populations only — no player-capacity promise may be derived from these rows by extrapolation** (risk register #3: AoI/capacity data met live in Phase 5 with no measured fallback).

The implementation written for this spike, `tools/spikes/s0.8/aoi.ts`, is deliberately authored as the **normative algorithm spec for the Phase-5 Go port** of the region-match interest manager: the port must reproduce it step for step (Decision 3).

## Evidence

All values [MEASURED 2026-09-06, `tools/spikes/s0.8/report.json` — 32 configs = 4 presence counts (100/500/1000/5000) × 4 cell sizes (100/250/500/1000 m) × 2 distributions over a 5×5 km synthetic region; 300 measured ticks after 30 warmup per config; `perf_hooks` `performance.now()` spans; one tick = move phase (every presence takes one 0.07 m random-direction step through `grid.move()` — 1.4 m/s walk at the assumed 20 Hz [INPUT assumption, not a measurement; Nakama `MatchInit` permits tickrate 1–60, NETWORKING.md §5]) + full interest rebuild (`grid.rebuildTick()`)]. Algorithm correctness is pinned by 12 vitest probe tests (`npx vitest run tools/spikes/s0.8`: floor-cell semantics, membership invariants, rect-intersects-disc interest vs an independent brute force, exact tangency at R, set-identity of rebuild, buffer reuse). Placement RNG fully seeded; timing rows vary run to run by nature. AoI radius fixed at 500 m so cell size is the only grid variable [PLACEHOLDER — gate: Phase 3/5 for the production radius].

**Full rebuild tick, p50 / p99, ms** (mean/p50/p99/max per config live in `report.json`; p99 = 297th of 300 sorted samples, nearest-rank). U = uniform over the 5×5 km area; C = clustered, Stone-Town-like — 80% of presences in the centred square holding 10% of the area:

| cell size | N=100 | N=500 | N=1000 | N=5000 |
|---|---|---|---|---|
| **U 100 m** | 0.65 / 1.92 | 2.95 / 7.70 | 7.24 / 13.64 | 56.46 / 124.85 |
| **U 250 m** | **0.19 / 0.74** | **0.81 / 2.06** | **2.10 / 4.13** | **23.74 / 41.06** |
| **U 500 m** | 0.09 / 0.59 | 0.40 / 1.12 | 1.11 / 2.63 | 22.92 / 36.45 |
| **U 1000 m** | 0.05 / 0.29 | 0.37 / 1.47 | 1.30 / 3.07 | 35.49 / 55.84 |
| **C 100 m** | 0.66 / 3.13 | 3.32 / 5.70 | 8.24 / 12.40 | 98.85 / 151.64 |
| **C 250 m** | **0.18 / 0.79** | **1.27 / 2.60** | **4.45 / 9.54** | **78.66 / 134.83** |
| **C 500 m** | 0.09 / 0.30 | 0.92 / 2.36 | 3.02 / 7.02 | 77.36 / 123.30 |
| **C 1000 m** | 0.05 / 0.14 | 1.01 / 2.35 | 4.26 / 8.43 | 100.06 / 146.49 |

**Populations and set sizes at N=5000** (max over the 300 measured ticks):

| cell size | max cell population U / C | max interest set U / C | mean AoI cells per observer |
|---|---|---|---|
| 100 m | 8 / 27 | 236 / 1728 | 99.6 |
| **250 m** | **23 / 129** | **334 / 2411** | 21.5 |
| 500 m | 64 / 425 | 488 / 2829 | 8.1 |
| 1000 m | 224 / 1686 | 843 / 2921 | 3.8 |

Observed structure: the rebuild phase dominates the tick (mean move phase ≤ 1.1 ms in every config; the rest is rebuild), and its cost is the product of cells walked per observer (99.6 / 21.5 / 8.1 / 3.8 at 100/250/500/1000 m — pure geometry of the rect-intersects-disc rule, distribution-insensitive) and members per cell. 100 m cells walk 4.6× the cells of 250 m to buy only ≈1.4× smaller interest sets (334/236 = 1.42, N5000 uniform); 1000 m cells copy the largest sets and pile up to 1686 presences in one cell. At N=5000 clustered the measured p99 exceeds the 50 ms period of a 20 Hz tick at **every** candidate cell size on this Node runtime (123.3–151.6 ms); uniform fits at p99 only at 250/500 m (41.06 / 36.45 ms). That is a measured tick-cost statement at the measured count — the Go runtime's cost is unmeasured and no capacity figure is derived from it.

**Message-size implication** [MEASURED populations; DERIVED bandwidth implication — the byte ledger per opcode is owned by the Phase-5 netcode design doc; until then the stated model is: envelope 16 B, full-state record 24 B (compact state per NETWORKING.md §8: id + 2×f32 position + 2×i16 velocity + heading + frame ID + movement regime + model revision + flags), delta record 10 B — [PLACEHOLDER — gate: Phase 5]]:

- A full-state-per-tick broadcast to one client's AoI neighbor set (NETWORKING.md §4 rule 2 framing: one coalesced message per tick per presence) violates the 1500 B cap beyond **61 presences** in the set — floor((1500−16)/24); at the cap the message is 1480 B = 29.6 kB/s ≈ 0.24 Mbps per client at 20 Hz [DERIVED].
- The delta/coalescing path becomes mandatory beyond **148 presences** in the set — floor((1500−16)/10); beyond that the only remaining lever is the NETWORKING.md §9 priority tiers (full-rate local cell / interpolated adjacent / throttled beyond), because the cap never moves.
- Worst measured config (N5000, 1000 m cells, clustered): max interest set **2921** → 70,120 B of full state ≈ **46.8× the cap** ≈ 11.2 Mbps per client at 20 Hz [DERIVED] — over the B-RTT-09 assumed 5–10 Mbps access envelope before any per-second budget is even considered [PLACEHOLDER — gate: S0.9].
- At the adopted 250 m cells the measured sets first cross 61 at N1000 uniform (70 → 1696 B) and first cross 148 at N500 clustered (233 → 5608 B). Full-state-per-tick is legal only in sparse regions: **the delta/coalescing path is mandatory from day one of Phase 5**, not a later optimization.

## Decision

1. **Adopt 250 m cells with a 500 m AoI radius** [MEASURED 2026-09-06, the tables above; the radius is the benchmark's fixed input — the production radius follows pop-in and streaming-lead distances and stays [PLACEHOLDER — gate: Phase 3/5]]. 250 m is the measured knee: statistically tied with 500 m on tick cost at N5000 (p50 23.74 vs 22.92 ms uniform in the quoted run; the first same-day run measured a p50 tie at the quoted precision, 23.92 vs 23.92 ms (raw 23.9219 vs 23.9172)), 2.4× cheaper than 100 m there, and dearer than 500 m only at low/mid counts where both are immaterial against the 50 ms period (N1000 uniform: 2.10 vs 1.11 ms), while giving the smallest worst-case broadcast sets of any size that holds the tick at N5000 (334/2411 vs 488/2829 at 500 m, 843/2921 at 1000 m) and a per-cell population bounded at 129 measured max in the densest hotspot (the voice-culling subscription set, B-AOI-04) vs 425 at 500 m and 1686 at 1000 m. 100 m is rejected on tick cost; 1000 m on set size, cell population and tick cost at N5000.
2. **Adopt rebuild-per-tick subscription semantics** (ARCHITECTURE.md §6 as written): no incremental subscription diff; every tick recomputes every observer's interest set from the cell grid. The measured cost of that semantics is what this ADR bought; a delta-subscription scheme may be revisited only through ROADMAP §7 change control with its own measurements.
3. **`tools/spikes/s0.8/aoi.ts` is the algorithm spec for the Phase-5 Go port** — the port must reproduce, step for step: static square grid, cell = (floor(x/c), floor(z/c)) with boundary positions on the positive side; one long-lived member array per cell with swap-remove and pruning of emptied cells; per tick, every presence is an observer whose interest set is the member ids of all cells whose closed rectangle intersects the AoI disc (nearest-point clamp test, f64), excluding itself; candidate cell range padded one ring beyond the raw floor bounds so exact tangency and f64 rounding survive (the rectangle test is the sole membership authority); interest buffers cleared and reused so a rebuild tick allocates nothing; cell key packed as `(cx + 2^20)·2^21 + (cz + 2^20)` — injective for |cx|,|cz| < 2^20 and exact in f64 (< 2^42), the same uint64 arithmetic in Go. **Go maps vs TS Map caveat**: TS `Map` iterates in insertion order, Go map range order is randomized — rebuild outputs are identical *as sets*; any consumer needing order (stable wire field order, deterministic validation) must sort explicitly. Interest buffers map to `buf = buf[:0]` reuse; member arrays to Go slices with the same swap-remove; `Math.floor` to `math.Floor` (identical f64 semantics). The grid lives in match state and is touched only by the match's `MatchLoop` (NETWORKING.md §5) — no synchronization is specified. The 12 probe tests pin the rules a port must honor.
4. **Broadcast framing for Phase 5**: one coalesced message per tick per presence over the rebuilt interest set; full-state records only while the set ≤ 61; delta records beyond; §9 priority tiers beyond 148. The 61/148 thresholds derive from the stated wire model above and move if the Phase-5 netcode design doc's byte ledger differs — the 1500 B cap itself never moves (CLAUDE.md invariant).

## Consequences

Fills ROADMAP §Budgets **B-AOI-01** = 250 m [MEASURED 2026-09-06, 32-config rebuild-tick benchmark, `tools/spikes/s0.8/report.json`] and **B-AOI-02** — headline rows in the Evidence tables; the full 32-row table (mean/p50/p99/max tick, phases, populations, set sizes) lives in `report.json` and is regenerable. **B-AOI-03 is NOT filled** — it needs a live Nakama node and stays [PLACEHOLDER — gate: Phase 5]; **B-AOI-04** (voice-culling set size — measured upper bound 129 per cell at the chosen size, clustered N5000) is ratified at Phase 6; **B-AOI-05** (steady-state per-client bandwidth) is a Phase-5 measurement. No player-capacity figure, no "supports N players", and no per-presence extrapolation beyond the measured counts is licensed by this ADR or by `report.json` (ROADMAP §3.4, §1.3); the Node/Windows numbers characterize this runtime class only — the Go runtime's cost is unmeasured (Open item 1).

Easier: Phase 5 has a tested algorithm spec and a port checklist instead of a paragraph of prose; the byte-threshold arithmetic (61/148) gives the netcode design doc its first hard budget line. Harder/locked out: rebuild-per-tick means per-tick cost scales with observers × cells-in-radius — the measured 123–152 ms p99 for a 5000-presence clustered 5×5 km region on the Node runtime says a Stone-Town-density region of that size cannot be one 20 Hz match on this class of runtime; region decomposition (ARCHITECTURE.md §6's regional design) and the Phase-5 Go measurement must answer it, and **any sentence elsewhere deriving "supports N players" from this spike is a defect** (ROADMAP §1.3). The measured cell-population bound (129) is a hotspot-at-N5000 observation, not a ceiling — real regions can exceed it, which is exactly why the §9 priority tiers exist.

**Open items** (each blocks the named gate, not this ADR):

1. Real Nakama Go-runtime `MatchLoop` integration and live per-tick measurement on the dev-box node → B-AOI-03 [PLACEHOLDER — gate: Phase 5]. This spike measures the algorithm, not the platform.
2. Production AoI radius (pop-in / streaming-lead distances own it) [PLACEHOLDER — gate: Phase 3/5]; the cell-size choice is conditioned on the benchmarked 500 m and should be re-checked if the radius moves by a factor.
3. Voice-culling hysteresis on the subscribe/unsubscribe edge (ARCHITECTURE.md §6) — unmeasured [PLACEHOLDER — gate: Phase 6].
4. The wire-model byte ledger (16/24/10 B) is a stated stand-in for the Phase-5 netcode design doc's ledger; the 61/148 thresholds inherit that gate [PLACEHOLDER — gate: Phase 5].
5. Steady-state AoI update bandwidth per client → B-AOI-05 [PLACEHOLDER — gate: Phase 5].
