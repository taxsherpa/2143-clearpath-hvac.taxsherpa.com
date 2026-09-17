import type { ClearpathCategory } from "@shared/schema";

/**
 * Phase 3.1 (education + lay-user UX): the single source of copy for "what does this category
 * mean" across every surface — mapping, review, report, and Comparison. One rewrite here reaches
 * all four; no surface should hardcode its own wording.
 *
 * Surfacing mechanism (decided here, reused everywhere per the Phase 3 plan): a small info-icon
 * trigger opening a `Popover` (see `client/src/components/ui/popover.tsx`), not a `Tooltip`.
 * Reasons:
 *   - Tooltip is hover-only, which does not exist on a touchscreen; this is a self-serve tool a
 *     business owner may well use on a phone, and hover-only content is invisible there.
 *   - The explainer text below is full sentences, sometimes two — too long for a tooltip's
 *     single-line convention, and Radix's own guidance reserves Tooltip for short labels.
 *   - Popover is click/tap-triggered and stays open until dismissed, so a lay user can actually
 *     read it rather than chasing a hover state, and it works identically with mouse or touch.
 * Every wiring sub-phase (3.2–3.4) should use the same trigger+Popover pattern rather than
 * inventing a per-screen variant.
 */

export interface CategoryExplainer {
  /** One-line plain-English definition — safe to show inline next to the label if space allows. */
  short: string;
  /** The full popover body: one or two sentences, expanding the short definition. */
  body: string;
}

export const CATEGORY_EXPLAINERS: Record<ClearpathCategory, CategoryExplainer> = {
  revenue: {
    short: "The money customers pay you for what you sell or do.",
    body:
      "The money customers pay you for what you sell or do. This is top-line — before any cost of " +
      "delivering it, running the business, or paying yourself comes out.",
  },
  fulfillment_cogs: {
    short: "The direct materials or goods cost of what you sold.",
    body:
      "The direct materials or goods cost of what you sold — the parts, inventory, or supplies " +
      "that went into the specific thing the customer bought. Not overhead, not labor to deliver a " +
      "service — just the physical goods cost.",
  },
  fulfillment_services: {
    short: "The direct labor or subcontractor cost of delivering the service or job.",
    body:
      "The direct labor or subcontractor cost of delivering the service or job — the people or " +
      "contractors doing the actual work the customer paid for. Not admin, not sales, just the " +
      "delivery itself.",
  },
  cac: {
    short: "What you spent to get the customer in the door.",
    body:
      "What you spent to get the customer in the door — ads, sales commissions, marketing spend. " +
      "Money spent to win the business, not to deliver it once won.",
  },
  opex_systems: {
    short: "Software, rent, insurance, and other overhead that runs regardless of volume.",
    body:
      "Software, rent, insurance, and other fixed overhead that runs regardless of how many " +
      "customers you serve this month. The cost of the business existing, not the cost of any one " +
      "job or sale.",
  },
  opex_people: {
    short: "Salaries for admin or support staff — not the owner, not delivery labor.",
    body:
      "Salaries for admin or support staff who keep the business running — not the owner, and not " +
      "the people doing the delivery work counted under Fulfillment — Services.",
  },
  tax_strategy: {
    short: "Owner pay and other moves that convert business profit into your personal money.",
    body:
      "Owner pay, retirement contributions, and other moves that convert business profit into your " +
      "personal usable money as tax-efficiently as possible. These aren't costs of running the " +
      "business — they're how the profit gets home to you. If a line is your own salary or a " +
      "distribution to yourself, it belongs here.",
  },
};

export interface MetricExplainer {
  short: string;
  body: string;
}

/**
 * The two calculated headline metrics. Keyed by the same camelCase keys `METRIC_LABELS` uses in
 * `shared/categories.ts` so a caller can look either table up with one identifier.
 */
export const METRIC_EXPLAINERS: Record<"operationalNetProfit" | "taxableNetProfit", MetricExplainer> = {
  operationalNetProfit: {
    short: "What the business actually produced for you, before Ascent Moves. Maximize this.",
    body:
      "Revenue, minus what it cost to fulfill and win the work, minus overhead and support staff. " +
      "This is what the business actually produced — the Basecamp number, and the one this report " +
      "benchmarks and stoplights. The goal is to grow it.",
  },
  taxableNetProfit: {
    short: "What's left after Ascent Moves. There's no target for this — it's a result, not a goal.",
    body:
      "Operational Net Profit minus Ascent Moves / Tax Strategy (owner pay, retirement, and similar " +
      "moves). This is what's left over after the profit has been routed to you — not a target to " +
      "hit, just the number that falls out once the Ascent moves are made. There's no benchmark " +
      "for it, because minimizing it legally is the point, not maximizing it.",
  },
};
