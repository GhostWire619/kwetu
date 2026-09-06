/**
 * Kwetu engine — the f64 Kepler / patched-conic orbital core (Phase 7/8
 * groundwork; ROADMAP phases 7-8). Pure math: renderer-independent and
 * physics-independent, with no Rapier, no frame registry and no clock. The
 * caller supplies μ and a Cartesian state in WHATEVER inertial frame it is
 * working in; every function returns states in that same frame. Nothing here
 * converts frames — the ICRF<->EQJ frame-bias alignment (needed to consume
 * ICRF-tabulated DE440s fixtures inside the EQJ engine chain, COORDINATE_SYSTEM.md
 * §1) is a rocket-phase follow-up and deliberately lives outside this module.
 *
 * Precision law (COORDINATE_SYSTEM.md Law P-1, ADR-002): every number in this
 * module is a JS number (IEEE-754 binary64). Positions and velocities are
 * engine `Vec3` (f64) end to end; there is no f32 anywhere on these paths and
 * no Rapier boundary — orbital motion is NOT a contact-bubble problem (Law
 * PH-1 owns bubbles; this module is the FLIGHT_DYNAMIC-class free-flight
 * math the bubble hands over to, per ADR-002 Decision 4).
 *
 * Honest scope (the "launch works" bar): this module is the math core only.
 * It does NOT integrate ascent, atmosphere, engines, or attitude; those are
 * later-phase owners (docs/VEHICLES_AND_FLIGHT.md). Patched conics are an
 * APPROXIMATION: each body's trajectory is one conic at a time under one
 * dominant μ, switched at SOI boundaries. The switch is state-continuous
 * (no velocity jump — see `soiHandoffToParent`) but not ACCELERATION-
 * continuous: at the crossing the model drops the weaker body's pull
 * entirely, so the real (N-body) trajectory diverges from the patched arc
 * through the neighbourhood of the boundary. ADR-001 owns the flight rules;
 * the measured SOI/bubble boundaries live in ADR-002.
 *
 * Validation (tests/engine/orbits.test.ts): f64 round trips over the
 * eccentricity/inclination envelope, Kepler's third law, hyperbolic excess
 * speed vs vis-viva, angular-momentum and energy conservation, and a
 * real-ephemeris golden fixture (tests/golden/kepler/kepler-earth.json,
 * generated from DE440s by tools/oracle/generate_kepler.py) that measures the
 * two-body reduction of Earth's actual heliocentric arc over 600 s.
 */

import {
  addV,
  cross3,
  dot3,
  norm3,
  scaleV,
  subV,
  type Vec3,
} from './vec3';

// --- GM constants (the single source for orbital dynamics) -------------------------

/**
 * GM of the Sun, m³/s². [EXTERNAL — DE440s kernel DAF header, "Mass parameter
 * (GM)" table, KM**3/SEC**2 column, read directly from
 * .bake/ephemeris/de440s.bsp on 2026-09-06: GMS = 132712440041.279419 km³/s².
 * The kernel header cites Park, Folkner, Williams & Boggs, "The JPL Planetary
 * and Lunar Ephemerides DE440 and DE441", AJ, DOI 10.3847/1538-3881/abd414.
 * Consistent with the IAU 2009 system value 1.32712440041e20 m³/s² inside its
 * quoted uncertainty (±8e10); the kernel value is used because it is what the
 * ephemeris oracle integrates.] DE440 constants are TDB-compatible; treating
 * a TT interval as TDB over a 600 s arc shifts the ephemeris argument by
 * ~9e-6 s (~0.3 mm of Earth motion) [derived — LB ~ 1.55e-8] — far under
 * every tolerance here; the time-scale decision for the rocket phase belongs
 * to COORDINATE_SYSTEM.md §4.
 */
export const GM_SUN_M3_PER_S2 = 1.32712440041279419e20;

/**
 * GM of Earth, m³/s². [EXTERNAL — DE440s kernel DAF header as above:
 * GM3 = 398600.435507 km³/s².] NOTE the deliberate difference from
 * geodesy.ts's `EARTH_GM_M3_PER_S2` (3.986004418e14, IERS Conventions
 * 2010 / EGM2008, the surface-gravity constant): the two realizations differ
 * by 1.6e-8 relative [derived], far under gameplay tolerances either way.
 * Orbital dynamics use the DE440-fitted value so that hand-computed conics
 * and the ephemeris oracle agree; survey gravity keeps its own constant.
 */
export const GM_EARTH_M3_PER_S2 = 3.98600435507e14;

/**
 * GM of the Moon, m³/s². [EXTERNAL — DE440s kernel DAF header as above:
 * GMM = 4902.800118 km³/s².]
 */
export const GM_MOON_M3_PER_S2 = 4.902800118e12;

/**
 * GM of the Earth-Moon barycenter, m³/s² — a consistency identity, not a new
 * source: GM3 + GMM from the same kernel header equals the tabulated
 * GMB = 403503.235625 km³/s² to the last printed digit [EXTERNAL — DE440s
 * kernel DAF header; equality asserted in tests]. [derived from the two above]
 */
export const GM_EMB_M3_PER_S2 = GM_EARTH_M3_PER_S2 + GM_MOON_M3_PER_S2;

// --- errors -------------------------------------------------------------------------

/** Base class for documented orbit-math failures. */
export class OrbitError extends Error {}

/** Input validation: non-finite vectors, μ ≤ 0, or a state at the origin. */
export class OrbitArgumentError extends OrbitError {}

