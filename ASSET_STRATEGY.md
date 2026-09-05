# Kwetu — Asset Strategy

Status: **pre-code (docs-first)**. The pipeline decisions below are locked
and license-verified from primary sources (research pass, 2026-09); every
size and performance figure is unmeasured until the Phase-0 spikes run, and
the single home for numbers is `ROADMAP.md` §Budgets. This doc owns *how*
assets are sourced, licensed, compressed, and cached — not the numbers.

Tag legend: `[EXTERNAL url]` = verified against the cited primary source ·
`[PLACEHOLDER — gate: S0.x]` = unmeasured, gated on a Phase-0 spike ·
per-asset license evidence lives in `THIRD_PARTY_ASSETS.md` (columns and
row format defined there).

## 1. Scope and ownership

| Topic | Owner |
|---|---|
| Dataset provenance: imagery, DEMs, PMTiles, toponyms | `DATA_SOURCES.md` |
| Ledger format, one row per asset, CI gate | `THIRD_PARTY_ASSETS.md` |
| Verbatim attribution strings (EN + sw) | `ATTRIBUTIONS.md` |
| License policy, incompatibility register, verification procedure | `LICENSES.md` |
| ODbL share-alike boundary for OSM-derived artifacts | `data/README.md` |
| Transport, Cache API wiring, degradation paths | `ARCHITECTURE.md` |
| Initial-load and per-asset size numbers | `ROADMAP.md` §Budgets |
| Asset-pipeline and caching prompt sections | `MASTER_PROMPT.md` (Parts C and E) |

Boundary: celestial texture sourcing (NASA PDS / USGS / Blue Marble, and the
prohibited list around them) is DATA_SOURCES territory. This doc covers
authored and curated assets — meshes, materials, kit parts, vehicles,
audio, fonts.

## 2. Sourcing modes by asset class

Every asset class gets a deliberate primary mode — **library**, **custom
authored**, **procedural**, or **AI-generated** — chosen once, in this
table, not improvised per asset. "AI-generated" always means the trap rules
in §8 apply and a provenance row is mandatory (§15).

| Class | Primary | Secondary / fallback | Notes |
|---|---|---|---|
| Architecture, flagship TZ/KE regions | **Custom CC0 kit** (§9) assembled procedurally on OSM footprints | OSM2World placeholder blocks for non-flagship regions | Kit geometry stays CC0; footprints stay ODbL |
| Road vehicles | **Library**: Kenney Car Kit (CC0) | — | §10 |
| Watercraft (dhow, mashua) | **Custom kit parts** (§9) | AI-gen originals via TRELLIS for unique variants | No library has these; per-vehicle license chains avoided by authoring |
| Spacecraft (real) | **NASA public-domain models** | — | Strip insignia, verify each asset; §7, §10 |
| Rovers / fictional vehicles | **AI-gen originals** (TRELLIS first, MIT incl. weights) | Hunyuan3D under the §8 constraints | Provenance row mandatory |
| Vegetation and nature props | **Library**: Poly Haven, Kenney/KayKit (CC0) | Procedural scattering; AI-gen only for unique hero plants | Never resell/rehost library content as our own "pack" |
| Surface materials (PBR) | **Library**: Poly Haven, ambientCG (CC0) → KTX2 (§4) | — | See §4 for ETC1S/UASTC split |
| Audio SFX | **Library**: freesound, CC0/CC-BY rows only (§12) | — | NC rows never, even as placeholders |
| Swahili voice lines | **Recorded** with written releases (§12) | — | Recording rights are personality rights, not copyright only |
| Fonts | **OFL** with full Swahili coverage (§13) | — | Pick is an S0.10 output |
| Celestial bodies (Moon, planets) | Dataset textures — see `DATA_SOURCES.md` | — | Out of scope here |

## 3. Wire format: glTF 2.0 binary (.glb)

One runtime mesh format, no exceptions:

- **glTF 2.0, binary container (`.glb`)** — the ratified Khronos format
  [EXTERNAL https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html].
  Textures ride in external `.ktx2` files (§4) so a texture re-author
  invalidates exactly one content-hashed URL instead of the whole scene.
- **`EXT_meshopt_compression` mandatory** on every shipped `.glb`. It is
  Khronos-ratified, its decoder runs on the order of ~1 GB/s under
  WASM-SIMD [EXTERNAL — Khronos glTF extension registry, vendor extension
  page], and meshopt payloads still shrink a few percent further under
  gzip — so **leave gzip on for `.glb`** (§6).
