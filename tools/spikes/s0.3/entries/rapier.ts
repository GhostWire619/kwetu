// S0.3 load-budget probe — Rapier entry.
// The deterministic compat build is the ARCHITECTURE.md §13 pin. The WASM arrives
// base64-inlined in this package's JS (compat build), so the measured JS figure
// already carries the WASM; no separate .wasm asset is emitted by this build.
// Gravity is the canonical ENU Z-up tangent gravity (COORDINATE_SYSTEM.md §8).
// Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import RAPIER from '@dimforge/rapier3d-deterministic-compat';

await RAPIER.init();

export const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
