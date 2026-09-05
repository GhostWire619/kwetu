# Kwetu — Agent Contract (CLAUDE.md)

Operational contract for any AI agent working in this repo: pointers and invariants only. The deep docs own every fact — this file owns none of them. One sanctioned exception: the two invariant numbers below (the 1500 B wire cap — NETWORKING.md §4; three.js r168 — ARCHITECTURE.md §13) are quoted here on purpose as invariants, and they are the only numbers this file carries.

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

- Never install `@types/three` (three.js has bundled its own types since r168). Keep `moduleResolution` at `"bundler"` or `"node16"`.
- Simulation math is f64 in JS. f32 appears only at the last upload to the GPU, camera-relative.
- Logarithmic depth buffer AND floating origin, always both (log depth may be replaced only by the S0.2 outcome, recorded as an ADR per ROADMAP.md §7.2 change control). Enabling one without the other is a bug.

### Simulation and audio

- One Rapier world per celestial body — never one global world, never per region or tile.
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

Placeholder — filled in at Phase 1. Until then, do not invent scripts or flags. Phase-0 spike probes are expected and exempt — keep them throwaway under `tools/spikes/`; do not add named package.json scripts or CLI flags before Phase 1 scaffolding lands.

| Command | Purpose |
|---|---|
| `dev` | *(placeholder — fills in at Phase 1)* |
| `build` | *(placeholder — fills in at Phase 1)* |
| `test` | *(placeholder — fills in at Phase 1)* |
| `bake` | *(placeholder — regenerates `data/` artifacts; fills in at Phase 1)* |
| `golden-test` | *(placeholder — regenerates golden baselines; fills in at Phase 1)* |

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
| docs/swahili-i18n.md | Localization: keys, PO workflow, EN↔sw process |

## Verification discipline

- Before claiming a license: fetch the LICENSE file at the pinned commit and read it. GitHub sidebar metadata has been wrong before (three-tile, OrbitalObject3D, delatin).
- Before claiming a size: measure the actual artifact.
- Before claiming a version: check the registry at write time, not from memory.
- Tag quantitative claims `[MEASURED]` / `[EXTERNAL]` / `[PLACEHOLDER — gate]` (convention: `docs/adr/README.md`).

## When uncertain

Write an ADR draft in `docs/adr/` (`ADR-NNN-short-title.md`, format in `docs/adr/README.md`) and surface the open question — do not guess silently. An evidence-free ADR is a hypothesis, not a decision: leave it `proposed`.
