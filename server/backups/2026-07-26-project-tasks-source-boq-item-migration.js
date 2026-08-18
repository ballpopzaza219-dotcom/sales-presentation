// One-off migration: adds client_project_tasks.source_boq_item_id (traceability back to the
// approved BOQ line item a task was batch-created from — see schema.sql's comment on this column,
// and server.js's GET .../available-boq-items-for-task + POST .../tasks/batch).
// Idempotent — ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-26-project-tasks-source-boq-item-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS source_boq_item_id INTEGER`,
  `ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_source_boq_item_fk`,
  `ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_source_boq_item_fk
     FOREIGN KEY (source_boq_item_id) REFERENCES client_budget_items(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_client_project_tasks_source_boq_item ON client_project_tasks(source_boq_item_id)`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');
    const check = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='client_project_tasks' AND column_name='source_boq_item_id'`
    );
    console.log('\nColumn present:', check.rowCount > 0);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
