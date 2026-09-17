/**
 * Formatting for a P&L's reporting period.
 *
 * `uploads.month_start` is a **calendar month**, not a moment in time — but it is stored in a
 * `timestamp` column (no time zone), which means every layer that touches it is free to guess
 * a zone, and they guessed differently:
 *
 *   - the parsers build the Date from the server's local zone,
 *   - Postgres stores the naive literal `2026-01-01 00:00:00`,
 *   - Railway (UTC) reads it back as UTC and serialises `2026-01-01T00:00:00.000Z`,
 *   - the browser renders that with `toLocaleDateString()` in the *viewer's* zone.
 *
 * Anyone west of UTC therefore saw the month before: a January 2026 P&L displayed as
 * "December 2025". It looked correct from an Eastern workstation only by accident, because
 * reading the naive literal as local time nudged it back over the boundary.
 *
 * The fix is to stop letting any zone apply. Every helper here reads the Date's **UTC** parts,
 * so the calendar month that went in is the calendar month that comes out, on every machine.
 * Use these instead of `toLocaleDateString`/`date-fns format` anywhere `monthStart` is shown.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** "January 2026" — the report header, the PDF, the comparison column headings. */
export function formatMonthLong(value: Date | string | null | undefined): string {
  const d = toDate(value);
  if (!d) return "Unknown month";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Jan 2026" — where the long form doesn't fit. */
export function formatMonthShort(value: Date | string | null | undefined): string {
  const d = toDate(value);
  if (!d) return "Unknown";
  return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** "2026-01" — export filenames. Sorts correctly as a string, carries no false precision. */
export function formatMonthSlug(value: Date | string | null | undefined): string {
  const d = toDate(value);
  if (!d) return "unknown";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Build the canonical Date for a calendar month, as UTC midnight on the first.
 * Both parsers should use this rather than `new Date(year, month, 1)`, which is local
 * midnight and lands on a different calendar day depending on where the server runs.
 */
export function monthStartUTC(year: number, monthIndexZeroBased: number): Date {
  return new Date(Date.UTC(year, monthIndexZeroBased, 1));
}

/**
 * Phase 2.5 — period-aware intake and tiering.
 *
 * `uploads.month_start` assumed one upload equals one calendar month. Real P&Ls are monthly,
 * quarterly, year-to-date, annual, or a multi-column export with several of those side by
 * side. These helpers are the UTC-safe equivalent of the month helpers above, for a period
 * that isn't necessarily one month — same discipline (read UTC parts, never
 * `toLocaleDateString`/local `Date` math), extended to a start/end range.
 */

export type PeriodType = "month" | "quarter" | "year_to_date" | "annual" | "custom" | "unknown";

/** Last UTC calendar day of the month containing `date`, at UTC midnight. */
export function endOfMonthUTC(year: number, monthIndexZeroBased: number): Date {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndexZeroBased + 1, 0));
}

/**
 * Whole-month span between two UTC dates, inclusive of both ends' months.
 * `monthsBetweenUTC(Jan 1, Jan 31) === 1`; `monthsBetweenUTC(Jan 1, Jul 31) === 7`.
 */
export function monthsBetweenUTC(start: Date, end: Date): number {
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1;
  return Math.max(1, months);
}

/** "Jan 2026" / "Jan-Mar 2026" / "FY2026" / "YTD through Jul 2026" — for period pickers and labels. */
export function formatPeriodRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
  periodType: PeriodType,
): string {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return "Unknown period";

  if (periodType === "annual") {
    return `FY${s.getUTCFullYear()}`;
  }
  if (periodType === "year_to_date") {
    return `YTD through ${formatMonthShort(e)}`;
  }
  if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()) {
    return formatMonthLong(s);
  }
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const startLabel = MONTHS[s.getUTCMonth()].slice(0, 3);
  const endLabel = sameYear
    ? `${MONTHS[e.getUTCMonth()].slice(0, 3)} ${e.getUTCFullYear()}`
    : formatMonthShort(e);
  return `${startLabel}${sameYear ? "" : ` ${s.getUTCFullYear()}`}-${endLabel}`;
}

/**
 * Build requirement #7: every surface that shows a tier/annualized figure states the basis in
 * plain language, e.g. "Monthly P&L annualized from 1 month", "YTD P&L annualized from 7
 * months", "Annual P&L, no annualization applied". `sourceNote`, when given, names where the
 * months came from (a single statement vs. several confirmed monthly uploads) or which month is
 * missing from an attempted YTD history roll-up.
 */
export function describePeriodBasis(
  periodType: PeriodType,
  monthsCovered: number,
  sourceNote?: string,
): string {
  const months = monthsCovered === 1 ? "1 month" : `${monthsCovered} months`;
  let base: string;
  switch (periodType) {
    case "annual":
      base = monthsCovered >= 12
        ? "Annual P&L, no annualization applied"
        : `Partial-year P&L annualized from ${months}`;
      break;
    case "year_to_date":
      base = `YTD P&L annualized from ${months}`;
      break;
    case "quarter":
      base = `Quarterly P&L annualized from ${months}`;
      break;
    case "custom":
      base = `Custom-range P&L annualized from ${months}`;
      break;
    case "unknown":
      base = `P&L of unconfirmed period annualized from ${months}`;
      break;
    case "month":
    default:
      base = `Monthly P&L annualized from ${months}`;
      break;
  }
  return sourceNote ? `${base} (${sourceNote})` : base;
}
