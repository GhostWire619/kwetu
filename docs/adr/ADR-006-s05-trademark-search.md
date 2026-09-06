# ADR-006: S0.5 — "Kwetu" trademark search (best-effort record, not legal clearance)

- **Status**: proposed (exit criterion partially met — the recording exists, but Tanzania/Kenya class 9/41 register results, the WIPO Global Brand Database and the primary USPTO registry could not be searched tonight; see Open items)
- **Date**: 2026-09-06
- **Deciders**: Claude Code S0.5 spike session (agent-run best-effort search under ROADMAP §5 S0.5); the gate in Decision 2 is explicitly reserved for a human
- **Fills Budgets rows**: none (decision record, not a measurement — ROADMAP §5 S0.5; `budgetRows` returned empty)

## Context

ROADMAP §5 S0.5 asks whether the name "Kwetu" can ship. "Kwetu" is a common Swahili word ("our place/home") — the project's own naming premise — so the collision surface is wide: the word appears in East African music, media and small business names. The spike must record what was searched, what was found, what could not be verified, and gate public use of the name behind a human trademark-attorney confirmation plus manual national-registry searches. This ADR is a best-effort record made by automated fetching on 2026-09-06; it is **not** legal clearance.

## Evidence

Tag convention: every external fact below was fetched live on 2026-09-06 and carries `[EXTERNAL, verified 2026-09-06 <url>]`. Nothing is from memory.

### Method — what was searched, and how (re-runnable)

