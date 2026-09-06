// S0.3 load-budget probe — meshopt decoder entry (B-LOAD-06, bundled figure).
// three 0.185.1 ships examples/jsm/libs/meshopt_decoder.module.js with the
// WASM payload EMBEDDED in the JS (meshoptimizer's own string encoding, not
// base64) — no separate .wasm file ships in three's path (verified: the only
// .wasm files under examples/jsm/libs are basis/ and draco/). This entry
// measures the decoder as the app bundle carries it (minified); the shipped
// unminified file is measured separately in report.json (staticAssets).
//
// BUNDLER NOTE (measured 2026-09-06): an entry that merely re-exports the
// decoder tree-shakes to ZERO bytes in a vite 8 (rolldown) app build — the
// IIFE result is inferred pure and unused entry exports are dropped. Consuming
// the decoder is required for retention; awaiting `.ready` is the documented
// pre-use pattern (GLTFLoader does the same), so this entry uses it.
// Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

await MeshoptDecoder.ready;

export const decoder = MeshoptDecoder;
