// Kwetu — server-side kinematic validator (ADR-007 contract port).
//
// This is the Phase-5 Go-runtime implementation of the ADR-007 validation
// contract: versioned kinematic replay with clamped client claims. It is
// ported op-for-op from the measured spike validator
// tools/spikes/s0.6/go-validator/main.go (same f64 operation order, so the
// measured cross-language agreement applies to this file too) and it owns:
//
//   - the trapezoidal step speed (Decision 2 — the end-of-tick-speed model is
//     a proven defect: a·dt²/2 per accelerating tick, 0.1665 m over the spike
//     ramp; this port reproduces the v2 trapezoidal model only),
//   - the clamp constants (Decision 3, [PLACEHOLDER — gate: Phase 4 ratify
//     the per-vehicle-class table]),
//   - the accept threshold (Decision 4, [PLACEHOLDER — gate: Phase 4/5
//     ratify against the real vehicle path]).
//
// WHAT THIS IS NOT (ADR-007 Decision 5 / NETWORKING.md §6): no server-side
// Rapier or any contact solver; no collision/crash outcome authority
// (contact resolution stays client-visual); no input re-simulation (the
// replay only follows clamped client-reported speed/heading). The accurate
// phrase is "server-validated kinematics" — never "server-authoritative
// physics".
package main

import (
	"errors"
	"math"
)

var (
	errEmptySession = errors.New("validator: session.states must be non-empty")
	errBadDt        = errors.New("validator: session.dt must be > 0")
)

// Validator clamps (ADR-007 Decision 3 prototype values for a road car).
// [PLACEHOLDER — gate: Phase 4 ratify per-vehicle-class: reverse, boost,
// aircraft classes].
const (
	validatorMaxAccel   = 6.0  // m/s^2, symmetric accel/decel
	validatorMaxYawRate = 2.5  // rad/s
	validatorMaxSpeed   = 55.0 // m/s
	validatorMinSpeed   = 0.0  // m/s, no reverse in this model revision
)

// Proposed production accept threshold: max cumulative position drift per
// replay window (m). ADR-007 Decision 4 [PLACEHOLDER — gate: Phase 4/5
// ratify; the measured legal bound is 4.524e-5 m (B-VAL-01) × 2.2e4 safety
// factor, against a synthetic client — a real Rapier vehicle will drift
// more].
const validatorAcceptThreshold = 1.0

// ReplayWindowTicks is the live-match replay window length in ticks: the max
// per-tick drift is measured over this many most-recent ticks (60 s at the
// 20 Hz match tick). ADR-007 measures a 60 s session window; the live runtime
// keeps the same window length. [PLACEHOLDER — gate: Phase 5 netcode design
// doc ratifies the live window + resync cadence.]
const validatorWindowTicks = 1200

// WireState is one client-reported movement state at wire precision
// (ADR-007 Decision 1: {t, pos[3], yaw, speed}; t = tick index, seconds =
// t·dt). Numbers arrive as f32 on the wire and are widened to f64 here —
// the f32 quantization is part of the measured contract (the replay noise
// floor includes it).
type WireState struct {
	T     int64
	Pos   [3]float64
	Yaw   float64
	Speed float64
}

// ReplayState is the validator's own integrated state (the trusted authority
// while a session is under replay).
type ReplayState struct {
	Px, Py, Pz float64
	Yaw        float64
	Speed      float64
}

// Clamp validates and seeds a replay from the trusted init state (ADR-007
// Decision 1: "the trusted init state plus per-tick client-reported states").
func NewReplayState(init WireState) ReplayState {
	return ReplayState{
		Px:    init.Pos[0],
		Py:    init.Pos[1],
		Pz:    init.Pos[2],
		Yaw:   init.Yaw,
		Speed: init.Speed,
	}
}

// ValidatorClamp wraps a value to (-pi, pi]. math.Mod is IEEE fmod (sign of
// the dividend), the same primitive as JS %, so the arithmetic matches the
// spike's TS mirror bitwise for identical inputs.
func ValidatorWrapAngle(a float64) float64 {
	a = math.Mod(a+math.Pi, 2*math.Pi)
	if a < 0 {
		a += 2 * math.Pi
	}
	return a - math.Pi
}

