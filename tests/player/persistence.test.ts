/**
 * Saved player state tests (Phase 3 groundwork).
 *
 * Covers the persistence contract with a deterministic in-memory `StorageLike`
 * mock (no real timings): round-trip fidelity under the versioned key
 * 'kwetu.player.v1', and the never-throw degradation law — corrupt JSON,
 * wrong-shaped payloads, missing keys, absent and throwing backends all
 * degrade to null/false.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYER_STATE_KEY,
  clearPlayerState,
  loadPlayerState,
  savePlayerState,
  type SavedPlayerState,
  type StorageLike,
} from '../../client/src/player/persistence';

const GOOD_STATE: SavedPlayerState = {
  anchorGeodetic: { latDeg: -6.7927, lonDeg: 39.208, heightM: 12.5 },
  localOffset: { x: 1.25, y: -2.5, z: 0.9180001 },
  savedAtUtc: '2026-09-06T00:00:00.000Z',
};

/** Deterministic in-memory backend; `map` is the test's raw-value backdoor. */
function makeStorage(): { storage: StorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    },
  };
}

describe('player/persistence — round trip under the versioned key', () => {
  it('saves and loads the exact state, writing only the versioned key', () => {
    const { storage, map } = makeStorage();
    expect(savePlayerState(GOOD_STATE, storage)).toBe(true);
    expect(map.size).toBe(1);
    expect(map.has(PLAYER_STATE_KEY)).toBe(true);
    expect(loadPlayerState(storage)).toEqual(GOOD_STATE);
  });

  it('clearPlayerState removes the key', () => {
    const { storage, map } = makeStorage();
    savePlayerState(GOOD_STATE, storage);
    clearPlayerState(storage);
    expect(map.has(PLAYER_STATE_KEY)).toBe(false);
    expect(loadPlayerState(storage)).toBeNull();
  });

  it('tolerates unknown extra fields on read (forward compatibility)', () => {
    const { storage, map } = makeStorage();
    map.set(
      PLAYER_STATE_KEY,
      JSON.stringify({ ...GOOD_STATE, futureField: { nested: true } }),
    );
    expect(loadPlayerState(storage)).toEqual(GOOD_STATE);
  });
});

describe('player/persistence — corrupt, missing and wrong-shaped data returns null, never throws', () => {
  it('missing key → null', () => {
    const { storage } = makeStorage();
    expect(loadPlayerState(storage)).toBeNull();
  });

  it('corrupt JSON → null', () => {
    const { storage, map } = makeStorage();
    map.set(PLAYER_STATE_KEY, '{"anchorGeodetic":');
    expect(loadPlayerState(storage)).toBeNull();
    map.set(PLAYER_STATE_KEY, 'not json at all');
    expect(loadPlayerState(storage)).toBeNull();
  });

  it('valid JSON of the wrong shape → null', () => {
    const { storage, map } = makeStorage();
    for (const raw of ['null', '123', '"a string"', '[]', '{}', '{"anchorGeodetic":{}}']) {
      map.set(PLAYER_STATE_KEY, raw);
      expect(loadPlayerState(storage)).toBeNull();
    }
  });

  it('non-finite coordinates (JSON has no NaN — it serialises to null) → null', () => {
    const { storage, map } = makeStorage();
    // JSON.stringify({x: NaN}) === '{"x":null}' — the exact round-trip leak.
    map.set(
      PLAYER_STATE_KEY,
      JSON.stringify({ ...GOOD_STATE, localOffset: { x: Number.NaN, y: 0, z: 0 } }),
    );
    expect(map.get(PLAYER_STATE_KEY)).toContain('null');
    expect(loadPlayerState(storage)).toBeNull();
  });

  it('empty savedAtUtc or missing field → null', () => {
    const { storage, map } = makeStorage();
    map.set(PLAYER_STATE_KEY, JSON.stringify({ ...GOOD_STATE, savedAtUtc: '' }));
    expect(loadPlayerState(storage)).toBeNull();
    map.set(PLAYER_STATE_KEY, JSON.stringify({ anchorGeodetic: GOOD_STATE.anchorGeodetic, localOffset: GOOD_STATE.localOffset }));
    expect(loadPlayerState(storage)).toBeNull();
  });

  it('a backend whose getItem throws → null (never throws)', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(loadPlayerState(throwing)).toBeNull();
  });
});

describe('player/persistence — save degrades to false, never throws', () => {
  it('a backend whose setItem throws → false', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };
    expect(savePlayerState(GOOD_STATE, throwing)).toBe(false);
  });

  it('an invalid state (NaN coordinate, wrong shape) → false and nothing stored', () => {
    const { storage, map } = makeStorage();
    const bad = { ...GOOD_STATE, localOffset: { x: Number.NaN, y: 0, z: 0 } };
    expect(savePlayerState(bad, storage)).toBe(false);
    expect(map.size).toBe(0);
    expect(savePlayerState('nope' as unknown as SavedPlayerState, storage)).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe('player/persistence — the default backend (globalThis.localStorage)', () => {
  // Cast through unknown: the DOM lib types globalThis.localStorage as the full
  // `Storage` interface, while the module under test deliberately needs only its
  // StorageLike subset — and these tests delete/redefine the property freely.
  type StorageHost = { localStorage?: unknown };
  const g = globalThis as unknown as StorageHost;
  let saved: unknown;

  it('absent localStorage (this node test env) → load null / save false, no throw', () => {
    expect('localStorage' in g ? g.localStorage : undefined).toBeUndefined();
    expect(loadPlayerState()).toBeNull();
    expect(savePlayerState(GOOD_STATE)).toBe(false);
  });

  it('a localStorage whose property ACCESS throws → load null / save false, no throw', () => {
    saved = 'localStorage' in g ? g.localStorage : undefined;
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked by privacy mode');
      },
    });
    try {
      expect(loadPlayerState()).toBeNull();
      expect(savePlayerState(GOOD_STATE)).toBe(false);
    } finally {
      // Restore the original state (absent in the node env).
      delete g.localStorage;
      if (saved !== undefined) {
        Object.defineProperty(g, 'localStorage', { configurable: true, value: saved });
      }
    }
  });

  it('a working globalThis.localStorage is used by the parameterless forms', () => {
    const { map } = makeStorage();
    saved = 'localStorage' in g ? g.localStorage : undefined;
    const working: StorageLike = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    };
    g.localStorage = working;
    try {
      expect(savePlayerState(GOOD_STATE)).toBe(true);
      expect(loadPlayerState()).toEqual(GOOD_STATE);
      clearPlayerState();
      expect(map.size).toBe(0);
    } finally {
      delete g.localStorage;
      if (saved !== undefined) {
        g.localStorage = saved;
      }
    }
  });
});
