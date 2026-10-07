-- ---------------- Client Contract (ข้อ 11 ของ Master Blueprint) ----------------
-- สัญญาหลักระหว่างบริษัท (ผู้รับจ้าง) กับลูกค้า (เจ้าของโครงการ) — คู่ขนานทิศทางตรงข้ามกับ
-- client_subcontract_terms (migration 0012, สัญญาฝั่งผู้รับเหมาช่วง: ที่นั่นบริษัทเราเป็นผู้จ้าง
-- ที่นี่บริษัทเราเป็นผู้ถูกจ้าง) ใช้โครงสร้างคอลัมน์/constraint pattern เดียวกันทุกจุดที่สมเหตุสมผล
--
-- 1 โครงการมีได้หลายสัญญา (เผื่อ amendment/change order ในอนาคต) แต่ตามปกติธุรกิจจะมีสัญญาหลักใบเดียว
-- ต่อโครงการ — สัญญาใบแรกใช้ BOQ ของโครงการเดิมร่วมกัน (client_budgets, budget_scope='project') ไม่
-- สร้าง BOQ scope ใหม่ให้ เพราะ client_budgets บังคับ "1 budget ต่อ 1 โครงการ" อยู่แล้วด้วย
-- uq_client_budgets_project (unique partial index) — การแยก BOQ ต่อสัญญาเป็นงานคนละ phase ถ้ามีความ
-- ต้องการจริงในอนาคต (ตัดสินใจร่วมกับเจ้าของระบบแล้วว่าไม่ทำตอนนี้)
--
-- contract_value แยกความหมายจาก client_projects.budget_amount โดยตั้งใจ ไม่ sync กัน:
--   budget_amount = งบที่ตั้งไว้ใช้จ่าย (ฝั่งต้นทุน), contract_value = มูลค่าที่เซ็นกับลูกค้า (ฝั่งรายรับ)
--   สองค่านี้ไม่จำเป็นต้องเท่ากัน (มี margin)
--
-- Progress Claim (client_progress_claims) ยังไม่ผูกกับตารางนี้ — คง project_id ตรงๆ แบบเดิมไปก่อน
-- ตามที่เจ้าของระบบตัดสินใจไว้ (ลดความเสี่ยงต่อโมดูลที่เสร็จแล้ว 90%+)
--
-- สิทธิ์สร้าง/อนุมัติ: super_user เท่านั้นไปก่อน (ยังไม่มี flag แยกสำหรับ Contract) — ตรวจใน server.js
-- ด้วย req.customer.role === 'super_user' ตรงๆ ไม่ใช่คอลัมน์ boolean ใหม่ ตาม pattern ที่มีอยู่แล้วของ
-- canApprove ตัวอื่นที่ยัง fallback เป็น super_user-only (เทียบ CLAUDE.md ข้อ 14)
CREATE TABLE client_contracts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  tender_id INTEGER,  -- nullable — ไม่ใช่ทุกโครงการมาจาก tender ที่ชนะ
  -- parent_contract_id / revision_no: NULL/0 = สัญญาหลักของโครงการ, มีค่า = สัญญาเสริม (R1/R2/...) ที่
  -- ลูกค้าแก้ไขสัญญาหลัก — ไม่ใช่สัญญาอิสระเท่ากัน เปิดได้ทีละฉบับต่อสัญญาหลัก 1 ใบเท่านั้น (ดู
  -- uq_client_contracts_one_open_revision ด้านล่าง) revision_no ว่างได้ตอนยังเป็น draft (ยังไม่ออกเลข)
  -- ออกเลขจริงตอน /submit เท่านั้น (ตาม CLAUDE.md ข้อ 11 — ห้าม COUNT(*)/MAX() มาคำนวณ ใช้
  -- next_revision_seq ด้านล่างแบบเดียวกับ company_document_counters เพื่อไม่ให้เลขซ้ำแม้ R เก่าจะถูก
  -- cancel ไปแล้ว)
  parent_contract_id INTEGER,
  revision_no INTEGER,
  -- next_revision_seq: มีความหมายเฉพาะแถวสัญญาหลัก (parent_contract_id IS NULL) เป็น atomic counter
  -- สำหรับออกเลข R ถัดไปของสัญญานี้ — ล็อกแถวนี้ด้วย FOR UPDATE ก่อนอ่าน/เพิ่มค่าเสมอ (เพิ่มแบบสัมพัทธ์
  -- next_revision_seq = next_revision_seq + 1 ตาม CLAUDE.md ข้อ 5) ไม่มีความหมายบนแถว R เอง
  next_revision_seq INTEGER NOT NULL DEFAULT 1,
  contract_no TEXT,   -- เลขที่สัญญา — NULL จนกว่าจะ /submit (ออกเลขตอน submit เท่านั้น ตาม CLAUDE.md ข้อ 11)
                       -- รูปแบบ R: '{เลขสัญญาหลัก}-R{revision_no}' เช่น CT-2569-0001-R1
  contract_name TEXT NOT NULL DEFAULT '',
  -- สัญญาหลัก: มูลค่ารวมของสัญญา (> 0) — ใบ R: ส่วนต่างที่เพิ่ม/ลดจากยอดปัจจุบัน (<> 0, ติดลบได้) ตามที่
  -- เจ้าของระบบยืนยันแล้ว ดู client_contracts_value_check ด้านล่างแทนการ CHECK บนคอลัมน์ตรงๆ (ต้องรู้ค่า
  -- parent_contract_id ประกอบ) ยอดสัญญาปัจจุบันจริงต้องอ่านผ่าน VIEW client_contract_current_value
  -- ท้ายไฟล์นี้เท่านั้น ห้ามคำนวณ SUM เองกระจายไปตามจุดต่างๆ ของโค้ด
  contract_value NUMERIC(18,2) NOT NULL,
  -- deposit_percent/retention_percent/payment_terms: nullable โดยตั้งใจ — NULL = ใบ R นี้ไม่ได้แก้ไข
  -- ฟิลด์นี้ (ใช้ค่าจากสัญญาหลัก/R ก่อนหน้าต่อไป) มีค่า = ใบ R นี้ override เป็นค่านี้ ดู
  -- client_contract_effective_terms ท้ายไฟล์นี้สำหรับวิธีอ่านค่าที่ใช้จริง — ไม่มี DEFAULT ที่ระดับ DB
  -- เด็ดขาด (ทั้งของสัญญาหลักและ R) เพราะ DEFAULT 0/''ที่นี่จะกลายเป็น "override เงียบๆ" ของใบ R ที่ไม่ได้
  -- ตั้งใจแตะฟิลด์นั้นเลย คล้ายปัญหา NULL กับ 0 ใน CLAUDE.md ข้อ 17 — ค่าเริ่มต้นของสัญญาหลัก (deposit=0,
  -- payment_terms='') ให้ชั้นแอปใส่ตอนสร้างสัญญาหลักแทน (ไม่ใช่ DB DEFAULT) ส่วน retention_percent ของ
  -- สัญญาหลักไม่มีค่าเริ่มต้นเลยแม้แต่ในแอป ต้องกรอกเองเสมอตามที่เจ้าของระบบยืนยันไว้ — สัญญาหลักทั้ง 3
  -- ฟิลด์นี้ต้องไม่เป็น NULL บังคับด้วย client_contracts_root_required_fields_check ด้านล่าง
  deposit_percent NUMERIC(5,2) CHECK (deposit_percent >= 0 AND deposit_percent <= 100),
  retention_percent NUMERIC(5,2) CHECK (retention_percent >= 0 AND retention_percent <= 100),
  payment_terms TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  -- contract_status อธิบายอายุของสัญญาทั้งก้อน (ไม่ใช่ของใบ R แต่ละใบ) จึงมีความหมายเฉพาะแถวสัญญาหลัก
  -- เท่านั้น — บังคับร่วมกับ status ทั้งสองมิติ (approved/parent) ในข้อเดียวด้านล่าง
  -- (client_contracts_status_pair_check) แทนที่จะแยกสองข้อ เพราะแยกแล้วขัดกันเอง (R ที่ approved ต้อง
  -- "มี contract_status" ตามข้อเดิม แต่ต้อง "ไม่มี contract_status" ตามข้อ R — อนุมัติ R ไม่ได้เลย)
  contract_status TEXT CHECK (contract_status IN ('active','completed','terminated')),
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, contract_no),
  UNIQUE (parent_contract_id, revision_no),
  CONSTRAINT client_contracts_status_pair_check CHECK (
    (parent_contract_id IS NOT NULL AND contract_status IS NULL) OR
    (parent_contract_id IS NULL AND status = 'approved' AND contract_status IS NOT NULL) OR
    (parent_contract_id IS NULL AND status <> 'approved' AND contract_status IS NULL)
  ),
  CONSTRAINT client_contracts_date_range_check CHECK (
    end_date IS NULL OR start_date IS NULL OR end_date >= start_date
  ),
  -- สัญญาหลัก: มูลค่า > 0 เสมอ — ใบ R: ส่วนต่าง ห้ามเป็น 0 (ไม่มีความหมายถ้าไม่เปลี่ยนอะไรเลย) แต่ติดลบได้
  CONSTRAINT client_contracts_value_check CHECK (
    (parent_contract_id IS NULL AND contract_value > 0) OR
    (parent_contract_id IS NOT NULL AND contract_value <> 0)
  ),
  -- แก้ช่องโหว่ NULL-propagation ของ Postgres CHECK (ผลเป็น NULL = ผ่าน ไม่ใช่แค่ TRUE เท่านั้นที่ผ่าน) —
  -- รุ่นก่อนหน้าเขียน "revision_no = 0"/"revision_no > 0" เฉยๆ ซึ่งเมื่อ revision_no เป็น NULL จะได้ผล
  -- เป็น NULL (ไม่ใช่ FALSE) ทำให้ทั้งสัญญาหลักที่ revision_no เป็น NULL และ R ที่ submitted/approved แต่
  -- revision_no เป็น NULL ผ่าน CHECK ไปได้ทั้งคู่ — ต้องใส่ "revision_no IS NOT NULL AND" กำกับทุกแขนที่
  -- ตั้งใจให้ "ต้องมีค่า" ไว้อย่างชัดเจน ไม่พึ่งผลลัพธ์ NULL จากการเทียบค่าตรงๆ เด็ดขาด
  CONSTRAINT client_contracts_revision_no_check CHECK (
    (parent_contract_id IS NULL AND revision_no IS NOT NULL AND revision_no = 0) OR
    (parent_contract_id IS NOT NULL AND revision_no IS NULL AND status NOT IN ('submitted','approved')) OR
    (parent_contract_id IS NOT NULL AND revision_no IS NOT NULL AND revision_no > 0)
  ),
  -- สัญญาหลักต้องมีค่าครบทั้ง 3 ฟิลด์ที่ใบ R ยอมให้เป็น NULL ได้ (deposit_percent/retention_percent/
  -- payment_terms) — ใบ R ไม่ถูกบังคับเลย (เงื่อนไขแรกเป็นจริงทันทีถ้าเป็น R ข้ามการตรวจทั้งหมด)
  CONSTRAINT client_contracts_root_required_fields_check CHECK (
    parent_contract_id IS NOT NULL OR
    (deposit_percent IS NOT NULL AND retention_percent IS NOT NULL AND payment_terms IS NOT NULL)
  ),
  -- กัน R ส่งค่าว่าง ('') มา override payment_terms ของสัญญาหลักเป็นค่าว่างเงียบๆ — NULL (="ไม่แก้ไข
  -- ฟิลด์นี้") กับ '' (="แก้ไขเป็นข้อความว่างเปล่า") ต้องแยกความหมายกันชัดเจน เหมือนปัญหา NULL กับ 0 ใน
  -- CLAUDE.md ข้อ 17 — ฟอร์ม R ฝั่งแอปต้องแปลงค่าว่าง/ไม่ได้กรอกเป็น NULL เอง ไม่ส่ง '' มาตรงๆ เด็ดขาด
  -- (ดูกฎระดับแอปข้อ 6 ด้านล่าง)
  CONSTRAINT client_contracts_payment_terms_not_blank_check CHECK (
    parent_contract_id IS NULL OR payment_terms IS NULL OR btrim(payment_terms) <> ''
  )
);

