/**
 * Phase 2 (project 2143) rollup verification.
 *
 * Checks the consolidated rollup arithmetic against hand-computed figures, including the
 * double-count case that motivated the "exclude from report" state. Pure arithmetic — no
 * database, no network — so it can run anywhere.
 *
 *   node scripts/verify-rollups.mjs
 *
 * Exits non-zero on any failure.
 */

// Mirror of computeMetrics() in server/lib/rollups.ts. Kept as a literal transcription rather
// than an import so this script needs no TypeScript build step; if the two ever disagree, that
// disagreement is itself the thing worth catching.
function computeMetrics(nodes) {
  const totals = {
    revenue: 0, fulfillment_cogs: 0, fulfillment_services: 0,
    cac: 0, opex_systems: 0, opex_people: 0, tax_strategy: 0,
  };
  for (const n of nodes) {
    if (n.amountCents !== null && n.isRollup === 0 && n.category && n.status !== 'excluded') {
      totals[n.category] += n.amountCents;
    }
  }
  const EXPENSE_KEYS = ['fulfillment_cogs', 'fulfillment_services', 'cac',
    'opex_systems', 'opex_people', 'tax_strategy'];
  const expenseSum = EXPENSE_KEYS.reduce((a, k) => a + totals[k], 0);
  const expenseSign = expenseSum < 0 ? -1 : 1;
  const d = c => c / 100;
  const e = c => (expenseSign * c) / 100;
  const revenue = Math.abs(d(totals.revenue));
  const fulfillmentCogs = e(totals.fulfillment_cogs);
  const fulfillmentServices = e(totals.fulfillment_services);
  const fulfillment = fulfillmentCogs + fulfillmentServices;
  const grossProfit = revenue - fulfillment;
  const cac = e(totals.cac);
  const opexSystems = e(totals.opex_systems);
  const opexPeople = e(totals.opex_people);
  const operationalNetProfit = grossProfit - cac - opexSystems - opexPeople;
  const taxStrategy = e(totals.tax_strategy);
  const taxableNetProfit = operationalNetProfit - taxStrategy;
  const pct = v => (grossProfit > 0 ? (v / grossProfit) * 100 : null);
  return {
    revenue, fulfillmentCogs, fulfillmentServices, fulfillment,
    fulfillmentPct: revenue > 0 ? (fulfillment / revenue) * 100 : null,
    grossProfit, cac, cacPct: pct(cac),
    opexSystems, opexSystemsPct: pct(opexSystems),
    opexPeople, opexPeoplePct: pct(opexPeople),
    operationalNetProfit, operationalNetProfitPct: pct(operationalNetProfit),
    taxStrategy, taxStrategyPct: pct(taxStrategy),
    taxableNetProfit, taxableNetProfitPct: pct(taxableNetProfit),
  };
}

// Mirror of normalizeCategoryTotals() + deriveMetrics() in server/lib/rollups.ts — the split
// that fixed the Phase 2.6 multi-period sign-convention bug (§9 below). Sign detection happens
// PER NODE-SET here, exactly like computeMetrics() above; the difference is loadMultiPeriodMetrics
// now calls this once per PERIOD and sums the normalized dollar totals, instead of concatenating
// every period's raw rows and detecting one sign convention across all of them.
function normalizeCategoryTotals(nodes) {
  const totals = {
    revenue: 0, fulfillment_cogs: 0, fulfillment_services: 0,
    cac: 0, opex_systems: 0, opex_people: 0, tax_strategy: 0,
  };
  for (const n of nodes) {
    if (n.amountCents !== null && n.isRollup === 0 && n.category && n.status !== 'excluded') {
      totals[n.category] += n.amountCents;
    }
  }
  const EXPENSE_KEYS = ['fulfillment_cogs', 'fulfillment_services', 'cac',
    'opex_systems', 'opex_people', 'tax_strategy'];
  const expenseSum = EXPENSE_KEYS.reduce((a, k) => a + totals[k], 0);
  const expenseSign = expenseSum < 0 ? -1 : 1;
  const e = c => (expenseSign * c) / 100;
  return {
    revenue: Math.abs(totals.revenue / 100),
    fulfillmentCogs: e(totals.fulfillment_cogs),
    fulfillmentServices: e(totals.fulfillment_services),
    cac: e(totals.cac),
    opexSystems: e(totals.opex_systems),
    opexPeople: e(totals.opex_people),
    taxStrategy: e(totals.tax_strategy),
  };
}

