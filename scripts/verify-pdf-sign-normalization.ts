#!/usr/bin/env tsx
import { normalizePdfAmountForCategory } from "../server/lib/pdf-parser";
import type { ClearpathCategory } from "../shared/schema";

let failures = 0;

function check(name: string, actual: number, expected: number) {
  const ok = Math.abs(actual - expected) < 0.005;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) failures++;
}

function expense(category: ClearpathCategory, amount: number) {
  return normalizePdfAmountForCategory(amount, category);
}

console.log("\n-- PDF sign normalization --");
check("revenue stored positive when Gemini returns positive", expense("revenue", 108602.75), 108602.75);
check("revenue stored positive when Gemini returns negative", expense("revenue", -108602.75), 108602.75);

check("Advertising - web ads stays an expense", expense("cac", -701.53), -701.53);
check("Referral fees is normalized to the same expense sign", expense("cac", 2700), -2700);
check("mixed-sign CAC source rows sum as expense storage", expense("cac", -701.53) + expense("cac", 2700), -3401.53);

check("OpEx positive model output stores as expense", expense("opex_systems", 20.33), -20.33);
check("Tax strategy positive model output stores as expense", expense("tax_strategy", 18000), -18000);

if (failures > 0) {
  console.error(`\n${failures} PDF sign normalization check(s) failed`);
  process.exit(1);
}

console.log("\nALL CHECKS PASSED");
