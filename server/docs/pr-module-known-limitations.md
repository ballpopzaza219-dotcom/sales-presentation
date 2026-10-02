# Known Limitations — client ledger / PR module (รวมทุกหัวข้อ)

จุดที่ยังค้างจริงเท่านั้น — **รายการที่ปิดไปแล้วถูกตัดออกจากไฟล์นี้** (หัวข้อ 1, 2 (2.1-2.3), 3.1, 4, 5,
งานหน้างาน (ตรวจรับของ/ส่งบิลค่าใช้จ่าย), และโครงสร้าง PR⇄Finance เสร็จสมบูรณ์ทั้งหมดแล้ว ดูรายละเอียด
endpoint/migration ที่ [`module-status-overview.md`](./module-status-overview.md) และประวัติที่
`git log`) เรียงตามความสำคัญ: **บล็อกการใช้งานจริง** ก่อน แล้วตามด้วย **แค่ไม่สะดวก/ทำใจได้ชั่วคราว**

อัปเดตล่าสุด: 2026-10-02 — **ก.5 ปิดแล้ว** (UPDATE ไม่ scope ด้วย company_id แพร่หลายทั่วระบบ — audit sprint
ที่เลื่อนไว้ตั้งแต่ 2026-09-12 ทำเสร็จแล้ว แก้ครบ 82 จุด/21 ตาราง หลัง grep ยืนยันพบว่าตัวเลขจริงมากกว่าที่
ประเมินไว้ตอนแรกเกือบเท่าตัว) และ **ข.15 ปิดแล้ว** (เทส 12 ไฟล์ hardcode port 3000 ชน production จริง พบ
ระหว่าง migration 0034 — แก้ root cause เปลี่ยนให้อ่าน `BOQ_TEST_BASE_URL` ครบทั้ง 12 ไฟล์แล้ว ยืนยันผ่านหมด)
ของเดิม: **ข.14** (`data-act="close-modal"` ไม่มี handler เลย พบระหว่างงาน Customer Master picker, ยังไม่แก้)
ของเดิม: 2026-09-12 — **ก.1 (`/void`) และ ก.2 (นำส่งภาษีหัก ณ ที่จ่าย) ทั้งคู่ทำเสร็จและปิดไปแล้ว**
(migration 0021/0022, commit `c572aa4`/`33bec5d`) **พบจุดบล็อกใหม่ 2 จุด: ก.3** (`client_subcontractors` PUT
ไม่ scope UPDATE ด้วย `company_id` — กระทบข้อมูลธนาคารจริง) เป็นงานถัดไปทันทีหลัง `client_customers` **และ ก.4**
(`fx_maker2` เห็นปุ่มอนุมัติเงินสดย่อยทั้งที่ไม่มีสิทธิ์ — เจอระหว่างทดสอบ `client_customers`, ยืนยันแล้วว่า
เป็นบั๊กเก่าที่มีอยู่ก่อนเซสชันนี้ ไม่เกี่ยวกับงานใดๆ ที่ทำในเซสชันนี้เลย และยืนยันเพิ่มว่าเป็นแค่ UI แสดงปุ่มผิด
เท่านั้น — backend `canApprove()` ปฏิเสธ 403 ถูกต้องเมื่อเรียกตรงผ่าน API ไม่ใช่ broken permission
enforcement จริง จึงเรียงความสำคัญ ก.3 ก่อน ก.4) — ดูหัวข้อ ข.9/ข.10 สำหรับส่วนย่อยที่ทำไปแล้วบางส่วนแต่ยังเหลือ

---

## ก. บล็อกการใช้งานจริง (ต้องแก้ก่อนใช้งานกับเงินจริงระยะยาว)

### ก.3 `client_subcontractors` PUT ไม่ scope UPDATE ด้วย `company_id` (เหมือนบั๊กที่เคยแก้ใน branches/departments)

**พบ 2026-09-12** ระหว่างอ่านโค้ด `client_subcontractors` เป็นต้นแบบตอนเขียน endpoint `client_customers`
— `app.put('/api/customer/subcontractors/:id', ...)` (migration 0009) มี
`UPDATE client_subcontractors SET ... WHERE id=$13 RETURNING *` **ไม่มี `AND company_id=$N`** ทั้งที่มี
`SELECT ... FOR UPDATE` ที่ scope ด้วย `company_id` ถูกต้องอยู่ก่อนหน้าแล้ว — เป็นช่องโหว่ defense-in-depth
ชนิดเดียวกับที่ผู้ใช้ตรวจพบและให้แก้ในโค้ด branches/departments (CLAUDE.md ข้อ 10: ทุก query ต้อง scope ด้วย
company_id เอง ไม่พึ่งพา query อื่นก่อนหน้าเป็นกลไกป้องกันทางอ้อม)

**ต่างจาก ข้อ 13 ตรงที่นี่คือโค้ด production ที่ใช้งานจริงแล้ว** (ไม่ใช่ branches/departments ที่ยังไม่
deploy) และกระทบข้อมูลที่เกี่ยวกับเงินจริงโดยตรง (ข้อมูลธนาคารผู้รับเหมาช่วง — ถ้าแก้ผิดบริษัทจริงจะโอนเงิน
งวดถัดไปผิดบัญชี) — **ตั้งเป็นงานถัดไปทันทีหลังจบ `client_customers` ตามที่สั่ง ไม่ใช่ known-limitation
ทั่วไปที่ไม่มีกำหนดแก้**

### ก.4 `fx_maker2` เห็นปุ่มอนุมัติใบเบิกเงินสดย่อยทั้งที่ไม่มีสิทธิ์ — บั๊กเก่า ไม่เกี่ยวกับงาน client_customers

**พบ 2026-09-12** ระหว่างรัน `test:regression-all` เต็มชุดหลังเสร็จงาน `client_customers` —
`test:petty-cash-vouchers-ui` พังที่ assertion `fx_maker2 (ไม่มี can_approve_petty_cash) ไม่เห็นปุ่มอนุมัติเลย`
(นับได้ 1 ปุ่ม ทั้งที่ควรเป็น 0) — **ยืนยันสาเหตุอย่างละเอียดก่อนสรุปว่าไม่เกี่ยวกับงานเซสชันนี้**:

1. ตรวจ DB ตรงๆ ว่า `fx_maker2.can_approve_petty_cash = false` จริง และไม่มีแถวใน
   `client_pr_approval_rules` ที่จะให้สิทธิ์ทางอ้อม — สถานะข้อมูลถูกต้องสมบูรณ์
2. สงสัยว่าเกิดจากบั๊กที่เพิ่งพบและแก้ไปในงานนี้เอง (function `serializeCustomer` ชนกันจนฟังก์ชันเดิมที่ใช้
   ตอน login ถูก override เงียบๆ) — แก้บั๊กนั้นแล้ว restart service แล้วเทสซ้ำ **ยังพังเหมือนเดิมทุกประการ**
   พิสูจน์ว่าไม่ใช่สาเหตุ
3. เพื่อยืนยันให้แน่ชัดที่สุด: `git stash` โค้ดทั้งหมดของงานนี้ (endpoints, เทส, package.json) กลับไปเป็น
   commit ล่าสุดก่อนเริ่ม `client_customers` เป๊ะ แล้วรัน `node server.js` แยกต่างหากบนพอร์ต 3001 (ไม่แตะ
   Windows service ตัวจริงเลย) ยืนยันด้วย `curl /api/customer/clients` ว่าได้ 404 จริง (โค้ด clean จริง ไม่มี
   ร่องรอยงานเซสชันนี้หลงเหลือ) แล้วรัน `test:petty-cash-vouchers-ui` ชี้ไปที่พอร์ตนั้นโดยตรง (ผ่าน
   `BOQ_TEST_BASE_URL`) — **พังด้วย assertion เดิมทุกตัวอักษร** สรุปได้ชัดเจนว่าเป็นบั๊กที่มีอยู่ก่อนเซสชันนี้
   เริ่มทำงานเลย ไม่เกี่ยวกับ branches/departments, migration 0023-0025, หรือ client_customers แต่อย่างใด

