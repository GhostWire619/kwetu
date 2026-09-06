/**
 * Kwetu voice — spatial audio graph over the ONE shared AudioContext.
 *
 * Owns: the module-singleton `AudioContext` and the per-participant
 * spatialization chain (MediaStreamSource → PannerNode → destination), plus
 * the listener and participant pose setters the future camera rig drives.
 *
 * HARD INVARIANT (CLAUDE.md): **exactly one `AudioContext` for the whole
 * app.** `getSharedAudioContext()` is the only way anything in Kwetu may
 * create one. The future UI/mixer, the three.js scene audio, and LiveKit's
 * web-audio mixing must ALL use this context:
 *   - LiveKit gets it via `Room({ webAudioMix: { audioContext } })` — the
 *     pinned option name against livekit-client 2.22.2 is `webAudioMix:
 *     WebAudioSettings.audioContext` [MEASURED 2026-09-06,
 *     dist/src/options.d.ts]. Without it, LiveKit's `webAudioMix: true`
 *     creates its OWN context (2.22.2 source creates one exactly when the
 *     option is a boolean) — that is the trap this singleton exists to
 *     prevent.
 *   - three.js must be pointed at it via `THREE.AudioContext.setContext(...)`
 *     when the scene audio lands (Phase 3+), never allowed to create its own.
 * One context also means ONE resume/gesture to rule them all (voiceClient.ts
 * does that resume inside the user gesture).
 *
 * Panner model: **HRTF** (default) — 3D externalization on headphones is the
 * product goal, and the AEC-trap posture (below / NETWORKING.md §11)
 * already recommends headphones. Per-node CPU cost is unmeasured
 * [PLACEHOLDER — gate: Phase 6]; `panningModel: 'equalpower'` is available
 * through SpatialAudioOptions as a low-end fallback.
 *
 * Chain topology per subscribed remote participant — TWO paths:
 * 1. SDK-plugin path (preferred; the NETWORKING.md §10 verified hook):
 *    `RemoteAudioTrack.setWebAudioPlugins([panner])`. The SDK builds the
 *    MediaStream source itself and connects source → panner → its own gain
 *    → `context.destination`, and mutes the element it attached so audio
 *    reaches the ears only through WebAudio [MEASURED 2026-09-06,
 *    livekit-client 2.22.2 source, RemoteAudioTrack.connectWebAudio/attach].
 *    PRECONDITION (same source, `setWebAudioPlugins`): the SDK only
 *    (re)builds that graph while `attachedElements.length > 0 &&
 *    audioContext` — and `attachedElements` is populated exclusively by
 *    `Track.attach()`. `attachParticipant` therefore calls `attach()`
 *    BEFORE `setWebAudioPlugins()` and refuses a handle that cannot attach:
 *    handing the panner to an unattached track stores it and builds NO
 *    graph — silence. The hook is `@internal`/`@experimental` upstream —
 *    pinned at 2.22.2, expected to need forking (NETWORKING.md §14 gate).
 *    The panner is therefore NOT connected to the destination by us on this
 *    path.
 * 2. Manual fallback (when the SDK hook is absent): we create the
 *    MediaStreamAudioSourceNode from the track's `mediaStream` and connect
 *    source → panner → `context.destination` ourselves.
 *
 * The Chromium AEC trap is a product rule, not a bug to fix here (ADR-012
 * D10, NETWORKING.md §11): Chromium's echo canceller never hears WebAudio
 * output, so remote voices leaving this graph re-enter any open mic. The
 * consequence is enforced upstream in voiceClient.ts — push-to-talk by
 * default, open mic opt-in only. This module adds nothing that could
 * re-enable open mic.
 *
 * Test seam: every WebAudio type here is a minimal structural interface
 * (`AudioContextLike`, `PannerNodeLike`, …). Tests inject a factory that
 * returns stubs — vitest runs in node, which has no WebAudio. The one real
 * context is born inside `getSharedAudioContext()` in a browser.
 */

/** Minimal structural AudioParam — only `.value` is driven (per-frame direct assignment, the three.js pattern). */
export interface AudioParamLike {
  value: number;
}

/** Minimal structural AudioNode — just graph wiring. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

export interface PannerNodeLike extends AudioNodeLike {
  panningModel: PanningModelType;
  distanceModel: DistanceModelType;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  coneInnerAngle: number;
  coneOuterAngle: number;
  coneOuterGain: number;
  positionX: AudioParamLike;
  positionY: AudioParamLike;
  positionZ: AudioParamLike;
}

export interface MediaStreamAudioSourceNodeLike extends AudioNodeLike {}

/** The nine AudioParams of WebAudio's AudioListener we drive. */
export interface AudioListenerLike {
  positionX: AudioParamLike;
  positionY: AudioParamLike;
  positionZ: AudioParamLike;
  forwardX: AudioParamLike;
  forwardY: AudioParamLike;
  forwardZ: AudioParamLike;
  upX: AudioParamLike;
  upY: AudioParamLike;
  upZ: AudioParamLike;
}

