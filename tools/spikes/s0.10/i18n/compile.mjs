// S0.10 i18n compile step — throwaway Phase-0 spike code (CLAUDE.md tools/spikes
// carve-out). NOT a production build script; the Phase-1 build wrapper will own
// this. It exists so the ADR's commands and the compiled artifacts in locales/
// are regenerable tonight.
//
// Usage: node tools/spikes/s0.10/i18n/compile.mjs
//
// Pipeline per docs/swahili-i18n.md §4:
//   1. Run the i18next-conv CLI over each PO (PO -> JSON parse proof, exact
//      flags set explicitly — never tool defaults) into a temp intermediate.
//   2. Re-emit the contract JSON: flat keys `<msgctxt><msgid>` (ctx FIRST,
//      msgctxt carries its own trailing slash), i18next v4 plural suffixes
//      (`_one` from msgstr[0], `_other` from msgstr[1]).
//   3. Enforce the compile-step contract items: Plural-Forms header exact
//      match, msgctxt format, printf rejection, placeholder parity EN<->sw,
//      key uniqueness, cross-locale key parity, and a round-trip assertion
//      that every emitted value matches the i18next-conv CLI's own output.
//
// FINDING (measured 2026-09-06, i18next-conv 17.0.0): the CLI joins keys as
// `msgid + ctxSeparator + msgctxt` (gettext-converter esm/js2i18next.js line
// 119) — the OPPOSITE order of the owning doc's contract
// (`<msgctxt><msgid>`). An empty --ctxSeparator is impossible (`options
// .ctxSeparator || '_'`), so the CLI alone cannot emit ctx-first keys. The
// normalizer below therefore re-keys the CLI output using an authoritative
// gettext-parser parse, and asserts value round-trip against the CLI output.
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { po } from 'gettext-parser';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const repoRoot = path.resolve(spikeRoot, '..', '..', '..');
const tmpDir = path.join(here, 'tmp');

