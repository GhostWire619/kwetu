/**
 * Engine Kepler/patched-conic core tests (orbits.ts; Phase 7/8 groundwork).
 *
 * Everything here is deterministic: fixed literals, fixed step counts, no
 * Math.random, no timing. The golden-ephemeris section consumes the committed
 * fixture tests/golden/kepler/kepler-earth.json (schema kwetu.golden.kepler/1,
 * generated from DE440s by tools/oracle/generate_kepler.py) and derives its
 * tolerance from data recorded IN the fixture (jerk, perturbation
 * acceleration) — nothing is hardcoded that pretends to be measured.
 *
 * Tolerance derivations are stated inline where each is asserted:
 *  - full-period round trips: two solves whose χ roots and f/g
 *    reconstructions each accumulate O(10²–10³) f64 roundings at position
 *    magnitude — an O(1e-6) m class at a = 2e7 m (ulp(r) ~ 1e-9 m), with no
 *    systematic removable term ([MEASURED 2026-09-06]: n-splitting does not
 *    shrink the error — it is per-solve rounding, not truncation; relaxing
 *    the χ-solve stop to stagnation-only changes nothing). The 5e-6 m bound
 *    is that derived class with margin and ~7 orders below gameplay scale.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GM_EARTH_M3_PER_S2,
  GM_EMB_M3_PER_S2,
  GM_MOON_M3_PER_S2,
  GM_SUN_M3_PER_S2,
  ECCENTRICITY_CIRCULAR_EPS,
  HyperbolicAsymptoteError,
  KeplerConvergenceError,
  NoSoiCrossingError,
  OrbitArgumentError,
  ParabolicConicError,
  type CartesianState,
  type ClassicalElements,
  angularMomentumVector,
  elementsToState,
  hyperbolicExcessSpeed,
  laplaceSoiRadiusMetres,
  periodFromSemimajorAxis,
  propagate,
  semimajorAxisFromEnergy,
  soiHandoffToParent,
  specificOrbitalEnergy,
  stateToElements,
  stumpffC,
  stumpffS,
} from '../../client/src/engine/orbits';
import { EARTH_GM_M3_PER_S2 } from '../../client/src/engine/geodesy';
import { angleBetweenRadians, dot3, norm3, scaleV, subV, vec3 } from '../../client/src/engine/vec3';

// --- shared helpers -----------------------------------------------------------------

const state = (r: ReturnType<typeof vec3>, v: ReturnType<typeof vec3>): CartesianState => ({
  positionMetres: r,
  velocityMetresPerSecond: v,
});

/** Distance between two states' positions. */
function positionError(a: CartesianState, b: CartesianState): number {
  return norm3(subV(a.positionMetres, b.positionMetres));
}

/** Builds a state from elements around Earth (the round-trip workhorse). */
function earthElements(a: number, e: number, inc: number, raan: number, argp: number, nu: number): CartesianState {
  return elementsToState(GM_EARTH_M3_PER_S2, {
    semimajorAxisMetres: a,
    eccentricity: e,
    inclinationRad: inc,
    raanRad: raan,
    argpRad: argp,
    trueAnomalyRad: nu,
    raanDefined: true,
    argpDefined: true,
  });
}

