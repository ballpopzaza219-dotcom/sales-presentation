-- หัวข้อ 2.1-2.3: การเบิกเงินตามใบสั่งจ้าง (เงินล่วงหน้า/งวดงาน/คืนเงินประกันผลงาน)
-- อิงแผน server/docs/subcontractor-module-plan.md (ร่าง 2026-08-18) แต่ปรับให้เข้ากับ client_subcontract_terms
-- ตัวจริงที่สร้างไปแล้วในหัวข้อ 5 รอบ B (migration 0012) — ตอนร่างแผนยังไม่มีตารางนี้จริง ข้อแตกต่างหลัก:
--   - แผนเดิมออกแบบ status ของสัญญาเป็น draft/active/completed/terminated ตัวเดียว แต่ของจริงแยกเป็น
--     status (draft/submitted/approved/rejected/cancelled, workflow เอกสาร) + contract_status
--     (active/completed/terminated, วงจรชีวิตสัญญา, ไม่ NULL ก็ต่อเมื่อ status='approved') — บิลได้เฉพาะ
--     สัญญาที่ status='approved' เท่านั้น (ไม่จำกัด contract_status — สัญญาที่ completed/terminated แล้ว
--     ยังต้องเคลียร์ retention ค้างได้อยู่ เป็นเงินที่ค้างจ่ายจริงจากงานที่ทำไปแล้ว ไม่หายไปเพราะเลิกสัญญา)
--   - client_wht_income_types.code ไม่ใช่ composite key ต่อบริษัท (PRIMARY KEY (code) เดี่ยวๆ เป็น master
--     กลางข้ามบริษัท) — ตรวจสอบแล้วจาก client_subcontract_terms.wht_income_type_code ที่ FK แบบ
--     single-column อยู่แล้วจริง ใช้ pattern เดียวกัน ไม่ทำ composite
--   - client_wht_certificates.source_type='subcontractor_payment' และ
--     client_document_audit_log.doc_type='subcontractor_payment' ถูกจองไว้แล้วจริงตั้งแต่ migration 0001
--     (ตรวจสอบแล้ว) ไม่ต้องขยาย CHECK ทั้งสองจุดนี้เพิ่ม
--   - ยอดคงเหลือทั้ง 3 ตัว (เงินล่วงหน้าคงค้าง/retention สะสม/ยอดเบิกสะสมเทียบสัญญา) คำนวณสดด้วย SUM
--     ตอนอ่านเสมอ (endpoint /balance) ไม่มีคอลัมน์สะสมใหม่บน client_subcontract_terms เลย — จึงไม่มี ALTER
--     TABLE ตารางเดิมใดๆ ในไฟล์นี้ (ต่างจาก migration 0014 ที่ต้องเพิ่ม applied_amount/claimed_percent)
--   - WHT/VAT บนเงินล่วงหน้า (billing_type='advance') ยังไม่มีข้อสรุปจากฝ่ายบัญชี (ทั้งสองจุดยัง ⚠️ ในแผน
--     เดิม ไม่ได้อยู่ใน 6 ข้อที่ผู้ใช้ยืนยันรอบนี้) — ออกแบบให้เป็น "ตัวเลือกต่อรายการ" แทนการ hardcode
--     นโยบายเดียวตายตัว (มี has_tax_invoice/wht_rate ให้กรอกหรือเว้นว่างต่อบิลแต่ละใบ เหมือน has_tax_invoice
--     ของโมดูล 1.3/1.4) — billing_type='progress' ก็ใช้กลไกเดียวกัน แต่ในทางปฏิบัติแทบทุกกรณีจะมี wht_amount
--     จริงเสมอ (ระบบไม่บังคับ แค่ไม่ตัดโอกาสให้เลือกได้ถ้าฝ่ายบัญชีตัดสินใจภายหลังว่าเงินล่วงหน้าไม่ต้องหัก)
--
-- กันเบิกเกิน 3 จุด (ทำเป็น DB CHECK ธรรมดาไม่ได้เลยสักข้อ — ทุกจุดเทียบกับ SUM ข้ามหลายแถว ต้องบังคับใน
-- โค้ด application ภายใน transaction เท่านั้น ดูส่วน 6.1 ของแผน) — เช็คทั้งตอน submit (เตือน ไม่บล็อก
-- เพราะยอดอาจเปลี่ยนได้อีกก่อนถึง approve) และ approve (บังคับจริง พร้อม FOR UPDATE ล็อกแถวที่เกี่ยวข้องก่อน
-- เสมอ แยก statement จาก aggregate ตาม CLAUDE.md ข้อ 6/7):
--   1. ยอดเบิกสะสมเกินสัญญา: SUM(gross_amount) ของ billing_type='progress' ที่ approved ทั้งหมด (รวมแถวนี้)
--      ต้องไม่เกิน client_subcontract_terms.contract_value
--   2. หักคืนเงินล่วงหน้าเกิน: advance_recovery_amount แถวนี้ต้องไม่เกินเงินล่วงหน้าคงค้างจริง
--      (SUM(gross_amount) ของ advance ที่ approved - SUM(advance_recovery_amount) ของ progress ที่ approved)
--   3. คืน retention เกิน: ตรวจทีละแถวใน client_subcontract_retention_release_items — SUM(amount) ของ
--      source_progress_billing_id เดียวกัน (รวมครั้งก่อนๆ) ต้องไม่เกิน retention_amount ของงวด progress นั้น
-- ทุกการเทียบทำฝั่ง SQL ด้วย ::numeric แล้วคืน boolean กลับมาตัดสินใจ ไม่แปลงเป็น JS Number (ข้อ 3)

