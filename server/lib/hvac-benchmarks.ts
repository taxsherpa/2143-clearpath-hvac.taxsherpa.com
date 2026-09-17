/**
 * HVAC benchmarks.
 *
 * The generic ClearPath tiers by gross profit and states every target as a percentage of gross
 * profit. The HVAC industry report does neither: it tiers by REVENUE and states every category as
 * a percentage of REVENUE, with two columns per tier — the average operator and the exceptional
 * (top-quartile) firm.
 *
 * Source, with the tables rebuilt from the report's own figures and checked (fulfillment + gross
 * profit + OpEx adds back to the stated net margin in every column):
 * Tax-Sherpa-OS `02-workbench/3065-hvac-webinar-offer/01-explore/
 * 2026-09-14-hvac-financial-benchmarks-research.md`.
 *
 * Two decisions from Neal are encoded here:
 *  - Shops under $500K are scored against the $500K–$2M **exceptional** column (2026-09-15). The
 *    report doesn't cover them and they're roughly half the market, so `borrowedTier` is set and
 *    the UI has to say so rather than implying the benchmark is for their size.
 *  - We score against the exceptional column, and show the average alongside it, because that is
 *    what the workshop page promises: what the average shop gets, next to what the best-in-class
 *    shop gets from the same conditions.
 *
 * Owner compensation is excluded from every figure in the report — replaced by a market-rate GM
 * salary inside OpEx when the owner actively manages. Numbers that still carry the owner's own pay
 * are not comparable to these benchmarks, which is why `ownerCompExcluded` gates the scorecard.
 */

export type HvacTier = "under-500k" | "500k-2mm" | "2mm-5mm" | "5mm-10mm" | "10mm-plus";

/** Every benchmarked category, each a percentage of revenue. */
export type HvacCategory =
  | "fulfillmentCogs"
  | "fulfillmentServices"
  | "grossProfit"
  | "cac"
  | "opexPeople"
  | "opexSystems"
  | "netOperatingMargin";

/** For a category, higher can be better (gross profit, net margin) or worse (every cost line). */
export type Direction = "higher-is-better" | "lower-is-better";

export interface HvacBenchmark {
  /** The industry average operator, shown for context. */
  average: number;
  /** The top-quartile firm. This is what we score against. */
  exceptional: number;
}

const TIER_ORDER: HvacTier[] = ["under-500k", "500k-2mm", "2mm-5mm", "5mm-10mm", "10mm-plus"];

export const TIER_LABELS: Record<HvacTier, string> = {
  "under-500k": "Under $500K",
  "500k-2mm": "$500K–$2M",
  "2mm-5mm": "$2M–$5M",
  "5mm-10mm": "$5M–$10M",
  "10mm-plus": "$10M–$20M+",
};

export const CATEGORY_LABELS: Record<HvacCategory, string> = {
  fulfillmentCogs: "Fulfillment — COGS",
  fulfillmentServices: "Fulfillment — Services",
  grossProfit: "Gross Profit",
  cac: "Customer Acquisition",
  opexPeople: "OpEx — People",
  opexSystems: "OpEx — Systems",
  netOperatingMargin: "Net Operating Margin",
};

export const CATEGORY_DIRECTION: Record<HvacCategory, Direction> = {
  fulfillmentCogs: "lower-is-better",
  fulfillmentServices: "lower-is-better",
  grossProfit: "higher-is-better",
  cac: "lower-is-better",
  opexPeople: "lower-is-better",
  opexSystems: "lower-is-better",
  netOperatingMargin: "higher-is-better",
};

/**
 * The matrix, as percentages of revenue. `under-500k` deliberately has no row of its own: it
 * borrows $500K–$2M, which `getHvacBenchmarks` records in `borrowedTier`.
 */
const HVAC_BENCHMARKS: Record<
  Exclude<HvacTier, "under-500k">,
  Record<HvacCategory, HvacBenchmark>
> = {
  "500k-2mm": {
    fulfillmentCogs: { average: 28.5, exceptional: 19.5 },
    fulfillmentServices: { average: 29.5, exceptional: 23.5 },
    grossProfit: { average: 42.0, exceptional: 57.0 },
    cac: { average: 11.0, exceptional: 8.5 },
    opexPeople: { average: 9.0, exceptional: 7.0 },
    opexSystems: { average: 16.5, exceptional: 14.5 },
    netOperatingMargin: { average: 5.5, exceptional: 27.0 },
  },
  "2mm-5mm": {
    fulfillmentCogs: { average: 26.5, exceptional: 19.0 },
    fulfillmentServices: { average: 28.5, exceptional: 22.0 },
    grossProfit: { average: 45.0, exceptional: 59.0 },
    cac: { average: 10.0, exceptional: 7.5 },
    opexPeople: { average: 10.0, exceptional: 7.5 },
    opexSystems: { average: 17.0, exceptional: 13.0 },
    netOperatingMargin: { average: 8.0, exceptional: 31.0 },
  },
  "5mm-10mm": {
    fulfillmentCogs: { average: 25.5, exceptional: 18.0 },
    fulfillmentServices: { average: 27.5, exceptional: 21.0 },
    grossProfit: { average: 47.0, exceptional: 61.0 },
    cac: { average: 8.5, exceptional: 6.5 },
    opexPeople: { average: 11.0, exceptional: 8.0 },
    opexSystems: { average: 19.5, exceptional: 11.5 },
    netOperatingMargin: { average: 8.0, exceptional: 35.0 },
  },
  "10mm-plus": {
    fulfillmentCogs: { average: 24.5, exceptional: 17.0 },
    fulfillmentServices: { average: 26.5, exceptional: 20.0 },
    grossProfit: { average: 49.0, exceptional: 63.0 },
    cac: { average: 7.0, exceptional: 5.5 },
    opexPeople: { average: 11.0, exceptional: 8.0 },
    opexSystems: { average: 22.0, exceptional: 10.5 },
    netOperatingMargin: { average: 9.0, exceptional: 39.0 },
  },
};

