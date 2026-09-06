// S0.2 probe — Scheme A: cube-sphere quadtree, per-frame split/merge by
// screen-space error, CPU-displaced patch geometry from a geometry pool,
// cracks handled by radial SKIRTS (the chosen crack approach for this scheme:
// no neighbor-topology dependency, works with async/streaming chunks).
//
// Probe-only carve-out (CLAUDE.md): throwaway code under tools/spikes/.

import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Frustum,
  Group,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import {
  FACE_COUNT,
  PLANET_RADIUS,
  cubeToDir,
  droppedAmpM,
  elevationTint,
  faceSizeToWorldM,
  heightAtBanded,
  horizonCullCos,
  levelErrorM,
  octaveCountForDepth,
  patchBoundRadiusM,
  quadAngularRadius,
  screenSpaceError,
} from './planetCommon';

export const QT_GRID_N = 17; // vertices per patch side (16 cells)
export const QT_MAX_DEPTH = 16;
export const QT_SSE_PX = 2;
export const QT_HYSTERESIS = 1.5;
/** Pool cap. Measured 2026-09-06: the 1 m-altitude tree wants ~4.3k patches
 * without a frustum cull (whole over-horizon disc) — the cap sits above that;
 * the GPU page passes a frustum and allocates well under it. */
export const QT_POOL_CAP = 8192;

const CELLS = QT_GRID_N - 1;
const GRID_VERTS = QT_GRID_N * QT_GRID_N;
const PERIM = 4 * CELLS; // skirt ring vertex count
const VERTS = GRID_VERTS + PERIM;
const GRID_TRIS = 2 * CELLS * CELLS;
const SKIRT_TRIS = 2 * PERIM;
const SKIRT_BYTES =
  VERTS * 3 * 4 + // position f32
  VERTS * 3 * 4 + // normal f32
  VERTS * 3 * 4 + // color f32
  (GRID_TRIS + SKIRT_TRIS) * 3 * 4; // uint32 index

interface QNode {
  face: number;
  depth: number;
  u0: number;
  v0: number;
  size: number;
  /** unit-sphere direction of the patch center */
  cd: Vector3;
  /** world position of the patch center (band-limited surface) */
  cw: Vector3;
  /** bounding-sphere radius (m) */
  radius: number;
  /** height of the patch center above the sphere (m, cached) */
  centerH: number;
  children: QNode[] | null;
  isBranch: boolean;
  geom: BufferGeometry | null;
  mesh: Mesh | null;
  lastFrame: number;
}

export interface QuadtreeStats {
  leavesVisible: number;
  splits: number;
  merges: number;
  lodCpuMs: number;
  builtThisFrame: number;
  buildMsTotal: number;
  geometriesAllocated: number;
  vramBytes: number;
}

/**
 * Per-patch geometry bytes (exact: one position + one normal + one color f32
 * attribute over GRID_VERTS + PERIM verts, plus a uint32 index buffer).
 */
export const QT_PATCH_BYTES = SKIRT_BYTES;

export class QuadtreePlanet {
  readonly group = new Group();
  readonly material: MeshLambertMaterial;
  readonly stats: QuadtreeStats = {
    leavesVisible: 0,
    splits: 0,
    merges: 0,
    lodCpuMs: 0,
    builtThisFrame: 0,
    buildMsTotal: 0,
    geometriesAllocated: 0,
    vramBytes: 0,
  };
  /** split+merge transitions per update (rolling, for thrash measurement) */
  transitionsLast = 0;

  private roots: QNode[] = [];
  private geomPool: BufferGeometry[] = [];
  private released: BufferGeometry[] = [];
  private meshPool: Mesh[] = [];
  private frame = 0;
  private camPos = new Vector3();
  private viewportH = 720;
  private fovRad = 1.0;
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  private tmpRel = new Vector3();
  private frustumSphere = new Sphere();
  /** f64 world positions of one patch grid (transient, per writePatch call). */
  private tmpWorld = new Float64Array(GRID_VERTS * 3);

  constructor() {
    this.material = new MeshLambertMaterial({ vertexColors: true });
    for (let f = 0; f < FACE_COUNT; f++) {
      this.roots.push(this.makeNode(f, 0, -1, -1, 2, null));
    }
  }

