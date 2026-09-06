// B-LOAD-09 Phase-1 built-shell measurement (committed 2026-09-06 — the
// diagnostic version of this script lived only in gitignored build/ before
// the Part-B review; see ADR-004 "Addendum — Phase-1 built-shell
// measurement"): zlib gzipSync level 9 over the built shell JS (ADR-004's
// method) + the sourcemap module list (Rapier-absence check).
//
// Usage: npm run build && node tools/measure/shell-load.mjs [assetsDir]
// Default assetsDir is build/shell/assets (the `npm run build` output).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = process.argv[2] ?? 'build/shell/assets';
const files = readdirSync(dir);
const rows = [];
let totalRaw = 0;
let totalGzip = 0;
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const raw = readFileSync(join(dir, f));
  const gz = gzipSync(raw, { level: 9 });
  totalRaw += raw.length;
  totalGzip += gz.length;
  rows.push({ file: f, rawBytes: raw.length, gzip9Bytes: gz.length });
}

const mapFile = files.find((f) => f.endsWith('.js.map'));
const map = JSON.parse(readFileSync(join(dir, mapFile ?? ''), 'utf8'));
const sources = [...new Set(map.sources)].sort();
const rapierHits = sources.filter((s) => /rapier/i.test(s));
const byPackage = {};
for (const s of sources) {
  const m = /node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(s.replace(/\\/g, '/'));
  const pkg = m === null ? '(app)' : m[1];
  byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
}

console.log(JSON.stringify({ rows, totalRaw, totalGzip, moduleCount: sources.length, byPackage, rapierHits }, null, 1));
console.log('--- modules ---');
for (const s of sources) console.log(s);
