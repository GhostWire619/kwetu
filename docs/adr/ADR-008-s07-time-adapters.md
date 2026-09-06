# ADR-008: S0.7 — TT universe clock: adapters, leap table, warp isolation and restart

- **Status**: accepted (measured 2026-09-06). The SOI handoff *algorithm* half of S0.7's exit
  criterion is deferred to Phase 7 per ROADMAP §4 ("ADR SOI handoff algorithm") — this record
  fixes the clock contract that handoff must use (Decision 3). Open items listed at the end.
- **Date**: 2026-09-06
- **Deciders**: S0.7 keystone spike (orchestrated Phase-0 agent wave); probes, tests and report
  at `tools/spikes/s0.7/` (`report.json`, regenerable via `node tools/spikes/s0.7/writeReport.ts`;
  host: Windows 11 dev box, Node v24.13.0, astronomy-engine 2.1.19)

## Context

ADR-001 Decision 3 fixed the clock *semantics* — TT seconds since J2000 TT is the authoritative
instant, the public shared clock rate is real time, offline coast preserves duration, accelerated
isolated training cannot merge state, fictional rapid transit is a separately labelled trajectory
mode — and COORDINATE_SYSTEM.md §4 fixed the persisted field set and outage policy. Both left the
implementation unverified. ROADMAP §9 makes the S0.7 gate: TT/UTC/provider adapters; leap
boundary; wall-clock jump; restart/reconnect; coast/burn/contact/SOI transitions; one movement
owner.

Two runtime hazards had no measured answer. First, ECMAScript `Date` carries no leap-second
labels and cannot express an inserted second (`:60`), so UTC↔TT conversion needs a versioned
table plus a stated policy for the one second the POSIX timeline cannot label. Second,
astronomy-engine's `Date` input is interpreted as UT while its ephemerides run on a TT derived
from a ΔT model — feeding a true TT instant through the wrong door misplaces it silently by the
whole ΔT (measured in Evidence B).

## Evidence

All values [MEASURED 2026-09-06, vitest probes + `report.json` under `tools/spikes/s0.7/`,
methods recorded there per probe] unless tagged otherwise. 29 probe tests pass
(`npx vitest run tools/spikes/s0.7`); a strict `tsc --noEmit` over the spike files is clean
(project flags + `resolveJsonModule` + `allowImportingTsExtensions`).

**A — Leap table and known points (fills B-TIME-02).** The committed table
`client/src/engine/leap-seconds.json` (`kwetu.leap-table/1`; spike path at decision time
was `tools/spikes/s0.7/leap-seconds.json` — relocated 2026-09-06 per Decision 1) holds 28 entries, base
TAI−UTC = 10 s at 1972-01-01 through 37 s at 2017-01-01 — the current offset 37 s is in force
throughout 2026. Re-verified 2026-09-06 row-by-row against the live IANA file
https://data.iana.org/time-zones/data/leap-seconds.list ('#$ last update' NTP 3992312697,
'#@ expires' NTP 4023129600 = 2027-06-28; 28/28 rows matched date-by-date and value-by-value;
no negative step) [EXTERNAL — verified 2026-09-06, url]. Conversion points [MEASURED
2026-09-06, ttClock probes]: `2000-01-01T11:58:55.816Z ↔ TT 0` is exact in **both directions**
(the J2000 TT POSIX label derives from the table as 946727935816 ms = civil 12:00:00Z − 32 s
leap − 32.184 s TT−TAI); 2017-01-01 reads 37 s and the last label before it 36 s; a 6 h sweep
2016-06 → 2017-06 is strictly increasing with exactly one +1 s TT step (21 600 s of labels =
21 601 s of TT); two days of labels across the step = 172 801 s of TT; label round-trips are
exact at every table boundary tested. The inserted 2017 second has no POSIX label — TT instants
inside it clamp to the last representable label (`2016-12-31T23:59:59.999Z`), a stated policy —
and `:60` input labels are rejected. Instants before table coverage are refused, never
extrapolated.

