-- Blueprint ข้อ 3 (Multi-Tenant Architecture: Platform → Tenant/Company → Branch → Department → Users) —
-- ตรวจสอบแล้วว่าห่วงโซ่ปัจจุบันมีแค่ Platform → Company → Users จริง ไม่มีชั้น Branch/Department เลย (ดู
-- gap analysis ใน blueprint-progress.md) — `branch_code` ที่มีอยู่แล้วบน client_external_payees/
-- client_subcontractors คือรหัสสาขาสรรพากรของ "ผู้รับเงินภายนอก" ไม่ใช่โครงสร้างสาขาของบริษัทผู้เช่าระบบเอง
-- คนละเรื่องกันโดยสิ้นเชิง — migration นี้สร้างชั้น Branch/Department ของบริษัทเองเป็นครั้งแรก
--
-- ออกแบบตาม 4 ข้อที่ตกลงกันไว้:
-- 1) composite FK (company_id, branch_id) -> client_branches(company_id, id) กัน department ของบริษัท A
--    อ้างอิง branch ของบริษัท B ได้ (CLAUDE.md ข้อ 1) — branch_id เป็น nullable ตั้งใจ (แผนกระดับบริษัท
--    ที่ไม่ผูกสาขาใดสาขาหนึ่งมีจริงในทางปฏิบัติ เช่น "ฝ่ายบัญชีกลาง")
-- 2) job_applications.hr_department (free-text เดิม) auto-generate เป็น client_departments จาก DISTINCT
--    ค่าที่ไม่ว่างเปล่า แล้ว backfill FK — ตรวจสอบแล้วว่าข้อมูลจริงตอนนี้มีแค่ 2 แถว ทั้งคู่ hr_department=''
--    (ไม่เคยกรอกจริง) จึงไม่มีอะไรให้ backfill จริงในสภาพข้อมูลตอนนี้ — DROP hr_department (text) ทิ้งใน
--    ไฟล์เดียวกัน (ไม่เก็บ column คู่ขนานค้างไว้ ตามธรรมเนียมเดียวกับที่ migration 0020 DROP default_rate)
-- 3) UNIQUE(company_id, code) ทั้งสองตาราง — department เป็นแนวคิดระดับบริษัท ไม่ใช่ระดับสาขา (สอดคล้อง
--    กับข้อ 1 ที่ให้ branch_id เป็น optional)
-- 4) is_active (soft-delete) + เข้า client_document_audit_log — ตาม precedent ของ client_subcontractors/
--    client_external_payees (migration 0009/0010/0011) ที่ master data ก็เข้า audit log เหมือนกัน ไม่ใช่
--    แค่ transactional documents

-- ---------------- client_branches ----------------
CREATE TABLE client_branches (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_branches_company ON client_branches(company_id);
-- รองรับ composite FK จากตารางลูก (client_departments และตารางอื่นในอนาคต)
ALTER TABLE client_branches ADD CONSTRAINT client_branches_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_branches ADD CONSTRAINT uq_client_branches_code UNIQUE (company_id, code);

-- ---------------- client_departments ----------------
CREATE TABLE client_departments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  branch_id INTEGER, -- nullable ตั้งใจ (ข้อ 1) — แผนกระดับบริษัทที่ไม่ผูกสาขาใดสาขาหนึ่งได้
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_departments_company ON client_departments(company_id);
CREATE INDEX idx_client_departments_branch ON client_departments(company_id, branch_id);
ALTER TABLE client_departments ADD CONSTRAINT client_departments_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_departments ADD CONSTRAINT uq_client_departments_code UNIQUE (company_id, code);
-- composite FK ตามข้อ 1 — NULL ใน branch_id ทำให้ constraint ไม่ถูกตรวจ (พฤติกรรมเริ่มต้นของ Postgres
-- multi-column FK: ถ้าคอลัมน์ใดใน FK เป็น NULL แถวนั้นผ่านการเช็คเสมอ) ตรงกับที่ต้องการพอดี — department
-- ที่ไม่ผูกสาขา (branch_id IS NULL) ไม่ต้องมี branch อ้างอิงอยู่จริง แต่ถ้าระบุ branch_id มา ต้องมีจริงและ
-- เป็นของบริษัทเดียวกันเท่านั้น
ALTER TABLE client_departments ADD CONSTRAINT fk_client_departments_branch
  FOREIGN KEY (company_id, branch_id) REFERENCES client_branches(company_id, id);

-- ---------------- job_applications: ย้าย hr_department จาก free-text เป็น FK ----------------
ALTER TABLE job_applications ADD COLUMN department_id INTEGER;

-- Auto-generate department master จาก DISTINCT ค่า hr_department ที่ไม่ว่างเปล่าต่อบริษัท — code สร้างเป็น
-- เลขรันต่อบริษัท (DEPT-0001, DEPT-0002, ...) เพราะข้อความเดิมเป็น free-text ภาษาไทยไม่มีโครงสร้างที่
-- ทำ code สั้นๆ ได้แม่นยำอัตโนมัติ ส่วน name เก็บข้อความเดิมไว้ตรงๆ ไม่ให้ข้อมูลหาย
WITH distinct_depts AS (
  SELECT DISTINCT company_id, hr_department
  FROM job_applications
  WHERE hr_department IS NOT NULL AND trim(hr_department) <> ''
),
numbered AS (
  SELECT company_id, hr_department,
         'DEPT-' || LPAD(ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY hr_department)::text, 4, '0') AS code
  FROM distinct_depts
)
INSERT INTO client_departments (company_id, code, name)
SELECT company_id, code, hr_department FROM numbered;

UPDATE job_applications ja
SET department_id = cd.id
FROM client_departments cd
WHERE cd.company_id = ja.company_id
  AND cd.name = ja.hr_department
  AND ja.hr_department IS NOT NULL AND trim(ja.hr_department) <> '';

-- Guard: ยืนยันว่าทุกแถวที่มี hr_department ไม่ว่างเปล่า ต้องได้ department_id จริงหลัง backfill — ถ้ายังมี
-- แถวหลุด (department_id ยัง NULL ทั้งที่ hr_department ไม่ว่าง) ให้ RAISE EXCEPTION ทันที ห้ามปล่อยผ่าน
DO $$
DECLARE
  missed_count INTEGER;
BEGIN
  SELECT count(*) INTO missed_count
  FROM job_applications
  WHERE hr_department IS NOT NULL AND trim(hr_department) <> '' AND department_id IS NULL;
  IF missed_count > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน job_applications ที่มี hr_department ไม่ว่างเปล่าแต่ backfill department_id ไม่สำเร็จ — หยุดทันที', missed_count;
  END IF;
END $$;

ALTER TABLE job_applications ADD CONSTRAINT fk_job_applications_department
  FOREIGN KEY (company_id, department_id) REFERENCES client_departments(company_id, id);
ALTER TABLE job_applications DROP COLUMN hr_department;

-- ---------------- audit log: เพิ่ม doc_type ใหม่ (ข้อ 4) ----------------
-- ตรวจสอบก่อนแล้วว่าข้อมูลปัจจุบันของ client_document_audit_log.doc_type ทุกแถวอยู่ใน list เดิมครบ ไม่มี
-- ค่านอกเหนือ list ที่จะทำให้ DROP/ADD constraint พัง (ตรวจด้วยมือก่อน apply แล้ว)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance',
    'branch','department'));

