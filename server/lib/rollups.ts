import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { plNodes, categoryMappings, periods, plNodePeriodAmounts, uploads } from "@shared/schema";
import type { ClearpathCategory, Period } from "@shared/schema";
import { formatPeriodRange, describePeriodBasis } from "@shared/period";
import { METRIC_ORDER, METRIC_LABELS } from "@shared/categories";

/**
 * The one and only rollup implementation.
 *
 * There used to be three copies of this arithmetic in `routes.ts` — the on-screen report, the
 * PDF export, and `getUploadMetrics()` behind `/api/comparisons` — and they had already
 * drifted: the third subtracted taxes where the other two didn't, and the first invented a
 * 15%-of-revenue tax figure that was never mapped data at all. The Comparison page and the
 * report showed different profit for the same upload. Everything now reads from here.
 */

export interface MappedNode {
  amountCents: number | null;
  isRollup: number;
  category: ClearpathCategory | null;
  status: "mapped" | "excluded" | null;
}

export interface Metrics {
  revenue: number;
  fulfillmentCogs: number;
  fulfillmentServices: number;
  fulfillment: number;
  fulfillmentPct: number | null;
  grossProfit: number;
  cac: number;
  cacPct: number | null;
  opexSystems: number;
  opexSystemsPct: number | null;
  opexPeople: number;
  opexPeoplePct: number | null;
  operationalNetProfit: number;
  operationalNetProfitPct: number | null;
  taxStrategy: number;
  taxStrategyPct: number | null;
  taxableNetProfit: number;
  taxableNetProfitPct: number | null;
}

const EMPTY_TOTALS: Record<ClearpathCategory, number> = {
  revenue: 0,
  fulfillment_cogs: 0,
  fulfillment_services: 0,
  cac: 0,
  opex_systems: 0,
  opex_people: 0,
  tax_strategy: 0,
};

/**
 * A line counts only if it has an amount, is not a rollup row, is mapped to a category, and
 * has not been excluded by the user. The `status` check is the whole point of the excluded
 * state: without it, a subtotal the parser misjudged as a leaf gets summed alongside its own
 * children, which is the double-count this phase exists to fix.
 */
function countsTowardTotals(node: MappedNode): boolean {
  return (
    node.amountCents !== null &&
    node.isRollup === 0 &&
    node.category !== null &&
    node.status !== "excluded"
  );
}

/** The six mappable categories' dollar totals, sign-normalized — see `normalizeCategoryTotals`. */
interface NormalizedTotals {
  revenue: number;
  fulfillmentCogs: number;
  fulfillmentServices: number;
  cac: number;
  opexSystems: number;
  opexPeople: number;
  taxStrategy: number;
}

/**
 * Sum a set of nodes' amounts by category, then normalize sign — split out of `computeMetrics`
 * so Phase 2.6's multi-period construction can normalize EACH PERIOD separately before summing
 * them (see `loadMultiPeriodMetrics`), rather than detecting one sign convention across nodes
 * that may span several uploads.
 *
 * The two intake paths disagree on convention, and the rollup used to assume one of them.
 *
 * A QuickBooks CSV export lists expenses as POSITIVE numbers. The PDF path's Gemini prompt
 * instructs the opposite — "use negative for expenses, positive for income" — so a
 * PDF-sourced upload stores every cost as a negative. The old arithmetic applied Math.abs()
 * to revenue only and subtracted the rest as-is, so on a PDF upload it *added* every cost:
 * Gross Profit came out larger than revenue and Operational Net Profit read 173.8% of it.
 * This predates Phase 2 — the three old rollup copies all did it — so every PDF-sourced
 * report has been wrong, not just since the model changed.
 *
 * Detect the convention per upload rather than per line: if the expense side sums negative,
 * this upload files costs as negatives, so flip the whole expense side. Doing it at the
 * upload level (not with a blanket Math.abs per category) preserves genuine contra lines —
 * a refund inside revenue, a net credit inside an expense category — instead of silently
 * turning a credit into a cost.
 */
function normalizeCategoryTotals(nodes: MappedNode[]): NormalizedTotals {
  const totals = { ...EMPTY_TOTALS };

  for (const node of nodes) {
    if (countsTowardTotals(node)) {
      totals[node.category!] += node.amountCents!;
    }
  }

  const EXPENSE_KEYS: ClearpathCategory[] = [
    "fulfillment_cogs", "fulfillment_services", "cac",
    "opex_systems", "opex_people", "tax_strategy",
  ];
  const expenseSum = EXPENSE_KEYS.reduce((acc, k) => acc + totals[k], 0);
  const expenseSign = expenseSum < 0 ? -1 : 1;

  const expense = (cents: number) => (expenseSign * cents) / 100;

  // Revenue arrives negative on some P&L exports and positive on others; the sign carries no
  // information here, only the magnitude does.
  return {
    revenue: Math.abs(totals.revenue / 100),
    fulfillmentCogs: expense(totals.fulfillment_cogs),
    fulfillmentServices: expense(totals.fulfillment_services),
    cac: expense(totals.cac),
    opexSystems: expense(totals.opex_systems),
    opexPeople: expense(totals.opex_people),
    taxStrategy: expense(totals.tax_strategy),
  };
}

function sumNormalizedTotals(list: NormalizedTotals[]): NormalizedTotals {
  return list.reduce(
    (acc, t) => ({
      revenue: acc.revenue + t.revenue,
      fulfillmentCogs: acc.fulfillmentCogs + t.fulfillmentCogs,
      fulfillmentServices: acc.fulfillmentServices + t.fulfillmentServices,
      cac: acc.cac + t.cac,
      opexSystems: acc.opexSystems + t.opexSystems,
      opexPeople: acc.opexPeople + t.opexPeople,
      taxStrategy: acc.taxStrategy + t.taxStrategy,
    }),
    { revenue: 0, fulfillmentCogs: 0, fulfillmentServices: 0, cac: 0, opexSystems: 0, opexPeople: 0, taxStrategy: 0 },
  );
}

/** The derived rollup (Gross Profit, Operational Net Profit, percentages, ...) from already
 *  sign-normalized category totals. Pure arithmetic — no sign detection happens here. */
