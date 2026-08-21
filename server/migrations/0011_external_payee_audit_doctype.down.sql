-- Rollback for 0011_external_payee_audit_doctype.up.sql
--
-- ⚠️ guard: ถ้ามีแถว doc_type='external_payee' อยู่จริง ต้อง rollback ไม่ได้ — เหตุผลเดียวกับ guard ใน
-- 0010_subcontractor_audit_doctype.down.sql เป๊ะๆ (ดูคอมเมนต์ที่นั่นสำหรับคำอธิบายเต็ม: ปล่อยให้ DROP+ADD
-- constraint ผ่านไปเงียบๆ จะทำให้แถวที่มีอยู่แล้วขัดกับ CHECK ใหม่ที่แคบกว่าเดิมทันทีตอน ALTER TABLE —
-- statement จะพังอยู่ดี แค่ error message ดิบจาก Postgres จะไม่บอกตรงๆ ว่าต้องทำอะไรต่อ)
DO $$
DECLARE
  usage_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO usage_count FROM client_document_audit_log WHERE doc_type = 'external_payee';
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type=''external_payee'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0011 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มี ''external_payee''', usage_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor'));
