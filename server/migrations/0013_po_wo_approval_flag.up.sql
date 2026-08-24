-- can_approve_po_wo — flag ที่ APPROVAL_DOC_TYPE_FLAG_COLUMN ใน server.js ผูกไว้กับ doc_type='po_wo'
-- อยู่แล้วตั้งแต่เขียนโค้ดตอนแรก (เตรียม mapping ไว้ล่วงหน้า) แต่ไม่เคยมีคอลัมน์จริงในตาราง customers เลย —
-- ถ้าเรียก canApprove(..., 'po_wo', ...) โดยไม่มีคอลัมน์นี้จะ throw ทันที ('canApprove: approver.
-- can_approve_po_wo ขาดหายไปหรือไม่ใช่ boolean') พบตอนสำรวจก่อนเขียน endpoint PO/WO จริงในหัวข้อ 5
ALTER TABLE customers ADD COLUMN can_approve_po_wo BOOLEAN NOT NULL DEFAULT false;
