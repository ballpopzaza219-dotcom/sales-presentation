# คำสั่งสำหรับ Claude Code ในโปรเจกต์นี้

## ภาษาที่ใช้ตอบกลับ

**ตอบกลับผู้ใช้เป็นภาษาไทยเสมอ** ทั้งคำอธิบาย คำถาม หัวข้อ และตัวเลือกใน AskUserQuestion —
ห้ามใช้ภาษาญี่ปุ่นหรือภาษาอังกฤษเป็นภาษาหลักในการอธิบาย ไม่ว่าการสนทนาจะยาวแค่ไหนหรือมีเนื้อหา
ทางเทคนิค/ภาษาอังกฤษปนอยู่มากแค่ไหนก็ตาม

ข้อยกเว้น: ศัพท์เทคนิค ชื่อตาราง ชื่อฟังก์ชัน ชื่อตัวแปร โค้ด และ error message ที่ยกมาจากระบบจริง
ให้คงเป็นภาษาอังกฤษตามเดิม — คอมเมนต์ในโค้ดเขียนเป็นภาษาไทยได้

กฎนี้ต้องถูกปฏิบัติตามอย่างเคร่งครัดตลอดทั้งการสนทนา ไม่ใช่แค่ตอนเริ่มต้น

## เมื่อไหร่ต้องถามผู้ใช้ก่อน เมื่อไหร่ตัดสินใจเองได้

- **คำถาม yes/no ที่เป็นเรื่องเทคนิค/รูปแบบโค้ดล้วนๆ**: ตัดสินใจเอง ไม่ต้องถาม — เลือกทางที่ปลอดภัยกว่า
  และตรงกับกฎใน CLAUDE.md ฉบับนี้มากที่สุด แล้ว**รายงานในสรุปผลว่าตัดสินใจอะไรไป เพราะอะไร** (ให้ผู้ใช้
  เห็นเหตุผลย้อนหลังได้ ไม่ใช่แค่ทำเงียบๆ)
- **4 กลุ่มนี้ต้องถามก่อนเสมอ ไม่มีข้อยกเว้น** แม้จะดูเหมือนเป็นเรื่องเทคนิคก็ตาม:
  1. Apply migration ลง DB จริง
  2. ลบ/แก้ไขข้อมูลที่มีอยู่แล้ว หรือ DROP ตาราง/คอลัมน์
  3. เรื่องผังบัญชี อัตราภาษี หรือวิธีลงบัญชี (Dr/Cr, รหัสบัญชีใหม่, การตีความรายการทางบัญชี)
  4. เรื่องสิทธิ์การอนุมัติและการแบ่งแยกหน้าที่ (แยก doc_type ใหม่ไหม, ใครอนุมัติอะไรได้)
- **คำถามที่ไม่ใช่ yes/no** (ต้องเลือกจากหลายทาง หรือต้องใช้ข้อมูลทางธุรกิจที่เดาไม่ได้): **ห้ามหยุดงานรอ**
  — รวบรวมไว้ท้ายรายงานเป็นรายการเดียว ให้ผู้ใช้ตอบรวดเดียวทีหลัง แล้วทำงานส่วนอื่นที่ไม่ติดคำถามนั้น
  ต่อไปก่อนระหว่างรอ
- **กำกวมว่าอยู่ในกลุ่มยกเว้น (4 กลุ่มข้างบน) หรือไม่**: ให้ถือว่าอยู่ในกลุ่มยกเว้นไว้ก่อนเสมอ แล้วถาม
  (fail-safe ไปทางถาม ไม่ใช่ทางเดาเอง)

## กฎการจัดการ process/service บนเครื่อง Windows

**ห้ามแนะนำหรือรัน `Stop-Process`/`taskkill` แบบกรองด้วยชื่อ (`-Name node`, `-Name java` ฯลฯ) เด็ดขาด
ไม่ว่าจะดูปลอดภัยแค่ไหนก็ตาม** — ต้อง filter ด้วย **Path เต็มของ exe** หรือระบุ **PID เจาะจง** เท่านั้น
(เช่น `Get-Process -Id <pid> | Stop-Process` หรือเช็ค `.Path` ก่อนกรองด้วยชื่อไฟล์ทุกครั้ง) เหตุผล:
ชื่อ process อย่าง `node` ใช้ร่วมกันได้กับซอฟต์แวร์อื่นที่ไม่เกี่ยวข้องเลย (พบจริง: `node.exe` ของ Adobe
Creative Cloud Experience รันอยู่คู่กับ `node.exe` ของโปรเจกต์นี้บนเครื่องเดียวกัน — แนะนำ `Stop-Process
-Name node -Force` แบบเหมาชื่อไปครั้งหนึ่ง ทำให้ process ของ Adobe ถูกฆ่าไปด้วยโดยไม่ตั้งใจ ทั้งที่ไม่ได้
เกี่ยวอะไรกับโปรเจกต์เลย) — ก่อนฆ่า process ใดๆ ต้อง `Select-Object Id, Path` (หรือ `Path`/
`MainModule.FileName`) ยืนยันเสมอว่าเป็นตัวที่ตั้งใจจริง ไม่ใช่เดาจากชื่อเฉยๆ

