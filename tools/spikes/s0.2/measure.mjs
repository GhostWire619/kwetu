// S0.2 measurement runner — throwaway Phase-0 spike code (CLAUDE.md
// tools/spikes carve-out). Regenerates tools/spikes/s0.2/report.json.
//
// Usage: node tools/spikes/s0.2/measure.mjs
//   S02_FLIGHTS="quadtree/log,cdlod/log"   subset the flight matrix (debug)
//   S02_SKIP_FLIGHTS=1                     depth fixtures + smoke only (debug)
//
// Method (the numbers the ADR cites):
//   - Vite dev server on 127.0.0.1 (IPv4 — vite binds ::1 by default on this
//     host and the IPv4 poller times out; measured for the S0.11 harness) so
//     the page imports the pinned `three` from node_modules.
//   - HEADED Chromium via Playwright (launch({ headless: false })): headless
//     SwiftShader FPS is INVALID for the perf rows — a browser window opening
//     for ~7 min is expected. Viewport 1280x720, DPR 1.
//   - Flight matrix: {quadtree, cdlod} x {log, revz, revz-f32, std}, each the
//     same deterministic 42 s scripted 1 m -> 1e6 m -> 1e3 m flight
//     (flightPath.ts; first 3 s warmup excluded from frame stats by the page).
//     Frame times are rAF deltas — vsync-quantized on this host; p99 is the
//     "1%-worst" figure. draw calls / triangles from renderer.info per frame
//     (scene pass only; revz-f32's +1 blit draw is excluded and documented).
//   - Depth-quality fixture: three front/back quad pairs (8 m / 1 mm,
//     5 km / 5 cm, 500 km / 2 m) with the BACK quad drawn last, so a correct
//     depth compare — not painter's order — must win the inner box; sampled
//     by readPixels (main.ts runDepthFixture).
//   - Horizon silhouette: 4 readbacks during the high-hold pan; residual of
//     the limb row profile after removing the per-capture median shift —
//     LOD popping/cracks show as non-rigid deviation (px).
//   - VRAM: exact byte sum of every geometry the probe creates
//     (planetCommon.geometryBytes / pooled patch formula) + the revz-f32
//     render-target bytes; the browser does not expose true driver VRAM.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);

const PORT = 5272;
const W = 1280;
const H = 720;
const FLIGHT_TIMEOUT_MS = 240_000;
const MODE_TIMEOUT_MS = 120_000;

const DEPTHS = ['log', 'revz', 'revz-f32', 'std'];
const SCHEMES = ['quadtree', 'cdlod'];

// ------------------------------------------------------------------ versions
const pkgVersion = (name) =>
  JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
  ).version;

