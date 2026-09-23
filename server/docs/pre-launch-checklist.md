# เช็คลิสต์ก่อนขึ้นใช้งานจริง (Pre-launch Checklist)

รวบรวมจากเอกสาร primer ภายนอก repo ("BUILDCON") ที่วางไว้ตอนต้นเซสชันการทำงานกับ Stripe Billing
(2026-09) + รายการใหม่ที่พบระหว่างงานเซสชันนี้ — สร้างไฟล์นี้ไว้ใน repo เพื่อไม่ต้องพึ่งเอกสารนอก repo
อีกต่อไป **หมายเหตุความสมบูรณ์**: บางหัวข้อยังเป็นแค่หัวข้อย่อ (ผู้เขียนไม่มีเนื้อหาต้นฉบับของ primer ให้
อ้างอิงตอนสร้างไฟล์นี้ — มีแค่ชื่อหัวข้อที่เจ้าของโปรเจกต์ระบุมา) ต้องเติมรายละเอียดจริงเพิ่มเมื่อพร้อม

อัปเดตล่าสุด: 2026-09-23 — Stripe Billing สเตจ 1-5 เสร็จสมบูรณ์ทั้งหมดแล้ว (เดิม: ตัดหัวข้อ "D: เป็น
FAT32" ออก เปลี่ยนวิธีเก็บ backup ไปแล้ว ไม่เกี่ยวข้องอีกต่อไป)

---

## 1. ล้างข้อมูลทดสอบ (company_id = 13)

**สถานะ**: ยังไม่ได้ทำ — ต้องทำเป็นขั้นตอนสุดท้ายก่อน launch จริงเท่านั้น (หลังเทสทุกอย่างผ่านหมดแล้ว)

`company_id = 13` (บริษัท "ทกลอง จำกัด") คือบริษัท fixture ที่เทสถาวรทั้งชุด (`server/tests/*.regression.js`)
ใช้เป็น `COMPANY_A_ID` ร่วมกันแทบทุกไฟล์ — ต้องลบ/เคลียร์ข้อมูลทั้งหมดที่ผูกกับบริษัทนี้ก่อนขึ้นใช้งานจริง
รวมถึง:
- ผู้ใช้ fixture ทั้งหมด (`fx_super`, `fx_maker`, `fx_maker2`, `fx_approver_mid`, `fx_settler`,
  `fx_sitework` ฯลฯ จาก `server/tests/fixtures/setup-approval-fixtures.js`)
- เอกสารทดสอบทุกประเภทที่สร้างขึ้นภายใต้บริษัทนี้ตลอดการพัฒนา (PR/PO/WO/ใบเบิกเงิน/ใบเคลียร์เงินทดรองจ่าย
  ฯลฯ) รวมถึง journal entries ที่โพสต์จากเอกสารเหล่านั้น
- บัญชี `platform_admins` อีเมล `e2e-stripe-fixture@sitereq.local` (role='owner', fixture สำหรับเทส Stripe
  Billing โดยเฉพาะ — ไม่ผูกกับ company_id 13 โดยตรงแต่เป็นข้อมูลทดสอบเช่นกัน)
- Stripe test-mode objects (Product/Price/Customer/Subscription) ที่มี prefix ชื่อ "E2E" — ต้อง archive/
  ลบใน Stripe Dashboard (โหมด Test mode) แยกต่างหากจากการลบข้อมูลใน DB เรา

**ข้อควรระวัง**: อย่าลบ 4 แพ็กเกจจริง (Basic/Pro/Enterprise/Free) หรือ Stripe Product/Price ของแพ็กเกจ
เหล่านั้นที่ sync ไปจริงแล้ว (stage 1) — เป็นข้อมูล production ไม่ใช่ข้อมูลทดสอบ — และห้ามลบบริษัทจริงอื่นๆ
(1, 2, 3, 19, 20, 21) ที่มีอยู่แล้วในระบบ

## 2. พิจารณาย้ายจาก PC ไป VPS

**สถานะ**: ระบุไว้เป็นหัวข้อจาก primer เดิม — **ยังไม่มีรายละเอียด** ต้องเติมเพิ่ม

สถาปัตยกรรมปัจจุบัน (ดู [`README.md`](./README.md)) รันบนเครื่อง Windows PC จริงผ่าน NSSM (Windows
Service) + Cloudflare Tunnel เปิดให้เข้าถึงจากภายนอกที่ `build-con.com` — ไม่ใช่ VPS/cloud server
**ต้องการข้อมูลเพิ่มจากเจ้าของโปรเจกต์**: VPS provider ที่จะใช้, timeline, และจะย้าย PostgreSQL ไปด้วยหรือ
แยก host

## 3. PDPA / สัญญา / Billing

**สถานะ**: ระบุไว้เป็นหัวข้อจาก primer เดิม — **ยังไม่มีรายละเอียด** ต้องเติมเพิ่ม

หัวข้อกว้างที่คาดว่าครอบคลุม (ต้องยืนยันกับเจ้าของโปรเจกต์):
- **PDPA** — ระบบเก็บข้อมูลส่วนบุคคลจริงหลายจุด (พนักงาน, เอกสารแรงงานต่างด้าว, ผู้ติดต่อลูกค้า) ต้องมี
  นโยบายความเป็นส่วนตัว/ฐานทางกฎหมายในการเก็บข้อมูลก่อนรับลูกค้าจริง
- **สัญญา** — ข้อตกลงการใช้บริการ (Terms of Service) ระหว่าง SiteReq กับบริษัทผู้เช่าระบบ — ยังไม่มีอยู่ใน
  ระบบเลย (ไม่ใช่ `client_subcontract_terms` ซึ่งเป็นสัญญาฝั่ง tenant กับผู้รับเหมาช่วงของเขาเอง คนละเรื่อง)
- **Billing** — คาดว่าเกี่ยวกับการออกใบกำกับภาษีเต็มรูปที่ถูกต้องตามกฎหมายสำหรับรายได้ค่าสมัครสมาชิกที่ SiteReq
  เก็บจากบริษัทผู้เช่า (ปัจจุบันมีแค่ `invoices`/`quotations` แบบไม่เต็มรูปตามที่พบใน gap analysis ของ Stripe
  Billing — ดู [`blueprint-progress.md`](./blueprint-progress.md))

## 4. Stripe Billing — ต้องแก้ก่อนขึ้นจริง (พบระหว่างเซสชันนี้)

**สถานะ**: สเตจ 1-5 เสร็จสมบูรณ์ทั้งหมดแล้ว (2026-09-23, ดู git log) — เหลือแค่จุดที่ตั้งใจทิ้งไว้เป็นค่า
ชั่วคราวสำหรับพัฒนา/ทดสอบเท่านั้นก่อนขึ้นใช้งานจริง

- **`STRIPE_WEBHOOK_SECRET`** ใน `server/.env` เป็นค่าที่สร้างขึ้นเองสำหรับทดสอบ signature verification
  แบบ offline เท่านั้น (ไม่ใช่ secret จริงจาก Stripe) — **ต้องเปลี่ยนเป็นค่าจริง** ที่ Stripe Dashboard แสดง
  ตอนลงทะเบียน webhook endpoint จริง (Developers → Webhooks → Add endpoint) ก่อนใช้งานจริง เพราะต้องมี
  public URL ให้ Stripe ยิง webhook มาถึงก่อนถึงจะลงทะเบียนได้จริง (มี `build-con.com` ผ่าน Cloudflare
  Tunnel อยู่แล้ว ใช้เป็น endpoint ได้เลยเมื่อพร้อม)
- **`STRIPE_SECRET_KEY`** ปัจจุบันเป็น **test mode key** (`sk_test_...`) — ต้องเปลี่ยนเป็น live mode key
  (`sk_live_...`) ก่อนเก็บเงินจริง (สลับพร้อมกับ toggle "Test mode" เป็น off ใน Stripe Dashboard)
- **สเตจ 5 (refund) รองรับเฉพาะ "คืนเต็มจำนวน" เท่านั้น** — ยังไม่รองรับคืนบางส่วน/คืนซ้ำหลายครั้งต่อ
  ใบแจ้งหนี้เดียว (`platform_refunds` schema รองรับได้อยู่แล้วถ้าต้องขยายในอนาคต แต่ยังไม่มีการยืนยัน
  use case จริงตอนสร้าง) — ถ้าฝ่ายบัญชีต้องการคืนบางส่วนจริง ต้องออกแบบเพิ่มก่อนใช้งาน
- **บั๊กจริง 2 ตัวที่พบระหว่างสร้างสเตจ 3-5 และแก้ไปแล้วทั้งคู่** (บันทึกไว้เผื่อค้นย้อนหลัง — ดู
  git log ของ commit `37f01e0`/`2708a13` สำหรับรายละเอียดเต็ม):
  1. Stripe API เวอร์ชันของบัญชีนี้ย้าย `invoice.subscription`/`invoice.charge` ไปที่ตำแหน่งอื่น
     (`invoice.parent.subscription_details.subscription`, ผ่าน `stripe.invoicePayments`+`paymentIntents`
     ตามลำดับ) ทำให้ `handleInvoicePaid`/`handleInvoicePaymentFailed` เงียบมาตั้งแต่สเตจ 3 — ยืนยันแล้วว่า
     ไม่กระทบข้อมูลจริง (ไม่มีบริษัทจริงเข้าใช้ Stripe เลยตลอดช่วงที่มีบั๊ก)
  2. `withIdempotency` (ใช้อยู่ 38 จุดทั่วระบบ client-ledger) — กลไก "reclaim reservation ที่ค้างเกิน
     5 นาที" ไม่เคยทำงานได้จริงเลยตั้งแต่สร้างมา (เทียบ timestamp แบบ equality ข้าม JS Date ที่ปัดเศษ
     ไมโครวินาทีทิ้ง) แก้แล้วให้ Postgres เช็คความเก่าด้วย `now()` ของตัวเองแทน

---

## สารบัญที่เกี่ยวข้อง

- [`pr-module-known-limitations.md`](./pr-module-known-limitations.md) — จุดที่ยังค้างจริงระดับโค้ด (ก./ข.)
- [`blueprint-progress.md`](./blueprint-progress.md) — สถานะ Stripe Billing แต่ละสเตจ + Master Blueprint 74 ข้อ
