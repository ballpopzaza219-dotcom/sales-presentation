-- PR Module (จัดซื้อวัสดุ) — Batch 1: ข้อ 1 (เงินสดย่อย/เงินทดรองจ่าย/เคลียร์/จ่ายเจ้าหนี้ภายนอก) +
-- infra ร่วม (audit log, idempotency). ทุกตาราง company_id-scoped, composite FK ทุกจุดที่ client
-- เลือกค่าได้เอง (ยกเว้น 2 จุด polymorphic ที่ Postgres ทำ FK แบบมีเงื่อนไขไม่ได้ — ดูคอมเมนต์ที่จุดนั้น)

-- ---------------- ผู้รับเงินภายนอกไม่มี PO/WO (ข้อ 1.4) ----------------
CREATE TABLE client_external_payees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tax_id TEXT,
  branch_code TEXT NOT NULL DEFAULT '00000',
  address TEXT NOT NULL DEFAULT '',
  taxpayer_type TEXT NOT NULL DEFAULT 'juristic' CHECK (taxpayer_type IN ('individual','juristic')),
  default_wht_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  default_expense_account_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tax_id IS NULL OR char_length(tax_id) = 13)
);
CREATE INDEX idx_client_external_payees_company ON client_external_payees(company_id);
ALTER TABLE client_external_payees ADD CONSTRAINT client_external_payees_expense_account_fk
  FOREIGN KEY (company_id, default_expense_account_code) REFERENCES client_chart_of_accounts(company_id, code);
ALTER TABLE client_external_payees ADD CONSTRAINT client_external_payees_company_id_id_key UNIQUE (company_id, id);

-- Normalize ชื่อ: lowercase + ตัดคำนำหน้า/ต่อท้ายรูปแบบนิติบุคคลที่พบบ่อย (ไทย/อังกฤษ) + ยุบช่องว่างซ้ำ
-- + trim หัวท้าย — ตัวอย่าง: "บริษัท เอบีซี จำกัด" กับ "ABC Co., Ltd." (คนละภาษา) จะไม่ match กัน (ยอมรับ
-- ข้อจำกัดนี้ — ไม่ทำ cross-language matching) แต่ "บริษัท เอบีซี จำกัด " กับ "เอบีซี" (พิมพ์สั้นครั้งหลัง)
-- จะ match กัน ป้องกันซ้ำได้จริงในเคสที่พบบ่อยที่สุด (พิมพ์มี/ไม่มีคำนำหน้า, ช่องว่างเกิน, ตัวพิมพ์ต่าง)
--
-- ต้องเป็น IMMUTABLE เท่านั้นถึงจะใช้เป็น expression ใน CREATE UNIQUE INDEX ได้ (Postgres ปฏิเสธ
-- functional index บนฟังก์ชันที่ไม่ IMMUTABLE ทันทีตอน CREATE INDEX — ไม่ใช่ error ที่มาทีหลัง)
--
-- ⚠️ คำเตือนสำหรับอนาคต: ถ้าแก้ regex/ตรรกะในฟังก์ชันนี้ภายหลัง (ต้อง DROP FUNCTION แล้ว CREATE ใหม่ —
-- ดูเหตุผลที่ไม่ใช้ OR REPLACE ด้านล่าง) จะไม่กระทบแถวที่ index ไปแล้วโดยอัตโนมัติ — ค่าที่ index เก็บไว้
-- คือผลลัพธ์จากฟังก์ชัน "เวอร์ชันเก่า" ค้างอยู่ ต้องรัน
-- REINDEX INDEX uq_client_external_payees_name_normalized; ทันทีหลังแก้ฟังก์ชัน ไม่งั้น index จะผิดแบบ
-- เงียบ (silently stale) — ทั้งกันไม่ให้ insert ที่ควรซ้ำผ่านไปได้ และอาจ block insert ที่ไม่ควรซ้ำ
-- อย่างผิดๆ ขึ้นอยู่กับว่า regex เปลี่ยนไปทางไหน — เหตุผลเดียวกันนี้ใช้ได้กับกรณี OS/glibc อัปเกรดแล้ว
-- เปลี่ยนพฤติกรรม collation ที่ lower() พึ่งพาอยู่ด้วย (เป็นความเสี่ยงที่รู้จักกันดีของ Postgres บน
-- glibc — ตัวอักษรบางตัวอาจ lower-case ต่างไปจากเดิมหลังอัปเกรด) ต้อง REINDEX ตัวนี้ (และ index อื่นที่
-- พึ่ง lower()/collation ทั้งหมดในระบบ) ทุกครั้งที่ทำ OS upgrade ที่เปลี่ยน glibc ไม่ใช่เฉพาะตอนแก้
-- ฟังก์ชันเองเท่านั้น
--
-- ไม่ใช้ CREATE OR REPLACE โดยเจตนา: migration นี้ต้อง "สร้างครั้งแรก" เท่านั้น ถ้าฟังก์ชันชื่อนี้มีอยู่
-- ก่อนแล้ว (เช่น จากที่อื่นในระบบที่ไม่เกี่ยวกัน หรือรัน migration ซ้ำโดยไม่ผ่าน schema_migrations
-- tracking) ต้องการให้ระเบิดทันทีเป็น error ชัดเจน ไม่ใช่เงียบๆ ทับของเดิมไปโดยไม่รู้ตัว
CREATE FUNCTION normalize_payee_name(raw_name TEXT) RETURNS TEXT AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(raw_name),
        '^(บริษัท|บจก\.?|หจก\.?|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ)\s*', '', 'g'
      ),
      '\s*(\(มหาชน\)|จำกัด\s*\(มหาชน\)|จำกัด|co\.,?\s*ltd\.?|co\s+ltd\.?|ltd\.?|inc\.?|corp\.?)\s*$', '', 'gi'
    ),
    '\s+', ' ', 'g'
  ))
