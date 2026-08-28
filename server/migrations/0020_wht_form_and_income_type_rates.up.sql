-- PR Module — Batch 20: sub-ledger ภ.ง.ด.3/53 (client_wht_certificates.wht_form) + แยกอัตรา WHT ตาม
-- ประเภทผู้เสียภาษี (client_wht_income_types) — ตามข้อสรุปฝ่ายบัญชี (2026-08-27/28)
--
-- ตัดสินใจ (กลับคำจากรอบแรกที่เสนอเพิ่มบัญชี 2121/2122 แยก): ใช้บัญชี 2120 เดิมต่อไป ไม่เพิ่มบัญชีใหม่
-- ไม่ต้อง migrate ยอดเก่า งบดุลไม่แตกเป็น 2 บรรทัด — แยก ภ.ง.ด.3/53 ด้วย sub-ledger บน
-- client_wht_certificates แทน (ตารางนี้มี payment_date อยู่แล้ว ตรงกับ query รายงานรายเดือน)

-- ---------------- (1) wht_form sub-ledger ----------------
-- ⚠️ ตรวจสอบแล้วก่อน apply (2026-08-27): client_wht_certificates มี 0 แถวทั้งระบบ (ทั้ง
-- source_type='advance_clearance_item' และ 'subcontractor_payment') จึงตั้ง NOT NULL ตรงได้เลยโดยไม่ต้อง
-- backfill/DEFAULT ชั่วคราว — ถ้าอนาคตมีข้อมูลจริงก่อน apply ต้อง backfill จาก taxpayer_type ของ payee ที่
-- อ้างอิงใน source_id ก่อน ไม่ใช่ปล่อย NULL หรือ DEFAULT เดียวกันหมด (ผิดหลักการเดียวกับ default_rate)
--
-- ค่าคำนวณฝั่ง server เท่านั้นจาก taxpayer_type ของผู้รับเงิน ห้ามรับจาก client (ดูคอมเมนต์ในโค้ดจุดออก
-- 50-ทวิ): พนักงาน (ไม่มีคอลัมน์ taxpayer_type) = individual เสมอ → 'pnd3', ผู้รับเงินภายนอก/ผู้รับเหมาช่วง
-- อ่าน taxpayer_type จริง → 'individual'→'pnd3', 'juristic'→'pnd53', ค่าอื่นใดต้อง throw (ไม่ fallback)
ALTER TABLE client_wht_certificates ADD COLUMN wht_form TEXT NOT NULL
  CHECK (wht_form IN ('pnd3', 'pnd53'));

CREATE INDEX idx_client_wht_certificates_form_period
  ON client_wht_certificates (company_id, wht_form, payment_date);

-- ---------------- (2) แยกอัตรา WHT ตามประเภทผู้เสียภาษี ----------------
-- แทนที่ default_rate เดี่ยว (สมมติว่าอัตราเดียวกันทุกคน) ด้วย 2 คอลัมน์แยกชัดเจน — ทั้งคู่ nullable
-- ด้วยเหตุผลเดียวกับ default_rate เดิม (40_1 เงินเดือนคำนวณตามอัตราก้าวหน้า ไม่ใช่อัตราคงที่ ต้องเป็น NULL
-- ไม่ใช่ 0) ฝั่งแอปต้องอ่าน "เฉพาะ" คอลัมน์ที่ตรงกับ taxpayer_type ของผู้รับเงิน ห้าม
-- COALESCE(rate_individual, rate_juristic) ข้ามคอลัมน์เด็ดขาด — ถ้าคอลัมน์ที่ควรอ่านเป็น NULL ต้อง throw
-- ("ประเภทเงินได้นี้ไม่มีอัตราสำหรับบุคคลธรรมดา/นิติบุคคล ต้องกรอกเอง") กฎเดียวกับ 40_1 เดิม
ALTER TABLE client_wht_income_types
  ADD COLUMN rate_individual NUMERIC(5,2),
  ADD COLUMN rate_juristic NUMERIC(5,2);

-- Backfill: อัตราเดิมทุกแถวเท่ากันทั้งบุคคลธรรมดา/นิติบุคคลอยู่แล้วในทุกจุดที่ระบบเคยใช้ (40_1 เป็น NULL
-- ทั้งคู่ตามเดิม ไม่มีอะไรเปลี่ยน) — ฝ่ายบัญชียังไม่ได้ระบุอัตราที่ต่างกันจริงระหว่าง 2 ประเภทสำหรับโค้ด
-- ที่มีอยู่ก่อนหน้านี้ ถ้ามีในอนาคตให้ UPDATE เจาะจงเพิ่มเป็น migration แยก
UPDATE client_wht_income_types SET rate_individual = default_rate, rate_juristic = default_rate;

-- แยก 40_8 (เดิม "อื่นๆ ตามคำสั่งกรมสรรพากร ทป.4/2528") เป็น 2 รหัสใหม่ตามที่ฝ่ายบัญชีระบุ — ปิด (ไม่ลบ)
-- 40_8 เดิมกัน FK ของเอกสารเก่าพัง (client_advance_clearance_items/client_payment_vouchers/
-- client_subcontract_terms/client_subcontract_billings/client_wht_certificates ทุกตัวอ้างอิง code นี้ได้)
UPDATE client_wht_income_types SET is_active = false WHERE code = '40_8';

INSERT INTO client_wht_income_types (code, name_th, rate_individual, rate_juristic, is_active) VALUES
  ('40_8_service', 'ค่าบริการทั่วไป ตามคำสั่งกรมสรรพากร ทป.4/2528 (มาตรา 40(8))', 3, 3, true),
  ('40_8_transport', 'ค่าขนส่ง ตามคำสั่งกรมสรรพากร ทป.4/2528 (มาตรา 40(8))', 1, 1, true);

-- ตัดขาด default_rate เลยในไฟล์เดียวกัน (ไม่เก็บ backward-compat column ค้างไว้) — ทุกจุดที่เคยอ่าน
-- default_rate ใน server.js (~20 จุด) ต้องแก้ไขพร้อมกันในโค้ดที่ deploy คู่กับ migration นี้ มิเช่นนั้น
-- server ที่รันอยู่จะพังทันทีที่มีการอ่านคอลัมน์นี้ — ห้าม apply migration นี้ก่อน backend เดพลอยพร้อมกัน
ALTER TABLE client_wht_income_types DROP COLUMN default_rate;
