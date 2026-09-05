/**
 * S0.1 probe C — contact-bubble probe runner (throwaway spike, vitest).
 *
 * Asserts the COORDINATE_SYSTEM.md §8 / Law PH-1 invariants the probes measure.
 * Bounds are the measured classes, commented with the values they pin; the
 * probe asserts the invariants — a failing invariant is a finding, not a
 * threshold to loosen.
 */
import { describe, it, expect } from 'vitest';
import { collectBubbleReport, STEP_COUNT, DT_SECONDS, REBASE_OFFSET_METRES } from './bubbleProbe.ts';

describe('S0.1 C: Rapier contact bubble (Z-up, gravity (0,0,-9.80665), dt=1/60)', () => {
  let report: Awaited<ReturnType<typeof collectBubbleReport>>;
  it('builds the bubble report', async () => {
    report = await collectBubbleReport();
    expect(report.config.worldGravity).toEqual([0, 0, -9.80665]);
    expect(report.config.dtSeconds).toBeCloseTo(DT_SECONDS, 15);
    expect(report.config.build).toContain('0.20.0');
  });

  // --- (i) resting-contact stability -----------------------------------------
  it('(i) resting contact holds 600 steps: no tunnelling, sub-mm-class penetration, no creep', () => {
    const r = report.resting;
    // Pad box (flat ground): penetration 6.875e-5 m, zero drift/creep/speed.
    expect(r.padBox.minZMetres).toBeGreaterThan(0.49); // no tunnelling through the pad top (z=0)
    expect(r.padBox.maxPenetrationMetres).toBeLessThan(1e-3);
    expect(r.padBox.maxVerticalDriftMetres).toBeLessThan(1e-6);
    expect(r.padBox.maxHorizontalCreepMetres).toBeLessThan(1e-6);
    expect(r.padBox.maxSpeedMetresPerSecond).toBeLessThan(1e-6);
    expect(r.padBox.maxEnergyProxyDeviationJoules).toBeLessThan(1e-6);
    // Ramp box (15° friction ramp, tan 15° < 0.7): static friction holds it.
    expect(r.rampBox.maxPenetrationMetres).toBeLessThan(5e-3); // measured 1.056e-3
    expect(r.rampBox.maxVerticalDriftMetres).toBeLessThan(1e-4);
    expect(r.rampBox.maxHorizontalCreepMetres).toBeLessThan(1e-6);
    expect(r.rampBox.maxSpeedMetresPerSecond).toBeLessThan(1e-6);
    // The active (never-sleeping) solver holds the same class.
    expect(report.restingAwake.padBox.maxPenetrationMetres).toBeLessThan(1e-3);
    expect(report.restingAwake.padBox.maxHorizontalCreepMetres).toBeLessThan(1e-4);
    expect(report.restingAwake.padBox.maxVerticalDriftMetres).toBeLessThan(1e-4);
    expect(report.restingAwake.rampBox.maxPenetrationMetres).toBeLessThan(5e-3);
  });

  // --- (ii) joint stability ----------------------------------------------------
  it('(ii) fixed joint under gravity: zero measurable anchor drift and sag over 600 steps', () => {
    const j = report.joint;
    expect(j.hangingMassKg).toBeGreaterThan(500); // ~523.6 kg ball bears on the joint
    expect(j.maxAnchorDriftMetres).toBe(0);
    expect(j.finalAnchorDriftMetres).toBe(0);
    expect(j.maxSagMetres).toBe(0);
  });

  // --- (iii) origin rebase at a tick boundary ---------------------------------
  it('(iii) naive whole-world f32 shift: separation corruption measured, contact silently killed', () => {
    const n = report.rebase.naive;
    expect(report.rebase.f32SpacingAtRebaseMetres).toBe(0.5); // 2^22 <= 5e6 < 2^23
    // Injected corruption: pad pair loses its 1 mm drop-in; ramp pair gains ~0.27 m.
    expect(n.padSeparationErrorMetres).toBeCloseTo(-1e-3, 9);
    expect(n.rampSeparationErrorMetres).toBeGreaterThan(0.2);
    expect(n.rampSeparationErrorMetres).toBeLessThan(0.35);
    // Phantom state with default sleeping: free-fall velocity accumulates
    // (4.903 m/s = g * 0.5 s) while positions are frozen; bodies sleep spuriously.
    expect(n.padPhantomVelocityAtSleepMetresPerSecond).toBeGreaterThan(4);
    expect(n.padPhantomVelocityAtSleepMetresPerSecond).toBeLessThan(6);
    expect(n.rampBoxFloatingAboveContactMetres).toBeGreaterThan(0.2); // ends asleep, floating
    // With sleeping disabled the failure is unmasked: contact dead, tunnelling.
    expect(n.sleepDisabled.maxSpeedMetresPerSecond).toBeGreaterThan(90); // ~g * 10 s
    expect(n.sleepDisabled.stepsPositionFrozen).toBeGreaterThan(100);
    expect(n.sleepDisabled.tunnelledThroughSlab).toBe(true);
    expect(n.sleepDisabled.finalPenetrationBelowGroundTopMetres).toBeGreaterThan(100);
  });

  it('(iii) compliant Law P-6 re-derivation: post-rebase stability identical to pre-rebase', () => {
    const pre = report.rebase.pre;
    const c = report.rebase.compliant;
    expect(c.padBox.maxPenetrationMetres).toBe(pre.padBox.maxPenetrationMetres);
    expect(c.rampBox.maxPenetrationMetres).toBe(pre.rampBox.maxPenetrationMetres);
    expect(c.padBox.maxVerticalDriftMetres).toBeLessThan(1e-6);
    expect(c.padBox.maxHorizontalCreepMetres).toBeLessThan(1e-6);
    expect(c.padBox.maxSpeedMetresPerSecond).toBeLessThan(1e-6);
    expect(c.maxJointAnchorDriftMetres).toBeLessThan(1e-6);
    // Bubble-local coordinates stay small — the whole point of the anchor move.
    expect(report.rebase.rebaseOffsetMetres).toBe(5_000_000);
    expect(report.rebase.maxBubbleLocalCoordinateMetres).toBeLessThan(10);
  });

  // --- (iv) two independent bubbles at separated Earth locations --------------
  it('(iv) two bubbles ~7330 km apart simulate simultaneously, zero cross-talk by construction', () => {
    const t = report.twoBubbles;
    expect(t.anchorSeparationMetres).toBeGreaterThan(7.0e6); // Dar es Salaam <-> Oslo
    expect(t.anchorSeparationMetres).toBeLessThan(7.5e6);
    expect(t.bitwiseCrossTalkCheckPassed).toBe(true);
    // Both bubbles match the single-bubble resting class...
    expect(t.dar.padBox.maxPenetrationMetres).toBeLessThan(1e-3);
    expect(t.oslo.padBox.maxPenetrationMetres).toBeLessThan(1e-3);
    expect(t.dar.rampBox.maxPenetrationMetres).toBeLessThan(5e-3);
    expect(t.oslo.rampBox.maxPenetrationMetres).toBeLessThan(5e-3);
    // ...and, being identical layouts in independent worlds, are bitwise equal.
    expect(JSON.stringify(t.oslo)).toBe(JSON.stringify(t.dar));
  });

  // --- (v) rebase with axes change ---------------------------------------------
  it('(v) rebase with 90° yaw axes change: f32-class residuals, contact holds, joint intact', () => {
    const a = report.axesRebase;
    expect(a.yawRad).toBeCloseTo(Math.PI / 2, 15);
    // Re-derived state f32 downcast at ~km coordinates: residual ~ f32 ULP there.
    expect(a.maxPositionResidualMetres).toBeGreaterThan(0);
    expect(a.maxPositionResidualMetres).toBeLessThan(1e-4); // measured 2.44e-5 m
    expect(a.maxVelocityResidualMetresPerSecond).toBe(0);
    expect(a.maxOrientationResidualQuaternionNorm).toBeLessThan(1e-6); // measured 6.7e-8
    // Post-rebase contact stability is the pre-rebase class.
    expect(a.post.padBox.maxPenetrationMetres).toBeLessThan(1e-3);
    expect(a.post.padBox.maxVerticalDriftMetres).toBeLessThan(1e-6);
    expect(a.post.rampBox.maxPenetrationMetres).toBeLessThan(5e-3);
    expect(a.post.rampBox.maxVerticalDriftMetres).toBeLessThan(1e-3); // measured 5.4e-5 m re-settle
    // The fixed joint survives the axes change.
    expect(a.post.maxJointAnchorDriftMetres).toBeLessThan(1e-6); // measured 2.4e-7 m
  });

  // --- (vi) ROADMAP §9 matrix items: Z-up jump/vehicle axes/parent-relative exit ---
  it('(vi-a) Z-up jump: ballistic +Z excursion stays on the axis, lands, re-rests', () => {
    const j = report.gateMatrix.jump;
    expect(j.launchSpeedMetresPerSecond).toBe(3.0);
    // Apex within one-dt discretization class of continuous physics.
    expect(Math.abs(j.apexMinusContinuousMetres)).toBeLessThan(0.05);
    expect(j.measuredApexMetres).toBeGreaterThan(j.launchHeightMetres + 0.3);
    // The Z-up axis law: the ballistic phase must not drift laterally
    // (measured 1.65e-4 m over a 0.61 s flight — launch-contact solver noise).
    // (Post-landing contact micro-slide is recorded separately as an artifact.)
    expect(j.maxHorizontalCreepAirborneMetres).toBeLessThan(1e-3);
    // It lands back into the same resting contact (mm penetration, at rest).
    expect(j.finalRestPenetrationMetres).toBeLessThan(1e-3);
    expect(j.finalRestSpeedMetresPerSecond).toBeLessThan(1e-6);
  });

  it('(vi-b) vehicle axes: yawed chassis keeps ENU up and heading; local gravity stays (0,0,-g)', () => {
    const v = report.gateMatrix.vehicleAxes;
    expect(v.yawRad).toBeCloseTo(Math.PI / 6, 15);
    // Up stays ENU up; the 30° heading is preserved (no hidden axis flip).
    expect(v.finalUpAlignmentErrorRad).toBeLessThan(1e-3);
    expect(v.finalYawErrorRad).toBeLessThan(1e-3);
    // Z-up gravity pulls straight down: no lateral creep of the chassis.
    expect(v.maxHorizontalCreepMetres).toBeLessThan(1e-3);
    expect(v.finalPenetrationMetres).toBeLessThan(5e-3);
    // World gravity in the vehicle frame is (0,0,-g) for any yaw (§8).
    expect(v.localGravityDeviationMetresPerSecond2).toBeLessThan(0.01);
  });

  it('(vi-c) parent-relative exit: jointed child tracks v_parent + ω×r; handover injects zero delta-V', () => {
    const e = report.gateMatrix.parentExit;
    expect(e.parentAngularVelocityRadPerSecond).toBeCloseTo(1.0, 6);
    expect(e.parentLinearVelocityMetresPerSecond.x).toBeCloseTo(0.5, 6);
    // The rigid joint holds the 1 m offset (pose fidelity, constraint hold)...
    expect(e.maxPoseResidualMetres).toBeLessThan(1e-4);
    expect(e.maxOffsetDriftMetres).toBeLessThan(1e-4);
    // ...the child velocity equals the exit formula v_parent + ω × r_offset...
    expect(e.carryVelocityErrorAtExitMetresPerSecond).toBeLessThan(0.01);
    expect(e.maxCarryVelocityErrorLast60StepsMetresPerSecond).toBeLessThan(0.01);
    // ...and the tick-boundary handover applies exactly the captured velocity.
    expect(e.injectedDeltaVMetresPerSecond).toBe(0);
    expect(e.postExitMaxTrajectoryDeviationMetres).toBeLessThan(5e-3);
    // The rolling-body caveat: a merely-RESTING body reaches only ~2/7 of the
    // surface velocity (rolling-sphere carry) — it must NOT be handed the
    // attachment-point velocity on exit.
    expect(e.rollingBodyCarryRatioAtExit).toBeGreaterThan(0.2);
    expect(e.rollingBodyCarryRatioAtExit).toBeLessThan(0.35);
  });

  it('report carries the S0.1 verdict and full config', () => {
    expect(report.rebase.verdict).toContain('HOLDS');
    expect(report.config.stepCount).toBe(STEP_COUNT);
    expect(report.config.solver).toContain('numSolverIterations 4');
    expect(report.config.massesKg.padBox).toBeCloseTo(1000, 2);
  });
});
