# ADR-011: S0.11 — test pyramid, headless WebGL2 smoke, bitwise determinism regression, and golden ephemeris fixtures

- **Status**: accepted (measured 2026-09-06; the CI *wiring* itself is deferred by
  orchestrator decision — see Decision 6)
- **Date**: 2026-09-06
- **Deciders**: S0.11 keystone spike (orchestrated Phase-0 agent wave); artifacts:
  `playwright.config.ts`, `tests/`, `tools/oracle/generate_golden.py`,
  `tools/spikes/s0.11/report.json`

## Context

ROADMAP §5 S0.11 asks whether CI can "see the game at all" and whether determinism and
ephemeris correctness can be proven mechanically. Its exit criterion: Playwright headless
WebGL2 smoke on Chrome **and** Firefox; a bitwise determinism regression that fails on
divergence (→ B-EPH-02); golden ephemeris fixtures precomputed via Skyfield + de440s
(build-time, cached locally, never live in CI) committed and compared on every run.
COORDINATE_SYSTEM.md §11 defines the golden-test contract (G-03 ephemeris vs Python
oracle; G-05 bitwise replay); §10/B-CONST-06 fixes astronomy-engine's stated accuracy at
±1 arcmin for Solar System bodies, subtending ≈ 112 km at the Moon's mean distance and
≈ 43 500 km at 1 AU [EXTERNAL — astronomy-engine docs / derived].

## Evidence

All values [MEASURED 2026-09-06, methods recorded in `tools/spikes/s0.11/report.json` and
in the named test files]. Host: Windows 11 dev box (Ryzen 7 7445HS, RTX 4050 Laptop 6 GB),
Node v24.13.0. Runners: `npx vitest run tests tools/spikes/s0.11` — 2 files, 7 tests
passing; `npx playwright test` — 4 tests passing.

**A — headless WebGL2 (both browsers).** Chromium forced onto software ANGLE
(`--use-angle=swiftshader`): WebGL 2.0 (OpenGL ES 3.0 Chromium), max texture size 8192,
max renderbuffer 8192; Firefox headless (prefs `webgl.force-enabled`): WebGL 2.0 via
ANGLE/D3D11, max texture size 16384. Both rasterize a GLSL ES 3.00 triangle and read back
the exact shader output colour (255, 128, 64) on all 16 sampled pixels. The three.js
render smoke — the pinned `three` 0.185.1 from node_modules through the vite dev server —
renders on both browsers: r185, `isWebGL2` true, 1 draw call / 2 triangles, readback
(255, 64, 128), no context loss. Headless CI-grade browsers can therefore see the
rendering stack at raw-WebGL2 and three.js levels.

**B — bitwise determinism (B-EPH-02, same-host half).** Two in-process runs of the same
seeded 600-step Rapier sim (deterministic-compat 0.20.0, WASM f32 solver, Z-up, gravity
(0,0,−9.80665), dt = 1/60, Rapier defaults, friction 0.7 / restitution 0; layout mirrors
the S0.1 bubble probe family: pad + resting box, 15° ramp + resting box, fixed-joint
hanging body). Seeding: an LCG (seed 1264010580) derives a 6-impulse scripted schedule at
ticks 60/157/254/351/448/545. The state stream — 21 snapshots × 3 bodies × [translation,
linvel, rotation] — is hashed as sha256 over **raw IEEE-754 f64 bit patterns** of the
solver's f32-promoted values (no float *formatting* anywhere in the hash) plus a secondary
shortest-round-trip JSON-text hash. The two runs agree bitwise; the hash is stable across
3 consecutive invocations: `f127593e229cb26f942bade3bf849b8b21f77fed5baa909b3a7215074e2e9f7e`.
A different seed produces a different hash (the check is live, not vacuous). Cross-platform
agreement is **not** measured tonight [PLACEHOLDER — gate: CI matrix].

