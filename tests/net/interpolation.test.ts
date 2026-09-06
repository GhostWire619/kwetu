/**
 * Snapshot-buffer interpolation tests (Phase 1/5 netcode groundwork).
 *
 * The buffer is pure f64 — every assertion that can be exact IS exact
 * (values chosen so the linear path is bitwise: 0→10 over 100 ms has an
 * exact midpoint of 5). Yaw shortest-arc cases assert BOTH against an
 * inline reference computed with the same f64 operation order AND against
 * the geometric answer within 1e-15, so the wrap logic cannot silently
 * take the long way round.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTRAPOLATION_CAP_MS,
  MAX_SNAPSHOTS_DEFAULT,
  RENDER_DELAY_MS_DEFAULT,
  SnapshotBuffer,
  wrapPi,
  type Snapshot,
} from '../../client/src/net/interpolation';

const TWO_PI = Math.PI * 2;

/** Build a snapshot from [id, x, y, z, yaw] rows. */
function snap(serverTimeMs: number, rows: Array<[string, number, number, number, number]>): Snapshot {
  const entities: Record<string, { x: number; y: number; z: number; yaw: number }> = {};
  for (const [id, x, y, z, yaw] of rows) entities[id] = { x, y, z, yaw };
  return { serverTimeMs, entities };
}

/** Inline reference for the module's yaw wrap — same operations, same order. */
function refWrapPi(angle: number): number {
  let w = angle % TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  else if (w < -Math.PI) w += TWO_PI;
  return w;
}

describe('interpolation: exact linear math', () => {
  it('interpolates the exact midpoint between two bracketing snapshots (f64-exact)', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 10, -4, 8, 1]]));
    const f = buf.sample(50);
    expect(f.extrapolated).toBe(false);
    expect(f.behindBuffer).toBe(false);
    expect(f.degenerate).toBe(false);
    expect(f.sampleTimeMs).toBe(50);
    const a = f.entities.get('a');
    expect(a).toBeDefined();
    expect(a!.x).toBe(5); // bitwise: 0 + (10-0)*0.5
    expect(a!.y).toBe(-2);
    expect(a!.z).toBe(4);
    expect(a!.yaw).toBe(0.5);
  });

  it('returns the exact snapshot pose when sampling exactly on a snapshot time', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 1, 2, 3, 0.25]]));
    buf.insert(snap(100, [['a', 5, 6, 7, 0.75]]));
    const f = buf.sample(100);
    const a = f.entities.get('a');
    expect(a!.x).toBe(5);
    expect(a!.yaw).toBe(0.75);
    expect(f.degenerate).toBe(true); // passthrough at the newest edge, nothing ahead to lerp toward
    expect(f.extrapolated).toBe(false);
  });

  it('wraps yaw the SHORT way across the ±π branch cut (−3 → +3 goes through −π)', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, -3.0]]));
    buf.insert(snap(100, [['a', 0, 0, 0, 3.0]]));
    const mid = buf.sample(50).entities.get('a')!.yaw;
    expect(mid).toBe(-3.0 + refWrapPi(3.0 - -3.0) * 0.5); // same op order → bitwise
    expect(Math.abs(mid - -Math.PI)).toBeLessThan(1e-15); // and geometrically −π, not +2.86
    expect(mid).toBeLessThan(0);
  });

  it('wraps yaw the short way in the other direction (+3 → −3 goes through +π)', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, 3.0]]));
    buf.insert(snap(100, [['a', 0, 0, 0, -3.0]]));
    const mid = buf.sample(50).entities.get('a')!.yaw;
    expect(Math.abs(mid - Math.PI)).toBeLessThan(1e-15);
    expect(mid).toBeGreaterThan(0);
  });

  it('wrapPi output stays inside [−π, π] and preserves ±π exactly', () => {
    for (const a of [0, 0.1, Math.PI, -Math.PI, 2 * Math.PI, -2 * Math.PI, 7, -7, 100, -100]) {
      const w = wrapPi(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(w).toBe(refWrapPi(a));
    }
    // The boundary is preserved, not folded to one side: a heading that
    // lands exactly on the branch cut keeps the direction its short arc
    // chose (the renderer may read that direction).
    expect(wrapPi(Math.PI)).toBe(Math.PI);
    expect(wrapPi(-Math.PI)).toBe(-Math.PI);
    expect(wrapPi(3 * Math.PI)).toBe(Math.PI); // π + one full turn
  });

  it('interpolates the union of entity ids: spawn appears, departure holds', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [
      ['a', 10, 0, 0, 0],
      ['b', 4, 4, 4, 2],
    ]));
    const f = buf.sample(50);
    expect(f.entities.get('a')!.x).toBe(5);
    const b = f.entities.get('b');
    expect(b).toBeDefined();
    expect(b!.x).toBe(4); // one-sided id: newer snapshot's pose verbatim
    expect(b!.yaw).toBe(2);
  });
});

