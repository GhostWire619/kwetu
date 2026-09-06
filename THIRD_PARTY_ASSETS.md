# THIRD_PARTY_ASSETS.md — per-asset ledger (the gate)

**Status:** docs-first. Verdicts verified 2026-09-05 by the project license
sweep; pins land at the first code commit. **Companions:**
[LICENSES.md](LICENSES.md) — policy · [ATTRIBUTIONS.md](ATTRIBUTIONS.md) —
exact strings · [DATA_SOURCES.md](DATA_SOURCES.md) — dataset provenance rows.

## The gate

1. **An asset without a row may not be committed.** No exceptions — not for
   "just a prototype", "just a texture", "just a test scene", or
   CI-generated content. A commit containing an asset with no ledger row is a
   review failure.
2. **A row without an attribution string fails the build** (CI rule, stated at
   the top of ATTRIBUTIONS.md). Mechanically: the "attribution string
   required" column must be filled on every row — `y` points at an exact
   string in ATTRIBUTIONS.md; `n` records why no string is owed (license-text
   retention, CC0 voluntary credit, or a blocked verdict). An empty cell is
   what fails the build.
3. **A verdict is valid only for the pinned commit/tag.** Re-verify the
   upstream LICENSE at the new commit on every bump (LICENSES.md
   §Verification); a bump whose row still shows the old verification date
   fails review.

## Row format

Every ledger row carries:

| Field | Meaning |
|---|---|
| `id` | stable ledger id: `code-NN`, `asset-NN`, `data-NN`, `gen-NN` |
| `name` | package / product / pack name exactly as upstream spells it |
| `source URL` | canonical upstream — repo, site, or catalogue entry |
| `author` | copyright holder or author as upstream states it |
| `license + version` | SPDX identifier where one exists; exact license name where not |
| `files/sha256` | which files came from this row, and their hashes — the pin evidence |
| `how used` | where in Kwetu it appears (runtime, build-time, docs) |
| `attribution string required y/n` | `y` → an exact string must exist in ATTRIBUTIONS.md (CI-enforced) |
| `AI-generated model/version/prompt/date` | filled for generated assets only (§Generated assets); `n/a` otherwise |
| `verified date + method` | when the license was verified, and how |

The code-dependency table below is **pre-populated with a reduced view** of
the format (name, license, how used, pin, attribution, verified); the full
ten-field row — including `files/sha256` — is completed at pin time. Asset,
dataset, and generated rows carry the full format.

## Code dependencies

Pre-populated from the plan's verified verdicts. Each row carries license +
verified 2026-09-05 + pin. `[PLACEHOLDER — pin at first code commit]` means
the exact version/commit and `files/sha256` are recorded in the row when the
dependency is first committed.

