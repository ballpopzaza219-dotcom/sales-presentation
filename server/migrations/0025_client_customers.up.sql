-- Blueprint ข้อ 9 (CRM/Sales, 0%) — สร้างตาราง Customer Master ของบริษัทผู้เช่าระบบเองเป็นครั้งแรก
--
-- ⚠️ อย่าสับสนกับ `customers`/`customer_companies` ที่มีอยู่แล้วในระบบ — สองตารางนั้นคือบัญชี login ของ
-- ผู้ใช้ฝั่งลูกค้า (tenant) และทะเบียนบริษัทผู้เช่าระบบเอง (คือตัวบริษัทก่อสร้างเอง ไม่ใช่ลูกค้าของบริษัท
-- ก่อสร้าง) — `client_customers` ที่สร้างในไฟล์นี้คือ "ลูกค้า/เจ้าของโครงการ" ที่บริษัทก่อสร้าง (ผู้เช่าระบบ)
-- รับงานให้ (เช่น เจ้าของอาคาร, หน่วยงานราชการที่เปิดประมูล) — คนละทิศทางกับ customers/customer_companies
-- โดยสิ้นเชิง ตรงกับ pattern client_ prefix เดียวกับ client_subcontractors/client_external_payees ที่เป็น
-- "ผู้รับเงินภายนอก" ของบริษัทผู้เช่า — client_customers คือ "ผู้จ่ายเงินภายนอก" กลับด้าน
--
-- โครงสร้างฟิลด์เต็มตาม client_subcontractors/client_external_payees (migration 0001/0009) ตามที่ตกลง
-- ไว้ — ต่างจากทั้งสองตารางนั้นตรงที่ "ไม่บังคับ tax_id เมื่อ taxpayer_type='juristic'" (ตัดสินใจเอง):
-- client_subcontractors/client_external_payees บังคับเพราะต้องออกหนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) ทันที
-- ที่มีการจ่ายเงินจริง แต่ client_customers ยังไม่มี usecase ที่ต้องใช้ tax_id ณ ตอนสร้าง master record เลย
-- (ใบกำกับภาษีขายจะออกทีหลังตอนมีการวางบิล/รับชำระจริง ซึ่งเป็นคนละจุดเวลา) จึงยอมให้กรอกทีหลังได้ ไม่ block
-- การสร้างลูกค้าใหม่ตอนยังไม่ทราบเลขผู้เสียภาษีครบ (เช่น ช่วงเจรจา/เสนอราคาเริ่มต้น)
CREATE TABLE client_customers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tax_id TEXT,
  branch_code TEXT NOT NULL DEFAULT '00000',
  address TEXT NOT NULL DEFAULT '',
  taxpayer_type TEXT NOT NULL DEFAULT 'juristic' CHECK (taxpayer_type IN ('individual','juristic')),
  phone TEXT NOT NULL DEFAULT '',
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tax_id IS NULL OR char_length(tax_id) = 13)
);
CREATE INDEX idx_client_customers_company ON client_customers(company_id);
ALTER TABLE client_customers ADD CONSTRAINT client_customers_company_id_id_key UNIQUE (company_id, id);

-- กันซ้ำสองชั้นแบบเดียวกับ client_subcontractors/client_external_payees เป๊ะ: (1) tax_id ซ้ำเมื่อทราบเลข
-- (partial — ตามที่ตกลง ไม่รวม branch_code เข้าคีย์เหมือนสองตารางนั้น เพราะลูกค้าฝั่งนี้ไม่มี usecase ที่คน
-- เดียวกันมีหลายสาขาต้องแยกเป็นลูกค้าคนละราย), (2) ชื่อซ้ำหลัง normalize (กันช่องว่าง/case/คำนำหน้าต่างกัน)
-- reuse normalize_payee_name() ที่มีอยู่แล้ว (IMMUTABLE, สร้างไว้ตั้งแต่ migration 0001) ไม่สร้างฟังก์ชันใหม่ซ้ำ
CREATE UNIQUE INDEX uq_client_customers_taxid
  ON client_customers(company_id, tax_id) WHERE tax_id IS NOT NULL AND tax_id <> '';
