/**
 * S0.1 probe A — f64 frame-chain probe (THROWAWAY spike code, CLAUDE.md carve-out).
 *
 * Implements the COORDINATE_SYSTEM.md §1 chain as f64 math:
 *
 *   Geodetic(Earth, WGS84) --§5 closed form--> PlanetFixed(Earth)   [ITRF-like, no polar motion]
 *   PlanetFixed --Rz(+GAST)--> EQD --library EQD->EQJ--> Pci(Earth) [axes parallel to EQJ]
 *   Pci --+Earth HelioVector--> Helio                               [AU boundary crossed ONCE]
 *
 * ROTATION PAIR USED (documented per the S0.1 brief):
 *   - EQJ <-> EQD via astronomy-engine's Rotation_EQJ_EQD / Rotation_EQD_EQJ
 *     (precession + nutation), ALWAYS applied through the library's own
 *     RotateVector/RotateState. Do NOT multiply `rot.rot` row-major by hand:
 *     RotateVector applies the stored matrix transposed (verified against the
 *     library's own ObserverVector(ofdate=true/false) endpoints to 6.8e-21 AU);
 *     a manual row-major multiply is the inverse mapping and silently inverts
 *     the rotation direction.
 *   - EQD <-> PlanetFixed(CTRS) via the Greenwich Apparent Sidereal Time
 *     (library SiderealTime, sidereal hours) as a rotation about +z:
 *     PF -> EQD is Rz(+GAST); EQD -> PF is Rz(-GAST).
 *     This pair is "EQJ -> EQD -> CTRS" in the brief's terms. No polar motion,
 *     no DUT1 — the deliberate omissions of COORDINATE_SYSTEM.md §1.
 *   - The ecliptic equivalents (ECL/ECT) are NOT used: COORDINATE_SYSTEM.md §1
 *     bans ecliptic frames as Kwetu frames.
 *
 * Earth-fixed geodesy here is the doc's own §5 WGS84 closed form (a = 6378137 m
 * exact, 1/f = 298.257223563 exact). astronomy-engine's internal ellipsoid
 * constant (EARTH_FLATTENING = 0.996647180302104, read from its source) is NOT
 * WGS84 — it is used only as an independent oracle for directions (G-01) and
 * never for survey positions.
 *
 * The ECEF->geodetic inverse below is probe-only (Bowring iteration). The doc
 * blesses no inverse; the production choice is the geodesy reference
 * implementation decision recorded in the S0.1 ADR.
 */
import * as A from 'astronomy-engine';

// --- WGS84 constants (COORDINATE_SYSTEM.md §5) -------------------------------
export const WGS84_A_METRES = 6378137.0; // exact [EXTERNAL — NGA STND.0036]
export const WGS84_INVF = 298.257223563; // exact
const WGS84_F = 1 / WGS84_INVF;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F); // 0.0066943799901413165 [derived]

// Earth mean radius for probe D (doc landmark: 6 371 km, §6 table).
export const EARTH_MEAN_RADIUS_METRES = 6371000.0;

// Library AU constant, crossed exactly once (Law U-1 / §3).
export const AU_METRES = A.KM_PER_AU * 1000;

// Earth sidereal rotation rate, quoted by COORDINATE_SYSTEM.md Law V-1.
export const EARTH_OMEGA_RAD_PER_S = 7.2921159e-5;

export type Vec3 = [number, number, number];

export const SITE = {
  name: 'Dar es Salaam seafront (COORDINATE_SYSTEM.md §12 worked example)',
  latitudeDeg: -6.79,
  longitudeDeg: 39.21,
  heightMetres: 0,
  instantIso: '2026-09-05T00:00:00Z',
};

export function siteInstant(): Date {
  return new Date(Date.UTC(2026, 8, 5, 0, 0, 0)); // 2026-09-05T00:00:00Z
}

// --- Geodesy: geodetic <-> PlanetFixed (ECEF) --------------------------------

