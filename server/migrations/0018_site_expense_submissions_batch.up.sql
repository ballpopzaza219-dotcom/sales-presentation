-- งานหน้างาน (งานที่ 2) — ส่งบิลค่าใช้จ่ายจากหน้างาน (site expense submission)
--
-- เป็น "inbox/triage" record เท่านั้น ไม่ใช่เอกสารการเงินเอง ไม่โพสต์ journal ตัวเอง — บัญชีต้องกดปุ่ม
-- prefill ไปสร้างเอกสารจริงเอง (ยืนยันจากผู้ใช้: ไม่ auto-convert) แล้วกลับมา "ปิดเรื่อง" อ้างอิงเลขที่
-- เอกสารที่สร้างจริงผ่าน result_doc_type/result_doc_id (ไม่มี FK เพราะ polymorphic ชี้ได้ทั้ง
-- client_advance_clearances และ client_payment_vouchers — เหมือน pattern เดิมของ
-- client_journal_entries.source_id/client_wht_certificates.source_id แต่ใส่ CHECK จำกัดค่าที่รับได้
-- เหมือนที่ client_wht_certificates.source_type ทำไว้ แทนที่จะปล่อยเป็น TEXT อิสระเฉยๆ)
--
-- expense_case เป็นแค่ "คำใบ้" ช่วยบัญชี triage เร็วขึ้น ไม่ได้บังคับปลายทางเอกสารเป๊ะๆ (บัญชีตัดสินใจเอง
-- เสมอตอนกด "สร้างเอกสาร"):
--   - advance_offset (ก): มีใบเบิกเงินสดย่อย/เงินทดรองจ่ายอยู่ก่อนแล้ว -> ปกติไปเป็นใบเคลียร์เงินทดรอง
--     จ่าย (client_advance_clearances) — บังคับมี linked_voucher_id เสมอ (อ้างอิงใบเบิกเดิม ช่วย prefill)
--   - reimbursement (ข): ไม่มีใบเบิกมาก่อน จ่ายเงินตัวเองไปก่อน -> ปกติไปเป็น payment voucher
--     (voucher_type='other') จ่ายคืนพนักงานตรง — ตัดสินใจแล้วว่าไม่ใช้กลไกเคลียร์เงินทดรองจ่าย เพราะ
--     client_advance_clearances.advance_voucher_id เป็น NOT NULL ในโครงสร้างเดิม ไม่รองรับ "ไม่มีใบเบิก
--     อ้างอิง" ตรงๆ (ดู server/docs/pr-module-known-limitations.md ข้อ ข.1 เดิม) — ผลข้างเคียงที่ต้องรู้:
--     ต้องลงทะเบียนพนักงานเป็น client_external_payees ก่อน 1 ครั้งถ้ายังไม่เคยจ่ายผ่านช่องทางนี้มาก่อน
--   - payable (ค): ซื้อเชื่อ ร้านวางบิลทีหลัง -> ปกติไปเป็น payment voucher (voucher_type='other') เช่นกัน
--     (สร้างเป็น draft ไว้ก่อน ยื่น+อนุมัติจริงตอนจ่ายเงินจริง)
-- linked_voucher_id ใช้เฉพาะกรณี ก เท่านั้น ต้อง NULL เสมอสำหรับกรณี ข/ค (บังคับด้วย CHECK คู่กัน กันข้อมูล
-- กำกวมว่า "อ้างอิงใบเบิกหรือเปล่า")
--
-- ---- รูปบิล/ใบเสร็จ: บังคับ "ต้องมีอย่างน้อย 1 ไฟล์" ที่ชั้นแอปเท่านั้น ไม่ใช่ DB CHECK ----
-- เดิมออกแบบเป็นคอลัมน์ photo_attachment TEXT NOT NULL บนตารางนี้ตรงๆ แต่เปลี่ยนเป็นตารางลูก
-- client_site_expense_attachments (รองรับหลายไฟล์ + metadata ครบ ดูคอมเมนต์ท้ายไฟล์) แล้ว — DB ไม่มี
-- CHECK แบบ "ต้องมีอย่างน้อย 1 แถวในตารางลูก" ให้ใช้ (CHECK ผูกได้แค่ภายในแถวเดียวกันเท่านั้น) จึง**ต้อง
-- บังคับที่ POST /api/customer/site-expense-submissions เท่านั้น**: ถ้า request ไม่มีไฟล์แนบมาด้วยเลย
-- (ผ่าน multer .array()) ให้ throw 400 ทันทีก่อน INSERT แถวใดๆ ทั้งสองตาราง (rollback ทั้งทรานแซกชัน ไม่ใช่
-- insert หัวข้อไปก่อนแล้วค่อยพบว่าไม่มีไฟล์แนบทีหลัง)

