/**
 * Kwetu engine — the f64/f32 precision discipline (COORDINATE_SYSTEM.md §6).
 *
 * This module owns the *helpers and constants* of the precision law. It does
 * not own the law: where a boundary sits is decided by Laws P-1…P-6 in
 * COORDINATE_SYSTEM.md, and the measured evidence is ADR-002 (S0.1, evidence
 * section B). Summary of what this module is for:
 *
 *  - Canonical state, frame conversions and free-flight integration are f64
 *    (Law P-1). Plain JS numbers; `Float32Array` is forbidden on those paths
 *    (G-04). This module contains no canonical-path f32 code at all — only
 *    the explicit helpers for the two named f32 boundaries:
 *      1. the bounded Rapier contact solver (Law P-1), via `f32Downcast*`
 *         at the tick-boundary re-derivation (`localScene.ts`),
 *      2. the single per-pipeline GPU upload downcast (Law P-2).
 *  - Downstream consumers get *deltas* computed in f64 first (Law P-3):
 *    `subtractF64` exists so a caller never writes `a - b` on huge magnitudes
 *    by hand and can be grepped/reviewed at the boundary.
 *
 * All constants carry provenance tags per `docs/adr/README.md`.
 */

// --- f32 downcast helpers (the bounded-boundary primitives) --------------------

/**
 * Rounds to the nearest IEEE-754 binary32 value. The single primitive for the
 * two lawful f32 boundaries: the Rapier solver re-derivation (Law P-1) and the
 * per-pipeline render downcast (Law P-2). Any other use of f32 in canonical
 * paths is a violation of Law P-1 (see G-04).
 */
export function f32Downcast(x: number): number {
  return Math.fround(x);
}

/** Component-wise {@link f32Downcast} of a 3-vector. */
export function f32DowncastVec3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.fround(v.x), y: Math.fround(v.y), z: Math.fround(v.z) };
}

/**
 * Law P-3 helper: subtract two large positions in f64 and hand the small delta
 * down. Exists so the boundary is a named, greppable call — never an inline
 * subtraction on heliocentric-magnitude coordinates. Measured stakes
 * (ADR-002 evidence B, COORDINATE_SYSTEM.md §12 step 8): subtracting two
 * ~1.5e11 m positions errs 4.37e-6 m in f64 but 12 636.38 m if the operands
 * are f32-downcast first.
 */
export function subtractF64(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

// --- ULP spacing (measured by bit pattern, S0.1 probe B) -----------------------

/**
 * f64 ULP spacing at |x| for normal numbers: 2^(e−52), e the exponent bracket
 * of the stored value. Read from the bit pattern so non-representable x still
 * yields the bracket spacing, not a rounded-subtraction artifact.
 * [MEASURED 2026-09-05, tools/spikes/s0.1 precision probe — cross-checked
 * against the COORDINATE_SYSTEM.md §6 ladder (2^(e−52) for f64).]
 */
export function f64Spacing(x: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0);
  const e = ((hi >> 20) & 0x7ff) - 1023;
  return 2 ** (e - 52);
}

/**
 * f32 ULP spacing at |x| for normal numbers: 2^(e−23). Same bit-level method
 * as {@link f64Spacing}. [MEASURED 2026-09-05 — see the §6 ladder.]
 */
export function f32Spacing(x: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, Math.abs(x));
  const bits = buf.getUint32(0);
  const e = ((bits >> 23) & 0xff) - 127;
  return 2 ** (e - 23);
}

// --- the 2^24 guard -------------------------------------------------------------

/**
 * 2^24 = 16 777 216: above this magnitude f32 can no longer represent every
 * integer metre (spacing becomes 2 m). [derived — COORDINATE_SYSTEM.md §6
 * ladder note; verified by enumeration in ADR-002 evidence B: 25 of the 33
 * integers in a ±16 window at 2^24 are f32-exact, all at/below it are.]
 */
export const TWO_POW_24_METRES = 2 ** 24;

/**
 * True while |x| is low enough that f32 still represents every integer metre
 * exactly. The guard for any magnitude that is about to be handed to an f32
 * consumer (Law P-2 upload, or a scene-bound assertion — Law P-5: "The scene
 * bound is asserted in code, not hoped for").
 */
export function f32RepresentsEveryIntegerMetre(x: number): boolean {
  return Math.abs(x) <= TWO_POW_24_METRES;
}

// --- measured ladder constants (ADR-002 evidence B; COORDINATE_SYSTEM.md §6) ----

/** One row of the §6 spacing ladder: worst-case spacing within the magnitude bracket. */
export interface SpacingLadderRow {
  /** A representative magnitude inside the bracket, metres. */
  readonly magnitudeMetres: number;
  /** The doc's landmark for the bracket, or '' when the §6 table names none. */
  readonly landmark: string;
  readonly f64SpacingMetres: number;
  readonly f32SpacingMetres: number;
}

