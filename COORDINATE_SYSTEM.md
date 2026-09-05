# Kwetu — Coordinate System

Status: **pre-code, Phase 0 not run.** This doc defines the frame chain, units, precision law,
and time policy for the whole simulation. It is the single owner of *frames, precision, and
time* (pointer table in `CLAUDE.md`); other docs link here instead of restating. Number
ownership: performance and budget numbers live in `ROADMAP.md §Budgets`, referenced never
restated; physical constants, library accuracies, and arithmetic facts (e.g. the f32 spacing
ladder) are owned **here**, tagged per `docs/adr/README.md`; thresholds needing a measurement
are `[PLACEHOLDER — gate]`, promoted into §Budgets by the spike that measures. Cite-by rule:
a derived accuracy constant owned here (e.g. one arcminute ≈ 112 km at the Moon's mean
distance, §10) is cited from other docs as `ROADMAP.md` §Budgets `B-CONST-06` — that row is
the reference pointer, and its value mirrors this doc's derivation, never a competing
rounding.

Everything stated as a **Law** is the spec, copied verbatim into implementations. If code, a
shader, or a network message contradicts a Law, the code is wrong.

## 1. The six frames, plus the local scene

Every position in Kwetu exists in exactly one frame at a time, and every change of frame goes
through a named conversion owned by exactly one subsystem. There are no other frames.

| Frame | Origin | Axes | Units | Conversion owner |
|---|---|---|---|---|
| `Frame.Universe` | Solar System Barycenter (SSB) | parallel to EQJ (J2000 mean equator; ICRF-aligned to within the ~0.02″ frame bias [EXTERNAL]) | metres | **none today** — defined and reserved for the Interstellar phase; no code computes it |
| `Frame.Helio` | Sun center | EQJ (J2000 mean equator) | metres (AU exists only inside the ephemeris adapter) | **ephemeris adapter** — the only code allowed to call astronomy-engine (`toHelio`) |
| `Frame.Pci(body)` | center of the body (Earth, Moon, …) | **parallel to EQJ** — translation only, never rotated | metres | **sim core, f64** (`toPci` = `Frame.Helio` position − body heliocentric position) |
| `Frame.PlanetFixed(body)` | center of the body | body-fixed rotating: Earth = ITRF-like (x → 0°E/equator, z → north pole); other bodies = IAU north pole + prime meridian | metres | **`toPlanetFixed`** — one f64 rotation per (body, tick), composed in sim core |
| `Frame.Geodetic(body)` | the body's reference ellipsoid (Earth: WGS84) | lat / lon / height | degrees + metres | **Earth-fixed geodesy module** (GeographicLib candidate — §5, spike) |
| `Frame.Enu(anchor)` | an anchor point on the body | tangent triad: x East, y North, z Up | metres | **Earth-fixed geodesy module** (Earth) / planet-fixed tangent (other bodies) |
| `LocalScene` | the scene anchor (`SceneAnchor`) | **identical axes to `Frame.Enu(anchor)`** | metres; f32 only at the two downcast points (§6, Laws P-2/P-5) | **scene layer** (`LocalScene.rebase`), renderer (downcast) |

The chain, one arrow per conversion:

```
Frame.Universe (SSB, reserved)  ── deferred to the Interstellar phase

Frame.Helio ──toPci──> Frame.Pci(body) ──toPlanetFixed──> Frame.PlanetFixed(body)
   (translation only)                                        (the one rotation)
                                                                  │
                                       toGeodetic / toEnu (geodesy module)
                                                                  │
                                            LocalScene (scene layer + renderer)
```

Why each hop is shaped the way it is:

- **`Frame.Helio` is the computational root.** astronomy-engine produces heliocentric vectors
  in EQJ in AU (`HelioVector`); the adapter converts to metres once, at one boundary, with one
  pinned constant (§4). Nothing else in the codebase knows AU exists.
