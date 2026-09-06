// Kwetu — world_join_rpc: find-or-create the authoritative region match.
//
// The client's ONE-call entry into the shared world (client/src/net/
// session.ts): respond with the joinable match id, creating the match on
// first call after an empty-tick termination. The match handler itself is
// match.go ("kwetu_world"); its MatchInit stamp makes the match LABEL equal
// MatchName, which is what MatchList filters on here.
//
// Payload (optional): {"region": "<name>"} — ACCEPTED AND IGNORED tonight.
// The groundwork runs exactly one authoritative match whose label is
// MatchName; the region registry (per-region matches with per-region labels)
// is the Phase-5 design item match.go's MatchJoinAttempt comment points at.
// An unknown/absent payload is fine; a region value the registry would
// reject is not distinguishable yet, and this file does not pretend it is.
//
// Concurrency note: two simultaneous calls can both observe an empty list
// and both create. The loser is a fresh match with no presences, which the
// handler's emptyTickLimit terminates on its own (match.go MatchLoop) —
// self-healing within the limit, recorded here rather than pretended away.
// The Phase-5 registry owns the real fix (a storage-leased creation gate).
package main

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

type worldJoinRequest struct {
	Region string `json:"region,omitempty"`
}

type worldJoinResponse struct {
	MatchID string `json:"matchId"`
	Created bool   `json:"created"`
}

func rpcWorldJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	if payload != "" {
		var req worldJoinRequest
		if err := jsonUnmarshalStrict(payload, &req); err != nil {
			return "", runtime.NewError("world_join: payload is not a valid world_join_request", grpcInvalidArgument)
		}
		// req.Region is accepted and deliberately unused tonight (see header).
	}

	// One authoritative match per label; label match is exact (query "").
	auth := true
	matches, err := nk.MatchList(ctx, 1, auth, MatchName, nil, nil, "")
	if err != nil {
		logger.WithField("error", err.Error()).Error("world_join: match list failed")
		return "", runtime.NewError("world_join: match list failed", grpcInternal)
	}
	if len(matches) > 0 {
		return marshalWorldJoin(matches[0], false)
	}

	matchID, err := nk.MatchCreate(ctx, MatchName, nil)
	if err != nil {
		logger.WithField("error", err.Error()).Error("world_join: match create failed")
		return "", runtime.NewError("world_join: match create failed", grpcInternal)
	}
	logger.WithField("match_id", matchID).Info("world_join: created the region match")
	// MatchGet is the honest shape here: MatchCreate returns the id, and the
	// response needs only the id — no re-fetch, no fabricated fields.
	return marshalWorldJoin(&api.Match{MatchId: matchID}, true)
}

func marshalWorldJoin(match *api.Match, created bool) (string, error) {
	resp := worldJoinResponse{MatchID: match.GetMatchId(), Created: created}
	b, err := json.Marshal(resp)
	if err != nil {
		return "", runtime.NewError("world_join: encode failed", grpcInternal)
	}
	return string(b), nil
}
