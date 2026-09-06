/**
 * Kwetu netcode — pure snapshot interpolation for remote entities.
 *
 * Owns: the time-shifted snapshot buffer the client renders remote entities
 * from (NETWORKING.md §7: remote entities render from a buffered window so
 * they move smoothly through loss and jitter instead of stuttering on every
 * late packet — §2's TCP stalls). The pattern is Glenn Fiedler's "Snapshot
 * Interpolation", LINKED from NETWORKING.md §7 and never reproduced; this
 * implementation is ours.
 *
 * Pure: f64 arithmetic only (Law P-1 canonical state; wire quantization
 * happens at the protocol boundary, not here), no clocks, no I/O, no DOM.
 * The caller owns time — every timestamp is an argument, so tests are
 * deterministic and the future render loop feeds it from the engine clock.
 *
 * Tunables and their gates:
 * - renderDelayMs = 100  — the render lag the buffer buys. The game loop
 *   samples at (estimated server time − renderDelayMs) via
 *   sampleFromServerTime().
 * - EXTRAPOLATION_CAP_MS = 50 — how far past the newest snapshot a sample
 *   may extrapolate along the last segment before it is clamped. A clamped
 *   sample is flagged (`extrapolated: true`) so the renderer can decide to
 *   fade/hitch honestly instead of coasting on stale velocity.
 * - MAX_SNAPSHOTS = 40 — FIFO trim bound. At the 20 Hz send rate that is
 *   ~2 s of history against a 100 ms delay + 50 ms cap [DERIVED — arithmetic
 *   on those two rates, not a measurement].
 * All three are [PLACEHOLDER — gate: Phase 5 ratifies against ROADMAP
 * §Budgets; the §Budgets table owns every number that graduates].
 *
 * Yaw interpolation is shortest-arc: the delta is wrapped into [−π, π]
 * before lerping and the result is re-wrapped, so an entity never spins the
 * long way across the branch cut. The wrap PRESERVES ±π exactly (identity
 * inside the closed interval): when the short arc passes the cut, the lerped
 * heading lands on −π or +π according to the direction it crossed — folding
 * the boundary to one side would silently flip that direction. The wrap is
 * written as explicit f64 operations in a fixed order (`wrapPi`) — a port
 * must keep the order and the branch conditions.
 */

/** Default render delay (ms) the buffer smooths across. [PLACEHOLDER — gate: Phase 5] */
export const RENDER_DELAY_MS_DEFAULT = 100;
/** Maximum extrapolation past the newest snapshot (ms) before clamping. [PLACEHOLDER — gate: Phase 5] */
export const EXTRAPOLATION_CAP_MS = 50;
/** FIFO bound on buffered snapshots. [PLACEHOLDER — gate: Phase 5] */
export const MAX_SNAPSHOTS_DEFAULT = 40;

const TWO_PI = Math.PI * 2;

/**
 * Wrap an angle into [−π, π], PRESERVING ±π exactly: identity inside the
 * closed interval, only values strictly outside are folded. (The common
 * double-modulo idiom is not used here — it silently maps +π to −π, which
 * flips a heading that lands exactly on the branch cut.) Fixed f64
 * operation order; a port must keep both the order and the branch
 * conditions. ECMAScript `%` keeps the dividend's sign, so `w` lands in
 * (−2π, 2π) and one conditional fold is enough.
 */
export function wrapPi(angle: number): number {
  let w = angle % TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  else if (w < -Math.PI) w += TWO_PI;
  return w;
}

/** One entity's pose in a snapshot. Canonical f64 metres / radians. */
export interface EntityPose {
  x: number;
  y: number;
  z: number;
  /** Yaw in radians; any branch is accepted, output is wrapped into [−π, π] (±π preserved). */
  yaw: number;
}

/** Entities of one snapshot, keyed by entity id. JSON-shaped (the wire decodes into this). */
export type SnapshotEntities = Readonly<Record<string, EntityPose>>;

/** One server snapshot. `serverTimeMs` is the server's own send-tick clock. */
export interface Snapshot {
  serverTimeMs: number;
  entities: SnapshotEntities;
}

/** An interpolated pose: the sample output for one entity. */
export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** The result of one `sample()` call. */
export interface SampleFrame {
  /** The requested render time, as passed in. */
  readonly requestedTimeMs: number;
  /** The time actually sampled — clamped to the buffer's coverage when the request fell outside it. */
  readonly sampleTimeMs: number;
  /** Poses for the union of the two bracketing snapshots' entity ids. */
  readonly entities: ReadonlyMap<string, InterpolatedPose>;
  /**
   * True when the request was NEWER than the newest snapshot: the state was
   * extrapolated along the last segment (and clamped at
   * newest + EXTRAPOLATION_CAP_MS if the request ran past that). Rendering
   * ahead of data — the flag is the honest signal, not an error.
   */
  readonly extrapolated: boolean;
  /** True when the request was OLDER than the oldest snapshot: clamped forward to it. */
  readonly behindBuffer: boolean;
  /**
   * True when the returned state was NOT interpolated (empty buffer, single
   * snapshot, or a clamp to one snapshot's pose). A request exactly ON a
   * bracketing snapshot's time runs the interpolation path with alpha 0 or
   * 1 — the pose is bitwise that snapshot's, but the frame is not flagged
   * degenerate: the flag tracks structural clamps, not blend factors.
   */
  readonly degenerate: boolean;
}

