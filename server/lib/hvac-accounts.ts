import type { ClearpathCategory, ConfidenceLevel } from "@shared/schema";

/**
 * HVAC-specific account mapping.
 *
 * The generic heuristics in `csv-parser.ts` read a chart of accounts written for any business.
 * An HVAC P&L has its own vocabulary — RTUs, line sets, permits, truck leases — and two traps
 * that decide whether a shop's scorecard is honest:
 *
 *  1. **Variable vehicle costs belong to fulfillment.** Fuel, oil changes and field maintenance
 *     are part of delivering the job, and the industry report counts them in Fulfillment Services.
 *  2. **Fixed fleet costs belong to overhead.** Truck leases, depreciation and auto liability sit
 *     in OpEx Systems.
 *
 * Get those backwards and a shop with six trucks looks like it has a labour problem when it has a
 * fleet problem, and the advice on the screen points at the wrong thing.
 *
 * Source for the category definitions: the HVAC benchmarking report, summarised in Tax-Sherpa-OS
 * `02-workbench/3065-hvac-webinar-offer/01-explore/2026-09-14-hvac-financial-benchmarks-research.md`.
 *
 * These rules run BEFORE the generic ones, and only when they match with confidence. Anything
 * they don't recognise falls through to the existing heuristics, and the user's own past choice
 * (mapping memory) still beats both.
 */

export interface HvacMatch {
  category: ClearpathCategory;
  confidence: ConfidenceLevel;
  /** Why this line went where it did, for the review screen. */
  reason: string;
}

interface Rule {
  category: ClearpathCategory;
  confidence: ConfidenceLevel;
  reason: string;
  /** Any of these in the label or path matches. */
  any: string[];
  /** None of these may appear, which is how the vehicle split is kept apart. */
  not?: string[];
}

/**
 * Order matters: the first match wins, so the narrow rules (the vehicle split) come before the
 * broad ones (anything with "vehicle" in it).
 */
const RULES: Rule[] = [
  // ---- The vehicle split, first and most specific -------------------------------------------
  {
    category: "opex_systems",
    confidence: "medium",
    reason: "Fixed fleet cost — the report counts truck leases, depreciation and auto liability in overhead",
    any: [
      "truck lease", "vehicle lease", "auto lease", "fleet lease", "truck payment",
      "vehicle loan", "auto loan", "vehicle depreciation", "truck depreciation",
      "auto insurance", "vehicle insurance", "truck insurance", "fleet insurance", "commercial auto",
      "vehicle registration", "truck registration",
    ],
  },
  {
    category: "fulfillment_services",
    confidence: "medium",
    reason: "Variable vehicle cost — fuel and field maintenance are part of delivering the job",
    any: [
      "fuel", "gasoline", "diesel", "oil change", "vehicle maintenance", "truck maintenance",
      "fleet maintenance", "vehicle repair", "truck repair", "tires", "mileage reimbursement",
    ],
    not: ["lease", "depreciation", "insurance", "loan", "payment", "registration"],
  },

  // ---- Equipment and materials consumed on the job ------------------------------------------
  {
    category: "fulfillment_cogs",
    confidence: "high",
    reason: "Equipment or material consumed on a job",
    any: [
      "equipment purchase", "condenser", "furnace", "air handler", "heat pump", "mini split",
      "mini-split", "rtu", "rooftop unit", "compressor", "evaporator", "coil", "thermostat",
      "refrigerant", "freon", "duct", "ductwork", "sheet metal", "line set", "lineset",
      "copper", "flex", "filter", "capacitor", "contactor", "motor", "water heater",
      "job material", "job supplies", "materials purchased", "parts purchase", "supply house",
    ],
  },

  // ---- Delivering the work -------------------------------------------------------------------
  {
    category: "fulfillment_services",
    confidence: "high",
    reason: "Direct cost of delivering the job",
    any: [
      "technician", "tech wage", "tech pay", "tech labor", "tech labour", "installer",
      "install labor", "install labour", "service labor", "service labour", "field labor",
      "field labour", "apprentice", "helper wage", "crew", "subcontractor", "sub labor",
      "1099 labor", "contractor", "contract labor", "permit", "inspection fee",
      "equipment rental", "tool rental",
      "dumpster", "disposal", "haul away", "warranty work", "callback", "call back",
      "workers comp", "workers' comp", "tech commission", "spiff", "job bonus",
    ],
  },

  // ---- Winning the work ----------------------------------------------------------------------
  {
    category: "cac",
    confidence: "high",
    reason: "Cost of winning work",
    any: [
      "yelp", "angi", "angie", "home advisor", "homeadvisor", "thumbtack", "nextdoor",
      "google ads", "adwords", "ppc", "pay per click", "seo", "direct mail", "postcard",
      "billboard", "radio ad", "tv ad", "truck wrap", "vehicle wrap", "yard sign",
      "door hanger", "lead gen", "lead purchase", "sponsorship", "trade show", "home show",
      "marketing agency", "advertising",
    ],
  },

  // ---- Running the shop ----------------------------------------------------------------------
  {
    category: "opex_people",
    confidence: "medium",
    reason: "Non-field payroll — office and admin",
    any: [
      "wages", "salaries", "payroll", "payroll taxes",
      "dispatcher", "dispatch wage", "csr", "customer service rep", "office manager",
      "office staff", "office wage", "office salary", "admin wage", "admin salary",
      "administrative", "bookkeeper", "receptionist", "general manager", "gm salary",
    ],
  },
  {
    category: "opex_systems",
    confidence: "medium",
    reason: "Fixed cost of running the shop",
    any: [
      "servicetitan", "service titan", "housecall", "jobber", "fieldedge", "successware",
      "shop rent", "warehouse rent", "yard rent", "general liability", "liability insurance",
      "shop utilities", "shop supplies", "uniform", "phone system", "answering service",
      "software", "subscription", "merchant fee", "credit card fee",
    ],
  },
];

