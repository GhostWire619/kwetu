/**
 * Kwetu early-playable LOCAL surface slice — the third-person walk/drive app
 * (Phase-3 Part B bounding; MASTER_PROMPT "Stone Town slice" + docs/
 * VEHICLES_AND_FLIGHT.md + COORDINATE_SYSTEM.md §8).
 *
 * What this is: a bounded single-player slice that boots straight onto the
 * baked Stone Town terrain at a measured flat bench and gives the player a
 * grounded third-person walk (WASD relative to the camera, Space jump, mouse/
 * arrows look), a simple procedural car (E to enter/exit near it, W/S
 * throttle/brake, A/D steering), R safe reset, and a local save/resume. It is
 * deliberately NOT the ClientApp space shell — it owns its own Z-up Rapier
 * world, three.js scene, input and HUD, and it must not disturb the existing
 * ClientApp region/space code paths (the shell boots this app only for
 * `?mode=surface`).
 *
 * Coordinates (COORDINATE_SYSTEM.md §8): everything here lives in ONE bounded
 * bubble-local Z-up ENU triad — the bake's own tile-local axes (+x east, +y
 * north, +z up, origin at the tile bbox SW ground corner). The GLB vertices
 * are therefore placed with the IDENTITY mapping (same axis convention as
 * LocalScene), world gravity is (0, 0, −g), and the character/vehicle
 * controllers (client/src/player/character.ts, vehicle/vehicle.ts) run in
 * this same triad with canonical f64 state (Laws P-1/P-6). No planet
 * rendering happens in this slice.
 *
 * Physics cadence (ADR-002 Decision 5 + the controller contracts): ONE shared
 * Rapier world, stepped at a fixed 1/60 s exactly once per tick. Each tick
 * pairs CharacterController.update(dt) (walk) and/or VehicleController.preStep(dt)
 * with a single world.step(). The real-time loop runs an accumulator with a
 * finite per-frame dt clamp; the debug seam's advance(seconds) runs whole
 * fixed ticks synchronously through the same path.
 *
 * Spawn site: [MEASURED 2026-09-06, node + Rapier raycast over the bake] a
 * flat bench around tile-local (6690, 5320): centre terrain z ≈ 9.99, slope
 * 0.001, and a full 260 m disc around it stays on dry land (z 5.8–14.6, no
 * ocean/creek cells) — so the 200 m boundary reset can never strand the
 * player in water. A thin original "test pad" (30 × 24 m, top flush +0.12 m
 * with the terrain) guarantees a level floor under the car and avatar; four
 * small original test crates sit ~25 m out on the diagonals as the only props
 * (no real city buildings).
 *
 * Save/resume: best-effort localStorage (version-gated). The slice labels
 * itself a LOCAL prototype in the HUD; nothing leaves the browser.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { CharacterController } from '../player/character';
import { makeDefaultVehicleParams, VehicleController } from '../vehicle/vehicle';
import { TANGENT_G_METRES_PER_S2 } from '../engine/geodesy';
import { f32Downcast } from '../engine/precision';
import { quatRotate, type Quat, type Vec3 } from '../engine/vec3';
import { createPlayHud, type PlayHud, type PlayHudState } from './playHud';

// --- resolved constants --------------------------------------------------------

const MANIFEST_SCHEMA = 'kwetu.bake.terrain-manifest/0.1' as const;
const REGION_NAME = 'stone-town';
const MANIFEST_URL = `/data/region/${REGION_NAME}.terrain.manifest.json`;
const TERRAIN_COLOR = 0x8a7d6a;
const MAX_PIXEL_RATIO = 1.5;
const CAMERA_FOV_DEG = 60;
const CAMERA_NEAR_METRES = 0.1;
const CAMERA_FAR_METRES = 20000;

const FIXED_DT_SECONDS = 1 / 60;
const MAX_FRAME_DT_SECONDS = 0.25;
const MAX_TICKS_PER_FRAME = 6;
const SETTLE_TICKS = 90; // 1.5 s of world settle at boot so the car rests on its wheels
const GROUND_RAY_ORIGIN_Z = 2000;
const GROUND_RAY_MAX_TOI = 4000;
const FALL_GUARD_Z_METRES = -10;

/** The bounded play disc (metres, tile-local): pad centre + radius. */
const PLAY_CENTRE_X = 6690;
const PLAY_CENTRE_Y = 5320;
const PLAY_RADIUS_METRES = 200;
/** Level "test pad" half extents; top sits +0.12 m above the terrain at the centre. */
const PAD_HALF_METRES = { x: 15, y: 12, z: 0.3 };
const PAD_TOP_LIFT_METRES = 0.12;
/** Test crates (original props) on the pad diagonals, ~25 m out. */
const CRATES = [
  { dx: 20, dy: 16, colour: 0xc0392b },
  { dx: 20, dy: -16, colour: 0xe67e22 },
  { dx: -20, dy: 16, colour: 0x2980b9 },
  { dx: -20, dy: -16, colour: 0x27ae60 },
] as const;
const CRATE_HALF_METRES = 0.8;

