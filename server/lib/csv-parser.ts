import { matchHvacAccount } from "./hvac-accounts";
import { parse } from "csv-parse/sync";
import type { ClearpathCategory, ConfidenceLevel, PeriodType } from "@shared/schema";
import { monthStartUTC, endOfMonthUTC, monthsBetweenUTC } from "@shared/period";

export interface PlNode {
  tempId: string;
  label: string;
  level: number;
  displayOrder: number;
  /** One amount per detected period column, parallel to CSVParseResult.periods. `null` where
   *  this line had no value in that column. */
  amounts: (number | null)[];
  isRollup: boolean;
  sourcePath: string;
  parentTempId?: string;
  suggestedCategory?: ClearpathCategory;
  confidence?: ConfidenceLevel;
}

export interface DetectedPeriod {
  /** Index into each row's array — where this period's amount lives. */
  columnIndex: number;
  label: string;
  periodType: PeriodType;
  periodStart: Date;
  periodEnd: Date;
  monthsCovered: number;
  /** True when the parser is confident in periodType/range without a heuristic guess. When
   *  false, build requirement #2 says the upload flow must force user confirmation rather than
   *  silently trusting the guess. */
  confident: boolean;
}

export interface CSVParseResult {
  nodes: PlNode[];
  periods: DetectedPeriod[];
  errors: string[];
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function parseMonthName(monthName: string): number {
  const normalized = monthName.toLowerCase().trim();
  // startsWith so "Jan" and "January" both resolve, but guard against "Ju" matching June/July —
  // require at least 3 characters, which every legitimate abbreviation already has.
  if (normalized.length < 3) return -1;
  return MONTH_NAMES.findIndex(m => m.startsWith(normalized));
}

/**
 * Classify one header cell as a period column, or return null if it doesn't look like one.
 * Handles the shapes QuickBooks and similar exports actually use:
 *   "Jan 2026" / "January 2026"        -> month
 *   "Q1 2026"                          -> quarter
 *   "Jan - Dec 2026" / "FY2026"        -> annual
 *   "Jan - Jul 2026"                   -> year_to_date (starts in January)
 *   "Mar - Jul 2026"                   -> custom (arbitrary range, doesn't start in January)
 *   "Total" / "Amount" / "Balance"     -> unknown (single-column export; caller resolves this
 *                                          against extractSingleColumnPeriod)
 */
function classifyHeaderCell(text: string): Omit<DetectedPeriod, "columnIndex"> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // "Jan 2026" / "January 2026"
  const monthYear = trimmed.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (monthYear) {
    const month = parseMonthName(monthYear[1]);
    if (month !== -1) {
      const year = parseInt(monthYear[2], 10);
      return {
        label: `${MONTH_NAMES[month][0].toUpperCase()}${MONTH_NAMES[month].slice(1)} ${year}`,
        periodType: "month",
        periodStart: monthStartUTC(year, month),
        periodEnd: endOfMonthUTC(year, month),
        monthsCovered: 1,
        confident: true,
      };
    }
  }

  // "Q1 2026" / "Quarter 1 2026"
  const quarter = trimmed.match(/^Q(?:uarter)?\s*([1-4])\D*(\d{4})$/i);
  if (quarter) {
    const q = parseInt(quarter[1], 10);
    const year = parseInt(quarter[2], 10);
    const startMonth = (q - 1) * 3;
    return {
      label: `Q${q} ${year}`,
      periodType: "quarter",
      periodStart: monthStartUTC(year, startMonth),
      periodEnd: endOfMonthUTC(year, startMonth + 2),
      monthsCovered: 3,
      confident: true,
    };
  }

  // "FY2026" / "FY 2026" — a bare fiscal/calendar year, treated as annual.
  const fiscalYear = trimmed.match(/^FY\s*(\d{4})$/i);
  if (fiscalYear) {
    const year = parseInt(fiscalYear[1], 10);
    return {
      label: `FY${year}`,
      periodType: "annual",
      periodStart: monthStartUTC(year, 0),
      periodEnd: endOfMonthUTC(year, 11),
      monthsCovered: 12,
      confident: true,
    };
  }