$$ LANGUAGE sql IMMUTABLE;

-- (1) กันเลขผู้เสียภาษีซ้ำจริงเมื่อทราบเลข  (2) กันชื่อซ้ำ (normalize แล้ว) ครอบทุกแถวไม่ว่าจะทราบเลข
-- ผู้เสียภาษีหรือไม่ — แก้ช่องโหว่ที่ 2 partial index แยกกัน (tax_id NULL vs NOT NULL) ปล่อยให้ชื่อเดียวกัน
-- ซ้ำข้ามสถานะ tax_id ได้ ตอนนี้ปิดครบด้วย index (2) ที่ครอบทุกแถวเสมอ
CREATE UNIQUE INDEX uq_client_external_payees_taxid
  ON client_external_payees(company_id, tax_id, branch_code) WHERE tax_id IS NOT NULL;
CREATE UNIQUE INDEX uq_client_external_payees_name_normalized
  ON client_external_payees(company_id, branch_code, normalize_payee_name(name));

-- customers เดิมไม่เคยมี UNIQUE(company_id,id) มาก่อน (customers.id เป็น global SERIAL PK อยู่แล้ว) —
-- ต้องเพิ่มตรงนี้ (ก่อนตารางไหนที่จะ composite-FK submitted_by/approved_by มาหามัน) ไม่ใช่ท้ายไฟล์
-- เพราะ Postgres ต้องมี unique constraint ที่ตรงกับ FK อยู่ก่อน ณ เวลาที่ FK ถูกสร้าง ไม่ใช่แค่ก่อนจบ
-- ทรานแซกชัน — ย้ายมาไว้จุดนี้หลังพบว่าวางไว้ท้ายไฟล์แล้ว apply ไม่ผ่านจริง ("there is no unique
-- constraint matching given keys for referenced table customers")
ALTER TABLE customers ADD CONSTRAINT customers_company_id_id_key UNIQUE (company_id, id);

-- ---------------- กองทุนเงินสดย่อย (ข้อ 1.1) ----------------
CREATE TABLE client_petty_cash_funds (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_id INTEGER,
  fund_limit NUMERIC(18,2) NOT NULL CHECK (fund_limit > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_petty_cash_funds_company ON client_petty_cash_funds(company_id);
ALTER TABLE client_petty_cash_funds ADD CONSTRAINT client_petty_cash_funds_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_petty_cash_funds ADD CONSTRAINT client_petty_cash_funds_company_id_id_key UNIQUE (company_id, id);

-- ---------------- ใบเบิกเงิน (ข้อ 1.1/1.2/1.4) ----------------
CREATE TABLE client_payment_vouchers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  voucher_no TEXT,   -- NULL จนกว่าจะ /submit — กันเลขกระโดดจาก draft ที่ถูกลบทิ้งโดยไม่เคยยื่นจริง
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('petty_cash','advance','other')),
  project_id INTEGER,
  petty_cash_fund_id INTEGER,
  payee_employee_id INTEGER,
  payee_external_id INTEGER,
  payee_name TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  expense_account_code TEXT,
  request_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled','voided')),
  submitted_by INTEGER,   -- composite FK เพิ่มด้านล่าง (ไม่ใช่ single-column inline แบบ created_by)
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,    -- composite FK เพิ่มด้านล่างเช่นกัน
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  voided_reason TEXT NOT NULL DEFAULT '',
  voided_by INTEGER,   -- composite FK เพิ่มด้านล่าง (เหมือน submitted_by/approved_by)
  voided_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, voucher_no),
  -- ผูก voucher_type กับผู้รับเงินให้ตรงกันที่ระดับ DB — กันแอปบั๊กส่งค่าผิดคู่กันหลุดเข้ามาได้
  -- (เช่น other ที่ดันมี payee_employee_id แทนที่จะเป็น payee_external_id)
  -- "status = 'draft' OR ..." โดยเจตนา: draft ต้องกรอกค้างได้ (ยังเลือกยังไม่เสร็จระหว่างกรอกฟอร์ม) —
  -- บังคับให้ครบคู่กันจริงเฉพาะตอนพ้น draft แล้ว (submit เป็นต้นไป) ชั้นแอปต้องปฏิเสธการ /submit ถ้ายัง
  -- ไม่ครบ ไม่งั้นจะหลุดไปเป็น submitted ทั้งที่ยังไม่มี payee/fund ครบ (DB ก็จะปฏิเสธอยู่ดีเป็น safety net)
  CONSTRAINT client_payment_vouchers_payee_type_check CHECK (
    status = 'draft' OR
    (voucher_type = 'other' AND payee_external_id IS NOT NULL AND payee_employee_id IS NULL) OR
    (voucher_type IN ('advance','petty_cash') AND payee_employee_id IS NOT NULL AND payee_external_id IS NULL)
  ),
  CONSTRAINT client_payment_vouchers_fund_type_check CHECK (
    status = 'draft' OR
    (voucher_type = 'petty_cash' AND petty_cash_fund_id IS NOT NULL) OR
    (voucher_type <> 'petty_cash' AND petty_cash_fund_id IS NULL)
  )
);
CREATE INDEX idx_client_payment_vouchers_company ON client_payment_vouchers(company_id);
CREATE INDEX idx_client_payment_vouchers_status ON client_payment_vouchers(company_id, status);
-- สำหรับคำนวณยอดคงเหลือกองทุนเงินสดย่อย (SUM ยอด petty_cash voucher ที่ approved ของกองทุนหนึ่ง)
CREATE INDEX idx_client_payment_vouchers_fund_status ON client_payment_vouchers(company_id, petty_cash_fund_id, status);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_payee_employee_fk
  FOREIGN KEY (company_id, payee_employee_id) REFERENCES employees(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_payee_external_fk
  FOREIGN KEY (company_id, payee_external_id) REFERENCES client_external_payees(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_expense_account_fk
  FOREIGN KEY (company_id, expense_account_code) REFERENCES client_chart_of_accounts(company_id, code);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_fund_fk
  FOREIGN KEY (company_id, petty_cash_fund_id) REFERENCES client_petty_cash_funds(company_id, id);
-- submitted_by/approved_by เป็น composite FK (ต่างจาก created_by ที่คงเป็น single-column) — สองฟิลด์นี้
-- คือจุดตัดสินใจ/อนุมัติจริง ต้องพิสูจน์ระดับ DB ว่าคนที่อนุมัติเป็นของบริษัทเดียวกับเอกสาร ไม่ใช่แค่
-- attribution ทั่วไปแบบ created_by/uploaded_by — ต้องมี customers_company_id_id_key ก่อน (เพิ่มท้ายไฟล์นี้)
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_company_id_id_key UNIQUE (company_id, id);

-- storage_path: path จริงบนดิสก์สำหรับดึงไฟล์กลับมา (file_name แค่ชื่อที่แสดงผล/สุ่มไว้ก่อนหน้านี้ ดึง
-- ไฟล์จริงไม่ได้ถ้ามีแค่ชื่อ) — mime_type/file_size/checksum ไว้ตรวจสอบความถูกต้องตอนดาวน์โหลด/แสดงผล
CREATE TABLE client_payment_voucher_attachments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  voucher_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  file_size BIGINT,
  checksum TEXT,
  uploaded_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, voucher_id) REFERENCES client_payment_vouchers(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_client_payment_voucher_attachments_voucher ON client_payment_voucher_attachments(voucher_id);

CREATE TABLE client_petty_cash_replenishments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  fund_id INTEGER NOT NULL,
  replenish_no TEXT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  replenish_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  submitted_by INTEGER,   -- composite FK เพิ่มด้านล่าง
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,    -- composite FK เพิ่มด้านล่าง
  approved_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, replenish_no),
  FOREIGN KEY (company_id, fund_id) REFERENCES client_petty_cash_funds(company_id, id)
);
CREATE INDEX idx_client_petty_cash_replenishments_fund ON client_petty_cash_replenishments(fund_id);
ALTER TABLE client_petty_cash_replenishments ADD CONSTRAINT client_petty_cash_replenishments_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_petty_cash_replenishments ADD CONSTRAINT client_petty_cash_replenishments_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);

