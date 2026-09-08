// Regression suite — verifies the 3 journal-entry insert points identified in known-limitations ข.9
// that never passed project_id (advance-clearance approve, advance-clearance settle, petty-cash
// replenishment approve) now correctly resolve it from their source document (voucher/fund) and store
// it on the resulting client_journal_entries row. Before this fix these journals always had
// project_id=NULL even when the source document was tied to a real project.
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/journal-project-id-linkage.regression.js
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {};
async function call(username, method, urlPath, body, idempotencyKey) {
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }
function bangkokToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); }

(async () => {
  const cleanup = { voucherIds: [], clearanceIds: [], fundIds: [], replenishmentIds: [], projectIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    for (const u of ['fx_maker', 'fx_approver_mid', 'fx_settler', 'fx_super']) await login(u, codeA);

    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E project_id-journal-linkage ' + Date.now(), sectorType: 'private', status: 'in_progress' });
    cleanup.projectIds.push(proj.project.id);

    // ============================================================================================
    // (A) petty-cash-replenishments /approve — journal ต้องมี project_id ตรงกับกองทุนต้นทาง
    // ============================================================================================
    console.log('\n=== (A) petty-cash-replenishments /approve ===');
    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'E2E project-linked fund ' + Date.now(), projectId: proj.project.id, fundLimit: 50000 });
    cleanup.fundIds.push(fund.fund.id);
    const repl = await call('fx_maker', 'POST', '/api/customer/petty-cash-replenishments', { fundId: fund.fund.id, amount: 3000, note: 'E2E project_id linkage test' }, idemKey('pjid-repl-create'));
    cleanup.replenishmentIds.push(repl.replenishment.id);
    await call('fx_maker', 'POST', `/api/customer/petty-cash-replenishments/${repl.replenishment.id}/submit`, {}, idemKey('pjid-repl-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/petty-cash-replenishments/${repl.replenishment.id}/approve`, {}, idemKey('pjid-repl-approve'));

    const replJournal = await pool.query(`SELECT project_id FROM client_journal_entries WHERE source_type='petty_cash_replenishment' AND source_id=$1`, [repl.replenishment.id]);
    assert(replJournal.rowCount === 1, 'พบ journal entry ของการเติมเงินกองทุนนี้จริง 1 รายการ');
    assert(replJournal.rows[0].project_id === proj.project.id, `journal ของเติมเงินกองทุนมี project_id ตรงกับกองทุนต้นทาง (ได้ ${replJournal.rows[0].project_id} คาดหวัง ${proj.project.id})`);

    // กองทุนที่ไม่ผูกโครงการ (projectId ไม่ระบุตอนสร้าง) -> journal ต้องเป็น NULL แบบตั้งใจ (พิสูจน์ว่า
    // โค้ดอ่านค่าจริงจากกองทุนต้นทางเสมอ ไม่ใช่ hardcode ค่าคงที่บางอย่างที่บังเอิญตรงกับเคสข้างบน)
    const fundNoProject = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'E2E no-project fund ' + Date.now(), fundLimit: 50000 });
    cleanup.fundIds.push(fundNoProject.fund.id);
    const replNoProject = await call('fx_maker', 'POST', '/api/customer/petty-cash-replenishments', { fundId: fundNoProject.fund.id, amount: 2000, note: 'E2E project_id linkage test (no project)' }, idemKey('pjid-repl2-create'));
    cleanup.replenishmentIds.push(replNoProject.replenishment.id);
    await call('fx_maker', 'POST', `/api/customer/petty-cash-replenishments/${replNoProject.replenishment.id}/submit`, {}, idemKey('pjid-repl2-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/petty-cash-replenishments/${replNoProject.replenishment.id}/approve`, {}, idemKey('pjid-repl2-approve'));
    const replJournal2 = await pool.query(`SELECT project_id FROM client_journal_entries WHERE source_type='petty_cash_replenishment' AND source_id=$1`, [replNoProject.replenishment.id]);
    assert(replJournal2.rows[0].project_id === null, `กองทุนที่ไม่ผูกโครงการ -> journal เป็น NULL แบบตั้งใจ (ได้ ${replJournal2.rows[0].project_id})`);

    // ============================================================================================
    // (B) advance-clearances /approve และ /settle — journal ทั้งสองจุดต้องมี project_id ตรงกับ voucher
    // ต้นทาง (มีความแตกต่างของยอดเพื่อบังคับให้เกิดสถานะ 'approved' รอ /settle จริง ไม่ auto-settled)
    // ============================================================================================
    console.log('\n=== (B) advance-clearances /approve และ /settle ===');
    const advVoucher = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'advance', payeeEmployeeId: 2, projectId: proj.project.id, purpose: 'E2E project_id linkage advance', amount: 5000,
    }, idemKey('pjid-advv-create'));
    cleanup.voucherIds.push(advVoucher.voucher.id);
    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${advVoucher.voucher.id}/submit`, {}, idemKey('pjid-advv-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${advVoucher.voucher.id}/approve`, {}, idemKey('pjid-advv-approve'));

    const clearanceCreate = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: advVoucher.voucher.id,
      items: [{ description: 'ค่าวัสดุเบ็ดเตล็ด E2E project_id', expenseAccountCode: '5100', amount: 4500, payeeName: 'ร้านวัสดุทดสอบ project_id' }],
    }, idemKey('pjid-advcl-create'));
    const clearance = clearanceCreate.clearance;
    cleanup.clearanceIds.push(clearance.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance.id}/submit`, {}, idemKey('pjid-advcl-submit'));
    const approved = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance.id}/approve`, {}, idemKey('pjid-advcl-approve'));
    assert(approved.clearance.status === 'approved', `เคลียร์ยอดไม่ตรงกับ voucher (4500 vs 5000) จึงยังเป็น approved รอ /settle จริง (ได้ ${approved.clearance.status})`);

    const approveJournal = await pool.query(`SELECT project_id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id=$1 ORDER BY id LIMIT 1`, [clearance.id]);
    assert(approveJournal.rowCount === 1, 'พบ journal entry ของขั้นตอนอนุมัติเคลียร์เงินทดรองจ่ายจริง');
    assert(approveJournal.rows[0].project_id === proj.project.id, `journal ของขั้นตอนอนุมัติเคลียร์มี project_id ตรงกับ voucher ต้นทาง (ได้ ${approveJournal.rows[0].project_id} คาดหวัง ${proj.project.id})`);

    await call('fx_settler', 'POST', `/api/customer/advance-clearances/${clearance.id}/settle`, {
      settlementDate: bangkokToday(), settlementChannel: 'cash', settlementRef: 'E2E project_id linkage settle',
    }, idemKey('pjid-advcl-settle'));

    const settleJournal = await pool.query(`SELECT project_id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id=$1 ORDER BY id DESC LIMIT 1`, [clearance.id]);
    assert(settleJournal.rows[0].project_id === proj.project.id, `journal ของขั้นตอนชำระส่วนต่างมี project_id ตรงกับ voucher ต้นทางเช่นกัน (ได้ ${settleJournal.rows[0].project_id} คาดหวัง ${proj.project.id})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      const { voucherIds, clearanceIds, fundIds, replenishmentIds, projectIds } = cleanup;
      if (clearanceIds.length) {
        const clJournalIds = (await pool.query(`SELECT id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1)`, [clearanceIds])).rows.map(r => r.id);
        if (clJournalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [clJournalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [clJournalIds]);
        }
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='advance_clearance' AND doc_id = ANY($1)`, [clearanceIds]);
        await pool.query('DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [clearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [clearanceIds]);
      }
      if (voucherIds.length) {
        const vJournalIds = (await pool.query(`SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [voucherIds])).rows.map(r => r.id);
        if (vJournalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [vJournalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [vJournalIds]);
        }
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [voucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [voucherIds]);
      }
      if (replenishmentIds.length) {
        const rJournalIds = (await pool.query(`SELECT id FROM client_journal_entries WHERE source_type='petty_cash_replenishment' AND source_id = ANY($1)`, [replenishmentIds])).rows.map(r => r.id);
        if (rJournalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [rJournalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [rJournalIds]);
        }
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='petty_cash_replenishment' AND doc_id = ANY($1)`, [replenishmentIds]);
        await pool.query('DELETE FROM client_petty_cash_replenishments WHERE id = ANY($1)', [replenishmentIds]);
      }
      if (fundIds.length) await pool.query('DELETE FROM client_petty_cash_funds WHERE id = ANY($1)', [fundIds]);
      if (projectIds.length) await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [projectIds]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'pjid-%'`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
