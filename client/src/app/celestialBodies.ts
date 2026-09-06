/**
 * Kwetu shell — the test-world body registry (Phase-1 Part B).
 *
 * Canonical positions are f64 `Frame.PlanetFixed(Earth)`, re-derived EVERY
 * frame through the real frame chain (COORDINATE_SYSTEM.md §1 — ttClock ->
 * ephemeris adapter -> frames.ts), and rendered as LocalScene coordinates
 * `ecefToEnu(bodyPf, anchorGeodetic)` — subtract-in-f64-first (Laws P-3/P-6),
 * f32-downcast at the last moment (Law P-2, one explicit call per component).
 *
 *   Frame.Helio --toPci--> Frame.Pci(Earth) --toPlanetFixed--> PlanetFixed
 *   (translation only)                          (the one rotation: GAST + EQD)
 *
 * The Sun's heliocentric position is the adapter's `Body.Sun` vector (the SSB
 * offset is deferred with Frame.Universe, §1). The Moon rides `GeoMoon` into
 * `Frame.Pci(Earth)` and rotates through `toPlanetFixed` like everything else.
 *
 * [PLACEHOLDER — ADR-003] all meshes are smooth primitives with procedural
 * textures at fixed segment counts. The single-mesh full-Earth sphere carries
 * ~0.5 m f32 vertex quantization at planetary radius (COORDINATE_SYSTEM.md §6
 * ladder) and shows image steps while moving close to the surface — that is
 * the known limitation ADR-003's planet-LOD strategy exists to remove; the
 * body-registry / re-derivation boundary here is the shape that fix plugs
 * into. No visual-fidelity claim is made.
 */
import * as THREE from 'three';
import * as A from 'astronomy-engine';
import {
  ecefToEnu,
  enuBasis,
  type GeodeticCoord,
} from '../engine/geodesy';
import {
  earthHelioPositionMetres,
  geoMoonPositionMetres,
  helioPositionMetres,
} from '../engine/ephemeris';
import { toPci, toPlanetFixed } from '../engine/frames';
import { f32Downcast } from '../engine/precision';
import type { Vec3 } from '../engine/vec3';
import { makeEarthTexture, makeSunSpriteTexture } from './textures';

/**
 * Moon mean radius, metres. [EXTERNAL — NASA/IAU Moon fact sheet mean radius]
 * Body constants are not yet ledgered in DATA_SOURCES.md — recorded as a doc
 * follow-up; nothing survey-grade consumes this (visual placeholder only).
 */
export const MOON_MEAN_RADIUS_METRES = 1_737_400;

/** Star backdrop sphere radius, metres from the scene origin (the anchor). */
const STAR_SPHERE_RADIUS_METRES = 5e10;
const STAR_COUNT = 1500;
/** Sun billboard world size, metres (constant angular size, not physical). */
const SUN_BILLBOARD_METRES = 2e9;

export class CelestialBodies {
  readonly group = new THREE.Group();
  private readonly earth: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly sun: THREE.Sprite;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchQuat = new THREE.Quaternion();

  constructor(earthRadiusMetres: number) {
    // --- Earth: PlanetFixed-aligned sphere (poles baked to +z = north, §8) ---
    const earthGeometry = new THREE.SphereGeometry(earthRadiusMetres, 256, 128);
    earthGeometry.rotateX(Math.PI / 2);
    const earthTexture = makeEarthTexture();
    const earthMaterial = new THREE.MeshLambertMaterial({ map: earthTexture });
    this.earth = new THREE.Mesh(earthGeometry, earthMaterial);
    this.disposables.push(earthGeometry, earthTexture, earthMaterial);

    // --- Moon ---
    const moonGeometry = new THREE.SphereGeometry(MOON_MEAN_RADIUS_METRES, 96, 48);
    const moonMaterial = new THREE.MeshLambertMaterial({ color: 0x9a9a92 });
    this.moon = new THREE.Mesh(moonGeometry, moonMaterial);
    this.disposables.push(moonGeometry, moonMaterial);

    // --- Sun: directional light + billboard sprite at its ephemeris position ---
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.target.position.set(0, 0, 0); // scene origin = the anchor
    const sunTexture = makeSunSpriteTexture();
    const sunMaterial = new THREE.SpriteMaterial({ map: sunTexture, depthWrite: false });
    this.sun = new THREE.Sprite(sunMaterial);
    this.sun.scale.set(SUN_BILLBOARD_METRES, SUN_BILLBOARD_METRES, 1);
    this.disposables.push(sunTexture, sunMaterial);

    // Faint ambient so the night side is not pure black.
    const ambient = new THREE.AmbientLight(0xffffff, 0.05);

    this.group.add(this.earth, this.moon, this.sun, this.sunLight, this.sunLight.target, ambient);
    this.group.add(makeStars(this.disposables));
  }

