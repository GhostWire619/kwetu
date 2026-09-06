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
// Baseline entries (2026-09-05 wave) are listed FIRST with their build config
// untouched, so their figures must reproduce byte-identically on every run —
// report.test.mjs asserts exactly that against the committed 2026-09-05 values.
//
// Rapier note: the deterministic-compat package base64-inlines its WASM into the
// JS, so the JS figures already carry the WASM. The standalone .wasm from the
// installed package is measured separately (raw + gzip9) as the reference figure
// a separate-WASM shipping configuration would transfer, and the compat build's
// JS glue (the minified bundle with the base64 blob deleted) is derived from the
// built artifact — together they bound the separate-WASM shipping option.
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
// Baseline wave (2026-09-05) — order and config unchanged, figures must reproduce.
const BASELINE_ENTRIES = ['three', 'rapier', 'astronomy', 'i18next', 'shell'];
// Second wave (2026-09-06): nakama-js + livekit-client (installed since), the
// meshopt bundled figure, the strict-shell cross-check and the full first-visit
// bundle cross-check.
const NEW_ENTRIES = ['nakama', 'livekit', 'meshopt', 'shell-strict', 'fullshell'];
const ENTRIES = [...BASELINE_ENTRIES, ...NEW_ENTRIES];

// Version probe via the node_modules path — three (among others) does not export
// './package.json', so require('pkg/package.json') throws on it.
const pkgVersion = (name) => JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
const viteVersion = pkgVersion('vite');
const threeVersion = pkgVersion('three');
const rapierVersion = pkgVersion('@dimforge/rapier3d-deterministic-compat');
const astronomyVersion = pkgVersion('astronomy-engine');
const i18nextVersion = pkgVersion('i18next');
const nakamaJsVersion = pkgVersion('@heroiclabs/nakama-js');
const livekitClientVersion = pkgVersion('livekit-client');

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

// DERIVED, not a build: take the built+minified Rapier compat bundle, delete the
// single base64 WASM literal, and gzip what remains — the size of the JS glue a
// separate-WASM configuration would still have to ship. Refuses to run if the
// base64 marker is not found exactly once, so it can never silently mis-derive.
function deriveRapierGlue() {
  const minEntryPath = path.join(distDir, 'rapier', 'min', 'entry.js');
  const src = readFileSync(minEntryPath, 'utf8');
  const marker = 'AGFzbQ'; // base64 of the WASM magic "\0asm"
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('rapier glue derivation: base64 WASM marker not found in built entry');
  if (src.indexOf(marker, start + 1) !== -1) throw new Error('rapier glue derivation: base64 WASM marker not unique — refusing to derive');
  // The oxc minifier emits long string literals as double-quoted, single-quoted
  // or template literals — accept any of the three quote characters.
  const quote = src[start - 1];
  if (quote !== '"' && quote !== "'" && quote !== '`') throw new Error(`rapier glue derivation: unexpected literal opening before marker: ${JSON.stringify(quote)}`);
  const end = src.indexOf(quote, start);
  if (end === -1) throw new Error('rapier glue derivation: base64 literal not terminated');
  const blobChars = end - start;
  const glue = src.slice(0, start) + src.slice(end);
  return {
    source: 'dist/rapier/min/entry.js with the single base64 WASM literal deleted',
    blobChars,
    glueMinifiedBytes: Buffer.byteLength(glue),
    glueGzip9Bytes: gzipSync(Buffer.from(glue, 'utf8'), { level: GZIP_LEVEL }).length,
    note:
      'DERIVED from the built compat artifact, not a build of the real separate-WASM package ' +
      '(@dimforge/rapier3d-deterministic 0.20.0 exists on the registry but is not installed here). ' +
      'A real swap would also change the init() call shape slightly; treat this as an estimate with a stated method.',
  };
}

// Static assets measured as three ships them (no build) — these are
// runtime-fetched files, never bundled into app JS.
function measureStatic(relParts, note) {
  const full = path.join(repoRoot, ...relParts);
  const raw = readFileSync(full);
  return {
    file: relParts.join('/'),
    rawBytes: raw.length,
    gzip9Bytes: gzipSync(raw, { level: GZIP_LEVEL }).length,
    units: 'bytes',
    note,
  };
}