CREATE UNIQUE INDEX uq_client_customers_name_normalized
  ON client_customers(company_id, normalize_payee_name(name));

-- ---------------- เพิ่ม customer_id (nullable) เข้า 3 ตารางที่เคยเก็บชื่อลูกค้าเป็น free text ----------------
-- ตั้งใจ "ไม่ DROP" client_name/project_owner เดิมในไฟล์นี้ (ต่างจาก migration 0024 ที่ DROP hr_department
-- ทันที) เพราะ client_name/project_owner ถูกใช้งานจริงตรงๆ ใน server.js ถึง 12 จุดข้าม 3 โมดูลหลัก
-- (Project/Tender/Quotation) การ DROP พร้อมกับ apply migration นี้จะทำให้ server.js เวอร์ชันปัจจุบัน (ยังไม่
-- ได้แก้ให้ใช้ customer_id) พังทันทีตั้งแต่วินาทีที่ apply เสร็จ ก่อนโค้ดฝั่ง backend จะถูกแก้ให้ทัน — เก็บ
-- คอลัมน์เดิมไว้คู่กันไปก่อน จะ DROP จริงในอีก migration แยกต่างหาก (0026) หลังแก้ server.js/pr-system.html
-- ให้อ่าน/เขียนผ่าน customer_id ครบทุกจุดและเทสผ่านหมดแล้วเท่านั้น
ALTER TABLE client_projects ADD COLUMN customer_id INTEGER;
ALTER TABLE client_quotations ADD COLUMN customer_id INTEGER;
ALTER TABLE client_tenders ADD COLUMN customer_id INTEGER;

-- Backfill: รวม 3 แหล่งเป็นชุดเดียวก่อน dedupe ข้ามตาราง (ตรวจข้อมูลจริงแล้วพบเคสจริงที่ต้องรวม —
-- "มหาวิทยาลัยราชภัฏนครสวรรค์" ปรากฏทั้งใน client_projects.client_name (id=49) และ
-- client_tenders.project_owner (id=97) เป็นลูกค้ารายเดียวกัน) — ใช้ normalize_payee_name() เป็นคีย์เทียบ
-- (trim + lowercase + ตัดคำนำหน้า/ต่อท้ายนิติบุคคล + ยุบช่องว่างซ้ำ) ตามที่ตกลง ไม่ใช่ raw string เทียบตรงๆ
-- ชื่อที่เก็บจริงใน client_customers.name เลือกจากตัวแปรที่ยาวที่สุด (informative ที่สุด) ในกลุ่ม
-- normalize แล้วตรงกัน ไม่ใช่ค่า normalize เอง (ไม่ต้องการ "มหาวิทยาลัยราชภัฏนครสวรรค์" กลายเป็นตัวพิมพ์เล็ก
-- ที่ตัดคำแล้วไปแสดงในระบบจริง — normalize_payee_name มีไว้เป็นคีย์เทียบเท่านั้น ไม่ใช่ค่าที่จะเก็บแสดงผล)
WITH source_names AS (
  SELECT company_id, client_name AS raw_name FROM client_projects WHERE trim(client_name) <> ''
  UNION ALL
  SELECT company_id, client_name AS raw_name FROM client_quotations WHERE trim(client_name) <> ''
  UNION ALL
  SELECT company_id, project_owner AS raw_name FROM client_tenders WHERE trim(project_owner) <> ''
),
grouped AS (
  SELECT company_id, normalize_payee_name(raw_name) AS norm_name,
         (array_agg(raw_name ORDER BY length(trim(raw_name)) DESC, raw_name ASC))[1] AS display_name
  FROM source_names
  GROUP BY company_id, normalize_payee_name(raw_name)
)
INSERT INTO client_customers (company_id, name)
SELECT company_id, display_name FROM grouped;

