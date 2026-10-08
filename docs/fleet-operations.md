# Fleet operations: rules, setup and release

This guide covers station health, incidents, priority, references, maintenance work and the field-day planner (API protocol `fleet-ops-2`, Worker 1.2.0). The map-first interface, its navigation map from old to new routes, the routing verdict and the 1.2.0 release steps are in [map-first-redesign.md](map-first-redesign.md). Synoptic stays the upstream observation provider. Fleet replaces the Synoptic *interface* for daily monitoring; it does not remove the data dependency.

## Daily workflow

1. The **map** (`#/map`) is the home page: every station with the chosen measurement as fill colour and its health as shape and glyph, observed radar, and the time of the latest station data. Select a marker or search for a station to open its panel: latest valid readings with their own times, quality notes, a 24-hour chart, *Add to trip*, and folds for notes, issues, visits, sensors and nearby comparison.
2. **Needs attention** (header button, `#/attention`) answers what is down and what comes first: the canonical queue grouped P1 → P4 with suspected and confirmed labelled, a separate *Quality checks* tab, and *Recent changes* (alerts) with acknowledgement.
3. An **incident** (`#/incident/<id>`) shows why it has that priority, the onset window, evidence and timeline. Editors can acknowledge, assign, change state, override urgency or defer (both need a recorded reason), add notes, merge or split groups, and create work items.
4. The full **station record** (`#/station/<id>/details`) shows expected versus reporting channels, reference coverage per variable, incidents, maintenance history and access notes.
5. **Trips** (`#/trips`): add stations from the map, keep your order or choose *Optimize order*, and save. A saved trip (`#/trip/<id>`) supports accept (an infeasible trip needs a recorded reason), completion, cancel, copy, JSON/CSV export, print, deliberate offline saving, navigation links and Field Notes. The multi-day comparison is at `#/trips/compare`.
6. A **work item**'s *Start Field Notes* opens the existing visit-plan review (`/field-notes/?work=<id>`). Readings and completion boxes stay empty. Record the work performed on the work item; the incident resolves only when telemetry recovers.
7. **Records** holds investigations, Field Notes, stations, the reference (anomaly) report and the reference tracker. Account, team access, settings and connections, the logger file inspector and exports are in the account menu.

## Priority (canonical, `priority-v1`)

| Tier | Meaning |
| --- | --- |
| P1 | A group of stations is out |
| P2 | One station is completely out |
| P3 | A reporting station has multiple expected instrument groups missing or stale |
| P4 | A reporting station has one expected instrument group missing or stale |
| QC | Unconfirmed QC or reference anomaly (review) |
| PM | Scheduled maintenance |

The sort key is a lexicographic tuple, never a blended score:

1. Tier (a human override with a recorded reason wins).
2. Confirmed before suspected.
3. Longer since the last good report.
4. More affected stations.
5. More affected instrument groups.
6. Higher team-set importance (0–3).
7. Weaker reference coverage.
8. A ready work item.
9. Incident ID.

Group members are nested under their group, and each count includes every station exactly once. The same `buildQueue`/`comparePriority` code drives Needs attention, exports, alerts and trip planning.

Provisional response deadlines (owner-editable; not adopted policy): P1 24 h, P2 48 h, P3 7 d, P4 14 d.

## Health model

Health has three independent dimensions.

**Data service.** Each ingest is classified before any station is judged:

- *complete*;
- *partial*: an active station is missing from the response, or metadata lost more than 20% of stations;
- *degraded*: fewer than 50% of active stations have data newer than the stale threshold, or the newest observation network-wide is stale;
- *failed*: the provider returned an error.

A non-complete ingest opens one **feed incident** and holds every absence-based counter. Fresh data still counts as recovery evidence. An empty "successful" response never overwrites the last good observations. Stations missing from a partial response are carried forward and labelled.

**Station reporting** is judged from *expected* channels only:

