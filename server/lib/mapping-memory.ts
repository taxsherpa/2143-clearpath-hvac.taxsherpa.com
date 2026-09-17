import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { rules } from "@shared/schema";
import type { ClearpathCategory, ConfidenceLevel, MappingStatus } from "@shared/schema";

/**
 * Mapping memory: the system remembers how this user categorised a P&L line last time, and
 * pre-fills the same choice on the next upload.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every month's P&L is largely the same chart of accounts as the month before. Without memory
 * the user re-decides the same forty lines every time, and the auto-mapping heuristics — which
 * are keyword guesses — get a fresh chance to be wrong in the same way. A user's own previous
 * decision is far better evidence than any keyword list, because it encodes what the business
 * actually does.
 *
 * The `rules` table shipped with the original build but was never connected: rows were written
 * behind a `createRule` flag the client never sent, and nothing read them back. This module is
 * the missing half.
 *
 * WHAT GETS REMEMBERED
 * --------------------
 * Only choices the *user* made — `POST /api/nodes/:id/map` is user-driven, so recording there
 * captures decisions and never enshrines the heuristics' own guesses as if they were decisions.
 *
 * Two rules per choice: one keyed on the full `sourcePath`, one on the bare `label`.
 *
 * WHY THE LABEL KEY DOES THE REAL WORK
 * ------------------------------------
 * The first version trusted an exact path match and flagged every label-only match as unsure,
 * on the theory that a label match meant the statement had been restructured. Measured against
 * two real consecutive months of the same client, that theory was wrong in a way that made the
 * feature nearly useless: **only 8 of 49 paths matched, and memory filled in 2 lines out of 47.**
 *
 * The cause is upstream. `sourcePath` is built from the `level` each line is assigned, and for
 * PDF uploads those levels come from a vision model reading a rendered page — which assigns
 * them differently between two renderings of the same statement. December filed
 * "Bank fees & charges" at level 2 beneath an invented "General & Admin" parent; January filed
 * it at level 1 directly under Expenses. Of 34 labels present in both months, 23 had a
 * different path. Path equality is simply not a stable key across PDF uploads.
 *
 * What *is* stable is the account name, and the same data shows why trusting it is safe: within
 * a single statement there were **no duplicate leaf labels at all**. A chart of accounts does
 * not name two different lines the same thing. So a label match is trusted whenever the name is
 * unambiguous — it occurs once in the incoming statement and one rule matches it — and flagged
 * only when it genuinely isn't.
 *
 * Path is still checked first. When it hits, it is the strongest possible evidence; it just
 * cannot be relied on to hit.
 *
 * SCOPE
 * -----
 * By `userId` alone. The tool's audience is a business owner with one business, for whom
 * account-level and business-level are identical. Per-business scoping is a logged follow-up
 * for the advisory case — one login covering several companies — and the migration path is a
 * nullable `client_id` where NULL keeps today's account-wide behaviour.
 */

export interface RememberedChoice {
  category: ClearpathCategory;
  status: MappingStatus;
  confidence: ConfidenceLevel;
  ruleId: string;
  /** How the memory matched — surfaced in the UI so the user can see why a line was pre-filled. */
  matchedOn: "path" | "label";
  /** True when the label appeared more than once, so the match could not be trusted outright. */
  ambiguous?: boolean;
}

/** Path rules outrank label rules when both match. */
const PRIORITY_PATH = 100;
const PRIORITY_LABEL = 50;

/**
 * Record a user's mapping decision so the next upload can reuse it.
 *
 * Upserts rather than inserts: re-mapping the same line replaces the earlier choice instead of
 * stacking a second rule beside it, so the most recent decision is always the one that counts.
 * Never throws into the caller's path — a failure to remember must not fail the mapping itself.
 */