const CANONICAL_PLURAL_FORMS = 'nplurals=2; plural=(n != 1);';
const CTX_RE = /^[a-z0-9_]+(\/[a-z0-9_]+)*\/$/; // snake_case segments, trailing slash
const PRINTF_RE = /%(\d+\$)?[#0-9.]*[sdfioxXeEgG]/; // printf-style tokens are rejected
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g; // i18next tokens
const PLURAL_SUFFIX = ['_one', '_other']; // v4: msgstr[0] -> _one, msgstr[1] -> _other

const fail = (msg) => {
  throw new Error(`[s0.10 compile] ${msg}`);
};

function parsePo(file) {
  const raw = readFileSync(file, 'utf8');
  const parsed = po.parse(raw, 'UTF-8');
  const headerLine = String(parsed.headers?.['Plural-Forms'] ?? parsed.headers?.['plural-forms'] ?? '').trim();
  if (headerLine !== CANONICAL_PLURAL_FORMS) {
    fail(
      `${path.basename(file)}: Plural-Forms header is "${headerLine}" but must EXACTLY equal ` +
        `"${CANONICAL_PLURAL_FORMS}". docs/swahili-i18n.md §3: corrupted headers circulate in real sw files ` +
        `(an Arabic nplurals=6 expression was found inside sw-labelled POTs); never "parse it anyway".`,
    );
  }
  return parsed;
}

function contractEntries(parsed, poName) {
  const entries = new Map(); // contractKey -> { value, msgid, msgctxt, tokens }
  for (const [ctx, msgs] of Object.entries(parsed.translations ?? {})) {
    for (const [msgid, item] of Object.entries(msgs)) {
      if (msgid === '') continue; // header entry
      if (!CTX_RE.test(ctx)) {
        fail(`${poName}: msgctxt "${ctx}" is not <screen>/ snake_case with a trailing slash (docs/swahili-i18n.md §2).`);
      }
      if (msgid.includes('##')) {
        fail(`${poName}: msgid "${msgid}" contains the keyseparator '##' — flat keys would corrupt.`);
      }
      if (PRINTF_RE.test(msgid)) {
        fail(`${poName}: msgid "${msgid}" uses printf-style placeholders — i18next {{token}} only (§2).`);
      }
      const key = ctx + msgid; // contract: <msgctxt><msgid> joined with '/'
      if (entries.has(key)) fail(`${poName}: duplicate joined key "${key}".`);
      const plural = item.msgid_plural !== undefined;
      const msgstr = item.msgstr ?? [];
      if (plural && msgstr.length !== 2) {
        fail(`${poName}: plural entry "${key}" has ${msgstr.length} msgstr slots; nplurals=2 requires exactly 2.`);
      }
      if (!plural && (msgstr[0] ?? '') === '') {
        fail(`${poName}: entry "${key}" has an empty msgstr (EN is compiled too — fill it, §1 principle 5).`);
      }
      const tokens = [...(plural ? item.msgid_plural : msgid).matchAll(TOKEN_RE)].map((m) => m[1]).sort();
      entries.set(key, { value: plural ? null : msgstr[0], msgid, msgctxt: ctx, plural, tokens });
    }
  }
  return entries;
}

function checkPlaceholderParity(enEntries, swEntries, poName) {
  for (const [key, e] of enEntries) {
    const s = swEntries.get(key);
    if (!s) fail(`${poName}: key "${key}" is missing from the sw PO — UI strings land EN + sw in the same change (§1).`);
    const a = e.tokens.join(',');
    const b = s.tokens.join(',');
    if (a !== b) {
      fail(`${poName}: placeholder mismatch for "${key}": en={${a}} sw={${b}} — tokens must match exactly.`);
    }
  }
  for (const key of swEntries.keys()) {
    if (!enEntries.has(key)) fail(`${poName}: sw PO has key "${key}" with no EN counterpart.`);
  }
}

function emitJson(entries, locale) {
  const out = {};
  for (const [key, e] of entries) {
    if (e.plural) {
      out[key + PLURAL_SUFFIX[0]] = e.valueOne;
      out[key + PLURAL_SUFFIX[1]] = e.valueOther;
    } else {
      out[key] = e.value;
    }
  }
  return out;
}

function runConvCli(locale, poPath, outJsonPath) {
  // Exact CLI flags, set explicitly (docs/swahili-i18n.md §4: never tool
  // defaults). --compatibilityJSON v4 targets the i18next@21+ plural format.
  const args = [
    'i18next-conv',
    '-l', locale,
    '-s', poPath,
    '-t', outJsonPath,
    '-k', '##',            // keyseparator (explicit default; msgids containing it are rejected above)
    '--ctxSeparator', '_', // explicit default — conv emits msgid_ctx keys; we re-key to ctx-first
    '--compatibilityJSON', 'v4',
    '--noDate',            // deterministic output (no timestamps)
    '--quiet',
  ];
  const res = spawnSync('npx', args, { cwd: repoRoot, shell: process.platform === 'win32', encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`i18next-conv CLI failed for ${locale} (exit ${res.status}):\n${res.stderr || res.stdout}`);
  }
  return JSON.parse(readFileSync(outJsonPath, 'utf8'));
}

// ---------------------------------------------------------------- run
mkdirSync(tmpDir, { recursive: true });
const report = { locales: {}, checks: {} };
const parsed = {};
const entries = {};

for (const locale of ['en', 'sw']) {
  const poPath = path.join(repoRoot, 'locales', 'po', `${locale}.default.po`);
  parsed[locale] = parsePo(poPath);
  entries[locale] = contractEntries(parsed[locale], `${locale}.default.po`);
  const nFuzzy = Object.values(parsed[locale].translations ?? {})
    .flatMap((msgs) => Object.values(msgs))
    .filter((it) => it.comments?.flag?.includes('fuzzy')).length;
  report.locales[locale] = { poEntries: entries[locale].size, fuzzyEntries: nFuzzy };
}

checkPlaceholderParity(entries.en, entries.sw, 'en<->sw');

// plural values land after the parity check so `valueOne/valueOther` are set late
for (const locale of ['en', 'sw']) {
  for (const [, e] of entries[locale]) {
    if (e.plural) {
      const msgs = Object.values(parsed[locale].translations ?? {})
        .flatMap((msgs) => Object.values(msgs))
        .find((it) => it.msgid === e.msgid && it.msgid_plural !== undefined);
      e.valueOne = msgs.msgstr[0];
      e.valueOther = msgs.msgstr[1];
    }
  }
}

for (const locale of ['en', 'sw']) {
  const contractJson = emitJson(entries[locale], locale);
  const convJson = runConvCli(
    locale,
    path.join(repoRoot, 'locales', 'po', `${locale}.default.po`),
    path.join(tmpDir, `${locale}.conv.json`),
  );

  // round-trip: contract value must equal the CLI's own output value.
  // conv joins keys as `msgid + '_' + msgctxt (+ plural suffix)` with the
  // msgctxt's trailing slash intact (measured 2026-09-06, see header note).
  let verified = 0;
  for (const [key, value] of Object.entries(contractJson)) {
    const info = [...entries[locale].values()].find((v) => key.startsWith(v.msgctxt + v.msgid));
    if (!info) fail(`round-trip: no PO entry for emitted key "${key}"`);
    const convKey =
      `${info.msgid}_${info.msgctxt}` +
      (info.plural ? (key.endsWith('_one') ? '_one' : '_other') : '');
    if (!(convKey in convJson)) {
      fail(`round-trip: i18next-conv output for ${locale} has no key "${convKey}" (contract key "${key}")`);
    }
    if (convJson[convKey] !== value) {
      fail(`round-trip: value mismatch for ${locale} "${key}": contract="${value}" conv="${convJson[convKey]}"`);
    }
    verified += 1;
  }

  const outPath = path.join(repoRoot, 'locales', locale, 'translation.json');
  mkdirSync(path.dirname(outPath), { recursive: true });
  const json = JSON.stringify(contractJson, null, 4) + '\n';
  writeFileSync(outPath, json);
  const raw = Buffer.from(json, 'utf8');
  report.locales[locale].compiled = {
    path: path.relative(repoRoot, outPath).replaceAll('\\', '/'),
    keys: Object.keys(contractJson).length,
    rawBytes: raw.length,
    gzip9Bytes: gzipSync(raw, { level: 9 }).length,
    convRoundTripVerifiedKeys: verified,
  };
}

const en = report.locales.en.compiled;
const sw = report.locales.sw.compiled;
report.checks = {
  canonicalPluralForms: CANONICAL_PLURAL_FORMS,
  placeholderParity: 'pass',
  crossLocaleKeyParity: 'pass',
  flatKeys: true,
  bundleRatio: {
    swVsEnRaw: +(sw.rawBytes / en.rawBytes).toFixed(4),
    swVsEnGzip9: +(sw.gzip9Bytes / en.gzip9Bytes).toFixed(4),
  },
};

rmSync(tmpDir, { recursive: true, force: true });
writeFileSync(path.join(here, 'compile-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`en: ${en.keys} keys, ${en.rawBytes} B (gzip9 ${en.gzip9Bytes} B)`);
console.log(`sw: ${sw.keys} keys, ${sw.rawBytes} B (gzip9 ${sw.gzip9Bytes} B)`);
console.log(`sw/en ratio: raw ${report.checks.bundleRatio.swVsEnRaw}, gzip9 ${report.checks.bundleRatio.swVsEnGzip9}`);
