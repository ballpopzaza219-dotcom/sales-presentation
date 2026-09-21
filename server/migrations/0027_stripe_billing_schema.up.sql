-- Stripe Billing integration (platform/admin billing — SiteReq charging its tenant companies for
-- their subscription, NOT client_* tenant-side finance). ตกลงกันไว้แล้ว 4 ข้อก่อนวาง DDL นี้:
-- 1) ที่นั่งเพิ่ม: มีราคาต่อที่นั่งตามแพ็กเกจ (option ก) — Stripe metered/per-unit Price แยกต่อแพ็กเกจ
-- 2) Source of truth ราคา: ระบบเราเอง — admin แก้ราคาในระบบก่อน แล้ว sync ขึ้น Stripe ผ่าน API
--    (Stripe Price เป็น immutable object — "แก้ราคา" จริงๆ คือสร้าง Price ใหม่แล้วเปลี่ยน
--    stripe_price_id ให้ชี้ตัวใหม่ ไม่ใช่ mutate object เดิม — subscription เดิมที่ยังไม่ต่ออายุจะยังอยู่
--    บน Price เก่าต่อไปตามปกติของ Stripe จนกว่าจะต่ออายุ/upgrade จริง)
-- 3) Grace period: 3 วันหลัง Stripe รายงาน subscription เป็น past_due/unpaid (ไม่ใช่นับจากตัดเงินล้มเหลว
--    ครั้งแรก — Stripe เองมี Smart Retries อยู่แล้วก่อนจะยอมแพ้จริง) — ตัวเลขนี้เป็นค่า config ระดับโค้ด
--    ไม่ใช่ schema จึงไม่มีคอลัมน์สำหรับมันตรงนี้
-- 4) บริษัท status='expired' เดิม (ไม่มี Stripe object เลย) ไม่ต้อง backfill สร้าง Stripe
--    Customer/Subscription ให้ตอนนี้ — รอจนกว่าจะมีการต่ออายุจริงค่อยสร้าง (lazy provisioning)
--
-- ทุกคอลัมน์ stripe_* เป็น nullable ทั้งหมดโดยตั้งใจ (lazy provisioning ตามข้อ 4) — ไม่มีการ backfill ค่า
-- Stripe ID ใดๆ ในไฟล์นี้เลย เพราะยังไม่มี Stripe object จริงให้ backfill ก่อนโค้ด integration เสร็จ

-- Guard: ยืนยันก่อนว่าไม่มี subscriptions แถวไหนที่ custom_price เบี่ยงจากราคามาตรฐานแพ็กเกจตัวเองจริง
-- (ตรวจด้วยมือแล้วว่าตอนนี้ไม่มีเคสแบบนี้ — ทุกแถวที่มี custom_price ตรงกับราคาแพ็กเกจเป๊ะ) — เขียน guard
-- ไว้เผื่ออนาคตมีข้อมูลใหม่เข้ามาก่อน migration นี้ apply จริง ป้องกันไม่ให้ "ลืม" กรณีลูกค้าได้ราคาต่อรอง
-- พิเศษไปเงียบๆ ตอนเปลี่ยนมาใช้ระบบแพ็กเกจราคาคงที่ (fail-closed ตาม CLAUDE.md ข้อ 13)
DO $$
DECLARE
  mismatch_count INTEGER;
BEGIN
  SELECT count(*) INTO mismatch_count
  FROM subscriptions s
  JOIN customer_companies c ON c.id = s.company_id
  JOIN packages p ON p.id = c.package_id
  WHERE s.custom_price IS NOT NULL AND s.custom_price <> p.price;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'พบ % แถวใน subscriptions ที่ custom_price ไม่ตรงกับราคามาตรฐานของแพ็กเกจตัวเอง (น่าจะมีการต่อรองราคาพิเศษจริง) — ต้องตัดสินใจด้วยมือก่อนว่าจะ grandfather ราคาเดิมไว้อย่างไรก่อน apply migration นี้ เพราะหลังจากนี้ระบบจะไม่รองรับ custom price ต่อบริษัทอีกต่อไป', mismatch_count;
  END IF;
END $$;

