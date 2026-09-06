/**
 * S0.8 — AoI cell-grid correctness probes (throwaway spike, vitest). These
 * pin the algorithm aoi.ts documents, because that file is the algorithm
 * spec for the Phase-5 Go port: the tests assert the RULE (floor cell
 * semantics, rect-intersects-disc interest, rebuild-per-tick set semantics,
 * membership invariants), not implementation details.
 */
import { describe, it, expect } from 'vitest';
import { AoiGrid, cellKey, cellCoordOf } from './aoi.ts';

/** Small deterministic LCG (mulberry32) — same generator family as bench.mjs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sorted copy of an interest set, for order-independent comparison. */
function sortedIds(ids: readonly number[]): number[] {
  return [...ids].sort((a, b) => a - b);
}

/**
 * Independent expected-interest computation (does NOT use AoiGrid's range
 * logic): presence q is in the observer's interest set iff the rectangle of
 * q's own cell has its nearest point to the observer within the radius.
 */
function expectedInterest(
  ox: number,
  oz: number,
  xs: number[],
  zs: number[],
  selfId: number,
  cellSize: number,
  radius: number,
): number[] {
  const out: number[] = [];
  const rSq = radius * radius;
  for (let i = 0; i < xs.length; i++) {
    const id = i + 1;
    if (id === selfId) continue;
    const cx = Math.floor(xs[i]! / cellSize);
    const cz = Math.floor(zs[i]! / cellSize);
    const nx = Math.min(Math.max(ox, cx * cellSize), (cx + 1) * cellSize);
    const nz = Math.min(Math.max(oz, cz * cellSize), (cz + 1) * cellSize);
    const dx = ox - nx;
    const dz = oz - nz;
    if (dx * dx + dz * dz <= rSq) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

describe('S0.8: cell key + floor semantics', () => {
  it('cellKey is injective across a negative-to-positive coordinate window', () => {
    const keys = new Set<number>();
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) keys.add(cellKey(cx, cz));
    }
    expect(keys.size).toBe(49);
  });

  it('cellCoordOf uses floor semantics: a boundary position belongs to the positive-side cell', () => {
    expect(cellCoordOf(250, 0, 100)).toEqual({ cx: 2, cz: 0 });
    expect(cellCoordOf(-0.0001, -100, 100)).toEqual({ cx: -1, cz: -1 });
    expect(cellCoordOf(-250.5, 99.9, 100)).toEqual({ cx: -3, cz: 0 });
    expect(cellCoordOf(0, 0, 100)).toEqual({ cx: 0, cz: 0 });
  });
});

describe('S0.8: membership invariants (add / remove / move)', () => {
  it('keeps populations summed over cells equal to the presence count and stores no empty cells', () => {
    const grid = new AoiGrid({ cellSize: 100, aoiRadius: 250 });
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i++) grid.add(i + 1, rng() * 1000, rng() * 1000);
    expect(grid.count()).toBe(50);
    let sum = 0;
    grid.populations().forEach((pop) => {
      expect(pop).toBeGreaterThan(0); // no empty cells stored
      sum += pop;
    });
    expect(sum).toBe(50);
  });

  it('remove() drops the id from every interest set, updates populations, and prunes emptied cells', () => {
    const grid = new AoiGrid({ cellSize: 100, aoiRadius: 250 });
    const rng = mulberry32(2);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < 40; i++) {
      const x = rng() * 800;
      const z = rng() * 800;
      xs.push(x);
      zs.push(z);
      grid.add(i + 1, x, z);
    }
    const cellsBefore = grid.cellCount();
    const removed = [3, 11, 27];
    for (const id of removed) grid.remove(id);
    grid.rebuildTick();
    let sum = 0;
    grid.populations().forEach((pop) => {
      expect(pop).toBeGreaterThan(0);
      sum += pop;
    });
    expect(sum).toBe(37);
    expect(grid.cellCount()).toBeLessThanOrEqual(cellsBefore);
    expect(grid.has(11)).toBe(false);
    for (const [id, buf] of grid.rebuildTick()) {
      for (const gone of removed) expect(buf).not.toContain(gone);
      expect(buf).not.toContain(id); // self never in own interest set
    }
    expect(() => grid.remove(11)).toThrow();
  });

  it('move() reindexes membership only across cell changes and updates interest sets both sides', () => {
    const grid = new AoiGrid({ cellSize: 100, aoiRadius: 200 });
    grid.add(1, 500, 500); // observer
    grid.add(2, 520, 520); // neighbour, same cell as observer
    grid.add(3, 900, 900); // far away, other cell
    grid.rebuildTick();
    expect(sortedIds(grid.interestOf(1))).toEqual([2]);
    expect(sortedIds(grid.interestOf(3))).toEqual([]);

    grid.move(3, 515, 518); // into the observer's neighbourhood
    grid.rebuildTick();
    expect(sortedIds(grid.interestOf(1))).toEqual([2, 3]);
    expect(sortedIds(grid.interestOf(3))).toEqual([1, 2]);

    const cellsBefore = grid.cellCount();
    grid.move(2, 521, 522); // same cell: position-only update
    grid.rebuildTick();
    expect(sortedIds(grid.interestOf(1))).toEqual([2, 3]);
    expect(grid.cellCount()).toBe(cellsBefore);

    grid.move(2, 100, 100); // far away
    grid.rebuildTick();
    expect(sortedIds(grid.interestOf(1))).toEqual([3]);
    let sum = 0;
    grid.populations().forEach((pop) => (sum += pop));
    expect(sum).toBe(3);
  });

  it('throws on duplicate add, unknown move and unknown remove', () => {
    const grid = new AoiGrid({ cellSize: 100, aoiRadius: 250 });
    grid.add(1, 10, 10);
    expect(() => grid.add(1, 20, 20)).toThrow();
    expect(() => grid.move(9, 20, 20)).toThrow();
    expect(() => grid.remove(9)).toThrow();
    expect(() => grid.interestOf(9)).toThrow();
    expect(() => grid.aoiCellCount(9)).toThrow();
  });
});

