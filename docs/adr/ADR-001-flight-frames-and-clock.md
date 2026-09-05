# ADR-001: Local physics, fleet movement and a shared clock

- **Status**: accepted design baseline; implementation unverified
- **Date**: 2026-09-05
- **Deciders**: Codex documentation revision under the user's request to research and correct the specification and support many vehicle kinds
- **Supersedes**: pre-code PH-1 planet-wide physics-world rule; Y-down gravity in Z-up ENU; speed/time-warp-based flight ownership; unresolved shared-clock options; bundled Three.js type prohibition. There is no earlier numbered ADR.

## Context

The previous documents contradicted their coordinate axes, prohibited multiple contact worlds on a planet, assigned flight both to Rapier and exclusively to conics, and left private time acceleration competing with a shared universe. Their blanket f64 claim also excluded the selected f32 contact engine. A single generic vehicle record did not adequately specify staged rockets, landers, shuttles, cargo ships or passengers.

## Evidence

Primary documentation read on 2026-09-05:

| Source | Verified capability or constraint | Design implication |
|---|---|---|
| [Rapier gravity](https://rapier.rs/docs/user_guides/javascript/rigid_body_gravity/) | Global gravity is configurable; kinematic bodies do not respond to forces | Integrate avatar desired movement explicitly |
| [Rapier forces](https://rapier.rs/docs/user_guides/javascript/rigid_body_forces_and_impulses/) | Custom forces and torques can be applied to dynamic bodies | A spatial gravity field is possible; local bubbles are a precision choice |
| [Rapier character controller](https://rapier.rs/docs/user_guides/javascript/character_controller/) | Character movement uses collision queries and configurable up | ENU and asset/controller conventions must be set deliberately |
| [Three.js installation](https://threejs.org/manual/en/installation.html) | TypeScript declarations are community maintained | Verify compatible declarations; remove the r168 prohibition |
| [NASA NAIF time](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/time.html) | TT, TAI, UTC and TDB have distinct definitions and conversions | Pin time adapters and leap data; TT is the chosen game epoch, not a provider mandate |
| [ECMAScript time values](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-time-values-and-time-range) | Date models days without leap-second labels | Civil timestamps are not a simulation stopwatch |
| [NASA rocket thrust](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/rocket-thrust-equation/) | Thrust depends on mass flow, exhaust and ambient pressure | Define engines, propellant and changing mass independently of vehicle art |
| [Nakama multiplayer](https://heroiclabs.com/docs/nakama/concepts/multiplayer/) | Authoritative match logic is application-defined | Go validation is a project model; absence of a contact solver is not a platform ban on physics |

These sources establish capabilities, not benchmark results or an endorsed Kwetu architecture. The policies below are engineering decisions inferred from the product constraints. No license sweep, target-hardware benchmark or numerical simulation was performed in this revision.

## Decision

1. Keep ENU Z-up and use local contact bubbles, with separate canonical f64 state and local f32 solver boundaries. Atomic rebase includes axes, velocity and attachments. Allow multiple independent bubbles on one planet; tiles supply geometry only.
2. Use exactly one movement owner: local contact, f64 powered/atmospheric flight, analytic unpowered coast, attachment, or later fictional transit. Clock rate and vehicle family do not determine the integrator.
3. Use TT seconds since J2000 TT for authoritative instants. Public clock rate is real time. Offline coast preserves duration. Accelerated isolated training cannot merge state. Fictional rapid travel is separately labelled, follows shared time, and retains real geometry. This resolves semantics without claiming a short physical Earth–Moon journey.
4. Build a capability-based fleet with versioned definitions/instances, staged mass/resources, seats, docking and environment limits. Guided landing is cancellable flight control with validated contact, not animation-driven teleportation.
5. Retain server-owned outcomes and bounded movement validation; add numerical replay for powered flight. No promise of full server-authoritative contact physics or universal cross-language bitwise equality.

## Consequences

This replaces hard invariants under ROADMAP §7 change control, not just wording. It adds local-world handoff and numerical-flight work, removes an invalid global-gravity argument, and makes public journey duration explicit. A conic solver cannot substitute for powered ascent. A generic ship cannot land on every body. Rapid fictional transport remains a later feature; it must pass its own route/arrival tests.

S0.1 must measure Z-up contact/rebase and multi-location stability; S0.6 validates adversarial car and powered-flight paths; S0.7 proves time adapters, restart and all movement transitions. Phase 7 proves staged launch and recovery; Phase 8 adds a distinct lander. ROADMAP budget rows remain unfilled; this accepted design does not count as completion of any spike. Existing historical numerical examples remain unverified seeds, not new evidence.

## Review and remaining measurements

A bounded claude-deepseek review suggested rebase, orbital conservation, clock-skew, stale-landing-clearance and fuel-gate tests. Those test themes were retained. Its proposed numerical tolerances were not accepted: they were unsupported and some were inappropriate for planetary f32 contact precision. Codex independently checked document consistency and local links. Implementation still requires measured bubble sizes, timestep/substeps, model tolerances, streaming lead distances, landing envelopes and reconciliation bounds; owners and gates are in ROADMAP.
