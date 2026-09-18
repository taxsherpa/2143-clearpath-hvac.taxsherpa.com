/**
 * Checks the HVAC account rules against the lines a real HVAC chart of accounts contains.
 *
 *   npx tsx scripts/verify-hvac-accounts.ts
 *
 * The vehicle checks are the ones that matter. Fuel and oil changes belong to Fulfillment
 * Services; truck leases, depreciation and auto liability belong to OpEx Systems. Swap them and a
 * shop with six trucks reads as having a labour problem when it has a fleet problem, and the
 * advice on screen points at the wrong fix.
 */
import { matchHvacAccount, detectOwnerCompInOpex } from "../server/lib/hvac-accounts";

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

function expect(label: string, expected: string, path = "") {
  const got = matchHvacAccount(label, path);
  check(`"${label}" → ${expected}`, got?.category === expected, got ? `got ${got.category}` : "no match");
}

function expectNoMatch(label: string, path = "") {
  const got = matchHvacAccount(label, path);
  check(`"${label}" falls through to the generic rules`, got === null, got ? `matched ${got.category}` : "");
}

console.log("\nThe vehicle split");
expect("Fuel", "fulfillment_services");
expect("Gasoline - service trucks", "fulfillment_services");
expect("Oil changes", "fulfillment_services");
expect("Truck maintenance", "fulfillment_services");
expect("Tires", "fulfillment_services");
expect("Truck lease", "opex_systems");
expect("Vehicle depreciation", "opex_systems");
expect("Commercial auto insurance", "opex_systems");
expect("Truck payment - Ford F250", "opex_systems");
// The trap inside the trap: a line naming both sides must land on the fixed side.
expect("Vehicle lease and maintenance", "opex_systems");
expect("Truck insurance and repair", "opex_systems");

console.log("\nEquipment and materials");
expect("Condenser units", "fulfillment_cogs");
expect("RTU purchases", "fulfillment_cogs");
expect("Refrigerant", "fulfillment_cogs");
expect("Line sets", "fulfillment_cogs");
expect("Sheet metal and ductwork", "fulfillment_cogs");
expect("Job materials", "fulfillment_cogs");
expect("Supply house - Ferguson", "fulfillment_cogs");

console.log("\nDelivering the work");
expect("Technician wages", "fulfillment_services");
expect("Install labor", "fulfillment_services");
expect("Apprentice pay", "fulfillment_services");
expect("Subcontractor - crane", "fulfillment_services");
expect("Permits", "fulfillment_services");
expect("Inspection fees", "fulfillment_services");
expect("Dumpster rental", "fulfillment_services");
expect("Callback labor", "fulfillment_services");
expect("Workers comp insurance", "fulfillment_services");
expect("Tech commissions", "fulfillment_services");

console.log("\nWinning the work");
expect("Yelp advertising", "cac");
expect("Angi leads", "cac");
expect("Google Ads", "cac");
expect("Direct mail postcards", "cac");
expect("Truck wraps", "cac");
expect("Home show booth", "cac");

console.log("\nRunning the shop");
expect("Dispatcher wages", "opex_people");
expect("CSR salaries", "opex_people");
expect("Office manager salary", "opex_people");
expect("ServiceTitan subscription", "opex_systems");
expect("Shop rent", "opex_systems");
expect("General liability insurance", "opex_systems");
expect("Merchant fees", "opex_systems");

console.log("\nWhat these rules deliberately leave alone");
// Owner money must keep falling through to the generic rules, which push it below the operating
// line — where the report's benchmarks expect it.
expectNoMatch("Owner draw");
expectNoMatch("Owner's truck payment");
expectNoMatch("Shareholder distribution");
expectNoMatch("Member draw");
expectNoMatch("Sales revenue");
expectNoMatch("Interest expense");
expectNoMatch("Bank charges");

console.log("\nOwner pay hiding in operating expenses");
{
  const none = detectOwnerCompInOpex([
    { label: "Technician wages", category: "fulfillment_services", amount: 240_000 },
    { label: "Owner draw", category: "tax_strategy", amount: 90_000 },
  ]);
  check("owner pay already below the line is not flagged", none === null);

  const found = detectOwnerCompInOpex([
    { label: "Owner salary", category: "opex_people", amount: 85_000 },
    { label: "Officer comp", category: "opex_people", amount: 15_000 },
    { label: "Dispatcher wages", category: "opex_people", amount: 52_000 },
  ]);
  check("owner pay inside OpEx is found", found !== null);
  check("it totals every owner line", found?.amount === 100_000, `got ${found?.amount}`);
  check("it names the lines", found?.labels.length === 2);

  const negative = detectOwnerCompInOpex([
    { label: "Owner distribution", category: "opex_people", amount: -40_000 },
  ]);
  check("a negative amount still counts, as a magnitude", negative?.amount === 40_000);

  const zero = detectOwnerCompInOpex([
    { label: "Owner salary", category: "opex_people", amount: 0 },
  ]);
  check("a zero line is not a finding", zero === null);

  const unmapped = detectOwnerCompInOpex([
    { label: "Owner salary", category: null, amount: 85_000 },
  ]);
  check("an unmapped line is not a finding", unmapped === null);
}

console.log("\nLines a real upload got wrong (2026-09-18)");
// From the first live upload: an HVAC shop's "Contractors" line is the crew doing the billable
// work, and a bare "Wages" line is office payroll unless it says otherwise. Both had fallen
// through to OpEx Systems.
expect("Contractors", "fulfillment_services");
expect("Contract labor", "fulfillment_services");
expect("Wages", "opex_people");
expect("Salaries", "opex_people");
expect("Payroll taxes", "opex_people");
// The field-labour phrasings still win, because their rule runs first.
expect("Technician wages", "fulfillment_services");
expect("Install labor", "fulfillment_services");

console.log(`\nPASS: ${pass}   FAIL: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
