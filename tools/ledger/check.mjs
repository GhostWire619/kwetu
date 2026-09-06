// tools/ledger/check.mjs — S0.4 license-ledger CI check (ROADMAP.md §5, S0.4).
//
// Enforces the docs' own rules mechanically. Rule sources:
//   R0  The five documents this gate reads exist and are non-empty.
//   R1  THIRD_PARTY_ASSETS.md "The gate" rule 2 + Row format — every ledger row
//       (code-NN / asset-NN / data-NN / gen-NN) carries an id, a license cell and
//       a non-empty attribution cell; a `y` cell points at an exact string in
//       ATTRIBUTIONS.md (STR-* name or quoted verbatim text, whitespace-
//       normalized: trimmed, runs of whitespace collapsed to single spaces); an
//       `n` cell records why no string is owed.
//   R2  THIRD_PARTY_ASSETS.md note 4 — a blocked verdict (asset-01) keeps its
//       recorded refusal: the row must exist, carry a reason, and stay marked
//       `n/a — blocked verdict`.
//   R3  THIRD_PARTY_ASSETS.md §Generated assets rule 1 — the gen table carries
//       the model/version/prompt/date columns and every gen-NN row fills them.
//       Passes vacuously while the table is empty, but still asserts the
//       columns are detectable in the header.
//   R4  DATA_SOURCES.md provenance table — every row pins source URL, license
//       and version/date (the provenance cells).
//   R5  ATTRIBUTIONS.md §Docs and repo attribution + MASTER_PROMPT.md §44 — the
//       attribution strings quoted in README.md ("Data and assets") and
//       MASTER_PROMPT.md §44 byte-match the canonical strings under the
//       whitespace-normalized standard (ATTRIBUTIONS.md preamble).
//   R6  DATA_SOURCES.md §Format column notes — an `ATTRIBUTIONS.md#<slug>` link
//       must point at an anchor that exists: every such reference in any *.md
//       resolves to an explicit `<a id="...">` in ATTRIBUTIONS.md.
//   R7  package.json dependency coverage (CLAUDE.md: "Never add a dependency
//       without a THIRD_PARTY_ASSETS.md row") — every name in dependencies AND
//       devDependencies must appear as the name of a code-NN row (boundary-
//       aware match; annotation-carrying name cells are fine). Transitive
//       dependencies are NOT checked — only direct declarations are deliberate
//       adoption decisions. Rows outside the code table (asset/data/gen) never
//       satisfy coverage.
//   R8  version drift (the gate, rule 3: a verdict is valid only for the
//       pinned commit) — for each declared package, every matching code row
//       whose pin cell carries a comparable version must equal the version
//       resolved in package-lock.json (packages["node_modules/<name>"].version,
//       lockfileVersion-1 dependencies fallback). A mismatch fails; an
//       unpinned row defers with a warning (pin lands at first code commit).
//
// Node builtins only (project code, zero dependencies — no ledger row owed).
// Exit codes: 0 = pass, 1 = violation, 2 = structural error.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- utilities

/** House whitespace-normalized standard (ATTRIBUTIONS.md preamble). */
export function normalizeWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Strip markdown emphasis so cell analysis sees the text, not the markup. */
function stripMd(s) {
  return String(s ?? '').replace(/\*\*/g, '').trim();
}

/** Blank out fenced code blocks, preserving line count (line numbers stay true). */
export function stripFences(md) {
  const out = [];
  let inFence = false;
  for (const line of String(md ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(''); continue; }
    out.push(inFence ? '' : line);
  }
  return out.join('\n');
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

function isSepRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
}

/** Parse every markdown table: [{ header, rows: [{num, cells}] }] (1-based md line numbers). */
export function parseTables(md) {
  const lines = stripFences(md).split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    if (i + 1 >= lines.length || !isSepRow(splitRow(lines[i + 1]))) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      rows.push({ num: j + 1, cells: splitRow(lines[j]) });
      j++;
    }
    tables.push({ header: splitRow(lines[i]), startLine: i + 1, rows });
    i = j - 1;
  }
  return tables;
}

const ID_RE = /^(code|asset|data|gen)-\d{2,}$/;
const STR_RE = /\bSTR-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*/g;

/** A quoted span that claims to be a string, not a path/URL/filename/short token. */
export function isStringLike(s) {
  const n = normalizeWs(s);
  if (n.length < 8) return false;
  if (!/\p{L}{3}/u.test(n)) return false;
  if (/^(https?:|www\.)/i.test(n)) return false;
  if (/[\\/]/.test(n)) return false;
  if (/\.(md|txt|json|toml|yaml|pbf|glb|gltf|ktx2|zip|pmtiles)\b/i.test(n)) return false;
  return true;
}

