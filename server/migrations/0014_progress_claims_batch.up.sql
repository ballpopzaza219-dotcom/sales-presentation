-- หัวข้อ 3: บันทึกความคืบหน้าโครงการ (progress claim workflow: submit->certify->approve)
-- แนวทาง: reuse client_revenue/client_revenue_payments ที่มีอยู่แล้ว (ถูกต้อง มีข้อมูลจริง 0 แถว) เป็น
-- "หลังบ้าน" การรับรู้รายได้/เงินประกัน/รับชำระ ไม่แตะเลย — ตารางใหม่ในไฟล์นี้เป็น "หน้าบ้าน" workflow
-- ตรวจสอบ/อนุมัติที่ยังไม่มีมาก่อน พอ approve แล้วค่อยเรียก postClientRevenueJournalEntry/
-- postClientRetentionHoldJournalEntry (server.js, มีอยู่แล้ว) ให้สร้างแถว client_revenue ให้อัตโนมัติ

-- ================= 1) แก้ตารางเดิมก่อน (ต้องทำก่อนสร้างตารางใหม่ที่จะ FK มาหา) =================
-- ติดตามยอดเงินรับล่วงหน้า (client_revenue.type='deposit') ที่ถูกหักล้างไปแล้ว — คงเหลือ = amount - applied_amount
ALTER TABLE client_revenue ADD COLUMN applied_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE client_revenue ADD CONSTRAINT client_revenue_applied_amount_bounds_check
  CHECK (applied_amount >= 0 AND applied_amount <= amount);

-- ติดตาม % สะสมที่ถูกเบิกไปแล้วต่อบรรทัด BOQ — ตอน approve ต้อง UPDATE claimed_percent = claimed_percent
-- + certified_percent แบบสัมพัทธ์เท่านั้น (เหมือน qty_ordered ของ PR) ห้ามอ่านค่ามาคำนวณในโค้ดแอปแล้วเขียน
-- ค่าสัมบูรณ์กลับ กัน lost-update ตอน concurrent request หลายใบเบิกอนุมัติพร้อมกัน (CLAUDE.md ข้อ 5)
ALTER TABLE client_budget_items ADD COLUMN claimed_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE client_budget_items ADD CONSTRAINT client_budget_items_claimed_percent_bounds_check
  CHECK (claimed_percent >= 0 AND claimed_percent <= 100);

-- ต้องมี UNIQUE(company_id,id) ก่อนถึงจะรับ composite FK จาก client_progress_claims.installment_id ได้
-- (ต้องมาก่อนส่วนที่ 2 ด้านล่างเสมอ ไม่งั้น CREATE TABLE...ADD CONSTRAINT ที่ FK มาหาตารางนี้จะพัง)
ALTER TABLE client_project_installments ADD CONSTRAINT client_project_installments_company_id_id_key UNIQUE (company_id, id);

