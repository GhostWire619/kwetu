# Kwetu — Master Development Prompt

*Swahili: **kwetu** — "our place."*

---

## How to use this prompt

This file is the complete, standalone brief for building **Kwetu**: an open-source, browser-based, persistent multiplayer digital
universe with a real-scale Solar System and flagship Earth regions in Tanzania and Zanzibar. It was reconstructed from the founder's
original development prompt plus a license-verified technology research pass, so that a cold agent with zero prior context can act on
it. It tells you **what to build and why**; the repo's deeper documents own fine detail (see the Documentation Map, §50).

**Reading protocol:**

- **Always read Part A (Identity) and Part G (Engineering).** Then read the Part matching the work you are implementing:

  | Work | Read |
  |---|---|
  | Phase 0 spikes / architecture | A, C, G, plus D (§32), E (§33–34), F as the spike requires — spike specs: §53 and ROADMAP.md §5 |
  | Engine core (precision, rendering) | C |
  | Earth data & regions | B, C (§20), E |
  | Walk / car / vehicles | C, D, E |
  | Multiplayer / voice | C (§17–19), D |
  | Rocket / orbit / Moon | D (§27–28), C (§13–16) |
  | Content & asset production | E |
  | Localization & Swahili | F |
  | Delivery / CI / infra | G, H |
  | Vertical Slice / Alpha / Solar System / Interstellar | A, plus every Part of any subsystem you touch — gates and deliverables live in ROADMAP.md §4 |

- **Never re-derive an item marked `DECIDED:`.** These are locked, user-confirmed choices. If you believe one is wrong, draft an ADR
  (see `docs/adr/README.md`) and stop — do not silently substitute.
- **Fact-provenance discipline.** Numbers in this file carry one of three tags: `[MEASURED date+method]` = a benchmark this project ran;
  `[PLACEHOLDER — gate: S0.x]` = a slot a named Phase-0 spike must fill; `[EXTERNAL]` = verified from primary sources (Sept 2026). **An
  untagged number is not a commitment.** Project performance budgets live only in `ROADMAP.md §Budgets`; when this file and an owning
  document disagree, the owner wins and this file gets fixed.
- **Do not build the universe in one heroic explosion.** You are the technical lead, not a code fountain. Work phase by phase (§51);
  each phase ends with something playable in a browser. Evaluate every early design decision against one question: *"Will this still
  work when the player can travel from Earth to Mars, then eventually to another star system?"*

---

# PART A — IDENTITY

## 1. What Kwetu Is

You are the lead game architect, simulation engineer, multiplayer/backend engineer, graphics engineer, and technical researcher for
**Kwetu** — an ambitious open-source game project. Kwetu is a persistent multiplayer digital universe where players live on planets,
drive vehicles, launch rockets, travel through space, land on other worlds, explore realistic celestial bodies, communicate with each
other, build identities, and eventually explore an expandable universe containing other star systems, nebulae, black holes, wormholes,
stations, and settlements.

It deliberately blends several genres: a realistic space simulator, an open-world multiplayer game, a planetary exploration game, a
social virtual universe, a vehicle simulator, a sandbox, and an astronomical visualization platform. It is not "one of these with
decoration" — it is all of them on one architecture.

**The core principle: the universe must feel continuous.** A player should eventually be able to go:

> Earth surface → enter a car → drive to a launch facility → enter a rocket → launch → pass through
> the atmosphere → reach orbit → travel through interplanetary space → approach another planet →
> enter its atmosphere → land → exit the spacecraft → walk on the surface

…without a traditional "level select". Loading and streaming behind the scenes are acceptable; the experience must feel geographically
and spatially continuous. The first vertical slice proves exactly this chain at Earth → Moon scale (§51).

Kwetu's distinguishing identity: **Swahili and East Africa are first-class.** The Earth experience concentrates its highest detail in
Tanzania, Dar es Salaam, and Zanzibar, with regional flavor from Kenya (Part B), and the entire interface treats Swahili as a
first-class language, not a skin (Part F).

## 2. Design Pillars

Every design decision serves these six pillars, in this order of precedence when they conflict:

1. **Real scale.** Planets are their true physical size. We never shrink a world to fit an engine limit; we fix the engine (§7, §13).
2. **Persistence.** The world remembers. What a player builds, owns, discovers, and where they logged out survives sessions (§24).
3. **One shared universe clock.** All players inhabit the same simulated time; planetary positions, day/night, and orbits agree for
   everyone (§16, §28).
4. **One seamless camera.** Walk → car → rocket → orbit → Moon is a single continuous experience, not a chain of scenes (§25).
5. **Low-bandwidth-respectful by default.** Target hardware and network are modest (§4); every megabyte and every message is budgeted
   (§22, §29, §47).
6. **Culturally authored, not extracted.** East African regions are built with regional data, regional architecture, and regional
   language — not generic tropical maps with labels pasted on top (§9, §35).

## 3. Exclusions and Non-Goals

Be as disciplined about what Kwetu is **not** as about what it is:

- **Browser only.** No native desktop build, no mobile-native app, no console build. **DECIDED:** desktop Chrome / Edge / Firefox first;
  mobile-tolerant, not mobile-target; iOS is out of scope (Safari's 7-day storage eviction makes a persistence game unreliable there —
  re-evaluate at the Alpha gate).
- **No VR / AR.**
- **No offline installer.** Kwetu is a streamed web experience.
- **No blockchain, NFTs, or real-money trading. No advertising.**
- **No fake scale.** We do not ship a "small solar system" fallback; if scale breaks, we fix the architecture (§7).
- **No non-free content.** No NC/ND-licensed assets, no ToS-gated services, no unledgered assets (§33, §43). Downloadable ≠
  redistributable.
- **Not a hardcore flight simulator.** Spacecraft startup, maintenance, and comms latency are deliberately simplified (§10).
- **Not a professional racing simulator.** Cars must feel convincing, not simulate tire compounds.
- **Not only a scientific simulator.** Players need things to *do* (§25, §31); normal life on planets matters as much as spaceflight
  (§10).
- **No premature microservices.** One modular monolith per domain until load forces separation (§19, §29).

## 4. Hardware and Network Envelope

Design to the floor, not to the dev box:

- **DECIDED: the target player envelope.** A ~2019-era laptop with an integrated GPU and 8 GB RAM (the envelope's home is
  PROJECT_VISION.md; the RAM figure is an assumption there, not a measured requirement), integrated graphics drivers of varying quality.
  A developer machine with an RTX 4050 is **not** the target — it is the upper bound of the dev envelope.
- **DECIDED: the target network envelope.** 5–10 Mbps `[PLACEHOLDER — gate: S0.9 — assumption, not data; measured under ROADMAP B-RTT-09]`,
  relatively high RTT, and CGNAT-heavy (assumed typical of East African ISPs; PROJECT_VISION.md owns the envelope statement). This drives
  the voice architecture (§18), the data pipeline (§20), and the caching strategy (§22).
- **DECIDED: WebGL2 is the mandatory baseline renderer; WebGPU is optional and progressively enhanced.** The game must run on WebGL2
  alone; WebGPU may unlock extra quality where present.
- **Cross-origin isolation is a written decision, not an accident.** If anything requires SharedArrayBuffer (COOP/COEP headers), a
  single-threaded fallback must exist. Do not build architecture that silently requires it (Phase-1 ADR per ROADMAP.md §4).
- **TLS everywhere, including dev.** Microphone access (§18) is a secure context; `docker compose up` must serve the client over real
  TLS from day one (§19).
- Every load-time, frame-rate, and memory figure is a budgeted number owned by `ROADMAP.md §Budgets`; the initial-load budget is
  replaced or withdrawn by spike S0.3, never asserted in prose.

## 5. Naming, Language, and Cultural Grounding

- The project is named **Kwetu** ("our place" in Swahili) — a statement of intent: this universe is a home people share, and its soul is
  East African. A formal trademark search is spike S0.5 (TZ/Kenya classes 9/41, WIPO/EUIPO/USPTO, domains, fallback-name list); treat
  the name as provisional until that ADR lands.
- **DECIDED: Swahili is a first-class UI language, shipped alongside English from the first UI screen** — not a later localization pass.
  Part F governs.
- In-world cultural grounding is a product requirement, not decoration: place names, architecture, transport, markets, gathering spaces,
  and color moods in East African regions reflect real regional life (§9). Where culture and gameplay tension appears (e.g., fictional
  physics vs. real toponyms), authenticity wins on Earth; fiction is reserved for space (§10).
- All player-facing language defaults to parity: a string lands in English and Swahili in the same change, or it does not land (§38).

---

# PART B — WORLD

## 6. Earth Flagship: Tanzania, Dar es Salaam, Zanzibar, Kenya

Earth is the flagship planet, and on Earth, East Africa is the flagship region. This is a core product requirement, not decoration.
**DECIDED:** the highest map detail, environmental richness, and asset quality are concentrated first in **Tanzania** (mainland),
**Zanzibar** (Unguja and Pemba), with **Dar es Salaam** and **Stone Town** as the first two flagship builds; Kenya is represented
(Nairobi, Mombasa, coastal Swahili areas) at a lower detail tier. The rest of Earth follows through scalable expansion (§8).

The data position justifies the choice — this is not sentiment alone:

- OSM building completeness is high in exactly the regions we care about: **Dar es Salaam ≈ 94 %, Zanzibar ≈ 86 %** of buildings mapped
  `[EXTERNAL]` — among the best data positions on the continent, so real footprints, not guesses, drive the 3D city.
- Geofabrik publishes `tanzania-latest.osm.pbf` (~672 MB `[EXTERNAL]`, ODbL) with daily change files, plus a separate Kenya extract — a
  clean, refreshable source pipeline (§20).
- 32,138 OSM objects already carry `name:sw` Swahili name tags (count owned and tagged in `docs/swahili-i18n.md`) — a thin but real
  cross-check layer for the toponym table (§41).
- The founder's requirement is explicit: Tanzania and Zanzibar must feel like real places with regional geography, culture,
  architecture, urban patterns, atmosphere, and recognizable landmarks. The player should feel *"this world has a real East African
  soul."*

