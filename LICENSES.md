# LICENSES.md — licensing policy

**Status:** docs-first (pre-code). License verdicts were verified 2026-09-05 by
the project license sweep and are re-verified at every pin or version bump
(see §Verification).
**Companions:** [ATTRIBUTIONS.md](ATTRIBUTIONS.md) — exact strings, CI-checked ·
[THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md) — per-asset ledger and gate ·
[DATA_SOURCES.md](DATA_SOURCES.md) — dataset provenance rows ·
[data/README.md](data/README.md) — the `data/` directory rules.

Kwetu is a **three-layer** project. Each layer is licensed separately, and the
directory boundary enforces the split mechanically, not by convention:

| Layer | Where | License | Governed by |
|---|---|---|---|
| Code | everything except `data/` | Apache-2.0 | this file, [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) |
| Data | `data/` | ODbL 1.0 | this file, `data/README.md`, DATA_SOURCES.md |
| Assets | bundled models, textures, audio, imagery, generated meshes | per row | THIRD_PARTY_ASSETS.md, ATTRIBUTIONS.md |

## Code: Apache-2.0

Kwetu's code layer is licensed under the **Apache License, Version 2.0**. The
full text is in [`LICENSE`](LICENSE); the NOTICE file is [`NOTICE`](NOTICE).

Rationale, in order of weight:

1. **Explicit patent grant.** The project sits on WASM physics, GPU texture
   compression, tiled planetary-scale rendering and realtime networking.
   Apache-2.0 §3 grants an express patent license, which protects contributors
   and downstream users in a way MIT/BSD do not. For a codebase this
   graphics- and network-heavy, that is the decisive property.
2. **NOTICE convention feeds the attribution chain.** Apache-2.0 §4(c)–(d)
   give the project a standard NOTICE mechanism. Every third-party attribution
   obligation flows through `NOTICE` into the in-game credits screen and map
   footer — the exact strings live in ATTRIBUTIONS.md.
3. **Uniformity with the stack.** Nakama, Rapier, LiveKit and planetiler —
   the load-bearing server, physics, voice and tile-generation components —
   are all Apache-2.0. Matching the majority of the dependency set keeps the
   code compliance story to a single license.

## Contributions: DCO, not CLA

