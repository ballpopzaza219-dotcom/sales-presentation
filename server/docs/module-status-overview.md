# สถานะรวมโมดูล client ledger / PR — เอกสารอ้างอิงเชิงเทคนิค

อัปเดตล่าสุด: 2026-08-27 — **ทุกหัวข้อ (1, 2, 3.1, 4, 5) + งานหน้างาน (ตรวจรับของ/ส่งบิลค่าใช้จ่าย) +
โครงสร้าง PR⇄Finance เสร็จสมบูรณ์แล้ว** เหลือแค่ 3.2 (Project Complete, อสังหาริมทรัพย์) ที่ยังไม่มีนิยาม
requirement — ดู [`README.md`](./README.md) สำหรับสรุปแบบภาษาคนไม่อ่านโค้ด และ
[`pr-module-known-limitations.md`](./pr-module-known-limitations.md) สำหรับจุดที่ยังค้างจริง

## Endpoint ทั้งหมดที่มีจริง แยกตามหัวข้อ

### หัวข้อ 1 — Client ledger (เงินสด/เงินทดรองจ่าย/จ่ายภายนอก) — ✅ เสร็จสมบูรณ์

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

เทสถาวร: `server/tests/petty-cash-vouchers-ui.regression.js`, `advance-vouchers-ui.regression.js`,
`external-payment-ui.regression.js`, `advance-clearance-ui.regression.js`,
`advance-clearance-settle-ui.regression.js` + HTTP-level suite (`npm run test:client-ledger`)

### หัวข้อ 2 — ผู้รับเหมาช่วง (subcontractor) — ✅ เสร็จสมบูรณ์ครบ 2.1-2.3

**Master data**
- `GET/POST/PUT /api/customer/subcontractors`

**สัญญา/หนังสือสั่งจ้าง** (`client_subcontract_terms` — ตัวเดียวกับ "WO" ของหัวข้อ 5)
- `GET/POST/PUT /api/customer/subcontract-terms`, `/:id` + `/submit /approve /reject /cancel /complete /terminate`

**2.1-2.3 เบิกเงินตามสัญญา** (`client_subcontract_billings` — รวม 3 ประเภทในตารางเดียว ผ่าน
`billing_type`: advance/progress/retention_release)
- `GET/POST/PUT /api/customer/subcontract-billings`, `/:id` + `/submit /approve /reject /cancel`
- `GET /api/customer/subcontract-terms/:id/balance` (ยอดเงินล่วงหน้าคงค้าง/เงินประกันผลงานที่กันไว้/ยอดเบิกสะสม — คำนวณสดจาก SUM ไม่เก็บเป็นคอลัมน์สะสม)
- `GET /api/customer/subcontract-billings/:id/wht-certificates`

เทสถาวร: `server/tests/subcontractors.regression.js` (HTTP-level, ส่วนหนึ่งของ `test:client-ledger`),
`server/tests/subcontract-billings-ui.regression.js` (46 checks)

### หัวข้อ 3 — บันทึกความคืบหน้าโครงการ (progress claims) — 🟡 3.1 เสร็จสมบูรณ์ / 3.2 ยังไม่เริ่ม

**3.1 เรียกเก็บเงินจากเจ้าของโครงการ** (`client_progress_claims` — รองรับทั้ง claim_type=advance/progress
และ claim_mode=installment/boq)
- `GET/POST/PUT /api/customer/progress-claims`, `/:id` + `/submit /certify /approve /reject /cancel`
- `GET /api/customer/projects/:id/outstanding-advance`

**3.2 Project Complete (อสังหาริมทรัพย์)** — ยังไม่มีตาราง/endpoint ใดๆ เลย รอนิยาม requirement — ดู
[`pr-module-known-limitations.md`](./pr-module-known-limitations.md)

เทสถาวร: `server/tests/progress-claims-ui.regression.js` (30 checks)

