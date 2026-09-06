/**
 * Net-socket wrapper tests (Phase 1/5 netcode groundwork).
 *
 * Deterministic by construction: the transport is a mock (no real sockets —
 * the brief forbids opening any in vitest), the clock and scheduler are
 * manual, and the reconnect jitter comes from a seeded mulberry32, so the
 * backoff sequence is asserted bitwise. The pinned @heroiclabs/nakama-js
 * adapter is exercised against a vi.mock'ed module — the URL/handler
 * mapping is checked without a network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INPUT_SEND_HZ,
  INPUT_SEND_PERIOD_MS,
  MatchOpcode,
  WIRE_MAX_BYTES,
  createNakamaTransport,
  createNetSocket,
  mulberry32,
  type MatchPresenceEventMessage,
  type MatchStateMessage,
  type NetSocket,
  type NetSocketState,
  type SocketTransport,
} from '../../client/src/net/socket';

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Manual clock: the game loop's nowMs stand-in. */
function makeClock(startMs = 0): { now: () => number; set: (ms: number) => void } {
  let now = startMs;
  return { now: () => now, set: (ms: number) => { now = ms; } };
}

interface ScheduledEntry {
  fn: () => void;
  delayMs: number;
  cancelled: boolean;
}

/** Manual scheduler: captures every scheduled callback with its delay. */
function makeScheduler(): { schedule: (fn: () => void, delayMs: number) => () => void; entries: ScheduledEntry[]; run: () => number } {
  const entries: ScheduledEntry[] = [];
  return {
    entries,
    schedule: (fn, delayMs) => {
      const entry: ScheduledEntry = { fn, delayMs, cancelled: false };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Run every live entry (in schedule order); returns how many fired. */
    run: () => {
      const due = entries.filter((e) => !e.cancelled);
      entries.length = 0;
      for (const e of due) e.fn();
      return due.length;
    },
  };
}

/** Mock transport implementing the SocketTransport seam. */
class MockTransport implements SocketTransport {
  connectCalls: string[] = [];
  joinCalls: string[] = [];
  leaveCalls: string[] = [];
  sent: Array<{ matchId: string; opCode: number; data: Uint8Array; reliable: boolean }> = [];
  closeCalls = 0;
  /** When set, connect() rejects (reconnect tests); else resolves. */
  connectError: Error | undefined;
  /** When set, joinMatch() rejects (rejoin-after-reconnect failure path). */
  joinError: Error | undefined;
  /** When set, sendMatchState rejects (error-path test). */
  sendError: Error | undefined;
  private matchStateHandler: ((m: MatchStateMessage) => void) | undefined;
  private presenceHandler: ((e: MatchPresenceEventMessage) => void) | undefined;
  private disconnectHandler: (() => void) | undefined;

  async connect(sessionToken: string): Promise<void> {
    this.connectCalls.push(sessionToken);
    if (this.connectError !== undefined) throw this.connectError;
  }

  close(): void {
    this.closeCalls += 1;
  }

  async joinMatch(matchId: string): Promise<{ matchId: string; selfSessionId: string }> {
    this.joinCalls.push(matchId);
    if (this.joinError !== undefined) throw this.joinError;
    return { matchId, selfSessionId: 'self-session' };
  }

  async leaveMatch(matchId: string): Promise<void> {
    this.leaveCalls.push(matchId);
  }

  async sendMatchState(matchId: string, opCode: number, data: Uint8Array, reliable: boolean): Promise<void> {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push({ matchId, opCode, data, reliable });
  }

  onMatchState(handler: (m: MatchStateMessage) => void): void {
    this.matchStateHandler = handler;
  }

  onMatchPresence(handler: (e: MatchPresenceEventMessage) => void): void {
    this.presenceHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  emitDisconnect(): void {
    this.disconnectHandler?.();
  }

  emitMatchState(message: MatchStateMessage): void {
    this.matchStateHandler?.(message);
  }

  emitPresence(joins: string[], leaves: string[]): void {
    const toPresence = (id: string) => ({ userId: id, sessionId: `${id}-s`, username: id, node: 'n1' });
    this.presenceHandler?.({ matchId: 'm1', joins: joins.map(toPresence), leaves: leaves.map(toPresence) });
  }
}

interface Harness {
  socket: NetSocket;
  transport: MockTransport;
  clock: ReturnType<typeof makeClock>;
  scheduler: ReturnType<typeof makeScheduler>;
  states: NetSocketState[];
  reconnectAttempts: Array<{ attempt: number; delayMs: number }>;
  disconnects: Array<{ reason: string }>;
  errors: Error[];
}

function makeHarness(rngSeed = 7, backoffOverrides?: { maxAttempts?: number }): Harness {
  const clock = makeClock(1000);
  const scheduler = makeScheduler();
  const transport = new MockTransport();
  const states: NetSocketState[] = [];
  const reconnectAttempts: Array<{ attempt: number; delayMs: number }> = [];
  const disconnects: Array<{ reason: string }> = [];
  const errors: Error[] = [];
  const socket = createNetSocket({
    transport,
    nowMs: clock.now,
    schedule: scheduler.schedule,
    rng: mulberry32(rngSeed),
    backoff: {
      baseDelayMs: 250,
      maxDelayMs: 8000,
      maxAttempts: backoffOverrides?.maxAttempts ?? 10,
      jitter: 0.5,
    },
  });
  socket.onStateChange((s) => states.push(s));
  socket.onReconnectAttempt((attempt, delayMs) => reconnectAttempts.push({ attempt, delayMs }));
  socket.onDisconnect((info) => disconnects.push(info));
  socket.onError((err) => errors.push(err));
  return { socket, transport, clock, scheduler, states, reconnectAttempts, disconnects, errors };
}

async function connectHarness(h: Harness): Promise<void> {
  await h.socket.connect('session-token');
  expect(h.socket.state).toBe('connected');
}

/**
 * Drain pending promise jobs: the reconnect chain continues in .then()
 * handlers, which run a microtask AFTER the manual scheduler's synchronous
 * run(). Deterministic — no timers involved.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('net socket: connect lifecycle', () => {
  it('transitions idle → connecting → connected', async () => {
    const h = makeHarness();
    const pending = h.socket.connect('session-token');
    expect(h.socket.state).toBe('connecting');
    await pending;
    expect(h.socket.state).toBe('connected');
    expect(h.states).toEqual(['connecting', 'connected']);
    expect(h.transport.connectCalls).toEqual(['session-token']);
  });

  it('rejects the first connect on failure and lands in failed (no auto-retry)', async () => {
    const h = makeHarness();
    h.transport.connectError = new Error('no route to host');
    await expect(h.socket.connect('session-token')).rejects.toThrow('no route to host');
    expect(h.socket.state).toBe('failed');
    expect(h.scheduler.entries).toHaveLength(0); // no background retry was armed
    // A failed socket may be retried explicitly.
    h.transport.connectError = undefined;
    await h.socket.connect('session-token');
    expect(h.socket.state).toBe('connected');
  });

  it('refuses a second concurrent connect', async () => {
    const h = makeHarness();
    const first = h.socket.connect('a');
    await expect(h.socket.connect('b')).rejects.toThrow();
    await first;
  });

  it('joinMatch records the active match; leaveMatch clears it; join while down throws', async () => {
    const h = makeHarness();
    await expect(h.socket.joinMatch('m1')).rejects.toThrow();
    await connectHarness(h);
    const joined = await h.socket.joinMatch('m1');
    expect(joined.matchId).toBe('m1');
    expect(joined.selfSessionId).toBe('self-session');
    expect(h.socket.activeMatchId).toBe('m1');
    expect(h.transport.joinCalls).toEqual(['m1']);
    await h.socket.leaveMatch('m1');
    expect(h.socket.activeMatchId).toBeNull();
    expect(h.transport.leaveCalls).toEqual(['m1']);
  });
});

// ---------------------------------------------------------------------------
// The 20 Hz coalescing throttle
// ---------------------------------------------------------------------------

describe('net socket: 20 Hz input-send throttle (NETWORKING.md §4)', () => {
  it('constant table matches the brief', () => {
    expect(INPUT_SEND_HZ).toBe(20);
    expect(INPUT_SEND_PERIOD_MS).toBe(50);
  });

  it('sends the first input immediately, coalesces the window, flushes latest-wins', async () => {
    const h = makeHarness();
    await connectHarness(h);
    h.transport.sent.length = 0;

    // t=1000: window open → immediate send.
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('A'))).toBe('sent');
    expect(h.transport.sent).toHaveLength(1);

    // t=1010: window closed → B is held.
    h.clock.set(1010);
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('B'))).toBe('coalesced');
    expect(h.transport.sent).toHaveLength(1);

    // t=1016: C overwrites B — at most ONE pending input, latest wins.
    h.clock.set(1016);
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('C'))).toBe('coalesced');
    expect(h.transport.sent).toHaveLength(1);

    // One flush timer is armed, for the moment the window reopens.
    const live = h.scheduler.entries.filter((e) => !e.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0]!.delayMs).toBe(1050 - 1016);

    h.scheduler.run();
    expect(h.transport.sent.map((s) => decoder(s.data))).toEqual(['A', 'C']); // B never leaves
    // The flush stamped lastSentAtMs = 1016 (the clock has not moved), so a
    // send at the same instant falls inside the NEXT window: coalesced.
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('x'))).toBe('coalesced');
    expect(h.transport.sent.map((s) => decoder(s.data))).toEqual(['A', 'C']);
  });

  it('flushes again on the next window boundary and never sends twice per window', () => {
    const h = makeHarness();
    return connectHarness(h).then(() => {
      h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('A')); // t=1000, sent
      h.clock.set(1010);
      h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('B')); // held
      h.clock.set(1016);
      h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('C')); // held, overwrites B
      h.scheduler.run(); // flush at the boundary; lastSent := 1016
      h.clock.set(1020);
      expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('D'))).toBe('coalesced'); // 4 ms in
      const live = h.scheduler.entries.filter((e) => !e.cancelled);
      expect(live).toHaveLength(1);
      expect(live[0]!.delayMs).toBe(1066 - 1020);
      h.clock.set(1066);
      h.scheduler.run();
      expect(h.transport.sent.map((s) => decoder(s.data))).toEqual(['A', 'C', 'D']);
      // A flush with nothing pending is a no-op and arms nothing.
      h.clock.set(1100);
      h.scheduler.run();
      expect(h.transport.sent).toHaveLength(3);
      expect(h.scheduler.entries).toHaveLength(0);
    });
  });

  it('enforces the 1500 B wire cap (CLAUDE.md — quoted, never moved) at the API boundary', () => {
    const h = makeHarness();
    return connectHarness(h).then(() => {
      expect(WIRE_MAX_BYTES).toBe(1500);
      const atCap = new Uint8Array(1500);
      const overCap = new Uint8Array(1501);
      expect(() => h.socket.sendMatchState('m1', MatchOpcode.INPUT, overCap)).toThrow(RangeError);
      expect(() => h.socket.sendMatchState('m1', MatchOpcode.INPUT, atCap)).not.toThrow();
      expect(h.transport.sent).toHaveLength(1); // the at-cap message went out
    });
  });

  it('returns droppedNotConnected while down instead of throwing (game loops must survive drops)', async () => {
    const h = makeHarness();
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('A'))).toBe('droppedNotConnected');
    await connectHarness(h);
    h.transport.emitDisconnect(); // → reconnecting
    expect(h.socket.state).toBe('reconnecting');
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('B'))).toBe('droppedNotConnected');
  });

  it('routes transport send failures to onError, not to the game loop', async () => {
    const h = makeHarness();
    await connectHarness(h);
    h.transport.sendError = new Error('socket dead mid-send');
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('A'))).toBe('sent');
    await Promise.resolve(); // let the rejected promise settle
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.message).toBe('socket dead mid-send');
  });

  it('drops held input at flush time when the socket went down mid-window', async () => {
    const h = makeHarness();
    await connectHarness(h);
    h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('A')); // sent
    h.clock.set(1010);
    expect(h.socket.sendMatchState('m1', MatchOpcode.INPUT, utf8('B'))).toBe('coalesced');
    h.transport.emitDisconnect(); // window still closed, B pending
    expect(h.socket.state).toBe('reconnecting');
    h.scheduler.run(); // flush fires during reconnecting
    expect(h.transport.sent.map((s) => decoder(s.data))).toEqual(['A']); // B dropped, not sent stale
  });
});

// ---------------------------------------------------------------------------
// Reconnect: exponential backoff + seeded jitter, auto-rejoin
// ---------------------------------------------------------------------------

describe('net socket: reconnect backoff (seeded, deterministic)', () => {
  it('delays follow base·2^k clamped, jittered from the seeded rng, and rejoin the active match', async () => {
    // Fresh generators: one drives the module, the other predicts it.
    const expected = mulberry32(7);
    const h = makeHarness(7);
    await connectHarness(h);
    await h.socket.joinMatch('m1');

    h.transport.emitDisconnect();
    expect(h.socket.state).toBe('reconnecting');
    expect(h.transport.connectCalls).toHaveLength(1);

    // attempt 1: base 250, r1
    const r1 = expected();
    expect(h.reconnectAttempts[0]).toEqual({ attempt: 1, delayMs: Math.min(8000, 250 * (1 + 0.5 * r1)) });
    // attempt 2 fails (transport error set), attempt 3 succeeds.
    h.transport.connectError = new Error('still down');
    h.scheduler.run();
    await flushMicrotasks(); // the failure → next attempt chain runs in a .then()
    expect(h.socket.state).toBe('reconnecting');
    const r2 = expected();
    expect(h.reconnectAttempts[1]).toEqual({ attempt: 2, delayMs: Math.min(8000, 500 * (1 + 0.5 * r2)) });

    h.transport.connectError = undefined;
    h.scheduler.run();
    await flushMicrotasks(); // success → state change + auto-rejoin
    expect(h.socket.state).toBe('connected');
    expect(h.transport.connectCalls).toEqual(['session-token', 'session-token', 'session-token']);
    // The held match was re-joined automatically — presences do not survive
    // a disconnect (NETWORKING.md §5 MatchLeave semantics).
    expect(h.transport.joinCalls).toEqual(['m1', 'm1']);
    expect(h.socket.activeMatchId).toBe('m1');
  });

  it('gives up after maxAttempts and surfaces reconnectExhausted', async () => {
    const h = makeHarness(7, { maxAttempts: 2 });
    await connectHarness(h);
    h.transport.connectError = new Error('down');
    h.transport.emitDisconnect();
    h.scheduler.run(); // attempt 1 fails
    await flushMicrotasks(); // the failure schedules attempt 2
    h.scheduler.run(); // attempt 2 fails → exhausted
    await flushMicrotasks();
    expect(h.socket.state).toBe('disconnected');
    expect(h.disconnects).toEqual([{ reason: 'reconnectExhausted' }]);
    expect(h.transport.connectCalls).toHaveLength(3); // initial + 2 attempts
    expect(h.scheduler.entries).toHaveLength(0); // nothing left armed
    // And a later drop is ignored in the dead state (no zombie reconnect).
    h.transport.emitDisconnect();
    expect(h.socket.state).toBe('disconnected');
  });

  it('never reconnects after a user-requested disconnect', async () => {
    const h = makeHarness(7);
    await connectHarness(h);
    h.socket.disconnect();
    expect(h.socket.state).toBe('disconnected');
    expect(h.disconnects).toEqual([{ reason: 'userRequested' }]);
    expect(h.transport.closeCalls).toBe(1);
    h.transport.emitDisconnect(); // late transport close event
    expect(h.socket.state).toBe('disconnected');
    expect(h.scheduler.entries).toHaveLength(0);
    expect(h.transport.connectCalls).toHaveLength(1);
  });

  it('reconnects with the RENEWED token after setSessionToken (NETWORKING.md §12 refresh path)', async () => {
    const h = makeHarness(7);
    await connectHarness(h);
    h.socket.setSessionToken('refreshed-token');
    h.transport.emitDisconnect();
    h.scheduler.run();
    expect(h.transport.connectCalls).toEqual(['session-token', 'refreshed-token']);
  });

  it('an explicit connect() cancels a pending backoff attempt', async () => {
    const h = makeHarness(7);
    await connectHarness(h);
    h.transport.emitDisconnect();
    expect(h.scheduler.entries).toHaveLength(1); // backoff armed
    await h.socket.connect('manual-token');
    expect(h.socket.state).toBe('connected');
    // The armed backoff entry was cancelled, not forgotten.
    expect(h.scheduler.entries.every((e) => e.cancelled)).toBe(true);
    h.scheduler.run(); // must not fire the cancelled attempt
    expect(h.transport.connectCalls).toEqual(['session-token', 'manual-token']);
    expect(h.socket.state).toBe('connected');
  });

  it('reports a failed post-reconnect rejoin via onError and stays connected', async () => {
    const h = makeHarness(7);
    await connectHarness(h);
    await h.socket.joinMatch('m1');
    h.transport.emitDisconnect();
    h.transport.joinError = new Error('join refused');
    h.scheduler.run();
    await flushMicrotasks(); // connect resolves, then the rejoin rejects
    expect(h.socket.state).toBe('connected');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.message).toBe('join refused');
    expect(h.transport.joinCalls).toEqual(['m1', 'm1']);
  });
});

// ---------------------------------------------------------------------------
// Inbound handlers and the opcode table
// ---------------------------------------------------------------------------

describe('net socket: inbound events and opcodes', () => {
  it('forwards match-state messages to onMatchState verbatim', async () => {
    const h = makeHarness();
    const received: MatchStateMessage[] = [];
    h.socket.onMatchState((m) => received.push(m));
    await connectHarness(h);
    const payload = utf8('snapshot-bytes');
    h.transport.emitMatchState({
      matchId: 'm1',
      opCode: MatchOpcode.SNAPSHOT,
      data: payload,
      reliable: true,
      sender: null,
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.opCode).toBe(MatchOpcode.SNAPSHOT);
    expect(received[0]!.data).toBe(payload);
    expect(received[0]!.sender).toBeNull();
  });

  it('forwards presence join/leave events', async () => {
    const h = makeHarness();
    const events: Array<{ joins: string[]; leaves: string[] }> = [];
    h.socket.onMatchPresence((e) => events.push({ joins: e.joins.map((p) => p.userId), leaves: e.leaves.map((p) => p.userId) }));
    await connectHarness(h);
    h.transport.emitPresence(['alice'], ['bob']);
    expect(events).toEqual([{ joins: ['alice'], leaves: ['bob'] }]);
  });

  it('a throwing onMatchState handler is contained (dispatch continues, error surfaces via onError)', async () => {
    const h = makeHarness();
    h.socket.onMatchState(() => {
      throw new Error('renderer bug');
    });
    const after: MatchStateMessage[] = [];
    h.socket.onMatchState((m) => after.push(m));
    await connectHarness(h);
    h.transport.emitMatchState({ matchId: 'm1', opCode: 1, data: utf8('x'), reliable: true, sender: null });
    h.transport.emitMatchState({ matchId: 'm1', opCode: 1, data: utf8('y'), reliable: true, sender: null });
    expect(after).toHaveLength(2); // the second handler was still called both times
    expect(h.errors.map((e) => e.message)).toEqual(['renderer bug', 'renderer bug']);
  });

  it('the opcode table is frozen (a mutated protocol table is a defect)', () => {
    expect(() => {
      (MatchOpcode as { INPUT: number }).INPUT = 99;
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The nakama-js adapter, against a vi.mock'ed module (no real sockets)
// ---------------------------------------------------------------------------

interface FakePresence {
  user_id: string;
  session_id: string;
  username: string;
  node: string;
}

interface FakeMatchData {
  match_id: string;
  op_code: number;
  data: Uint8Array;
  presence?: FakePresence;
  reliable?: boolean;
}

const nakamaFakes = vi.hoisted(() => {
  interface FakePresenceShim {
    user_id: string;
    session_id: string;
    username: string;
    node: string;
  }
  interface FakeMatchDataShim {
    match_id: string;
    op_code: number;
    data: Uint8Array;
    presence?: FakePresenceShim;
    reliable?: boolean;
  }
  interface FakePresenceEventShim {
    match_id: string;
    joins: FakePresenceShim[];
    leaves: FakePresenceShim[];
  }
  interface FakeSocketRecord {
    connectCalls: Array<{ token: unknown; createStatus: boolean }>;
    disconnectCalls: boolean[];
    joinCalls: Array<{ matchId: string | undefined; token: string | undefined; metadata: unknown }>;
    leaveCalls: string[];
    sendCalls: Array<{ matchId: string; opCode: number; data: Uint8Array; presences: unknown; reliable: boolean | undefined }>;
    onmatchdata: ((md: FakeMatchDataShim) => void) | undefined;
    onmatchpresence: ((ev: FakePresenceEventShim) => void) | undefined;
    ondisconnect: (() => void) | undefined;
  }

  const clients: Array<{ serverKey: string; host: string; port: string; useSSL: boolean }> = [];
  // The record IS the socket object: the adapter assigns
  // `sock.onmatchdata = …` etc. on the instance, so assertions must read the
  // same object (a detached copy would never see the handlers).
  const sockets: FakeSocketRecord[] = [];
  const restored: Array<{ token: string; refresh: string }> = [];

  class FakeNakamaSocket implements FakeSocketRecord {
    connectCalls: Array<{ token: unknown; createStatus: boolean }> = [];
    disconnectCalls: boolean[] = [];
    joinCalls: Array<{ matchId: string | undefined; token: string | undefined; metadata: unknown }> = [];
    leaveCalls: string[] = [];
    sendCalls: Array<{ matchId: string; opCode: number; data: Uint8Array; presences: unknown; reliable: boolean | undefined }> = [];
    onmatchdata: ((md: FakeMatchDataShim) => void) | undefined;
    onmatchpresence: ((ev: FakePresenceEventShim) => void) | undefined;
    ondisconnect: (() => void) | undefined;

    constructor() {
      sockets.push(this);
    }
    connect(session: unknown, createStatus: boolean): Promise<unknown> {
      this.connectCalls.push({ token: session, createStatus });
      return Promise.resolve({ token: session });
    }
    disconnect(fireDisconnectEvent: boolean): void {
      this.disconnectCalls.push(fireDisconnectEvent);
    }
    joinMatch(matchId: string | undefined, token: string | undefined, metadata: unknown): Promise<unknown> {
      this.joinCalls.push({ matchId, token, metadata });
      return Promise.resolve({
        match_id: matchId,
        authoritative: true,
        size: 1,
        presences: [],
        self: { user_id: 'u1', session_id: 'self-session', username: 'me', node: 'n1' },
      });
    }
    leaveMatch(matchId: string): Promise<void> {
      this.leaveCalls.push(matchId);
      return Promise.resolve();
    }
    sendMatchState(
      matchId: string,
      opCode: number,
      data: Uint8Array,
      presences: unknown,
      reliable: boolean | undefined,
    ): Promise<void> {
      this.sendCalls.push({ matchId, opCode, data, presences, reliable });
      return Promise.resolve();
    }
  }

  class FakeClient {
    constructor(
      public serverkey: string,
      public host: string,
      public port: string,
      public useSSL: boolean,
    ) {
      clients.push({ serverKey: serverkey, host, port, useSSL });
    }
    createSocket(useSSL?: boolean, verbose?: boolean): FakeNakamaSocket {
      void useSSL;
      void verbose;
      return new FakeNakamaSocket();
    }
  }

  const Session = {
    restore(token: string, refreshToken: string): unknown {
      restored.push({ token, refresh: refreshToken });
      return { token, refresh_token: refreshToken };
    },
  };

  return { clients, sockets, restored, FakeClient, Session };
});

vi.mock('@heroiclabs/nakama-js', () => ({
  Client: nakamaFakes.FakeClient,
  Session: nakamaFakes.Session,
}));

describe('net socket: nakama-js 2.8.0 adapter (mocked module)', () => {
  // The hoisted fake module records into module-level arrays; each test
  // below creates its own transport, so reset before each one or the
  // assertions against sockets[0] would read a previous test's socket.
  beforeEach(() => {
    nakamaFakes.clients.length = 0;
    nakamaFakes.sockets.length = 0;
    nakamaFakes.restored.length = 0;
  });

  it('builds the client from the same-origin config and restores the session', async () => {
    const transport = createNakamaTransport({
      host: 'localhost',
      port: '8443',
      useSSL: true,
      serverKey: 'defaultkey',
    });
    await transport.connect('session-jwt');
    expect(nakamaFakes.clients[0]).toEqual({ serverKey: 'defaultkey', host: 'localhost', port: '8443', useSSL: true });
    expect(nakamaFakes.restored).toEqual([{ token: 'session-jwt', refresh: '' }]);
    expect(nakamaFakes.sockets[0]!.connectCalls).toEqual([{ token: { token: 'session-jwt', refresh_token: '' }, createStatus: false }]);
  });

  it('maps onmatchdata/onmatchpresence onto the framework-free message shapes', async () => {
    const transport = createNakamaTransport({ host: 'h', port: '443', useSSL: true, serverKey: 'k' });
    const received: MatchStateMessage[] = [];
    const presenceEvents: Array<{ joins: string[]; leaves: string[] }> = [];
    transport.onMatchState((m) => received.push(m));
    transport.onMatchPresence((e) => presenceEvents.push({ joins: e.joins.map((p) => p.userId), leaves: e.leaves.map((p) => p.userId) }));
    await transport.connect('jwt');
    const sock = nakamaFakes.sockets[0]!;

    sock.onmatchdata?.({ match_id: 'm1', op_code: 2, data: utf8('snap'), reliable: false });
    sock.onmatchdata?.({ match_id: 'm1', op_code: 2, data: utf8('server-origin'), presence: { user_id: 'u9', session_id: 's9', username: 'zed', node: 'n2' } });
    sock.onmatchpresence?.({
      match_id: 'm1',
      joins: [{ user_id: 'u1', session_id: 's1', username: 'a', node: 'n1' }],
      leaves: [{ user_id: 'u2', session_id: 's2', username: 'b', node: 'n1' }],
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ matchId: 'm1', opCode: 2, data: utf8('snap'), reliable: false, sender: null });
    expect(received[1]!.reliable).toBe(true); // nakama-js omits the flag for reliable deliveries → default true
    expect(received[1]!.sender).toEqual({ userId: 'u9', sessionId: 's9', username: 'zed', node: 'n2' });
    expect(presenceEvents).toEqual([{ joins: ['u1'], leaves: ['u2'] }]);
  });

  it('maps join/leave/send/close onto the pinned client API shapes', async () => {
    const transport = createNakamaTransport({ host: 'h', port: '443', useSSL: true, serverKey: 'k' });
    await transport.connect('jwt');
    const sock = nakamaFakes.sockets[0]!;

    const joined = await transport.joinMatch('m1');
    expect(joined).toEqual({ matchId: 'm1', selfSessionId: 'self-session' });
    expect(sock.joinCalls).toEqual([{ matchId: 'm1', token: undefined, metadata: undefined }]);

    await transport.sendMatchState('m1', 1, utf8('in'), true);
    expect(sock.sendCalls).toEqual([{ matchId: 'm1', opCode: 1, data: utf8('in'), presences: undefined, reliable: true }]);

    await transport.leaveMatch('m1');
    expect(sock.leaveCalls).toEqual(['m1']);

    transport.close();
    expect(sock.disconnectCalls).toEqual([false]);
    transport.close(); // idempotent
    expect(sock.disconnectCalls).toEqual([false]);
  });

  it('surfaces the transport drop through onDisconnect', async () => {
    const transport = createNakamaTransport({ host: 'h', port: '443', useSSL: true, serverKey: 'k' });
    let dropped = 0;
    transport.onDisconnect(() => {
      dropped += 1;
    });
    await transport.connect('jwt');
    nakamaFakes.sockets[0]!.ondisconnect?.();
    expect(dropped).toBe(1);
  });

  it('operations before connect reject cleanly', async () => {
    const transport = createNakamaTransport({ host: 'h', port: '443', useSSL: true, serverKey: 'k' });
    await expect(transport.joinMatch('m1')).rejects.toThrow('not connected');
    await expect(transport.sendMatchState('m1', 1, utf8('x'), true)).rejects.toThrow('not connected');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

function decoder(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
