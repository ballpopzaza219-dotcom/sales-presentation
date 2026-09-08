# สำรองข้อมูลฐานข้อมูลอัตโนมัติ (Database Backup)

ตั้งค่าเมื่อ 2026-09-07 ตามที่ฝ่ายบัญชีขอ (เก็บลงไดรฟ์ที่ไม่ใช่ C: — เครื่องนี้ C: มีที่ว่างเพียงพออยู่แล้ว
แต่แยกไดรฟ์ไว้ก็ยังปลอดภัยกว่าในระยะยาว)

## สิ่งที่ตั้งไว้

| อะไร | ค่า |
|---|---|
| สคริปต์ | `server/scripts/backup-database.ps1` |
| รูปแบบไฟล์ข้อมูล | `pg_dump -Fc` (custom format, บีบอัดในตัว, กู้คืนด้วย `pg_restore` ตรงๆ) |
| รูปแบบไฟล์ role/password | `pg_dumpall -g` (plain SQL) — **ยังไม่ทำงาน** จนกว่าจะตั้ง credential ที่มีสิทธิ์อ่าน `pg_authid` (ดูหัวข้อข้อจำกัดด้านล่าง) |
| ปลายทาง | `D:\SiteReqBackups\sitereq_db_YYYYMMDD_HHmmss.dump` + `sitereq_globals_YYYYMMDD_HHmmss.sql` |
| เก็บย้อนหลัง | 30 วัน (ไฟล์เก่ากว่านี้ถูกลบอัตโนมัติทุกครั้งที่รัน ทั้งสองชนิดไฟล์) |
| รหัสผ่าน DB | ไม่เก็บในสคริปต์เลย — sync เข้า `.pgpass` มาตรฐานของ Postgres อัตโนมัติทุกครั้งที่รัน (`%APPDATA%\postgresql\pgpass.conf`) จาก `server/.env` |
| Scheduled Task | ชื่อ `SiteReqDatabaseBackup` — รันทุกวันเวลา 02:00 ภายใต้สิทธิ์ผู้ใช้ปัจจุบัน (ไม่ต้อง Administrator เพราะรันในนามผู้ใช้ ไม่ใช่ SYSTEM) |
| Log | `D:\SiteReqBackups\backup-log.txt` (บันทึกทุกครั้งที่ backup สำเร็จ/ล้มเหลว/ลบไฟล์เก่า — globals ที่ยังไม่สำเร็จบันทึกเป็น `WARN` แยกจาก `FAILED` ของตัวข้อมูลหลัก) |
| เช็คสุขภาพ | `server/scripts/health-check.ps1` เตือนถ้า backup ข้อมูลหลักล่าสุดเก่าเกิน 48 ชั่วโมง หรือไม่พบไฟล์เลย (globals ยังไม่เตือนเป็น error จนกว่าจะเริ่มทำงานได้จริงครั้งแรก) |

## ตรวจสอบว่ายังทำงานอยู่

```powershell
Get-ScheduledTaskInfo -TaskName "SiteReqDatabaseBackup" | Select-Object LastRunTime, LastTaskResult, NextRunTime
```
`LastTaskResult` ต้องเป็น `0` (สำเร็จ) — ถ้าไม่ใช่ ดู `D:\SiteReqBackups\backup-log.txt` ว่า error อะไร

หรือรัน `server\scripts\health-check.ps1` ตามปกติ — จะเตือนอัตโนมัติถ้า backup ข้อมูลหลักค้างเกิน 48 ชั่วโมง

## กู้คืนข้อมูล (Restore)

**ห้ามรันคำสั่งนี้ทับฐานข้อมูลจริง (`sitereq_db`) โดยตรงเด็ดขาด** เว้นแต่ตั้งใจกู้คืนจริงและได้สำรองสถานะ
ปัจจุบันไว้ก่อนแล้ว — แนะนำให้กู้คืนลงฐานข้อมูลใหม่ก่อนเสมอเพื่อตรวจสอบความถูกต้อง:

```powershell
# 1) สร้างฐานข้อมูลทดสอบ (ต้องใช้ role ที่มีสิทธิ์ CREATEDB เช่น postgres)
psql -h 127.0.0.1 -U postgres -d postgres -c "CREATE DATABASE sitereq_restore_test;"

# 2) กู้คืนไฟล์ backup ลงฐานข้อมูลทดสอบ
pg_restore -h 127.0.0.1 -U postgres -d sitereq_restore_test "D:\SiteReqBackups\sitereq_db_<timestamp>.dump"

# 3) ตรวจสอบข้อมูลถูกต้องก่อนตัดสินใจกู้คืนจริง แล้วค่อยลบฐานข้อมูลทดสอบทิ้ง
psql -h 127.0.0.1 -U postgres -d postgres -c "DROP DATABASE sitereq_restore_test;"
```

