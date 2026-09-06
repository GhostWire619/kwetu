/**
 * Engine frame-chain tests (COORDINATE_SYSTEM.md §11/§12; ADR-002 Decision 1).
 *
 * Golden seeds G-01/G-02 are the doc §12 committed values, confirmed
 * reproducible by ADR-002. Thresholds: ADR-002 Decision 1 proposed CI gates
 * 1e−12 deg (G-01) and 1e−5 m (G-02) — three orders inside the measured
 * values [PLACEHOLDER — gate: S0.11 confirm]. Fuzz vectors come from a
 * deterministic LCG — never Math.random (tests must replay bitwise).
 */
import { describe, expect, it } from 'vitest';
import * as A from 'astronomy-engine';
import {
  Frame,
  earthHelioPosition,
  enuToPlanetFixed,
  gastRadians,
  pciVelocityFromPlanetFixed,
  toEnu,
  toGeodetic,
  toHelio,
  toPci,
  toPlanetFixed,
  geodeticToPlanetFixed,
  type BodyName,
} from '../../client/src/engine/frames';
import { AU_METRES, worldTimeTtFromUtcMillis, type WorldTimeTtSeconds } from '../../client/src/engine/ephemeris';
import { EARTH_OMEGA_RAD_PER_S, enuBasis, type GeodeticCoord } from '../../client/src/engine/geodesy';
import { f32Downcast, F32_CANCELLATION_AT_1AU_METRES } from '../../client/src/engine/precision';
import { angleBetweenRadians, dot3, norm3, subV, type Framed, type Vec3 } from '../../client/src/engine/vec3';

// --- fixtures: the COORDINATE_SYSTEM.md §12 worked example ----------------------------

const SITE: GeodeticCoord = { latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 };
/** 2026-09-05T00:00:00Z under the pinned TT bridge. */
const T0: WorldTimeTtSeconds = worldTimeTtFromUtcMillis(Date.UTC(2026, 8, 5, 0, 0, 0));
const BODY: BodyName = 'Earth';

/** §12 committed seeds (displayed rounded in the doc; ADR-002 confirmed reproducible). */
const SEEDS = {
  gastDeg: 344.118,
  ecef: { x: 4907565.698, y: 4003939.392, z: -749078.231 },
  pci: { x: 5828917.818, y: 2473115.83, z: -764372.354 },
  earthHelio: { x: 143544280009.368, y: -42547782563.768, z: -18444627471.66 },
  darHelio: { x: 143550108927.186, y: -42545309447.938, z: -18445391844.014 },
  g02BoundMetres: 4.4e-6,
  g01SeedDeg: 4.6e-14,
  f32CancellationMetres: 12636,
};

/** Deterministic LCG (Numerical Recipes) — fixed-seed fuzz vectors, no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function maxComponentError(a: Vec3, b: Vec3): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

/** Full-chain round trip: geodetic → pf → pci → helio → pci → pf → geodetic, residual in PlanetFixed metres. */
function fullChainResidualMetres(site: GeodeticCoord, t: WorldTimeTtSeconds): number {
  const pf = geodeticToPlanetFixed(site);
  const pci = toPci(pf, BODY, t);
  const helio = toHelio(pci, earthHelioPosition(t));
  const pciBack = toPci(helio, earthHelioPosition(t));
  const pfBack = toPlanetFixed(pciBack, BODY, t);
  const geoBack = toGeodetic(pfBack);
  const pfReconstructed = geodeticToPlanetFixed(geoBack);
  return norm3(subV(pfReconstructed.xyz, pf.xyz));
}

