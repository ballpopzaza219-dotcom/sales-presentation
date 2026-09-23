-- Stripe Billing stage 5: refund processing — CLAUDE.md ข้อ 8 บังคับให้ endpoint ที่เคลื่อนเงินต้องผ่าน
-- withIdempotency เสมอ แต่ withIdempotency เดิม (server.js) hardcode ใช้ req.customer.company_id +
-- client_idempotency_keys ซึ่งผูกกับ session ฝั่งลูกค้า (tenant) เท่านั้น — endpoint refund เป็น action
-- ของ platform_admin (req.currentAdmin) ไม่มี req.customer เลย ใช้กลไกเดิมตรงๆ ไม่ได้
--
-- สร้างตารางคู่ขนานสำหรับฝั่ง platform_admin โดยเลียนแบบโครงสร้าง client_idempotency_keys +
-- client_idempotency_purge_state (migration 0001) ทุกประการ เปลี่ยนแค่ FK จาก customer_companies เป็น
-- platform_admins — เพื่อให้ withPlatformIdempotency() (server.js) มีกลไกเดียวกันเป๊ะ (reserve-then-cache,
-- request_hash กันใช้ key ซ้ำกับ body ต่างกัน, stale reservation reclaim, lazy purge อายุ 7 วัน) โดยไม่ต้อง
-- ดัดแปลง client_idempotency_keys ให้รองรับสอง actor type ปนกัน (จะทำให้ FK/nullable ซับซ้อนขึ้นโดยไม่จำเป็น)
CREATE TABLE platform_idempotency_keys (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, idempotency_key, endpoint)
);
CREATE INDEX idx_platform_idempotency_keys_created ON platform_idempotency_keys(created_at);

-- Singleton row เก็บเวลา purge ล่าสุด สำหรับ throttle lazy-cleanup — pattern เดียวกับ
-- client_idempotency_purge_state เป๊ะ
CREATE TABLE platform_idempotency_purge_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_purged_at TIMESTAMPTZ
);
INSERT INTO platform_idempotency_purge_state (id) VALUES (1);
