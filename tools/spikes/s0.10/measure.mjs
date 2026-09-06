// S0.10 measurement runner — throwaway Phase-0 spike code (CLAUDE.md
// tools/spikes carve-out).
//
// Usage: node tools/spikes/s0.10/measure.mjs
//
// Two measurement halves, merged into tools/spikes/s0.10/report.json:
//   1. HUD probe (tools/spikes/s0.10/hud/) — 200 live-updating text/stat
//      elements over a three.js scene, rendered as an HTML DOM overlay vs a
//      2D-canvas overlay, in HEADLESS Chromium via Playwright. Headless
//      latency numbers are PROXIES (event.timeStamp -> next rAF timestamp);
//      frame pacing is BeginFrame-driven, not display-driven — the DOM vs
//      canvas RELATIVE comparison is the decision input, not absolute host
//      figures (SwiftShader/CPU GL — the actual renderer string is recorded).
//   2. i18n compiled bundle sizes (locales/en|sw/translation.json) — run
//      tools/spikes/s0.10/i18n/compile.mjs first if the JSONs are missing.
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);

const FRAMES = 300;          // measured frames per mode
const WARMUP = 60;           // discarded frames per mode
const INPUT_MOVES = 60;      // synthetic pointer moves per mode window
const INPUT_GAP_MS = 100;
const VIEWPORT = { width: 800, height: 600 }; // SwiftShader pixel budget: 1280x800 paced rAF at ~9.5 fps (measured); 800x600 holds ~65 fps