  // "Jan - Dec 2026", "Jan-Jul 2026", "Mar - Jul 2026", "January - December 2026"
  const range = trimmed.match(/^([A-Za-z]+)\.?\s*-\s*([A-Za-z]+)\.?\s+(\d{4})$/);
  if (range) {
    const startMonth = parseMonthName(range[1]);
    const endMonth = parseMonthName(range[2]);
    const year = parseInt(range[3], 10);
    if (startMonth !== -1 && endMonth !== -1) {
      const monthsCovered = endMonth - startMonth + 1;
      if (monthsCovered >= 1) {
        const periodStart = monthStartUTC(year, startMonth);
        const periodEnd = endOfMonthUTC(year, endMonth);
        if (startMonth === 0 && endMonth === 11) {
          return { label: `${year} (annual)`, periodType: "annual", periodStart, periodEnd, monthsCovered: 12, confident: true };
        }
        if (startMonth === 0) {
          return {
            label: `YTD through ${MONTH_NAMES[endMonth]} ${year}`,
            periodType: "year_to_date", periodStart, periodEnd, monthsCovered, confident: true,
          };
        }
        return {
          label: `${trimmed}`,
          periodType: "custom", periodStart, periodEnd, monthsCovered, confident: true,
        };
      }
    }
  }

  // A bare 4-digit year with no month names, e.g. "2026" — ambiguous between "annual" and "as
  // of end of year"; treat as annual but flag for confirmation rather than assume silently.
  const bareYear = trimmed.match(/^(\d{4})$/);
  if (bareYear) {
    const year = parseInt(bareYear[1], 10);
    return {
      label: `${year}`,
      periodType: "annual",
      periodStart: monthStartUTC(year, 0),
      periodEnd: endOfMonthUTC(year, 11),
      monthsCovered: 12,
      confident: false,
    };
  }

  return null;
}

/**
 * Look at the first few rows for a report-title line (QuickBooks puts this above the header
 * row, e.g. "Profit and Loss — January 1-31, 2026" or "Profit and Loss — January-July 2026").
 * Used both to date a single-amount-column CSV (the old behaviour) and as a confidence check
 * against a header-row-detected period.
 */
function extractTitlePeriod(records: any[]): Omit<DetectedPeriod, "columnIndex"> | null {
  for (let i = 0; i < Math.min(5, records.length); i++) {
    const row = records[i];
    if (!row || row.length === 0) continue;
    // Reconstruct with a comma, not a space: a title line like "January 1-31, 2026" is itself
    // split by the CSV parser at that comma into two fields ("January 1-31", " 2026") — joining
    // with " " would drop the comma the date-range/year-range patterns below require.
    const text = row.join(",");

    // "January 1-31, 2026" — a single month written as a day range.
    const dateRangeMatch = text.match(/(\w+)\s+(\d{1,2})-(\d{1,2}),\s+(\d{4})/);
    if (dateRangeMatch) {
      const [, monthName, , , year] = dateRangeMatch;
      const month = parseMonthName(monthName);
      if (month !== -1) {
        const y = parseInt(year, 10);
        return {
          label: `${MONTH_NAMES[month][0].toUpperCase()}${MONTH_NAMES[month].slice(1)} ${y}`,
          periodType: "month", periodStart: monthStartUTC(y, month), periodEnd: endOfMonthUTC(y, month),
          monthsCovered: 1, confident: true,
        };
      }
    }

    // "January-July 2026" / "January - July, 2026" in a title line.
    const titleRange = text.match(/(\w+)\s*-\s*(\w+),?\s+(\d{4})/);
    if (titleRange) {
      const startMonth = parseMonthName(titleRange[1]);
      const endMonth = parseMonthName(titleRange[2]);
      if (startMonth !== -1 && endMonth !== -1) {
        const y = parseInt(titleRange[3], 10);
        const monthsCovered = endMonth - startMonth + 1;
        if (monthsCovered >= 1) {
          const periodStart = monthStartUTC(y, startMonth);
          const periodEnd = endOfMonthUTC(y, endMonth);
          if (startMonth === 0 && endMonth === 11) {
            return { label: `${y} (annual)`, periodType: "annual", periodStart, periodEnd, monthsCovered: 12, confident: true };
          }
          if (startMonth === 0) {
            return { label: `YTD through ${MONTH_NAMES[endMonth]} ${y}`, periodType: "year_to_date", periodStart, periodEnd, monthsCovered, confident: true };
          }
          return { label: text.trim(), periodType: "custom", periodStart, periodEnd, monthsCovered, confident: true };
        }
      }
    }

    // A single month name + year in the title, e.g. "Profit & Loss January 2026".
    const monthYearMatch = text.match(/(\w+)\s+(\d{4})/);
    if (monthYearMatch) {
      const [, monthName, year] = monthYearMatch;
      const month = parseMonthName(monthName);
      if (month !== -1) {
        const y = parseInt(year, 10);
        return {
          label: `${MONTH_NAMES[month][0].toUpperCase()}${MONTH_NAMES[month].slice(1)} ${y}`,
          periodType: "month", periodStart: monthStartUTC(y, month), periodEnd: endOfMonthUTC(y, month),
          monthsCovered: 1, confident: true,
        };
      }
    }
  }
  return null;
}

