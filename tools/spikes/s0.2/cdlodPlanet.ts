// S0.2 probe — Scheme B: CDLOD-style continuous-morph grid per cube face
// (Strugar's algorithm re-expressed in our own implementation): stateless
// per-frame selection, GPU vertex morph between the level's band-limited
// surface and the parent level's grid, cracks closed by edge-collapse flags
// (fine edge vertices snap onto the coarser grid) cooperating with the morph.
// Rendered as up to 6 instanced draw calls (one per cube face, CPU frustum
// culled).
//
// Precision arrangement (Law P-2 / ADR-002 probe form): the shader never
// computes planetary-magnitude positions. Every instance carries aOrigin =
// (anchor world position - camera position) composed in f64 on the CPU and
// downcast once to f32 (magnitude = camera distance to the quad, <= horizon
// distance); the vertex shader builds the surface QUAD-LOCAL to that anchor
// with a cancellation-free decomposition (see s02_localSurf): the vertex
// offset from the anchor is computed from exact small quantities, so
// near-camera precision is f32 ULP of quad-local magnitudes, not of the
// 6.4e6 m planet radius.
//
// Probe-only carve-out (CLAUDE.md): throwaway code under tools/spikes/.

import {
  BufferAttribute,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import {
  FACE_COUNT,
  HEIGHT_MAX,
  PLANET_RADIUS,
  cubeToDir,
  faceSizeToWorldM,
  geometryBytes,
  glslHeightFn,
  glslTintFn,
  heightAtBanded,
  horizonCullCos,
  levelErrorM,
  octaveCountForDepth,
  quadAngularRadius,
  screenSpaceError,
} from './planetCommon';
import { FACES } from './planetCommon';

export const CD_GRID_N = 17;
export const CD_MAX_LEVEL = 16;
export const CD_SSE_PX = 2;
export const CD_INSTANCE_CAP = 4096; // per face (dropped quads are counted, never silent)
export const CD_MORPH_START_FRAC = 0.5; // morphStart = frac * parentSplitDist
/** Anchor-direction cache cap (entries); cleared wholesale when exceeded. */
export const CD_ANCHOR_CACHE_CAP = 262144;

const CELLS = CD_GRID_N - 1; // 16
/** Cube-face bounding sphere: center at faceDir*cos(gammaMax)*R, radius as derived. */
const FACE_SPHERE_COS = 1 / Math.sqrt(3); // cos(54.7356 deg) — max angle from face normal
const FACE_SPHERE_RADIUS = PLANET_RADIUS * Math.sqrt(2 / 3) + HEIGHT_MAX + 1000;

/**
 * Cube-face adjacency: for face f, edge e (0:v=-1, 1:u=+1, 2:v=+1, 3:u=-1)
 * -> [adjacent face, adjacent edge]. The adjacent face is the one whose normal
 * dominates the edge's outward direction; the shared edge ON that face is
 * found by gnomonically projecting the edge MIDPOINT direction onto the
 * adjacent face and reading which boundary coordinate is +-1. (The previous
 * approach — matching an edge whose outward direction is the negative of this
 * edge's outward — is wrong for perpendicular faces: the two faces' tangent
 * outward directions at a shared edge are not antiparallel, so the search
 * failed for 8 of 24 edges and produced edge index -1, whose edgeMax lookup
 * was undefined and poisoned the collapse flags with NaN — caught by the
 * probe suite, measured 2026-09-06.)
 */
function buildAdjacency(): [number, number][][] {
  const faceOfDir = (d: Vector3): number => {
    let best = 0;
    let bestDot = -2;
    for (let f = 0; f < FACE_COUNT; f++) {
      const v = d.dot(FACES_N[f] as Vector3);
      if (v > bestDot) {
        bestDot = v;
        best = f;
      }
    }
    return best;
  };
  const table: [number, number][][] = [];
  for (let f = 0; f < FACE_COUNT; f++) {
    const au = FACES_AU[f] as Vector3;
    const av = FACES_AV[f] as Vector3;
    // outward direction of each edge
    const outward = [av.clone().negate(), au.clone(), av.clone(), au.clone().negate()];
    const row: [number, number][] = [];
    for (let e = 0; e < 4; e++) {
      const o = outward[e] as Vector3;
      const nf = faceOfDir(o);
      // Edge midpoint direction on face f (u or v = +-1, other coord 0).
      const mid = new Vector3().copy(FACES_N[f] as Vector3);
      if (e === 0) mid.addScaledVector(av, -1);
      else if (e === 1) mid.addScaledVector(au, 1);
      else if (e === 2) mid.addScaledVector(av, 1);
      else mid.addScaledVector(au, -1);
      // Gnomonic projection onto the adjacent face: (u, v) = (d.au, d.av)/d.n.
      const dn = mid.dot(FACES_N[nf] as Vector3);
      const u = mid.dot(FACES_AU[nf] as Vector3) / dn;
      const v = mid.dot(FACES_AV[nf] as Vector3) / dn;
      let ne: number;
      if (Math.abs(u) > Math.abs(v)) ne = u > 0 ? 1 : 3;
      else ne = v > 0 ? 2 : 0;
      row.push([nf, ne]);
    }
    table.push(row);
  }
  return table;
}

// Face basis vectors as plain arrays (module-local; planetCommon owns the canonical ones).
const FACES_N = FACES.map((f) => f.n.clone());
const FACES_AU = FACES.map((f) => f.au.clone());
const FACES_AV = FACES.map((f) => f.av.clone());
/** Cube-face adjacency table (exported for probe introspection/tests). */
export const ADJ = buildAdjacency();

export interface CdlodStats {
  instancesVisible: number;
  /** per-face instance counts of the last update (parallel to faces) */
  countsPerFace: number[];
  selectionMs: number;
  /** emitted quads per level (last frame) */
  instancesPerLevel: number[];
  /** quads dropped because the per-face instance cap was hit (must stay 0) */
  droppedByCap: number;
  /** faces skipped whole by the CPU frustum test (last frame) */
  culledFaces: number;
  vramBytes: number;
}

export class CdlodPlanet {
  readonly group = new Group();
  readonly stats: CdlodStats = {
    instancesVisible: 0,
    countsPerFace: new Array(FACE_COUNT).fill(0),
    selectionMs: 0,
    instancesPerLevel: new Array(CD_MAX_LEVEL + 1).fill(0),
    droppedByCap: 0,
    culledFaces: 0,
    vramBytes: 0,
  };

  private meshes: Mesh[] = [];
  private geoms: InstancedBufferGeometry[] = [];
  // Probe introspection (tests read the emitted instance data directly).
  readonly aQuad: InstancedBufferAttribute[] = [];
  readonly aFlags: InstancedBufferAttribute[] = [];
  readonly aMeta: InstancedBufferAttribute[] = [];
  readonly aOrigin: InstancedBufferAttribute[] = [];
  /** split distance per level (dist at which a level-l node splits) */
  readonly splitDist: number[] = new Array(CD_MAX_LEVEL + 1).fill(0);
  private seen: Set<number>[] = [];
  /** anchor cache: key -> [x, y, z] world f64 anchor (quad center surface point) */
  private anchorCache = new Map<number, [number, number, number]>();
  // Emitted-leaf records as parallel number arrays (reused across frames —
  // selection is allocation-free after warmup, matching the quadtree's pooled
  // path so the CPU comparison is fair).
  private emFace: number[] = [];
  private emLevel: number[] = [];
  private emX: number[] = [];
  private emY: number[] = [];
  private emMorph: number[] = [];
  private edgeMax: number[][] = []; // per face, 4 edges: max emitted level touching it
  private viewportH = 720;
  private fovRad = 1.0;
  private camPos = new Vector3();
  private tmp = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  private tmpD = new Vector3();
  private faceSphere = new Sphere(new Vector3(), FACE_SPHERE_RADIUS);

  constructor() {
    // Shared base grid: position = local grid indices (i, j, 0), i/j in 0..16.
    const posArr = new Float32Array(CD_GRID_N * CD_GRID_N * 3);
    for (let j = 0; j < CD_GRID_N; j++) {
      for (let i = 0; i < CD_GRID_N; i++) {
        posArr[(j * CD_GRID_N + i) * 3] = i;
        posArr[(j * CD_GRID_N + i) * 3 + 1] = j;
      }
    }
    const pos = new Float32BufferAttribute(posArr, 3);
    const idxArr = new Uint32Array(CELLS * CELLS * 6);
    let w = 0;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = j * CD_GRID_N + i;
        const b = a + 1;
        const c = a + CD_GRID_N;
        const e = c + 1;
        idxArr[w++] = a;
        idxArr[w++] = b;
        idxArr[w++] = e;
        idxArr[w++] = a;
        idxArr[w++] = e;
        idxArr[w++] = c;
      }
    }
    const idx = new Uint32BufferAttribute(idxArr, 1);

    for (let f = 0; f < FACE_COUNT; f++) {
      const geom = new InstancedBufferGeometry();
      geom.setAttribute('position', pos);
      geom.setIndex(idx);
      const q = new InstancedBufferAttribute(new Float32Array(CD_INSTANCE_CAP * 4), 4);
      const fl = new InstancedBufferAttribute(new Float32Array(CD_INSTANCE_CAP * 4), 4);
      const mt = new InstancedBufferAttribute(new Float32Array(CD_INSTANCE_CAP * 2), 2);
      const or = new InstancedBufferAttribute(new Float32Array(CD_INSTANCE_CAP * 3), 3);
      q.setUsage(DynamicDrawUsage);
      fl.setUsage(DynamicDrawUsage);
      mt.setUsage(DynamicDrawUsage);
      or.setUsage(DynamicDrawUsage);
      geom.setAttribute('aQuad', q);
      geom.setAttribute('aFlags', fl);
      geom.setAttribute('aMeta', mt);
      geom.setAttribute('aOrigin', or);
      geom.instanceCount = 0;
      this.geoms.push(geom);
      this.aQuad.push(q);
      this.aFlags.push(fl);
      this.aMeta.push(mt);
      this.aOrigin.push(or);

      const material = new MeshLambertMaterial({ vertexColors: true });
      const faceN = (FACES_N[f] as Vector3).clone();
      const faceAu = (FACES_AU[f] as Vector3).clone();
      const faceAv = (FACES_AV[f] as Vector3).clone();
      material.onBeforeCompile = (shader) => {
        shader.uniforms['uFaceN'] = { value: faceN };
        shader.uniforms['uFaceAu'] = { value: faceAu };
        shader.uniforms['uFaceAv'] = { value: faceAv };
        shader.uniforms['uPlanetR'] = { value: PLANET_RADIUS };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${cdlodShaderPars()}`)
          .replace('#include <color_vertex>', '')
          .replace('#include <beginnormal_vertex>', cdlodVertexBody())
          .replace('#include <begin_vertex>', 'vec3 transformed = s02pos;');
      };
      material.customProgramCacheKey = () => 's02-cdlod';
      const mesh = new Mesh(geom, material);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      // Per-face culling is done CPU-side (see update) against camera-relative
      // face spheres; three's per-mesh test would need a per-frame bounding
      // volume, so it is disabled here.
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    for (let l = 0; l <= CD_MAX_LEVEL; l++) this.seen.push(new Set<number>());
    // Exact allocation: per face, base grid (position + index) + the four
    // instance attributes at their allocated cap (aQuad 4 + aFlags 4 + aMeta 2
    // + aOrigin 3 floats) — WebGL buffers are allocated at creation size
    // regardless of the per-frame instanceCount.
    this.stats.vramBytes = FACE_COUNT * geometryBytes(this.geoms[0] as InstancedBufferGeometry);
  }

  /** Quad anchor (world f64 surface point of the quad center), cached. */
  private anchorFor(face: number, level: number, X: number, Y: number): [number, number, number] {
    const key = ((face * (CD_MAX_LEVEL + 1) + level) * 65536 + Y) * 65536 + X;
    const hit = this.anchorCache.get(key);
    if (hit !== undefined) return hit;
    const n = 1 << level;
    const size = 2 / n;
    const cd = this.tmpD;
    cubeToDir(face, -1 + (X + 0.5) * size, -1 + (Y + 0.5) * size, cd);
    const r = PLANET_RADIUS + heightAtBanded(cd, octaveCountForDepth(level));
    const anchor: [number, number, number] = [cd.x * r, cd.y * r, cd.z * r];
    if (this.anchorCache.size >= CD_ANCHOR_CACHE_CAP) this.anchorCache.clear();
    this.anchorCache.set(key, anchor);
    return anchor;
  }

  update(camPos: Vector3, viewportH: number, fovRad: number, frustum?: {
    intersectsSphere(sphere: Sphere): boolean;
  } | null): void {
    const t0 = performance.now();
    this.camPos.copy(camPos);
    this.viewportH = viewportH;
    this.fovRad = fovRad;
    const tanHalf = Math.tan(fovRad / 2);
    // Split distance per level: dist where the level's SSE crosses the threshold.
    for (let l = 0; l <= CD_MAX_LEVEL; l++) {
      const e = levelErrorM(l, CD_GRID_N);
      this.splitDist[l] = (e * viewportH) / (2 * CD_SSE_PX * tanHalf);
    }
    for (const s of this.seen) s.clear();
    this.emFace.length = 0;
    this.emLevel.length = 0;
    this.emX.length = 0;
    this.emY.length = 0;
    this.emMorph.length = 0;
    this.edgeMax = [];
    for (let f = 0; f < FACE_COUNT; f++) this.edgeMax.push([0, 0, 0, 0]);

    const camLen = camPos.length();
    const camDir = this.tmpB.copy(camPos).normalize();
    const cosHorizon = camLen > PLANET_RADIUS ? PLANET_RADIUS / camLen : -1;

    // Phase 0: whole-face CPU frustum cull (camera-relative face spheres).
    let culled = 0;
    const faceActive: boolean[] = [];
    for (let f = 0; f < FACE_COUNT; f++) {
      let active = true;
      if (frustum !== undefined && frustum !== null) {
        const center = this.tmpD
          .copy(FACES_N[f] as Vector3)
          .multiplyScalar(FACE_SPHERE_COS * PLANET_RADIUS)
          .sub(camPos);
        this.faceSphere.center.copy(center);
        active = frustum.intersectsSphere(this.faceSphere);
      }
      faceActive.push(active);
      if (!active) culled++;
    }
    this.stats.culledFaces = culled;

    // Phase 1: selection (stateless recursion), recording seen cells + emissions.
    for (let f = 0; f < FACE_COUNT; f++) {
      if (!faceActive[f]) continue;
      this.select(f, 0, 0, 0, cosHorizon, camDir);
    }
    // Phase 2: edge-collapse flags per emitted quad, then instance buffers.
    const counts = new Array(FACE_COUNT).fill(0);
    const perLevel = new Array(CD_MAX_LEVEL + 1).fill(0);
    this.stats.droppedByCap = 0;
    for (let e = 0; e < this.emFace.length; e++) {
      const face = this.emFace[e] as number;
      const level = this.emLevel[e] as number;
      const X = this.emX[e] as number;
      const Y = this.emY[e] as number;
      const morph = this.emMorph[e] as number;
      const n = 1 << level;
      const q = { face, level };
      const rL = this.edgeRatio(q, X === 0 ? 3 : -1, X - 1, Y, n);
      const rR = this.edgeRatio(q, X === n - 1 ? 1 : -1, X + 1, Y, n);
      const rB = this.edgeRatio(q, Y === 0 ? 0 : -1, X, Y - 1, n);
      const rT = this.edgeRatio(q, Y === n - 1 ? 2 : -1, X, Y + 1, n);
      const k = counts[face] as number;
      if (k >= CD_INSTANCE_CAP) {
        this.stats.droppedByCap++;
        continue;
      }
      counts[face] = k + 1;
      const qArr = (this.aQuad[face] as InstancedBufferAttribute).array as Float32Array;
      const fArr = (this.aFlags[face] as InstancedBufferAttribute).array as Float32Array;
      const mArr = (this.aMeta[face] as InstancedBufferAttribute).array as Float32Array;
      const oArr = (this.aOrigin[face] as InstancedBufferAttribute).array as Float32Array;
      qArr[k * 4] = X * CELLS;
      qArr[k * 4 + 1] = Y * CELLS;
      qArr[k * 4 + 2] = 2 / n / CELLS;
      qArr[k * 4 + 3] = morph;
      fArr[k * 4] = rL;
      fArr[k * 4 + 1] = rR;
      fArr[k * 4 + 2] = rB;
      fArr[k * 4 + 3] = rT;
      mArr[k * 2] = octaveCountForDepth(level);
      mArr[k * 2 + 1] = octaveCountForDepth(Math.max(0, level - 1));
      // Camera-relative anchor: f64 world anchor minus f64 camera position,
      // THEN the single f32 downcast (magnitude = camera distance, bounded by
      // the horizon cull — never the planetary radius).
      const anchor = this.anchorFor(face, level, X, Y);
      oArr[k * 3] = anchor[0] - camPos.x;
      oArr[k * 3 + 1] = anchor[1] - camPos.y;
      oArr[k * 3 + 2] = anchor[2] - camPos.z;
      perLevel[level] = (perLevel[level] as number) + 1;
    }
    for (let f = 0; f < FACE_COUNT; f++) {
      const geom = this.geoms[f] as InstancedBufferGeometry;
      const used = counts[f] as number;
      geom.instanceCount = used;
      this.stats.countsPerFace[f] = used;
      for (const attr of [this.aQuad[f], this.aFlags[f], this.aMeta[f], this.aOrigin[f]] as InstancedBufferAttribute[]) {
        attr.clearUpdateRanges();
        if (used > 0) {
          const itemSize = attr.itemSize;
          attr.addUpdateRange(0, used * itemSize);
        }
        attr.needsUpdate = true;
      }
    }
    this.stats.instancesVisible = this.emFace.length;
    this.stats.instancesPerLevel = perLevel;
    this.stats.selectionMs = performance.now() - t0;
  }

  /**
   * Edge-collapse ratio for one edge. `edgeIdx` >= 0 means the quad touches
   * that face boundary edge (cross-face rule); otherwise the same-level
   * neighbor cell (nX, nY) is inspected: seen -> no collapse; unseen -> the
   * covering coarser leaf's level sets the ratio (clamped to 4).
   */
  private edgeRatio(
    q: { face: number; level: number },
    edgeIdx: number,
    nX: number,
    nY: number,
    n: number,
  ): number {
    if (edgeIdx >= 0) {
      const adj = ADJ[q.face]?.[edgeIdx] as [number, number] | undefined;
      if (adj === undefined) return 1;
      const [nf, ne] = adj;
      const nbLevel = (this.edgeMax[nf] as number[])[ne] as number;
      if (nbLevel >= q.level) return 1;
      return Math.min(4, Math.pow(2, q.level - nbLevel));
    }
    if (nX < 0 || nY < 0 || nX >= n || nY >= n) return 1;
    if (this.seen[q.level]?.has(nY * n + nX)) return 1;
    for (let ll = q.level - 1; ll >= 0; ll--) {
      const shift = q.level - ll;
      const m = 1 << ll;
      const cx = Math.floor(nX / (1 << shift));
      const cy = Math.floor(nY / (1 << shift));
      if (cx >= 0 && cy >= 0 && cx < m && cy < m && (this.seen[ll] as Set<number>).has(cy * m + cx)) {
        return Math.min(4, Math.pow(2, shift));
      }
    }
    return 1; // region not rendered (e.g. frustum-culled face) — no constraint
  }

  private select(
    face: number,
    level: number,
    X: number,
    Y: number,
    cosHorizon: number,
    camDir: Vector3,
  ): void {
    const n = 1 << level;
    const size = 2 / n;
    // Quad center direction (unit) for the horizon test; band-limited world
    // center (cached anchor) for the distance test. Reused temps — no
    // per-node allocation, no per-node trig after the anchor is cached.
    const cd = this.tmpC;
    cubeToDir(face, -1 + (X + 0.5) * size, -1 + (Y + 0.5) * size, cd);
    // Horizon cull first (cheapest, prunes the anchor lookups too). EXACT form
    // (angle space, via horizonCullCos): the quad's true angular radius plus
    // the horizon angle — the old cosine-space subtraction over-kept far-side
    // quads, and the earlier size-as-radians form never culled a root quad.
    if (cosHorizon > -1 && cd.dot(camDir) < horizonCullCos(cosHorizon, quadAngularRadius(size))) return;
    const anchor = this.anchorFor(face, level, X, Y);
    const dist = Math.max(
      this.camPos.distanceTo(this.tmp.set(anchor[0], anchor[1], anchor[2])) -
        faceSizeToWorldM(size) * 0.78,
      1,
    );
    const err = levelErrorM(level, CD_GRID_N);
    const sse = screenSpaceError(err, dist, this.viewportH, this.fovRad);
    if (level < CD_MAX_LEVEL && sse > CD_SSE_PX) {
      (this.seen[level] as Set<number>).add(Y * n + X);
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          this.select(face, level + 1, X * 2 + i, Y * 2 + j, cosHorizon, camDir);
        }
      }
      return;
    }
    // Emit leaf with the CDLOD morph factor. The morph TARGET is the parent
    // level's grid+band, so the ramp is governed by the split distance at
    // which THIS node was created (the parent's splitDist), not by its own:
    // morph = 1 exactly at the creation distance (fully coarse — the surface
    // the parent was rendering when it split, so the split instant is
    // seamless), 0 once the camera is closer than morphStart.
    let morph = 0;
    if (level > 0) {
      const sdP = this.splitDist[level - 1] as number;
      if (sdP > 0) {
        const morphStart = sdP * CD_MORPH_START_FRAC;
        morph = Math.min(1, Math.max(0, (dist - morphStart) / (sdP - morphStart)));
      }
    }
    (this.seen[level] as Set<number>).add(Y * n + X);
    this.emFace.push(face);
    this.emLevel.push(level);
    this.emX.push(X);
    this.emY.push(Y);
    this.emMorph.push(morph);
    // Track face-boundary edge levels for cross-face flags.
    if (X === 0) {
      const e = this.edgeMax[face] as number[];
      e[3] = Math.max(e[3] as number, level);
    }
    if (X === n - 1) {
      const e = this.edgeMax[face] as number[];
      e[1] = Math.max(e[1] as number, level);
    }
    if (Y === 0) {
      const e = this.edgeMax[face] as number[];
      e[0] = Math.max(e[0] as number, level);
    }
    if (Y === n - 1) {
      const e = this.edgeMax[face] as number[];
      e[2] = Math.max(e[2] as number, level);
    }
  }
}

// ---- shader chunks ---------------------------------------------------------

function cdlodShaderPars(): string {
  return [
    'uniform vec3 uFaceN;',
    'uniform vec3 uFaceAu;',
    'uniform vec3 uFaceAv;',
    'uniform float uPlanetR;',
    'attribute vec4 aQuad;   // Xb, Yb (global grid indices), scale (face units / grid step), morph',
    'attribute vec4 aFlags;  // edge collapse ratio: left, right, bottom, top (1 = none)',
    'attribute vec2 aMeta;   // octave count: fine level, coarse level',
    'attribute vec3 aOrigin; // camera-relative anchor (f64-composed on CPU, f32 here)',
    glslHeightFn(),
    glslTintFn(),
    '',
    '// Quad-local surface point at face-unit offset dG from the anchor, band-limited',
    '// to `band` octaves. EXACT decomposition (no series truncation): with',
    '// f = f0 + delta, d = f/|f|, cos(theta) = (c0 + d0.delta)/|f| and',
    '// sin(theta)*t = (delta - d0*(d0.delta))/|f| — both computed from exact small',
    '// quantities, so no cancellation anywhere; 1-cos uses the half-angle-stable',
    '// identity sin^2/(1+cos). Returns vec4(local position, height).',
    'vec4 s02_localSurf(vec2 dG, float band, vec3 f0, vec3 d0, float c0) {',
    '  vec3 delta = uFaceAu * dG.x + uFaceAv * dG.y;',
    '  float dq = dot(d0, delta);',
    '  vec3 dp = delta - d0 * dq;',
    '  vec3 fh = f0 + delta;',
    '  float lenF = length(fh);',
    '  float cosT = (c0 + dq) / lenF;',
    '  float oneM = dot(dp, dp) / (lenF * lenF) / (1.0 + cosT);',
    '  float h = s02_heightBanded(fh / lenF, band);',
    '  float h0 = s02_heightBanded(d0, band);',
    '  float A = (h - h0) - (uPlanetR + h) * oneM;',
    '  float B = (uPlanetR + h) / lenF;',
    '  return vec4(A * d0 + B * dp, h);',
    '}',
  ].join('\n');
}

function cdlodVertexBody(): string {
  return [
    '// --- S0.2 CDLOD quad-local displacement (replaces beginnormal_vertex) ---',
    'vec2 g = position.xy;',
    'if (g.x < 0.5)  g.y = floor(g.y / aFlags.x + 0.5) * aFlags.x;',
    'if (g.x > 15.5) g.y = floor(g.y / aFlags.y + 0.5) * aFlags.y;',
    'if (g.y < 0.5)  g.x = floor(g.x / aFlags.z + 0.5) * aFlags.z;',
    'if (g.y > 15.5) g.x = floor(g.x / aFlags.w + 0.5) * aFlags.w;',
    'float s = aQuad.z;',
    '// Anchor frame: global grid coords of the quad center cell (+8 of 16).',
    'vec2 G0 = vec2(aQuad.x, aQuad.y) + 8.0;',
    'vec2 G0f = -1.0 + G0 * s;',
    'vec3 f0 = uFaceN + uFaceAu * G0f.x + uFaceAv * G0f.y;',
    'float c0 = length(f0);',
    'vec3 d0 = f0 / c0;',
    '// Fine band-limited surface, quad-local (dG exact small: (g - 8) * s).',
    'vec2 dG = (g - 8.0) * s;',
    'vec4 fine = s02_localSurf(dG, aMeta.x, f0, d0, c0);',
    'vec3 s02pos = fine.xyz;',
    'if (aQuad.w > 0.0001) {',
    '  // Morph toward the PARENT grid evaluated at the same anchor: parent grid',
    '  // vertices sit at even global grid indices; the blend is exact 3D, so at',
    '  // morph = 1 the vertex IS the parent-grid surface point (seamless split).',
    '  // Anchor-band correction: s02_localSurf returns S_b(t) - S_b(a) exactly,',
    '  // but the anchor sits at the FINE band height, so S_coarse(a) = anchor -',
    '  // (h_fine(a) - h_coarse(a)) * d0 and the coarse target in anchor-relative',
    '  // space is p_coarse - corr with corr = (h_fine(a) - h_coarse(a)) * d0',
    '  // (without it, morph=1 is offset from the parent surface by the band jump',
    '  // at the anchor — up to droppedAmpM(level) m; caught by the f64 mirror',
    '  // test, measured 2026-09-06).',
    '  vec2 Gg = vec2(aQuad.x, aQuad.y) + g;',
    '  vec2 Gcg = floor(Gg * 0.5) * 2.0;',
    '  vec2 dGc = (Gcg - G0) * s;',
    '  vec2 fr = (Gg - Gcg) * 0.5;',
    '  float h0f = s02_heightBanded(d0, aMeta.x);',
    '  float h0c = s02_heightBanded(d0, aMeta.y);',
    '  vec3 corr = (h0f - h0c) * d0;',
    '  vec3 c00 = s02_localSurf(dGc, aMeta.y, f0, d0, c0).xyz;',
    '  vec3 c10 = s02_localSurf(dGc + vec2(2.0 * s, 0.0), aMeta.y, f0, d0, c0).xyz;',
    '  vec3 c01 = s02_localSurf(dGc + vec2(0.0, 2.0 * s), aMeta.y, f0, d0, c0).xyz;',
    '  vec3 c11 = s02_localSurf(dGc + vec2(2.0 * s, 2.0 * s), aMeta.y, f0, d0, c0).xyz;',
    '  vec3 posCoarse = mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y) - corr;',
    '  s02pos = mix(posCoarse, fine.xyz, aQuad.w);',
    '}',
    'vec4 pu = s02_localSurf(dG + vec2(s, 0.0), aMeta.x, f0, d0, c0);',
    'vec4 pv = s02_localSurf(dG + vec2(0.0, s), aMeta.x, f0, d0, c0);',
    'vec3 objectNormal = normalize(cross(pu.xyz - fine.xyz, pv.xyz - fine.xyz));',
    'vColor = s02_tint(fine.w);',
  ].join('\n');
}