// Locale bundles: authored JSON served as a lazy asset (docs/swahili-i18n.md) —
// measured as-authored (primary) and as compact re-serialized JSON (variant).
function measureLocale(fileName, expectedKeys) {
  const full = path.join(entriesDir, fileName);
  const raw = readFileSync(full);
  const text = raw.toString('utf8');
  const obj = JSON.parse(text);
  const keys = Object.keys(obj);
  if (expectedKeys && keys.join(' ') !== expectedKeys.join(' ')) {
    throw new Error(`locale key parity violated for ${fileName}: EN and sw namespaces must carry identical key sets (CLAUDE.md localization invariant)`);
  }
  const compact = Buffer.from(JSON.stringify(obj), 'utf8');
  return {
    file: `entries/${fileName}`,
    keyCount: keys.length,
    rawBytes: raw.length,
    gzip9Bytes: gzipSync(raw, { level: GZIP_LEVEL }).length,
    compactGzip9Bytes: gzipSync(compact, { level: GZIP_LEVEL }).length,
    units: 'bytes',
    note:
      'Authored JSON as served (primary figure) plus a compact-JSON re-serialization variant. Locales load ' +
      'lazily per docs/swahili-i18n.md, so this is an asset fetch, not bundle bytes. Representative app ' +
      'namespace fixture — the real key namespace is owned by docs/swahili-i18n.md (S0.10).',
  };
}

mkdirSync(distDir, { recursive: true });
const results = [];
for (const name of ENTRIES) results.push(await measureEntry(name));

const byName = Object.fromEntries(results.map((r) => [r.entry, r]));
const depSumMin = ['three', 'rapier', 'astronomy', 'i18next'].reduce((s, n) => s + byName[n].jsTotalBytes.minified, 0);
const depSumGzip = ['three', 'rapier', 'astronomy', 'i18next'].reduce((s, n) => s + byName[n].jsTotalBytes.gzip9, 0);
const wasm = measureStandaloneWasm();
const rapierGlue = deriveRapierGlue();

// Locale key parity is enforced before either locale is reported.
const enJson = JSON.parse(readFileSync(path.join(entriesDir, 'locale-full.en.json'), 'utf8'));
const localeKeys = Object.keys(enJson);
const localeFullEn = measureLocale('locale-full.en.json');
const localeFullSw = measureLocale('locale-full.sw.json', localeKeys);

// Shipped static assets (as three ships them — unminified, runtime-fetched).
const basisTranscoderJs = measureStatic(
  ['node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', 'basis_transcoder.js'],
  'The Basis/KTX2 transcoder JS exactly as three 0.185.1 ships it. KTX2Loader fetches this file and the .wasm from a transcoder path at runtime — they are static assets, never bundled into app JS.',
);
const basisTranscoderWasm = measureStatic(
  ['node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', 'basis_transcoder.wasm'],
  'The Basis/KTX2 transcoder WASM exactly as three 0.185.1 ships it. Fetched at runtime alongside basis_transcoder.js by KTX2Loader.setTranscoderPath().',
);
const meshoptDecoderShipped = measureStatic(
  ['node_modules', 'three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js'],
  'Unminified module as shipped. The WASM payload is EMBEDDED inside this JS (meshoptimizer\'s own string encoding, not base64) — NO separate .wasm file ships in three\'s path (verified: the only .wasm files under examples/jsm/libs are basis/ and draco/). The bundled+minified figure is entries.meshopt.',
);
const ktx2LoaderShipped = measureStatic(
  ['node_modules', 'three', 'examples', 'jsm', 'loaders', 'KTX2Loader.js'],
  'REFERENCE ONLY, not a budget row: unminified loader source as shipped. When the app imports it, this code rides in the app bundle MINIFIED (B-LOAD-07 territory), so this raw-file figure overstates the bundled cost.',
);
const livekitE2eeWorker = measureStatic(
  ['node_modules', 'livekit-client', 'dist', 'livekit-client.e2ee.worker.mjs'],
  'REFERENCE ONLY, not in B-LOAD-04: the optional E2EE worker the app would import via the livekit-client/e2ee-worker subpath and hand to the Room as a consumer-provided Worker. Kwetu does not plan E2EE, so it is excluded from the first-visit figure.',
);

// ---- Derivations -----------------------------------------------------------

