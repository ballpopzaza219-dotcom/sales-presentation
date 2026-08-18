-- PR Module — Batch 3: เตรียม schema สำหรับข้อ 1.2 (เงินทดรองจ่าย), 1.3 (เคลียร์เงินทดรองจ่าย),
-- 1.4 (จ่ายเจ้าหนี้ภายนอก) ก่อนเขียน backend จริง — สำรวจโค้ด/schema ที่มีอยู่แล้วพบว่า
-- client_payment_vouchers (voucher_type รองรับ 'advance'/'other' อยู่แล้วตั้งแต่ batch 1),
-- client_advance_clearances, client_advance_clearance_items (มี vat_rate/vat_amount/wht_rate/
-- wht_amount/net_amount ต่อบรรทัดอยู่แล้ว), client_wht_certificates ถูกวางโครงไว้ครบเกือบทั้งหมดแล้ว
-- ตั้งแต่ migration 0001 — เหลือ 6 จุดที่ยังขาดจริงตามที่สำรวจ (ดูรายละเอียดแต่ละหัวข้อด้านล่าง — เพิ่ม
-- จาก 4 เป็น 6 หลังรอบตรวจที่สองพบช่องโหว่เพิ่ม: WHT master table แทน CHECK, unique index กันกลับรายการซ้ำ)
--
-- ขอบเขตที่ตั้งใจ "ไม่รวม" ในรอบนี้: คอลัมน์ VAT/WHT ระดับ voucher ของ client_payment_vouchers และการ
-- ขยาย client_wht_certificates.source_type ให้รับ 'payment_voucher' (สำหรับข้อ 1.4 กรณีจ่ายตรงไม่ผ่าน
-- advance) — ผังบัญชีที่ 1.4 ต้องใช้ (1170/2120) ถูก seed ไว้พร้อมแล้วในไฟล์นี้ (ใช้ร่วมกับ 1.3 ได้เลย)
-- แต่คอลัมน์ตัวเลขระดับ voucher ยังไม่เพิ่ม เพราะรูปแบบ 1.4 ยังไม่ผ่านรอบวางแผนละเอียด (checkpoint ก่อน
-- เขียนโค้ดแบบเดียวกับที่กำลังจะทำกับ 1.3) — เดาโครงสร้างไว้ล่วงหน้าเสี่ยงผิดแล้วต้องแก้อีกรอบ จะเพิ่มเป็น
-- migration แยกตอนวางแผน 1.4 จริง

