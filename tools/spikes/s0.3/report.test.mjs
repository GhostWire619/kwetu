// S0.3 report guard — throwaway Phase-0 spike test (CLAUDE.md tools/spikes
// carve-out). Asserts that report.json's figures are REGENERABLE:
//   1. the 2026-09-05 baseline entry figures reproduce byte-identically,
//   2. every static-asset and locale figure re-derives from the files on disk,
//   3. the derived figures (strict shell, Rapier shipping estimate, provisional
//      first-visit total) are internally consistent with their stated methods.
// Run: npx vitest run tools/spikes/s0.3
// Requires dist/ from a prior `node tools/spikes/s0.3/measure.mjs` run for the
// bundle-figure checks; static-asset and locale checks are independent of it.
import { expect, test } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const report = JSON.parse(readFileSync(path.join(here, 'report.json'), 'utf8'));

const GZIP9 = { level: 9 };
const gz = (absPath) => gzipSync(readFileSync(absPath), GZIP9).length;
const nm = (...parts) => path.join(repoRoot, 'node_modules', ...parts);

// Committed 2026-09-05 baseline (first S0.3 wave) — these MUST reproduce.
const BASELINE_2026_09_05 = {
  three: { raw: 1150902, minified: 511462, gzip9: 126438 },
  rapier: { raw: 2922934, minified: 2887718, gzip9: 1088335 },
  astronomy: { raw: 95621, minified: 44521, gzip9: 19257 },
  i18next: { raw: 74999, minified: 43171, gzip9: 13568 },
  shell: { raw: 4244682, minified: 3488728, gzip9: 1249242 },
};

test('baseline entry figures reproduce the committed 2026-09-05 values byte-identically', () => {
  for (const [entry, expected] of Object.entries(BASELINE_2026_09_05)) {
    const actual = report.entries[entry]?.jsTotalBytes;
    expect(actual, `entry ${entry} missing from report`).toBeDefined();
    expect(actual.raw, `${entry} raw`).toBe(expected.raw);
    expect(actual.minified, `${entry} minified`).toBe(expected.minified);
    expect(actual.gzip9, `${entry} gzip9`).toBe(expected.gzip9);
  }
});

test('bundle figures agree with a fresh gzip of the built dist artifacts', () => {
  const parseName = (fileString) => {
    const m = fileString.match(/^(.*) (\d+) B$/);
    expect(m, `file string "${fileString}" is well-formed`).not.toBeNull();
    return m[1];
  };
  for (const [entry, figures] of Object.entries(report.entries)) {
    const minDir = path.join(here, 'dist', entry, 'min');
    const jsNames = figures.files.min.map(parseName).filter((name) => name.endsWith('.js'));
    expect(jsNames.length, `${entry} has minified js output`).toBeGreaterThan(0);
    const concatenated = Buffer.concat(jsNames.map((name) => readFileSync(path.join(minDir, name))));
    expect(gzipSync(concatenated, GZIP9).length, `${entry} gzip9`).toBe(figures.jsTotalBytes.gzip9);
  }
});

test('B-LOAD-05 Basis transcoder figures re-derive from the shipped files', () => {
  const { basisTranscoderJs, basisTranscoderWasm, basisTranscoderPairGzip9 } = report.staticAssets;
  expect(basisTranscoderJs.gzip9Bytes).toBe(gz(nm('three', 'examples', 'jsm', 'libs', 'basis', 'basis_transcoder.js')));
  expect(basisTranscoderWasm.gzip9Bytes).toBe(gz(nm('three', 'examples', 'jsm', 'libs', 'basis', 'basis_transcoder.wasm')));
  expect(basisTranscoderPairGzip9).toBe(basisTranscoderJs.gzip9Bytes + basisTranscoderWasm.gzip9Bytes);
});

test('B-LOAD-06: no separate meshopt .wasm ships and the shipped-file figure re-derives', () => {
  const shipped = report.staticAssets.meshoptDecoderShipped;
  expect(shipped.gzip9Bytes).toBe(gz(nm('three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js')));
  // The only .wasm files three ships under examples/jsm/libs are basis/ and draco/.
  const libsDir = nm('three', 'examples', 'jsm', 'libs');
  const wasmFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.wasm')) wasmFiles.push(path.relative(libsDir, full));
    }
  };
  walk(libsDir);
  expect(wasmFiles.every((f) => f.startsWith('basis') || f.startsWith('draco'))).toBe(true);
});

test('Rapier standalone .wasm reference re-derives and the glue derivation is coherent', () => {
  const wasm = report.rapierWasmStandalone;
  expect(wasm.gzip9Bytes).toBe(gz(nm('@dimforge', 'rapier3d-deterministic-compat', 'dist', 'rapier_wasm3d_bg.wasm')));
  const glue = report.rapierGlueDerived;
  // base64 of 2,048,139 raw bytes must be ~4/3 of the raw size (plus padding).
  expect(glue.blobChars).toBe(Math.ceil(wasm.rawBytes / 3) * 4);
  const shipping = report.derived.rapierWasmShipping;
  expect(shipping.grossInliningCostGzip9).toBe(shipping.compatAsShipsGzip9 - wasm.gzip9Bytes);
  expect(shipping.separateWasmEstimate.estimatedTotalGzip9).toBe(shipping.separateWasmEstimate.glueGzip9 + shipping.separateWasmEstimate.wasmGzip9);
  expect(shipping.separateWasmEstimate.netSavingVsCompatGzip9).toBe(shipping.compatAsShipsGzip9 - shipping.separateWasmEstimate.estimatedTotalGzip9);
});