const shellStrictDerived = {
  note:
    'DERIVED per the S0.3 task, not independently re-measured by this arithmetic: previous shell entry gzip ' +
    'MINUS astronomy-engine gzip MINUS i18next gzip. The direct shell-strict entry build is the measured ' +
    'cross-check (entries[shell-strict]). HONEST COMPOSITION: this figure still CONTAINS three + Rapier compat ' +
    '(they are bundled inside the shell entry) plus the ~1.6 KB app-glue/locale residue — it is the ' +
    'first-visit bundle minus the two removed libraries, NOT an app-code-only shell.',
  gzipBytes: byName.shell.jsTotalBytes.gzip9 - byName.astronomy.jsTotalBytes.gzip9 - byName.i18next.jsTotalBytes.gzip9,
  crossCheck: {
    shellStrictEntryGzip9: byName['shell-strict'].jsTotalBytes.gzip9,
    directVsDerivedDelta: byName['shell-strict'].jsTotalBytes.gzip9 - (byName.shell.jsTotalBytes.gzip9 - byName.astronomy.jsTotalBytes.gzip9 - byName.i18next.jsTotalBytes.gzip9),
    note: 'Single-stream gzip is not strictly additive across deletions (dictionary/alignment effects), so the direct build and the subtraction differ slightly; the direct build is the better figure and both are recorded.',
  },
};

const rapierWasmShipping = {
  question: 'B-LOAD-02 shipping config: compat base64-inlined vs separate .wasm fetch (ADR-004 decides; the Phase-1 build confirms)',
  compatAsShipsGzip9: byName.rapier.jsTotalBytes.gzip9,
  standaloneWasmGzip9: wasm.gzip9Bytes,
  grossInliningCostGzip9: byName.rapier.jsTotalBytes.gzip9 - wasm.gzip9Bytes,
  separateWasmEstimate: {
    glueGzip9: rapierGlue.glueGzip9Bytes,
    wasmGzip9: wasm.gzip9Bytes,
    estimatedTotalGzip9: rapierGlue.glueGzip9Bytes + wasm.gzip9Bytes,
    netSavingVsCompatGzip9: byName.rapier.jsTotalBytes.gzip9 - (rapierGlue.glueGzip9Bytes + wasm.gzip9Bytes),
    method: rapierGlue.note,
    extraCostsNotInFigure: 'a second HTTP request + cache entry, correct application/wasm MIME + CORS, and a fetch/instantiate path replacing the inlined init()',
  },
  nonCompatPackage: {
    name: '@dimforge/rapier3d-deterministic',
    version: '0.20.0',
    note: 'Registry-verified 2026-09-06 (npm view): latest = 0.20.0, same version as the pinned compat build — a same-pin swap is possible. NOT installed in this spike; its glue is estimated from the compat artifact above.',
  },
};

// Provisional first-visit total: DERIVED SUM over an explicit inclusion list,
// with the single-stream fullshell build as its primary measured component.
const fullshellGzip = byName.fullshell.jsTotalBytes.gzip9;
const firstVisitProvisional = {
  note:
    'DERIVED SUM over the inclusion list — not a single end-to-end transfer measurement. The fullshell entry ' +
    'is one measured gzip stream (no double counting inside it); the remaining components are runtime-fetched ' +
    'static files added on top. Known small over-count: fullshell still carries the 8-key locale fixture ' +
    'inline (the real app loads locales lazily), worth roughly 0.1 KB gzip.',
  inclusionList: [
    'fullshell entry (single measured gzip stream): three + Rapier compat (base64-inlined WASM) + nakama-js + livekit-client + astronomy-engine + i18next + meshopt decoder + app glue + 8-key locale fixture',
    'basis_transcoder.js (runtime-fetched static, gzip9 as shipped)',
    'basis_transcoder.wasm (runtime-fetched static, gzip9 as shipped)',
    'locale-full EN (default lazy locale bundle, gzip9 as authored — replaces the fixture)',
  ],
  components: {
    fullshellGzip9: fullshellGzip,
    basisTranscoderJsGzip9: basisTranscoderJs.gzip9Bytes,
    basisTranscoderWasmGzip9: basisTranscoderWasm.gzip9Bytes,
    localeEnGzip9: localeFullEn.gzip9Bytes,
  },
  totalGzip9: fullshellGzip + basisTranscoderJs.gzip9Bytes + basisTranscoderWasm.gzip9Bytes + localeFullEn.gzip9Bytes,
  excluded: [
    'livekit-client e2ee worker (optional consumer-provided asset, E2EE not planned)',
    'KTX2Loader.js / MeshoptDecoder loader-side JS beyond what fullshell already carries (meshopt decoder module IS in fullshell; KTX2Loader is not — open item)',
    'warm-revisit transfer (B-LOAD-10) — needs a real CDN + service-worker/Cache-API probe',
  ],
};