/** Geodetic (deg, deg, m) -> Frame.PlanetFixed(Earth) metres. COORDINATE_SYSTEM.md §5 closed form. */
export function geodeticToPlanetFixed(latitudeDeg: number, longitudeDeg: number, heightMetres: number): Vec3 {
  const phi = (latitudeDeg * Math.PI) / 180;
  const lam = (longitudeDeg * Math.PI) / 180;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const n = WGS84_A_METRES / Math.sqrt(1 - WGS84_E2 * s * s);
  return [
    (n + heightMetres) * c * Math.cos(lam),
    (n + heightMetres) * c * Math.sin(lam),
    (n * (1 - WGS84_E2) + heightMetres) * s,
  ];
}

/**
 * Frame.PlanetFixed(Earth) metres -> geodetic (deg, deg, m).
 * PROBE-ONLY Bowring iteration (the doc blesses no inverse; production uses the
 * geodesy reference implementation chosen by the S0.1 ADR).
 */
export function planetFixedToGeodetic(p: Vec3): { latitudeDeg: number; longitudeDeg: number; heightMetres: number } {
  const [x, y, z] = p;
  const pxy = Math.hypot(x, y);
  let lat = Math.atan2(z, pxy);
  let h = 0;
  for (let i = 0; i < 64; i++) {
    const s = Math.sin(lat);
    const n = WGS84_A_METRES / Math.sqrt(1 - WGS84_E2 * s * s);
    h = pxy / Math.cos(lat) - n;
    const next = Math.atan2(z, pxy * (1 - (WGS84_E2 * n) / (n + h)));
    if (Math.abs(next - lat) < 1e-15) {
      lat = next;
      break;
    }
    lat = next;
  }
  return {
    latitudeDeg: (lat * 180) / Math.PI,
    longitudeDeg: (Math.atan2(y, x) * 180) / Math.PI,
    heightMetres: h,
  };
}

// --- The one rotation: PlanetFixed <-> Pci(Earth) ----------------------------

/** GAST in radians (library SiderealTime returns sidereal hours [0,24)). */
export function gastRadians(t: Date): number {
  return ((A.SiderealTime(t) * 15) * Math.PI) / 180;
}