function deriveMetrics(t: NormalizedTotals): Metrics {
  const fulfillment = t.fulfillmentCogs + t.fulfillmentServices;

  // Gross Profit is the framework's 100% baseline: every benchmark below this line is a
  // percentage of it, not of revenue.
  const grossProfit = t.revenue - fulfillment;

  // BASECAMP metric. Owner compensation is deliberately NOT subtracted here — it lives below
  // the line in tax_strategy. This is the same quantity the ClearPath framework calls
  // "Owner Net Benefit" (the Remainder), which is why it carries a benchmark.
  const operationalNetProfit = grossProfit - t.cac - t.opexSystems - t.opexPeople;

  // ASCENT metric. A good Ascent minimises this legally, without damaging the line above.
  const taxableNetProfit = operationalNetProfit - t.taxStrategy;

  const pctOfGp = (value: number) => (grossProfit > 0 ? (value / grossProfit) * 100 : null);

  return {
    revenue: t.revenue,
    fulfillmentCogs: t.fulfillmentCogs,
    fulfillmentServices: t.fulfillmentServices,
    fulfillment,
    fulfillmentPct: t.revenue > 0 ? (fulfillment / t.revenue) * 100 : null,
    grossProfit,
    cac: t.cac,
    cacPct: pctOfGp(t.cac),
    opexSystems: t.opexSystems,
    opexSystemsPct: pctOfGp(t.opexSystems),
    opexPeople: t.opexPeople,
    opexPeoplePct: pctOfGp(t.opexPeople),
    operationalNetProfit,
    operationalNetProfitPct: pctOfGp(operationalNetProfit),
    taxStrategy: t.taxStrategy,
    taxStrategyPct: pctOfGp(t.taxStrategy),
    taxableNetProfit,
    taxableNetProfitPct: pctOfGp(taxableNetProfit),
  };
}

export function computeMetrics(nodes: MappedNode[]): Metrics {
  return deriveMetrics(normalizeCategoryTotals(nodes));
}

/**
 * Reads one PERIOD's nodes and rolls them up (Phase 2.5: a node's amount is now period-
 * specific, via `pl_node_period_amounts`; the node and its category mapping are shared across
 * every period in the same upload). Used by the report, both exports, and comparisons.
 */
export async function loadPeriodMetrics(periodId: string): Promise<Metrics> {
  return computeMetrics((await loadPeriodNodes(periodId)) as MappedNode[]);
}

/**
 * The same rows `loadPeriodMetrics` sums, with each line's label kept.
 *
 * The label is what lets the HVAC scorecard notice owner pay sitting inside operating expenses —
 * the one thing that makes a shop's numbers incomparable to benchmarks that exclude it.
 */
export async function loadPeriodNodes(periodId: string) {
  return db
    .select({
      label: plNodes.label,
      amountCents: plNodePeriodAmounts.amountCents,
      isRollup: plNodes.isRollup,
      category: categoryMappings.clearpathCategory,
      status: categoryMappings.status,
    })
    .from(plNodePeriodAmounts)
    .innerJoin(plNodes, eq(plNodePeriodAmounts.nodeId, plNodes.id))
    .leftJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
    .where(eq(plNodePeriodAmounts.periodId, periodId));
}

/**
 * All periods belonging to one upload, chronological. A single-column monthly CSV or a PDF
 * produces one row; a multi-column CSV produces several, sharing the same pl_nodes.
 */
export async function getUploadPeriods(uploadId: string): Promise<Period[]> {
  return db.select().from(periods).where(eq(periods.uploadId, uploadId)).orderBy(periods.displayOrder);
}

export async function getPeriod(periodId: string): Promise<Period | undefined> {
  const [p] = await db.select().from(periods).where(eq(periods.id, periodId));
  return p;
}

/**
 * Reads several periods' nodes in one query and rolls them up together — the multi-period
 * equivalent of `loadPeriodMetrics`. Used for Phase 2.6's constructed annual/YTD views, where a
 * displayed figure is the SUM of several confirmed monthly uploads rather than one period's own
 * rows.
 *
 * Goes through the same category-total arithmetic (`deriveMetrics`) every other report uses, so
 * this is a new view over existing arithmetic, not a second rollup implementation — BUT it does
 * NOT concatenate every period's rows into one array and call `computeMetrics` once on the
 * result. An earlier version did exactly that, on the (wrong) assumption that "summing before
 * forming category totals is equivalent to summing after." It isn't, once the sign-convention
 * detection in `normalizeCategoryTotals` is in play: that detection runs once per call, over
 * whatever rows it's given. Twelve months summed into one report can easily span both a
 * CSV-sourced month (expenses stored positive) and a PDF-sourced month (expenses stored
 * negative) — see the note on `normalizeCategoryTotals` — and concatenating them first meant one
 * global sign guess got applied to every row, silently flipping whichever months disagreed with
 * the majority. Reported live (Neal, 2026-09-06): Fulfillment read wrong relative to revenue and
 * OpEx People came out negative (-$123,744) on a constructed full year.
 *
 * Fixed by normalizing EACH period's rows independently — the same per-upload sign detection a
 * single-period report already gets — and summing the resulting (already sign-correct) dollar
 * totals, THEN deriving Gross Profit / Operational Net Profit / percentages once from that sum.
 */
export async function loadMultiPeriodMetrics(periodIds: string[]): Promise<Metrics> {
  if (periodIds.length === 0) {
    return computeMetrics([]);
  }
  const rows = await db
    .select({
      periodId: plNodePeriodAmounts.periodId,
      amountCents: plNodePeriodAmounts.amountCents,
      isRollup: plNodes.isRollup,
      category: categoryMappings.clearpathCategory,
      status: categoryMappings.status,
    })
    .from(plNodePeriodAmounts)
    .innerJoin(plNodes, eq(plNodePeriodAmounts.nodeId, plNodes.id))
    .leftJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
    .where(inArray(plNodePeriodAmounts.periodId, periodIds));

  const byPeriod = new Map<string, MappedNode[]>();
  for (const row of rows) {
    const list = byPeriod.get(row.periodId) ?? [];
    list.push(row as MappedNode);
    byPeriod.set(row.periodId, list);
  }

  const perPeriodTotals = periodIds.map(id => normalizeCategoryTotals(byPeriod.get(id) ?? []));
  return deriveMetrics(sumNormalizedTotals(perPeriodTotals));
}

/**
 * Tiering is on annualized GROSS PROFIT, not revenue, and — Phase 2.5 — on the ACTUAL length of
 * the period, not a blind `* 12`.
 *
 * The Phase 2 code tiered on `grossProfit * 12` unconditionally, which is only correct for a
 * single calendar month. Applied to a full annual P&L (monthsCovered = 12) that would 12x an
 * already-annual number; applied to a YTD Jan-July statement (monthsCovered = 7) it should
 * divide by 7 and annualize from the monthly average, not multiply the 7-month total by 12.
 */
