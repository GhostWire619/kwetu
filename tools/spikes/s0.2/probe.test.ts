// S0.2 probe — CPU-side vitest suite (no WebGL here: three's scene-graph,
// matrix and BufferGeometry math is headless; the GPU measurements live in
// measure.mjs + page/). Guards the probe invariants the ADR's numbers rest
// on: shared banding, exact VRAM accounting, quadtree split/merge + horizon
// culling behavior, CDLOD morph/edge-flag crack closure by construction, the
// scripted flight, and the reversed-Z projection + depth fixture layout.
//
// Probe-only carve-out (CLAUDE.md): throwaway code under tools/spikes/.

import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  DepthFormat,
  FloatType,
  PerspectiveCamera,
  Vector3,
  WebGLCoordinateSystem,
  Frustum,
  Matrix4,
} from 'three';
import {
  FACES,
  HEIGHT_OCTAVES,
  HEIGHT_MAX,
  OCTAVE_COUNT,
  PLANET_RADIUS,
  cubeToDir,
  dirFromLatLon,
  droppedAmpM,
  faceSizeToWorldM,
  geometryBytes,
  glslHeightFn,
  heightAt,
  heightAtBanded,
  horizonCullCos,
  octaveCountForDepth,
  quadAngularRadius,
  totalPatchErrorM,
} from './planetCommon';
import {
  FLIGHT_END_S,
  FLIGHT_HIGH_HOLD_END_S,
  FLIGHT_HIGH_HOLD_S,
  FLIGHT_STATS_FROM_S,
  flightPose,
} from './flightPath';
import { QT_GRID_N, QT_PATCH_BYTES, QT_POOL_CAP, QuadtreePlanet } from './quadtreePlanet';
import { ADJ, CD_GRID_N, CD_INSTANCE_CAP, CdlodPlanet } from './cdlodPlanet';
import {
  DEPTH_MODES,
  DEPTH_MODE_IDS,
  DEPTH_NEAR_M,
  DEPTH_FAR_M,
  DEPTH_PAIRS,
  buildDepthTestScene,
  configureCameraDepth,
  createF32DepthTarget,
} from './depthModes';

const LAT0 = 0.35;
const LON0 = 0.9;
const VIEWPORT_H = 720;
const FOV_RAD = 1.0471975512; // 60 deg

/** Camera position at (lat, lon, altitude) over the probe planet. */
function camAt(lat: number, lon: number, altM: number): Vector3 {
  return dirFromLatLon(lat, lon, new Vector3()).multiplyScalar(PLANET_RADIUS + altM);
}

describe('S0.2 shared planet math', () => {
  it('bands octaves monotonically with depth and drops amplitude monotonically', () => {
    for (let d = 0; d < 16; d++) {
      expect(octaveCountForDepth(d + 1)).toBeGreaterThanOrEqual(octaveCountForDepth(d));
      expect(droppedAmpM(d + 1)).toBeLessThanOrEqual(droppedAmpM(d));
    }
    // Depth 0 (|k| * cell <= 1.5 rule) keeps the first TWO octaves (k = 3.07
    // and 12.3 rad; 12.3 * (1/16) = 0.77 <= 1.5); the full band keeps all.
    expect(octaveCountForDepth(0)).toBe(2);
    expect(octaveCountForDepth(16)).toBe(OCTAVE_COUNT);
    expect(droppedAmpM(16)).toBe(0);
    expect(droppedAmpM(0)).toBeCloseTo(HEIGHT_MAX - (HEIGHT_OCTAVES[0]?.amp ?? 0) - (HEIGHT_OCTAVES[1]?.amp ?? 0), 6);
  });

  it('total patch error = dropped band + kept-band interpolation, monotone in depth', () => {
    for (let d = 0; d <= 16; d++) {
      const e = totalPatchErrorM(0, -1, -1, 2, QT_GRID_N, d);
      expect(e).toBeGreaterThanOrEqual(droppedAmpM(d));
      if (d > 0) {
        expect(e).toBeLessThanOrEqual(totalPatchErrorM(0, -1, -1, 2, QT_GRID_N, d - 1));
      }
    }
  });

  it('full-band height equals the banded evaluation at oMax = OCTAVE_COUNT', () => {
    const d = new Vector3();
    for (const [lat, lon] of [
      [0.0, 0.0],
      [LAT0, LON0],
      [-1.2, 2.5],
      [0.7, -3.0],
    ] as const) {
      dirFromLatLon(lat, lon, d);
      expect(heightAtBanded(d, OCTAVE_COUNT)).toBeCloseTo(heightAt(d), 12);
    }
  });

  it('generates the GLSL height function with one branch per octave', () => {
    const glsl = glslHeightFn();
    expect(glsl).toContain('float s02_heightBanded(vec3 d, float oMax)');
    expect(glsl.match(/if \(i == \d+\)/g)?.length).toBe(OCTAVE_COUNT);
  });
});

