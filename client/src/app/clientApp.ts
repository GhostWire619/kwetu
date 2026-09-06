/**
 * Kwetu shell — the Phase-1 Part B client app: renderer setup, the floating-
 * origin scene, the flight loop, and the e2e debug surface.
 *
 * Hard invariants honoured here (CLAUDE.md / COORDINATE_SYSTEM.md):
 *   - logarithmicDepthBuffer: true AND a floating origin — always both
 *     (Law R-1). The floating origin lives in CameraRig + CelestialBodies
 *     (canonical f64 -> re-derived local -> one f32 downcast, Laws P-1/P-2/
 *     P-3/P-6); log depth is set on the WebGLRenderer below.
 *   - The GPU never sees a global coordinate (Law P-2): every object handed
 *     to three.js is an anchor-local delta.
 *   - Delta time comes from the monotonic source (performance.now), clamped;
 *     simulation time is the UniverseClock (ttClock.ts — the authoritative TT
 *     clock, ADR-008) anchored once at boot and advanced by the integrated
 *     frame deltas (rate 1, §4). advance() in the debug surface replays the
 *     same tick with fixed 1/60 s dt so the e2e flight is deterministic under
 *     a software rasterizer.
 *   - NO physics tonight: no Rapier import anywhere in this graph (ADR-004
 *     Decision 2 anticipates the shell flying before RAPIER.init() resolves;
 *     the contact bubble is localScene.ts, which lands with walk phase).
 *
 * [PLACEHOLDER — ADR-003] the world is a single-mesh placeholder Earth, Moon
 * (ephemeris position + real radius), Sun light + billboard at ~1 AU, and a
 * seeded star backdrop. No visual-fidelity or performance claim is made;
 * SwiftShader frames are not representative of hardware fps.
 */
import * as THREE from 'three';
import { ecefToEnu, EARTH_MEAN_RADIUS_METRES } from '../engine/geodesy';
import { f32Downcast } from '../engine/precision';
import { UniverseClock } from '../engine/ttClock';
import { CameraRig, KEY_TO_FLIGHT_ACTION } from './cameraRig';
import { CelestialBodies } from './celestialBodies';
import type { CanvasReadback, DepthProbe, FlightInput, KwetuDebug, KwetuRenderInfo } from './debugTypes';

/** Near plane, metres: 10 cm at the walk scale the shell boots into. */
const CAMERA_NEAR_METRES = 0.1;
/** Far plane, metres: covers the Sun billboard at ~1.6e11 m with margin. */
const CAMERA_FAR_METRES = 1e12;
/** Vertical field of view, degrees. */
const CAMERA_FOV_DEG = 50;
/** Fixed dt for the deterministic advance() replay, seconds. */
const FIXED_DT_SECONDS = 1 / 60;
/** Maximum real frame delta, seconds (tab-switch clamp). */
const MAX_FRAME_DT_SECONDS = 0.1;
/**
 * Depth-probe diagnostic FOV, degrees. At the 1e10 m stop the planet's angular
 * radius is asin(R/1e10) ≈ 0.0365° — sub-pixel through the 50° flight FOV, so
 * the probe renders through its own narrow camera: the disc covers ~46% of the
 * viewport height and the corners are clearly far-field. [derived]
 */
const PROBE_FOV_DEG = 0.16;
/** Centre patch side, pixels, for the probe's nearest-fragment (MIN) sample. */
const PROBE_PATCH_PX = 5;

/** Keys the shell consumes — derived from the rig's ONE key->action map. */
const FLIGHT_KEYS: ReadonlySet<string> = new Set(Object.keys(KEY_TO_FLIGHT_ACTION));

