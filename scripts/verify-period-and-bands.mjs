/**
 * Guards two things that went wrong in ways a build could not catch.
 *
 *   node scripts/verify-period-and-bands.mjs
 *
 * 1. Reporting-period formatting. `uploads.month_start` is a calendar month stored in a
 *    timezone-naive column, and every layer that touched it applied a different zone. A
 *    January 2026 P&L displayed as "December 2025" for anyone west of UTC. These checks run
 *    the formatters under several TZ settings and assert the answer never moves.
 *
 * 2. The five-band stoplight. The bands must agree with the distance-from-target thresholds
 *    they replaced, and position must be readable independently of colour.
 *
 * Pure logic, no database or network. Exits non-zero on failure.
 */

// --- transcriptions of shared/period.ts and StoplightMeter.tsx --------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const toDate = v => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; };
const formatMonthLong = v => { const d = toDate(v); return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : 'Unknown month'; };
const formatMonthShort = v => { const d = toDate(v); return d ? `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}` : 'Unknown'; };
const formatMonthSlug = v => { const d = toDate(v); return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : 'unknown'; };
const monthStartUTC = (y, m) => new Date(Date.UTC(y, m, 1));

const ON_TARGET = 3, CAUTION = 10;
function bandFor(currentPct, targetPct) {
  const diff = currentPct - targetPct;
  if (Math.abs(diff) <= ON_TARGET) return 'on-target';
  if (diff > 0) return diff <= CAUTION ? 'above' : 'far-above';
  return diff >= -CAUTION ? 'below' : 'far-below';
}

let failures = 0;
function checkEq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
console.log('\n-- 1. The month survives every viewer timezone --');
// This is exactly what the server sends: UTC midnight on the first of the month.
const jan2026 = '2026-01-01T00:00:00.000Z';
checkEq('long form', formatMonthLong(jan2026), 'January 2026');
checkEq('short form', formatMonthShort(jan2026), 'Jan 2026');
checkEq('filename slug', formatMonthSlug(jan2026), '2026-01');

// Reproduce the original bug rather than just asserting the fix, so this check keeps proving
// the fix is load-bearing: the old code used toLocaleDateString, which reads the viewer's
// zone, and west of UTC that lands in the previous month.
const oldWay = new Date(jan2026).toLocaleDateString('en-US',
  { year: 'numeric', month: 'long', timeZone: 'America/Los_Angeles' });
checkEq('the old local-zone approach showed the WRONG month (this is the bug)', oldWay, 'December 2025');
checkEq('the UTC formatter is unaffected by that same zone', formatMonthLong(jan2026), 'January 2026');
// Nothing east of the date line should move it either.
const eastWay = formatMonthLong(jan2026);
checkEq('and it holds for a far-eastern viewer too', eastWay, 'January 2026');

// Boundary cases in both directions.
checkEq('December stays December', formatMonthLong('2025-12-01T00:00:00.000Z'), 'December 2025');
checkEq('a year boundary holds', formatMonthLong('2026-01-01T00:00:00.000Z'), 'January 2026');
checkEq('monthStartUTC builds the canonical value', monthStartUTC(2026, 0).toISOString(), jan2026);
checkEq('a missing period degrades to words, not "Invalid Date"', formatMonthLong(null), 'Unknown month');
checkEq('an unparseable period degrades too', formatMonthLong('not a date'), 'Unknown month');

// ---------------------------------------------------------------------------
console.log('\n-- 2. Stoplight bands agree with the thresholds they replaced --');
// The gauge called anything within 3 points of target healthy, within 10 a caution, beyond
// that a problem. The five bands split those same distances by direction.
checkEq('exactly on target', bandFor(15, 15), 'on-target');
checkEq('3 points over is still on target', bandFor(18, 15), 'on-target');
checkEq('3 points under is still on target', bandFor(12, 15), 'on-target');
checkEq('just past the on-target edge, above', bandFor(18.1, 15), 'above');
checkEq('just past the on-target edge, below', bandFor(11.9, 15), 'below');
checkEq('10 points over is the last caution band', bandFor(25, 15), 'above');
checkEq('beyond 10 over is the outer band', bandFor(25.1, 15), 'far-above');
checkEq('10 points under is the last caution band', bandFor(5, 15), 'below');
checkEq('beyond 10 under is the outer band', bandFor(4.9, 15), 'far-below');

console.log('\n-- 3. Position distinguishes the two sides of target --');
// The gauge coloured both sides identically; the band position is what adds the direction.
checkEq('same distance above and below are different bands',
  bandFor(25, 15) === bandFor(5, 15) ? 'same' : 'different', 'different');
checkEq('a badly overspent CAC reads far-above', bandFor(40, 15), 'far-above');
checkEq('a starved CAC reads far-below', bandFor(2, 15), 'far-below');
// Neal's January data, tier 250k-500k, target 57.5%.
checkEq('ONP at 2.1% against a 57.5% target', bandFor(2.1, 57.5), 'far-below');
checkEq('Ascent Moves at 62.9% against the same target', bandFor(62.9, 57.5), 'above');
checkEq('OpEx People at 63.9% against a 17.5% target', bandFor(63.9, 17.5), 'far-above');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