/** Angle difference mod 2π, in (−π, π]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

// --- GM constants (verified against the kernel header this module cites) -------------

describe('engine/orbits — GM constants (single source, kernel-header pinned)', () => {
  it('carries the exact DE440s DAF-header values converted to SI', () => {
    // Read directly from .bake/ephemeris/de440s.bsp on 2026-09-06 (the
    // "Mass Parameter (GM)" table, KM**3/SEC**2 column):
    //   GMS 132712440041.279419, GM3 398600.435507, GMM 4902.800118,
    //   GMB 403503.235625. km³/s² → m³/s² is ×1e9 exactly.
    expect(GM_SUN_M3_PER_S2).toBe(132712440041.279419 * 1e9); // [EXTERNAL — DE440s kernel header]
    expect(GM_EARTH_M3_PER_S2).toBe(398600.435507 * 1e9);
    expect(GM_MOON_M3_PER_S2).toBe(4902.800118 * 1e9);
  });

  it('the Earth-Moon-barycenter identity closes to the kernel’s own GMB', () => {
    // GM3 + GMM = 403503.235625 km³/s² = GMB, exact to the last printed digit.
    expect(GM_EMB_M3_PER_S2).toBe(403503.235625 * 1e9);
  });

  it('differs from the geodesy surface-gravity constant by the documented 1.6e-8 relative', () => {
    const rel = Math.abs(GM_EARTH_M3_PER_S2 - EARTH_GM_M3_PER_S2) / EARTH_GM_M3_PER_S2;
    expect(rel).toBeGreaterThan(1.5e-8);
    expect(rel).toBeLessThan(1.7e-8); // [MEASURED 2026-09-06: 1.579e-8]
  });

  it('produces the textbook Laplace SOI radii', () => {
    // Earth around the Sun: a·(μ⊕/μ☉)^0.4 with a = 1.496e11 m → ~9.25e8 m
    // (the cited 924,000–929,000 km class). Moon around Earth: ~66,200 km.
    const moonSemimajor = 3.84379e8; // [EXTERNAL — mean semimajor axis]
    const soiEarth = laplaceSoiRadiusMetres(GM_EARTH_M3_PER_S2, GM_SUN_M3_PER_S2, 1.496e11);
    const soiMoon = laplaceSoiRadiusMetres(GM_MOON_M3_PER_S2, GM_EARTH_M3_PER_S2, moonSemimajor);
    expect(soiEarth).toBeGreaterThan(9.2e8);
    expect(soiEarth).toBeLessThan(9.3e8); // [MEASURED 9.253e8 with the a above]
    expect(soiMoon).toBeGreaterThan(6.6e7);
    expect(soiMoon).toBeLessThan(6.65e7); // [MEASURED 6.618e7]
  });
});

// --- Stumpff functions ---------------------------------------------------------------

describe('engine/orbits — Stumpff functions (C, S)', () => {
  it('matches the closed forms away from the series branch', () => {
    expect(stumpffC(1)).toBe((1 - Math.cos(1)) / 1);
    expect(stumpffS(1)).toBe(1 - Math.sin(1)); // (√1 − sin 1)/1
    expect(stumpffC(-1)).toBe((Math.cosh(1) - 1) / 1);
    expect(stumpffS(-1)).toBe(Math.sinh(1) - 1);
  });

  it('has the exact z=0 values C=1/2, S=1/6', () => {
    expect(stumpffC(0)).toBe(0.5);
    expect(stumpffS(0)).toBe(1 / 6);
  });

  it('both branches agree at the ±1e-2 series seam to the closed form’s cancellation floor', () => {
    // The SERIES is accurate to ~1e-19 here; the closed form is not — its
    // (1 − cos s) / (s − sin s) subtractions lose absolute digits near z = 0,
    // with floors ~2·eps/z ≈ 4.4e-14 (C) and ~eps(s)/s³ ≈ 1.4e-14 (S) at
    // s = 0.1 [derived]. That floor is exactly why the series branch exists,
    // so seam agreement is asserted against it, not against the series
    // truncation. [MEASURED 2026-09-06: ΔC = 5.7e-15, ΔS = 6.9e-15 at +1e-2.]
    for (const z of [1e-2, -1e-2]) {
      const s = Math.sqrt(Math.abs(z));
      const closedC =
        z > 0 ? (1 - Math.cos(s)) / z : (Math.cosh(s) - 1) / -z;
      const closedS =
        z > 0 ? (s - Math.sin(s)) / (s * s * s) : (Math.sinh(s) - s) / (s * s * s);
      expect(Math.abs(stumpffC(z) - closedC)).toBeLessThan(1e-13);
      expect(Math.abs(stumpffS(z) - closedS)).toBeLessThan(1e-13);
    }
  });
});

// --- classical elements ----------------------------------------------------------------

describe('engine/orbits — classical elements round trips (explicit sets)', () => {
  const sets: ClassicalElements[] = [
    { semimajorAxisMetres: 2e7, eccentricity: 0.2, inclinationRad: 0.9, raanRad: 1.1, argpRad: 0.4, trueAnomalyRad: 2.0, raanDefined: true, argpDefined: true },
    { semimajorAxisMetres: -4e7, eccentricity: 1.8, inclinationRad: 0.5, raanRad: -0.7, argpRad: 2.2, trueAnomalyRad: 0.9, raanDefined: true, argpDefined: true }, // hyperbolic
    { semimajorAxisMetres: 3e7, eccentricity: 0.7, inclinationRad: 2.6, raanRad: -2.0, argpRad: -1.3, trueAnomalyRad: 1.1, raanDefined: true, argpDefined: true }, // retrograde-equivalent (i > π/2, not degenerate)
  ];

  it.each(sets.map((el, i) => [el, i] as const))(
    'stateToElements inverts elementsToState exactly (set $i)',
    (el) => {
      const s = elementsToState(GM_EARTH_M3_PER_S2, el);
      const back = stateToElements(GM_EARTH_M3_PER_S2, s);
      expect(back.semimajorAxisMetres).toBeCloseTo(el.semimajorAxisMetres, -6);
      expect(back.eccentricity).toBeCloseTo(el.eccentricity, 12);
      expect(back.inclinationRad).toBeCloseTo(el.inclinationRad, 12);
      expect(angleDiff(back.raanRad, el.raanRad)).toBeCloseTo(0, 10);
      expect(angleDiff(back.argpRad, el.argpRad)).toBeCloseTo(0, 10);
      expect(angleDiff(back.trueAnomalyRad, el.trueAnomalyRad)).toBeCloseTo(0, 10);
      expect(back.raanDefined).toBe(true);
      expect(back.argpDefined).toBe(true);
    },
  );

  it('exact degeneracies round-trip the STATE exactly (equatorial pro/retrograde, circular)', () => {
    const cases: ClassicalElements[] = [
      // equatorial prograde (i = 0): node undefined
      { semimajorAxisMetres: 2.5e7, eccentricity: 0.3, inclinationRad: 0, raanRad: 0, argpRad: 0.8, trueAnomalyRad: 1.7, raanDefined: false, argpDefined: true },
      // equatorial retrograde (i = π): node undefined, sense-flipped convention
      { semimajorAxisMetres: 2.5e7, eccentricity: 0.3, inclinationRad: Math.PI, raanRad: 0, argpRad: 0.8, trueAnomalyRad: 1.7, raanDefined: false, argpDefined: true },
      // circular inclined (e = 0): periapsis undefined, ν carries argument of latitude
      { semimajorAxisMetres: 2.5e7, eccentricity: 0, inclinationRad: 0.9, raanRad: 1.1, argpRad: 0, trueAnomalyRad: 2.3, raanDefined: true, argpDefined: false },
      // circular equatorial (both degenerate)
      { semimajorAxisMetres: 2.5e7, eccentricity: 0, inclinationRad: 0, raanRad: 0, argpRad: 0, trueAnomalyRad: 2.3, raanDefined: false, argpDefined: false },
      // circular retrograde equatorial
      { semimajorAxisMetres: 2.5e7, eccentricity: 0, inclinationRad: Math.PI, raanRad: 0, argpRad: 0, trueAnomalyRad: 2.3, raanDefined: false, argpDefined: false },
    ];
    for (const el of cases) {
      const s = elementsToState(GM_EARTH_M3_PER_S2, el);
      const back = stateToElements(GM_EARTH_M3_PER_S2, s);
      const rebuilt = elementsToState(GM_EARTH_M3_PER_S2, back);
      // State reconstruction must be exact to f64 trig noise — the convention
      // angles exist precisely so the degenerate views still rebuild the state.
      expect(positionError(rebuilt, s)).toBeLessThan(1e-6);
      expect(norm3(subV(rebuilt.velocityMetresPerSecond, s.velocityMetresPerSecond))).toBeLessThan(1e-9);
      // The flags report the degeneracy honestly.
      expect(back.raanDefined).toBe(el.raanDefined);
      expect(back.argpDefined).toBe(el.argpDefined);
      // Angular momentum sense preserved (retrograde stays retrograde).
      if (el.inclinationRad === Math.PI) expect(back.inclinationRad).toBeCloseTo(Math.PI, 12);
    }
  });

  it('near-degenerate bands round-trip within the documented O(e·r) bound', () => {
    // e just below ECCENTRICITY_CIRCULAR_EPS: argp is convention-0 in the view
    // and the rebuild errs O(e·r) ≤ 1e-11·r [derived — documented band].
    const el: ClassicalElements = {
      semimajorAxisMetres: 2.5e7,
      eccentricity: 0.9 * ECCENTRICITY_CIRCULAR_EPS,
      inclinationRad: 0.9,
      raanRad: 1.1,
      argpRad: 0.8,
      trueAnomalyRad: 1.7,
      raanDefined: true,
      argpDefined: true,
    };
    const s = elementsToState(GM_EARTH_M3_PER_S2, el);
    const back = stateToElements(GM_EARTH_M3_PER_S2, s);
    expect(back.argpDefined).toBe(false); // flagged, not silently defaulted
    const rebuilt = elementsToState(GM_EARTH_M3_PER_S2, back);
    const err = positionError(rebuilt, s);
    expect(err).toBeLessThan(2 * ECCENTRICITY_CIRCULAR_EPS * 3e7); // [derived band bound]
    expect(err).toBeGreaterThan(0); // and it is NOT exact inside the band — honest
  });

  it('refuses e = 1 and rectilinear states with a documented error', () => {
    // Exactly parabolic: v = √(2μ/r).
    const r = 2e7;
    const parabolic = state(vec3(r, 0, 0), vec3(0, Math.sqrt((2 * GM_EARTH_M3_PER_S2) / r), 0));
    expect(() => stateToElements(GM_EARTH_M3_PER_S2, parabolic)).toThrow(ParabolicConicError);
    // Rectilinear (h = 0) radial fall: also refused (no defined plane).
    const radial = state(vec3(3e7, 0, 0), vec3(-1000, 0, 0));
    expect(() => stateToElements(GM_EARTH_M3_PER_S2, radial)).toThrow(ParabolicConicError);
  });

  it('elementsToState refuses inconsistent a/e and beyond-asymptote anomalies', () => {
    expect(() =>
      elementsToState(GM_EARTH_M3_PER_S2, { ...sets[0]!, eccentricity: 2, semimajorAxisMetres: 2e7 }),
    ).toThrow(OrbitArgumentError); // p = a(1−e²) < 0
    const hyp = sets[1]!;
    // The exact asymptote angle is NOT f64-representable as a throwing case:
    // cos(acos(−1/e)) reproduces −1/e only to a few ulps, so the computed
    // denominator 1 + e·cos ν rounds to ±few·2.2e-16 with an uncontrollable
    // sign. Construct ν 1e-9 rad BEYOND the asymptote instead: there
    // d(1 + e·cos ν)/dν = −e·sin ν ≈ −1.53 [derived], so the denominator is
    // ≤ −1.5e-9 — decisively negative, far outside denominator noise.
    const nuAsymptote = Math.acos(-1 / hyp.eccentricity);
    expect(() => elementsToState(GM_EARTH_M3_PER_S2, { ...hyp, trueAnomalyRad: nuAsymptote + 1e-9 })).toThrow(
      HyperbolicAsymptoteError,
    );
    // And symmetrically, 1e-9 rad INSIDE the asymptote must NOT throw: the
    // guard fires exactly when the computed denominator is ≤ 0.
    expect(() =>
      elementsToState(GM_EARTH_M3_PER_S2, { ...hyp, trueAnomalyRad: nuAsymptote - 1e-9 }),
    ).not.toThrow();
    expect(() =>
      elementsToState(GM_EARTH_M3_PER_S2, {
        semimajorAxisMetres: -4e7,
        eccentricity: 1.8,
        inclinationRad: 0.5,
        raanRad: 0,
        argpRad: 0,
        trueAnomalyRad: Math.acos(-1 / 1.8) + 0.1,
        raanDefined: true,
        argpDefined: true,
      }),
    ).toThrow(HyperbolicAsymptoteError);
  });
});

// --- universal-variable propagation -----------------------------------------------------

describe('engine/orbits — propagate round trips (the brief envelope)', () => {
  // a = 2e7 m keeps e = 0.7 periapsis (6e6 m) outside Earth; every case is a
  // physical geocentric conic. The round trip is propagate(+T) then
  // propagate(−T) from the returned state.
  const A = 2e7;
  const T = periodFromSemimajorAxis(GM_EARTH_M3_PER_S2, A);

  it.each([
    [0.0, 0.0],
    [0.0, 0.9],
    [0.2, 0.0],
    [0.2, 0.9],
    [0.7, 0.0],
    [0.7, 0.9],
  ] as const)('forward+back over a full period closes (e=%f, incl=%f)', (e, inc) => {
    const s0 = earthElements(A, e, inc, 0.7, 1.3, 0.4);
    const s1 = propagate(GM_EARTH_M3_PER_S2, s0, T);
    const sBack = propagate(GM_EARTH_M3_PER_S2, s1, -T);
    const errR = positionError(sBack, s0);
    const errV = norm3(subV(sBack.velocityMetresPerSecond, s0.velocityMetresPerSecond));
    // Derived floor: two full-period solves whose χ roots and f/g
    // reconstructions each accumulate O(10²–10³) f64 roundings at position
    // magnitude (r ~ 6e6 m here, ulp ~ 1e-9 m) → an O(1e-6) m class with no
    // systematic removable term [MEASURED 2026-09-06: envelope over the six
    // cases below is 0 .. 1.1e-6 m; n-splitting does not shrink it — it is
    // per-solve rounding, not truncation; and relaxing the χ-solve stop to
    // stagnation-only changes nothing]. 5e-6 m is that class with margin
    // and ~7 orders below gameplay scale.
    expect(errR).toBeLessThan(5e-6);
    expect(errR / norm3(s0.positionMetres)).toBeLessThan(1e-9); // relative bound [derived: errR/r ≤ 2πε_rel]
    // Velocity: the fdot/gdot reconstruction carries the same rounding class
    // as position — v ~ 1e4 m/s, ulp(v) ~ 2e-12, O(10²) roundings → an
    // O(1e-9) m/s class [MEASURED 2026-09-06: envelope over the six cases
    // 0 .. 1.40e-9 m/s, relative ≤ 1.34e-13]. 1e-8 m/s is that class with
    // margin — 7 orders below gameplay-relevant velocity error.
    expect(errV).toBeLessThan(1e-8);
  });

  it('lands in the 1e-8 m class for a full-period circular round trip (the g-cancellation floor)', () => {
    // The exact e = 0 round trip has f = 1, g = 0 in real arithmetic — but
    // the solver computes g = dt − χ³S/√μ as the DIFFERENCE of two
    // √μ·dt-sized terms (~5.6e11 s·m here), so its absolute error is a few
    // ulp(√μ·T) ≈ few·6e-12 s [derived], which the reconstruction maps to
    // δr ≈ δg·v_circ ≈ few·6e-12·6264 m/s ~ 1e-8..1e-7 m. That is the f64
    // floor of this formulation — ~60× tighter than the elliptic worst case
    // above, but not 0 and not sub-1e-9. [MEASURED 2026-09-06: 1.65e-8.]
    const s0 = earthElements(A, 0, 0.9, 0.7, 0, 0);
    const sBack = propagate(GM_EARTH_M3_PER_S2, propagate(GM_EARTH_M3_PER_S2, s0, T), -T);
    expect(positionError(sBack, s0)).toBeLessThan(1e-7);
  });

  it('half-period propagation lands at the antipode (e = 0)', () => {
    const s0 = earthElements(A, 0, 0.9, 0.7, 0, 0);
    const s1 = propagate(GM_EARTH_M3_PER_S2, s0, T / 2);
    const r0 = s0.positionMetres;
    const r1 = s1.positionMetres;
    expect(norm3(r1)).toBeCloseTo(norm3(r0), -3);
    expect(dot3(scaleV(r0, 1 / norm3(r0)), scaleV(r1, 1 / norm3(r1)))).toBeCloseTo(-1, 9);
  });

  it('dt = 0 returns the input state; negative dt reverses the arc', () => {
    const s0 = earthElements(A, 0.2, 0.9, 0.7, 1.3, 0.4);
    const zero = propagate(GM_EARTH_M3_PER_S2, s0, 0);
    expect(positionError(zero, s0)).toBe(0);
    const fwd = propagate(GM_EARTH_M3_PER_S2, s0, 600);
    const rev = propagate(GM_EARTH_M3_PER_S2, s0, -600);
    // +600 s and −600 s from the same state are mirror arcs through s0:
    // propagating fwd by −1200 s must land on rev.
    const back = propagate(GM_EARTH_M3_PER_S2, fwd, -1200);
    expect(positionError(back, rev)).toBeLessThan(1e-6);
  });

  it('throws on invalid inputs (μ, non-finite state, non-finite dt, origin state)', () => {
    const s0 = earthElements(A, 0.2, 0.9, 0.7, 1.3, 0.4);
    expect(() => propagate(0, s0, 1)).toThrow(OrbitArgumentError);
    expect(() => propagate(-1, s0, 1)).toThrow(OrbitArgumentError);
    expect(() => propagate(GM_EARTH_M3_PER_S2, state(vec3(NaN, 0, 0), vec3(0, 1, 0)), 1)).toThrow(OrbitArgumentError);
    expect(() => propagate(GM_EARTH_M3_PER_S2, s0, NaN)).toThrow(OrbitArgumentError);
    expect(() => propagate(GM_EARTH_M3_PER_S2, state(vec3(0, 0, 0), vec3(0, 1, 0)), 1)).toThrow(OrbitArgumentError);
  });
});

describe('engine/orbits — Kepler’s third law and conic identities', () => {
  const A = 2e7;
  const T = periodFromSemimajorAxis(GM_EARTH_M3_PER_S2, A);

  it.each([0, 0.2, 0.7] as const)('T = 2π√(a³/μ) is eccentricity-independent: the state revolves exactly once (e=%f)', (e) => {
    const s0 = earthElements(A, e, 0.9, 0.7, 1.3, 0.4);
    const s1 = propagate(GM_EARTH_M3_PER_S2, s0, T);
    // Same point in space AND same velocity direction after exactly one
    // period — true for every e only if T is the closed-form period.
    expect(positionError(s1, s0)).toBeLessThan(1e-6);
    const v0 = s0.velocityMetresPerSecond;
    const v1 = s1.velocityMetresPerSecond;
    const cos = dot3(scaleV(v0, 1 / norm3(v0)), scaleV(v1, 1 / norm3(v1)));
    expect(cos).toBeCloseTo(1, 9);
  });

  it('periodFromSemimajorAxis reproduces the closed form and refuses a ≤ 0', () => {
    expect(periodFromSemimajorAxis(GM_EARTH_M3_PER_S2, 2e7)).toBe(2 * Math.PI * Math.sqrt((2e7 ** 3) / GM_EARTH_M3_PER_S2));
    expect(() => periodFromSemimajorAxis(GM_EARTH_M3_PER_S2, -1)).toThrow(OrbitArgumentError);
  });

  it('hyperbolic arc approaches the asymptote: vis-viva and the ν∞ approach law', () => {
    // a = −4e7, e = 1.8 → rp = a(1−e) = 3.2e7 m, p = a(1−e²) = 8.96e7 m.
    const aH = -4e7;
    const eH = 1.8;
    const p = aH * (1 - eH * eH);
    const vInf = hyperbolicExcessSpeed(GM_EARTH_M3_PER_S2, aH);
    expect(vInf).toBeCloseTo(Math.sqrt(-GM_EARTH_M3_PER_S2 / aH), 6);
    const atPeri = elementsToState(GM_EARTH_M3_PER_S2, {
      semimajorAxisMetres: aH,
      eccentricity: eH,
      inclinationRad: 0.5,
      raanRad: 0.3,
      argpRad: 0,
      trueAnomalyRad: 0,
      raanDefined: true,
      argpDefined: true,
    });
    const periDir = scaleV(atPeri.positionMetres, 1 / norm3(atPeri.positionMetres)); // ν = 0 here
    const nuInf = Math.acos(-1 / eH);
    const n = Math.sqrt(-GM_EARTH_M3_PER_S2 / (aH * aH * aH)); // mean motion (√(−μ/a³))
    // Time from periapsis to a target radius via the closed hyperbolic Kepler
    // chain r → ν → H → M → t (deterministic; independent of the propagator).
    const stateAtRadius = (rTarget: number): CartesianState => {
      const cosN = (p / rTarget - 1) / eH; // r = p/(1+e·cosν)
      const H = Math.acosh((eH + cosN) / (1 + eH * cosN)); // cosh H = (e+cosν)/(1+e·cosν)
      return propagate(GM_EARTH_M3_PER_S2, atPeri, (eH * Math.sinh(H) - H) / n);
    };
    for (const rTarget of [5e7, 1e8, 4e8]) {
      const s1 = stateAtRadius(rTarget);
      const r1 = norm3(s1.positionMetres);
      expect(r1).toBeCloseTo(rTarget, -3); // lands where Kepler’s equation says
      const v1 = norm3(s1.velocityMetresPerSecond);
      const visViva = Math.sqrt(vInf * vInf + (2 * GM_EARTH_M3_PER_S2) / r1);
      expect(v1 / visViva).toBeCloseTo(1, 12); // [derived identity — vis-viva]
      // Asymptote approach: ν(r) = ν∞ − δ with δ ≈ p/(e·r·√(1−1/e²)) [derived:
      // expand 1+e·cos ν around ν∞]. The angle between r and the periapsis
      // direction IS ν here, so it must approach ν∞ from below at that rate.
      const delta = p / (eH * r1 * Math.sqrt(1 - 1 / (eH * eH)));
      const angle = angleBetweenRadians(s1.positionMetres, periDir);
      expect(nuInf - angle).toBeGreaterThan(0); // below the asymptote, always
      expect(nuInf - angle).toBeGreaterThan(0.8 * delta);
      expect(nuInf - angle).toBeLessThan(1.25 * delta); // O(δ³) correction margin
    }
    // And the excess speed decays like the 1/r class: v − v∞ ≈ μ/(r·v∞)
    // [derived from vis-viva], so quadrupling r quarters the excess.
    const e1 = norm3(stateAtRadius(4e8).velocityMetresPerSecond) - vInf;
    const e2 = norm3(stateAtRadius(1.6e9).velocityMetresPerSecond) - vInf;
    expect(e2 / e1).toBeGreaterThan(0.15);
    expect(e2 / e1).toBeLessThan(0.55); // 0.25 class [MEASURED 0.258]
  });
});

// --- conservation ------------------------------------------------------------------------

describe('engine/orbits — conservation over propagation', () => {
  const A = 2e7;
  const T = periodFromSemimajorAxis(GM_EARTH_M3_PER_S2, A);

  it.each([0, 0.2, 0.7] as const)('h vector and specific energy conserved over one period (e=%f)', (e) => {
    const s0 = earthElements(A, e, 0.9, 0.7, 1.3, 0.4);
    const h0 = angularMomentumVector(s0);
    const eps0 = specificOrbitalEnergy(GM_EARTH_M3_PER_S2, s0);
    const s1 = propagate(GM_EARTH_M3_PER_S2, s0, T);
    const h1 = angularMomentumVector(s1);
    const eps1 = specificOrbitalEnergy(GM_EARTH_M3_PER_S2, s1);
    // f64 noise class: |Δh|/|h| ≲ 1e-15·(#roundings) — assert 1e-12 relative
    // [derived: ~10² roundings · 2^-52 ≈ 2e-14, with margin].
    expect(norm3(subV(h1, h0)) / norm3(h0)).toBeLessThan(1e-12);
    // Energy: |ε| ~ 5e6 J/kg here; absolute f64 noise in ε ~ 1e-9 class.
    expect(Math.abs(eps1 - eps0) / Math.abs(eps0)).toBeLessThan(1e-12);
  });

  it('hyperbolic energy and angular momentum conserved on the escape arc', () => {
    const aH = -4e7;
    const atPeri = elementsToState(GM_EARTH_M3_PER_S2, {
      semimajorAxisMetres: aH,
      eccentricity: 1.8,
      inclinationRad: 0.5,
      raanRad: 0.3,
      argpRad: 0,
      trueAnomalyRad: 0,
      raanDefined: true,
      argpDefined: true,
    });
    const eps0 = specificOrbitalEnergy(GM_EARTH_M3_PER_S2, atPeri);
    const h0 = angularMomentumVector(atPeri);
    const s1 = propagate(GM_EARTH_M3_PER_S2, atPeri, 20 * 86400); // 20 days outbound
    expect(specificOrbitalEnergy(GM_EARTH_M3_PER_S2, s1)).toBeCloseTo(eps0, 2); // ε = +μ/(2·4e7) ~ 5e6
    expect(norm3(subV(angularMomentumVector(s1), h0)) / norm3(h0)).toBeLessThan(1e-12);
    // Semimajor axis recovered from energy matches the element view.
    expect(semimajorAxisFromEnergy(GM_EARTH_M3_PER_S2, eps0)).toBeCloseTo(aH, -3);
  });

  it('multi-revolution stepping conserves to the same class as one long step', () => {
    const s0 = earthElements(A, 0.7, 0.9, 0.7, 1.3, 0.4);
    const h0 = norm3(angularMomentumVector(s0));
    const eps0 = specificOrbitalEnergy(GM_EARTH_M3_PER_S2, s0);
    let s = s0;
    for (let i = 0; i < 100; i++) s = propagate(GM_EARTH_M3_PER_S2, s, T / 100); // 100 steps ≈ 1 period
    expect(norm3(subV(angularMomentumVector(s), angularMomentumVector(s0))) / h0).toBeLessThan(1e-12);
    expect(specificOrbitalEnergy(GM_EARTH_M3_PER_S2, s)).toBeCloseTo(eps0, 2);
    expect(norm3(s.positionMetres)).toBeCloseTo(norm3(s0.positionMetres), -3); // full revolution closed
  });
});

// --- real-ephemeris golden fixture ---------------------------------------------------------

interface KeplerRow {
  readonly t0Iso: string;
  readonly t1Iso: string;
  readonly dtSeconds: number;
  readonly r0m: { x: number; y: number; z: number };
  readonly v0m: { x: number; y: number; z: number };
  readonly r1m: { x: number; y: number; z: number };
  readonly v1m: { x: number; y: number; z: number };
  readonly v0mKernelAnalytic: { x: number; y: number; z: number };
  readonly v0mFivePoint: { x: number; y: number; z: number };
  readonly jerkEstimateMPerS3: number;
  readonly perturbationAccelMPerS2: number;
}
interface KeplerFixture {
  readonly schema: string;
  readonly rows: readonly KeplerRow[];
}

const keplerFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/golden/kepler/kepler-earth.json', import.meta.url)), 'utf-8'),
) as KeplerFixture;

describe('engine/orbits — real-ephemeris golden fixture (DE440s oracle, ICRF in/out)', () => {
  it('the committed fixture is the schema this suite consumes', () => {
    expect(keplerFixture.schema).toBe('kwetu.golden.kepler/1');
    expect(keplerFixture.rows.length).toBe(2);
  });

  it.each(keplerFixture.rows.map((row, i) => [row, i] as const))(
    'two-body GM_SUN propagation of row $i hits the oracle to the DERIVED model gap',
    (row) => {
      const dt = row.dtSeconds;
      const s0: CartesianState = {
        positionMetres: vec3(row.r0m.x, row.r0m.y, row.r0m.z),
        velocityMetresPerSecond: vec3(row.v0m.x, row.v0m.y, row.v0m.z),
      };
      const s1 = propagate(GM_SUN_M3_PER_S2, s0, dt);
      const miss = norm3(subV(s1.positionMetres, vec3(row.r1m.x, row.r1m.y, row.r1m.z)));

      // DERIVED bound (the fixture carries the two inputs it needs):
      //  1. velocity-differencing error of the oracle: v_cd − v_true =
      //     (h²/6)·r'''(ξ) [derived central-difference remainder], h = 300 s,
      //     with |r'''| ≤ jerkEstimateMPerS3 → position effect ≤ (h²/6)·jerk·dt.
      //  2. two-body-vs-N-body model gap: |Δr| ≤ ½·a_pert·dt² while a_pert
      //     holds over the arc; the fixture records a_pert(t0) and the arc is
      //     short enough that a_pert varies ≲ 0.4% (Moon’s synodic rate
      //     2.66e-6 rad/s × 600 s rotates the geometry by 1.6e-3 rad) [derived].
      const hDiff = 300;
      const diffTerm = ((hDiff * hDiff) / 6) * row.jerkEstimateMPerS3 * dt;
      const modelGap = 0.505 * row.perturbationAccelMPerS2 * dt * dt; // +0.5% arc variation
      const f64Headroom = 0.01; // propagator noise at 1 AU: 2πa·2^-52·k ≪ 1 cm [derived]
      const bound = diffTerm + modelGap + f64Headroom;
      expect(miss).toBeLessThan(bound);
      // And the miss is GENUINE model error, not f64 dust: it must exceed the
      // differencing term alone in this Moon-dominated geometry.
      expect(miss).toBeGreaterThan(f64Headroom);
    },
  );

  it.each(keplerFixture.rows.map((row, i) => [row, i] as const))(
    'reverse: propagating row $i’s t1 state BACK lands on r0 within the same bound',
    (row) => {
      const dt = row.dtSeconds;
      const s1: CartesianState = {
        positionMetres: vec3(row.r1m.x, row.r1m.y, row.r1m.z),
        velocityMetresPerSecond: vec3(row.v1m.x, row.v1m.y, row.v1m.z),
      };
      const s0 = propagate(GM_SUN_M3_PER_S2, s1, -dt);
      const miss = norm3(subV(s0.positionMetres, vec3(row.r0m.x, row.r0m.y, row.r0m.z)));
      const diffTerm = ((300 * 300) / 6) * row.jerkEstimateMPerS3 * dt;
      const modelGap = 0.505 * row.perturbationAccelMPerS2 * dt * dt;
      expect(miss).toBeLessThan(diffTerm + modelGap + 0.01);
    },
  );

  it('the oracle’s central-difference velocity matches its own five-point stencil within the derived stencil error', () => {
    // Cross-check of the fixture itself, using KERNEL POSITIONS ONLY (both
    // velocities are finite differences of the Chebyshev position fit, so
    // neither carries the fit's derivative error): |v_cd − v_5p| ≈
    // (h²/6)·|r'''(ξ)| [derived — the two stencils' h⁴ truncation terms
    // nearly cancel; the h² term is shared].
    // The analytic column (v0mKernelAnalytic) is NOT usable as the model
    // check: it is the Chebyshev fit's own derivative and sits in the
    // fit-derivative error class (2.5e-6 .. 4.8e-6 m/s [MEASURED 2026-09-06
    // against the five-point stencil]) — row 0 ran 27% over its (h²/6)·jerk
    // prediction, row 1 13% under. It stays in the fixture as a diagnostic.
    // Bound = (h²/6)·jerk with factor-2 headroom for the jerk ESTIMATE's own
    // error (finite 5-point jerk stencil vs the sup over the arc) plus
    // ~5e-7 m/s of kernel-evaluation noise floor [MEASURED margins:
    // row 0 dv = 1.744e-5 vs 4.49e-5 bound; row 1 dv = 1.832e-5 vs 4.66e-5].
    for (const row of keplerFixture.rows) {
      const dv = norm3(subV(vec3(row.v0m.x, row.v0m.y, row.v0m.z), vec3(row.v0mFivePoint.x, row.v0mFivePoint.y, row.v0mFivePoint.z)));
      const bound = 2 * ((300 * 300) / 6) * row.jerkEstimateMPerS3 + 1e-5;
      expect(dv).toBeLessThan(bound);
      expect(dv).toBeGreaterThan(0); // the differencing error is real, just bounded
    }
  });
});

// --- patched-conic SOI handoff -------------------------------------------------------------

describe('engine/orbits — soiHandoffToParent (synthetic two-body scenario)', () => {
  // Scenario (every number below derived in-test, nothing tuned by hand):
  //   A = the Sun (GM_SUN), B = an Earth-mass planet on the EXACT mutual
  //   two-body circle at R_AB. The craft starts AT REST relative to A at
  //   1.1·R_AB on the +x ray and falls radially inward (a rectilinear e = 1
  //   A-conic — h = 0, which the universal-variable propagator handles).
  //   B is phased (initial angle −ω·t_arrival) so that it is EXACTLY at
  //   (R_AB, 0) when the craft reaches R_AB: the model has a collision there,
  //   so the craft MUST cross B's SOI shortly before t_arrival — the first
  //   crossing time is pinned analytically to a derived window.
  const muA = GM_SUN_M3_PER_S2;
  const muB = GM_EARTH_M3_PER_S2;
  const R_AB = 1.5e11;
  const muSum = muA + muB;
  const r0 = 1.1 * R_AB; // craft release radius (at rest relative to A)
  const omega = Math.sqrt(muSum / (R_AB * R_AB * R_AB)); // B's circular rate
  const vB = omega * R_AB; // √(μSum/R_AB)

  // Radial fall from rest at r0 to radius R_AB under μA (degenerate ellipse
  // a = r0/2, e = 1; Kepler M = E − sin E): t = √(a³/μ)·(π − (E1 − sin E1)).
  const aSemi = r0 / 2;
  const cosE1 = 1 - R_AB / aSemi;
  const E1 = Math.acos(cosE1);
  const tArrival = Math.sqrt((aSemi * aSemi * aSemi) / muA) * (Math.PI - (E1 - Math.sin(E1)));

  const soiRadius = laplaceSoiRadiusMetres(muB, muA, R_AB);

  const craftRelA: CartesianState = { positionMetres: vec3(r0, 0, 0), velocityMetresPerSecond: vec3(0, 0, 0) };
  const bRelA: CartesianState = {
    positionMetres: vec3(R_AB * Math.cos(-omega * tArrival), R_AB * Math.sin(-omega * tArrival), 0),
    velocityMetresPerSecond: vec3(-vB * Math.sin(-omega * tArrival), vB * Math.cos(-omega * tArrival), 0),
  };
  // A's state relative to B is the exact negative (the brief's parameter).
  const primaryARelB: CartesianState = {
    positionMetres: scaleV(bRelA.positionMetres, -1),
    velocityMetresPerSecond: scaleV(bRelA.velocityMetresPerSecond, -1),
  };

  const result = soiHandoffToParent({ muA, muB, craftRelA, primaryARelB, soiRadiusB: soiRadius });

  it('crosses the SOI once, shortly before the analytic collision instant', () => {
    expect(result.crossingTimeSeconds).toBeGreaterThan(0);
    expect(result.crossingTimeSeconds).toBeLessThan(tArrival); // the model collides AT t_arrival
    // Derived window for τ = t_arrival − t_cross (the entry-to-collision span).
    //  τ ≥ R_soi/(v_craft + v_B): the B-centric separation can close no faster
    //  than the relative speed bound |v_rel| ≤ v_craft + v_B (reverse triangle
    //  inequality) — 41.6 km/s → τ ≥ 22.4 ks.
    //  τ ≤ R_soi/((2/π)·R_AB·ω − v_craft): the tangential offset R_AB·|sin ωτ|
    //  grows at ≥ (2/π)·v_B (sin x ≥ 2x/π on [0, π/2], ωτ ≤ 0.485 rad here)
    //  while the radial offset grows at ≤ v_craft — reverse triangle gives
    //  |d| ≥ (2/π)v_B·τ − v_craft·τ ≈ 6.2 km/s of guaranteed closing — τ ≤ 150 ks.
    const vCraft = Math.sqrt(2 * muA * (1 / (R_AB + soiRadius) - 1 / r0)); // vis-viva at the crossing radius class
    const tauMin = soiRadius / (vCraft + vB);
    const tauMax = soiRadius / ((2 / Math.PI) * vB - vCraft);
    const tau = tArrival - result.crossingTimeSeconds;
    expect(tau).toBeGreaterThan(tauMin);
    expect(tau).toBeLessThan(tauMax);
  });

  it('state continuity is BITWISE: no velocity jump, the reframe is pure vector algebra', () => {
    // r_c/B = r_c/A + r_A/B and v_c/B = v_c/A + v_A/B, exactly as constructed.
    expect(result.stateRelB.positionMetres.x).toBe(result.stateRelA.positionMetres.x + result.primaryARelB.positionMetres.x);
    expect(result.stateRelB.positionMetres.y).toBe(result.stateRelA.positionMetres.y + result.primaryARelB.positionMetres.y);
    expect(result.stateRelB.positionMetres.z).toBe(result.stateRelA.positionMetres.z + result.primaryARelB.positionMetres.z);
    expect(result.stateRelB.velocityMetresPerSecond.x).toBe(result.stateRelA.velocityMetresPerSecond.x + result.primaryARelB.velocityMetresPerSecond.x);
    expect(result.stateRelB.velocityMetresPerSecond.y).toBe(result.stateRelA.velocityMetresPerSecond.y + result.primaryARelB.velocityMetresPerSecond.y);
    expect(result.stateRelB.velocityMetresPerSecond.z).toBe(result.stateRelA.velocityMetresPerSecond.z + result.primaryARelB.velocityMetresPerSecond.z);
    // The returned A-relative state is the propagated craft state at tCross.
    const craftAtCross = propagate(muA, craftRelA, result.crossingTimeSeconds);
    expect(result.stateRelA.positionMetres.x).toBe(craftAtCross.positionMetres.x);
    expect(result.stateRelA.positionMetres.z).toBe(craftAtCross.positionMetres.z);
  });

  it('the crossing is ON the SOI sphere, and it is the FIRST entry', () => {
    const rCross = norm3(result.stateRelB.positionMetres);
    // Bisection stops at 1e-9·tCross s [the documented stop]; the separation
    // moves at the ≤ (v_craft+v_B) ≈ 41.6 km/s closing rate, so |d| is pinned
    // to ~±100 m [derived: 41,555 · 1e-9 · 2.44e6 ≈ 100 m].
    expect(Math.abs(rCross - soiRadius)).toBeLessThan(200);
    // Independent first-entry scan: the separation must stay ABOVE the SOI
    // radius for all t < tCross (2 s grid, own composition of the model).
    const tCross = result.crossingTimeSeconds;
    const step = 2000;
    for (let t = step; t < tCross - step; t += step) {
      const craft = propagate(muA, craftRelA, t);
      const primary = propagate(muSum, primaryARelB, t);
      const d = norm3({ x: craft.positionMetres.x + primary.positionMetres.x, y: craft.positionMetres.y + primary.positionMetres.y, z: craft.positionMetres.z + primary.positionMetres.z });
      if (d <= soiRadius) {
        throw new Error(`earlier SOI entry found at t=${t} (d=${d} ≤ R_soi) — first-entry violated`);
      }
    }
  });

  it('the craft is just outside B’s orbit radius and on a hyperbolic B-arc at handoff', () => {
    const rCraftA = norm3(result.stateRelA.positionMetres);
    expect(rCraftA).toBeGreaterThan(R_AB); // it has not reached B's orbital radius yet
    expect(rCraftA).toBeLessThan(R_AB + soiRadius);
    const epsB = specificOrbitalEnergy(muB, result.stateRelB);
    expect(epsB).toBeGreaterThan(0); // hyperbolic B-centric arc (flyby class)
  });

  it('exposes the patched-conic acceleration discontinuity (the honest approximation flag)', () => {
    // Independent recomputation: a_A = μA·r̂_c→A/r², a_B = μB·r̂_c→B/r² at the
    // crossing; the result must match, and must be nonzero — that nonzero
    // value IS the conic-to-conic discontinuity documented in orbits.ts.
    const rToB = scaleV(result.stateRelB.positionMetres, -1); // craft → B (B at origin of B-frame)
    const rToA = subV(result.primaryARelB.positionMetres, result.stateRelB.positionMetres); // craft → A
    const aB = scaleV(rToB, muB / norm3(rToB) ** 3); // μB/r² · r̂ = μB·r_vec/r³
    const aA = scaleV(rToA, muA / norm3(rToA) ** 3);
    const expected = norm3(subV(aB, aA));
    const got = result.accelerationDiscontinuityMetresPerS2;
    expect(Math.abs(got - expected) / expected).toBeLessThan(1e-12);
    expect(got).toBeGreaterThan(0);
    // Scale sanity: the B-field term μB/R_soi² is a 4.6e-4 m/s² class here,
    // the A-field term μA/R_AB² ≈ 5.9e-3 m/s² dominates the difference.
    expect(result.accelerationDiscontinuityMetresPerS2).toBeGreaterThan((muB / (soiRadius * soiRadius)) * 0.5);
  });

  it('refuses a craft already inside the SOI and a trajectory that never crosses', () => {
    // Already inside: craft 0.5·R_soi sunward of B.
    const inside: CartesianState = { positionMetres: vec3(R_AB - 0.5 * soiRadius, 0, 0), velocityMetresPerSecond: vec3(0, 10, 0) };
    const bAtZero: CartesianState = { positionMetres: vec3(-R_AB, 0, 0), velocityMetresPerSecond: vec3(0, -vB, 0) };
    expect(() => soiHandoffToParent({ muA, muB, craftRelA: inside, primaryARelB: bAtZero, soiRadiusB: soiRadius })).toThrow(
      OrbitArgumentError,
    );
    // Never crosses: craft on a circular A-orbit at 0.5·R_AB — its B-centric
    // distance stays in [0.5, 1.5]·R_AB, orders above the SOI radius.
    const inner: CartesianState = {
      positionMetres: vec3(0.5 * R_AB, 0, 0),
      velocityMetresPerSecond: vec3(0, Math.sqrt(muA / (0.5 * R_AB)), 0),
    };
    expect(() => soiHandoffToParent({ muA, muB, craftRelA: inner, primaryARelB: bAtZero, soiRadiusB: soiRadius })).toThrow(
      NoSoiCrossingError,
    );
    // Invalid inputs.
    expect(() =>
      soiHandoffToParent({ muA: -1, muB, craftRelA, primaryARelB, soiRadiusB: soiRadius }),
    ).toThrow(OrbitArgumentError);
    expect(() =>
      soiHandoffToParent({ muA, muB, craftRelA, primaryARelB, soiRadiusB: 0 }),
    ).toThrow(OrbitArgumentError);
  });

  it('never throws the convergence error on this scenario (deterministic search)', () => {
    // The scenario is fully smooth; a KeplerConvergenceError would mean the
    // solver, not the geometry, failed. (Explicit re-run for a clear failure
    // message — the describe-level call already succeeded.)
    expect(() =>
      soiHandoffToParent({ muA, muB, craftRelA, primaryARelB, soiRadiusB: soiRadius }),
    ).not.toThrow(KeplerConvergenceError);
  });
});
