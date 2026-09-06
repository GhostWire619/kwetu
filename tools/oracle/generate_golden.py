#!/usr/bin/env python3
"""S0.11 golden-ephemeris oracle generator (tools/oracle/generate_golden.py).

Offline, build-time ONLY (COORDINATE_SYSTEM.md §11): reads the locally cached
JPL DE440s kernel from .bake/ephemeris/de440s.bsp (gitignored; never committed)
and emits committed golden fixtures under tests/golden/ephemeris/.

Oracle conventions (stated precisely — the fixtures are the contract):

- Frame: ICRF axes exactly as tabulated in de440s.bsp (the kernel's own
  reference frame; de440s is ICRF-oriented). No rotation, no aberration, no
  deflection is applied to the emitted Cartesian vectors unless a row says so.
- Geocentric rows (Sun / Moon / Mars): astrometric positions as seen from the
  Earth geocenter, SPICE body 399, i.e. skyfield
  ``earth.at(t).observe(body).position.km`` — light-travel-time corrected,
  aberration NOT applied, ICRF axes, origin = geocenter. This is the closest
  skyfield analogue of astronomy-engine ``GeoVector(body, t, aberration=false)``.
- Mars row: SPICE body 4, the Mars system barycenter. de440s does NOT contain
  the Mars center (499) — verified at generation time from the kernel's own
  target list. The Mars system barycenter sits within meters of the Mars center
  (Phobos offset ~0.16 m) [derived], far inside every tolerance in play.
- Earth row: emitted three ways, all geometric (same-instant kernel differences,
  no light time — these are origin-bookkeeping vectors, not observations):
  (a) ``earth_barycentric_km``  = position of 399, origin SSB, ICRF km;
  (b) ``emb_barycentric_km``    = position of 3 (Earth-Moon barycenter), origin SSB, ICRF km;
  (c) ``emb_to_earth_km``       = (a) - (b), the Earth-vs-EMB offset, ICRF km.
  astronomy-engine's comparable quantity for (c) is
  ``HelioVector(Earth) - HelioVector(EMB)`` (a difference, so its Sun-origin EQJ
  frame is equivalent to within the ~0.02 arcsec ICRS<->EQJ frame bias).
- Topocentric rows (Moon alt/az, Dar es Salaam): WGS84 lat/lon
  (-6.79 deg, +39.21 deg, elevation 0 m), ``apparent().altaz()`` — aberration
  and gravitational deflection applied by skyfield, refraction NOT applied
  (pressure 0), azimuth degrees clockwise from north, altitude degrees. No
  polar motion (no finals2000A loaded) — skyfield and astronomy-engine both run
  unpolarized Earth rotation, so the residual term is symmetrical.
- Time: skyfield ``load.timescale(builtin=True)`` (bundled leap seconds + built
  in delta-T approximation; no finals2000A). Every row records the skyfield
  ``t.tt`` value (TT days since the J2000 TT epoch) so astronomy-engine can be
  evaluated at the *identical* TT instant via ``AstroTime.FromTerrestrialTime``.
  Topocentric rows are additionally evaluated at the same civil UTC instant in
  both libraries; their residual therefore includes a delta-T model term
  (Earth rotation differs by ~15 arcsec per second of delta-T disagreement)
  [derived].

Regenerate:  python tools/oracle/generate_golden.py
Pin:         skyfield version printed into the fixture metadata at run time.
Kernel:      .bake/ephemeris/de440s.bsp, sha256 pinned in KERNEL_SHA256 below;
             source URL https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp
"""

import datetime
import hashlib
import json
import platform
import sys
from pathlib import Path

import skyfield
from skyfield.api import load, load_file, wgs84

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL_PATH = REPO_ROOT / ".bake" / "ephemeris" / "de440s.bsp"
OUT_DIR = REPO_ROOT / "tests" / "golden" / "ephemeris"
OUT_FILE = OUT_DIR / "ephemeris-golden.json"

# Pin: sha256 of de440s.bsp, verified against the live JPL download
# (Content-Length 32726016, Last-Modified 2020-12-22) on 2026-09-06.
KERNEL_SHA256 = "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"
KERNEL_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp"

SITE = {
    "name": "Dar es Salaam seafront (COORDINATE_SYSTEM.md §12 site)",
    "lat_deg": -6.79,
    "lon_deg": 39.21,
    "elevation_m": 0,
}

# 8 dates spanning 1990..2030 including the committed S0.1 seed instant.
DATES_UTC = [
    (1990, 1, 1, 0, 0, 0),
    (1999, 12, 31, 12, 0, 0),
    (2009, 3, 20, 11, 44, 0),
    (2017, 8, 21, 18, 25, 0),
    (2020, 6, 21, 6, 39, 0),
    (2026, 9, 5, 0, 0, 0),
    (2028, 7, 4, 0, 0, 0),
    (2030, 1, 1, 0, 0, 0),
]

