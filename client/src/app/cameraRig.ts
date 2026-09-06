/**
 * Kwetu shell — the camera rig: the floating-origin render bubble's anchor
 * owner (Phase-1 Part B; COORDINATE_SYSTEM.md §1/§6/§8, ADR-002).
 *
 * Frame layout (COORDINATE_SYSTEM.md is the correctness law):
 *   - Canonical camera state is f64 `Frame.PlanetFixed(Earth)` (Law P-1).
 *     The shell's camera is surface-anchored: idle flight co-rotates with the
 *     body, so "N metres above a site" is stable. Free-flight inertial
 *     integration is ADR-001/VEHICLES_AND_FLIGHT territory, not tonight's.
 *   - LocalScene axes are the anchor's ENU triad (+x east, +y north, +z up —
 *     §8 Z-up rule). Body-local render positions are RE-DERIVED every frame
 *     as `ecefToEnu(bodyPlanetFixed, anchorGeodetic)` in f64 — Law P-6:
 *     re-derivation, never a shift vector.
 *   - Anchor = the camera position. When the camera's local coordinates cross
 *     {@link RENDER_REBASE_THRESHOLD_METRES}, the anchor is re-derived
 *     canonically (`ecefToGeodetic(cameraPf)`) and every body re-derives from
 *     its f64 ground truth under the new axes — nothing is translated in f32.
 *   - The single f32 downcast happens at the render boundary (Law P-2): the
 *     app calls f32Downcast on each component as it hands coordinates to
 *     three.js. Local coordinates are bounded by the rebase threshold, so the
 *     f32 spacing there is bounded with them (Law P-5).
 *
 * NO PHYSICS TONIGHT: this rig imports no Rapier and no LocalScene — the
 * contact bubble (localScene.ts, Law PH-1) is a separate layer that lands
 * with Phase 3. ADR-004 Decision 2 already anticipated the shell flying
 * before RAPIER.init() resolves.
 *
 * [PLACEHOLDER — ADR-003] the world body is a single smooth sphere, so its
 * f32 mesh vertices carry ~0.5 m static quantization at Earth radius and the
 * whole-planet translate quantizes in f32 at the same scale while MOVING near
 * the surface (catastrophic cancellation in the vertex stage — the exact
 * class Law P-3 forbids on CPU paths). Stationary frames are exact. ADR-003's
 * per-tile planet renderer is the fix; this rig's re-derivation boundary is
 * already the shape that fix plugs into.
 */
import { Quaternion, Vector3 } from 'three';
import {
  ecefToEnu,
  ecefToGeodetic,
  enuBasis,
  type GeodeticCoord,
} from '../engine/geodesy';
import { addV, norm3, scaleV, type Vec3 } from '../engine/vec3';
import type { FlightInput } from './debugTypes';

/**
 * Render-scene rebase threshold, metres. Law P-5 bounds a rendered local
 * scene at ~1e5–1e6 m; this rig rebases at the lower band. f32 spacing at
 * 1e5 m is 7.8 mm [derived — COORDINATE_SYSTEM.md §6 ladder], sub-pixel at
 * every view the shell supports. The 1e4 m ADR-002 Decision 4 bound is the
 * *contact bubble* bound (Law PH-1) — tighter, and not this layer's.
 */
export const RENDER_REBASE_THRESHOLD_METRES = 1e5;

/** Speed clamp, m/s: 1 m/s … 1e9 m/s (1 m → 1e10 m in seconds of flight). */
export const SPEED_MIN_METRES_PER_SECOND = 1;
export const SPEED_MAX_METRES_PER_SECOND = 1e9;
/** Mouse-wheel speed multiplier per notch (exponential scaling). */
export const SPEED_WHEEL_FACTOR = 1.5;

/**
 * Boot site: the COORDINATE_SYSTEM.md §12 illustrative site (Dar es Salaam
 * seafront, geodetic phi/lambda). [PLACEHOLDER — ADR-003] the placeholder
 * world is a SPHERE of the mean radius, and the site's geodetic latitude is
 * used directly as the geocentric direction of the surface point (deflection
 * of the vertical ~8e-4 rad at this latitude — irrelevant for a placeholder;
 * the real planet renderer anchors through Law G-3 geodesy).
 */
