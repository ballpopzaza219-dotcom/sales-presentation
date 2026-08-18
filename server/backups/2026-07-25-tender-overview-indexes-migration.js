// One-off migration: applies the "ภาพรวมประมูลงาน" (Tender Overview dashboard) index additions
// (see schema.sql, "Tender Overview dashboard" section) to the live DB. Idempotent — every
// statement uses IF NOT EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-25-tender-overview-indexes-migration.js

const pool = require('../db');

const STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_client_tenders_company_created ON client_tenders(company_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_tenders_upcoming_deadline
     ON client_tenders(company_id, submission_deadline)
     WHERE status IN ('preparing','submitted')`,
  `CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_pending
     ON client_budget_revisions(company_id, submitted_at)
     WHERE status='pending_approval'`,
  `CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_company_approved
     ON client_budget_revisions(company_id, approved_at DESC)`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname IN
       ('idx_client_tenders_company_created','idx_client_tenders_upcoming_deadline',
        'idx_client_budget_revisions_pending','idx_client_budget_revisions_company_approved')
       ORDER BY indexname`
    );
    console.log('\nIndexes present:', JSON.stringify(idx.rows, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