/** Avatar (walk) tuning — capsule 0.4 r × 1.0 cylinder, 2.5 m/s walk. */
const CHAR_RADIUS_METRES = 0.4;
const CHAR_HALF_HEIGHT_METRES = 0.5;
const CHAR_STANDING_HEIGHT_METRES = CHAR_RADIUS_METRES + CHAR_HALF_HEIGHT_METRES + 0.02;
const WALK_SPEED_METRES_PER_SECOND = 2.5;
const RUN_SPEED_METRES_PER_SECOND = 5.0;
const JUMP_SPEED_METRES_PER_SECOND = 3.2;
/** Spawn heights: capsule centre just above rest; chassis wheels touch at +1.05. */
const CHAR_SPAWN_LIFT_METRES = 0.05;
const VEHICLE_SPAWN_Z_METRES = 1.02;
const DEFAULT_CHAR_X = PLAY_CENTRE_X - 4;
const DEFAULT_CHAR_Y = PLAY_CENTRE_Y;
const DEFAULT_VEHICLE_X = PLAY_CENTRE_X + 5;
const DEFAULT_VEHICLE_Y = PLAY_CENTRE_Y;
const DEFAULT_YAW_RAD = 0;

const ENTER_RADIUS_METRES = 4.5;
const EXIT_LATERAL_METRES = 2.6;

/** Third-person orbit camera: subject distance by mode, default pitch ~24°. */
const CAMERA_DISTANCE_WALK_METRES = 6.5;
const CAMERA_DISTANCE_DRIVE_METRES = 10;
const CAMERA_PITCH_DEFAULT_RAD = 0.42;
const CAMERA_PITCH_MIN_RAD = 0.08;
const CAMERA_PITCH_MAX_RAD = 1.2;
const MOUSE_SENSITIVITY_RAD_PER_PX = 0.0026;
const ARROW_LOOK_RATE_RAD_PER_SECOND = 2.2;
/** How fast the drive camera re-centres behind the car after the player looks away. */
const DRIVE_LOOK_RECENTRE_PER_SECOND = 4;

const SAVE_KEY = 'kwetu.surface.save.v1';
const SAVE_VERSION = 1;
const AUTOSAVE_INTERVAL_SECONDS = 3;
const HUD_PUSH_INTERVAL_SECONDS = 0.25;

/** Control codes after the physical → intent mapping (layout-independent). */
type ControlName =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'run'
  | 'lookUp'
  | 'lookDown'
  | 'lookLeft'
  | 'lookRight';

/** The versioned local-save payload. z is stored but recomputed at resume. */
interface SurfaceSaveV1 {
  readonly version: number;
  readonly savedAt: number;
  readonly mode: 'walk' | 'drive';
  readonly player: { readonly x: number; readonly y: number; readonly yawRad: number };
  readonly vehicle: { readonly x: number; readonly y: number; readonly yawRad: number };
}

/** Render-info snapshot after one render (the debug seam's renderFrame). */
export interface KwetuSurfaceRenderInfo {
  readonly calls: number;
  readonly triangles: number;
}

/** The `window.__kwetuSurface` e2e seam (mirrors __kwetuDebug's discipline). */
export interface KwetuSurfaceDebug {
  readonly state: 'booting' | 'ready' | 'error';
  readonly mode: 'loading' | 'walk' | 'drive' | 'error';
  readonly error: string | null;
  readonly frameCount: number;
  readonly simElapsedSeconds: number;
  readonly character: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly grounded: boolean;
    readonly speed: number;
  } | null;
  readonly vehicle: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly headingRad: number;
    readonly speed: number;
    readonly wheelsInContact: readonly boolean[];
  } | null;
  readonly camera: { readonly yawRad: number; readonly pitchRad: number };
  readonly terrain: {
    readonly state: 'loading' | 'ready' | 'error';
    readonly vertexCount: number;
    readonly triangleCount: number;
  };
  readonly savePresent: boolean;
  reset(): void;
  teleportNearCar(): void;
  advance(seconds: number): void;
  renderFrame(): KwetuSurfaceRenderInfo;
  readCanvasRgba(): { width: number; height: number; rgba: Uint8Array } | null;
  dispose(): void;
}

