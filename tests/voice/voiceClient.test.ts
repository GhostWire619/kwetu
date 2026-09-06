/**
 * Voice client + spatial audio graph tests (Phase 6 groundwork).
 *
 * Deterministic by construction: node has no WebAudio and no LiveKit server,
 * so both seams are injected — an `AudioContextLike` stub records the graph
 * (created nodes, param writes, connect/disconnect wiring) and a `VoiceRoom`
 * stub records the LiveKit operations and re-emits its events on demand.
 * The pinned livekit-client production adapter is additionally exercised
 * against a vi.mock'ed module — the Room option shapes and the event
 * mappings are checked without the real SDK, network or media elements
 * (mirroring what tests/net/socket.test.ts does for the nakama-js adapter).
 * No real audio devices, no network, no JWT handling (the Go runtime mints
 * tokens — the client only receives one, so tests pass opaque strings).
 *
 * Honesty note: positional hearing is verified by GRAPH assertions only —
 * which nodes exist, how they are wired, which params were written — never
 * by listening. The human Phase-6 criterion (does spatialized voice actually
 * externalize on headphones) stands and is out of scope for CI. Likewise
 * TURN/CGNAT relay behaviour is untested until deploy against a real domain
 * (NETWORKING.md §2/§10).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANNER_REF_DISTANCE_M,
  PANNER_ROLLOFF_FACTOR,
  getSharedAudioContext,
  createSpatialAudio,
  type AudioContextLike,
  type AudioNodeLike,
  type PannerNodeLike,
  type RemoteTrackHandle,
  type SpatialAudio,
} from '../../client/src/voice/spatial';
import {
  createLiveKitRoom,
  createVoiceClient,
  type VoiceClient,
  type VoiceRoom,
  type VoiceRoomEvent,
  type VoiceRoomEvents,
} from '../../client/src/voice/voiceClient';

// ---------------------------------------------------------------------------
// WebAudio stubs — structural, recording, no real audio
// ---------------------------------------------------------------------------

interface Param {
  value: number;
}
function param(initial = 0): Param {
  return { value: initial };
}

interface FakePanner extends PannerNodeLike {
  /** Destinations this node was connected to (cleared on disconnect). */
  connections: AudioNodeLike[];
  /** How many times disconnect() was called. */
  disconnectCalls: number;
}

function makeNode(): AudioNodeLike & { connections: AudioNodeLike[]; disconnectCalls: number } {
  const node = {
    connections: [] as AudioNodeLike[],
    disconnectCalls: 0,
    connect(destination: AudioNodeLike): AudioNodeLike {
      node.connections.push(destination);
      return destination;
    },
    disconnect(): void {
      node.connections.length = 0;
      node.disconnectCalls += 1;
    },
  };
  return node;
}

function makePanner(): FakePanner {
  // ONE object, extended in place — not a spread copy. makeNode()'s methods
  // close over the inner object, so a spread would strand a stale
  // `disconnectCalls` counter on the panner while disconnect() incremented
  // the original: the graph assertions would read a counter that never moves.
  const panner = Object.assign(makeNode(), {
    panningModel: 'HRTF' as PanningModelType,
    distanceModel: 'inverse' as DistanceModelType,
    refDistance: 0,
    maxDistance: 10000,
    rolloffFactor: 0,
    coneInnerAngle: 0,
    coneOuterAngle: 0,
    coneOuterGain: 0,
    positionX: param(),
    positionY: param(),
    positionZ: param(),
  });
  return panner;
}

class FakeAudioContext implements AudioContextLike {
  state = 'suspended';
  readonly destination = makeNode();
  readonly listener = {
    positionX: param(),
    positionY: param(),
    positionZ: param(),
    forwardX: param(),
    forwardY: param(),
    forwardZ: param(),
    upX: param(),
    upY: param(),
    upZ: param(),
  };
  resumeCalls = 0;
  closeCalls = 0;
  readonly createdPanners: FakePanner[] = [];
  readonly createdSources: Array<{ stream: MediaStream; node: ReturnType<typeof makeNode> }> = [];

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  createPanner(): FakePanner {
    const panner = makePanner();
    this.createdPanners.push(panner);
    return panner;
  }
  createMediaStreamSource(stream: MediaStream): ReturnType<typeof makeNode> {
    const node = makeNode();
    this.createdSources.push({ stream, node });
    return node;
  }
}

// ---------------------------------------------------------------------------
// VoiceRoom stub — records operations, re-emits events on demand
// ---------------------------------------------------------------------------