  /**
   * Re-derives every body's LocalScene transform from its f64 canonical
   * PlanetFixed state under `anchorGeodetic` (Law P-6) and downcasts at the
   * render boundary (Law P-2). Called once per frame with the authoritative
   * TT instant.
   */
  update(worldTimeTtSeconds: number, anchorGeodetic: GeodeticCoord): void {
    // `Frame.PlanetFixed(Earth)` origin IS the body centre (§1 — the body-
    // fixed frame is defined at the body centre; the ephemeris position of
    // Earth enters the chain through the Moon/Sun translations below).
    const earthPf: Vec3 = { x: 0, y: 0, z: 0 };

    const earthHelio = earthHelioPositionMetres(worldTimeTtSeconds);
    const sunPf = toPlanetFixed(toPci(helioPositionMetres(A.Body.Sun, worldTimeTtSeconds), earthHelio), 'Earth', worldTimeTtSeconds).xyz;
    const moonPf = toPlanetFixed(geoMoonPositionMetres(worldTimeTtSeconds), 'Earth', worldTimeTtSeconds).xyz;

    this.setLocalPosition(this.earth, earthPf, anchorGeodetic);
    this.setLocalPosition(this.moon, moonPf, anchorGeodetic);
    this.setLocalPosition(this.sun, sunPf, anchorGeodetic);
    this.setLocalPosition(this.sunLight, sunPf, anchorGeodetic);

    // §8: a changed ENU anchor rotates axes as well as translating. The ENU
    // basis ROWS (E, N, U) are the PlanetFixed -> LocalScene rotation for
    // orientations; re-derived every frame in f64 like the positions.
    const basis = enuBasis(anchorGeodetic.latitudeDeg, anchorGeodetic.longitudeDeg);
    this.scratchMatrix.set(
      basis.east.x, basis.east.y, basis.east.z, 0,
      basis.north.x, basis.north.y, basis.north.z, 0,
      basis.up.x, basis.up.y, basis.up.z, 0,
      0, 0, 0, 1,
    );
    this.scratchQuat.setFromRotationMatrix(this.scratchMatrix);
    this.earth.quaternion.copy(this.scratchQuat);
    this.moon.quaternion.copy(this.scratchQuat);
  }

  /** PlanetFixed (f64) -> LocalScene (f64) -> one explicit f32 downcast (Law P-2). */
  private setLocalPosition(object: THREE.Object3D, planetFixed: Vec3, anchorGeodetic: GeodeticCoord): void {
    const local = ecefToEnu(planetFixed, anchorGeodetic);
    object.position.set(f32Downcast(local.x), f32Downcast(local.y), f32Downcast(local.z));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}

/**
 * Star backdrop: seeded deterministic points on a large sphere centred on the
 * scene origin. Directions are drawn in f64 and downcast into the f32
 * attribute — the one lawful render-boundary crossing (Law P-2). Magnitude
 * 5e10 m in f32 has ~4 km spacing [derived, §6 ladder]: an 8e-8 rad angular
 * wobble, invisible by construction.
 */
function makeStars(disposables: Array<{ dispose(): void }>): THREE.Points {
  // Seeded LCG — the backdrop is decor, but deterministic beats not.
  let seed = 0x4b36;

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const z = (seed / 0xffffffff) * 2 - 1;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const theta = (seed / 0xffffffff) * Math.PI * 2;
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    positions[i * 3] = f32Downcast(STAR_SPHERE_RADIUS_METRES * ring * Math.cos(theta));
    positions[i * 3 + 1] = f32Downcast(STAR_SPHERE_RADIUS_METRES * ring * Math.sin(theta));
    positions[i * 3 + 2] = f32Downcast(STAR_SPHERE_RADIUS_METRES * z);
    const brightness = 0.35 + (seed % 64) / 96;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness;
    colors[i * 3 + 2] = brightness;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  const points = new THREE.Points(geometry, material);
  disposables.push(geometry, material);
  return points;
}