export async function recordMappingChoice(params: {
  userId: string;
  label: string;
  sourcePath: string;
  category: ClearpathCategory;
  status: MappingStatus;
}): Promise<void> {
  const { userId, label, sourcePath, category, status } = params;

  const entries: { scope: "category_path" | "category_label"; value: string; priority: number }[] = [];
  if (sourcePath) entries.push({ scope: "category_path", value: sourcePath, priority: PRIORITY_PATH });
  if (label) entries.push({ scope: "category_label", value: label, priority: PRIORITY_LABEL });

  for (const entry of entries) {
    try {
      await db
        .insert(rules)
        .values({
          userId,
          scope: entry.scope,
          scopeValue: entry.value,
          clearpathCategory: category,
          status,
          priority: entry.priority,
        })
        .onConflictDoUpdate({
          target: [rules.userId, rules.scope, rules.scopeValue],
          set: {
            clearpathCategory: category,
            status,
            updatedAt: new Date(),
          },
        });
    } catch (error) {
      // Remembering is a convenience. If it fails, the mapping the user just made still stands.
      console.error("Failed to record mapping choice:", error);
    }
  }
}

/**
 * Look up remembered choices for a set of freshly parsed lines.
 *
 * Returns a map keyed by `sourcePath` (unique within an upload). One query for paths and one
 * for labels, rather than a query per line.
 */
export async function lookupRemembered(
  userId: string,
  lines: { label: string; sourcePath: string }[],
): Promise<Map<string, RememberedChoice>> {
  const result = new Map<string, RememberedChoice>();
  if (lines.length === 0) return result;

  const paths = Array.from(new Set(lines.map(l => l.sourcePath).filter(Boolean)));
  const labels = Array.from(new Set(lines.map(l => l.label).filter(Boolean)));

  try {
    const [pathRules, labelRules] = await Promise.all([
      paths.length
        ? db.select().from(rules).where(
            and(eq(rules.userId, userId), eq(rules.scope, "category_path"), inArray(rules.scopeValue, paths)))
        : Promise.resolve([]),
      labels.length
        ? db.select().from(rules).where(
            and(eq(rules.userId, userId), eq(rules.scope, "category_label"), inArray(rules.scopeValue, labels)))
        : Promise.resolve([]),
    ]);

    const byPath = new Map(pathRules.map(r => [r.scopeValue, r]));
    const byLabel = new Map(labelRules.map(r => [r.scopeValue, r]));

    // How many lines in THIS statement carry each name. A name used once is unambiguous
    // evidence; a name used twice is not, and gets flagged rather than guessed at.
    const labelOccurrences = new Map<string, number>();
    for (const line of lines) {
      labelOccurrences.set(line.label, (labelOccurrences.get(line.label) ?? 0) + 1);
    }

    for (const line of lines) {
      // Exact path wins: same line, same place, so the previous decision applies directly and
      // does not need re-checking.
      const pathRule = byPath.get(line.sourcePath);
      if (pathRule) {
        result.set(line.sourcePath, {
          category: pathRule.clearpathCategory,
          status: pathRule.status,
          // An exclusion is always surfaced for confirmation, however it matched: a line
          // silently leaving the totals is the one outcome worth making the user look at.
          confidence: pathRule.status === "excluded" ? "needs_review" : "high",
          ruleId: pathRule.id,
          matchedOn: "path",
        });
        continue;
      }

      // Fall back to the account name. For PDF uploads this is the common case, not the
      // exception, because the model's level assignment shifts between renderings and takes
      // the path with it.
      const labelRule = byLabel.get(line.label);
      if (labelRule) {
        // Trust it when the name is unambiguous: one line by that name in this statement, so
        // there is no question which line the earlier decision was about. A chart of accounts
        // does not name two different lines the same thing, and the real data bears that out.
        const ambiguous = (labelOccurrences.get(line.label) ?? 0) > 1;
        result.set(line.sourcePath, {
          category: labelRule.clearpathCategory,
          status: labelRule.status,
          // Exclusions are always surfaced regardless of how confidently they matched.
          confidence:
            labelRule.status === "excluded" || ambiguous ? "needs_review" : "high",
          ruleId: labelRule.id,
          matchedOn: "label",
          ambiguous,
        });
      }
    }

    // Traceability: record that these memories actually fired, and when.
    const firedIds = Array.from(new Set(Array.from(result.values()).map(c => c.ruleId)));
    if (firedIds.length > 0) {
      await db
        .update(rules)
        .set({ timesApplied: sql`${rules.timesApplied} + 1`, lastAppliedAt: new Date() })
        .where(inArray(rules.id, firedIds));
    }
  } catch (error) {
    // A lookup failure degrades to the keyword heuristics, which is how the app behaved before
    // memory existed. Never fail an upload over it.
    console.error("Failed to look up remembered mappings:", error);
    return new Map();
  }

  return result;
}