class FakeRoom implements VoiceRoom {
  /** Shared with the harness so events land in the call-order log. */
  order: string[] = [];
  connectCalls: Array<{ url: string; token: string }> = [];
  startAudioCalls = 0;
  disconnectCalls = 0;
  publishCalls = 0;
  muteCalls: boolean[] = [];

  private readonly handlerSets: { [K in VoiceRoomEvent]: Set<VoiceRoomEvents[K]> } = {
    trackSubscribed: new Set(),
    trackUnsubscribed: new Set(),
    participantConnected: new Set(),
    participantDisconnected: new Set(),
    reconnected: new Set(),
    disconnected: new Set(),
  };

  async connect(url: string, token: string): Promise<void> {
    this.order.push('room.connect');
    this.connectCalls.push({ url, token });
  }
  async startAudio(): Promise<void> {
    this.order.push('room.startAudio');
    this.startAudioCalls += 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
  async publishMic(): Promise<void> {
    this.publishCalls += 1;
  }
  async setMicMuted(muted: boolean): Promise<void> {
    this.muteCalls.push(muted);
  }
  on<K extends VoiceRoomEvent>(event: K, handler: VoiceRoomEvents[K]): () => void {
    const set = this.handlerSets[event];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emitTrackSubscribed(track: RemoteTrackHandle, participantId: string): void {
    for (const h of [...this.handlerSets.trackSubscribed]) h(track, participantId);
  }
  emitTrackUnsubscribed(track: RemoteTrackHandle, participantId: string): void {
    for (const h of [...this.handlerSets.trackUnsubscribed]) h(track, participantId);
  }
  emitParticipantConnected(participantId: string): void {
    for (const h of [...this.handlerSets.participantConnected]) h(participantId);
  }
  emitParticipantDisconnected(participantId: string): void {
    for (const h of [...this.handlerSets.participantDisconnected]) h(participantId);
  }
  emitReconnected(): void {
    for (const h of [...this.handlerSets.reconnected]) h();
  }
  emitDisconnected(): void {
    for (const h of [...this.handlerSets.disconnected]) h();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface VoiceHarness {
  client: VoiceClient;
  context: FakeAudioContext;
  room: FakeRoom;
  order: string[];
  states: string[];
  errors: Error[];
}

function makeVoiceHarness(): VoiceHarness {
  const context = new FakeAudioContext();
  const room = new FakeRoom();
  const order: string[] = [];
  room.order = order;
  const client = createVoiceClient({
    contextFactory: () => {
      order.push('createContext');
      return context;
    },
    roomFactory: async (ctx) => {
      order.push('roomFactory');
      void ctx;
      return room;
    },
  });
  const states: string[] = [];
  const errors: Error[] = [];
  client.onStateChange((s) => states.push(s));
  client.onError((e) => errors.push(e));
  return { client, context, room, order, states, errors };
}

/** Connect a harness and return after the room is up. */
async function connectHarness(h: VoiceHarness): Promise<void> {
  await h.client.connect('wss://voice.example', 'opaque-token-from-the-go-runtime');
  h.order.length = 0; // the gesture log is asserted by its own test
}

// ---------------------------------------------------------------------------
// The user-gesture contract (NETWORKING.md §10 autoplay rule)
// ---------------------------------------------------------------------------

describe('voice client: user-gesture contract', () => {
  it('creates the shared context and initiates resume() synchronously, before the first await', async () => {
    const h = makeVoiceHarness();
    const pending = h.client.connect('wss://voice.example', 'token');
    // Observed WITHOUT awaiting anything: this is the gesture-critical
    // section. Everything here has run while the click handler is still on
    // the stack.
    expect(h.order).toEqual(['createContext', 'roomFactory']); // context FIRST, inside the gesture
    expect(h.context.resumeCalls).toBe(1); // resume initiated in-gesture
    expect(h.room.connectCalls).toHaveLength(0); // the await has not landed yet
    expect(h.room.startAudioCalls).toBe(0);
    await pending;
    expect(h.context.state).toBe('running');
  });

  it('connects, then calls startAudio (the LiveKit autoplay rule), in that order', async () => {
    const h = makeVoiceHarness();
    await h.client.connect('wss://voice.example', 'token');
    expect(h.order).toEqual(['createContext', 'roomFactory', 'room.connect', 'room.startAudio']);
    expect(h.room.connectCalls).toEqual([{ url: 'wss://voice.example', token: 'token' }]);
    expect(h.client.state).toBe('connected');
    expect(h.states).toEqual(['connecting', 'connected']);
  });

  it('a connect failure lands in failed, rethrows, and never calls startAudio', async () => {
    const h = makeVoiceHarness();
    h.room.connect = async (): Promise<void> => {
      h.order.push('room.connect');
      throw new Error('room join refused');
    };
    await expect(h.client.connect('wss://voice.example', 'token')).rejects.toThrow('room join refused');
    expect(h.client.state).toBe('failed');
    expect(h.states).toEqual(['connecting', 'failed']);
    expect(h.room.startAudioCalls).toBe(0);
    // The gesture-critical section still ran: the context exists and resume
    // was initiated before the failure (it is not re-armed per attempt).
    expect(h.context.resumeCalls).toBe(1);
  });

  it('a fresh client may connect after a failed attempt', async () => {
    const h = makeVoiceHarness();
    h.room.connectCalls.push(...([] as Array<{ url: string; token: string }>));
    await expect(h.client.connect('', 'token')).rejects.toThrow();
    await h.client.connect('wss://voice.example', 'token');
    expect(h.client.state).toBe('connected');
  });

  it('rejects an empty url or token before touching the context or the room (minting is server-side)', async () => {
    const h = makeVoiceHarness();
    await expect(h.client.connect('', 'token')).rejects.toThrow('liveKitUrl');
    await expect(h.client.connect('wss://voice.example', '')).rejects.toThrow('token');
    expect(h.context.resumeCalls).toBe(0);
    expect(h.room.connectCalls).toHaveLength(0);
    expect(h.client.state).toBe('idle');
  });

  it('refuses a second concurrent connect', async () => {
    const h = makeVoiceHarness();
    const first = h.client.connect('wss://voice.example', 'token');
    await expect(h.client.connect('wss://voice.example', 'token')).rejects.toThrow('already connected or connecting');
    await first;
  });

  it('disconnect() tears the room down and resets mic state', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await h.client.publishMic(true);
    await h.client.disconnect();
    expect(h.room.disconnectCalls).toBe(1);
    expect(h.client.state).toBe('disconnected');
    expect(h.client.micPublished).toBe(false);
    expect(h.client.transmitting).toBe(false);
    expect(h.client.openMicOptIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Push-to-talk mic (the AEC trap is a product rule — ADR-012 D10)
// ---------------------------------------------------------------------------

describe('voice client: push-to-talk mic (ADR-012 D10, NETWORKING.md §11)', () => {
  it('publishMic() defaults to push-to-talk: published but MUTED, open-mic opt-in false', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await h.client.publishMic();
    expect(h.room.publishCalls).toBe(1);
    expect(h.room.muteCalls).toEqual([true]); // the safe default: silent until the key is held
    expect(h.client.micPublished).toBe(true);
    expect(h.client.transmitting).toBe(false);
    expect(h.client.openMicOptIn).toBe(false);
  });

  it('setPushToTalk edges mute and unmute in place (no republish)', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await h.client.publishMic(true);
    await h.client.setPushToTalk(true); // key held
    expect(h.room.muteCalls).toEqual([true, false]);
    expect(h.client.transmitting).toBe(true);
    await h.client.setPushToTalk(false); // key released
    expect(h.room.muteCalls).toEqual([true, false, true]);
    expect(h.client.transmitting).toBe(false);
    expect(h.room.publishCalls).toBe(1); // never republished
  });

  it('publishMic(false) is the explicit open-mic opt-in and is reported as such', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await h.client.publishMic(false);
    expect(h.room.muteCalls).toEqual([false]);
    expect(h.client.transmitting).toBe(true);
    expect(h.client.openMicOptIn).toBe(true); // the UI must show the AEC warning when this is true
  });

  it('setPushToTalk before publishMic throws with the gesture guidance', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await expect(h.client.setPushToTalk(true)).rejects.toThrow('publishMic');
  });

  it('publishMic before connect throws', async () => {
    const client = createVoiceClient();
    await expect(client.publishMic(true)).rejects.toThrow('connect()');
  });

  it('a failed initial mute lands no client state and forces the safe mute (no room/client divergence)', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    h.room.setMicMuted = async (muted: boolean): Promise<void> => {
      h.room.muteCalls.push(muted);
      throw new Error('mute rejected');
    };
    await expect(h.client.publishMic(true)).rejects.toThrow('mute rejected');
    // The room never confirmed the posture, so the client must not claim it:
    // micPublished stays false — the UI keeps showing "mic off" while the
    // divergence is surfaced, instead of reporting an opt-in that never took.
    expect(h.client.micPublished).toBe(false);
    expect(h.client.openMicOptIn).toBe(false);
    expect(h.client.transmitting).toBe(false);
    expect(h.room.muteCalls).toEqual([true, true]); // the attempt + the best-effort safe mute
  });

  it('setPushToTalk keeps client mute state only for a confirmed room mute', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    await h.client.publishMic(true);
    h.room.setMicMuted = async (muted: boolean): Promise<void> => {
      h.room.muteCalls.push(muted);
      throw new Error('unmute rejected');
    };
    await expect(h.client.setPushToTalk(true)).rejects.toThrow('unmute rejected');
    expect(h.client.transmitting).toBe(false); // the client mute flag did not move — the room is still muted
  });
});

// ---------------------------------------------------------------------------
// subscribeRemote: room events drive the spatial graph
// ---------------------------------------------------------------------------

interface SdkTrackFake {
  handle: RemoteTrackHandle;
  pluginCalls: AudioNodeLike[][];
  attachCalls: number;
  detachCalls: number;
  /** Call order across attach/setWebAudioPlugins/detach — the ordering assertions read this. */
  calls: string[];
}

function sdkTrack(): SdkTrackFake {
  const fake: SdkTrackFake = {
    pluginCalls: [],
    attachCalls: 0,
    detachCalls: 0,
    calls: [],
    handle: {} as RemoteTrackHandle,
  };
  fake.handle = {
    attach: (): void => {
      fake.attachCalls += 1;
      fake.calls.push('attach');
    },
    setWebAudioPlugins: (nodes) => {
      fake.pluginCalls.push([...nodes]);
      fake.calls.push('setWebAudioPlugins');
    },
    detach: (): void => {
      fake.detachCalls += 1;
      fake.calls.push('detach');
    },
  };
  return fake;
}

function manualTrack(): { handle: RemoteTrackHandle; stream: MediaStream } {
  const stream = {} as MediaStream; // node has no MediaStream; identity is all the stub needs
  return { handle: { mediaStream: stream }, stream };
}

describe('voice client: subscribeRemote wiring', () => {
  it('routes subscribed remote audio into the spatial graph and detaches on unsubscribe/leave', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    h.client.subscribeRemote(spatial);

    const t1 = sdkTrack();
    h.room.emitTrackSubscribed(t1.handle, 'alice');
    expect(spatial.participantIds).toEqual(['alice']);

    h.room.emitParticipantDisconnected('alice');
    expect(spatial.participantIds).toEqual([]);
  });

  it('trackUnsubscribed also detaches; room loss disposes the whole graph', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    h.client.subscribeRemote(spatial);

    const t1 = manualTrack();
    h.room.emitTrackSubscribed(t1.handle, 'bob');
    h.room.emitTrackUnsubscribed(t1.handle, 'bob');
    expect(spatial.participantIds).toEqual([]);

    h.room.emitTrackSubscribed(t1.handle, 'carol');
    h.room.emitDisconnected();
    expect(spatial.participantIds).toEqual([]); // disposed
  });

  it('a re-subscription for an attached participant REPLACES the stale chain (reconnect tolerance)', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    h.client.subscribeRemote(spatial);

    const t1 = sdkTrack();
    h.room.emitTrackSubscribed(t1.handle, 'alice');
    // LiveKit re-fires TrackSubscribed after a full reconnect: the fresh
    // handle must replace the stale chain, not trip the 'already attached'
    // guard into a contained error that would leave a dead chain attached.
    const t2 = sdkTrack();
    h.room.emitTrackSubscribed(t2.handle, 'alice');
    expect(h.errors).toHaveLength(0);
    expect(spatial.participantIds).toEqual(['alice']);
    expect(t1.detachCalls).toBe(1); // the stale chain was torn down first
    expect(t2.calls).toEqual(['attach', 'setWebAudioPlugins']); // fresh chain, SDK order kept

    h.room.emitParticipantDisconnected('alice');
    expect(spatial.participantIds).toEqual([]);
  });

