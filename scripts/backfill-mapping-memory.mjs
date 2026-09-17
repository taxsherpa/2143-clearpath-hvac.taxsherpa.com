/**
 * Seeds mapping memory from mappings that already exist (project 2143).
 *
 *   railway run --service ClearPathMapper node scripts/backfill-mapping-memory.mjs <uploadId>
 *   railway run --service ClearPathMapper node scripts/backfill-mapping-memory.mjs <uploadId> --apply
 *
 * Mapping memory records a choice at the moment the user makes it, so uploads mapped *before*
 * the feature shipped left no rules behind. This walks one already-mapped upload and writes the
 * rules those mappings would have written, so the next upload benefits immediately instead of
 * waiting a month.
 *
 * WHAT IT ASSUMES, STATED PLAINLY
 * -------------------------------
 * It cannot tell a mapping the user deliberately chose from one the keyword heuristics guessed
 * and nobody corrected — nothing in the schema records provenance. So it only backfills
 * mappings whose confidence is NOT `needs_review`, on the grounds that a flagged line is one
 * the system itself was unsure about and therefore poor evidence. That is a heuristic about
 * heuristics: **run the dry run first and read the list.** Anything wrong in it becomes a
 * remembered choice, and remembered choices are trusted on an exact path match.
 *
 * Existing rules are left alone. A backfill never overwrites a decision made since.
 *
 * Dry run by default. `--apply` writes.
 */
import fs from 'fs';
import pg from 'pg';

const SECRETS = 'G:/My Drive/_secure/2143-clearpath-mapper/.env';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const uploadId = args.find(a => !a.startsWith('--'));

if (!uploadId) {
  console.error('Usage: node scripts/backfill-mapping-memory.mjs <uploadId> [--apply]');
  console.error('Tip: run without an id first — the script lists your uploads if the id is unknown.');
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
  const up = await c.query(
    `SELECT id, user_id, month_start FROM uploads WHERE id = $1`, [uploadId]);
  if (up.rows.length === 0) {
    console.error(`No upload ${uploadId}.`);
    const all = await c.query(`SELECT id, month_start::date FROM uploads ORDER BY month_start`);
    console.error('Uploads on this database:');
    for (const r of all.rows) console.error(`  ${r.id}  ${r.month_start}`);
    process.exit(2);
  }
  const { user_id: userId, month_start: month } = up.rows[0];
  console.log(`Upload ${uploadId} (${new Date(month).toISOString().slice(0, 7)}), user ${userId}\n`);

  // Leaf lines only, and skip anything the system itself flagged as uncertain.
  const rows = (await c.query(`
    SELECT n.label, n.source_path, cm.clearpath_category::text AS cat,
           cm.status::text AS status, cm.confidence::text AS conf
      FROM pl_nodes n
      JOIN category_mappings cm ON cm.node_id = n.id
     WHERE n.upload_id = $1 AND n.is_rollup = 0 AND n.amount_cents IS NOT NULL
     ORDER BY n.display_order`, [uploadId])).rows;

  const usable = rows.filter(r => r.conf !== 'needs_review');
  const skipped = rows.length - usable.length;

  console.log(`${rows.length} mapped leaf lines; ${usable.length} usable, ${skipped} skipped as needs_review.\n`);
  console.log('Would remember:');
  for (const r of usable) {
    const mark = r.status === 'excluded' ? '  [EXCLUDED]' : '';
    console.log(`  ${r.cat.padEnd(22)} ${r.source_path}${mark}`);
  }
  if (skipped) {
    console.log('\nSkipped (flagged needs_review — decide these in the UI and they record themselves):');
    for (const r of rows.filter(x => x.conf === 'needs_review')) {
      console.log(`  ${r.cat.padEnd(22)} ${r.source_path}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Read the list above, then re-run with --apply.');
    process.exit(0);
  }

  let written = 0, kept = 0;
  for (const r of usable) {
    for (const [scope, value, priority] of [
      ['category_path', r.source_path, 100],
      ['category_label', r.label, 50],
    ]) {
      if (!value) continue;
      // DO NOTHING, not DO UPDATE: a backfill must never overwrite a decision made since.
      const res = await c.query(
        `INSERT INTO rules (user_id, scope, scope_value, clearpath_category, status, priority)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, scope, scope_value) DO NOTHING
         RETURNING id`,
        [userId, scope, value, r.cat, r.status, priority]);
      if (res.rows.length) written++; else kept++;
    }
  }
  console.log(`\n${written} rule(s) written, ${kept} left alone because a rule already existed.`);
  const total = (await c.query(`SELECT count(*)::int n FROM rules WHERE user_id = $1`, [userId])).rows[0].n;
  console.log(`${total} rule(s) now remembered for this user.`);
  console.log('\nMemory applies at UPLOAD time, so it will not change an upload that already exists.');
  console.log('Re-upload the next P&L to see it take effect.');
} finally {
  await c.end();
}
