-- ย้อนกลับ migration 0030 — เอาค่า 'refunded' ออกจาก CHECK ของ invoices.status
--
-- Guard: ปฏิเสธ rollback ถ้ามีใบแจ้งหนี้สถานะ refunded อยู่จริงแม้แต่ใบเดียว (ไม่งั้น ADD CONSTRAINT ด้วย
-- CHECK เดิมที่ไม่รู้จักค่านี้จะ fail กลางทางอยู่ดี แต่ error message ทั่วไปของ Postgres จะไม่บอกชัดว่าต้อง
-- ทำอะไรต่อ — ใส่ guard ของเราเองให้ข้อความชัดเจนกว่า เหมือน guard อื่นๆ ในชุด migration นี้)
DO $$
DECLARE
  refunded_count INTEGER;
BEGIN
  SELECT count(*) INTO refunded_count FROM invoices WHERE status = 'refunded';
  IF refunded_count > 0 THEN
    RAISE EXCEPTION 'มีใบแจ้งหนี้สถานะ refunded อยู่จริง % ใบ — ต้องเปลี่ยนสถานะ/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นจะขัดกับ CHECK เดิมที่ไม่รู้จักค่านี้', refunded_count;
  END IF;
END $$;

ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('unpaid','partial','paid','overdue','cancelled'));
