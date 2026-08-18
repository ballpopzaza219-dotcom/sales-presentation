// One-off migration: applies the "เพิ่มโครงการ" form-expansion schema changes (see schema.sql,
// "PM: Project detail fields" section) to the live DB. Idempotent — every statement uses
// IF NOT EXISTS / DROP CONSTRAINT IF EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-25-project-detail-fields-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS bidding_method TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS sector_type TEXT`,
  `ALTER TABLE client_projects DROP CONSTRAINT IF EXISTS client_projects_sector_type_check`,
  `ALTER TABLE client_projects ADD CONSTRAINT client_projects_sector_type_check
     CHECK (sector_type IS NULL OR sector_type IN ('government', 'private'))`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS reference_price NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS phone_number TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS site_coordinates TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS submission_open_date DATE`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS submission_conditions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS installment_count INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS client_project_installments (
     id SERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
     project_id INTEGER NOT NULL,
     installment_no INTEGER NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     amount NUMERIC NOT NULL DEFAULT 0,
     days_to_complete INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_client_project_installments_project ON client_project_installments(project_id)`,
  `ALTER TABLE client_project_installments DROP CONSTRAINT IF EXISTS client_project_installments_project_fk`,
  `ALTER TABLE client_project_installments ADD CONSTRAINT client_project_installments_project_fk
     FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id) ON DELETE CASCADE`,
];

(async () => {
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      console.log('OK:', sql.trim().split('\n')[0].slice(0, 90));
    }
    console.log('\nMigration complete.');

    const cols = await pool.query(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_name='client_projects' AND column_name IN
       ('bidding_method','sector_type','reference_price','phone_number','site_coordinates',
        'submission_open_date','submission_conditions','installment_count')
       ORDER BY column_name`
    );
    console.log('\nclient_projects new columns:', JSON.stringify(cols.rows, null, 2));
    const tableCheck = await pool.query(`SELECT to_regclass('client_project_installments') AS exists`);
    console.log('client_project_installments exists:', tableCheck.rows[0].exists !== null);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
