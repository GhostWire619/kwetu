/**
 * Kwetu engine — the ephemeris adapter (COORDINATE_SYSTEM.md §1, §3, §4).
 *
 * THE single place that owns the astronomy-engine boundary: every AU → metre
 * conversion in the codebase happens in this file, with the library's own
 * pinned constant, exactly once per returned vector (§3). Nothing outside this
 * module ever sees AU, kilometres, or a library Vector object.
 *
 * Frame contract (§1): positions are returned in `Frame.Helio` (EQJ axes,
 * metres), `Frame.Pci(Earth)` (EQJ axes — translation only, never rotated) or
 * `Frame.Enu` (topocentric). EQJ is the only inertial axes set; no stored or
 * transmitted position is ever in ECL/ECT/EQD/HOR (§1 — "ecliptic coordinates"
 * is a synonym bug, §13). Library rotations are applied ONLY through the
 * library's own `RotateVector`/`RotateState` — the stored matrix must never be
 * hand-multiplied (S0.1 finding: `rot.rot` row-major is the transposed mapping;
 * ADR-002 evidence A).
 *
 * Accuracy contract (§10): the ephemeris is sky/event quality (±1 arcminute
 * [EXTERNAL — astronomy-engine docs]); it is not landing guidance and never
 * back-solves a surface position.
 *
 * All math f64 (Law P-1); results in SI metres (Law U-1); angles in radians in
 * code, degrees only in `...Deg` fields (Laws U-2/U-3).
 */
import * as A from 'astronomy-engine';
import type { Framed, Vec3 } from './vec3';

/**
 * The library's own AU constant, in metres — the ONLY AU→m conversion constant
 * in the codebase. Do NOT substitute the exact IAU 2012 definition
 * (1 au = 149 597 870 700 m [EXTERNAL — IAU 2012 Resolution B2]): the library's
 * constant differs by ~9 m per AU, and golden fixtures generated under a
 * different constant are wrong by metres (§3).
 * [EXTERNAL — astronomy-engine 2.1.19 `KM_PER_AU`, pinned in package.json.]
 */
export const AU_METRES = A.KM_PER_AU * 1000;

// --- authoritative time bridge (COORDINATE_SYSTEM.md §4) --------------------------

/**
 * The authoritative simulation instant: TT seconds since the J2000 TT epoch
 * (2000-01-01 12:00:00 TT) — a simulation number, never a JS Date (§4).
 * Field-name convention carries the unit (Law U-3).
 */
export type WorldTimeTtSeconds = number;

/**
 * UTC milliseconds of the J2000 TT epoch: 2000-01-01T11:58:55.816Z — the UTC
 * label of the instant whose TT reading is 2000-01-01T12:00:00.000. The
 * TT−UTC offset is absorbed into this constant, so worldTime 0 maps to it
 * exactly (§4: worldTime is TT seconds since J2000 TT).
 * [EXTERNAL — IERS leap-second history: TT − UTC = 32 leap seconds + 32.184 s
 * at the J2000 epoch.]
 */
export const J2000_TT_EPOCH_UTC_MILLIS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);

/**
 * TT − UTC for the pinned era, seconds: TAI−UTC = 37 s (since 2017-01-01) +
 * TT−TAI = 32.184 s = 69.184 s. [PLACEHOLDER — gate: S0.7 owns the versioned
 * leap-second table and the restart/outage policy (COORDINATE_SYSTEM.md §4, §14).
 * Valid for instants in the current leap era, including the S0.1/§12 seed
 * instant 2026-09-05T00:00:00Z. The bridge functions below do NOT add this
 * value explicitly: it is absorbed into {@link J2000_TT_EPOCH_UTC_MILLIS},
 * which is *defined* as the UTC label of the TT epoch. This constant is what
 * that definition was computed from — golden fixtures record it
 * (`GOLDEN_FIXTURE_PINS`) because a different leap era shifts the UTC label of
 * any worldTime by whole seconds, and a fixture regenerated under a different
 * pin is a different fixture (§11). Before any save schema ships, S0.7
 * replaces this constant with the versioned table.]
 * [EXTERNAL — IERS Bulletin C leap-second count.]
 */
export const TT_MINUS_UTC_SECONDS = 69.184;