- **EQJ is the only inertial axes set.** astronomy-engine also speaks ECL, ECT, EQD, HOR and
  GAL; the adapter may use them internally, but no stored or transmitted position is ever in
  any of them. "Ecliptic coordinates" is not a Kwetu frame — treat it as a synonym bug (§13).
- **`Frame.Pci(body)` axes are parallel to `Frame.Helio` axes, always.** The heliocentric →
  planet-centered hop is a pure translation (subtract the body's position). Deliberate: it
  removes an entire class of double-rotation bugs and leaves exactly *one* rotation in the
  chain — the one at `toPlanetFixed`.
- **`Frame.PlanetFixed(body)`** is where rotation happens. Earth: astronomy-engine's EQJ→EQD
  rotation (precession + nutation) plus Greenwich Apparent Sidereal Time (`SiderealTime`, GAST).
  Other bodies: `RotationAxis` (IAU pole RA/Dec + prime-meridian angle W) [EXTERNAL —
  astronomy-engine implements the IAU/WGCCRE rotation models]. Validated against the library's
  own horizon frame to 4.6e−14 degrees (§11, G-01).
- **`Frame.Geodetic(body)`** exists so lat/lon/height has exactly one home. Earth's ellipsoid is
  WGS84 (§5). Other bodies get their own ellipsoid/sphere constants from their data sources
  (owned by `DATA_SOURCES.md`), same math, different constants.
- **`LocalScene`** is the only frame the renderer and Rapier ever see, and its axes are the
  anchor's ENU triad — which is why gravity inside a surface scene is exactly `(0, −g, 0)` and
  "up" is +z. Free-space scenes use the same convention with a scene-defined "up".

### Deliberate omissions (quantified, so nobody "fixes" them by accident)

| Omission | Magnitude | Tag |
|---|---|---|
| Polar motion (Earth rotation axis wobble) | ≤ ~0.3″ ≈ 9 m at the surface | [EXTERNAL — IERS] |
| DUT1 (UT1−UTC, vs treating UTC as UT1) | < 0.9 s of Earth rotation ≈ < 0.4 km at the equator | [EXTERNAL — IERS] |
| Solid-Earth and ocean tides (crust displacement) | up to ~0.3 m vertical | [EXTERNAL] |
| Plate tectonics (site motion) | mm–cm per year | [EXTERNAL] |
| ITRF vs WGS84 realisation difference | centimetres (aligned since WGS84(G1150)) | [EXTERNAL] |

All are below the game-accuracy bar forever (§10). Any can be revisited, but only by ADR — never by an individual PR adding a correction term.

## 2. Velocities and rotating frames

**Law V-1.** Every position conversion has a matching velocity conversion. Crossing into or
out of a rotating frame (`Frame.Pci(body)` ⇄ `Frame.PlanetFixed(body)`) adds the transport
term **ω × r**: a point fixed on the equator has velocity ≈ 465 m/s in `Frame.Pci(Earth)` and
zero in `Frame.PlanetFixed(Earth)` [derived: ω⊕ = 7.2921159e−5 rad/s × 6.378e6 m].

A body's state is stored as (frame, position, velocity) **as a pair in one frame**. Mixing a
`Frame.Pci` velocity with a `Frame.PlanetFixed` position is the bug that makes launch
trajectories drift sideways; the Phase-7 handoff (§9) is where this bites, exercised by G-03.

## 3. Units

**Law U-1.** Metres and seconds everywhere. No km, no AU, no miles, no minutes-as-time in engine code.
**Law U-2.** Radians everywhere in code. Degrees only at human boundaries (geodetic input, UI), and only where the identifier says `Deg`.
**Law U-3.** Every distance/duration/angle field carries its unit in its name
(`positionMetres`, `dtSeconds`, `longitudeDeg`). A conversion is always a named function at
a boundary — never an inline `* 1000`. Branded types (`Metres`, `Seconds`, `Radians`) make
a unit mismatch a compile error, not a jitter report.

AU handling: astronomy-engine returns vectors in AU. The ephemeris adapter converts AU → m
with the library's own pinned constant, exactly once, and nothing outside the adapter ever
sees AU. Do **not** substitute the exact IAU 2012 definition (1 au = 149 597 870 700 m
[EXTERNAL — IAU 2012 Resolution B2]) for the library's constant: astronomy-engine 2.1.19
(Python) exposes `KM_PER_AU = 149597870.69098932` — about 9 m per AU off the exact definition
[MEASURED 2026-09-05]. Golden fixtures must use the same constant as the runtime, or the
fixtures are wrong by metres.

## 4. Time: the TT vs UTC question (OPEN — gates NETWORKING.md and world state)

This is a Phase-0 deliverable owned by spike **S0.7** (universe-clock / time-warp semantics).
Until its ADR lands, NETWORKING.md cannot fix its message-timestamp format and the
world-state schema cannot fix its persistence format. This section presents the question and
the options honestly; it does **not** decide. Facts that constrain the choice:

- **JS `Date` is POSIX time, not UTC.** It counts 86400 s per day and ignores leap seconds;
  a real UTC second 23:59:60 does not exist in `Date`, and each leap second widens the POSIX
  drift from civil time [EXTERNAL — ECMAScript spec].
- **True TT − UTC = TAI−UTC + 32.184 s = 37 + 32.184 = 69.184 s** today [EXTERNAL — IERS
  Bulletin C; re-verify the 37 s leap count at pin time].
- **astronomy-engine's own `.tt` is not that number.** For the worked-example instant
  (2026-09-05T00:00:00Z) it exposes `.ut = 9743.5 d`, `.tt = 9743.500873473704 d` — a ΔT
  model of 75.47 s [MEASURED 2026-09-05, astronomy-engine 2.1.19]. The library's internal
  scale is self-consistent for ephemeris purposes, but it is **not** a policy; never treat a library timestamp as the universe clock.
- **Leap seconds are non-monotonic.** A clock that repeats a second breaks fixed-timestep
  accumulators, interpolation, and server replay — why physics never runs on civil time.
- **The leap second itself is being retired:** the CGPM resolved (2022) that leap seconds
  should cease by 2035, successor mechanism still undefined [EXTERNAL]; until then Bulletin C remains live.

Options for the authoritative universe/world-state clock:

| Option | Monotonic | Pros | Cons |
|---|---|---|---|
| POSIX seconds (JS `Date`) | yes | native to JS, trivially serialisable | drifts from civil UTC by the leap count; ambiguous instants; physics semantics silently wrong across a leap |
| UTC + leap table | no | civil truth everywhere | non-monotonic (repeats a second); every client/server needs a table-update path |
| TAI seconds since epoch | yes | uniform, no leaps; civil mapping = TAI + 37 s (changes only at leaps) | needs the Bulletin C count at display boundaries |
| TT seconds since J2000 | yes | ephemeris-native (astronomy-engine, Skyfield all speak TT); 32.184 s offset exact by definition | not civil time; library ΔT models differ (measured above) — must pin construction path |

Working recommendation, to be ratified or rejected by the S0.7 ADR: **one monotonic scale
(TT- or TAI-based — S0.7 chooses) as the authoritative simulation and world-state clock**, civil
UTC derived only at display/logging boundaries, network timestamps in the monotonic scale plus a
server-published mapping to civil UTC. Rails orbit math (`M = M0 + n·t`, §9) requires it — a leap
second inside a time-warp interpolation is a discontinuity in every moving body at once.

## 5. Earth-fixed geodesy

astronomy-engine covers astro frames (EQJ/EQD/ECL/HOR, observer topocentric). It is **not** an
Earth-fixed survey library: its `Observer` takes "elevation above sea level" [EXTERNAL —
astronomy-engine docs], not a surveyed ellipsoidal height, and its built-in Earth constants are
not the WGS84 survey constants. Earth-fixed geodesy is therefore delegated to a dedicated
module. **Candidate: GeographicLib (MIT, including the official JS port `geographiclib` by the
same author)** [EXTERNAL — license verified from source per LICENSES.md procedure], scope
decided by a **named spike (part of S0.1's ADR)**: geodetic ⇄ ECEF, geodesics, geoid models
(EGM96/EGM2008), normal gravity — and whether any of it is needed at *runtime* at all, or only
at bake time (Python/pyproj offline); geoid grids are a load-budget input owned by §Budgets.

### Conventions (the formulas agents copy verbatim)

WGS84 constants [EXTERNAL — NGA STND.0036 (formerly TR8350.2)]:
`a = 6 378 137.0 m` (exact), `1/f = 298.257223563` (exact), from which
`e² = f(2−f) = 0.0066943799901413165` [derived].

Geodetic (φ, λ, h) → ECEF (f64, closed form — the *easy* direction):

```
N = a / sqrt(1 − e²·sin²φ)
X = (N + h)·cosφ·cosλ
Y = (N + h)·cosφ·sinλ
Z = (N·(1 − e²) + h)·sinφ
```

ECEF → ENU at an anchor (φ, λ): rows of the rotation are

```
E = (−sinλ,        cosλ,       0)
N = (−sinφ·cosλ, −sinφ·sinλ,  cosφ)
U = ( cosφ·cosλ,   cosφ·sinλ,  sinφ)
p_enu = R · (p_ecef − p_anchor)
```

ECEF → geodetic (the *hard* direction): use the library (GeographicLib candidate). Naive
closed forms degrade near the poles and at large height; this doc does not bless one.

### Height: ellipsoidal vs orthometric — the datum bug

- **Ellipsoidal (geodetic) height h** — above the WGS84 ellipsoid. What `Frame.Geodetic(Earth)` stores and `Frame.PlanetFixed(Earth)` implies.
- **Orthometric height H** — above the geoid (≈ mean sea level). Nearly every human and
  cartographic height is this one: survey marks, OSM `ele` tags, and the elevation models we
  bake (Copernicus GLO-30 is referenced to the EGM2008 geoid [EXTERNAL — ESA/Copernicus
  documentation; provenance owned by DATA_SOURCES.md]).
- They differ by the **geoid undulation N**: `h = H + N`. Worldwide N spans roughly −107 m to
  +85 m [EXTERNAL — NGA EGM2008]; the value at Dar es Salaam is read from the grid by the
  geodesy spike — it is **not** assumed and **not** zero.

Consequences, stated as Laws because each has produced real-world bugs elsewhere:

**Law G-1.** Sea level is *not* `h = 0`. Mean sea level sits at ellipsoidal height h = N. The Indian Ocean is rendered at h ≈ N, or the coastline is broken by tens of metres.
**Law G-2.** Every height dataset entering the terrain pipeline carries a declared datum
(ellipsoidal, or orthometric + model). Datum conversion happens once, in the bake (owned by
DATA_SOURCES.md), never at runtime, never in a shader.
**Law G-3.** Landing sites, anchors, and saved player positions are stored as geodetic
coordinates + the geodetic model version that defined them.

## 6. Precision rules — the law

**Law P-1. All simulation and frame math is f64 (the JS `number`).** `Float32Array` may not
appear in any frame-conversion, orbit, or physics-integration code path. Type boundaries
enforce this (§11, G-04).

**Law P-2. The GPU never sees a global coordinate.** WGSL/WebGPU has no f64 [EXTERNAL —
WebGPU/WGSL spec]; the renderer receives only `LocalScene`-local deltas already inside the
scene bound (Law P-5), downcast to f32 at one point per pipeline.

**Law P-3. Subtract large positions in f64 first, then hand the small delta down.** The
downstream consumer (renderer, Rapier, audio) gets *deltas*, never raw heliocentric or
planet-centered coordinates. Converting to f32 first and subtracting after is catastrophic
cancellation — the single most expensive bug class this doc exists to prevent. Worked example
§12, step 8: the subtraction that costs f64 four micrometres costs f32 **12.6 km**.

**Law P-4. Catastrophic cancellation is the killer, not range.** f64 range is never the problem
in the Solar System — its resolution at 1 AU is ~30 µm, at Earth radius ~1 nm (table below).
Range only becomes marginal at interstellar distances (~8 m at 4 ly), which is why
`Frame.Universe` is a reserved root and not today's working frame.

**Law P-5. Every rendered local scene stays under ~1e5–1e6 m across its largest extent.** A
planet seen from space is drawn by its own planet renderer, never inside a walk-scale scene.
The scene bound is asserted in code, not hoped for. Rationale (f32 spacing at the scene's far
edge): ~8 mm at 100 km, ~6 cm at 1000 km; beyond that it degrades fast (table below).

**Law P-6. Floating-origin rebase is re-derivation, not translation.** `LocalScene.rebase`
moves the anchor and then **re-derives every dynamic body's `LocalScene` transform from its
f64 ground-truth frame** (`Frame.PlanetFixed` or rails state). Never apply a shift vector to
accumulated f32 physics/vertex positions — cumulative f32 rounding on shifted positions is
the rebase-jitter bug, nearly undiagnosable from a screenshot.

f32 and f64 spacing (worst-case spacing within each magnitude bracket; 2^(e−23) for f32,
2^(e−52) for f64, x ∈ [2^e, 2^(e+1))) [derived]:

| Magnitude | f32 spacing | f64 spacing | Landmark |
|---|---|---|---|
| 8 192 – 16 384 m | 0.98 mm | 1.8e−12 m | mm precision dies above this (f32) |
| 65 536 – 131 072 m | 7.8 mm | 1.5e−11 m | |
| 1 048 576 – 2 097 152 m | 0.125 m | 2.3e−10 m | scene-bound far edge |
| 4 194 304 – 8 388 608 m | 0.5 m | 0.9e−9 m | Earth radius (6 371 km) lives here |
| 8 388 608 – 16 777 216 m | 1 m | 1.9e−9 m | |
| 16 777 216 – 33 554 432 m | 2 m | 3.7e−9 m | **2^24 ≈ 16.7M m: f32 can no longer represent every integer metre** |
| 268 435 456 – 536 870 912 m | 32 m | 6.0e−8 m | Moon distance (~384 400 km) |
| ~1.5e11 m | 16 384 m | 30.5 µm | Earth's heliocentric distance (~1 AU) |
| ~4e16 m | ~4.3e9 m | ~8 m | Proxima distance — f64 finally marginal |

(Note on a shorthand circulating in the plan, "f32 loses mm precision at 16 777 km": precisely,
at 2^24 m f32 loses **exact integer-metre** representation (spacing becomes 2 m); millimetre
spacing already dies near 8–16 km. Both facts matter; the table is the reference, not the shorthand.)

float-float (double-single) emulation: **rejected** — 8–16× arithmetic cost [EXTERNAL —
double-single GPU prior art], intrusive into every shader, and nothing on the roadmap needs
sub-millimetre precision at planetary range. Revisit only by ADR.

## 7. Rendering: log depth AND floating origin

**Law R-1. Logarithmic depth buffer AND floating origin are both always on. Enabling one without the other is a bug.** They solve different problems:

- **Log depth** fixes *depth-precision* z-fighting at distance (a 1 m rock at 100 km vs a mountain behind it) — a *buffer resolution* problem.
- **Floating origin** fixes *vertex jitter* — geometry wobbling because positions are huge relative to f32 precision (0.5 m spacing at Earth radius, table above) — a *coordinate size* problem.

No depth-buffer trick can fix jitter, and no re-origin can fix distant z-fighting: the pair is
required. The renderer spike **S0.2** additionally evaluates reversed-Z + float32 depth as the
depth mechanism; if adopted by ADR it *replaces the depth strategy*, never the floating origin,
which is not negotiable.

## 8. Physics world layout

**Law PH-1. One Rapier world per celestial body. Never one global world, never per region or
tile.** Rationale: Rapier's `World.gravity` is a single global vector per world, and
`gravityScale` scales magnitude only — it can never change direction [EXTERNAL — Rapier
documentation]. A world cannot have per-position gravity direction, so a world cannot span
bodies, latitudes, or a planet's curved surface.

| Regime | World | Gravity |
|---|---|---|
| On/near a body's surface (walk, drive, landed) | that body's world, in `LocalScene` coordinates | `(0, −g, 0)` — axis-aligned because scene axes are ENU; magnitude from normal gravity (standard 9.80665 until the geodesy spike supplies site values) [PLACEHOLDER — gate: S0.1 geodesy ADR] |
| Micro-g (EVA, station interiors, asteroid) | a zero-g world | `(0,0,0)`; artificial gravity applied manually as forces |
| Spacecraft in flight | **no world** — rails (§9) | n/a; contact exists only inside a body's world when landed/docked |

Rapier is f32 [EXTERNAL — Rapier WASM bindings; no f64]. The physics world therefore lives
entirely inside `LocalScene` (Laws P-2/P-5), rebase follows Law P-6, and bodies whose motion
is ephemeris/orbital are **kinematic position-based bodies** driven from f64 evaluation each
tick — Rapier never integrates an orbit. Fixed-timestep accumulator with render
interpolation: physics steps a fixed `dt` (candidate 1/60 s) [PLACEHOLDER — gate: S0.7], an
accumulator carries the remainder, render interpolates between the last two states, and a
substep clamp prevents the spiral of death.

## 9. Rails vs physics: two-mode time-warp

Two modes, one threshold [PLACEHOLDER — gate: S0.7 sets the threshold and hysteresis]:

- **Physics mode (below threshold).** Rapier steps normally (§8). Real accelerations, real
  collisions, character/vehicle feel.
- **Rails mode (above threshold).** Local physics freezes — dynamic bodies paused/kinematic —
  and all orbital motion is evaluated analytically from Keplerian elements in f64:
  **`M = M0 + n·t`** (mean anomaly grows linearly in the monotonic universe time), solve
  Kepler's equation for the true anomaly, position in `Frame.Pci(body)` from the elements.
  Time-warp then advances the universe clock by arbitrary amounts without integrating anything.

**SOI handoff = named Phase-0 spike S0.7.** When a rails trajectory crosses a body's sphere of
influence, the reference body changes and position/velocity are re-expressed in the new
`Frame.Pci(body)` (the frames differ by the translation between body centers — Law V-1's
transport term is why velocity needs care here). Kerbal Space Program's patched-conic handoff
is invoked as prior art for the *pattern* only; it is not designed here, and nothing in this doc
is the handoff design. Mode transitions never occur mid-physics-step, and an R→P transition
re-syncs all frozen bodies from f64 ground truth before control returns.

## 10. Accuracy expectations

- astronomy-engine's stated accuracy is ±1 arcminute for Solar System bodies [EXTERNAL —
  astronomy-engine documentation]. One arcminute subtends ≈ 112 km at the Moon's mean distance
  (384 400 km) and ≈ 43 500 km at 1 AU [derived].
- The ephemeris is therefore **sky and event quality**: where the Moon hangs in the sky,
  sunrise/sunset, eclipse-grade timing. It is **not** landing guidance, not orbit determination
  for gameplay-critical contact, not anything where 100 km matters.
- **Landing sites are defined in planet-fixed frames.** A pad is a `Frame.Geodetic` anchor
  (Law G-3); "where am I relative to the pad" is local planet-fixed knowledge. Never back-solve
  a surface position from an ephemeris direction — that inverts the accuracy budget and
  produces sites that move with the ephemeris version. Ephemeris comparisons assert
  sky-quality tolerances only (§11).

## 11. Golden tests

The oracle is Python, offline, at build time: **Skyfield (MIT) with de440s.bsp**, plus
**astroquery (BSD) against JPL Horizons** [EXTERNAL — licenses per LICENSES.md]. **Horizons
has no SLA** — a research service that may change or vanish — so it is never a runtime or
CI-gate dependency: reference data is precomputed at build time and **committed as fixtures**
(provenance rows in DATA_SOURCES.md). Tolerance thresholds are set by S0.1/S0.11
[PLACEHOLDER — gate]; measured seeds from this doc's worked example (§12) are inlined below
so the tests start from real numbers, not round numbers.

| ID | What it proves | Seed / threshold |
|---|---|---|
| G-01 | Frame self-consistency: the library's own horizon frame at a site vs our ECEF→EQD→EQJ chain (zenith round-trip) | measured 4.6e−14 deg at the §12 site [MEASURED 2026-09-05]; threshold [PLACEHOLDER — gate: S0.1] |
| G-02 | Full-chain f64 round-trip (geodetic → helio → camera inputs and back) | measured residual ≤ 4.4e−6 m at the §12 site [MEASURED 2026-09-05]; threshold [PLACEHOLDER — gate: S0.1] |
| G-03 | Ephemeris vs Python oracle (Skyfield/de440s, Horizons fixtures), heliocentric + geocentric, multiple dates | tolerance [PLACEHOLDER — gate: S0.1/S0.11] |
| G-04 | No-f32-contamination: static check that no `Float32Array` crosses a frame-conversion boundary | zero violations, enforced every build |
| G-05 | Determinism: bitwise replay of a recorded input path (S0.11) | threshold [PLACEHOLDER — gate: S0.11] |

Fixtures pin the astronomy-engine version, the AU constant, and the ΔT behaviour (§4) they
were generated with. A fixture regenerated under a different pin is a different fixture.

## 12. Worked example — one position, the whole chain

Illustrative position: **Dar es Salaam seafront, geodetic φ = −6.79°, λ = 39.21° (Tanzania),
h = 0 m ellipsoidal** — h is zero to keep the arithmetic readable; a real site's ellipsoidal
height comes from datum-corrected terrain (Law G-2), and sea level itself sits at h = N, not 0
(Law G-1). Instant: **2026-09-05T00:00:00Z** (UTC), processed with astronomy-engine 2.1.19
[MEASURED 2026-09-05 — exact values below are committed as the seed of G-01/G-02; figures
displayed rounded].

| Step | Conversion (owner) | Precision | Result |
|---|---|---|---|
| 1 | Geodetic → `Frame.PlanetFixed(Earth)` (ECEF) via §5 formulas (geodesy module) | f64, closed form | X = 4 907 565.698 m, Y = 4 003 939.392 m, Z = −749 078.231 m (r ≈ 6 377 840.5 m) |
| 2 | `Frame.PlanetFixed` → `Frame.Pci(Earth)` via GAST = 344.118° then EQD→EQJ (library rotation) — `toPlanetFixed` inverse | f64 rotation | geocentric EQJ ≈ (5 828 917.818, 2 473 115.830, −764 372.354) m |
| 3 | AU boundary: Earth `HelioVector` = (0.959534245683709, −0.2844143594239741, −0.12329471927952336) AU × pinned constant (ephemeris adapter) | f64, one multiply | (143 544 280 009.368, −42 547 782 563.768, −18 444 627 471.660) m |
| 4 | `Frame.Pci` + Earth position → `Frame.Helio` (sim core, addition) | f64; ULP ≈ 30 µm here — lossless at our bar | Dar heliocentric ≈ (143 550 108 927.186, −42 545 309 447.938, −18 445 391 844.014) m |
| — | `Frame.Universe` (SSB) | n/a | **not computed** — deferred (Interstellar phase); the Sun–SSB offset is of order one solar radius (~7e8 m) [EXTERNAL] |
| 5 | Back down: `Frame.Helio` − Earth position → `Frame.Pci` (sim core, **subtraction**) | **f64 mandatory** — see step 8 | recovers step 2 to ≤ 4.4e−6 m (G-02 seed) |
| 6 | `Frame.Pci` → `Frame.PlanetFixed` → `Frame.Enu(anchor)` (geodesy module) | f64 | returns the site to micrometre level; round-trip residual ≤ 4.4e−6 m, consistent with f64 ULP ≈ 30 µm at this magnitude |
| 7 | `Frame.Enu(anchor)` → `LocalScene`: eye = anchor + 1.7 m up; door = anchor + (100 E, 0 N, 3 U) m (scene layer) | f64 | door − eye = (99.99999999963, 2.3e−11, 1.30000000032) m — the few-×1e−10 m noise is f64 ULP at Earth radius (~1 nm), irrelevant |
| 8 | `LocalScene` → camera space (renderer): camera faces East, three.js basis (x right, y up, z backward) → **single f32 downcast** (Law P-2) | **f32, last hop only** | (≈ 0, 1.3000000, −100.00000) — small numbers, millimetre-exact at this range |

**Step 8's why** (the whole doc in two lines): the same step-5 subtraction performed after an
f32 downcast of the heliocentric coordinates yields a geocentric position in error by
**12 636 m** [MEASURED 2026-09-05 — f32 ULP is 16 384 m at this magnitude]. Storing the step-1
planet-fixed coordinates themselves in f32 quantises the site by **0.227 m** — that error *is*
the vertex jitter floating origin exists to kill. f64 end-to-end, f32 only after the last
subtraction, is not a style preference.

## 13. Naming conventions

Future code copies this vocabulary verbatim. Identical words mean identical frames — synonyms are where jitter bugs are born.

| Name | Meaning |
|---|---|
| `Frame` | The frame registry/enum: `Frame.Universe`, `Frame.Helio`, `Frame.Pci(body)`, `Frame.PlanetFixed(body)`, `Frame.Geodetic(body)`, `Frame.Enu(anchor)` |
| `toPlanetFixed(pos, body, t)` | Rotation into a body-fixed frame (required name — the only rotating hop) |
| `toHelio`, `toPci`, `toGeodetic`, `toEnu` | The other conversions, same verb style, one per chain arrow |
| `LocalScene` | The floating-origin scene: owns its `SceneAnchor`, the rebase, and the two f32 downcast points |
| `SceneAnchor` | A geodetic/ENU anchor + the instant it was fixed; what `LocalScene` is relative to |
| `worldTime` | The authoritative monotonic simulation instant (§4) |

Rules:

1. The §1 table is the complete frame vocabulary. **Banned synonyms:** "world frame", "global
   frame", "absolute frame", "game frame", "map frame", "surface frame", "ecliptic coordinates"
   — none of them names a hop, so all of them name a bug.
2. Conversions are verbs (`toX`), frames are nouns (`Frame.X`); a conversion never mutates its
   input, it returns a value tagged with its frame.
3. A value's frame travels with it — a bare `{x, y, z}` crossing a module boundary without a
   frame is a defect, not a shorthand.
4. When a Law is quoted in code comments, ADRs, or PRs, quote it by number (P-3, G-2, PH-1…) so the text cannot drift.

## 14. Open items

| Item | Owner | Blocks |
|---|---|---|
| TT vs UTC (universe clock) policy | S0.7 ADR | NETWORKING.md timestamps, world-state/persistence schema |
| GeographicLib (or bake-only) adoption + geoid grid cost | named spike within S0.1 ADR | terrain datum conversion (DATA_SOURCES.md), per-site gravity (§8) |
| reversed-Z + float32 vs log depth mechanism | S0.2 ADR | renderer depth strategy (floating origin is not open) |
| Rails threshold, hysteresis, SOI handoff design | S0.7 ADR | Phase 7 rocket, time-warp UX |
| Fixture tolerances (G-01…G-05) | S0.1 / S0.11 ADRs | CI gate |