| Source | Method used 2026-09-06 | Outcome |
|---|---|---|
| TMview (tmdn.org — the multi-office search operated alongside EUIPO eSearch) | `POST https://www.tmdn.org/tmview/api/search/results` with JSON body `{"criteria":"C","basicSearch":"kwetu","page":1,"pageSize":100}` (browser User-Agent + `Referer: https://www.tmdn.org/tmview/`; a bare POST from curl is reset, and a GET on the same path returns 405 — the POST needs the session cookie from a prior GET of `/tmview/` and browser-like headers) | Works. JSON `totalResults` and full records (name, office, classes, status, holder, dates). Repeated with `"criteria":"E"` (exact) | [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/]
| WIPO Global Brand Database (branddb.wipo.int) | WebFetch of `branddb.wipo.int/en/quicksearch/brand?by=brandName&v=kwetu` and direct probe of `api.branddb.wipo.int` | **Not searchable.** The web app sits behind an ALTCHA captcha gateway (`api.branddb.wipo.int/captcha`); the API host returns HTTP 403 `{"message":"Missing Authentication Token"}` — a keyed WIPO API | [EXTERNAL, verified 2026-09-06 https://branddb.wipo.int/en/quicksearch/brand?by=brandName&v=kwetu]
| EUIPO eSearch plus (euipo.europa.eu/eSearch) | WebFetch of the site root | **JS application shell only** — header/footer chrome, no search results in the HTML. EUIPO-level coverage taken from TMview instead (TMview mirrors EUIPO data) | [EXTERNAL, verified 2026-09-06 https://euipo.europa.eu/eSearch/]
| USPTO (tmsearch-new.uspto.gov / tmsearch.uspto.gov) | DNS-over-HTTPS lookup + curl of both hosts + the Justia mirror | **Primary registry not searchable.** `tmsearch-new.uspto.gov` has no A and no AAAA record (Cloudflare DoH `Status:0` with SOA-only authority — NODATA, hence "could not resolve" everywhere); `tmsearch.uspto.gov` serves HTTP 200 behind an AWS WAF challenge (`a434627cf98f.edge.sdk.awswaf.com/.../challenge.js`) and its legacy `api-v1-0-0/tmsearch` path returns 405 `MethodNotAllowed` (S3 error XML); Justia (`trademarks.justia.com/search?q=kwetu`) returns 403. USPTO evidence below is limited to what TMview's US-office feed returns | [EXTERNAL, verified 2026-09-06 https://tmsearch.uspto.gov/]
| Tanzania BRELA (ort.brela.go.tz / brela.go.tz) | curl + WebFetch + DoH | `ort.brela.go.tz` is **NXDOMAIN** (DoH `Status:3`; the parent zone `brela.go.tz` answers with SOA `ns.eganet.go.tz`, serial 2018020150 — the ORS hostname does not exist in DNS). `www.brela.go.tz` and `/services/trade-and-service-marks` are live and describe trade-and-service-mark registration ("Usajili wa Alama za Biashara na Huduma") with an "ORS" online-registration system referenced for filing — **no public online trademark register/search was found on the site** | [EXTERNAL, verified 2026-09-06 https://www.brela.go.tz/services/trade-and-service-marks]
| Kenya KiPI (kipi.go.ke) | curl + WebFetch | Site live; `/trade-marks` page live (describes registration under the Trade Marks Act (Cap 506)); online e-filing/search banner covers **patents, utility models and industrial designs only**; the "Patent Search" link points to `ipsearch.kipi.go.ke`, which has **no A/AAAA record** (DoH NODATA). **No online trademark register/search was found** | [EXTERNAL, verified 2026-09-06 https://www.kipi.go.ke/trade-marks]
| General web search | WebSearch tool (budget exhausted at 200/200 calls this session) and DuckDuckGo lite | **Not available.** DDG returned a bot-verification challenge. The known-use sweep below therefore covers only structured API sources | [EXTERNAL, verified 2026-09-06 https://lite.duckduckgo.com/lite/?q=%22Kwetu%22]

### Registry findings — every mark matching "kwetu" in TMview-participating offices

Contains-match (`criteria:"C"`) `totalResults` = **10**; exact-match (`criteria:"E"`) = **4**. Complete set [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/api/search/results (POST, criteria C/E, basicSearch kwetu)]:

| Mark | Office | Application | Nice classes | Status | Filed | Expires | Holder |
|---|---|---|---|---|---|---|---|
| KWETU | CN | 44188847 | 43 | Registered | 2020-02-24 | 2030-10-13 | 武汉福满翼科技咨询有限公司 |
| KWETU | FR | 5150248 | 25, 43 | Registered | 2025-05-23 | — | Imani SARL |
| Kwetu ASILI | UG | UG/T/2023/080486 | 30 | Registered | 2023-08-25 | 2030-08-25 | Sokowatch Inc. |
| Kwetu ASILI | UG | UG/T/2023/080484 | 16 | Registered | 2023-08-25 | 2030-08-25 | Sokowatch Inc. |
| Kwetu Asili | ZM | ZM/T/2023/001429 | 16 | Registered | 2023-08-29 | 2030-08-29 | Sokowatch Inc |
| Kwetu Asili | ZM | ZM/T/2023/001506 | 30 | Registered | 2023-09-07 | 2030-09-07 | Sokowatch Inc |
| KIKWETU COFFEE COMPANY | US | 98290765 | 43 | Registered | 2023-11-29 | — | Kikwetu Coffee Company, LLC |
| KIKWETU COFFEE COMPANY | US | 98290795 | 30 | Registered | 2023-11-29 | — | Kikwetu Coffee Company, LLC |
| CHARTREUSE DE LA SOLLE DU BOST KWETU | FR | 4833255 | 43 | Registered | 2022-01-12 | — | Madame Grace Benjamin MOSHI |
| 麦唯图 MYKWETU | CN | 8789136 | 25 | Expired (2022-03-20) | 2010-10-28 | 2022-03-20 | 上海奈布电子商务有限公司 |

Observations, limited to what was actually searched:

1. **No EUIPO (EM) record** appears in either the contains or exact result sets → no EUIPO registration or application containing "kwetu" was found in TMview's EUIPO feed. [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/]
2. **No record in the set claims Nice class 9, 41 or 42.** Classes present: 16, 25, 30, 43. A browser-game ("downloadable/game software" = class 9; "online entertainment services" = class 41; "hosting/platform SaaS" = class 42) does not collide with any registered mark found in TMview-participating offices tonight. [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/]
3. **Tanzania (BRELA) and Kenya (KiPI) are NOT verifiably covered.** The result offices observed are CN, FR, UG, ZM, US. Uganda and Zambia do participate, so TMview includes some African registries — but whether BRELA or KiPI participate could not be verified tonight (TMview's coverage page/API is a JS shell: `https://www.tmdn.org/tmview/api/coverage` returns an empty app shell). **Absence in TMview must not be read as absence in TZ/KE.** [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/api/coverage]
4. USPTO coverage here is TMview's US-office mirror (2 live "Kikwetu" marks, classes 30/43) — not a search of the primary USPTO register, which was unreachable (see Method). An exact "Kwetu" word mark was not found in that mirror's feed, but this is weak negative evidence. [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/]
5. The closest live exact "KWETU" marks are CN class 43 (restaurant/hospitality services) and FR classes 25/43 (clothing + restaurants) — adjacent to none of 9/41/42, but an attorney must judge likelihood-of-confusion across territories. [EXTERNAL, verified 2026-09-06 https://www.tmdn.org/tmview/]

### Known uses of "Kwetu" in software/products (the risk table)

| # | Use | What it is | Where | Relevance |
|---|---|---|---|---|
| 1 | **Kwetu eSIM** — Kwetu Esim Limited | iOS app v1.6, released 2026-09-04, genre Travel; self-described in its store metadata as "a digital telecom brand that sells embedded SIM (eSIM) data plans to travellers, expatriates, and roaming-heavy professionals **across Africa and globally**" (from iTunes Lookup API `itunes.apple.com/lookup?id=6789627153`); also on Google Play as `com.app.kwetuesim` | [EXTERNAL, verified 2026-09-06 https://apps.apple.com/us/app/kwetu-esim/id6789627153] and [EXTERNAL, verified 2026-09-06 https://play.google.com/store/search?q=kwetu&c=apps] | **Sharpest known use**: a live, Africa-first *digital/telecom brand* on the exact name, published the day before this measurement. Class 9-shaped product (software goods). Not a registered mark in any TMview-covered office — its rights, if any, are unregistered/common-law |
| 2 | **Kwetu-Ticket** — developer "Kwetu-tech" / Christian Rusipa | iOS app v3.0.1, released 2026-09-05, genre Productivity; French description: "un système de production et de gestion de billets d'événements" (event ticketing platform); Google Play `com.kwetuticket` | [EXTERNAL, verified 2026-09-06 https://apps.apple.com/us/app/kwetu-ticket/id6670704305] | Event ticketing = software (9) + event/entertainment services (41) territory |
| 3 | **Nyumbani Kwetu** — Glintacon Services | Google Play app `tz.co.glintacon.nyumbanikwetuapp` (Tanzanian developer, name means "home, our place") | [EXTERNAL, verified 2026-09-06 https://play.google.com/store/search?q=kwetu&c=apps] | TZ-market Android app on a longer compound name |
| 4 | "KWETU." podcast | Apple Podcasts show id1528119769, Society & Culture | [EXTERNAL, verified 2026-09-06 https://podcasts.apple.com/us/podcast/kwetu/id1528119769] | Media use of the bare word |
| 5 | GitHub ecosystem | Repository search `api.github.com/search/repositories?q=kwetu` reports `total_count: 234` (name/description/readme matches). Examples: `Nschadrack/Kwetuwebshop` ("Kwetu Trade Ltd is a Rwandan e-commerce company… founded August 2020"), several `KwetuMall` repos, `ALI-HASSAN-HAJI/KwetuHub`, `andreyanga/KwetuCast`, `jacquesmofa/kwetu-connect`, `imbukwa1/KwetuCare-Foundation`, `mugumya2/kwetu` ("kwetu online booking system"), `spgdaman/hosting_platform` ("A hosting platform for Kwetu Designs App"), `mercikigombo/KWETU-TECH`, `latrondav/kwetu-edu-services`. All small/personal projects; none is a major product | [EXTERNAL, verified 2026-09-06 https://api.github.com/search/repositories?q=kwetu] | Widespread informal use, mostly East-African e-commerce/tools; establishes the word's popularity, no single dominant software "Kwetu" |
| 6 | Package registries | npm: `registry.npmjs.org/kwetu` → 404 `{"error":"Not found"}` — **no package named "kwetu"** (text search returns 1 irrelevant fuzzy match). PyPI: `pypi.org/simple/kwetu/` → 404 — **no package named "kwetu"**. crates.io: HTTP 403 (bot-blocked) — unverified | [EXTERNAL, verified 2026-09-06 https://registry.npmjs.org/kwetu], [EXTERNAL, verified 2026-09-06 https://pypi.org/simple/kwetu/] | Clean at the exact-name level on the two registries checked |
| 7 | Music (context) | Apple Music returns ~25 albums/tracks titled "Kwetu" (Kidum, Sizzla, Aaron Rimbui, Kirk Whalum feat. Ghetto Classics, …) across US/KE/TZ storefronts | [EXTERNAL, verified 2026-09-06 https://itunes.apple.com/search?term=kwetu&country=US&limit=25] | Confirms "Kwetu" is a common cultural word — expect crowded-name review comments, not blocking software conflicts |

### Domains (RDAP via rdap.org, checked 2026-09-06)

Method: `curl -sL https://rdap.org/domain/<domain>`; HTTP status + response body recorded. Note rdap.org 404 has two distinct meanings, distinguished by body: a registry RDAP `error` object ("not found in registry") vs `"title":"No RDAP service is available for this resource"` (rdap.org has no service for that TLD — **not** availability evidence).

| Domain | Result | Conclusion |
|---|---|---|
| kwetu.game | HTTP 404, ICANN RDAP `error` object served by the CentralNic registry RDAP (`rdap.centralnic…` referenced in notices) | **Not registered — available.** [EXTERNAL, verified 2026-09-06 https://rdap.org/domain/kwetu.game] |
| kwetu.app | HTTP 404, body `"kwetu.app not found"` (Google Registry RDAP) | **Not registered — available.** [EXTERNAL, verified 2026-09-06 https://rdap.org/domain/kwetu.app] |
| kwetu.dev | HTTP 404, body `"kwetu.dev not found"` (Google Registry RDAP) | **Not registered — available.** [EXTERNAL, verified 2026-09-06 https://rdap.org/domain/kwetu.dev] |
| kwetu.gg | HTTP 404, body `"title":"No RDAP service is available for this resource"` | **Unverified** — .gg has no RDAP service via rdap.org; manual whois/registrar check required before relying on it. [EXTERNAL, verified 2026-09-06 https://rdap.org/domain/kwetu.gg] |
| kwetu.example | HTTP 404, "No RDAP service" | **Not an availability signal** — `.example` is a special-use reserved TLD: RFC 6761 §6.5, "DNS Registries/Registrars MUST NOT grant requests to register example names in the normal way". Never registrable. [EXTERNAL, verified 2026-09-06 https://www.rfc-editor.org/rfc/rfc6761.html] |
| kwetu.com | HTTP **200** — registered: created 2011-11-19, expires 2026-11-19, last changed 2025-11-10, status `client transfer prohibited`, registrar "Megazone Corp., dba HOSTING.KR" (handle 1489), nameservers `SL1.SEDO.COM` / `SL2.SEDO.COM` | **Taken.** The Sedo nameserver pattern is characteristic of domain parking/marketplace listings (an acquisition may be possible, but no offer or price was verified — do not rely on this). [EXTERNAL, verified 2026-09-06 https://rdap.org/domain/kwetu.com] |

## Decision

1. **Dated go/no-go (2026-09-06):** conditional **GO** for non-public, internal development use of "Kwetu" as the project codename (repo, docs, internal builds). **NO-GO** for any public use — public launch, app-store listings, marketing, community spaces under the name, or monetization — until the gate in Decision 2 closes. This enforces ROADMAP's "No public use of the name before this closes."
2. **Gate — all three REQUIRED before the name goes public:**
   a. **Human trademark-attorney confirmation** covering Tanzania, Kenya, the EU, the US and any launch storefronts, expressly assessing the known uses in the risk table (Kwetu eSIM first) and the TMview record set above.
   b. **Manual BRELA (Tanzania) and KiPI (Kenya) searches of classes 9, 41 and 42.** Their registers were not machine-readable from this host tonight (ort.brela.go.tz NXDOMAIN; KiPI's online search covers patents/industrial designs only, and its IP-search host has no DNS address records) — this cannot be closed by an agent.
   c. **A WIPO Global Brand Database search** (Madrid registrations plus national offices TMview does not cover). The branddb web UI is captcha-gated and its API is key-only, so this too requires a human session.
   This spike is a best-effort record, **not** legal clearance.
3. **Fallback-name selection criteria** (criteria only — no candidate names are proposed tonight; a shortlist drafted before the searches above exist would be decoration, and ROADMAP's shortlist requirement is recorded here as deferred to the gate):
   - **Swahili-rooted**: meaningful, positive meaning in sw, consistent with the project's language pillars.
   - **Class-clear**: no registered or known unregistered use in Nice classes 9, 41, 42 across the offices actually searched (TMview-covered offices, manual BRELA/KiPI, WIPO branddb) for the candidate and its close variants.
   - **Domain available**: an exact-match domain (or a defensible alternative TLD, kwetu.game/.app/.dev-class) confirmed available via RDAP **at selection time**, with the same availability re-checked the day of registration.
   - **Pronounceable in EN + sw**: syllable structure pronounceable and non-embarrassing in both English and Swahili, and spellable after one hearing.
4. The three verifiably open TLDs (kwetu.game, kwetu.app, kwetu.dev) may be registered as option/defensive registrations if the project accepts the cost — a user decision, not one this ADR makes. Nothing in this ADR licenses public use of the name.

## Consequences

- **Budgets rows filled: none** — S0.5 fills no §Budgets rows (ROADMAP §5); this ADR is the deliverable, and the orchestrator's `budgetRows` for this spike is empty by design.
- **Easier:** there is now a dated, URL-tagged record of exactly what was and was not searched, re-runnable query bodies included; the two live "Kwetu" apps and the Sokowatch/Imani/Kikwetu registered marks are visible before any public commitment; three plausible TLDs are documented open; the exact-name space is clean on npm and PyPI.
- **Harder / locked out:** public naming, store listings, marketing and monetization under "Kwetu" stay locked until a human closes the gate; the name is also now known to be *crowded* (a live Africa-wide eSIM brand on the exact name, released 2026-09-04, plus 234 GitHub-name matches), so the fallback criteria in Decision 3 should be exercised seriously, not treated as a formality.
- **Read-hazard guard:** TMview absence must not be read as TZ/KE absence until TMview office coverage for BRELA/KiPI is confirmed (Open item 6); the USPTO negative is only as strong as TMview's US mirror.
- **Verification hooks:** no test or typecheck surface exists for this spike (docs-only; S0.5 adds no code, so `vitest` has no file filter for it — `npm run typecheck` was still run to confirm no regression). Every finding is regenerable from the URLs and the TMview request body in the Method table on a later date; date-stamp every re-run.

## Open items

1. Trademark-attorney confirmation (gate 2a) — REQUIRED before public launch/monetization. Owner: user. Blocks: public naming.
2. Manual BRELA (TZ) class 9/41/42 register search (gate 2b) — ort.brela.go.tz does not resolve; find the working ORS entry point or search in person. Owner: user.
3. Manual KiPI (KE) class 9/41/42 register search (gate 2b) — no online trademark register found; ipsearch.kipi.go.ke has no DNS address records. Owner: user.
4. WIPO Global Brand Database search (gate 2c) — captcha/API-key gated tonight. Owner: user.
5. Primary USPTO search — tmsearch-new.uspto.gov had no A/AAAA records on 2026-09-06 (possibly transient USPTO infrastructure); re-check interactively at tmsearch.uspto.gov in a browser (AWS WAF blocks automation). Owner: user/attorney.
6. Confirm whether TMview covers BRELA and KiPI offices; if yes, re-run the documented TMview query and update Observation 3.
7. General-web known-use sweep (startups/telecom beyond the app stores) — the session's WebSearch budget was exhausted (200/200) and DuckDuckGo bot-walled; re-run on a fresh session or by hand.
8. crates.io exact-name check returned 403 (bot-blocked) — verify manually if Rust tooling ever matters.
