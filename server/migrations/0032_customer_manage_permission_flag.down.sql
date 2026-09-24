-- Rollback for 0032_customer_manage_permission_flag.up.sql
--
-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION (เหมือนตอนเพิ่มรหัสบัญชีใหม่ใน 0003/0005) เพราะคอลัมน์นี้
-- เป็นแค่ permission flag (boolean) บนตาราง customers เอง ไม่มี FK จากตารางอื่นชี้มา และไม่มีตารางไหน
-- อ้างอิงค่าคอลัมน์นี้แบบถาวร (ใช้แค่เช็คสิทธิ์ ณ เวลา request เท่านั้น ผ่าน hasCustomerManagePermission())
-- — DROP COLUMN จึงปลอดภัยเสมอไม่ว่าจะมีกี่แถวตั้งค่าเป็น true อยู่ก็ตาม (เหตุผลเดียวกับ down.sql ของ
-- migration 0007 เป๊ะ) — rollback แปลว่ากลับไปใช้ super_user-only ชั่วคราวเหมือนก่อน apply migration นี้
-- (โค้ด server.js ฝั่ง OR กับ role==='super_user' ยังทำงานได้ปกติ เพียงแต่ทุกคนที่ไม่ใช่ super_user จะ
-- กลับไปไม่มีสิทธิ์จัดการ Customer Master เหมือนเดิม) ไม่ทำลายข้อมูลธุรกรรมใดๆ
ALTER TABLE customers DROP COLUMN can_manage_customer_records;
