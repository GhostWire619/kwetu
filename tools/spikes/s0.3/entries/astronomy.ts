// S0.3 load-budget probe — astronomy-engine entry.
// One body position call: the geocentric Moon vector, the shape of call the
// Phase 1 shell makes to seed the sky. Throwaway probe code (CLAUDE.md carve-out).
import { Body, GeoVector } from 'astronomy-engine';

export const moonGeo = GeoVector(Body.Moon, new Date(), true);
