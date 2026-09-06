# Kwetu Nakama Go runtime module

The Kwetu authoritative server runtime (Phase-5 groundwork): core RPCs plus the
authoritative region match handler `kwetu_world`. Contracts implemented here:

- **ADR-007** (S0.6): the server-validation contract — versioned kinematic
  replay with clamped client claims, trapezoidal step speed, drift thresholds.
  NO server-side physics, no contact solver, no "server-authoritative physics"
  (NETWORKING.md §6 wording is binding).
- **ADR-009** (S0.8): the AoI cell grid — `tools/spikes/s0.8/aoi.ts` is the
  normative algorithm spec (Decision 3); `aoi.go` reproduces it step for step,
  with 250 m cells / 500 m radius (Decision 1).
- **ADR-008** (S0.7): the server hands out UTC + a monotonic reading only —
  TT conversion stays client-side (`ttClock`), never on the server.
- **NETWORKING.md** §4: ≤1500 B per message (the cap never moves), ~1 coalesced
  message per tick per presence; §5: Go-runtime match handlers own the tick.

## Files

| File | Owns |
|---|---|
| `main.go` | plugin entry, RPC + match registration |
| `aoi.go` | AoI cell grid (ADR-009 port; step-for-step parity with the TS spec) |
| `validator.go` | ADR-007 kinematic replay: clamps, drift window, session verdict |
| `snapshot.go` | wire format: opcodes, 24 B record ledger, 1500 B cap arithmetic |
| `match.go` | `kwetu_world` handler: Init/JoinAttempt/Join/Leave/Loop/Terminate/Signal |
| `rpc.go` | `healthcheck_rpc`, `world_time_rpc`, `voice_token_rpc` |
| `voice.go` | HS256 LiveKit token minting (stdlib only, no JWT dependency) |
| `*_test.go` | AoI parity, validator parity, wire-ledger, RPC and mint tests |

## Build (inside the matching container — never on the Windows host)

The plugin is `linux/amd64`, CGO on, and is dynamically linked into the
Nakama server binary. **Both the toolchain and the build flags are
load-compatibility requirements**: a mismatched plugin refuses to load and —
because Nakama treats a failed module load as fatal — crash-loops the server.

1. Read the pins off the running server binary (never from memory):

   ```
   docker cp kwetu-nakama:/nakama/nakama "$TEMP/nakama-bin"
   docker run --rm -v "C:/Users/lugat/AppData/Local/Temp:/host" golang:1.25.5 go version -m /host/nakama-bin
   ```

   For nakama **3.37.0** this measures: go1.25.5, CGO_ENABLED=1, GOOS=linux,
   GOARCH=amd64, `-trimpath=true`, deps nakama-common v1.44.2,
   protobuf v1.36.11, grpc v1.78.0. `go.mod` pins exactly these (the plugin's
   module graph does not link grpc — only nakama-common + protobuf are shared).

2. Build + gates in the same toolchain image (from the repo root; note the
   repo root is mounted, not just the package, so the validator's golden
   parity tests can read `tools/spikes/s0.6/sessions/*.json`):

   ```
   docker run --rm -v "C:/Users/lugat/Projects/kwetu:/repo" -w /repo/server/runtime-go \
     -e CGO_ENABLED=1 -e GOOS=linux -e GOARCH=amd64 golang:1.25.5 \
     sh -c "go mod tidy && go vet ./... && go test ./... && \
            go build -trimpath -buildmode=plugin -o /repo/server/runtime-go/kwetu.so ."
   ```

   **`-trimpath` is mandatory.** The host binary is built with `-trimpath=true`;
   an untrimmed plugin compiles the shared stdlib/nakama-common packages with
   different (absolute) source paths, their build IDs diverge, and the load
   fails with `plugin was built with a different version of package
   internal/goarch` even when the Go version matches. [MEASURED 2026-09-06:
   both failure modes observed against the live 3.37.0 server — untrimmed
   go1.25.5 build rejected; trimmed build loaded.]