/** The docs' own recorded-deferral language for a `y` whose string lands later. */
const DEFERRAL_RE =
  /\b(to be added|lands in the ci-generated table|ci-generated table|pending|placeholder|at pin|not yet|until the|deferred)\b/i;

// ------------------------------------------------- ATTRIBUTIONS.md canonical

/**
 * Parse ATTRIBUTIONS.md: the `### STR-*` sections, their "String (verbatim)"
 * spans (a wrapped string continues on following lines that are bare backtick
 * spans), and the explicit `<a id="...">` anchors.
 *
 * Returns { strs: Map<NAME, {line, spans}>, units: Map<normalized, {str, kind}>,
 * anchors: Set<string> }. `units` holds every individual span AND the
 * whitespace-joined full string (STR-NASA's two sentences are one string,
 * delivered as two adjacent spans).
 */
export function parseAttributionStrings(attribMd) {
  const lines = stripFences(attribMd).split(/\r?\n/);
  const strs = new Map();
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(STR-[A-Za-z0-9-]+)\b/);
    if (h) { current = h[1]; strs.set(current, { line: i + 1, spans: [] }); continue; }
    if (/^#{1,6}\s/.test(lines[i])) { current = null; continue; }
    if (!current) continue;
    const m = lines[i].match(/String \(verbatim\)\s*:\s*(.*)$/);
    if (!m) continue;
    const spans = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    let j = i + 1;
    while (j < lines.length && /^\s+`[^`]+`\s*$/.test(lines[j])) {
      spans.push(lines[j].trim().slice(1, -1));
      j++;
    }
    strs.get(current).spans.push(...spans);
  }
  const units = new Map();
  for (const [name, { spans }] of strs) {
    for (const s of spans) units.set(normalizeWs(s), { str: name, kind: 'span' });
    if (spans.length > 1) units.set(normalizeWs(spans.join(' ')), { str: name, kind: 'joined' });
  }
  const anchors = new Set(
    [...String(attribMd ?? '').matchAll(/<a\s+id=["']([^"']+)["']/g)].map((m) => m[1]),
  );
  return { strs, units, anchors };
}

// ------------------------------------------------- THIRD_PARTY_ASSETS.md tables

function locateCols(table) {
  const h = table.header.map((c) => c.toLowerCase());
  return {
    ...table,
    idCol: h.findIndex((c) => c === 'id'),
    licCol: h.findIndex((c) => /license/.test(c)),
    attrCol: h.findIndex((c) => /^attribution string/.test(c)),
    nameCol: h.findIndex((c) => c === 'name'),
    pinCol: h.findIndex((c) => c === 'pin' || /^pin\b/.test(c)),
  };
}

/** Find the three ledger tables of THIRD_PARTY_ASSETS.md (throws if any is missing). */
export function parseTpaTables(tpaMd) {
  let code = null;
  let dataset = null;
  let gen = null;
  for (const t of parseTables(tpaMd)) {
    const h = t.header.map((c) => c.toLowerCase());
    if (h.some((c) => c === 'attribution string required')) code ??= locateCols(t);
    else if (h[0] === 'id' && h.some((c) => c === 'dataset') && h.some((c) => /^attribution string/.test(c))) dataset ??= locateCols(t);
    else if (h.some((c) => /^model \+ version$/.test(c))) gen ??= locateCols(t);
  }
  const missing = [
    code ? null : 'code/asset dependency table',
    dataset ? null : 'dataset license-shape table',
    gen ? null : 'generated-assets table',
  ].filter(Boolean);
  if (missing.length) throw new Error(`THIRD_PARTY_ASSETS.md: table(s) not found: ${missing.join('; ')}`);
  return { code, dataset, gen };
}

export function classifyRows(table) {
  const ledger = [];
  const placeholders = [];
  const bad = [];
  for (const r of table.rows) {
    const idCell = stripMd(r.cells[table.idCol] ?? '');
    const nonEmpty = r.cells.filter((c) => stripMd(c) !== '').length;
    if (ID_RE.test(idCell)) ledger.push({ ...r, id: idCell });
    else if (nonEmpty === 0 || /none yet/i.test(idCell)) placeholders.push(r);
    else if (idCell === '' || /^(code|asset|data|gen)(?!-\d{2,}\b)/i.test(idCell)) bad.push({ ...r, idCell });
    else placeholders.push(r);
  }
  return { ledger, placeholders, bad };
}

// ------------------------------------------------- package.json + lockfile

const SEMVER_RE = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** First comparable version token in a pin cell — null when unpinned or non-semver ("4.x"). */
export function parsePinVersion(cell) {
  const m = stripMd(cell).match(SEMVER_RE);
  return m ? m[0] : null;
}

function normalizeVersion(v) {
  return String(v ?? '').trim().replace(/^v/i, '').replace(/^==/, '').trim();
}

/**
 * Boundary-aware "does this ledger name cell refer to this npm package?".
 * Name cells may carry annotations ("@heroiclabs/nakama-js (npm scope; plain
 * `nakama-js` 404s)", "three.js", "meshoptimizer / gltfpack"), so an exact
 * cell match is not required — but the match must not continue a longer name:
 * "vite" must not match "vitest", "i18next" must not match "i18next-conv",
 * and an unscoped name must not match inside a scope ("three" vs
 * "@types/three"). '.' and '/' may END a match ("three.js"), never extend it.
 */
export function rowNameMatches(nameCell, pkg) {
  const c = normalizeWs(stripMd(nameCell)).toLowerCase();
  const p = normalizeWs(String(pkg ?? '')).toLowerCase();
  if (!p) return false;
  const extendsName = (ch) => /[a-z0-9@/_.-]/.test(ch);
  let i = c.indexOf(p);
  while (i !== -1) {
    const before = i > 0 ? c[i - 1] : '';
    const after = i + p.length < c.length ? c[i + p.length] : '';
    if (!extendsName(before) && !/[a-z0-9@_-]/.test(after)) return true;
    i = c.indexOf(p, i + 1);
  }
  return false;
}

/** Parse package.json into name → {section, spec} over dependencies + devDependencies. */
export function parsePackageJson(text) {
  const out = { names: new Map(), error: null };
  if (text === null || text === undefined) {
    out.error = 'not readable';
    return out;
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  for (const section of ['dependencies', 'devDependencies']) {
    const obj = pkg && typeof pkg === 'object' ? pkg[section] : null;
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, spec] of Object.entries(obj)) {
      if (typeof name === 'string' && name) out.names.set(name, { section, spec: String(spec) });
    }
  }
  return out;
}

/** Resolved version from an npm lockfile: v3 packages["node_modules/<name>"].version, v1 dependencies fallback. */
export function resolvedLockVersion(lock, name) {
  const v3 = lock && lock.packages ? lock.packages[`node_modules/${name}`] : null;
  if (v3 && typeof v3.version === 'string') return v3.version;
  const v1 = lock && lock.dependencies ? lock.dependencies[name] : null;
  if (v1 && typeof v1.version === 'string') return v1.version;
  return null;
}

/** Evaluate one attribution cell. verdict: ok | deferred | fail */
export function evalAttributionCell(cell, canon) {
  const raw = stripMd(cell);
  if (raw === '') return { verdict: 'fail', msg: 'attribution cell is empty' };
  if (/^n(?:\/a)?\b/i.test(raw)) {
    const reason = raw.replace(/^n(?:\/a)?\b[\s—–:.]*/, '');
    if (normalizeWs(reason).replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
      return { verdict: 'fail', msg: `'n' without a recorded reason: "${normalizeWs(raw)}"` };
    }
    return { verdict: 'ok', msg: `n — ${normalizeWs(reason)}` };
  }
  const strNames = [...new Set(raw.match(STR_RE) ?? [])];
  const spans = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(isStringLike);
  const unknown = strNames.filter((n) => !canon.strs.has(n));
  if (unknown.length) {
    return { verdict: 'fail', msg: `STR reference not in ATTRIBUTIONS.md: ${unknown.join(', ')}` };
  }
  const badSpans = spans.filter((s) => !canon.units.has(normalizeWs(s)));
  if (badSpans.length) {
    return {
      verdict: 'fail',
      msg: `quoted string not found in ATTRIBUTIONS.md (whitespace-normalized): "${normalizeWs(badSpans[0])}"`,
    };
  }
  if (strNames.length || spans.length) {
    return { verdict: 'ok', msg: `resolved via ${[...strNames, ...spans].map(normalizeWs).join(' | ')}` };
  }
  if (/^y\b/i.test(raw)) {
    if (DEFERRAL_RE.test(raw)) return { verdict: 'deferred', msg: `y deferred to a named trigger — "${normalizeWs(raw)}"` };
    return { verdict: 'fail', msg: `'y' with no resolvable string and no recorded deferral: "${normalizeWs(raw)}"` };
  }
  return { verdict: 'fail', msg: `unrecognized attribution cell (neither y/n nor a resolvable string): "${normalizeWs(raw)}"` };
}

// ----------------------------------------------------------------- rules

function rule0Files(files, out) {
  for (const f of files) {
    if (f.text === null || f.text === undefined) {
      out.fail('R0', `required document not readable: ${f.name}`);
    } else if (f.text.trim() === '') {
      out.fail('R0', `required document is empty: ${f.name}`);
    } else {
      out.info('R0', `${f.name}: ${f.text.split(/\r?\n/).length} lines`);
    }
  }
}

function rule1LedgerRows(tpa, canon, out) {
  let total = 0;
  for (const [label, table, withAttr] of [
    ['code/asset table', tpa.code, true],
    ['dataset table', tpa.dataset, true],
    ['generated-assets table', tpa.gen, false],
  ]) {
    const { ledger, placeholders, bad } = classifyRows(table);
    total += ledger.length;
    out.info(
      'R1',
      `${label}: ${ledger.length} ledger row(s)${placeholders.length ? `, ${placeholders.length} placeholder row(s) skipped` : ''}`,
    );
    for (const b of bad) {
      out.fail(
        'R1',
        `row with a malformed/missing ledger id (line ${b.num}): id="${b.idCell}" — expected code-NN / asset-NN / data-NN / gen-NN`,
      );
    }
    for (const row of ledger) {
      const lic = stripMd(row.cells[table.licCol] ?? '');
      if (lic === '') out.fail('R1', `${row.id}: license cell is empty`);
      else if (/\[placeholder/i.test(lic)) out.info('R1', `${row.id}: license pending verification by design — "${normalizeWs(lic)}"`);
      if (!withAttr) continue;
      const v = evalAttributionCell(row.cells[table.attrCol] ?? '', canon);
      if (v.verdict === 'fail') out.fail('R1', `${row.id}: ${v.msg}`);
      else if (v.verdict === 'deferred') out.warn('R1', `${row.id}: attribution ${v.msg}`);
    }
  }
  return total;
}

function isBlockedRow(row, table) {
  return /^NO\b/.test(normalizeWs(stripMd(row.cells[table.licCol] ?? '')));
}

function rule2BlockedRefusals(tpa, out) {
  let checked = 0;
  const blockedIds = [];
  for (const table of [tpa.code, tpa.dataset]) {
    for (const row of classifyRows(table).ledger) {
      if (!isBlockedRow(row, table)) continue;
      checked++;
      blockedIds.push(row.id);
      const lic = normalizeWs(stripMd(row.cells[table.licCol] ?? ''));
      const reason = lic.replace(/^NO\b[\s—–:.]*/, '');
      if (normalizeWs(reason).replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
        out.fail('R2', `${row.id}: blocked verdict without a recorded refusal reason ("${lic}")`);
      }
      const attr = normalizeWs(stripMd(row.cells[table.attrCol] ?? ''));
      if (!/blocked/i.test(attr)) {
        out.fail('R2', `${row.id}: blocked verdict must keep an attribution cell of "n/a — blocked verdict" (found "${attr}")`);
      } else {
        out.info('R2', `${row.id}: refusal retained — ${lic}`);
      }
    }
  }
  const asset01 = classifyRows(tpa.code).ledger.find((r) => r.id === 'asset-01');
  if (!asset01) {
    out.fail('R2', 'asset-01 not found: the recorded Quaternius refusal (THIRD_PARTY_ASSETS.md note 4) has been removed');
  } else if (!blockedIds.includes('asset-01')) {
    out.fail('R2', 'asset-01 exists but is no longer a blocked-verdict row — the recorded refusal was altered');
  }
  return checked;
}

function rule3GeneratedAssets(tpa, out) {
  const t = tpa.gen;
  const h = t.header.map((c) => c.toLowerCase());
  const need = [['model', /model/], ['version', /version/], ['prompt', /prompt/], ['generated date', /generated/]];
  for (const [name, re] of need) {
    if (!h.some((c) => re.test(c))) {
      out.fail('R3', `generated-assets table header has no "${name}" column — AI provenance cannot be recorded`);
    }
  }
  out.info('R3', 'generated-assets table: model/version/prompt/date columns detected in header');
  const { ledger, placeholders } = classifyRows(t);
  if (ledger.length === 0) {
    out.info('R3', `generated-assets table: 0 gen rows — rule passes vacuously (${placeholders.length} placeholder row(s) skipped)`);
    return 0;
  }
  for (const row of ledger) {
    const cell = (re) => stripMd(row.cells[h.findIndex((c) => re.test(c))] ?? '');
    if (cell(/^asset$/) === '') out.fail('R3', `${row.id}: asset cell is empty`);
    if (cell(/model/) === '') out.fail('R3', `${row.id}: model + version cell is empty — a generated asset may not be committed without it`);
    if (cell(/prompt/) === '') out.fail('R3', `${row.id}: prompt cell is empty — the prompt is recorded in full or by reference`);
    const date = cell(/generated/);
    if (date === '') out.fail('R3', `${row.id}: generated-date cell is empty`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) out.warn('R3', `${row.id}: generated date "${date}" is not ISO 8601 (YYYY-MM-DD)`);
    if (cell(/output license/) === '') out.fail('R3', `${row.id}: output-license cell is empty`);
  }
  return ledger.length;
}

function rule4DataSources(dsMd, out) {
  const tables = parseTables(dsMd).filter((t) => {
    const h = t.header.map((c) => c.toLowerCase());
    return h[0] === 'dataset' && h.some((c) => /version\/date pinned/.test(c));
  });
  if (tables.length === 0) {
    out.fail('R4', 'DATA_SOURCES.md: provenance table not found (expected header "dataset | version/date pinned | source URL | license | ...")');
    return 0;
  }
  let n = 0;
  for (const t of tables) {
    const h = t.header.map((c) => c.toLowerCase());
    const col = (re) => h.findIndex((c) => re.test(c));
    const verCol = col(/version\/date pinned/);
    const srcCol = col(/source url/);
    const licCol = col(/^license/);
    const attrCol = col(/exact attribution string/);
    const buildCol = col(/build step/);
    const cadCol = col(/refresh cadence/);
    for (const r of t.rows) {
      const idCell = stripMd(r.cells[0] ?? '');
      const nonEmpty = r.cells.filter((c) => stripMd(c) !== '').length;
      if (nonEmpty === 0 || /none yet/i.test(idCell)) continue;
      n++;
      const name = normalizeWs(idCell).slice(0, 60) || `line ${r.num}`;
      if (verCol < 0 || stripMd(r.cells[verCol] ?? '') === '') out.fail('R4', `DATA_SOURCES.md "${name}": provenance cell (version/date pinned) is empty`);
      if (srcCol < 0 || stripMd(r.cells[srcCol] ?? '') === '') out.fail('R4', `DATA_SOURCES.md "${name}": source URL cell is empty`);
      if (licCol < 0 || stripMd(r.cells[licCol] ?? '') === '') out.fail('R4', `DATA_SOURCES.md "${name}": license cell is empty`);
      if (attrCol >= 0 && stripMd(r.cells[attrCol] ?? '') === '') out.warn('R4', `DATA_SOURCES.md "${name}": exact-attribution-string cell is empty`);
      if (buildCol >= 0 && stripMd(r.cells[buildCol] ?? '') === '') out.warn('R4', `DATA_SOURCES.md "${name}": build-step cell is empty`);
      if (cadCol >= 0 && stripMd(r.cells[cadCol] ?? '') === '') out.warn('R4', `DATA_SOURCES.md "${name}": refresh-cadence cell is empty`);
    }
  }
  out.info('R4', `DATA_SOURCES.md: ${n} provenance row(s) checked (source + license + pin)`);
  return n;
}

/**
 * R5. Required per-doc string sets come from the docs themselves:
 *  - README "Data and assets": STR-OSM, STR-COPERNICUS, STR-NASA
 *    (ATTRIBUTIONS.md §Docs and repo attribution).
 *  - MASTER_PROMPT §44 quotes STR-OSM, STR-GEOFABRIK, STR-COPERNICUS (the NASA
 *    acknowledgment is referenced there, not quoted).
 * A string counts as present if a run of 1..4 consecutive quoted spans, joined
 * with spaces, equals the canonical string whitespace-normalized (this admits
 * STR-NASA's two-sentence form delivered as two adjacent spans).
 */
const DOC_REQUIREMENTS = [
  { doc: 'README.md', section: /^## Data and assets\b/m, title: '"Data and assets"', strs: ['STR-OSM', 'STR-COPERNICUS', 'STR-NASA'] },
  { doc: 'MASTER_PROMPT.md', section: /^## 44\. Attribution\b/m, title: '§44', strs: ['STR-OSM', 'STR-GEOFABRIK', 'STR-COPERNICUS'] },
];

/** Any quoted span invoking a provider name must BE a canonical string. */
const MARKERS = ['OpenStreetMap contributors', 'Open Database License', 'Copernicus data', 'Geofabrik GmbH', 'Geological Survey', 'Natural Earth'];

function sectionOf(md, sectionRe) {
  const src = stripFences(md);
  const start = src.search(sectionRe);
  if (start < 0) return null;
  const rest = src.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function rule5DocQuotes(readmeMd, mpMd, canon, out) {
  const docs = { 'README.md': readmeMd, 'MASTER_PROMPT.md': mpMd };
  for (const req of DOC_REQUIREMENTS) {
    const section = sectionOf(docs[req.doc], req.section);
    if (section === null) {
      out.fail('R5', `${req.doc}: ${req.title} section not found — the doc-footer attribution rule cannot hold`);
      continue;
    }
    const spans = [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const strName of req.strs) {
      const def = canon.strs.get(strName);
      if (!def || def.spans.length === 0) {
        out.fail('R5', `${req.doc}: required string ${strName} has no verbatim form in ATTRIBUTIONS.md`);
        continue;
      }
      const targets = [normalizeWs(def.spans.join(' ')), ...def.spans.map(normalizeWs)];
      let ok = false;
      for (let i = 0; i < spans.length && !ok; i++) {
        for (let len = 1; len <= 4 && i + len <= spans.length && !ok; len++) {
          if (targets.includes(normalizeWs(spans.slice(i, i + len).join(' ')))) ok = true;
        }
      }
      if (!ok) {
        out.fail('R5', `${req.doc}: ${req.title} does not quote ${strName} verbatim (expected "${normalizeWs(def.spans.join(' '))}" under the whitespace-normalized standard)`);
      } else {
        out.info('R5', `${req.doc}: ${strName} quoted verbatim`);
      }
    }
    for (const span of spans) {
      const n = normalizeWs(span);
      if (!MARKERS.some((mk) => n.includes(mk))) continue;
      if (!canon.units.has(n)) {
        out.fail('R5', `${req.doc}: quoted string invokes a data provider but is not a canonical ATTRIBUTIONS.md string: "${n}"`);
      }
    }
  }
}

function rule6Anchors(mdFiles, canon, out) {
  let refs = 0;
  for (const f of mdFiles) {
    for (const m of String(f.text ?? '').matchAll(/ATTRIBUTIONS\.md#([A-Za-z0-9._~-]+)/g)) {
      refs++;
      if (!canon.anchors.has(m[1])) {
        out.fail('R6', `${f.rel}: reference ATTRIBUTIONS.md#${m[1]} does not resolve to an explicit <a id="${m[1]}"> in ATTRIBUTIONS.md`);
      }
    }
  }
  const anchors = [...canon.anchors].sort().join(', ') || 'none';
  out.info('R6', `${refs} ATTRIBUTIONS.md# anchor reference(s) scanned across ${mdFiles.length} markdown file(s); explicit anchors: ${anchors}`);
  return refs;
}