/**
 * The COORDINATE_SYSTEM.md §6 ladder at the magnitudes ADR-002 measured, with
 * the doc's landmarks. Spacings are *derived* (2^(e−52) / 2^(e−23) bit-exact
 * powers of two), cross-checked against the doc's decimals by
 * `tests/engine/precision.test.ts`. [derived; verified MEASURED 2026-09-05.]
 */
export const SPACING_LADDER: readonly SpacingLadderRow[] = [
  { magnitudeMetres: 8192, landmark: 'mm precision dies above this (f32)', f64SpacingMetres: 2 ** (13 - 52), f32SpacingMetres: 2 ** (13 - 23) },
  { magnitudeMetres: 65536, landmark: '', f64SpacingMetres: 2 ** (16 - 52), f32SpacingMetres: 2 ** (16 - 23) },
  { magnitudeMetres: 1048576, landmark: 'scene-bound far edge (Law P-5)', f64SpacingMetres: 2 ** (20 - 52), f32SpacingMetres: 2 ** (20 - 23) },
  { magnitudeMetres: 4194304, landmark: 'Earth radius (6 371 km) lives here', f64SpacingMetres: 2 ** (22 - 52), f32SpacingMetres: 2 ** (22 - 23) },
  { magnitudeMetres: 5e6, landmark: 'S0.1 bubble rebase magnitude', f64SpacingMetres: 2 ** (22 - 52), f32SpacingMetres: 2 ** (22 - 23) },
  { magnitudeMetres: 1e7, landmark: 'B-PREC-01 offset', f64SpacingMetres: 2 ** (23 - 52), f32SpacingMetres: 2 ** (23 - 23) },
  { magnitudeMetres: 1e10, landmark: 'long-range camera class', f64SpacingMetres: 2 ** (33 - 52), f32SpacingMetres: 2 ** (33 - 23) },
  { magnitudeMetres: 268435456, landmark: 'Moon distance class', f64SpacingMetres: 2 ** (28 - 52), f32SpacingMetres: 2 ** (28 - 23) },
  { magnitudeMetres: 1.5e11, landmark: "Earth's heliocentric distance (~1 AU)", f64SpacingMetres: 2 ** (37 - 52), f32SpacingMetres: 2 ** (37 - 23) },
] as const;

// --- ADR-002 measured boundary constants (evidence section B) -------------------

/**
 * B-PREC-01: max observed positional jitter of a 1 m/s walk (600 ticks,
 * dt 1/60) stored at a 1e7 m origin offset in global f32. The floating-origin
 * run of the same walk measured 4.45e-7 m — 1.1e6× better.
 * [MEASURED 2026-09-05, tools/spikes/s0.1 precision probe.]
 */
export const B_PREC_01_MAX_OBSERVED_JITTER_METRES = 0.5;
/** Same walk, floating-origin storage (f64 canonical, f32 local). [MEASURED 2026-09-05] */
export const B_PREC_01_FLOATING_ORIGIN_JITTER_METRES = 4.45e-7;

/**
 * Catastrophic cancellation at ~1 AU (Law P-3's worked case, §12 step 8):
 * subtracting the §12 heliocentric pair after an f32 downcast of the operands
 * errs by this many metres; the f64 subtraction errs F64_SUBTRACTION_AT_1AU.
 * [MEASURED 2026-09-05; doc seed 12 636 m.]
 */
export const F32_CANCELLATION_AT_1AU_METRES = 12636.38;
/** f64 subtraction error for the same pair (f64 ULP ≈ 30.5 µm class). [MEASURED 2026-09-05] */
export const F64_SUBTRACTION_AT_1AU_METRES = 4.37e-6;
/** Same case, Earth→Moon vector: f32-first error. [MEASURED 2026-09-05] */
export const F32_CANCELLATION_EARTH_MOON_METRES = 1522.41;

/**
 * f32-quantising the §12 site's PlanetFixed position (the *stored-coordinate*
 * error — the vertex jitter floating origin exists to kill; §12 step 8 note).
 * [MEASURED 2026-09-05; doc seed 0.227 m.]
 */
export const F32_QUANTISATION_OF_SITE_METRES = 0.227;

/** f32 ULP at 1e7 m (bubble-rebase / B-PREC-01 magnitude). [derived; verified MEASURED 2026-09-05] */
export const F32_SPACING_AT_1E7_METRES = 1.0;
/** f32 ULP at the 5e6 m S0.1 rebase magnitude (2^22 ≤ 5e6 < 2^23). [derived; verified MEASURED 2026-09-05] */
export const F32_SPACING_AT_5E6_METRES = 0.5;
/** f32 ULP at ~1.5e11 m (~1 AU). [derived; verified MEASURED 2026-09-05] */
export const F32_SPACING_AT_1AU_METRES = 16384;
/** f64 ULP at ~1.5e11 m (~1 AU) — the G-02 residual floor class. [derived; verified MEASURED 2026-09-05] */
export const F64_SPACING_AT_1AU_METRES = 2 ** (37 - 52);
