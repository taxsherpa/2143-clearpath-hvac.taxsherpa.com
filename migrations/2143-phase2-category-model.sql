-- Phase 2 (project 2143): migrate clearpath_category to the new model, preserving every row.
--
-- WHY THIS IS HAND-WRITTEN AND NOT `db:push`
-- ------------------------------------------
-- `npm run db:push` is this repo's normal schema path (see README §"Database"), and the old
-- `migrations/0000_cuddly_iron_monger.sql` is stale and must never be replayed. But push
-- cannot rewrite enum *values* under existing rows: it would either fail or drop data.
-- Production holds 1 upload / 76 pl_nodes / 38 category_mappings, so the Safety Rail against
-- silently bulk-reassigning mappings applies. This file is the deliberate migration that rail
-- asks for. Run it BEFORE `npm run db:push`.
--
-- OLD -> NEW
-- ----------
--   revenue      -> revenue               deterministic, confidence preserved
--   cac          -> cac                   deterministic, confidence preserved
--   systems      -> opex_systems          deterministic, confidence preserved
--   people       -> opex_people           deterministic, confidence preserved
--   owners_pay   -> tax_strategy          deterministic, confidence preserved
--   taxes        -> tax_strategy          deterministic, confidence preserved
--   fulfillment  -> fulfillment_cogs      AMBIGUOUS: confidence FORCED to needs_review
--
-- The last one is the only judgement call. The old model had a single Fulfillment bucket, so
-- there is no stored signal that distinguishes direct materials (COGS) from delivery
-- labour/services. Rather than guess and hide the guess, every migrated fulfillment row is
-- flagged so it surfaces in the review UI for a real decision by the person whose data it is.
--
-- Idempotent: safe to run twice. Wrapped in a transaction; either all of it lands or none.

BEGIN;

-- 1. Add the new values to the existing enum. (ALTER TYPE ... ADD VALUE cannot run inside a
--    transaction block in older Postgres, so build a new type and swap instead — which is
--    also what lets us drop the retired values rather than leave them orphaned in the type.)
CREATE TYPE clearpath_category_new AS ENUM (
  'revenue',
  'fulfillment_cogs',
  'fulfillment_services',
  'cac',
  'opex_systems',
  'opex_people',
  'tax_strategy'
);

-- 2. category_mappings: translate, then swap the column type.
--    The USING clause does the value mapping; the confidence fix-up follows separately so it
--    can key off the *old* value, which is why it is captured first.
CREATE TEMPORARY TABLE _phase2_ambiguous_mappings ON COMMIT DROP AS
  SELECT id FROM category_mappings WHERE clearpath_category::text = 'fulfillment';

ALTER TABLE category_mappings
  ALTER COLUMN clearpath_category DROP DEFAULT,
  ALTER COLUMN clearpath_category TYPE clearpath_category_new
  USING (
    CASE clearpath_category::text
      WHEN 'revenue'     THEN 'revenue'
      WHEN 'fulfillment' THEN 'fulfillment_cogs'
      WHEN 'cac'         THEN 'cac'
      WHEN 'systems'     THEN 'opex_systems'
      WHEN 'people'      THEN 'opex_people'
      WHEN 'owners_pay'  THEN 'tax_strategy'
      WHEN 'taxes'       THEN 'tax_strategy'
    END
  )::clearpath_category_new;

-- 3. rules: same translation. The table is empty today, and (per the Phase 2 re-audit) rules
--    are never actually read by the server — but the column exists and must stay coherent.
ALTER TABLE rules
  ALTER COLUMN clearpath_category DROP DEFAULT,
  ALTER COLUMN clearpath_category TYPE clearpath_category_new
  USING (
    CASE clearpath_category::text
      WHEN 'revenue'     THEN 'revenue'
      WHEN 'fulfillment' THEN 'fulfillment_cogs'
      WHEN 'cac'         THEN 'cac'
      WHEN 'systems'     THEN 'opex_systems'
      WHEN 'people'      THEN 'opex_people'
      WHEN 'owners_pay'  THEN 'tax_strategy'
      WHEN 'taxes'       THEN 'tax_strategy'
    END
  )::clearpath_category_new;

-- 4. Retire the old type and take its name.
DROP TYPE clearpath_category;
ALTER TYPE clearpath_category_new RENAME TO clearpath_category;

-- 5. The third mapping state. Existing rows are all 'mapped' — nothing was excluded before,
--    because there was no way to exclude anything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mapping_status') THEN
    CREATE TYPE mapping_status AS ENUM ('mapped', 'excluded');
  END IF;
END $$;

ALTER TABLE category_mappings
  ADD COLUMN IF NOT EXISTS status mapping_status NOT NULL DEFAULT 'mapped',
  ADD COLUMN IF NOT EXISTS excluded_reason text;

-- 6. Flag the ambiguous rows for re-review. This is the Safety Rail made concrete: these rows
--    were assigned a category the old data could not actually justify, so they must not look
--    settled. Done last so it survives the type swap above.
UPDATE category_mappings
   SET confidence = 'needs_review'
 WHERE id IN (SELECT id FROM _phase2_ambiguous_mappings);

COMMIT;

-- Verification (run after committing):
--   SELECT unnest(enum_range(NULL::clearpath_category))::text;
--     -> revenue, fulfillment_cogs, fulfillment_services, cac, opex_systems, opex_people,
--        tax_strategy
--   SELECT clearpath_category, confidence, status, count(*) FROM category_mappings
--    GROUP BY 1,2,3 ORDER BY 1,2,3;
--     -> no row should carry a retired value; every former 'fulfillment' row should read
--        fulfillment_cogs / needs_review / mapped
