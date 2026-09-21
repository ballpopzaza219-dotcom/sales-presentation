-- แก้ ข.11 (pr-module-known-limitations.md) — generateInvoiceNumber/generateQuotationNumber (platform/
-- admin billing — SiteReq ออกใบแจ้งหนี้/ใบเสนอราคาให้ "บริษัทผู้เช่าระบบ" เอง ไม่ใช่ client_* ฝั่ง tenant
-- ออกให้ลูกค้าของ tenant) มีบั๊กคู่เดียวกับที่แก้ไปแล้วใน migration 0023 ฝั่ง client ledger:
-- 1) timezone: new Date().getFullYear() อ่าน system clock ของ server ตรงๆ ไม่ใช่ Asia/Bangkok ชัดเจน
-- 2) reuse-after-delete: เลขที่ derive จาก COUNT(*) ตอน generate ไม่ใช่ atomic counter — ลบแถวแล้วเลข
--    เดิมจะถูกสร้างซ้ำได้
--
-- ยกระดับความเร่งด่วนขึ้นมาก่อนเริ่ม Stripe Billing integration เพราะการออกใบแจ้งหนี้อัตโนมัติทุกรอบบิล
-- (แทนที่ admin กดสร้างเองนานๆ ครั้ง) จะเพิ่มทั้งความถี่การเรียกและความเสี่ยงชนกัน/timezone ผิดขึ้นมหาศาล
--
-- ต่างจาก company_document_counters (migration 0023) ตรงที่นี่เป็นเลขระดับ "แพลตฟอร์ม" ไม่ใช่ต่อ tenant —
-- invoice_no/quotation_no เป็น UNIQUE ระดับ global ไม่เคย scope ด้วย company_id เลย (ตรวจ endpoint จริง
-- ยืนยันแล้ว) จึงไม่มีคอลัมน์ company_id ในตารางนี้เหมือน company_document_counters — key แค่ (doc_type, year)
--
-- ตรวจสอบแล้วว่า invoice_no/quotation_no ไม่เคยรับค่าจาก user เองเลยสักจุด (ทั้ง POST /api/admin/invoices
-- และ POST /api/admin/quotations เรียก generateInvoiceNumber/generateQuotationNumber ตรงๆ เสมอ ไม่มี input
-- field ให้พิมพ์เลขเอง) — ต่างจาก client_projects.code ที่ user พิมพ์เองได้ (ต้องมี retry+exists-check คู่กับ
-- nextDocumentSeq) ที่นี่ atomic counter รับประกัน unique ได้เต็มที่ ไม่ต้อง retry loop เลย (ดู server.js)

-- Guard: ยืนยันก่อนว่าข้อมูลเดิมทุกแถวตรงรูปแบบมาตรฐาน (INV-YYYY-NNNN / QT-YYYY-NNNN) ก่อน backfill —
-- ถ้าเจอเลขนอกรูปแบบ (ไม่ควรมีจริง แต่เช็คไว้ก่อนเสมอ) ให้ RAISE EXCEPTION หยุดทันที ต้องตรวจด้วยมือก่อน
DO $$
DECLARE
  bad_invoice_count INTEGER;
  bad_quotation_count INTEGER;
BEGIN
  SELECT count(*) INTO bad_invoice_count FROM invoices WHERE invoice_no !~ '^INV-\d+-\d+$';
  SELECT count(*) INTO bad_quotation_count FROM quotations WHERE quotation_no !~ '^QT-\d+-\d+$';
  IF bad_invoice_count > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน invoices ที่ invoice_no ไม่ตรงรูปแบบมาตรฐาน INV-YYYY-NNNN — ต้องตรวจด้วยมือก่อน apply migration นี้', bad_invoice_count;
  END IF;
  IF bad_quotation_count > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน quotations ที่ quotation_no ไม่ตรงรูปแบบมาตรฐาน QT-YYYY-NNNN — ต้องตรวจด้วยมือก่อน apply migration นี้', bad_quotation_count;
  END IF;
END $$;

CREATE TABLE platform_document_counters (
  doc_type TEXT NOT NULL,
  year INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, year)
);

-- Backfill: ทั้ง invoice_no/quotation_no มีปี พ.ศ. ฝังอยู่ในเลขเดิมอยู่แล้ว (ต่างจาก migration 0023 ที่
-- ข้อมูลเก่าไม่มีปีในคีย์เลยต้อง infer จาก created_at) — parse ตรงๆ จาก string เดิมได้แม่นยำกว่า ไม่ต้องเดา
-- จาก timestamp เลย ตั้ง next_seq เท่ากับเลขรันสูงสุดที่มีอยู่จริงต่อปี (ไม่ +1 เพราะ nextPlatformDocumentSeq
-- จะ +1 เองตอนเรียกครั้งแรกหลัง apply — ดู server.js)
INSERT INTO platform_document_counters (doc_type, year, next_seq)
SELECT 'invoice', (regexp_match(invoice_no, '^INV-(\d+)-(\d+)$'))[1]::int,
       MAX((regexp_match(invoice_no, '^INV-(\d+)-(\d+)$'))[2]::int)
FROM invoices
GROUP BY (regexp_match(invoice_no, '^INV-(\d+)-(\d+)$'))[1]::int;

INSERT INTO platform_document_counters (doc_type, year, next_seq)
SELECT 'quotation', (regexp_match(quotation_no, '^QT-(\d+)-(\d+)$'))[1]::int,
       MAX((regexp_match(quotation_no, '^QT-(\d+)-(\d+)$'))[2]::int)
FROM quotations
GROUP BY (regexp_match(quotation_no, '^QT-(\d+)-(\d+)$'))[1]::int;
