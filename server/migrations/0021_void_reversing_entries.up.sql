-- PR Module — Batch 21: /void (undo an approved document + reversing journal entry) — ตามข้อสรุปฝ่ายบัญชี
-- (2026-08-28), ครอบคลุม client_payment_vouchers / client_advance_clearances / client_subcontract_billings
-- / client_progress_claims (+ client_revenue ที่มันสร้าง) — client_petty_cash_replenishments **ไม่รวมใน
-- ขอบเขตนี้** (ยืนยันแล้ว: กองทุนคำนวณยอดสดจาก SUM(...) WHERE status='approved' อยู่แล้ว แค่เปลี่ยน status
-- ของใบเบิก/ใบเติมเงินออกจาก 'approved' ยอดก็ปรับถูกต้องอัตโนมัติ ไม่จำเป็นต้องมี /void แยกในตอนนี้ — ถ้า
-- วันหน้าเปลี่ยนไปเก็บเป็นคอลัมน์สะสม (ไม่ใช่คำนวณสด) ต้องกลับมาทบทวนเพิ่ม void ให้ตารางนี้ด้วย ดู
-- known-limitations ข.10)
--
-- ⚠️ ตรวจสอบแล้วก่อนเขียนไฟล์นี้ — งานส่วนใหญ่ถูกวางรากฐานไว้แล้วตั้งแต่ migration 0003/0001 แต่ไม่เคยมี
-- endpoint ไหนใช้จริง:
--   - client_journal_entries.reverses_entry_id + partial unique index uq_client_journal_entries_
--     reverses_entry_id (company_id, reverses_entry_id) WHERE NOT NULL — มีอยู่แล้วจาก migration 0003
--     กันแถวมากกว่า 1 แถวชี้ reverse entry เดิมตัวเดียวกันได้อัตโนมัติ ไม่ต้องเพิ่มอะไรอีก
--   - client_payment_vouchers / client_advance_clearances / client_subcontract_billings: status CHECK
--     รองรับค่า 'voided' อยู่แล้ว + มีคอลัมน์ voided_by(composite FK)/voided_reason/voided_at ครบแล้ว
--   - ไม่ต้องเพิ่มคอลัมน์ is_reversal แยก — เช็ค reverses_entry_id IS NOT NULL แทนได้เลย (คอลัมน์เดียวพอ)
--   - client_document_audit_log.action ไม่มี CHECK จำกัดค่า — action='void' ใช้ได้ทันทีไม่ต้องแก้ไฟล์นี้
--   - client_document_audit_log.doc_type ครบทั้ง 4 ประเภทที่ใช้จริงในรอบนี้อยู่แล้ว (payment_voucher,
--     advance_clearance, subcontractor_payment, progress_claim)
-- Reversing entry ใช้ entry_date = วันที่ void จริง (วันนี้) ไม่ใช่วันเดียวกับ entry เดิม — ยืนยันแล้วว่า
-- เป็นวิธีคิดที่ถูกต้อง (entry เดิมคือข้อเท็จจริงทางประวัติศาสตร์ว่าเกิดขึ้นวันไหน reversing entry คือ
-- เหตุการณ์ใหม่ที่เกิดขึ้นวันนี้ ไม่ใช่การแก้ไขอดีต) — ไม่มีผลต่อ DDL ไฟล์นี้ เป็นเรื่อง backend ล้วนๆ

-- ---------------- (1) client_wht_certificates: เพิ่มสถานะยกเลิก + ออกใบใหม่อ้างอิงใบเก่า ----------------
-- ตั้งชื่อคอลัมน์ voided_* ให้ตรงกับคำศัพท์เดียวกันที่ใช้ทั้งระบบ (payment_vouchers/advance_clearances/
-- subcontract_billings) แม้ภาษาไทยจะเรียก "ยกเลิก 50 ทวิ" ก็ตาม — เพื่อความสม่ำเสมอของชื่อคอลัมน์ทั้งระบบ
-- ค่า status ใช้ 'active'/'voided' — สอดคล้องกับ client_revenue.status ด้านล่าง (ทั้งคู่เป็นคอลัมน์ที่สร้าง
-- เองรอบนี้ทั้งคู่ จึงกำหนดค่าที่เป็นไปได้ทั้งหมดให้ตรงกันได้ ต่างจาก client_payment_vouchers/
-- client_advance_clearances/client_subcontract_billings ที่ enum เดิมมีมาก่อนแล้วแก้ตามไม่ได้) — รายงาน
-- ภ.ง.ด. รายเดือน (migration ถัดไป) ต้อง filter ด้วย status <> 'voided' เสมอ ห้ามรวมใบที่ถูกยกเลิกแล้ว
ALTER TABLE client_wht_certificates
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN voided_reason TEXT,
  ADD COLUMN voided_by INTEGER,
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN replaces_cert_id INTEGER;

ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_status_check
  CHECK (status IN ('active', 'voided'));
