// S0.3 load-budget probe — three.js entry.
// The core path the Phase 1 shell actually imports: WebGLRenderer + PerspectiveCamera + Scene.
// Log depth is ON — hard invariant (log depth AND floating origin, always both).
// Throwaway probe code (CLAUDE.md tools/spikes carve-out) — never imported by src/.
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

export const scene = new Scene();

// Real-scale far plane; floating origin is a frame-math concern, not a constructor
// argument — the byte-relevant surface here is the core import path + renderer flags.
export const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1e12);

export const renderer = new WebGLRenderer({ logarithmicDepthBuffer: true });
