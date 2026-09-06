# Kwetu — Agent Contract (CLAUDE.md)

Operational contract for any AI agent working in this repo: pointers and invariants only. The deep docs own every fact — this file owns none of them. One sanctioned exception: the wire cap is quoted below; dependency versions and declarations are owned by ARCHITECTURE.md §13.

## What this project is

Kwetu ("our place") is an open-source, browser-based, persistent multiplayer digital universe: a real-scale Solar System with seamless walk → car → rocket → orbit → Moon travel, flagship Earth regions in East Africa, and Swahili as a first-class UI language. Scope, pillars, and non-goals: [PROJECT_VISION.md](PROJECT_VISION.md).

## Read order for a cold start

1. This file.
2. [MASTER_PROMPT.md](MASTER_PROMPT.md) — read Part A + Part G, plus the part matching the work you are implementing. It owns the DECIDED register, the reading protocol, and the fact-provenance tags.
3. [ROADMAP.md](ROADMAP.md) — the phase you are working in.
4. The doc that owns the subsystem you are touching (table below). **Never act on a subsystem without its owning doc.** If that doc does not exist yet, the subsystem does not either — do not build it from priors; raise it (see *When uncertain*).

## Hard invariants

Violating any of these is a bug, no matter what the surrounding code, task, or review says.

### Rendering and precision

- Use compatible pinned community Three.js declarations, including `@types/three` where required; verify core/addon imports in a strict typecheck (ARCHITECTURE.md §13). Keep `moduleResolution` at `"bundler"` or `"node16"`.
- Canonical frame and free-flight math use f64; bounded local Rapier contact and GPU upload are the explicit f32 boundaries.
- Logarithmic depth buffer AND floating origin, always both (log depth may be replaced only by the S0.2 outcome, recorded as an ADR per ROADMAP.md §7.2 change control). Enabling one without the other is a bug.

### Simulation and audio

- One bounded Rapier world per active local contact bubble; COORDINATE_SYSTEM.md §8 owns Z-up axes, gravity and rebase rules.
- Exactly one `AudioContext` for the whole app.

### Networking

- Network messages are ≤ 1500 B. Larger payloads are reduced by coalescing/delta/compression per NETWORKING.md §4; the cap never moves.

### Legal, licensing, data

- Never copy GPL/AGPL/NonCommercial/NoDerivs code or assets into the repo, even as a reference.
- Never reproduce Gaffer on Games text — link the article (NETWORKING.md curates the links), never quote it.
- Never strip Apache-2.0 license headers or the NOTICE file.
- Never commit to `data/` anything that is not regenerable by a pinned script and ledgered in DATA_SOURCES.md.
- Never add a dependency without a THIRD_PARTY_ASSETS.md row, with the LICENSE fetched at the pinned commit.

### Localization

- UI strings land EN + sw in the same change; no hard-coded English in components.

## Commands

App dev/build commands wired at the Phase-1 client entry — do not invent scripts or flags beyond what is listed here. Phase-0 tooling is wired as it lands: `typecheck`/`test` run the strict TS check and the vitest suites (including Phase-0 probe tests), and `check:ledger` enforces the THIRD_PARTY_ASSETS.md attribution gate — run it before any commit. Phase-0 spike probes are expected and exempt — keep them throwaway under `tools/spikes/`; do not add further named package.json scripts or CLI flags before Phase 1 scaffolding lands.

| Command | Purpose |
|---|---|
| `typecheck` | Strict TypeScript compile check (`tsc --noEmit`) |
| `test` | Run the vitest suites |
| `check:ledger` | Enforce the attribution ledger gate (tools/ledger/check.mjs) |
| `test:e2e` | Run the Playwright suites (Chromium + Firefox) |
| `bake:terrain` | Regenerate terrain meshes from Copernicus GLO-30 (tools/bake/terrain.mjs) |
| `bake:basemap` | Regenerate region PMTiles via planetiler (tools/bake/basemap.ps1, needs Docker) |
| `golden-test` | Regenerate the golden ephemeris baselines (tools/oracle/generate_golden.py, needs the DE440s kernel) |
| `dev` | Vite dev server for the client (`vite client --config vite.config.ts`, port 5199 — serves the shell at `/client/index.html` and the e2e fixtures) |
| `build` | Production client build (`vite build client --config vite.config.ts` → gitignored `build/shell/`; B-LOAD-09 measures it via tools/measure/shell-load.mjs) |

## Repo layout

- `docs/` — the deep docs below, plus `docs/adr/` for decision records (format: `docs/adr/README.md`).
- `data/` — the ODbL-1.0 data layer, licensed separately from the Apache-2.0 code; rules in `data/README.md`.
- `LICENSE`, `NOTICE` — Apache-2.0 for the code; the third-party ledger is LICENSES.md / ATTRIBUTIONS.md / THIRD_PARTY_ASSETS.md.
- Source and tool directories are laid down with the first code; the on-disk layout is owned by MASTER_PROMPT.md §42.

## Where facts live

Every fact has exactly one owning doc. If two docs disagree, the owner wins — then fix the loser. If a fact is not in one of these docs, it is not established: do not state it as fact.

| Doc | Owns |
|---|---|
| PROJECT_VISION.md | Product scope, pillars, non-goals |
| MASTER_PROMPT.md | What-and-why brief; the DECIDED register, reading protocol, fact-provenance tags |
| ROADMAP.md | ALL numbers — phases, spikes, gates, and every budget in §Budgets |
| ARCHITECTURE.md | System topology + version pins |
| COORDINATE_SYSTEM.md | Frames, precision, time |
| NETWORKING.md | Netcode + voice contract (including the 1500 B cap) |
| DATA_SOURCES.md | Datasets: sources, pins, provenance, regeneration |
| ASSET_STRATEGY.md | Art pipeline: sources, formats, optimization |
| LICENSES.md / ATTRIBUTIONS.md / THIRD_PARTY_ASSETS.md | Legal: code and dependency licenses, attribution strings, the dependency ledger |
| docs/VEHICLES_AND_FLIGHT.md | Vehicle capabilities, regimes, landing, docking, persistence contracts |
| docs/swahili-i18n.md | Localization: keys, PO workflow, EN↔sw process |

## Verification discipline

- Before claiming a license: fetch the LICENSE file at the pinned commit and read it. GitHub sidebar metadata has been wrong before (three-tile, OrbitalObject3D, delatin).
- Before claiming a size: measure the actual artifact.
- Before claiming a version: check the registry at write time, not from memory.
- Tag quantitative claims `[MEASURED]` / `[EXTERNAL]` / `[PLACEHOLDER — gate]` (convention: `docs/adr/README.md`).

## When uncertain

Write an ADR draft in `docs/adr/` (`ADR-NNN-short-title.md`, format in `docs/adr/README.md`) and surface the open question — do not guess silently. An evidence-free ADR is a hypothesis, not a decision: leave it `proposed`.
