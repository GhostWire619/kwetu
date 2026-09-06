// Kwetu — authoritative region match "kwetu_world" (Phase-5 groundwork).
//
// One authoritative match per region; the AoI cell grid lives inside it
// (NETWORKING.md §9, ARCHITECTURE.md §6). The handler owns the tick loop and
// the server's tick is the only clock that advances shared simulation state
// (NETWORKING.md §5).
//
// Per-tick shape (bounded work; MatchLoop must finish before the next tick):
//
//  1. consume queued client movement reports (op 1) → per-presence ADR-007
//     kinematic replay with clamped claims; drift beyond the accept threshold
//     is REJECTED: the server keeps its replayed (clamped) state and sends the
//     offender a correction (op 3) — recorded, never a crash.
//  2. one AoI rebuild (ADR-009 rebuild-per-tick semantics).
//  3. one coalesced snapshot per presence (op 2) covering its AoI, capped
//     structurally under the 1500 B message rule (NETWORKING.md §4).
//  4. emptyTicks termination per Nakama semantics: no presences and no queued
//     messages for emptyTickLimit ticks → return nil state (the Go-runtime
//     termination mechanism, NETWORKING.md §5).
//
// NOT owned by this handler (ADR-007 Decision 5): server-side Rapier or any
// contact solver; crash/collision outcomes; input re-simulation beyond the
// clamped kinematic replay; any "server-authoritative physics" claim.
package main

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// MatchName is the registered match handler name.
const MatchName = "kwetu_world"

// Match configuration. Values are the ADR-009 adopted grid (Decision 1) and
// the assumed 20 Hz tick the whole Phase-0 benchmark series is phrased at
// [INPUT assumption — Nakama MatchInit permits tickrate 1–60, NETWORKING.md
// §5; the production tick rate is a Phase-5 netcode design decision].
const (
	matchTickRate      = 20    // Hz
	aoiCellSizeM       = 250.0 // m [MEASURED 2026-09-06, ADR-009 B-AOI-01]
	aoiRadiusM         = 500.0 // m [PLACEHOLDER — gate: Phase 3/5 production radius, ADR-009]
	matchEmptyTickMin  = 600   // 30 s at 20 Hz [PLACEHOLDER — gate: Phase 5]
	matchReplayTickLog = 1200  // one stats log line per 60 s
	correctionCooldown = 20    // ticks between corrections to one presence [PLACEHOLDER — gate: Phase 5]
)

// kwetuWorldPresence is one connected participant's authoritative state.
type kwetuWorldPresence struct {
	id       int64 // short wire id (snapshot records); stable within a session
	userID   string
	username string
	presence runtime.Presence

	replay ReplayState

	// driftWindow is the ADR-007 verdict window: max per-tick position drift
	// over the most recent validatorWindowTicks reports.
	driftWindow *DriftWindow
	lastDrift   float64

	lastClientTick uint32
	reports        int64
	rejects        int64
	// ticksSinceCorr counts SERVER ticks (advanced once per tick in
	// MatchLoop, not per report) since this presence's last correction send;
	// the correctionCooldown constant is documented in ticks.
	ticksSinceCorr int
}

// kwetuWorldState is the in-memory match state. It lives only as long as the
// match; resume-after-restart via storage snapshots is Phase-5 work
// (NETWORKING.md §5) and deliberately not stubbed here.
type kwetuWorldState struct {
	tickRate    int
	cellSize    float64
	aoiRadius   float64
	emptyLimit  int
	driftThresh float64

	createdAtUnix int64
	nextID        int64

	byUserID map[string]*kwetuWorldPresence
	byID     map[int64]*kwetuWorldPresence
	grid     *AoiGrid

	emptyTicks   int
	rejectsTotal int64
	malformed    int64

	// scratch buffers reused across ticks (alloc-free steady state).
	snapshotBuf []byte
	stateBuf    []byte
	sortScratch []aoiNeighbor

	// lastReportScratch holds, for the tick in progress, the last
	// OpClientState per user id (the one-report-per-tick wire budget);
	// cleared at the top of every MatchLoop.
	lastReportScratch map[string]runtime.MatchData
}