## กฎการเขียน backend สำหรับโมดูล client ledger / PR (server/server.js, server/migrations/)

กฎเหล่านี้สรุปจากรอบตรวจของผู้ใช้ตลอดโมดูล "ใบขอซื้อ" (ข้อ 4) และ "เงินสดย่อย" (ข้อ 1.1) — ใช้กับ
ทุกโมดูลถัดไปในกลุ่ม client ledger (subcontractor, progress claim, PO/WO ฯลฯ) ตั้งแต่รอบแรก ไม่ต้อง
รอให้ผู้ใช้แจ้งซ้ำ:

1. **Composite FK ทุกจุด**: ทุกคอลัมน์ที่อ้างอิงตารางอื่นแบบ client ส่งค่ามาเอง (ไม่ใช่แค่
   "ใครทำ" อย่าง `created_by`/`uploaded_by`) ต้องเป็น composite FK `(company_id, xxx_id)
   REFERENCES other_table(company_id, id)` ไม่ใช่ single-column — ต้องมี `UNIQUE(company_id, id)`
   บนตารางแม่รองรับด้วยเสมอ
2. **หน่วยตัวเลข**: เงิน = `NUMERIC(18,2)`, จำนวน/ปริมาณ = `NUMERIC(18,4)`, อัตราร้อยละ =
   `NUMERIC(5,2)`
3. **ห้ามเทียบ/คำนวณเงินและจำนวนด้วย JS Number** — pg คืนคอลัมน์ NUMERIC เป็น string เสมอ ต้อง
   เทียบในฝั่ง SQL ด้วย `::numeric` แล้วคืนผลเป็น boolean กลับมา (เช่น `(qty_remaining >=
   $N::numeric) AS has_enough`) ใช้ `Number()` ได้เฉพาะตอน format ข้อความแสดงผลเท่านั้น ห้ามใช้
   ตัดสินใจ — ค่าเงิน/จำนวนที่รับจาก client (body) ต้องรับได้ทั้ง JS number และ numeric string แล้ว
   ส่งค่าดั้งเดิมเข้า SQL เป็น `$N::numeric` ตรงๆ เสมอ ห้ามแปลงผ่าน `Number()` ก่อนส่งเข้า query หรือ
   ก่อน INSERT/UPDATE ลงคอลัมน์ NUMERIC (18 หลักนัยสำคัญเกินขอบเขต JS number ที่แม่นยำจริงแค่
   ~15-16 หลัก) — มี helper กลาง `parsePositiveNumericValue(raw)` ให้ใช้ร่วมกันแล้ว (คืนค่าดั้งเดิม
   หรือ null)
4. **ยอดสรุปบน header คำนวณจาก items ฝั่ง server เสมอ** (เช่น `total_amount` จาก
   `SUM(estimated_amount)`) ห้ามเชื่อค่าที่ client ส่งมาตรงๆ
5. **UPDATE ยอดสะสมต้องเป็นแบบสัมพัทธ์เท่านั้น** เช่น `qty_ordered = qty_ordered + $1` ห้ามอ่านค่า
   มาคำนวณในโค้ดแอปแล้วเขียนค่าสัมบูรณ์กลับ (กัน lost-update ตอน concurrent request)
6. **`SELECT ... FOR UPDATE` ของแถวที่ค่าจะถูกใช้ตัดสินใจ ต้องเป็นคำสั่งแรกสุดของ handler** ก่อน
   อ่านค่าอะไรก็ตามที่จะใช้เทียบ/คำนวณ — ไม่พึ่งพาลำดับการล็อกแถวอื่นเป็นกลไกป้องกัน race ทางอ้อม
   **ลำดับการล็อกเมื่อมีมากกว่า 1 แถว ต้องคงที่เหมือนกันทุก endpoint ของเอกสารประเภทเดียวกันเสมอ:
   ล็อกแถวเอกสารหลัก/header ก่อนเสมอ (เช่น `client_purchase_requests`) แล้วค่อยล็อกแถวลูก/รายการ
   (เช่น `client_purchase_request_items`)** ห้ามมี endpoint ไหนล็อกกลับลำดับ (item ก่อน header) แม้จะ
   มีเหตุผลด้าน race-condition เฉพาะจุดก็ตาม เพราะสองทรานแซกชันที่ล็อกสองแถวเดียวกันคนละลำดับกันจะเกิด
   deadlock ได้จริงแม้แต่ละฝั่งจะทำงานกับสถานะเอกสารคนละสถานะที่ "ไม่มีทางชนกันจริง" ก็ตาม — Postgres
   ตัดสินจากลำดับการขอล็อกเท่านั้น ไม่รู้เรื่อง business logic ว่าจะชนกันจริงหรือไม่ (พบจริงจากการรีวิว
   endpoint items consume/release/cancel-qty ของ PR ที่ล็อก item ก่อน สวนทางกับ PUT ที่ล็อก PR ก่อน)
