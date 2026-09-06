# ROADMAP

> **Status: pre-code, docs-first.** Phase 0 spikes have not been run. Nothing in this
> document is a promise until its figure is `[MEASURED]` in the Budgets section. Phase
> numbering here is canonical for the whole repo; MASTER_PROMPT.md section H summarizes it
> and must mirror it, never fork it.

## 1. Reading rules

### 1.1 Tag vocabulary

Every figure in this project carries exactly one tag:

| Tag | Meaning |
|---|---|
| `[MEASURED yyyy-mm-dd, method]` | We measured it. The method is named in the row (tool, build, link conditions, sample size). Only the spike or phase named in the row's gate may fill it. |
| `[PLACEHOLDER — gate: Phase 0.x]` | Unfilled. The gate names the spike or phase that must fill it before any work that depends on it. A placeholder is never a target, a goal, or a promise. |
| `[EXTERNAL url]` | Quoted from an external primary source (spec, vendor docs, standards body), pinned by URL. It is an input to our design — never evidence that Kwetu achieves it. |

### 1.2 Single home for numbers

**Budgets & Benchmarks (§3) is the single home for every number in the project** that
describes what Kwetu builds or promises: initial load, region payloads, draw calls, frame
rate, VRAM, AoI sizing, players per handler, RTT, hosting cost, bake times, precision
limits, and the pinned external engine-guidance constants that other docs cite. Other
documents reference rows by ID (`§Budgets B-LOAD-01`) and **MUST NOT restate the values**.

Research facts with their own provenance home — dataset versions and sizes
(DATA_SOURCES.md), corpus counts (docs/swahili-i18n.md), the hardware and access envelope
(PROJECT_VISION.md) — live there, tagged with this same vocabulary, and are cross-referenced
rather than duplicated. Where a delegated fact also has a measurement gate here, the
delegated doc owns the *statement* and the §Budgets row owns the *measurement*: the access
envelope is stated — and tagged as an assumption pending S0.9 — in PROJECT_VISION.md, while
B-RTT-09 holds the S0.9 verdict that confirms, revises, or replaces it.

### 1.3 The no-unbenchmarked-promises rule

1. **No phase exit criterion may depend on a `[PLACEHOLDER]` row.** Where a criterion needs
   a budget, the criterion is "the measurement exists and is recorded in §Budgets" — the
   number itself is produced by the phase that runs the measurement, then owned by the row.
2. **Any sentence asserting performance without a tag — in this document or any other — is
   a defect.** Fix it by tagging it, moving it into a §Budgets row, or deleting it. The
   cross-doc review pass enforces this.
3. An `[EXTERNAL]` quote never upgrades into a promise about Kwetu. Only `[MEASURED]` rows
   support exit criteria.

### 1.4 Placeholder gates and the Phase 0 exit

Phase 0's exit criterion (§2) requires that no `[PLACEHOLDER]` row **gating Phase 1 or
later** is still empty when Phase 0 closes. Rows gated at Phase 2 or later may legitimately
remain placeholders until their gate runs. Every row below has a gate; no row is ever
filled without its tag naming date and method.

## 2. Phase table

Exit criteria are browser-testable by one human. Sequencing is strictly linear: a phase
starts only when the previous gate passes and no §Budgets row it depends on is still
`[PLACEHOLDER]`.

| Phase | Goal | Exit criterion (one human, in a browser) |
|---|---|---|
| 0 — Spikes | 12 ADRs + measurements, no feature code | All 12 ADRs merged; §Budgets has no empty `[PLACEHOLDER]` rows gating Phase 1+ |
| 1 — Engine core | Precision + rendering in empty world | Camera flies 1 m → 1e10 m in Chrome + Firefox: no jitter, no z-fighting; shell transfer recorded |
| 2 — Earth data | DSM/Zanzibar baked + streamed | Player loads Dar es Salaam: OSM basemap + terrain + buildings streamed over range requests; payload + bake times recorded |
| 3 — Walk | Character on real ground, single-player | Walk Stone Town seafront inland on the dev box and the defined integrated-GPU baseline, with the frame rate recorded into B-FPS-01 tier B; position persists across reload |
| 4 — Car | Vehicles + world interaction | Scripted loop through Dar streets, suspension behaves; rejoin finds car where left |
| 5 — Multiplayer | 2+ players, server-authoritative | Two browsers see each other interpolated; unvalidated positions rejected (drift measured); mid-session reconnect recovers |
| 6 — Voice | Proximity voice behind CGNAT | Positional hearing w/ attenuation; TURN-forced connection succeeds; server mute not bypassable |
| 7 — Rocket | Ascent + rails handoff | Launch from Dar-coast pad, powered-flight→coast handoff without visible discontinuity, land back; ephemeris matches Python-oracle fixtures |
| 8 — Orbit & Moon | Off-Earth bodies | Lunar orbit → descent → walk at real scale; Earth-in-sky correct via astronomy-engine |
| Vertical Slice | The promise, integrated | Fresh browser: pad→walk→drive→launch→orbit→lunar landing alongside another player, with voice, EN + sw, on a measured connection profile |
| Alpha | A world people can live in | kill -9 + snapshot recovery; backup restore drill on video; measured concurrent-player figure; compliance + attribution screens pass |
| Solar System | The neighborhood | Earth→Mars travel; MOLA-sampled landing at real scale; satellites match Horizons fixtures |
| Interstellar | Beyond | Round trip preserves persistence + clock consistency; any n-body mode proven deterministic cross-platform before touching the authoritative server |

## 3. Budgets & Benchmarks

This section is the project's single home for every number (§1.2). All rows are seeded
unfilled; each carries its gate.

### 3.1 Initial load per package — gate S0.3

Method for whoever fills these rows: build a minimal production shell that imports each
package in its shipping configuration, serve under the production CDN/compression config,
record gzip transfer per package and the total first visit. The informal 3–5 MB
first-visit figure from early planning is **withdrawn** — S0.3 replaces it with measured
figures or formally withdraws it. Every row below is `[PLACEHOLDER — gate: S0.3]` until
measured.