-- ================= 1) client_subcontract_billings (header) =================
CREATE TABLE client_subcontract_billings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  subcontract_term_id INTEGER NOT NULL,
  billing_no TEXT, -- ออกเลขที่ตอน submit เท่านั้น (เหมือนเอกสารอื่นทั้งหมดในระบบ)
  billing_type TEXT NOT NULL CHECK (billing_type IN ('advance','progress','retention_release')),
  billing_date DATE NOT NULL DEFAULT CURRENT_DATE,
  gross_amount NUMERIC(18,2) NOT NULL CHECK (gross_amount > 0), -- มูลค่างวด/เงินล่วงหน้า/retention ที่คืน แล้วแต่ billing_type
  -- เฉพาะ billing_type='progress' — คำนวณฝั่ง server จาก advance_percent x gross_amount เสมอ (CLAUDE.md
  -- ข้อ 4) แล้ว cap ไม่ให้เกินยอดเงินล่วงหน้าคงค้างจริง ตรวจตอน approve พร้อม FOR UPDATE (ข้อ 6/7)
  advance_recovery_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (advance_recovery_amount >= 0),
  retention_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (retention_amount >= 0), -- เฉพาะ progress — กันไว้ตอนงวดนี้ ยังไม่จ่าย
  -- WHT/VAT เป็นตัวเลือกต่อรายการเสมอ (ดูคอมเมนต์บนสุดของไฟล์) — has_tax_invoice=false บังคับ vat_amount=0
  -- ด้วย CHECK ด้านล่าง (pattern เดียวกับ client_advance_clearance_items/client_payment_vouchers)
  has_tax_invoice BOOLEAN NOT NULL DEFAULT false,
  vat_rate NUMERIC(5,2),
  vat_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  -- wht_income_type_code/wht_rate เป็น "snapshot ตอน approve" (freeze ค่าจริงที่ใช้คำนวณ ไม่ join สดย้อนหลัง
  -- เหมือนที่แก้บั๊ก client_wht_income_types ไปแล้วในโมดูลอื่น) — ก่อน approve เป็นแค่ค่าที่ตั้งใจจะใช้
  wht_income_type_code TEXT REFERENCES client_wht_income_types(code),
  wht_rate NUMERIC(5,2), -- NULL = ไม่หัก WHT บิลนี้ (ตัวเลือกต่อรายการ ดูคอมเมนต์บนสุด)
  wht_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (wht_amount >= 0),
  -- คำนวณฝั่ง server เสมอ ไม่เชื่อ client (CLAUDE.md ข้อ 4): net_payable_amount =
  -- gross_amount + vat_amount - advance_recovery_amount - retention_amount - wht_amount
  net_payable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled','voided')),
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  -- voided_* เตรียมไว้เท่านั้น (คอลัมน์มีไว้ก่อน) ยังไม่มี endpoint /void ในรอบนี้ — เหมือนสถานะค้างของ
  -- โมดูล 1.3 ที่มี pattern เดียวกัน (คอลัมน์พร้อมแต่ endpoint ยังไม่ทำ)
  voided_reason TEXT NOT NULL DEFAULT '',
  voided_by INTEGER,
  voided_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, billing_no),
  -- ผูก billing_type กับฟิลด์ที่ใช้ได้จริง — บังคับทุกสถานะรวม draft ด้วย เพราะทั้ง 2 กรณีนี้เป็นค่าที่ "ผิด
  -- ประเภทเชิงตรรกะ" ไม่ใช่ "ยังกรอกไม่ครบ" (advance_recovery_amount/retention_amount มี DEFAULT 0 อยู่
  -- แล้ว draft ที่ยังไม่ได้แตะฟิลด์เหล่านี้จะผ่านเงื่อนไขนี้เองโดยอัตโนมัติอยู่แล้ว ไม่มีเหตุผลต้อง escape
  -- ด้วย status='draft' — ถ้ายังปล่อยผ่านตอน draft จะไปโดนปฏิเสธตอน submit แทน ซึ่งงงกว่าที่ควรจะเป็น)
  CONSTRAINT client_subcontract_billings_type_fields_check CHECK (
    (billing_type = 'advance' AND advance_recovery_amount = 0 AND retention_amount = 0) OR
    (billing_type = 'progress') OR
    (billing_type = 'retention_release' AND advance_recovery_amount = 0 AND retention_amount = 0
      AND wht_amount = 0 AND vat_amount = 0)
  ),
  -- 2 constraint ด้านล่างนี้ยังคง escape ด้วย status='draft' ไว้ — ต่างจากด้านบน เพราะเป็นการเช็ค "ความ
  -- สอดคล้องข้ามฟิลด์ที่ยังกรอกไม่ครบได้จริงระหว่างกรอกฟอร์ม" (เช่น handleAction ฝั่ง client อาจเรียง
  -- ลำดับกรอก wht_income_type_code หลัง wht_amount) ไม่ใช่ "ค่าที่ผิดประเภทเอกสารตั้งแต่ต้น" แบบ
  -- constraint บน — บังคับเข้มจริงจังตั้งแต่ submitted เป็นต้นไป (ชั้น application ต้องปฏิเสธ /submit เอง
  -- ด้วยถ้ายังไม่ครบ ไม่พึ่ง DB CHECK อย่างเดียวเป็นเกราะสุดท้าย)
  CONSTRAINT client_subcontract_billings_tax_invoice_check CHECK (
    status = 'draft' OR has_tax_invoice OR vat_amount = 0
  ),
  CONSTRAINT client_subcontract_billings_wht_type_required_check CHECK (
    status = 'draft' OR wht_amount = 0 OR wht_income_type_code IS NOT NULL
  )
);
CREATE INDEX idx_client_subcontract_billings_company ON client_subcontract_billings(company_id);
CREATE INDEX idx_client_subcontract_billings_term ON client_subcontract_billings(company_id, subcontract_term_id);
CREATE INDEX idx_client_subcontract_billings_status ON client_subcontract_billings(company_id, status);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_term_fk
  FOREIGN KEY (company_id, subcontract_term_id) REFERENCES client_subcontract_terms(company_id, id);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);

