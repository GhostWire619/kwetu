// Kwetu — snapshot / client-state wire format tests.
//
// These pin the byte ledger the encoder claims in its header (the groundwork
// instantiation of ADR-009's stated wire model: envelope 14 B, record 24 B)
// and the 1500 B message-cap arithmetic (NETWORKING.md §4 rule 1 — the cap
// never moves, CLAUDE.md invariant). The per-opcode ledger itself stays
// [PLACEHOLDER — gate: Phase 5 netcode design doc]; these tests make the
// code agree with ITSELF and with the cap.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"
)

// TestSnapshotRecordByteLayout walks one encoded record byte by byte and
// asserts the exact ledger: id u32 + pos 2×f32 + vel 2×i16 + heading u16 +
// frameId u8 + movementRegime u8 + modelRevision u16 + stateFlags u16 = 24 B.
// (Regression guard: the heading field once silently fell off the wire.)
func TestSnapshotRecordByteLayout(t *testing.T) {
	rec := EntityRecord{
		ID:             0x01020304,
		X:              1.5,
		Z:              -2.5,
		VelX:           -321,
		VelZ:           1234,
		Heading:        0xBEEF,
		FrameID:        7,
		MovementRegime: 3,
		ModelRevision:  0x0201,
		StateFlags:     0x0403,
	}
	data := EncodeSnapshot(nil, 99, []EntityRecord{rec})
	if len(data) != snapshotEnvelopeBytes+snapshotRecordBytes {
		t.Fatalf("one-record snapshot = %d B, want %d", len(data), snapshotEnvelopeBytes+snapshotRecordBytes)
	}
	if got := binary.LittleEndian.Uint32(data[0:4]); got != 99 {
		t.Fatalf("tick = %d, want 99", got)
	}
	if got := binary.LittleEndian.Uint16(data[4:6]); got != 1 {
		t.Fatalf("entityCount = %d, want 1", got)
	}
	if got := binary.LittleEndian.Uint16(data[6:8]); got != 0 {
		t.Fatalf("flags = %d, want 0 (not truncated)", got)
	}
	for i := 8; i < snapshotEnvelopeBytes; i++ {
		if data[i] != 0 {
			t.Fatalf("reserved envelope byte %d = %d, want 0", i, data[i])
		}
	}

	off := snapshotEnvelopeBytes
	if got := binary.LittleEndian.Uint32(data[off : off+4]); int64(got) != rec.ID {
		t.Fatalf("id = %#x, want %#x", got, rec.ID)
	}
	if got := math.Float32frombits(binary.LittleEndian.Uint32(data[off+4 : off+8])); got != rec.X {
		t.Fatalf("x = %v, want %v", got, rec.X)
	}
	if got := math.Float32frombits(binary.LittleEndian.Uint32(data[off+8 : off+12])); got != rec.Z {
		t.Fatalf("z = %v, want %v", got, rec.Z)
	}
	if got := int16(binary.LittleEndian.Uint16(data[off+12 : off+14])); got != rec.VelX {
		t.Fatalf("velX = %d, want %d", got, rec.VelX)
	}
	if got := int16(binary.LittleEndian.Uint16(data[off+14 : off+16])); got != rec.VelZ {
		t.Fatalf("velZ = %d, want %d", got, rec.VelZ)
	}
	if got := binary.LittleEndian.Uint16(data[off+16 : off+18]); got != rec.Heading {
		t.Fatalf("heading = %#x, want %#x (offset 16..18, per the ledger)", got, rec.Heading)
	}
	if got := data[off+18]; got != rec.FrameID {
		t.Fatalf("frameID = %d, want %d", got, rec.FrameID)
	}
	if got := data[off+19]; got != rec.MovementRegime {
		t.Fatalf("movementRegime = %d, want %d", got, rec.MovementRegime)
	}
	if got := binary.LittleEndian.Uint16(data[off+20 : off+22]); got != rec.ModelRevision {
		t.Fatalf("modelRevision = %#x, want %#x", got, rec.ModelRevision)
	}
	if got := binary.LittleEndian.Uint16(data[off+22 : off+24]); got != rec.StateFlags {
		t.Fatalf("stateFlags = %#x, want %#x", got, rec.StateFlags)
	}
}