**ยังไม่ได้หา root cause แท้จริง** — ตรวจ logic ฝั่ง frontend คร่าวๆ แล้ว (`canApproveFlag` ใน
`pr-system.html` และ mapping ตอน login `canApprovePettyCash: !!data.customer.can_approve_petty_cash`) ดูถูก
ต้องทั้งคู่เมื่ออ่านเฉยๆ ไม่เจอจุดผิดที่ชัดเจนจากการอ่านโค้ดอย่างเดียว ต้องขุดลึกกว่านี้ (อาจเป็นเรื่อง
state/cache ฝั่ง browser ระหว่างสลับ user ในเทสเดียวกัน หรือจุดอื่นที่ยังไม่ได้ตรวจ) — **บล็อก
`npm run test:regression-all` ไม่ให้ได้ EXIT=0 เต็มชุดอยู่ตอนนี้** แม้ว่า `client_customers` เองจะผ่านครบ
(ยืนยันแยกด้วย `npm run test:client-customers` เดี่ยวๆ ผ่าน 17/17)

**ยืนยันแล้วว่าเป็นบั๊ก UI แสดงผลผิดเท่านั้น ไม่ใช่ broken permission enforcement จริง (2026-09-12)** — ทดสอบ
ตรงๆ ด้วยการเรียก backend endpoint ผ่าน API ตรง ข้ามหน้าเว็บไปเลย: สร้างใบเบิกเงินสดย่อยจริงด้วย `fx_maker`,
ยื่นขออนุมัติ, แล้วให้ `fx_maker2` เรียก `POST /api/customer/payment-vouchers/:id/approve` ตรงๆ (ไม่ผ่านปุ่ม
ใดๆ บนหน้าเว็บเลย) — ได้ผลลัพธ์ `403 {"error":"ไม่มีสิทธิ์อนุมัติเอกสารประเภทเงินสดย่อย","code":"no_permission"}`
พิสูจน์ว่า `canApprove()` ฝั่ง backend (fail-closed ตาม CLAUDE.md ข้อ 13) ทำงานถูกต้องสมบูรณ์ — ต่อให้กดปุ่มที่
โชว์ผิดจริงบนหน้าเว็บ ก็จะได้แค่ error toast กลับมา ไม่มีทางอนุมัติสำเร็จได้จริง **สรุป: ไม่ใช่ช่องโหว่การควบคุม
เงินจริง เป็นแค่ UI แสดงปุ่มผิดที่ทำให้สับสน** — ความเร่งด่วนต่ำกว่า ก.3 (ที่กระทบเงินจริงได้จริง) จึงเรียง
ลำดับ ก.3 ก่อน ก.4 ตามเดิม

### ~~ก.5~~ pattern "UPDATE ไม่ scope ด้วย company_id เอง พึ่งพา SELECT FOR UPDATE ก่อนหน้าอย่างเดียว" แพร่หลายทั่วระบบ — ✅ ปิดแล้ว (audit sprint เต็มรูปแบบ 2026-10-02)

**พบ 2026-09-12** ระหว่างแก้ ก.3 (`client_subcontractors`) — grep `UPDATE client_` ทั้งไฟล์ `server.js` แล้ว
เช็คว่าแต่ละ statement มี `company_id` ใน `WHERE`/`SET` เองหรือไม่ พบว่าเป็น**ธรรมเนียมเดิมของทั้งระบบ**
(ล็อกแถวด้วย `SELECT ... FOR UPDATE WHERE id=$1 AND company_id=$2` ก่อนเสมอ แล้วค่อย `UPDATE ... WHERE
id=$X` ตัวเดียวโดยไม่ scope ซ้ำ) — เลื่อนไว้เป็น audit sprint แยกต่างหากตามที่ตกลง ไม่ได้แก้รวมกับ ก.3 ตอนนั้น

**แก้จริงแล้ว 2026-10-02** (ระหว่างงาน Customer Master migration 0034) — **grep ยืนยันรายการใหม่ทั้งหมดก่อน
ลงมือแก้ตามที่สั่ง พบว่าตัวเลขจริงต่างจากที่บันทึกไว้ครั้งแรกมาก: 82 statement ข้าม 21 ตาราง** (ไม่ใช่ ~36
จุด/13 ตารางตามที่ประเมินไว้ตอนแรก) สาเหตุหลัก: การตรวจครั้งแรกสุ่มมาแค่ 1 บรรทัดตัวแทนต่อ 1 action ต่อ
ตาราง (เช่น submit/approve) ไม่ได้ไล่ reject/cancel/void ที่เป็น pattern เดียวกันทุกประการ และพบตารางใหม่ที่
ไม่เคยอยู่ในรายการเดิมเลย 7 ตาราง: `client_labor_costs`, `client_pr_approval_rules`, `client_budgets`,
`client_budget_items`, `client_progress_claim_items`, `client_purchase_request_items`,
`client_wht_certificates` (จุดเชื่อม remittance_id)

**ข้อควรระวังเดิมเรื่อง JOIN ไม่ตรงกับสภาพจริง** — ตรวจ schema จริงทุกตารางที่เกี่ยวข้องแล้วพบว่า **ทุกตาราง
รวมถึงตารางระดับ item ที่เคยเตือนไว้ว่า "อาจไม่มี company_id เอง" (`client_progress_claim_items`,
`client_budget_items`, `client_purchase_request_items`) มีคอลัมน์ `company_id` ของตัวเองครบทุกตารางจริง** —
แก้ด้วยการเติม `AND company_id=$N` ตรงๆ ได้ทั้งหมด ไม่ต้องใช้ JOIN เลยแม้แต่จุดเดียว

**ผลการแก้**: เติม `company_id` เข้า WHERE ของ UPDATE ครบทั้ง 82 จุด (ยืนยันด้วยสคริปต์ตรวจอัตโนมัติซ้ำหลังแก้
เสร็จว่าเหลือ 0 จุด) รัน `node --check` ผ่าน แล้ว apply/verify ผ่าน `npm run test:regression-all` เต็มชุด 2
รอบ (ก่อน commit และหลัง commit) ได้ 932 checks/34 ไฟล์ EXIT=0 ทั้งสองรอบ ไม่มี regression — รายชื่อตาราง
สุดท้ายที่แก้ครบ: `client_progress_claims` (8), `client_progress_claim_items` (1), `client_revenue` (4),
`client_budget_items` (2), `client_labor_costs` (1), `client_project_tasks` (4), `client_tenders` (1 — จุด
`/status` ที่ตกหล่นจาก PUT หลักที่แก้ไปแล้วตอน migration 0025), `client_budget_revisions` (5),
`client_budgets` (1), `client_purchase_orders` (5), `client_purchase_request_items` (7),
`client_pr_approval_rules` (3), `client_purchase_requests` (5), `client_subcontract_terms` (7),
`client_subcontract_billings` (6), `client_site_expense_submissions` (2), `client_external_payees` (1),
`client_payment_vouchers` (6), `client_wht_certificates` (1), `client_advance_clearances` (7),
`client_petty_cash_replenishments` (5)

**บทเรียนสำคัญ**: เมื่อกลับมาทำ audit sprint ที่เลื่อนไว้นานแล้ว ต้อง grep ยืนยันรายการใหม่เสมอก่อนลงมือ
ไม่ใช่เชื่อตัวเลข/รายการที่บันทึกไว้ครั้งแรกตรงๆ — schema และโค้ดอาจเปลี่ยนไปมากระหว่างที่งานถูกเลื่อนไว้
(ในกรณีนี้คือเพิ่มตารางใหม่ 7 ตาราง และขอบเขตที่ประเมินไว้ครั้งแรกไม่ครบถ้วนตั้งแต่ต้น ไม่ใช่เพราะมีอะไร
เปลี่ยนแปลงระหว่างทาง)

### ก.6 `new Date().toISOString().slice(0,10)` (UTC ตรงๆ ไม่ผ่าน Asia/Bangkok) กระจายอยู่ทั่วระบบ — เตรียมไว้สำหรับ audit แยกต่างหาก ยังไม่แก้ตอนนี้

**พบ 2026-09-13** ระหว่างแก้ ข.11 (platform document numbering) — grep pattern เดียวกันทั้งไฟล์ `server.js`
แล้วไล่ตรวจทีละจุดว่าเป็นค่าที่ใช้แสดงผล/บันทึกให้คนเห็น (ควรเป็น `getBangkokDateStr()` ตาม CLAUDE.md ข้อ 12)
หรือเป็นแค่ log ภายในที่ locale ไม่มีผล (ปลอดภัยเป็น UTC ต่อไปได้) — **แยกไว้ชัดเจนแล้วเพื่อไม่ต้องไล่วิเคราะห์
ใหม่ทั้งหมดตอน audit จริง**:

**ถูกต้องอยู่แล้ว (UTC ตั้งใจ ไม่ต้องแก้)** — 1 จุด:
- บรรทัด 62 (`getRequestLogStream()`) — คอมเมนต์ในโค้ดระบุไว้ตรงๆ แล้วว่าเป็น machine log ไม่ใช่ค่าที่คนเห็น

**น่าจะเป็นบั๊กจริง (ควรเป็น Bangkok)** — 25 จุด แบ่งตามกลุ่ม:

| กลุ่ม | บรรทัด (ประมาณ) | บริบท |
|---|---|---|
| ระบบ PR เดิม (legacy `prs` table, ก่อน client_ledger) | 466, 534 | default วันที่ยื่นคำขอ, วันที่อนุมัติ (foreman_date/manager_date) |
| HR | 2213 | default `start_date` ตอนรับพนักงานเข้าเป็นทางการ |
| Platform: ใบแจ้งหนี้/ใบเสนอราคา (admin) | 3428, 3506, 3545, 3705, 3747, 3796 | issue_date, วันที่รับชำระ (2 จุด), issue_date ตอนแก้/แปลงจากใบเสนอราคา |
| Platform: ค่าใช้จ่ายของแพลตฟอร์มเอง (admin) | 3910, 3960, 3999 | expense_date ตอนสร้าง/แก้, entryDate ตอนจ่ายชำระเจ้าหนี้ |
| Platform: รายงาน (admin) | 4081, 4125 | default ช่วงวันที่ report (P&L, VAT) — `from` ใช้ `new Date().getFullYear()` บั๊กเดียวกันด้วย |
| Client ledger: ต้นทุนโครงการ/ค่าใช้จ่าย/รายรับ | 4316, 4384, 4520, 4580, 4641, 4747 | costDate, expenseDate, revenueDate, วันที่คืนเงินประกัน, วันที่รับชำระ, วันที่เอกสารแนบ — **ทุกจุดนี้ป้อนเข้า journal entry จริง (CLAUDE.md ข้อ 12 ระบุชัดว่าใช้กับ "วันนี้" แบบเต็มวันที่ ไม่ใช่แค่ปี พ.ศ.)** |
| Client ledger: ใบสั่งซื้อ (PO) | 8466, 8520 | issue_date ตอนสร้าง/แก้ — บรรทัด 8520 (UPDATE) ยังไม่ scope ด้วย company_id ด้วย ซ้ำกับ ก.5 (นับเป็นจุดเดียวกัน ไม่แยกนับซ้ำ) |
| Client ledger: ใบเสนอราคา/เอกสารทั่วไป | 14894, 14994 | issue_date ตอนสร้างใบเสนอราคา (จุดที่เพิ่งแก้เรื่อง customerId ในงานก่อนหน้า — บั๊กนี้มีอยู่ก่อนแล้ว ไม่ได้เกิดจากการแก้ครั้งนั้น), doc_date ของเอกสารทั่วไป |
| Client ledger: รายงาน | 15146, 15166, 15188 | default ช่วงวันที่ report (trial balance, income statement, balance sheet) — `from` ที่ 15166 ใช้ `new Date().getFullYear()` บั๊กเดียวกันด้วย |

**ไม่ทำรวมกับ ข.11 ตอนนี้ตามที่ตกลง** — ขอบเขตใหญ่กว่ามาก (2 ฝั่งระบบ ผสมทั้ง default วันที่ในฟอร์มและวันที่
ที่ป้อนเข้า journal entry จริง) ควรเป็น audit sprint แยกต่างหาก เหมือน ก.5

### ~~ก.1 เอกสารที่อนุมัติแล้วไม่มี `/void`~~ — ✅ ทำเสร็จแล้ว (2026-09-07, migration 0021)

`POST .../:id/void` มีครบทั้ง 4 โมดูล (`payment-vouchers`, `advance-clearances`, `subcontract-billings`,
`progress-claims`) — สร้าง reversing journal entry (debit/credit สลับจากเดิม ไม่ลบของเดิม), ยกเลิก 50 ทวิที่
ผูกอยู่ (`replaces_cert_id` รองรับออกใบใหม่แทนที่), ลบไฟล์แนบที่ผูกกับเอกสารนั้นจริง (ดู ข.8 ด้านล่าง — เฉพาะ
2 ตารางนี้เท่านั้น), บังคับเหตุผล, กันยกเลิกเอกสารข้ามเดือนปฏิทินปัจจุบัน, กันยกเลิกโดยผู้ที่มีส่วนในเอกสาร
เอง (created_by/submitted_by/approved_by/certified_by) แม้เป็น super_user ก็ตาม เทสถาวร:
`void-reversing-entry.regression.js` (77 checks รวม forced-failure atomicity test จริง)

**ส่วนที่ตั้งใจยังไม่ทำในรอบนี้** (ไม่ใช่บั๊ก เป็นการตัดสินใจตั้งแต่ต้น): เอกสารที่มีบรรทัดใด
`has_tax_invoice=true` (มีใบกำกับภาษีเต็มรูป) **ยังบล็อกไม่ให้ `/void` เด็ดขาด** เพราะการยกเลิกใบกำกับภาษีที่
ออกไปแล้วตามกฎสรรพากรต้องใช้ **ใบลดหนี้ (credit note)** ไม่ใช่แค่ reverse journal entry เฉยๆ — ยังไม่มีเคส
ใบกำกับภาษีจริงที่ต้องยกเลิกเกิดขึ้นในระบบเลย จึงยังไม่ได้ออกแบบ credit-note document type ล่วงหน้า
**เมื่อไหร่ต้องกลับมาทำ**: ทันทีที่มีการยกเลิกใบแจ้งหนี้ที่มี VAT เกิดขึ้นจริงในระบบ

### ~~ก.2 การนำส่งภาษีหัก ณ ที่จ่าย ไม่มีกระบวนการปิดยอด~~ — ✅ ทำเสร็จแล้ว (2026-09-07, migration 0022)

ระบบนำส่งภาษีหัก ณ ที่จ่ายแบบชุด (`client_wht_remittances`) — `POST /api/customer/wht-remittances` ล็อกใบ
50 ทวิที่ยัง pending ของ (wht_form, งวด) ที่ระบุ, บันทึกเลขที่ใบเสร็จ+วันที่ชำระ, โพสต์ journal entry เดียว
`Dr 2120 / Cr เงินสด` ล้างยอดจริง (ยืนยันแล้วว่า 2120 net เป็น 0 พอดีหลังนำส่งครบ), export Excel รายชื่อ
50 ทวิของงวด (ทั้งก่อน/หลังนำส่ง), กันนำส่งซ้ำงวดเดิม (409), `GET /wht-payable-summary` เดิมยังใช้ดูยอดค้าง
ระหว่างรอนำส่งได้เหมือนเดิม เทสถาวร: `wht-remittances.regression.js` (30 checks รวมเทสดาวน์โหลดไฟล์จริงได้
ชื่อไทยถูกต้อง)

**ยังไม่ทำในรอบนี้** (ตามที่ตกลงไว้แต่แรก): ไฟล์นำส่งรูปแบบ RD Prep (text file ตามสเปกกรมสรรพากร) — ยังไม่มี
สเปกในมือ ใช้ Excel ทั่วไปแทนไปก่อน — ระบบแจ้งเตือนอัตโนมัติ (email/LINE) เมื่อใกล้ครบกำหนด 7/15 — ยังไม่มี
infra ส่งแจ้งเตือนออกนอกระบบเลย มีแค่ `daysUntilOnlineDeadline` ให้ UI แสดงเตือนบนหน้าจอเท่านั้น

---

## ข. แค่ไม่สะดวก (ทำใจใช้งานได้ชั่วคราว ไม่บล็อก)

### ข.1 หัวข้อ 3.2 — Project Complete (อสังหาริมทรัพย์) — ยังไม่มีนิยาม requirement

