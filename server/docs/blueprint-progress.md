# ความคืบหน้าเทียบกับ Master Blueprint 74 ข้อ

เอกสารติดตามสถานะแบบมีชีวิต (living document) — อัปเดตทุกครั้งที่จบงานแต่ละ stage ตามแผนใน
`idempotent-forging-wave.md` (แผนที่อนุมัติแล้ว 2026-09-10) ต่างจากแผนตรงที่ไฟล์นี้อยู่ใน repo และจะอัปเดต
ต่อเนื่องไปเรื่อยๆ ตลอดโปรเจกต์ ไม่ใช่ snapshot ครั้งเดียวตอนวางแผน

อัปเดตล่าสุด: 2026-09-11 — หลังปิดงาน Stage A ข้อ 1-2 (document numbering migration 0023; Branch/Department
migration 0024 + CRUD endpoints) — เทสถาวรรวม 27 ไฟล์/752 checks ผ่านหมด

---

## หมวดพิเศษ: ระบบภาษีไทย (ไม่ได้อยู่ใน 74 ข้อเดิม — เพิ่มเป็นหมวดของตัวเองตามคำสั่ง 2026-09-08)

| รายการ | สถานะ |
|---|---|
| หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) | ✅ เสร็จสมบูรณ์ |
| แยกอัตราภาษีตามประเภทผู้เสียภาษี (individual/juristic) | ✅ เสร็จสมบูรณ์ |
| ภ.ง.ด.3/53 การนำส่งจริง | ✅ เสร็จสมบูรณ์ |
| /void + reversing entry | ✅ เสร็จสมบูรณ์ (ยกเว้น VAT-block โดยตั้งใจ รอใบลดหนี้) |
| ผัง Dr/Cr 5 เคสเคลียร์เงินทดรองจ่าย | ✅ ยืนยันจากฝ่ายบัญชีแล้ว |
| ฐาน WHT คำนวณจากยอดงวดเต็ม | ✅ ยืนยันจากฝ่ายบัญชีแล้ว |
| VAT ขายบนเงินรับล่วงหน้า | ⚠️ ยังไม่ได้ทำ — เลื่อนไว้ตั้งใจ รอข้อมูลเพิ่มเติมจากฝ่ายบัญชี (ไม่ใช่ built-then-forgotten) |

รายละเอียดเต็ม ดู `idempotent-forging-wave.md` และ `accounting-review-checklist.md`

---

## สถานะ 74 ข้อ แยกตามหมวด (ตรวจจากโค้ดจริง ไม่ใช่จากเอกสารเดิม — ดูวิธีตรวจใน idempotent-forging-wave.md)

**หมายเหตุการอ่านตาราง**: บางข้อในบลูปรินต์เป็นหลักการ/แนวทาง (เช่น ข้อ 66 หลักการแก้ไขระบบเดิม, ข้อ 70
เป้าหมายสูงสุด) ไม่ใช่ feature ที่วัด % เสร็จได้ตรงๆ — ทำเครื่องหมาย "หลักการ" แทนเปอร์เซ็นต์ ยึดปฏิบัติอยู่
ต่อเนื่องตลอดโปรเจกต์แล้ว