// TestSnapshotCapArithmetic asserts the structural 1500 B guarantee: the
// record budget is DERIVED from the cap (not checked after the fact), and a
// full-size message payload fits inside the cap minus the framing margin.
func TestSnapshotCapArithmetic(t *testing.T) {
	if snapshotMsgCapBytes != 1500 {
		t.Fatalf("message cap = %d B, want 1500 (NETWORKING.md §4 — the cap never moves)", snapshotMsgCapBytes)
	}
	if snapshotMaxRecords != (snapshotMsgCapBytes-snapshotWireMarginBytes-snapshotEnvelopeBytes)/snapshotRecordBytes {
		t.Fatalf("record budget does not match the derivation floor((cap-margin-envelope)/record)")
	}
	full := snapshotEnvelopeBytes + snapshotMaxRecords*snapshotRecordBytes
	if full > snapshotMsgCapBytes-snapshotWireMarginBytes {
		t.Fatalf("full snapshot payload %d B exceeds cap-margin %d B", full, snapshotMsgCapBytes-snapshotWireMarginBytes)
	}
	// A full-budget message must not exceed the cap even with the margin.
	if full+snapshotWireMarginBytes > snapshotMsgCapBytes {
		t.Fatalf("full message %d B exceeds the 1500 B cap", full+snapshotWireMarginBytes)
	}
	t.Logf("[MEASURED] full snapshot payload = %d B (envelope %d + %d records × %d B); payload headroom to the 1500 B cap: %d B (the %d B margin covers Nakama protobuf + WS/TLS framing)",
		full, snapshotEnvelopeBytes, snapshotMaxRecords, snapshotRecordBytes, snapshotMsgCapBytes-full, snapshotWireMarginBytes)
}

// TestSnapshotFillsToMaxAndTruncates: a full-budget snapshot encodes at
// exactly the derived size; one more record sets the truncated flag and is
// dropped (the §9 priority-tier stand-in).
func TestSnapshotFillsToMaxAndTruncates(t *testing.T) {
	records := make([]EntityRecord, snapshotMaxRecords+3)
	for i := range records {
		records[i] = EntityRecord{ID: int64(i + 1)}
	}
	data := EncodeSnapshot(nil, 1, records)
	if len(data) != snapshotEnvelopeBytes+snapshotMaxRecords*snapshotRecordBytes {
		t.Fatalf("capped snapshot = %d B, want exactly the budget", len(data))
	}
	if got := binary.LittleEndian.Uint16(data[4:6]); int(got) != snapshotMaxRecords {
		t.Fatalf("entityCount = %d, want %d", got, snapshotMaxRecords)
	}
	flags := binary.LittleEndian.Uint16(data[6:8])
	if flags&snapshotFlagTruncated == 0 {
		t.Fatal("truncated flag not set although the AoI set exceeded the budget")
	}
	// Records are taken nearest-first BY THE CALLER; the encoder keeps the
	// first snapshotMaxRecords in order.
	if got := binary.LittleEndian.Uint32(data[snapshotEnvelopeBytes : snapshotEnvelopeBytes+4]); got != 1 {
		t.Fatalf("first record id = %d, want 1", got)
	}
}

// TestSnapshotJSONEnvelopeShape: the message is opaque binary to JSON, so
// assert instead that the payload byte length is what a client's DataView
// reads (sanity against accidental JSON encoding slipping in).
func TestSnapshotIsBinaryNotJSON(t *testing.T) {
	data := EncodeSnapshot(nil, 1, []EntityRecord{{ID: 1, X: 1, Z: 2}})
	if json.Valid(data) {
		t.Fatal("snapshot payload is valid JSON — the wire format must be the compact binary ledger")
	}
}

