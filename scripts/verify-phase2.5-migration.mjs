/**
 * Phase 2.5 (project 2143) periods migration rehearsal.
 *
 * Builds a throwaway schema containing the pre-migration shape (uploads.month_start,
 * pl_nodes.amount_cents), seeds it with rows resembling real production data — two uploads,
 * several nodes each, one rollup row with no amount — runs
 * `migrations/2143-phase2.5-periods.sql` against it, and asserts the result. Production is
 * never touched: everything happens inside a schema named `phase25_rehearsal_<pid>`, dropped at
 * the end even on failure.
 *
 *   railway run --service ClearPathMapper node scripts/verify-phase2.5-migration.mjs
 *
 * Exits non-zero on any failure.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const SCHEMA = `phase25_rehearsal_${process.pid}`;

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

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  console.log(`Rehearsing in isolated schema ${SCHEMA} (production untouched)\n`);

  // ---- the OLD world, as production looks today (post-Phase-2, pre-Phase-2.5) -----------
  await client.query(`
    CREATE TABLE uploads (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      original_filename text NOT NULL,
      month_start timestamp NOT NULL,
      status text NOT NULL DEFAULT 'parsed'
    );
    CREATE TABLE pl_nodes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id varchar NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      label text NOT NULL,
      is_rollup integer NOT NULL DEFAULT 0,
      amount_cents integer
    );
  `);

  await client.query(`
    INSERT INTO uploads (id, original_filename, month_start) VALUES
      ('u1', 'december.csv', '2025-12-01'),
      ('u2', 'january.csv', '2026-01-01');
    INSERT INTO pl_nodes (id, upload_id, label, is_rollup, amount_cents) VALUES
      ('n1', 'u1', 'Revenue', 0, 500000),
      ('n2', 'u1', 'Total Revenue', 1, NULL),
      ('n3', 'u1', 'Rent', 0, 150000),
      ('n4', 'u2', 'Revenue', 0, 600000),
      ('n5', 'u2', 'Rent', 0, 150000),
      ('n6', 'u2', 'Header only, no amount', 0, NULL);
  `);

  // ---- run the real migration file, scoped to the rehearsal schema ----------------------
  let sql = fs.readFileSync('migrations/2143-phase2.5-periods.sql', 'utf8');
  sql = sql.replace(/^BEGIN;/m, `BEGIN;\nSET LOCAL search_path TO ${SCHEMA};`);
  await client.query(sql);
  await client.query(`SET search_path TO ${SCHEMA}`);

  // ---- assertions -------------------------------------------------------------------------
  const periods = (await client.query(
    `SELECT upload_id, period_type::text AS pt, months_covered, confirmed, label
       FROM periods ORDER BY upload_id`)).rows;
  check('one period per existing upload', periods.length === 2, `${periods.length} periods`);
  check('every period is type=month, monthsCovered=1, confirmed=true',
    periods.every(p => p.pt === 'month' && p.months_covered === 1 && p.confirmed === true),
    JSON.stringify(periods));

  const dec = periods.find(p => p.upload_id === 'u1');
  check('December period start/label carries the original month', dec.label.trim() === 'December 2025', dec.label);

  const amounts = (await client.query(
    `SELECT n.id AS node_id, a.amount_cents
       FROM pl_node_period_amounts a JOIN pl_nodes n ON n.id = a.node_id
       ORDER BY n.id`)).rows;
  check('amount rows created only for nodes that had an amount (5 of 6, rollup + header excluded)',
    amounts.length === 4, `${amounts.length} rows: ${JSON.stringify(amounts)}`);
  // n1, n3, n4, n5 had amounts; n2 (rollup) and n6 (header) did not.
  const byNode = Object.fromEntries(amounts.map(a => [a.node_id, a.amount_cents]));
  check('n1 (Revenue, December) amount preserved exactly', byNode.n1 === 500000, String(byNode.n1));
  check('n3 (Rent, December) amount preserved exactly', byNode.n3 === 150000, String(byNode.n3));
  check('n4 (Revenue, January) amount preserved exactly', byNode.n4 === 600000, String(byNode.n4));
  check('rollup node n2 got no amount row', byNode.n2 === undefined);
  check('header-only node n6 got no amount row', byNode.n6 === undefined);

  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'pl_nodes'`, [SCHEMA])).rows.map(r => r.column_name);
  check('pl_nodes.amount_cents column is dropped', !cols.includes('amount_cents'), cols.join(','));

  const nodeCount = (await client.query(`SELECT count(*)::int AS n FROM pl_nodes`)).rows[0].n;
  check('no pl_nodes rows lost', nodeCount === 6, String(nodeCount));
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  console.log(`\nDropped ${SCHEMA}.`);
  await client.end();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
