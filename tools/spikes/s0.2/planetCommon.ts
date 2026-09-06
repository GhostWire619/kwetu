// S0.2 probe — shared planet math: cube-face mapping, analytic displacement
// (single source of truth for the JS f64 and GLSL f32 versions, band-limited
// per LOD level), elevation tint, screen-space error, patch error metric and
// VRAM accounting.
//
// Probe-only carve-out (CLAUDE.md): throwaway code under tools/spikes/.

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

/** Probe stand-in for Earth's mean radius (m). Probe constant, not a geodesy claim. */
export const PLANET_RADIUS = 6_371_000;

export const FACE_COUNT = 6;

/** Face basis with au x av = n, so (u, v) grids wind CCW seen from outside. */
export interface FaceBasis {
  readonly n: Vector3;
  readonly au: Vector3;
  readonly av: Vector3;
}

export const FACES: readonly FaceBasis[] = [
  { n: new Vector3(1, 0, 0), au: new Vector3(0, 0, -1), av: new Vector3(0, 1, 0) },
  { n: new Vector3(-1, 0, 0), au: new Vector3(0, 0, 1), av: new Vector3(0, 1, 0) },
  { n: new Vector3(0, 1, 0), au: new Vector3(1, 0, 0), av: new Vector3(0, 0, -1) },
  { n: new Vector3(0, -1, 0), au: new Vector3(1, 0, 0), av: new Vector3(0, 0, 1) },
  { n: new Vector3(0, 0, 1), au: new Vector3(1, 0, 0), av: new Vector3(0, 1, 0) },
  { n: new Vector3(0, 0, -1), au: new Vector3(-1, 0, 0), av: new Vector3(0, 1, 0) },
];

/** Cube-face local (u, v) in [-1, 1] -> unit sphere direction. */
export function cubeToDir(face: number, u: number, v: number, out: Vector3): Vector3 {
  const f = FACES[face] as FaceBasis;
  return out
    .copy(f.n)
    .addScaledVector(f.au, u)
    .addScaledVector(f.av, v)
    .normalize();
}

/**
 * Analytic displacement octaves. ONE table drives the JS (f64, CPU-built
 * quadtree geometry) and GLSL (f32, CDLOD vertex shader) implementations, so
 * both schemes displace the same planet. No textures.
 *
 * Spectrum: slope-flat macro relief (first 4 octaves) plus steep "alpine"
 * micro relief (last 4) so the LOD tree is exercised down to the patch floor.
 * Finest wavelength 2*pi*R/5e5 = 80 m with 3 m amplitude.
 */
export interface HeightOctave {
  amp: number;
  /** unit-sphere wavevector of the sin factor */
  kx: number;
  ky: number;
  kz: number;
  phK: number;
  /** unit-sphere wavevector of the cos factor */
  mx: number;
  my: number;
  mz: number;
  phM: number;
}

function oct(
  amp: number,
  k: number,
  kd: readonly [number, number, number],
  phK: number,
  md: readonly [number, number, number],
  phM: number,
): HeightOctave {
  return {
    amp,
    kx: k * kd[0],
    ky: k * kd[1],
    kz: k * kd[2],
    phK,
    mx: k * md[0],
    my: k * md[1],
    mz: k * md[2],
    phM,
  };
}

export const HEIGHT_OCTAVES: readonly HeightOctave[] = [
  oct(2000, 3.07, [0.8, 0.28, 0.53], 0.7, [-0.42, 0.8, 0.43], 0.4),
  oct(500, 12.3, [0.62, -0.4, 0.68], 1.3, [0.75, 0.55, -0.36], 0.0),
  oct(124, 49.4, [-0.3, 0.71, 0.64], 0.0, [0.55, -0.62, 0.56], 0.9),
  oct(31, 200, [0.68, 0.6, -0.42], 0.5, [-0.58, -0.44, 0.69], 1.7),
  oct(12, 3200, [-0.72, 0.35, -0.6], 0.2, [0.38, 0.72, 0.58], 1.1),
  oct(30, 33400, [0.45, -0.78, 0.44], 1.9, [-0.66, 0.3, -0.69], 0.6),
  oct(10, 133500, [0.85, 0.2, -0.49], 0.3, [-0.35, -0.68, 0.64], 2.3),
  oct(3, 500000, [-0.52, 0.66, 0.54], 0.4, [0.62, 0.48, -0.62], 2.0),
];

