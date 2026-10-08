# Map-first redesign: changes, verification and release

Branch `map-first-redesign`, based on `main` at `9724a28` (what production runs). API protocol `fleet-ops-2`, Worker 1.2.0. No new D1 migration. **Not deployed.** Production still runs Pages `9724a28` with Worker 1.1.0 (`fleet-ops-1`) as of Oct 7, 23:10 ET.

## What changed

- **The Michigan map is the home page.** It shows both peninsulas with an OpenStreetMap basemap and observed radar on by default. The compact header holds the brand, station search, **Map / Trips / Records**, a **Needs attention** button with a count, and an account menu. The hero section, metric cards and the priority table are gone.
- **Station markers** show weather and health separately. The fill colour is the selected measurement (temperature, dew point, humidity, wind or rain). The shape and glyph show health: a ring means reporting, ◷ delayed, ▲ sensor missing, ✕ not reporting, and ? a QC flag to review. Every marker has a text title for screen readers. Flagged, stale or future-dated values are never drawn as weather.
- **The map is created once per session.** Position and zoom persist for the session, and variable, radar and opacity persist per device. Selection lives in the URL. **Michigan** resets the view. The map auto-fits only when no view has been saved, and it pans only when the selection changes.
- **Station panel.** On desktop it is a side panel; on phones, a bottom sheet. It shows:
  - name, ID, coordinates and elevation;
  - quality notes: not reporting since…, missing instrument groups, delayed, or a QC flag (described as "not a confirmed equipment fault");
  - each reading with units, its own observation time and age. Flagged or stale values are struck through and tagged;
  - the network fetch time;
  - **Add to trip**, issue details and the full station record;
  - a 24-hour history chart that leaves out QC-flagged points and marks where they were;
  - lazy-loaded folds for notes, issues and visits, and for sensors and nearby comparison.
- **Needs attention** replaces the priority cards, Daily review, Alerts and the queue table. It has three tabs:
  - **Problems** keeps the server's canonical order, grouped P1 groups out → P2 one station out → P3 multiple sensors → P4 one sensor. Suspected and confirmed are labelled.
  - **Quality checks** holds QC items, which are kept separate from failures.
  - **Recent changes** lists alerts, each with a "Seen" acknowledgement.
- **Trips** combines the planner and saved plans:
  - Add stations from the map. They keep your order until you choose **Optimize order**.
  - Road times are recalculated as you edit, with stale-response protection.
  - The summary shows Leave, Back (with "(next day)" when it crosses midnight), driving, visits, breaks and road miles. It comes first, followed by violations, P1/P2 work not in the trip, and the stops.
  - A saved trip view has navigation links, Field Notes, accept (an infeasible trip needs a recorded reason), completion, print, CSV/JSON export and offline save.
  - The multi-day comparison is still at `#/trips/compare`.
- **Records** holds Investigations, Field Notes, Stations, References (the anomaly report) and the reference tracker.
- **Release consistency.** The Pages build stamps every module import, the entry script and the stylesheet with `?v=<sha>`. It also gives the service worker one cache per release, so a browser can never mix two releases.

Supporting engine fixes on this branch:

- **Sensor-issue timing.** Onset and last-good times now come from the affected channel, not the station.
- **Partial settings.** Partial fleet settings no longer blank out defaults. Previously, a missing lag limit disabled stale-channel detection.
- **Trip stops.** Stations added deliberately to a trip are no longer dropped as "already planned"; a warning is shown instead.

## Navigation inventory

Nothing was deleted. Accounts, roles, records and access controls are unchanged, and every old deep link redirects (`web/lib/routes.mjs`, covered by `fleet-ui.test.mjs`).

| Before (sidebar) | Now |
|---|---|
| Overview `#/overview` | Map home `#/map` |
| Daily review `#/review` | Needs attention → Problems `#/attention` |
| Alerts `#/alerts` | Needs attention → Recent changes `#/attention/changes` |
| QC items (inside the overview) | Needs attention → Quality checks `#/attention/qc` |
| Anomaly report `#/anomalies` | Records → References `#/records/references` |
| Reference tracker `#/tracker` | Records → Tracker `#/records/tracker` |
| Stations `#/stations` | Header station search, and Records → Stations `#/records/stations` |
| Station page `#/station/<id>` | Station panel over the map. The full record is at `#/station/<id>/details` |
| Field-day planner `#/planner` | Trips → "Compare the next few days" `#/trips/compare` |
| Saved plans `#/plans`, `#/plan/<id>` | Trips `#/trips`, `#/trip/<id>` |
| Investigations `#/issues` | Records → Investigations `#/records/investigations` |
| Field Notes `#/visits` | Records → Field Notes `#/records/visits` |
| Bench testing `#/bench` | Account menu → Logger file inspector `#/tools/logger` |
| Connections `#/connections` | Account menu → Settings and connections `#/settings` |
| My account `#/account` | Account menu (same route) |
| Team access `#/team` | Account menu, owners only (same route) |
| Operations / Records export | Account menu |
| Incident `#/incident/<id>`, packet `#/packet/<id>` | Unchanged |

