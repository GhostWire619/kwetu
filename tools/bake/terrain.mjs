/**
 * Kwetu terrain bake — Stone Town / Zanzibar Town window.
 *
 * Pipeline: Copernicus DEM GLO-30 COG tiles (.bake/dem) → merged 1-arcsec
 * height grid over the window (lon 39.14..39.26 E, lat 6.21..6.11 S) → sea
 * rule → delatin TIN decimation (maxError 1.5 m) → minimal glTF 2.0 .glb in
 * LOCAL ENU metres + a manifest sidecar + tools/bake/last-run.log.
 *
 * Run:  node tools/bake/terrain.mjs
 * Tests: npx vitest run tools/bake/terrain.test.mjs
 *
 * Frames and precision (COORDINATE_SYSTEM.md — the authority for all of this):
 *   - Output axes are Frame.Enu axes: +x east, +y north, +z up (§8, Z-up ENU).
 *     This is deliberately NOT the glTF +Y-up convention; the loader must
 *     convert explicitly (§8: "Three.js asset defaults must not silently
 *     redefine ENU"). The manifest carries the same warning.
 *   - z is ORTHOMETRIC height: metres above the EGM2008 geoid, GLO-30's
 *     vertical reference [EXTERNAL — ESA/Copernicus documentation; provenance
 *     owned by DATA_SOURCES.md]. The ellipsoidal conversion h = H + N is
 *     DEFERRED to the geodesy bake step (Laws G-1/G-2) — it must never happen
 *     at runtime or in a shader.
 *   - The mesh is a FIRST-ORDER LOCAL TANGENT-PLANE bake about the grid's
 *     south-west node (the Frame.Enu anchor, stored at height 0 = local mean
 *     sea level). Projection constants (N, M radii) are frozen at the anchor;
 *     the reference ellipsoid falls away from the tangent plane quadratically
 *     (≈ x²/(2N) + y²/(2M) — ≈ 23.5 m in up at this tile's NE corner
 *     [derived]). Reconciling that curvature is the geodesy/planet-renderer
 *     boundary's job (Laws G-2/G-3), not this bake's.
 *   - Grid/vertex math is f64; positions are downcast to f32 exactly once, at
 *     the glTF boundary (Law P-2 — the GPU never sees a global coordinate, and
 *     this tile is LocalScene-local by construction). Source heights are f32
 *     samples and are carried through exactly.
 *
 * Sea rule: heights < 0 are clamped to 0 (local mean-sea-level plane). The
 * GLO-30 ocean treatment is not trusted further than that — water-body
 * refinement (WBM water mask + OSM coastline flattening per DATA_SOURCES.md)
 * is a later bake step and is NOT applied here.
 *
 * Not a simulation code path: wall-clock time (new Date()) appears only in
 * bake-provenance stamps (manifest bakedAtUtc, source retrieval evidence);
 * durations use performance.now(). COORDINATE_SYSTEM.md §4 owns simulation
 * time, not build-tool provenance.
 *
 * Outputs go to .bake/ (gitignored): the repo artifact is THIS SCRIPT — every
 * output is regenerable by re-running it (DATA_SOURCES.md regeneration rule).
 * No manifest copy is kept in the repo tree.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromFile } from 'geotiff';
import Delatin from 'delatin';

// ---------------------------------------------------------------------------
// Pinned configuration
// ---------------------------------------------------------------------------

/** Bake window (Stone Town / Zanzibar Town), WGS84 degrees. */
export const WINDOW_DEG = {
  westDeg: 39.14,
  southDeg: -6.21,
  eastDeg: 39.26,
  northDeg: -6.11,
};

/**
 * Source tiles — Copernicus DEM GLO-30, AWS Open Data mirror
 * (s3://copernicus-dem-30m, registry: https://registry.opendata.aws/copernicus-dem/
 * [EXTERNAL — per DATA_SOURCES.md]). Local copies live in .bake/dem.
 *
 * etagMd5 values are the upstream S3 ETags observed via HTTP HEAD on
 * 2026-09-06 [MEASURED — from this dev host]; for these simple (non-multipart)
 * uploads the ETag is the object MD5, and the local files' MD5s match exactly
 * [MEASURED 2026-09-06] — the bake asserts this so a silently-drifted local
 * copy fails loudly instead of baking wrong terrain. A different upstream
 * version is a new source row version (DATA_SOURCES.md): update the pin
 * consciously, never silently.
 */
export const SOURCE_TILES = [
  {
    name: 'Copernicus_DSM_COG_10_S06_00_E039_00_DEM',
    file: 'S06_00_E039_00_DEM.tif',
    etagMd5: 'fa328fe7c26f5c2131b4ec0fcb907a4d',
    upstreamObjectLastModifiedUtc: '2022-05-09T14:54:29Z',
  },
  {
    name: 'Copernicus_DSM_COG_10_S07_00_E039_00_DEM',
    file: 'S07_00_E039_00_DEM.tif',
    etagMd5: '994959a43d585155ccaecf151973635d',
    upstreamObjectLastModifiedUtc: '2022-05-09T14:54:53Z',
  },
];

/** TIN decimation budget in metres (vertical). */
export const MAX_ERROR_METRES = 1.5;

/** Output artifact names (under .bake/meshes by default). */
export const OUTPUTS = {
  glbFile: 'stone-town.terrain.glb',
  manifestFile: 'stone-town.terrain.manifest.json',
};

const ATTRIBUTION =
  'Contains modified Copernicus data 2026 (canonical string: ATTRIBUTIONS.md#copernicus-dem)';

// ---------------------------------------------------------------------------
// Geodesy constants — WGS84, COORDINATE_SYSTEM.md §5 (copied verbatim)
// ---------------------------------------------------------------------------

const WGS84_A_METRES = 6378137.0; // exact [EXTERNAL — NGA STND.0036]
const WGS84_INV_F = 298.257223563; // exact [EXTERNAL — NGA STND.0036]
const WGS84_E2 = (1 / WGS84_INV_F) * (2 - 1 / WGS84_INV_F); // e² = f(2−f) [derived, §5]

const ARCSEC_PER_DEG = 3600;
/** Radians per arcsecond — the angular unit of the GLO-30 node lattice. */
const ARCSEC_RAD = Math.PI / (180 * ARCSEC_PER_DEG);
/** Window→lattice tolerance: windows are given in decimal degrees and must
 *  land on 1-arcsec node centres; 1e-6 arcsec ≈ 3e-8 m of slack absorbs the
 *  double-precision noise of e.g. 39.14 * 3600 = 140904.00000000003. */
const LATTICE_EPS = 1e-6;

/**
 * Prime-vertical radius of curvature N(φ) — normal to the ellipsoid (§5).
 * @param {number} phiRad geodetic latitude, radians
 * @returns {number} metres
 */
