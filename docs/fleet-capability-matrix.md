# Enviroweather Fleet — observed capability and gap matrix

Observed October 7, 2026 before the fleet-operations work began. Sources: the local checkout at `ca7f019`, `npm run check`, `npm run fleet:test` (69/69 passing), the public site, the public API, `wrangler deployments list`, `wrangler d1 migrations list --remote`, read-only D1 queries, and GitHub Actions history. No private station data is recorded here.

## Deployment baseline

| Component | Observed | Notes |
| --- | --- | --- |
| Pages frontend | Commit `799b3d6` (Last-Modified Oct 5 16:59 UTC) | The two later Pages runs did not publish. `48759d7` built on Ubuntu, then its deploy job hung and was cancelled. `ca7f019` moved to `macos-15` runners and no runner picked up the job within 15 minutes. That is why public `app.js`, `auth.mjs`, `index.html`, `sw.js` and `reports.mjs` differ from the source while `lib/reference.mjs`, `config.js` and `field-plan.mjs` match. |
| API Worker | Version `f61c6649` deployed Oct 5 19:26 UTC (matches `48759d7`) | `/api/migration` returns 410 and `/api/state` returns 401 anonymously, as the security commit requires. `/health` reports `1.0.0` without a release identifier. |
| Frontend/backend compatibility | Mixed | The live frontend predates paginated exports and visit publication revisions. Exports above 50 shared records, and republishing an already-shared visit, will not work until the current frontend is published. |
| D1 | All four migrations applied; scheduled refresh writing `cache:latest` every 15 minutes | No saved `settings` document exists, so the code defaults apply: network 120, delayed 60 min, stale 180 min. |
| Edge Worker | Adds CSP/HSTS/no-store for HTML and `sw.js` | GitHub Pages serves JS with `max-age=14400`; the service worker is network-first with versioned query strings. |

## Fleet inventory (from the current cached snapshot)

- 104 stations in network 120: 99 `ACTIVE`, 5 `INACTIVE`. The count is discovered at runtime and is not hardcoded.
- Nearest active neighbor: median 15 km, 90th percentile 36 km, maximum 98 km. Third-nearest: median 24 km, 90th percentile 58 km. Two co-located pairs are under 500 m apart.
- Cadence is mixed. Wind, solar, soil, voltage and hourly precipitation report hourly. At many stations, air temperature, RH and 5-minute precipitation report every 5–30 minutes. A 15-minute poll of hourly data cannot detect an outage faster than roughly one reporting cycle plus the persistence rule.
- Metadata lists channels that have never reported (`PERIOD_OF_RECORD` start and end both null; for example a second wind set at −0.1 m or extra soil depths). These must not be treated as expected sensors.
- Three channels have a last report more than 30 days before their station's other channels. These are treated as dormant at bootstrap, need team confirmation, and are not silently retired.

## Capability / gap matrix

| Area | Existing capability | Gap against the brief |
| --- | --- | --- |
| Station freshness | `assess()` uses the newest numeric non-derived observation | One fresh channel hides missing channels. There are no expected-sensor profiles, per-channel lag, physical-sensor grouping, or hysteresis. |
| Prioritisation | Overview sorts by age; Daily review sorts by status rank | Two different orderings, and no P1–P4 tiers, group outages, tie-breakers or recorded reasons. |
| Incidents | Investigations (one open per station) with append-only evidence | No incident identity, lifecycle, acknowledgement, assignee, grouping, merge/split, recovery tracking or alerts. |
| Feed health | A failed refresh keeps prior data and records `refresh-error` | A partial or empty-but-successful response is accepted as complete. There is no mass-outage guard and no feed incident. |
| References | Latest-snapshot anomaly report and 24/72/168-hour tracker (500 m independence, median/MAD, fixed membership) | No per-station, per-variable coverage summary, height/depth/elevation checks, circular wind direction, pin/exclude audit, daylight-aware solar or flatline screening. |
| Maintenance work | Investigations plus the Field Notes handoff (`?case=`) | No work items, templates, parts/skills/duration estimates, or separation of work done from recovery. |
| Forecasts | Live radar imagery only | No NWS hourly/grid forecast, no alerts, no task-weather evaluation. |
| Routing / planning | None (Leaflet display only) | No road-routing provider is configured; the only Worker secret is `SYNOPTIC_TOKEN`. No planner, itinerary, navigation links or saved plans. |
| Team | Owner/editor/viewer roles, invitations, revocation, revision conflicts | New endpoints must inherit these checks. |
| Offline | Field Notes IndexedDB notebook; service worker caches public assets only | No deliberate offline field packet. |
| External systems | Teams link, Flyspray link, Campbell link | Teams uploads, Flyspray sync, internal MSU APIs, LoggerNet and direct logger access remain unconnected. |
