# Operator's Manual — `scripts/`

Assume you have never seen this project before. This document should let you run everything in
this folder safely, without reading any source code.

---

## 1. Operational Purpose (The Why)

Twelve scripts for project `2143` (ClearPath Mapper). Seven answer questions a passing build does
not; two apply database migrations; three operate on a user's data or access.

| Script | Answers / does |
|---|---|
| `verify-rollups.mjs` | Does the report arithmetic produce the right numbers? |
| `verify-phase2-migration.mjs` | Does the database migration preserve every row and flag the ambiguous ones? (rehearsal, on a throwaway schema) |
| `verify-period-and-bands.mjs` | Does the reporting period survive every viewer's timezone, and do the stoplight bands match the thresholds they replaced? |
| `verify-pdf-sign-normalization.ts` | Does the PDF parser normalize Gemini's mixed page-by-page signs before rows are saved? |
| `verify-mapping-memory.mjs` | Does mapping memory record and recall correctly — upsert, path-beats-label, exclusions, per-user isolation? (rehearsal, on a throwaway schema) |
| `verify-routes-render.mjs` | Does every screen actually render in a browser, or is one of them a white page? |
| `verify-access-gating.ts` | Does paid access gating hold end to end — the migration's legacy grants, the GHL webhook, sign-in with the gate on and off, refunds, and access ending mid-session? (drops and recreates a **local** test database; refuses any other) |
| `apply-migration.mjs` | **Writes to production.** Applies any `migrations/*.sql` file with before/after row accounting. Use this for new migrations. |
| `apply-phase2-migration.mjs` | **Writes to production.** The Phase 2 category migration specifically; superseded by `apply-migration.mjs` and kept as the historical record. |
| `backfill-mapping-memory.mjs` | **Writes to production.** Seeds mapping memory from an upload mapped before the feature existed. |
| `grant-access.mjs` | **Writes to production** (with `--apply`). Shows, grants or revokes one email's *manual* access — comps and corrections. Purchases arrive through the GHL webhook, never through here. Dry run by default. |
| `purge-user-data.mjs` | **Writes to production.** Deletes one account's financial data, keeping the account itself. The command-line twin of the in-app Account settings control. |

**Background you need in one paragraph.** ClearPath Mapper maps a business owner's P&L onto
functional categories and scores them against benchmarks. Phase 2 replaced the old category set
(`revenue, fulfillment, cac, systems, people, owners_pay, taxes`) with a new one
(`revenue, fulfillment_cogs, fulfillment_services, cac, opex_systems, opex_people, tax_strategy`),
consolidated three divergent copies of the report arithmetic into one, moved tiering from
revenue onto Gross Profit, and added an "excluded" mapping state so a line can be taken out of
the report. Each of those is a place where a silent wrong number is possible, which is what the
verification scripts guard.

`verify-rollups.mjs` is pure arithmetic — no database, no network. It re-implements the rollup
maths as a literal transcription of `server/lib/rollups.ts`; if the two ever disagree, the
script fails, and that disagreement is the point.

`verify-period-and-bands.mjs` covers two things a build cannot catch. A P&L's month is stored in
a timezone-naive column, and every layer that touched it applied a different zone — a January 2026
statement displayed as "December 2025" for any viewer west of UTC. The script reproduces that bug
and asserts the replacement formatters are immune. It also pins the five-band stoplight to the
same distance-from-target thresholds the speedometer gauges used, so the visual change didn't
quietly become a threshold change.

`verify-phase2-migration.mjs` runs the real migration file against a **throwaway schema** on the
real Postgres server. It never reads or writes production tables.

---

## 2. Execution Cadence (The When)

* **`verify-rollups.mjs`** — run after **any** change to `server/lib/rollups.ts`, to the
  benchmark tier table, or to the category enum. Cheap enough to run every time.
* **`verify-period-and-bands.mjs`** — run after any change to `shared/period.ts`, to
  `StoplightMeter.tsx`'s band thresholds, or to how either parser derives `monthStart`. Also
  cheap; no database, no network.
* **`verify-pdf-sign-normalization.ts`** — run after any change to `server/lib/pdf-parser.ts`
  that affects parsed amounts or categories.
* **`verify-mapping-memory.mjs`** — run before applying `2143-mapping-memory.sql`, and after any
  change to `server/lib/mapping-memory.ts`'s matching or upsert behaviour.
* **`verify-routes-render.mjs`** — run after **any** change under `client/src/`, before pushing.
  This is the one that would have caught the blank Review screen shipped in `d0d93ff`: a hook
  declared below an early return, which a clean typecheck, a clean build and a booting bundle all
  reported as fine because none of them opens a page. Needs `npm run build` first, since it drives
  the built bundle rather than the dev server.
* **`verify-phase2-migration.mjs`** — run **before** applying
  `migrations/2143-phase2-category-model.sql` to a real database, and again if that file is
  ever edited. Once the migration has been applied to production it becomes a historical
  rehearsal, not a routine check.
* **`backfill-mapping-memory.mjs`** — once per upload that predates mapping memory, and never
  again after that.
