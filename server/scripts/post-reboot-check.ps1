# ตรวจว่า reboot เครื่องแล้วระบบกลับมาเองครบโดยไม่ต้องแตะอะไรเลย — postgresql-x64-18 -> SiteReqServer ->
# Cloudflared -> build-con.com เข้าได้จากภายนอก
#
# ไม่ต้อง Administrator (เหมือน health-check.ps1) — รันได้ทันทีหลัง login เข้าเครื่องหลัง reboot
#
# หมายเหตุเรื่อง "ลำดับ": Windows ไม่มี event log ที่เชื่อถือได้เสมอสำหรับดู timestamp ที่แต่ละ service
# เริ่มจริง (Event ID 7036 ไม่ได้ถูกบันทึกทุกเครื่อง/ทุก config) สคริปต์นี้เลยตรวจ "กลไกที่บังคับลำดับจริง"
# แทนการเดาจาก timestamp:
#   - postgresql-x64-18 -> SiteReqServer: บังคับด้วย Windows Service dependency จริง (DependOnService)
#     Windows SCM จะไม่ปล่อยให้ SiteReqServer start จนกว่า postgresql-x64-18 จะ Running ก่อนเสมอ
#   - SiteReqServer -> Cloudflared: ไม่มี dependency ทาง OS (cloudflared ไม่จำเป็นต้องรอ Node) แต่
#     Cloudflared แค่ proxy คำขอไปที่ localhost:3000 เฉยๆ — ถ้า Node ยังไม่พร้อมตอน request เข้ามาพอดี
#     (ช่วงไม่กี่วินาทีแรกหลัง boot) จะเห็น 502 ชั่วคราวเท่านั้น ไม่ใช่ error ถาวร (ดู nssm-service-setup.md)
#
# Usage: powershell -File server\scripts\post-reboot-check.ps1

$ErrorActionPreference = 'Continue'
$problems = @()

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$uptimeMin = [Math]::Round(((Get-Date) - $boot).TotalMinutes, 1)
Write-Output "=== เวลา boot เครื่องล่าสุด ==="
Write-Output "  $boot (boot มาแล้ว $uptimeMin นาที)"
if ($uptimeMin -gt 30) {
  Write-Output "  ⚠️ boot มาเกิน 30 นาทีแล้ว — ถ้าตั้งใจเทสหลัง reboot สดๆ ผลตรงนี้อาจไม่ใช่สภาพหลัง boot จริง"
}

Write-Output "`n=== StartType ต้องเป็น Automatic ทั้ง 3 service (ถึงจะขึ้นเองได้โดยไม่ต้องแตะอะไร) ==="
foreach ($name in @('postgresql-x64-18', 'SiteReqServer', 'Cloudflared')) {
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Output "  $name -> Status=$($svc.Status) / StartType=$($svc.StartType)"
    if ($svc.StartType -ne 'Automatic') { $problems += "$name ไม่ได้ตั้ง StartType=Automatic (ปัจจุบัน=$($svc.StartType)) -> จะไม่ขึ้นเองตอน boot" }
    if ($svc.Status -ne 'Running') { $problems += "$name ไม่ได้ Running (Status=$($svc.Status))" }
  } else {
    Write-Output "  $name -> ไม่พบ service เลย"
    $problems += "ไม่พบ service $name"
  }
}

Write-Output "`n=== ลำดับ postgresql-x64-18 -> SiteReqServer (บังคับด้วย Windows Service dependency) ==="
$dep = (Get-Service SiteReqServer -ErrorAction SilentlyContinue).ServicesDependedOn
if ($dep -and ($dep.Name -contains 'postgresql-x64-18')) {
  Write-Output "  OK: SiteReqServer ตั้ง DependOnService=postgresql-x64-18 จริง (Windows SCM รับประกันลำดับนี้เอง)"
} else {
  Write-Output "  ⚠️ ไม่พบ dependency นี้ — ดู server/docs/nssm-service-setup.md เพื่อตั้งใหม่ (nssm set SiteReqServer DependOnService postgresql-x64-18)"
  $problems += "SiteReqServer ไม่ได้ตั้ง DependOnService=postgresql-x64-18"
}

Write-Output "`n=== รัน health-check.ps1 (เช็คปลายทางจริง: localhost:3000 + build-con.com) ==="
$healthCheckPath = Join-Path $PSScriptRoot 'health-check.ps1'
& $healthCheckPath
if ($LASTEXITCODE -ne 0) { $problems += "health-check.ps1 เจอปัญหา (ดู output ด้านบน)" }

Write-Output "`n================================"
if ($problems.Count -eq 0) {
  Write-Output "ผ่านหมด — reboot แล้วระบบขึ้นเองครบโดยไม่ต้องแตะอะไรเลย"
  Write-Output "⚠️ ยังต้องเช็คจากมือถือ/เน็ตนอกวง (ไม่ใช่เครื่องนี้) ว่า https://build-con.com เข้าได้จริงด้วย — ผลจากเครื่องนี้เจอ DNS cache ของตัวเองบังตาได้"
} else {
  Write-Output "พบ $($problems.Count) ปัญหา:"
  foreach ($p in $problems) { Write-Output "  - $p" }
  exit 1
}