export const OCTAVE_COUNT = HEIGHT_OCTAVES.length;

/** Max |h| (sum of amplitudes) — bounding bound used for sphere radii. */
export const HEIGHT_MAX = HEIGHT_OCTAVES.reduce((s, o) => s + o.amp, 0);

/**
 * Band-limiting rule: a patch whose cell spans `cellFace` cube-face units
 * includes octaves with |k| * cellFace <= 1.5 (Nyquist + margin). Cube-face
 * cell size at quadtree depth d / CDLOD level l is exactly 2^-d / 16 face
 * units (faces span [-1,1] with a (16-cell) grid), so the octave ladder per
 * level is a pure function of depth.
 */
export function octaveCountForDepth(depth: number): number {
  const cellFace = Math.pow(2, -depth) / 16;
  let count = 0;
  for (const o of HEIGHT_OCTAVES) {
    const kmag = Math.sqrt(o.kx * o.kx + o.ky * o.ky + o.kz * o.kz);
    if (kmag * cellFace <= 1.5) count++;
    else break;
  }
  return Math.max(1, count);
}

/** Sum of amplitudes EXCLUDED at `depth` — the band jump a skirt must cover. */
export function droppedAmpM(depth: number): number {
  const kept = octaveCountForDepth(depth);
  let sum = 0;
  for (let i = kept; i < OCTAVE_COUNT; i++) {
    sum += (HEIGHT_OCTAVES[i] as HeightOctave).amp;
  }
  return sum;
}

/** JS f64 height (m) at a unit direction, band-limited to the first `oMax` octaves. */
export function heightAtBanded(d: Vector3, oMax: number): number {
  let h = 0;
  const n = Math.min(oMax, OCTAVE_COUNT);
  for (let i = 0; i < n; i++) {
    const o = HEIGHT_OCTAVES[i] as HeightOctave;
    h += o.amp * Math.sin(o.kx * d.x + o.ky * d.y + o.kz * d.z + o.phK) *
      Math.cos(o.mx * d.x + o.my * d.y + o.mz * d.z + o.phM);
  }
  return h;
}

/** Full-band JS height. */
export function heightAt(d: Vector3): number {
  return heightAtBanded(d, OCTAVE_COUNT);
}

function glslFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/**
 * GLSL f32 banded height — generated from HEIGHT_OCTAVES so both stay in
 * lockstep. Arguments are mod-wrapped into [-pi, pi] before sin/cos: at
 * planetary scale |k*d| reaches ~7e5 rad where D3D-class range reduction is
 * unspecified; wrapping keeps the trig input small. The f32 wrapping costs
 * ~k*d*2^-24 rad of phase (~0.1 m on the finest octave) — accepted and noted.
 */
export function glslHeightFn(): string {
  const body = HEIGHT_OCTAVES.map((o, i) => {
    const a = `(${glslFloat(o.kx)}*d.x + ${glslFloat(o.ky)}*d.y + ${glslFloat(o.kz)}*d.z + ${glslFloat(o.phK)})`;
    const b = `(${glslFloat(o.mx)}*d.x + ${glslFloat(o.my)}*d.y + ${glslFloat(o.mz)}*d.z + ${glslFloat(o.phM)})`;
    return `    if (i == ${i}) { h += ${glslFloat(o.amp)} * sin(mod(${a}, 6.2831853)) * cos(mod(${b}, 6.2831853)); }`;
  });
  return [
    'float s02_heightBanded(vec3 d, float oMax) {',
    '  float h = 0.0;',
    `  for (int i = 0; i < ${OCTAVE_COUNT}; i++) {`,
    '    if (float(i) >= oMax) break;',
    body.join('\n'),
    '  }',
    '  return h;',
    '}',
    `float s02_height(vec3 d) { return s02_heightBanded(d, ${glslFloat(OCTAVE_COUNT)}); }`,
  ].join('\n');
}