// ------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const abs = path.resolve(repoRoot, rel);
  if (!abs.startsWith(repoRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
    console.error(`[s0.10 server] 404 for ${req.url} (resolved ${abs})`);
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
  res.end(readFileSync(abs));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ------------------------------------------------------------- browser run
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/tools/spikes/s0.10/hud/index.html`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__probeReady === true, null, { timeout: 60000 });
} catch (e) {
  console.error('probe page never became ready. pageErrors:', pageErrors);
  throw e;
}

const env = await page.evaluate(() => ({
  glRenderer: window.__glInfo,
  loafSupported: window.__loafSupported,
  userAgent: navigator.userAgent,
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
}));

const modes = {};
for (const mode of ['dom', 'dom-thrash', 'canvas']) {
  let done = false;
  const runP = page.evaluate(([m, f, w]) => window.__runMode(m, f, w), [mode, FRAMES, WARMUP]);
  const inputLoop = (async () => {
    for (let k = 0; k < INPUT_MOVES && !done; k++) {
      await page.mouse.move(120 + ((k * 67) % 1000), 90 + ((k * 43) % 620));
      await page.waitForTimeout(INPUT_GAP_MS);
    }
  })();
  const result = await runP;
  done = true;
  await inputLoop;
  modes[mode] = result;
  console.log(
    `${mode.padEnd(11)} update p50 ${result.hudUpdateCost.p50Ms.toFixed(3)} ms  p95 ${result.hudUpdateCost.p95Ms.toFixed(3)} ms` +
    ` | frame p50 ${result.frameInterval.p50Ms.toFixed(2)} ms  >16.7ms ${result.frameInterval.overBudget}/${result.frameInterval.n}` +
    ` | input->paint p50 ${result.inputToPaintLatencyProxy.p50Ms.toFixed(2)} ms`,
  );
}

const browserVersion = browser.version();
await browser.close();
server.close();

// ------------------------------------------------------------- i18n bundle sizes
function bundleSize(rel) {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs);
  return {
    path: rel.replaceAll('\\', '/'),
    rawBytes: raw.length,
    gzip9Bytes: gzipSync(raw, { level: 9 }).length,
  };
}
const enBundle = bundleSize('locales/en/translation.json');
const swBundle = bundleSize('locales/sw/translation.json');
const i18nBundles = {
  method: 'node:fs byte length + node:zlib gzipSync level 9 over the compiled translation.json artifacts',
  en: enBundle,
  sw: swBundle,
  swVsEnRawRatio: enBundle && swBundle ? +(swBundle.rawBytes / enBundle.rawBytes).toFixed(4) : null,
  swVsEnGzip9Ratio: enBundle && swBundle ? +(swBundle.gzip9Bytes / enBundle.gzip9Bytes).toFixed(4) : null,
  note: 'Measured on the S0.10 spike string set (43 msgids -> 45 compiled keys per locale); a different string set shifts the ratio. Compiled by tools/spikes/s0.10/i18n/compile.mjs (i18next-conv 17.0.0).',
};

// ------------------------------------------------------------- report
// three (among others) does not export './package.json' — read the file directly.
const depVersion = (name) =>
  JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;

const cpu = os.cpus()[0]?.model ?? 'unknown';
const report = {
  spike: 'S0.10 — UI stack (DOM vs canvas HUD), i18n pipeline bundle sizes',
  measuredAt: new Date().toISOString(),
  host: {
    os: `${os.type()} ${os.release()}`,
    cpu,
    totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    note: 'Host identity per orchestrator context: Windows 11, Ryzen 7 7445HS, RTX 4050 Laptop 6 GB, 15.2 GB RAM.',
  },
  browser: {
    engine: 'Chromium (headless new) via Playwright',
    playwrightVersion: depVersion('@playwright/test'),
    browserVersion,
    userAgent: env.userAgent,
    glRenderer: env.glRenderer,
    viewport: env.viewport,
    headlessNote:
      'Headless: frame pacing is BeginFrame-driven and GL is software (SwiftShader-class) unless the renderer string says otherwise. ' +
      'Absolute ms figures are headless proxies; only the DOM-vs-canvas relative comparison and the thrash detector behaviour carry decision weight.',
  },
  probe: {
    file: 'tools/spikes/s0.10/hud/probe.js',
    hudElements: 200,
    layout: '5 columns x 40 rows, 12px/14px system-ui, 800x600 viewport (pixel budget chosen so headless rAF paces near 60 Hz; measured 1280x800 paced at ~9.5 fps)',
    domMode: '200 <div class="stat"> (400 nodes incl. label+value spans); per-frame textContent update of the 200 value spans',
    domThrashMode: 'identical DOM plus a forced offsetTop read after every write — 200 forced reflows/frame (hazard demonstration)',
    canvasMode: 'one 2D-canvas overlay: clearRect + 200 label/value fillText calls per frame',
    threeScene: 'wireframe icosahedron + 24 orbiting cubes + 600 point stars (WebGL2, pixelRatio 1) — realistic co-load',
    framesPerMode: FRAMES,
    warmupFramesPerMode: WARMUP,
    inputProxy:
      'pointer-event-to-next-paint latency proxy: last input event.timeStamp minus NEXT requestAnimationFrame timestamp, collected while the runner drives ' + INPUT_MOVES + ' synthetic mouse moves (' + INPUT_GAP_MS + ' ms apart) during the measured window. PROXY ONLY in headless.',
    layoutThrash:
      "PerformanceObserver 'long-animation-frame' (LoAF reports only frames > 50 ms, so a healthy HUD yields zero entries — the pass signal) + an instrumented forced-reflow count known by construction (0 dom/canvas, 200 dom-thrash).",
    threeVersion: depVersion('three'),
  },
  results: modes,
  i18nBundles,
  pageErrors,
  scopeNotes: [
    'No integrated-GPU or real-display-pipeline figure was measured — headless software GL only.',
    'No player-capacity or element-count ceiling is extrapolated beyond the 200-element probe point.',
    'The DOM-vs-canvas decision and its budget row live in docs/adr/ADR-010-s10-ui-i18n.md and ROADMAP §Budgets (B-UI-01).',
  ],
};

const outPath = path.join(here, 'report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${path.relative(repoRoot, outPath)}`);
console.log(`i18n sw/en ratio: raw ${i18nBundles.swVsEnRawRatio}, gzip9 ${i18nBundles.swVsEnGzip9Ratio}`);
if (pageErrors.length) console.log(`PAGE ERRORS: ${pageErrors.length}`, pageErrors.slice(0, 5));