/**
 * The universal-variable Newton solve (with bracketing fallback) did not
 * converge to its documented tolerances. Deterministic inputs reproduce this
 * deterministically; it should be unreachable for finite |dt| on non-singular
 * conics — treat an occurrence as a bug report, not a runtime condition.
 */
export class KeplerConvergenceError extends OrbitError {}

/**
 * e = 1 exactly (parabolic) or a rectilinear (h = 0) conic: the semimajor
 * axis is infinite / the orbital plane undefined, so classical elements do
 * not exist. Propagation still works for near-parabolic arcs; only the
 * elements VIEW is refused. Documented per the brief's degeneracy rule.
 */
export class ParabolicConicError extends OrbitError {}

/** elementsToState asked for a hyperbolic true anomaly beyond the asymptote. */
export class HyperbolicAsymptoteError extends OrbitError {}

/** No SOI crossing exists within the searched time window (see soiHandoffToParent). */
export class NoSoiCrossingError extends OrbitError {}

// --- basic state algebra -------------------------------------------------------------

/** A Cartesian state: position (m) and velocity (m/s) in one inertial frame. */
export interface CartesianState {
  readonly positionMetres: Vec3;
  readonly velocityMetresPerSecond: Vec3;
}

/**
 * Specific orbital energy ε = v²/2 − μ/r, J/kg (m²/s²). Negative: bound
 * (elliptic); zero: parabolic escape; positive: hyperbolic.
 */
export function specificOrbitalEnergy(mu: number, state: CartesianState): number {
  assertMu(mu);
  const r = norm3(state.positionMetres);
  if (r === 0) throw new OrbitArgumentError('specificOrbitalEnergy: state is at the origin');
  const v2 = dot3(state.velocityMetresPerSecond, state.velocityMetresPerSecond);
  return v2 / 2 - mu / r;
}

/** Specific angular momentum vector h = r × v, m²/s. Conserved on any conic. */
export function angularMomentumVector(state: CartesianState): Vec3 {
  return cross3(state.positionMetres, state.velocityMetresPerSecond);
}

/** Semimajor axis from specific energy: a = −μ/(2ε), metres (negative for hyperbolic). */
export function semimajorAxisFromEnergy(mu: number, energyJPerKg: number): number {
  assertMu(mu);
  if (energyJPerKg === 0) throw new ParabolicConicError('parabolic arc has no finite semimajor axis');
  return -mu / (2 * energyJPerKg);
}

/** Sidereal period of a closed orbit, seconds: T = 2π√(a³/μ). Throws for a ≤ 0. */
export function periodFromSemimajorAxis(mu: number, semimajorAxisMetres: number): number {
  assertMu(mu);
  if (semimajorAxisMetres <= 0) {
    throw new OrbitArgumentError(
      `periodFromSemimajorAxis needs a > 0 (closed orbit), got ${semimajorAxisMetres}`,
    );
  }
  return 2 * Math.PI * Math.sqrt((semimajorAxisMetres * semimajorAxisMetres * semimajorAxisMetres) / mu);
}

/** Hyperbolic excess speed v∞ = √(−μ/a), m/s. Throws unless a < 0. */
export function hyperbolicExcessSpeed(mu: number, semimajorAxisMetres: number): number {
  assertMu(mu);
  if (semimajorAxisMetres >= 0) {
    throw new OrbitArgumentError(
      `hyperbolicExcessSpeed needs a < 0 (hyperbolic), got ${semimajorAxisMetres}`,
    );
  }
  return Math.sqrt(-mu / semimajorAxisMetres);
}

/**
 * Laplace sphere of influence of `muBody` orbiting `muParent` on a semimajor
 * axis `orbitSemimajorAxisMetres`: r_soi = a·(μ_body/μ_parent)^(2/5), metres.
 * The classic Laplace SOI (the patched-conic handoff radius; the Hill/"exact"
 * radius differs by the (μ ratio)^(2/5) vs (1/3) exponent choice — patched
 * conic practice and KSP-style conventions use Laplace). [derived — standard
 * formula; the Earth-Moon value it produces (~66 200 km) is asserted in tests.]
 */
export function laplaceSoiRadiusMetres(
  muBody: number,
  muParent: number,
  orbitSemimajorAxisMetres: number,
): number {
  assertMu(muBody);
  assertMu(muParent);
  if (orbitSemimajorAxisMetres <= 0) {
    throw new OrbitArgumentError('laplaceSoiRadiusMetres needs a > 0 for the body-parent orbit');
  }
  return orbitSemimajorAxisMetres * Math.pow(muBody / muParent, 2 / 5);
}

// --- classical elements ----------------------------------------------------------------

