/**
 * S0.7 probe — TT universe-clock adapter (THROWAWAY spike code, CLAUDE.md carve-out).
 *
 * Implements the COORDINATE_SYSTEM.md §4 authoritative time contract and encodes
 * ADR-001 Decision 3 as testable semantics:
 *
 *   TT seconds since J2000 TT is the one authoritative simulation instant ("worldTime").
 *   Public shared clock rate is real time (1). Offline coast preserves duration.
 *   Accelerated isolated training (warp) can never merge state.
 *
 * Scale rules (NASA NAIF time reqs; COORDINATE_SYSTEM.md §4):
 *   TAI  = UTC + leapOffset(t)          [versioned leap-second table, this folder]
 *   TT   = TAI + 32.184 s               [EXTERNAL — definition of TT (IAU 1991)]
 *   tt   = seconds since J2000 TT, where J2000 TT = 2000-01-01T12:00:00 TT
 *        = POSIX UTC label 2000-01-01T11:58:55.816Z (TAI−UTC was 32 s then).
 *
 * JS Date is used ONLY for POSIX civil-label arithmetic (Date.UTC/Date.now):
 * it never stores, carries, or advances simulation time (ECMAScript time values
 * have no leap-second labels — COORDINATE_SYSTEM.md §4). Simulation time inside a
 * process always comes from an injectable MONOTONIC source anchored once; the wall
 * clock only seeds/audits anchors and computes civil downtime across a restart.
 */
import leapTableJson from './leap-seconds.json' with { type: 'json' };

export const TIME_ADAPTER_REVISION = 'kwetu-tt-adapter/1';

/** TT = TAI + 32.184 s, exact by definition of Terrestrial Time. */
export const TAI_MINUS_TT_SECONDS = 32.184;
export const MS_PER_DAY = 86_400_000;
const TAI_MINUS_TT_MS = TAI_MINUS_TT_SECONDS * 1000; // 32184

/** The POSIX UTC label (ms) of civil 2000-01-01T12:00:00Z. */
const J2000_CIVIL_POSIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // 946728000000

// --- Leap table -------------------------------------------------------------

export interface LeapEntry {
  /** POSIX UTC date label at which the offset step becomes effective. */
  readonly utcEffective: string;
  readonly taiMinusUtc: number;
  readonly type: 'positive';
}

export interface LeapTable {
  readonly schema: string;
  readonly revision: string;
  readonly baseOffsetSeconds: number;
  readonly baseEffectiveUtc: string;
  readonly currentOffsetSeconds: number;
  readonly currentOffsetEffectiveUtc: string;
  readonly entries: readonly LeapEntry[];
}

const table = leapTableJson as unknown as LeapTable;

/** Effective POSIX ms of a table row (rows are whole UTC dates). */
function entryEffectiveMs(entry: LeapEntry): number {
  return Date.parse(entry.utcEffective + 'T00:00:00Z');
}

/**
 * TAI−UTC offset in seconds in force at a POSIX UTC label (integer ms).
 * POSIX labels skip inserted seconds, so the step sits exactly at the effective
 * date label. Throws outside table coverage (base 1972-01-01 .. today) — the
 * caller must not silently extrapolate leap counts it does not have.
 */
export function taiMinusUtcAtPosixMs(posixMs: number): number {
  if (!Number.isFinite(posixMs)) throw new Error('ttClock: non-finite POSIX ms');
  const entries = table.entries;
  const firstMs = entryEffectiveMs(entries[0] as LeapEntry);
  if (posixMs < firstMs) {
    throw new Error(
      `ttClock: POSIX instant ${new Date(posixMs).toISOString()} predates leap-table coverage ` +
      `(first entry ${table.baseEffectiveUtc}); refusing to extrapolate leap counts.`,
    );
  }
  let offset = table.baseOffsetSeconds;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LeapEntry;
    if (entryEffectiveMs(entry) <= posixMs) offset = entry.taiMinusUtc;
    else break;
  }
  return offset;
}