If a session expires, the deep link is kept, so signing back in returns to the same place.

## Map, basemap and radar

- **Basemap.** OpenStreetMap standard tiles (`tile.openstreetmap.org`), with attribution and a referrer header as the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) requires. This is fine for a small team tool, and nothing is prefetched in bulk.
  - If usage grows, move to a keyed provider or self-hosted tiles. That is a one-line change in `web/map.mjs` plus both CSPs.
  - CARTO tiles were rejected because they now return "API KEY REQUIRED".
  - Natural Earth outlines stay underneath as a fallback.
- **Radar.** NWS NEXRAD base-reflectivity composite (N0Q) from the Iowa Environmental Mesonet.
  - The frame list comes from `radar.py`. Each frame is one WMS-T image at the frame's exact valid time, drawn over the Great Lakes.
  - The loop is **observed frames only**: about 7 frames over the past hour, with play/pause and a frame-time label ("Latest · 10:55 PM", "Past · …"). Nothing is extrapolated or forecast.
  - The ⓘ details keep four times separate:
    - the frame valid time;
    - the image retrieval time;
    - when the frame list was last checked;
    - the station observation and network fetch times, shown in the station panel and the status chip.
  - If the frame list cannot be refreshed, the label says "not updating".
  - A radar failure only affects the radar control; stations keep working. This was verified by blocking the radar host.
  - The list refreshes every 5 minutes while the page is visible and the loop is paused.
- **Content Security Policy.** Both `web/index.html` and the edge Worker add `https://tile.openstreetmap.org` to `img-src` and `https://mesonet.agron.iastate.edu` to `connect-src`. The edge Worker must be deployed for production (see release step 3).

## Models

`web/lib/model-links.mjs` is an extension point. A station shows a **Models** section only when two things exist:

- a person has recorded its Enviroweather station ID (with `verifiedBy` and `verifiedAt`);
- an https destination has been added.

Both lists are empty, so no model links appear. The station mapping could not be verified: the Enviroweather API needs a token, and the legacy site needs access arranged through eweather@msu.edu. Names and coordinates are never used to guess.

## Routing verdict

**Real road routing has not been verified.** Every routed result seen so far is simulated.

| Evidence | Kind |
|---|---|
| Planner and trip-preview tests (`fleet-planner`, `fleet-api`) | **Simulated.** Synthetic matrices, labelled SYNTHETIC |
| `npm --prefix backend run dev:synthetic` harness | **Simulated.** Synthetic matrix; the UI draws a dashed red line and shows "Synthetic routing (test only)" |
| ORS adapter tests (matrix normalisation, canonical-order cache, reorder without a new call) | **Simulated.** Mocked HTTP |
| Live call to `api.openrouteservice.org` | **Real response, but an error.** 401 "Authorization field missing" with no key and 403 "Access to this API has been disallowed" with an invalid key. The adapter maps these to "not configured" and "credentials rejected" |
| Production secrets (names only, Oct 7) | Only `SYNOPTIC_TOKEN`. **No `ORS_API_KEY`** |

Without a key, a trip shows "Road times not calculated. Road routing is not set up yet. Settings and connections shows the server setup step for an administrator. … Nothing is estimated from straight-line distance."

- The stops stay in your order with visit times.
- Navigation links still open each leg in Google or Apple Maps. The links carry coordinates only; access notes and gate codes never enter URLs.
- A trip can be saved without road times, and it is stored as `routing.unavailable`.
- Arrival times are never described as traffic-aware, because OpenRouteService has no departure-time traffic model.

**To enable routing (the external blocker):**

1. Create a free Standard key at <https://account.heigit.org>.
2. From `backend/`, run `npx wrangler secret put ORS_API_KEY`. This creates a new Worker version with the secret.
3. Open Trips, add two stations and confirm three things:
   - the summary says "Road times from OpenRouteService, fetched …";
   - the line on the map is solid green;
   - **Optimize order** returns an order.

Until a real response with durations has been seen, treat routing as unverified.

## Verification

**Tests.** `npm run check` is clean and `npm test` passes 105/105. The new and changed tests cover:

- routes and redirects, reading semantics and health;
- release stamping, matrix permutation and the trip preview;
- stale-response handling;
- sensor onset timing, the partial-config defaults and the cross-midnight return label;
- model links.

**Browser.** Run in the in-app Chromium pane against a local Worker that holds a copy of production data (`backend/dev/wrangler.local.jsonc`, seeded by `backend/dev/seed-from-production.mjs`). All writes went to that local copy only. Checked:

- Desktop 1440×900 and phone 390×844.
- Sign-in and deep links through an expired session.
- Marker selection and search (keyboard).
- The station panel and phone sheet; a selected station pans clear of the panel, the sheet and the controls docked above it.
- The radar loop, the radar outage and "not updating".
- Needs attention tabs.
- Trips: add, reorder (order kept through save), the unrouted state, save, view, print content, offline save, accept with a recorded reason, completion and copy. Copy now starts a clean draft; before the fix it carried over the original's accept reason.
- Records tabs, account menu routes and legacy redirects.

**Screenshots.** In `docs/screenshots/`, all from the same production-data copy:

| Before (main `9724a28`) | After |
|---|---|
| `before-desktop.jpg` (1440×900) | `after-desktop.jpg`, `after-desktop-station.jpg` |
| `before-mobile.jpg` (390×844) | `after-mobile.jpg`, `after-mobile-station.jpg` |

**Not verified:**

- Production deployment.
- A live OpenRouteService route.
- The station history chart with real data (the local copy has no weather-data token, so it shows "Weather data connection is not configured").
- Service-worker install: the in-app browser refuses the registration fetch even though the page can fetch `/sw.js`. The stamped asset list was checked offline instead, and every precached file exists.
- iPad Safari, printing on paper, and teammate testing.

## Release steps

Do these in order from the repository root. Each step can be rolled back independently, and none touches existing records.

1. **Check the branch.** Run `git log --oneline origin/main..map-first-redesign`. Expect only this branch's commits; `main` is still `9724a28`. Then run `npm run check && npm test`.
2. **Back up D1 (recommended).** From `backend/`, run `npx wrangler d1 export enviroweather-fleet --remote --output <private path outside the repo>`. There is no migration in this release: `npx wrangler d1 migrations list enviroweather-fleet --remote` should show nothing pending (0005 is already applied).
3. **Deploy the edge CSP first.** Run `backend/node_modules/.bin/wrangler deploy --config edge/wrangler.jsonc`. It only adds allowed hosts, so the current page is unaffected.
   - Verify: `curl -sI https://atolldb.com/ | grep -i content-security-policy` shows `tile.openstreetmap.org` in `img-src` and `mesonet.agron.iastate.edu` in `connect-src`.
   - Without this step the new page has no basemap and the radar loop cannot list frames.
4. **Deploy the Worker.** Run `npm --prefix backend run deploy`. Verify that `curl -s https://enviroweather-fleet-api.polyswap.workers.dev/api/health` reports `"version":"1.2.0","protocol":"fleet-ops-2"`.
   - Until step 5 finishes, the old page shows its "Operations views are unavailable until matching frontend and API versions are deployed" notice. Records are safe. Go straight to step 5.
5. **Deploy the frontend.**
   1. Push the branch and open a PR to `main`.
   2. Merge it. Pages runs the syntax check and tests, stamps `?v=<sha>`, writes `release.json` and deploys, which takes a few minutes.
   3. Verify that `https://atolldb.com/release.json` shows the merge commit and that the account menu shows `Web <sha> · API 1.2.0` with no version banner.
6. **Routing (optional, external).** See "To enable routing" above.
7. **Smoke test in production:**
   - The map loads with tiles, markers and radar, and the status chip shows a fresh station-data time.
   - Needs attention matches the old queue order.
   - Open one station.
   - Open an old link such as `#/review`; it redirects.
   - Trips loads saved plans.

**Cache handling:**

- The edge Worker serves HTML and `sw.js` with `no-store`, so the next navigation always gets the new page.
- Every script and stylesheet URL carries `?v=<sha>`.
- The service worker is network-first, never caches `/api/`, uses the cache `enviroweather-fleet-<sha>` and deletes older `enviroweather-fleet-*` caches on activate.
- An already-open old page shows the version banner with a **Reload** button.
- New per-device keys:
  - `fleet-map-view` (session storage);
  - `fleet-map-prefs` and `fleet-map-legend`;
  - `fleet-trip-draft:<email>`.
- Sign-out clears trip drafts and offline packets. It never touches the Field Notes notebook.

**Rollback:**

- **Frontend.** Revert the merge commit on `main` and push. Pages rebuilds `9724a28`'s code.
- **Worker.** From `backend/`, run `npx wrangler rollback` to return to 1.1.0 / `fleet-ops-1`. Roll back the frontend and the Worker together; either one alone shows the version notice.
- **Edge CSP.** No rollback is needed, because the change is additive.
- **Data written by 1.2.0.** This means trips saved without road times and `acceptOverride` reasons. Both are extra fields on existing plan documents. The 1.1.0 views were not tested against trips that have no road times.
