/**
 * Kwetu netcode — the real-time socket wrapper (client side).
 *
 * Owns
 * ----
 * - Connection lifecycle to the Nakama real-time socket: connect, automatic
 *   reconnect with exponential backoff + seeded jitter, and the reconnect
 *   state machine (MASTER_PROMPT.md §29: "Reconnect is a feature" — Caddy
 *   reloads, mobile network hiccups and laptop sleeps are normal).
 * - Match join/leave and the 20 Hz coalesced input-send throttle
 *   (NETWORKING.md §4 rule 2: ~1 message per tick per presence; rule 3:
 *   coalescing beats splitting).
 * - The framework-free `SocketTransport` seam: tests inject a mock transport
 *   and never open real sockets. The pinned @heroiclabs/nakama-js 2.8.0
 *   client (NETWORKING.md §12 — expect to read its source) is adapted behind
 *   the same seam by `createNakamaTransport`, which imports it lazily so no
 *   test or non-network build ever loads it.
 * - The opcode table was re-homed (2026-09-06, Phase 5) to `shared/` — the
 *   single source of truth is `shared/protocol.json`; this module re-exports
 *   the typed view (`shared/protocol.ts`) so existing importers keep
 *   working. The Go runtime's compiled constants are verified against the
 *   same JSON at `go test` time (server/runtime-go/protocol_check_test.go,
 *   server/runtime-go/README.md §Build): a one-sided renumber now fails a
 *   test instead of shipping as a silent protocol break.
 *
 * Hard rules enforced here
 * ------------------------
 * - **1500 B wire cap** (CLAUDE.md invariant, quoted — never moved): a
 *   `sendMatchState` payload larger than `WIRE_MAX_BYTES` throws before it
 *   reaches the transport. NETWORKING.md §4 rule 4: the server's configured
 *   cap (default 4096, infra/nakama/config.yml) is only a backstop — an
 *   oversized message closes the connection. Kwetu's budget is ours to
 *   enforce client-side.
 * - **At most one pending input, latest wins** (NETWORKING.md §4 rule 2):
 *   inputs arriving inside a closed send window overwrite the single
 *   pending slot; a scheduled flush sends it when the window reopens.
 *
 * Not owned here (by design): payload/protocol decoding (Phase-5 netcode
 * design doc), client prediction and reconciliation, snapshot interpolation
 * (`./interpolation.ts`), server-side validation (ADR-007 — it never runs
 * here), and session refresh (NETWORKING.md §12). The wrapper never mints,
 * parses or stores tokens beyond holding the current session JWT for
 * reconnects — the session layer calls `setSessionToken()` on refresh.
 *
 * Same-origin transport (NETWORKING.md §3): the production transport dials
 * `ws(s)://<host>:<port>/ws` — Caddy reverse-proxies `/ws` to nakama:7350
 * (infra/Caddyfile). Config comes from the browser location, not a literal:
 * see `sameOriginNakamaConfig()`. [MEASURED 2026-09-06, nakama-js 2.8.0
 * dist source: the client appends "/ws" and the session token rides the
 * handshake query string, inside the TLS session.]
 */

/**
 * The protocol table lives in `shared/` (one definition for the TS client
 * and the Go runtime — shared/protocol.ts reads shared/protocol.json, the
 * single source of truth; the Go side is test-verified against the same
 * file). Re-exported here so this module's public API is unchanged.
 */
import { MatchOpcode, WIRE_MAX_BYTES, INPUT_SEND_HZ, INPUT_SEND_PERIOD_MS } from '../../shared/protocol';
export { MatchOpcode, WIRE_MAX_BYTES, INPUT_SEND_HZ, INPUT_SEND_PERIOD_MS };
export type { MatchOpcodeValue } from '../../shared/protocol';

