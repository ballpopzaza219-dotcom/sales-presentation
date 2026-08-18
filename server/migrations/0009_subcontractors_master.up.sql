-- หัวข้อ 2 (ผู้รับเหมาช่วง) — Batch 1: master data ของผู้รับเหมาเท่านั้น (client_subcontractors)
-- ไม่แตะผังบัญชี/สัญญา/เอกสารเบิกจ่ายใดๆ เลย (client_subcontract_terms, client_subcontract_billings,
-- บัญชีใหม่ 1160/2130/2140) — รอฝ่ายบัญชียืนยันจุด ⚠️ ใน server/docs/subcontractor-module-plan.md ก่อน
-- ค่อยทำ batch ถัดไป — ตาราง master นี้ไม่มีผลกระทบทางบัญชี/ภาษีเลย จึงร่างล่วงหน้าได้โดยไม่ต้องรอ
--
-- โครงสร้างเลียนแบบ client_external_payees (migration 0001) เกือบทั้งหมดโดยเจตนา — เป็น "ผู้รับเงิน
-- ภายนอก" แบบเดียวกัน ต่างกันแค่ context การใช้งาน (ผูกกับสัญญา ไม่ใช่ผูกกับ voucher เดี่ยวๆ) — ไม่รวมเป็น
-- ตารางเดียวกับ client_external_payees เพราะคนละ lifecycle กัน (ผู้รับเหมาช่วงผูกกับสัญญา/งวดงานที่ซับซ้อน
-- กว่ามาก ในขณะที่ client_external_payees คือจ่ายครั้งเดียวจบไม่มี state สะสม) และคนละหน้าจอ/สิทธิ์จัดการ
-- ในมุมมองผู้ใช้จริง (ฝ่ายจัดซื้อจัดการ external payees ทั่วไป ฝ่ายควบคุมงาน/สัญญาจัดการผู้รับเหมาช่วง)
CREATE TABLE client_subcontractors (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tax_id TEXT,
  branch_code TEXT NOT NULL DEFAULT '00000',
  address TEXT NOT NULL DEFAULT '',
  taxpayer_type TEXT NOT NULL DEFAULT 'juristic' CHECK (taxpayer_type IN ('individual','juristic')),
  phone TEXT NOT NULL DEFAULT '',
  -- ผู้ติดต่อ + อีเมล (ใช้ส่งใบสั่งจ้าง/หนังสือรับรองหัก ณ ที่จ่ายให้ผู้รับเหมาช่วงตลอดโครงการ)
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  -- ข้อมูลบัญชีธนาคาร — จ่ายผู้รับเหมาช่วงส่วนใหญ่โอน ไม่ใช่เงินสด (settlement_channel='transfer' ที่มี
  -- อยู่แล้วในโมดูล 1.3 ต้องใช้ข้อมูลนี้ตอนบันทึกจ่ายจริง)
  bank_name TEXT NOT NULL DEFAULT '',
  bank_account_no TEXT NOT NULL DEFAULT '',
  bank_account_name TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tax_id IS NULL OR char_length(tax_id) = 13),
  -- นิติบุคคลต้องมีเลขผู้เสียภาษี 13 หลักเสมอ (ไม่งั้นออก 50 ทวิ ไม่ได้ตอนถึงเวลาจ่ายจริง) — บุคคลธรรมดา
  -- ยอมให้ tax_id ว่างได้ (อาจยังไม่ทราบตอนบันทึกครั้งแรก มากรอกทีหลังก่อนจ่ายเงินจริงได้)
  CHECK (taxpayer_type <> 'juristic' OR tax_id IS NOT NULL)
);
CREATE INDEX idx_client_subcontractors_company ON client_subcontractors(company_id);
ALTER TABLE client_subcontractors ADD CONSTRAINT client_subcontractors_company_id_id_key UNIQUE (company_id, id);

-- กันซ้ำแบบเดียวกับ client_external_payees เป๊ะ — ใช้ normalize_payee_name() ฟังก์ชันเดิมที่มีอยู่แล้ว
-- (สร้างไว้ตั้งแต่ migration 0001, IMMUTABLE) ไม่ต้องสร้างฟังก์ชันใหม่ซ้ำ
CREATE UNIQUE INDEX uq_client_subcontractors_taxid
  ON client_subcontractors(company_id, tax_id, branch_code) WHERE tax_id IS NOT NULL;
CREATE UNIQUE INDEX uq_client_subcontractors_name_normalized
  ON client_subcontractors(company_id, branch_code, normalize_payee_name(name));

-- ⚠️ ไม่มี default_wht_rate/default_wht_income_type_code ในตารางนี้โดยเจตนา (ต่างจาก
-- client_external_payees ที่มี default_wht_rate) — ตามที่ตกลงในแผน (subcontractor-module-plan.md
-- ส่วน 4): WHT override ระดับ "สัญญา" (client_subcontract_terms) ไม่ใช่ระดับ "ผู้รับเหมา" เพราะผู้รับเหมา
-- รายเดียวอาจมีหลายสัญญาที่ WHT ต่างกันได้ในทางทฤษฎี — คอลัมน์นี้จะอยู่ใน batch ถัดไปตอนสร้าง
-- client_subcontract_terms แทน
