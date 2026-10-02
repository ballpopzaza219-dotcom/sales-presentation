-- Master Blueprint Stage A ข้อ 3 (Customer Master) — ขั้นตอนสุดท้าย: DROP คอลัมน์ free-text เดิม
-- (client_name/project_owner) ที่ migration 0025 เพิ่ม customer_id ให้อยู่คู่กันไว้ชั่วคราว ตอนนี้
-- frontend (pr-system.html) เปลี่ยนมาบังคับเลือก customerId ผ่าน Customer Master picker ครบทั้ง 3 ฟอร์ม
-- (Project/Tender/Quotation add) แล้ว — ไม่มีจุดไหนในระบบที่ยังพึ่ง client_name/project_owner เป็น
-- source of truth อีกต่อไป (ดู CLIENT_PROJECT_SELECT/CLIENT_TENDER_SELECT/CLIENT_QUOTATION_SELECT ใน
-- server.js ที่ join client_customers ไว้แล้วตั้งแต่ 0025 — cc.name คือค่าที่ถูกต้องเสมอ)
--
-- Guard ก่อน DROP: ต้องไม่มีแถวไหนเหลือ customer_id IS NULL อยู่เลย (ตรวจแล้วตอนออกแบบ migration นี้ —
-- client_projects/client_tenders/client_quotations ทั้งหมดในฐานข้อมูลจริงตอนนี้มี customer_id ครบทุกแถว
-- อยู่แล้ว) ถ้าพบแถวที่ยังเป็น NULL (เช่น มีข้อมูลเก่าที่สร้างก่อน Customer Master จะมีอยู่) ให้ throw ทันที
-- แทนที่จะ DROP ทิ้งแบบเงียบๆ แล้วทำข้อมูลระบุตัวลูกค้าหายไปตลอดกาล — ต้อง backfill customer_id ให้ครบ
-- ก่อนเท่านั้นถึงจะรัน migration นี้ต่อได้ (ตรงกับหลัก fail-closed เดียวกับ parsePositiveNumericValue/
-- CLAUDE.md ข้อ 3, 17)
DO $$
DECLARE
  missing_projects int;
  missing_tenders int;
  missing_quotations int;
BEGIN
  SELECT count(*) INTO missing_projects FROM client_projects WHERE customer_id IS NULL;
  IF missing_projects > 0 THEN
    RAISE EXCEPTION 'migration 0034 aborted: client_projects has % row(s) with customer_id IS NULL — backfill customer_id before dropping client_name', missing_projects;
  END IF;

  SELECT count(*) INTO missing_tenders FROM client_tenders WHERE customer_id IS NULL;
  IF missing_tenders > 0 THEN
    RAISE EXCEPTION 'migration 0034 aborted: client_tenders has % row(s) with customer_id IS NULL — backfill customer_id before dropping project_owner', missing_tenders;
  END IF;

  SELECT count(*) INTO missing_quotations FROM client_quotations WHERE customer_id IS NULL;
  IF missing_quotations > 0 THEN
    RAISE EXCEPTION 'migration 0034 aborted: client_quotations has % row(s) with customer_id IS NULL — backfill customer_id before dropping client_name', missing_quotations;
  END IF;
END $$;

-- customer_id เปลี่ยนจาก optional เป็น required ตั้งแต่จุดนี้เป็นต้นไป (ตรงกับที่ frontend บังคับเลือกอยู่
-- แล้ว — DB ต้อง enforce เองด้วย ไม่พึ่ง frontend validation ฝ่ายเดียว)
ALTER TABLE client_projects ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE client_tenders ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE client_quotations ALTER COLUMN customer_id SET NOT NULL;

ALTER TABLE client_projects DROP COLUMN client_name;
ALTER TABLE client_tenders DROP COLUMN project_owner;
ALTER TABLE client_quotations DROP COLUMN client_name;