Contributions sign off via `git commit -s` (Developer Certificate of Origin,
https://developercertificate.org). No CLA.

## NOTICE policy

- Source files carry the Apache header (`SPDX-License-Identifier: Apache-2.0`
  plus the copyright line). Headers are **retained** — never stripped.
- **State changes when redistributing modified source.** If Kwetu ever
  redistributes modified third-party Apache-2.0 source, the modified files
  carry prominent notices of change (Apache-2.0 §4(b)) and the original
  attribution notices are preserved (§4(c)–(d)). Vendoring is the exception,
  not the habit — and the incompatibility register below names the items that
  must never be vendored at all.
- The root `NOTICE` points at this attribution triad; ATTRIBUTIONS.md is the
  string-level expansion of the NOTICE chain, and THIRD_PARTY_ASSETS.md is the
  row-level ledger behind it.

## Data layers: `data/` is ODbL 1.0

The `data/` directory is **ODbL 1.0**, deliberately separate from the
Apache-2.0 code layer.

Why: OpenStreetMap data is ODbL 1.0, and the things Kwetu builds from it —
generated `.pmtiles` vector tiles, OSM-footprint building meshes, terrain
rasters cut on OSM geometry — are **derivative databases**. ODbL's share-alike
obligation attaches to the **database**, not to the code that processed it.
The split is therefore a license fact, not a packaging preference: `data/` is a
**separate distribution, not a code-repo license question**.

Consequences:

1. `data/` content is never folded into the code layer, and code-layer
   licensing statements never describe data artifacts. The directory boundary
   enforces this mechanically.
2. Any distribution of a `data/` artifact ships the ODbL 1.0 full text plus
   the OSM attribution string (STR-OSM in ATTRIBUTIONS.md).
3. Every `data/` artifact is regenerable from a pinned build script plus a
   pinned source timestamp (`data/README.md`, rule 2). Regeneration, not
   redistribution, is the default way data content travels — generated
   binaries are not committed.
4. Full provenance rows (source, pinned version/timestamp, license,
   attribution string, build step) live in DATA_SOURCES.md.

## Assets

Bundled assets are licensed **per row** of THIRD_PARTY_ASSETS.md, with exact
strings in ATTRIBUTIONS.md. Two asset rules are already policy-level:

- **Quaternius packs are prototype-only** — upstream relicensed away from CC0
  (its Asset License v1.0 forbids standalone redistribution regardless of
  modification), so no Quaternius pack may be committed to the repo or
  redistributed standalone; individual assets may be used in-game only via
  their own per-asset ledger row (THIRD_PARTY_ASSETS.md — `asset-01` records
  the pack-level refusal).
- **Nothing NASA-identified ever renders** — insignia and logotypes are
  protected by US law regardless of any asset's stated license status
  (register rule R8 below; ATTRIBUTIONS.md §Forbidden).

## Incompatibility register

Hard rules. "Never" means never — no spike, no prototype, no "just for now".

| # | Item | Conflict | Rule |
|---|---|---|---|
| R1 | CDLA-Permissive × ODbL | Overture and other CDLA-Permissive sources cannot be mixed into OSM-derived layers: their obligations collide inside one derivative database | **Never mix Overture into OSM layers.** CDLA-Permissive content, if ever adopted, lives in its own separately-licensed layer |
| R2 | Havok physics WASM | Closed-source binary distributed via npm; the package's LICENSE file reads MIT, but the binary is governed by separate proprietary terms | **Keep Havok out of the bundle** even though its npm LICENSE reads MIT. Rapier is the physics engine |
| R3 | CockroachDB | Proprietary — not open-source | **Never vendor.** If a deployment ever runs it, it runs as an external service and never enters the repo or shipped artifacts |
| R4 | Grafana | AGPL-3.0 | **Run the unmodified official image** for observability. Never fork, patch, or copy Grafana code into the repo |
| R5 | MinIO | AGPL-3.0; project archived 2026-04-25 | **Skipped.** If S3 semantics are ever needed, use SeaweedFS instead |
| R6 | Cesium ion | ToS-gated hosted service — account terms, not an open license | **Do not adopt.** 3D Tiles come from Kwetu's own pipeline and public-domain NASA/USGS sources |
| R7 | Krisp noise filter | LiveKit-Cloud-only feature; absent from self-hosted LiveKit | **Not in scope.** Self-hosted voice ships without it; never bundle the filter SDK |
| R8 | NASA insignia / logotype | Protected by US law (14 CFR Part 1221, https://www.ecfr.gov/current/title-14/chapter-V/part-1221) **regardless of asset status** | **Never render** the insignia, the "worm" logotype, or mission logos anywhere in the project — see ATTRIBUTIONS.md §Forbidden |

## Verification procedure

1. **Fetch the LICENSE at the pinned commit** — not at `main`, not from a
   README, not from a registry summary — before a dependency or asset enters
   THIRD_PARTY_ASSETS.md. Record `license + version` and
   `verified date + method` in the row.
2. **Re-verify at every bump.** A version bump whose ledger row still shows
   the previous verification date fails review.
3. **Corrections already made during the 2026-09-05 research sweep**, recorded
   here so future sweeps do not regress them:
   - **OSM2World is MIT**, not LGPL as an early draft recorded.
   - **Rapier is recorded as Apache-2.0 only.** The dual "MIT OR Apache-2.0"
     claim could not be reconfirmed; Apache-2.0 is the operative verdict
     either way, and the ledger row says so explicitly.
   - **The PMTiles spec is CC0** — the library implementations are BSD-3.
   - **spacekit is MIT**, not Apache-2.0 as first recorded (not currently an
     adopted dependency; revisit if adopted).
   - **Quaternius has relicensed away from CC0** — its packs are therefore
     prototype-only (THIRD_PARTY_ASSETS.md, `asset-01`).
   - **osmium-tool is GPL-3.0**, not LGPL-2.1-or-later as first recorded —
     verified from the repo's LICENSE/README (the underlying libosmium is
     permissive Boost/BSL); build-time use only (THIRD_PARTY_ASSETS.md, note 1).
   - **delatin is ISC — settled 2026-09-05.** The upstream LICENSE lives on the
     `master` branch (`main` 404s, which broke the research sweep's fetches):
     https://raw.githubusercontent.com/mapbox/delatin/master/LICENSE —
     "Copyright (c) 2019, Michael Fogleman, Vladimir Agafonkin". Recorded in
     the ledger row (THIRD_PARTY_ASSETS.md, `code-11`); delatin is **not** a
     pending item.
4. Method tags follow house discipline: the initial sweep is tagged
   `[MEASURED 2026-09-05, license sweep]`; later entries carry their own date
   and method; unverified claims stay tagged `[PLACEHOLDER — gate]` or
   `[EXTERNAL url]` rather than silently upgraded.
5. **Pending verification (open items).** Claims below are not established;
   each stays `[PLACEHOLDER — gate]` in its ledger row until the named check is
   done:
   - **Hipparcos** (THIRD_PARTY_ASSETS.md, `data-07`) — the "ESA catalogue
     terms" verdict could not be traced to a primary source; verify the
     catalogue terms at CDS VizieR `I/239` before the first starfield build.

## Governance

- **Contributions:** DCO via `git commit -s`; no CLA (see above).
- **Trademark:** the "Kwetu" name and mark are an **open item, tracked under
  Phase-0 spike S0.5** (ROADMAP.md). No trademark claim is asserted anywhere
  in the project until that spike resolves; this document makes none.
- **Attribution-screen review:** before each release, the in-game credits
  screen and map footer are reviewed against ATTRIBUTIONS.md and the current
  THIRD_PARTY_ASSETS.md rows. A release whose attribution screen is stale
  fails the release checklist.
- **Doc precedence:** this file governs policy; THIRD_PARTY_ASSETS.md governs
  per-row verdicts; ATTRIBUTIONS.md governs exact strings. A ledger row that
  contradicts this file is invalid; a string that contradicts a row's license
  requirements escalates to this file.
- **Decisions:** reversals of license-policy decisions produce ADRs in
  `docs/adr/` with their evidence attached.
