# Kwetu Architecture

Status: pre-code, docs-first. This file is the system-level reference —
what talks to what, where state lives, which decisions are closed and
which are gated. It summarizes and points; it does not re-derive.
Canonical precision rules live in `COORDINATE_SYSTEM.md`, every
performance number lives in `ROADMAP.md` §Budgets, data licensing lives
in `DATA_SOURCES.md` + `data/README.md`, and decisions land as ADRs in
`docs/adr/`.

Evidence discipline: quantitative claims carry `[MEASURED yyyy-mm-dd,
method]`, `[EXTERNAL, verified yyyy-mm-dd, url]`, or
`[PLACEHOLDER — gate]`. An untagged number in this file is a bug.

## 1. System context

Kwetu is a browser client, one stateful game server, one database, one
media server, and dumb object storage for the heavy data. No
microservices, no service mesh, no tile server.

```
+----------------------------------------------------------------------------+
| Browser (desktop Chrome / Edge / Firefox first; mobile-tolerant, no iOS)   |
|   main thread: three.js, UI (i18next), ONE AudioContext                    |
|   workers: Rapier physics (WASM) | asset decode (KTX2, meshopt, PMTiles)   |
+------+--------------------------+---------------------------+--------------+
       |                          |                           |
       | (1) app + API            | (2) voice                 | (3) tiles/assets
       | https://play.<domain>    | wss://livekit.<domain>    | https://data.<domain>
       | app shell, Nakama        | WebRTC signaling          | PMTiles archives,
       | HTTP API + game WS       |                           | content-hashed assets
       v                          v                           v
+------+------------+   +---------+-------------+   +-----------+----------+
| Caddy             |   | LiveKit server        |   | Object storage       |
| TLS termination,  |   | (separate subdomain)  |   | (PMTiles + hashed    |
| static assets,    |   | WSS signaling via TLS |   |  assets; CORS +      |
| reverse proxy     |   +---------+-------------+   |  HTTP range reqs)    |
+------+------------+               |               +----------------------+
       | :7350 proxied              | media: UDP 50000-60000 + TCP 7881
       v                            | fallback — bound on the host and
+------+------------+               | BYPASS Caddy entirely (Caddy
| Nakama OSS node   |<--------------+ cannot proxy UDP; media flows
| monolithic,       |  server-to-  browser<->LiveKit as a direct
| stateful          |  server API   peer connection)
|  Go runtime:      |  (RoomService:
|  authoritative    |  moderation;
|  matches (memory) |  join tokens
|  AoI cell grid    |  signed locally)
+------+------------+
       | SQL: accounts, storage, match snapshots, wallets
       v
+------+------------+
| Postgres          |
+-------------------+
```

Hops, in words:

- **Browser -> Caddy -> Nakama -> Postgres** is the main chain. Caddy
  terminates TLS, serves the static app shell, and reverse-proxies the
  Nakama API (HTTP + WebSocket) on `play.<domain>`. Postgres is Nakama's
  durable layer; nothing else writes to it.
- **Voice is a separate subdomain on purpose.** LiveKit signaling is WSS
  through TLS, but WebRTC media (UDP 50000-60000, TCP 7881 fallback) is
  bound on the host directly and never touches Caddy — a reverse proxy
  cannot carry UDP media, and forcing media through any HTTP proxy adds
  latency and failure modes for zero benefit.
- **The Go runtime talks to LiveKit server-to-server** on the private
  interface: it signs join tokens locally and calls the RoomService API
  for moderation. Browsers never see LiveKit credentials (§9).
- **Tiles and assets come straight from object storage** over HTTPS with
  CORS + range requests (§7). This path bypasses both Caddy and Nakama;
  the game server never ships megabytes of map data.

## 2. Compose port layout

Standard Nakama port set, and what Kwetu actually publishes:

