-- Paid access gating (project 2143): who may sign in, and until when.
--
-- Adds `access_grants`. GoHighLevel writes a row when someone buys (see
-- server/access-webhook.ts); the app checks for an active row at sign-in and on every
-- authenticated request, but ONLY while ACCESS_GATE_ENABLED is on. With it off, nothing
-- reads this table.
--
-- Purely additive: one new table, and rows written only to it. The currently deployed code
-- never touches `access_grants`, so this can run BEFORE the matching deploy, with no broken
-- window (unlike Phase 2 / 2.5, which changed columns the old code read).
--
-- Every existing user gets a permanent `legacy` grant here, so turning the gate on later
-- locks out nobody already using the app. If that should not be permanent, it is an
-- `expires_at` update, not a code change.
--
-- Run via scripts/apply-migration.mjs (dry run first). Idempotent: re-running it creates
-- nothing new, because the table is created IF NOT EXISTS and legacy grants are only
-- inserted for users who have no legacy grant yet.

BEGIN;

CREATE TABLE IF NOT EXISTS access_grants (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased and trimmed, the same normalisation server/auth.ts applies to sign-in.
  email text NOT NULL,
  -- Where the grant came from: 'ghl:<offer>', 'legacy', or 'manual'.
  source text NOT NULL,
  -- The purchase's id in the source system. Makes the webhook idempotent per purchase,
  -- and lets a refund revoke exactly the grant that purchase created.
  external_ref text,
  starts_at timestamp NOT NULL DEFAULT now(),
  -- NULL means no expiry.
  expires_at timestamp,
  -- Set on refund. A revoked grant never counts, whatever its dates say.
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_grants_email_idx ON access_grants (email);

CREATE UNIQUE INDEX IF NOT EXISTS access_grants_source_ref_idx
  ON access_grants (source, external_ref)
  WHERE external_ref IS NOT NULL;

INSERT INTO access_grants (email, source)
SELECT lower(trim(u.email)), 'legacy'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM access_grants g
  WHERE g.email = lower(trim(u.email)) AND g.source = 'legacy'
);

COMMIT;