export const SITE_LATITUDE_DEG = -6.79;
export const SITE_LONGITUDE_DEG = 39.21;

const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/**
 * The ONE owner of the keyboard-code -> FlightInput-slot mapping (review
 * hygiene 2026-09-06: was duplicated as ClientApp's FLIGHT_KEYS set +
 * `setKey`'s private table). ClientApp reads it to filter + preventDefault
 * the DOM events; {@link applyKeyStates} consumes it for the per-tick sync.
 */
export const KEY_TO_FLIGHT_ACTION: Readonly<Record<string, keyof FlightInput>> = {
  KeyW: 'forward',
  KeyS: 'backward',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'up',
  KeyQ: 'down',
};

export class CameraRig {
  /** Placeholder sphere radius — the visible "surface" altitudes measure against. */
  private readonly sphereRadiusMetres: number;
  /** Geocentric unit direction of the boot site (f64). */
  private readonly siteRadial: Vec3;
  /** Canonical camera position, Frame.PlanetFixed(Earth), f64 (Law P-1). */
  private cameraPf: Vec3;
  /** The floating-origin anchor: geodetic of the last canonical re-derivation. */
  private anchor: GeodeticCoord;
  /** Free-look angles (f64): yaw about local +z, pitch about local +x. */
  private yawRad = 0;
  private pitchRad = 0;

  speedMetresPerSecond = SPEED_MIN_METRES_PER_SECOND;
  private readonly keyInput: FlightInput = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  private readonly debugInput: FlightInput = { forward: false, backward: false, left: false, right: false, up: false, down: false };

  private readonly scratchQuatYaw = new Quaternion();
  private readonly scratchQuatPitch = new Quaternion();
  private readonly scratchDir = new Vector3();

  constructor(sphereRadiusMetres: number, bootAltitudeAboveSphereMetres: number) {
    this.sphereRadiusMetres = sphereRadiusMetres;
    const phi = (SITE_LATITUDE_DEG * Math.PI) / 180;
    const lam = (SITE_LONGITUDE_DEG * Math.PI) / 180;
    this.siteRadial = { x: Math.cos(phi) * Math.cos(lam), y: Math.cos(phi) * Math.sin(lam), z: Math.sin(phi) };
    this.cameraPf = scaleV(this.siteRadial, sphereRadiusMetres + bootAltitudeAboveSphereMetres);
    this.anchor = ecefToGeodetic(this.cameraPf);
  }

  /** The current anchor (f64 canonical; mutated only by re-derivation, Law P-6). */
  get anchorGeodetic(): GeodeticCoord {
    return this.anchor;
  }

  /** Canonical camera position, Frame.PlanetFixed(Earth), f64. */
  get cameraPlanetFixed(): Vec3 {
    return this.cameraPf;
  }

  /** Camera altitude above the placeholder sphere (geocentric), metres, f64. */
  get altitudeAboveSphereMetres(): number {
    return norm3(this.cameraPf) - this.sphereRadiusMetres;
  }

  /** The boot site's surface point on the placeholder sphere, canonical PlanetFixed, f64. */
  get siteSurfacePoint(): Vec3 {
    return scaleV(this.siteRadial, this.sphereRadiusMetres);
  }

  get look(): { yawRad: number; pitchRad: number } {
    return { yawRad: this.yawRad, pitchRad: this.pitchRad };
  }

  /**
   * The look quaternion, composed in ONE place (review hygiene 2026-09-06:
   * was built identically here and in ClientApp.applyCamera): q_z(yaw) ·
   * q_x(pitch) — pitch applies first. Identity looks along LocalScene -z =
   * nadir (LocalScene is Z-up ENU). `target` is overwritten and returned; it
   * must not alias the rig's internal pitch scratch quaternion.
   */
  lookQuaternion(target: Quaternion): Quaternion {
    return target
      .setFromAxisAngle(Z_AXIS, this.yawRad)
      .multiply(this.scratchQuatPitch.setFromAxisAngle(X_AXIS, this.pitchRad));
  }

  // --- input -----------------------------------------------------------------------