-- ================= 2) client_progress_claims (header) =================
CREATE TABLE client_progress_claims (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  -- 'progress' = 3.1.1.1 (ตรวจสอบผลงานก่อนอนุมัติ) / 'advance' = 3.1.1.2 (ไม่มีผลงานให้ตรวจ ข้าม certify)
  claim_type TEXT NOT NULL CHECK (claim_type IN ('progress','advance')),
  -- 'installment' = อ้างอิงงวดงานที่ตั้งไว้ล่วงหน้า (client_project_installments) ยอดก้อนเดียว
  -- 'boq' = อ้างอิง BOQ รายบรรทัด (client_progress_claim_items) กรอก % ต่อบรรทัด
  -- NULL เฉพาะ claim_type='advance' เท่านั้น (ไม่มี "งาน" ให้อ้างอิง)
  claim_mode TEXT CHECK (claim_mode IN ('installment','boq')),
  installment_id INTEGER,
  claim_no TEXT, -- ออกเลขที่ตอน submit เท่านั้น (เหมือน PR/PO/WO) ไม่ใช่ตอนสร้าง draft
  requested_amount NUMERIC(18,2) NOT NULL CHECK (requested_amount > 0),
  certified_amount NUMERIC(18,2), -- NULL จนกว่าจะ certify (claim_type='progress') หรือ copy จาก requested ตอน approve (claim_type='advance')
  -- อัตราเงินประกันผลงาน "ที่ใช้จริงในใบนี้" บันทึกไว้ตรงๆ ไม่ join สดจาก client_projects.default_retention_percent
  -- (โครงการอาจแก้ default ทีหลัง ใบเก่าต้องไม่เปลี่ยนตามย้อนหลัง) — autofill จาก default ตอนสร้าง แก้ได้
  -- เฉพาะ claim_type='progress' เท่านั้น (advance ไม่มีเงินประกันผลงาน)
  retention_percent NUMERIC(5,2) CHECK (retention_percent IS NULL OR (retention_percent >= 0 AND retention_percent <= 100)),
  -- บังคับกรอกเหตุผลถ้าอัตราที่ใช้ต่างจาก default ของโครงการ (เช็คตอน validate ฝั่ง server เทียบกับ
  -- client_projects.default_retention_percent ตอนนั้น — ทำเป็น DB CHECK ไม่ได้เพราะต้อง join ข้ามตาราง)
  retention_percent_override_reason TEXT NOT NULL DEFAULT '',
  retention_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (retention_amount >= 0), -- คำนวณตอน approve จาก certified_amount x retention_percent
  -- จะหักล้างเงินรับล่วงหน้าคงเหลือ (client_revenue.type='deposit') เท่าไหร่ตอนออกใบแจ้งหนี้งวดนี้ —
  -- เฉพาะ claim_type='progress' — เช็คที่ชั้นแอปตอน /approve เท่านั้น (ไม่ใช่ DB CHECK) เพราะ
  -- certified_amount/retention_amount ยังไม่ final จนกว่าจะถึงขั้น approve — CHECK ที่อิงคอลัมน์ที่ยังไม่
  -- final จะพังตอน draft/submitted/certified ที่ยังไม่ครบ — ต้องกันหักเกิน 2 เงื่อนไขตอน /approve เสมอ:
  --   (ก) apply_advance_amount <= (client_revenue.amount - client_revenue.applied_amount) ของ advance
  --       แถวนั้น — ต้อง SELECT ... FOR UPDATE ล็อกแถว client_revenue (advance) นั้นก่อนเป็นลำดับแรกสุด
  --       ของ handler ก่อนอ่านค่าไปตัดสินใจ (CLAUDE.md ข้อ 6) แล้ว query คำนวณคงเหลือแยกเป็นอีก statement
  --       ต่างหาก ไม่รวมกับ statement ล็อก (ข้อ 7)
  --   (ข) apply_advance_amount <= certified_amount - retention_amount ของใบนี้เอง (กัน AR ติดลบ)
  apply_advance_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (apply_advance_amount >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','certified','approved','rejected','cancelled')),
  -- submitted_by/certified_by/approved_by/created_by เป็น composite FK (company_id,xxx) -> customers
  -- (company_id,id) ทุกตัว ทั้งที่ปกติคอลัมน์ "ใครทำ" ได้รับการยกเว้นไว้ (CLAUDE.md ข้อ 1) — ยกเว้นเป็นพิเศษ
  -- ในตารางนี้ตามที่สั่งไว้ตรงๆ เพราะ certified_by คือคนยืนยันว่าผลงานจริงเท่าไหร่ ถ้าบันทึกข้ามบริษัทได้
  -- (แม้จะเป็นไปได้ยากเพราะ req.customer.id มาจาก session เดียวกับ company_id เสมอ) ผู้ตรวจสอบจะไล่ที่มาไม่ได้
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  certified_by INTEGER,
  certified_at TIMESTAMPTZ,
  certify_note TEXT NOT NULL DEFAULT '',
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  revenue_id INTEGER, -- set ตอน approve เท่านั้น ชี้ไปที่ client_revenue แถวที่ระบบสร้างให้อัตโนมัติ
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, claim_no),
  -- claim_mode ต้องมีก็ต่อเมื่อเป็น progress เท่านั้น (advance ต้องเป็น NULL เสมอ)
  CONSTRAINT client_progress_claims_type_mode_pair_check CHECK (
    (claim_type = 'progress' AND claim_mode IS NOT NULL) OR
    (claim_type = 'advance' AND claim_mode IS NULL)
  ),
  -- installment_id ต้องมีก็ต่อเมื่อ claim_mode='installment' เท่านั้น — ใช้ IS DISTINCT FROM กัน 3-valued-logic
  -- ของ NULL=NULL ที่ปกติจะ evaluate เป็น NULL (ผ่านเสมอ) แทนที่จะเป็น false ตอนเจอค่าที่ไม่ควรผ่าน
  CONSTRAINT client_progress_claims_installment_pair_check CHECK (
    (claim_mode = 'installment' AND installment_id IS NOT NULL) OR
    (claim_mode IS DISTINCT FROM 'installment' AND installment_id IS NULL)
  ),
  -- ห้ามรับรองเกินยอดที่ขอ (certified_amount <= requested_amount) — NULL ผ่านเสมอ (ยังไม่ certify)
  CONSTRAINT client_progress_claims_certified_bounds_check CHECK (
    certified_amount IS NULL OR certified_amount <= requested_amount
  ),
  -- ถ้ารับรองไม่เท่าที่ขอ ต้องมี certify_note อธิบายเหตุผลเสมอ (เคส "จำนวนตรวจสอบไม่เท่าเดิม")
  CONSTRAINT client_progress_claims_certified_note_check CHECK (
    certified_amount IS NULL OR certified_amount = requested_amount OR certify_note <> ''
  )
);
CREATE INDEX idx_client_progress_claims_company ON client_progress_claims(company_id);
CREATE INDEX idx_client_progress_claims_project ON client_progress_claims(company_id, project_id);
CREATE INDEX idx_client_progress_claims_status ON client_progress_claims(company_id, status);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_installment_fk
  FOREIGN KEY (company_id, installment_id) REFERENCES client_project_installments(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_revenue_fk
  FOREIGN KEY (company_id, revenue_id) REFERENCES client_revenue(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_certified_by_fk
  FOREIGN KEY (company_id, certified_by) REFERENCES customers(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);

-- ================= 3) client_progress_claim_items (เฉพาะ claim_mode='boq') =================
CREATE TABLE client_progress_claim_items (
  id SERIAL PRIMARY KEY,
  progress_claim_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  budget_item_id INTEGER NOT NULL,
  requested_percent NUMERIC(5,2) NOT NULL CHECK (requested_percent > 0 AND requested_percent <= 100),
  requested_amount NUMERIC(18,2) NOT NULL CHECK (requested_amount >= 0), -- = budget_item.amount x requested_percent/100 คำนวณฝั่ง server
  certified_percent NUMERIC(5,2) CHECK (certified_percent IS NULL OR (certified_percent >= 0 AND certified_percent <= 100)),
  certified_amount NUMERIC(18,2) CHECK (certified_amount IS NULL OR certified_amount >= 0),
  UNIQUE (company_id, id),
  -- กัน budget_item เดิมถูกใส่ซ้ำสองบรรทัดในใบเดียวกัน — ถ้าซ้ำได้ SUM(requested_percent) ตอน approve
  -- จะเกิน 100% จริงโดยที่ผู้ใช้ไม่เห็นว่าเป็นเพราะใส่ซ้ำ ไม่ใช่เพราะเบิกเกินจริง
  UNIQUE (company_id, progress_claim_id, budget_item_id)
);
CREATE INDEX idx_client_progress_claim_items_claim ON client_progress_claim_items(progress_claim_id);
ALTER TABLE client_progress_claim_items ADD CONSTRAINT client_progress_claim_items_claim_fk
  FOREIGN KEY (company_id, progress_claim_id) REFERENCES client_progress_claims(company_id, id) ON DELETE CASCADE;
ALTER TABLE client_progress_claim_items ADD CONSTRAINT client_progress_claim_items_budget_item_fk
  FOREIGN KEY (company_id, budget_item_id) REFERENCES client_budget_items(company_id, id);

-- ================= 4) client_revenue_advance_applications (ledger การหักล้างเงินรับล่วงหน้า) =================
-- 1 แถว = 1 เหตุการณ์ "หัก X บาทจากเงินล่วงหน้าก้อนนี้ ไปลงในใบเบิกงวดนี้" — เก็บแยกจาก
-- client_revenue.applied_amount (ยอดสะสม) เพื่อให้สืบย้อนได้ว่าหักไปตอนไหน เข้าใบไหนบ้าง (อาจหักหลายครั้ง
-- จากเงินล่วงหน้าก้อนเดียวกันไปหลายงวด) เหมือนหลักการเดียวกับ client_purchase_request_item_adjustments
CREATE TABLE client_revenue_advance_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  advance_revenue_id INTEGER NOT NULL,
  progress_claim_id INTEGER NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  applied_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX idx_client_revenue_advance_applications_advance ON client_revenue_advance_applications(advance_revenue_id);