func TestClientStateRoundTrip(t *testing.T) {
	in := WireState{
		T:     42,
		Pos:   [3]float64{1234.5, -0.25, 9.75},
		Yaw:   2.999,
		Speed: 19.25,
	}
	data := EncodeClientState(nil, 42, in)
	if len(data) != ClientStateBytes {
		t.Fatalf("client state = %d B, want %d", len(data), ClientStateBytes)
	}
	tick, out, err := DecodeClientState(data)
	if err != nil {
		t.Fatal(err)
	}
	if tick != 42 {
		t.Fatalf("tick = %d, want 42", tick)
	}
	if out.T != 42 {
		t.Fatalf("state.t = %d, want 42", out.T)
	}
	// f32 quantization is part of the contract (f32-at-upload rule): values
	// survive only at f32 precision.
	if out.Pos[0] != float64(float32(in.Pos[0])) || out.Pos[1] != float64(float32(in.Pos[1])) || out.Pos[2] != float64(float32(in.Pos[2])) {
		t.Fatalf("pos round-trip = %v, want f32-quantized %v", out.Pos, in.Pos)
	}
	if out.Yaw != float64(float32(in.Yaw)) {
		t.Fatalf("yaw round-trip = %v, want %v", out.Yaw, float64(float32(in.Yaw)))
	}
	if out.Speed != float64(float32(in.Speed)) {
		t.Fatalf("speed round-trip = %v, want %v", out.Speed, float64(float32(in.Speed)))
	}
}

func TestDecodeClientStateRejectsWrongSize(t *testing.T) {
	if _, _, err := DecodeClientState(make([]byte, ClientStateBytes-1)); err == nil {
		t.Fatal("short payload must error")
	}
	if _, _, err := DecodeClientState(make([]byte, ClientStateBytes+1)); err == nil {
		t.Fatal("long payload must error")
	}
	if _, _, err := DecodeClientState(nil); err == nil {
		t.Fatal("empty payload must error")
	}
}

func TestQuantizeHeadingKnownValues(t *testing.T) {
	cases := []struct {
		yaw  float64
		want uint16
	}{
		{0, 32768},                       // east → half a turn
		{math.Pi / 2, 49152},             // → 3/4 turn
		{-math.Pi / 2, 16384},            // → 1/4 turn
		{math.Pi, 0},                     // wraps to the seam
		{-math.Pi, 0},                    // same seam from below
		{3 * math.Pi, 0},                 // out-of-range input wraps to the seam first
		{-0.00009587379901928619, 32767}, // just below the seam (−π/32768), rounds down
	}
	for _, c := range cases {
		if got := quantizeHeading(c.yaw); got != c.want {
			t.Errorf("quantizeHeading(%g) = %d, want %d", c.yaw, got, c.want)
		}
	}
}

func TestQuantizeVelCmSKnownValues(t *testing.T) {
	cases := []struct {
		v    float64
		want int16
	}{
		{0, 0},
		{1.4, 140},
		{20.0, 2000},
		{-2.55, -255},
		{400.0, 32767},   // clamps high
		{-400.0, -32768}, // clamps low
	}
	for _, c := range cases {
		if got := quantizeVelCmS(c.v); got != c.want {
			t.Errorf("quantizeVelCmS(%g) = %d, want %d", c.v, got, c.want)
		}
	}
}

// TestEncodeSnapshotBufferReuse: the caller may pass a reused dst buffer
// (the match loop does); the encoder must not grow it when it already fits.
func TestEncodeSnapshotBufferReuse(t *testing.T) {
	buf := make([]byte, 0, snapshotEnvelopeBytes+snapshotRecordBytes*2)
	// Identity probe: buf itself stays at length 0, so take a length-1 view
	// of the same backing array and compare element addresses against it.
	probe := buf[:1]
	out1 := EncodeSnapshot(buf, 1, []EntityRecord{{ID: 1}, {ID: 2}})
	if !bytes.Equal(out1[:4], []byte{1, 0, 0, 0}) {
		t.Fatalf("unexpected tick bytes %v", out1[:4])
	}
	if &out1[0] != &probe[0] {
		t.Fatal("encoder reallocated although the buffer already fit")
	}
	out2 := EncodeSnapshot(buf, 2, []EntityRecord{{ID: 3}})
	if &out2[0] != &probe[0] {
		t.Fatal("encoder reallocated on the second reuse")
	}
	if got := binary.LittleEndian.Uint32(out2[0:4]); got != 2 {
		t.Fatalf("tick after reuse = %d, want 2 (stale bytes must be overwritten)", got)
	}
}