/** Reconnect backoff defaults. [PLACEHOLDER — gate: Phase 5 tunes against real East-African links] */
export const RECONNECT_BASE_DELAY_MS = 250;
export const RECONNECT_MAX_DELAY_MS = 8000;
export const RECONNECT_MAX_ATTEMPTS = 10;
/** Delay = clamped-base × (1 + jitter × rng()), rng ∈ [0,1). */
export const RECONNECT_JITTER = 0.5;

/** A user on the wire (framework-free mirror of nakama-js `Presence`). */
export interface PresenceInfo {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly node: string;
}

/** One inbound match-state message (bytes only — decoding is the protocol layer's job). */
export interface MatchStateMessage {
  readonly matchId: string;
  readonly opCode: number;
  readonly data: Uint8Array;
  /** Nakama's reliable flag on the delivery. */
  readonly reliable: boolean;
  /** The sending presence, or null for server-originated messages. */
  readonly sender: PresenceInfo | null;
}

/** Inbound match presence join/leave event. */
export interface MatchPresenceEventMessage {
  readonly matchId: string;
  readonly joins: readonly PresenceInfo[];
  readonly leaves: readonly PresenceInfo[];
}

/** Result of a successful match join. */
export interface MatchJoined {
  readonly matchId: string;
  /** This client's session id inside the match. */
  readonly selfSessionId: string;
}

/** Terminal disconnect reasons surfaced by `NetSocket.onDisconnect`. */
export type DisconnectReason = 'userRequested' | 'reconnectExhausted';

/** NetSocket lifecycle states. */
export type NetSocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected';

/** What happened to a `sendMatchState` call. */
export type InputSendResult = 'sent' | 'coalesced' | 'droppedNotConnected';

/**
 * The transport seam. Everything above this line is framework-free; the
 * nakama-js adapter below is the only place that knows Nakama's shapes.
 */
export interface SocketTransport {
  /** Open the socket for this session token. Rejects on failure. */
  connect(sessionToken: string): Promise<void>;
  /** Close the socket. Must be idempotent and never throw on a dead socket. */
  close(): void;
  joinMatch(matchId: string): Promise<MatchJoined>;
  leaveMatch(matchId: string): Promise<void>;
  sendMatchState(matchId: string, opCode: number, data: Uint8Array, reliable: boolean): Promise<void>;
  onMatchState(handler: (message: MatchStateMessage) => void): void;
  onMatchPresence(handler: (event: MatchPresenceEventMessage) => void): void;
  /** The transport dropped (connection loss, server close, heartbeat timeout). */
  onDisconnect(handler: () => void): void;
}

/** Backoff policy. Delay for attempt k (1-based) = min(base·2^(k−1), max) clamped again after jitter. */
export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  readonly jitter: number;
}

/** Clock, scheduler and randomness seams — injected in tests, defaulted in production. */
export interface NetSocketConfig {
  readonly transport: SocketTransport;
  readonly backoff?: BackoffPolicy;
  /** Coalescing window in ms (1000 / send rate). */
  readonly inputSendPeriodMs?: number;
  /** Wall clock for the send window. Default Date.now. */
  readonly nowMs?: () => number;
  /**
   * Timer scheduler for the input flush and reconnect attempts.
   * Returns a cancel function. Default setTimeout/clearTimeout.
   */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  /** Jitter source in [0, 1). Default Math.random; seed with mulberry32 for determinism. */
  readonly rng?: () => number;
}

