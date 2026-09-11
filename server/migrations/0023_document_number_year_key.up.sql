-- แก้บั๊ก document numbering (พบระหว่างสำรวจ Master Blueprint 2026-09): company_document_counters ใช้ key
-- แค่ (company_id, doc_type) ไม่มี "ปี" อยู่ในกลไกจริงเลย ทั้งที่เลขที่พิมพ์บนเอกสารทุกใบมีปีเป็นส่วนหนึ่ง
-- ของรูปแบบ (เช่น PV-2569-0001) — แปลว่า next_seq ไม่เคยรีเซ็ตขึ้นปีใหม่ สะสมไปเรื่อยๆ ข้ามปีจริง (ยังไม่มี
-- ผลกระทบที่เห็นได้ตอนนี้เพราะระบบยังไม่เคยข้ามปีเลยตั้งแต่สร้างมา แต่จะเป็นปัญหาแน่ทันทีที่ข้ามปีจริง —
-- สำคัญกว่าที่คิดตอนขึ้น production จริงบน server ที่ตั้ง timezone เป็น UTC: เที่ยงคืนถึงตี 7 เวลาไทยคือ
-- ยังเป็น "เมื่อวาน" ตาม UTC แล้ว ถ้าคำนวณปีผิด timezone จะข้ามปีเอกสารผิดช่วงเวลานี้พอดี — ดูข้อ (7) ด้านล่าง)
--
-- แก้โดยเปลี่ยน primary key เป็น (company_id, doc_type, year) — แต่ละปีมี counter ของตัวเอง เริ่มที่ 1 ใหม่
-- อัตโนมัติทุกปี (ผ่านกลไก UPSERT เดิมที่ INSERT ค่า 1 เมื่อยังไม่มีแถวของปีนั้น)
--
-- Backfill: ตั้งค่า next_seq ของทุกแถวเดิมด้วย GREATEST(ค่า next_seq เดิม, เลขสูงสุดที่พบจริงในตารางเอกสาร
-- ของบริษัทนั้น) ตามที่ตกลง — ไม่ reset เป็น 0 แม้ตารางเอกสารบางประเภทจะว่างเปล่าตอนนี้ก็ตาม (แถวถูกลบไปจาก
-- การทดสอบ regression ไม่ได้แปลว่าเลขไม่เคยถูกออกจริง — next_seq คือหลักฐานว่า "เคยออกแล้ว" ตามนิยามของ
-- กลไกนี้เอง) คำนวณแยกต่อบริษัทเสมอ (ห้ามใช้ค่า max รวมข้ามบริษัท — จะทำให้ counter ของบริษัทหนึ่งพองขึ้นจาก
-- ข้อมูลของอีกบริษัทที่ไม่เกี่ยวข้องกันเลย ผิดหลัก tenant isolation) ปีที่ backfill ให้ทุกแถวคือปี พ.ศ.
-- ปัจจุบันตาม Asia/Bangkok เสมอ (คำนวณสด ไม่ hardcode ตัวเลข) เพราะระบบนี้ยังไม่เคยดำเนินการข้ามปีเลยนับตั้งแต่
-- สร้างมา (ยืนยันจากข้อมูลจริงก่อน apply migration นี้)
--
-- ในรอบเดียวกันนี้ ย้าย client_projects.code และ client_quotations.quotation_no จากการนับแบบ
-- COUNT(*)-based (บั๊กที่ร้ายแรงกว่า — เลขซ้ำได้จริงถ้ามีการลบแถว เหมือนบั๊กเดิมของ tender ที่แก้ไปแล้วก่อน
-- หน้านี้) มาใช้กลไก company_document_counters เดียวกันกับเอกสารประเภทอื่นทั้งหมด — เพิ่ม 2 doc_type ใหม่
-- ('project', 'quotation') เข้าตารางนี้พร้อมกัน

-- (1) เพิ่มคอลัมน์ year แบบ nullable ก่อน จะตั้ง NOT NULL หลัง backfill เสร็จ
ALTER TABLE company_document_counters ADD COLUMN year INTEGER;

-- (2) Backfill ปีให้ทุกแถวเดิม = ปี พ.ศ. ปัจจุบันตาม Asia/Bangkok (คำนวณสด)
UPDATE company_document_counters
SET year = (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Bangkok'))::int + 543)
WHERE year IS NULL;

-- (3) ยกระดับ next_seq ของทุกแถวเดิมเป็น GREATEST(ค่าเดิม, เลขสูงสุดที่พบจริงในตารางเอกสาร "ของบริษัทเดียวกัน")
--     ใช้ dynamic SQL วนทุก (doc_type, table, column, prefix) เพื่อไม่ต้องเขียนซ้ำ 12 รอบ
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('payment_voucher',          'client_payment_vouchers',           'voucher_no',    'PV'),
    ('advance_clearance',        'client_advance_clearances',         'clearance_no',  'ADV'),
    ('purchase_request',         'client_purchase_requests',          'pr_no',         'PR'),
    ('purchase_order',           'client_purchase_orders',            'po_no',         'PO'),
    ('subcontract_term',         'client_subcontract_terms',          'contract_no',   'WO'),
    ('subcontract_billing',      'client_subcontract_billings',       'billing_no',    'SB'),
    ('goods_receipt',            'client_goods_receipts',             'receipt_no',    'GR'),
    ('site_expense_submission',  'client_site_expense_submissions',   'submission_no', 'SE'),
    ('progress_claim',           'client_progress_claims',            'claim_no',      'PC'),
    ('wht_certificate',          'client_wht_certificates',           'cert_no',       'WHT'),
    ('petty_cash_replenishment', 'client_petty_cash_replenishments',  'replenish_no',  'PCR'),
    ('tender',                   'client_tenders',                    'tender_no',     'TDR')
  ) AS t(doc_type, tbl, col, prefix) LOOP
    EXECUTE format(
      'UPDATE company_document_counters c
       SET next_seq = GREATEST(c.next_seq, sub.real_max)
       FROM (
         SELECT company_id, MAX(split_part(%I, ''-'', 3)::int) AS real_max
         FROM %I WHERE %I LIKE %L GROUP BY company_id
       ) sub
       WHERE c.company_id = sub.company_id AND c.doc_type = %L',
      spec.col, spec.tbl, spec.col, spec.prefix || '-%', spec.doc_type
    );
  END LOOP;
