# DATA_SOURCES.md — dataset provenance ledger

> Status: docs-first, pre-code. The pipeline described here is scheduled in
> `ROADMAP.md` (Phase-0 spikes, Phase-2 data pipeline); no artifacts exist yet.
> Companion files: `LICENSES.md` (license policy and verdicts),
> `ATTRIBUTIONS.md` (the exact attribution strings), `THIRD_PARTY_ASSETS.md`
> (code libraries and art assets), `data/README.md` (the ODbL layer boundary),
> `NOTICE` (top-level notices). This file covers **datasets only**.

Every dataset Kwetu ingests — a server-side build input or a client-shipped
artifact — gets a row in the provenance table below. The table is the gate:

**A dataset not in this table may not be used.** Not for prototyping, not "just
to try it", not in a spike that might ship.

Quantitative claims carry the house tags. The suite-wide vocabulary is
canonical in `ROADMAP.md` §1.1 (mirrored in `docs/adr/README.md`); this file
adds one dataset-specific tag rather than reusing the canonical
`[EXTERNAL url]`, which means verified-from-primary-source:

- `[MEASURED @ date]` — verified by us (downloaded, ran, counted); a date is
  attached wherever the value can drift.
- `[REPORTED — unverified in-repo]` — from provider documentation or community
  sources; not verified by us. When a primary source is fetched and pinned by
  URL, the claim graduates to the canonical `[EXTERNAL url]`.
- `[PLACEHOLDER — gate]` — must be pinned by a named Phase-0/Phase-2 spike or a
  build run before anything downstream relies on it.

License verdicts were verified in the 2026-09 license research pass and are
recorded in `LICENSES.md`. This file records *which* license a dataset carries
and what that license forbids for us; `ATTRIBUTIONS.md` carries the exact
strings, and this file never restates them (the one exception: a string that is
itself load-bearing content, marked as such below).

## The provenance table

Adding a row is a PR that also adds the license verdict (`LICENSES.md`) and the
attribution string (`ATTRIBUTIONS.md`). Generated artifacts enter `data/` only
from rows in this table (`data/README.md`, rule 1).

Checklist for a new row:

1. license verdict in `LICENSES.md` — including ODbL compatibility if anything
   it touches will land in `data/`;
2. exact attribution string added to `ATTRIBUTIONS.md`;
3. row added here, with a build step and a refresh cadence;
4. prohibited-list check (see Moon & planets below) — NC / ND / SA and
   law-protected marks do not get a row, they get a refusal;
5. only then: code.

### Format

| dataset | version/date pinned | source URL | license | exact attribution string | derived artifacts | build step | refresh cadence |
|---|---|---|---|---|---|---|---|

Column notes:

- **dataset** — canonical name plus the exact file or product fetched.
- **version/date pinned** — whatever identifies the exact bytes: a published
  timestamp, a product version, a dump date. A filename containing `latest` is
  never a version; pin the timestamp inside the file.
- **source URL** — the URL actually fetched, including which mirror we chose.
- **license** — the SPDX identifier where one exists; otherwise the license's
  own name plus an explicit note that it has no SPDX id. ODbL-flagged sources
  imply their derivatives live in `data/` (see `data/README.md`).
- **exact attribution string** — an anchor into `ATTRIBUTIONS.md`
  (preferred form: `→ ATTRIBUTIONS.md#<slug>`) or the byte-exact string.
  Slugs are explicit HTML anchors (`<a id="…"></a>`) placed above each STR
  heading in `ATTRIBUTIONS.md` — short stable names (`osm`, `geofabrik`,
  `copernicus-dem`, `nasa`, `natural-earth`), not the auto-generated heading
  slugs; a `ATTRIBUTIONS.md#<slug>` link must point at an anchor that exists.
  `ATTRIBUTIONS.md` is canonical; an inlined copy must be kept byte-identical.
  Never paraphrase an attribution string.
- **derived artifacts** — what we build from it, so contamination stays
  traceable end to end.
- **build step** — the pinned script path plus the section of this file that
  specifies the pipeline. Script paths are pinned when the pipeline lands.
- **refresh cadence** — upstream publication rhythm plus our refresh policy.
  A refresh produces a new row version, never a silent overwrite.

