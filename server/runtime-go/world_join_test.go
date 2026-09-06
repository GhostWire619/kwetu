// Kwetu — world_join_rpc unit tests (no live Nakama required).
//
// MatchList/MatchCreate run through a stub that embeds the nil
// runtime.NakamaModule interface and overrides exactly the two calls the RPC
// makes — the same pattern as the other RPC tests (plain-Go handlers, nop
// logger). What this can NOT cover: the live HTTP surface and Nakama's own
// match lifecycle — verified against the running server (README.md §Deploy).
package main

import (
	"context"
	"strings"
	"testing"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

// stubNakama routes only MatchList/MatchCreate; every other NakamaModule
// method panics via the nil-embedded interface if a test's code path calls
// one unexpectedly (loud, not silent).
type stubNakama struct {
	runtime.NakamaModule
	list   func() ([]*api.Match, error)
	create func() (string, error)
}

func (s *stubNakama) MatchList(ctx context.Context, limit int, authoritative bool, label string, minSize, maxSize *int, query string) ([]*api.Match, error) {
	if !authoritative {
		panic("world_join must list authoritative matches only")
	}
	if label != MatchName || query != "" || limit != 1 {
		panic("world_join must filter on the exact match label")
	}
	return s.list()
}

func (s *stubNakama) MatchCreate(ctx context.Context, module string, params map[string]interface{}) (string, error) {
	if module != MatchName || params != nil {
		panic("world_join must create the registered match with default params")
	}
	return s.create()
}

func TestWorldJoinCreatesWhenNoMatchExists(t *testing.T) {
	nk := &stubNakama{
		list:   func() ([]*api.Match, error) { return nil, nil },
		create: func() (string, error) { return "match-fresh-1", nil },
	}
	out, err := rpcWorldJoin(context.Background(), nopLogger{}, nil, nk, "")
	if err != nil {
		t.Fatal(err)
	}
	var resp map[string]any
	if err := jsonUnmarshalStrict(out, &resp); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if resp["matchId"] != "match-fresh-1" {
		t.Fatalf("matchId = %v, want match-fresh-1", resp["matchId"])
	}
	if resp["created"] != true {
		t.Fatalf("created = %v, want true", resp["created"])
	}
}

func TestWorldJoinReturnsExistingMatchWithoutCreating(t *testing.T) {
	created := false
	nk := &stubNakama{
		list: func() ([]*api.Match, error) {
			return []*api.Match{{MatchId: "match-live-7"}}, nil
		},
		create: func() (string, error) {
			created = true
			return "match-should-not-exist", nil
		},
	}
	out, err := rpcWorldJoin(context.Background(), nopLogger{}, nil, nk, "")
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("world_join created a match although one exists")
	}
	var resp map[string]any
	if err := jsonUnmarshalStrict(out, &resp); err != nil {
		t.Fatal(err)
	}
	if resp["matchId"] != "match-live-7" || resp["created"] != false {
		t.Fatalf("response = %v, want {matchId: match-live-7, created: false}", resp)
	}
}

func TestWorldJoinRejectsInvalidPayload(t *testing.T) {
	nk := &stubNakama{
		list:   func() ([]*api.Match, error) { panic("list must not run for an invalid payload") },
		create: func() (string, error) { panic("create must not run for an invalid payload") },
	}
	_, err := rpcWorldJoin(context.Background(), nopLogger{}, nil, nk, `{"region": "stone-town", "extra": 1}`)
	if err == nil {
		t.Fatal("strict-JSON payload with an unknown key must be rejected")
	}
}

func TestWorldJoinSurfacesListFailure(t *testing.T) {
	nk := &stubNakama{
		list:   func() ([]*api.Match, error) { return nil, context.DeadlineExceeded },
		create: func() (string, error) { panic("create must not run after a list failure") },
	}
	_, err := rpcWorldJoin(context.Background(), nopLogger{}, nil, nk, "")
	if err == nil || !strings.Contains(err.Error(), "match list failed") {
		t.Fatalf("list failure must surface a structured error, got %v", err)
	}
}