type aoiNeighbor struct {
	id int64
	d2 float64
}

// kwetuWorldMatch implements runtime.Match.
type kwetuWorldMatch struct{}

func newKwetuWorldMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
	return &kwetuWorldMatch{}, nil
}

// MatchInit runs once at creation. Recognised params (all optional):
// tickRate (1–60), cellSize (>0 m), aoiRadius (>0 m), emptyTickLimit (≥1),
// driftThreshold (>0 m). Defaults are the constants above.
func (m *kwetuWorldMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	tickRate := matchTickRate
	cellSize := aoiCellSizeM
	aoiRadius := aoiRadiusM
	emptyLimit := matchEmptyTickMin
	threshold := validatorAcceptThreshold

	if v, ok := intParam(params, "tickRate"); ok && v >= 1 && v <= 60 {
		tickRate = v
	}
	if v, ok := floatParam(params, "cellSize"); ok && v > 0 {
		cellSize = v
	}
	if v, ok := floatParam(params, "aoiRadius"); ok && v > 0 {
		aoiRadius = v
	}
	if v, ok := intParam(params, "emptyTickLimit"); ok && v >= 1 {
		emptyLimit = v
	}
	if v, ok := floatParam(params, "driftThreshold"); ok && v > 0 {
		threshold = v
	}

	grid, err := NewAoiGrid(AoiParams{CellSize: cellSize, AoiRadius: aoiRadius})
	if err != nil {
		// A bad config must fail the match creation, not the server.
		logger.WithField("error", err.Error()).Error("kwetu_world: invalid AoI params; falling back to adopted defaults")
		cellSize = aoiCellSizeM
		aoiRadius = aoiRadiusM
		grid, _ = NewAoiGrid(AoiParams{CellSize: cellSize, AoiRadius: aoiRadius})
	}

	state := &kwetuWorldState{
		tickRate:      tickRate,
		cellSize:      cellSize,
		aoiRadius:     aoiRadius,
		emptyLimit:    emptyLimit,
		driftThresh:   threshold,
		createdAtUnix: time.Now().Unix(),
		nextID:        1,
		byUserID:      make(map[string]*kwetuWorldPresence),
		byID:          make(map[int64]*kwetuWorldPresence),
		grid:          grid,
		snapshotBuf:   make([]byte, 0, snapshotEnvelopeBytes+snapshotMaxRecords*snapshotRecordBytes),
		stateBuf:      make([]byte, 0, ClientStateBytes),
		sortScratch:   make([]aoiNeighbor, 0, 64),

		lastReportScratch: make(map[string]runtime.MatchData),
	}
	logger.Info("kwetu_world match created: tickRate %d Hz, cellSize %.0f m, aoiRadius %.0f m, emptyTickLimit %d, driftThreshold %.2f m, recordBudget %d",
		tickRate, cellSize, aoiRadius, emptyLimit, threshold, snapshotMaxRecords)
	return state, tickRate, MatchName
}

func (m *kwetuWorldMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	// Groundwork: every join is allowed. NETWORKING.md §5 puts AoI cell
	// checks and suspended-user refusals here — Phase 5 wires the region
	// registry and the moderation data source; there is no suspension data
	// source yet, so NETWORKING.md §12's capability restriction is not yet
	// enforceable and is not pretended.
	s, ok := state.(*kwetuWorldState)
	if !ok || s == nil {
		return state, false, "match state is not initialised"
	}
	logger.WithFields(map[string]interface{}{
		"user_id":  presence.GetUserId(),
		"session":  presence.GetSessionId(),
		"username": presence.GetUsername(),
	}).Info("kwetu_world join attempt allowed")
	return s, true, ""
}