describe('engine/frames — the §12 worked example (doc seeds)', () => {
  it('reproduces GAST, PlanetFixed, Pci and Helio seeds', () => {
    const gastDeg = (gastRadians(T0) * 180) / Math.PI;
    expect(gastDeg).toBeCloseTo(SEEDS.gastDeg, 2); // doc shows 3 dp
    const ecef = geodeticToPlanetFixed(SITE);
    expect(ecef.frame).toBe(Frame.planetFixed('Earth'));
    expect(maxComponentError(ecef.xyz, SEEDS.ecef)).toBeLessThan(2e-3);
    const pci = toPci(ecef, BODY, T0);
    expect(pci.frame).toBe(Frame.pci('Earth'));
    expect(maxComponentError(pci.xyz, SEEDS.pci)).toBeLessThan(2e-3);
    const earthHelio = earthHelioPosition(T0);
    expect(earthHelio.frame).toBe(Frame.Helio);
    expect(maxComponentError(earthHelio.xyz, SEEDS.earthHelio)).toBeLessThan(2e-3);
    const darHelio = toHelio(pci, earthHelio);
    expect(darHelio.frame).toBe(Frame.Helio);
    expect(maxComponentError(darHelio.xyz, SEEDS.darHelio)).toBeLessThan(2e-3);
  });

  it('G-02: full-chain f64 round trip lands in the committed residual class (≤ 4.4e−6 m)', () => {
    const residual = fullChainResidualMetres(SITE, T0);
    expect(residual).toBeGreaterThan(0); // the f64 ULP floor at 1 AU is real, not zero
    // [MEASURED 2026-09-06: 4.3735e−6 m — the ADR-002 figure, reproduced.]
    expect(residual).toBeLessThanOrEqual(SEEDS.g02BoundMetres);
  });

  it('G-02 companion: the rotation-only chain round trips far below the full chain', () => {
    const pf = geodeticToPlanetFixed(SITE);
    const pci = toPci(pf, BODY, T0);
    const pfBack = toPlanetFixed(pci, BODY, T0);
    const residual = norm3(subV(pfBack.xyz, pf.xyz));
    // [MEASURED 2026-09-06: 1.4163e−9 m — the ADR-002 rotation-only class.]
    expect(residual).toBeLessThan(1e-7);
  });

  it('G-01: our chain’s ENU zenith matches the library’s own horizon frame to ≤ 1e−12 deg', () => {
    const t = A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)));
    const obs = new A.Observer(SITE.latitudeDeg, SITE.longitudeDeg, SITE.heightMetres);
    const up = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).up;
    // Our ENU up, carried by OUR chain's PlanetFixed → Pci rotation to EQJ:
    const upPci = toPci({ frame: Frame.planetFixed('Earth'), xyz: up }, BODY, T0);
    // The library's own zenith, HOR → EQJ (independent oracle path):
    const libZenith = libraryRotate(A.Rotation_HOR_EQJ(t, obs), { x: 0, y: 0, z: 1 });
    const deg = (angleBetweenRadians(upPci.xyz, libZenith) * 180) / Math.PI;
    // [MEASURED 2026-09-06: 4.8145e−14 deg — the ADR-002 G-01 figure.]
    expect(deg).toBeLessThan(1e-12);
  });

  it('G-01 companion: the library’s EQD→EQJ rotation maps its own of-date observer vector onto its own J2000 one', () => {
    const t = A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)));
    const obs = new A.Observer(SITE.latitudeDeg, SITE.longitudeDeg, SITE.heightMetres);
    const vEqd = A.ObserverVector(t, obs, true);
    const vEqj = A.ObserverVector(t, obs, false);
    const conv = A.RotateVector(A.Rotation_EQD_EQJ(t), vEqd);
    const err = Math.hypot(conv.x - vEqj.x, conv.y - vEqj.y, conv.z - vEqj.z) * AU_METRES;
    expect(err).toBeLessThan(1e-6); // [MEASURED 2026-09-05: 1.02e−9 m]
  });
});