function sumNormalizedTotals(list) {
  return list.reduce((acc, t) => ({
    revenue: acc.revenue + t.revenue,
    fulfillmentCogs: acc.fulfillmentCogs + t.fulfillmentCogs,
    fulfillmentServices: acc.fulfillmentServices + t.fulfillmentServices,
    cac: acc.cac + t.cac,
    opexSystems: acc.opexSystems + t.opexSystems,
    opexPeople: acc.opexPeople + t.opexPeople,
    taxStrategy: acc.taxStrategy + t.taxStrategy,
  }), { revenue: 0, fulfillmentCogs: 0, fulfillmentServices: 0, cac: 0, opexSystems: 0, opexPeople: 0, taxStrategy: 0 });
}

function deriveMetrics(t) {
  const fulfillment = t.fulfillmentCogs + t.fulfillmentServices;
  const grossProfit = t.revenue - fulfillment;
  const operationalNetProfit = grossProfit - t.cac - t.opexSystems - t.opexPeople;
  const taxableNetProfit = operationalNetProfit - t.taxStrategy;
  const pct = v => (grossProfit > 0 ? (v / grossProfit) * 100 : null);
  return {
    revenue: t.revenue, fulfillmentCogs: t.fulfillmentCogs, fulfillmentServices: t.fulfillmentServices,
    fulfillment, fulfillmentPct: t.revenue > 0 ? (fulfillment / t.revenue) * 100 : null,
    grossProfit, cac: t.cac, cacPct: pct(t.cac),
    opexSystems: t.opexSystems, opexSystemsPct: pct(t.opexSystems),
    opexPeople: t.opexPeople, opexPeoplePct: pct(t.opexPeople),
    operationalNetProfit, operationalNetProfitPct: pct(operationalNetProfit),
    taxStrategy: t.taxStrategy, taxStrategyPct: pct(t.taxStrategy),
    taxableNetProfit, taxableNetProfitPct: pct(taxableNetProfit),
  };
}

/** The FIXED multi-period path: normalize each period's own rows, then sum. */
function multiPeriodMetricsFixed(periodsOfNodes) {
  return deriveMetrics(sumNormalizedTotals(periodsOfNodes.map(normalizeCategoryTotals)));
}

/** The OLD, BROKEN multi-period path: concatenate every period's raw rows first, then detect
 *  ONE sign convention across the combined set. Kept only so §9 can prove it's wrong. */
function multiPeriodMetricsBroken(periodsOfNodes) {
  return computeMetrics(periodsOfNodes.flat());
}

function getTier(grossProfit) {
  const a = grossProfit * 12;
  if (a < 250000) return 'under-250k';
  if (a < 500000) return '250k-500k';
  if (a < 1000000) return '500k-1mm';
  if (a < 5000000) return '1mm-5mm';
  return '5mm-plus';
}

const TIERS = {
  'under-250k': { cac: 15, opexSystems: 10, opexPeople: 10, operationalNetProfit: 65 },
  '250k-500k': { cac: 15, opexSystems: 10, opexPeople: 17.5, operationalNetProfit: 57.5 },
  '500k-1mm': { cac: 15, opexSystems: 10, opexPeople: 25, operationalNetProfit: 50 },
  '1mm-5mm': { cac: 15, opexSystems: 10, opexPeople: 40, operationalNetProfit: 35 },
  '5mm-plus': { cac: 15, opexSystems: 10, opexPeople: 40, operationalNetProfit: 35 },
};

let failures = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.005;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures++;
}
function checkEq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures++;
}

const leaf = (category, dollars, status = 'mapped') =>
  ({ amountCents: Math.round(dollars * 100), isRollup: 0, category, status });

// ---------------------------------------------------------------------------
// 1. Hand-checked P&L.
//    Revenue 100,000. COGS 12,000 + Services 8,000 = Fulfillment 20,000.
//    Gross Profit = 80,000.  CAC 10,000 / Systems 6,000 / People 14,000 = 30,000.
//    Operational Net Profit = 50,000  (62.5% of GP)
//    Ascent Moves 30,000 -> Taxable Net Profit = 20,000  (25% of GP)
// ---------------------------------------------------------------------------
console.log('\n-- 1. Hand-checked arithmetic --');
const m1 = computeMetrics([
  leaf('revenue', -100000),          // revenue often arrives negative; sign must not matter
  leaf('fulfillment_cogs', 12000),
  leaf('fulfillment_services', 8000),
  leaf('cac', 10000),
  leaf('opex_systems', 6000),
  leaf('opex_people', 14000),
  leaf('tax_strategy', 30000),
]);
check('revenue', m1.revenue, 100000);
check('fulfillment (combined)', m1.fulfillment, 20000);
check('fulfillmentPct (of revenue)', m1.fulfillmentPct, 20);
check('grossProfit', m1.grossProfit, 80000);
check('cacPct (of GP)', m1.cacPct, 12.5);
check('operationalNetProfit', m1.operationalNetProfit, 50000);
check('operationalNetProfitPct', m1.operationalNetProfitPct, 62.5);
check('taxableNetProfit', m1.taxableNetProfit, 20000);
check('taxableNetProfitPct', m1.taxableNetProfitPct, 25);