**B — astronomy-engine cross-check (fills B-TIME-01).** Library conventions read from the
installed 2.1.19 source [MEASURED 2026-09-06, `node_modules/astronomy-engine/astronomy.js`]:
the epoch constant is `J2000 = new Date('2000-01-01T12:00:00Z')`; `AstroTime(Date)` sets
`ut = (ms − J2000.ms)/86400000` and `tt = ut + ΔT(ut)/86400`, ΔT defaulting to the
Espenak–Meeus model (`SetDeltaTFunction` is the override hook); Earth rotation (`era()`,
consumed by `SiderealTime`) reads `time.ut` while nutation (`e_tilt`) and the ephemeris
polynomials read `time.tt` — a dual-scale library with **no TDB anywhere**. The JS package has
no `DayValue` export (that is the C# API name); its J2000-days convention enters through the
`AstroTime` numeric constructor / `MakeTime`, verified against the epoch constant
(`MakeTime(2000-01-01T12:00:00Z).ut === 0` exact). Cross-check over 7 samples spanning
1995–2026 (J2000 itself, ±150–840e6 s, one ms-level): `AstroTime.FromTerrestrialTime(tt/86400).tt
− tt/86400` = **0 days (bitwise) at every sample**, and the linear convention
`MakeTime(libEpoch + tt·1000).ut − tt/86400` = **0 days (bitwise)**; both are bounded above by
the library's 1e-12 day solve tolerance and our f64 ULP (Evidence E). **The measured trap**:
feeding our TT as a naive `Date` misplaces it by the ΔT model — 63.847 s at J2000 rising to
75.432 s at the 2026 samples; at the COORDINATE_SYSTEM.md §12 instant that is a GAST error of
0.3153 deg ≈ 18.9 arcmin. The committed §12 seed (and ADR-002's chain) used the date-feed
convention; its difference from the TT-correct feed is measured 0.02626 deg ≈ 6.3 s of Earth
rotation. ADR-011's golden verifier already enters at identical TT instants via
`FromTerrestrialTime` — the fixture side has the convention pinned.

**C — Warp semantics (ADR-001 Decision 3, encoded as tests).** The shared `UniverseClock`
anchors worldTime to an injectable monotonic source at rate 1; a warp is an isolated
`WarpClock` view with its own anchor and rate that never touches the parent anchor. Identical
fake-mono scenarios with and without a concurrent 10× warp produce shared-clock readings that
are **bitwise identical at 6 sample stops (max divergence 0 s)** — zero divergence by
construction, not by correction. The warp view itself advances 100 s of local TT over 10 s of
host time (rate 10, 90 s ahead of shared at the last stop) and `WarpClock.serialize()`
**throws** — accelerated state cannot merge. The three movement-regime sample slots (named
CONTACT_LOCAL / FLIGHT_DYNAMIC / ORBIT_COAST in the probe) read identical shared instants with
and without the concurrent warp: regime ownership is independent of clock speed. Mid-process
wall-clock corrections (NTP steps ±) move sim time by exactly 0 (bitwise) — sim time is
mono-driven; the wall clock only seeds anchors and displays.

**D — Restart / reconnect.** Serialize emits exactly the COORDINATE_SYSTEM.md §4 field set
`{clockRevision, worldTimeTtSeconds, savedAtUtc, leapTableRevision, timeAdapterRevision}`.
Resume probe (5 s process life → serialize → 60 s civil downtime → fresh process, monotonic at
0): resumed worldTime is **bitwise equal to saved TT + downtime** (drift 0 s); downtime is
computed in integer wall-ms (label difference + leap-count difference) and converted to seconds
once. A negative civil jump (wall set backwards) is refused: downtime clamped to 0,
`clockRevision` incremented, no backwards motion (bitwise). A `leapTableRevision` mismatch
between saved state and the loaded table is flagged on resume; foreign schema/adapter revisions
are rejected. Offline coast preserves duration by construction (rate-1 downtime added).

**E — f64 precision of the tt scale.** ULP of the tt value at the 2026 epoch
(tt = 841 968 069.184 s): 1.1920928955078125e−7 s = 1.3797e−12 day — three orders inside the
1e-9 day cross-check bar, so the conversion scale itself leaves the measured agreement
untouched at current epochs.

**F — Provider time scales (material for Open item 2).** NAIF SPICE time requirements
[EXTERNAL — verified 2026-09-06, https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/time.html]:
TT − TAI is a defined constant 32.184 s; TDB − TT is periodic
(model TDB − TT = K·sin E, K = 1.657e−3 s, magnitude ≈ 1.66 ms, model accurate to ~30 µs);
SPICE ET = TDB, not TT. The same page states no negative leap second has occurred since 1972,
and its "UTC strings 69.184 s behind TDB as of 2020-12-01" is consistent with TAI−UTC = 37 s.

## Decision

1. **Adopt the ttClock module design** (spike-homed; re-homed 2026-09-06 into
   `client/src/engine/ttClock.ts` + `client/src/engine/leap-seconds.json` with the test suite at
   `tests/engine/ttClock.test.ts` — content unchanged): TT is f64 seconds since J2000 TT; conversions run in integer-ms civil arithmetic
   (`tt = (posixMs + (TAI−UTC)·1000 + 32184 − civilJ2000Ms) / 1000`; the inverse by exact
   interval lookup over the table); `Date`/`Date.UTC`/`Date.parse` are used **only** to produce
   and parse POSIX civil labels and to bridge the wall clock — `ttNow()` is documented as a
   wall-clock bridge, never a sim-time source. Within a process, simulation time flows only
   from an injectable monotonic source anchored once; `Date` never stores, carries or advances
   simulation time.
2. **The leap-second table is a versioned JSON committed to the repo** (`kwetu.leap-table/1`,
   revision `ierc-2026-09-06`), refreshed **at build time only, never at runtime**: fetch the
   IANA `leap-seconds.list` (IERS Bulletin C derived), diff its DTAI rows, bump
   `leapTableRevision`, commit, record the retrieval date. The file's expiry (currently
   2027-06-28) is the maintenance trigger. Measured and adopted policies: before-coverage
   instants are refused (no extrapolation); `:60` labels are rejected; TT instants inside an
   inserted second clamp to the last representable POSIX label; the schema's `type` field
   reserves a `'negative'` step the adapter rejects at load today (`validateLeapTable` accepts
   +1 steps only). Persisted state carries `leapTableRevision` so a resumed process detects a
   table change.
3. **One shared clock, isolated warps, instant-preserving handoffs.** Exactly one
   `UniverseClock` per universe, owned by the authoritative server, rate fixed at 1,
   monotonic-anchored, serializable in the COORDINATE_SYSTEM.md §4 field set; clients hold
   estimates they smooth and can never write authority time. Warp exists only as
   non-serializable `WarpClock` views (isolated training/test universes — measured zero
   divergence, serialize throws). The movement regimes (CONTACT_LOCAL / FLIGHT_DYNAMIC /
   ORBIT_COAST) all sample the shared instant at the same tick, so a regime handoff changes
   the integrator, never the instant — measured bitwise; handoffs consume `ttAtMono(tick)`,
   never a per-regime clock. The SOI handoff *algorithm* (geometry, patched conics, transition
   tolerances) remains a Phase-7 ADR and must build on this contract. NETWORKING.md snapshots
   carry `clockRevision`, tick and `worldTimeTtSeconds` per §4; reconnect receives a fresh
   mapping (schema-level statement — value budgets stay in ROADMAP §Budgets). Fictional rapid
   transit stays a separately labelled trajectory mode following shared time (ADR-001
   Decision 3) — out of this spike's measured scope.
4. **Ephemeris feeding enters at the TT boundary.** Every astronomy-engine call from Kwetu time
   uses `AstroTime.FromTerrestrialTime(tt/86400)`; TT values are never handed to the library as
   `Date`. Golden fixtures (S0.11/ADR-011) already pin this convention; the measured
   63.8–75.4 s ΔT trap and the 0.02626 deg feed-convention difference at the §12 site are the
   quantitative reasons.

## Consequences

Fills ROADMAP §Budgets **B-TIME-01** = 0 s (0 day) max conversion residual vs astronomy-engine
2.1.19, 7 samples 1995–2026 [MEASURED 2026-09-06, `tools/spikes/s0.7/report.json`] and
**B-TIME-02** = leap coverage 1972-01-01 (TAI−UTC 10 s) → 2017-01-01 (37 s), 28 rows, current
offset 37 s [MEASURED 2026-09-06, `validateLeapTable()`; source EXTERNAL — verified 2026-09-06,
https://data.iana.org/time-zones/data/leap-seconds.list]. (ROADMAP §5 S0.7 reads "fills Budgets
rows: none"; the orchestrator adds these two rows centrally with this ADR.)

Easier: Phase 3's world-state schema and Phase 5's reconnect mapping can be written against a
measured field set with an exact-resume guarantee; Phase 7's handoff ADR inherits an
instant-preserving tick contract; golden fixtures have a named, measured entry boundary
(`FromTerrestrialTime`).

Harder / locked out: any `Date`-carried simulation time is a defect (measured 63.8–75.4 s
misplacement class, 0.3153 deg GAST error if fed to the ephemeris); a wall-clock-only server is
a defect (negative-jump hazard — measured refusal path); warp views can never persist
(serialize throws); extrapolating leap counts outside table coverage is a defect. The build-time
refresh becomes a real maintenance obligation with a deadline (IANA expiry 2027-06-28); a table
refresh changes `leapTableRevision` and must surface through the measured flagged-mismatch path
in every resumed world.

The probe suite lives under the throwaway `tools/spikes/s0.7/` carve-out and is deleted when
this ADR's durable assertions are re-homed as golden tests (J2000 round-trip, 2017 boundary,
warp zero-divergence, resume continuation).

## Open items

1. **Negative-leap-second contingency.** No negative leap has ever been inserted
   [EXTERNAL — IANA file and NAIF page, verified 2026-09-06]; the schema reserves
   `type: 'negative'`, but the adapter rejects non-+1 steps at load, and a repeated
   `23:59:59` label cannot be expressed on the POSIX timeline at all. A clamp/refuse/custom-
   label policy must land before any Bulletin C announces one — owner: adapter maintainers;
   gate: any table refresh introducing a negative step.
2. **TT vs TDB for long-term ephemeris feeding.** astronomy-engine 2.1.19 is confirmed from
   source to be dual-scale (ut for Earth rotation, tt for nutation/ephemerides) with no TDB at
   all; its `tt` comes from the Espenak–Meeus ΔT model, not a leap table. Skyfield/de440s (the
   Phase-7 oracle) works in TDB/SPICE-ET. The TT−TDB difference is periodic ≈ 1.66 ms
   (model ~30 µs accurate) [EXTERNAL — NAIF, verified 2026-09-06] — far inside the current
   ±1 arcmin sky envelope, but COORDINATE_SYSTEM.md §4's rule stands: the Phase-7 ephemeris
   adapter converts TT↔TDB explicitly per provider; "TT ≈ TDB" may never be assumed silently
   in code.
3. **COORDINATE_SYSTEM.md §12 seed feed convention.** The committed §12 GAST seed
   (344.1180787594703 deg) corresponds to the date-feed convention; the TT-correct value at
   that instant is 344.09182320318416 deg (difference 0.02626 deg ≈ 6.3 s of Earth rotation at the sidereal rate 0.0041781 deg/s)
   [MEASURED 2026-09-06, tools/spikes/s0.7/report.json]. The doc is centrally owned — flag for
   its next revision rather than editing here; ADR-011's fixture convention
   (`FromTerrestrialTime`) is already the pinned one.
4. **Leap-table refresh tooling.** The refresh is a documented build-time process note
   (owner: Phase-1 build tooling); no CI check validates table freshness against the IANA
   expiry tonight.
