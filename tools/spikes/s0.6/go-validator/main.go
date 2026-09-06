// S0.6 spike — server-side kinematic validator prototype (throwaway probe).
//
// This is the Phase-5 Nakama Go-runtime validator in miniature: pure Go stdlib,
// no physics engine, no Rapier (ADR-001 Decision 5 — bounded movement validation,
// never full server-authoritative contact physics; NETWORKING.md §6/§8).
//
// It reads a recorded client session (sessions/legal.json | tampered.json, format in
// gen-session.mjs), replays it from the trusted init state with the client-reported
// heading and speed CLAMPED to legal limits, and reports per-tick + max cumulative
// drift |posReplay - posReported| and heading drift. Exit code 0 = accept
// (max drift under threshold), 1 = reject, 2 = malformed input.
//
// The replay model is mirrored op-for-op in tools/spikes/s0.6/ts-mirror.mjs — running
// both over the same session measures Go-vs-V8 f64 agreement (recorded in ADR-007).
//
// Build/run (repo root mount):
//
//	docker run --rm -v C:/Users/lugat/Projects/kwetu:/src -w //src/tools/spikes/s0.6 \
//	  golang:1.24-alpine go run ./go-validator -in sessions/legal.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"time"
)

// The contract's legal clamps (rationale and provenance in ADR-007). The client is
// free to claim any speed/yaw rate it likes; the validator only ever integrates
// clamped values, which is what makes illegal claims diverge.
const (
	maxAccel   = 6.0  // m/s^2, symmetric accel/decel
	maxYawRate = 2.5  // rad/s
	maxSpeed   = 55.0 // m/s (~198 km/h)
	minSpeed   = 0.0  // m/s, no reverse in this model revision

	// Spike pass threshold placeholder — ADR-007 proposes the production value.
	defaultThreshold = 5.0 // m, max cumulative position drift
)

type vec3 [3]float64

type state struct {
	T     int     `json:"t"`
	Pos   vec3    `json:"pos"`
	Yaw   float64 `json:"yaw"`
	Speed float64 `json:"speed"`
}

type session struct {
	DT     float64 `json:"dt"`
	Ticks  int     `json:"ticks"`
	Init   state   `json:"init"`
	States []state `json:"states"`
}

// result is the compact stdout contract, identical in the Go validator and ts-mirror.mjs.
type result struct {
	MaxDrift        float64 `json:"maxDrift"`
	MaxHeadingDrift float64 `json:"maxHeadingDrift"`
	TickOfMax       int     `json:"tickOfMax"`
	Verdict         string  `json:"verdict"`
}

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// wrapAngle wraps to (-pi, pi]. math.Mod is IEEE fmod (sign of the dividend), the same
// primitive as JS %, so this matches ts-mirror.mjs bitwise for identical inputs.
func wrapAngle(a float64) float64 {
	a = math.Mod(a+math.Pi, 2*math.Pi)
	if a < 0 {
		a += 2 * math.Pi
	}
	return a - math.Pi
}

type replayOut struct {
	res     result
	perTick []float64
	perHead []float64
}