-- ---------------- ใบเคลียร์เงินทดรองจ่าย (ข้อ 1.3) ----------------
-- difference_amount = total_expense_amount - advance_amount (generated เสมอ, คำนวณจากสองคอลัมน์นี้
-- โดย server ต้องเขียน total_expense_amount ให้ถูกก่อน ไม่มีทาง UPDATE difference_amount ตรงๆ ได้เลย):
--   > 0 = ค่าใช้จ่ายเกินยอดทดรองที่เบิก → เบิกเพิ่ม (ข้อ 1.3.2/1.3.5)
--   < 0 = ค่าใช้จ่ายน้อยกว่ายอดทดรองที่เบิก → คืนเงินให้บริษัท (ข้อ 1.3.3)
--   = 0 (ข้อ 1.3.1/1.3.4)
CREATE TABLE client_advance_clearances (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  clearance_no TEXT,
  advance_voucher_id INTEGER NOT NULL,
  clearance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  advance_amount NUMERIC(18,2) NOT NULL,
  total_expense_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  difference_amount NUMERIC(18,2) GENERATED ALWAYS AS (total_expense_amount - advance_amount) STORED,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled','voided')),
  submitted_by INTEGER,   -- composite FK เพิ่มด้านล่าง
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,    -- composite FK เพิ่มด้านล่าง
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  voided_reason TEXT NOT NULL DEFAULT '',
  voided_by INTEGER,   -- composite FK เพิ่มด้านล่าง
  voided_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, clearance_no),
  FOREIGN KEY (company_id, advance_voucher_id) REFERENCES client_payment_vouchers(company_id, id)
);
CREATE INDEX idx_client_advance_clearances_company ON client_advance_clearances(company_id);
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);
-- กันเคลียร์ advance ใบเดียวกันซ้ำหลายใบพร้อมกัน — อนุญาตสร้างใบใหม่ได้อีกก็ต่อเมื่อใบก่อนหน้าจบแบบ
-- ไม่สำเร็จแล้วเท่านั้น (rejected/cancelled/voided), ไม่ใช่ตอนที่ยังมีใบ live (draft/submitted/approved)
CREATE UNIQUE INDEX uq_client_advance_clearances_active_voucher
  ON client_advance_clearances(company_id, advance_voucher_id)
  WHERE status NOT IN ('rejected','cancelled','voided');

