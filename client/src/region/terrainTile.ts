/**
 * Kwetu region streaming — the L2 terrain tile (Phase 2; ROADMAP §3.2).
 *
 * Loads one pre-baked delatin terrain GLB (tools/bake/terrain.mjs →
 * .bake/meshes/<region>.terrain.glb + manifest) and mounts it in the shell's
 * floating-origin scene. The bake is the provenance boundary: vertex data,
 * georef, sea rule and validation evidence live in the manifest — this module
 * REVALIDATES the load against the manifest (counts, bbox) and refuses a
 * mismatched artifact rather than rendering it silently.
 *
 * Frames (COORDINATE_SYSTEM.md §1/§8 — the correctness law):
 *   - The GLB stores vertices in the TILE ANCHOR's ENU triad: +x east,
 *     +y north, +z up, metres, origin at the tile bbox SW ground corner.
 *     This is deliberately NOT the glTF +Y-up convention (manifest georef.axes)
 *     and GLTFLoader performs no axis conversion — the mapping into
 *     LocalScene is the IDENTITY, because LocalScene is also a Z-up ENU triad.
 *     That identity is still stated explicitly here (the §8 rule: three.js
 *     asset defaults must not silently redefine ENU) and guarded by the
 *     load-time bbox check, which would fail loudly if an axis convention
 *     ever changed on either side.
 *   - Placement re-derives EVERY frame from f64 ground truth (Law P-6):
 *     position = ecefToEnu(tileMountPf, anchorGeodetic), orientation = the
 *     rotation E_rig·E_tile^T (tile axes re-expressed in the rig anchor's
 *     ENU). Nothing is ever shifted in f32; the one downcast is at the
 *     render boundary (Law P-2).
 *
 * [PLACEHOLDER — ADR-003] the tile mounts on the placeholder mean-radius
 * SPHERE along the anchor's geodetic direction + a fixed offset — not on the
 * WGS84 ellipsoid (Laws G-1/G-2; the manifest's verticalDatum defers the
 * orthometric→ellipsoidal conversion to the geodesy bake). Both the mount and
 * CameraRig.setCameraSite use the same geodetic-direction convention, so the
 * camera sits exactly above the mount. Walk scale is unaffected: the
 * character works in the tile's own frame. The real planet renderer replaces
 * this mount wholesale.
 *
 * The offset ({@link TILE_MOUNT_OFFSET_METRES}) keeps the tile off the sphere:
 * at the anchor the tangent plane is tangent (0 gap — coincident geometry,
 * z-fighting); the sphere falls away quadratically (~13.8 m below the tile
 * plane at the tile's far corner [derived — d²/2R at 13.28 km, R = 6.371e6]).
 * A 50 m lift keeps the whole tile strictly above the placeholder surface.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ecefToEnu,
  enuBasis,
  type EnuBasis,
  type GeodeticCoord,
} from '../engine/geodesy';
import { f32Downcast } from '../engine/precision';
import { addV, dot3, scaleV, type Vec3 } from '../engine/vec3';

/** The one manifest schema this module accepts (tools/bake/terrain.mjs). */
const MANIFEST_SCHEMA = 'kwetu.bake.terrain-manifest/0.1' as const;

/** Tile lift above the placeholder sphere at the anchor, metres (header). */
export const TILE_MOUNT_OFFSET_METRES = 50;

/** Neutral terrain material colour (no texture in the L2 bake). */
const TERRAIN_COLOR = 0x8a7d6a;

/** geodetic lat/lon as the placeholder sphere's radial DIRECTION (header). */
export function radialFromGeodetic(latitudeDeg: number, longitudeDeg: number): Vec3 {
  const phi = (latitudeDeg * Math.PI) / 180;
  const lam = (longitudeDeg * Math.PI) / 180;
  return { x: Math.cos(phi) * Math.cos(lam), y: Math.cos(phi) * Math.sin(lam), z: Math.sin(phi) };
}

/**
 * The tile anchor's canonical PlanetFixed mount on the placeholder sphere,
 * f64 — computed once (it is ground truth; the per-frame re-derivation reads
 * it, Law P-6).
 */
export function tileMountPlanetFixed(
  tileAnchor: GeodeticCoord,
  sphereRadiusMetres: number,
  mountOffsetMetres: number,
): Vec3 {
  const surface = scaleV(radialFromGeodetic(tileAnchor.latitudeDeg, tileAnchor.longitudeDeg), sphereRadiusMetres);
  const basis = enuBasis(tileAnchor.latitudeDeg, tileAnchor.longitudeDeg);
  return addV(surface, scaleV(basis.up, mountOffsetMetres));
}

/** A PlanetFixed direction re-expressed in an ENU triad (pure rotation). */
export function rotateIntoEnu(basis: EnuBasis, v: Vec3): Vec3 {
  return { x: dot3(basis.east, v), y: dot3(basis.north, v), z: dot3(basis.up, v) };
}

