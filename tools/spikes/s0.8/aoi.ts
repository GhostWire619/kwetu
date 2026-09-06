/**
 * S0.8 — AoI cell grid (THROWAWAY spike implementation under the CLAUDE.md
 * tools/spikes/ carve-out). This file is ALSO the algorithm spec for the
 * Phase-5 Go port of the region-match interest manager (ARCHITECTURE.md §6,
 * NETWORKING.md §5/§9): the Go port must reproduce THIS algorithm step for
 * step. Zero dependencies; pure f64 arithmetic; no I/O; no clocks.
 *
 * ALGORITHM (normative for the Go port)
 * ------------------------------------
 * 1. Static square cell grid over the region. Cell of a position is
 *    (cx, cz) = (floor(x / cellSize), floor(z / cellSize)) — floor, so the
 *    grid extends over negative coordinates; cell k spans [k·c, (k+1)·c)
 *    and a position exactly on a boundary belongs to the positive-side cell.
 * 2. Presence membership: every presence id lives in exactly one cell's
 *    member array. add / remove / move maintain the invariant. remove and
 *    the cell-change branch of move are O(population of that cell)
 *    (indexOf + swap-with-last); move within a cell updates position only.
 *    Cells that empty out are pruned from the map (memory reclamation).
 * 3. Per tick — REBUILD semantics (ARCHITECTURE.md §6 "per tick, the runtime
 *    computes each client's area of interest as a set of cells"; no
 *    incremental diff): every presence is an observer. Its area of interest
 *    is the set of cells whose closed rectangle intersects the disc of
 *    radius `aoiRadius` around the observer (nearest point of the cell
 *    rectangle to the observer, f64, distance <= radius). The observer's
 *    interest set is the member ids of those cells EXCLUDING itself.
 * 4. Candidate cell range before the rectangle test is padded one ring
 *    beyond the raw floor bounds: cx in [floor((x−R)/c) − 1,
 *    floor((x+R)/c) + 1], same for cz. In exact arithmetic floor((x±R)/c)
 *    already reaches a tangential cell; the padding is what keeps that
 *    true under f64 rounding of (x±R)/c (a rounded-down quotient would
 *    otherwise drop an exactly-tangent cell). The rectangle test is the
 *    sole authority on membership.
 * 5. Interest buffers are REUSED across ticks (cleared, never reallocated)
 *    so a rebuild tick allocates nothing; cell member arrays are long-lived.
 *    The Go port does the same (`buf = buf[:0]`).
 * 6. Interest sets are SETS: element order is unspecified. TS Map iterates
 *    in insertion order; Go map range order is randomized — a port consumer
 *    that needs order (e.g. stable wire field order) must sort explicitly.
 *    The rebuild's outputs are identical as sets.
 *
 * CELL KEY PACKING (identical in Go as uint64)
 * --------------------------------------------
 * key = (cx + 2^20) * 2^21 + (cz + 2^20): injective for |cx|, |cz| < 2^20
 * cells, and exact in f64 (max < 2^42 << 2^53). At the smallest benchmarked
 * cell (100 m) that bounds the grid at ±1.05e8 m — about 2.6x Earth's
 * circumference (4.0e7 m); any Kwetu region sits far inside it.
 *
 * Numbers are f64 throughout (ADR-002 Law P-1 canonical state). Any wire
 * quantization is a Phase-5 protocol concern (NETWORKING.md §7), not this
 * structure's. Boundary membership at exactly radius distance is decided by
 * the f64 arithmetic shown (same operations, IEEE-754 double) — a Go port
 * computing the same expressions in the same order gets the same answer.
 */

export interface AoiParams {
  /** Cell edge length in metres (> 0). */
  cellSize: number;
  /** Area-of-interest radius in metres (> 0). */
  aoiRadius: number;
}

const KEY_OFFSET = 1 << 20; // 1048576
const KEY_ROW = 1 << 21; // 2097152