function matches(text: string, rule: Rule): boolean {
  if (rule.not?.some((n) => text.includes(n))) return false;
  return rule.any.some((a) => text.includes(a));
}

/**
 * Returns a mapping when an HVAC-specific rule recognises the line, or null to let the generic
 * heuristics decide.
 */
export function matchHvacAccount(label: string, path: string = ""): HvacMatch | null {
  const text = `${path} ${label}`.toLowerCase();

  // Owner money stays out of this: the generic rules already push it below the operating line,
  // which is exactly where the report's benchmarks expect it. Catching "owner truck" here would
  // undo that.
  if (text.includes("owner") || text.includes("member draw") || text.includes("shareholder")) {
    return null;
  }

  for (const rule of RULES) {
    if (matches(text, rule)) {
      return { category: rule.category, confidence: rule.confidence, reason: rule.reason };
    }
  }
  return null;
}

/**
 * Owner compensation sitting in operating expenses.
 *
 * Every benchmark in the report excludes the owner's own pay, replacing it with what a hired
 * general manager would cost. An owner-operator who runs a W-2 salary through payroll therefore
 * shows up with inflated OpEx and a net margin far below a benchmark that was never measured the
 * same way — and it's the first thing they'd see on the 29th.
 *
 * We don't guess a correction. We detect the situation and say so, so the number on screen is
 * either comparable or openly flagged as not.
 */
export interface OwnerCompFinding {
  /** Dollar total found inside operating categories. */
  amount: number;
  /** The lines it came from, for the message. */
  labels: string[];
}

const OWNER_PATTERNS = [
  "owner", "member draw", "shareholder", "officer comp", "officer salary", "officers comp",
  "guaranteed payment", "distribution",
];

const OPERATING_CATEGORIES: ClearpathCategory[] = [
  "opex_people",
  "opex_systems",
  "fulfillment_services",
  "fulfillment_cogs",
  "cac",
];

export function detectOwnerCompInOpex(
  nodes: Array<{ label: string; category: string | null; amount: number | null }>,
): OwnerCompFinding | null {
  const hits = nodes.filter((n) => {
    if (!n.category || !OPERATING_CATEGORIES.includes(n.category as ClearpathCategory)) return false;
    if (n.amount === null || n.amount === 0) return false;
    const label = n.label.toLowerCase();
    return OWNER_PATTERNS.some((p) => label.includes(p));
  });

  if (hits.length === 0) return null;

  return {
    amount: hits.reduce((sum, n) => sum + Math.abs(n.amount ?? 0), 0),
    labels: hits.map((n) => n.label),
  };
}