// Row-ready summary: every B-LOAD figure this probe backs, with its method, so
// the ADR's numbers are regenerable from this file alone.
const budgetFigureSummary = {
  'B-LOAD-01': { value: byName.three.jsTotalBytes.gzip9, method: 'baseline wave 2026-09-05, reproduced 2026-09-06' },
  'B-LOAD-02': { value: byName.rapier.jsTotalBytes.gzip9, method: 'baseline wave 2026-09-05, reproduced 2026-09-06; standalone .wasm reference + separate-WASM estimate in rapierWasmShipping' },
  'B-LOAD-03': { value: byName.nakama.jsTotalBytes.gzip9, method: 'entries.nakama — Client + createSocket, ESM dist (whatwg-fetch carried inline)' },
  'B-LOAD-04': { value: byName.livekit.jsTotalBytes.gzip9, method: 'entries.livekit — Room + track imports (RemoteAudioTrack as value); E2EE worker excluded' },
  'B-LOAD-05': { value: basisTranscoderJs.gzip9Bytes + basisTranscoderWasm.gzip9Bytes, method: 'basis_transcoder.js + basis_transcoder.wasm as shipped in three 0.185.1, gzip9 each, summed' },
  'B-LOAD-06': { value: meshoptDecoderShipped.gzip9Bytes, method: 'shipped meshopt_decoder.module.js (WASM embedded in the JS — no separate .wasm ships); bundled figure entries.meshopt' },
  'B-LOAD-07': { value: shellStrictDerived.gzipBytes, method: 'DERIVED subtraction per task; direct shell-strict build cross-check recorded' },
  'B-LOAD-08': { value: `sw ${localeFullSw.gzip9Bytes} / EN ${localeFullEn.gzip9Bytes}`, method: '112-key namespace JSON as served, gzip9; locales load lazily' },
  'B-LOAD-09': { value: firstVisitProvisional.totalGzip9, method: 'DERIVED SUM, inclusion list in firstVisitProvisional; fullshell single-stream build is the primary component' },
  'B-LOAD-10': { value: null, method: 'NOT measurable by this probe — needs a real CDN + service-worker/Cache-API warm measurement' },
};

