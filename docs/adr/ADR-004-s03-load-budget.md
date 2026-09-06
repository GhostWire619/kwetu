# ADR-004: S0.3 — load budget (per-package first-visit bytes) and Rapier WASM shipping

- **Status**: accepted (ratified 2026-09-06 by the orchestrator landing pass: all B-LOAD rows landed in ROADMAP §3.1, B-LOAD-07/09 definition revisions recorded in §7.1, B-LOAD-10 re-gated to Phase 1 per this ADR. The Rapier shipping recommendation stands; Phase-1 production-build confirmation remains open)
- **Date**: 2026-09-06 (baseline wave measured 2026-09-05, reproduced byte-identically 2026-09-06)
- **Deciders**: S0.3 keystone spike (orchestrated Phase-0 agent wave); probes and report at `tools/spikes/s0.3/` (`measure.mjs`, regenerable `report.json` with a `report.test.mjs` reproducibility guard; host: Windows 11, Ryzen 7 7445HS / RTX 4050 Laptop 6 GB, Node 24.13.0, vite 8.2.2, zlib `gzipSync` level 9)

## Context

S0.3's question — "what does the first visit actually weigh, per package?" — owns ROADMAP §Budgets
B-LOAD-01…10 and must replace the withdrawn informal 3–5 MB claim with measured figures. The
2026-09-05 wave measured three.js, the Rapier deterministic-compat build (with the standalone
.wasm as a reference), and a combined shell entry that bundled astronomy-engine and i18next inside
it — leaving four packages uninstalled, the shell composition contested, and the Rapier WASM
shipping configuration explicitly open.

This wave (2026-09-06) completes the package set — nakama-js 2.8.0 and livekit-client 2.22.2 are
now installed — and owes two decisions the partial wave deferred:

1. **Rapier WASM shipping**: the compat package base64-inlines its WASM into the JS. Ship that, or
   a separate-`.wasm` configuration?
2. **astronomy-engine / i18next row placement**: inside B-LOAD-07 (app shell) or their own rows?

## Evidence

**Method** [MEASURED 2026-09-06, `tools/spikes/s0.3/measure.mjs`]: vite 8.2.2 production build
(rolldown bundler, oxc minifier — the vite 8 default), one entry per package, no shared chunks,
import surfaces kept realistic (the surface the Phase 1 shell will actually import), then zlib
`gzipSync` level 9 over the concatenated minified JS. Static vendor files (Basis transcoder pair,
meshopt decoder module, KTX2Loader, LiveKit E2EE worker) are read from `node_modules` exactly as
shipped and gzipped directly — they are runtime-fetched assets, never bundled. Locale bundles are
gzipped as served. Rapier figures reproduce the 2026-09-05 baseline **byte-identically** on
2026-09-06 (all five baseline entries: three, rapier, astronomy, i18next, shell), and
`report.test.mjs` asserts the committed values so the report stays regenerable. `report.json`'s
`budgetFigureSummary` maps every figure below back to its regeneration method.

**Per-package figures** (gzip9 bytes):

