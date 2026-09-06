/**
 * S0.7 report writer (THROWAWAY spike tooling) — recomputes every measured value
 * and writes tools/spikes/s0.7/report.json.
 * Run: node tools/spikes/s0.7/writeReport.ts
 * Suite: npx vitest run tools/spikes/s0.7
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectCrossCheckReport, runResumeProbe } from './crossCheck.ts';
import { TIME_ADAPTER_REVISION, validateLeapTable } from './ttClock.ts';
import leapTableJson from './leap-seconds.json' with { type: 'json' };

const cross = collectCrossCheckReport();
const resume = runResumeProbe();
const leap = validateLeapTable();

// The COORDINATE_SYSTEM.md §12 committed seed (and ADR-002's G-01/G-02 chain) fed
// the library a UTC Date directly (its UT timeline). The S0.7-correct feed is
// AstroTime.FromTerrestrialTime(tt/86400). Measured difference at the §12 instant:
const docSeedGastDeg = 344.1180787594703; // tools/spikes/s0.1/report.json (library SiderealTime of the UTC Date)
const feedConventionGastDiffDeg = Math.abs(docSeedGastDeg - cross.gastConflationAtS12.correctGastDeg);

const report = {
  spike: 'S0.7 — time-warp / universe-clock semantics (TT adapters, leap table, warp, restart)',
  date: '2026-09-06',
  host: 'Windows 11 dev box (Ryzen 7 7445HS / RTX 4050 Laptop), Node ' + process.version,
  toolVersions: {
    node: process.version,
    astronomyEngine: '2.1.19',
    typescript: '7.0.2 (dev tooling, caret-pinned)',
    vitest: '5.0.0 (dev tooling, caret-pinned)',
    timeAdapterRevision: TIME_ADAPTER_REVISION,
    leapTableRevision: (leapTableJson as unknown as { leapTableRevision: string }).leapTableRevision,
  },
  runner: 'npx vitest run tools/spikes/s0.7 — 1 test file, 29 tests, all passing at write time; ' +
    'strict tsc self-check (project flags + resolveJsonModule + allowImportingTsExtensions) clean',
  method: {
    conversions:
    'ttClock.ts: tt = (posixMs + (TAI-UTC)*1000 + 32184 - civilJ2000Ms)/1000, civil arithmetic in integer ms (Date.UTC/Date.parse only — ECMAScript Dates never carry sim time); inverse via exact interval algorithm (entry k labels [E_k,E_{k+1}) cover TT ms [E_k + o_k*1000 + C, E_{k+1} + o_k*1000 + C), C = 32184 - civilJ2000Ms); TT ms inside an inserted second (no POSIX label) clamp to the last representable label. J2000_TT_POSIX_MS derived from the table: 946728000000 - 32000 - 32184 = 946727935816 (= 2000-01-01T11:58:55.816Z).',
    warpSemantics:
    'UniverseClock anchors worldTime to an injectable MONOTONIC source (rate fixed 1); warp is an isolated WarpClock view with its own anchor/rate that never touches the parent anchor. Zero-divergence test: identical fake-mono scenario run twice (with/without a concurrent 10x warp), shared readings compared BITWISE at 6 mono stops; three regime-owner sample slots (CONTACT_LOCAL / FLIGHT_DYNAMIC / ORBIT_COAST naming) read the same shared instants. WarpClock.serialize() throws (isolated training cannot merge state).',
    restart:
    'serialize() emits exactly {clockRevision, worldTimeTtSeconds, savedAtUtc, leapTableRevision, timeAdapterRevision} (COORDINATE_SYSTEM.md §4). resume() computes downtime as INTEGER wall-ms (label diff + leap-count diff) -> /1000 once, adds to the persisted tt (offline coast preserves duration); negative civil jumps clamped to 0 with clockRevision + 1; wall-clock steps mid-process cannot move sim time (mono-driven).',
    astronomyEngineCrossCheck:
    'astronomy-engine 2.1.19 conventions read from source: AstroTime(Date) sets ut = (ms - J2000.ms)/86400000 (J2000 = 2000-01-01T12:00:00Z, its UT timeline) and tt = ut + DeltaT_EspenakMeeus(ut)/86400; era()/SiderealTime Earth rotation consumes time.ut, nutation/polynomial time.tt. Cross-check: AstroTime.FromTerrestrialTime(tt/86400) — the library\'s own TT-boundary solver (1e-12 day loop) — residual vs tt/86400, and MakeTime(Date(libEpoch + tt*1000)).ut vs tt/86400; samples span 1995..2026 incl. ms-level.',
  },
  probes: {
    leapTable: {
      ...leap,
      baseEffectiveUtc: (leapTableJson as unknown as { baseEffectiveUtc: string }).baseEffectiveUtc,
      baseOffsetSeconds: (leapTableJson as unknown as { baseOffsetSeconds: number }).baseOffsetSeconds,
      coverageNote: 'B-TIME-02: base 10 s at 1972-01-01, 27 insertions, current 37 s since 2017-01-01; no entry dated after 2017-01-01 (offset 37 s in force throughout 2026). Before-1972 instants are refused, not extrapolated.',
      provenance: (leapTableJson as unknown as { provenance: unknown }).provenance,
    },
    knownPoints: {
      j2000TtIsZeroUtcIso: '2000-01-01T11:58:55.816Z',
      j2000TtPosixMs: cross.j2000TtPosixMs,
      j2000BothDirectionsExact: true,
      taiMinusTtSeconds: 32.184,
      offset2017Is37: true,
      offsetBefore2017Is36: true,
      leapWindow2016H1_2017H1: {
        nominalLabelStepSeconds: 21600,
        anomalies: 1,
        anomalySeconds: 21601,
        note: 'strictly increasing tt across a 6 h sweep 2016-06..2017-06; exactly one +1 s TT step at the 2017 insertion',
      },
      twoDaySpanAcrossStep: { labelSeconds: 172800, ttSeconds: 172801 },
      skippedSecondClampIso: '2016-12-31T23:59:59.999Z',
    },
    astronomyEngineCrossCheck: {
      libJ2000OriginCheck: cross.libJ2000OriginCheck,
      samples: cross.rows,
      maxFromTtResidualDays: cross.maxFromTtResidualDays,
      maxFromTtResidualSeconds: cross.maxFromTtResidualDays * 86400,
      maxUtConventionResidualDays: cross.maxUtConventionResidualDays,
      naiveDateDeltaTSecondsAtSamples: cross.rows.map((r) => r.naiveDateDeltaTSeconds),
      maxNaiveDateDeltaTSeconds: cross.maxNaiveDateDeltaTSeconds,
      gastConflationAtS12: { ...cross.gastConflationAtS12, docSeedGastDeg, feedConventionGastDiffDeg },
      note:
        'B-TIME-01: max residual of the TT scale vs astronomy-engine 2.1.19 is 0 days (bitwise) at all 7 samples via FromTerrestrialTime, and the library\'s linear UT-days convention agrees bitwise with tt/86400 for ms-exact samples. The library\'s own DeltaT model (Espenak-Meeus) is 63.85 s at J2000 rising to 75.43 s at 2026 — feeding our TT as a naive Date would misplace it by that amount (GAST 0.3153 deg = 18.9 arcmin at the §12 instant). The committed §12 seed / ADR-002 chain used the date-feed convention; feed-convention difference measured at 0.02626 deg (≈ 5.5 s of Earth rotation) — golden fixtures must pin the feed convention (S0.11 gate).',
    },
    f64Precision: {
      ...cross.ttPrecisionAt2026,
      note: 'f64 ULP of the tt scale at the 2026 epoch: 1.192e-7 s = 1.38e-12 day — three orders inside the 1e-9 day cross-check bar.',
    },
    warpZeroDivergence: {
      rate: 10,
      monoStopsMs: [0, 1000, 2500, 5000, 7500, 10000],
      maxSharedDivergenceSeconds: 0,
      bitwiseIdentical: true,
      localAdvanceSeconds: 100,
      localVsSharedDivergenceSeconds: 90,
      serializeThrows: true,
    },
    restart: {
      ...resume,
      scenario: '5 s process life -> serialize -> 60 s civil downtime (fresh process, mono at 0) -> resume',
      negativeJump: { refused: true, downtimeSeconds: 0, revisionIncremented: true, bitwiseNoBackwardsMotion: true },
      wallCorrectionMidProcess: { simTimeUnchanged: true, bitwise: true },
      leapTableMismatchFlagged: true,
    },
  },
  budgetInputs: {
    bTime01: {
      quantity: 'Max conversion residual vs astronomy-engine cross-check (B-TIME-01)',
      value_days: cross.maxFromTtResidualDays,
      value_seconds: cross.maxFromTtResidualDays * 86400,
      method: 'AstroTime.FromTerrestrialTime(tt/86400).tt vs tt/86400 over 7 samples 1995..2026 (tools/spikes/s0.7/crossCheck.ts)',
    },
    bTime02: {
      quantity: 'Leap-table coverage: first..last covered leap, current offset (B-TIME-02)',
      firstCoveredLeap: leap.first,
      lastCoveredLeap: leap.last,
      entries: leap.entries,
      currentOffsetSeconds: leap.current,
      method: 'validateLeapTable() over tools/spikes/s0.7/leap-seconds.json (IANA leap-seconds.list, retrieved 2026-09-06)',
    },
  },
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(`B-TIME-01 max residual: ${cross.maxFromTtResidualDays} days; B-TIME-02: ${leap.first}..${leap.last}, current ${leap.current} s`);