| ข้อ | หมวด | % | หมายเหตุ |
|---|---|---|---|
| 1-2 | วิสัยทัศน์/หลักการออกแบบ | หลักการ | ยึดปฏิบัติต่อเนื่อง |
| 3-6 | Multi-tenant/Platform/Company | **~75%** ⬆️ | tenant provisioning จริงผ่าน admin-panel แล้ว **Branch/Department เสร็จแล้ว 2026-09-11** (migration 0024, CRUD 6 endpoints, composite FK isolation, audit log) — เหลือขาด default currency/VAT ระดับบริษัท |
| 7 | Module Architecture (เปิด/ปิดต่อบริษัท) | ~10% | โมดูลมีจริงแต่ hardcode ทั้งหมด ไม่มี toggle ต่อบริษัทเลย |
| 8 | Dashboard | ~40% | มี overview แยกตามโมดูล ไม่มี dashboard รวมศูนย์ |
| 9 | CRM/Sales | 0% | ไม่มี Customer master/opportunity pipeline เลย |
| 10 | Quotation | ~25% | มีแต่ record แบนบรรทัดเดียว ไม่เชื่อม Tender |
| 11 | Contract | ~10% | ไม่มีตาราง Contract จริง มีแค่ไฟล์แนบ |
| 12 | Project Management | ~85% | ✅ ใกล้เคียง blueprint มาก |
| 13 | BOQ | ~80% | ✅ ผ่าน `client_budget_items` เต็มรูปแบบ |
| 14 | Project Budget | ~85% | ✅ approval workflow เต็ม |
| 15 | Project Schedule | ~35% | backend รองรับ Gantt เต็ม แต่ frontend ถูกลดขนาดลงแล้ว |
| 16 | Project Progress | ~20% | มีแค่ % พิมพ์มือ ไม่มีรูปหน้างาน |
| 17-21 | Procurement/PR/PO/GR/Supplier | ~95% | ✅ โมดูลจัดซื้อ (baseline) |
| 22-25 | Inventory/Material/Stock | 0% | ยืนยันด้วย grep ทั้งระบบ ไม่มีเลย |
| 26 | HR Employee Master | ~70% | มี master จริงแยกจาก login user |
| 27 | Attendance | 0% | ไม่มีเลย |
| 28 | Payroll | 0% | ไม่มีเลย |
| 29 | Labor Cost Allocation | ~40% | accrual ledger มี ไม่มี % แบ่งหลายโครงการ |
| 30 | Subcontractor | ~95% | ✅ |
| 31-32 | Equipment/Equipment Cost | 0% | ไม่มีเลย |
| 33-34 | Project Cost/Budget vs Actual | ~50% | ข้อมูลมีเกือบครบ ขาด roll-up dashboard |
| 35 | Document Center | ~20% | ไม่มี registry รวมศูนย์ แต่ละประเภทแยกตาราง |
| 36 | Document Number | **~85%** ⬆️ | **แก้เสร็จ 2026-09-10 (migration 0023)** — atomic, แยกปีจริง, ครบ 14 doc_type — ขาดแค่ branch-level scoping |
| 37 | Document Cancellation (ห้ามนำเลขกลับมาใช้) | **~90%** ⬆️ | **แก้เสร็จพร้อมข้อ 36** — project/quotation ย้ายจาก COUNT(*) มาใช้ counter แล้ว ปิดช่องเลขซ้ำครบทุก doc_type |
| 38 | Approval Architecture (2 engine) | ~40% | Legacy แข็งแรง Workflow ใหม่ยังไม่เริ่ม |
| 39 | New Workflow Engine | 0% | ยังไม่เริ่ม (ตั้งใจ — รอ Stage F) |
| 40 | Approval Strategy | 0% | มี engine เดียว ยังไม่ต้องเลือก |
| 41 | Approval Flow (multi-step/parallel/quorum) | ~10% | progress claim มี 2-stage hardcode เป็นต้นแบบ |
| 42 | Approval Delegation | 0% | ไม่มีเลย |
| 43 | Workflow Version | 0% | ยังไม่เริ่ม |
| 44 | Legacy Compatibility | ~90% | ✅ ยึดหลัก additive-not-replacement มาตลอด |
| 45 | Approval Service (adapter) | 0% | ยังไม่เริ่ม |
| 46 | Audit Log | ~60% | มีตารางกลางจริง แต่ไม่เก็บ before/after ทุกฟิลด์ |
| 47 | Finance | ~90% | ✅ |
| 48 | Tax | ~95% | ✅ ดูหมวดภาษีไทยด้านบน |
| 49 | Accounting | ~90% | ✅ |
| 50 | Reports | ~45% | ขาด aging/vendor-spend/stock-valuation |
| 51 | User/Role/Permission | ~40% | flag-based ทำงานได้ ไม่มี role template |
| 52 | Project-Level Permission | 0% | ไม่มีเลย |
| 53 | Security | ~55% | auth/session/tenant-isolation/audit ดี ยังไม่ตรวจ rate-limiting เชิงลึก |
| 54 | Mobile Site Application | 0% | ไม่มีเลย |
| 55 | Offline Strategy | 0% | ไม่มีเลย |
| 56 | Database Architecture | ~75% | ตารางส่วนใหญ่ตรงกับที่ blueprint ระบุแล้ว |
| 57 | Core Business Flow | หลักการ | สะท้อนจาก feature ที่มีจริงข้างต้น |
| 58 | Procurement Flow | ~95% | ✅ |
| 59 | Labor Flow | ~35% | ไม่มี attendance/payroll ต่อยอด |
| 60 | Material Flow | 0% | ไม่มี inventory |
| 61 | Equipment Flow | 0% | ไม่มี equipment |
| 62 | Project Profit | ~50% | คำนวณได้จากข้อมูลที่มี ยังไม่มีหน้าจอเฉพาะ |
| 63 | Module Dependency | หลักการ | ทำ dependency graph ไว้ใน idempotent-forging-wave.md แล้ว |
| 64 | SaaS Package | ~35% | packages/subscriptions มีจริง ไม่มี feature-matrix |
| 65 | Development Strategy | หลักการ | จัดลำดับใหม่เป็น Stage A-F แล้ว |
| 66-68 | หลักการแก้ไขระบบเดิม/Testing/DoD | หลักการ | ยึดปฏิบัติต่อเนื่อง (694→733 checks, PRESERVE/MODIFY/ADD ทุกครั้ง) |
| 69-74 | จุดขาย/เป้าหมาย/สถาปัตยกรรมหลัก | หลักการ | แนวทางกำกับภาพรวม |