  it('reconnected rebuilds every tracked chain and never resurrects a departed participant', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    h.client.subscribeRemote(spatial);

    const t1 = sdkTrack();
    h.room.emitTrackSubscribed(t1.handle, 'alice');
    h.room.emitTrackSubscribed(sdkTrack().handle, 'bob');
    h.room.emitParticipantDisconnected('bob'); // left before the reconnect

    h.room.emitReconnected();
    expect(spatial.participantIds).toEqual(['alice']); // bob is not resurrected
    expect(t1.detachCalls).toBe(1); // stale chain dropped …
    expect(t1.attachCalls).toBe(2); // … and rebuilt from the recorded handle (SDK re-attach)
    // teardown (detach + plugin clear) then the fresh attach → plugins order
    expect(t1.calls.slice(-4)).toEqual(['detach', 'setWebAudioPlugins', 'attach', 'setWebAudioPlugins']);
    expect(t1.pluginCalls[1]).toEqual([]); // the clear step carried no nodes
  });

  it('client.disconnect() disposes the spatial graph (no leaked chain on teardown)', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    h.client.subscribeRemote(spatial);
    h.room.emitTrackSubscribed(sdkTrack().handle, 'alice');
    expect(spatial.participantIds).toEqual(['alice']);

    await h.client.disconnect();
    expect(spatial.participantIds).toEqual([]); // disposed alongside the room
    expect(h.errors).toHaveLength(0);
  });

  it('unsubscribe removes the wiring (no spatial calls afterwards)', async () => {
    const h = makeVoiceHarness();
    await connectHarness(h);
    const spatial = createSpatialAudio({ contextFactory: () => h.context });
    const off = h.client.subscribeRemote(spatial);
    off();
    h.room.emitTrackSubscribed(sdkTrack().handle, 'late');
    expect(spatial.participantIds).toEqual([]);
  });

  it('subscribeRemote before connect throws', () => {
    const client = createVoiceClient();
    const spatial = createSpatialAudio({ contextFactory: () => new FakeAudioContext() });
    expect(() => client.subscribeRemote(spatial)).toThrow('connect()');
  });
});