/** Structural validation of the committed table (monotone dates, +1 steps). */
export function validateLeapTable(): { entries: number; first: string; last: string; current: number } {
  const entries = table.entries;
  if (entries.length === 0) throw new Error('ttClock: empty leap table');
  let prevMs = entryEffectiveMs(entries[0] as LeapEntry);
  let prevOffset = (entries[0] as LeapEntry).taiMinusUtc;
  if (prevOffset !== table.baseOffsetSeconds) {
    throw new Error('ttClock: first entry must carry the base offset');
  }
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i] as LeapEntry;
    const ms = entryEffectiveMs(e);
    if (ms <= prevMs) throw new Error(`ttClock: non-monotone entry at ${e.utcEffective}`);
    if (e.taiMinusUtc !== prevOffset + 1) {
      throw new Error(
        `ttClock: entry ${e.utcEffective} steps ${prevOffset}->${e.taiMinusUtc}; this adapter only ` +
        `accepts +1 steps (no negative leap second has ever been inserted — see ADR-008 open item).`,
      );
    }
    prevMs = ms;
    prevOffset = e.taiMinusUtc;
  }
  const last = entries[entries.length - 1] as LeapEntry;
  if (last.taiMinusUtc !== table.currentOffsetSeconds || last.utcEffective !== table.currentOffsetEffectiveUtc) {
    throw new Error('ttClock: table header current-offset fields disagree with the last entry');
  }
  return {
    entries: entries.length,
    first: (entries[0] as LeapEntry).utcEffective,
    last: last.utcEffective,
    current: last.taiMinusUtc,
  };
}

// --- Core conversions (POSIX civil label <-> TT seconds) --------------------

/**
 * J2000 TT expressed as a POSIX UTC label (ms): the civil 12:00:00 label minus
 * the 32 s leap offset then in force minus the 32.184 s TT−TAI constant.
 * Derives to 946727935816 = the label 2000-01-01T11:58:55.816Z.
 */
export const J2000_TT_POSIX_MS =
  J2000_CIVIL_POSIX_MS - (taiMinusUtcAtPosixMs(J2000_CIVIL_POSIX_MS) * 1000 + TAI_MINUS_TT_MS);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Strict POSIX-UTC ISO parse -> integer ms. Rejects leap-second labels (POSIX cannot represent them). */
function posixMsFromIso(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`ttClock: expected strict UTC ISO 'YYYY-MM-DDTHH:MM:SS[.mmm]Z', got '${iso}'`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  const fracStr = m[7];
  const frac = fracStr === undefined ? 0 : Number(fracStr.padEnd(3, '0'));
  if (s > 59) {
    throw new Error(
      `ttClock: second value ${s} in '${iso}' — POSIX UTC labels cannot express a leap second (:60); use the POSIX label`,
    );
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) + frac;
  // Reject silent rollover (Date.UTC normalises out-of-range fields).
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
    check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s
  ) {
    throw new Error(`ttClock: '${iso}' does not exist on the POSIX UTC timeline`);
  }
  return ms;
}

/**
 * Authoritative TT seconds (f64) for a POSIX UTC ISO label (ms-resolution input).
 * tt = (posixMs + (TAI−UTC)·1000 + 32184 − civilJ2000Ms) / 1000 — all civil
 * arithmetic in integer ms; the only f64 rounding is the final /1000.
 */
export function ttFromUtcIso(iso: string): number {
  const posixMs = posixMsFromIso(iso);
  return (posixMs + taiMinusUtcAtPosixMs(posixMs) * 1000 + TAI_MINUS_TT_MS - J2000_CIVIL_POSIX_MS) / 1000;
}

/**
 * Inverse of ttFromUtcIso: POSIX UTC ISO label for a TT instant, ms resolution.
 * Exact interval algorithm: entry k's labels [E_k, E_{k+1}) carry offset o_k and
 * cover TT ms [G_k, H_k) with G_k = E_k + o_k·1000 + C, H_k = E_{k+1} + o_k·1000 + C
 * (last interval open-ended); C = TT−TAI ms − civil J2000 ms. TT ms in
 * [H_k, G_{k+1}) fall inside an INSERTED leap second, which the POSIX timeline
 * cannot label: clamp to the last representable label E_{k+1} − 1
 * (forward(clamp) is the largest labeled value <= tMs) — documented ADR-008.
 */
export function utcIsoFromTt(tt: number): string {
  if (!Number.isFinite(tt)) throw new Error('ttClock: non-finite tt');
  const tMs = Math.round(tt * 1000);
  const C = TAI_MINUS_TT_MS - J2000_CIVIL_POSIX_MS;
  const entries = table.entries;
  let k = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LeapEntry;
    if (tMs < entryEffectiveMs(e) + e.taiMinusUtc * 1000 + C) break;
    k = i;
  }
  if (k === -1) {
    throw new Error('ttClock: TT instant predates leap-table coverage; no POSIX label exists');
  }
  const entry = entries[k] as LeapEntry;
  const g = entryEffectiveMs(entry) + entry.taiMinusUtc * 1000 + C;
  if (k + 1 < entries.length) {
    const nextE = entryEffectiveMs(entries[k + 1] as LeapEntry);
    const h = nextE + entry.taiMinusUtc * 1000 + C;
    const posixMs = tMs >= h ? nextE - 1 : entryEffectiveMs(entry) + (tMs - g); // gap clamp | in-interval
    return new Date(posixMs).toISOString();
  }
  return new Date(entryEffectiveMs(entry) + (tMs - g)).toISOString();
}

