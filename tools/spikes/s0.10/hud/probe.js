// S0.10 HUD probe page logic — throwaway Phase-0 spike (tools/spikes carve-out).
//
// A three.js scene with an overlaid HUD of 200 live-updating text/stat elements,
// rendered three ways (one active per measurement window):
//   dom         — HTML DOM overlay: 200 <div class="stat">, per-frame
//                 textContent updates on the value spans.
//   dom-thrash  — same DOM plus a forced synchronous layout read (offsetTop)
//                 after every write: 200 forced reflows per frame. Hazard
//                 demonstration that validates the layout-thrash detector.
//   canvas      — single 2D-canvas overlay: clearRect + 200 fillText per frame.
//
// Measured per window: HUD update cost (performance.now around the update
// only), rAF frame interval, pointer-event-to-next-paint latency proxy
// (event.timeStamp vs the NEXT rAF timestamp delta), and layout-thrash signals
// (PerformanceObserver 'long-animation-frame' blockingStyleLayout + the
// instrumented reflow count, which is known by construction).
import * as THREE from '/node_modules/three/build/three.module.js';

const N_STATS = 200;
const COLS = 5;
const ROW_H = 14;
const LABELS = ['Speed', 'Altitude', 'Heading', 'Position', 'Fuel', 'Time', 'Ping', 'Frame Rate', 'Azimuth', 'Elevation'];

// ---------------------------------------------------------------- three.js scene
const glCanvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 8);
camera.lookAt(0, 0, 0);

const planet = new THREE.LineSegments(
  new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.6, 2)),
  new THREE.LineBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.45 }),
);
scene.add(planet);

const cubes = new THREE.Group();
const boxGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
const boxMat = new THREE.MeshNormalMaterial();
const cubeOrbit = [];
for (let i = 0; i < 24; i++) {
  const m = new THREE.Mesh(boxGeo, boxMat);
  cubeOrbit.push({ m, r: 3.4 + (i % 4) * 0.7, w: 0.15 + (i % 5) * 0.06, p: (i / 24) * Math.PI * 2, tilt: (i % 3 - 1) * 0.4 });
  cubes.add(m);
}
scene.add(cubes);

const starPos = new Float32Array(600 * 3);
for (let i = 0; i < 600; i++) {
  const r = 40, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
  starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
  starPos[i * 3 + 1] = r * Math.cos(ph);
  starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
}
const stars = new THREE.Points(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3)),
  new THREE.PointsMaterial({ color: 0x8b949e, size: 0.08 }),
);
scene.add(stars);

function renderThree(t) {
  planet.rotation.y = t * 0.06;
  planet.rotation.x = 0.15;
  for (const o of cubeOrbit) {
    o.m.position.set(Math.cos(t * o.w + o.p) * o.r, Math.sin(t * o.w * 0.7 + o.p) * o.r * o.tilt, Math.sin(t * o.w + o.p) * o.r);
  }
  stars.rotation.y = t * 0.01;
  renderer.render(scene, camera);
}

let glRendererString = 'unknown';
try {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  glRendererString = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked';
} catch (e) { glRendererString = 'error: ' + e.message; }

// ---------------------------------------------------------------- HUD (both renderers)
const stats = [];
for (let i = 0; i < N_STATS; i++) {
  stats.push({
    label: `${LABELS[i % LABELS.length]} ${String(i).padStart(3, '0')}`,
    phase: i * 0.37,
    freq: 0.3 + (i % 7) * 0.11,
    col: i % COLS,
    row: Math.floor(i / COLS),
  });
}
const fmt = (s, i) => `${s.toFixed(3)} ms`;

const hudEl = document.getElementById('hud');
const domValues = [];
for (const st of stats) {
  const div = document.createElement('div');
  div.className = 'stat';
  const l = document.createElement('span');
  l.className = 'l';
  l.textContent = st.label + ' ';
  const v = document.createElement('span');
  v.className = 'v';
  div.appendChild(l);
  div.appendChild(v);
  hudEl.appendChild(div);
  domValues.push(v);
}

const c2d = document.getElementById('c2d');
const ctx2d = c2d.getContext('2d');
c2d.width = innerWidth;
c2d.height = innerHeight;
const colW = (innerWidth - 24) / COLS;
const colX = (col) => 12 + col * colW;
const rowY = (row) => 20 + row * ROW_H;

function valAt(st, t) { return Math.sin(t * st.freq + st.phase) * 100; }

function updateDom(t) {
  for (let i = 0; i < N_STATS; i++) {
    domValues[i].textContent = fmt(valAt(stats[i], t), i);
  }
}

function updateDomThrash(t) {
  for (let i = 0; i < N_STATS; i++) {
    domValues[i].textContent = fmt(valAt(stats[i], t), i);
    void domValues[0].offsetTop; // forced synchronous layout every write
  }
}

function updateCanvas(t) {
  ctx2d.clearRect(0, 0, c2d.width, c2d.height);
  ctx2d.font = '12px system-ui, "Segoe UI", sans-serif';
  for (let i = 0; i < N_STATS; i++) {
    const st = stats[i];
    ctx2d.fillStyle = '#7d8b98';
    ctx2d.fillText(st.label + ' ', colX(st.col), rowY(st.row));
    ctx2d.fillStyle = '#e6edf3';
    ctx2d.fillText(fmt(valAt(st, t), i), colX(st.col) + 80, rowY(st.row));
  }
}