func (m *kwetuWorldMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	s, ok := state.(*kwetuWorldState)
	if !ok || s == nil {
		return state
	}
	for _, p := range presences {
		// Reconnect: the same user rejoining replaces the stale session
		// (connection loss is "presence is gone", never "player quit" —
		// NETWORKING.md §5). The authoritative state restarts at the
		// server-owned spawn; carrying the old session's state across a
		// reconnect is Phase-5 work with the snapshot/persistence path.
		if old, dup := s.byUserID[p.GetUserId()]; dup {
			s.removePresence(old)
			logger.WithField("user_id", p.GetUserId()).Info("kwetu_world reconnect: replacing stale session")
		}

		id := s.nextID
		s.nextID++
		wp := &kwetuWorldPresence{
			id:          id,
			userID:      p.GetUserId(),
			username:    p.GetUsername(),
			presence:    p,
			replay:      ReplayState{Px: 0, Py: 0, Pz: 0, Yaw: 0, Speed: 0},
			driftWindow: NewDriftWindow(validatorWindowTicks),
		}
		if err := s.grid.Add(id, 0, 0); err != nil {
			// Cannot happen (fresh ids); recorded because a grid invariant
			// failure must never take the tick down.
			logger.WithField("error", err.Error()).Error("kwetu_world: grid add failed")
			s.nextID--
			continue
		}
		s.byUserID[wp.userID] = wp
		s.byID[id] = wp
	}
	s.emptyTicks = 0
	return s
}

func (m *kwetuWorldMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	s, ok := state.(*kwetuWorldState)
	if !ok || s == nil {
		return state
	}
	for _, p := range presences {
		if wp, found := s.byUserID[p.GetUserId()]; found {
			s.removePresence(wp)
		}
	}
	return s
}

// removePresence drops one presence from every index. The maps are always
// cleaned; a grid error would be an invariant violation and is swallowed so
// a Leave can never panic the tick.
func (s *kwetuWorldState) removePresence(wp *kwetuWorldPresence) {
	_ = s.grid.Drop(wp.id)
	delete(s.byUserID, wp.userID)
	delete(s.byID, wp.id)
}

