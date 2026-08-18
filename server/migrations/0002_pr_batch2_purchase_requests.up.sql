-- PR Module (จัดซื้อวัสดุ) — Batch 2: ข้อ 4 (บันทึกใบขอซื้อ) — backend จริงตัวแรกของฟีเจอร์นี้
-- (DB.prs เดิมใน pr-system.html ไม่มี backend เลย). ใช้ lesson ทุกข้อจาก batch 1 ตั้งแต่ต้น:
-- composite FK ทุกจุดที่ client เลือกค่าได้, direct company_id FK บนทุกตารางลูก, voided_by/voided_at
-- คู่กับ submitted_by/approved_by เสมอ, เลขที่เอกสารออกตอน submit ไม่ใช่ตอนสร้าง

-- ต้องมีก่อน budget_item_id/po_id composite FK ด้านล่างใช้ได้ (ตารางเดิมทั้งคู่ไม่เคยมี
-- UNIQUE(company_id,id) มาก่อนเซสชันนี้เลย — ตรวจสอบจริงจาก DB แล้ว)
ALTER TABLE client_budget_items ADD CONSTRAINT client_budget_items_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_company_id_id_key UNIQUE (company_id, id);

-- customers_company_id_id_key ถูกสร้างไปแล้วใน batch 1 (schema_migrations ต้องมี 0001 apply แล้วก่อน
-- batch นี้เสมอ) — ไม่สร้างซ้ำที่นี่ ใช้ของเดิมได้เลย