/** Packed, f64-exact, injective cell key for |cx|,|cz| < 2^20. */
export function cellKey(cx: number, cz: number): number {
  return (cx + KEY_OFFSET) * KEY_ROW + (cz + KEY_OFFSET);
}

/** Floor cell coordinates of a position (boundary belongs to the positive side). */
export function cellCoordOf(
  x: number,
  z: number,
  cellSize: number,
): { cx: number; cz: number } {
  return { cx: Math.floor(x / cellSize), cz: Math.floor(z / cellSize) };
}

export class AoiGrid {
  readonly cellSize: number;
  readonly aoiRadius: number;

  private readonly radiusSq: number;
  /** cellKey -> member ids (long-lived; swap-remove; emptied cells pruned). */
  private readonly cells = new Map<number, number[]>();
  /** presence id -> its current cell key. */
  private readonly cellOfId = new Map<number, number>();
  /** presence id -> [x, z] in f64 canonical metres. Doubles as the presence set. */
  private readonly pos = new Map<number, Float64Array>();
  /** presence id -> reused interest buffer (cleared per tick, never reallocated). */
  private readonly interests = new Map<number, number[]>();

  constructor(params: AoiParams) {
    if (!(params.cellSize > 0)) throw new Error('cellSize must be > 0');
    if (!(params.aoiRadius > 0)) throw new Error('aoiRadius must be > 0');
    this.cellSize = params.cellSize;
    this.aoiRadius = params.aoiRadius;
    this.radiusSq = params.aoiRadius * params.aoiRadius;
  }

  /** Index a new presence. Duplicate ids are a caller bug and throw. */
  add(id: number, x: number, z: number): void {
    if (this.cellOfId.has(id)) throw new Error(`presence ${id} is already indexed`);
    const key = this.cellKeyAt(x, z);
    this.cellOfId.set(id, key);
    this.pos.set(id, Float64Array.of(x, z));
    this.interests.set(id, []);
    let members = this.cells.get(key);
    if (members === undefined) {
      members = [];
      this.cells.set(key, members);
    }
    members.push(id);
  }

  has(id: number): boolean {
    return this.cellOfId.has(id);
  }

  /** Drop a presence. Unknown ids are a caller bug and throw. */
  remove(id: number): void {
    const key = this.cellOfId.get(id);
    if (key === undefined) throw new Error(`presence ${id} is not indexed`);
    this.cellOfId.delete(id);
    this.pos.delete(id);
    this.interests.delete(id);
    const members = this.cells.get(key);
    if (members !== undefined) {
      const i = members.indexOf(id); // O(population of cell) — spec'd tradeoff
      const last = members.pop() as number;
      if (i < members.length) members[i] = last;
      if (members.length === 0) this.cells.delete(key);
    }
  }

  /**
   * Update a presence's position; reindexes membership only when the floor
   * cell changes. Unknown ids are a caller bug and throw.
   */
  move(id: number, x: number, z: number): void {
    const p = this.pos.get(id);
    const oldKey = this.cellOfId.get(id);
    if (p === undefined || oldKey === undefined) {
      throw new Error(`presence ${id} is not indexed`);
    }
    p[0] = x;
    p[1] = z;
    const newKey = this.cellKeyAt(x, z);
    if (newKey === oldKey) return;
    const oldMembers = this.cells.get(oldKey);
    if (oldMembers !== undefined) {
      const i = oldMembers.indexOf(id);
      const last = oldMembers.pop() as number;
      if (i < oldMembers.length) oldMembers[i] = last;
      if (oldMembers.length === 0) this.cells.delete(oldKey);
    }
    let members = this.cells.get(newKey);
    if (members === undefined) {
      members = [];
      this.cells.set(newKey, members);
    }
    members.push(id);
    this.cellOfId.set(id, newKey);
  }

