-- Rollback for 0003_pr_batch3_advance_clearance_prep.up.sql — reverses every change in strict
-- reverse-dependency order, RESTRICT-safe (same discipline as 0001/0002's down.sql).

DROP INDEX uq_client_journal_entries_reverses_entry_id;

ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_reverses_entry_id_fk;
ALTER TABLE client_journal_entries DROP COLUMN reverses_entry_id;
-- ⚠️ ก่อน DROP บรรทัดถัดไป ต้องเช็คก่อนเสมอว่ามี migration รุ่นหลัง 0003 เอา
-- client_journal_entries_company_id_id_key ไป composite-FK ต่อหรือยัง (constraint นี้เปิดทางให้ตารางอื่น
-- ในอนาคต FK มาหา client_journal_entries(company_id,id) ได้ ไม่ได้ใช้แค่กับ reverses_entry_id ตัวเดียว) —
-- ถ้ามี migration หลังจากนี้พึ่ง constraint นี้อยู่ ต้อง rollback migration นั้นก่อนเสมอ ไม่งั้น DROP
-- บรรทัดนี้จะพังทันที (Postgres ปฏิเสธ DROP constraint ที่มี FK อื่นอ้างอิงอยู่โดยไม่ใช้ CASCADE — ซึ่งไฟล์
-- นี้ตั้งใจไม่ใช้ CASCADE อยู่แล้วตามหลัก RESTRICT-safe ที่บันทึกไว้ด้านบน)
ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_company_id_id_key;

ALTER TABLE client_wht_certificates DROP COLUMN wht_income_type_name_snapshot;
ALTER TABLE client_wht_certificates DROP COLUMN wht_income_type_code;

ALTER TABLE client_advance_clearance_items DROP COLUMN wht_income_type_code;

DROP TABLE client_wht_income_types RESTRICT;

ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_settlement_required_check;
ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_settlement_recorded_by_fk;
ALTER TABLE client_advance_clearances DROP COLUMN settlement_recorded_at;
ALTER TABLE client_advance_clearances DROP COLUMN settlement_recorded_by;
ALTER TABLE client_advance_clearances DROP COLUMN settlement_ref;
ALTER TABLE client_advance_clearances DROP COLUMN settlement_channel;
ALTER TABLE client_advance_clearances DROP COLUMN settlement_date;

ALTER TABLE client_petty_cash_replenishments DROP COLUMN rejected_reason;

-- ปลอดภัยที่จะ DELETE แบบนี้เพราะ up.sql มี guard (DO block RAISE EXCEPTION) พิสูจน์ไว้แล้วว่าไม่มี
-- บริษัทไหนมีรหัส 1170/2120 อยู่ก่อน migration นี้ apply — ทุกแถวที่มีรหัสนี้ตอนนี้มาจาก migration นี้
-- เท่านั้น ยังคง scope ด้วย company_id ไว้อย่างชัดเจนตาม convention ของทั้งไฟล์
DELETE FROM client_chart_of_accounts
WHERE company_id IN (SELECT id FROM customer_companies) AND code IN ('1170','2120');
