/**
 * Kwetu wire protocol — the typed TS view of {@link ./protocol.json} (the
 * single source of truth; the JSON's header comment owns the rules).
 *
 * `client/src/net/socket.ts` re-exports the opcode/cap constants from here —
 * its public API is unchanged, its definitions are not duplicated. The Go
 * side is verified against the same JSON by
 * `server/runtime-go/protocol_check_test.go` (compiled constants vs file, at
 * `go test` time — server/runtime-go/README.md §Build).
 *
 * `shared/` is part of the strict typecheck program (tsconfig include) and
 * may be imported by client code; nothing here imports client code — the
 * dependency arrow points one way (client → shared).
 */
import protocol from './protocol.json';

export const PROTOCOL_SCHEMA = protocol.schema;

/** The registered authoritative match handler (server/runtime-go/match.go). */
export const MATCH_NAME: string = protocol.matchName;

/**
 * Wire-format opcodes. Frozen contract numbers — the Go runtime's
 * `OpClientState/OpServerSnapshot/OpServerCorrection` mirror them exactly
 * (protocol_check_test.go enforces it).
 */
export const MatchOpcode = Object.freeze({
  /** C2S: one coalesced per-tick input message (NETWORKING.md §4 rule 2). */
  INPUT: protocol.opcodes.clientState,
  /** S2C: per-tick world snapshot for client interpolation (NETWORKING.md §7). */
  SNAPSHOT: protocol.opcodes.serverSnapshot,
  /** S2C: server-sanctioned kinematic discontinuity — teleport, lift, impact (ADR-007 Open item 3). */
  DISCONTINUITY: protocol.opcodes.serverCorrection,
} as const);
export type MatchOpcodeValue = (typeof MatchOpcode)[keyof typeof MatchOpcode];

/**
 * The 1500-byte wire cap. CLAUDE.md hard invariant — quoted here, never
 * moved, never tuned.
 */
export const WIRE_MAX_BYTES: number = protocol.wireMaxBytes;

/** Client input send rate (Hz); the coalescing window derives from it. */
export const INPUT_SEND_HZ: number = protocol.inputSendHz;
/** Derived from INPUT_SEND_HZ: the coalescing window in ms. */
export const INPUT_SEND_PERIOD_MS = 1000 / INPUT_SEND_HZ;

/** The server tick rate (Hz) the wire's tick field advances at. */
export const TICK_RATE_HZ: number = protocol.tickRateHz;
/** Derived: the server tick period in ms — the snapshot timeline quantum. */
export const TICK_PERIOD_MS = 1000 / TICK_RATE_HZ;

/** Exact size of the OpClientState/OpServerCorrection payload (bytes). */
export const CLIENT_STATE_BYTES: number = protocol.clientState.bytes;

/** Server snapshot envelope size (bytes). */
export const SNAPSHOT_ENVELOPE_BYTES: number = protocol.snapshot.envelopeBytes;
/** One snapshot entity record's size (bytes). */
export const SNAPSHOT_RECORD_BYTES: number = protocol.snapshot.recordBytes;
/**
 * Budget for Nakama's own protobuf envelope + WebSocket/TLS framing around
 * the data payload [PLACEHOLDER — gate: Phase 5 netcode design doc replaces
 * this with a measured framing ledger; 128 B is a stated conservative
 * stand-in, not a measurement] — server/runtime-go/snapshot.go owns the
 * identical constant; protocol_check_test.go enforces the agreement.
 */
export const SNAPSHOT_WIRE_MARGIN_BYTES: number = protocol.snapshot.wireMarginBytes;

/** AoI grid parameters the server runs (ADR-009; provenance in the JSON). */
export const AOI_CELL_SIZE_METRES: number = protocol.aoi.cellSizeMetres;
export const AOI_RADIUS_METRES: number = protocol.aoi.radiusMetres;

/** RPC id strings — client/src/net/session.ts and the Go registry mirror these. */
export const RpcId = Object.freeze({
  HEALTHCHECK: protocol.rpcs.healthcheck,
  WORLD_TIME: protocol.rpcs.worldTime,
  WORLD_JOIN: protocol.rpcs.worldJoin,
  VOICE_TOKEN: protocol.rpcs.voiceToken,
} as const);

export type ProtocolShape = typeof protocol;