  private makeNode(face: number, depth: number, u0: number, v0: number, size: number, cdSeed: Vector3 | null): QNode {
    const cd = new Vector3();
    if (cdSeed !== null) {
      cd.copy(cdSeed);
    } else {
      cubeToDir(face, u0 + size / 2, v0 + size / 2, cd);
    }
    const cw = cd.clone().multiplyScalar(PLANET_RADIUS + heightAtBanded(cd, octaveCountForDepth(depth)));
    return {
      face,
      depth,
      u0,
      v0,
      size,
      cd,
      cw,
      radius: patchBoundRadiusM(size, depth),
      centerH: cw.length() - PLANET_RADIUS,
      children: null,
      isBranch: false,
      geom: null,
      mesh: null,
      lastFrame: -1,
    };
  }

  /**
   * Per-frame LOD update: traversal with split/merge by screen-space error
   * (shared per-level error metric, planetCommon.levelErrorM), horizon
   * culling, geometry builds from the pool, mesh visibility. An optional
   * `frustum` culls patches CPU-side so geometry is only built for patches
   * the camera can actually see; it must be built for a camera AT THE ORIGIN
   * (camera-relative space — the page renders the planet group at -camPos),
   * and patch centers are tested camera-relative here. Without it the whole
   * over-horizon disc is built.
   */
  update(camPos: Vector3, viewportH: number, fovRad: number, frustum?: Frustum | null): void {
    const t0 = performance.now();
    this.frame++;
    this.camPos.copy(camPos);
    // Law P-2 / ADR-002 render arrangement, probe form: the whole planet group
    // is drawn CAMERA-RELATIVE (group at -camPos, camera at the origin) so the
    // single f32 downcast happens on patch-local coordinates, never on
    // planetary-magnitude positions. Patch geometry is stored relative to its
    // own patch center (see writePatch); mesh.position holds the absolute f64
    // patch center, so modelView = (patchCenter - camPos) is composed in f64
    // matrix math before the f32 uniform upload.
    this.group.position.copy(camPos).negate();
    this.viewportH = viewportH;
    this.fovRad = fovRad;
    this.stats.splits = 0;
    this.stats.merges = 0;
    this.stats.builtThisFrame = 0;
    let leaves = 0;

    const camLen = camPos.length();
    const camDir = this.tmpA.copy(camPos).normalize();
    // cos of the horizon angle for the camera altitude (0 if inside radius).
    const cosHorizon = camLen > PLANET_RADIUS ? PLANET_RADIUS / camLen : -1;

    for (const root of this.roots) {
      this.decide(root);
      leaves += this.emit(root, cosHorizon, camDir, frustum ?? null);
    }

    this.stats.leavesVisible = leaves;
    this.transitionsLast = this.stats.splits + this.stats.merges;
    this.stats.lodCpuMs = performance.now() - t0;
  }

  /**
   * Split/merge decision for one node (recursive).
   *
   * Horizon discipline is deliberately left to the EMIT pass: decide() splits
   * and merges purely on screen-space error (with the split/merge hysteresis
   * gap), and emit() culls whatever ends up beyond the limb. A node whose
   * bounding-sphere radius is the SHARED tight bound (patchBoundRadiusM, not the
   * old faceSize*0.78 + HEIGHT_MAX + 100) has an honest `dist`: far over-limb
   * patches get large distances and therefore small SSE, so SSE never drives an
   * invisible over-limb subtree to deep LOD, and the LOD boundary naturally
   * hugs the visible limb instead of toggling there under sub-metre camera
   * moves. A coarse patch that STRADDLES the limb (center just past the horizon,
   * near edge on screen) still refines by SSE — no coarse-LOD holes at the
   * limb. A branch whose SSE drops under the merge threshold collapses and
   * releases its pooled geometry as the camera retreats.
   */
  private decide(node: QNode): void {
    const dist = Math.max(this.camPos.distanceTo(node.cw) - node.radius, 1);
    const err = levelErrorM(node.depth, QT_GRID_N);
    const sse = screenSpaceError(err, dist, this.viewportH, this.fovRad);
    node.lastFrame = this.frame;

    if (node.isBranch) {
      const mustMerge = sse < QT_SSE_PX / QT_HYSTERESIS || node.depth >= QT_MAX_DEPTH;
      if (mustMerge) {
        this.collapse(node);
      } else {
        for (const c of node.children ?? []) this.decide(c);
      }
      return;
    }
    if (sse > QT_SSE_PX && node.depth < QT_MAX_DEPTH) {
      this.split(node);
      for (const c of node.children ?? []) this.decide(c);
    }
  }