// ------------------------------------------------- R7/R8 dependency ledger

/** The code-NN rows of THIRD_PARTY_ASSETS.md (asset rows in the same table are excluded), or null if the table is unavailable. */
function codeLedgerRows(tpa) {
  return tpa ? classifyRows(tpa.code).ledger.filter((r) => r.id.startsWith('code-')) : null;
}

/**
 * R7 — package.json dependency coverage. Every name in dependencies AND
 * devDependencies must match a code-NN row's name cell (rowNameMatches).
 * Transitive dependencies are NOT checked — npm resolves them, but the row
 * gate exists to force a deliberate adoption decision, and only direct
 * declarations are deliberate. Rows outside the code table (asset/data/gen)
 * never satisfy coverage.
 */
function rule7DependencyCoverage(pkgInfo, tpa, out) {
  const rows = codeLedgerRows(tpa);
  if (pkgInfo.error) out.fail('R7', `package.json could not be parsed: ${pkgInfo.error}`);
  if (rows === null || tpa.code.nameCol < 0) {
    out.fail(
      'R7',
      `THIRD_PARTY_ASSETS.md code table unavailable${tpa && tpa.code.nameCol < 0 ? ' (no "name" column)' : ''} — dependency coverage cannot be verified`,
    );
    return { packages: pkgInfo.names.size, covered: 0, uncovered: pkgInfo.error ? 0 : pkgInfo.names.size };
  }
  out.info(
    'R7',
    `dependency coverage: ${pkgInfo.names.size} declared package(s) (dependencies + devDependencies) vs ${rows.length} code-NN row(s); transitive dependencies are NOT checked`,
  );
  let covered = 0;
  let uncovered = 0;
  for (const [name, meta] of pkgInfo.names) {
    const hits = rows.filter((r) => rowNameMatches(r.cells[tpa.code.nameCol] ?? '', name));
    if (hits.length) {
      covered++;
      out.info('R7', `${name} (${meta.section}) → ${hits.map((r) => r.id).join(', ')}`);
      continue;
    }
    uncovered++;
    out.fail(
      'R7',
      `${name} (package.json ${meta.section}, spec "${meta.spec}"): no code-NN row in THIRD_PARTY_ASSETS.md — a dependency without a ledger row may not be committed (the gate, rule 1)`,
    );
  }
  return { packages: pkgInfo.names.size, covered, uncovered };
}