The first vertical-slice Earth flow lives here: **spawn in Dar es Salaam or Zanzibar → walk a real East African environment → drive
through the city/coastal area → travel to a launch facility → launch into space from a Tanzanian pad context** (§25).

## 7. The Real-Scale Policy

**DECIDED: the Solar System is real-scale.** Planets keep their true physical dimensions — Earth's radius, the Moon's distance,
Jupiter's mass. Do **not** shrink planets into tiny game worlds merely because ordinary engine coordinates cannot handle astronomical
distances. Instead:

- Use a **hierarchical frame chain**: SSB → heliocentric → planet-centered inertial → planet-fixed rotating → local floating-origin
  scene (§15; canonical detail in `COORDINATE_SYSTEM.md`).
- Use **double-precision (f64) math in JS** for world positions and **camera-relative f32 only at the last upload to the GPU**.
  WebGPU/WebGL have no f64 pipeline; float-float emulation (8–16× cost `[EXTERNAL]`) is rejected. The GPU never renders the Solar System
  in ordinary float coordinates (§13).
- Use **floating origin** (rebase the local scene so the camera stays near zero) and **log-depth buffering**. These solve different
  problems and both are needed. The exact precision boundaries (e.g., stability at ~1e7 m offsets) are pinned by spike S0.1
  `[PLACEHOLDER — gate: S0.1]`.
- Organize simulation into **levels of fidelity**: Level 0 — astronomical/ephemeris representation; Level 1 — star system; Level 2 —
  planetary orbital zone; Level 3 — regional simulation; Level 4 — the player's local physics bubble. Only what is close enough to
  interact needs expensive physics (§14, §27).

Separate **simulation scale** from **gameplay time scale** (§28). Travel support, in order of introduction: real-time simulation;
configurable time acceleration; autopilot and an orbital transfer planner; later, fictional propulsion (warp, wormholes) — but never by
destroying astronomical scale to reduce travel time.

## 8. Regions Catalog and Detail Tiers

Earth detail is tiered. Each region is a bbox-driven data build (§20), not a hand-modeled diorama; bboxes below are approximate and
`[PLACEHOLDER — gate: confirmed per region at its Phase-2/3 bake]`.

**Tier 1 — flagship (full pipeline: PMTiles vector basemap + 3D buildings + real terrain + Swahili-coast kit):**

| Region | Approx. bbox (lon E, lat S–N) |
|---|---|
| Dar es Salaam (city core) | 39.00–39.45, 7.05 S–6.55 S |
| Stone Town / Zanzibar City | 39.17–39.22, 6.19 S–6.13 S |
| Unguja (Zanzibar island) | 39.05–39.65, 6.50 S–5.85 S |
| Pemba | 39.55–39.85, 5.55 S–4.75 S |

**Tier 2 — mainland Tanzania (vector + terrain; 3D kit where footprints allow):** Arusha (36.55–36.85, 3.50 S–3.25 S) · Dodoma
(35.60–36.05, 6.40 S–6.00 S) · Mwanza (32.75–33.05, 2.65 S–2.35 S) · Kilimanjaro region (37.00–37.65, 3.35 S–2.95 S) · Serengeti /
Ngorongoro (34.20–35.60, 2.80 S–1.30 S) · Bagamoyo (38.85–39.00, 6.50 S–6.35 S) · Tanga (39.00–39.20, 5.20 S–4.95 S).

**Tier 3 — Kenya and coastal Swahili areas:** Nairobi (36.60–37.00, 1.45 S–1.15 S) · Mombasa (39.55–39.80, 4.20 S–3.90 S) · selected
coastal towns. Vector + terrain; selective 3D.

**Tier 4 — the world.** Far-field imagery and procedural texture; no per-building detail. Built by the same streaming architecture, so
adding a region is data work, never architecture surgery.

For Tanzania and Zanzibar specifically, the map system must carry as much open-data detail as practical: coastlines, islands, roads,
neighborhoods, major towns and cities, landmarks, terrain elevation, beaches, ports, airports/airstrips, parks and reserves, mountains,
important public areas, and street layouts where licensing and technique allow (§20).

## 9. Authenticity Rules

East African regions must reflect authentic local atmosphere. The Swahili-coast and Tanzanian environment vocabulary includes:

- **Architecture:** Swahili coastal style — coral-stone walls, carved Zanzibar doors, arched windows, wooden balconies, corrugated and
  mangrove-pole roofs, baraza benches, courtyard and alley structures, mosques and minarets where appropriate (§35 defines the modular
  kit).
- **Urban fabric:** local density patterns, markets, harbor/port areas, dala-dala and bajaji local transport, East African road
  environments, coastal social life and public gathering spaces.
- **Nature:** Indian Ocean coastal feeling, beaches, tropical coastal vegetation, baobab and palms, savannah and mountain biomes
  (Kilimanjaro, Ngorongoro), regional color moods.
- **Worldbuilding:** Swahili-inspired place naming where appropriate; NPC/world flavor drawn from East African daily life; local
  commerce atmosphere; East African music/rhythm inspiration only where licensing allows (§33).

Rules:

1. **Tier-1 regions get the kit, not the paintbrush.** Never ship a generic tropical map and add Tanzanian labels. If the kit cannot
   express a place yet, reduce scope — do not fake it.
2. **Toponyms are a frozen, human-reviewed table** (§41). Never blind-import machine labels — the Wikidata Swahili label for Stone Town
   is actually the district name; the real local name exists only as an alias.
3. **Real map data provides the skeleton; procedural systems fill visual detail** (§20, §35).
4. **Attribution is part of authenticity** — in-world credits honor the data sources and their contributors (§44).

## 10. Player Fiction and Tone

Kwetu's fiction is **grounded near-future**: real celestial bodies, real physics behavior, real geography — plus just enough fictional
capability (later) to make the universe traversable and playable. The design philosophy:

- **REAL where reality improves wonder:** planet scale, gravity per body, orbits, terrain, celestial positions, day/night, the sky as it
  actually appears.
- **SIMPLIFIED where reality becomes tedious:** spacecraft startup procedures, maintenance, communication latency (optional flavor, off
  by default), fuel logistics at game-friendly depth.
- **FICTIONAL where fiction makes exploration possible — and marked as such:** FTL, warp, wormholes, exotic propulsion are late
  additions behind explicit in-fiction framing (§53 keeps them architecturally clean: a wormhole is a `SpatialPortal {entrance,
  destination, transition_rules}` that the coordinate system never needs to redesign for).

The universe must not force every player to be an astronaut. A player may spend an entire session driving around Zanzibar, sitting on a
Stone Town baraza with friends, or running a market stall. Normal-life gameplay (homes, cars, cities, events, small commerce) is as
legitimate as spaceflight (§31).

**Exploration is a core progression system.** Players discover cities, mountains, craters, valleys, moons, caves, stations, and
anomalies, tracked server-side with first-visit records — `FIRST VISIT · Kilimanjaro · Tanzania · Discovered by: Isack · date`.
Landmarks to seed (data and licensing permitting): Kilimanjaro, Serengeti, Ngorongoro, Stone Town, Mount Kenya; Moon — Sea of
Tranquility, Tycho; Mars — Olympus Mons, Valles Marineris, Gale Crater (§37, §51). Community exploration statistics come later.

**Expandability is an architecture requirement, not a roadmap promise.** The world model must never assume only one star system exists
(§15): the same data formats later admit Alpha Centauri, TRAPPIST-1, Proxima, fictional and procedurally generated systems, Milky Way
regions, other galaxies; black holes (visual/gameplay approximations first — lensing and accretion as shaders, not general relativity)
fit the same hierarchy.

---

# PART C — STACK

## 11. Browser Targets and Platform Policy

**DECIDED: browser only.** Kwetu runs in desktop Chrome, Edge, and Firefox. There is no native client, no Electron shell, no Unity/Godot
export. Consequences you must respect everywhere:

- **WebGL2 is mandatory; WebGPU is optional** (§4). Feature-detect; degrade gracefully; never gate core gameplay on WebGPU.
- **No UDP.** Browsers offer WebSockets and (later, as a measured decision) WebRTC datachannels. The netcode is designed around
  WebSocket realities — including head-of-line blocking on lossy links (§29; full transport analysis in `NETWORKING.md`).
- **Secure context required** for microphone, so the whole client is TLS-served (§18, §19).
- **Storage is evictable** except where `navigator.storage.persist()` succeeds (§22). Design for cache misses and re-downloads.
- **Desktop-first, mobile-tolerant.** A phone may open the page; we do not design for it. iOS/Safari is out of scope (§3). Android is
  re-tested at the Alpha gate.
- **Worker layout is deliberate:** physics and terrain/asset decoding live in workers where beneficial; audio processing may be
  scheduled off the render loop, but the single `AudioContext` always lives on the main thread (ARCHITECTURE.md §3.3). Keep a documented
  single-threaded fallback path for when the cross-origin-isolation decision (§4) lands.

## 12. Rendering

**DECIDED: three.js over Babylon.js** — ecosystem density for planet-scale TypeScript work, ~175 KB gzipped vs ~1.1–1.3 MB `[EXTERNAL]`
for the alternative (spike S0.3 re-measures the final bundle), and a verified hook for voice spatialization
(`Audio.setMediaStreamSource` — defined on the base `Audio` class, used via `PositionalAudio`, which inherits it, §18).

Rendering rules:

- **Pick GLSL `ShaderMaterial` or TSL at project start — one or the other, never mixed.** Mixed shader styles across agent-written code
  is a renderer-compatibility hazard. Record the choice as the first rendering ADR and route all custom shaders through it.
- **Never install `@types/three`.** three.js ships its own types since r168; installing the stub package shadows them and breaks builds.
- **Log-depth buffering AND floating origin are both required** — they solve different problems (depth precision vs. coordinate
  precision). Reversed-Z with float32 depth is evaluated as an alternative within the renderer spike S0.2; if adopted, it replaces log
  depth only with an ADR.
- **Planet rendering** uses an adaptive LOD scheme; the concrete scheme (cube-sphere vs. CDLOD, crack stitching, skirt strategy) is
  decided by spike S0.2 `[PLACEHOLDER — gate: S0.2]` — do not pre-implement a choice. Near surface: high-resolution terrain; from orbit:
  progressive LOD; from deep space: a textured sphere. Transitions are continuous, never an abrupt swap.
