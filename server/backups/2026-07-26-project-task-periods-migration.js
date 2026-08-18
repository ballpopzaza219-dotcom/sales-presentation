// One-off migration: adds client_project_task_periods (แผนงาน Phase 2 — per-day แผนงาน/ผลงาน % —
// see schema.sql's comment on this table and server.js's PUT .../tasks/periods).
// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-26-project-task-periods-migration.js

const pool = require('../db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_project_task_periods (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL,
    period_date DATE NOT NULL,
    planned_percent NUMERIC NOT NULL DEFAULT 0 CHECK (planned_percent >= 0 AND planned_percent <= 100),
    actual_percent NUMERIC NOT NULL DEFAULT 0 CHECK (actual_percent >= 0 AND actual_percent <= 100),
    UNIQUE (task_id, period_date)
  )`,
  `ALTER TABLE client_project_task_periods DROP CONSTRAINT IF EXISTS cptp_task_fk`,
  `ALTER TABLE client_project_task_periods ADD CONSTRAINT cptp_task_fk
     FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_cptp_task ON client_project_task_periods(task_id)`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');
    const check = await pool.query(
      `SELECT to_regclass('client_project_task_periods') AS t`
    );
    console.log('\nTable present:', !!check.rows[0].t);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
