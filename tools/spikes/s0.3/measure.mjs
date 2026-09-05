// S0.3 load-budget probe runner — throwaway Phase-0 spike code (CLAUDE.md
// tools/spikes carve-out; never imported by src/; no package.json scripts).
//
// Usage: node tools/spikes/s0.3/measure.mjs
//
// For each entry in entries/ it runs TWO vite production builds:
//   raw  — minify disabled (structural bundle size)
//   min  — vite production default minifier (vite 8 = oxc) — the shipping figure
// then gzips the concatenated minified JS output with node zlib gzipSync level 9.
// Each entry is built separately (no shared chunks), so figures are independent.
// Writes report.json next to this script.
//
// Rapier note: the deterministic-compat package base64-inlines its WASM into the
// JS, so the JS figures already carry the WASM. The standalone .wasm from the
// installed package is measured separately (raw + gzip9) as the reference figure
// a separate-WASM shipping configuration would transfer.
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entriesDir = path.join(here, 'entries');
const distDir = path.join(here, 'dist');
const repoRoot = path.resolve(here, '..', '..', '..');

const GZIP_LEVEL = 9;
const ENTRIES = ['three', 'rapier', 'astronomy', 'i18next', 'shell'];

// Version probe via the node_modules path — three (among others) does not export
// './package.json', so require('pkg/package.json') throws on it.
const pkgVersion = (name) => JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
const viteVersion = pkgVersion('vite');
const threeVersion = pkgVersion('three');
const rapierVersion = pkgVersion('@dimforge/rapier3d-deterministic-compat');
const astronomyVersion = pkgVersion('astronomy-engine');
const i18nextVersion = pkgVersion('i18next');

// Recursively list files under dir with byte sizes (relative names).
function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, acc);
    else acc.push({ name: path.relative(base, full).replaceAll('\\', '/'), bytes: st.size });
  }
  return acc;
}

