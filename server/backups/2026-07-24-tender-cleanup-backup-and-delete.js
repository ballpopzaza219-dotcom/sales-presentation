// One-off cleanup: removes 10 duplicate-test-data tenders (TDR-2569-0001..0010, excluding 0011/0012
// which are kept per user confirmation) and their linked budgets/revisions/items. Exports a full JSON
// backup of everything before deleting, in case restoration is ever needed.
//
// Context: these tenders/budgets accumulated from repeated manual end-to-end test runs of the BOQ
// import feature during the 2026-07-24 dev session — TDR-2569-0001/0009/0011 are near-identical
// repeated imports of the same source file (item counts 103/94/90 track the evolving isGroup/
// isSummaryRow classification logic across that session), TDR-2569-0002 through 0008 and 0010 are
// empty (0-item) budgets from tests that never got past creation. TDR-2569-0011 is kept as the
// most-recent, most-refined reference/test budget; TDR-2569-0012 is kept because it has real workflow
// activity (submitted for approval) unlike any of the others.
//
// Run once: cd server && node backups/2026-07-24-tender-cleanup-backup-and-delete.js
// Safe to re-run — the SELECT-then-DELETE-by-id approach is a no-op on a second pass once the rows
// are already gone (tenderNos query will just return nothing left to delete).

const fs = require('fs');
const path = require('path');
const pool = require('../db');

const TENDER_NOS_TO_DELETE = [
  'TDR-2569-0001', 'TDR-2569-0002', 'TDR-2569-0003', 'TDR-2569-0004', 'TDR-2569-0005',
  'TDR-2569-0006', 'TDR-2569-0007', 'TDR-2569-0008', 'TDR-2569-0009', 'TDR-2569-0010',
];
const KEEP_TENDER_NOS = ['TDR-2569-0011', 'TDR-2569-0012'];
const BACKUP_PATH = path.join(__dirname, `2026-07-24-tender-cleanup-backup-${Date.now()}.json`);

(async () => {
  const client = await pool.connect();
  try {
    const tendersRes = await client.query(
      `SELECT * FROM client_tenders WHERE tender_no = ANY($1) ORDER BY tender_no`,
      [TENDER_NOS_TO_DELETE]
    );
    const tenderIds = tendersRes.rows.map(r => r.id);
    if (tenderIds.length === 0) {
      console.log('Nothing to delete — no matching tenders found (already cleaned up?).');
      return;
    }

    const budgetsRes = await client.query(`SELECT * FROM client_budgets WHERE tender_id = ANY($1)`, [tenderIds]);
    const budgetIds = budgetsRes.rows.map(r => r.id);
    const revisionsRes = await client.query(`SELECT * FROM client_budget_revisions WHERE budget_id = ANY($1)`, [budgetIds]);
    const revisionIds = revisionsRes.rows.map(r => r.id);
    const itemsRes = await client.query(`SELECT * FROM client_budget_items WHERE revision_id = ANY($1)`, [revisionIds]);

    // Safety check, repeated from the pre-flight query: nothing else may trace back to a budget we're
    // about to delete as its source_budget_id (would otherwise FK-violate mid-transaction).
    const sourceRefs = await client.query(`SELECT id FROM client_budgets WHERE source_budget_id = ANY($1)`, [budgetIds]);
    if (sourceRefs.rowCount > 0) {
      throw new Error(`Aborting: ${sourceRefs.rowCount} other budget(s) reference one of the target budgets as source_budget_id — resolve that first.`);
    }
    const keepers = await client.query(`SELECT id, tender_no FROM client_tenders WHERE tender_no = ANY($1)`, [KEEP_TENDER_NOS]);
    if (keepers.rowCount !== KEEP_TENDER_NOS.length) {
      throw new Error(`Aborting: expected to find both keeper tenders (${KEEP_TENDER_NOS.join(', ')}) untouched, found ${keepers.rowCount}.`);
    }

    const backup = {
      exportedAt: new Date().toISOString(),
      note: 'Backup of tenders/budgets/revisions/items deleted by 2026-07-24-tender-cleanup-backup-and-delete.js',
      client_tenders: tendersRes.rows,
      client_budgets: budgetsRes.rows,
      client_budget_revisions: revisionsRes.rows,
      client_budget_items: itemsRes.rows,
    };
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`Backup written: ${BACKUP_PATH}`);
    console.log(`  ${tendersRes.rowCount} tenders, ${budgetsRes.rowCount} budgets, ${revisionsRes.rowCount} revisions, ${itemsRes.rowCount} items backed up.`);

    await client.query('BEGIN');
    let deletedItems = 0, deletedRevisions = 0, deletedBudgets = 0, deletedTenders = 0;
    for (const budgetId of budgetIds) {
      await client.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id=$1', [budgetId]);
      const revIds = (await client.query('SELECT id FROM client_budget_revisions WHERE budget_id=$1', [budgetId])).rows.map(r => r.id);
      for (const rid of revIds) {
        const d = await client.query('DELETE FROM client_budget_items WHERE revision_id=$1', [rid]);
        deletedItems += d.rowCount;
      }
      const dRev = await client.query('DELETE FROM client_budget_revisions WHERE budget_id=$1', [budgetId]);
      deletedRevisions += dRev.rowCount;
      const dBudget = await client.query('DELETE FROM client_budgets WHERE id=$1', [budgetId]);
      deletedBudgets += dBudget.rowCount;
    }
    const dTenders = await client.query('DELETE FROM client_tenders WHERE id = ANY($1)', [tenderIds]);
    deletedTenders = dTenders.rowCount;
    await client.query('COMMIT');

    console.log('\n--- DELETE REPORT ---');
    console.log(`client_budget_items:     ${deletedItems} rows deleted`);
    console.log(`client_budget_revisions: ${deletedRevisions} rows deleted`);
    console.log(`client_budgets:          ${deletedBudgets} rows deleted`);
    console.log(`client_tenders:          ${deletedTenders} rows deleted`);

    // Post-check: confirm the 2 keepers (and their budgets/items) are fully intact.
    const keptTenders = await pool.query(`SELECT id, tender_no, status FROM client_tenders WHERE tender_no = ANY($1) ORDER BY tender_no`, [KEEP_TENDER_NOS]);
    console.log('\n--- KEEPERS (must still be present) ---');
    for (const t of keptTenders.rows) {
      const b = await pool.query(`SELECT cb.id AS budget_id, count(cbi.id)::int AS item_count FROM client_budgets cb LEFT JOIN client_budget_revisions cbr ON cbr.budget_id=cb.id LEFT JOIN client_budget_items cbi ON cbi.revision_id=cbr.id WHERE cb.tender_id=$1 GROUP BY cb.id`, [t.id]);
      console.log(`  ${t.tender_no} (id=${t.id}, status=${t.status}) -> budget ${JSON.stringify(b.rows)}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