**สถานะ**: ไม่มีตาราง/endpoint/ร่องรอยอื่นใดในระบบเลย — เจ้าของโปรเจกต์ยืนยันแล้วว่ายังไม่มีรายละเอียดพอจะ
อธิบาย ต้องไปถามคนที่กำหนด requirement มาก่อนถึงจะเริ่มออกแบบได้ (2026-08-25)

**คำถามที่ต้องถามก่อนเริ่มออกแบบ**:
1. **รับรู้รายได้ตอนไหน** — ตอนโอนกรรมสิทธิ์ (โอนบ้าน/คอนโดที่ห้องกรม), ตอนผ่อนดาวน์ครบ, หรือทยอยรับรู้ตาม
   งวดที่ผ่อน (คนละหลักการบัญชีกันโดยสิ้นเชิง มีผลต่อผังบัญชีที่ต้องออกแบบ)
2. **ต่างจากการปิดโครงการรับเหมาทั่วไป (หัวข้อ 3.1) ยังไง** — 3.1 คือเรียกเก็บเงินจากเจ้าของโครงการตามงวด
   งานที่ทำเสร็จ (เราเป็นผู้รับเหมา) ส่วน "Project Complete (อสังหาริมทรัพย์)" ฟังดูเหมือนเราเป็นเจ้าของ/
   ผู้พัฒนาโครงการเองแล้วขายให้ลูกค้ารายย่อย — ทิศทางธุรกิจต่างกันโดยพื้นฐาน ต้องยืนยันว่าใช่หรือไม่
3. **มีเอกสาร/ขั้นตอนอนุมัติอะไรบ้าง** — มีสัญญาจะซื้อจะขาย, ใบเสร็จรับเงินดาวน์แต่ละงวด, ใบโอนกรรมสิทธิ์
   แยกกันเป็นเอกสารคนละใบไหม หรือรวมเป็น flow เดียว ใครเป็นคนอนุมัติแต่ละขั้นตอน
4. **ผูกกับ BOQ/งบประมาณโครงการแบบเดียวกับหัวข้อ 3.1 หรือไม่** — หรือเป็นคนละโมเดลข้อมูลไปเลย (เช่น ผูกกับ
   "ยูนิต/ห้อง" แทน "งวดงาน")
5. **ภาษีที่เกี่ยวข้อง** — ภาษีธุรกิจเฉพาะ/อากรแสตมป์ตอนโอนกรรมสิทธิ์ต้องรวมอยู่ใน flow นี้ด้วยหรือไม่

### ข.2 `client_purchase_request_item_adjustments` ไม่มี `uncancel`

`cancel-qty` เป็นการตัดสินใจถาวรโดยตั้งใจ ต่างจาก consume/release ที่มี release ย้อนกลับได้ — ถ้าต้องการ
uncancel ในอนาคตต้องเพิ่ม `adjustment_type='uncancel'` ผ่าน migration ใหม่ ยังไม่ได้ทำและไม่ได้วางแผนไว้

### ข.3 ใบเบิกจ่ายเจ้าหนี้ภายนอก (1.4) รองรับแค่ 1 บรรทัดค่าใช้จ่ายต่อใบ

ต่างจาก 1.3 (เคลียร์เงินทดรองจ่าย) ที่มีตาราง `client_advance_clearance_items` แยกรองรับหลายรายการต่อใบ —
`client_payment_vouchers` (voucher_type='other') ผูกกับบัญชีค่าใช้จ่าย/VAT/WHT เดียวต่อ 1 voucher เท่านั้น
ถ้าใบแจ้งหนี้จริงมีหลายรายการ (เช่น ค่าบริการ + ค่าวัสดุ คนละบัญชี) ต้องแยกสร้างหลาย voucher เอาเอง — ยัง
ไม่บล็อกเพราะ workaround (แยกใบ) ทำได้จริง แค่ไม่สะดวก

### ข.4 `payee_tax_id`/`payee_name` ของพนักงาน ไม่เชื่อมกับ master data พนักงานอัตโนมัติ

เงินทดรองจ่าย/เคลียร์เงินทดรองจ่ายอ้างถึง "พนักงาน" ผ่าน `customers` (ผู้ใช้งานในระบบ) ซึ่งไม่มีคอลัมน์เลข
ผู้เสียภาษีส่วนบุคคลอยู่แล้ว ต่างจาก `client_external_payees`/`client_subcontractors` ที่บังคับดึง
`tax_id`/`name` จาก master เสมอ — กรณีพนักงานยังไม่มี master data ที่เทียบเท่าให้ผูก จึงยังไม่ได้บังคับ
ลักษณะเดียวกัน ผลกระทบจำกัดเพราะเงินทดรองจ่ายพนักงานมักไม่ใช่กรณีที่ต้องออก 50 ทวิให้ตัวพนักงานเอง (WHT ใน
เคลียร์เงินทดรองจ่ายคือหักจาก "ผู้รับเงินปลายทาง" ที่พนักงานสำรองจ่ายให้ ไม่ใช่หักจากตัวพนักงาน)

### ข.5 npm audit — 7 รายการ (5 moderate, 2 high) — ยอมรับความเสี่ยงแล้วทั้งหมด ไม่ได้เกิดจาก stripe

**อัปเดต 2026-09-22**: จำนวนเพิ่มจาก 2 เป็น 7 หลังติดตั้ง `stripe` (เริ่ม Stripe Billing integration) — ตรวจ
แล้วด้วย `npm ls stripe qs uuid` ว่า **`stripe` เองไม่ได้พา dependency ที่มีช่องโหว่เข้ามาเลยสักตัว** (เป็น leaf
package ไม่มี sub-dependency ที่ชนกับรายการด้านล่าง) — 7 รายการทั้งหมดเป็น CVE ที่เพิ่งถูกประกาศใหม่ใน
dependency เดิมที่มีอยู่ก่อนแล้ว (`npm audit` แค่ refresh ฐานข้อมูลตอนรัน `npm install`):

- `multer` (2 high) — DoS หลายช่องทาง (crafted multipart field names, file descriptor leak, fileFilter
  race, oversized array index) — ใช้จริงสำหรับ upload ไฟล์แนบ/สลิป/ใบเสร็จ มีเวอร์ชันแก้แล้วแต่ major
  ใหม่กว่า (ต้องประเมิน breaking change ก่อน bump)
- `nodemailer` (moderate) — หลายจุดเกี่ยวกับ domain allow-list bypass / ReDoS — ใช้จริงสำหรับส่งอีเมล
- `qs` (moderate, มาจาก `express`/`body-parser`) — array-limit bypass, DoS
- `uuid` (moderate, มาจาก `exceljs@4.4.0` — เหตุผล exploitability ต่ำเดิม): CVE (GHSA-w5hq-g745-h8pq) คือ
  "missing buffer bounds check เมื่อส่ง `buf` param" เท่านั้น — โค้ดจริงของ `exceljs` เรียก `uuidv4()` แบบ
  ไม่ส่ง `buf` เลยสักจุด (ใช้แค่สร้าง unique id สำหรับ conditional-formatting rule) → code path ที่จะโดน
  ช่องโหว่นี้ไม่เคยถูกเรียกใช้จริงในระบบเรา — `exceljs@4.4.0` เป็นเวอร์ชันล่าสุดที่มีจริงบน npm ตอนนี้ที่ยัง pin
  `uuid@^8.3.0` อยู่ ทางแก้เดียวที่ `npm audit fix --force` เสนอคือ downgrade `exceljs` กลับไป 3.4.0
  (major ย้อนหลัง) ซึ่งเสี่ยงเกินไป ไม่ทำ

**ต้องทำต่อไป**: ประเมิน `multer`/`nodemailer` version ใหม่ที่แก้ CVE แล้วว่ามี breaking change กระทบโค้ด
จริงแค่ไหน (ยังไม่ได้ประเมิน ณ วันที่บันทึก) และเช็ค release ใหม่ของ `exceljs` เป็นระยะว่าอัปเดต `uuid` เป็น
`^11.x` แล้วหรือยัง

### ข.6 `client_external_payees` บังคับ "นิติบุคคลต้องมีเลขผู้เสียภาษี" แค่ชั้น application เท่านั้น — ไม่เหมือน `client_subcontractors`

