# infra/ — dev stack README

Local development infrastructure for Kwetu: Postgres, Nakama OSS, Caddy
(TLS + static + reverse proxy), LiveKit. Topology owner:
[ARCHITECTURE.md](../ARCHITECTURE.md) §1–§2; network contract owner:
[NETWORKING.md](../NETWORKING.md) §3. Nothing here binds beyond
`127.0.0.1` on the host.

Status: stood up and verified 2026-09-06 (all checks below `[MEASURED
2026-09-06, method]` on this box, Docker Desktop on Windows 11).

## Run

From the repo root (the `.env` lives there; compose otherwise looks in the
compose file's own directory):

```sh
docker compose --env-file .env -f infra/docker-compose.yml up -d
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs -f nakama
docker compose --env-file .env -f infra/docker-compose.yml stop     # keeps volumes
docker compose --env-file .env -f infra/docker-compose.yml down -v  # full reset
```

## Host ports (all `127.0.0.1` only)

| Host port | Container | Service | Notes |
|---|---|---|---|
| 15432 | 5432 | Postgres | dev psql convenience |
| 7350 | 7350 | Nakama client HTTP + WS | normally reached via Caddy same-origin; direct publish is for dev debugging |
| 7351 | 7351 | Nakama console (HTTP) | dev-only publish — loopback-bound; REMOVE before any deployment (ARCHITECTURE.md §2: internal only) |
| 8443 | 443 | Caddy HTTPS | `https://localhost:8443` |
| 7880 | 7880 | LiveKit signaling (HTTP/WS) | WebRTC media (UDP 50000–60000, TCP 7881) NOT published in dev |

Deliberately unpublished (compose-internal only): Nakama console gRPC 7348,
client gRPC 7349, Prometheus 9100, Caddy admin 2019.

Port-choice survey `[MEASURED 2026-09-06, netstat -ano -p TCP LISTENING +
docker ps -a]`: ports already taken on this host included 5000, 5040, 5433,
55432, 50051, 8070, 8765, 27015, 27017 (stopped containers), plus ephemeral
ranges. 7348/7349/7350/7351/7880/7881/9100 and 8443/15432 were all free and
remain conflict-free. B-CONST-03's port identities (7349 client gRPC, 7350
client HTTP+WS, 7351 console HTTP, 7348 console gRPC) are kept on the
*container* side; only the *host* side is remapped where this box demanded
it.

## Secrets flow (ARCHITECTURE.md §10)

`.env` (gitignored) is the single source. It is compose-interpolated:

- Postgres + LiveKit get theirs via container `environment:`.
- Nakama gets the security-model keys — `socket.server_key`,
  `session.encryption_key`, `session.refresh_encryption_key`,
  `runtime.http_key`, `console.username/password` — as command-line flags,
  because Nakama's YAML config does not expand `${ENV}` and environment
  variables are not a config layer for Nakama's own subsystems
  `[EXTERNAL, verified 2026-09-06,
  https://heroiclabs.com/docs/nakama/getting-started/configuration/]`.
  Flag names verified against the pinned binary's `--help` `[MEASURED
  2026-09-06]`. Caveat: interpolated flags are visible in `docker inspect`
  — acceptable loopback-only; replaced by a real secret mechanism at deploy.
- `infra/nakama/config.yml` is the tracked, non-secret config (notably
  B-CONST-04: `metrics.prometheus_port: 9100`, without which Nakama exports
  NO metrics). `socket.max_message_size_bytes` is left at the default 4096
  (NETWORKING.md §4: oversized message = server closes the connection; the
  1500 B budget is enforced client-side, this cap is a backstop).

`.env` values were generated 2026-09-06 (`python secrets`, LiveKit pair via
`livekit-server generate-keys`) and are LOCAL DEV ONLY.

## First-run notes

- **Browser certificate**: Caddy issues a real local X.509 certificate from
  its internal CA (`local_certs`); issuer chain observed: `Caddy Local
  Authority - ECC Intermediate` `[MEASURED 2026-09-06, openssl s_client]`.
  Browsers show a warning once; either accept it or trust Caddy's root:
  `docker compose --env-file .env -f infra/docker-compose.yml exec caddy cat
  /data/caddy/pki/authorities/local/root.crt` (persisted in the
  `caddy_data` volume — no re-trust per restart).
- **Secure context for mic**: `localhost` is a potentially-trustworthy
  origin in Chromium/Firefox regardless of certificate validity, so
  getUserMedia works on `https://localhost:8443` even before the CA is
  trusted, as long as the user explicitly proceeds past the warning.
  Production uses a real domain + ACME; this note is dev-only context for
  the voice work (NETWORKING.md §10).
- **Nakama console**: `http://127.0.0.1:7351`, credentials in `.env`
  (`NAKAMA_CONSOLE_USERNAME` / `NAKAMA_CONSOLE_PASSWORD`).

## Verification record `[MEASURED 2026-09-06, curl / docker / node]`

