# Networking — transport, netcode, and voice

**Status**: draft (docs-first, pre-code) · 2026-09-05
**Owns**: how Kwetu moves state between browser and server, how the server
validates it, and how players hear each other. Every performance number is
owned by `ROADMAP.md` §Budgets; this file states the rules that produce
those numbers. Evidence tags (`[MEASURED]` / `[EXTERNAL]` /
`[PLACEHOLDER — gate]`) follow `docs/adr/README.md`.

## 1. Hard rules (TL;DR)

1. **Browsers cannot send UDP.** Every client↔server message rides
   TCP/TLS (WebSocket) unless a later *measured* spike proves a WebRTC
   datachannel path is worth its cost (§3).
2. **Message budget is a hard rule, not a guideline**: ≤1500 bytes per
   message, ~1 message per tick per presence, coalesced (§4).
3. **The server is authoritative over decisions and kinematics only.** It
   will never run Rapier. Never write "server-authoritative physics"
   into any doc, pitch, or UI string (§6).
4. **Match handlers live in the Go runtime.** The TypeScript runtime is
   ES5, single-threaded, no-WASM RPC glue and can never carry
   simulation (§5).
5. **The universe clock is server-owned** (§8); time semantics are the
   open S0.7 gate.
6. **Voice is push-to-talk by default** — a product decision forced by
   Chromium's echo-cancellation gap (§11).
7. **No capacity promises.** Kwetu is, through Phase 2, a single
   monolithic stateful node with zero benchmark data (§9).

## 2. Transport reality

