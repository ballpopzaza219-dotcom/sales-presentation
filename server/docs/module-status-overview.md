# สถานะรวมโมดูล client ledger / PR — ณ จบหัวข้อ 1

อัปเดตล่าสุด: 2026-08-06 (จบหัวข้อ 1: 1.1-1.4 ครบ, หัวข้อ 4: PR ครบ) · แก้ไข: 2026-08-19

⚠️ **"เสร็จสมบูรณ์" ในเอกสารนี้หมายถึง backend/endpoint เท่านั้น ไม่รวม UI** — สำรวจจริงตอนเริ่มทำ UI
(2026-08-19) พบว่า **ทั้งหัวข้อ 1 (1.1-1.4) และหัวข้อ 4 (PR) ไม่มี UI ที่ต่อ API จริงเลยสักหน้า** — หน้า
`pagePRList`/`pageCreatePR` ที่มีอยู่ในโค้ดเป็น **demo-mode ล้วนๆ** อ่าน/เขียนแค่ `DB.prs` (array เดโม
hardcode) ไม่เคยเรียก endpoint จริงข้างล่างนี้เลยแม้แต่ครั้งเดียว — กำลังสร้าง UI จริงอยู่ (ดู
`server/docs/README.md` สำหรับสถานะล่าสุด)

## Endpoint ทั้งหมดที่มีจริง แยกตามหัวข้อ

### หัวข้อ 1 — Client ledger (เงินสด/เงินทดรองจ่าย/จ่ายภายนอก) — **Backend เสร็จสมบูรณ์ / UI กำลังทำ**

**1.1 เงินสดย่อย**
- `GET/POST/PUT /api/customer/petty-cash-funds`, `/:id`
- `GET/POST/PUT /api/customer/payment-vouchers` (voucher_type=petty_cash) + `/submit /approve /reject /cancel`
- `GET/POST/PUT /api/customer/petty-cash-replenishments`, `/:id` + `/submit /approve /reject /cancel`

**1.2 เงินทดรองจ่าย** (ใช้ตาราง/route เดียวกับ 1.1 แต่ voucher_type=advance)
- `GET/POST/PUT /api/customer/payment-vouchers` + `/submit /approve /reject /cancel`
- `GET /api/customer/outstanding-advances` (ยอดคงค้างรายพนักงาน)

**1.3 เคลียร์เงินทดรองจ่าย**
- `GET/POST/PUT /api/customer/advance-clearances`, `/:id` + `/submit /approve /settle /reject /cancel`
- `GET /api/customer/advance-clearances/:id/wht-certificates`
- `GET /api/customer/wht-payable-summary` (สรุปยอดหัก ณ ที่จ่ายรายเดือน ให้บัญชีเอาไปยื่นเอง)

**1.4 จ่ายเจ้าหนี้ภายนอก** (ใช้ตาราง/route เดียวกับ 1.1/1.2 แต่ voucher_type=other)
- `GET/POST/PUT /api/customer/payment-vouchers` + `/submit /approve /reject /cancel`
- `GET /api/customer/payment-vouchers/:id/wht-certificates`

### หัวข้อ 4 — ใบขอซื้อ (PR) — **Backend เสร็จสมบูรณ์ / UI ยังไม่มี (ทำก่อนหัวข้อ 1 ในเซสชันก่อนหน้า)**
- `GET/POST/PUT /api/customer/purchase-requests`, `/:id` + `/submit /approve /reject /cancel`
- `POST /api/customer/purchase-requests/:id/items/:itemId/consume /release /cancel-qty`
- `GET /api/customer/purchase-requests/:id/items/:itemId/adjustments`

### หัวข้อ 2 — ผู้รับเหมาช่วง (subcontractor) — **ไม่มีอะไรเลย**
ไม่มีตาราง ไม่มี endpoint สักจุด — ดู known-limitations ข้อ 1