/**
 * Find the header row that carries period columns (e.g. "Jan 2025", "Feb 2025", ..., "Total")
 * and classify every column after the first as a period, if it looks like one.
 *
 * This used to search for a single row whose first cell contains "account", OR equals "income"
 * or "revenue", and use THAT row as the header. Those are two different rows in a real
 * QuickBooks Online multi-column export: the period-header row itself has an empty first cell
 * (",Jan 2025,Feb 2025,...,Total") and sits ABOVE the "Income" section-label row, separated by
 * a blank line. Treating "income"/"revenue" as equivalent to "account" picked the blank-celled
 * "Income" row as the header, found zero classifiable period columns on it, and fell back to a
 * single unconfident column — silently discarding every month but the first and mislabeling an
 * 11-month statement as a single period. The hand-written test fixture
 * (`test-data/multi-column-pl.csv`) never caught this because it labels its header row's first
 * cell "Account" — a real QBO export's header row has no such label.
 *
 * So the two cases are handled separately: a row whose first cell literally contains "account"
 * IS the header row (it names its own columns). A row whose first cell is exactly "income" or
 * "revenue" is a SECTION label, not a header — the header, if any, is the row immediately
 * above it.
 */
function detectPeriods(records: any[]): { headerRowIndex: number; periods: DetectedPeriod[] } {
  let headerRowIndex = -1;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.length < 2) continue;
    const first = String(row[0]).toLowerCase();
    if (first.includes('account')) {
      headerRowIndex = i;
      break;
    }
    if (first === 'income' || first === 'revenue') {
      headerRowIndex = i > 0 ? i - 1 : -1;
      break;
    }
  }

  const detected: DetectedPeriod[] = [];
  const titlePeriod = extractTitlePeriod(records);

  if (headerRowIndex !== -1) {
    const headerRow = records[headerRowIndex];
    for (let col = 1; col < headerRow.length; col++) {
      const classified = classifyHeaderCell(String(headerRow[col] ?? ""));
      if (classified) {
        detected.push({ columnIndex: col, ...classified });
      }
    }
  }

  if (detected.length === 0) {
    // No parseable period headers (a plain "Account, Total" export, or the header row itself
    // wasn't found). Fall back to a single amount column, dated from the title line if present.
    // Not confident: the caller/upload flow should force the user to confirm this period.
    const fallback = titlePeriod ?? {
      label: "Unknown period",
      periodType: "unknown" as PeriodType,
      periodStart: new Date(),
      periodEnd: new Date(),
      monthsCovered: 1,
      confident: false,
    };
    detected.push({ columnIndex: 1, ...fallback, confident: titlePeriod ? true : false });
  }

  return { headerRowIndex: headerRowIndex === -1 ? 0 : headerRowIndex, periods: detected };
}

