-- PR Module — Batch 5: แก้ 3 จุดตามรอบตรวจแผน 1.3 ก่อนเขียนโค้ดจริง
-- (1) has_tax_invoice บน items — แยกภาษีซื้อเคลมได้ (1170) ออกจากที่เคลมไม่ได้ (รวมเป็นค่าใช้จ่าย)
-- (2) แยกสถานะ 'settled' ออกจาก 'approved' — approve คือ "ยืนยันยอดค่าใช้จ่ายถูกต้อง" เท่านั้น ไม่ใช่
--     "จ่าย/รับเงินส่วนต่างแล้ว" (แก้สมมติฐานผิดที่ฝังอยู่ใน settlement_required_check เดิมของ 0003)
-- (3) ผังบัญชี "เจ้าหนี้พนักงาน" (liability) — ยังไม่มีอยู่ก่อนเลย (ตรวจแล้วด้วย query สด ไม่มีคำว่า
--     "พนักงาน"/"ลูกจ้าง" ในผังบัญชีเลยสักบริษัท และรหัสหมวด 21xx ที่ใช้แล้วมีแค่ 2100/2120/2150)

-- ---------------- (1) has_tax_invoice ----------------
-- true = มีใบกำกับภาษีเต็มรูปชื่อ/เลขผู้เสียภาษีบริษัทจริง → vat_amount เข้า 1170 ได้
-- false = ใบเสร็จชื่อพนักงาน/ไม่มีใบกำกับ → vat_amount ต้องรวมเป็นส่วนหนึ่งของค่าใช้จ่าย (Dr เข้าบัญชี
-- ค่าใช้จ่ายเดียวกับ amount ไปเลย ไม่แยกลง 1170) — กฎนี้บังคับที่ชั้น API ตอนเขียนโค้ดจริง (คำนวณ Dr
-- แต่ละบรรทัดจาก has_tax_invoice ไม่ใช่แค่ vat_amount>0 เฉยๆ)
ALTER TABLE client_advance_clearance_items ADD COLUMN has_tax_invoice BOOLEAN NOT NULL DEFAULT false;
-- กันความขัดแย้งในตัวเองระดับ DB ตรงๆ: has_tax_invoice=false แปลว่า "ไม่มีใบกำกับภาษีเต็มรูป" ซึ่งแปลว่า
-- vat_amount ต้องถูกรวมเข้า amount ไปแล้ว (ไม่มี vat_amount แยกบรรทัดให้เห็นอีก) — ถ้าไม่มี CHECK นี้
-- แอปอาจเผลอ INSERT has_tax_invoice=false พร้อม vat_amount>0 ได้ (ข้อมูลขัดแย้งกันเอง) แล้วโค้ดที่คำนวณ
-- Dr 1170 อาจเผลออ่าน vat_amount ไปลงบัญชีทั้งที่ไม่ควรมีสิทธิ์เคลมเลย
ALTER TABLE client_advance_clearance_items ADD CONSTRAINT client_advance_clearance_items_tax_invoice_check
  CHECK (has_tax_invoice = true OR vat_amount = 0);

-- ---------------- (2) แยกสถานะ 'settled' ----------------
ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_status_check;
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_status_check
  CHECK (status IN ('draft','submitted','approved','settled','rejected','cancelled','voided'));

-- แทนที่ constraint เดิมจาก 0003 ที่ผูกกับ 'approved' (สมมติฐานผิดว่า approve = จ่ายเงินแล้ว) ด้วยผูกกับ
-- 'settled' แทน — เมื่อ difference_amount=0 ไม่ต้องกรอก settlement เลย (ไม่มีอะไรต้องจ่าย/รับเพิ่ม)
-- เมื่อ difference_amount<>0 ต้องกรอกให้ครบก่อนเข้าสถานะ settled เท่านั้น (ไม่ใช่ตอน approved)
ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_settlement_required_check;
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_settlement_required_check
  CHECK (
    status <> 'settled' OR
    difference_amount = 0 OR
    (settlement_date IS NOT NULL AND settlement_channel IS NOT NULL)
  );