// ---------------------------------------------------------------------------
// 2. Owner compensation must NOT reduce Operational Net Profit.
//    This is the behavioural heart of the new model.
// ---------------------------------------------------------------------------
console.log('\n-- 2. Owner comp sits below the line --');
const base = [leaf('revenue', 100000), leaf('fulfillment_cogs', 20000), leaf('cac', 10000)];
const withoutOwner = computeMetrics(base);
const withOwner = computeMetrics([...base, leaf('tax_strategy', 40000)]);
check('ONP without owner comp', withoutOwner.operationalNetProfit, 70000);
check('ONP with owner comp (unchanged)', withOwner.operationalNetProfit, 70000);
check('Taxable NP absorbs it', withOwner.taxableNetProfit, 30000);

// ---------------------------------------------------------------------------
// 3. The double-count that motivated "exclude from report".
//    A QuickBooks P&L carries below-the-line Other Expenses AND a "Net Other Income"
//    summary of those same items. If the summary is misjudged as a leaf, both are counted.
// ---------------------------------------------------------------------------
console.log('\n-- 3. Exclusion fixes the double-count --');
const doubleCounted = [
  leaf('revenue', 100000),
  leaf('fulfillment_cogs', 20000),
  leaf('opex_systems', 5000),
  leaf('opex_systems', 3000),
  leaf('opex_systems', 8000),            // "Net Other Income" — the sum of the two above
];
const before = computeMetrics(doubleCounted);
check('OpEx Systems inflated by the subtotal', before.opexSystems, 16000);

const corrected = [...doubleCounted];
corrected[4] = leaf('opex_systems', 8000, 'excluded');
const after = computeMetrics(corrected);
check('OpEx Systems after excluding it', after.opexSystems, 8000);
check('ONP corrected', after.operationalNetProfit, 72000);

// ---------------------------------------------------------------------------
// 4. Tiering is on Gross Profit, not revenue.
//    A business with 100k/mo revenue but only 15k/mo gross profit is a small business
//    (180k annualized GP), not a $1.2M one. The old code tiered it as '1mm-5mm'.
// ---------------------------------------------------------------------------
console.log('\n-- 4. Tier axis is Gross Profit --');
const thin = computeMetrics([leaf('revenue', 100000), leaf('fulfillment_cogs', 85000)]);
check('grossProfit', thin.grossProfit, 15000);
checkEq('tier by GP', getTier(thin.grossProfit), 'under-250k');
checkEq('tier the old revenue axis would have given', getTier(thin.revenue), '1mm-5mm');

// ---------------------------------------------------------------------------
// 5. Every tier's targets still allocate exactly 100% of Gross Profit.
//    This is what makes the Operational Net Profit target a re-derivation of the shipped
//    table rather than a new threshold: ONP = 100 - (CAC + Systems + People).
// ---------------------------------------------------------------------------
console.log('\n-- 5. Tier tables still sum to 100% --');
for (const [tier, b] of Object.entries(TIERS)) {
  check(`${tier} allocates 100%`, b.cac + b.opexSystems + b.opexPeople + b.operationalNetProfit, 100);
}

// ---------------------------------------------------------------------------
// 6. Empty / zero-revenue upload must not divide by zero.
// ---------------------------------------------------------------------------
console.log('\n-- 6. Empty upload --');
const empty = computeMetrics([]);
check('grossProfit', empty.grossProfit, 0);
checkEq('cacPct is null, not NaN', empty.cacPct, null);
checkEq('fulfillmentPct is null, not NaN', empty.fulfillmentPct, null);