/** Minimal structural AudioContext — exactly what this module needs. */
export interface AudioContextLike {
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly listener: AudioListenerLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  createPanner(): PannerNodeLike;
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike;
}

/** A position in the frame the caller is working in (metres; Kwetu world is Z-up, COORDINATE_SYSTEM.md §8). */
export interface SpatialPose {
  x: number;
  y: number;
  z: number;
}

/**
 * What spatial.ts needs from a subscribed remote audio track. The livekit
 * adapter (voiceClient.ts) builds this from a `RemoteAudioTrack`.
 */
export interface RemoteTrackHandle {
  /**
   * Attach the track to an SDK-managed media element. REQUIRED on the
   * SDK-plugin path: LiveKit's web-audio graph is (re)built only while
   * `attachedElements.length > 0 && audioContext`, and `attachedElements`
   * is populated exclusively by `Track.attach()` [MEASURED 2026-09-06,
   * livekit-client 2.22.2 source]. With webAudioMix enabled the SDK mutes
   * the element it creates — audio flows through the WebAudio graph only.
   */
  attach?(): void;
  /**
   * LiveKit's verified web-audio hook (`@internal`/`@experimental` upstream,
   * pinned at 2.22.2). When present, the SDK owns the source node AND the
   * destination connection; we hand it our panner and touch nothing else.
   * MUST be called AFTER `attach()` (precondition above) — before that it
   * stores the nodes and builds nothing. Call with `[]` to clear on detach.
   */
  setWebAudioPlugins?: ((nodes: readonly AudioNodeLike[]) => void) | undefined;
  /**
   * Detach the SDK-managed element(s) and drop the SDK-built graph — the
   * `attach()` inverse (`RemoteAudioTrack.detach()` in the production
   * adapter). Required whenever `setWebAudioPlugins` is present.
   */
  detach?(): void;
  /** The track's MediaStream, for the manual source fallback. Optional even on real tracks. */
  mediaStream?: MediaStream | undefined;
}

export interface SpatialAudioOptions {
  /** Context factory. Default: the module singleton `getSharedAudioContext()`. Tests inject stubs. */
  contextFactory?: (() => AudioContextLike) | undefined;
  /** Panner model. Default 'HRTF'; 'equalpower' is the low-end fallback. */
  panningModel?: PanningModelType | undefined;
}

/** Panner distance-model defaults. [PLACEHOLDER — gate: Phase 6 tunes against real rooms] */
export const PANNER_REF_DISTANCE_M = 1;
export const PANNER_ROLLOFF_FACTOR = 1;

