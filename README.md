# ClearPath Mapper (Project `2143`) — Operator's Manual

> Written for a reader with zero prior context. You should be able to run, deploy, or
> troubleshoot this app in two minutes without opening a source file.

## 1. Operational Purpose (The Why)

ClearPath Mapper takes a business owner's monthly P&L export (QuickBooks-style CSV, or a
PDF read by Gemini 2.5 Flash vision) and sorts every line item into the ClearPath Insight
Framework's functional categories, then scores the result against benchmark targets for
that owner's revenue tier and produces a report (on-screen, CSV, and PDF).

It is a **self-serve, externally-facing, multi-tenant** tool: a business owner signs in
with their own email and sees only their own uploads, rules, and reports.

Scope and phasing live in `Tax-Sherpa-OS/02-workbench/2143-clearpath-mapper/prd.md`.
This repo holds the code only.

**Sign-in is passwordless.** There is no password anywhere in this system — no password
field, no password hash, no login form. A user enters their email, receives a one-time
link from Resend, and clicks a button on a transition page to establish their session.
That transition page is mandatory, not decoration: corporate email scanners pre-fetch
links in inbound mail, and a link that logged the user in on GET would have its
single-use token burned by the scanner before the human ever clicked it. This is the
org-wide rule in `systems-registry.md` §Core Software Directives.

## 2. Execution Cadence (The When)

This is a **continuously-running web service**, not a scheduled job. There is no cron,
no batch run, and nothing to trigger on a timetable.

