// Kwetu — protocol mirror + wire golden tests.
//
// protocol.json (repo root shared/) is the SINGLE source of truth for the
// wire contract (shared/protocol.ts is the client's typed view; the JSON's
// header comment owns the rules). These tests make a one-sided change fail:
//
//   - TestProtocolMirror reads the JSON and asserts every Go constant the
//     runtime compiles with — opcodes, byte ledger, cap arithmetic, tick
//     rate, AoI parameters, match name, RPC ids.
//
//   - TestGoldenWireFrames re-encodes the committed hex frames in shared/
//     protocol-golden.json and requires byte equality: the encoder's wire
//     output is frozen against a fixture both sides read. The TS decoder
//     (tests/net/wire.test.ts) decodes the SAME hex and asserts the same
//     fields — cross-implementation parity pinned to one file.
//
// Set KWETU_UPDATE_WIRE_GOLDEN=1 to regenerate the fixture from THIS side's
// encoders (container build: README.md §Build) — never edit it by hand, and
// never regenerate it after changing an encoder without stating why in the
// commit that does it.
package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type protocolDoc struct {
	Schema     string `json:"schema"`
	MatchName  string `json:"matchName"`
	Opcodes    struct {
		ClientState     int64 `json:"clientState"`
		ServerSnapshot  int64 `json:"serverSnapshot"`
		ServerCorrection int64 `json:"serverCorrection"`
	} `json:"opcodes"`
	WireMaxBytes int `json:"wireMaxBytes"`
	InputSendHz  int `json:"inputSendHz"`
	TickRateHz   int `json:"tickRateHz"`
	ClientState  struct {
		Bytes int `json:"bytes"`
	} `json:"clientState"`
	Snapshot struct {
		EnvelopeBytes   int `json:"envelopeBytes"`
		RecordBytes     int `json:"recordBytes"`
		WireMarginBytes int `json:"wireMarginBytes"`
	} `json:"snapshot"`
	Aoi struct {
		CellSizeMetres float64 `json:"cellSizeMetres"`
		RadiusMetres   float64 `json:"radiusMetres"`
	} `json:"aoi"`
	Rpcs struct {
		Healthcheck string `json:"healthcheck"`
		WorldTime   string `json:"worldTime"`
		WorldJoin   string `json:"worldJoin"`
		VoiceToken  string `json:"voiceToken"`
	} `json:"rpcs"`
}

