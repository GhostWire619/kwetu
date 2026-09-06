// S0.2 measurement page driver (throwaway probe, tools/spikes carve-out).
// Runs in a HEADED Chromium driven by measure.mjs/Playwright — headless
// SwiftShader numbers are invalid for the perf rows.
//
// Arrangement (Law P-2 / ADR-002 probe form, BOTH schemes): the camera sits
// AT THE ORIGIN with the absolute-space orientation, and the scene graph
// carries the -camPos translation (quadtree: the planet group position; CDLOD:
// the per-instance aOrigin attribute). model-space -> view-space is composed
// in f64 on the CPU (three's JS matrices) and downcast once to f32 at uniform
// upload. Measured 2026-09-06: putting the camera at the absolute pose while
// the group sits at -camPos subtracts the camera position TWICE; three's
// frustum cull then rejects nearly every mesh (0-3 draw calls per frame,
// empty renders) — the flight rows of the first partial run are invalid for
// exactly that reason and were re-measured.

import * as THREE from 'three';
import {
  DEPTH_FAR_M,
  DEPTH_FOV_RAD,
  DEPTH_MODES,
  DEPTH_NEAR_M,
  type DepthModeId,
  buildDepthTestScene,
  configureCameraDepth,
  createDisplayPass,
  createF32DepthTarget,
} from '../depthModes';
import { FLIGHT_END_S, FLIGHT_STATS_FROM_S, flightPose } from '../flightPath';
import { PLANET_RADIUS, dirFromLatLon, heightAt } from '../planetCommon';
import { QT_GRID_N, QT_HYSTERESIS, QT_MAX_DEPTH, QT_POOL_CAP, QT_SSE_PX, QuadtreePlanet } from '../quadtreePlanet';
import { CD_GRID_N, CD_INSTANCE_CAP, CD_MAX_LEVEL, CD_MORPH_START_FRAC, CD_SSE_PX, CdlodPlanet } from '../cdlodPlanet';

const W = 1280;
const H = 720;
const FOV_RAD = 1.0471975512; // 60 deg — shared with the CPU tests
const SKY = { r: 11, g: 16, b: 38 };
const SIL_CAPTURES_S = [16, 18, 20, 22]; // inside the high-hold pan
const SIL_COLUMNS = 48;

interface Harness {
  ready: boolean;
  done: boolean;
  error: string | null;
  result: unknown;
}

const harness = window as unknown as { __s02: Harness };
harness.__s02 = { ready: false, done: false, error: null, result: null };

function fail(err: unknown): void {
  harness.__s02.error = err instanceof Error ? err.message : String(err);
  harness.__s02.done = true;
}

function getCanvas(): HTMLCanvasElement {
  const c = document.querySelector('#c');
  if (!(c instanceof HTMLCanvasElement)) throw new Error('missing #c canvas');
  return c;
}

interface ReversedCapable {
  capabilities: { reversedDepthBuffer: boolean };
}

function makeRenderer(depthId: DepthModeId): THREE.WebGLRenderer {
  const spec = DEPTH_MODES[depthId];
  const renderer = new THREE.WebGLRenderer({
    canvas: getCanvas(),
    antialias: false, // uniform across modes: revz-f32's RT path has no MSAA
    preserveDrawingBuffer: true, // readback of flight frames + depth fixture
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: spec.rendererOptions.logarithmicDepthBuffer,
    reversedDepthBuffer: spec.rendererOptions.reversedDepthBuffer,
  } as THREE.WebGLRendererParameters);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  // Sky MUST land at (11,16,38) in the readback: setRGB(..., SRGBColorSpace)
  // stores the sRGB values as linear working-space color, which the output
  // encoder converts back to exactly (11,16,38). (new Color(r,g,b) treats the
  // numbers as already-linear and the clear came out (58,69,107) — measured
  // 2026-09-06 — which made every background pixel "non-sky" and would have
  // made the limb-profile metric vacuous.)
  renderer.setClearColor(new THREE.Color().setRGB(SKY.r / 255, SKY.g / 255, SKY.b / 255, THREE.SRGBColorSpace), 1);
  // Verify the depth mode actually engaged (EXT_clip_control gate for revz).
  const cap = (renderer as unknown as ReversedCapable).capabilities.reversedDepthBuffer === true;
  if (spec.rendererOptions.reversedDepthBuffer && !cap) {
    throw new Error('EXT_clip_control missing: reversedDepthBuffer did not engage');
  }
  return renderer;
}

