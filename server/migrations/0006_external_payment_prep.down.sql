-- Rollback for 0006_external_payment_prep.up.sql — reverses in strict reverse-dependency order.
-- จะพังถ้ามีแถว client_pr_approval_rules ที่ doc_type='other' หรือ client_wht_certificates ที่
-- source_type='payment_voucher' อยู่จริงตอน rollback (ตั้งใจให้พังชัดเจนแบบเดียวกับ guard สไตล์ 0004/0005
-- — Postgres จะปฏิเสธ ALTER...ADD CONSTRAINT ที่แคบกว่าเดิมถ้ามีแถวอยู่จริงที่ขัดกับ constraint ใหม่อยู่แล้ว
-- โดยธรรมชาติ ไม่ต้องมี DO block guard แยกต่างหากเหมือน 0005 เพราะ "แคบเข้า" (narrowing) ต่างจาก "DROP
-- ข้อมูลจริง" (0005's 2110/settled) ที่ DB เองไม่มีกลไกป้องกันอัตโนมัติให้)

ALTER TABLE customers DROP COLUMN can_approve_other;

ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance'));

ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_source_type_check;
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_source_type_check
  CHECK (source_type IN ('advance_clearance_item','subcontractor_payment'));

ALTER TABLE client_payment_vouchers DROP CONSTRAINT client_payment_vouchers_tax_invoice_check;
ALTER TABLE client_payment_vouchers DROP COLUMN net_amount;
ALTER TABLE client_payment_vouchers DROP COLUMN wht_income_type_code;
ALTER TABLE client_payment_vouchers DROP COLUMN wht_amount;
ALTER TABLE client_payment_vouchers DROP COLUMN wht_rate;
ALTER TABLE client_payment_vouchers DROP COLUMN has_tax_invoice;
ALTER TABLE client_payment_vouchers DROP COLUMN vat_amount;
ALTER TABLE client_payment_vouchers DROP COLUMN vat_rate;
