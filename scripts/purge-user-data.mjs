/**
 * Purges a user's financial data (project 2143).
 *
 *   railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email>
 *   railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email> --apply
 *   railway run --service ClearPathMapper node scripts/purge-user-data.mjs <email> --apply --keep-rules
 *
 * Dry run by default: it reports exactly what would go and stops.
 *
 * WHAT IS DELETED
 *   uploads            -> and, by cascade, pl_nodes, category_mappings, reports
 *   rules              -> the remembered mapping choices, unless --keep-rules
 *
 * WHAT IS DELIBERATELY KEPT
 *   users              -> the account and its email address survive a data purge. Purging
 *                         financial data is NOT account deletion and must never be conflated
 *                         with it, nor with opting out of contact. Those are separate actions.
 *   login_tokens       -> auth artefacts, not financial data. They are keyed by *email* rather
 *                         than user_id, which is worth remembering if account deletion is ever
 *                         built: a delete-by-user_id sweep would silently miss them.
 *
 * This is the command-line half of the self-serve "purge my data" control specified for Phase 4.
 * The behaviour here is the contract that control has to honour.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP_RULES = args.includes('--keep-rules');
const email = args.find(a => !a.startsWith('--'));

if (!email) {
  console.error('Usage: node scripts/purge-user-data.mjs <email> [--apply] [--keep-rules]');
  process.exit(2);
}

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

const c = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  const u = await c.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
  if (u.rows.length === 0) {
    console.error(`No account for ${email}.`);
    process.exit(2);
  }
  const userId = u.rows[0].id;

  const tally = async () => ({
    uploads: (await c.query(`SELECT count(*)::int n FROM uploads WHERE user_id=$1`, [userId])).rows[0].n,
    pl_nodes: (await c.query(
      `SELECT count(*)::int n FROM pl_nodes WHERE upload_id IN (SELECT id FROM uploads WHERE user_id=$1)`, [userId])).rows[0].n,
    category_mappings: (await c.query(
      `SELECT count(*)::int n FROM category_mappings WHERE node_id IN
        (SELECT id FROM pl_nodes WHERE upload_id IN (SELECT id FROM uploads WHERE user_id=$1))`, [userId])).rows[0].n,
    reports: (await c.query(
      `SELECT count(*)::int n FROM reports WHERE upload_id IN (SELECT id FROM uploads WHERE user_id=$1)`, [userId])).rows[0].n,
    rules: (await c.query(`SELECT count(*)::int n FROM rules WHERE user_id=$1`, [userId])).rows[0].n,
  });

  const before = await tally();
  console.log(`Account ${email} (${userId})\n`);
  console.log('Would delete:');
  console.log(`  uploads             ${before.uploads}`);
  console.log(`  pl_nodes            ${before.pl_nodes}   (by cascade)`);
  console.log(`  category_mappings   ${before.category_mappings}   (by cascade)`);
  console.log(`  reports             ${before.reports}   (by cascade)`);
  console.log(`  rules               ${KEEP_RULES ? `0   (${before.rules} kept: --keep-rules)` : before.rules}`);
  console.log('\nWould keep:');
  console.log('  the account and its email address');
  console.log('  login_tokens (auth artefacts, not financial data — you stay signed in)');

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to purge.');
    process.exit(0);
  }

  await c.query('BEGIN');
  // uploads cascades to pl_nodes -> category_mappings, and to reports.
  await c.query(`DELETE FROM uploads WHERE user_id = $1`, [userId]);
  if (!KEEP_RULES) await c.query(`DELETE FROM rules WHERE user_id = $1`, [userId]);
  await c.query('COMMIT');

  const after = await tally();
  console.log('\nAfter:', JSON.stringify(after));

  let failures = 0;
  const expectZero = KEEP_RULES
    ? ['uploads', 'pl_nodes', 'category_mappings', 'reports']
    : ['uploads', 'pl_nodes', 'category_mappings', 'reports', 'rules'];
  for (const t of expectZero) {
    const ok = after[t] === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t} is empty`);
    if (!ok) failures++;
  }
  if (KEEP_RULES) {
    const ok = after.rules === before.rules;
    console.log(`${ok ? 'PASS' : 'FAIL'}  rules preserved (${before.rules} -> ${after.rules})`);
    if (!ok) failures++;
  }
  const stillThere = (await c.query(`SELECT count(*)::int n FROM users WHERE id=$1`, [userId])).rows[0].n;
  console.log(`${stillThere === 1 ? 'PASS' : 'FAIL'}  the account itself still exists`);
  if (stillThere !== 1) failures++;

  console.log(failures === 0 ? '\nPURGE OK' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  await c.end();
}
