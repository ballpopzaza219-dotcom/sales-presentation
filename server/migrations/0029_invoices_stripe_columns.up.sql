-- Stripe Billing stage 5: refund processing — เชื่อมตาราง invoices/invoice_payments เดิม (ระบบบันทึก
-- รับชำระด้วยมือที่มีอยู่แล้วเต็มรูปแบบ: generateInvoiceNumber/recordInvoicePayment/mark-paid/cancel/
-- slip upload/AR aging report) เข้ากับ Stripe แทนที่จะสร้าง ledger คู่ขนานใหม่ — เพิ่มแค่ 2 คอลัมน์
-- nullable ไว้จับคู่กับ Stripe Invoice/Charge object เมื่อใบแจ้งหนี้นั้นถูกสร้างจาก webhook invoice.paid
-- (ใบแจ้งหนี้เก่า/ที่สร้างด้วยมือจะเป็น NULL ทั้งคู่ตามปกติ ไม่กระทบข้อมูลเดิม)
--
-- platform_refunds.invoice_id (migration 0027) อ้างอิงตาราง invoices นี้อยู่แล้วตั้งแต่แรก — migration
-- นี้แค่เติมคอลัมน์ที่ยังขาดให้ครบ ไม่ใช่การสร้างความสัมพันธ์ใหม่
ALTER TABLE invoices ADD COLUMN stripe_invoice_id TEXT;
ALTER TABLE invoices ADD COLUMN stripe_charge_id TEXT;

-- partial unique index (ไม่ใช่ unique constraint ธรรมดา) เพราะใบแจ้งหนี้ส่วนใหญ่ (ที่สร้างด้วยมือ) เป็น
-- NULL อยู่แล้ว ต้องอนุญาตหลายแถว NULL พร้อมกันได้ แต่ห้ามซ้ำกันถ้าเป็นค่าจริง — ใช้คู่กับ
-- ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING ใน handleInvoicePaid
-- กัน Stripe webhook retry สร้างแถวซ้ำ (pattern เดียวกับ uq_subscriptions_stripe_subscription_id สเตจ 3)
CREATE UNIQUE INDEX uq_invoices_stripe_invoice_id
  ON invoices(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