**C — golden ephemeris (B-EPH-01).** Oracle: skyfield 1.55 (Python 3.14.2) with
`de440s.bsp`, sha256
`c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2`, 32 726 016 bytes,
pinned to `https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp` (verified live
2026-09-06: HTTP 200, matching Content-Length, Last-Modified 2020-12-22). Fixtures:
`tests/golden/ephemeris/ephemeris-golden.json` (schema `kwetu.golden.ephemeris/1`, 8 dates
1990-01-01 → 2030-01-01 incl. 2026-09-05T00:00:00Z). Conventions (stated precisely, in the
fixture itself): ICRF axes exactly as tabulated in the kernel; geocentric rows are
**astrometric** positions from the Earth geocenter (SPICE 399) — light-time corrected, no
aberration, skyfield `earth.at(t).observe(body).position.km`; the Mars row uses the Mars
system barycenter (4) because **de440s contains no Mars center (499)** (kernel target list
enumerated at generation time); the Earth row emits the geometric barycentric 399 and 3
positions and their difference (EMB→Earth offset); topocentric rows are apparent alt/az for
the Moon over Dar es Salaam (−6.79°, +39.21°, h = 0), no refraction, azimuth clockwise from
north; every row records its TT instant both as skyfield's TT Julian Date and as days since
J2000 TT. The verifier (`tools/spikes/s0.11/golden-verify.test.ts`) recomputes everything
with astronomy-engine 2.1.19 at the **identical TT instant**
(`AstroTime.FromTerrestrialTime`). Measured residuals:

| Quantity | Max residual | Where |
|---|---|---|
| Geocentric angular (Sun) | 0.0216 arcmin | 2026-09-05 |
| Geocentric angular (Moon) | 0.345 arcmin | 2017-08-21 |
| Geocentric angular (Mars barycenter) | 0.0414 arcmin | 1999-12-31 |
| Moon linear | 46.3 km | 1990-01-01 |
| Sun linear / Mars linear | 2 170 km / 5 068 km | 1999-12-31 (≈ 0.6–0.7 arcmin subtension at AU-class distances — angular is the comparable metric) |
| EMB→Earth bookkeeping offset | 0.17 km | 2028-07-04 |
| Topocentric Moon alt/az (Dar) | 0.093 arcmin | 2017-08-21 |

Everything sits **inside** the B-CONST-06 ±1 arcmin class — the Moon, the hardest body, at
0.345 arcmin ≈ 21 arcsec. The topocentric residual decomposes into the libraries' ΔT-model
gap (astronomy-engine Espenak-Meeus ≈ 75.5 s vs skyfield builtin ≈ 69.1 s at 2026 → ~0.06
arcmin at lunar distance [derived]) and Earth-rotation UT1 handling (astronomy-engine's
`era()` uses the civil instant as UT1; skyfield's builtin UT1−UTC = +0.096 s at the seed
date = 1.44 arcsec) — both recorded in the test header so a future threshold change is an
argument, not a guess.

**D — toolchain findings that shape CI wiring** (each measured 2026-09-06, each encoded as
a comment in `playwright.config.ts`): Node 24 refuses to spawn `npx.cmd` without a shell
(`spawn npx.cmd` → EINVAL), so the webServer command invokes node directly
(`node node_modules/vite/bin/vite.js --port 5199 --strictPort --host 127.0.0.1`); vite dev
binds IPv6 `::1` by default on this host, so server and readiness URL are pinned to
127.0.0.1; Phase 0 has no root `index.html`, so `/` 404s and the readiness URL must be the
fixture page itself; and the e2e specs are named `*.pw.ts` (not `*.spec.ts`) because
vitest's default include globs `**/*.{test,spec}.ts` and fails collecting Playwright's
`test()` calls — vitest.config.ts is outside this spike's write scope, so the rename and
the explicit `testMatch: '**/*.pw.ts'` live on the Playwright side.

## Decision

1. **Adopt the four-layer test pyramid** (executed from Phase 1 on; the layers exist and
   pass tonight): (a) vitest unit/probe tests, node environment (`npm test`); (b) the
   determinism regression `tests/determinism/determinism.test.ts`; (c) golden-ephemeris
   verification `tools/spikes/s0.11/golden-verify.test.ts` against committed fixtures; (d)
   Playwright browser smokes `tests/e2e/*.pw.ts` on Chromium + Firefox (`npx playwright
   test`; the orchestrator wires the `test:e2e` script). Layers (a–c) run in one vitest
   pass; (d) is a separate runner by design.
