/**
 * Grants, lists or revokes ClearPath Mapper access by hand (project 2143, access gating).
 *
 *   railway run --service ClearPathMapper node scripts/grant-access.mjs <email>                        # show grants
 *   railway run --service ClearPathMapper node scripts/grant-access.mjs <email> --days 60              # dry run
 *   railway run --service ClearPathMapper node scripts/grant-access.mjs <email> --days 60 --apply
 *   railway run --service ClearPathMapper node scripts/grant-access.mjs <email> --permanent --apply
 *   railway run --service ClearPathMapper node scripts/grant-access.mjs <email> --revoke-manual --apply
 *
 * Dry run by default: it prints the grant it would write and stops.
 *
 * For comps, corrections and first tests. Purchases arrive through the GHL webhook
 * (server/access-webhook.ts), never through here. Every grant this writes has source 'manual',
 * so it can be told apart from a purchase and revoked without touching one: --revoke-manual
 * revokes only manual grants.
 *
 * Options:
 *   --days N        access for N days, starting now (or at --starts)
 *   --permanent     no expiry
 *   --starts DATE   start date, YYYY-MM-DD (default: now)
 *   --revoke-manual revoke this email's active manual grants
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PERMANENT = args.includes('--permanent');
const REVOKE = args.includes('--revoke-manual');
const optionValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const daysArg = optionValue('--days');
const startsArg = optionValue('--starts');
const optionValues = new Set([daysArg, startsArg].filter(Boolean));
const rawEmail = args.find(a => !a.startsWith('--') && !optionValues.has(a));

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/grant-access.mjs <email> [--days N | --permanent] [--starts YYYY-MM-DD] [--revoke-manual] [--apply]');
  process.exit(2);
}

if (!rawEmail) usage();
const email = rawEmail.trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage(`Not an email address: ${rawEmail}`);
if (daysArg !== undefined && PERMANENT) usage('Use --days or --permanent, not both.');
if (REVOKE && (daysArg !== undefined || PERMANENT)) usage('--revoke-manual cannot be combined with a grant.');

let days = null;
if (daysArg !== undefined) {
  days = Number(daysArg);
  if (!Number.isInteger(days) || days < 1 || days > 3650) usage('--days must be a whole number from 1 to 3650.');
}
const startsAt = startsArg ? new Date(startsArg) : new Date();
if (Number.isNaN(startsAt.getTime())) usage(`Invalid --starts date: ${startsArg}`);

/**
 * Railway's injected DATABASE_URL uses the internal hostname, which only resolves inside
 * Railway; swap in the public proxy address from the secrets file in that case only. Any other
 * URL — a local test database above all — is used exactly as given, so a local run can never be
 * silently redirected to production.
 */
function connectionString() {
  if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set. Run through `railway run`, or set it for a local database.');
  const url = new URL(process.env.DATABASE_URL);
  // Railway injects the TCP proxy's host and port into the Postgres service itself once Public
  // Access is on, so `railway run --service Postgres` can find them with nothing to copy by hand.
  if (url.hostname.endsWith('.railway.internal')
      && process.env.RAILWAY_TCP_PROXY_DOMAIN && process.env.RAILWAY_TCP_PROXY_PORT) {
    url.hostname = process.env.RAILWAY_TCP_PROXY_DOMAIN;
    url.port = process.env.RAILWAY_TCP_PROXY_PORT;
    return url.toString();
  }
  // Same swap from an environment variable set by hand, for a machine with no G: drive mounted:
  //   $env:POSTGRES_PUBLIC_ADDRESS = "<proxy host>:<port>"   (host and port only, never the password)
  if (url.hostname.endsWith('.railway.internal') && process.env.POSTGRES_PUBLIC_ADDRESS) {
    const [h, p] = process.env.POSTGRES_PUBLIC_ADDRESS.split(':');
    if (h && p) { url.hostname = h; url.port = p; }
    return url.toString();
  }
  if (url.hostname.endsWith('.railway.internal') && fs.existsSync(SECRETS)) {
    const env = Object.fromEntries(
      fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/).filter(l => l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    if (env.POSTGRES_PUBLIC_ADDRESS) {
      const [h, p] = env.POSTGRES_PUBLIC_ADDRESS.split(':');
      url.hostname = h; url.port = p;
    }
  }
  return url.toString();
}

const local = /^(localhost|127\.0\.0\.1)$/.test(new URL(process.env.DATABASE_URL ?? 'postgres://x@localhost/x').hostname);
const c = new pg.Client({ connectionString: connectionString(), ssl: local ? undefined : { rejectUnauthorized: false } });
await c.connect();

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function showGrants() {
  const { rows } = await c.query(
    `SELECT source, external_ref, starts_at, expires_at, revoked_at,
            (revoked_at IS NULL AND starts_at <= now() AND (expires_at IS NULL OR expires_at > now())) AS active
       FROM access_grants WHERE email = $1 ORDER BY created_at`, [email]);
  if (rows.length === 0) {
    console.log(`  no grants for ${email}`);
    return;
  }
  for (const r of rows) {
    const state = r.revoked_at ? `revoked ${fmt(r.revoked_at)}` : r.active ? 'ACTIVE' : 'inactive';
    console.log(`  ${state.padEnd(18)} ${r.source.padEnd(34)} ${fmt(r.starts_at)} → ${r.expires_at ? fmt(r.expires_at) : 'no expiry'}${r.external_ref ? `  ref ${r.external_ref}` : ''}`);
  }
}

try {
  console.log(`Grants for ${email}:`);
  await showGrants();

  if (REVOKE) {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM access_grants WHERE email = $1 AND source = 'manual' AND revoked_at IS NULL`, [email]);
    console.log(`\nWould revoke ${rows[0].n} active manual grant(s).`);
    if (!APPLY) { console.log('Dry run. Re-run with --apply to revoke.'); process.exit(0); }
    await c.query(
      `UPDATE access_grants SET revoked_at = now(), updated_at = now()
        WHERE email = $1 AND source = 'manual' AND revoked_at IS NULL`, [email]);
  } else if (days !== null || PERMANENT) {
    const expiresAt = PERMANENT ? null : new Date(startsAt.getTime() + days * 86400000);
    console.log(`\nWould grant: source manual, ${fmt(startsAt)} → ${expiresAt ? fmt(expiresAt) : 'no expiry'}`);
    if (!APPLY) { console.log('Dry run. Re-run with --apply to write it.'); process.exit(0); }
    await c.query(
      `INSERT INTO access_grants (email, source, starts_at, expires_at) VALUES ($1, 'manual', $2, $3)`,
      [email, startsAt, expiresAt]);
  } else {
    process.exit(0);
  }

  console.log('\nDone. Grants now:');
  await showGrants();
} finally {
  await c.end();
}