-- ================= 2) client_subcontract_retention_release_items (เฉพาะ billing_type='retention_release') =================
-- 1 ครั้งคืน retention คืนได้หลายงวดพร้อมกัน หรือคืนไม่เต็มจำนวนของงวดใดงวดหนึ่งก็ได้ (ธุรกิจจริงมักคืนรวม
-- หลายงวดทีเดียวตอนพ้นระยะประกันผลงาน ไม่ใช่คืนทีละงวด)
CREATE TABLE client_subcontract_retention_release_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  retention_release_billing_id INTEGER NOT NULL, -- แถวแม่ billing_type='retention_release'
  source_progress_billing_id INTEGER NOT NULL, -- แถว billing_type='progress' ที่ถูกคืน retention
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0), -- อาจไม่เต็มจำนวน retention_amount เดิมของงวดนั้นก็ได้
  UNIQUE (company_id, id),
  -- กันใบคืนใบเดียวอ้าง progress billing เดิมซ้ำสองบรรทัด — ถ้าซ้ำได้ SUM(amount) ตอนกันคืนเกิน (ส่วน 6.1
  -- ของแผน) จะนับสองครั้งจากที่ตั้งใจจริง โดยที่ไม่มีอะไรจับได้เลยที่ชั้น DB
  UNIQUE (company_id, retention_release_billing_id, source_progress_billing_id)
);
CREATE INDEX idx_client_subcontract_retention_release_items_billing ON client_subcontract_retention_release_items(retention_release_billing_id);
CREATE INDEX idx_client_subcontract_retention_release_items_source ON client_subcontract_retention_release_items(source_progress_billing_id);
ALTER TABLE client_subcontract_retention_release_items ADD CONSTRAINT client_subcontract_retention_release_items_billing_fk
  FOREIGN KEY (company_id, retention_release_billing_id) REFERENCES client_subcontract_billings(company_id, id) ON DELETE CASCADE;
ALTER TABLE client_subcontract_retention_release_items ADD CONSTRAINT client_subcontract_retention_release_items_source_fk
  FOREIGN KEY (company_id, source_progress_billing_id) REFERENCES client_subcontract_billings(company_id, id);

-- ================= 3) ขยาย CHECK เดิมให้รองรับ doc_type ใหม่สำหรับเพดานอนุมัติ =================
-- หมายเหตุ: client_document_audit_log.doc_type='subcontractor_payment' และ
-- client_wht_certificates.source_type='subcontractor_payment' ถูกจองไว้แล้วจริงตั้งแต่ migration 0001
-- (ตรวจสอบจาก DB จริงแล้ว) ไม่ต้องขยาย CHECK สองจุดนั้นเพิ่มในไฟล์นี้
ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance','other','progress','subcontractor_billing'));