export function parseCSV(fileContent: string): CSVParseResult {
  const errors: string[] = [];

  let records: any[];
  try {
    records = parse(fileContent, {
      skip_empty_lines: true,
      trim: false,
      relax_column_count: true,
      relax_quotes: true,
    });
  } catch (error: any) {
    throw new Error(`CSV parsing failed: ${error.message}`);
  }

  if (records.length === 0) {
    throw new Error("CSV file is empty");
  }

  const { periods: detectedPeriods } = detectPeriods(records);

  const nodes = parseHierarchy(records, detectedPeriods, errors);

  if (nodes.length === 0) {
    throw new Error("No valid P&L categories found in CSV");
  }

  return {
    nodes,
    periods: detectedPeriods,
    errors,
  };
}

function parseHierarchy(records: any[], detectedPeriods: DetectedPeriod[], errors: string[]): PlNode[] {
  const nodes: PlNode[] = [];
  let displayOrder = 0;
  let nextId = 1;

  let dataStartIndex = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.length >= 2 &&
        (String(row[0]).toLowerCase().includes('account') ||
         String(row[0]).toLowerCase() === 'income' ||
         String(row[0]).toLowerCase() === 'revenue')) {
      dataStartIndex = i + 1;
      break;
    }
  }

  const stack: { tempId: string; label: string; level: number }[] = [];
  const topLevelSections = [
    'income', 'revenue', 'cost of goods sold', 'cogs', 'expenses',
    'operating expenses', 'other income', 'other expenses'
  ];

  for (let i = dataStartIndex; i < records.length; i++) {
    const row = records[i];

    if (!row || row.length < 2) continue;

    const label = String(row[0] || "").trim();

    if (!label || label.toLowerCase().includes('basis') || label.toLowerCase().includes('gmt')) {
      continue;
    }

    // One amount per detected period column, in the same order as `detectedPeriods`.
    const amounts = detectedPeriods.map(p => parseAmount(String(row[p.columnIndex] ?? "").trim()));
    const hasAnyAmount = amounts.some(a => a !== null);

    const isRollup = isRollupRow(label);
    const isTopLevel = topLevelSections.some(section =>
      label.toLowerCase() === section ||
      label.toLowerCase().startsWith(section + ' ')
    );

    const isStructural = !hasAnyAmount && !isRollup;

    let level = 0;

    if (isTopLevel) {
      stack.length = 0;
      level = 0;
    } else if (isRollup) {
      if (label.startsWith('Total for ')) {
        while (stack.length > 0) {
          stack.pop();
        }
        level = 0;
      } else {
        stack.length = 0;
        level = 0;
      }
    } else {
      level = stack.length > 0 ? stack[stack.length - 1].level + 1 : 0;
    }

    const parentTempId = stack.length > 0 ? stack[stack.length - 1].tempId : undefined;
    const sourcePath = buildPathFromStack(stack, label);

    const tempId = `temp_${nextId++}`;

    let suggestedCategory: ClearpathCategory | undefined;
    let confidence: ConfidenceLevel | undefined;

    if (hasAnyAmount && !isRollup) {
      const mapping = autoMapCategory(label, sourcePath);
      suggestedCategory = mapping.category;
      confidence = mapping.confidence;
    }

    const node: PlNode = {
      tempId,
      label,
      level,
      displayOrder: displayOrder++,
      amounts,
      isRollup,
      sourcePath,
      parentTempId,
      suggestedCategory,
      confidence,
    };

    nodes.push(node);

    if (isStructural) {
      stack.push({ tempId, label, level });
    }
  }

  return nodes;
}