### หัวข้อ 4 — ใบขอซื้อ (PR) — ✅ เสร็จสมบูรณ์
- `GET/POST/PUT /api/customer/purchase-requests`, `/:id` + `/submit /approve /reject /cancel`
- `POST /api/customer/purchase-requests/:id/items/:itemId/consume /release /cancel-qty`
- `GET /api/customer/purchase-requests/:id/items/:itemId/adjustments`

เทสถาวร: `server/tests/pr-ui.regression.js` (26 checks) + `pr.regression.js` (HTTP-level)

### หัวข้อ 5 — PO/WO — ✅ เขียนใหม่ทั้งหมดตามมาตรฐานชุดนี้

**PO (ใบสั่งซื้อวัสดุ)** — `client_purchase_orders` เขียนใหม่ทั้งหมด (migration 0012), เดิมไม่มี
composite FK/idempotency/approval workflow/journal entry เลยสักข้อ
- `GET/POST/PUT /api/customer/purchase-orders`, `/:id` + `/submit /approve /reject /cancel`

**WO (สัญญาจ้างผู้รับเหมาช่วง)** — ใช้ `client_subcontract_terms` ร่วมกับหัวข้อ 2 โดยตรง (ไม่มี route
แยกต่างหากชื่อ "work-orders" — ดูรายการ endpoint ในหัวข้อ 2 ด้านบน)

เทสถาวร: `server/tests/po-ui.regression.js` (33 checks), `server/tests/wo-ui.regression.js` (27 checks)

### งานหน้างาน — ตรวจรับของตาม PO + ส่งบิลค่าใช้จ่ายจากหน้างาน — ✅ เสร็จสมบูรณ์

**ตรวจรับของ** (`client_goods_receipts`+`items`+`attachments`, migration 0017) — ไม่มี submit/approve
สร้างคือขั้นสุดท้ายในตัวเอง ยอดรับสะสมต่อบรรทัด PO คำนวณสดจาก SUM เสมอ
- `GET/POST /api/customer/goods-receipts`, `GET /:id`
- `GET /api/customer/purchase-orders/:id/receipt-summary` (สั่ง/รับแล้ว/คงเหลือต่อบรรทัด)
- `GET /api/customer/goods-receipts/:id/attachments/:attachmentId/file`
- แก้ `POST /api/customer/purchase-orders/:id/cancel` ให้บล็อก 409 ถ้ามีการตรวจรับของไปแล้ว

**ส่งบิลค่าใช้จ่ายจากหน้างาน** (`client_site_expense_submissions`+`attachments`, migration 0018) — เป็น
inbox/triage เท่านั้น ไม่โพสต์ journal เอง บัญชีต้องสร้างเอกสารจริงเอง (ใบเคลียร์เงินทดรองจ่าย/payment
voucher) แล้วกลับมาปิดเรื่องอ้างอิงเอกสารที่สร้างจริง
- `GET/POST /api/customer/site-expense-submissions`, `GET /:id`
- `GET /api/customer/site-expense-submissions/:id/attachments/:attachmentId/file`
- `POST /api/customer/site-expense-submissions/:id/reject /close`

**ไฟล์แนบ** — ครั้งแรกที่ schema เต็ม (`storage_path`/`mime_type`/`file_size`/`checksum` จาก migration
0001) ถูกต่อ endpoint จริง (2 ตารางเดิมของหัวข้อ 1 มี schema เดียวกันแต่ไม่เคยมี endpoint) — เก็บที่
`server/uploads/goods-receipt-attachments/` และ `server/uploads/site-expense-attachments/` ไฟล์ละ
ไม่เกิน 5MB สูงสุด 5 ไฟล์ต่อคำขอ (jpg/png/webp/pdf เท่านั้น) เข้าถึงได้เฉพาะผ่าน endpoint ที่เช็ค
`requireCustomerAuth` + `company_id` scope ทุกครั้ง (ยืนยันแล้วด้วยการทดสอบจริง: ไม่ auth = 401,
ข้ามบริษัท = 404, ไม่มีทาง static-serve หลุดออกไปเพราะมี guard บล็อก `/server/*` ทั้งหมดอยู่แล้ว) — ยังไม่มี
กลไกลบไฟล์เมื่อเอกสารถูกตีกลับ/ปิดเรื่อง (ดู known-limitations)

