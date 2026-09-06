// S0.3 load-budget probe — nakama-js entry (B-LOAD-03).
// The real shipping shape Phase 5 imports: Client from the package's ESM build
// (dist/nakama-js.esm.mjs, which carries whatwg-fetch + the base64 helpers
// inline — no external imports) plus the socket the app creates before
// connect() (nakama-js 2.8.0 API: client.createSocket(...)). No server is
// contacted — this probe measures bytes, not connectivity.
// Throwaway probe code (CLAUDE.md tools/spikes carve-out).
import { Client } from '@heroiclabs/nakama-js';
import type { Session, Socket } from '@heroiclabs/nakama-js';

export const client = new Client('defaultkey', '127.0.0.1', '7350', false);
export const socket: Socket = client.createSocket(false, false);
export type KwetuSession = Session;
