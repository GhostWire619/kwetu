/**
 * Phase-1 Part B — the shell's first flight e2e (the Phase-1 exit criterion:
 * a real-scale planet and a camera that flies 1 m -> 1e10 m).
 *
 * FLIGHT MECHANISM (one mechanism, declared): the flight is driven ENTIRELY
 * through the app's own `window.__kwetuDebug` surface. Leg motion runs the
 * app's REAL integration path (setFlightInput + setSpeed + advance(), fixed
 * 1/60 s ticks, so the f64 integration and the Law P-6 threshold rebase are
 * exercised deterministically) and the leg is ASSERTED before anything else
 * happens: the camera must actually move, and it must land within
 * {@link LEG_RELATIVE_TOLERANCE} of the stop altitude by integration alone.
 * Each stop is then snapped with setCameraAltitude(), which is the same
 * canonical re-derivation a rebase runs — kept deliberately, but no longer
 * load-bearing for correctness: the leg assertions above it fail first if the
 * integration is broken, and a one-off seam check proves setCameraAltitude is
 * not a no-op (review 2026-09-06: the snap used to discard each leg's result
 * unchecked, so a no-op integration or a no-op snap would have gone unseen).
 * The mouse-wheel / keyboard path drives the same input struct and the same
 * speed clamp — it is not used here because timed input under a software
 * rasterizer (SwiftShader) is not frame-rate deterministic.
 *
 * JITTER MEASUREMENT (two signals — review 2026-09-06): the original spec
 * re-rendered frozen state 30 times (no tick, no applyCamera, no
 * bodies.update), so every frame was bit-identical, stdDev was ~1e-14 px with
 * 2 distinct values among the 60 samples, and the "no jitter" criterion was
 * not measured at all. Now, per frame inside the 30-frame loop, the world is
 * TICKED first (advance(1/60): input sync, rig integration, applyCamera,
 * ephemeris/bodies re-derivation, clock advance) and then rendered, so the
 * frames come from the app's real per-frame path; the loop's non-degeneracy
 * is guarded by asserting the frame count and the integrated sim time. Two
 * independent signals bound jitter over those frames:
 *   1. CPU re-projection (f64 path): the fixed boot-site surface point is
 *      re-projected through the live camera each frame; stdDev < 0.5 px. This
 *      sees anchor/re-derivation drift and camera-state wobble — it CANNOT
 *      see GPU vertex-stage quantization (the known ~0.5 m Earth-mesh f32
 *      error, cameraRig.ts header).
 *   2. GPU image stability: the full canvas is read back each frame
 *      (readCanvasRgba — same-task, before the compositor clears the
 *      non-preserved buffer) and the per-frame max channel delta plus the
 *      changed-pixel fraction are bounded. This is the signal that CAN see
 *      vertex quantization: any edge that wobbles by a pixel flips
 *      high-contrast pixels far past the bounds below, while the expected
 *      idle noise is near zero (measured baselines in the constants).
 *
 * Z-FIGHTING PROXY (honesty note): at the far stop, depthProbe() renders the
 * scene offscreen into a DEPTH_COMPONENT24 attachment and reads the planet
 * disc's depth (MIN over a centred patch) plus four inset corners. Two
 * measured facts shape the probe: raw readPixels(DEPTH_COMPONENT) is
 * INVALID_ENUM (GL 1280) on headless Chromium AND Firefox (measured
 * 2026-09-06, tools/measure/gl-depth-readback.mjs — committed probe), so
 * depth reaches the test through a depth-texture -> colour readout pass; and
 * the planet disc is sub-pixel through the 50 deg flight FOV at 1e10 m
 * (angular radius ~0.036 deg [derived]), so the probe renders through a
 * dedicated 0.16 deg diagnostic camera at the flight camera's pose. Asserting
 * planet depth < every corner depth proves distinct depth planes between the
 * planet and the far field under logarithmicDepthBuffer — it does NOT prove
 * per-fragment ordering of coincident surfaces, which no cheap headless
 * assertion can; the corners read the clear depth because the star backdrop
 * writes no depth by design (depthWrite: false). The two jitter signals at
 * every stop are the other half of the proxy.
 *
 * SwiftShader caveat: Chromium runs software ANGLE here (playwright.config.ts);
 * nothing in this spec is an fps or fidelity claim.
 */
import { expect, test } from '@playwright/test';
import type { KwetuDebug } from '../../client/src/app/debugTypes';

/** Smaller viewport: SwiftShader fills 640x360 in a fraction of 1280x720. */
test.use({ viewport: { width: 640, height: 360 } });

