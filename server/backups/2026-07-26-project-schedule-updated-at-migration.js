// One-off migration: adds client_projects.schedule_updated_at — "วันที่ Update ล่าสุด" on the แผนงาน
// print header, touched by every task/period mutation (see server.js's touchProjectScheduleUpdatedAt()).
// Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-26-project-schedule-updated-at-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS schedule_updated_at TIMESTAMPTZ`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');
    const check = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='client_projects' AND column_name='schedule_updated_at'`
    );
    console.log('\nColumn present:', check.rowCount > 0);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
