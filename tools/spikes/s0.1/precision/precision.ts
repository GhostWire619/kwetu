/**
 * S0.1 probe B — precision boundary probes (THROWAWAY spike code).
 *
 * (i)   offset stability: additive jitter of small deltas applied to positions
 *       stored in f64 vs f32 at 1e7 m (B-PREC-01's offset) and 1e10 m;
 *       spacing measured by incrementing the IEEE-754 bit pattern (nextUp),
 *       cross-checked against the COORDINATE_SYSTEM.md §6 ladder
 *       (2^(e−52) for f64, 2^(e−23) for f32, x ∈ [2^e, 2^(e+1))).
 * (ii)  catastrophic cancellation: subtracting two heliocentric-scale positions
 *       in f64 vs after an f32 downcast (Law P-3's worked case, §12 step 8).
 * (iii) the 2^24 = 16 777 216 integer-exactness boundary as a unit check
 *       (B-CONST-05).
 *
 * Note: the S0.1 brief's parenthetical "~2 µm f64 / ~1 km f32 at 1e7 m" figures
 * correspond to ~1e10 m, not 1e7 m — the doc's §6 ladder is the authority
 * (1.9e-9 m f64 / 1 m f32 at 1e7 m). Both regimes are measured below.
 */
import { collectFrameReport } from '../frames/frameChain.ts';
import * as A from 'astronomy-engine';

export const AU_METRES = A.KM_PER_AU * 1000;

/**
 * f64 ULP spacing at |x| for normal numbers: 2^(e-52) with e the exponent of the
 * stored value. Read from the bit pattern so non-representable x (e.g. 1.5e11 in
 * f32) still yields the bracket spacing, not a rounded-subtraction artifact.
 */
export function f64Spacing(x: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0);
  const e = ((hi >> 20) & 0x7ff) - 1023;
  return 2 ** (e - 52);
}

/** f32 ULP spacing at |x| for normal numbers: 2^(e-23). Same bit-level method. */
export function f32Spacing(x: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = Math.abs(x);
  const e = ((u[0] >> 23) & 0xff) - 127;
  return 2 ** (e - 23);
}

export interface JitterRow {
  deltaMetres: number;
  f64SurvivedMetres: number;
  f64LostMetres: number;
  f32SurvivedMetres: number;
  f32LostMetres: number;
  f32AchievedPositionErrorMetres: number;
}

/** Applies a small local delta to a global position, f64 vs f32 storage. */
function jitterRowAt(globalX: number, delta: number): JitterRow {
  const xF64 = globalX + delta;
  const f64Survived = xF64 - globalX;
  const xF32Base = Math.fround(globalX);
  const xF32 = Math.fround(xF32Base + delta);
  return {
    deltaMetres: delta,
    f64SurvivedMetres: f64Survived,
    f64LostMetres: delta - f64Survived,
    f32SurvivedMetres: xF32 - xF32Base,
    f32LostMetres: delta - (xF32 - xF32Base),
    f32AchievedPositionErrorMetres: Math.abs(xF32 - (globalX + delta)),
  };
}

export interface WalkJitter {
  offsetMetres: number;
  mode: string;
  maxStoredPositionErrorMetres: number;
  maxStepErrorMetres: number;
  finalStoredMinusTruthMetres: number;
}

/**
 * 600 fixed ticks of a 1 m/s walk (dt = 1/60 s), stored globally in f32 vs
 * floating-origin (f64 canonical, f32 only for the small local coordinate).
 */