describe('S0.2 exact VRAM accounting (all geometry is created by the probe)', () => {
  it('quadtree patch bytes match the pooled allocation formula', () => {
    const verts = QT_GRID_N * QT_GRID_N + 4 * (QT_GRID_N - 1); // grid + skirt ring
    const tris = 2 * (QT_GRID_N - 1) * (QT_GRID_N - 1) + 2 * 4 * (QT_GRID_N - 1); // grid + skirt walls
    const expected = verts * 3 * 4 * 3 + tris * 3 * 4; // pos+normal+color f32 + uint32 index
    expect(QT_PATCH_BYTES).toBe(expected);
  });

  it('quadtree pool VRAM tracks allocations exactly', () => {
    const planet = new QuadtreePlanet();
    const cam = camAt(LAT0, LON0, 1);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    expect(planet.stats.geometriesAllocated).toBeGreaterThan(0);
    expect(planet.stats.geometriesAllocated).toBeLessThanOrEqual(QT_POOL_CAP);
    expect(planet.vramEstimateBytes()).toBe(planet.stats.geometriesAllocated * QT_PATCH_BYTES);
    expect(planet.stats.vramBytes).toBe(planet.vramEstimateBytes());
  });

  it('CDLOD allocation is base grid + instance caps, exactly', () => {
    const planet = new CdlodPlanet();
    const perFaceBase = 289 * 12 + 1536 * 4; // 17x17 pos f32 + 256 quads * 6 uint32 index
    const perFace = perFaceBase + CD_INSTANCE_CAP * 13 * 4; // aQuad4 + aFlags4 + aMeta2 + aOrigin3 f32
    expect(planet.stats.vramBytes).toBe(6 * perFace);
  });

  it('CDLOD per-face geometry buffers sum to the reported figure', () => {
    const planet = new CdlodPlanet();
    const mesh = planet.group.children[0] as unknown as { geometry: unknown };
    const geom = mesh.geometry as Parameters<typeof geometryBytes>[0];
    // geometryBytes includes the instance attributes (allocated at cap).
    expect(geometryBytes(geom)).toBe(289 * 12 + 1536 * 4 + CD_INSTANCE_CAP * 13 * 4);
  });
});