-- ---------------- (1) ผังบัญชีที่ 1.2/1.3/1.4 ต้องใช้แต่ยังไม่มี ----------------
-- ตรวจแล้ว (query สดข้าม distinct code/name ทุกบริษัทที่มีอยู่จริงในระบบ) ว่าโค้ดที่มีความหมาย "ภาษีซื้อ"
-- หรือ "ภาษีหัก ณ ที่จ่ายค้างนำส่ง" ไม่เคยมีอยู่ภายใต้เลขอื่นมาก่อนเลย — บัญชีเดียวที่เกี่ยวกับภาษีที่มีอยู่
-- จริงคือ 1260 "ภาษีหัก ณ ที่จ่ายค้างรับ" ซึ่งเป็นคนละเรื่อง คนละทิศทางกับที่ต้องการที่นี่ (1260 = สิทธิ
-- ที่จะได้เครดิตภาษีคืน เกิดตอนบริษัท "รับ" เงินจาก client แล้วโดน client หัก ณ ที่จ่าย — เป็น asset
-- ฝั่งลูกหนี้ ผูกกับ client_revenue_payments.wht_amount ส่วน 2120 ที่จะเพิ่มใหม่นี้คือด้านตรงข้าม: บริษัท
-- เป็นฝ่าย "หัก" เงินผู้รับ (พนักงาน/subcontractor/ผู้รับเหมา) เอง แล้วมีหน้าที่นำส่งกรมสรรพากร เป็น
-- liability ฝั่งเจ้าหนี้ — ไม่ใช่บัญชีเดียวกัน ไม่ทับซ้อนกัน) ไม่พบระบบ WHT ผู้รับเหมาที่มีอยู่ก่อนเลย
-- (ค้นหาตาราง client_subcontractor* ไม่พบเลยสักตาราง) จึงยืนยันว่า 1170/2120 เป็นบัญชีใหม่จริง ไม่ซ้ำ
--
-- 1170 ภาษีซื้อ: Dr เมื่อมี VAT ซื้อเกิดขึ้นตอนเคลียร์เงินทดรองจ่าย/จ่ายเจ้าหนี้ภายนอก (มีอยู่แล้ว: 1150
-- ลูกหนี้เงินทดรองจ่าย จาก batch 1 — พอสำหรับข้อ 1.2 อยู่แล้ว ไม่ต้องเพิ่ม)
-- 2120 ภาษีหัก ณ ที่จ่ายค้างนำส่ง: Cr เมื่อหัก ณ ที่จ่ายจากผู้รับเงิน (ตั้งเป็นเจ้าหนี้กรมสรรพากรรอนำส่ง)
-- ใช้ guard เดียวกับ batch 1 (RAISE EXCEPTION ถ้ามีบริษัทไหนมีรหัสนี้อยู่ก่อนแล้ว — เช็คแค่ "เลขว่าง"
-- ตรงๆ ไม่ได้เช็คความหมายซ้ำ แต่ข้างบนตรวจความหมายซ้ำด้วย query แยกไปแล้วว่าไม่มีจริง) เพื่อให้ down.sql
-- DELETE แบบเหมาได้ปลอดภัย 100% (ถ้า migration นี้ apply สำเร็จ แปลว่าไม่มีบริษัทไหนมีรหัสนี้มาก่อนแน่นอน)
DO $$
DECLARE
  conflict_company_id INTEGER;
  conflict_code TEXT;
BEGIN
  SELECT company_id, code INTO conflict_company_id, conflict_code
  FROM client_chart_of_accounts WHERE code IN ('1170','2120') LIMIT 1;
  IF conflict_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'บริษัท id=% มีรหัสบัญชี % อยู่ก่อนแล้ว — migration 0003 ต้องการรหัส 1170/2120 ว่างสำหรับทุกบริษัทก่อน apply กรุณาแก้ไข/ย้ายรหัสเดิมก่อน', conflict_company_id, conflict_code;
  END IF;
END $$;

INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, x.code, x.name, x.category
FROM customer_companies c
CROSS JOIN (VALUES
  ('1170','ภาษีซื้อ','asset'),
  ('2120','ภาษีหัก ณ ที่จ่ายค้างนำส่ง','liability')
) AS x(code, name, category)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------- (2) rejected_reason ของใบเติมเงินกองทุน (ช่องโหว่ที่บันทึกไว้ตอนรีวิว ข้อ 1.1) ----------------
-- เดิม: client_payment_vouchers มี rejected_reason แต่ client_petty_cash_replenishments ไม่มี — audit
-- log (client_document_audit_log) บันทึก reason ไว้อยู่แล้วเสมอก็จริง แต่ไม่มีคอลัมน์ผูกตรงบนแถวเอกสาร
-- เหมือนใบเบิกเงิน ทำให้ดึงเหตุผลปฏิเสธมาแสดงตรงๆ บนตัวเอกสารไม่ได้ ต้องไปรวม join audit log แทน
ALTER TABLE client_petty_cash_replenishments ADD COLUMN rejected_reason TEXT NOT NULL DEFAULT '';

