# SiteReq — สารบัญเอกสาร + สถานะโปรเจกต์

หน้ารวมสำหรับคนที่มารับงานต่อ (หรือเจ้าของโปรเจกต์เองอีกหลายเดือนข้างหน้า) ให้เริ่มงานได้เร็วโดยไม่ต้อง
ไล่อ่านทุกไฟล์ — อัปเดตล่าสุด: 2026-08-21

---

## สถานะแต่ละหัวข้อ (1 หน้า)

ลำดับที่ตกลงทำ: **4 → 1 → 2 → 3 → 5**

| หัวข้อ | เรื่อง | สถานะ |
|---|---|---|
| **4** | ใบขอซื้อ (PR) | 🟡 Backend เสร็จ — **UI ยังไม่มี** (หน้าเดิมเป็น demo-mode ล้วนๆ ไม่ต่อ API จริง) รอทำหลังหัวข้อ 1 |
| **1** | Client ledger (เงินสดย่อย 1.1 / เงินทดรองจ่าย 1.2 / เคลียร์เงินทดรองจ่าย 1.3 / จ่ายเจ้าหนี้ภายนอก 1.4) | 🟡 Backend เสร็จ — **UI: 1.1✅ 1.2✅ กำลังขึ้น 1.4** (ลำดับ 1.1→1.2→1.4→1.3) — แต่ละขั้นมี E2E test ถาวรใน `server/tests/*-ui.regression.js` |
| **2** | ผู้รับเหมาช่วง (subcontractor) | 🟡 **master data เสร็จแล้ว** (`client_subcontractors` + CRUD + UI, migration 0009/0010) — ส่วนสัญญา/เบิกจ่าย/บัญชี **บล็อกรอฝ่ายบัญชี** (ดูรายการท้ายไฟล์นี้) |
| **3** | บันทึกความคืบหน้าโครงการ (progress claims — ฝั่งรายรับ เรียกเก็บจากเจ้าของโครงการ) | 📋 วางแผนโครงสร้างไว้แล้ว (3.1/3.1.1/3.1.1.1-3, 3.1.2, 3.2) **ยังไม่เริ่มเขียนโค้ด** รอคิวหลังหัวข้อ 2 — ⚠️ ทิศทางบัญชีตรงข้ามหัวข้อ 2 (รายรับ ไม่ใช่รายจ่าย) ห้ามเอาผัง Dr/Cr มาปนกัน |
| **5** | PO/WO | ⚠️ ของเดิมมีอยู่ (`purchase_orders`) แต่ไม่ผ่านมาตรฐานชุดนี้เลยสักข้อ (ไม่มี composite FK/idempotency/approval workflow/journal entry) — เวลาถึงคิวต้องเขียนใหม่ทั้งหมด ไม่ใช่ต่อยอด |

รายละเอียดเต็มทุกจุด (รวม known limitations ที่ไม่บล็อกแต่ควรรู้) ดูที่
[`pr-module-known-limitations.md`](./pr-module-known-limitations.md)

---

## สารบัญเอกสารทั้งหมด

