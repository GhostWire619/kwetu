# Kwetu — Project Vision

> **Status: pre-code, docs-first.** No engine exists yet; Phase 0 spikes have not run. This document
> states intent and taste, not capability. Nothing here is a promise until the matching exit criterion
> in [ROADMAP.md](ROADMAP.md) passes in a browser, on the target hardware, for a real person.
>
> **About the numbers here:** this project tags every quantitative claim. `[EXTERNAL]` marks a fact
> about third-party data or the world, verified from primary sources in Sept 2026. All *performance*
> figures live in [ROADMAP.md](ROADMAP.md) §Budgets as `[PLACEHOLDER — gate]` until measured; this
> document deliberately quotes almost none.

## Thesis

**Kwetu** — Swahili for "our place" — is an open-source, persistent, multiplayer digital universe that
runs in a browser tab. It is built at real scale on real data: the actual Solar System, with a Moon
that is actually 3,474 km across [EXTERNAL] and actually in orbit, and an Earth whose flagship region
is not Silicon Valley or Western Europe but the Swahili coast — Dar es Salaam, Zanzibar's Stone Town,
a slice of coastal Kenya — with Swahili as a first-class language of the interface itself.

The founder's one-sentence framing, kept intact from the original draft: *a digital universe people
can come to and live in — explore, talk, make friends, have fun.* Kwetu resembles several genres at
once — space simulator, open-world multiplayer world, vehicle game, social space, astronomical
visualization — and is none of them alone. The product is the place; everything else serves the place
feeling real, shared, and worth returning to.

Free and open source: Apache-2.0 code, a separately-licensed ODbL `data/` layer for OpenStreetMap-derived
databases, CC0 for our own authored kit — see [LICENSES.md](LICENSES.md). Openness is part of the
vision, not paperwork attached to it.

## The long arc

The Solar System is the beginning, not the boundary. The architecture is judged by one question
inherited from the original draft: *will this design still work on the day a player can fly from
Earth to Mars — and eventually onward to another star?* Any early decision that answers "no" gets
redesigned, however convenient it looked. So the data model is a hierarchy (galaxy → star system →
body → region → local scene) that never assumes Sol is the only entry, and the far future is planned
as *content and data*, never architectural surgery:

- Other stars — real nearby systems (Alpha Centauri, Proxima Centauri, TRAPPIST-1), procedurally
  generated systems, and openly fictional destinations.
- The galactic middle-distance: nebulae, star fields, other galaxies as reachable horizons rather
  than painted backdrops.
- Black holes with visual and gameplay approximations (event horizon, accretion disk, lensing) —
  never a claim of full general relativity.
- Wormholes as navigation links between distant coordinates, not a rework of the coordinate system.
- Stations, settlements, player-built places, and ordinary life on planet surfaces.

That last line matters as much as the rockets: the universe must not force every player to be an
astronaut. A player who spends an entire session driving Dar es Salaam's streets, meeting friends on
a Stone Town seafront baraza, or attending an event is playing Kwetu correctly. A world people *live*
in needs errands and hangouts, not only trajectories.

The social layer is load-bearing, not garnish: persistent accounts and avatars; friends; presence
that says a friend is "driving around Earth" or "in transit, Earth → Moon" at a precision the
player's own privacy setting allows; text chat; proximity voice that fades with distance; travel
together, shared vehicles, groups. Table stakes for any modern platform — except here it is welded
to a shared physical world instead of a lobby.

And the universe keeps a memory: first visits to landmarks — Kilimanjaro, Serengeti, Olympus Mons,
Tycho — are recorded and credited to whoever got there first.

## Why the browser

Kwetu was originally drafted around a desktop engine (Godot 4) and pivoted to the web mid-planning,
deliberately. The reason is the first ten seconds of the player experience: **a URL is the entire
install**. No launcher, no store approval, no multi-gigabyte download, no GPU-driver lottery. Where
installs compete directly with data bundles and disk space, "click the link and you are there" is the
difference between a world people try and a world people only hear about — and the browser is where
the social layer already lives.

The honest costs, stated plainly because they shape the architecture:

- **No UDP.** Browsers do not expose raw UDP; real-time state rides WebSockets over TCP, with
  head-of-line blocking on lossy links, and WebRTC datachannels as a later, measured option. Kwetu
  therefore never promises twitch-grade netcode: the server validates player motion with kinematic
  replay rather than full physics simulation, and the game's fun is designed to survive high latency.
- **TLS is mandatory, not nice-to-have.** Microphone access — the basis of proximity voice — exists
  only in a secure context. HTTPS/WSS with real certificates is a day-one infrastructure
  requirement, including in development.
- **The first load is the front door.** Engine code, one locale, and the first region must arrive
  inside a budget that works on the target connection. Until measured, that budget is a placeholder
  owned by [ROADMAP.md](ROADMAP.md) §Budgets (spike S0.3); no marketing number may exist before the
  measurement does. Heavy assets stream lazily; locales load one at a time; textures ship GPU-native.
- **Browser storage can be evicted.** Cached world data is a convenience, never a source of truth;
  the client asks for persistent storage and degrades gracefully when the browser says no.
- **No 64-bit floats on the GPU.** Astronomical-scale precision is solved in software — double
  precision in JS, floating origins, log depth — a cost paid once, in
  [COORDINATE_SYSTEM.md](COORDINATE_SYSTEM.md), so the world never gets shrunk to fit a float.

The bet: these costs are known, bounded, and engineerable — and cheaper than native distribution.

## Why Tanzania, Zanzibar, and Kenya come first

Identity first, pragmatics second — and in Kwetu's case they point the same way. The founder's
requirement is cultural, not decorative: East Africa must not be generic tropical maps
with flags pasted on top. The flagship regions should feel authored — Swahili coastal architecture,
Stone Town's alleys and carved doors, daladala and bajaji in traffic, markets, ports, minarets,
baobabs, the Indian Ocean — so a player from Dar es Salaam recognizes their own city, and a player
from anywhere else understands they are somewhere real. Kwetu's differentiation from every other
space game is exactly this grounding; a demo that looks like everywhere looks like nowhere.

The data position makes this the *smart* choice, not just the sentimental one:

- OpenStreetMap building completeness is ≈94% in Dar es Salaam and ≈86% in Zanzibar [EXTERNAL] —
  city-scale building footprints good enough to stream real neighborhoods instead of procedural
  filler, among the strongest coverage on the continent.
- 32,138 objects in Tanzania already carry explicit Swahili names (`name:sw`) — the map
  itself speaks the flagship language (corpus count owned and tagged by
  [docs/swahili-i18n.md](docs/swahili-i18n.md) §7).
- Geofabrik republishes the Tanzania extract daily, with change files between versions [EXTERNAL],
  so flagship regions can be re-baked on a cadence: the world tracks reality instead of forking
  from it.

The flagship set for Earth: Dar es Salaam first (ocean, port, streets, airport, vehicle-scale
gameplay), Zanzibar and Stone Town as the walkable historic core, selected Kenya (Nairobi, Mombasa,
the Swahili coast) next, with Kilimanjaro and Serengeti/Ngorongoro as landmark destinations. Detail
widens in tiers — Tanzania and Zanzibar, then East Africa, then Africa, then the world. Concentrating
detail is also engineering: one real region first forces the streaming pipeline to exist early, and
a city the size of Dar es Salaam cannot be faked.

## Swahili as a first-class language

**Parity is the design constraint.** When a screen ships, it ships in English and Swahili in the same
change; a feature that lands English-only is incomplete, not "ready for translation later". That
later is exactly how Swahili becomes a settings checkbox, and Kwetu refuses that outcome.

Three commitments follow:

- **Layout for the longer language.** Swahili text runs roughly 10–20% longer than English — an
  assumption pending the measured length-diff report, owned by
  [docs/swahili-i18n.md](docs/swahili-i18n.md) §1/§9. The UI is sized for Swahili from the first
  screen, and a pseudo-localization build inflates strings during development so overflow is caught
  by the team before a player catches it.
- **Place names are culture, not strings.** Toponyms live in a frozen, human-reviewed table behind a
  review gate; imported labels are never trusted blind. Worked example: the Wikidata Swahili *label*
  for Stone Town is the administrative district's name, while the form residents use survives only in
  aliases — precisely the failure a human gate exists to catch. OSM's `name:sw` layer is a
  cross-check, never a source of truth.