| Row | Package / quantity | Value (B) | Tag |
|---|---|---|---|
| B-LOAD-01 | three.js core build (log-depth renderer, camera, scene) | 126,438 | [MEASURED 2026-09-05, tools/spikes/s0.3/measure.mjs — vite 8.2.2 (rolldown/oxc) minified prod import; reproduced byte-identically 2026-09-06] |
| B-LOAD-02 | Rapier WASM, deterministic-compat 0.20.0 as it ships (WASM base64-inlined; package split per ARCHITECTURE.md §13) | 1,088,335 | [MEASURED 2026-09-05, tools/spikes/s0.3/measure.mjs; reproduced byte-identically 2026-09-06] |
| B-LOAD-03 | nakama-js 2.8.0 (Client + `createSocket` — the package's ESM dist carries whatwg-fetch and its base64 helpers inline) | 13,137 | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — vite 8.2.2 minified prod import, zlib gzipSync level 9; byte probe, no server contacted] |
| B-LOAD-04 | livekit-client 2.22.2 (Room + the track surface the positional-voice path imports, with RemoteAudioTrack used as a value so it cannot tree-shake away) | 131,745 | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — vite 8.2.2 minified prod import, zlib gzipSync level 9; optional E2EE worker excluded — it is a consumer-provided Worker (livekit-client/e2ee-worker subpath), shipped file 292,384 B raw / 68,605 B gzip9 [MEASURED 2026-09-06, report.json staticAssets]] |
| B-LOAD-05 | KTX2 / Basis transcoder pair as shipped in three 0.185.1 (basis_transcoder.js 15,143 + basis_transcoder.wasm 247,535) | 262,678 | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — the two files as shipped, zlib gzipSync level 9 each; runtime-fetched by KTX2Loader.setTranscoderPath(), never bundled] |
| B-LOAD-06 | meshopt decoder — three ships `examples/jsm/libs/meshopt_decoder.module.js` with the WASM payload **embedded in the JS** (meshoptimizer's own string encoding); **no separate .wasm accompanies it in the shipping path** (verified: the only .wasm files under examples/jsm/libs are basis/ and draco/) | 7,804 as shipped; 7,231 bundled+minified | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — shipped file gzipped; bundled figure via a vite 8.2.2 entry that consumes the decoder; zlib gzipSync level 9] |
| B-LOAD-07 | App shell — strict exclusive figure per the tasked derivation (see Decision 4 for what it still carries) | 1,216,417 derived; direct strict-shell build cross-check 1,215,356 (delta −1,061) | [MEASURED 2026-09-06, derived subtraction: 2026-09-05 shell 1,249,242 − astronomy-engine 19,257 − i18next 13,568; cross-checked by a direct vite 8.2.2 build of the shell-minus-both entry; zlib gzipSync level 9 — the subtraction is a derivation, not an independent re-measurement, and both figures are recorded] |
| B-LOAD-08 | One locale bundle (locales load lazily per docs/swahili-i18n.md): 112-key app namespace, EN + sw with identical key sets | sw 1,346; EN 1,210 (compact-JSON variants 1,329 / 1,192) | [MEASURED 2026-09-06, tools/spikes/s0.3/measure.mjs — authored JSON as served, zlib gzipSync level 9; representative fixture — the real key namespace is owned by docs/swahili-i18n.md (S0.10)] |
| B-LOAD-09 | **Total first-visit transfer** — provisional derived sum, inclusion list in Decision 5 | 1,665,025 (≈ 1.59 MiB) | [MEASURED 2026-09-06, derived sum over the stated inclusion list; every component individually measured, zlib gzipSync level 9; anchored on the single-stream `fullshell` build 1,401,137 B — not an end-to-end transfer measurement] |
| B-LOAD-10 | Warm re-visit transfer (Cache API / IndexedDB hit, `navigator.storage.persist()` granted) | — | [PLACEHOLDER — gate: needs real CDN warm measurement] |

**Rapier shipping arithmetic** [MEASURED 2026-09-06, tools/spikes/s0.3/report.json
`derived.rapierWasmShipping`]: the standalone `rapier_wasm3d_bg.wasm` gzips to 772,479 B
(2,048,139 B raw), so base64 inlining costs **315,856 B gzip gross** (compat JS 1,088,335 − wasm
772,479). A separate-WASM configuration still ships the JS glue: deleting the single base64
literal (2,730,852 chars) from the built minified bundle leaves 156,866 B minified / **28,836 B
gzip** glue [DERIVED 2026-09-06 from the built compat artifact, not a build of the real
non-compat package]. Estimated separate-WASM total: 772,479 + 28,836 = **801,315 B**, a net
saving of **≈ 287,020 B (−26.4%)** vs the compat build. The same-pin swap is possible:
`@dimforge/rapier3d-deterministic` (non-compat) is registry-verified at 0.20.0, latest
[EXTERNAL, verified 2026-09-06, npm registry `npm view`]. Costs NOT in that figure: a second HTTP
request + cache entry, correct `application/wasm` MIME + CORS, and a fetch/instantiate path
replacing the inlined `init()`.

**First-visit sum cross-check**: the additive row-sum accounting (three 126,438 + Rapier compat
1,088,335 + astronomy 19,257 + i18next 13,568 + app-glue residue 1,644 + nakama 13,137 + livekit
131,745 + meshopt 7,231 + Basis pair 262,678 + EN locale 1,210 = 1,665,243 B) agrees with the
single-stream fullshell-anchored total (1,665,025 B) to within 218 B — shared gzip
dictionary/dedup effects only. Compositional sanity: fullshell (1,401,137) ≤ shell + nakama +
livekit + meshopt (1,401,355). All asserted in `report.test.mjs`.

**Bundler observation** [MEASURED 2026-09-06]: an entry that merely re-exports the meshopt decoder
tree-shakes to **0 bytes** in a vite 8 (rolldown) app build — the IIFE result is inferred pure and
unused entry exports are dropped. The decoder must be consumed (`await MeshoptDecoder.ready`, the
GLTFLoader pattern) to be retained. The same discipline applies to any pure-export addon the
Phase-1 shell imports; a silently empty chunk is the failure mode.

**Honesty notes**: nakama-js and livekit-client are byte probes — no server is contacted, no
connection is made; these are transfer-size figures, not protocol benchmarks. The probe "shell" is
a combined bundle: its app-code-only residue over the dependency sum is 1,856 B minified /
1,644 B gzip [DERIVED, report.json `shellOverheadVsDepSum`] — the real app shell (TS + CSS) is
measured at Phase 1, whose exit criterion records shell transfer. KTX2Loader.js
(36,567 B raw / 9,011 B gzip as shipped, unminified — overstates its bundled cost) and the
MeshoptDecoder loader-side wiring ride in B-LOAD-07 territory when imported; the fullshell entry
carries the meshopt decoder module but not KTX2Loader.

## Decision

1. **Fill B-LOAD-03…06 and B-LOAD-08 with the measured values above**; B-LOAD-01/02 stand as
   measured 2026-09-05 and reproduced 2026-09-06. The informal 3–5 MB first-visit claim is
   replaced by B-LOAD-09's provisional 1,665,025 B.
2. **Rapier WASM ships in the deterministic-compat build (base64-inlined) for Phase 1.** Rationale:
   the determinism pin (ARCHITECTURE.md §13, gated by S0.11) stays in one artifact from one
   package at one version; one request, one cache entry, no `application/wasm` MIME/CORS or
   streaming-instantiation failure modes; and physics is not on the first-paint critical path —
   the Phase-1 shell renders and flies before `RAPIER.init()` resolves, so the whole compat chunk
   can defer behind first render regardless of shape. The measured price is explicit: **+315,856 B
   gzip gross** vs the raw .wasm (≈ +287,020 B net vs the estimated separate-WASM build, −26.4%
   of the package). The **Phase-1 build confirms** this decision when it wires the real shell;
   the standing trigger to revisit is S0.9's B-RTT-09 access-envelope verdict × the B-LOAD-09
   total — if the measured load time on that envelope hurts, the separate-.wasm swap
   (`@dimforge/rapier3d-deterministic` 0.20.0, same pin) is the first lever, worth ≈ 287 KB gzip.
   The swap then requires: ledger rows (S0.4), a re-verified determinism claim (S0.11), and the
   dual-fetch/cache path — it is a deliberate Phase-1 ADR amendment, never a silent package swap.
3. **astronomy-engine and i18next move OUT of the shell row into their own dedicated rows** —
   proposed as **B-LOAD-12 (astronomy-engine, 19,257 B)** and **B-LOAD-13 (i18next, 13,568 B)**.
   Rationale: B-LOAD-07 is defined as app TS + CSS, and third-party runtimes are not app code;
   they have independent upgrade cadences (an i18next minor bump would otherwise silently move
   the shell row); and dedicated rows keep B-LOAD-09's sum strictly additive. The strict-shell
   derivation in this ADR already removed both from the shell figure, so the accounting closes.
4. **B-LOAD-07's strict figure is the derived 1,216,417 B, stated with its composition**: it is
   the 2026-09-05 combined shell minus astronomy-engine and i18next, and it **still carries
   three + Rapier compat** (they are bundled inside the shell entry) plus the ~1.6 KB app-glue
   residue. It is the first-visit bundle minus the two removed libraries — not an app-code-only
   shell. The direct strict-shell build (1,215,356 B) is the measured cross-check. The real
   B-LOAD-07 value (app TS + CSS alone) is measured at Phase 1.
5. **B-LOAD-09 = 1,665,025 B provisional, over this explicit inclusion list**: (a) the fullshell
   single-stream build — three + Rapier compat (base64-inlined WASM) + nakama-js + livekit-client
   + astronomy-engine + i18next + meshopt decoder + app glue + the 8-key locale fixture (known
   ~0.1 KB over-count: the real app loads locales lazily); (b) basis_transcoder.js 15,143;
   (c) basis_transcoder.wasm 247,535; (d) the EN locale bundle 1,210 (the default lazy locale).
   Excluded: the LiveKit E2EE worker (optional consumer-provided asset; E2EE not planned), the
   KTX2Loader in-bundle cost (open), and warm-revisit transfer (B-LOAD-10). One locale loads on
   the first visit; the other is an extra lazy fetch.
6. **B-LOAD-10 stays a placeholder** — a static gzip probe cannot measure Cache-API/IndexedDB warm
   behaviour, and building the service-worker cache path is feature code Phase 0 must not write.
   Recommended re-gate (orchestrator's call): a genuine warm probe — SW + Cache API +
   `navigator.storage.persist()` granted, against the production CDN/compression config — either
   as an S0.11 Playwright harness item or folded into Phase 1's "shell transfer recorded" exit
   criterion, which already measures transfer twice (cold shell record + warm revisit).
7. **Locales stay lazy** (docs/swahili-i18n.md): B-LOAD-08 is an asset fetch, not bundle bytes;
   the Phase-1 shell must not inline locale JSON (the probe fixtures do, and are flagged as such).

## Consequences

Fills ROADMAP §Budgets **B-LOAD-03…06, B-LOAD-08** (measured), **B-LOAD-07** (derived, composition
stated), **B-LOAD-09** (provisional derived sum, inclusion list stated); **B-LOAD-10 remains
empty**, so S0.3's exit criterion ("every row in §3.1 carries a `[MEASURED]` figure") is not
fully met and this ADR is `proposed` — B-LOAD-10 needs its re-gate decision or a genuine warm
probe. Adds proposed rows **B-LOAD-12/13** for astronomy-engine and i18next. Locks in: the
load-budget accounting method (per-package gzip9 + explicit inclusion lists; single-stream bundle
builds as the anti-double-counting anchor); the compat Rapier shipping choice for Phase 1 with
its ≈ 316 KB gross / ≈ 287 KB net price on record; and the consume-pure-exports bundling rule
(an unused pure export tree-shakes to zero — every addon the shell imports must be consumed).
Makes the first-visit weight honest for planning: three + Rapier + livekit are ~81% of the
provisional total; the withdrawn 3–5 MB guess is replaced by a measured ~1.67 MB over the current
package set — with the explicit caveat that region payloads (B-REG-*) stack on top of this and
that the real app shell and KTX2Loader will move the total. Harder: every new dependency now
needs a row update and an inclusion-list revision, and the shell figure cannot be cited without
its composition caveat. Open items: (1) B-LOAD-10 warm measurement + re-gate; (2) Phase-1
confirmation of the Rapier shipping decision on the real shell; (3) the separate-WASM estimate is
derived from the compat artifact, not a build of the non-compat package — re-derive if the swap
is ever taken; (4) KTX2Loader/MeshoptDecoder loader-side in-bundle cost (Phase 2); (5) ledger rows
for nakama-js 2.8.0, livekit-client 2.22.2 and their transitive dependencies (S0.4 gate — licenses
to be verified from the LICENSE files at pinned commits, not from package metadata); (6) the real
locale namespace (S0.10) replaces the 112-key fixture.
