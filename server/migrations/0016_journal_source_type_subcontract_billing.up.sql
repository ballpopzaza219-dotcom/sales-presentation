-- Migration 0016: เพิ่ม 'subcontract_billing' เข้า client_journal_entries.source_type
--
-- เหตุผล (จากข้อทักท้วงของผู้ใช้หลัง migration 0015): journal ที่สร้างจาก
-- POST /api/customer/subcontract-billings/:id/approve เดิมใช้ sourceType='manual' ซึ่งผิดหลักการที่
-- ยึดมาตลอดทั้งเซสชันนี้ — 'manual' สงวนไว้เฉพาะรายการที่คนบันทึกเองด้วยมือจริงๆ ไม่ใช่รายการที่ระบบสร้าง
-- อัตโนมัติจากเอกสาร ทุกโมดูลเบิกจ่าย/รับเงินอื่นในระบบมี source_type เฉพาะของตัวเอง (payment_voucher,
-- advance_clearance, petty_cash_replenishment) การใช้ 'manual' ปนกับรายการอัตโนมัติทำให้รายงานที่กรอง
-- source_type='manual' เพื่อดู "รายการที่คนบันทึกเอง" (จุดที่ผู้ตรวจสอบสนใจที่สุด) มีรายการอัตโนมัติปนเข้ามา
-- — source_id ชี้กลับไปตาราง client_subcontract_billings ได้แม่นยำก็จริง แต่ต้องรู้ก่อนว่า source_type ค่า
-- ไหนชี้ไปตารางไหน ซึ่งเป็นหน้าที่ของ source_type เอง ไม่ใช่ source_id

ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_source_type_check;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_source_type_check
  CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment',
                          'payment_voucher','advance_clearance','petty_cash_replenishment','subcontract_billing'));