describe('S0.8: interest = cells whose rectangle intersects the AoI disc', () => {
  it('matches an independent brute-force computation of the rect-intersection rule', () => {
    const cellSize = 100;
    const radius = 250;
    const grid = new AoiGrid({ cellSize, aoiRadius: radius });
    const rng = mulberry32(42);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < 400; i++) {
      const x = rng() * 2000;
      const z = rng() * 2000;
      xs.push(x);
      zs.push(z);
      grid.add(i + 1, x, z);
    }
    grid.rebuildTick();
    for (let o = 0; o < 25; o++) {
      const selfId = o * 16 + 1;
      const want = expectedInterest(xs[selfId - 1]!, zs[selfId - 1]!, xs, zs, selfId, cellSize, radius);
      expect(sortedIds(grid.interestOf(selfId))).toEqual(want);
    }
  });

  it('interest is a cell-rectangle superset: contains every presence within the radius, only presences within radius + full cell diagonal', () => {
    const cellSize = 250;
    const radius = 500;
    // Over-inclusion bound: a member sits inside its cell, so it is at most
    // (nearest-point distance <= R) + the cell's FULL diagonal away.
    const maxOverinclusion = radius + cellSize * Math.SQRT2;
    const grid = new AoiGrid({ cellSize, aoiRadius: radius });
    const rng = mulberry32(7);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = rng() * 3000;
      const z = rng() * 3000;
      xs.push(x);
      zs.push(z);
      grid.add(i + 1, x, z);
    }
    grid.rebuildTick();
    const ox = xs[0]!;
    const oz = zs[0]!;
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 1; i < xs.length; i++) {
      const dx = ox - xs[i]!;
      const dz = oz - zs[i]!;
      const d2 = dx * dx + dz * dz;
      if (d2 <= radius * radius) near.push(i + 1);
      if (d2 > maxOverinclusion * maxOverinclusion) far.push(i + 1);
    }
    const got = new Set(grid.interestOf(1));
    for (const id of near) expect(got.has(id)).toBe(true);
    for (const id of far) expect(got.has(id)).toBe(false);
  });

  it('exact tangency: a cell whose rectangle touches the disc at exactly R is included (padded candidate range), its diagonal neighbour is not', () => {
    const grid = new AoiGrid({ cellSize: 1000, aoiRadius: 500 });
    // Observer at a 4-cell corner point (2500, 2500), cell (2,2).
    grid.add(1, 2500, 2500);
    grid.add(2, 3050, 2500); // cell (3,2): rect tangent east at exactly 500 m
    grid.add(3, 3050, 2550); // same cell (3,2) -> included by over-inclusion
    grid.add(4, 1950, 2500); // cell (1,2): rect tangent west
    grid.add(5, 1950, 2450); // same cell (1,2) -> included by over-inclusion
    grid.add(6, 2500, 3050); // cell (2,3): rect tangent north
    grid.add(7, 2500, 1950); // cell (2,1): rect tangent south
    grid.add(8, 2501, 2501); // own cell (2,2)
    grid.add(9, 1950, 1950); // cell (1,1): nearest point (2000,2000) = 707 m -> out
    grid.add(10, 3050, 3050); // cell (3,3): diagonal, 707 m -> out
    grid.add(11, 4500, 4500); // cell (4,4): far -> out
    grid.rebuildTick();
    expect(sortedIds(grid.interestOf(1))).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // The AoI cell set is the plus-shape around the corner point: own cell + 4 tangent cells.
    expect(grid.aoiCellCount(1)).toBe(5);
    // Presence 9 at (1950,1950) has its own 4-cell AoI: own cell (1,1), the
    // two tangent cells (2,1)/(1,2) at 50 m, and diagonal (2,2) at 70.7 m.
    expect(grid.aoiCellCount(9)).toBe(4);
  });

  it('finer aligned grids never add interest: interest(100) subseteq interest(500) subseteq interest(1000)', () => {
    const rng = mulberry32(99);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < 250; i++) {
      xs.push(rng() * 2500);
      zs.push(rng() * 2500);
    }
    const sets: Set<number>[] = [];
    for (const cs of [100, 500, 1000]) {
      const grid = new AoiGrid({ cellSize: cs, aoiRadius: 500 });
      for (let i = 0; i < xs.length; i++) grid.add(i + 1, xs[i]!, zs[i]!);
      grid.rebuildTick();
      sets.push(new Set(grid.interestOf(1)));
    }
    const [fine, mid, coarse] = sets as [Set<number>, Set<number>, Set<number>];
    for (const id of fine) expect(mid.has(id)).toBe(true);
    for (const id of mid) expect(coarse.has(id)).toBe(true);
  });

  it('rebuild-per-tick is deterministic as a set and buffers are reused, never reallocated', () => {
    const grid = new AoiGrid({ cellSize: 250, aoiRadius: 500 });
    const rng = mulberry32(1234);
    for (let i = 0; i < 120; i++) grid.add(i + 1, rng() * 2000, rng() * 2000);
    grid.rebuildTick();
    const first = sortedIds(grid.interestOf(5));
    const bufRef = grid.interestOf(5);
    grid.rebuildTick();
    const second = sortedIds(grid.interestOf(5));
    expect(second).toEqual(first);
    expect(grid.interestOf(5)).toBe(bufRef); // reused buffer (Go port: buf[:0])
  });
});