**ความไม่สอดคล้อง**: `client_subcontractors` มี DB-level `CHECK (taxpayer_type<>'juristic' OR tax_id IS
NOT NULL)` บังคับกฎนี้ที่ชั้นฐานข้อมูลด้วย (กันได้แม้มีทางเข้าอื่นที่ไม่ผ่าน `validateSubcontractorInput()`)
แต่ `client_external_payees` (สร้างก่อนกฎนี้จะถูกกำหนดขึ้นนานมาก) มีแค่ `CHECK (tax_id IS NULL OR
char_length(tax_id)=13)` เท่านั้น ไม่มี CHECK บังคับ "juristic ต้องมี tax_id" เลย — กฎนี้ถูกเพิ่มเข้ามาที่
`validateExternalPayeeInput()` (server.js) เป็น**ชั้น application อย่างเดียว**

**ผลกระทบจริง**: เส้นทางปกติผ่าน `POST/PUT /api/customer/external-payees` ถูกกันครบเหมือนกันทั้งสองตาราง
แต่ถ้ามีการเขียนแถวลง `client_external_payees` ตรงๆ ผ่านช่องทางอื่นที่ไม่ผ่าน endpoint นี้ (เช่น
script/migration data-fix ในอนาคต) จะไม่มี DB ช่วยกันให้ — ความเสี่ยงต่ำเพราะไม่มีช่องทางเขียนอื่นในโค้ด
ปัจจุบันเลยนอกจาก endpoint นี้ แต่ถ้าจะเพิ่มความเข้มงวดให้เท่ากันในอนาคต ต้องทำ migration ใหม่เพิ่ม CHECK
แบบเดียวกัน (ต้อง backfill/ตรวจแถวเก่าที่ละเมิดกฎก่อน ถ้ามี) — ยังไม่ได้วางแผนไว้ ไม่บล็อกการใช้งานปัจจุบัน

### ข.7 คอลัมน์ DATE (ไม่ใช่ TIMESTAMPTZ) ที่ SELECT ผ่าน `.*` โดยไม่ใส่ `to_char()` จะแสดงผิดวันไปหนึ่งวันบนเครื่องนี้

**สาเหตุ**: `pg` แปลงคอลัมน์ `DATE` เป็น JS `Date` object โดยตีความเป็น "เที่ยงคืนตาม local timezone ของ
เครื่องที่รัน Node" (ไม่ใช่ UTC) — เครื่อง server เครื่องนี้ local timezone เป็น Asia/Bangkok (UTC+7) พอ
`res.json()` เรียก `JSON.stringify()` จะแปลง Date object กลับเป็น UTC ISO string ซึ่งเลื่อนถอยหลังไป 7
ชั่วโมง เพียงพอให้ข้ามวันไปเป็น "17:00 ของวันก่อนหน้า" เสมอ

**แก้แล้ว**: ทุกจุดที่เจอจริงจนถึงตอนนี้ (`client_advance_clearances`, `client_wht_certificates`,
`client_tenders`) cast ด้วย `to_char(col,'YYYY-MM-DD') AS col` ครบแล้ว — ดู CLAUDE.md ข้อ 22 สำหรับ
รายละเอียดเต็มและ pattern การแก้

**ยังไม่ได้ตรวจทั้งระบบ**: grep `SELECT \*`/`SELECT alias.*` แบบไม่มี `to_char` ทั่วทั้ง `server.js` เจอ
มากกว่า 30 จุด (users/employees/leave/job_applications/foreign_worker_documents ฯลฯ) — ส่วนใหญ่ไม่เคยถูก
ตรวจว่ามีคอลัมน์ `DATE` ที่ได้รับผลกระทบจริงหรือไม่ (บางตารางอาจมีแต่ `TIMESTAMPTZ` ซึ่งไม่มีปัญหานี้) อยู่
นอกขอบเขตงาน client ledger/PR — ถ้าจะแก้ทั่วระบบต้องไล่ตรวจทีละตารางว่ามีคอลัมน์ `DATE` จริงหรือไม่ก่อน ยัง
ไม่ได้ทำ

### ข.8 ไฟล์แนบ (รูปใบส่งของ/บิล) ไม่เคยถูกลบทิ้งจาก endpoint ไหนเลย — 🟡 แก้บางส่วนแล้ว (2 จาก 4 ตาราง)

**อัปเดต 2026-09-07**: `client_payment_voucher_attachments`/`client_advance_clearance_attachments` (ไฟล์
แนบใบกำกับภาษี) **ลบไฟล์จริงแล้ว** ทั้งตอน `/void` และ `/cancel` (draft) — ลบแถว DB คู่กับ `fs.unlink()` บน
ดิสก์เสมอ และยืนยันแล้วด้วย forced-mid-transaction-failure test จริงว่าลำดับถูกต้อง: `fs.unlink()` เกิด
**หลัง** commit ทรานแซกชันสำเร็จเท่านั้น (เช็คจาก `res.statusCode` เป็น 2xx หลัง `withIdempotency`/`COMMIT`
resolve แล้วเท่านั้น) ถ้าทรานแซกชันพังกลางทาง ไฟล์ยังอยู่ครบ ไม่มีการ unlink เกิดขึ้นเลย — เทสถาวร:
`attachments-void-cancel.regression.js` (17 checks)

**ปัญหาที่ยังเหลืออยู่**: `client_goods_receipt_attachments`/`client_site_expense_attachments` (migration
0017/0018 — ไฟล์แนบตรวจรับของ/ส่งบิลหน้างาน คนละตารางกับข้างบน) **ยังไม่มี `DELETE` statement อ้างถึงเลย
สักจุด** ใน `server.js` — ไฟล์บนดิสก์ (`server/uploads/goods-receipt-attachments/`, `server/uploads/
site-expense-attachments/`) จะค้างอยู่ตลอดไป (goods receipt ไม่มี endpoint ยกเลิก/ลบเลยด้วยซ้ำ — ตรวจรับ
ของแล้วคือบันทึกถาวร)

**ผลกระทบจริง**: ตรวจสอบแล้ว (2026-08-27) พื้นที่ใช้จริงในโฟลเดอร์ `uploads/` ทั้งหมดของระบบตอนนี้อยู่ที่
~500KB เท่านั้น และดิสก์ C: ของเครื่องนี้มีที่ว่างจริง ~184GB — **ไม่ใช่ปัญหาเร่งด่วนในสภาพปัจจุบัน** แต่ถ้า
ใช้งานจริงต่อเนื่องเป็นปีโดยไม่มีระบบล้างข้อมูลเก่า ไฟล์จะสะสมไปเรื่อยๆ ไม่มีวันลดตามธรรมชาติของฟีเจอร์นี้

**เมื่อไหร่ต้องกลับมาทำจริง** (2 เงื่อนไข อย่างใดอย่างหนึ่งเกิดก็ต้องทำ):
1. เมื่อมีระบบ void/cancel ของเอกสารที่มีไฟล์แนบผูกอยู่ (goods receipt / site expense submission) —
   ตอนออกแบบ endpoint นั้น ใช้ pattern เดียวกับที่ทำไปแล้วกับ payment-voucher/advance-clearance ข้างบนได้
   เลย (DELETE แถว DB คืน storage_path ก่อน แล้ว unlink หลัง commit เท่านั้น)
2. เมื่อโฟลเดอร์ `server/uploads/` รวมทั้งหมดมีขนาดเกิน **X GB** (ยังไม่ได้กำหนดเลข X ที่ชัดเจน — เสนอ
   ผูกกับเกณฑ์เตือนพื้นที่ดิสก์ใน `health-check.ps1` เช่น ถ้า `uploads/` กินพื้นที่เกิน 50% ของเกณฑ์เตือน
   20GB คือ 10GB ให้เริ่มพิจารณาทำ cleanup job ได้แล้ว)

### ข.9 `project_id` ไม่ครบทุกเส้นทางสำหรับต้นทุน/รายรับต่อโครงการ (ตรวจสอบแล้ว 2026-08-27)

ตรวจสอบทั้งระบบตามที่ฝ่ายบัญชีขอ — ส่วนใหญ่มี `project_id` ที่ header เอกสารแล้วให้ item ย่อยอ้างอิงผ่าน
parent ปกติดี พบ 3 จุดที่เป็นช่องโหว่จริง:

