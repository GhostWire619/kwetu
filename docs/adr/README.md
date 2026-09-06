# Architecture Decision Records

Every Phase-0 spike (S0.1–S0.12, see `ROADMAP.md`) and every reversible-
decision reversal produces an ADR here. One file per decision, named
`ADR-NNN-short-title.md` (zero-padded, sequential).

## Format

```markdown
# ADR-NNN: <short title>

- **Status**: proposed | accepted | superseded by ADR-MMM
- **Date**: yyyy-mm-dd
- **Deciders**: <who/what session>

## Context
What problem, constraint, or measurement prompted this decision.

## Evidence
Measurements, benchmarks, or license verifications — with the
[MEASURED yyyy-mm-dd, method] / [EXTERNAL url] tags used across the
docs, and [PLACEHOLDER — gate] for thresholds a later spike must pin.
An evidence-free ADR is a hypothesis, not a decision.

## Decision
What we will do, stated plainly.

## Consequences
What becomes easier, what becomes harder, what this locks out, and
which ROADMAP §Budgets rows this fills.
```

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-flight-frames-and-clock.md) | Local physics, fleet movement and a shared clock | accepted design baseline; implementation unverified |
| [ADR-002](ADR-002-s01-frames-precision-rebase.md) | S0.1 — frame chain validated, f64/f32 boundaries, and contact-bubble rebase | accepted (measured); geodesy reference implementation still open |
| [ADR-003](ADR-003-s02-planet-lod-rendering.md) | S0.2 — planet LOD, crack stitching and depth strategy | *reserved slot — S0.2 in progress at the 2026-09-06 landing pass; spike code exists in tools/spikes/s0.2/ awaiting its measurement + ADR* |
| [ADR-004](ADR-004-s03-load-budget.md) | S0.3 — load budget measured; Rapier WASM shipping decision | accepted; B-LOAD-10 re-gated to Phase 1 (ROADMAP §7.1) |
| [ADR-005](ADR-005-s04-ledger-ci-check.md) | S0.4 — the attribution ledger gate (R0–R8 checker) | accepted; hosted-CI wiring deferred per ADR-011 Decision 6 |
| [ADR-006](ADR-006-s05-trademark-search.md) | S0.5 — "Kwetu" trademark search (partial; human gates remain) | proposed — conditional GO for internal use, NO-GO for public use until human searches close |
| [ADR-007](ADR-007-s06-server-validation-contract.md) | S0.6 — server-validation contract (kinematic replay + drift thresholds) | accepted (measured); production thresholds re-measured at Phase 4 |
| [ADR-008](ADR-008-s07-time-adapters.md) | S0.7 — TT universe clock, leap-second table, warp semantics | accepted (measured); SOI-handoff algorithm deferred to Phase 7; ttClock + leap table promoted to client/src/engine 2026-09-06 |
| [ADR-009](ADR-009-s08-aoi-cell-grid.md) | S0.8 — AoI cell-grid cost measurement | accepted (measured); B-AOI-03 re-gated to Phase 5 (ROADMAP §7.1) |
| [ADR-010](ADR-010-s10-ui-i18n.md) | S0.10 — DOM HUD, PO→i18next pipeline, sw-first rules | accepted (measured); sw native-speaker review + font ledger row open |
| [ADR-011](ADR-011-s11-ci-testing.md) | S0.11 — CI/testing, golden ephemeris fixtures, determinism | accepted (measured); CI wiring deferred (Decision 6); B-EPH-02 closed cross-platform 2026-09-06 |
| [ADR-012](ADR-012-s12-compliance-checklist.md) | S0.12 — privacy/compliance engineering checklist | accepted; human legal review gated before Alpha |
| [ADR-013](ADR-013-s09-regate-hosting-probes.md) | S0.9 — re-gate hosting + RTT probes to the hosting decision | accepted (change control; probes require Dar/Zanzibar vantage points) |
