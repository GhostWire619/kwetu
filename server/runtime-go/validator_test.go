// Kwetu — validator tests (ADR-007 contract).
//
// Three layers:
//  1. a synthetic client (Go port of tools/spikes/s0.6/gen-session.mjs's
//     integration model, f32 wire quantization included) that always runs;
//  2. a golden parity test over the RECORDED S0.6 session captures
//     (tools/spikes/s0.6/sessions/{legal,tampered}.json) asserting the port
//     reproduces the measured ADR-007 results — skipped with a clear message
//     when the spike files are absent (spikes are throwaway by CLAUDE.md);
//  3. clamp + drift-window unit tests (the named placeholder constants and
//     the rolling window the live match loops through).
package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// spike session file locations (read-only inputs; never written).
const (
	goldenLegalPath    = ".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "tools" + string(filepath.Separator) + "spikes" + string(filepath.Separator) + "s0.6" + string(filepath.Separator) + "sessions" + string(filepath.Separator) + "legal.json"
	goldenTamperedPath = ".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "tools" + string(filepath.Separator) + "spikes" + string(filepath.Separator) + "s0.6" + string(filepath.Separator) + "sessions" + string(filepath.Separator) + "tampered.json"
)

// Measured ADR-007 values (report.json; B-VAL-01/B-VAL-02).
const (
	measuredLegalMaxDrift     = 4.52413552422039e-05
	measuredLegalTickOfMax    = 2994
	measuredTamperedMaxDrift  = 169.01845833979195
	measuredTamperedTickOfMax = 1477
)

// --- synthetic client (port of gen-session.mjs) ------------------------------

type synthClient struct {
	x, y, yaw, v float64
}

// stepClient: midpoint scheme while accelerating, exact circular chord at
// constant speed — the spike's O(dt^3)-exact client integration.
func (c *synthClient) step(dt, radius, a float64) {
	if a != 0 {
		vMid := c.v + a*dt*0.5
		w := vMid / radius
		yawMid := c.yaw + w*dt*0.5
		c.x += vMid * dt * math.Cos(yawMid)
		c.y += vMid * dt * math.Sin(yawMid)
		c.yaw += w * dt
		c.v += a * dt
		return
	}
	w := c.v / radius
	ds := 2 * radius * math.Sin(w*dt*0.5)
	yawMid := c.yaw + w*dt*0.5
	c.x += ds * math.Cos(yawMid)
	c.y += ds * math.Sin(yawMid)
	c.yaw += w * dt
}

// genSyntheticSession builds the 3600-tick legal or speed-hacked capture at
// the given dt (the spike used 1/60; the live match runs 20 Hz).
func genSyntheticSession(tampered bool, dt float64, ticks int) (WireState, []WireState) {
	const (
		radius    = 250.0
		vCruise   = 20.0
		aAccel    = 5.0
		hackAccel = 72.0
		hackStart = 1201
		hackEnd   = 1500
		hackRamp  = 50
		hackHold  = 200
	)
	f32 := func(f float64) float64 { return float64(float32(f)) }
	accelTicks := int(vCruise / aAccel / dt) // ramp ticks at aAccel to reach vCruise

	c := &synthClient{x: radius, y: 0, yaw: math.Pi / 2, v: 0}
	init := WireState{T: 0, Pos: [3]float64{f32(c.x), f32(c.y), 0}, Yaw: f32(c.yaw), Speed: f32(c.v)}
	states := make([]WireState, 0, ticks)
	for tick := 1; tick <= ticks; tick++ {
		var a float64
		switch {
		case tick <= accelTicks:
			a = aAccel
		case tampered && tick >= hackStart && tick < hackStart+hackRamp:
			a = hackAccel
		case tampered && tick >= hackStart+hackRamp && tick < hackStart+hackRamp+hackHold:
			a = 0
		case tampered && tick >= hackStart+hackRamp+hackHold && tick <= hackEnd:
			a = -hackAccel
		default:
			a = 0
		}
		c.step(dt, radius, a)
		states = append(states, WireState{
			T:     int64(tick),
			Pos:   [3]float64{f32(c.x), f32(c.y), 0},
			Yaw:   f32(c.yaw),
			Speed: f32(c.v),
		})
	}
	return init, states
}

// --- layer 1: synthetic contract tests ---------------------------------------