// validate replays the session and measures drift. The arithmetic order mirrors
// ts-mirror.mjs line for line; only math.Cos/math.Sin may differ from V8 by ~1 ULP,
// which is exactly what the cross-language agreement run measures.
func validate(sess *session, threshold float64) (replayOut, error) {
	if !(sess.DT > 0) {
		return replayOut{}, fmt.Errorf("session.dt must be > 0")
	}
	if len(sess.States) == 0 {
		return replayOut{}, fmt.Errorf("session.states must be non-empty")
	}
	if len(sess.States) != sess.Ticks {
		return replayOut{}, fmt.Errorf("states length %d != ticks %d", len(sess.States), sess.Ticks)
	}

	dt := sess.DT
	px, py, pz := sess.Init.Pos[0], sess.Init.Pos[1], sess.Init.Pos[2]
	yaw := sess.Init.Yaw
	v := sess.Init.Speed

	aMaxDt := maxAccel * dt

	out := replayOut{
		res:     result{TickOfMax: 0, Verdict: "pass"},
		perTick: make([]float64, len(sess.States)),
		perHead: make([]float64, len(sess.States)),
	}

	for i := range sess.States {
		s := &sess.States[i]
		vPrev := v
		wReq := wrapAngle(s.Yaw-yaw) / dt
		w := clamp(wReq, -maxYawRate, maxYawRate)
		vReq := clamp(s.Speed, vPrev-aMaxDt, vPrev+aMaxDt)
		v = clamp(vReq, minSpeed, maxSpeed)
		vStep := (vPrev + v) * 0.5 // trapezoidal step speed — replay v1 (end-of-tick speed) biased every accel tick by a*dt^2/2 (ADR-007 Evidence)
		yawMid := yaw + w*dt*0.5
		step := vStep * dt
		px += step * math.Cos(yawMid)
		py += step * math.Sin(yawMid)
		yaw += w * dt
		dx := px - s.Pos[0]
		dy := py - s.Pos[1]
		dz := pz - s.Pos[2]
		d := math.Sqrt(dx*dx + dy*dy + dz*dz) // plain sqrt: correctly rounded in Go and JS
		h := math.Abs(wrapAngle(yaw - s.Yaw))
		out.perTick[i] = d
		out.perHead[i] = h
		if d > out.res.MaxDrift {
			out.res.MaxDrift = d
			out.res.TickOfMax = i + 1 // 1-based tick index
		}
		if h > out.res.MaxHeadingDrift {
			out.res.MaxHeadingDrift = h
		}
	}
	if out.res.MaxDrift < threshold {
		out.res.Verdict = "pass"
	} else {
		out.res.Verdict = "reject"
	}
	return out, nil
}

func main() {
	in := flag.String("in", "", "session JSON path (required)")
	threshold := flag.Float64("threshold", defaultThreshold, "max cumulative drift pass threshold (m)")
	bench := flag.Int("bench", 0, "if > 0, replay the session N times and report ns/tick on stderr")
	flag.Parse()

	if *in == "" {
		fmt.Fprintln(os.Stderr, "usage: go-validator -in <session.json> [-threshold M] [-bench N]")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read session: %v\n", err)
		os.Exit(2)
	}
	var sess session
	if err := json.Unmarshal(raw, &sess); err != nil {
		fmt.Fprintf(os.Stderr, "parse session: %v\n", err)
		os.Exit(2)
	}

	if *bench > 0 {
		const benchThreshold = defaultThreshold
		reps := *bench
		// warmup
		if _, err := validate(&sess, benchThreshold); err != nil {
			fmt.Fprintf(os.Stderr, "validate: %v\n", err)
			os.Exit(2)
		}
		start := time.Now()
		for i := 0; i < reps; i++ {
			if _, err := validate(&sess, benchThreshold); err != nil {
				fmt.Fprintf(os.Stderr, "validate: %v\n", err)
				os.Exit(2)
			}
		}
		elapsed := time.Since(start)
		nsPerSession := float64(elapsed.Nanoseconds()) / float64(reps)
		b, _ := json.Marshal(struct {
			BenchRepeats int     `json:"benchRepeats"`
			NsPerSession float64 `json:"nsPerSession"`
			NsPerTick    float64 `json:"nsPerTick"`
		}{reps, nsPerSession, nsPerSession / float64(len(sess.States))})
		fmt.Fprintln(os.Stderr, string(b))
	}

	out, err := validate(&sess, *threshold)
	if err != nil {
		fmt.Fprintf(os.Stderr, "validate: %v\n", err)
		os.Exit(2)
	}
	b, err := json.Marshal(out.res)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal result: %v\n", err)
		os.Exit(2)
	}
	fmt.Println(string(b))
	if out.res.Verdict != "pass" {
		os.Exit(1)
	}
}
