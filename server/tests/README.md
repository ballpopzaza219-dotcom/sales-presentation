# Test fixtures — บัญชีทดสอบสำหรับเทส HTTP ของโมดูล client ledger

สร้างไว้ตอนเทส 【ขั้น 1】ของโมดูล PR (ข้อ 4) และเงินสดย่อย (ข้อ 1.1) — เก็บไว้ถาวรเป็น fixture
ที่ใช้ซ้ำได้ทุกรอบทดสอบถัดไป **ไม่ต้องสร้างใหม่** ยกเว้นถ้าถูกลบไปโดยไม่ได้ตั้งใจ (ดูวิธีสร้างใหม่ท้ายไฟล์)

> **อัปเดต 2026-08-18**: fixture ชุดนี้เคยหายไปทั้งหมดจากการ restore ฐานข้อมูลจาก backup เก่า (schema
> คงอยู่ แต่ข้อมูลที่สร้างหลัง backup วันนั้นหายหมด รวมถึงเทสหัวข้อ 1/4 หลายสิบเคสที่เคยรันผ่านซึ่งไม่เคย
> commit เข้า repo เลยเพราะทำผ่าน scratchpad ชั่วคราว) — บทเรียนจากครั้งนั้น: **สคริปต์สร้าง fixture และ
> regression test ทุกไฟล์ต้อง commit เข้า repo เสมอ ห้ามเป็น one-time script ที่ทำแล้วทิ้ง** ตอนนี้แก้แล้ว
> ทั้งสองส่วน:
> - สคริปต์สร้าง fixture: `server/tests/fixtures/setup-approval-fixtures.js` — เป็น idempotent module
>   (ไฟล์เดียว, `require` ได้จากเทสไฟล์อื่น, รันตรงก็ได้) commit เข้า repo แล้ว ทุกไฟล์
>   `*.regression.js` ในโฟลเดอร์นี้เรียก `setup()` เองตอนเริ่มรัน จึงกู้ fixture คืนอัตโนมัติถ้าหายไปอีก
>   ไม่ต้องมาสร้างมือแบบครั้งก่อน
> - เทสหัวข้อ 1/4: เขียนใหม่เป็นไฟล์ถาวร 5 ไฟล์ (`pr.regression.js`, `petty-cash.regression.js`,
>   `advance.regression.js`, `advance-clearance.regression.js`, `external-payment.regression.js`)
>   ครอบคลุมเคสสำคัญที่เคยรันผ่านมาก่อน (concurrent race, idempotency retry, cross-company 404,
>   self-approval, balance verification, 50-tawi snapshot freeze) — รันรวดเดียวด้วย
>   `npm run test:client-ledger`
>
> **id ของ fixture accounts/rules เปลี่ยนไปจากตารางเดิมด้านล่าง** (เดิม 971-977 / rule 1-4 — หลัง
> restore ได้ id ใหม่ตาม sequence ปัจจุบันของ DB) เทสทุกไฟล์จึง **lookup ด้วย username เสมอ ไม่ hardcode
> id** (ต่างจากที่ตารางด้านล่างอาจสื่อ) — ดู id จริงปัจจุบันด้วย `SELECT id, username FROM customers
> WHERE username LIKE 'fx_%';`

## ขอบเขต: เก็บอะไรไว้ / ลบอะไรทิ้งไปแล้ว

- **เก็บไว้ถาวร**: บัญชี `customers` 7 แถว (id 971-977, username ขึ้นต้นด้วย `fx_`) +
  `client_pr_approval_rules` 4 แถว (id 1-4) — เป็นข้อมูล "บัญชี/สิทธิ์" เฉยๆ ไม่โผล่ในหน้ารายการ
  เอกสารธุรกิจของบริษัทจริง จึงไม่ปนกับข้อมูลลูกค้าจริงที่มองเห็นได้ในหน้าจอ
- **ลบทิ้งแล้ว**: เอกสารธุรกรรมทั้งหมดที่สร้างระหว่างเทส (purchase requests/items/adjustments,
  purchase orders, payment vouchers, petty cash funds/replenishments, journal entries, audit log
  ที่ผูกกับเอกสารเหล่านั้น) — ลบเฉพาะแถวที่สร้างโดยบัญชี fixture เท่านั้น (ยืนยันด้วย dry-run ก่อนลบจริง
  แล้วว่า 100% ของแถวในตารางเหล่านี้เป็นของบัญชีทดสอบ ไม่มีของบัญชีจริงปนเลยสักแถว — ตารางกลุ่มนี้เพิ่งสร้าง
  ใหม่ในเซสชันนี้เอง ยังไม่เคยมีใครใช้งานจริงมาก่อน)

## บริษัทที่ใช้

| บริษัท | company_id | code (login) | ใช้ทำอะไร |
|---|---|---|---|
| บริษัท ทกลอง จำกัด | 13 | `RIXCFR` | บริษัทหลักที่ใช้เทสเกือบทั้งหมด |
| บริษัท ดีดี จำกัด | 19 | `DIUXPB` | ใช้แค่เทส cross-company (ต้องเห็น/แก้เอกสารบริษัทอื่นไม่ได้) |