describe('engine/frames — Laws and conventions', () => {
  it('Law §13 rule 3: conversions reject mis-framed input', () => {
    const helio = earthHelioPosition(T0);
    const wrongTag = { frame: Frame.pci('Earth'), xyz: helio.xyz } as unknown as Framed<'Helio'>;
    // The first argument is deliberately mis-framed at the type level too — a
    // Helio vector where the conversion demands Pci — hence the explicit cast.
    const helioMisframedAsPci = helio as unknown as Framed<'Pci(Earth)'>;
    expect(() => toHelio(helioMisframedAsPci, wrongTag)).toThrow(/Frame.Helio/);
    const helioAsPlanetFixed = { frame: Frame.Helio, xyz: helio.xyz } as unknown as Framed<'PlanetFixed(Earth)'>;
    expect(() => toGeodetic(helioAsPlanetFixed)).toThrow(/PlanetFixed/);
    expect(() => toEnu(helioAsPlanetFixed, SITE)).toThrow(/PlanetFixed/);
  });

  it('Pci→PlanetFixed inverse composed with PlanetFixed→Pci is the identity (the one rotation, round trip)', () => {
    const pf = geodeticToPlanetFixed({ latitudeDeg: 51.5, longitudeDeg: -0.12, heightMetres: 123.456 });
    const pci = toPci(pf, BODY, T0);
    const back = toPlanetFixed(pci, BODY, T0);
    expect(norm3(subV(back.xyz, pf.xyz))).toBeLessThan(1e-8);
  });

  it('Helio→Pci→Helio is the identity translation (axes parallel, §1)', () => {
    const earthHelio = earthHelioPosition(T0);
    const pci = toPci(earthHelio, earthHelio); // a point AT the body centre: Pci origin
    expect(norm3(pci.xyz)).toBeLessThan(1e-6); // 1e-6 m of f64 ULP noise at 1.5e11 m
    const helioBack = toHelio(pci, earthHelio);
    expect(norm3(subV(helioBack.xyz, earthHelio.xyz))).toBeLessThan(1e-6);
  });

  it('ENU round trips through PlanetFixed at nanometre level', () => {
    for (const o of [ { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 100, y: -50, z: 3 } ]) {
      const pf = enuToPlanetFixed({ frame: Frame.enu('Earth'), xyz: o }, SITE);
      const back = toEnu(pf, SITE);
      expect(norm3(subV(back.xyz, o))).toBeLessThan(1e-8);
    }
  });

  it('Law V-1: a point fixed on the equator has ≈465 m/s in Pci and zero in PlanetFixed', () => {
    const rEquator = geodeticToPlanetFixed({ latitudeDeg: 0, longitudeDeg: 0, heightMetres: 0 });
    const still = pciVelocityFromPlanetFixed(rEquator.xyz, { x: 0, y: 0, z: 0 }, BODY, T0);
    const speed = norm3(still.velocityPciMetresPerSecond);
    expect(speed).toBeGreaterThan(464);
    expect(speed).toBeLessThan(466);
    // ω×r analytically, for the same point (derived form quoted by Law V-1):
    const analytic = EARTH_OMEGA_RAD_PER_S * norm3(rEquator.xyz);
    expect(Math.abs(speed - analytic)).toBeLessThan(1e-6);
  });

  it('Law V-1: chain transport term agrees with the library ObserverState to < 1e−3 m/s', () => {
    const rEquator = geodeticToPlanetFixed({ latitudeDeg: 0, longitudeDeg: 0, heightMetres: 0 });
    const still = pciVelocityFromPlanetFixed(rEquator.xyz, { x: 0, y: 0, z: 0 }, BODY, T0);
    const st = A.ObserverState(A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0))), new A.Observer(0, 0, 0), false);
    const libSpeed = Math.hypot(st.vx, st.vy, st.vz) * (AU_METRES / 86400);
    expect(Math.abs(norm3(still.velocityPciMetresPerSecond) - libSpeed)).toBeLessThan(1e-3);
  });

  it('Law V-1: a non-zero PlanetFixed velocity composes as transport ⊕ rotated local velocity', () => {
    const rPf = geodeticToPlanetFixed(SITE).xyz;
    const vPf = { x: 0, y: 1, z: 0 }; // 1 m/s north in the site's PlanetFixed axes
    const conv = pciVelocityFromPlanetFixed(rPf, vPf, BODY, T0);
    // The position leg must equal the plain position conversion (same matrix):
    const pciPosition = toPci(geodeticToPlanetFixed(SITE), BODY, T0);
    expect(norm3(subV(conv.positionPci, pciPosition.xyz))).toBeLessThan(1e-8);
    // The velocity must equal the still-case transport plus the chain-rotated walk:
    const still = pciVelocityFromPlanetFixed(rPf, { x: 0, y: 0, z: 0 }, BODY, T0);
    const t = A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)));
    const walkEqd = rotateZ(vPf, gastRadians(T0)); // PF → EQD: Rz(+GAST)
    const walkEqj = libraryRotate(A.Rotation_EQD_EQJ(t), walkEqd);
    const expected = { x: still.velocityPciMetresPerSecond.x + walkEqj.x, y: still.velocityPciMetresPerSecond.y + walkEqj.y, z: still.velocityPciMetresPerSecond.z + walkEqj.z };
    expect(norm3(subV(conv.velocityPciMetresPerSecond, expected))).toBeLessThan(1e-12);
  });
});

