/**
 * S0.1 probe D — tangent-gravity error probe (THROWAWAY spike code).
 *
 * COORDINATE_SYSTEM.md §8 permits a tangent normal-gravity approximation inside
 * a small surface bubble — world gravity (0, 0, -g) in the anchor's ENU triad —
 * and requires S0.1 to measure its error so the contact-bubble extent bound
 * (Law P-5's "separate, tighter measured bound") is a measurement, not a guess.
 *
 * Model (spherical, the honest bubble geometry):
 *   - Earth as a sphere of mean radius R = 6 371 000 m (COORDINATE_SYSTEM.md §6
 *     landmark), centre O at the origin.
 *   - Anchor A on the sphere. Its ENU triad: up = radial out, east/north tangent.
 *   - A body at bubble-local (d, 0, 0) (a surface displacement along the tangent)
 *     sits at P = A + d·east in 3-D space — the tangent model's own placement.
 *   - TRUE gravity at P: central field g⃗(P) = −μ·P/|P|³, magnitude μ/|P|²,
 *     directed at O.  μ⊕ = 3.986004418e14 m³/s² [EXTERNAL — IERS Conventions
 *     (2010) / EGM2008 GM⊕].
 *   - TANGENT model: g⃗_tan = (0, 0, −9.80665) ENU = −9.80665·up_A everywhere in
 *     the bubble (uniform, anchored at A).
 *
 * Measured per displacement d ∈ {0, 100 m, 1 km, 10 km, 100 km, 1e6 m}:
 *   - angular direction error (rad): angle between −up_A and the true gravity
 *     direction at P, measured with the atan2(|a×b|, a·b) form (no acos clamping);
 *   - magnitude error (m/s² and relative): |g⃗(P)| − 9.80665;
 *   - curvature magnitude drop (relative): 1 − |g⃗(P)|/|g⃗(A)| — isolates the
 *     geometric 1/r² spreading term from the constant-choice offset;
 *   - spurious lateral acceleration (m/s²): |g⃗(P)|·sin(dirErr) — the component
 *     of true gravity the tangent model points the wrong way (feeds Law P-5);
 *   - lateral miss over a 60 s ballistic flight (m): spurious·(60²)/2 [derived,
 *     order-of-magnitude playback of the error, not a simulation].
 *
 * The d = 0 row is the constant-choice offset: central gravity at mean radius
 * (μ/R² ≈ 9.820) vs the 9.80665 tangent constant — present everywhere in the
 * bubble, independent of extent.
 *
 * Symmetry check: on a sphere, displacing east vs north is identical to fp
 * rounding; both are computed and their max deviation recorded (on the real
 * WGS84 ellipsoid they would differ slightly — the geodesy decision owns that;
 * the spherical bound is the bubble-extent input).
 */
import { EARTH_MEAN_RADIUS_METRES, angleBetweenRadians, norm3, type Vec3 } from '../frames/frameChain.ts';

/** GM⊕ [EXTERNAL — IERS Conventions (2010) / EGM2008], m³/s². */
export const EARTH_GM_M3_PER_S2 = 3.986004418e14;
/** The tangent constant of COORDINATE_SYSTEM.md §8 / VEHICLES_AND_FLIGHT reference model. */
export const TANGENT_G_METRES_PER_S2 = 9.80665;
/** COORDINATE_SYSTEM.md §6 landmark radius ("Earth radius (6 371 km) lives here"). */
export const R_METRES = EARTH_MEAN_RADIUS_METRES;
/** Surface displacements probed (the brief's ladder, plus d = 0 as the baseline). */
export const DISPLACEMENTS_METRES = [0, 100, 1000, 10000, 100000, 1e6];

export interface GravityRow {
  displacementMetres: number;
  /** |g⃗(P)| at the displaced point, m/s². */
  trueGravityMetresPerSecond2: number;
  /** Angle between −up(anchor) and the true gravity direction at P, rad. */
  angularDirectionErrorRad: number;
  /** |g⃗(P)| − 9.80665, m/s² (negative: true field weaker than the constant). */
  magnitudeErrorMetresPerSecond2: number;
  magnitudeRelativeError: number;
  /** 1 − |g⃗(P)|/|g⃗(A)| — the geometric 1/r² term alone. */
  curvatureRelativeMagnitudeDrop: number;
  /** |g⃗(P)|·sin(dirErr): true-gravity component the tangent model misdirects. */
  spuriousLateralAccelerationMetresPerSecond2: number;
  /** spurious lateral accel over a 60 s ballistic flight: a·t²/2, t = 60 s [derived]. */
  lateralMissOver60sMetres: number;
}