- *reporting*: newest data within the delayed threshold (60 min);
- *delayed*: older than 60 min but within the stale threshold;
- *outage candidate*: no expected channel newer than the stale threshold (180 min);
- *no data*, *not in response*, *clock ahead*, *inactive*, or *planned maintenance* (from station notes).

**Channel health:**

- **Missing or stale** means absent, a null value (null is never zero), or more than `max(90, cadence + 30)` minutes behind the station's newest channel. This compares 5-minute and hourly channels fairly.
- **QC flag** is review evidence, not a fault.
- **Future-dated** observations are excluded from freshness.
- **Possible rename** applies when a new channel at the same variable and height started reporting.
- **Silent** applies to every channel when the whole station is out.

Zero rain, calm wind and night-time zero solar are valid.

**Physical instruments** are grouped provisionally by family and height:

- wind speed, gust and direction;
- temperature and RH;
- rain gauge;
- pyranometer;
- soil probe by depth;
- logger voltage.

Tiers count groups, so a dead wind instrument is P4, not P3. Team edits can confirm the grouping.

## Expected-sensor profiles (`profiles-v1`)

Profiles are bootstrapped from Synoptic metadata periods of record and observed coverage:

- **No period of record** → *never-reported*.
- **Last report more than 30 days before the station's other channels** → *dormant*, awaiting team confirmation.
- **Reporting for more than 24 h** → *expected*.
- **New or unlisted channels** → *provisional* until 24 h of coverage.

A channel that was expected **stays expected when it disappears**, so the loss remains detectable. Team edits (expected, optional, seasonal months, removed date, installation date, cadence, group) need a reason, are revision-checked, and are recorded on any open incident. Inference never overwrites them.

Rehearsal on the October 7 production snapshot: 1,414 channels, of which 1,335 were expected, 9 provisional and 70 never-reported.

## Incident engine (`fleet-engine-v1`)

- **Persistence.** Counters advance only on a *new* successful ingest. Re-processing the same ingest is a no-op; the per-station `lastIngestId`, the `ingests.assessed_at` marker and an assessment lease guard against duplicate jobs.
- **Outages.** A station outage is *suspected* on first absence and *confirmed* after 2 consecutive new snapshots without data.
- **Sensor issues** confirm after 2 snapshots.
- **Recovery** needs 2 consecutive reporting snapshots, then the incident resolves as `telemetry-recovered`. An unconfirmed suspicion clears immediately.
- **Identity.** There is one open incident per station. It escalates from sensor issue to outage and de-escalates in place. An issue that recurs within 24 h reopens the same incident.
- **Manual resolution** needs a reason. If the issue is still observed at the next ingest, the incident reopens with the note "still observed after manual resolution".
- **Onset** is reported as a window, from the last good observation to the first snapshot without data. Age is never reset on refresh.
- **Workflow states:**
  - new
  - acknowledged
  - investigating
  - planned
  - in progress
  - awaiting parts
  - awaiting access
  - monitoring recovery
  - resolved

  Acknowledgement is not resolution. Completing work does not resolve an incident.
- **Writes.** Engine writes run in one transaction with a combined revision guard; a teammate's concurrent edit causes a clean retry. Human edits change only human-owned fields and need the current revision (409 otherwise). Routine evidence refreshes do not bump the revision.
- **Cloudflare limits.** D1 counts every statement in a batch toward the per-invocation limit (1,000 on Workers Paid, 50 on Free). Profiles (about 640 KB for the October fleet) and per-station hysteresis state (about 40 KB) are each one JSON row in `fleet_blobs`. Incidents, events and alerts use multi-row upserts and inserts, and unchanged metadata is not rewritten. A refresh plus assessment of a 104-station network measured 40–43 statements (enforced by `fleet-api.test.mjs`). CPU per assessment has not been measured on Cloudflare. Workers Paid is recommended because the Free plan's 10 ms CPU limit is likely too small; check with `wrangler tail` after deploying.

### Grouping (P1)

Fully non-reporting active stations link when they are within **40 km** and their onsets are within **180 min**. A group can never span more than **100 km** (complete linkage) or **180 min** of onset. Team-recorded shared dependencies or regions (station notes) can link or separate stations.