interface StoredSnapshot {
  readonly serverTimeMs: number;
  /** Copied on insert: the buffer is decoupled from wire-decode reuse and caller mutation. */
  readonly entities: ReadonlyMap<string, EntityPose>;
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function copyPose(p: EntityPose): EntityPose {
  return { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
}

function lerpPose(a: EntityPose, b: EntityPose, alpha: number): InterpolatedPose {
  return {
    x: lerp(a.x, b.x, alpha),
    y: lerp(a.y, b.y, alpha),
    z: lerp(a.z, b.z, alpha),
    // Shortest arc, then re-wrapped so output stays in [−π, π] — wrapPi
    // keeps ±π exactly, so a heading crossing the cut keeps its direction.
    yaw: wrapPi(a.yaw + wrapPi(b.yaw - a.yaw) * alpha),
  };
}

/**
 * The snapshot buffer. Insert server snapshots as they arrive (out of order
 * is fine — insertion is by serverTimeMs; an equal timestamp REPLACES the
 * stored snapshot, keeping one snapshot per send tick). Sample every frame.
 */
export class SnapshotBuffer {
  readonly renderDelayMs: number;
  readonly maxSnapshots: number;

  private readonly snapshots: StoredSnapshot[] = [];

  constructor(options?: { renderDelayMs?: number; maxSnapshots?: number }) {
    this.renderDelayMs = options?.renderDelayMs ?? RENDER_DELAY_MS_DEFAULT;
    this.maxSnapshots = options?.maxSnapshots ?? MAX_SNAPSHOTS_DEFAULT;
    if (!(this.renderDelayMs >= 0)) throw new Error('renderDelayMs must be >= 0');
    if (!(this.maxSnapshots >= 2)) throw new Error('maxSnapshots must be >= 2');
  }

  /** Number of buffered snapshots (after trimming). */
  get count(): number {
    return this.snapshots.length;
  }

  /** Oldest buffered snapshot time, or null when empty. */
  get oldestTimeMs(): number | null {
    const first = this.snapshots[0];
    return first === undefined ? null : first.serverTimeMs;
  }

  /** Newest buffered snapshot time, or null when empty. */
  get newestTimeMs(): number | null {
    const last = this.snapshots[this.snapshots.length - 1];
    return last === undefined ? null : last.serverTimeMs;
  }

  /**
   * Insert a snapshot. Out-of-order inserts land in sorted position; an
   * equal `serverTimeMs` replaces the stored one. Entities are copied, so
   * the caller may reuse its decode buffers. Trims to `maxSnapshots`,
   * dropping oldest first.
   */
  insert(snapshot: Snapshot): void {
    if (!Number.isFinite(snapshot.serverTimeMs)) {
      throw new Error('snapshot serverTimeMs must be a finite number');
    }
    const stored: StoredSnapshot = {
      serverTimeMs: snapshot.serverTimeMs,
      entities: new Map(Object.entries(snapshot.entities)),
    };
    // Binary search for the insertion point (first index with time > new time).
    let lo = 0;
    let hi = this.snapshots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midTime = this.snapshots[mid]?.serverTimeMs;
      if (midTime === undefined) break;
      if (midTime <= snapshot.serverTimeMs) lo = mid + 1;
      else hi = mid;
    }
    const prev = this.snapshots[lo - 1];
    if (prev !== undefined && prev.serverTimeMs === snapshot.serverTimeMs) {
      this.snapshots[lo - 1] = stored; // equal timestamp replaces (one snapshot per send tick)
    } else {
      this.snapshots.splice(lo, 0, stored);
    }
    while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
  }

  clear(): void {
    this.snapshots.length = 0;
  }

  /**
   * Sample the state to render at `renderTimeMs` — a time already expressed
   * on the snapshot (server) clock, DELAY INCLUDED. The convenience path is
   * `sampleFromServerTime(serverTimeEstimateMs)`, which subtracts
   * `renderDelayMs` first.
   */
  sample(renderTimeMs: number): SampleFrame {
    const count = this.snapshots.length;
    if (count === 0) {
      return {
        requestedTimeMs: renderTimeMs,
        sampleTimeMs: renderTimeMs,
        entities: new Map(),
        extrapolated: false,
        behindBuffer: false,
        degenerate: true,
      };
    }
    const newest = this.snapshots[count - 1];
    const oldest = this.snapshots[0];
    if (newest === undefined || oldest === undefined) {
      throw new Error('unreachable: non-empty buffer bounds'); // keeps noUncheckedIndexedAccess honest
    }

    if (renderTimeMs > newest.serverTimeMs) {
      // Extrapolation branch: along the last segment, clamped at newest + cap.
      const clampedTime = Math.min(renderTimeMs, newest.serverTimeMs + EXTRAPOLATION_CAP_MS);
      if (count < 2) {
        return {
          requestedTimeMs: renderTimeMs,
          sampleTimeMs: newest.serverTimeMs,
          entities: this.poseMapOf(newest),
          extrapolated: true,
          behindBuffer: false,
          degenerate: true,
        };
      }
      const a = this.snapshots[count - 2];
      if (a === undefined) throw new Error('unreachable: non-empty buffer bounds');
      const span = newest.serverTimeMs - a.serverTimeMs;
      // Extrapolate ALONG the last segment, anchored at the NEWEST snapshot:
      // pose = newest + (newest − a)·k with k = (clamped − newest)/span. The
      // segment's slope continues from the latest known state — anchoring at
      // a instead would snap the entity back toward the older snapshot.
      // Expressed as the same lerpPose(a, b, alpha): alpha = 1 + k.
      const k = span > 0 ? (clampedTime - newest.serverTimeMs) / span : 0;
      const alpha = 1 + k;
      return {
        requestedTimeMs: renderTimeMs,
        sampleTimeMs: clampedTime,
        entities: this.interpMapOf(a, newest, alpha),
        extrapolated: true,
        behindBuffer: false,
        degenerate: false,
      };
    }

    if (renderTimeMs < oldest.serverTimeMs) {
      // Behind the buffer: clamp forward to the oldest known state.
      return {
        requestedTimeMs: renderTimeMs,
        sampleTimeMs: oldest.serverTimeMs,
        entities: this.poseMapOf(oldest),
        extrapolated: false,
        behindBuffer: true,
        degenerate: true,
      };
    }

    if (count === 1) {
      // Exactly on the single snapshot's time (the range checks above leave only this).
      return {
        requestedTimeMs: renderTimeMs,
        sampleTimeMs: oldest.serverTimeMs,
        entities: this.poseMapOf(oldest),
        extrapolated: false,
        behindBuffer: false,
        degenerate: true,
      };
    }

    // Interpolation branch: find the largest index i with time[i] <= renderTimeMs.
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const midTime = this.snapshots[mid]?.serverTimeMs;
      if (midTime === undefined) break;
      if (midTime <= renderTimeMs) lo = mid;
      else hi = mid - 1;
    }
    const a = this.snapshots[lo];
    const b = this.snapshots[lo + 1];
    if (a === undefined) throw new Error('unreachable: bracket search inside non-empty buffer');
    if (b === undefined) {
      // renderTimeMs === newest exactly: passthrough, nothing to interpolate toward.
      return {
        requestedTimeMs: renderTimeMs,
        sampleTimeMs: a.serverTimeMs,
        entities: this.poseMapOf(a),
        extrapolated: false,
        behindBuffer: false,
        degenerate: true,
      };
    }
    const span = b.serverTimeMs - a.serverTimeMs;
    const alpha = span > 0 ? (renderTimeMs - a.serverTimeMs) / span : 0;
    return {
      requestedTimeMs: renderTimeMs,
      sampleTimeMs: renderTimeMs,
      entities: this.interpMapOf(a, b, alpha),
      extrapolated: false,
      behindBuffer: false,
      degenerate: false,
    };
  }

  /** The game-loop entry point: sample at (estimated server time − renderDelayMs). */
  sampleFromServerTime(serverTimeEstimateMs: number): SampleFrame {
    return this.sample(serverTimeEstimateMs - this.renderDelayMs);
  }

  private poseMapOf(s: StoredSnapshot): Map<string, InterpolatedPose> {
    const out = new Map<string, InterpolatedPose>();
    for (const [id, pose] of s.entities) out.set(id, copyPose(pose));
    return out;
  }

  /**
   * Interpolated union of two snapshots: ids in both lerp; an id present in
   * only one side takes that side's pose (a spawn appears at its first
   * snapshot; a departure holds until the window passes it).
   */
  private interpMapOf(a: StoredSnapshot, b: StoredSnapshot, alpha: number): Map<string, InterpolatedPose> {
    const out = new Map<string, InterpolatedPose>();
    for (const [id, poseA] of a.entities) {
      const poseB = b.entities.get(id);
      out.set(id, poseB === undefined ? copyPose(poseA) : lerpPose(poseA, poseB, alpha));
    }
    for (const [id, poseB] of b.entities) {
      if (!out.has(id)) out.set(id, copyPose(poseB));
    }
    return out;
  }
}