/**
 * WALL-CLOCK BRIDGE ONLY. Current TT from Date.now(). Date.now is neither
 * monotonic nor authoritative: NTP steps and manual changes move it. Use it to
 * seed/audit a persisted anchor or to render a civil timestamp — NEVER as the
 * source of simulation time (that is UniverseClock's monotonic anchor).
 */
export function ttNow(): number {
  return ttFromWallMs(Date.now());
}

/** tt seconds for a wall POSIX ms (shared seed path). */
function ttFromWallMs(posixMs: number): number {
  return (posixMs + taiMinusUtcAtPosixMs(posixMs) * 1000 + TAI_MINUS_TT_MS - J2000_CIVIL_POSIX_MS) / 1000;
}

/** f64 spacing (ULP) of a positive normal number, for the report's precision rows. */
export function ulp64(x: number): number {
  if (!(x > 0)) throw new Error('ttClock: ulp64 defined for positive normals only');
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const lo = buf.getUint32(4);
  if (lo === 0xffffffff) {
    // carry: low word overflows into the high word (mantissa rollover)
    buf.setUint32(4, 0);
    buf.setUint32(0, buf.getUint32(0) + 1);
  } else {
    buf.setUint32(4, lo + 1);
  }
  return buf.getFloat64(0) - x;
}

// --- Universe clock (ADR-001 Decision 3 semantics) ---------------------------

/** Persisted clock state — exactly the COORDINATE_SYSTEM.md §4 field set. */
export interface ClockStateV1 {
  readonly schema: 'kwetu.clock/1';
  readonly clockRevision: number;
  readonly worldTimeTtSeconds: number;
  /** POSIX UTC label of the save (wall clock, civil — used only for downtime). */
  readonly savedAtUtc: string;
  readonly leapTableRevision: string;
  readonly timeAdapterRevision: string;
}

export interface ClockDeps {
  /** Monotonic source (default performance.now). The ONLY in-process sim-time source. */
  readonly nowMonoMs?: () => number;
  /** Wall source (default Date.now). Seeds/audits anchors; civil downtime across restarts. */
  readonly nowWallMs?: () => number;
}

export interface ResumeReport {
  /** Civil downtime added to worldTime on resume (seconds, rate 1 — offline coast). */
  readonly downtimeSeconds: number;
  /** True when a negative civil jump was refused (clamped to 0, revision incremented). */
  readonly negativeJumpRefused: boolean;
  /** True when the saved leapTableRevision differs from the loaded table. */
  readonly leapTableMismatch: boolean;
}

const defaultMono = (): number => performance.now();
const defaultWall = (): number => Date.now();

/**
 * The one shared universe clock. Rate is FIXED at 1 (ADR-001 Decision 3: the
 * public clock rate is real time). Warp lives only in isolated WarpClock views.
 */
export class UniverseClock {
  private anchorTt: number;
  private anchorMonoMs: number;
  private readonly deps: { nowMonoMs: () => number; nowWallMs: () => number };
  private revision: number;
  private readonly leapMismatch: boolean;

  private constructor(
    anchorTt: number,
    anchorMonoMs: number,
    deps: { nowMonoMs: () => number; nowWallMs: () => number },
    revision: number,
    leapMismatch = false,
  ) {
    this.anchorTt = anchorTt;
    this.anchorMonoMs = anchorMonoMs;
    this.deps = deps;
    this.revision = revision;
    this.leapMismatch = leapMismatch;
  }

  static start(deps: ClockDeps = {}): UniverseClock {
    const d = { nowMonoMs: deps.nowMonoMs ?? defaultMono, nowWallMs: deps.nowWallMs ?? defaultWall };
    return new UniverseClock(ttFromWallMs(d.nowWallMs()), d.nowMonoMs(), d, 1);
  }

  /** Authoritative shared instant, rate 1, derived from the monotonic anchor only. */
  nowTt(): number {
    return this.ttAtMono(this.deps.nowMonoMs());
  }

  /** Shared instant sampled AT a given monotonic reading (one consistent sample). */
  ttAtMono(monoMs: number): number {
    return this.anchorTt + (monoMs - this.anchorMonoMs) / 1000;
  }

  get clockRevision(): number {
    return this.revision;
  }

  get leapTableMismatch(): boolean {
    return this.leapMismatch;
  }

  /** Wall-clock display label for the current authoritative instant. */
  displayUtcIso(): string {
    return utcIsoFromTt(this.nowTt());
  }

