/**
 * S0.7 probe — astronomy-engine cross-check + report collector (THROWAWAY spike code).
 *
 * Cross-checks the ttClock adapter's TT scale against astronomy-engine 2.1.19's own
 * J2000-days convention, and measures the library's internal time-scale behavior
 * (the material for ADR-008's "TT vs the ephemeris provider" open item):
 *
 *   - `new AstroTime(date)` (2.1.19 source): ut = (date.ms − J2000.ms)/86400000 with
 *     J2000 = new Date('2000-01-01T12:00:00Z'); tt = ut + DeltaT_EspenakMeeus(ut)/86400.
 *     So the library's Date input timeline is UT, and its TT comes from a ΔT MODEL,
 *     not a leap-second table (TT−UTC is not representable in its Date input).
 *   - `AstroTime.FromTerrestrialTime(tt)` (exported, 2.1.19): solves ut such that
 *     tt = ut + ΔT_model(ut) to 1e-12 day — the library's own sanctioned boundary
 *     for callers that already hold a TT instant. This is the ephemeris feed.
 *   - Earth rotation (era(), used by SiderealTime) consumes time.ut; nutation/polynomial
 *     parts consume time.tt — BOTH must be right, which FromTerrestrialTime delivers.
 */
import * as A from 'astronomy-engine';
// ttClock was promoted to the engine per ADR-008; the cross-check harness stays
// in the spike dir and imports the promoted module.
import { J2000_TT_POSIX_MS, UniverseClock, ttFromUtcIso, ulp64 } from '../../../client/src/engine/ttClock';

/** The library's own epoch constant, as a POSIX ms label (2.1.19: J2000 = new Date('2000-01-01T12:00:00Z')). */
export const LIB_J2000_POSIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Days-per-second and seconds-per-day helpers (f64-exact constants). */
const SEC_PER_DAY = 86400;

/** Sample TT instants (integer ms so Date placement stays exact): span 1995..2026 + J2000 + ms-level. */
export const SAMPLE_TT_SECONDS: readonly number[] = [
  0, // J2000 TT
  -150_000_000, // ~1995-03
  100_000_000, // ~2003-04
  250_000_000, // ~2007-12
  500_000_000, // ~2015-11
  840_000_000, // ~2026-08-31
  840_000_000.123, // ms-level offset within 2026
];

export interface CrossCheckRow {
  ttSeconds: number;
  ttDays: number;
  /** |FromTerrestrialTime(tt).tt − tt| in days — the library's own TT-boundary residual. */
  fromTtResidualDays: number;
  /** |MakeTime(Date(libEpoch + tt·1000)).ut − tt/86400| — the library's linear UT-days convention. */
  utConventionResidualDays: number;
  /** ΔT the library would apply if the TT instant were naively fed as a Date: (tt − ut)·86400 s. */
  naiveDateDeltaTSeconds: number;
}

export function crossCheckRow(tt: number): CrossCheckRow {
  const ttDays = tt / SEC_PER_DAY;
  const solved = A.AstroTime.FromTerrestrialTime(ttDays);
  const asDate = new A.AstroTime(new Date(LIB_J2000_POSIX_MS + tt * 1000));
  return {
    ttSeconds: tt,
    ttDays,
    fromTtResidualDays: Math.abs(solved.tt - ttDays),
    utConventionResidualDays: Math.abs(asDate.ut - ttDays),
    naiveDateDeltaTSeconds: (asDate.tt - asDate.ut) * SEC_PER_DAY,
  };
}

/**
 * GAST conflation at the COORDINATE_SYSTEM.md §12 instant (2026-09-05T00:00:00Z):
 * correct feed = FromTerrestrialTime (tt right for nutation, ut right for Earth
 * rotation) vs the naive feed that places the TT instant on the library's UT
 * timeline with its epoch constant. Measured in degrees of sidereal angle.
 */
export function gastConflation(): { correctGastDeg: number; naiveGastDeg: number; errorDeg: number } {
  const tt = ttFromUtcIso('2026-09-05T00:00:00Z');
  const correct = A.SiderealTime(A.AstroTime.FromTerrestrialTime(tt / SEC_PER_DAY)) * 15;
  const naive = A.SiderealTime(new A.AstroTime(new Date(LIB_J2000_POSIX_MS + tt * 1000))) * 15;
  let err = Math.abs(naive - correct);
  if (err > 180) err = 360 - err; // sidereal angle wraps
  return { correctGastDeg: correct, naiveGastDeg: naive, errorDeg: err };
}