-- ---------------- (3) ส่วนต่างตอนเคลียร์เงินทดรองจ่าย (ข้อ 1.3.2/1.3.3/1.3.5) ----------------
-- difference_amount (generated อยู่แล้วจาก total_expense_amount - advance_amount) บอกแค่ "มีส่วนต่าง
-- เท่าไหร่/ทิศทางไหน" (คืนเงิน หรือเบิกเพิ่ม) แต่ไม่มีที่เก็บว่า "จ่าย/รับเงินจริงเมื่อไหร่ ช่องทางไหน
-- อ้างอิงอะไร (เช่น เลขที่สลิปโอน)" เลย — เพิ่ม 5 คอลัมน์นี้ทั้งหมด nullable/default เพราะไม่ใช่ทุกใบ
-- เคลียร์จะมีส่วนต่างต้องชำระ (เคส 1.3.1/1.3.4 ที่ difference_amount=0 ไม่ต้องกรอกเลย)
ALTER TABLE client_advance_clearances ADD COLUMN settlement_date DATE;
ALTER TABLE client_advance_clearances ADD COLUMN settlement_channel TEXT
  CHECK (settlement_channel IS NULL OR settlement_channel IN ('cash','transfer'));
ALTER TABLE client_advance_clearances ADD COLUMN settlement_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE client_advance_clearances ADD COLUMN settlement_recorded_by INTEGER;
ALTER TABLE client_advance_clearances ADD COLUMN settlement_recorded_at TIMESTAMPTZ;
-- composite FK เหมือน submitted_by/approved_by/voided_by เดิมทุกจุด (ต้องเป็นคนของบริษัทเดียวกัน)
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_settlement_recorded_by_fk
  FOREIGN KEY (company_id, settlement_recorded_by) REFERENCES customers(company_id, id);

-- บังคับที่ระดับ DB ตรงๆ ว่าถ้ามีส่วนต่าง (difference_amount<>0) แล้วเอกสารผ่าน approved/voided ไปแล้ว
-- ต้องกรอก settlement_date+settlement_channel ครบ — ทำได้เพราะ difference_amount/status/settlement_*
-- ทุกตัวอยู่แถวเดียวกัน (single-row CHECK อ่าน generated column ได้ปกติ ไม่ต้องเป็น trigger) เผื่อชั้นแอป
-- มีบั๊กลืมเช็คก่อนเปลี่ยนสถานะ — ยังคงต้องเช็คซ้ำที่ชั้น API ก่อน UPDATE สถานะด้วย (คืน error message ที่
-- อ่านเข้าใจง่ายกว่า constraint violation ดิบๆ ตาม pattern เดิมของโมดูลนี้) — ไม่บังคับตอน draft/submitted/
-- rejected/cancelled เพราะเอกสารพวกนี้ไม่เคยไปถึงขั้นตอนชำระส่วนต่างจริง
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_settlement_required_check
  CHECK (
    status NOT IN ('approved','voided') OR
    difference_amount = 0 OR
    (settlement_date IS NOT NULL AND settlement_channel IS NOT NULL)
  );