| Check | Command shape | Result |
|---|---|---|
| Console | `curl http://127.0.0.1:7351/` | HTTP 200 |
| TLS + static | `curl -sk https://localhost:8443/` | HTTP 200, `Caddy Local Authority - ECC Intermediate` issuer |
| API proxy (real end-to-end) | `POST /v2/account/authenticate/device?create=true` with the dev server key as Basic auth | HTTP 200, session + refresh JWT minted (the key matters — the default `defaultkey` would 401) |
| `/api/*` alias | `POST /api/v2/rpc/nope` | Nakama grpc-gateway error body `{"code":5,...}` behind `Via: 1.1 Caddy` — upstream proven |
| WebSocket | Node WebSocket client, token from the auth call above, `wss://localhost:8443/ws?token=...` | `101` upgrade; unauthenticated `GET /ws` gets Nakama's own `401` (proxy path proven, auth gate intact) |
| Metrics (B-CONST-04) | `docker compose exec caddy wget -qO- http://nakama:9100/metrics` | 59 `nakama_*` series incl. `nakama_sessions`, `nakama_presences`, `nakama_socket_ws_opened/closed` |
| LiveKit | `curl http://127.0.0.1:7880/` | HTTP 200, body `OK` |
| Postgres | `pg_isready -U nakama -d nakama` | accepting connections |

## Startup timings

| Scenario | Timing |
|---|---|
| Cold start (empty volumes, images already pulled): `up -d` returns | 10.6 s |
| Same, to Nakama `healthy` (migrate up + boot + healthcheck) | 14.9 s |
| Recreate after config change (volumes intact) | ~4.6 s to started, Nakama healthy ~9 s |

## Measured config quirks (read before editing)

1. **Nakama binary is not on PATH in the image** — the compose entrypoint
   must call `/nakama/nakama` by full path (`nakama migrate up` bare →
   `exit 127`).
2. **`LIVEKIT_KEYS` format**: parser demands exactly `"key: secret"`
   including the space after the colon (`"k:s"` → startup loop "Could not
   parse keys").
3. **`stream_close_delay` does not exist in caddy 2.11.4** — not as a
   Caddyfile global option, not under `servers {}`, not in native JSON
   (`json: unknown field`, all three probed via `caddy validate`).
   ARCHITECTURE.md §11 names it as the reload mitigation — stale for this
   pin (see open items). Actual protection: Caddy's default `grace_period`
   is eternal per docs `[EXTERNAL,
   https://caddyserver.com/docs/caddyfile/options]`.
4. **No brotli encoder ships in caddy 2.11.4** (`encode zstd br gzip` →
   `module not registered: http.encoders.br`). Only zstd + gzip.
5. **No exclusion rule needed for .glb/.ktx2 compression**: caddy's encode
   middleware refuses non-compressible content types on its own — measured
   no `Content-Encoding` for `model/gltf-binary` and `image/ktx2` (2 KiB
   fixtures), while `text/plain`/`text/html` compress. An explicit
   path-matcher double-encode was tried and removed after measurement.
6. **encode `minimum_length` default 512 B**: sub-512-byte files are never
   compressed (misleading when testing with tiny fixtures).
7. **`header /index.html` misses `/`** — index resolution happens after
   header matching; use a matcher listing both (`@shell path / /index.html`).
8. **Metric series names on Nakama 3.37.0** differ from ARCHITECTURE.md §9's
   prose: `nakama_sessions` (not `GaugeSessions`), `nakama_presences`,
   `nakama_socket_ws_opened/closed` (not `CountWebsocketOpened/Closed`),
   per-RPC counters like `nakama_AuthenticateDevice_count`. NETWORKING.md
   §13 already mandates confirming names on the pinned server's `/metrics`
   — this is that confirmation.
9. **`caddy reload` inside the container**: passing the config path from a
   Git-Bash host shell mangles `/etc/...` (MSYS path conversion) — use
   `docker compose restart caddy` or `MSYS_NO_PATHCONV=1`.
10. **Nakama sends its own `Cache-Control` on API responses**; Caddy's
    `no-store` rule for `/api/*` results in two Cache-Control headers on
    those responses (legal HTTP, combined semantics fine).

## Open items

- **TURN not configured** (NETWORKING.md §10): embedded LiveKit TURN is the
  decided topology but requires a real domain + CA-issued certificate;
  impossible on a localhost dev box. No `turn:` block in
  `infra/livekit/livekit.yaml`. Voice media testing (UDP/TCP 7881
  publishing) comes with the Phase 6 voice work.
- **Go runtime module mount is a TODO**: `infra/nakama/data/modules/` is
  mounted (Nakama auto-loads `data_dir/modules/*.so`); Phase 5 builds and
  drops the module there.
- **`.env.example` is currently gitignored**: the root `.gitignore` rule
  `.env.*` also matches `.env.example` (verified with `git check-ignore`),
  so the template is not tracked. Fix belongs to a change that may touch
  `.gitignore` (outside this task's write scope): add a `!.env.example`
  exception line.
- **`infra/nakama/data/.cookie` needs a gitignore rule**: Nakama writes a
  16-byte random console-cookie secret into `data_dir` on first boot
  (regenerated per reset). It is runtime state, not repo content — exclude
  it via `.gitignore` (outside this task's write scope), or accept deleting
  it before any commit of the data dir.
- **ARCHITECTURE.md doc discrepancies to reconcile** (root doc, outside
  this task's write scope): §11's `stream_close_delay` does not exist in
  the pinned Caddy 2.11.4 (quirk 3); §9's metric-name prose vs measured
  series names (quirk 8). Per CLAUDE.md, the owner doc wins and the loser
  is fixed — by whoever owns ARCHITECTURE.md.
- **Console publish (7351) and direct API publish (7350) are dev
  conveniences** — both loopback-bound today, both to be removed/not
  widened before any deployment.
- **Prometheus/Grafana pinning** (ARCHITECTURE.md §13 placeholders): the
  scrape target exists (internal 9100); the scraper itself is not stood up
  tonight.