function rotateAboutZ(v: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

function libraryRotate(rot: A.RotationMatrix, v: Vec3): Vec3 {
  const out = A.RotateVector(rot, new A.Vector(v[0], v[1], v[2], A.MakeTime(0)));
  return [out.x, out.y, out.z];
}

/** Frame.PlanetFixed(Earth) -> Frame.Pci(Earth). Rz(+GAST) into EQD, then library EQD->EQJ. */
export function planetFixedToPci(v: Vec3, t: Date): Vec3 {
  const eqd = rotateAboutZ(v, gastRadians(t));
  return libraryRotate(A.Rotation_EQD_EQJ(t), eqd);
}

/** Frame.Pci(Earth) -> Frame.PlanetFixed(Earth). Library EQJ->EQD, then Rz(-GAST). */
export function pciToPlanetFixed(v: Vec3, t: Date): Vec3 {
  const eqd = libraryRotate(A.Rotation_EQJ_EQD(t), v);
  return rotateAboutZ(eqd, -gastRadians(t));
}

// --- Translation hops: Pci <-> Helio -----------------------------------------

/** Earth heliocentric position, metres in EQJ (AU crossed exactly once, §3). */
export function earthHelioMetres(t: Date): Vec3 {
  const hv = A.HelioVector(A.Body.Earth, t);
  return [hv.x * AU_METRES, hv.y * AU_METRES, hv.z * AU_METRES];
}

export function pciToHelio(vPci: Vec3, earthHelio: Vec3): Vec3 {
  return [vPci[0] + earthHelio[0], vPci[1] + earthHelio[1], vPci[2] + earthHelio[2]];
}

export function helioToPci(vHelio: Vec3, earthHelio: Vec3): Vec3 {
  return [vHelio[0] - earthHelio[0], vHelio[1] - earthHelio[1], vHelio[2] - earthHelio[2]];
}

// --- ENU triad (COORDINATE_SYSTEM.md §5 formulas, copied verbatim) -----------

export interface EnuBasis {
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

/** ENU basis rows at a geodetic anchor (doc §5: E, N, U rows). */
export function enuBasis(latitudeDeg: number, longitudeDeg: number): EnuBasis {
  const phi = (latitudeDeg * Math.PI) / 180;
  const lam = (longitudeDeg * Math.PI) / 180;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  return {
    east: [-sl, cl, 0],
    north: [-sp * cl, -sp * sl, cp],
    up: [cp * cl, cp * sl, sp],
  };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** PlanetFixed -> ENU at an anchor: p_enu = R · (p_pf − p_anchor), doc §5. */
export function planetFixedToEnu(pPf: Vec3, anchorGeodetic: { latitudeDeg: number; longitudeDeg: number; heightMetres: number }): Vec3 {
  const anchorPf = geodeticToPlanetFixed(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg, anchorGeodetic.heightMetres);
  const d: Vec3 = [pPf[0] - anchorPf[0], pPf[1] - anchorPf[1], pPf[2] - anchorPf[2]];
  const basis = enuBasis(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg);
  return [dot3(basis.east, d), dot3(basis.north, d), dot3(basis.up, d)];
}

/** ENU at an anchor -> PlanetFixed: p_pf = p_anchor + E·x + N·y + U·z. */
export function enuToPlanetFixed(enu: Vec3, anchorGeodetic: { latitudeDeg: number; longitudeDeg: number; heightMetres: number }): Vec3 {
  const anchorPf = geodeticToPlanetFixed(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg, anchorGeodetic.heightMetres);
  const basis = enuBasis(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg);
  return [
    anchorPf[0] + basis.east[0] * enu[0] + basis.north[0] * enu[1] + basis.up[0] * enu[2],
    anchorPf[1] + basis.east[1] * enu[0] + basis.north[1] * enu[1] + basis.up[1] * enu[2],
    anchorPf[2] + basis.east[2] * enu[0] + basis.north[2] * enu[1] + basis.up[2] * enu[2],
  ];
}

/** Angle between unit-direction pairs, computed as atan2(|a×b|, a·b) — no acos clamping noise. */
export function angleBetweenRadians(a: Vec3, b: Vec3): number {
  return Math.atan2(norm3(cross3(a, b)), dot3(a, b));
}

// --- Doc seeds (COORDINATE_SYSTEM.md §12, committed as G-01/G-02 seeds) ------

export const DOC_SEEDS = {
  gastDeg: 344.118,
  ecef: [4907565.698, 4003939.392, -749078.231] as Vec3,
  pciEqj: [5828917.818, 2473115.83, -764372.354] as Vec3,
  earthHelioAu: [0.959534245683709, -0.2844143594239741, -0.12329471927952336] as Vec3,
  earthHelioMetres: [143544280009.368, -42547782563.768, -18444627471.66] as Vec3,
  darHelioMetres: [143550108927.186, -42545309447.938, -18445391844.014] as Vec3,
  pciRoundTripResidualMetresBound: 4.4e-6,
  f32CancellationMetres: 12636,
  g01ZenithDegSeed: 4.6e-14,
};

// --- Probe A measurements -----------------------------------------------------

export interface FrameReport {
  rotationPairUsed: string;
  site: typeof SITE;
  gastDeg: number;
  gastDocSeedDeg: number;
  ecefPlanetFixed: Vec3;
  ecefDocSeed: Vec3;
  ecefVsDocSeedMaxComponentErrorMetres: number;
  pciEqj: Vec3;
  pciDocSeed: Vec3;
  pciVsDocSeedMaxComponentErrorMetres: number;
  earthHelioMetresValue: Vec3;
  earthHelioDocSeedMetres: Vec3;
  darHelioMetresValue: Vec3;
  darHelioDocSeedMetres: Vec3;
  roundTripFullChainResidualMetres: number;
  roundTripRotationOnlyResidualMetres: number;
  g01ZenithSelfConsistencyDeg: number;
  g01ZenithDocSeedDeg: number;
  libraryEndpointCheckMetres: number;
  libraryEllipsoidConstantNote: string;
  enuUpRadialChecks: {
    offsetHeightMetres: number;
    latLonRecoveredEqualsAnchor: boolean;
    maxLatOrLonDeviationRad: number;
    heightResidualMetres: number;
  }[];
  enuUpVsGeocentricRadialAngleRad: number;
  transportVelocity: {
    docDerivedEquatorSpeedMetresPerSecond: number;
    chainEquatorSpeedMetresPerSecond: number;
    libraryObserverStateEquatorSpeedMetresPerSecond: number;
    chainVsLibraryDiffMetresPerSecond: number;
  };
  f32QuantisationOfSitePosition: {
    maxComponentErrorMetres: number;
    vectorErrorMetres: number;
    docSeedMetres: number;
  };
  f32Cancellation: {
    f64SubtractionErrorMetres: number;
    f32SubtractionErrorMetres: number;
    f32UlpAtHelioMagnitudeMetres: number;
    docSeedMetres: number;
  };
  /** §12 steps 7-8: the LocalScene hop (eye/door offsets re-derived through
   * PlanetFixed, subtracted back in ENU) and the single f32 downcast (Law P-2):
   * camera faces East, three.js basis x=right=−N, y=up=U, z=backward=−E. */
  localSceneStep: {
    doorMinusEye: Vec3;
    doorMinusEyeDocSeed: Vec3;
    doorMinusEyeDeviationFromSeedMetres: number;
    doorMinusEyeMaxDeviationFromExactMetres: number;
    cameraSpaceF32: Vec3;
    cameraSpaceF32DocSeed: Vec3;
  };
}

/** Runs the full worked example and returns every measured number. Pure + deterministic. */
export function collectFrameReport(): FrameReport {
  const t = siteInstant();
  const { latitudeDeg, longitudeDeg, heightMetres } = SITE;

  const gastDeg = (gastRadians(t) * 180) / Math.PI;
  const ecef = geodeticToPlanetFixed(latitudeDeg, longitudeDeg, heightMetres);
  const pci = planetFixedToPci(ecef, t);
  const earthHelio = earthHelioMetres(t);
  const darHelio = pciToHelio(pci, earthHelio);

  // Round trip, full chain (through Helio: the add/subtract at 1.5e11 m).
  const pciBack = helioToPci(darHelio, earthHelio);
  const ecefBack = pciToPlanetFixed(pciBack, t);
  const geoBack = planetFixedToGeodetic(ecefBack);
  // Residual in metres: recompute the position in PlanetFixed, the frame where
  // metres are meaningful (degree deltas are not a distance).
  const ecefReconstructed = geodeticToPlanetFixed(geoBack.latitudeDeg, geoBack.longitudeDeg, geoBack.heightMetres);
  const roundTripFullChainResidualMetres = norm3([
    ecefReconstructed[0] - ecef[0],
    ecefReconstructed[1] - ecef[1],
    ecefReconstructed[2] - ecef[2],
  ]);

  // Round trip, rotation-only (no Helio hop): isolates rotation + geodesy noise.
  const ecefRotOnly = pciToPlanetFixed(pci, t);
  const roundTripRotationOnlyResidualMetres = norm3([
    ecefRotOnly[0] - ecef[0],
    ecefRotOnly[1] - ecef[1],
    ecefRotOnly[2] - ecef[2],
  ]);

  // G-01: library's own horizon-frame zenith vs our ENU up through the chain.
  const obs = new A.Observer(latitudeDeg, longitudeDeg, heightMetres);
  const basis = enuBasis(latitudeDeg, longitudeDeg);
  const upEqj = planetFixedToPci(basis.up, t); // directions only — same rotation path
  const zenLib = libraryRotate(A.Rotation_HOR_EQJ(t, obs), [0, 0, 1]);
  const g01ZenithDeg = (angleBetweenRadians(upEqj, zenLib) * 180) / Math.PI;

  // Library endpoint check: RotateVector(Rotation_EQD_EQJ) maps the library's own
  // of-date observer vector onto its own J2000 observer vector.
  const vEqd = A.ObserverVector(t, obs, true);
  const vEqj = A.ObserverVector(t, obs, false);
  const conv = A.RotateVector(A.Rotation_EQD_EQJ(t), vEqd);
  const libraryEndpointCheckMetres = Math.hypot(conv.x - vEqj.x, conv.y - vEqj.y, conv.z - vEqj.z) * AU_METRES;

  // (ii) ENU up-vector is radial to the ellipsoid normal: a normal-offset line
  // (anchor + h·U) must recover the anchor's lat/lon exactly, with height = h.
  const offsets = [-100, 100, 1000];
  const enuUpRadialChecks = offsets.map((h) => {
    const p = enuToPlanetFixed([0, 0, h], SITE);
    const back = planetFixedToGeodetic(p);
    const dLat = ((back.latitudeDeg - latitudeDeg) * Math.PI) / 180;
    const dLon = ((back.longitudeDeg - longitudeDeg) * Math.PI) / 180;
    return {
      offsetHeightMetres: h,
      latLonRecoveredEqualsAnchor: Math.abs(dLat) < 1e-12 && Math.abs(dLon) < 1e-12,
      maxLatOrLonDeviationRad: Math.max(Math.abs(dLat), Math.abs(dLon)),
      heightResidualMetres: back.heightMetres - h,
    };
  });

  // ENU up vs the geocentric radial direction at the site (deflection of the vertical).
  const radial: Vec3 = [ecef[0] / norm3(ecef), ecef[1] / norm3(ecef), ecef[2] / norm3(ecef)];
  const enuUpVsGeocentricRadialAngleRad = angleBetweenRadians(basis.up, radial);

  // Law V-1 transport term at the equator: chain omega×r vs library ObserverState.
  const rEquator = geodeticToPlanetFixed(0, 0, 0);
  const rEqdVec = rotateAboutZ(rEquator, gastRadians(t));
  const vEqdVec: Vec3 = [
    -EARTH_OMEGA_RAD_PER_S * rEqdVec[1],
    EARTH_OMEGA_RAD_PER_S * rEqdVec[0],
    0,
  ];
  const vChain = libraryRotate(A.Rotation_EQD_EQJ(t), vEqdVec);
  const chainSpeed = norm3(vChain);
  const st = A.ObserverState(t, new A.Observer(0, 0, 0), false);
  const libSpeed = Math.hypot(st.vx, st.vy, st.vz) * (AU_METRES / 86400);

  // §12 step 8: the same subtraction after an f32 downcast of the heliocentric coords.
  const fr = (x: number) => Math.fround(x);
  const pciF32: Vec3 = [fr(darHelio[0]) - fr(earthHelio[0]), fr(darHelio[1]) - fr(earthHelio[1]), fr(darHelio[2]) - fr(earthHelio[2])];
  const f32CancellationError = norm3([pciF32[0] - pci[0], pciF32[1] - pci[1], pciF32[2] - pci[2]]);
  const f64SubtractionError = norm3([pciBack[0] - pci[0], pciBack[1] - pci[1], pciBack[2] - pci[2]]);
  const ecefF32 = ecef.map(fr);
  const ecefErrs = ecef.map((v, i) => Math.abs(v - ecefF32[i]));
  const f32VectorError = Math.hypot(...ecefErrs);

  // §12 steps 7-8: the LocalScene hop + the single f32 downcast. Eye and door
  // are re-derived through PlanetFixed (the scene layer's own path), then
  // subtracted back in ENU — reproducing the doc's few-×1e-10 m noise class
  // (f64 ULP at Earth radius, ~1 nm). Camera faces East: three.js basis
  // x = right = −N, y = up = U, z = backward = −E (three.js Matrix4.lookAt:
  // z = eye − target, x = up × z, y = z × x). LocalScene axes are IDENTICAL to
  // the ENU anchor's axes (doc §1), so the camera basis is expressed in ENU
  // components and applied to the ENU-component door−eye vector; one f32
  // downcast, Law P-2.
  const eyeEnu = planetFixedToEnu(enuToPlanetFixed([0, 0, 1.7], SITE), SITE);
  const doorEnu = planetFixedToEnu(enuToPlanetFixed([100, 0, 3], SITE), SITE);
  const doorMinusEye: Vec3 = [doorEnu[0] - eyeEnu[0], doorEnu[1] - eyeEnu[1], doorEnu[2] - eyeEnu[2]];
  const doorMinusEyeDocSeed: Vec3 = [99.99999999963, 2.3e-11, 1.30000000032];
  const doorMinusEyeDeviationFromSeedMetres = Math.max(
    ...doorMinusEye.map((v, i) => Math.abs(v - doorMinusEyeDocSeed[i])),
  );
  const doorMinusEyeExact: Vec3 = [100, 0, 1.3];
  const doorMinusEyeMaxDeviationFromExactMetres = Math.max(
    ...doorMinusEye.map((v, i) => Math.abs(v - doorMinusEyeExact[i])),
  );
  const camXEnu: Vec3 = [0, -1, 0]; // right = −N, in ENU components
  const camYEnu: Vec3 = [0, 0, 1]; // up = U
  const camZEnu: Vec3 = [-1, 0, 0]; // backward = −E
  const camF64: Vec3 = [dot3(camXEnu, doorMinusEye), dot3(camYEnu, doorMinusEye), dot3(camZEnu, doorMinusEye)];
  const cameraSpaceF32: Vec3 = [fr(camF64[0]), fr(camF64[1]), fr(camF64[2])];

  return {
    rotationPairUsed:
      'EQJ<->EQD via astronomy-engine Rotation_EQJ_EQD / Rotation_EQD_EQJ applied ONLY through library RotateVector ' +
      '(manual row-major multiply of rot.rot is the transposed/inverse mapping; verified against the library\'s own ' +
      'ObserverVector ofdate=true/false endpoints), plus GAST (SiderealTime) as the EQD<->PlanetFixed(CTRS) z-rotation: ' +
      'the "EQJ -> EQD -> CTRS" pair. No ecliptic frame used (banned as a Kwetu frame).',
    site: SITE,
    gastDeg,
    gastDocSeedDeg: DOC_SEEDS.gastDeg,
    ecefPlanetFixed: ecef,
    ecefDocSeed: DOC_SEEDS.ecef,
    ecefVsDocSeedMaxComponentErrorMetres: Math.max(...ecef.map((v, i) => Math.abs(v - DOC_SEEDS.ecef[i]))),
    pciEqj: pci,
    pciDocSeed: DOC_SEEDS.pciEqj,
    pciVsDocSeedMaxComponentErrorMetres: Math.max(...pci.map((v, i) => Math.abs(v - DOC_SEEDS.pciEqj[i]))),
    earthHelioMetresValue: earthHelio,
    earthHelioDocSeedMetres: DOC_SEEDS.earthHelioMetres,
    darHelioMetresValue: darHelio,
    darHelioDocSeedMetres: DOC_SEEDS.darHelioMetres,
    roundTripFullChainResidualMetres,
    roundTripRotationOnlyResidualMetres,
    g01ZenithSelfConsistencyDeg: g01ZenithDeg,
    g01ZenithDocSeedDeg: DOC_SEEDS.g01ZenithDegSeed,
    libraryEndpointCheckMetres,
    libraryEllipsoidConstantNote:
      "astronomy-engine EARTH_FLATTENING = 0.996647180302104 (read from its source) is not WGS84's b/a = 0.996647189335; " +
      'the library is used only as a direction oracle (G-01), never for survey positions (COORDINATE_SYSTEM.md §5).',
    enuUpRadialChecks,
    enuUpVsGeocentricRadialAngleRad,
    transportVelocity: {
      docDerivedEquatorSpeedMetresPerSecond: EARTH_OMEGA_RAD_PER_S * norm3(rEquator),
      chainEquatorSpeedMetresPerSecond: chainSpeed,
      libraryObserverStateEquatorSpeedMetresPerSecond: libSpeed,
      chainVsLibraryDiffMetresPerSecond: chainSpeed - libSpeed,
    },
    f32QuantisationOfSitePosition: {
      maxComponentErrorMetres: Math.max(...ecefErrs),
      vectorErrorMetres: f32VectorError,
      docSeedMetres: 0.227,
    },
    f32Cancellation: {
      f64SubtractionErrorMetres: f64SubtractionError,
      f32SubtractionErrorMetres: f32CancellationError,
      f32UlpAtHelioMagnitudeMetres: 16384,
      docSeedMetres: DOC_SEEDS.f32CancellationMetres,
    },
    localSceneStep: {
      doorMinusEye,
      doorMinusEyeDocSeed,
      doorMinusEyeDeviationFromSeedMetres,
      doorMinusEyeMaxDeviationFromExactMetres,
      cameraSpaceF32,
      cameraSpaceF32DocSeed: [0, 1.3, -100],
    },
  };
}