export function getTier(grossProfit: number, monthsCovered: number = 1): string {
  const months = monthsCovered > 0 ? monthsCovered : 1;
  const annualizedGrossProfit = (grossProfit / months) * 12;
  if (annualizedGrossProfit < 250000) return "under-250k";
  if (annualizedGrossProfit < 500000) return "250k-500k";
  if (annualizedGrossProfit < 1000000) return "500k-1mm";
  if (annualizedGrossProfit < 5000000) return "1mm-5mm";
  return "5mm-plus";
}

export interface TieringBasis {
  /** What actually fed the tier: this statement's own period, a confirmed YTD/annual upload
   *  elsewhere, or a roll-up of contiguous confirmed monthly uploads for the current year. */
  source: "own" | "confirmed-annual" | "confirmed-ytd" | "monthly-history";
  grossProfit: number;
  monthsCovered: number;
  periodType: Period["periodType"];
  /** Named for the UI when history was attempted but a month was missing, or when a
   *  confirmed-annual/YTD upload was preferred over the statement being viewed. */
  note?: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Which confirmed single-month periods, from January through `throughMonthIndex` (0-based,
 * inclusive) of `targetYear`, are present vs. missing. Shared by `resolveTieringBasis` (Build
 * requirement #6) and Phase 2.6's constructed YTD display — both need the identical "every
 * intervening month present, else name the missing one" rule, and this is the one place it's
 * computed so they can't drift apart.
 */
function findContiguousMonths(
  monthlyPeriods: Period[],
  targetYear: number,
  throughMonthIndex: number,
): { present: Period[]; missing: string[] } {
  const byMonthIndex = new Map<number, Period>();
  for (const p of monthlyPeriods) {
    if (new Date(p.periodStart).getUTCFullYear() === targetYear) {
      byMonthIndex.set(new Date(p.periodStart).getUTCMonth(), p);
    }
  }

  const missing: string[] = [];
  const present: Period[] = [];
  for (let m = 0; m <= throughMonthIndex; m++) {
    const p = byMonthIndex.get(m);
    if (p) present.push(p);
    else missing.push(MONTH_NAMES[m]);
  }
  return { present, missing };
}

/** "3 months (Feb-Apr)" for a long gap, else the plain comma list — keeps basis text a sentence. */
function summarizeMissingMonths(missing: string[]): string {
  return missing.length <= 3
    ? missing.join(", ")
    : `${missing.length} months (${missing[0]}-${missing[missing.length - 1]})`;
}

/**
 * Build requirement #6 — YTD/history tiering precedence, evaluated for the period currently
 * being reported (`targetPeriod`), scoped to its own user:
 *
 *   1. Prefer a CONFIRMED annual or YTD upload that covers the same calendar year (any upload,
 *      not just the one being viewed) — a real annual/YTD statement is better evidence than a
 *      roll-up of individual months. When more than one qualifies, the one with the latest
 *      period end (most complete) wins.
 *   2. Otherwise, if the target period is itself a single month, look for CONFIRMED monthly
 *      uploads covering every month from January through the target's month, inclusive, for
 *      the same year. If all intervening months are present, tier on their combined Gross
 *      Profit (sum) divided by that month count.
 *   3. Otherwise, fall back to the target statement's own monthsCovered/grossProfit — and if a
 *      history roll-up was attempted and came up short, name the missing month(s) rather than
 *      silently mixing partial history (never guess by leaving a gap unmentioned).
 */
export async function resolveTieringBasis(
  userId: string,
  targetPeriod: Period,
  targetMetrics: Metrics,
): Promise<TieringBasis> {
  const targetYear = new Date(targetPeriod.periodEnd).getUTCFullYear();
  const own: TieringBasis = {
    source: "own",
    grossProfit: targetMetrics.grossProfit,
    monthsCovered: targetPeriod.monthsCovered,
    periodType: targetPeriod.periodType,
  };

  // All of this user's periods, upload-joined, so history can be assembled across uploads.
  const userPeriods = await db
    .select({ period: periods, uploadId: uploads.id })
    .from(periods)
    .innerJoin(uploads, eq(periods.uploadId, uploads.id))
    .where(eq(uploads.userId, userId));

  // ---- Step 1: a confirmed annual/YTD upload for the same year -------------------------------
  const annualOrYtd = userPeriods
    .map(r => r.period)
    .filter(p =>
      p.confirmed &&
      (p.periodType === "annual" || p.periodType === "year_to_date") &&
      new Date(p.periodEnd).getUTCFullYear() === targetYear,
    )
    .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime());

  if (annualOrYtd.length > 0) {
    const best = annualOrYtd[0];
    if (best.id === targetPeriod.id) {
      return { ...own, source: best.periodType === "annual" ? "confirmed-annual" : "confirmed-ytd" };
    }
    const metrics = await loadPeriodMetrics(best.id);
    return {
      source: best.periodType === "annual" ? "confirmed-annual" : "confirmed-ytd",
      grossProfit: metrics.grossProfit,
      monthsCovered: best.monthsCovered,
      periodType: best.periodType,
      note: `using ${best.label} instead of this statement's own period`,
    };
  }

  // ---- Step 2: contiguous confirmed Jan-through-current monthly uploads ----------------------
  if (targetPeriod.periodType === "month" && targetPeriod.monthsCovered === 1) {
    const targetMonthIndex = new Date(targetPeriod.periodStart).getUTCMonth(); // 0-based
    const monthlyPeriods = userPeriods
      .map(r => r.period)
      .filter(p => p.confirmed && p.periodType === "month" && p.monthsCovered === 1);

    const { present, missing } = findContiguousMonths(monthlyPeriods, targetYear, targetMonthIndex);

    if (missing.length === 0 && present.length > 0) {
      let sumGrossProfit = 0;
      for (const p of present) {
        const metrics = p.id === targetPeriod.id ? targetMetrics : await loadPeriodMetrics(p.id);
        sumGrossProfit += metrics.grossProfit;
      }
      const rangeLabel = targetMonthIndex === 0
        ? `${MONTH_NAMES[0]} ${targetYear}`
        : `${MONTH_NAMES[0]}-${MONTH_NAMES[targetMonthIndex]} ${targetYear}`;
      return {
        source: "monthly-history",
        grossProfit: sumGrossProfit,
        monthsCovered: present.length,
        periodType: "month",
        note: `${rangeLabel}, ${present.length} confirmed monthly statement${present.length === 1 ? "" : "s"}`,
      };
    }

    if (missing.length > 0 && present.length > 0) {
      // Never silently mix partial history — name what's missing and fall back to the
      // statement's own basis rather than pretending the gap doesn't matter. A long missing
      // list (e.g. reporting December with no prior months this year) is summarized rather
      // than enumerated in full, so the basis text stays a sentence, not a list.
      return { ...own, note: `missing ${summarizeMissingMonths(missing)} — using this statement's own period instead of partial YTD history` };
    }
  }

  // ---- Step 3: fall back to the statement's own basis -----------------------------------------
  return own;
}

export interface AnnualConstruction {
  available: boolean;
  /** Which real periods fed the figure — needed by exports that want the underlying line items. */
  sourcePeriodIds: string[];
  source?: "confirmed-annual" | "confirmed-ytd" | "monthly-history";
  metrics?: Metrics;
  monthsCovered?: number;
  periodType?: Period["periodType"];
  /** Feeds `describePeriodBasis` — reuse that formatter rather than inventing a second one. */
  note?: string;
  /** Set only when `available` is false: why no annual/YTD figure could be built. */
  reason?: string;
}

/**
 * Phase 2.6 — build a full-year or year-to-date figure for display, the same way
 * `resolveTieringBasis` already builds one for tiering, but returning the full `Metrics` (every
 * category, not just Gross Profit) since this feeds a report screen rather than a tier lookup.
 *
 * `mode: "full-year"` prefers a confirmed ANNUAL upload covering `year`; otherwise, if all 12
 * confirmed monthly uploads for `year` are on file (January through December, no gaps), sums
 * them into the year instead — 12 *complete* months genuinely are a full year, not an
 * approximation of one. It refuses only a PARTIAL set: summing fewer than 12 months into
 * something labeled "a full year" would misrepresent it as complete, so anything short of all
 * 12 reports unavailable (naming what's missing) rather than guessing.
 *
 * `mode: "ytd"` mirrors `resolveTieringBasis`'s own precedence: prefer a confirmed
 * `year_to_date` upload for the year (a real YTD statement is better evidence than a roll-up of
 * individual months); otherwise sum contiguous confirmed monthly uploads from January through
 * the latest confirmed month of `year`, and refuse to produce a partial-year figure silently —
 * if a month is missing before the latest present one, name it and report unavailable rather
 * than showing a "year-to-date" sum missing a month with no indication.
 */
export async function resolveAnnualConstruction(
  userId: string,
  year: number,
  mode: "full-year" | "ytd",
): Promise<AnnualConstruction> {
  const userPeriods = await db
    .select({ period: periods, uploadId: uploads.id })
    .from(periods)
    .innerJoin(uploads, eq(periods.uploadId, uploads.id))
    .where(eq(uploads.userId, userId));

  const wantedType = mode === "full-year" ? "annual" : "year_to_date";
  const direct = userPeriods
    .map(r => r.period)
    .filter(p => p.confirmed && p.periodType === wantedType && new Date(p.periodEnd).getUTCFullYear() === year)
    .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime());