UPDATE client_projects cp
SET customer_id = cc.id
FROM client_customers cc
WHERE cc.company_id = cp.company_id
  AND normalize_payee_name(cc.name) = normalize_payee_name(cp.client_name)
  AND trim(cp.client_name) <> '';

UPDATE client_quotations cq
SET customer_id = cc.id
FROM client_customers cc
WHERE cc.company_id = cq.company_id
  AND normalize_payee_name(cc.name) = normalize_payee_name(cq.client_name)
  AND trim(cq.client_name) <> '';

UPDATE client_tenders ct
SET customer_id = cc.id
FROM client_customers cc
WHERE cc.company_id = ct.company_id
  AND normalize_payee_name(cc.name) = normalize_payee_name(ct.project_owner)
  AND trim(ct.project_owner) <> '';

-- Guard: ยืนยันว่าทุกแถวที่มี free-text ไม่ว่างเปล่า ต้องได้ customer_id จริงหลัง backfill — ถ้ายังมีแถวหลุด
-- ให้ RAISE EXCEPTION ทันที ห้ามปล่อยผ่าน (แบบเดียวกับ guard ใน migration 0024)
DO $$
DECLARE
  missed_projects INTEGER;
  missed_quotations INTEGER;
  missed_tenders INTEGER;
BEGIN
  SELECT count(*) INTO missed_projects FROM client_projects WHERE trim(client_name) <> '' AND customer_id IS NULL;
  SELECT count(*) INTO missed_quotations FROM client_quotations WHERE trim(client_name) <> '' AND customer_id IS NULL;
  SELECT count(*) INTO missed_tenders FROM client_tenders WHERE trim(project_owner) <> '' AND customer_id IS NULL;
  IF missed_projects > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน client_projects ที่มี client_name ไม่ว่างเปล่าแต่ backfill customer_id ไม่สำเร็จ — หยุดทันที', missed_projects;
  END IF;
  IF missed_quotations > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน client_quotations ที่มี client_name ไม่ว่างเปล่าแต่ backfill customer_id ไม่สำเร็จ — หยุดทันที', missed_quotations;
  END IF;
  IF missed_tenders > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน client_tenders ที่มี project_owner ไม่ว่างเปล่าแต่ backfill customer_id ไม่สำเร็จ — หยุดทันที', missed_tenders;
  END IF;
END $$;

-- composite FK ตาม CLAUDE.md ข้อ 1 — customer_id เป็น nullable ตั้งใจ (โครงการ/tender/quotation ที่ยังไม่
-- ระบุลูกค้าตอนสร้างมีจริงในทางปฏิบัติ) NULL จะข้ามการเช็ค FK ไปเองตามพฤติกรรม multi-column FK ปกติของ Postgres
ALTER TABLE client_projects ADD CONSTRAINT fk_client_projects_customer
  FOREIGN KEY (company_id, customer_id) REFERENCES client_customers(company_id, id);
ALTER TABLE client_quotations ADD CONSTRAINT fk_client_quotations_customer
  FOREIGN KEY (company_id, customer_id) REFERENCES client_customers(company_id, id);
ALTER TABLE client_tenders ADD CONSTRAINT fk_client_tenders_customer
  FOREIGN KEY (company_id, customer_id) REFERENCES client_customers(company_id, id);

-- ---------------- audit log: เพิ่ม doc_type ใหม่ ----------------
-- ขยายตอนนี้เลย (ทำพร้อม DDL) แม้ backend CRUD ของ client_customers จะเขียนเป็น commit แยกทีหลัง (แบบเดียว
-- กับ migration 0024/branches-departments) กัน migration แยกอีกไฟล์แค่เพื่อ ALTER CHECK นี้อย่างเดียว
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance',
    'branch','department','customer'));
