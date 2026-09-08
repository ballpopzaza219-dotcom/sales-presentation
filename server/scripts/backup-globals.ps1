# สำรอง role/password ระดับ cluster (pg_dumpall -g) — รันมือเดือนละครั้งก็พอ (role/password ของระบบนี้
# เปลี่ยนน้อยมาก ไม่คุ้มที่จะฝากรหัสผ่าน superuser ไว้ถาวรในไฟล์เพื่อแลกกับการอัตโนมัติ) — pg_dump รายวัน
# ของฐานข้อมูลเดียว (backup-database.ps1) ไม่เก็บส่วนนี้เลย ถ้า cluster พังทั้งชุดต้องมีทั้งคู่ถึงจะกู้คืน
# role/สิทธิ์เดิมได้ครบ ไม่ใช่แค่ตัวข้อมูล
#
# ต้องใช้สิทธิ์ superuser (เช่น postgres) เพราะ pg_dumpall -g อ่านตาราง pg_authid (มี password hash อยู่)
# ซึ่ง Postgres สงวนไว้ให้ superuser เท่านั้นโดยตั้งใจ — ไม่มี predefined role ไหนให้สิทธิ์อ่านบางส่วนได้เลย
# (ตรวจสอบแล้วจริงจากการรันจริง ไม่ใช่แค่อ่านเอกสาร) — สคริปต์นี้จึง "พิมพ์รหัสผ่านสดทุกครั้งที่รัน" ผ่าน
# prompt ของ pg_dumpall เอง ไม่เก็บรหัสผ่าน superuser ไว้ที่ไหนเลยแม้แต่ .pgpass (ต่างจาก
# backup-database.ps1 ที่ sitereq_app เป็น role ขอบเขตจำกัด เก็บใน .pgpass ได้โดยความเสี่ยงเท่าที่ .env
# มีอยู่แล้ว — แต่ postgres เป็น superuser เต็มรูปแบบ ไม่ควร persist ไว้เลยถ้าไม่จำเป็นจริงๆ)
#
# Usage (รันมือ ไม่ผูก Scheduled Task):
#   powershell -File server\scripts\backup-globals.ps1
#   -> จะถาม username (default: postgres) แล้วให้พิมพ์รหัสผ่านสด (ไม่ echo ขึ้นจอ)

$ErrorActionPreference = 'Stop'

$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envPath)) { Write-Error "ไม่พบไฟล์ .env ที่ $envPath"; exit 1 }
$envVars = @{}
Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $envVars[$matches[1]] = $matches[2]
  }
}
foreach ($key in @('PGHOST','PGPORT')) {
  if (-not $envVars.ContainsKey($key) -or [string]::IsNullOrEmpty($envVars[$key])) {
    Write-Error "ไม่พบค่า $key ใน .env — หยุดทำงานทันที"
    exit 1
  }
}

$BackupDir = 'C:\SiteReqBackups'
if (-not (Test-Path $BackupDir)) { Write-Error "ไม่พบโฟลเดอร์ $BackupDir — รัน backup-database.ps1 อย่างน้อย 1 ครั้งก่อน (สร้างโฟลเดอร์ + ตั้ง ACL ให้)"; exit 1 }

$pgDumpAll = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter 'pg_dumpall.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $pgDumpAll) { Write-Error 'ไม่พบ pg_dumpall.exe — ตรวจสอบการติดตั้ง PostgreSQL'; exit 1 }

$superuser = Read-Host "Superuser role (Enter = postgres)"
if ([string]::IsNullOrWhiteSpace($superuser)) { $superuser = 'postgres' }

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$globalsFile = Join-Path $BackupDir "sitereq_globals_$timestamp.sql"
$logFile = Join-Path $BackupDir 'backup-log.txt'

Write-Output "จะขอรหัสผ่านของ role '$superuser' ต่อไป (พิมพ์แล้ว Enter — จะไม่ถูกเก็บไว้ที่ไหนหลังสคริปต์นี้จบ)"
& $pgDumpAll -h $envVars['PGHOST'] -p $envVars['PGPORT'] -U $superuser -W -g -f $globalsFile
if ($LASTEXITCODE -ne 0) {
  $errorMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FAILED (globals, manual) - pg_dumpall -g exit code $LASTEXITCODE"
  Add-Content -Path $logFile -Value $errorMsg -Encoding utf8
  Write-Error $errorMsg
  exit 1
}
$sizeBytes = (Get-Item $globalsFile).Length
if ($sizeBytes -lt 10) {
  Remove-Item $globalsFile -Force -ErrorAction SilentlyContinue
  Write-Error "ไฟล์ globals เล็กผิดปกติ ($sizeBytes bytes) — น่าจะพังกลางทาง"
  exit 1
}
$successMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK (globals, manual) - $globalsFile ($sizeBytes bytes)"
Add-Content -Path $logFile -Value $successMsg -Encoding utf8
Write-Output $successMsg
Write-Output "เสร็จแล้ว — เตือนตัวเองให้รันสคริปต์นี้อีกครั้งใน ~30 วัน (health-check.ps1 จะเตือนถ้าเลยกำหนด)"