// ---------------------------------------------------------------------------
// The spatial audio graph (graph assertions only — no ears in CI)
// ---------------------------------------------------------------------------

describe('spatial audio graph (shared AudioContext seam)', () => {
  it('attaches via the SDK-plugin path: attach() FIRST, then the panner — the SDK builds the graph', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    const t = sdkTrack();
    spatial.attachParticipant('p1', t.handle);

    // The load-bearing order [MEASURED, livekit-client 2.22.2]:
    // setWebAudioPlugins only builds the SDK graph for ATTACHED elements, so
    // attach must land before the panner is handed over — the reverse order
    // stores the panner and produces silence.
    expect(t.calls).toEqual(['attach', 'setWebAudioPlugins']);
    expect(t.attachCalls).toBe(1);

    expect(context.createdPanners).toHaveLength(1);
    const panner = context.createdPanners[0]!;
    expect(panner.panningModel).toBe('HRTF'); // the stated panner model
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBe(PANNER_REF_DISTANCE_M);
    expect(panner.rolloffFactor).toBe(PANNER_ROLLOFF_FACTOR);
    expect(panner.coneInnerAngle).toBe(360); // omnidirectional source
    // The SDK owns the chain: exactly one node handed over, no self-wiring.
    expect(t.pluginCalls).toEqual([[panner]]);
    expect(panner.connections).toEqual([]);
  });

  it('a setWebAudioPlugins handle without attach/detach is refused (the wiring that produced silence)', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    expect(() =>
      spatial.attachParticipant('p1', {
        setWebAudioPlugins: (nodes) => {
          void nodes;
        },
      }),
    ).toThrow('attached elements');
  });

  it('attaches via the manual fallback when the track exposes only a mediaStream', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    const t = manualTrack();
    spatial.attachParticipant('p1', t.handle);

    const panner = context.createdPanners[0]!;
    expect(context.createdSources).toHaveLength(1);
    const source = context.createdSources[0]!;
    expect(source.stream).toBe(t.stream); // the track's own stream
    expect(source.node.connections).toEqual([panner]); // source → panner
    expect(panner.connections).toEqual([context.destination]); // panner → destination
  });

  it('a track with neither attach path is refused loudly', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    expect(() => spatial.attachParticipant('p1', {})).toThrow('neither setWebAudioPlugins nor mediaStream');
  });

  it('setParticipantPose writes the panner position params exactly', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    spatial.attachParticipant('p1', sdkTrack().handle);
    spatial.setParticipantPose('p1', { x: 10.5, y: -2, z: 3000 });
    const panner = context.createdPanners[0]!;
    expect(panner.positionX.value).toBe(10.5);
    expect(panner.positionY.value).toBe(-2);
    expect(panner.positionZ.value).toBe(3000);
  });

  it('setListenerPose drives all nine listener params from the camera rig', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    // Z-up world (COORDINATE_SYSTEM.md §8); forward/up are unit vectors.
    spatial.setListenerPose({ x: 1, y: 2, z: 3 }, { x: 0.6, y: 0, z: -0.8 }, { x: 0, y: 0, z: 1 });
    const l = context.listener;
    expect(l.positionX.value).toBe(1);
    expect(l.positionY.value).toBe(2);
    expect(l.positionZ.value).toBe(3);
    expect(l.forwardX.value).toBe(0.6);
    expect(l.forwardY.value).toBe(0);
    expect(l.forwardZ.value).toBe(-0.8);
    expect(l.upX.value).toBe(0);
    expect(l.upY.value).toBe(0);
    expect(l.upZ.value).toBe(1);
  });

  it('detachParticipant: SDK path detaches the SDK element/graph and clears the plugin chain; manual path disconnects its nodes', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });

    const t1 = sdkTrack();
    spatial.attachParticipant('sdk', t1.handle);
    spatial.detachParticipant('sdk');
    expect(t1.pluginCalls).toEqual([[context.createdPanners[0]], []]); // attach, then cleared
    expect(t1.detachCalls).toBe(1); // the SDK element + graph were dropped too
    expect(t1.calls.slice(-2)).toEqual(['detach', 'setWebAudioPlugins']); // graph first, then clear

    const t2 = manualTrack();
    spatial.attachParticipant('manual', t2.handle);
    const panner2 = context.createdPanners[1]!;
    // The SDK-path participant above created no source node, so the manual
    // one is the FIRST source in the recording.
    const source2 = context.createdSources[0]!;
    spatial.detachParticipant('manual');
    expect(source2.node.disconnectCalls).toBe(1);
    expect(panner2.disconnectCalls).toBe(1);
    expect(source2.node.connections).toEqual([]);
  });

  it('unknown ids are caller bugs and throw', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context });
    expect(() => spatial.detachParticipant('ghost')).toThrow('ghost');
    expect(() => spatial.setParticipantPose('ghost', { x: 0, y: 0, z: 0 })).toThrow('ghost');
  });

  it('dispose detaches everyone and the instance stays usable', () => {
    const context = new FakeAudioContext();
    const spatial: SpatialAudio = createSpatialAudio({ contextFactory: () => context });
    const t1 = sdkTrack();
    spatial.attachParticipant('a', t1.handle);
    spatial.attachParticipant('b', manualTrack().handle);
    spatial.dispose();
    expect(spatial.participantIds).toEqual([]);
    // Reusable after disposal (e.g. rejoin after room loss).
    spatial.attachParticipant('a', t1.handle);
    expect(spatial.participantIds).toEqual(['a']);
  });

  it('equalpower is selectable as the low-end panner fallback', () => {
    const context = new FakeAudioContext();
    const spatial = createSpatialAudio({ contextFactory: () => context, panningModel: 'equalpower' });
    spatial.attachParticipant('p', sdkTrack().handle);
    expect(context.createdPanners[0]!.panningModel).toBe('equalpower');
    expect(spatial.panningModel).toBe('equalpower');
  });

  it('getSharedAudioContext refuses to run outside a browser (tests inject instead)', () => {
    // Node has no AudioContext global: the singleton must throw here rather
    // than create anything. In a browser this IS the one shared context.
    expect(() => getSharedAudioContext()).toThrow('AudioContext is unavailable');
  });
});

