/**
 * TT universe clock tests — promoted from the S0.7 spike per ADR-008.
 *
 * Encodes the ADR-001 Decision 3 clock semantics and the COORDINATE_SYSTEM.md §4
 * time contract as executable checks, plus the S0.7 exit-criterion measurements:
 * known epochs, the 2017 leap boundary, astronomy-engine cross-check (<= 1e-9 day),
 * warp zero-divergence, and exact restart/resume. These are now regression
 * coverage for client/src/engine/ttClock.ts, not throwaway probes.
 */
import { describe, expect, it } from 'vitest';
import * as A from 'astronomy-engine';
import {
  J2000_TT_POSIX_MS,
  MS_PER_DAY,
  TAI_MINUS_TT_SECONDS,
  TIME_ADAPTER_REVISION,
  UniverseClock,
  taiMinusUtcAtPosixMs,
  ttFromUtcIso,
  ttNow,
  utcIsoFromTt,
  ulp64,
  validateLeapTable,
  type ClockStateV1,
} from '../../client/src/engine/ttClock';
import { LIB_J2000_POSIX_MS, collectCrossCheckReport, crossCheckRow, runResumeProbe, SAMPLE_TT_SECONDS } from '../../tools/spikes/s0.7/crossCheck';

// Deterministic fakes: the ONLY sim-time source in tests is the monotonic fake.
function fakeHosts(wallStartMs: number) {
  let monoMs = 0;
  let wallMs = wallStartMs;
  return {
    deps: { nowMonoMs: (): number => monoMs, nowWallMs: (): number => wallMs },
    setMonoMs: (v: number): void => { monoMs = v; },
    advanceMonoMs: (d: number): void => { monoMs += d; },
    setWallMs: (v: number): void => { wallMs = v; },
    get mono(): number { return monoMs; },
    get wall(): number { return wallMs; },
  };
}

const T0_2026 = Date.UTC(2026, 8, 6, 12, 0, 0); // 2026-09-06T12:00:00Z
const SEC_PER_DAY = 86400;

describe('S0.7 leap table (B-TIME-02 provenance + coverage)', () => {
  it('validates structurally and covers every leap second through 2026', () => {
    const v = validateLeapTable();
    // 10 s base at 1972-01-01 + 27 insertions = 37 s current (B-TIME-02).
    expect(v.entries).toBe(28);
    expect(v.first).toBe('1972-01-01');
    expect(v.last).toBe('2017-01-01');
    expect(v.current).toBe(37);
  });

  it('carries TAI-UTC = 37 s from 2017-01-01 and 36 s the instant before', () => {
    expect(taiMinusUtcAtPosixMs(Date.UTC(2017, 0, 1))).toBe(37);
    expect(taiMinusUtcAtPosixMs(Date.UTC(2016, 11, 31, 23, 59, 59, 999))).toBe(36);
  });

  it('refuses to extrapolate before table coverage (1972-01-01)', () => {
    expect(() => taiMinusUtcAtPosixMs(Date.UTC(1971, 11, 31, 23, 59, 59, 999))).toThrow(/coverage/);
  });
});

describe('S0.7 known points (UTC <-> TT)', () => {
  it('maps J2000.0: 2000-01-01T11:58:55.816Z is TT 0 exactly, both directions', () => {
    expect(ttFromUtcIso('2000-01-01T11:58:55.816Z')).toBe(0);
    expect(utcIsoFromTt(0)).toBe('2000-01-01T11:58:55.816Z');
    expect(J2000_TT_POSIX_MS).toBe(Date.UTC(2000, 0, 1, 12, 0, 0) - 32_000 - TAI_MINUS_TT_SECONDS * 1000);
  });

  it('applies TT = TAI + 32.184 on top of the leap offset (2017 sample)', () => {
    // From the J2000 TT label, civil labels advance 1:1 but 5 leap seconds were
    // inserted between 2000 and 2017 (33..37 vs 32 at J2000): 5 s of extra TT.
    const expectedSeconds = (Date.UTC(2017, 0, 1) - J2000_TT_POSIX_MS) / 1000 + (37 - 32);
    expect(ttFromUtcIso('2017-01-01T00:00:00Z')).toBeCloseTo(expectedSeconds, 9);
    // And TT = TAI + 32.184 shows up as the .816/.184 sub-second part of the J2000 label.
    expect(J2000_TT_POSIX_MS % 1000).toBe(816);
  });

  it('round-trips POSIX labels exactly across every table boundary', () => {
    const samples = [
      '1972-01-01T00:00:00.000Z', // first covered instant
      '1999-12-31T23:59:59.999Z',
      '2000-01-01T11:58:55.816Z', // J2000 TT
      '2006-01-01T00:00:00.000Z', // step 32 -> 33
      '2012-07-01T00:00:00.000Z', // step 34 -> 35
      '2015-07-01T00:00:00.000Z', // step 35 -> 36
      '2016-12-31T23:59:59.999Z', // last label before the 2017 step
      '2017-01-01T00:00:00.000Z', // step 36 -> 37
      '2026-09-06T12:00:00.000Z',
    ];
    for (const iso of samples) {
      // Output contract: always .sss.mmmZ (ms resolution, 3 digits).
      expect(utcIsoFromTt(ttFromUtcIso(iso))).toBe(iso);
    }
  });

  it('rejects leap-second labels (:60) — POSIX cannot express them', () => {
    expect(() => ttFromUtcIso('2016-12-31T23:59:60Z')).toThrow(/leap second/);
  });
});