**สรุปโดยประมาณ** (ตัวเลขนี้เป็นการจัดกลุ่มคร่าวๆ เพื่อดูภาพรวมเท่านั้น ไม่ใช่การตรวจนับที่แม่นยำ 100%
เพราะหลายข้อคาบเกี่ยวกัน): **เสร็จแล้ว (≥80%) ~16 ข้อ, ทำบางส่วน (10-79%) ~25 ข้อ, ยังไม่เริ่ม (&lt;10%)
~19 ข้อ, เป็นหลักการ/แนวทางที่ปฏิบัติตามอยู่แล้ว ~14 ข้อ**

---

## Stage A (จากแผนที่อนุมัติ) — ความคืบหน้า

| งาน | สถานะ |
|---|---|
| 1. แก้บั๊ก document numbering (ปี/สาขาใน key) | ✅ **เสร็จแล้ว 2026-09-10** — migration 0023, commit `dc20a4f`/`b4198a9`, เทส 26 ไฟล์/733 checks ผ่านหมด |
| 2. Branch/Department ของบริษัทเอง | ✅ **เสร็จแล้ว 2026-09-11** — migration 0024, CRUD 6 endpoints (`server.js`), commit `6d4bea6`/`b4942a7`/`45db393`, เทส 27 ไฟล์/752 checks ผ่านหมด |
| 3. Customer Master จริง | ⏳ ยังไม่เริ่ม (ลำดับถัดไปตามแผน) |

## จุดที่ต้องติดตามต่อ (จากงาน Stage A ข้อ 1-2)

- ข.11: `generateInvoiceNumber`/`generateQuotationNumber` (admin-panel/platform billing) มีบั๊กเดียวกัน
  (timezone + reuse-after-delete) — ยังไม่แก้ นอกขอบเขต migration 0023 ดู `pr-module-known-limitations.md`
- ข.12: down.sql migration 0023 ส่วน guard >1 ปี ยืนยันด้วยมือแล้วแต่ยังไม่มี automated test — ดู
  `pr-module-known-limitations.md`
- ข.13: down.sql migration 0024 guard แยกข้อมูล backfill เป็น heuristic (`code NOT LIKE 'DEPT-%'`) — ดู
  `pr-module-known-limitations.md`
- ข.14 (แก้แล้ว 2026-09-11, commit `cd0e461`): `tests/attachments-void-cancel.regression.js` เคย hardcode
  รายการ `doc_type` ของ CHECK constraint ไว้ตรงๆ เพื่อ "คืนค่า" หลังจงใจแคบ CHECK กลางเทส — ค่าที่ hardcode
  เก่ากว่า migration 0024 ทำให้ทุกครั้งที่ไฟล์นี้รันใน `test:regression-all` จะคืนค่า CHECK กลับไปแคบกว่าที่
  migration 0024 ตั้งไว้จริง (ไม่มี `'branch'`/`'department'`) ทำให้ `test:branches-departments` ที่รันทีหลัง
  ในลำดับ chain พังแบบดูเหมือนสุ่ม ทั้งที่ apply migration ถูกต้องแล้ว — แก้โดยให้อ่าน constraint จริงจาก DB
  (`pg_get_constraintdef`) ตอนเริ่มเทสแทน hardcode **บทเรียน: เทสไฟล์ใดก็ตามที่ "จำลองการพังกลางทาง" ด้วยการ
  แคบ constraint ชั่วคราวแล้วคืนค่าด้วย string ตายตัว มีความเสี่ยงแบบเดียวกับ CLAUDE.md ข้อ 23 (hardcoded
  status/type list ตกหล่นตาม migration ใหม่) — ควรตรวจแนวเดียวกันนี้ในเทสไฟล์อื่นที่ทำ pattern คล้ายกันด้วย
  ถ้าเจอในอนาคต**