  private split(node: QNode): void {
    if (node.isBranch) return;
    const half = node.size / 2;
    const kids: QNode[] = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const child = this.makeNode(node.face, node.depth + 1, node.u0 + i * half, node.v0 + j * half, half, null);
        kids.push(child);
      }
    }
    node.children = kids;
    node.isBranch = true;
    this.releaseGeom(node);
    this.stats.splits++;
  }

  private collapse(node: QNode): void {
    if (!node.isBranch) return;
    for (const c of node.children ?? []) {
      this.collapse(c);
      this.releaseGeom(c);
    }
    node.children = null;
    node.isBranch = false;
    this.stats.merges++;
  }

  /** Horizon-cull + frustum-cull + visibility pass; returns visible leaf count. */
  private emit(node: QNode, cosHorizon: number, camDir: Vector3, frustum: Frustum | null): number {
    if (node.isBranch) {
      let n = 0;
      for (const c of node.children ?? []) n += this.emit(c, cosHorizon, camDir, frustum);
      return n;
    }
    // Horizon cull: EXACT form — the patch is over the horizon when its center
    // direction is further from the sub-camera direction than the horizon
    // angle PLUS the patch's true angular radius (acos(1/sqrt(1+size^2/2)) *
    // margin, in radians), composed in angle space, not cosine space.
    if (cosHorizon > -1 && node.cd.dot(camDir) < horizonCullCos(cosHorizon, quadAngularRadius(node.size))) {
      if (node.mesh !== null) node.mesh.visible = false;
      return 0;
    }
    // Frustum cull (camera-relative bounding sphere; the frustum must be built
    // for a camera AT THE ORIGIN, so patch centers are tested as cw - camPos).
    if (
      frustum !== null &&
      !frustum.intersectsSphere(this.frustumSphere.set(this.tmpRel.copy(node.cw).sub(this.camPos), node.radius))
    ) {
      if (node.mesh !== null) node.mesh.visible = false;
      return 0;
    }
    this.ensureGeometry(node);
    if (node.mesh !== null) node.mesh.visible = true;
    return 1;
  }

  private ensureGeometry(node: QNode): void {
    if (node.geom !== null) {
      if (node.mesh === null) this.attachMesh(node);
      return;
    }
    const t0 = performance.now();
    const geom = this.acquireGeom();
    this.writePatch(node, geom);
    node.geom = geom;
    this.attachMesh(node);
    this.stats.builtThisFrame++;
    this.stats.buildMsTotal += performance.now() - t0;
  }

  private attachMesh(node: QNode): void {
    let mesh = this.meshPool.pop() ?? null;
    if (mesh === null) {
      mesh = new Mesh(node.geom as BufferGeometry, this.material);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    } else {
      mesh.geometry = node.geom as BufferGeometry;
    }
    // Absolute f64 patch center as the mesh translation (geometry is stored
    // patch-local); matrixWorld = (-camPos) * patchCenter is composed in f64.
    mesh.position.copy(node.cw);
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    mesh.visible = true;
    node.mesh = mesh;
  }

  private releaseGeom(node: QNode): void {
    if (node.mesh !== null) {
      node.mesh.visible = false;
      this.meshPool.push(node.mesh);
      node.mesh = null;
    }
    if (node.geom !== null) {
      this.released.push(node.geom);
      node.geom = null;
    }
  }

  private acquireGeom(): BufferGeometry {
    const free = this.released.pop();
    if (free !== undefined) return free;
    if (this.geomPool.length < QT_POOL_CAP) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
      g.setAttribute('normal', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
      g.setAttribute('color', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
      g.setIndex(new Uint32BufferAttribute(new Uint32Array((GRID_TRIS + SKIRT_TRIS) * 3), 1));
      this.geomPool.push(g);
      this.stats.geometriesAllocated = this.geomPool.length;
      this.stats.vramBytes = this.geomPool.length * QT_PATCH_BYTES;
      return g;
    }
    // Pool exhausted with nothing released: grow beyond cap (counted).
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
    g.setAttribute('normal', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(VERTS * 3), 3));
    g.setIndex(new Uint32BufferAttribute(new Uint32Array((GRID_TRIS + SKIRT_TRIS) * 3), 1));
    this.geomPool.push(g);
    this.stats.geometriesAllocated = this.geomPool.length;
    this.stats.vramBytes = this.geomPool.length * QT_PATCH_BYTES;
    return g;
  }

  /**
   * Write one patch into a pooled geometry: GRID_VERTS band-limited displaced
   * grid vertices stored PATCH-LOCAL (relative to node.cw, composed in f64 and
   * downcast once to f32 — the Law P-2 render boundary), grid normals from
   * grid neighbors, elevation tint colors, and a radial skirt ring hanging
   * GRID_VERTS..VERTS-1, indexed to reuse the boundary grid vertices
   * (watertight by construction). Adjacent patches derive boundary vertices
   * from the same f64 grid coordinates, so their f32 copies agree to within
   * ULP(patch extent) — orders below a pixel, and covered by the skirts.
   */
  private writePatch(node: QNode, geom: BufferGeometry): void {
    const pos = geom.getAttribute('position') as BufferAttribute;
    const nor = geom.getAttribute('normal') as BufferAttribute;
    const col = geom.getAttribute('color') as BufferAttribute;
    const idx = geom.index as BufferAttribute;
    const posA = pos.array as Float32Array;
    const norA = nor.array as Float32Array;
    const colA = col.array as Float32Array;
    const idxA = idx.array as Uint32Array;

    const s = node.size / CELLS; // power of two (node.size = 2/2^depth)
    const oMax = octaveCountForDepth(node.depth);
    const d = this.tmpB;
    const p = this.tmpC;
    const tint = new Vector3();
    const cx = node.cw.x;
    const cy = node.cw.y;
    const cz = node.cw.z;

    // Global integer grid indices (face-local) -> exact shared coordinates.
    const gx0 = Math.round((node.u0 + 1) / s); // == cell column * CELLS
    const gy0 = Math.round((node.v0 + 1) / s);
    const heights = new Float64Array(GRID_VERTS);
    const world = this.tmpWorld;
    for (let j = 0; j < QT_GRID_N; j++) {
      for (let i = 0; i < QT_GRID_N; i++) {
        const u = -1 + (gx0 + i) * s;
        const v = -1 + (gy0 + j) * s;
        cubeToDir(node.face, u, v, d);
        const h = heightAtBanded(d, oMax);
        heights[j * QT_GRID_N + i] = h;
        const r = PLANET_RADIUS + h;
        // f64 world position first, then the single f32 downcast of the
        // PATCH-LOCAL offset (Law P-2: bounded magnitude at upload).
        const o = (j * QT_GRID_N + i) * 3;
        const wx = d.x * r;
        const wy = d.y * r;
        const wz = d.z * r;
        world[o] = wx;
        world[o + 1] = wy;
        world[o + 2] = wz;
        posA[o] = wx - cx;
        posA[o + 1] = wy - cy;
        posA[o + 2] = wz - cz;
      }
    }
    // Normals from grid neighbors (cross of secants of the displaced surface).
    for (let j = 0; j < QT_GRID_N; j++) {
      for (let i = 0; i < QT_GRID_N; i++) {
        const i0 = j * QT_GRID_N + i;
        const il = i > 0 ? i0 - 1 : i0;
        const ir = i < CELLS ? i0 + 1 : i0;
        const jd = j > 0 ? i0 - QT_GRID_N : i0;
        const ju = j < CELLS ? i0 + QT_GRID_N : i0;
        const ax = (posA[ir * 3] as number) - (posA[il * 3] as number);
        const ay = (posA[ir * 3 + 1] as number) - (posA[il * 3 + 1] as number);
        const az = (posA[ir * 3 + 2] as number) - (posA[il * 3 + 2] as number);
        const bx = (posA[ju * 3] as number) - (posA[jd * 3] as number);
        const by = (posA[ju * 3 + 1] as number) - (posA[jd * 3 + 1] as number);
        const bz = (posA[ju * 3 + 2] as number) - (posA[jd * 3 + 2] as number);
        // au x av = n => cross(du, dv) points outward.
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        norA[i0 * 3] = nx;
        norA[i0 * 3 + 1] = ny;
        norA[i0 * 3 + 2] = nz;
        elevationTint(heights[i0] as number, tint);
        colA[i0 * 3] = tint.x;
        colA[i0 * 3 + 1] = tint.y;
        colA[i0 * 3 + 2] = tint.z;
      }
    }
    // Grid indices (CCW from outside: u right, v up).
    let w = 0;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = j * QT_GRID_N + i;
        const b = a + 1;
        const c = a + QT_GRID_N;
        const e = c + 1;
        idxA[w++] = a;
        idxA[w++] = b;
        idxA[w++] = e;
        idxA[w++] = a;
        idxA[w++] = e;
        idxA[w++] = c;
      }
    }
    // Skirt ring: perimeter walked CCW (top L->R, right T->B, bottom R->L,
    // left B->T), verts dropped radially by the band-jump depth + margin.
    const skirtDepth = droppedAmpM(node.depth) * 1.5 + 0.03 * faceSizeToWorldM(node.size) + 1;
    const perim: number[] = new Array(PERIM);
    let k = 0;
    for (let i = 0; i < CELLS; i++) perim[k++] = i; // top edge (j=0)
    for (let j = 0; j < CELLS; j++) perim[k++] = j * QT_GRID_N + CELLS; // right edge
    for (let i = CELLS; i > 0; i--) perim[k++] = CELLS * QT_GRID_N + i; // bottom edge
    for (let j = CELLS; j > 0; j--) perim[k++] = j * QT_GRID_N; // left edge
    for (let m = 0; m < PERIM; m++) {
      const src = perim[m] as number;
      const so = src * 3;
      const dst = (GRID_VERTS + m) * 3;
      // Skirt verts hang radially INWARD from the f64 world position, then are
      // stored patch-local like every other vertex.
      const wx = world[so] as number;
      const wy = world[so + 1] as number;
      const wz = world[so + 2] as number;
      const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
      const scale = (len - skirtDepth) / len;
      posA[dst] = wx * scale - cx;
      posA[dst + 1] = wy * scale - cy;
      posA[dst + 2] = wz * scale - cz;
      norA[dst] = norA[so] as number;
      norA[dst + 1] = norA[so + 1] as number;
      norA[dst + 2] = norA[so + 2] as number;
      colA[dst] = (colA[so] as number) * 0.45;
      colA[dst + 1] = (colA[so + 1] as number) * 0.45;
      colA[dst + 2] = (colA[so + 2] as number) * 0.45;
    }
    for (let m = 0; m < PERIM; m++) {
      const m2 = (m + 1) % PERIM;
      const pk = perim[m] as number;
      const pk2 = perim[m2] as number;
      const sk = GRID_VERTS + m;
      const sk2 = GRID_VERTS + m2;
      // Wall outward = right of the CCW walk, facing away from patch interior.
      idxA[w++] = pk;
      idxA[w++] = sk2;
      idxA[w++] = pk2;
      idxA[w++] = pk;
      idxA[w++] = sk;
      idxA[w++] = sk2;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    col.needsUpdate = true;
    idx.needsUpdate = true;
    geom.computeBoundingSphere();
    if (node.mesh !== null) node.mesh.geometry = geom;
  }

  /** Leaf node descriptors for tests/probes; `visible` = passed horizon+frustum culls. */
  visibleLeaves(): { depth: number; face: number; u0: number; v0: number; size: number; visible: boolean }[] {
    const out: { depth: number; face: number; u0: number; v0: number; size: number; visible: boolean }[] = [];
    const walk = (n: QNode): void => {
      if (n.isBranch) {
        for (const c of n.children ?? []) walk(c);
        return;
      }
      out.push({ depth: n.depth, face: n.face, u0: n.u0, v0: n.v0, size: n.size, visible: n.mesh?.visible === true });
    };
    for (const r of this.roots) walk(r);
    return out;
  }

  /** Total live geometry bytes currently held (pool + in-use). */
  vramEstimateBytes(): number {
    return this.geomPool.length * QT_PATCH_BYTES;
  }
}
