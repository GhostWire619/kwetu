// tools/ledger/check.test.mjs — tests for the S0.4 ledger checker itself.
//
// The fixtures are in-memory "temp fixture tables": minimal-but-complete doc
// sets fed to checkAll() (the same entry point main() uses), then mutated per
// case. The base fixture passes; every mutation must fail exactly the rule it
// targets. Mandated cases: a fixture row with a missing attribution cell fails,
// and a whitespace-mangled canonical string still passes the normalized
// compare (ATTRIBUTIONS.md preamble standard).

import { describe, expect, it } from 'vitest';
import { checkAll, evalAttributionCell, normalizeWs, parseAttributionStrings } from './check.mjs';

// ------------------------------------------------------------------ fixtures

const ATTRIB = `# ATTRIBUTIONS.md

<a id="osm"></a>

### STR-OSM — OpenStreetMap

- String (verbatim): \`© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0\`

<a id="geofabrik"></a>

### STR-GEOFABRIK — Geofabrik

- String (verbatim): \`Data processed by Geofabrik GmbH\`

<a id="copernicus-dem"></a>

### STR-COPERNICUS — Copernicus

- String (verbatim): \`Contains modified Copernicus data [year]\`

<a id="nasa"></a>

### STR-NASA — NASA / USGS data acknowledgment

- String (verbatim): \`Terrain and imagery data courtesy of NASA and the U.S. Geological Survey.\`
  \`Kwetu is not affiliated with, endorsed by, or sponsored by NASA or the U.S. Geological Survey.\`

<a id="foo"></a>

### STR-FOO — Fixture

- String (verbatim): \`Alpha  Beta   Gamma Delta Epsilon Zeta.\`
`;

const CODE_ROWS = [
  '| code-01 | code | widget-lib | MIT | demo | 1.0.0 | n — license text retained | 2026-09-05 — registry packument |',
  '| asset-01 | asset library | Quaternius | **NO — relicensed away from CC0** | none — prototype-only | — | n/a — blocked verdict | 2026-09-05 — license sweep |',
].join('\n');

const CODE_TABLE = `## Code dependencies

| id | kind | name | license | how used | pin | attribution string required | verified |
|---|---|---|---|---|---|---|---|
${CODE_ROWS}
`;

const DATASET_ROWS = [
  '| data-01 | OSM planet extract | ODbL 1.0 | STR-OSM + STR-GEOFABRIK | tiles',
  '| data-02 | Copernicus DEM | custom terms — no SPDX | STR-COPERNICUS `Contains modified Copernicus data [year]` | DEM',
  '| data-03 | GeoNames | CC BY 4.0 | y — attribution string to be added with the first GeoNames row | gazetteer',
].map((r) => `${r} |`).join('\n');

const DATASET_TABLE = `## Datasets

| id | dataset | license | attribution string | notes |
|---|---|---|---|---|
${DATASET_ROWS}
`;

const GEN_TABLE = `## Generated assets

| id | asset | model + version | prompt (ref) | generated | output license | files/sha256 |
|---|---|---|---|---|---|---|
| *(none yet)* | | | | | | |
`;

const TPA = `# THIRD_PARTY_ASSETS.md\n\n${CODE_TABLE}\n${DATASET_TABLE}\n${GEN_TABLE}\n`;

const DATA_SOURCES = `# DATA_SOURCES.md

## The provenance table

### Format

| dataset | version/date pinned | source URL | license | exact attribution string | derived artifacts | build step | refresh cadence |
|---|---|---|---|---|---|---|---|

### Filled example row

| dataset | version/date pinned | source URL | license | exact attribution string | derived artifacts | build step | refresh cadence |
|---|---|---|---|---|---|---|---|
| OSM planet extract — Geofabrik Tanzania | the .pbf's own timestamp, first pin 2026-09 | https://download.geofabrik.de/africa/tanzania-latest.osm.pbf | ODbL 1.0 | © OpenStreetMap contributors — canonical copy: ATTRIBUTIONS.md#osm | per-region pmtiles | pinned fetch script | daily upstream |
`;