### Filled example row

| dataset | version/date pinned | source URL | license | exact attribution string | derived artifacts | build step | refresh cadence |
|---|---|---|---|---|---|---|---|
| OpenStreetMap planet extract — Geofabrik Tanzania, `tanzania-latest.osm.pbf` | the `.pbf`'s own timestamp, read at fetch with `osmium fileinfo` (the `osmosis_replication_timestamp` metadata item) and recorded into every derived artifact's provenance record — the filename says `latest`, the timestamp is the version. First pin: 2026-09 download, 672 MB [REPORTED — unverified in-repo]; re-verified on every refresh | `https://download.geofabrik.de/africa/tanzania-latest.osm.pbf` (`.md5` alongside); daily change files under `https://download.geofabrik.de/africa/tanzania-updates/` | ODbL 1.0 — all derivatives live in the `data/` layer (`data/README.md`) | © OpenStreetMap contributors — canonical copy: `ATTRIBUTIONS.md#osm`, keep byte-identical | per-region `.pmtiles` basemap tiles; OSM2World building meshes; footprint-flattened terrain rasters; `name:sw` cross-check layer (Toponyms) | pinned fetch script → `osmium extract --bbox` (Earth vector) → planetiler (Earth tiles); script paths pinned when the Phase-2 pipeline lands [PLACEHOLDER — gate] | daily upstream; refresh per region release, rolling forward from the pinned timestamp with the daily `.osc.gz` change files where practical |

Kenya regions use the same row shape against
`https://download.geofabrik.de/africa/kenya-latest.osm.pbf`; that row is added
when the first Kenya region is adopted.

## Earth vector

**Sources.** The Geofabrik country extracts (filled example row above; Kenya
likewise). The full-country `.pbf` is the pinned source of record; per-region
extracts are derived artifacts.

**Why per-region extracts.** planetiler build time scales with input size.
Building the whole of Tanzania in one job is hours-scale; per-region extracts
keep each build at minutes-scale. Regions are named bboxes in a pinned manifest
(planned `tools/data-pipeline/regions.toml`), starting with `dar-es-salaam`,
`zanzibar-stone-town` (Unguja), `pemba`, plus the Kenya regions as adopted.
Bbox values are pinned facts, reviewed like any other parameter.

**Extract discipline.**

- `osmium extract --strategy=complete_ways --bbox=<manifest bbox>` — complete
  ways keep referenced nodes, otherwise building meshes shear at region seams.
- Extract bboxes carry a margin (coastal multipolygons and land/sea relations
  cross arbitrary bbox edges); the margin is part of the pinned manifest.
- Every extract records: source row, source `.pbf` timestamp, manifest
  revision, output checksum. Extracts are regenerable by construction.

**ODbL note.** Extracts, tiles, meshes and rasters built on OSM geometry are
derivative databases. They live in `data/` under the separately licensed ODbL
layer (`data/README.md`) and are never folded into the Apache-2.0 codebase.

## Earth tiles

**Tool.** planetiler — Apache-2.0. Runs on Java 21+ or via Docker. Pin the
planetiler release and the Protomaps **basemap** profile together, and pin the
Java/Docker image digest alongside them. The style JSON the map client consumes
must match the pinned profile — the style is itself a derived artifact.

**Resource guidance.** planetiler needs roughly 0.5x the input size as RAM and
5–10x the input size as scratch SSD [REPORTED — unverified in-repo]. Against the 672 MB whole-country
file that is ~340 MB RAM and ~3.5–7 GB SSD [REPORTED — unverified in-repo]; a per-region extract is
far smaller on both axes. These are build-resource guidance, not performance
budgets — budgets live in `ROADMAP.md` §Budgets; gate the measured figures in
the Phase-2 build run [PLACEHOLDER — gate].

**Serving requirements (hard).** PMTiles is read over HTTP byte ranges. The
serving host must support range requests (`Accept-Ranges: bytes`) **and** CORS.
Object storage (S3-compatible) works; naive static servers that ignore Range
headers do not. Serving is part of the pinned infrastructure config, not an
afterthought.