CREATE TABLE client_advance_clearance_items (
  id SERIAL PRIMARY KEY,
  clearance_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  expense_account_code TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  vat_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  wht_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  wht_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- payee_name/payee_tax_id: snapshot ฟรีเทกซ์ (ยังจำเป็น — ผู้รับเงินของรายการค่าใช้จ่ายหนึ่งบรรทัดไม่
  -- จำเป็นต้องเป็น master data เสมอไป เช่น ร้านค้าเล็กๆ ที่ไม่เคยจ่ายซ้ำ). payee_external_id: ถ้าผู้รับเงิน
  -- เป็น master data จริง (client_external_payees) ให้ผูก FK จริงแทน — จำเป็นเพราะ 50 ทวิ (client_wht_
  -- certificates) จะออกจากบรรทัดนี้โดยตรงเมื่อ wht_rate>0, ไม่ควรมีแค่ชื่อฟรีเทกซ์ล้วนๆ ที่ตรวจสอบย้อน
  -- กลับไปหา master ไม่ได้ — nullable เพราะไม่ใช่ทุกบรรทัดจะมี master data จริง
  payee_name TEXT NOT NULL DEFAULT '',
  payee_tax_id TEXT NOT NULL DEFAULT '',
  payee_external_id INTEGER,
  FOREIGN KEY (company_id, clearance_id) REFERENCES client_advance_clearances(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_client_advance_clearance_items_clearance ON client_advance_clearance_items(clearance_id);
ALTER TABLE client_advance_clearance_items ADD CONSTRAINT client_advance_clearance_items_account_fk
  FOREIGN KEY (company_id, expense_account_code) REFERENCES client_chart_of_accounts(company_id, code);
ALTER TABLE client_advance_clearance_items ADD CONSTRAINT client_advance_clearance_items_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_advance_clearance_items ADD CONSTRAINT client_advance_clearance_items_payee_external_fk
  FOREIGN KEY (company_id, payee_external_id) REFERENCES client_external_payees(company_id, id);

CREATE TABLE client_advance_clearance_attachments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  clearance_id INTEGER NOT NULL,
  item_id INTEGER,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  file_size BIGINT,
  checksum TEXT,
  uploaded_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, clearance_id) REFERENCES client_advance_clearances(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES client_advance_clearance_items(company_id, id)
);
CREATE INDEX idx_client_advance_clearance_attachments_clearance ON client_advance_clearance_attachments(clearance_id);

-- ---------------- หนังสือรับรองหัก ณ ที่จ่าย 50 ทวิ (ข้อ 1.3.4, ใช้ร่วมกับ 2.x ในอนาคต) ----------------
CREATE TABLE client_wht_certificates (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  cert_no TEXT,
  -- source_id ไม่มี FK โดยเจตนา: polymorphic (ชี้ไปตารางต่างกันตาม source_type) Postgres ทำ FK แบบ
  -- มีเงื่อนไขไม่ได้ (ต้องใช้ trigger เท่านั้น) — ตรงกับ pattern เดิมของ client_journal_entries.source_id
  source_type TEXT NOT NULL CHECK (source_type IN ('advance_clearance_item','subcontractor_payment')),
  source_id INTEGER NOT NULL,
  payee_name TEXT NOT NULL,
  payee_tax_id TEXT NOT NULL,
  payment_date DATE NOT NULL,
  income_type_desc TEXT NOT NULL DEFAULT '',
  gross_amount NUMERIC(18,2) NOT NULL,
  wht_rate NUMERIC(5,2) NOT NULL,
  wht_amount NUMERIC(18,2) NOT NULL,
  issued_by INTEGER REFERENCES customers(id),
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, cert_no)
);
CREATE INDEX idx_client_wht_certificates_source ON client_wht_certificates(company_id, source_type, source_id);

