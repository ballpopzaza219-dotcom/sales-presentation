-- ย้อนกลับ migration 0025 — ลบ client_customers และ customer_id ออกจากทั้ง 3 ตาราง คืน audit log CHECK
-- ให้แคบกลับเหมือนเดิม
--
-- ง่ายกว่า down.sql ของ migration 0024 มาก เพราะ 0025 ไม่เคย DROP client_name/project_owner เดิมเลย —
-- ข้อมูล free-text เดิมยังอยู่ครบ ไม่ต้อง reconstruct อะไรกลับ แค่ตัดการเชื่อมโยงแบบมีโครงสร้าง (customer_id)
-- ทิ้งเท่านั้น
--
-- อันตราย 2 จุดที่ต้อง guard ก่อนเสมอ (แบบเดียวกับหลักการใน migration 0024's down.sql):
-- 1) ถ้ามี audit log แถวใดใช้ doc_type='customer' ไปแล้ว การแคบ CHECK กลับจะขัดกับข้อมูลเก่าทันที
-- 2) ถ้ามีแถว client_customers อยู่จริง (ไม่ว่าจะมาจาก backfill ตอน up หรือถูกสร้างเพิ่มเองทีหลังผ่าน backend
--    CRUD ที่จะเขียนต่อจากนี้) การ DROP TABLE ทิ้งจะทำให้ข้อมูลหายถาวร — ต่างจาก client_departments ที่
--    แยกแยะได้ด้วย pattern โค้ด 'DEPT-%', client_customers ไม่มี pattern แบบนั้นเลย (ชื่อลูกค้าเป็นข้อความ
--    อิสระทั้งหมด ไม่มีทางแยกแถว backfill กับแถวที่ผู้ใช้สร้างเองได้อัตโนมัติ) จึงต้องกันแบบระมัดระวังที่สุด
--    คือปฏิเสธ rollback ถ้ามีแถวเหลืออยู่เลยแม้แต่แถวเดียว (แบบเดียวกับ guard ของ client_branches ใน
--    migration 0024 ที่ไม่มี backfill อัตโนมัติเช่นกัน)

DO $$
DECLARE
  audit_count INTEGER;
BEGIN
  SELECT count(*) INTO audit_count FROM client_document_audit_log WHERE doc_type = 'customer';
  IF audit_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type=''customer'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0025 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มีค่านี้', audit_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance',
    'branch','department'));

ALTER TABLE client_projects DROP CONSTRAINT fk_client_projects_customer;
ALTER TABLE client_quotations DROP CONSTRAINT fk_client_quotations_customer;
ALTER TABLE client_tenders DROP CONSTRAINT fk_client_tenders_customer;

-- Guard: ปฏิเสธ rollback ถ้ามีแถว client_customers เหลืออยู่เลยแม้แต่แถวเดียว (ดูเหตุผลด้านบน)
DO $$
DECLARE
  customer_count INTEGER;
BEGIN
  SELECT count(*) INTO customer_count FROM client_customers;
  IF customer_count > 0 THEN
    RAISE EXCEPTION 'มีแถว client_customers อยู่จริง % แถว (ไม่มีทางแยกอัตโนมัติว่าแถวไหนมาจาก backfill ตอน up.sql กับแถวไหนถูกสร้างเพิ่มเองทีหลัง) — ต้องตรวจสอบและย้าย/ลบข้อมูลด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', customer_count;
  END IF;
END $$;

ALTER TABLE client_projects DROP COLUMN customer_id;
ALTER TABLE client_quotations DROP COLUMN customer_id;
ALTER TABLE client_tenders DROP COLUMN customer_id;

DROP TABLE client_customers;
