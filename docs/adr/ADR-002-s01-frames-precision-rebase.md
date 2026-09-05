# ADR-002: S0.1 — frame chain validated, f64/f32 boundaries, and contact-bubble rebase

- **Status**: accepted (measured; the geodesy reference-implementation half of S0.1's exit criterion is explicitly still open — see Decision 6)
- **Date**: 2026-09-06 (probe wave and measurements 2026-09-05)
- **Deciders**: S0.1 keystone spike (orchestrated Phase-0 agent wave), probes and report at `tools/spikes/s0.1/` (`report.json`, regenerable via `node tools/spikes/s0.1/writeReport.ts`; host: Windows 11 dev box, Node 24.13.0, `@dimforge/rapier3d-deterministic-compat` 0.20.0)

## Context

ADR-001 fixed the simulation architecture (local contact bubbles, Z-up ENU, canonical f64 state
with a bounded f32 Rapier solver, tick-boundary rebase) but explicitly left its numbers
unmeasured. COORDINATE_SYSTEM.md §8/Law PH-1 and Law P-6 required S0.1 to answer, by
measurement: does the frame chain hold at planetary scale; where exactly does f64 end and f32
begin; does origin rebase survive resting contacts and joints; how far may a tangent-gravity
bubble extend before the (0,0,−g) approximation fails (the "separate, tighter measured bound"
Law P-5 demands); and which Earth-fixed geodesy reference implementation anchors the
planet-fixed frame.

## Evidence

All values [MEASURED 2026-09-05, vitest probes + `report.json` under `tools/spikes/s0.1/`,
methods recorded there per probe]. 38 probe tests pass deterministically on the host
(bit-for-bit report regeneration verified).

**A — frame chain (rotation pair: EQJ ↔ EQD via astronomy-engine `Rotation_EQJ_EQD` /
`Rotation_EQD_EQJ` applied only through library `RotateVector`, plus `SiderealTime` GAST as the
EQD ↔ PlanetFixed(CTRS) z-rotation — the "EQJ → EQD → CTRS" pair; no ecliptic frame).** At the
COORDINATE_SYSTEM.md §12 site (Dar es Salaam, φ = −6.79°, λ = 39.21°, h = 0,
2026-09-05T00:00:00Z): full-chain f64 round-trip through the heliocentric hop residual
4.3735e−6 m — reproducing the doc's committed G-02 seed (≤ 4.4e−6 m) and confirming that the
sub-micrometre class belongs to the rotation-only chain (1.4163e−9 m), the full chain being
floored by f64 ULP (~30.5 µm) at 1.5e11 m. G-01 zenith self-consistency vs the library's own
horizon frame 4.8145e−14 deg (seed 4.6e−14 deg). ENU up is the ellipsoid normal: normal-offset
lines recover the anchor lat/lon to 1.24e−16 rad at h = −100/+100/+1000 m. Law V-1 transport
term at the equator: chain 465.101 m/s agrees with library `ObserverState` to 8.66e−5 m/s. The
doc's §12 step-7/step-8 seeds reproduce to 5.0e−12 m (door − eye) and the single f32 downcast
stays mm-exact at 100 m.

**B — f64/f32 boundaries (Laws P-3/P-4; fills B-PREC-01, evidence for B-PREC-02).**
B-PREC-01: max observed positional jitter at a 1e7 m origin offset = 0.5 m stored globally in
f32 (600-tick 1 m/s walk) vs 4.45e−7 m with floating origin — 1.1e6× better. ULP ladder
(f64/f32): 1.86e−9 m / 1 m at 1e7 m; 1.91e−6 m / 1024 m at 1e10 m; 30.5 µm / 16384 m at
1.5e11 m. Catastrophic cancellation (the quantitative case for Law P-3): subtracting two
~1.5e11 m heliocentric positions errs 4.37e−6 m in f64 vs 12 636.38 m downcast-to-f32-first
(the doc's §12 seed), and the Earth→Moon vector errs 7.22e−6 m vs 1522.41 m. 2^24 = 16 777 216
verified as the f32 integer-exact limit (+1 collapses; 25 of 33 integers representable in a
±16 window). Note: the plan-shorthand figures "~2 µm f64 / ~1 km f32 at 1e7 m" actually
describe 1e10 m; the doc's §6 ladder is the authority and both regimes were measured.

**C — contact bubble (Rapier deterministic-compat 0.20.0, WASM f32 solver, Z-up, world gravity
(0,0,−9.80665), dt = 1/60, 600 steps, Rapier defaults, friction 0.7 / restitution 0).**
(i) Resting contact is rock-solid: pad box penetration 6.875e−5 m, ramp box 1.056e−3 m, zero
vertical drift, zero horizontal creep (≤ 6.7e−6 m awake), no tunnelling. (ii) Fixed joint under
a 523.6 kg load: 0 m anchor drift and sag over 600 steps. (iii) **The core verdict** — a naive
whole-world f32 translation of +5e6 m in z (f32 spacing 0.5 m at that magnitude) injects
separation errors of −1.0e−3 m (pad) / +0.2677 m (ramp) and silently kills resting contact:
with default sleeping the boxes accumulate phantom free-fall velocity (4.903 m/s) while their
f32 positions stay frozen and then sleep in the corrupted pose; with sleeping disabled the
contact is dead (velocity accumulates to 98.07 m/s, position frozen 367 steps, box tunnels
465.5 m through the 1 m slab). The Law P-6 compliant rebase — the anchor absorbs the 5000 km in
canonical f64 and every solver transform is re-derived from canonical state (bubble-local
coords stay ≤ 3.33 m) — leaves stability identical to pre-rebase. **Rebase with resting
contacts HOLDS only as canonical-f64 re-derivation.** (iv) Two independent bubbles at
Dar es Salaam / Oslo (anchor separation 7327.3 km) simulate simultaneously with stability
identical to single-bubble runs and bitwise-identical Dar states with/without a neighbour —
zero cross-talk by construction. (v) Rebase with an axes change (+1000 m translation AND 90°
yaw, p′ = Rz(−yaw)(p − t), v′ = Rz(−yaw)v, q′ = q_frame ⊗ q): residuals 2.44e−5 m position
(f32 ULP class at km range), 0 m/s velocity, 6.72e−8 quaternion; contacts re-hold and the joint
keeps 2.38e−7 m drift. (vi) ROADMAP §9 matrix items: Z-up jump lands back into rest with
1.65e−4 m airborne creep; a 30°-yawed chassis keeps ENU up (1.97e−6 rad) and heading
(4.18e−6 rad) with vehicle-frame gravity (0,0,−g) to 1.93e−5 m/s²; parent-relative exit
velocity v = v_parent + ω × r (VEHICLES_AND_FLIGHT.md §5) is acquired by a jointed ATTACHED
child to 4.17e−3 m/s and a tick-boundary handover injects 0 m/s delta-V
(VEHICLES_AND_FLIGHT.md §3), with the measured caveat that a merely-resting rolling body
carries only 0.283 (~2/7) of surface velocity.

**D — tangent-gravity error (spherical Earth, R = 6 371 000 m, GM = 3.986004418e14 m³/s²;
feeds the Law P-5 bubble bound).** At surface displacement d: direction error 1.57e−5 rad
(100 m), 1.57e−4 rad (1 km), 1.57e−3 rad (10 km), 1.57e−2 rad (100 km), 0.156 rad (1e6 m);
spurious lateral acceleration 1.5e−4 / 1.5e−3 / 1.5e−2 / 0.154 / 1.49 m/s² respectively
(60 s ballistic miss 0.28 / 2.77 / 27.7 / 277 / 2675 m). Magnitude error is dominated
everywhere by the constant choice (+0.0136 m/s², +0.14%) until the 1/r² curvature term takes
over at ~1e6 m (−0.223 m/s², −2.3%).

## Decision

1. **Adopt the measured frame chain as-is**: geodetic (§5 WGS84 closed form) → PlanetFixed via
   Rz(+GAST) + library EQD→EQJ (applied only through `RotateVector`) → Pci → Helio, with the AU
   constant crossed exactly once. Canonical math f64 (Laws P-1/P-3); f32 only at the bounded
   solver and the single per-pipeline render downcast (Law P-2). G-01/G-02 fixture seeds are
   confirmed reproducible; CI thresholds proposed at 1e−12 deg (G-01) and 1e−5 m (G-02) — three
   orders inside the measured values [PLACEHOLDER — gate: S0.11 confirm].
2. **Rebase is re-derivation, never translation (Law P-6, now measured)**: `LocalScene.rebase`
   moves the anchor in canonical f64 and re-derives every solver transform from canonical
   state. A shift vector applied to accumulated f32 solver state is a bug by measurement: it
   silently destroys resting contacts at 5e6 m magnitude while looking "stable" once bodies
   sleep. A changed ENU anchor also rotates axes (p′ = Rz(−yaw)(p − t), v′ = Rz(−yaw)v,
   q′ = q_frame ⊗ q) — measured safe at f32-downcast residuals.
3. **One Rapier world per active contact bubble (Law PH-1), independent worlds per location** —
   cross-talk is zero by construction and bitwise-verified. No joint may span two solvers.
4. **Contact-bubble extent bound (the Law P-5 "tighter measured bound"): active contact-bubble
   extent ≤ 1e4 m (10 km).** At 10 km the tangent (0,0,−g) model errs 1.57e−3 rad in direction
   and 0.0154 m/s² laterally (60 s miss ~28 m), magnitude error +0.14% (constant choice,
   present at every extent); at 100 km direction error reaches 0.0157 rad and 277 m/60 s; at
   1e6 m the model is invalid outright (0.156 rad, −2.3% magnitude). Walk/car-scale gameplay
   lives orders of magnitude inside this; powered flight leaves the bubble to FLIGHT_DYNAMIC
   central gravity before the bound matters.
5. **Solver baseline for bubble sizing**: Rapier defaults (numSolverIterations 4, default ERP /
   allowed linear error), dt = 1/60, friction 0.7 / restitution 0. Measured resting penetration
   classes (6.9e−5 m flat, 1.06e−3 m on a 15° ramp) are the acceptance classes for
   streaming/terrain colliders.
6. **Geodesy reference implementation (GeographicLib candidate, COORDINATE_SYSTEM.md §5/§14) is
   NOT decided by this ADR** — probe D used the honest spherical model, so its d = 0 row is the
   g-constant choice and not a deflection-of-the-vertical figure. The S0.1 exit criterion's
   geodesy half (library vs bake-only pyproj, site normal-gravity values, geoid grid cost)
   remains open and must land as its own decision record or an amendment here.

## Consequences

Fills ROADMAP §Budgets **B-PREC-01** = 0.5 m [MEASURED 2026-09-05, 600-tick f32 walk at 1e7 m
offset] and provides the verified f64/f32 boundary ladder for **B-PREC-02**; adds measured
**B-CONTACT-01…03** (bubble extent, rebase residuals, resting/joint acceptance classes). The
Law P-5 ~1e5–1e6 m render bound is consistent with the ladder; bubble extent is bounded
separately per Decision 4. ADR-001's rebase/axes/attachment requirements now have measured
backing; production rebase code can be reviewed against concrete failure numbers. Locked in:
the f64 canonical law is no longer merely stylistic — violating Law P-3 costs 12 636 m per
subtraction at heliocentric range, and a translation-style rebase is a proven contact-killer.
Harder: rebase must be implemented as state re-derivation (more code than a shift vector), and
sleeping must never be trusted as a health signal in rebase/teleport paths (a sleeping body in
a corrupted pose is "stable" to every naive metric). Recorded quirks for vehicle work: this
Rapier build's ball-vs-cylinder manifold returns a tilted normal for off-axis contacts (use
flat cuboids for carry/exit tests), and a merely-resting body inherits only ~2/7 of surface
velocity — exit/undock must use the attachment-point formula on jointed (ATTACHED) bodies only.
The frame-chain, precision, bubble and gravity probe suites live under the throwaway
`tools/spikes/s0.1/` carve-out and are deleted when this ADR's durable assertions are re-homed
as golden tests (G-01/G-02 seeds, B-PREC-01 walk, bubble re-derivation regression).
