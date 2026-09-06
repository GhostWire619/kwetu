/**
 * S0.11 — Playwright configuration (ROADMAP §5 S0.11, ADR-011).
 *
 * Two browser projects (Chromium AND Firefox), headless, retries 0.
 *
 * webServer: the ONLY thing that needs a server is the three.js render smoke
 * (tests/e2e/three-render-smoke.pw.ts), which loads its fixture through the
 * vite dev server on port 5199 so the page can `import * as THREE from
 * 'three'` and get the real pinned dependency from node_modules. The WebGL2
 * smoke (webgl2-smoke.pw.ts) is deliberately self-contained — it never
 * touches the server, so it would also run with `webServer: none`; the server
 * exists for the second spec. (The S0.11 task brief's "webServer: none" and
 * its vite-webServer instruction for the three fixture conflict; this config
 * resolves that by keeping the smoke self-contained and scoping the server to
 * the fixture spec. Recorded in ADR-011 §Decision.)
 *
 * Run: `npm run test:e2e` (wired in package.json 2026-09-06).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // `*.pw.ts`, not the conventional `*.spec.ts`: vitest's default include
  // (**/*.{test,spec}.ts) also globs `tests/e2e/*.spec.ts` and fails
  // collecting Playwright's test() calls, which would break `npm test`
  // (measured 2026-09-06). The `.pw.ts` extension is invisible to vitest and
  // claimed here via testMatch. vitest.config.ts is outside this spike's
  // write scope, so the rename lives on this side of the boundary.
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],

  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    // 127.0.0.1, not localhost: vite dev binds IPv6 ::1 by default on this
    // host and the IPv4 poller times out waiting for it (measured
    // 2026-09-06) — pin both sides of the webServer handshake to IPv4.
    baseURL: 'http://127.0.0.1:5199/',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Force SwiftShader (software ANGLE) so the smoke proves the
            // WebGL2 pipeline itself, not this machine's GPU drivers.
            '--use-angle=swiftshader',
          ],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'webgl.force-enabled': true,
            'webgl.disabled': false,
          },
        },
      },
    },
  ],

  webServer: {
    // node invoked directly (not `npx vite`): Node 24 refuses to spawn .cmd
    // shims without a shell (spawn npx.cmd -> EINVAL, measured 2026-09-06),
    // which silently burned the whole webServer timeout. Direct node works
    // identically on CI and skips npx resolution.
    command: 'node node_modules/vite/bin/vite.js --port 5199 --strictPort --host 127.0.0.1',
    // Readiness URL is the fixture page itself: Phase 0 has no root
    // index.html, so '/' 404s and Playwright would wait out the full
    // timeout even with the server up (measured 2026-09-06).
    url: 'http://127.0.0.1:5199/tests/e2e/fixtures/three-render.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