export interface NetSocket {
  readonly state: NetSocketState;
  /** The match currently joined (auto-rejoined after a reconnect), or null. */
  readonly activeMatchId: string | null;
  /**
   * Connect with a session JWT. Rejects on the first failure (state
   * 'failed'); the automatic backoff loop only covers a connection that
   * was ESTABLISHED and then dropped.
   */
  connect(sessionToken: string): Promise<void>;
  /**
   * Swap the session token used by automatic reconnects — the refresh path
   * (NETWORKING.md §12) calls this with the renewed JWT.
   */
  setSessionToken(sessionToken: string): void;
  /** User-requested disconnect. Cancels reconnects; never reconnects afterwards. */
  disconnect(): void;
  joinMatch(matchId: string): Promise<MatchJoined>;
  leaveMatch(matchId: string): Promise<void>;
  /**
   * Queue one input/state message under the 20 Hz coalescing window.
   * Throws on a payload over WIRE_MAX_BYTES (a schema bug must be loud);
   * returns 'droppedNotConnected' (never throws) when the socket is down —
   * the game loop must not crash on a mid-session drop.
   */
  sendMatchState(matchId: string, opCode: number, data: Uint8Array, reliable?: boolean): InputSendResult;
  onMatchState(handler: (message: MatchStateMessage) => void): () => void;
  onMatchPresence(handler: (event: MatchPresenceEventMessage) => void): () => void;
  onStateChange(handler: (state: NetSocketState) => void): () => void;
  /** Fires per automatic reconnect attempt, with the delay it is waiting out. */
  onReconnectAttempt(handler: (attempt: number, delayMs: number) => void): () => void;
  onDisconnect(handler: (info: { reason: DisconnectReason }) => void): () => void;
  /** Background failures: send errors, rejoin-after-reconnect failures. */
  onError(handler: (error: Error) => void): () => void;
}

/**
 * Deterministic PRNG for seeded jitter (same mulberry32 family as the
 * Phase-0 spikes). Production passes `Math.random`; tests pass a seeded
 * instance so backoff sequences are reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PendingInput {
  readonly matchId: string;
  readonly opCode: number;
  readonly data: Uint8Array;
  readonly reliable: boolean;
}

type Handler<T> = (payload: T) => void;

/** Tiny exception-safe handler set; returns the unsubscribe function. */
function handlerSet<T>(): {
  add: (h: Handler<T>) => () => void;
  emit: (payload: T, onSink: ((error: Error) => void) | undefined) => void;
} {
  const handlers: Array<Handler<T>> = [];
  return {
    add: (h) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    emit: (payload, onSink) => {
      for (const h of [...handlers]) {
        try {
          h(payload);
        } catch (err) {
          if (onSink !== undefined) onSink(err instanceof Error ? err : new Error(String(err)));
          else console.error(err); // a throwing error handler must not recurse
        }
      }
    },
  };
}

