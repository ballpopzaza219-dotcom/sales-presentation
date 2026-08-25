-- Rollback for 0016_journal_source_type_subcontract_billing.up.sql
--
-- ต้องพังถ้ามีแถว client_journal_entries ที่ source_type='subcontract_billing' อยู่จริงตอน rollback —
-- การ ADD CONSTRAINT ที่แคบกว่าเดิมของ Postgres จะปฏิเสธเองโดยธรรมชาติถ้ามีแถวขัดอยู่แล้ว (เหมือนกับ 0006's
-- client_wht_certificates_source_type_check — ไม่ต้องมี DO block guard แยกก็ปลอดภัยอยู่แล้วในทางเทคนิค)
-- แต่ใส่ guard ไว้ด้วยเพื่อ error message ที่ชัดเจนกว่าข้อความ default ของ Postgres (เช่นเดียวกับ
-- migration 0014/0015 ที่ใส่ guard ไว้ก่อน DROP TABLE แม้บาง DROP จะพังเองอยู่แล้วจาก FK ก็ตาม)
DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM client_journal_entries WHERE source_type = 'subcontract_billing';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'ยกเลิก migration 0016 ไม่ได้: มี client_journal_entries ที่ source_type=subcontract_billing อยู่ % แถว (ต้องลบ/ย้ายข้อมูลก่อน)', cnt;
  END IF;
END $$;

ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_source_type_check;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_source_type_check
  CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment',
                          'payment_voucher','advance_clearance','petty_cash_replenishment'));
