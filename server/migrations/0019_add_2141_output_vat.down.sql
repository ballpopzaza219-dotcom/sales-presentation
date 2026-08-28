-- Rollback for 0019_add_2141_output_vat.up.sql
--
-- ⚠️ guard: ถ้ามี journal entry line ใดๆ อ้างอิงบัญชี 2141 อยู่แล้วจริง ต้อง rollback ไม่ได้ — ตรงกับ
-- วินัยเดิมของ 0005 (บัญชี 2110): DELETE รหัสบัญชีที่ยังมี journal line ผูกอยู่จริงจะชน FK
-- client_jel_account_fk อยู่ดี (Postgres บังคับเอง) แต่ guard นี้ให้ error message อ่านรู้เรื่องแทน
DO $$
DECLARE
  usage_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO usage_count FROM client_journal_entry_lines WHERE account_code = '2141';
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มี journal entry line % แถวอ้างอิงบัญชี 2141 (ภาษีขาย) อยู่แล้วจริง — ต้องจัดการ/ย้ายรายการเหล่านั้นก่อน rollback migration 0019', usage_count;
  END IF;
END $$;

DELETE FROM client_chart_of_accounts
WHERE company_id IN (SELECT id FROM customer_companies) AND code = '2141';
