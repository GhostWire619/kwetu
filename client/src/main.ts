/**
 * Kwetu client bootstrap — Phase-1 Part B shell.
 *
 * Boots the ClientApp (client/src/app/clientApp.ts): WebGL2 renderer with
 * logarithmic depth + floating origin, the ephemeris-driven test world, and
 * the flight camera. No UI strings tonight (the EN+sw rule applies to UI
 * strings; the shell renders a full-viewport canvas only) — the one visible
 * text is the renderer-failure diagnostic below, which exists so a broken
 * WebGL2 environment shows a cause instead of a black page with an uncaught
 * exception (review hygiene 2026-09-06). It is tagged for i18n rather than
 * silently hard-coded: no i18n runtime exists in the shell yet.
 */
import { ClientApp } from './app/clientApp';

const canvas = document.getElementById('kwetu-canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('kwetu bootstrap: expected a <canvas id="kwetu-canvas"> element');
}

/**
 * [PLACEHOLDER — i18n] diagnostic failure text, not a UI surface: it joins the
 * EN+sw locale namespace when the shell UI layer lands (docs/swahili-i18n.md);
 * the shell has no i18n runtime tonight, so there is nothing to key it into.
 */
const RENDERER_FAILURE_TEXT = 'Kwetu cannot start: the WebGL2 renderer failed to initialize.';

function showRendererFailure(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const banner = document.createElement('pre');
  banner.setAttribute('role', 'alert');
  banner.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'margin:0;padding:2rem;color:#e8e8e8;background:#000;font:14px/1.5 monospace;' +
    'white-space:pre-wrap;text-align:center;';
  banner.textContent = `${RENDERER_FAILURE_TEXT}\n${reason}`;
  document.body.appendChild(banner);
  // Loud for the test harness too: fly.pw.ts fails the run on any console
  // error, which is the correct outcome for a shell that cannot render.
  console.error('kwetu bootstrap: renderer construction failed', error);
}

function boot(canvas: HTMLCanvasElement): void {
  let app: ClientApp;
  try {
    app = new ClientApp(canvas);
  } catch (error) {
    showRendererFailure(error);
    return;
  }
  app.start();
}

boot(canvas);