**✅ แก้แล้ว (2026-09-08) — จุดที่ 2 เป็นบั๊กจริง ไม่ใช่ฟีเจอร์ที่ยังไม่ทำ**: `client_journal_entries` มี
คอลัมน์ `project_id` ใช้งานจริงอยู่แล้วส่วนใหญ่ แต่ **3 จุด insert ไม่เคยส่งค่านี้เลย** (เคลียร์เงินทดรองจ่าย
ตอนอนุมัติ, ตอนชำระส่วนต่าง, เติมเงินกองทุนเงินสดย่อย) ทำให้ journal ที่เกิดจาก 3 จุดนี้มี `project_id`
เป็น NULL เสมอแม้เอกสารต้นทางจะผูกโครงการไว้จริง — แก้โดย query หา `project_id` จากต้นทาง (voucher/
กองทุน) แล้วส่งเข้า `createClientJournalEntry` ทั้ง 3 จุด เทสถาวร:
`journal-project-id-linkage.regression.js` (7 checks รวมเคส "กองทุนไม่ผูกโครงการ → NULL แบบตั้งใจ"
พิสูจน์ว่าไม่ใช่ hardcode)

**ยังไม่แก้ (รอ requirement เพิ่มเติม เป็นฟีเจอร์ใหม่ ไม่ใช่บั๊ก)**:
1. `client_advance_clearances`/`client_advance_clearance_items` **ไม่มี `project_id` เลยแม้แต่ทางอ้อม**
   (ต้อง join ผ่าน `advance_voucher_id → client_payment_vouchers.project_id` เท่านั้น) — ยืนยันแล้วว่า
   **ไม่เพิ่มคอลัมน์** (ตัดสินใจ 2026-09-08): join อ้อมทำได้อยู่แล้ว เพิ่มคอลัมน์ซ้ำเสี่ยงข้อมูลสองที่ไม่ตรง
   กันมากกว่า — เดียวกันกับ `client_subcontract_billings`/`client_petty_cash_replenishments` (join ผ่าน
   สัญญา/กองทุนต้นทางได้เช่นกัน) พิจารณาใหม่เฉพาะถ้ารายงานช้าเพราะ join เยอะจริงในอนาคต
2. งบทดลอง/งบกำไรขาดทุน/งบดุล (`/reports/trial-balance` ฯลฯ) **ไม่มีพารามิเตอร์ filter ตามโครงการเลย** —
   เป็นแบบทั้งบริษัทเท่านั้น ต้นทุนต่อโครงการปัจจุบันคำนวณแยกทางอื่น (`checkBudgetControl()`) ที่ไม่ผ่าน
   journal — **ยืนยันแล้วว่าพร้อมทำ** (ไม่ต้อง migration ใหม่ เพิ่ม parameter `projectId` กรอง
   `WHERE project_id=$X` ได้เลย งานไม่ใหญ่) รอฝ่ายบัญชียืนยันว่าต้องการก่อนเริ่ม

### ข.10 D: เป็น FAT32 ไม่รองรับ ACL — ต้องทบทวนก่อนนำระบบขึ้นใช้งานจริงกับข้อมูลลูกค้า

### ข.11 `generateInvoiceNumber`/`generateQuotationNumber` (Platform/admin-panel, ไม่ใช่ client ledger) — timezone + reuse-after-delete บั๊กเดียวกับที่เพิ่งแก้ไปใน migration 0023

**พบระหว่างแก้ document numbering ของฝั่ง client (migration 0023)** — 2 ฟังก์ชันนี้อยู่คนละส่วนกับ
`company_document_counters` เลย (เป็นเลขที่ SiteReq เองออกใบแจ้งหนี้/ใบเสนอราคาให้ **ลูกค้าเช่าระบบ**
ผ่าน `admin-panel.html`, ตาราง `invoices`/`quotations` ระดับ platform ไม่ใช่ตาราง `client_*` ของ tenant
ใดๆ เลย) แต่มีบั๊กแบบเดียวกันเป๊ะ 2 อย่าง:
1. คำนวณปีจาก `new Date().getFullYear()` (เวลาเครื่อง server) ไม่ใช่ `getBangkokYear()` — ยังไม่มีอาการ
   ตอนนี้เพราะเครื่องนี้ตั้ง timezone เป็น Asia/Bangkok อยู่แล้ว แต่จะออกเลขปีผิดทันทีช่วง 00:00-07:00
   น. เวลาไทยถ้าย้ายขึ้น production host ที่ตั้ง UTC (เหมือนที่พบใน document numbering ฝั่ง client)
2. นับเลขแบบ `COUNT(*) FROM invoices/quotations` — เลขซ้ำได้จริงถ้ามีการลบแถว (บั๊กเดียวกับที่ `tender`/
   `client_projects`/`client_quotations` เคยเป็นมาก่อนแก้)

**ผลกระทบจริง**: จำกัดอยู่แค่บัญชี/ใบแจ้งหนี้ของ SiteReq เอง (ฝั่งขาย subscription ให้ลูกค้า) ไม่กระทบข้อมูล
ธุรกิจของบริษัทผู้เช่าระบบรายใดเลย — ความเสี่ยงต่ำกว่าฝั่ง client เพราะ (1) เป็นการออกใบแจ้งหนี้ภายในของ
SiteReq เอง ปริมาณยังน้อย (2) ยังไม่ได้ deploy ขึ้น production host จริงที่ตั้ง UTC — แต่ยังควรแก้ก่อนขึ้น
production เพื่อไม่ให้เอกสารบัญชีของ SiteReq เองมีปัญหาเดียวกัน

**ยังไม่ได้แก้** — วิธีแก้เหมือนกับที่ทำไปแล้วกับ `client_projects`/`client_quotations` เป๊ะ (เปลี่ยนมาใช้
counter table แยกของ platform เอง เช่น `platform_document_counters`, แก้ให้ใช้ `getBangkokYear()`) แต่
เป็นคนละ migration/คนละ scope กับ 0023 (แก้ไว้เฉพาะ `company_document_counters` ของฝั่ง tenant เท่านั้น)

### ข.12 down.sql ของ migration 0023 ส่วน guard เรื่อง >1 ปี ยังไม่เคยถูกทดสอบแบบ trigger จริงในเทสถาวร

ยืนยันด้วยมือครั้งเดียวระหว่างพัฒนา (เซ็ตแถวข้อมูล 2 ปีปลอมแล้วรัน `migrate.js down` ยืนยันว่า
`RAISE EXCEPTION` ทำงานถูกจริง) แต่ `document-numbering-year-key.regression.js` ข้อ (1) ทดสอบแค่ฝั่ง
forward (สร้าง counter ปีใหม่แยกจากปีเก่าถูกต้อง) เท่านั้น ไม่เคยเรียก `down.sql` เพื่อ trigger guard นี้เลย
— ควรเพิ่ม unit test เฉพาะจุดนี้เมื่อมีโอกาส (เซ็ตแถว 2 ปีปลอมแล้วรัน down.sql จริง ยืนยัน exception + ยืนยัน
ว่าไม่มีอะไรถูกลบไปจริง)

### ข.13 down.sql migration 0024 ส่วน guard "แยกข้อมูล backfill กับข้อมูลที่ผู้ใช้สร้างเอง" เป็น heuristic ไม่ใช่การตรวจสมบูรณ์แบบ

Guard ที่กัน rollback ทำลายข้อมูลจริงของ `client_departments` เช็คจาก `code NOT LIKE 'DEPT-%'` (แยกโค้ดที่
backfill อัตโนมัติสร้างตอน `up.sql` ออกจากโค้ดที่ผู้ใช้กรอกเอง) — ยืนยันด้วยการรันจริงแล้วว่า guard ทำงานถูก
ต้องตามที่ออกแบบไว้ (2026-09-11) **แต่เป็น heuristic**: ถ้า endpoint ที่จะสร้างขึ้นในอนาคต (backend
controller ของ branches/departments) บังเอิญ generate โค้ดขึ้นต้นด้วย `DEPT-` เอง แถวนั้นจะหลุดผ่าน guard
ไปได้โดยไม่ตั้งใจ — ควรออกแบบ endpoint จริงให้ผู้ใช้กำหนดโค้ดเองเสมอ (ไม่ auto-generate ด้วย pattern เดียวกับ
migration) เพื่อไม่ให้ชนกับ heuristic นี้ หรือถ้าจำเป็นต้อง auto-generate ในอนาคตจริงๆ ให้ใช้ prefix อื่นที่
ไม่ใช่ `DEPT-` เพื่อไม่ให้ปนกับข้อมูลจาก migration ก็ได้ — บันทึกไว้เป็น known-limitation ไม่ใช่บั๊ก เพราะ
ยอมรับความเสี่ยงนี้แล้วตอนออกแบบ (สถานการณ์ปกติที่จะ trigger migration นี้ rollback คือทันทีหลัง apply ก่อน
มีข้อมูลจริงเกิดขึ้นเลย ซึ่ง heuristic นี้ครอบคลุมถูกต้อง 100%)

