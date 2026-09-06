/**
 * Engine ephemeris-adapter tests — self-consistency against astronomy-engine
 * calls at the adapter boundary (COORDINATE_SYSTEM.md §1/§3/§10). Golden
 * fixtures (G-03, Python oracle) arrive via S0.11 and wire into
 * `GOLDEN_FIXTURE_PINS` — this suite pins the units/time contract they must
 * share: the library's AU constant crossed exactly once, and the TT bridge.
 */
import { describe, expect, it } from 'vitest';
import * as A from 'astronomy-engine';
import {
  AU_METRES,
  GOLDEN_FIXTURE_PINS,
  J2000_TT_EPOCH_UTC_MILLIS,
  TT_MINUS_UTC_SECONDS,
  astroTimeFromWorldTime,
  earthHelioPositionMetres,
  geoMoonPositionMetres,
  geoPositionMetres,
  helioPositionMetres,
  topoAltAzDeg,
  topoEnuPositionMetres,
  utcMillisFromWorldTimeTt,
  worldTimeTtFromUtcMillis,
  type WorldTimeTtSeconds,
} from '../../client/src/engine/ephemeris';
import { norm3, subV } from '../../client/src/engine/vec3';

const T0: WorldTimeTtSeconds = worldTimeTtFromUtcMillis(Date.UTC(2026, 8, 5, 0, 0, 0)); // the §12 instant
const SITE = { latitudeDeg: -6.79, longitudeDeg: 39.21, heightMetres: 0 };

/** The library call the adapter wraps, evaluated independently in the test. */
function libTime(): A.AstroTime {
  return A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)));
}

describe('engine/ephemeris — the AU boundary (Law U-1, §3)', () => {
  it('uses the library’s own KM_PER_AU, not the IAU 2012 exact definition', () => {
    expect(AU_METRES).toBe(A.KM_PER_AU * 1000);
    expect(A.KM_PER_AU).toBe(149597870.69098932); // [EXTERNAL — astronomy-engine 2.1.19]
    // The IAU 2012 exact value (149 597 870 700 m) differs by ~9 m per AU;
    // substituting it would corrupt every golden fixture by metres (§3).
    const iau2012 = 149597870700;
    const diff = Math.abs(AU_METRES - iau2012);
    expect(diff).toBeGreaterThan(8);
    expect(diff).toBeLessThan(10); // [MEASURED 2026-09-05: 9.0107 m]
  });

  it('helioPositionMetres crosses AU→m exactly once per component', () => {
    const hv = A.HelioVector(A.Body.Earth, libTime());
    const p = helioPositionMetres(A.Body.Earth, T0);
    expect(p.frame).toBe('Helio');
    expect(p.xyz.x).toBe(hv.x * AU_METRES);
    expect(p.xyz.y).toBe(hv.y * AU_METRES);
    expect(p.xyz.z).toBe(hv.z * AU_METRES);
  });

  it('earthHelioPositionMetres matches the generic body call', () => {
    const p = earthHelioPositionMetres(T0);
    const q = helioPositionMetres(A.Body.Earth, T0);
    expect(p.frame).toBe('Helio');
    expect(p.xyz.x).toBe(q.xyz.x);
    expect(p.xyz.y).toBe(q.xyz.y);
    expect(p.xyz.z).toBe(q.xyz.z);
  });
});

describe('engine/ephemeris — geocentric positions (Frame.Pci(Earth), EQJ axes)', () => {
  it('geoPositionMetres wraps GeoVector(geometric) with the single AU multiply', () => {
    const gv = A.GeoVector(A.Body.Moon, libTime(), false);
    const p = geoPositionMetres(A.Body.Moon, T0);
    expect(p.frame).toBe('Pci(Earth)');
    expect(p.xyz.x).toBe(gv.x * AU_METRES);
    expect(p.xyz.y).toBe(gv.y * AU_METRES);
    expect(p.xyz.z).toBe(gv.z * AU_METRES);
  });

  it('geoMoonPositionMetres wraps GeoMoon with the single AU multiply', () => {
    const gv = A.GeoMoon(libTime());
    const p = geoMoonPositionMetres(T0);
    expect(p.frame).toBe('Pci(Earth)');
    expect(p.xyz.x).toBe(gv.x * AU_METRES);
    expect(p.xyz.y).toBe(gv.y * AU_METRES);
    expect(p.xyz.z).toBe(gv.z * AU_METRES);
  });

  it('the Earth→Moon vector is recovered from two heliocentric positions (frame-parallel translation, §1)', () => {
    const moonHelio = helioPositionMetres(A.Body.Moon, T0).xyz;
    const earthHelio = earthHelioPositionMetres(T0).xyz;
    const viaHelio = subV(moonHelio, earthHelio);
    const viaGeoMoon = geoMoonPositionMetres(T0).xyz;
    // Both paths are library geometries at the same instant; they agree far
    // below any gameplay scale (the residual is the library's own Moon-model
    // bookkeeping between HelioVector and GeoMoon).
    const residual = norm3(subV(viaHelio, viaGeoMoon));
    expect(residual).toBeLessThan(1.0); // [MEASURED 2026-09-06: 8.5e-4 m at the §12 instant]
  });
});