**Never one giant Tanzania archive.** Clients are low-bandwidth by assumption.
A player standing in Stone Town must download megabytes, not a whole-country
archive. The per-region payload budget is owned by `ROADMAP.md` §Budgets
(`B-REG-02`) — no size is set here; the region manifest defines the split.

**Build record — first regional bake [MEASURED 2026-09-06].**

- Script: `tools/bake/basemap.ps1` (`npm run bake:basemap`); planetiler image
  digest pinned in `THIRD_PARTY_ASSETS.md` (code-08).
- Input: Geofabrik `tanzania-latest.osm.pbf`, downloaded 2026-09-06, 673 MB
  (the extract's own replication timestamp is not yet recorded — record it at
  the next refresh per the reproducibility rule).
- Profile: planetiler's default **OpenMapTiles** profile (aux sources fetched
  with `--download`) — *not* the Protomaps basemap profile named above.
  Consequences recorded: the OMT tile schema carries the visible-credit
  obligation `© OpenMapTiles` (STR-OMT, `ATTRIBUTIONS.md`). The Protomaps
  profile decision is reopened by this bake's evidence — OMT gives MapLibre
  style-schema compatibility out of the box; the final profile call lands with
  the Phase-2 row revision, and any profile switch bumps the artifact row
  version and swaps the style JSON.
- Output: `.bake/pmtiles/dar-zanzibar.pmtiles` — 63,203,540 B, bounds
  38.95,-7.05,39.6,-5.75, maxzoom 15; wall time 20 min 43 s on the dev box
  (4c/8t, `-Xmx5g`).
- Location: `.bake/` is gitignored by design; the artifact is regenerable by
  the pinned script and is published per `data/README.md` when distributed.

## Earth elevation

**Primary source: Copernicus DEM GLO-30.**

- **It is a DSM, not a DTM.** GLO-30 is an X-band radar surface model
  (TanDEM-X-derived): buildings and trees are baked into the ground heights. At
  street level in Stone Town the "ground" is rooftops. Mitigation is mandatory,
  not optional: filter water bodies with the product's own WBM (water body
  mask) layer, and flatten the surface around OSM building footprints and road
  geometry from the pinned extract. Footprint-flattened rasters are ODbL
  derivatives → `data/`.
- **NO ocean tiles.** GLO-30 has no bathymetry, and its offshore treatment
  (masked voids, zero-filled patches) is inconsistent at the coast. Uncorrected,
  the Indian Ocean renders as a numeric cliff beside a flat sea plane. Rule:
  never ingest offshore cells; clamp/flatten everything seaward of a pinned
  land/sea mask (OSM coastline) to a flat mean-sea-level plane. The same
  treatment applies to Lake Victoria in the Kenya regions.
- **License.** Not an SPDX entry — the Copernicus DEM licence is a custom terms
  document. Required attribution is the exact string
  `Contains modified Copernicus data [year]` (year filled per artifact; the
  canonical form lives in `ATTRIBUTIONS.md#copernicus-dem`). The exact
  producer-credit line is pinned from the Copernicus DEM EULA at the first
  data build [PLACEHOLDER — gate: Phase 2] and lands once in
  `ATTRIBUTIONS.md` — not per tile.
- **Vertical datum.** GLO-30 heights are referenced to EGM2008 [REPORTED — unverified in-repo];
  SRTM to EGM96 [REPORTED — unverified in-repo]. Pick one vertical datum per artifact and record any
  conversion in the build step — silent mixing shifts coastlines by metres.
- Sources: Copernicus Data Space Ecosystem (`https://spacedata.copernicus.eu`);
  AWS Open Data mirror `s3://copernicus-dem-30m`
  (`https://registry.opendata.aws/copernicus-dem/`).

**Build record — first terrain bake [MEASURED 2026-09-06].**

- Script: `tools/bake/terrain.mjs` (`npm run bake:terrain`).
- Input: 2× Copernicus GLO-30 tiles (S06/E039 + S07/E039, covering the
  Stone Town bake extent), fetched 2026-09-06 from the AWS Open Data mirror.
- Pipeline: geotiff → delatin mesh; sea rule applied at bake time (all cells
  < 0 m clamped to 0 — the no-ocean-tiles rule above); maxError 1.5 m.