A browser cannot open a UDP socket, full stop. This is a deliberate
platform boundary, and the standard netcode literature assumes it away:
Glenn Fiedler, ["Why can't I send UDP packets from a browser?"](https://www.gafferongames.com/post/why_cant_i_send_udp_packets_from_a_browser/) and ["UDP vs. TCP"](https://www.gafferongames.com/post/udp_vs_tcp/) [EXTERNAL].

What we actually have is Nakama's real-time socket: one WebSocket
(TCP+TLS) carrying everything — match state, chat, presence events,
signals. TCP is *reliable and ordered*, so under packet loss a lost
segment head-of-line blocks every later byte in the stream until
retransmission completes. On East African access links — long RTTs,
mobile backhaul, and carrier-grade NAT on most consumer ISPs — loss is a
normal operating condition, not an edge case. Loss therefore manifests to
the player as a *stall and then a burst of stale frames* — the client
must render through stalls (interpolation buffers, §7), not assume smooth
delivery.

The one escape hatch browsers do offer is a **WebRTC datachannel**
(SCTP over DTLS) with per-message reliability/ordering modes — i.e.
unreliable-unordered delivery with no head-of-line blocking. That is the
only candidate for a later transport upgrade:

- **A later, measured decision.** Not Phase 0 work. Gated on a spike that
  measures real-world WebSocket behavior on representative East African
  links (loss profile, stall length under load) against a datachannel
  transport. Its numbers land in `ROADMAP.md` §Budgets as `[MEASURED]`
  rows; until then every capacity/latency claim here is
  `[PLACEHOLDER — gate]`.
- **geckos.io**
  ([github.com/geckosio/geckos.io](https://github.com/geckosio/geckos.io)
  [EXTERNAL]) is our pattern source for the datachannel layer —
  unreliable/ordered options,
  channel management, server-authoritative room structure. License:
  BSD-3-Clause `[MEASURED 2026-09-05, GitHub API]`. Upstream is
  effectively dormant (no recent stable release), so if the pattern is
  adopted it is **fork-and-own**, not a dependency.
- **TURN relay cost is the reason this is gated.** Any WebRTC path will
  relay a large share of sessions — CGNAT clients behind symmetric NAT
  cannot punch through without TURN — so a transport "upgrade" converts
  a server-bandwidth bill into a *relayed-bandwidth bill*: a TURNed path
  adds a relay hop and its per-session overhead on top of the SFU relay
  that every session already pays. Cost model: `[PLACEHOLDER — gate]`,
  owned by §Budgets row B-COST-02.

## 3. Topology: same-origin wss through Caddy

```
Browser (https://<host>/)
    │  TLS terminated at Caddy (automatic ACME cert)
    ▼
Caddy :443 ──► static site (three.js build)
    └── /ws   ──► reverse_proxy nakama:7350   (WebSocket)
        /api, /v2/rpc ──► nakama:7350         (HTTP auth + RPC)
```

- The browser talks to **one origin**. Caddy terminates TLS and
  reverse-proxies to Nakama's socket port (`socket.port`, default 7350
  `[EXTERNAL]` https://heroiclabs.com/docs/nakama/getting-started/configuration/).
  Nakama's own TLS options exist but are documented as not recommended
  for production — TLS lives at Caddy.
- **Nakama ships permissive CORS internally.** The API gateway answers
  with `Access-Control-Allow-Origin: *` (hardcoded via gorilla/handlers
  in `server/api.go`) `[MEASURED 2026-09-05, Nakama source]` [EXTERNAL]
  https://github.com/heroiclabs/nakama — and `socket.response_headers`
  only fills values the server does not already set.
- **Same-origin is preferred anyway**, because it is simpler and
  stricter, not because Nakama forbids the wildcard: same-origin
  `fetch`/RPC calls issue no CORS preflights; the WebSocket handshake is
  not subject to CORS at all when same-origin; and the CSP collapses to
  `connect-src 'self'` instead of negotiating wildcard origins in a
  header layer we don't control. The wildcard stays available for local
  development tooling; production is same-origin or it is a bug.

## 4. Message budget (hard rules)

Constraints on every feature, enforced in review, not tunables:

1. **≤1500 bytes per message.** No client→server or server→client
   message may exceed this, regardless of the server's configured cap.
   It keeps frames small and predictable on lossy links and forces
   schema discipline.
2. **~1 message per tick per presence.** Each client coalesces its input
   into a single send per tick; the server coalesces its broadcast into
   a single send per tick per presence. Features that want "more
   messages" get more *bytes inside the one message*, not more messages.
3. **Coalescing beats splitting.** One 1000-byte message per second is
   strictly better than five 200-byte messages per second: each
   WebSocket frame pays TLS record and frame overhead, and on TCP every
   extra frame is another unit that loss can stall behind (§2). Batch.
4. **The server cap is real and it is fatal.**
   `socket.max_message_size_bytes` defaults to 4096 bytes `[EXTERNAL]`
   (configuration reference, URL above). When a client sends an
   oversized message the server **closes the connection**. Verify exact
   close behavior against the pinned Nakama version at implementation
   time, but design as if one fat message ends your session — because
   it can.

Concrete implication: snapshot and input payloads are field-budgeted
(byte ledger per opcode, maintained next to the protocol definitions in
the netcode design doc), and any feature that cannot fit its budget gets
a delta/compression pass, not an exception.

## 5. The authoritative model: Go-runtime match handlers

Authoritative multiplayer simulation runs in Nakama **authoritative
matches** whose handlers are written in the **Go runtime**. The match
handler owns the tick loop; the server's tick is the only clock that
advances shared simulation state.

The full callback contract — `ctx`, `logger`, `db`, `nk` parameters
elided; verified against the current docs `[EXTERNAL]`
https://heroiclabs.com/docs/nakama/server-framework/go-runtime/function-reference/match-handler/

| Callback | Signature (delta) | Semantics |
|---|---|---|
| `MatchInit` | `(..., params map[string]interface{}) (interface{}, int, string)` | Runs once at creation. Returns `(state, tickrate, label)`. Tickrate must be 1–60; label ≤2048 chars (it is the match's lookup label). |
| `MatchJoinAttempt` | `(..., dispatcher, tick, state, presence, metadata) (interface{}, bool, string)` | Gate every join, including reconnect re-joins. Returns `(state, allow bool, reason)`. This is where AoI cell checks and suspended-user refusals happen. |
| `MatchJoin` | `(..., dispatcher, tick, state, presences) interface{}` | Commit accepted presences into state. |
| `MatchLeave` | `(..., dispatcher, tick, state, presences) interface{}` | Runs on departure including connection loss — treat as "presence is gone", never as "player quit". |
| `MatchLoop` | `(..., dispatcher, tick, state, messages []runtime.MatchData) interface{}` | The tick. Consume queued client messages, advance simulation, emit broadcasts. |
| `MatchTerminate` | `(..., dispatcher, tick, state, graceSeconds int) interface{}` | Graceful-shutdown hook: this is where a snapshot is persisted (below). |
| `MatchSignal` | `(..., dispatcher, tick, state, data string) (interface{}, string)` | Cross-runtime pokes: RPC-initiated spawns, AoI handoffs, moderation actions. |

Operating rules:

- **State is in-memory** and lives only as long as the match. For
  resume-after-restart, **snapshot to storage**: `MatchTerminate` (and
  periodically every N ticks, cheaply) serializes match state into the
  Nakama storage engine, and `MatchInit` accepts a `snapshot_id` param
  to rebuild from it. Mind the storage value size cap of the pinned
  Nakama version — snapshot deltas, not monoliths.
- **Terminate idle matches yourself.** There is no built-in idle GC in
  the Go runtime: keep an `emptyTicks int` counter in your state
  struct, increment it whenever the match has no presences and no
  queued messages, and end the match by **returning `nil` state from
  `MatchLoop`** (in the Go runtime, `nil` state is the termination
  mechanism — the `MatchNoTicks` idiom belongs to the Lua/TS runtimes).
- **`MatchLoop` must finish before the next tick.** Treat this as a hard
  budget: whether the scheduler slips or stacks a slow tick, the effect
  on a shared node is the same — every match on it degrades together.
  Per-tick work is therefore bounded by design and *measured* with a
  runtime custom timer (§13), not trusted.
- **The TypeScript runtime is RPC glue and nothing else.** It is ES5,
  single-threaded, no WASM — it can never run Rapier, and it must never
  be asked to. It handles non-realtime RPC: auth flows, profile
  persistence, matchmaking requests, moderation plumbing. Voice-token
  requests are forwarded to the Go runtime, which is the only minting
  authority (§10). Everything with a physics or tick requirement lives
  in Go.

## 6. Server validation: kinematic/analytic replay, not physics

The server validates by **kinematic/analytic replay**: client-reported
positions are reconciled against closed-form models — orbital elements
propagated analytically, vehicles integrated along known equations of
motion — with **drift thresholds** defining when a client's claim is
rejected, snapped, or flagged. The validator contract (which models,
which thresholds, which actions) is **S0.6's deliverable** in
`ROADMAP.md`; this section only fixes the boundaries.

What the server **cannot** do, stated explicitly so no later doc
promises it:

- **No Rapier in the Go runtime.** There is no WASM, no arbitrary native
  physics engine, no collision solver in the authoritative path.
- Therefore **contact resolution, collisions, ragdolls, and any
  emergent-physics outcome are client-side visual/behavioral systems**,
  not server truth. The server owns *intent and trajectory* (where you
  are along a sanctioned model), not *accidents*.
- Gameplay that must be fair must be expressible as decisions over
  kinematics (overlap of volumes along reported paths, timing checks,
  rate limits), never as "the server solved the crash".
- **Never write "server-authoritative physics."** The accurate phrase is
  "server-validated kinematics".

## 7. Prediction, reconciliation, interpolation

The client-side patterns are standard; we link them, never reproduce
them (Gaffer on Games is reference material — link by URL with title,
never copy text). All `[EXTERNAL]`:

- Glenn Fiedler, ["What Every Programmer Needs To Know About Game Networking"](https://www.gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) — the shared vocabulary.
- Glenn Fiedler, ["Snapshot Interpolation"](https://www.gafferongames.com/post/snapshot_interpolation/) — remote entities render from a buffered, time-shifted snapshot window, so they move smoothly through loss and jitter instead of stuttering on every late packet (§2's stalls).
- Glenn Fiedler, ["Snapshot Compression"](https://www.gafferongames.com/post/snapshot_compression/) — baseline/delta and quantization strategy behind the §4 byte budget.
- Glenn Fiedler, ["State Synchronization"](https://www.gafferongames.com/post/state_synchronization/) — why snapshots beat event streams for a shared persistent world.
- Glenn Fiedler, ["Fix Your Timestep!"](https://www.gafferongames.com/post/fix_your_timestep/) — decoupling render rate from simulation tick.

Kwetu's shape, in one line each:

- **Client prediction** for the local player: input is applied locally
  the same tick it is generated, so controls feel instant even at
  East-African RTTs.
- **Server reconciliation**: the server's validated result of that input
  arrives later; the client rewinds and replays unacknowledged inputs on
  top of it. Local kinematics come from the same closed-form models the
  server replays (§6), so reconciliation converges instead of fighting.
- **Snapshot interpolation buffers** for everything else (links above):
  a render delay of a few ticks buys smoothness through loss. Buffer
  depth is a §Budgets number (`[PLACEHOLDER — gate]`).

## 8. Shared-world time semantics — OPEN (S0.7)

This section is a gate, not a decision. **S0.7** in `ROADMAP.md` owns
it; its outcome becomes an ADR (`docs/adr/`).

Fixed already: **the universe clock authority is server-owned.** Clients
receive epoch-anchored time and render through it; no client ever
advances shared time, or two players' skies disagree.

Open for S0.7 to settle:

- **Whether time-warp is permitted in shared space, and how.** A
  persistent universe wants time acceleration (a trip that "takes
  days"). But two players standing next to each other must share one
  rate of time. Options on the table: shared timelines with scripted
  fast-forward windows; per-observer time that must reconcile when
  players meet; time-warped pockets (instanced travel) that rejoin
  shared time. Each has different interpolation/reconciliation
  consequences (§7).
- **TT vs UTC policy.** Real-scale orbital propagation is naturally done
  on a uniform timescale (TT-style, no leap seconds), while human-facing
  clocks want UTC/local and the Swahili calendar is a first-class UI
  concern. S0.7 decides the canonical server timescale, the conversion
  points, and where leap-second/ΔT policy lives.

## 9. Interest management (AoI) — no capacity promises

- **One authoritative match per region; the AoI cell grid lives inside
  it.** Each region is one authoritative match in the Go runtime, and
  the area-of-interest cell grid is an in-match data structure in that
  match's state — not one match per cell (ARCHITECTURE.md §6).
  `MatchSignal` (§5) handles region-to-region handoff when a player
  crosses a region boundary.
- **Priority levels** per presence: full-rate updates for the local
  cell, interpolated updates for adjacent cells, throttled or
  event-only updates beyond. This is the main lever that keeps §4's
  "one message per tick" affordable.
- **NO capacity promises.** Kwetu's Phase 0–2 deployment target is a
  **single monolithic stateful node** — one Nakama server, one Postgres,
  one LiveKit. We have **zero benchmark data**: no per-match tick cost,
  no presences-per-cell number, no cells-per-node number has ever been
  measured. Every such figure in any doc must be `[PLACEHOLDER — gate]`
  and must land in §Budgets as `[MEASURED]` before it is quoted as a
  commitment. Phase 0 "scale" work is architecture that keeps scaling
  *possible* (in-match cell grids, snapshot/resume, stateless Caddy),
  not a cluster.

## 10. Voice: self-hosted LiveKit

Voice is **LiveKit, self-hosted** — Apache-2.0 `[MEASURED 2026-09-05,
LiveKit README]` [EXTERNAL] https://github.com/livekit/livekit — an SFU
(side-by-side with Nakama, not embedded in it).

- **TURN for East African CGNAT.** LiveKit ships an **embedded TURN
  server**; it must run with a **real domain and a CA-issued
  certificate** (ACME/Let's Encrypt), because TURN-over-TLS is what
  CGNAT'd mobile clients can actually reach — media rides TCP/TLS 443
  when UDP is blocked. Exact config surface is pinned at implementation
  against the pinned LiveKit version `[EXTERNAL]`.
- **Auth: the Go runtime mints the token.** There is **no official
  Nakama–LiveKit integration**; we write it ourselves: a Nakama **RPC
  (Go runtime)** validates the session and **mints an HS256 JWT**
  carrying LiveKit **room grants** (`roomJoin`, `canPublish`,
  `canSubscribe`, `canPublishData`) scoped to that player's room. The
  LiveKit API key/secret live only server-side.
- **Moderation: `RoomService`.** Mute, kick, and subscription changes
  are server-side `RoomService` operations, invoked from Nakama RPC —
  never trusted to the client.
- **Proximity = subscription culling.** Who can hear whom is enforced by
  the server updating each participant's subscriptions as players move
  across AoI cells (§9) — proximity audio is a *server policy*, not a
  client mute list.
- **Bandwidth: speech preset, not music.** Publish with the **speech
  preset — 24 kbps Opus with DTX**; **not** the music preset (48 kbps),
  which costs 2× for nothing (voice content is speech). `[MEASURED
  2026-09-05, client-sdk-js AudioPresets source]` [EXTERNAL]
  https://github.com/livekit/client-sdk-js. DTX stays on.
- **Disable RED when bandwidth matters.** RED (redundant audio encoding)
  is enabled by default for mono tracks and re-sends a redundant copy of
  audio for loss protection; on tight/relayed links turn it off
  (`red: false`) and let the mute/interpolation policy absorb the
  occasional lost packet.
- **Autoplay: `Room.startAudio()` inside a user gesture.** Browsers keep
  audio silent until interaction; the doc comment on `startAudio` says
  exactly this — call it from a click/tap handler (e.g. the "join voice"
  button), not from a network callback `[MEASURED 2026-09-05,
  client-sdk-js Room source]`.
- **Spatialization path.** The verified hook: a `RemoteAudioTrack`'s
  output is routed through WebAudio via
  `RemoteAudioTrack.setWebAudioPlugins(nodes)`, which connects our node
  chain in order and silences the bare `<audio>` element `[MEASURED
  2026-09-05, client-sdk-js source]`. Our chain is a **`PannerNode`
  chain** driven by the scene graph: three.js `PositionalAudio` (its
  `setMediaStreamSource`, defined on the base `Audio` class, is the
  verified hook for feeding a `MediaStream` and having the object's
  world matrix drive the panner) `[MEASURED 2026-09-05, three.js
  source]` https://github.com/mrdoob/three.js. Caveat:
  `setWebAudioPlugins` is marked `@internal`/`@experimental` upstream —
  pin the exact client-sdk-js version and expect to fork around it.
- **One shared `AudioContext`.** LiveKit's mixing and three.js'
  `AudioListener` each create contexts by default; a page's audio graph
  must have exactly one. Create it once, hand the same context to both
  (three.js exposes the singleton via `THREE.AudioContext`; LiveKit
  accepts a context in its web-audio mixing options — pin exact option
  names against the pinned version). One context also means one
  resume/gesture to rule them all.

## 11. The AEC trap — a product decision, not a bug to fix

**Chromium does not feed WebAudio output into the echo canceller.** When
remote players' voices leave through our WebAudio spatialization chain
(§10 — they must, for spatial audio), the browser's acoustic echo
canceller never sees that output as "what we are playing", so microphone
input re-captures the room's own audio and every open mic re-broadcasts
an echo of the conversation. Tracked upstream (still open at drafting)
as chromium bugs [121673](https://issues.chromium.org/issues/121673) and
[686665](https://issues.chromium.org/issues/686665) `[EXTERNAL]`.

Because we cannot fix Chromium, we make this a **product decision**:

1. **Push-to-talk is the DEFAULT** for every player, every platform,
   every session. Open mic is **opt-in** per player (and may be
   re-prompted).
2. **Headphones are recommended** in the UI at voice setup — with
   headphones, speaker output never re-enters the mic and the trap
   disappears; the recommendation is honest and prominent.
3. **Open mic opt-in carries a warning** (echo, and that it degrades
   with speakers) and is subject to server-side moderation (§10) so one
   echoing player cannot poison a shared space.

This is written down as a decision, not a workaround, so no later
"convenience" feature re-enables open mic by default. It belongs in the
UI copy, onboarding, and any pitch material — same status as §6's "never
say server-authoritative physics".

## 12. Session lifecycle and security

- **`@heroiclabs/nakama-js` is pinned at 2.8.0** (npm scope — the plain
  `nakama-js` package is gone) — the newest npm release, published
  **2024-06-21**, with **no release in the 2+ years since** `[MEASURED
  2026-09-05, npm registry]` (Apache-2.0). Consequence: **expect to read
  its source** as part of development. The npm package and repo
  ([github.com/heroiclabs/nakama-js](https://github.com/heroiclabs/nakama-js))
  are treated as the spec where docs lag; upgrades are deliberate,
  version-pinned, and changelog-read.
- **Token refresh**: Nakama sessions are short-lived bearer tokens that
  the client library refreshes automatically (`autoRefreshToken` on the
  client, refresh-token exchange server-side; default lifetimes in the
  pinned server config). The refresh is silent and must never block the
  render loop; a failed refresh is a session-end, handled by the same
  reconnect path as a socket drop (§7's stall handling applies here
  too).
- **Suspended users still get tokens — without publish grants.**
  Suspension is enforced at the *capability* layer, not by locking
  people out of the world: the voice-token RPC (§10) mints suspended
  users a JWT with `canPublish` absent/false (listen-only at most), and
  `MatchJoinAttempt`/match handlers enforce world-level restrictions. A
  suspended account can spectate and appeal; it cannot publish audio or
  data. Server-side `RoomService` (§10) remains the enforcement backstop
  if a grant leaks.

## 13. Netcode observability

Enable Nakama's Prometheus endpoint and alert on the following
(metric names per the current docs `[EXTERNAL]`
https://heroiclabs.com/docs/nakama/getting-started/metrics/ — confirm exported series names on the pinned server's `/metrics`):

| Metric | What it tells us | Alert posture |
|---|---|---|
| `GaugeSessions`, `GaugePresences` | Live load; §9 capacity data source | Trend + anomaly (rate of change), no absolute thresholds |
| `GaugeAuthoritativeMatches` | AoI cell/match population (§9) | Growth trend; correlation with tick timing |
| `CountWebsocketOpened` / `CountWebsocketClosed` | Connect churn; churn *spikes* mean flapping, not load | Rate-of-change alert |
| `Message` (count, size, errors) | §4 budget compliance; oversize rejects | Any error-rate > 0 is investigated; size histogram drifts |
| `Api` (count, latency, errors) + `ApiRpc` | Auth/RPC path health, incl. voice-token RPC | Latency tail + error rate |
| `CountDroppedEvents`, `StorageWriteRejectCount` | Dropped runtime events; snapshot persistence failing (§5) | Any sustained non-zero value |
| `SnapshotLatencyMs` / `SnapshotRateSec` | Server request latency/throughput baseline | Tail regression vs. own baseline |

Plus **our own runtime metrics** (custom counters/gauges/timers from the
Go runtime): per-`MatchLoop` duration (§5 budget), AoI cell occupancy,
kinematic-replay drift-reject count (§6), and voice-token mint rate.
These four are the netcode's vital signs; Nakama's generic metrics are
the body temperature.

LiveKit exposes its own Prometheus metrics on the same pattern (series
names pinned at implementation); alert on relayed-session share (§10
TURN cost) and publishing-failure rate.

## 14. Open gates (tracked)

| Gate | Owner | Becomes |
|---|---|---|
| WebRTC datachannel transport: adopt or reject | Later measured spike (S0.13+, appended per ROADMAP.md §7.4) → §Budgets | ADR |
| Validator contract: models, drift thresholds, actions | **S0.6** | ADR |
| Universe clock: time-warp policy, TT/UTC policy | **S0.7** | ADR |
| AoI cell size, priorities, per-node presences | Measured spike → §Budgets | ADR |
| LiveKit client pin: `setWebAudioPlugins` (`@experimental`), shared `AudioContext` option names | Implementation pin | ADR |
| `@heroiclabs/nakama-js` 2.8.0 drift vs. pinned server | Ongoing, at each server upgrade | ADR on any fork |

Nothing here is a capacity commitment; `ROADMAP.md` §Budgets is the only
place numbers graduate from `[PLACEHOLDER — gate]` to `[MEASURED]`.