/** Log-spaced stops, metres above the placeholder sphere surface. */
const STOP_ALTITUDES = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10] as const;
const JITTER_FRAMES = 30;
const JITTER_TOLERANCE_PX = 0.5;
const MAX_DRAW_CALLS = 100;
/**
 * Leg tolerance (review 2026-09-06: "~1e-6"): the real integration must land
 * this close to the stop altitude BEFORE the canonical snap runs. The f64
 * tick accumulation error over the longest leg (540 ticks at 1e9 m/s) is
 * ~1e-3 m [derived] — six orders under the 1e4 m this allows at 1e10 m.
 */
const LEG_RELATIVE_TOLERANCE = 1e-6;
/**
 * GPU image-stability bounds over the jitter frames (signal 2). BANDed by
 * what the frame can contain, because the idle noise is banded too:
 *
 * GROUND-FILLED frames (alt <= {@link GROUND_FILLED_MAX_ALTITUDE_METRES}):
 * the placeholder Earth's angular radius exceeds the flight FOV half-angle,
 * so the frame is all surface and NO far body can be in view (the Moon's
 * apparent direction stays > 60 deg from nadir there [derived — its geocentric
 * direction would have to be within the planet's occlusion cone]). Idle noise
 * is the ephemeris-driven sun light's f32 position stepping (~9 km spacing at
 * 1 AU [derived]): shading flips of 1 quantum [MEASURED max 1 across 15+
 * stop-runs on both browsers, tools/measure/gpu-stability.mjs]. A one-pixel
 * wobble of the weakest visible edge (the 15 deg checker: max channel
 * contrast 28/255 [derived from textures.ts]) trips 12 with margin.
 *
 * FAR-FIELD frames (alt > the band edge): space is in frame and the Moon's
 * f32-stepped silhouette (spacing ~46 m at 3.84e8 m [derived — f32 eps]) can
 * flip a pixel by up to the Moon's local contrast (< ~160/255 [derived]);
 * MEASURED idle max 16 in one parallel-worker e2e run (Firefox, 1e9 m;
 * sequential baseline 1, tools/measure/gpu-stability.mjs). The bound absorbs
 * that catalogue
 * noise while still failing on whole-image instability (a NaN/garbage frame
 * deltas ~255 across a large fraction — also caught by the fraction bound).
 * At these stops the planet is small-to-sub-pixel: the geometric claims are
 * carried by the CPU signal above and the far-stop depth probe.
 *
 * The changed-pixel FRACTION is bounded for all stops: idle is <= ~5e-4
 * [MEASURED <= 1363 px per frame pair of 230400], so 1% catches any
 * many-pixel flicker while absorbing the stepping noise.
 */
const GPU_GROUND_MAX_CHANNEL_DELTA = 12;
const GPU_FARFIELD_MAX_CHANNEL_DELTA = 170;
const GPU_MAX_CHANGED_PIXEL_FRACTION = 0.01;
/**
 * Altitude below which the frame is entirely planet surface: the placeholder
 * Earth's angular radius asin(R / (R + alt)) >= the flight FOV half-angle
 * (25 deg) while R + alt <= R / sin(25 deg) = 1.508e7 m [derived], i.e.
 * alt <= 8.71e6 m. The stop list makes 1e6 m the last ground-filled stop.
 */
const GROUND_FILLED_MAX_ALTITUDE_METRES = 8.6e6;

interface Projection {
  xPx: number;
  yPx: number;
}

/** Diagnostic for the worst GPU delta of one frame pair (failure message). */
interface GpuWorstDelta {
  frame: number;
  maxDelta: number;
  px: number;
  py: number;
  from: [number, number, number];
  to: [number, number, number];
}

function stdDev(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length);
}

/**
 * setCameraAltitude lands within this of the requested altitude: the re-
 * derivation's f64 round trip (siteRadial * (R + h) -> norm - R) carries an
 * error of ~(R + h) * 2^-52 * sqrt(3) [derived — f64 component spacing], i.e.
 * ~1e-9 m at boot altitude and ~2e-6 m at 1e10 m; the bound sits orders above
 * that and far below any real failure (e.g. a no-op or an off-by-one snap).
 */
function snapToleranceMetres(altitudeMetres: number): number {
  return Math.max(1e-6, altitudeMetres * 1e-12);
}

