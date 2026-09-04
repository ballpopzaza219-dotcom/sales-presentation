-- PR Module — Batch 22: ระบบนำส่งภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3/53) — บันทึกเลขที่ใบเสร็จ+วันที่ชำระเป็น "ชุด"
-- ต่อ 1 งวด+1 ประเภทฟอร์ม (ธรรมชาติจริงของการยื่น — ยื่นรวมทุกใบ 50-ทวิของเดือนนั้นในครั้งเดียว ไม่ใช่แยกยื่น
-- ทีละใบ) — ตามข้อสรุปฝ่ายบัญชี (2026-08-28): เริ่มจาก Excel/CSV ทั่วไปก่อน ไม่ทำ RD Prep text-file format
-- ในรอบนี้ (ยังไม่มี spec) ทุก query ต้อง filter client_wht_certificates.status='active' เสมอ (บทเรียนจาก
-- บั๊ก wht-payable-summary ที่เจอตอนเทส /void)

CREATE TABLE client_wht_remittances (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  wht_form TEXT NOT NULL CHECK (wht_form IN ('pnd3', 'pnd53')),
  period_year_ad INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  receipt_no TEXT NOT NULL,
  paid_date DATE NOT NULL,
  -- total_wht_amount = SUM(wht_amount) ของทุกใบ 50-ทวิ (status='active') ที่ถูกผูกเข้าชุดนี้ ณ ตอนบันทึก —
  -- เก็บ snapshot ไว้ตรงๆ ไม่ join คำนวณสดทุกครั้ง เพราะถ้ามีใบถูก void ทีหลัง (ยืนยันจากฝ่ายบัญชีว่าต้อง
  -- บล็อกไว้ก่อน — ดูคอลัมน์ remittance_id ด้านล่าง) ยอดที่นำส่งจริงต้องคงที่ตามใบเสร็จจริงที่ถืออยู่ในมือ
  -- ไม่ใช่คำนวณสดที่อาจเปลี่ยนไปตามข้อมูลปัจจุบัน
  total_wht_amount NUMERIC(18,2) NOT NULL CHECK (total_wht_amount > 0),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 1 งวด + 1 ประเภทฟอร์ม ยื่นได้ครั้งเดียวเท่านั้น (ยื่นซ้ำเดือนเดียวกันไม่สมเหตุสมผลในทางปฏิบัติ) — ตั้งชื่อ
-- constraint เองตรงๆ (ไม่ปล่อยให้ Postgres auto-generate) เพราะชื่ออัตโนมัติของคอลัมน์ชุดนี้ยาวเกิน 63
-- ตัวอักษร จะถูกตัดท้ายเงียบๆ ทำให้โค้ดที่จับ error ผ่าน err.constraint ต้องเดาชื่อที่ถูกตัดแล้ว เสี่ยงพลาด
ALTER TABLE client_wht_remittances ADD CONSTRAINT client_wht_remittances_period_unique
  UNIQUE (company_id, wht_form, period_year_ad, period_month);
ALTER TABLE client_wht_remittances ADD CONSTRAINT client_wht_remittances_company_id_id_key
  UNIQUE (company_id, id);
ALTER TABLE client_wht_remittances ADD CONSTRAINT client_wht_remittances_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);

-- ผูกใบ 50-ทวิแต่ละใบเข้ากับชุดที่นำส่งมันไป — NULL = ยังไม่นำส่ง
ALTER TABLE client_wht_certificates ADD COLUMN remittance_id INTEGER;
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_remittance_id_fk
  FOREIGN KEY (company_id, remittance_id) REFERENCES client_wht_remittances(company_id, id);
CREATE INDEX idx_client_wht_certificates_remittance ON client_wht_certificates(remittance_id);

-- เพิ่ม doc_type ใหม่ให้ client_document_audit_log รองรับ (บันทึกทุกครั้งที่สร้างชุดนำส่ง — กฎข้อ 9)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance'));