/**
 * Classical (Keplerian) orbital elements. All angles radians; `a` metres
 * (negative for hyperbolic). The two `...Defined` flags are the honest
 * degeneracy bookkeeping (COORDINATE_SYSTEM.md-style: a fact is either
 * established or flagged, never silently defaulted):
 *
 *  - `raanDefined: false` — equatorial orbit (|sin i| < 1e-12): the node line
 *    is undefined. `raanRad` carries the documented CONVENTION 0, and
 *    `argpRad`/`trueAnomalyRad` are then measured from the +x axis of the
 *    reference plane (sense-flipped for retrograde planes, cos i < 0) so the
 *    round trip through `elementsToState` still reconstructs the state
 *    exactly at exact degeneracy.
 *  - `argpDefined: false` — circular orbit (e < 1e-11): the periapsis
 *    direction is undefined. `argpRad` carries the convention 0 and
 *    `trueAnomalyRad` carries the argument of latitude (from the node, or
 *    from +x when the node is also undefined). Within the band the round
 *    trip errs O(e·r) ≤ 1e-11·r [derived]; at exact e = 0 it is exact.
 *
 * Round-trip contract: `stateToElements(mu, elementsToState(mu, el)) === el`
 * (angles mod 2π, to f64 trig noise) for any explicit element set, INCLUDING
 * the degenerate ones; and `elementsToState(mu, stateToElements(mu, s))`
 * reconstructs s exactly at exact degeneracy, to within the band bounds
 * inside the bands.
 */
export interface ClassicalElements {
  /** Semimajor axis, metres; negative for hyperbolic conics. */
  semimajorAxisMetres: number;
  eccentricity: number;
  inclinationRad: number;
  /** Right ascension of the ascending node, radians (see `raanDefined`). */
  raanRad: number;
  /** Argument of periapsis, radians (see `argpDefined`). */
  argpRad: number;
  /** True anomaly, radians (argument of latitude when `argpDefined` is false). */
  trueAnomalyRad: number;
  /** False when the node line is degenerate (equatorial) and `raanRad` is the convention value. */
  raanDefined: boolean;
  /** False when the orbit is circular and `argpRad` is the convention value. */
  argpDefined: boolean;
}

/**
 * Below this eccentricity the periapsis direction is numerically undefined
 * (e_vec points into f64 noise): `stateToElements` reports the convention
 * argp and flags it. [PLACEHOLDER — gate: a rocket-phase ADR may retune this
 * to the navigation accuracy bar; it is an elements-view threshold only and
 * does not affect `propagate`.]
 */
export const ECCENTRICITY_CIRCULAR_EPS = 1e-11;

/**
 * The node line is |n| = |h|·|sin i| long; below this fraction of |h| the
 * RAAN direction is numerically undefined and the convention branch applies.
 * [derived: 1e-12 ≈ the level at which f64 noise in h_x, h_y (~1e-16 of |h|)
 * starts rotating the atan2 result by more than ~1e-4 rad.]
 */
export const NODE_DEGENERATE_EPS = 1e-12;

function assertMu(mu: number): void {
  if (!(mu > 0) || !Number.isFinite(mu)) {
    throw new OrbitArgumentError(`mu must be a positive finite GM, got ${mu}`);
  }
}

function assertFiniteState(state: CartesianState, where: string): void {
  const p = state.positionMetres;
  const v = state.velocityMetresPerSecond;
  const ok =
    Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
    Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  if (!ok) throw new OrbitArgumentError(`${where}: non-finite position/velocity component`);
}

/** Active rotation about +x (right-hand rule) — perifocal-plane construction. */
function rotateX(v: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

/** Wraps an angle into (−π, π]. */
function wrapPi(angle: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = angle % twoPi;
  return wrapped > Math.PI ? wrapped - twoPi : wrapped <= -Math.PI ? wrapped + twoPi : wrapped;
}

/** Unit vector (f64); throws on a zero vector. */
function unit(v: Vec3, what: string): Vec3 {
  const n = norm3(v);
  if (n === 0) throw new OrbitArgumentError(`${what}: zero vector has no direction`);
  return scaleV(v, 1 / n);
}

/**
 * Cartesian state → classical elements. Elliptic AND hyperbolic; see
 * {@link ClassicalElements} for the degeneracy conventions and
 * {@link ParabolicConicError} for the refused e = 1 / rectilinear case.
 */
export function stateToElements(mu: number, state: CartesianState): ClassicalElements {
  assertMu(mu);
  assertFiniteState(state, 'stateToElements');
  const r = state.positionMetres;
  const v = state.velocityMetresPerSecond;
  const rMag = norm3(r);
  if (rMag === 0) throw new OrbitArgumentError('stateToElements: state is at the origin');

  const h = cross3(r, v);
  const hMag = norm3(h);
  const v2 = dot3(v, v);
  const energy = v2 / 2 - mu / rMag;
  const a = -mu / (2 * energy);

  const rHat = scaleV(r, 1 / rMag);
  const eVec = scaleV(subV(scaleV(r, v2 - mu / rMag), scaleV(v, dot3(r, v))), 1 / mu);
  const e = norm3(eVec);
  if (Math.abs(e - 1) < 1e-12) {
    throw new ParabolicConicError(
      'stateToElements: e = 1 (parabolic or rectilinear h = 0) has no finite semimajor axis / no defined plane; propagate the state vector instead',
    );
  }

  const inclination = hMag === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, h.z / hMag)));
  const node = { x: -h.y, y: h.x, z: 0 }; // ẑ × h
  const nodeDegenerate = norm3(node) < NODE_DEGENERATE_EPS * hMag;
  const circular = e < ECCENTRICITY_CIRCULAR_EPS;
  const hHat = hMag === 0 ? { x: 0, y: 0, z: 1 } : scaleV(h, 1 / hMag);

  if (nodeDegenerate) {
    // Equatorial convention: Ω = 0; measure ω, ν from +x of the reference
    // plane, sense-flipped for retrograde planes (cos i < 0) so that the
    // standard Rz(Ω)Rx(i)Rz(ω) reconstruction maps them back exactly.
    const s = h.z >= 0 ? 1 : -1;
    const u = Math.atan2(s * r.y, r.x);
    const argp = circular ? 0 : wrapPi(Math.atan2(s * eVec.y, eVec.x));
    return {
      semimajorAxisMetres: a,
      eccentricity: e,
      inclinationRad: inclination,
      raanRad: 0,
      argpRad: argp,
      trueAnomalyRad: wrapPi(u - argp),
      raanDefined: false,
      argpDefined: !circular,
    };
  }

  const raan = Math.atan2(h.x, -h.y); // atan2(n_y, n_x), n = ẑ × h
  const nodeHat = unit(node, 'node line');
  const alongNode = cross3(hHat, nodeHat); // in-plane, prograde, ⊥ node
  const rAlong = norm3(r);
  const rHatL = scaleV(r, 1 / rAlong);

  if (circular) {
    // Inclined circular convention: ω = 0, ν = argument of latitude (node → r).
    const argLat = Math.atan2(dot3(alongNode, rHatL), dot3(nodeHat, rHatL));
    return {
      semimajorAxisMetres: a,
      eccentricity: e,
      inclinationRad: inclination,
      raanRad: raan,
      argpRad: 0,
      trueAnomalyRad: wrapPi(argLat),
      raanDefined: true,
      argpDefined: false,
    };
  }

  const eHat = scaleV(eVec, 1 / e);
  const argp = Math.atan2(dot3(alongNode, eHat), dot3(nodeHat, eHat));
  const nu = Math.atan2(dot3(cross3(eHat, rHatL), hHat), dot3(eHat, rHatL));
  return {
    semimajorAxisMetres: a,
    eccentricity: e,
    inclinationRad: inclination,
    raanRad: raan,
    argpRad: wrapPi(argp),
    trueAnomalyRad: wrapPi(nu),
    raanDefined: true,
    argpDefined: true,
  };
}