| ID | Package / quantity | gzip transfer | Tag |
|---|---|---|---|
| B-LOAD-01 | three.js core build | 126,438 B | [MEASURED 2026-09-05, tools/spikes/s0.3/measure.mjs — vite 8.2.2 (rolldown/oxc) minified prod import, zlib gzipSync level 9] |
| B-LOAD-02 | Rapier WASM (deterministic compat build — package split recorded in ARCHITECTURE.md §13) | 1,088,335 B as the compat build ships (WASM base64-inlined); standalone .wasm reference 772,479 B (not additive; inlining costs ≈ 316 KB gzip) — shipping config decided by ADR-004 Decision 2 (compat build, base64-inlined); Phase-1 production-build confirmation pending, revisit trigger = B-RTT-09 × B-LOAD-09 | [MEASURED 2026-09-05, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-03 | nakama-js | 13,137 B | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — byte probe, no server contacted] |
| B-LOAD-04 | livekit-client | 131,745 B (E2EE worker excluded; its 68,605 B gzip9 build recorded separately in ADR-004) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-05 | KTX2 / Basis transcoder (WASM + JS) | 262,678 B | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-06 | meshopt decoder (WASM + JS) | 7,804 B as shipped (7,231 B when bundled) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-07 | App shell composition — definition revised 2026-09-06 (§7): the probed figure includes three + Rapier compat + B-LOAD-12/13; the pure app-TS+CSS-only figure moves to Phase 1 with the real build | 1,216,417 B derived (cross-check direct build 1,215,356 B; composition = B-LOAD-01 + B-LOAD-02 + B-LOAD-12 + B-LOAD-13 + app code) | [MEASURED 2026-09-06, derived subtraction + direct-build cross-check, tools/spikes/s0.3/report.json] |
| B-LOAD-08 | One locale bundle (EN or sw JSON; locales load lazily per docs/swahili-i18n.md) | sw 1,346 / EN 1,210 (112-key spike fixture; production namespace re-measure at Phase 1) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-09 | **Total first-visit transfer** — method revised 2026-09-06 (§7): ADR-004 inclusion list (shell 1,401,137 + Basis transcoder 262,678 + EN locale 1,210), NOT a naive sum of rows 01–08 (which would double-count) | 1,665,025 B provisional | [MEASURED 2026-09-06, derived sum over stated inclusion list] |
| B-LOAD-10 | Warm re-visit transfer (Cache API / IndexedDB hit, `navigator.storage.persist()` granted) | — | [PLACEHOLDER — gate: Phase 1 (re-gated from S0.3 per ADR-004 — static probe cannot observe cache behaviour; §7)] |
| B-LOAD-12 | astronomy-engine | 19,257 B (inside B-LOAD-07 composition; not additive) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |
| B-LOAD-13 | i18next | 13,568 B (inside B-LOAD-07 composition; not additive) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs] |

### 3.2 Region payload per LOD tier — gate Phase 2

Tier definitions are owned here; the regions catalog with bboxes lives in MASTER_PROMPT.md
section B.

- **L0 far-field** — global imagery + coarse DEM for the whole-planet view
- **L1 vector basemap** — per-region PMTiles (planetiler output) over CORS + range requests
- **L2 terrain mesh** — pre-baked delatin meshes built from the GLO-30 DSM
- **L3 buildings** — OSM2World → glTF → 3D Tiles, streamed by the 3d-tiles renderer

| ID | Tier | Dar es Salaam | Zanzibar / Stone Town | Tag |
|---|---|---|---|---|
| B-REG-01 | L0 far-field, per typical visit | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-REG-02 | L1 vector basemap, per typical visit | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-REG-03 | L2 terrain mesh, per typical visit | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-REG-04 | L3 buildings, per typical visit | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-REG-05 | Warm-cache re-visit payload (all tiers) | — | — | [PLACEHOLDER — gate: Phase 2] |

### 3.3 Draw calls, frame rate, VRAM per scene tier — gate S0.2, refreshed per phase

Scene tiers: **A** empty-world precision flythrough (Phase 1) · **B** one flagship region at
walk scale (Phase 3) · **C** region + vehicles + remote players (Phase 5) · **D**
orbital/planetary view (Phase 8). S0.2 fills tier A; tiers B/C/D are re-measured as their
phases land and the rows updated. Every row is measured on the dev box **and** on the
defined integrated-GPU baseline; both values go in the row when filled.

Acceptance bar for tier B: **60 fps** on the dev box *and* on the defined integrated-GPU
baseline — recorded here as the intent the phase aims at, not as data. B-FPS-01 is filled
only by `[MEASURED]` values, and the §2/§4 criteria test that the measurement exists and
is recorded, never that a bar was met (§1.3).

| ID | Quantity (unit) | A | B | C | D | Tag |
|---|---|---|---|---|---|---|
| B-DC-01 | Draw calls per frame | — | — | — | — | [PLACEHOLDER — gate: S0.2; tiers B/C/D at Phases 3/5/8] |
| B-FPS-01 | Frame rate (fps) | — | — | — | — | [PLACEHOLDER — gate: S0.2; tiers B/C/D at Phases 3/5/8] |
| B-VRAM-01 | VRAM per scene tier (MiB) | — | — | — | — | [PLACEHOLDER — gate: S0.2; tiers B/C/D at Phases 3/5/8] |
| B-VRAM-02 | Integrated-GPU VRAM ceiling (MiB) — the ceiling other rows must respect | — | — | — | — | [PLACEHOLDER — gate: S0.2] |

### 3.4 Interest management & capacity — gate S0.8

S0.8 measures tick cost only. **No player-capacity promise may be derived from these rows
by extrapolation** — that is S0.8's explicit rule and §1.3 applies to any such sentence.

| ID | Quantity (unit) | Value | Tag |
|---|---|---|---|
| B-AOI-01 | AoI cell size (m) — measured optimum | 250 m (chosen from 4 candidate cell sizes × 4 presence counts × 2 distributions; headline config N=5,000 uniform, cs 250 m: p50 23.737 ms / p99 41.057 ms per tick) | [MEASURED 2026-09-06, tools/spikes/s0.8/report.json — full 32-config table in ADR-009] |
| B-AOI-02 | Measured per-tick cost per synthetic presence at each candidate cell size (ms; full table lives in the S0.8 ADR) | headline: 5,000 presences, cs 250 m, uniform — p50 23.737 / p99 41.057 ms per 300+30-tick run; per-population sets (23/334), (129/2,411), (1,686/2,921) presences across AoI radii | [MEASURED 2026-09-06, tools/spikes/s0.8/report.json] |
| B-AOI-03 | Players per match handler, measured on the dev-box Nakama node (measured, not extrapolated) | — | [PLACEHOLDER — gate: Phase 5 (re-gated from S0.8 per ADR-009 — requires a live Nakama node, which a synthetic micro-benchmark cannot provide; §7)] |
| B-AOI-04 | Voice proximity subscription-culling set size at the chosen cell size (presences) | — | [PLACEHOLDER — gate: Phase 6] |
| B-AOI-05 | AoI update bandwidth per client at the chosen cell size (kB/s, steady state) | — | [PLACEHOLDER — gate: Phase 5] |

### 3.5 RTT & access envelope — gate S0.9

