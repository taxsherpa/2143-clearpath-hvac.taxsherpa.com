/**
 * Checks the HVAC benchmark model against the report it came from.
 *
 *   npx tsx scripts/verify-hvac-benchmarks.ts
 *
 * The internal-consistency checks are the ones that matter: if a column's fulfillment, gross
 * profit, CAC and OpEx don't add back to its stated net margin, a digit was mistyped somewhere
 * between the PDF and this repo, and every scorecard built on it would be quietly wrong.
 */
import {
  getHvacTier,
  getHvacBenchmarks,
  scoreMetrics,
  scoreHvac,
  tiersInOrder,
  TIER_LABELS,
  type HvacTier,
} from "../server/lib/hvac-benchmarks";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tolerance = 0.05) {
  return Math.abs(a - b) <= tolerance;
}

console.log("\nTiering");
check("a single month of $250K annualises into $2M-$5M ($3M)", getHvacTier(250_000, 1) === "2mm-5mm");
check("a single month of $150K annualises into $500K-$2M ($1.8M)", getHvacTier(150_000, 1) === "500k-2mm");
check("twelve months of $1.2M is $500K-$2M", getHvacTier(1_200_000, 12) === "500k-2mm");
check("$420K a year is under $500K", getHvacTier(420_000, 12) === "under-500k");
check("$2M exactly tips into $2M-$5M", getHvacTier(2_000_000, 12) === "2mm-5mm");
check("$10M exactly tips into the top tier", getHvacTier(10_000_000, 12) === "10mm-plus");
// A zero month count falls back to 1, so $500K reads as a $6M year rather than dividing by zero.
check("zero months doesn't divide by zero", getHvacTier(500_000, 0) === "5mm-10mm");

console.log("\nUnder $500K borrows the $500K-$2M column (Neal, 2026-09-15)");
{
  const set = getHvacBenchmarks("under-500k");
  const borrowed = getHvacBenchmarks("500k-2mm");
  check("tier is reported honestly as under-500k", set.tier === "under-500k");
  check("borrowedTier is set, so the UI can say so", set.borrowedTier === "500k-2mm");
  check(
    "the numbers are the $500K-$2M ones",
    set.benchmarks.netOperatingMargin.exceptional ===
      borrowed.benchmarks.netOperatingMargin.exceptional,
  );
  check("a real tier carries no borrowedTier", getHvacBenchmarks("2mm-5mm").borrowedTier === undefined);
}

console.log("\nEvery column adds up (the check that catches a mistyped digit)");
for (const tier of tiersInOrder().filter((t) => t !== "under-500k") as Exclude<HvacTier, "under-500k">[]) {
  const { benchmarks: b } = getHvacBenchmarks(tier);
  for (const column of ["average", "exceptional"] as const) {
    const fulfillment = b.fulfillmentCogs[column] + b.fulfillmentServices[column];
    const gross = b.grossProfit[column];
    const opex = b.cac[column] + b.opexPeople[column] + b.opexSystems[column];
    const net = b.netOperatingMargin[column];

    check(
      `${TIER_LABELS[tier]} ${column}: fulfillment + gross profit = 100% of revenue`,
      near(fulfillment + gross, 100),
      `${fulfillment} + ${gross} = ${fulfillment + gross}`,
    );
    check(
      `${TIER_LABELS[tier]} ${column}: gross profit - OpEx = net margin`,
      near(gross - opex, net),
      `${gross} - ${opex} = ${(gross - opex).toFixed(1)}, report says ${net}`,
    );
  }
}

console.log("\nExceptional beats average in the right direction, every tier");
for (const tier of tiersInOrder().filter((t) => t !== "under-500k")) {
  const { benchmarks: b } = getHvacBenchmarks(tier);
  check(`${TIER_LABELS[tier]}: exceptional keeps more`, b.netOperatingMargin.exceptional > b.netOperatingMargin.average);
  check(`${TIER_LABELS[tier]}: exceptional spends less on COGS`, b.fulfillmentCogs.exceptional < b.fulfillmentCogs.average);
  check(`${TIER_LABELS[tier]}: exceptional spends less on acquisition`, b.cac.exceptional < b.cac.average);
}