* **`purge-user-data.mjs`** — only when the in-app control at **Account settings → Delete my
  financial data** isn't usable (no browser to hand, or acting on someone else's account with
  their say-so). Prefer the UI: it is the same operation with a confirmation step.
* **`apply-phase2-migration.mjs`** — **once**, at the moment Phase 2 deploys. It is idempotent
  (it detects an already-migrated enum and stops), so a second run is harmless, but there is no
  reason to run it twice.

None of them is wired into CI or a deploy hook. They are run by hand, deliberately.

---

## 3. Prerequisites & Environment

**`verify-rollups.mjs`** and **`verify-period-and-bands.mjs`** need nothing but Node.js 20.11+.
No env vars, no database, no network.

**`verify-routes-render.mjs`** needs Node.js 20.11+, a current `npm run build`, and a local
Chrome or Edge. It finds the browser itself on a normal Windows or macOS install; if it can't,
set `CHROME_PATH` to the binary. It uses ports 2198 (its stub server) and 9332 (the browser's
debugging port) — override with `SMOKE_PORT` / `SMOKE_CDP_PORT` if either is busy. No database,
no credentials, no outbound network: the API is stubbed in the script itself.

**`verify-phase2-migration.mjs`** and **`apply-phase2-migration.mjs`** both need:

| Requirement | Where it comes from |
|---|---|
| Node.js 20.11+ | `.nvmrc` / `engines.node` |
| `DATABASE_URL` | Injected by `railway run` from the Railway service |
| `POSTGRES_PUBLIC_ADDRESS` | `G:\My Drive\_secure\2143-clearpath-mapper\.env` |
| Railway CLI, logged in | `npm i -g @railway/cli`, then `railway login` |
| Permission to `CREATE SCHEMA` (rehearsal) and to `ALTER TYPE`/`ALTER TABLE` (apply) | The Railway Postgres plugin's default user has both |

**Why both `DATABASE_URL` and `POSTGRES_PUBLIC_ADDRESS`?** Railway's `DATABASE_URL` points at
`postgres.railway.internal`, a hostname that only resolves *inside* Railway's network. The
script grafts the public `host:port` from the secrets file onto those credentials so it can
reach the database from a workstation. If the secrets file is missing, the script uses
`DATABASE_URL` unmodified — which works when run inside Railway, and fails with
`ENOTFOUND postgres.railway.internal` when run from a laptop.

---

## 4. Step-by-Step Execution (The How)

Run from the **repository root**, not from inside `scripts/`.

### Rollup arithmetic

```bash
node scripts/verify-rollups.mjs
```

Expect a list of `PASS` lines ending in `ALL CHECKS PASSED`, and exit code 0.

### Reporting period and stoplight bands

```bash
node scripts/verify-period-and-bands.mjs
```

Same shape. One line is an `INFO`, not a failure: it prints what the old local-timezone
formatter produced ("December 2025" for a January 2026 statement), which is the bug being
guarded against.

### PDF sign normalization

```bash
npm run verify:pdf-signs
```

Expect `ALL CHECKS PASSED`. This check covers the real December failure mode where Gemini
returned one CAC expense as negative and another as positive even though both were expenses on
the source P&L.

### Every screen renders

```bash
npm run build
node scripts/verify-routes-render.mjs
```

Builds nothing itself — it serves `dist/public`, so **the build must be current or you are
testing yesterday's code**. Expect one `ok` line per route and `All routes rendered clean`, exit
code 0. A failure prints the browser's own error; `#root is empty` is the white screen a user
would report, and a minified React error code can be looked up at the URL the message gives.

### Migration rehearsal

```bash
railway run --service ClearPathMapper node scripts/verify-phase2-migration.mjs
```

Expect `Rehearsing in isolated schema phase2_rehearsal_<pid> (production untouched)`, a list of
`PASS` lines, `Dropped phase2_rehearsal_<pid>.`, and `ALL CHECKS PASSED`.

### Applying the migration for real

**Read this before running it.** The old code cannot read the new enum and the new code cannot
read the old one, so the migration and the code deploy must happen together. There is a brief
window where the live app is broken whichever order you choose. That is acceptable only while
the app is not public-facing.

Dry run first — it reports the current state and changes nothing:

```bash
railway run --service ClearPathMapper node scripts/apply-phase2-migration.mjs
```

Then, to actually migrate:

```bash
railway run --service ClearPathMapper node scripts/apply-phase2-migration.mjs --apply
```

**For any migration other than Phase 2's**, use the general script, which takes the file as an
argument and works the same way (dry run without `--apply`):

```bash
railway run --service ClearPathMapper node scripts/apply-migration.mjs migrations/<file>.sql
railway run --service ClearPathMapper node scripts/apply-migration.mjs migrations/<file>.sql --apply
```

It refuses to run `0000_cuddly_iron_monger.sql`, and reports FAIL if any table's row count moved
across the migration.

### Purging one account's data

```bash
railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email>
railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email> --apply
railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email> --apply --keep-rules
```