function gpuInfo(gl: WebGL2RenderingContext): {
  gpu: string;
  depthBits: number | null;
  clipControl: boolean;
} {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : 'unknown (WEBGL_debug_renderer_info unavailable)';
  let depthBits: number | null = null;
  try {
    depthBits = Number(gl.getParameter(gl.DEPTH_BITS));
  } catch {
    depthBits = null;
  }
  return { gpu, depthBits, clipControl: gl.getExtension('EXT_clip_control') !== null };
}

function addLights(scene: THREE.Scene): void {
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2018, 2.1);
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(0.4, 0.8, 0.45).normalize();
  scene.add(hemi, sun);
}

/** Display-space limb row per column (topmost non-sky pixel), or -1. */
function limbProfile(buf: Uint8Array, columns: number): number[] {
  const rows: number[] = [];
  for (let ci = 0; ci < columns; ci++) {
    const x = Math.floor(((ci + 0.5) / columns) * W);
    let found = -1;
    for (let yd = 0; yd < H; yd++) {
      const o = ((H - 1 - yd) * W + x) * 4; // GL rows are bottom-up
      const dr = (buf[o] as number) - SKY.r;
      const dg = (buf[o + 1] as number) - SKY.g;
      const db = (buf[o + 2] as number) - SKY.b;
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 60) {
        found = yd;
        break;
      }
    }
    rows.push(found);
  }
  return rows;
}

