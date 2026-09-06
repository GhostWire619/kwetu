/**
 * S0.11 — three.js render smoke through the vite dev server.
 *
 * The second half of "can CI see the game at all": the pinned three
 * dependency (node_modules, resolved by vite) initializes its WebGL2
 * renderer in headless Chromium AND headless Firefox and rasterizes a frame
 * whose pixels we can read back.
 *
 * The fixture (tests/e2e/fixtures/three-render.html) is a module page served
 * by `npx vite --port 5199 --strictPort` (see playwright.config.ts) — vite
 * resolves the bare 'three' import to the installed pinned version, so the
 * smoke exercises the REAL dependency, not a CDN copy.
 *
 * The fixture captures the readback (readPixels of a centre patch + renderer
 * info) synchronously after render into window.__threeRender, so the test
 * never races the compositor's buffer clear.
 */
import { expect, test } from '@playwright/test';

interface ThreeRenderInfo {
  threeRevision: string;
  isWebGL2: boolean;
  drawCalls: number;
  triangles: number;
  nonBlackPixels: number;
  readbackRgba: number[];
  contextLost: boolean;
}

test('three.js renders a frame headless with pixel readback', async ({ page, browserName }) => {
  await page.goto('/tests/e2e/fixtures/three-render.html');
  const handle = await page.waitForFunction(
    (): ThreeRenderInfo | null =>
      (window as { __threeRender?: ThreeRenderInfo }).__threeRender ?? null,
    undefined,
    { timeout: 15_000 },
  );
  const info = (await handle.jsonValue()) as ThreeRenderInfo;

  console.log(`[three-render-smoke ${browserName}]`, JSON.stringify(info));

  expect(info.threeRevision).toBe('185'); // pinned: three 0.185.1
  expect(info.isWebGL2).toBe(true);
  expect(info.drawCalls).toBe(1);
  expect(info.triangles).toBe(2);
  expect(info.contextLost).toBe(false);
  expect(info.nonBlackPixels).toBeGreaterThan(0);
  // MeshBasicMaterial 0xff4080 = (255, 64, 128); colour space converts to
  // sRGB output — assert the red channel is decisively present and green/blue
  // present but strictly darker than red.
  const r = info.readbackRgba[0] ?? 0;
  const g = info.readbackRgba[1] ?? 0;
  const b = info.readbackRgba[2] ?? 0;
  expect(r).toBeGreaterThanOrEqual(200);
  expect(g).toBeLessThan(r);
  expect(b).toBeGreaterThan(g);
});
