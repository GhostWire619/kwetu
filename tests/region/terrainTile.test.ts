/**
 * Region terrain placement math — headless (no WebGL, no network): the
 * pure f64 functions terrainTile.ts exports, which RegionTerrain.update()
 * consumes. The GLB fetch/parse/validation path is covered by the e2e
 * (tests/e2e/region.pw.ts) against the real baked artifact.
 */
import { describe, expect, it } from 'vitest';
import {
  radialFromGeodetic,
  tileMountPlanetFixed,
  tilePlacement,
  TILE_MOUNT_OFFSET_METRES,
} from '../../client/src/region/terrainTile';
import {
  ecefToGeodetic,
  enuBasis,
  enuToEcef,
  type GeodeticCoord,
} from '../../client/src/engine/geodesy';
import { norm3, subV, type Vec3 } from '../../client/src/engine/vec3';

const STONE_TOWN_ANCHOR: GeodeticCoord = { latitudeDeg: -6.21, longitudeDeg: 39.14, heightMetres: 0 };
const SPHERE_RADIUS = 6371000;

describe('region/terrainTile — placeholder-sphere mount', () => {
  it('mounts at sphere radius + offset along the anchor radial (f64)', () => {
    const mount = tileMountPlanetFixed(STONE_TOWN_ANCHOR, SPHERE_RADIUS, TILE_MOUNT_OFFSET_METRES);
    const radial = radialFromGeodetic(STONE_TOWN_ANCHOR.latitudeDeg, STONE_TOWN_ANCHOR.longitudeDeg);
    // Radial distance from centre = sphere + offset exactly (the offset is
    // applied along the anchor's geodetic up, which is parallel to the radial
    // here — both derive from the same lat/lon).
    expect(Math.abs(norm3(mount) - (SPHERE_RADIUS + TILE_MOUNT_OFFSET_METRES))).toBeLessThan(1e-6);
    // And it points along the geodetic radial: cross product ~ 0.
    const cross: Vec3 = {
      x: radial.y * mount.z - radial.z * mount.y,
      y: radial.z * mount.x - radial.x * mount.z,
      z: radial.x * mount.y - radial.y * mount.x,
    };
    expect(norm3(cross)).toBeLessThan(1e-9);
  });
});

describe('region/terrainTile — Law P-6 placement under the rig anchor', () => {
  // The app models the rig anchor the way CameraRig does: cameraPf is a
  // radial point and the anchor is ecefToGeodetic(cameraPf) — a consistent
  // (point, geodetic) pair, NOT a hand-written geodetic (whose ellipsoid
  // position sits ~7 km away from the placeholder sphere [derived]).
  function rigAnchorAt(latitudeDeg: number, longitudeDeg: number, altitude: number): GeodeticCoord {
    const radial = radialFromGeodetic(latitudeDeg, longitudeDeg);
    const cameraPf: Vec3 = { x: radial.x * (SPHERE_RADIUS + altitude), y: radial.y * (SPHERE_RADIUS + altitude), z: radial.z * (SPHERE_RADIUS + altitude) };
    return ecefToGeodetic(cameraPf);
  }

  it('camera directly above the mount: tile origin ~250 m below, axes at the deflection band', () => {
    const mount = tileMountPlanetFixed(STONE_TOWN_ANCHOR, SPHERE_RADIUS, TILE_MOUNT_OFFSET_METRES);
    const placement = tilePlacement(mount, enuBasis(STONE_TOWN_ANCHOR.latitudeDeg, STONE_TOWN_ANCHOR.longitudeDeg), rigAnchorAt(STONE_TOWN_ANCHOR.latitudeDeg, STONE_TOWN_ANCHOR.longitudeDeg, 300));
    // Camera 300 m above the sphere, mount +50 m up the same radial: the tile
    // origin sits ~250 m straight below, horizontal components only at the
    // ellipsoid-normal deflection scale (radial vs geodetic up ~4e-4 rad ×
    // 250 m ≈ 0.1 m [derived]).
    expect(Math.abs(placement.positionMetres.z - -250)).toBeLessThan(0.5);
    expect(Math.abs(placement.positionMetres.x) + Math.abs(placement.positionMetres.y)).toBeLessThan(1);
    // Same site: tile axes vs rig axes agree to the deflection angle class.
    const [east, north, up] = placement.axisColumns;
    expect(Math.abs(east.x - 1) + Math.abs(east.y) + Math.abs(east.z)).toBeLessThan(1e-3);
    expect(Math.abs(north.y - 1) + Math.abs(north.x) + Math.abs(north.z)).toBeLessThan(1e-3);
    expect(Math.abs(up.z - 1) + Math.abs(up.x) + Math.abs(up.y)).toBeLessThan(1e-3);
  });

  it('from an anchor displaced east, the tile origin lands west by the ground distance', () => {
    // 0.01 deg of longitude at -6.21 deg latitude ≈ 2π·N·cosφ·(0.01/360)
    // ≈ 1113 m [derived — the same first-order constant the terrain manifest
    // uses]. Second-order terms (sphere curvature s²/2R ≈ 0.1 m, plus the
    // radial-vs-normal deflection across the arc) land in the ~1 m class —
    // the bound is 2 m, far above that class and far below any real error.
    const anchorLon = 39.15;
    const mount = tileMountPlanetFixed(STONE_TOWN_ANCHOR, SPHERE_RADIUS, TILE_MOUNT_OFFSET_METRES);
    const placement = tilePlacement(mount, enuBasis(STONE_TOWN_ANCHOR.latitudeDeg, STONE_TOWN_ANCHOR.longitudeDeg), rigAnchorAt(STONE_TOWN_ANCHOR.latitudeDeg, anchorLon, 300));
    const groundDistance = ((anchorLon - STONE_TOWN_ANCHOR.longitudeDeg) / 360) * 2 * Math.PI * 6378137 * Math.cos((-6.21 * Math.PI) / 180);
    expect(placement.positionMetres.x).toBeLessThan(0); // west of the anchor
    expect(Math.abs(placement.positionMetres.x - -groundDistance)).toBeLessThan(2);
    // The up-offset survives: ~200 m below the camera as at the home site.
    expect(Math.abs(placement.positionMetres.z - -250)).toBeLessThan(2);
    // Separation ~1.1 km on a 6.4e6 m sphere: the axis rotation carries the
    // arc term (~1.1e3/6.4e6 ≈ 1.7e-4 rad) AND the geodetic↔geocentric
    // deflection at this latitude (e²·sinφ·cosφ ≈ 7.2e-4 rad [derived]) —
    // the rig anchor is a radial point while the tile basis is geodetic. The
    // columns are within 1e-3 of identity.
    const [east, north, up] = placement.axisColumns;
    for (const [column, axis] of [[east, 'x'], [north, 'y'], [up, 'z']] as const) {
      const identity: Vec3 = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
      const deviation = norm3(subV(column, identity));
      expect(deviation, `axis ${axis} deviation`).toBeLessThan(1e-3);
    }
  });

  it('placement position round-trips: enuToEcef(position, rigAnchor) ≈ mount', () => {
    const anchor = rigAnchorAt(-6.19, 39.16, 550);
    const mount = tileMountPlanetFixed(STONE_TOWN_ANCHOR, SPHERE_RADIUS, TILE_MOUNT_OFFSET_METRES);
    const placement = tilePlacement(mount, enuBasis(STONE_TOWN_ANCHOR.latitudeDeg, STONE_TOWN_ANCHOR.longitudeDeg), anchor);
    const back = enuToEcef(placement.positionMetres, anchor);
    expect(norm3(subV(back, mount))).toBeLessThan(1e-4);
  });
});
