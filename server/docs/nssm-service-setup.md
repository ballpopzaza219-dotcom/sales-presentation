# NSSM — ตั้งค่า Node server เป็น Windows Service

บันทึกไว้เผื่อต้องตั้งใหม่บนเครื่องอื่น หรือหลัง reinstall Windows/PostgreSQL (ดูบทเรียนจาก
2026-08-17 ที่ทั้งเครื่องต้อง restore ใหม่หมด — เอกสารพวกนี้ป้องกันไม่ให้ต้องคิด/หาขั้นตอนใหม่ทุกครั้ง)

ติดตั้งจริงบนเครื่องนี้แล้ว 2026-08-18: `Get-Service SiteReqServer` → `Status=Running`,
`StartType=Automatic`

## ⚠️ ต้องใช้ PowerShell แบบ "Run as Administrator" เท่านั้น

การสร้าง/แก้ Windows Service (`nssm install`, `nssm set`) ต้องใช้สิทธิ์ Administrator เสมอ — รันจาก
PowerShell ธรรมดา (ไม่ elevated) จะได้ error `Administrator access is needed to install a service` /
`OpenService(): Access is denied.` ทันที คลิกขวาที่ PowerShell/Terminal แล้วเลือก "Run as
administrator" ก่อนรันคำสั่งทุกครั้งในเอกสารนี้

## ติดตั้ง NSSM

```cmd
winget install NSSM.NSSM
```

ติดตั้งผ่าน winget จะได้ path ประมาณนี้ (เวอร์ชันอาจเปลี่ยนได้ ให้เช็คจริงด้วย
`Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe`):
```
C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe
```
winget ยังเพิ่ม PATH alias `nssm` ให้ด้วย แต่ต้องเปิด shell ใหม่ก่อนถึงจะเห็นผล (ตัวติดตั้งเองบอกไว้ว่า
"Path environment variable modified; restart your shell to use the new value")

## ค่าที่ตั้งไว้จริงบนเครื่องนี้

| การตั้งค่า | ค่า |
|---|---|
| ชื่อ service | `SiteReqServer` |
| Application | `C:\Program Files\nodejs\node.exe` |
| AppParameters | `server.js` |
| AppDirectory | `C:\Users\User\Desktop\sales-presentation\server` |
| AppStdout | `C:\Users\User\Desktop\sales-presentation\server\logs\service-stdout.log` |
| AppStderr | `C:\Users\User\Desktop\sales-presentation\server\logs\service-stderr.log` |
| AppRotateFiles | `1` (เปิด log rotation) |
| AppRotateBytes | `10485760` (10 MB ต่อไฟล์ก่อน rotate) |
| DependOnService | `postgresql-x64-18` (Windows จะไม่ start service นี้จนกว่า Postgres จะ start สำเร็จก่อน) |
| AppExit Default | `Restart` (auto-restart ถ้า process ตายกลางทาง) |
| AppRestartDelay | `5000` (รอ 5 วินาทีก่อน restart กันวน crash-loop รัวๆ) |
| Start | `SERVICE_AUTO_START` (เริ่มอัตโนมัติตอน boot เครื่อง) |

## คำสั่งสร้างตั้งแต่ต้น (ทำครั้งเดียวตอนติดตั้งใหม่)

```powershell
$nssm = "<path เต็มของ nssm.exe จากขั้นตอนติดตั้ง>"

& $nssm install SiteReqServer "C:\Program Files\nodejs\node.exe" "server.js"
& $nssm set SiteReqServer AppDirectory "C:\Users\User\Desktop\sales-presentation\server"
& $nssm set SiteReqServer AppStdout "C:\Users\User\Desktop\sales-presentation\server\logs\service-stdout.log"
& $nssm set SiteReqServer AppStderr "C:\Users\User\Desktop\sales-presentation\server\logs\service-stderr.log"
& $nssm set SiteReqServer AppRotateFiles 1
& $nssm set SiteReqServer AppRotateBytes 10485760
& $nssm set SiteReqServer DependOnService postgresql-x64-18
& $nssm set SiteReqServer AppExit Default Restart
& $nssm set SiteReqServer AppRestartDelay 5000
& $nssm set SiteReqServer Start SERVICE_AUTO_START

nssm start SiteReqServer
```