-- บังคับกรอกเหตุผลเสมอเมื่อยกเลิก (ข้อ 5 ที่ฝ่ายบัญชีระบุ) เป็นเกราะชั้น DB เสริมจาก validation ชั้นแอป
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_company_id_id_key
  UNIQUE (company_id, id);
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);
-- replaces_cert_id: ใบใหม่ที่ออกแทนใบที่ถูกยกเลิก — เลขที่ใบเดิม (cert_no) ไม่ถูกนำกลับมาใช้เองอยู่แล้ว
-- เพราะ generateWhtCertNo() สุ่มเลขใหม่ทุกครั้งจาก sequence เดินหน้าอย่างเดียว ไม่มีทางย้อนกลับมาชนของเดิม
ALTER TABLE client_wht_certificates ADD CONSTRAINT client_wht_certificates_replaces_cert_id_fk
  FOREIGN KEY (company_id, replaces_cert_id) REFERENCES client_wht_certificates(company_id, id);
-- กันใบใหม่มากกว่า 1 ใบอ้างว่า "แทนที่" ใบเก่าใบเดียวกัน (pattern เดียวกับ uq_client_journal_entries_
-- reverses_entry_id ข้างบน)
CREATE UNIQUE INDEX uq_client_wht_certificates_replaces_cert_id
  ON client_wht_certificates(company_id, replaces_cert_id) WHERE replaces_cert_id IS NOT NULL;

-- ---------------- (2) client_revenue: ไม่มีกลไก void เลยมาก่อน (ตรวจสอบแล้ว — ไม่มีแม้แต่คอลัมน์ status)
-- ----------------
-- progress_claim สร้างแถว client_revenue ตอนอนุมัติ (revenue_id ผูกกลับมา) — void progress_claim ต้อง void
-- แถวนี้ไปด้วยพร้อมกัน ไม่งั้นรายงานที่ query client_revenue ตรงๆ (ไม่ผ่าน journal) จะยังเห็นรายได้นี้อยู่
-- ทั้งที่ journal ถูก reverse ไปแล้ว — ตัดสินใจเอง (ไม่ใช่นโยบายบัญชี แค่ความถูกต้องของข้อมูล ไม่มีทาง
-- เลือกอื่นที่สมเหตุสมผลกว่า): บล็อก void ถ้า (ก) applied_amount>0 (ถูกใบอื่นเบิกไปแล้ว — ตามที่ตกลง) หรือ
-- (ข) มีแถวใน client_revenue_payments อ้างอิงอยู่แล้ว (ลูกค้าชำระเงินจริงมาแล้ว ไม่มีทาง reverse การรับเงิน
-- จริงผ่าน endpoint นี้ได้ ต้องมีกลไกอื่นจัดการก่อน) — เช็คระดับแอปทั้งคู่ ไม่ใช่ DB constraint
ALTER TABLE client_revenue
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN voided_reason TEXT,
  ADD COLUMN voided_by INTEGER,
  ADD COLUMN voided_at TIMESTAMPTZ;

ALTER TABLE client_revenue ADD CONSTRAINT client_revenue_status_check
  CHECK (status IN ('active', 'voided'));
ALTER TABLE client_revenue ADD CONSTRAINT client_revenue_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
ALTER TABLE client_revenue ADD CONSTRAINT client_revenue_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);

-- ---------------- (3) client_progress_claims: เพิ่ม voided_* + ขยาย status CHECK ----------------
ALTER TABLE client_progress_claims
  ADD COLUMN voided_reason TEXT,
  ADD COLUMN voided_by INTEGER,
  ADD COLUMN voided_at TIMESTAMPTZ;

ALTER TABLE client_progress_claims DROP CONSTRAINT client_progress_claims_status_check;
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_status_check
  CHECK (status IN ('draft', 'submitted', 'certified', 'approved', 'rejected', 'cancelled', 'voided'));
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_voided_by_fk
  FOREIGN KEY (company_id, voided_by) REFERENCES customers(company_id, id);

-- ---------------- (4) เสริมเกราะย้อนหลังให้ 3 ตารางเดิมที่มี 'voided' อยู่แล้วแต่ไม่เคยบังคับเหตุผล ----------------
ALTER TABLE client_payment_vouchers ADD CONSTRAINT client_payment_vouchers_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
ALTER TABLE client_subcontract_billings ADD CONSTRAINT client_subcontract_billings_voided_reason_check
  CHECK (status <> 'voided' OR voided_reason IS NOT NULL);
