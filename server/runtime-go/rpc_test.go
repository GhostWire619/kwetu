// Kwetu — RPC unit tests (no live Nakama required).
//
// healthcheck_rpc, world_time_rpc and voice_token_rpc are exercised through
// their plain-Go handler signatures with a no-op logger and hand-built
// contexts. What these tests can NOT cover: the live HTTP/gRPC surface,
// session auth, and the runtime env injection — those are verified against
// the running server (README.md §Deploy) rather than claimed here.
package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// nopLogger satisfies runtime.Logger (nakama-common v1.44.2: Debug/Info/Warn/
// Error + WithField/WithFields/Fields — verified against the fetched module
// source, not memory) without emitting anything.
type nopLogger struct{}

func (nopLogger) Debug(string, ...interface{})                       {}
func (nopLogger) Info(string, ...interface{})                        {}
func (nopLogger) Warn(string, ...interface{})                        {}
func (nopLogger) Error(string, ...interface{})                       {}
func (l nopLogger) WithField(string, interface{}) runtime.Logger     { return l }
func (l nopLogger) WithFields(map[string]interface{}) runtime.Logger { return l }
func (l nopLogger) Fields() map[string]interface{}                   { return nil }

func TestHealthcheckRPCShape(t *testing.T) {
	before := time.Now().UnixMilli()
	out, err := rpcHealthcheck(context.Background(), nopLogger{}, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	afterMs := time.Now().UnixMilli()

	var resp map[string]any
	if err := jsonUnmarshalStrict(out, &resp); err != nil {
		t.Fatalf("healthcheck response is not JSON: %v", err)
	}
	if resp["ok"] != true {
		t.Fatalf("ok = %v, want true", resp["ok"])
	}
	if resp["moduleVersion"] != moduleVersion {
		t.Fatalf("moduleVersion = %v, want %s", resp["moduleVersion"], moduleVersion)
	}
	if resp["matchName"] != MatchName {
		t.Fatalf("matchName = %v, want %s", resp["matchName"], MatchName)
	}
	utc, ok := resp["utcMillis"].(float64)
	if !ok || utc < float64(before) || utc > float64(afterMs) {
		t.Fatalf("utcMillis = %v, want a wall-clock ms value in [%d, %d]", resp["utcMillis"], before, afterMs)
	}
	uptime, ok := resp["uptimeSeconds"].(float64)
	if !ok || uptime < 0 {
		t.Fatalf("uptimeSeconds = %v, want a non-negative duration", resp["uptimeSeconds"])
	}
}

func TestWorldTimeRPC(t *testing.T) {
	before := time.Now().UnixMilli()
	out, err := rpcWorldTime(context.Background(), nopLogger{}, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	afterMs := time.Now().UnixMilli()

	var resp map[string]any
	if err := jsonUnmarshalStrict(out, &resp); err != nil {
		t.Fatalf("world_time response is not JSON: %v", err)
	}
	utc, ok := resp["utcMillis"].(float64)
	if !ok || utc < float64(before) || utc > float64(afterMs) {
		t.Fatalf("utcMillis = %v, want wall-clock ms in [%d, %d]", resp["utcMillis"], before, afterMs)
	}
	mono, ok := resp["serverMonotonicMillis"].(float64)
	if !ok || mono < 0 {
		t.Fatalf("serverMonotonicMillis = %v, want a non-negative monotonic reading", resp["serverMonotonicMillis"])
	}

	// ADR-008 posture check at the type level: the response carries UTC +
	// monotonic only. TT conversion stays client-side (ttClock), so the
	// payload must not contain any TT field.
	if _, has := resp["worldTimeTtSeconds"]; has {
		t.Fatal("world_time_rpc must never hand out TT — the server owns UTC/monotonic only (ADR-008 Decision 1: TT conversion lives client-side)")
	}
}

func TestVoiceTokenRPCUnsetEnvIsStructuredError(t *testing.T) {
	// No LIVEKIT_* in the runtime env or the process env: the RPC must fail
	// gracefully with a structured error (never panic, never log a secret).
	// The keys are cleared in-process (t.Setenv restores the previous value
	// after the test) so this path is exercised on every machine, including
	// hosts whose environment exports LiveKit variables; envLookup treats
	// present-but-empty exactly like absent ("" → not configured).
	t.Setenv("LIVEKIT_API_KEY", "")
	t.Setenv("LIVEKIT_API_SECRET", "")
	t.Setenv("LIVEKIT_HOST", "")
	_, err := rpcVoiceToken(context.Background(), nopLogger{}, nil, nil, "")
	rpcErr, ok := err.(*runtime.Error)
	if !ok {
		t.Fatalf("err = %T (%v), want *runtime.Error", err, err)
	}
	if rpcErr.Code != grpcFailedPrecondition {
		t.Fatalf("code = %d, want %d (failed precondition: server-side voice config missing)", rpcErr.Code, grpcFailedPrecondition)
	}
	if !strings.Contains(rpcErr.Message, "LIVEKIT_API_KEY") {
		t.Fatalf("message = %q, want it to name the missing configuration", rpcErr.Message)
	}
}

func TestVoiceTokenRPCSuccessAndBadPayload(t *testing.T) {
	ctx := context.WithValue(context.Background(), runtime.RUNTIME_CTX_ENV, map[string]string{
		"LIVEKIT_API_KEY":    "testkey",
		"LIVEKIT_API_SECRET": "testsecret-0123456789abcdef",
		"LIVEKIT_HOST":       "wss://voice.example.invalid",
	})
	ctx = context.WithValue(ctx, runtime.RUNTIME_CTX_USER_ID, "user-uuid-1")

	out, err := rpcVoiceToken(ctx, nopLogger{}, nil, nil, "")
	if err != nil {
		t.Fatalf("mint with a fully configured env failed: %v", err)
	}
	var resp map[string]any
	if err := jsonUnmarshalStrict(out, &resp); err != nil {
		t.Fatal(err)
	}
	token, _ := resp["token"].(string)
	if token == "" || strings.Count(token, ".") != 2 {
		t.Fatalf("token = %q, want a three-segment compact JWT", token)
	}
	if resp["room"] != "kwetu-global" {
		t.Fatalf("room = %v, want the groundwork default kwetu-global", resp["room"])
	}
	if resp["identity"] != "user-uuid-1" {
		t.Fatalf("identity = %v, want the authenticated user id", resp["identity"])
	}
	if resp["liveKitHost"] != "wss://voice.example.invalid" {
		t.Fatalf("liveKitHost = %v, want the env-provided host", resp["liveKitHost"])
	}
	if err := VerifyVoiceTokenSignature(token, "testsecret-0123456789abcdef"); err != nil {
		t.Fatalf("minted token does not self-verify: %v", err)
	}

	// A room override rides the payload; garbage is a structured 3 (invalid argument).
	out, err = rpcVoiceToken(ctx, nopLogger{}, nil, nil, `{"room":"region-ea-1"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"room":"region-ea-1"`) {
		t.Fatalf("room override not applied: %s", out)
	}
	_, err = rpcVoiceToken(ctx, nopLogger{}, nil, nil, `{"room":"has space"}`)
	rpcErr, ok := err.(*runtime.Error)
	if !ok || rpcErr.Code != grpcInvalidArgument {
		t.Fatalf("invalid room err = %v, want code %d", err, grpcInvalidArgument)
	}

	// An unauthenticated context (no user id) is a precondition failure.
	_, err = rpcVoiceToken(context.WithValue(context.Background(), runtime.RUNTIME_CTX_ENV, map[string]string{
		"LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s", "LIVEKIT_HOST": "h",
	}), nopLogger{}, nil, nil, "")
	rpcErr, ok = err.(*runtime.Error)
	if !ok || rpcErr.Code != grpcFailedPrecondition {
		t.Fatalf("unauthenticated err = %v, want code %d", err, grpcFailedPrecondition)
	}
}