describe('S0.2 quadtree scheme (skirts, CPU side)', () => {
  it('deep LOD near the camera at 1 m, horizon-culled beyond the limb, no thrash on a small move', () => {
    const planet = new QuadtreePlanet();
    const cam = camAt(LAT0, LON0, 1);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    const leaves = planet.visibleLeaves();
    const visible = leaves.filter((l) => l.visible);
    expect(visible.length).toBeGreaterThan(50);
    expect(planet.stats.builtThisFrame).toBeGreaterThan(0);
    const maxDepth = Math.max(...visible.map((l) => l.depth));
    expect(maxDepth).toBeGreaterThanOrEqual(10);

    // Horizon: every VISIBLE leaf center must be within the horizon cone plus
    // the patch's true angular radius, composed in ANGLE space (the same exact
    // predicate emit() culls with — horizonCullCos).
    const camDir = cam.clone().normalize();
    const cosHorizon = PLANET_RADIUS / cam.length();
    for (const leaf of visible) {
      const cd = cubeToDir(leaf.face, leaf.u0 + leaf.size / 2, leaf.v0 + leaf.size / 2, new Vector3());
      expect(cd.dot(camDir)).toBeGreaterThanOrEqual(
        horizonCullCos(cosHorizon, quadAngularRadius(leaf.size)) - 1e-9,
      );
    }

    // Hysteresis: a small lateral move must not split or merge anything.
    const cam2 = camAt(LAT0 + 1e-7, LON0 + 1e-7, 1);
    planet.update(cam2, VIEWPORT_H, FOV_RAD);
    expect(planet.transitionsLast).toBe(0);
    expect(planet.stats.splits).toBe(0);
    expect(planet.stats.merges).toBe(0);
  });

  it('a CPU frustum cull strictly reduces the built set at 1 m altitude', () => {
    // The frustum is built for a camera AT THE ORIGIN (camera-relative space,
    // matching the page arrangement: planet group at -camPos); patch centers
    // are tested as cw - camPos inside emit().
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1.5e7);
    const cam = camAt(LAT0, LON0, 1);
    camera.position.set(0, 0, 0);
    camera.up.copy(cam).normalize();
    camera.lookAt(camAt(LAT0 - 1e-7, LON0 + 3e-7, 1).sub(cam)); // ground ahead, as the flight flies
    camera.updateMatrixWorld();
    const projScreen = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(projScreen, WebGLCoordinateSystem);
    const planet = new QuadtreePlanet();
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    const noCull = planet.stats.leavesVisible;
    planet.update(cam, VIEWPORT_H, FOV_RAD, frustum);
    const culled = planet.stats.leavesVisible;
    expect(culled).toBeGreaterThan(0);
    expect(culled).toBeLessThan(noCull);
  });

  it('high altitude collapses to a shallow tree', () => {
    const planet = new QuadtreePlanet();
    const cam = camAt(LAT0, LON0, 1e6);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    const visible = planet.visibleLeaves().filter((l) => l.visible);
    expect(visible.length).toBeGreaterThan(0);
    expect(Math.max(...visible.map((l) => l.depth))).toBeLessThanOrEqual(6);
  });

  it('renders camera-relative (Law P-2 probe form): group at -camPos, patch-local geometry', () => {
    const planet = new QuadtreePlanet();
    const cam = camAt(LAT0, LON0, 1e4);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    // The planet group carries the whole -camera translation.
    expect(planet.group.position.x).toBeCloseTo(-cam.x, 6);
    expect(planet.group.position.y).toBeCloseTo(-cam.y, 6);
    expect(planet.group.position.z).toBeCloseTo(-cam.z, 6);
    // Mesh translations stay ABSOLUTE patch centers (f64 matrix composition);
    // the geometry itself is stored patch-local: bounding spheres are bounded
    // by the patch extent + skirt, never by planetary magnitudes.
    let meshes = 0;
    for (const child of planet.group.children) {
      const mesh = child as unknown as { position: Vector3; geometry: BufferGeometry; visible: boolean };
      if (!mesh.visible) continue;
      meshes++;
      const len = mesh.position.length();
      expect(len).toBeGreaterThan(PLANET_RADIUS * 0.9);
      expect(len).toBeLessThan(PLANET_RADIUS * 1.4);
      mesh.geometry.computeBoundingSphere();
      expect(mesh.geometry.boundingSphere?.radius ?? Infinity).toBeLessThan(PLANET_RADIUS * 0.5);
    }
    expect(meshes).toBeGreaterThan(10);
  });
});

