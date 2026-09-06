// Kwetu — coalesced per-tick snapshot wire format (Phase-5 groundwork).
//
// NETWORKING.md §4 hard rules implemented here:
//  1. ≤ 1500 B per message — the cap NEVER moves (CLAUDE.md invariant). The
//     encoder enforces it structurally: the record budget is derived from
//     the cap, not checked after the fact.
//  2. ~1 message per tick per presence — one coalesced snapshot per
//     recipient per tick (ADR-009 Decision 4 framing).
//  3. Coalescing beats splitting — everything a recipient needs this tick
//     rides inside its one message.
//
// BYTE LEDGER [PLACEHOLDER — gate: Phase 5 netcode design doc, which owns the
// per-opcode ledger; the ledger below is the groundwork instantiation of
// ADR-009's stated wire model]:
//
//	server data payload = envelope 14 B + record 24 B × n
//	  envelope 14 B: tick u32 (4) + entityCount u16 (2) + flags u16 (2)
//	                 + reserved u8×6 (6)   [reserved = 0]
//	  record 24 B:   id u32 (4) + pos 2×f32 (8) + vel 2×i16 (4)
//	                 + heading u16 (2) + frameId u8 (1) + movementRegime u8 (1)
//	                 + modelRevision u16 (2) + stateFlags u16 (2)
//
// This is ADR-009's stated 24 B record and 16 B envelope minus the 2 B opcode
// that Nakama carries as the message opCode (outside the data payload).
// Because ADR-009's 61/148 thresholds derive from THAT model, this file
// derives its own record budget the same way and adds a fixed margin for
// Nakama's own protobuf envelope + WebSocket framing on top — see
// snapshotWireMarginBytes. The cap arithmetic is asserted by test.
//
// Quantization [PLACEHOLDER — gate: Phase 5 netcode design doc]:
//
//	pos        f32 (the ADR-007 f32-at-upload rule)
//	vel        i16 = clamp(round(v·100), −32768, 32767)  → cm/s, ±327.67 m/s
//	heading    u16 = round(wrap(yaw)+π)/2π·65536 mod 65536 → 1/65536 turns
package main

import (
	"encoding/binary"
	"errors"
	"math"
)

var errBadClientState = errors.New("snapshot: client state payload must be exactly 24 bytes")

// Opcode vocabulary (small ints; clients switch on these).
const (
	// opClientState: client → server, one coalesced movement report per tick.
	// Payload = ClientStateBytes: t u32 + pos 3×f32 + yaw f32 + speed f32
	// (the ADR-007 wire state at f32 precision).
	OpClientState int64 = 1
	// opServerSnapshot: server → client, one coalesced AoI snapshot per tick.
	OpServerSnapshot int64 = 2
	// opServerCorrection: server → one client whose report was rejected
	// (ADR-007 Decision 4 "flags/resyncs" groundwork). Payload is the same
	// 24 B layout as OpClientState with the SERVER's replayed state.
	OpServerCorrection int64 = 3
)

// ClientStateBytes is the exact size of the client movement report.
const ClientStateBytes = 4 + 12 + 4 + 4 // 24 (t u32 + pos 3×f32 + yaw f32 + speed f32)

// Server snapshot layout constants.
const (
	snapshotEnvelopeBytes = 14
	snapshotRecordBytes   = 24

	// snapshotWireMarginBytes budgets Nakama's own protobuf envelope and
	// WebSocket/TLS framing around the data payload so the TOTAL message
	// stays inside the 1500 B cap (NETWORKING.md §4 rule 1: the cap counts
	// the whole message, "regardless of the server's configured cap").
	// [PLACEHOLDER — gate: Phase 5 netcode design doc replaces this margin
	// with a measured ledger of the Nakama framing at the pinned server
	// version; 128 B is a stated conservative stand-in, not a measurement.]
	snapshotWireMarginBytes = 128

	// snapshotMsgCapBytes is the NETWORKING.md §4 hard rule (CLAUDE.md).
	snapshotMsgCapBytes = 1500
)

// snapshotMaxRecords is the record budget per snapshot message:
// floor((cap − margin − envelope) / recordBytes). Derived from the cap, so a
// full-size message is structurally inside the 1500 B limit.
const snapshotMaxRecords = (snapshotMsgCapBytes - snapshotWireMarginBytes - snapshotEnvelopeBytes) / snapshotRecordBytes

// Snapshot flag bits (envelope flags field).
const (
	// snapshotFlagTruncated marks that the recipient's AoI set exceeded the
	// record budget and only the nearest records are included. This is the
	// groundwork stand-in for the NETWORKING.md §9 priority tiers
	// [PLACEHOLDER — gate: Phase 5 netcode design doc implements the real
	// tier ladder: full-rate local cell / interpolated adjacent / throttled
	// beyond, and the ADR-009 delta-record path beyond 148 presences].
	snapshotFlagTruncated uint16 = 1 << 0
)

