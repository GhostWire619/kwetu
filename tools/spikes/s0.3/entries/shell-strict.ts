// S0.3 load-budget probe — strict shell entry (B-LOAD-07 measured cross-check).
// The 2026-09-05 shell entry (shell.ts) with astronomy-engine and i18next
// removed: three + Rapier + the locale fixture remain, so a direct build of
// this entry is the MEASURED cross-check for the DERIVED strict-shell figure
// (shell gzip − astronomy gzip − i18next gzip). Keep it byte-shaped like
// shell.ts (same renderer flags, same gravity, same locale fixture) so the
// cross-check isolates exactly the two removed packages.
// Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import sw from './locale.sw.json';

await RAPIER.init();
export const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });

export const scene = new Scene();
export const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1e12);
export const renderer = new WebGLRenderer({ logarithmicDepthBuffer: true });

// Locale bytes ride along exactly as in shell.ts (8-key fixture); the real
// B-LOAD-08 locale bundle is measured separately as a lazily-fetched asset.
export const strings = sw;