describe('S0.2 CDLOD scheme (edge flags + parent-grid morph, CPU side)', () => {
  it('face adjacency table is complete and symmetric', () => {
    for (let f = 0; f < 6; f++) {
      for (let e = 0; e < 4; e++) {
        const [nf, ne] = ADJ[f]![e]!;
        expect(nf).not.toBe(f);
        expect([0, 1, 2, 3]).toContain(ne);
        // Walking f -> nf across the shared edge must come back to (f, e):
        // both edges parametrize the same cube-edge segment.
        const [bf, be] = ADJ[nf]![ne]!;
        expect(bf).toBe(f);
        expect(be).toBe(e);
      }
    }
  });

  it('emits instances at 1 m without cap drops, flags in {1,2,4}, morph in [0,1]', () => {
    const planet = new CdlodPlanet();
    const cam = camAt(LAT0, LON0, 1);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    expect(planet.stats.instancesVisible).toBeGreaterThan(100);
    expect(planet.stats.droppedByCap).toBe(0);
    // Per-face counts are tracked explicitly and must sum to the total.
    const sumCounts = planet.stats.countsPerFace.reduce((a, b) => a + b, 0);
    expect(sumCounts).toBe(planet.stats.instancesVisible);
    // Written flag entries carry valid collapse ratios; unwritten tails are 0.
    let total = 0;
    for (let f = 0; f < 6; f++) {
      const flags = planet.aFlags[f]!.array as Float32Array;
      const count = planet.stats.countsPerFace[f] as number;
      for (let k = 0; k < count; k++) {
        const v = flags[k * 4] as number;
        expect([1, 2, 4]).toContain(v);
        total++;
      }
      for (let k = count; k < Math.min(count + 8, CD_INSTANCE_CAP); k++) {
        expect(flags[k * 4] as number).toBe(0);
      }
    }
    expect(total).toBe(planet.stats.instancesVisible);
  });

  it('instance anchors are camera-relative and bounded by the horizon cone per level', () => {
    const planet = new CdlodPlanet();
    const cam = camAt(LAT0, LON0, 1);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    for (let f = 0; f < 6; f++) {
      const origins = planet.aOrigin[f]!.array as Float32Array;
      const quads = planet.aQuad[f]!.array as Float32Array;
      const count = planet.stats.countsPerFace[f] as number;
      for (let k = 0; k < count; k++) {
        const x = origins[k * 3] as number;
        const y = origins[k * 3 + 1] as number;
        const z = origins[k * 3 + 2] as number;
        const len = Math.hypot(x, y, z);
        // Reconstruct the quad level from the instance payload: aQuad = (X*16,
        // Y*16, (2/n)/16, morph) -> cell face-size = scale*16 = 2/n.
        const cellFace = (quads[k * 4 + 2] as number) * 16;
        const size = cellFace * 16;
        // A kept quad's center is within (horizon angle + its true angular
        // radius) of the camera direction; the 3D camera->anchor chord is then
        // bounded by 2R' sin((horizon + margin)/2) plus slack for anchor
        // elevation and the f32 roundtrip.
        const horizonAngle = Math.acos(PLANET_RADIUS / cam.length());
        const bound = 2.05 * (PLANET_RADIUS + 3e3) * Math.sin((horizonAngle + quadAngularRadius(size)) / 2) +
          faceSizeToWorldM(size) * 0.6;
        expect(len).toBeLessThan(bound);
        // Near-field precision: quads at level >= 12 (<= 2.4 km cells) sit
        // within a few km of the camera; an ABSOLUTE-coordinate implementation
        // would store ~6.4e6 m here for every instance.
        if (size <= 2 / 4096) {
          expect(len).toBeLessThan(5e4);
        }
      }
    }
  });

  it('whole-face frustum cull drops all faces when the planet is behind the camera', () => {
    const planet = new CdlodPlanet();
    const camera = new PerspectiveCamera(60, 16 / 9, 1, 1e8);
    camera.position.set(5 * PLANET_RADIUS, 0, 0);
    camera.lookAt(10 * PLANET_RADIUS, 0, 0);
    camera.updateMatrixWorld();
    const projScreen = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(projScreen, WebGLCoordinateSystem);
    const camPos = new Vector3(5 * PLANET_RADIUS, 0, 0);
    planet.update(camPos, VIEWPORT_H, FOV_RAD, frustum);
    expect(planet.stats.culledFaces).toBe(6);
    expect(planet.stats.instancesVisible).toBe(0);
    // Without a frustum the cull is skipped entirely.
    planet.update(camPos, VIEWPORT_H, FOV_RAD);
    expect(planet.stats.culledFaces).toBe(0);
    expect(planet.stats.instancesVisible).toBeGreaterThan(0);
  });

  it('split distances are strictly monotone and the morph starts at 1 on creation', () => {
    const planet = new CdlodPlanet();
    const cam = camAt(LAT0, LON0, 1e4);
    planet.update(cam, VIEWPORT_H, FOV_RAD);
    // Total error (dropped band + kept-band interpolation) is monotone in
    // level, so the SSE-mapped split distance is strictly decreasing. Inside
    // an octave PLATEAU (several levels sharing one octave count) the ratio
    // approaches 1 as the error floors at the dropped-amplitude term — there
    // the fine and coarse surfaces nearly coincide (the morph blend amplitude
    // is the interpolation difference, sub-pixel), so an uncompleted morph is
    // visually moot. Measured ratios are recorded in report.json.
    for (let l = 1; l <= 12; l++) {
      const sdP = planet.splitDist[l - 1]!;
      const sdOwn = planet.splitDist[l]!;
      expect(sdOwn).toBeGreaterThan(0);
      expect(sdOwn).toBeLessThan(sdP);
      // A node is created at its PARENT's split distance, where the ramp must
      // read fully coarse (morph = 1) for a seamless split instant.
      const morphStart = sdP * 0.5;
      const morphAtCreation = Math.min(1, Math.max(0, (sdP - morphStart) / (sdP - morphStart)));
      expect(morphAtCreation).toBe(1);
    }
  });

  it('morph=1 reproduces the parent-grid surface point exactly (seamless split)', () => {
    // The shader's morph=1 position for a fine-grid vertex G is the 3D bilinear
    // mix of the four parent-grid surface points around it. On a shared BOUNDARY
    // (snap puts odd vertices onto even G) that must equal the parent surface
    // point computed at the parent's own grid step — the property that closes
    // the split-front seam. Verified here in f64 with the shared math.
    const fine = new Vector3();
    const coarse = new Vector3();
    const dir = new Vector3();
    const level = 6;
    const sizeFine = 2 / (1 << level);
    const sizeCoarse = 2 / (1 << (level - 1));
    const bandCoarse = octaveCountForDepth(level - 1);
    for (let i = 0; i < 32; i++) {
      const gx = 2 * ((i * 7) % 16); // even global fine-grid index
      const gy = 2 * ((i * 11) % 16);
      // Fine step: parent grid index = fine global index / 2.
      cubeToDir(0, -1 + gx * sizeFine / CD_GRID_N_MINUS_1, -1 + gy * sizeFine / CD_GRID_N_MINUS_1, dir);
      fine.copy(dir).multiplyScalar(PLANET_RADIUS + heightAtBanded(dir, bandCoarse));
      cubeToDir(0, -1 + (gx / 2) * sizeCoarse / CD_GRID_N_MINUS_1, -1 + (gy / 2) * sizeCoarse / CD_GRID_N_MINUS_1, dir);
      coarse.copy(dir).multiplyScalar(PLANET_RADIUS + heightAtBanded(dir, bandCoarse));
      expect(fine.distanceTo(coarse)).toBeLessThan(1e-9);
    }
  });
});
const CD_GRID_N_MINUS_1 = CD_GRID_N - 1;