function walkJitter(offset: number, mode: 'global-f32' | 'floating-origin-f32-local'): WalkJitter {
  const ticks = 600;
  const dt = 1 / 60;
  let maxPosErr = 0;
  let maxStepErr = 0;
  let prevStored = 0;
  let finalTrueRendered = 0;
  for (let i = 0; i <= ticks; i++) {
    const truth = i * dt; // 1 m/s * t, relative to the offset
    const stored = mode === 'global-f32' ? Math.fround(offset + truth) : Math.fround(truth);
    // What the renderer draws vs where the body truly is:
    const trueRendered = mode === 'global-f32' ? offset + truth : truth;
    const posErr = Math.abs(stored - trueRendered);
    if (i > 0) {
      const stepErr = Math.abs(stored - prevStored - dt);
      if (stepErr > maxStepErr) maxStepErr = stepErr;
    }
    if (posErr > maxPosErr) maxPosErr = posErr;
    prevStored = stored;
    finalTrueRendered = trueRendered;
  }
  return {
    offsetMetres: offset,
    mode,
    maxStoredPositionErrorMetres: maxPosErr,
    maxStepErrorMetres: maxStepErr,
    finalStoredMinusTruthMetres: prevStored - finalTrueRendered,
  };
}

export interface PrecisionReport {
  spacingLadder: {
    magnitudeMetres: number;
    landmark: string;
    f64SpacingMetres: number;
    f32SpacingMetres: number;
  }[];
  additiveJitterAt1e7: JitterRow[];
  additiveJitterAt1e10: JitterRow[];
  walkJitter: WalkJitter[];
  bPrec01MaxObservedJitterMetres: number;
  bPrec02VerifiedBoundaryNote: string;
  cancellation: {
    caseName: string;
    magnitudeMetres: number;
    trueDeltaMetres: number;
    f64ErrorMetres: number;
    f32ErrorMetres: number;
    f64RelativeError: number;
    f32RelativeError: number;
    f32UlpAtMagnitudeMetres: number;
  }[];
  twoPow24: {
    value: number;
    froundExact: boolean;
    plusOneRoundTripsToSelf: boolean;
    plusOneCollapses: boolean;
    plusTwoExact: boolean;
    minusOneExact: boolean;
    representableIntegersInWindow32: number;
    f64MaxSafeInteger: number;
    f64LosesIntegersAbove: number;
  };
}

