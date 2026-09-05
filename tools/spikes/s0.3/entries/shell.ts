// S0.3 load-budget probe — combined shell entry (the S0.3 shell figure).
// All four pinned runtime deps plus one tiny Swahili locale JSON, wired the way
// the Phase 1 shell will wire them: log-depth renderer, Z-up Rapier world,
// astronomy body call, i18next with an imported locale bundle. The locale JSON
// is a probe fixture with generic keys — the real key namespace is owned by
// docs/swahili-i18n.md. Throwaway probe code (CLAUDE.md carve-out).
import i18next from 'i18next';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { Body, GeoVector } from 'astronomy-engine';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import sw from './locale.sw.json';

await RAPIER.init();
export const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });

export const scene = new Scene();
export const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1e12);
export const renderer = new WebGLRenderer({ logarithmicDepthBuffer: true });

export const moonGeo = GeoVector(Body.Moon, new Date(), true);

await i18next.init({
  lng: 'sw',
  fallbackLng: 'en',
  resources: { sw: { translation: sw } },
});
export const title: string = i18next.t('welcome.title');