// ---------------------------------------------------------------------------
// The livekit-client adapter, against a vi.mock'ed module (no real SDK)
// ---------------------------------------------------------------------------

const livekitFakes = vi.hoisted(() => {
  /** Stands in for RemoteAudioTrack: records the attach/plugin/detach calls the adapter delegates. */
  class FakeRemoteAudioTrack {
    kind = 'audio';
    attachCalls = 0;
    detachCalls = 0;
    pluginCalls: unknown[][] = [];
    /** Cross-method call order — the attach→setWebAudioPlugins ordering reads this. */
    calls: string[] = [];
    mediaStream: MediaStream | undefined;
    constructor(mediaStream?: MediaStream) {
      this.mediaStream = mediaStream;
    }
    attach(): HTMLMediaElement {
      this.attachCalls += 1;
      this.calls.push('attach');
      return {} as HTMLMediaElement;
    }
    detach(): HTMLMediaElement[] {
      this.detachCalls += 1;
      this.calls.push('detach');
      return [];
    }
    setWebAudioPlugins(nodes: unknown[]): void {
      this.pluginCalls.push(nodes);
      this.calls.push('setWebAudioPlugins');
    }
  }

  /** A remote track that is NOT a RemoteAudioTrack — for the instanceof filter. */
  class FakeRemoteTrack {}

  interface FakeRoomRecord {
    options: unknown;
    connectCalls: Array<{ url: string; token: string }>;
    startAudioCalls: number;
    disconnectCalls: number;
    micCalls: Array<{ enabled: boolean; options: unknown; publishOptions: unknown }>;
    listeners: Map<string, Array<(...args: unknown[]) => void>>;
    emit(event: string, ...args: unknown[]): void;
  }

  const rooms: FakeRoomRecord[] = [];

  /** Stands in for the livekit Room class: records options, listeners and calls. */
  class FakeRoom implements FakeRoomRecord {
    options: unknown;
    connectCalls: Array<{ url: string; token: string }> = [];
    startAudioCalls = 0;
    disconnectCalls = 0;
    micCalls: Array<{ enabled: boolean; options: unknown; publishOptions: unknown }> = [];
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(options: unknown) {
      this.options = options;
      rooms.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      let list = this.listeners.get(event);
      if (list === undefined) {
        list = [];
        this.listeners.set(event, list);
      }
      list.push(handler);
      return this;
    }
    off(event: string, handler: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event);
      if (list === undefined) return;
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    }
    // The record IS the room: the adapter calls connect/startAudio/disconnect
    // and localParticipant.setMicrophoneEnabled on the instance.
    async connect(url: string, token: string): Promise<void> {
      this.connectCalls.push({ url, token });
    }
    async startAudio(): Promise<void> {
      this.startAudioCalls += 1;
    }
    async disconnect(): Promise<void> {
      this.disconnectCalls += 1;
    }
    readonly localParticipant = {
      setMicrophoneEnabled: (enabled: boolean, options?: unknown, publishOptions?: unknown): Promise<void> => {
        this.micCalls.push({ enabled, options, publishOptions });
        return Promise.resolve();
      },
    };
    /** Drive the registered LiveKit-side listeners (the adapter's mappings). */
    emit(event: string, ...args: unknown[]): void {
      for (const h of [...(this.listeners.get(event) ?? [])]) h(...args);
    }
  }

  // String values match the real RoomEvent/Track.Kind enums (dist/src/room/events.d.ts).
  const RoomEvent = {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  } as const;
  const Track = { Kind: { Audio: 'audio', Video: 'video', Data: 'data' } } as const;
  const AudioPresets = { speech: { name: 'speech', maxBitrate: 24000 } } as const;

  return { rooms, FakeRoom, FakeRemoteAudioTrack, FakeRemoteTrack, RoomEvent, Track, AudioPresets };
});