/** Build a NetSocket over an injected transport. This is the module's only constructor path. */
export function createNetSocket(config: NetSocketConfig): NetSocket {
  const transport = config.transport;
  const nowMs = config.nowMs ?? Date.now;
  const schedule = config.schedule ?? ((fn: () => void, delayMs: number) => {
    const id = setTimeout(fn, delayMs);
    return () => clearTimeout(id);
  });
  const rng = config.rng ?? Math.random;
  const backoff: BackoffPolicy = config.backoff ?? {
    baseDelayMs: RECONNECT_BASE_DELAY_MS,
    maxDelayMs: RECONNECT_MAX_DELAY_MS,
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    jitter: RECONNECT_JITTER,
  };
  const inputSendPeriodMs = config.inputSendPeriodMs ?? INPUT_SEND_PERIOD_MS;
  if (!(inputSendPeriodMs > 0)) throw new Error('inputSendPeriodMs must be > 0');

  const matchStateSet = handlerSet<MatchStateMessage>();
  const matchPresenceSet = handlerSet<MatchPresenceEventMessage>();
  const stateSet = handlerSet<NetSocketState>();
  const reconnectAttemptSet = handlerSet<{ attempt: number; delayMs: number }>();
  const disconnectSet = handlerSet<{ reason: DisconnectReason }>();
  const errorSet = handlerSet<Error>();

  const emitError = (err: Error): void => errorSet.emit(err, undefined);

  transport.onMatchState((m) => matchStateSet.emit(m, emitError));
  transport.onMatchPresence((e) => matchPresenceSet.emit(e, emitError));
  transport.onDisconnect(() => {
    if (state !== 'connected') return;
    // Presences do not survive a disconnect (NETWORKING.md §5 MatchLeave):
    // activeMatchId is KEPT and re-joined when the reconnect lands.
    setState('reconnecting');
    scheduleReconnect();
  });

  let state: NetSocketState = 'idle';
  let sessionToken = '';
  let activeMatchId: string | null = null;
  let reconnectAttempt = 0;
  let reconnectCancel: (() => void) | undefined;

  let pendingInput: PendingInput | undefined;
  let pendingCancel: (() => void) | undefined;
  let lastSentAtMs = Number.NEGATIVE_INFINITY;

  function setState(next: NetSocketState): void {
    state = next;
    stateSet.emit(state, emitError);
  }

  function clearPending(): void {
    pendingInput = undefined;
    if (pendingCancel !== undefined) {
      pendingCancel();
      pendingCancel = undefined;
    }
  }

  function sendNow(input: PendingInput): void {
    transport.sendMatchState(input.matchId, input.opCode, input.data, input.reliable).catch((err: unknown) => {
      emitError(err instanceof Error ? err : new Error('match-state send failed', { cause: err }));
    });
  }

  function flushPending(): void {
    pendingCancel = undefined;
    const input = pendingInput;
    pendingInput = undefined;
    if (input === undefined) return;
    if (state !== 'connected') return; // inputs do not survive a drop; reconnect restarts the flow
    lastSentAtMs = nowMs();
    sendNow(input);
  }

  function cancelReconnect(): void {
    if (reconnectCancel !== undefined) {
      reconnectCancel();
      reconnectCancel = undefined;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectAttempt >= backoff.maxAttempts) {
      setState('disconnected');
      disconnectSet.emit({ reason: 'reconnectExhausted' }, emitError);
      return;
    }
    reconnectAttempt += 1;
    const base = Math.min(backoff.baseDelayMs * 2 ** (reconnectAttempt - 1), backoff.maxDelayMs);
    const delayMs = Math.min(backoff.maxDelayMs, base * (1 + backoff.jitter * rng()));
    reconnectAttemptSet.emit({ attempt: reconnectAttempt, delayMs }, emitError);
    reconnectCancel = schedule(() => {
      reconnectCancel = undefined;
      transport
        .connect(sessionToken)
        .then(() => {
          reconnectAttempt = 0;
          setState('connected');
          const matchId = activeMatchId;
          if (matchId !== null) {
            transport.joinMatch(matchId).then(undefined, (err: unknown) => {
              emitError(err instanceof Error ? err : new Error('match rejoin after reconnect failed', { cause: err }));
            });
          }
        }, () => {
          scheduleReconnect();
        });
    }, delayMs);
  }

  return {
    get state(): NetSocketState {
      return state;
    },
    get activeMatchId(): string | null {
      return activeMatchId;
    },

    async connect(token: string): Promise<void> {
      if (state === 'connected' || state === 'connecting') {
        throw new Error('net socket is already connected or connecting');
      }
      cancelReconnect(); // an explicit connect supersedes any pending backoff attempt
      clearPending();
      sessionToken = token;
      setState('connecting');
      try {
        await transport.connect(token);
      } catch (err) {
        setState('failed');
        throw err;
      }
      reconnectAttempt = 0;
      setState('connected');
    },

    setSessionToken(token: string): void {
      sessionToken = token;
    },

    disconnect(): void {
      cancelReconnect();
      clearPending();
      if (state !== 'idle') {
        try {
          transport.close();
        } catch (err) {
          console.error(err);
        }
      }
      setState('disconnected');
      disconnectSet.emit({ reason: 'userRequested' }, emitError);
    },

    async joinMatch(matchId: string): Promise<MatchJoined> {
      if (state !== 'connected') throw new Error('cannot join a match while not connected');
      const joined = await transport.joinMatch(matchId);
      activeMatchId = matchId;
      return joined;
    },

    async leaveMatch(matchId: string): Promise<void> {
      if (activeMatchId === matchId) activeMatchId = null; // intent is authoritative even if the leave errors
      return transport.leaveMatch(matchId);
    },

    sendMatchState(matchId: string, opCode: number, data: Uint8Array, reliable = true): InputSendResult {
      if (data.byteLength > WIRE_MAX_BYTES) {
        throw new RangeError(`match-state payload is ${data.byteLength} B; the wire cap is ${WIRE_MAX_BYTES} B (CLAUDE.md — never moved)`);
      }
      if (state !== 'connected') return 'droppedNotConnected';
      const now = nowMs();
      if (now - lastSentAtMs >= inputSendPeriodMs) {
        // Window open: the newest observation wins — anything pending is stale.
        clearPending();
        lastSentAtMs = now;
        sendNow({ matchId, opCode, data, reliable });
        return 'sent';
      }
      // Window closed: hold exactly one pending input, latest wins.
      pendingInput = { matchId, opCode, data, reliable };
      const delayMs = Math.max(0, lastSentAtMs + inputSendPeriodMs - now);
      if (pendingCancel !== undefined) pendingCancel();
      pendingCancel = schedule(flushPending, delayMs);
      return 'coalesced';
    },

    onMatchState: (h) => matchStateSet.add(h),
    onMatchPresence: (h) => matchPresenceSet.add(h),
    onStateChange: (h) => stateSet.add(h),
    onReconnectAttempt: (h) => reconnectAttemptSet.add(({ attempt, delayMs }) => h(attempt, delayMs)),
    onDisconnect: (h) => disconnectSet.add(h),
    onError: (h) => errorSet.add(h),
  };
}