declare global {
  interface Window {
    __kwetuSurface?: KwetuSurfaceDebug;
  }
}

// --- tiny pure helpers ---------------------------------------------------------

function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteVec(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/** Physical code/key → control intent. e.code is layout-independent. */
function codeToControl(code: string, key: string): ControlName | null {
  switch (code) {
    case 'KeyW':
      return 'forward';
    case 'KeyS':
      return 'back';
    case 'KeyA':
      return 'left';
    case 'KeyD':
      return 'right';
    case 'Space':
      return 'jump';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'run';
    case 'ArrowUp':
      return 'lookUp';
    case 'ArrowDown':
      return 'lookDown';
    case 'ArrowLeft':
      return 'lookLeft';
    case 'ArrowRight':
      return 'lookRight';
  }
  // Non-QWERTY fallback for the movement letters only (e.key case-insensitive).
  if (key.length === 1) {
    const k = key.toLowerCase();
    if (k === 'w') return 'forward';
    if (k === 's') return 'back';
    if (k === 'a') return 'left';
    if (k === 'd') return 'right';
  }
  return null;
}

interface LoadedTerrain {
  mesh: THREE.Mesh;
  vertices: Float32Array;
  indices: Uint32Array;
  groundZ: number;
  vertexCount: number;
  triangleCount: number;
}

async function loadTerrain(): Promise<LoadedTerrain> {
  const manifestResponse = await fetch(MANIFEST_URL);
  if (!manifestResponse.ok) throw new Error(`Imeshindikana kusoma ramani (${manifestResponse.status}).`);
  const manifest = (await manifestResponse.json()) as {
    schema?: string;
    artifact?: { file?: string };
    mesh?: { vertexCount?: number; triangleCount?: number };
  };
  if (manifest.schema !== MANIFEST_SCHEMA || typeof manifest.artifact?.file !== 'string') {
    throw new Error('Ramani ya eneo haijatambulika.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.artifact.file)) throw new Error('Jina la ramani si salama.');
  const url = new URL(manifest.artifact.file, new URL(MANIFEST_URL, window.location.href)).toString();
  const buffer = await (await fetch(url)).arrayBuffer();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
  let source: THREE.Mesh | null = null;
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Mesh && source === null) source = object;
  });
  if (source === null) throw new Error('Ramani haina uso wa ardhi.');
  const sourceMesh = source as THREE.Mesh;
  const geometry = sourceMesh.geometry.clone();
  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) throw new Error('Ramani haina nafasi za ardhi.');
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    vertices[i * 3] = position.getX(i);
    vertices[i * 3 + 1] = position.getY(i);
    vertices[i * 3 + 2] = position.getZ(i);
  }
  let indices: Uint32Array;
  if (geometry.index !== null) indices = Uint32Array.from(geometry.index.array);
  else {
    indices = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i++) indices[i] = i;
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: TERRAIN_COLOR }));
  mesh.receiveShadow = true;
  const groundZ = 9.99;
  return {
    mesh,
    vertices,
    indices,
    groundZ,
    vertexCount: manifest.mesh?.vertexCount ?? position.count,
    triangleCount: manifest.mesh?.triangleCount ?? indices.length / 3,
  };
}

export class SurfaceApp {
  static async create(canvas: HTMLCanvasElement): Promise<SurfaceApp> {
    await RAPIER.init();
    const terrain = await loadTerrain();
    return new SurfaceApp(canvas, terrain);
  }

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world = new RAPIER.World({ x: 0, y: 0, z: -TANGENT_G_METRES_PER_S2 });
  private readonly terrain: LoadedTerrain;
  private characterCtl: CharacterController;
  private readonly vehicleCtl: VehicleController;
  private readonly avatarMesh: THREE.Mesh;
  private readonly carGroup = new THREE.Group();
  private readonly hud: PlayHud;
  private readonly controls = new Set<ControlName>();
  private mode: 'walk' | 'drive' = 'walk';
  private state: 'booting' | 'ready' | 'error' = 'booting';
  private error: string | null = null;
  private frameCount = 0;
  private simElapsed = 0;
  private accumulator = 0;
  private lastTime = 0;
  private cameraYaw = 0.8;
  private cameraPitch = CAMERA_PITCH_DEFAULT_RAD;
  private disposed = false;
  private raf = 0;
  private lastSave = 0;
  private lastHud = 0;