/**
 * Classical elements → Cartesian state (the inverse view of
 * {@link stateToElements}; see the round-trip contract there). The angles are
 * interpreted literally under the standard perifocal construction
 * R = Rz(Ω)·Rx(i)·Rz(ω) — the `...Defined` flags are diagnostics of
 * `stateToElements` output and are not read here, which is exactly why the
 * convention angles close the round trip.
 *
 * Throws:
 *  - {@link OrbitArgumentError}: μ invalid, a·(1−e²) ≤ 0 (inconsistent
 *    a/e — e.g. a positive a with e > 1 gives a negative p), or a
 *    hyperbolic ν beyond the asymptote (1 + e·cos ν ≤ 0, no such point).
 */
export function elementsToState(mu: number, el: ClassicalElements): CartesianState {
  assertMu(mu);
  const { semimajorAxisMetres: a, eccentricity: e } = el;
  if (!Number.isFinite(a) || !Number.isFinite(e) || e < 0) {
    throw new OrbitArgumentError(`elementsToState: invalid a=${a} e=${e}`);
  }
  const p = a * (1 - e * e);
  if (p <= 0) {
    throw new OrbitArgumentError(
      `elementsToState: semilatus rectum p = a(1−e²) = ${p} ≤ 0 — inconsistent a/e pair`,
    );
  }
  const cosNu = Math.cos(el.trueAnomalyRad);
  // The asymptote test must run on the DENOMINATOR, not on the quotient: at
  // 1 + e·cos ν = 0 exactly the quotient is +Infinity (not ≤ 0), which would
  // sail past a radius-only guard and return an infinite state [MEASURED
  // 2026-09-06 — the exact-asymptote test caught exactly that].
  const oneECosNu = 1 + e * cosNu;
  if (oneECosNu <= 0) {
    throw new HyperbolicAsymptoteError(
      `elementsToState: true anomaly ${el.trueAnomalyRad} is beyond the hyperbolic asymptote (1 + e·cos ν = ${oneECosNu} ≤ 0)`,
    );
  }
  const rMag = p / oneECosNu;
  const sq = Math.sqrt(mu / p);
  const rPf: Vec3 = { x: rMag * cosNu, y: rMag * Math.sin(el.trueAnomalyRad), z: 0 };
  const vPf: Vec3 = { x: -sq * Math.sin(el.trueAnomalyRad), y: sq * (e + cosNu), z: 0 };
  // R = Rz(Ω)·Rx(i)·Rz(ω): in-plane rotation first, then the plane tilt, then the node.
  const r1 = rotateZPf(rPf, el.argpRad);
  const v1 = rotateZPf(vPf, el.argpRad);
  const r2 = rotateX(r1, el.inclinationRad);
  const v2 = rotateX(v1, el.inclinationRad);
  const r3 = rotateZPf(r2, el.raanRad);
  const v3 = rotateZPf(v2, el.raanRad);
  return { positionMetres: r3, velocityMetresPerSecond: v3 };
}

function rotateZPf(v: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

// --- universal-variable Kepler propagation --------------------------------------------

/**
 * Stumpff C(z): C = (1 − cos√z)/z (z > 0), (cosh√(−z) − 1)/(−z) (z < 0),
 * 1/2 at z = 0; series branch for |z| < 1e-2. The series exists because the
 * closed form's (1 − cos) cancellation loses absolute digits as z → 0
 * (floor ~2·eps/z ≈ 4e-14 at the 1e-2 seam [derived]); below the seam the
 * series is accurate to ~1e-19. At the seam itself the two branches agree
 * only to the CLOSED FORM's floor, no better [asserted in tests].
 */
export function stumpffC(z: number): number {
  if (z > 1e-2) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  }
  if (z < -1e-2) {
    const s = Math.sqrt(-z);
    return (Math.cosh(s) - 1) / -z;
  }
  // Σ (−z)^k/(2k+2)!: 1/2 − z/24 + z²/720 − z³/40320 + z⁴/3628800
  return (
    0.5 -
    z / 24 +
    (z * z) / 720 -
    (z * z * z) / 40320 +
    (z * z * z * z) / 3628800
  );
}