console.log("\nScoring a shop");
{
  const set = getHvacBenchmarks("500k-2mm");

  // A shop sitting exactly on the exceptional column.
  const onTheNumber = scoreHvac(
    {
      fulfillmentCogs: 19.5,
      fulfillmentServices: 23.5,
      grossProfit: 57,
      cac: 8.5,
      opexPeople: 7,
      opexSystems: 14.5,
      netOperatingMargin: 27,
    },
    set,
  );
  check("every category reads 'ahead' when it's exactly on target", onTheNumber.every((s) => s.status === "ahead"));

  // A shop with a pricing problem: materials heavy, margin thin.
  const leaky = scoreHvac(
    { fulfillmentCogs: 31, grossProfit: 41, netOperatingMargin: 4, cac: 8.0 },
    set,
  );
  const cogs = leaky.find((s) => s.category === "fulfillmentCogs")!;
  const net = leaky.find((s) => s.category === "netOperatingMargin")!;
  const cac = leaky.find((s) => s.category === "cac")!;
  const opexPeople = leaky.find((s) => s.category === "opexPeople")!;

  check("a cost line above target is 'behind'", cogs.status === "behind");
  check("a cost line above target has a negative gap", cogs.gap !== null && cogs.gap < 0);
  check("11.5 points of COGS over target is measured exactly", near(cogs.gap!, -11.5));
  check("the COGS reading talks about pricing", cogs.interpretation.toLowerCase().includes("pricing"));
  check("a thin margin is 'behind'", net.status === "behind");
  check("the margin reading says being busier won't fix it", net.interpretation.includes("busier"));
  check("beating a cost benchmark reads 'ahead'", cac.status === "ahead");
  check("a missing category is 'unknown', not zero", opexPeople.status === "unknown" && opexPeople.actual === null);
  check("an unknown category carries no interpretation", opexPeople.interpretation === "");

  // Within tolerance: 1.5 points short of the exceptional margin is on-track, not behind.
  const close = scoreHvac({ netOperatingMargin: 25.5 }, set);
  check("1.5 points short is 'on-track'", close.find((s) => s.category === "netOperatingMargin")!.status === "on-track");

  const notClose = scoreHvac({ netOperatingMargin: 24.5 }, set);
  check("2.5 points short is 'behind'", notClose.find((s) => s.category === "netOperatingMargin")!.status === "behind");

  check("every category is returned, in a stable order", onTheNumber.length === 7 && onTheNumber[0].category === "fulfillmentCogs");
}

console.log("\nConverting metrics to percentages of revenue");
{
  // A $1.2M shop sitting exactly on the $500K-$2M exceptional column, in dollars:
  //   COGS 19.5% = 234,000   Services 23.5% = 282,000   Gross profit 57% = 684,000
  //   CAC 8.5% = 102,000     People 7% = 84,000         Systems 14.5% = 174,000
  //   Net 27% = 324,000
  const card = scoreMetrics(
    {
      revenue: 1_200_000,
      fulfillmentCogs: 234_000,
      fulfillmentServices: 282_000,
      grossProfit: 684_000,
      cac: 102_000,
      opexPeople: 84_000,
      opexSystems: 174_000,
      operationalNetProfit: 324_000,
    },
    12,
  );

  check("tiers on revenue, not gross profit", card.tier === "500k-2mm");
  check("reports the annualised revenue it tiered on", card.annualRevenue === 1_200_000);

  const byCategory = Object.fromEntries(card.scores.map((s) => [s.category, s]));
  check("COGS is a percentage of revenue, not of gross profit", near(byCategory.fulfillmentCogs.actual!, 19.5));
  check("gross profit converts to 57% of revenue", near(byCategory.grossProfit.actual!, 57));
  check("net margin converts to 27% of revenue", near(byCategory.netOperatingMargin.actual!, 27));
  check("a shop on the exceptional column scores 'ahead' everywhere", card.scores.every((s) => s.status === "ahead"));

  // The bug this guards against: 234,000 is 34.2% of gross profit but 19.5% of revenue. If the
  // adapter ever passes percent-of-gross-profit through, this check fails loudly.
  check("percent-of-gross-profit would have read 34.2, and does not", !near(byCategory.fulfillmentCogs.actual!, 34.2, 0.2));

  const sixMonths = scoreMetrics(
    {
      revenue: 600_000,
      fulfillmentCogs: 117_000,
      fulfillmentServices: 141_000,
      grossProfit: 342_000,
      cac: 51_000,
      opexPeople: 42_000,
      opexSystems: 87_000,
      operationalNetProfit: 162_000,
    },
    6,
  );
  check("six months of $600K annualises into the same $1.2M tier", sixMonths.tier === "500k-2mm");
  check("percentages don't shift with the period length", near(sixMonths.scores[0].actual!, 19.5));

  const tiny = scoreMetrics(
    {
      revenue: 300_000,
      fulfillmentCogs: 120_000,
      fulfillmentServices: 90_000,
      grossProfit: 90_000,
      cac: 30_000,
      opexPeople: 15_000,
      opexSystems: 30_000,
      operationalNetProfit: 15_000,
    },
    12,
  );
  check("a $300K shop is tiered under-500k", tiny.tier === "under-500k");
  check("and is told which column it borrowed", tiny.borrowedTierLabel === "$500K–$2M");
  check("its 5% margin reads 'behind'", tiny.scores.find((s) => s.category === "netOperatingMargin")!.status === "behind");

  const empty = scoreMetrics(
    { revenue: 0, fulfillmentCogs: 0, fulfillmentServices: 0, grossProfit: 0, cac: 0, opexPeople: 0, opexSystems: 0, operationalNetProfit: 0 },
    12,
  );
  check("zero revenue gives 'unknown', never a divide by zero", empty.scores.every((s) => s.status === "unknown"));
  check("zero revenue reports no annual revenue", empty.annualRevenue === null);
}


console.log(`\nPASS: ${pass}   FAIL: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