func (m *kwetuWorldMatch) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, messages []runtime.MatchData) interface{} {
	s, ok := state.(*kwetuWorldState)
	if !ok || s == nil {
		// A foreign/nil state ends the match rather than guessing.
		logger.Error("kwetu_world: unexpected match state; terminating match")
		return nil
	}

	// 1 — consume queued client messages. The wire budget is ONE movement
	// report per presence per tick (snapshot.go OpClientState doc, README):
	// within a tick only the LAST report per user is the freshest claim;
	// earlier ones are a rate violation and count as malformed. Without this
	// coalescing a client sending N reports/tick would earn N clamped
	// integration steps per tick (rate amplification). Out-of-order/late/
	// missing reports stay ADR-007 Open item 4 (Phase 5); this enforces only
	// the per-tick budget the docs already state.
	clear(s.lastReportScratch)
	for _, msg := range messages {
		switch msg.GetOpCode() {
		case OpClientState:
			if _, dup := s.lastReportScratch[msg.GetUserId()]; dup {
				s.malformed++
			}
			s.lastReportScratch[msg.GetUserId()] = msg
		default:
			s.malformed++
		}
	}
	for _, msg := range s.lastReportScratch {
		s.handleStateReport(logger, dispatcher, msg)
	}

	// The correction cooldown counts server ticks, not reports: advance
	// every presence once per tick, after this tick's reports are consumed.
	for _, wp := range s.byID {
		wp.ticksSinceCorr++
	}

	// Empty-tick termination (NETWORKING.md §5): no presences AND no queued
	// messages for emptyLimit ticks → return nil (Go-runtime termination).
	if len(s.byID) == 0 && len(messages) == 0 {
		s.emptyTicks++
		if s.emptyTicks >= s.emptyLimit {
			logger.Info("kwetu_world: idle for %d ticks; terminating match", s.emptyTicks)
			return nil
		}
		return s
	}
	s.emptyTicks = 0

	if len(s.byID) > 0 {
		// 2 — one AoI rebuild for every presence (ADR-009 Decision 2).
		interests := s.grid.RebuildTick()

		// 3 — one coalesced snapshot per presence. The encode buffer is
		// reused across recipients in the same tick: safe because
		// dispatcher.BroadcastMessage (the NON-deferred variant) marshals
		// the envelope synchronously into a fresh buffer before it returns
		// [MEASURED 2026-09-06, nakama v3.37.0 server source
		// server/runtime_go_match_core.go validateBroadcast embeds the data
		// slice by reference, but LocalMessageRouter.SendToPresenceIDs
		// proto.Marshal/protojson-encodes it into a new payload before
		// returning — server/message_router.go]. Switching to
		// BroadcastMessageDeferred would retain the envelope and REQUIRE a
		// fresh buffer per send.
		for _, wp := range s.byID {
			records := s.buildRecipientRecords(wp, interests)
			data := EncodeSnapshot(s.snapshotBuf, uint32(tick), records)
			// Defensive cap assert: the encoder is structural, this is a
			// tripwire against future ledger edits breaking the invariant.
			if len(data) > snapshotMsgCapBytes-snapshotWireMarginBytes {
				logger.Error("kwetu_world: snapshot payload %d B exceeds the payload budget; skipping broadcast this tick", len(data))
				continue
			}
			if err := dispatcher.BroadcastMessage(OpServerSnapshot, data, []runtime.Presence{wp.presence}, nil, true); err != nil {
				logger.WithField("error", err.Error()).Warn("kwetu_world: snapshot broadcast failed")
			}
		}
	}

	// 4 — observability heartbeat (NETWORKING.md §13 groundwork: drift
	// rejects and message hygiene are the netcode vital signs; real runtime
	// metrics plumbing is Phase 5).
	if tick%matchReplayTickLog == 0 {
		logger.Info("kwetu_world tick %d: presences %d, drift rejects total %d, malformed %d",
			tick, len(s.byID), s.rejectsTotal, s.malformed)
	}
	return s
}

// handleStateReport validates one client movement report through the ADR-007
// contract. Positions beyond the drift threshold are rejected: the server
// keeps its replayed state and (cooldown permitting) sends the offender a
// correction message with that replayed state.
func (s *kwetuWorldState) handleStateReport(logger runtime.Logger, dispatcher runtime.MatchDispatcher, msg runtime.MatchData) {
	wp, found := s.byUserID[msg.GetUserId()]
	if !found {
		s.malformed++
		return
	}
	tick, wire, err := DecodeClientState(msg.GetData())
	if err != nil {
		s.malformed++
		return
	}
	wp.lastClientTick = tick
	wp.reports++

	dt := 1.0 / float64(s.tickRate)
	posDrift, _ := ValidatorStep(&wp.replay, &wire, dt)
	wp.lastDrift = posDrift
	windowMax := wp.driftWindow.Push(posDrift)

	if windowMax >= s.driftThresh {
		// ADR-007 Decision 4: rejection = the server keeps its replayed
		// state and flags/resyncs. The claim is discarded; the clamped
		// replay state IS the authoritative position (already advanced by
		// ValidatorStep). The heading channel (spin-class cheats, ADR-007
		// Open item 2) is a future detector and records nothing yet.
		wp.rejects++
		s.rejectsTotal++
		if wp.ticksSinceCorr >= correctionCooldown {
			wp.ticksSinceCorr = 0
			corr := WireState{
				T:     int64(tick),
				Pos:   [3]float64{wp.replay.Px, wp.replay.Py, wp.replay.Pz},
				Yaw:   wp.replay.Yaw,
				Speed: wp.replay.Speed,
			}
			data := EncodeClientState(s.stateBuf, tick, corr)
			if err := dispatcher.BroadcastMessage(OpServerCorrection, data, []runtime.Presence{wp.presence}, nil, true); err != nil {
				logger.WithField("error", err.Error()).Warn("kwetu_world: correction send failed")
			}
		}
		return
	}

	// Accept: the authoritative position is the server's clamped replay.
	if err := s.grid.Move(wp.id, wp.replay.Px, wp.replay.Pz); err != nil {
		s.malformed++
	}
}