CREATE TABLE client_site_expense_submissions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  submission_no TEXT,
  project_id INTEGER NOT NULL,
  expense_case TEXT NOT NULL CHECK (expense_case IN ('advance_offset','reimbursement','payable')),
  linked_voucher_id INTEGER,
  vendor_name TEXT NOT NULL DEFAULT '',
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL DEFAULT '',
  has_tax_invoice BOOLEAN NOT NULL DEFAULT false,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','rejected','closed')),
  rejected_reason TEXT NOT NULL DEFAULT '',
  result_doc_type TEXT CHECK (result_doc_type IS NULL OR result_doc_type IN ('advance_clearance','payment_voucher')),
  result_doc_id INTEGER,
  submitted_by INTEGER,  -- composite FK ด้านล่าง
  closed_by INTEGER,     -- composite FK ด้านล่าง
  closed_at TIMESTAMPTZ,
  closing_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expense_case <> 'advance_offset' OR linked_voucher_id IS NOT NULL),
  CHECK (expense_case = 'advance_offset' OR linked_voucher_id IS NULL),
  CHECK (status <> 'closed' OR (result_doc_type IS NOT NULL AND result_doc_id IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejected_reason <> ''),
  UNIQUE (company_id, id),
  UNIQUE (company_id, submission_no)
);
CREATE INDEX idx_client_site_expense_submissions_status ON client_site_expense_submissions(company_id, status);
CREATE INDEX idx_client_site_expense_submissions_project ON client_site_expense_submissions(project_id);
ALTER TABLE client_site_expense_submissions ADD CONSTRAINT client_site_expense_submissions_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_site_expense_submissions ADD CONSTRAINT client_site_expense_submissions_voucher_fk
  FOREIGN KEY (company_id, linked_voucher_id) REFERENCES client_payment_vouchers(company_id, id);
ALTER TABLE client_site_expense_submissions ADD CONSTRAINT client_site_expense_submissions_submitted_by_fk
  FOREIGN KEY (company_id, submitted_by) REFERENCES customers(company_id, id);
ALTER TABLE client_site_expense_submissions ADD CONSTRAINT client_site_expense_submissions_closed_by_fk
  FOREIGN KEY (company_id, closed_by) REFERENCES customers(company_id, id);

-- ไฟล์แนบ (รูปบิล/ใบเสร็จ) — ตารางลูกรองรับหลายไฟล์ต่อ 1 ใบส่งบิล เหมือน client_goods_receipt_attachments
-- ของ migration 0017 เป๊ะๆ (metadata ครบ, uploaded_by single-column FK ตาม pattern เดิม)
CREATE TABLE client_site_expense_attachments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  submission_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  file_size BIGINT,
  checksum TEXT,
  uploaded_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, submission_id) REFERENCES client_site_expense_submissions(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_client_site_expense_attachments_submission ON client_site_expense_attachments(submission_id);

-- doc_type ใหม่สำหรับ audit log (submit/reject/close)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term','goods_receipt','site_expense_submission'));

-- flag สำหรับคนหน้างาน — แยกอิสระจาก can_submit_goods_receipt (แยก 2 flag ตามที่ตัดสินใจแล้ว) และไม่นับ
-- เป็นเงื่อนไขเปิดโมดูล Finance เช่นกัน
-- "ใครปิดเรื่อง/ตีกลับคิวนี้ได้ฝั่งบัญชี" ยืนยันจากผู้ใช้แล้ว (2026-08-27): super_user || can_settle_cash
-- (flag เดิมจาก migration 0007 ของคนบันทึกการจ่าย/รับเงินจริง — ไม่เพิ่ม flag ใหม่ เพราะปิดเรื่องคือการ
-- ยืนยันว่าสร้างเอกสารการเงินให้แล้วจริง ตรงกับความหมายเดิมของ flag นี้อยู่แล้ว) ดู
-- hasSiteExpenseProcessPermission ใน server.js
ALTER TABLE customers ADD COLUMN can_submit_site_expense BOOLEAN NOT NULL DEFAULT false;
