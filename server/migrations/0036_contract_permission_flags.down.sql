-- Rollback for 0036_contract_permission_flags.up.sql
--
-- ไม่ต้องมี guard แบบ DO block (เหตุผลเดียวกับ down.sql ของ migration 0032/0033 เป๊ะ) — ทั้งสองคอลัมน์เป็น
-- แค่ permission flag (boolean) บนตาราง customers เอง ไม่มี FK จากตารางอื่นชี้มา และไม่มีตารางไหนอ้างอิง
-- ค่าคอลัมน์นี้แบบถาวร DROP COLUMN จึงปลอดภัยเสมอไม่ว่าจะมีกี่แถวตั้งค่าเป็น true อยู่ก็ตาม — rollback
-- แปลว่ากลับไปใช้ super_user-only ชั่วคราวเหมือนก่อน apply migration นี้ ไม่ทำลายข้อมูลธุรกรรมใดๆ
ALTER TABLE customers DROP COLUMN can_manage_contracts;
ALTER TABLE customers DROP COLUMN can_approve_contracts;