// ---------------------------------------------------------------------------
// Production transport: @heroiclabs/nakama-js 2.8.0 (NETWORKING.md §12 pin).
// Dynamically imported inside connect() so tests and non-network builds
// never load it.
// ---------------------------------------------------------------------------

/** Nakama endpoint config for `createNakamaTransport`. */
export interface NakamaTransportConfig {
  /** e.g. location.hostname — same-origin (NETWORKING.md §3). */
  readonly host: string;
  /** e.g. location.port, or '443'/'80'. The client appends ':port/ws'. */
  readonly port: string;
  /** true → wss:// (the Caddy origin). */
  readonly useSSL: boolean;
  /** Nakama socket server key (dev: 'defaultkey' unless the stack overrides it). */
  readonly serverKey: string;
  /** Optional refresh JWT for `Session.restore` (NETWORKING.md §12 refresh path). */
  readonly refreshToken?: string | undefined;
  readonly verbose?: boolean | undefined;
}

/**
 * Same-origin Nakama endpoint derived from the browser location — the
 * NETWORKING.md §3 posture (one origin; Caddy proxies /ws and /v2/*).
 * Call from the app shell, not from tests.
 */
export function sameOriginNakamaConfig(serverKey: string, loc: {
  protocol: string;
  hostname: string;
  port: string;
} = {
  protocol: typeof location === 'undefined' ? 'https:' : location.protocol,
  hostname: typeof location === 'undefined' ? '' : location.hostname,
  port: typeof location === 'undefined' ? '' : location.port,
}): NakamaTransportConfig {
  const useSSL = loc.protocol === 'https:' || loc.protocol === 'wss:';
  return {
    host: loc.hostname,
    port: loc.port !== '' ? loc.port : useSSL ? '443' : '80',
    useSSL,
    serverKey,
  };
}

type NakamaModule = typeof import('@heroiclabs/nakama-js');

function mapPresence(p: import('@heroiclabs/nakama-js').Presence): PresenceInfo {
  return { userId: p.user_id, sessionId: p.session_id, username: p.username, node: p.node };
}

