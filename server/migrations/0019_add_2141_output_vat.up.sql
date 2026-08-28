-- PR Module — Batch 19: เพิ่มบัญชี 2141 "ภาษีขาย" ตามที่ฝ่ายบัญชียืนยัน (2026-08-27)
--
-- เหตุผลเลือกรหัส 2141: 2150 ถูกใช้เป็น "ค่าแรงค้างจ่าย" ในทุกบริษัทแล้ว (ตรวจสอบจาก
-- DEFAULT_CLIENT_CHART_OF_ACCOUNTS ใน server.js) ส่วน 2141 ว่างและอยู่ติดกลุ่ม 2140 (ภาระผูกพันตาม
-- สัญญา) ตามที่ฝ่ายบัญชีระบุ
--
-- ⚠️ บัญชีนี้เตรียมไว้ล่วงหน้าเฉยๆ ตามคำสั่งฝ่ายบัญชี — ยังไม่มี endpoint ไหนอ้างถึงเลยในรอบนี้ (VAT ขายบน
-- เงินรับล่วงหน้ายังรอคำตอบเรื่อง tax point ซ้ำ/กลับรายการ ก่อนจะเขียน logic จริงในงานถัดไป — ดู
-- pr-module-known-limitations.md ส่วนที่รอคำตอบ) ห้ามมี route ใดอ้างอิงโค้ดนี้จนกว่าจะมีคำสั่งเพิ่ม

DO $$
DECLARE
  conflict_company_id INTEGER;
  conflict_code TEXT;
BEGIN
  SELECT company_id, code INTO conflict_company_id, conflict_code
  FROM client_chart_of_accounts WHERE code = '2141' LIMIT 1;
  IF conflict_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'บริษัท id=% มีรหัสบัญชี % อยู่ก่อนแล้ว — migration 0019 ต้องการรหัส 2141 ว่างสำหรับทุกบริษัทก่อน apply กรุณาแก้ไข/ย้ายรหัสเดิมก่อน', conflict_company_id, conflict_code;
  END IF;
END $$;

INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, '2141', 'ภาษีขาย', 'liability'
FROM customer_companies c
ON CONFLICT (company_id, code) DO NOTHING;