export function primeVerticalRadiusMetres(phiRad) {
  const s = Math.sin(phiRad);
  return WGS84_A_METRES / Math.sqrt(1 - WGS84_E2 * s * s);
}

/**
 * Meridional radius of curvature M(φ) — along the meridian (§5).
 * @param {number} phiRad geodetic latitude, radians
 * @returns {number} metres
 */
export function meridionalRadiusMetres(phiRad) {
  const s = Math.sin(phiRad);
  return (WGS84_A_METRES * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s * s, 1.5);
}

/**
 * Local grid spacing on the anchor's tangent plane: one 1-arcsec lattice step
 * expressed in metres east-west (along the parallel's instantaneous radius
 * N·cosφ) and north-south (along the meridian M), constants frozen at the
 * anchor latitude. First-order exact; second-order deviation is the documented
 * tangent-plane omission (module header).
 * @param {number} anchorLatitudeDeg
 */
export function enuSpacingMetres(anchorLatitudeDeg) {
  const phi = (anchorLatitudeDeg * Math.PI) / 180;
  return {
    eastWestMetres: primeVerticalRadiusMetres(phi) * Math.cos(phi) * ARCSEC_RAD,
    northSouthMetres: meridionalRadiusMetres(phi) * ARCSEC_RAD,
  };
}

// ---------------------------------------------------------------------------
// Tool versions (read from the installed packages, never from memory)
// ---------------------------------------------------------------------------

/** Resolves the installed version of a dependency by walking up from its
 *  entry point to its package.json — works regardless of the exports map. */