async function buildEntry(name, minify) {
  const outDir = path.join(distDir, name, minify ? 'min' : 'raw');
  await build({
    configFile: false, // spike-local build; the root vite.config's spikes-external guard does not apply here
    root: repoRoot,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      minify: minify, // vite 8 default = oxc minifier; 'esbuild' is deprecated and needs esbuild installed separately
      sourcemap: false,
      target: 'es2022',
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: path.join(entriesDir, `${name}.ts`),
        output: {
          entryFileNames: 'entry.js',
          chunkFileNames: 'chunk-[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  });
  return walk(outDir);
}

async function measureEntry(name) {
  const rawFiles = await buildEntry(name, false);
  const minFiles = await buildEntry(name, true);

  const rawTotal = rawFiles.filter((f) => f.name.endsWith('.js')).reduce((s, f) => s + f.bytes, 0);
  const minTotal = minFiles.filter((f) => f.name.endsWith('.js')).reduce((s, f) => s + f.bytes, 0);

  // gzip level 9 over the concatenated minified JS output (single stream, the
  // transfer-shape a CDN-served bundle would compress to).
  const concatenated = Buffer.concat(
    minFiles.filter((f) => f.name.endsWith('.js')).map((f) => readFileSync(path.join(distDir, name, 'min', f.name))),
  );
  const gzipBytes = gzipSync(concatenated, { level: GZIP_LEVEL }).length;

  const nonJs = minFiles.filter((f) => !f.name.endsWith('.js'));

  return {
    entry: name,
    files: { raw: rawFiles.map((f) => `${f.name} ${f.bytes} B`), min: minFiles.map((f) => `${f.name} ${f.bytes} B`) },
    jsTotalBytes: { raw: rawTotal, minified: minTotal, gzip9: gzipBytes },
    units: 'bytes',
    nonJsAssets: nonJs.map((f) => `${f.name} ${f.bytes} B`),
  };
}

function measureStandaloneWasm() {
  // Direct node_modules path: the package exports map only exposes '.', so
  // require.resolve on the dist file throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const wasmPath = path.join(repoRoot, 'node_modules', '@dimforge', 'rapier3d-deterministic-compat', 'dist', 'rapier_wasm3d_bg.wasm');
  const raw = readFileSync(wasmPath);
  return {
    file: path.relative(repoRoot, wasmPath).replaceAll('\\', '/'),
    rawBytes: raw.length,
    gzip9Bytes: gzipSync(raw, { level: GZIP_LEVEL }).length,
    units: 'bytes',
    note:
      'Reference figure only: the pinned deterministic-compat package base64-inlines this WASM into its JS ' +
      '(rapier.mjs), so the built JS already carries it — do not add this row to the JS figure in B-LOAD-09. ' +
      'A separate-WASM shipping configuration would transfer this raw/gzip figure instead.',
  };
}

mkdirSync(distDir, { recursive: true });
const results = [];
for (const name of ENTRIES) results.push(await measureEntry(name));

const byName = Object.fromEntries(results.map((r) => [r.entry, r]));
const depSumMin = ['three', 'rapier', 'astronomy', 'i18next'].reduce((s, n) => s + byName[n].jsTotalBytes.minified, 0);
const depSumGzip = ['three', 'rapier', 'astronomy', 'i18next'].reduce((s, n) => s + byName[n].jsTotalBytes.gzip9, 0);
const wasm = measureStandaloneWasm();

const report = {
  spike: 'S0.3 — initial load budget (per-package bytes)',
  measuredAt: new Date().toISOString(),
  method: {
    builder: `vite ${viteVersion} production build (rolldown bundler — vite 8 default), one entry per build, no shared chunks`,
    raw: 'same build with minify disabled — structural bundle size',
    minified: 'vite production default minifier (vite 8 = oxc; the esbuild minifier path is deprecated in vite 8 and errors without esbuild installed separately)',
    gzip: `node zlib gzipSync level ${GZIP_LEVEL} over the concatenated minified JS output`,
    units: 'bytes',
    realismNote:
      'Imports are kept realistic (the surface the Phase 1 shell will import); no aggressive tree-shaking tricks, no dead-code stripping beyond vite defaults.',
  },
  toolVersions: { node: process.version, vite: viteVersion, three: threeVersion, rapierDeterministicCompat: rapierVersion, astronomyEngine: astronomyVersion, i18next: i18nextVersion },
  entries: byName,
  rapierWasmStandalone: wasm,
  derived: {
    shellOverheadVsDepSum: {
      note: 'DERIVED, not a direct measurement: shell minus the four single-entry minified figures — a crude proxy for app-shell code + locale JSON in this spike entry only, not the real B-LOAD-07 shell.',
      minifiedBytesDelta: byName.shell.jsTotalBytes.minified - depSumMin,
      gzipBytesDelta: byName.shell.jsTotalBytes.gzip9 - depSumGzip,
    },
    shellIfWasmShippedSeparately: {
      note: 'DERIVED estimate, not a build: shell gzip minus the rapier-entry JS gzip (the base64-inlined WASM portion) plus the standalone .wasm gzip — the transfer a separate-WASM shipping configuration would plausibly approach. A bound from base64-vs-raw arithmetic; never cite it as a measurement.',
      gzipBytesEstimate: byName.shell.jsTotalBytes.gzip9 - byName.rapier.jsTotalBytes.gzip9 + wasm.gzip9Bytes,
    },
  },
  scopeNotes: [
    'Rapier WASM is measured separately (rapierWasmStandalone) and is base64-inlined in the compat JS — the rapier entry JS figure already includes it.',
    'B-LOAD-03 (nakama-js), B-LOAD-04 (livekit-client), B-LOAD-05 (KTX2/Basis transcoder), B-LOAD-06 (meshopt decoder) are NOT measured by this probe run — those packages are not installed at scaffold.',
    'B-LOAD-09 (total first visit) and B-LOAD-10 (warm re-visit) are NOT computable from this run — they need the full package set and a Cache-API/IndexedDB probe.',
  ],
};

const outPath = path.join(here, 'report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${path.relative(repoRoot, outPath)}`);
for (const r of results) {
  const b = r.jsTotalBytes;
  console.log(`${r.entry.padEnd(10)} raw ${String(b.raw).padStart(9)}  min ${String(b.minified).padStart(9)}  gzip9 ${String(b.gzip9).padStart(9)}`);
}
const w = report.rapierWasmStandalone;
console.log(`wasm (standalone reference) raw ${w.rawBytes}  gzip9 ${w.gzip9Bytes}`);
