-- rollback 0012 — คืนโครงสร้างเดิมทุกจุด (ทดสอบ up->down->up->down ก่อน apply จริงเสมอตาม CLAUDE.md ข้อ 15)
--
-- ⚠️ guard 3 จุด (เหตุผลเดียวกับ 0005/0007/0010 เป๊ะ): rollback นี้ DROP ตาราง client_purchase_orders/
-- client_purchase_order_items/client_subcontract_terms ทิ้งทั้งก้อน แล้วสร้างโครงสร้างเดิมกลับ (JSONB
-- items แบบเก่า) กลับคืนมา — คืนได้แค่ "โครงสร้าง" เท่านั้น ไม่มีทางแปลง PO/PR item ที่ผูกกันแบบ relational
-- กลับเป็น JSONB เดิมได้เลย (ข้อมูลจะหายจริง ไม่ใช่แค่ error message ที่อ่านไม่รู้เรื่องแบบ 0005/0007/0010)
-- ต้องกันไว้ตั้งแต่ก่อน DROP บรรทัดแรก ไม่ใช่แค่ก่อน ALTER CHECK แบบ 3 migration ก่อนหน้า
DO $$
DECLARE
  po_count INTEGER;
  wo_count INTEGER;
  audit_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO po_count FROM client_purchase_orders;
  IF po_count > 0 THEN
    RAISE EXCEPTION 'มีใบสั่งซื้อ % แถวอยู่จริงใน client_purchase_orders (โครงสร้างใหม่) — rollback migration 0012 จะ DROP TABLE ทิ้งทั้งก้อน ข้อมูลเหล่านี้จะหายถาวร (ไม่มีทางแปลงกลับเป็น JSONB เดิมได้) ต้อง export/ย้ายข้อมูลออกก่อน', po_count;
  END IF;

  SELECT COUNT(*) INTO wo_count FROM client_subcontract_terms;
  IF wo_count > 0 THEN
    RAISE EXCEPTION 'มีสัญญา/หนังสือสั่งจ้าง % แถวอยู่จริงใน client_subcontract_terms — rollback migration 0012 จะ DROP TABLE ทิ้งทั้งก้อน ต้อง export/ย้ายข้อมูลออกก่อน', wo_count;
  END IF;

  SELECT COUNT(*) INTO audit_count FROM client_document_audit_log WHERE doc_type IN ('purchase_order','subcontract_term');
  IF audit_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type IN (''purchase_order'',''subcontract_term'') อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0012 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มีสองค่านี้', audit_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee'));

DROP TABLE client_subcontract_terms;
DROP TABLE client_purchase_order_items;

ALTER TABLE client_purchase_request_item_adjustments DROP CONSTRAINT client_pr_item_adjustments_po_fk;
DROP TABLE client_purchase_orders;

-- คืนโครงสร้างเดิมเป๊ะตามที่มีอยู่ใน schema.sql ก่อน migration นี้
CREATE TABLE client_purchase_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  po_no TEXT NOT NULL,
  project_id INTEGER,
  pr_reference TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL,
  supplier_contact TEXT NOT NULL DEFAULT '',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  payment_terms TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ordered','received','cancelled')),
  items JSONB NOT NULL DEFAULT '[]',
  amount NUMERIC NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, po_no)
);
CREATE INDEX idx_client_purchase_orders_company ON client_purchase_orders(company_id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE client_purchase_request_item_adjustments ADD CONSTRAINT client_pr_item_adjustments_po_fk
  FOREIGN KEY (company_id, po_id) REFERENCES client_purchase_orders(company_id, id);