  if (direct.length > 0) {
    const best = direct[0];
    const metrics = await loadPeriodMetrics(best.id);
    return {
      available: true,
      sourcePeriodIds: [best.id],
      source: mode === "full-year" ? "confirmed-annual" : "confirmed-ytd",
      metrics,
      monthsCovered: best.monthsCovered,
      periodType: best.periodType,
      note: mode === "full-year" ? `from your ${year} annual upload` : `from your confirmed YTD upload (${best.label})`,
    };
  }

  if (mode === "full-year") {
    // Before giving up, say what actually IS on file — a real case (Neal, 2026-09-06) was an
    // 11-month Jan-Nov multi-column upload the user believed was "a full year," which this mode
    // deliberately does NOT treat as one (see the doc comment above): naming the gap turns "no
    // confirmed annual P&L" from a dead end into an explanation of why Year-to-Date is the right
    // view for that data, rather than a bug report.
    //
    // A second real case surfaced immediately after: Neal reported "December 2025 is there as a
    // separate upload," which the missing-month message above had no way to distinguish from
    // "December was never uploaded at all" — the message only looked at periods that passed the
    // CONFIRMED month-type filter, so a December upload sitting there unconfirmed, or filed
    // under a period type other than a plain single month, was invisible to it and silently
    // read as absent. Every reason below now ends with an inventory of every period this user
    // has for the year — confirmed or not, whatever type — precisely so "missing" and "present
    // but not counted for some other reason" are never conflated again.
    const periodsThisYear = userPeriods
      .map(r => r.period)
      .filter(p =>
        new Date(p.periodStart).getUTCFullYear() === year ||
        new Date(p.periodEnd).getUTCFullYear() === year,
      )
      .sort((a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime());

    const inventory = periodsThisYear.length > 0
      ? "On file for " + year + ": " + periodsThisYear
          .map(p => `"${p.label}" (${p.periodType}${p.monthsCovered !== 1 ? `, ${p.monthsCovered}mo` : ""}${p.confirmed ? "" : ", NOT YET CONFIRMED"})`)
          .join("; ") + "."
      : `Nothing on file for ${year} at all.`;

    const yearToDateUpload = periodsThisYear
      .filter(p => p.confirmed && p.periodType === "year_to_date")
      .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())[0];

    if (yearToDateUpload) {
      return {
        available: false,
        sourcePeriodIds: [],
        reason: `Your most complete ${year} data on file is "${yearToDateUpload.label}" `
          + `(${yearToDateUpload.monthsCovered} month${yearToDateUpload.monthsCovered === 1 ? "" : "s"}), not a full year. `
          + `Upload a confirmed annual P&L for ${year}, or view Year-to-Date instead. ${inventory}`,
      };
    }

    const monthlyPeriodsForYear = periodsThisYear
      .filter(p => p.confirmed && p.periodType === "month" && p.monthsCovered === 1);

    if (monthlyPeriodsForYear.length > 0) {
      const DECEMBER = 11;
      const { present, missing } = findContiguousMonths(monthlyPeriodsForYear, year, DECEMBER);

      // All 12 confirmed months are on file. This genuinely IS a full year — the PRD originally
      // scoped "full year" as reading only a dedicated confirmed annual upload, but real data
      // (Neal, 2026-09-06: 12 separate confirmed monthly uploads for 2025, no annual upload at
      // all) showed that requirement was too narrow: refusing to sum 12 *complete* months into
      // a year is not the same caution as refusing to sum a partial set (which stays refused
      // below). Reuses the same loadMultiPeriodMetrics() the YTD monthly-history path already
      // uses — this is that same construction, just spanning the whole calendar year instead of
      // stopping at whatever month is latest.
      if (missing.length === 0) {
        const metrics = await loadMultiPeriodMetrics(present.map(p => p.id));
        return {
          available: true,
          sourcePeriodIds: present.map(p => p.id),
          source: "monthly-history",
          metrics,
          monthsCovered: 12,
          periodType: "annual",
          note: `summed from 12 confirmed monthly statements`,
        };
      }

      return {
        available: false,
        sourcePeriodIds: [],
        reason: `Your ${year} monthly statements cover ${present.length} of 12 months, missing `
          + `${summarizeMissingMonths(missing)}. Upload a confirmed annual P&L for ${year}, or `
          + `view Year-to-Date instead. ${inventory}`,
      };
    }

    return {
      available: false,
      sourcePeriodIds: [],
      reason: `No confirmed annual P&L on file for ${year} — upload one, or view year-to-date instead. ${inventory}`,
    };
  }