describe('S0.7 monotonicity across the 2017 leap insertion', () => {
  it('is strictly increasing with exactly one +1 s TT step in the 2016-06..2017-06 window', () => {
    const start = Date.UTC(2016, 5, 1);
    const end = Date.UTC(2017, 5, 1);
    const stepMs = 6 * 3600 * 1000; // 6 h
    let prev = ttFromUtcIso(new Date(start).toISOString());
    let anomalies = 0;
    let anomalyValue = 0;
    for (let ms = start + stepMs; ms <= end; ms += stepMs) {
      const cur = ttFromUtcIso(new Date(ms).toISOString());
      const d = cur - prev; // nominal 6 h = 21600 s
      if (Math.abs(d - stepMs / 1000) > 1e-9) {
        anomalies += 1;
        anomalyValue = d;
      }
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
    // Exactly one anomaly: the inserted second — 6 h of labels span 21601 s of TT.
    expect(anomalies).toBe(1);
    expect(anomalyValue).toBeCloseTo(stepMs / 1000 + 1, 9);
  });

  it('stretches 2 days of labels to 2 days + 1 s of TT across 2017-01-01', () => {
    const a = ttFromUtcIso('2016-12-31T00:00:00Z');
    const b = ttFromUtcIso('2017-01-02T00:00:00Z');
    expect(b - a).toBeCloseTo(2 * SEC_PER_DAY + 1, 9);
  });
});

describe('S0.7 skipped second (inserted leap second has no POSIX label)', () => {
  it('clamps TT values inside the inserted 2017 second to the last representable label', () => {
    const lastLabel = '2016-12-31T23:59:59.999Z';
    const firstLabelAfter = '2017-01-01T00:00:00.000Z';
    const ttA = ttFromUtcIso(lastLabel);
    const ttB = ttFromUtcIso(firstLabelAfter);
    // 1 ms of labels spans 1001 ms of TT across the step (the inserted second).
    expect(ttB - ttA).toBeCloseTo(1.001, 6);
    // Inside the inserted second: no label exists; clamp documented in ADR-008.
    expect(utcIsoFromTt(ttA + 1.0)).toBe(lastLabel);
    expect(utcIsoFromTt(ttB - 0.001)).toBe(lastLabel);
    // The boundary labels themselves are exact in both directions.
    expect(utcIsoFromTt(ttB)).toBe(firstLabelAfter);
    expect(utcIsoFromTt(ttA)).toBe(lastLabel);
  });
});

describe('S0.7 astronomy-engine cross-check (<= 1e-9 day)', () => {
  it('finds the library epoch exactly: MakeTime(2000-01-01T12:00:00Z).ut === 0', () => {
    const ut = A.MakeTime(new Date(LIB_J2000_POSIX_MS)).ut;
    expect(ut).toBe(0);
  });

  it('agrees with FromTerrestrialTime to <= 1e-9 day across sample TT values', () => {
    const report = collectCrossCheckReport();
    expect(report.libJ2000OriginCheck.exactZero).toBe(true);
    expect(report.maxFromTtResidualDays).toBeLessThan(1e-9);
    expect(report.rows).toHaveLength(SAMPLE_TT_SECONDS.length);
  });

  it('confirms the library linear UT-days convention against our seconds scale', () => {
    for (const tt of SAMPLE_TT_SECONDS) {
      const row = crossCheckRow(tt);
      // MakeTime(Date) ut is (ms - libJ2000ms)/86400000 by construction; our tt/86400 must match.
      expect(row.utConventionResidualDays).toBeLessThan(1e-9);
    }
  });

  it('measures the DeltaT trap: a naive Date feed conflates TT with UT by ~69 s (never ship it)', () => {
    const report = collectCrossCheckReport();
    // Espenak-Meeus model values at the samples; large enough to wreck sky accuracy.
    expect(report.maxNaiveDateDeltaTSeconds).toBeGreaterThan(60);
    expect(report.maxNaiveDateDeltaTSeconds).toBeLessThan(120);
  });

  it('measures the GAST conflation at the COORDINATE_SYSTEM.md §12 instant', () => {
    const g = collectCrossCheckReport().gastConflationAtS12;
    // ~0.29 deg class: Earth rotation over ~69 s of misread time.
    expect(g.errorDeg).toBeGreaterThan(0.2);
    expect(g.errorDeg).toBeLessThan(0.5);
  });
});

describe('S0.7 f64 precision of the tt scale', () => {
  it('records the ULP at the 2026 epoch (well inside the 1e-9 day cross-check bar)', () => {
    const p = collectCrossCheckReport().ttPrecisionAt2026;
    expect(p.ulpSeconds).toBeGreaterThan(0);
    expect(p.ulpDays).toBeLessThan(1e-9);
    expect(p.ulpSeconds).toBeCloseTo(ulp64(p.ttSeconds), 15);
  });
});

describe('S0.7 warp semantics (ADR-001 Decision 3, encoded as tests)', () => {
  const MONO_STOPS = [0, 1000, 2500, 5000, 7500, 10_000];

  function scenario(withWarp: boolean): { shared: number[]; local: number[] } {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    const warp = withWarp ? clock.startIsolatedWarp(10) : null;
    const shared: number[] = [];
    const local: number[] = [];
    for (const stop of MONO_STOPS) {
      host.setMonoMs(stop);
      // CONTACT_LOCAL / FLIGHT_DYNAMIC / ORBIT_COAST owners all sample the same shared clock:
      shared.push(clock.ttAtMono(stop));
      local.push(warp === null ? clock.ttAtMono(stop) : warp.localTt());
    }
    return { shared, local };
  }

  it('a 10x local warp produces ZERO divergence in shared-clock readings', () => {
    const clean = scenario(false);
    const warped = scenario(true);
    for (let i = 0; i < MONO_STOPS.length; i++) {
      // Bitwise identical: the warp view never touches the shared anchor.
      expect(warped.shared[i]).toBe(clean.shared[i]);
    }
    const maxDivergence = Math.max(...warped.shared.map((v, i) => Math.abs(v - clean.shared[i]!)));
    expect(maxDivergence).toBe(0);
  });

  it('the warp view itself advances 10x and diverges from shared time', () => {
    const warped = scenario(true);
    const sharedAtEnd = warped.shared[warped.shared.length - 1]!;
    const localAtEnd = warped.local[warped.local.length - 1]!;
    // 10 s of host time at rate 10 = 100 s of local TT (warp anchored at mono 0).
    expect(localAtEnd - warped.local[0]!).toBeCloseTo(100, 6);
    expect(Math.abs(localAtEnd - sharedAtEnd)).toBeCloseTo(90, 6);
  });

  it('isolated warp state cannot merge: serialization is refused', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    const warp = clock.startIsolatedWarp(10);
    expect(() => warp.serialize()).toThrow(/cannot merge state/);
  });

  it('regime owners sampling the shared clock are independent of clock speed', () => {
    const clean = scenario(false);
    const warped = scenario(true);
    // The three regime sample slots (contact/coast/flight owners) read identical
    // shared instants with and without a concurrent isolated warp.
    for (const i of [1, 3, 5]) {
      expect(warped.shared[i]!).toBe(clean.shared[i]!);
    }
  });
});

