/**
 * Engine precision-discipline tests (COORDINATE_SYSTEM.md §6 Laws P-1…P-6;
 * ADR-002 evidence B). The spacing/2^24 facts are *derived* powers of two,
 * verified bit-exactly here; the boundary constants are ADR-002's measured
 * values [MEASURED 2026-09-05, tools/spikes/s0.1 precision probe].
 */
import { describe, expect, it } from 'vitest';
import {
  B_PREC_01_FLOATING_ORIGIN_JITTER_METRES,
  B_PREC_01_MAX_OBSERVED_JITTER_METRES,
  F32_CANCELLATION_AT_1AU_METRES,
  F32_CANCELLATION_EARTH_MOON_METRES,
  F32_QUANTISATION_OF_SITE_METRES,
  F32_SPACING_AT_1AU_METRES,
  F32_SPACING_AT_1E7_METRES,
  F32_SPACING_AT_5E6_METRES,
  F64_SPACING_AT_1AU_METRES,
  SPACING_LADDER,
  TWO_POW_24_METRES,
  f32Downcast,
  f32DowncastVec3,
  f32RepresentsEveryIntegerMetre,
  f32Spacing,
  f64Spacing,
  subtractF64,
} from '../../client/src/engine/precision';

describe('engine/precision — the f32 downcast boundary helpers (Laws P-1/P-2)', () => {
  it('f32Downcast is the IEEE-754 round-to-nearest-even binary32 rounding', () => {
    expect(f32Downcast(0.1)).toBe(Math.fround(0.1));
    expect(f32Downcast(-1.5e11)).toBe(Math.fround(-1.5e11));
    // 2^24 + 1 is not representable in f32: it rounds DOWN to 2^24 (ties-to-even).
    expect(f32Downcast(TWO_POW_24_METRES + 1)).toBe(TWO_POW_24_METRES);
    // 2^24 + 2 is exactly representable and survives.
    expect(f32Downcast(TWO_POW_24_METRES + 2)).toBe(TWO_POW_24_METRES + 2);
  });

  it('f32DowncastVec3 is component-wise', () => {
    const v = { x: 0.1, y: 4907565.698, z: -1.5e11 };
    const d = f32DowncastVec3(v);
    expect(d.x).toBe(Math.fround(0.1));
    expect(d.y).toBe(Math.fround(4907565.698));
    expect(d.z).toBe(Math.fround(-1.5e11));
  });

  it('subtractF64 is the named Law P-3 boundary: exact f64 component-wise subtraction', () => {
    // The helper's contract: identical to raw f64 subtraction (never an f32
    // downcast of the operands) — it exists so the boundary is greppable.
    const a = { x: 143550108927.186, y: -42545309447.938, z: -18445391844.014 };
    const b = { x: 143544280009.368, y: -42547782563.768, z: -18444627471.66 };
    const d = subtractF64(a, b);
    expect(d.x).toBe(a.x - b.x);
    expect(d.y).toBe(a.y - b.y);
    expect(d.z).toBe(a.z - b.z);
    // The same subtraction after an f32 downcast of the operands is the bug it
    // prevents: ~12.6 km of error at this magnitude (ADR-002 evidence B).
    const f32First = {
      x: Math.fround(a.x) - Math.fround(b.x),
      y: Math.fround(a.y) - Math.fround(b.y),
      z: Math.fround(a.z) - Math.fround(b.z),
    };
    const trueDelta = subtractF64(a, b);
    const f32Error = Math.hypot(f32First.x - trueDelta.x, f32First.y - trueDelta.y, f32First.z - trueDelta.z);
    expect(f32Error).toBeGreaterThan(1000); // kilometre-class [MEASURED 12 636.38 m]
  });
});

describe('engine/precision — ULP spacing (bit-level, the §6 ladder formulas)', () => {
  it('f64Spacing is 2^(e−52) in the magnitude bracket of |x|', () => {
    expect(f64Spacing(8192)).toBe(2 ** (13 - 52));
    expect(f64Spacing(1048576)).toBe(2 ** (20 - 52));
    expect(f64Spacing(6.371e6)).toBe(2 ** (22 - 52));
    expect(f64Spacing(1e7)).toBe(2 ** (23 - 52));
    expect(f64Spacing(1.5e11)).toBe(2 ** (37 - 52)); // ≈ 30.5 µm at ~1 AU (doc §6)
    expect(f64Spacing(-1.5e11)).toBe(2 ** (37 - 52)); // |x| symmetric
  });

  it('f32Spacing is 2^(e−23) in the magnitude bracket of |x|', () => {
    expect(f32Spacing(8192)).toBe(2 ** (13 - 23)); // 0.98 mm class — "mm precision dies here"
    expect(f32Spacing(65536)).toBe(2 ** (16 - 23)); // 7.8 mm
    expect(f32Spacing(1048576)).toBe(2 ** (20 - 23)); // 0.125 m — scene-bound far edge
    expect(f32Spacing(4194304)).toBe(2 ** (22 - 23)); // 0.5 m — Earth-radius bracket
    expect(f32Spacing(5e6)).toBe(0.5); // the S0.1 rebase magnitude
    expect(f32Spacing(1e7)).toBe(1); // B-PREC-01 offset
    expect(f32Spacing(1.5e11)).toBe(16384); // ~1 AU
  });
});

