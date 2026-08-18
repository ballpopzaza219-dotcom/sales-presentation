-- เพิ่ม 3 flag สิทธิ์ "จัดการ/ดำเนินการ" แยกจากสิทธิ์ "อนุมัติ" ตาม CLAUDE.md ข้อ 14 — มาแทนที่การจำกัด
-- ไว้ที่ super_user อย่างเดียวชั่วคราวใน 3 จุดของ server.js (hasPrItemActionPermission,
-- hasPettyCashAdminPermission, POST /advance-clearances/:id/settle) โดย super_user ยังคงทำได้ทุกอย่าง
-- เสมอ — โค้ดจะเช็คควบคู่กับ role==='super_user' (OR กัน) ไม่ใช่แทนที่การเช็ค super_user

-- can_manage_po — ดำเนินการ consume/release/cancel-qty รายการใบขอซื้อ (ข้อ 4.4) คนละหน้าที่กับ
-- can_approve_pr (อนุมัติใบขอซื้อ) โดยเจตนา: ผู้อนุมัติใบขอซื้อไม่ควรมีสิทธิ์ตัดยอด PO เองอัตโนมัติ
ALTER TABLE customers ADD COLUMN can_manage_po BOOLEAN NOT NULL DEFAULT false;

-- can_manage_petty_cash_fund — ตั้งค่า/แก้เพดานกองทุนเงินสดย่อย (client_petty_cash_funds) คนละหน้าที่
-- กับ can_approve_petty_cash (อนุมัติใบเบิก) โดยเจตนา: กันไม่ให้คนอนุมัติใบเบิกขึ้นเพดานกองทุนเองแล้ว
-- อนุมัติใบเบิกของตัวเองได้ไม่จำกัด (ทำให้เพดานใน client_pr_approval_rules ไร้ผล)
ALTER TABLE customers ADD COLUMN can_manage_petty_cash_fund BOOLEAN NOT NULL DEFAULT false;

-- can_settle_cash — บันทึกการจ่าย/รับเงินส่วนต่างจริงตอนเคลียร์เงินทดรองจ่าย (advance clearance
-- /settle) คนละหน้าที่กับ can_approve_advance (อนุมัติเคลียร์) โดยเจตนา: คนยืนยันยอดค่าใช้จ่ายถูกต้อง
-- ไม่ควรเป็นคนเดียวกับคนจ่าย/รับเงินส่วนต่างจริงเสมอไป
ALTER TABLE customers ADD COLUMN can_settle_cash BOOLEAN NOT NULL DEFAULT false;

-- เพิ่ม doc_type='user_permission' ใน client_document_audit_log — endpoint จัดการสิทธิ์ใหม่ (ข้อ 4)
-- ต้องเรียก writeAuditLog() ทุกครั้งที่แก้ 3 flag ข้างบน ตาม CLAUDE.md ข้อ 9 (ทุกการเปลี่ยนสถานะเอกสาร
-- ต้องมี audit log) — ในที่นี้ doc_id คือ customers.id ของผู้ใช้ที่ถูกแก้ไขสิทธิ์ (ไม่ใช่เอกสารธุรกรรม
-- เหมือน doc_type อื่นๆ แต่ยังใช้ตาราง audit log กลางเดียวกัน ไม่แยกตารางใหม่)
-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION เหมือนตอนเพิ่มรหัสบัญชีใหม่ (0003/0005) เพราะนี่คือการ
-- "ขยาย" CHECK ที่มีอยู่แล้วให้กว้างขึ้น (ไม่ใช่สร้างข้อมูลใหม่ที่ต้องกันชนกับของเดิม) — เหตุผลเดียวกับ
-- 0004 ที่ขยาย client_pr_approval_rules_doc_type_check โดยไม่มี guard
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission'));