CREATE INDEX idx_client_contracts_company ON client_contracts(company_id);
CREATE INDEX idx_client_contracts_status ON client_contracts(company_id, status);
CREATE INDEX idx_client_contracts_project ON client_contracts(project_id);
CREATE INDEX idx_client_contracts_customer ON client_contracts(customer_id);
CREATE INDEX idx_client_contracts_parent ON client_contracts(parent_contract_id);

-- 1 โครงการมีสัญญาหลักที่ "ยังอยู่" ได้ใบเดียว — ตัด rejected/cancelled ออก (ยังไม่เคยมีผลจริง สร้างใหม่ได้)
-- และตัด terminated ออกด้วย (เจ้าของระบบยืนยันแล้วว่าเลิกสัญญาแล้วเปิดสัญญาหลักใบใหม่ของโครงการเดิมได้) —
-- ใช้ pattern "NOT IN รายการจบแบบล้มเหลว/เลิกแล้ว" ตาม CLAUDE.md ข้อ 23 ปลอดภัยกว่า IN รายการที่ยัง
-- active เพราะสถานะ/contract_status ใหม่ในอนาคตจะตกไปฝั่ง "กันซ้ำ" (ปลอดภัย) แทนฝั่ง "อนุญาตซ้ำ" โดย
-- อัตโนมัติถ้าลืมแก้จุดนี้ — Cost roll-up (ข้อ 7 ในอนาคต) ต้องเลือกสัญญาหลักที่ยัง active ด้วยเงื่อนไข
-- เดียวกันนี้ (parent_contract_id IS NULL AND contract_status IS DISTINCT FROM 'terminated') ไม่ใช่แค่
-- "สัญญาหลักของโครงการนี้" เฉยๆ เพราะหลัง terminate+เปิดใหม่ โครงการเดียวกันจะมีแถวสัญญาหลัก 2 แถวขึ้นไป
-- (ใบเก่า terminated + ใบใหม่ active) ต้องกรองใบที่ยัง active ให้ถูกจุดนี้เสมอ — ยังไม่ implement ตอนนี้
-- แค่บันทึกไว้
CREATE UNIQUE INDEX uq_client_contracts_root_per_project ON client_contracts(project_id)
  WHERE parent_contract_id IS NULL AND status NOT IN ('rejected','cancelled')
    AND contract_status IS DISTINCT FROM 'terminated';

