// Kwetu — Nakama Go runtime module (Phase-5 groundwork).
//
// Registers the core RPCs and the authoritative region match handler. The
// plugin is built with -buildmode=plugin for linux/amd64 with the EXACT
// toolchain and nakama-common version the pinned Nakama server was built
// with — see go.mod and README.md §Upgrading (a mismatched toolchain or a
// drifted shared dependency refuses to load at server start).
package main

import (
	"context"
	"database/sql"

	"github.com/heroiclabs/nakama-common/runtime"
)

// RPC ids (client-visible; stable contract surface).
const (
	RpcHealthcheck = "healthcheck_rpc"
	RpcWorldTime   = "world_time_rpc"
	RpcVoiceToken  = "voice_token_rpc"
)

// InitModule is the Nakama plugin entry point.
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	if err := initializer.RegisterRpc(RpcHealthcheck, rpcHealthcheck); err != nil {
		return err
	}
	if err := initializer.RegisterRpc(RpcWorldTime, rpcWorldTime); err != nil {
		return err
	}
	if err := initializer.RegisterRpc(RpcVoiceToken, rpcVoiceToken); err != nil {
		return err
	}
	if err := initializer.RegisterMatch(MatchName, newKwetuWorldMatch); err != nil {
		return err
	}

	logger.Info("kwetu runtime module %s loaded: rpcs(%s, %s, %s) + match(%s, %d Hz, AoI %.0f m cells / %.0f m radius)",
		moduleVersion, RpcHealthcheck, RpcWorldTime, RpcVoiceToken, MatchName, matchTickRate, aoiCellSizeM, aoiRadiusM)
	return nil
}

// main is required for -buildmode=plugin but is never executed: Nakama calls
// InitModule when loading the .so.
func main() {}