### หัวข้อ 3 — ⚠️ ไม่แน่ใจว่าคืออะไร ต้องถามคุณ (ดูรายการคำถามท้ายไฟล์)
พบว่า `server/docs/pr-module-known-limitations.md` ที่มีอยู่ก่อนเซสชันนี้อ้างถึงตาราง/endpoint
`client_progress_claims` (ใบขอเบิกความคืบหน้า?) แต่**ไม่มีอยู่จริงในโค้ดปัจจุบันเลย** — ไม่มีตาราง
ไม่มี route ไม่มีร่องรอยอื่นใดนอกจากในไฟล์เอกสารนั้น ไม่แน่ใจว่าเป็นเอกสารที่เขียนไว้ล่วงหน้าก่อนสร้างจริง
(แล้วยังไม่ได้ทำ) หรือเคยมีแล้วถูกลบ/ย้อนกลับไปในบางจุดของประวัติโปรเจกต์

### หัวข้อ 5 — PO/WO — **มีแค่ PO แบบพื้นฐานเดิม (ไม่ผ่านมาตรฐานชุดนี้เลย)**
- `GET/POST /api/customer/purchase-orders`, `/:id`, `PUT .../status`, `DELETE /:id`
- ของเดิมที่มีอยู่ก่อนเซสชันนี้ — **ไม่มี** composite FK เข้ม, **ไม่มี** idempotency, **ไม่มี**
  approval workflow, **ไม่โพสต์ journal entry**, เก็บ items เป็น JSONB ก้อนเดียวแทนตารางแยก
  ไม่ตรงกับกฎ CLAUDE.md ข้อ 1-9 ที่ใช้กับ PR/client ledger เลยสักข้อ — เวลาจะทำหัวข้อ 5 จริงต้อง
  พิจารณาเขียนใหม่ทั้งหมด ไม่ใช่ต่อยอดของเดิม
- WO (หนังสือสั่งจ้าง) — ไม่มีอะไรเลย

## Migration 0001-0006 แต่ละไฟล์เพิ่มอะไร

| # | ชื่อไฟล์ | เพิ่มอะไร |
|---|---|---|
| 0001 | pr_batch1_payment_vouchers | โครงสร้างพื้นฐานทั้งหมดของหัวข้อ 1: `client_external_payees`, `client_petty_cash_funds`, `client_payment_vouchers` (รองรับ 3 ประเภทตั้งแต่ต้น), `client_petty_cash_replenishments`, `client_advance_clearances`+`items`+`attachments`, `client_wht_certificates`, `client_document_audit_log`, `client_idempotency_keys`, `can_approve_petty_cash`, seed บัญชี 1110/1150 |
| 0002 | pr_batch2_purchase_requests | โครงสร้าง PR ทั้งหมด: `client_purchase_requests`+`items`+`item_adjustments`, `client_pr_approval_rules`, `can_approve_pr` |
| 0003 | pr_batch3_advance_clearance_prep | seed บัญชี 1170/2120, `rejected_reason` บน replenishments, `settlement_*` บน clearances (ตอนนั้นยังผูกกับ `approved`), `client_wht_income_types`+seed 8 ประเภท, `wht_income_type_code` บน clearance_items+wht_certificates, `reverses_entry_id`+unique index บน journal_entries |
| 0004 | advance_approval_doctype | แยก `doc_type='advance'` + `can_approve_advance` (สิทธิ์อนุมัติเงินทดรองจ่ายแยกจากเงินสดย่อย) |
| 0005 | advance_clearance_settle_split | `has_tax_invoice`+CHECK บน clearance_items, แยกสถานะ `settled` ออกจาก `approved` (แก้ settlement_required_check ให้ผูกกับ settled แทน), seed บัญชี 2110 (เจ้าหนี้พนักงาน) |
| 0006 | external_payment_prep | VAT/WHT columns บน `client_payment_vouchers` (ใช้ตอน voucher_type=other), ขยาย `wht_certificates.source_type` รับ `payment_voucher`, แยก `doc_type='other'` + `can_approve_other` |

รวม: บริษัททุกบริษัทมีบัญชีใหม่ **5 รหัส** จากเซสชันนี้ (1110, 1150, 1170, 2110, 2120) — ไม่นับ 1260
ที่มีอยู่ก่อนแล้วจากฟีเจอร์ client_revenue_payments เดิม

## คำถามจากการสำรวจนี้ (ไม่ใช่ yes/no — รวบรวมไว้ท้ายรายงานหลักตามกฎใหม่)
ดูท้าย `server/docs/pr-module-known-limitations.md`