- Output: `.bake/meshes/stone-town.terrain.glb`, 433×361 grid, plus a bake
  manifest. Wall time 3.6 s.
- **Known gap, honestly:** the mandatory DSM mitigation (WBM water filtering +
  footprint flattening around OSM buildings/roads) is NOT yet in this
  pipeline — Stone Town rooftops are baked into the current mesh. Tracked for
  the Phase-2 pipeline revision; until then the mesh is fit for
  renderer-mechanics testing, not for final terrain.
- Gitignored; regenerable by the pinned script.

**Cross-checks and fallbacks.**

- **SRTM** (NASA) — public domain. C-band radar reflects from canopy and roofs,
  so heights run high under forest and dense settlement [REPORTED — unverified in-repo]. Cross-check
  and gap-fill only, with the datum mix recorded explicitly. Source: USGS
  EarthExplorer (`https://earthexplorer.usgs.gov/`).
- **GEBCO_2026** — public-domain-style open data with a requested attribution
  (GEBCO Compilation Group). ~15 arc-second grid, ~465 m at the equator
  [REPORTED — unverified in-repo]. The right tool for the Zanzibar Channel and the Pemba shelf —
  bathymetric context — and useless for reef-scale swimming: one cell is wider
  than a reef. Source:
  `https://www.gebco.net/data_and_products/gridded_bathymetry_data/`.
- **Mapzen terrarium tiles** (AWS Terrain Tiles,
  `https://registry.opendata.aws/terrain-tiles/`) — public domain, but a frozen
  ~2018 snapshot that will never be refreshed. Prototyping only; never ship as
  final terrain.

## Earth 3D buildings

**Toolchain.** OSM region extract → **OSM2World** → glTF → **3D Tiles** →
streamed into the three.js client.

- **OSM2World** is **MIT**-licensed. The circulating claim that it is LGPL is
  wrong (verified against upstream in the 2026-09 research pass; verdict in
  `LICENSES.md`). Its meshes are ODbL derivatives of the OSM input → `data/`.
- **3D Tiles conversion** via `3d-tiles-tools` (Apache-2.0): glTF/GLB assets
  tiled into a `tileset.json` archive.
- **Streaming** via NASA-AMMOS `3d-tiles-renderer` (Apache-2.0) inside the
  client. Code dependencies are tracked in `THIRD_PARTY_ASSETS.md`, not here.

**Content hazard — read before promising detail.** Tanzanian OSM coverage of
`height`, `building:levels` and `roof:shape` is sparse. Expect many flat or
procedurally simplified blocks. Before any region promises 3D detail, run the
tag-density check for that region (counts of `height`, `building:levels`,
`roof:shape` over `building=*` objects) and record the percentages in the
region manifest [PLACEHOLDER — gate]. The promise follows the numbers, not the
wish.

**Non-option: Cesium ion OSM Buildings.** ToS-locked and non-redistributable;
an ion-hosted tileset cannot ship inside an open, self-hosted client.
**Self-host always.** No ion tokens ship in the client, ever.

## Building-footprint fallbacks (hazards)

Fallback footprint sources fill gaps where OSM building coverage is thin. Both
candidates below get a table row first and code second.

- **Google Open Buildings v3** — CC BY 4.0, **but** the accompanying terms
  restrict ML training on the dataset. Fine for rendering (footprints and
  extrusion hints as fallback geometry where OSM is sparse). Any future feature
  that trains on city data needs legal eyes first — the CC BY 4.0 badge does
  not answer that question. Source:
  `https://sites.research.google/open-buildings/`.
- **Overture** — CDLA-Permissive 2.0, officially incompatible with ODbL.
  **DO NOT MIX.** Never ingest Overture into `data/`, and never into any
  intermediate database that also holds OSM-derived rows: share-alike
  contamination propagates to every downstream artifact (tiles, meshes,
  terrain) built from that database. There is no "just a few columns" version
  of this rule.

An adopted fallback gets its own row, its own attribution string, and — where
it feeds `data/` — an explicit ODbL-compatibility verdict in `LICENSES.md`
first.

## Moon & planets

Sources: NASA PDS (`https://pds.nasa.gov`) and USGS Astrogeology
(`https://astrogeology.usgs.gov`). Both publish US public domain data; credit
is courteous, not contractual (strings in `ATTRIBUTIONS.md`).