  // mode === "ytd": fall back to summing contiguous confirmed monthly uploads for the year.
  const monthlyPeriods = userPeriods
    .map(r => r.period)
    .filter(p => p.confirmed && p.periodType === "month" && p.monthsCovered === 1)
    .filter(p => new Date(p.periodStart).getUTCFullYear() === year);

  if (monthlyPeriods.length === 0) {
    return {
      available: false,
      sourcePeriodIds: [],
      reason: `No confirmed monthly statements on file for ${year} yet.`,
    };
  }

  // The latest month actually on file for this year is the YTD's "current" month — Phase 2.6
  // shows YTD through whatever the user has uploaded, not through today's calendar date, which
  // would just as often be a future month nothing has been uploaded for yet.
  const latestMonthIndex = Math.max(
    ...monthlyPeriods.map(p => new Date(p.periodStart).getUTCMonth()),
  );

  return buildMonthlyHistoryYtd(monthlyPeriods, year, latestMonthIndex);
}

/**
 * The pure "sum contiguous confirmed months, January through `throughMonthIndex`" arithmetic,
 * shared by `resolveAnnualConstruction`'s own ytd branch above (which computes
 * `throughMonthIndex` as the latest month on file before calling this) and
 * `resolveYtdThroughMonth` below (Phase 2.7 — which takes an explicit, caller-supplied index
 * instead, so a PRIOR year can be summed through the SAME calendar month a current-year YTD
 * stopped at, rather than that prior year's own latest month).
 */
async function buildMonthlyHistoryYtd(
  monthlyPeriodsForYear: Period[],
  year: number,
  throughMonthIndex: number,
): Promise<AnnualConstruction> {
  const { present, missing } = findContiguousMonths(monthlyPeriodsForYear, year, throughMonthIndex);

  if (missing.length > 0) {
    return {
      available: false,
      sourcePeriodIds: [],
      reason: `Missing ${summarizeMissingMonths(missing)} — every month from January through `
        + `${MONTH_NAMES[throughMonthIndex]} must be present to build a year-to-date summary for ${year}.`,
    };
  }

  const metrics = await loadMultiPeriodMetrics(present.map(p => p.id));
  const rangeLabel = throughMonthIndex === 0
    ? `${MONTH_NAMES[0]} ${year}`
    : `${MONTH_NAMES[0]}-${MONTH_NAMES[throughMonthIndex]} ${year}`;

  return {
    available: true,
    sourcePeriodIds: present.map(p => p.id),
    source: "monthly-history",
    metrics,
    monthsCovered: present.length,
    periodType: "year_to_date",
    note: `${rangeLabel}, ${present.length} confirmed monthly statement${present.length === 1 ? "" : "s"}`,
  };
}

/**
 * Phase 2.7 — sum contiguous confirmed monthly periods for `year`, January through
 * `throughMonthIndex` (0-based, inclusive), with NO precedence check against a confirmed
 * year_to_date/annual upload for that year (contrast `resolveAnnualConstruction`, which checks
 * that precedence first and falls back to the same monthly-history summation via
 * `buildMonthlyHistoryYtd` above).
 *
 * Built for the Year-to-Date-over-YTD comparison mode (`resolveYtdOverYtd` below), which needs
 * to build a PRIOR year's YTD figure through the EXACT same month the current year's YTD stopped
 * at — a real requirement distinct from "what's the best evidence for last year's YTD on its
 * own." A confirmed annual or year_to_date upload for the prior year might cover a different
 * span entirely (e.g. a full 12 months, or YTD through a different month), and there is no way
 * to slice a single already-summed period down to just the months a comparison needs — only the
 * underlying monthly periods can be summed to an exact match. So this function deliberately
 * skips the "confirmed upload wins" precedence and always builds from monthly history, even when
 * a confirmed annual/YTD upload exists for the year.
 */
export async function resolveYtdThroughMonth(
  userId: string,
  year: number,
  throughMonthIndex: number,
): Promise<AnnualConstruction> {
  const userPeriods = await db
    .select({ period: periods, uploadId: uploads.id })
    .from(periods)
    .innerJoin(uploads, eq(periods.uploadId, uploads.id))
    .where(eq(uploads.userId, userId));

  const monthlyPeriods = userPeriods
    .map(r => r.period)
    .filter(p => p.confirmed && p.periodType === "month" && p.monthsCovered === 1)
    .filter(p => new Date(p.periodStart).getUTCFullYear() === year);

  if (monthlyPeriods.length === 0) {
    return {
      available: false,
      sourcePeriodIds: [],
      reason: `No confirmed monthly statements on file for ${year} yet.`,
    };
  }

  return buildMonthlyHistoryYtd(monthlyPeriods, year, throughMonthIndex);
}

/**
 * Phase 2.7 — Compare reports expansion.
 *
 * One period (or synthetic multi-month window) participating in a comparison. `periodId` and
 * `uploadId` are null for a synthetic window (a rolling quarter, or a YTD-over-YTD span) that
 * isn't itself one stored `periods` row — `sourcePeriodIds` always names the real periods that
 * were summed, real or singular.
 */
export interface ComparisonPeriodResult {
  periodId: string | null;
  uploadId: string | null;
  sourcePeriodIds: string[];
  periodLabel: string;
  periodBasis: string;
  monthsCovered: number;
  periodType: Period["periodType"];
  metrics: Metrics;
  /** For chronological sorting/labeling — the real calendar end of what this period covers. */
  periodEnd: Date;
}

export interface ComparisonModeResult {
  available: boolean;
  /** Set only when `available` is false: why this mode couldn't be built from what's on file. */
  reason?: string;
  periods?: ComparisonPeriodResult[];
}