เทสถาวร: `server/tests/site-work-ui.regression.js` (28 checks)

### โครงสร้าง PR⇄Finance — เอกสารปฏิบัติการเห็นได้จาก 2 โมดูล — ✅ เสร็จสมบูรณ์

`pr-system.html` มี `DOC_GROUP_ACCESS` เป็นจุดเดียวที่ตัดสิน "ใครเห็นเมนูเอกสารกลุ่มไหนบ้าง" ให้ทั้ง
`navFor()` (โมดูล PR) และ `financeNavFor()` (โมดูล Finance) ดึงจากจุดเดียวกันเสมอ — เอกสารปฏิบัติการ (PR,
PO, WO, ผู้รับเหมาช่วง, เบิกเงินผู้รับเหมาช่วง, ตรวจรับของ, ส่งบิลหน้างาน, เงินสดย่อย/เงินทดรองจ่าย)
เห็นได้จากทั้ง 2 โมดูล ส่วนเอกสารบัญชี/ปิดงวดล้วนๆ (สมุดรายวัน, งบทดลอง, งบการเงิน, รายรับ-ต้นทุน,
ลูกหนี้-เจ้าหนี้ ฯลฯ) เปิดเฉพาะโมดูล Finance + `super_user` เหมือนเดิม

การเปลี่ยนหน้า/เปิดฟอร์มทุกจุดในระบบต้องผ่าน `goToPage(page, extraState)` เท่านั้น (ห้าม set `S.page`
ตรงๆ ที่ไหนอีก — ดู CLAUDE.md หมวด "กฎการเขียน frontend") ซึ่งเรียก `loadDataForPage()` ให้อัตโนมัติเสมอ —
แก้บั๊กคลาส "เปลี่ยนหน้าแล้วข้อมูลที่หน้านั้นต้องใช้ไม่ถูกโหลด" ที่เจอจริงมาแล้ว 6 จุด (switch-module,
เปิดฟอร์มส่งบิลหน้างาน, เปิดฟอร์มสร้างโครงการจาก PR, สร้าง tender/PO สำเร็จแล้ว redirect ไปหน้า detail
ที่โหลดข้อมูลไม่ครบ)

เทสถาวร: `server/tests/dual-module-nav.regression.js` (62 checks)

## Migration 0001-0018 แต่ละไฟล์เพิ่มอะไร