/**
 * Stumpff S(z): S = (√z − sin√z)/z^1.5 (z > 0), (sinh√(−z) − √(−z))/(−z)^1.5
 * (z < 0), 1/6 at z = 0; series branch for |z| < 1e-2. Same seam reasoning
 * as {@link stumpffC}: the closed form's (s − sin s) cancellation has floor
 * ~eps(s)/s³ ≈ 1.4e-14 at the 1e-2 seam [derived]; the series branch is
 * accurate to ~1e-19 below it. Seam agreement is limited by the closed
 * form's floor, no better [asserted in tests].
 */
export function stumpffS(z: number): number {
  if (z > 1e-2) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-2) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  // Σ (−z)^k/(2k+3)!: 1/6 − z/120 + z²/5040 − z³/362880 + z⁴/39916800
  return (
    1 / 6 -
    z / 120 +
    (z * z) / 5040 -
    (z * z * z) / 362880 +
    (z * z * z * z) / 39916800
  );
}

/**
 * Kepler propagation of a two-body state by `dtSeconds` (negative = backward
 * in time), universal variables with Stumpff functions — valid for elliptic,
 * parabolic-class and hyperbolic arcs alike, circular orbits included
 * (no singularity at e = 0). Returns the state at t0 + dt in the SAME frame
 * and units as the input (m, m/s).
 *
 * Method: solve F(χ) = (r0·v_r0/√μ)χ²C(z) + (1 − α r0)χ³S(z) + r0χ − √μ·dt = 0
 * for the universal anomaly χ (z = αχ², α = 2/r0 − v0²/μ = 1/a). dF/dχ = r(χ) > 0
 * always [derived: dχ/dt = √μ/r], so F is strictly monotone and the root is
 * unique: Newton with the r(χ) slope from the standard conic-class initial
 * guess; if Newton stalls, a deterministic expanding bracket + bisection to
 * full f64 resolution, then a Newton polish to the residual's noise floor.
 * The fallback is NOT hypothetical: on long hyperbolic arcs the closed-form
 * initial guess (clamped per the note below) lands in the exp-dominated
 * Stumpff region where Newton stalls immediately (F(guess) ~ 1e54 on a
 * 20-day Earth-escape arc [MEASURED 2026-09-06, the conservation suite]) and
 * the bracket+polish owns the root — its precision is what the hyperbolic
 * conservation tests measure.
 *
 * Envelope note: for very deep hyperbolic arcs the hyperbolic Stumpff branch
 * evaluates cosh/sinh at √(−z) = √|α|·χ; beyond ~700 that overflows f64 and
 * the solve throws {@link KeplerConvergenceError} rather than returning
 * garbage. Precision on such arcs is validated in tests to the radii the
 * game's patched-conic handoffs actually use.
 */