function toComparisonPeriod(period: Period, metrics: Metrics): ComparisonPeriodResult {
  return {
    periodId: period.id,
    uploadId: period.uploadId,
    sourcePeriodIds: [period.id],
    periodLabel: formatPeriodRange(period.periodStart, period.periodEnd, period.periodType),
    periodBasis: describePeriodBasis(period.periodType, period.monthsCovered),
    monthsCovered: period.monthsCovered,
    periodType: period.periodType,
    metrics,
    periodEnd: new Date(period.periodEnd),
  };
}

/** A synthetic multi-month window (a rolling quarter) built from several real monthly periods. */
function toWindowComparisonPeriod(
  window: Period[],
  metrics: Metrics,
  periodType: Period["periodType"],
): ComparisonPeriodResult {
  const start = window[0].periodStart;
  const end = window[window.length - 1].periodEnd;
  return {
    periodId: null,
    uploadId: null,
    sourcePeriodIds: window.map(p => p.id),
    periodLabel: formatPeriodRange(start, end, periodType),
    periodBasis: describePeriodBasis(periodType, window.length, `${window.length} confirmed monthly statements`),
    monthsCovered: window.length,
    periodType,
    metrics,
    periodEnd: new Date(end),
  };
}

/** Every confirmed single-month period this user has, across every year, ascending by start date. */
async function loadAllConfirmedMonths(userId: string): Promise<Period[]> {
  const rows = await db
    .select({ period: periods, uploadId: uploads.id })
    .from(periods)
    .innerJoin(uploads, eq(periods.uploadId, uploads.id))
    .where(eq(uploads.userId, userId));

  return rows
    .map(r => r.period)
    .filter(p => p.confirmed && p.periodType === "month" && p.monthsCovered === 1)
    .sort((a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime());
}

/** True when `nextStart` is the calendar month immediately after `prevStart` — no gap. */
function isNextCalendarMonth(prevStart: Date, nextStart: Date): boolean {
  const expected = new Date(Date.UTC(prevStart.getUTCFullYear(), prevStart.getUTCMonth() + 1, 1));
  return expected.getUTCFullYear() === nextStart.getUTCFullYear() && expected.getUTCMonth() === nextStart.getUTCMonth();
}

/** The most recent `runLength` months, only if they are contiguous calendar months; else null. */
function latestContiguousRun(monthsAscending: Period[], runLength: number): Period[] | null {
  if (monthsAscending.length < runLength) return null;
  const tail = monthsAscending.slice(-runLength);
  for (let i = 1; i < tail.length; i++) {
    if (!isNextCalendarMonth(new Date(tail[i - 1].periodStart), new Date(tail[i].periodStart))) return null;
  }
  return tail;
}

/**
 * Month-over-Month — the most recent complete month vs. the one before it.
 *
 * **Decision, logged in the PRD Decisions Log (2026-09-06):** "complete" means the calendar
 * month has actually finished in wall-clock UTC time — `periodEnd` strictly before `now`. A
 * statement uploaded for the CURRENT, still-open month (a same-month work-in-progress P&L) is
 * real data but is not "a complete month" to compare against, so it is skipped rather than
 * silently treated as the latest complete month; MoM instead compares the two most recent
 * months that have actually closed. `now` defaults to the real clock but is an argument so a
 * verification script can pin it against fixed fixture dates.
 */
export async function resolveMonthOverMonth(userId: string, now: Date = new Date()): Promise<ComparisonModeResult> {
  const months = await loadAllConfirmedMonths(userId);
  const complete = months.filter(p => new Date(p.periodEnd).getTime() < now.getTime());

  if (complete.length < 2) {
    return {
      available: false,
      reason: `Need at least two complete confirmed monthly statements to compute Month-over-Month `
        + `(found ${complete.length}; a statement for the current, still-open month doesn't count as complete).`,
    };
  }

  const prior = complete[complete.length - 2];
  const current = complete[complete.length - 1];
  const [priorMetrics, currentMetrics] = await Promise.all([
    loadPeriodMetrics(prior.id),
    loadPeriodMetrics(current.id),
  ]);

  return { available: true, periods: [toComparisonPeriod(prior, priorMetrics), toComparisonPeriod(current, currentMetrics)] };
}

/**
 * Rolling Quarter-over-Quarter — the most recent complete rolling 3-month window vs. the
 * 3-month window immediately before it. "Complete" carries the same meaning as Month-over-Month
 * above (periodEnd strictly before `now`); a window must also be three CONTIGUOUS calendar
 * months (no gap) to count as a rolling quarter, since a gap would silently average in a missing
 * month as if it were zero.
 */
export async function resolveRollingQuarterOverQuarter(userId: string, now: Date = new Date()): Promise<ComparisonModeResult> {
  const months = await loadAllConfirmedMonths(userId);
  const complete = months.filter(p => new Date(p.periodEnd).getTime() < now.getTime());

  if (complete.length < 6) {
    return {
      available: false,
      reason: `Need at least 6 complete confirmed monthly statements to compute two rolling 3-month `
        + `quarters (found ${complete.length}).`,
    };
  }

  const currentWindow = latestContiguousRun(complete, 3);
  if (!currentWindow) {
    return {
      available: false,
      reason: "The most recent 3 complete months on file aren't contiguous calendar months, so a rolling quarter can't be built from them.",
    };
  }

  const priorWindow = latestContiguousRun(complete.slice(0, complete.length - 3), 3);
  if (!priorWindow) {
    return {
      available: false,
      reason: "The 3 months immediately before the most recent rolling quarter aren't contiguous, so there's no prior rolling quarter to compare against.",
    };
  }

  const [priorMetrics, currentMetrics] = await Promise.all([
    loadMultiPeriodMetrics(priorWindow.map(p => p.id)),
    loadMultiPeriodMetrics(currentWindow.map(p => p.id)),
  ]);

  return {
    available: true,
    periods: [
      toWindowComparisonPeriod(priorWindow, priorMetrics, "quarter"),
      toWindowComparisonPeriod(currentWindow, currentMetrics, "quarter"),
    ],
  };
}

/**
 * Year-to-Date-over-Year-to-Date — this year's YTD-so-far vs. the same YTD span last year.
 *
 * Reuses `resolveAnnualConstruction(userId, currentYear, "ytd")` for the current year exactly as
 * the Phase 2.6 report screen does (same precedence: a confirmed YTD upload wins over a monthly
 * roll-up). The prior year is built with `resolveYtdThroughMonth`, deliberately WITHOUT that
 * precedence check, so it sums the exact same January-through-`throughMonthIndex` span rather
 * than whatever a confirmed upload for last year happens to cover — see that function's doc
 * comment for why. `throughMonthIndex` is inferred from the current year's `monthsCovered`
 * (assumes a January start, the same calendar-year assumption the rest of Phase 2.5/2.6 already
 * makes; a non-calendar fiscal year is a pre-existing open item, not solved here).
 */
export async function resolveYtdOverYtd(userId: string, now: Date = new Date()): Promise<ComparisonModeResult> {
  const currentYear = now.getUTCFullYear();
  const current = await resolveAnnualConstruction(userId, currentYear, "ytd");
  if (!current.available || !current.metrics) {
    return { available: false, reason: `This year (${currentYear}): ${current.reason ?? "no year-to-date figure available."}` };
  }

  const throughMonthIndex = (current.monthsCovered ?? 1) - 1;
  const priorYear = currentYear - 1;
  const prior = await resolveYtdThroughMonth(userId, priorYear, throughMonthIndex);
  if (!prior.available || !prior.metrics) {
    return { available: false, reason: `Last year (${priorYear}), same span: ${prior.reason ?? "no matching year-to-date figure available."}` };
  }

  const priorResult: ComparisonPeriodResult = {
    periodId: prior.sourcePeriodIds.length === 1 ? prior.sourcePeriodIds[0] : null,
    uploadId: null,
    sourcePeriodIds: prior.sourcePeriodIds,
    periodLabel: `YTD through ${MONTH_NAMES[throughMonthIndex]} ${priorYear}`,
    periodBasis: describePeriodBasis("year_to_date", prior.monthsCovered ?? 1, prior.note),
    monthsCovered: prior.monthsCovered ?? 1,
    periodType: "year_to_date",
    metrics: prior.metrics,
    periodEnd: new Date(Date.UTC(priorYear, throughMonthIndex + 1, 0)),
  };
  const currentResult: ComparisonPeriodResult = {
    periodId: current.sourcePeriodIds.length === 1 ? current.sourcePeriodIds[0] : null,
    uploadId: null,
    sourcePeriodIds: current.sourcePeriodIds,
    periodLabel: `YTD through ${MONTH_NAMES[throughMonthIndex]} ${currentYear}`,
    periodBasis: describePeriodBasis("year_to_date", current.monthsCovered ?? 1, current.note),
    monthsCovered: current.monthsCovered ?? 1,
    periodType: "year_to_date",
    metrics: current.metrics,
    periodEnd: new Date(Date.UTC(currentYear, throughMonthIndex + 1, 0)),
  };

  return { available: true, periods: [priorResult, currentResult] };
}

/**
 * The comparison-specific variance filter documented in
 * `clearpath-insight-framework-handoff.md`: "written explanations are only triggered if a trend
 * line deviates by **> 10% AND $1,500** from the baseline." This is distinct from
 * `calculateVariances` above (which scores a single period's own metrics against a tier
 * benchmark target) — this one flags a LINE-ITEM CHANGE between two periods, on both an absolute
 * dollar threshold and a percentage-of-baseline threshold at once.
 *
 * When the baseline amount is exactly zero, a percentage change is undefined (division by
 * zero) — rather than fabricate one, any nonzero move away from zero is treated as satisfying
 * the percentage leg (going from nothing to something is, definitionally, an unbounded percentage
 * change), so the dollar threshold alone decides whether it's flagged in that edge case.
 */
export interface ComparisonVariance {
  category: string;
  categoryLabel: string;
  fromLabel: string;
  toLabel: string;
  baselineAmount: number;
  currentAmount: number;
  amountDelta: number;
  percentDelta: number | null;
}

const COMPARISON_VARIANCE_PCT_THRESHOLD = 10;
const COMPARISON_VARIANCE_DOLLAR_THRESHOLD = 1500;

export function calculateComparisonVariances(
  baseline: Metrics,
  current: Metrics,
  fromLabel: string,
  toLabel: string,
): ComparisonVariance[] {
  const variances: ComparisonVariance[] = [];

  for (const key of METRIC_ORDER) {
    const baselineAmount = (baseline as any)[key] as number | undefined;
    const currentAmount = (current as any)[key] as number | undefined;
    if (typeof baselineAmount !== "number" || typeof currentAmount !== "number") continue;

    const amountDelta = currentAmount - baselineAmount;
    if (Math.abs(amountDelta) <= COMPARISON_VARIANCE_DOLLAR_THRESHOLD) continue;

    const percentDelta = baselineAmount !== 0 ? (amountDelta / Math.abs(baselineAmount)) * 100 : null;
    const percentConditionMet = percentDelta === null
      ? amountDelta !== 0 // baseline was zero: any nonzero move is an unbounded percentage change
      : Math.abs(percentDelta) > COMPARISON_VARIANCE_PCT_THRESHOLD;

    if (!percentConditionMet) continue;

    variances.push({
      category: key,
      categoryLabel: METRIC_LABELS[key] ?? key,
      fromLabel,
      toLabel,
      baselineAmount,
      currentAmount,
      amountDelta,
      percentDelta,
    });
  }

  variances.sort((a, b) => Math.abs(b.amountDelta) - Math.abs(a.amountDelta));
  return variances;
}

export interface Benchmark {
  target: number;
  min: number;
  max: number;
  type?: string;
  status?: string;
}

/**
 * Per-tier targets as a percentage of Gross Profit.
 *
 * CAC, OpEx Systems and OpEx People are carried over from the shipped table untouched — they
 * were already separate benchmarks in the original framework, so splitting the old flat
 * categories into sub-categories required no re-basing.
 *
 * Ascent Moves / Tax Strategy carries NO target here (Neal, 2026-09-06, reversing an earlier
 * 2026-09-06 decision that gave it the same target as Operational Net Profit). Rationale: a
 * target percentage implied a "how much of Gross Profit should go through tax strategy"
 * question, but an individual's tax situation is holistic — it depends on factors outside the
 * business entity — so there is no defensible target to hold Ascent Moves against. The only
 * real goal is to legally minimize Taxable Net Profit, which needs no percentage target to
 * express; see `calculateVariances` below, which no longer flags Ascent Moves at all.
 *
 * `operationalNetProfit` replaces the old `ownersPay`, `taxes` and `profit` entries, and its
 * target is their sum. That is a re-derivation of the existing table rather than a new
 * threshold: each tier already allocated exactly 100% of Gross Profit across
 * CAC + Systems + People + Owner's Pay + Taxes + Profit, and the new model simply moves the
 * last three below the line into one number.
 */
const TIER_BENCHMARKS: Record<string, Record<string, Benchmark>> = {
  "under-250k": {
    cac: { target: 15, min: 15, max: 15 },
    opexSystems: { target: 10, min: 10, max: 10 },
    opexPeople: { target: 10, min: 5, max: 15 },
    // 5 (profit) + 45 (owner's pay) + 15 (taxes); the range comes from owner's pay's 40-50.
    operationalNetProfit: { target: 65, min: 60, max: 70 },
  },
  "250k-500k": {
    cac: { target: 15, min: 15, max: 15 },
    opexSystems: { target: 10, min: 10, max: 10 },
    opexPeople: { target: 17.5, min: 15, max: 20 },
    // 10 + 32.5 + 15; range from owner's pay's 30-35.
    operationalNetProfit: { target: 57.5, min: 55, max: 60 },
  },
  "500k-1mm": {
    cac: { target: 15, min: 15, max: 15 },
    opexSystems: { target: 10, min: 10, max: 10 },
    opexPeople: { target: 25, min: 25, max: 25 },
    // 15 + 20 + 15
    operationalNetProfit: { target: 50, min: 50, max: 50 },
  },
  "1mm-5mm": {
    cac: { target: 15, min: 15, max: 15 },
    opexSystems: { target: 10, min: 10, max: 10 },
    opexPeople: { target: 40, min: 40, max: 40 },
    // 10 + 10 + 15
    operationalNetProfit: { target: 35, min: 35, max: 35 },
  },
  "5mm-plus": {
    cac: { target: 15, min: 15, max: 15 },
    opexSystems: { target: 10, min: 10, max: 10 },
    opexPeople: { target: 40, min: 40, max: 40 },
    // 15 + 5 + 15
    operationalNetProfit: { target: 35, min: 35, max: 35 },
  },
};

/**
 * Fulfillment is benchmarked against the COMBINED COGS + Services total, as a percentage of
 * revenue. The COGS/Services split is for reporting insight — showing which side of delivery
 * cost drives a variance — not for benchmarking; the framework only ever carried one combined
 * threshold.
 */
export function getFulfillmentBenchmark(fulfillmentPct: number | null): Benchmark {
  const pct = fulfillmentPct ?? 0;
  if (pct <= 25) {
    return { target: 20, min: 0, max: 25, type: "service", status: pct <= 20 ? "healthy" : "warning" };
  }
  return {
    target: 50,
    min: 0,
    max: 65,
    type: "goods",
    status: pct <= 50 ? "healthy" : pct <= 65 ? "warning" : "danger",
  };
}

export interface Benchmarks {
  cac: Benchmark;
  opexSystems: Benchmark;
  opexPeople: Benchmark;
  operationalNetProfit: Benchmark;
  fulfillment: Benchmark;
}

export function getBenchmarks(tier: string, fulfillmentPct: number | null): Benchmarks {
  const base = TIER_BENCHMARKS[tier] || TIER_BENCHMARKS["under-250k"];
  return {
    cac: base.cac,
    opexSystems: base.opexSystems,
    opexPeople: base.opexPeople,
    operationalNetProfit: base.operationalNetProfit,
    fulfillment: getFulfillmentBenchmark(fulfillmentPct),
  };
}

export interface Variance {
  category: string;
  current: string;
  target: string;
  variance: number;
  status: "warning" | "danger";
}

function targetText(bench: Benchmark): string {
  return bench.min === bench.max ? `${bench.target}%` : `${bench.min}-${bench.max}%`;
}

export function calculateVariances(metrics: Metrics, benchmarks: Benchmarks): Variance[] {
  const variances: Variance[] = [];

  // Operational Net Profit: higher is better, so only flag when it falls short. There is no
  // upper-bound warning — Basecamp's whole aim is to maximise this.
  const onpBench = benchmarks.operationalNetProfit;
  const onpPct = metrics.operationalNetProfitPct;
  if (onpPct !== null && onpPct < onpBench.min) {
    variances.push({
      category: "Operational Net Profit",
      current: `${onpPct.toFixed(1)}%`,
      target: targetText(onpBench),
      variance: parseFloat((onpPct - onpBench.min).toFixed(1)),
      status: "warning",
    });
  }

  // Ascent Moves / Tax Strategy is deliberately never flagged here (Neal, 2026-09-06, reversing
  // an earlier same-day decision that scored it against Operational Net Profit's target). An
  // individual's tax situation is holistic — it isn't isolated to the business entity — so
  // there is no defensible target percentage to measure a shortfall against. The only real goal
  // is to legally minimize Taxable Net Profit, which is a direction (lower is better), not a
  // percentage to hit; see Taxable Net Profit's own comment below for the same reasoning.

  // Cost categories: lower is better, so only flag when they run over.
  const costChecks: { key: "cac" | "opexSystems" | "opexPeople"; label: string; current: number | null }[] = [
    { key: "cac", label: "Customer Acquisition (CAC)", current: metrics.cacPct },
    { key: "opexSystems", label: "OpEx Systems", current: metrics.opexSystemsPct },
    { key: "opexPeople", label: "OpEx People", current: metrics.opexPeoplePct },
  ];

  for (const check of costChecks) {
    if (check.current === null) continue;
    const bench = benchmarks[check.key];
    if (check.current > bench.max) {
      const over = check.current - bench.max;
      variances.push({
        category: check.label,
        current: `${check.current.toFixed(1)}%`,
        target: targetText(bench),
        variance: parseFloat(over.toFixed(1)),
        status: over > 10 ? "danger" : "warning",
      });
    }
  }

  // Fulfillment, against the combined total.
  const fulfillmentBench = benchmarks.fulfillment;
  if (fulfillmentBench.status !== "healthy" && metrics.fulfillmentPct !== null) {
    const businessType = fulfillmentBench.type === "service" ? "Service" : "Goods";
    variances.push({
      category: `Fulfillment (${businessType})`,
      current: `${metrics.fulfillmentPct.toFixed(1)}%`,
      target: fulfillmentBench.type === "service" ? "<20%" : "<50%",
      variance: parseFloat((metrics.fulfillmentPct - fulfillmentBench.target).toFixed(1)),
      status: (fulfillmentBench.status as "warning" | "danger") ?? "warning",
    });
  }

  // Taxable Net Profit is deliberately absent: it is the residual after Ascent Moves, not a
  // figure with a target of its own, so it renders as a plain number with no indicator.

  variances.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  return variances.slice(0, 3);
}
