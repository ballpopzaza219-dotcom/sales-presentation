-- rollback 0014 — guard ทุกจุดก่อน DROP/DROP COLUMN/แคบ CHECK กลับ (ทดสอบ up->down->up->down พร้อมข้อมูล
-- จริงก่อน apply เสมอตาม CLAUDE.md ข้อ 15, เหตุผลเดียวกับ 0005/0007/0010/0012)
--
-- ลำดับสำคัญ: ต้อง DROP client_progress_claims (และตารางลูก) ก่อน ถึงจะไปแก้ client_project_installments
-- ได้ (มี composite FK จาก client_progress_claims.installment_id ชี้มาที่ UNIQUE(company_id,id) ของตาราง
-- นั้นอยู่ — DROP CONSTRAINT UNIQUE ก่อนตารางลูกจะพังด้วย "other objects depend on it")

DO $$
DECLARE
  claim_count INTEGER;
  audit_count INTEGER;
  rule_count INTEGER;
  applied_amount_count INTEGER;
  claimed_percent_count INTEGER;
  flag_count INTEGER;
  coa_2160_used_count INTEGER;
BEGIN
  -- ไม่ต้องเช็ค client_progress_claim_items/client_revenue_advance_applications แยกต่างหาก — ทั้งสองตาราง
  -- มี composite FK บังคับให้ต้องมี client_progress_claims แถวแม่อยู่จริงเสมอ (items ผ่าน ON DELETE CASCADE,
  -- applications ผ่าน FK ธรรมดาที่ block การลบแม่อยู่แล้วถ้ายังมีลูกอ้างอิง) เช็ค claim_count ตัวเดียวก็ครอบคลุม
  -- กรณีมีข้อมูลจริงในตารางลูกทั้งคู่แล้ว (พิสูจน์จริงจากการทดสอบ up->down->up->down ด้านล่าง)
  SELECT COUNT(*) INTO claim_count FROM client_progress_claims;
  IF claim_count > 0 THEN
    RAISE EXCEPTION 'มีใบขอเบิกความคืบหน้า % แถวอยู่จริงใน client_progress_claims (หรือมีรายการย่อย/ประวัติหักล้างเงินล่วงหน้าที่อ้างอิงถึง) — rollback migration 0014 จะ DROP TABLE ทิ้งทั้งก้อน ข้อมูลจะหายถาวร ต้อง export/ย้ายข้อมูลออกก่อน', claim_count;
  END IF;

  SELECT COUNT(*) INTO audit_count FROM client_document_audit_log WHERE doc_type = 'progress_claim';
  IF audit_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type=''progress_claim'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มีค่านี้', audit_count;
  END IF;

  SELECT COUNT(*) INTO rule_count FROM client_pr_approval_rules WHERE doc_type = 'progress';
  IF rule_count > 0 THEN
    RAISE EXCEPTION 'มีเพดานอนุมัติ % แถวที่ doc_type=''progress'' อยู่แล้วจริงใน client_pr_approval_rules — ต้องลบ/ปิดใช้งาน rule เหล่านั้นก่อน rollback', rule_count;
  END IF;

  SELECT COUNT(*) INTO applied_amount_count FROM client_revenue WHERE applied_amount <> 0;
  IF applied_amount_count > 0 THEN
    RAISE EXCEPTION 'มีรายรับ % แถวที่ applied_amount <> 0 อยู่จริง — rollback จะ DROP COLUMN client_revenue.applied_amount ทิ้ง ทำให้ประวัติการหักล้างเงินล่วงหน้าหายไป', applied_amount_count;
  END IF;

  SELECT COUNT(*) INTO claimed_percent_count FROM client_budget_items WHERE claimed_percent <> 0;
  IF claimed_percent_count > 0 THEN
    RAISE EXCEPTION 'มีบรรทัด BOQ % แถวที่ claimed_percent <> 0 อยู่จริง — rollback จะ DROP COLUMN client_budget_items.claimed_percent ทิ้ง ทำให้ประวัติเปอร์เซ็นต์ที่เบิกไปแล้วหายไป', claimed_percent_count;
  END IF;

  SELECT COUNT(*) INTO flag_count FROM customers WHERE can_certify_progress = true OR can_approve_progress = true;
  IF flag_count > 0 THEN
    RAISE EXCEPTION 'มีผู้ใช้ % คนที่ตั้งค่า can_certify_progress/can_approve_progress=true อยู่จริง — rollback จะ DROP COLUMN ทิ้ง ทำให้การให้สิทธิ์เหล่านี้หายไป', flag_count;
  END IF;

  SELECT COUNT(*) INTO coa_2160_used_count FROM client_journal_entry_lines WHERE account_code = '2160';
  IF coa_2160_used_count > 0 THEN
    RAISE EXCEPTION 'มีรายการบัญชี % แถวที่ผูกกับรหัสบัญชี 2160 (เงินรับล่วงหน้าจากลูกค้า) อยู่จริงใน client_journal_entry_lines — rollback จะลบผังบัญชีนี้ทิ้ง ทำให้รายการเหล่านั้นอ้างอิงบัญชีที่ไม่มีอยู่จริง', coa_2160_used_count;
  END IF;
END $$;

-- ต้อง DROP ตารางใหม่ (client_progress_claims และลูก) ก่อนเสมอ — มี composite FK ไปหา
-- client_project_installments ที่กำลังจะถูกแก้ด้านล่าง ถ้าสลับลำดับจะ DROP CONSTRAINT UNIQUE ไม่ได้
DROP TABLE client_revenue_advance_applications;
DROP TABLE client_progress_claim_items;
DROP TABLE client_progress_claims;

ALTER TABLE client_project_installments DROP CONSTRAINT client_project_installments_company_id_id_key;

ALTER TABLE client_budget_items DROP CONSTRAINT client_budget_items_claimed_percent_bounds_check;
ALTER TABLE client_budget_items DROP COLUMN claimed_percent;

ALTER TABLE client_revenue DROP CONSTRAINT client_revenue_applied_amount_bounds_check;
ALTER TABLE client_revenue DROP COLUMN applied_amount;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term'));

ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance','other'));

ALTER TABLE customers DROP COLUMN can_certify_progress;
ALTER TABLE customers DROP COLUMN can_approve_progress;

DELETE FROM client_chart_of_accounts WHERE company_id IN (SELECT id FROM customer_companies) AND code = '2160';
