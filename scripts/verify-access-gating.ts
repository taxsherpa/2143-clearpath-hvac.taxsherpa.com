/**
 * Verifies paid access gating end to end: the migration, the GHL webhook, sign-in, and the
 * per-request check — against a THROWAWAY Postgres, through the real Express routes.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:54329/cpm_access_test \
 *     npx tsx scripts/verify-access-gating.ts
 *
 * It DROPS and recreates the database named in DATABASE_URL, so it refuses to run unless the
 * host is localhost and the database name contains "test". It never sends email
 * (EMAIL_TRANSPORT=memory) and never needs a Resend, Gemini or GHL credential.
 *
 * Schema: `drizzle-kit push` builds the current schema, then `access_grants` is dropped and
 * recreated by the real migration file — so the migration itself is what gets tested,
 * including its legacy grants for users who existed before it ran, and running it twice.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import pg from "pg";
import type { AddressInfo } from "net";

const TEST_URL = process.env.DATABASE_URL;
if (!TEST_URL) {
  console.error("Set DATABASE_URL to a throwaway local database (its name must contain 'test').");
  process.exit(2);
}
const parsed = new URL(TEST_URL);
const dbName = parsed.pathname.replace(/^\//, "");
if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) || !dbName.includes("test")) {
  console.error(`Refusing to run: ${parsed.hostname}/${dbName} is not a local test database.`);
  process.exit(2);
}

process.env.NODE_ENV = "test";
process.env.EMAIL_TRANSPORT = "memory";
process.env.GHL_ACCESS_WEBHOOK_SECRET = "test-secret";
process.env.ACCESS_PURCHASE_URL = "https://go.taxsherpa.com/hvac-workshop/register";
process.env.SESSION_SECRET = "verify-access-gating";
delete process.env.ACCESS_GATE_ENABLED;

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: ok ? undefined : JSON.stringify(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}
const gate = (on: boolean) => {
  if (on) process.env.ACCESS_GATE_ENABLED = "true";
  else delete process.env.ACCESS_GATE_ENABLED;
};

// --- 1. Fresh database, current schema, then the real migration ------------------------------
console.log("\n1. Database and migration");
{
  const admin = new pg.Client({ connectionString: TEST_URL.replace(/\/[^/]*$/, "/postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
}
execSync("npx drizzle-kit push --force", { stdio: "pipe", env: process.env });

const migrationSql = fs.readFileSync(path.join("migrations", "2143-access-grants.sql"), "utf8");
{
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  // Recreate the pre-migration state: no access_grants table, and a user who already exists.
  await c.query("DROP TABLE access_grants");
  await c.query("INSERT INTO users (email) VALUES ('legacy@example.com'), ('Mixed.Case@Example.com')");

  await c.query(migrationSql);
  const first = await c.query("SELECT email, source, expires_at, revoked_at FROM access_grants ORDER BY email");
  check("migration gives every existing user a permanent legacy grant",
    first.rows.length === 2 && first.rows.every(r => r.source === "legacy" && r.expires_at === null && r.revoked_at === null),
    first.rows);
  check("legacy grant emails are normalised to lowercase",
    first.rows.some(r => r.email === "mixed.case@example.com"), first.rows.map(r => r.email));

  await c.query(migrationSql);
  const second = await c.query("SELECT count(*)::int AS n FROM access_grants");
  check("running the migration twice adds nothing", second.rows[0].n === 2, second.rows[0].n);
  await c.end();
}

// --- 2. The real app, in-process --------------------------------------------------------------
const express = (await import("express")).default;
const { setupAuth } = await import("../server/auth");
const { registerRoutes } = await import("../server/routes");
const { memoryOutbox } = await import("../server/lib/email");
const { evaluateGrants } = await import("../server/lib/access");
const { pool } = await import("../server/db");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
setupAuth(app);
const server = await registerRoutes(app);
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Jar = { cookie: string };
async function call(method: string, url: string, opts: { body?: unknown; jar?: Jar; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.jar?.cookie ? { cookie: opts.jar.cookie } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (opts.jar && setCookie) opts.jar.cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function requestLink(email: string) {
  const before = memoryOutbox.length;
  const res = await call("POST", "/api/auth/magic-link", { body: { email } });
  const mail = memoryOutbox.slice(before).find(m => m.to === email.toLowerCase());
  const token = mail?.text.match(/token=([a-f0-9]+)/)?.[1] ?? null;
  return { ...res, mail, token };
}

async function signIn(email: string) {
  const jar: Jar = { cookie: "" };
  const link = await requestLink(email);
  const verify = link.token ? await call("POST", "/api/auth/verify", { body: { token: link.token }, jar }) : null;
  return { jar, link, verify };
}

const webhook = (body: unknown, key: string | null = "test-secret") =>
  call("POST", "/api/webhooks/ghl/access", { body, headers: key === null ? {} : { "x-api-key": key } });

const grantCount = async (where: string, params: unknown[]) =>
  (await pool.query(`SELECT count(*)::int AS n FROM access_grants WHERE ${where}`, params)).rows[0].n as number;

try {
  // --- 3. Gate off: nothing changes -----------------------------------------------------------
  console.log("\n2. Gate OFF — behaves exactly as before");
  gate(false);
  {
    const s = await signIn("nobody-granted@example.com");
    check("an address with no grant still gets a sign-in link", s.link.mail?.kind === "magic-link", s.link.mail?.kind);
    check("…and signs in", s.verify?.status === 200, s.verify);
    const me = await call("GET", "/api/user", { jar: s.jar });
    check("/api/user answers 200", me.status === 200, me);
    const uploads = await call("GET", "/api/uploads", { jar: s.jar });
    check("authenticated routes answer 200", uploads.status === 200, uploads.status);
    const cfg = await call("GET", "/api/auth/config");
    check("/api/auth/config reports the gate off", cfg.json?.accessGateEnabled === false, cfg.json);
  }

  // --- 4. Webhook contract ---------------------------------------------------------------------
  console.log("\n3. GHL webhook");
  {
    const ok = { email: "Buyer@Example.com", source: "ghl:workshop-test", external_ref: "order-1", starts_at: "2026-01-01", days: 3000 };
    check("no API key → 401", (await webhook(ok, null)).status === 401);
    check("wrong API key → 401", (await webhook(ok, "nope")).status === 401);
    check("missing source → 400", (await webhook({ ...ok, source: undefined })).status === 400);
    check("reserved source 'legacy' → 400", (await webhook({ ...ok, source: "legacy" })).status === 400);
    check("missing expiry → 400 (webhook grants always end)", (await webhook({ ...ok, days: undefined })).status === 400);
    check("expires_at and days together → 400", (await webhook({ ...ok, expires_at: "2030-01-01" })).status === 400);
    check("invalid email → 400", (await webhook({ ...ok, email: "not-an-email" })).status === 400);
    check("expiry before start → 400", (await webhook({ ...ok, days: undefined, expires_at: "2025-01-01" })).status === 400);

    const created = await webhook(ok);
    check("valid grant → 200, created", created.status === 200 && created.json?.created === true, created);
    const retried = await webhook(ok);
    check("same purchase sent again → 200, not created again", retried.status === 200 && retried.json?.created === false, retried.json);
    check("…and still exactly one row", (await grantCount("source = $1 AND external_ref = $2", ["ghl:workshop-test", "order-1"])) === 1);
    check("webhook email stored lowercase",
      (await grantCount("email = $1", ["buyer@example.com"])) === 1);

    const standardAction = await webhook({
      email: "standard@example.com",
      source: "HVAC Precision Path Call", // the CONTACT's source, as GHL's standard action sends it
      customData: { source: "ghl:workshop-test", external_ref: "order-cd", days: 60 },
    });
    check("customData wins over colliding top-level contact fields", standardAction.status === 200 &&
      (await grantCount("email = $1 AND source = $2", ["standard@example.com", "ghl:workshop-test"])) === 1, standardAction.json);
  }

  // --- 5. Gate on --------------------------------------------------------------------------------
  console.log("\n4. Gate ON — sign-in");
  gate(true);
  {
    const cfg = await call("GET", "/api/auth/config");
    check("/api/auth/config reports the gate on", cfg.json?.accessGateEnabled === true && !!cfg.json?.purchaseUrl, cfg.json);

    const legacy = await signIn("legacy@example.com");
    check("legacy user gets a link and signs in", legacy.link.mail?.kind === "magic-link" && legacy.verify?.status === 200, legacy.verify);

    const buyer = await signIn("buyer@example.com");
    check("buyer with an active grant signs in (account created on click)", buyer.verify?.status === 200, buyer.verify);
    check("…and authenticated routes answer 200", (await call("GET", "/api/uploads", { jar: buyer.jar })).status === 200);

    const granted = await requestLink("buyer@example.com");
    const stranger = await requestLink("stranger@example.com");
    check("no access: same HTTP status and body as with access",
      stranger.status === granted.status && JSON.stringify(stranger.json) === JSON.stringify(granted.json),
      { granted: granted.json, stranger: stranger.json });
    check("no access: the no-access email is sent, not a link", stranger.mail?.kind === "no-access" && !stranger.token, stranger.mail?.kind);
    check("no access: the email offers the purchase link", !!stranger.mail?.text.includes("https://go.taxsherpa.com/hvac-workshop/register"));
    check("no access: no login token is created",
      (await pool.query("SELECT count(*)::int AS n FROM login_tokens WHERE email = $1", ["stranger@example.com"])).rows[0].n === 0);

    await webhook({ email: "future@example.com", source: "ghl:workshop-test", external_ref: "order-future",
      starts_at: new Date(Date.now() + 10 * 86400000).toISOString(), days: 60 });
    const future = await requestLink("future@example.com");
    check("grant that hasn't started: no link, email says when it starts",
      future.mail?.kind === "no-access" && future.mail.text.includes("starts on"), future.mail?.text);

    // A token issued while the gate was off must not get round the gate once it is on.
    gate(false);
    const early = await requestLink("no-grant-early-token@example.com");
    gate(true);
    const earlyVerify = await call("POST", "/api/auth/verify", { body: { token: early.token } });
    check("valid token, no access at click time → 403", earlyVerify.status === 403 && earlyVerify.json?.code === "access_expired", earlyVerify);

    // Link requested while access was active; refund lands before the click.
    await webhook({ email: "refund@example.com", source: "ghl:workshop-test", external_ref: "order-refund", days: 60 });
    const refundLink = await requestLink("refund@example.com");
    check("refund case: link sent while access active", refundLink.mail?.kind === "magic-link", refundLink.mail?.kind);
    const revoked = await webhook({ action: "revoke", source: "ghl:workshop-test", external_ref: "order-refund" });
    check("revoke → 200, one grant revoked", revoked.status === 200 && revoked.json?.revoked === 1, revoked.json);
    const refundVerify = await call("POST", "/api/auth/verify", { body: { token: refundLink.token } });
    check("refund case: clicking the earlier link → 403", refundVerify.status === 403, refundVerify);
    const retryAfterRefund = await webhook({ email: "refund@example.com", source: "ghl:workshop-test", external_ref: "order-refund", days: 60 });
    check("GHL retrying the original grant does not undo the refund",
      retryAfterRefund.json?.revoked === true && (await requestLink("refund@example.com")).mail?.kind === "no-access", retryAfterRefund.json);

    check("revoke without external_ref or email → 400",
      (await webhook({ action: "revoke", source: "ghl:workshop-test" })).status === 400);
    const otherSource = await webhook({ action: "revoke", source: "ghl:some-other-offer", email: "buyer@example.com" });
    check("revoke by email only touches that source", otherSource.json?.revoked === 0 &&
      (await call("GET", "/api/uploads", { jar: buyer.jar })).status === 200, otherSource.json);

    console.log("\n5. Gate ON — access ends mid-session");
    await pool.query("UPDATE access_grants SET expires_at = now() - interval '1 minute' WHERE email = $1", ["buyer@example.com"]);
    const me = await call("GET", "/api/user", { jar: buyer.jar });
    check("/api/user → 403 access_expired, with the end date", me.status === 403 && me.json?.error === "access_expired" && !!me.json?.endedAt, me);
    const uploads = await call("GET", "/api/uploads", { jar: buyer.jar });
    check("authenticated routes → 403", uploads.status === 403, uploads.status);
    const purge = await call("DELETE", "/api/account/data?keepRules=false", { jar: buyer.jar });
    check("data purge still allowed without access", purge.status >= 200 && purge.status < 300, purge);

    gate(false);
    const meGateOff = await call("GET", "/api/user", { jar: buyer.jar });
    check("turning the gate off restores the same session immediately", meGateOff.status === 200, meGateOff.status);
  }

  // --- 6. The rule itself ------------------------------------------------------------------------
  console.log("\n6. evaluateGrants");
  {
    const now = new Date("2026-10-01T00:00:00Z");
    const d = (s: string) => new Date(s);
    const g = (startsAt: string, expiresAt: string | null, revokedAt: string | null = null) =>
      ({ startsAt: d(startsAt), expiresAt: expiresAt ? d(expiresAt) : null, revokedAt: revokedAt ? d(revokedAt) : null });

    check("no grants → inactive", evaluateGrants([], now).active === false);
    check("expiry exactly now → inactive (ends at the instant, not after)",
      evaluateGrants([g("2026-09-01", "2026-10-01T00:00:00Z")], now).active === false);
    check("one active among expired and revoked → active",
      evaluateGrants([g("2026-01-01", "2026-02-01"), g("2026-09-01", null, "2026-09-15"), g("2026-09-29", "2026-11-28")], now).active === true);
    const lapsed = evaluateGrants([g("2026-01-01", "2026-02-01"), g("2026-03-01", "2026-04-01")], now);
    check("lapsed → reports the LATEST end", !lapsed.active && lapsed.endedAt?.toISOString().startsWith("2026-04-01"), lapsed);
    const revokedOnly = evaluateGrants([g("2026-09-01", "2026-12-01", "2026-09-10")], now);
    check("revoked grant's dates are ignored", !revokedOnly.active && revokedOnly.endedAt === null && revokedOnly.startsAt === null, revokedOnly);
  }
} finally {
  server.close();
  await pool.end();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log("ACCESS GATING OK");