  /**
   * Spawns an ISOLATED warp view (accelerated training universe). It holds its
   * own anchor and rate; the parent anchor is untouched, so shared readings
   * carry ZERO divergence from any warp activity. Serialization is refused:
   * accelerated state can never merge into the shared universe (ADR-001 D3).
   */
  startIsolatedWarp(rate: number): WarpClock {
    if (!(rate > 0)) throw new Error('ttClock: warp rate must be > 0');
    const monoMs = this.deps.nowMonoMs(); // ONE sample: anchor tt and mono stay consistent
    return new WarpClock(this, this.ttAtMono(monoMs), monoMs, this.deps.nowMonoMs, rate);
  }

  serialize(): ClockStateV1 {
    return {
      schema: 'kwetu.clock/1',
      clockRevision: this.revision,
      worldTimeTtSeconds: this.nowTt(),
      savedAtUtc: new Date(this.deps.nowWallMs()).toISOString(),
      leapTableRevision: table.revision,
      timeAdapterRevision: TIME_ADAPTER_REVISION,
    };
  }

  /**
   * Restart: worldTime continues from the persisted value plus civil downtime
   * (offline coast preserves duration). Downtime is computed in INTEGER wall
   * ms (label difference plus the leap-count difference, so an inserted leap
   * second inside the downtime contributes exactly 1 s of real coast), then
   * converted to seconds once — no f64 subtraction of two large tt values.
   * Negative civil jumps are refused (clamped 0) with a new clock revision —
   * a wall correction never moves shared time backwards.
   */
  static resume(state: ClockStateV1, deps: ClockDeps = {}): { clock: UniverseClock; report: ResumeReport } {
    const d = { nowMonoMs: deps.nowMonoMs ?? defaultMono, nowWallMs: deps.nowWallMs ?? defaultWall };
    if (state.schema !== 'kwetu.clock/1') throw new Error(`ttClock: unknown clock state schema '${state.schema}'`);
    if (state.timeAdapterRevision !== TIME_ADAPTER_REVISION) {
      throw new Error(`ttClock: state written by ${state.timeAdapterRevision}, loading ${TIME_ADAPTER_REVISION}`);
    }
    const mismatch = state.leapTableRevision !== table.revision;
    const savedMs = Date.parse(state.savedAtUtc); // our own toISOString output — exact integer ms
    const nowMs = d.nowWallMs();
    let downtimeMs = nowMs - savedMs + (taiMinusUtcAtPosixMs(nowMs) - taiMinusUtcAtPosixMs(savedMs)) * 1000;
    let refused = false;
    if (!(downtimeMs >= 0)) {
      downtimeMs = 0; // refuse negative jumps: civil downtime cannot be negative
      refused = true;
    }
    const applied = downtimeMs / 1000; // exact: integer ms -> seconds at these magnitudes
    const clock = new UniverseClock(
      state.worldTimeTtSeconds + applied,
      d.nowMonoMs(),
      d,
      refused ? state.clockRevision + 1 : state.clockRevision,
      mismatch,
    );
    return {
      clock,
      report: { downtimeSeconds: applied, negativeJumpRefused: refused, leapTableMismatch: mismatch },
    };
  }
}

/**
 * Isolated accelerated clock — never authoritative, never serializable. Its
 * local time runs at `rate` × real time from its anchor; the shared parent is
 * untouched (zero-divergence by construction, measured in the probe suite).
 */
export class WarpClock {
  private readonly parent: UniverseClock;
  private readonly anchorTt: number;
  private readonly anchorMonoMs: number;
  private readonly nowMonoMs: () => number;
  private readonly rate: number;

  constructor(
    parent: UniverseClock,
    anchorTt: number,
    anchorMonoMs: number,
    nowMonoMs: () => number,
    rate: number,
  ) {
    this.parent = parent;
    this.anchorTt = anchorTt;
    this.anchorMonoMs = anchorMonoMs;
    this.nowMonoMs = nowMonoMs;
    this.rate = rate;
  }

  /** Local accelerated training time (TT seconds at `rate`). */
  localTt(): number {
    return this.anchorTt + ((this.nowMonoMs() - this.anchorMonoMs) / 1000) * this.rate;
  }

  /** Shared reading — delegates to the untouched parent. */
  sharedNowTt(): number {
    return this.parent.nowTt();
  }

  /** Wall label of the CURRENT LOCAL time — display only, never persisted. */
  localDisplayUtcIso(): string {
    return utcIsoFromTt(this.localTt());
  }

  serialize(): never {
    throw new Error('ttClock: isolated warp clocks cannot merge state (ADR-001 Decision 3)');
  }
}