Deletes uploads (cascading to line items, mappings and reports) plus the remembered mappings in
`rules` unless `--keep-rules`. **The account, its email address and the user's contact
preferences are never touched** — deleting data is not closing an account, and the two must not
be conflated. `login_tokens` also survives, so the user stays signed in.

### Seeding mapping memory from an older upload

```bash
railway run --service ClearPathMapper node scripts/backfill-mapping-memory.mjs <uploadId>
railway run --service ClearPathMapper node scripts/backfill-mapping-memory.mjs <uploadId> --apply
```

Pass an unknown id to have it list the uploads on the database. **Read the dry run** — everything
it lists becomes a remembered choice, and remembered choices are trusted on an exact path match.

`npm run db:push` is **not** normally needed after a hand-written migration — check the live
schema against `shared/schema.ts` first, because a migration that did its job leaves nothing for
push to do.

Expect `MIGRATION OK`, row counts unchanged on every table, and an `INFO` line naming how many
mappings are now flagged `needs_review` — those are the former `fulfillment` rows awaiting a
COGS-vs-Services decision in the review UI. Then merge the Phase 2 branch so the new code
deploys.

Do **not** replay `migrations/0000_cuddly_iron_monger.sql`. It is stale, describes tables that no
longer exist, and would produce the wrong schema.

---

## 5. Troubleshooting & Known Limitations

| Symptom | Cause and fix |
|---|---|
| `ENOTFOUND postgres.railway.internal` | The secrets file wasn't found, so the internal hostname was used. Check `G:\My Drive\_secure\2143-clearpath-mapper\.env` exists and defines `POSTGRES_PUBLIC_ADDRESS` as a bare `host:port`. |
| `Cannot find package 'pg'` | You ran the script from outside the repo root, so Node couldn't resolve `node_modules`. `cd` to the repository root. |
| `DATABASE_URL` is undefined | You ran it without `railway run`. The script does not read `DATABASE_URL` from a local `.env`. |
| `permission denied to create schema` | The database user lacks `CREATE`. Use the Postgres plugin's own credentials, not a restricted role. |
| `apply-phase2-migration.mjs` reports `Nothing to do` | The enum already holds the new values, so the migration has run before. This is the idempotency check, not a failure. |
| A row count changed during the migration | Should be impossible — the migration is one transaction. Stop, do not deploy, and inspect before doing anything else. |
| A `phase2_rehearsal_*` schema is left behind | The script drops it in a `finally` block, so this only happens if the process was killed. Drop it by hand: `DROP SCHEMA phase2_rehearsal_<pid> CASCADE;`. It contains only synthetic rows. |
| `verify-rollups.mjs` fails after a change to `rollups.ts` | Expected and intentional. The script transcribes that file's maths; reconcile the two deliberately rather than editing the script to match. |
| `verify-routes-render.mjs` says `No build at .../dist/public` | You skipped `npm run build`. It drives the built bundle, never the dev server. |
| `verify-routes-render.mjs` says `No Chrome or Edge found` | Set `CHROME_PATH` to a Chromium-family binary. |
| `verify-routes-render.mjs` reports a route as `#root is empty` | That route is a white screen for real users. Read the React error printed beside it; a hook declared below an early return is the failure this script was written for. |
| `verify-routes-render.mjs` hangs or times out | Its debugging port (9332) is in use, often by a browser left behind by a killed run. Set `SMOKE_CDP_PORT`, or close stray headless Chrome processes. |
| `verify-period-and-bands.mjs` fails on the band checks | Someone moved the on-target (3 point) or caution (10 point) breakpoints. Those are benchmark thresholds and need Neal's sign-off — see the Safety Rails in the `2143` PRD. |

**Known limitations, stated plainly:**

* `verify-period-and-bands.mjs` transcribes the formatters rather than importing them (they are
  TypeScript and this is a plain `.mjs` script), so it proves the *logic* is right, not that
  every call site uses it. A page that formats a date by hand would slip past it.
* `verify-rollups.mjs` tests the arithmetic, **not** the API. It cannot catch a route that
  forgets to call the shared function, or a client page that renders the wrong field.
* `verify-phase2-migration.mjs` seeds *representative* rows — one of every retired category —
  not a copy of production. It proves the migration's logic, not that production's specific
  rows are clean.
* `purge-user-data.mjs` and the in-app control are two implementations of one contract. If you
  change what a purge keeps or deletes, change both — there is no shared code between them.
* `verify-routes-render.mjs` proves each route **renders** against a stub API. It does not prove
  the figures are right, does not touch the real database, and its assertions cover the three
  defects that prompted it (blank screen, period switcher, default period) plus "did anything
  throw". A new screen needs a new `visit()` line or it is not covered at all.
* Confirming that an excluded line disappears identically from the on-screen report, the PDF, the
  CSV **and** the Comparison page is still a manual check against a real P&L, and is listed in
  project `2143`'s Verification Checklist.
* The rehearsal cannot detect a lock or timeout that only a large table would produce. Production
  currently holds tens of rows, so this is not a present concern.
