import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { accessGrants, type AccessGrant } from "@shared/schema";

/**
 * Paid access gating.
 *
 * Access is a property of an EMAIL, not of an account: a purchase arrives from GoHighLevel
 * before the buyer has ever signed in, and accounts are only created on the first magic-link
 * click. An email has access when at least one of its grants has started, has not expired,
 * and has not been revoked.
 *
 * Everything here is dormant unless ACCESS_GATE_ENABLED is "true". With it off, callers skip
 * the checks entirely and the app behaves exactly as it did before gating existed — which is
 * what lets this ship to production ahead of the decision to turn it on.
 */

/** Read on every call rather than once at boot, so a test can flip it. */
export function isAccessGateEnabled(): boolean {
  return process.env.ACCESS_GATE_ENABLED === "true";
}

/** Where the "you don't have access" email and page send people to buy. */
export function purchaseUrl(): string | null {
  return process.env.ACCESS_PURCHASE_URL || null;
}

/**
 * The one normalisation every email goes through, shared with sign-in. A grant written as
 * "Jane@Example.com " must match a sign-in typed as "jane@example.com".
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  // Deliberately permissive — Resend is the real deliverability check.
  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

export type AccessStatus =
  | { active: true }
  | {
      active: false;
      /** Latest expiry among unrevoked grants that have ended, if there were any. */
      endedAt: Date | null;
      /** Earliest start among unrevoked grants that have not begun yet, if any. */
      startsAt: Date | null;
    };

export function evaluateGrants(grants: Pick<AccessGrant, "startsAt" | "expiresAt" | "revokedAt">[], now: Date): AccessStatus {
  let endedAt: Date | null = null;
  let startsAt: Date | null = null;

  for (const grant of grants) {
    if (grant.revokedAt) continue;

    const started = grant.startsAt.getTime() <= now.getTime();
    const unexpired = grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime();

    if (started && unexpired) return { active: true };

    if (!started && (startsAt === null || grant.startsAt < startsAt)) {
      startsAt = grant.startsAt;
    }
    if (started && grant.expiresAt && (endedAt === null || grant.expiresAt > endedAt)) {
      endedAt = grant.expiresAt;
    }
  }

  return { active: false, endedAt, startsAt };
}

export async function getAccessStatus(email: string, now: Date = new Date()): Promise<AccessStatus> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { active: false, endedAt: null, startsAt: null };

  const grants = await db
    .select({
      startsAt: accessGrants.startsAt,
      expiresAt: accessGrants.expiresAt,
      revokedAt: accessGrants.revokedAt,
    })
    .from(accessGrants)
    .where(eq(accessGrants.email, normalized));

  return evaluateGrants(grants, now);
}

export interface GrantInput {
  email: string;
  source: string;
  externalRef: string | null;
  startsAt: Date;
  expiresAt: Date | null;
}

/**
 * Creates a grant, or — when the same purchase (`source` + `externalRef`) was already
 * recorded — updates its dates in place. A webhook GoHighLevel retries therefore never adds a
 * second row.
 *
 * Deliberately does NOT clear `revoked_at` on an existing row: a late retry of the original
 * purchase webhook must not undo a refund. Re-granting after a refund needs a new purchase
 * (a new externalRef) or a manual grant.
 *
 * Raw SQL rather than the query builder because the conflict target is a PARTIAL unique
 * index, and the ON CONFLICT clause has to repeat its predicate exactly to be matched.
 */
export async function upsertGrant(input: GrantInput): Promise<{ id: string; created: boolean; revoked: boolean }> {
  if (input.externalRef === null) {
    const { rows } = await pool.query(
      `INSERT INTO access_grants (email, source, starts_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.email, input.source, input.startsAt, input.expiresAt],
    );
    return { id: rows[0].id, created: true, revoked: false };
  }

  const { rows } = await pool.query(
    `INSERT INTO access_grants (email, source, external_ref, starts_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL
     DO UPDATE SET email = EXCLUDED.email,
                   starts_at = EXCLUDED.starts_at,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = now()
     RETURNING id, (xmax = 0) AS created, (revoked_at IS NOT NULL) AS revoked`,
    [input.email, input.source, input.externalRef, input.startsAt, input.expiresAt],
  );
  return { id: rows[0].id, created: rows[0].created, revoked: rows[0].revoked };
}

/**
 * Revokes the grant a purchase created. When no externalRef is known, revokes every active
 * grant that email holds from that source instead — never grants from other sources, so a
 * refund on one offer cannot take away access bought through another.
 */
export async function revokeGrants(opts: { source: string; externalRef: string | null; email: string | null }): Promise<number> {
  const byRef = opts.externalRef !== null;
  const key = byRef ? opts.externalRef : opts.email;
  if (key === null) return 0;

  const { rowCount } = await pool.query(
    `UPDATE access_grants
        SET revoked_at = now(), updated_at = now()
      WHERE source = $1
        AND ${byRef ? "external_ref" : "email"} = $2
        AND revoked_at IS NULL`,
    [opts.source, key],
  );
  return rowCount ?? 0;
}
