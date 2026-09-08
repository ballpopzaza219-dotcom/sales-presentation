# สำรองข้อมูลฐานข้อมูลอัตโนมัติ (Database Backup)

ตั้งค่าเมื่อ 2026-09-07 ตามที่ฝ่ายบัญชีขอ — อัปเดต 2026-09-08 (ย้ายปลายทาง + แยกวิธีสำรอง role/password
หลังไล่ตรวจ ACL จริงแล้วพบว่าที่ตั้งเดิมมีปัญหา ดูหัวข้อ "ทำไมย้ายจาก D:" ด้านล่าง)

## สิ่งที่ตั้งไว้

| อะไร | ค่า |
|---|---|
| สคริปต์ข้อมูลหลัก (รายวัน อัตโนมัติ) | `server/scripts/backup-database.ps1` |
| สคริปต์ role/password (รายเดือน มือ) | `server/scripts/backup-globals.ps1` |
| รูปแบบไฟล์ข้อมูล | `pg_dump -Fc` (custom format, บีบอัดในตัว, กู้คืนด้วย `pg_restore` ตรงๆ) |
| รูปแบบไฟล์ role/password | `pg_dumpall -g` (plain SQL) |
| ปลายทาง | `C:\SiteReqBackups\sitereq_db_YYYYMMDD_HHmmss.dump` + `sitereq_globals_YYYYMMDD_HHmmss.sql` |
| สิทธิ์เข้าถึงโฟลเดอร์ | NTFS ACL จำกัดเฉพาะ `SYSTEM`, `Administrators`, user ปัจจุบันเท่านั้น (ไม่มี `Everyone`/`Authenticated Users`/`Users`) |
| เก็บย้อนหลัง | 30 วัน (ไฟล์เก่ากว่านี้ถูกลบอัตโนมัติทุกครั้งที่ `backup-database.ps1` รัน ทั้ง C:, D: สำเนาที่สอง, และ globals) |
| สำเนาที่สอง | ก๊อป `sitereq_db_*.dump` ล่าสุดไป `D:\SiteReqBackups` ทุกครั้งหลัง backup หลักสำเร็จ (ป้องกันดิสก์ C: เสียทั้งลูก — ไม่ใช่มาตรการ ACL ดู "ทำไมย้ายจาก D: มา C:" ด้านล่างว่าทำไม D: ไม่ใช่ที่เก็บหลักที่ปลอดภัยพอ) — soft-fail ถ้าถอด USB ออก ไม่กระทบ backup หลักบน C: |
| รหัสผ่าน `sitereq_app` | ไม่เก็บในสคริปต์เลย — sync เข้า `.pgpass` มาตรฐานของ Postgres อัตโนมัติทุกครั้งที่รัน (`%APPDATA%\postgresql\pgpass.conf`) จาก `server/.env` |
| รหัสผ่าน `postgres` (superuser) | **ไม่เก็บไว้ที่ไหนเลย** — `backup-globals.ps1` ถามสดทุกครั้งที่รันมือ (ดูเหตุผลด้านล่าง) |
| Scheduled Task | ชื่อ `SiteReqDatabaseBackup` — รัน `backup-database.ps1` ทุกวันเวลา 02:00 ภายใต้สิทธิ์ผู้ใช้ปัจจุบัน (ไม่ต้อง Administrator เพราะรันในนามผู้ใช้ ไม่ใช่ SYSTEM) — `backup-globals.ps1` **ไม่ผูก Task ใดๆ ตั้งใจ** ต้องรันมือ |
| Log | `C:\SiteReqBackups\backup-log.txt` (บันทึกทุกครั้งที่ backup สำเร็จ/ล้มเหลว/ลบไฟล์เก่า) |
| เช็คสุขภาพ | `server/scripts/health-check.ps1` เตือนถ้า backup ข้อมูลหลักหรือสำเนาที่สองเก่าเกิน 48 ชั่วโมง หรือ backup globals เก่าเกิน 45 วัน |

## ทำไมย้ายจาก D: มา C: (2026-09-08)

ตอนตั้งค่าครั้งแรกใช้ `D:\SiteReqBackups` ตามคำขอ "ไม่ใช่ C:" — ตอนนั้นไม่รู้ว่า `D:` ของเครื่องนี้คือ
**removable USB drive ฟอร์แมต FAT32** จนกว่าจะไล่ตรวจ ACL จริงตามคำถามของฝ่ายบัญชี พบว่า:

- **FAT32 ไม่รองรับ NTFS ACL เลย** — ไฟล์ทุกไฟล์บนไดรฟ์นี้แสดงเป็น `Everyone: Full Control` เสมอ (Windows
  fabricate ให้เพราะ filesystem ไม่มีระบบสิทธิ์จริง) **ตั้งสิทธิ์จำกัดไม่ได้จริงๆ ไม่ว่าจะลองยังไง** — แปลว่า
  ใครก็ตามที่ล็อกอินเครื่องนี้ได้ (account ไหนก็ได้) หรือถอด USB ไปเสียบเครื่องอื่น อ่าน/แก้/ลบไฟล์ backup
  (มีข้อมูลลูกค้าทั้งบริษัท) ได้ทันที