const README = `# Kwetu

## Data and assets

The core strings, verbatim:

- \`© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0\`
- \`Contains modified Copernicus data [year]\`
- \`Terrain and imagery data courtesy of NASA and the U.S. Geological Survey.\` —
  \`Kwetu is not affiliated with, endorsed by, or sponsored by NASA or the U.S. Geological Survey.\`

## Non-goals

The rest of the README.
`;

const MASTER_PROMPT = `# MASTER_PROMPT

## 44. Attribution

- In-game credits, verbatim: \`© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0\` (the full STR-OSM
  sentence); \`Data processed by Geofabrik GmbH\`; the Copernicus string \`Contains modified Copernicus data [year]\`.

## 45. Next

A later section.
`;

const MD_FILES = (extra = []) => [
  { rel: 'ATTRIBUTIONS.md', text: ATTRIB },
  { rel: 'THIRD_PARTY_ASSETS.md', text: TPA },
  { rel: 'DATA_SOURCES.md', text: DATA_SOURCES },
  { rel: 'README.md', text: README },
  { rel: 'MASTER_PROMPT.md', text: MASTER_PROMPT },
  ...extra,
];

const BASE = { tpaMd: TPA, attributionsMd: ATTRIB, dataSourcesMd: DATA_SOURCES, readmeMd: README, masterPromptMd: MASTER_PROMPT };

function run(overrides = {}, extraFiles = []) {
  return checkAll({ ...BASE, ...overrides, mdFiles: MD_FILES(extraFiles) });
}

const rule = (res, id) => res.rules.find((r) => r.id === id);
const texts = (res, id, level) =>
  rule(res, id).details.filter((d) => (level ? d.level === level : true)).map((d) => d.text);

// --------------------------------------------------------------------- tests

describe('whitespace-normalized standard', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeWs('  ©  OpenStreetMap \n\t contributors,   ODbL 1.0 ')).toBe(
      '© OpenStreetMap contributors, ODbL 1.0',
    );
  });

  it('parses STR sections, joining wrapped two-sentence strings (STR-NASA)', () => {
    const canon = parseAttributionStrings(ATTRIB);
    expect([...canon.strs.keys()].sort()).toEqual(['STR-COPERNICUS', 'STR-FOO', 'STR-GEOFABRIK', 'STR-NASA', 'STR-OSM']);
    const nasa = canon.strs.get('STR-NASA').spans;
    expect(nasa).toHaveLength(2);
    expect(canon.units.has(normalizeWs(nasa.join(' ')))).toBe(true);
    expect(canon.anchors.has('osm')).toBe(true);
  });
});

describe('base fixture', () => {
  it('passes with only the recorded-deferral warnings', () => {
    const res = run();
    expect(res.failures).toEqual([]);
    expect(rule(res, 'R1').status).not.toBe('fail');
    expect(texts(res, 'R1', 'warn')).toHaveLength(1); // data-03's deferred y
    expect(res.failed).toBe(false);
  });
});

