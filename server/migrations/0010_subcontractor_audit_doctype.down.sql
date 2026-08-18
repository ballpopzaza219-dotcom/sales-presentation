-- Rollback for 0010_subcontractor_audit_doctype.up.sql
--
-- ⚠️ guard: ถ้ามีแถว doc_type='subcontractor' อยู่จริง ต้อง rollback ไม่ได้ — ถ้าปล่อยให้ DROP+ADD
-- constraint ผ่านไปเงียบๆ แถวที่มี doc_type='subcontractor' อยู่แล้วจะขัดกับ CHECK เดิม (ไม่มี
-- 'subcontractor' ในรายการที่ยอมรับ) ทำให้ constraint ใหม่ (แคบกว่าเดิม) ปฏิเสธข้อมูลที่มีอยู่จริงทันทีตอน
-- ALTER TABLE (Postgres ตรวจทุกแถวที่มีอยู่แล้วตอนเพิ่ม CHECK constraint เสมอ) — แปลว่า statement จะพัง
-- อยู่ดี แต่ error message ดิบจาก Postgres จะไม่บอกตรงๆ ว่าต้องทำอะไรต่อ ใส่ guard ให้ error message
-- อ่านรู้เรื่องแทน (ปัญหาเดียวกับ status='settled' ใน 0005 และ doc_type='user_permission' ใน 0007 เป๊ะๆ —
-- endpoint /api/customer/subcontractors ใช้งานจริงแล้วจะมีแถว audit log ค้างอยู่แน่นอนทุกครั้งที่มีคน
-- สร้าง/แก้ผู้รับเหมาช่วง)
DO $$
DECLARE
  usage_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO usage_count FROM client_document_audit_log WHERE doc_type = 'subcontractor';
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type=''subcontractor'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0010 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มี ''subcontractor''', usage_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission'));
