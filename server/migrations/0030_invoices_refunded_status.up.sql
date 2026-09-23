-- Stripe Billing stage 5: refund processing — ขยาย CHECK ของ invoices.status ให้รับค่า 'refunded' เพิ่ม
--
-- ก่อนขยาย CHECK นี้ ได้ไล่ grep หา hardcoded status list ที่อ้างถึงตาราง invoices ทั้งหมดตาม CLAUDE.md
-- ข้อ 23 แล้ว พบ 2 จุดที่ต้องแก้พร้อมกัน (แก้ไปแล้วใน server.js ก่อนหน้านี้):
--   1. recordInvoicePayment() บล็อกรับชำระซ้ำเฉพาะ status='cancelled' — ต้องบล็อก 'refunded' ด้วย
--   2. รายงานกำไรขาดทุน + รายงาน VAT ใช้ status <> 'cancelled' (นับทุกอย่างที่ไม่ใช่ cancelled เป็นรายได้/
--      ยอดขาย) — ต้องเปลี่ยนเป็น status NOT IN ('cancelled','refunded') ไม่งั้นใบที่คืนเงินแล้วจะยังถูกนับ
--      เป็นรายได้อยู่ ทั้งที่เงินคืนไปแล้วจริง
-- ส่วนที่ตรวจแล้วว่าไม่ต้องแก้ (ปลอดภัยอยู่แล้วด้วย pattern เดิม):
--   - รายงาน receivables-aging ใช้ status IN ('unpaid','overdue') — 'refunded' ไม่เข้าเงื่อนไขนี้อยู่แล้ว
--     (ใบที่คืนเงินได้ต้องเคย paid มาก่อน ไม่เคยเป็น unpaid/overdue ค้างอยู่)
--   - dashboard revenue stat ใช้ status='paid' ตรงๆ — ใบที่เปลี่ยนเป็น refunded จะหลุดจากผลรวมอัตโนมัติเอง
--   - endpoint /cancel เช็ค SUM(invoice_payments.amount) > 0 อยู่แล้ว — ใบที่ refunded ได้ต้องเคยมีการรับ
--     ชำระมาก่อนเสมอ จึงถูกบล็อกไม่ให้ cancel อยู่แล้วโดยอัตโนมัติจาก guard เดิม ไม่ต้องแก้เพิ่ม
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('unpaid','partial','paid','overdue','cancelled','refunded'));
