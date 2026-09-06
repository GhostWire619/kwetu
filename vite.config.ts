import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * Region data serving (Phase 2): the gitignored .bake artifacts (terrain
 * GLBs, PMTiles basemaps) are served under /data/region/ with byte-range
 * support — the capability the "streamed over range requests" Phase-2
 * criterion rests on (PMTiles' protocol is range-driven). vite's own static
 * middleware does not serve dot-directories, hence this plugin. Production
 * is Caddy's file_server over the deployed copy of the same artifacts
 * (infra/Caddyfile @immutable already covers *.glb/*.pmtiles).
 */
const REGION_DATA_DIRS = ['.bake/meshes', '.bake/pmtiles'] as const;
const REGION_CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.pmtiles': 'application/octet-stream',
};

const regionDataMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  try {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const name = decodeURIComponent(url.replace(/^\/+/, ''));
    // Filename-only alphabet (no separators, no traversal) — resolved inside
    // the fixed roots, containment-checked again after resolution.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    for (const dir of REGION_DATA_DIRS) {
      const root = path.resolve(process.cwd(), dir);
      const file = path.resolve(root, name);
      if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) continue;
      const size = statSync(file).size;
      const contentType = REGION_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      const base: Record<string, string> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size),
        'Cache-Control': 'no-cache',
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, base);
        res.end();
        return;
      }
      const range = req.headers.range;
      const rangeText = Array.isArray(range) ? range[0] : range;
      const match = rangeText === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(rangeText);
      if (match !== null) {
        const start = Number(match[1]);
        const endRaw = match[2];
        const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
        if (start <= end && start < size) {
          res.writeHead(206, { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(200, base);
      createReadStream(file).pipe(res);
      return;
    }
    next();
  } catch {
    next();
  }
};

function kwetuRegionData(): Plugin {
  return {
    name: 'kwetu-region-data',
    configureServer: (server) => {
      server.middlewares.use('/data/region', regionDataMiddleware);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use('/data/region', regionDataMiddleware);
    },
  };
}

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
  plugins: [kwetuRegionData()],
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
