/**
 * S0.1 probe D — tangent-gravity error probe runner (throwaway spike, vitest).
 *
 * Asserts the measured tangent-approximation error table that feeds the
 * contact-bubble extent bound Law P-5 requires. Bounds are the measured
 * classes; a failing bound is a finding, not a threshold to loosen.
 */
import { describe, it, expect } from 'vitest';
import { collectGravityReport, DISPLACEMENTS_METRES, R_METRES, EARTH_GM_M3_PER_S2, TANGENT_G_METRES_PER_S2 } from './gravityProbe.ts';

describe('S0.1 D: tangent gravity vs central gravity (Earth mean radius)', () => {
  const report = collectGravityReport();
  const rowAt = (d: number) => report.rows.find((r) => r.displacementMetres === d)!;

  it('builds the full displacement ladder', () => {
    expect(DISPLACEMENTS_METRES).toEqual([0, 100, 1000, 10000, 100000, 1e6]);
    expect(report.rows).toHaveLength(DISPLACEMENTS_METRES.length);
    expect(report.radiusMetres).toBe(R_METRES);
  });

  it('d = 0: direction error is zero; magnitude error is the g-constant choice (~0.0136 m/s^2)', () => {
    const r = rowAt(0);
    expect(r.angularDirectionErrorRad).toBe(0);
    expect(r.trueGravityMetresPerSecond2).toBeCloseTo(EARTH_GM_M3_PER_S2 / (R_METRES * R_METRES), 12);
    expect(r.magnitudeErrorMetresPerSecond2).toBeGreaterThan(0.013);
    expect(r.magnitudeErrorMetresPerSecond2).toBeLessThan(0.014);
    expect(r.magnitudeRelativeError).toBeGreaterThan(1.3e-3);
    expect(r.magnitudeRelativeError).toBeLessThan(1.5e-3);
  });

  it('direction error grows ~d/R: 1.57e-4 rad at 1 km, 1.57e-2 rad (0.90°) at 100 km', () => {
    // Small-angle regime: the exact angle is acos(R/sqrt(R^2+d^2)) ~ d/R.
    const at = (d: number) => rowAt(d).angularDirectionErrorRad;
    expect(at(100)).toBeCloseTo(100 / R_METRES, 7);
    expect(at(1000)).toBeCloseTo(1000 / R_METRES, 5);
    expect(at(10000)).toBeCloseTo(10000 / R_METRES, 3);
    expect(at(100000)).toBeCloseTo(100000 / R_METRES, 1);
    // 1e6 m leaves the small-angle regime; only bounds.
    expect(at(1e6)).toBeGreaterThan(0.14);
    expect(at(1e6)).toBeLessThan(0.17);
    for (let i = 1; i < report.rows.length; i++) {
      expect(report.rows[i].angularDirectionErrorRad).toBeGreaterThan(report.rows[i - 1].angularDirectionErrorRad);
    }
  });

  it('magnitude error stays ~1e-2 m/s^2 until 100 km; curvature term is (d/R)^2-class', () => {
    const at = (d: number) => rowAt(d);
    for (const d of [100, 1000, 10000, 100000]) {
      expect(Math.abs(at(d).magnitudeErrorMetresPerSecond2)).toBeLessThan(0.014);
      expect(Math.abs(at(d).magnitudeErrorMetresPerSecond2)).toBeGreaterThan(0.010);
    }
    // At 1e6 m the curvature term dominates: true field 9.584 vs constant 9.80665.
    expect(rowAt(1e6).magnitudeErrorMetresPerSecond2).toBeLessThan(-0.2);
    // Curvature drop matches the geometric 1 - R^2/(R^2+d^2) to fp noise.
    for (const r of report.rows) {
      const d = r.displacementMetres;
      const geometric = d === 0 ? 0 : 1 - (R_METRES * R_METRES) / (R_METRES * R_METRES + d * d);
      expect(r.curvatureRelativeMagnitudeDrop).toBeCloseTo(geometric, 15);
    }
    expect(rowAt(100000).curvatureRelativeMagnitudeDrop).toBeCloseTo(2.4631e-4, 7);
    expect(rowAt(1e6).curvatureRelativeMagnitudeDrop).toBeCloseTo(2.404e-2, 4);
  });

  it('spurious lateral acceleration feeds the Law P-5 bubble bound: 1.5e-3 m/s^2 at 1 km, 1.5e-2 at 10 km', () => {
    const at = (d: number) => rowAt(d).spuriousLateralAccelerationMetresPerSecond2;
    expect(at(100)).toBeLessThan(2e-4);
    expect(at(1000)).toBeGreaterThan(1e-3);
    expect(at(1000)).toBeLessThan(2e-3);
    expect(at(10000)).toBeGreaterThan(1.4e-2);
    expect(at(10000)).toBeLessThan(1.7e-2);
    expect(at(100000)).toBeGreaterThan(0.14);
    expect(at(100000)).toBeLessThan(0.17);
    expect(at(1e6)).toBeGreaterThan(1.3);
    // Consistency: lateral = |g| * sin(dirErr).
    for (const r of report.rows) {
      expect(r.spuriousLateralAccelerationMetresPerSecond2).toBeCloseTo(
        r.trueGravityMetresPerSecond2 * Math.sin(r.angularDirectionErrorRad),
        12,
      );
    }
  });

  it('60 s ballistic playback: the lateral miss is metres at 1 km extent, hundreds of metres at 100 km', () => {
    const at = (d: number) => rowAt(d).lateralMissOver60sMetres;
    expect(at(100)).toBeLessThan(0.5); // measured 0.28 m
    expect(at(1000)).toBeGreaterThan(2);
    expect(at(1000)).toBeLessThan(3.5); // measured 2.77 m
    expect(at(10000)).toBeGreaterThan(25);
    expect(at(10000)).toBeLessThan(30); // measured 27.7 m
    expect(at(100000)).toBeGreaterThan(250);
    expect(at(100000)).toBeLessThan(300); // measured 277.3 m
  });

  it('azimuth symmetry on the sphere: east and north displacements agree to fp zero', () => {
    expect(report.maxAzimuthSymmetryDeviation.angularErrorRad).toBe(0);
    expect(report.maxAzimuthSymmetryDeviation.magnitudeMetresPerSecond2).toBe(0);
  });

  it('the tangent constant of §8 is 9.80665 and the method is recorded', () => {
    expect(report.tangentGMetresPerSecond2).toBe(TANGENT_G_METRES_PER_S2);
    expect(report.method).toContain('central');
    expect(report.sphericalModelNote).toContain('deflection');
  });
});
