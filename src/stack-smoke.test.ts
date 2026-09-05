import { describe, it, expect } from 'vitest';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import * as astronomy from 'astronomy-engine';

// The other two pinned runtime deps (ARCHITECTURE.md §13): the deterministic
// Rapier compat build must init its embedded WASM inside the node test
// environment (spike S0.1 depends on this), and astronomy-engine must
// resolve its named exports.
describe('rapier 0.20.0 deterministic compat', () => {
  it('initializes WASM and opens a Z-up world', async () => {
    await RAPIER.init();
    // COORDINATE_SYSTEM.md §8: ENU is Z-up, gravity (0, 0, -g).
    const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
    expect(world.gravity.z).toBeCloseTo(-9.81);
    world.free();
  });
});

describe('astronomy-engine 2.1.19', () => {
  it('resolves named exports and computes a body position', () => {
    expect(astronomy.Body.Earth).toBeDefined();
    const time = astronomy.MakeTime(new Date('2026-09-05T00:00:00Z'));
    const vec = astronomy.GeoVector(astronomy.Body.Moon, time, false);
    expect(Number.isFinite(vec.x)).toBe(true);
  });
});