  /**
   * Keyboard state — ClientApp passes its live key-code set each tick. The
   * rig owns the code -> action map ({@link KEY_TO_FLIGHT_ACTION}); the app
   * layer mirrors no table.
   */
  applyKeyStates(keysDown: ReadonlySet<string>): void {
    for (const code of Object.keys(KEY_TO_FLIGHT_ACTION)) {
      const slot = KEY_TO_FLIGHT_ACTION[code];
      if (slot !== undefined) this.keyInput[slot] = keysDown.has(code);
    }
  }

  /** Debug/e2e input — REPLACES the debug lanes; the keyboard ORs in on top. */
  setDebugInput(input: FlightInput): void {
    this.debugInput.forward = input.forward === true;
    this.debugInput.backward = input.backward === true;
    this.debugInput.left = input.left === true;
    this.debugInput.right = input.right === true;
    this.debugInput.up = input.up === true;
    this.debugInput.down = input.down === true;
  }

  /** Mouse-wheel speed scaling (exponential, clamped). `direction` = wheel deltaY sign. */
  scaleSpeedByWheel(direction: number): void {
    if (direction < 0) {
      this.speedMetresPerSecond = Math.min(this.speedMetresPerSecond * SPEED_WHEEL_FACTOR, SPEED_MAX_METRES_PER_SECOND);
    } else if (direction > 0) {
      this.speedMetresPerSecond = Math.max(this.speedMetresPerSecond / SPEED_WHEEL_FACTOR, SPEED_MIN_METRES_PER_SECOND);
    }
  }