-- กันเปิด R ซ้อนกันเกิน 1 ฉบับต่อสัญญาหลักเดียวกันเท่านั้น (ไม่ใช่กฎ "cancel ได้เฉพาะ draft/submitted" —
-- กฎนั้นเป็นเรื่องของ endpoint cancel ที่ปฏิเสธ action ตามสถานะปัจจุบันของแถวเดียว ไม่เกี่ยวกับ unique
-- index ตัวนี้เลย ต้องตรวจ/มีเทสแยกต่างหากในโค้ด endpoint — ดูรายการกฎระดับแอปท้ายไฟล์นี้) — index นี้
-- ตอบแค่คำถาม "มี R มากกว่า 1 ฉบับที่ยังไม่จบ (draft/submitted) อยู่พร้อมกันใต้สัญญาหลักเดียวกันไหม"
CREATE UNIQUE INDEX uq_client_contracts_one_open_revision ON client_contracts(parent_contract_id)
  WHERE parent_contract_id IS NOT NULL AND status NOT IN ('approved','rejected','cancelled');

ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_company_id_id_key UNIQUE (company_id, id);
-- รองรับ composite FK ของ parent_contract_id ที่ต้องบังคับทั้ง "R อยู่โครงการเดียวกับสัญญาหลัก" และ
-- "R เป็นของลูกค้าเดียวกับสัญญาหลัก" พร้อมกัน (project_id อย่างเดียวไม่พอ — ใบ R ยังตั้ง customer_id ให้
-- ต่างจากแม่ได้ถ้าไม่รวมคอลัมน์นี้เข้า unique/FK ด้วย)
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_company_id_id_project_id_customer_id_key
  UNIQUE (company_id, id, project_id, customer_id);

ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_customer_fk
  FOREIGN KEY (company_id, customer_id) REFERENCES client_customers(company_id, id);
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_tender_fk
  FOREIGN KEY (company_id, tender_id) REFERENCES client_tenders(company_id, id);
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_approved_by_fk
  FOREIGN KEY (company_id, approved_by) REFERENCES customers(company_id, id);
