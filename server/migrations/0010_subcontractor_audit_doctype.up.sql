-- เพิ่ม doc_type='subcontractor' ใน client_document_audit_log — สำหรับ audit log ของการแก้ไข master
-- data ผู้รับเหมาช่วง (client_subcontractors: สร้าง/แก้ไข/ปิดใช้งาน) โดยเฉพาะ
--
-- ทำไมไม่ใช้ 'subcontractor_payment' ที่มีอยู่แล้ว (เตรียมไว้ตั้งแต่ migration 0007): ค่านั้นเจตนาไว้สำหรับ
-- เอกสารเบิกจ่าย/งวดงานจริง (client_subcontract_billings ในอนาคต — ดู
-- server/docs/subcontractor-module-plan.md) ซึ่งเป็นเหตุการณ์ "เงินเคลื่อนไหว" คนละประเภทกับการแก้ไข
-- ข้อมูลติดต่อ/บัญชีธนาคารของผู้รับเหมา (ไม่มีเงินเคลื่อนไหวเลย) — ถ้าใช้ค่าเดียวกันปนกัน รายงาน audit
-- ที่กรองด้วย doc_type='subcontractor_payment' ในอนาคต (เช่น "แสดงประวัติการจ่ายเงินทั้งหมด") จะปนแถว
-- "แก้ไขเบอร์โทร" เข้ามาด้วยโดยไม่ตั้งใจ
--
-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION (นี่คือการ "ขยาย" CHECK ให้กว้างขึ้น ไม่ใช่สร้างข้อมูลใหม่ที่
-- ต้องกันชนกับของเดิม — เหตุผลเดียวกับ 0004/0007 ที่ขยาย CHECK ลักษณะเดียวกันโดยไม่มี guard)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor'));