export function propagate(mu: number, state0: CartesianState, dtSeconds: number): CartesianState {
  assertMu(mu);
  assertFiniteState(state0, 'propagate');
  if (!Number.isFinite(dtSeconds)) throw new OrbitArgumentError(`propagate: non-finite dt ${dtSeconds}`);
  if (dtSeconds === 0) {
    return {
      positionMetres: { ...state0.positionMetres },
      velocityMetresPerSecond: { ...state0.velocityMetresPerSecond },
    };
  }

  const r0Vec = state0.positionMetres;
  const v0Vec = state0.velocityMetresPerSecond;
  const r0 = norm3(r0Vec);
  if (r0 === 0) throw new OrbitArgumentError('propagate: state is at the origin');
  const v0 = norm3(v0Vec);
  const rdotv = dot3(r0Vec, v0Vec);
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0 - (v0 * v0) / mu; // = 1/a (elliptic > 0, hyperbolic < 0)

  // F(χ) and its slope r(χ), sharing one Stumpff evaluation.
  const residual = (chi: number): { f: number; slope: number } => {
    const z = alpha * chi * chi;
    const c = stumpffC(z);
    const s = stumpffS(z);
    const f = (rdotv / sqrtMu) * chi * chi * c + (1 - alpha * r0) * chi * chi * chi * s + r0 * chi - sqrtMu * dtSeconds;
    // dF/dχ = r(χ): χ²C + (r0 v_r0/√μ)χ(1 − zS) + r0(1 − zC)
    const slope =
      chi * chi * c +
      (rdotv / sqrtMu) * chi * (1 - z * s) +
      r0 * (1 - z * c);
    return { f, slope };
  };

  // Initial guess per conic class (standard; quality only affects speed —
  // the bracket fallback owns correctness). The hyperbolic guess is clamped
  // so |z| = |α|χ² ≤ 1e4: the closed-form guess grows like |dt| and reaches
  // the cosh/sinh overflow region (|z| > ~5e5) for long arcs, where the
  // residual is not evaluable. The clamp keeps every Newton iterate finite;
  // the root's own |z| is far smaller (z* = αχ*² with χ* ~ √|a|·O(1…e·sinh)).
  const HYPERBOLIC_GUESS_Z_MAX = 1e4;
  let chi: number;
  if (alpha > 0) {
    chi = sqrtMu * alpha * dtSeconds;
  } else if (alpha < 0) {
    const zMaxChi = Math.sqrt(HYPERBOLIC_GUESS_Z_MAX / -alpha);
    chi = Math.sign(dtSeconds) * Math.min(sqrtMu * Math.sqrt(-alpha) * Math.abs(dtSeconds), zMaxChi);
  } else {
    chi = sqrtMu * dtSeconds / (2 * r0);
  }

  // Newton phase (deterministic; slope = r(χ) > 0 on the whole line). The
  // iterate is driven to the f64 noise floor of the residual, not merely to a
  // relative-χ tolerance: the early exit is at 1e-14·|χ|, and beyond that the
  // loop runs until the step stops shrinking — stagnation is exactly where
  // Newton hits F's own rounding noise (|δχ| ~ noise(F)/r) — keeping the
  // iterate with the smallest |F|. Stopping looser measurably degrades the
  // full-period round trip: a 1e-12-class relative stop leaves δχ ~ 3e-5 at
  // χ ≈ 2.8e7 (one Earth-size period), which scatters the returned position
  // by ~1e-6 m at a = 2e7 m [MEASURED 2026-09-06, the round-trip suite] — the
  // brief's own bound. Min-|F| selection is deterministic (same inputs, same
  // iterate), so the solver stays reproducible.
  let converged = false;
  let bestChi = chi;
  let bestAbsF = Number.POSITIVE_INFINITY;
  let prevStep = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 100; i++) {
    const { f, slope } = residual(chi);
    if (!Number.isFinite(f) || !Number.isFinite(slope) || slope <= 0) break;
    const absF = Math.abs(f);
    if (absF < bestAbsF) {
      bestAbsF = absF;
      bestChi = chi;
    }
    const step = f / slope;
    chi -= step;
    const absStep = Math.abs(step);
    if (absStep <= 1e-14 * Math.max(1, Math.abs(chi))) {
      converged = true;
      break;
    }
    if (absStep >= prevStep) break; // stagnated at the residual's noise floor
    prevStep = absStep;
  }
  if (!converged) chi = bestChi;

  if (!converged) {
    // Bracketing fallback: F(0) = −√μ·dt, so the root lies at sign(dt) side.
    const dir = Math.sign(dtSeconds);
    let lo = 0;
    let hi = dir * Math.max(Math.abs(chi), 1);
    let fHi = residual(hi).f;
    let guard = 0;
    while (dir * fHi < 0 && guard < 1024) {
      hi *= 2;
      const r = residual(hi);
      if (!Number.isFinite(r.f)) break;
      fHi = r.f;
      guard++;
    }
    if (dir * fHi >= 0) {
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        const fMid = residual(mid).f;
        if (dir * fMid < 0) lo = mid;
        else hi = mid;
        // Full f64 resolution of the bracket, not a looser relative stop: on
        // long hyperbolic arcs this path IS the solve, and δχ here maps
        // directly into state error (a 1e-12·|hi| stop leaves δχ ~ hi·5e-13,
        // which measured 6.9e-11 relative h drift over a 20-day escape arc —
        // [MEASURED 2026-09-06, fixed by this resolution + the polish below]).
        if (hi - lo <= Number.EPSILON * Math.abs(hi)) break;
      }
      chi = (lo + hi) / 2;
      // Newton polish from the bisected χ: the bisection's χ is within
      // ulp(χ) of the root, and from there a stagnation-stopped Newton (the
      // same min-|F| rule as the main phase) drives the residual to its own
      // rounding noise floor, recovering the accuracy of a Newton-healthy
      // solve. From a near-root start the steps are ~noise/slope — they
      // cannot leave the bracket's neighbourhood.
      let polishChi = chi;
      let polishBestF = Math.abs(residual(chi).f);
      let polishPrevStep = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60; i++) {
        const { f: fPolish, slope: slopePolish } = residual(chi);
        if (!Number.isFinite(fPolish) || !Number.isFinite(slopePolish) || slopePolish <= 0) break;
        const step = fPolish / slopePolish;
        chi -= step;
        const absStep = Math.abs(step);
        if (!Number.isFinite(absStep)) break;
        const fAfter = residual(chi).f;
        if (Number.isFinite(fAfter)) {
          const absFAfter = Math.abs(fAfter);
          if (absFAfter < polishBestF) {
            polishBestF = absFAfter;
            polishChi = chi;
          }
        }
        if (absStep >= polishPrevStep) break;
        polishPrevStep = absStep;
      }
      chi = polishChi;
      converged = true;
    }
    if (!converged) {
      throw new KeplerConvergenceError(
        `propagate: universal-variable solve did not converge (dt=${dtSeconds}s, alpha=${alpha})`,
      );
    }
  }

  const z = alpha * chi * chi;
  const c = stumpffC(z);
  const s = stumpffS(z);
  const f = 1 - (chi * chi * c) / r0;
  const g = dtSeconds - (chi * chi * chi * s) / sqrtMu;
  const rVec = addV(scaleV(r0Vec, f), scaleV(v0Vec, g));
  const rMag = norm3(rVec);
  if (rMag === 0) {
    throw new KeplerConvergenceError('propagate: trajectory reached the origin (collision conic)');
  }
  const fdot = (sqrtMu / (r0 * rMag)) * chi * (z * s - 1);
  const gdot = 1 - (chi * chi * c) / rMag;
  const vVec = addV(scaleV(r0Vec, fdot), scaleV(v0Vec, gdot));

  // Lagrange identity f·ḡ − ḟ·g = 1 — a cheap whole-formulation invariant.
  const identity = f * gdot - fdot * g;
  if (Math.abs(identity - 1) > 1e-9) {
    throw new KeplerConvergenceError(
      `propagate: Lagrange identity violated (f·ḡ − ḟ·g − 1 = ${identity - 1}) — universal-variable solve failed`,
    );
  }
  return { positionMetres: rVec, velocityMetresPerSecond: vVec };
}

