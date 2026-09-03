-- Rollback for 0021_void_reversing_entries.up.sql — reverse order, guarded wherever a blind rollback
-- would silently discard real void/cancellation history.

-- (4) ถอดเกราะย้อนหลัง 3 ตารางเดิม — ปลอดภัย ไม่มีการสูญเสียข้อมูล (แค่เอา CHECK ออก)
ALTER TABLE client_subcontract_billings DROP CONSTRAINT client_subcontract_billings_voided_reason_check;
ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_voided_reason_check;
ALTER TABLE client_payment_vouchers DROP CONSTRAINT client_payment_vouchers_voided_reason_check;

-- (3) client_progress_claims
DO $$
DECLARE voided_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO voided_count FROM client_progress_claims WHERE status = 'voided';
  IF voided_count > 0 THEN
    RAISE EXCEPTION 'มีใบเบิกความคืบหน้าที่ถูก void ไปแล้ว % ใบ — ต้องจัดการข้อมูลก่อน rollback migration 0021 (ไม่มีทางกู้คืนสถานะเดิมได้อัตโนมัติ)', voided_count;
  END IF;
END $$;

ALTER TABLE client_progress_claims DROP CONSTRAINT client_progress_claims_voided_reason_check;
ALTER TABLE client_progress_claims DROP CONSTRAINT client_progress_claims_voided_by_fk;
ALTER TABLE client_progress_claims DROP CONSTRAINT client_progress_claims_status_check;
ALTER TABLE client_progress_claims ADD CONSTRAINT client_progress_claims_status_check
  CHECK (status IN ('draft', 'submitted', 'certified', 'approved', 'rejected', 'cancelled'));
ALTER TABLE client_progress_claims DROP COLUMN voided_at;
ALTER TABLE client_progress_claims DROP COLUMN voided_by;
ALTER TABLE client_progress_claims DROP COLUMN voided_reason;

-- (2) client_revenue
DO $$
DECLARE voided_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO voided_count FROM client_revenue WHERE status = 'voided';
  IF voided_count > 0 THEN
    RAISE EXCEPTION 'มีรายรับที่ถูก void ไปแล้ว % แถว — ต้องจัดการข้อมูลก่อน rollback migration 0021 (ไม่มีทางกู้คืนสถานะเดิมได้อัตโนมัติ)', voided_count;
  END IF;
END $$;

ALTER TABLE client_revenue DROP CONSTRAINT client_revenue_voided_by_fk;
ALTER TABLE client_revenue DROP CONSTRAINT client_revenue_voided_reason_check;
ALTER TABLE client_revenue DROP CONSTRAINT client_revenue_status_check;
ALTER TABLE client_revenue DROP COLUMN voided_at;
ALTER TABLE client_revenue DROP COLUMN voided_by;
ALTER TABLE client_revenue DROP COLUMN voided_reason;
ALTER TABLE client_revenue DROP COLUMN status;

-- (1) client_wht_certificates
DO $$
DECLARE voided_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO voided_count FROM client_wht_certificates WHERE status = 'voided';
  IF voided_count > 0 THEN
    RAISE EXCEPTION 'มีใบ 50-ทวิ ที่ถูก void ไปแล้ว % ใบ — ต้องจัดการข้อมูลก่อน rollback migration 0021 (ไม่มีทางกู้คืนสถานะเดิมได้อัตโนมัติ)', voided_count;
  END IF;
END $$;

DROP INDEX uq_client_wht_certificates_replaces_cert_id;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_replaces_cert_id_fk;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_voided_by_fk;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_company_id_id_key;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_voided_reason_check;
ALTER TABLE client_wht_certificates DROP CONSTRAINT client_wht_certificates_status_check;
ALTER TABLE client_wht_certificates DROP COLUMN replaces_cert_id;
ALTER TABLE client_wht_certificates DROP COLUMN voided_at;
ALTER TABLE client_wht_certificates DROP COLUMN voided_by;
ALTER TABLE client_wht_certificates DROP COLUMN voided_reason;
ALTER TABLE client_wht_certificates DROP COLUMN status;