Rationale: the median nearest active neighbour is 15 km and the 90th percentile is 36 km. Most channels report hourly and are polled every 15 minutes.

- A group never implies a shared cause.
- Groups keep their identity across ingests. Merge and split are audited; split stations opt out of automatic regrouping.
- A group with fewer than two members still out moves to *partial recovery*, and the remaining station is tracked as P2 without a new alert.

### Alerts

Alerts are in-app only. They fire on transitions:

- newly confirmed;
- escalation;
- group created or expanded;
- recovery;
- feed problem or recovery.

Rules:

- Group members alert through their group.
- Nothing alerts from a degraded snapshot.
- Each alert has a unique dedupe key, and at most 12 alerts are emitted per ingest (the rest are summarised).
- Acknowledging an alert does not acknowledge the incident.
- Email, Teams and push delivery are **not configured**.

### Detection latency

Detection is suspected after about 180 minutes of silence and confirmed about 30 minutes later (15-minute polling). Expect P2 detection roughly 3–4 hours after the last report. This is not instantaneous monitoring.

## Nearby references (`coverage-v1`)

Coverage is computed for every active station and variable: air temperature, RH, wind speed, wind direction, solar, hourly rain and soil temperature by depth. The existing protections are kept:

- independent sites at least 500 m apart;
- matching units;
- QC exclusion;
- ±5-minute alignment;
- band = max(provisional floor, 3 × 1.4826 × MAD);
- fixed membership in the tracker.

Added rules:

- Sensor height must match (1.5 m is not compared with 10 m).
- Soil depth must match exactly; unknown depths are excluded.
- Wind direction uses a circular mean and angular residual, and calm wind (< 1 m/s) is excluded.
- Solar is not compared at night.
- Rain is compared only with the same accumulation interval.
- Elevation differences over 150 m produce a warning.

Every excluded reference shows a reason. Pin and exclude overrides need a reason, are audited and removable, and pinned references outside the radius produce a warning.

A silent target still lists its references, but no residual is computed. Neighbour values never replace target observations, and insufficient coverage stays *insufficient*. Flatline screening is variable-aware and produces suspicion only; zero rain never flatlines.

## Maintenance work (`work-v1`)

Templates:

- remote investigation;
- communications/power;
- sensor inspection;
- tower sensor inspection;
- vegetation/obstruction;
- scheduled service.

Template tasks are *proposed* until confirmed. Durations carry an estimate basis: entered, template default, or unknown. Parts, tools, skills, access windows, prerequisites and recovery criteria are stored.

*Done* requires a written record of the work actually performed. Completion never resolves the incident. The Field Notes handoff reuses the `enviroweather-field-handoff` v1 schema, so existing visits and imports stay compatible.

## Forecasts (NWS, `forecast-v1`)

Forecasts come from the server side: `/points` (cached 7 days), `/gridpoints` (trimmed and cached 1 hour) and `/alerts/active?area=MI` (cached 5 minutes). The User-Agent is `NWS_USER_AGENT` or `(atolldb.com, Enviroweather Fleet)`. Fetches are restricted to `api.weather.gov`, and grid IDs are validated.

Weather is evaluated over each stop's **whole on-site interval**: rain chance, rain amount (prorated), wind, gust, temperature, thunder probability and wording, daylight (computed sunrise/sunset agrees with NWS within about 1 minute), and NWS alerts matched by forecast-zone and county codes.

Default task-weather thresholds per class are **provisional**:

| Class | Max rain chance | Max gust | Max wind | Temperature range | Max thunder | Daylight |
| --- | --- | --- | --- | --- | --- | --- |
| Electronics | 40% | 15.6 m/s | 11 m/s | −15 to 35 °C | 10% | required |
| Exposed / climbing | 30% | 11.2 m/s | 8.9 m/s | −10 to 32 °C | 5% | required |
| Inspection | 70% | 20 m/s | 15 m/s | −20 to 38 °C | 20% | not required |

