// Raw-GL probe behind the [MEASURED 2026-09-06] tag in
// client/src/app/clientApp.ts (depthProbe) and tests/e2e/fly.pw.ts: does
// headless WebGL2 readPixels(DEPTH_COMPONENT, UNSIGNED_INT) from an FBO with
// a DEPTH_COMPONENT24 attachment? Two variants: depth as a RENDERBUFFER vs
// depth as a TEXTURE (three.js DepthTexture path).
//
// Measured verdict (2026-09-06, both variants, both browsers): INVALID_ENUM
// (GL 1280) — which is why the app's depth probe reaches the test through a
// depth-texture -> colour readout pass instead. Committed 2026-09-06 so the
// measurement's provenance is tracked; it previously lived only in gitignored
// build/ diagnostics. Not part of the app or its test suite.
//
// Run: node tools/measure/gl-depth-readback.mjs
import { chromium, firefox } from '@playwright/test';

const experiment = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) return { ok: false, reason: 'no webgl2' };

  const makeColorTex = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  };

  const clearDraw = () => {
    gl.viewport(0, 0, 64, 64);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // trivial geometry not needed: we only need the depth plane values from clear.
  };

  const results = {};

  // Variant A: DEPTH_COMPONENT24 renderbuffer attachment.
  {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, makeColorTex(), 0);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 64, 64);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    clearDraw();
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.getError(); // drain
    const buf = new Uint32Array(1);
    gl.readPixels(32, 32, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, buf);
    const err = gl.getError();
    results.renderbuffer = { status: status === gl.FRAMEBUFFER_COMPLETE ? 'complete' : String(status), err, depth: buf[0] };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Variant B: DEPTH_COMPONENT24 depth TEXTURE attachment (three.js DepthTexture path).
  {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, makeColorTex(), 0);
    const depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 64, 64, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    clearDraw();
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.getError(); // drain
    const buf = new Uint32Array(1);
    gl.readPixels(32, 32, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, buf);
    const err = gl.getError();
    results.depthTexture = { status: status === gl.FRAMEBUFFER_COMPLETE ? 'complete' : String(status), err, depth: buf[0] };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Variant C: like B but read via DEPTH24_STENCIL8-style alternative format? skip.
  return { ok: true, results, renderer: gl.getParameter(gl.RENDERER) };
};

const run = async (label, launch) => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const out = await page.evaluate(experiment);
  console.log(`[${label}]`, JSON.stringify(out, null, 1));
  await browser.close();
};

await run('chromium', () => chromium.launch({ args: ['--use-angle=swiftshader'] }));
await run('firefox', () => firefox.launch({ firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } }));
