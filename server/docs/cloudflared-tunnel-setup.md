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

## ⚠️ Error 1033 = Cloudflared service ไม่ได้รันอยู่ — เช็คจุดนี้ก่อนเสมอ

`build-con.com` ขึ้น **Error 1033** (Argo Tunnel error) แทบทุกครั้งแปลว่า Windows Service `Cloudflared`
บนเครื่องนี้ไม่ได้ทำงานอยู่ (ไม่ใช่ปัญหาที่ dashboard/DNS/route เลย) — เช็คก่อนอันดับแรกเสมอ:
```powershell
Get-Service Cloudflared
```
ถ้า `Status` ไม่ใช่ `Running` ให้ `Start-Service Cloudflared` แล้วรอสัก 10 วินาทีเหมือน `SiteReqServer`
(ดู `nssm-service-setup.md`) แล้วลองเปิดเว็บใหม่

**สาเหตุที่พบจริงแล้ว**: รัน foreground debug (ดูหัวข้อ Debug ด้านล่าง) แล้ว `Stop-Service Cloudflared`
ก่อนเริ่ม แต่ลืม `Start-Service Cloudflared` กลับหลังดู log เสร็จ — service เลยค้างสถานะ Stopped ไปเรื่อยๆ
จนกว่าจะมีคนสังเกต **ใช้ `server/scripts/health-check.ps1` เช็คทั้งระบบทีเดียวหลังทำอะไรกับ service
ไหนก็ตาม จะจับเคสนี้ได้ทันที**

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

## ตั้ง restart-on-failure (เพิ่งตั้งแล้ว 2026-08-19)

`cloudflared service install` **ไม่ได้ตั้ง recovery action ให้อัตโนมัติ** ต่างจาก `SiteReqServer` ที่ตั้ง
`AppExit Default Restart` ไว้ผ่าน NSSM ตั้งแต่ต้น — cloudflared เป็น native Windows Service ธรรมดา
(ไม่ผ่าน NSSM) ต้องตั้งผ่านกลไก Recovery ของ Windows Service Control Manager เอง โดยใช้ `sc.exe
failure` (ต้อง Administrator เสมอ — และสังเกตว่า `sc.exe` บังคับต้องมีช่องว่างหลัง `reset=`/`actions=`
เป๊ะๆ ไม่งั้นจะ error):
```powershell
sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/5000/restart/5000
```
- `reset= 86400` — นับ failure ใหม่ (รีเซ็ตกลับไปนับจากครั้งที่ 1) ถ้าไม่มี failure ใหม่เกิดขึ้นภายใน
  86400 วินาที (24 ชม.) หลัง failure ล่าสุด
- `actions= restart/5000/restart/5000/restart/5000` — failure ครั้งที่ 1/2/3 ทั้งหมด restart หลังรอ
  5000ms (5 วินาที) เหมือนกัน (ตรงกับ `AppRestartDelay 5000` ที่ตั้งไว้กับ `SiteReqServer`)

**⚠️ ข้อจำกัดสำคัญ — recovery action นี้ป้องกันได้แค่ "crash" ไม่ใช่ "ถูกสั่งหยุดเอง"**: Windows SCM
จงใจไม่ trigger recovery action เมื่อมีคนสั่ง `Stop-Service`/`net stop` ตรงๆ (ถือเป็นการหยุดที่ตั้งใจ ไม่ใช่
ความผิดปกติ) — **เคสที่เกิดขึ้นจริง (ลืม start กลับหลัง debug foreground) จะไม่ถูกป้องกันโดย `sc failure`
เลย** เพราะเป็นการสั่งหยุดตรงๆ ไม่ใช่ crash — วิธีป้องกันเคสนี้จริงๆ คือระเบียบปฏิบัติ (เตือนไว้ในหัวข้อ
Error 1033 ด้านบนแล้ว) + รัน `health-check.ps1` ตรวจซ้ำหลังทำอะไรกับ service เสมอ

ตรวจว่าตั้งสำเร็จ:
```powershell
sc.exe qfailure Cloudflared
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