describe('engine/ephemeris — the authoritative time bridge (§4)', () => {
  it('J2000 TT epoch maps to worldTime 0 and back', () => {
    expect(TT_MINUS_UTC_SECONDS).toBe(69.184); // TAI−UTC 37 s + TT−TAI 32.184 s [EXTERNAL — IERS]
    expect(worldTimeTtFromUtcMillis(J2000_TT_EPOCH_UTC_MILLIS)).toBe(0);
    expect(utcMillisFromWorldTimeTt(0)).toBe(J2000_TT_EPOCH_UTC_MILLIS);
    expect(J2000_TT_EPOCH_UTC_MILLIS).toBe(Date.UTC(2000, 0, 1, 11, 58, 55, 816));
  });

  it('round trips integer-millisecond UTC instants exactly inside the pinned era', () => {
    for (const millis of [
      Date.UTC(2026, 8, 5, 0, 0, 0),
      Date.UTC(2000, 0, 1, 12, 0, 0),
      Date.UTC(2025, 0, 1, 12, 34, 56, 789),
      Date.UTC(2030, 11, 31, 23, 59, 59, 999),
    ]) {
      expect(utcMillisFromWorldTimeTt(worldTimeTtFromUtcMillis(millis))).toBe(millis);
    }
  });

  it('feeds the library the same instant as its own UT interpretation of the UTC Date', () => {
    const t = astroTimeFromWorldTime(T0);
    expect(t.ut).toBe(A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0))).ut);
    expect(t.tt).toBe(A.MakeTime(new Date(Date.UTC(2026, 8, 5, 0, 0, 0))).tt);
  });

  it('worldTime is a simulation number, not a Date (type-level + arithmetic sanity)', () => {
    // One simulated hour later: pure arithmetic on TT seconds (§4 — the
    // adapter never reads a wall clock; wall-clock anchoring is the host's).
    const t1: WorldTimeTtSeconds = T0 + 3600;
    expect(utcMillisFromWorldTimeTt(t1) - utcMillisFromWorldTimeTt(T0)).toBe(3600 * 1000);
  });
});

describe('engine/ephemeris — topocentric ENU + alt/az at a geodetic anchor', () => {
  it('range equals the EQJ topocentric distance (an orthonormal rotation preserves the norm)', () => {
    const t = libTime();
    const obs = new A.Observer(SITE.latitudeDeg, SITE.longitudeDeg, SITE.heightMetres);
    const geo = A.GeoVector(A.Body.Moon, t, false);
    const obsVec = A.ObserverVector(t, obs, false);
    const expectedRange = Math.hypot(geo.x - obsVec.x, geo.y - obsVec.y, geo.z - obsVec.z) * AU_METRES;
    const enu = topoEnuPositionMetres(A.Body.Moon, T0, SITE);
    expect(enu.frame).toBe('Enu(Earth)');
    expect(Math.abs(norm3(enu.xyz) - expectedRange)).toBeLessThan(1e-9);
  });

  it('alt/az matches the library’s own horizon-vector convention (HOR: x north, y west, z zenith)', () => {
    for (const body of [A.Body.Moon, A.Body.Sun, A.Body.Mars]) {
      const enu = topoEnuPositionMetres(body, T0, SITE);
      // ENU → HOR: north = +y_enu, west = −x_enu, zenith = +z_enu.
      const hor = new A.Vector(enu.xyz.y, -enu.xyz.x, enu.xyz.z, libTime());
      // No refraction on either side: the library accepts 'normal', 'jplhor'
      // or a FALSY value (= none, verified in its source); its .d.ts types the
      // parameter as `string`, so the falsy form needs the documented cast.
      const sph = A.HorizonFromVector(hor, null as unknown as string);
      const mine = topoAltAzDeg(enu.xyz);
      expect(Math.abs(mine.altitudeDeg - sph.lat)).toBeLessThan(1e-9);
      expect(Math.abs(mine.azimuthDeg - sph.lon)).toBeLessThan(1e-9);
    }
  });

  it('topoAltAzDeg follows the navigation convention: az 0 = north, 90 = east, clockwise', () => {
    expect(topoAltAzDeg({ x: 0, y: 1, z: 0 }).azimuthDeg).toBeCloseTo(0, 12); // north
    expect(topoAltAzDeg({ x: 1, y: 0, z: 0 }).azimuthDeg).toBeCloseTo(90, 12); // east
    expect(topoAltAzDeg({ x: 0, y: -1, z: 0 }).azimuthDeg).toBeCloseTo(180, 12); // south
    expect(topoAltAzDeg({ x: -1, y: 0, z: 0 }).azimuthDeg).toBeCloseTo(270, 12); // west
    const up = topoAltAzDeg({ x: 0, y: 0, z: 1 });
    expect(up.altitudeDeg).toBeCloseTo(90, 12);
    // 30° elevation due east: east component cos(30°), up component sin(30°).
    const east30 = topoAltAzDeg({ x: Math.cos((30 * Math.PI) / 180), y: 0, z: Math.sin((30 * Math.PI) / 180) });
    expect(east30.altitudeDeg).toBeCloseTo(30, 12);
    expect(east30.azimuthDeg).toBeCloseTo(90, 12);
    const s = Math.SQRT1_2;
    const north45 = topoAltAzDeg({ x: 0, y: s, z: s });
    expect(north45.altitudeDeg).toBeCloseTo(45, 12);
    expect(north45.azimuthDeg).toBeCloseTo(0, 12);
  });
});

describe('engine/ephemeris — the G-03 golden-fixture seam (S0.11)', () => {
  it('pins the generation contract fixtures must record (§11: a different pin is a different fixture)', () => {
    expect(GOLDEN_FIXTURE_PINS.astronomyEngineVersion).toBe('2.1.19');
    expect(GOLDEN_FIXTURE_PINS.auConstantMetres).toBe(AU_METRES);
    expect(GOLDEN_FIXTURE_PINS.ttMinusUtcSeconds).toBe(TT_MINUS_UTC_SECONDS);
  });
});
