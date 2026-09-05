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
