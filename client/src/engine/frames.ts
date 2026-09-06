/**
 * Kwetu engine — the frame chain (COORDINATE_SYSTEM.md §1, §13).
 *
 * Implements the doc's chain, one arrow per conversion, all f64 (Law P-1):
 *
 *   Frame.Helio ──toPci──> Frame.Pci(Earth) ──toPlanetFixed──> Frame.PlanetFixed(Earth)
 *      (translation only)                                        (the one rotation)
 *                                                                     │
 *                                          toGeodetic / toEnu (geodesy module)
 *
 * Rotation pair (ADR-002 Decision 1, measured):
 *   - `Frame.Pci(Earth)` axes are parallel to `Frame.Helio` axes — the
 *     heliocentric hop is a pure translation (§1), which is why there is
 *     exactly ONE rotation in the chain: `toPlanetFixed`.
 *   - PlanetFixed(Earth) ↔ EQD via the Greenwich Apparent Sidereal Time
 *     (library `SiderealTime`) as a z-rotation: PF → EQD is Rz(+GAST),
 *     EQD → PF is Rz(−GAST).
 *   - EQJ ↔ EQD via the library's `Rotation_EQJ_EQD` / `Rotation_EQD_EQJ`,
 *     applied ONLY through the library's `RotateVector`/`RotateState`. The
 *     stored matrix must never be hand-multiplied: a manual row-major
 *     multiply of `rot.rot` is the transposed (inverted) mapping — verified
 *     against the library's own `ObserverVector` endpoints in S0.1
 *     [MEASURED 2026-09-05, ADR-002 evidence A].
 *   - No ecliptic frame: ECL/ECT are banned as Kwetu frames (§1, §13).
 *
 * Deliberate omissions (§1, quantified): polar motion (≤ ~9 m at the surface),
 * DUT1 (< 0.4 km at the equator), tides, plate motion. All below the game
 * accuracy bar; any revisit is by ADR only.
 *
 * Naming (§13): conversions are verbs (`toX`), frames are nouns (`Frame.X`);
 * conversions never mutate their input; a returned vector always carries its
 * frame. Banned synonyms ("world frame", "surface frame", "ecliptic
 * coordinates", …) appear nowhere in this file.
 *
 * Runtime dependency: this module → ephemeris (the adapter owns the provider
 * time bridge and the AU boundary, §1/§3/§4). The ephemeris module tags its
 * returns with the frame-name literals defined here — the equality is asserted
 * in tests so the vocabulary cannot drift.
 */
import * as A from 'astronomy-engine';
import {
  EARTH_OMEGA_RAD_PER_S,
  ecefToEnu,
  ecefToGeodetic,
  enuToEcef,
  geodeticToEcef,
  type GeodeticCoord,
} from './geodesy';
import { astroTimeFromWorldTime, earthHelioPositionMetres, type WorldTimeTtSeconds } from './ephemeris';
import {
  addV,
  cross3,
  framed,
  rotateZ,
  type Framed,
  type Vec3,
} from './vec3';

// --- the frame registry (§13) ------------------------------------------------------

/**
 * The §13 frame vocabulary as frame-name strings. Only Earth exists today;
 * other bodies land with their data sources (§1 — `Frame.Geodetic(body)` for
 * non-Earth bodies needs their ellipsoid constants from `DATA_SOURCES.md`).
 * New frame kinds require an ADR (§1).
 *
 * The body-parameterised members carry EXPLICIT template-literal return types:
 * a bare template expression widens to `string` in value position, which
 * would silently strip the frame identity off every `Framed` value (§13 rule 3
 * — a value whose frame has widened is the compile-time shape of the very bug
 * the rule bans).
 */