/**
 * R8 — version drift. For every declared package, each matching code row
 * whose pin cell carries a comparable version must equal the version resolved
 * in package-lock.json. An unpinned row defers with a warning (the row format
 * defers the exact pin to the first code commit); a mismatch fails, because
 * the recorded license verdict no longer covers what is actually installed
 * (the gate, rule 3).
 */
function rule8VersionDrift(pkgInfo, tpa, lockText, out) {
  const rows = codeLedgerRows(tpa);
  let lock = null;
  if (lockText === null || lockText === undefined) {
    out.fail('R8', 'package-lock.json not readable — version drift cannot be verified');
  } else {
    try {
      lock = JSON.parse(lockText);
    } catch (e) {
      out.fail('R8', `package-lock.json could not be parsed: ${e.message}`);
    }
  }
  if (pkgInfo.error) out.fail('R8', 'package.json could not be parsed — declared packages cannot be enumerated');
  if (rows === null || tpa.code.nameCol < 0 || tpa.code.pinCol < 0) {
    out.fail('R8', 'THIRD_PARTY_ASSETS.md code table unavailable (name/pin column missing) — version drift cannot be verified');
    return { compared: 0, deferred: 0, drifted: 0 };
  }
  let compared = 0;
  let deferred = 0;
  let drifted = 0;
  for (const [name] of pkgInfo.names) {
    const hits = rows.filter((r) => rowNameMatches(r.cells[tpa.code.nameCol] ?? '', name));
    if (!hits.length) continue; // R7 already reported the gap
    const resolved = lock ? resolvedLockVersion(lock, name) : null;
    if (!resolved) {
      out.fail('R8', `${name}: no resolved version in package-lock.json (expected packages["node_modules/${name}"].version)`);
      continue;
    }
    for (const r of hits) {
      const pinCell = stripMd(r.cells[tpa.code.pinCol] ?? '');
      const pin = parsePinVersion(pinCell);
      if (pin === null) {
        deferred++;
        out.warn(
          'R8',
          `${r.id} (${name}): pin cell carries no comparable version ("${normalizeWs(pinCell)}") — drift check deferred until the pin lands (pin at first code commit)`,
        );
        continue;
      }
      compared++;
      if (normalizeVersion(pin) !== normalizeVersion(resolved)) {
        drifted++;
        out.fail(
          'R8',
          `${r.id} (${name}): ledger pin ${pin} ≠ package-lock.json resolved ${resolved} — a verdict is valid only for the pinned version (the gate, rule 3): re-verify the upstream license at ${resolved} and update the row`,
        );
      } else {
        out.info('R8', `${r.id} (${name}): pin ${pin} = package-lock.json ${resolved}`);
      }
    }
  }
  out.info('R8', `version drift: ${compared} row pin(s) compared against package-lock.json, ${drifted} drifted, ${deferred} deferred (row unpinned)`);
  return { compared, deferred, drifted };
}

