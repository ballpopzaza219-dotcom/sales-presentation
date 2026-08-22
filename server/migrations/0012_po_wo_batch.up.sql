-- หัวข้อ 5 (PO/WO) — Batch 1: เขียนใหม่ทั้งหมดตามมาตรฐาน CLAUDE.md
--
-- client_purchase_orders เดิม (มีมาก่อนโมดูล client ledger/PR ทั้งชุด) ไม่ผ่านมาตรฐานสักข้อ: ไม่มี
-- composite FK, ไม่มี approval workflow (แค่ pending/ordered/received/cancelled), ไม่มี idempotency,
-- ไม่มี audit log, items เก็บเป็น JSONB ก้อนเดียวไม่มี id ต่อบรรทัด (ทำให้ผูกกับ
-- client_purchase_request_items ไม่ได้เลย — คือสาเหตุที่ consume/release ของหัวข้อ 4 ยังใช้งานจริงไม่ได้
-- จนถึงตอนนี้), DELETE เป็น hard delete จริง (ทุกตารางอื่นในระบบใช้ cancel/void แทนทั้งหมด) — ตรวจสอบแล้ว
-- ว่ามี 0 แถวทุกบริษัทในระบบจริง (ไม่มีข้อมูลต้อง migrate) และมี FK จากภายนอกมาแค่จุดเดียว
-- (client_purchase_request_item_adjustments.po_id) จึง DROP+CREATE ใหม่ในไฟล์นี้แทนการค่อยๆ ALTER
--
-- WO (หนังสือสั่งจ้างผู้รับเหมาช่วง) คือเอกสารเดียวกับ client_subcontract_terms ที่เคยร่างไว้ใน
-- server/docs/subcontractor-module-plan.md ส่วน 4 (ยังไม่เคยมี migration จริงมาก่อน) — ยกมาสร้างในหัวข้อ 5
-- นี้แทนที่จะรอหัวข้อ 2 เพราะหัวข้อ 2 (เบิกงวดตามสัญญา) ต้องอ้างอิง WO ที่มีอยู่แล้วเป็นเงื่อนไขเบื้องต้น

-- ---------------- ใบสั่งซื้อวัสดุ (Purchase Orders) ----------------
ALTER TABLE client_purchase_request_item_adjustments DROP CONSTRAINT client_pr_item_adjustments_po_fk;
DROP TABLE client_purchase_orders;

CREATE TABLE client_purchase_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  po_no TEXT,   -- NULL จนกว่าจะ /submit (เหตุผลเดียวกับ pr_no/voucher_no ทุกโมดูลก่อนหน้า)
  project_id INTEGER,   -- nullable โดยเจตนา (ของเดิมก็ nullable) — PO บางใบไม่ผูกโครงการเฉพาะ (เช่น ของใช้สำนักงานกลาง)
  supplier_name TEXT NOT NULL,
  supplier_contact TEXT NOT NULL DEFAULT '',
  -- คง text อิสระเหมือนของเดิม ไม่เปลี่ยนเป็น FK -> client_external_payees ตามที่ตกลง (คนละ concept กัน —
  -- external_payees คือ "ผู้รับเงิน" ของใบจ่ายเงินสด/โอนในโมดูล 1.4, supplier ของ PO คือคู่ค้าซื้อวัสดุ
  -- อาจไม่ได้จ่ายผ่านระบบนี้เลยด้วยซ้ำในเฟสนี้) — ⚠️ known limitation ที่ตั้งใจรับไว้: วันหน้าถ้าต้องรวมยอด
  -- ซื้อรายผู้ขาย (เช่น "ปีนี้ซื้อจากร้าน A รวมเท่าไหร่") จะเจอปัญหาชื่อไม่ตรงกันแบบเดียวกับที่เคยแก้ไปแล้ว
  -- ใน client_external_payees/client_subcontractors (ต้องมี normalize_payee_name() + unique index กันซ้ำ)
  -- — บันทึกไว้ใน server/docs/pr-module-known-limitations.md ด้วย
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  payment_terms TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  -- total_amount: server เขียนจาก SUM(items.amount) เสมอในทรานแซกชันเดียวกับที่แก้ items (ห้ามเชื่อค่าจาก
  -- client) — รูปแบบเดียวกับ client_purchase_requests.total_amount เป๊ะ
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, po_no)
);
CREATE INDEX idx_client_purchase_orders_company ON client_purchase_orders(company_id);
CREATE INDEX idx_client_purchase_orders_status ON client_purchase_orders(company_id, status);
CREATE INDEX idx_client_purchase_orders_project ON client_purchase_orders(project_id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);

-- คืน FK เดิมของ adjustments.po_id ให้ชี้กลับมาที่ตารางใหม่ (ชื่อตารางเดิม โครงสร้างใหม่)
ALTER TABLE client_purchase_request_item_adjustments ADD CONSTRAINT client_pr_item_adjustments_po_fk
  FOREIGN KEY (company_id, po_id) REFERENCES client_purchase_orders(company_id, id);