function pkgVersion(name) {
  const entry = createRequire(import.meta.url).resolve(name);
  let dir = path.dirname(entry);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fsSync.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fsSync.readFileSync(candidate, 'utf8'));
        if (pkg.name === name) return pkg.version;
      } catch {
        // unreadable package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json for ${name} not found from ${entry}`);
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Tile IO
// ---------------------------------------------------------------------------

/**
 * Loads one GLO-30 COG tile and validates every convention this bake relies
 * on. Fails loudly on anything unexpected — silent convention drift bakes
 * wrong terrain.
 * @param {{name: string, file: string, etagMd5: string}} source
 * @returns {Promise<{name: string, file: string, originLonDeg: number,
 *   originLatDeg: number, dxDeg: number, dyDeg: number, width: number,
 *   height: number, samples: Float32Array, readMs: number}>}
 */
export async function loadTile(source) {
  const t0 = performance.now();
  const tif = await fromFile(source.file);
  const image = await tif.getImage(); // COG: first image is full resolution

  const geoKeys = image.getGeoKeys();
  if (geoKeys?.GeographicTypeGeoKey !== 4326) {
    throw new Error(`${source.name}: expected WGS84 (GeoKey 4326), got ${geoKeys?.GeographicTypeGeoKey}`);
  }
  if (image.getGeoKeys()?.GTRasterTypeGeoKey !== 2) {
    throw new Error(`${source.name}: expected RasterPixelIsPoint (GeoKey 2) — GLO-30 nodes are point samples on the 1-arcsec lattice`);
  }
  if (image.pixelIsArea()) {
    throw new Error(`${source.name}: pixelIsArea disagrees with GTRasterTypeGeoKey — refusing to guess node placement`);
  }
  if (image.getSamplesPerPixel() !== 1) {
    throw new Error(`${source.name}: expected 1 sample per pixel, got ${image.getSamplesPerPixel()}`);
  }
  if (image.getSampleFormat() !== 3 || image.getBitsPerSample() !== 32) {
    throw new Error(`${source.name}: expected IEEE float32 heights (format 3, 32 bits)`);
  }
  const nodata = await image.getGDALNoData();
  if (nodata !== null) {
    throw new Error(`${source.name}: GDAL nodata ${nodata} — this bake implements no nodata handling`);
  }

  const [originLonDeg, originLatDeg] = image.getOrigin(); // ties raster node (0, 0)
  const res = image.getResolution();
  const dxDeg = Math.abs(res[0]);
  const dyDeg = Math.abs(res[1]);

  const samples = (await image.readRasters())[0];
  if (!(samples instanceof Float32Array)) {
    throw new Error(`${source.name}: expected Float32Array samples, got ${samples?.constructor?.name}`);
  }
  return {
    name: source.name,
    file: source.file,
    originLonDeg,
    originLatDeg,
    dxDeg,
    dyDeg,
    width: image.getWidth(),
    height: image.getHeight(),
    samples,
    readMs: performance.now() - t0,
  };
}

/** sha256 + md5 + byte size + mtime of one file (single read; sources are ≤ ~13 MB).
 *  mtime is the only retrieval-date evidence this bake has — the download step
 *  records no ledger of its own. */
export async function fileHashes(filePath) {
  const [buf, st] = await Promise.all([fsp.readFile(filePath), fsp.stat(filePath)]);
  return {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    md5: createHash('md5').update(buf).digest('hex'),
    mtimeUtc: st.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Grid planning and mosaic (integer arcseconds — no float lattice drift)
// ---------------------------------------------------------------------------

/** Degrees → integer arcseconds; throws if off the 1-arcsec lattice. */
function degToArcsecRounded(deg, label) {
  const as = deg * ARCSEC_PER_DEG;
  const rounded = Math.round(as);
  if (Math.abs(as - rounded) > LATTICE_EPS) {
    throw new Error(`${label}: ${deg} deg is not on the 1-arcsec node lattice`);
  }
  return rounded;
}

/**
 * Plans the merged window grid on the tiles' shared 1-arcsec node lattice.
 * Nodes are identified by integer arcseconds: gi east of the westernmost tile
 * origin, gj SOUTH of the northernmost tile origin (raster rows run
 * north→south). Tile nodes never overlap in GLO-30, so the mosaic is a pure
 * partition — overlap is refused, not blended.
 *
 * @param {Array<{name: string, originLonDeg: number, originLatDeg: number,
 *   width: number, height: number, dxDeg: number, dyDeg: number}>} tileMetas
 * @param {{westDeg: number, southDeg: number, eastDeg: number, northDeg: number}} windowDeg
 */
export function planGrid(tileMetas, windowDeg) {
  if (tileMetas.length === 0) throw new Error('no source tiles given');
  for (const t of tileMetas) {
    for (const [label, v] of [['dxDeg', t.dxDeg], ['dyDeg', t.dyDeg]]) {
      if (Math.abs(v * ARCSEC_PER_DEG - 1) > 1e-9) {
        throw new Error(`${t.name}: ${label} = ${v} — this bake pins the shared 1-arcsec GLO-30 grid`);
      }
    }
  }

  const refLonAs = Math.min(...tileMetas.map((t) => degToArcsecRounded(t.originLonDeg, `${t.name} origin lon`)));
  const refLatAs = Math.max(...tileMetas.map((t) => degToArcsecRounded(t.originLatDeg, `${t.name} origin lat`)));

  // Window bounds → node index ranges (inclusive), off-lattice bounds snap
  // outward to the first/last node centre inside the window.
  const giStart = Math.ceil(windowDeg.westDeg * ARCSEC_PER_DEG - refLonAs - LATTICE_EPS);
  const giEnd = Math.floor(windowDeg.eastDeg * ARCSEC_PER_DEG - refLonAs + LATTICE_EPS);
  const gjStart = Math.ceil(refLatAs - windowDeg.northDeg * ARCSEC_PER_DEG - LATTICE_EPS);
  const gjEnd = Math.floor(refLatAs - windowDeg.southDeg * ARCSEC_PER_DEG + LATTICE_EPS);
  const cols = giEnd - giStart + 1;
  const rows = gjEnd - gjStart + 1;
  if (cols <= 0 || rows <= 0) throw new Error('window selects no grid nodes');
  const nodeCount = cols * rows;

  const ranges = tileMetas.map((t) => {
    const gi0 = degToArcsecRounded(t.originLonDeg, `${t.name} origin lon`) - refLonAs;
    const gj0 = refLatAs - degToArcsecRounded(t.originLatDeg, `${t.name} origin lat`);
    const c0 = Math.max(giStart, gi0);
    const c1 = Math.min(giEnd, gi0 + t.width - 1);
    const r0 = Math.max(gjStart, gj0);
    const r1 = Math.min(gjEnd, gj0 + t.height - 1);
    const hasOverlap = c0 <= c1 && r0 <= r1;
    return {
      name: t.name,
      gi0,
      gj0,
      hasOverlap,
      c0: hasOverlap ? c0 : 0,
      c1: hasOverlap ? c1 : -1,
      r0: hasOverlap ? r0 : 0,
      r1: hasOverlap ? r1 : -1,
      nodes: hasOverlap ? (c1 - c0 + 1) * (r1 - r0 + 1) : 0,
    };
  });
  const covered = ranges.reduce((sum, r) => sum + r.nodes, 0);
  if (covered < nodeCount) {
    throw new Error(`window not covered by source tiles: ${covered} of ${nodeCount} nodes`);
  }
  if (covered > nodeCount) {
    throw new Error(`source tiles overlap over the window (${covered} nodes for ${nodeCount} cells) — this bake refuses to blend`);
  }

  const lonOf = (gi) => (refLonAs + gi) / ARCSEC_PER_DEG;
  const latOf = (gj) => (refLatAs - gj) / ARCSEC_PER_DEG;
  return {
    refLonAs,
    refLatAs,
    giStart,
    giEnd,
    gjStart,
    gjEnd,
    cols,
    rows,
    nodeCount,
    ranges,
    /** Exact node coordinates of the grid's four corner nodes (pixel-is-point
     *  raster: nodes sit ON these coordinates). */
    cornersDeg: {
      northWest: { longitudeDeg: lonOf(giStart), latitudeDeg: latOf(gjStart) },
      northEast: { longitudeDeg: lonOf(giEnd), latitudeDeg: latOf(gjStart) },
      southEast: { longitudeDeg: lonOf(giEnd), latitudeDeg: latOf(gjEnd) },
      southWest: { longitudeDeg: lonOf(giStart), latitudeDeg: latOf(gjEnd) },
    },
  };
}

/** Min/max/mean over a height grid; throws on any non-finite sample. */
export function gridStats(grid) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (!Number.isFinite(v)) throw new Error(`non-finite sample at grid[${i}] — this bake has no nodata handling`);
    n++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, mean: sum / n, count: n };
}

/**
 * Copies each tile's window sub-rectangle into the merged grid (row-wise
 * subarray copies — no resampling: the tiles share the exact node lattice).
 * @param {ReturnType<planGrid>} plan
 * @param {Map<string, {name: string, width: number, samples: Float32Array}>} tilesByName
 */
export function mosaic(plan, tilesByName) {
  const t0 = performance.now();
  const grid = new Float32Array(plan.nodeCount);
  const contributions = [];
  for (const range of plan.ranges) {
    if (!range.hasOverlap) {
      contributions.push({ name: range.name, nodes: 0 });
      continue;
    }
    const tile = tilesByName.get(range.name);
    if (!tile) throw new Error(`missing samples for tile ${range.name}`);
    const spanCols = range.c1 - range.c0 + 1;
    for (let gj = range.r0; gj <= range.r1; gj++) {
      const srcStart = (gj - range.gj0) * tile.width + (range.c0 - range.gi0);
      const dstStart = (gj - plan.gjStart) * plan.cols + (range.c0 - plan.giStart);
      grid.set(tile.samples.subarray(srcStart, srcStart + spanCols), dstStart);
    }
    contributions.push({ name: range.name, nodes: range.nodes });
  }
  const stats = gridStats(grid);
  return { grid, contributions, stats, ms: performance.now() - t0 };
}

/**
 * SEA RULE: clamp heights < 0 to 0 (the local mean-sea-level plane). GLO-30's
 * ocean cells are 0-ish; the WBM water-mask / OSM coastline refinement
 * (DATA_SOURCES.md) is a later bake step and is deliberately not here.
 * Mutates `grid` in place (f32 source values, clamped in f32).
 */
export function applySeaRule(grid) {
  const t0 = performance.now();
  let clampedCells = 0;
  let zeroCells = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) {
      grid[i] = 0;
      clampedCells++;
    }
    if (grid[i] === 0) zeroCells++;
  }
  return {
    clampedCells,
    zeroCells,
    zeroFraction: zeroCells / grid.length,
    stats: gridStats(grid),
    ms: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// TIN mesh
// ---------------------------------------------------------------------------

/**
 * Decimates the grid with delatin (Garland/Heckbert greedy insertion, exact
 * Delaunay) and emits Kwetu-local ENU positions.
 *
 * Grid layout note: `grid` is the raster layout — row 0 is the NORTH edge,
 * columns run west→east; delatin indexes data[cols·row + col]. Positions map
 * to ENU: x = col·dx (east), y = (rows−1−row)·dy (so +y is NORTH), z = the
 * orthometric source height, carried through f32-exact (Law P-2: the single
 * f32 downcast is the position buffer itself).
 *
 * Winding: glTF front faces are counter-clockwise. Triangles are re-wound so
 * they are CCW seen from +z (above) in the ENU x/y plane — delatin's array-
 * space winding is orientation-of-the-raster-dependent, so it is measured and
 * fixed here, deterministically, per triangle.
 *
 * @param {Float32Array} grid clamped heights, cols·rows
 * @param {number} cols
 * @param {number} rows
 * @param {{eastWestMetres: number, northSouthMetres: number}} spacing
 * @param {number} maxErrorMetres
 */
export function buildMesh(grid, cols, rows, spacing, maxErrorMetres) {
  const t0 = performance.now();
  const tin = new Delatin(grid, cols, rows);
  tin.run(maxErrorMetres);
  if (tin.getMaxError() > maxErrorMetres) {
    throw new Error(`delatin finished above budget: ${tin.getMaxError()} > ${maxErrorMetres} m`);
  }
  if (tin.coords.length % 2 !== 0 || tin.triangles.length % 3 !== 0) {
    throw new Error('delatin produced malformed coords/triangles arrays');
  }

  const vertexCount = tin.coords.length >> 1;
  const positions = new Float32Array(vertexCount * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const col = tin.coords[2 * v];
    const row = tin.coords[2 * v + 1];
    positions[3 * v] = col * spacing.eastWestMetres; // f64 → f32, once (Law P-2)
    positions[3 * v + 1] = (rows - 1 - row) * spacing.northSouthMetres;
    positions[3 * v + 2] = tin.heightAt(col, row); // f32 source value, exact
    const x = positions[3 * v];
    const y = positions[3 * v + 1];
    const z = positions[3 * v + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const triangleCount = tin.triangles.length / 3;
  const indices = new Uint32Array(triangleCount * 3);
  let flippedWinding = 0;
  let degenerateTriangles = 0;
  for (let t = 0; t < triangleCount; t++) {
    const a = tin.triangles[3 * t];
    const b = tin.triangles[3 * t + 1];
    const c = tin.triangles[3 * t + 2];
    const ax = positions[3 * a];
    const ay = positions[3 * a + 1];
    // signed area ×2 in the ENU x/y plane; > 0 = CCW seen from +z (above)
    const cross =
      (positions[3 * b] - ax) * (positions[3 * c + 1] - ay) -
      (positions[3 * b + 1] - ay) * (positions[3 * c] - ax);
    if (cross > 0) {
      indices[3 * t] = a;
      indices[3 * t + 1] = b;
      indices[3 * t + 2] = c;
    } else if (cross < 0) {
      flippedWinding++;
      indices[3 * t] = a;
      indices[3 * t + 1] = c;
      indices[3 * t + 2] = b;
    } else {
      // zero 2D area (collinear grid points) — kept, counted, never wound
      degenerateTriangles++;
      indices[3 * t] = a;
      indices[3 * t + 1] = b;
      indices[3 * t + 2] = c;
    }
  }

  return {
    positions,
    indices,
    vertexCount,
    triangleCount,
    flippedWinding,
    degenerateTriangles,
    achievedMaxErrorMetres: tin.getMaxError(),
    rmsdMetres: tin.getRMSD(),
    bboxLocalEnuMetres: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    ms: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// glTF 2.0 (.glb) writer + independent verifier
// ---------------------------------------------------------------------------

/**
 * Packs a mesh into a minimal single-primitive glTF 2.0 GLB: one buffer (BIN
 * chunk), one VEC3 f32 POSITION accessor (min/max included — required by the
 * spec for POSITION), one UNSIGNED_INT SCALAR index accessor, TRIANGLES mode,
 * one default PBR material. Positions are LOCAL ENU metres (Z-up) — NOT the
 * glTF Y-up convention; the manifest and this module's header say so, and the
 * loader converts explicitly.
 *
 * @param {ReturnType<buildMesh>} mesh
 * @param {string} generator asset.generator string
 */
export function buildGlb(mesh, generator) {
  const posBytes = mesh.positions.byteLength; // 12·V — multiple of 4
  const idxBytes = mesh.indices.byteLength; // 12·T — multiple of 4
  if (posBytes % 4 !== 0 || idxBytes % 4 !== 0) {
    throw new Error('position/index byte lengths must be 4-byte aligned');
  }
  const binLen = posBytes + idxBytes;
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, posBytes), 0);
  bin.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, idxBytes), posBytes);

  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0], name: 'kwetu-terrain' }],
    nodes: [{ mesh: 0, name: 'stone-town.terrain' }],
    meshes: [
      {
        name: 'stone-town.terrain',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'terrain-default',
        pbrMetallicRoughness: { baseColorFactor: [0.53, 0.49, 0.41, 1], metallicFactor: 0.0, roughnessFactor: 1.0 },
      },
    ],
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 }, // ARRAY_BUFFER
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 }, // ELEMENT_ARRAY_BUFFER
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: mesh.vertexCount,
        type: 'VEC3',
        min: mesh.bboxLocalEnuMetres.min,
        max: mesh.bboxLocalEnuMetres.max,
      },
      {
        bufferView: 1,
        componentType: 5125, // UNSIGNED_INT
        count: mesh.triangleCount * 3,
        type: 'SCALAR',
      },
    ],
  };

  const jsonText = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonLen = (jsonText.length + 3) & ~3; // pad to 4 with spaces (spec)
  const jsonChunk = Buffer.alloc(jsonLen, 0x20);
  jsonText.copy(jsonChunk);

  const glb = Buffer.alloc(12 + 8 + jsonLen + 8 + binLen);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true); // version 2
  dv.setUint32(8, glb.length, true); // total length
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  jsonChunk.copy(glb, 20);
  const binChunkAt = 20 + jsonLen;
  dv.setUint32(binChunkAt, binLen, true);
  dv.setUint32(binChunkAt + 4, 0x004e4942, true); // 'BIN\0'
  glb.set(bin, binChunkAt + 8);

  return { glb, jsonChunkBytes: jsonLen, binChunkBytes: binLen, gltf };
}