function isRollupRow(label: string): boolean {
  const lowerLabel = label.toLowerCase().trim();

  if (lowerLabel.startsWith('total ') || lowerLabel === 'total') return true;
  if (lowerLabel.startsWith('subtotal')) return true;

  // QuickBooks phrases summary lines many ways — "Net Other Income", "Net Other Income
  // (Expense)", "Net Income (Loss)". The old exact-string list missed every variant, which is
  // how a subtotal became a mappable leaf and got counted alongside its own children.
  // This is a best effort, not a guarantee: the user-facing "exclude from report" control is
  // the durable fix, because no heuristic catches every phrasing.
  const withoutQualifier = lowerLabel.replace(/\s*\((?:loss|expense|deficit)\)\s*$/, '').trim();
  if (/^net\s+(income|operating income|other income|profit|loss|earnings)$/.test(withoutQualifier)) return true;
  if (withoutQualifier === 'gross profit' || withoutQualifier === 'gross margin') return true;

  return false;
}

function buildPathFromStack(stack: { tempId: string; label: string; level: number }[], currentLabel: string): string {
  const pathParts = stack.map(s => s.label);
  pathParts.push(currentLabel);
  return pathParts.join(' > ');
}

function parseAmount(amountStr: string): number | null {
  if (!amountStr || amountStr.trim() === '') {
    return null;
  }

  let cleaned = amountStr.replace(/[$,\s]/g, '');

  if (cleaned === '' || cleaned === '-') {
    return null;
  }

  let isNegative = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    isNegative = true;
    cleaned = cleaned.slice(1, -1);
  }

  if (cleaned.startsWith('-')) {
    isNegative = true;
    cleaned = cleaned.slice(1);
  }

  const amount = parseFloat(cleaned);

  if (isNaN(amount)) {
    return null;
  }

  const amountCents = Math.round(amount * 100);
  return isNegative ? -amountCents : amountCents;
}

/**
 * Words that mean "this cost is the delivery itself, performed by a person" as opposed to
 * "this cost is a thing we bought and resold".
 *
 * The COGS-vs-Services split is new in Phase 2 — the old model had a single Fulfillment
 * bucket, so there is no prior heuristic to carry over. The distinction that matters to the
 * report is *which side of delivery cost drives a variance* — materials pressure behaves
 * differently from labour pressure. Anything genuinely ambiguous is returned as
 * `needs_review` rather than guessed at confidently, because a lay user correcting a flagged
 * line is a far better outcome than a confident wrong total.
 */
const SERVICES_PATTERNS = [
  'subcontract', 'sub-contract', 'contract labor', 'contract labour', 'contractor',
  'installer', 'technician', 'crew', 'labor', 'labour', 'freelance', '1099',
  'project management', 'delivery fee', 'service fee', 'professional fee',
  'outsourc', 'fulfillment service',
];

const COGS_PATTERNS = [
  'material', 'supplies', 'inventory', 'parts', 'product cost', 'goods',
  'freight', 'shipping', 'postage', 'packaging', 'merchant', 'processing fee',
  'payment processing', 'wholesale', 'purchase',
];

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => haystack.includes(n));
}

/**
 * Split a line already known to be a delivery cost into COGS vs. Services.
 * Confidence is deliberately conservative: `medium` on a keyword hit, `needs_review` when
 * nothing matches, so the review screen surfaces it.
 */
function splitFulfillment(text: string): { category: ClearpathCategory; confidence: ConfidenceLevel } {
  if (matchesAny(text, SERVICES_PATTERNS)) {
    return { category: "fulfillment_services", confidence: "medium" };
  }
  if (matchesAny(text, COGS_PATTERNS)) {
    return { category: "fulfillment_cogs", confidence: "medium" };
  }
  return { category: "fulfillment_cogs", confidence: "needs_review" };
}