export const Frame = {
  /** Reserved root (SSB, EQJ-aligned axes) — defined and reserved; no code computes it (§1). */
  Universe: 'Universe',
  /** Sun centre, EQJ axes, metres. Owner: the ephemeris adapter. */
  Helio: 'Helio',
  /** Body centre, axes parallel to EQJ — translation only, never rotated (§1). */
  pci: (body: BodyName): PciFrameName => `Pci(${body})`,
  /** Body-fixed rotating frame — where the one rotation happens (§1). */
  planetFixed: (body: BodyName): PlanetFixedFrameName => `PlanetFixed(${body})`,
  /** Reference-ellipsoid coordinates (Earth: WGS84), degrees + metres (§1, §5). */
  geodetic: (body: BodyName): GeodeticFrameName => `Geodetic(${body})`,
  /** Tangent triad at an anchor: +x east, +y north, +z up (§1, §8). */
  enu: (body: BodyName): EnuFrameName => `Enu(${body})`,
} as const;

/** `Frame.Pci(body)` name, distributed over the implemented bodies. */
export type PciFrameName = `Pci(${BodyName})`;
/** `Frame.PlanetFixed(body)` name, distributed over the implemented bodies. */
export type PlanetFixedFrameName = `PlanetFixed(${BodyName})`;
/** `Frame.Geodetic(body)` name, distributed over the implemented bodies. */
export type GeodeticFrameName = `Geodetic(${BodyName})`;
/** `Frame.Enu(body)` name, distributed over the implemented bodies. */
export type EnuFrameName = `Enu(${BodyName})`;

/** Concrete frame-name string types carried by `Framed` values. */
export type FrameName =
  | typeof Frame.Universe
  | typeof Frame.Helio
  | PciFrameName
  | PlanetFixedFrameName
  | GeodeticFrameName
  | EnuFrameName;

/** Bodies with an implemented frame chain. Earth only today (§1). */
export type BodyName = 'Earth';

function assertEarth(body: BodyName): void {
  if (body !== 'Earth') {
    // Other bodies need their ellipsoid/rotation constants from their data
    // sources first (§1); they are not implemented, not approximated.
    throw new Error(`Frame chain for body "${body}" is not implemented (Earth only; new bodies need their data-source constants)`);
  }
}

// --- the one rotation: PlanetFixed(Earth) <-> Pci(Earth) ---------------------------

/**
 * Greenwich Apparent Sidereal Time, radians (library `SiderealTime` returns
 * sidereal hours in [0, 24); 1 h = 15°). The EQD ↔ PlanetFixed z-rotation
 * angle. [Seed: 344.118° at the §12 instant — COORDINATE_SYSTEM.md §12 step 2.]
 */
export function gastRadians(worldTimeTtSeconds: WorldTimeTtSeconds): number {
  const hours = A.SiderealTime(astroTimeFromWorldTime(worldTimeTtSeconds));
  return (hours * 15 * Math.PI) / 180;
}

/**
 * `Frame.Pci(Earth)` → `Frame.PlanetFixed(Earth)` — REQUIRED name (§13: the
 * only rotating hop). Library EQJ→EQD through `RotateVector`, then Rz(−GAST).
 */
export function toPlanetFixed(
  v: Framed<'Pci(Earth)'>,
  body: BodyName,
  worldTimeTtSeconds: WorldTimeTtSeconds,
): Framed<'PlanetFixed(Earth)'> {
  assertEarth(body);
  const eqd = libraryRotate(A.Rotation_EQJ_EQD(astroTimeFromWorldTime(worldTimeTtSeconds)), v.xyz);
  return framed(Frame.planetFixed(body), rotateZ(eqd, -gastRadians(worldTimeTtSeconds)));
}

/**
 * `Frame.PlanetFixed(Earth)` → `Frame.Pci(Earth)` — the inverse rotation of
 * {@link toPlanetFixed}: Rz(+GAST) into EQD, then library EQD→EQJ.
 */
