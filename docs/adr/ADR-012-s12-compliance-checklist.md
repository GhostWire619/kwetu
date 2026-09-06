# ADR-012: S0.12 — privacy/compliance checklist (data map, legal frames, subject rights, voice policy)

- **Status**: accepted (engineering checklist delivered; legal citations verified from primary sources 2026-09-06; **not legal advice** — human legal review is itself a gate below, required before Alpha and before any monetization)
- **Date**: 2026-09-06
- **Deciders**: S0.12 keystone spike (orchestrated Phase-0 agent wave). No measurements were taken — S0.12 fills no §Budgets rows (ROADMAP §5: "policy, not measurement"); every legal claim below carries the tag with its primary-source URL.

> **This document is an engineering checklist, NOT legal advice.** It maps what Kwetu stores, what three statutes demand of a small self-hosted multiplayer service, and which repo component and ROADMAP gate owns each obligation. Statutes are summarized in our own words with short name + section references only. A qualified lawyer must review every gate marked `legal review` **before Alpha (public-facing accounts)** and **before any monetization**.

## Context

Kwetu will hold personal data from the moment Phase 3 persists a position through a Nakama account: credentials, social graph, text chat, per-tick player state, and — from Phase 6 — live voice. ROADMAP risk register item 10 names the consequence of leaving these obligations unmapped: retrofit after Alpha, legal exposure in Tanzania/Kenya/EU, and an Alpha compliance screen that cannot pass. The Alpha phase already consumes this spike ("S0.12's compliance requirements enforced (consent, export, deletion, retention)").

Three legal frames are in scope, chosen because they cover the plausible player base and operator:

1. **Tanzania PDPA 2022** (Personal Data Protection Act, Act No. 11 of 2022, now Chapter 44) — the presumptive operator domicile.
2. **Kenya DPA 2019** (Data Protection Act, No. 31 of 2019) — a primary player market.
3. **GDPR** (Regulation (EU) 2016/679) — the strictest common denominator if EU players are accepted at all.

Kwetu's architecture is deliberately small for compliance purposes: one Nakama OSS node, one Postgres, one self-hosted LiveKit (ARCHITECTURE.md §1), no third-party SaaS in the data path, no advertising, no analytics SDK. That is a real liability-reduction decision and this ADR locks it in as such.

## Evidence

### A — Verified platform facts (what the pinned stack actually stores)

All [EXTERNAL, verified 2026-09-06, URLs cited per line]. Architecture locations cross-checked against ARCHITECTURE.md §1/§5/§6/§10/§11 and NETWORKING.md §10/§12.