7. **ห้ามรวม `SELECT ... FOR UPDATE` ของแถวหนึ่งกับการคำนวณ aggregate/subquery ที่อ่านตารางอื่นไว้ใน
   SQL statement เดียวกัน ถ้าผลจากการคำนวณนั้นจะถูกใช้ตัดสินใจ (เช่น เช็คยอดคงเหลือ)** — ต้องแยกเป็น
   2 statement เสมอ: (1) `SELECT id FROM table WHERE id=$1 FOR UPDATE` (ล็อกเฉยๆ) แล้ว (2) query
   คำนวณ/เทียบค่าแยกต่างหาก (ไม่ต้อง FOR UPDATE ซ้ำ เพราะถือ lock จากขั้นตอนแรกอยู่แล้ว) เหตุผล: ใน
   READ COMMITTED แต่ละ statement ได้ snapshot ของตัวเองตอนเริ่ม statement — ถ้าอีกทรานแซกชันหนึ่ง
   กำลังถือ lock อยู่ทำให้ statement นี้ต้องรอคิว แถวที่ถูกล็อกเองจะได้เวอร์ชันล่าสุดหลังตื่นจากรอก็จริง
   แต่ correlated subquery ที่อ่าน "ตารางอื่น" ในผลลัพธ์ SELECT เดียวกันนั้นจะไม่ถูก re-evaluate ให้
   อัตโนมัติ ยังคงค่าจาก snapshot ก่อนรอคิว ทำให้สองทรานแซกชันที่แข่งกันเห็นยอดรวมชุดเดิมทั้งคู่แล้วผ่าน
   ทั้งคู่ได้ทั้งที่รวมกันเกินจริง (พบจริงจากการรีวิวจุดเช็คยอดคงเหลือกองทุนเงินสดย่อยตอนอนุมัติใบเบิก)
8. **Endpoint ที่เคลื่อนเงินหรือยอดต้องผ่าน `withIdempotency`** และ endpoint string ต้องมี id ของ
   เอกสาร (และ id ของ sub-resource ถ้ามี เช่น itemId) ฝังอยู่ในตัว string เสมอ (เช่น
   `` `purchase-requests-item-consume:${id}:${itemId}` ``) ห้ามใช้ endpoint string เดียวข้าม
   เอกสารคนละใบ
9. **ทุกการเปลี่ยนสถานะเอกสารต้องเรียก `writeAuditLog`** ในทรานแซกชันเดียวกับที่เปลี่ยนสถานะจริง
10. **ทุก route ต้อง scope ด้วย `company_id` จาก session (`req.customer.company_id`) เท่านั้น**
    ข้ามบริษัทต้องคืน 404 (ไม่ใช่ 403 — ไม่บอกว่าเอกสารมีอยู่จริงแต่เป็นของบริษัทอื่น)
11. **ออกเลขที่เอกสาร (running number) ตอน submit เท่านั้น ไม่ใช่ตอนสร้าง draft** ใช้ atomic
    counter (`nextDocumentSeq` + `company_document_counters`) ห้ามใช้ `COUNT(*)`-based pattern
12. **ปี พ.ศ. ต้องคำนวณจาก timezone Asia/Bangkok เสมอ** (`Intl.DateTimeFormat({timeZone:
    'Asia/Bangkok'})`) ไม่ใช่ timezone ของเครื่อง server — ใช้กับ "วันนี้" แบบเต็มวันที่ด้วย ไม่ใช่
    แค่ปี พ.ศ. (มี `getBangkokDateStr()` ให้ใช้ร่วมกันแล้ว)
13. **Validation ที่ fail ต้อง throw ไม่ใช่ปล่อยผ่านแบบ fail-open** โดยเฉพาะฟังก์ชันด่านสิทธิ์กลาง
    (เช่น `canApprove`) — พารามิเตอร์ที่ขาด/ผิดชนิด/กำกวมต้อง throw ด้วยชื่อฟิลด์ที่ชัดเจน ไม่ใช่
    default ไปทาง "อนุญาต"