/**
 * Adapt the pinned nakama-js client to the transport seam. [MEASURED
 * 2026-09-06, nakama-js 2.8.0 .d.ts + dist source: DefaultSocket builds
 * `ws(s)://host:port/ws?lang=en&status=…&token=…`; match data arrives via
 * the `onmatchdata` callback property; `Session.restore(token, refreshToken)`
 * decodes both JWTs (an empty refresh token skips refresh validation).
 * Interface drift in 2.8.0: the `Socket` INTERFACE declares
 * `sendMatchState(matchId, opCode, data, presence?)` — no `reliable` — while
 * the `DefaultSocket` CLASS (what `Client.createSocket` actually
 * constructs, dist/nakama-js.cjs.js `createSocket`) declares
 * `sendMatchState(matchId, opCode, data, presences?, reliable?)`. We bind
 * to `DefaultSocket` so the reliable flag reaches the wire.]
 */
export function createNakamaTransport(config: NakamaTransportConfig): SocketTransport {
  let socket: import('@heroiclabs/nakama-js').DefaultSocket | undefined;
  let matchStateHandler: ((m: MatchStateMessage) => void) | undefined;
  let presenceHandler: ((e: MatchPresenceEventMessage) => void) | undefined;
  let disconnectHandler: (() => void) | undefined;

  async function loadModule(): Promise<NakamaModule> {
    return import('@heroiclabs/nakama-js');
  }

  return {
    async connect(sessionToken: string): Promise<void> {
      const mod = await loadModule();
      const client = new mod.Client(config.serverKey, config.host, config.port, config.useSSL);
      const session = mod.Session.restore(sessionToken, config.refreshToken ?? '');
      // Downcast to DefaultSocket: createSocket is typed to the (stale)
      // Socket interface but always constructs a DefaultSocket — see the
      // [MEASURED] note above.
      const sock = client.createSocket(config.useSSL, config.verbose) as import('@heroiclabs/nakama-js').DefaultSocket;
      sock.onmatchdata = (md) => {
        matchStateHandler?.({
          matchId: md.match_id,
          opCode: md.op_code,
          data: md.data,
          reliable: md.reliable ?? true,
          sender: md.presence === undefined ? null : mapPresence(md.presence),
        });
      };
      sock.onmatchpresence = (ev) => {
        presenceHandler?.({
          matchId: ev.match_id,
          joins: ev.joins.map(mapPresence),
          leaves: ev.leaves.map(mapPresence),
        });
      };
      sock.ondisconnect = () => {
        disconnectHandler?.();
      };
      await sock.connect(session, false);
      socket = sock;
    },

    close(): void {
      try {
        socket?.disconnect(false);
      } catch (err) {
        console.error(err);
      }
      socket = undefined;
    },

    async joinMatch(matchId: string): Promise<MatchJoined> {
      const sock = socket;
      if (sock === undefined) throw new Error('nakama transport is not connected');
      const match = await sock.joinMatch(matchId, undefined, undefined);
      return { matchId: match.match_id, selfSessionId: match.self.session_id };
    },

    async leaveMatch(matchId: string): Promise<void> {
      const sock = socket;
      if (sock === undefined) throw new Error('nakama transport is not connected');
      await sock.leaveMatch(matchId);
    },

    async sendMatchState(matchId: string, opCode: number, data: Uint8Array, reliable: boolean): Promise<void> {
      const sock = socket;
      if (sock === undefined) throw new Error('nakama transport is not connected');
      await sock.sendMatchState(matchId, opCode, data, undefined, reliable);
    },

    onMatchState(handler: (m: MatchStateMessage) => void): void {
      matchStateHandler = handler;
    },
    onMatchPresence(handler: (e: MatchPresenceEventMessage) => void): void {
      presenceHandler = handler;
    },
    onDisconnect(handler: () => void): void {
      disconnectHandler = handler;
    },
  };
}