3. Deploy: copy the built `.so` where the server's `data_dir/modules` mounts
   (compose maps `infra/nakama/data` → `/nakama/data`, config.yml pins
   `data_dir: /nakama/data`):

   ```
   cp server/runtime-go/kwetu.so infra/nakama/data/modules/kwetu.so
   docker compose --env-file .env -f infra/docker-compose.yml restart nakama
   docker compose --env-file .env -f infra/docker-compose.yml logs nakama | grep -i kwetu
   ```

   A clean load logs `Found runtime modules`, the three
   `Registered Go runtime RPC function invocation` lines, the
   `Registered Go runtime Match creation function invocation` line, and the
   module's own `kwetu runtime module <version> loaded` line from InitModule.

## Runtime environment (read-only lookups)

`voice_token_rpc` reads three keys — via the Nakama runtime environment
(config `runtime.env`, surfaced through the request context) first, then the
process environment:

| Key | Meaning |
|---|---|
| `LIVEKIT_API_KEY` | LiveKit API key (also the token `iss` claim) |
| `LIVEKIT_API_SECRET` | LiveKit API secret (HS256 signing key) |
| `LIVEKIT_HOST` | LiveKit server URL handed back to the client |

Keys are never logged, never hardcoded; `.env` is gitignored and is never read
by the module or its tests. If any key is unset the RPC returns a structured
error (gRPC code 9, failed-precondition) naming the missing keys — never a
panic. **Current dev-stack state**: compose injects the LiveKit keys into the
`livekit` container only, not into `nakama`'s environment — so the live RPC
verifiably returns the not-configured error until the compose wiring adds them
to the nakama service (orchestrator-owned file; recorded as a follow-up).

## RPC surface (measured wire contract)

All three are registered RPCs callable over HTTP `POST /v2/rpc/<id>` with a
session bearer token, and over the WebSocket. The payload handling below was
measured against the live 3.37.0 server and matches the v3.37.0 source
(`server/api_rpc.go`): the request body must be a **JSON-encoded string**
(the wire form every Nakama client SDK produces — `payload:
JSON.stringify(args)`), or empty, or raw with the `?unwrap` query param.

| RPC | Body (payload) | Response payload |
|---|---|---|
| `healthcheck_rpc` | empty or `"{}"`-style string | `{"ok":true,"module":"kwetu-runtime-go","moduleVersion":"0.1.0","matchName":"kwetu_world","uptimeSeconds":<s>,"utcMillis":<ms>}` |
| `world_time_rpc` | empty or any JSON string | `{"utcMillis":<ms>,"serverMonotonicMillis":<ms>}` — UTC + monotonic only; TT conversion stays client-side (ADR-008; see the handler comment for the measured ΔT trap that forbids server-side TT) |
| `voice_token_rpc` | JSON string of `{"room":"<id>"}` (optional; default `kwetu-global`; `[A-Za-z0-9_-]{1,64}`) | `{"token":"<jwt>","room":"…","identity":"<user id>","liveKitHost":"…","expiresAtUtcMillis":<ms>}` — HS256 JWT with `video` grants `roomJoin`/`canPublish`/`canSubscribe`/`canPublishData`, TTL 6 h |

The minted token's claim shape mirrors livekit/protocol's
`tokenClaims{RegisteredClaims, ClaimGrants}` (registered claims + grants
flattened at the top level; the can* permissions are pointers so a future
listen-only token can encode explicit `false` — absent means default-allow
upstream). Verified in unit tests (signature re-derivation, claim shape,
explicit-false encoding). **Not verified against a live LiveKit server** — a
real room join is the Phase-6 exit criterion.

## Match handler `kwetu_world`

Registered with tick rate 20 Hz. Parameters (all optional, passed to
`MatchInit`): `tickRate` (1–60), `cellSize` (m, > 0), `aoiRadius` (m, > 0),
`emptyTickLimit` (≥ 1), `driftThreshold` (m, > 0).

Per tick (`MatchLoop`), bounded work in this order:

1. consume queued `OpClientState` (op 1) reports — one per presence per tick
   is the budget; each report is 24 B: tick u32 + pos 3×f32 + yaw f32 + speed
   f32 (ADR-007's wire state, f32-quantized).
2. validate each report through the ADR-007 replay (clamped claims only):
   the per-tick drift joins a rolling 1200-tick (60 s) window; a window max
   ≥ threshold rejects — the server keeps its clamped replay state and sends
   the offender an `OpServerCorrection` (op 3) on a 20-tick cooldown. Rejection
   is recorded, never a crash.
3. one AoI rebuild (ADR-009 rebuild-per-tick semantics), then one coalesced
   `OpServerSnapshot` (op 2) per presence: self first, then AoI neighbours
   nearest-first, capped at 56 records (byte-ledger arithmetic below), with
   the truncated flag when the set exceeded the budget.
4. observability heartbeat log every 1200 ticks (drift rejects, malformed
   count). Match ends by returning nil state after `emptyTickLimit`
   consecutive ticks with no presences and no queued messages (Go-runtime
   termination semantics, NETWORKING.md §5).

### Byte ledger (1500 B cap arithmetic)

```
snapshot payload = envelope 14 B + record 24 B × n
envelope: tick u32 + entityCount u16 + flags u16 + reserved u8×6
record:   id u32 + pos 2×f32 + vel 2×i16 (cm/s) + heading u16 (1/65536 turns)
          + frameId u8 + movementRegime u8 + modelRevision u16 + stateFlags u16
record budget = floor((1500 − 128 − 14) / 24) = 56 records
```

[MEASURED 2026-09-06, `TestSnapshotCapArithmetic`]: a full-budget snapshot
payload is **1358 B** — 142 B of headroom to the 1500 B cap; the 128 B margin
is a stated stand-in for Nakama's protobuf envelope + WS/TLS framing, to be
replaced by a measured ledger in the Phase-5 netcode design doc. The record
budget is derived from the cap, not checked after the fact, so the encoder is
structurally inside the limit; the cap itself never moves (CLAUDE.md).

Measured vs placeholder, in one line each:

- [MEASURED] AoI port parity: the three ADR-009 headline population rows
  reproduce exactly — N5000/cell 250 uniform (23, 334), clustered (129, 2411),
  N5000/cell 1000 clustered (1686, 2921) — plus the 12 spec scenarios.
- [MEASURED] validator parity: the recorded S0.6 sessions replay to the
  ADR-007 values — legal maxDrift 4.52414e-05 m at tick 2994, tampered
  169.018 m at tick 1477 (margin 3.74e6) — and the synthetic port reproduces
  them within the stated factors.
- [MEASURED] live load + RPC round-trips against the running 3.37.0 server
  (see the log lines and payload examples above).
- [PLACEHOLDER — gate: Phase 4] validator clamps (6 m/s², 2.5 rad/s, 55 m/s,
  no reverse) and the 1.0 m accept threshold.
- [PLACEHOLDER — gate: Phase 5 netcode design doc] the 128 B framing margin,
  the 24 B record ledger, the nearest-first truncation as the priority-tier
  stand-in, the 1200-tick live replay window and correction cooldown.
- [PLACEHOLDER — gate: Phase 3/5] the 500 m AoI radius (ADR-009 Open item 2).
- NOT implemented (Phase-5 work, not stubbed): storage snapshots /
  resume-after-restart, suspended-user listen-only tokens, the spin-class
  heading-drift rejection path, sanctioned-discontinuity events, region
  handoffs, per-presence priority tiers. No capacity claim of any kind is
  made or licensed here (ADR-009 / NETWORKING.md §9).

## Upgrading (Nakama version bump)

Re-derive every pin from the new server binary (`go version -m`, step 1
above), update `go.mod`, rebuild, redeploy, and re-run the load check. A
Nakama upgrade that changes the Go toolchain or any shared dependency WILL
reject the previously built plugin — expect to rebuild on every bump.
