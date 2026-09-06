/**
 * Phase 2 — region terrain streaming e2e (the automated portion of the
 * Phase-2 exit criterion's terrain tier; ROADMAP §3.2 B-REG-03).
 *
 * What is proven, in order:
 *   1. SERVING PATH: the region data middleware serves the baked GLB with
 *      `Accept-Ranges: bytes`, honours a single-range request (206 +
 *      Content-Range) and returns the exact artifact length — the range
 *      capability the "streamed over range requests" criterion rests on.
 *      (The PMTiles vector basemap, L1, rides the same middleware; its
 *      in-browser MapLibre UI is not built yet, so it is NOT claimed here.)
 *   2. STREAM + VALIDATION: booting the shell with ?region=stone-town fetches
 *      manifest + GLB through the app's real RegionTerrain path, which
 *      revalidates the decoded mesh against the manifest (vertex/triangle
 *      counts, bbox) — a corrupted or axis-broken artifact fails the boot
 *      state machine, and the e2e asserts `ready` plus the exact counts.
 *   3. MOUNT: the camera boots at the region anchor (the [PLACEHOLDER —
 *      ADR-003] placeholder-sphere mount; lat is asserted within the
 *      geodetic↔geocentric deflection band, altitude exactly, longitude
 *      exactly), the tile is geometrically in front (projectPoint), and it
 *      actually RENDERS — the draw-call triangle count rises by the tile's
 *      39,301 triangles on top of the empty-shell floor (light-independent:
 *      a night-side boot still draws).
 *   4. STABILITY: real fixed-tick frames advance with zero console/page
 *      errors, all exposed values finite, and dispose is clean — the same
 *      discipline as fly.pw.ts.
 *
 * Skipped (with reason) on machines without the gitignored bake artifact.
 * SwiftShader caveat: no fps or fidelity claim.
 */
import { existsSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { KwetuDebug } from '../../client/src/app/debugTypes';

const GLB_PATH = '.bake/meshes/stone-town.terrain.glb';
const GLB_URL = '/data/region/stone-town.terrain.glb';
const MANIFEST_URL = '/data/region/stone-town.terrain.manifest.json';
/** [MEASURED 2026-09-06] the baked artifact (manifest artifact.bytes). */
const GLB_BYTES = 709852;
/** [MEASURED 2026-09-06] the bake manifest's mesh record. */
const VERTEX_COUNT = 19777;
const TRIANGLE_COUNT = 39301;
const REGION_LAT = -6.21;
const REGION_LON = 39.14;
const BOOT_ALTITUDE = 300;

const bakedArtifact = existsSync(GLB_PATH) && statSync(GLB_PATH).isFile();

test.skip(!bakedArtifact, `region e2e needs the baked artifact ${GLB_PATH} — run npm run bake:terrain first`);

test.use({ viewport: { width: 640, height: 360 } });

test('region streams over range requests, validates against the manifest, mounts and renders', async ({ page }) => {
  test.setTimeout(180_000);

  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });

  // --- 1. serving path (out-of-page: the API request context) -------------
  const full = await page.request.get(GLB_URL);
  expect(full.status(), 'GLB serves 200').toBe(200);
  expect(full.headers()['accept-ranges'], 'GLB advertises byte ranges').toBe('bytes');
  expect(Number(full.headers()['content-length']), 'GLB length is the baked artifact').toBe(GLB_BYTES);

  const ranged = await page.request.get(GLB_URL, { headers: { Range: 'bytes=0-99' } });
  expect(ranged.status(), 'single-range request is honoured').toBe(206);
  expect(ranged.headers()['content-range']).toBe(`bytes 0-99/${GLB_BYTES}`);
  expect(Number(ranged.headers()['content-length'])).toBe(100);

  const manifestResponse = await page.request.get(MANIFEST_URL);
  expect(manifestResponse.status(), 'manifest serves 200').toBe(200);
  const manifest = (await manifestResponse.json()) as { schema: string; mesh: { vertexCount: number; triangleCount: number } };
  expect(manifest.schema, 'manifest schema').toBe('kwetu.bake.terrain-manifest/0.1');
  expect(manifest.mesh.vertexCount).toBe(VERTEX_COUNT);
  expect(manifest.mesh.triangleCount).toBe(TRIANGLE_COUNT);

  // Measure the shell at the same pose, without terrain. Sphere pole triangles
  // and off-screen Moon culling make a hard-coded whole-scene count incorrect.
  await page.goto('/client/index.html?mode=space');
  await page.waitForFunction(() => window.__kwetuDebug !== undefined);
  const baselineTriangles = await page.evaluate(() => {
    const hook = window.__kwetuDebug!;
    hook.setCameraSite(-6.21, 39.14, 300);
    hook.orientToPlanetCenter();
    const count = hook.renderFrame().triangles;
    hook.dispose();
    return count;
  });

  // --- 2+3. the app's real streaming path ---------------------------------
  await page.goto('/client/index.html?region=stone-town');
  await page.waitForFunction(
    () => {
      const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
      return hook !== undefined && hook.region !== null && hook.region.state === 'ready';
    },
    undefined,
    { timeout: 60_000 },
  );

  const region = await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined || hook.region === null) throw new Error('region debug surface missing');
    return hook.region;
  });
  expect(region.vertexCount, 'decoded vertex count matches the manifest').toBe(VERTEX_COUNT);
  expect(region.triangleCount, 'decoded triangle count matches the manifest').toBe(TRIANGLE_COUNT);
  expect(region.bytesReceived, 'manifest + GLB bytes streamed').toBeGreaterThanOrEqual(GLB_BYTES);
  expect(region.error).toBeNull();

  // Camera booted at the region anchor. Longitude is exact (geodetic lon =
  // geocentric lon); the placeholder sphere uses the geodetic direction as
  // the radial, so the re-derived geodetic latitude sits within the
  // deflection band (~0.04 deg here [derived]) rather than exactly at -6.21.
  const boot = await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    return { anchor: hook.anchorGeodetic, altitude: Number(hook.cameraAltitudeMetres) };
  });
  expect(Math.abs(Number(boot.anchor.latitudeDeg) - REGION_LAT), 'boot latitude at the region (deflection band)').toBeLessThan(0.1);
  expect(Math.abs(Number(boot.anchor.longitudeDeg) - REGION_LON), 'boot longitude at the region').toBeLessThan(1e-6);
  expect(Math.abs(boot.altitude - BOOT_ALTITUDE), 'boot altitude above the placeholder sphere').toBeLessThan(1e-6);

  // The tile anchor is in front of the camera, near frame centre (nadir).
  const projection = await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    hook.orientToPlanetCenter();
    hook.renderFrame();
    // The mount point (sphere + 50 m offset) as a canonical PlanetFixed
    // point, derived from the TILE anchor, not the camera's re-derived
    // WGS84 geodetic anchor. The latter differs from the placeholder sphere's
    // radial latitude and would test a different point kilometres away.
    const anchor = hook.region?.anchor;
    if (anchor === undefined) throw new Error('region anchor missing');
    const r = 6371000 + 50;
    const phi = (Number(anchor.latitudeDeg) * Math.PI) / 180;
    const lam = (Number(anchor.longitudeDeg) * Math.PI) / 180;
    return hook.projectPoint([r * Math.cos(phi) * Math.cos(lam), r * Math.cos(phi) * Math.sin(lam), r * Math.sin(phi)]);
  });
  expect(projection.behind, 'tile anchor in front of the camera').toBe(false);
  expect(Math.abs(projection.xPx - 320), 'tile anchor near frame centre x').toBeLessThan(40);
  expect(Math.abs(projection.yPx - 180), 'tile anchor near frame centre y').toBeLessThan(40);

  // Rendered, not just mounted: the tile adds its 39,301 triangles to the
  // shell's floor (placeholder Earth 65,536 + Moon 9,216 = 74,752; star
  // backdrop is points). Frustum culling is per-object — the tile's bounding
  // sphere (radius ~8.6 km) always intersects a camera sitting on it, so the
  // whole tile counts. Light-independent: draws happen on the night side too.
  const info = await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    return hook.renderFrame();
  });
  expect(info.triangles - baselineTriangles, 'tile triangles actually submitted at the same camera pose').toBe(TRIANGLE_COUNT);

  // --- 4. stability over real fixed-tick frames ----------------------------
  await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    hook.advance(1);
    hook.renderFrame();
  });
  const after = await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    return {
      cameraPos: hook.cameraPos,
      altitude: hook.cameraAltitudeMetres,
      anchor: hook.anchorGeodetic,
      region: hook.region,
    };
  });
  for (const axis of [after.cameraPos.x, after.cameraPos.y, after.cameraPos.z]) {
    expect(Number.isFinite(Number(axis)), `cameraPos axis "${axis}" finite`).toBe(true);
  }
  expect(Number.isFinite(Number(after.altitude)), 'altitude finite').toBe(true);
  expect(after.region?.state, 'region still ready after frames').toBe('ready');
  expect(problems, `no errors: ${problems.join(' | ')}`).toEqual([]);

  await page.evaluate(() => {
    const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (hook === undefined) throw new Error('__kwetuDebug missing');
    hook.dispose();
  });
  expect(problems, `no errors during dispose: ${problems.join(' | ')}`).toEqual([]);
});
