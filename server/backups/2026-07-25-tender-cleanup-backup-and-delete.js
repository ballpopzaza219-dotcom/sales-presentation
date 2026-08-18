// One-off cleanup: removes ALL remaining tenders for company 13 (TDR-2569-0011, 0012, 0018, 0019 —
// the last leftover test/demo data from the Tender module rewrite work) plus every linked
// budget/revision/BOQ item/installment, and resets the company's tender-number counter back to 0 so
// the next tender created gets TDR-2569-0001. Exports a full JSON backup of everything before
// deleting, in case restoration is ever needed. Follows the exact same pattern as
// 2026-07-24-tender-cleanup-backup-and-delete.js (same file, extended with client_tender_installments
// and the counter reset, which that earlier pass didn't need).
//
// Context: TDR-2569-0011/0012/0018 were the last 3 pre-existing tenders kept during the Tender List/
// Detail/Budget/BOQ frontend rewrite (2026-07-25) for validating the new UI against real data.
// TDR-2569-0019 was found during this cleanup — not originally listed, but confirmed by the user to
// be the same kind of test data (same naming pattern, "อาคารก่อสร้างบ้านพัก ... ชั้น") and included.
// After this runs, company 13 has zero tenders — the system is meant to start clean.
//
// Run once: cd server && node backups/2026-07-25-tender-cleanup-backup-and-delete.js
// Safe to re-run — the SELECT-then-DELETE-by-id approach is a no-op on a second pass once the rows
// are already gone (tenderNos query will just return nothing left to delete), though the counter
// reset step is skipped on a re-run to avoid re-zeroing a counter that's since been used for real.

const fs = require('fs');
const path = require('path');
const pool = require('../db');

const COMPANY_ID = 13;
const TENDER_NOS_TO_DELETE = ['TDR-2569-0011', 'TDR-2569-0012', 'TDR-2569-0018', 'TDR-2569-0019'];
const BACKUP_PATH = path.join(__dirname, `2026-07-25-tender-cleanup-backup-${Date.now()}.json`);