function autoMapCategory(label: string, path: string): { category: ClearpathCategory; confidence: ConfidenceLevel } {
  const lowerLabel = label.toLowerCase();
  const lowerPath = path.toLowerCase();
  const text = `${lowerPath} ${lowerLabel}`;

  if (lowerLabel.startsWith('total for ') ||
      lowerLabel === 'gross profit' ||
      lowerLabel === 'net operating income' ||
      lowerLabel === 'net income') {
    return { category: "revenue", confidence: "needs_review" };
  }

  if (lowerPath.includes('income') || lowerPath.includes('revenue') || lowerPath.includes('sales')) {
    return { category: "revenue", confidence: "high" };
  }

  // HVAC vocabulary first: an HVAC chart of accounts names things the generic rules don't know,
  // and two of those decide whether the scorecard is honest (fuel is fulfillment, truck leases
  // are overhead). Anything these rules don't recognise falls through unchanged.
  const hvac = matchHvacAccount(lowerLabel, lowerPath);
  if (hvac) {
    return { category: hvac.category, confidence: hvac.confidence };
  }

  // Delivery costs, then split by which side of delivery they sit on.
  if (lowerPath.includes('cost of goods') || lowerPath.includes('cogs') ||
      lowerPath.includes('cost of sales') || lowerPath.includes('fulfillment')) {
    return splitFulfillment(text);
  }

  if (lowerPath.includes('cac') || lowerPath.includes('customer acquisition')) {
    return { category: "cac", confidence: "high" };
  }

  if (lowerLabel.includes('advertis') || lowerLabel.includes('marketing') ||
      lowerLabel.includes('ad spend') || lowerLabel.includes('sales commission')) {
    return { category: "cac", confidence: "high" };
  }

  // Owner money is an Ascent move, not an operating cost — it must be caught BEFORE the
  // payroll branch, or an owner's salary line lands in OpEx People and understates the
  // Basecamp metric it is supposed to sit below.
  if (lowerLabel.includes('owner') || lowerLabel.includes('distribution') ||
      lowerLabel.includes("member draw") || lowerLabel.includes('draw') ||
      lowerLabel.includes('shareholder') || lowerLabel.includes('dividend') ||
      lowerLabel.includes('guaranteed payment')) {
    return { category: "tax_strategy", confidence: "medium" };
  }

  if (lowerLabel.includes('retirement') || lowerLabel.includes('401') ||
      lowerLabel.includes('sep ira') || lowerLabel.includes('pension') ||
      lowerLabel.includes('accountable plan') || lowerLabel.includes('augusta')) {
    return { category: "tax_strategy", confidence: "medium" };
  }

  // Income/corporate tax is an Ascent move. Sales tax and payroll tax are not — they are
  // operating costs the business cannot strategise away.
  if (lowerLabel.includes('tax') && !lowerPath.includes('sales') &&
      !lowerLabel.includes('sales tax') && !lowerLabel.includes('payroll tax')) {
    return { category: "tax_strategy", confidence: "medium" };
  }

  if (lowerPath.includes('people') || lowerPath.includes('payroll') || lowerPath.includes('employee')) {
    // Delivery labour belongs to Fulfillment even when the P&L files it under payroll —
    // this is the framework's "shadow fulfillment" point.
    if (matchesAny(text, SERVICES_PATTERNS)) {
      return { category: "fulfillment_services", confidence: "needs_review" };
    }
    if (lowerLabel.includes('wage') || lowerLabel.includes('salary') || lowerLabel.includes('payroll')) {
      return { category: "opex_people", confidence: "medium" };
    }
    return { category: "opex_people", confidence: "medium" };
  }

  if (lowerPath.includes('systems') || lowerPath.includes('opex')) {
    return { category: "opex_systems", confidence: "high" };
  }

  if (lowerLabel.includes('software') || lowerLabel.includes('subscription') ||
      lowerLabel.includes('rent') || lowerLabel.includes('utilities') ||
      lowerLabel.includes('insurance') || lowerLabel.includes('bank') ||
      lowerLabel.includes('legal') || lowerLabel.includes('professional')) {
    return { category: "opex_systems", confidence: "medium" };
  }

  if (lowerPath.includes('expense')) {
    return { category: "opex_systems", confidence: "needs_review" };
  }

  return { category: "opex_systems", confidence: "needs_review" };
}
