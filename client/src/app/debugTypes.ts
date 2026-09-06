/**
 * The `window.__kwetuDebug` surface — the Phase-1 shell's e2e hook.
 *
 * Type-only module (no runtime imports): tests/e2e/fly.pw.ts imports these
 * types from Node, the app implements them in the page
 * (client/src/app/clientApp.ts). Kept deliberately tiny — it is a test seam,
 * not a public API.
 *
 * All f64 canonical values cross as exact decimal STRINGS (JS numbers are
 * IEEE-754 binary64; String(v) round-trips), so the test can assert finiteness
 * without the page ever downcasting them.
 */

/** An f64 3-vector serialized as exact strings. */
export interface DebugF64Vec3 {
  readonly x: string;
  readonly y: string;
  readonly z: string;
}

/** Result of projecting one canonical world point through the live camera. */
export interface ProjectedPoint {
  /** NDC mapped to CSS pixels, x right (0 = left edge). */
  readonly xPx: number;
  /** NDC mapped to CSS pixels, y down (0 = top edge). */
  readonly yPx: number;
  /** True when the point is behind the camera plane. */
  readonly behind: boolean;
}

/** Snapshot of renderer.info.render after the most recent render. */
export interface KwetuRenderInfo {
  readonly calls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
}

/**
 * Full-canvas RGBA readback (ClientApp.readCanvasRgba). The GPU-side jitter
 * signal: CPU re-projection cannot see GPU vertex-stage quantization; a
 * per-frame pixel-delta bound over this buffer can.
 */
export interface CanvasReadback {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Far-stop depth probe (see ClientApp.depthProbe). Normalized [0, 1]. */
export interface DepthProbe {
  /** Depth at the viewport centre — the planet disc (camera looks nadir). */
  readonly centerDepth: number;
  /** Depth at the four inset corners — star backdrop or clear depth. */
  readonly cornerDepths: readonly number[];
}

/** Discrete flight input, the same struct the keyboard/wheel path fills. */
export interface FlightInput {
  forward?: boolean;
  backward?: boolean;
  left?: boolean;
  right?: boolean;
  /** LocalScene +z (geodetic up at the anchor) — the E key. */
  up?: boolean;
  /** LocalScene −z — the Q key. */
  down?: boolean;
}

/** The complete debug/e2e surface. */
export interface KwetuDebug {
  /** Rendered frame count (monotonic; advances only on real renders). */
  readonly frameCount: number;
  /** Simulated seconds integrated by the shell since boot (drives the clock). */
  readonly simElapsedSeconds: number;
  /** Camera canonical position, Frame.PlanetFixed(Earth), f64 exact strings. */
  readonly cameraPos: DebugF64Vec3;
  /** Geocentric radius above the placeholder sphere, metres, f64 string. */
  readonly cameraAltitudeMetres: string;
  /** The current floating-origin anchor (f64, Law P-6 ground truth). */
  readonly anchorGeodetic: {
    readonly latitudeDeg: string;
    readonly longitudeDeg: string;
    readonly heightMetres: string;
  };
  /** The boot site's surface point on the placeholder sphere, canonical PlanetFixed, f64 strings. */
  readonly surfacePoint: DebugF64Vec3;
  /** renderer.info.render snapshot after the most recent render. */
  readonly renderInfo: KwetuRenderInfo;
  /** Projects a canonical PlanetFixed point to CSS pixels through the live camera. */
  projectPoint(worldPlanetFixed: readonly [number, number, number]): ProjectedPoint;
  /**
   * Teleports the camera to `altitudeAboveSphereMetres` along the boot site's
   * geocentric radial by CANONICAL RE-DERIVATION (Law P-6) — the same path a
   * threshold rebase runs. A test seam for the real re-derivation; human
   * flight is the input/speed path.
   */
  setCameraAltitude(altitudeAboveSphereMetres: number): void;
  /** Sets the flight speed (m/s) through the same clamp the mouse wheel uses. */
  setSpeed(metresPerSecond: number): void;
  /** Replaces the debug flight input (the keyboard ORs into the same struct). */
  setFlightInput(input: FlightInput): void;
  /** Points the camera nadir (at the planet centre). */
  orientToPlanetCenter(): void;
  /** Advances the app's own update loop `seconds` of simulated time in fixed 1/60 s ticks, without rendering. */
  advance(seconds: number): void;
  /** Renders exactly one frame and returns the fresh render info. */
  renderFrame(): KwetuRenderInfo;
  /**
   * Reads back the whole canvas as RGBA bytes (same-task; must follow a
   * renderFrame() in the same JS task — the buffer is not preserved across
   * composites). Null when the GL read errors.
   */
  readCanvasRgba(): CanvasReadback | null;
  /** Renders offscreen and reads two depth samples (null when the GL path fails). */
  depthProbe(): DepthProbe | null;
  /** Full teardown: stops the loop, disposes GPU resources, removes listeners. */
  dispose(): void;
}

declare global {
  interface Window {
    __kwetuDebug?: KwetuDebug;
  }
}