-- pr_item_id เป็น NULLABLE โดยเจตนา (ต่างจากที่ร่างไว้ตอนแรกว่าจะ NOT NULL) — เคสซื้อด่วนหน้างานที่ไม่ผ่าน
-- PR มีจริงในงานก่อสร้าง เหมือนกับที่ client_purchase_request_items.budget_item_id เป็น NULL ได้เมื่อ
-- PR source='manual' (ไม่อ้างอิง BOQ) — บรรทัดที่มี pr_item_id จะถูก auto-consume ตอน PO /approve,
-- บรรทัดที่ไม่มีจะถูกข้ามไปเฉยๆ ไม่ error (ดู server.js's PO approve handler เมื่อเขียนจริง)
--
-- ⚠️ กฎกันเบิกเกินที่ชั้น API ต้องทำตามเสมอ (DB บังคับด้วย CHECK ธรรมดาไม่ได้ เพราะต้องเทียบกับ
-- qty_remaining ของ client_purchase_request_items ซึ่งเป็นอีกตารางหนึ่ง): ต้องเช็คทั้งตอน /submit
-- (เตือนล่วงหน้า) และ /approve (บังคับจริง ห้ามเชื่อผลจาก submit เพราะ PR item อาจถูกตัดยอดจากที่อื่นไป
-- ระหว่างนั้น) — SUM(qty) ต่อ pr_item_id ของทุกบรรทัดใน PO ใบนี้ ต้องไม่เกิน qty_remaining ที่ล็อกไว้
-- (FOR UPDATE) ของ PR item นั้น ถ้าเกิน reject ทั้งใบ 400 พร้อมระบุบรรทัด/จำนวนที่เกิน ไม่ปล่อยให้ถึง
-- CHECK constraint ระดับ DB เลย
CREATE TABLE client_purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  pr_item_id INTEGER,
  idx INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  qty NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount NUMERIC(18,2) GENERATED ALWAYS AS (qty * unit_price) STORED,
  FOREIGN KEY (company_id, purchase_order_id) REFERENCES client_purchase_orders(company_id, id) ON DELETE CASCADE,
  UNIQUE (company_id, purchase_order_id, idx)
);
CREATE INDEX idx_client_purchase_order_items_po ON client_purchase_order_items(purchase_order_id);
CREATE INDEX idx_client_purchase_order_items_pr_item ON client_purchase_order_items(pr_item_id) WHERE pr_item_id IS NOT NULL;
ALTER TABLE client_purchase_order_items ADD CONSTRAINT client_purchase_order_items_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_purchase_order_items ADD CONSTRAINT client_purchase_order_items_pr_item_fk
  FOREIGN KEY (company_id, pr_item_id) REFERENCES client_purchase_request_items(company_id, id);