function readFrame(gl: WebGL2RenderingContext): Uint8Array {
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------

interface FlightResult {
  mode: 'flight';
  scheme: 'quadtree' | 'cdlod';
  depth: DepthModeId;
  config: {
    scheme: string;
    sseThresholdPx: number;
    gridN: number;
    maxDepth: number;
    hysteresis: number | null;
    poolCap: number | null;
    instanceCap: number | null;
    morphStartFrac: number | null;
    crackApproach: string;
  };
  prefill: {
    /** warmup outside the flight clock: LOD tree fill (quadtree) / first selection (CDLOD) */
    ms: number;
    frames: number;
    /** first render (shader compile + first geometry upload) */
    warmRenderMs: number;
    /** quadtree geometries allocated after the warmup */
    quadtreeGeometries: number | null;
  };
  frames: number;
  flightSeconds: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  fpsMean: number;
  drawCallsMean: number;
  drawCallsMax: number;
  trianglesMean: number;
  trianglesMax: number;
  leavesOrInstancesMean: number;
  leavesOrInstancesMax: number;
  lodCpuMsMean: number;
  transitionsMean: number;
  geometryBytesMax: number;
  geometryBytesAtMaxZoom: number;
  renderTargetBytes: number;
  vramTotalMax: number;
  vramTotalAtMaxZoom: number;
  instanceUploadBytesPerFrameMean: number;
  silhouette: { captures: number; maxResidualPx: number; meanResidualPx: number; invalidColumns: number };
  debugFrames: {
    tSec: number;
    altM: number;
    visible: number;
    calls: number;
    triangles: number;
    visibleMeshes: number;
    groupChildren: number;
    camPos: [number, number, number];
    groupPos: [number, number, number];
    sampleMesh: {
      visible: boolean;
      frustumCulled: boolean;
      posW: [number, number, number];
      matrixWorldW: [number, number, number, number];
      bsCenter: [number, number, number];
      bsRadius: number;
    } | null;
    lastSampleMesh: {
      visible: boolean;
      frustumCulled: boolean;
      posW: [number, number, number];
      matrixWorldW: [number, number, number, number];
      bsCenter: [number, number, number];
      bsRadius: number;
    } | null;
    bsMin: number;
    bsMax: number;
    bsNaN: number;
  }[];
  capabilities: {
    gpu: string;
    depthBits: number | null;
    clipControl: boolean;
    reversedEngaged: boolean;
    logDepth: boolean;
  };
}

function runFlight(schemeId: 'quadtree' | 'cdlod', depthId: DepthModeId): void {
  const renderer = makeRenderer(depthId);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const spec = DEPTH_MODES[depthId];
  const scene = new THREE.Scene();
  addLights(scene);
  const camera = new THREE.PerspectiveCamera((FOV_RAD * 180) / Math.PI, W / H, DEPTH_NEAR_M, DEPTH_FAR_M);
  configureCameraDepth(camera, depthId);

  const planet: QuadtreePlanet | CdlodPlanet = schemeId === 'quadtree' ? new QuadtreePlanet() : new CdlodPlanet();
  const qt = schemeId === 'quadtree' ? (planet as QuadtreePlanet) : null;
  const cd = schemeId === 'cdlod' ? (planet as CdlodPlanet) : null;
  scene.add(planet.group);

  const useRT = spec.renderTargetF32;
  const rt = useRT ? createF32DepthTarget(W, H) : null;
  const display = rt ? createDisplayPass(rt.texture) : null;
  const renderTargetBytes = rt ? W * H * 4 + W * H * 4 : 0; // RGBA8 color + DEPTH_COMPONENT32F

  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const projScreen = new THREE.Matrix4();
  const frustum = new THREE.Frustum();

  const dts: number[] = [];
  const calls: number[] = [];
  const tris: number[] = [];
  const live: number[] = [];
  const lodMs: number[] = [];
  const transitions: number[] = [];
  const uploads: number[] = [];
  let geometryBytesMax = 0;
  let geometryBytesAtMaxZoom = 0;
  let callsMax = 0;
  let trisMax = 0;
  let liveMax = 0;
  const silProfiles: number[][] = [];
  let silNext = 0;
  let silInvalid = 0;
  let t0 = -1;
  let lastFrameNow = 0;
  const DEBUG_AT_S = [5, 20, 40];
  let debugNext = 0;
  const debugFrames: FlightResult['debugFrames'] = [];

  const config: FlightResult['config'] =
    qt !== null
      ? {
          scheme: 'quadtree',
          sseThresholdPx: QT_SSE_PX,
          gridN: QT_GRID_N,
          maxDepth: QT_MAX_DEPTH,
          hysteresis: QT_HYSTERESIS,
          poolCap: QT_POOL_CAP,
          instanceCap: null,
          morphStartFrac: null,
          crackApproach: 'radial skirts',
        }
      : {
          scheme: 'cdlod',
          sseThresholdPx: CD_SSE_PX,
          gridN: CD_GRID_N,
          maxDepth: CD_MAX_LEVEL,
          hysteresis: null,
          poolCap: null,
          instanceCap: CD_INSTANCE_CAP,
          morphStartFrac: CD_MORPH_START_FRAC,
          crackApproach: 'edge-collapse flags + parent-grid morph',
        };

  /** Camera pose + view frustum for one flight pose (shared by warmup + flight). */
  const applyPose = (pose: ReturnType<typeof flightPose>): void => {
    dirFromLatLon(pose.lat, pose.lon, pos).multiplyScalar(PLANET_RADIUS + pose.altM);
    dirFromLatLon(pose.targetLat, pose.targetLon, tmp);
    target.copy(tmp).multiplyScalar(PLANET_RADIUS + heightAt(tmp));
    // Camera AT THE ORIGIN (see header note); the scene graph carries -camPos.
    camera.position.set(0, 0, 0);
    camera.up.copy(pos).normalize();
    camera.lookAt(tmp.copy(target).sub(pos));
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Built BEFORE planet.update so the LOD pass culls against THIS frame.
    frustum.setFromProjectionMatrix(projScreen, THREE.WebGLCoordinateSystem, camera.reversedDepth);
  };

  // Warmup OUTSIDE the flight clock. CDLOD selection is stateless — one
  // update + one render pay the shader-compile cost. The quadtree fills its
  // tree + geometry pool at the initial pose until stable: a single update
  // builds EVERY visible patch, which measured 2026-09-06 as a multi-second
  // first-frame stall when left inside the flight stats window.
  const warmT0 = performance.now();
  applyPose(flightPose(0));
  let prefillFrames = 0;
  if (qt !== null) {
    for (let i = 0; i < 100; i++) {
      qt.update(pos, H, FOV_RAD, frustum);
      prefillFrames++;
      if (qt.stats.builtThisFrame === 0 && qt.transitionsLast === 0) break;
    }
  } else if (cd !== null) {
    cd.update(pos, H, FOV_RAD, frustum);
    prefillFrames = 1;
  }
  const prefillMs = performance.now() - warmT0;
  const prefillGeometries = qt !== null ? qt.stats.geometriesAllocated : null;
  const warmRenderT0 = performance.now();
  if (rt !== null && display !== null) {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  } else {
    renderer.render(scene, camera);
  }
  const warmRenderMs = performance.now() - warmRenderT0;

  const finish = (): void => {
    const dtsSorted = [...dts].sort((a, b) => a - b);
    const meanMs = mean(dtsSorted);
    // Silhouette: residual of the limb profile after removing the per-capture
    // median shift (rigid pan); popping/cracks show as non-rigid deviation.
    let maxRes = 0;
    let resSum = 0;
    let resN = 0;
    for (let i = 1; i < silProfiles.length; i++) {
      const a = silProfiles[i - 1] as number[];
      const b = silProfiles[i] as number[];
      const shifts: number[] = [];
      for (let c = 0; c < a.length; c++) {
        if ((a[c] as number) >= 0 && (b[c] as number) >= 0) shifts.push((b[c] as number) - (a[c] as number));
      }
      if (shifts.length < SIL_COLUMNS / 2) continue;
      shifts.sort((x, y) => x - y);
      const med = shifts[Math.floor(shifts.length / 2)] as number;
      for (let c = 0; c < a.length; c++) {
        if ((a[c] as number) >= 0 && (b[c] as number) >= 0) {
          const r = Math.abs((b[c] as number) - (a[c] as number) - med);
          resSum += r;
          resN++;
          if (r > maxRes) maxRes = r;
        }
      }
    }
    for (const prof of silProfiles) for (const v of prof) if (v < 0) silInvalid++;

    const result: FlightResult = {
      mode: 'flight',
      scheme: schemeId,
      depth: depthId,
      config,
      prefill: {
        ms: prefillMs,
        frames: prefillFrames,
        warmRenderMs,
        quadtreeGeometries: prefillGeometries,
      },
      frames: dts.length,
      flightSeconds: t0 >= 0 && lastFrameNow > t0 ? (lastFrameNow - t0) / 1000 : 0,
      meanMs,
      p50Ms: percentile(dtsSorted, 50),
      p95Ms: percentile(dtsSorted, 95),
      p99Ms: percentile(dtsSorted, 99),
      maxMs: dtsSorted.length > 0 ? (dtsSorted[dtsSorted.length - 1] as number) : 0,
      fpsMean: meanMs > 0 ? 1000 / meanMs : 0,
      drawCallsMean: mean(calls),
      drawCallsMax: callsMax,
      trianglesMean: mean(tris),
      trianglesMax: trisMax,
      leavesOrInstancesMean: mean(live),
      leavesOrInstancesMax: liveMax,
      lodCpuMsMean: mean(lodMs),
      transitionsMean: mean(transitions),
      geometryBytesMax,
      geometryBytesAtMaxZoom,
      renderTargetBytes,
      vramTotalMax: geometryBytesMax + renderTargetBytes,
      vramTotalAtMaxZoom: geometryBytesAtMaxZoom + renderTargetBytes,
      instanceUploadBytesPerFrameMean: mean(uploads),
      silhouette: {
        captures: silProfiles.length,
        maxResidualPx: maxRes,
        meanResidualPx: resN > 0 ? resSum / resN : 0,
        invalidColumns: silInvalid,
      },
      debugFrames,
      capabilities: {
        ...gpuInfo(gl),
        reversedEngaged: (renderer as unknown as ReversedCapable).capabilities.reversedDepthBuffer === true,
        logDepth: spec.rendererOptions.logarithmicDepthBuffer,
      },
    };
    harness.__s02.result = result;
    harness.__s02.done = true;
  };

  const frame = (now: number): void => {
    if (t0 < 0) t0 = now;
    const tAbs = (now - t0) / 1000;
    const pose = flightPose(Math.min(tAbs, FLIGHT_END_S));

    applyPose(pose);
    if (qt !== null) qt.update(pos, H, FOV_RAD, frustum);
    else if (cd !== null) cd.update(pos, H, FOV_RAD, frustum);

    if (rt !== null && display !== null) {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      const sceneCalls = renderer.info.render.calls;
      const sceneTris = renderer.info.render.triangles;
      renderer.setRenderTarget(null);
      renderer.info.reset();
      renderer.render(display.scene, display.camera);
      calls.push(sceneCalls);
      tris.push(sceneTris);
      if (sceneCalls > callsMax) callsMax = sceneCalls;
      if (sceneTris > trisMax) trisMax = sceneTris;
    } else {
      renderer.render(scene, camera);
      const c = renderer.info.render.calls;
      const tr = renderer.info.render.triangles;
      calls.push(c);
      tris.push(tr);
      if (c > callsMax) callsMax = c;
      if (tr > trisMax) trisMax = tr;
    }

    const vram = planet.stats.vramBytes;
    if (vram > geometryBytesMax) geometryBytesMax = vram;
    if (tAbs < FLIGHT_STATS_FROM_S && vram > geometryBytesAtMaxZoom) geometryBytesAtMaxZoom = vram;

    if (tAbs >= FLIGHT_STATS_FROM_S) {
      if (lastFrameNow > 0) dts.push(now - lastFrameNow);
      const lv = qt !== null ? qt.stats.leavesVisible : (cd as CdlodPlanet).stats.instancesVisible;
      live.push(lv);
      if (lv > liveMax) liveMax = lv;
      lodMs.push(qt !== null ? qt.stats.lodCpuMs : (cd as CdlodPlanet).stats.selectionMs);
      transitions.push(qt !== null ? qt.transitionsLast : 0);
      if (cd !== null) {
        let bytes = 0;
        for (const n of cd.stats.countsPerFace) bytes += n * 13 * 4;
        uploads.push(bytes);
      }
    }
    if (silNext < SIL_CAPTURES_S.length && tAbs >= (SIL_CAPTURES_S[silNext] as number)) {
      silProfiles.push(limbProfile(readFrame(gl), SIL_COLUMNS));
      silNext++;
    }

    if (debugNext < DEBUG_AT_S.length && tAbs >= (DEBUG_AT_S[debugNext] as number)) {
      let visibleMeshes = 0;
      let sampleMesh: FlightResult['debugFrames'][number]['sampleMesh'] = null;
      let lastSampleMesh: FlightResult['debugFrames'][number]['sampleMesh'] = null;
      let bsMin = Infinity;
      let bsMax = -Infinity;
      let bsNaN = 0;
      for (const child of planet.group.children) {
        const m = child as unknown as {
          visible: boolean;
          frustumCulled: boolean;
          position: THREE.Vector3;
          matrixWorld: THREE.Matrix4;
          geometry: THREE.BufferGeometry;
        };
        if (m.visible) {
          visibleMeshes++;
          m.geometry.computeBoundingSphere();
          const bs = m.geometry.boundingSphere as THREE.Sphere;
          if (Number.isNaN(bs.radius) || !Number.isFinite(bs.radius)) bsNaN++;
          else {
            if (bs.radius < bsMin) bsMin = bs.radius;
            if (bs.radius > bsMax) bsMax = bs.radius;
          }
          const rec = (): FlightResult['debugFrames'][number]['sampleMesh'] => {
            const e = m.matrixWorld.elements;
            return {
              visible: m.visible,
              frustumCulled: m.frustumCulled,
              posW: [m.position.x, m.position.y, m.position.z],
              matrixWorldW: [e[12] as number, e[13] as number, e[14] as number, e[15] as number],
              bsCenter: [bs.center.x, bs.center.y, bs.center.z],
              bsRadius: bs.radius,
            };
          };
          if (sampleMesh === null) sampleMesh = rec();
          lastSampleMesh = rec();
        }
      }
      debugFrames.push({
        tSec: Math.round(tAbs * 100) / 100,
        altM: pose.altM,
        visible: qt !== null ? qt.stats.leavesVisible : (cd as CdlodPlanet).stats.instancesVisible,
        calls: calls[calls.length - 1] ?? -1,
        triangles: tris[tris.length - 1] ?? -1,
        visibleMeshes,
        groupChildren: planet.group.children.length,
        camPos: [pos.x, pos.y, pos.z],
        groupPos: [planet.group.position.x, planet.group.position.y, planet.group.position.z],
        sampleMesh,
        lastSampleMesh,
        bsMin,
        bsMax,
        bsNaN,
      });
      debugNext++;
    }

    lastFrameNow = now;
    if (tAbs >= FLIGHT_END_S) {
      finish();
      return;
    }
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------

interface DepthPairResult {
  d: number;
  gap: number;
  innerFrontFrac: number;
  innerBackFrac: number;
  annulusBackFrac: number;
  pass: boolean;
}

interface DepthResult {
  mode: 'depth';
  depth: DepthModeId;
  pairs: DepthPairResult[];
  allPass: boolean;
  debug: { histogram: { sky: number; front: number; back: number; other: number }; grid: string };
  capabilities: {
    gpu: string;
    depthBits: number | null;
    clipControl: boolean;
    reversedEngaged: boolean;
    logDepth: boolean;
  };
}

function colorNear(buf: Uint8Array, x: number, y: number, rgb: readonly [number, number, number], tol: number): boolean {
  const o = (y * W + x) * 4;
  return (
    Math.abs((buf[o] as number) - rgb[0]) <= tol &&
    Math.abs((buf[o + 1] as number) - rgb[1]) <= tol &&
    Math.abs((buf[o + 2] as number) - rgb[2]) <= tol
  );
}

function runDepthFixture(depthId: DepthModeId): void {
  const renderer = makeRenderer(depthId);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const caps = { ...gpuInfo(gl), reversedEngaged: (renderer as unknown as ReversedCapable).capabilities.reversedDepthBuffer === true, logDepth: DEPTH_MODES[depthId].rendererOptions.logarithmicDepthBuffer };
  const camera = new THREE.PerspectiveCamera((DEPTH_FOV_RAD * 180) / Math.PI, W / H, DEPTH_NEAR_M, DEPTH_FAR_M);
  configureCameraDepth(camera, depthId);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  // Camera first: the fixture derives its sample rects by projecting the quad
  // corners through THIS camera (reversed projection for the revz modes).
  const { scene, samples } = buildDepthTestScene(camera, W, H);

  if (DEPTH_MODES[depthId].renderTargetF32) {
    const rt = createF32DepthTarget(W, H);
    const display = createDisplayPass(rt.texture);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(display.scene, display.camera);
    rt.dispose();
  } else {
    renderer.render(scene, camera);
  }

  const buf = readFrame(gl);
  const FRONT = [255, 60, 60] as const;
  const BACK = [60, 255, 60] as const;
  const SKY_RGB = [SKY.r, SKY.g, SKY.b] as const;
  const TOL = 40;
  // Debug aid (kept for regenerability): whole-frame category histogram and a
  // 64x36 category grid ('.'=sky 'F'=front 'B'=back '?'=other), GL row order.
  let hist = { sky: 0, front: 0, back: 0, other: 0 };
  const GX = 64;
  const GY = 36;
  let grid = '';
  for (let gy = 0; gy < GY; gy++) {
    let row = '';
    for (let gx = 0; gx < GX; gx++) {
      const x = Math.floor(((gx + 0.5) / GX) * W);
      const y = Math.floor(((gy + 0.5) / GY) * H);
      let cat = '?';
      if (colorNear(buf, x, y, SKY_RGB, 12)) cat = '.';
      else if (colorNear(buf, x, y, FRONT, TOL)) cat = 'F';
      else if (colorNear(buf, x, y, BACK, TOL)) cat = 'B';
      hist = {
        ...hist,
        [cat === '.' ? 'sky' : cat === 'F' ? 'front' : cat === 'B' ? 'back' : 'other']:
          hist[cat === '.' ? 'sky' : cat === 'F' ? 'front' : cat === 'B' ? 'back' : 'other'] + 1,
      };
      row += cat;
    }
    grid += row + '\n';
  }
  const pairs: DepthPairResult[] = samples.map((s) => {
    let front = 0;
    let back = 0;
    let innerN = 0;
    for (let y = s.inner.y; y < s.inner.y + s.inner.h && y < H; y++) {
      for (let x = s.inner.x; x < s.inner.x + s.inner.w && x < W; x++) {
        innerN++;
        if (colorNear(buf, x, y, FRONT, TOL)) front++;
        else if (colorNear(buf, x, y, BACK, TOL)) back++;
      }
    }
    let annBack = 0;
    let annN = 0;
    for (let y = s.annulus.y; y < s.annulus.y + s.annulus.h && y < H; y++) {
      for (let x = s.annulus.x; x < s.annulus.x + s.annulus.w && x < W; x++) {
        annN++;
        if (colorNear(buf, x, y, BACK, TOL)) annBack++;
      }
    }
    const innerFrontFrac = innerN > 0 ? front / innerN : 0;
    const innerBackFrac = innerN > 0 ? back / innerN : 1;
    const annulusBackFrac = annN > 0 ? annBack / annN : 0;
    return {
      d: s.d,
      gap: s.gap,
      innerFrontFrac,
      innerBackFrac,
      annulusBackFrac,
      pass: innerFrontFrac > 0.99 && annulusBackFrac > 0.9,
    };
  });
  renderer.dispose();
  const result: DepthResult = {
    mode: 'depth',
    depth: depthId,
    pairs,
    allPass: pairs.every((p) => p.pass),
    debug: { histogram: hist, grid },
    capabilities: caps,
  };
  harness.__s02.result = result;
  harness.__s02.done = true;
}

// ---------------------------------------------------------------------------

async function runSmoke(): Promise<void> {
  const renderer = makeRenderer('log');
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const scene = new THREE.Scene();
  addLights(scene);
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1.5e7);
  const planet = new QuadtreePlanet();
  scene.add(planet.group);
  const pos = dirFromLatLon(0.35, 0.9, new THREE.Vector3()).multiplyScalar(PLANET_RADIUS + 1e4);
  // Camera at the origin (see header note); look toward the planet center.
  camera.position.set(0, 0, 0);
  camera.up.copy(pos).normalize();
  camera.lookAt(pos.clone().negate());
  camera.updateMatrixWorld();
  for (let i = 0; i < 20; i++) {
    planet.update(pos, H, FOV_RAD, null);
    renderer.render(scene, camera);
    await new Promise((r) => requestAnimationFrame(r));
  }
  harness.__s02.result = {
    mode: 'smoke',
    ok: true,
    drawCalls: renderer.info.render.calls,
    ...gpuInfo(gl),
  };
  harness.__s02.done = true;
}

// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'smoke';

try {
  if (mode === 'smoke') {
    void runSmoke();
  } else if (mode === 'depth') {
    runDepthFixture((params.get('depth') ?? 'log') as DepthModeId);
  } else if (mode === 'flight') {
    void runFlight(
      (params.get('scheme') ?? 'quadtree') as 'quadtree' | 'cdlod',
      (params.get('depth') ?? 'log') as DepthModeId,
    );
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  harness.__s02.ready = true;
} catch (err) {
  fail(err);
}