14. **สิทธิ์จัดการ "ตั้งค่า/เพดาน" ของทรัพยากร ต้องแยกจากสิทธิ์ "อนุมัติธุรกรรมที่ใช้ทรัพยากรนั้น"
    เสมอ** — ห้ามใช้ flag เดียวกันทำทั้งสองอย่าง (เช่น คนอนุมัติใบเบิกเงินสดย่อยได้ ไม่ควรตั้ง
    fund_limit ของกองทุนได้ด้วย ไม่งั้นจะขึ้นวงเงินเองแล้วอนุมัติตัวเองได้ไม่จำกัด ทำให้เพดานอนุมัติ
    ไร้ผล) ถ้ายังไม่มี flag แยกจริง ให้จำกัดเป็น `super_user` เท่านั้นไปก่อน พร้อมคอมเมนต์ชื่อ flag ที่
    ควรสร้างในอนาคต
15. **Schema ใหม่ทุกจุดต้องเป็นไฟล์ migration แยก** (`server/migrations/000N_*.up.sql` /
    `.down.sql`) มีลำดับเวอร์ชันชัดเจน + rollback ทดสอบจริงด้วย up→down→up→down ก่อนเสมอ **ห้าม
    apply เข้า DB จริงก่อนได้รับอนุมัติจากผู้ใช้อย่างชัดเจน**
16. **การโหลด config เชื่อมต่อ DB ห้ามพึ่ง `cwd` เด็ดขาด** — `server/db.js` และสคริปต์ใดๆ ที่เชื่อมต่อ
    DB ตรง (scripts/, tests/ ที่ไม่ได้ผ่าน HTTP) ต้องโหลด `.env` ด้วย path สัมบูรณ์อิง `__dirname`
    เสมอ (`require('dotenv').config({ path: require('path').join(__dirname, '.env') })`) ห้ามเรียก
    `require('dotenv').config()` เฉยๆ โดยไม่ระบุ `path` — dotenv default resolve จาก
    `process.cwd()` (ตำแหน่งที่สั่งรัน `node`) ไม่ใช่ตำแหน่งไฟล์ที่เรียก ถ้าสคริปต์ถูกรันจากคนละโฟลเดอร์
    กับที่ `.env` อยู่จริง (เช่น รันจาก root แทนที่จะ `cd server` ก่อน) จะหา `.env` ไม่เจอเงียบๆ แล้ว
    ตกไปใช้ค่า default ที่ผิด — **ชื่อ database ห้ามมีค่า default แบบเงียบๆ ใน `db.js` เด็ดขาด**
    (`process.env.PGDATABASE` ต้อง throw ทันทีถ้าไม่ได้ตั้งค่า ไม่ใช่ fallback ไปต่อกับ database อื่น)
    เพราะ "ต่อ database ผิดชื่อ" อันตรายกว่า "ต่อ host/port ผิด" มาก — ค่า default ของ host/port/user
    ยังเป็นค่าที่สมเหตุสมผลสำหรับ local dev ได้ตามปกติ พบจริงจากการดีบัก: สคริปต์ที่ต่อ DB ผ่าน
    `require('./db')` ทำงานได้บ้างไม่ได้บ้างขึ้นอยู่กับว่ารันจากโฟลเดอร์ไหน โดยที่ error ที่เห็น
    (`SASL: client password must be a string`) ไม่ได้บอกใบ้เรื่อง cwd/`.env` เลยแม้แต่น้อย ทำให้ดีบัก
    ยากมากถ้าไม่รู้ pattern นี้มาก่อน
17. **ตาราง master ที่มีคอลัมน์ "อัตรา/ค่าเริ่มต้น" ซึ่งบางแถวไม่มีอัตราคงที่จริง (เช่น
    `client_wht_income_types.default_rate` — 40(1) เงินเดือนคำนวณตามอัตราก้าวหน้า ไม่ใช่ %
    คงที่) ต้องปล่อยเป็น `NULL` ไม่ใช่ `0`** — `0` สื่อความหมายผิดว่า "ไม่ต้องหักภาษี" ทั้งที่ความจริง
    คือ "คำนวณอัตโนมัติจากอัตราคงที่ไม่ได้ ต้องกรอกเอง" (fail-open ที่มองไม่เห็นว่าเป็น fail-open)
    เหตุผลเดียวกับที่ `parsePositiveNumericValue` คืน `null` ให้ caller ปฏิเสธเองแทนที่จะ default เงียบๆ
    (ดูข้อ 3) — **โค้ดฝั่ง server.js ทุกจุดที่ดึงค่าจากคอลัมน์แบบนี้ไปใช้คำนวณ/ตั้งค่าเริ่มต้นให้ฟอร์ม
    ต้อง throw หรือปฏิเสธเป็น 400 ทันทีถ้าเจอ `NULL` ห้าม fallback เป็น `0` เด็ดขาด** เพราะ 0 กับ
    "ไม่รู้อัตรา" มีความหมายต่างกันโดยสิ้นเชิงในบริบทภาษี ปนกันแล้วจะออกเอกสาร/หักภาษีผิดโดยไม่มีใครรู้ตัว
