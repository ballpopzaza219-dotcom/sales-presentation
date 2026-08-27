-- Rollback for 0017_goods_receipts_batch.up.sql — reverses in strict reverse-dependency order.
-- ต้องพังถ้ามีข้อมูลจริงอยู่ (ใบตรวจรับของ หรือ user ที่เปิด flag ไว้แล้ว) — DROP TABLE ของ Postgres ไม่
-- เตือน/บล็อกให้เองถ้ามีข้อมูลอยู่ (ต่างจากการ narrow CHECK ที่ Postgres validate แถวเดิมให้อัตโนมัติ)
-- จึงต้อง guard เองก่อนเสมอ ตามรูปแบบเดียวกับ 0014/0015 — ไม่ต้อง guard client_goods_receipt_attachments
-- แยกต่างหาก เพราะ ON DELETE CASCADE + composite FK ไปที่ client_goods_receipts ทำให้ guard ของตารางแม่
-- ครอบคลุมอยู่แล้ว (ทดสอบยืนยันจริงก่อน apply เหมือนที่เคยทำกับ retention_release_items ตอนหัวข้อ 2)

DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM client_goods_receipts;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'ยกเลิก migration 0017 ไม่ได้: มีข้อมูลใบตรวจรับของอยู่จริง % แถว (ต้องลบ/ย้ายข้อมูลก่อน)', cnt;
  END IF;
END $$;

DO $$
DECLARE cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM customers WHERE can_submit_goods_receipt = true;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'ยกเลิก migration 0017 ไม่ได้: มี user ที่เปิด can_submit_goods_receipt=true อยู่จริง % คน (ต้องปิดสิทธิ์ก่อน)', cnt;
  END IF;
END $$;

DROP TABLE client_goods_receipt_attachments;
DROP TABLE client_goods_receipt_items;
DROP TABLE client_goods_receipts;
ALTER TABLE customers DROP COLUMN can_submit_goods_receipt;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term'));
