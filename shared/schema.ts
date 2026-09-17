import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, pgEnum, uniqueIndex, index, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

// Magic-link sign-in. Only the SHA-256 hash of the token is stored, so a database
// read can never be replayed as a login. Single-use: `consumedAt` is stamped on
// the first successful verification and the row is never reusable after that.
export const loginTokens = pgTable("login_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  requestedIp: text("requested_ip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Paid access: who may sign in, and until when (migrations/2143-access-grants.sql).
// Keyed by email rather than user id because a purchase arrives before the account exists —
// accounts are only created on the first magic-link click. Only consulted while
// ACCESS_GATE_ENABLED is on; see server/lib/access.ts.
export const accessGrants = pgTable("access_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  source: text("source").notNull(),
  externalRef: text("external_ref"),
  startsAt: timestamp("starts_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  emailIdx: index("access_grants_email_idx").on(table.email),
  sourceRefIdx: uniqueIndex("access_grants_source_ref_idx")
    .on(table.source, table.externalRef)
    .where(sql`external_ref IS NOT NULL`),
}));

export const uploadStatusEnum = pgEnum("upload_status", ["parsed", "mapped", "exported", "deleted"]);
export const confidenceEnum = pgEnum("confidence_level", ["high", "medium", "needs_review"]);
export const categoryEnum = pgEnum("clearpath_category", ["revenue", "fulfillment_cogs", "fulfillment_services", "cac", "opex_systems", "opex_people", "tax_strategy"]);
// A mapping is either counted or deliberately taken out of the report. "Excluded" is a
// third state on purpose, distinct from having no mapping at all: an unmapped line means
// "this still needs your attention", so reusing it for an intentional exclusion would turn
// every deliberate choice into a permanent warning. The category is kept on an excluded row
// so putting the line back is a one-field change and the user's original judgement survives.
export const mappingStatusEnum = pgEnum("mapping_status", ["mapped", "excluded"]);
export const ruleScopeEnum = pgEnum("rule_scope", ["category_label", "category_path", "category_regex"]);

// Phase 2.5 — what kind of statement period a P&L (or one column of it) covers. Drives
// annualization: `annualizedGrossProfit = grossProfit / monthsCovered * 12`, which is a no-op
// for a true annual statement (monthsCovered = 12) instead of the old blind `* 12`.
export const periodTypeEnum = pgEnum("period_type", ["month", "quarter", "year_to_date", "annual", "custom", "unknown"]);

