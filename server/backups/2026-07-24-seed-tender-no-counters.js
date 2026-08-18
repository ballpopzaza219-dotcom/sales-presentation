// One-off migration: creates company_document_counters (see schema.sql) on the live DB and seeds its
// 'tender' counter for every company that already has client_tenders rows, so the just-fixed
// generateTenderNo (server.js) never reissues a number lower than what's already been used.
//
// For company 13 specifically, the seed also accounts for tender_no values that were ISSUED but no
// longer exist as rows (TDR-2569-0001..0010, deleted 2026-07-24 — see
// server/backups/2026-07-24-tender-cleanup-backup-*.json — and TDR-2569-0013, created then deleted by
// tests/tender-double-submit.regression.js's own cleanup) — a plain "MAX of current rows" seed would
// have missed those and could still collide. For every other company, seeding from current rows alone
// is correct (nothing else is known to have been deleted for them).
//
// Idempotent: uses ON CONFLICT DO NOTHING, safe to re-run.
// Run once: cd server && node backups/2026-07-24-seed-tender-no-counters.js

const pool = require('../db');

// Known historical max for company 13 specifically (see comment above) — everything else is derived
// from currently-existing rows.
const KNOWN_HISTORICAL_MAX = { 13: 13 };

(async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_document_counters (
        company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (company_id, doc_type)
      )
    `);
    console.log('company_document_counters table ensured.');

    const companies = await client.query(
      `SELECT company_id, MAX((regexp_match(tender_no, '(\\d+)$'))[1]::int) AS max_seq
       FROM client_tenders
       WHERE tender_no ~ '\\d+$'
       GROUP BY company_id`
    );

    await client.query('BEGIN');
    let seeded = 0;
    for (const row of companies.rows) {
      const seedValue = Math.max(row.max_seq, KNOWN_HISTORICAL_MAX[row.company_id] || 0);
      const r = await client.query(
        `INSERT INTO company_document_counters (company_id, doc_type, next_seq)
         VALUES ($1, 'tender', $2)
         ON CONFLICT (company_id, doc_type) DO NOTHING
         RETURNING company_id, next_seq`,
        [row.company_id, seedValue]
      );
      if (r.rowCount > 0) {
        seeded++;
        console.log(`  company ${row.company_id}: seeded next_seq=${seedValue} (current-rows max=${row.max_seq}${KNOWN_HISTORICAL_MAX[row.company_id] ? `, known historical max=${KNOWN_HISTORICAL_MAX[row.company_id]}` : ''})`);
      } else {
        console.log(`  company ${row.company_id}: counter already exists, left untouched`);
      }
    }
    await client.query('COMMIT');
    console.log(`\nDone. Seeded ${seeded} company counter(s).`);

    const check = await pool.query(`SELECT * FROM company_document_counters ORDER BY company_id`);
    console.log('\nFinal company_document_counters state:', JSON.stringify(check.rows));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
