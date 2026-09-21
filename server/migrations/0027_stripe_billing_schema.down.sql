-- ย้อนกลับ migration 0027 — ลบ platform_refunds/platform_webhook_events, คืน journal_entries CHECK
-- ให้แคบกลับ, ลบคอลัมน์ stripe_* ทั้งหมดออกจาก customer_companies/packages/subscriptions
--
-- อันตราย: คอลัมน์ stripe_* เก็บ reference ไปยัง object จริงฝั่ง Stripe (Customer/Subscription/Product/
-- Price) — ถ้ามีข้อมูลจริงตั้งค่าไว้แล้ว การ DROP COLUMN ทิ้งจะทำให้ "จำ" ไม่ได้อีกเลยว่า company ไหนผูกกับ
-- Stripe object ไหน (ต้องไปไล่ค้นใน Stripe Dashboard เอาเองทีละบริษัท ไม่มีทาง reconstruct จากข้อมูลใน DB
-- เราเองได้เลย) — ต้อง guard ปฏิเสธ rollback ถ้ามีข้อมูลจริงตั้งค่าไว้แล้วแม้แต่แถวเดียว

DO $$
DECLARE
  stripe_company_count INTEGER;
  stripe_package_count INTEGER;
  stripe_subscription_count INTEGER;
  refund_count INTEGER;
  webhook_event_count INTEGER;
  refund_journal_count INTEGER;
  reversing_entry_count INTEGER;
BEGIN
  SELECT count(*) INTO stripe_company_count FROM customer_companies WHERE stripe_customer_id IS NOT NULL;
  IF stripe_company_count > 0 THEN
    RAISE EXCEPTION 'มี customer_companies % แถวที่ผูก stripe_customer_id ไว้แล้วจริง — ต้องบันทึกการ mapping ไว้ด้วยมือก่อน rollback มิเช่นนั้นจะหาไม่เจอว่าบริษัทไหนผูกกับ Stripe Customer ไหน', stripe_company_count;
  END IF;

  SELECT count(*) INTO stripe_package_count FROM packages WHERE stripe_product_id IS NOT NULL OR stripe_price_id IS NOT NULL OR stripe_seat_price_id IS NOT NULL;
  IF stripe_package_count > 0 THEN
    RAISE EXCEPTION 'มี packages % แถวที่ผูก Stripe Product/Price ไว้แล้วจริง — ต้องบันทึกการ mapping ไว้ด้วยมือก่อน rollback', stripe_package_count;
  END IF;

  SELECT count(*) INTO stripe_subscription_count FROM subscriptions WHERE stripe_subscription_id IS NOT NULL;
  IF stripe_subscription_count > 0 THEN
    RAISE EXCEPTION 'มี subscriptions % แถวที่ผูก stripe_subscription_id ไว้แล้วจริง — ต้องบันทึกการ mapping ไว้ด้วยมือก่อน rollback', stripe_subscription_count;
  END IF;

  SELECT count(*) INTO refund_count FROM platform_refunds;
  IF refund_count > 0 THEN
    RAISE EXCEPTION 'มีแถว platform_refunds อยู่จริง % แถว (ประวัติการคืนเงินจริง) — ต้องย้าย/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', refund_count;
  END IF;

  SELECT count(*) INTO webhook_event_count FROM platform_webhook_events;
  IF webhook_event_count > 0 THEN
    RAISE EXCEPTION 'มีแถว platform_webhook_events อยู่จริง % แถว (ประวัติ webhook จาก Stripe จริง) — ต้องย้าย/สำรองข้อมูลด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', webhook_event_count;
  END IF;

  SELECT count(*) INTO refund_journal_count FROM journal_entries WHERE source_type = 'refund';
  IF refund_journal_count > 0 THEN
    RAISE EXCEPTION 'มี journal_entries % แถวที่ source_type=''refund'' อยู่แล้วจริง — ต้องย้าย/ลบแถวเหล่านั้นก่อน rollback มิเช่นนั้นข้อมูลจะขัดกับ source_type CHECK เดิมที่ไม่มีค่านี้', refund_journal_count;
  END IF;

  SELECT count(*) INTO reversing_entry_count FROM journal_entries WHERE reverses_entry_id IS NOT NULL;
  IF reversing_entry_count > 0 THEN
    RAISE EXCEPTION 'มี journal_entries % แถวที่ reverses_entry_id ถูกตั้งค่าไว้แล้วจริง — ต้องบันทึกความสัมพันธ์นี้ไว้ด้วยมือก่อน rollback มิเช่นนั้นข้อมูลจะหายถาวร', reversing_entry_count;
  END IF;
END $$;

DROP TABLE platform_refunds;
DROP TABLE platform_webhook_events;

ALTER TABLE journal_entries DROP COLUMN reverses_entry_id;
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('invoice','payment','expense','manual'));

ALTER TABLE subscriptions DROP COLUMN stripe_subscription_id;
ALTER TABLE subscriptions DROP COLUMN stripe_price_id;

ALTER TABLE packages DROP COLUMN stripe_product_id;
ALTER TABLE packages DROP COLUMN stripe_price_id;
ALTER TABLE packages DROP COLUMN seat_price;
ALTER TABLE packages DROP COLUMN stripe_seat_price_id;

ALTER TABLE customer_companies DROP COLUMN stripe_customer_id;
ALTER TABLE customer_companies DROP COLUMN payment_failed_at;
