#!/usr/bin/env python3
"""Kepler golden-fixture oracle generator (tools/oracle/generate_kepler.py).

Offline, build-time ONLY (COORDINATE_SYSTEM.md §11): reads the locally cached
JPL DE440s kernel from .bake/ephemeris/de440s.bsp (gitignored; never
committed) and emits tests/golden/kepler/kepler-earth.json — the real-ephemeris
fixture that tests/engine/orbits.test.ts uses to measure the two-body Kepler
propagator against the actual Solar System.

What each row is (stated precisely — the fixture is the contract):

- Pair: Earth geocenter (SPICE 399) relative to the Sun proper (SPICE 10),
  geometric same-instant kernel difference, ICRF axes exactly as tabulated in
  de440s.bsp, metres. This is the closest two-body reduction of the real
  ephemeris: r_helio(t) = earth.at(t).position - sun.at(t).position.
- r0m / r1m: that pair at t0 and t1 = t0 + dtSeconds (600 s), ICRF, metres.
- v0m / v1m: velocity by the PRESCRIBED central difference over +/-300 s:
      v(t) ~ (r(t + 300 s) - r(t - 300 s)) / 600 s
  Its truncation error is (h^2/6) * r'''(xi) for some xi inside the stencil,
  h = 300 s [derived — standard central-difference expansion; the "a*dt^2/6"
  shorthand holds while |r'''| ~ a*n ~ mu*v/r^3]. For the Earth-Sun pair
  |r'''| ~ 1.2e-9 m/s^3 (see jerkEstimateMPerS3), so |dv| ~ 2e-5 m/s and the
  propagated-position effect over 600 s is ~0.013 m — well inside the genuine
  two-body-vs-N-body model gap (~6 m, Moon-dominated). CRITICAL: the stencil
  instants are built on skyfield's whole/fraction JD split (see offset());
  naive f64 JD arithmetic quantizes each instant at ~4e-5 s (~1.2 m of Earth
  motion), which aliases into the stencil and inflates |dv| to ~1.8e-3 m/s
  [MEASURED 2026-09-06, both constructions]. The fixture also records:
  v0mFivePoint / v1mFivePoint — the 5-point central difference
      [-r(t+2h) + 8 r(t+h) - 8 r(t-h) + r(t-2h)] / (12 h),  h = 300 s,
  whose truncation error is O(h^4 r''''') ~ 1e-15 m/s [derived: |r'''''| ~
  A n^5 ~ 1.5e11 * (2e-7)^5 ~ 5e-23 m/s^5 for the pair] with kernel-evaluation
  noise ~5e-7 m/s [derived: ~1e-4 m last-bit Chebyshev noise per position,
  ~1.8e-3 m in the numerator, / (12 h)]. It exists so consumers can VERIFY the
  (h^2/6) r''' differencing model against kernel positions ALONE — [MEASURED
  2026-09-06: |v_central - v_five_point| matches (h^2/6) r'''(t0) to 1e-8 m/s,
  while the kernel's own Chebyshev-differentiated velocity
  (v0mKernelAnalytic / v1mKernelAnalytic, kept as a diagnostic) disagrees with
  the finite-difference derivative by 2.5e-6 .. 4.8e-6 m/s — the
  Chebyshev-fit-derivative error class, NOT a stencil error. The earlier
  v_central-vs-kernel-analytic comparison therefore runs ~27% over (h^2/6)
  jerk on the 2026 row and must not be used as the model check.] and a jerk
  estimate jerkEstimateMPerS3 so the test's tolerance is DERIVED from fixture
  data, not hardcoded.
- jerkEstimateMPerS3: max |r'''| over t0-300 s .. t1 via
      r'''(t) ~ [r(t+2h) - 2 r(t+h) + 2 r(t-h) - r(t-2h)] / (2 h^3),
  h = 300 s, on the heliocentric pair. (Shorter stencils are noise-limited:
  the last bits of the Chebyshev evaluation put ~1e-4 m of noise in the
  numerator, which at h = 10 s swamps the ~1e-9 signal [MEASURED].)
- perturbationAccelMPerS2: |sum_b GM_b [(r_E-r_b)/d_Eb^3 - (r_S-r_b)/d_Sb^3]|
  over all nine other massive bodies, GMs parsed from the kernel's own DAF
  header (the constants DE440s integrates), at t0 — the N-body-minus-two-body
  relative acceleration; relativity and the solar quadrupole are neglected
  (~6e-11 m/s^2 at Earth [derived: a*(v/c)^2]). The test derives its model-gap
  allowance as 0.5 * this * dtSeconds^2 (rigorous while |a_pert| <= this).
- Time: skyfield load.timescale(builtin=True). Rows record t0/t1 as UTC ISO
  plus skyfield's ttJulianDate for both instants. dtSeconds is EXACTLY the
  propagation interval in TT seconds: TT-UTC is piecewise constant (leap
  seconds) and neither window here contains one, so a 600 s UTC interval is a
  600 s TT interval [derived].
- Frames: ICRF in, ICRF out. The Kepler propagator under test is
  frame-agnostic (mu + state in the caller's inertial frame, same frame out),
  so this fixture tests dynamics only. The ICRF<->EQJ frame-bias conversion
  (to plug the same oracle into the EQJ engine frame chain) is a rocket-phase
  follow-up and is deliberately NOT folded in here.

Regenerate:  python tools/oracle/generate_kepler.py
Pin:         skyfield version + kernel sha256 recorded into the fixture.
Kernel:      .bake/ephemeris/de440s.bsp, sha256 pinned below (matches
             tools/oracle/generate_golden.py).
"""

