/**
 * Mapping-memory rehearsal (project 2143).
 *
 * Builds a throwaway schema, runs `migrations/2143-mapping-memory.sql` against it, and
 * exercises the record-then-recall behaviour with real SQL: the upsert, the unique index, the
 * path-beats-label precedence, and the exclusion carry-forward. Production is never touched —
 * everything happens inside `memory_rehearsal_<pid>`, dropped at the end even on failure.
 *
 *   railway run --service ClearPathMapper node scripts/verify-mapping-memory.mjs
 *
 * Exits non-zero on any failure.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const SCHEMA = `memory_rehearsal_${process.pid}`;

function connectionString() {
  const url = new URL(process.env.DATABASE_URL);
  if (fs.existsSync(SECRETS)) {
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

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const c = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await c.connect();

/** Mirrors recordMappingChoice(): one path rule and one label rule, upserted. */
async function record({ user, label, path, category, status = 'mapped' }) {
  for (const [scope, value, priority] of [
    ['category_path', path, 100],
    ['category_label', label, 50],
  ]) {
    await c.query(
      `INSERT INTO rules (user_id, scope, scope_value, clearpath_category, status, priority)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, scope, scope_value)
       DO UPDATE SET clearpath_category = EXCLUDED.clearpath_category,
                     status = EXCLUDED.status, updated_at = now()`,
      [user, scope, value, category, status, priority]);
  }
}

/**
 * Mirrors lookupRemembered(): exact path first, then bare label.
 * `occurrences` is how many lines in the incoming statement carry this name — a name used once
 * is unambiguous and its match is trusted; a name used twice is flagged instead of guessed at.
 */
async function recall({ user, label, path, occurrences = 1 }) {
  const byPath = await c.query(
    `SELECT * FROM rules WHERE user_id=$1 AND scope='category_path' AND scope_value=$2`, [user, path]);
  if (byPath.rows.length) {
    const r = byPath.rows[0];
    return { category: r.clearpath_category, status: r.status,
             confidence: r.status === 'excluded' ? 'needs_review' : 'high', matchedOn: 'path' };
  }
  const byLabel = await c.query(
    `SELECT * FROM rules WHERE user_id=$1 AND scope='category_label' AND scope_value=$2`, [user, label]);
  if (byLabel.rows.length) {
    const r = byLabel.rows[0];
    const ambiguous = occurrences > 1;
    return { category: r.clearpath_category, status: r.status,
             confidence: (r.status === 'excluded' || ambiguous) ? 'needs_review' : 'high',
             matchedOn: 'label', ambiguous };
  }
  return null;
}

