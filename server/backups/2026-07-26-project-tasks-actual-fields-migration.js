// One-off migration: adds client_project_tasks.actual_start_date/actual_end_date/actual_amount/
// actual_percent — a per-task ผลงาน (actual) snapshot shown alongside the existing แผนงาน columns
// (duration_days/start_date/end_date/budget_amount) in the Task table on the แผนงาน page. Distinct
// from client_project_task_periods' per-day planned/actual % grid (that one drives the time grid and
// S-curve chart; these four are a single manually-entered per-task summary).
// actual_duration_days is NOT a column — always derived from actual_end_date - actual_start_date + 1.
// See schema.sql's comment on these columns and server.js's serializeTask()/CLIENT_PROJECT_TASK_SELECT.
// Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-26-project-tasks-actual-fields-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_start_date DATE`,
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_end_date DATE`,
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_amount NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_percent NUMERIC NOT NULL DEFAULT 0 CHECK (actual_percent >= 0 AND actual_percent <= 100)`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');
    const check = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='client_project_tasks' AND column_name IN ('actual_start_date','actual_end_date','actual_amount','actual_percent') ORDER BY column_name`
    );
    console.log('\nColumns present:', check.rows.map(r => r.column_name).join(', '));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