-- ---------------- Audit log กลาง (ใช้ร่วมทุก batch ในอนาคต) ----------------
-- doc_id ไม่มี FK เช่นกัน โดยเจตนา — polymorphic ตาม doc_type (ชี้ได้หลายตาราง) เหตุผลเดียวกับ
-- client_wht_certificates.source_id ข้างบน
CREATE TABLE client_document_audit_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment')),
  doc_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  performed_by INTEGER REFERENCES customers(id),
  is_override BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_document_audit_log_doc ON client_document_audit_log(company_id, doc_type, doc_id);

-- ---------------- Idempotency ----------------
-- ขอบเขตทรานแซกชัน (ยืนยัน 2 ก้อนแยกกันตามที่ตกลง ไม่ใช่ 3):
--   ก้อนที่ 1 — "จอง": INSERT แถวนี้ (reserved_at=now(), response_status/response_body ยังเป็น NULL)
--     ผ่าน `INSERT ... ON CONFLICT DO NOTHING`, commit ทันทีเป็นทรานแซกชันของตัวเอง แยกขาดจากก้อนที่ 2
--     โดยสิ้นเชิง — ทำหน้าที่เป็น lock กันสอง request ถือ key เดียวกันพร้อมกันประมวลผลซ้ำเท่านั้น
--   ก้อนที่ 2 — "งานธุรกิจ + บันทึกผลลัพธ์": handler (เช่น สร้าง client_revenue/journal entries) กับ
--     `UPDATE client_idempotency_keys SET response_status=.., response_body=..` อยู่ใน **ทรานแซกชัน
--     เดียวกัน คนละ client/connection เดียวกัน** commit พร้อมกันเป็นอะตอมเดียว — handler ต้องรับ
--     client ที่เปิดทรานแซกชันไว้แล้วเป็นพารามิเตอร์ (แบบเดียวกับ createClientJournalEntry(client,...)
--     ที่มีอยู่แล้วในโค้ดเบสนี้ ไม่ใช่ pattern ใหม่) แล้วใช้ client นั้นทำทุกอย่าง ไม่เปิด
--     connection ของตัวเองแยกต่างหาก
--   ผลคือ: พังตรงไหนในก้อนที่ 2 (ธุรกิจ หรือ UPDATE เอง) → ROLLBACK ทั้งก้อน → ธุรกิจไม่ commit และ
--     response_status ยังเป็น NULL เหมือนเดิม (เพราะ UPDATE ก็ถูก rollback ไปด้วย) — ไม่มีทางเกิดสภาวะ
--     "ธุรกิจสำเร็จแล้วแต่ไม่บันทึกผล" อีกต่อไป — แถวจอง (ก้อนที่ 1) ยังอยู่แต่ response_status ยัง NULL
--     ณ จุดนี้แอปจะ DELETE แถวจองทิ้งทันที (ไม่ต้องรอ stale window 5 นาที) แล้ว throw error ต่อให้
--     route handler ปกติจัดการ — request ถัดไปด้วย key เดียวกัน (หรือ retry ทันทีของ client เดิม)
--     จองใหม่ได้เลยตั้งแต่ศูนย์อย่างปลอดภัย
-- reserved_at: เวลาที่ "จอง" คีย์นี้ไว้ล่าสุด — ใช้ตรวจ stale reservation เฉพาะกรณี process ตายกลางทาง
-- แบบไม่ทัน DELETE ได้จริง (เช่น process ถูก kill -9, ไม่ใช่ error ปกติที่ catch ได้) ค้างเกิน 5 นาที
-- แปลว่าน่าจะตายจริง ให้ request ใหม่ยึดคืนสิทธิ์ได้ (compare-and-swap ผ่าน WHERE reserved_at=แถวเดิม
-- กันสอง request แข่งกันยึดคืนพร้อมกัน) แทนที่จะติด 409 ตลอดกาล
-- request_hash: SHA-256 ของ body แบบ canonical (ดูวิธี canonicalize แน่นอนในคอมเมนต์ที่ server.js
-- ตอนเขียนจริง — เรียง key แบบ recursive ก่อน stringify, array คงลำดับเดิม, hash เป็น UTF-8 bytes)
-- — คีย์เดิมแต่ payload ต่างกันต้องถูกปฏิเสธ (422) ไม่ใช่คืน response เก่าที่ไม่ตรงกับคำขอใหม่
-- response_status/response_body เป็น NULLable: NULL หมายถึง "กำลังประมวลผลอยู่ (หรือเพิ่งจอง)" ไม่ใช่
-- error state — มีค่าแล้วหมายถึงเสร็จจริง คืนค่านั้นซ้ำได้ปลอดภัยทุกครั้ง
CREATE TABLE client_idempotency_keys (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key, endpoint)
);
CREATE INDEX idx_client_idempotency_keys_created ON client_idempotency_keys(created_at);

