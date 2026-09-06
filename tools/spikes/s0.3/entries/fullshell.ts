// S0.3 load-budget probe — full first-visit bundle (B-LOAD-09 direct check).
// Every pinned runtime dependency in ONE entry, wired as the shell will wire
// them, so the provisional first-visit total has a measured single-stream gzip
// figure with no double counting between package rows. The Basis transcoder
// pair is the only exclusion: KTX2Loader fetches those two files at runtime as
// static assets, never from the bundle — report.json adds them explicitly in
// firstVisitProvisional. The 8-key locale fixture rides inline here exactly as
// in shell.ts (the real app loads locales lazily; the fixture's inline cost is
// noted in the report). Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import { Client } from '@heroiclabs/nakama-js';
import { RemoteAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { Body, GeoVector } from 'astronomy-engine';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import i18next from 'i18next';
import sw from './locale.sw.json';

await RAPIER.init();
export const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });

export const scene = new Scene();
export const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1e12);
export const renderer = new WebGLRenderer({ logarithmicDepthBuffer: true });

export const moonGeo = GeoVector(Body.Moon, new Date(), true);

export const nakama = new Client('defaultkey', '127.0.0.1', '7350', false);
export const socket = nakama.createSocket(false, false);

export const voiceRoom = new Room({ adaptiveStream: true, dynacast: true });
export const audioTrackKind = Track.Kind.Audio;
export const isRemoteAudio = (t: unknown): t is RemoteAudioTrack =>
  t instanceof RemoteAudioTrack;
voiceRoom.on(RoomEvent.TrackSubscribed, () => {});

// Consumed, not merely re-exported: a pure unused export tree-shakes away
// (measured — see entries/meshopt.ts). GLTFLoader awaits `.ready` the same way.
await MeshoptDecoder.ready;
export const decoder = MeshoptDecoder;

await i18next.init({
  lng: 'sw',
  fallbackLng: 'en',
  resources: { sw: { translation: sw } },
});
export const title: string = i18next.t('welcome.title');
