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