/**
 * Annualises the revenue on the statement before tiering, so a single month doesn't drop a $6M
 * shop into the smallest tier.
 */
export function getHvacTier(revenue: number, monthsCovered: number = 12): HvacTier {
  const months = monthsCovered > 0 ? monthsCovered : 1;
  const annualRevenue = (revenue / months) * 12;
  if (annualRevenue < 500_000) return "under-500k";
  if (annualRevenue < 2_000_000) return "500k-2mm";
  if (annualRevenue < 5_000_000) return "2mm-5mm";
  if (annualRevenue < 10_000_000) return "5mm-10mm";
  return "10mm-plus";
}

export interface HvacBenchmarkSet {
  /** The tier the shop's revenue actually falls in. */
  tier: HvacTier;
  /** Set only for shops under $500K: the tier whose column they are being scored against. */
  borrowedTier?: Exclude<HvacTier, "under-500k">;
  benchmarks: Record<HvacCategory, HvacBenchmark>;
}

export function getHvacBenchmarks(tier: HvacTier): HvacBenchmarkSet {
  if (tier === "under-500k") {
    return {
      tier,
      borrowedTier: "500k-2mm",
      benchmarks: HVAC_BENCHMARKS["500k-2mm"],
    };
  }
  return { tier, benchmarks: HVAC_BENCHMARKS[tier] };
}

/**
 * What being off this benchmark means, and the first move. Neal, 2026-09-14: "the scorecard must
 * explain the so-what". Each line is written from the report's own mechanics, not invented advice.
 */
export const CATEGORY_INTERPRETATION: Record<HvacCategory, { over: string; under: string }> = {
  fulfillmentCogs: {
    over:
      "Equipment and materials are eating more of every job than they should. That's a pricing " +
      "problem far more often than a buying problem: the supply house raised prices and the price " +
      "book didn't follow. Re-price before you renegotiate.",
    under:
      "Materials are running lean against the benchmark. Worth checking that equipment costs " +
      "aren't sitting in labour or overhead instead.",
  },
  fulfillmentServices: {
    over:
      "Delivering the work costs more than it should. Look at unbilled hours, callbacks and " +
      "windshield time before you look at wages — and at whether the work is priced for the crew " +
      "it actually takes. Predictable revenue (service agreements) is what smooths this.",
    under:
      "Labour and direct job costs are lean. Confirm technician pay is fully burdened here — " +
      "payroll taxes, insurance, workers' comp — or this number flatters you.",
  },
  grossProfit: {
    over: "Gross profit is ahead of the benchmark. The leak, if there is one, is below this line.",
    under:
      "What's left after doing the work is short of the benchmark, which caps everything below " +
      "it. No amount of overhead discipline fixes a gross profit problem — it's set by price and " +
      "by what the job costs to deliver.",
  },
  cac: {
    over:
      "You're paying more for each job than the benchmark shop does. With a full schedule this " +
      "is often the easiest dollar to take back: work booked that you'd have won anyway.",
    under:
      "Acquisition is cheap for you. If the schedule has room, this is the number to spend into, " +
      "not to protect.",
  },
  opexPeople: {
    over:
      "Office and admin payroll is heavy for a shop this size. Usually it's roles added to absorb " +
      "chaos: dispatch, chasing paperwork, re-keying invoices.",
    under: "Non-field payroll is lean. Check the owner isn't personally absorbing those roles.",
  },
  opexSystems: {
    over:
      "Rent, fleet, software and insurance are running high. Fixed fleet costs are the usual " +
      "cause: trucks added faster than the revenue to carry them.",
    under: "Fixed overhead is lean.",
  },
  netOperatingMargin: {
    over: "The business keeps more of what it bills than the benchmark shop does.",
    under:
      "What the business keeps is short of what a best-in-class shop keeps from the same " +
      "conditions. The categories above tell you which stage it leaks at — and being busier " +
      "doesn't move it.",
  },
};

export interface HvacScore {
  category: HvacCategory;
  label: string;
  /** The shop's own figure, as a percentage of revenue. Null when revenue is zero. */
  actual: number | null;
  average: number;
  exceptional: number;
  /** Percentage points between the shop and the exceptional column, signed as good/bad. */
  gap: number | null;
  status: "ahead" | "on-track" | "behind" | "unknown";
  interpretation: string;
}

