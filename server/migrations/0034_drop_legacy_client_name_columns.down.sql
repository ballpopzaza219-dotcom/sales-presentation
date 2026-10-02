-- Rollback ของ 0034 — คืนคอลัมน์ client_name/project_owner กลับมา backfill จากชื่อลูกค้าจริงใน
-- client_customers ผ่าน customer_id ที่ยังอยู่ครบ (ไม่ได้แตะ/ลบทิ้งตอน up.sql) แล้วคืน NOT NULL เดิมของ
-- client_name/project_owner กับคืน customer_id ให้ nullable เหมือนก่อน 0034 ทุกประการ (ตรงกับสภาพก่อน
-- apply เป๊ะ — ค่าที่ backfill กลับมาจะตรงกับชื่อลูกค้าจริง ณ ตอน rollback ไม่ใช่ค่าดั้งเดิมเป๊ะถ้าหากชื่อ
-- ลูกค้าถูกแก้ไปแล้วระหว่างที่ migration นี้ apply อยู่ — ยอมรับความคลาดเคลื่อนนี้เหมือนกับ down.sql อื่นๆ
-- ในระบบที่ backfill จากข้อมูลที่เชื่อมโยงอยู่แทนการเก็บ snapshot ไว้ต่างหาก)
ALTER TABLE client_projects ADD COLUMN client_name TEXT;
ALTER TABLE client_tenders ADD COLUMN project_owner TEXT;
ALTER TABLE client_quotations ADD COLUMN client_name TEXT;

UPDATE client_projects cp SET client_name = cc.name
  FROM client_customers cc WHERE cc.company_id = cp.company_id AND cc.id = cp.customer_id;
UPDATE client_tenders t SET project_owner = cc.name
  FROM client_customers cc WHERE cc.company_id = t.company_id AND cc.id = t.customer_id;
UPDATE client_quotations q SET client_name = cc.name
  FROM client_customers cc WHERE cc.company_id = q.company_id AND cc.id = q.customer_id;

ALTER TABLE client_projects ALTER COLUMN client_name SET NOT NULL;
ALTER TABLE client_tenders ALTER COLUMN project_owner SET NOT NULL;
ALTER TABLE client_quotations ALTER COLUMN client_name SET NOT NULL;

ALTER TABLE client_projects ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE client_tenders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE client_quotations ALTER COLUMN customer_id DROP NOT NULL;
