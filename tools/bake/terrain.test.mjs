// Tests for the terrain bake (tools/bake/terrain.mjs).
//
// Two layers:
//   1. pure-function tests on synthetic grids — lattice planning, mosaic
//      bookkeeping, sea rule, mesh + glb round-trips, corruption detection;
//   2. an integration test that runs the REAL bake against the real
//      .bake/dem tiles when they exist on the host (skipped otherwise —
//      .bake/ is a gitignored, machine-local working area).
//
// Frames: assertions encode the Z-up ENU contract (COORDINATE_SYSTEM.md §8) —
// +x east, +y north, +z up, sea plane at z = 0.

import { afterAll, describe, expect, it } from 'vitest';
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ERROR_METRES,
  OUTPUTS,
  SOURCE_TILES,
  WINDOW_DEG,
  applySeaRule,
  bake,
  buildGlb,
  buildMesh,
  checkCorners,
  enuSpacingMetres,
  meridionalRadiusMetres,
  mosaic,
  planGrid,
  primeVerticalRadiusMetres,
  spotCheckHeights,
  verifyGlb,
} from './terrain.mjs';

const ARCSEC_DEG = 1 / 3600;

/** Builds a synthetic tile with the real GLO-30 conventions (pixel-is-point,
 *  1-arcsec lattice, origin = north-west node). `heightFn(col, row)` sets z. */
function fakeTile(name, originLonDeg, originLatDeg, width, height, heightFn) {
  const samples = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      samples[row * width + col] = heightFn(col, row);
    }
  }
  return { name, originLonDeg, originLatDeg, dxDeg: ARCSEC_DEG, dyDeg: ARCSEC_DEG, width, height, samples };
}

/** Two full-scale (3600x3600 node) fake tiles mirroring the measured real
 *  layout: S06 covers lat [-6,-5], S07 covers lat [-7,-6], both lon [39,40]. */
const s06 = fakeTile('S06', 39, -5, 3600, 3600, (c, r) => 100 + c + r);
const s07 = fakeTile('S07', 39, -6, 3600, 3600, (c, r) => 200 + c + r);

describe('planGrid (1-arcsec lattice bookkeeping)', () => {
  it('maps the real Stone Town window onto the real tile layout', () => {
    const plan = planGrid([s06, s07], WINDOW_DEG);
    expect(plan.cols).toBe(433);
    expect(plan.rows).toBe(361);
    expect(plan.nodeCount).toBe(156313);
    // The window (lat -6.21..-6.11) lies entirely inside S07's [-7,-6];
    // S06 contributes nothing — measured on the real tiles 2026-09-06.
    const byName = Object.fromEntries(plan.ranges.map((r) => [r.name, r.nodes]));
    expect(byName.S06).toBe(0);
    expect(byName.S07).toBe(156313);
    // Corner nodes sit exactly on the requested window bounds.
    expect(plan.cornersDeg.southWest).toEqual({ longitudeDeg: 39.14, latitudeDeg: -6.21 });
    expect(plan.cornersDeg.northEast).toEqual({ longitudeDeg: 39.26, latitudeDeg: -6.11 });
  });

  it('splits a window across two abutting tiles at the 1-arcsec seam', () => {
    // Window lon 0.0005..0.001 (gi 2..3), lat -0.9995..-1.0005: row gj 3599 is
    // tile A's last node row, rows gj 3600-3601 are tile B's first two — the
    // window straddles the -1 deg seam where the real tiles abut.
    const a = fakeTile('A', 0, 0, 3600, 3600, (c, r) => 100 + c);
    const b = fakeTile('B', 0, -1, 3600, 3600, (c, r) => 200 + c);
    const plan = planGrid([a, b], { westDeg: 0.0005, southDeg: -1.0005, eastDeg: 0.001, northDeg: -0.9995 });
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(3);
    const byName = Object.fromEntries(plan.ranges.map((r) => [r.name, r.nodes]));
    expect(byName.A).toBe(2);
    expect(byName.B).toBe(4);

    const { grid } = mosaic(plan, new Map([[a.name, a], [b.name, b]]));
    // Merged-grid row 0 = window north = gj 3599 = tile A row 3599, col 2: 102.
    expect(grid[0 * plan.cols + 0]).toBe(102);
    // Row 1 = gj 3600 = tile B row 0, col 2: 202 — the seam was crossed exactly.
    expect(grid[1 * plan.cols + 0]).toBe(202);
    // Last cell = gj 3601 = tile B row 1, col 3: 203.
    expect(grid[2 * plan.cols + 1]).toBe(203);
  });

  it('refuses overlapping tiles instead of blending them silently', () => {
    const a = fakeTile('A', 39, -6, 3600, 3600, () => 0);
    const b = fakeTile('B', 39, -6, 3600, 3600, () => 1); // same footprint
    expect(() => planGrid([a, b], WINDOW_DEG)).toThrow(/overlap/);
  });

  it('refuses a window the tiles do not cover', () => {
    expect(() => planGrid([s06], WINDOW_DEG)).toThrow(/not covered/); // window is in S07's band
  });
});