test('locale bundles: EN and sw carry identical 112-key sets and figures re-derive', () => {
  const en = JSON.parse(readFileSync(path.join(here, 'entries', 'locale-full.en.json'), 'utf8'));
  const sw = JSON.parse(readFileSync(path.join(here, 'entries', 'locale-full.sw.json'), 'utf8'));
  const enKeys = Object.keys(en).sort();
  const swKeys = Object.keys(sw).sort();
  expect(enKeys).toEqual(swKeys);
  expect(enKeys.length).toBe(report.locales.keyCount);
  expect(report.locales.en.gzip9Bytes).toBe(gz(path.join(here, 'entries', 'locale-full.en.json')));
  expect(report.locales.sw.gzip9Bytes).toBe(gz(path.join(here, 'entries', 'locale-full.sw.json')));
  // CLAUDE.md localization invariant: UI strings land EN + sw in the same change.
  for (const key of enKeys) {
    expect(typeof en[key]).toBe('string');
    expect(typeof sw[key]).toBe('string');
    expect(sw[key].length, `sw value for ${key} is non-empty`).toBeGreaterThan(0);
  }
});

test('the 8-key locale.sw.json fixture is untouched (protects shell.ts reproducibility)', () => {
  const fixture = JSON.parse(readFileSync(path.join(here, 'entries', 'locale.sw.json'), 'utf8'));
  expect(Object.keys(fixture).length).toBe(8);
  expect(fixture['welcome.title']).toBe('Karibu Kwetu');
});

test('B-LOAD-07 strict-shell derivation matches its stated method and cross-check', () => {
  const strict = report.derived.shellStrict;
  const expected = report.entries.shell.jsTotalBytes.gzip9 - report.entries.astronomy.jsTotalBytes.gzip9 - report.entries.i18next.jsTotalBytes.gzip9;
  expect(strict.gzipBytes).toBe(expected);
  expect(strict.crossCheck.shellStrictEntryGzip9).toBe(report.entries['shell-strict'].jsTotalBytes.gzip9);
  expect(strict.crossCheck.directVsDerivedDelta).toBe(strict.crossCheck.shellStrictEntryGzip9 - expected);
  // Single-stream gzip is not strictly additive across deletions; the direct
  // build and the subtraction must still land within a few KB of each other.
  expect(Math.abs(strict.crossCheck.directVsDerivedDelta)).toBeLessThan(5000);
});

test('B-LOAD-09 provisional total equals the sum over its stated inclusion list', () => {
  const provisional = report.derived.firstVisitProvisional;
  const { fullshellGzip9, basisTranscoderJsGzip9, basisTranscoderWasmGzip9, localeEnGzip9 } = provisional.components;
  expect(provisional.totalGzip9).toBe(fullshellGzip9 + basisTranscoderJsGzip9 + basisTranscoderWasmGzip9 + localeEnGzip9);
  expect(fullshellGzip9).toBe(report.entries.fullshell.jsTotalBytes.gzip9);
  // The Rapier standalone .wasm must NOT appear — the compat JS already carries it.
  const inclusionText = provisional.inclusionList.join(' ');
  expect(inclusionText).toContain('Rapier compat (base64-inlined WASM)');
});

test('B-LOAD-09 row-sum accounting agrees with the single-stream fullshell build', () => {
  const e = (name) => report.entries[name].jsTotalBytes.gzip9;
  const glue = report.derived.shellOverheadVsDepSum.gzipBytesDelta;
  const rowSum =
    e('three') + e('rapier') + e('astronomy') + e('i18next') + glue + e('nakama') + e('livekit') + e('meshopt') +
    report.staticAssets.basisTranscoderPairGzip9 + report.locales.en.gzip9Bytes;
  const delta = rowSum - report.derived.firstVisitProvisional.totalGzip9;
  // Shared gzip dictionary effects make the single-stream build slightly smaller.
  expect(delta).toBeGreaterThanOrEqual(0);
  expect(delta).toBeLessThan(5000);
});

test('fullshell bundle sanity: contains the heavy packages, no double counting', () => {
  const e = (name) => report.entries[name].jsTotalBytes.gzip9;
  const fullshell = e('fullshell');
  expect(fullshell).toBeGreaterThan(e('shell'));
  expect(fullshell).toBeGreaterThan(e('livekit'));
  const upperBound = e('shell') + e('nakama') + e('livekit') + e('meshopt');
  expect(fullshell).toBeLessThanOrEqual(upperBound);
});

test('every B-LOAD figure the spike owes carries a value or an explicit null with a reason', () => {
  const summary = report.budgetFigureSummary;
  for (const id of ['B-LOAD-01', 'B-LOAD-02', 'B-LOAD-03', 'B-LOAD-04', 'B-LOAD-05', 'B-LOAD-06', 'B-LOAD-07', 'B-LOAD-08', 'B-LOAD-09']) {
    expect(summary[id]?.value, `${id} must be filled`).not.toBeNull();
    expect(summary[id]?.method, `${id} must carry a method`).toBeTruthy();
  }
  expect(summary['B-LOAD-10'].value).toBeNull();
  expect(summary['B-LOAD-10'].method).toMatch(/warm|CDN/i);
});