| id | kind | name | license | how used | pin | attribution string required | verified |
|---|---|---|---|---|---|---|---|
| code-01 | code | three.js | MIT | WebGL rendering core | **0.185.1** (pinned exact in package.json) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (three.js authors); ships no .d.ts, see code-26 |
| code-02 | code | @dimforge/rapier3d-compat | Apache-2.0 | physics (WASM compat build) | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05 — recorded Apache-2.0 only; dual MIT OR Apache-2.0 claim could not be reconfirmed |
| code-03 | code | astronomy-engine | MIT | ephemeris: sun/moon/planet positions | **2.1.19** (pinned exact in package.json) | n — license text retained | 2026-09-05, license sweep + registry packument — note: the npm tarball ships no LICENSE file (upstream repo is the license source, https://github.com/cosinekitty/astronomy) |
| code-04 | code | @heroiclabs/nakama-js (npm scope; plain `nakama-js` 404s) | Apache-2.0 | Nakama browser client | **2.8.0** (pinned exact in package.json; `latest`, published 2024-06-21 — no npm release in 2+ years) | n — license text retained | 2026-09-05, license sweep + registry packument; 2026-09-06 — Apache-2.0 re-verified from GitHub LICENSE at tag v2.8.0 (the npm tarball ships no LICENSE file) + node_modules package.json license field |
| code-05 | code | livekit-client | Apache-2.0 | WebRTC voice client | **2.22.2** (pinned exact in package.json) | n — license text retained | 2026-09-05, license sweep; 2026-09-06 — node_modules LICENSE (Apache-2.0 text present) |
| code-06 | code | livekit server (self-hosted image) | Apache-2.0 | voice/chat SFU | [PLACEHOLDER — pin image digest at first deploy] | n — license text retained | 2026-09-05, license sweep |
| code-07 | code | i18next | MIT | runtime i18n (gettext PO as source of truth) | **26.4.2** (pinned exact in package.json; installed for the S0.3 load-budget spike, ARCHITECTURE.md §13) | n — license text retained | 2026-09-05 — registry packument (license field: MIT) + node_modules LICENSE (MIT text present) |
| code-08 | code | planetiler | Apache-2.0 | build-time vector-tile generation | image **ghcr.io/onthegomap/planetiler:latest**, digest sha256:db66b104ad08a7cde33ebbb9f371ab0ed2dbe62dc1daeb7a5179709257595e54 (pinned for the 2026-09-06 Stone Town bake; re-pin deliberately on refresh) | n — license text retained | 2026-09-05, license sweep; 2026-09-06 digest recorded from local Docker at bake time |
| code-09 | code | osmium-tool | GPL-3.0 | build-time OSM extract filtering | [PLACEHOLDER — pin at first code commit] | n — see note 1 | 2026-09-05 — GPL-3.0 verified from the repo LICENSE/README (the underlying libosmium is permissive Boost/BSL) |
| code-10 | code | OSM2World | MIT | build-time OSM building meshes | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05 — LGPL claim corrected (LICENSES.md §Verification) |
| code-11 | code | delatin | ISC | terrain mesh decimation | **superseded by code-30** (this row's placeholder pin never filled; the real pin lives there) | n — license text retained | 2026-09-05 — ISC verified from the upstream LICENSE, https://raw.githubusercontent.com/mapbox/delatin/master/LICENSE (the file lives on the `master` branch; `main` 404s). Row kept per the no-deletion rule; consolidated 2026-09-06 (ADR-005 open item 3) |
| code-12 | code | @NASA-AMMOS/3d-tiles-renderer | Apache-2.0 | 3D Tiles rendering in three.js | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-13 | code | maplibre-gl | BSD-3-Clause | map / vector-tile rendering | [PLACEHOLDER — pin at first code commit] | n — see note 2 | 2026-09-05, license sweep |
| code-14 | code | pmtiles | BSD-3-Clause | PMTiles reader/writer (the PMTiles spec itself is CC0) | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-15 | code | Skyfield | MIT | build-time ephemeris (Python oracle: golden fixtures, kepler fixture generation) | **1.55** (installed version, verified 2026-09-06; used by tools/oracle/generate_golden.py) | n — license text retained | 2026-09-05, license sweep; 2026-09-06 — version + license re-verified from installed package metadata (pip show) |
| code-16 | code | astroquery | BSD-3-Clause | build-time catalogue queries (Python) | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-17 | code | satellite.js | MIT | satellite TLE propagation | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-18 | code | gltf-transform | MIT | glTF asset pipeline | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-19 | code | meshoptimizer / gltfpack | MIT | mesh compression + packing | [PLACEHOLDER — pin at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-20 | code | KTX-Software | Apache-2.0 | KTX2/BasisU texture encoding | **4.x** — see note 3 | n — license text retained | 2026-09-05, license sweep |
| code-21 | model + weights | TRELLIS | MIT (incl. weights) | image-to-3D generation — preferred generator | [PLACEHOLDER — pin weights revision at first code commit] | n — license text retained | 2026-09-05, license sweep |
| code-22 | code (dev tooling) | typescript | Apache-2.0 | typechecker (`npm run typecheck`) | **7.0.2** (package.json carries `^7.0.2`; exact resolved recorded here) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (Apache-2.0 text present) |
| code-23 | code (dev tooling) | vite | MIT | dev server + production bundler | **8.2.2** (package.json carries `^8.2.2`) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (MIT) |
| code-24 | code (dev tooling) | vitest | MIT | test runner (`npm test`; also runs `tools/spikes/**` probes via `npx vitest run tools/spikes`) | **5.0.0** (package.json carries `^5.0.0`) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (MIT) |
| code-25 | code (dev types) | @types/node | MIT | Node declarations, scoped to tooling config + node-environment tests | **24.13.3** (package.json carries `^24.13.3`; matches the Node 24.13.0 dev host) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (MIT) |
| code-26 | code (dev types) | @types/three | MIT | three.js TypeScript declarations — three 0.185.1 ships **no** `.d.ts` (verified in node_modules at scaffold: no `types` field, no `types` export condition, zero `.d.ts` files) | **0.185.4** (package.json carries `^0.185.4`) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (MIT) |
| code-27 | code | @dimforge/rapier3d-deterministic-compat | Apache-2.0 | physics (WASM *deterministic* compat build — the target wherever cross-platform bitwise determinism matters, ARCHITECTURE.md §13; distinct package from code-02's general build) | **0.20.0** (pinned exact in package.json) | n — license text retained | 2026-09-05 — registry packument + node_modules LICENSE (Apache-2.0 text present) |
| code-28 | code (dev tooling) | @playwright/test | Apache-2.0 | browser e2e testing (S0.11; headless WebGL2 smoke, determinism e2e) | **1.63.0** (pinned exact in package.json devDependencies) | n — license text retained | 2026-09-06 — node_modules LICENSE (Apache-2.0 text present) + package.json license field |
| code-29 | code (dev tooling) | i18next-conv | MIT | gettext PO → i18next JSON compiler (docs/swahili-i18n.md pipeline) | **17.0.0** (pinned exact in package.json devDependencies) | n — license text retained | 2026-09-06 — node_modules LICENSE.md (MIT, Copyright (c) 2016 Jan Mühlemann) |
| code-30 | code (build tooling) | delatin | ISC | terrain mesh decimation (GLO-30 → walkable meshes, ASSET_STRATEGY.md) | **0.2.0** (pinned exact in package.json devDependencies) | n — license text retained | 2026-09-06 — node_modules package.json license field (ISC) + upstream LICENSE verified 2026-09-05 (LICENSES.md §Verification) |
| code-31 | code (build tooling) | geotiff | MIT | COG GeoTIFF reader for the DEM bake (GLO-30 tiles) | **3.0.5** (pinned exact in package.json devDependencies) | n — license text retained | 2026-09-06 — node_modules LICENSE (MIT text present) + package.json license field |
| code-32 | code (build tooling) | jplephem | MIT | DE440s BSP kernel reader behind the Python oracle (Skyfield dependency) | **2.24** (installed version, verified 2026-09-06) | n — license text retained | 2026-09-06 — installed package metadata (pip show, MIT); added at ADR-011 landing |
| code-33 | code (build tooling) | numpy | BSD-3-Clause (wheel license-expression: BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0) | array backend for the Python oracle | **2.4.4** (installed version, verified 2026-09-06) | n — license text retained | 2026-09-06 — installed package metadata (pip show, License-Expression recorded verbatim); added at ADR-011 landing |
| asset-01 | asset library | Quaternius | **NO — relicensed away from CC0** | none — prototype-only | — (no pack may be pinned) | n/a — blocked verdict | 2026-09-05, license sweep |
| asset-02 | asset library | Kenney | CC0 | prototype + final art packs | [PLACEHOLDER — pin pack/version at first use] | n — CC0, voluntary credit | 2026-09-05, license sweep |
| asset-03 | asset library | Poly Haven | CC0 | HDRIs, textures, models | [PLACEHOLDER — pin pack/version at first use] | n — CC0, voluntary credit | 2026-09-05, license sweep |
| asset-04 | asset library | ambientCG | CC0 1.0 | PBR textures | [PLACEHOLDER — pin pack/version at first use] | n — CC0, voluntary credit | 2026-09-05, license sweep |

Notes:

1. **osmium-tool is invoked at build time only.** GPL-3.0 does not contaminate
   the tiles produced with it — running a GPL tool on data does not license the
   output. Never link osmium/libosmium code into Kwetu or ship the tool inside
   an artifact; keep its license notice with the build documentation. If it is
   ever distributed (for example inside a published CI image), full GPL-3.0
   compliance applies.
2. **maplibre-gl ships a combined, multi-license LICENSE.txt** covering it and
   its bundled components. Copy the file **wholesale** into distributions —
   never excerpt it.
3. **KTX-Software (pin 4.x):** the upstream repo contains one non-open
   Ericsson file. Consume release **binaries**; never vendor the source tree
   into the repo.
4. **Quaternius verdict (`asset-01`) is a recorded refusal:** upstream
   relicensed away from CC0, so the packs are prototype-only. A Quaternius
   pack committed to the repo fails review; the row exists so the refusal
   survives staff turnover.
5. **spacekit**, if ever adopted, is recorded **MIT** — the research sweep
   initially recorded Apache-2.0 and the claim was corrected
   (LICENSES.md §Verification).
6. "n — license text retained" means no display string is owed, but the
   license text must be retained and flow through the NOTICE chain
   (LICENSES.md §NOTICE policy).

## Datasets

Full provenance rows — source, pinned version/timestamp, license, attribution
string, build step — live in **DATA_SOURCES.md** (`data/README.md`, rule 1);
that file is authoritative for pins. This section records the license shape
only, so the ledger answers "what do we owe whom" without opening the
provenance file.

| id | dataset | license | attribution string | notes |
|---|---|---|---|---|
| data-01 | NASA PDS / USGS PD chain (LRO LOLA, MGS MOLA, SLDEM2015, LROC WAC, planetary imagery) | Public domain (US government work) | STR-NASA — acknowledgment, not a license debt | No share-alike; the non-endorsement sentence is mandatory (ATTRIBUTIONS.md §Forbidden) |
| data-02 | OpenStreetMap via Geofabrik extracts | ODbL 1.0 | STR-OSM + STR-GEOFABRIK | Derivative-database rule: outputs live in `data/`, licensed ODbL (LICENSES.md §Data layers) |
| data-03 | Copernicus (Sentinel + Copernicus DEM GLO-30) | Copernicus data terms — **no SPDX identifier** | STR-COPERNICUS `Contains modified Copernicus data [year]` | The non-SPDX string is the required credit — Sentinel products and the GLO-30 DEM alike |
| data-04 | Unicode CLDR | Unicode License V3 | n — license text retained | Locale data incl. Swahili |
| data-05 | Wikidata | CC0 1.0 | n — CC0, voluntary credit | |
| data-06 | GeoNames | CC BY 4.0 | y — attribution string to be added with the first GeoNames row (per GeoNames CC BY 4.0 terms, with the pinned dump date) | Gazetteer |
| data-07 | Hipparcos (ESA) | [PLACEHOLDER — verify catalogue terms at CDS VizieR I/239 at pin] | y — lands in the CI-generated table (ATTRIBUTIONS.md) | Star catalogue; 2026-09-05 — license not yet verified (pending in LICENSES.md §Verification) |

## Generated assets (AI provenance)

1. **Every generated asset gets a `gen-NN` row**, and its AI columns — model,
   version, prompt, date — are mandatory, never `n/a`. The prompt is recorded
   in full (inline or as a referenced prompt file). A generated asset whose
   row cannot answer "which model, which version, prompted with what, on what
   date" may not be committed (§The gate, rule 1).
2. **TRELLIS is the preferred generator** — MIT including weights, so model,
   weights, and outputs impose no additional distribution constraints, and
   outputs are Kwetu content with no third-party license attached.
3. **Hunyuan3D is constrained.** Its community license: (a) excludes the
   **EU, UK, and South Korea** from the grant; (b) caps use at **1M monthly
   active users**; (c) forbids **training on outputs** ("no-output-training").
   Hunyuan3D-derived assets may ship only within those limits and must never
   become training data. If Kwetu exceeds the MAU cap or ships to an excluded
   territory, Hunyuan3D-derived assets are replaced. TRELLIS is preferred
   precisely to avoid carrying this row's constraints.
4. **AI-generated planetary surfaces are Kwetu's own content.** Never present
   them as NASA/USGS data or "according to NASA"
   (ATTRIBUTIONS.md §Forbidden).

Ledger (empty until first generation):

| id | asset | model + version | prompt (ref) | generated | output license | files/sha256 |
|---|---|---|---|---|---|---|
| *(none yet)* | | | | | | |

Template row (shape only — not a real asset):

```text
| gen-01 | crater_rim_rocks.glb | TRELLIS <version> (MIT) | prompts/gen-01.txt | 2026-mm-dd | Kwetu content — no third-party license | files/… sha256:… |
```
