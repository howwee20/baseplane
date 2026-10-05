# Enviroweather Fleet

Station diagnostics, investigations, bench analysis, and Field Notes at https://atolldb.com.

The website is hosted by GitHub Pages in `howwee20/baseplane`. The independent API is hosted in the owner's Cloudflare account at `https://enviroweather-fleet-api.polyswap.workers.dev`. Cloudflare D1 holds private team records and cached observations. No ChatGPT account, subscription, service, database, or backend is required to use the app.

## App workflow

Navigation is grouped into Workspace, Analysis, Records and Account. Anomaly report and Reference tracker keep their primary filters visible, with provisional reference controls under Reference settings. The October 5 UI polish was implemented by Claude Fable 5.1 and reviewed in the browser; it changes presentation and copy while retaining data, auth and evidence workflows.

The subsequent copy cleanup removes capability slogans, duplicate page descriptions and general advice banners. Rows show compact reading age and QC information. Reading rules, radar details and storage guidance are available in disclosures; source times, missing data and actionable errors stay visible.

Sign in with your Fleet email/password. The owner creates invitation links in Team access; invitations work only for the selected email and last seven days. Editors can create and update records, viewers can read and export. Disable access to revoke a member's existing sessions. My account changes passwords and signs out all devices.

Review the network, inspect a station, compare nearby stations, and save investigation evidence. Extended diagnostics loads derived precipitation, window statistics calculated from loaded history, and QC segments for the selected 24/72/168-hour window. An investigation retains fixed observations, source timestamps, flags, and any extended products already loaded at capture time. Prepare field visit reviews a plan before creating a local notebook visit; it never fills field readings or checks performed work.

Field Notes saves locally and can work offline after an initial successful load. Publish to team shares completed visit text. Photos remain local, and existing visit PDFs are shared in Teams. Export notebook backups to retain photo bytes separately. Browser notes use IndexedDB; clearing website data removes that local notebook. The separately installed iPad app retains its own native SQLite notebook and is not modified by this deployment.

## Connections

- Synoptic MSU account: metadata, latest, time series, advanced QC flags/segments, derived precipitation, window statistics calculated from loaded history. The separate Synoptic Statistics API is not included in the current account. One concurrent upstream request, serialized by D1 leases. Network snapshots refresh every 15 minutes; history/products cache for ten minutes.
- Michigan radar: NWS imagery via Iowa Environmental Mesonet, separate from historical evidence.
- Teams Field Notes channel is linked. Automatic Graph uploads are not configured.
- Flyspray Ticket Tracker: account activation and a supported API connection remain required.
- Campbell website login does not establish LoggerNet, direct logger, or internal MSU API access. File imports remain supported.

All readings and QC are investigation evidence rather than hardware certification. Empty data is not assumed zero. API credentials stay in backend secrets and are never shipped to browsers or the Pages artifact.

## Privacy and review

The public website serves the sign-in page, application code, blank forms, map outlines, and a clearly synthetic logger fixture. Network data, raw QC, maintenance notes, completed shared visits, handoffs, and exports all require an active Fleet session. There is no anonymous maintenance dashboard. D1 is accessed only through the Worker; it has no browser database connection. Provider credentials remain Wrangler secrets. Sessions expire after seven days and API responses use `Cache-Control: no-store`.

`npm run fleet:test` exercises anonymous access to every private route, invalid sessions, viewer restrictions, editor access restrictions, invitation roles, revocation, stale or missing record revisions, immutable evidence, large records, upstream failures, incomplete refreshes, and public asset exclusions. A failed refresh preserves the prior observations and their original fetch time. Unexpected upstream errors never become public error details. The deployment workflow runs the checks for frontend and backend changes before publishing Pages. Deploy Worker changes separately with Wrangler.

See [the team review guide](docs/team-review.md) for a repeatable review with synthetic records. Automated checks and a successful browser login are recorded evidence; they are not a substitute for a teammate's acceptance test or physical station validation.

The repository is public. A maintenance-example payload was removed from the current frontend and main-branch history on October 5, 2026; old build runs containing it were deleted. A private Git bundle preserves the original history for recovery. A request to remove the retained old commit copies has been submitted to GitHub Support; removal is pending their review. No provider secret was found in the tracked files. Avoid adding real station cases, exports, photos, or credentials to source control.

## Development and deployment

```sh
npm run serve
npm --prefix backend ci
npm --prefix backend run dev
npm run fleet:test
```

Create a private `backend/.dev.vars` with `SYNOPTIC_TOKEN`, `BOOTSTRAP_TOKEN` for local development. These files are ignored. The owner bootstrap requires both the secret and the configured OWNER_EMAIL; there can be only one owner. After initial setup, remove the bootstrap secret. The one-time migration endpoint is retired.