# Dates that also carry the topocentric Moon alt/az rows.
TOPOCENTRIC_DATES = {(2026, 9, 5, 0, 0, 0), (2017, 8, 21, 18, 25, 0)}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not KERNEL_PATH.exists():
        print(f"ERROR: kernel missing: {KERNEL_PATH}", file=sys.stderr)
        print(
            "Fetch it from " + KERNEL_URL + " into .bake/ephemeris/ (gitignored).",
            file=sys.stderr,
        )
        return 2

    digest = sha256_of(KERNEL_PATH)
    if digest != KERNEL_SHA256:
        print(
            f"ERROR: kernel sha256 mismatch: got {digest}, expected {KERNEL_SHA256}",
            file=sys.stderr,
        )
        return 2

    ts = load.timescale(builtin=True)
    eph = load_file(str(KERNEL_PATH))

    targets = sorted(eph.names())
    missing = {10, 301, 399, 3, 4} - set(targets)
    if missing:
        print(f"ERROR: kernel lacks required targets {sorted(missing)}", file=sys.stderr)
        return 2
    if 499 in targets:
        print("NOTE: kernel contains Mars center 499; using barycenter 4 anyway "
              "for cross-library consistency.", file=sys.stderr)

    earth = eph["earth"]          # 399 geocenter
    emb = eph["earth_barycenter"] # 3
    moon = eph["moon"]            # 301
    mars = eph["mars_barycenter"] # 4
    sun = eph["sun"]              # 10

    rows = []
    for y, mo, d, h, mi, s in DATES_UTC:
        t = ts.utc(y, mo, d, h, mi, s)
        iso = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}Z"

        def geocentric(body):
            """Astrometric geocentric ICRF km (light-time, no aberration)."""
            v = earth.at(t).observe(body).position.km
            return {"x": v[0], "y": v[1], "z": v[2]}

        def barycentric(body):
            v = body.at(t).position.km
            return {"x": v[0], "y": v[1], "z": v[2]}

        p399 = barycentric(earth)
        p3 = barycentric(emb)
        emb_to_earth = {k: p399[k] - p3[k] for k in p399}

        row = {
            "isoUtc": iso,
            # TT instant, two conventions: skyfield's t.tt is a full Julian
            # Date in TT; astronomy-engine's TT is days since the J2000 TT
            # epoch (JD 2451545.0 TT). Both are recorded so consumers pin the
            # mapping rather than infer it.
            "ttJulianDate": float(t.tt),
            "ttDaysSinceJ2000TT": float(t.tt) - 2451545.0,
            "deltaTSeconds": float(t.delta_t),
            "geocentricAstrometricICRFkm": {
                "sun": geocentric(sun),
                "moon": geocentric(moon),
                "marsBarycenter": geocentric(mars),
            },
            "earthBarycentricICRFkm": p399,
            "embBarycentricICRFkm": p3,
            "embToEarthICRFkm": emb_to_earth,
        }

        if (y, mo, d, h, mi, s) in TOPOCENTRIC_DATES:
            topos = earth + wgs84.latlon(
                SITE["lat_deg"], SITE["lon_deg"], elevation_m=SITE["elevation_m"]
            )
            apparent = (topos).at(t).observe(moon).apparent()
            alt, az, dist = apparent.altaz()
            row["topocentricMoonApparentDarEsSalaam"] = {
                "altDeg": alt.degrees,
                "azDeg": az.degrees,
                "distanceKm": dist.km,
            }

        rows.append(row)

    fixture = {
        "schema": "kwetu.golden.ephemeris/1",
        "generatedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "generator": "tools/oracle/generate_golden.py",
        "oracle": {
            "library": "skyfield",
            "skyfieldVersion": skyfield.__version__,
            "pythonVersion": platform.python_version(),
            "kernel": {
                "file": "de440s.bsp",
                "sha256": KERNEL_SHA256,
                "bytes": KERNEL_PATH.stat().st_size,
                "sourceUrl": KERNEL_URL,
                "dateRange": "1849-2150 [EXTERNAL — JPL DE440/DE440s release notes]",
                "targets": targets,
            },
            "conventions": {
                "frame": "ICRF axes exactly as tabulated in de440s.bsp",
                "geocentricRows": (
                    "astrometric: origin = Earth geocenter (SPICE 399), "
                    "light-travel-time corrected, NO aberration, NO deflection; "
                    "skyfield earth.at(t).observe(body).position.km"
                ),
                "marsRow": (
                    "SPICE body 4 (Mars system barycenter); de440s has no Mars "
                    "center (499); barycenter-center offset < 1 m [derived]"
                ),
                "earthRow": (
                    "geometric same-instant kernel positions (no light time): "
                    "399 barycentric, 3 barycentric, and their difference "
                    "(EMB -> Earth offset)"
                ),
                "topocentricRows": (
                    "WGS84 lat/lon, apparent().altaz(): aberration + gravitational "
                    "deflection applied, NO refraction (pressure 0), azimuth "
                    "clockwise from north, elevation 0 m above the WGS84 "
                    "ellipsoid, no polar motion"
                ),
                "time": (
                    "skyfield load.timescale(builtin=True): bundled leap seconds + "
                    "builtin delta-T approximation, no finals2000A; ttJulianDate "
                    "(TT JD) and ttDaysSinceJ2000TT (TT days after JD 2451545.0) "
                    "recorded per row so consumers evaluate at the identical TT "
                    "instant — astronomy-engine's FromTerrestrialTime takes the "
                    "days-since-J2000 form"
                ),
            },
            "site": SITE,
            "regenerateCommand": "python tools/oracle/generate_golden.py",
        },
        "rows": rows,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {OUT_FILE.relative_to(REPO_ROOT)}")
    print(f"kernel sha256 OK: {digest}")
    print(f"skyfield {skyfield.__version__}, python {platform.python_version()}, "
          f"kernel {KERNEL_PATH.stat().st_size} bytes, targets {targets}")
    for row in rows:
        moon_km = row["geocentricAstrometricICRFkm"]["moon"]
        top = row.get("topocentricMoonApparentDarEsSalaam")
        extra = (
            f" | moon alt {top['altDeg']:.6f} az {top['azDeg']:.6f}" if top else ""
        )
        print(
            f"  {row['isoUtc']} ttJD {row['ttJulianDate']:.8f} "
            f"dT {row['deltaTSeconds']:.3f}s moon km ({moon_km['x']:.1f}, "
            f"{moon_km['y']:.1f}, {moon_km['z']:.1f}){extra}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
