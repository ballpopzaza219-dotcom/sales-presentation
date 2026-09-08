# สำรองข้อมูล PostgreSQL (sitereq_db) อัตโนมัติรายวัน — เก็บที่ C:\SiteReqBackups (NTFS, ACL จำกัดเฉพาะ
# SYSTEM/Administrators/user ปัจจุบันเท่านั้น — ดูเหตุผลที่ย้ายจาก D: ในคอมเมนต์ท้ายไฟล์นี้และใน
# server/docs/database-backup-setup.md) เก็บย้อนหลัง 30 วัน (ลบไฟล์เกินอายุอัตโนมัติ) ใช้รูปแบบ
# pg_dump -Fc (custom format บีบอัดในตัว กู้คืนด้วย pg_restore ได้ตรงๆ ไม่ต้องแตกไฟล์ก่อน)
#
# ไม่รวม pg_dumpall -g (role/password ระดับ cluster) ในสคริปต์นี้โดยตั้งใจ — ต้องใช้สิทธิ์ postgres
# (superuser) ซึ่งไม่คุ้มที่จะฝากรหัสผ่านไว้ถาวรในไฟล์เพื่อแลกกับการอัตโนมัติสิ่งที่เปลี่ยนน้อยมาก (role/
# password) ดูสคริปต์แยก server/scripts/backup-globals.ps1 (รันมือทุกเดือน ไม่เก็บรหัสผ่านที่ไหนเลย)
#
# โหลดค่าเชื่อมต่อ DB จาก server\.env ด้วย path สัมบูรณ์อิง $PSScriptRoot เสมอ (CLAUDE.md ข้อ 16 หลักการ
# เดียวกับสคริปต์ Node — ห้ามพึ่ง cwd ที่รันคำสั่งนี้จากโฟลเดอร์ไหนก็ตาม)
#
# รหัสผ่านไม่เก็บในสคริปต์นี้เลย — ใช้ไฟล์ .pgpass มาตรฐานของ PostgreSQL แทน (%APPDATA%\postgresql\
# pgpass.conf บน Windows) สคริปต์นี้แค่ sync บรรทัดของ sitereq_app เข้าไฟล์นั้นจาก .env ให้อัตโนมัติทุกครั้ง
# ที่รัน (ไม่ต้องตั้งมือ) — sitereq_app เป็น role ขอบเขตจำกัด (ไม่ใช่ superuser) ความเสี่ยงจากการ persist
# รหัสผ่านนี้เท่ากับที่ .env เก็บอยู่แล้วในเครื่องเดียวกัน ไม่ได้เพิ่ม attack surface ใหม่
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

$BackupDir = 'C:\SiteReqBackups'
$RetentionDays = 30
$pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter 'pg_dump.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $pgDump) { Write-Error 'ไม่พบ pg_dump.exe — ตรวจสอบการติดตั้ง PostgreSQL'; exit 1 }

# สร้างโฟลเดอร์ + ล็อก ACL เฉพาะ SYSTEM/Administrators/user ปัจจุบันเท่านั้น (เฉพาะตอนสร้างครั้งแรก — ถ้ามี
# อยู่แล้วไม่แตะ ACL ซ้ำทุกรอบ กันกรณี admin ปรับเพิ่มเองภายหลังแล้วสคริปต์ไปรีเซ็ตทับ)
if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -Path $BackupDir -AclObject $acl
}

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
$logFile = Join-Path $BackupDir 'backup-log.txt'

try {
  & $pgDump -h $envVars['PGHOST'] -p $envVars['PGPORT'] -U $envVars['PGUSER'] -d $envVars['PGDATABASE'] -Fc -f $backupFile
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exit code $LASTEXITCODE" }

  $sizeBytes = (Get-Item $backupFile).Length
  if ($sizeBytes -lt 1024) { throw "ไฟล์ backup เล็กผิดปกติ ($sizeBytes bytes) — น่าจะพังกลางทาง" }

  $successMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK - $backupFile ($([math]::Round($sizeBytes/1MB,2)) MB)"
  Add-Content -Path $logFile -Value $successMsg -Encoding utf8
  Write-Output $successMsg

  # ก๊อปสำเนาที่สองไปไดรฟ์อื่น (D:) นอกเหนือจาก C: ที่เก็บ Postgres data อยู่แล้ว — ป้องกันกรณีดิสก์ C:
  # เสียทั้งลูก (ซึ่งจะพา backup ที่อยู่ดิสก์เดียวกันหายไปด้วย ไม่ต่างจากไม่มี backup เลย) D: เป็น USB
  # removable FAT32 (ตั้ง ACL จำกัดสิทธิ์ไม่ได้ — ดู database-backup-setup.md) จึงไม่ใช่ที่เก็บหลักที่ปลอดภัย
  # พอสำหรับข้อมูลลูกค้า แต่เป็นสำเนาสำรองสำรอง (defense against disk failure, ไม่ใช่ access control) ยัง
  # ดีกว่าไม่มีเลย — soft-fail ถ้าถอด USB ออกไปแล้ว ไม่ทำให้ backup หลักที่สำเร็จแล้วถูกนับเป็น FAILED
  try {
    $secondaryDir = 'D:\SiteReqBackups'
    if (-not (Test-Path $secondaryDir)) { New-Item -ItemType Directory -Path $secondaryDir -Force | Out-Null }
    Copy-Item -Path $backupFile -Destination $secondaryDir -Force
    $secondaryMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK (secondary copy) - $(Join-Path $secondaryDir (Split-Path $backupFile -Leaf))"
    Add-Content -Path $logFile -Value $secondaryMsg -Encoding utf8
    Write-Output $secondaryMsg
    Get-ChildItem -Path $secondaryDir -Filter 'sitereq_db_*.dump' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
      ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  } catch {
    $secondaryWarnMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') WARN (secondary copy) - ก๊อปไป D: ไม่สำเร็จ: $($_.Exception.Message) (ไม่กระทบ backup หลักบน C: ซึ่งสำเร็จแล้ว — เช็คว่า USB เสียบอยู่ไหม)"
    Add-Content -Path $logFile -Value $secondaryWarnMsg -Encoding utf8
    Write-Warning $secondaryWarnMsg
  }

  # ลบไฟล์ backup (ทั้งสองชนิด — sitereq_db_*.dump รายวันจากสคริปต์นี้ และ sitereq_globals_*.sql รายเดือน
  # จาก backup-globals.ps1) ที่เก่าเกิน $RetentionDays วัน — รวมไว้จุดเดียวกันเพื่อไม่ต้องซ้ำ logic retention
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
