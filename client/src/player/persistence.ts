/**
 * Kwetu player — saved player state (Phase 3 groundwork).
 *
 * Owns the local persistence contract for the walk avatar: the versioned
 * storage key, the saved-state shape, and the load/save functions over a
 * `StorageLike` backend (constructor-injected in tests, `localStorage` at
 * runtime). The Phase-3 exit criterion "position persists across reload"
 * (ROADMAP.md §Phase 3) is the consumer of this contract.
 *
 * Shape law: the saved shape is a PERSISTENCE contract, deliberately its own
 * compact record — it is NOT `GeodeticCoord` (geodesy.ts owns that survey type
 * and its Law G-3 status). `anchorGeodetic.heightM` is the WGS84 ELLIPSOIDAL
 * height (Laws G-1/G-2), never orthometric. `localOffset` is the avatar's
 * bubble-local ENU offset (f64 canonical, metres) relative to that anchor —
 * exactly what `CharacterController.position` holds while the anchor is the
 * enclosing bubble's anchor.
 *
 * Failure law: corrupt, missing, or wrong-shaped data returns `null` / `false`
 * — this module NEVER throws. Accessing `globalThis.localStorage` itself can
 * throw (privacy modes, sandboxed frames, some embedded contexts) and every
 * backend call is guarded the same way.
 *
 * Open dependency (recorded, not owned here): ADR-002 Decision 6 — the ECEF →
 * geodetic reference implementation is still the validated Bowring placeholder
 * in geodesy.ts and must be replaced by that decision's outcome before any
 * geodetic derivation touches saved player positions (Law G-3). This module
 * stores the caller's anchor as-is and adds no geodesy of its own.
 */

/** The minimal storage backend the module needs (a subset of the DOM `Storage`). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The persisted walk-avatar state, version 1 (the version lives in the KEY;
 * the payload carries no version field — a new shape lands under a new key).
 */
export interface SavedPlayerState {
  /** The bubble anchor the offset is relative to (WGS84 geodetic; height is ellipsoidal). */
  anchorGeodetic: {
    latDeg: number;
    lonDeg: number;
    heightM: number;
  };
  /** Bubble-local ENU offset of the avatar (capsule centre) from the anchor, metres, f64. */
  localOffset: {
    x: number;
    y: number;
    z: number;
  };
  /** When the state was saved, ISO-8601 UTC (caller-supplied; stored verbatim). */
  savedAtUtc: string;
}

/** The versioned storage key (bump the version, never widen this shape in place). */
export const PLAYER_STATE_KEY = 'kwetu.player.v1';

// --- validation -----------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural validation shared by load (after the JSON parse) and save (before
 * the serialise — a state we could never load back is rejected, not stored).
 * Unknown EXTRA fields are tolerated on read (forward-compatible) and dropped.
 */
function isValidSavedPlayerState(state: unknown): state is SavedPlayerState {
  if (!isRecord(state)) return false;
  const anchor = state['anchorGeodetic'];
  const offset = state['localOffset'];
  const savedAtUtc = state['savedAtUtc'];
  if (!isRecord(anchor) || !isRecord(offset)) return false;
  if (!isFiniteNumber(anchor['latDeg']) || !isFiniteNumber(anchor['lonDeg']) || !isFiniteNumber(anchor['heightM'])) return false;
  if (!isFiniteNumber(offset['x']) || !isFiniteNumber(offset['y']) || !isFiniteNumber(offset['z'])) return false;
  if (typeof savedAtUtc !== 'string' || savedAtUtc.length === 0) return false;
  return true;
}

// --- storage resolution -----------------------------------------------------------

/**
 * Resolves the default backend: `globalThis.localStorage`, guarded — the
 * property ACCESS itself can throw in some contexts, and in others (node test
 * env, hardened privacy modes) it is simply absent. Returns null when no
 * usable backend exists; callers then degrade (load → null, save → false).
 */
function defaultStorage(): StorageLike | null {
  try {
    const holder = globalThis as typeof globalThis & { localStorage?: unknown };
    const candidate: unknown = holder.localStorage;
    if (isRecord(candidate)) {
      const like = candidate as Partial<StorageLike>;
      if (typeof like.getItem === 'function' && typeof like.setItem === 'function' && typeof like.removeItem === 'function') {
        // Shape verified at runtime above; the double cast carries that evidence.
        return candidate as unknown as StorageLike;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  return storage !== undefined ? storage : defaultStorage();
}

// --- the API ----------------------------------------------------------------------

/**
 * Loads the saved player state. Returns null when the backend is unavailable,
 * the key is missing, the payload is not JSON, or the payload fails the shape
 * validation — never throws.
 */
export function loadPlayerState(storage?: StorageLike): SavedPlayerState | null {
  const store = resolveStorage(storage);
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PLAYER_STATE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isValidSavedPlayerState(parsed)) return null;
  return {
    anchorGeodetic: { ...parsed.anchorGeodetic },
    localOffset: { ...parsed.localOffset },
    savedAtUtc: parsed.savedAtUtc,
  };
}

/**
 * Saves the player state under the versioned key. Returns true when stored,
 * false when the backend is unavailable, the state fails validation (e.g. a
 * NaN coordinate, which could never be loaded back), or the backend throws
 * (quota exceeded, privacy mode) — never throws.
 */
export function savePlayerState(state: SavedPlayerState, storage?: StorageLike): boolean {
  if (!isValidSavedPlayerState(state)) return false;
  const store = resolveStorage(storage);
  if (store === null) return false;
  try {
    store.setItem(PLAYER_STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Removes the saved player state (e.g. a "reset position" flow). Never throws. */
export function clearPlayerState(storage?: StorageLike): void {
  const store = resolveStorage(storage);
  if (store === null) return;
  try {
    store.removeItem(PLAYER_STATE_KEY);
  } catch {
    // unreachable backend — the goal state (nothing readable) holds either way
  }
}
