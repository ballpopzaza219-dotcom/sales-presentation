-- ย้อนกลับ migration 0026 — ลบ platform_document_counters ทิ้ง
--
-- ไม่ต้อง guard อะไรเพิ่ม: migration นี้ไม่เคยแตะ invoices/quotations เองเลยสักคอลัมน์ (แค่อ่านค่ามา backfill
-- ตาราง counter ใหม่ที่สร้างขึ้นเองในไฟล์นี้เท่านั้น) — DROP TABLE จึงปลอดภัยเสมอ ไม่มีทางทำให้ข้อมูลจริง
-- (invoices/quotations) หายไปหรือผิดเพี้ยนได้เลย
DROP TABLE platform_document_counters;