18. **รันไฟล์ .sql ด้วย `psql` บน Windows ต้องใส่ `-c "SET client_encoding TO 'UTF8';"` ก่อน `-f`
    เสมอ** — ไฟล์ migration/dump มีคอมเมนต์และข้อมูลภาษาไทยเป็น UTF-8 แต่ `psql` บน Windows ใช้
    client_encoding ตาม codepage ของ console เป็นค่าเริ่มต้น (เครื่อง locale ไทยมักเป็น WIN874) ไม่ตรง
    กับ encoding จริงของไฟล์ ทำให้พังกลางทางด้วย error `character with byte sequence 0x9a in
    encoding "WIN874" has no equivalent in encoding "UTF8"` (พบจริงจากการ import PGSQL.sql) — คำสั่ง
    ที่ถูกต้อง: `psql ... -c "SET client_encoding TO 'UTF8';" -f migration.sql` (`psql` รัน `-c`/`-f`
    ตามลำดับที่ระบุในคำสั่งเดียวกัน ทำให้ set encoding ก่อนอ่านไฟล์ได้จริง)
19. **รัน migration `.up.sql` ด้วย `psql` ตรงๆ (ไม่ผ่าน `server/migrations/migrate.js`) ต้อง
    `INSERT INTO schema_migrations (version) VALUES (...)` เองเพิ่มเติมเสมอ โดยใช้ `-1`
    (`--single-transaction`) ควบคู่กับ `-f` และ `-c` (INSERT) ในคำสั่งเดียวกัน** — การ INSERT บันทึก
    version ที่ apply แล้วอยู่ใน `migrate.js` เท่านั้น (`client.query('INSERT INTO schema_migrations
    ...')` หลังรัน SQL ในทรานแซกชันเดียวกัน) ไม่ได้อยู่ในไฟล์ `.up.sql` เอง ถ้ารันผ่าน `psql -f` ตรงๆ
    โดยไม่ INSERT เพิ่ม จะทำให้ `schema_migrations` ไม่อัปเดต แล้ว `migrate.js up` รอบถัดไปพยายามรัน
    migration ซ้ำแล้วพัง (ตาราง/constraint ที่มีอยู่แล้วชนกัน) — ใส่ `-1` กำกับด้วยเสมอเพื่อให้ SQL ของ
    migration กับการ INSERT อยู่ใน transaction เดียวกัน (ถ้า migration พังกลางทาง ทั้งก้อน rollback
    รวม INSERT ด้วย ไม่ทิ้ง state ครึ่งๆ กลางๆ ไว้ — เทียบเท่าพฤติกรรมจริงของ `migrate.js`)
20. **รัน migration ด้วย `psql -U postgres` (แทน `migrate.js` ที่รันผ่าน connection ของแอปเอง) ต้องตรวจ
    ownership ของ object ใหม่ทุกตัวที่ migration นั้นสร้างทันทีหลังรันเสร็จ แล้ว `ALTER ... OWNER TO`
    (role ที่แอปใช้เชื่อมต่อจริง เช่น `sitereq_app`) ให้ครบทุกตัวที่หลุด** — เช็คด้วย
    `SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' AND tableowner <>
    'sitereq_app';` (และ query เดียวกันกับ `pg_sequences`/`pg_views`/`pg_proc` ด้วย ไม่ใช่แค่ตาราง)
    เหตุผล: `CREATE TABLE`/`CREATE SEQUENCE`/ฯลฯ ที่รันผ่าน `psql -U postgres` จะได้ owner เป็น
    `postgres` เสมอ (ไม่ใช่ role ที่ระบุใน `-U` ของคำสั่งอื่นในสคริปต์ แต่เป็น role ที่ authenticate อยู่
    ตอนนั้นจริงๆ) แอปเชื่อมต่อจริงด้วย `sitereq_app` (ไม่ใช่ superuser) และไม่มีสิทธิ์ query object ที่
    owner เป็นคนอื่นเลยถ้าไม่มี GRANT ชัดเจน — statement ที่เป็น `ALTER TABLE`/`ALTER ... ADD COLUMN` บน
    object ที่มี owner ถูกต้องอยู่แล้ว (สร้างมาจาก `migrate.js` เดิม) ไม่กระทบ owner จึงไม่มีปัญหา มีแค่
    `CREATE TABLE`/`CREATE SEQUENCE` ใหม่ๆ ในไฟล์เดียวกันเท่านั้นที่เสี่ยงหลุด — พบจริงจากการรีวิว:
    `client_wht_income_types` (สร้างใน migration 0003 ที่รันผ่าน `psql -U postgres` เพราะตอนนั้นเครื่อง
    ยังไม่มี Node.js) เป็น table เดียวในทั้งระบบที่ owner เป็น `postgres` ไม่มี GRANT ให้ `sitereq_app`
    เลย ทำให้ทุก endpoint ที่ query ตารางนี้ (validate ประเภทเงินได้ตอนสร้างรายการเคลียร์เงินทดรองจ่าย,
    join ดึงชื่อตอนออก 50 ทวิ) พังด้วย `permission denied for table client_wht_income_types` ทันทีที่มี
    ยอดหัก ณ ที่จ่าย > 0 — บั๊กนี้ตรวจไม่เจอจากการอ่านโค้ดเลย เจอจากการเขียน regression test จริงเท่านั้น
    (`server/tests/advance-clearance.regression.js`)