  /** Sets the flight speed through the same clamp (the e2e seam for the wheel path). */
  setSpeed(metresPerSecond: number): void {
    if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) return;
    this.speedMetresPerSecond = Math.min(Math.max(metresPerSecond, SPEED_MIN_METRES_PER_SECOND), SPEED_MAX_METRES_PER_SECOND);
  }

  /** Mouse-look deltas (pointer-lock movementX/Y), f64. */
  applyMouseLook(deltaX: number, deltaY: number): void {
    const sensitivity = 0.0022;
    this.yawRad -= deltaX * sensitivity;
    this.pitchRad -= deltaY * sensitivity;
    // Full sphere coverage: yaw is degenerate only exactly at nadir/zenith,
    // where it degenerates to roll-in-place (harmless). Clamp to +-pi.
    const limit = Math.PI;
    this.pitchRad = Math.min(Math.max(this.pitchRad, -limit), limit);
  }

  /** Points the camera nadir — at the planet centre (identity local orientation). */
  orientToPlanetCenter(): void {
    this.yawRad = 0;
    this.pitchRad = 0;
  }

  /**
   * Teleports the camera to an arbitrary geodetic site at an altitude above
   * the placeholder sphere, by canonical re-derivation (Law P-6): cameraPf is
   * recomputed from f64 ground truth and the anchor re-derived from it. Never
   * a shift of accumulated state. The geodetic lat/lon is used directly as
   * the radial DIRECTION (the same placeholder-sphere convention as the boot
   * site and the region tile mount — see the header note).
   * Note: `ecefToGeodetic` is validated to +-80 deg lat, |h| <= 1e6 m
   * (geodesy.ts); beyond that the shell relies only on its self-consistent
   * round trip (anchorEcef ~= cameraPf, so camera-local ~= 0), never on
   * survey-grade values (Law G-3 keeps those in planet-fixed geodetic state).
   */
  setCameraSite(latitudeDeg: number, longitudeDeg: number, altitudeAboveSphereMetres: number): void {
    if (!Number.isFinite(latitudeDeg) || !Number.isFinite(longitudeDeg) || !Number.isFinite(altitudeAboveSphereMetres)) return;
    const phi = (latitudeDeg * Math.PI) / 180;
    const lam = (longitudeDeg * Math.PI) / 180;
    const radial: Vec3 = { x: Math.cos(phi) * Math.cos(lam), y: Math.cos(phi) * Math.sin(lam), z: Math.sin(phi) };
    this.cameraPf = scaleV(radial, this.sphereRadiusMetres + altitudeAboveSphereMetres);
    this.anchor = ecefToGeodetic(this.cameraPf);
  }

  /** Teleports along the boot site's radial — {@link setCameraSite} at the boot site. */
  setCameraAltitude(altitudeAboveSphereMetres: number): void {
    this.setCameraSite(SITE_LATITUDE_DEG, SITE_LONGITUDE_DEG, altitudeAboveSphereMetres);
  }

  // --- per-tick integration ----------------------------------------------------------

  /**
   * One flight tick, all f64 (Law P-1): input direction in LocalScene axes
   * (WASD camera-relative, QE along the anchor's geodetic up), integrated
   * into canonical PlanetFixed through the ENU basis rotation, then the
   * Law P-6 rebase check.
   */
  tick(dtSeconds: number): void {
    const dir = this.flightDirectionLocal();
    if (dir !== null && this.speedMetresPerSecond > 0) {
      const step = this.speedMetresPerSecond * dtSeconds;
      const deltaLocal = { x: dir.x * step, y: dir.y * step, z: dir.z * step };
      // Pure ENU -> PlanetFixed rotation for a DELTA (the enuToEcef rows
      // without the anchor translation — never an inline * 1000-style hop).
      const b = enuBasis(this.anchor.latitudeDeg, this.anchor.longitudeDeg);
      const deltaPf: Vec3 = {
        x: b.east.x * deltaLocal.x + b.north.x * deltaLocal.y + b.up.x * deltaLocal.z,
        y: b.east.y * deltaLocal.x + b.north.y * deltaLocal.y + b.up.y * deltaLocal.z,
        z: b.east.z * deltaLocal.x + b.north.z * deltaLocal.y + b.up.z * deltaLocal.z,
      };
      this.cameraPf = addV(this.cameraPf, deltaPf);
    }

    // Law P-6 re-derivation: the anchor moved through the world. Re-derive
    // the anchor from canonical camera state; every body re-derives from its
    // own ground truth next frame under the new axes. Nothing is shifted.
    const cameraLocal = ecefToEnu(this.cameraPf, this.anchor);
    if (norm3(cameraLocal) > RENDER_REBASE_THRESHOLD_METRES) {
      this.anchor = ecefToGeodetic(this.cameraPf);
    }
  }

  /**
   * Camera position in LocalScene axes (the anchor's ENU triad), f64 — the
   * value the renderer downcasts at its single f32 boundary (Law P-2).
   */
  cameraLocalMetres(): Vec3 {
    return ecefToEnu(this.cameraPf, this.anchor);
  }

  /**
   * Combined input direction in LocalScene axes, normalized, or null when no
   * input is held. WASD are camera-relative (through the look quaternion);
   * QE are LocalScene up/down (geodetic up at the anchor) so altitude control
   * stays world-referenced.
   */
  private flightDirectionLocal(): Vec3 | null {
    const f = this.keyInput.forward === true || this.debugInput.forward === true ? 1 : 0;
    const b = this.keyInput.backward === true || this.debugInput.backward === true ? 1 : 0;
    const l = this.keyInput.left === true || this.debugInput.left === true ? 1 : 0;
    const r = this.keyInput.right === true || this.debugInput.right === true ? 1 : 0;
    const u = this.keyInput.up === true || this.debugInput.up === true ? 1 : 0;
    const d = this.keyInput.down === true || this.debugInput.down === true ? 1 : 0;
    if (f === 0 && b === 0 && l === 0 && r === 0 && u === 0 && d === 0) return null;

    // look quaternion = q_z(yaw) (x) q_x(pitch) — composed by the one owner,
    // lookQuaternion().
    const q = this.lookQuaternion(this.scratchQuatYaw);
    const dir = this.scratchDir.set(0, 0, 0);
    if (f !== 0 || b !== 0) dir.addScaledVector(FORWARD, f - b).applyQuaternion(q);
    if (l !== 0 || r !== 0) dir.addScaledVector(RIGHT, r - l).applyQuaternion(q);
    if (u !== 0 || d !== 0) dir.addScaledVector(LOCAL_UP, u - d);
    if (dir.lengthSq() === 0) return null;
    dir.normalize();
    return { x: dir.x, y: dir.y, z: dir.z };
  }
}

// Module-level scratch directions (allocation-free hot path).
const FORWARD = new Vector3(0, 0, -1);
const RIGHT = new Vector3(1, 0, 0);
const LOCAL_UP = new Vector3(0, 0, 1);
