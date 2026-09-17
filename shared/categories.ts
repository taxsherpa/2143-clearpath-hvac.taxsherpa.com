import type { ClearpathCategory } from "./schema";

/**
 * The single source of truth for what the ClearPath categories are called and what order
 * they appear in.
 *
 * Before Phase 2 this list existed independently in four places — the enum, `Review.tsx`,
 * `Comparison.tsx` and the PDF export template — and they had already drifted apart. Every
 * surface now reads from here so a rename lands everywhere at once.
 *
 * Stored enum values are deliberately short and stable; only the labels below change when the
 * product language changes. `tax_strategy` in particular keeps its name even though its label
 * has now been rewritten twice — renaming the stored value would churn every export for no
 * behavioural gain.
 */

export const CATEGORY_ORDER: ClearpathCategory[] = [
  "revenue",
  "fulfillment_cogs",
  "fulfillment_services",
  "cac",
  "opex_systems",
  "opex_people",
  "tax_strategy",
];

export const CATEGORY_LABELS: Record<ClearpathCategory, string> = {
  revenue: "Revenue",
  fulfillment_cogs: "Fulfillment — COGS",
  fulfillment_services: "Fulfillment — Services",
  cac: "Customer Acquisition (CAC)",
  opex_systems: "OpEx Systems",
  opex_people: "OpEx People",
  tax_strategy: "Ascent Moves / Tax Strategy",
};

/**
 * Short forms for places where the full label doesn't fit — gauges, table headers, the
 * comparison grid. Never used where a lay user is making a mapping decision; there they get
 * the full label above plus (from Phase 3) the explainer.
 */
export const CATEGORY_SHORT_LABELS: Record<ClearpathCategory, string> = {
  revenue: "Revenue",
  fulfillment_cogs: "COGS",
  fulfillment_services: "Services",
  cac: "CAC",
  opex_systems: "OpEx Systems",
  opex_people: "OpEx People",
  tax_strategy: "Ascent Moves",
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Unmapped";
  return CATEGORY_LABELS[category as ClearpathCategory] ?? category;
}

/**
 * The calculated lines. These are not mappable categories — they are derived from the
 * mapped totals — but they need stable names too, because they appear on the report, the
 * PDF, the CSV and the comparison grid.
 *
 * `operationalNetProfit` is the framework's "Owner Net Benefit" under the name this product
 * uses. The two are the same quantity (Gross Profit − CAC − OpEx), which is why it carries a
 * benchmark while the Ascent-layer figures below it do not.
 */
export const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  fulfillment: "Fulfillment (total)",
  fulfillmentCogs: "Fulfillment — COGS",
  fulfillmentServices: "Fulfillment — Services",
  grossProfit: "Gross Profit",
  cac: "Customer Acquisition (CAC)",
  opexSystems: "OpEx Systems",
  opexPeople: "OpEx People",
  operationalNetProfit: "Operational Net Profit",
  taxStrategy: "Ascent Moves / Tax Strategy",
  taxableNetProfit: "Taxable Net Profit",
};

/** The subtitle shown under Operational Net Profit, tying it back to the framework's term. */
export const OPERATIONAL_NET_PROFIT_ALIAS = "Owner Benefit";

/**
 * Order the report, PDF and comparison grid render metrics in. Mirrors the model:
 * revenue, delivery cost, the Gross Profit line, the three operating buckets, the Basecamp
 * metric, the Ascent bucket, the Ascent metric.
 */
export const METRIC_ORDER = [
  "revenue",
  "fulfillmentCogs",
  "fulfillmentServices",
  "fulfillment",
  "grossProfit",
  "cac",
  "opexSystems",
  "opexPeople",
  "operationalNetProfit",
  "taxStrategy",
  "taxableNetProfit",
] as const;

/**
 * Metrics that carry a benchmark and therefore a stoplight. Everything else renders as a
 * plain figure.
 *
 * `taxStrategy` was added 2026-09-06 (Neal) and is scored against the same tier target as
 * `operationalNetProfit`, on the same Gross Profit basis.
 *
 * `taxableNetProfit` remains absent on purpose: it is the residual left after Ascent Moves,
 * not a figure anyone aims at, and putting a red/yellow/green beside it would invent guidance
 * the framework doesn't give.
 */
export const BENCHMARKED_METRICS = [
  "fulfillment",
  "cac",
  "opexSystems",
  "opexPeople",
  "operationalNetProfit",
  "taxStrategy",
] as const;
