#!/usr/bin/env tsx
/**
 * Phase 2.5 (project 2143) real-data verification for build requirement #6 — YTD/history
 * tiering precedence — and the missing-month fixture from the PRD's suggested verification.
 *
 * Runs the REAL resolveTieringBasis()/loadPeriodMetrics()/computeMetrics() against a real
 * Postgres database, using a throwaway schema (search_path-scoped, own enum types, own copies
 * of the tables) so production is never touched. Seeds it from the actual CSV fixtures via the
 * actual parseCSV(), the same as scripts/verify-csv-periods.ts, so the whole path — parse,
 * persist, roll up, tier — runs on real code, not a hand-built mock of the precedence rule.
 *
 *   railway run --service ClearPathMapper npx tsx scripts/verify-tiering-precedence.ts
 *   (or against a local Postgres: DATABASE_URL=... npx tsx scripts/verify-tiering-precedence.ts)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = "G:/My Drive/_secure/2143-clearpath-mapper/.env";
const SCHEMA = `phase25_livetest_${process.pid}`;

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
    `INSERT INTO users (email) VALUES ('phase25-livetest@example.com') RETURNING id`)).rows;

  // Load one upload+period+nodes+amounts+mappings into the temp schema from a real CSV fixture,
  // using the real parseCSV() and its real auto-mapped categories.
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

  const janId = await loadFixtureUpload("history-jan.csv", "January 2026");
  const febId = await loadFixtureUpload("history-feb.csv", "February 2026");
  const aprId = await loadFixtureUpload("history-apr.csv", "April 2026");

  // Now point the REAL server code at this schema and run the REAL functions.
  process.env.DATABASE_URL = scopedConnectionString(SCHEMA);
  const { getPeriod, loadPeriodMetrics, resolveTieringBasis, getTier } = await import("../server/lib/rollups");

  console.log("\n-- Missing-month history fixture: Jan, Feb, Apr present, March absent --");
  {
    const aprPeriod = await getPeriod(aprId);
    if (!aprPeriod) throw new Error("April period not found");
    const aprMetrics = await loadPeriodMetrics(aprId);
    const basis = await resolveTieringBasis(userId, aprPeriod, aprMetrics);
    check("does NOT claim monthly-history (March is missing)", basis.source !== "monthly-history", basis.source);
    check("falls back to April's own basis", basis.source === "own", basis.source);
    check("names the missing month (March) in the note", (basis.note ?? "").includes("March"), basis.note ?? "(no note)");
    check("does not silently mix partial history (monthsCovered stays 1, not 3)", basis.monthsCovered === 1, String(basis.monthsCovered));
  }

  console.log("\n-- Full contiguous history: add March, Jan-Mar all present --");
  {
    const marId = await loadFixtureUpload("history-feb.csv", "March 2026 (reusing Feb fixture amounts for a distinct month)");
    // Re-date the "March" upload's period to actually be March, since we borrowed Feb's fixture
    // content for realistic numbers rather than authoring a fourth near-duplicate CSV.
    await setupClient.query(
      `UPDATE periods SET period_start = '2026-03-01', period_end = '2026-03-31', label = 'March 2026' WHERE id = $1`,
      [marId]);

    const aprPeriod = await getPeriod(aprId);
    if (!aprPeriod) throw new Error("April period not found");
    const aprMetrics = await loadPeriodMetrics(aprId);
    const basis = await resolveTieringBasis(userId, aprPeriod, aprMetrics);
    check("uses monthly-history now that Jan-Apr are all present", basis.source === "monthly-history", basis.source);
    check("monthsCovered is 4 (Jan through Apr)", basis.monthsCovered === 4, String(basis.monthsCovered));

    const janMetrics = await loadPeriodMetrics(janId);
    const febMetrics = await loadPeriodMetrics(febId);
    const marMetrics = await loadPeriodMetrics(marId);
    const expectedSum = janMetrics.grossProfit + febMetrics.grossProfit + marMetrics.grossProfit + aprMetrics.grossProfit;
    check(`combined Gross Profit sums the four real months ($${expectedSum.toFixed(2)})`,
      Math.abs(basis.grossProfit - expectedSum) < 0.01, `${basis.grossProfit} vs ${expectedSum}`);
  }

  console.log("\n-- Confirmed annual upload takes precedence over monthly history --");
  {
    const annualResult = await fixtureCsvNodesAndPeriod("annual-pl.csv");
    const ap = annualResult.periods[0];
    // Same calendar year (2026) as the April statement being reported, so it should outrank the
    // Jan-Apr monthly roll-up per build requirement #6's precedence order.
    const [{ id: annualUploadId }] = (await setupClient.query(
      `INSERT INTO uploads (user_id, original_filename, month_start) VALUES ($1,'annual-pl.csv','2026-01-01') RETURNING id`,
      [userId])).rows;
    const [{ id: annualPeriodId }] = (await setupClient.query(
      `INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
       VALUES ($1,'2026-01-01','2026-12-31','annual',12,'FY2026',0,true) RETURNING id`,
      [annualUploadId])).rows;
    for (const node of annualResult.nodes) {
      const [{ id: nodeId }] = (await setupClient.query(
        `INSERT INTO pl_nodes (upload_id, label, level, display_order, is_rollup, source_path) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [annualUploadId, node.label, node.level, node.displayOrder, node.isRollup ? 1 : 0, node.sourcePath])).rows;
      const amount = node.amounts[0];
      if (amount !== null && amount !== undefined) {
        await setupClient.query(`INSERT INTO pl_node_period_amounts (node_id, period_id, amount_cents) VALUES ($1,$2,$3)`,
          [nodeId, annualPeriodId, amount]);
      }
      if (!node.isRollup && node.suggestedCategory) {
        await setupClient.query(`INSERT INTO category_mappings (node_id, clearpath_category, confidence) VALUES ($1,$2,$3)`,
          [nodeId, node.suggestedCategory, node.confidence ?? "medium"]);
      }
    }

    const aprPeriod = await getPeriod(aprId);
    if (!aprPeriod) throw new Error("April period not found");
    const aprMetrics = await loadPeriodMetrics(aprId);
    const basis = await resolveTieringBasis(userId, aprPeriod, aprMetrics);
    check("prefers the confirmed annual upload over monthly history", basis.source === "confirmed-annual", basis.source);
    check("uses the annual statement's own Gross Profit ($595,200)", Math.abs(basis.grossProfit - 595200) < 0.01, String(basis.grossProfit));
    check("uses the annual statement's monthsCovered (12)", basis.monthsCovered === 12, String(basis.monthsCovered));
  }
} finally {
  await setupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  console.log(`\nDropped ${SCHEMA}.`);
  await setupClient.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