describe('S0.8: benchmark-shape smoke (no timing)', () => {
  it('handles the benchmark config space: 5000 presences, cellSize 250, clustered placement, one rebuild', () => {
    const grid = new AoiGrid({ cellSize: 250, aoiRadius: 500 });
    const rng = mulberry32(20260906);
    const count = 5000;
    const area = 5000;
    const hotspotSide = Math.sqrt(0.1) * area;
    for (let i = 0; i < count; i++) {
      let x: number;
      let z: number;
      if (rng() < 0.8) {
        x = area / 2 + (rng() - 0.5) * hotspotSide;
        z = area / 2 + (rng() - 0.5) * hotspotSide;
      } else {
        x = rng() * area;
        z = rng() * area;
      }
      grid.add(i + 1, x, z);
    }
    expect(grid.count()).toBe(count);
    const interests = grid.rebuildTick();
    expect(interests.size).toBe(count);
    let sum = 0;
    grid.populations().forEach((pop) => (sum += pop));
    expect(sum).toBe(count);
    // Dense hotspot cells at 250 m hold on the order of a hundred presences
    // (expected ~100 per fully-hotspot cell at 80% of 5000 in 10% of area).
    expect(grid.maxCellPopulation().population).toBeGreaterThan(60);
    expect(grid.maxCellPopulation().population).toBeLessThan(160);
    // Sampled set-hygiene: no duplicates, no self in any sampled interest
    // set. Violations are counted and asserted once — expect() per element
    // would dominate the runtime of a 6M-entry rebuild.
    let checked = 0;
    let violations = 0;
    for (const [id, buf] of interests) {
      if (checked++ >= 200) break;
      const seen = new Set<number>();
      for (const mid of buf) {
        if (mid === id || seen.has(mid)) {
          violations++;
          break;
        }
        seen.add(mid);
      }
    }
    expect(violations).toBe(0);
  }, 20000);
});
