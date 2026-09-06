# ADR-005: S0.4 — the license-ledger CI check (R0–R8) and the dependency gate

- **Status**: accepted (ratified 2026-09-06 by the orchestrator landing pass: the checker is implemented, self-tested (45/45) and green (PASS, 0 violations); the delatin double row code-11/code-30 consolidated 2026-09-06; data-06/data-07 remain sanctioned deferrals landing with first use. The hosted-CI-runner open item is owned by the ratified ADR-011 Decision 6 deferral, not by this ADR's mechanism — the gate mechanism itself is complete and enforced locally as `check:ledger`)
- **Date**: 2026-09-06
- **Deciders**: S0.4 keystone spike (orchestrated Phase-0 agent wave). Checker, self-tests and report generator in `tools/ledger/` (`check.mjs`, `check.test.mjs`, `report.mjs`, `report.json`); host: Windows 11 dev box, Node v24.13.0. THIRD_PARTY_ASSETS.md rows and package.json remain orchestrator-owned and were updated by the orchestrator during this spike (see Evidence D).

## Context

CLAUDE.md's hard invariant — "Never add a dependency without a THIRD_PARTY_ASSETS.md row, with the LICENSE fetched at the pinned commit" — and THIRD_PARTY_ASSETS.md's own gate ("an asset without a row may not be committed"; "a row without an attribution string fails the build"; "a verdict is valid only for the pinned commit") were, until tonight, review-discipline only. ROADMAP §5 S0.4 requires a mechanical check: "a CI job fails the build on any dependency without a ledger row". Risk register #8 records the consequence of skipping it: a Havok-class license trap ships, and an unledgered dataset breaches the ODbL boundary.

S0.4's exit criterion also demands the attribution-string half: a `y` in a row's "attribution string required" cell must point at an exact string in ATTRIBUTIONS.md, under the whitespace-normalized standard defined in the ATTRIBUTIONS.md preamble (trimmed; runs of whitespace collapsed to a single space; any other difference fails).

## Evidence

All measurements 2026-09-06 on the dev box, regenerable via `node tools/ledger/report.mjs` → `tools/ledger/report.json` (Node builtins only).

**A — the checker as it stands.** Nine rules, R0–R8, in `tools/ledger/check.mjs` (project code, zero dependencies — Node builtins only, so the checker itself needs no ledger row). Exit codes: 0 = pass, 1 = violation, 2 = structural error. 45 self-tests (29 pre-existing + 16 added tonight for R7/R8 and their matcher units) all pass [MEASURED 2026-09-06, `npx vitest run tools/ledger` — 45 passed / 0 failed; `report.json` `selfTests`]. A full run over the real repo documents takes 97.1 ms [MEASURED 2026-09-06, `process.hrtime.bigint()` around `checkAll(collectRepoInputs(root))`, `report.json` `checker.run.durationMs`], so pre-commit use costs nothing.

Baseline before tonight's R7/R8 work: PASS, 0 violations, 2 warnings (data-06, data-07) [MEASURED 2026-09-06, `node tools/ledger/check.mjs` at session start]. After R7/R8: PASS, 0 violations, 3 warnings, exit 0 [MEASURED 2026-09-06, `node tools/ledger/check.mjs`; `report.json` `checker.run`].

**B — what each rule actually checks** (rule sources quoted from the doc set; verified against the source, not the comments):

| Rule | Checks | Source |
|---|---|---|
| R0 | The five documents (THIRD_PARTY_ASSETS.md, ATTRIBUTIONS.md, DATA_SOURCES.md, README.md, MASTER_PROMPT.md) exist, are non-empty, and ATTRIBUTIONS.md contains at least one `STR-*` section. | the gate's own inputs |
| R1 | Every ledger row (id matching `code-NN`/`asset-NN`/`data-NN`/`gen-NN`) in the code/asset, dataset and generated-assets tables carries a non-empty license cell and — for code/asset and dataset tables — an evaluable attribution cell (see Decision 2). Malformed ids, empty license cells and unresolvable `y` cells fail; the docs' own named deferrals warn. | THIRD_PARTY_ASSETS.md "The gate" rule 2 + Row format; ATTRIBUTIONS.md CI rule |
| R2 | A blocked verdict keeps its recorded refusal: a license cell beginning `NO` must carry a reason (≥ 3 alphanumeric characters after the prefix), its attribution cell must still say "blocked", and the asset-01 Quaternius row must still exist as a blocked-verdict row — removal or alteration of the recorded refusal fails. | THIRD_PARTY_ASSETS.md note 4 |
| R3 | The generated-assets table header carries model / version / prompt / generated-date columns, and every `gen-NN` row fills them (date in ISO 8601, else warned). Passes vacuously while the table is empty. | THIRD_PARTY_ASSETS.md §Generated assets rule 1 |
| R4 | Every non-empty DATA_SOURCES.md provenance row pins version/date, source URL and license (missing attribution-string / build-step / refresh-cadence cells warn). | DATA_SOURCES.md provenance table |
| R5 | README.md "Data and assets" quotes STR-OSM, STR-COPERNICUS, STR-NASA and MASTER_PROMPT.md §44 quotes STR-OSM, STR-GEOFABRIK, STR-COPERNICUS verbatim under the whitespace-normalized standard (STR-NASA's two-sentence form matches as two adjacent spans), and any quoted span invoking a data-provider marker is a canonical string. | ATTRIBUTIONS.md §Docs and repo attribution; MASTER_PROMPT.md §44 |
| R6 | Every `ATTRIBUTIONS.md#<slug>` link in any `*.md` resolves to an explicit `<a id="...">` anchor in ATTRIBUTIONS.md. | DATA_SOURCES.md §Format column notes |
| R7 | Dependency coverage — see Decision 3. | CLAUDE.md "Never add a dependency without a THIRD_PARTY_ASSETS.md row"; the gate, rule 1 |
| R8 | Version drift — see Decision 4. | the gate, rule 3 ("a verdict is valid only for the pinned commit") |

**C — dependency coverage and version drift measured tonight.** package.json declares 15 packages (6 dependencies + 9 devDependencies) [MEASURED 2026-09-06, package.json]. THIRD_PARTY_ASSETS.md carries 31 `code-NN` rows [MEASURED 2026-09-06, checker R7 info]. R7 covers 15/15 declared packages; R8 compares 15 row pins against the lockfile-resolved versions (`packages["node_modules/<name>"].version`, lockfileVersion-1 `dependencies` fallback) with 0 drifted and 1 deferred — code-11 (delatin) still carries its `[PLACEHOLDER — pin at first code commit]` pin and is superseded by code-30 (delatin **0.2.0**, which matches the lockfile) [MEASURED 2026-09-06, `report.json` `dependencyCoverage` / `versionDrift`]. Licenses re-verified tonight from the shipped LICENSE files: @playwright/test 1.63.0 Apache-2.0, i18next-conv 17.0.0 MIT, delatin 0.2.0 ISC, geotiff 3.0.5 MIT [MEASURED 2026-09-06, node_modules LICENSE inspection — consistent with rows code-28/29/30/31].

**D — concurrency note (honest record).** The task anticipated that the four deps added tonight (@heroiclabs/nakama-js, livekit-client, @playwright/test, i18next-conv) might lack rows and that R7 might fire. While this spike ran, the orchestrator landed rows code-28 (@playwright/test) and code-29 (i18next-conv), pinned code-04/code-05, and added code-30/code-31 (delatin, geotiff) together with the matching package.json entries. The "ledger rows owed" contingency therefore never fired; had it fired, R7 would have exited 1 naming the exact uncovered packages (self-tested). Residual inconsistency from that landing: delatin is now double-rowed (code-11 placeholder pin + code-30 real pin) — see open items.

## Decision

1. **Adopt `tools/ledger/check.mjs` as the mechanical ledger gate, rules R0–R8, numbering fixed.** New rules append as R9+ (never renumber — R-ids are cited by docs and tests). CI runs it as `node tools/ledger/check.mjs` (wired as the `check:ledger` npm script; CLAUDE.md's commands table documents "run it before any commit"). Exit 0 commits may proceed; exit 1 blocks the commit until the named violations are fixed in THIRD_PARTY_ASSETS.md / DATA_SOURCES.md / package.json; exit 2 (structural — unreadable tree, checker bug) also blocks. When S0.11 lands the hosted runner, this is a CI job step with the exit code deciding.

2. **Attribution-cell interpretation (R1).** A cell is evaluable iff one of: (a) `n`/`n/a` with a recorded reason (≥ 3 alphanumeric characters after the prefix) — no string owed; (b) it names an `STR-*` string defined in ATTRIBUTIONS.md, and/or quotes a span that byte-matches a canonical span or joined string under the whitespace-normalized standard (normalize = trim + collapse `\s+` runs to single spaces; any other difference fails) — the string is owed and canonical; (c) it begins with `y` and carries the docs' own named-deferral language ("to be added", "lands in the CI-generated table", "pending", "at pin", "not yet", "until the", "deferred") — sanctioned debt, warned, never silent; (d) for a blocked-verdict row, `n/a — blocked verdict` (R2). Anything else — empty cell, bare `y`, bare `n`, unknown STR name, paraphrased quote — fails.

3. **R7 dependency coverage — the "no row → no commit" rule, mechanized.** Every name in package.json `dependencies` AND `devDependencies` must match the name cell of a `code-NN` row. Matching is boundary-aware because real name cells carry annotations: the match may not continue a longer name ("vite" ≠ "vitest", "i18next" ≠ "i18next-conv", unscoped "three" ≠ "@types/three"), while annotation-bearing cells match ("three.js", "@heroiclabs/nakama-js (npm scope; …)", "meshoptimizer / gltfpack"). Rows outside the code table (asset/data/gen) never satisfy coverage. **Transitive dependencies are NOT checked** — npm resolves them, but the row gate exists to force a deliberate adoption decision, and only direct declarations are deliberate; a transitive dep whose license matters must be promoted to a direct dependency (and then rowed). An uncovered package fails with its name, section and spec — the fix is a ledger row, not a checker edit.

4. **R8 version drift — "a verdict is valid only for the pinned version", mechanized.** For each declared package, every matching code row whose pin cell contains a comparable version must equal the version resolved in package-lock.json. The comparison is **ledger pin vs lockfile resolution** (not the package.json range — npm owns that consistency). A mismatch fails and the message demands the gate-rule-3 action: re-verify the upstream license at the resolved version, then update the row. A row whose pin is still `[PLACEHOLDER — pin at first code commit]` defers with a warning — the row format defers the exact pin to the first code commit — so the deferral is visible and self-expiring: the moment a version is written, R8 holds it to the lockfile.

5. **The gate rule stands as documented:** no THIRD_PARTY_ASSETS.md row → no commit. R7/R8 mechanize the dependency half. The arbitrary-asset half (a binary sneaked into the tree without a row) stays review + process discipline; mechanically inventorying arbitrary binary assets is out of scope for this checker and must not be presumed from its exit code.

6. **Evidence regenerability:** `node tools/ledger/report.mjs` rewrites `tools/ledger/report.json` (rule inventory, run verdict, self-test count measured by running vitest, per-package coverage and drift tables, host). The ADR's numbers are reproducible from it.

## Consequences

**Easier:** a dependency cannot land unledgered, a pin cannot drift from the installed tree, and an attribution string cannot drift from ATTRIBUTIONS.md without a build failure; the Quaternius refusal survives staff turnover (R2). At 97.1 ms per run [MEASURED — see Evidence A], it can run before every commit and inside CI without costing anything.

**Harder:** every `npm install <pkg>` now carries a same-change obligation — code-NN row with verified license, correct name spelling (boundary-matchable), pin that equals the lockfile resolution — and every version bump re-opens the license verdict (R8 enforces the pin side; gate rule 3 the verification side). Ledger maintenance is no longer deferrable to "later cleanup".

**Locks out / accepted gaps:** transitive dependencies are unpoliced by design (Decision 3); the arbitrary-asset half of the gate is not mechanized (Decision 5); R8 cannot verify a license at a commit hash — it verifies version equality and relies on the row's recorded verification method; the checker trusts the repo's own package.json/package-lock.json (no registry re-query — that remains the verification discipline at pin time).

**ROADMAP §Budgets rows filled: none** — per ROADMAP §5, S0.4 fills no budget rows directly; it gates every dataset-phase row in §3.

**Open items gating acceptance of S0.4:**
1. Wire `check:ledger` into the hosted CI runner when S0.11 lands it (the npm script exists; the runner does not yet).
2. data-06 (GeoNames) and data-07 (Hipparcos) attribution strings are sanctioned deferrals — land the STR-* strings in ATTRIBUTIONS.md and the rows' final cells.
3. Consolidate the double delatin rows: code-11's placeholder pin is superseded by code-30 (0.2.0) and generates the checker's one standing R8 deferral warning; delete or complete code-11 when code-30 is confirmed.
4. code-02 (@dimforge/rapier3d-compat) dual-license note and code-20 (KTX-Software 4.x) exact pin remain recorded-pending per the ledger's own notes; both resolve at first code commit, after which R8 holds them.
5. ADR status flips to accepted once 1–2 land and the checker stays green.