Provisional rules only produce cautions. The owner can mark a class *adopted*, which makes its rules hard constraints. Missing fields are *unknown*: rain amounts reach only about 3 days ahead, and gusts can be missing. A stale forecast is never reported as "within limits". Generic forecasts cannot certify lightning absence or field safety.

## Road routing (OpenRouteService, `routing-v1`)

- **Provider.** `POST /v2/matrix/driving-car` (directed durations and distances; `null` means unroutable) and `/v2/directions/driving-car/geojson` for the route line. Both are behind `backend/providers/routing.mjs`.
- **Bounds.** At most 40 points per matrix. Cached 24 h in canonical point order, so reordering or removing stops reuses the cached matrix instead of calling the provider again. Day comparison and saving are limited to 60 requests per user per hour; the live trip preview (`POST /ops/plans/preview`) to 240.
- **No substitutes.** Without a provider matrix a trip is returned as *road times not calculated*: stops keep their order and visit times, nothing is estimated from straight-line distance, and no road line is drawn. Synthetic fixtures are labelled SYNTHETIC and drawn as a dashed red line.
- **Limitations.** There is no departure-time traffic model, and this is disclosed in the UI. Station coordinates are routed unless a road entrance is recorded; the final access walk is marked unknown.
- **Attribution:** © openrouteservice by HeiGIT · Data from OpenStreetMap contributors (results CC-BY-SA 4.0).
- **Why not Google Routes.** Google Maps Platform Service Specific Terms §19.2 forbid using Routes content with a non-Google map (this app uses Leaflet), and the general terms do not permit caching durations, which saved plans require.

**Setup still needed:** no routing credential is configured in production (Oct 7: the only Worker secret is `SYNOPTIC_TOKEN`), so trips show road times as not calculated until one is. A live road route has not yet been verified.

1. Create an OpenRouteService key at <https://account.heigit.org> (Standard plan, free: about 500 matrix and 2,000 directions requests per day, 40 per minute; verify current numbers there). MSU may qualify for the Collaborative plan.
2. From `backend/`, run `npx wrangler secret put ORS_API_KEY`.

No purchase is involved.

## Planner (`planner-v1`)

The planner never claims optimality.

1. **Candidates.** Open incidents, QC items and maintenance work in the included tiers, plus required stations. Region filter, excluded stations and deferrals are applied. Great-circle distance is used **only** to drop stations beyond a one-day round trip (labelled "not a driving estimate"). At most 38 candidates go to the matrix.
2. **Insertion.** Stops are inserted in canonical priority order (required stops first). A stop goes where it adds the least time while all hard constraints hold: road reachability, access windows, the return deadline, workday length, crew skills and adopted weather rules. A lower-tier stop is rejected if it would delay any higher-tier arrival by more than 30 minutes (configurable).
3. **Improvement.** Bounded relocate and 2-opt passes (300 iterations) are accepted only if the plan stays feasible, gets faster (or has fewer weather cautions), and keeps P1/P2 arrivals within tolerance.
4. **Breaks and buffers.** A lunch break (11:30–13:30, 30 min) and a 10-minute buffer per stop are defaults, not policy.
5. **Exclusions.** Every exclusion has a code and an exact reason. Urgent exclusions are surfaced as priority exceptions and can be given a recorded deferral reason.
6. **Day comparison.** Days within forecast coverage are compared. The recommendation is the **earliest day that reaches the most urgent work**. Better-weather and most-stops alternatives state the consequence of waiting. If no day is feasible, the planner lists blocker counts and the decisions needed.
7. **Saving.** A saved plan is re-verified server-side with a fresh matrix and forecasts, and stores snapshots of the incident tiers, forecast issue times and routing fetch time.
8. **Accepted plans.** An accepted plan is never rewritten. It is marked outdated when a new confirmed P1/P2 incident appears, a planned incident closes or escalates, a cached forecast is newer, or the plan date passes.
9. **Duplicate work.** Stations in another accepted plan are excluded unless deliberately included.