/**
 * Independent re-parse of a .glb from raw bytes: verifies the container
 * (magic, version, chunk types/lengths/padding), the JSON (buffer/
 * bufferView/accessor arithmetic against the BIN chunk, POSITION min/max vs
 * the decoded data, index range) and returns the decoded positions/indices so
 * the caller can cross-check against the source grid. Throws on the first
 * failed check — a broken glTF poisons the runtime, so this refuses to bless.
 *
 * @param {Uint8Array|Buffer} bytes the .glb file content
 */
export function verifyGlb(bytes) {
  const checks = [];
  const assert = (cond, name) => {
    if (!cond) throw new Error(`glTF verification failed at '${name}'`);
    checks.push(name);
  };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(dv.getUint32(0, true) === 0x46546c67, 'magic glTF');
  assert(dv.getUint32(4, true) === 2, 'container version 2');
  const total = dv.getUint32(8, true);
  assert(total === bytes.byteLength, 'header total length == file length');

  const jsonLen = dv.getUint32(12, true);
  assert(dv.getUint32(16, true) === 0x4e4f534a, 'JSON chunk type');
  assert(jsonLen % 4 === 0, 'JSON chunk 4-byte padded');
  assert(20 + jsonLen + 8 <= total, 'JSON chunk within file');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));

  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  assert(dv.getUint32(binAt + 4, true) === 0x004e4942, 'BIN chunk type');
  assert(binLen % 4 === 0, 'BIN chunk 4-byte padded');
  assert(binAt + 8 + binLen === total, 'BIN chunk ends exactly at total length');

  // Copy the BIN out so typed-array views never alias a pooled Buffer.
  const bin = new Uint8Array(binLen);
  bin.set(bytes.subarray(binAt + 8, binAt + 8 + binLen));

  assert(json.asset?.version === '2.0', 'asset version 2.0');
  assert(json.buffers?.length === 1, 'exactly one buffer');
  assert(json.buffers[0].byteLength === binLen, 'buffer.byteLength == BIN chunk length');
  assert(json.bufferViews?.length === 2, 'exactly two bufferViews');
  json.bufferViews.forEach((bv, i) => {
    assert(bv.buffer === 0, `bufferView ${i} references buffer 0`);
    assert(bv.byteOffset % 4 === 0, `bufferView ${i} byteOffset 4-byte aligned`);
    assert(bv.byteOffset + bv.byteLength <= binLen, `bufferView ${i} fits inside the buffer`);
  });

  const prim = json.meshes?.[0]?.primitives?.[0];
  assert(prim && prim.mode === 4, 'primitive mode TRIANGLES');
  const posAcc = json.accessors[prim.attributes.POSITION];
  const idxAcc = json.accessors[prim.indices];
  assert(posAcc.componentType === 5126 && posAcc.type === 'VEC3', 'POSITION accessor FLOAT VEC3');
  assert(idxAcc.componentType === 5125 && idxAcc.type === 'SCALAR', 'index accessor UNSIGNED_INT SCALAR');

  const posBv = json.bufferViews[posAcc.bufferView];
  assert(posBv.byteLength === posAcc.count * 12, 'POSITION accessor byte length exact (12·count)');
  assert(Array.isArray(posAcc.min) && posAcc.min.length === 3, 'POSITION accessor min present (spec-required)');
  assert(Array.isArray(posAcc.max) && posAcc.max.length === 3, 'POSITION accessor max present (spec-required)');
  const positions = new Float32Array(bin.buffer, posBv.byteOffset, posAcc.count * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  assert(
    minX === posAcc.min[0] && minY === posAcc.min[1] && minZ === posAcc.min[2] &&
    maxX === posAcc.max[0] && maxY === posAcc.max[1] && maxZ === posAcc.max[2],
    'POSITION accessor min/max match the decoded buffer exactly',
  );

  const idxBv = json.bufferViews[idxAcc.bufferView];
  assert(idxBv.byteLength === idxAcc.count * 4, 'index accessor byte length exact (4·count)');
  assert(idxBv.byteOffset % 4 === 0, 'index data 4-byte aligned');
  assert(idxAcc.count % 3 === 0, 'index count is a multiple of 3');
  const indices = new Uint32Array(bin.buffer, idxBv.byteOffset, idxAcc.count);
  const vertexCount = posAcc.count;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) throw new Error(`glTF verification failed: index ${indices[i]} out of vertex range at #${i}`);
  }
  checks.push('all indices within vertex range');

  return {
    checks,
    positions,
    indices,
    vertexCount,
    triangleCount: idxAcc.count / 3,
    gltf: json,
  };
}