describe('sea rule (heights < 0 clamp to 0)', () => {
  it('clamps negatives, counts them, and reports stats', () => {
    const grid = new Float32Array([-3, 0, 2, -0.5, 7]);
    const result = applySeaRule(grid);
    expect(Array.from(grid)).toEqual([0, 0, 2, 0, 7]);
    expect(result.clampedCells).toBe(2);
    expect(result.zeroCells).toBe(3);
    expect(result.stats).toMatchObject({ min: 0, max: 7, mean: 1.8 });
  });
});

describe('WGS84 tangent-plane spacing (COORDINATE_SYSTEM.md §5 constants)', () => {
  it('reproduces the known ellipsoid radii at the equator', () => {
    expect(primeVerticalRadiusMetres(0)).toBeCloseTo(6378137.0, 6); // N(0) = a
    expect(meridionalRadiusMetres(0)).toBeCloseTo(6378137.0 * (1 - 0.0066943799901413165), 3); // M(0) = a(1-e²)
  });

  it('gives ~30.7 m node spacing at the Stone Town anchor latitude', () => {
    const s = enuSpacingMetres(-6.21);
    expect(s.eastWestMetres).toBeGreaterThan(30.7);
    expect(s.eastWestMetres).toBeLessThan(30.8);
    expect(s.northSouthMetres).toBeGreaterThan(30.7);
    expect(s.northSouthMetres).toBeLessThan(30.8);
  });
});

describe('buildMesh (delatin + ENU positions + winding)', () => {
  const COLS = 64;
  const ROWS = 64;
  const spacing = { eastWestMetres: 30, northSouthMetres: 31 };
  // Gentle deterministic terrain in f32, plus a flat ocean corner (z=0).
  const grid = new Float32Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      grid[row * COLS + col] =
        col < 8 && row < 8 ? 0 : 2 + 0.08 * col + 0.05 * row + 3 * Math.sin(col / 7) * Math.cos(row / 9);
    }
  }
  const mesh = buildMesh(grid, COLS, ROWS, spacing, 0.25);

  it('meets the maxError budget and triangulates the full grid', () => {
    expect(mesh.vertexCount).toBeGreaterThanOrEqual(4);
    expect(mesh.triangleCount).toBeGreaterThanOrEqual(2);
    expect(mesh.achievedMaxErrorMetres).toBeLessThanOrEqual(0.25 + 1e-12);
  });

  it('emits Z-up ENU positions: x/y from grid indices, y north, z = heights', () => {
    // SW origin: min corner at (0, 0); heights are non-negative post-clamp.
    expect(mesh.bboxLocalEnuMetres.min[0]).toBe(0);
    expect(mesh.bboxLocalEnuMetres.min[1]).toBe(0);
    expect(mesh.bboxLocalEnuMetres.min[2]).toBeGreaterThanOrEqual(0);
    // North edge maps to y = (rows-1)·dy, east edge to x = (cols-1)·dx.
    expect(mesh.bboxLocalEnuMetres.max[0]).toBe(Math.fround((COLS - 1) * spacing.eastWestMetres));
    expect(mesh.bboxLocalEnuMetres.max[1]).toBe(Math.fround((ROWS - 1) * spacing.northSouthMetres));
    // The TIN is a vertex SUBSET of the grid, so the peak node may be unselected;
    // delatin's contract bounds the surface (hence the max vertex z, a linear
    // surface peaking at a vertex) within achievedMaxError of the grid max.
    const gridMax = Math.max(...grid);
    expect(mesh.bboxLocalEnuMetres.max[2]).toBeLessThanOrEqual(gridMax);
    expect(mesh.bboxLocalEnuMetres.max[2]).toBeGreaterThanOrEqual(gridMax - mesh.achievedMaxErrorMetres - 1e-9);
  });

  it('winds every triangle CCW seen from above (+z)', () => {
    let cw = 0;
    let degenerate = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
      const ax = mesh.positions[3 * a], ay = mesh.positions[3 * a + 1];
      const cross =
        (mesh.positions[3 * b] - ax) * (mesh.positions[3 * c + 1] - ay) -
        (mesh.positions[3 * b + 1] - ay) * (mesh.positions[3 * c] - ax);
      if (cross < 0) cw++;
      if (cross === 0) degenerate++;
    }
    expect(cw).toBe(0);
    expect(degenerate).toBe(mesh.degenerateTriangles);
  });

  it('keeps all four grid corner nodes as vertices', () => {
    const corners = checkCorners(mesh.positions, COLS, ROWS, spacing);
    expect(corners.every((c) => c.present)).toBe(true);
  });

  it('spot-checks vertex heights against the source grid bitwise', () => {
    const result = spotCheckHeights(mesh.positions, grid, COLS, ROWS, spacing, 64);
    expect(result.checked).toBe(64);
    expect(result.failures).toEqual([]);
  });

  it('is deterministic (bitwise-identical meshes across runs)', () => {
    const again = buildMesh(grid, COLS, ROWS, spacing, 0.25);
    expect(again.positions).toEqual(mesh.positions);
    expect(again.indices).toEqual(mesh.indices);
  });
});