// ---------------------------------------------------------------------------
// 7. Sign convention. A QuickBooks CSV files expenses positive; the PDF path's Gemini
//    prompt files them negative. Both must produce the same report.
//    Before this was handled, a PDF-sourced upload had every cost ADDED: Gross Profit came
//    out larger than revenue and Operational Net Profit read 173.8% of it. This predates
//    Phase 2 - all three of the old rollup copies did it.
// ---------------------------------------------------------------------------
console.log('\n-- 7. Both sign conventions produce the same report --');
const csvStyle = [
  leaf('revenue', 100000),
  leaf('fulfillment_cogs', 20000), leaf('cac', 10000),
  leaf('opex_systems', 6000), leaf('opex_people', 14000), leaf('tax_strategy', 30000),
];
const pdfStyle = [
  leaf('revenue', 100000),
  leaf('fulfillment_cogs', -20000), leaf('cac', -10000),
  leaf('opex_systems', -6000), leaf('opex_people', -14000), leaf('tax_strategy', -30000),
];
const csvM = computeMetrics(csvStyle);
const pdfM = computeMetrics(pdfStyle);
check('CSV-style grossProfit', csvM.grossProfit, 80000);
check('PDF-style grossProfit matches', pdfM.grossProfit, 80000);
check('CSV-style ONP', csvM.operationalNetProfit, 50000);
check('PDF-style ONP matches', pdfM.operationalNetProfit, 50000);
check('PDF-style ONP% is sane, not >100', pdfM.operationalNetProfitPct, 62.5);
checkEq('every field identical across conventions',
  JSON.stringify(csvM), JSON.stringify(pdfM));
check('CAC + Systems + People + ONP = 100% of GP',
  pdfM.cacPct + pdfM.opexSystemsPct + pdfM.opexPeoplePct + pdfM.operationalNetProfitPct, 100);

// ---------------------------------------------------------------------------
// 8. Phase 2.6 — a constructed annual/YTD figure (several periods' worth of
//    pl_node_period_amounts summed together) still satisfies the 100%-of-Gross-Profit
//    invariant. Uses multiPeriodMetricsFixed() — normalize each period's sign convention
//    separately, THEN sum — which is what loadMultiPeriodMetrics() actually does. (An earlier
//    version of this check called the OLD, broken concatenate-then-detect path instead; because
//    all three months here share one sign convention, that bug was invisible to it — see §9,
//    which is the case that actually caught it.)
// ---------------------------------------------------------------------------
console.log('\n-- 8. Constructed multi-period (YTD) sum still balances to 100% of GP --');
const jan = [
  leaf('revenue', 100000), leaf('fulfillment_cogs', 20000),
  leaf('cac', 10000), leaf('opex_systems', 6000), leaf('opex_people', 14000), leaf('tax_strategy', 30000),
];
const feb = [
  leaf('revenue', 110000), leaf('fulfillment_cogs', 22000),
  leaf('cac', 11000), leaf('opex_systems', 6000), leaf('opex_people', 15000), leaf('tax_strategy', 28000),
];
const mar = [
  leaf('revenue', 90000), leaf('fulfillment_cogs', 18000),
  leaf('cac', 9000), leaf('opex_systems', 6000), leaf('opex_people', 13000), leaf('tax_strategy', 26000),
];
const janM = computeMetrics(jan);
const febM = computeMetrics(feb);
const marM = computeMetrics(mar);
const q1Constructed = multiPeriodMetricsFixed([jan, feb, mar]);

// The summed metrics must equal the sum of the monthly metrics, not just look plausible —
// a display figure that silently differs from "add up the three months yourself" would be its
// own kind of double-count.
check('constructed revenue = sum of monthly revenue',
  q1Constructed.revenue, janM.revenue + febM.revenue + marM.revenue);
check('constructed grossProfit = sum of monthly grossProfit',
  q1Constructed.grossProfit, janM.grossProfit + febM.grossProfit + marM.grossProfit);
check('constructed operationalNetProfit = sum of monthly operationalNetProfit',
  q1Constructed.operationalNetProfit,
  janM.operationalNetProfit + febM.operationalNetProfit + marM.operationalNetProfit);
check('CAC + Systems + People + ONP = 100% of GP for the constructed figure',
  q1Constructed.cacPct + q1Constructed.opexSystemsPct + q1Constructed.opexPeoplePct + q1Constructed.operationalNetProfitPct,
  100);

