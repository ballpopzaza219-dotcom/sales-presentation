// Regression suite — Advance Payment module (หัวข้อ 1.2: เงินทดรองจ่าย, disbursement voucher only —
// clearance/reconciliation is tests/advance-clearance.regression.js).
// Covers: cross-company 404, self-approval block, no_rule/over_ceiling/approve-success, idempotency
// retry, journal balance verification (Dr 1150 ลูกหนี้เงินทดรองจ่าย / Cr 1100 เงินสด).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/advance.regression.js  (or: npm run test:advance)
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const EMPLOYEE_ID = 2;

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
async function callExpectError(username, method, urlPath, body, idempotencyKey) {
  try { await call(username, method, urlPath, body, idempotencyKey); throw new Error(`expected ${method} ${urlPath} (as ${username}) to fail but it succeeded`); }
  catch (e) { if (e.status === undefined) throw e; return e; }
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }

async function makeAdvanceVoucher(username, amount) {
  const data = await call(username, 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'advance', payeeEmployeeId: EMPLOYEE_ID, purpose: 'regression test advance', amount,
  }, idemKey('adv-create'));
  return data.voucher;
}
async function submitVoucher(username, id) {
  return call(username, 'POST', `/api/customer/payment-vouchers/${id}/submit`, {}, idemKey('adv-submit'));
}

(async () => {
  const createdVoucherIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;

    await login('fx_maker', codeA);
    await login('fx_approver_mid', codeA);
    await login('fx_approver_floor', codeA);
    await login('fx_approver_norule', codeA);
    await login('fx_other_co', codeB);

    // ================= 1) no_rule / over_ceiling / approve success =================
    let v1 = await makeAdvanceVoucher('fx_maker', 8000);
    createdVoucherIds.push(v1.id);
    await submitVoucher('fx_maker', v1.id);
    const eNoRule = await callExpectError('fx_approver_norule', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('adv-approve'));
    assert(eNoRule.status === 403 && eNoRule.body.code === 'no_rule', `มี flag can_approve_advance แต่ไม่มี rule -> no_rule (ได้ code ${eNoRule.body.code})`);

    const approveOk = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('adv-approve'));
    assert(approveOk.voucher.status === 'approved', 'อนุมัติสำเร็จภายในเพดาน (8,000 อยู่ในช่วง 0-50,000)');

    let v2 = await makeAdvanceVoucher('fx_maker', 55000);
    createdVoucherIds.push(v2.id);
    await submitVoucher('fx_maker', v2.id);
    const eOverCeiling = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v2.id}/approve`, {}, idemKey('adv-approve'));
    assert(eOverCeiling.status === 403 && eOverCeiling.body.code === 'over_ceiling', `ยอด 55,000 เกินเพดาน 50,000 -> over_ceiling (ได้ code ${eOverCeiling.body.code})`);
    const approveFloorOk = await call('fx_approver_floor', 'POST', `/api/customer/payment-vouchers/${v2.id}/approve`, {}, idemKey('adv-approve'));
    assert(approveFloorOk.voucher.status === 'approved', 'ผู้อนุมัติเพดานสูงกว่า (10,000-200,000) อนุมัติยอดเดียวกันได้');

    // ================= 2) Cross-company 404 =================
    const eCross = await callExpectError('fx_other_co', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('adv-approve-cross'));
    assert(eCross.status === 404, `บริษัทอื่นแตะใบเบิกเงินทดรองจ่ายไม่ได้ 404 (ได้ ${eCross.status})`);

    // ================= 3) Self-approval block =================
    let vSelf = await makeAdvanceVoucher('fx_approver_mid', 1000);
    createdVoucherIds.push(vSelf.id);
    await submitVoucher('fx_approver_mid', vSelf.id);
    const eSelf = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vSelf.id}/approve`, {}, idemKey('adv-approve'));
    assert(eSelf.status === 403 && eSelf.body.code === 'self_approval', `ผู้สร้างอนุมัติใบเบิกเงินทดรองจ่ายของตัวเองไม่ได้ (ได้ code ${eSelf.body.code})`);

    // ================= 4) Idempotency retry =================
    let vIdem = await makeAdvanceVoucher('fx_maker', 3000);
    createdVoucherIds.push(vIdem.id);
    await submitVoucher('fx_maker', vIdem.id);
    const idemApproveKey = idemKey('adv-approve-retry');
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vIdem.id}/approve`, {}, idemApproveKey);
    const retryRes = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vIdem.id}/approve`, {}, idemApproveKey);
    assert(retryRes.voucher.status === 'approved', 'retry approve ด้วย Idempotency-Key เดิม ยังได้ status approved เดิม');
    const journalCountRes = await pool.query(
      `SELECT count(*)::int AS n FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id=$1`,
      [vIdem.id]
    );
    assert(journalCountRes.rows[0].n === 1, `retry ไม่โพสต์ journal entry ซ้ำ (ยังมีแค่ 1 entry ได้ ${journalCountRes.rows[0].n})`);

    // ================= 5) ตรวจยอดบัญชี Dr 1150 (ลูกหนี้เงินทดรองจ่าย) / Cr 1100 (เงินสด) =================
    const linesRes = await pool.query(
      `SELECT l.account_code, l.debit_amount, l.credit_amount FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.source_type='payment_voucher' AND e.source_id=$1 ORDER BY l.id`,
      [vIdem.id]
    );
    assert(linesRes.rowCount === 2, `journal entry มีแค่ 2 บรรทัดพอดี (Dr/Cr) ได้ ${linesRes.rowCount}`);
    const debitLine = linesRes.rows.find(r => Number(r.debit_amount) > 0);
    const creditLine = linesRes.rows.find(r => Number(r.credit_amount) > 0);
    assert(debitLine.account_code === '1150' && Number(debitLine.debit_amount) === 3000, `Journal Dr 1150 (ลูกหนี้เงินทดรองจ่าย) ถูกต้อง = 3,000 (ได้ ${debitLine.account_code}/${debitLine.debit_amount})`);
    assert(creditLine.account_code === '1100' && Number(creditLine.credit_amount) === 3000, `Journal Cr 1100 (เงินสด) ถูกต้อง = 3,000 (ได้ ${creditLine.account_code}/${creditLine.credit_amount})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'payment_voucher\' AND doc_id = ANY($1)', [createdVoucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'adv-%'`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
