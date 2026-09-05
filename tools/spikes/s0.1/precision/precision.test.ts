/**
 * S0.1 probe B — precision boundary probe runner (throwaway spike, vitest).
 * Asserts the COORDINATE_SYSTEM.md §6 precision law boundaries numerically.
 */
import { describe, it, expect } from 'vitest';
import {
  collectPrecisionReport,
  f32Spacing,
  f64Spacing,
} from './precision.ts';

describe('S0.1 B: f64/f32 precision boundaries', () => {
  const report = collectPrecisionReport();

  it('measures the §6 spacing ladder by bit increment (f64 2^(e-52), f32 2^(e-23))', () => {
    const at = (m: number) => report.spacingLadder.find((r) => r.magnitudeMetres === m)!;
    // Doc ladder values (worst-case spacing within each bracket):
    expect(at(8192).f32SpacingMetres).toBeCloseTo(1 / 1024, 12); // 0.98 mm
    expect(at(1048576).f32SpacingMetres).toBeCloseTo(0.125, 12);
    expect(at(4194304).f32SpacingMetres).toBeCloseTo(0.5, 12);
    expect(at(10000000).f32SpacingMetres).toBeCloseTo(1.0, 12);
    expect(at(10000000).f64SpacingMetres).toBeCloseTo(2 ** (23 - 52), 15); // 1.86e-9 m
    expect(at(1.5e11).f32SpacingMetres).toBeCloseTo(16384, 6);
    expect(at(1.5e11).f64SpacingMetres).toBeCloseTo(2 ** (37 - 52), 18); // ~30.5 µm
  });

  it('offset stability at 1e7 m: f64 keeps sub-mm deltas, f32 loses anything under 0.5 m and snaps 0.5 m upward', () => {
    const rows = report.additiveJitterAt1e7;
    const byDelta = (d: number) => rows.find((r) => r.deltaMetres === d)!;
    // f64: the full delta survives the addition at 1e7 m (spacing 1.9e-9 m).
    for (const d of [0.001, 0.01, 0.1, 0.5, 1.0, 10.0]) {
      expect(Math.abs(byDelta(d).f64LostMetres)).toBeLessThan(1e-8);
    }
    // f32: a 1 mm delta vanishes entirely; a 1 m delta survives; the achieved
    // position error for sub-spacing deltas is up to ~0.5 m (half the 1 m spacing).
    expect(byDelta(0.001).f32SurvivedMetres).toBe(0);
    expect(byDelta(0.1).f32SurvivedMetres).toBe(0);
    expect(byDelta(1.0).f32SurvivedMetres).toBe(1);
    expect(byDelta(0.001).f32AchievedPositionErrorMetres).toBeCloseTo(0.001, 9);
    expect(byDelta(0.5).f32AchievedPositionErrorMetres).toBeLessThanOrEqual(1.0);
  });

  it('offset stability at 1e10 m: f64 spacing ~1.9 µm, f32 spacing 1024 m (the brief\'s regime)', () => {
    const rows = report.additiveJitterAt1e10;
    const byDelta = (d: number) => rows.find((r) => r.deltaMetres === d)!;
    expect(f64Spacing(1e10)).toBeCloseTo(2 ** (33 - 52), 18);
    expect(f32Spacing(1e10)).toBe(1024);
    expect(byDelta(0.001).f32SurvivedMetres).toBe(0);
    expect(byDelta(1000).f32SurvivedMetres).toBe(1024); // 1000 m rounds UP to the next representable
    expect(Math.abs(byDelta(1000).f32AchievedPositionErrorMetres)).toBeCloseTo(24, 6);
  });

  it('B-PREC-01 class: a 1 m/s walk at a 1e7 m offset in global f32 jitters by up to ~0.5 m; floating origin keeps ~1e-6 m', () => {
    const globalF32 = report.walkJitter.find((r) => r.offsetMetres === 1e7 && r.mode === 'global-f32')!;
    const floating = report.walkJitter.find((r) => r.offsetMetres === 1e7 && r.mode === 'floating-origin-f32-local')!;
    expect(globalF32.maxStoredPositionErrorMetres).toBeGreaterThan(0.1);
    expect(globalF32.maxStoredPositionErrorMetres).toBeLessThanOrEqual(0.5);
    expect(floating.maxStoredPositionErrorMetres).toBeLessThan(1e-5);
    expect(floating.maxStoredPositionErrorMetres).toBeLessThan(globalF32.maxStoredPositionErrorMetres / 1e4);
  });

  it('catastrophic cancellation: f32-first subtraction of heliocentric positions errs by km; f64 by µm (Law P-3)', () => {
    const site = report.cancellation[0];
    const moon = report.cancellation[1];
    // Doc §12 seed: 12 636 m at the §12 site.
    expect(Math.abs(site.f32ErrorMetres - 12636)).toBeLessThan(1);
    expect(site.f64ErrorMetres).toBeLessThan(1e-4);
    expect(moon.f32ErrorMetres).toBeGreaterThan(1000);
    expect(moon.f32ErrorMetres).toBeLessThan(moon.f32UlpAtMagnitudeMetres);
    expect(moon.f64ErrorMetres).toBeLessThan(1e-3);
    // The quantitative case: f32 is > 1e9 times worse here.
    expect(site.f32ErrorMetres / site.f64ErrorMetres).toBeGreaterThan(1e9);
  });

  it('2^24 = 16 777 216 is the f32 integer-exact limit (B-CONST-05 unit check)', () => {
    const b = report.twoPow24;
    expect(b.value).toBe(16777216);
    expect(b.froundExact).toBe(true);
    expect(b.minusOneExact).toBe(true);
    expect(b.plusOneCollapses).toBe(true);
    expect(b.plusTwoExact).toBe(true);
    expect(b.representableIntegersInWindow32).toBe(25); // 17 exact at/below 2^24, then only evens: +2..+16
    expect(b.f64MaxSafeInteger).toBe(2 ** 53 - 1);
  });
});