CREATE INDEX idx_client_revenue_advance_applications_claim ON client_revenue_advance_applications(progress_claim_id);
ALTER TABLE client_revenue_advance_applications ADD CONSTRAINT client_revenue_advance_applications_advance_fk
  FOREIGN KEY (company_id, advance_revenue_id) REFERENCES client_revenue(company_id, id);
ALTER TABLE client_revenue_advance_applications ADD CONSTRAINT client_revenue_advance_applications_claim_fk
  FOREIGN KEY (company_id, progress_claim_id) REFERENCES client_progress_claims(company_id, id);
ALTER TABLE client_revenue_advance_applications ADD CONSTRAINT client_revenue_advance_applications_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);

-- ================= 5) ขยาย CHECK เดิมให้รองรับ doc_type/rule doc_type ใหม่ =================
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term'));

ALTER TABLE client_pr_approval_rules DROP CONSTRAINT client_pr_approval_rules_doc_type_check;
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_doc_type_check
  CHECK (doc_type IN ('pr','po_wo','petty_cash','advance','other','progress'));

-- ================= 6) สิทธิ์ใหม่ 2 ตัว =================
-- can_certify_progress: ยืนยันว่าผลงานจริงตามที่อ้าง — ไม่ผ่าน canApprove()/เพดานวงเงิน (การตรวจสอบผลงาน
-- ไม่มีแนวคิดเรื่อง "เพดานบาท" แบบสิทธิ์อนุมัติธุรกรรม) เช็คแค่ certifier.id <> claim.created_by ที่ชั้นแอป
-- can_approve_progress: อนุมัติจริง ผ่าน canApprove() ปกติ (doc_type='progress' เพิ่มใน CHECK ข้อ 5 แล้ว)
-- self-block ของ approve ครอบคลุมถึง certifier ด้วย (originators = [created_by, submitted_by, certified_by])
-- ตามที่ตกลง — เข้มกว่าเอกสารประเภทอื่นที่ครอบแค่ created_by/submitted_by เพราะมี 3 ขั้นตอนแยกคนกันจริง
ALTER TABLE customers ADD COLUMN can_certify_progress BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN can_approve_progress BOOLEAN NOT NULL DEFAULT false;

-- ================= 7) ผังบัญชีใหม่: เงินรับล่วงหน้าจากลูกค้า =================
-- backfill เข้าทุกบริษัทที่มีอยู่แล้ว (DEFAULT_CLIENT_CHART_OF_ACCOUNTS ในโค้ดก็ต้องแก้คู่กันสำหรับบริษัทใหม่
-- ในอนาคต — แก้ไฟล์ server.js แยกต่างหาก ไม่ใช่ส่วนของ migration นี้)
INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT id, '2160', 'เงินรับล่วงหน้าจากลูกค้า', 'liability' FROM customer_companies
ON CONFLICT (company_id, code) DO NOTHING;
