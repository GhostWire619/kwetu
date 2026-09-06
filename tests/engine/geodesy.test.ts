/**
 * Engine geodesy tests — WGS84 closed form, ENU triad, normal-gravity seam
 * (COORDINATE_SYSTEM.md §5; ADR-002 Decision 6 for the open reference choice).
 */
import { describe, expect, it } from 'vitest';
import {
  SPHERICAL_CENTRAL_GRAVITY,
  TANGENT_G_METRES_PER_S2,
  TANGENT_NORMAL_GRAVITY,
  WGS84_A_METRES,
  WGS84_B_METRES,
  WGS84_E2,
  WGS84_F,
  WGS84_INVF,
  ecefToEnu,
  ecefToGeodetic,
  enuBasis,
  enuToEcef,
  geodeticToEcef,
} from '../../client/src/engine/geodesy';
import { angleBetweenRadians, dot3, norm3, subV, type Vec3 } from '../../client/src/engine/vec3';

/** Deterministic LCG — fixed-seed fuzz, no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('engine/geodesy — WGS84 constants (§5)', () => {
  it('carries the exact survey constants and the derived e², b', () => {
    expect(WGS84_A_METRES).toBe(6378137.0);
    expect(WGS84_INVF).toBe(298.257223563);
    expect(WGS84_F).toBeCloseTo(1 / 298.257223563, 20);
    expect(WGS84_E2).toBeCloseTo(0.0066943799901413165, 18);
    expect(WGS84_B_METRES).toBeCloseTo(6356752.314245179, 6);
  });
});

describe('engine/geodesy — geodetic → ECEF closed form (§5)', () => {
  it('reproduces the §12 step-1 site coordinates', () => {
    const ecef = geodeticToEcef({ latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 });
    const seed: Vec3 = { x: 4907565.698, y: 4003939.392, z: -749078.231 };
    expect(norm3(subV(ecef, seed))).toBeLessThan(2e-3);
    expect(Math.hypot(ecef.x, ecef.y, ecef.z)).toBeCloseTo(6377840.5, 0); // doc: r ≈ 6 377 840.5 m
  });

  it('round-trips through the [PLACEHOLDER] inverse at fixed fuzz sites', () => {
    const rnd = lcg(0x00e0);
    for (let i = 0; i < 16; i++) {
      const coord = {
        latitudeDeg: -80 + rnd() * 160,
        longitudeDeg: -180 + rnd() * 360,
        heightMetres: -1e5 + rnd() * 1.1e6,
      };
      const ecef = geodeticToEcef(coord);
      const back = ecefToGeodetic(ecef);
      const ecefBack = geodeticToEcef(back);
      expect(norm3(subV(ecefBack, ecef))).toBeLessThan(1e-6);
    }
  });

  it('keeps metre-level agreement at the polar and high-height edges of its validated envelope', () => {
    for (const coord of [
      { latitudeDeg: 80, longitudeDeg: 0, heightMetres: 1e6 },
      { latitudeDeg: -80, longitudeDeg: 179, heightMetres: -1e5 },
      { latitudeDeg: 0, longitudeDeg: -90, heightMetres: 5e6 },
    ]) {
      const ecef = geodeticToEcef(coord);
      const back = ecefToGeodetic(ecef);
      expect(norm3(subV(geodeticToEcef(back), ecef))).toBeLessThan(1e-6);
    }
  });
});

describe('engine/geodesy — ENU triad (§5, Z-up §8)', () => {
  const SITE = { latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 };

  it('basis rows are the §5 formulas: orthonormal, east at equator = +x, up at equator = +x', () => {
    const b = enuBasis(0, 0);
    expect(b.east.x).toBeCloseTo(0, 15);
    expect(b.east.y).toBeCloseTo(1, 15);
    expect(b.up.x).toBeCloseTo(1, 15);
    const bEq = enuBasis(0, 90);
    expect(bEq.up.y).toBeCloseTo(1, 15);
    for (const v of [b.east, b.north, b.up]) expect(Math.abs(norm3(v) - 1)).toBeLessThan(1e-15);
  });

  it('up is the ellipsoid NORMAL: normal-offset lines recover the anchor lat/lon (ADR-002 evidence A)', () => {
    for (const h of [-100, 100, 1000]) {
      const p = enuToEcef({ x: 0, y: 0, z: h }, SITE);
      const back = ecefToGeodetic(p);
      const dLat = ((back.latitudeDeg - SITE.latitudeDeg) * Math.PI) / 180;
      const dLon = ((back.longitudeDeg - SITE.longitudeDeg) * Math.PI) / 180;
      expect(Math.max(Math.abs(dLat), Math.abs(dLon))).toBeLessThan(1e-12); // [MEASURED 1.24e−16 rad]
      expect(Math.abs(back.heightMetres - h)).toBeLessThan(1e-6);
    }
  });

  it('up is NOT the geocentric radial (deflection of the vertical is real at this site)', () => {
    const ecef = geodeticToEcef(SITE);
    const radial = { x: ecef.x / norm3(ecef), y: ecef.y / norm3(ecef), z: ecef.z / norm3(ecef) };
    const deflection = angleBetweenRadians(enuBasis(SITE.latitudeDeg, SITE.longitudeDeg).up, radial);
    expect(deflection).toBeGreaterThan(0);
    expect(deflection).toBeLessThan(0.01); // < 0.6° at this latitude [MEASURED 7.86e−4 rad]
  });

  it('ECEF↔ENU round trips 1 m-class offsets at nanometre level', () => {
    for (const o of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 100, y: -50, z: 3 }]) {
      const ecef = enuToEcef(o, SITE);
      const back = ecefToEnu(ecef, SITE);
      expect(norm3(subV(back, o))).toBeLessThan(1e-8);
    }
  });

  it('is right-handed: east × north = up', () => {
    const b = enuBasis(41.3, 2.1);
    const cross = {
      x: b.east.y * b.north.z - b.east.z * b.north.y,
      y: b.east.z * b.north.x - b.east.x * b.north.z,
      z: b.east.x * b.north.y - b.east.y * b.north.x,
    };
    expect(Math.abs(dot3(cross, b.up) - 1)).toBeLessThan(1e-15);
  });
});

describe('engine/geodesy — normal-gravity seam (ADR-002 Decision 6 OPEN)', () => {
  it('exposes the §8-permitted tangent constant and no more', () => {
    expect(TANGENT_NORMAL_GRAVITY.model).toContain('constant-tangent');
    expect(TANGENT_NORMAL_GRAVITY.at(-6.79, 0)).toBe(TANGENT_G_METRES_PER_S2);
    expect(TANGENT_NORMAL_GRAVITY.at(61.0, 500)).toBe(TANGENT_G_METRES_PER_S2); // deliberately latitude-blind
  });

  it('the spherical reference row measures the tangent constant’s +0.14% constant-choice offset (ADR-002 D)', () => {
    const central = SPHERICAL_CENTRAL_GRAVITY.at(0, 0);
    expect(central).toBeGreaterThan(9.819); // μ/R² ≈ 9.820 m/s²
    expect(central).toBeLessThan(9.821);
    const magnitudeError = central - TANGENT_G_METRES_PER_S2;
    expect(magnitudeError).toBeGreaterThan(0.0135); // [MEASURED 2026-09-05: +0.0136 m/s²]
    expect(magnitudeError).toBeLessThan(0.0137);
  });
});