| Port | Service | Exposure |
|---|---|---|
| 7350 | Nakama HTTP API + client WebSocket | Published; proxied by Caddy at `play.<domain>` |
| 7349 | Nakama gRPC (client protocol) | Published only if a non-browser client ever needs it; browsers use 7350 |
| 7351 | Nakama console (HTTP) | **Internal only** — never published; access via SSH tunnel |
| 7348 | Nakama console gRPC (tooling/automation) | **Internal only** — never published |
| 7880 | LiveKit signaling (HTTP/WS, behind TLS) | Proxied by Caddy at `livekit.<domain>` |
| 7881 | LiveKit TCP fallback (ICE/TCP) | Direct to host, bypasses Caddy |
| 50000-60000/UDP | LiveKit media | Direct to host, bypasses Caddy |
| 9100 | Nakama Prometheus metrics (once set, §8) | Internal only |

**"The console is on 7349" is stale folklore.** 7349 is the *client*
gRPC port. The console is HTTP on 7351, with its gRPC sibling on 7348.
Publishing 7349 in the mistaken belief it exposes the console gets you
neither the console nor a useful client port.

## 3. Client architecture

TypeScript, web-native, no wrapper. Three load-bearing decisions:

### 3.1 Renderer: GLSL ShaderMaterial vs TSL — Phase-0 gate

The terrain / atmosphere / water shading stack is the hardest shader
work in the project, and three.js offers two roads:

- **Raw GLSL `ShaderMaterial`** — maximum control, stable WebGL2 path,
  hand-maintained shader code, no WebGPU future without a rewrite.
- **TSL (three.js node shading language)** — one source compiled to
  GLSL *and* WGSL, which keeps the WebGPU path open, at the cost of a
  younger, less battle-tested abstraction.

Decision gate: build the atmosphere + terrain test scenes both ways in a
Phase-0 spike, measure expressiveness and tooling friction, and record
the choice as an ADR `[PLACEHOLDER — gate]`. Written default if forced
to choose today: TSL, because WebGPU is the endgame and rewriting a large
GLSL stack later is the expensive direction. Reversal is cheap *before*
the terrain stack is written, which is exactly why the gate exists.

### 3.2 Worker layout

| Thread | Owns | Rationale |
|---|---|---|
| Main | three.js scene graph, input, UI, i18next, **the AudioContext** | render-loop latency is the budget everything else respects |
| Physics worker | Rapier WASM — the deterministic compat build wherever cross-platform determinism matters (B-EPH-02, S0.11), the general compat build otherwise (§13) — fixed timestep, **one Rapier world per active local contact bubble**; multiple bubbles can belong to a body, tiles only supply colliders | stepping a real-scale scene must never stall a frame |
| Decode worker(s) | KTX2/basis transcoder, meshopt decoder, PMTiles range fetch + decompress | decode spikes are bursty and must not touch the render thread |

