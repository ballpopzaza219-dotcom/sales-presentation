// One-off migration: applies the "เปิด Tender ใหม่" form-expansion schema changes (see schema.sql,
// "BD: Tender detail fields" section) to the live DB. Idempotent — every statement uses
// IF NOT EXISTS / DROP CONSTRAINT IF EXISTS, safe to re-run.
// Run once: cd server && node backups/2026-07-24-tender-detail-fields-migration.js

const pool = require('../db');

const STATEMENTS = [
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS project_no TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS bidding_method TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS sector_type TEXT`,
  `ALTER TABLE client_tenders DROP CONSTRAINT IF EXISTS client_tenders_sector_type_check`,
  `ALTER TABLE client_tenders ADD CONSTRAINT client_tenders_sector_type_check
     CHECK (sector_type IS NULL OR sector_type IN ('government', 'private'))`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS budget_amount NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS reference_price NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS phone_number TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS site_coordinates TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS submission_open_date DATE`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS submission_conditions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS installment_count INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS client_tender_installments (
     id SERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
     tender_id INTEGER NOT NULL,
     installment_no INTEGER NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     amount NUMERIC NOT NULL DEFAULT 0,
     days_to_complete INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_client_tender_installments_tender ON client_tender_installments(tender_id)`,
  `ALTER TABLE client_tender_installments DROP CONSTRAINT IF EXISTS client_tender_installments_tender_fk`,
  `ALTER TABLE client_tender_installments ADD CONSTRAINT client_tender_installments_tender_fk
     FOREIGN KEY (company_id, tender_id) REFERENCES client_tenders(company_id, id) ON DELETE CASCADE`,
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
       WHERE table_name='client_tenders' AND column_name IN
       ('project_no','bidding_method','sector_type','budget_amount','reference_price','location',
        'phone_number','site_coordinates','submission_open_date','submission_conditions','installment_count')
       ORDER BY column_name`
    );
    console.log('\nclient_tenders new columns:', JSON.stringify(cols.rows, null, 2));
    const tableCheck = await pool.query(`SELECT to_regclass('client_tender_installments') AS exists`);
    console.log('client_tender_installments exists:', tableCheck.rows[0].exists !== null);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