- Standard toolkit: PBR materials, HDR pipeline, GPU instancing for repeated geometry (vegetation, buildings, props), occlusion culling
  where the scheme allows, texture streaming via KTX2 (§21).
- Visual target: **believable realism, not stylized cartoon** — physically-inspired sunlight, atmospheric scattering (§36), realistic
  materials from CC0/PD sources (§33).
- Pin three-tile-style helpers **at ≥ their GPL-free version** and verify the license at the pinned commit — the predecessor of one such
  helper was GPL-licensed and npm sidebar metadata is not authoritative (§43, §45).

## 13. Precision and Coordinates

This is the highest-risk area of the whole project. Internalize the physics of the problem:

- **The killer is catastrophic cancellation, not range.** f64 easily *represents* 1e10 m; the danger is subtracting two large
  nearly-equal values in f32 after an early conversion.
- **The f32 fact:** a 32-bit float has a 24-bit significand; above 2^24 ≈ 16.7 M metres the gap between representable values exceeds 2 m
  `[EXTERNAL]`, and millimetre-level precision is lost a couple of orders of magnitude below that. Any position math done in f32 at
  planetary scale produces visible jitter.
- **DECIDED: f64 math in JS throughout; convert to camera-relative f32 only at the final GPU upload.** Subtract large positions in f64
  and hand small deltas downstream.
- **DECIDED: the frame chain** (summary; canonical definitions in `COORDINATE_SYSTEM.md`): `SSB → heliocentric → planet-centered
  inertial (EQJ, ICRF-aligned) → planet-fixed rotating → local floating-origin scene`. Each frame has an explicit origin, axes, units, and owner
  module. Naming conventions (`Frame`, `toPlanetFixed`, `LocalScene`) are fixed there and used verbatim in code.
- **Keep rendered local scenes small** — inside the ~1e5–1e6 m regime — by rebasing the floating origin as the player moves; the
  practical ceiling is pinned by spike S0.1.
- Geodesy on Earth uses WGS84 ⇄ ECEF ⇄ ENU with explicit ellipsoidal-vs-orthometric height handling; the reference implementation choice
  (GeographicLib, MIT, is the candidate) is a named spike output.
- Golden tests (§46) protect this module forever: a regression here is a regression of the whole game.

## 14. Physics

**DECIDED: Rapier** (Apache-2.0) as the physics engine — WASM, TypeScript-native bindings, the deterministic compat build
(`@dimforge/rapier3d-deterministic-compat`; verify the exact package name at pin time) for determinism-critical use such as the S0.11
cross-platform determinism work, the verified general build (`@dimforge/rapier3d-compat`, see `ARCHITECTURE.md` §13) otherwise — and it
ships the two controllers we need out of the box:
`KinematicCharacterController` for the avatar and `DynamicRayCastVehicleController` for ground vehicles.

Rules:

- **One Rapier world per celestial body.** Rapier's `World.gravity` is global per world and `gravityScale` only scales magnitude — you
  cannot express per-body gravity directions inside one world. Micro-gravity environments (orbit, station interiors) run a **zero-g
  world + manual gravity application** instead.
- **No f64 WASM bindings exist** for Rapier `[EXTERNAL]` — the engine is f32 internally. This is why floating origin is *mandatory* (§7,
  §13): keep every physics world's local coordinates small.
- **LOD of simulation**, per the founder's fidelity tiers (§7): far objects run analytical orbital mechanics; the player's vicinity runs
  full collision physics; nothing in between simulates expensively. Do not run N-body physics for everything — patched-conic
  approximations first (§27); advanced N-body is an optional later mode and must prove deterministic cross-platform before ever touching
  the authoritative server (§51).
- Gravity must depend on the celestial body: walking on Earth, the Moon, and Mars must feel different. Use the gravitational parameter
  **μ = GM** from the body's data record — never assume a constant 9.81 m/s².
- Atmosphere matters: drag, entry heating approximation, aerodynamic forces, and parachutes are simulated at gameplay fidelity, not CFD
  fidelity (§27).

## 15. The Frame Chain and Scene Layout

The frame chain is the load-bearing abstraction that makes the continuity promise (§1) possible. Summary (canonical spec:
`COORDINATE_SYSTEM.md`):

- **SSB frame** — the solar-system barycenter frame, defined and reserved for the Interstellar phase; no code computes it
  (COORDINATE_SYSTEM.md §1).
- **Heliocentric frame** — the computational root where the ephemeris adapter evaluates astronomy-engine. Units: metres and seconds,
  always SI, always explicit.
- **Planet-centered inertial frame** — derived by translation/rotation from the heliocentric frame; used for orbital mechanics.
- **Planet-fixed rotating frame** — terrain, cities, and surface features live here and rotate with the body.
- **Local floating-origin scene** — a small, camera-near scene graph where rendering and physics actually happen; rebased whenever the
  player moves far from its origin.
- **Shell transfer:** moving walk → car → rocket → orbit is a chain of scene "shells" handing the player between local scenes while
  world-frame position stays continuous. The rocket ascent (Rapier → Kepler rails) handoff is a named Phase-0 design output, spike S0.7
  — the Kerbal-style pattern is invoked but **undesigned**; do not improvise it ad hoc.
- The world model is hierarchical and extensible — `Universe → Galaxy → StarSystem → CelestialBody → Region → SimulationZone` — with no
  code assumption that Sol is the only system (§10). Celestial bodies are **data records, not hardcoded gameplay logic**:

  ```
  CelestialBody {
    id, name, type,
    radius, mass, gravitational_parameter,
    rotation_period, axial_tilt,
    atmosphere { density, pressure, composition, scale_height, ... },
    terrain_source, texture_source,
    orbit { parent_body, elements },
    satellites []
  }
  ```

  Real astronomical data fills these records from the sources in §33 and `DATA_SOURCES.md`.

## 16. Ephemerides and Time

- **DECIDED: `astronomy-engine`** (MIT, ~116 KB `[EXTERNAL]`) for planetary positions and events. Its accuracy is ±1 arcminute ≈ 112 km
  at the Moon's mean distance `[EXTERNAL]` — that is **sky/event quality** (what the Moon looks like from Stone Town tonight), **not landing
  guidance**. Landing and rendezvous use our own f64 orbital propagation (§27). Use its topocentric `Observer` support for sky-correct
  rendering.
- **satellite.js** (MIT) joins later for artificial satellites; SPICE kernels are redistributable **unmodified only** and the SPICE
  toolkit is not — fetch kernels at build time; JPL Horizons has no redistribution license, so precompute reference fixtures at build
  (§46).
- **One shared universe clock** (pillar 3, §2): every client and the server agree on simulated time; planetary positions, day/night, and
  the Moon's phase are identical for all players.
- **DECIDED: TT vs UTC leap-second handling is a Phase-0 deliverable (spike S0.7)** — it gates the networking time-sync schema and
  world-state persistence; do not ship a schema that ignores it.
- **Golden fixtures:** a Python oracle — Skyfield (MIT, de440s.bsp) + astroquery/Horizons (BSD) — precomputes committed test fixtures
  that the in-game ephemeris must match (§46).

## 17. Backend

**DECIDED: Nakama OSS** (Apache-2.0, self-hosted, Go server + PostgreSQL) for accounts, friends, groups, chat, presence, storage, and
matchmaker — with a **Go runtime for all authoritative simulation**.

Non-negotiable runtime facts:

- The **TypeScript runtime (goja) is ES5, single-threaded, and WASM-free** `[EXTERNAL]`. It is acceptable for RPC glue only. Every match
  handler, validator, and simulation loop lives in the **Go runtime**. There is no scenario where simulation runs in TS.
- **Match state is in-memory and never auto-persisted** by Nakama. Crash-resume requires explicit snapshots to storage (§24).
  `emptyTicks` termination policy is ours to implement. `MatchLoop` must finish before the next tick — no long-running work inside it.
- **Clustering is an Enterprise feature.** We design **single-node** and keep an escape hatch: the authoritative state we own lives in
  plain PostgreSQL we control, and the Apache-2.0 client API surface is re-implementable if outgrowing Nakama ever becomes necessary. Do
  not build as if a cluster exists; do not paint us into a corner either.
- The browser SDK is **`@heroiclabs/nakama-js` 2.8.0, pinned** (npm scope — the plain `nakama-js` package is gone; ARCHITECTURE.md §13)
  `[EXTERNAL]`, so expect to read its source and pin the exact version.
- **Ports:** client HTTP+WS 7350, console 7351, gRPC 7349, gRPC-console 7348. ("Console on 7349" is stale folklore — it is 7351.)
- **Metrics:** `metrics.prometheus_port` defaults to 0, i.e. **disabled** — set it explicitly and watch `GaugeSessions`,
  `GaugePresences`, `CountWebsocketOpened/Closed`, and `ApiRpc` (§49).
- Pin the Nakama server version from the versions table (`ARCHITECTURE.md`) at the time you start, verifying at write time — prose in
  this file deliberately does not hardcode it (§23).

## 18. Voice

**DECIDED: LiveKit** (self-hosted; server, `livekit-client` JS SDK, and node-sdks — all Apache-2.0) for proximity and long-distance
voice.

- **Embedded TURN is the default** (LiveKit v1.4+ embedded TURN), on a **real domain with a real CA certificate** — self-signed does not
  work with browsers. This is critical for East African CGNAT players, where direct P2P often fails. `coturn` as a separate container is
  the fallback only if the 443 conflict is genuinely unsolvable (second IP or SNI passthrough; Caddy owns 443, §19).
- **There is no official Nakama integration.** The Go runtime mints HS256 LiveKit access tokens (JWT with room grants) via an RPC. A
  circulating `nakama-plugin-livekit` URL is **debunked** — do not chase it.
- **Spatialization:** LiveKit v2 removed its built-in spatializer. Use `RemoteAudioTrack.setWebAudioPlugins` feeding a `PannerNode`
  chain; the verified bridge into three.js is `Audio.setMediaStreamSource` — defined on the base `Audio` class and used via
  `PositionalAudio`, which inherits it (NETWORKING.md §10). **One shared `AudioContext`** serves the game's `AudioListener`, LiveKit, and
  the custom mixer — never create a second context.