const UPDATERS = { dom: updateDom, 'dom-thrash': updateDomThrash, canvas: updateCanvas };
const REFLOWS_BY_CONSTRUCTION = { dom: 0, 'dom-thrash': N_STATS, canvas: 0 };
const OVERLAY = { dom: hudEl, 'dom-thrash': hudEl, canvas: c2d };

function showOverlay(mode) {
  hudEl.classList.toggle('off', mode !== 'dom' && mode !== 'dom-thrash');
  c2d.classList.toggle('off', mode !== 'canvas');
  if (mode === 'canvas') ctx2d.clearRect(0, 0, c2d.width, c2d.height);
}

// ---------------------------------------------------------------- instrumentation
const state = {
  mode: null,
  warmup: 0,
  measuring: false,
  target: 0,
  frames: 0,
  lastTs: 0,
  wallStart: 0,
  updateCosts: [],
  frameIntervals: [],
  latencies: [],
  pendingInput: null,
  loaf: [],
  resolveFn: null,
};

let loafSupported = false;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      state.loaf.push({
        durationMs: +(e.duration ?? 0).toFixed(2),
        scriptDurationMs: +(e.scriptDuration ?? 0).toFixed(2),
        blockingStyleLayoutMs: +(e.blockingStyleLayout ?? 0).toFixed(2),
      });
    }
  }).observe({ type: 'long-animation-frame', buffered: false });
  loafSupported = true;
} catch (e) { loafSupported = false; }

window.addEventListener('pointermove', (e) => { state.pendingInput = e.timeStamp; }, { passive: true });
window.addEventListener('pointerdown', (e) => { state.pendingInput = e.timeStamp; }, { passive: true });

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = state.lastTs ? ts - state.lastTs : 0;
  state.lastTs = ts;

  // pointer-event -> next paint latency proxy: the delta between the last
  // input event's timeStamp and THIS frame's rAF timestamp.
  if (state.pendingInput !== null) {
    state.latencies.push(ts - state.pendingInput);
    state.pendingInput = null;
  }

  if (state.mode) {
    const t0 = performance.now();
    UPDATERS[state.mode](ts / 1000);
    const cost = performance.now() - t0;

    if (state.warmup > 0) {
      state.warmup -= 1;
    } else if (state.measuring) {
      state.updateCosts.push(cost);
      if (state.frames > 0) state.frameIntervals.push(dt);
      state.frames += 1;
      if (state.frames >= state.target) {
        state.measuring = false;
        const resolveFn = state.resolveFn;
        state.resolveFn = null;
        if (resolveFn) resolveFn(snapshot());
      }
    }
  }
  renderThree(ts / 1000);
}
requestAnimationFrame(frame);

function quantiles(arr, q) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p) => Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[idx(q)];
}

function summarize(arr, overMs) {
  const n = arr.length;
  const mean = n ? arr.reduce((a, b) => a + b, 0) / n : 0;
  return {
    n,
    meanMs: +mean.toFixed(4),
    p50Ms: +(quantiles(arr, 0.5) ?? 0).toFixed(4),
    p95Ms: +(quantiles(arr, 0.95) ?? 0).toFixed(4),
    maxMs: +Math.max(...arr, 0).toFixed(4),
    ...(overMs ? { overBudget: arr.filter((x) => x > overMs).length, overBudgetMs: overMs } : {}),
  };
}

function snapshot() {
  const mode = state.mode;
  const loafBlocking = state.loaf.filter((e) => e.blockingStyleLayoutMs > 0.1);
  return {
    mode,
    measuredFrames: state.frames,
    warmupFrames: state.warmup,
    wallTimeMs: +(performance.now() - state.wallStart).toFixed(1),
    hudUpdateCost: summarize(state.updateCosts, null),
    frameInterval: summarize(state.frameIntervals, 1000 / 60),
    inputToPaintLatencyProxy: summarize(state.latencies, null),
    layoutThrash: {
      instrumentedForcedReflowsPerFrame: REFLOWS_BY_CONSTRUCTION[mode],
      loafSupported,
      loafEntries: state.loaf.length,
      loafEntriesWithStyleLayoutOver0p1ms: loafBlocking.length,
      loafBlockingStyleLayoutTotalMs: +state.loaf.reduce((a, b) => a + b.blockingStyleLayoutMs, 0).toFixed(2),
      loafLongestFrameMs: state.loaf.reduce((a, b) => Math.max(a, b.durationMs), 0),
    },
  };
}

// ---------------------------------------------------------------- public hooks
window.__runMode = (mode, frames, warmup) =>
  new Promise((resolve) => {
    if (!UPDATERS[mode]) { resolve({ error: 'unknown mode ' + mode }); return; }
    showOverlay(mode);
    Object.assign(state, {
      mode, target: frames, warmup, measuring: true, frames: 0,
      updateCosts: [], frameIntervals: [], latencies: [], loaf: [],
      wallStart: performance.now(), resolveFn: resolve,
    });
  });

window.__probeReady = true;
window.__glInfo = glRendererString;
window.__loafSupported = loafSupported;