21. **ไฟล์ `.ps1` ที่มีข้อความภาษาไทย ต้องบันทึกเป็น UTF-8 พร้อม BOM เสมอ (ไม่ใช่ UTF-8 เฉยๆ)** — Windows
    PowerShell 5.1 (ค่าเริ่มต้นของเครื่องนี้) อ่านไฟล์ `.ps1` ที่ไม่มี BOM โดยตีความตาม system codepage
    (locale ไทยมักเป็น WIN874) ไม่ใช่ UTF-8 ทำให้ตัวอักษรไทยใน string literal เพี้ยนแล้ว parser งงว่าเป็น
    token แปลกๆ พังด้วย error `Unexpected token 'เน' in expression...`/`Missing closing '}'...`/`The
    string is missing the terminator` (พบจริงจาก `server/scripts/health-check.ps1` — เนื้อหาถูกต้องทุก
    ตัวอักษร แค่ encoding ของไฟล์ผิด) เครื่องมือเขียนไฟล์ทั่วไป (รวม Write tool ของ Claude Code) มักบันทึก
    เป็น UTF-8 ไม่มี BOM โดยปริยาย — ถ้าเขียนไฟล์ `.ps1` ที่มีภาษาไทยแล้วรันไม่ผ่านด้วย error ลักษณะนี้ ให้
    บันทึกซ้ำด้วย BOM ก่อนเสมอ (เช่น `[System.IO.File]::WriteAllText($path, $content, (New-Object
    System.Text.UTF8Encoding($true)))` — `$true` คือใส่ BOM) แล้วค่อยรันใหม่ ไม่ต้องแก้เนื้อหาสคริปต์เลย
    (ปัญหาเดียวกับ psql/WIN874 ในข้อ 18 เชิงหลักการ แต่เป็นคนละ layer — ข้อ 18 คือ psql ตีความ input
    stream ผิด encoding, ข้อนี้คือ PowerShell parser เองตีความไฟล์ผิด encoding)