/** Elevation tint ramp (shared by the CPU and shader paths). */
export const TINT_STOPS: readonly { h: number; rgb: readonly [number, number, number] }[] = [
  { h: -1500, rgb: [0.13, 0.27, 0.4] },
  { h: -200, rgb: [0.18, 0.36, 0.3] },
  { h: 60, rgb: [0.26, 0.4, 0.2] },
  { h: 900, rgb: [0.46, 0.4, 0.24] },
  { h: 2200, rgb: [0.52, 0.46, 0.4] },
  { h: 4200, rgb: [0.82, 0.8, 0.8] },
  { h: 6000, rgb: [0.97, 0.97, 0.99] },
];

export function elevationTint(h: number, out: Vector3): Vector3 {
  const stops = TINT_STOPS;
  const first = stops[0] as { h: number; rgb: readonly [number, number, number] };
  const last = stops[stops.length - 1] as { h: number; rgb: readonly [number, number, number] };
  if (h <= first.h) return out.set(first.rgb[0], first.rgb[1], first.rgb[2]);
  if (h >= last.h) return out.set(last.rgb[0], last.rgb[1], last.rgb[2]);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i] as { h: number; rgb: readonly [number, number, number] };
    const b = stops[i + 1] as { h: number; rgb: readonly [number, number, number] };
    if (h >= a.h && h <= b.h) {
      const t = (h - a.h) / (b.h - a.h);
      return out.set(
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t,
      );
    }
  }
  return out.set(last.rgb[0], last.rgb[1], last.rgb[2]);
}

export function glslTintFn(): string {
  const stops = TINT_STOPS;
  const lines = stops.map(
    (s) =>
      `  if (h <= ${glslFloat(s.h)}) return vec3(${glslFloat(s.rgb[0])}, ${glslFloat(s.rgb[1])}, ${glslFloat(s.rgb[2])});`,
  );
  const last = stops[stops.length - 1] as { h: number; rgb: readonly [number, number, number] };
  return [
    'vec3 s02_tint(float h) {',
    ...lines,
    `  return vec3(${glslFloat(last.rgb[0])}, ${glslFloat(last.rgb[1])}, ${glslFloat(last.rgb[2])});`,
    '}',
  ].join('\n');
}

/**
 * Cosine threshold of the EXACT horizon-cull test. A patch whose center
 * direction sits at planet-center angle theta from the camera sub-point is
 * potentially visible iff theta <= thetaHorizon + patchAngularRadius, i.e.
 * iff cd.dot(camDir) >= cos(thetaHorizon + patchAngularRadius). The previous
 * probe form (cosHorizon - angularRadius) subtracted a RADIUS from a COSINE,
 * which over-keeps far-side quads wherever the angular radius is large (a
 * root quad's 1.05 rad margin swamps cos(30 deg) = 0.87 at 1e6 m altitude and
 * never culled anything) — both schemes now cull with this exact form.
 * `cosHorizon` <= -1 (camera inside the mean sphere) disables the cull.
 */
export function horizonCullCos(cosHorizon: number, angularRadius: number): number {
  if (cosHorizon <= -1) return -2;
  return Math.cos(Math.acos(Math.min(1, Math.max(-1, cosHorizon))) + angularRadius);
}

const levelErrCache = new Map<string, number>();

