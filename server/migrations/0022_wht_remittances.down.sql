-- Rollback for 0022_wht_remittances.up.sql

DO $$
DECLARE remittance_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO remittance_count FROM client_wht_remittances;
  IF remittance_count > 0 THEN
    RAISE EXCEPTION 'มีการนำส่งภาษีหัก ณ ที่จ่ายบันทึกไว้แล้ว % ชุด — ต้องจัดการข้อมูลก่อน rollback migration 0022 (ไม่มีทางกู้คืนได้อัตโนมัติ)', remittance_count;
  END IF;
END $$;

DO $$
DECLARE audit_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO audit_count FROM client_document_audit_log WHERE doc_type = 'wht_remittance';
  IF audit_count > 0 THEN
    RAISE EXCEPTION 'มี audit log ของ doc_type=wht_remittance อยู่แล้ว % แถว — ต้องจัดการก่อน rollback migration 0022 (แคบ CHECK กลับไม่ได้ถ้ายังมีแถวใช้ค่านี้)', audit_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission'));

DROP INDEX idx_client_wht_certificates_remittance;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_remittance_id_fk;
ALTER TABLE client_wht_certificates DROP COLUMN remittance_id;

DROP TABLE client_wht_remittances;
