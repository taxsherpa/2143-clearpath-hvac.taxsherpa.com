/**
 * Phase 2 (project 2143) migration rehearsal.
 *
 * Builds a throwaway schema containing the OLD table/enum shapes, seeds it with rows covering
 * all seven retired categories, runs `migrations/2143-phase2-category-model.sql` against it,
 * and asserts the result. Production is never touched: everything happens inside a schema
 * named `phase2_rehearsal_<pid>`, which is dropped at the end even on failure.
 *
 *   railway run --service ClearPathMapper node scripts/verify-phase2-migration.mjs
 *
 * (POSTGRES_PUBLIC_ADDRESS from the project's .env is grafted onto DATABASE_URL, because the
 * Railway plugin's own hostname only resolves from inside Railway's network.)
 *
 * Exits non-zero on any failure.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const SCHEMA = `phase2_rehearsal_${process.pid}`;

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

  // ---- the OLD world, as production looks today -------------------------------------
  await client.query(`
    CREATE TYPE clearpath_category AS ENUM
      ('revenue','fulfillment','cac','systems','people','owners_pay','taxes');
    CREATE TYPE confidence_level AS ENUM ('high','medium','needs_review');
    CREATE TABLE category_mappings (
      id serial PRIMARY KEY,
      node_id text NOT NULL,
      clearpath_category clearpath_category NOT NULL,
      confidence confidence_level NOT NULL DEFAULT 'needs_review'
    );
    CREATE TABLE rules (
      id serial PRIMARY KEY,
      clearpath_category clearpath_category NOT NULL
    );
  `);

  await client.query(`
    INSERT INTO category_mappings (node_id, clearpath_category, confidence) VALUES
      ('n1','revenue','high'),
      ('n2','fulfillment','high'),      -- ambiguous: must be flagged
      ('n3','fulfillment','medium'),    -- ambiguous: must be flagged
      ('n4','cac','high'),
      ('n5','systems','medium'),
      ('n6','people','medium'),
      ('n7','owners_pay','medium'),
      ('n8','taxes','medium');
    INSERT INTO rules (clearpath_category) VALUES ('systems'),('owners_pay');
  `);

  // ---- run the real migration file ---------------------------------------------------
  let sql = fs.readFileSync('migrations/2143-phase2-category-model.sql', 'utf8');
  // The file targets the default schema; scope it to the rehearsal schema instead.
  sql = sql.replace(/^BEGIN;/m, `BEGIN;\nSET LOCAL search_path TO ${SCHEMA};`);
  await client.query(sql);
  await client.query(`SET search_path TO ${SCHEMA}`);

  // ---- assertions --------------------------------------------------------------------
  const values = (await client.query(
    `SELECT unnest(enum_range(NULL::${SCHEMA}.clearpath_category))::text AS v`)).rows.map(r => r.v);
  check('enum holds exactly the new seven values',
    JSON.stringify(values) === JSON.stringify([
      'revenue', 'fulfillment_cogs', 'fulfillment_services', 'cac',
      'opex_systems', 'opex_people', 'tax_strategy']),
    values.join(','));

  const rows = (await client.query(
    `SELECT node_id, clearpath_category::text AS cat, confidence::text AS conf, status::text AS st
       FROM category_mappings ORDER BY node_id`)).rows;
  const by = Object.fromEntries(rows.map(r => [r.node_id, r]));

  check('no rows lost', rows.length === 8, `${rows.length} rows`);
  check('revenue -> revenue', by.n1.cat === 'revenue', by.n1.cat);
  check('cac -> cac', by.n4.cat === 'cac', by.n4.cat);
  check('systems -> opex_systems', by.n5.cat === 'opex_systems', by.n5.cat);
  check('people -> opex_people', by.n6.cat === 'opex_people', by.n6.cat);
  check('owners_pay -> tax_strategy', by.n7.cat === 'tax_strategy', by.n7.cat);
  check('taxes -> tax_strategy', by.n8.cat === 'tax_strategy', by.n8.cat);

  check('fulfillment -> fulfillment_cogs',
    by.n2.cat === 'fulfillment_cogs' && by.n3.cat === 'fulfillment_cogs');
  check('BOTH former fulfillment rows flagged needs_review (the Safety Rail)',
    by.n2.conf === 'needs_review' && by.n3.conf === 'needs_review',
    `n2=${by.n2.conf} n3=${by.n3.conf}`);
  check('deterministic rows KEEP their original confidence',
    by.n1.conf === 'high' && by.n4.conf === 'high' && by.n5.conf === 'medium' &&
    by.n7.conf === 'medium',
    `n1=${by.n1.conf} n4=${by.n4.conf} n5=${by.n5.conf} n7=${by.n7.conf}`);
  check('every row defaults to status=mapped', rows.every(r => r.st === 'mapped'));

  const ruleCats = (await client.query(
    `SELECT clearpath_category::text AS cat FROM rules ORDER BY id`)).rows.map(r => r.cat);
  check('rules column migrated too',
    JSON.stringify(ruleCats) === JSON.stringify(['opex_systems', 'tax_strategy']),
    ruleCats.join(','));

  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'category_mappings'`, [SCHEMA])).rows.map(r => r.column_name);
  check('excluded_reason column added', cols.includes('excluded_reason'));

  // A retired value must no longer be accepted at all.
  let rejected = false;
  try {
    await client.query(`INSERT INTO category_mappings (node_id, clearpath_category) VALUES ('x','owners_pay')`);
  } catch { rejected = true; }
  check('retired value owners_pay is now rejected by the type', rejected);
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  console.log(`\nDropped ${SCHEMA}.`);
  await client.end();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
