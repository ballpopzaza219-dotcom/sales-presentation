-- ย้อนกลับ migration 0024 — คืน job_applications.hr_department เป็น free-text, ลบ client_departments/
-- client_branches ทิ้ง, แคบ client_document_audit_log.doc_type กลับเหมือนเดิม
--
-- อันตราย 2 จุดที่ต้อง guard ก่อนเสมอ:
-- 1) ถ้ามี audit log แถวใดใช้ doc_type='branch'/'department' ไปแล้ว การแคบ CHECK กลับจะทำให้แถวเหล่านั้น
--    ขัดกับ constraint ใหม่ทันที (ข้อมูลเก่าอยู่ในตารางแต่ผิด constraint ปัจจุบัน) — ต้อง RAISE EXCEPTION
--    ปฏิเสธถ้าเจอ (แบบเดียวกับ migration 0022's down.sql guard บน wht_remittance)
-- 2) ถ้ามี branch/department แถวใดถูกสร้างขึ้นจริงหลัง migration นี้ apply แล้ว (ไม่ใช่แค่ backfill ตอน
--    up) การ DROP TABLE ทิ้งจะทำให้ข้อมูลนั้นหายถาวร ไม่มีทางกู้คืน — ต้อง RAISE EXCEPTION ปฏิเสธถ้าเจอ
--    แถวที่ไม่ได้มาจาก backfill อัตโนมัติตอน up (สังเกตได้จาก code ที่ไม่ตรง pattern 'DEPT-%' ที่ backfill
--    สร้างไว้ หรือง่ายกว่านั้น: เช็คแค่ว่ามีแถวเหลืออยู่เลยหรือไม่ เพราะถ้า rollback ต้องทำทันทีหลัง apply
--    โดยไม่มีใครสร้างข้อมูลจริงเพิ่มเข้ามาก่อน จำนวนแถวควรตรงกับที่ backfill สร้างไว้เป๊ะเท่านั้น)

DO $$
DECLARE
  audit_count INTEGER;
BEGIN
  SELECT count(*) INTO audit_count FROM client_document_audit_log WHERE doc_type IN ('branch','department');
  IF audit_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type IN (''branch'',''department'') อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0024 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มีสองค่านี้', audit_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance'));

-- คืน hr_department เป็น free-text จากชื่อ department ที่ผูกอยู่ (ถ้ามี) — ก่อน DROP ตาราง
ALTER TABLE job_applications ADD COLUMN hr_department TEXT NOT NULL DEFAULT '';
UPDATE job_applications ja
SET hr_department = cd.name
FROM client_departments cd
WHERE cd.id = ja.department_id;

ALTER TABLE job_applications DROP CONSTRAINT fk_job_applications_department;
ALTER TABLE job_applications DROP COLUMN department_id;

-- Guard: ปฏิเสธ rollback ถ้ามีแถว branch/department ที่ "ดูเหมือน" ถูกสร้างขึ้นเองหลัง migration (ไม่ตรง
-- รูปแบบ code ที่ backfill อัตโนมัติสร้างไว้ตอน up.sql คือ 'DEPT-%') — ป้องกันการลบข้อมูลจริงที่ผู้ใช้กรอก
-- เองทิ้งไปเงียบๆ โดยไม่รู้ตัว (branches ไม่มี backfill อัตโนมัติเลยตั้งแต่ up.sql จึงแถวใดๆ ก็ถือว่าเป็น
-- ข้อมูลจริงที่ต้องกันไว้ทั้งหมด)
DO $$
DECLARE
  branch_count INTEGER;
  manual_dept_count INTEGER;
BEGIN
  SELECT count(*) INTO branch_count FROM client_branches;
  IF branch_count > 0 THEN
    RAISE EXCEPTION 'มีแถว client_branches อยู่จริง % แถว (migration นี้ไม่เคย backfill branch ใดๆ เองเลย ทุกแถวคือข้อมูลจริงที่ผู้ใช้กรอก) — ต้องย้าย/ลบข้อมูลด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', branch_count;
  END IF;
  SELECT count(*) INTO manual_dept_count FROM client_departments WHERE code NOT LIKE 'DEPT-%';
  IF manual_dept_count > 0 THEN
    RAISE EXCEPTION 'มีแถว client_departments ที่ code ไม่ตรงรูปแบบ backfill อัตโนมัติ (DEPT-%%) อยู่ % แถว — น่าจะเป็นข้อมูลที่สร้างเพิ่มเองหลัง migration นี้ apply แล้ว ต้องย้าย/ลบก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', manual_dept_count;
  END IF;
END $$;

DROP TABLE client_departments;
DROP TABLE client_branches;