import datetime
import hashlib
import json
import platform
import re
import sys
from pathlib import Path

import skyfield
from skyfield.api import load, load_file

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL_PATH = REPO_ROOT / ".bake" / "ephemeris" / "de440s.bsp"
OUT_DIR = REPO_ROOT / "tests" / "golden" / "kepler"
OUT_FILE = OUT_DIR / "kepler-earth.json"

# Pin: sha256 of de440s.bsp, verified against the live JPL download
# (Content-Length 32726016, Last-Modified 2020-12-22) on 2026-09-06.
KERNEL_SHA256 = "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"
KERNEL_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp"

DT_SECONDS = 600.0          # the row's propagation interval
DIFF_H_SECONDS = 300.0      # central-difference half-stencil for velocity
JERK_H_SECONDS = 300.0      # half-stencil for the jerk estimate (2h = +/-600 s)

# Two rows: the committed S0.1/S0.11 seed instant and the 2009 equinox row
# (both also live in tests/golden/ephemeris/ephemeris-golden.json).
DATES_UTC = [
    (2026, 9, 5, 0, 0, 0),
    (2009, 3, 20, 11, 44, 0),
]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not KERNEL_PATH.exists():
        print(f"ERROR: kernel missing: {KERNEL_PATH}", file=sys.stderr)
        print("Fetch it from " + KERNEL_URL + " into .bake/ephemeris/ (gitignored).", file=sys.stderr)
        return 2

    digest = sha256_of(KERNEL_PATH)
    if digest != KERNEL_SHA256:
        print(f"ERROR: kernel sha256 mismatch: got {digest}, expected {KERNEL_SHA256}", file=sys.stderr)
        return 2

    ts = load.timescale(builtin=True)
    eph = load_file(str(KERNEL_PATH))
    earth = eph["earth"]  # 399 geocenter
    sun = eph["sun"]      # 10 Sun proper

    # GM table parsed from the kernel's own DAF header (the header.440 text
    # embedded in the file — the constants DE440s actually integrates), the
    # third column, km^3/s^2. Only single-line rows are needed here; the GMB
    # row wraps in the header text and is not among the perturbers.
    header_text = KERNEL_PATH.read_bytes()[:65536].decode("latin-1")
    gm_km3_s2: dict[str, float] = {}
    for m in re.finditer(r"GM([1-9M])\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)", header_text):
        gm_km3_s2[m.group(1)] = float(m.group(4))
    GM_BY_NAME = {
        "mercury_barycenter": gm_km3_s2["1"],
        "venus_barycenter": gm_km3_s2["2"],
        "moon": gm_km3_s2["M"],
        "mars_barycenter": gm_km3_s2["4"],
        "jupiter_barycenter": gm_km3_s2["5"],
        "saturn_barycenter": gm_km3_s2["6"],
        "uranus_barycenter": gm_km3_s2["7"],
        "neptune_barycenter": gm_km3_s2["8"],
        "pluto_barycenter": gm_km3_s2["9"],
    }

    def perturbation_accel_m_per_s2(t) -> float:
        """|sum_b GM_b [(r_E-r_b)/d_E^3 - (r_S-r_b)/d_S^3]| — the N-body-minus-
        two-body relative acceleration on the Earth-Sun pair, from the kernel
        itself (relativistic and solar-quadrupole terms neglected: ~6e-11 m/s^2
        at Earth [derived: a*(v/c)^2])."""
        import numpy as np

        pe = np.array(earth.at(t).position.km)
        ps = np.array(sun.at(t).position.km)
        acc = np.zeros(3)
        for name, gm_km3 in GM_BY_NAME.items():
            pb = np.array(eph[name].at(t).position.km)
            de = pe - pb
            ds = ps - pb
            acc += gm_km3 * (de / np.linalg.norm(de) ** 3 - ds / np.linalg.norm(ds) ** 3)
        return float(np.linalg.norm(acc)) * 1e3  # km/s^2 -> m/s^2

    def helio_m(t) -> dict:
        """Earth-minus-Sun geometric kernel difference, ICRF, metres."""
        pe = earth.at(t).position.km
        ps = sun.at(t).position.km
        return {"x": (pe[0] - ps[0]) * 1000.0, "y": (pe[1] - ps[1]) * 1000.0, "z": (pe[2] - ps[2]) * 1000.0}

    def pair_vel_m_per_s(t) -> dict:
        """Kernel's own analytic velocity of the pair (diagnostic)."""
        ve = earth.at(t).velocity.km_per_s
        vs = sun.at(t).velocity.km_per_s
        return {"x": (ve[0] - vs[0]) * 1000.0, "y": (ve[1] - vs[1]) * 1000.0, "z": (ve[2] - vs[2]) * 1000.0}

    def offset(t_base, dt_seconds: float):
        """A Time dt_seconds from t_base, built on the whole/fraction split.

        Plain f64 JD arithmetic (t.tt + dt/86400) quantizes the instant on the
        f64 grid at JD ~2.46e6 (ulp ~4e-10 day = 4e-5 s ~ 1.2 m of Earth
        motion) and that sawtooth aliases into every finite-difference stencil
        [MEASURED 2026-09-06: |v_central - v_analytic| was 1.78e-3 m/s with the
        naive construction, 2.2e-5 m/s with this one]. Keeping the offset in
        the fraction (magnitude ~0.5, relative error ~1e-16) bounds the
        absolute time error at ~1e-11 s [derived].
        """
        return ts.tt_jd(t_base.whole, float(t_base.tt_fraction) + dt_seconds / 86400.0)

    def vel_central_m_per_s(t0) -> dict:
        """Prescribed central difference over +/-DIFF_H_SECONDS, metres/second."""
        h = DIFF_H_SECONDS
        rp = helio_m(offset(t0, +h))
        rm = helio_m(offset(t0, -h))
        return {k: (rp[k] - rm[k]) / (2.0 * h) for k in rp}

    def vel_five_point_m_per_s(t0) -> dict:
        """5-point central difference [-r(t+2h) + 8r(t+h) - 8r(t-h) + r(t-2h)]/(12h).

        Same h as the prescribed velocity stencil. Its truncation error is
        O(h^4 * r^(5)) ~ 1e-15 m/s for this pair [derived: |r^(5)| ~
        A*n^5 ~ 1.5e11*(2e-7)^5 ~ 5e-23 m/s^5, times h^4 = 8.1e9], with
        kernel-evaluation noise ~5e-7 m/s [derived: ~1e-4 m last-bit
        Chebyshev noise per position, ~1.8e-3 m in the numerator, / (12h)].
        It exists so consumers can verify the (h^2/6) r''' differencing
        model against kernel POSITIONS alone: |v_central - v_five_point| =
        (h^2/6)*r'''(xi) for some xi in the stencil [derived — the
        central-difference remainder against the higher-order estimate].
        The kernel's own Chebyshev-differentiated velocity
        (v0mKernelAnalytic, kept as a diagnostic) is NOT usable for that
        check: it disagrees with the finite-difference derivative by the
        Chebyshev-fit-derivative error class (2.5e-6 .. 4.8e-6 m/s
        [MEASURED 2026-09-06]), which is why the earlier
        v_central-vs-kernel-analytic comparison ran ~27% over (h^2/6)*jerk
        on the 2026 row."""
        h = DIFF_H_SECONDS
        p2p = helio_m(offset(t0, +2 * h))
        php = helio_m(offset(t0, +h))
        phm = helio_m(offset(t0, -h))
        p2m = helio_m(offset(t0, -2 * h))
        return {k: (-p2p[k] + 8.0 * php[k] - 8.0 * phm[k] + p2m[k]) / (12.0 * h) for k in p2p}

    def jerk_mag_at_m_per_s3(t_base) -> float:
        """|r'''| at t_base, third central difference over the +/-2h stencil
        (h = 300 s: at short stencils the third difference is noise-limited by
        the last bits of the Chebyshev evaluation, ~1e-4 m of numerator noise;
        at h = 300 s that noise divides by 2h^3 ~ 5.4e7 and the ~1e-9 signal
        dominates)."""
        h = JERK_H_SECONDS
        p2p = helio_m(offset(t_base, +2 * h))
        php = helio_m(offset(t_base, +h))
        phm = helio_m(offset(t_base, -h))
        p2m = helio_m(offset(t_base, -2 * h))
        comp = {k: (p2p[k] - 2.0 * php[k] + 2.0 * phm[k] - p2m[k]) / (2.0 * h ** 3) for k in p2p}
        return (comp["x"] ** 2 + comp["y"] ** 2 + comp["z"] ** 2) ** 0.5

    # Interval self-check: the internal (whole, fraction) pair must differ by
    # exactly the intended offset (the printed tt values are f64-rounded and
    # must NOT be subtracted for this check).
    _t0 = ts.utc(2026, 9, 5)
    _dt_days = DT_SECONDS / 86400.0
    _t1 = offset(_t0, DT_SECONDS)
    _interval_s = ((_t1.whole - _t0.whole) + (float(_t1.tt_fraction) - float(_t0.tt_fraction))) * 86400.0
    if abs(_interval_s - DT_SECONDS) > 1e-6:
        print(f"ERROR: interval construction imprecise: {_interval_s!r} vs {DT_SECONDS}", file=sys.stderr)
        return 2
    print(f"interval self-check OK: dt = {_interval_s!r} s (target {DT_SECONDS})")

    rows = []
    for y, mo, d, h, mi, s in DATES_UTC:
        t0 = ts.utc(y, mo, d, h, mi, s)
        t1 = offset(t0, DT_SECONDS)
        r0 = helio_m(t0)
        r1 = helio_m(t1)
        # Jerk bound over BOTH 600 s windows: max of the stencil at
        # t0-300, t0, t0+300, t1 (covers the velocity stencils around t0 and
        # t1 and both propagation intervals).
        jerk_max = max(
            jerk_mag_at_m_per_s3(offset(t0, -DIFF_H_SECONDS)),
            jerk_mag_at_m_per_s3(t0),
            jerk_mag_at_m_per_s3(offset(t0, +DIFF_H_SECONDS)),
            jerk_mag_at_m_per_s3(t1),
        )
        rows.append(
            {
                "t0Iso": f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}Z",
                "t1Iso": t1.utc_datetime().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "t0TtWhole": float(t0.whole),
                "t0TtFraction": float(t0.tt_fraction),
                "t1TtWhole": float(t1.whole),
                "t1TtFraction": float(t1.tt_fraction),
                "dtSeconds": DT_SECONDS,
                "r0m": r0,
                "v0m": vel_central_m_per_s(t0),
                "r1m": r1,
                "v1m": vel_central_m_per_s(t1),
                "v0mFivePoint": vel_five_point_m_per_s(t0),
                "v1mFivePoint": vel_five_point_m_per_s(t1),
                "v0mKernelAnalytic": pair_vel_m_per_s(t0),
                "v1mKernelAnalytic": pair_vel_m_per_s(t1),
                "jerkEstimateMPerS3": jerk_max,
                "perturbationAccelMPerS2": perturbation_accel_m_per_s2(t0),
            }
        )

    fixture = {
        "schema": "kwetu.golden.kepler/1",
        "generatedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "generator": "tools/oracle/generate_kepler.py",
        "method": {
            "pair": (
                "Earth geocenter (399) minus Sun proper (10), geometric same-instant "
                "kernel difference, ICRF axes, metres; velocity by prescribed central "
                "difference over +/-300 s; v0mFivePoint/v1mFivePoint record the "
                "5-point stencil over the same h (the differencing-model check "
                "reference: |v_central - v_five_point| = (h^2/6) r'''(xi), kernel-"
                "positions only); v0mKernelAnalytic/v1mKernelAnalytic record the "
                "kernel's own Chebyshev-differentiated velocity (diagnostics, not "
                "the row contract, NOT usable for the differencing-model check — "
                "Chebyshev-fit-derivative error class 2.5e-6..4.8e-6 m/s); "
                "jerkEstimateMPerS3 is the +/-600 s third-central-difference "
                "magnitude of the pair at t0"
            ),
            "time": (
                "skyfield load.timescale(builtin=True); dtSeconds = 600 s is exact in "
                "TT (no leap second inside either window; TT-UTC piecewise constant) "
                "[derived]"
            ),
            "frame": (
                "ICRF in, ICRF out — the Kepler propagator under test is "
                "frame-agnostic; ICRF<->EQJ frame bias is a rocket-phase follow-up, "
                "deliberately not folded in"
            ),
            "expectedResidual": (
                "two-body GM_SUN propagation of (r0m, v0m) misses r1m by "
                "(h^2/6)*r'''*dt (velocity differencing, ~0.013 m here) plus the "
                "two-body-vs-N-body model gap (<= 0.5*perturbationAccelMPerS2*dt^2, "
                "~6 m class, Moon-dominated) [derived — the test derives its bound "
                "from jerkEstimateMPerS3 and perturbationAccelMPerS2 and reports "
                "the measured residual]"
            ),
        },
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
            },
            "regenerateCommand": "python tools/oracle/generate_kepler.py",
        },
        "rows": rows,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {OUT_FILE.relative_to(REPO_ROOT)}")
    print(f"kernel sha256 OK: {digest}")
    print(f"skyfield {skyfield.__version__}, python {platform.python_version()}")
    for row in rows:
        dv = sum((row["v0m"][k] - row["v0mKernelAnalytic"][k]) ** 2 for k in ("x", "y", "z")) ** 0.5
        print(f"  {row['t0Iso']} jerk {row['jerkEstimateMPerS3']:.6e} m/s^3 | "
              f"a_pert {row['perturbationAccelMPerS2']:.6e} m/s^2 | "
              f"|v0m - v0mKernelAnalytic| {dv:.4e} m/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