| # | ชื่อไฟล์ | เพิ่มอะไร |
|---|---|---|
| 0001 | pr_batch1_payment_vouchers | โครงสร้างพื้นฐานทั้งหมดของหัวข้อ 1: `client_external_payees`, `client_petty_cash_funds`, `client_payment_vouchers` (รองรับ 3 ประเภทตั้งแต่ต้น), `client_petty_cash_replenishments`, `client_advance_clearances`+`items`+`attachments`, `client_wht_certificates`, `client_document_audit_log`, `client_idempotency_keys`, `can_approve_petty_cash`, seed บัญชี 1110/1150 |
| 0002 | pr_batch2_purchase_requests | โครงสร้าง PR ทั้งหมด: `client_purchase_requests`+`items`+`item_adjustments`, `client_pr_approval_rules`, `can_approve_pr` |
| 0003 | pr_batch3_advance_clearance_prep | seed บัญชี 1170/2120, `rejected_reason` บน replenishments, `settlement_*` บน clearances (ตอนนั้นยังผูกกับ `approved`), `client_wht_income_types`+seed 8 ประเภท, `wht_income_type_code` บน clearance_items+wht_certificates, `reverses_entry_id`+unique index บน journal_entries |
| 0004 | advance_approval_doctype | แยก `doc_type='advance'` + `can_approve_advance` (สิทธิ์อนุมัติเงินทดรองจ่ายแยกจากเงินสดย่อย) |
| 0005 | advance_clearance_settle_split | `has_tax_invoice`+CHECK บน clearance_items, แยกสถานะ `settled` ออกจาก `approved` (แก้ settlement_required_check ให้ผูกกับ settled แทน), seed บัญชี 2110 (เจ้าหนี้พนักงาน) |
| 0006 | external_payment_prep | VAT/WHT columns บน `client_payment_vouchers` (ใช้ตอน voucher_type=other), ขยาย `wht_certificates.source_type` รับ `payment_voucher`, แยก `doc_type='other'` + `can_approve_other` |
| 0007 | manage_permission_flags | `can_manage_po`/`can_manage_petty_cash_fund`/`can_settle_cash` — แยกสิทธิ์ "จัดการ" ออกจากสิทธิ์ "อนุมัติ" (เดิมผูกกับ `super_user` ชั่วคราว) |
| 0008 | fix_wht_income_types_ownership | แก้ ownership ของ `client_wht_income_types` ที่หลุดไปเป็น `postgres` (จากการรัน 0003 ผ่าน `psql -U postgres` ตรงๆ ตอนยังไม่มี Node.js) ให้กลับมาเป็น `sitereq_app` |
| 0009 | subcontractors_master | `client_subcontractors` (master data ผู้รับเหมาช่วง) — ยังไม่แตะบัญชี/ภาษี |
| 0010 | subcontractor_audit_doctype | `doc_type='subcontractor'` ใน audit log สำหรับแก้ไข master data ผู้รับเหมาช่วง |
| 0011 | external_payee_audit_doctype | `doc_type='external_payee'` ใน audit log สำหรับแก้ไข master data ผู้รับเงินภายนอก |
| 0012 | po_wo_batch | เขียนใหม่ `client_purchase_orders` ทั้งหมด + `client_subcontract_terms` (สัญญา/WO) ใหม่ตามมาตรฐานชุดนี้ |
| 0013 | po_wo_approval_flag | `can_approve_po_wo` (คอลัมน์จริงที่ขาดหายไปตอนแรก ทำให้ `canApprove('po_wo', ...)` throw) |
| 0014 | progress_claims_batch | `client_progress_claims`+`items`, บัญชีใหม่ `2160 เงินรับล่วงหน้าจากลูกค้า`, `can_certify_progress`/`can_approve_progress` |
| 0015 | subcontract_billings_batch | `client_subcontract_billings`+`retention_release_items`, บัญชีใหม่ `1160`/`2130`/`2140`, `can_approve_subcontract_billing` |
| 0016 | journal_source_type_subcontract_billing | เพิ่ม `'subcontract_billing'` เข้า `client_journal_entries.source_type` CHECK (แก้จากที่เคยใช้ `'manual'` ผิดหลักการชั่วคราว) |
| 0017 | goods_receipts_batch | `client_goods_receipts`+`items`+`attachments`, `can_submit_goods_receipt`, แก้ `/purchase-orders/:id/cancel` ให้บล็อกถ้ารับของไปแล้ว |
| 0018 | site_expense_submissions_batch | `client_site_expense_submissions`+`attachments`, `can_submit_site_expense` |

รวม: บริษัททุกบริษัทมีบัญชีใหม่ **9 รหัส** จากทุกเซสชัน (1110, 1150, 1160, 1170, 2110, 2120, 2130, 2140,
2160) — ไม่นับ 1260 ที่มีอยู่ก่อนแล้วจากฟีเจอร์ `client_revenue_payments` เดิม (0017/0018 ไม่เพิ่มบัญชีใหม่
— เป็น log ปฏิบัติการ ไม่ใช่เอกสารการเงินที่โพสต์ journal เอง)