Physics runs at a fixed tick inside its worker; the main thread renders
interpolation between published states. Multiple decode workers are fine
(each single-threaded — see §7's isolation decision). Workers are plain
`Worker`s, module type, no frameworks.

### 3.3 The single shared AudioContext rule

Browsers allow multiple `AudioContext`s but punish them (instance caps,
per-context overhead, autoplay policy), and `AudioContext` is not
available in workers. Kwetu creates **exactly one** `AudioContext`, on
the main thread, after the first user gesture, and routes *everything*
through it: LiveKit remote voice, positional SFX, ambience. One context
means one listener and one spatializer — voice and world audio share a
single spatial graph, and autoplay policy is handled once, in one place.

## 4. Precision architecture (summary)

Kwetu is 1:1 real scale — walking a street in Dar es Salaam and orbiting
the Moon use the same universe. Single-precision floats cannot carry
that: float32 spacing near Earth's radius (~6.4e6 m) is on the order of
half a metre (arithmetic, not a measurement), so naive world coordinates
jitter long before the horizon does.

The shape of the answer, one line each — **canonical details, frames,
and rules live in `COORDINATE_SYSTEM.md`**:

- Simulation state is float64 (Go runtime) and float64 on the client
  wherever a coordinate is held; float32 is confined to local contact solving and render buffers.
- Rendering is camera-relative (floating origin) **and** uses a
  logarithmic depth buffer — always both, never one without the other.
  The camera is the origin of its own float32 frame, so everything the
  GPU sees is near zero and precise; the log depth buffer is what keeps
  street-level detail and lunar-orbit distances in one depth range.
- Planetary frames (Earth-fixed vs inertial) and ephemeris (via
  `astronomy-engine`, §12) are defined once, in COORDINATE_SYSTEM.md;
  no subsystem invents its own convention.

## 5. Server architecture

**One monolithic, stateful Nakama OSS node** is the v1 target, with the
authoritative simulation in the Go runtime. Not because it will scale
forever — because a single stateful node is the only architecture whose
failure modes we can fully reason about pre-code, and Kwetu's regional
scope (a handful of flagship regions) fits it.

- **In-memory match state + explicit snapshots.** Each region is an
  authoritative Nakama match; its state lives in match-handler memory.
  Persistence is *explicit*: a periodic callback writes a snapshot to a
  Nakama storage collection, and a final snapshot is written on orderly
  termination. After a node restart, a region is rebuilt lazily from its
  latest snapshot on first join. Snapshots are versioned; a snapshot
  without a version is a bug.
- **Idle-match termination.** Nakama happily keeps an empty match alive
  forever. Kwetu does not: match state tracks last-active time and the
  loop terminates an idle region (after persisting a snapshot) past a
  threshold `[PLACEHOLDER — gate]`. Terminating regions is also the
  memory reclamation mechanism — a server that never forgets a match is
  a slow leak by design choice.
- **MatchLoop timing constraint.** `MatchLoop` is called every tick at
  `1/rate` seconds. It must return inside that budget: an overrunning
  loop delays every subsequent tick of that match and burns runtime CPU
  that every other match on the node shares. Per-match-type tick rates
  and the per-tick work budget are Phase-0 measurements feeding
  ROADMAP §Budgets `[PLACEHOLDER — gate]`.
- **Clustering is Enterprise-gated.** Multi-node clustering (cross-node
  presences, cross-node matches) is a Heroic Labs Enterprise feature;
  OSS Nakama is one node. The **plain-Postgres escape hatch** before
  ever paying for Enterprise: run several independent OSS nodes against
  plain Postgres and shard deterministically by region (an RPC returns
  each player's region's node). Presences are node-local in OSS, so the
  sim must keep cross-region interaction thin — which the regional
  design already does. This hatch is why region boundaries matter
  architecturally, not just geographically.

## 6. Interest management (AoI)

- **Go-runtime AoI cell grid.** Each region match partitions its space
  into a static cell grid. Per tick, the runtime computes each client's
  area of interest as a set of cells (own cell + radius) and streams
  only entities in those cells. Clients never receive a full region
  diff; bandwidth is a function of interest, not population.
- **Voice proximity = subscription culling.** Everyone in a region may
  join one LiveKit room; *which remote audio tracks a client subscribes
  to* is decided by the same cell grid — the runtime issues proximity
  subscriptions server-side. Distance culling is not left to client
  math; the server says who you can hear. Hysteresis on the subscribe /
  unsubscribe edge (avoid chattering at cell boundaries) is part of the
  same mechanism.
- **Cell sizing is a Phase-0 measurement, not a guess.** Cell edge
  length, AoI radius, and voice-culling hysteresis trade tick cost
  against bytes-per-client against pop-in `[PLACEHOLDER — gate]`;
  the numbers land in ROADMAP §Budgets and an ADR records the choice.

## 7. Data plane

Map data is big, static, and per-region — which makes it a CDN-shaped
problem, not a server problem.

- **Per-region PMTiles over object storage.** One `.pmtiles` archive per
  region (Dar es Salaam, Zanzibar/Stone Town, ...), built by the Phase-2
  pipeline (`DATA_SOURCES.md`, `data/README.md`). PMTiles is a
  single-file archive read via **HTTP range requests**, so any object
  storage that sends CORS headers and honors range requests serves it —
  no tile server, no server-side rendering, no extra origin. The storage
  bucket's CORS policy is part of the infrastructure spec, not an
  afterthought: without `Access-Control-Allow-Origin` and range support
  the whole data plane is dead on arrival.
- **Content-hashed asset URLs.** Assets are addressed by content hash
  (`.../terrain-<sha256>.pmtiles`). Hashed URLs are immutable, so they
  are cached with `Cache-Control: immutable` and a long max-age — safe
  forever-caching, and safe parallel publication of new regions. A
  separately-versioned manifest maps logical layer names to hash URLs.
- **Client cache stack.** The Cache API holds fetched tile/asset bytes;
  IndexedDB holds the manifest and cache index;
  `navigator.storage.persist()` is requested at first launch so the
  browser deprioritizes eviction of the offline map cache. Persistence
  can be *refused* — the stack treats its cache as best-effort, never
  as a guarantee (§10, §11).
- **This is the ODbL boundary in motion.** Everything served from this
  plane that derives from OSM is the separately-licensed `data/` layer;
  provenance and the attribution strings the client must render are
  defined in `data/README.md` and `DATA_SOURCES.md`.

## 8. Cross-origin isolation decision point

**This must be a written decision (an ADR in `docs/adr/`), not a
default that happens by accident.**

- What cross-origin isolation (COOP + COEP) buys: `SharedArrayBuffer`,
  which unlocks WASM threads (pthreads). The affected path is
  satellite.js-style SGP4 propagation compiled to threaded WASM for
  high satellite density. Note the v1 celestial stack is
  `astronomy-engine` — pure TypeScript, no WASM, no SAB requirement
  (§12) — so the pthread path is a *contingency*, not a current need.
- What it costs: COEP forces every subresource — object-storage tiles,
  fonts, worker bundles — to satisfy CORP/COEP semantics; third-party
  embeds and some popup flows break or need rework, and the relaxations
  (e.g. `credentialless`) have uneven browser support that must be
  verified per target browser at Phase 0.
- The alternative: no COOP/COEP. Workers stay single-threaded (WASM
  decode included); parallelism comes from *multiple* workers, which
  covers physics and decode fine. Dense-satellite propagation then runs
  on the main-thread-compatible pure-JS path, within whatever budget
  ROADMAP §Budgets assigns it.

**Decision status: open, gated.** Written default if forced to choose
today: ship v1 *without* COOP/COEP (single-threaded workers), because
nothing in the v1 stack needs `SharedArrayBuffer` and un-isolated CORS
is strictly simpler for the data plane. The ADR is owned by ROADMAP.md
§4 (Phase 1, decisions produced) and must be recorded before any
`SharedArrayBuffer`-dependent path is written; it is reversed the day a
measured budget says the pthread path is the only way through.

## 9. Observability

- **`metrics.prometheus_port` defaults to 0 — disabled.** An unmodified
  Nakama install exposes *no* metrics, invisibly. Kwetu's compose sets
  it (e.g. 9100), scraped by Prometheus on the internal network only,
  never published. A deployment without this port set is considered
  unobservable and therefore unfinished.
- **Metrics that matter for Kwetu's first dashboards:** `GaugeSessions`
  (open client sockets), `GaugePresences` (active presences),
  `CountWebsocketOpened` / `CountWebsocketClosed` (churn — the
  opened-minus-closed trend is the reconnect-health signal, §10),
  and `ApiRpc` (RPC traffic; spikes flag client misbehavior or a hot
  loop). Region-level and sim-specific metrics are added by the Go
  runtime later; these four are the heartbeat.
- **Grafana is AGPLv3. House rule: run the official unmodified image
  only.** Patching Grafana source triggers AGPL source obligations an
  Apache-2.0 project does not want. Dashboards and provisioning files
  we author ourselves are our own work and Apache-2.0 — that is fine.
  (Prometheus is Apache-2.0; no constraint.)

## 10. Security model

Secrets that ship with public default values and **must be changed at
first deploy** — an unchanged install is an open proxy for anyone who
has read the docs:

| Setting | Role | Why it must change |
|---|---|---|
| `socket.server_key` | client authenticates the socket connection | public default is documented |
| `session.encryption_key` | signs session JWTs | holder can forge sessions |
| `session.refresh_encryption_key` | signs refresh tokens | holder can forge long-lived access |
| `runtime.http_key` | authenticates server-to-server HTTP RPC | holder can invoke runtime HTTP endpoints |
| `console.username` / `password` | console login | console = full server control; and the console is never published anyway (§2) |

- **Token lifecycle in browsers.** The session JWT lives in memory only;
  the refresh token is persisted in IndexedDB with the eviction caveat
  (§11). The client refreshes before expiry and treats any 401 as
  refresh-then-retry. No long-lived secret is ever written to
  `localStorage`. Logout clears stored tokens.
- **LiveKit signing keys live only in the Go runtime.** The server holds
  the API key/secret, signs short-lived join tokens per session, and the
  browser receives tokens — never the secret. Token minting is
  server-side by construction, so a client cannot grant itself a room.
- **Moderation is server-authoritative via RoomService.** The Go runtime
  calls LiveKit's RoomService API to list participants, mute, remove,
  and delete rooms. Clients render moderation state; they never enforce
  it.

## 11. Failure & degradation

- **Caddy config reload forcibly closes WebSockets.** Reloading Caddy
  (including routine certificate renewal) closes in-flight streams.
  Mitigation: set the Caddyfile global `stream_close_delay` so streams
  are not cut at the instant of reload — and treat it as a *delay*, not
  immunity: Caddy upgrades and host restarts will still cut connections,
  so the reconnect flow below is the primary defense. Config changes
  ship in low-traffic windows regardless.
- **Reconnect / rejoin flow, layered:** (a) session refresh — client
  refreshes the JWT on expiry and on any 401; (b) socket reconnect —
  capped exponential backoff with jitter; (c) match rejoin — the client
  rejoins its region match by id, and the handler's join-attempt logic
  recognizes a returning player (by user id) while the stale presence is
  reaped by timeout, so a dropped socket does not lose a position; (d)
  voice rejoin — a fresh short-lived LiveKit token is minted and
  proximity subscriptions are re-established from the AoI grid (§6).
- **TURN fallback.** If UDP media is blocked (restrictive NAT,
  corporate networks), ICE degrades in order: UDP direct -> TCP 7881 ->
  TURN over TLS. Voice survives; capacity drops. Topology is decided,
  not open: **embedded LiveKit TURN is the default (real domain +
  CA-issued certificate)**; standalone coturn is the fallback only if
  the 443 conflict proves unsolvable — ratified by the S0.9 ADR.
- **IndexedDB eviction.** Browsers may evict origin storage under
  pressure unless `navigator.storage.persist()` was granted (§7) — and
  persistence is best-effort. The manifest is re-verified on every load;
  missing entries refetch in the background. A wiped cache must never
  block entering the simulation.
- **Cache-miss behavior.** On any tile or asset miss, render continues
  with what is present — lower LOD, placeholder terrain — while fetches
  queue in the decode worker. Simulation state is authoritative on the
  server (§5) and is never cached as if local. Missing scenery is
  cosmetic; missing server state is a bug.

## 12. Performance budget (pointer table)

Every number lives in `ROADMAP.md` §Budgets — one owner, no copies — and
the `B-XXX-NN` row IDs defined there (§3) are the only canonical budget
identifiers. This table is a *pointer*: it maps each quantity an agent
hits in this file to the rows that bound it, and defines no IDs of its
own. Most of these quantities are Phase-2+ or Alpha measurements, not
Phase-0 spike outputs; the gate on each cited row names what fills it.
All rows are unfilled in v1.

| Quantity, as this file hits it | ROADMAP §Budgets row(s) |
|---|---|
| Frame time / draw calls, dense flagship region (§3.2 worker layout) | B-FPS-01 (tier C), B-DC-01 |
| Tick cost, worst region — the Go match handler (§5) and the client physics worker (§3.2) | B-AOI-02, B-AOI-03 (server per-tick cost, S0.8); the client worker is bounded by the frame budget, B-FPS-01 |
| AoI update bandwidth per client (§6) | B-AOI-05 |
| MatchLoop CPU per region at peak presence (§5) | B-SIM-01 |
| Concurrent voice listeners per region (§6) | B-AOI-04 |
| Persisted asset-cache footprint (§7) | B-CACHE-01 (warm-cache per-visit payload: B-REG-05) |
| Time-to-first-region, cold / warm cache (§7) | B-LOAD-11 (transfer bounds: B-LOAD-09, B-REG-05) |

## 13. Version pins

Exact tags in compose, exact semver in `package.json`. No `latest`, no
caret ranges at deploy time.

| Component | Pin | Evidence |
|---|---|---|
| Nakama OSS (server image) | `registry.heroiclabs.com/heroiclabs/nakama:3.37.0` | [EXTERNAL, verified 2026-09-05, https://heroiclabs.com/docs/nakama/getting-started/install/docker/] — official compose baseline; docs live under `/docs/nakama/getting-started/install/` (older `/installing-nakama` paths 404) |
| Postgres (companion image) | `postgres:16.8-alpine` | [EXTERNAL, verified 2026-09-05, same page] — official compose companion |
| three | 0.185.1 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/three/latest] |
| @dimforge/rapier3d-deterministic-compat | 0.20.0 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/@dimforge/rapier3d-deterministic-compat/latest] — the *deterministic* build (Apache-2.0): the target wherever cross-platform bitwise determinism matters (B-EPH-02, S0.11); verify the exact package name and version at pin time |
| @dimforge/rapier3d-compat | 0.20.0 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/@dimforge/rapier3d-compat/latest] — the verified *general* build (Apache-2.0), for non-determinism-critical use |
| astronomy-engine | 2.1.19 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/astronomy-engine/latest] |
| TypeScript (compiler + typechecker) | `typescript` **7.0.2** — package.json carries `^7.0.2` (dev tooling; exact resolved version recorded here and in the ledger) | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/typescript/latest] — Apache-2.0; THIRD_PARTY_ASSETS.md code-22 |
| Vite (dev server + bundler) | `vite` **8.2.2** — package.json carries `^8.2.2` (dev tooling); production pipeline is rolldown + oxc (vite 8's rust bundler/minifier — the legacy `rollupOptions` config key is still honored) | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/vite/latest] — MIT; THIRD_PARTY_ASSETS.md code-23 |
| Vitest (test runner) | `vitest` **5.0.0** — package.json carries `^5.0.0` (dev tooling) | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/vitest/latest] — MIT; peer range accepts vite ^8; THIRD_PARTY_ASSETS.md code-24 |
| @types/node | `@types/node` **24.13.3** — package.json carries `^24.13.3` | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/@types/node] — MIT; matched to the Node 24.13.0 dev host; THIRD_PARTY_ASSETS.md code-25 |
| @types/three | `@types/three` **0.185.4** — package.json carries `^0.185.4` | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/@types/three/latest] — MIT; three 0.185.1 ships no `.d.ts` (verified in node_modules at scaffold); THIRD_PARTY_ASSETS.md code-26 |
| nakama-js | `@heroiclabs/nakama-js` 2.8.0 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/@heroiclabs/nakama-js] — the SDK moved to the `@heroiclabs` npm scope (plain `nakama-js` 404s); 2.8.0 is `latest`, published 2024-06-21, license Apache-2.0. No release in 2+ years — expect to read its source |
| livekit-client | 2.22.2 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/livekit-client/latest] |
| i18next | 26.4.2 | [EXTERNAL, verified 2026-09-05, https://registry.npmjs.org/i18next/latest] |
| Caddy | [PLACEHOLDER — pin at Phase 0] | pin when compose is written (§11 reload behavior applies to whatever is pinned) |
| LiveKit server | [PLACEHOLDER — pin at Phase 0] | pin when compose is written |
| Prometheus / Grafana | [PLACEHOLDER — pin at Phase 0] | Grafana: unmodified official image only (§8) |
| KTX-Software (bake-time texture encoding) | 4.x — v5 is mid-transition upstream | [EXTERNAL, verified 2026-09-05 — license sweep, THIRD_PARTY_ASSETS.md code-20] — one non-open Ericsson file upstream: consume release binaries, never vendor the source tree (ASSET_STRATEGY.md §4) |
| Node.js (build + tooling) | 24.x LTS | [MEASURED 2026-09-05 — dev-host environment (MASTER_PROMPT.md §48)] — pin the exact version at first code commit |
| Python (ephemeris oracle scripts) | 3.14 | [MEASURED 2026-09-05 — dev-host environment (MASTER_PROMPT.md §48)] — pin the exact version at first code commit |
| Blender (bake-time authoring) | 5.0 | [MEASURED 2026-09-05 — dev-host environment (MASTER_PROMPT.md §48)] — build-time tool, never distributed; an exported .glb carries no GPL obligation (ASSET_STRATEGY.md §5) |

TypeScript declaration correction (researched 2026-09-05): Three.js points to community-maintained types in its [official installation guide](https://threejs.org/manual/en/installation.html). Remove the former r168 bundled-types prohibition. At scaffolding, verify and pin a compatible `@types/three` release and ledger it before installation; compile representative core and addon imports. No dependency has been installed by this documentation change.

Scaffold outcome (2026-09-05, first code commit): three 0.185.1 ships **no** TypeScript declarations — verified in node_modules (no `types` field, no `types` export condition, zero `.d.ts` files) — so `@types/three` 0.185.4 is pinned and ledgered (code-26), and the core import surface (`WebGLRenderer`, `PerspectiveCamera`) compiles clean under `tsc --noEmit` with the strict flags of CLAUDE.md. Dev-tooling caveat tied to these pins: vite 8.2.2 and vitest 5.0.0 ship mutually incompatible declaration internals (vitest 5.0.0's `config.d.ts` imports `@vitest/expect`, which its own package.json does not declare), so tsconfig carries `skipLibCheck` — project source stays fully checked; revisit at the next tooling bump.

Vehicle movement and persistence: [docs/VEHICLES_AND_FLIGHT.md](docs/VEHICLES_AND_FLIGHT.md). Powered flight is f64 numerical integration; analytic coast and local f32 contacts are separate regimes. The server validates each using its sanctioned model.

## 14. Related documents

- `ROADMAP.md` — phases, the S0.x spike list, and §Budgets (owner of
  every number in this file)
- `COORDINATE_SYSTEM.md` — canonical precision, frames, and origins (§4
  is only a summary)
- `NETWORKING.md` — netcode + voice contract, including the 1500 B
  message cap (larger payloads are reduced by the coalescing/delta/
  compression policy in NETWORKING.md §4, never an oversized message;
  the cap never moves) — §6's AoI and §10's voice flow sit on top of it
- `DATA_SOURCES.md` + `data/README.md` — the ODbL data plane, provenance,
  attribution (§7)
- `docs/adr/` — where the gated decisions above land, one ADR each