- ไดรฟ์นี้เป็น USB ส่วนตัวที่มีไฟล์อื่นของผู้ใช้อยู่แล้ว (เอกสาร, PDF) ไม่ใช่ไดรฟ์ที่กันไว้เพื่อ backup
  โดยเฉพาะ — เสี่ยงถูกถอด/สลับ/ทำหายโดยไม่ตั้งใจ
- FAT32 จำกัดไฟล์เดียวไม่เกิน 4GB — ยังไม่ใช่ปัญหาตอนนี้ (ไฟล์ ~0.85MB) แต่จะกลายเป็นจุดพังแบบเงียบๆ ถ้า
  ฐานข้อมูลโตขึ้นในอนาคต (เช็ค "ไฟล์เล็กกว่า 1KB" ที่มีอยู่จับเคสนี้ไม่ได้)

ย้ายมา `C:\SiteReqBackups` แทน (NTFS, ตั้ง ACL จำกัดได้จริง, C: มีที่ว่าง 239GB เหลือเฟือ) — เหตุผลเดิมที่
เลี่ยง C: (พื้นที่ดิสก์) ตรวจสอบแล้วว่าไม่ใช่ข้อจำกัดจริงของเครื่องนี้

**แต่** C: เป็นดิสก์เดียวกับที่ PostgreSQL เก็บข้อมูลจริงอยู่ — ถ้าดิสก์นี้เสียทั้งลูก backup ก็หายไปพร้อมกับ
ข้อมูลต้นฉบับ เท่ากับไม่มี backup เลยในสถานการณ์นั้น จึงเพิ่มการก๊อปสำเนาที่สองไป `D:\SiteReqBackups`
(USB เดิม) ทุกครั้งหลัง backup หลักสำเร็จ — **ใช้ D: เป็นสำเนาสำรองกันดิสก์เสีย ไม่ใช่ที่เก็บหลัก** (ยัง
ตั้ง ACL จำกัดสิทธิ์บน D: ไม่ได้เหมือนเดิม เพราะเป็น FAT32 — ยอมรับความเสี่ยงนี้เพื่อแลกกับการมีสำเนานอกดิสก์
C: ไว้บ้าง ดีกว่าไม่มีเลย) ไม่มีไดรฟ์ภายในตัวที่สองบนเครื่องนี้ และยังไม่มีบริการ cloud storage ที่ตั้งไว้ใช้
ในโปรเจกต์นี้ — ถ้าจะเพิ่มความปลอดภัยกว่านี้ในอนาคต ต้องพิจารณา cloud storage หรือหาไดรฟ์ NTFS ตัวที่สองจริง

## ทำไมแยก pg_dumpall -g ออกเป็นสคริปต์รันมือต่างหาก

`pg_dumpall -g` ต้องอ่านตาราง `pg_authid` (เก็บ password hash ของทุก role) ซึ่ง Postgres สงวนสิทธิ์ให้
**เฉพาะ superuser** อ่านได้เท่านั้น — ไม่มี predefined role ไหน (`pg_read_all_data`, `pg_monitor` ฯลฯ)
ให้สิทธิ์อ่านบางส่วนได้เลย (ยืนยันจากการรันจริง ไม่ใช่แค่อ่านเอกสาร: `sitereq_app` เจอ `permission denied
for table pg_authid` ทุกครั้ง) — ทางเดียวที่ทำได้คือใช้ credential ของ role ที่เป็น superuser จริง (เช่น
`postgres`)

**ตัดสินใจ**: ไม่คุ้มที่จะฝากรหัสผ่าน superuser ไว้ถาวรในไฟล์ (`.pgpass` หรือที่ไหนก็ตาม) เพื่อแลกกับการ
อัตโนมัติสิ่งที่เปลี่ยนน้อยมาก (role/password ของระบบนี้แทบไม่เปลี่ยนเลยนอกจากมีคนเพิ่ม/ลบ login จริงๆ) —
เครื่องนี้เปิดออก internet ผ่าน Cloudflare Tunnel ด้วย รหัสผ่าน superuser ที่ persist ไว้คือความเสี่ยงจริง
ไม่ใช่ทฤษฎี **ห้าม** แก้ปัญหาด้วยการ `GRANT SELECT ON pg_authid TO sitereq_app` เด็ดขาด เพราะเท่ากับเปิด
ช่องให้แอป (ถ้าถูกโจมตีผ่าน SQL injection จุดใดในอนาคต) อ่าน password hash ของทุก role ในคลัสเตอร์ได้ ไม่ใช่
แค่ของตัวเอง — เป็นการแลกความเสี่ยงที่แพงกว่าประโยชน์ที่ได้มาก

แทนที่ด้วย `server/scripts/backup-globals.ps1` — **รันมือทุกเดือน**, ถามรหัสผ่าน `postgres` สดทุกครั้ง
(ไม่ echo ขึ้นจอ ไม่เก็บไว้ที่ไหนหลังจบ) — `health-check.ps1` เตือนถ้าเกิน 45 วันไม่มีไฟล์ใหม่