describe('glTF 2.0 GLB container (writer + independent verifier)', () => {
  const grid = new Float32Array(16 * 16);
  for (let i = 0; i < grid.length; i++) grid[i] = (i % 16) * 0.75 + Math.floor(i / 16) * 0.5;
  const spacing = { eastWestMetres: 30, northSouthMetres: 30 };
  const mesh = buildMesh(grid, 16, 16, spacing, MAX_ERROR_METRES);
  const glb = buildGlb(mesh, 'test-generator');

  it('round-trips through the independent verifier', () => {
    const parsed = verifyGlb(glb.glb);
    expect(parsed.vertexCount).toBe(mesh.vertexCount);
    expect(parsed.triangleCount).toBe(mesh.triangleCount);
    expect(parsed.checks.length).toBeGreaterThanOrEqual(20);
    expect(parsed.positions).toEqual(mesh.positions);
    expect(parsed.indices).toEqual(mesh.indices);
  });

  it('reports container byte accounting exactly', () => {
    const posBytes = mesh.positions.byteLength;
    const idxBytes = mesh.indices.byteLength;
    expect(glb.jsonChunkBytes % 4).toBe(0);
    expect(glb.binChunkBytes).toBe(posBytes + idxBytes);
    expect(glb.glb.length).toBe(12 + 8 + glb.jsonChunkBytes + 8 + glb.binChunkBytes);
  });

  it('rejects a corrupted container instead of blessing it', () => {
    const badTotal = Buffer.from(glb.glb);
    badTotal.writeUInt32LE(badTotal.length + 1, 8); // header total length now wrong
    expect(() => verifyGlb(badTotal)).toThrow(/total length/);

    const badChunk = Buffer.from(glb.glb);
    badChunk.writeUInt32LE(0xdeadbeef, 20 + glb.jsonChunkBytes + 4); // BIN chunk type mangled
    expect(() => verifyGlb(badChunk)).toThrow(/BIN chunk/);

    const truncated = glb.glb.subarray(0, glb.glb.length - 8);
    expect(() => verifyGlb(truncated)).toThrow();
  });
});

describe('bake() integration — real Copernicus GLO-30 tiles', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const demDir = path.join(repoRoot, '.bake', 'dem');
  const tmpRoot = path.join(repoRoot, 'tools', 'bake', 'tmp'); // gitignored ('tmp/')
  let outDir;

  const tilesPresent = SOURCE_TILES.every((t) => fsSync.existsSync(path.join(demDir, t.file)));

  it.skipIf(!tilesPresent)(
    'bakes the Stone Town window end-to-end and verifies its own glb',
    async () => {
      await fsp.mkdir(tmpRoot, { recursive: true }); // mkdtemp does not create parents
      outDir = await fsp.mkdtemp(path.join(tmpRoot, 'terrain-test-'));
      const { report, manifest } = await bake({
        demDir,
        outDir,
        logPath: path.join(outDir, 'last-run.log'),
        quiet: true,
      });

      // Measured on 2026-09-06: 433x361 nodes, all from the S07 tile.
      expect(report.plan.nodeCount).toBe(156313);
      expect(report.plan.cols).toBe(433);
      expect(report.plan.rows).toBe(361);
      expect(report.mesh.triangleCount).toBeGreaterThan(1000);
      expect(report.mesh.achievedMaxErrorMetres).toBeLessThanOrEqual(MAX_ERROR_METRES);
      expect(report.verify.checkCount).toBeGreaterThanOrEqual(20);
      expect(report.verify.spotChecks.failures).toEqual([]);
      expect(report.verify.corners.every((c) => c.present)).toBe(true);
      expect(report.sea.clampedCells).toBe(0); // measured: no negative heights in this window

      // Artifacts exist and the manifest records a passing verification.
      const glbStat = await fsp.stat(path.join(outDir, OUTPUTS.glbFile));
      expect(glbStat.size).toBe(report.glb.bytes);
      expect(glbStat.size).toBeGreaterThan(500_000);
      const manifestOnDisk = JSON.parse(await fsp.readFile(path.join(outDir, OUTPUTS.manifestFile), 'utf8'));
      expect(manifestOnDisk.checks.glbStructuralVerification).toMatch(/^PASS/);
      expect(manifestOnDisk.georef.gridCornersDeg.southWest).toEqual({ longitudeDeg: 39.14, latitudeDeg: -6.21 });
      expect(manifestOnDisk.source.tiles).toHaveLength(SOURCE_TILES.length);
      expect(manifestOnDisk.source.tiles.every((t) => t.md5MatchesUpstreamEtag)).toBe(true);
    },
    60_000, // real-data bake: downloads/decodes Copernicus GLO-30 tiles; measured >5s
  );

  afterAll(async () => {
    if (outDir) await fsp.rm(outDir, { recursive: true, force: true });
  });
});
