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

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode === 'surface') {
    try {
      // Keep the large Rapier surface bundle out of the lightweight space
      // diagnostic; it is fetched only when the player selects surface mode.
      const { SurfaceApp } = await import('./play/surfaceApp');
      const surface = await SurfaceApp.create(canvas);
      surface.start();
    } catch (error) {
      showRendererFailure(error);
    }
    return;
  }
  // Phase 2: ?region=<name> streams that region's terrain tile into the
  // shell. The name is restricted to the bake's naming alphabet — it becomes
  // part of a URL path only (the server re-validates its own side).
  const regionParam = new URLSearchParams(window.location.search).get('region');
  let regionManifestUrl: string | undefined;
  if (regionParam !== null) {
    if (/^[a-z0-9][a-z0-9-]*$/.test(regionParam)) {
      regionManifestUrl = `/data/region/${regionParam}.terrain.manifest.json`;
    } else {
      console.warn(`kwetu bootstrap: ignoring malformed ?region value "${regionParam}"`);
    }
  }
  let app: ClientApp;
  try {
    app = new ClientApp(canvas, regionManifestUrl === undefined ? {} : { regionManifestUrl });
  } catch (error) {
    showRendererFailure(error);
    return;
  }
  app.start();
}

void boot(canvas);