/**
 * Re-derives a spread of vertices' ENU coordinates from the source grid and
 * compares against the f32 position buffer — bitwise. x/y must equal the
 * projection of their grid indices (f32-rounded), z must equal the grid
 * height exactly.
 */
export function spotCheckHeights(positions, grid, cols, rows, spacing, sampleCount = 64) {
  const vertexCount = positions.length / 3;
  if (vertexCount === 0) throw new Error('no vertices to spot-check');
  const stride = Math.max(1, Math.floor(vertexCount / sampleCount));
  const failures = [];
  let checked = 0;
  for (let v = 0; v < vertexCount && checked < sampleCount; v += stride) {
    const x = positions[3 * v];
    const y = positions[3 * v + 1];
    const z = positions[3 * v + 2];
    const col = Math.round(x / spacing.eastWestMetres);
    const row = rows - 1 - Math.round(y / spacing.northSouthMetres);
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      failures.push({ vertex: v, reason: 're-derived grid index out of range' });
      checked++;
      continue;
    }
    const expectedX = Math.fround(col * spacing.eastWestMetres);
    const expectedY = Math.fround((rows - 1 - row) * spacing.northSouthMetres);
    const expectedZ = grid[row * cols + col];
    if (x !== expectedX || y !== expectedY || !Object.is(z, expectedZ)) {
      failures.push({ vertex: v, got: [x, y, z], expected: [expectedX, expectedY, expectedZ] });
    }
    checked++;
  }
  return { checked, failures };
}

/**
 * Confirms the mesh contains vertices at all four grid corner nodes (delatin
 * seeds the mesh with them; the assertion makes that contract explicit so a
 * future mesh generator cannot silently shrink the tile).
 */
export function checkCorners(positions, cols, rows, spacing) {
  const corners = new Set();
  for (let v = 0; v < positions.length / 3; v++) {
    const col = Math.round(positions[3 * v] / spacing.eastWestMetres);
    const row = rows - 1 - Math.round(positions[3 * v + 1] / spacing.northSouthMetres);
    corners.add(row * cols + col);
  }
  const want = [
    { name: 'northWest', col: 0, row: 0 },
    { name: 'northEast', col: cols - 1, row: 0 },
    { name: 'southEast', col: cols - 1, row: rows - 1 },
    { name: 'southWest', col: 0, row: rows - 1 },
  ];
  return want.map((c) => ({ name: c.name, present: corners.has(c.row * cols + c.col) }));
}

// ---------------------------------------------------------------------------
// Bake orchestration
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const fmt = (n, digits = 3) => n.toFixed(digits);
const fmtInt = (n) => n.toLocaleString('en-US');

/**
 * Builds the human-readable run log (also printed to stdout by bake()).
 * Pure — exported for tests.
 */