describe('interpolation: delay semantics', () => {
  it('defaults to renderDelayMs = 100', () => {
    expect(new SnapshotBuffer().renderDelayMs).toBe(RENDER_DELAY_MS_DEFAULT);
    expect(RENDER_DELAY_MS_DEFAULT).toBe(100);
  });

  it('sampleFromServerTime(t) === sample(t − renderDelayMs), field for field', () => {
    const buf = new SnapshotBuffer({ renderDelayMs: 100 });
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 10, 0, 0, 1]]));
    buf.insert(snap(200, [['a', 20, 0, 0, 0.5]]));
    const viaDelay = buf.sampleFromServerTime(1150);
    const direct = buf.sample(1050);
    expect(viaDelay.sampleTimeMs).toBe(direct.sampleTimeMs);
    expect(viaDelay.extrapolated).toBe(direct.extrapolated);
    expect(viaDelay.behindBuffer).toBe(direct.behindBuffer);
    expect(viaDelay.degenerate).toBe(direct.degenerate);
    const va = viaDelay.entities.get('a');
    const da = direct.entities.get('a');
    expect(va!.x).toBe(da!.x);
    expect(va!.yaw).toBe(da!.yaw);
  });
});

describe('interpolation: out-of-order inserts', () => {
  it('inserts out of order into sorted position and still brackets correctly', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(200, [['a', 20, 0, 0, 0]]));
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 10, 0, 0, 0]]));
    expect(buf.count).toBe(3);
    expect(buf.oldestTimeMs).toBe(0);
    expect(buf.newestTimeMs).toBe(200);
    const f = buf.sample(150);
    expect(f.entities.get('a')!.x).toBe(15);
  });

  it('replaces (does not duplicate) an equal timestamp — one snapshot per send tick', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(100, [['a', 1, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 2, 0, 0, 0]]));
    expect(buf.count).toBe(1);
    expect(buf.sample(100).entities.get('a')!.x).toBe(2);
  });

  it('an insert older than everything is still usable from its own time', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(200, [['a', 20, 0, 0, 0]]));
    buf.insert(snap(50, [['a', 5, 0, 0, 0]]));
    const f = buf.sample(50);
    expect(f.entities.get('a')!.x).toBe(5);
    // Sampling exactly ON the oldest edge is inside coverage: the
    // interpolation path ran with alpha 0, so this is not a structural
    // clamp and degenerate stays false (see SampleFrame.degenerate).
    expect(f.behindBuffer).toBe(false);
    expect(f.degenerate).toBe(false);
    expect(f.sampleTimeMs).toBe(50);
  });
});

describe('interpolation: buffer trimming', () => {
  it('keeps at most 40 snapshots, dropping oldest first', () => {
    const buf = new SnapshotBuffer();
    // 44 inserts: 0..4300 ms — the first four (0..300 ms) are trimmed.
    for (let i = 0; i < 44; i++) {
      buf.insert(snap(i * 100, [['a', i, 0, 0, 0]]));
    }
    expect(buf.count).toBe(MAX_SNAPSHOTS_DEFAULT);
    expect(MAX_SNAPSHOTS_DEFAULT).toBe(40);
    expect(buf.oldestTimeMs).toBe(400); // 0, 100, 200, 300 dropped
    expect(buf.newestTimeMs).toBe(4300);
    // Samples inside the surviving window still interpolate exactly.
    expect(buf.sample(450).entities.get('a')!.x).toBe(4.5);
  });

  it('honours a smaller explicit maxSnapshots', () => {
    const buf = new SnapshotBuffer({ maxSnapshots: 2 });
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 1, 0, 0, 0]]));
    buf.insert(snap(200, [['a', 2, 0, 0, 0]]));
    expect(buf.count).toBe(2);
    expect(buf.oldestTimeMs).toBe(100);
  });
});

