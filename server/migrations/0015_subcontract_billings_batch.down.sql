-- rollback 0015 — guard ทุกจุดก่อน DROP/DROP COLUMN/แคบ CHECK กลับ (ทดสอบ up->down->up->down พร้อมข้อมูล
-- จริงก่อน apply เสมอตาม CLAUDE.md ข้อ 15, เหตุผลเดียวกับ 0005/0007/0010/0012/0014)

DO $$
DECLARE
  billing_count INTEGER;
  rule_count INTEGER;
  flag_count INTEGER;
  coa_used_count INTEGER;
BEGIN
  -- ไม่ต้องเช็ค client_subcontract_retention_release_items แยกต่างหาก — มี composite FK บังคับให้ต้องมี
  -- client_subcontract_billings แถวแม่อยู่จริงเสมอ (ON DELETE CASCADE จากฝั่ง retention_release_billing_id)
  -- เช็ค billing_count ตัวเดียวครอบคลุมแล้ว (พิสูจน์จริงตาม pattern เดียวกับ migration 0014's claim_count)
  SELECT COUNT(*) INTO billing_count FROM client_subcontract_billings;
  IF billing_count > 0 THEN
    RAISE EXCEPTION 'มีใบเบิกเงินตามสัญญาจ้าง % แถวอยู่จริงใน client_subcontract_billings (หรือมีรายการย่อยการคืน retention ที่อ้างอิงถึง) — rollback migration 0015 จะ DROP TABLE ทิ้งทั้งก้อน ข้อมูลจะหายถาวร ต้อง export/ย้ายข้อมูลออกก่อน', billing_count;
  END IF;

  SELECT COUNT(*) INTO rule_count FROM client_pr_approval_rules WHERE doc_type = 'subcontractor_billing';
  IF rule_count > 0 THEN
    RAISE EXCEPTION 'มีเพดานอนุมัติ % แถวที่ doc_type=''subcontractor_billing'' อยู่แล้วจริงใน client_pr_approval_rules — ต้องลบ/ปิดใช้งาน rule เหล่านั้นก่อน rollback', rule_count;
  END IF;

  SELECT COUNT(*) INTO flag_count FROM customers WHERE can_approve_subcontract_billing = true;
  IF flag_count > 0 THEN
    RAISE EXCEPTION 'มีผู้ใช้ % คนที่ตั้งค่า can_approve_subcontract_billing=true อยู่จริง — rollback จะ DROP COLUMN ทิ้ง ทำให้การให้สิทธิ์เหล่านี้หายไป', flag_count;
  END IF;

  SELECT COUNT(*) INTO coa_used_count FROM client_journal_entry_lines WHERE account_code IN ('1160','2130','2140');
  IF coa_used_count > 0 THEN
    RAISE EXCEPTION 'มีรายการบัญชี % แถวที่ผูกกับรหัสบัญชี 1160/2130/2140 อยู่จริงใน client_journal_entry_lines — rollback จะลบผังบัญชีเหล่านี้ทิ้ง ทำให้รายการเหล่านั้นอ้างอิงบัญชีที่ไม่มีอยู่จริง', coa_used_count;
  END IF;
END $$;

DROP TABLE client_subcontract_retention_release_items;
DROP TABLE client_subcontract_billings;

ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance','other','progress'));

ALTER TABLE customers DROP COLUMN can_approve_subcontract_billing;

DELETE FROM client_chart_of_accounts WHERE company_id IN (SELECT id FROM customer_companies) AND code IN ('1160','2130','2140');
