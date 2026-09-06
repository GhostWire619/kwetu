# ADR-013: S0.9 — re-gate hosting + RTT probes to the hosting decision (before Alpha)

- **Status**: accepted
- **Date**: 2026-09-06
- **Deciders**: orchestrator (overnight autonomous run), under ROADMAP §7.2 change control

## Context

ROADMAP §5 gates S0.9 (hosting + RTT probes: Dar es Salaam / Zanzibar → eu-central,
Cape Town, Nairobi; TURN placement; monthly cost) as a Phase-0 spike, and §1.4 makes
every Phase-0-gated, still-empty `[PLACEHOLDER]` row a Phase-0 exit blocker
(B-RTT-01…09, B-COST-01…03).

S0.9's probes are qualitatively different from the project's other Phase-0 spikes.
S0.1–S0.8 and S0.10–S0.12 are all executable from wherever the development machine
happens to be: they measure *our code*. S0.9 measures *network paths from specific
geographic vantage points* — the probe must physically run from Dar es Salaam and
from Zanzibar to be honest. During the 2026-09-06 autonomous overnight run the
Phase-0 spike workflow attempted the searchable parts (S0.5 trademark registries hit
the same class of wall: BRELA, KiPI, WIPO and primary USPTO were not machine-
searchable — ADR-006) and correctly produced no ADR for S0.9: no spike directory was
created, no probe was run, and no number was invented.

Fabricating or substituting a non-Tanzanian vantage point (e.g. a cloud VM in Europe
probing European targets) would produce numbers that look like S0.9 evidence while
measuring nothing relevant — a defect under ROADMAP §1.3.

## Evidence

- No `tools/spikes/s0.9/` directory exists; no probe ran; no B-RTT/B-COST row was
  filled by the overnight run [MEASURED 2026-09-06, orchestrator's repo inspection].
- ROADMAP §3.5/§3.6 rows B-RTT-01…09 and B-COST-01…03 remain empty
  [PLACEHOLDER — gate: S0.9] as of the 2026-09-06 landing pass.
- Every engineering phase through Phase 6 runs against the local compose stack
  (infra/docker-compose.yml, verified live 2026-09-06) — no Phase 0–6 deliverable
  consumes a B-RTT/B-COST value. The first consumer is the hosting decision that
  precedes the Alpha gate (ROADMAP §4).

## Decision

1. **Re-gate S0.9 from "Phase-0 spike" to "the hosting decision, before Alpha."**
   The spike definition, exit criterion, and fills list in ROADMAP §5 are unchanged;
   only the gate timing moves. ROADMAP §7.1 records the change.
2. **B-RTT-01…09 and B-COST-01…03 stay empty until probes run from real vantage
   points** (Dar es Salaam and Zanzibar; relay pair per B-RTT-07). They are *not*
   withdrawn: the access-envelope verdict (B-RTT-09) still governs the assumed
   5–10 Mbps / high-RTT design envelope carried in PROJECT_VISION.md.
3. **No Phase 1–6 exit criterion may consume a B-RTT/B-COST row.** The design
   envelope remains an assumption under test, tagged as such where it is cited.
4. **The concrete closure plan**: the probes run when a person or agent can execute
   from the vantage points — travel, a local collaborator, or a Dar/Zanzibar-located
   cloud/test device — and always before the first paid hosting commitment. The
   TURN placement decision (embedded LiveKit TURN with a real domain + CA cert as
   default) stays binding as designed in NETWORKING.md; only its measured-RTT
   validation waits.

## Consequences

- **Unblocks Phase-0 close** on the S0.9 rows without diluting the
  no-unbenchmarked-promises rule — nothing consumes these numbers.
- **Costs**: the hosting decision (region, cost, TURN relay economics) cannot be
  made until the probes run; the Alpha gate's "measured connection profile" for the
  Vertical Slice needs the same vantage points — plan them together.
- **Locks out**: any claim that Kwetu "will work on East African connections" until
  B-RTT-09 has a verdict; the PROJECT_VISION assumption tag stays.
- **Fills §Budgets rows**: none now; B-RTT-01…09, B-COST-01…03 at the hosting
  decision, by the same spike definition.