// validatorClamp is the spike's clamp helper (kept private; the constants
// above are the contract surface).
func validatorClamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// ValidatorStep advances the replay one tick against the client's reported
// state and returns (positionDrift, headingDrift) for that tick. The
// arithmetic order mirrors tools/spikes/s0.6/go-validator/main.go line for
// line:
//
//	w = clamp(wrapAngle(reportedYaw − replayYaw)/dt, ±maxYawRate)
//	v = clamp(reportedSpeed, v_prev ± maxAccel·dt), then clamp(v, minSpeed, maxSpeed)
//	vStep = (v_prev + v)/2            (trapezoidal — ADR-007 Decision 2)
//	yawMid = yaw + w·dt/2
//	pos += vStep·dt·[cos yawMid, sin yawMid]
//	yaw += w·dt
//
// The client's claims are never adopted: only clamped values enter the
// integration, which is what makes illegal claims diverge.
func ValidatorStep(rs *ReplayState, reported *WireState, dt float64) (posDrift, headingDrift float64) {
	vPrev := rs.Speed
	wReq := ValidatorWrapAngle(reported.Yaw-rs.Yaw) / dt
	w := validatorClamp(wReq, -validatorMaxYawRate, validatorMaxYawRate)
	vReq := validatorClamp(reported.Speed, vPrev-validatorMaxAccel*dt, vPrev+validatorMaxAccel*dt)
	v := validatorClamp(vReq, validatorMinSpeed, validatorMaxSpeed)
	vStep := (vPrev + v) * 0.5
	yawMid := rs.Yaw + w*dt*0.5
	step := vStep * dt
	rs.Px += step * math.Cos(yawMid)
	rs.Py += step * math.Sin(yawMid)
	rs.Yaw += w * dt
	rs.Speed = v

	dx := rs.Px - reported.Pos[0]
	dy := rs.Py - reported.Pos[1]
	dz := rs.Pz - reported.Pos[2]
	posDrift = math.Sqrt(dx*dx + dy*dy + dz*dz)
	headingDrift = math.Abs(ValidatorWrapAngle(rs.Yaw - reported.Yaw))
	return posDrift, headingDrift
}

// DriftWindow is a fixed-length ring of recent per-tick position drifts; the
// verdict compares the window max against the accept threshold (ADR-007
// Decision 4: "max cumulative position drift over the replay window").
type DriftWindow struct {
	buf    []float64
	next   int
	filled int
	max    float64
}

// NewDriftWindow builds a window of the given tick length.
func NewDriftWindow(ticks int) *DriftWindow {
	if ticks < 1 {
		ticks = 1
	}
	return &DriftWindow{buf: make([]float64, ticks)}
}

// Push records one tick's drift and returns the current window max.
func (w *DriftWindow) Push(d float64) float64 {
	if w.filled < len(w.buf) {
		// Window still filling: the running max is exact.
		w.buf[w.next] = d
		w.next = (w.next + 1) % len(w.buf)
		w.filled++
		if d > w.max {
			w.max = d
		}
		return w.max
	}
	evicted := w.buf[w.next] // the slot leaving the window
	w.buf[w.next] = d
	w.next = (w.next + 1) % len(w.buf)
	switch {
	case evicted >= w.max:
		// The max left the window: recompute over the window, which now
		// already contains d (the common case — a non-max tick — is O(1)).
		w.max = 0
		for _, v := range w.buf {
			if v > w.max {
				w.max = v
			}
		}
	case d > w.max:
		// A new spike entered a full window: it must raise the max even
		// though nothing was evicted. (Without this branch a fresh spike
		// was silently dropped until the next max aged out — the reject
		// verdict would under-report exactly when a tamper starts.)
		w.max = d
	}
	return w.max
}

// Max returns the current window max without pushing.
func (w *DriftWindow) Max() float64 {
	return w.max
}

// ValidateSession replays a whole recorded session from the trusted init and
// returns the result contract identical to the spike's
// {maxDrift, maxHeadingDrift, tickOfMax, verdict} (tickOfMax is 1-based).
// threshold < 0 means the proposed production threshold. Used by the parity
// tests against the S0.6 recorded sessions.
type SessionResult struct {
	MaxDrift        float64
	MaxHeadingDrift float64
	TickOfMax       int64
	Verdict         string
}

func ValidateSession(init WireState, states []WireState, dt, threshold float64) (SessionResult, error) {
	if !(dt > 0) {
		return SessionResult{}, errBadDt
	}
	if len(states) == 0 {
		return SessionResult{}, errEmptySession
	}
	rs := NewReplayState(init)
	out := SessionResult{Verdict: "pass"}
	for i := range states {
		d, h := ValidatorStep(&rs, &states[i], dt)
		if d > out.MaxDrift {
			out.MaxDrift = d
			out.TickOfMax = int64(i + 1)
		}
		if h > out.MaxHeadingDrift {
			out.MaxHeadingDrift = h
		}
	}
	if out.MaxDrift >= threshold {
		out.Verdict = "reject"
	}
	return out, nil
}