| ID | Path / quantity | Value | Tag |
|---|---|---|---|
| B-RTT-01 | Dar es Salaam → eu-central: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-02 | Dar es Salaam → Cape Town: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-03 | Dar es Salaam → Nairobi: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-04 | Zanzibar → eu-central: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-05 | Zanzibar → Cape Town: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-06 | Zanzibar → Nairobi: RTT median (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-07 | TURN-relayed RTT overhead vs direct, same path pair (ms) | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-08 | Loss / jitter profile on the measured paths | — | [PLACEHOLDER — gate: S0.9] |
| B-RTT-09 | Access-envelope verdict: S0.9's probes confirm, revise, or replace the assumed 5–10 Mbps / high-RTT design envelope. The envelope *statement* is owned by PROJECT_VISION.md and tagged there as an assumption pending this row. Bandwidth medians for Tanzania/Kenya could not be verified at research time — this is an assumption, not data | 5–10 Mbps, high RTT (assumption under test) | [PLACEHOLDER — gate: S0.9] |

### 3.6 Hosting cost — gate S0.9

| ID | Quantity (unit) | Value | Tag |
|---|---|---|---|
| B-COST-01 | Monthly hosting cost per candidate region (eu-central / Cape Town / Nairobi), full compose stack | — | [PLACEHOLDER — gate: S0.9] |
| B-COST-02 | TURN relay cost at the measured CGNAT relay share | — | [PLACEHOLDER — gate: S0.9] |
| B-COST-03 | Storage + backup cost (Postgres dumps, object storage, offsite rotation), monthly | — | [PLACEHOLDER — gate: S0.9] |

### 3.7 Region bake times — gate Phase 2

Recorded at the Phase 2 exit per its criterion ("payload + bake times recorded"). Also
record: the pinned Geofabrik Tanzania pbf timestamp each bake used.

| ID | Bake step (per region) | Dar es Salaam | Zanzibar / Stone Town | Tag |
|---|---|---|---|---|
| B-BAKE-01 | osmium bbox extract + planetiler → per-region PMTiles | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-BAKE-02 | GLO-30 DSM (WBM-filtered, sea flattened) → delatin terrain meshes | — | — | [PLACEHOLDER — gate: Phase 2] |
| B-BAKE-03 | OSM2World → glTF → 3d-tiles-tools → 3D Tiles | — | — | [PLACEHOLDER — gate: Phase 2] |

### 3.8 Precision & ephemeris — gates S0.1, S0.11, Phase 7

| ID | Quantity (unit) | Value | Tag |
|---|---|---|---|
| B-PREC-01 | Max observed positional jitter at a 1e7 m origin offset (m) | 0.5 m stored globally in f32 vs 4.45e-7 m with floating origin (600-tick 1 m/s walk, dt 1/60) — 1.1e6× improvement | [MEASURED 2026-09-05, tools/spikes/s0.1/report.json; ADR-002] |
| B-PREC-02 | Rendered-scene distance-from-origin ceiling (m) — verified f64/f32 boundary from S0.1 | 1e5–1e6 m confirmed: f32 spacing 6 cm at 1e6 m, 0.5 m at 1e7 m, 1 km at 1e10 m; f64 side floors at 30.5 µm ULP at 1.5e11 m — full ladder in ADR-002 §Evidence B; contact bubbles bounded separately (B-CONTACT-01) | [MEASURED 2026-09-05, tools/spikes/s0.1/report.json; ADR-002] |
| B-EPH-01 | Golden-ephemeris residual: our propagator vs Skyfield/Horizons fixtures (arcmin; km at lunar distance) | — | [PLACEHOLDER — gate: Phase 7] |
| B-EPH-02 | Determinism regression: state-hash agreement across platforms (bitwise pass/fail, per S0.11) | PASS — canonical sha256 `f127593e229cb26f942bade3bf849b8b21f77fed5baa909b3a7215074e2e9f7e` identical on Windows host (Ryzen 7 7445HS) and Linux x86-64 (`node:24-alpine`, image digest sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf); the same WASM f32 module ships on both, as ADR-011 predicted | [MEASURED 2026-09-06, tests/determinism executed on both platforms, hashes compared bitwise] |

### 3.8a Contact bubble — gate S0.1 (measured 2026-09-05; ADR-002)

Added per the ROADMAP §9 flight-revision acceptance matrix ("local contact radius and error
(S0.1)"). Rapier deterministic-compat 0.20.0, dt 1/60, Rapier defaults, friction 0.7.

| ID | Quantity | Value | Tag |
|---|---|---|---|
| B-CONTACT-01 | Active contact-bubble extent bound (m) — tangent (0,0,-g) gravity direction error at the extent | ≤ 1e4 m: direction error 1.57e-3 rad, lateral 0.0154 m/s², 60 s ballistic miss ≈ 28 m; 100 km → 0.0157 rad / 277 m; 1e6 m → model invalid (0.156 rad) | [MEASURED 2026-09-05, tools/spikes/s0.1/report.json; ADR-002 Decision 4] |
| B-CONTACT-02 | Rebase re-derivation residuals (+1000 m translate + 90° yaw: position m / velocity m/s / quaternion) | 2.44e-5 / 0 / 6.72e-8; contacts re-hold, joint drift 2.38e-7 m. A translation applied to accumulated f32 solver state is a proven contact-killer at 5e6 m (phantom free-fall, tunnelling) | [MEASURED 2026-09-05, tools/spikes/s0.1/report.json; ADR-002 Decision 2] |
| B-CONTACT-03 | Resting-contact acceptance classes (penetration m) and joint anchor drift | 6.875e-5 m flat pad; 1.056e-3 m on a 15° ramp; fixed joint 0 m drift under 523.6 kg (600 steps, dt 1/60, Rapier defaults) | [MEASURED 2026-09-05, tools/spikes/s0.1/report.json; ADR-002 Decision 5] |

### 3.8b Universe clock — gate S0.7 (measured 2026-09-06; ADR-008)

Added with ADR-008's landing (the spike's fills were recorded against the S0.7 exit
criterion; the rows formalize them).

| ID | Quantity | Value | Tag |
|---|---|---|---|
| B-TIME-01 | TT↔UTC conversion residual vs astronomy-engine 2.1.19 across the leap-second span (max over 7 samples 1995–2026) | 0 s (0 day) | [MEASURED 2026-09-06, tools/spikes/s0.7/report.json] |
| B-TIME-02 | Versioned leap-second table coverage (tools/spikes/s0.7/leap-seconds.json — durable asset, relocation pending) | 1972-01-01 (TAI−UTC 10 s) → 2017-01-01 (37 s), 28 rows; current offset 37 s; revision ierc-2026-09-06 | [MEASURED 2026-09-06, validateLeapTable(); source EXTERNAL — verified 2026-09-06, https://data.iana.org/time-zones/data/leap-seconds.list] |

### 3.9 Pinned external reference figures

These rows pin external figures so other docs cite by ID instead of restating. They are
inputs to design, never promises about Kwetu.

| ID | Figure | Tag |
|---|---|---|
| B-CONST-01 | Nakama match-handler guidance: payloads within ~1500 B; ~1 msg/tick/presence; fewer larger messages beat many small ones | [EXTERNAL https://heroiclabs.com/docs/] |
| B-CONST-02 | Nakama `socket.max_message_size_bytes` default 4 KB; an oversized message causes the server to close the connection | [EXTERNAL https://heroiclabs.com/docs/] |
| B-CONST-03 | Nakama default ports: client HTTP+WS 7350, console 7351, gRPC 7349, gRPC-console 7348 ("console on 7349" is stale folklore) | [EXTERNAL https://heroiclabs.com/docs/] |
| B-CONST-04 | Nakama `metrics.prometheus_port` default 0 = disabled; must be set explicitly | [EXTERNAL https://heroiclabs.com/docs/] |
| B-CONST-05 | IEEE-754 binary32 loses integer precision above 2^24 (≈ 1.6777e7); drives the f64-in-JS / f32-at-upload rule and B-PREC-02 | [EXTERNAL https://en.wikipedia.org/wiki/Single-precision_floating-point_format] |
| B-CONST-06 | astronomy-engine stated accuracy ≈ ±1 arcmin (≈ 112 km at the Moon's mean distance, per COORDINATE_SYSTEM.md §10): sky/event quality, NOT landing guidance | [EXTERNAL https://github.com/commenthol/astronomy-engine] |
| B-CONST-07 | Chromium AEC does not hear WebAudio output (issues 121673 and 686665) → push-to-talk is the default | [EXTERNAL https://issues.chromium.org/issues/121673] |
| B-CONST-08 | WebKit ITP caps script-writable storage (localStorage/IndexedDB) at 7 days → `navigator.storage.persist()` is mandatory; Safari is out of target scope, Android re-tested at Alpha | [EXTERNAL https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/] |

### 3.10 Asset, decode & cache runtime — gate Phase 2

Per-asset and client-runtime rows, appended 2026-09-05 so the docs that reference them
(ASSET_STRATEGY.md §14 and §11; ARCHITECTURE.md §12) cite real IDs instead of dead-ending.

| ID | Quantity (unit) | Value | Tag |
|---|---|---|---|
| B-ASSET-01 | Hero asset .glb (LOD0 + LOD1), gz transfer per asset (kB) | — | [PLACEHOLDER — gate: Phase 2] |
| B-ASSET-02 | Single Swahili-coast kit part .glb, gz transfer (kB) | — | [PLACEHOLDER — gate: Phase 2] |
| B-ASSET-03 | ETC1S / UASTC KTX2 texture at each standard resolution (kB) | — | [PLACEHOLDER — gate: Phase 2] |
| B-DEC-01 | Decoder decode time per asset class — KTX2 texture, meshopt .glb (ms per asset) | — | [PLACEHOLDER — gate: Phase 2] |
| B-MESH-01 | Client runtime-meshing cost per terrain chunk (ms; exploration-only path, ASSET_STRATEGY.md §11) | — | [PLACEHOLDER — gate: Phase 2] |
| B-LOAD-11 | Time-to-first-region, cold cache and warm cache (s) | — | [PLACEHOLDER — gate: Phase 2] |
| B-CACHE-01 | Persisted asset-cache footprint after a defined region tour (MiB; steers the LRU policy, ASSET_STRATEGY.md §6) | — | [PLACEHOLDER — gate: Phase 2] |

### 3.11 Multiplayer runtime — gate Phase 5

Server and netcode rows filled when real presences flow; ARCHITECTURE.md §12 and
NETWORKING.md §7 cite them.

| ID | Quantity (unit) | Value | Tag |
|---|---|---|---|
| B-SIM-01 | Go-runtime `MatchLoop` CPU per region at peak presence (ms per tick, worst region) | — | [PLACEHOLDER — gate: Phase 5] |
| B-NET-01 | Interpolation buffer depth (snapshot entries held before rendering; NETWORKING.md §7) | — | [PLACEHOLDER — gate: Phase 5] |

### 3.11a Server-validation replay — gate S0.6 (measured 2026-09-06; ADR-007)

Added with ADR-007's landing (ROADMAP §9 sanctions "powered-flight integration/replay
drift and CPU cost (S0.6/S0.7)" rows). Contract: trapezoidal kinematic replay with
drift thresholds; production thresholds + clamps remain Phase-4 proposals.

| ID | Quantity | Value | Tag |
|---|---|---|---|
| B-VAL-01 | Kinematic-replay position drift vs recorded car path over a full synthetic session (max; p50 2.92e-5 / p95 4.12e-5 / p99 4.36e-5 m) | 4.524e-5 m | [MEASURED 2026-09-06, tools/spikes/s0.6/report.json] |
| B-VAL-02 | Validator replay CPU cost (ticks/s) — Go 81.92 ns/tick, TS 140.7/149.8 ns/tick | 3,735,928 ticks/s (Go, single core) | [MEASURED 2026-09-06, tools/spikes/s0.6/report.json] |

### 3.12 UI & i18n runtime — gate S0.10 (measured 2026-09-06; ADR-010)

Added with ADR-010's landing. DOM-overlay-vs-canvas HUD decision evidence; spike
string-set basis (production namespace re-measure owed at Phase 1).

| ID | Quantity | Value | Tag |
|---|---|---|---|
| B-UI-01 | HUD update cost, DOM vs canvas (p50 ms per update at 200 elements; headless Chromium) — DOM 0.50 (mean 0.59), canvas 2.00; text-thrash hazard 68.3/71.3 ms; input→paint 9.3 ms; rAF peak 33.4 ms | DOM 0.50 / canvas 2.00 ms p50 | [MEASURED 2026-09-06, tools/spikes/s0.10/report.json] |
| B-I18N-01 | Swahili/English locale bundle size ratio (raw / gzip9, spike string set) | 1.056 raw / 1.325 gzip9 (EN 1,825 B / sw 1,927 B raw) | [MEASURED 2026-09-06, tools/spikes/s0.10/report.json] |

## 4. Phase gates

Exit criteria are quoted verbatim from §2. "Spikes consumed" names the Phase-0 spikes whose outputs this phase builds on; "decisions produced" names the ADRs this phase owes in docs/adr/.

### Phase 0 — Spikes

- **Goal**: 12 ADRs + measurements, no feature code.
- **Deliverables**: the 12 spike ADRs of §5; every §Budgets row gated at S0.x filled or formally withdrawn; the license ledger with CI check; the trademark search record; the privacy data map; committed golden ephemeris fixtures. Zero feature code.
- **Exit criterion**: All 12 ADRs merged; §Budgets has no empty `[PLACEHOLDER]` rows gating Phase 1+
- **Spikes consumed**: none — Phase 0 produces all of S0.1–S0.12.
- **Decisions produced**: one ADR per spike (§5).

### Phase 1 — Engine core

- **Goal**: Precision + rendering in empty world.
- **Deliverables**: the frame chain (SSB → heliocentric → planet-centered inertial → planet-fixed rotating → local floating-origin scene) with f64 math in JS and f32 only at bounded local contact and final render upload; log depth AND floating origin per the S0.2 outcome; the S0.7 universe clock; worker layout; an empty-world scene covering the camera range the criterion demands; Playwright perf smoke from S0.11.
- **Exit criterion**: Camera flies 1 m → 1e10 m in Chrome + Firefox: no jitter, no z-fighting; shell transfer recorded
- **Spikes consumed**: S0.1, S0.2, S0.3 (shell row), S0.7, S0.11.
- **Decisions produced**: ADR GLSL-ShaderMaterial vs TSL (decided at project start — mixed usage across agent-written code is a renderer-compatibility hazard); ADR cross-origin isolation (COOP/COEP vs single-threaded workers — a written decision, never an accident); ADR worker layout; the COORDINATE_SYSTEM.md naming conventions (`Frame`, `toPlanetFixed`, `LocalScene`).

### Phase 2 — Earth data

- **Goal**: DSM/Zanzibar baked + streamed.
- **Deliverables**: the data pipeline — Geofabrik Tanzania pbf (timestamp recorded) → osmium bbox extracts → planetiler per-region PMTiles (pinned Protomaps profile) → GLO-30 DSM (WBM filter; sea flattened or the Indian Ocean is a numeric cliff) → delatin pre-baked terrain meshes → OSM2World building meshes → 3d-tiles-tools → 3D Tiles streamed by the 3d-tiles renderer; provenance rows + regeneration scripts in data/ per its README; MapLibre GL JS surface-map UI; LOD tier boundaries per region.
- **Exit criterion**: Player loads Dar es Salaam: OSM basemap + terrain + buildings streamed over range requests; payload + bake times recorded
- **Spikes consumed**: S0.3 (payload rows), S0.4 (data/ ledger rows + CI).
- **Decisions produced**: ADR terrain source + ocean policy; ADR LOD tier boundaries; ADR PMTiles serving config (CORS + range requests; never one giant archive).

### Phase 3 — Walk

- **Goal**: Character on real ground, single-player.
- **Deliverables**: Rapier KinematicCharacterController on real streamed terrain (local contact bubbles on Earth, Z-up gravity); position persistence across reload via Nakama storage (world-state schema gated by S0.7's clock decisions); the integrated-GPU baseline defined and recorded (fills B-VRAM-02); HUD strings land EN + sw in the same change via the S0.10 pipeline.
- **Exit criterion**: Walk Stone Town seafront inland on the dev box and the defined integrated-GPU baseline, with the frame rate recorded into B-FPS-01 tier B; position persists across reload
- **Spikes consumed**: S0.2 (baseline hardware), S0.3 (in-region payload), S0.10 (UI strings pipeline).
- **Decisions produced**: ADR character-controller parameters; ADR world-state persistence schema v1.

### Phase 4 — Car

- **Goal**: Vehicles + world interaction.
- **Deliverables**: Rapier DynamicRayCastVehicleController on real streets (suspension: stiffness, compression/relaxation, friction); a scripted-loop harness that records the driven path — the input S0.6's validator replays; vehicle persistence so rejoin finds it where left.
- **Exit criterion**: Scripted loop through Dar streets, suspension behaves; rejoin finds car where left
- **Spikes consumed**: S0.6.
- **Decisions produced**: ADR vehicle physics configuration; the server-validation contract ratified from S0.6's prototype.

### Phase 5 — Multiplayer

- **Goal**: 2+ players, server-authoritative.
- **Deliverables**: Go-runtime match handlers doing authoritative validation by versioned analytic coast, numerical powered flight and contact-kinematic replay with drift thresholds (no full server contact solver by design); prediction/interpolation tuned to the measured B-RTT rows; the Go AoI cell grid sized by the B-AOI rows; hosting region chosen from B-RTT/B-COST; explicit match snapshots for crash-resume (Nakama match state is in-memory, never auto-persisted); reconnect/rejoin recovery including the Caddy-reload WebSocket path.
- **Exit criterion**: Two browsers see each other interpolated; unvalidated positions rejected (drift measured); mid-session reconnect recovers
- **Spikes consumed**: S0.6 (validation contract), S0.8 (AoI sizing), S0.9 (region + cost).
- **Decisions produced**: ADR hosting region; ADR AoI cell size adopted; ADR drift thresholds; ADR snapshot/reconnect policy.

### Phase 6 — Voice

- **Goal**: Proximity voice behind CGNAT.
- **Deliverables**: self-hosted LiveKit with the Go runtime minting HS256 JWTs carrying room grants over RPC (no third-party Nakama-LiveKit plugin — the circulating URL is debunked); embedded LiveKit TURN with a real domain + CA cert (self-signed does not work); spatialization via RemoteAudioTrack WebAudio plugins into a PannerNode chain on the one shared AudioContext; Room.startAudio() inside a user gesture; speech preset + DTX; server-side RoomService mute only; proximity via subscription culling (fills B-AOI-04); push-to-talk default per B-CONST-07.
- **Exit criterion**: Positional hearing w/ attenuation; TURN-forced connection succeeds; server mute not bypassable
- **Spikes consumed**: S0.9 (TURN placement), S0.12 (voice policy).
- **Decisions produced**: ADR TURN topology (embedded vs coturn — coturn only if the 443 conflict is unsolvable); ADR voice consent/recording policy from S0.12; ADR proximity-culling parameters (measured).

### Phase 7 — Rocket

- **Goal**: Ascent + rails handoff.
- **Deliverables**: the in-house f64 Kepler/patched-conic module (GDCelestial, OrbitalObject3D and Principia as algorithm references only); ascent under f64 powered flight → analytic coast (`M = M0 + n·t`) handoff → descent, with the S0.7 warp semantics; a Dar-coast launch pad; the Python oracle (Skyfield + de440s.bsp, astroquery/Horizons at build time only — fixtures precomputed and committed).
- **Exit criterion**: Launch from Dar-coast pad, powered-flight→coast handoff without visible discontinuity, land back; ephemeris matches Python-oracle fixtures
- **Spikes consumed**: S0.7 (handoff design), S0.11 (golden fixtures).
- **Decisions produced**: ADR SOI handoff algorithm; ADR measured movement-regime thresholds; ADR launch-site and rails conventions; accuracy-envelope statement (±1 arcmin class is sky quality, not landing guidance — B-CONST-06).

### Phase 8 — Orbit & Moon

- **Goal**: Off-Earth bodies.
- **Deliverables**: the Moon at real scale (LOLA/SLDEM2015 + LROC WAC per DATA_SOURCES.md pins); lunar orbit → descent → walk; Earth-in-sky via astronomy-engine's topocentric Observer; lunar contact bubbles with atomic frame/ownership transfer; cross-SOI travel reusing the Phase 7 handoff.
- **Exit criterion**: Lunar orbit → descent → walk at real scale; Earth-in-sky correct via astronomy-engine
- **Spikes consumed**: S0.1 (frame chain off-Earth), S0.2 (planet LOD reuse), S0.11 (fixtures extended to the Moon).
- **Decisions produced**: ADR off-Earth data pins (Moon first, then per-body); ADR multi-world physics switching.

### Vertical Slice

- **Goal**: The promise, integrated.
- **Deliverables**: the integrated run — pad→walk→drive→launch→orbit→lunar landing alongside another player, with voice, EN + sw — exercised on a measured connection profile; attribution and credits screens in both languages; every §Budgets row the slice touches current.
- **Exit criterion**: Fresh browser: pad→walk→drive→launch→orbit→lunar landing alongside another player, with voice, EN + sw, on a measured connection profile
- **Spikes consumed**: none new — all Phase-0 outputs must be current.
- **Decisions produced**: ADR scope cut-line; success-definition sign-off against PROJECT_VISION.md.

### Alpha

- **Goal**: A world people can live in.
- **Deliverables**: kill -9 + snapshot recovery demonstrated; Postgres 16 backup/restore drill (pg_dump sidecar, rotation, offsite, recorded on video); the measured concurrent-player figure recorded in §Budgets; S0.12's compliance requirements enforced (consent, export, deletion, retention); attribution screens pass CI; Prometheus + Grafana (AGPL, unmodified image only) watching the Nakama gauges; Android re-test of the mobile-tolerant posture.
- **Exit criterion**: kill -9 + snapshot recovery; backup restore drill on video; measured concurrent-player figure; compliance + attribution screens pass
- **Spikes consumed**: S0.12 (compliance), S0.5 (name clearance before public launch), S0.9 (hosting sizing).
- **Decisions produced**: ADR retention schedule; ADR backup/restore + incident runbook; the measured capacity statement (a §Budgets row, not a marketing number).

### Solar System

- **Goal**: The neighborhood.
- **Deliverables**: Earth→Mars travel via patched-conic transfers (hapsira/pykep as planning oracles, off the critical path); Mars at real scale (MOLA + Viking MDIM + THEMIS per DATA_SOURCES.md pins); satellites via satellite.js against Horizons-derived fixtures (build-time only — never call Horizons from clients or the server at runtime); per-body data pins from the NASA PDS / USGS chain.
- **Exit criterion**: Earth→Mars travel; MOLA-sampled landing at real scale; satellites match Horizons fixtures
- **Spikes consumed**: S0.11 (fixture pattern extended), S0.1 (per-body frame chain).
- **Decisions produced**: ADR Mars data pins; ADR satellite propagation + fixture pipeline.

### Interstellar

- **Goal**: Beyond.
- **Deliverables**: a round trip that preserves persistence and clock consistency; the optional n-body mode (velocity-Verlet/DOP853 in f64, validated against external oracles only — REBOUND is GPL and stays out of the codebase) proven deterministic cross-platform before any of it touches the authoritative server.
- **Exit criterion**: Round trip preserves persistence + clock consistency; any n-body mode proven deterministic cross-platform before touching the authoritative server
- **Spikes consumed**: S0.11 (determinism regression), S0.7 (clock semantics).
- **Decisions produced**: ADR n-body integrator + oracle boundary; ADR authority gating for n-body mode.

## 5. Phase-0 spikes (S0.1–S0.12)

> **Phase-0 spikes (each = one ADR; the per-spike entries below name the §Budgets rows each fills, if any):** S0.1 coordinate/origin proof (1e7 m offset stability, f64/f32 boundaries) · S0.2 planet-LOD ADR (cube-sphere vs CDLOD, crack stitching, reversed-Z vs log-depth; measured frame rate on dev box + integrated baseline) · S0.3 load budget (per-package gz: three.js, Rapier WASM, nakama-js, livekit-client, KTX2/meshopt decoders, shell, one locale — replaces the 3–5 MB claim or withdraws it) · S0.4 license ledger completion + CI check · S0.5 "Kwetu" trademark search (TZ/Kenya class 9/41, WIPO/EUIPO/USPTO, domains, fallback names) · S0.6 server-validation prototype (recorded car path vs kinematic model, drift measured, contract written) · S0.7 time-warp/universe-clock semantics (TT/UTC, warp in shared space, handoff design) · S0.8 AoI micro-benchmark (synthetic presences vs cell sizes — measured tick cost only, no extrapolated promises) · S0.9 hosting + RTT probes (Dar/Zanzibar → eu-central/Cape Town/Nairobi; TURN placement; cost) · S0.10 UI stack (DOM vs canvas) + i18n pipeline + OFL font pick · S0.11 CI/testing (Playwright headless WebGL2, bitwise determinism regression, golden ephemeris) · S0.12 privacy/compliance checklist (PDPA 2022 / DPA 2019 / GDPR data map, retention, consent/export/deletion, voice policy).

Each spike lands exactly one ADR in docs/adr/ and either fills its named §Budgets rows with `[MEASURED date, method]` values or explicitly records why it fills none. A spike is done when its exit criterion is met — not when its write-up is drafted.

### S0.1 — Coordinate/origin proof

- **Question**: does the frame chain plus floating origin hold the world visually stable at planetary scale, where exactly does f64 end and f32 begin, and which Earth-fixed geodesy reference implementation anchors the planet-fixed frame?
- **Exit criterion**: an ADR recording measured stability at a 1e7 m offset (jitter quantified → B-PREC-01) and the verified f64/f32 boundary → B-PREC-02, backed by a committed test that fails if the rule (subtract large positions in f64, hand small deltas to renderer/physics) is violated — and recording the Earth-fixed geodesy reference-implementation decision (GeographicLib candidate, per COORDINATE_SYSTEM.md §5), including the site normal-gravity values, in the same ADR.
- **Fills Budgets rows**: B-PREC-01, B-PREC-02. The geodesy decision is ADR-only — no budget row (COORDINATE_SYSTEM.md gates its standard-gravity site values on this ADR).
- **Status 2026-09-06**: measured — [ADR-002](docs/adr/ADR-002-s01-frames-precision-rebase.md) accepted; B-PREC-01/02 filled and B-CONTACT-01…03 added (§3.8a). Committed f64-violation test lives in the throwaway probe suite (`tools/spikes/s0.1/`) until S0.11 re-homes it. **Open**: the geodesy reference-implementation half of the exit criterion was NOT resolved (ADR-002 Decision 6 — probe used the honest spherical model); it must land as its own decision record before Phase 2.

### S0.2 — Planet-LOD ADR

- **Question**: cube-sphere vs CDLOD; how are LOD cracks stitched; reversed-Z vs log-depth (with float32 depth evaluated)?
- **Exit criterion**: an ADR choosing the LOD scheme, the crack-stitching approach, and the depth strategy; frame rate measured on the dev box and a defined integrated-GPU baseline for the empty-planet tier → B-DC-01 / B-FPS-01 / B-VRAM-01 / B-VRAM-02.
- **Fills Budgets rows**: B-DC-01 (tier A), B-FPS-01 (tier A), B-VRAM-01 (tier A), B-VRAM-02.

### S0.3 — Load budget

- **Question**: what does the first visit actually weigh, per package?
- **Exit criterion**: every row in §3.1 (B-LOAD-01 … B-LOAD-10) carries a `[MEASURED]` gzip figure (method recorded), or an ADR formally withdraws the informal 3–5 MB claim; either way no load-size promise exists anywhere until this table is filled.
- **Fills Budgets rows**: B-LOAD-01 … B-LOAD-10.
- **Status 2026-09-06**: partial — B-LOAD-01, B-LOAD-02 measured; B-LOAD-07 partially (probe shell includes astronomy-engine + i18next, whose row placement is itself an open decision); B-LOAD-03…06 unmeasured (nakama-js, livekit-client, KTX2/meshopt not yet installed); B-LOAD-08…10 open. Method and per-package figures: `tools/spikes/s0.3/report.json`. **Open decision for a Phase-1 ADR**: Rapier WASM shipping config — compat build base64-inlines the WASM (1,088,335 B gzip) vs separate .wasm fetch (772,479 B reference, ≈ 316 KB cheaper but adds a request and needs its own caching path).

### S0.4 — License ledger completion + CI check

- **Question**: can every dependency and dataset ship under a license verified from its source at a pinned commit?
- **Exit criterion**: THIRD_PARTY_ASSETS.md, DATA_SOURCES.md and LICENSES.md rows for every named dependency, license fetched at the pinned commit (sidebar metadata has been wrong before: three-tile, OrbitalObject3D, delatin); recorded corrections stand (OSM2World is MIT, not LGPL; Rapier recorded Apache-2.0 only; PMTiles spec CC0); pending verifications explicitly marked (three-tile ≥0.10.3, delatin ISC, Rapier dual-license claim, JRC Surface Water wording, EOX Sentinel-2 prohibited regardless); a CI job fails the build on any dependency without a ledger row.
- **Fills Budgets rows**: none directly — but gates every dataset-phase row in §3.

### S0.5 — "Kwetu" trademark search

- **Question**: can the name ship?
- **Exit criterion**: an ADR recording search results for "Kwetu" in Tanzania and Kenya (classes 9 and 41), WIPO Global Brand Database, EUIPO and USPTO; domain availability check; a fallback-name shortlist; a dated go/no-go decision. No public use of the name before this closes.
- **Fills Budgets rows**: none (decision record, not a measurement).

### S0.6 — Server-validation prototype

- **Question**: can a Go-runtime validator accept or reject client positions without full physics, and with how much drift?
- **Exit criterion**: an ADR plus the written validator contract — a recorded car path replayed against the closed-form kinematic model, the drift distribution measured and recorded, and an explicit statement of what the server will NOT do (no server-side Rapier). NETWORKING.md must not promise server-authoritative physics beyond this contract.
- **Fills Budgets rows**: B-VAL-01, B-VAL-02 (created in §3.11a at ADR-007 landing; previously "the drift figures, recorded in the ADR").

### S0.7 — Time-warp / universe-clock semantics

- **Question**: who owns the one shared universe clock; how do TT and UTC relate (leap-second policy); how does warp behave in shared space; how do bodies hand off between physics and rails?
- **Exit criterion**: a measured verification ADR for ADR-001 clock authority, TT adapters, restart and shared-time semantics (CONTACT_LOCAL / FLIGHT_DYNAMIC / ORBIT_COAST, independent of clock speed), and the SOI handoff design — written well enough to gate NETWORKING.md and the world-state schema. A Phase-0 deliverable per COORDINATE_SYSTEM.md.
- **Fills Budgets rows**: B-TIME-01, B-TIME-02 (created in §3.8b at ADR-008 landing; the ADR flagged the addition — previously "none (semantics, not measurement)").

### S0.8 — AoI micro-benchmark

- **Question**: what does interest management actually cost per tick at candidate cell sizes?
- **Exit criterion**: an ADR plus measured per-tick cost for synthetic presences across candidate cell sizes → B-AOI-01 … B-AOI-03. Measured tick cost ONLY: the ADR must state that no player-capacity figure was extrapolated, and any sentence elsewhere deriving "supports N players" from this spike is a defect under §1.3.
- **Fills Budgets rows**: B-AOI-01, B-AOI-02, B-AOI-03.

### S0.9 — Hosting + RTT probes

- **Question**: where does the single monolithic Nakama node live, and what does that cost?
- **Exit criterion**: an ADR recording probe results run from Dar es Salaam and Zanzibar to eu-central, Cape Town and Nairobi → B-RTT-01 … B-RTT-08; the TURN placement decision (embedded LiveKit TURN with real domain + CA cert is the default; coturn only if the 443 conflict is unsolvable); monthly cost → B-COST-01 … B-COST-03; a verdict on the B-RTT-09 assumed access envelope.
- **Fills Budgets rows**: B-RTT-01 … B-RTT-09, B-COST-01 … B-COST-03.

### S0.10 — UI stack + i18n pipeline + OFL font pick

- **Question**: DOM or canvas for UI; does the PO→i18next pipeline hold; which OFL font covers Swahili fully?
- **Exit criterion**: an ADR choosing DOM vs canvas; the i18n pipeline (gettext PO source of truth → i18next JSON) demonstrated end-to-end with an EN + sw round trip in CI and the corrupted Plural-Forms header lint in place (nplurals=2 set explicitly); an OFL font with full Swahili coverage chosen and pinned.
- **Fills Budgets rows**: B-UI-01, B-I18N-01 (created in §3.12 at ADR-010 landing; previously "none (decision + pipeline proof)").

### S0.11 — CI/testing

- **Question**: can CI see the game at all, and can we prove determinism and ephemeris correctness mechanically?
- **Exit criterion**: CI running Playwright headless WebGL2 smoke tests on Chrome and Firefox; a bitwise determinism regression (same inputs → identical state hashes across platforms) wired to fail on divergence → B-EPH-02; golden ephemeris fixtures precomputed via Skyfield + Horizons (build-time, cached locally — never live in CI) committed and compared on every run.
- **Fills Budgets rows**: B-EPH-02.

### S0.12 — Privacy/compliance checklist

- **Question**: what does the law require of a multiplayer service with voice, under Tanzania's PDPA 2022, Kenya's Data Protection Act 2019, and GDPR?
- **Exit criterion**: an ADR plus a data map — what PII exists (accounts, text chat, voice), where it lives (Nakama storage, Postgres, LiveKit), the retention schedule, consent flows, export and deletion duties, and the voice recording/moderation policy — written as engineering requirements feeding NETWORKING.md and the Alpha compliance gate.
- **Fills Budgets rows**: none (policy, not measurement).

## 6. Risk register

Known gaps from the research phase, mapped to the spike or written decision that retires them, with the consequence of skipping each.

| # | Known gap / risk | Mapped to | Consequence if skipped |
|---|---|---|---|
| 1 | Initial-load figure asserted, never decomposed (the informal 3–5 MB guess — withdrawn, §3.1) | S0.3 | The core "browser on an East African link" promise ships unmeasured; Rapier + LiveKit alone plausibly consume the whole guess; found at Vertical Slice when re-architecture is unaffordable. |
| 2 | Integrated-GPU envelope uncharacterized (draw calls, VRAM, triangles) | S0.2 + §3.3 refresh per phase | LOD and asset pipeline tuned to the dev RTX box; target-laptop users get a slideshow; redoing LOD after Phase 3 is a rewrite. |
| 3 | No AoI, tick-cost, or capacity data anywhere | S0.8 | Multiplayer gates carry unsupportable concurrency promises; single-node Nakama limits met live in Phase 5 with no measured fallback. |
| 4 | Hosting region, latency and cost unknown | S0.9 | Region chosen on vibes; prediction aggressiveness, TURN placement and budget all wrong; re-migration after Phase 5 is a production incident. |
| 5 | Server-validation contract undefined | S0.6 | Docs promise server-authoritative physics the Go runtime cannot run; ships as either cheating or rubber-banding. |
| 6 | Clock policy accepted in ADR-001; adapters/restart and movement handoff unverified | S0.7 | World-state schema and netcode built on wrong time semantics; retrofit breaks persistence and every Phase 5+ replay. |
| 7 | Bitwise determinism and golden ephemeris unproven | S0.11 | Interstellar's determinism gate fails after years of accumulation; ephemeris bugs surface at the Phase 7 launch instead of in CI. |
| 8 | License ledger incomplete or unverified | S0.4 | A Havok-class trap (npm LICENSE says MIT, binary proprietary) ships; an unledgered dataset breaches the ODbL boundary; forced relicensing. |
| 9 | Trademark uncleared | S0.5 | Forced rename after public launch: docs, attribution, domains and community reworked. |
| 10 | PDPA 2022 / DPA 2019 / GDPR obligations unmapped | S0.12 | Voice recording and PII retention retrofitted post-Alpha; legal exposure in TZ/KE/EU; Alpha's compliance screen cannot pass. |
| 11 | COOP/COEP left undecided | Phase 1 ADR (written decision required) | Accidental SharedArrayBuffer dependency without a single-threaded fallback; Android re-test at Alpha fails for architectural reasons. |
| 12 | GLSL vs TSL mixed across agent-written code | Phase 1 ADR at project start | Renderer-compatibility hazard: shaders diverge by author, breaking under one renderer. |
| 13 | Godot-era residue re-imported (patterns, addons, precision=double advice) | §8 rule: no Godot anywhere | Wrong-platform patterns (double-precision engine builds, GDExtension) leak into web architecture; GPL-wall code gets copied. |
| 14 | Circulating "nakama-plugin-livekit" URL adopted | S0.4 ledger verification | Integrating a debunked, unsanctioned plugin; supply-chain and license risk; JWT minting belongs in the Go runtime. |
| 15 | Cloud-only voice features assumed (Krisp noise filter) | LICENSES.md incompatibility register | Depending on a LiveKit-Cloud-only feature in a self-hosted deployment; push-to-talk + client-side AEC/NS must carry the design instead. |
| 16 | Mobile scope drift (designing for phones implicitly) | Recorded decision: mobile-tolerant, not mobile-target | Budgets tuned to the wrong envelope; SharedArrayBuffer-requiring architecture ships; Android revisited only at Alpha, too late. |

## 7. Change control

1. **Tighten freely**: any exit criterion may be tightened at any time; record the change with a date in the phase's gate entry (§4).
2. **Loosen only by ADR**: relaxing an exit criterion, a hard invariant, or a rule in §1 or §3 requires a recorded ADR in docs/adr/ using its supersede semantics.
3. **Budgets rows**: filled only by the spike or phase named in their gate; a `[MEASURED]` row always cites date + method; rows are never deleted — a superseded row stays in place with a pointer to its replacement.
4. **Renumbering is forbidden**: phase and spike IDs are canonical identifiers used by other docs and ADRs; new spikes append as S0.13 and beyond.
5. **Tag discipline is a defect class**: an untagged performance assertion anywhere is a defect (§1.3); the review pass hunts for restated numbers and untagged claims.
6. **Mirrors reference, never fork**: MASTER_PROMPT.md section H (roadmap summary, DoD, risk register) and CLAUDE.md's pointer table must point at this document; the consistency critic checks phase numbering across the suite.

### 7.1 Change-control log

Each entry = a loosening or re-gate, with its recording ADR (rule 2). Tightenings are
recorded in the phase's gate entry and not listed here.

- **2026-09-06 — B-LOAD-07 definition revised.** The probed "app shell" figure includes
  three + Rapier compat + astronomy-engine + i18next; the pure app-TS+CSS figure moves
  to Phase 1 with the real build. Recording ADR: ADR-004 (Decision 4).
- **2026-09-06 — B-LOAD-09 method revised.** Total transfer = ADR-004 inclusion list
  (shell + Basis transcoder + locale), not a naive sum of rows 01–08 (double-counts).
  Recording ADR: ADR-004.
- **2026-09-06 — B-LOAD-02 shipping decision made** (compat build, base64-inlined);
  Phase-1 production confirmation pending; revisit trigger B-RTT-09 × B-LOAD-09.
  Recording ADR: ADR-004 (Decision 2).
- **2026-09-06 — B-LOAD-10 re-gated S0.3 → Phase 1.** A static byte probe cannot
  observe warm-cache behaviour; closes at the first real CDN/client-cache integration.
  Recording ADR: ADR-004.
- **2026-09-06 — B-AOI-03 re-gated S0.8 → Phase 5.** Requires a live Nakama node;
  a synthetic micro-benchmark cannot measure players-per-handler. Recording ADR: ADR-009.
- **2026-09-06 — S0.5 fallback-name shortlist deferred to the human trademark gate.**
  Drafting it before the manual BRELA/KiPI/WIPO searches would be decoration.
  Recording ADR: ADR-006 (Decision 3).
- **2026-09-06 — S0.9 (hosting + RTT probes) re-gated to the hosting decision
  (before Alpha).** The probes require physically-located vantage points (Dar es
  Salaam, Zanzibar) which no automated run can synthesize; B-RTT-01…09 /
  B-COST-01…03 stay empty until run for real. Recording ADR: ADR-013.
- **2026-09-06 — B-EPH-01 scope upheld, ADR-011's library residual NOT written into
  the row.** B-EPH-01 stays Phase-7-gated (our propagator vs fixtures); the
  astronomy-engine-vs-skyfield residual (0.345 arcmin Moon / 46.3 km) lives in
  ADR-011 and the golden fixture. Landing decision by the orchestrator.

## 8. Development environment & tooling

- **Host**: Windows 11. **WSL2 is the primary shell** — all pipeline, build and data work runs there; PowerShell is the fallback, not the home.
- **Docker Desktop** with the WSL2 backend runs the compose stack (Caddy, Nakama, Postgres, LiveKit, and later planetiler).
- **Node 24** for the client and build tooling. **Python 3.14** is the golden-test oracle environment (Skyfield + astroquery/Horizons; network at build time only, fixtures committed). Dependency/tool version pins live in the versions table in ARCHITECTURE.md, not here.
- **Blender 5.0 on PATH** — the asset pipeline (glTF-Blender-IO → glTF-Transform → gltfpack) starts with Phase 3 content work; KTX-Software 4.x binaries are consumed, never vendored (pin note in ASSET_STRATEGY.md).
- **Java 21+ or planetiler-in-Docker** is required by Phase 2 (planetiler), plus the osmium CLI for bbox extracts — install when Phase 2 starts if absent.
- **No Godot anywhere**: no Godot install, no GDExtension, no Godot-era code or patterns. Godot-ecosystem research findings (GDCelestial, OrbitalObject3D, Principia, Terrain3D, Swahili string corpora) are algorithm and reference inputs, re-expressed in our own words in the appropriate doc; GPL-wall projects (Celestia, Stellarium, Veloren, OpenMW) are study-only, and Gaffer on Games is link-only.
- **Disk**: dataset phases (2, 8, Solar System) want **~54 GB free** on the WSL2/data drive [PLACEHOLDER — gate: Phase 2 — recount from the pinned DATA_SOURCES.md dataset list; per-dataset sizes belong in those provenance rows, not here]. Check before starting Phase 2.
- **TLS from day one**: the microphone requires a secure context, so local development serves over TLS (Caddy's local CA); the "plain http:// dev server" shortcut is unavailable and must not be built around.
- **Commands**: intentionally placeholder until Phase 1 scaffolding exists; CLAUDE.md's commands section stays empty rather than inventing invocations.


## 9. Flight revision acceptance matrix — 2026-09-05

ADR-001 is an accepted design correction, not an executed spike. Existing phase IDs and budgets remain intact. This matrix adds required evidence to their gates; numerical limits must be measured and recorded by the named gate before acceptance.

| Gate | Additional required evidence | Failure prevents |
|---|---|---|
| S0.1 | Z-up fall/jump/vehicle axes; rebase with resting contacts and joints; two separated Earth locations; parent-relative exit velocity | Local contact architecture acceptance |
| S0.6 | Recorded car and powered-flight inputs; bounded server/client drift; forged thrust, fuel, stage and seat requests rejected | Shared vehicle authority |
| S0.7 | TT/UTC/provider adapters; leap boundary; wall-clock jump; restart/reconnect; coast/burn/contact/SOI transitions; one movement owner | Flight and durable trajectory schemas |
| S0.11 | Reference orbit conservation and return residuals; model-specific deterministic replay; position/velocity tolerances with units; no blanket bitwise JS/Go claim | Numerical correctness claim |
| Phase 7 | Staged rocket and reusable recovery configuration use the same component framework; fuel/mass/staging persistence; assisted pad landing and abort under stale clearance | Rocket completion |
| Phase 8 | Separate lander with distinct environment envelope; lunar descent/exit; coast continues on reconnect; no gravity-axis or reference-body discontinuity | Moon completion |
| Alpha | Duplicate stage/seat/dock commands; server restart during transactions; invalid saves and missing parents; passenger reconnect | Persistent fleet release |
| Solar System | Orbit-only cargo craft and runway shuttle as distinct capability configurations; docking and resource transfer; landing rejects unsupported bodies | Expanded fleet release |

Budgets to add as measured rows under §3 when their gates execute: local contact radius and error (S0.1), powered-flight integration/replay drift and CPU cost (S0.6/S0.7), landing envelope and collider preload lead time (Phase 7), and attachment/docking reconciliation error (Alpha). No numeric defaults from agent prose count as measurements. A release cannot claim all vehicle families merely because their definitions load.
