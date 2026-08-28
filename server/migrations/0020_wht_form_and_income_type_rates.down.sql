-- Rollback for 0020_wht_form_and_income_type_rates.up.sql — reverses in strict reverse order with
-- explicit guards at every point where a blind rollback could silently lose real data, matching the
-- same discipline as 0005/0019.

-- ⚠️ guard: ถ้ามีใบ 50-ทวิ จริงในระบบแล้ว ห้าม rollback — wht_form ไม่มีทางกู้คืนความหมายเดิมได้อัตโนมัติ
DO $$
DECLARE cert_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO cert_count FROM client_wht_certificates;
  IF cert_count > 0 THEN
    RAISE EXCEPTION 'มีใบ 50-ทวิ % ใบอยู่ในระบบแล้ว — ต้องจัดการข้อมูล wht_form ก่อน rollback migration 0020 (ไม่มีทางกู้คืนความหมายเดิมได้อัตโนมัติ)', cert_count;
  END IF;
END $$;

ALTER TABLE client_wht_certificates DROP COLUMN wht_form;
-- idx_client_wht_certificates_form_period ถูกลบอัตโนมัติไปพร้อมคอลัมน์

-- ⚠️ guard: ถ้า rate_individual/rate_juristic ถูกแก้ให้ต่างกันจริงหลัง migrate (เช่น ฝ่ายบัญชีกรอกอัตรา
-- ต่างกันจริงสำหรับโค้ดใดโค้ดหนึ่งในภายหลัง) ไม่มีทางยุบกลับเป็น default_rate ตัวเดียวได้อัตโนมัติ
DO $$
DECLARE mismatched INTEGER;
BEGIN
  SELECT COUNT(*) INTO mismatched FROM client_wht_income_types
  WHERE rate_individual IS DISTINCT FROM rate_juristic;
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'มี % รหัสเงินได้ที่ rate_individual/rate_juristic ต่างกันจริงแล้ว — ไม่มีทางยุบกลับเป็น default_rate เดียวได้โดยอัตโนมัติ ต้องจัดการข้อมูลก่อน rollback', mismatched;
  END IF;
END $$;

-- ⚠️ guard: ถ้ามีเอกสารจริงอ้างอิงรหัสที่แยกใหม่ (40_8_service/40_8_transport) อยู่แล้ว ห้าม rollback
DO $$
DECLARE usage_count INTEGER;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM client_advance_clearance_items WHERE wht_income_type_code IN ('40_8_service','40_8_transport')) +
    (SELECT COUNT(*) FROM client_wht_certificates WHERE wht_income_type_code IN ('40_8_service','40_8_transport')) +
    (SELECT COUNT(*) FROM client_payment_vouchers WHERE wht_income_type_code IN ('40_8_service','40_8_transport')) +
    (SELECT COUNT(*) FROM client_subcontract_terms WHERE wht_income_type_code IN ('40_8_service','40_8_transport')) +
    (SELECT COUNT(*) FROM client_subcontract_billings WHERE wht_income_type_code IN ('40_8_service','40_8_transport'))
  INTO usage_count;
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มีเอกสาร % รายการอ้างอิงรหัส 40_8_service/40_8_transport อยู่แล้วจริง — ต้องจัดการเอกสารเหล่านั้นก่อน rollback migration 0020', usage_count;
  END IF;
END $$;

ALTER TABLE client_wht_income_types ADD COLUMN default_rate NUMERIC(5,2);
UPDATE client_wht_income_types SET default_rate = COALESCE(rate_individual, rate_juristic);

DELETE FROM client_wht_income_types WHERE code IN ('40_8_service', '40_8_transport');
UPDATE client_wht_income_types SET is_active = true WHERE code = '40_8';

ALTER TABLE client_wht_income_types DROP COLUMN rate_individual;
ALTER TABLE client_wht_income_types DROP COLUMN rate_juristic;
