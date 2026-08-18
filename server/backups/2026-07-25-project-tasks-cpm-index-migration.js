// One-off migration: adds idx_cptd_depends_on (see schema.sql, "แผนงาน (Gantt) — Phase 1" section,
// index added for Phase 2's CPM backward-pass/cycle-check reverse lookups) to the live DB.
// Idempotent — CREATE INDEX IF NOT EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-25-project-tasks-cpm-index-migration.js

const pool = require('../db');

(async () => {
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_cptd_depends_on ON client_project_task_dependencies(depends_on_task_id)');
    console.log('OK: idx_cptd_depends_on created (or already existed)');
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_cptd_depends_on'`);
    console.log('Index present:', idx.rowCount > 0);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