/**
 * Total geometric error (dropped band + kept-band interpolation) of LOD level
 * `depth`, taken as the MAX over 16 deterministic sample quads spread over
 * face 0. ONE shared metric drives the screen-space-error decisions of BOTH
 * LOD schemes, so their split distances and patch counts are directly
 * comparable. It also removes the per-node 1,313-sample error evaluation from
 * the split path: measured 2026-09-06, that lazy per-node computation was the
 * cause of a 6.7 s first-frame stall in the quadtree (thousands of nodes each
 * evaluating a 17x17 grid + 4 samples/cell on the first descent to 1 m).
 */
export function levelErrorM(depth: number, gridN: number): number {
  const key = `${depth}:${gridN}`;
  const hit = levelErrCache.get(key);
  if (hit !== undefined) return hit;
  const n = 1 << depth;
  const size = 2 / n;
  let e = 0;
  for (let i = 0; i < 16; i++) {
    const X = (i * 37 + 3) % n;
    const Y = (i * 91 + 11) % n;
    const err = totalPatchErrorM(0, -1 + X * size, -1 + Y * size, size, gridN, depth);
    if (err > e) e = err;
  }
  levelErrCache.set(key, e);
  return e;
}

/**
 * Tight bounding-sphere radius (m) of a patch of cube-face extent `size`
 * rendered at band `depth`: the half-chord of the patch's true angular extent
 * plus a bound on the band-limited relief variation across the patch (each
 * kept octave contributes min(amp, amp*pi*arc/wavelength) — octaves much
 * longer than the patch shift center and vertices equally and cancel against
 * the band-limited center height). Replaces the earlier ad-hoc bounds
 * (quadtree: faceSize*0.78 + HEIGHT_MAX + 100; CDLOD: faceSize*0.78): the
 * HEIGHT_MAX term floored `dist` at ~1 m for every patch within ~3 km of a
 * ground camera and over-split the whole nadir disc to max depth (measured
 * 2026-09-06: 4,336 pooled patches / 84 MiB at 1 m altitude), and the two
 * schemes' differing bounds made their split decisions incomparable. ONE
 * shared radius now feeds both schemes' split distance and frustum sphere.
 */
export function patchBoundRadiusM(size: number, depth: number): number {
  const alpha = quadAngularRadius(size) / 1.1; // un-margined angular radius
  const arc = faceSizeToWorldM(size);
  let relief = 0;
  for (let i = 0; i < octaveCountForDepth(depth); i++) {
    const o = HEIGHT_OCTAVES[i] as HeightOctave;
    const kmag = Math.sqrt(o.kx * o.kx + o.ky * o.ky + o.kz * o.kz);
    relief += Math.min(o.amp, (o.amp * Math.PI * arc * kmag) / (2 * Math.PI));
  }
  return PLANET_RADIUS * Math.sin(Math.min(alpha, Math.PI / 2)) + relief + 10;
}

/**
 * Screen-space error (px) of a feature of geometric error `geomErrM` seen from
 * `distM` with vertical fov `fovRad` on a `viewportH`-px tall viewport.
 */
export function screenSpaceError(geomErrM: number, distM: number, viewportH: number, fovRad: number): number {
  const d = Math.max(distM, 1e-2);
  return (geomErrM * viewportH) / (2 * d * Math.tan(fovRad / 2));
}

/** Approximate world arc length of a cube-face-local extent `size` (face units). */
export function faceSizeToWorldM(size: number): number {
  return size * (Math.PI / 2) * PLANET_RADIUS;
}

/**
 * Angular radius (rad, seen from the planet center) of a quad of cube-face
 * extent `size`: max angle between the quad center direction and any quad
 * corner direction = acos(1 / sqrt(1 + size^2/2)) (au x av = n, corners at
 * n +/- (size/2)(au+av)), scaled by a 1.1 cull-margin factor. Exact for the
 * sphere; the height field adds the margin. Replaces the old face-units-as-
 * radians `size * 1.1`, which over-conservatively kept far-side coarse quads
 * (a size-2 quad got a 2.2 rad margin — more than the 90 deg to any face).
 */
export function quadAngularRadius(size: number): number {
  return Math.acos(1 / Math.sqrt(1 + (size * size) / 2)) * 1.1;
}

