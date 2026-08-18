-- Rollback for 0004_advance_approval_doctype.up.sql — reverses in strict reverse-dependency order.
-- จะพังถ้ามีแถว client_pr_approval_rules ที่ doc_type='advance' อยู่จริงตอน rollback (ตั้งใจให้พัง
-- ชัดเจนแบบนั้น ดีกว่าเงียบๆ ลบกฎอนุมัติของผู้ใช้จริงทิ้งไปโดยไม่รู้ตัว) — ต้องลบ/ย้ายแถวเหล่านั้นเองก่อน

ALTER TABLE customers DROP COLUMN can_approve_advance;

ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash'));