/** One frame's placement, all f64 — downcast happens at the caller (Law P-2). */
export interface TilePlacement {
  /** Tile-origin position in the rig anchor's ENU, metres. */
  readonly positionMetres: Vec3;
  /** Tile east/north/up axes expressed in the rig anchor's ENU (columns). */
  readonly axisColumns: readonly [Vec3, Vec3, Vec3];
}

export function tilePlacement(
  mountPf: Vec3,
  tileBasis: EnuBasis,
  rigAnchor: GeodeticCoord,
): TilePlacement {
  const rigBasis = enuBasis(rigAnchor.latitudeDeg, rigAnchor.longitudeDeg);
  return {
    positionMetres: ecefToEnu(mountPf, rigAnchor),
    axisColumns: [
      rotateIntoEnu(rigBasis, tileBasis.east),
      rotateIntoEnu(rigBasis, tileBasis.north),
      rotateIntoEnu(rigBasis, tileBasis.up),
    ],
  };
}

/** The manifest fields this module consumes (subset; full file is the bake's). */
export interface TerrainManifest {
  readonly schema: string;
  readonly georef: {
    readonly anchor: { readonly latitudeDeg: number; readonly longitudeDeg: number };
  };
  readonly mesh: {
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly bboxLocalEnuMetres: { readonly min: readonly number[]; readonly max: readonly number[] };
  };
}

export type RegionTerrainState = 'idle' | 'loading' | 'ready' | 'error';

export interface RegionTerrainOptions {
  readonly manifestUrl: string;
  readonly sphereRadiusMetres: number;
}

/**
 * One terrain tile in the shell scene. Load is async and self-reporting
 * (`state`/`error`); `update()` is a per-frame no-op until `ready`.
 */
export class RegionTerrain {
  readonly group = new THREE.Group();
  private readonly manifestUrl: string;
  private readonly sphereRadiusMetres: number;
  private readonly scratchMatrix = new THREE.Matrix4();
  private mesh: THREE.Mesh | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  private stateValue: RegionTerrainState = 'idle';
  private errorValue: string | null = null;
  private bytesReceivedValue = 0;
  private tileAnchor: GeodeticCoord | null = null;
  private mountPf: Vec3 | null = null;
  private tileBasis: EnuBasis | null = null;
  private vertexCountValue = 0;
  private triangleCountValue = 0;
  private loadStarted = false;

  constructor(options: RegionTerrainOptions) {
    this.manifestUrl = options.manifestUrl;
    this.sphereRadiusMetres = options.sphereRadiusMetres;
    this.group.name = 'kwetu-region-terrain';
  }