/** Measured f64 spacing of the tt scale at the current epoch. */
export function ttPrecisionAt2026(): { ttSeconds: number; ulpSeconds: number; ulpDays: number } {
  const tt = ttFromUtcIso('2026-09-06T12:00:00Z');
  const u = ulp64(tt);
  return { ttSeconds: tt, ulpSeconds: u, ulpDays: u / SEC_PER_DAY };
}

export interface FullProbeReport {
  libJ2000OriginCheck: { utAtLibEpoch: number; exactZero: boolean };
  rows: CrossCheckRow[];
  maxFromTtResidualDays: number;
  maxUtConventionResidualDays: number;
  maxNaiveDateDeltaTSeconds: number;
  gastConflationAtS12: { instantIso: string; correctGastDeg: number; naiveGastDeg: number; errorDeg: number };
  ttPrecisionAt2026: { ttSeconds: number; ulpSeconds: number; ulpDays: number };
  j2000TtPosixMs: number;
}

export function collectCrossCheckReport(): FullProbeReport {
  const rows = SAMPLE_TT_SECONDS.map(crossCheckRow);
  const utAtLibEpoch = A.MakeTime(new Date(LIB_J2000_POSIX_MS)).ut;
  const gast = gastConflation();
  return {
    libJ2000OriginCheck: { utAtLibEpoch, exactZero: utAtLibEpoch === 0 },
    rows,
    maxFromTtResidualDays: Math.max(...rows.map((r) => r.fromTtResidualDays)),
    maxUtConventionResidualDays: Math.max(...rows.map((r) => r.utConventionResidualDays)),
    maxNaiveDateDeltaTSeconds: Math.max(...rows.map((r) => r.naiveDateDeltaTSeconds)),
    gastConflationAtS12: { instantIso: '2026-09-05T00:00:00Z', ...gast },
    ttPrecisionAt2026: ttPrecisionAt2026(),
    j2000TtPosixMs: J2000_TT_POSIX_MS,
  };
}

/** Restart/resume drift measurement shared by the test suite and the report. */
export interface ResumeProbe {
  anchorWallIso: string;
  savedTtSeconds: number;
  downtimeSeconds: number;
  expectedTtSeconds: number;
  resumedTtSeconds: number;
  /** |resumed − (tt(savedAtUtc) + naive civil seconds)| — accumulated f64 rounding vs the naive expectation. */
  resumeDriftSeconds: number;
  exactContinuation: boolean;
}

/**
 * Deterministic resume probe: 5 s of process life, serialize, 60 s civil
 * downtime (host wall jumps forward; the new process's monotonic clock starts
 * at 0), resume, and measure the continuation residual against the exact
 * f64 expression (savedTt + downtime) the resume anchors on.
 */
export function runResumeProbe(): ResumeProbe {
  const T0_WALL_MS = Date.UTC(2026, 8, 6, 12, 0, 0); // 2026-09-06T12:00:00Z
  let monoMs = 0;
  let wallMs = T0_WALL_MS;
  const clock1 = UniverseClock.start({ nowMonoMs: () => monoMs, nowWallMs: () => wallMs });
  monoMs += 5000;
  wallMs += 5000; // wall advances with the process lifetime before the save
  const state = clock1.serialize();
  // Restart: fresh process (mono at 0), wall advanced by 60 s of civil downtime.
  const downtimeMs = 60_000;
  const wall2 = T0_WALL_MS + 5000 + downtimeMs;
  const { clock: clock2, report } = UniverseClock.resume(state, {
    nowMonoMs: () => 0,
    nowWallMs: () => wall2,
  });
  const expected = state.worldTimeTtSeconds + report.downtimeSeconds;
  const resumed = clock2.nowTt();
  // Naive civil expectation: anchor tt at process start + total elapsed (5 s life + 60 s downtime).
  const naiveCivil = ttFromUtcIso(new Date(T0_WALL_MS).toISOString()) + (5000 + downtimeMs) / 1000;
  return {
    anchorWallIso: new Date(T0_WALL_MS).toISOString(),
    savedTtSeconds: state.worldTimeTtSeconds,
    downtimeSeconds: report.downtimeSeconds,
    expectedTtSeconds: expected,
    resumedTtSeconds: resumed,
    resumeDriftSeconds: Math.abs(resumed - naiveCivil),
    exactContinuation: resumed === expected && report.downtimeSeconds === downtimeMs / 1000,
  };
}
