-- งานหน้างาน (งานที่ 1) — ตรวจรับของตาม PO (goods receipt)
--
-- ไม่มี workflow อนุมัติ (ไม่ใช่เอกสารการเงิน ไม่โพสต์ journal — เป็น log ปฏิบัติการว่าของมาถึงจริงกี่ชิ้น
-- ต่อ PO แต่ละใบ) รับของทีละบางส่วนได้หลายครั้งต่อ PO ใบเดียว (partial receipt) — ยอดรับสะสมต่อบรรทัด PO
-- คำนวณสดจาก SUM(qty_received) ของ client_goods_receipt_items เสมอ ไม่เก็บเป็นคอลัมน์สะสมบน
-- client_purchase_order_items (กัน lost-update ตามรูปแบบเดียวกับ computeSubcontractTermBalances ของ
-- หัวข้อ 2 — ดู CLAUDE.md ข้อ 5)
--
-- created_by ของ client_goods_receipts ใช้ composite FK เข้ม (company_id, created_by) — ต่างจากตาราง
-- attachment ที่ยังใช้ single-column (ดูคอมเมนต์ท้ายไฟล์) เพราะแถวนี้คือหลักฐานว่า "ใครเป็นคนตรวจรับของ"
-- ซึ่งเป็นจุดที่ผู้ตรวจสอบดูตอนของหาย/ของขาด ยึดมาตรฐานเดียวกับตารางอนุมัติทางการเงินอื่นๆ
--
-- receipt_no ออกเลขที่ตอนสร้างเลย (ไม่มี draft ให้ข้าม — การสร้างคือขั้นสุดท้ายในตัวเองอยู่แล้ว ไม่ขัดกับ
-- CLAUDE.md ข้อ 11 ที่ห้ามออกเลขตอน "สร้าง draft" เพราะที่นี่ไม่มี draft state เลย)
--
-- ---- กันรับของเกินยอดสั่ง (บังคับที่ชั้นแอปเท่านั้น — ไม่ใช่ DB CHECK เพราะเป็น aggregate ข้ามแถว) ----
-- ทุก endpoint ที่ INSERT ลง client_goods_receipt_items ต้อง:
--   1) SELECT id FROM client_purchase_order_items WHERE id = ANY($poItemIds) ORDER BY id FOR UPDATE
--      เป็น statement แรกสุดของ handler เสมอ (เรียง id ก่อนล็อกกันเดดล็อกข้ามคำขอที่ล็อกคนละลำดับ)
--   2) แยก statement คำนวณ SUM(qty_received) ของแต่ละ po_item_id จาก client_goods_receipt_items ที่มีอยู่
--      แล้วบวกกับจำนวนที่จะรับใหม่ เทียบกับ qty ที่สั่งใน client_purchase_order_items (ห้ามรวม FOR UPDATE
--      กับการคำนวณ SUM ไว้ใน statement เดียวกัน — ตาม CLAUDE.md ข้อ 7 เพราะ correlated subquery ที่อ่าน
--      ตารางอื่นจะไม่ re-evaluate ให้อัตโนมัติหลังตื่นจากรอคิว)
--   3) ถ้าบรรทัดไหนเกิน ปฏิเสธ 400 ทันที ระบุชัดว่าบรรทัดไหน (material/po_item_id) เกินไปเท่าไหร่ (สั่ง X /
--      รับไปแล้ว Y / ที่ขอรับใหม่ Z / เกิน Z-(X-Y))

CREATE TABLE client_goods_receipts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  po_id INTEGER NOT NULL,
  receipt_no TEXT,
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,  -- composite FK ด้านล่าง
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, receipt_no),
  FOREIGN KEY (company_id, po_id) REFERENCES client_purchase_orders(company_id, id)
);
CREATE INDEX idx_client_goods_receipts_po ON client_goods_receipts(po_id);
ALTER TABLE client_goods_receipts ADD CONSTRAINT client_goods_receipts_created_by_fk
  FOREIGN KEY (company_id, created_by) REFERENCES customers(company_id, id);

CREATE TABLE client_goods_receipt_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  receipt_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  qty_received NUMERIC(18,4) NOT NULL CHECK (qty_received > 0),
  FOREIGN KEY (company_id, receipt_id) REFERENCES client_goods_receipts(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, po_item_id) REFERENCES client_purchase_order_items(company_id, id),
  -- กันใบรับของใบเดียวใส่ po_item เดิมซ้ำสองบรรทัด (ปัญหาเดียวกับที่แก้ไปแล้วใน
  -- client_subcontract_retention_release_items ตอนหัวข้อ 2) — ไม่งั้น SUM เกินยอดจริงโดยผู้ใช้ไม่เห็นว่าซ้ำ
  UNIQUE (company_id, receipt_id, po_item_id)
);
CREATE INDEX idx_client_goods_receipt_items_receipt ON client_goods_receipt_items(receipt_id);
CREATE INDEX idx_client_goods_receipt_items_po_item ON client_goods_receipt_items(po_item_id);
ALTER TABLE client_goods_receipt_items ADD CONSTRAINT client_goods_receipt_items_company_id_id_key UNIQUE (company_id, id);

-- ไฟล์แนบ (รูปใบส่งของ) — แยกเป็นตารางลูกรองรับหลายไฟล์ต่อ 1 ใบรับของจริง (ใบส่งของมักมีหลายหน้า) พร้อม
-- metadata ครบตาม pattern ที่ตกลงไว้ตอนหัวข้อ 1 (client_payment_voucher_attachments/
-- client_advance_clearance_attachments migration 0001) — ต่างจากตอนหัวข้อ 1 ตรงที่รอบนี้จะมี endpoint
-- upload/serve จริงต่อเลย (ตรวจแล้วพบว่า 2 ตารางเดิมของหัวข้อ 1 ไม่เคยมี endpoint ต่อจริงเลยสักจุด)
-- uploaded_by เป็น single-column FK (ไม่ composite) — ยึด pattern เดิมของ 2 ตารางต้นแบบข้างต้นเป๊ะๆ เพราะ
-- เป็นแค่ "ใครเป็นคนอัปโหลดไฟล์นี้" ไม่ใช่หลักฐานหลักของธุรกรรมเหมือน created_by ของตารางแม่ด้านบน
CREATE TABLE client_goods_receipt_attachments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  receipt_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  file_size BIGINT,
  checksum TEXT,
  uploaded_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, receipt_id) REFERENCES client_goods_receipts(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_client_goods_receipt_attachments_receipt ON client_goods_receipt_attachments(receipt_id);

-- doc_type ใหม่สำหรับ audit log (บันทึกทุกครั้งที่สร้างใบตรวจรับของ)
ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee','purchase_order','subcontract_term','goods_receipt'));

-- flag สำหรับคนหน้างาน — เจตนาแยกจาก can_manage_po/can_approve_po_wo โดยสิ้นเชิง: คนหน้างานตรวจรับของ
-- ได้ ไม่ได้แปลว่ามีสิทธิ์จัดการ/อนุมัติ PO เอง และไม่นับเป็นเงื่อนไขเปิดโมดูล Finance เด็ดขาด (ไม่ถูกใช้
-- ใน canFinance ฝั่ง pr-system.html เลย)
ALTER TABLE customers ADD COLUMN can_submit_goods_receipt BOOLEAN NOT NULL DEFAULT false;
