#!/usr/bin/env tsx
/**
 * Phase 2.6 (project 2143) real-data verification for `resolveAnnualConstruction()` — the
 * function that builds the "Full Year" and "Year-to-Date" report views.
 *
 * Mirrors scripts/verify-tiering-precedence.ts's harness (isolated schema, real parseCSV(),
 * real server code) but exercises the new annual-construction function rather than tiering:
 *   1. full-year mode with no confirmed annual upload on file -> unavailable, with a reason.
 *   2. full-year mode with a confirmed annual upload -> uses its own metrics directly.
 *   3. ytd mode with a gap (Jan, Feb, Apr present; March missing) -> unavailable, names March,
 *      per the same "every intervening month present, else name the missing one" rule Phase 2.5
 *      already applies to tiering (server/lib/rollups.ts: findContiguousMonths).
 *   4. ytd mode once March is filled in -> sums Jan-Apr via loadMultiPeriodMetrics, and that sum
 *      must equal the four months' own Gross Profit added by hand — not merely "a number".
 *   5. ytd mode with a confirmed year_to_date upload on file for the year -> that direct upload
 *      wins over the monthly roll-up (same precedence resolveTieringBasis already uses).
 *
 *   railway run --service ClearPathMapper npx tsx scripts/verify-annual-construction.ts
 *   (or against a local Postgres: DATABASE_URL=... npx tsx scripts/verify-annual-construction.ts)
 *
 * NOT YET RUN as of this writing — this session had no DATABASE_URL / secrets access. Written to
 * the same standard as the Phase 2.5 tiering test so it's ready to run before this checkpoint is
 * called closed; per this project's own rule, a passing typecheck/build/headless-render pass does
 * not substitute for this.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = "G:/My Drive/_secure/2143-clearpath-mapper/.env";
const SCHEMA = `phase26_livetest_${process.pid}`;

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

async function fixtureCsvNodesAndPeriod(filename: string) {
  const { parseCSV } = await import("../server/lib/csv-parser");
  const content = fs.readFileSync(path.join(__dirname, "..", "test-data", filename), "utf-8");
  return parseCSV(content);
}

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
    `INSERT INTO users (email) VALUES ('phase26-livetest@example.com') RETURNING id`)).rows;

  async function loadFixtureUpload(filename: string, label: string) {
    const result = await fixtureCsvNodesAndPeriod(filename);
    const p = result.periods[0];
    const [{ id: uploadId }] = (await setupClient.query(
      `INSERT INTO uploads (user_id, original_filename, month_start) VALUES ($1, $2, $3) RETURNING id`,
      [userId, filename, p.periodStart.toISOString()])).rows;
    const [{ id: periodId }] = (await setupClient.query(
      `INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,0,true) RETURNING id`,
      [uploadId, p.periodStart.toISOString(), p.periodEnd.toISOString(), p.periodType, p.monthsCovered, label])).rows;

    for (const node of result.nodes) {
      const [{ id: nodeId }] = (await setupClient.query(
        `INSERT INTO pl_nodes (upload_id, label, level, display_order, is_rollup, source_path)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uploadId, node.label, node.level, node.displayOrder, node.isRollup ? 1 : 0, node.sourcePath])).rows;
      const amount = node.amounts[0];
      if (amount !== null && amount !== undefined) {
        await setupClient.query(
          `INSERT INTO pl_node_period_amounts (node_id, period_id, amount_cents) VALUES ($1,$2,$3)`,
          [nodeId, periodId, amount]);
      }
      if (!node.isRollup && node.suggestedCategory) {
        await setupClient.query(
          `INSERT INTO category_mappings (node_id, clearpath_category, confidence) VALUES ($1,$2,$3)`,
          [nodeId, node.suggestedCategory, node.confidence ?? "medium"]);
      }
    }
    return periodId as string;
  }

  async function loadDirectPeriod(
    csvFixture: string, label: string, periodType: string, periodStart: string, periodEnd: string, monthsCovered: number,
  ) {
    const result = await fixtureCsvNodesAndPeriod(csvFixture);
    const [{ id: uploadId }] = (await setupClient.query(
      `INSERT INTO uploads (user_id, original_filename, month_start) VALUES ($1,$2,$3) RETURNING id`,
      [userId, csvFixture, periodStart])).rows;
    const [{ id: periodId }] = (await setupClient.query(
      `INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,0,true) RETURNING id`,
      [uploadId, periodStart, periodEnd, periodType, monthsCovered, label])).rows;
    for (const node of result.nodes) {
      const [{ id: nodeId }] = (await setupClient.query(
        `INSERT INTO pl_nodes (upload_id, label, level, display_order, is_rollup, source_path) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uploadId, node.label, node.level, node.displayOrder, node.isRollup ? 1 : 0, node.sourcePath])).rows;
      const amount = node.amounts[0];
      if (amount !== null && amount !== undefined) {
        await setupClient.query(`INSERT INTO pl_node_period_amounts (node_id, period_id, amount_cents) VALUES ($1,$2,$3)`,
          [nodeId, periodId, amount]);
      }
      if (!node.isRollup && node.suggestedCategory) {
        await setupClient.query(`INSERT INTO category_mappings (node_id, clearpath_category, confidence) VALUES ($1,$2,$3)`,
          [nodeId, node.suggestedCategory, node.confidence ?? "medium"]);
      }
    }
    return periodId as string;
  }

  /**
   * Hand-builds one confirmed month directly from category dollar amounts (no CSV parsing) so a
   * PDF-style negative-expense month can sit alongside CSV-style positive months in the same
   * year — reproducing the live-site bug (Neal, 2026-09-06): a constructed Full Year mixed
   * CSV-sourced and PDF-sourced months and came out with Fulfillment wrong and OpEx People at
   * -$123,744, because the old loadMultiPeriodMetrics() detected ONE sign convention across
   * every month's rows concatenated together instead of normalizing each month first.
   */
  async function loadHandBuiltMonth(
    year: number, monthIndexZeroBased: number, label: string,
    amountsDollars: Partial<Record<string, number>>,
  ) {
    const start = `${year}-${String(monthIndexZeroBased + 1).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(year, monthIndexZeroBased + 1, 0)).toISOString().slice(0, 10);
    const [{ id: uploadId }] = (await setupClient.query(
      `INSERT INTO uploads (user_id, original_filename, month_start) VALUES ($1,$2,$3) RETURNING id`,
      [userId, `${label}.handbuilt`, start])).rows;
    const [{ id: periodId }] = (await setupClient.query(
      `INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
       VALUES ($1,$2,$3,'month',1,$4,0,true) RETURNING id`,
      [uploadId, start, end, label])).rows;
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

  const janId = await loadFixtureUpload("history-jan.csv", "January 2026");
  const febId = await loadFixtureUpload("history-feb.csv", "February 2026");
  const aprId = await loadFixtureUpload("history-apr.csv", "April 2026");

  process.env.DATABASE_URL = scopedConnectionString(SCHEMA);
  const { resolveAnnualConstruction, loadPeriodMetrics } = await import("../server/lib/rollups");

  console.log("\n-- 1. Full-year mode, no confirmed annual upload, partial monthly history --");
  {
    // Jan, Feb and Apr are already loaded above (March deliberately absent) — real shape of
    // Neal's live-site report (an 11-month Jan-Nov upload mistaken for "a full year"). The
    // reason should name what's actually on file, not just say "no annual P&L."
    const result = await resolveAnnualConstruction(userId, 2026, "full-year");
    check("unavailable", result.available === false, String(result.available));
    check("names the year in the reason", (result.reason ?? "").includes("2026"), result.reason ?? "(none)");
    check("says how many of 12 months are covered", (result.reason ?? "").includes("of 12 months"), result.reason ?? "(none)");
    check("names a missing month rather than just refusing generically",
      /missing/i.test(result.reason ?? ""), result.reason ?? "(none)");
    // Reported by Neal (2026-09-06): "December is there as a separate upload," which an earlier
    // version of this message had no way to surface — it only inspected periods that passed the
    // confirmed/month-type filter, so a period sitting there unconfirmed or under a different
    // type was silently indistinguishable from "never uploaded." Every reason now ends with a
    // full inventory (confirmed or not, whatever type) so that distinction is never lost again.
    check("includes an inventory of what's actually on file for the year",
      /On file for 2026:/.test(result.reason ?? ""), result.reason ?? "(none)");
    check("inventory names January's real period",
      /January 2026/.test(result.reason ?? ""), result.reason ?? "(none)");
  }

  console.log("\n-- 2. Year-to-date mode with a gap: Jan, Feb, Apr present, March missing --");
  {
    const result = await resolveAnnualConstruction(userId, 2026, "ytd");
    check("unavailable", result.available === false, String(result.available));
    check("names the missing month (March)", (result.reason ?? "").includes("March"), result.reason ?? "(none)");
  }

  console.log("\n-- 3. Year-to-date mode once March is filled in: Jan-Apr all present --");
  {
    const marId = await loadFixtureUpload("history-feb.csv", "March 2026 (reusing Feb fixture amounts for a distinct month)");
    await setupClient.query(
      `UPDATE periods SET period_start = '2026-03-01', period_end = '2026-03-31', label = 'March 2026' WHERE id = $1`,
      [marId]);

    const result = await resolveAnnualConstruction(userId, 2026, "ytd");
    check("available", result.available === true, String(result.available));
    check("source is monthly-history", result.source === "monthly-history", result.source);
    check("monthsCovered is 4 (Jan through Apr)", result.monthsCovered === 4, String(result.monthsCovered));
    check("four source periods", (result.sourcePeriodIds ?? []).length === 4, String(result.sourcePeriodIds?.length));

    const janMetrics = await loadPeriodMetrics(janId);
    const febMetrics = await loadPeriodMetrics(febId);
    const marMetrics = await loadPeriodMetrics(marId);
    const aprMetrics = await loadPeriodMetrics(aprId);
    const expectedGP = janMetrics.grossProfit + febMetrics.grossProfit + marMetrics.grossProfit + aprMetrics.grossProfit;
    check(`constructed Gross Profit sums the four real months ($${expectedGP.toFixed(2)})`,
      Math.abs((result.metrics?.grossProfit ?? NaN) - expectedGP) < 0.01,
      `${result.metrics?.grossProfit} vs ${expectedGP}`);
  }

  console.log("\n-- 4. Full-year mode once a confirmed annual upload exists --");
  {
    const annualPeriodId = await loadDirectPeriod(
      "annual-pl.csv", "FY2026", "annual", "2026-01-01", "2026-12-31", 12);
    const result = await resolveAnnualConstruction(userId, 2026, "full-year");
    check("available", result.available === true, String(result.available));
    check("source is confirmed-annual", result.source === "confirmed-annual", result.source);
    check("uses the annual statement's own Gross Profit ($595,200)",
      Math.abs((result.metrics?.grossProfit ?? NaN) - 595200) < 0.01, String(result.metrics?.grossProfit));
    check("single source period (the annual upload itself)",
      result.sourcePeriodIds?.length === 1 && result.sourcePeriodIds[0] === annualPeriodId,
      JSON.stringify(result.sourcePeriodIds));
  }

  console.log("\n-- 5. A confirmed year_to_date upload wins over the monthly roll-up --");
  {
    const ytdPeriodId = await loadDirectPeriod(
      "history-apr.csv", "YTD through April 2026", "year_to_date", "2026-01-01", "2026-04-30", 4);
    const result = await resolveAnnualConstruction(userId, 2026, "ytd");
    check("available", result.available === true, String(result.available));
    check("prefers the confirmed YTD upload over the Jan-Apr monthly roll-up",
      result.source === "confirmed-ytd", result.source);
    check("single source period (the YTD upload itself)",
      result.sourcePeriodIds?.length === 1 && result.sourcePeriodIds[0] === ytdPeriodId,
      JSON.stringify(result.sourcePeriodIds));
  }

  console.log("\n-- 6. Full-year mode sums 12 complete confirmed monthly uploads, no annual upload --");
  {
    // The real bug this reproduces (Neal, live site, 2026-09-06): 12 separate confirmed monthly
    // uploads for a year, zero dedicated annual upload, and Full Year said "No confirmed annual
    // P&L on file" even though the data fully supports a real full year. A fresh year (2027)
    // isolates this from the 2026 annual/YTD uploads added in sections 4-5 above, which would
    // otherwise win the "direct" precedence check before this path is ever reached.
    const YEAR = 2027;
    const monthIds: string[] = [];
    for (let m = 0; m < 12; m++) {
      const start = `${YEAR}-${String(m + 1).padStart(2, "0")}-01`;
      const end = new Date(Date.UTC(YEAR, m + 1, 0)).toISOString().slice(0, 10);
      const label = `${["January","February","March","April","May","June","July","August","September","October","November","December"][m]} ${YEAR}`;
      // Reusing Feb's fixture amounts for every month — this test is about the CONSTRUCTION
      // (does a complete 12-month set get summed at all?), not about distinct dollar figures.
      const id = await loadFixtureUpload("history-feb.csv", label);
      await setupClient.query(
        `UPDATE periods SET period_start = $2, period_end = $3, label = $4 WHERE id = $1`,
        [id, start, end, label]);
      monthIds.push(id);
    }

    const result = await resolveAnnualConstruction(userId, YEAR, "full-year");
    check("available (12 complete confirmed months IS a full year)", result.available === true, String(result.available) + " " + (result.reason ?? ""));
    check("source is monthly-history", result.source === "monthly-history", result.source);
    check("monthsCovered is 12", result.monthsCovered === 12, String(result.monthsCovered));
    check("periodType is annual (it genuinely is a full year now)", result.periodType === "annual", result.periodType);
    check("all 12 source periods included", (result.sourcePeriodIds ?? []).length === 12, String(result.sourcePeriodIds?.length));

    const oneMonth = await loadPeriodMetrics(monthIds[0]);
    const expectedGP = oneMonth.grossProfit * 12; // every month reuses the same fixture amounts
    check(`constructed Gross Profit sums all 12 months ($${expectedGP.toFixed(2)})`,
      Math.abs((result.metrics?.grossProfit ?? NaN) - expectedGP) < 0.01,
      `${result.metrics?.grossProfit} vs ${expectedGP}`);

    // A February-only "full year" for a year with only 1 of 12 months (no December this time
    // either) must still be refused — this section proves the 12-complete-months case works
    // WITHOUT loosening the refusal for a genuinely partial one.
    const partialResult = await resolveAnnualConstruction(userId, 2028, "full-year");
    check("a year with zero data is still refused, not silently treated as available",
      partialResult.available === false, String(partialResult.available));
  }

  console.log("\n-- 7. Mixed sign conventions across periods (the live-site bug, real DB path) --");
  {
    // Fresh year again (2029), hand-built rather than from CSV fixtures: a CSV-style month
    // (expenses stored positive) and a PDF-style month (expenses stored negative, per the real
    // Gemini prompt convention — see server/lib/pdf-parser.ts). Numbers chosen so the OLD
    // concatenate-then-detect bug would have shown OpEx People negative, same shape as
    // scripts/verify-rollups.mjs §9 — this section proves the REAL loadMultiPeriodMetrics(),
    // not just the arithmetic mirror, gets it right.
    const YEAR = 2029;
    const csvMonthId = await loadHandBuiltMonth(YEAR, 0, `January ${YEAR}`, {
      revenue: 500000, fulfillment_cogs: 100000, cac: 100000,
      opex_systems: 100000, opex_people: 10000, tax_strategy: 100000,
    });
    const pdfMonthId = await loadHandBuiltMonth(YEAR, 1, `February ${YEAR}`, {
      revenue: -50000, fulfillment_cogs: -1000, cac: -1000,
      opex_systems: -1000, opex_people: -150000, tax_strategy: -1000,
    });

    const csvMonthMetrics = await loadPeriodMetrics(csvMonthId);
    const pdfMonthMetrics = await loadPeriodMetrics(pdfMonthId);
    check("sanity: CSV-style month alone has positive OpEx People ($10,000)",
      Math.abs(csvMonthMetrics.opexPeople - 10000) < 0.01, String(csvMonthMetrics.opexPeople));
    check("sanity: PDF-style month alone correctly flips to positive OpEx People ($150,000)",
      Math.abs(pdfMonthMetrics.opexPeople - 150000) < 0.01, String(pdfMonthMetrics.opexPeople));

    const result = await resolveAnnualConstruction(userId, YEAR, "ytd");
    check("available", result.available === true, String(result.available) + " " + (result.reason ?? ""));
    check("REAL loadMultiPeriodMetrics: OpEx People is positive, not the -$140,000 the bug produced",
      (result.metrics?.opexPeople ?? NaN) > 0, String(result.metrics?.opexPeople));
    const expectedOpexPeople = csvMonthMetrics.opexPeople + pdfMonthMetrics.opexPeople;
    check(`REAL loadMultiPeriodMetrics: OpEx People equals the sum of each month's own OpEx People ($${expectedOpexPeople.toFixed(2)})`,
      Math.abs((result.metrics?.opexPeople ?? NaN) - expectedOpexPeople) < 0.01,
      `${result.metrics?.opexPeople} vs ${expectedOpexPeople}`);
    const expectedGrossProfit = csvMonthMetrics.grossProfit + pdfMonthMetrics.grossProfit;
    check(`REAL loadMultiPeriodMetrics: Gross Profit equals the sum of each month's own Gross Profit ($${expectedGrossProfit.toFixed(2)})`,
      Math.abs((result.metrics?.grossProfit ?? NaN) - expectedGrossProfit) < 0.01,
      `${result.metrics?.grossProfit} vs ${expectedGrossProfit}`);
  }
} finally {
  await setupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  console.log(`\nDropped ${SCHEMA}.`);
  await setupClient.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
