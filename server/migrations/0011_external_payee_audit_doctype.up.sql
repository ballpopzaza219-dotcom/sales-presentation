-- เพิ่ม doc_type='external_payee' ใน client_document_audit_log — สำหรับ audit log ของการแก้ไข master
-- data ผู้รับเงินภายนอก (client_external_payees: สร้าง/แก้ไข/ปิดใช้งาน) โดยเฉพาะ
--
-- เหตุผลเดียวกับ migration 0010 (doc_type='subcontractor') เป๊ะๆ: ไม่ใช้ 'payment_voucher' ที่มีอยู่แล้ว
-- เพราะนั่นเจตนาไว้สำหรับใบจ่ายเจ้าหนี้ภายนอกจริง (เอกสาร "เงินเคลื่อนไหว") คนละประเภทเหตุการณ์กับการ
-- แก้ไขข้อมูลติดต่อ/เลขผู้เสียภาษี/อัตราหัก ณ ที่จ่ายเริ่มต้นของผู้รับเงิน (ไม่มีเงินเคลื่อนไหวเลย) — ถ้าใช้
-- ค่าเดียวกันปนกัน รายงาน audit ที่กรองด้วย doc_type='payment_voucher' ในอนาคต (เช่น "แสดงประวัติการจ่าย
-- เงินทั้งหมด") จะปนแถว "แก้ไขเลขผู้เสียภาษี" เข้ามาด้วยโดยไม่ตั้งใจ
--
-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION (นี่คือการ "ขยาย" CHECK ให้กว้างขึ้น ไม่ใช่สร้างข้อมูลใหม่ที่
-- ต้องกันชนกับของเดิม — เหตุผลเดียวกับ 0004/0007/0010 ที่ขยาย CHECK ลักษณะเดียวกันโดยไม่มี guard)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee'));