-- self-reference 4 คอลัมน์ — บังคับ "R ต้องอยู่โครงการเดียวกันและลูกค้าเดียวกันกับสัญญาหลัก" ที่ชั้น DB
-- ไปในตัว โดยไม่ต้องเขียน validation แยก (NULL ของแถวสัญญาหลักเอง ข้ามการตรวจ FK นี้ไปตามปกติของ
-- Postgres — MATCH SIMPLE เป็นค่าเริ่มต้น ข้ามการตรวจทั้งแถวถ้ามีคอลัมน์ใดคอลัมน์หนึ่งเป็น NULL)
-- ส่วน "แม่ต้องเป็นสัญญาหลัก (parent ของ parent ต้องเป็น NULL เสมอ ห้าม R ซ้อน R)" CHECK ข้ามแถวไม่ได้
-- ต้องตรวจในโค้ด endpoint ตอนสร้าง R เท่านั้น (ดูรายการกฎระดับแอปท้ายไฟล์นี้ — มีเทสยืนยันเพิ่มตอนเขียน
-- endpoint)
ALTER TABLE client_contracts ADD CONSTRAINT client_contracts_parent_fk
  FOREIGN KEY (company_id, parent_contract_id, project_id, customer_id)
  REFERENCES client_contracts(company_id, id, project_id, customer_id);

