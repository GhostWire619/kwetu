// tools/ledger/report.mjs — regenerates tools/ledger/report.json (S0.4 evidence).
//
// Every figure the ADR-005 Evidence section cites is recomputed here from the
// live repo state: the rule inventory with per-rule verdicts, the checker run
// (violations + warnings), the self-test count (by actually running vitest),
// the dependency-coverage table (package.json vs THIRD_PARTY_ASSETS.md) and
// the version-drift table (ledger pins vs package-lock.json resolutions).
// Node builtins only. Run: node tools/ledger/report.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  checkAll,
  classifyRows,
  collectRepoInputs,
  parsePackageJson,
  parsePinVersion,
  parseTpaTables,
  repoRoot,
  resolvedLockVersion,
  rowNameMatches,
} from './check.mjs';

const root = repoRoot();
const here = dirname(fileURLToPath(import.meta.url));

// ---- the checker run over the real repo documents --------------------------

const t0 = process.hrtime.bigint();
const inputs = collectRepoInputs(root);
const res = checkAll(inputs);
const checkMs = Number(process.hrtime.bigint() - t0) / 1e6;

// ---- dependency coverage + version drift tables ----------------------------

const pkgInfo = parsePackageJson(inputs.packageJsonText);
const lock = JSON.parse(inputs.lockfileText);
const tpa = parseTpaTables(inputs.tpaMd);
const codeRows = classifyRows(tpa.code).ledger.filter((r) => r.id.startsWith('code-'));

const packages = [...pkgInfo.names.entries()].map(([name, meta]) => {
  const hits = codeRows.filter((r) => rowNameMatches(r.cells[tpa.code.nameCol] ?? '', name));
  const resolved = resolvedLockVersion(lock, name);
  return {
    name,
    section: meta.section,
    packageJsonSpec: meta.spec,
    rows: hits.map((r) => r.id),
    lockfileResolved: resolved,
    checks: hits.map((r) => {
      const pin = parsePinVersion(r.cells[tpa.code.pinCol] ?? '');
      return {
        row: r.id,
        ledgerPin: pin,
        lockfileResolved: resolved,
        verdict: pin === null ? 'deferred (row unpinned)' : pin === resolved ? 'match' : 'DRIFT',
      };
    }),
  };
});

const allChecks = packages.flatMap((p) => p.checks);
const uncovered = packages.filter((p) => p.rows.length === 0).map((p) => p.name);
const drifted = allChecks.filter((c) => c.verdict === 'DRIFT');

// ---- self-test count (measured by running the runner) -----------------------

function countSelfTests() {
  const fallback = (why) => {
    const src = readFileSync(join(root, 'tools', 'ledger', 'check.test.mjs'), 'utf8');
    return {
      count: (src.match(/^\s*(?:it|test)\(/gm) ?? []).length,
      method: `static count of it()/test() calls in tools/ledger/check.test.mjs (vitest run unavailable: ${why})`,
    };
  };
  const outputFile = join(root, 'tools', 'ledger', 'vitest-run.json');
  const vitestMjs = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  let r;
  try {
    // vitest 5's json reporter writes a file (--outputFile), not stdout; run the
    // bin directly under node so no npx/shell layer is involved.
    r = spawnSync(process.execPath, [vitestMjs, 'run', 'tools/ledger/check.test.mjs', '--reporter=json', `--outputFile=${outputFile}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 240000,
    });
  } catch (e) {
    return fallback(e.message);
  }
  try {
    const j = JSON.parse(readFileSync(outputFile, 'utf8'));
    if (typeof j.numTotalTests === 'number') {
      return {
        count: j.numTotalTests,
        passed: j.numPassedTests,
        failed: j.numFailedTests,
        success: j.success === true,
        method: 'node node_modules/vitest/vitest.mjs run tools/ledger/check.test.mjs --reporter=json (vitest-run.json, deleted after reading)',
      };
    }
    return fallback('reporter output had no numTotalTests');
  } catch {
    return fallback(`exit ${r?.status}`);
  } finally {
    try {
      unlinkSync(outputFile);
    } catch {
      /* nothing to clean up */
    }
  }
}

// ---- write ------------------------------------------------------------------

const report = {
  spike: 'S0.4',
  title: 'license-ledger CI check — rule inventory, dependency coverage, version drift',
  generated: new Date().toLocaleString('sv-SE').replace(' ', 'T'),
  generatedUtc: new Date().toISOString(),
  host: {
    platform: process.platform,
    osRelease: os.release(),
    node: process.version,
    totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
  },
  checker: {
    file: 'tools/ledger/check.mjs',
    selfTestsFile: 'tools/ledger/check.test.mjs',
    exitCodes: { 0: 'pass', 1: 'violation', 2: 'structural error' },
    rules: res.rules.map((r) => ({ id: r.id, name: r.name, status: r.status })),
    run: {
      result: res.failed ? 'FAIL' : 'PASS',
      exitCode: res.failed ? 1 : 0,
      violationCount: res.failures.length,
      warningCount: res.warnings.length,
      violations: res.failures,
      warnings: res.warnings,
      durationMs: +checkMs.toFixed(1),
      method: 'checkAll(collectRepoInputs(root)) timed with process.hrtime.bigint()',
    },
  },
  selfTests: countSelfTests(),
  dependencyCoverage: {
    declaredPackages: pkgInfo.names.size,
    codeLedgerRows: codeRows.length,
    transitiveDependenciesChecked: false,
    uncoveredPackages: uncovered,
    packages,
    method: 'parsePackageJson(package.json) × rowNameMatches(name cell) over classifyRows(parseTpaTables(THIRD_PARTY_ASSETS.md).code)',
  },
  versionDrift: {
    pinsCompared: allChecks.filter((c) => c.verdict !== 'deferred (row unpinned)').length,
    pinsDeferred: allChecks.filter((c) => c.verdict === 'deferred (row unpinned)').length,
    pinsDrifted: drifted.length,
    drifted,
    method: 'parsePinVersion(ledger pin cell) vs resolvedLockVersion(package-lock.json) — packages["node_modules/<name>"].version, lockfileVersion-1 dependencies fallback',
  },
};

const outPath = join(root, 'tools', 'ledger', 'report.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${outPath}`);
console.log(`checker run: ${report.checker.run.result} (exit ${report.checker.run.exitCode}), ${report.checker.run.violationCount} violation(s), ${report.checker.run.warningCount} warning(s)`);
console.log(`self-tests: ${report.selfTests.count} (${report.selfTests.method})`);
console.log(`coverage: ${packages.length - uncovered.length}/${packages.length} declared package(s) covered; uncovered: ${uncovered.length ? uncovered.join(', ') : 'none'}`);
console.log(`drift: ${report.versionDrift.pinsCompared} compared, ${report.versionDrift.pinsDeferred} deferred, ${report.versionDrift.pinsDrifted} drifted`);
