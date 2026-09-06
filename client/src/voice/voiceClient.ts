/**
 * Kwetu voice — LiveKit client groundwork (pinned livekit-client 2.22.2,
 * NETWORKING.md §10/§12).
 *
 * THE AEC TRAP IS A PRODUCT RULE (ADR-012 D10, NETWORKING.md §11): Chromium
 * does not feed WebAudio output into the echo canceller (upstream issues
 * 121673 / 686665), and Kwetu's remote voices MUST leave through the WebAudio
 * spatialization chain (spatial.ts). Therefore:
 *
 *   1. Push-to-talk is the DEFAULT for every player, platform and session.
 *      Open mic is OPT-IN per player and carries a UI warning — the future
 *      UI shell owns that copy (EN + sw) and the warning; this module only
 *      makes the safe path the default.
 *   2. Nothing here re-enables open mic by default, ever. `publishMic(false)`
 *      is the explicit opt-in API — the UI calling it IS the consent record
 *      (ADR-012 D5/D10: the PTT keypress is per-transmission consent).
 *   3. Headphones are the honest recommendation at voice setup (with them the
 *      trap disappears); that copy belongs to the UI shell.
 *
 * THE USER-GESTURE CONTRACT (NETWORKING.md §10, [MEASURED 2026-09-06,
 * livekit-client 2.22.2 Room.startAudio docblock]): browsers keep audio
 * silent until interaction. `connect(liveKitUrl, token)` MUST be called from
 * a user-gesture handler (the "join voice" button), never from a network
 * callback. connect() performs the gesture-gated operation FIRST, before its
 * first await: it creates the shared AudioContext (spatial.ts singleton) and
 * calls `resume()` synchronously inside the gesture, then connects, then
 * calls `room.startAudio()` — the LiveKit autoplay rule — to unblock any
 * media elements LiveKit attached. `publishMic()` should run in the same
 * gesture (the microphone permission prompt wants one).
 *
 * Bandwidth posture (NETWORKING.md §10): the SPEECH preset (24 kbps Opus)
 * with DTX on — never the music preset — and RED off: East-African mobile
 * links and the TURN-relayed share are exactly the "bandwidth matters" case,
 * and the mute/interpolation policy absorbs the lost packet. [PLACEHOLDER —
 * gate: Phase 6 re-measures the preset on real links.]
 *
 * Auth: the client only RECEIVES a token — the Nakama Go runtime is the only
 * minting authority (NETWORKING.md §10). No JWT handling lives here.
 *
 * TURN/CGNAT reality: media-over-TLS relay behaviour is UNTESTED until
 * deploy against a real domain (NETWORKING.md §2/§10, infra open item) —
 * nothing in this module assumes UDP reachability.
 *
 * Test seam: `VoiceRoom` is the structural seam over the LiveKit Room and
 * `RemoteTrackHandle` (spatial.ts) the seam over RemoteAudioTrack. Tests
 * inject a room factory and an AudioContext factory — no network, no
 * WebAudio in vitest (node has neither).
 */

import { getSharedAudioContext, type AudioContextLike, type RemoteTrackHandle, type SpatialAudio } from './spatial';

/**
 * Events the voice client cares about, as the `VoiceRoom` seam surfaces
 * them (framework-free; the adapter maps LiveKit's enums onto these).
 */
export interface VoiceRoomEvents {
  /** A remote AUDIO track was subscribed. (Video/data tracks are filtered out by the adapter.) */
  trackSubscribed: (track: RemoteTrackHandle, participantId: string) => void;
  /** A previously subscribed remote audio track went away. */
  trackUnsubscribed: (track: RemoteTrackHandle, participantId: string) => void;
  participantConnected: (participantId: string) => void;
  participantDisconnected: (participantId: string) => void;
  /** LiveKit completed its own reconnection. */
  reconnected: () => void;
  /** The room is gone (server kick, network death after LiveKit's retry budget). */
  disconnected: () => void;
}

export type VoiceRoomEvent = keyof VoiceRoomEvents;

/**
 * The room seam. One method per operation the voice client drives; the
 * production adapter maps them onto LocalParticipant.setMicrophoneEnabled —
 * which, on an already-published mic track, MUTES/UNMUTES rather than
 * republishing [MEASURED 2026-09-06, 2.22.2 .d.ts docblock] — exactly the
 * push-to-talk pattern.
 */
