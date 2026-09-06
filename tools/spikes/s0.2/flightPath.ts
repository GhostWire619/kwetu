// S0.2 probe — scripted camera flight over the probe planet.
// Pure and deterministic: pose is a pure function of elapsed seconds so every
// scheme/depth run flies the identical path.
//
// Profile (the task's 1 m -> 1e6 m -> 1e3 m flight, 42 s):
//   0..3    warmup hold at 1 m altitude (LOD tree fills; excluded from stats)
//   3..15   ascend 1 m -> 1e6 m (log-eased) while drifting east
//   15..23  hold 1e6 m, faster pan with the limb in view (silhouette window)
//   23..36  descend 1e6 m -> 1e3 m (log-eased)
//   36..42  hold 1e3 m, low lateral pass

export const FLIGHT_END_S = 42;
export const FLIGHT_STATS_FROM_S = 3;
export const FLIGHT_HIGH_HOLD_S = 15;
export const FLIGHT_HIGH_HOLD_END_S = 23;

export const ALT_START_M = 1;
export const ALT_HIGH_M = 1e6;
export const ALT_LOW_M = 1e3;

const LAT0 = 0.35; // rad (~20 deg N)
const LON0 = 0.9;
const DRIFT_RAD_S = 0.004;
const PAN_RAD_S = 0.02;

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export interface FlightPose {
  /** camera sub-point latitude (rad) */
  lat: number;
  /** camera sub-point longitude (rad) */
  lon: number;
  /** altitude above the mean sphere (m) */
  altM: number;
  /** look-target latitude (rad, on the surface) */
  targetLat: number;
  /** look-target longitude (rad, on the surface) */
  targetLon: number;
  phase: 'warmup' | 'ascend' | 'high' | 'descend' | 'low';
}

export function flightPose(t: number): FlightPose {
  const lon = LON0 + DRIFT_RAD_S * t + (t > FLIGHT_HIGH_HOLD_S ? (PAN_RAD_S - DRIFT_RAD_S) * Math.min(t - FLIGHT_HIGH_HOLD_S, FLIGHT_HIGH_HOLD_END_S - FLIGHT_HIGH_HOLD_S) : 0);
  let altM: number;
  let phase: FlightPose['phase'];
  if (t < FLIGHT_STATS_FROM_S) {
    altM = ALT_START_M;
    phase = 'warmup';
  } else if (t < FLIGHT_HIGH_HOLD_S) {
    const k = smoothstep((t - FLIGHT_STATS_FROM_S) / (FLIGHT_HIGH_HOLD_S - FLIGHT_STATS_FROM_S));
    altM = Math.exp((1 - k) * Math.log(ALT_START_M) + k * Math.log(ALT_HIGH_M));
    phase = 'ascend';
  } else if (t < FLIGHT_HIGH_HOLD_END_S) {
    altM = ALT_HIGH_M;
    phase = 'high';
  } else if (t < 36) {
    const k = smoothstep((t - FLIGHT_HIGH_HOLD_END_S) / (36 - FLIGHT_HIGH_HOLD_END_S));
    altM = Math.exp((1 - k) * Math.log(ALT_HIGH_M) + k * Math.log(ALT_LOW_M));
    phase = 'descend';
  } else {
    altM = ALT_LOW_M;
    phase = 'low';
  }
  // Look at the surface `groundAheadM` ahead along-track; during the high hold
  // look further out so the limb sits in frame.
  const groundAheadM = phase === 'high' ? 4.5e6 : 2 * altM;
  const dLat = groundAheadM / 6_371_000; // great-circle offset ~ arc/R (small-angle)
  return { lat: LAT0, lon, altM, targetLat: LAT0 - dLat * 0.7, targetLon: lon + dLat * 0.7, phase };
}