Remote D1 uses the named `enviroweather-fleet` database in `backend/wrangler.jsonc`. From `backend/`, apply migrations explicitly with `npx wrangler d1 migrations apply enviroweather-fleet --remote`, set secrets through Wrangler, then `npm run fleet:deploy`. Keep `web/config.js` pointing at the verified API origin. Push web changes to main to deploy Pages through `.github/workflows/pages.yml`; the published artifact contains only `web/`. Existing atolldb.com GitHub DNS and HTTPS remain in use.

For a different account, run Wrangler from `backend/`. Create a D1 database with `npx wrangler d1 create enviroweather-fleet`, update the account/database IDs, `OWNER_EMAIL`, allowed frontend origins, and `web/config.js`, then apply migrations and set secrets. Do not copy another environment's database IDs or owner credentials. Set an unpredictable bootstrap secret with `npx wrangler secret put BOOTSTRAP_TOKEN`, create the first owner using the same secret and the configured email, and delete it with `npx wrangler secret delete BOOTSTRAP_TOKEN`. A missing bootstrap secret does not enable setup. Do not provision a migration secret: the import endpoint is retired.

Use the signed-in Export action to back up shared records and evidence. Save Field Notes notebook backups separately to retain local photo bytes. Keep backups outside the repository. An older frontend commit can be deployed again through Pages, and Cloudflare retains Worker deployment versions for rollback. Frontend rollback does not restore a deleted browser notebook or undo database edits.

Passwords use salted scrypt (N=16384,r=8,p=5); sessions use random bearer tokens whose digests are stored in D1. Browser sessions are tab-scoped. Password changes and disabling users revoke sessions. Auth attempts are rate limited. Record updates use revision checks; stale edits receive a conflict response rather than replacing newer evidence.

The former Atoll database platform is archived in a private Git bundle and repository history. Its executable source, Studio, generators and development services have been removed from the current tree. The Vercel entry point returns HTTP 410 and does not connect to a database.

## Anomaly report and reference tracker

Anomaly report screens the latest primary air temperature, relative humidity, wind speed, solar radiation and preceding-hour precipitation against nearby stations. Reference tracker loads 24/72/168-hour histories sequentially using the same server-side Synoptic connection. Reference sites are at least 500 m apart from each other and the target so co-located instruments are not counted as independent sites. Both require sign-in. Settings select a 25/50/100/150-km radius, at least 2/3/4 references, a tolerance scale, and maximum latest-reading age (default 90 minutes). Source observation times remain visible; this age setting does not change the existing delayed/stale station thresholds. Downloads retain the settings, source times, observations and reference membership.

Default tolerance floors are 3 °C, 20 percentage points, 3 m/s, 200 W/m², and 5 mm for reported preceding-hour precipitation. These are provisional review thresholds, not manufacturer specifications or MSU-approved calibration criteria. The reference band uses the greater of the floor or 3 × 1.4826 × the median absolute deviation from the nearby median. Unsupported or missing units, QC flags, old latest readings and insufficient neighbors remain unavailable or excluded.

The tracker compares station and neighbor changes about an hour apart while holding reference membership fixed. It distinguishes shared changes, isolated changes and offsets, but applies no elevation/terrain correction and does not infer historical weather from live radar. The latest-reading age limit is disclosed separately from historical coverage, and old latest observations do not erase the selected history. An outside-range reading is a request for review, not a confirmed fault. Persistent-difference screening requires six outside-range readings and at least half of evaluated observations; coverage is shown separately.

Security repair deployment (October 5, 2026): credentials and sessions use a generation counter; password rotation and member disabling revoke stale credentials. Sign-in has an IP budget and shared hashing admission. Uploads are limited while streaming. Shared visits use a bounded server schema and publication revisions; local notebook text remains readable. Workspace exports paginate and signed-out clients abort pending private requests.

Apply all backend D1 migrations before deploying the Worker. Migration 0004 preserves any incompatible historical visit identities as `legacy-visit` documents outside active lists and exports; recover these from a private D1 export if needed. The retired token-only migration endpoint returns 410. Bootstrap and migration secrets are absent from production.

`edge/` adds HTTP browser security headers in front of the GitHub Pages origin. Deploy it with `backend/node_modules/.bin/wrangler deploy --config edge/wrangler.jsonc`. The Cloudflare zone preserves the GitHub Pages A records, www CNAME, and email records. The old Vercel Control API is paused and requires team authentication on every deployment; resume only after a fresh security review.
