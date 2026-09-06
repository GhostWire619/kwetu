import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 800, height: 500 } });

test('surface mode walks, enters, drives, exits and resets', async ({ page }) => {
  // [MEASURED 2026-09-06] 120 s passed in isolation (4.9 s chromium / 10.6 s
  // firefox) but failed in the full parallel suite: fullyParallel x 2 browsers
  // runs 10 SwiftShader software-GL workers at once, and Rapier WASM init +
  // terrain parse starve past the budget. 180 s matches region.pw.ts's
  // heavy-test budget; the functional assertions below stay tight.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/client/index.html?mode=surface');
  // Same headroom for the ready wait: WASM + 700 KB GLB under worker load.
  await page.waitForFunction(() => window.__kwetuSurface?.state === 'ready', undefined, { timeout: 90_000 });

  const start = await page.evaluate(() => window.__kwetuSurface!.character!);
  // All drive sections hold the key UNTIL the assertion passes instead of
  // assuming a fixed wall-clock duration delivers enough fixed-tick physics
  // steps: [MEASURED 2026-09-06] under the full 10-worker SwiftShader suite,
  // 1400 ms of wall clock ran too few steps and the car was still
  // decelerating (+2.11 m/s) when S released — with no rolling drag modelled
  // it then coasted at constant speed forever. Holding through the poll
  // asserts the same control behaviour more strongly and survives load.
  const pollTimeout = 30_000;
  await page.keyboard.down('KeyW');
  await expect.poll(async () => {
    const c = await page.evaluate(() => window.__kwetuSurface!.character!);
    return Math.hypot(c.x - start.x, c.y - start.y);
  }, { timeout: pollTimeout }).toBeGreaterThan(0.3);
  await page.keyboard.up('KeyW');

  await page.evaluate(() => window.__kwetuSurface!.teleportNearCar());
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.mode)).toBe('drive');
  const carStart = await page.evaluate(() => window.__kwetuSurface!.vehicle!);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1100);
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.vehicle!.speed), { timeout: pollTimeout }).toBeGreaterThan(0);
  await page.keyboard.up('KeyW');
  const carMoved = await page.evaluate(() => window.__kwetuSurface!.vehicle!);
  expect(Math.hypot(carMoved.x - carStart.x, carMoved.y - carStart.y)).toBeGreaterThan(0.1);
  expect(carMoved.speed).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => {
    const { yawRad } = window.__kwetuSurface!.camera!;
    const { headingRad } = window.__kwetuSurface!.vehicle!;
    return Math.abs(Math.atan2(Math.sin(yawRad - headingRad), Math.cos(yawRad - headingRad)));
  })).toBeLessThan(0.2);

  await page.keyboard.down('KeyS');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.vehicle!.speed), { timeout: pollTimeout }).toBeLessThan(0);
  await page.keyboard.up('KeyS');

  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.mode)).toBe('walk');
  await page.keyboard.press('KeyR');
  const reset = await page.evaluate(() => window.__kwetuSurface!.character!);
  expect(Math.abs(reset.x - 6686)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