const report = {
  spike: 'S0.3 — initial load budget (per-package bytes)',
  measuredAt: new Date().toISOString(),
  measuredAtLocal: `${new Date().toLocaleString('sv-SE', { timeZoneName: 'short' })} (host local time — date-stamp tags use the local date)`,
  method: {
    builder: `vite ${viteVersion} production build (rolldown bundler — vite 8 default), one entry per build, no shared chunks`,
    raw: 'same build with minify disabled — structural bundle size',
    minified: 'vite production default minifier (vite 8 = oxc; the esbuild minifier path is deprecated in vite 8 and errors without esbuild installed separately)',
    gzip: `node zlib gzipSync level ${GZIP_LEVEL} over the concatenated minified JS output`,
    staticAssets: 'files read directly from node_modules as shipped (no build) and gzipSync level 9 — used for the Basis transcoder pair, the meshopt decoder module, KTX2Loader (reference) and the locale bundles',
    units: 'bytes',
    realismNote:
      'Imports are kept realistic (the surface the Phase 1 shell will import); no aggressive tree-shaking tricks, no dead-code stripping beyond vite defaults.',
    reproducibility:
      'Baseline entries (three, rapier, astronomy, i18next, shell) keep their 2026-09-05 build config untouched and must reproduce byte-identically — report.test.mjs asserts the committed 2026-09-05 values.',
  },
  toolVersions: { node: process.version, vite: viteVersion, three: threeVersion, rapierDeterministicCompat: rapierVersion, astronomyEngine: astronomyVersion, i18next: i18nextVersion, nakamaJs: nakamaJsVersion, livekitClient: livekitClientVersion },
  entries: byName,
  rapierWasmStandalone: wasm,
  rapierGlueDerived: rapierGlue,
  staticAssets: {
    basisTranscoderJs,
    basisTranscoderWasm,
    basisTranscoderPairGzip9: basisTranscoderJs.gzip9Bytes + basisTranscoderWasm.gzip9Bytes,
    meshoptDecoderShipped,
    ktx2LoaderReference: ktx2LoaderShipped,
    livekitE2eeWorkerReference: livekitE2eeWorker,
  },
  locales: {
    keyParityChecked: true,
    keyCount: localeKeys.length,
    en: localeFullEn,
    sw: localeFullSw,
    note: 'The 8-key entries/locale.sw.json fixture is UNCHANGED from 2026-09-05 so shell.ts keeps reproducing; the representative ~100-string namespace lives in locale-full.{en,sw}.json.',
  },
  derived: {
    shellOverheadVsDepSum: {
      note: 'DERIVED, not a direct measurement: shell minus the four single-entry minified figures — a crude proxy for app-shell code + locale JSON in this spike entry only, not the real B-LOAD-07 shell.',
      minifiedBytesDelta: byName.shell.jsTotalBytes.minified - depSumMin,
      gzipBytesDelta: byName.shell.jsTotalBytes.gzip9 - depSumGzip,
    },
    shellIfWasmShippedSeparately: {
      note: 'DERIVED estimate, not a build: shell gzip minus the rapier-entry JS gzip (the base64-inlined WASM portion) plus the standalone .wasm gzip — the transfer a separate-WASM shipping configuration would plausibly approach. A bound from base64-vs-raw arithmetic; never cite it as a measurement. Superseded for decisions by rapierWasmShipping, which accounts for the JS glue separately.',
      gzipBytesEstimate: byName.shell.jsTotalBytes.gzip9 - byName.rapier.jsTotalBytes.gzip9 + wasm.gzip9Bytes,
    },
    shellStrict: shellStrictDerived,
    rapierWasmShipping,
    firstVisitProvisional,
  },
  budgetFigureSummary,
  scopeNotes: [
    'Rapier WASM is measured separately (rapierWasmStandalone) and is base64-inlined in the compat JS — the rapier entry JS figure already includes it.',
    'B-LOAD-03 (nakama-js) and B-LOAD-04 (livekit-client) are measured as byte probes: no server is contacted, no connection is made. The figures are transfer-size estimates for the shipping bundles, not protocol benchmarks.',
    'livekit-client: the optional E2EE worker (livekit-client/e2ee-worker subpath, a consumer-provided Worker) is NOT in the B-LOAD-04 figure; its shipped-file size is recorded in staticAssets.livekitE2eeWorkerReference. Kwetu does not plan E2EE.',
    'B-LOAD-05 figures are the two Basis transcoder files AS SHIPPED (unminified vendor files, runtime-fetched); the KTX2Loader.js reference in staticAssets is unminified loader source and overstates its bundled cost.',
    'B-LOAD-06: three ships NO separate meshopt .wasm — the payload is embedded in meshopt_decoder.module.js (meshoptimizer string encoding). entries.meshopt gives the bundled+minified figure; staticAssets.meshoptDecoderShipped gives the shipped-file figure.',
    'Bundler observation (measured 2026-09-06): an entry that merely RE-EXPORTS the meshopt decoder tree-shakes to 0 bytes in a vite 8 (rolldown) app build — the decoder must be consumed (await MeshoptDecoder.ready, the GLTFLoader pattern) to be retained. Same discipline applies to any pure-export addon in the Phase 1 shell.',
    'B-LOAD-07: the shell entry is a combined bundle — its strict figure (derived) still carries three + Rapier; the app-code-only residue is derived.shellOverheadVsDepSum (~1.6 KB gzip) and the REAL app shell (TS + CSS) is measured at Phase 1, whose exit criterion records shell transfer.',
    'B-LOAD-09 is a DERIVED SUM over the stated inclusion list, anchored on the measured single-stream fullshell build; it is not an end-to-end transfer measurement.',
    'B-LOAD-10 (warm revisit) is NOT measured — a static gzip probe cannot measure Cache-API/IndexedDB warm behaviour; it needs a real CDN + service-worker probe.',
  ],
};

const outPath = path.join(here, 'report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${path.relative(repoRoot, outPath)}`);
for (const r of results) {
  const b = r.jsTotalBytes;
  console.log(`${r.entry.padEnd(12)} raw ${String(b.raw).padStart(9)}  min ${String(b.minified).padStart(9)}  gzip9 ${String(b.gzip9).padStart(9)}`);
}
const w = report.rapierWasmStandalone;
console.log(`wasm (standalone reference) raw ${w.rawBytes}  gzip9 ${w.gzip9Bytes}`);
const g = report.rapierGlueDerived;
console.log(`rapier glue (derived)       min ${String(g.glueMinifiedBytes).padStart(9)}  gzip9 ${String(g.glueGzip9Bytes).padStart(9)}`);
console.log(`basis pair gzip9 ${report.staticAssets.basisTranscoderPairGzip9}  meshopt shipped gzip9 ${report.staticAssets.meshoptDecoderShipped.gzip9Bytes}`);
console.log(`locales: EN ${report.locales.en.gzip9Bytes}  sw ${report.locales.sw.gzip9Bytes}  (${report.locales.keyCount} keys)`);
console.log(`first-visit provisional total gzip9: ${report.derived.firstVisitProvisional.totalGzip9}`);