- **Real machinery, not a translation pass.** gettext PO files as the single source of truth, i18next
  at runtime, CLDR Swahili locale data (Januari through Desemba, proper plurals), and a lint that
  rejects the corrupted plural headers known to circulate in the wild. Full pipeline in
  [docs/swahili-i18n.md](docs/swahili-i18n.md).

The end state: a Swahili-first player experiences Kwetu as if built for them — because it was.

## The six design pillars

These are non-negotiable: the tests any feature, doc, or pull request is measured against.

1. **Real scale.** Planets keep their true dimensions. We do not shrink the Moon because float math
   finds it awkward; we build the precision architecture instead — double precision in JS, floating
   origins, log depth, a frame chain descending from Solar System barycenter to the metre under the
   player's feet. Simulation scale and play scale are separated honestly: autopilots and transfer planning reduce workload while offline coast preserves elapsed travel. Isolated training may accelerate time; later fictional rapid transit changes travel capability, never geometry. Gravity differs per
   body, orbits obey ephemerides, and standing on lunar soil feels different because it is different.

2. **Persistence.** The universe remembers. Ground locations persist, while travelling craft continue along their saved journeys; the car
   you left at the ferry terminal is still there; friendships, discoveries, and ownership survive
   closed tabs, crashed servers, and weeks away. Realtime simulation state lives in memory; the
   things that constitute a life in the world are snapshotted and owned by the authoritative backend.
   A place people live in must be a place that does not reset when they leave.

3. **One shared universe clock.** Everyone inhabits the same simulation time. The Moon is where its
   orbit says it is — for all — and "my friend is in transit, Earth → Moon" is true of a shared
   world, not a private cutscene. Public time runs at real time. Accelerated training is isolated; it cannot change shared state. Physical coasting and optional later fictional transit follow the same shared clock.
   The sky is an honest clock: ephemeris-driven, checked against a Python oracle's golden fixtures.

4. **Walk → car → rocket → orbit → Moon as one seamless camera.** The continuity principle, taken
   straight from the original draft: a player walks Earth's surface, gets into a car, drives to a
   launch facility, boards a rocket, launches, passes through the atmosphere, reaches orbit, crosses
   to the Moon, descends, lands, exits, and walks in lunar gravity — with no level select, no scene
   swap, no rocket that plays a cutscene on their behalf. Streaming happens behind the curtain; the
   felt experience is one continuous place. This is the single hardest thing Kwetu does, and the
   reason is leverage: **if this chain works, everything else — Mars, other stars, fictional
   destinations — becomes expansion rather than architectural surgery.**

5. **Low-bandwidth-respectful by default.** Built for the connection most of the audience actually
   has, not the one we wish they had: metered, mid-tier, high-latency, often behind CGNAT. Interest
   management means a client receives only its surroundings; state messages are small and few; assets
   compress into modern GPU formats and cache in the browser; the initial load is budgeted and
   measured before it is advertised. The game degrades down a ladder — lower LODs, fewer dynamic
   players, voice that still works where twitchy state sync cannot — and never punishes a player for
   their network. Every budget lives in [ROADMAP.md](ROADMAP.md) §Budgets.

6. **Culturally authored, not extracted.** The flagship regions are built with intent, not skinned: a
   custom CC0 Swahili-coast modular kit — coral-stone walls, carved Zanzibar doors, mangrove-pole
   construction, baraza benches, dhows and mashua, daladala and bajaji — assembled on real
   OpenStreetMap footprints, with attribution flowing back to the mappers whose data makes it
   possible. Swahili naming is human-reviewed; regional architecture, vegetation, transport, and
   light are studied, not guessed. If a player from Dar or Zanzibar feels their home was rendered by
   someone who has never been, this pillar has failed regardless of frame rate.

## What we will NOT do

- **No fake scale.** No miniature planets, no "orbit" that is a teleport with a loading screen, no
  rocket that is a cutscene. If a thing is claimed to be real-scale, it is.
- **No noncommercial or no-derivatives content.** Nothing licensed NC or ND enters the repo, the
  game, or the data layer — no matter how good it looks. Verified license or it does not ship.