// --- patched-conic SOI handoff ----------------------------------------------------------

/** Parameters for {@link soiHandoffToParent}. */
export interface SoiHandoffParams {
  /** GM of the body the craft currently orbits (A), m³/s². */
  muA: number;
  /** GM of the parent body (B) that owns the SOI being entered, m³/s². */
  muB: number;
  /** Craft state relative to A at the epoch. */
  craftRelA: CartesianState;
  /**
   * A's state relative to B at the SAME epoch — the approach geometry.
   * Propagated as the exact mutual two-body conic under `muA + muB` (see
   * {@link soiHandoffToParent}).
   */
  primaryARelB: CartesianState;
  /** SOI radius of B, metres (e.g. `laplaceSoiRadiusMetres`). */
  soiRadiusB: number;
}

/** Result of {@link soiHandoffToParent}. */
export interface SoiHandoffResult {
  /** Epoch-to-crossing interval, seconds (> 0). */
  crossingTimeSeconds: number;
  /** Craft state relative to B at the crossing — the handoff state. */
  stateRelB: CartesianState;
  /** Craft state relative to A at the crossing (verification / logging). */
  stateRelA: CartesianState;
  /** A's state relative to B at the crossing. */
  primaryARelB: CartesianState;
  /**
   * The patched-conic discontinuity, made explicit: |a_B − a_A| at the
   * crossing, where a_A = μ_A·(r̂ toward A)/r_A² and a_B = μ_B·r̂/r_B² are the
   * two central fields the model swaps between. This is the magnitude of the
   * acceleration error the patched-conic approximation commits at the
   * boundary by dropping the weaker body's pull — state-continuity has no
   * such jump (the handoff Δv is identically 0 by construction).
   */
  accelerationDiscontinuityMetresPerS2: number;
}

/**
 * Patched-conic SOI-ENTRY handoff: the craft is referred to body A on an
 * A-conic (its previous primary — e.g. a heliocentric cruise arc) and
 * approaches body B; this finds the first instant the craft's B-centric
 * distance reaches `soiRadiusB` (B's Laplace SOI radius,
 * `laplaceSoiRadiusMetres`) and re-expresses the craft state relative to B
 * there. The craft's A-conic must remain a valid model of its motion up to
 * the crossing (A's field dominant on that arc — the cruise leg of an
 * approach).
 *
 * Pure vector algebra at the crossing: r_c/B = r_c/A + r_A/B and
 * v_c/B = v_c/A + v_A/B (`primaryARelB` is A's B-centric state). There is NO
 * velocity jump — the handoff is a frame change, not a maneuver; the returned
 * states satisfy stateRelB = stateRelA ⊕ primaryARelB exactly (bitwise, by
 * construction, asserted in tests). What jumps is the ACCELERATION (see
 * {@link SoiHandoffResult.accelerationDiscontinuityMetresPerS2}): before the
 * boundary the model integrates only A's pull on the craft, after it only
 * B's — that is the patched-conic approximation itself (the conic-to-conic
 * discontinuity; ADR-001 owns the flight rules), and the reason patched-conic
 * arrival states are approximate even though the handoff arithmetic is exact.
 *
 * Model inside the search (the patched-conic assumption, stated): the craft
 * is propagated under μ_A alone; the A↔B relative geometry is propagated as
 * the EXACT mutual two-body conic under μ_A + μ_B — the relative motion of
 * two bodies is a conic with the sum of their GMs (the same law that gives
 * the Moon its geocentric arc). The escape-side mirror (a craft leaving A's
 * SOI into B's regime, crossing at |r_c/A| = R_soi) is a separate need for
 * the rocket phase and deliberately not folded into this entry helper.
 *
 * Search: the model solves |r_c/A(t) + r_A/B(t)|² = R_soi² for the first
 * sign change for t > 0 — a deterministic uniform grid scan (see the inline
 * comment for the step/horizon reasoning) followed by bisection to ~1e-9·t s.
 * Throws:
 *  - {@link OrbitArgumentError}: invalid μ, non-positive SOI radius, or the
 *    craft already inside (or exactly on) B's SOI at the epoch;
 *  - {@link NoSoiCrossingError}: no boundary crossing within the searched
 *    window (4 characteristic times of the approach geometry) — the
 *    trajectory does not reach the SOI;
 *  - {@link KeplerConvergenceError}: a conic solve failed (see `propagate`).
 */
