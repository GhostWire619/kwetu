// GPU idle-stability baselines behind the banded bounds in
// tests/e2e/fly.pw.ts (GPU_GROUND_MAX_CHANNEL_DELTA /
// GPU_FARFIELD_MAX_CHANNEL_DELTA / GPU_MAX_CHANGED_PIXEL_FRACTION).
//
// Replicates the e2e flight (integration legs + setCameraAltitude snaps +
// 30 advance(1/60) + renderFrame() frames per stop, full-canvas readback via
// the app's readCanvasRgba debug surface) against a dev server, and dumps
// per-stop worst channel delta with its pixel location and colours.
//
// Measured verdict (2026-09-06, both browsers, sequential runs — the state in
// which the baselines were taken):
//   - Ground-filled stops (1 m … 1e6 m): idle max channel delta 1 — the sun
//     light's f32 position stepping flipping shading by one quantum.
//   - Far-field stops (1e7 … 1e10 m): idle max delta 1 typically; one
//     parallel-worker e2e observation of 16 (Firefox, 1e9 m) — consistent
//     with the Moon's f32-stepped silhouette transiting the frame, which is
//     why the far-field band is wider (see the constants' header in fly.pw.ts).
//   - Changed pixels: <= 1363 px per frame pair of 230400 (~5e-4 fraction).
//
// Run: node tools/measure/gpu-stability.mjs   (spawns its own dev server on
// port 5215, runs chromium then firefox, prints one JSON line per stop).
// Not part of the app or its test suite.
import { firefox, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 5215;
const STOPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10]; // mirrors fly.pw.ts
const FRAMES = 30; // mirrors JITTER_FRAMES

const server = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

async function waitReady(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('dev server never became ready');
}

const BASE = `http://127.0.0.1:${PORT}/client/index.html`;

try {
  await waitReady(BASE);
  for (const [label, launch] of [
    ['chromium', () => chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] })],
    ['firefox', () => firefox.launch({ headless: true, firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } })],
  ]) {
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForFunction(() => {
      const d = window.__kwetuDebug;
      return d !== undefined && d.frameCount >= 1;
    }, undefined, { timeout: 60000 });

    let previous = null;
    for (const altitude of STOPS) {
      const flyTheLeg = previous !== null;
      previous = altitude;
      const out = await page.evaluate(({ frames, target, flyLeg }) => {
        const d = window.__kwetuDebug;
        const before = Number(d.cameraAltitudeMetres);
        if (flyLeg && target > before) {
          const distance = target - before;
          const speed = Math.min(distance, 1e9);
          d.setFlightInput({ up: true });
          d.setSpeed(speed);
          d.advance(distance / speed);
          d.setFlightInput({});
        }
        d.setCameraAltitude(target);
        d.orientToPlanetCenter();
        d.renderFrame();
        const rows = [];
        let prev = null;
        let changed = 0;
        for (let i = 0; i < frames; i++) {
          d.advance(1 / 60);
          d.renderFrame();
          const grab = d.readCanvasRgba();
          if (grab === null) throw new Error('readCanvasRgba: GL readPixels failed');
          if (prev !== null) {
            let maxDelta = 0;
            let arg = -1;
            for (let j = 0; j < grab.rgba.length; j += 4) {
              const m = Math.max(
                Math.abs(grab.rgba[j] - prev[j]),
                Math.abs(grab.rgba[j + 1] - prev[j + 1]),
                Math.abs(grab.rgba[j + 2] - prev[j + 2]),
              );
              if (m > 0) changed++;
              if (m > maxDelta) { maxDelta = m; arg = j; }
            }
            if (maxDelta > 0) {
              rows.push({
                frame: i, maxDelta,
                px: Math.round((arg / 4) % grab.width),
                py: Math.floor(arg / 4 / grab.width),
                from: [prev[arg], prev[arg + 1], prev[arg + 2]],
                to: [grab.rgba[arg], grab.rgba[arg + 1], grab.rgba[arg + 2]],
              });
            }
          }
          prev = grab.rgba;
        }
        return { before, rows, changed };
      }, { frames: FRAMES, target: altitude, flyLeg: flyTheLeg });
      const worst = out.rows.reduce((a, b) => (b.maxDelta > (a?.maxDelta ?? 0) ? b : a), null);
      console.log(JSON.stringify({ browser: label, altitude, changedPx: out.changed, worst, errors }));
    }
    await browser.close();
  }
} finally {
  server.kill();
}