describe('R1 — attribution cells', () => {
  it('fails a fixture table row with a missing attribution cell', () => {
    const tpa = TPA.replace(
      '| data-01 | OSM planet extract | ODbL 1.0 | STR-OSM + STR-GEOFABRIK | tiles |',
      '| data-01 | OSM planet extract | ODbL 1.0 |  | tiles |',
    );
    const res = run({ tpaMd: tpa });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail')).toEqual(expect.arrayContaining(['data-01: attribution cell is empty']));
  });

  it('fails an n cell that carries no reason', () => {
    const res = run({ tpaMd: TPA.replace('n — license text retained', 'n') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/'n' without a recorded reason/);
  });

  it('fails a y cell pointing at an STR that does not exist in ATTRIBUTIONS.md', () => {
    const res = run({ tpaMd: TPA.replace('STR-OSM + STR-GEOFABRIK', 'STR-NOPE') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/STR reference not in ATTRIBUTIONS\.md: STR-NOPE/);
  });

  it('fails a y cell with neither a resolvable string nor a recorded deferral', () => {
    const res = run({ tpaMd: TPA.replace(
      'y — attribution string to be added with the first GeoNames row',
      'y — someday',
    ) });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/'y' with no resolvable string and no recorded deferral/);
  });

  it('warns (does not fail) on the docs\' own recorded deferral', () => {
    const res = run();
    expect(texts(res, 'R1', 'warn')[0]).toMatch(/data-03: attribution y deferred/);
  });

  it('fails a quoted string that is not canonical even when an STR name is present', () => {
    const res = run({ tpaMd: TPA.replace(
      'STR-COPERNICUS `Contains modified Copernicus data [year]`',
      'STR-COPERNICUS `Contains modified Copernicus data 2025`',
    ) });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/quoted string not found in ATTRIBUTIONS\.md/);
  });

  it('fails a row with a malformed ledger id', () => {
    const res = run({ tpaMd: TPA.replace('| code-01 |', '| code1 |') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/malformed\/missing ledger id/);
  });
});

describe('R2 — blocked-verdict refusal (asset-01)', () => {
  it('passes while the refusal row is intact', () => {
    const res = run();
    expect(texts(res, 'R2', 'info')).toEqual(['asset-01: refusal retained — NO — relicensed away from CC0']);
  });

  it('fails when the asset-01 row is removed', () => {
    const res = run({ tpaMd: TPA.replace(CODE_ROWS.split('\n')[1] + '\n', '') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R2', 'fail').join('\n')).toMatch(/asset-01 not found/);
  });

  it('fails when the refusal reason is stripped from the license cell', () => {
    const res = run({ tpaMd: TPA.replace('**NO — relicensed away from CC0**', '**NO**') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R2', 'fail').join('\n')).toMatch(/blocked verdict without a recorded refusal reason/);
  });

  it('fails when the attribution cell no longer says "blocked"', () => {
    const res = run({ tpaMd: TPA.replace('n/a — blocked verdict', 'n — license text retained') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R2', 'fail').join('\n')).toMatch(/"n\/a — blocked verdict"/);
  });
});

describe('R3 — generated assets', () => {
  it('detects the AI columns and passes vacuously with zero gen rows', () => {
    const res = run();
    expect(texts(res, 'R3', 'info')).toEqual(
      expect.arrayContaining([expect.stringMatching(/columns detected in header/), expect.stringMatching(/passes vacuously/)]),
    );
  });

  it('fails a gen row whose prompt cell is empty', () => {
    const tpa = TPA.replace('| *(none yet)* | | | | | | |',
      '| *(none yet)* | | | | | | |\n| gen-01 | crater.glb | TRELLIS 1.0 (MIT) |  | 2026-09-05 | Kwetu content | sha256:abc |');
    const res = run({ tpaMd: tpa });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R3', 'fail')).toEqual(expect.arrayContaining(['gen-01: prompt cell is empty — the prompt is recorded in full or by reference']));
  });

  it('fails when the prompt column is missing from the header', () => {
    const tpa = TPA.replace(
      '| id | asset | model + version | prompt (ref) | generated | output license | files/sha256 |',
      '| id | asset | model + version | generated | output license | files/sha256 |',
    );
    const res = run({ tpaMd: tpa });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R3', 'fail').join('\n')).toMatch(/no "prompt" column/);
  });

  it('fails when the whole generated-assets table is gone', () => {
    const res = run({ tpaMd: TPA.replace(GEN_TABLE, '') });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R1', 'fail').join('\n')).toMatch(/generated-assets table/);
  });
});

describe('R4 — DATA_SOURCES provenance rows', () => {
  it('checks the filled row', () => {
    const res = run();
    expect(texts(res, 'R4', 'info')).toEqual(['DATA_SOURCES.md: 1 provenance row(s) checked (source + license + pin)']);
  });

  it('fails a row with an empty license cell', () => {
    const ds = DATA_SOURCES.replace(
      '| ODbL 1.0 | © OpenStreetMap contributors — canonical copy: ATTRIBUTIONS.md#osm |',
      '|  | © OpenStreetMap contributors — canonical copy: ATTRIBUTIONS.md#osm |',
    );
    const res = run({ dataSourcesMd: ds });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R4', 'fail').join('\n')).toMatch(/license cell is empty/);
  });
});

describe('R5 — doc-quoted strings vs canonical strings', () => {
  it('passes a whitespace-mangled quote (the normalized compare)', () => {
    const readme = README.replace(
      '- `© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0`',
      '- `©  OpenStreetMap   contributors,\n  under the Open Database License (ODbL) 1.0`',
    );
    const res = run({ readmeMd: readme });
    expect(res.failed).toBe(false);
    expect(texts(res, 'R5', 'info')).toEqual(expect.arrayContaining(['README.md: STR-OSM quoted verbatim']));
  });

  it('passes STR-NASA delivered as two adjacent spans with a joiner', () => {
    const res = run();
    expect(texts(res, 'R5', 'info')).toEqual(expect.arrayContaining(['README.md: STR-NASA quoted verbatim']));
  });

  it('fails a quote that lost part of the string', () => {
    const readme = README.replace(
      '`© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0`',
      '`© OpenStreetMap contributors, under the Open Database License`',
    );
    const res = run({ readmeMd: readme });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R5', 'fail').join('\n')).toMatch(/does not quote STR-OSM verbatim/);
    expect(texts(res, 'R5', 'fail').join('\n')).toMatch(/not a canonical ATTRIBUTIONS\.md string/);
  });

  it('fails when a required section drops a string entirely', () => {
    const readme = README.replace('\n- `Contains modified Copernicus data [year]`', '');
    const res = run({ readmeMd: readme });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R5', 'fail').join('\n')).toMatch(/does not quote STR-COPERNICUS verbatim/);
  });

  it('fails when the whole doc-footer section is missing', () => {
    const res = run({ readmeMd: '# Kwetu\n\n## Non-goals\n\nNothing.\n' });
    expect(res.failed).toBe(true);
    expect(texts(res, 'R5', 'fail').join('\n')).toMatch(/section not found/);
  });
});

describe('R6 — ATTRIBUTIONS.md# anchors', () => {
  it('passes when references resolve to explicit anchors', () => {
    const res = run();
    expect(res.failed).toBe(false);
    expect(texts(res, 'R6', 'info')[0]).toMatch(/1 ATTRIBUTIONS\.md# anchor reference\(s\)/);
  });

  it('fails a reference with no matching explicit anchor', () => {
    const res = run({}, [{ rel: 'docs/notes.md', text: 'credit goes to ATTRIBUTIONS.md#geonames for this one.\n' }]);
    expect(res.failed).toBe(true);
    expect(texts(res, 'R6', 'fail')).toEqual([
      'docs/notes.md: reference ATTRIBUTIONS.md#geonames does not resolve to an explicit <a id="geonames"> in ATTRIBUTIONS.md',
    ]);
  });
});

describe('evalAttributionCell (unit)', () => {
  const canon = parseAttributionStrings(ATTRIB);
  it('accepts n with reason, n/a blocked, resolved STR, and resolved verbatim', () => {
    expect(evalAttributionCell('n — license text retained', canon).verdict).toBe('ok');
    expect(evalAttributionCell('n/a — blocked verdict', canon).verdict).toBe('ok');
    expect(evalAttributionCell('STR-OSM — the ODbL credit', canon).verdict).toBe('ok');
    expect(evalAttributionCell('y — `Contains   modified Copernicus data [year]`', canon).verdict).toBe('ok');
  });
  it('rejects empty, bare n, unknown STR, non-canonical quote, bare y, and prose', () => {
    expect(evalAttributionCell('', canon).verdict).toBe('fail');
    expect(evalAttributionCell('n', canon).verdict).toBe('fail');
    expect(evalAttributionCell('STR-MISSING', canon).verdict).toBe('fail');
    expect(evalAttributionCell('`some paraphrased credit`', canon).verdict).toBe('fail');
    expect(evalAttributionCell('y', canon).verdict).toBe('fail');
    expect(evalAttributionCell('maybe later', canon).verdict).toBe('fail');
  });
});
