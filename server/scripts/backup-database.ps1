# สำรองข้อมูล PostgreSQL (sitereq_db) อัตโนมัติรายวัน — เก็บไว้ที่ไดรฟ์ D: (ไม่ใช่ C:) ตามที่ฝ่ายบัญชี
# ระบุไว้ชัดเจน เก็บย้อนหลัง 30 วัน (ลบไฟล์เกินอายุอัตโนมัติ) ใช้รูปแบบ pg_dump -Fc (custom format บีบอัด
# ในตัว กู้คืนด้วย pg_restore ได้ตรงๆ ไม่ต้องแตกไฟล์ก่อน) + pg_dumpall -g (เฉพาะ role/password ระดับ
# cluster — pg_dump -Fc ของฐานข้อมูลเดียวไม่เก็บส่วนนี้เลย ถ้า cluster พังทั้งชุดต้องมีทั้งคู่ถึงกู้คืน
# role/สิทธิ์เดิมได้ครบ ไม่ใช่แค่ตัวข้อมูล) — รันทุกครั้งที่ backup หลัก (ไฟล์เล็กมาก ไม่คุ้มทำ schedule แยก)
#
# โหลดค่าเชื่อมต่อ DB จาก server\.env ด้วย path สัมบูรณ์อิง $PSScriptRoot เสมอ (CLAUDE.md ข้อ 16 หลักการ
# เดียวกับสคริปต์ Node — ห้ามพึ่ง cwd ที่รันคำสั่งนี้จากโฟลเดอร์ไหนก็ตาม)
#
# รหัสผ่านไม่เก็บในสคริปต์นี้เลย — ใช้ไฟล์ .pgpass มาตรฐานของ PostgreSQL แทน (%APPDATA%\postgresql\
# pgpass.conf บน Windows) สคริปต์นี้แค่ sync บรรทัดของ sitereq_app เข้าไฟล์นั้นจาก .env ให้อัตโนมัติทุกครั้ง
# ที่รัน (ไม่ต้องตั้งมือ) แล้วเรียก pg_dump/pg_dumpall โดยไม่ตั้ง PGPASSWORD environment variable เลย —
# ลด exposure ของรหัสผ่านที่อาจติดอยู่ใน process environment ของ child process แม้จะ scope ไว้ใน
# try/finally อยู่แล้วก็ตาม
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
$pgDumpAll = Join-Path (Split-Path $pgDump) 'pg_dumpall.exe'
if (-not (Test-Path $pgDumpAll)) { Write-Error "ไม่พบ pg_dumpall.exe ที่ $pgDumpAll"; exit 1 }

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

# sync บรรทัดของ sitereq_app เข้า .pgpass เสมอ (สร้างไฟล์/โฟลเดอร์ถ้ายังไม่มี) — รูปแบบ:
# hostname:port:database:username:password (ใช้ * แทน database เพื่อให้ครอบคลุมทั้ง sitereq_db เอง
# และ database อื่นที่ role เดียวกันอาจต้องต่อในอนาคต)
$pgpassDir = Join-Path $env:APPDATA 'postgresql'
if (-not (Test-Path $pgpassDir)) { New-Item -ItemType Directory -Path $pgpassDir -Force | Out-Null }
$pgpassPath = Join-Path $pgpassDir 'pgpass.conf'
$pgpassLine = "$($envVars['PGHOST']):$($envVars['PGPORT']):*:$($envVars['PGUSER']):$($envVars['PGPASSWORD'])"
$existingLines = @()
if (Test-Path $pgpassPath) { $existingLines = Get-Content $pgpassPath | Where-Object { $_ -notmatch [regex]::Escape(":$($envVars['PGUSER']):") } }
Set-Content -Path $pgpassPath -Value ($existingLines + $pgpassLine) -Encoding ascii

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupFile = Join-Path $BackupDir "sitereq_db_$timestamp.dump"
$globalsFile = Join-Path $BackupDir "sitereq_globals_$timestamp.sql"
$logFile = Join-Path $BackupDir 'backup-log.txt'

