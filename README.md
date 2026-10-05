# Enviroweather Fleet

Station diagnostics, investigations, bench analysis, and Field Notes at https://atolldb.com.

The website is hosted by GitHub Pages in `howwee20/baseplane`. The independent API is hosted in the owner's Cloudflare account at `https://enviroweather-fleet-api.polyswap.workers.dev`. Cloudflare D1 holds private team records and cached observations. No ChatGPT account, subscription, service, database, or backend is required to use the app.

## App workflow

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

## Development and deployment

```sh
npm run serve
npm --prefix backend ci
npm --prefix backend run dev
npm run fleet:test
```

Create a private `backend/.dev.vars` with `SYNOPTIC_TOKEN`, `BOOTSTRAP_TOKEN`, and optionally `MIGRATION_TOKEN` for local development. These files are ignored. The owner bootstrap requires both the secret and the configured OWNER_EMAIL; there can be only one owner. After initial setup, remove the bootstrap secret. Migration is disabled once its secret is removed.

Remote D1 uses the named `enviroweather-fleet` database in `backend/wrangler.jsonc`. Apply migrations explicitly with `wrangler d1 migrations apply enviroweather-fleet --remote`, set secrets through Wrangler, then `npm run fleet:deploy`. Keep `web/config.js` pointing at the verified API origin. Push web changes to main to deploy Pages through `.github/workflows/pages.yml`; the published artifact contains only `web/`. Existing atolldb.com GitHub DNS and HTTPS remain in use.

Passwords use salted scrypt (N=16384,r=8,p=5); sessions use random bearer tokens whose digests are stored in D1. Browser sessions are tab-scoped. Password changes and disabling users revoke sessions. Auth attempts are rate limited. Record updates use revision checks; stale edits receive a conflict response rather than replacing newer evidence.

The former Atoll project is retained in repository history and unserved legacy source. Its former platform landing page and studio are excluded from the Pages artifact. The previous site can be recovered from commit `516e905`.
