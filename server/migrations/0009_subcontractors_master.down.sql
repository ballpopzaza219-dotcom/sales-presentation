-- Rollback for 0009_subcontractors_master.up.sql
--
-- Guard เพิ่มเข้ามาแล้ว (ของเดิมเป็นแค่ DROP TABLE IF EXISTS เฉยๆ ไม่มีการป้องกันเลย — พลาดไปตอนร่างครั้ง
-- แรก): DROP TABLE ไม่มีกลไกป้องกันในตัวเองเหมือน ALTER ... ADD CONSTRAINT (ที่ Postgres validate กับ
-- แถวเดิมอัตโนมัติแล้ว fail เองถ้าไม่ผ่าน) ต้องเช็คเองก่อนเสมอว่ามีข้อมูลจริงอยู่ไหม แล้ว RAISE EXCEPTION
-- ปฏิเสธชัดเจน ดีกว่าลบรายชื่อผู้รับเหมาที่ผู้ใช้กรอกไว้จริงทิ้งไปเงียบๆ โดยไม่รู้ตัว
DO $$
DECLARE
  row_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO row_count FROM client_subcontractors;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'ยกเลิกไม่ได้: มีข้อมูลผู้รับเหมาช่วงอยู่จริง % แถวใน client_subcontractors — ต้องลบ/ย้ายข้อมูลเหล่านี้เองก่อน rollback', row_count;
  END IF;
END $$;

DROP TABLE client_subcontractors;
