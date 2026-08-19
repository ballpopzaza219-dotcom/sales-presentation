// Regression suite — Petty Cash module (หัวข้อ 1.1: เงินสดย่อย).
// Covers: cross-company 404, self-approval block, no_rule/over_ceiling/approve-success, idempotency
// retry (approve), journal balance verification (Dr expense / Cr 1110), and a real concurrent-request
// race against the FUND's remaining balance (not just the per-document ceiling) — the exact class of
// bug documented in CLAUDE.md ข้อ 7 (correlated subquery snapshot must not be combined with the lock).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/petty-cash.regression.js  (or: npm run test:petty-cash)
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const EMPLOYEE_ID = 2;
const EXPENSE_ACCOUNT_CODE = '5300'; // ค่าใช้จ่ายสำนักงาน

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

async function makeVoucher(username, fundId, amount) {
  const data = await call(username, 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'petty_cash', pettyCashFundId: fundId, payeeEmployeeId: EMPLOYEE_ID,
    purpose: 'regression test', amount, expenseAccountCode: EXPENSE_ACCOUNT_CODE,
  }, idemKey('pcv-create'));
  return data.voucher;
}
async function submitVoucher(username, id) {
  return call(username, 'POST', `/api/customer/payment-vouchers/${id}/submit`, {}, idemKey('pcv-submit'));
}

