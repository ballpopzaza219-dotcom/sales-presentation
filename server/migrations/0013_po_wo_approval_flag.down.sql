-- guard: ถ้ามีใครถูกให้สิทธิ์ can_approve_po_wo=true อยู่จริงแล้ว rollback นี้จะ DROP COLUMN ทิ้ง
-- ทำให้การตั้งค่าสิทธิ์นั้นหายไปเงียบๆ (ต้องมาตั้งใหม่เองทุกคนถ้า apply ซ้ำ) — กันไว้เหมือน 0012
DO $$
DECLARE
  grant_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO grant_count FROM customers WHERE can_approve_po_wo = true;
  IF grant_count > 0 THEN
    RAISE EXCEPTION 'มีผู้ใช้ % คนที่ตั้งค่า can_approve_po_wo=true อยู่จริง — rollback migration 0013 จะ DROP COLUMN ทิ้ง ทำให้การให้สิทธิ์เหล่านี้หายไป ต้องจดบันทึก/ยืนยันก่อน rollback', grant_count;
  END IF;
END $$;

ALTER TABLE customers DROP COLUMN can_approve_po_wo;