* **Production:** deploys automatically from this repo's default branch to Railway
  project `2143-clearpath-mapper`
  ([dashboard](https://railway.com/project/c44d22f4-4964-4cf3-8aae-76e1e6e7bf38)),
  serving `https://clearpathmap.taxsherpa.com`.
* **Database schema:** pushed manually, only when `shared/schema.ts` changes (§4).
* **Expired login tokens:** cleaned up opportunistically on each magic-link request.
  Nothing to schedule.

## 3. Prerequisites & Environment

**Tooling:** Node.js 20+ and npm. The Railway CLI (`npm i -g @railway/cli`) for anything
touching the deployed service.

**Environment variables.** Copy `.env.example` to `.env` for local work; in production
these are set on the `ClearPathMapper` service in Railway.

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. In Railway, set it to the reference `${{Postgres.DATABASE_URL}}` so it tracks the plugin. |
| `SESSION_SECRET` | yes in production | Signs the session cookie. Any long random string. **Changing it signs every user out.** The app refuses to boot in production without it. |
| `RESEND_API_KEY` | yes | Sends magic-link email. Without it, sign-in requests fail with a 500 and log `RESEND_API_KEY must be set`. |
| `RESEND_FROM_EMAIL` | recommended | Sender identity, e.g. `ClearPath Mapper <login@clearpathmap.taxsherpa.com>`. The domain must be verified in Resend or delivery fails. |
| `APP_URL` | yes in production | Absolute base URL used to build the link inside the email — e.g. `https://clearpathmap.taxsherpa.com`. If it's wrong, the emailed link points at the wrong host. Falls back to the inbound request's own host. |
| `GEMINI_API_KEY` | for PDF uploads | Gemini 2.5 Flash vision extraction for PDF P&Ls. CSV uploads and sign-in work without it. `GOOGLE_API_KEY` is accepted as an alias. |
| `PORT` | no | Defaults to **2143** (this project's 4-digit code, per the Tax Sherpa OS port convention). Railway injects its own. |

**Database:** Railway's own Postgres plugin, reached over plain TCP via `node-postgres`.
This app does **not** use Neon or any other third-party database. The plugin is
internal-only by default — to connect from a laptop you must first enable public
networking on the Postgres service in the Railway dashboard.

## 4. Step-by-Step Execution (The How)

### Run it locally

```bash
npm install
cp .env.example .env      # then fill in the values from §3
npm run db:push           # only needed the first time, or after a schema change
npm run dev
```

Open `http://localhost:2143`.

Signing in locally still sends a real email through Resend — there is no console-only
fallback. Use an address you can actually read.

### Type-check and build

```bash
npm run check     # tsc, no emit
npm run build     # vite client build + esbuild server bundle into dist/
npm run start     # runs the built bundle
```

Note: `npm run check` currently reports 1 pre-existing error, in
`client/src/components/examples/DashboardHeader.tsx` (a props mismatch in a component
example). It predates this work, doesn't affect the build, and is unrelated to sign-in
or parsing.

### Apply a schema change to the database

`shared/schema.ts` is the single source of truth. The `migrations/` folder is a **stale
leftover from Replit** — its SQL describes tables (`lines`, `line_splits`) that no longer
exist in the schema. Do not run it. Use push:

```bash
npm run db:push                                  # against DATABASE_URL in your .env
railway run --service ClearPathMapper npm run db:push   # against the Railway database
```

The second form only works if the Postgres plugin has public networking enabled and the
service has `DATABASE_URL` set.

### Deploy

Push to the default branch; Railway builds and deploys automatically using `railway.json`
(`npm run build` → `npm run start`, health-checked at `/api/health`).

Confirm a deploy landed:

```bash
curl https://clearpathmap.taxsherpa.com/api/health
# {"ok":true,"database":"connected"}
```

### Verify sign-in end to end

1. Go to `/auth`, enter your email, submit. The page should say "Check your email."
2. The email arrives from `RESEND_FROM_EMAIL` with a "Continue to sign-in" button.
3. The link opens `/verify?token=…`. **Nothing happens yet** — this is the transition
   page, and it must not sign you in on its own.
4. Click **"Securely Open My ClearPath Dashboard."** You land on the upload screen.
5. Reload the same `/verify?token=…` URL. It must now say the link was already used —
   that proves the token is genuinely single-use.

## 5. Troubleshooting & Known Limitations

| Symptom | Cause / Fix |
|---|---|
| Service crashes at boot; `/api/health` unreachable | Almost always a missing env var. `DATABASE_URL` absent → boot throws "DATABASE_URL must be set." `SESSION_SECRET` absent in production → boot throws by design. Check the Railway service's variables. |
| `/api/health` returns `503 database unreachable` | The app is up but Postgres isn't. Check the Postgres plugin is running and that `DATABASE_URL` points at it (use the `${{Postgres.DATABASE_URL}}` reference, not a pasted string). |
| Sign-in returns 500, log shows `RESEND_API_KEY must be set` | The key isn't set on the service. |
| A PDF upload fails with `GEMINI_API_KEY must be set` | Expected when the key is absent. Only PDF parsing needs it — sign-in and CSV uploads are unaffected. |
| Email never arrives | Check the Resend dashboard for the send. Most common cause is an unverified sending domain in `RESEND_FROM_EMAIL`. |
| Emailed link 404s or points at `localhost` | `APP_URL` is unset or wrong in production. |
| "This sign-in link has expired or was already used" on a fresh link | Tokens last 20 minutes and work once. Requesting a new link also invalidates any earlier unused link for that address — so if you clicked "send" twice, only the newest email works. |
| "Too many sign-in requests" | Throttle: 5 sends per email and 15 per IP per 15 minutes. It's held in process memory, so a redeploy clears it. It is not shared across instances — scaling past one instance weakens it. |
| Everyone got signed out at once | `SESSION_SECRET` changed, or the `session` table was dropped. |
| `npm run dev` fails on `NODE_ENV` on Windows | Should not happen — `cross-env` handles it. If it does, `cross-env` didn't install; re-run `npm install`. |

**Known limitations**

* The rate limiter is per-process and in-memory, not distributed.
* Sign-in depends entirely on Resend being up and the domain verified; there is no
  fallback delivery path and no admin override.
* `migrations/` is stale and must not be applied (see §4).
* PDF parsing requires `GEMINI_API_KEY` (Gemini 2.5 Flash); CSV parsing does not.
* PDFs are rasterized in-process by `pdf-to-png-converter` at ~144dpi. No `pdftoppm`/
  poppler-utils installation is required, and nothing is written to a temp directory.
* Sessions live in Postgres (`connect-pg-simple`), so a database outage signs everyone
  out for its duration.
* The category model, report math, and in-app explanatory copy are still the
  pre-rescope versions — those are Phases 2 and 3 in the PRD, not yet built.