-- ⚠️ กฎที่ชั้น API (route /advance-clearances/:id/settle) ต้องบังคับตอนเขียนโค้ดจริง — CHECK ข้างบน
-- คุ้มครองแค่ "ข้อมูลครบก่อนเข้า settled" ไม่ได้คุ้มครอง state-transition/สิทธิ์ ต้องเช็คเพิ่มที่แอป:
--   1. เรียก /settle ได้เฉพาะ status='approved' เท่านั้น (ไม่ใช่ draft/submitted/settled/rejected/
--      cancelled/voided) — SELECT ... FOR UPDATE ก่อนเช็คตามกฎเดิมของทั้งโมดูล
--   2. เรียกซ้ำ (เช่น หลัง settled ไปแล้ว เรียกอีกครั้งด้วย Idempotency-Key คนละอัน) ต้องได้ 409 ชัดเจน —
--      นี่คือการเช็ค status นอกเหนือจากกลไก withIdempotency เอง (idempotency คุ้มครองแค่ "คีย์เดิมซ้ำ"
--      ไม่คุ้มครอง "เรียกซ้ำด้วยคีย์ใหม่หลัง state เปลี่ยนไปแล้ว")
--   3. difference_amount=0 ต้องไม่มีทางไปถึง /settle ได้เลย เพราะ /approve ต้องข้ามสถานะ 'approved'ไป
--      'settled' อัตโนมัติทันทีตอนตรวจพบ difference_amount=0 (ไม่ค้างที่ 'approved' ให้เรียก /settle
--      ต่อ) — ถ้าทำถูก กฎข้อ 1 (status='approved' only) จะกันเคสนี้เองโดยธรรมชาติอยู่แล้ว (สถานะจะเป็น
--      'settled' ไปแล้วตั้งแต่ต้น ไม่ใช่ 'approved') ไม่ต้องมี special-case แยกต่างหากในโค้ด /settle
--   4. สิทธิ์เรียก /settle ควรแยกจากสิทธิ์ /approve (แยก "อนุมัติยอดถูกต้อง" ออกจาก "ปล่อย/รับเงินจริง"
--      ตาม CLAUDE.md ข้อ 14) — ยังไม่มี flag แยกจริง ให้จำกัดเป็น super_user ไปก่อนพร้อมคอมเมนต์ชื่อ flag
--      ที่ควรสร้างในอนาคต (เช่น can_settle_cash) เหมือน pattern เดิมที่ใช้กับ hasPettyCashAdminPermission

-- ---------------- (3) ผังบัญชีเจ้าหนี้พนักงาน ----------------
-- ใช้ตอน approve ที่ total_expense_amount > advance_amount (ข้อ 1.3.2/1.3.5) — บันทึกยอดที่บริษัทติดค้าง
-- จ่ายพนักงานเพิ่ม ณ เวลาที่ยืนยันยอดค่าใช้จ่าย (ยังไม่ใช่การจ่ายเงินจริง) แล้วค่อยล้างยอดนี้ตอน /settle
-- เมื่อจ่ายเงินจริง (Dr เจ้าหนี้พนักงาน / Cr 1100)
DO $$
DECLARE
  conflict_company_id INTEGER;
  conflict_code TEXT;
BEGIN
  SELECT company_id, code INTO conflict_company_id, conflict_code
  FROM client_chart_of_accounts WHERE code = '2110' LIMIT 1;
  IF conflict_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'บริษัท id=% มีรหัสบัญชี % อยู่ก่อนแล้ว — migration 0005 ต้องการรหัส 2110 ว่างสำหรับทุกบริษัทก่อน apply กรุณาแก้ไข/ย้ายรหัสเดิมก่อน', conflict_company_id, conflict_code;
  END IF;
END $$;

INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, '2110', 'เจ้าหนี้พนักงาน', 'liability'
FROM customer_companies c
ON CONFLICT (company_id, code) DO NOTHING;
