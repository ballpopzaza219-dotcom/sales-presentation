-- เพิ่ม doc_type='advance' แยกจาก 'petty_cash' สำหรับสิทธิ์อนุมัติใบเงินทดรองจ่าย (ข้อ 1.2) — ตกลงกับ
-- ผู้ใช้แล้วว่าไม่ใช้ปนกับ petty_cash เพราะเป็นคนละเรื่องกันจริง (เบิกเงินสดย่อยใช้จ่ายทันทีจากกองทุนที่มี
-- เพดาน vs เบิกเงินทดรองจ่ายที่ยังไม่ใช่ค่าใช้จ่ายจนกว่าจะเคลียร์ในข้อ 1.3 และไม่ผูกกับกองทุนใดๆ เลย) —
-- ตาม CLAUDE.md ข้อ 14 (แยกสิทธิ์ตามประเภทธุรกรรมชัดเจน ไม่ใช้ flag เดียวทำสองอย่าง)
--
-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION เหมือนตอนเพิ่มรหัสบัญชี (1170/2120) เพราะนี่คือการ "ขยาย"
-- CHECK ที่มีอยู่แล้วให้กว้างขึ้น (ไม่ใช่สร้างข้อมูลใหม่ที่ต้องกันชนกับของเดิม) — DROP+ADD คืนค่าเดิมได้
-- ตรงๆ เสมอถ้ายังไม่มีแถวไหนใช้ค่า 'advance' จริงตอน rollback (เหตุผลเดียวกับที่ 0001 ขยาย
-- client_journal_entries_source_type_check ไม่มี guard เช่นกัน)
ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance'));

ALTER TABLE customers ADD COLUMN can_approve_advance BOOLEAN NOT NULL DEFAULT false;
