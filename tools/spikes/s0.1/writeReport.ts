/**
 * S0.1 report writer (THROWAWAY spike tooling) — collects all four probes and
 * writes tools/spikes/s0.1/report.json. Run: node tools/spikes/s0.1/writeReport.ts
 */
import { writeFileSync } from 'node:fs';
import { collectFrameReport } from './frames/frameChain.ts';
import { collectPrecisionReport } from './precision/precision.ts';
import { collectBubbleReport } from './bubble/bubbleProbe.ts';
import { collectGravityReport } from './gravity/gravityProbe.ts';

const report = {
  spike: 'S0.1 — coordinate/origin proof (keystone spike: frame chain, f64/f32 boundaries, contact-bubble rebase, tangent gravity)',
  date: '2026-09-05',
  host: 'Windows 11 dev box, Node 24.13.0, deterministic-compat 0.20.0',
  toolVersions: {
    node: 'v24.13.0',
    astronomyEngine: '2.1.19',
    rapierDeterministicCompat: '0.20.0',
    typescript: '7.0.2 (dev tooling, caret-pinned)',
    vitest: '5.0.0 (dev tooling, caret-pinned)',
  },
  runner: 'npx vitest run tools/spikes — 4 test files, 38 tests, all passing at write time',
  method: {
    A_frames:
      'COORDINATE_SYSTEM.md §1 chain in f64 with astronomy-engine 2.1.19: geodetic (doc §5 WGS84 closed form) -> PlanetFixed(Earth) -> [Rz(+GAST) then library Rotation_EQD_EQJ] -> Pci(Earth) -> [+Earth HelioVector, AU crossed once] -> Helio. Rotation pair: EQJ<->EQD via Rotation_EQJ_EQD/Rotation_EQD_EQJ applied ONLY through library RotateVector (a manual row-major multiply of rot.rot is the transposed/inverse mapping — verified against the library\'s own ObserverVector ofdate endpoints), plus SiderealTime GAST as the EQD<->PlanetFixed(CTRS) z-rotation: the "EQJ -> EQD -> CTRS" pair; no ecliptic frame (banned as a Kwetu frame). Round-trip residual measured in PlanetFixed metres; ENU up radiality via normal-offset lines recovering the anchor lat/lon; G-01 zenith cross-check vs the library\'s own horizon frame; Law V-1 transport term vs library ObserverState.',
    B_precision:
      'IEEE-754 spacing measured by bit-pattern exponent (f64 2^(e-52), f32 2^(e-23)); additive-jitter rows apply small deltas to stored positions at 1e7 m and 1e10 m in f64 vs f32 (Math.fround); walk-jitter rows integrate 600 fixed ticks of a 1 m/s walk (dt=1/60) stored globally in f32 vs floating-origin f32-local; catastrophic cancellation subtracts the §12 heliocentric pairs (and the Moon case) downcast-first vs subtract-first; 2^24 boundary enumerated over a +/-16 integer window with Math.fround.',
    C_bubble:
      '@dimforge/rapier3d-deterministic-compat 0.20.0 (WASM f32 solver) in Node: Z-up world, world gravity (0,0,-9.80665), dt=1/60, 600 steps, Rapier default solver (numSolverIterations 4, default ERP/allowed linear error), friction 0.7 / restitution 0. Layout per bubble: flat ground pad + 1 m^3 box (~1000 kg), 15° friction ramp + aligned box (~1000 kg, face-to-face contact), static post + 523.6 kg ball on a fixed joint. (i) rest: settle 60 steps, measure 540; also measured with sleeping disabled (active solver). (ii) fixed joint: 600 steps, anchor drift = |anchor positions difference|. (iii) rebase at tick 120: NAIVE = whole-world f32 translation +5e6 m in z (Law P-6-forbidden move; joint anchors body-local and follow), measured vs post-shift pose, plus a sleep-disabled variant exposing the raw failure; COMPLIANT = anchor absorbs 5e6 m in canonical f64, every solver transform re-derived from canonical f64 state (bubble-local coordinates unchanged, <= 3.33 m). (iv) two independent RAPIER.World instances (Dar es Salaam / Oslo anchors, 7.33e6 m apart) stepped simultaneously + a Dar-alone control, bitwise final-state comparison. (v) rebase at tick 120 with +1000 m east translation AND 90° yaw axes change: p\' = Rz(-yaw)·(p - t), v\' = Rz(-yaw)·v, q\' = q_frame ⊗ q; residuals measured against the canonical f64 targets, then 480 post-rebase steps. (vi) ROADMAP §9 acceptance-matrix items: Z-up jump (3 m/s vertical launch; ballistic-phase lateral creep split from the post-landing contact slide), vehicle axes (chassis at 30° yaw dropped under Z-up gravity: up alignment, heading hold, vehicle-frame gravity), parent-relative exit velocity (VEHICLES_AND_FLIGHT.md §5 v = v_parent + ω × r_offset validated with a rigidly-jointed ATTACHED-regime child on a moving+rotating kinematic parent, then the captured state handed to a fresh zero-gravity world — deviation from p0 + v0·t is injected delta-V; plus the rolling-body carry ratio, the 2/7 rolling-sphere result, as the measured caveat that a merely-RESTING body does NOT inherit the attachment-point velocity).',
    D_gravity:
      'Spherical Earth (R = 6 371 000 m), anchor on the surface; body at bubble-local (d,0,0) i.e. P = A + d·east in 3-D; true field central (g = GM⊕/r² toward O, GM⊕ = 3.986004418e14 m³/s² [EXTERNAL — IERS Conventions (2010)/EGM2008]); tangent model uniform (0,0,-9.80665) in the anchor ENU. Direction error = angle(-up_A, -P/|P|) via atan2(|a×b|, a·b); magnitude error = GM⊕/r² - 9.80665; lateral miss = spurious lateral acceleration × 60²/2 [derived playback, not a simulation]. d=0 row is the g-constant choice, NOT a deflection-of-the-vertical figure (spherical model).',
  },
  probes: {
    A_frames: collectFrameReport(),
    B_precision: collectPrecisionReport(),
    C_bubble: await collectBubbleReport(),
    D_gravity: collectGravityReport(),
  },
  budgetInputs: {
    bPrec01: {
      quantity: 'Max observed positional jitter at a 1e7 m origin offset (m) — ROADMAP §3.8',
      value: null as number | null,
      note: 'Filled below from B_precision.walkJitter (global-f32 walk at 1e7 m, 600 ticks at dt=1/60).',
    },
    bPrec02: {
      quantity: 'Rendered-scene distance-from-origin ceiling (m) — verified f64/f32 boundary — ROADMAP §3.8',
      note: 'COORDINATE_SYSTEM.md Law P-5 scene bound (~1e5–1e6 m) is consistent with the measured ladder: f32 spacing 1.5e-11 m at 6.5e4 m, 0.125 m at 1.05e6 m, 1 m at 1e7 m. The verified boundary facts are the B_precision.spacingLadder rows; contact-bubble extent is measured separately (probe D + C).',
    },
  },
};

// Fill the B-PREC-01 budget input from the measured walk row.
const globalF32Walk = report.probes.B_precision.walkJitter.find(
  (r: { offsetMetres: number; mode: string }) => r.offsetMetres === 1e7 && r.mode === 'global-f32',
);
report.budgetInputs.bPrec01.value = globalF32Walk ? globalF32Walk.maxStoredPositionErrorMetres : null;

const out = 'tools/spikes/s0.1/report.json';
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log('wrote', out);
