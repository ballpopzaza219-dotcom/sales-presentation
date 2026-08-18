// Minimal sequential migration runner. Tracks applied versions in `schema_migrations`
// (auto-created). Migrations are plain numbered .up.sql/.down.sql pairs in this folder.
//
// Usage:
//   node migrations/migrate.js status   — list applied vs pending (no lock needed, read-only)
//   node migrations/migrate.js up       — apply all pending migrations, in order, each in its own transaction
//   node migrations/migrate.js down     — roll back only the most-recently-applied migration
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const MIGRATIONS_DIR = __dirname;

// Advisory lock key — an arbitrary fixed bigint identifying "this migration runner" specifically,
// so it can't collide with any other advisory lock this codebase might use elsewhere. Held on a
// single dedicated session (pg_advisory_lock, not the _xact variant) for the whole up()/down() run,
// not scoped to any one transaction — so it stays held across the per-migration BEGIN/COMMIT blocks
// inside up()/down() and is only released when the whole command finishes. Uses pg_try_advisory_lock
// (non-blocking) rather than pg_advisory_lock (blocking) — a second concurrent `up`/`down` invocation
// should fail fast and tell the operator to retry later, not hang indefinitely waiting for the first
// one to finish.
const MIGRATION_LOCK_KEY = 847362951;

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.up.sql'))
    .map(f => f.replace(/\.up\.sql$/, ''))
    .sort();
}

async function appliedVersions() {
  const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(r.rows.map(row => row.version));
}

async function runUp() {
  await ensureTrackingTable();
  const all = listMigrations();
  const applied = await appliedVersions();
  const pending = all.filter(v => !applied.has(v));
  if (pending.length === 0) {
    console.log('ไม่มี migration ค้าง (up to date)');
    return;
  }
  for (const version of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${version}.up.sql`), 'utf8');
    console.log(`Applying ${version}...`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log('  OK');
    } catch (err) {
      // ROLLBACK เองก็ล้มเหลวได้ (เช่น connection หลุดพอดี) — ห่อด้วย try/catch กันไม่ให้ error จาก
      // ROLLBACK บังข้อความ error จริงจาก err เดิม (ที่เป็นสาเหตุแท้จริงที่ทำให้ต้อง rollback)
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error(`  คำเตือน: ROLLBACK เองล้มเหลวด้วย: ${rollbackErr.message}`);
      }
      throw new Error(`${version} FAILED: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

async function runDown() {
  await ensureTrackingTable();
  const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  if (r.rowCount === 0) {
    console.log('ไม่มี migration ให้ rollback');
    return;
  }
  const version = r.rows[0].version;
  const downPath = path.join(MIGRATIONS_DIR, `${version}.down.sql`);
  if (!fs.existsSync(downPath)) {
    throw new Error(`ไม่พบไฟล์ ${version}.down.sql — ยกเลิก`);
  }
  const sql = fs.readFileSync(downPath, 'utf8');
  console.log(`Rolling back ${version}...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
    console.log('  OK');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(`  คำเตือน: ROLLBACK เองล้มเหลวด้วย: ${rollbackErr.message}`);
    }
    throw new Error(`${version} rollback FAILED: ${err.message}`);
  } finally {
    client.release();
  }
}

async function runStatus() {
  await ensureTrackingTable();
  const all = listMigrations();
  const applied = await appliedVersions();
  for (const v of all) console.log(`${applied.has(v) ? '[x]' : '[ ]'} ${v}`);
}

async function withMigrationLock(fn) {
  const lockClient = await pool.connect();
  const r = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_KEY]);
  if (!r.rows[0].locked) {
    lockClient.release();
    throw new Error('อีก process กำลังรัน migration อยู่พอดี (advisory lock ถูกถือครองอยู่) — ยกเลิก ลองใหม่ภายหลัง');
  }
  try {
    await fn();
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    lockClient.release();
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'up') await withMigrationLock(runUp);
  else if (cmd === 'down') await withMigrationLock(runDown);
  else if (cmd === 'status') await runStatus(); // read-only, no lock needed
  else {
    console.log('Usage: node migrations/migrate.js <up|down|status>');
    process.exitCode = 1;
  }
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