  private constructor(private readonly canvas: HTMLCanvasElement, terrain: LoadedTerrain) {
    this.terrain = terrain;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0x86b5d8);
    this.scene.fog = new THREE.Fog(0x86b5d8, 500, 5000);
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, innerWidth / innerHeight, CAMERA_NEAR_METRES, CAMERA_FAR_METRES);
    this.scene.add(new THREE.HemisphereLight(0xbde1ff, 0x594735, 2.1));
    const sun = new THREE.DirectionalLight(0xfff2d0, 2.4);
    sun.position.set(300, -200, 500);
    sun.castShadow = true;
    this.scene.add(sun);
    this.scene.add(terrain.mesh);

    const terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(terrain.vertices, terrain.indices), terrainBody);
    const padTop = terrain.groundZ + PAD_TOP_LIFT_METRES;
    const padCenterZ = padTop - PAD_HALF_METRES.z;
    const padBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(PLAY_CENTRE_X, PLAY_CENTRE_Y, padCenterZ));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(PAD_HALF_METRES.x, PAD_HALF_METRES.y, PAD_HALF_METRES.z).setFriction(0.9), padBody);
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(PAD_HALF_METRES.x * 2, PAD_HALF_METRES.y * 2, PAD_HALF_METRES.z * 2),
      new THREE.MeshStandardMaterial({ color: 0xb9b09c, roughness: 0.9 }),
    );
    pad.position.set(PLAY_CENTRE_X, PLAY_CENTRE_Y, padCenterZ);
    pad.receiveShadow = true;
    this.scene.add(pad);

    for (const crate of CRATES) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(PLAY_CENTRE_X + crate.dx, PLAY_CENTRE_Y + crate.dy, padTop + CRATE_HALF_METRES),
      );
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(CRATE_HALF_METRES, CRATE_HALF_METRES, CRATE_HALF_METRES), body);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(CRATE_HALF_METRES * 2, CRATE_HALF_METRES * 2, CRATE_HALF_METRES * 2),
        new THREE.MeshStandardMaterial({ color: crate.colour }),
      );
      mesh.position.set(PLAY_CENTRE_X + crate.dx, PLAY_CENTRE_Y + crate.dy, padTop + CRATE_HALF_METRES);
      mesh.castShadow = true;
      this.scene.add(mesh);
    }

    this.characterCtl = this.makeCharacter(DEFAULT_CHAR_X, DEFAULT_CHAR_Y, padTop + CHAR_STANDING_HEIGHT_METRES + CHAR_SPAWN_LIFT_METRES);
    const params = makeDefaultVehicleParams(this.world, {
      x: DEFAULT_VEHICLE_X,
      y: DEFAULT_VEHICLE_Y,
      z: padTop + VEHICLE_SPAWN_Z_METRES,
    });
    this.vehicleCtl = new VehicleController(params);
    this.avatarMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(CHAR_RADIUS_METRES, CHAR_HALF_HEIGHT_METRES * 2, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x1d71b8, roughness: 0.7 }),
    );
    this.avatarMesh.rotation.x = Math.PI / 2;
    this.avatarMesh.castShadow = true;
    this.scene.add(this.avatarMesh);
    this.makeCarVisual();
    this.scene.add(this.carGroup);

    for (let i = 0; i < SETTLE_TICKS; i++) {
      this.vehicleCtl.preStep(FIXED_DT_SECONDS);
      this.world.timestep = FIXED_DT_SECONDS;
      this.world.step();
    }
    this.hud = createPlayHud({
      onReset: () => this.reset(),
      onMode: () => { window.location.href = '?mode=space'; },
    });
    this.bind();
    this.state = 'ready';
    window.__kwetuSurface = this.debugSurface();
    this.syncVisuals();
  }

  private makeCharacter(x: number, y: number, z: number): CharacterController {
    return new CharacterController(this.world, {
      radiusMetres: CHAR_RADIUS_METRES,
      halfHeightMetres: CHAR_HALF_HEIGHT_METRES,
      walkSpeedMetresPerSecond: WALK_SPEED_METRES_PER_SECOND,
      runSpeedMetresPerSecond: RUN_SPEED_METRES_PER_SECOND,
      spawnPositionMetres: { x, y, z },
    });
  }

  private makeCarVisual(): void {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 1.7, 0.7), new THREE.MeshStandardMaterial({ color: 0xe14938, roughness: 0.55 }));
    body.position.z = 0.1;
    body.castShadow = true;
    this.carGroup.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.45, 0.65), new THREE.MeshStandardMaterial({ color: 0xdde8ef }));
    cabin.position.set(-0.25, 0, 0.68);
    cabin.castShadow = true;
    this.carGroup.add(cabin);
    for (const x of [-1.25, 1.25]) for (const y of [-0.88, 0.88]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.22, 16), new THREE.MeshStandardMaterial({ color: 0x20242a }));
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, y, -0.35);
      this.carGroup.add(wheel);
    }
  }

  private bind(): void {
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('resize', this.onResize);
    addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('click', this.onCanvasClick);
    addEventListener('mousemove', this.onMouseMove);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat && ['KeyE', 'KeyR'].includes(event.code)) return;
    if (event.code === 'KeyE') this.toggleVehicle();
    else if (event.code === 'KeyR') this.reset();
    else {
      const control = codeToControl(event.code, event.key);
      if (control) this.controls.add(control);
    }
    if (codeToControl(event.code, event.key) || ['KeyE', 'KeyR'].includes(event.code)) event.preventDefault();
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const control = codeToControl(event.code, event.key);
    if (control) this.controls.delete(control);
  };
  private readonly onBlur = (): void => { this.controls.clear(); };
  private readonly onVisibility = (): void => { if (document.hidden) this.controls.clear(); };
  private readonly onCanvasClick = (): void => { void this.canvas.requestPointerLock?.(); };
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    this.cameraYaw -= event.movementX * MOUSE_SENSITIVITY_RAD_PER_PX;
    this.cameraPitch = clamp(this.cameraPitch + event.movementY * MOUSE_SENSITIVITY_RAD_PER_PX, CAMERA_PITCH_MIN_RAD, CAMERA_PITCH_MAX_RAD);
  };
  private readonly onResize = (): void => {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  };

  start(): void {
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      if (this.disposed) return;
      this.accumulator += Math.min(MAX_FRAME_DT_SECONDS, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      let ticks = 0;
      while (this.accumulator >= FIXED_DT_SECONDS && ticks++ < MAX_TICKS_PER_FRAME) {
        this.step();
        this.accumulator -= FIXED_DT_SECONDS;
      }
      if (ticks >= MAX_TICKS_PER_FRAME) this.accumulator = 0;
      this.syncVisuals();
      this.renderer.render(this.scene, this.camera);
      this.frameCount++;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private step(): void {
    const turn = (this.controls.has('left') ? 1 : 0) - (this.controls.has('right') ? 1 : 0);
    const drive = (this.controls.has('forward') ? 1 : 0) - (this.controls.has('back') ? 1 : 0);
    if (this.controls.has('lookLeft')) this.cameraYaw += ARROW_LOOK_RATE_RAD_PER_SECOND * FIXED_DT_SECONDS;
    if (this.controls.has('lookRight')) this.cameraYaw -= ARROW_LOOK_RATE_RAD_PER_SECOND * FIXED_DT_SECONDS;
    if (this.controls.has('lookUp')) this.cameraPitch = clamp(this.cameraPitch - ARROW_LOOK_RATE_RAD_PER_SECOND * FIXED_DT_SECONDS, CAMERA_PITCH_MIN_RAD, CAMERA_PITCH_MAX_RAD);
    if (this.controls.has('lookDown')) this.cameraPitch = clamp(this.cameraPitch + ARROW_LOOK_RATE_RAD_PER_SECOND * FIXED_DT_SECONDS, CAMERA_PITCH_MIN_RAD, CAMERA_PITCH_MAX_RAD);
    if (this.mode === 'walk') {
      const forward = { x: Math.cos(this.cameraYaw), y: Math.sin(this.cameraYaw), z: 0 };
      const right = { x: -forward.y, y: forward.x, z: 0 };
      this.characterCtl.setDesiredMove(
        { x: forward.x * drive + right.x * -turn, y: forward.y * drive + right.y * -turn, z: 0 },
        this.controls.has('run'),
      );
      if (this.controls.has('jump')) {
        this.characterCtl.jump(JUMP_SPEED_METRES_PER_SECOND);
        this.controls.delete('jump');
      }
      this.characterCtl.update(FIXED_DT_SECONDS);
      this.vehicleCtl.setThrottle(0);
      this.vehicleCtl.setSteer(0);
      this.vehicleCtl.setBrake(0);
    } else {
      this.vehicleCtl.setThrottle(drive);
      this.vehicleCtl.setSteer(turn);
      this.vehicleCtl.setBrake(this.controls.has('jump') ? 1 : 0);
    }
    this.vehicleCtl.preStep(FIXED_DT_SECONDS);
    this.world.timestep = FIXED_DT_SECONDS;
    this.world.step();
    this.simElapsed += FIXED_DT_SECONDS;
    this.guardBounds();
    if (this.simElapsed - this.lastHud >= HUD_PUSH_INTERVAL_SECONDS) { this.pushHud(); this.lastHud = this.simElapsed; }
    if (this.simElapsed - this.lastSave >= AUTOSAVE_INTERVAL_SECONDS) { this.save(); this.lastSave = this.simElapsed; }
  }

  private syncVisuals(): void {
    const p = this.characterCtl.position;
    this.avatarMesh.position.set(f32Downcast(p.x), f32Downcast(p.y), f32Downcast(p.z));
    this.avatarMesh.visible = this.mode === 'walk';
    const car = this.vehicleCtl.positionMetres;
    const q = this.vehicleCtl.orientationQuat;
    this.carGroup.position.set(f32Downcast(car.x), f32Downcast(car.y), f32Downcast(car.z));
    this.carGroup.quaternion.set(q.x, q.y, q.z, q.w);
    const target = this.mode === 'drive' ? car : p;
    if (this.mode === 'drive' && !this.controls.has('lookLeft') && !this.controls.has('lookRight')) {
      // cameraYaw is the direction from the camera towards its target. Matching
      // the chassis heading therefore places the camera behind the car. Adding
      // PI puts it in front and makes forward motion look like reversing.
      this.cameraYaw = lerpAngle(this.cameraYaw, this.vehicleCtl.headingRadians, Math.min(1, DRIVE_LOOK_RECENTRE_PER_SECOND * FIXED_DT_SECONDS));
    }
    const dist = this.mode === 'drive' ? CAMERA_DISTANCE_DRIVE_METRES : CAMERA_DISTANCE_WALK_METRES;
    const horizontal = Math.cos(this.cameraPitch) * dist;
    this.camera.position.set(
      target.x - Math.cos(this.cameraYaw) * horizontal,
      target.y - Math.sin(this.cameraYaw) * horizontal,
      target.z + Math.sin(this.cameraPitch) * dist + 1.2,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(target.x, target.y, target.z + 0.8);
  }

  private toggleVehicle(): void {
    const p = this.characterCtl.position;
    const car = this.vehicleCtl.positionMetres;
    if (this.mode === 'walk') {
      if (Math.hypot(p.x - car.x, p.y - car.y, p.z - car.z) <= ENTER_RADIUS_METRES) this.mode = 'drive';
    } else {
      this.mode = 'walk';
      const side = quatRotate(this.vehicleCtl.orientationQuat, { x: 0, y: 1, z: 0 });
      this.recreateCharacter(car.x + side.x * EXIT_LATERAL_METRES, car.y + side.y * EXIT_LATERAL_METRES, car.z + CHAR_STANDING_HEIGHT_METRES);
    }
    this.pushHud();
  }

  private recreateCharacter(x: number, y: number, z: number): void {
    this.characterCtl.dispose();
    this.characterCtl = this.makeCharacter(x, y, z);
  }

  reset(): void {
    const padTop = this.terrain.groundZ + PAD_TOP_LIFT_METRES;
    this.mode = 'walk';
    this.recreateCharacter(DEFAULT_CHAR_X, DEFAULT_CHAR_Y, padTop + CHAR_STANDING_HEIGHT_METRES + CHAR_SPAWN_LIFT_METRES);
    const body = this.vehicleCtl.chassisRigidBody;
    body.setTranslation({ x: DEFAULT_VEHICLE_X, y: DEFAULT_VEHICLE_Y, z: padTop + VEHICLE_SPAWN_Z_METRES }, true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.controls.clear();
    localStorage.removeItem(SAVE_KEY);
    this.pushHud();
  }

  private guardBounds(): void {
    const subject = this.mode === 'drive' ? this.vehicleCtl.positionMetres : this.characterCtl.position;
    if (!isFiniteVec(subject.x, subject.y, subject.z) || subject.z < FALL_GUARD_Z_METRES || Math.hypot(subject.x - PLAY_CENTRE_X, subject.y - PLAY_CENTRE_Y) > PLAY_RADIUS_METRES) this.reset();
  }

  private pushHud(): void {
    const state: PlayHudState = { mode: this.mode, speed: this.mode === 'drive' ? Math.abs(this.vehicleCtl.speedMetresPerSecond) : this.characterCtl.speed };
    this.hud.update(state);
  }

  private save(): void {
    try {
      const p = this.characterCtl.position;
      const v = this.vehicleCtl.positionMetres;
      const payload: SurfaceSaveV1 = { version: SAVE_VERSION, savedAt: Date.now(), mode: this.mode, player: { x: p.x, y: p.y, yawRad: 0 }, vehicle: { x: v.x, y: v.y, yawRad: this.vehicleCtl.headingRadians } };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch { /* storage may be unavailable */ }
  }

  private debugSurface(): KwetuSurfaceDebug {
    const app = this;
    return {
      get state() { return app.state; }, get mode() { return app.mode; }, get error() { return app.error; },
      get frameCount() { return app.frameCount; }, get simElapsedSeconds() { return app.simElapsed; },
      get character() { const p = app.characterCtl.position; return { x: p.x, y: p.y, z: p.z, grounded: app.characterCtl.isGrounded, speed: app.characterCtl.speed }; },
      get vehicle() { const p = app.vehicleCtl.positionMetres; return { x: p.x, y: p.y, z: p.z, headingRad: app.vehicleCtl.headingRadians, speed: app.vehicleCtl.speedMetresPerSecond, wheelsInContact: [0,1,2,3].map(i => app.vehicleCtl.wheelInContact(i)) }; },
      get camera() { return { yawRad: app.cameraYaw, pitchRad: app.cameraPitch }; },
      terrain: { state: 'ready', vertexCount: app.terrain.vertexCount, triangleCount: app.terrain.triangleCount },
      get savePresent() { return localStorage.getItem(SAVE_KEY) !== null; },
      reset: () => app.reset(), teleportNearCar: () => { const v = app.vehicleCtl.positionMetres; app.recreateCharacter(v.x - 2, v.y, v.z + CHAR_STANDING_HEIGHT_METRES); },
      advance: (seconds: number) => { const count = Math.max(0, Math.min(3600, Math.floor(seconds / FIXED_DT_SECONDS))); for (let i=0;i<count;i++) app.step(); app.syncVisuals(); },
      renderFrame: () => { app.syncVisuals(); app.renderer.render(app.scene, app.camera); app.frameCount++; const r=app.renderer.info.render; return { calls:r.calls, triangles:r.triangles }; },
      readCanvasRgba: () => app.readCanvas(), dispose: () => app.dispose(),
    };
  }

  private readCanvas(): { width: number; height: number; rgba: Uint8Array } | null {
    const gl=this.renderer.getContext(), width=gl.drawingBufferWidth, height=gl.drawingBufferHeight, rgba=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    return gl.getError() === gl.NO_ERROR ? {width,height,rgba} : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed=true; cancelAnimationFrame(this.raf); this.save(); this.characterCtl.dispose(); this.hud.dispose();
    removeEventListener('keydown',this.onKeyDown); removeEventListener('keyup',this.onKeyUp); removeEventListener('resize',this.onResize); removeEventListener('blur',this.onBlur); document.removeEventListener('visibilitychange',this.onVisibility); this.canvas.removeEventListener('click',this.onCanvasClick); removeEventListener('mousemove',this.onMouseMove);
    this.scene.traverse(o=>{ if(o instanceof THREE.Mesh){o.geometry.dispose(); const m=o.material; if(Array.isArray(m))m.forEach(x=>x.dispose());else m.dispose();} });
    this.renderer.dispose(); this.world.free(); delete window.__kwetuSurface;
  }
}