export function collectPrecisionReport(): PrecisionReport {
  // --- (i) spacing ladder (measured, bit-level) vs doc landmarks -------------
  const ladderPoints: [number, string][] = [
    [8192, 'mm precision dies above this (f32)'],
    [65536, ''],
    [1048576, 'scene-bound far edge (Law P-5)'],
    [4194304, 'Earth radius lives here'],
    [5000000, 'S0.1 bubble rebase height'],
    [10000000, 'B-PREC-01 offset'],
    [16777216, '2^24: f32 loses integer metres'],
    [268435456, 'Moon distance class'],
    [1.5e11, 'Earth heliocentric distance (~1 AU)'],
    [1e10, 'Phase-1 camera fly range'],
  ];
  const spacingLadder = ladderPoints.map(([magnitude, landmark]) => ({
    magnitudeMetres: magnitude,
    landmark,
    f64SpacingMetres: f64Spacing(magnitude),
    f32SpacingMetres: f32Spacing(magnitude),
  }));

  const additiveJitterAt1e7 = [0.001, 0.01, 0.1, 0.5, 1.0, 10.0].map((d) => jitterRowAt(1e7, d));
  const additiveJitterAt1e10 = [0.001, 1.0, 100.0, 512.0, 1000.0, 10000.0].map((d) => jitterRowAt(1e10, d));

  const walkJitterRows = [
    walkJitter(1e7, 'global-f32'),
    walkJitter(1e7, 'floating-origin-f32-local'),
    walkJitter(1e10, 'global-f32'),
    walkJitter(1e10, 'floating-origin-f32-local'),
  ];

  // --- (ii) catastrophic cancellation ----------------------------------------
  const frames = collectFrameReport();
  const fr = (x: number) => Math.fround(x);

  function cancellationCase(
    caseName: string,
    p1: number[],
    p2: number[],
    exactDelta: number[],
  ): PrecisionReport['cancellation'][number] {
    const trueDelta = Math.hypot(exactDelta[0], exactDelta[1], exactDelta[2]);
    const magnitude = Math.hypot(p1[0], p1[1], p1[2]);
    const f64Back: number[] = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
    // The Law P-3 violation: downcast FIRST, subtract after.
    const f32Back: number[] = [fr(p1[0]) - fr(p2[0]), fr(p1[1]) - fr(p2[1]), fr(p1[2]) - fr(p2[2])];
    // Both measured against the exact f64 delta (the frame-chain ground truth).
    const errF64 = Math.hypot(f64Back[0] - exactDelta[0], f64Back[1] - exactDelta[1], f64Back[2] - exactDelta[2]);
    const errF32 = Math.hypot(f32Back[0] - exactDelta[0], f32Back[1] - exactDelta[1], f32Back[2] - exactDelta[2]);
    return {
      caseName,
      magnitudeMetres: magnitude,
      trueDeltaMetres: trueDelta,
      f64ErrorMetres: errF64,
      f32ErrorMetres: errF32,
      f64RelativeError: errF64 / trueDelta,
      f32RelativeError: errF32 / trueDelta,
      f32UlpAtMagnitudeMetres: f32Spacing(magnitude),
    };
  }

  const pci = frames.pciEqj;
  const earthHelio = frames.earthHelioMetresValue;
  const darHelio = frames.darHelioMetresValue;
  // Moon geocentric position (library GeoMoon, EQJ, AU->m) — the Earth->Moon
  // vector that the two heliocentric positions must recover by subtraction.
  const moonGeo = A.GeoMoon(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)));
  const moonGeoM = [moonGeo.x * AU_METRES, moonGeo.y * AU_METRES, moonGeo.z * AU_METRES];
  const moonHelio = [earthHelio[0] + moonGeoM[0], earthHelio[1] + moonGeoM[1], earthHelio[2] + moonGeoM[2]];

  const cancellation = [
    cancellationCase(
      'Dar es Salaam site (Pci) subtracted from its heliocentric position (doc §12 step 8)',
      darHelio,
      earthHelio,
      pci,
    ),
    cancellationCase(
      'Earth->Moon geocentric vector recovered from two heliocentric positions (Earth/Moon scale, 2026-09-05)',
      moonHelio,
      earthHelio,
      moonGeoM,
    ),
  ];

  // --- (iii) 2^24 boundary unit check ----------------------------------------
  const p24 = 2 ** 24;
  let representable = 0;
  for (let n = p24 - 16; n <= p24 + 16; n++) {
    if (Math.fround(n) === n) representable++;
  }
  const twoPow24 = {
    value: p24,
    froundExact: Math.fround(p24) === p24,
    plusOneRoundTripsToSelf: Math.fround(Math.fround(p24 + 1)) === Math.fround(p24 + 1),
    plusOneCollapses: Math.fround(p24 + 1) === p24,
    plusTwoExact: Math.fround(p24 + 2) === p24 + 2,
    minusOneExact: Math.fround(p24 - 1) === p24 - 1,
    representableIntegersInWindow32: representable, // 33-integer window: 17 exact at/below 2^24, then only evens (+2..+16) = 25
    f64MaxSafeInteger: Number.MAX_SAFE_INTEGER,
    f64LosesIntegersAbove: 2 ** 53,
  };

  // B-PREC-01: max observed positional jitter at a 1e7 m offset = the global-f32 walk error.
  const bPrec01 = walkJitterRows.find((r) => r.offsetMetres === 1e7 && r.mode === 'global-f32')!;

  return {
    spacingLadder,
    additiveJitterAt1e7,
    additiveJitterAt1e10,
    walkJitter: walkJitterRows,
    bPrec01MaxObservedJitterMetres: bPrec01.maxStoredPositionErrorMetres,
    bPrec02VerifiedBoundaryNote:
      'B-PREC-02 (rendered-scene distance-from-origin ceiling): the verified f32 boundary facts are the spacing ' +
      'ladder above; the Law P-5 scene bound (~1e5-1e6 m) keeps f32 vertex spacing <= ~0.125 m at 1e6 m and is ' +
      'asserted in code, not hoped for. Contact-bubble extent is measured separately (probe D + C).',
    cancellation,
    twoPow24,
  };
}
