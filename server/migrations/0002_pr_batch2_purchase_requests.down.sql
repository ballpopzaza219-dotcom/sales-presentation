-- Rollback for 0002_pr_batch2_purchase_requests.up.sql — reverses every change in strict reverse-
-- dependency order, RESTRICT-safe (same discipline as 0001's down.sql).

DROP TABLE client_pr_approval_rules RESTRICT;
ALTER TABLE customers DROP COLUMN can_approve_pr;

DROP TABLE client_purchase_request_item_adjustments RESTRICT;
DROP TABLE client_purchase_request_items RESTRICT;
DROP TABLE client_purchase_requests RESTRICT;

-- ลบเฉพาะ constraint ที่ batch นี้เพิ่มเข้าไป — ไม่แตะตัวตาราง client_purchase_orders/client_budget_items
-- เอง (ทั้งสองมีอยู่ก่อน batch นี้แล้ว ไม่ใช่ของที่ migration นี้สร้าง)
ALTER TABLE client_purchase_orders DROP CONSTRAINT client_purchase_orders_company_id_id_key;
ALTER TABLE client_budget_items DROP CONSTRAINT client_budget_items_company_id_id_key;