### ข.14 `data-act="close-modal"` ไม่มี handler ใน `handleAction()` เลยสักจุด — ปุ่มยกเลิก/คลิกนอก modal ของ `S.modal` ทุกตัวไม่ทำงาน

**พบ 2026-10-01** ระหว่างสำรวจ `pr-system.html` สำหรับงาน Customer Master picker — ตอนแรกตั้งใจจะเปิด
quick-add modal ผ่าน `S.modal` (กลไกกลางของ modal ทั่วไปในระบบ) แต่สังเกตว่าไม่มีจุดไหนใน `handleAction()`
ที่เช็ค `act==='close-modal'` เลย จึงไล่ grep `data-act="close-modal"` ทั้งไฟล์เพื่อยืนยัน — **ทุกจุดที่เจอเป็น
แค่ attribute `data-act="close-modal"` บน `<div class="modal-overlay">`/ปุ่ม "ยกเลิก" เท่านั้น ไม่มีจุดไหนเลยที่
`handleAction(act, el)` มี branch รับค่านี้แล้วสั่ง `S.modal=null; render();`** — ยืนยันซ้ำด้วย Playwright จริง
(เปิด modal แล้วคลิกปุ่ม/พื้นที่นอก modal ที่มี `data-act="close-modal"` — modal ไม่ปิด)

**ผลกระทบจริง**: กระทบ**ทุก modal ที่ใช้กลไก `S.modal` กลาง** ทั่วทั้งแอป (เช่น add-user, add-project (demo),
add-stock, reject-admin-req, ledger-add ฯลฯ) — ปุ่ม "ยกเลิก"/คลิกพื้นที่นอก modal ที่ตั้งใจให้ปิดโดยไม่บันทึก
ใช้งานไม่ได้จริง ผู้ใช้ต้องกดปุ่ม action อื่นที่ตั้ง `S.modal=null` เอง (เช่นปุ่มบันทึกสำเร็จ) หรือ refresh หน้า
เพื่อออกจาก modal แทน — **ไม่กระทบความถูกต้องของข้อมูล** (ไม่มี modal ไหนบันทึกอะไรเองตอนปิด) เป็นแค่ UX ที่
ผู้ใช้ค้างอยู่ใน modal นานกว่าที่ตั้งใจ

**ทางเลี่ยงที่ใช้ในงาน Customer Master picker**: quick-add modal ของ picker (`S.customerQuickAddForm`,
`renderCustomerQuickAddForm()`) **จงใจไม่ใช้ `S.modal`/`close-modal` เลย** — ใช้ state object แยกของตัวเองกับ
action เฉพาะ `cancel-customer-quick-add` แทน (มี handler จริงใน `handleAction()`) ตาม pattern เดียวกับ
`S.addRuleForm`/`cancel-add-rule` ที่ยืนยันแล้วว่าทำงานถูกต้อง — เป็นทางเลี่ยงเฉพาะจุดของ feature ใหม่
เท่านั้น ไม่ได้แก้บั๊กนี้ที่ต้นตอ

**ยังไม่แก้ตามที่ตกลงไว้** (นอก scope งาน Customer Master/Bidding permission) — วิธีแก้ที่ตรงไปตรงมาที่สุด
คือเพิ่ม `if(act==='close-modal'){ S.modal=null; render(); return; }` เข้า `handleAction()` จุดเดียว (กลไก
กลาง แก้จุดเดียวได้ผลทุก modal ที่ใช้ `S.modal` ทันที ไม่ต้องไล่แก้ทีละหน้า) — ยังไม่ได้ทำเพราะต้องตรวจสอบ
ก่อนว่า modal บางตัวที่ตั้งใจ "ปิดแล้วเสียข้อมูลฟอร์มที่กรอกค้างไว้" (เช่น `ledger-add` ที่มีฟอร์มยาว) มีผล
ข้างเคียงอะไรที่ต้องระวังเพิ่มหรือไม่ก่อนเปิดใช้งานกลไกปิดแบบทั่วไปจริง

### ~~ข.15~~ เทส Playwright 12 ไฟล์ hardcode `BASE = 'http://localhost:3000'` ตรงๆ ไม่อ่าน `BOQ_TEST_BASE_URL` — แอบรันชน production service แทน sandbox โดยไม่มีใครรู้ตัว — ✅ แก้ root cause แล้ว (2026-10-02)

**พบ 2026-10-01** ระหว่างตรวจ regression suite รอบ migration 0034 (DROP `client_name`/`project_owner`) —
ตั้งใจรัน server ทดสอบแยกบนพอร์ตอื่น (เช่น 3913) แล้วชี้ด้วย `BOQ_TEST_BASE_URL` เพื่อไม่แตะ production
service จริง (`SiteReqServer`, NSSM, port 3000) ตามมาตรฐานทั้งเซสชัน — แต่ `test:petty-cash-vouchers-ui`
พังด้วย 500 error ที่ไม่เคยมีมาก่อน สืบจนพบว่าไฟล์นี้ `const BASE = 'http://localhost:3000';`
**hardcode ตรงๆ ไม่มี `process.env.BOQ_TEST_BASE_URL ||` เหมือนไฟล์ส่วนใหญ่เลย** — grep ทั้ง `tests/`
พบอีก 11 ไฟล์ที่เป็นแบบเดียวกัน (hardcode + ไม่มี fallback จาก env var):

```
advance-clearance-settle-ui, advance-clearance-ui, advance-vouchers-ui, dual-module-nav,
external-payment-ui, petty-cash-vouchers-ui, po-ui, pr-ui, progress-claims-ui, site-work-ui,
subcontract-billings-ui, wo-ui
```

**ผลกระทบจริงที่เกิดขึ้นแล้ว**: ทั้ง 12 ไฟล์นี้วิ่งชน **production service ตัวจริงบน port 3000 มาตลอด**
ทุกครั้งที่รัน ไม่ว่าจะตั้งใจชี้ `BOQ_TEST_BASE_URL` ไปที่ sandbox หรือไม่ก็ตาม — คืนวันที่พบ migration
0034 เพิ่งถูก apply เข้า DB จริง (DROP คอลัมน์) ขณะที่ production service ยังรันโค้ด server.js เก่า
(ก่อนแก้วันนี้) ค้างอยู่ในหน่วยความจำ (ไม่ได้ restart มาพร้อมกับตอน apply migration) ทำให้โค้ดเก่าที่ยัง
`SELECT`/`INSERT` คอลัมน์ที่เพิ่งถูก DROP พังทันทีด้วย 500 จริง — ยืนยันตรงๆ ด้วย `GET
/api/customer/projects` บน port 3000 ได้ 500 ก่อน restart, ได้ 200 หลัง restart service — แก้ด้วย
`Restart-Service -Name SiteReqServer -Force` ผ่าน `Start-Process -Verb RunAs` (ต้อง elevate ตามที่เคย
บันทึกไว้) **Claude Code เองไม่มีความสามารถคลิกอนุมัติหน้าต่าง UAC ได้ — เจ้าของระบบเป็นผู้กดอนุมัติ UAC
prompt เองที่หน้าเครื่องจริง** (ยืนยันแล้วในแชท) — **production service ใช้งาน Project/Tender/Quotation
ไม่ได้เลยช่วงสั้นๆ ระหว่างนั้นจริง** (ไม่มีลูกค้าจริงใช้งานอยู่ตอนนี้ ยังอยู่ช่วงพัฒนา แต่ถ้าเกิดเหตุการณ์
เดียวกันหลัง launch จริงจะกระทบผู้ใช้จริง)

