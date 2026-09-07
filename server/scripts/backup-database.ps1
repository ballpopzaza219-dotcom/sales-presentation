# สำรองข้อมูล PostgreSQL (sitereq_db) อัตโนมัติรายวัน — เก็บไว้ที่ไดรฟ์ D: (ไม่ใช่ C:) ตามที่ฝ่ายบัญชี
# ระบุไว้ชัดเจน เก็บย้อนหลัง 30 วัน (ลบไฟล์เกินอายุอัตโนมัติ) ใช้รูปแบบ pg_dump -Fc (custom format บีบอัด
# ในตัว กู้คืนด้วย pg_restore ได้ตรงๆ ไม่ต้องแตกไฟล์ก่อน)
#
# โหลดค่าเชื่อมต่อ DB จาก server\.env ด้วย path สัมบูรณ์อิง $PSScriptRoot เสมอ (CLAUDE.md ข้อ 16 หลักการ
# เดียวกับสคริปต์ Node — ห้ามพึ่ง cwd ที่รันคำสั่งนี้จากโฟลเดอร์ไหนก็ตาม)
#
# Usage: powershell -File server\scripts\backup-database.ps1
# Scheduled Task: ตั้งให้รันทุกวัน (แนะนำตอนกลางคืน เช่น 02:00) ด้วยสิทธิ์ผู้ใช้ที่มีสิทธิ์เขียนไฟล์ที่ปลายทาง

$ErrorActionPreference = 'Stop'

$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envPath)) { Write-Error "ไม่พบไฟล์ .env ที่ $envPath"; exit 1 }
$envVars = @{}
Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $envVars[$matches[1]] = $matches[2]
  }
}
foreach ($key in @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD')) {
  if (-not $envVars.ContainsKey($key) -or [string]::IsNullOrEmpty($envVars[$key])) {
    Write-Error "ไม่พบค่า $key ใน .env — หยุดทำงานทันที (ห้าม fallback เงียบๆ ไปต่อกับ database อื่น ตาม CLAUDE.md ข้อ 16)"
    exit 1
  }
}

$BackupDir = 'D:\SiteReqBackups'
$RetentionDays = 30
$pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter 'pg_dump.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $pgDump) { Write-Error 'ไม่พบ pg_dump.exe — ตรวจสอบการติดตั้ง PostgreSQL'; exit 1 }

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupFile = Join-Path $BackupDir "sitereq_db_$timestamp.dump"
$logFile = Join-Path $BackupDir 'backup-log.txt'

$env:PGPASSWORD = $envVars['PGPASSWORD']
try {
  & $pgDump -h $envVars['PGHOST'] -p $envVars['PGPORT'] -U $envVars['PGUSER'] -d $envVars['PGDATABASE'] -Fc -f $backupFile
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exit code $LASTEXITCODE" }

  $sizeBytes = (Get-Item $backupFile).Length
  if ($sizeBytes -lt 1024) { throw "ไฟล์ backup เล็กผิดปกติ ($sizeBytes bytes) — น่าจะพังกลางทาง" }

  $successMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK - $backupFile ($([math]::Round($sizeBytes/1MB,2)) MB)"
  Add-Content -Path $logFile -Value $successMsg -Encoding utf8
  Write-Output $successMsg

  # ลบไฟล์ backup ที่เก่าเกิน $RetentionDays วัน
  Get-ChildItem -Path $BackupDir -Filter 'sitereq_db_*.dump' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    ForEach-Object {
      Remove-Item $_.FullName -Force
      Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ลบไฟล์เก่า: $($_.Name)" -Encoding utf8
    }
} catch {
  $errorMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FAILED - $($_.Exception.Message)"
  Add-Content -Path $logFile -Value $errorMsg -Encoding utf8
  Write-Error $errorMsg
  exit 1
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