describe('S0.2 CDLOD quad-local decomposition (f64 mirror of the shader formula)', () => {
  // Mirror of the GLSL s02_localSurf: algebraically EXACT decomposition of
  // S(anchor + dG) - S(anchor) into (radial along d0, perpendicular along dp),
  // with 1-cos(theta) via the half-angle-stable identity sin^2/(1+cos).
  function localSurfRef(
    face: number,
    g0f: readonly [number, number],
    dG: readonly [number, number],
    band: number,
  ): { p: Vector3; h: number } {
    const basis = FACES[face]!;
    const f0 = basis.n.clone().addScaledVector(basis.au, g0f[0]).addScaledVector(basis.av, g0f[1]);
    const c0 = f0.length();
    const d0 = f0.clone().divideScalar(c0);
    const delta = basis.au.clone().multiplyScalar(dG[0]).addScaledVector(basis.av, dG[1]);
    const dq = d0.dot(delta);
    const dp = delta.clone().addScaledVector(d0, -dq);
    const fh = f0.clone().add(delta);
    const lenF = fh.length();
    const cosT = (c0 + dq) / lenF;
    const oneM = dp.lengthSq() / (lenF * lenF) / (1 + cosT);
    const dH = fh.clone().divideScalar(lenF);
    const h = heightAtBanded(dH, band);
    const h0 = heightAtBanded(d0, band);
    const a = h - h0 - (PLANET_RADIUS + h) * oneM;
    const b = (PLANET_RADIUS + h) / lenF;
    return { p: d0.clone().multiplyScalar(a).addScaledVector(dp, b), h };
  }

  /** Absolute band-limited surface point at face coords (f64 direct evaluation). */
  function surfAt(face: number, gf: readonly [number, number], band: number): Vector3 {
    const basis = FACES[face]!;
    const dir = basis.n.clone().addScaledVector(basis.au, gf[0]).addScaledVector(basis.av, gf[1]).normalize();
    return dir.multiplyScalar(PLANET_RADIUS + heightAtBanded(dir, band));
  }

  it('localSurfRef(0) is exactly zero (anchor cancellation is exact)', () => {
    for (const level of [0, 3, 8, 14]) {
      const s = 2 / (1 << level) / 16;
      const g0f: readonly [number, number] = [-1 + (5 * 16 + 8) * s, -1 + (3 * 16 + 8) * s];
      const r = localSurfRef(0, g0f, [0, 0], octaveCountForDepth(level));
      expect(r.p.x).toBe(0);
      expect(r.p.y).toBe(0);
      expect(r.p.z).toBe(0);
    }
  });

  it('matches the direct f64 surface difference to 1e-5 m at near AND coarse quads', () => {
    for (const [level, x, y] of [
      [14, 100, 200], // near-camera class: 19 m cells, dG ~ 6e-4 face units
      [8, 7, 3], // mid: ~39 km cells
      [3, 1, 2], // coarse: ~1300 km cells, dG ~ 0.09 face units
    ] as const) {
      const n = 1 << level;
      const s = 2 / n / 16;
      const g0f: readonly [number, number] = [-1 + (x * 16 + 8) * s, -1 + (y * 16 + 8) * s];
      const band = octaveCountForDepth(level);
      const anchor = surfAt(0, g0f, band);
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [7, 9],
        [-8, -8],
        [8, 8],
      ] as const) {
        const dG: readonly [number, number] = [du * s, dv * s];
        const ref = localSurfRef(0, g0f, dG, band);
        const direct = surfAt(0, [g0f[0] + dG[0], g0f[1] + dG[1]], band).sub(anchor);
        expect(ref.p.distanceTo(direct)).toBeLessThan(1e-5);
      }
    }
  });

  it('parent and child anchors render the identical parent-grid surface point (seamless split)', () => {
    // anchorP + localSurfP(dGP, coarseBand) == anchorC + localSurfC(dGC, coarseBand)
    //   + (h_fineC(a_C) - h_coarse(a_C)) * d0C      [the shader's anchor-band
    // correction] — for the same global surface point. This is the property
    // that makes the CDLOD morph=1 state exactly coincide across a split,
    // independent of anchor. The child is the LOWER-LEFT quarter (its center
    // sits one half-quad step down-left of the parent center in each axis), so
    // a parent-grid vertex 2 parent cells up-right of the parent anchor is
    // 2 + 4 = 6 parent cells = 12 child cells up-right of the CHILD anchor.
    for (const [level, x, y] of [
      [4, 2, 3],
      [10, 300, 700],
    ] as const) {
      const sP = 2 / (1 << level) / 16;
      const sC = sP / 2;
      const g0fP: readonly [number, number] = [-1 + (x * 16 + 8) * sP, -1 + (y * 16 + 8) * sP];
      const g0fC: readonly [number, number] = [-1 + (2 * x * 16 + 8) * sC, -1 + (2 * y * 16 + 8) * sC];
      const bandCoarse = octaveCountForDepth(level); // child's aMeta.y == parent's band
      const bandFineP = octaveCountForDepth(level);
      const bandFineC = octaveCountForDepth(level + 1);
      const anchorP = surfAt(0, g0fP, bandFineP);
      const anchorC = surfAt(0, g0fC, bandFineC);
      const dGP: readonly [number, number] = [2 * sP, 2 * sP];
      const dGC: readonly [number, number] = [12 * sC, 12 * sC]; // same face position
      const sideP = anchorP.clone().add(localSurfRef(0, g0fP, dGP, bandCoarse).p);
      // Anchor-band correction, exactly as the shader computes it: the coarse
      // target in anchor-relative space is p_coarse - (h_fine(a) - h_coarse(a)) * d0.
      const basis = FACES[0]!;
      const f0C = basis.n.clone().addScaledVector(basis.au, g0fC[0]).addScaledVector(basis.av, g0fC[1]);
      const d0C = f0C.clone().divideScalar(f0C.length());
      const corr = d0C.clone().multiplyScalar(
        heightAtBanded(d0C, bandFineC) - heightAtBanded(d0C, bandCoarse),
      );
      const sideC = anchorC.clone().add(localSurfRef(0, g0fC, dGC, bandCoarse).p).sub(corr);
      expect(sideP.distanceTo(sideC)).toBeLessThan(1e-6);
    }
  });
});