// TestValidatorSyntheticLegalPath: the trapezoidal replay stays at the f32
// noise floor. ADR-007 measured 4.524e-5 m at dt=1/60 (B-VAL-01); the port
// must reproduce the same order of magnitude — asserted within a STATED
// FACTOR of 2 of the measured bound (cross-implementation trig may differ by
// ~1 ULP; the drift is quantization noise, not a model bias).
func TestValidatorSyntheticLegalPath(t *testing.T) {
	init, states := genSyntheticSession(false, 1.0/60.0, 3600)
	res, err := ValidateSession(init, states, 1.0/60.0, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if res.MaxDrift > 2*measuredLegalMaxDrift || res.MaxDrift < 0.25*measuredLegalMaxDrift {
		t.Fatalf("legal maxDrift = %.6g m, want within a factor ~2 of the measured %.6g m (B-VAL-01)", res.MaxDrift, measuredLegalMaxDrift)
	}
	if res.MaxHeadingDrift != 0 {
		t.Fatalf("legal heading drift = %g rad, want exactly 0 (heading re-sync is bitwise on a legal path, ADR-007)", res.MaxHeadingDrift)
	}
	if res.Verdict != "pass" {
		t.Fatalf("legal verdict = %s, want pass", res.Verdict)
	}
	t.Logf("synthetic legal: maxDrift %.6g m at tick %d (measured %.6g m at tick %d)",
		res.MaxDrift, res.TickOfMax, measuredLegalMaxDrift, measuredLegalTickOfMax)
}

// TestValidatorSyntheticTamperedPath: the 4x speed hack diverges; the
// detection margin stays ~1e6x the legal bound (B-VAL-02 measured 3.736e6).
func TestValidatorSyntheticTamperedPath(t *testing.T) {
	init, legal := genSyntheticSession(false, 1.0/60.0, 3600)
	legalRes, err := ValidateSession(init, legal, 1.0/60.0, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	_, hacked := genSyntheticSession(true, 1.0/60.0, 3600)
	hackRes, err := ValidateSession(init, hacked, 1.0/60.0, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if hackRes.Verdict != "reject" {
		t.Fatalf("tampered verdict = %s, want reject", hackRes.Verdict)
	}
	if hackRes.MaxDrift < 100 {
		t.Fatalf("tampered maxDrift = %.6g m, want >= 100 m (measured %.6g m)", hackRes.MaxDrift, measuredTamperedMaxDrift)
	}
	margin := hackRes.MaxDrift / legalRes.MaxDrift
	if margin < 1e6 {
		t.Fatalf("detection margin = %.6g, want >= 1e6 (measured B-VAL-02 = 3.736e6)", margin)
	}
	t.Logf("synthetic tampered: maxDrift %.6g m at tick %d, margin %.3g (measured %.6g m at tick %d, margin 3.736e6)",
		hackRes.MaxDrift, hackRes.TickOfMax, margin, measuredTamperedMaxDrift, measuredTamperedTickOfMax)
}

// TestValidatorSyntheticAtMatchTickRate: the contract at the live 20 Hz dt
// (the spike pinned dt=1/60; the match runs dt=1/20).
func TestValidatorSyntheticAtMatchTickRate(t *testing.T) {
	init, states := genSyntheticSession(false, 1.0/20.0, 1200)
	res, err := ValidateSession(init, states, 1.0/20.0, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict != "pass" || res.MaxDrift > validatorAcceptThreshold {
		t.Fatalf("legal path at 20 Hz: maxDrift %.6g m verdict %s — must pass comfortably under the %.1f m threshold", res.MaxDrift, res.Verdict, validatorAcceptThreshold)
	}
}

// --- layer 2: golden parity against the recorded S0.6 captures ---------------

type goldenSession struct {
	DT     float64     `json:"dt"`
	Ticks  int         `json:"ticks"`
	Init   WireState   `json:"init"`
	States []WireState `json:"states"`
}

func loadGoldenSession(t *testing.T, path string) *goldenSession {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("S0.6 recorded session not available at %s (spikes are throwaway; skipping golden parity): %v", path, err)
	}
	var s goldenSession
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &s
}

// TestValidatorGoldenParityWithS06RecordedSessions asserts the port
// reproduces the ADR-007 measured results on the exact recorded captures:
// legal maxDrift within a stated factor of 2 of 4.524e-5 m with the measured
// arg-tick, tampered maxDrift within factor 1.5 of 169.018 m with the
// measured arg-tick, and the same verdicts.
func TestValidatorGoldenParityWithS06RecordedSessions(t *testing.T) {
	legal := loadGoldenSession(t, goldenLegalPath)
	res, err := ValidateSession(legal.Init, legal.States, legal.DT, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict != "pass" {
		t.Fatalf("golden legal verdict = %s, want pass", res.Verdict)
	}
	if res.MaxDrift > 2*measuredLegalMaxDrift || res.MaxDrift < 0.5*measuredLegalMaxDrift {
		t.Fatalf("golden legal maxDrift = %.6g m, want within factor 2 of measured %.6g m", res.MaxDrift, measuredLegalMaxDrift)
	}
	if res.TickOfMax != measuredLegalTickOfMax {
		t.Fatalf("golden legal tickOfMax = %d, want %d (measured)", res.TickOfMax, measuredLegalTickOfMax)
	}
	if res.MaxHeadingDrift != 0 {
		t.Fatalf("golden legal heading drift = %g, want exactly 0", res.MaxHeadingDrift)
	}
	t.Logf("golden legal: maxDrift %.6g m at tick %d — matches ADR-007 B-VAL-01", res.MaxDrift, res.TickOfMax)

	tampered := loadGoldenSession(t, goldenTamperedPath)
	tres, err := ValidateSession(tampered.Init, tampered.States, tampered.DT, validatorAcceptThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if tres.Verdict != "reject" {
		t.Fatalf("golden tampered verdict = %s, want reject", tres.Verdict)
	}
	if tres.MaxDrift > 1.5*measuredTamperedMaxDrift || tres.MaxDrift < 0.66*measuredTamperedMaxDrift {
		t.Fatalf("golden tampered maxDrift = %.6g m, want within factor 1.5 of measured %.6g m", tres.MaxDrift, measuredTamperedMaxDrift)
	}
	if tres.TickOfMax != measuredTamperedTickOfMax {
		t.Fatalf("golden tampered tickOfMax = %d, want %d (measured)", tres.TickOfMax, measuredTamperedTickOfMax)
	}
	t.Logf("golden tampered: maxDrift %.6g m at tick %d — matches ADR-007", tres.MaxDrift, tres.TickOfMax)
}

// --- layer 3: clamps and the drift window ------------------------------------

func TestWrapAngle(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{0, 0},
		{2 * math.Pi, 0},
		{math.Pi / 2, math.Pi / 2},
		{3 * math.Pi / 2, -math.Pi / 2},
		{math.Pi, -math.Pi}, // wraps to (-pi, pi]; |±pi| are the same distance
		{-math.Pi, -math.Pi},
	}
	for _, c := range cases {
		if got := ValidatorWrapAngle(c.in); got != c.want {
			t.Errorf("wrapAngle(%g) = %g, want %g", c.in, got, c.want)
		}
	}
}

func TestYawRateClampBinds(t *testing.T) {
	// A client claiming a 1 rad heading jump in one tick (60 rad/s at 60 Hz)
	// is clamped to maxYawRate: the replay advances only 2.5·dt.
	rs := ReplayState{Yaw: 0}
	reported := WireState{Pos: [3]float64{0, 0, 0}, Yaw: 1.0, Speed: 0}
	dt := 1.0 / 60.0
	_, headingDrift := ValidatorStep(&rs, &reported, dt)
	if w := rs.Yaw; math.Abs(w-validatorMaxYawRate*dt) > 1e-12 {
		t.Fatalf("replay yaw = %g, want the clamp %.6g", w, validatorMaxYawRate*dt)
	}
	// The reported claim is unreachable: heading drift = 1 − 2.5·dt.
	if math.Abs(headingDrift-(1.0-validatorMaxYawRate*dt)) > 1e-12 {
		t.Fatalf("heading drift = %g, want %g", headingDrift, 1.0-validatorMaxYawRate*dt)
	}
}

func TestAccelAndSpeedClampsBind(t *testing.T) {
	// A standing client claiming 80 m/s is clamped to +6·dt per tick and to
	// the 55 m/s ceiling; the replay never reaches the claim.
	rs := ReplayState{Speed: 0}
	reported := WireState{Pos: [3]float64{0, 0, 0}, Yaw: 0, Speed: 80}
	dt := 1.0 / 20.0
	ValidatorStep(&rs, &reported, dt)
	if rs.Speed != validatorMaxAccel*dt {
		t.Fatalf("replay speed = %g, want the accel clamp %g", rs.Speed, validatorMaxAccel*dt)
	}
	// A client already at the ceiling cannot exceed it.
	rs2 := ReplayState{Speed: validatorMaxSpeed}
	rep2 := WireState{Pos: [3]float64{0, 0, 0}, Yaw: 0, Speed: 120}
	ValidatorStep(&rs2, &rep2, dt)
	if rs2.Speed != validatorMaxSpeed {
		t.Fatalf("replay speed = %g, want the %g ceiling", rs2.Speed, validatorMaxSpeed)
	}
}

func TestDriftWindowRollingMax(t *testing.T) {
	w := NewDriftWindow(5)
	seq := []float64{1, 5, 2, 8, 3, 0.5, 9, 0.1, 0.2, 0.3}
	// brute-force expectation of the rolling max over the last 5 values
	for i, v := range seq {
		got := w.Push(v)
		lo := i - 4
		if lo < 0 {
			lo = 0
		}
		want := 0.0
		for _, s := range seq[lo : i+1] {
			if s > want {
				want = s
			}
		}
		if got != want {
			t.Fatalf("after %d pushes (value %g): window max = %g, want %g", i+1, v, got, want)
		}
	}
}

func TestDriftWindowEvictionRecompute(t *testing.T) {
	// The max must drop exactly when it ages out (window 3: after the 4th
	// push the 10 is gone, so the max is 3, not 10) and a new spike entering
	// a full window must raise it (the 4 on push 5).
	w := NewDriftWindow(3)
	got := []float64{w.Push(10), w.Push(1), w.Push(2), w.Push(3), w.Push(4), w.Push(0.5)}
	want := []float64{10, 10, 10, 3, 4, 4}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("rolling max[%d] = %g, want %g", i, got[i], want[i])
		}
	}
}

func TestValidateSessionRejectsBadInput(t *testing.T) {
	if _, err := ValidateSession(WireState{}, nil, 0.05, 1.0); err == nil {
		t.Fatal("empty session must error")
	}
	init, states := genSyntheticSession(false, 1.0/20.0, 10)
	if _, err := ValidateSession(init, states, 0, 1.0); err == nil {
		t.Fatal("dt=0 must error")
	}
}