  get state(): RegionTerrainState {
    return this.stateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get bytesReceived(): number {
    return this.bytesReceivedValue;
  }

  get tileAnchorGeodetic(): GeodeticCoord {
    if (this.tileAnchor === null) throw new Error('region: tile anchor read before ready');
    return this.tileAnchor;
  }

  /** The tile anchor once the manifest has been parsed, else null. */
  tileAnchorOrNull(): GeodeticCoord | null {
    return this.tileAnchor;
  }

  get vertexCount(): number {
    return this.vertexCountValue;
  }

  get triangleCount(): number {
    return this.triangleCountValue;
  }

  /** Kicks the async load once. Errors land in `state`/`error`, never thrown. */
  load(): Promise<void> {
    if (this.loadStarted) return Promise.resolve();
    this.loadStarted = true;
    this.stateValue = 'loading';
    return this.loadInner().catch((error: unknown) => {
      this.stateValue = 'error';
      this.errorValue = error instanceof Error ? error.message : String(error);
    });
  }

  private async loadInner(): Promise<void> {
    const manifestResponse = await fetch(this.manifestUrl);
    if (!manifestResponse.ok) throw new Error(`region: manifest HTTP ${manifestResponse.status} (${this.manifestUrl})`);
    const manifestBytes = await manifestResponse.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as TerrainManifest;
    this.bytesReceivedValue += manifestBytes.byteLength;
    if (manifest.schema !== MANIFEST_SCHEMA) {
      throw new Error(`region: manifest schema "${manifest.schema}" is not ${MANIFEST_SCHEMA}`);
    }
    this.tileAnchor = {
      latitudeDeg: manifest.georef.anchor.latitudeDeg,
      longitudeDeg: manifest.georef.anchor.longitudeDeg,
      heightMetres: 0,
    };
    this.mountPf = tileMountPlanetFixed(this.tileAnchor, this.sphereRadiusMetres, TILE_MOUNT_OFFSET_METRES);
    this.tileBasis = enuBasis(this.tileAnchor.latitudeDeg, this.tileAnchor.longitudeDeg);

    // The GLB URL derives from the manifest's own artifact record — one
    // provenance chain, no parallel naming convention to drift.
    const glbUrl = new URL(manifestArtifactFile(manifest), new URL(this.manifestUrl, window.location.href)).toString();
    const glbResponse = await fetch(glbUrl);
    if (!glbResponse.ok) throw new Error(`region: GLB HTTP ${glbResponse.status} (${glbUrl})`);
    const glbBuffer = await glbResponse.arrayBuffer();
    this.bytesReceivedValue += glbBuffer.byteLength;

    const mesh = await parseGlbMesh(glbBuffer);
    validateMeshAgainstManifest(mesh.geometry, manifest);
    mesh.material = new THREE.MeshLambertMaterial({ color: TERRAIN_COLOR });
    this.disposables.push(mesh.geometry, mesh.material);
    mesh.matrixAutoUpdate = false; // the GROUP carries the per-frame transform
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    this.mesh = mesh;
    this.group.add(mesh);
    this.vertexCountValue = manifest.mesh.vertexCount;
    this.triangleCountValue = manifest.mesh.triangleCount;
    this.stateValue = 'ready';
    this.group.visible = true;
  }

  /**
   * Per-frame Law P-6 re-derivation under the rig's CURRENT anchor. No-op
   * until `ready` (the group stays invisible, so a mid-load frame renders
   * nothing of the tile).
   */
  update(rigAnchor: GeodeticCoord): void {
    if (this.stateValue !== 'ready' || this.mountPf === null || this.tileBasis === null) return;
    const placement = tilePlacement(this.mountPf, this.tileBasis, rigAnchor);
    this.group.position.set(
      f32Downcast(placement.positionMetres.x),
      f32Downcast(placement.positionMetres.y),
      f32Downcast(placement.positionMetres.z),
    );
    const [c0, c1, c2] = placement.axisColumns;
    this.scratchMatrix.set(
      c0.x, c1.x, c2.x, 0,
      c0.y, c1.y, c2.y, 0,
      c0.z, c1.z, c2.z, 0,
      0, 0, 0, 1,
    );
    this.group.quaternion.setFromRotationMatrix(this.scratchMatrix);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
    this.mesh = null;
    this.stateValue = 'idle';
  }
}

/** Reads the GLB artifact filename from the manifest (dotted onto the URL). */
function manifestArtifactFile(manifest: TerrainManifest): string {
  const file = (manifest as { readonly artifact?: { readonly file?: string } }).artifact?.file;
  if (file === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
    throw new Error(`region: manifest artifact.file missing or unsafe ("${String(file)}")`);
  }
  return file;
}

async function parseGlbMesh(buffer: ArrayBuffer): Promise<THREE.Mesh> {
  const loader = new GLTFLoader();
  return new Promise<THREE.Mesh>((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (gltf) => {
        const meshes: THREE.Mesh[] = [];
        gltf.scene.traverse((object) => {
          if ((object as THREE.Mesh).isMesh === true) meshes.push(object as THREE.Mesh);
        });
        if (meshes.length !== 1) {
          reject(new Error(`region: expected exactly 1 mesh in the terrain GLB, found ${meshes.length}`));
          return;
        }
        resolve(meshes[0]!);
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** Load-time revalidation: the decoded mesh must BE the manifest's mesh. */
function validateMeshAgainstManifest(geometry: THREE.BufferGeometry, manifest: TerrainManifest): void {
  const position = geometry.getAttribute('position');
  if (position === undefined || position.itemSize !== 3) {
    throw new Error('region: terrain GLB has no VEC3 position attribute');
  }
  if (position.count !== manifest.mesh.vertexCount) {
    throw new Error(`region: decoded vertex count ${position.count} != manifest ${manifest.mesh.vertexCount}`);
  }
  const index = geometry.getIndex();
  if (index === null || index.count !== manifest.mesh.triangleCount * 3) {
    throw new Error(
      `region: decoded index count ${index === null ? 'none' : index.count} != manifest triangles×3 = ${manifest.mesh.triangleCount * 3}`,
    );
  }
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (bbox === null) throw new Error('region: decoded geometry produced no bounding box');
  const mins = [bbox.min.x, bbox.min.y, bbox.min.z];
  const maxs = [bbox.max.x, bbox.max.y, bbox.max.z];
  for (let axis = 0; axis < 3; axis++) {
    // f32-quantized positions against the manifest's f64 record: 1e-3 m is
    // far above f32 spacing at these magnitudes and far below any real
    // axis-convention break (which would move a coordinate by kilometres).
    const min = manifest.mesh.bboxLocalEnuMetres.min[axis];
    const max = manifest.mesh.bboxLocalEnuMetres.max[axis];
    if (min === undefined || max === undefined) throw new Error(`region: manifest bbox axis ${axis} missing`);
    if (Math.abs(mins[axis]! - min) > 1e-3 || Math.abs(maxs[axis]! - max) > 1e-3) {
      throw new Error(
        `region: decoded bbox axis ${axis} [${mins[axis]}, ${maxs[axis]}] != manifest [${min}, ${max}] — axis convention or artifact mismatch`,
      );
    }
  }
  // The bake carries no normals (position+index only); Lambert needs them.
  geometry.computeVertexNormals();
}