## ⚠️ ข้อจำกัดที่ตรวจสอบแล้ว (อัปเดต 2026-09-08)

- **ทดสอบ backup ข้อมูลหลักจริงแล้ว**: รันสคริปต์ผ่าน Scheduled Task จริง (ไม่ใช่แค่รันมือ) ได้ไฟล์ `.dump`
  จริงหลายรอบ, `pg_restore --list` ตรวจสอบโครงสร้างไฟล์แล้วว่าอ่านได้ครบทุก TOC entries ไม่เสียหาย
- **`pg_dumpall -g` (role/password ระดับ cluster) ยังไม่ทำงาน — ตรวจสอบแล้วว่าเป็นข้อจำกัดของสิทธิ์ ไม่ใช่
  บั๊กสคริปต์**: `pg_dumpall -g` ต้อง `SELECT` จากตาราง `pg_authid` (เก็บ password hash ของทุก role) ซึ่ง
  Postgres ออกแบบให้ **เฉพาะ superuser** อ่านได้เท่านั้น โดยตั้งใจ — role ของแอป (`sitereq_app`) ที่ใช้
  เชื่อมต่ออยู่ไม่ใช่ superuser (least privilege ตามที่ตั้งใจไว้) จึงเจอ `permission denied for table
  pg_authid` ทุกครั้งที่รัน (ยืนยันด้วยการรันจริง ไม่ใช่แค่คาดเดา) — สคริปต์ทำให้ส่วนนี้ fail แบบ **soft**
  (บันทึกเป็น `WARN` ใน log, ไม่ทำให้ backup ข้อมูลหลักที่สำเร็จแล้วถูกนับเป็น `FAILED` ไปด้วย) แต่ยังไม่มี
  backup ของ role/password เลยจนกว่าจะแก้ข้อจำกัดนี้
  - **ทางแก้ที่ต้องมีคนตัดสินใจ**: ต้องใช้ credential ของ role ที่มีสิทธิ์อ่าน `pg_authid` ได้ (เช่น
    `postgres`) — **ห้าม** แก้ด้วยการ `GRANT SELECT ON pg_authid TO sitereq_app` เด็ดขาด เพราะจะเปิดช่องให้
    แอป (ถ้าถูกโจมตีผ่าน SQL injection จุดใดจุดหนึ่งในอนาคต) อ่าน password hash ของทุก role ในคลัสเตอร์ได้
    ไม่ใช่แค่ของตัวเอง — ทางที่ถูกต้องคือเพิ่มบรรทัด `.pgpass` ของ role `postgres` เอง (หรือ role อื่นที่เป็น
    superuser) แยกต่างหาก แล้วแก้สคริปต์ให้เรียก `pg_dumpall -g` ด้วย `-U` ของ role นั้นแทน `sitereq_app`
- **ยังไม่ได้ทดสอบ live-restore เข้าฐานข้อมูลจริงแบบครบวงจร (restore แล้วเทียบจำนวนแถวกับต้นฉบับ)** —
  ติดข้อจำกัดเดียวกัน: role `sitereq_app` ไม่มีสิทธิ์ `CREATEDB` (ตั้งใจ — least privilege) ต้องใช้ role ที่มี
  สิทธิ์สูงกว่า (เช่น `postgres`) ทำตามขั้นตอนข้างบนด้วยมือเมื่อสะดวก เพื่อยืนยันครบวงจรจริงอย่างน้อย 1 ครั้ง
  — เมื่อทำแล้วให้เทียบ `SELECT count(*)` ของตารางหลักๆ (เช่น `client_journal_entries`,
  `client_payment_vouchers`) ระหว่างฐานข้อมูลจริงกับฐานข้อมูลทดสอบที่ restore มา ต้องตรงกันเป๊ะ
- `sitereq_app` มีสิทธิ์เพียงพอสำหรับ `pg_dump` เอง (ตรวจสอบแล้ว — ไม่มี permission error แม้บางตารางในอดีต
  เคยมีปัญหาเรื่อง ownership ตาม CLAUDE.md ข้อ 20)