describe('engine/frames — f64/f32 discipline at the §12 step-8 boundary', () => {
  it('Law P-3: f64 subtraction of the heliocentric pair errs ~µm; f32-first errs ~12.6 km', () => {
    const pci = toPci(geodeticToPlanetFixed(SITE), BODY, T0);
    const earthHelio = earthHelioPosition(T0);
    const darHelio = toHelio(pci, earthHelio);
    const f64Back = toPci(darHelio, earthHelio);
    const f64Error = norm3(subV(f64Back.xyz, pci.xyz));
    expect(f64Error).toBeLessThan(1e-4);
    const fr = (x: number) => Math.fround(x);
    const f32Back: Vec3 = {
      x: fr(darHelio.xyz.x) - fr(earthHelio.xyz.x),
      y: fr(darHelio.xyz.y) - fr(earthHelio.xyz.y),
      z: fr(darHelio.xyz.z) - fr(earthHelio.xyz.z),
    };
    const f32Error = norm3(subV(f32Back, pci.xyz));
    expect(Math.abs(f32Error - SEEDS.f32CancellationMetres)).toBeLessThan(1);
    expect(Math.abs(f32Error - F32_CANCELLATION_AT_1AU_METRES)).toBeLessThan(1);
    expect(f32Error / f64Error).toBeGreaterThan(1e6);
  });

  it('f32-quantising the site’s PlanetFixed position moves it ~0.2 m (the jitter floating origin kills)', () => {
    const ecef = geodeticToPlanetFixed(SITE).xyz;
    const err = Math.hypot(ecef.x - f32Downcast(ecef.x), ecef.y - f32Downcast(ecef.y), ecef.z - f32Downcast(ecef.z));
    expect(err).toBeGreaterThan(0.05);
    expect(err).toBeLessThan(0.5);
  });
});

describe('engine/frames — deterministic fuzz round trips (fixed-seed LCG)', () => {
  const rnd = lcg(0x4b57_4554); // 'KWET'
  const fuzzSites: GeodeticCoord[] = Array.from({ length: 12 }, () => ({
    latitudeDeg: -80 + rnd() * 160,
    longitudeDeg: -180 + rnd() * 360,
    heightMetres: -1e5 + rnd() * 1.1e6,
  }));

  it('full-chain round trip holds the single-addition-rounding class at 12 fixed fuzz sites', () => {
    for (const site of fuzzSites) {
      const residual = fullChainResidualMetres(site, T0);
      // The full chain is floored by ONE f64 addition-rounding at ~1.5e11 m
      // (Pci + Earth helio): ≤ 0.5 ULP ≈ 1.53e−5 m [derived — §6 ladder row].
      // [MEASURED 2026-09-06: max 1.4288e−5 m over these 12 sites; the §12
      // seed site happens to measure 4.3735e−6 m (the doc's G-02 seed) — the
      // per-site value varies inside the 0.5-ULP class.]
      expect(residual).toBeLessThan(2e-5);
    }
  });

  it('rotation-only round trip holds the ~1e−9 m class at the same sites', () => {
    for (const site of fuzzSites) {
      const pf = geodeticToPlanetFixed(site);
      const pci = toPci(pf, BODY, T0);
      const pfBack = toPlanetFixed(pci, BODY, T0);
      expect(norm3(subV(pfBack.xyz, pf.xyz))).toBeLessThan(1e-7);
    }
  });

  it('ENU basis is orthonormal and Z-up at every fuzz site', () => {
    for (const site of fuzzSites) {
      const b = enuBasis(site.latitudeDeg, site.longitudeDeg);
      for (const v of [b.east, b.north, b.up]) {
        expect(Math.abs(Math.hypot(v.x, v.y, v.z) - 1)).toBeLessThan(1e-15);
      }
      expect(Math.abs(dot3(b.east, b.north))).toBeLessThan(1e-15);
      expect(Math.abs(dot3(b.east, b.up))).toBeLessThan(1e-15);
      expect(Math.abs(dot3(b.north, b.up))).toBeLessThan(1e-15);
      // Z-up (§8) means the ENU +z axis IS the ellipsoid outward normal: it
      // always points away from Earth's centre (up · radial ≈ 1; the residual
      // is the deflection of the vertical, ≤ ~0.19° on WGS84). up.z = sin(φ)
      // by the §5 formula — it is NEGATIVE at southern latitudes, so the
      // property is the outward dot, never the sign of the ECEF z component.
      const ecef = geodeticToPlanetFixed(site).xyz;
      const r = norm3(ecef);
      const outwardDot = dot3(b.up, { x: ecef.x / r, y: ecef.y / r, z: ecef.z / r });
      expect(outwardDot).toBeGreaterThan(0.999); // [MEASURED 2026-09-06: 0.99999969 at the §12 site]
      expect(Math.abs(b.up.z - Math.sin((site.latitudeDeg * Math.PI) / 180))).toBeLessThan(1e-15);
    }
  });
});

// --- test-side primitives for the library-oracle side of comparisons --------------------

function rotateZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

function libraryRotate(rot: A.RotationMatrix, v: Vec3): Vec3 {
  const out = A.RotateVector(rot, new A.Vector(v.x, v.y, v.z, A.MakeTime(0)));
  return { x: out.x, y: out.y, z: out.z };
}