-- ⚠️ Cancel PO (ทุกสถานะรวม approved) จะ auto-release PR items ที่เคย consume ไปคืนทั้งหมดในทรานแซกชัน
-- เดียวกัน (เขียนตอนทำ server.js จริง) — ระบบตอนนี้ยังไม่มีกลไก "รับของ" (goods receipt) และไม่มี payment
-- voucher ผูกกับ PO เลยแม้แต่นิดเดียว จึงยัง cancel ได้อิสระทุกสถานะ **เมื่อมีระบบรับของในอนาคต ต้องเพิ่ม
-- เงื่อนไขห้าม cancel ถ้ารับของแล้วบางส่วน (mirror PR's qty_ordered>0 ก่อน cancel) และถ้ามี payment
-- voucher อ้างอิง PO นี้แล้วต้องบล็อกด้วย** — บันทึกไว้ใน known-limitations ด้วย อย่าลืมตอนต่อระบบรับของจริง

-- ---------------- หนังสือสั่งจ้างผู้รับเหมาช่วง (Work Order / สัญญา) ----------------
-- client_subcontract_terms — เอกสารเดียวกับที่ร่างไว้ใน subcontractor-module-plan.md ส่วน 4 บวก
-- contract_status คอลัมน์ใหม่ (ตกลงเพิ่มตอนวางแผนหัวข้อ 5) — แยก 2 มิติจากกันชัดเจน:
--   status         = สถานะอนุมัติ "เอกสาร WO" (draft/submitted/approved/rejected/cancelled) มาตรฐาน
--                    เดียวกับทุกเอกสารในระบบ
--   contract_status = สถานะ "อายุสัญญา" หลังอนุมัติแล้วเท่านั้น (active/completed/terminated) — NULL
--                    ตลอดเวลาที่ status ยังไม่ใช่ approved, ต้องมีค่าเสมอทันทีที่ approved (บังคับด้วย
--                    CHECK คู่ด้านล่าง) — เอกสารเดิมที่ร่างไว้มีแค่มิติเดียว (draft/active/completed/
--                    terminated ปนกัน) ทำให้แยกไม่ออกว่า "ยังไม่อนุมัติ" กับ "อนุมัติแล้วแต่ยังไม่เริ่มงาน"
CREATE TABLE client_subcontract_terms (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  subcontractor_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  contract_no TEXT,   -- เลขที่ WO — NULL จนกว่าจะ /submit
  contract_value NUMERIC(18,2) NOT NULL CHECK (contract_value > 0),
  advance_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (advance_percent >= 0 AND advance_percent <= 100),
  retention_percent NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (retention_percent >= 0 AND retention_percent <= 100),
  wht_income_type_code TEXT NOT NULL DEFAULT '40_7' REFERENCES client_wht_income_types(code),
  -- NULL = ใช้ default_rate จาก client_wht_income_types ตอนคำนวณจริงเสมอ (ไม่ copy มา snapshot ตอนสร้าง
  -- สัญญา) มีค่า = override เฉพาะสัญญานี้ (เหตุผลเดียวกับ client_advance_clearance_items.wht_rate)
  -- ⚠️ 40_1 (เงินเดือน) มี default_rate เป็น NULL ตามกฎ CLAUDE.md ข้อ 17 (คำนวณตามอัตราก้าวหน้า ไม่ใช่ %
  -- คงที่) — ถ้าสัญญานี้เลือก wht_income_type_code='40_1' แล้ว wht_rate (คอลัมน์นี้) ก็เป็น NULL ด้วย
  -- (ไม่ override) โค้ดฝั่ง server.js ที่คำนวณ WHT ตอน approve billing (หัวข้อ 2) ต้อง throw/ปฏิเสธ 400
  -- ทันทีที่เจอทั้งคู่เป็น NULL พร้อมกัน ห้าม fallback เป็น 0 เด็ดขาด (0 สื่อความหมายผิดว่า "ไม่ต้องหักภาษี")
  wht_rate NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  contract_status TEXT CHECK (contract_status IN ('active','completed','terminated')),
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  start_date DATE,
  end_date DATE,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, contract_no),
  -- ตั้งชื่อไม่ให้ชนกับ constraint ที่ Postgres auto-generate ให้คอลัมน์ contract_status เอง (column-level
  -- CHECK ด้านบนจะได้ชื่ออัตโนมัติ client_subcontract_terms_contract_status_check พอดี — ชนชื่อตรงๆ ถ้าตั้ง
  -- ชื่อ table-level constraint นี้แบบเดียวกัน พบจริงตอน apply migration นี้ครั้งแรก)
  CONSTRAINT client_subcontract_terms_status_pair_check CHECK (
    (status = 'approved' AND contract_status IS NOT NULL) OR
    (status <> 'approved' AND contract_status IS NULL)
  ),
  CONSTRAINT client_subcontract_terms_date_range_check CHECK (
    end_date IS NULL OR start_date IS NULL OR end_date >= start_date
  )
);
CREATE INDEX idx_client_subcontract_terms_company ON client_subcontract_terms(company_id);
CREATE INDEX idx_client_subcontract_terms_status ON client_subcontract_terms(company_id, status);
CREATE INDEX idx_client_subcontract_terms_project ON client_subcontract_terms(project_id);
CREATE INDEX idx_client_subcontract_terms_subcontractor ON client_subcontract_terms(subcontractor_id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_subcontractor_fk
  FOREIGN KEY (company_id, subcontractor_id) REFERENCES client_subcontractors(company_id, id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_subcontract_terms ADD CONSTRAINT client_subcontract_terms_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);

-- ---------------- สิทธิ์อนุมัติ ----------------
-- ใช้ doc_type='po_wo' ที่เตรียมไว้แล้วตั้งแต่ migration 0002 (client_pr_approval_rules_doc_type_check
-- มี 'po_wo' อยู่แล้ว ไม่ต้องแก้ CHECK เพิ่ม) — PO และ WO ใช้สิทธิ์อนุมัติร่วมกันตามที่คอมเมนต์เดิมใน
-- server.js (APPROVAL_RULE_DOC_TYPES) ตั้งใจไว้ตั้งแต่ต้น ("จะกำหนดคอลัมน์ตอนเขียนโมดูลข้อ 2")
-- ส่วนสิทธิ์ "จัดการ" (สร้าง/แก้ไข/consume-release) ใช้ can_manage_po เดิมร่วมกันทั้งคู่เช่นกัน
-- (เหตุผลเดียวกับที่ subcontractor master data ใช้ flag นี้ร่วมอยู่แล้ว — งานฝั่งจัดซื้อ/จัดหาแบบเดียวกัน)

-- ---------------- Audit log ----------------
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term'));