- **`KHR_mesh_quantization` mandatory.** Quantized vertex attributes are
  the cheap, universal win; any client that can render glTF 2.0 can read
  it [EXTERNAL — Khronos glTF extension registry].
- **`KHR_texture_basisu` / KTX2 containers** for all textures (§4).
- **Draco rejected.** Last release January 2024 [EXTERNAL
  https://github.com/google/draco — checked 2026-09], larger decoder
  bundle, slower decode than meshopt on WASM-SIMD. Nothing in the pipeline
  may emit Draco payloads; do not enable Draco in exporter settings.

Rule: the exporter emits meshes+materials; the compression pass is a build
step (§5), never a hand-toggled exporter checkbox — the build is what makes
the format guarantees auditable.

## 4. Textures: KTX2 / Basis Universal

All shipped textures are **KTX2 containers carrying Basis Universal
payloads**:

| Payload | Use for | Cost |
|---|---|---|
| **ETC1S** | color (albedo, emissive) | 4 bpp (8 bpp with alpha) |
| **UASTC** | normals, roughness/metalness/occlusion (ORM) | 8 bpp |
| RGBA8 uncompressed | nothing — never ship | 32 bpp |

ETC1S and UASTC sit at 4 and 8 bits per pixel against RGBA8's 32 — a
4–8× VRAM and download win per texture [EXTERNAL — Basis Universal
documentation, Khronos KTX2 spec]. That multiplier is what puts a region
within reach of the target hardware envelope at all (`PROJECT_VISION.md`);
the absolute budget rows are the §Budgets rows in `ROADMAP.md` §3 —
B-LOAD-05 for the transcoder `[PLACEHOLDER — gate: S0.3]`, B-ASSET-03
for texture sizes `[PLACEHOLDER — gate: Phase 2]`.

Hard rules:

1. **Author ETC1S or UASTC only.** three.js `KTX2Loader` only parses Basis
   Universal payloads; a KTX2 container with raw RGBA data fails at load.
   Author with `toktx --bcmp` (ETC1S) / `--uastc`, or glTF-Transform's
   `etc1s()` / `uastc()` functions (§5).
2. **Budget the one-time Basis transcoder WASM** — a few hundred KB, loaded
   once and cached [EXTERNAL — basis_universal / three.js KTX2Loader docs].
   Its exact per-package size is §Budgets row B-LOAD-05, measured
   alongside the meshopt decoder (B-LOAD-06) `[PLACEHOLDER — gate: S0.3]`.
3. **Pin KTX-Software 4.x** [EXTERNAL https://github.com/KhronosGroup/KTX-Software].
   v5 is mid-transition; do not chase it. The repository contains one
   non-open Ericsson file — therefore: **consume prebuilt binaries, never
   vendor KTX-Software sources into this repo** without a license scan,
   and record the scan in the ledger. Any vendoring needs a LICENSES.md
   note first.

## 5. Toolchain: Blender → glTF-Transform → gltfpack

Three stages, **complementary tools, not alternatives** — each owns a
stage, and neither replaces the other:

1. **Blender 5.0** — authoring (kit parts §9, vehicle retopology §10, kit
   textures). Export via **glTF-Blender-IO**, which is Apache-2.0. The key
   legal point: Blender is GPL, but the glTF exporter is separately
   licensed and **the exported `.glb` carries no GPL obligation** — exported
   asset data is not a derivative of the GPL application. Our kit stays
   CC0 (§9); no GPL attaches to the payload.
2. **glTF-Transform (MIT)** [EXTERNAL https://github.com/donmccurdy/glTF-Transform]
   — graph surgery: **weld, prune, dedup, quantize, simplify**, plus
   texture compression to ETC1S/UASTC (§4). Runs as CLI or library in the
   build.
3. **gltfpack / meshoptimizer (MIT)** [EXTERNAL https://github.com/zeux/meshoptimizer]
   — **LOD chains and the final `EXT_meshopt_compression` pass**. Generates
   L0–Ln levels per asset and packs the scene for the wire format of §3.

Pipeline order is fixed: Blender export → glTF-Transform (clean, quantize,
textures) → gltfpack (LODs, meshopt) → content hash → publish. Both tools
overlap in some features (both can quantize and compress); that overlap is
not an invitation to pick one — the stage ownership above is the decision.

Version pins live in the versions table (`ARCHITECTURE.md`) under the
verify-at-write-time rule; Blender 5.0 and KTX-Software 4.x are the
current recorded pins.

## 6. Serving and caching

Asset URLs are **content-hashed** (hash of the final published artifact),
served with:

```
Cache-Control: public, max-age=31536000, immutable
```

Encoding policy at the edge (Caddy, TLS + **HTTP/3**; the encode
negotiates zstd → brotli → gzip for text):

| Payload | Edge encoding |
|---|---|
| `.js`, `.wasm`, `.json`, `.po`, HTML | zstd / brotli / gzip, negotiated |
| `.glb` (EXT_meshopt) | **gzip on** (meshopt still compresses under it, §3); **no brotli/deflate** |
| `.ktx2` | **identity — never encode** (Basis payloads are already entropy-coded; more compression is wasted CPU) |
| `.pmtiles` | owned by `DATA_SOURCES.md` |

The rule in one line: **do not brotli/deflate `.glb`/`.ktx2` — they are
already compressed**; keep plain gzip for the meshopt `.glb` case only.

Integrity and storage, in order of authority:

1. **SRI does NOT apply to `fetch()`** — the `integrity=` attribute exists
   for script/link tags only. Asset integrity is verified in JS:
   `crypto.subtle.digest('SHA-256', bytes)` against a manifest of
   `url → sha256 → bytes → lastUsed`.
2. The manifest lives in **IndexedDB**; **idb-keyval** (Apache-2.0) is a
   fine substrate for it [EXTERNAL https://github.com/jakearchibald/idb-keyval].
   A hash mismatch drops the cache entry, refetches once, and reports —
   it must never wedge a session.
3. The **Cache API** (`caches`, via service worker) is the durable HTTP
   cache; hashed URLs make request-matching trivial. The IndexedDB
   manifest is the source of truth for what *should* be present.
4. **`navigator.storage.estimate()`** steers LRU eviction: when usage
   approaches quota, prune least-recently-used region tiles first
   (flagship regions and the decoders are pinned last to evict).
5. **`navigator.storage.persist()` is MANDATORY** on first meaningful
   interaction. Safari deletes all script-writable storage after 7 days
   of browser use [EXTERNAL https://webkit.org/blog/10218/ — ITP storage
   cap]; `persist()` is the only lever, and it can be denied, so every
   cache read must tolerate absence gracefully. Degradation wiring is
   ARCHITECTURE.md's; the asset-side requirement is that nothing assumes
   a warm cache.

## 7. Verified CC0 / public-domain sources

All verified CC0 unless noted, research pass 2026-09; ledger rows carry
per-asset evidence in `THIRD_PARTY_ASSETS.md`:

| Source | What we take | License |
|---|---|---|
| **Poly Haven** (polyhaven.com) | HDRIs, textures, models | CC0 |
| **ambientCG** (ambientcg.com) | PBR material sets | CC0 |
| **Kenney** (kenney.nl) | game kits incl. the Car Kit | CC0 |
| **KayKit** | stylized 3D kits | CC0 |
| **NASA 3D model repositories** (e.g. nasa3d.arc.nasa.gov) | real spacecraft | public domain, with rules below |

NASA-specific rules (these are legal, not aesthetic):

- **Strip insignia** — the NASA insignia/logotype is protected by law; it
  must not ship on models and must never appear in our UI (full policy in
  `ATTRIBUTIONS.md`).
- **No implied endorsement** — never present an asset as NASA's blessing
  of Kwetu; attribution is factual acknowledgment only.
- **Verify each asset** — NASA pages aggregate contributor submissions
  with varying terms; per-asset verification is the ledger's job and a
  "NASA" label on a page is not license evidence by itself.

CC0 requires no attribution, but the ledger row is still mandatory (§15)
— provenance is our memory, not a legal concession.

## 8. Traps

The list of sources that look fine and are not. Each entry is a rule, not
a warning.

- **Quaternius is NO LONGER CC0.** Current packs ship under the Quaternius
  Asset License v1.0, which **forbids standalone redistribution regardless
  of modification** — exactly what a git repo full of `.glb` files is.
  In-game use of their assets is fine; **never commit the packs** to this
  repository. If an old Quaternius pack was genuinely CC0 at download
  time, the ledger row must prove it — default assumption is v1.0.
- **Sketchfab — CC0/CC-BY per-model check only.** Platform filters are not
  evidence; uploads are mislabeled routinely. Rule: a Sketchfab asset
  ships only with the model page's own license statement captured in its
  ledger row, and only under CC0 or CC-BY. NC/ND Sketchfab rows never.
- **Hunyuan3D — outputs are shippable, the model is not ours.** The license
  states "Tencent claims no rights in Outputs" [EXTERNAL — Tencent Hunyuan
  Community License, model page on Hugging Face], so generated meshes can
  ship. But the model license also **excludes EU/UK/KR territories**,
  **caps free commercial use at 1M MAU**, and **forbids using outputs to
  train other models**. Consequences: **never commit the weights**, never
  point agents at the model from this repo, and record generation
  provenance (§15) for every output.
- **TRELLIS (MIT, including weights)** [EXTERNAL https://github.com/microsoft/TRELLIS]
  is the cleanest AI mesh-generation option — license covers the weights,
  so the pipeline can pin and run it ourselves. Still records provenance
  per output (§15), and prompts must not target recognizable third-party
  IP — an MIT generator does not launder a copied design.
- **Meshy / Tripo — unverified → do not ship.** Their terms are
  ToS-based and unverified as of 2026-09. No exceptions until a verified
  verdict lands in `LICENSES.md` and the ledger.
- **freesound mixes CC0/CC-BY/CC-BY-NC on one platform.** The ledger rule:
  **CC0/CC-BY rows only**; an NC row never enters the table, not even as a
  placeholder to "fix later".
- **Marketplace content is where asset licensing actually goes wrong.**
  Resold packs, unclear chains of title, "royalty-free" that isn't, store
  licenses that prohibit engine-agnostic redistribution. Rule: a purchase
  receipt is not license evidence; the ledger requires the actual license
  document, verified like any other row.

## 9. The Swahili-coast modular kit

The flagship-region architecture is **our own CC0 kit, authored in
Blender** — not scraped, not bought, not generated:

- coral-stone (coral-rag) wall modules and coping,
- carved Zanzibar doors and frames,
- mangrove-pole (boriti) construction elements,
- baraza — the street benches that make Stone Town's public space,
- watercraft: **dhow** and **mashua**,
- modern Dar es Salaam elements: **daladala** (shared minibus) and
  **bajaji** (three-wheeler).

Assembly is **procedural on OSM footprints**: building parts snap to
footprint geometry and height data from the ODbL layer, so real building
shapes come from real data while the parts remain authored modules.

The key legal insight: **our kit geometry is CC0 while the footprints
remain in the ODbL layer.** The kit must stay clean of share-alike
contamination:

1. A kit part is a shape-agnostic authored module — it must never be
   "baked from" a real footprint or embed OSM geometry.
2. The assembled per-region result (kit placed on OSM footprints) is an
   ODbL derivative database → it lives in `data/` under the ODbL rules
   (`data/README.md`), never in the permissive asset side.
3. This split is what allows the kit itself to be CC0 — including
   published standalone — while the city stays honest about its OSM
   derivation.

Kit authenticity (materials, proportions, door carving styles) is a
cultural-authoring matter owned by `PROJECT_VISION.md`; this doc owns the
license and pipeline mechanics.

## 10. Vehicle and spacecraft sourcing

- **The road car** — Kenney Car Kit (CC0, §7). Lowest-risk path to Phase 4
  driving gameplay; its low-poly style is acceptable at flagship-region
  distance budgets.
- **Daladala / bajaji** — custom kit parts (§9): real Dar street vehicles
  exist in no CC0 library, and per-vehicle AI generation would multiply
  provenance surface for no cultural gain.
- **Real spacecraft** — NASA public-domain models (§7 rules: strip
  insignia, no implied endorsement, verify each asset individually).
- **Unique rovers / fictional dhows** — AI-generated originals: TRELLIS
  first (MIT incl. weights), Hunyuan3D only under the full §8 constraint
  set. Each generation is one ledger row with provenance.

## 11. Terrain meshing

- **Flagship regions: pre-baked meshes** at build time from the DEM chain
  (`DATA_SOURCES.md` owns the DEM sources) using **delatin** (ISC)
  [EXTERNAL https://github.com/mapbox/delatin]. License settled
  2026-09-05: the ISC LICENSE text (first line "Copyright (c) 2019,
  Michael Fogleman, Vladimir Agafonkin") was fetched from the repo's
  `master` branch — the `main` path 404s, which is what broke the
  research pass' fetch. The verdict is recorded in `LICENSES.md`
  §Verification; the ledger row still carries the pinned-commit evidence
  before the build depends on it.
- **martini** is the named fallback and is **effectively dormant since
  mid-2025** [EXTERNAL https://github.com/mapbox/martini — checked 2026-09];
  it exists as a fallback only, not an active dependency.
- **Runtime meshing is for exploration only** — non-flagship terrain may
  mesh client-side on demand. It is explicitly excluded from flagship
  regions because client-side meshing burns CPU that modest East African
  laptops (the target envelope, `PROJECT_VISION.md`) do not have; the
  exact cost figure is §Budgets row B-MESH-01 (`ROADMAP.md` §3)
  `[PLACEHOLDER — gate: Phase 2]`.
- Pre-baked terrain meshes built **on OSM-derived geometry** are ODbL
  derivatives → `data/`, per `data/README.md`. Same split as §9.

## 12. Audio

- **freesound** is the SFX library under the §8 ledger rule: CC0/CC-BY
  rows only, per-sound license captured per row.
- **Swahili audio recording rights need a written release from voice
  actors** — obtained *before* the recording session, covering recording,
  distribution, and modification, and filed with the asset's ledger row.
  This is a personality-rights matter, not solved by CC0 anything.
- Music and ambience follow the same gate as every other asset class: no
  NC/ND, no marketplace-without-license-document (§8).

## 13. Fonts and UI

- **OFL fonts with full Swahili coverage.** The specific pick is a
  Phase-0 output of **S0.10** (UI stack + i18n pipeline + font choice);
  this doc fixes only the license class: OFL, web-embedding via
  `@font-face` permitted, license text kept alongside the font files,
  Reserved Font Name obligations respected.
- Coverage check is part of S0.10's exit criteria — a font that renders
  the UI shell but mangles East African name data fails the gate (see
  `docs/swahili-i18n.md` for the string and QA pipeline the font must
  survive).
- Icon sets, if adopted, are assets like any other: ledger row, license
  verified, CC0/OFL preferred.

## 14. Size budgets — measured-first policy

There are **no hardcoded asset-size promises** in this document. The
budget *rows* below live in `ROADMAP.md` §3 (§Budgets), which owns the
`B-XXX-NN` ID space; this doc cites rows by ID and never restates the
numbers. Each starts as a placeholder and is filled only by measurement
(S0.3 measures the decoder payloads; Phase 2+ measures real region and
asset payloads):

| ROADMAP §Budgets row(s) | What it bounds | Gate |
|---|---|---|
| B-LOAD-05 + B-LOAD-06 | KTX2 transcoder + meshopt decoder, per-package gz, one-time | `[PLACEHOLDER — gate: S0.3]` |
| B-ASSET-01 | LOD0 + LOD1 for a hero vehicle/building (.glb, gz) | `[PLACEHOLDER — gate: Phase 2]` |
| B-ASSET-02 | a single Swahili-coast kit part (.glb, gz) | `[PLACEHOLDER — gate: Phase 2]` |
| B-ASSET-03 | ETC1S/UASTC KTX2 at standard resolutions | `[PLACEHOLDER — gate: Phase 2]` |
| B-REG-03 / B-REG-04 | streamed flagship-region payloads (L2 terrain mesh / L3 buildings — mesh + textures per tier) | `[PLACEHOLDER — gate: Phase 2]` |

Other docs reference these rows; they never restate the numbers.

## 15. Ledger gate

The hard rule of this entire document:

> **No asset ships without a `THIRD_PARTY_ASSETS.md` row.**

- One row per asset: id, source URL, author, license + version, files +
  sha256, how used, attribution required, AI provenance, verified
  date + method (column definitions live in `THIRD_PARTY_ASSETS.md`).
- **AI-generated assets record model, version, prompt, date, and the
  model's license terms** — for every generation, not just shippable
  keepers (rejected generations of the same prompt are also provenance).
- Attribution strings for anything requiring credit go to
  `ATTRIBUTIONS.md`; CC0 rows still get ledger rows (§7).
- The CI completeness check is S0.4's deliverable: a new asset reference
  without a ledger row fails the build.
- Vendored tool sources (§4's KTX-Software caveat, §11's delatin) follow
  the same gate via `LICENSES.md`, which records pending verifications
  and settled verdicts (delatin's ISC verdict landed 2026-09-05 — §11).

## 16. Pending verifications and open items

| Item | State | Where it resolves |
|---|---|---|
| KTX-Software non-open Ericsson file | mitigated — binaries only; scan required if sources are ever vendored | `LICENSES.md` |
| Meshy / Tripo terms | unverified — do not ship | `LICENSES.md` verdict, then ledger |
| OFL font pick with full Swahili coverage | open — Phase-0 output | S0.10 ADR |
| Decoder + asset size figures | placeholders — §Budgets rows B-LOAD-05/06, B-ASSET-01…03, B-DEC-01 (ROADMAP.md §3.10) | S0.3 and Phase 2 |
| Hunyuan3D territory/MAU posture for our use | constrained-shippable (§8); revisit before any EU/UK/KR-facing decision | ADR if posture changes |