// ------------------------------------------------------------- vite dev server
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += String(d)));
vite.stderr.on('data', (d) => (viteLog += String(d)));
const pageUrl = (query) =>
  `http://127.0.0.1:${PORT}/tools/spikes/s0.2/page/index.html${query}`;

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(pageUrl('?mode=smoke'), { method: 'GET' });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite dev server did not come up on ${PORT}; log:\n${viteLog}`);
}

// ------------------------------------------------------------------ helpers
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

async function runMode(page, label, url, timeoutMs) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const h = window.__s02;
      return h !== undefined && (h.done === true || h.error !== null);
    },
    null,
    { timeout: timeoutMs, polling: 250 },
  );
  const state = await page.evaluate(() => window.__s02);
  if (state.error !== null) throw new Error(`${label}: page error: ${state.error}`);
  if (errors.length > 0) throw new Error(`${label}: page exceptions: ${errors.join(' | ')}`);
  return state.result;
}

// ------------------------------------------------------------------ the run
await waitForServer();

const browser = await chromium.launch({ headless: false }); // HEADED — real GPU path
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

// Idle rAF pacing (display refresh proxy, vsync quantization context).
const displayHzProxy = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      let sum = 0;
      const tick = (t) => {
        sum += t - last;
        last = t;
        n += 1;
        if (n < 40) requestAnimationFrame(tick);
        else resolve((1000 * n) / sum);
      };
      requestAnimationFrame(tick);
    }),
);

const report = {
  spike: 'S0.2',
  measuredAt: new Date().toISOString(),
  method: {
    browser: 'headed Chromium via Playwright (headless SwiftShader invalid for perf rows)',
    viewport: `${W}x${H} @ DPR 1`,
    server: `vite dev server 127.0.0.1:${PORT} (pinned three resolved from node_modules)`,
    frameTime: 'rAF deltas, vsync-quantized on this host; first 3 s of each flight excluded (LOD warmup)',
    drawCalls: 'renderer.info.render.calls per frame, scene pass only (revz-f32 +1 fullscreen blit excluded)',
    vram: 'exact sum of probe-created geometry attribute+index bytes (+ f32-depth RT bytes for revz-f32); browser does not expose driver VRAM',
    flight:
      '42 s scripted 1 m -> 1e6 m -> 1e3 m flight (tools/spikes/s0.2/flightPath.ts), identical path per run; ' +
      'LOD warmup (quadtree tree+pool fill, CDLOD first selection, shader compile) runs OUTSIDE the flight clock and is recorded per run as prefill',
    depthFixture:
      'front/back quad pairs at 8 m / 1 mm, 5 km / 5 cm, 500 km / 2 m; back quad drawn LAST (renderOrder 2) so the depth compare is load-bearing; readPixels sampling',
    silhouette:
      'limb row profile (48 columns) at t=16/18/20/22 s of the high-hold pan; residual after median-shift removal, px',
  },
  host: {
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    totalRamGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    displayHzProxy: Math.round(displayHzProxy * 10) / 10,
    userAgent: null,
    gpu: null,
    depthBitsDefaultFb: null,
    extClipControl: null,
    browserVersion: null,
  },
  versions: {
    three: pkgVersion('three'),
    playwright: pkgVersion('playwright'),
    vite: pkgVersion('vite'),
    node: process.version,
  },
  smoke: null,
  depth: {},
  flights: {},
};

{
  // ---- smoke ----
  const smoke = await runMode(page, 'smoke', pageUrl('?mode=smoke'), MODE_TIMEOUT_MS);
  report.smoke = smoke;
  report.host.userAgent = await page.evaluate(() => navigator.userAgent);
  report.host.browserVersion = browser.version();
  report.host.gpu = smoke.gpu ?? null;
  report.host.depthBitsDefaultFb = smoke.depthBits ?? null;
  report.host.extClipControl = smoke.clipControl ?? null;
  if (/swiftshader/i.test(String(report.host.gpu))) {
    throw new Error(`headed run fell back to SwiftShader (${report.host.gpu}) — invalid for perf rows`);
  }
  console.log(`[s0.2] smoke ok: ${report.host.gpu}, depthBits=${report.host.depthBitsDefaultFb}, clipControl=${report.host.extClipControl}`);
}

// ---- depth-quality fixtures ----
for (const depth of DEPTHS) {
  const res = await runMode(page, `depth/${depth}`, pageUrl(`?mode=depth&depth=${depth}`), MODE_TIMEOUT_MS);
  report.depth[depth] = res;
  const fails = res.pairs.filter((p) => !p.pass).map((p) => `${p.d}m/${p.gap}m`);
  console.log(`[s0.2] depth ${depth}: allPass=${res.allPass}${fails.length ? ` FAIL: ${fails.join(', ')}` : ''}`);
}

// ---- flight matrix ----
const flightList =
  process.env.S02_FLIGHTS !== undefined && process.env.S02_FLIGHTS !== ''
    ? process.env.S02_FLIGHTS.split(',').map((s) => s.trim())
    : SCHEMES.flatMap((s) => DEPTHS.map((d) => `${s}/${d}`));
const skipFlights = process.env.S02_SKIP_FLIGHTS === '1';

if (!skipFlights) {
  // Carry over flights from a previous partial run (incremental batching);
  // keys re-measured here always win.
  try {
    const prior = JSON.parse(readFileSync(path.join(here, 'report.json'), 'utf8'));
    if (prior && typeof prior === 'object' && prior.flights) {
      for (const [k, v] of Object.entries(prior.flights)) {
        if (!flightList.includes(k)) report.flights[k] = v;
      }
      console.log(`[s0.2] carried over ${Object.keys(report.flights).length} prior flight result(s)`);
    }
  } catch {
    /* no prior report */
  }
  for (const key of flightList) {
    const [scheme, depth] = key.split('/');
    if (!SCHEMES.includes(scheme) || !DEPTHS.includes(depth)) throw new Error(`bad flight key ${key}`);
    console.log(`[s0.2] flight ${scheme}/${depth} ...`);
    const res = await runMode(
      page,
      `flight/${key}`,
      pageUrl(`?mode=flight&scheme=${scheme}&depth=${depth}`),
      FLIGHT_TIMEOUT_MS,
    );
    report.flights[key] = res;
    console.log(
      `[s0.2] flight ${key}: mean=${res.meanMs.toFixed(2)}ms p99=${res.p99Ms.toFixed(2)}ms max=${res.maxMs.toFixed(2)}ms ` +
        `fps=${res.fpsMean.toFixed(1)} dc(mean/max)=${res.drawCallsMean.toFixed(1)}/${res.drawCallsMax} ` +
        `tris(mean)=${(res.trianglesMean / 1e6).toFixed(2)}M vramMax=${(res.vramTotalMax / 2 ** 20).toFixed(1)}MiB ` +
        `prefill=${res.prefill.ms.toFixed(0)}ms(+${res.prefill.warmRenderMs.toFixed(0)}ms render) ` +
        `silResid(max)=${res.silhouette.maxResidualPx}px silInvalidCols=${res.silhouette.invalidColumns}`,
    );
  }
}

await browser.close();
vite.kill();

// ------------------------------------------------- derived decision summary
// Numbers only — the ADR owns the decision. Ranks frame cost per scheme at the
// two depth strategies that engage correctly on this host.
report.derived = {
  depthVerdicts: Object.fromEntries(
    DEPTHS.map((d) => [d, { allPass: report.depth[d]?.allPass ?? false, pairs: report.depth[d]?.pairs ?? [] }]),
  ),
  flightKeys: Object.keys(report.flights),
};

writeFileSync(path.join(here, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`[s0.2] wrote ${path.join(here, 'report.json')}`);