export function soiHandoffToParent(params: SoiHandoffParams): SoiHandoffResult {
  const { muA, muB, craftRelA, primaryARelB, soiRadiusB } = params;
  assertMu(muA);
  assertMu(muB);
  if (!(soiRadiusB > 0) || !Number.isFinite(soiRadiusB)) {
    throw new OrbitArgumentError(`soiHandoffToParent: soiRadiusB must be positive, got ${soiRadiusB}`);
  }
  assertFiniteState(craftRelA, 'soiHandoffToParent(craftRelA)');
  assertFiniteState(primaryARelB, 'soiHandoffToParent(primaryARelB)');

  // The A<->B relative geometry is the exact mutual two-body conic under
  // muA + muB (the relative motion of two bodies is a conic with the SUM of
  // their GMs — the same law that gives the Moon its geocentric arc), not a
  // test-particle conic under muB alone.
  const muSum = muA + muB;

  /**
   * Squared miss against B's SOI sphere: f(t) = |r_craft/B(t)|² − R_soi².
   * r_craft/B = r_craft/A + r_A/B — the craft's A-relative state PLUS A's
   * B-centric state (`primaryARelB` is A's state relative to B; the sign here
   * and in the composition below is the same plus, which is the whole
   * consistency contract of the handoff).
   */
  const missSquared = (t: number): number => {
    const craft = propagate(muA, craftRelA, t);
    const primary = propagate(muSum, primaryARelB, t);
    const d = addV(craft.positionMetres, primary.positionMetres);
    return dot3(d, d) - soiRadiusB * soiRadiusB;
  };

  const f0 = missSquared(0);
  if (f0 <= 0) {
    throw new OrbitArgumentError(
      'soiHandoffToParent: the craft is already inside (or on) B\'s SOI at the epoch — a handoff has nothing to find; pass an earlier epoch',
    );
  }

  // The craft's initial B-centric state (the same plus as in missSquared).
  const craftB0: CartesianState = {
    positionMetres: addV(craftRelA.positionMetres, primaryARelB.positionMetres),
    velocityMetresPerSecond: addV(craftRelA.velocityMetresPerSecond, primaryARelB.velocityMetresPerSecond),
  };
  const relSep = norm3(craftB0.positionMetres);
  const relSpeed = norm3(craftB0.velocityMetresPerSecond);

  // Characteristic time of the approach geometry: one period of the mutual
  // A<->B conic when bound, else the crossing time of the current separation
  // at the current relative speed.
  let step: number;
  const energyA = specificOrbitalEnergy(muSum, primaryARelB);
  if (energyA < 0) {
    step = periodFromSemimajorAxis(muSum, semimajorAxisFromEnergy(muSum, energyA));
  } else {
    step = relSep / Math.max(relSpeed, 1e-9);
  }

  // Fine deterministic scan for the FIRST entry (f > 0 outside, ≤ 0 inside).
  // A doubling ladder can step clean over an SOI transit: an interplanetary
  // approach crosses the SOI inside a ~2·R_soi/v_rel window (~1e5 s) that is
  // narrower than the characteristic time by orders of magnitude. The search
  // therefore walks a uniform grid of step/1024 s up to 4·step (4096 samples;
  // worst case ~8e3 propagates ≈ tens of ms) and brackets the first sign
  // change. A transit at the epoch's relative speed spans ≥ ~250 grid samples
  // (window/step = 2048·R_soi/(v_rel·step) ≥ 250 for any sane approach), so a
  // genuine first entry is not skipped; a trajectory that reaches B's SOI
  // later than 4 characteristic times throws {@link NoSoiCrossingError}.
  const gridStep = step / 1024;
  let lo = 0;
  let hi = -1;
  {
    let tPrev = 0;
    let t = gridStep;
    for (let i = 0; i < 4096; i++) {
      if (missSquared(t) <= 0) {
        lo = tPrev;
        hi = t;
        break;
      }
      tPrev = t;
      t += gridStep;
    }
  }
  if (hi < 0) {
    throw new NoSoiCrossingError(
      `soiHandoffToParent: no SOI entry within ${4 * step}s of propagation on a ${gridStep}s grid — the craft's A-conic does not reach B's SOI`,
    );
  }

  // Bisection to f64 resolution of the crossing time (unconditionally
  // convergent, deterministic; the bracket is one grid step wide, so ~25
  // iterations reach the 1e-9·max(1, hi) s stop).
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (missSquared(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-9 * Math.max(1, hi)) break;
  }
  const tCross = (lo + hi) / 2;

  const craftA = propagate(muA, craftRelA, tCross);
  const primaryB = propagate(muSum, primaryARelB, tCross);
  const stateRelB: CartesianState = {
    positionMetres: addV(craftA.positionMetres, primaryB.positionMetres),
    velocityMetresPerSecond: addV(craftA.velocityMetresPerSecond, primaryB.velocityMetresPerSecond),
  };

  // The two central fields at the crossing (the model's before/after pair).
  const rToA = subV(primaryB.positionMetres, stateRelB.positionMetres); // craft → A
  const rToB = scaleV(stateRelB.positionMetres, -1); // craft → B
  const rATo = unit(rToA, 'craft→A direction');
  const rBTo = unit(rToB, 'craft→B direction');
  const aA = scaleV(rATo, muA / Math.max(dot3(rToA, rToA), 1e-9));
  const aB = scaleV(rBTo, muB / Math.max(dot3(rToB, rToB), 1e-9));

  return {
    crossingTimeSeconds: tCross,
    stateRelB,
    stateRelA: craftA,
    primaryARelB: primaryB,
    accelerationDiscontinuityMetresPerS2: norm3(subV(aB, aA)),
  };
}
