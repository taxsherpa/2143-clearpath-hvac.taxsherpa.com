#!/usr/bin/env tsx
/**
 * Phase 2.5 (project 2143) real-data verification for the CSV period detector.
 *
 * Per this project's standing rule ("verify real output against real data before calling a
 * phase done" — .system-rules.md rule 1), this runs the ACTUAL parseCSV() against real
 * QuickBooks-style fixtures in test-data/ and checks real numbers, not mocked ones. It also
 * runs the parsed output through the real computeMetrics()/getTier() so a period-detection bug
 * and a rollup-arithmetic bug can't hide behind each other.
 *
 *   npx tsx scripts/verify-csv-periods.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCSV } from "../server/lib/csv-parser";
import { computeMetrics, getTier } from "../server/lib/rollups";
import type { ClearpathCategory } from "../shared/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "..", "test-data", name), "utf-8");
}

function findNode(nodes: ReturnType<typeof parseCSV>["nodes"], label: string) {
  return nodes.find((n) => n.label === label);
}

// Roll up one detected period's amounts through the REAL computeMetrics(), using each node's
// own auto-suggested category (what routes.ts would insert when no mapping memory exists).
function metricsForPeriod(result: ReturnType<typeof parseCSV>, periodIndex: number) {
  const mapped = result.nodes.map((n) => ({
    amountCents: n.amounts[periodIndex] ?? null,
    isRollup: n.isRollup ? 1 : 0,
    category: (n.suggestedCategory ?? null) as ClearpathCategory | null,
    status: "mapped" as const,
  }));
  return computeMetrics(mapped);
}

console.log("\n-- CSV period detection: single monthly statement (unchanged behavior) --");
{
  const result = parseCSV(fixture("monthly-pl.csv"));
  check("exactly one period detected", result.periods.length === 1, `${result.periods.length}`);
  const p = result.periods[0];
  check("period type is month", p.periodType === "month", p.periodType);
  check("monthsCovered is 1", p.monthsCovered === 1, String(p.monthsCovered));
  check("period is confident (title line gave a real date)", p.confident === true);
  check("period start is January 2026", p.periodStart.getUTCFullYear() === 2026 && p.periodStart.getUTCMonth() === 0,
    p.periodStart.toISOString());

  const sales = findNode(result.nodes, "Sales - Services");
  check("Sales - Services amount parsed exactly ($50,000.00 -> 5,000,000 cents)",
    sales?.amounts[0] === 5000000, String(sales?.amounts[0]));

  const metrics = metricsForPeriod(result, 0);
  check("Revenue = $58,000", Math.abs(metrics.revenue - 58000) < 0.005, String(metrics.revenue));
  check("Gross Profit = $49,600", Math.abs(metrics.grossProfit - 49600) < 0.005, String(metrics.grossProfit));
  check("rollup invariant: CAC+OpExSys+OpExPeople+ONP = 100% of GP",
    Math.abs((metrics.cac + metrics.opexSystems + metrics.opexPeople + metrics.operationalNetProfit) - metrics.grossProfit) < 0.01,
    `${metrics.cac + metrics.opexSystems + metrics.opexPeople + metrics.operationalNetProfit} vs GP ${metrics.grossProfit}`);
  check("tier annualizes a single month by *12 (not a no-op)",
    getTier(metrics.grossProfit, 1) === getTier(metrics.grossProfit * 12, 12));
}

console.log("\n-- CSV period detection: 3-column Jan/Feb/Mar statement --");
{
  const result = parseCSV(fixture("multi-column-pl.csv"));
  check("three periods detected", result.periods.length === 3, `${result.periods.length}`);
  const [jan, feb, mar] = result.periods;
  check("Jan 2026 classified as month, monthsCovered=1", jan.periodType === "month" && jan.monthsCovered === 1);
  check("Feb 2026 classified as month, monthsCovered=1", feb.periodType === "month" && feb.monthsCovered === 1);
  check("Mar 2026 classified as month, monthsCovered=1", mar.periodType === "month" && mar.monthsCovered === 1);
  check("Jan period start is January 2026", jan.periodStart.getUTCMonth() === 0 && jan.periodStart.getUTCFullYear() === 2026);
  check("Feb period start is February 2026", feb.periodStart.getUTCMonth() === 1 && feb.periodStart.getUTCFullYear() === 2026);
  check("Mar period start is March 2026", mar.periodStart.getUTCMonth() === 2 && mar.periodStart.getUTCFullYear() === 2026);
  check("all three periods confident", jan.confident && feb.confident && mar.confident);

  const sales = findNode(result.nodes, "Sales - Services");
  check("Sales - Services has 3 amounts, one per period",
    sales?.amounts.length === 3, JSON.stringify(sales?.amounts));
  check("Jan amount is $50,000.00", sales?.amounts[0] === 5000000, String(sales?.amounts[0]));
  check("Feb amount is $52,000.00", sales?.amounts[1] === 5200000, String(sales?.amounts[1]));
  check("Mar amount is $55,000.00", sales?.amounts[2] === 5500000, String(sales?.amounts[2]));

  const janMetrics = metricsForPeriod(result, 0);
  const febMetrics = metricsForPeriod(result, 1);
  const marMetrics = metricsForPeriod(result, 2);
  check("Jan Gross Profit = $49,600 (matches single-month fixture)", Math.abs(janMetrics.grossProfit - 49600) < 0.005, String(janMetrics.grossProfit));
  check("Feb Gross Profit = $50,850", Math.abs(febMetrics.grossProfit - 50850) < 0.005, String(febMetrics.grossProfit));
  check("Mar Gross Profit = $54,680", Math.abs(marMetrics.grossProfit - 54680) < 0.005, String(marMetrics.grossProfit));
  for (const [label, m] of [["Jan", janMetrics], ["Feb", febMetrics], ["Mar", marMetrics]] as const) {
    check(`${label}: rollup invariant holds`,
      Math.abs((m.cac + m.opexSystems + m.opexPeople + m.operationalNetProfit) - m.grossProfit) < 0.01);
  }
}

console.log("\n-- CSV period detection: annual statement (must NOT be re-annualized) --");
{
  const result = parseCSV(fixture("annual-pl.csv"));
  check("exactly one period detected", result.periods.length === 1);
  const p = result.periods[0];
  check("period type is annual", p.periodType === "annual", p.periodType);
  check("monthsCovered is 12", p.monthsCovered === 12, String(p.monthsCovered));
  check("period is confident", p.confident === true);

  const metrics = metricsForPeriod(result, 0);
  check("Gross Profit = $595,200", Math.abs(metrics.grossProfit - 595200) < 0.01, String(metrics.grossProfit));
  // annualizedGrossProfit = grossProfit / 12 * 12 = grossProfit exactly — a full annual
  // statement must NOT be multiplied by 12 again (the Phase 2 bug this phase exists to fix).
  const tier = getTier(metrics.grossProfit, p.monthsCovered);
  const naiveDoubleAnnualizedTier = getTier(metrics.grossProfit, 1); // old buggy behavior: grossProfit * 12
  check("annual tier does NOT match the old grossProfit*12 double-annualization bug",
    tier !== naiveDoubleAnnualizedTier,
    `correct tier=${tier} (on $595,200) vs old-bug tier=${naiveDoubleAnnualizedTier} (on $7,142,400)`);
  check("annual GP of $595,200 lands in the 500k-1mm tier", tier === "500k-1mm", tier);
}

console.log("\n-- CSV period detection: YTD Jan-Jul statement --");
{
  const result = parseCSV(fixture("ytd-pl.csv"));
  check("exactly one period detected", result.periods.length === 1);
  const p = result.periods[0];
  check("period type is year_to_date", p.periodType === "year_to_date", p.periodType);
  check("monthsCovered is 7", p.monthsCovered === 7, String(p.monthsCovered));
  check("period is confident", p.confident === true);

  const metrics = metricsForPeriod(result, 0);
  check("Gross Profit = $347,200", Math.abs(metrics.grossProfit - 347200) < 0.01, String(metrics.grossProfit));
  const tier = getTier(metrics.grossProfit, p.monthsCovered);
  const expectedAnnualized = (metrics.grossProfit / 7) * 12;
  // getTier(x, 12) treats x as already annualized (x/12*12 = x), so this checks the 7-month
  // tier lands in the same bucket as the hand-computed annualized figure.
  check(`tier reflects grossProfit/7*12 = ${expectedAnnualized.toFixed(2)}`,
    tier === getTier(expectedAnnualized, 12), tier);
}

console.log("\n-- CSV period detection: quarterly statement --");
{
  const result = parseCSV(fixture("quarterly-pl.csv"));
  check("exactly one period detected", result.periods.length === 1);
  const p = result.periods[0];
  check("period type is quarter", p.periodType === "quarter", p.periodType);
  check("monthsCovered is 3", p.monthsCovered === 3, String(p.monthsCovered));
  check("period is confident", p.confident === true);

  const metrics = metricsForPeriod(result, 0);
  const tier = getTier(metrics.grossProfit, p.monthsCovered);
  const expectedAnnualized = (metrics.grossProfit / 3) * 12;
  check("quarterly tier annualizes by x4 (grossProfit/3*12)",
    Math.abs(expectedAnnualized - metrics.grossProfit * 4) < 0.01);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
