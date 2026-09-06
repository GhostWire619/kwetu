# Swahili i18n — Localization Contract

This doc owns localization for Kwetu: key structure, the PO workflow, and the
EN↔sw process (per the ownership table in [CLAUDE.md](../CLAUDE.md)). It binds
from the first UI change — Swahili is a first-class language, not a phase-3
add-on. Version pins live in ARCHITECTURE.md; dataset provenance in
DATA_SOURCES.md; dependency ledger rows in THIRD_PARTY_ASSETS.md. Claim tags
follow [docs/adr/README.md](adr/README.md): data quoted below was read from
the cited sources on **2026-09-05** and must be re-verified at the pinned
commit before any import.

## 1. Principles

1. **Swahili is a first-class UI language.** Every user-facing string lands in
   EN and sw **in the same change** — a PR that adds an English string without
   its sw rendering is incomplete and fails CI (§9).
2. **Swahili runs ~10–20% longer than English.** [PLACEHOLDER — gate: the
   length-diff report (§9) measures the real factor per screen.] This section
   is the canonical statement of that factor — an assumption until measured,
   and other docs cite it here rather than tagging it themselves. Until
   measured, every screen absorbs ≥20% expansion without truncation or reflow,
   **from the first screen onward** — retro-fitting layouts for a second
   language is the classic i18n failure mode.
3. **No hard-coded English in components.** Components render strings from the
   i18n layer only; a static lint (§9) rejects raw literals in render paths.
4. **Agents draft, native speakers approve.** Machine and agent translation
   are drafting tools: they produce `fuzzy` entries that a native-speaker
   review gate clears before release (§8, §9). Nothing ships as approved sw
   copy without that sign-off.
5. **Both locales go through the same pipeline.** EN is stored as PO and
   compiled too — the fallback language is data, not component literals (§4).

## 2. Source of truth: gettext PO

The source of truth is **gettext PO**, not JSON, not a CMS, not in-code
literals.

```
locale/
  messages.pot              # template extracted from source (xgettext/msgmerge)
  ui/en.po  ui/sw.po        # UI chrome — one domain file per locale
  items/en.po items/sw.po   # item and object names
  world/en.po world/sw.po   # places, bodies, region copy
  glossary-sw.md            # term decisions (§8)
  toponyms-sw.json          # frozen place-name table (§7, generated)
```

Per-domain files (`ui.po` / `items.po` / `world.po`) instead of one monolith,
so a one-screen change produces a small, reviewable diff confined to its
domain.

- **`msgid` is the English source string** (natural keys). Any agent can
  author an English string, see it appear in the PO with full context, and
  translate it — no invented key vocabulary, no key registry. The cost is key
  churn: **renaming the English source text is a key rename**, and the same
  change must update every locale's PO and every code reference. Renames are
  treated as string additions, not refactors.
- **`msgctxt` carries the screen path** — `<screen>/`, snake_case segments,
  trailing slash (e.g. `main_menu/`, `settings/audio/`). It disambiguates
  identical English strings ("Play" the action vs "Play" the media verb) and
  gives translators the screen context inline. msgctxt is mandatory in
  `ui.po`; `items.po` and `world.po` use entity-path contexts (`items/rover/`,
  `world/zanzibar/`).
- **Plurals use `msgid_plural` + `msgstr[n]`** (§3).
- **Placeholders are i18next tokens, not printf.** msgids carry `{{token}}`
  directly (`"{{count}} friends online"`); the lint rejects `%s`/`%d`-style
  msgids so the compile step never has to rewrite tokens.

Example (illustrative copy — renderings are proposals, not approved):

```po
msgid ""
msgstr ""
"Plural-Forms: nplurals=2; plural=(n != 1);\n"

msgctxt "main_menu/"
msgid "Play"
msgstr "Cheza"
# fuzzy = drafted, pending native-speaker review
#, fuzzy
msgctxt "friends/"
msgid "{{count}} friend online"
msgid_plural "{{count}} friends online"
msgstr[0] "Rafiki {{count}} mtandaoni"
msgstr[1] "Marafiki {{count}} mtandaoni"
```

Extraction uses the GNU gettext toolchain (`xgettext` → `messages.pot`,
`msgmerge` → domain POs). The gettext programs are GPL-licensed binaries;
running them on our sources does not affect the license of the output.

## 3. Plural rules

Swahili has **two plural categories: `one` and `other`** — CLDR gives sw
`one: i = 1 and v = 0`, `other` catch-all
[EXTERNAL: https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/plurals.json].
The canonical PO header is therefore the standard two-form expression, set
explicitly in every POT/PO we ship:

```
"Plural-Forms: nplurals=2; plural=(n != 1);"
```

- GNU gettext's own language table **does not list Swahili**
  [EXTERNAL: https://www.gnu.org/software/gettext/manual/html_node/Plural-forms.html],
  so no template can be trusted to carry the right line for sw — it is always
  written by us, cross-checked against CLDR.
- **Corrupted headers circulate in real sw files.** The research sweep found
  an Arabic `nplurals=6` plural expression inside sw-labelled WordPress POTs
  [MEASURED 2026-09-05, research-agent corpus sweep]. Importing such a file
  silently mis-pluralizes the runtime resolver. **The compile step and the
  lint must reject any sw PO whose `Plural-Forms` header does not exactly
  match the canonical line above** — not "parse it anyway".

## 4. Runtime and build pipeline

- **Runtime: i18next** — UI-agnostic and MIT-licensed; it drives the DOM
  overlay UI on top of the three.js canvas and imposes no component
  framework. (Version pins: ARCHITECTURE.md.)
- **PO compiles to i18next JSON at build** via `i18next-conv`
  (or `po2json` where a plain converter suffices). Verified options
  [EXTERNAL: https://unpkg.com/i18next-conv/README.md]: `-k/--keyseparator`
  defaults to `##`, `--ctxSeparator` defaults to `_`, `--compatibilityJSON v4`
  targets i18next@21+ plural format; PO/MO ↔ JSON, plus POT emission. The
  build wrapper sets these **explicitly** — never tool defaults.
- **Compile-step contract** (each item is a hard build failure):
  1. preserve `msgctxt` — the context survives into the emitted key;
  2. validate the `Plural-Forms` header against §3 (exact match);
  3. emit **flat keys**: joined `msgctxt` + `msgid` with `/`
     (`settings/audio/` + `Volume` → `settings/audio/Volume`);
  4. reject duplicate joined keys and printf-style placeholders in msgids;
  5. emit plural keys in i18next v4 form (`key_one` from `msgstr[0]`,
     `key_other` from `msgstr[1]`).

  **Key-order correction [MEASURED 2026-09-06, tools/spikes/s0.10]:** the raw
  `i18next-conv` 17.0.0 CLI emits flat keys as `msgid + ctxSeparator + msgctxt`
  (msgid-FIRST — and an empty `ctxSeparator` is impossible, so the raw join can
  never match this contract's `msgctxt/msgid` order). The contract above is
  therefore implemented by the **build wrapper**, which re-keys the converter's
  output into `msgctxt/msgid` order before the JSON is written. The wrapper is
  a required pipeline component, not an optimization; productionizing it is a
  Phase-1 deliverable (ADR-010 Decision 4).

  Flat keys are chosen over nested JSON because msgids are free English text:
  they legitimately contain `.`, spaces, and punctuation that would corrupt
  nested-key traversal. The runtime therefore sets `keySeparator: false` and
  `nsSeparator: false`; namespaces (`ui`/`items`/`world`) are passed
  explicitly.
- **Loading: HTTP backend, lazy per locale.** Compiled JSON is served from
  `/locales/<lng>/<ns>.json` via i18next-http-backend. The main bundle ships
  **zero** locale strings — neither language is bundled. `en` is `fallbackLng`
  and loads immediately; `sw` loads on demand, namespace by namespace, so a
  player only ever downloads what they use.
- Missing sw keys fall back to EN at runtime and are collected into the QA
  report (§9) — a safety net, never a steady state.

## 5. Locale data: dates, numbers, currency

Date, number, and currency formatting is **not translated by hand** — it is
pulled from CLDR (`cldr-json`; the data files are covered by the Unicode
License V3 [EXTERNAL: https://www.unicode.org/license.txt]). Values below were
read from cldr-json `main/sw` on 2026-09-05; pin the commit at import:

| Data | sw value |
|---|---|
| Months (wide, stand-alone) | Januari, Februari, Machi, Aprili, Mei, Juni, Julai, Agosti, Septemba, Oktoba, Novemba, Desemba |
| Days (wide, sun→sat) | Jumapili, Jumatatu, Jumanne, Jumatano, Alhamisi, Ijumaa, Jumamosi |
| Decimal / group separators | `.` / `,` (latn digits) |
| TZS display name / symbol | "Shilingi ya Tanzania" / "TSh" |

Formatting runs with **the player-chosen locale, never the platform's**:
`navigator.language` may seed the initial default, but the persisted settings
value is the only input afterwards — it feeds `Intl.DateTimeFormat`,
`Intl.NumberFormat`, and currency rendering (TZS) for every timestamp,
distance, and price shown in-game.

## 6. Safe-reuse stack (ordered)

Swahili UI vocabulary is reused from license-clean corpora, in this strict
order. **Before any import: a THIRD_PARTY_ASSETS.md row with the LICENSE
fetched and read at the pinned commit** (CLAUDE.md invariant). Each source is
a **reference corpus for agent translators** — "look up how established sw
software says this", not "bulk-copy files".

| Rank | Source | License | Use and restrictions |
|---|---|---|---|
| 1 | CLDR (`cldr-json`) | Unicode License V3 | Dates, numbers, currency, plural data. Cleanest source; permissive. |
| 1 | Wikidata labels + aliases | CC0 | Toponyms and proper nouns (§7). No attribution burden beyond CC0. |
| 2 | Ubuntu / Launchpad Rosetta exports — **mine the old release series** | BSD | Generic UI vocabulary ("Settings", "Cancel", "Save"). Small, dated, but genuinely human-translated sw. |
| 3 | Godot editor sw strings | MIT | Editor-registered UI vocabulary only; small coverage. Use as reference corpus for agent translators; do not wholesale-copy. |
| 4 | Mozilla sw (Firefox l10n) | MPL-2.0 | Browser/internet vocabulary. **File-level copyleft**: keep any imported files as separate files and attribute them in NOTICE/ATTRIBUTIONS.md. [PLACEHOLDER — gate: confirm the sw repo path and license header at the pinned commit before import.] |
| avoid | KDE sw strings | LGPL/GPL | Avoid — copyleft obligations we do not want in a UI string layer. |
| never | anything NC / ND | — | Never enters the repo, same rule as code/assets. |

**Never machine-translate GPL-licensed project strings into Swahili and ship
the result as original work** — a translation of GPL text is a derivative of
it. If a string resembles a GPL project's string, it comes from the permissive
rows above or from our own drafting, or it does not ship.

## 7. Toponym table

Real place names (Dar es Salaam, Zanzibar, Stone Town, the Kenya regions) come
from a **frozen, review-gated place-name table** (`locale/toponyms-sw.json`),
built by a pinned script from:

- **Wikidata labels + aliases** (CC0) — primary;
- **GeoNames sw alternates** (CC-BY 4.0) — secondary;
- **OSM `name:sw` tags — cross-check only.** The corpus is real: 32,138 objects in the
  Tanzania extract already carry explicit Swahili names [MEASURED 2026-09-05,
  research-agent corpus sweep]. This section is the canonical home of that count; other
  docs cite it here rather than re-tagging it.

**Never blind-import.** The canonical worked example, verified against the
Wikidata API [MEASURED 2026-09-05, wbgetentities, entity Q844417]: for Stone
Town, the **sw label is the district name "Wilaya ya Unguja Mjini"** — while
the name everyone actually uses locally, **"Mji Mkongwe", appears only on the
English-language alias side** (the sw alias list holds the segment-order
variant "Wilaya ya Mjini Unguja"). A naive "take the sw label" import ships
the district, not the settlement; a naive "take any alias" import ships the
wrong thing entirely. Every entry therefore passes a **human review gate** —
a native speaker confirms granularity (settlement vs district vs region) and
local usage — before it enters the frozen table. The table is frozen per
release: regeneration re-runs the gate, it does not silently overwrite.

**License rule:** OSM `name:sw` is ODbL. The table stays **built from CC0 /
CC-BY sources with OSM only as cross-check** — the moment OSM values are
ingested, the whole table becomes a derivative ODbL database and must move
into `data/` under the ODbL layer rules ([data/README.md](../data/README.md)).
The review gate checks that no ingested value is OSM-derived; provenance and
regeneration rows live in DATA_SOURCES.md.

## 8. Glossary — `locale/glossary-sw.md`

Game-specific vocabulary is decided **once**, in the glossary, not re-litigated
per screen. The glossary holds two lists: approved sw renderings, and terms
**deliberately left in English** (product names like "Kwetu", feature names
pending a native-approved rendering). It is binding: agents must consult it
before authoring any sw string, and a PR that contradicts it is wrong.

Seed below — **every rendering is a PROPOSAL requiring native-speaker
review**; where natural Swahili usage prefers a loanword or already-Swahili
word, the proposal keeps it rather than inventing a calque.

| English | Proposed sw (PROPOSAL) | Note |
|---|---|---|
| dhow | dau | The Swahili word; English "dhow" is the borrowing. Overlaps with mashua — native review should split the craft classes. |
| mashua | mashua | Already Swahili (boat). Confirm which craft class it denotes in-game. |
| daladala | daladala | Already Swahili (Dar es Salaam minibus). |
| bajaji | bajaji | Already Swahili (three-wheeler). |
| baraza | baraza | Already Swahili (veranda / council bench) — in-game social space. |
| orbit | mduara | Noun; the verb "kuzunguka" covers orbiting as an action. |
| training time acceleration | kuongeza kasi ya muda | Draft: isolated training only; native review required. |
| fictional rapid transit | safari ya kasi ya kubuni | Draft: separate key from clock acceleration; native review required. |
| region | eneo / mkoa | "eneo" general; "mkoa" if the real Tanzanian admin regions are meant — review decides per context. |
| map | ramani | Standard. |
| account | akaunti | Standard loanword. |
| username | jina la mtumiaji | Standard compound. |
| friend | rafiki | Plural "marafiki" (§3 example). |
| chat | mazungumzo | Verb "kuzungumza". |
| voice | sauti | Voice chat = "mazungumzo ya sauti". |
| push-to-talk | bonyeza kuzungumza | Descriptive compound; review for a shorter form. |
| settings | mipangilio | Standard (Ubuntu sw usage). |
| launch | zindua | Verb; noun "uzinduzi". |
| landing | kutua | Verb/noun; "eneo la kutua" = landing site. |
| rover | gari la utafiti | Descriptive; loanword "rova" is the alternative — review decides. |
| planet | sayari | Standard. |
| moon | mwezi | Also means "month"; context disambiguates. |
| star | nyota | Standard. |
| space station | kituo cha angani | "anga" = sky/space. |
| avatar | kivuwazo | Coinage used in sw software glossaries; loanword "avatar" acceptable. |
| server | seva | Standard loanword. |

## 9. QA gates

All four run in CI from Phase 1; a red gate blocks the change.

1. **Pseudo-localization build.** A generated `pseudo` locale derived from the
   EN PO (accented ASCII, `[== … ==]` wrappers, ~40% padding) on every screen,
   surfacing truncation and hard-coded-English leaks before sw copy exists.
2. **Screenshot-based visual QA per locale.** Every screen captured in EN, sw,
   and pseudo; reviewed in PR, persisted per release.
3. **Playwright "no raw keys" pass.** Walks every screen in every shipped
   locale and asserts every visible text node is a value in the loaded
   namespace resources — any element displaying a compiled key (or an
   unresolved fallback) fails the run.
4. **Length-diff report EN vs sw per screen.** Aggregates per-`msgctxt`
   character-length deltas; validates the §1 expansion assumption and flags
   screens where sw copy risks overflow before visual QA runs.

Lint suite (build-time):

| Lint | Rule |
|---|---|
| plural-header | sw PO `Plural-Forms` header matches §3 exactly (§3 corruption case) |
| no-hardcoded-english | no raw string literals in component render paths (small explicit allowlist) |
| msgctxt-format | msgctxt present in `ui.po`, `<screen>/` snake_case, trailing slash |
| placeholders | msgids use `{{token}}` only; printf-style rejected |
| key-uniqueness | joined `msgctxt+msgid` keys are unique per namespace |
| same-change | a PR adding/changing an EN string touches the sw PO in the same change; untranslated sw entries carry the `fuzzy` flag, which is the "pending native review" marker, and a release gate fails while any shipped screen still has `fuzzy` strings |

## 10. Open gates

- Expansion factor (~10–20%) stays an assumption until the length-diff
  report measures it (§1, §9).
- License verifications outstanding before first import, each requiring the
  LICENSE fetched at the pinned commit: i18next/i18next-conv LICENSE.md (MIT
  per plan, unverified this session), Ubuntu/Launchpad Rosetta export terms
  (BSD per plan), Godot editor sw string files (MIT), Mozilla sw l10n repo
  path and license header (MPL-2.0 per plan).
- CLDR `cldr-json` and Wikidata data quoted here were read 2026-09-05;
  import-time pins must re-verify (§5, §7).
- Native-speaker reviewer(s) for the glossary, toponym gate, and fuzzy
  clearance are not yet recruited — release-blocking for sw.
- The compile, lint, and QA steps above land as repo scripts at Phase 1 (the
  `Commands` table in CLAUDE.md is a Phase-1 placeholder).
