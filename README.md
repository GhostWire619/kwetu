# Kwetu

**Kwetu** — Swahili for *our place* — is an open-source, persistent, multiplayer digital universe
that runs in a browser tab: the real Solar System at real scale, seamless travel from walking a
street to driving a car to launching a rocket to orbiting and landing on the Moon — no level
select, no cutscene, one continuous camera — with flagship Earth regions on the Swahili coast
(Dar es Salaam, Zanzibar's Stone Town, coastal Kenya) and Swahili as a first-class language of the
interface itself, not a settings checkbox. Accounts, friends, chat, and proximity voice are welded
to that shared physical world. The intent, and the vision: [PROJECT_VISION.md](PROJECT_VISION.md).

## Status: early implementation

The repository now contains an engine foundation, browser rendering shell, real Stone Town
terrain loading, a playable walking/driving surface prototype, orbital calculations and
multiplayer/voice groundwork. These systems are at different integration stages; the full
shared universe is not yet connected. See [local testing](docs/LOCAL_TESTING.md) for controls,
verified browser results, the playable surface entry point and diagnostic views.
Phase completion still requires the browser and target-hardware evidence in [ROADMAP.md](ROADMAP.md).

## Documentation map

| Read… | When you want… |
|---|---|
| [PROJECT_VISION.md](PROJECT_VISION.md) | What Kwetu is and why — the thesis, the six design pillars, what we will not do, the hardware envelope |
| [MASTER_PROMPT.md](MASTER_PROMPT.md) | The full build instruction — the self-contained, section-numbered brief an implementer (human or AI) can work from alone |
| [ROADMAP.md](ROADMAP.md) | The phases, the Phase-0 spikes, and §Budgets — the single home for every number in the project |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System topology: browser ⇄ Caddy ⇄ Nakama ⇄ Postgres, LiveKit, and the version pins |
| [COORDINATE_SYSTEM.md](COORDINATE_SYSTEM.md) | How real-scale precision works: frames, f64-in-JS, floating origin, log depth, ephemerides |
| [NETWORKING.md](NETWORKING.md) | The netcode and voice contract: transport reality, message budgets, authoritative model, LiveKit voice |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Every dataset: provenance rows, pins, licenses, and the regeneration path for everything in `data/` |
| [ASSET_STRATEGY.md](ASSET_STRATEGY.md) | The art pipeline: wire formats, textures, toolchain, the Swahili-coast kit, verified sources |
| [LICENSES.md](LICENSES.md) | Licensing policy and the incompatibility register (what may never enter the repo) |
| [ATTRIBUTIONS.md](ATTRIBUTIONS.md) | The exact, CI-checked attribution strings, EN and Swahili |
| [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md) | The dependency ledger — the gate: no ledger row, no commit |
| [docs/swahili-i18n.md](docs/swahili-i18n.md) | The localization machinery: gettext PO as source of truth, i18next at runtime, Swahili-first rules |
| [CLAUDE.md](CLAUDE.md) | The operational contract for AI agents working in this repo |
| [docs/adr/README.md](docs/adr/README.md) | Architecture decision records — the Phase-0 spike outputs land here |
| [data/README.md](data/README.md) | The rules of the separately-licensed ODbL `data/` layer |

## Flight and fleet specification

[Vehicles and flight](docs/VEHICLES_AND_FLIGHT.md) defines the component-based fleet, powered flight, orbital coast, boarding, docking, assisted landing, persistence and acceptance tests. [ADR-001](docs/adr/ADR-001-flight-frames-and-clock.md) records the researched corrections to coordinates, local physics, shared time and Three.js typing. These are accepted design choices; browser measurements remain outstanding.

## Running it

With the locked dependencies installed (`npm ci`), run
`npm run dev -- --host 127.0.0.1 --port 5199` from the repository root. Open the Vite URL
with `?mode=surface` for the local surface test or `?mode=space` for the space-camera diagnostic.
Terrain data prerequisites and the existing root-serving test URL are in [local testing](docs/LOCAL_TESTING.md).
The local surface prototype needs no account or backend. The separate Nakama/Postgres/LiveKit
development stack is documented in [infra/README-dev.md](infra/README-dev.md).

## Browsers

Desktop **Chrome, Edge, and Firefox** first; **WebGL2 is the mandatory floor**, WebGPU an
optional accelerator. Mobile is tolerated, not targeted — nothing in the architecture may
require capabilities a modest phone lacks, but no phase gate is defined by a phone — and iOS
is out of scope for now. The intended audience envelope (a modest integrated-Graphics laptop
on a metered, high-latency connection) is owned by [PROJECT_VISION.md](PROJECT_VISION.md);
every performance budget is owned by [ROADMAP.md](ROADMAP.md) §Budgets.

## Licensing

- **Code: Apache-2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
- **The `data/` layer: ODbL 1.0** — OpenStreetMap-derived databases are derivative databases;
  they live in a separately licensed layer, never folded into permissive code
  ([LICENSES.md](LICENSES.md), [data/README.md](data/README.md)).
- **Our own authored kit (art, sounds): CC0.** Every third-party asset, dataset, and
  dependency carries a ledger row in [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md) —
  a row without an attribution string fails the build.

## Data and assets

Kwetu is built on other people's open data, and says so in its players' languages. The
canonical strings live in [ATTRIBUTIONS.md](ATTRIBUTIONS.md); the core ones, verbatim:

- `© OpenStreetMap contributors, under the Open Database License (ODbL) 1.0`
- `Contains modified Copernicus data [year]`
- `Terrain and imagery data courtesy of NASA and the U.S. Geological Survey.` —
  `Kwetu is not affiliated with, endorsed by, or sponsored by NASA or the U.S. Geological Survey.`

The in-game credits screen ships in English and Swahili (legal strings stay verbatim English
in every language — only the screen labels are translated). The NASA insignia and logotypes are
protected by US law and are never rendered anywhere in Kwetu.

## Non-goals

The short public version (the full list with reasons is in
[PROJECT_VISION.md](PROJECT_VISION.md)): **no fake scale** — if something is claimed to be
real-scale, it is; **no mobile-native apps** — the browser is the platform; **no VR**; **no
installable launcher or offline installer** — a URL is the entire install; **no ads, no NFTs,
no blockchain**; **no noncommercial or no-derivatives content anywhere in the repo**; **no
promises without measurements** — an unmeasured number is a visibly tagged placeholder, always.
