// Kwetu — core RPCs (Phase-5 groundwork).
//
//	healthcheck_rpc  : uptime + module version (ops probe).
//	world_time_rpc   : {utcMillis, serverMonotonicMillis} — see the ADR-008
//	                   note on worldTime below.
//	voice_token_rpc  : mints an HS256 LiveKit token (voice.go), scoped to a
//	                   room, with roomJoin/canPublish/canSubscribe/
//	                   canPublishData grants (NETWORKING.md §10).
//
// Env policy (all three): LIVEKIT_* variables are looked up in the Nakama
// runtime environment (config `runtime.env`, exposed through the request
// context) and fall back to the process environment. They are read-only,
// never logged, never hardcoded; unset → structured error, never a panic.
// (.env is gitignored and is never read by this module or its tests.)
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// moduleVersion identifies the built runtime module (surfaced by
// healthcheck_rpc and the startup log line).
const moduleVersion = "0.1.0"

// processStart anchors healthcheck uptime and the monotonic clock hand-out.
var processStart = time.Now()

// gRPC status codes used for structured RPC errors (Nakama maps these to
// HTTP status codes for the client).
const (
	grpcInvalidArgument    = 3
	grpcFailedPrecondition = 9
	grpcInternal           = 13
)

// ---------------------------------------------------------------- healthcheck

type healthcheckResponse struct {
	OK            bool    `json:"ok"`
	Module        string  `json:"module"`
	ModuleVersion string  `json:"moduleVersion"`
	MatchName     string  `json:"matchName"`
	UptimeSeconds float64 `json:"uptimeSeconds"`
	UtcMillis     int64   `json:"utcMillis"`
}

func rpcHealthcheck(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	resp := healthcheckResponse{
		OK:            true,
		Module:        "kwetu-runtime-go",
		ModuleVersion: moduleVersion,
		MatchName:     MatchName,
		UptimeSeconds: time.Since(processStart).Seconds(),
		UtcMillis:     time.Now().UnixMilli(),
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return "", runtime.NewError("healthcheck encode failed", grpcInternal)
	}
	return string(b), nil
}

// --------------------------------------------------------------- world time

type worldTimeResponse struct {
	UtcMillis             int64 `json:"utcMillis"`
	ServerMonotonicMillis int64 `json:"serverMonotonicMillis"`
}

// rpcWorldTime hands out the server's wall-clock UTC and a monotonic base.
//
// WHY NO TT HERE (ADR-008): the TT universe clock conversion lives
// client-side, in the ttClock module (ADR-008 Decision 1). The server hands
// out UTC and a monotonic reading only; it never computes TT seconds and
// never lets a civil `Date`-like value carry simulation time — ADR-008
// measured that a naive date-feed misplaces a TT instant by the whole ΔT
// (63.8–75.4 s at 2000–2026 epochs). utcMillis is a wall-clock BRIDGE
// (documented as such, never a sim-time source); serverMonotonicMillis is
// milliseconds since this module's process start, a stable monotonic base a
// client can anchor its clock-smoothing offset estimate against. The
// server-owned UniverseClock with its serializable field set
// (COORDINATE_SYSTEM.md §4) lands in a later phase on top of this surface.
func rpcWorldTime(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	resp := worldTimeResponse{
		UtcMillis:             time.Now().UnixMilli(),
		ServerMonotonicMillis: time.Since(processStart).Milliseconds(),
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return "", runtime.NewError("world_time encode failed", grpcInternal)
	}
	return string(b), nil
}

// -------------------------------------------------------------- voice token

type voiceTokenRequest struct {
	Room string `json:"room"`
}

type voiceTokenResponse struct {
	Token              string `json:"token"`
	Room               string `json:"room"`
	Identity           string `json:"identity"`
	LiveKitHost        string `json:"liveKitHost"`
	ExpiresAtUtcMillis int64  `json:"expiresAtUtcMillis"`
}

// rpcVoiceToken mints one LiveKit access token for the calling user.
// Payload (optional JSON): {"room": "<id>"} — omitted/empty falls back to the
// groundwork global room. [PLACEHOLDER — gate: Phase 6 owns the room
// topology: per-region proximity rooms driven by the AoI grid.]
//
// Suspension (NETWORKING.md §12: suspended users get listen-only tokens) is
// NOT implemented: there is no suspension data source yet. Recorded as an
// open integration item rather than pretended.
func rpcVoiceToken(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	apiKey := envLookup(ctx, "LIVEKIT_API_KEY")
	apiSecret := envLookup(ctx, "LIVEKIT_API_SECRET")
	host := envLookup(ctx, "LIVEKIT_HOST")
	if apiKey == "" || apiSecret == "" || host == "" {
		return "", runtime.NewError("voice is not configured on this server: LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_HOST must be set in the runtime environment", grpcFailedPrecondition)
	}

	room := "kwetu-global"
	if payload != "" {
		var req voiceTokenRequest
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			return "", runtime.NewError("voice_token_rpc payload must be JSON like {\"room\":\"<id>\"}", grpcInvalidArgument)
		}
		if req.Room != "" {
			room = req.Room
		}
	}
	// Room ids are user input here (the default is always valid), so a bad id
	// is a caller error (invalid argument), not an internal mint failure.
	if !validRoomName(room) {
		return "", runtime.NewError("voice_token_rpc room must be 1-64 characters of [A-Za-z0-9_-]", grpcInvalidArgument)
	}

	identity := ctx.Value(runtime.RUNTIME_CTX_USER_ID)
	userID, _ := identity.(string)
	if userID == "" {
		return "", runtime.NewError("voice_token_rpc requires an authenticated session", grpcFailedPrecondition)
	}

	token, err := MintVoiceToken(apiKey, apiSecret, userID, room, time.Now())
	if err != nil {
		logger.WithField("error", err.Error()).Error("voice_token_rpc mint failed")
		return "", runtime.NewError("voice token could not be minted", grpcInternal)
	}

	resp := voiceTokenResponse{
		Token:              token,
		Room:               room,
		Identity:           userID,
		LiveKitHost:        host,
		ExpiresAtUtcMillis: time.Now().Add(voiceTokenTTL).UnixMilli(),
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return "", runtime.NewError("voice token encode failed", grpcInternal)
	}
	logger.Info("voice token minted (room configured; grants roomJoin/canPublish/canSubscribe/canPublishData)")
	return string(b), nil
}

// ----------------------------------------------------------------- helpers

// envLookup resolves one configuration key READ-ONLY: the Nakama runtime
// environment first (config `runtime.env`, injected through the request
// context), then the process environment. Values are never logged; unset keys
// return "" and callers decide the failure mode (structured error, never a
// panic). (.env is gitignored and is never read by this module or its tests.)
func envLookup(ctx context.Context, key string) string {
	if m, ok := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string); ok {
		if v, inMap := m[key]; inMap {
			return v
		}
	}
	return os.Getenv(key)
}

// jsonUnmarshalStrict decodes exactly one JSON value from s into v and
// rejects any trailing non-whitespace data. Shared by the RPC unit tests so
// the assertions read the same payload shape a client library would parse.
func jsonUnmarshalStrict(s string, v interface{}) error {
	dec := json.NewDecoder(strings.NewReader(s))
	if err := dec.Decode(v); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("rpc: trailing data after the JSON value")
	}
	return nil
}