try {
  await c.query(`CREATE SCHEMA ${SCHEMA}`);
  await c.query(`SET search_path TO ${SCHEMA}`);
  console.log(`Rehearsing in isolated schema ${SCHEMA} (production untouched)\n`);

  await c.query(`
    CREATE TYPE clearpath_category AS ENUM
      ('revenue','fulfillment_cogs','fulfillment_services','cac','opex_systems','opex_people','tax_strategy');
    CREATE TYPE mapping_status AS ENUM ('mapped','excluded');
    CREATE TYPE rule_scope AS ENUM ('category_label','category_path','category_regex');
    CREATE TABLE rules (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      scope rule_scope NOT NULL,
      scope_value text NOT NULL,
      clearpath_category clearpath_category NOT NULL,
      priority integer NOT NULL DEFAULT 50,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );`);

  let sql = fs.readFileSync('migrations/2143-mapping-memory.sql', 'utf8');
  sql = sql.replace(/^BEGIN;/m, `BEGIN;\nSET LOCAL search_path TO ${SCHEMA};`);
  await c.query(sql);
  await c.query(`SET search_path TO ${SCHEMA}`);

  const cols = (await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='rules'`, [SCHEMA])).rows.map(r => r.column_name);
  for (const col of ['status', 'times_applied', 'last_applied_at']) {
    check(`migration added rules.${col}`, cols.includes(col));
  }

  // ---------------------------------------------------------------------------------
  console.log('\n-- January: the user maps a line --');
  await record({ user: 'u1', label: 'Advertising', path: 'Expenses > Marketing > Advertising', category: 'cac' });
  let hit = await recall({ user: 'u1', label: 'Advertising', path: 'Expenses > Marketing > Advertising' });
  check('December recalls it by exact path', hit?.category === 'cac' && hit.matchedOn === 'path', JSON.stringify(hit));
  check('an exact path match is trusted, not re-flagged', hit?.confidence === 'high', hit?.confidence);

  console.log('\n-- The path shifts between uploads, which is the NORMAL case for PDFs --');
  // Measured on two real consecutive months of the same client: only 8 of 49 paths matched, and
  // 23 of the 34 shared labels sat at a different path, because the vision model assigns
  // hierarchy levels differently between renderings of the same statement. When a label match
  // was flagged as unsure, memory filled in 2 lines out of 47 — effectively useless.
  hit = await recall({ user: 'u1', label: 'Advertising', path: 'Expenses > Advertising' });
  check('still recalled, by label', hit?.category === 'cac' && hit.matchedOn === 'label', JSON.stringify(hit));
  check('and TRUSTED, because the name is unambiguous', hit?.confidence === 'high', hit?.confidence);

  console.log('\n-- ...but a name used twice in one statement is not evidence --');
  hit = await recall({ user: 'u1', label: 'Advertising', path: 'Expenses > Advertising', occurrences: 2 });
  check('still applied, since it is the user own decision', hit?.category === 'cac');
  check('but flagged, because which line it referred to is unclear',
    hit?.confidence === 'needs_review' && hit?.ambiguous === true, JSON.stringify(hit));

  console.log('\n-- Re-mapping replaces the earlier choice --');
  await record({ user: 'u1', label: 'Advertising', path: 'Expenses > Marketing > Advertising', category: 'opex_systems' });
  hit = await recall({ user: 'u1', label: 'Advertising', path: 'Expenses > Marketing > Advertising' });
  check('the newest decision wins', hit?.category === 'opex_systems', hit?.category);
  const n = (await c.query(
    `SELECT count(*)::int n FROM rules WHERE user_id='u1' AND scope='category_path'`)).rows[0].n;
  check('it replaced rather than stacked a second rule', n === 1, `${n} path rule(s)`);

  console.log('\n-- Exclusions carry forward, but always pre-flagged --');
  await record({ user: 'u1', label: 'Net Other Income', path: 'Net Other Income',
                 category: 'opex_systems', status: 'excluded' });
  hit = await recall({ user: 'u1', label: 'Net Other Income', path: 'Net Other Income' });
  check('the exclusion is remembered', hit?.status === 'excluded', hit?.status);
  check('and surfaced for confirmation even on an exact path match',
    hit?.confidence === 'needs_review', hit?.confidence);

  console.log('\n-- Memory is per user --');
  await record({ user: 'u2', label: 'Advertising', path: 'Expenses > Marketing > Advertising', category: 'revenue' });
  const u1 = await recall({ user: 'u1', label: 'Advertising', path: 'Expenses > Marketing > Advertising' });
  const u2 = await recall({ user: 'u2', label: 'Advertising', path: 'Expenses > Marketing > Advertising' });
  check("one user's choice does not reach another", u1?.category === 'opex_systems' && u2?.category === 'revenue',
    `u1=${u1?.category} u2=${u2?.category}`);

  console.log('\n-- An unseen line falls through to the heuristics --');
  hit = await recall({ user: 'u1', label: 'Brand New Account', path: 'Expenses > Brand New Account' });
  check('no memory, no match', hit === null);

  console.log('\n-- The unique index actually holds --');
  let blocked = false;
  try {
    await c.query(`INSERT INTO rules (user_id, scope, scope_value, clearpath_category)
                   VALUES ('u1','category_path','Expenses > Marketing > Advertising','cac')`);
  } catch { blocked = true; }
  check('a duplicate key is rejected', blocked);
} finally {
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  console.log(`\nDropped ${SCHEMA}.`);
  await c.end();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