-- ================= 4) สิทธิ์ใหม่ 1 ตัว =================
-- can_approve_subcontract_billing แยกจาก can_manage_po (จัดการสัญญา/master data) และ can_approve_po_wo
-- (อนุมัติตัวสัญญาเอง) โดยเจตนา — นี่คือสิทธิ์อนุมัติ "การจ่ายเงินจริง" ตามสัญญาที่อนุมัติแล้ว ใกล้เคียงกับ
-- can_approve_petty_cash/can_approve_advance/can_approve_other มากกว่า (สิทธิ์อนุมัติธุรกรรมเงิน ไม่ใช่
-- สิทธิ์จัดการทรัพยากร ตาม CLAUDE.md ข้อ 14) — สร้าง/แก้ไข draft billing เปิดให้ทุกคนที่ login แล้วทำได้
-- เหมือน PR/PO (ไม่มี gate พิเศษตอนสร้าง) กำหนดสิทธิ์แค่ตอน approve เท่านั้น
ALTER TABLE customers ADD COLUMN can_approve_subcontract_billing BOOLEAN NOT NULL DEFAULT false;

-- ================= 5) ผังบัญชีใหม่ 3 บัญชี =================
-- ตรวจแล้ว (query สดข้าม distinct code/name ทุกบริษัทที่มีอยู่จริงในระบบ ณ วันที่ apply): ไม่มีรหัส
-- 1160/2130/2140 อยู่ก่อนเลย และไม่มีบัญชีอื่นที่ความหมายซ้ำกันภายใต้เลขอื่นด้วย — ที่เจอจาก keyword ใกล้
-- เคียง (ล่วงหน้า/ผู้รับเหมา/ประกันผลงาน) มีแค่ 3 ตัวซึ่งเป็นคนละเรื่อง/คนละทิศทางทั้งหมด: 5200 ต้นทุน
-- ผู้รับเหมาช่วง (บัญชีต้นทุน ใช้เป็น Dr ตอน approve progress billing อยู่แล้ว ไม่ใช่บัญชีสินทรัพย์/หนี้สิน
-- ที่ต้องการที่นี่), 1250 ลูกหนี้เงินประกันผลงาน (retention ที่ "เราถูกลูกค้าหัก" — asset ฝั่งเรา คนละทิศกับ
-- 2140 ที่ "เราหักผู้รับเหมา" — liability ฝั่งเรา), 2160 เงินรับล่วงหน้าจากลูกค้า (เงินที่ "ลูกค้าจ่ายเรา
-- ล่วงหน้า" — liability ฝั่งเรา คนละทิศกับ 1160 ที่ "เราจ่ายผู้รับเหมาล่วงหน้า" — asset ฝั่งเรา) — ใช้ guard
-- เดียวกับ 0003/0005 เช็คแค่ "เลขว่าง" ตรงๆ ก่อน INSERT (ความหมายซ้ำตรวจแยกไปแล้วข้างบนว่าไม่มีจริง) เพื่อ
-- ให้ down.sql DELETE แบบเหมา code ได้ปลอดภัย 100% (ถ้า migration นี้ apply สำเร็จ แปลว่าไม่มีบริษัทไหนมี
-- รหัสนี้มาก่อนแน่นอน — ป้องกัน ON CONFLICT DO NOTHING เงียบๆ ข้ามไปโดยไม่มีใครรู้ตัวถ้าบังเอิญมีเลขซ้ำ)
DO $$
DECLARE
  conflict_company_id INTEGER;
  conflict_code TEXT;
BEGIN
  SELECT company_id, code INTO conflict_company_id, conflict_code
  FROM client_chart_of_accounts WHERE code IN ('1160','2130','2140') LIMIT 1;
  IF conflict_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'บริษัท id=% มีรหัสบัญชี % อยู่ก่อนแล้ว — migration 0015 ต้องการรหัส 1160/2130/2140 ว่างสำหรับทุกบริษัทก่อน apply กรุณาแก้ไข/ย้ายรหัสเดิมก่อน', conflict_company_id, conflict_code;
  END IF;
END $$;

INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT id, x.code, x.name, x.category FROM customer_companies,
  (VALUES
    ('1160', 'เงินจ่ายล่วงหน้าผู้รับเหมาช่วง', 'asset'),
    ('2130', 'เจ้าหนี้ผู้รับเหมาช่วง', 'liability'),
    ('2140', 'เงินประกันผลงานค้างจ่าย', 'liability')
  ) AS x(code, name, category)
ON CONFLICT (company_id, code) DO NOTHING;