- **Nakama account surface.** Public profile: id, username, display name, avatar URL, lang, location, timezone, metadata (a public slot capped at 16 KB), edge counts, third-party auth IDs, create/update times, online flag. Private: email, device IDs, custom ID, wallet. [EXTERNAL, verified 2026-09-06, https://heroiclabs.com/docs/nakama/concepts/user-accounts/]
- **Auth modes** are device ID, email+password, custom ID, or social providers; every mode writes to the same account record. [EXTERNAL, verified 2026-09-06, same URL + /docs/nakama/concepts/authentication/]
- **Chat is persistent by default** — messages sent through default channels are saved to the database and served back as history; joining a channel with the persistence flag disabled makes it ephemeral (online users only, never stored). Authors can update and remove their own messages (message codes 1/2); server-side hooks (`RegisterBeforeRt` on `ChannelMessageSend`) can reject or sanitize before delivery. [EXTERNAL, verified 2026-09-06, https://heroiclabs.com/docs/nakama/concepts/chat/]
- **Export/deletion machinery exists**: Nakama console can export all of a player's data and delete the account; the server runtimes expose `accountExportId` / `accountDeleteId` for user-facing flows, and the docs recommend the **recorded** delete flag so the deletion can be replayed after a restore from older backups. Bulk "delete all player data" exists; **partial bulk removal does not** — per-feature sweeps need custom jobs. [EXTERNAL, verified 2026-09-06, https://heroiclabs.com/docs/nakama/getting-started/data-privacy/]
- **Client account deletion** is available as `DELETE /v2/account` (documented as removing all data associated with the user). [EXTERNAL, verified 2026-09-06, https://heroiclabs.com/docs/nakama/concepts/user-accounts/]
- **LiveKit recording is opt-in infrastructure**: Egress — the recording/streaming component — is a **separate service** deployed alongside the LiveKit server (it uses Redis to communicate with the server), and recordings happen only when Egress is running and a recording is requested. No Egress, no recording. [EXTERNAL, verified 2026-09-06, https://docs.livekit.io/transport/media/ingress-egress/egress.md and https://docs.livekit.io/transport/self-hosting/egress.md]
- **Voice session state is transient**: join authority is a short-lived HS256 JWT minted in the Go runtime; moderation is server-side RoomService; proximity is subscription culling (NETWORKING.md §10, verified there 2026-09-05). ARCHITECTURE.md §10 already fixes that clients never see LiveKit credentials.
- **Client-side storage** per ARCHITECTURE.md §10/§11: session JWT in memory only, refresh token in IndexedDB (best-effort, cleared on logout), tile/asset bytes in the Cache API, manifest in IndexedDB — the caches hold game data, not identity.
- **Ops layer** (PII-adjacent): Caddy TLS/ACME logs, Nakama server logs (can carry user IDs/usernames), Prometheus/Grafana aggregates (counters/gauges, not identities), and — from Alpha — Postgres `pg_dump` backups stored offsite (ROADMAP Alpha deliverable). Backups are a PII store and are covered by the deletion duty below.

### B — Verified statutory facts

Method: primary texts downloaded 2026-09-06 and text-extracted locally (Kenya Act + Registration Regulations from ODPC PDFs; Tanzania Act from the official English Gazette translation GN No. 395B on pdpc.go.tz; GDPR from the EUR-Lex consolidated text). Summaries below are our own words.

**Tanzania PDPA 2022 (Ch. 44).** [EXTERNAL, verified 2026-09-06, https://pdpc.go.tz/documents/3/PERSONAL_DATA_PROTECTION_ACT_2022.pdf]

- Territorial reach: applies to controllers domiciled in the United Republic and to processing carried out in Tanzania (s. 22(1)); Mainland and Zanzibar, non-union matters excepted (s. 2).
- **Registration**: a person must not collect or process personal data without being registered as a controller or processor (s. 14(1)); registration certificate runs five years, renewable (s. 16). The Act text itself carries **no small-operator carve-out** — exemptions, if any, live in the 2023 Regulations (not verifiable tonight; see open items).
- Collection needs a lawful purpose related to the controller's function and necessity (s. 22(2)); data is collected directly from the subject with awareness of purposes (s. 23).
- Security of data is a controller duty (s. 27), and **any security breach affecting personal data must be notified to the Commission without undue delay** (s. 27(5)) — no fixed hour count in the Act.
- Retention and disposal rules (s. 28); correction duty (s. 29).
- Sensitive data needs **prior written consent** (s. 30(1)), and "data related to children" is in the sensitive definition (s. 3); where the subject is a minor, consent comes from a guardian or lawful representative (s. 30(4)). No numeric age appears in the Act text.
- Transborder flow: transfer to a country with an adequate legal framework is conditioned on necessity/no-prejudice tests (s. 31); other destinations need an assessed adequate protection level (s. 32); the Commission may prohibit transfers (s. 31(1)).
- Rights: access (s. 33), prevention of harmful processing (s. 34), objection to direct marketing (s. 35), automated-decision rights (s. 36), compensation (s. 37 — exercisable via a representative for a child), rectification/blocking/erasure/destruction (s. 38). Administrative fines (s. 47).

**Kenya DPA 2019.** [EXTERNAL, verified 2026-09-06, https://www.odpc.go.ke/wp-content/uploads/2024/02/TheDataProtectionAct__No24of2019.pdf and https://www.odpc.go.ke/wp-content/uploads/2024/03/THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf — note: the Act PDF's text layer extracted with OCR-class noise; section numbers below were confirmed from the Act's own arrangement of sections and body where recoverable]

- **Registration** with the Office of the Data Protection Commissioner is required (s. 18). The Registration Regulations exempt a controller/processor whose annual turnover **and** annual revenue are both below five million shillings and who has fewer than ten employees (Reg. 13(2)); the exemption does not apply to processing for the purposes listed in the Third Schedule — telecom network/service provision, direct marketing, gambling, financial services, and similar (Reg. 13(4)); registration certificates run twenty-four months (Reg. 9). [EXTERNAL, verified 2026-09-06, Registration Regulations PDF]
- Data protection officer designation (s. 24); principles (s. 25); **data subject rights**: information, access, objection, correction, deletion of false or misleading data (s. 26), exercised by a parent/guardian where the subject is a minor (s. 27(a)); direct collection duty (s. 28); consent conditions (s. 32); **children**: no processing of a child's data without parental/guardian consent, and controllers must build age-verification and consent mechanisms (s. 33); portability (s. 38); **retention limitation** (s. 39); rectification and erasure (s. 40); privacy by design (s. 41); **breach**: notify the Data Commissioner within seventy-two hours and the data subject in writing within a reasonably practical period; a processor must tell its controller within forty-eight hours (s. 43). Transfers out of Kenya (s. 48) with safeguards (s. 49) and a dedicated server-in-Kenya processing provision (s. 50). Sensitive data includes biometric data (s. 2 definition).
- The statutory child-age figure was not recoverable from the noisy PDF tonight — flagged for legal review (open item).

**GDPR.** [EXTERNAL, verified 2026-09-06, https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02016R0679-20160504 — Articles 1–36 line-checked in the consolidated text; Chapter V confirmed via the text's own cross-references to Articles 46, 47, 49(1); the Article 37+ block truncates in that fetch and is flagged for legal review]

- Applicability: established in the EU (Art. 3(1)) **or** offering goods/services to, or monitoring the behavior of, data subjects in the Union (Art. 3(2)) — free-of-charge services still count as "offered" where use is intended/foreseen.
- Lawful bases: consent, contract, legal obligation, vital interests, public task, legitimate interests (Art. 6); consent must be freely given, specific, informed, withdrawable (Art. 7).
- Children: for information-society services offered directly to a child, processing on the consent basis is lawful only where the child is at least 16, with member states free to lower that to no less than 13 (Art. 8).
- Rights: access (Art. 15), rectification (Art. 16), erasure (Art. 17), portability (Art. 20), objection (Art. 21).
- Duties: data protection by design and by default (Art. 25), records of processing (Art. 30), security (Art. 32), **breach notification to the supervisory authority within 72 hours** (Art. 33) and to affected subjects where risk is high (Art. 34), DPIA where processing is likely high-risk (Art. 35), representative of non-EU controllers (Art. 27).
- Transfers (Chapter V, Arts. 44–49): adequacy decisions or appropriate safeguards such as standard contractual clauses.

**Adequacy landscape.** The EU adequacy list contains **no African country** — Kenya and Tanzania are not on it. [EXTERNAL, verified 2026-09-06, https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en]

### C — The Kwetu data map (system of record, per ARCHITECTURE.md §1)

| # | Data | Lives in | Class / notes |
|---|---|---|---|
| 1 | Credentials: username, email, password hash, device IDs, custom ID | Postgres (Nakama-managed tables) | Identity. Email optional if device-only auth is chosen at signup [PLACEHOLDER — gate: Phase 5 signup flow decision] |
| 2 | Profile: display name, avatar URL, lang, location, timezone, ≤16 KB metadata | Postgres (Nakama users) | Public-by-design; location/timezone fields are deprecated-by-default for us — leave them unset |
| 3 | Friends / social edges | Postgres (Nakama edges) | Social graph |
| 4 | Text chat messages | Postgres (Nakama channels — persistent by default) | Conversational data; can be made ephemeral per channel |
| 5 | Player position / match state | Match-handler memory (authoritative) → snapshot callbacks → Nakama storage → Postgres | Kinematic state; not sensitive, but personal |
| 6 | Storage objects (world-state persistence, any Kwetu JSON, wallet ledger from Phase 5) | Postgres (Nakama storage) | Per-user objects |
| 7 | Voice session metadata: short-lived join-token JWTs, room/participant presence | Go runtime minting (token), LiveKit memory (presence) | Transient; no media at rest without Egress (Evidence A) |
| 8 | Voice media | Never stored: no Egress service is deployed; no transcription | Absence is the guarantee — see Decision 4 |
| 9 | Client-side: session JWT (memory), refresh token (IndexedDB), tile/asset cache (Cache API + IndexedDB) | Player's browser | Tokens are credentials, not identity; caches hold non-personal game data |
| 10 | Ops: server logs, Caddy logs, Prometheus aggregates, console | Host / internal network | May carry IDs/usernames in log lines |
| 11 | Postgres backups (from Alpha) | pg_dump sidecar, rotated, offsite | A PII store — deletion and transfer duties apply; pairs with Nakama's recorded-delete replay |

## Decision

The checklist. Each item names the **owner** (the component or role that lands it) and the **gate** (ROADMAP phase or an explicit placeholder). Nothing here may be closed by an agent asserting a legal conclusion; gates marked `legal review` require a human lawyer.

### 1. Data map (adopted)

- **D1** — Adopt the §Evidence-C data map as the canonical inventory. Owner: project docs. Gate: refreshed at **Phase 5** (accounts, chat, snapshots go live), finalized for **Alpha**'s compliance screen; any new data category lands with an ADR or a row added the same change.
- **D2** — Data minimization defaults: leave Nakama's `location`/`timezone` profile fields unset; collect email only for players who choose email+password auth; keep client caches free of identity data (ARCHITECTURE.md §10 already keeps long-lived secrets out of `localStorage`). Owner: client + server runtime. Gate: **Phase 5**.

### 2. Legal frames and registration posture

- **D3** — **GDPR is the strictest common denominator**: build notice, rights, security and breach handling once to the GDPR standard; Tanzania and Kenya obligations then layer on (registration, breach clocks, transfer mechanisms). Rationale: implementing to the strictest frame is cheaper than per-jurisdiction forks in an OSS codebase. Owner: project. Gate: standing policy from Phase 0; no gate.
- **D4** — **Registration determinations** (each is a posture check, not an automatic registration):
  - Tanzania: s. 14 registration applies before collecting/processing personal data; confirm against the 2023 Regulations whether any small-scale carve-out exists. Owner: project lead + legal review. Gate: **[PLACEHOLDER — gate: legal review before public signups (Alpha)]**; posture documented by Phase 5.
  - Kenya: if operating into Kenya, evaluate Reg. 13(2) exemption (turnover and revenue below five million shillings, fewer than ten employees, no Third-Schedule purpose) versus s. 18 registration; re-evaluate on any monetization or team growth — both can void the exemption. Owner: project lead + legal review. Gate: **[PLACEHOLDER — gate: legal review before Alpha; re-check at any monetization decision]**.
  - EU: if EU players are accepted without geo-blocking, Art. 3(2) applies through the "offering" limb; plan for the Art. 27 representative and GDPR-conform notice/rights rather than blocking. Owner: project lead + legal review. Gate: **[PLACEHOLDER — gate: legal review before Alpha]**.
- **D5** — **Lawful bases / processing grounds** (engineering-facing mapping):
  - Account + position/state: performance of the service (GDPR contract basis, Art. 6(1)(b)); TZ: lawful-purpose + necessity collection tests (s. 22(2)); KE: grounds under Part IV of the Act. Consent is *not* the basis for mere account operation — consent-based processing is reserved for voice publishing and any optional feature, so it can be withdrawn without breaking the account.
  - Voice publishing: consent, expressed per-session by the push-to-talk press itself (see D9) — the cleanest possible consent artifact.
  - Moderation and anti-cheat (validator drift flags, RoomService mute): legitimate interests / safety-of-users basis; TZ legal-claims ground (s. 30(5)(c)) where sensitive data is involved.
  - Owner: server runtime + docs. Gate: notice text at **Phase 5**; reviewed at Alpha.
- **D6** — **Retention expectations**: every frame has a storage-limitation duty (GDPR Art. 5(1)(e) via the principles; KE s. 39; TZ s. 28). Concrete per-category retention periods are deliberately **not** set here — they are the ROADMAP Alpha deliverable "ADR retention schedule". This ADR fixes only the shape: chat history and match snapshots are the retention candidates; credentials and storage objects live as long as the account; voice has nothing to retain. Owner: ops + project. Gate: **Alpha**.

### 3. Subject rights implementation path

- **D7 — Export.** Two layers, both already provided by the pinned stack: (a) operator-level via Nakama console export; (b) player-facing via a Go-runtime RPC wrapping `accountExportId`, permission-checked to the caller's own ID. If that bundle ever proves to miss a Kwetu-owned storage collection, the fallback is a per-user storage listing over the runtime storage-list API plus our own collection dump — same RPC, audited against the data map. Voice media is excluded by design — there is none to export (D8). Owner: Go runtime. Gate: RPC lands **Phase 5** (accounts are live there); exercised end-to-end at **Alpha**.
- **D8 — Deletion cascade.** Player-triggered `DELETE /v2/account` (client SDK) or operator `accountDeleteId` with the **recorded** flag set, per Nakama's own backup-restore guidance. The cascade and its verification:
  1. Account, storage objects, friends, chat messages, wallet, notifications — removed by Nakama's delete (Evidence A).
  2. **Kwetu-owned residue to sweep and verify at Phase 5**: match snapshots keyed by user id in our storage collections; any Go-runtime indexes. Presence data and voice room membership need nothing — both are session-transient by architecture.
  3. **Backups**: the recorded-delete ID list is replayed after any backup restore (ties to the Alpha backup/restore drill).
  4. **Client-side**: logout clears tokens; tile caches are non-personal and may persist.
  Owner: Go runtime + ops. Gate: cascade implemented **Phase 5**; the recorded-delete replay demonstrated in the Alpha backup drill. Open verification: whether the pinned Nakama 3.37.0 removes every chat row authored by the deleted user, or whether our runtime must sweep residuals — verify at Phase 5 before signups open.
- **D9 — Rectification.** Profile fields editable in-app via `client.updateAccount` / `PUT /v2/account`; chat authors can update or remove their own messages (message codes 1/2 — Evidence A), and this is adopted as the product position: authors own their messages' correction/deletion. Moderation can remove any message server-side via the channel-message hook; there is no admin chat-edit. Owner: client UI + Go runtime. Gate: **Phase 5**.

### 4. Voice privacy (product decisions, stated explicitly)

- **D10 — Push-to-talk is the default for every player, platform and session; open mic is opt-in with a warning**, per NETWORKING.md §11 — justified by the Chromium AEC gap (ROADMAP §Budgets B-CONST-07: Chromium's echo canceller never hears WebAudio output — issues 121673/686665 [EXTERNAL, verified 2026-09-05, per that row]). This doubles as the consent mechanism in D5: the physical keypress is per-transmission consent.
- **D11 — Server-side RoomService mute is the only moderation tool** for voice, matching NETWORKING.md §10: the Go runtime calls RoomService (mute/remove), suspended users are minted tokens without publish grants (NETWORKING.md §12), clients render but never enforce moderation state (ARCHITECTURE.md §10). No client-side mute list is authoritative.
- **D12 — No recording, no transcription, no server-side audio — by default, as a product decision**: the Egress service is not deployed at all, so no voice content exists anywhere at rest (Evidence A). Any future recording feature requires a new ADR covering per-session consent, retention, export scope, and a DPIA — this ADR does not and cannot authorize it retroactively. Owner: infra (deployment keeps Egress out) + project (policy). Gate: **Phase 6** (voice ADR implements these three decisions verbatim); the absence of Egress is checked in the Phase 6/Alpha compliance screen.
- **D13 — Voice metadata stays transient**: short-lived HS256 join tokens, room presence in LiveKit memory, a mint-rate counter in metrics — no per-user durable voice records. Owner: Go runtime. Gate: **Phase 6**; confirm at the LiveKit version pin that no durable participant store is enabled beyond the session [PLACEHOLDER — gate: Phase 6 pin verification].

### 5. Children

- **D14 — The age-gate question is a decision point, not a done deal.** Verified trigger landscape: GDPR Art. 8 defaults to 16 with member states able to go to 13; Kenya requires parental consent and built-in age-verification mechanisms for children's data (s. 33) with a minor's rights exercised by a parent/guardian (s. 27(a)); Tanzania treats data related to children as sensitive data needing prior written consent, given through a guardian for minors (ss. 3, 30(1), 30(4)) but fixes no numeric age in the Act text.
- **D15 — Written default until legal review**: a single conservative global gate — the player attests to being **18 or older** at account creation — plus a parental-consent path shelved until counsel says otherwise. Rationale: one gate is the cheapest thing that satisfies the strictest reading across all three frames; device-based anonymous accounts mean the gate collects **no** age data, only an attestation. This is a product choice to be confirmed, not a legal conclusion: **[PLACEHOLDER — gate: legal review before Alpha / before public signups; also confirm the Kenyan statutory child-age figure and any Tanzanian 2023-Regulations age rules]**. Owner: client UI + project. Gate: ships with the **Phase 5** signup flow, reviewed at Alpha.

### 6. Cross-border

- **D16 — Hosting region is S0.9's decision** (candidates probed from Dar/Zanzibar: eu-central, Cape Town, Nairobi), landing as the Phase 5 hosting ADR and re-tested at Phase 6 for voice. This ADR fixes only the transfer duties each candidate drags in:
  - **eu-central**: all PII at rest in the EU; East African players' data flows out of their region under TZ s. 31/32 or KE s. 48/49 (necessity/adequacy/safeguards tests — the EU is not on any published TZ adequacy list tonight and the EU list has no African countries). Flows back toward East Africa (operator/CI/admin access, offsite backups) are EU exports needing a Chapter V mechanism — standard contractual clauses, since no adequacy exists — plus the Art. 27 representative if EU players are accepted.
  - **Nairobi**: PII in Kenya directly engages KE s. 50 (server-in-Kenya processing) and Kenyan registration/breach duties most strongly; outbound transfers still need s. 48/49 analysis.
  - **Cape Town**: South Africa's POPIA applies and is out of this ADR's three-frame scope — record it as a per-frame addendum before that region could be chosen.
  Owner: infra + project lead + legal review. Gate: region decision **S0.9 → Phase 5 ADR** (voice topology **Phase 6**); transfer instruments and representative engagement **[PLACEHOLDER — gate: legal review, Alpha]**.

### 7. Breach and incident response (minimal checklist)

- **D17 — The runbook, in seven steps** (owner: ops; the full ADR "backup/restore + incident runbook" is already a ROADMAP Alpha deliverable — draft by **Phase 5**, drilled at **Alpha**):
  1. **Detect** — Prometheus/Nakama alerts (ARCHITECTURE.md §9, NETWORKING.md §13), console audit, Postgres logs.
  2. **Contain** — rotate every secret in ARCHITECTURE.md §10's table (`socket.server_key`, session/refresh encryption keys, `runtime.http_key`, console credentials), kill sessions, revoke LiveKit API keys, snapshot evidence.
  3. **Assess** — which of the §Evidence-C categories were exposed, for how long, for whom.
  4. **Notify on the clocks** [EXTERNAL — figures per §Evidence B] — GDPR: 72 hours to the supervisory authority (Art. 33), subjects without undue delay where risk is high (Art. 34); Kenya: 72 hours to the ODPC plus written notice to subjects, processor-to-controller inside 48 hours (s. 43); Tanzania: notify the Commission without undue delay (s. 27(5)). The strictest clock governs the runbook: start it at 72 hours.
  5. **Communicate** — a plain-language notice through the game's own channels.
  6. **Restore** — replay Nakama's recorded-delete list after any backup restore (D8.3).
  7. **Record** — incident log + a dated note in the runbook ADR (ROADMAP §7 change control).

### 8. Notice, records and DPIA

- **D18 — Privacy notice + consent flow in the client** (EN + sw, per the localization invariant), covering the data map, bases (D5), rights (D7–D9), voice (D10–D13), children (D15), transfers (D16), breach contact. Owner: client UI + project. Gate: **Phase 5**; Alpha compliance screen.
- **D19 — Records of processing** (GDPR Art. 30-style) generated from the data map rather than written twice: the data map is the record's source. Owner: docs. Gate: **Alpha**.
- **D20 — DPIA before public voice**: proximity voice over self-hosted infrastructure with possible minors and chat/voice moderation is a plausible Art. 35 trigger; the DPIA is counsel-confirmed, engineering-scaffolded. Owner: project + legal review. Gate: **[PLACEHOLDER — gate: before Phase 6 public voice / Alpha]**.

## Consequences

**Fills no §Budgets rows** — S0.12 is policy, not measurement (ROADMAP §5); the budget table is untouched.

**What becomes easier.** The Alpha compliance screen ("consent, export, deletion, retention") has a named owner and gate per item, and every duty maps onto machinery that already exists in the pinned stack (Nakama export/delete, Nakama chat ephemerality, LiveKit's recording-by-deployment). GDPR-as-denominator (D3) means one rights implementation serves all three frames. Push-to-talk-by-default already serves three masters at once — the AEC constraint (B-CONST-07), the consent mechanism (D5/D10), and the privacy-of-the-home expectation — so the voice design needs no exemption from anything in this ADR.

**What becomes harder.** Backups become a compliance object, not just an ops convenience (recorded-delete replay is mandatory). Retention is now a decision that must be made and defended at Alpha, not deferred forever. EU acceptance carries the Art. 27 representative cost; Kenya/Tanzania registration must be re-checked at every monetization or headcount change because both can flip the posture. The voice stack may never deploy Egress "temporarily" for a community event without a new ADR.

**What this locks out.** Server-side recording or transcription without a successor ADR; third-party analytics or ad SDKs in the client; per-jurisdiction forks of the rights implementation; open-mic-by-default (already excluded by NETWORKING.md §11 — restated here as compliance posture).

**Feeds other docs.** Phase 6's "ADR voice consent/recording policy from S0.12" is D10–D13 of this record — no NETWORKING.md change is needed (its §10/§11 already match). The Phase 5 signup flow, the Phase 5 Go-runtime RPC list (export/delete), and the Alpha retention/runbook ADRs implement D6–D9 and D17. The orchestrator should paste nothing into ROADMAP §Budgets for this spike.

**Open items (also tracked here because they gate Alpha):**
1. Tanzania's 2023 implementation regulations (Collection & Processing; Registration) exist only as scans without a text layer on pdpc.go.tz — child-consent mechanics, registration categories and any small-operator carve-out could not be text-verified tonight; legal review must read them before the D4/D15 gates close.
2. The Kenyan statutory child-age figure was not recoverable from the noisy Act PDF tonight; s. 33's parental-consent duty is verified, the age number needs counsel confirmation.
3. Whether Nakama 3.37.0's account delete removes every chat row authored by the deleted user — verify at Phase 5 before signups open; add a runtime sweep if not.
4. LiveKit participant-metadata durability at the version pinned in Phase 6 — confirm no durable store beyond the session (D13).
5. GDPR Arts. 37+ and Chapter V were not line-checked in the consolidated text tonight (cross-references verified); legal review covers them as a matter of course.
6. The D15 age gate, D4 registrations, D16 transfer instruments, D20 DPIA — all explicitly gated on human legal review.

**Review discipline.** This record was written in one session from primary sources on 2026-09-06; it quotes no statutory text beyond section numbers and short labels, and it invents no obligations — every legal statement traces to §Evidence. A lawyer's corrections supersede this file via ROADMAP §7 change control (a superseding ADR, not silent edits).