(async () => {
  const createdVoucherIds = [];
  const createdFundIds = [];
  const createdReplenishmentIds = [];
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
    await login('fx_super', codeA);
    await login('fx_other_co', codeB);

    // ================= 1) สร้างกองทุน (fx_super = can_manage_petty_cash_fund ผ่าน super_user) =================
    const fundRes = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', {
      name: 'Fixture Fund ' + Date.now(), fundLimit: 60000,
    });
    const fundId = fundRes.fund.id;
    createdFundIds.push(fundId);
    assert(fundRes.fund.balance === '60000.00' || Number(fundRes.fund.balance) === 60000, `สร้างกองทุนสำเร็จ ยอดคงเหลือเริ่มต้น = fund_limit (60,000) (ได้ ${fundRes.fund.balance})`);

    // ================= 2) no_rule / over_ceiling / approve success =================
    let v1 = await makeVoucher('fx_maker', fundId, 5000);
    createdVoucherIds.push(v1.id);
    await submitVoucher('fx_maker', v1.id);
    const eNoRule = await callExpectError('fx_approver_norule', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('pcv-approve'));
    assert(eNoRule.status === 403 && eNoRule.body.code === 'no_rule', `มี flag แต่ไม่มี rule -> no_rule (ได้ code ${eNoRule.body.code})`);

    const approveOk = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('pcv-approve'));
    assert(approveOk.voucher.status === 'approved', 'อนุมัติสำเร็จภายในเพดาน (5,000 อยู่ในช่วง 0-50,000)');

    let v2 = await makeVoucher('fx_maker', fundId, 55000); // เกินเพดาน fx_approver_mid (0-50,000)
    createdVoucherIds.push(v2.id);
    await submitVoucher('fx_maker', v2.id);
    const eOverCeiling = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v2.id}/approve`, {}, idemKey('pcv-approve'));
    assert(eOverCeiling.status === 403 && eOverCeiling.body.code === 'over_ceiling', `ยอด 55,000 เกินเพดาน fx_approver_mid (50,000) -> over_ceiling (ได้ code ${eOverCeiling.body.code})`);

    // ================= 3) Cross-company 404 =================
    const eCross = await callExpectError('fx_other_co', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('pcv-approve-cross'));
    assert(eCross.status === 404, `บริษัทอื่นแตะใบเบิกเงินไม่ได้ 404 (ได้ ${eCross.status})`);

    // ================= 4) Self-approval block =================
    let vSelf = await makeVoucher('fx_approver_mid', fundId, 1000);
    createdVoucherIds.push(vSelf.id);
    await submitVoucher('fx_approver_mid', vSelf.id);
    const eSelf = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vSelf.id}/approve`, {}, idemKey('pcv-approve'));
    assert(eSelf.status === 403 && eSelf.body.code === 'self_approval', `ผู้สร้างอนุมัติใบเบิกของตัวเองไม่ได้ (ได้ code ${eSelf.body.code})`);

    // ================= 5) Idempotency retry บน approve =================
    let vIdem = await makeVoucher('fx_maker', fundId, 2000);
    createdVoucherIds.push(vIdem.id);
    await submitVoucher('fx_maker', vIdem.id);
    const idemApproveKey = idemKey('pcv-approve-retry');
    const approveA = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vIdem.id}/approve`, {}, idemApproveKey);
    const approveB = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vIdem.id}/approve`, {}, idemApproveKey);
    assert(approveA.voucher.status === 'approved' && approveB.voucher.status === 'approved', 'retry approve ด้วย Idempotency-Key เดิม ทั้งคู่ได้ status approved เหมือนกัน');
    const journalCountRes = await pool.query(
      `SELECT count(*)::int AS n FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id=$1`,
      [vIdem.id]
    );
    assert(journalCountRes.rows[0].n === 1, `retry ไม่โพสต์ journal entry ซ้ำ (ยังมีแค่ 1 entry ได้ ${journalCountRes.rows[0].n})`);

    // ================= 6) ตรวจยอดบัญชีหลัง approve จริง (Dr 5300 / Cr 1110) =================
    const linesRes = await pool.query(
      `SELECT l.account_code, l.debit_amount, l.credit_amount FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.source_type='payment_voucher' AND e.source_id=$1 ORDER BY l.id`,
      [vIdem.id]
    );
    const debitLine = linesRes.rows.find(r => Number(r.debit_amount) > 0);
    const creditLine = linesRes.rows.find(r => Number(r.credit_amount) > 0);
    assert(debitLine.account_code === EXPENSE_ACCOUNT_CODE && Number(debitLine.debit_amount) === 2000, `Journal Dr ${EXPENSE_ACCOUNT_CODE} (ค่าใช้จ่าย) ถูกต้อง = 2,000 (ได้ ${debitLine.account_code}/${debitLine.debit_amount})`);
    assert(creditLine.account_code === '1110' && Number(creditLine.credit_amount) === 2000, `Journal Cr 1110 (เงินสดย่อย) ถูกต้อง = 2,000 (ได้ ${creditLine.account_code}/${creditLine.credit_amount})`);

    // ================= 7) Concurrent race บนยอดคงเหลือ "กองทุน" (ไม่ใช่แค่เพดานต่อเอกสาร) =================
    // fund_limit=60,000, ใช้ไปแล้ว 5,000+2,000=7,000 (จากข้อ 2 และ 5) เหลือ 53,000 — สร้าง 2 ใบ 40,000
    // แต่ละใบอยู่ในเพดาน fx_approver_mid (0-50,000) เดี่ยวๆ ผ่านได้สบาย แต่รวมกัน 80,000 > 53,000 คงเหลือ
    // ยิง approve พร้อมกันจริงต้องมีแค่ใบเดียวผ่าน (พิสูจน์ fix ตาม CLAUDE.md ข้อ 7 — ล็อกกองทุนแยกจากคำนวณ balance)
    let vRaceA = await makeVoucher('fx_maker', fundId, 40000);
    let vRaceB = await makeVoucher('fx_maker', fundId, 40000);
    createdVoucherIds.push(vRaceA.id, vRaceB.id);
    await submitVoucher('fx_maker', vRaceA.id);
    await submitVoucher('fx_maker', vRaceB.id);

    const raceResults = await Promise.allSettled([
      call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vRaceA.id}/approve`, {}, idemKey('pcv-race-a')),
      call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vRaceB.id}/approve`, {}, idemKey('pcv-race-b')),
    ]);
    const raceFulfilled = raceResults.filter(r => r.status === 'fulfilled');
    const raceRejected = raceResults.filter(r => r.status === 'rejected');
    assert(raceFulfilled.length === 1, `approve 2 ใบพร้อมกัน (40k+40k=80k เกินยอดคงเหลือกองทุน 53k) — สำเร็จแค่ 1 ใบจริง (ได้ ${raceFulfilled.length})`);
    assert(raceRejected.length === 1, `อีกใบถูกปฏิเสธเพราะยอดกองทุนไม่พอ (ได้ ${raceRejected.length} rejected)`);
    if (raceRejected.length === 1) {
      assert(/ไม่เพียงพอ/.test(raceRejected[0].reason.body.error || ''), `เหตุผลที่ถูกปฏิเสธคือยอดกองทุนไม่พอจริง (ได้ "${raceRejected[0].reason.body.error}")`);
    }

    const fundAfter = await call('fx_super', 'GET', '/api/customer/petty-cash-funds');
    const fundNow = fundAfter.funds.find(f => f.id === fundId);
    // 60,000 - 5,000 - 2,000 - 40,000(ใบเดียวที่ผ่าน) = 13,000
    assert(Number(fundNow.balance) === 13000, `ยอดคงเหลือกองทุนหลัง race ถูกต้องเป๊ะ = 13,000 ไม่ใช่ -27,000 (ได้ ${fundNow.balance})`);

    // ================= 8) เติมเงินกองทุน — reject ต้องเขียน rejected_reason ลงคอลัมน์บนแถวจริง =================
    // เดิม (known-limitations ข้อ ข.4): column มีอยู่แล้วตั้งแต่ migration 0003 แต่ route ไม่เคยเขียนลงไป
    // เลย พึ่ง audit log อย่างเดียว — แก้แล้ว เทสนี้ยืนยันว่าคอลัมน์บนแถวเอกสารเองก็มีค่าจริงด้วย
    const replRes = await call('fx_maker', 'POST', '/api/customer/petty-cash-replenishments', { fundId, amount: 3000, note: 'regression reject test' }, idemKey('pcr-create'));
    createdReplenishmentIds.push(replRes.replenishment.id);
    await call('fx_maker', 'POST', `/api/customer/petty-cash-replenishments/${replRes.replenishment.id}/submit`, {}, idemKey('pcr-submit'));
    const rejectReason = 'ยอดไม่ตรงกับใบเสร็จ regression test';
    const rejected = await call('fx_approver_mid', 'POST', `/api/customer/petty-cash-replenishments/${replRes.replenishment.id}/reject`, { reason: rejectReason }, idemKey('pcr-reject'));
    assert(rejected.replenishment.status === 'rejected', 'ปฏิเสธใบเติมเงินกองทุนสำเร็จ');
    const replRow = await pool.query('SELECT rejected_reason FROM client_petty_cash_replenishments WHERE id=$1', [replRes.replenishment.id]);
    assert(replRow.rows[0].rejected_reason === rejectReason, `rejected_reason เขียนลงคอลัมน์บนแถวเอกสารจริง (ได้ "${replRow.rows[0].rejected_reason}" คาดหวัง "${rejectReason}")`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdReplenishmentIds.length) {
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'petty_cash_replenishment\' AND doc_id = ANY($1)', [createdReplenishmentIds]);
        await pool.query('DELETE FROM client_petty_cash_replenishments WHERE id = ANY($1)', [createdReplenishmentIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'payment_voucher\' AND doc_id = ANY($1)', [createdVoucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      if (createdFundIds.length) {
        await pool.query('DELETE FROM client_petty_cash_funds WHERE id = ANY($1)', [createdFundIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND (idempotency_key LIKE 'pcv-%' OR idempotency_key LIKE 'pcr-%')`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