export const uploads = pgTable("uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originalFilename: text("original_filename").notNull(),
  // Display-only alias, kept for backward compatibility (upload list sorting, any surface not
  // yet updated to read `periods`). It is synced to the upload's FIRST period's `periodStart`
  // whenever periods are written — never a second source of truth. New code should read
  // `periods` directly; do not let this column disagree with it.
  monthStart: timestamp("month_start").notNull(),
  status: uploadStatusEnum("status").notNull().default("parsed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * One row per period *within* an upload. A single-column monthly CSV or a single-period PDF
 * produces exactly one row here; a `Account, Jan 2026, Feb 2026, Mar 2026` CSV produces three,
 * sharing the same `pl_nodes`/`category_mappings` (mapping is a property of the account, not of
 * the period — see Phase 2.5 scope decision 1). `displayOrder` is chronological, so the period
 * switcher and comparisons don't have to re-derive it from dates.
 *
 * `confirmed` is false when the parser could not classify the period type with confidence and
 * the upload flow is forcing the user to confirm it (build requirement #2) — an unconfirmed
 * period must not silently feed the YTD-history tiering precedence in `rollups.ts`.
 */
export const periods = pgTable("periods", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadId: varchar("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  periodType: periodTypeEnum("period_type").notNull().default("month"),
  monthsCovered: integer("months_covered").notNull().default(1),
  label: text("label").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  confirmed: boolean("confirmed").notNull().default(true),
});

export const plNodes = pgTable("pl_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadId: varchar("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
  parentId: varchar("parent_id"),
  label: text("label").notNull(),
  level: integer("level").notNull(),
  displayOrder: integer("display_order").notNull(),
  isRollup: integer("is_rollup").notNull().default(0),
  sourcePath: text("source_path").notNull(),
  // amountCents lived here through Phase 2. Phase 2.5 moves it to `pl_node_period_amounts`
  // (one row per node per period) because a node is now shared across every period in its
  // upload — a single amount column on the node itself cannot represent a 3-column CSV. Do not
  // add it back: two amount fields that can silently disagree is exactly the bug class this
  // migration exists to close off.
});

/** One amount per P&L line per period. The node and its category mapping are shared across
 * every period in the same upload; only the amount is period-specific. */
export const plNodePeriodAmounts = pgTable("pl_node_period_amounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeId: varchar("node_id").notNull().references(() => plNodes.id, { onDelete: "cascade" }),
  periodId: varchar("period_id").notNull().references(() => periods.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
}, (table) => [
  uniqueIndex("pl_node_period_amounts_node_period_idx").on(table.nodeId, table.periodId),
]);

export const categoryMappings = pgTable("category_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeId: varchar("node_id").notNull().references(() => plNodes.id, { onDelete: "cascade" }),
  clearpathCategory: categoryEnum("clearpath_category").notNull(),
  confidence: confidenceEnum("confidence").notNull().default("needs_review"),
  status: mappingStatusEnum("status").notNull().default("mapped"),
  // Optional and never required. Excluding a line must stay a one-click action; asking a lay
  // user to justify it would add a decision without changing the outcome.
  excludedReason: text("excluded_reason"),
  ruleId: varchar("rule_id").references(() => rules.id, { onDelete: "set null" }),
});

/**
 * Remembered mapping choices — the system's memory of how this user has categorised a given
 * P&L line before.
 *
 * The table shipped with the original build but was never wired up: rows were written behind a
 * flag the client never sent, and nothing ever read them. It is now the mapping-memory store.
 *
 * Scoped by `userId` and nothing else, deliberately: the tool's audience is a business owner
 * with one business, for whom account-level and business-level are the same thing. Scoping per
 * business is a logged follow-up for the advisory case (one login, several companies).
 *
 * Two rules are written per choice — one keyed on the full `sourcePath`, one on the bare
 * `label` — so a restructured P&L still matches on name when the path has moved. `priority`
 * separates them: path beats label.
 */
export const rules = pgTable("rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scope: ruleScopeEnum("scope").notNull(),
  scopeValue: text("scope_value").notNull(),
  clearpathCategory: categoryEnum("clearpath_category").notNull(),
  // An exclusion is a remembered choice too — "this line doesn't count" is as much a decision
  // as "this line is CAC", and the subtotal that double-counts recurs every month.
  status: mappingStatusEnum("status").notNull().default("mapped"),
  priority: integer("priority").notNull().default(50),
  // Traceability: how often this memory has actually been used, and when it last fired.
  timesApplied: integer("times_applied").notNull().default(0),
  lastAppliedAt: timestamp("last_applied_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // One rule per user per key. Re-mapping the same line overwrites the old choice rather than
  // stacking a second rule beside it — the most recent decision is the one that counts.
  uniqueIndex("rules_user_scope_value_idx").on(table.userId, table.scope, table.scopeValue),
]);

export const reports = pgTable("reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadId: varchar("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
  rollupJson: jsonb("rollup_json").notNull(),
  benchmarksJson: jsonb("benchmarks_json").notNull(),
  pdfPath: text("pdf_path"),
  csvPath: text("csv_path"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
});

export const insertLoginTokenSchema = createInsertSchema(loginTokens).omit({
  id: true,
  createdAt: true,
});

export const insertUploadSchema = createInsertSchema(uploads).omit({
  id: true,
  createdAt: true,
});

export const insertPlNodeSchema = createInsertSchema(plNodes).omit({
  id: true,
});

export const insertPeriodSchema = createInsertSchema(periods).omit({
  id: true,
});

export const insertPlNodePeriodAmountSchema = createInsertSchema(plNodePeriodAmounts).omit({
  id: true,
});

export const insertCategoryMappingSchema = createInsertSchema(categoryMappings).omit({
  id: true,
});

export const insertRuleSchema = createInsertSchema(rules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertLoginToken = z.infer<typeof insertLoginTokenSchema>;
export type LoginToken = typeof loginTokens.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploads.$inferSelect;
export type InsertPlNode = z.infer<typeof insertPlNodeSchema>;
export type PlNode = typeof plNodes.$inferSelect;
export type InsertPeriod = z.infer<typeof insertPeriodSchema>;
export type Period = typeof periods.$inferSelect;
export type InsertPlNodePeriodAmount = z.infer<typeof insertPlNodePeriodAmountSchema>;
export type PlNodePeriodAmount = typeof plNodePeriodAmounts.$inferSelect;
export type InsertCategoryMapping = z.infer<typeof insertCategoryMappingSchema>;
export type CategoryMapping = typeof categoryMappings.$inferSelect;
export type InsertRule = z.infer<typeof insertRuleSchema>;
export type Rule = typeof rules.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;

export type ClearpathCategory = "revenue" | "fulfillment_cogs" | "fulfillment_services" | "cac" | "opex_systems" | "opex_people" | "tax_strategy";
export type MappingStatus = "mapped" | "excluded";
export type ConfidenceLevel = "high" | "medium" | "needs_review";
export type UploadStatus = "parsed" | "mapped" | "exported" | "deleted";
export type PeriodType = "month" | "quarter" | "year_to_date" | "annual" | "custom" | "unknown";
