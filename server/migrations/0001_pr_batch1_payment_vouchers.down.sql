-- Rollback for 0001_pr_batch1_payment_vouchers.up.sql — reverses every change in strict reverse-
-- dependency order. Uses RESTRICT (not CASCADE): if any step fails because something unexpected still
-- depends on it, this ROLLBACKs the whole migration transaction instead of silently cascading away
-- data/objects this rollback wasn't told about.

ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_source_type_check;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_source_type_check
  CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment'));

-- ปลอดภัยที่จะ DELETE แบบนี้เพราะ up.sql มี guard (DO block RAISE EXCEPTION) พิสูจน์ไว้แล้วว่าไม่มี
-- บริษัทไหนมีรหัส 1110/1150 อยู่ก่อน migration นี้ apply — ทุกแถวที่มีรหัสนี้ตอนนี้มาจาก migration นี้
-- เท่านั้น ยังคง scope ด้วย company_id ไว้อย่างชัดเจนตาม convention ของทั้งไฟล์
DELETE FROM client_chart_of_accounts
WHERE company_id IN (SELECT id FROM customer_companies) AND code IN ('1110','1150');

-- ---- ลำดับ DROP TABLE: ใบไม้ก่อนราก (RESTRICT จะ error ถ้าลำดับผิด แทนที่จะเงียบๆ cascade ไปเอง) ----
DROP TABLE client_advance_clearance_attachments RESTRICT;
DROP TABLE client_advance_clearance_items RESTRICT;
DROP TABLE client_advance_clearances RESTRICT;
DROP TABLE client_payment_voucher_attachments RESTRICT;
DROP TABLE client_payment_vouchers RESTRICT;
DROP TABLE client_petty_cash_replenishments RESTRICT;
DROP TABLE client_petty_cash_funds RESTRICT;
DROP TABLE client_external_payees RESTRICT;
DROP TABLE client_wht_certificates RESTRICT;
DROP TABLE client_document_audit_log RESTRICT;
DROP TABLE client_idempotency_keys RESTRICT;
DROP TABLE client_idempotency_purge_state RESTRICT;

-- ปลอดภัยที่จะ DROP constraint นี้ตอนนี้เท่านั้น (ทุกตารางที่เคย FK มาหามัน — payment_vouchers/
-- petty_cash_replenishments/advance_clearances — ถูก DROP ไปหมดแล้วข้างบน)
ALTER TABLE customers DROP CONSTRAINT customers_company_id_id_key;
ALTER TABLE customers DROP COLUMN can_approve_petty_cash;

DROP FUNCTION normalize_payee_name(TEXT);