**⚠️ หลัง start/restart ต้องรอสัก 10 วินาทีก่อนเช็คว่าใช้งานได้จริง** — NSSM รายงาน `Status: Running`
ทันทีที่ launch process สำเร็จ (แค่ process เริ่มรัน ไม่ได้แปลว่าแอปพร้อมใช้งานแล้ว) แต่ Node ยังต้องโหลด
โค้ด + เชื่อมต่อ PostgreSQL ก่อนถึงจะ `app.listen()` จริง — ถ้าทดสอบ `Invoke-WebRequest
http://localhost:3000` ทันทีหลัง start อาจเจอ connection refused ทั้งที่ service กำลังขึ้นอยู่จริง
(พบจริงจากการทดสอบ — ไม่ใช่ error ต้อง panic รอสักครู่แล้วลองใหม่ก่อน)

**ถ้า `nssm install` บอกว่า service มีอยู่แล้ว** (`already exists` — เช่นเคยรันค้างจากรอบก่อนที่ล้มเหลว
กลางทาง) ข้ามบรรทัด `install` ไปเลย รันแค่บรรทัด `set`/`start` ที่เหลือทั้งหมดต่อได้ปกติ (พบจริงตอนติดตั้ง
ครั้งนี้ — install ครั้งแรกน่าจะสร้าง service เปล่าไว้ได้ก่อนจะ error ตอน set เพราะสิทธิ์ไม่พอ)

## Start / Stop / Restart

```powershell
nssm start SiteReqServer
nssm stop SiteReqServer
nssm restart SiteReqServer
```

หรือใช้คำสั่ง Windows service มาตรฐานก็ได้ (ใช้แทนกันได้ทั้งหมด):
```powershell
Start-Service SiteReqServer
Stop-Service SiteReqServer
Restart-Service SiteReqServer
```

## ตรวจสถานะ

```powershell
Get-Service SiteReqServer | Select-Object Name, Status, StartType
nssm get SiteReqServer Application
nssm get SiteReqServer AppParameters
nssm get SiteReqServer AppDirectory
```

ทดสอบว่า server ตอบจริง:
```powershell
Invoke-WebRequest http://localhost:3000 -UseBasicParsing
```

## Log อยู่ที่ไหน

- `server\logs\service-stdout.log` — output ปกติ (เช่น `SiteReq server listening on
  http://localhost:3000`)
- `server\logs\service-stderr.log` — error
- ทั้งสองไฟล์ rotate อัตโนมัติที่ 10 MB (ตั้งไว้ผ่าน `AppRotateFiles`/`AppRotateBytes`)
- **อยู่ใน `.gitignore` แล้ว** (ผ่าน `server/.gitignore` บรรทัด `logs/`) ไม่ต้องกังวลว่าจะหลุดเข้า git

## ลบ service ทิ้ง (ถ้าต้องการ)

```powershell
nssm stop SiteReqServer
nssm remove SiteReqServer confirm
```

## หมายเหตุสำคัญ

ตรวจโค้ดจริงแล้ว `server.js` เรียก `app.listen()` ทันทีโดยไม่รอเช็ค DB ก่อน (`pg` Pool เป็น lazy
connection) — **server จะไม่ crash ตอน boot แม้ Postgres ยังไม่ขึ้น** แต่ตั้ง `DependOnService` ไว้ก็ยัง
ถูกต้องและควรทำ เพราะกัน request แรกๆ หลัง reboot พังเพราะต่อ DB ไม่ได้ (ไม่ใช่กัน crash แต่กัน error
ชั่วครู่ตอนเริ่มระบบ)

**อย่ารัน `npm start` แบบ manual ค้างไว้พร้อมกับ service** — จะแย่งกัน bind port 3000 (ตัวที่สอง error
`EADDRINUSE`) ก่อนจะทดสอบอะไรผ่าน manual process ให้ `nssm stop SiteReqServer` ก่อนเสมอ
