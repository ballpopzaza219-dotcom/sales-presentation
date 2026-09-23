-- ย้อนกลับ migration 0029 — ลบคอลัมน์ผูก Stripe ออกจาก invoices
--
-- Guard: ปฏิเสธ rollback ถ้ามีใบแจ้งหนี้ใดก็ตามที่ผูกกับ Stripe อยู่จริงแล้ว (stripe_invoice_id/
-- stripe_charge_id ไม่ใช่ NULL) เพราะการเชื่อมโยงกลับ Stripe Invoice/Charge object เดิมจะหายถาวรถ้าลบ
-- คอลัมน์ทิ้งไป (เหมือน guard ของ platform_refunds/platform_webhook_events ใน migration 0027)
DO $$
DECLARE
  stripe_invoice_count INTEGER;
BEGIN
  SELECT count(*) INTO stripe_invoice_count FROM invoices WHERE stripe_invoice_id IS NOT NULL OR stripe_charge_id IS NOT NULL;
  IF stripe_invoice_count > 0 THEN
    RAISE EXCEPTION 'มีใบแจ้งหนี้ % ใบที่ผูกกับ Stripe อยู่จริง (stripe_invoice_id/stripe_charge_id ไม่ใช่ NULL) — ต้องตรวจสอบ/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นจะเสียการเชื่อมโยงกับ Stripe ถาวร', stripe_invoice_count;
  END IF;
END $$;

DROP INDEX IF EXISTS uq_invoices_stripe_invoice_id;
ALTER TABLE invoices DROP COLUMN stripe_invoice_id;
ALTER TABLE invoices DROP COLUMN stripe_charge_id;
