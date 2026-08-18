// One-off migration: creates the "แผนงาน" (Gantt Phase 1) tables — client_project_tasks,
// client_project_task_dependencies, client_project_task_baseline — on the live DB. See schema.sql's
// "แผนงาน (Gantt) — Phase 1" section for the annotated version of these same statements.
// Idempotent — CREATE TABLE IF NOT EXISTS / DROP CONSTRAINT IF EXISTS throughout, safe to re-run.
// Run once: cd server && node backups/2026-07-25-project-tasks-schema-migration.js

const pool = require('../db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_project_tasks (
     id SERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
     project_id INTEGER NOT NULL,
     parent_task_id INTEGER,
     wbs_code TEXT NOT NULL DEFAULT '',
     task_name TEXT NOT NULL,
     duration_days INTEGER NOT NULL DEFAULT 1,
     start_date DATE,
     end_date DATE,
     percent_complete INTEGER NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
     is_milestone BOOLEAN NOT NULL DEFAULT false,
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES customers(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'client_project_tasks_company_id_id_key' AND conrelid = 'client_project_tasks'::regclass
     ) THEN
       ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_company_id_id_key UNIQUE (company_id, id);
     END IF;
   END $$`,
  `ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_project_fk`,
  `ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_project_fk
     FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id) ON DELETE CASCADE`,
  `ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_parent_fk`,
  `ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_parent_fk
     FOREIGN KEY (company_id, parent_task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_client_project_tasks_project ON client_project_tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_project_tasks_parent ON client_project_tasks(parent_task_id)`,

  `CREATE TABLE IF NOT EXISTS client_project_task_dependencies (
     id SERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
     task_id INTEGER NOT NULL,
     depends_on_task_id INTEGER NOT NULL,
     dependency_type TEXT NOT NULL DEFAULT 'FS' CHECK (dependency_type IN ('FS','SS','FF','SF')),
     lag_days INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     CHECK (task_id <> depends_on_task_id),
     UNIQUE (task_id, depends_on_task_id)
   )`,
  `ALTER TABLE client_project_task_dependencies DROP CONSTRAINT IF EXISTS cptd_task_fk`,
  `ALTER TABLE client_project_task_dependencies ADD CONSTRAINT cptd_task_fk
     FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE`,
  `ALTER TABLE client_project_task_dependencies DROP CONSTRAINT IF EXISTS cptd_depends_on_fk`,
  `ALTER TABLE client_project_task_dependencies ADD CONSTRAINT cptd_depends_on_fk
     FOREIGN KEY (company_id, depends_on_task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_cptd_task ON client_project_task_dependencies(task_id)`,

  `CREATE TABLE IF NOT EXISTS client_project_task_baseline (
     id SERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
     task_id INTEGER NOT NULL UNIQUE,
     baseline_start DATE,
     baseline_end DATE,
     baseline_set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     set_by INTEGER REFERENCES customers(id)
   )`,
  `ALTER TABLE client_project_task_baseline DROP CONSTRAINT IF EXISTS cptb_task_fk`,
  `ALTER TABLE client_project_task_baseline ADD CONSTRAINT cptb_task_fk
     FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 100));
    }
    console.log('\nMigration complete.');

    const tables = await pool.query(
      `SELECT to_regclass('client_project_tasks') AS tasks,
              to_regclass('client_project_task_dependencies') AS deps,
              to_regclass('client_project_task_baseline') AS baseline`
    );
    console.log('\nTables present:', JSON.stringify(tables.rows[0], null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