END $$;

-- (4) เพิ่ม doc_type ใหม่ 'project'/'quotation' เข้าตารางนี้ (ยังไม่เคยมีแถวมาก่อนเพราะเดิมใช้ COUNT(*)) —
--     เฉพาะบริษัทที่มีแถวอยู่จริงในตารางต้นทาง, seed = เลขสูงสุดที่เจอจริงต่อบริษัท (ปีเดียวกับ backfill ข้างบน)
INSERT INTO company_document_counters (company_id, doc_type, next_seq, year)
SELECT company_id, 'project', MAX(split_part(code, '-', 3)::int),
       (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Bangkok'))::int + 543)
FROM client_projects
WHERE code LIKE 'PRJ-%'
GROUP BY company_id;

INSERT INTO company_document_counters (company_id, doc_type, next_seq, year)
SELECT company_id, 'quotation', MAX(split_part(quotation_no, '-', 3)::int),
       (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Bangkok'))::int + 543)
FROM client_quotations
WHERE quotation_no LIKE 'QT-%'
GROUP BY company_id;

-- (5) Guard: ยืนยันว่าไม่มีเอกสารใดในระบบที่เลขสูงกว่า counter ที่เพิ่งตั้งไว้ — ถ้าเจอ RAISE EXCEPTION
--     ทันทีพร้อมบอก doc_type + เลขที่ผิด + company_id (กันกรณี backfill พลาดหรือมีบริษัทที่ยังไม่มีแถวใน
--     company_document_counters เลยมาก่อนทั้งที่มีเอกสารอยู่จริง)
DO $$
DECLARE
  spec RECORD;
  offending RECORD;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('payment_voucher',          'client_payment_vouchers',           'voucher_no',    'PV'),
    ('advance_clearance',        'client_advance_clearances',         'clearance_no',  'ADV'),
    ('purchase_request',         'client_purchase_requests',          'pr_no',         'PR'),
    ('purchase_order',           'client_purchase_orders',            'po_no',         'PO'),
    ('subcontract_term',         'client_subcontract_terms',          'contract_no',   'WO'),
    ('subcontract_billing',      'client_subcontract_billings',       'billing_no',    'SB'),
    ('goods_receipt',            'client_goods_receipts',             'receipt_no',    'GR'),
    ('site_expense_submission',  'client_site_expense_submissions',   'submission_no', 'SE'),
    ('progress_claim',           'client_progress_claims',            'claim_no',      'PC'),
    ('wht_certificate',          'client_wht_certificates',           'cert_no',       'WHT'),
    ('petty_cash_replenishment', 'client_petty_cash_replenishments',  'replenish_no',  'PCR'),
    ('tender',                   'client_tenders',                    'tender_no',     'TDR'),
    ('project',                  'client_projects',                   'code',          'PRJ'),
    ('quotation',                'client_quotations',                 'quotation_no',  'QT')
  ) AS t(doc_type, tbl, col, prefix) LOOP
    EXECUTE format(
      'SELECT t.company_id, t.%I AS doc_no
       FROM %I t
       LEFT JOIN company_document_counters c
         ON c.company_id = t.company_id AND c.doc_type = %L
       WHERE t.%I LIKE %L AND (c.next_seq IS NULL OR split_part(t.%I, ''-'', 3)::int > c.next_seq)
       LIMIT 1',
      spec.col, spec.tbl, spec.doc_type, spec.col, spec.prefix || '-%', spec.col
    ) INTO offending;
    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'พบเอกสาร doc_type=% เลขที่ % (company_id=%) ที่เลขเกิน counter ที่เพิ่ง backfill ไว้ — หยุดทันที ห้ามปล่อยผ่าน',
        spec.doc_type, offending.doc_no, offending.company_id;
    END IF;
  END LOOP;
END $$;

-- (6) ปิดช่อง year เป็น NOT NULL แล้วเปลี่ยน primary key
ALTER TABLE company_document_counters ALTER COLUMN year SET NOT NULL;
ALTER TABLE company_document_counters DROP CONSTRAINT company_document_counters_pkey;
ALTER TABLE company_document_counters ADD CONSTRAINT company_document_counters_pkey
  PRIMARY KEY (company_id, doc_type, year);

