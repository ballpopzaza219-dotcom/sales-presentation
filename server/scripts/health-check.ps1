# ตรวจสุขภาพทั้งระบบทีเดียว (PostgreSQL, SiteReqServer, Cloudflared, localhost:3000) — รันได้ทุกเมื่อ
# ไม่ต้อง Administrator แนะนำให้รันหลังทำอะไรก็ตามกับ service ไหนก็ตาม (restart, debug foreground,
# rotate token ฯลฯ) เพื่อจับเคส "ลืม Start-Service กลับ" แบบที่เจอจริงกับ Cloudflared (ดู
# server/docs/cloudflared-tunnel-setup.md หัวข้อ Error 1033)
#
# Usage: powershell -File server\scripts\health-check.ps1

$ErrorActionPreference = 'Continue'
$problems = @()

Write-Output "=== PostgreSQL (postgresql-x64-18) ==="
$pg = Get-Service postgresql-x64-18 -ErrorAction SilentlyContinue
if ($pg) {
  Write-Output "  Status: $($pg.Status) / StartType: $($pg.StartType)"
  if ($pg.Status -ne 'Running') { $problems += "postgresql-x64-18 ไม่ได้ Running (Status=$($pg.Status))" }
} else {
  Write-Output "  ไม่พบ service — เช็คว่าติดตั้ง PostgreSQL แล้วหรือยัง"
  $problems += "ไม่พบ service postgresql-x64-18"
}

Write-Output "`n=== Node server (SiteReqServer) ==="
$node = Get-Service SiteReqServer -ErrorAction SilentlyContinue
if ($node) {
  Write-Output "  Status: $($node.Status) / StartType: $($node.StartType)"
  if ($node.Status -ne 'Running') { $problems += "SiteReqServer ไม่ได้ Running (Status=$($node.Status))" }
} else {
  Write-Output "  ไม่พบ service — ดู server/docs/nssm-service-setup.md"
  $problems += "ไม่พบ service SiteReqServer"
}

Write-Output "`n=== Cloudflare Tunnel (Cloudflared) ==="
$cf = Get-Service Cloudflared -ErrorAction SilentlyContinue
if ($cf) {
  Write-Output "  Status: $($cf.Status) / StartType: $($cf.StartType)"
  if ($cf.Status -ne 'Running') { $problems += "Cloudflared ไม่ได้ Running (Status=$($cf.Status)) -> build-con.com จะขึ้น Error 1033" }
} else {
  Write-Output "  ไม่พบ service — ดู server/docs/cloudflared-tunnel-setup.md"
  $problems += "ไม่พบ service Cloudflared"
}

Write-Output "`n=== localhost:3000 ==="
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/" -UseBasicParsing -TimeoutSec 10
  Write-Output "  STATUS: $($r.StatusCode)"
  if ($r.StatusCode -ne 200) { $problems += "localhost:3000 ตอบ status $($r.StatusCode) ไม่ใช่ 200" }
} catch {
  Write-Output "  ERROR: $($_.Exception.Message)"
  $problems += "localhost:3000 เชื่อมต่อไม่ได้เลย: $($_.Exception.Message)"
}

Write-Output "`n=== build-con.com (จากเครื่องนี้ — ทดสอบให้ชัวร์ต้องเช็คจากมือถือ/เน็ตนอกวงด้วย) ==="
try {
  $r = Invoke-WebRequest -Uri "https://build-con.com/" -UseBasicParsing -TimeoutSec 15
  Write-Output "  STATUS: $($r.StatusCode)"
  if ($r.StatusCode -ne 200) { $problems += "build-con.com ตอบ status $($r.StatusCode) ไม่ใช่ 200" }
} catch {
  Write-Output "  ERROR: $($_.Exception.Message)"
  $problems += "build-con.com เชื่อมต่อไม่ได้เลย: $($_.Exception.Message)"
}

Write-Output "`n=== พื้นที่ดิสก์ ==="
$diskWarnGB = 20
try {
  $drives = Get-PSDrive -PSProvider FileSystem -ErrorAction Stop
  foreach ($d in $drives) {
    $freeGB = [math]::Round($d.Free / 1GB, 1)
    Write-Output "  $($d.Name): เหลือว่าง $freeGB GB"
    if ($freeGB -lt $diskWarnGB) { $problems += "ไดรฟ์ $($d.Name): เหลือว่างแค่ $freeGB GB (ต่ำกว่าเกณฑ์เตือน $diskWarnGB GB)" }
  }
} catch {
  Write-Output "  ERROR: เช็คพื้นที่ดิสก์ไม่ได้: $($_.Exception.Message)"
}

Write-Output "`n================================"
if ($problems.Count -eq 0) {
  Write-Output "ทุกอย่างปกติ — ไม่พบปัญหา"
  exit 0
} else {
  Write-Output "พบ $($problems.Count) ปัญหา:"
  foreach ($p in $problems) { Write-Output "  - $p" }
  exit 1
}