-- ---------------- กฎระดับแอปที่ DB บังคับให้ไม่ได้ (บันทึกไว้ที่นี่ ต้องเขียน validation + เทสตอนทำ
-- endpoint จริง — ไม่ใช่ CHECK เพราะต้องอ่าน/เทียบข้ามแถว ซึ่ง Postgres CHECK ทำไม่ได้) ----------------
-- 1. แม่ของ R ต้องเป็นสัญญาหลัก (parent_contract_id IS NULL) เท่านั้น — ห้ามสร้าง R ของ R (ห้าม "ซ้อน R")
-- 2. สร้าง R ใหม่ได้เฉพาะเมื่อสัญญาหลัก status='approved' AND contract_status='active' เท่านั้น (บล็อก
--    ทั้ง draft/submitted/rejected/cancelled ของสัญญาหลัก และ contract_status='completed'/'terminated')
-- 3. ตอน approve R: ต้องคำนวณยอดรวมหลังอนุมัติ (ผ่านตรรกะเดียวกับ client_contract_current_value) แล้ว
--    ปฏิเสธถ้ายอดรวม <= 0 — CHECK ระดับแถวของ R เองตรวจแค่ "ไม่เท่ากับ 0" ไม่รู้ยอดรวมทั้งสาย
-- 4. ตอน approve R: ต้องตรวจว่า effective end_date (ค่าที่จะมีผลจริงหลังอนุมัติ R นี้ ซึ่งอาจมาจากค่า
--    ของแถวอื่นก็ได้ ไม่ใช่แค่ค่าในแถว R นี้เอง) ไม่ก่อน effective start_date ที่จะมีผลจริง — เช่น R ที่
--    แก้แค่ end_date ต้องเทียบกับ start_date ปัจจุบัน (ของสัญญาหลักหรือ R อื่นก่อนหน้าที่ยัง effective
--    อยู่) ไม่ใช่เทียบกับ start_date ที่เป็น NULL ในแถวของตัวเอง — client_contracts_date_range_check
--    เช็คได้แค่ภายในแถวเดียวกัน ไม่ครอบคลุมกรณีนี้
-- 5. cancel ใบ R ได้เฉพาะสถานะ draft/submitted เท่านั้น (เหมือน client_subcontract_terms ทุกประการ — ดู
--    ข้อความ error จริงที่ server.js:11528 "ยกเลิกได้เฉพาะสถานะร่างหรือยื่นแล้วเท่านั้น") ใบ R ที่
--    approved แล้วแก้ไข/ยกเลิก/ย้อนกลับไม่ได้เด็ดขาด ไม่มี "terminate" ระดับใบ R แยก (terminate เป็น
--    แนวคิดระดับสัญญาทั้งก้อน ผูกกับสัญญาหลักเท่านั้น) ถ้า R ที่ approved แล้วผิดพลาด ต้องเปิด R ถัดไป
--    เพื่อหักล้างแทน (ตรงกับปรัชญา reversing-entry ของ journal entry ในระบบนี้)
-- 6. ฟอร์มสร้าง/แก้ไขใบ R ฝั่งแอปต้องแปลงฟิลด์ที่ผู้ใช้ "ไม่ได้แตะ/เว้นว่าง" เป็น NULL ก่อนส่งเข้า API
--    เสมอ ห้ามส่งค่าว่าง ('') หรือ 0 มาแทน NULL เด็ดขาด (deposit_percent=0 กับ "ไม่เปลี่ยน deposit" มี
--    ความหมายต่างกันโดยสิ้นเชิง) — UI ควรมีตัวเลือก "แก้ไขฟิลด์นี้" แยกต่อฟิลด์ ไม่ใช่ฟอร์มเดียวกรอกครบ
--    ทุกช่องเหมือนสัญญาหลัก

