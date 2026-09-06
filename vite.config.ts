import { defineConfig } from 'vite';

/**
 * Kwetu root vite config (Phase-1 Part B wiring, 2026-09-06).
 *
 * `root` is deliberately NOT set here: the Playwright webServer
 * (playwright.config.ts) runs vite with NO positional root so the dev server
 * serves the REPO ROOT — both the S0.11 fixture (tests/e2e/fixtures/three-
 * render.html) and the shell page (/client/index.html) must stay reachable.
 * The npm `dev`/`build` scripts pass the client root per invocation
 * (`vite client`), and they must ALSO pass `--config vite.config.ts`
 * explicitly: vite 8.2.2 resolves config-file DISCOVERY against the CLI root
 * (client/) and an explicit --config against the process CWD [verified
 * 2026-09-06, loadConfigFromFile in vite/dist/node] — without the flag this
 * file would silently not load.
 *
 * tools/spikes/** holds throwaway probe code (CLAUDE.md carve-out); nothing
 * in src/ or client/ may import it, and the external guard below turns any
 * accidental import into a loud build failure instead of a silent bundle
 * inclusion.
 */
export default defineConfig({
  build: {
    // Resolved against the build root (`client`) → <repo>/build/shell
    // (gitignored; reproducible via `npm run build`). An outDir outside the
    // root needs emptyOutDir stated explicitly or vite refuses to empty it.
    outDir: '../build/shell',
    emptyOutDir: true,
    // The B-LOAD-09 shell measurement reads the emitted .js.map for the
    // module list and the Rapier-absence check (tools/measure/shell-load.mjs;
    // ADR-004 "Addendum — Phase-1 built-shell measurement"). Whether a
    // production deploy SHIPS the maps is a hosting decision (ADR-013), not
    // this file's.
    sourcemap: true,
    rollupOptions: {
      external: [/tools[\\/]spikes[\\/]/],
    },
  },
});
