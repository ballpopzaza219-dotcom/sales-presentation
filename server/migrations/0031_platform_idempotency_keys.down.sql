-- ย้อนกลับ migration 0031 — ลบตาราง idempotency ฝั่ง platform_admin ทิ้ง
--
-- Guard: ปฏิเสธ rollback ถ้ามีแถวอยู่จริง (มีการเรียก endpoint ที่ผ่าน withPlatformIdempotency() แล้วจริง
-- ระหว่างที่ migration นี้ apply อยู่) — response cache ที่หายไปอาจทำให้ retry ด้วย Idempotency-Key เดิม
-- ทำงานซ้ำโดยไม่ตั้งใจ (เหมือน guard ของ platform_company_status_log/platform_refunds)
DO $$
DECLARE
  key_count INTEGER;
BEGIN
  SELECT count(*) INTO key_count FROM platform_idempotency_keys;
  IF key_count > 0 THEN
    RAISE EXCEPTION 'มีแถว platform_idempotency_keys อยู่จริง % แถว — ต้องตรวจสอบ/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นการป้องกัน retry ซ้ำจะหายไป', key_count;
  END IF;
END $$;

DROP TABLE platform_idempotency_purge_state;
DROP TABLE platform_idempotency_keys;