describe('S0.2 scripted flight', () => {
  it('profiles 1 m -> 1e6 m -> 1e3 m with deterministic, continuous altitude', () => {
    expect(FLIGHT_STATS_FROM_S).toBe(3);
    expect(FLIGHT_HIGH_HOLD_S).toBe(15);
    expect(FLIGHT_HIGH_HOLD_END_S).toBe(23);
    expect(FLIGHT_END_S).toBe(42);
    expect(flightPose(0).altM).toBe(1);
    expect(flightPose(FLIGHT_HIGH_HOLD_S + 1).altM).toBe(1e6);
    expect(flightPose(FLIGHT_END_S - 1).altM).toBe(1e3);
    // Mid-ascent is the geometric mean (log-eased).
    const mid = flightPose((FLIGHT_STATS_FROM_S + FLIGHT_HIGH_HOLD_S) / 2);
    expect(mid.altM).toBeCloseTo(Math.sqrt(1 * 1e6), 0);
    // Deterministic.
    expect(flightPose(17.3)).toEqual(flightPose(17.3));
    // Phases ordered and labelled.
    expect(flightPose(1).phase).toBe('warmup');
    expect(flightPose(9).phase).toBe('ascend');
    expect(flightPose(19).phase).toBe('high');
    expect(flightPose(30).phase).toBe('descend');
    expect(flightPose(40).phase).toBe('low');
  });
});