22. **คอลัมน์ type `DATE` ทุกคอลัมน์ ห้ามส่งค่าดิบออกจาก query ไปให้ client เด็ดขาด — ต้องผ่าน
    `to_char(col,'YYYY-MM-DD') AS col` ใน SQL เสมอ (หรือแปลงด้วย local-timezone getters ในโค้ด JS
    ก็ได้ถ้าไม่สะดวกแก้ SQL ตรงนั้น เช่น `dt.getFullYear()`/`getMonth()`/`getDate()` ไม่ใช่
    `getUTCFullYear()` — ห้ามใช้ `new Date(d).toISOString()` หรือปล่อยให้ `JSON.stringify` แปลงเองเด็ดขาด
    ทั้งสองแบบ)** เหตุผล: `pg` parse คอลัมน์ `DATE` เป็น JS `Date` โดยตีความเป็นเที่ยงคืน**ตาม timezone
    เครื่อง server** (เครื่องนี้ Asia/Bangkok, UTC+7) ไม่ใช่ UTC แล้ว `res.json()` (ผ่าน
    `JSON.stringify`) เรียก `.toISOString()` ซึ่งแปลงกลับเป็น UTC เสมอ ทำให้ค่าถอยหลังไป 7 ชั่วโมง —
    พอชนกับเที่ยงคืนพอดี วันที่ที่ client เห็นจะผิดไปหนึ่งวันเสมอ (เช่น DB เก็บ `2026-08-21` แต่ client
    เห็น `2026-08-20T17:00:00.000Z`) พบจริงครั้งแรกจาก `client_advance_clearances.clearance_date`/
    `settlement_date` และ `client_wht_certificates.payment_date` (แก้แล้วในเซสชันที่พบ) — ตอนไล่ตรวจทั้ง
    ระบบตามคำสั่งผู้ใช้หลังจากนั้น พบเพิ่มอีกจุดที่ `client_tenders`: endpoint `PUT
    /api/customer/tenders/:id` และ `POST /api/customer/tenders/:id/status` ใช้
    `UPDATE ... RETURNING *` แล้วส่งแถวดิบเข้า `serializeTender()` ตรงๆ — ทั้งที่ `CLIENT_TENDER_SELECT`
    (ใช้ตอน GET/list) cast `submission_deadline`/`submission_open_date` ด้วย `to_char()` ถูกต้องอยู่แล้ว
    ทำให้ endpoint สอง endpoint เดียวกันของเอกสารเดียวกันเห็นวันที่ไม่ตรงกันคนละแบบ (GET ถูก, PUT/
    status ผิด) — **บทเรียนสำคัญ: `SELECT` ผ่าน constant กลาง (เช่น `CLIENT_XXX_SELECT`) ที่ cast
    ถูกต้องแล้ว ไม่ได้แปลว่าทุก endpoint ของตารางนั้นปลอดภัย ต้องเช็ค `RETURNING *` ทุกจุดแยกต่างหากด้วย
    เพราะ `UPDATE`/`INSERT ... RETURNING *` ไม่ได้ผ่าน SELECT constant นั้นเลย** (แก้แล้วโดยเปลี่ยนให้
    re-query ผ่าน `CLIENT_TENDER_SELECT` แทน `RETURNING *` ตรงๆ เหมือน endpoint สร้างใหม่ที่ทำถูกอยู่แล้ว)
23. **เมื่อ migration ใดก็ตาม `DROP CONSTRAINT`/`ADD CONSTRAINT` ขยาย CHECK ของคอลัมน์ `status` ให้
    รับค่าใหม่เพิ่ม ต้องไล่ grep โค้ดทั้งไฟล์ทันทีหลังจากนั้นหา hardcoded status list เดิมที่อาจตกหล่น
    ค่าใหม่** — ค้นด้วย pattern `status IN (`, `status NOT IN (`, `status = '`, `status <> '` ทุกจุดที่
    อ้างถึงตารางนั้น (ทั้งฝั่ง `server.js` และ `pr-system.html`) แล้วพิจารณาทีละจุดว่าค่าที่เพิ่มมาใหม่
    ควรถูกนับรวมอยู่ใน "active"/"outstanding"/"blocking" หรือไม่ ตามความหมายทางธุรกิจของสถานะนั้น พบจริง
    จาก migration 0005 ที่แยกสถานะ `'settled'` ออกจาก `'approved'` ของ
    `client_advance_clearances.status` (ก่อนหน้านั้นมีแค่ `'approved'` เป็นสถานะจบงานทั้งหมด) — endpoint
    `GET /api/customer/outstanding-advances` เขียนไว้ตั้งแต่ก่อน 0005 เช็คแค่
    `c.status = 'approved'` ว่า "เคลียร์แล้วหรือยัง" ไม่รู้จัก `'settled'` เลย ทำให้เงินทดรองจ่ายที่เคลียร์
    จนจบ (สถานะ `settled`) แสดงเป็น "ยอดคงค้าง" กลับมาอีกครั้งอย่างผิดๆ ทั้งที่จริงไม่ค้างแล้ว (แก้เป็น
    `c.status IN ('approved','settled')` โดยอ่านทั้งสองสถานะรวมกันว่า "มีการเคลียร์แล้ว") — ตรวจสอบเพิ่ม
    ในรอบเดียวกัน: `status NOT IN ('rejected','cancelled','voided')` (endpoint สร้างใบเคลียร์ใหม่ กัน
    สร้างซ้ำ) ไม่ต้องแก้ เพราะ `'settled'` ไม่อยู่ในรายการที่ถูก exclude อยู่แล้ว (สื่อความถูกต้องว่ายัง
    "active/ครองสิทธิ์อยู่" โดยไม่ต้องเพิ่มชื่อ status ใหม่ทุกครั้งที่เพิ่มสถานะ — pattern แบบ NOT IN
    ด้วยรายการสถานะ "จบแบบล้มเหลว" ปลอดภัยต่อการเพิ่มสถานะใหม่มากกว่า pattern แบบ IN ด้วยรายการสถานะ
    "จบแบบสำเร็จ" เพราะสถานะสำเร็จใหม่ที่ถูกลืมจะหลุดไปอยู่ฝั่ง "ยังไม่จบ" แทน ซึ่งมักปลอดภัยกว่าไปฝั่ง
    "จบแล้ว" แบบผิดๆ — พิจารณาเลือก pattern นี้เมื่อออกแบบเช็คสถานะใหม่ในอนาคตด้วย)