describe('interpolation: extrapolation cap', () => {
  function twoSnapshotBuffer(): SnapshotBuffer {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.insert(snap(100, [['a', 10, 0, 0, 0]]));
    return buf;
  }

  it('extrapolates linearly past the newest snapshot and flags it', () => {
    const buf = twoSnapshotBuffer();
    const f = buf.sample(112.5); // 12.5 ms past newest, inside the 50 ms cap
    expect(f.extrapolated).toBe(true);
    expect(f.sampleTimeMs).toBe(112.5);
    expect(f.entities.get('a')!.x).toBe(11.25); // lerp alpha 1.125
  });

  it(`clamps at newest + ${EXTRAPOLATION_CAP_MS} ms and keeps the flag`, () => {
    expect(EXTRAPOLATION_CAP_MS).toBe(50);
    const buf = twoSnapshotBuffer();
    const atCap = buf.sample(150); // exactly newest + 50
    expect(atCap.extrapolated).toBe(true);
    expect(atCap.sampleTimeMs).toBe(150);
    expect(atCap.entities.get('a')!.x).toBe(15); // 0 + 10 * 1.5

    const farPast = buf.sample(2000);
    expect(farPast.extrapolated).toBe(true);
    expect(farPast.sampleTimeMs).toBe(150); // clamped back
    expect(farPast.entities.get('a')!.x).toBe(15); // identical state to atCap
  });

  it('does not flag anything inside the covered window', () => {
    const buf = twoSnapshotBuffer();
    expect(buf.sample(0).extrapolated).toBe(false);
    expect(buf.sample(50).extrapolated).toBe(false);
    expect(buf.sample(100).extrapolated).toBe(false);
  });
});

describe('interpolation: edge coverage', () => {
  it('reports behindBuffer when sampling older than the oldest snapshot', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(100, [['a', 1, 0, 0, 0]]));
    buf.insert(snap(200, [['a', 2, 0, 0, 0]]));
    const f = buf.sample(50);
    expect(f.behindBuffer).toBe(true);
    expect(f.sampleTimeMs).toBe(100); // clamped forward
    expect(f.entities.get('a')!.x).toBe(1);
    expect(f.extrapolated).toBe(false);
  });

  it('handles a single snapshot: degenerate passthrough, extrapolation flagged when ahead', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(100, [['a', 7, 0, 0, 0.5]]));
    const on = buf.sample(100);
    expect(on.degenerate).toBe(true);
    expect(on.extrapolated).toBe(false);
    expect(on.entities.get('a')!.x).toBe(7);

    const ahead = buf.sample(500);
    expect(ahead.extrapolated).toBe(true); // rendering ahead of data — flagged honestly
    expect(ahead.degenerate).toBe(true); // but nothing was extrapolated: state is the snapshot
    expect(ahead.entities.get('a')!.x).toBe(7);
  });

  it('returns an empty frame from an empty buffer without throwing', () => {
    const buf = new SnapshotBuffer();
    const f = buf.sample(123);
    expect(f.entities.size).toBe(0);
    expect(f.degenerate).toBe(true);
    expect(f.extrapolated).toBe(false);
    expect(f.behindBuffer).toBe(false);
    expect(f.sampleTimeMs).toBe(123);
  });

  it('clear() empties the buffer', () => {
    const buf = new SnapshotBuffer();
    buf.insert(snap(0, [['a', 0, 0, 0, 0]]));
    buf.clear();
    expect(buf.count).toBe(0);
    expect(buf.oldestTimeMs).toBeNull();
    expect(buf.newestTimeMs).toBeNull();
  });

  it('rejects a non-finite timestamp (a corrupt wire decode must be loud)', () => {
    const buf = new SnapshotBuffer();
    expect(() => buf.insert(snap(Number.NaN, [['a', 0, 0, 0, 0]]))).toThrow();
  });
});
