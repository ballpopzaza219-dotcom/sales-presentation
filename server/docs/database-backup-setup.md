# สำรองข้อมูลฐานข้อมูลอัตโนมัติ (Database Backup)

ตั้งค่าเมื่อ 2026-09-07 ตามที่ฝ่ายบัญชีขอ (เก็บลงไดรฟ์ที่ไม่ใช่ C: — เครื่องนี้ C: มีที่ว่างเพียงพออยู่แล้ว
แต่แยกไดรฟ์ไว้ก็ยังปลอดภัยกว่าในระยะยาว)

## สิ่งที่ตั้งไว้

| อะไร | ค่า |
|---|---|
| สคริปต์ | `server/scripts/backup-database.ps1` |
| รูปแบบไฟล์ | `pg_dump -Fc` (custom format, บีบอัดในตัว, กู้คืนด้วย `pg_restore` ตรงๆ) |
| ปลายทาง | `D:\SiteReqBackups\sitereq_db_YYYYMMDD_HHmmss.dump` |
| เก็บย้อนหลัง | 30 วัน (ไฟล์เก่ากว่านี้ถูกลบอัตโนมัติทุกครั้งที่รัน) |
| Scheduled Task | ชื่อ `SiteReqDatabaseBackup` — รันทุกวันเวลา 02:00 ภายใต้สิทธิ์ผู้ใช้ปัจจุบัน (ไม่ต้อง Administrator เพราะรันในนามผู้ใช้ ไม่ใช่ SYSTEM) |
| Log | `D:\SiteReqBackups\backup-log.txt` (บันทึกทุกครั้งที่ backup สำเร็จ/ล้มเหลว/ลบไฟล์เก่า) |
| เช็คสุขภาพ | `server/scripts/health-check.ps1` เตือนถ้า backup ล่าสุดเก่าเกิน 26 ชั่วโมง หรือไม่พบไฟล์เลย |

## ตรวจสอบว่ายังทำงานอยู่

```powershell
Get-ScheduledTaskInfo -TaskName "SiteReqDatabaseBackup" | Select-Object LastRunTime, LastTaskResult, NextRunTime
```
`LastTaskResult` ต้องเป็น `0` (สำเร็จ) — ถ้าไม่ใช่ ดู `D:\SiteReqBackups\backup-log.txt` ว่า error อะไร

หรือรัน `server\scripts\health-check.ps1` ตามปกติ — จะเตือนอัตโนมัติถ้า backup ค้างเกิน 26 ชั่วโมง

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

## ⚠️ ข้อจำกัดที่ตรวจสอบแล้ว (2026-09-07)

- **ทดสอบ backup จริงแล้ว**: รันสคริปต์ผ่าน Scheduled Task จริง (ไม่ใช่แค่รันมือ) ได้ไฟล์ `.dump` จริง
  ขนาด ~0.85MB, `pg_restore --list` ตรวจสอบโครงสร้างไฟล์แล้วว่าอ่านได้ครบ 1,133 TOC entries ไม่เสียหาย
- **ยังไม่ได้ทดสอบ live-restore เข้าฐานข้อมูลจริงแบบครบวงจร** เพราะ role `sitereq_app` ที่สคริปต์ใช้เชื่อมต่อ
  ไม่มีสิทธิ์ `CREATEDB` (ตั้งใจ — least privilege) การทดสอบ restore เต็มรูปแบบต้องใช้ role ที่มีสิทธิ์สูงกว่า
  (เช่น `postgres`) ทำตามขั้นตอนข้างบนด้วยมือเมื่อสะดวก เพื่อยืนยันครบวงจรจริงอย่างน้อย 1 ครั้ง
- `sitereq_app` มีสิทธิ์เพียงพอสำหรับ `pg_dump` เอง (ตรวจสอบแล้ว — ไม่มี permission error แม้บางตารางในอดีต
  เคยมีปัญหาเรื่อง ownership ตาม CLAUDE.md ข้อ 20)
