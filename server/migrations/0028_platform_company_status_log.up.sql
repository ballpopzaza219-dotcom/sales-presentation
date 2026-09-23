-- Stripe Billing stage 4: auto-suspend เมื่อเก็บเงินไม่สำเร็จเกิน grace period (3 วัน ตกลงไว้แล้ว) —
-- ตรวจแล้วว่า customer_companies.status (active/suspended) ไม่เคยมี audit trail เลยแม้แต่ endpoint
-- manual suspend เดิม (POST /api/admin/companies/:id/suspend) ก็ไม่เคยบันทึกอะไรไว้ — สร้างตารางนี้ให้
-- ครอบคลุมทั้งการ suspend/reactivate อัตโนมัติ (cron/webhook, changed_by=NULL) และที่ admin กดเอง
-- (changed_by=platform_admins.id) ในตารางเดียวกัน แทนที่จะแยกสองกลไก
--
-- ขอบเขตตั้งใจให้แคบแค่ "การเปลี่ยนสถานะบริษัท" เท่านั้น (ไม่ใช่ audit log ทั่วไปของทุก action ที่ admin ทำ
-- ในระบบ — ยังไม่มี usecase ชัดเจนสำหรับสิ่งนั้นตอนนี้ ไม่ over-engineer ล่วงหน้า)
CREATE TABLE platform_company_status_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL CHECK (from_status IN ('active','suspended')),
  to_status TEXT NOT NULL CHECK (to_status IN ('active','suspended')),
  reason TEXT NOT NULL,
  -- NULL = ระบบเปลี่ยนเองอัตโนมัติ (auto-suspend cron หรือ auto-reactivate ตอน invoice.paid webhook) —
  -- ไม่ใช่ NULL = admin คนนี้เป็นคนกดเปลี่ยนเอง
  changed_by INTEGER REFERENCES platform_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_company_status_log_company ON platform_company_status_log(company_id);