export interface SpatialAudio {
  readonly context: AudioContextLike;
  readonly panningModel: PanningModelType;
  /** Ids currently attached (subscribed). */
  readonly participantIds: readonly string[];
  /**
   * Build the spatial chain for a subscribed remote participant. Throws on
   * a duplicate id (a caller bug), a handle that offers `setWebAudioPlugins`
   * without `attach`/`detach` (the SDK builds its graph only for attached
   * elements — proceeding would be silent), or a handle with neither attach
   * path.
   */
  attachParticipant(participantId: string, track: RemoteTrackHandle): void;
  /** Tear the chain down. Unknown ids are a caller bug and throw. */
  detachParticipant(participantId: string): void;
  /** Move a participant's panner. Unknown ids are a caller bug and throw. */
  setParticipantPose(participantId: string, pos: SpatialPose): void;
  /** Drive the shared listener from the camera rig: position + orientation unit vectors. */
  setListenerPose(pos: SpatialPose, forward: SpatialPose, up: SpatialPose): void;
  /** Detach every participant (room loss, page teardown). The instance stays usable. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// The ONE shared AudioContext (module singleton).
// ---------------------------------------------------------------------------

let sharedContext: AudioContextLike | undefined;

/**
 * The app's single AudioContext. CLAUDE.md hard invariant: exactly one for
 * the whole app — the future UI/mixer and the three.js scene audio must use
 * THIS context (three.js: `THREE.AudioContext.setContext(...)`), never
 * create another. Throws outside a browser (node tests must inject a
 * factory instead) and keeps a closed context from being resurrected.
 */
export function getSharedAudioContext(): AudioContextLike {
  if (sharedContext !== undefined) return sharedContext;
  if (typeof AudioContext === 'undefined') {
    throw new Error('AudioContext is unavailable here — inject an AudioContextLike factory (node/tests)');
  }
  sharedContext = asAudioContextLike(new AudioContext());
  return sharedContext;
}

/**
 * Bridge a real DOM AudioContext into the seam. Boundary casts: the real
 * nodes satisfy every seam field we use; the double casts avoid coupling the
 * minimal seam to the DOM types' full overload sets. This is the only place
 * a real context is wrapped.
 */
function asAudioContextLike(ctx: AudioContext): AudioContextLike {
  return {
    get state(): string {
      return ctx.state;
    },
    destination: ctx.destination as unknown as AudioNodeLike,
    listener: ctx.listener as unknown as AudioListenerLike,
    resume: () => ctx.resume(),
    close: () => ctx.close(),
    createPanner: () => ctx.createPanner() as unknown as PannerNodeLike,
    createMediaStreamSource: (stream) => ctx.createMediaStreamSource(stream) as unknown as MediaStreamAudioSourceNodeLike,
  };
}

/** Build the spatial graph. Tests inject `contextFactory`; production uses the singleton default. */
export function createSpatialAudio(options?: SpatialAudioOptions): SpatialAudio {
  const contextFactory = options?.contextFactory ?? getSharedAudioContext;
  const panningModel = options?.panningModel ?? 'HRTF';
  const context = contextFactory();

  interface Attached {
    readonly panner: PannerNodeLike;
    /** Manual-path source node; undefined on the SDK-plugin path. */
    readonly source: MediaStreamAudioSourceNodeLike | undefined;
    /** The handle, kept to clear the SDK plugin chain on detach. */
    readonly track: RemoteTrackHandle;
  }
  const attached = new Map<string, Attached>();

  return {
    context,
    panningModel,
    get participantIds(): readonly string[] {
      return [...attached.keys()];
    },

    attachParticipant(participantId: string, track: RemoteTrackHandle): void {
      if (attached.has(participantId)) throw new Error(`participant ${participantId} is already attached`);
      const panner = context.createPanner();
      panner.panningModel = panningModel;
      panner.distanceModel = 'inverse';
      panner.refDistance = PANNER_REF_DISTANCE_M;
      panner.rolloffFactor = PANNER_ROLLOFF_FACTOR;
      // Omnidirectional source: full inner cone, no outer attenuation.
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 0;
      panner.positionX.value = 0;
      panner.positionY.value = 0;
      panner.positionZ.value = 0;

      if (track.setWebAudioPlugins !== undefined) {
        // SDK-plugin path. ORDER IS LOAD-BEARING [MEASURED 2026-09-06,
        // livekit-client 2.22.2 source]: setWebAudioPlugins(nodes) rebuilds
        // the SDK graph only while attachedElements.length > 0, and only
        // Track.attach() populates attachedElements — so attach FIRST, then
        // hand over the panner (the SDK then wires source → panner → its
        // gain → destination and mutes its element). We must NOT connect
        // the panner ourselves on this path.
        if (track.attach === undefined || track.detach === undefined) {
          throw new Error(
            `remote track for ${participantId} exposes setWebAudioPlugins without attach/detach — the SDK builds its web-audio graph only for attached elements, so this wiring would be silent`,
          );
        }
        track.attach();
        track.setWebAudioPlugins([panner]);
        attached.set(participantId, { panner, source: undefined, track });
        return;
      }
      if (track.mediaStream !== undefined) {
        // Manual fallback: we own the whole chain.
        const source = context.createMediaStreamSource(track.mediaStream);
        source.connect(panner);
        panner.connect(context.destination);
        attached.set(participantId, { panner, source, track });
        return;
      }
      throw new Error(`remote track for ${participantId} exposes neither setWebAudioPlugins nor mediaStream — cannot spatialize`);
    },

    detachParticipant(participantId: string): void {
      const a = attached.get(participantId);
      if (a === undefined) throw new Error(`participant ${participantId} is not attached`);
      if (a.source !== undefined) {
        a.source.disconnect();
        a.panner.disconnect();
      } else {
        // SDK-plugin path: detach() drops the SDK's element AND its graph
        // (connectWebAudio's source/gain pair), then clear the stored plugin
        // chain — with nothing attached that only resets the node list (the
        // measured precondition), it cannot rebuild a graph.
        a.track.detach?.();
        a.track.setWebAudioPlugins?.([]);
      }
      attached.delete(participantId);
    },

    setParticipantPose(participantId: string, pos: SpatialPose): void {
      const a = attached.get(participantId);
      if (a === undefined) throw new Error(`participant ${participantId} is not attached`);
      a.panner.positionX.value = pos.x;
      a.panner.positionY.value = pos.y;
      a.panner.positionZ.value = pos.z;
    },

    setListenerPose(pos: SpatialPose, forward: SpatialPose, up: SpatialPose): void {
      const l = context.listener;
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    },

    dispose(): void {
      for (const id of [...attached.keys()]) this.detachParticipant(id);
    },
  };
}