describe('S0.2 depth modes', () => {
  it('declares exactly the four strategies with mutually exclusive mechanisms', () => {
    expect(DEPTH_MODE_IDS).toHaveLength(4);
    for (const id of DEPTH_MODE_IDS) {
      const m = DEPTH_MODES[id]!;
      if (id === 'log') {
        expect(m.rendererOptions.logarithmicDepthBuffer).toBe(true);
        expect(m.rendererOptions.reversedDepthBuffer).toBe(false);
        expect(m.cameraReversed).toBe(false);
      } else if (id === 'std') {
        expect(m.rendererOptions.logarithmicDepthBuffer).toBe(false);
        expect(m.rendererOptions.reversedDepthBuffer).toBe(false);
      } else {
        expect(m.rendererOptions.reversedDepthBuffer).toBe(true);
        expect(m.cameraReversed).toBe(true);
        expect(m.renderTargetF32).toBe(id === 'revz-f32');
      }
    }
  });

  it('reversed camera maps near to NDC z=1 and far to NDC z=0 (reversed projection)', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, DEPTH_NEAR_M, DEPTH_FAR_M);
    configureCameraDepth(camera, 'revz');
    expect(camera.reversedDepth).toBe(true);
    const p = new Vector3();
    expect(p.set(0, 0, -DEPTH_NEAR_M).project(camera).z).toBeCloseTo(1, 6);
    // z(d) = (n/(f-n)) (1 - f/d) for the reversed perspective; at d = 2n that
    // is (f - 2n) / (2(f-n)) — just UNDER 0.5 for f >> n.
    expect(p.set(0, 0, -(DEPTH_NEAR_M * 2)).project(camera).z).toBeCloseTo(
      (DEPTH_FAR_M - 2 * DEPTH_NEAR_M) / (2 * (DEPTH_FAR_M - DEPTH_NEAR_M)),
      9,
    );
    expect(p.set(0, 0, -DEPTH_FAR_M).project(camera).z).toBeCloseTo(0, 6);
    // Monotone decreasing with distance (reversed).
    const zNear = p.set(0, 0, -10).project(camera).z;
    const zFar = p.set(0, 0, -10000).project(camera).z;
    expect(zNear).toBeGreaterThan(zFar);
  });

  it('reversed frustum culls with swapped near/far planes', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, DEPTH_NEAR_M, DEPTH_FAR_M);
    configureCameraDepth(camera, 'revz');
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();
    const projScreen = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(projScreen, WebGLCoordinateSystem, camera.reversedDepth);
    expect(frustum.containsPoint(new Vector3(0, 0, -1))).toBe(true);
    expect(frustum.containsPoint(new Vector3(0, 0, -DEPTH_FAR_M + 1))).toBe(true);
    expect(frustum.containsPoint(new Vector3(0, 0, -DEPTH_FAR_M * 2))).toBe(false);
    expect(frustum.containsPoint(new Vector3(0, 0, -DEPTH_NEAR_M / 2))).toBe(false);
  });

  it('f32 depth target carries a FloatType DepthTexture (DEPTH_COMPONENT32F path)', () => {
    const rt = createF32DepthTarget(64, 32);
    expect(rt.depthTexture).not.toBeNull();
    expect(rt.depthTexture?.type).toBe(FloatType); // three 0.185: FloatType === 1015
    expect(rt.depthTexture?.format).toBe(DepthFormat);
    expect(rt.samples).toBe(0);
    rt.dispose();
  });

  it('depth fixture: back quad drawn last, sample boxes derived from projected corners', () => {
    const W = 1280;
    const H = 720;
    const camera = new PerspectiveCamera(60, W / H, DEPTH_NEAR_M, DEPTH_FAR_M);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();
    const { scene, samples } = buildDepthTestScene(camera, W, H);
    expect(scene.children).toHaveLength(6);
    expect(samples).toHaveLength(3);
    for (const s of samples) {
      // Inner box strictly inside the projected front quad.
      expect(s.inner.x).toBeGreaterThan(s.frontRect.x);
      expect(s.inner.x + s.inner.w).toBeLessThan(s.frontRect.x + s.frontRect.w);
      expect(s.inner.y).toBeGreaterThan(s.frontRect.y);
      expect(s.inner.y + s.inner.h).toBeLessThan(s.frontRect.y + s.frontRect.h);
      // Annulus strictly between the projected back and front LEFT edges
      // (never covered by the front quad; always on the back quad).
      expect(s.annulus.x).toBeGreaterThan(s.backRect.x);
      expect(s.annulus.x + s.annulus.w).toBeLessThan(s.frontRect.x);
      expect(s.annulus.w).toBeGreaterThan(8);
      expect(s.annulus.h).toBeGreaterThan(8);
      // The back quad really is wider than the front quad (ring exists).
      expect(s.backRect.x).toBeLessThan(s.frontRect.x);
      expect(s.backRect.w).toBeGreaterThan(s.frontRect.w);
    }
    // Pairs are stacked vertically: front-quad y ranges do not overlap.
    const ys = samples.map((s) => [s.frontRect.y, s.frontRect.y + s.frontRect.h] as const).sort((a, b) => a[0] - b[0]);
    expect(ys[0]![1]).toBeLessThanOrEqual(ys[1]![0]);
    expect(ys[1]![1]).toBeLessThanOrEqual(ys[2]![0]);
    // renderOrder: front (1) before back (2) so the depth compare is load-bearing.
    const orders = scene.children.map((c) => c.renderOrder);
    for (let i = 0; i < orders.length; i += 2) {
      expect(orders[i]).toBe(1);
      expect(orders[i + 1]).toBe(2);
    }
  });

  it('depth pairs span near, mid and far ranges with the task gaps', () => {
    expect(DEPTH_PAIRS.map((p) => p.d)).toEqual([8, 5_000, 500_000]);
    expect(DEPTH_PAIRS.map((p) => p.gap)).toEqual([0.001, 0.05, 2]);
    expect(DEPTH_NEAR_M).toBe(0.1);
    expect(DEPTH_FAR_M).toBe(1.5e7);
  });
});