test('shell flies 1 m -> 1e10 m: finite values, stationary jitter < 0.5 px, bounded draw calls, distinct far-field depth', async ({ page }) => {
  // 11 stops x 30 rendered frames + flight, on a software rasterizer.
  test.setTimeout(600_000);

  // Console error + page error capture across the WHOLE flight. three's own
  // warnings are allowed only as console 'warning'/'info' — anything at
  // 'error' level, or any uncaught exception, fails the run (aim: zero).
  //
  // One exclusion, documented: Firefox emits a machine-local profile-noise
  // console error ("Bookmarks.html file could be corrupt" [MEASURED
  // 2026-09-06 — a full-suite parallel run failed this spec on it while the
  // app's own console stayed clean; it passes in isolation]). It is browser
  // profile output, not page output, so it is filtered here rather than
  // weakening the page-error gate.
  const FIREFOX_PROFILE_NOISE = 'Bookmarks.html file could be corrupt';
  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes(FIREFOX_PROFILE_NOISE)) {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  await page.goto('/client/index.html');
  await page.waitForFunction(
    () => {
      const hook = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
      return hook !== undefined && hook.frameCount >= 1;
    },
    undefined,
    { timeout: 60_000 },
  );

  const assertFinite = async (): Promise<void> => {
    const dump = await page.evaluate(() => {
      const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
      if (d === undefined) throw new Error('__kwetuDebug not installed');
      return {
        cameraPos: d.cameraPos,
        altitude: d.cameraAltitudeMetres,
        anchor: d.anchorGeodetic,
        renderInfo: d.renderInfo,
      };
    });
    for (const axis of [dump.cameraPos.x, dump.cameraPos.y, dump.cameraPos.z]) {
      expect(Number.isFinite(Number(axis)), `cameraPos axis "${axis}" is finite`).toBe(true);
    }
    expect(Number.isFinite(Number(dump.altitude)), `altitude "${dump.altitude}" is finite`).toBe(true);
    for (const value of [dump.anchor.latitudeDeg, dump.anchor.longitudeDeg, dump.anchor.heightMetres]) {
      expect(Number.isFinite(Number(value)), `anchor value "${value}" is finite`).toBe(true);
    }
    for (const [name, value] of Object.entries(dump.renderInfo)) {
      expect(Number.isFinite(value), `renderInfo.${name} (${String(value)}) is finite`).toBe(true);
    }
  };

  // setCameraAltitude seam check: prove the snap seam actually moves the
  // camera and round-trips, independent of the legs (whose landing point is
  // too close to target to expose a no-op snap on its own).
  const seam = await page.evaluate(() => {
    const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (d === undefined) throw new Error('__kwetuDebug not installed');
    const bootAltitude = Number(d.cameraAltitudeMetres);
    d.setCameraAltitude(1234.5);
    const movedTo = Number(d.cameraAltitudeMetres);
    d.setCameraAltitude(bootAltitude);
    return { bootAltitude, movedTo, restored: Number(d.cameraAltitudeMetres) };
  });
  expect(
    Math.abs(seam.movedTo - 1234.5),
    `setCameraAltitude moves the camera (no-op would stay at ${seam.bootAltitude})`,
  ).toBeLessThanOrEqual(snapToleranceMetres(1234.5));
  expect(
    Math.abs(seam.restored - seam.bootAltitude),
    'setCameraAltitude round-trips to the boot altitude',
  ).toBeLessThanOrEqual(snapToleranceMetres(1));

  // The fixed world point the jitter check re-projects: the boot site's
  // surface point, canonical Frame.PlanetFixed(Earth), f64 exact strings.
  const surfacePoint = await page.evaluate(() => {
    const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (d === undefined) throw new Error('__kwetuDebug not installed');
    const p = d.surfacePoint;
    return [Number(p.x), Number(p.y), Number(p.z)] as const;
  });

  let previousAltitude: number | null = null;
  for (const altitude of STOP_ALTITUDES) {
    const hasPrevious = previousAltitude !== null;

    // Fly (real integration) then snap (canonical re-derivation) + aim nadir.
    // The leg's altitude is read BEFORE the snap and returned, so the
    // assertions below see what the integration achieved on its own.
    const leg = await page.evaluate(({ target, flyTheLeg }) => {
      const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
      if (d === undefined) throw new Error('__kwetuDebug not installed');
      const beforeLeg = Number(d.cameraAltitudeMetres);
      if (flyTheLeg && target > beforeLeg) {
        const distanceMetres = target - beforeLeg;
        const speedMetresPerSecond = Math.min(distanceMetres, 1e9); // the app's own clamp
        d.setFlightInput({ up: true });
        d.setSpeed(speedMetresPerSecond);
        d.advance(distanceMetres / speedMetresPerSecond);
        d.setFlightInput({});
      }
      const afterLeg = Number(d.cameraAltitudeMetres);
      d.setCameraAltitude(target);
      d.orientToPlanetCenter();
      d.renderFrame();
      return { beforeLeg, afterLeg, afterSnap: Number(d.cameraAltitudeMetres) };
    }, { target: altitude, flyTheLeg: hasPrevious });
    previousAltitude = altitude;

    if (hasPrevious) {
      expect(
        leg.afterLeg,
        `leg to ${altitude} m: the camera actually moved (integration started at ${leg.beforeLeg} m)`,
      ).not.toBe(leg.beforeLeg);
      expect(
        Math.abs(leg.afterLeg - altitude) / altitude,
        `leg to ${altitude} m: integration alone landed at ${leg.afterLeg} m`,
      ).toBeLessThanOrEqual(LEG_RELATIVE_TOLERANCE);
    }
    expect(
      Math.abs(leg.afterSnap - altitude),
      `snap to ${altitude} m re-derived the exact altitude`,
    ).toBeLessThanOrEqual(snapToleranceMetres(altitude));

    // No NaN/Infinity in any exposed camera/renderer value at this stop.
    await assertFinite();

    const info = await page.evaluate(() => {
      const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
      if (d === undefined) throw new Error('__kwetuDebug not installed');
      return d.renderInfo;
    });
    expect(info.triangles, `triangles rendered at ${altitude} m`).toBeGreaterThan(0);
    expect(info.calls, `draw calls at ${altitude} m (no per-frame allocation storms)`).toBeLessThan(MAX_DRAW_CALLS);

    // Stationary jitter, two signals over the same frames: 30 consecutive
    // tick+render frames (the world advances one 1/60 s tick per frame — the
    // camera holds station, so "stationary" stays honest), re-project the
    // fixed surface point each frame (signal 1) and read the canvas back
    // (signal 2).
    const loop = await page.evaluate(
      ({ point, frames }) => {
        const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
        if (d === undefined) throw new Error('__kwetuDebug not installed');
        const frameCount0 = d.frameCount;
        const simSeconds0 = d.simElapsedSeconds;
        const xs: number[] = [];
        const ys: number[] = [];
        const gpuMaxDeltas: number[] = [];
        const worstDeltas: GpuWorstDelta[] = [];
        let changedPixels = 0;
        let comparedPixels = 0;
        let width = 0;
        let height = 0;
        let previousRgba: Uint8Array | null = null;
        for (let i = 0; i < frames; i++) {
          d.advance(1 / 60); // tick: input sync, rig.tick, applyCamera, bodies.update, clock
          d.renderFrame();
          const projected = d.projectPoint(point);
          xs.push(projected.xPx);
          ys.push(projected.yPx);
          const grab = d.readCanvasRgba();
          if (grab === null) throw new Error('readCanvasRgba: GL readPixels failed');
          width = grab.width;
          height = grab.height;
          if (previousRgba !== null) {
            if (grab.width * grab.height !== previousRgba.length / 4) {
              throw new Error('canvas resized mid-loop');
            }
            let maxDelta = 0;
            let argmax = -1;
            for (let j = 0; j < grab.rgba.length; j += 4) {
              const deltaR = Math.abs(grab.rgba[j]! - previousRgba[j]!);
              const deltaG = Math.abs(grab.rgba[j + 1]! - previousRgba[j + 1]!);
              const deltaB = Math.abs(grab.rgba[j + 2]! - previousRgba[j + 2]!);
              const channelMax = Math.max(deltaR, deltaG, deltaB);
              if (channelMax > 0) changedPixels++;
              if (channelMax > maxDelta) {
                maxDelta = channelMax;
                argmax = j;
              }
            }
            gpuMaxDeltas.push(maxDelta);
            if (maxDelta > 0 && argmax >= 0) {
              worstDeltas.push({
                frame: i,
                maxDelta,
                px: Math.round((argmax / 4) % grab.width),
                py: Math.floor(argmax / 4 / grab.width),
                from: [previousRgba[argmax]!, previousRgba[argmax + 1]!, previousRgba[argmax + 2]!],
                to: [grab.rgba[argmax]!, grab.rgba[argmax + 1]!, grab.rgba[argmax + 2]!],
              });
            }
            comparedPixels += grab.width * grab.height;
          } else {
            gpuMaxDeltas.push(0);
          }
          previousRgba = grab.rgba;
        }
        return {
          xs,
          ys,
          gpuMaxDeltas,
          worstDeltas,
          changedPixels,
          comparedPixels,
          width,
          height,
          frameCountDelta: d.frameCount - frameCount0,
          simDeltaSeconds: d.simElapsedSeconds - simSeconds0,
        };
      },
      { point: surfacePoint, frames: JITTER_FRAMES },
    );

    // Non-degeneracy guards (review 2026-09-06): the loop must have run the
    // app's real per-frame path — rendered JITTER_FRAMES frames and advanced
    // simulated time one fixed tick per frame — not re-rendered frozen state.
    expect(
      loop.frameCountDelta,
      'jitter loop rendered exactly one frame per iteration',
    ).toBe(JITTER_FRAMES);
    expect(
      loop.simDeltaSeconds,
      'jitter loop advanced simulated time by one 1/60 s tick per frame',
    ).toBeCloseTo(JITTER_FRAMES / 60, 9);

    // Signal 1: CPU re-projection of the fixed f64 point through the live
    // camera (std dev of its pixel position over the frames).
    const jitterX = stdDev(loop.xs);
    const jitterY = stdDev(loop.ys);
    expect(jitterX, `stationary jitter x at ${altitude} m`).toBeLessThan(JITTER_TOLERANCE_PX);
    expect(jitterY, `stationary jitter y at ${altitude} m`).toBeLessThan(JITTER_TOLERANCE_PX);

    // Signal 2: GPU image stability — the readback bound that can actually
    // see vertex-stage quantization (signal 1 cannot). The max-delta bound is
    // banded by what the frame can contain (see the constants): a tight bound
    // where the frame is all planet surface, a wider one where a far body's
    // f32-stepped silhouette can legitimately transit the frame.
    const gpuMaxDelta = Math.max(...loop.gpuMaxDeltas);
    const changedFraction = loop.comparedPixels === 0 ? 0 : loop.changedPixels / loop.comparedPixels;
    const groundFilled = altitude <= GROUND_FILLED_MAX_ALTITUDE_METRES;
    const maxDeltaBound = groundFilled ? GPU_GROUND_MAX_CHANNEL_DELTA : GPU_FARFIELD_MAX_CHANNEL_DELTA;
    const worst = loop.worstDeltas.reduce<GpuWorstDelta | null>(
      (a, b) => (b.maxDelta > (a?.maxDelta ?? 0) ? b : a),
      null,
    );
    const worstText =
      worst === null
        ? 'no pixel changed'
        : `worst frame-pair ${worst.frame}: ${worst.maxDelta} at (${worst.px},${worst.py}) ` +
          `[${worst.from.join(',')}]->[${worst.to.join(',')}]`;
    expect(
      gpuMaxDelta,
      `GPU frame stability (max channel delta) at ${altitude} m (${loop.width}x${loop.height}, ` +
        `${groundFilled ? 'ground-filled band' : 'far-field band'}): ${worstText}`,
    ).toBeLessThanOrEqual(maxDeltaBound);
    expect(
      changedFraction,
      `GPU frame stability (changed-pixel fraction) at ${altitude} m: ${worstText}`,
    ).toBeLessThanOrEqual(GPU_MAX_CHANGED_PIXEL_FRACTION);
  }

  // Far stop only: planet disc vs star backdrop distinct depth (see header).
  const probe = await page.evaluate(() => {
    const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (d === undefined) throw new Error('__kwetuDebug not installed');
    return d.depthProbe();
  });
  expect(probe, 'depth probe read back (WebGL2 DEPTH_COMPONENT from an FBO)').not.toBeNull();
  const centerDepth = probe!.centerDepth;
  expect(Number.isFinite(centerDepth), 'planet depth is finite').toBe(true);
  expect(centerDepth, 'planet disc wrote depth, not the clear value').toBeLessThan(1);
  for (const cornerDepth of probe!.cornerDepths) {
    expect(
      centerDepth,
      `planet depth ${centerDepth} distinct from backdrop depth ${cornerDepth} (log depth planes separated)`,
    ).toBeLessThan(cornerDepth);
  }

  // The whole flight (and the probe) produced zero console errors / page errors.
  expect(problems, `no errors across the flight: ${problems.join(' | ')}`).toEqual([]);

  // Dispose path must be clean too.
  await page.evaluate(() => {
    const d = (window as Window & { __kwetuDebug?: KwetuDebug }).__kwetuDebug;
    if (d === undefined) throw new Error('__kwetuDebug not installed');
    d.dispose();
  });
  expect(problems, `no errors during dispose: ${problems.join(' | ')}`).toEqual([]);
});