-- Singleton row เก็บเวลา purge ล่าสุด สำหรับ throttle lazy-cleanup (ข้าม purge ถ้ายังไม่เกิน 1 ชม.
-- นับจากครั้งก่อน) — CHECK (id=1) บังคับมีแถวเดียวเสมอ
CREATE TABLE client_idempotency_purge_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_purged_at TIMESTAMPTZ
);
INSERT INTO client_idempotency_purge_state (id) VALUES (1);
-- อายุ idempotency key: 7 วัน — enforce ใน server.js (lazy purge หลังส่ง response, LIMIT 500/ครั้ง,
-- ห่อ .catch() กัน request ล้ม) และ server/scripts/purge_idempotency_keys.js (สคริปต์สำรอง manual)
-- ไม่มี TTL ในตัว Postgres เอง ค่า 7 วันนี้ต้องตรงกันทั้งสองที่

-- ---------------- สิทธิ์อนุมัติ (เฉพาะส่วนที่ batch 1 ใช้จริง — petty cash) ----------------
ALTER TABLE customers ADD COLUMN can_approve_petty_cash BOOLEAN NOT NULL DEFAULT false;

-- ---------------- ผังบัญชี + Journal (เฉพาะที่ batch 1 ใช้) ----------------
-- Guard: ต้อง RAISE EXCEPTION ถ้าพบว่ามีบริษัทใดมีรหัส 1110/1150 อยู่ก่อนแล้ว — ทำให้ down.sql พิสูจน์ได้
-- ว่าการ DELETE แบบเหมาปลอดภัย 100% (ถ้า migration นี้ apply สำเร็จ แปลว่าไม่มีบริษัทไหนมีรหัสนี้มาก่อน
-- แน่นอน ดังนั้นทุกแถวที่มีรหัสนี้อยู่ตอน rollback ต้องมาจาก INSERT ด้านล่างเท่านั้น ไม่มีทางเป็นของเดิม)
DO $$
DECLARE
  conflict_company_id INTEGER;
  conflict_code TEXT;
