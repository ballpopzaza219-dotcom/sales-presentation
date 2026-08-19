# Cloudflare Tunnel — เปิดให้เข้าถึง build-con.com จากภายนอก

บันทึกไว้เผื่อต้องตั้งใหม่บนเครื่องอื่น หรือหลัง reinstall (ดูบทเรียนเดียวกับที่ทำให้ต้องเขียน
`nssm-service-setup.md` — เอกสารพวกนี้กันไม่ให้ต้องไล่หาขั้นตอนใหม่ทุกครั้งที่เครื่องมีปัญหา)

ใช้งานจริงสำเร็จ 2026-08-19 — `https://build-con.com` เข้าได้จากภายนอกแล้ว

## ⚠️ Tunnel ที่ใช้งานจริงคือ `build-con` ไม่ใช่ `sitereq-tunnel`

| | สถานะ |
|---|---|
| **`build-con`** (ID `c6388f39-...`) | **ใช้งานจริง** — สร้างใหม่แบบ remotely-managed ตั้ง route ผ่าน dashboard ได้ปกติ |
| `sitereq-tunnel` (ID `334fd719-3c05-462a-95ee-f4d24935b1c9`) | **เลิกใช้แล้ว** — เป็น tunnel แบบ **locally-managed** (route ต้องมาจาก `config.yml` ในเครื่องเท่านั้น แก้จาก dashboard ไม่ได้เลย ตัว dashboard เองก็บอกตรงๆ ว่า "This tunnel is locally managed... cannot be modified from the dashboard") เครื่องเดิมที่มี `config.yml` นี้พังไปแล้ว ทำให้ route หายและกู้จาก dashboard ไม่ได้ — **ยังไม่ลบ เก็บไว้เป็นทางถอยเผื่อจำเป็น** แต่ไม่ควรใช้งานต่อ

**ถ้าจะตั้ง tunnel ใหม่ในอนาคต ให้สร้างผ่าน dashboard เสมอ** (Networks → Tunnels → Create a tunnel) จะได้เป็นแบบ remotely-managed ตั้งแต่ต้น ไม่เจอปัญหาเดียวกันซ้ำ — **หลีกเลี่ยงการสร้างด้วย `cloudflared tunnel create` ผ่าน CLI** (ได้ tunnel แบบ locally-managed โดยปริยาย)

## ติดตั้ง cloudflared (เครื่องใหม่/reinstall)

```cmd
winget install Cloudflare.cloudflared
```

Binary จะอยู่ที่ `C:\Program Files (x86)\cloudflared\cloudflared.exe` (เวอร์ชันที่ติดตั้งจริงบนเครื่องนี้:
2026.8.2)

## ติดตั้งเป็น Windows Service ด้วย token

**เอา token**: Zero Trust dashboard → **Networks → Tunnels → `build-con`** → **Configure** → คัดลอก
token จากคำสั่งติดตั้งที่แสดงให้ (รูปแบบ `cloudflared service install eyJhIjoi...`)

**ติดตั้ง** (ต้องรันใน PowerShell แบบ **Administrator** เสมอ — เหมือน NSSM):
```cmd
cloudflared service install <TOKEN>
```
คำสั่งนี้สร้าง Windows Service ชื่อ `Cloudflared` ให้เองครบ (ไม่ต้องใช้ NSSM ช่วย cloudflared มี service
installer ในตัว)

**ตรวจสถานะ**:
```powershell
Get-Service Cloudflared
```

## Rotate token (ถ้า token เดิมหลุด/ใช้ไม่ได้)

Dashboard → `build-con` → **Configure** → **Rotate Token** — token เดิมจะใช้ไม่ได้ทันที ต้องรัน
`cloudflared service install <TOKEN_ใหม่>` ซ้ำ (ก่อนหน้านั้นต้อง `cloudflared service uninstall` ตัวเก่า
ออกก่อนเสมอ ไม่งั้นจะชนกับ service ชื่อเดิมที่มีอยู่แล้ว):
```powershell
cloudflared service uninstall
cloudflared service install <TOKEN_ใหม่>
```

## ตั้ง Public Hostname (route) — ทำผ่าน dashboard เท่านั้น

Dashboard → `build-con` → แท็บ **Public Hostname** → **Add a public hostname**:
- Domain: `build-con.com`
- Service Type: **HTTP**
- URL: **`localhost:3000`**

ตั้งตรงนี้แล้ว DNS record จะถูกสร้าง/อัปเดตให้อัตโนมัติ ไม่ต้องไปแก้ DNS แยกเอง (ข้อดีของ
remotely-managed tunnel — สร้างผ่าน CLI แบบ locally-managed จะไม่ได้สิทธิ์นี้)

## Debug — เช็คว่า cloudflared ดึง config จริงมาจากไหน

Windows Event Viewer (`Get-WinEvent -LogName Application`, filter `ProviderName -like "*cloudflare*"`)
**มีแค่ log ระดับ service lifecycle เท่านั้น** (`Cloudflared service starting`, arguments ที่ใช้รัน) —
**ไม่มี log ระดับ connection/routing ให้เห็นเลย** ไม่พอสำหรับ debug ปัญหา route/ingress จริง

วิธีดู log แบบละเอียดจริง — หยุด Windows Service ชั่วคราวแล้วรัน foreground เอง:
```powershell
Stop-Service Cloudflared
cloudflared tunnel --loglevel debug run --token-file C:\ProgramData\cloudflared\token
```
วิธีนี้จะเห็น **ingress configที่ cloudflared ดึงมาจาก Cloudflare cloud จริง** ทาง terminal ตรงๆ (สำหรับ
tunnel แบบ remotely-managed ไม่มี config.yml ในเครื่องให้ดู ต้องรัน foreground แบบนี้เท่านั้นถึงจะเห็นว่า
มันโหลด rule อะไรมาจริง) กด Ctrl+C ออกแล้ว `Start-Service Cloudflared` กลับตามปกติเมื่อดูเสร็จ

## ทดสอบ

เปิด `https://build-con.com` จากมือถือ/เน็ตนอกวง (ไม่ใช่เครื่องนี้ กัน DNS cache ของเครื่องเองบังตา) — ควร
เห็นหน้าเว็บจริง ไม่ใช่ Error 1033/503