| ไฟล์ | เนื้อหา |
|---|---|
| [`pr-module-known-limitations.md`](./pr-module-known-limitations.md) | รายการจุดที่ยังไม่สมบูรณ์ทั้งหมด แบ่งกลุ่ม ก. (บล็อกการใช้งานจริง) / ข. (ไม่สะดวกแต่ใช้ได้) |
| [`accounting-review-checklist.md`](./accounting-review-checklist.md) | เช็คลิสต์ให้ฝ่ายบัญชียืนยันสมมติฐานบัญชี/ภาษีของหัวข้อ 1 (WHT 8 ประเภท, ผังบัญชีใหม่, Dr/Cr 5 เคส) |
| [`subcontractor-module-plan.md`](./subcontractor-module-plan.md) | แผนบัญชีเต็มของหัวข้อ 2 (ผู้รับเหมาช่วง) พร้อมจุด ⚠️ ที่รอฝ่ายบัญชียืนยัน |
| [`module-status-overview.md`](./module-status-overview.md) | Endpoint ทั้งหมดที่มีจริง แยกตามหัวข้อ + migration 0001-0006 แต่ละไฟล์เพิ่มอะไร (เขียนไว้ ณ จบหัวข้อ 1 — ดูไฟล์นี้ประกอบกับตารางสถานะด้านบนสำหรับ progress ล่าสุด) |
| [`nssm-service-setup.md`](./nssm-service-setup.md) | ตั้ง Node server เป็น Windows Service ด้วย NSSM — ค่าที่ตั้งจริง, start/stop/restart, log |
| [`cloudflared-tunnel-setup.md`](./cloudflared-tunnel-setup.md) | เปิด `build-con.com` ให้เข้าจากภายนอกผ่าน Cloudflare Tunnel — tunnel ไหนใช้จริง, ติดตั้ง, debug |
| `README.md` (ไฟล์นี้) | สารบัญ + สถานะรวม + setup เครื่องใหม่ |

---

## โครงสร้างระบบ

```
Internet ──▶ build-con.com ──▶ Cloudflare Tunnel ("build-con", remotely-managed)
                                        │
                                        ▼
                              localhost:3000 (Windows Service "SiteReqServer" ผ่าน NSSM)
                                        │
                                        ▼
                              server/server.js (Express)
                                        │
                                        ▼
                              PostgreSQL 18 (Windows Service "postgresql-x64-18")
                              database: sitereq_db
                              app เชื่อมต่อด้วย role sitereq_app (ไม่ใช่ superuser)
```

- **Frontend**: `pr-system.html` (แอปหลักที่ลูกค้าใช้ — vanilla JS SPA ไม่มี build step) +
  `admin-panel.html` (แผงควบคุมฝั่ง platform admin) — locale ที่ `locales/th.json`/`locales/en.json`
- **Backend**: `server/server.js` ไฟล์เดียว (Express + `pg`) — ไม่มี framework แบ่ง route หลายไฟล์
- **Migration**: `server/migrations/000N_*.up.sql`/`.down.sql` — รันผ่าน `node migrations/migrate.js up`
  (ดู `server/migrations/migrate.js` — มี advisory lock กันรันซ้อน, track ใน `schema_migrations`)
- **Test**: `server/tests/*.regression.js` — ยิง HTTP จริงใส่ server ที่ต้องรันอยู่ก่อน (`localhost:3000`)
  ใช้ fixture ร่วมจาก `server/tests/fixtures/setup-approval-fixtures.js` (idempotent, รันซ้ำได้)
  รันทั้งชุด client ledger: `npm run test:client-ledger`

---

## Setup เครื่องใหม่ตั้งแต่ต้นจนจบ

**1) PostgreSQL 18** — ติดตั้ง แล้วสร้าง role/database (หรือ restore จาก backup — ถ้ามี `pg_dumpall`
ให้ import ด้วย `psql` ระวังเรื่อง encoding บน Windows: ต้อง
`psql ... -c "SET client_encoding TO 'UTF8';" -f dump.sql` เสมอ ไม่งั้นคอมเมนต์/ข้อมูลภาษาไทยจะพัง)

**2) Clone repo** (private — ต้องมีสิทธิ์เข้าถึง):
```cmd
git clone https://github.com/ballpopzaza219-dotcom/sales-presentation.git
```

**3) ตั้งค่า `.env`**:
```cmd
copy server\.env.example server\.env
```
แก้ `server/.env` ใส่ค่าจริง (`PGPASSWORD`, `SESSION_SECRET` สุ่มใหม่ด้วย `crypto.randomBytes(32)`,
`GMAIL_USER`/`GMAIL_APP_PASSWORD` ถ้าต้องการส่งอีเมล, `APP_BASE_URL=https://build-con.com`)

**4) ติดตั้ง Node.js** (ถ้ายังไม่มี): `winget install OpenJS.NodeJS.LTS`