try {
  & $pgDump -h $envVars['PGHOST'] -p $envVars['PGPORT'] -U $envVars['PGUSER'] -d $envVars['PGDATABASE'] -Fc -f $backupFile
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exit code $LASTEXITCODE" }

  $sizeBytes = (Get-Item $backupFile).Length
  if ($sizeBytes -lt 1024) { throw "ไฟล์ backup เล็กผิดปกติ ($sizeBytes bytes) — น่าจะพังกลางทาง" }

  $successMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK - $backupFile ($([math]::Round($sizeBytes/1MB,2)) MB)"
  Add-Content -Path $logFile -Value $successMsg -Encoding utf8
  Write-Output $successMsg

  # pg_dumpall -g: เฉพาะ role definitions + password hash ระดับ cluster (ไม่รวมข้อมูลตาราง — pg_dump
  # ข้างบนจัดการส่วนนั้นแล้ว) จำเป็นสำหรับ disaster recovery แบบเต็มรูปแบบ (เครื่องใหม่ล้วนๆ) ที่ role
  # sitereq_app เองก็ต้องถูกสร้างใหม่ก่อนถึงจะ restore ตัวข้อมูลกลับเข้าไปได้ — แยก try/catch ของตัวเอง
  # ไม่ให้พังแล้วทำให้ backup ตัวข้อมูลหลัก (ที่สำเร็จไปแล้วข้างบน) ถูกนับเป็น FAILED ไปด้วย เพราะ
  # pg_dumpall -g ต้องอ่าน pg_authid (มี password hash อยู่) ซึ่ง Postgres สงวนสิทธิ์ไว้ให้ superuser
  # เท่านั้นโดยออกแบบมาตั้งใจ — role ของแอป (sitereq_app) ที่ไม่ใช่ superuser จะเจอ "permission denied
  # for table pg_authid" เสมอ จนกว่าจะมี credential ของ role ที่มีสิทธิ์อ่านตรงนี้ได้ (เช่น postgres)
  try {
    & $pgDumpAll -h $envVars['PGHOST'] -p $envVars['PGPORT'] -U $envVars['PGUSER'] -g -f $globalsFile
    if ($LASTEXITCODE -ne 0) { throw "pg_dumpall -g exit code $LASTEXITCODE" }
    $globalsSizeBytes = (Get-Item $globalsFile).Length
    if ($globalsSizeBytes -lt 10) { throw "ไฟล์ globals เล็กผิดปกติ ($globalsSizeBytes bytes)" }
    $globalsMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK (globals) - $globalsFile ($globalsSizeBytes bytes)"
    Add-Content -Path $logFile -Value $globalsMsg -Encoding utf8
    Write-Output $globalsMsg
  } catch {
    Remove-Item $globalsFile -Force -ErrorAction SilentlyContinue
    $globalsWarnMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') WARN (globals) - pg_dumpall -g ไม่สำเร็จ: $($_.Exception.Message) (ไม่กระทบ backup ตัวข้อมูลหลักข้างบนซึ่งสำเร็จแล้ว — ต้องตั้ง credential ของ role ที่มีสิทธิ์อ่าน pg_authid เช่น postgres ก่อนถึงจะทำงานได้)"
    Add-Content -Path $logFile -Value $globalsWarnMsg -Encoding utf8
    Write-Warning $globalsWarnMsg
  }

  # ลบไฟล์ backup (ทั้งสองชนิด) ที่เก่าเกิน $RetentionDays วัน
  Get-ChildItem -Path $BackupDir -Filter 'sitereq_db_*.dump' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    ForEach-Object {
      Remove-Item $_.FullName -Force
      Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ลบไฟล์เก่า: $($_.Name)" -Encoding utf8
    }
  Get-ChildItem -Path $BackupDir -Filter 'sitereq_globals_*.sql' |
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
}
