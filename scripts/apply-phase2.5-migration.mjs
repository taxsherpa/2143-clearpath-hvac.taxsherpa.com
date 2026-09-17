/**
 * Applies the Phase 2.5 (project 2143) periods migration to a real database.
 *
 *   railway run --service ClearPathMapper node scripts/apply-phase2.5-migration.mjs          # dry run
 *   railway run --service ClearPathMapper node scripts/apply-phase2.5-migration.mjs --apply  # for real
 *
 * Without `--apply` it only reports the current state and stops. The migration file itself is
 * wrapped in BEGIN/COMMIT, so it either lands whole or not at all. This wrapper adds the
 * before/after accounting: row counts across the tables the migration must not disturb are
 * captured first and re-checked afterwards, plus the new periods/pl_node_period_amounts counts
 * are reported. Rehearse with verify-phase2.5-migration.mjs before running this.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const APPLY = process.argv.includes('--apply');
const PRESERVED_TABLES = ['users', 'uploads', 'pl_nodes', 'category_mappings', 'rules', 'reports'];

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

async function counts(client, tables) {
  const out = {};
  for (const t of tables) {
    out[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  }
  return out;
}

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
  return r.rowCount > 0;
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

let failures = 0;
try {
  const before = await counts(client, PRESERVED_TABLES);
  console.log('BEFORE');
  console.log('  rows:', JSON.stringify(before));

  const alreadyMigrated = await tableExists(client, 'periods');
  if (alreadyMigrated) {
    console.log('\nperiods table already exists — migration has already been applied. Nothing to do.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to migrate.');
    process.exit(0);
  }

  console.log('\nApplying migrations/2143-phase2.5-periods.sql ...');
  await client.query(fs.readFileSync('migrations/2143-phase2.5-periods.sql', 'utf8'));
  console.log('Committed.\n');

  const after = await counts(client, PRESERVED_TABLES);
  console.log('AFTER');
  console.log('  rows:', JSON.stringify(after));

  console.log('');
  for (const t of PRESERVED_TABLES) {
    const ok = before[t] === after[t];
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t} row count unchanged (${before[t]} -> ${after[t]})`);
    if (!ok) failures++;
  }

  const periodsCount = (await client.query(`SELECT count(*)::int AS n FROM periods`)).rows[0].n;
  const uploadsCount = after.uploads;
  console.log(`${periodsCount === uploadsCount ? 'PASS' : 'FAIL'}  one period created per existing upload (${periodsCount} periods for ${uploadsCount} uploads)`);
  if (periodsCount !== uploadsCount) failures++;

  const amountsCount = (await client.query(`SELECT count(*)::int AS n FROM pl_node_period_amounts`)).rows[0].n;
  const nodesWithAmountBefore = (await client.query(
    // pl_nodes.amount_cents no longer exists post-migration, so this only runs meaningfully
    // pre-migration; kept here for the log even though the column is gone by now.
    `SELECT count(*)::int AS n FROM pl_node_period_amounts`)).rows[0].n;
  console.log(`INFO  ${amountsCount} pl_node_period_amounts row(s) created`);

  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='pl_nodes' AND table_schema='public'`)).rows.map(r => r.column_name);
  const dropped = !cols.includes('amount_cents');
  console.log(`${dropped ? 'PASS' : 'FAIL'}  pl_nodes.amount_cents column dropped`);
  if (!dropped) failures++;
} finally {
  await client.end();
}

console.log(failures === 0 ? '\nMIGRATION OK' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