## ตรวจสอบว่า backup รายวันยังทำงานอยู่

```powershell
Get-ScheduledTaskInfo -TaskName "SiteReqDatabaseBackup" | Select-Object LastRunTime, LastTaskResult, NextRunTime
```
`LastTaskResult` ต้องเป็น `0` (สำเร็จ) — ถ้าไม่ใช่ ดู `C:\SiteReqBackups\backup-log.txt` ว่า error อะไร

หรือรัน `server\scripts\health-check.ps1` ตามปกติ — จะเตือนอัตโนมัติทั้ง backup ข้อมูลหลัก, สำเนาที่สองบน
D: (เกิน 48 ชม. ทั้งคู่) และ backup globals (เกิน 45 วัน)

## สำรอง role/password รายเดือน (ต้องรันมือ)

```powershell
powershell -File server\scripts\backup-globals.ps1
```
จะถาม username (Enter = `postgres`) แล้วให้พิมพ์รหัสผ่านสด — ทำเดือนละครั้งก็พอ

## กู้คืนข้อมูล (Restore)

**ห้ามรันคำสั่งนี้ทับฐานข้อมูลจริง (`sitereq_db`) โดยตรงเด็ดขาด** เว้นแต่ตั้งใจกู้คืนจริงและได้สำรองสถานะ
ปัจจุบันไว้ก่อนแล้ว — แนะนำให้กู้คืนลงฐานข้อมูลใหม่ก่อนเสมอเพื่อตรวจสอบความถูกต้อง:

```powershell
# 1) สร้างฐานข้อมูลทดสอบ (ต้องใช้ role ที่มีสิทธิ์ CREATEDB เช่น postgres)
psql -h 127.0.0.1 -U postgres -d postgres -c "CREATE DATABASE sitereq_restore_test;"

# 2) กู้คืนไฟล์ backup ลงฐานข้อมูลทดสอบ
pg_restore -h 127.0.0.1 -U postgres -d sitereq_restore_test "C:\SiteReqBackups\sitereq_db_<timestamp>.dump"

# 3) เทียบจำนวนแถวของตารางหลักๆ ให้ตรงกับต้นฉบับเป๊ะ ก่อนเชื่อว่า backup ใช้ได้จริง เช่น:
psql -h 127.0.0.1 -U postgres -d sitereq_db -c "SELECT count(*) FROM client_journal_entries;"
psql -h 127.0.0.1 -U postgres -d sitereq_restore_test -c "SELECT count(*) FROM client_journal_entries;"

# 4) ลบฐานข้อมูลทดสอบทิ้งหลังตรวจเสร็จ
psql -h 127.0.0.1 -U postgres -d postgres -c "DROP DATABASE sitereq_restore_test;"

# กู้คืน role/password (ถ้าเป็นการกู้คืนเครื่องใหม่ทั้งชุด ไม่ใช่แค่ทดสอบ) — รันไฟล์ globals ก่อน pg_restore เสมอ
psql -h 127.0.0.1 -U postgres -d postgres -f "C:\SiteReqBackups\sitereq_globals_<timestamp>.sql"
```

## ⚠️ ข้อจำกัดที่เหลืออยู่ (อัปเดต 2026-09-08)

- **ทดสอบ backup ข้อมูลหลักจริงแล้ว**: รันสคริปต์ผ่าน Scheduled Task จริง (ไม่ใช่แค่รันมือ) ได้ไฟล์ `.dump`
  จริงหลายรอบ, `pg_restore --list` ตรวจสอบโครงสร้างไฟล์แล้วว่าอ่านได้ครบทุก TOC entries ไม่เสียหาย
- **ยังไม่ได้ทดสอบ live-restore เข้าฐานข้อมูลจริงแบบครบวงจร (restore แล้วเทียบจำนวนแถวกับต้นฉบับ)** —
  ต้องใช้ role ที่มีสิทธิ์ `CREATEDB` (เช่น `postgres`) ซึ่งตอนนี้ยังไม่ได้ persist credential ไว้ที่ไหนเลย
  (ตามการตัดสินใจข้างบน) — ทำตามขั้นตอน "กู้คืนข้อมูล" ด้านบนด้วยมือเมื่อสะดวก เพื่อยืนยันครบวงจรจริงอย่าง
  น้อย 1 ครั้ง
- **`backup-globals.ps1` ยังไม่เคยถูกรันจริงเลยสักครั้ง** (เพิ่งสร้างเสร็จ 2026-09-08) — ต้องรันครั้งแรก
  ด้วยมือเพื่อยืนยันว่าใช้งานได้จริงกับรหัสผ่าน `postgres` จริงของเครื่องนี้
- `sitereq_app` มีสิทธิ์เพียงพอสำหรับ `pg_dump` เอง (ตรวจสอบแล้ว — ไม่มี permission error แม้บางตารางในอดีต
  เคยมีปัญหาเรื่อง ownership ตาม CLAUDE.md ข้อ 20)
