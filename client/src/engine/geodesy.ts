/**
 * Kwetu engine — Earth-fixed geodesy (COORDINATE_SYSTEM.md §5).
 *
 * Owns: WGS84 constants, the §5 closed-form geodetic → ECEF conversion, the
 * ECEF ↔ ENU triad, and the normal-gravity seam (ADR-002 Decision 6).
 * astronomy-engine is NOT used here — it is not an Earth-fixed survey library
 * (§5): its `Observer` takes "elevation above sea level", not ellipsoidal
 * height, and its built-in Earth constants are not WGS84. Survey positions
 * only ever come from this module.
 *
 * Frame mapping (COORDINATE_SYSTEM.md §1): `Frame.PlanetFixed(Earth)` is the
 * ITRF-like body-fixed frame — for Earth this *is* ECEF (x → 0°E/equator,
 * z → north pole), so "ECEF" here and "PlanetFixed(Earth)" in `frames.ts` are
 * the same frame; `frames.ts` supplies the frame-tagged wrappers.
 *
 * All math f64 (Law P-1). Unit law: metres and radians in code; degrees only
 * at the geodetic input boundary, in fields named `...Deg` (Laws U-1/U-2/U-3).
 */

// --- WGS84 constants -----------------------------------------------------------

/** WGS84 semi-major axis, metres. [EXTERNAL — NGA STND.0036 (formerly TR8350.2), exact] */
export const WGS84_A_METRES = 6378137.0;
/** WGS84 reciprocal flattening 1/f. [EXTERNAL — NGA STND.0036, exact] */
export const WGS84_INVF = 298.257223563;
/** WGS84 flattening f = 1 / (1/f). [derived from the exact constants above] */
export const WGS84_F = 1 / WGS84_INVF;
/** WGS84 first eccentricity squared e² = f(2−f) = 0.0066943799901413165. [derived — doc §5] */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** WGS84 semi-minor axis b = a(1−f), metres. [derived from the exact constants above] */
export const WGS84_B_METRES = WGS84_A_METRES * (1 - WGS84_F);

/**
 * Earth mean radius — the doc's §6 ladder landmark ("Earth radius (6 371 km)
 * lives here"), used by the bubble-extent gravity model (ADR-002 Decision 4),
 * never for survey positions. [EXTERNAL — COORDINATE_SYSTEM.md §6 landmark.]
 */
export const EARTH_MEAN_RADIUS_METRES = 6371000.0;

/** GM⊕, m³/s². [EXTERNAL — IERS Conventions (2010) / EGM2008] */
export const EARTH_GM_M3_PER_S2 = 3.986004418e14;

/**
 * Earth sidereal rotation rate, rad/s. Quoted by Law V-1 (a point fixed on the
 * equator has velocity ≈ 465 m/s in `Frame.Pci(Earth)`).
 * [EXTERNAL — IERS Conventions value quoted in COORDINATE_SYSTEM.md Law V-1.]
 */
export const EARTH_OMEGA_RAD_PER_S = 7.2921159e-5;

/**
 * The tangent (constant) surface gravity of COORDINATE_SYSTEM.md §8: world
 * gravity (0, 0, −g) inside a small surface bubble. [EXTERNAL — standard
 * gravity g₀ = 9.80665 m/s² (ISO 80000-3).] Its error model is measured in
 * ADR-002 evidence D: magnitude error +0.0136 m/s² (+0.14%) vs μ/R²
 * (constant choice, present at every bubble extent); direction error grows
 * with displacement — the basis of the 10 km bubble-extent bound (Decision 4).
 */
export const TANGENT_G_METRES_PER_S2 = 9.80665;

// --- geodetic → ECEF (the doc's §5 closed form) ---------------------------------

/** Geodetic coordinates: degrees at the human boundary, metres of ellipsoidal height (Law G-3). */
export interface GeodeticCoord {
  latitudeDeg: number;
  longitudeDeg: number;
  /** Ellipsoidal height above the WGS84 ellipsoid — NOT orthometric (Laws G-1/G-2). */
  heightMetres: number;
}