**Navigation links** carry coordinates only. Google links hold at most three intermediate stops (the mobile limit); Apple Maps links are one leg each. Access notes and gate codes never enter URLs.

**Offline packets** are deliberate, per-device and read/print only. They never hold gate codes, carry their saved-at time, and are removed on sign-out. The Field Notes notebook is never touched by sign-out.

## Security

- Every `/ops/*` route requires a session. Viewers are read-only (the global check comes before the routes), and fleet policy settings are owner-only.
- Gate codes are hidden from viewers and kept out of exports, links and packets.
- Provider credentials stay server-side.
- Request bodies are limited during streaming. Coordinates, station IDs, dates, cursors and grid IDs are validated, and provider hosts are fixed.
- CSV exports escape formula prefixes.
- The service worker caches no API response; `release.test.mjs` asserts this.

## Release and rollback

The 1.2.0 release (map-first interface, `fleet-ops-2`) has exact, ordered steps in [map-first-redesign.md](map-first-redesign.md#release-steps): back up D1 (no migration), deploy the edge CSP, deploy the Worker, merge to `main` for Pages, then optionally add the routing key. Production on Oct 7 runs Pages and Worker release `9724a28` (Worker 1.1.0, `fleet-ops-1`).

Rollback:

- **Worker:** `npx wrangler rollback` (or choose the previous version in the dashboard).
- **Frontend:** revert the merge on `main`. A frontend that meets a different API protocol shows a version notice rather than breaking.
- Migrations are additive. If you must remove one, restore from a backup instead of dropping tables by hand.
- Frontend rollback does not restore browser notebooks or undo database edits.

## Local synthetic review

```bash
npm --prefix backend run dev:synthetic
```

`backend/dev/` serves 30 invented `TST` stations and a **synthetic** road matrix (labelled "SYNTHETIC routing fixture" in every plan). NWS forecasts are live. The dev Worker uses a local D1 database. Put a `BOOTSTRAP_TOKEN` in `backend/dev/.dev.vars` (gitignored), create the dev owner with `/api/auth/register`, then run `npm run serve`. The production config cannot load the dev worker; `release.test.mjs` enforces this.

## Tests and evidence

`npm run check` and `npm run fleet:test` run 105 tests: the original 69 plus engine, planner, coverage, API, release and interface-logic tests. All provider data in tests is synthetic. Acceptance criteria 1–16 are covered by automated tests. Criterion 17 was walked through in a browser against the synthetic dev stack: sign in, overview, map sync, group expansion, acknowledge and assign, create work, plan options, save, accept, offline packet, Field Notes handoff and visit creation, recording work done, and a tablet width with no horizontal page overflow.

**Not yet performed:**

- Production deployment.
- A live OpenRouteService call (no key exists).
- A real multi-station outage.
- Teammate acceptance testing.
- Physical station validation.
- Printing on paper.
- iPad Safari.
- NWS alerts during an active warning (none were active on Oct 7).

## Team pilot checklist

Run Fleet alongside the current Synoptic workflow for two to four weeks.

1. Each morning, compare Fleet's P1–P4 queue with what Synoptic shows. Log any station Fleet missed or wrongly flagged, with the time and the incident link.
2. Review and confirm sensor profiles for each station (removed, seasonal and optional channels). Confirm or correct the provisional instrument groups.
3. Record access notes, road entrances and access windows for stations the team visits.
4. Decide the policies Fleet cannot infer: response deadlines, task-weather rules to adopt, team base locations, crew skills, and confirmation counts.
5. Configure OpenRouteService and plan one real field day. Compare predicted and actual drive and on-site times.
6. Use the viewer, editor and owner roles once each. Confirm that viewers cannot edit and cannot see gate codes.
7. Exercise an outage end to end: acknowledge → work item → Field Notes → work recorded → telemetry recovery resolves the incident.
8. Keep Synoptic access throughout. Do not treat Fleet as the sole interface until the team has done its critical workflows in it and understands the upstream dependence, the 3–4 hour detection latency and the offline limits.
