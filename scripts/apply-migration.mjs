/**
 * Applies a migration file from `migrations/` to a real database, with before/after row
 * accounting on every table.
 *
 *   railway run --service ClearPathMapper node scripts/apply-migration.mjs <file>           # dry run
 *   railway run --service ClearPathMapper node scripts/apply-migration.mjs <file> --apply   # for real
 *
 * Without `--apply` it reports the current state and stops, so running it by accident changes
 * nothing. The migration file itself must be wrapped in BEGIN/COMMIT so it lands whole or not
 * at all; this wrapper adds the accounting around it and refuses to report success if any row
 * count moved.
 *
 * Generalises `apply-phase2-migration.mjs`, which was hardcoded to one file. That script is
 * kept as the historical record of the Phase 2 category migration.
 *
 * Do NOT point this at `migrations/0000_cuddly_iron_monger.sql`. It is stale, describes tables
 * that no longer exist, and would produce the wrong schema.
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const TABLES = ['users', 'login_tokens', 'uploads', 'pl_nodes', 'category_mappings', 'rules', 'reports'];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const file = args.find(a => !a.startsWith('--'));

if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <migrations/file.sql> [--apply]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}
if (path.basename(file).startsWith('0000_')) {
  console.error('Refusing: 0000_cuddly_iron_monger.sql is stale and must never be replayed.');
  process.exit(2);
}

function connectionString() {
  const url = new URL(process.env.DATABASE_URL);
  if (fs.existsSync(SECRETS)) {
    const env = Object.fromEntries(
      fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/).filter(l => l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
    if (env.POSTGRES_PUBLIC_ADDRESS) {
      const [host, port] = env.POSTGRES_PUBLIC_ADDRESS.split(':');
      url.hostname = host;
      url.port = port;
    }
  }
  return url.toString();
}

async function counts(client) {
  const out = {};
  for (const t of TABLES) {
    try {
      out[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    } catch {
      out[t] = null; // table doesn't exist yet
    }
  }
  return out;
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

let failures = 0;
try {
  const before = await counts(client);
  console.log(`Migration: ${file}`);
  console.log('BEFORE rows:', JSON.stringify(before));

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to migrate.');
    process.exit(0);
  }

  console.log('\nApplying ...');
  await client.query(fs.readFileSync(file, 'utf8'));
  console.log('Committed.\n');

  const after = await counts(client);
  console.log('AFTER  rows:', JSON.stringify(after), '\n');

  for (const t of TABLES) {
    const ok = before[t] === after[t];
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t} row count unchanged (${before[t]} -> ${after[t]})`);
    if (!ok) failures++;
  }
} finally {
  await client.end();
}

console.log(failures === 0 ? '\nMIGRATION OK' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
