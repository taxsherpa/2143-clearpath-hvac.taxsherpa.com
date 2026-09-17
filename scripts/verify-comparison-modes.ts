#!/usr/bin/env tsx
/**
 * Phase 2.7 (project 2143) real-data verification for the three default comparison lenses —
 * `resolveMonthOverMonth`, `resolveRollingQuarterOverQuarter`, `resolveYtdOverYtd` in
 * server/lib/rollups.ts — plus the multi-period `/api/comparisons` picker's underlying period
 * addressing (the bug-fix half of this phase is covered by the route itself; this script
 * exercises the mode resolvers against a real Postgres schema, the same way
 * scripts/verify-annual-construction.ts exercises resolveAnnualConstruction()).
 *
 * Mirrors that script's harness exactly: an isolated schema, hand-built months (no CSV parsing
 * needed — full control over exact dollar amounts, months and years), dropped in a `finally`.
 *
 *   railway run --service ClearPathMapper npx tsx scripts/verify-comparison-modes.ts
 *   (or against a local Postgres: DATABASE_URL=... npx tsx scripts/verify-comparison-modes.ts)
 *
 * NOT YET RUN as of this writing — this session had no DATABASE_URL / secrets access, the same
 * standing gap noted throughout Phase 2.6's Decisions Log entries. Written to the same standard
 * so it's ready to run before this checkpoint is called closed; per this project's own rule, a
 * passing typecheck/build/verify-rollups.mjs/verify-routes-render.mjs pass does not substitute
 * for this.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = "G:/My Drive/_secure/2143-clearpath-mapper/.env";
const SCHEMA = `phase27_livetest_${process.pid}`;

function baseConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL!);
  if (fs.existsSync(SECRETS)) {
    const env = Object.fromEntries(
      fs.readFileSync(SECRETS, "utf8").split(/\r?\n/).filter(l => l.includes("="))
        .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    if (env.POSTGRES_PUBLIC_ADDRESS) {
      const [host, port] = env.POSTGRES_PUBLIC_ADDRESS.split(":");
      url.hostname = host;
      url.port = port;
    }
  }
  return url.toString();
}

function scopedConnectionString(schema: string): string {
  const url = new URL(baseConnectionString());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const setupClient = new pg.Client({ connectionString: baseConnectionString(), ssl: { rejectUnauthorized: false } });
await setupClient.connect();

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

try {
  console.log(`Setting up isolated schema ${SCHEMA} (production untouched)\n`);
  await setupClient.query(`CREATE SCHEMA ${SCHEMA}`);
  await setupClient.query(`SET search_path TO ${SCHEMA}`);

  await setupClient.query(`
    CREATE TYPE period_type AS ENUM ('month','quarter','year_to_date','annual','custom','unknown');
    CREATE TYPE clearpath_category AS ENUM ('revenue','fulfillment_cogs','fulfillment_services','cac','opex_systems','opex_people','tax_strategy');
    CREATE TYPE confidence_level AS ENUM ('high','medium','needs_review');
    CREATE TYPE mapping_status AS ENUM ('mapped','excluded');
    CREATE TABLE users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE);
    CREATE TABLE uploads (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id),
      original_filename text NOT NULL,
      month_start timestamp NOT NULL,
      status text NOT NULL DEFAULT 'parsed',
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE periods (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id varchar NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      period_start timestamp NOT NULL,
      period_end timestamp NOT NULL,
      period_type period_type NOT NULL DEFAULT 'month',
      months_covered integer NOT NULL DEFAULT 1,
      label text NOT NULL,
      display_order integer NOT NULL DEFAULT 0,
      confirmed boolean NOT NULL DEFAULT true
    );
    CREATE TABLE pl_nodes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id varchar NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      parent_id varchar,
      label text NOT NULL,
      level integer NOT NULL,
      display_order integer NOT NULL,
      is_rollup integer NOT NULL DEFAULT 0,
      source_path text NOT NULL
    );
    CREATE TABLE pl_node_period_amounts (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id varchar NOT NULL REFERENCES pl_nodes(id) ON DELETE CASCADE,
      period_id varchar NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
      amount_cents integer NOT NULL
    );
    CREATE TABLE category_mappings (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id varchar NOT NULL REFERENCES pl_nodes(id) ON DELETE CASCADE,
      clearpath_category clearpath_category NOT NULL,
      confidence confidence_level NOT NULL DEFAULT 'needs_review',
      status mapping_status NOT NULL DEFAULT 'mapped',
      excluded_reason text,
      rule_id varchar
    );
  `);

  const [{ id: userId }] = (await setupClient.query(
    `INSERT INTO users (email) VALUES ('phase27-livetest@example.com') RETURNING id`)).rows;

  /** Hand-builds one confirmed calendar month directly from category dollar amounts (no CSV
   *  parsing) — full control over exact revenue/expense figures and exact month/year, which this
   *  script needs to construct specific contiguous/gapped/complete/incomplete shapes. Mirrors
   *  the same helper in scripts/verify-annual-construction.ts. */
  async function loadHandBuiltMonth(
    year: number, monthIndexZeroBased: number, label: string,
    amountsDollars: Partial<Record<string, number>>,
    confirmed = true,
  ) {
    const start = `${year}-${String(monthIndexZeroBased + 1).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(year, monthIndexZeroBased + 1, 0)).toISOString().slice(0, 10);
    const [{ id: uploadId }] = (await setupClient.query(
      `INSERT INTO uploads (user_id, original_filename, month_start) VALUES ($1,$2,$3) RETURNING id`,
      [userId, `${label}.handbuilt`, start])).rows;
    const [{ id: periodId }] = (await setupClient.query(
      `INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
       VALUES ($1,$2,$3,'month',1,$4,0,$5) RETURNING id`,
      [uploadId, start, end, label, confirmed])).rows;
    for (const [category, dollars] of Object.entries(amountsDollars)) {
      const [{ id: nodeId }] = (await setupClient.query(
        `INSERT INTO pl_nodes (upload_id, label, level, display_order, is_rollup, source_path) VALUES ($1,$2,1,0,0,$2) RETURNING id`,
        [uploadId, category])).rows;
      await setupClient.query(`INSERT INTO pl_node_period_amounts (node_id, period_id, amount_cents) VALUES ($1,$2,$3)`,
        [nodeId, periodId, Math.round((dollars as number) * 100)]);
      await setupClient.query(`INSERT INTO category_mappings (node_id, clearpath_category, confidence) VALUES ($1,$2,'high')`,
        [nodeId, category]);
    }
    return periodId as string;
  }

  const MONTH = (dollarsBase: number) => ({
    revenue: dollarsBase, fulfillment_cogs: dollarsBase * 0.2, cac: dollarsBase * 0.1,
    opex_systems: dollarsBase * 0.1, opex_people: dollarsBase * 0.15, tax_strategy: dollarsBase * 0.2,
  });

  process.env.DATABASE_URL = scopedConnectionString(SCHEMA);
  const { resolveMonthOverMonth, resolveRollingQuarterOverQuarter, resolveYtdOverYtd, loadPeriodMetrics, loadMultiPeriodMetrics } =
    await import("../server/lib/rollups");

  console.log("\n-- 1. Month-over-Month: two most recent COMPLETE months, skipping an in-progress current month --");
  {
    const YEAR = 2030;
    const janId = await loadHandBuiltMonth(YEAR, 0, `January ${YEAR}`, MONTH(100000));
    const febId = await loadHandBuiltMonth(YEAR, 1, `February ${YEAR}`, MONTH(110000));
    const marId = await loadHandBuiltMonth(YEAR, 2, `March ${YEAR}`, MONTH(120000));
    // April is on file but the "current" month — its periodEnd is AFTER `now`, so it must not
    // be treated as the latest complete month (the exact ambiguity flagged in the PRD: what
    // "complete" means when the latest upload is itself mid-month).
    await loadHandBuiltMonth(YEAR, 3, `April ${YEAR}`, MONTH(999999));

    const now = new Date(Date.UTC(YEAR, 3, 15)); // April 15 — March has closed, April has not.
    const result = await resolveMonthOverMonth(userId, now);
    check("available", result.available === true, String(result.available) + " " + (result as any).reason);
    check("2 periods returned", (result.periods ?? []).length === 2, String(result.periods?.length));
    check("compares February vs March, NOT March vs the in-progress April",
      result.periods?.[0].periodLabel === "February 2030" && result.periods?.[1].periodLabel === "March 2030",
      JSON.stringify(result.periods?.map(p => p.periodLabel)));

    const febMetrics = await loadPeriodMetrics(febId);
    const marMetrics = await loadPeriodMetrics(marId);
    check("February's own Gross Profit carries through unchanged",
      Math.abs((result.periods?.[0].metrics.grossProfit ?? NaN) - febMetrics.grossProfit) < 0.01,
      `${result.periods?.[0].metrics.grossProfit} vs ${febMetrics.grossProfit}`);
    check("March's own Gross Profit carries through unchanged",
      Math.abs((result.periods?.[1].metrics.grossProfit ?? NaN) - marMetrics.grossProfit) < 0.01,
      `${result.periods?.[1].metrics.grossProfit} vs ${marMetrics.grossProfit}`);
    void janId;
  }

  console.log("\n-- 2. Month-over-Month: fewer than 2 complete months on file --> unavailable --");
  {
    const now = new Date(Date.UTC(2040, 0, 15));
    const result = await resolveMonthOverMonth(userId, now);
    check("unavailable for a user/window with no data", result.available === false, String(result.available));
  }

  console.log("\n-- 3. Rolling Quarter-over-Quarter: two clean contiguous 3-month windows --");
  {
    const YEAR = 2031;
    const monthIds: string[] = [];
    for (let m = 0; m < 6; m++) {
      monthIds.push(await loadHandBuiltMonth(YEAR, m, `${MONTH_NAMES[m]} ${YEAR}`, MONTH(50000 + m * 1000)));
    }
    const now = new Date(Date.UTC(YEAR, 6, 15)); // mid-July: all 6 months (Jan-Jun) have closed.
    const result = await resolveRollingQuarterOverQuarter(userId, now);
    check("available", result.available === true, String(result.available) + " " + (result as any).reason);
    check("2 windows returned", (result.periods ?? []).length === 2, String(result.periods?.length));
    check("prior window is Jan-Mar", /Jan.*Mar 2031|January.*March/.test(result.periods?.[0].periodLabel ?? ""), result.periods?.[0].periodLabel);
    check("current window is Apr-Jun", /Apr.*Jun 2031|April.*June/.test(result.periods?.[1].periodLabel ?? ""), result.periods?.[1].periodLabel);

    const janFebMar = await loadMultiPeriodMetrics(monthIds.slice(0, 3));
    const aprMayJun = await loadMultiPeriodMetrics(monthIds.slice(3, 6));
    check("prior window's Gross Profit equals Jan+Feb+Mar summed directly",
      Math.abs((result.periods?.[0].metrics.grossProfit ?? NaN) - janFebMar.grossProfit) < 0.01,
      `${result.periods?.[0].metrics.grossProfit} vs ${janFebMar.grossProfit}`);
    check("current window's Gross Profit equals Apr+May+Jun summed directly",
      Math.abs((result.periods?.[1].metrics.grossProfit ?? NaN) - aprMayJun.grossProfit) < 0.01,
      `${result.periods?.[1].metrics.grossProfit} vs ${aprMayJun.grossProfit}`);
  }

  console.log("\n-- 4. Rolling Quarter-over-Quarter: a gap inside the would-be CURRENT window refuses, not silently averages around it --");
  {
    const YEAR = 2032;
    await loadHandBuiltMonth(YEAR, 0, `January ${YEAR}`, MONTH(10000));
    await loadHandBuiltMonth(YEAR, 1, `February ${YEAR}`, MONTH(10000));
    await loadHandBuiltMonth(YEAR, 2, `March ${YEAR}`, MONTH(10000));
    // April deliberately skipped.
    await loadHandBuiltMonth(YEAR, 4, `May ${YEAR}`, MONTH(10000));
    await loadHandBuiltMonth(YEAR, 5, `June ${YEAR}`, MONTH(10000));
    const now = new Date(Date.UTC(YEAR, 6, 15));
    const result = await resolveRollingQuarterOverQuarter(userId, now);
    check("unavailable: the most recent 3 (Mar, May, Jun) are not contiguous", result.available === false, String(result.available));
    check("names the contiguity problem in the reason", /aren't contiguous/.test((result as any).reason ?? ""), (result as any).reason);
  }

  console.log("\n-- 5. Year-to-Date-over-YTD: matching spans across two years, extra months in the prior year ignored --");
  {
    const CURRENT_YEAR = 2033;
    const PRIOR_YEAR = 2032 - 1 + 1; // 2032, kept explicit for readability below
    const priorYear = CURRENT_YEAR - 1;
    for (let m = 0; m < 8; m++) {
      await loadHandBuiltMonth(CURRENT_YEAR, m, `${MONTH_NAMES[m]} ${CURRENT_YEAR}`, MONTH(20000 + m * 500));
    }
    const priorMonthIds: string[] = [];
    for (let m = 0; m < 8; m++) {
      priorMonthIds.push(await loadHandBuiltMonth(priorYear, m, `${MONTH_NAMES[m]} ${priorYear}`, MONTH(18000 + m * 500)));
    }
    // Prior year ALSO has September-December on file. YTD-over-YTD must sum only Jan-Aug for
    // the prior year to match the current year's span — including these would silently compare
    // 8 months against 12.
    for (let m = 8; m < 12; m++) {
      await loadHandBuiltMonth(priorYear, m, `${MONTH_NAMES[m]} ${priorYear}`, MONTH(999999));
    }

    const now = new Date(Date.UTC(CURRENT_YEAR, 8, 15)); // mid-September: Jan-Aug is this year's YTD.
    const result = await resolveYtdOverYtd(userId, now);
    check("available", result.available === true, String(result.available) + " " + (result as any).reason);
    check("prior period covers 8 months (Jan-Aug), not 12", result.periods?.[0].monthsCovered === 8, String(result.periods?.[0].monthsCovered));
    check("current period covers 8 months (Jan-Aug)", result.periods?.[1].monthsCovered === 8, String(result.periods?.[1].monthsCovered));

    const priorJanAug = await loadMultiPeriodMetrics(priorMonthIds);
    check("prior YTD Gross Profit equals exactly Jan-Aug summed (the Sep-Dec months are excluded)",
      Math.abs((result.periods?.[0].metrics.grossProfit ?? NaN) - priorJanAug.grossProfit) < 0.01,
      `${result.periods?.[0].metrics.grossProfit} vs ${priorJanAug.grossProfit}`);
    void PRIOR_YEAR;
  }

  console.log("\n-- 6. Year-to-Date-over-YTD: prior year missing a month in the matching span --> unavailable, names it --");
  {
    const CURRENT_YEAR = 2034;
    const priorYear = CURRENT_YEAR - 1;
    for (let m = 0; m < 6; m++) {
      await loadHandBuiltMonth(CURRENT_YEAR, m, `${MONTH_NAMES[m]} ${CURRENT_YEAR}`, MONTH(10000));
    }
    // Prior year: every month EXCEPT March.
    for (let m = 0; m < 6; m++) {
      if (m === 2) continue;
      await loadHandBuiltMonth(priorYear, m, `${MONTH_NAMES[m]} ${priorYear}`, MONTH(10000));
    }
    const now = new Date(Date.UTC(CURRENT_YEAR, 6, 15));
    const result = await resolveYtdOverYtd(userId, now);
    check("unavailable", result.available === false, String(result.available));
    check("names last year and March specifically", /Last year/.test((result as any).reason ?? "") && /March/.test((result as any).reason ?? ""), (result as any).reason);
  }

} finally {
  await setupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  console.log(`\nDropped ${SCHEMA}.`);
  await setupClient.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
