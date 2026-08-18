-- PR Module — Batch 6: เตรียม schema สำหรับข้อ 1.4 (จ่ายเจ้าหนี้ภายนอกไม่ผ่าน PO/WO) — deferred มาจาก
-- 0003 โดยเจตนา (ตอนนั้นยังไม่ผ่านรอบวางแผนละเอียด) ตอนนี้เห็นชัดจากเคส 4.2 (มี VAT+WHT) ว่าต้องมีจริง
--
-- 1.4 ไม่มี items แยกตาราง (จ่ายครั้งเดียวจบ ไม่มีหลายบรรทัดเหมือน 1.3) จึงเพิ่มคอลัมน์ VAT/WHT ตรงบน
-- client_payment_vouchers เลย (มีความหมายเฉพาะตอน voucher_type='other' เท่านั้น — petty_cash/advance
-- ปล่อย default 0/false ไปเหมือนเดิม ไม่ใช้คอลัมน์กลุ่มนี้)

-- ---------------- (1) คอลัมน์ VAT/WHT บน client_payment_vouchers ----------------
ALTER TABLE client_payment_vouchers ADD COLUMN vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE client_payment_vouchers ADD COLUMN vat_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE client_payment_vouchers ADD COLUMN has_tax_invoice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client_payment_vouchers ADD COLUMN wht_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE client_payment_vouchers ADD COLUMN wht_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE client_payment_vouchers ADD COLUMN wht_income_type_code TEXT REFERENCES client_wht_income_types(code);
ALTER TABLE client_payment_vouchers ADD COLUMN net_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

-- กฎเดียวกับ client_advance_clearance_items_tax_invoice_check ใน 0005 เป๊ะ (เหตุผลเดียวกัน — ไม่มีใบกำกับ
-- ต้องไม่มี VAT แยกเลย ต้องรวมเข้า amount เอง)
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_tax_invoice_check
  CHECK (has_tax_invoice = true OR vat_amount = 0);

-- ---------------- (2) client_wht_certificates ต้องออกจากการจ่ายตรง (voucher) ได้ด้วย ----------------
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_source_type_check;
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_source_type_check
  CHECK (source_type IN ('advance_clearance_item','subcontractor_payment','payment_voucher'));

-- ---------------- (3) doc_type='other' แยกสิทธิ์อนุมัติจากเงินทดรองจ่าย/เงินสดย่อย ----------------
-- เหตุผลเดียวกับที่แยก 'advance' ออกจาก 'petty_cash' ใน 0004 — เงินที่จ่ายออกไปนอกบริษัทถาวร (ไม่มีทาง
-- เรียกคืน ต่างจากเงินทดรองจ่ายที่พนักงานยังต้องเคลียร์คืน) เป็นความเสี่ยงคนละระดับ ไม่ควรปนสิทธิ์กัน
ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance','other'));

ALTER TABLE customers ADD COLUMN can_approve_other BOOLEAN NOT NULL DEFAULT false;