- **No ToS-gated services on the critical path.** Core features (maps, buildings, voice, identity)
  run on self-hostable, open infrastructure. If a vendor can revoke it, it is a demo, not a world.
- **No unledgered assets.** Nothing enters the repo or `data/` without a license row, provenance, and
  a regeneration path; OpenStreetMap derivatives live in the separately-licensed ODbL `data/` layer,
  never folded into permissive code.
- **No economy-first design.** Currency, trading, and property stay deliberately thin and strictly
  server-authoritative; early Kwetu sells nothing and mints nothing.
- **No ads, no NFTs, no blockchain, no dark patterns.** [README.md](README.md) repeats the short
  public version of these non-goals.
- **No promises without measurements.** An unmeasured number is a visibly tagged placeholder. Always.

## Audience and hardware envelope

The player Kwetu is built for owns a **roughly 2019-era laptop with integrated graphics and
8 GB RAM** [assumption — envelope figure, not data], connects over a **5–10 Mbps metered link**
[PLACEHOLDER — gate: S0.9 — assumption, not data; measured under ROADMAP B-RTT-09], experiences
**high round-trip latency** to distant servers, sits behind CGNAT as often as not, and keeps an
up-to-date desktop Chrome, Edge, or Firefox. That person is not hypothetical: they are the flagship
region's actual population, plus the founder's diaspora friends abroad.

Target platforms: desktop browsers first — Chrome, Edge, Firefox; WebGL2 as the mandatory floor,
WebGPU as an optional accelerator. **Mobile-tolerant, not mobile-target**: nothing in the
architecture may require capabilities a modest phone lacks, but no phase gate is defined by a phone.
iOS is out of scope for now (Safari's storage-eviction semantics among them); Android is re-tested
at the Alpha gate.

**Explicitly not the target: the founder's development laptop with an RTX 4050.** It is a pleasant
place to write code, and it proves nothing. Every performance claim is gated on the defined
integrated-GPU baseline in [ROADMAP.md](ROADMAP.md); something that runs only on the dev box does
not run.

## What success looks like

Success is defined in the player's experience, per milestone. The normative, testable exit criteria
live in [ROADMAP.md](ROADMAP.md); these are the human versions.

**Vertical Slice — the promise, integrated.** A first-time player opens a fresh browser tab, creates
an account, and stands on real ground in a Tanzanian flagship region. They walk real streets, meet
another actual player, chat, get into a car, drive to a launch facility, board a rocket, launch,
watch the atmosphere thin and their city become lights and then a sphere, reach orbit, fly to the
Moon, land, step out, and walk in one-sixth gravity — talking to that other player the whole way.
Then they close the tab and, back tomorrow, resume where they left off. All of it in English *and*
Swahili, on a measured connection profile, on the integrated-GPU envelope. No single moment of that
chain is a teleport.

**Alpha — a world people can live in.** The server is killed mid-session and a player's world
survives it. Backups restore, on camera. Presence, friends, chat, and proximity voice work for
players behind CGNAT. A measured number of concurrent players is recorded — a measurement, not a
marketing figure. Compliance and attribution screens pass in both languages, because a world built
on other people's data says so in its players' languages.

**Solar System — the neighborhood.** A player flies Earth to Mars, descends through a thin atmosphere
onto terrain sampled from real orbital data at real scale, and the trip is made with the same
architecture that carried them to the Moon — no rewrite, no fudge; Mars added as content and data,
not surgery. The sky over Mars shows the wandering planets where the ephemerides say they are.
Beyond that lies the interstellar horizon, and the same test question waiting for it.

## Where this document ends

This is the vision; it intentionally contains almost no engineering. The operational contract for
agents is [CLAUDE.md](CLAUDE.md); the full build instruction is [MASTER_PROMPT.md](MASTER_PROMPT.md);
architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md) and [COORDINATE_SYSTEM.md](COORDINATE_SYSTEM.md);
network truth in [NETWORKING.md](NETWORKING.md); every number is owned by [ROADMAP.md](ROADMAP.md)
§Budgets. When documents disagree, the others win on facts and this one wins on purpose — and if
purpose and fact genuinely conflict, we surface it in an ADR rather than quietly choosing.