describe('S0.7 restart / reconnect (persisted TT resumed exactly)', () => {
  it('resume continues worldTime exactly: 5 s process life + 60 s downtime, no gap, no drift', () => {
    const probe = runResumeProbe();
    expect(probe.exactContinuation).toBe(true); // bitwise: resumed === savedTt + downtime
    expect(probe.downtimeSeconds).toBe(60); // integer-ms civil arithmetic, exact
    // Drift vs the naive civil expectation is bounded by f64 add rounding only.
    expect(probe.resumeDriftSeconds).toBeLessThan(2 * ulp64(probe.expectedTtSeconds));
    expect(probe.resumeDriftSeconds).toBeLessThan(1e-6);
  });

  it('serialized state carries the §4 field set and a round-trippable savedAtUtc', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    host.advanceMonoMs(5000);
    host.setWallMs(T0_2026 + 5000); // wall advances with the process lifetime
    const state = clock.serialize();
    expect(Object.keys(state).sort()).toEqual(
      ['clockRevision', 'leapTableRevision', 'savedAtUtc', 'schema', 'timeAdapterRevision', 'worldTimeTtSeconds'].sort(),
    );
    expect(state.schema).toBe('kwetu.clock/1');
    expect(state.timeAdapterRevision).toBe(TIME_ADAPTER_REVISION);
    expect(state.savedAtUtc).toBe(new Date(T0_2026 + 5000).toISOString());
    expect(state.worldTimeTtSeconds).toBeCloseTo(ttFromUtcIso(new Date(T0_2026).toISOString()) + 5, 12);
  });

  it('offline coast preserves duration measured in TT (leap-aware)', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    host.advanceMonoMs(1234);
    host.setWallMs(T0_2026 + 1234); // the save instant, in wall terms
    const state = clock.serialize();
    const { clock: resumed, report } = UniverseClock.resume(state, {
      nowMonoMs: () => 0,
      nowWallMs: () => T0_2026 + 1234 + 90_000,
    });
    expect(report.downtimeSeconds).toBe(90);
    expect(resumed.nowTt()).toBe(state.worldTimeTtSeconds + 90);
  });

  it('refuses negative civil jumps (wall clock set backwards): clamped, revision incremented', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    host.advanceMonoMs(5000);
    host.setWallMs(T0_2026 + 5000); // the save instant, in wall terms
    const state = clock.serialize();
    const { clock: resumed, report } = UniverseClock.resume(state, {
      nowMonoMs: () => 0,
      nowWallMs: () => T0_2026 + 1000, // 4 s BEFORE the save
    });
    expect(report.negativeJumpRefused).toBe(true);
    expect(report.downtimeSeconds).toBe(0);
    expect(resumed.nowTt()).toBe(state.worldTimeTtSeconds); // bitwise: no backwards motion
    expect(resumed.clockRevision).toBe(state.clockRevision + 1);
  });

  it('wall-clock corrections mid-process never change elapsed simulation time', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    host.advanceMonoMs(2500);
    const before = clock.nowTt();
    host.setWallMs(T0_2026 + 60_000); // NTP step forward
    expect(clock.nowTt()).toBe(before); // mono-driven: untouched
    host.setWallMs(T0_2026 - 30_000); // NTP step backward
    expect(clock.nowTt()).toBe(before);
    host.advanceMonoMs(2500);
    expect(clock.nowTt()).toBe(before + 2.5);
  });

  it('flags a leapTableRevision mismatch on resume (Phase-1 gate: refuse or re-anchor)', () => {
    const host = fakeHosts(T0_2026);
    const clock = UniverseClock.start(host.deps);
    const state = clock.serialize();
    const tampered: ClockStateV1 = { ...state, leapTableRevision: 'older-table' };
    const { report } = UniverseClock.resume(tampered, {
      nowMonoMs: () => 0,
      nowWallMs: () => T0_2026 + 1000,
    });
    expect(report.leapTableMismatch).toBe(true);
    expect(clock.leapTableMismatch).toBe(false);
  });

  it('rejects foreign schema / adapter revisions', () => {
    const host = fakeHosts(T0_2026);
    const state = UniverseClock.start(host.deps).serialize();
    expect(() =>
      UniverseClock.resume({ ...state, schema: 'kwetu.clock/999' as unknown as ClockStateV1['schema'] }, host.deps),
    ).toThrow(/schema/);
    expect(() =>
      UniverseClock.resume({ ...state, timeAdapterRevision: 'kwetu-tt-adapter/0' }, host.deps),
    ).toThrow(/adapter/);
  });
});

describe('S0.7 wall-clock bridge (ttNow)', () => {
  it('ttNow agrees with the ISO bridge of the same civil instant (<= 2 ms)', () => {
    const nowIso = new Date().toISOString();
    expect(Math.abs(ttNow() - ttFromUtcIso(nowIso))).toBeLessThanOrEqual(0.002);
  });

  it('day-scale sanity: tt now is within 0.001 day of the expected 2026 epoch offset', () => {
    const days = ttNow() / SEC_PER_DAY;
    const expectedDays = (Date.now() - J2000_TT_POSIX_MS) / MS_PER_DAY;
    expect(Math.abs(days - expectedDays)).toBeLessThan(0.001);
  });
});