| body | datasets | typical resolution [REPORTED — unverified in-repo] |
|---|---|---|
| Moon | LOLA DEM; SLDEM2015; LROC WAC imagery | 512 ppd ≈ 59 m/px (LOLA / SLDEM) |
| Mars | MOLA DEM; Viking MDIM; THEMIS mosaics | 128 ppd ≈ 463 m/px (MOLA) |
| Venus | Magellan FMAP radar mosaic | — |
| Mercury | MESSENGER MDIS mosaic | — |
| Outer moons | Cassini / Voyager mosaics | — |
| Pluto / Charon | New Horizons mosaics | — |
| Ceres / Vesta | Dawn | — |

(ppd = pixels per degree; figures are equatorial.)

**Art fallback.** Solar System Scope texture sets
(`https://www.solarsystemscope.com/textures/`) are CC BY 4.0 — usable where a
scientific mosaic is patchy and the body is seen from far away. Recoloring and
reprojection do not escape the license: derived textures stay CC BY 4.0 and
stay attributed.

### Prohibited sources

The following are **prohibited**. Treat as prohibited regardless of
verification: a permissive-looking file from these producers is still out, and
re-checking a listed entry does not change its status. Removing an entry is a
`LICENSES.md` decision with a written rationale.

| source | license | why |
|---|---|---|
| DLR imagery | CC BY-NC-ND | non-commercial and no-derivatives — both terms are unusable in a distributable game client (reprojection and recoloring are derivatives) |
| ESA imagery | CC BY-SA-NC | non-commercial plus share-alike contamination of the art pipeline |
| EOX Sentinel-2 cloudless mosaic (`s2maps.eu`) | CC BY-NC-SA | non-commercial + share-alike; attractive as an Earth texture, which is exactly why it is listed here |
| Stellarium / Celestia bundles | GPL | GPL assets and texture packs cannot be folded into an Apache-2.0 project's data layer |
| NASA insignia / logotype | protected by law (14 CFR 1221), not a copyright license | strip insignia textures from 3D models; never render the insignia or logotype in the UI; never imply endorsement. Acknowledgment is requested per NASA policy — use STR-NASA (ATTRIBUTIONS.md); credit is courteous, not contractual |

The rule behind the table: NC / ND / SA terms are incompatible with a freely
distributable multiplayer client and with the code/data license split;
share-alike on assets would drag the whole art pipeline into obligations the
codebase does not carry.

## Far-field imagery

- **Blue Marble Next Generation** (NASA) — public domain. 500 m/px, monthly,
  cloud-free composites [REPORTED — unverified in-repo]. The "Earth from orbit" far view; the month
  selection is pinned per artifact (seasonal tint is a deliberate choice,
  recorded in the row). Source: NASA Visible Earth
  (`https://visibleearth.nasa.gov`).
- **Natural Earth** — public domain. 1:10m / 1:50m / 1:110m vectors and
  rasters. Far-zoom coastlines, borders, and the zoomed-out Earth before the
  OSM tiles take over. Source: `https://www.naturalearthdata.com/`.

Both are public domain: attribution is courteous, not contractual. Blue
Marble's courtesy credit is the NASA acknowledgment (`STR-NASA` in
`ATTRIBUTIONS.md`); Natural Earth's upstream-requested courtesy credit is
pinned as `STR-NE` in `ATTRIBUTIONS.md`.

## Ephemeris & frames

- **SPICE kernels** (NAIF, `https://naif.jpl.nasa.gov/pub/naif/`) — kernel
  files are redistributable **unmodified**; pin the kernel set by filename and
  checksum, and never edit a kernel. Initial set [PLACEHOLDER — gate on the
  Phase-0 ephemeris spike]: planetary ephemeris (`de440s.bsp`), leap seconds
  (`naif0012.tls`), body orientation and radii (`pck00011.tpc`).
- **The SPICE toolkit itself is not redistributable** under NAIF's terms.
  Fetch it at build time (a package-managed binding such as spiceypy, which
  installs CSPICE, satisfies this). Never vendor toolkit source or binaries
  into the repo or into release artifacts.
