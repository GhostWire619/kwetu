import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 800, height: 500 } });

test('surface mode walks, enters, drives, exits and resets', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/client/index.html?mode=surface');
  await page.waitForFunction(() => window.__kwetuSurface?.state === 'ready', undefined, { timeout: 60_000 });

  const start = await page.evaluate(() => window.__kwetuSurface!.character!);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyW');
  const walked = await page.evaluate(() => window.__kwetuSurface!.character!);
  expect(Math.hypot(walked.x - start.x, walked.y - start.y)).toBeGreaterThan(0.3);

  await page.evaluate(() => window.__kwetuSurface!.teleportNearCar());
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.mode)).toBe('drive');
  const carStart = await page.evaluate(() => window.__kwetuSurface!.vehicle!);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1100);
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
  await page.waitForTimeout(1400);
  await page.keyboard.up('KeyS');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.vehicle!.speed)).toBeLessThan(0);

  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__kwetuSurface!.mode)).toBe('walk');
  await page.keyboard.press('KeyR');
  const reset = await page.evaluate(() => window.__kwetuSurface!.character!);
  expect(Math.abs(reset.x - 6686)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