**5) ติดตั้ง dependencies + รัน migration**:
```cmd
cd server
npm install
node migrations\migrate.js up
node migrations\migrate.js status
```
ต้องเห็น migration ทุกตัวขึ้น `[x]` ครบ (ปัจจุบันมีถึง 0010)

**6) ทดสอบรันตรงก่อน** (ยังไม่ตั้ง service):
```cmd
npm start
```
เปิด `http://localhost:3000` ต้องเห็นหน้า login

**7) ตั้งเป็น Windows Service** — ดู [`nssm-service-setup.md`](./nssm-service-setup.md) เต็มๆ (ต้อง
Administrator, ต้องตั้ง `DependOnService postgresql-x64-18` ด้วยเสมอ)

**8) เปิดให้เข้าจากภายนอก** — ดู [`cloudflared-tunnel-setup.md`](./cloudflared-tunnel-setup.md) เต็มๆ
(สร้าง tunnel ผ่าน **dashboard เท่านั้น** อย่าใช้ `cloudflared tunnel create` ผ่าน CLI — จะได้ tunnel แบบ
locally-managed ที่แก้ route จาก dashboard ไม่ได้อีกเลย เจอปัญหานี้มาแล้วจริงกับ tunnel เดิม
`sitereq-tunnel`)

**9) ตรวจสอบทั้งระบบ** — รัน `npm run test:client-ledger` ใน `server/` (ต้องมี server รันอยู่ก่อน ผ่าน
`npm start` หรือ service ก็ได้) ต้องผ่านครบทุกไฟล์

---

## รายการที่รอฝ่ายบัญชียืนยัน (บล็อกหัวข้อ 2 ส่วนที่เหลือ)

รายละเอียดเต็มอยู่ใน [`subcontractor-module-plan.md`](./subcontractor-module-plan.md) — สรุปสั้น 4 ข้อ
(เรียงตามความสำคัญ):

1. มีภาษีหัก ณ ที่จ่าย (WHT) บนเงินล่วงหน้าที่จ่ายให้ผู้รับเหมาช่วงหรือไม่ (เสนอ default = มี)
2. มีภาษีมูลค่าเพิ่ม (VAT) บนเงินล่วงหน้าหรือไม่ (ขึ้นกับผู้รับเหมาแต่ละราย เสนอให้ toggle ได้ต่อรายการ)
3. รหัสบัญชี `1160 เงินจ่ายล่วงหน้าผู้รับเหมาช่วง` (สินทรัพย์) ชื่อ/ตำแหน่งในผังบัญชีเหมาะสมหรือไม่
4. จุดเช็ค "กันเบิกเกินมูลค่าสัญญา" ควรอยู่ตอน submit หรือ approve (เสนอ approve)

**ยืนยันแล้ว** (ไม่ต้องถามซ้ำ): บัญชี `1160` แยกจาก `1150` (คนละคู่สัญญา), ฐาน WHT ของงวดงาน = มูลค่างวด
เต็มจำนวน (ไม่ลดด้วย retention/เงินล่วงหน้าที่หักคืน), โครงสร้าง `client_subcontract_billings` รวม
3 ประเภทเอกสารไว้ตารางเดียว

---

## Known limitations อื่นที่ไม่บล็อก (ไม่ต้องรออะไร แต่ควรรู้)

ดูรายการเต็มใน [`pr-module-known-limitations.md`](./pr-module-known-limitations.md) หมวด ข. — ที่เด่น
ที่สุด: **ก.3** (ใบเบิกเงินที่อนุมัติแล้วไม่มี `/void`) และ **ก.4** (ไม่มีกระบวนการนำส่งภาษีหัก ณ ที่จ่าย
ให้กรมสรรพากร — บัญชี 2120 สะสมไม่มีวันลด) เป็น 2 จุดที่ยังบล็อกอยู่เหมือนกัน (ไม่ใช่แค่ "ไม่สะดวก")
ควรอ่านก่อนใช้งานกับเงินจริงระยะยาว