-- ---------------- ยอดสัญญาปัจจุบัน (single source of truth) ----------------
-- สูตรเดียวที่ทุก endpoint/รายงานต้องอ่านผ่าน ไม่ใช่คำนวณ SUM เองกระจายจุด — คำนวณในฝั่ง SQL ล้วน (NUMERIC
-- บวก NUMERIC) ไม่ผ่าน JS Number เลยตาม CLAUDE.md ข้อ 3 คืนค่าต่อ "สัญญาหลัก" 1 แถว รวมส่วนต่างจากทุกใบ R
-- ที่ approved แล้วเท่านั้น (R ที่ยัง draft/submitted/rejected/cancelled ไม่กระทบยอด)
--
-- คำเตือนสำหรับผู้เรียก: VIEW นี้คืนทุกแถวสัญญาหลัก รวมที่ยังเป็น draft/submitted/rejected/cancelled
-- ด้วย (ไม่ได้กรองสถานะไว้ในตัว view เอง) — ผู้เรียกต้อง WHERE company_id=$1 เสมอ (CLAUDE.md ข้อ 10)
-- และกรองเฉพาะ status='approved' ของสัญญาหลักเองถ้าต้องการ "ยอดของสัญญาที่มีผลจริงเท่านั้น"
CREATE VIEW client_contract_current_value AS
SELECT
  root.company_id,
  root.id AS contract_id,
  root.project_id,
  root.contract_value AS base_value,
  COALESCE(SUM(rev.contract_value) FILTER (WHERE rev.status = 'approved'), 0)::numeric(18,2) AS revision_total,
  (root.contract_value + COALESCE(SUM(rev.contract_value) FILTER (WHERE rev.status = 'approved'), 0))::numeric(18,2) AS current_value
FROM client_contracts root
LEFT JOIN client_contracts rev ON rev.parent_contract_id = root.id AND rev.company_id = root.company_id
WHERE root.parent_contract_id IS NULL
GROUP BY root.company_id, root.id, root.project_id, root.contract_value;