describe('engine/precision — the §6 spacing ladder constants', () => {
  it('every ladder row agrees with the bit-level spacing functions', () => {
    for (const row of SPACING_LADDER) {
      expect(f64Spacing(row.magnitudeMetres)).toBe(row.f64SpacingMetres);
      expect(f32Spacing(row.magnitudeMetres)).toBe(row.f32SpacingMetres);
    }
  });

  it('the ladder reproduces the doc’s decimal landmark values', () => {
    const row8k = SPACING_LADDER.find((r) => r.magnitudeMetres === 8192)!;
    expect(row8k.f32SpacingMetres).toBeCloseTo(0.98e-3, 4); // "0.98 mm"
    const rowScene = SPACING_LADDER.find((r) => r.magnitudeMetres === 1048576)!;
    expect(rowScene.f32SpacingMetres).toBeCloseTo(0.125, 12); // "0.125 m" far edge
    const rowEarth = SPACING_LADDER.find((r) => r.magnitudeMetres === 4194304)!;
    expect(rowEarth.f32SpacingMetres).toBeCloseTo(0.5, 12); // "0.5 m" Earth radius
    const rowMoon = SPACING_LADDER.find((r) => r.magnitudeMetres === 268435456)!;
    expect(rowMoon.f32SpacingMetres).toBe(32); // "32 m" Moon distance
    const rowAu = SPACING_LADDER.find((r) => r.magnitudeMetres === 1.5e11)!;
    expect(rowAu.f32SpacingMetres).toBe(16384); // "16 384 m" at ~1 AU
    // The doc's "30.5 µm" is the 3-significant-figure rounding of the exact
    // derived power 2^(37−52) = 2^−15; assert the exact value, and the doc
    // figure to the precision the rounding guarantees.
    expect(rowAu.f64SpacingMetres).toBe(2 ** (37 - 52));
    expect(rowAu.f64SpacingMetres).toBeCloseTo(30.5e-6, 7);
  });
});

describe('engine/precision — the 2^24 guard (f32 integer-metre limit)', () => {
  it('2^24 = 16 777 216 is the last magnitude where f32 holds every integer metre', () => {
    expect(TWO_POW_24_METRES).toBe(16777216);
    expect(f32RepresentsEveryIntegerMetre(TWO_POW_24_METRES)).toBe(true);
    expect(f32RepresentsEveryIntegerMetre(TWO_POW_24_METRES + 1)).toBe(false);
    expect(f32RepresentsEveryIntegerMetre(-TWO_POW_24_METRES)).toBe(true);
    expect(f32RepresentsEveryIntegerMetre(6.371e6)).toBe(true); // Earth radius
    expect(f32RepresentsEveryIntegerMetre(1.5e11)).toBe(false); // heliocentric range
  });

  it('enumeration agrees with ADR-002: 25 of the 33 integers in a ±16 window at 2^24 are f32-exact', () => {
    let representable = 0;
    for (let n = TWO_POW_24_METRES - 16; n <= TWO_POW_24_METRES + 16; n++) {
      if (Math.fround(n) === n) representable++;
    }
    expect(representable).toBe(25); // [MEASURED 2026-09-05 — ADR-002 evidence B]
    // All integers at or below 2^24 in the window are exact; above it only evens.
    for (let n = TWO_POW_24_METRES - 16; n <= TWO_POW_24_METRES; n++) {
      expect(Math.fround(n)).toBe(n);
    }
    expect(Math.fround(TWO_POW_24_METRES + 1)).toBe(TWO_POW_24_METRES);
    // Spacing at 2^24 is 2 m: +3 is exactly midway between +2 and +4, and
    // IEEE-754 round-half-to-EVEN mantissas pick +4 (the even mantissa).
    expect(Math.fround(TWO_POW_24_METRES + 3)).toBe(TWO_POW_24_METRES + 4);
  });
});

describe('engine/precision — ADR-002 measured boundary constants (evidence B)', () => {
  it('carries the measured values unrounded', () => {
    expect(B_PREC_01_MAX_OBSERVED_JITTER_METRES).toBe(0.5);
    expect(B_PREC_01_FLOATING_ORIGIN_JITTER_METRES).toBe(4.45e-7);
    expect(F32_CANCELLATION_AT_1AU_METRES).toBe(12636.38);
    expect(F32_CANCELLATION_EARTH_MOON_METRES).toBe(1522.41);
    expect(F32_QUANTISATION_OF_SITE_METRES).toBe(0.227);
    // 1.1e6× — the floating-origin ratio quoted by ADR-002 (B-PREC-01).
    expect(B_PREC_01_MAX_OBSERVED_JITTER_METRES / B_PREC_01_FLOATING_ORIGIN_JITTER_METRES).toBeGreaterThan(1e6);
  });

  it('carries the derived spacing constants at the measured magnitudes', () => {
    expect(F32_SPACING_AT_1E7_METRES).toBe(f32Spacing(1e7));
    expect(F32_SPACING_AT_5E6_METRES).toBe(f32Spacing(5e6));
    expect(F32_SPACING_AT_1AU_METRES).toBe(f32Spacing(1.5e11));
    expect(F64_SPACING_AT_1AU_METRES).toBe(f64Spacing(1.5e11));
    expect(F64_SPACING_AT_1AU_METRES).toBeCloseTo(3.05e-5, 6); // the G-02 residual floor class
  });

  it('f32-quantising the §12 site’s PlanetFixed position errs in the measured 0.227 m class', () => {
    const site = { x: 4907565.698, y: 4003939.392, z: -749078.231 };
    const err = Math.hypot(site.x - f32Downcast(site.x), site.y - f32Downcast(site.y), site.z - f32Downcast(site.z));
    // Each component error is < 0.5 ULP = 0.25 m at this magnitude; the vector
    // error lands near the doc's 0.227 m seed [MEASURED 2026-09-05].
    expect(err).toBeGreaterThan(0.05);
    expect(err).toBeLessThan(0.5);
  });
});