// ----------------------------------------------------------------- harness

/** Run every rule over the given document texts. */
export function checkAll({
  tpaMd,
  attributionsMd,
  dataSourcesMd,
  readmeMd,
  masterPromptMd,
  packageJsonText = null,
  lockfileText = null,
  mdFiles = [],
}) {
  const failures = [];
  const warnings = [];
  const infos = [];
  const out = {
    fail: (rule, text) => failures.push({ rule, text }),
    warn: (rule, text) => warnings.push({ rule, text }),
    info: (rule, text) => infos.push({ rule, text }),
  };

  const files = [
    { name: 'THIRD_PARTY_ASSETS.md', text: tpaMd },
    { name: 'ATTRIBUTIONS.md', text: attributionsMd },
    { name: 'DATA_SOURCES.md', text: dataSourcesMd },
    { name: 'README.md', text: readmeMd },
    { name: 'MASTER_PROMPT.md', text: masterPromptMd },
  ];
  rule0Files(files, out);

  const canon = parseAttributionStrings(attributionsMd ?? '');
  if (canon.strs.size === 0) out.fail('R0', 'ATTRIBUTIONS.md: no STR-* string sections found');

  let tpa = null;
  try {
    tpa = parseTpaTables(tpaMd ?? '');
  } catch (e) {
    out.fail('R1', e.message);
  }

  const counts = {
    rows: tpa ? rule1LedgerRows(tpa, canon, out) : 0,
    blocked: tpa ? rule2BlockedRefusals(tpa, out) : 0,
    gen: tpa ? rule3GeneratedAssets(tpa, out) : 0,
    provenance: rule4DataSources(dataSourcesMd ?? '', out),
  };
  rule5DocQuotes(readmeMd ?? '', masterPromptMd ?? '', canon, out);
  counts.anchorRefs = rule6Anchors(mdFiles, canon, out);
  const pkgInfo = parsePackageJson(packageJsonText);
  counts.coverage = rule7DependencyCoverage(pkgInfo, tpa, out);
  counts.drift = rule8VersionDrift(pkgInfo, tpa, lockfileText, out);

  const rules = [
    { id: 'R0', name: 'required documents present' },
    { id: 'R1', name: 'ledger rows: id + license + attribution cell (y resolves, n explains)' },
    { id: 'R2', name: 'blocked-verdict refusal retained (asset-01)' },
    { id: 'R3', name: 'generated assets: AI columns present and filled' },
    { id: 'R4', name: 'DATA_SOURCES.md provenance rows: source + license + pin' },
    { id: 'R5', name: 'doc-quoted strings byte-match ATTRIBUTIONS.md (README + MASTER_PROMPT §44)' },
    { id: 'R6', name: 'ATTRIBUTIONS.md# anchor references resolve' },
    { id: 'R7', name: 'package.json dependencies covered by code-NN ledger rows (transitive deps not checked)' },
    { id: 'R8', name: 'ledger pin = package-lock.json resolved version (no drift)' },
  ].map((r) => ({
    ...r,
    status: failures.some((f) => f.rule === r.id) ? 'fail' : warnings.some((w) => w.rule === r.id) ? 'warn' : 'pass',
    details: [
      ...infos.filter((i) => i.rule === r.id).map((i) => ({ level: 'info', text: i.text })),
      ...warnings.filter((w) => w.rule === r.id).map((w) => ({ level: 'warn', text: w.text })),
      ...failures.filter((f) => f.rule === r.id).map((f) => ({ level: 'fail', text: f.text })),
    ],
  }));

  return { rules, failures, warnings, counts, failed: failures.length > 0 };
}

