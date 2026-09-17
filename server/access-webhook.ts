import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { normalizeEmail, revokeGrants, upsertGrant } from "./lib/access";

/**
 * POST /api/webhooks/ghl/access — GoHighLevel grants or revokes ClearPath access.
 *
 * Called from GHL workflows: the workshop purchase workflow grants, a refund workflow revokes.
 * Writing grants works whether or not ACCESS_GATE_ENABLED is on, so purchases made before the
 * gate is switched on are already recorded when it is.
 *
 * Auth is a shared secret in the `x-api-key` header — the same pattern Bookkeeping Buddy's
 * GHL webhook uses in production. With no secret configured the endpoint refuses everything:
 * an unconfigured deploy must never accept grants from anyone.
 */

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,99}$/i;
/** Sources the app writes itself. A webhook must not create or revoke these. */
const RESERVED_SOURCES = new Set(["legacy", "manual"]);
const MAX_DAYS = 3650;

type Payload = Record<string, unknown>;

/**
 * GHL's standard "Webhook" action posts the whole contact record top-level and puts the
 * fields configured in the action under `customData`; its "Custom Webhook" action posts only
 * what was configured, top-level. `customData` wins, because the standard action's top-level
 * body carries contact fields with colliding names — the contact's own `source`, for one —
 * that would otherwise be mistaken for ours.
 */
function field(body: Payload, name: string): unknown {
  const custom = body.customData;
  if (custom && typeof custom === "object" && name in (custom as Payload)) {
    return (custom as Payload)[name];
  }
  return body[name];
}

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseDate(value: unknown): Date | null | "invalid" {
  const raw = text(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function keyMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  // Hash both sides first so the comparison is constant-time AND length-independent —
  // timingSafeEqual throws on buffers of different lengths, which would leak the length.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerAccessWebhook(app: Express) {
  app.post("/api/webhooks/ghl/access", async (req: Request, res: Response) => {
    const secret = process.env.GHL_ACCESS_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(503).json({ error: "Access webhook is not configured." });
    }
    if (!keyMatches(req.get("x-api-key"), secret)) {
      return res.status(401).json({ error: "Invalid API key." });
    }

    const body: Payload = req.body && typeof req.body === "object" ? req.body : {};
    const action = text(field(body, "action"))?.toLowerCase() ?? "grant";
    const source = text(field(body, "source"));
    const externalRef = text(field(body, "external_ref"));
    const rawEmail = field(body, "email");
    const email = normalizeEmail(rawEmail);

    if (!source) {
      return res.status(400).json({ error: "Missing field: source." });
    }
    if (!SOURCE_PATTERN.test(source) || RESERVED_SOURCES.has(source.toLowerCase())) {
      return res.status(400).json({ error: `Invalid source: ${source}.` });
    }
    if (externalRef !== null && externalRef.length > 200) {
      return res.status(400).json({ error: "external_ref is too long (200 characters max)." });
    }
    if (text(rawEmail) !== null && !email) {
      return res.status(400).json({ error: "Invalid field: email." });
    }

    try {
      if (action === "revoke") {
        if (externalRef === null && email === null) {
          return res.status(400).json({ error: "Revoke needs external_ref or email." });
        }
        const revoked = await revokeGrants({ source, externalRef, email });
        return res.json({ ok: true, action: "revoke", revoked });
      }

      if (action !== "grant") {
        return res.status(400).json({ error: `Unknown action: ${action}. Use grant or revoke.` });
      }

      if (!email) {
        return res.status(400).json({ error: "Missing field: email." });
      }

      const startsAt = parseDate(field(body, "starts_at"));
      const expiresAtInput = parseDate(field(body, "expires_at"));
      const daysRaw = text(field(body, "days"));

      if (startsAt === "invalid") {
        return res.status(400).json({ error: "Invalid field: starts_at (use YYYY-MM-DD or an ISO timestamp)." });
      }
      if (expiresAtInput === "invalid") {
        return res.status(400).json({ error: "Invalid field: expires_at (use YYYY-MM-DD or an ISO timestamp)." });
      }
      if (expiresAtInput !== null && daysRaw !== null) {
        return res.status(400).json({ error: "Send expires_at or days, not both." });
      }

      const start = startsAt ?? new Date();
      let expiresAt: Date;
      if (expiresAtInput !== null) {
        expiresAt = expiresAtInput;
      } else if (daysRaw !== null) {
        const days = Number(daysRaw);
        if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
          return res.status(400).json({ error: `Invalid field: days (a whole number from 1 to ${MAX_DAYS}).` });
        }
        expiresAt = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
      } else {
        // Webhook grants always end. Permanent access is a deliberate manual act
        // (scripts/grant-access.mjs), never the result of a forgotten field in a GHL action.
        return res.status(400).json({ error: "Missing field: expires_at or days." });
      }

      if (expiresAt.getTime() <= start.getTime()) {
        return res.status(400).json({ error: "expires_at must be after starts_at." });
      }

      const result = await upsertGrant({ email, source, externalRef, startsAt: start, expiresAt });
      return res.json({
        ok: true,
        action: "grant",
        created: result.created,
        // A refunded purchase stays revoked even if GHL retries the original grant.
        revoked: result.revoked,
        startsAt: start.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error: any) {
      console.error("Access webhook failed:", error?.message ?? error);
      return res.status(500).json({ error: "Could not record access. Retry the webhook." });
    }
  });
}
