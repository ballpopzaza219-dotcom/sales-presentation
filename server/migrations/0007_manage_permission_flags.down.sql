-- Rollback for 0007_manage_permission_flags.up.sql — reverses in strict reverse-dependency order
-- (up.sql เพิ่ม 3 คอลัมน์ก่อนแล้วค่อยขยาย doc_type check ทีหลัง → down.sql ต้องแคบ doc_type check
-- กลับก่อนแล้วค่อย DROP 3 คอลัมน์)
--
-- ⚠️ guard: ถ้ามีแถว doc_type='user_permission' อยู่จริง ต้อง rollback ไม่ได้ — ถ้าปล่อยให้ DROP+ADD
-- constraint ผ่านไปเงียบๆ แถวที่มี doc_type='user_permission' อยู่แล้วจะขัดกับ CHECK เดิม (ไม่มี
-- 'user_permission' ในรายการที่ยอมรับ) ทำให้ constraint ใหม่ (แคบกว่าเดิม) ปฏิเสธข้อมูลที่มีอยู่จริงทันที
-- ตอน ALTER TABLE (Postgres ตรวจทุกแถวที่มีอยู่แล้วตอนเพิ่ม CHECK constraint เสมอ) — แปลว่า statement
-- จะพังอยู่ดี แต่ error message ดิบจาก Postgres จะไม่บอกตรงๆ ว่าต้องทำอะไรต่อ ใส่ guard ให้ error message
-- อ่านรู้เรื่องแทน (ปัญหาเดียวกับ status='settled' ใน 0005 เป๊ะๆ — endpoint สิทธิ์ใช้งานจริงแล้วจะมีแถว
-- audit log ค้างอยู่แน่นอน)
DO $$
DECLARE
  usage_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO usage_count FROM client_document_audit_log WHERE doc_type = 'user_permission';
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มี audit log % แถวที่ doc_type=''user_permission'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback migration 0007 มิเช่นนั้นข้อมูลจะขัดกับ doc_type CHECK เดิมที่ไม่มี ''user_permission''', usage_count;
  END IF;
END $$;

ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim','purchase_request','petty_cash_replenishment'));

-- ไม่ต้องมี guard แบบ DO block RAISE EXCEPTION เหมือนตอนเพิ่มรหัสบัญชีใหม่ (0003/0005) เพราะทั้ง 3
-- คอลัมน์เป็นแค่ permission flag (boolean) บนตาราง customers เอง ไม่มี FK จากตารางอื่นชี้มา และไม่มี
-- ตารางไหนอ้างอิงค่าของคอลัมน์นี้แบบถาวร (ใช้แค่เช็คสิทธิ์ ณ เวลา request เท่านั้น) DROP COLUMN จึง
-- ปลอดภัยเสมอไม่ว่าจะมีกี่แถวตั้งค่าเป็น true อยู่ก็ตาม — rollback แปลว่ากลับไปใช้ super_user-only
-- ชั่วคราวเหมือนเดิม (โค้ด server.js ฝั่ง OR กับ role==='super_user' จะยังทำงานได้ปกติ เพียงแต่ทุกคนที่
-- ไม่ใช่ super_user จะกลับไปไม่มีสิทธิ์เหมือนก่อน apply migration นี้) ไม่ได้ทำลายข้อมูลธุรกรรมใดๆ

ALTER TABLE customers DROP COLUMN can_manage_po;
ALTER TABLE customers DROP COLUMN can_manage_petty_cash_fund;
ALTER TABLE customers DROP COLUMN can_settle_cash;