- **The Chromium AEC trap, and the product decision it forces:** Chromium's echo cancellation does **not** hear WebAudio output
  (chromium bugs 121673, 686665 `[EXTERNAL]`), so open-mic players would echo the entire game's audio. **DECIDED: push-to-talk is the
  default**; open mic is opt-in with headphones guidance. This is simultaneously the accessibility and the safety design (§32).
- **Codecs/bandwidth:** speech preset 24 kbps + DTX, not the 48 kbps music preset `[EXTERNAL]`;
  disable RED (redundant encoding) when bandwidth matters. Autoplay policy: call `Room.startAudio()` inside a user gesture.
- **Moderation is server-side only:** RoomService mute. Client mute is convenience, not control.
- **Proximity = subscription culling** in the Go runtime via the AoI grid (§29), so voice channels follow the same interest management
  as state.
- Krisp noise filtering is LiveKit **Cloud**-only — out of scope for the self-hosted stack.

## 19. Infrastructure

- **docker-compose first.** Services: Caddy (edge), Nakama + Nakama-Go-runtime build, PostgreSQL, LiveKit, Prometheus/Grafana, the
  static client. Kubernetes-compatible later; do not build K8s-specific assumptions now (founder's rule, preserved).
- **Caddy** is the single edge: automatic TLS, serves the static client, proxies same-origin `/api` to `nakama:7350`, HTTP/3,
  gzip/zstd/brotli for compressible assets — never brotli/deflate for `.glb`/`.ktx2`; `.glb` keeps plain gzip (meshopt payloads still
  shrink under it) and `.ktx2` ships identity (ASSET_STRATEGY.md §3/§6; §22). The Nakama **console (7351) stays internal-only** — never
  exposed.
- **Caddy reload closes WebSockets** (`stream_close_delay` mitigates, does not eliminate) — the client's reconnect/rejoin flow is a
  first-class feature, not an error path (§29).
- **PostgreSQL 16** with real backup discipline: `pg_dump` sidecar, rotation, offsite copy, and a **restore drill on video** before
  Alpha (§52).
- **Observability:** Prometheus + Grafana. **Grafana is AGPL — run the unmodified image only, never fork it into the repo.**
  OpenTelemetry traces where useful (§49).
- **Skipped on purpose:** MinIO (AGPL + archived — Caddy static serving now; SeaweedFS if S3 semantics are ever needed) and Redis
  (tri-license ambiguity — Valkey if a cache ever proves necessary). Do not "temporarily" add them.
- **Change every Nakama default** before any deployment: `socket.server_key`, `session.encryption_key`,
  `session.refresh_encryption_key`, `runtime.http_key`, console credentials (§49).
- Dev environment is WSL2 on Windows 11 (§48); `docker compose up` must yield a working, TLS-served game on the first clean checkout.

## 20. Earth Data Pipeline

The pipeline turns open geodata into streamed web content. Chain:

1. **Source:** Geofabrik `tanzania-latest.osm.pbf` (ODbL; **record the pbf timestamp** in the provenance table — a dataset not in
   `DATA_SOURCES.md`'s table may not be used, §43).
2. **Extract:** `osmium extract --bbox` per region (§8) — never process whole-country blobs per build.
3. **Vector tiles:** **planetiler** (Apache-2.0; Java 21+ or Docker; ~0.5× pbf-size RAM, 5–10× SSD `[EXTERNAL]`; pinned Protomaps
   profile) → **per-region PMTiles** (BSD-3; spec CC0), served with **CORS + HTTP range requests**. Never one giant global archive —
   regions stream independently.
4. **3D buildings:** **OSM2World** (MIT — the widely repeated LGPL claim is wrong, verified) → glTF → **3D Tiles** via `3d-tiles-tools`,
   streamed by the NASA-AMMOS `3d-tiles-renderer` (Apache-2.0). Expect **sparse height tags**: most buildings get flat/procedural
   extrusions from the Swahili-coast kit (§35), not accurate facades.
5. **Terrain meshes:** **delatin** (ISC) pre-baked meshes (martini as dormant fallback), built offline, streamed as static artifacts.
6. **Surface map UI:** **MapLibre GL JS** (BSD-3) rendering the PMTiles; preserve its combined multi-license `LICENSE.txt` file
   wholesale.

Elevation sources and their traps:

- **Copernicus GLO-30 DSM** — primary land DEM. Filter buildings/trees (WBM water mask); **no ocean tiles — flatten the sea to the
  reference level or the Indian Ocean becomes a numeric cliff**. License is not in SPDX; use the exact attribution string `Contains
  modified Copernicus data [year]` (§44).
- **SRTM** (public domain) — C-band canopy bias; secondary.
- **GEBCO_2026** (public domain) — ~465 m resolution `[EXTERNAL]`: fine for the Zanzibar Channel, useless at reef scale.
- Mapzen terrarium (public domain) — frozen 2018; prototype only.

Footprint fallbacks and hard license walls:

- Google Open Buildings v3 is CC-BY 4.0 (rendering OK; its ML-training restriction needs legal eyes before any dataset publication).
- **Overture CDLA-Permissive is incompatible with ODbL — never mix Overture data into OSM-derived layers.**
- **Cesium ion OSM Buildings is ToS-locked and non-redistributable — always self-host our own pipeline instead.**
- **ODbL share-alike (the load-bearing rule):** every OSM-derived artifact — `.pmtiles`, building meshes, terrain derivatives — is a
  **derivative database**. They ship in the separately-licensed ODbL `data/` layer, never folded into the permissive code tree (§42–43).

## 21. Asset Pipeline

The wire-format chain, end to end:

- **Authoring:** Blender 5.0 → `glTF-Blender-IO` (Apache-2.0; an exported `.glb` carries **no GPL obligation**).
- **Optimization:** `gltf-Transform` (MIT) — weld, prune, quantize — then `gltfpack`/`meshoptimizer` (MIT) for LOD generation. These are
  complementary stages, not alternatives.
- **DECIDED: `EXT_meshopt_compression` + `KHR_mesh_quantization` + `KHR_texture_basisu`/KTX2 — not Draco.** Draco's browser/tooling
  story went stale in early 2024; meshopt decodes on the main thread cheaply and pairs with the WASM decoder budget.
- **Textures:** ETC1S (via KTX2/Basis Universal) for color, UASTC for normals + ORM maps — a 4–8× VRAM win `[EXTERNAL]`. Pin
  **KTX-Software 4.x** (v5 is mid-transition; the distribution contains one non-open Ericsson file — **consume binaries, never vendor
  the sources**).
- Basis transcoder WASM size is part of the load budget (S0.3).
- Every artifact ships with a content-hashed URL and an entry in the attribution ledger (`THIRD_PARTY_ASSETS.md`); a source asset
  without a ledger row does not enter the pipeline (§44).

## 22. Client Caching and Storage

Players on the assumed 5–10 Mbps envelope (§4) make the cache a core system, not an optimization:

- **Content-hashed URLs + `Cache-Control: immutable`** for every asset; the browser cache does the first layer of work.
- **Cache API + IndexedDB manifest** with sha-256 integrity computed via `crypto.subtle.digest` — note that standard SRI headers **do
  not apply** to `fetch()` of game assets; the manifest is our integrity layer.
- **`navigator.storage.persist()` is mandatory** at first launch — without it the browser may evict a multi-hundred-MB cache under
  storage pressure. Handle the denial path gracefully (re-download).
- Use `navigator.storage.estimate()` to drive an LRU eviction policy over our own manifest.
- **Do not brotli `.glb` or `.ktx2`** at the edge — they are already compressed; double compression burns CPU and saves nothing.
- Design every loader for **cache misses**: the game must survive an evicted cache with a loading screen, not an error (§4).
- Safari's 7-day eviction of script-writable storage is one of the reasons iOS is out of scope (§3).

## 23. Version Pins and Dependency Discipline

- The **single versions table lives in `ARCHITECTURE.md`** with a *verify-at-write-time* rule: pins are recorded there, checked against
  upstream at each adoption, and never hardcoded in prose elsewhere (including this file).
- Pins known at research time (verify, do not trust blindly — the table in `ARCHITECTURE.md` §13 owns the values): the browser SDK is
  `@heroiclabs/nakama-js` 2.8.0 (npm scope — plain `nakama-js` 404s) and `livekit-client` is 2.22.2, both verified 2026-09-05. The
  "LiveKit v1.13.x" from early research conflated the LiveKit *server* with the client SDK — never pin it; the server pin lands at
  Phase 0. Nakama server: pin the current stable 3.x when you begin (research found 3.32/3.37/3.40 in circulation — verify, then
  record).
- **No dependency without a ledger row** (`THIRD_PARTY_ASSETS.md` / `LICENSES.md`) whose license evidence is the actual `LICENSE` file
  **fetched at the pinned commit**. npm/GitHub sidebar metadata has been wrong in practice — this exact procedure already corrected
  three mislabeled packages (three-tile's GPL history, `OrbitalObject3D`, `delatin`).
- Prefer boring, maintained, permissively-licensed dependencies. Evaluate every candidate repo on: license, quality, maintenance,
  engine/framework compatibility, architecture fit, performance, portability. Do not blindly copy abandoned repositories.

---

# PART D — GAMEPLAY

## 24. Identity, Accounts, and Persistence

- Players create persistent accounts with usernames, display names, avatars, and online status (`User { user_id, username, display_name,
  avatar, created_at, last_seen, online_status, current_location }`). Nakama provides the account/friends/storage substrate (§17).
- Each user plays one or more **characters** (`Character { character_id, user_id, appearance, inventory, position, current_body, health,
  money, skills, achievements, owned_vehicles, discovered_locations }`). Configurable avatars first; detailed character customization
  later.
- **Persistence rule:** what matters survives. Player location, character, inventory, currency, discoveries, owned vehicles, bases,
  achievements, missions, friends, and settings persist. **Realtime simulation state stays in memory**; periodic snapshots and important
  events are persisted — never write every physics frame to PostgreSQL (founder's rule, doubly true when the database also has to
  survive a crash: match state in Nakama is in-memory only, §17, so the snapshot cadence *is* the crash-resume design).
- **Spawn where you logged out.** The first thing a returning player sees is their last position — this single behavior is most of what
  "persistent universe" means to a player.
- **Server-authoritative always** for: inventory, money, teleportation, vehicle ownership, discoveries, achievements, trade, and major
  vehicle state. Clients propose; servers dispose (§29).

## 25. Locomotion Progression

The spine of the game is the seamless progression **walk → car → rocket → orbit → Moon**. Each stage must feel continuous with the
previous one (§1, §15):

- **Walk:** kinematic character on real terrain (`KinematicCharacterController`, §14), per-body gravity (§14), real ground from the data
  pipeline (§20). Walking Stone Town's seafront is the Phase-3 proof.
- **Drive:** approach a vehicle, enter, take control, exit (§26). The Phase-4 proof is a scripted loop through Dar es Salaam streets
  with believable suspension.
- **Launch:** enter a rocket at a real pad, ignite, ascend through atmosphere with drag and heating approximations, stage, reach orbit
  (§26–27).
- **Orbit:** patched-conic mechanics, transfer planning (autopilot/planner UI), station-keeping.
- **Land on the Moon:** enter lunar SOI, descend, touch down, exit, walk in 1/6 g.

**Navigation scales with the player** — three map modes in one UI continuum:

- **Surface map:** roads, cities, POIs, players, missions (MapLibre + PMTiles, §20).
- **System map:** planets, moons, orbits, stations, spacecraft, transfer trajectories.
- **Galactic map (later):** stars, nebulae, known systems, wormholes, player discoveries.

The UI transitions between scales elegantly — zoom is continuous, cutscenes are not involved.

Exploration overlays on all of this: discoveries (§10) and landmarks are first-class map objects.

## 26. Vehicles

**One unified vehicle framework**, not N special cases:

```
Vehicle {
  vehicle_id, owner, position, velocity, orientation,
  fuel, health, seats, cargo,
  propulsion_system, control_system
}
```

- **Types:** `GroundVehicle`, `Aircraft`, `Rocket`, `Spacecraft`, `Rover`, `Boat` — introduced in that order of priority (ground first).
  Future/prototype types plug into the same interface.
- **Interaction loop:** approach → open → enter → choose seat → take control → exit. Plus: own, store, damage, refuel, repair. Passenger
  seats enable multiplayer transport from day one of vehicles (§29).
- **Cars:** steering, acceleration, braking, suspension, collisions, headlights, ownership, multiplayer synchronization
  (`DynamicRayCastVehicleController`, §14). Realistic enough to feel convincing — not a racing simulator (§3).
- **Rockets are actual controllable vehicles — never a cutscene.** A player walks to the rocket, enters, sits in the cockpit, starts
  systems, ignites, launches, leaves the atmosphere, reaches orbit. Architecture includes stages, engines, fuel tanks, thrust, mass,
  drag, staging, guidance, landing systems, and (later) docking ports and modular rocket construction.
- **Spacecraft:** cockpit, seats, propulsion, fuel, power, docking, landing, autopilot, navigation computer, communications, cargo,
  ownership. Walkable interiors in large craft come later — the frame chain already supports a local scene inside a moving parent (§15).
- Vehicle assets: Kenney Car Kit (CC0) + NASA public-domain models (insignia stripped, §33) + TRELLIS-generated parts where policy
  allows (§34); the Swahili-coast flavor (daladala, bajaji, dhow, mashua) comes from our own CC0 kit (§35).

## 27. Orbital Rules

- **Patched-conic first.** Each celestial body owns a sphere of influence with μ = GM; trajectories are conic sections patched at
  boundaries. **N-body is an optional later mode** — and before it ever touches the authoritative server it must prove deterministic
  across platforms (§51, §53).
- **Server-side orbital state is validated, not simulated:** the Go runtime replays closed-form orbital/kinematic motion and compares
  against client claims with drift thresholds (§29). There are **no Go Rapier bindings** — nobody is running "server physics".
- **Atmospheric flight and entry** are progressive, not a loading screen: density/pressure/ temperature from the body's atmosphere
  record (§15); drag, entry heating approximation, aerodynamic forces, parachutes, and landing at gameplay fidelity (§14, §26).
- **SOI handoff** between patched conics and local physics (and rails-mode transitions, §28) is the **named spike S0.7 deliverable** —
  the Kerbal Space Program pattern is invoked as prior art but is not designed here; produce the ADR before implementing.
- Accuracy expectation discipline: astronomy-engine gives sky-quality positions (§16); anything that must *land* uses our own f64
  propagation validated against the Python oracle (§46).

## 28. Time-Warp Semantics

- **Two-mode travel:** below a defined threshold, motion is full Rapier physics at fixed timestep with client interpolation; above it,
  craft ride **"rails"** — analytic Kepler propagation (`M = M0 + n·t`) on kinematic bodies. The threshold value and the handoff
  behavior are spike S0.7 outputs `[PLACEHOLDER — gate: S0.7]`.
- **The universe clock is shared** (§16): warp happens in simulated time. All players' universes advance the same clock; what one
  player's warp does to *their* craft, and how it appears to a co-located observer, is exactly the S0.7 design question. Do not ship
  ad-hoc per-player time.
- **TT vs UTC leap-second policy is part of the same spike** (§16) and gates the world-state schema — a timestamp format that ignores
  leap seconds will silently drift ephemeris accuracy.
- Real-time is the default experience; time acceleration, autopilot, and a transfer planner make the Solar System playable without FTL
  (§7). Warp, wormholes, and exotic propulsion are later, fictional, and explicitly framed in-fiction (§10).

## 29. The Multiplayer Model

**The goal is the illusion of one persistent universe — not one giant server process.**

- **DECIDED: a single monolithic Nakama node serves everything at first** (clustering is Enterprise-gated, §17). Scale strategy is
  vertical capacity + interest management, with the plain-Postgres escape hatch (§17). Make **no capacity promises anywhere in the
  docs** — there is zero benchmark data until S0.8 measures it.
- **Interest management (AoI):** the Go runtime implements an area-of-interest cell grid. No framework ships spatial interest management
  — we build it. Cell sizes and tick cost come from the S0.8 micro-benchmark `[PLACEHOLDER — gate: S0.8]`. **Never synchronize every
  entity to every client**; players receive only their AoI.
- **DECIDED — message budget hard rules:**
  - Wire messages ≤ **1500 bytes** each (fits a single MTU path; Nakama's default
    `max_message_size_bytes` is 4 KB `[EXTERNAL]` and an oversized message gets the connection **closed**).
  - Target ~1 message per tick per presence.
  - Prefer one 1000 B/s stream over five 200 B/s streams — per-message overhead dominates.
  - Nothing exceeds these rules — a feature that cannot fit takes the delta/compression path (`NETWORKING.md` §4); the cap never moves
    (`CLAUDE.md`).
- **Authoritative model:** Go match handlers own game truth. The full Nakama callback list
  (`MatchInit/JoinAttempt/Join/Leave/Loop/Terminate/Signal`) is documented in `NETWORKING.md`; the TS runtime is RPC glue only (§17).
- **Server validation = closed-form replay:** the validator re-integrates a client's claimed path with the same kinematic/orbital model
  and rejects or corrects on drift beyond threshold (§27). The validation contract is the S0.6 deliverable: record a real car path,
  replay it, measure the drift, write the contract. **Docs must not promise "server-authoritative physics" — there is no server
  physics.**
- **Client prediction where appropriate:** local prediction + reconciliation for the avatar and the driven vehicle; interpolation for
  everyone else. Design patterns are linked (Gaffer on Games — **link only, never reproduce text**, §43); the implementation is ours.
- **Reconnect is a feature:** Caddy reloads, mobile networks hiccup, laptops sleep — mid-session reconnect must recover position and
  state (§19).

## 30. Voice and Social

- **Proximity voice** is spatial and distance-attenuated (§18); walls and interiors may affect it later. Voice follows the same AoI as
  game state (§29).
- **Communication devices** let players reach across space: direct messages, long-distance voice, group calls, channels. Spacecraft
  radio is flavor: range and interference may be simulated; **signal delay is optional and off by default** — realism that reduces fun
  stays optional (§10).
- **Presence** shows friends in the world: *"Benjamin — Mars, Olympus Mons region" · "Dinales — Earth, Dar es Salaam" · "Camillia — in
  transit, Earth → Moon"* (§32 governs precision privacy).
- **Social systems:** friends, text chat, channels, DMs, parties, then crews/organizations and block lists later. Players should be able
  to make friends through exploration — shared journeys are the point (§51's north star).
- Voice is behind moderation (§18, §32) and push-to-talk by default (§18).

## 31. The Deliberately Thin Economy

- **Design an economy, but keep it disabled/simple during early development.** Currency, vehicle purchase, fuel, repairs, property,
  trading, crafting, resources, and missions are future concepts, enumerated in the data model so schemas don't paint us into a corner.
- **When it exists, the economy is server-authoritative** — every trade, price, and balance change is validated server-side (§24).
- **No real-money mechanics, ever** (§3). The economy exists to give normal-life gameplay texture (§10) — markets in Dar es Salaam, fuel
  for the dhow, a fare for the daladala — not to monetize players.
- Do not let economy creep into Phases 1–8 (§51). The vertical slice ships without currency.

## 32. Safety, Privacy, and Moderation

- **Presence privacy levels:** Public / Friends / Party / Private. "Online on Mars" may be public while exact coordinates remain
  private. Location precision respects the setting everywhere it is displayed (§30).
- **Voice safety stack:** push-to-talk default (§18), server-side RoomService mute that cannot be bypassed client-side (§18), block
  lists, and report paths. Voice recordings, if ever made, require written releases (§33).
- **Compliance map is a named spike (S0.12):** Tanzania PDPA 2022, Kenya DPA 2019, and GDPR all plausibly apply — produce the data map,
  retention policy, and consent/export/deletion flows before Alpha.
- **Accounts:** proper password hashing, token authentication, refresh tokens, server-side authorization, rate limits, secure WebSocket
  authentication — much of this is Nakama's, but the configuration discipline is ours (§49).
- **Admin/moderation tooling** (Phase-Alpha scope): authorized operators view online players, inspect servers/regions/players, moderate,
  teleport, manage assets, and view telemetry (§49).

---

# PART E — CONTENT

## 33. Asset Source Policy

Everything shipped is open, verified, and ledgered. Verified-clean sources (full provenance table: `DATA_SOURCES.md`; asset ledger:
`THIRD_PARTY_ASSETS.md`):

- **Planetary data — NASA PDS / USGS Astrogeology (US public domain):** LOLA (to 512 ppd ≈ 59 m/px `[EXTERNAL]`), SLDEM2015, LROC WAC,
  MOLA (128 ppd), Viking MDIM, THEMIS, Magellan FMAP, MESSENGER MDIS, Cassini/Voyager imagery, New Horizons, Dawn, Blue Marble NG (500 m
  monthly), Natural Earth. **The whole Solar System is legally clean** from these chains. Solar System Scope textures (CC BY 4.0) are
  the fallback for bodies PDS coverage misses.
- **CC0 libraries (verified):** Poly Haven, ambientCG, Kenney, KayKit — PBR materials, HDRIs, vegetation, props, and the vehicle starter
  kits (§26).
- **NASA 3D models** are public domain — but **strip NASA insignia/logotypes from every model, never render the insignia in UI, and
  never imply NASA endorsement** (§44). Verify each model individually.
- **Prohibited regardless of anything else:** DLR (CC BY-NC-ND), ESA (CC BY-SA-NC), EOX Sentinel-2 cloudless (CC BY-NC-SA) —
  NonCommercial/NoDerivs content never ships. Stellarium/Celestia are GPL — **study-only**; design summaries in our own words, zero code
  or asset copying (§43). **Quaternius is no longer CC0** (Asset License v1.0 forbids standalone redistribution) — usable in-game, but
  never commit the packs. Sketchfab: CC0/CC-BY verified **per model only**. Freesound: CC0/CC-BY rows only — the site is a mixed-license
  hazard.
- **Verification procedure:** license text fetched from the source at the pinned commit/URL, per §23 and §45. A dataset or asset missing
  from the provenance table may not be used — no exceptions for "just a prototype".

## 34. AI-Generated Asset Policy

AI generation is a tool in the workshop — with provenance and license discipline:

- **TRELLIS** (MIT, weights included) is the cleanest AI mesh generator — usable and committable.
- **Hunyuan3D:** outputs are shippable ("Tencent claims no rights in Outputs"), but the model license **excludes EU/UK/KR, caps 1 M MAU,
  and forbids output-training** — never commit the weights, always record provenance (model, version, prompt, date) in the ledger.
- **Meshy/Tripo are unverified — do not ship their output.** Anything unverified stays unshipped until a license check lands (§43).
- **Never rely on raw AI 3D for hero content.** AI meshes tend to have poor topology, excessive polygons, broken UVs, baked textures,
  and no collision setup. The division of labor:
  - **Hero assets** — carefully generated, then hand-cleaned in Blender.
  - **Common assets** — open-source libraries, modified where needed.
  - **Buildings/cities** — modular kits assembled on OSM footprints (§35). *Never* individually AI-model a city.
  - **Vegetation** — instanced from libraries. **Terrain** — real elevation data + procedural dressing (§36). **Rocks/debris** —
    procedural.
- Every AI-generated asset carries its ledger row (model/version/prompt/date) before commit (§44). Never imply NASA or any agency
  authored AI content ("according to NASA" is forbidden, §44).

## 35. The Swahili-Coast Modular Kit

The signature content system. **DECIDED: we author our own Swahili-coast kit, licensed CC0, in Blender** — and assemble it procedurally
on OSM building footprints. Our kit is CC0; the footprints remain ODbL `data/` (§42). This is how Stone Town gets recognizable geography
without AI-modeling 20,000 buildings or baking the GPU (§34):

- **Kit pieces:** coral-stone walls; carved Zanzibar doors; arched windows; wooden balconies; corrugated and mangrove-pole roofs; stone
  walls; shop fronts; awnings; stairs; street lamps; market stalls; alleys; courtyard pieces; mosque architectural modules; baraza
  benches; street props; coastal vegetation (baobab, palms, mangroves).
- **Watercraft and transport:** dhow, mashua, daladala, bajaji — as vehicles and as static set dressing (§26).
- **Assembly:** OSM footprints + height tags drive placement and extrusion; where height data is sparse (it will be — §20), the kit's
  parametric variants carry the visual load. Roads and street layout come from PMTiles (§20).
- **Tone rules (§9):** the kit must read as *authored* — regional color moods, wear patterns, materials — not as generic tropical props
  with a Swahili door pasted on. Tier-1 regions (Dar es Salaam, Stone Town) get kit priority; the kit grows with each new region (§8).
- The kit is a first-class open-source contribution in its own right: CC0, documented, reusable by anyone — part of how Kwetu gives back
  to East Africa's representation in open worlds.

## 36. Terrain, Atmosphere, and Ocean

- **Terrain:** real elevation data first (§20's DEM chain), procedural detail second. Planet-scale rendering uses the S0.2-decided LOD
  scheme (§12); terrain meshes are pre-baked with delatin (§20) and streamed. Do not ship one gigantic mesh — ever (founder's rule).
- **Atmospheres are per-body data** (§15): density, pressure, composition, scale height, temperature. Visually: Rayleigh + Mie
  scattering approximations, sunrise/sunset effects, and the space-to-ground transition rendered continuously — atmospheric flight is
  never a loading screen (§27). Earth, Mars, Venus, and Titan must each behave differently.
- **Ocean:** the Indian Ocean is flattened from the DEM by rule (§20 — no ocean tiles), then rendered as water. Wave/shader fidelity is
  a measured budget decision, not a hero feature; the Zanzibar Channel reads correctly at GEBCO's coarse resolution only in the far
  field (§20).
- **Vegetation and terrain dressing** are procedural fills over the data skeleton (§35): savannah and coastal biomes for East Africa,
  biome rules driven by latitude/elevation data later.
- Atmosphere/ocean rendering approach (shader stack, scattering model) is decided in the renderer spike and recorded as an ADR before
  implementation spreads.

## 37. Sky, Satellites, and Far Field

- **Stars:** the Hipparcos magnitude-limited subset (~1–2 MB `[EXTERNAL]`) is the star catalog — Gaia is unusable in-browser. Stars
  render as data: positions, magnitudes, colors.
- **Sky correctness is a feature:** the Moon's phase from Stone Town, the position of Mars at midnight, sunrise direction over Dar es
  Salaam — all come from astronomy-engine's topocentric observer (§16). "The Moon moves through the sky according to its orbit" is a
  design requirement (§51), not a slogan.
- **Artificial satellites** come later via satellite.js (§16), validated against Horizons-derived fixtures (§46).
- **Far field:** Blue Marble NG and Natural Earth imagery for the Earth globe at distance; PDS mosaics for other bodies (§33). Far-field
  imagery licensing is a named open item in the renderer/atmosphere spike — do not assume any pretty globe texture is shippable.
- Planets and moons render as points → discs → LOD spheres as distance decreases, continuously (§12) — no popping.

---

# PART F — LOCALIZATION

## 38. Swahili-First Rules

- **Swahili is first-class, from the first UI screen** (§5). Concretely:
  - A string lands in English **and** Swahili in the same change, or it does not land.
  - **No hard-coded English in components** — ever. Lint/enforce.
  - A shared **glossary file** governs agents and translators (key terms: *nyumbani*, *baraza*, vehicle/control terms) so terminology
    stays consistent across contributors who never meet.
- **Swahili runs ~10–20 % longer than English** — an assumption pending the measured length-diff report (owner: `docs/swahili-i18n.md`
  §1, measured per §9) — size every UI surface for it from day one (flex layouts, no fixed-width labels, ellipsis never hides content).
- **Pseudo-localization builds** (accented padding, bracketing) run in CI to catch truncation and hard-coded strings before a real
  translation exists.
- Locale is **player-chosen**, not platform-detected (§40).

## 39. The i18n Pipeline

**DECIDED: gettext PO files are the source of truth; i18next is the runtime.**

- PO files organized per domain/screen, with **`msgctxt` per screen** and natural-language keys.
- Plural rules: Swahili is `nplurals=2; plural=(n != 1);` — set the header **explicitly** and lint it. **Corrupted Swahili Plural-Forms
  headers circulate in the wild** (an Arabic-style `nplurals=6` header was found in a popular corpus) — the lint rejects wrong headers
  on sight.
- Pipeline: **PO → `i18next-conv` → namespaced JSON** per locale.
- **Load lazily:** locales fetch over HTTP at runtime per-locale — never ship both languages in the main bundle (§22's budget discipline
  applies to strings too).
- The pipeline is UI-stack-agnostic (DOM or canvas — S0.10 decides the UI stack), so i18n outlives any particular UI implementation.

## 40. Locale Data

- **CLDR `sw`** (Unicode License V3) supplies dates, numbers, month names (*Januari…Desemba*), and day names. **Format with the
  player-chosen locale**, not the platform's.
- **Safe-reuse stack, ordered** (best first): CLDR/Wikidata (CC0) → Ubuntu/Rosetta (BSD) → Mozilla localization (MPL-2.0, file-separate
  + attributed) → **avoid KDE** (license friction) → **never NonCommercial corpora**.
- MPL-2.0 material, if used, stays in its own clearly-marked files with attribution (§43–44) — never merged into Apache-2.0 source.
- The UI font must carry full Swahili glyph coverage; the OFL font choice is part of spike S0.10, with the font's license row in the
  ledger (§33).

## 41. The Toponym Table

Place names are cultural data and get a dedicated, conservative pipeline:

- **Sources:** Wikidata (CC0) for canonical identifiers; GeoNames (CC BY 4.0) filtered to preferred-Swahili rows; OSM `name:sw` tags as
  a thin cross-check layer only (32,138 objects — count owned by `docs/swahili-i18n.md`; real but uneven coverage).
- **The label trap, learned the hard way:** Wikidata's Swahili *label* for Stone Town is the district name `Wilaya ya Unguja Mjini`; the
  beloved local name `Mji Mkongwe` exists only as an *alias*. **Never blind-import labels** — a frozen, human-reviewed toponym table is
  the gate.
- **The ODbL contamination rule:** the moment OSM-derived names become load-bearing in the toponym table (rather than cross-checks), the
  whole table becomes an ODbL derivative. Keep the table Wikidata/GeoNames-sourced; use OSM only to verify.
- The table ships with the localization data (F), is versioned, and grows through the same human-review gate every time a region is
  added (§8).

---

# PART G — ENGINEERING

## 42. Repository Layout

Monorepo (docs-first today; this is the layout code grows into):

```
kwetu/
├── README.md  PROJECT_VISION.md  MASTER_PROMPT.md  ARCHITECTURE.md
├── COORDINATE_SYSTEM.md  NETWORKING.md  DATA_SOURCES.md  ASSET_STRATEGY.md
├── ROADMAP.md  CLAUDE.md
├── LICENSES.md  ATTRIBUTIONS.md  THIRD_PARTY_ASSETS.md   (legal triad)
├── LICENSE  NOTICE  .gitignore
├── client/            # TypeScript + three.js + Rapier (WASM)
├── server/            # Nakama config + Go runtime modules
├── shared/            # schemas, protocol definitions shared client↔server
├── data/              # the ODbL layer — derivative databases ONLY
│   └── README.md      # states the layer rule (see below)
├── tools/             # pipeline scripts: osmium/planetiler/OSM2World/delatin/Blender
├── infra/             # docker-compose, Caddyfile, Grafana dashboards, backups
├── docs/
│   ├── swahili-i18n.md
│   └── adr/           # ADRs — Phase-0 spike outputs land here
└── tests/             # golden fixtures (ephemeris, determinism), Playwright
```

- **`data/` exists from day one so the share-alike boundary is enforced by directory.** Its README states the rule: *nothing enters
  without provenance, a regeneration path, and a ledger row; this directory is the ODbL layer.* An OSM-derived artifact found outside
  `data/` is a licensing bug.
- `shared/` keeps client and server honest about the wire protocol (§29) and world schema (§15).

## 43. The Licensing Model

**DECIDED: Apache-2.0 for all project code; the `data/` layer is separately licensed ODbL 1.0; assets carry their own per-ledger
licenses.**

- **Why Apache-2.0 for code:** explicit patent grant (matters for protocol/algorithm porting), the NOTICE convention feeds our
  attribution ledger (§44), and uniformity with our core stack (Nakama, Rapier, LiveKit, planetiler). Contributions under **DCO — not
  CLA**.
- **Why ODbL for `data/`:** ODbL share-alike attaches to the *derived database*. Keeping every OSM-derived artifact in `data/` with its
  own license contains the copyleft exactly where the data lives and leaves the permissive code tree clean (§20, §42).
- **The incompatibility register lives in `LICENSES.md`** and is binding knowledge: CDLA-Permissive ✗ ODbL (never mix); Havok (closed
  binary behind an MIT-looking npm LICENSE); CockroachDB (proprietary); Grafana (AGPL — unmodified image only, never fork); MinIO (AGPL
  + archived — skipped, §19); Cesium ion (ToS-locked); Krisp (Cloud-only).
- **Copyright discipline for study:** GPL projects (Stellarium, Celestia, Veloren, OpenMW) are studied and summarized **in our own
  words** — never copied. **Gaffer on Games articles are linked, never reproduced** (© Glenn Fiedler). No song lyrics; no long excerpts
  from copyrighted guides.
- **Verification procedure:** every dependency's license is confirmed from its LICENSE file at the pinned commit — sidebar metadata is
  unreliable and has already been wrong three times (§23). Corrections made during research (recorded in `LICENSES.md`): OSM2World is
  MIT (not LGPL); Rapier recorded Apache-2.0 only (dual-license claim unverified); the PMTiles *spec* is CC0.
- Governance: license questions produce an ADR, not a guess.

## 44. Attribution

Attribution is a first-class deliverable, not an afterthought:

- **In-game credits screen, English and Swahili, verbatim strings** including:
  `© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0` (the full STR-OSM sentence — the ODbL clause is part of
  the string); `Data processed by Geofabrik GmbH`; the Copernicus string `Contains modified Copernicus data [year]`; the NASA
  media-usage acknowledgment. Exact canonical strings live in `ATTRIBUTIONS.md` — copy them byte-for-byte.
- **Map footer** (surface map, §25) carries the OSM and Copernicus strings in both languages, permanently visible, not buried
  (Geofabrik and NASA/USGS credits live in the credits screen — ATTRIBUTIONS.md owns the split).
- **Repo/docs attribution** for code and content sources, fed by the NOTICE convention (§43).
- **Forbidden:** NASA/agency insignia anywhere (strip from models, never in UI); implying endorsement; "according to NASA" or similar on
  AI-generated content; stripping license headers from any third-party file.
- **CI rule: a new ledger row without an attribution string fails the build** — the legal triad (`LICENSES.md`, `ATTRIBUTIONS.md`,
  `THIRD_PARTY_ASSETS.md`) is enforced, not aspirational.

## 45. Agent Coding Conventions

The development method, every time (founder's loop, preserved): understand the requirement → research existing open implementations →
verify licenses → decide reuse/adapt/build → write the architecture → build the minimal implementation → test → profile → document →
commit cleanly.

Hard conventions (mirror of `CLAUDE.md`'s invariants — it is the ≤150-line operational contract and this is the rationale):

- TypeScript strict; no `@types/three` (§12); f64-in-JS / camera-relative f32 at upload (§13); log depth AND floating origin (§12); one
  `AudioContext` (§18); ≤1500 B wire messages (§29); one Rapier world per body (§14); no dependency without a ledger row (§23); never
  copy GPL/AGPL/NC/ND code or assets (§43); never reproduce Gaffer on Games text (§43); never strip Apache-2.0/NOTICE headers (§44);
  never commit an unregenerable or unledgered file to `data/` (§42).
- Strings land EN+sw in the same change (§38). Data-driven definitions over hardcoded logic — celestial bodies, vehicles, and regions
  are records, not code (§15, §26).
- Naming conventions from `COORDINATE_SYSTEM.md` (`Frame`, `toPlanetFixed`, `LocalScene`) are used verbatim — agents copy patterns from
  that document, so it stays the single source.
- **When uncertain: draft an ADR, don't guess.** Small commits; no enormous code dumps before the architecture is validated (founder's
  rule); debug tooling ships with the feature, not after (§46).

## 46. Testing and CI

- **Automated tests** for the correctness-critical core: orbital calculations, gravity, coordinate transformations, persistence,
  accounts, inventory, network message handling, vehicle ownership.
- **Golden ephemeris fixtures:** the Python oracle (Skyfield + Horizons, §16) precomputes committed fixtures; the in-game ephemeris must
  match them in CI. JPL Horizons has no redistribution license — fixtures are precomputed at build time (§16).
- **Bitwise-determinism regression:** the deterministic Rapier build's value depends on cross-platform determinism; CI asserts it (spike
  S0.11 defines the harness).
- **Playwright headless WebGL2** drives browser-level smoke tests (S0.11).
- **Debug tools are essential, not optional** — traveling to the Moon every time we test something would be absurd: teleport-to-body,
  visualize coordinate frames, show floating origin, show velocity, show gravity vector, show network latency, show simulation
  bubble/LOD level, show active terrain chunks, orbit inspector, time-warp controls.
- **i18n QA (Part F):** pseudo-localization build, per-locale screenshots, a no-raw-keys Playwright pass, and an EN-vs-sw length report
  (§38–39).
- **CI also enforces:** ledger-row-has-attribution (§44), license lint, Plural-Forms header lint (§39), and the `data/` regeneration
  check (§42).

## 47. The Budgets Rule

**All performance numbers live in exactly one place: `ROADMAP.md §Budgets`.** This file and every other document *reference* budgets;
they never restate or invent them.

- Every number is tagged: `[MEASURED date+method]`, `[PLACEHOLDER — gate: S0.x]`, or `[EXTERNAL url]`.
- **No exit criterion may depend on a `[PLACEHOLDER]`** — criteria test that a *measurement exists*, not that a guess was optimistic
  enough.
- Budget categories: initial load, draw calls, AoI cells, players per match handler, RTT tolerance, payload sizes per region, decode
  times.
- **Change control:** a budget criterion may be tightened freely; loosening it requires a recorded ADR (§54).
- **The no-unbenchmarked-promises rule** is the project's house discipline: *the project promises nothing unmeasured*. An untagged
  number in any document — including this one — is a defect.

## 48. Developer Environment

- **WSL2 is the primary dev shell** on the Windows 11 host. Present at research time: git 2.52, Node 24, Python 3.14, Docker Desktop,
  Blender 5.0. Godot-era tooling from the founder's original draft is gone — no Godot CLI anywhere in the pipeline.
- `docker compose up` (§19) must produce the full stack: TLS-served client, Nakama + Go runtime, PostgreSQL, LiveKit, metrics. **Mic
  testing requires TLS even locally** — Caddy's local CA handles it; never serve the game over plain HTTP, even in dev.
- Commands are placeholders until code exists (README play/run section, §50); when they land, they land in `CLAUDE.md` and `README.md`
  together.
- Windows host quirks (line endings, WSL2 networking, Docker Desktop file sharing) are recorded in the repo as they're hit — do not
  rediscover them per agent.

## 49. Security Checklist

- **Change every Nakama default before any deployment** (§19): `socket.server_key`, `session.encryption_key`,
  `session.refresh_encryption_key`, `runtime.http_key`, console credentials. Nakama console stays internal-only (§19).
- **Secrets management:** never in the client, never in git. LiveKit API keys live **only in the Go runtime** (§18). Use
  environment/secrets files excluded from VCS, documented in `infra/`.
- **Auth:** Nakama's password hashing/token/refresh machinery, properly configured; server-side authorization on every privileged
  action; rate limits on RPCs; authenticated WebSockets.
- **Anti-cheat posture:** server validation by replay (§29) + rate limits + authoritative state (§24). Assume clients are hostile; the
  universe is shared, so cheating is vandalism.
- **Migrations:** every PostgreSQL schema change ships as a reviewed migration, reversible where possible.
- **Admin tooling** (Alpha scope, §32): operator dashboard for players, servers, regions, moderation, telemetry.
- **Observability:** Prometheus metrics (§17's list), logs, OpenTelemetry traces; **Grafana AGPL rule: unmodified image only** (§19).
  Data-protection compliance per S0.12 (§32).

## 50. Documentation Map

This file summarizes; these documents **own** their subjects. When they disagree, the owner wins and this file gets fixed.

| Document | Owns |
|---|---|
| `README.md` | Identity snapshot, status banner (pre-code, docs-first), how to run, browser requirements, licensing summary, player-facing attribution strings, non-goals |
| `PROJECT_VISION.md` | Thesis, why browser / why East Africa first / why Swahili-first, the six pillars in full (§2), hardware envelope, non-goals, success definitions per milestone |
| `MASTER_PROMPT.md` | This file — the what-and-why for every future agent; **the repo/on-disk layout** (§42) |
| `ARCHITECTURE.md` | System context diagram, client/server architecture, interest-management design, data plane, cross-origin isolation decision point, observability, security model, failure & degradation, **the versions table** (§23), performance budget table (empty until measured) |
| `COORDINATE_SYSTEM.md` | **Highest correctness risk — agents copy patterns from it.** Frame chain with per-frame origin/axes/units/owner, units + TT/UTC policy, WGS84/ECEF/ENU geodesy, the precision law (§13), log-depth + floating origin, physics-world layout (§14), rails/SOI handoff, accuracy expectations, golden tests, naming conventions |
| `NETWORKING.md` | Transport reality (no UDP), topology, message-budget hard rules (§29), authoritative model + full Nakama callback list, the server-validation contract (S0.6), prediction/interpolation, shared-world time semantics, voice spec, session lifecycle/security, netcode observability |
| `DATA_SOURCES.md` | The provenance table (dataset | pinned version | URL | license | attribution string | derived artifacts | build step | refresh cadence); Earth/planetary/ephemeris/toponym/sky data; **the reproducibility rule: every `data/` artifact regenerable by pinned script + pinned source timestamp** |
| `ASSET_STRATEGY.md` | Wire format (§21), texture split, toolchain, serving & caching (§22), verified sources and traps (§33–34), the Swahili-coast kit spec (§35), terrain meshing, audio + voice-recording releases, fonts, ledger gate |
| `ROADMAP.md` | Phase table (§51), **§Budgets — the single home for every number** (§47), phase gates, risk register (§53), change control |
| `CLAUDE.md` | The ≤150-line always-loaded operational contract: invariants, pointers, commands, verification discipline (§45) |
| `LICENSES.md` | Code/data/asset licensing model (§43), incompatibility register, verification procedure, governance |
| `ATTRIBUTIONS.md` | Verbatim attribution strings EN+sw (§44), forbidden uses, CI rule |
| `THIRD_PARTY_ASSETS.md` | The asset ledger — one row per asset/dependency/dataset/generated item (§33) |
| `docs/swahili-i18n.md` | Full i18n spec: principles, PO pipeline, plural rules, locale data, safe-reuse stack, toponym table, glossary, QA (Part F) |
| `docs/adr/` | Architecture Decision Records — all Phase-0 spike outputs land here (§51, §53) |
| `data/README.md` | The ODbL layer rule (§42) |

---

# PART H — DELIVERY

## 51. Roadmap Summary

The first milestone is **not** the entire Solar System. The phases below are the delivery spine; full phase gates, deliverables, and
budgets live in `ROADMAP.md` (§50). Every exit criterion is **browser-testable by one human** and none depends on an unmeasured number
(§47).

- **Phase 0 — Spikes.** Twelve named spikes (S0.1–S0.12), each producing one ADR; spikes S0.1–S0.3, S0.6, S0.8, S0.9, and S0.11
  additionally fill their §Budgets rows, while S0.4/S0.5/S0.7/S0.10/S0.12 produce decisions and records, not measurements (ROADMAP.md §5).
  The full risk → spike mapping is ROADMAP.md §6; §53 lists the twelve that map one-to-one onto Phase-0 spikes. No feature code.
- **Phase 1 — Engine core.** Precision + rendering in an empty world: the camera flies 1 m → 1e10 m without jitter or z-fighting.
- **Phase 2 — Earth data.** Dar es Salaam streams: PMTiles basemap + terrain + buildings over range requests.
- **Phase 3 — Walk.** A character on real ground; position persists across reload.
- **Phase 4 — Car.** Vehicles + world interaction; rejoin finds the car where it was left.
- **Phase 5 — Multiplayer.** Two browsers see each other interpolated; unvalidated positions are rejected with measured drift; reconnect
  recovers.
- **Phase 6 — Voice.** Proximity voice behind CGNAT: positional hearing, TURN-forced connection succeeds, server mute is not bypassable.
- **Phase 7 — Rocket.** Launch from the Dar-coast pad; Rapier→Kepler handoff without visible discontinuity; ephemeris matches the oracle
  fixtures.
- **Phase 8 — Orbit & Moon.** Lunar orbit → descent → walk at real scale; Earth-in-sky correct.
- **Vertical slice.** A fresh browser does pad → walk → drive → launch → orbit → lunar landing alongside another player, with voice, in
  English *and* Swahili, on a measured connection profile. **This is the first major target** — the founder's Earth → car → rocket →
  orbit → Moon chain, intact.
- **Alpha.** A world people can live in: crash-recovery (`kill -9` + snapshot), backup restore drill on video, a measured
  concurrent-player figure, compliance + attribution screens pass.
- **Solar System.** Earth → Mars travel; MOLA-sampled landing at real scale; satellites match fixtures. Only now does Mars become the
  next major destination.
- **Interstellar.** Beyond: round trips preserve persistence and clock consistency; any n-body mode proves deterministic cross-platform
  before touching the authoritative server.

## 52. Definition of Done per Phase

- **Each phase ends with an actual playable build in a browser** — screenshot inspection and a performance test included. Not a demo,
  not a branch, a build.
- A phase is done when its gate has, all four: **goal met; deliverables merged; exit criterion demonstrated by one human in a browser;
  the spikes it consumes are merged as ADRs and the decisions it was supposed to produce are recorded.**
- **Exit criteria never depend on `[PLACEHOLDER]` budgets** (§47) — they test that measurements exist and that the browser experience
  holds. Persistence is tested the harsh way: disconnect, kill the server, restore, rejoin — the world remembers (§24).
- Every phase updates `ROADMAP.md §Budgets` with its `[MEASURED]` rows, lands its ADRs in `docs/adr/`, and updates the owning doc (§50)
  — a phase that changed architecture without updating docs is not done.

## 53. Risk Register

The problems that determine whether the entire project works — solved in Phase 0, not discovered in Phase 7. These twelve map
one-to-one onto Phase-0 spikes; the full risk → spike mapping is ROADMAP.md §6:

| Risk | Why it can kill the project | Spike |
|---|---|---|
| Coordinate precision / floating origin | Jitter at scale is unfixable retroactively | S0.1 |
| Planet LOD & rendering scheme | Wrong choice rewrites the renderer | S0.2 |
| Initial-load budget on East African links | The game must load over the assumed 5–10 Mbps envelope `[PLACEHOLDER — gate: S0.9 — assumption, not data; measured under ROADMAP B-RTT-09]` | S0.3 |
| License ledger completeness | One NC/ODbL mistake contaminates the repo | S0.4 |
| "Kwetu" trademark | Late naming collision is expensive | S0.5 |
| Server-validation contract | Cheat surface + no Go physics | S0.6 |
| Time-warp / universe clock / SOI handoff | Shared-time semantics underpin the world schema | S0.7 |
| AoI cell sizing | Interest management is hand-built (§29) | S0.8 |
| Hosting region / RTT / TURN placement | Voice and latency live or die here | S0.9 |
| UI stack + i18n pipeline + font | UI decisions leak into every screen | S0.10 |
| CI/testing harness (headless WebGL2, determinism) | Without it, precision regressions are silent | S0.11 |
| Privacy/compliance (PDPA/DPA/GDPR) | Pre-Alpha blocker for a social world | S0.12 |

Browser-native risks (permanent vigilance, not spikes): no UDP — WebSocket head-of-line blocking on lossy links, with WebRTC
datachannels only as a later *measured* decision (§29); storage eviction (§22); Caddy reload closing WebSockets (§19); CGNAT forcing
TURN for most East African voice sessions (§18); integrated-GPU memory discipline (§4).

## 54. Prompt Usage Protocol

- **When you are uncertain, write an ADR** — don't guess, and don't quietly decide a locked question. Changing a `DECIDED:` item
  requires an ADR plus the founder's sign-off; there is no silent substitution.
- **Keeping this file honest:** when an owning document changes (new budget, new pin, new ADR outcome), update this file's summary in
  the same change. This file is a *reconstruction*, not a rival authority — its facts are pointers with context.
- **Act like the technical lead the founder asked for:** do not dump enormous amounts of code before validating architecture, and do not
  create placeholder architecture that will obviously collapse once multiple planets are introduced (§45, §10, §15).
- **The north star** (from the founder, verbatim in spirit): *I open the game. My account loads. I see that three of my friends are
  online — one is driving around Earth, one is exploring Mars, another is aboard a spacecraft near Jupiter. I spawn where I last logged
  out. I enter my vehicle, travel to a spaceport, board my spacecraft, and launch from Earth. The atmosphere fades beneath me; cities
  become lights; Earth becomes a sphere; the Moon moves through the sky according to its orbit. I plot a trajectory, travel, and land
  somewhere geographically meaningful — a place another player can physically reach too. We explore together. And this same architecture
  can eventually take us beyond the Solar System.*
- **That is the universe we are building. Build it one technically sound layer at a time.** The key is the Earth → car → rocket → orbit
  → Moon vertical slice (§51): if that pipeline works, almost everything else becomes expansion rather than architectural surgery.
- Evaluate every decision against: *"Will this still work when the player can travel from Earth to Mars, then eventually to another star
  system?"*

---

*Reconstructed from the founder's original 51-section development prompt (Godot-era, adapted to the web-native TypeScript stack) and the
September 2026 license-verified research pass. This file is a living summary — the Documentation Map (§50) is authoritative on
ownership.*