// -------------------------------------------------------------------- main

export function listMarkdownFiles(root) {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.venv']);
  const out = [];
  const visit = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) visit(join(dir, e.name), childRel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push({ abs: join(dir, e.name), rel: childRel });
      }
    }
  };
  visit(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function printReport(res, root) {
  const lines = [];
  lines.push('kwetu license-ledger check — tools/ledger/check.mjs (ROADMAP.md S0.4)');
  lines.push(`root: ${root}`);
  lines.push('');
  for (const r of res.rules) {
    const tag = r.status === 'fail' ? 'FAIL' : r.status === 'warn' ? 'PASS (warnings)' : 'PASS';
    lines.push(`  ${r.id}  ${r.name}`);
    lines.push(`      -> ${tag}`);
    for (const d of r.details) {
      const mark = d.level === 'fail' ? '  x ' : d.level === 'warn' ? '  ! ' : '    ';
      lines.push(`${mark}${d.text}`);
    }
  }
  lines.push('');
  lines.push(
    `RESULT: ${res.failed ? 'FAIL' : 'PASS'} — ${res.rules.filter((r) => r.status === 'fail').length} rule(s) failed, ` +
      `${res.failures.length} violation(s), ${res.warnings.length} warning(s)`,
  );
  return lines.join('\n');
}

/** Gather the repo documents the checker reads (shared by main() and tools/ledger/report.mjs). */
export function collectRepoInputs(root = repoRoot()) {
  const read = (name) => {
    try {
      return readFileSync(join(root, name), 'utf8');
    } catch {
      return null;
    }
  };
  const mdFiles = listMarkdownFiles(root).map((f) => ({ rel: f.rel, text: readFileSync(f.abs, 'utf8') }));
  return {
    tpaMd: read('THIRD_PARTY_ASSETS.md'),
    attributionsMd: read('ATTRIBUTIONS.md'),
    dataSourcesMd: read('DATA_SOURCES.md'),
    readmeMd: read('README.md'),
    masterPromptMd: read('MASTER_PROMPT.md'),
    packageJsonText: read('package.json'),
    lockfileText: read('package-lock.json'),
    mdFiles,
  };
}

export function main() {
  const root = repoRoot();
  let res;
  try {
    res = checkAll(collectRepoInputs(root));
  } catch (e) {
    console.error(`structural error: ${e.message}`);
    return 2;
  }
  console.log(printReport(res, root));
  return res.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