-- ---------------- customer_companies: เชื่อม Stripe Customer + grace-period tracking ----------------
ALTER TABLE customer_companies ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX uq_customer_companies_stripe_customer_id
  ON customer_companies(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
-- ตั้งตอน Stripe webhook รายงานว่า subscription เป็น past_due/unpaid, เคลียร์กลับเป็น NULL ตอนจ่ายสำเร็จ —
-- cron ตัวใหม่ (เขียนพร้อมโค้ด integration ทีหลัง ไม่ใช่ตอนนี้) จะเช็คคอลัมน์นี้ + เทียบกับ grace period 3
-- วันที่ตกลงไว้ ก่อนจะ suspend จริง
ALTER TABLE customer_companies ADD COLUMN payment_failed_at TIMESTAMPTZ;

-- ---------------- packages: เชื่อม Stripe Product/Price + ราคาต่อที่นั่งเพิ่ม ----------------
ALTER TABLE packages ADD COLUMN stripe_product_id TEXT;
ALTER TABLE packages ADD COLUMN stripe_price_id TEXT;
-- seat_price เป็น NULL ไม่ใช่ 0 โดยตั้งใจ (เหมือน client_wht_income_types.default_rate — CLAUDE.md ข้อ 17):
-- NULL = แพ็กเกจนี้ไม่เปิดให้ซื้อที่นั่งเพิ่มเลย, 0 จะสื่อผิดว่า "ซื้อที่นั่งเพิ่มได้ฟรี" ซึ่งคนละความหมายกัน
-- โดยสิ้นเชิง — โค้ดฝั่ง server.js ที่จะเขียนทีหลังต้องปฏิเสธการซื้อที่นั่งเพิ่มทันทีถ้าเจอ NULL ไม่ fallback
-- เป็น 0 เด็ดขาด
ALTER TABLE packages ADD COLUMN seat_price NUMERIC(18,2);
ALTER TABLE packages ADD COLUMN stripe_seat_price_id TEXT;

-- ---------------- subscriptions: เชื่อม Stripe Subscription/Price ----------------
-- คอลัมน์เดิม (custom_price, custom_seat_price, total_amount, period_start, last_additional_users) คงไว้
-- เฉยๆ ไม่ลบ (ข้อมูลประวัติของ flow manual เดิม) แต่โค้ดใหม่หลังจากนี้จะไม่เขียนเพิ่มอีกต่อไป — expires_at/
-- status ยัง sync มาจาก Stripe webhook ต่อเนื่อง (current_period_end/status)
ALTER TABLE subscriptions ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN stripe_price_id TEXT;
CREATE UNIQUE INDEX uq_subscriptions_stripe_subscription_id
  ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- ---------------- journal_entries: เปิดทาง source_type='refund' + reversing-entry linkage ----------------
-- mirror pattern เดียวกับ client_journal_entries.reverses_entry_id ฝั่ง client ledger — ตอนนี้ฝั่ง
-- platform ยังไม่เคยมี concept ของ reversing entry เลยเพราะไม่เคยมี /void มาก่อน (invoices มีแค่ /cancel
-- ซึ่งบล็อกถ้ามีรับชำระแล้วเท่านั้น ไม่เคยต้องย้อนกลับ journal ที่โพสต์ไปแล้วจริง)
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('invoice','payment','expense','manual','refund'));
ALTER TABLE journal_entries ADD COLUMN reverses_entry_id INTEGER REFERENCES journal_entries(id);

-- ---------------- platform_webhook_events: idempotency สำหรับ Stripe webhook ----------------
-- แยกจาก client_idempotency_keys โดยตั้งใจ (ดู gap analysis) — key หลักคือ stripe_event_id ที่ Stripe
-- กำหนดมาเองเสมอ ไม่ใช่ client-supplied key แบบ client_idempotency_keys, ไม่ผูกกับ session ใดๆ (webhook
-- ไม่มี session), และ company_id อาจต้อง resolve จาก payload เองทีหลัง ไม่ใช่ส่วนหนึ่งของ identity key
CREATE TABLE platform_webhook_events (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processed', 'failed')),
  error_message TEXT
);
CREATE INDEX idx_platform_webhook_events_status ON platform_webhook_events(processing_status) WHERE processing_status <> 'processed';

-- ---------------- platform_refunds ----------------
-- สิทธิ์อนุมัติ refund จำกัดแค่ platform_admins.role='owner' เท่านั้น (ตกลงไว้แล้ว) — บังคับที่ชั้น
-- application เท่านั้น (ตาราง platform_admins ไม่มีข้อจำกัดระดับ DB ที่จะเช็คตรงนี้ได้อยู่แล้ว)
-- ⚠️ journal_entry_id ยังเป็น nullable ในไฟล์นี้ — วิธีลงบัญชี (Dr/Cr) ของการคืนเงินยังไม่ได้ข้อสรุปสุดท้าย
-- (ระหว่างคืน AR กลับ vs กลับรายการรายได้ตรงๆ) รอตัดสินใจร่วมกับฝ่ายบัญชีก่อนเขียนโค้ดจริงที่ผูก journal
CREATE TABLE platform_refunds (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  stripe_refund_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES platform_admins(id),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_refunds_invoice ON platform_refunds(invoice_id);