func readProtocolDoc(t *testing.T) protocolDoc {
	t.Helper()
	path := filepath.Join("..", "..", "shared", "protocol.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc protocolDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

func TestProtocolMirror(t *testing.T) {
	doc := readProtocolDoc(t)

	if doc.Schema != "kwetu.protocol/0.1" {
		t.Fatalf("schema = %q, want kwetu.protocol/0.1 (the Go reader must track the file it reads)", doc.Schema)
	}
	if OpClientState != doc.Opcodes.ClientState {
		t.Fatalf("OpClientState = %d, JSON says %d", OpClientState, doc.Opcodes.ClientState)
	}
	if OpServerSnapshot != doc.Opcodes.ServerSnapshot {
		t.Fatalf("OpServerSnapshot = %d, JSON says %d", OpServerSnapshot, doc.Opcodes.ServerSnapshot)
	}
	if OpServerCorrection != doc.Opcodes.ServerCorrection {
		t.Fatalf("OpServerCorrection = %d, JSON says %d", OpServerCorrection, doc.Opcodes.ServerCorrection)
	}
	if snapshotMsgCapBytes != doc.WireMaxBytes {
		t.Fatalf("snapshotMsgCapBytes = %d, JSON says %d", snapshotMsgCapBytes, doc.WireMaxBytes)
	}
	if matchTickRate != doc.TickRateHz {
		t.Fatalf("matchTickRate = %d, JSON says %d", matchTickRate, doc.TickRateHz)
	}
	if ClientStateBytes != doc.ClientState.Bytes {
		t.Fatalf("ClientStateBytes = %d, JSON says %d", ClientStateBytes, doc.ClientState.Bytes)
	}
	if snapshotEnvelopeBytes != doc.Snapshot.EnvelopeBytes {
		t.Fatalf("snapshotEnvelopeBytes = %d, JSON says %d", snapshotEnvelopeBytes, doc.Snapshot.EnvelopeBytes)
	}
	if snapshotRecordBytes != doc.Snapshot.RecordBytes {
		t.Fatalf("snapshotRecordBytes = %d, JSON says %d", snapshotRecordBytes, doc.Snapshot.RecordBytes)
	}
	if snapshotWireMarginBytes != doc.Snapshot.WireMarginBytes {
		t.Fatalf("snapshotWireMarginBytes = %d, JSON says %d", snapshotWireMarginBytes, doc.Snapshot.WireMarginBytes)
	}
	if aoiCellSizeM != doc.Aoi.CellSizeMetres {
		t.Fatalf("aoiCellSizeM = %v, JSON says %v", aoiCellSizeM, doc.Aoi.CellSizeMetres)
	}
	if aoiRadiusM != doc.Aoi.RadiusMetres {
		t.Fatalf("aoiRadiusM = %v, JSON says %v", aoiRadiusM, doc.Aoi.RadiusMetres)
	}
	if MatchName != doc.MatchName {
		t.Fatalf("MatchName = %q, JSON says %q", MatchName, doc.MatchName)
	}
	if RpcHealthcheck != doc.Rpcs.Healthcheck {
		t.Fatalf("RpcHealthcheck = %q, JSON says %q", RpcHealthcheck, doc.Rpcs.Healthcheck)
	}
	if RpcWorldTime != doc.Rpcs.WorldTime {
		t.Fatalf("RpcWorldTime = %q, JSON says %q", RpcWorldTime, doc.Rpcs.WorldTime)
	}
	if RpcWorldJoin != doc.Rpcs.WorldJoin {
		t.Fatalf("RpcWorldJoin = %q, JSON says %q", RpcWorldJoin, doc.Rpcs.WorldJoin)
	}
	if RpcVoiceToken != doc.Rpcs.VoiceToken {
		t.Fatalf("RpcVoiceToken = %q, JSON says %q", RpcVoiceToken, doc.Rpcs.VoiceToken)
	}
	// The derived record budget is the cap arithmetic the 1500 B rule rests
	// on; assert it against the JSON inputs, not just the compiled constant.
	wantBudget := (doc.WireMaxBytes - doc.Snapshot.WireMarginBytes - doc.Snapshot.EnvelopeBytes) / doc.Snapshot.RecordBytes
	if snapshotMaxRecords != wantBudget {
		t.Fatalf("snapshotMaxRecords = %d, derived from JSON = %d", snapshotMaxRecords, wantBudget)
	}
}

// --- golden wire frames ------------------------------------------------------

// The frozen frames (shared/protocol-golden.json) are generated from THESE
// requests and re-encoded on every test run. Values chosen to exercise the
// ledger's quantization corners: a negative position, the i16 clamp bounds,
// heading 65535, and non-zero flag/revision fields.

type wireStateRequest struct {
	Tick  uint32
	Pos   [3]float64
	Yaw   float64
	Speed float64
}

type wireRecordRequest struct {
	ID             int64
	X, Z           float64
	VelX, VelZ     int
	Heading        uint16
	FrameID        uint8
	MovementRegime uint8
	ModelRevision  uint16
	StateFlags     uint16
}

type wireGoldenDoc struct {
	Schema string `json:"schema"`
	Frames struct {
		ClientState struct {
			Hex     string           `json:"hex"`
			Request wireStateRequest `json:"request"`
		} `json:"clientState"`
		Snapshot struct {
			Hex     string              `json:"hex"`
			Request struct {
				Tick    uint32              `json:"tick"`
				Records []wireRecordRequest `json:"records"`
			} `json:"request"`
		} `json:"snapshot"`
		Correction struct {
			Hex     string           `json:"hex"`
			Request wireStateRequest `json:"request"`
		} `json:"correction"`
	} `json:"frames"`
}

func goldenClientState() wireStateRequest {
	return wireStateRequest{Tick: 1234, Pos: [3]float64{1.5, 2.25, -3.75}, Yaw: 0.7071067811865476, Speed: 2.5}
}
func goldenSnapshotTick() uint32 { return 5678 }

func goldenRecords() []wireRecordRequest {
	return []wireRecordRequest{
		{ID: 1, X: 10.5, Z: -2.25, VelX: 100, VelZ: -50, Heading: 16384, FrameID: 1, MovementRegime: 2, ModelRevision: 7, StateFlags: 3},
		{ID: 2, X: -0.125, Z: 300.5, VelX: -32767, VelZ: 32767, Heading: 65535, FrameID: 0, MovementRegime: 0, ModelRevision: 0, StateFlags: 0},
	}
}

func goldenCorrection() wireStateRequest {
	return wireStateRequest{Tick: 9, Pos: [3]float64{0.1, 0.2, 0.3}, Yaw: -1.5, Speed: 0}
}

func encodeClientStateHex(req wireStateRequest) string {
	wire := WireState{T: int64(req.Tick), Pos: req.Pos, Yaw: req.Yaw, Speed: req.Speed}
	return hex.EncodeToString(EncodeClientState(nil, req.Tick, wire))
}

func encodeSnapshotHex(tick uint32, records []wireRecordRequest) string {
	rs := make([]EntityRecord, 0, len(records))
	for _, r := range records {
		rs = append(rs, EntityRecord{
			ID: r.ID, X: float32(r.X), Z: float32(r.Z),
			VelX: int16(r.VelX), VelZ: int16(r.VelZ), Heading: r.Heading,
			FrameID: r.FrameID, MovementRegime: r.MovementRegime,
			ModelRevision: r.ModelRevision, StateFlags: r.StateFlags,
		})
	}
	return hex.EncodeToString(EncodeSnapshot(nil, tick, rs))
}

// goldenPath resolves shared/protocol-golden.json relative to this package
// (the test binary's working directory is the package dir).
func goldenPath() string {
	return filepath.Join("..", "..", "shared", "protocol-golden.json")
}

func readWireGolden(t *testing.T) wireGoldenDoc {
	t.Helper()
	b, err := os.ReadFile(goldenPath())
	if err != nil {
		t.Fatalf("read the golden fixture: %v (regenerate with KWETU_UPDATE_WIRE_GOLDEN=1)", err)
	}
	var doc wireGoldenDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("parse the golden fixture: %v", err)
	}
	return doc
}

func TestGoldenWireFrames(t *testing.T) {
	if os.Getenv("KWETU_UPDATE_WIRE_GOLDEN") == "1" {
		var doc wireGoldenDoc
		doc.Schema = "kwetu.protocol-golden/0.1"
		doc.Frames.ClientState.Request = goldenClientState()
		doc.Frames.ClientState.Hex = encodeClientStateHex(doc.Frames.ClientState.Request)
		doc.Frames.Snapshot.Request.Tick = goldenSnapshotTick()
		doc.Frames.Snapshot.Request.Records = goldenRecords()
		doc.Frames.Snapshot.Hex = encodeSnapshotHex(doc.Frames.Snapshot.Request.Tick, doc.Frames.Snapshot.Request.Records)
		doc.Frames.Correction.Request = goldenCorrection()
		doc.Frames.Correction.Hex = encodeClientStateHex(doc.Frames.Correction.Request)
		b, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenPath(), append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Log("wrote", goldenPath())
		return
	}

	doc := readWireGolden(t)
	if got := encodeClientStateHex(goldenClientState()); got != doc.Frames.ClientState.Hex {
		t.Fatalf("client state frame drifted from the golden fixture:\n got  %s\n want %s", got, doc.Frames.ClientState.Hex)
	}
	if got := encodeSnapshotHex(doc.Frames.Snapshot.Request.Tick, doc.Frames.Snapshot.Request.Records); got != doc.Frames.Snapshot.Hex {
		t.Fatalf("snapshot frame drifted from the golden fixture:\n got  %s\n want %s", got, doc.Frames.Snapshot.Hex)
	}
	if got := encodeClientStateHex(goldenCorrection()); got != doc.Frames.Correction.Hex {
		t.Fatalf("correction frame drifted from the golden fixture:\n got  %s\n want %s", got, doc.Frames.Correction.Hex)
	}
}
