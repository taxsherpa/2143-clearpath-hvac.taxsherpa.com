/**
 * Applies the Phase 2 (project 2143) category-model migration to a real database.
 *
 *   railway run --service ClearPathMapper node scripts/apply-phase2-migration.mjs          # dry run
 *   railway run --service ClearPathMapper node scripts/apply-phase2-migration.mjs --apply  # for real
 *
 * Without `--apply` it only reports the current state and stops, so running it by accident
 * changes nothing.
 *
 * The migration file itself is wrapped in BEGIN/COMMIT, so it either lands whole or not at all.
 * This wrapper adds the before/after accounting around it: row counts are captured first and
 * re-checked afterwards, and a mismatch is reported loudly. Rehearse with
 * `verify-phase2-migration.mjs` before running this.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const APPLY = process.argv.includes('--apply');
const TABLES = ['users', 'uploads', 'pl_nodes', 'category_mappings', 'rules', 'reports'];

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
    out[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  }
  return out;
}

async function enumValues(client) {
  return (await client.query(
    `SELECT unnest(enum_range(NULL::clearpath_category))::text AS v`)).rows.map(r => r.v);
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

let failures = 0;
try {
  const before = await counts(client);
  const enumBefore = await enumValues(client);
  console.log('BEFORE');
  console.log('  rows:', JSON.stringify(before));
  console.log('  enum:', enumBefore.join(','));

  const alreadyMigrated = enumBefore.includes('opex_systems');
  if (alreadyMigrated) {
    console.log('\nEnum already holds the new values — migration has already been applied. Nothing to do.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to migrate.');
    process.exit(0);
  }

  console.log('\nApplying migrations/2143-phase2-category-model.sql ...');
  await client.query(fs.readFileSync('migrations/2143-phase2-category-model.sql', 'utf8'));
  console.log('Committed.\n');

  const after = await counts(client);
  const enumAfter = await enumValues(client);
  console.log('AFTER');
  console.log('  rows:', JSON.stringify(after));
  console.log('  enum:', enumAfter.join(','));

  console.log('');
  for (const t of TABLES) {
    const ok = before[t] === after[t];
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t} row count unchanged (${before[t]} -> ${after[t]})`);
    if (!ok) failures++;
  }

  const expected = ['revenue', 'fulfillment_cogs', 'fulfillment_services', 'cac',
    'opex_systems', 'opex_people', 'tax_strategy'];
  const enumOk = JSON.stringify(enumAfter) === JSON.stringify(expected);
  console.log(`${enumOk ? 'PASS' : 'FAIL'}  enum holds exactly the new seven values`);
  if (!enumOk) failures++;

  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'category_mappings' AND table_schema = 'public'`)).rows.map(r => r.column_name);
  for (const c of ['status', 'excluded_reason']) {
    const ok = cols.includes(c);
    console.log(`${ok ? 'PASS' : 'FAIL'}  category_mappings.${c} exists`);
    if (!ok) failures++;
  }

  const flagged = (await client.query(
    `SELECT count(*)::int AS n FROM category_mappings WHERE confidence = 'needs_review'`)).rows[0].n;
  console.log(`INFO  ${flagged} mapping(s) now marked needs_review and awaiting a COGS-vs-Services decision`);

  const excluded = (await client.query(
    `SELECT count(*)::int AS n FROM category_mappings WHERE status = 'excluded'`)).rows[0].n;
  const exOk = excluded === 0;
  console.log(`${exOk ? 'PASS' : 'FAIL'}  no rows arrive pre-excluded (${excluded})`);
  if (!exOk) failures++;
} finally {
  await client.end();
}

console.log(failures === 0 ? '\nMIGRATION OK' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
