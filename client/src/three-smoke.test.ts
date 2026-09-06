import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, WebGLRenderer, REVISION } from 'three';
import type { WebGLRendererParameters } from 'three';

// ARCHITECTURE.md §13 pins three 0.185.1; three ships no .d.ts (verified in
// node_modules at scaffold time), so @types/three@0.185.4 carries the
// declarations and this file is the strict-typecheck verification of the
// core import surface (CLAUDE.md: verify core/addon imports in a strict
// typecheck).
describe('three 0.185.1 under strict typecheck', () => {
  it('constructs a PerspectiveCamera', () => {
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1e10);
    expect(camera.fov).toBe(75);
    expect(camera.far).toBe(1e10);
  });

  it('exposes the WebGLRenderer type surface', () => {
    expect(typeof WebGLRenderer).toBe('function');
    // Constructing a WebGLRenderer needs a real WebGL2 context, which the
    // node test environment cannot provide — the constructor parameters
    // object still exercises the declaration surface, including the
    // logarithmicDepthBuffer flag that is one half of the log-depth AND
    // floating-origin invariant (CLAUDE.md).
    const params: WebGLRendererParameters = {
      logarithmicDepthBuffer: true,
      antialias: false,
    };
    expect(params.logarithmicDepthBuffer).toBe(true);
  });

  it('reports the pinned revision', () => {
    expect(REVISION).toBe('185');
  });
});