-- ---------------- (4) ประเภทเงินได้ตามมาตรา 40 สำหรับออกหนังสือรับรองหัก ณ ที่จ่าย 50 ทวิ (ข้อ 1.3.4) ----------------
-- เดิมมีแค่ wht_rate/wht_amount (ตัวเลขล้วน) ไม่มีที่เก็บ "ประเภทเงินได้" เลย — แบบฟอร์ม 50 ทวิ ต้องระบุ
-- ว่าเข้าเงื่อนไขมาตรา 40 ข้อไหนถึงจะกาช่องถูก มิเช่นนั้นออกเอกสารไม่ได้ถูกต้องตามกฎหมาย
--
-- เป็นตาราง master (ไม่ใช่ CHECK แบบปิดเหมือนร่างรอบแรก) โดยเจตนา: ชุดนี้เป็นร่างเริ่มต้นที่นักบัญชีจะ
-- ต้องแก้ไขแน่ๆ (โดยเฉพาะการแยกย่อยภายใน 40(5)-40(8) ตามคำสั่งกรมสรรพากร เช่น ทป.4/2528 ที่กำหนดอัตรา
-- ต่างกันไปตามประเภทบริการย่อย) ถ้าเป็น CHECK ทุกครั้งที่แก้ต้องออก migration ใหม่ — ไม่ใช่ company-scoped
-- (ไม่มี company_id) เพราะเป็น fixed list ตามกฎหมายที่ใช้ร่วมกันทุกบริษัทเหมือนกันหมด ไม่ใช่ข้อมูลธุรกิจ
-- ของแต่ละบริษัท จึง FK แบบ single-column ธรรมดาได้ (ไม่ใช่ composite (company_id,...) เหมือนกฎทั่วไปใน
-- CLAUDE.md — กฎนั้นมีไว้กันข้ามบริษัทอ้างอิงกันเอง แต่ตารางนี้ไม่มีแนวคิด "ของบริษัทไหน" เลยตั้งแต่ต้น)
-- ⚠️ default_rate 8 ค่านี้เป็นชุดร่างอ้างอิงหมวดที่พบบ่อยในงานก่อสร้างเท่านั้น ไม่ใช่คำแนะนำภาษีที่ยืนยัน
-- แล้ว ต้องให้ผู้ใช้/นักบัญชียืนยันก่อนใช้งานจริงทุกค่า
--
-- default_rate เป็น nullable โดยเจตนา (ไม่มี NOT NULL/DEFAULT) — 40_1 (เงินเดือนค่าจ้าง) คำนวณตามอัตรา
-- ก้าวหน้า ไม่ใช่อัตราคงที่ ใส่เป็น 0 จะดูเหมือนค่าที่ถูกต้องแต่ผิดจริง (0 = "ไม่ต้องหักภาษี" ซึ่งไม่จริง)
-- ต้องเป็น NULL = "ต้องกรอกอัตราเองทุกครั้ง คำนวณอัตโนมัติจาก default ไม่ได้" แบบเดียวกับหลักการ fail-open
-- ที่ไล่แก้มาตลอดทั้งโมดูลนี้ (เทียบเท่า parsePositiveNumericValue คืน null ให้ caller ปฏิเสธเอง ไม่ default
-- เงียบๆ) — ⚠️ กฎสำหรับโค้ดฝั่ง server.js ที่จะเขียนตอนทำ 1.3: จุดไหนก็ตามที่ดึง default_rate ไปใช้ต้อง
-- throw/ปฏิเสธเป็น 400 ถ้าเจอ NULL ห้าม fallback เป็น 0 เด็ดขาด (0 กับ "ไม่รู้อัตรา" มีความหมายต่างกันโดย
-- สิ้นเชิงในบริบทภาษี ปนกันแล้วจะออกเอกสารผิดโดยไม่มีใครรู้ตัว)
CREATE TABLE client_wht_income_types (
  code TEXT PRIMARY KEY,
  name_th TEXT NOT NULL,
  default_rate NUMERIC(5,2),
  is_active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO client_wht_income_types (code, name_th, default_rate) VALUES
  ('40_1', 'เงินเดือน ค่าจ้างแรงงาน (มาตรา 40(1)) — คำนวณตามอัตราก้าวหน้า ไม่ใช่อัตราคงที่', NULL),
  ('40_2', 'ค่านายหน้า ค่าธรรมเนียม (มาตรา 40(2))', 3),
  ('40_3', 'ค่าแห่งลิขสิทธิ์ (มาตรา 40(3))', 3),
  ('40_4', 'ดอกเบี้ย/เงินปันผล (มาตรา 40(4))', 10),
  ('40_5', 'ค่าเช่าทรัพย์สิน (มาตรา 40(5))', 5),
  ('40_6', 'ค่าวิชาชีพอิสระ (มาตรา 40(6))', 3),
  ('40_7', 'ค่าจ้างทำของ/รับเหมาก่อสร้าง (มาตรา 40(7))', 3),
  ('40_8', 'อื่นๆ ตามคำสั่งกรมสรรพากร ทป.4/2528 (มาตรา 40(8))', 3);

ALTER TABLE client_advance_clearance_items ADD COLUMN wht_income_type_code TEXT
  REFERENCES client_wht_income_types(code);

-- client_wht_certificates ต้อง snapshot แช่แข็งจริง (ไม่ใช่แค่ FK มาแล้ว join เอาชื่อสด) เหตุผลเดียวกับ
-- payee_name/payee_tax_id ที่ snapshot อยู่แล้วในตารางนี้ — เอกสารที่ออกเลขที่ไปแล้วต้องไม่เปลี่ยนตาม
-- ต้นทางย้อนหลัง แม้ master data (client_wht_income_types) จะถูกแก้ชื่อ/เปิด-ปิดใช้งานทีหลังก็ตาม —
-- อัตรามี wht_rate เก็บ snapshot อยู่แล้วจากเดิม (migration 0001) ไม่ต้องเพิ่มซ้ำ เพิ่มแค่ชื่อ snapshot
ALTER TABLE client_wht_certificates ADD COLUMN wht_income_type_code TEXT
  REFERENCES client_wht_income_types(code);
ALTER TABLE client_wht_certificates ADD COLUMN wht_income_type_name_snapshot TEXT NOT NULL DEFAULT '';

-- ---------------- (5) /void ของ client_payment_vouchers — reversing entry ต้องอ้างอิงกลับไปหา entry เดิมได้ ----------------
-- ช่องโหว่ที่พบตอนตอบคำถามรีวิว: voided_reason/voided_by/voided_at มีอยู่แล้วจาก batch 1 ก็จริง แต่
-- client_journal_entries ไม่มีคอลัมน์ผูก "entry นี้ reverse entry ไหน" เลย — เดิมมีแค่ (source_type,
-- source_id) แบบ polymorphic ซึ่งทั้ง entry ต้นฉบับตอนอนุมัติ กับ entry กลับรายการตอน void จะมี
-- (source_type='payment_voucher', source_id=<voucher.id>) เหมือนกันทุกประการ แยกไม่ออกว่า entry ไหน
-- reverse entry ไหนถ้าไม่พึ่งการเดาจากลำดับ id/เวลา (ใช้ได้จริงเฉพาะตอนที่รู้ล่วงหน้าว่ามี exactly 2
-- แถวต่อ source เท่านั้น เปราะบางเกินไปที่จะพึ่งเป็นกลไกหลัก) — เพิ่ม self-referencing FK ให้ระบุชัดเจน
-- ตรงๆ แทน (NULL สำหรับ entry ปกติทั่วไป, มีค่าเฉพาะ entry ที่เป็นการกลับรายการเท่านั้น)
--
-- ต้องมี UNIQUE(company_id, id) ก่อนถึงจะทำ composite FK ตัวเองอ้างตัวเองได้ (ตารางนี้ยังไม่เคยมีมาก่อน
-- ต่างจากตารางอื่นๆ ที่ทำไปแล้วตั้งแต่ batch ก่อนๆ)
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE client_journal_entries ADD COLUMN reverses_entry_id INTEGER;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_reverses_entry_id_fk
  FOREIGN KEY (company_id, reverses_entry_id) REFERENCES client_journal_entries(company_id, id);

-- ---------------- (6) กัน entry ต้นฉบับหนึ่งตัวถูก "กลับรายการ" ซ้ำสองครั้ง ----------------
-- ไม่มีอะไรกัน 2 แถวชี้ reverses_entry_id ไปที่ entry เดิมตัวเดียวกันได้ถ้าไม่มี unique index ตรงนี้ —
-- partial (WHERE reverses_entry_id IS NOT NULL) เพราะ entry ปกติทั่วไปเป็น NULL ทั้งหมด ไม่ควรถูกนับ
-- unique ร่วมด้วย (NULL ปกติไม่ชนกันเองใน unique index อยู่แล้วก็จริง แต่ใส่ partial ไว้ให้ชัดเจน/กระชับ
-- ขนาด index ด้วย)
CREATE UNIQUE INDEX uq_client_journal_entries_reverses_entry_id
  ON client_journal_entries(company_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
