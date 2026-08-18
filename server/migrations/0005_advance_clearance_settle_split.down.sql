-- Rollback for 0005_advance_clearance_settle_split.up.sql — reverses in strict reverse-dependency
-- order, with explicit guards (RAISE EXCEPTION) at every point where a blind rollback could silently
-- corrupt or orphan real data already created using this migration's new capabilities — matching the
-- same discipline as the guards already used for 1170/2120 in 0003 (up.sql guard there checks BEFORE
-- creating; these guard DOWN, checking BEFORE destroying, which up.sql's guard alone can't cover).

-- ⚠️ guard: ถ้ามีแถวสถานะ 'settled' อยู่จริง ต้อง rollback ไม่ได้ — ถ้าปล่อยให้ DROP+ADD constraint
-- ผ่านไปเงียบๆ แถวที่มี status='settled' อยู่แล้วจะขัดกับ CHECK เดิม (ไม่มี 'settled' ในรายการที่ยอมรับ)
-- ทำให้ constraint ใหม่ (แคบกว่าเดิม) ปฏิเสธข้อมูลที่มีอยู่จริงทันทีตอน ALTER TABLE (Postgres ตรวจทุกแถว
-- ที่มีอยู่แล้วตอนเพิ่ม CHECK constraint เสมอ) — แปลว่า statement จะพังอยู่ดี แต่ error message ดิบจาก
-- Postgres จะไม่บอกตรงๆ ว่าต้องทำอะไรต่อ ใส่ guard ให้ error message อ่านรู้เรื่องแทน
DO $$
DECLARE
  settled_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO settled_count FROM client_advance_clearances WHERE status = 'settled';
  IF settled_count > 0 THEN
    RAISE EXCEPTION 'มีใบเคลียร์เงินทดรองจ่าย % ใบอยู่ในสถานะ settled แล้ว — ต้องย้ายสถานะแถวเหล่านี้ (เช่น กลับไป approved ชั่วคราว หรือย้ายออกจากตาราง) ก่อน rollback migration 0005 มิเช่นนั้นข้อมูลจะขัดกับ status CHECK เดิมที่ไม่มี ''settled''', settled_count;
  END IF;
END $$;

ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_settlement_required_check;
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_settlement_required_check
  CHECK (
    status NOT IN ('approved','voided') OR
    difference_amount = 0 OR
    (settlement_date IS NOT NULL AND settlement_channel IS NOT NULL)
  );

ALTER TABLE client_advance_clearances DROP CONSTRAINT client_advance_clearances_status_check;
ALTER TABLE client_advance_clearances ADD CONSTRAINT client_advance_clearances_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','cancelled','voided'));

-- ⚠️ guard: ถ้ามี journal entry line ใดๆ อ้างอิงบัญชี 2110 อยู่แล้วจริง ต้อง rollback ไม่ได้ — DELETE
-- รหัสบัญชีที่ยังมี journal line ผูกอยู่จริงจะทำให้ FK (client_jel_account_fk บน
-- client_journal_entry_lines) ปฏิเสธทันทีอยู่แล้วก็จริง (Postgres บังคับเอง) แต่ error ดิบจาก FK
-- violation ไม่บอกว่า "ต้องทำอะไรต่อ" — guard นี้ให้ error message อ่านรู้เรื่องแทน ก่อนที่จะไปชน FK จริง
DO $$
DECLARE
  usage_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO usage_count FROM client_journal_entry_lines WHERE account_code = '2110';
  IF usage_count > 0 THEN
    RAISE EXCEPTION 'มี journal entry line % แถวอ้างอิงบัญชี 2110 (เจ้าหนี้พนักงาน) อยู่แล้วจริง — ต้องจัดการ/ย้ายรายการเหล่านั้นก่อน rollback migration 0005 ไม่งั้นจะไปชน FK client_jel_account_fk (บัญชีมี transaction ผูกอยู่จริง ลบไม่ได้อยู่ดี แต่ guard นี้บอกสาเหตุชัดเจนกว่า foreign key violation ดิบๆ)', usage_count;
  END IF;
END $$;

DELETE FROM client_chart_of_accounts
WHERE company_id IN (SELECT id FROM customer_companies) AND code = '2110';

ALTER TABLE client_advance_clearance_items DROP CONSTRAINT client_advance_clearance_items_tax_invoice_check;
ALTER TABLE client_advance_clearance_items DROP COLUMN has_tax_invoice;