/** Prime vertical radius of curvature N(φ), metres. */
export function primeVerticalRadius(latitudeRad: number): number {
  const s = Math.sin(latitudeRad);
  return WGS84_A_METRES / Math.sqrt(1 - WGS84_E2 * s * s);
}

/**
 * Geodetic (φ, λ, h) → ECEF, the COORDINATE_SYSTEM.md §5 closed form, f64
 * (the *easy* direction — the doc blesses exactly this formula):
 *
 *   N = a / sqrt(1 − e²·sin²φ)
 *   X = (N + h)·cosφ·cosλ
 *   Y = (N + h)·cosφ·sinλ
 *   Z = (N·(1 − e²) + h)·sinφ
 */
export function geodeticToEcef(coord: GeodeticCoord): { x: number; y: number; z: number } {
  const phi = (coord.latitudeDeg * Math.PI) / 180;
  const lam = (coord.longitudeDeg * Math.PI) / 180;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const n = primeVerticalRadius(phi);
  return {
    x: (n + coord.heightMetres) * c * Math.cos(lam),
    y: (n + coord.heightMetres) * c * Math.sin(lam),
    z: (n * (1 - WGS84_E2) + coord.heightMetres) * s,
  };
}

// --- ECEF → geodetic (OPEN decision: ADR-002 Decision 6) -------------------------

/**
 * ECEF → geodetic.
 *
 * [PLACEHOLDER — gate: ADR-002 Decision 6 (geodesy reference implementation:
 * GeographicLib candidate vs bake-only pyproj). COORDINATE_SYSTEM.md §5: "the
 * hard direction … use the library … this doc does not bless one" closed form.
 * What lives here is the S0.1 probe's Bowring iteration, promoted verbatim so
 * the frame chain can round-trip; it is validated on the test envelope
 * (±80° lat, |h| ≤ 1e6 m, residuals asserted in tests/engine) and must be
 * replaced by the Decision 6 outcome before it touches saved player positions
 * (Law G-3) or terrain datum conversion (Law G-2).]
 */
export function ecefToGeodetic(p: { x: number; y: number; z: number }): GeodeticCoord {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  const pxy = Math.hypot(x, y);
  // Bowring's method, iterated to f64 convergence (S0.1 probe A algorithm).
  let lat = Math.atan2(z, pxy);
  let h = 0;
  for (let i = 0; i < 64; i++) {
    const s = Math.sin(lat);
    const n = primeVerticalRadius(lat);
    h = pxy / Math.cos(lat) - n;
    const next = Math.atan2(z, pxy * (1 - (WGS84_E2 * n) / (n + h)));
    if (Math.abs(next - lat) < 1e-15) {
      lat = next;
      break;
    }
    lat = next;
  }
  return {
    latitudeDeg: (lat * 180) / Math.PI,
    longitudeDeg: (Math.atan2(y, x) * 180) / Math.PI,
    heightMetres: h,
  };
}

// --- ECEF ↔ ENU (the doc's §5 formulas, copied verbatim) --------------------------

/** The ENU triad at an anchor: unit axis vectors in ECEF components. */
export interface EnuBasis {
  /** East unit axis, ECEF components. */
  east: { x: number; y: number; z: number };
  /** North unit axis, ECEF components. */
  north: { x: number; y: number; z: number };
  /** Up unit axis, ECEF components — the ellipsoid *normal*, not the geocentric radial. */
  up: { x: number; y: number; z: number };
}

/**
 * ENU basis rows at a geodetic anchor — COORDINATE_SYSTEM.md §5 verbatim:
 *
 *   E = (−sinλ,        cosλ,       0)
 *   N = (−sinφ·cosλ, −sinφ·sinλ,  cosφ)
 *   U = ( cosφ·cosλ,   cosφ·sinλ,  sinφ)
 *
 * Law: ENU is Z-up (+x east, +y north, +z up); `up` is the ellipsoid normal
 * (deflection of the vertical at the §12 site ≈ 7.9e-4 rad vs geocentric
 * radial — [MEASURED 2026-09-05]).
 */