// ---------------------------------------------------------------------------
// 9. Mixed sign conventions across periods in one constructed figure. Reported live (Neal,
//    2026-09-06): a constructed Full Year showed Fulfillment wrong relative to revenue and OpEx
//    People at -$123,744. Root cause: some months were CSV-sourced (expenses stored positive),
//    others PDF-sourced (expenses stored negative, per the Gemini prompt) — see §7 above for
//    that convention. The old multiPeriodMetricsBroken() concatenated every month's raw rows
//    and detected ONE sign convention for the combined set, which — depending on which
//    convention had the larger combined magnitude — could flip the WRONG months and/or partly
//    cancel within a category before any sign correction happened at all.
// ---------------------------------------------------------------------------
console.log('\n-- 9. Mixed sign conventions across periods (the live-site bug) --');
// A CSV-sourced month (expenses positive, OpEx People small) and a PDF-sourced month (expenses
// negative per the Gemini prompt, OpEx People LARGE). Individually each month normalizes fine.
// Concatenated first, the combined expense side nets POSITIVE (the CSV month's other categories
// are large enough to outweigh the PDF month's), so the broken path picks expenseSign = +1 for
// the whole set — but OpEx People's own combined cents are still deeply negative (the PDF
// month's $150,000 dominates that one category), and +1 times a negative is negative. That's
// the exact shape reported live: one category (there, OpEx People) reads negative while the
// rest of the report looks superficially plausible.
const csvMonth = [
  leaf('revenue', 500000),
  leaf('fulfillment_cogs', 100000), leaf('cac', 100000),
  leaf('opex_systems', 100000), leaf('opex_people', 10000), leaf('tax_strategy', 100000),
];
const pdfMonth = [
  leaf('revenue', -50000),
  leaf('fulfillment_cogs', -1000), leaf('cac', -1000),
  leaf('opex_systems', -1000), leaf('opex_people', -150000), leaf('tax_strategy', -1000),
];
const csvMonthM = computeMetrics(csvMonth);   // each month on its own is correctly normalized
const pdfMonthM = computeMetrics(pdfMonth);
check('sanity: csv month alone has positive OpEx People ($10,000)', csvMonthM.opexPeople, 10000);
check('sanity: pdf month alone correctly flips to positive OpEx People ($150,000)', pdfMonthM.opexPeople, 150000);
const expectedOpexPeople = csvMonthM.opexPeople + pdfMonthM.opexPeople; // 10000 + 150000 = 160000
const expectedGrossProfit = csvMonthM.grossProfit + pdfMonthM.grossProfit;

const fixed = multiPeriodMetricsFixed([csvMonth, pdfMonth]);
check('FIXED: OpEx People is positive and correct ($160,000)', fixed.opexPeople, expectedOpexPeople);
check('FIXED: Gross Profit matches the sum of the two months\' own Gross Profit',
  fixed.grossProfit, expectedGrossProfit);
check('FIXED: CAC + Systems + People + ONP = 100% of GP',
  fixed.cacPct + fixed.opexSystemsPct + fixed.opexPeoplePct + fixed.operationalNetProfitPct, 100);

const broken = multiPeriodMetricsBroken([csvMonth, pdfMonth]);
checkEq('BROKEN path reproduces the reported symptom: OpEx People goes negative',
  broken.opexPeople < 0, true);
console.log(`  (for reference — this is what shipped and was reported live: OpEx People = ${broken.opexPeople} vs the correct ${expectedOpexPeople})`);

// ---------------------------------------------------------------------------
// 10. Phase 2.7 — the comparison-specific variance filter documented in
//     clearpath-insight-framework-handoff.md: flag a line only when it moves by BOTH >10% of
//     the baseline AND >$1,500 in absolute dollars. Mirror of calculateComparisonVariances() in
//     server/lib/rollups.ts.
// ---------------------------------------------------------------------------
console.log('\n-- 10. Comparison variance filter (>10% AND $1,500) --');
const METRIC_KEYS = [
  'revenue', 'fulfillmentCogs', 'fulfillmentServices', 'fulfillment', 'grossProfit',
  'cac', 'opexSystems', 'opexPeople', 'operationalNetProfit', 'taxStrategy', 'taxableNetProfit',
];
function calculateComparisonVariances(baseline, current) {
  const variances = [];
  for (const key of METRIC_KEYS) {
    const baselineAmount = baseline[key];
    const currentAmount = current[key];
    if (typeof baselineAmount !== 'number' || typeof currentAmount !== 'number') continue;
    const amountDelta = currentAmount - baselineAmount;
    if (Math.abs(amountDelta) <= 1500) continue;
    const percentDelta = baselineAmount !== 0 ? (amountDelta / Math.abs(baselineAmount)) * 100 : null;
    const percentConditionMet = percentDelta === null ? amountDelta !== 0 : Math.abs(percentDelta) > 10;
    if (!percentConditionMet) continue;
    variances.push({ category: key, amountDelta, percentDelta });
  }
  return variances;
}