vi.mock('livekit-client', () => ({
  Room: livekitFakes.FakeRoom,
  RoomEvent: livekitFakes.RoomEvent,
  Track: livekitFakes.Track,
  AudioPresets: livekitFakes.AudioPresets,
  RemoteAudioTrack: livekitFakes.FakeRemoteAudioTrack,
}));

describe('voice client: LiveKit 2.22.2 adapter (mocked module)', () => {
  // The hoisted fake module records into module-level arrays; each test
  // creates its own adapter room, so reset before each one.
  beforeEach(() => {
    livekitFakes.rooms.length = 0;
  });

  function makeAudioTrack(): InstanceType<typeof livekitFakes.FakeRemoteAudioTrack> {
    return new livekitFakes.FakeRemoteAudioTrack({} as MediaStream);
  }

  it('constructs the Room with the injected AudioContext (no SDK-minted context) and the speech publish defaults', async () => {
    const context = new FakeAudioContext();
    await createLiveKitRoom(context);
    const lk = livekitFakes.rooms[0]!;
    const options = lk.options as {
      webAudioMix: { audioContext: unknown };
      publishDefaults: { audioPreset: unknown; dtx: unknown; red: unknown };
    };
    expect(options.webAudioMix.audioContext).toBe(context); // OUR singleton — the one-context invariant
    expect(options.publishDefaults).toEqual({
      audioPreset: livekitFakes.AudioPresets.speech, // 24 kbps Opus — never the music preset
      dtx: true,
      red: false,
    });
  });

  it('maps connect/startAudio onto the Room', async () => {
    const room = await createLiveKitRoom(new FakeAudioContext());
    await room.connect('wss://voice.example', 'opaque-token');
    await room.startAudio();
    const lk = livekitFakes.rooms[0]!;
    expect(lk.connectCalls).toEqual([{ url: 'wss://voice.example', token: 'opaque-token' }]);
    expect(lk.startAudioCalls).toBe(1);
  });

  it('publishMic/setMicMuted map onto setMicrophoneEnabled (publish+mute options; in-place mute for PTT)', async () => {
    const room = await createLiveKitRoom(new FakeAudioContext());
    await room.publishMic();
    await room.setMicMuted(true);
    await room.setMicMuted(false);
    const lk = livekitFakes.rooms[0]!;
    expect(lk.micCalls).toEqual([
      { enabled: true, options: undefined, publishOptions: { audioPreset: livekitFakes.AudioPresets.speech, dtx: true, red: false } },
      { enabled: false, options: undefined, publishOptions: undefined }, // mute in place — the PTT edge
      { enabled: true, options: undefined, publishOptions: undefined },
    ]);
  });

  it('maps TrackSubscribed/TrackUnsubscribed/ParticipantConnected/ParticipantDisconnected/Reconnected/Disconnected onto the seam, filtering non-audio and non-RemoteAudioTrack events', async () => {
    const room = await createLiveKitRoom(new FakeAudioContext());
    const subscribed: string[] = [];
    const unsubscribed: string[] = [];
    const connected: string[] = [];
    const disconnected: string[] = [];
    let reconnected = 0;
    let seamDisconnected = 0;
    room.on('trackSubscribed', (_track, participantId) => subscribed.push(participantId));
    room.on('trackUnsubscribed', (_track, participantId) => unsubscribed.push(participantId));
    room.on('participantConnected', (participantId) => connected.push(participantId));
    room.on('participantDisconnected', (participantId) => disconnected.push(participantId));
    room.on('reconnected', () => {
      reconnected += 1;
    });
    room.on('disconnected', () => {
      seamDisconnected += 1;
    });

    const lk = livekitFakes.rooms[0]!;
    const audio = makeAudioTrack();
    const participant = { identity: 'alice' };
    const publication = {};

    lk.emit(livekitFakes.RoomEvent.TrackSubscribed, audio, publication, participant);
    lk.emit(livekitFakes.RoomEvent.TrackUnsubscribed, audio, publication, participant);
    lk.emit(livekitFakes.RoomEvent.ParticipantConnected, participant);
    lk.emit(livekitFakes.RoomEvent.ParticipantDisconnected, participant);
    lk.emit(livekitFakes.RoomEvent.Reconnected);
    lk.emit(livekitFakes.RoomEvent.Disconnected);
    expect(subscribed).toEqual(['alice']);
    expect(unsubscribed).toEqual(['alice']);
    expect(connected).toEqual(['alice']);
    expect(disconnected).toEqual(['alice']);
    expect(reconnected).toBe(1);
    expect(seamDisconnected).toBe(1);

    // Filters: a RemoteAudioTrack of the wrong kind (video) and an audio
    // track that is not a RemoteAudioTrack instance both stay silent.
    const video = new livekitFakes.FakeRemoteAudioTrack();
    video.kind = 'video';
    lk.emit(livekitFakes.RoomEvent.TrackSubscribed, video, publication, participant);
    lk.emit(livekitFakes.RoomEvent.TrackSubscribed, Object.assign(new livekitFakes.FakeRemoteTrack(), { kind: 'audio' }), publication, participant);
    expect(subscribed).toEqual(['alice']);
  });

  it('the track handle exposes attach BEFORE setWebAudioPlugins works — the ordering that connects the SDK graph', async () => {
    const room = await createLiveKitRoom(new FakeAudioContext());
    const captured: Array<{ track: RemoteTrackHandle; participantId: string }> = [];
    room.on('trackSubscribed', (track, participantId) => captured.push({ track, participantId }));
    const lk = livekitFakes.rooms[0]!;
    const audio = makeAudioTrack();
    lk.emit(livekitFakes.RoomEvent.TrackSubscribed, audio, {}, { identity: 'alice' });

    const handle = captured[0]!.track;
    expect(handle.mediaStream).toBe(audio.mediaStream); // manual fallback passthrough

    // Driven in the order spatial.ts uses (attach → plugins → detach), the
    // underlying RemoteAudioTrack must see exactly that sequence: attach
    // first populates attachedElements — the precondition that makes the
    // SDK's connectWebAudio actually build source → panner → gain →
    // destination when the plugins arrive.
    handle.attach?.();
    handle.setWebAudioPlugins?.([makePanner()]);
    handle.detach?.();
    expect(audio.calls).toEqual(['attach', 'setWebAudioPlugins', 'detach']);
    expect(audio.pluginCalls).toHaveLength(1); // our panner reached the SDK
    expect(audio.pluginCalls[0]).toEqual([expect.objectContaining({ panningModel: 'HRTF' })]);
  });

  it('room disconnect unbinds the LiveKit listeners (no seam events after teardown)', async () => {
    const room = await createLiveKitRoom(new FakeAudioContext());
    let events = 0;
    room.on('disconnected', () => {
      events += 1;
    });
    room.on('participantConnected', () => {
      events += 1;
    });
    const lk = livekitFakes.rooms[0]!;
    await room.disconnect();
    lk.emit(livekitFakes.RoomEvent.Disconnected);
    lk.emit(livekitFakes.RoomEvent.ParticipantConnected, { identity: 'late' });
    expect(events).toBe(0);
    expect(lk.disconnectCalls).toBe(1);
  });
});