## กฎการเขียน frontend สำหรับ pr-system.html

1. **ห้าม set `S.page = 'xxx'` ตรงๆ ที่ไหนในโค้ดเด็ดขาด นอกจากในฟังก์ชัน `goToPage(page, extraState)`
   เอง** — ทุกจุดที่จะเปลี่ยนหน้า/เปิดฟอร์มที่มีหน้าใหม่ ต้องเรียก `await goToPage('หน้าใหม่', {ค่า state
   อื่นที่ต้องตั้งก่อน เช่น selectedXxxId, module})` เท่านั้น ห้ามเขียน `S.page = ...; render();` เองแล้ว
   ค่อยเดา/จำเองว่าต้องเรียก loader ตัวไหนตามหลัง — `goToPage()` เรียก `loadDataForPage()` (จุดรวม
   loader ของทุกหน้าในระบบ) ให้อัตโนมัติเสมอ เหตุผล: เจอบั๊กคลาสเดียวกันนี้ซ้ำมาแล้วอย่างน้อย 6 ครั้งจาก
   การ set `S.page` ตรงๆ แล้วลืม/จำไม่ครบว่าต้องเรียก loader ตัวไหนบ้าง —
   (1) `switch-module` ไม่ trigger loader เดียวกับ `nav` ทำให้กระโดดไปหน้า default ของโมดูลที่ต้องโหลด
   ข้อมูล (เช่น `fin_tender_overview`, `fin_vouchers_petty_cash`) ค้างที่ "กำลังโหลด" ตลอดไป
   (2) `open-site-expense-add` เปิดฟอร์มผ่าน custom action ไม่ผ่าน `nav` เลย ทำให้ dropdown เลือก
   โครงการว่างเปล่าเพราะไม่มีใครเรียก `loadRealProjects()`
   (3) `goto-add-project-from-pr` ลืมโหลด employees/tenders ที่ dropdown PM/foreman และ
   source-tender-link ของฟอร์มสร้างโครงการต้องใช้
   (4) `save-tender-full`/`save-po-full` (ตอนสร้างเอกสารสำเร็จแล้ว redirect ไปหน้า detail) เขียน
   comment ไว้ตรงๆ ว่า "ต้องเรียก loader เองเพราะไม่ผ่าน nav" แต่เรียก **ไม่ครบ** ทุก loader ที่หน้านั้น
   ต้องการจริง (`save-tender-full` ลืม `loadTenderInstallments`, `save-po-full` ลืม
   `loadPoReceiptSummary` ที่เพิ่งเพิ่มเข้า `loadDataForPage()` ทีหลังจากตอนเขียน `save-po-full` — พิสูจน์
   ว่าแม้แต่คนที่รู้ตัวว่าต้อง "จำเรียกเอง" ก็ยังพลาดได้เมื่อจุดกลางถูกแก้ไขทีหลังแต่จุดที่ก๊อปลอจิกไว้เอง
   ไม่ได้ถูกอัปเดตตาม) — **นี่คือเหตุผลที่ต้องมีทางเข้าเดียว ไม่ใช่แค่ "จำให้ครบทุกจุด"**: ทางเข้าเดียว
   หมายความว่าแก้ `loadDataForPage()` ที่จุดเดียวจุดใดก็ตาม จุดเรียกทุกจุดในระบบได้ผลอัตโนมัติทันทีโดยไม่
   ต้องไล่แก้ทีละจุดเลย
2. **หน้าใหม่ทุกหน้าที่ต้องโหลดข้อมูลก่อนแสดงผล ต้องเพิ่ม `if(S.page==='หน้าใหม่' ...)` เข้า
   `loadDataForPage()` ตั้งแต่ตอนสร้างหน้านั้น** แม้ตอนแรกจะคิดว่ามีจุดเข้าเดียว (เช่น ปุ่มเปิดฟอร์มจุด
   เดียว) — เพราะภายหลังมักมีจุดเข้าที่สองเพิ่มมาเสมอ (ปุ่ม prefill, redirect หลังบันทึกสำเร็จ, ลิงก์จาก
   หน้าอื่น ฯลฯ) และทุกจุดเข้าใหม่จะได้ loader ถูกต้องอัตโนมัติทันทีถ้าผ่าน `goToPage()` (ดูข้อ 1)
   โดยไม่ต้องแก้อะไรเพิ่มที่จุดเข้าใหม่นั้นเลย