-- ---------------- เงื่อนไขสัญญาที่ใช้จริง (effective terms) ----------------
-- ต่อ "สัญญาหลัก" 1 แถว คำนวณค่าที่ใช้จริงของแต่ละฟิลด์แยกจากกันโดยตั้งใจ (ไม่ผูกกัน) = ค่าจากใบ R ที่
-- approved แล้วและมีค่าฟิลด์นั้นไม่เป็น NULL ที่ revision_no สูงสุด ถ้าไม่มี R แบบนั้นเลยใช้ค่าของสัญญา
-- หลักเอง — แยกคำนวณทีละฟิลด์ด้วย correlated subquery คนละตัว เพราะ R ที่แก้แค่ end_date ต้องไม่ทำให้
-- retention_percent ที่ไม่ได้แตะ "เปลี่ยนตาม" revision_no ของ R ใบนั้นไปด้วย — คำนวณในฝั่ง SQL ล้วน
--
-- คำเตือนสำหรับผู้เรียก (เหมือน client_contract_current_value ข้างบนทุกประการ): VIEW นี้คืนทุกแถวสัญญา
-- หลัก รวมที่ยังเป็น draft/submitted/rejected/cancelled ด้วย — ผู้เรียกต้อง WHERE company_id=$1 เสมอ
-- (CLAUDE.md ข้อ 10) และกรองเฉพาะ status='approved' ของสัญญาหลักเองถ้าต้องการเงื่อนไขที่มีผลจริงเท่านั้น
CREATE VIEW client_contract_effective_terms AS
SELECT
  root.company_id,
  root.id AS contract_id,
  root.project_id,
  COALESCE(
    (SELECT rev.start_date FROM client_contracts rev
     WHERE rev.parent_contract_id = root.id AND rev.company_id = root.company_id
       AND rev.status = 'approved' AND rev.start_date IS NOT NULL
     ORDER BY rev.revision_no DESC LIMIT 1),
    root.start_date
  ) AS effective_start_date,
  COALESCE(
    (SELECT rev.end_date FROM client_contracts rev
     WHERE rev.parent_contract_id = root.id AND rev.company_id = root.company_id
       AND rev.status = 'approved' AND rev.end_date IS NOT NULL
     ORDER BY rev.revision_no DESC LIMIT 1),
    root.end_date
  ) AS effective_end_date,
  COALESCE(
    (SELECT rev.retention_percent FROM client_contracts rev
     WHERE rev.parent_contract_id = root.id AND rev.company_id = root.company_id
       AND rev.status = 'approved' AND rev.retention_percent IS NOT NULL
     ORDER BY rev.revision_no DESC LIMIT 1),
    root.retention_percent
  ) AS effective_retention_percent,
  COALESCE(
    (SELECT rev.deposit_percent FROM client_contracts rev
     WHERE rev.parent_contract_id = root.id AND rev.company_id = root.company_id
       AND rev.status = 'approved' AND rev.deposit_percent IS NOT NULL
     ORDER BY rev.revision_no DESC LIMIT 1),
    root.deposit_percent
  ) AS effective_deposit_percent,
  COALESCE(
    (SELECT rev.payment_terms FROM client_contracts rev
     WHERE rev.parent_contract_id = root.id AND rev.company_id = root.company_id
       AND rev.status = 'approved' AND rev.payment_terms IS NOT NULL
     ORDER BY rev.revision_no DESC LIMIT 1),
    root.payment_terms
  ) AS effective_payment_terms
FROM client_contracts root
WHERE root.parent_contract_id IS NULL;

-- ---------------- Audit log ----------------
-- รายการ doc_type เดิมคัดลอกมาจาก migration 0025 (ไฟล์ล่าสุดที่แก้ constraint นี้) ตรงๆ แล้วเพิ่ม
-- 'contract' เข้าไปท้ายรายการเท่านั้น — ไม่เดา/เขียนรายการใหม่เอง กันตกหล่นค่าที่มีอยู่แล้ว
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance',
    'branch','department','customer','contract'));
