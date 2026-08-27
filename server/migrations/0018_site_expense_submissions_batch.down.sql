-- Rollback for 0018_site_expense_submissions_batch.up.sql — reverses in strict reverse-dependency order.

DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM client_site_expense_submissions;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'ยกเลิก migration 0018 ไม่ได้: มีข้อมูลใบส่งบิลหน้างานอยู่จริง % แถว (ต้องลบ/ย้ายข้อมูลก่อน)', cnt;
  END IF;
END $$;

DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM customers WHERE can_submit_site_expense = true;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'ยกเลิก migration 0018 ไม่ได้: มี user ที่เปิด can_submit_site_expense=true อยู่จริง % คน (ต้องปิดสิทธิ์ก่อน)', cnt;
  END IF;
END $$;

DROP TABLE client_site_expense_attachments;
DROP TABLE client_site_expense_submissions;
ALTER TABLE customers DROP COLUMN can_submit_site_expense;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term','goods_receipt'));
