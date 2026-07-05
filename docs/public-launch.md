# Atoll Public Launch

This runbook takes Atoll from GitHub Pages preview to:

```txt
https://atolldb.com
https://www.atolldb.com
https://api.atolldb.com
```

The static Studio can go live first. The hosted Control API makes sign-in, deploy, rows, server-side protection, and audit usable by people outside this machine.

## Current Shape

```txt
Atoll Studio
  static files from this repo
  graph UI, rows UI, access UI, deploy preview

Atoll Control API
  Node server in runtime/control-api/server.js
  local JSON fallback for development
  Postgres persistence when CONTROL_DATABASE_URL is set

Baseplane engine
  internal graph format
  baseplane.json
  compiler, policies, generated artifacts
```

## 1. GitHub Pages Custom Domain

Set the custom domain in GitHub Pages settings before changing DNS.

```txt
Repo: howwee20/baseplane
Settings
Pages
Custom domain
atolldb.com
Save
```

This repo uses GitHub Actions Pages deployment. Do not rely only on a `CNAME` file in the repo. The GitHub Pages custom-domain setting must be set for `atolldb.com`.

After DNS is resolving, return to the same Pages settings and enable:

```txt
Enforce HTTPS
```

Expected public URLs:

```txt
https://atolldb.com/
https://atolldb.com/app/
```

## 2. Namecheap DNS For Studio

In Namecheap:

```txt
Domain List
Manage atolldb.com
Advanced DNS
Host Records
```

Remove conflicting parking, forwarding, or default records for `@` and `www`, then add:

```txt
A Record      @      185.199.108.153      Automatic
A Record      @      185.199.109.153      Automatic
A Record      @      185.199.110.153      Automatic
A Record      @      185.199.111.153      Automatic
CNAME Record  www    howwee20.github.io   Automatic
```

Do not put `/baseplane` in DNS values. DNS points to the GitHub Pages host, and GitHub serves this repository at the custom domain root.

## 3. Hosted Control API

Host the API on Railway, Render, Fly, Vercel, or another Node host with a managed Postgres database.

Start command:

```bash
npm install --omit=dev
npm run control-api
```

Required environment:

```txt
NODE_ENV=production
ATOLL_CONTROL_PORT=<provider port or 8790>
ATOLL_PUBLIC_API_URL=https://api.atolldb.com
CONTROL_DATABASE_URL=postgres://...
CONTROL_DATABASE_SSL=true
SESSION_SECRET=<long random value>
CORS_ORIGIN=https://atolldb.com,https://www.atolldb.com,https://howwee20.github.io
ATOLL_VERSION=<git sha or release id>
```

Local development can omit `CONTROL_DATABASE_URL`; the API will use `~/.atoll/control-api.json`.

Hosted production should use Postgres. The API initializes these tables at startup:

```txt
accounts
users
sessions
projects
project_members
graph_versions
deploy_requests
backend_instances
field_access_levels
rows
audit_events
```

Production intentionally refuses to start in implicit file-backed mode. If `NODE_ENV=production` is set, `CONTROL_DATABASE_URL` must point at a real Postgres database.

### Vercel API Project

The repo includes:

```txt
api/index.js
vercel.json
```

`vercel.json` rewrites every API-domain request into the Control API function, so these routes work from the same Vercel deployment:

```txt
/health
/version
/api/auth/sign-in
/api/projects
/api/projects/:id/...
```

Set these Vercel production env vars before deploying:

```txt
NODE_ENV=production
ATOLL_PUBLIC_API_URL=https://api.atolldb.com
CONTROL_DATABASE_URL=postgres://...
CONTROL_DATABASE_SSL=true
SESSION_SECRET=<long random value>
CORS_ORIGIN=https://atolldb.com,https://www.atolldb.com,https://howwee20.github.io
```

## 4. API Custom Domain

Create a custom domain on the API host:

```txt
api.atolldb.com
```

The host will provide DNS records. Add those records in Namecheap. Most hosts use a CNAME and sometimes a TXT verification record.

Do not guess the `api` DNS values. Use the exact records supplied by the hosting provider.

## 5. Studio Runtime Config

The public Studio loads:

```txt
/app/config.js
```

Current behavior:

```txt
localhost / 127.0.0.1 -> no configured API, falls back to http://127.0.0.1:8790
public domain -> https://api.atolldb.com
?api=https://... -> overrides config for testing
```

The config file should stay static and safe:

```js
window.ATOLL_CONFIG = {
  apiUrl: "https://api.atolldb.com",
  mode: "hosted"
};
```

No service keys, database credentials, or secrets belong in the browser.

## 6. Smoke Tests

Static site:

```bash
curl -I https://atolldb.com/
curl -I https://atolldb.com/app/
curl -L https://atolldb.com/app/ | grep "Atoll Studio"
```

API:

```bash
curl https://api.atolldb.com/health
curl https://api.atolldb.com/version
```

Expected health shape:

```json
{
  "ok": true,
  "status": "ok",
  "service": "atoll-control-api",
  "engine": "baseplane",
  "version": "...",
  "storage": "postgres"
}
```

Browser flow:

```txt
1. Open https://atolldb.com/app/
2. Press Sign In.
3. Press New Backend.
4. Press Deploy.
5. Open Rows.
6. Add a row.
7. Switch actor to coding_agent.
8. Confirm protected row values are synthetic or blocked.
9. Switch actor to analysis_agent.
10. Confirm only allowed fields are visible.
11. Open Access / Audit and confirm server-side audit events exist.
```

## 7. Hard Rules

- Public brand is Atoll.
- `baseplane.json` remains the internal graph/source format.
- Keep ExactH2O completely separate.
- No secrets in frontend files.
- Unknown browser origins are rejected in production.
- Blocked actors cannot filter, sort, search, or select protected fields.
- Coding agents receive synthetic substitutes, not raw protected row values.