**บทเรียนสำคัญ**: การรันเทสชี้ sandbox ด้วย `BOQ_TEST_BASE_URL` **ไม่ได้แปลว่าปลอดภัยจาก production
จริง 100%** ถ้ามีไฟล์ไหนลืมรองรับ env var นี้ไว้ — ต้องตรวจสอบว่าทุกไฟล์ใน `tests/*.js` ที่ประกาศ `BASE`
ใช้ pattern `process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000'` ให้ครบจริงก่อนเชื่อว่าการแยก
sandbox ได้ผลครบทุกไฟล์

**แก้แล้ว (2026-10-02)** — เปลี่ยนทั้ง 12 ไฟล์เป็น `const BASE = process.env.BOQ_TEST_BASE_URL ||
'http://localhost:3000';` ตาม pattern เดียวกับไฟล์อื่นในชุดเทสทั้งหมด ยืนยันแล้วว่าทุกไฟล์ยังรันผ่านปกติ
เมื่อชี้ไปที่ sandbox จริง (รันทีละไฟล์ยืนยันครบทั้ง 12 ไฟล์ แล้วรัน `npm run test:regression-all` เต็มชุด
อีกครั้ง — 932 checks/34 ไฟล์ ผ่านหมด) และยืนยันด้วย grep ว่าไม่มีไฟล์ไหนใน `tests/*.js` เหลือ hardcode
`localhost:3000` แบบไม่มี fallback จาก env var อีกเลย — `test:petty-cash-vouchers-ui` ที่เคยมี 500 error
แปลกๆ ตอนรันกับ sandbox (เพราะแอบชน production ที่ยังรันโค้ดเก่าอยู่ ดูรายละเอียดด้านบน) ตอนนี้กลับมา
ผ่าน 27/27 สะอาดเหมือนก่อนเกิดเหตุการณ์นี้เป๊ะ ยืนยันว่า root cause คือจุดนี้จริง

---

## ตารางสรุปด่วน

| ID | เรื่อง | ระดับ |
|---|---|---|
| ~~ก.1~~ | ~~ไม่มี `/void`~~ — ✅ เสร็จแล้ว (2026-09-07) ยกเว้นเอกสารมี VAT ที่ยังบล็อกโดยตั้งใจ (รอใบลดหนี้) | ปิดแล้ว |
| ~~ก.2~~ | ~~ไม่มีกระบวนการนำส่ง ภ.ง.ด.~~ — ✅ เสร็จแล้ว (2026-09-07) | ปิดแล้ว |
| **ก.3** | **`client_subcontractors` PUT ไม่ scope UPDATE ด้วย `company_id`** (พบ 2026-09-12, โค้ด production กระทบข้อมูลธนาคารจริง) | **เปิดอยู่ — งานถัดไปทันทีหลัง client_customers** |
| **ก.4** | **`fx_maker2` เห็นปุ่มอนุมัติเงินสดย่อยทั้งที่ไม่มีสิทธิ์** (พบ 2026-09-12, บั๊กเก่าไม่เกี่ยวกับ client_customers/branches/departments — ยืนยันแล้วว่าเป็นแค่ UI แสดงผลผิด ไม่ใช่ broken permission enforcement, ยังไม่พบ root cause) | **เปิดอยู่ — ไม่กระทบเงินจริง แต่บล็อก test:regression-all ไม่ให้ EXIT=0 เต็มชุด** |
| ~~ก.5~~ | ~~UPDATE ไม่ scope ด้วย company_id เอง (พึ่งพา SELECT FOR UPDATE อย่างเดียว) แพร่หลายทั่วระบบ~~ — ✅ แก้ครบแล้ว (2026-10-02, 82 จุด/21 ตาราง — ตัวเลขจริงมากกว่าที่ประเมินไว้ตอนแรกมาก หลัง grep ยืนยันซ้ำ) | ปิดแล้ว |
| **ก.6** | **`new Date().toISOString()` (UTC) แทน `getBangkokDateStr()` กระจายทั่วระบบ** — พบ 2026-09-13 ระหว่างแก้ ข.11, ไล่แยกแล้ว 25 จุดน่าจะเป็นบั๊กจริง / 1 จุดถูกต้องอยู่แล้ว (ดูตารางเต็มด้านบน) | **เปิดอยู่ — เตรียมไว้สำหรับ audit sprint แยกต่างหาก ไม่ได้แก้ในงานนี้** |
| ข.1 | หัวข้อ 3.2 Project Complete (อสังหาริมทรัพย์) — รอนิยาม requirement | รอ requirement |
| ข.2 | PR item adjustment ไม่มี uncancel (ตั้งใจ) | ไม่สะดวก |
| ข.3 | payment voucher (other) รองรับ 1 บรรทัด/ใบ | ไม่สะดวก |
| ข.4 | payee_tax_id พนักงานไม่ผูก master data | ไม่สะดวก |
| ข.5 | npm audit เหลือ 7 (5 moderate: qs/uuid, 2 high: multer/nodemailer) — ยืนยันแล้วว่า stripe ไม่ใช่สาเหตุ | หนี้เทคนิค (ยอมรับแล้ว, multer/nodemailer ยังไม่ได้ประเมิน breaking change) |
| ข.6 | external_payees บังคับ juristic+tax_id แค่ชั้น app (subcontractors มี DB CHECK ด้วย) | ไม่สะดวก (ยอมรับแล้ว) |
| ข.7 | คอลัมน์ DATE ที่ไม่ cast to_char แสดงผิดวันไปหนึ่งวัน (แก้แล้วทุกจุดที่เจอ, เหลือ 30+ จุดนอกขอบเขตยังไม่ตรวจ) | บางส่วนแก้แล้ว |
| ข.8 | ไฟล์แนบตรวจรับของ/ส่งบิลหน้างาน ไม่เคยถูกลบทิ้ง (payment voucher/advance clearance แก้แล้ว, เหลือ goods receipt/site expense) | บางส่วนแก้แล้ว |
| ข.9 | `project_id`: 3 journal insert แก้แล้ว ✅ / advance clearance ไม่เพิ่มคอลัมน์ (ตัดสินใจแล้ว) / รายงาน filter โครงการ รอฝ่ายบัญชียืนยัน | บางส่วนแก้แล้ว |
| ข.10 | D: เป็น FAT32 ไม่รองรับ ACL — ต้องทบทวนก่อนนำระบบขึ้นใช้งานจริงกับข้อมูลลูกค้า | ไม่บล็อก (ช่วงพัฒนา ไม่มีข้อมูลลูกค้าจริง) |
| ข.11 | generateInvoiceNumber/generateQuotationNumber (platform, ไม่ใช่ tenant) เจอบั๊ก timezone+reuse-after-delete เดียวกับที่เพิ่งแก้ในฝั่ง client — ยังไม่แก้ | ไม่บล็อก (กระทบแค่บัญชี SiteReq เอง ยังไม่ deploy UTC host) |
| ข.12 | down.sql migration 0023 ส่วน guard >1 ปี ยืนยันด้วยมือแล้ว แต่ยังไม่มี automated test — ควรเพิ่มเมื่อมีโอกาส | ไม่บล็อก (SQL logic ตรวจแล้วถูกต้อง ความเสี่ยงต่ำ) |
| ข.13 | down.sql migration 0024 guard แยกข้อมูล backfill เป็น heuristic (`code NOT LIKE 'DEPT-%'`) ยืนยันด้วยมือแล้วว่าถูกต้อง | ไม่บล็อก (ครอบคลุมสถานการณ์จริงถูก 100% ตอนนี้) |
| ข.14 | `data-act="close-modal"` ไม่มี handler เลย — ปุ่มยกเลิก/คลิกนอก modal ของ `S.modal` ทุกตัวไม่ปิด (พบ 2026-10-01 ระหว่างงาน Customer Master picker) | ไม่บล็อก (ไม่กระทบความถูกต้องข้อมูล แค่ UX ค้างใน modal) |
| ~~ข.15~~ | ~~เทส 12 ไฟล์ hardcode `BASE=localhost:3000` ไม่อ่าน `BOQ_TEST_BASE_URL`~~ — ✅ แก้ root cause แล้ว (2026-10-02, เปลี่ยนทั้ง 12 ไฟล์เป็น pattern เดียวกับไฟล์อื่น ยืนยันผ่านหมดทีละไฟล์ + full suite) | ปิดแล้ว |
