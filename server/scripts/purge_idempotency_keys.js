// Manual backup for the lazy in-request purge (server.js). Safe to run any time —
// only deletes rows older than the same 7-day window the lazy purge uses.
const pool = require('../db');

async function main() {
  const r = await pool.query(
    `DELETE FROM client_idempotency_keys WHERE created_at < now() - interval '7 days'`
  );
  console.log(`Deleted ${r.rowCount} expired client_idempotency_keys rows (older than 7 days)`);
  await pool.query(`UPDATE client_idempotency_purge_state SET last_purged_at = now() WHERE id = 1`);
  await pool.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
