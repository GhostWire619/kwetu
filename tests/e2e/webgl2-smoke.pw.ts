/**
 * S0.11 — headless WebGL2 smoke (self-contained; no server dependency).
 *
 * Answers the S0.11 question "can CI see the game at all" for the raw
 * graphics layer: does a plain, unprivileged page get a working WebGL2
 * context in HEADLESS Chromium AND headless Firefox, with a big enough
 * max-texture size to stream planet tiles, and can it actually rasterize
 * and read pixels back (not just claim a context)?
 *
 * The page is built with page.evaluate on about:blank — no fixture file, no
 * network, no three.js. Raw WebGL2 on purpose: if this fails while the
 * three.js render smoke passes, the regression is in three.js's renderer
 * path; if this passes and three fails, same diagnosis the other way.
 *
 * Parameters are asserted at generous floors (2048 px texture) — the
 * measured values per browser are logged for tools/spikes/s0.11/report.json.
 */
import { expect, test } from '@playwright/test';

interface GlInfo {
  ok: boolean;
  reason?: string;
  version?: string;
  glslVersion?: string;
  vendor?: string;
  renderer?: string;
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  maxViewportDims?: number[];
  maxVertexAttribs?: number;
  nonBlackPixels?: number;
  readbackRgba?: number[];
}

test('headless WebGL2: context, sane limits, rasterized triangle with non-black readback', async ({
  page,
  browserName,
}) => {
  await page.goto('about:blank');
  const info = await page.evaluate((): GlInfo => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) return { ok: false, reason: 'webgl2 context is null' };

    const vsSource = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
    const fsSource = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0, 0.5, 0.25, 1.0); }`;

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type) as WebGLShader;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`shader compile failed: ${String(gl.getShaderInfoLog(sh))}`);
      }
      return sh;
    };

    const prog = gl.createProgram() as WebGLProgram;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { ok: false, reason: `link failed: ${String(gl.getProgramInfoLog(prog))}` };
    }
    gl.useProgram(prog);

    // One full-canvas triangle in clip space.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Read back a 4x4 patch at the canvas centre.
    const px = new Uint8Array(4 * 4 * 4);
    gl.readPixels(62, 62, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (i: number): number => px[i] ?? 0; // noUncheckedIndexedAccess
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (at(i) > 0 || at(i + 1) > 0 || at(i + 2) > 0) nonBlack++;
    }

    return {
      ok: nonBlack > 0,
      version: gl.getParameter(gl.VERSION) as string,
      glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION) as string,
      vendor: gl.getParameter(gl.VENDOR) as string,
      renderer: gl.getParameter(gl.RENDERER) as string,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Float32Array),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
      nonBlackPixels: nonBlack,
      readbackRgba: [at(0), at(1), at(2), at(3)],
    };
  });

  // Diagnostics land in the test log either way.
  console.log(`[webgl2-smoke ${browserName}]`, JSON.stringify(info));

  expect(info.ok, info.reason ?? 'webgl2 available and rasterized').toBe(true);
  expect(info.nonBlackPixels).toBe(16); // the whole 4x4 patch is the triangle colour
  expect(info.version).toMatch(/^WebGL 2(\.0)?/);
  expect(info.maxTextureSize as number).toBeGreaterThanOrEqual(2048);
  expect(info.maxRenderbufferSize as number).toBeGreaterThanOrEqual(2048);
  expect(info.maxViewportDims?.[0] ?? 0).toBeGreaterThanOrEqual(2048);
  expect(info.maxVertexAttribs as number).toBeGreaterThanOrEqual(16);
  // The shader's exact output colour: (255, 128, 64) — proves the readback.
  expect(info.readbackRgba?.[0] ?? 0).toBeGreaterThanOrEqual(250);
  expect(info.readbackRgba?.[1] ?? 0).toBeCloseTo(128, -1);
  expect(info.readbackRgba?.[2] ?? 0).toBeCloseTo(64, -1);
});
