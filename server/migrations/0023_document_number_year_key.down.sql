-- ย้อนกลับ migration 0023 — คืน primary key เป็น (company_id, doc_type) เดิม แล้วลบคอลัมน์ year ทิ้ง
--
-- อันตราย: ถ้า (company_id, doc_type) คู่ไหนมีมากกว่า 1 ปีอยู่แล้ว (เช่น ระบบนี้ใช้งานข้ามปีไปแล้วจริงหลัง
-- apply migration นี้) การยุบกลับเหลือ 1 แถวจะต้องเลือกทิ้งข้อมูลของปีใดปีหนึ่ง — ไม่มีทางเลือกที่ถูกต้อง
-- แบบอัตโนมัติ จึงต้อง RAISE EXCEPTION ปฏิเสธการ rollback ทันทีถ้าเจอสถานการณ์นี้ ไม่เดาให้ว่าจะเก็บปีไหน

BEGIN;

DO $$
DECLARE
  offending RECORD;
BEGIN
  SELECT company_id, doc_type, COUNT(DISTINCT year) AS year_count
  INTO offending
  FROM company_document_counters
  GROUP BY company_id, doc_type
  HAVING COUNT(DISTINCT year) > 1
  LIMIT 1;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'ไม่สามารถ rollback ได้: company_id=%, doc_type=% มีข้อมูลมากกว่า 1 ปี (% ปี) อยู่แล้ว — ยุบกลับเหลือ (company_id, doc_type) เดียวจะทำให้ข้อมูลของปีใดปีหนึ่งหายไปโดยไม่มีทางเลือกอัตโนมัติที่ถูกต้อง ต้องตัดสินใจด้วยมือว่าจะเก็บปีไหนก่อน',
      offending.company_id, offending.doc_type, offending.year_count;
  END IF;
END $$;

ALTER TABLE company_document_counters DROP CONSTRAINT company_document_counters_pkey;
ALTER TABLE company_document_counters ADD CONSTRAINT company_document_counters_pkey
  PRIMARY KEY (company_id, doc_type);
ALTER TABLE company_document_counters DROP COLUMN year;

-- ลบแถว doc_type='project'/'quotation' ที่เพิ่งเพิ่มเข้ามาในรอบนี้ทิ้งด้วย (เดิมไม่เคยมีแถวของสอง
-- doc_type นี้ในตารางนี้เลยก่อน migration 0023) — ทำให้ generateClientProjectCode/generateClientQuotationNo
-- ฝั่ง server.js ต้อง revert กลับไปใช้ COUNT(*)-based ด้วยเช่นกัน (คนละไฟล์ ไม่ใช่ DDL)
DELETE FROM company_document_counters WHERE doc_type IN ('project', 'quotation');

COMMIT;