export function enuBasis(latitudeDeg: number, longitudeDeg: number): EnuBasis {
  const phi = (latitudeDeg * Math.PI) / 180;
  const lam = (longitudeDeg * Math.PI) / 180;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  return {
    east: { x: -sl, y: cl, z: 0 },
    north: { x: -sp * cl, y: -sp * sl, z: cp },
    up: { x: cp * cl, y: cp * sl, z: sp },
  };
}

/** ECEF → ENU at an anchor: p_enu = R · (p_ecef − p_anchor), doc §5. */
export function ecefToEnu(pEcef: { x: number; y: number; z: number }, anchorGeodetic: GeodeticCoord): {
  x: number;
  y: number;
  z: number;
} {
  const anchor = geodeticToEcef(anchorGeodetic);
  const d = { x: pEcef.x - anchor.x, y: pEcef.y - anchor.y, z: pEcef.z - anchor.z };
  const b = enuBasis(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg);
  return {
    x: dotRow(b.east, d),
    y: dotRow(b.north, d),
    z: dotRow(b.up, d),
  };
}

/** ENU at an anchor → ECEF: p_ecef = p_anchor + E·x + N·y + U·z. */
export function enuToEcef(enu: { x: number; y: number; z: number }, anchorGeodetic: GeodeticCoord): {
  x: number;
  y: number;
  z: number;
} {
  const anchor = geodeticToEcef(anchorGeodetic);
  const b = enuBasis(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg);
  return {
    x: anchor.x + b.east.x * enu.x + b.north.x * enu.y + b.up.x * enu.z,
    y: anchor.y + b.east.y * enu.x + b.north.y * enu.y + b.up.y * enu.z,
    z: anchor.z + b.east.z * enu.x + b.north.z * enu.y + b.up.z * enu.z,
  };
}

function dotRow(axis: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }): number {
  return axis.x * v.x + axis.y * v.y + axis.z * v.z;
}

// --- normal gravity (the ADR-002 Decision 6 seam) ---------------------------------

/**
 * A source of normal gravity g(φ, h) in m/s². THE SEAM: the reference
 * implementation (Somigliana / GeographicLib candidate / bake-only pyproj
 * table) is an OPEN decision — ADR-002 Decision 6 and COORDINATE_SYSTEM.md
 * §5/§14. Nothing in the engine picks one today. The only sanctioned row is
 * `TANGENT_NORMAL_GRAVITY`, the §8-permitted constant approximation inside a
 * small surface bubble; its measured error model is ADR-002 evidence D.
 */
export interface NormalGravitySource {
  /** Machine-readable model name — part of saved-state diagnostics (Law G-3 spirit). */
  readonly model: string;
  /** Normal gravity at geodetic latitude φ and ellipsoidal height h, m/s². */
  at(latitudeDeg: number, heightMetres: number): number;
}

/**
 * The §8 tangent model: constant 9.80665 m/s² everywhere in the bubble.
 * Permitted by COORDINATE_SYSTEM.md §8 for *small surface bubbles* only; the
 * active contact-bubble extent bound is 1e4 m [MEASURED — ADR-002 Decision 4].
 * Powered flight uses central/body gravity in an inertial frame, never this.
 */
export const TANGENT_NORMAL_GRAVITY: NormalGravitySource = {
  model: 'constant-tangent-9.80665',
  at: () => TANGENT_G_METRES_PER_S2,
};

/**
 * Central-field gravity magnitude μ/r² at geodetic latitude/height (spherical
 * approximation at Earth mean radius) — the honest *reference* row for
 * measuring the tangent constant's error (ADR-002 evidence D), and the
 * magnitude model for the FLIGHT_DYNAMIC regime's neighbourhood checks.
 * NOT a normal-gravity decision: it has no ellipsoid, no deflection of the
 * vertical, and no rotation (apparent-gravity) term.
 */
export const SPHERICAL_CENTRAL_GRAVITY: NormalGravitySource = {
  model: 'spherical-central-6371km',
  at: (latitudeDeg, heightMetres) => {
    void latitudeDeg; // spherical model: latitude-independent by construction
    const r = EARTH_MEAN_RADIUS_METRES + heightMetres;
    return EARTH_GM_M3_PER_S2 / (r * r);
  },
};
