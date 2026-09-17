-- Phase 2.5 (project 2143): period-aware intake and tiering.
--
-- Adds `periods` (one row per statement period within an upload) and
-- `pl_node_period_amounts` (one row per P&L line per period), and retires
-- `pl_nodes.amount_cents` as a source of truth now that amounts are period-specific.
--
-- SAFETY RAIL: this is a hand-authored, data-preserving migration, not a clean replacement.
-- Re-checked production row counts immediately before writing this (2026-09-06):
-- 1 user, 2 uploads, 135 pl_nodes, 88 category_mappings, 141 rules, 0 reports. Every existing
-- upload becomes exactly one `month` period (monthsCovered = 1, confirmed = true, since it was
-- already a real, already-reviewed month), and every existing pl_nodes.amount_cents value moves
-- to one pl_node_period_amounts row against that period. Nothing is dropped except the now-
-- redundant amount_cents column, whose values are migrated first, in the same transaction.
--
-- Run via scripts/apply-phase2.5-migration.mjs, which wraps this with a before/after row-count
-- check (mirrors scripts/apply-phase2-migration.mjs). Rehearse first with
-- scripts/verify-phase2.5-migration.mjs.

BEGIN;

CREATE TYPE period_type AS ENUM ('month', 'quarter', 'year_to_date', 'annual', 'custom', 'unknown');

CREATE TABLE periods (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id varchar NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  period_start timestamp NOT NULL,
  period_end timestamp NOT NULL,
  period_type period_type NOT NULL DEFAULT 'month',
  months_covered integer NOT NULL DEFAULT 1,
  label text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  confirmed boolean NOT NULL DEFAULT true
);

CREATE TABLE pl_node_period_amounts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id varchar NOT NULL REFERENCES pl_nodes(id) ON DELETE CASCADE,
  period_id varchar NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL
);
CREATE UNIQUE INDEX pl_node_period_amounts_node_period_idx ON pl_node_period_amounts(node_id, period_id);

-- One period per existing upload, derived from month_start. Every upload that exists today was
-- a single monthly statement (the only shape the app supported before this migration), so
-- period_type = 'month', months_covered = 1, and period_end is the last day of that month.
-- confirmed = true: these are already-reviewed, already-reported real uploads, not a fresh
-- ambiguous parse that should force a confirmation dialog on next view.
INSERT INTO periods (upload_id, period_start, period_end, period_type, months_covered, label, display_order, confirmed)
SELECT
  id,
  month_start,
  (date_trunc('month', month_start) + interval '1 month' - interval '1 day')::timestamp,
  'month',
  1,
  to_char(month_start, 'FMMonth YYYY'),
  0,
  true
FROM uploads;

-- Move every existing per-node amount into its upload's one new period. Rollup rows and any
-- node with no amount at all leave nothing here, matching the Phase 2 rule that rollups don't
-- count toward totals.
INSERT INTO pl_node_period_amounts (node_id, period_id, amount_cents)
SELECT n.id, p.id, n.amount_cents
FROM pl_nodes n
JOIN periods p ON p.upload_id = n.upload_id
WHERE n.amount_cents IS NOT NULL;

ALTER TABLE pl_nodes DROP COLUMN amount_cents;

COMMIT;