- **JPL Horizons** (`https://ssd.jpl.nasa.gov/horizons/`) — an interactive
  service with **no SLA**. Never query it at runtime. Precompute reference data
  (per-body state samples over the playable epoch window) at build time with a
  pinned script, and ship the generated table as data with its epoch range
  recorded.

## Toponyms

Swahili is a first-class UI language, so toponym quality is product quality.
The backbone is two permissive sources; OSM Swahili names are a cross-check
layer only.

- **Wikidata** — CC0. The entity-ID backbone. **Never blind-import labels.**
  Research finding [MEASURED @ 2026-09]: Stone Town's Swahili `label` on
  Wikidata is the district name "Wilaya ya Unguja Mjini", while the correct
  place name "Mji Mkongwe" exists only as an alias. A naive `labels/sw` import
  renames the flagship region wrong. Import labels **and** aliases, prefer the
  GeoNames preferred-Swahili row for disputed places, and review flagship
  places by hand.
- **GeoNames** — CC BY 4.0. The Tanzania dump (`TZ.zip`) plus
  `alternateNamesV2.zip` from `https://download.geonames.org/export/dump/`;
  filter to `lang=sw` rows carrying the preferred-name flag. Pin the dump date.
- **OSM `name:sw`** — 32,138 objects; the count is owned and measured by
  `docs/swahili-i18n.md` (2026-09-05 corpus sweep). Valuable, but the
  source is ODbL: if OSM names became the toponym backbone, the whole world
  database would become an ODbL derivative. **Thin attributed cross-check layer
  only** — a small table of Swahili-name corrections sourced from OSM, kept in
  `data/` with its own attribution, never merged into the backbone.

Generated toponym tables are derived artifacts: pinned SPARQL query revision
(Wikidata), pinned dump date (GeoNames), pinned extract timestamp (the OSM
cross-check), one script, recorded checksums.

## Sky

- **Hipparcos** — the starfield. Ship a **magnitude-limited, quantized subset**
  (~1–2 MB [PLACEHOLDER — gate on the actual build]): cut at a chosen visual
  magnitude (the naked-eye cut, V ≈ 6.5, is ~9,000 stars [REPORTED — unverified in-repo]), quantize
  positions and magnitudes into packed integers. The subset is a generated
  artifact with a pinned script and a pinned catalogue source (CDS VizieR,
  Hipparcos main catalogue `I/239`). The catalogue's licence terms are **not
  yet verified** — confirm them at CDS VizieR `I/239` at pin (pending in
  `LICENSES.md` §Verification); no terms are asserted here.
- **Gaia** — billions of sources; unusable in-browser. Not adopted.

## Map UI

- **MapLibre GL JS** — BSD-3-Clause. The upstream `LICENSE.txt` is a combined
  multi-license file: **preserve it wholesale** in `NOTICE`, never excerpt it.
- **Terrain for the map UI** — the Mapzen/AWS terrain tiles (terrarium
  encoding) are public domain (see Earth elevation for the frozen-snapshot
  caveat); fine as the UI-terrain prototype.
- **Serving** — the client consumes per-region PMTiles from the pinned
  Protomaps basemap profile; the serving requirements (CORS + range requests)
  are in Earth tiles.
- Code-side UI dependencies are tracked in `THIRD_PARTY_ASSETS.md`; this file
  tracks datasets only.

## Reproducibility rule

**Every derived artifact in `data/` must be regenerable by a pinned script plus
the pinned source timestamp. An artifact without a regeneration path is a bug.**

Concretely, each artifact carries:

1. its source row in the provenance table;
2. the pinned source version/timestamp (the `.pbf` timestamp, the GeoNames dump
   date, the kernel checksum, the GLO-30 product release);
3. pinned tool versions (osmium, planetiler, the Java/Docker digest, OSM2World,
   3d-tiles-tools, node/python) and the region-manifest revision;
4. the build script path and its output checksums, recorded at build time;
5. a refresh path: a new source timestamp produces new artifacts as a new row
   version — never a silent overwrite — and binaries are published as releases
   or to object storage, never committed (`data/README.md`, rule 3).

A build or release that cannot reproduce an artifact fails review. When a
pipeline changes, bump the artifact's row version and keep the old provenance
readable.