// EntityRecord is one entity's compact state (the 24 B record, decoded form).
type EntityRecord struct {
	ID             int64 // wire: u32 (ids are small positive counters)
	X, Z           float32
	VelX, VelZ     int16  // cm/s quantized
	Heading        uint16 // 1/65536 turns
	FrameID        uint8
	MovementRegime uint8
	ModelRevision  uint16
	StateFlags     uint16
}

// EncodeSnapshot writes one coalesced snapshot for one recipient into dst
// (reused; grown only if needed) and returns the slice. ids must be sorted
// nearest-first by the caller when len(ids) > snapshotMaxRecords — the
// encoder takes the FIRST snapshotMaxRecords and sets the truncated flag
// (a deterministic nearest-first policy stands in for the §9 priority tiers
// until the Phase-5 netcode design doc owns the real ladder).
func EncodeSnapshot(dst []byte, tick uint32, records []EntityRecord) []byte {
	n := len(records)
	if n > snapshotMaxRecords {
		n = snapshotMaxRecords
	}
	flags := uint16(0)
	if n < len(records) {
		flags |= snapshotFlagTruncated
	}

	total := snapshotEnvelopeBytes + n*snapshotRecordBytes
	if cap(dst) < total {
		dst = make([]byte, 0, total)
	}
	dst = dst[:total]

	binary.LittleEndian.PutUint32(dst[0:4], tick)
	binary.LittleEndian.PutUint16(dst[4:6], uint16(n))
	binary.LittleEndian.PutUint16(dst[6:8], flags)
	// dst[8:14] reserved = 0 (already zeroed by the slice cap or explicit clear).
	for i := 8; i < snapshotEnvelopeBytes; i++ {
		dst[i] = 0
	}

	off := snapshotEnvelopeBytes
	for _, r := range records[:n] {
		binary.LittleEndian.PutUint32(dst[off:off+4], uint32(r.ID))
		binary.LittleEndian.PutUint32(dst[off+4:off+8], math.Float32bits(r.X))
		binary.LittleEndian.PutUint32(dst[off+8:off+12], math.Float32bits(r.Z))
		binary.LittleEndian.PutUint16(dst[off+12:off+14], uint16(r.VelX))
		binary.LittleEndian.PutUint16(dst[off+14:off+16], uint16(r.VelZ))
		binary.LittleEndian.PutUint16(dst[off+16:off+18], r.Heading)
		dst[off+18] = r.FrameID
		dst[off+19] = r.MovementRegime
		binary.LittleEndian.PutUint16(dst[off+20:off+22], r.ModelRevision)
		binary.LittleEndian.PutUint16(dst[off+22:off+24], r.StateFlags)
		off += snapshotRecordBytes
	}
	return dst
}

// DecodeClientState parses one client movement report (OpClientState).
// Returns the tick and the widened f64 state; malformed payloads are an
// error and must be counted, never crashed on.
func DecodeClientState(data []byte) (tick uint32, s WireState, err error) {
	if len(data) != ClientStateBytes {
		return 0, WireState{}, errBadClientState
	}
	tick = binary.LittleEndian.Uint32(data[0:4])
	s = WireState{
		T: int64(tick),
		Pos: [3]float64{
			float64(math.Float32frombits(binary.LittleEndian.Uint32(data[4:8]))),
			float64(math.Float32frombits(binary.LittleEndian.Uint32(data[8:12]))),
			float64(math.Float32frombits(binary.LittleEndian.Uint32(data[12:16]))),
		},
		Yaw:   float64(math.Float32frombits(binary.LittleEndian.Uint32(data[16:20]))),
		Speed: float64(math.Float32frombits(binary.LittleEndian.Uint32(data[20:24]))),
	}
	return tick, s, nil
}

// EncodeClientState is the inverse of DecodeClientState (f32 quantizing).
func EncodeClientState(dst []byte, tick uint32, s WireState) []byte {
	if cap(dst) < ClientStateBytes {
		dst = make([]byte, 0, ClientStateBytes)
	}
	dst = dst[:ClientStateBytes]
	binary.LittleEndian.PutUint32(dst[0:4], tick)
	binary.LittleEndian.PutUint32(dst[4:8], math.Float32bits(float32(s.Pos[0])))
	binary.LittleEndian.PutUint32(dst[8:12], math.Float32bits(float32(s.Pos[1])))
	binary.LittleEndian.PutUint32(dst[12:16], math.Float32bits(float32(s.Pos[2])))
	binary.LittleEndian.PutUint32(dst[16:20], math.Float32bits(float32(s.Yaw)))
	binary.LittleEndian.PutUint32(dst[20:24], math.Float32bits(float32(s.Speed)))
	return dst
}

// Quantize helpers (ledger above).
func quantizeVelCmS(v float64) int16 {
	q := math.Round(v * 100)
	if q > 32767 {
		q = 32767
	} else if q < -32768 {
		q = -32768
	}
	return int16(q)
}

func quantizeHeading(yaw float64) uint16 {
	// yaw ∈ (-pi, pi] → turns ∈ [0, 1) → 1/65536 turns.
	t := (ValidatorWrapAngle(yaw) + math.Pi) / (2 * math.Pi)
	h := math.Round(t * 65536)
	for h >= 65536 {
		h -= 65536
	}
	return uint16(h)
}
