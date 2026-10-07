-- Contract module (client_contracts, migration 0035) permission model — สองคอลัมน์แยกกันเจตนา ไม่ใช่
-- flag เดียว ตามที่เจ้าของระบบตัดสินใจไว้:
--   can_manage_contracts — สร้าง/แก้ไข draft/submit/cancel สัญญาหลักและใบ R
--   can_approve_contracts — approve/reject/terminate/complete
-- แยกสองสิทธิ์นี้ออกจากกันตั้งแต่ต้น (ไม่ใช้ flag เดียวทำทั้งสองหน้าที่) ตรงกับ CLAUDE.md ข้อ 14 — ป้องกัน
-- คนตั้งมูลค่า/เงื่อนไขสัญญาเองแล้วอนุมัติสัญญาตัวเองได้โดยไม่มีใครตรวจสอบ (สัญญากระทบรายรับทั้งโครงการ
-- โดยตรง เทียบเท่าหรือสูงกว่าเงินสดย่อยที่เป็นต้นเหตุของกฎข้อ 14 เดิม) การเช็คแบบ "ห้ามอนุมัติเอกสารที่
-- ตัวเองสร้าง/submit" (ยกเว้น super_user) เป็นงานโค้ด server.js ตอนเขียน endpoint approve ไม่ใช่ส่วนของ
-- DDL นี้
--
-- มอบสิทธิ์ผ่าน endpoint เดิมที่มีอยู่แล้ว PUT /api/customer/users/:id/permission-flags (ไม่ต้องเพิ่ม
-- endpoint ใหม่) — super_user ผ่านทั้งสอง flag นี้เสมอโดยไม่ต้องตั้งค่า (เหมือน canManageBidding/
-- canManageCustomerRecords ทุกประการ) ตาม pattern เดียวกับ migration 0032/0033 — ไม่มี FK จากตารางอื่น
-- ชี้มา ไม่มีตารางไหนอ้างอิงค่าคอลัมน์นี้แบบถาวร ใช้แค่เช็คสิทธิ์ ณ เวลา request เท่านั้น
ALTER TABLE customers ADD COLUMN can_manage_contracts BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN can_approve_contracts BOOLEAN NOT NULL DEFAULT false;
