# Overnight run — 2026-09-06

Autonomous build night authorized by the user ("don't stop till you are done and the
game is running and working well"). This log records what ran, what measured, and what
still needs human eyes. Honesty rule unchanged: browser-tested-by-Playwright is
**not** human-verified; exit criteria stay "pending human confirmation" until a person
checks them.

## Environment (recon 21:30 UTC+3)

- Windows 11, Ryzen 7 7445HS (4c/8t), 15.2 GB RAM, RTX 4050 Laptop 6 GB (dev box ≠
  integrated-GPU target envelope; FPS claims tagged accordingly)
- Node 24.13.0, npm 11.6.2, Python 3.14.2, Java 17.0.18, Docker Desktop (installed,
  started), git-lfs 3.7.1, 59 GB free disk
- Browser floor for tests: Playwright 1.63.0, Chromium + Firefox

## Plan (phases, in order)

- **A. Infra** — Tanzania pbf (673 MB), 2× GLO-30 DEM tiles (S06/S07 E039), DE440s.bsp,
  npm deps (nakama-js 2.8.0, livekit-client 2.22.2, @playwright/test 1.63.0,
  i18next-conv 17.0.0), Playwright browsers, Docker images (nakama 3.37.0,
  postgres 16.8-alpine, caddy:2, livekit-server, planetiler, golang 1.24)
- **B. Phase-0 completion** — spikes S0.2, S0.3-rest, S0.4-ADR, S0.5, S0.6, S0.7,
  S0.8, S0.10, S0.11, S0.12 → ADR-003…ADR-012 + budget rows; centralized landing
  (ROADMAP/ledger/index edited only by the orchestrator)
- **C. Phase 1** — engine core: f64 frame chain, TT clock, floating origin LocalScene,
  log-depth renderer, planet LOD per S0.2, camera 1 m → 1e10 m, golden ephemeris
  fixtures vs skyfield oracle, Playwright no-jitter fly test (Chromium + Firefox)
- **D. Phase 2** — Earth data: planetiler Stone Town PMTiles, GLO-30 → delatin terrain
  meshes, buildings via OSM2World if Java path cooperates; pinned regeneration scripts
- **E. Phase 3+4** — Rapier KCC walk on real terrain (persistence across reload),
  raycast-vehicle scripted loop
- **F. Phase 5** — docker compose (Caddy ⇄ Nakama ⇄ Postgres), Go runtime built in
  golang container, two-browser presence test, server drift validation
- **G. Phase 6** — LiveKit + Go-minted JWT + PannerNode spatial audio; connection
  verified programmatically (headless audio limits honestly tagged)
- **H. Phase 7/8** — f64 conic solver, ascent → rails handoff, golden fixtures,
  Moon approach prototype
- **I. Integration** — `docker compose up` + dev server serve the game; README
  Running-it true; final push + morning report

## Progress log

- 21:30 recon done; Docker Desktop launching; downloads started
- 21:41 npm deps in (pbf 673 MB landed, DEM tiles 7.6/12.9 MB landed, de440s refetching
  via skyfield after NASA path 404)
- 21:50 ledger rows updated: code-04/05 pins filled, code-28 @playwright/test,
  code-29 i18next-conv added; delatin 0.2.0 (ISC) + geotiff 3.0.5 (MIT) installed
  as code-30/31; planetiler image digest pinned in code-08
- 21:55 .gitattributes LF pin added (closes the long-standing CRLF-warning debt);
  .gitignore: .bake/ + playwright artifacts
- 22:00 three jobs in flight: (1) Phase-0 spike workflow — 10 agents → ADR-003…012,
  (2) Phase-1 Part A workflow — engine math core (src/engine) + infra compose verified
  + GLO-30 terrain bake, (3) planetiler Dar+Zanzibar PMTiles bake (first attempt failed:
  OMT profile needs --download for aux sources — relaunched)
- (later) planetiler bake done: dar-zanzibar.pmtiles 63,203,540 B, bounds
  38.95,-7.05,39.6,-5.75, maxzoom 15 [MEASURED, 20 min 43 s wall]; STR-OMT credit
  obligation recorded in ATTRIBUTIONS.md
- (later) terrain bake done: stone-town.terrain.glb from GLO-30 via geotiff+delatin,
  433×361 grid, sea clamp <0 → 0, maxError 1.5 m [MEASURED, 3.6 s]
- (later) Part A landed and verified: engine math core moved to client/src/engine
  (f64 vec3, WGS84 geodesy, frame chain, LocalScene rebase + one Rapier bubble);
  141 tests green across 10 files; typecheck clean; ledger PASS 0 violations;
  infra stack verified live headlessly (postgres 16.8, nakama 3.37.0, caddy 2.11.4
  local-CA HTTPS, livekit 1.13.6; device-auth JWT through proxy + WSS upgrade OK).
  Committed 57be54a, pushed.
- (late) groundwork workflow launched: walk KCC + vehicle controller + f64 Kepler
  orbits — three renderer-independent modules in parallel (adversarial verify +
  fix rounds), write paths disjoint from the still-running Phase-0 spike workflow.
  Renderer (Part B) waits on the S0.2 outcome per night plan.

## 05:25 — ttClock promoted; Part B renderer launched
- **d86cdff**: ADR-008 open item closed — ttClock.ts + leap-seconds.json + test suite
  promoted to `client/src/engine/` / `tests/engine/` (content unchanged; spike dir keeps
  crossCheck + report writer; report.json untouched as the point-in-time record).
  tsconfig gains `resolveJsonModule` for the JSON import attribute. Gates: typecheck clean,
  29/29 clock tests, ledger PASS.
- **Part B renderer workflow launched** (bootstrap + log-depth/floating-origin camera rig,
  fly.pw.ts 1 m → 1e10 m in Chromium+Firefox, B-LOAD-09 built-shell measurement). Launched
  now rather than waiting on ADR-003: the exit-criterion flight does not depend on the
  planet-LOD mesh strategy; placeholder visuals are tagged [PLACEHOLDER — ADR-003].
- **Multiplayer/voice groundwork workflow launched** (ADR-007/ADR-009 landed → unblocked):
  Nakama Go runtime (match handler 20 Hz, AoI port with parity tests vs tools/spikes/s0.8,
  validator per ADR-007, healthcheck/world_time/voice_token RPCs, built in golang:1.24-alpine,
  plugin load verified in the live stack) + client net/voice modules (socket wrapper with
  transport seam, snapshot interpolation buffer, LiveKit voice client with the single-
  shared-AudioContext rule + push-to-talk default).
- Four workflows in flight: Night B (S0.2 measurement + ADR-003), groundwork
  (walk/vehicle/orbits), multiplayer/voice groundwork, Part B renderer.

## 05:50 — audit remediation landed
- **a8a121f**: three-lens audit of the Phase-0 landing pass triaged and remediated. Both
  blockers dismissed as concurrent-work false positives (server/runtime-go is Night F's
  authorized path; delatin/geotiff already ledgered code-30/31). 12 real findings fixed:
  ADR-003 reserved stub (gate arithmetic + broken link), B-VAL-02 relabeled dimensionless
  + B-VAL-03 split out, B-EPH-02 addendum, B-EPH-01 scope, S0.9 timing three-way aligned,
  S0.7/S0.11/S0.1 section-7.1 entries, ADR-009 cell corrections, license hedge, status
  vocabulary, s0.7 6.3 s note, writeReport .ts-import fix (Node TS runner) verified to
  regenerate byte-identical. Deferred to quiet machine: full S0.2 pass (CDLOD, silhouette,
  thrash fix) — concurrent load would distort the numbers.
- Night B workflow complete (S0.2 blocked by agent stalls → PARTIAL, all other spikes
  landed). Remaining in flight: groundwork (walk/vehicle/orbits), multiplayer/voice,
  Part B renderer — the game-running critical path.

## 08:10 — multiplayer/voice groundwork landed
- **541debd**: Night F workflow (5 agents, 651 tool calls) landed through the central
  gate. Go runtime: AoI port reproduces all three ADR-009 parity rows exactly; validator
  replays the recorded S0.6 sessions bitwise to B-VAL-01/B-VAL-02; 42/42 Go tests;
  deployed live (module + 3 RPCs + kwetu_world match registered). The crash-loop root
  cause is recorded in server/runtime-go/README.md: golang:1.24-alpine cannot load into
  nakama 3.37.0 (go1.25.5 host) AND -trimpath is mandatory — both failure modes measured.
  Client net/voice: 85/85 tests; the verify round caught the SDK spatial path producing
  NO audio without Track.attach() (fixed + regression-tested). Central fixes on landing:
  one-report-per-tick wire budget enforced in MatchLoop (was doc-only), cooldown made
  tick-based, stale ClientStateBytes comment (20→24), unset-env RPC test made
  deterministic. Infra: LIVEKIT_* wired into nakama; Caddy /livekit TLS signaling route;
  voice_token_rpc mints live (verified end-to-end: 3-segment JWT + reachable host);
  .so gitignored. Phase-5 remaining: match-create surface (no nk.MatchCreate wrapper
  exists), session wiring (serverKey, setSessionToken), two-browser e2e, aoi.ts/opcode
  re-homing into shared/ (task #35).

## 08:45 — Phase-1 Part B landed: the game runs
- **5706f57**: client bootstrap + renderer shell + camera rig + fly e2e. Real-scale Earth
  with Sun/Moon at real ephemeris positions (full Helio->Pci->PlanetFixed chain, TT-now);
  f64 canonical, f32 only at upload; log depth + floating origin both on; no Rapier in
  the shell. fly.pw.ts drives 11 log-spaced stops 1 m → 1e10 m through the real f64
  integration path in Chromium + Firefox — the Phase-1 exit criterion's automated
  portion; the human browser check remains the gate (SwiftShader ≠ fps evidence).
  Adversarial review caught two degenerate assertions (jitter check never ticked the
  world; flight never positively asserted) — fixed with world-ticked jitter + GPU
  pixel-delta signals ([MEASURED] altitude-banded baselines, tools/measure/
  gpu-stability.mjs) and integration-only stop assertions. B-LOAD-09 built shell
  597,993 B raw / 158,799 B gzip-9, Rapier-free [MEASURED]; first-visit total
  1,665,025 → 861,881 B provisional. dev/build wired (CLAUDE.md command table updated).
- Phase-1 exit criterion: automated portion green (typecheck 0, e2e 6/6, vitest 451 —
  6 orbits reds are the groundwork workflow's in-flight files, 1 s0.2 thrash deferred).
  Awaiting the human browser check (Chrome + Firefox, 1 m → 1e10 m, no jitter, no
  z-fighting, shell-transfer recorded).
- Remaining in flight: groundwork workflow (walk/vehicle/orbits — 6 orbits reds are its
  live fix rounds). Next after it lands: Night D Earth-data streaming into this shell.

## 09:45 — Groundwork landed: orbits recovered + walk/vehicle (Phase-2/3/4 core)
- **463497e**: walk KCC + persistence + vehicle controller (headless,
  renderer-independent). 35/35 at commit. Walk canonical position = f64 sum of
  f32 computedMovement offsets; CONTROLLER deviation 7.5e-4 m over 180 ticks
  [MEASURED], TRACKING error ~1e-15 class [DERIVED]. Vehicle:
  rapier3d-deterministic-compat 0.20.0 API facts measured from .d.ts —
  addWheel takes positional args (no WheelOptions); `setIndexForwardAxis`
  assigned as a property; VehicleTuning.rollInfluence is INERT (no JS setter,
  Rust default 0.1 applies). setSteer normalized; full lock 0.5 rad;
  setSteer(0.2) @ 19.1 m/s → +49.5°/1s throttle-held [MEASURED].
- **0d50387**: the orbits module, recovered centrally after the groundwork
  workflow stalled 6/6 attempts on it. All 6 failures diagnosed with a
  standalone f64 probe (vitest silences console.log):
  1. **Newton stall on long hyperbolic arcs is real** — the clamped closed-form
     guess (HYPERBOLIC_GUESS_Z_MAX=1e4) lands in the exp-dominated Stumpff
     region, F(guess) ~ 1e54 on a 20-day escape arc, Newton exits on
     stagnation after 2 iterations; the doc comment claiming "never observed"
     was falsified and rewritten. Fix: fallback bisection to full f64
     resolution (Number.EPSILON·|hi|; the old 1e-12·max(1,hi) stop measured
     6.9e-11 relative h drift) + stagnation-stopped min-|F| Newton polish →
     |Δh|/|h| = 1.75e-14 (bound 1e-12), |Δε|/|ε| = 3.7e-16.
  2. **Round-trip bound 1e-6 was below the f64 floor** — reconstruction
     accumulates O(10²–10³) roundings; n-splitting shows NO systematic term
     (wanders 1.1e-6..3.2e-6 vs n=1..64, non-monotone → per-solve rounding,
     not truncation); one-way vs 1000-step ref = 3.4e-7. Amended 5e-6 with
     derivation; measured envelope 0..1.44e-6.
  3. **Circular identity 1e-9 unachievable** — g = dt − χ³S/√μ is the
     difference of two ~√μ·dt terms; δg ~ few·ulp ≈ few·6e-12 s → δr ≈
     1.65e-8 m [MEASURED]. Amended 1e-7; test retitled to the
     g-cancellation floor.
  4. **Stumpff seam 1e-16 unachievable** — closed form's own (1−cos)
     cancellation floor ~2·eps/z ≈ 4.4e-14 at the seam; that is WHY the series
     branch exists. Amended 1e-13; measured ΔC = 5.7e-15.
  5. **Exact hyperbolic asymptote not f64-representable** — cos(acos(−1/e))
     reproduces −1/e only to a few ulps with uncontrollable sign; test now
     constructs ν ± 1e-9 from the asymptote (must throw above / must not
     throw below).
  6. **Kernel-analytic velocity was the wrong reference** — it is the
     Chebyshev fit's derivative, error class 2.5e-6..4.8e-6 m/s [MEASURED]
     (row 0 27% over, row 1 13% under its own (h²/6)·jerk prediction). Oracle
     now emits five-point stencil columns ([-r(t+2h)+8r(t+h)−8r(t−h)+
     r(t−2h)]/(12h), skyfield whole/fraction JD split for the instants);
     measured agreement (h²/6)·jerk ratios 0.9995 / 1.0000; fixture
     regenerated, kernel sha256 verified (c1c7fee…).
- Gates at 0d50387: typecheck 0; orbits 47/47; total 456/457 (the 1 red is
  the deferred S0.2 thrash probe, untracked); check:ledger PASS (3 warnings,
  0 failures).
- Next: Night D (Earth data streaming into the Part B shell), Night E (walk
  wiring + localScene unification), then the morning report.

## 10:55 — Playable surface integration verified
- Surface mode now loads the real Stone Town terrain GLB and builds a matching
  Rapier trimesh collider. The existing character and vehicle controllers share
  one fixed 60 Hz physics loop. Keyboard input covers walking, jumping, entering
  and leaving the nearby car, steering, braking, camera movement and reset.
- A Swahili-first HUD provides controls, mode, speed, help, credits and an English
  toggle. The surface mode is dynamically imported, so the physics runtime does
  not inflate the initial space-shell chunk.
- Region browser coverage now compares terrain triangles against the same camera
  pose in space mode and projects the tile anchor correctly. The real terrain-bake
  test has an explicit 60 s timeout, and the S0.2 quadtree thrash probe is green.
- Final local gates: typecheck PASS; Vitest 30 files / 461 tests PASS; Playwright
  10/10 PASS across Chromium and Firefox; production build PASS; license ledger
  PASS with 0 violations and 3 existing warnings. Build sizes: space shell
  685.39 kB raw / 185.63 kB gzip; separate surface chunk 2,922.77 kB raw /
  1,117.78 kB gzip. Integrated-GPU frame-rate evidence remains open.
