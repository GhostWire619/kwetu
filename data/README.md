# `data/` — the ODbL layer

This directory holds **OpenStreetMap-derived datasets and other
share-alike data**: generated `.pmtiles` archives, terrain meshes built
on OSM footprints, building-mesh tiles, and their provenance records.

## Why this directory exists

OpenStreetMap data is licensed under **ODbL 1.0**. Every dataset derived
from it — vector tiles, 3D building meshes, terrain rasters built on OSM
geometry — is a **derivative database**, and the share-alike obligation
attaches to the database. Kwetu's code is Apache-2.0, so this layer is
**licensed and distributed separately** (ODbL 1.0) and must never be
folded into the permissively-licensed codebase. The directory boundary
enforces that split mechanically, not by convention.

## Rules (see LICENSES.md and DATA_SOURCES.md for the full policy)

1. Nothing enters `data/` without a **provenance row** in
   `DATA_SOURCES.md` (source, pinned version/timestamp, license,
   attribution string, build step).
2. Every artifact here must be **regenerable** by a pinned build script
   plus the pinned source timestamp. An artifact without a regeneration
   path is a bug.
3. Generated binaries (`.pmtiles`, baked meshes, rasters) are **never
   committed** — `.gitignore` excludes them; publish them as releases or
   to object storage.
4. Never mix **CDLA-Permissive** sources (e.g. Overture) into this layer
   — they are incompatible with ODbL.

## Current state

Pre-code. The Phase 2 data pipeline (Geofabrik Tanzania extract →
osmium bbox extracts → planetiler per-region PMTiles → GLO-30 terrain →
OSM2World building meshes) is specified in `DATA_SOURCES.md` and
`ROADMAP.md`. No artifacts exist yet.