## บัญชีทดสอบ (ทุกบัญชีรหัสผ่านเดียวกัน: `TestPass123!`)

| username | company | role | can_approve_pr | can_approve_petty_cash | เพดานอนุมัติ (pr / petty_cash) | ใช้ทดสอบอะไร |
|---|---|---|---|---|---|---|
| `fx_maker` | RIXCFR | maker | false | false | - | ผู้สร้าง/ยื่นเอกสารทั่วไป (เจ้าของเอกสาร) |
| `fx_maker2` | RIXCFR | maker | false | false | - | บุคคลที่สาม ไม่เกี่ยวข้องกับเอกสาร ใช้เทส 403 no_permission |
| `fx_approver_mid` | RIXCFR | approver | true | true | 0 - 50,000 | อนุมัติสำเร็จในเพดานปกติ / เทส over_ceiling |
| `fx_approver_floor` | RIXCFR | approver | true | true | 10,000 - 200,000 | เทส under_floor (มีขั้นต่ำ) |
| `fx_approver_norule` | RIXCFR | approver | true | true | *(ไม่มี rule active เลย)* | เทส no_rule (มี flag แต่ไม่มีเพดานตั้งไว้) |
| `fx_super` | RIXCFR | super_user | - | - | ไม่จำกัด (override) | เทส super_user override, สิทธิ์ CRUD กองทุน/consume/release/cancel-qty |
| `fx_other_co` | DIUXPB | super_user | - | - | - | เทส cross-company (ต้องได้ 404) |

## ข้อมูลอ้างอิงที่ใช้ร่วม (ของจริงที่มีอยู่แล้วในบริษัท 13 ไม่ต้องสร้างเอง)

- โครงการ: `project_id=7` (รหัส PRJ-2569-0001) มี budget revision `id=563` (approved) —
  budget item ตัวอย่างที่ใช้ได้: `id=5706, 5707` (อยู่ revision 563)
- โครงการ: `project_id=49` มี budget revision `id=92` (approved) — budget item ตัวอย่าง `id=1500-1504`
  (ใช้เทส "budget_item_id คนละ revision" โดยจงใจเอา item จาก revision 92 ไปใช้กับหัวเอกสารที่ระบุ
  revision 563 — ต้องโดนปฏิเสธ 400)
- พนักงาน (สำหรับ payee ใบเบิกเงินสดย่อย): `employee_id=2` หรือ `22` (status=active)
- รหัสบัญชีค่าใช้จ่าย (expense_account_code): `5100`, `5200`, `5300` (เป็นต้น — ดูเพิ่มด้วย
  `SELECT code FROM client_chart_of_accounts WHERE company_id=13 AND category='expense'`)

## Endpoint login

```
POST /api/customer-login
{ "companyCode": "RIXCFR", "username": "fx_maker", "password": "TestPass123!" }
```

เก็บ cookie จาก response header `Set-Cookie` แล้วแนบกลับไปทุกคำขอถัดไป (session-based auth)

## ถ้า fixture หายไป สร้างใหม่ยังไง

รัน `node tests/fixtures/setup-approval-fixtures.js` ตรงๆ (หรือปล่อยให้เทสไฟล์ไหนก็ได้ใน
`server/tests/*.regression.js` เรียกเองตอนเริ่ม — ทุกไฟล์เรียก `setup()` อยู่แล้ว) — เป็น idempotent
เต็มรูปแบบ รันซ้ำกี่ครั้งก็ได้ ไม่สร้างซ้ำ (upsert ด้วย `ON CONFLICT (username)` สำหรับ `customers`,
เช็ค active rule ก่อน insert สำหรับ `client_pr_approval_rules`) — ครอบคลุมทั้ง `can_approve_pr`,
`can_approve_petty_cash`, `can_approve_advance`, `can_approve_other` และ rule ทั้ง 4 doc_type
(ไม่ใช่แค่ pr/petty_cash เหมือนตารางอ้างอิงด้านบนที่เขียนไว้ตอนแรก — ขยายเพิ่มตอนเขียน
`advance.regression.js`/`advance-clearance.regression.js`/`external-payment.regression.js`)

## หมายเหตุ

อย่าลืมว่าเอกสารธุรกรรม (PR/PO/voucher/fund/replenishment) ที่สร้างระหว่างเทสรอบถัดๆ ไปจะไม่ถูกลบอัตโนมัติ
— ถ้าต้องการเก็บบริษัท 13 ให้สะอาดต่อ ให้ลบเอกสารที่สร้างโดยบัญชี `fx_*` (id 971-977) ทิ้งเองหลังเทสเสร็จ
ทุกครั้ง (บัญชี/rule ไม่ต้องลบ เก็บไว้ใช้ซ้ำได้เรื่อยๆ)