export function toPci(v: Framed<'PlanetFixed(Earth)'>, body: BodyName, worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Pci(Earth)'>;
/** `Frame.Helio` → `Frame.Pci(Earth)` — pure translation (§1): subtract the body's heliocentric position. */
export function toPci(v: Framed<'Helio'>, bodyHelioPosition: Framed<'Helio'>): Framed<'Pci(Earth)'>;
export function toPci(
  v: Framed<'PlanetFixed(Earth)'> | Framed<'Helio'>,
  bodyOrBodyHelio: BodyName | Framed<'Helio'>,
  worldTimeTtSeconds?: WorldTimeTtSeconds,
): Framed<'Pci(Earth)'> {
  if (typeof bodyOrBodyHelio === 'string') {
    assertEarth(bodyOrBodyHelio);
    const t = worldTimeTtSeconds as WorldTimeTtSeconds;
    const eqd = rotateZ(v.xyz, gastRadians(t));
    return framed(Frame.pci(bodyOrBodyHelio), libraryRotate(A.Rotation_EQD_EQJ(astroTimeFromWorldTime(t)), eqd));
  }
  const bodyHelio = bodyOrBodyHelio;
  if (bodyHelio.frame !== Frame.Helio) {
    throw new Error(`toPci(translation) needs the body's Frame.Helio position, got frame "${bodyHelio.frame}"`);
  }
  return framed(Frame.pci('Earth'), {
    x: v.xyz.x - bodyHelio.xyz.x,
    y: v.xyz.y - bodyHelio.xyz.y,
    z: v.xyz.z - bodyHelio.xyz.z,
  });
}

// --- translation hop: Pci(Earth) <-> Helio ------------------------------------------

/** `Frame.Pci(Earth)` → `Frame.Helio` — pure translation (§1): add the body's heliocentric position. */
export function toHelio(v: Framed<'Pci(Earth)'>, bodyHelioPosition: Framed<'Helio'>): Framed<'Helio'> {
  if (bodyHelioPosition.frame !== Frame.Helio) {
    throw new Error(`toHelio needs the body's Frame.Helio position, got frame "${bodyHelioPosition.frame}"`);
  }
  return framed(Frame.Helio, {
    x: v.xyz.x + bodyHelioPosition.xyz.x,
    y: v.xyz.y + bodyHelioPosition.xyz.y,
    z: v.xyz.z + bodyHelioPosition.xyz.z,
  });
}

/** Earth's heliocentric position in metres (the AU constant is crossed once, inside the adapter — §3). */
export function earthHelioPosition(worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Helio'> {
  return earthHelioPositionMetres(worldTimeTtSeconds);
}

// --- velocity conversion (Law V-1) ---------------------------------------------------

/** Earth's rotation as an EQD-axis vector, rad/s (the z axis of the of-date equator). */
const EARTH_OMEGA_EQD: Vec3 = { x: 0, y: 0, z: EARTH_OMEGA_RAD_PER_S };

/**
 * Law V-1: every position conversion has a matching velocity conversion.
 * `Frame.PlanetFixed(Earth)` → `Frame.Pci(Earth)` velocity for a body at
 * planet-fixed position `rPlanetFixed` (metres) with planet-fixed velocity
 * `vPlanetFixed` (metres/second), both f64:
 *
 *   v_eqd = Rz(+GAST)·v_pf + ω⊕ × r_eqd,   ω⊕ = 7.2921159e−5 rad/s about +z
 *   (position, v_eqd) → EQJ via the library's own `RotateState`
 *
 * The transport term ω × r is the whole point: a point fixed on the equator
 * (v_pf = 0) has velocity ≈ 465 m/s in `Frame.Pci(Earth)` and zero in
 * `Frame.PlanetFixed(Earth)` [derived — Law V-1]. The ω × r term is f64 physics
 * in this module (not a library matrix); the EQD→EQJ leg goes through the
 * library's `RotateState` so position and velocity are rotated by the same
 * stored matrix. Mixing a `Frame.Pci` velocity with a `Frame.PlanetFixed`
 * position is the bug this function exists to prevent (§2). Measured: chain
 * vs library `ObserverState` at the equator agree to 8.66e−5 m/s
 * [MEASURED 2026-09-05, ADR-002 evidence A].
 *
 * Returns both converted components: the position leg re-uses the same
 * `RotateState` call, so callers cannot mix frames by construction.
 */
export function pciVelocityFromPlanetFixed(
  rPlanetFixed: Vec3,
  vPlanetFixed: Vec3,
  body: BodyName,
  worldTimeTtSeconds: WorldTimeTtSeconds,
): { positionPci: Vec3; velocityPciMetresPerSecond: Vec3 } {
  assertEarth(body);
  const t = astroTimeFromWorldTime(worldTimeTtSeconds);
  const gast = gastRadians(worldTimeTtSeconds);
  const rEqd = rotateZ(rPlanetFixed, gast);
  const vEqd = addV(rotateZ(vPlanetFixed, gast), cross3(EARTH_OMEGA_EQD, rEqd));
  const state = A.RotateState(A.Rotation_EQD_EQJ(t), new A.StateVector(rEqd.x, rEqd.y, rEqd.z, vEqd.x, vEqd.y, vEqd.z, t));
  return { positionPci: { x: state.x, y: state.y, z: state.z }, velocityPciMetresPerSecond: { x: state.vx, y: state.vy, z: state.vz } };
}

// --- geodetic and ENU (geodesy owns the math; frames owns the tags) -------------------

/** Geodetic (WGS84, degrees + ellipsoidal height) → `Frame.PlanetFixed(Earth)` (ECEF), §5 closed form. */
export function geodeticToPlanetFixed(coord: GeodeticCoord): Framed<'PlanetFixed(Earth)'> {
  return framed(Frame.planetFixed('Earth'), geodeticToEcef(coord));
}

/** `Frame.PlanetFixed(Earth)` → geodetic (WGS84). [Inverse seam — see geodesy.ts.] */
export function toGeodetic(v: Framed<'PlanetFixed(Earth)'>): GeodeticCoord {
  if (v.frame !== Frame.planetFixed('Earth')) {
    throw new Error(`toGeodetic needs frame "PlanetFixed(Earth)", got "${v.frame}"`);
  }
  return ecefToGeodetic(v.xyz);
}

/** `Frame.PlanetFixed(Earth)` → `Frame.Enu(Earth)` at a geodetic anchor (§5: p_enu = R·(p_pf − p_anchor)). */
export function toEnu(v: Framed<'PlanetFixed(Earth)'>, anchorGeodetic: GeodeticCoord): Framed<'Enu(Earth)'> {
  if (v.frame !== Frame.planetFixed('Earth')) {
    throw new Error(`toEnu needs frame "PlanetFixed(Earth)", got "${v.frame}"`);
  }
  return framed(Frame.enu('Earth'), ecefToEnu(v.xyz, anchorGeodetic));
}

/** `Frame.Enu(Earth)` at a geodetic anchor → `Frame.PlanetFixed(Earth)` (§5 inverse). */
export function enuToPlanetFixed(v: Framed<'Enu(Earth)'>, anchorGeodetic: GeodeticCoord): Framed<'PlanetFixed(Earth)'> {
  if (v.frame !== Frame.enu('Earth')) {
    throw new Error(`enuToPlanetFixed needs frame "Enu(Earth)", got "${v.frame}"`);
  }
  return framed(Frame.planetFixed('Earth'), enuToEcef(v.xyz, anchorGeodetic));
}

// --- library-rotation plumbing (private) ---------------------------------------------

/**
 * Applies a library rotation matrix to a vector — ONLY via the library's
 * `RotateVector`. The vector's time field is rotation metadata the library
 * requires but does not use for the rotation itself; the J2000-epoch value
 * matches the spike's verified call shape (0 days since J2000).
 */
function libraryRotate(rot: A.RotationMatrix, v: Vec3): Vec3 {
  const out = A.RotateVector(rot, new A.Vector(v.x, v.y, v.z, A.MakeTime(0)));
  return { x: out.x, y: out.y, z: out.z };
}