/**
 * worldTime (TT seconds since J2000 TT) → the UTC label of that instant, in
 * milliseconds, for the astronomy-engine bridge only. Inside the pinned era
 * (constant {@link TT_MINUS_UTC_SECONDS}) the UTC label of the TT instant
 * `J2000 TT + worldTime` is exactly the UTC label of the epoch plus the same
 * duration, so this is a pure offset — exact for integer-millisecond
 * instants (asserted in tests). The inverse of {@link worldTimeTtFromUtcMillis}.
 * Wall-clock bridge: this is the one place in the engine allowed to construct
 * a Date from a simulation instant (§4 — the adapter "converts explicitly for
 * each provider"); it never reads the real clock and never passes TT seconds
 * themselves as a UTC value (§4).
 */
export function utcMillisFromWorldTimeTt(worldTimeTtSeconds: WorldTimeTtSeconds): number {
  return J2000_TT_EPOCH_UTC_MILLIS + worldTimeTtSeconds * 1000;
}

/**
 * UTC wall-clock milliseconds → worldTime (TT seconds since J2000 TT), the
 * inverse of {@link utcMillisFromWorldTimeTt}. Used by tests and by the host
 * to anchor a persisted world epoch (the actual anchoring policy is S0.7's):
 * worldTime 0 is the J2000 TT epoch itself, whose UTC label is
 * {@link J2000_TT_EPOCH_UTC_MILLIS}.
 */
export function worldTimeTtFromUtcMillis(utcMillis: number): WorldTimeTtSeconds {
  return (utcMillis - J2000_TT_EPOCH_UTC_MILLIS) / 1000;
}

/**
 * Builds the provider's time object from the authoritative simulation instant.
 * astronomy-engine interprets a JS Date as UT and applies its own ΔT model
 * internally (§4: that model is NOT the authoritative clock — it only bridges
 * to the provider's internals; the deliberate DUT1 omission of §1 is < 0.9 s
 * of Earth rotation and is accepted, documented there).
 */
export function astroTimeFromWorldTime(worldTimeTtSeconds: WorldTimeTtSeconds): A.AstroTime {
  return A.MakeTime(new Date(utcMillisFromWorldTimeTt(worldTimeTtSeconds)));
}

// --- AU boundary (the only crossing point) ----------------------------------------

/** Converts one library AU vector to metres. Private: the AU crossing itself. */
function auVectorToMetres(v: A.Vector): Vec3 {
  return { x: v.x * AU_METRES, y: v.y * AU_METRES, z: v.z * AU_METRES };
}

// --- heliocentric (Frame.Helio, EQJ axes, metres) ----------------------------------

/**
 * Body heliocentric position, `Frame.Helio` (EQJ axes), metres, f64.
 * The AU constant is crossed exactly once, here.
 */
export function helioPositionMetres(body: A.Body, worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Helio'> {
  const v = A.HelioVector(body, astroTimeFromWorldTime(worldTimeTtSeconds));
  return { frame: 'Helio', xyz: auVectorToMetres(v) };
}

/** Earth heliocentric position, `Frame.Helio` (EQJ axes), metres. */
export function earthHelioPositionMetres(worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Helio'> {
  return helioPositionMetres(A.Body.Earth, worldTimeTtSeconds);
}

// --- geocentric (Frame.Pci(Earth), EQJ axes — translation only, §1) ----------------

/**
 * Body geometric geocentric position, `Frame.Pci(Earth)` (EQJ axes — axes are
 * parallel to `Frame.Helio` by construction, §1), metres. Aberration is off:
 * `Frame.Pci` positions are geometrical, not apparent directions.
 */
export function geoPositionMetres(body: A.Body, worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Pci(Earth)'> {
  const v = A.GeoVector(body, astroTimeFromWorldTime(worldTimeTtSeconds), false);
  return { frame: 'Pci(Earth)', xyz: auVectorToMetres(v) };
}

/**
 * The Moon's geometric geocentric position, `Frame.Pci(Earth)` (EQJ axes),
 * metres. `GeoMoon` is the library's highest-accuracy Earth–Moon vector.
 */
export function geoMoonPositionMetres(worldTimeTtSeconds: WorldTimeTtSeconds): Framed<'Pci(Earth)'> {
  const v = A.GeoMoon(astroTimeFromWorldTime(worldTimeTtSeconds));
  return { frame: 'Pci(Earth)', xyz: auVectorToMetres(v) };
}

