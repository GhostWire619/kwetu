// S0.3 load-budget probe — livekit-client entry (B-LOAD-04).
// The shipping shape Phase 6 imports: Room + the track surface the positional-
// voice path actually touches. RemoteAudioTrack is used as a VALUE (an
// instanceof guard before WebAudio plugin wiring — the real Phase 6 pattern),
// so the class cannot be tree-shaken out of the figure. The optional E2EE
// worker is NOT imported: in livekit-client 2.22.2 it is a consumer-provided
// Worker ('livekit-client/e2ee-worker' subpath), loaded only if E2EE is
// enabled — Kwetu does not plan E2EE, so the main bundle figure is the honest
// one and the worker file is recorded separately in report.json.
// Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import {
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from 'livekit-client';

export const voiceRoom = new Room({ adaptiveStream: true, dynacast: true });
export const audioTrackKind = Track.Kind.Audio;

export function isRemoteAudio(track: RemoteTrack): track is RemoteAudioTrack {
  return track instanceof RemoteAudioTrack;
}

voiceRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
  if (isRemoteAudio(track)) {
    // Phase 6 wires the RemoteAudioTrack into the shared AudioContext
    // PannerNode chain (one AudioContext for the whole app — hard invariant).
  }
});

export type KwetuLocalTrack = LocalAudioTrack;
