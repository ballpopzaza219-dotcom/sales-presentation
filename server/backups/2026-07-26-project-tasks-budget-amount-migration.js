// One-off migration: adds client_project_tasks.budget_amount — a SNAPSHOT of the source BOQ item's
// amount (material_amount + labor_amount) taken at pull time (POST .../tasks/batch), not a live join.
// See schema.sql's comment on this column and server.js's endpoint comment for why snapshot was
// chosen over re-querying client_budget_items on every read.
// Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-26-project-tasks-budget-amount-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS budget_amount NUMERIC NOT NULL DEFAULT 0`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');
    const check = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='client_project_tasks' AND column_name='budget_amount'`
    );
    console.log('\nColumn present:', check.rowCount > 0);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
