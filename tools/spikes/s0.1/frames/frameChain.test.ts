/**
 * S0.1 probe A — frame-chain probe runner (throwaway spike, vitest).
 * Asserts the doc invariants against the worked example of COORDINATE_SYSTEM.md §12.
 */
import { describe, it, expect } from 'vitest';
import {
  collectFrameReport,
  DOC_SEEDS,
  geodeticToPlanetFixed,
  planetFixedToPci,
  pciToPlanetFixed,
  planetFixedToEnu,
  enuToPlanetFixed,
  enuBasis,
  dot3,
  norm3,
  siteInstant,
  SITE,
} from './frameChain.ts';

describe('S0.1 A: f64 frame chain (Helio -> Pci -> PlanetFixed -> Geodetic/ENU)', () => {
  const report = collectFrameReport();

  it('reproduces the §12 committed seeds (GAST, ECEF, Pci, Helio)', () => {
    expect(report.gastDeg).toBeCloseTo(DOC_SEEDS.gastDeg, 2); // doc shows 3 dp
    expect(report.ecefVsDocSeedMaxComponentErrorMetres).toBeLessThan(2e-3);
    expect(report.pciVsDocSeedMaxComponentErrorMetres).toBeLessThan(2e-3);
    const helioErr = Math.max(
      ...report.earthHelioMetresValue.map((v, i) => Math.abs(v - DOC_SEEDS.earthHelioMetres[i])),
    );
    expect(helioErr).toBeLessThan(2e-3);
    const darHelioErr = Math.max(
      ...report.darHelioMetresValue.map((v, i) => Math.abs(v - DOC_SEEDS.darHelioMetres[i])),
    );
    expect(darHelioErr).toBeLessThan(2e-3);
  });

  it('round-trips the site through the FULL chain (incl. Helio) to sub-10 µm (G-02 class)', () => {
    // Doc seed: ≤ 4.4e-6 m [MEASURED 2026-09-05]. Assert the same class.
    expect(report.roundTripFullChainResidualMetres).toBeLessThan(1e-5);
    expect(report.roundTripFullChainResidualMetres).toBeGreaterThan(0);
  });

  it('round-trips the rotation-only hop far below the full-chain residual', () => {
    // Rotation + geodesy noise lives at f64 ULP of Earth radius (~1 nm class).
    expect(report.roundTripRotationOnlyResidualMetres).toBeLessThan(1e-7);
    expect(report.roundTripRotationOnlyResidualMetres).toBeLessThan(report.roundTripFullChainResidualMetres / 10);
  });

  it('matches the library horizon-frame zenith (G-01 class, machine precision)', () => {
    expect(report.libraryEndpointCheckMetres).toBeLessThan(1e-6);
    expect(report.g01ZenithSelfConsistencyDeg).toBeLessThan(1e-12);
  });

  it('ENU up is the ellipsoid normal: normal-offset lines recover the anchor lat/lon', () => {
    for (const check of report.enuUpRadialChecks) {
      expect(check.latLonRecoveredEqualsAnchor, `offset ${check.offsetHeightMetres} m`).toBe(true);
      expect(Math.abs(check.heightResidualMetres)).toBeLessThan(1e-6);
    }
  });

  it('quantifies that ENU up is NOT the geocentric radial (deflection of the vertical)', () => {
    expect(report.enuUpVsGeocentricRadialAngleRad).toBeGreaterThan(0);
    expect(report.enuUpVsGeocentricRadialAngleRad).toBeLessThan(0.01); // < 0.6° at this latitude
  });

  it('reproduces the §12 step-8 f32 cancellation catastrophe and the f64 safety margin', () => {
    expect(report.f32Cancellation.f32SubtractionErrorMetres).toBeGreaterThan(1000); // kilometres
    expect(Math.abs(report.f32Cancellation.f32SubtractionErrorMetres - DOC_SEEDS.f32CancellationMetres)).toBeLessThan(1);
    expect(report.f32Cancellation.f64SubtractionErrorMetres).toBeLessThan(1e-4); // tens of nanometres..µm class
    expect(
      report.f32Cancellation.f32SubtractionErrorMetres /
        Math.max(report.f32Cancellation.f64SubtractionErrorMetres, 1e-12),
    ).toBeGreaterThan(1e6);
  });

  it('f32-quantising the site PlanetFixed position moves it ~0.2 m (the jitter floating origin kills)', () => {
    expect(report.f32QuantisationOfSitePosition.vectorErrorMetres).toBeGreaterThan(0.05);
    expect(report.f32QuantisationOfSitePosition.vectorErrorMetres).toBeLessThan(0.5);
  });

  it('Law V-1: transport term at the equator is ~465 m/s, chain agrees with the library', () => {
    expect(report.transportVelocity.chainEquatorSpeedMetresPerSecond).toBeGreaterThan(464);
    expect(report.transportVelocity.chainEquatorSpeedMetresPerSecond).toBeLessThan(466);
    expect(Math.abs(report.transportVelocity.chainVsLibraryDiffMetresPerSecond)).toBeLessThan(1e-3);
  });

  it('LocalScene hop (§12 steps 7-8): door − eye holds nm-class noise; the single f32 downcast stays mm-exact', () => {
    const s = report.localSceneStep;
    // The door−eye difference carries only f64 ULP noise at Earth radius (~1 nm).
    expect(s.doorMinusEyeMaxDeviationFromExactMetres).toBeLessThan(1e-8);
    // Same class as the doc's committed step-7 seed (deviation shown rounded there).
    expect(s.doorMinusEyeDeviationFromSeedMetres).toBeLessThan(1e-8);
    // Step 8: camera space is small numbers; f32 downcast is mm-exact at 100 m.
    expect(Math.abs(s.cameraSpaceF32[0])).toBeLessThan(1e-6);
    expect(s.cameraSpaceF32[1]).toBeCloseTo(1.3, 6);
    expect(s.cameraSpaceF32[2]).toBeCloseTo(-100, 6);
  });

  it('is frame-tagged end to end: ENU round-trips through PlanetFixed at nm level', () => {
    // A 1 m offset expressed in ENU must survive the round trip to PlanetFixed and back.
    const offsets: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [100, -50, 3],
    ];
    for (const o of offsets) {
      const pf = enuToPlanetFixed(o, SITE);
      const back = planetFixedToEnu(pf, SITE);
      expect(norm3([back[0] - o[0], back[1] - o[1], back[2] - o[2]])).toBeLessThan(1e-8);
    }
  });

  it('Pci->PlanetFixed inverse composed with PlanetFixed->Pci is the identity (rotation pair check)', () => {
    const t = siteInstant();
    const p = geodeticToPlanetFixed(SITE.latitudeDeg, SITE.longitudeDeg, 123.456);
    const pci = planetFixedToPci(p, t);
    const back = pciToPlanetFixed(pci, t);
    expect(norm3([back[0] - p[0], back[1] - p[1], back[2] - p[2]])).toBeLessThan(1e-8);
  });

  it('ENU basis rows are orthonormal unit vectors', () => {
    const b = enuBasis(SITE.latitudeDeg, SITE.longitudeDeg);
    for (const v of [b.east, b.north, b.up]) {
      expect(Math.abs(norm3(v) - 1)).toBeLessThan(1e-15);
    }
    expect(Math.abs(dot3(b.east, b.north))).toBeLessThan(1e-15);
    expect(Math.abs(dot3(b.east, b.up))).toBeLessThan(1e-15);
    expect(Math.abs(dot3(b.north, b.up))).toBeLessThan(1e-15);
  });
});