/** How far off the exceptional column counts as "on track" rather than "behind". */
const ON_TRACK_TOLERANCE_PTS = 2;

/**
 * Scores one shop's percentages against a tier's exceptional column.
 *
 * `actuals` are percentages of revenue, not of gross profit — the caller converts.
 */
export function scoreHvac(
  actuals: Partial<Record<HvacCategory, number | null>>,
  set: HvacBenchmarkSet,
): HvacScore[] {
  return (Object.keys(CATEGORY_LABELS) as HvacCategory[]).map((category) => {
    const bench = set.benchmarks[category];
    const actual = actuals[category] ?? null;
    const direction = CATEGORY_DIRECTION[category];

    if (actual === null || !Number.isFinite(actual)) {
      return {
        category,
        label: CATEGORY_LABELS[category],
        actual: null,
        average: bench.average,
        exceptional: bench.exceptional,
        gap: null,
        status: "unknown" as const,
        interpretation: "",
      };
    }

    // Positive gap always means "better than the exceptional column", whichever way the category
    // runs, so the UI never has to special-case a direction.
    //
    // Rounded to two decimals on purpose: 684,000 / 1,200,000 comes out as 56.99999999999999 in
    // binary floating point, which would put a shop sitting exactly on the benchmark a hair below
    // it and score it "on-track" instead of "ahead". Two decimals is what the scorecard shows
    // anyway, so nothing is lost.
    const rawGap =
      direction === "higher-is-better"
        ? actual - bench.exceptional
        : bench.exceptional - actual;
    const gap = Math.round(rawGap * 100) / 100;

    const status: HvacScore["status"] =
      gap >= 0 ? "ahead" : gap >= -ON_TRACK_TOLERANCE_PTS ? "on-track" : "behind";

    // The copy is keyed on where the number sits, not on whether that's good news: a cost line
    // above the benchmark reads `over` (and is bad), a margin above it also reads `over` (and is
    // good). Keying this on `gap` instead would hand a shop with heavy materials the text written
    // for a shop with lean ones.
    const copy = CATEGORY_INTERPRETATION[category];
    const interpretation = actual > bench.exceptional ? copy.over : copy.under;

    return {
      category,
      label: CATEGORY_LABELS[category],
      actual,
      average: bench.average,
      exceptional: bench.exceptional,
      gap,
      status,
      interpretation,
    };
  });
}

/** Ordered tiers, for a picker or a comparison table. */
export function tiersInOrder(): HvacTier[] {
  return [...TIER_ORDER];
}

export interface HvacScorecard {
  tier: HvacTier;
  tierLabel: string;
  /** Set only when the shop is under $500K and is measured against a larger tier's column. */
  borrowedTier?: Exclude<HvacTier, "under-500k">;
  borrowedTierLabel?: string;
  /** Annualised revenue the tier was chosen from, so the UI can show its working. */
  annualRevenue: number | null;
  scores: HvacScore[];
}

/**
 * Turns one statement's metrics into an HVAC scorecard.
 *
 * The conversion is the whole point. `Metrics` carries every percentage as a share of GROSS PROFIT,
 * because that is the generic ClearPath framework's baseline. Every HVAC benchmark is a share of
 * REVENUE. Passing the existing percentages straight through would compare two different
 * denominators and overstate every cost line.
 *
 * `operationalNetProfit` maps to the report's net operating margin without adjustment: both sit
 * before owner compensation, which the report replaces with a market-rate GM salary and this app
 * keeps below the line in tax strategy.
 */
export function scoreMetrics(
  metrics: {
    revenue: number;
    fulfillmentCogs: number;
    fulfillmentServices: number;
    grossProfit: number;
    cac: number;
    opexPeople: number;
    opexSystems: number;
    operationalNetProfit: number;
  },
  monthsCovered: number = 12,
): HvacScorecard {
  const { revenue } = metrics;
  const pct = (value: number): number | null => (revenue > 0 ? (value / revenue) * 100 : null);

  const tier = getHvacTier(revenue, monthsCovered);
  const set = getHvacBenchmarks(tier);
  const months = monthsCovered > 0 ? monthsCovered : 1;

  return {
    tier,
    tierLabel: TIER_LABELS[tier],
    borrowedTier: set.borrowedTier,
    borrowedTierLabel: set.borrowedTier ? TIER_LABELS[set.borrowedTier] : undefined,
    annualRevenue: revenue > 0 ? (revenue / months) * 12 : null,
    scores: scoreHvac(
      {
        fulfillmentCogs: pct(metrics.fulfillmentCogs),
        fulfillmentServices: pct(metrics.fulfillmentServices),
        grossProfit: pct(metrics.grossProfit),
        cac: pct(metrics.cac),
        opexPeople: pct(metrics.opexPeople),
        opexSystems: pct(metrics.opexSystems),
        netOperatingMargin: pct(metrics.operationalNetProfit),
      },
      set,
    ),
  };
}