// --- topocentric (Frame.Enu at a geodetic anchor) -----------------------------------

/**
 * Body topocentric position in the anchor's ENU triad (+x east, +y north,
 * +z up — §8), metres, f64. Path is library-rotations-only:
 * EQJ topocentric vector (library `GeoVector` − `ObserverVector`, ofdate=false,
 * both EQJ) → `Rotation_EQJ_HOR` via `RotateVector` → component mapping
 * (HOR: x north, y west, z zenith [EXTERNAL — astronomy-engine docs]) →
 * (east, north, up) = (−west, north, zenith).
 *
 * Datum note (§5): the library `Observer` takes elevation above *sea level*,
 * not ellipsoidal height. The anchor's geodetic height is passed as-is — exact
 * at h = 0 sites and direction-grade elsewhere (§10). Reconciling h vs H
 * (Laws G-1/G-2) is owned by the geodesy decision (ADR-002 Decision 6), not by
 * this adapter.
 */
export function topoEnuPositionMetres(
  body: A.Body,
  worldTimeTtSeconds: WorldTimeTtSeconds,
  anchorGeodetic: { latitudeDeg: number; longitudeDeg: number; heightMetres: number },
): Framed<'Enu(Earth)'> {
  const t = astroTimeFromWorldTime(worldTimeTtSeconds);
  const obs = new A.Observer(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg, anchorGeodetic.heightMetres);
  const geo = A.GeoVector(body, t, false);
  const obsVec = A.ObserverVector(t, obs, false);
  const topoEqj = new A.Vector(geo.x - obsVec.x, geo.y - obsVec.y, geo.z - obsVec.z, t);
  const hor = A.RotateVector(A.Rotation_EQJ_HOR(t, obs), topoEqj);
  // HOR (x north, y west, z zenith) → ENU (x east, y north, z up). Metres.
  return {
    frame: 'Enu(Earth)',
    xyz: { x: -hor.y * AU_METRES, y: hor.x * AU_METRES, z: hor.z * AU_METRES },
  };
}

/** Topocentric altitude/azimuth, degrees (human-boundary field names, Law U-2). */
export interface AltAzDeg {
  /** Altitude above the horizon, degrees, [−90, +90]. */
  altitudeDeg: number;
  /** Azimuth clockwise from north, degrees, [0, 360). */
  azimuthDeg: number;
  /** Slant range from the observer, metres. */
  rangeMetres: number;
}

/**
 * Alt/az derived from the ENU topocentric vector (radians in code, degrees at
 * the human boundary). Azimuth convention matches the library's horizon frame:
 * clockwise from north [EXTERNAL — astronomy-engine docs].
 */
export function topoAltAzDeg(enuMetres: Vec3): AltAzDeg {
  const r = Math.hypot(enuMetres.x, enuMetres.y, enuMetres.z);
  const altitudeRad = Math.asin(enuMetres.z / r);
  const azimuthRad = Math.atan2(enuMetres.x, enuMetres.y);
  return {
    altitudeDeg: (altitudeRad * 180) / Math.PI,
    azimuthDeg: ((azimuthRad * 180) / Math.PI + 360) % 360,
    rangeMetres: r,
  };
}

// --- golden-fixture seam (G-03; fixtures arrive via S0.11) ---------------------------

/**
 * Seam for G-03 (ephemeris vs the Python oracle — Skyfield/de440s + JPL
 * Horizons build-time fixtures, COORDINATE_SYSTEM.md §11): S0.11 commits the
 * fixtures and the comparison suite. Every fixture must record the pins below;
 * a fixture generated under different pins is a different fixture (§11).
 * Deliberately not wired yet — no fixture data exists in-repo.
 */
export interface GoldenFixturePins {
  readonly astronomyEngineVersion: string;
  readonly auConstantMetres: number;
  /** The pinned TT−UTC bridge value used at generation time (§4). */
  readonly ttMinusUtcSeconds: number;
}

export const GOLDEN_FIXTURE_PINS: GoldenFixturePins = {
  astronomyEngineVersion: '2.1.19',
  auConstantMetres: AU_METRES,
  ttMinusUtcSeconds: TT_MINUS_UTC_SECONDS,
};
