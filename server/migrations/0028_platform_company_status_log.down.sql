-- ย้อนกลับ migration 0028 — ลบ platform_company_status_log ทิ้ง
--
-- Guard: ปฏิเสธ rollback ถ้ามีแถวอยู่จริงแม้แต่แถวเดียว (ประวัติการ suspend/reactivate จริงที่ไม่มีทาง
-- reconstruct กลับมาได้เลยถ้าลบไปแล้ว — เหมือน guard ของ platform_refunds/platform_webhook_events ใน
-- migration 0027)
DO $$
DECLARE
  log_count INTEGER;
BEGIN
  SELECT count(*) INTO log_count FROM platform_company_status_log;
  IF log_count > 0 THEN
    RAISE EXCEPTION 'มีแถว platform_company_status_log อยู่จริง % แถว (ประวัติการเปลี่ยนสถานะบริษัทจริง) — ต้องย้าย/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', log_count;
  END IF;
END $$;

DROP TABLE platform_company_status_log;