-- 'voided' ไม่มีในสถานะของตารางนี้ (ต่างจาก client_payment_vouchers/client_advance_clearances ใน
-- batch 1) โดยเจตนา: PR ไม่เคย post journal เลย (เป็นแค่ commitment เหมือน PO/quotation เดิม) จึงไม่มี
-- อะไรต้อง "reversing entry" หลังอนุมัติแล้ว — 'cancelled' ใช้ได้ทั้งก่อนและหลังอนุมัติสำหรับตารางนี้
-- โดยเฉพาะ (ไม่เหมือนตารางที่ post journal ซึ่งต้องแยก cancel ก่อนอนุมัติ ออกจาก void หลังอนุมัติ)
-- source='boq' ต้องมี budget_revision_id เสมอ, 'manual' ต้องไม่มี — DB บังคับคู่นี้ตรงๆ ได้ แต่
-- "ทุกบรรทัดใน items ต้องมี budget_item_id เมื่อ source='boq'" เป็นกฎข้าม (parent, child) ตาราง ซึ่ง
-- CHECK ธรรมดาทำไม่ได้ (ต้องใช้ trigger ซึ่งโค้ดเบสนี้ไม่มีที่ไหนเลย) — บังคับที่ชั้น API ตอน /submit
-- แทน (validate items ทั้งหมดก่อนเปลี่ยน status)
CREATE TABLE client_purchase_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  pr_no TEXT,   -- NULL จนกว่าจะ /submit (เหตุผลเดียวกับ voucher_no ใน batch 1)
  project_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('boq','manual')),   -- ข้อ 4.1.1 vs 4.1.2
  budget_revision_id INTEGER,
  requested_by INTEGER,   -- composite FK ด้านล่าง (เปลี่ยนจาก single-column ตามที่ตกลง)
  request_date DATE NOT NULL DEFAULT CURRENT_DATE,
  needed_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  submitted_by INTEGER,   -- composite FK ด้านล่าง
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,    -- composite FK ด้านล่าง
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  -- total_amount: server เขียนจาก SUM(items.estimated_amount) เสมอ ในทรานแซกชันเดียวกับที่แก้ items
  -- (กฎเดียวกับ total_expense_amount ของ client_advance_clearances ใน batch 1 — ห้ามเชื่อค่าจาก client)
  -- ⚠️ canApprove() ต้องเทียบเพดานกับ total_amount ของแถวนี้ (ค่าที่ถูกคำนวณ/บันทึกไว้แล้ว) เสมอ
  -- ห้ามคำนวณ SUM(items) ใหม่ตอนอนุมัติ — ถ้าคำนวณใหม่ตอนนั้นแล้วดันไม่ตรงกับตอน submit (เช่น items
  -- ถูกแก้ไปหลัง submit ด้วยบั๊กอื่น) จะกลายเป็นอนุมัติโดยเทียบกับยอดคนละยอดที่ผู้อนุมัติเห็นตอนตัดสินใจ
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- approved_amount: บันทึก ณ เวลา approve ว่าอนุมัติที่ยอดเท่าไหร่ (snapshot ของ total_amount ตอนนั้น)
  -- เพื่อตรวจสอบย้อนหลังได้ว่าผู้อนุมัติมีเพดานพอจริงหรือไม่ ณ เวลาที่อนุมัติ แม้ total_amount ปัจจุบัน
  -- จะเปลี่ยนไปแล้วในภายหลัง (ถ้ามีการแก้ไขหลังอนุมัติ — แม้ปกติไม่ควรทำได้แล้วก็ตาม)
  approved_amount NUMERIC(18,2),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, pr_no),
  CONSTRAINT client_purchase_requests_source_budget_check CHECK (
    (source = 'boq' AND budget_revision_id IS NOT NULL) OR
    (source = 'manual' AND budget_revision_id IS NULL)
  )
);
-- ข้อจำกัดเพิ่มเติมที่บังคับที่ชั้น API เท่านั้น (CHECK ธรรมดาทำไม่ได้ ต้องดูข้ามแถว/ข้ามตาราง):
--   1. ยกเลิก PR (/cancel) ได้เฉพาะเมื่อทุกบรรทัด items มี qty_ordered=0 เท่านั้น — ถ้ามีบรรทัดใดถูก
--      consume ไปแล้ว (qty_ordered>0) ต้องปฏิเสธการยกเลิก ไม่งั้นจะเกิด PO ที่ยังอ้างอิง PR ที่ถูก
--      ยกเลิกไปแล้ว (PR บอกว่ายกเลิก แต่ PO ที่ตัดยอดไปแล้วยังคงอยู่ อ้างถึงเอกสารต้นทางที่ไม่ valid แล้ว)
--   2. เมื่อ source='boq': budget_item_id ของทุกบรรทัดใน items ต้องอยู่ภายใต้ budget_revision_id
--      เดียวกับที่ระบุไว้ที่หัวเอกสารนี้เท่านั้น (ตรวจตอน /submit เช่นเดียวกับกฎ "budget_item_id ต้อง
--      NOT NULL เมื่อ boq" ข้างบน) — ป้องกัน PR หนึ่งใบดึงรายการจาก BOQ คนละ revision กันมาปนกัน
CREATE INDEX idx_client_purchase_requests_company ON client_purchase_requests(company_id);
CREATE INDEX idx_client_purchase_requests_status ON client_purchase_requests(company_id, status);
CREATE INDEX idx_client_purchase_requests_project ON client_purchase_requests(project_id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_budget_revision_fk
  FOREIGN KEY (company_id, budget_revision_id) REFERENCES client_budget_revisions(company_id, id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_requested_by_fk
  FOREIGN KEY (company_id, requested_by) REFERENCES customers(company_id, id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
ALTER TABLE client_purchase_requests ADD CONSTRAINT client_purchase_requests_company_id_id_key UNIQUE (company_id, id);

-- qty_remaining/estimated_amount เป็น generated column เสมอ — ป้องกันข้อมูลสองที่ขัดแย้งกันโดย
-- ธรรมชาติของ constraint เอง (Postgres ห้าม UPDATE ทับตรงๆ)
-- purchase_request_id เป็น composite FK โดยเจตนา (ต่างจาก client_journal_entry_lines.journal_entry_id
-- เดิมที่ไม่ composite) เพราะตารางนี้มี endpoint /consume /release /cancel-qty รับ :itemId จาก client
-- ในคำขอทีหลัง ไม่ใช่แค่ตอนสร้างพร้อมแม่
--
-- ⚠️ กฎการ UPDATE qty_ordered/qty_cancelled ที่ชั้น API ต้องทำตามเสมอ (DB บังคับไม่ได้ตรงๆ ด้วย CHECK
-- เฉยๆ เพราะเป็นเรื่อง concurrency ไม่ใช่ความถูกต้องของค่า ณ ขณะใดขณะหนึ่ง):
--   1. ต้อง UPDATE แบบ "สัมพัทธ์" เท่านั้น เช่น
--        UPDATE client_purchase_request_items SET qty_ordered = qty_ordered + $1 WHERE id=$2
--      ห้ามอ่านค่าปัจจุบันมาคำนวณในโค้ดแอปแล้วเขียนค่าสัมบูรณ์กลับ (SET qty_ordered = <ค่าที่คำนวณมา>)
--      — ถ้าทำแบบหลัง สอง request consume พร้อมกัน (concurrent) จะอ่านค่าตั้งต้นเดียวกัน แล้วเขียนทับ
--      กันเอง (lost update) ได้ผลลัพธ์เหมือนมีแค่ request เดียวเกิดขึ้นจริง ทั้งที่ CHECK constraint
--      (qty_ordered+qty_cancelled<=qty_requested) จะยังผ่านอยู่ปกติเพราะมันเช็คแค่ค่าสุดท้าย ณ ตอน
--      commit ไม่รู้เรื่อง lost update ที่เกิดระหว่างทาง
--   2. การ UPDATE นี้ กับการ INSERT ลง client_purchase_request_item_adjustments ต้องอยู่ใน
--      ทรานแซกชันเดียวกันเสมอ (กฎเดียวกับที่ total_expense_amount ของ batch 1 ต้องคำนวณใหม่ในทรานแซกชัน
--      เดียวกับที่แก้ items) ไม่งั้น log กับยอด denormalized จะไม่ตรงกันถ้า process ตายกลางทาง
CREATE TABLE client_purchase_request_items (
  id SERIAL PRIMARY KEY,
  purchase_request_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  budget_item_id INTEGER,   -- NULL เมื่อ PR ไม่ได้ดึงจาก BOQ (ข้อ 4.1.2)
  idx INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  qty_requested NUMERIC(18,4) NOT NULL CHECK (qty_requested > 0),
  qty_ordered NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_cancelled NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_remaining NUMERIC(18,4) GENERATED ALWAYS AS (qty_requested - qty_ordered - qty_cancelled) STORED,
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  estimated_amount NUMERIC(18,2) GENERATED ALWAYS AS (qty_requested * unit_price) STORED,
  CHECK (qty_ordered >= 0 AND qty_cancelled >= 0 AND qty_ordered + qty_cancelled <= qty_requested),
  FOREIGN KEY (company_id, purchase_request_id) REFERENCES client_purchase_requests(company_id, id) ON DELETE CASCADE,
  UNIQUE (company_id, purchase_request_id, idx)
);
CREATE INDEX idx_client_purchase_request_items_pr ON client_purchase_request_items(purchase_request_id);
-- Postgres ไม่สร้าง index บนคอลัมน์ FK ให้อัตโนมัติ (ต่างจาก PRIMARY KEY/UNIQUE ที่มีมาให้เสมอ) —
-- ต้องเพิ่มเองเสมอสำหรับ FK ที่จะถูก query บ่อย (join/lookup ย้อนกลับจาก budget_item_id)
CREATE INDEX idx_client_purchase_request_items_budget_item ON client_purchase_request_items(budget_item_id);
ALTER TABLE client_purchase_request_items ADD CONSTRAINT client_purchase_request_items_budget_item_fk
  FOREIGN KEY (company_id, budget_item_id) REFERENCES client_budget_items(company_id, id);
ALTER TABLE client_purchase_request_items ADD CONSTRAINT client_purchase_request_items_company_id_id_key UNIQUE (company_id, id);

-- ประวัติ consume/release/cancel (ข้อ 4.4) — log แยก ไม่ทับค่าเดิม เพื่อ audit ว่าใคร/เมื่อไหร่/เท่าไหร่
-- consume: PO ตัดยอด (qty_ordered += qty, บังคับ po_id) | release: PO ถูกยกเลิก/ลด คืนยอด
-- (qty_ordered -= qty, บังคับ po_id เดียวกับตอน consume) | cancel: ผู้มีสิทธิ์ลดยอดเองไม่ผ่าน PO
-- (qty_cancelled += qty, ต้องไม่มี po_id) — แอปต้อง insert แถวนี้ + UPDATE qty_ordered/qty_cancelled
-- บน item ในทรานแซกชันเดียวกันเสมอ (ยอด denormalized คือ cache ของผลรวม log นี้)
--
-- ⚠️ กฎที่ชั้น API ต้องตรวจก่อน insert แถว 'release' เสมอ (DB บังคับด้วย CHECK ธรรมดาไม่ได้ เพราะต้อง
-- SUM ข้ามหลายแถวของ po_id เดียวกัน): SUM(qty ของแถว release ที่มี po_id นี้) ต้องไม่เกิน
-- SUM(qty ของแถว consume ที่มี po_id เดียวกัน) — ไม่งั้นจะ "คืนยอด" เกินกว่าที่เคย "ตัดยอด" ไปจริง
-- ทำให้ PR item ดูเหมือนมี qty_remaining เหลือมากกว่าที่ควร แล้วเปิด PO ใบใหม่ตัดยอดซ้ำเกินจำนวนที่ขอ
-- ซื้อจริงได้ — ต้องเช็คในทรานแซกชันเดียวกับที่จะ insert (lock แถวที่เกี่ยวข้องกันก่อนถ้าจำเป็น กัน
-- concurrent release พร้อมกันสอง request หลบเช็คนี้ได้เหมือนปัญหา lost-update ของ qty_ordered ข้างบน)
CREATE TABLE client_purchase_request_item_adjustments (
  id SERIAL PRIMARY KEY,
  pr_item_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('consume','release','cancel')),
  qty NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  po_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, pr_item_id) REFERENCES client_purchase_request_items(company_id, id) ON DELETE CASCADE,
  CONSTRAINT client_pr_item_adjustments_po_id_check CHECK (
    (adjustment_type IN ('consume','release') AND po_id IS NOT NULL) OR
    (adjustment_type = 'cancel' AND po_id IS NULL)
  )
);
CREATE INDEX idx_client_pr_item_adjustments_item ON client_purchase_request_item_adjustments(pr_item_id);
-- ใช้โดยการเช็ค SUM(release) <= SUM(consume) ต่อ po_id ที่คอมเมนต์ข้างบนอธิบายไว้ — partial เพราะ
-- 'cancel' แถวไม่มี po_id เลย (NULL เสมอตาม CHECK ข้างบน) ไม่มีประโยชน์ที่จะ index ไว้
CREATE INDEX idx_client_pr_item_adjustments_po ON client_purchase_request_item_adjustments(po_id) WHERE po_id IS NOT NULL;
ALTER TABLE client_purchase_request_item_adjustments ADD CONSTRAINT client_pr_item_adjustments_po_fk
  FOREIGN KEY (company_id, po_id) REFERENCES client_purchase_orders(company_id, id);

-- ---------------- สิทธิ์อนุมัติ (ข้อ 4.3) ----------------
ALTER TABLE customers ADD COLUMN can_approve_pr BOOLEAN NOT NULL DEFAULT false;

-- กฎช่วงวงเงินต่อ user — canApprove() query ตารางนี้จริง: ต้องมี flag ตรงประเภทเอกสาร AND ต้องมี rule
-- ที่ user ถูกกำหนดสิทธิ์ไว้จริงซึ่งจำนวนเงินไม่เกิน max_amount ของ rule นั้น — ไม่มี rule = ปฏิเสธ
-- (secure-by-default ไม่ใช่ผ่านโดยปริยาย) ต่อ user โดยตรง (ไม่ใช่ระดับบริษัทเฉยๆ) จึงมี
-- approver_customer_id. doc_type ครอบทั้ง 3 ค่าตั้งแต่ต้น (เหมือน client_document_audit_log.doc_type
-- ใน batch 1 ที่ครอบทุก doc_type ในอนาคตไว้ตั้งแต่แรกเพราะเป็น shared infra) แม้ batch นี้จะมีแค่
-- caller ของ 'pr' เท่านั้น — 'po_wo'/'petty_cash' จะมี caller จริงเมื่อเขียน routes ของหัวข้อ 2/1 ทีหลัง
--
-- max_amount เป็น NOT NULL โดยเจตนา — ไม่มีแนวคิด "ไม่จำกัดวงเงิน" ในตารางนี้ ผู้ที่อนุมัติได้ทุกยอด
-- ต้องใส่ตัวเลขสูงจริง (เช่น 999999999) ไม่ใช่ปล่อย NULL แล้วตีความว่า "ไม่จำกัด" — ทำแบบนี้เพื่อให้
-- รายงาน/หน้าจัดการสิทธิ์แสดง "เพดานที่แท้จริง" ของแต่ละคนได้ตรงไปตรงมาเสมอ ไม่ต้องมีเงื่อนไขพิเศษ
-- แยกกรณี NULL=ไม่จำกัด ในทุกจุดที่ query ตารางนี้
--
-- ⚠️ canApprove() ต้อง WHERE is_active=true เสมอทุกครั้งที่ query ตารางนี้ — แถวที่ is_active=false
-- คือสิทธิ์ที่ถูกเพิกถอนแล้ว (ไม่ลบทิ้งเพื่อเก็บประวัติ) ถ้าลืมกรองจะกลายเป็นให้สิทธิ์ที่ถูกเพิกถอนไปแล้ว
-- กลับมาใช้งานได้อีกโดยไม่ตั้งใจ
CREATE TABLE client_pr_approval_rules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  approver_customer_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('pr','po_wo','petty_cash')),
  min_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(18,2) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_amount >= min_amount)
);
CREATE INDEX idx_client_pr_approval_rules_lookup ON client_pr_approval_rules(company_id, approver_customer_id, doc_type);
ALTER TABLE client_pr_approval_rules ADD CONSTRAINT client_pr_approval_rules_approver_fk
  FOREIGN KEY (company_id, approver_customer_id) REFERENCES customers(company_id, id);
-- หนึ่ง user หนึ่ง doc_type มีได้แถว active พร้อมกันแค่แถวเดียว — ไม่งั้น canApprove() จะกำกวมว่าจะยึด
-- แถวไหน (เช่น สอง rule ที่วงเงินไม่เท่ากันสำหรับ user+doc_type เดียวกัน) ต้องการแก้เพดานให้ปิด
-- (is_active=false) แถวเดิมก่อนแล้วค่อยเปิดแถวใหม่ ไม่ใช่มีสองแถว active พร้อมกัน
CREATE UNIQUE INDEX uq_client_pr_approval_rules_active
  ON client_pr_approval_rules(company_id, approver_customer_id, doc_type) WHERE is_active;