func (m *kwetuWorldMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	// Groundwork: no storage snapshot yet — resume-after-restart
	// (MatchInit snapshot_id param + periodic persistence, NETWORKING.md §5)
	// is Phase-5 work. Returning the state lets Nakama finish its drain.
	return state
}

func (m *kwetuWorldMatch) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, data string) (interface{}, string) {
	// Cross-runtime pokes (region handoffs, moderation) are Phase-5; the
	// groundwork acknowledges so callers can distinguish a live handler.
	return state, "ack"
}

// buildRecipientRecords assembles one recipient's snapshot records: self
// first (the client reconciles its own authoritative position against it),
// then the AoI neighbours nearest-first, capped at the record budget with the
// truncated flag (the §9 priority-tier stand-in). Order is explicit — the
// AoI port returns sets (its rule 6).
func (s *kwetuWorldState) buildRecipientRecords(wp *kwetuWorldPresence, interests map[int64][]int64) []EntityRecord {
	records := make([]EntityRecord, 0, 1+len(interests[wp.id]))
	records = append(records, s.recordFor(wp))

	s.sortScratch = s.sortScratch[:0]
	x0, z0 := wp.replay.Px, wp.replay.Pz
	for _, id := range interests[wp.id] {
		other, ok := s.byID[id]
		if !ok {
			continue
		}
		dx := other.replay.Px - x0
		dz := other.replay.Pz - z0
		s.sortScratch = append(s.sortScratch, aoiNeighbor{id: id, d2: dx*dx + dz*dz})
	}
	// Nearest-first; the §9 tier ladder replaces this with per-tier rates
	// [PLACEHOLDER — gate: Phase 5 netcode design doc].
	if len(s.sortScratch) > 1 {
		sort.Slice(s.sortScratch, func(i, j int) bool {
			if s.sortScratch[i].d2 != s.sortScratch[j].d2 {
				return s.sortScratch[i].d2 < s.sortScratch[j].d2
			}
			return s.sortScratch[i].id < s.sortScratch[j].id
		})
	}
	budget := snapshotMaxRecords - 1 // self occupies one record
	for i, n := range s.sortScratch {
		if i >= budget {
			break
		}
		records = append(records, s.recordFor(s.byID[n.id]))
	}
	return records
}

func (s *kwetuWorldState) recordFor(wp *kwetuWorldPresence) EntityRecord {
	vx := wp.replay.Speed * math.Cos(wp.replay.Yaw)
	vz := wp.replay.Speed * math.Sin(wp.replay.Yaw)
	return EntityRecord{
		ID:             wp.id,
		X:              float32(wp.replay.Px),
		Z:              float32(wp.replay.Pz),
		VelX:           quantizeVelCmS(vx),
		VelZ:           quantizeVelCmS(vz),
		Heading:        quantizeHeading(wp.replay.Yaw),
		FrameID:        0, // frame id: Phase-3 world-frame registry [PLACEHOLDER]
		MovementRegime: 0, // contact/local groundwork; the regime enum lands with vehicles
		ModelRevision:  0, // movement model revision (versioned replay per NETWORKING.md §6)
		StateFlags:     0,
	}
}

// --- param helpers -----------------------------------------------------------

func intParam(params map[string]interface{}, key string) (int, bool) {
	v, ok := params[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	default:
		return 0, false
	}
}

func floatParam(params map[string]interface{}, key string) (float64, bool) {
	v, ok := params[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	default:
		return 0, false
	}
}