// Revenue: $100,000 -> $115,000. +$15,000 (>1500) and +15% (>10%) -> flagged.
const varA = calculateComparisonVariances({ revenue: 100000 }, { revenue: 115000 });
checkEq('flags a line crossing BOTH thresholds', varA.some(v => v.category === 'revenue'), true);

// Revenue: $100,000 -> $111,000. +$11,000 (>1500) but +11%... actually make a case where
// percent crosses but dollar doesn't: a tiny baseline moving a lot in % but under $1,500.
const varB = calculateComparisonVariances({ cac: 1000 }, { cac: 2600 }); // +160%, +$1,600 -> both cross
checkEq('a small baseline with a big swing still needs the dollar floor too (this one clears both)',
  varB.some(v => v.category === 'cac'), true);
const varC = calculateComparisonVariances({ cac: 1000 }, { cac: 1400 }); // +40%, +$400 -> dollar floor NOT cleared
checkEq('percent alone is not enough — under $1,500 stays unflagged', varC.length, 0);
const varD = calculateComparisonVariances({ revenue: 100000 }, { revenue: 105000 }); // +5%, +$5,000 -> percent floor NOT cleared
checkEq('dollars alone is not enough — under 10% stays unflagged', varD.length, 0);

// Baseline of zero: percent is undefined by division; any nonzero move over $1,500 is flagged
// rather than silently skipped or thrown as NaN.
const varE = calculateComparisonVariances({ opexSystems: 0 }, { opexSystems: 2000 });
checkEq('baseline of zero + a move over $1,500 is flagged (percent is undefined, not a blocker)',
  varE.some(v => v.category === 'opexSystems' && v.percentDelta === null), true);
const varF = calculateComparisonVariances({ opexSystems: 0 }, { opexSystems: 0 });
checkEq('baseline of zero with no actual change stays unflagged', varF.length, 0);

// ---------------------------------------------------------------------------
// 11. Phase 2.7 — an N-period (3+) trend view flags variance against BOTH the immediately
//     preceding period and the first period in the view (the logged decision for build
//     requirement #4). For a 2-period comparison the two readings are identical; for 3+ they can
//     diverge — a small step-over-step move can still add up to a large drift from where the
//     trend started, and a big one-time jump can also revert most of the way back.
// ---------------------------------------------------------------------------
console.log('\n-- 11. N-period trend flags vs-prior and vs-first independently --');
// Jan 100,000 -> Feb 108,000 (+8%, no flag month-over-month) -> Mar 130,000 (+20.4% vs Feb,
// flags vs-prior; +30% vs Jan, ALSO flags vs-first). This is the case where vs-prior alone would
// have caught March already; the point is vs-first must independently agree, not silently ride
// along.
const jan2 = { revenue: 100000 };
const feb2 = { revenue: 108000 };
const mar2 = { revenue: 130000 };
const janToFeb = calculateComparisonVariances(jan2, feb2);
const febToMar = calculateComparisonVariances(feb2, mar2);
const janToMar = calculateComparisonVariances(jan2, mar2);
checkEq('Jan->Feb (+8%, +$8,000): percent floor not cleared, no flag', janToFeb.length, 0);
checkEq('Feb->Mar (+20.4%, +$22,000) flags vs the immediately preceding period', febToMar.length > 0, true);
checkEq('Jan->Mar (+30%, +$30,000) ALSO flags vs the first period in the view', janToMar.length > 0, true);

// The reverse shape: a big vs-prior jump that mostly reverts, so vs-prior flags but vs-first
// does not — proving the two views are computed independently rather than one gating the other.
const jan3 = { revenue: 100000 };
const feb3 = { revenue: 140000 }; // +40% vs Jan -> flags vs-first
const mar3 = { revenue: 103000 }; // -26.4% vs Feb -> flags vs-prior; +3% vs Jan -> does NOT flag vs-first
const febToMar3 = calculateComparisonVariances(feb3, mar3);
const janToMar3 = calculateComparisonVariances(jan3, mar3);
checkEq('Mar flags vs the immediately preceding period (Feb->Mar, -26.4%)', febToMar3.length > 0, true);
checkEq('Mar does NOT flag vs the first period (Jan->Mar, only +3%) — the two views disagree, as designed',
  janToMar3.length, 0);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