2. **State hashing is bit-pattern hashing.** Determinism regressions hash the IEEE-754 f64
   bit patterns of solver state (f32-promoted), never formatted floats — formatting can
   drift, bits cannot. Producers of replay hashes follow this rule (COORDINATE_SYSTEM.md
   G-05 inherits it).
3. **The ephemeris oracle boundary is as generated.** Python + skyfield + de440s.bsp at
   build time only; the kernel stays in gitignored `.bake/` (both `*.bsp` and `.bake/` are
   gitignored — the kernel is never committed); the committed artifact is the fixture JSON
   with the kernel sha256, skyfield version, and every convention embedded, so fixtures
   are self-describing and reproducible. Regeneration:
   `python tools/oracle/generate_golden.py` (fails hard on kernel sha mismatch).
   Verification: `npx vitest run tools/spikes/s0.11`. Tolerance pins (regression pins, not
   accuracy claims — each inside the B-CONST-06 class with headroom over the measured
   maxima): geocentric ≤ 0.5 arcmin; Moon linear ≤ 120 km (= 1 arcmin at lunar distance);
   EMB↔Earth ≤ 1 km; topocentric ≤ 0.25 arcmin.
4. **Playwright config decisions**: both browser projects headless, retries 0, list
   reporter; Chromium pinned to `--use-angle=swiftshader` so the smoke proves the pipeline,
   not the dev box's GPU; Firefox gets `webgl.force-enabled`. The webServer (vite :5199)
   exists only for the three.js fixture — the WebGL2 smoke is deliberately self-contained
   (the task brief's "webServer: none" and its vite-webServer instruction conflict; the
   resolution is recorded here and in the config). The D-finding wiring (direct node,
   IPv4, fixture readiness URL, `*.pw.ts`) is part of this decision — CI inherits it.
5. **What is verified tonight vs what CI adds**: tonight — the suites exist, pass locally,
   and their numbers are pinned in report.json; CI (not written tonight, orchestrator
   decision) adds the cross-platform determinism matrix (Linux runner vs this Windows
   host — the bitwise claim B-EPH-02 promises), the second-host ephemeris sanity run, and
   the `test:e2e` wiring into the pipeline. ADR-002's proposed G-01/G-02 CI thresholds
   (1e−12 deg / 1e−5 m) remain as proposed — re-homing the S0.1 probe seeds into
   `tests/golden/` is open work (see Consequences).
6. **CI yaml deliberately not written tonight** (orchestrator decision): everything above
   is runner-agnostic (plain npm/node/python commands), so the CI definition can land
   without rework.

## Consequences

Fills ROADMAP §Budgets **B-EPH-01** = max 0.345 arcmin angular (Moon) / 46.3 km linear at
lunar distance [MEASURED 2026-09-06, golden fixtures vs astronomy-engine] and **B-EPH-02**
for the same-host half (bitwise PASS, sha256 pinned; cross-platform half
[PLACEHOLDER — gate: CI matrix]). Phase 7's ephemeris gate now has a measured starting
envelope: our JS ephemeris is already sky-quality against DE440s, so Phase 7's work is the
propagator, not the sky. Easier: any future astronomy-engine version bump is a one-command
regeneration + a measured residual diff instead of a trust decision. Harder/locked in: the
determinism hash format (bit patterns) is now a contract for every future replay/authority
feature; the `*.pw.ts` naming and the IPv4/direct-node webServer wiring must survive
CI-setup refactors; the ephemeris fixture embeds its own conventions, so "which frame was
this?" has one answer. Open items carried: cross-platform bitwise proof (CI matrix);
re-homing the S0.1 G-01/G-02 seeds and probe suites from `tools/spikes/s0.1/` into
`tests/golden/` per ADR-002's deletion condition; Horizons-derived fixtures (DATA_SOURCES.md)
remain a later, build-time-only addition — tonight's oracle is the kernel directly, which is
the stronger, service-free reference; THIRD_PARTY_ASSETS.md ledger rows for the Python
oracle chain (skyfield 1.55, jplephem 2.24, numpy 2.4.4 — MIT/BSD-class, versions
pre-installed by the environment, not added by this spike) are owned centrally and must
land with the ledger gate.