export class ClientApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: CameraRig;
  private readonly bodies: CelestialBodies;
  private readonly clock: UniverseClock;
  private readonly bootMonoMs: number;
  private simElapsedMs = 0;
  private frameCount = 0;
  private lastFrameMonoMs = 0;
  private disposed = false;

  private probeTarget: THREE.WebGLRenderTarget | null = null;
  private probeDepth: THREE.DepthTexture | null = null;
  private probeCamera: THREE.PerspectiveCamera | null = null;
  private readoutTarget: THREE.WebGLRenderTarget | null = null;
  private readoutMaterial: THREE.ShaderMaterial | null = null;
  /** The readout pass's depth-texture uniform (kept by reference for the per-probe swap). */
  private readoutDepthUniform: { value: THREE.Texture | null } | null = null;
  private readoutGeometry: THREE.PlaneGeometry | null = null;
  private readoutScene: THREE.Scene | null = null;
  private readoutCamera: THREE.OrthographicCamera | null = null;

  private readonly keys = new Set<string>();
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!FLIGHT_KEYS.has(event.code)) return;
    this.keys.add(event.code);
    event.preventDefault();
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!FLIGHT_KEYS.has(event.code)) return;
    this.keys.delete(event.code);
    event.preventDefault();
  };
  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.rig.scaleSpeedByWheel(event.deltaY);
  };
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.renderer.domElement) return;
    this.rig.applyMouseLook(event.movementX, event.movementY);
  };
  private readonly onClick = (): void => {
    // Pointer lock is a human-input path; in headless it may fail silently.
    try {
      const request = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
      if (request && typeof request.catch === 'function') request.catch(() => {});
    } catch {
      // No pointer lock available (headless / unsupported) — keyboard still works.
    }
  };
  private readonly onResize = (): void => {
    if (this.disposed) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.disposeProbeTarget();
  };

  private readonly loop = (): void => {
    if (this.disposed) return;
    const nowMonoMs = performance.now();
    const dtSeconds = Math.min(Math.max((nowMonoMs - this.lastFrameMonoMs) / 1000, 0), MAX_FRAME_DT_SECONDS);
    this.lastFrameMonoMs = nowMonoMs;
    this.tick(dtSeconds);
    this.render();
  };

  constructor(canvas: HTMLCanvasElement) {
    // Law R-1: log depth is switched on here; the floating origin is the rig.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(0x000000, 1);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, window.innerWidth / window.innerHeight, CAMERA_NEAR_METRES, CAMERA_FAR_METRES);

    this.bootMonoMs = performance.now();
    this.rig = new CameraRig(EARTH_MEAN_RADIUS_METRES, 1);
    this.bodies = new CelestialBodies(EARTH_MEAN_RADIUS_METRES);
    this.scene.add(this.bodies.group);

    // ADR-001 D3 / §4: the UniverseClock anchors TT once from the wall clock,
    // then derives every reading from the monotonic source — here the source
    // is the shell's integrated sim time, so the deterministic replay in
    // advance() advances the ephemeris exactly like real frames do.
    this.clock = UniverseClock.start({ nowMonoMs: () => this.bootMonoMs + this.simElapsedMs });

    this.bindEvents();
    window.__kwetuDebug = this.buildDebug();

    // Deterministic first frame before the loop starts.
    this.syncKeyInput();
    this.applyCamera();
    this.bodies.update(this.clock.nowTt(), this.rig.anchorGeodetic);
  }

  start(): void {
    if (this.disposed) return;
    this.lastFrameMonoMs = performance.now();
    this.renderer.setAnimationLoop(this.loop);
  }

  // --- frame ------------------------------------------------------------------------

  private tick(dtSeconds: number): void {
    this.simElapsedMs += dtSeconds * 1000;
    this.syncKeyInput();
    this.rig.tick(dtSeconds);
    this.applyCamera();
    this.bodies.update(this.clock.nowTt(), this.rig.anchorGeodetic);
  }

  private syncKeyInput(): void {
    this.rig.applyKeyStates(this.keys);
  }

  /** Camera <- rig: LocalScene coordinates (f64) downcast at the boundary (Law P-2). */
  private applyCamera(): void {
    const local = this.rig.cameraLocalMetres();
    this.camera.position.set(f32Downcast(local.x), f32Downcast(local.y), f32Downcast(local.z));
    // The look quaternion has one owner (CameraRig.lookQuaternion).
    this.rig.lookQuaternion(this.camera.quaternion);
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
    this.frameCount++;
  }

  /**
   * Reads back the whole default framebuffer (RGBA8, UNSIGNED_BYTE) — the e2e
   * GPU-side jitter signal (tests/e2e/fly.pw.ts bounds the per-frame pixel
   * delta; CPU re-projection cannot see GPU vertex-stage quantization, this
   * can). Must be called in the SAME task as the render it reads: the canvas
   * is not preserved across composites (preserveDrawingBuffer is false), and
   * the caller keeps the render loop's timing under its control. Returns null
   * when the GL read errors. [MEASURED 2026-09-06] a full-frame 640x360
   * SwiftShader readback is ~1-2 ms — cheap enough to run per frame, and
   * strictly stronger than a centre patch for edge-wobble detection.
   */
  private readCanvasRgba(): CanvasReadback | null {
    if (this.disposed) return null;
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    if (gl.getError() !== gl.NO_ERROR) return null;
    return { width, height, rgba };
  }

  private snapshotRenderInfo(): KwetuRenderInfo {
    const info = this.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines };
  }

  // --- events -------------------------------------------------------------------------

  private bindEvents(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('mousemove', this.onMouseMove);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.renderer.domElement.addEventListener('click', this.onClick);
  }

  private unbindEvents(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.renderer.domElement.removeEventListener('click', this.onClick);
  }

  // --- depth probe (z-fighting proxy) ---------------------------------------------------

  /**
   * Renders one offscreen frame through a dedicated narrow-FOV diagnostic
   * camera ({@link PROBE_FOV_DEG} — the planet is sub-pixel through the flight
   * FOV at the far stop) into an FBO with a DEPTH_COMPONENT24 depth texture,
   * then converts depth to COLOR with a fullscreen readout pass and reads RGBA
   * pixels. The color hop is required: raw readPixels(DEPTH_COMPONENT,
   * UNSIGNED_INT) is INVALID_ENUM (GL 1280) on headless Chromium (SwiftShader)
   * AND headless Firefox, even against a complete DEPTH_COMPONENT24
   * attachment [MEASURED 2026-09-06, tools/measure/gl-depth-readback.mjs —
   * the committed raw-GL probe; renderbuffer AND depth-texture variants, both
   * browsers].
   *
   * Under logarithmicDepthBuffer the planet's fragment depth must be strictly
   * smaller than the far-field clear depth at the 1e10 m stop: distinct depth
   * planes exist. This is the z-fighting PROXY — it does not prove per-
   * fragment ordering of coincident surfaces (no cheap headless assertion
   * can); the stationary jitter + NaN checks at every stop are the other half.
   * The corners sample the clear depth because the star backdrop writes no
   * depth by design (depthWrite: false) — the assertion is planet-vs-far-field,
   * not planet-vs-star-fragment.
   */
  private depthProbe(): DepthProbe | null {
    if (this.disposed) return null;
    const width = Math.max(2, window.innerWidth);
    const height = Math.max(2, window.innerHeight);
    if (
      this.probeTarget === null || this.readoutTarget === null || this.readoutScene === null ||
      this.readoutCamera === null || this.readoutMaterial === null || this.probeCamera === null
    ) {
      this.createProbePipeline(width, height);
    }
    const target = this.probeTarget;
    const readout = this.readoutTarget;
    const readoutScene = this.readoutScene;
    const readoutCamera = this.readoutCamera;
    const readoutMaterial = this.readoutMaterial;
    const probeCamera = this.probeCamera;
    if (
      target === null || readout === null || readoutScene === null ||
      readoutCamera === null || readoutMaterial === null || probeCamera === null
    ) {
      return null;
    }

    // The probe camera copies the flight camera's pose (the f32 render-boundary
    // values — the probe inspects exactly what the flight camera sees).
    probeCamera.aspect = width / height;
    probeCamera.position.copy(this.camera.position);
    probeCamera.quaternion.copy(this.camera.quaternion);
    probeCamera.updateProjectionMatrix();
    probeCamera.updateMatrixWorld();

    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, probeCamera);

    const depthUniform = this.readoutDepthUniform;
    if (depthUniform === null) return null;
    depthUniform.value = target.depthTexture;
    this.renderer.setRenderTarget(readout);
    this.renderer.render(readoutScene, readoutCamera);

    // Read the readout's COLOR attachment: r channel = normalized depth.
    this.renderer.setRenderTarget(readout);
    const gl = this.renderer.getContext();
    const readR = (px: number, py: number): number | null => {
      const buffer = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      if (gl.getError() !== gl.NO_ERROR) return null;
      const r = buffer[0];
      return r === undefined ? null : r / 255;
    };

    // Planet depth: MIN (nearest fragment) over a small centred patch — the
    // nadir direction projects to the viewport centre, so the patch straddles
    // the planet disc.
    const cx = width >> 1;
    const cy = height >> 1;
    const half = PROBE_PATCH_PX >> 1;
    const patch = new Uint8Array(4 * PROBE_PATCH_PX * PROBE_PATCH_PX);
    gl.readPixels(cx - half, cy - half, PROBE_PATCH_PX, PROBE_PATCH_PX, gl.RGBA, gl.UNSIGNED_BYTE, patch);
    if (gl.getError() !== gl.NO_ERROR) {
      this.renderer.setRenderTarget(null);
      return null;
    }
    let minR = 255;
    for (let i = 0; i < patch.length; i += 4) {
      const r = patch[i];
      if (r !== undefined && r < minR) minR = r;
    }
    const centerDepth = minR / 255;

    const corners: number[] = [];
    for (const [px, py] of [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3]] as const) {
      const d = readR(px, py);
      if (d === null) {
        this.renderer.setRenderTarget(null);
        return null;
      }
      corners.push(d);
    }
    this.renderer.setRenderTarget(null);
    return { centerDepth, cornerDepths: corners };
  }

  private createProbePipeline(width: number, height: number): void {
    // Scene target: color + DEPTH_COMPONENT24 depth texture (WebGL2). Depth
    // textures are not filterable — NEAREST is required for the readout sample.
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType; // DEPTH_COMPONENT24 in WebGL2
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    target.depthTexture = depthTexture;
    this.probeDepth = depthTexture;
    this.probeTarget = target;

    // Readout target: color only — the fullscreen pass copies the depth
    // texture's r channel into color for a legal readPixels.
    const readoutTarget = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.readoutTarget = readoutTarget;

    const readoutMaterial = new THREE.ShaderMaterial({
      uniforms: { uDepth: { value: depthTexture } },
      vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader:
        'uniform sampler2D uDepth;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = vec4(vec3(texture2D(uDepth, vUv).r), 1.0); }',
    });
    this.readoutMaterial = readoutMaterial;
    const depthUniform = readoutMaterial.uniforms.uDepth;
    if (depthUniform !== undefined) this.readoutDepthUniform = depthUniform as { value: THREE.Texture | null };
    const readoutGeometry = new THREE.PlaneGeometry(2, 2);
    this.readoutGeometry = readoutGeometry;
    const readoutScene = new THREE.Scene();
    readoutScene.add(new THREE.Mesh(readoutGeometry, readoutMaterial));
    this.readoutScene = readoutScene;
    this.readoutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.probeCamera = new THREE.PerspectiveCamera(PROBE_FOV_DEG, width / height, CAMERA_NEAR_METRES, CAMERA_FAR_METRES);
  }

  private disposeProbeTarget(): void {
    this.probeTarget?.dispose();
    this.probeDepth?.dispose();
    this.readoutTarget?.dispose();
    this.readoutMaterial?.dispose();
    this.readoutGeometry?.dispose();
    this.readoutScene?.clear();
    // The probe camera holds no GPU resources and has no dispose() in three's
    // runtime (Camera has none; the .d.ts declares one) — dropping the
    // reference is the whole teardown for it.
    this.probeTarget = null;
    this.probeDepth = null;
    this.probeCamera = null;
    this.readoutTarget = null;
    this.readoutMaterial = null;
    this.readoutDepthUniform = null;
    this.readoutGeometry = null;
    this.readoutScene = null;
    this.readoutCamera = null;
  }

  // --- e2e debug surface ---------------------------------------------------------------

  private buildDebug(): KwetuDebug {
    const app = this;
    const camera = this.camera;
    const scratch = new THREE.Vector3();
    const scratchForward = new THREE.Vector3();
    const scratchSize = new THREE.Vector2();

    return {
      get frameCount() {
        return app.frameCount;
      },
      /** Simulated seconds integrated since boot (the tick source of the clock). */
      get simElapsedSeconds() {
        return app.simElapsedMs / 1000;
      },
      get cameraPos() {
        const pf = app.rig.cameraPlanetFixed;
        return { x: String(pf.x), y: String(pf.y), z: String(pf.z) };
      },
      get cameraAltitudeMetres() {
        return String(app.rig.altitudeAboveSphereMetres);
      },
      get anchorGeodetic() {
        const anchor = app.rig.anchorGeodetic;
        return { latitudeDeg: String(anchor.latitudeDeg), longitudeDeg: String(anchor.longitudeDeg), heightMetres: String(anchor.heightMetres) };
      },
      get surfacePoint() {
        const point = app.rig.siteSurfacePoint;
        return { x: String(point.x), y: String(point.y), z: String(point.z) };
      },
      get renderInfo() {
        return app.snapshotRenderInfo();
      },
      projectPoint: (worldPlanetFixed: readonly [number, number, number]) => {
        if (worldPlanetFixed.length !== 3) throw new Error('projectPoint: expected [x, y, z]');
        const x = worldPlanetFixed[0] ?? NaN;
        const y = worldPlanetFixed[1] ?? NaN;
        const z = worldPlanetFixed[2] ?? NaN;
        const local = ecefToEnu({ x, y, z }, app.rig.anchorGeodetic);
        camera.updateMatrixWorld();
        scratch.set(f32Downcast(local.x), f32Downcast(local.y), f32Downcast(local.z));
        scratch.project(camera);
        const size = app.renderer.getSize(scratchSize);
        const forward = scratchForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const camLocal = app.rig.cameraLocalMetres();
        const relX = local.x - camLocal.x;
        const relY = local.y - camLocal.y;
        const relZ = local.z - camLocal.z;
        return {
          xPx: ((scratch.x + 1) / 2) * size.x,
          yPx: ((1 - scratch.y) / 2) * size.y,
          behind: forward.x * relX + forward.y * relY + forward.z * relZ < 0,
        };
      },
      setCameraAltitude: (altitudeAboveSphereMetres: number): void => {
        app.rig.setCameraAltitude(altitudeAboveSphereMetres);
        app.applyCamera();
        app.bodies.update(app.clock.nowTt(), app.rig.anchorGeodetic);
      },
      setSpeed: (metresPerSecond: number): void => {
        app.rig.setSpeed(metresPerSecond);
      },
      setFlightInput: (input: FlightInput): void => {
        app.rig.setDebugInput(input);
      },
      orientToPlanetCenter: (): void => {
        app.rig.orientToPlanetCenter();
        app.applyCamera();
      },
      advance: (seconds: number): void => {
        const ticks = Math.max(0, Math.round(seconds / FIXED_DT_SECONDS));
        for (let i = 0; i < ticks; i++) app.tick(FIXED_DT_SECONDS);
      },
      renderFrame: (): KwetuRenderInfo => {
        app.render();
        return app.snapshotRenderInfo();
      },
      /** Full-canvas RGBA readback of the most recent render (null on GL error). */
      readCanvasRgba: (): CanvasReadback | null => app.readCanvasRgba(),
      depthProbe: (): DepthProbe | null => app.depthProbe(),
      dispose: (): void => app.dispose(),
    };
  }

  // --- teardown ------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.unbindEvents();
    this.disposeProbeTarget();
    this.bodies.dispose();
    this.scene.clear();
    this.renderer.dispose();
    // Hand the GL context back immediately instead of waiting for GC (review
    // hygiene 2026-09-06): a disposed page otherwise keeps its live context,
    // and repeated boots in one tab can hit the browser's context cap.
    this.renderer.forceContextLoss();
    delete window.__kwetuDebug;
  }
}