BEGIN
  SELECT company_id, code INTO conflict_company_id, conflict_code
  FROM client_chart_of_accounts WHERE code IN ('1110','1150') LIMIT 1;
  IF conflict_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'บริษัท id=% มีรหัสบัญชี % อยู่ก่อนแล้ว — migration 0001 ต้องการรหัส 1110/1150 ว่างสำหรับทุกบริษัทก่อน apply กรุณาแก้ไข/ย้ายรหัสเดิมก่อน', conflict_company_id, conflict_code;
  END IF;
END $$;

INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, x.code, x.name, x.category
FROM customer_companies c
CROSS JOIN (VALUES
  ('1110','เงินสดย่อย','asset'),
  ('1150','ลูกหนี้เงินทดรองจ่าย','asset')
) AS x(code, name, category)
ON CONFLICT (company_id, code) DO NOTHING;  -- ยังคง ON CONFLICT ไว้เป็น safety net ซ้อนบน guard ข้างบน
                                             -- (ไม่ควรถูกใช้งานจริง เพราะ guard เช็คไปแล้วในทรานแซกชัน
                                             -- เดียวกันนี้เอง ก่อนถึง INSERT บรรทัดนี้)

ALTER TABLE client_journal_entries DROP CONSTRAINT client_journal_entries_source_type_check;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_source_type_check
  CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment',
                          'payment_voucher','advance_clearance','petty_cash_replenishment'));