export function buildLogText(r) {
  const t = r.timings;
  const lines = [
    `Kwetu terrain bake — ${r.region.name}`,
    `baked ${r.wallClockUtc} (wall clock [MEASURED — bake provenance only; not a simulation instant])`,
    '',
    `sources (Copernicus DEM GLO-30, AWS Open Data mirror s3://copernicus-dem-30m [EXTERNAL]):`,
    ...r.tiles.map(
      (tile) =>
        `  ${tile.name}  nodes ${fmtInt(tile.nodesContributed)}  read ${fmt(tile.readMs, 1)} ms  bytes ${fmtInt(tile.bytes)}  sha256 ${tile.sha256}  md5==ETag ${tile.md5MatchesUpstreamEtag}`,
    ),
    `window (deg): lon ${r.windowDeg.westDeg}..${r.windowDeg.eastDeg}  lat ${r.windowDeg.southDeg}..${r.windowDeg.northDeg}`,
    `grid: ${r.plan.cols} x ${r.plan.rows} nodes = ${fmtInt(r.plan.nodeCount)} (1-arcsec lattice, pixel-is-point)`,
    `grid corners (deg): NW (${fmt(r.plan.cornersDeg.northWest.longitudeDeg, 6)}, ${fmt(r.plan.cornersDeg.northWest.latitudeDeg, 6)})  NE (${fmt(r.plan.cornersDeg.northEast.longitudeDeg, 6)}, ${fmt(r.plan.cornersDeg.northEast.latitudeDeg, 6)})  SE (${fmt(r.plan.cornersDeg.southEast.longitudeDeg, 6)}, ${fmt(r.plan.cornersDeg.southEast.latitudeDeg, 6)})  SW (${fmt(r.plan.cornersDeg.southWest.longitudeDeg, 6)}, ${fmt(r.plan.cornersDeg.southWest.latitudeDeg, 6)}) = ENU anchor`,
    `node spacing: ${fmt(r.spacing.eastWestMetres, 4)} m E-W x ${fmt(r.spacing.northSouthMetres, 4)} m N-S [derived — WGS84 radii at the anchor, COORDINATE_SYSTEM.md §5]`,
    `sea rule: heights < 0 -> 0 (clamped ${fmtInt(r.sea.clampedCells)} cells)`,
    `heights (m, orthometric EGM2008): raw min ${fmt(r.rawStats.min)} max ${fmt(r.rawStats.max)} mean ${fmt(r.rawStats.mean, 4)} | clamped min ${fmt(r.clampedStats.min)} max ${fmt(r.clampedStats.max)} mean ${fmt(r.clampedStats.mean, 4)}`,
    `  zero cells: ${fmtInt(r.sea.zeroCells)} (${(r.sea.zeroFraction * 100).toFixed(2)}% of window) — ocean/plain; WBM water-mask refinement is a LATER bake step (DATA_SOURCES.md)`,
    '',
    `timings: read ${fmt(t.readMs, 1)} ms | mosaic ${fmt(t.mosaicMs, 1)} ms | sea rule ${fmt(t.seaRuleMs, 1)} ms | decimate ${fmt(t.decimateMs, 1)} ms | glb ${fmt(t.glbMs, 1)} ms | write ${fmt(t.writeMs, 1)} ms | verify ${fmt(t.verifyMs, 1)} ms | hashes ${fmt(t.hashesMs, 1)} ms | total ${fmt(t.totalMs, 1)} ms`,
    `mesh: ${fmtInt(r.mesh.vertexCount)} vertices, ${fmtInt(r.mesh.triangleCount)} triangles (maxError ${r.mesh.maxErrorMetres} m, achieved ${fmt(r.mesh.achievedMaxErrorMetres)} m, rmsd ${fmt(r.mesh.rmsdMetres, 4)} m)`,
    `  winding: ${fmtInt(r.mesh.flippedWinding)} triangles flipped to CCW-from-above, ${fmtInt(r.mesh.degenerateTriangles)} degenerate`,
    `  bbox (m, local ENU): min (${fmt(r.mesh.bboxLocalEnuMetres.min[0])}, ${fmt(r.mesh.bboxLocalEnuMetres.min[1])}, ${fmt(r.mesh.bboxLocalEnuMetres.min[2])})  max (${fmt(r.mesh.bboxLocalEnuMetres.max[0])}, ${fmt(r.mesh.bboxLocalEnuMetres.max[1])}, ${fmt(r.mesh.bboxLocalEnuMetres.max[2])})`,
    `glb: ${fmtInt(r.glb.bytes)} B (JSON chunk ${fmtInt(r.glb.jsonChunkBytes)} B + BIN chunk ${fmtInt(r.glb.binChunkBytes)} B) — structural verification PASSED (${r.verify.checkCount} checks)`,
    `  vertex spot-checks vs grid: ${r.verify.spotChecks.checked - r.verify.spotChecks.failures.length}/${r.verify.spotChecks.checked} exact (f32 bitwise)`,
    `  corner vertices: ${r.verify.corners.filter((c) => c.present).length}/4 present`,
    '',
    'outputs:',
    `  ${r.outputs.glbPath}`,
    `  ${r.outputs.manifestPath}`,
    'NOTE: .bake/ is gitignored — the repo artifact is tools/bake/terrain.mjs; outputs are regenerable by re-running it (DATA_SOURCES.md). No manifest copy is kept in the repo tree.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Runs the full bake and returns the measured report. Options exist for
 * tests (redirect output); the CLI uses the defaults.
 *
 * @param {{demDir?: string, outDir?: string, logPath?: string, quiet?: boolean}} [options]
 */
export async function bake(options = {}) {
  const demDir = options.demDir ?? path.join(REPO_ROOT, '.bake', 'dem');
  const outDir = options.outDir ?? path.join(REPO_ROOT, '.bake', 'meshes');
  const logPath = options.logPath ?? path.join(REPO_ROOT, 'tools', 'bake', 'last-run.log');
  const quiet = options.quiet ?? false;

  const t0 = performance.now();
  // Wall clock is legitimate here: bake-provenance stamp only. It never feeds
  // simulation state (COORDINATE_SYSTEM.md §4 owns worldTime; Law-compliant
  // simulation paths use monotonic clocks — this is a build tool).
  const wallClockUtc = new Date().toISOString();

  const toolVersions = { geotiff: pkgVersion('geotiff'), delatin: pkgVersion('delatin'), node: process.version };
  const generator = `kwetu tools/bake/terrain.mjs (geotiff ${toolVersions.geotiff}, delatin ${toolVersions.delatin}, node ${toolVersions.node})`;

  // 1. read — hashes first: refuse a drifted local copy before doing any work.
  const hashT0 = performance.now();
  const tiles = [];
  for (const source of SOURCE_TILES) {
    const filePath = path.join(demDir, source.file);
    const hashes = await fileHashes(filePath);
    if (hashes.md5 !== source.etagMd5) {
      throw new Error(
        `${source.file}: local md5 ${hashes.md5} != pinned upstream ETag ${source.etagMd5} — the local copy drifted or the upstream object changed. Update the SOURCE_TILES pin consciously (DATA_SOURCES.md row version), never silently.`,
      );
    }
    const tile = await loadTile({ ...source, file: filePath });
    tiles.push({ source, filePath, hashes, tile });
  }
  const hashesMs = performance.now() - hashT0;
  const readMs = tiles.reduce((sum, e) => sum + e.tile.readMs, 0);

  // 2. plan + mosaic
  const mosaicT0 = performance.now();
  const plan = planGrid(tiles.map((e) => e.tile), WINDOW_DEG);
  const { grid, contributions, stats: rawStats } = mosaic(
    plan,
    new Map(tiles.map((e) => [e.tile.name, e.tile])),
  );
  const mosaicMs = performance.now() - mosaicT0;

  // 3. sea rule
  const seaT0 = performance.now();
  const sea = applySeaRule(grid);
  const seaRuleMs = performance.now() - seaT0;

  // 4. decimate — anchor is the grid's south-west node (Frame.Enu anchor)
  const anchorLatDeg = plan.cornersDeg.southWest.latitudeDeg;
  const spacing = enuSpacingMetres(anchorLatDeg);
  const mesh = buildMesh(grid, plan.cols, plan.rows, spacing, MAX_ERROR_METRES);

  // 5. pack glb
  const glbT0 = performance.now();
  const glb = buildGlb(mesh, generator);
  const glbMs = performance.now() - glbT0;

  // 6. write the glb, then verify the bytes ON DISK (a broken glTF poisons the
  //    runtime — verification is part of the bake, not an afterthought).
  const glbPath = path.join(outDir, OUTPUTS.glbFile);
  const manifestPath = path.join(outDir, OUTPUTS.manifestFile);
  let writeMs = 0;
  const write = async (p, data) => {
    const w0 = performance.now();
    await fsp.writeFile(p, data);
    writeMs += performance.now() - w0;
  };
  await fsp.mkdir(outDir, { recursive: true });
  await write(glbPath, glb.glb);

  const verifyT0 = performance.now();
  const verify = verifyGlb(await fsp.readFile(glbPath));
  const spotChecks = spotCheckHeights(verify.positions, grid, plan.cols, plan.rows, spacing);
  if (spotChecks.failures.length > 0) {
    throw new Error(`vertex spot-checks failed: ${JSON.stringify(spotChecks.failures.slice(0, 4))}`);
  }
  const corners = checkCorners(verify.positions, plan.cols, plan.rows, spacing);
  if (corners.some((c) => !c.present)) {
    throw new Error(`grid corner vertices missing: ${JSON.stringify(corners)}`);
  }
  const verifyMs = performance.now() - verifyT0;

  // Second-order tangent-plane omission, quantified for the manifest [derived]:
  // the ellipsoid falls away from the anchor's tangent plane by x²/(2N) + y²/(2M).
  const phiAnchor = (anchorLatDeg * Math.PI) / 180;
  const extentEastMetres = (plan.cols - 1) * spacing.eastWestMetres;
  const extentNorthMetres = (plan.rows - 1) * spacing.northSouthMetres;
  const tangentPlaneDropAtFarCornerMetres =
    extentEastMetres ** 2 / (2 * primeVerticalRadiusMetres(phiAnchor)) +
    extentNorthMetres ** 2 / (2 * meridionalRadiusMetres(phiAnchor));

  // 7. manifest — built after verification so `checks` carries measured results
  const manifest = {
    schema: 'kwetu.bake.terrain-manifest/0.1',
    artifact: {
      file: OUTPUTS.glbFile,
      format: 'glTF 2.0 (GLB), single primitive, TRIANGLES (mode 4)',
      bytes: glb.glb.length,
      jsonChunkBytes: glb.jsonChunkBytes,
      binChunkBytes: glb.binChunkBytes,
      generator,
    },
    generatedBy: 'tools/bake/terrain.mjs',
    bakedAtUtc: `${wallClockUtc} [MEASURED — wall clock, bake provenance only; not a simulation instant (COORDINATE_SYSTEM.md §4)]`,
    region: { name: 'stone-town', description: 'Stone Town / Zanzibar Town window, Zanzibar (Tanzania)' },
    georef: {
      frame: 'Frame.Enu(anchor) — COORDINATE_SYSTEM.md §1/§8; the LocalScene axes for this tile',
      anchor: {
        latitudeDeg: anchorLatDeg,
        longitudeDeg: plan.cornersDeg.southWest.longitudeDeg,
        heightModel: 'anchor at 0 m orthometric = local mean sea level (Law G-1: sea level is not h = 0 ellipsoidally; the ellipsoidal placement is deferred, see verticalDatum)',
      },
      axes: '+x east, +y north, +z up (Z-up ENU). NOT the glTF +Y-up convention — convert explicitly on load (COORDINATE_SYSTEM.md §8: Three.js asset defaults must not silently redefine ENU).',
      gridCornersDeg: plan.cornersDeg,
      grid: {
        cols: plan.cols,
        rows: plan.rows,
        nodeCount: plan.nodeCount,
        nodeSpacingDeg: 1 / ARCSEC_PER_DEG,
        rasterType: 'pixel-is-point (GTRasterTypeGeoKey 2): each node sits exactly on its recorded coordinate',
        windowRequestedDeg: WINDOW_DEG,
      },
      nodeSpacingMetres: {
        eastWest: spacing.eastWestMetres,
        northSouth: spacing.northSouthMetres,
        derivation: 'dx = N(φ0)·cos(φ0)·(π/648000); dy = M(φ0)·(π/648000); φ0 = anchor latitude [derived]',
        constants: 'WGS84 a = 6378137.0 m, 1/f = 298.257223563, e² = f(2−f) — COORDINATE_SYSTEM.md §5 [EXTERNAL — NGA STND.0036]',
      },
      projection: 'first-order local tangent plane at the anchor; projection constants frozen at φ0. Second-order ellipsoid drop vs the plane at the tile NE corner ≈ ' +
        `${fmt(tangentPlaneDropAtFarCornerMetres, 2)} m [derived — x²/(2N) + y²/(2M) at (${fmt(extentEastMetres, 1)} E, ${fmt(extentNorthMetres, 1)} N)]. Reconciled at the geodesy/planet-renderer boundary (Laws G-2/G-3), not in this bake.`,
      verticalDatum: 'orthometric — metres above the EGM2008 geoid (GLO-30 vertical reference) [EXTERNAL — ESA/Copernicus documentation; provenance owned by DATA_SOURCES.md]. Ellipsoidal conversion h = H + N (Laws G-1/G-2) happens once, in the geodesy bake step — never at runtime, never in a shader.',
    },
    mesh: {
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      maxErrorMetres: MAX_ERROR_METRES,
      achievedMaxErrorMetres: mesh.achievedMaxErrorMetres,
      rmsdMetres: mesh.rmsdMetres,
      decimator: `delatin ${toolVersions.delatin} (Garland/Heckbert greedy-insertion Delaunay)`,
      winding: 're-wound CCW seen from +z (above) in ENU x/y; glTF front faces are CCW',
      windingFlippedTriangleCount: mesh.flippedWinding,
      degenerateTriangleCount: mesh.degenerateTriangles,
      bboxLocalEnuMetres: mesh.bboxLocalEnuMetres,
      positionComponentType: 'FLOAT (5126), VEC3 — f64 math downcast exactly once here (Law P-2)',
      indexComponentType: 'UNSIGNED_INT (5125), SCALAR',
    },
    seaRule: {
      rule: 'heights < 0 clamped to 0 (local mean-sea-level plane). GLO-30 ocean cells measured exactly 0 in this window — 0 negative cells found [MEASURED — full grid scan]; the clamp remains as the standing rule.',
      deferred: 'water-body refinement (WBM water mask + OSM coastline flattening per DATA_SOURCES.md) is a LATER bake step — NOT applied here',
      clampedCellCount: sea.clampedCells,
      zeroCellCount: sea.zeroCells,
      zeroCellFraction: sea.zeroFraction,
      windowStatsOrthometricMetres: { raw: rawStats, clamped: sea.stats },
    },
    source: {
      dataset: 'Copernicus DEM GLO-30',
      mirror: 'AWS Open Data mirror s3://copernicus-dem-30m (https://registry.opendata.aws/copernicus-dem/) [EXTERNAL — per DATA_SOURCES.md]',
      attribution: ATTRIBUTION,
      licenseNote: 'Copernicus DEM licence is a custom terms document (no SPDX id) — attribution string above is the required credit (ATTRIBUTIONS.md#copernicus-dem). This derivative lives in .bake/ (gitignored, regenerable by re-running the bake script).',
      tools: toolVersions,
      tiles: tiles.map((entry) => {
        const tile = entry.tile;
        const contribution = contributions.find((c) => c.name === tile.name);
        return {
          name: tile.name,
          url: `https://copernicus-dem-30m.s3.amazonaws.com/${tile.name}/${tile.name}.tif [EXTERNAL — URL layout verified 2026-09-06, HTTP HEAD 200 OK from dev host]`,
          localFile: path.relative(REPO_ROOT, entry.filePath).replaceAll('\\', '/'),
          retrievalEvidence: `retrieved before this bake; file mtime ${entry.hashes.mtimeUtc} [MEASURED — file mtime is the only retrieval record; the download step keeps no ledger]`,
          upstreamObjectLastModifiedUtc: `${entry.source.upstreamObjectLastModifiedUtc} [MEASURED 2026-09-06 — S3 Last-Modified header]`,
          bytes: entry.hashes.bytes,
          sha256: entry.hashes.sha256,
          md5: entry.hashes.md5,
          md5MatchesUpstreamEtag: entry.hashes.md5 === entry.source.etagMd5,
          upstreamEtagMd5: `${entry.source.etagMd5} [MEASURED 2026-09-06 — S3 ETag via HTTP HEAD]`,
          coverageDeg: {
            west: tile.originLonDeg,
            north: tile.originLatDeg,
            east: tile.originLonDeg + ((tile.width - 1) / ARCSEC_PER_DEG),
            south: tile.originLatDeg - ((tile.height - 1) / ARCSEC_PER_DEG),
            note: '[MEASURED — GeoTIFF tiepoint/resolution tags; pixel-is-point node extent, 3600x3600 nodes at 1 arcsec]',
          },
          nodesContributed: contribution ? contribution.nodes : 0,
        };
      }),
    },
    checks: {
      glbStructuralVerification: `PASS (${verify.checks.length} checks: ${verify.checks.join('; ')})`,
      vertexSpotChecks: `${spotChecks.checked - spotChecks.failures.length}/${spotChecks.checked} re-derived positions match the f32 buffer bitwise`,
      gridCornerVertices: `${corners.filter((c) => c.present).length}/4 present`,
      seaRuleApplied: `${sea.clampedCells} cells clamped; 0 non-finite samples (full grid scan)`,
      localCopyIntegrity: tiles
        .map((e) => `${e.source.file}: md5 == pinned upstream ETag (${e.hashes.md5 === e.source.etagMd5})`)
        .join('; '),
    },
  };

  // 8. manifest + log
  await write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const totalMs = performance.now() - t0;
  const report = {
    wallClockUtc,
    region: manifest.region,
    windowDeg: WINDOW_DEG,
    plan: { cols: plan.cols, rows: plan.rows, nodeCount: plan.nodeCount, cornersDeg: plan.cornersDeg },
    spacing,
    tiles: tiles.map((entry) => {
      const tile = entry.tile;
      return {
        name: tile.name,
        readMs: tile.readMs,
        nodesContributed: contributions.find((c) => c.name === tile.name)?.nodes ?? 0,
        bytes: entry.hashes.bytes,
        sha256: entry.hashes.sha256,
        md5: entry.hashes.md5,
        md5MatchesUpstreamEtag: entry.hashes.md5 === entry.source.etagMd5,
        coverageDeg: {
          west: tile.originLonDeg,
          north: tile.originLatDeg,
          east: tile.originLonDeg + (tile.width - 1) / ARCSEC_PER_DEG,
          south: tile.originLatDeg - (tile.height - 1) / ARCSEC_PER_DEG,
        },
        upstreamObjectLastModifiedUtc: entry.source.upstreamObjectLastModifiedUtc,
      };
    }),
    rawStats,
    clampedStats: sea.stats,
    sea: { clampedCells: sea.clampedCells, zeroCells: sea.zeroCells, zeroFraction: sea.zeroFraction },
    mesh: { ...mesh, maxErrorMetres: MAX_ERROR_METRES },
    glb: { bytes: glb.glb.length, jsonChunkBytes: glb.jsonChunkBytes, binChunkBytes: glb.binChunkBytes },
    verify: { checkCount: verify.checks.length, spotChecks, corners },
    timings: { readMs, mosaicMs, seaRuleMs, decimateMs: mesh.ms, glbMs, writeMs, verifyMs, hashesMs, totalMs },
    outputs: { glbPath, manifestPath, logPath },
  };

  const logText = buildLogText(report);
  await write(logPath, logText);
  if (!quiet) console.log(logText);

  return { report, manifest, logText };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  try {
    await bake();
  } catch (err) {
    console.error(`terrain bake FAILED: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}

// Run only when executed directly (tests import the module instead).
const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryHref) {
  await main();
}