/**
 * INTERPOLATION error (m) of the band-limited rendering of patch (face, u0,
 * v0, size) on an n-per-side grid: max distance between the band-limited
 * surface (oMax octaves, the surface actually rendered) and the
 * piecewise-linear surface through its grid vertices, sampled 4x per cell.
 *
 * The reference is the SAME band as the rendered grid, not the full-octave
 * surface: sampling the full 8-octave field at 4 points per cell aliases the
 * octaves the grid does not carry (at level 8 the 80 m octave is sampled at
 * ~1.2 km), which floor-ed the measured error at an artifactual ~constant and
 * stalled the SSE-driven split distance (measured 2026-09-06: splitDist(12) /
 * splitDist(11) ~ 1.03 instead of < 0.5). The octaves DROPPED at this depth
 * are accounted separately and exactly by droppedAmpM(depth) in
 * totalPatchErrorM. Shared by both LOD schemes so their SSE metrics are
 * comparable.
 */
export function gridErrorM(face: number, u0: number, v0: number, size: number, n: number, oMax: number): number {
  const cell = size / (n - 1);
  const p = new Vector3();
  const d = new Vector3();
  const ps: Vector3[] = new Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      cubeToDir(face, u0 + cell * i, v0 + cell * j, d);
      ps[j * n + i] = d.clone().multiplyScalar(PLANET_RADIUS + heightAtBanded(d, oMax));
    }
  }
  let maxErr = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const p00 = ps[j * n + i] as Vector3;
      const p10 = ps[j * n + i + 1] as Vector3;
      const p01 = ps[(j + 1) * n + i] as Vector3;
      const p11 = ps[(j + 1) * n + i + 1] as Vector3;
      for (const [fx, fy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ] as const) {
        cubeToDir(face, u0 + cell * (i + fx), v0 + cell * (j + fy), d);
        p.copy(d).multiplyScalar(PLANET_RADIUS + heightAtBanded(d, oMax)); // band-limited reference
        const ax = p00.x + (p10.x - p00.x) * fx;
        const ay = p00.y + (p10.y - p00.y) * fx;
        const az = p00.z + (p10.z - p00.z) * fx;
        const bx = p01.x + (p11.x - p01.x) * fx;
        const by = p01.y + (p11.y - p01.y) * fx;
        const bz = p01.z + (p11.z - p01.z) * fx;
        const rx = ax + (bx - ax) * fy;
        const ry = ay + (by - ay) * fy;
        const rz = az + (bz - az) * fy;
        const dx = p.x - rx;
        const dy = p.y - ry;
        const dz = p.z - rz;
        const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (err > maxErr) maxErr = err;
      }
    }
  }
  return maxErr;
}

/**
 * TOTAL geometric error (m) of rendering a patch at `depth`: the octaves the
 * band drops (absent relief, bounded exactly by their amplitude sum) plus the
 * interpolation error of the kept band. This is the quantity SSE must drive
 * splits with — it is monotone non-increasing with depth and strictly
 * decreasing inside an octave plateau (interp shrinks ~4x per grid refinement)
 * until it hits the dropped-amplitude floor. Used by both schemes.
 */
export function totalPatchErrorM(face: number, u0: number, v0: number, size: number, n: number, depth: number): number {
  return droppedAmpM(depth) + gridErrorM(face, u0, v0, size, n, octaveCountForDepth(depth));
}

/** Sum of all attribute + index bytes of a BufferGeometry (== GPU upload size). */
export function geometryBytes(g: BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as BufferAttribute;
    bytes += attr.array.byteLength;
  }
  if (g.index !== null) bytes += g.index.array.byteLength;
  return bytes;
}

/** Lat/lon (rad) -> unit direction (y = north pole). */
export function dirFromLatLon(lat: number, lon: number, out: Vector3): Vector3 {
  const cl = Math.cos(lat);
  return out.set(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon));
}
