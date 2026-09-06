# ADR-003: S0.2 — planet LOD, crack stitching and depth strategy

- **Status**: reserved — S0.2 measurement incomplete; this slot exists so the ADR index,
  the Phase-0 gate arithmetic and CLAUDE.md's depth invariant have a real target. It is
  NOT a decision.
- **Date**: 2026-09-06
- **Deciders**: none yet — the decision is unwritten.

## Context

S0.2 must decide the planet rendering strategy before Earth ships at real scale:
cube-sphere quadtree vs CDLOD (or another continuous-LOD scheme), crack stitching,
and log-depth vs reversed-Z. CLAUDE.md hard-codes the interim answer: **logarithmic
depth buffer AND floating origin, always both** — log depth may be replaced only by
this ADR's outcome, per ROADMAP §7.2 change control. Part B of Phase 1 therefore
renders with the CLAUDE.md interim strategy and placeholder visuals, tagged
[PLACEHOLDER — ADR-003], until this decision lands.

## Evidence

Partial and honestly marked. The S0.2 spike harness (`tools/spikes/s0.2/`) exists:
probe suite (28 tests, 1 currently failing — quadtree transition-thrash), a Playwright
measurement driver, quadtree AND CDLOD planet implementations, and a report.json that
covers **only the quadtree/log-depth flight** (measured 2026-09-06T01:52Z, headed
Chromium, host/GPU/depth-bits recorded).

Known defects at reservation time, recorded by the 2026-09-06 three-lens audit:

1. The report is **partial**: the CDLOD implementation sits unmeasured, so no
   scheme comparison exists; code was modified after the measurement timestamp.
2. The silhouette block's `maxResidualPx 0` is **no-data, not a measurement** —
   limb detection failed at all 4 capture instants (192/192 columns invalid).
3. A 6.7 s max-frame stall appears in the flight stats without annotation.
4. The quadtree transition-thrash test fails (expected 0 transitions after a small
   move, got 1).

The measurement agent stalled repeatedly on the full pass (long SwiftShader flights
exceed the runner's stall window); completion is deferred to a quiet machine so the
numbers are not distorted by concurrent load.

## Decision

None yet. Reserved. When the measurement completes, this ADR will record:
the LOD scheme verdict, crack-stitching approach, the log-depth/reversed-Z verdict
(the CLAUDE.md invariant stands until this section says otherwise), the measured
fps envelope on the dev box, and the integrated-GPU baseline gate.

## Consequences

Fills ROADMAP §Budgets B-DC-01, B-FPS-01, B-VRAM-01, B-VRAM-02 when the decision
lands. Until then Phase 0 cannot close (ROADMAP §2 enumerates the spike→ADR mapping),
and Phase 1's planet visuals are placeholders whose replacement is tracked here.
The reservation itself is change-controlled: it fixes the gate arithmetic so a
file count can never fake Phase-0 completion.
