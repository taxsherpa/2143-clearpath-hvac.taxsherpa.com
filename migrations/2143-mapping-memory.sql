-- Mapping memory (project 2143): make the `rules` table actually work.
--
-- The table shipped with the original build but was inert — rows were written behind a
-- `createRule` flag the client never sent, and nothing ever read them back. It is now the store
-- for "how did this user categorise this line last month", so an upload pre-fills from the
-- user's own earlier decisions instead of re-asking every month.
--
-- Purely additive: three new columns and a unique index. No existing row changes meaning, and
-- the table is empty in production anyway (no rule was ever created).
--
-- Run BEFORE deploying the code that reads these columns. Wrapped in a transaction.

BEGIN;

-- An exclusion is a remembered decision too. "This line doesn't count" recurs every month when
-- a QuickBooks subtotal is the cause, so it has to be storable alongside a category.
-- `mapping_status` already exists from the Phase 2 migration.
ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS status mapping_status NOT NULL DEFAULT 'mapped';

-- Traceability: how often a remembered choice has actually fired, and when it last did.
ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS times_applied integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_applied_at timestamp;

-- One rule per user per key, so re-mapping a line REPLACES the earlier choice rather than
-- stacking a second rule beside it. Without this the upsert has no conflict target and the
-- most recent decision would not reliably win.
--
-- Safe to build: the table is empty. If it were not, a duplicate would block the index and
-- would need resolving by hand first — deliberately, since silently dropping one of two
-- conflicting decisions is exactly the behaviour this index exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS rules_user_scope_value_idx
  ON rules (user_id, scope, scope_value);

COMMIT;

-- Verification (run after committing):
--   \d rules
--     -> status, times_applied, last_applied_at present;
--        rules_user_scope_value_idx listed as UNIQUE on (user_id, scope, scope_value)