(async () => {
  const client = await pool.connect();
  try {
    const tendersRes = await client.query(
      `SELECT * FROM client_tenders WHERE company_id=$1 AND tender_no = ANY($2) ORDER BY tender_no`,
      [COMPANY_ID, TENDER_NOS_TO_DELETE]
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
    const installmentsRes = await client.query(`SELECT * FROM client_tender_installments WHERE tender_id = ANY($1)`, [tenderIds]);

    // Safety check, same as the 2026-07-24 pass: nothing else may trace back to a budget we're about
    // to delete as its source_budget_id (would otherwise FK-violate mid-transaction).
    const sourceRefs = await client.query(`SELECT id FROM client_budgets WHERE source_budget_id = ANY($1)`, [budgetIds]);
    if (sourceRefs.rowCount > 0) {
      throw new Error(`Aborting: ${sourceRefs.rowCount} other budget(s) reference one of the target budgets as source_budget_id — resolve that first.`);
    }
    // Extra safety for THIS pass specifically: since this deletes every remaining tender for the
    // company, confirm the target set really is the company's complete tender list — if some other
    // tender exists that isn't in TENDER_NOS_TO_DELETE, abort rather than silently leaving it orphaned
    // relative to a now-reset counter.
    const allCompanyTenders = await client.query(`SELECT tender_no FROM client_tenders WHERE company_id=$1`, [COMPANY_ID]);
    const unexpected = allCompanyTenders.rows.map(r => r.tender_no).filter(no => !TENDER_NOS_TO_DELETE.includes(no));
    if (unexpected.length > 0) {
      throw new Error(`Aborting: company ${COMPANY_ID} has unexpected tender(s) not in the delete list: ${unexpected.join(', ')} — resolve that first (this script intends to zero the company's tender count).`);
    }

    const backup = {
      exportedAt: new Date().toISOString(),
      note: 'Backup of tenders/budgets/revisions/items/installments deleted by 2026-07-25-tender-cleanup-backup-and-delete.js — final cleanup after the Tender List/Detail/Budget/BOQ frontend rewrite, company 13 reset to zero tenders.',
      client_tenders: tendersRes.rows,
      client_budgets: budgetsRes.rows,
      client_budget_revisions: revisionsRes.rows,
      client_budget_items: itemsRes.rows,
      client_tender_installments: installmentsRes.rows,
    };
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`Backup written: ${BACKUP_PATH}`);
    console.log(`  ${tendersRes.rowCount} tenders, ${budgetsRes.rowCount} budgets, ${revisionsRes.rowCount} revisions, ${itemsRes.rowCount} items, ${installmentsRes.rowCount} installments backed up.`);

    await client.query('BEGIN');
    let deletedItems = 0, deletedRevisions = 0, deletedBudgets = 0, deletedInstallments = 0, deletedTenders = 0;
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
    const dInst = await client.query('DELETE FROM client_tender_installments WHERE tender_id = ANY($1)', [tenderIds]);
    deletedInstallments = dInst.rowCount;
    const dTenders = await client.query('DELETE FROM client_tenders WHERE id = ANY($1)', [tenderIds]);
    deletedTenders = dTenders.rowCount;

    // Reset the tender-number counter so the next tender created gets TDR-2569-0001. nextDocumentSeq
    // (server.js) does `next_seq = next_seq + 1` then returns it (or inserts next_seq=1 and returns 1
    // if no row exists yet) — so setting the existing row to 0 makes the next call's increment land on
    // 1, exactly like a fresh company that's never created a tender.
    const counterUpdate = await client.query(
      `UPDATE company_document_counters SET next_seq=0 WHERE company_id=$1 AND doc_type='tender' RETURNING next_seq`,
      [COMPANY_ID]
    );
    const counterReset = counterUpdate.rowCount > 0;

    await client.query('COMMIT');

    console.log('\n--- DELETE REPORT ---');
    console.log(`client_budget_items:          ${deletedItems} rows deleted`);
    console.log(`client_budget_revisions:      ${deletedRevisions} rows deleted`);
    console.log(`client_budgets:               ${deletedBudgets} rows deleted`);
    console.log(`client_tender_installments:   ${deletedInstallments} rows deleted`);
    console.log(`client_tenders:                ${deletedTenders} rows deleted`);
    console.log(`company_document_counters:    ${counterReset ? 'reset to next_seq=0 (next tender -> TDR-2569-0001)' : 'no existing row found for company/tender — nothing to reset (next tender will start at TDR-2569-0001 anyway, via the INSERT branch)'}`);

    // Post-checks.
    const remainingTenders = await pool.query(`SELECT count(*)::int AS n FROM client_tenders WHERE company_id=$1`, [COMPANY_ID]);
    console.log(`\nPost-check: remaining client_tenders for company ${COMPANY_ID}: ${remainingTenders.rows[0].n} (expect 0)`);

    const orphanBudgets = await pool.query(`SELECT count(*)::int AS n FROM client_budgets cb WHERE cb.tender_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM client_tenders ct WHERE ct.id=cb.tender_id)`);
    console.log(`Post-check: orphan client_budgets (tender_id set but no matching tender): ${orphanBudgets.rows[0].n} (expect 0)`);

    const orphanRevisions = await pool.query(`SELECT count(*)::int AS n FROM client_budget_revisions cbr WHERE NOT EXISTS (SELECT 1 FROM client_budgets cb WHERE cb.id=cbr.budget_id)`);
    console.log(`Post-check: orphan client_budget_revisions (no matching budget): ${orphanRevisions.rows[0].n} (expect 0)`);

    const orphanItems = await pool.query(`SELECT count(*)::int AS n FROM client_budget_items cbi WHERE NOT EXISTS (SELECT 1 FROM client_budget_revisions cbr WHERE cbr.id=cbi.revision_id)`);
    console.log(`Post-check: orphan client_budget_items (no matching revision): ${orphanItems.rows[0].n} (expect 0)`);

    const orphanInstallments = await pool.query(`SELECT count(*)::int AS n FROM client_tender_installments cti WHERE NOT EXISTS (SELECT 1 FROM client_tenders ct WHERE ct.id=cti.tender_id)`);
    console.log(`Post-check: orphan client_tender_installments (no matching tender): ${orphanInstallments.rows[0].n} (expect 0)`);

    const otherCompaniesTenders = await pool.query(`SELECT company_id, count(*)::int AS n FROM client_tenders WHERE company_id != $1 GROUP BY company_id`, [COMPANY_ID]);
    console.log(`Post-check: tenders belonging to OTHER companies (must be unaffected — expect empty list, since company 13 was the only company with any tenders): ${JSON.stringify(otherCompaniesTenders.rows)}`);

    const finalCounter = await pool.query(`SELECT * FROM company_document_counters WHERE company_id=$1 AND doc_type='tender'`, [COMPANY_ID]);
    console.log(`Post-check: company_document_counters row now: ${JSON.stringify(finalCounter.rows)}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