  /**
   * One full rebuild tick: every presence's interest buffer is cleared and
   * refilled with the member ids of the cells intersecting its AoI disc,
   * excluding itself (rule 3/4 above). Returns the internal buffer map —
   * READ-ONLY by contract: the arrays are reused next tick.
   */
  rebuildTick(): ReadonlyMap<number, readonly number[]> {
    const cs = this.cellSize;
    const rSq = this.radiusSq;
    const collect = (p: Float64Array, id: number): void => {
      const buf = this.interests.get(id);
      if (buf === undefined) return; // unreachable: buffers are created in add()
      buf.length = 0;
      const x = p[0] as number;
      const z = p[1] as number;
      const minCx = Math.floor((x - this.aoiRadius) / cs) - 1;
      const maxCx = Math.floor((x + this.aoiRadius) / cs) + 1;
      const minCz = Math.floor((z - this.aoiRadius) / cs) - 1;
      const maxCz = Math.floor((z + this.aoiRadius) / cs) + 1;
      for (let cz = minCz; cz <= maxCz; cz++) {
        const zLo = cz * cs;
        const zHi = zLo + cs;
        const dz = z < zLo ? zLo - z : z > zHi ? z - zHi : 0;
        if (dz * dz > rSq) continue;
        for (let cx = minCx; cx <= maxCx; cx++) {
          const xLo = cx * cs;
          const xHi = xLo + cs;
          const dx = x < xLo ? xLo - x : x > xHi ? x - xHi : 0;
          if (dx * dx + dz * dz > rSq) continue;
          const members = this.cells.get(cellKey(cx, cz));
          if (members === undefined) continue;
          for (let k = 0; k < members.length; k++) {
            const mid = members[k] as number;
            if (mid !== id) buf.push(mid);
          }
        }
      }
    };
    this.pos.forEach(collect);
    return this.interests;
  }

  /**
   * Number of cells whose rectangle intersects the AoI disc of one presence
   * (the size of the cell set the rebuild walks for that observer). Used by
   * voice-culling sizing and message-framing analysis; O(cells in range).
   */
  aoiCellCount(id: number): number {
    const p = this.pos.get(id);
    if (p === undefined) throw new Error(`presence ${id} is not indexed`);
    const cs = this.cellSize;
    const rSq = this.radiusSq;
    const x = p[0] as number;
    const z = p[1] as number;
    const minCx = Math.floor((x - this.aoiRadius) / cs) - 1;
    const maxCx = Math.floor((x + this.aoiRadius) / cs) + 1;
    const minCz = Math.floor((z - this.aoiRadius) / cs) - 1;
    const maxCz = Math.floor((z + this.aoiRadius) / cs) + 1;
    let n = 0;
    for (let cz = minCz; cz <= maxCz; cz++) {
      const zLo = cz * cs;
      const zHi = zLo + cs;
      const dz = z < zLo ? zLo - z : z > zHi ? z - zHi : 0;
      if (dz * dz > rSq) continue;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const xLo = cx * cs;
        const xHi = xLo + cs;
        const dx = x < xLo ? xLo - x : x > xHi ? x - xHi : 0;
        if (dx * dx + dz * dz <= rSq) n++;
      }
    }
    return n;
  }

  /** The observer's current interest buffer (reused next tick — do not mutate). */
  interestOf(id: number): readonly number[] {
    const buf = this.interests.get(id);
    if (buf === undefined) throw new Error(`presence ${id} is not indexed`);
    return buf;
  }

  /** Presence count. */
  count(): number {
    return this.pos.size;
  }

  /** Occupied cell count. */
  cellCount(): number {
    return this.cells.size;
  }

  /** Snapshot copy of cellKey -> population. Stats use only — never in a tick. */
  populations(): Map<number, number> {
    const out = new Map<number, number>();
    this.cells.forEach((members, key) => out.set(key, members.length));
    return out;
  }

  /** Max cell population without copying. Stats use only — never in a tick. */
  maxCellPopulation(): { cellKey: number; population: number } {
    let bestKey = -1;
    let best = 0;
    this.cells.forEach((members, key) => {
      if (members.length > best) {
        best = members.length;
        bestKey = key;
      }
    });
    return { cellKey: bestKey, population: best };
  }

  private cellKeyAt(x: number, z: number): number {
    return cellKey(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
  }
}