export interface GravityReport {
  method: string;
  gmMetres3PerSecond2: number;
  radiusMetres: number;
  tangentGMetresPerSecond2: number;
  /** Central gravity at the anchor, μ/R² (the field the tangent constant approximates). */
  gravityAtAnchorMetresPerSecond2: number;
  rows: GravityRow[];
  /** Max |east − north| row deviation (spherical symmetry check, fp-level). */
  maxAzimuthSymmetryDeviation: {
    angularErrorRad: number;
    magnitudeMetresPerSecond2: number;
  };
  /** True-gravity direction at the anchor vs the ellipsoid-deflected ENU up is NOT
   * measured here (spherical model has zero deflection by construction) — noted
   * so nobody quotes this table's d=0 row as a deflection-of-the-vertical figure. */
  sphericalModelNote: string;
}

function rowFor(displacementMetres: number, horizontal: Vec3): GravityRow {
  // Anchor on the +x axis; east = +y, north = +z (right-handed with up = +x).
  const anchor: Vec3 = [R_METRES, 0, 0];
  const up: Vec3 = [1, 0, 0];
  const p: Vec3 = [
    anchor[0] + horizontal[0] * displacementMetres,
    anchor[1] + horizontal[1] * displacementMetres,
    anchor[2] + horizontal[2] * displacementMetres,
  ];
  const r = norm3(p);
  const gMag = EARTH_GM_M3_PER_S2 / (r * r);
  // True gravity direction: from P toward O = −p/r.
  const gDir: Vec3 = [-p[0] / r, -p[1] / r, -p[2] / r];
  const modelDir: Vec3 = [-up[0], -up[1], -up[2]];
  const dirErr = angleBetweenRadians(gDir, modelDir);
  const gravityAtAnchor = EARTH_GM_M3_PER_S2 / (R_METRES * R_METRES);
  return {
    displacementMetres,
    trueGravityMetresPerSecond2: gMag,
    angularDirectionErrorRad: dirErr,
    magnitudeErrorMetresPerSecond2: gMag - TANGENT_G_METRES_PER_S2,
    magnitudeRelativeError: (gMag - TANGENT_G_METRES_PER_S2) / TANGENT_G_METRES_PER_S2,
    curvatureRelativeMagnitudeDrop: 1 - gMag / gravityAtAnchor,
    spuriousLateralAccelerationMetresPerSecond2: gMag * Math.sin(dirErr),
    lateralMissOver60sMetres: gMag * Math.sin(dirErr) * ((60 * 60) / 2),
  };
}

export function collectGravityReport(): GravityReport {
  const rows = DISPLACEMENTS_METRES.map((d) => rowFor(d, [0, 1, 0])); // east
  const northRows = DISPLACEMENTS_METRES.map((d) => rowFor(d, [0, 0, 1])); // north
  let maxDir = 0;
  let maxMag = 0;
  for (let i = 0; i < rows.length; i++) {
    maxDir = Math.max(maxDir, Math.abs(rows[i].angularDirectionErrorRad - northRows[i].angularDirectionErrorRad));
    maxMag = Math.max(maxMag, Math.abs(rows[i].trueGravityMetresPerSecond2 - northRows[i].trueGravityMetresPerSecond2));
  }
  return {
    method:
      'Spherical Earth (R = 6 371 000 m), anchor on the surface, body at bubble-local (d,0,0) i.e. P = A + d·east ' +
      'in 3-D; true field central (g = GM⊕/r² toward O); tangent model uniform (0,0,−9.80665) in the anchor ENU. ' +
      'Direction error = angle(−up_A, −P/|P|) via atan2(|a×b|, a·b); magnitude error = GM⊕/r² − 9.80665. ' +
      'Lateral miss = spurious lateral acceleration × 60²/2 [derived playback, not a simulation].',
    gmMetres3PerSecond2: EARTH_GM_M3_PER_S2,
    radiusMetres: R_METRES,
    tangentGMetresPerSecond2: TANGENT_G_METRES_PER_S2,
    gravityAtAnchorMetresPerSecond2: EARTH_GM_M3_PER_S2 / (R_METRES * R_METRES),
    rows,
    maxAzimuthSymmetryDeviation: { angularErrorRad: maxDir, magnitudeMetresPerSecond2: maxMag },
    sphericalModelNote:
      'Spherical model: zero deflection of the vertical by construction, so the d=0 row is the g-constant choice ' +
      '(μ/R² vs 9.80665), NOT a geodetic deflection figure; ellipsoidal normal gravity is owned by the geodesy ' +
      'decision (COORDINATE_SYSTEM.md §5/S0.1 ADR).',
  };
}