export interface VoiceRoom {
  connect(url: string, token: string): Promise<void>;
  /** Unblock audio playback; must follow a gesture-context connect (module docblock). */
  startAudio(): Promise<void>;
  disconnect(): Promise<void>;
  /** Publish the local microphone with the speech preset (24 kbps Opus, DTX on, RED off). */
  publishMic(): Promise<void>;
  /** Mute/unmute the published mic track without unpublishing (push-to-talk edge). */
  setMicMuted(muted: boolean): Promise<void>;
  on<K extends VoiceRoomEvent>(event: K, handler: VoiceRoomEvents[K]): () => void;
}

/** Voice client lifecycle states. 'failed' is a connect() that rejected. */
export type VoiceState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected';

export interface VoiceClientOptions {
  /** Room factory. Default: the production LiveKit adapter. Tests inject a fake. */
  roomFactory?: ((context: AudioContextLike) => Promise<VoiceRoom>) | undefined;
  /** AudioContext factory. Default: the spatial.ts singleton. Tests inject stubs. */
  contextFactory?: (() => AudioContextLike) | undefined;
}

export interface VoiceClient {
  readonly state: VoiceState;
  /** True while the mic track is published (capture is live). */
  readonly micPublished: boolean;
  /** True while the mic is TRANSMITTING (push-to-talk pressed, or open mic). */
  readonly transmitting: boolean;
  /**
   * The session's mic mode: true = push-to-talk (default), false = open-mic
   * opt-in. The UI must show the AEC warning whenever this is false
   * (ADR-012 D10).
   */
  readonly openMicOptIn: boolean;
  /**
   * Connect. MUST be called from a user-gesture handler — see the module
   * docblock for the exact gesture choreography this performs.
   */
  connect(liveKitUrl: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Publish the microphone. Default pushToTalk = true (ADR-012 D10): the
   * track is published MUTED and transmits only while `setPushToTalk(true)`
   * is held. `publishMic(false)` is the explicit open-mic opt-in.
   */
  publishMic(pushToTalk?: boolean): Promise<void>;
  /** Push-to-talk edge: active=true transmits, active=false mutes. Throws before publishMic(). */
  setPushToTalk(active: boolean): Promise<void>;
  /**
   * Route every subscribed remote audio track through `spatial` (the shared
   * AudioContext graph). Returns an unsubscribe. Spatial lifecycle, as
   * implemented here:
   * - room loss (LiveKit Disconnected) disposes the graph;
   * - `disconnect()` disposes it too (idempotent — room loss may already
   *   have);
   * - after the returned unsubscribe runs, the graph's lifecycle is the
   *   caller's again;
   * - a re-subscription for a still-attached participant (LiveKit re-fires
   *   TrackSubscribed after a full reconnect) REPLACES the stale chain
   *   instead of tripping the 'already attached' caller-bug guard;
   * - LiveKit's `reconnected` event rebuilds every tracked chain from the
   *   SDK's current track state, so no reconnect leaves a dead chain
   *   attached.
   * After a rejoin on a fresh client, call subscribeRemote again.
   */
  subscribeRemote(spatial: SpatialAudio): () => void;
  onStateChange(handler: (state: VoiceState) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
}

/** Build the voice client. Tests inject factories; production uses both singletons. */
export function createVoiceClient(options?: VoiceClientOptions): VoiceClient {
  const contextFactory = options?.contextFactory ?? getSharedAudioContext;
  const roomFactory = options?.roomFactory ?? createLiveKitRoom;

  const stateSet = new Set<(state: VoiceState) => void>();
  const errorSet = new Set<(error: Error) => void>();
  let state: VoiceState = 'idle';
  let room: VoiceRoom | undefined;
  let micPublished = false;
  let micMuted = true;
  let openMicOptIn = false;
  /** The spatial graph routed via subscribeRemote, for teardown on disconnect. */
  let subscribedSpatial: SpatialAudio | undefined;

  function setState(next: VoiceState): void {
    state = next;
    for (const h of [...stateSet]) {
      try {
        h(state);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function emitError(err: Error): void {
    for (const h of [...errorSet]) {
      try {
        h(err);
      } catch (err2) {
        console.error(err2);
      }
    }
  }

  const offRoom = new Set<() => void>();

  return {
    get state(): VoiceState {
      return state;
    },
    get micPublished(): boolean {
      return micPublished;
    },
    get transmitting(): boolean {
      return micPublished && !micMuted;
    },
    get openMicOptIn(): boolean {
      return openMicOptIn;
    },

    async connect(liveKitUrl: string, token: string): Promise<void> {
      if (liveKitUrl === '') throw new Error('liveKitUrl must not be empty');
      if (token === '') throw new Error('voice token must not be empty (the Go runtime mints it — NETWORKING.md §10)');
      if (state === 'connected' || state === 'connecting') throw new Error('voice client is already connected or connecting');
      // ---- gesture-critical section: everything before the first await ----
      const context = contextFactory(); // may CREATE the singleton — inside the gesture
      const resumePromise = context.resume(); // initiated synchronously inside the gesture
      setState('connecting');
      try {
        room = await roomFactory(context);
        await room.connect(liveKitUrl, token);
        // The resume was initiated in-gesture; settle it here (it must not
        // block the connect, and a rejection is non-fatal — startAudio is
        // the second chance).
        await resumePromise.then(
          () => undefined,
          () => undefined,
        );
        await room.startAudio();
      } catch (err) {
        setState('failed');
        throw err;
      }
      setState('connected');
    },

    async disconnect(): Promise<void> {
      // Capture BEFORE unbinding: the unbind loop runs the subscribeRemote
      // unsubscribe closure, which hands graph ownership back to the caller.
      const spatialToDispose = subscribedSpatial;
      subscribedSpatial = undefined;
      for (const off of offRoom) off();
      offRoom.clear();
      micPublished = false;
      micMuted = true;
      openMicOptIn = false;
      // The spatial graph belongs to this session: dispose it here too (the
      // room-loss path may already have — dispose() is idempotent).
      if (spatialToDispose !== undefined) {
        try {
          spatialToDispose.dispose();
        } catch (err) {
          emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      const r = room;
      room = undefined;
      if (r !== undefined) {
        try {
          await r.disconnect();
        } catch (err) {
          emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      setState('disconnected');
    },

    async publishMic(pushToTalk = true): Promise<void> {
      const r = room;
      if (r === undefined) throw new Error('cannot publish the microphone before connect()');
      // Publish, then the initial mute, and ONLY THEN reflect the mode in
      // client state: a rejection must not leave micPublished/openMicOptIn/
      // micMuted claiming a posture the room never confirmed.
      await r.publishMic();
      try {
        await r.setMicMuted(pushToTalk); // push-to-talk: published but silent until the key is held
      } catch (err) {
        // The track is live in the room but its initial mute failed — the
        // one state that must never silently stand (an open mic the UI
        // shows as push-to-talk). Best-effort force the safe mute, then
        // surface the failure; client state stays unpublished/unopted-in.
        await r.setMicMuted(true).catch(() => undefined);
        throw err;
      }
      micPublished = true;
      openMicOptIn = !pushToTalk;
      micMuted = pushToTalk;
    },

    async setPushToTalk(active: boolean): Promise<void> {
      const r = room;
      if (r === undefined || !micPublished) throw new Error('setPushToTalk before publishMic() — call publishMic() in the join-voice gesture');
      // Same rule as publishMic: the client-side mute flag moves only after
      // the room confirmed it, so a rejection cannot desync the two.
      await r.setMicMuted(!active);
      micMuted = !active;
    },

    subscribeRemote(spatial: SpatialAudio): () => void {
      const r = room;
      if (r === undefined) throw new Error('cannot subscribe remote audio before connect()');
      const offs: Array<() => void> = [];
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          emitError(err instanceof Error ? err : new Error(String(err)));
        }
      };
      /** Latest track handle per subscribed participant — what a reconnect rebuilds from. */
      const subscribed = new Map<string, RemoteTrackHandle>();
      const detachIfAttached = (participantId: string): void => {
        if (spatial.participantIds.includes(participantId)) spatial.detachParticipant(participantId);
      };
      subscribedSpatial = spatial;
      offs.push(
        r.on('trackSubscribed', (track, participantId) =>
          guard(() => {
            // Re-attach tolerance: LiveKit re-fires TrackSubscribed after a
            // full reconnect. Replace the stale chain (a dead MediaStream
            // chain must not survive under a contained 'already attached'
            // error) instead of tripping the caller-bug guard. detachIf-
            // Attached, not a bare detach: a prior attach may have failed
            // and left the map entry without a live chain.
            if (subscribed.has(participantId)) detachIfAttached(participantId);
            subscribed.set(participantId, track);
            spatial.attachParticipant(participantId, track);
          }),
        ),
      );
      offs.push(
        r.on('trackUnsubscribed', (_track, participantId) =>
          guard(() => {
            subscribed.delete(participantId);
            detachIfAttached(participantId);
          }),
        ),
      );
      offs.push(
        r.on('participantDisconnected', (participantId) =>
          guard(() => {
            subscribed.delete(participantId);
            detachIfAttached(participantId);
          }),
        ),
      );
      offs.push(
        r.on('reconnected', () =>
          guard(() => {
            // LiveKit completed its own reconnect. Rebuild every tracked
            // chain from the SDK's current track state: on a full reconnect
            // the SDK re-creates subscriptions (a fresh TrackSubscribed
            // re-attaches through the handler above), but a signal-resume
            // reconnect keeps the old subscription objects — a rebuild here
            // is what guarantees no dead chain survives either path.
            // Unknown/unsubscribed participants are not resurrected: the
            // map only holds what is still subscribed.
            for (const [participantId, track] of [...subscribed]) {
              detachIfAttached(participantId);
              spatial.attachParticipant(participantId, track);
            }
          }),
        ),
      );
      offs.push(
        r.on('disconnected', () =>
          guard(() => {
            subscribed.clear();
            spatial.dispose();
          }),
        ),
      );
      const unsubscribe = (): void => {
        for (const off of offs) off();
        offRoom.delete(unsubscribe);
        // Ownership returns to the caller: the client no longer disposes
        // this graph on room loss/disconnect (an active subscription is
        // what it tears down).
        if (subscribedSpatial === spatial) subscribedSpatial = undefined;
      };
      offRoom.add(unsubscribe);
      return unsubscribe;
    },

    onStateChange(handler: (state: VoiceState) => void): () => void {
      stateSet.add(handler);
      return () => stateSet.delete(handler);
    },

    onError(handler: (error: Error) => void): () => void {
      errorSet.add(handler);
      return () => errorSet.delete(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Production adapter: livekit-client 2.22.2 (dynamically imported).
// ---------------------------------------------------------------------------

type LiveKitModule = typeof import('livekit-client');
type LiveKitRoomCallbacks = import('livekit-client').RoomEventCallbacks;
type LiveKitRemoteAudioTrack = import('livekit-client').RemoteAudioTrack;

/**
 * Publish posture per NETWORKING.md §10: DTX on, RED off, with the SPEECH
 * preset (24 kbps Opus — never music) supplied from the SDK's AudioPresets
 * below. [PLACEHOLDER — gate: Phase 6 re-measures on real links.]
 */
const MIC_PUBLISH_OPTIONS = {
  dtx: true,
  red: false,
} as const;

/**
 * Adapt a real LiveKit Room to the VoiceRoom seam.
 *
 * [MEASURED 2026-09-06, livekit-client 2.22.2 .d.ts/source]:
 * - `Room({ webAudioMix: { audioContext } })` is the pinned option name that
 *   hands LiveKit OUR singleton context (`RoomOptions.webAudioMix: boolean |
 *   WebAudioSettings`, `WebAudioSettings.audioContext`); with a boolean
 *   `webAudioMix` the Room creates its OWN AudioContext — forbidden by the
 *   CLAUDE.md one-context invariant.
 * - Remote audio reaches our graph via the SDK-plugin path, in a fixed
 *   order: `RemoteAudioTrack.attach()` FIRST — it populates the SDK's
 *   `attachedElements` (the only state that makes `connectWebAudio` run)
 *   and, with webAudioMix enabled, mutes the element the SDK creates so
 *   audio flows through WebAudio only — and THEN
 *   `RemoteAudioTrack.setWebAudioPlugins` (@internal/@experimental —
 *   NETWORKING.md §14 gate), which rebuilds the SDK graph with our nodes.
 *   `RemoteTrackHandle.detach()` maps to `track.detach()` (drops the
 *   element and the graph). `Track.mediaStream` (on the Track base class,
 *   optional) stays as the manual fallback. [MEASURED 2026-09-06, 2.22.2
 *   dist source: setWebAudioPlugins builds nothing while
 *   `attachedElements.length === 0`, and nothing else populates it.]
 * - `setMicrophoneEnabled(enabled, options?, publishOptions?)` captures and
 *   publishes; on a published track it mutes/unmutes.
 * - `Room.startAudio()` exists exactly for the autoplay rule.
 * - `Room` is a TypedEmitter: `.on(event, listener)` returns the Room (not
 *   an unsubscribe), so listeners are removed via `.off(event, listener)`.
 *
 * The single `as unknown as AudioContext` below is the module's only seam
 * bridge: `context` is the real AudioContext wrapped by spatial.ts's
 * `AudioContextLike`; LiveKit needs the DOM type.
 */
export async function createLiveKitRoom(context: AudioContextLike): Promise<VoiceRoom> {
  const livekit: LiveKitModule = await import('livekit-client');
  const lkRoom = new livekit.Room({
    webAudioMix: { audioContext: context as unknown as AudioContext },
    publishDefaults: {
      audioPreset: livekit.AudioPresets.speech,
      dtx: MIC_PUBLISH_OPTIONS.dtx,
      red: MIC_PUBLISH_OPTIONS.red,
    },
  });

  // Mapped type so `handlerSets[event]` narrows to the handler's own set
  // under the generic `on<K>` below.
  const handlerSets: { [K in VoiceRoomEvent]: Set<VoiceRoomEvents[K]> } = {
    trackSubscribed: new Set(),
    trackUnsubscribed: new Set(),
    participantConnected: new Set(),
    participantDisconnected: new Set(),
    reconnected: new Set(),
    disconnected: new Set(),
  };

  const offs: Array<() => void> = [];
  const listen = <K extends keyof LiveKitRoomCallbacks>(event: K, handler: LiveKitRoomCallbacks[K]): void => {
    lkRoom.on(event, handler);
    offs.push(() => {
      lkRoom.off(event, handler);
    });
  };

  const trackHandle = (track: LiveKitRemoteAudioTrack): RemoteTrackHandle => ({
    // Order contract (spatial.ts): attach() BEFORE setWebAudioPlugins() —
    // the SDK's connectWebAudio runs only for attached elements [MEASURED].
    attach: (): void => {
      // Creates (or recycles) the SDK's audio element; with webAudioMix
      // enabled the SDK mutes it and routes audio through WebAudio only.
      track.attach();
    },
    setWebAudioPlugins: (nodes) => {
      // Seam bridge: our AudioNodeLike[] ARE real AudioNodes on this path.
      track.setWebAudioPlugins(nodes as unknown as AudioNode[]);
    },
    detach: (): void => {
      // Detaches all SDK elements and disconnects the SDK-built graph.
      track.detach();
    },
    mediaStream: track.mediaStream,
  });

  listen(livekit.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== livekit.Track.Kind.Audio) return; // audio-only seam; video is not ours
    if (!(track instanceof livekit.RemoteAudioTrack)) return;
    for (const h of handlerSets.trackSubscribed) h(trackHandle(track), participant.identity);
  });
  listen(livekit.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    if (!(track instanceof livekit.RemoteAudioTrack)) return;
    for (const h of handlerSets.trackUnsubscribed) h(trackHandle(track), participant.identity);
  });
  listen(livekit.RoomEvent.ParticipantConnected, (participant) => {
    for (const h of handlerSets.participantConnected) h(participant.identity);
  });
  listen(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
    for (const h of handlerSets.participantDisconnected) h(participant.identity);
  });
  listen(livekit.RoomEvent.Reconnected, () => {
    for (const h of handlerSets.reconnected) h();
  });
  listen(livekit.RoomEvent.Disconnected, () => {
    for (const h of handlerSets.disconnected) h();
  });

  return {
    async connect(url: string, token: string): Promise<void> {
      await lkRoom.connect(url, token);
    },
    async startAudio(): Promise<void> {
      await lkRoom.startAudio();
    },
    async disconnect(): Promise<void> {
      for (const off of offs) off();
      await lkRoom.disconnect();
    },
    async publishMic(): Promise<void> {
      await lkRoom.localParticipant.setMicrophoneEnabled(true, undefined, {
        audioPreset: livekit.AudioPresets.speech,
        dtx: MIC_PUBLISH_OPTIONS.dtx,
        red: MIC_PUBLISH_OPTIONS.red,
      });
    },
    async setMicMuted(muted: boolean): Promise<void> {
      // On a published mic track this mutes/unmutes in place
      // [MEASURED 2026-09-06, 2.22.2 .d.ts docblock] — the PTT pattern.
      await lkRoom.localParticipant.setMicrophoneEnabled(!muted);
    },
    on<K extends VoiceRoomEvent>(event: K, handler: VoiceRoomEvents[K]): () => void {
      const set: Set<VoiceRoomEvents[K]> = handlerSets[event];
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
}
