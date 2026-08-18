// Regression suite — External Payee module (หัวข้อ 1.4: จ่ายเจ้าหนี้ภายนอกไม่ผ่าน PO/WO,
// client_payment_vouchers voucher_type='other').
// Covers: cross-company 404, self-approval block, no_rule/over_ceiling/approve-success, journal
// balance verification with VAT+WHT (Dr expense, Dr 1170 VAT input, Cr 2120 WHT payable, Cr 1100 cash),
// and 50-tawi issuance tied to real master-data payee (client_external_payees — no CRUD endpoint exists
// for this table yet, so the fixture payee is inserted directly and cleaned up in this file's own
// try/finally, same pattern as the PO fixture in tests/pr.regression.js).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/external-payment.regression.js  (or: npm run test:external-payment)
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const EXPENSE_ACCOUNT_CODE = '5300';

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

(async () => {
  const createdVoucherIds = [];
  let payeeId = null;
  try {
    console.log('Ensuring fixtures...');
    await setup();

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;

    await login('fx_maker', codeA);
    await login('fx_approver_mid', codeA);
    await login('fx_approver_norule', codeA);
    await login('fx_other_co', codeB);

    // client_external_payees ไม่มี CRUD endpoint เลย (ตรวจแล้วจาก server.js) — insert ตรงเป็น fixture
    const payeeIns = await pool.query(
      `INSERT INTO client_external_payees (company_id, name, tax_id, taxpayer_type) VALUES ($1,$2,$3,'juristic') RETURNING id`,
      [COMPANY_A_ID, 'บริษัท ผู้รับเหมาทดสอบ Regression จำกัด', '9876543210987']
    );
    payeeId = payeeIns.rows[0].id;

    async function makeVoucher(username, amount, opts = {}) {
      const data = await call(username, 'POST', '/api/customer/payment-vouchers', {
        voucherType: 'other', payeeExternalId: payeeId, purpose: 'regression external payment',
        amount, expenseAccountCode: EXPENSE_ACCOUNT_CODE, ...opts,
      }, idemKey('ext-create'));
      return data.voucher;
    }
    async function submitVoucher(username, id) {
      return call(username, 'POST', `/api/customer/payment-vouchers/${id}/submit`, {}, idemKey('ext-submit'));
    }

    // ================= 1) no_rule / over_ceiling / approve success =================
    let v1 = await makeVoucher('fx_maker', 8000);
    createdVoucherIds.push(v1.id);
    await submitVoucher('fx_maker', v1.id);
    const eNoRule = await callExpectError('fx_approver_norule', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('ext-approve'));
    assert(eNoRule.status === 403 && eNoRule.body.code === 'no_rule', `มี flag can_approve_other แต่ไม่มี rule -> no_rule (ได้ code ${eNoRule.body.code})`);
    const approveOk = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('ext-approve'));
    assert(approveOk.voucher.status === 'approved', 'อนุมัติสำเร็จภายในเพดาน (8,000 อยู่ในช่วง 0-50,000)');

    let v2 = await makeVoucher('fx_maker', 55000);
    createdVoucherIds.push(v2.id);
    await submitVoucher('fx_maker', v2.id);
    const eOverCeiling = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v2.id}/approve`, {}, idemKey('ext-approve'));
    assert(eOverCeiling.status === 403 && eOverCeiling.body.code === 'over_ceiling', `ยอด 55,000 เกินเพดาน 50,000 -> over_ceiling (ได้ code ${eOverCeiling.body.code})`);

    // ================= 2) Cross-company 404 =================
    const eCross = await callExpectError('fx_other_co', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('ext-approve-cross'));
    assert(eCross.status === 404, `บริษัทอื่นแตะใบจ่ายเจ้าหนี้ภายนอกไม่ได้ 404 (ได้ ${eCross.status})`);

    // ================= 3) Self-approval block =================
    let vSelf = await makeVoucher('fx_approver_mid', 1000);
    createdVoucherIds.push(vSelf.id);
    await submitVoucher('fx_approver_mid', vSelf.id);
    const eSelf = await callExpectError('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vSelf.id}/approve`, {}, idemKey('ext-approve'));
    assert(eSelf.status === 403 && eSelf.body.code === 'self_approval', `ผู้สร้างอนุมัติใบจ่ายเจ้าหนี้ภายนอกของตัวเองไม่ได้ (ได้ code ${eSelf.body.code})`);

    // ================= 4) VAT + WHT: ตรวจยอดบัญชี + ออก 50 ทวิ =================
    let vTax = await makeVoucher('fx_maker', 10000, { hasTaxInvoice: true, vatRate: 7, whtRate: 3, whtIncomeTypeCode: '40_7' });
    createdVoucherIds.push(vTax.id);
    await submitVoucher('fx_maker', vTax.id);
    const approveTax = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${vTax.id}/approve`, {}, idemKey('ext-approve'));
    assert(approveTax.voucher.status === 'approved', 'อนุมัติใบที่มี VAT+WHT สำเร็จ');
    assert(approveTax.issuedWhtCertificates.length === 1, `ออก 50 ทวิ 1 ใบ (ได้ ${approveTax.issuedWhtCertificates.length})`);

    const linesRes = await pool.query(
      `SELECT account_code, SUM(debit_amount) AS dr, SUM(credit_amount) AS cr FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.source_type='payment_voucher' AND e.source_id=$1 GROUP BY account_code ORDER BY account_code`,
      [vTax.id]
    );
    const byCode = Object.fromEntries(linesRes.rows.map(r => [r.account_code, r]));
    // amount=10000, vat=700 (7%), wht=300 (3%), net_amount ที่จ่ายจริง = 10000+700-300=10400
    assert(Number(byCode[EXPENSE_ACCOUNT_CODE].dr) === 10000, `บัญชี ${EXPENSE_ACCOUNT_CODE} (ค่าใช้จ่าย) Dr = 10,000 (ได้ ${byCode[EXPENSE_ACCOUNT_CODE] && byCode[EXPENSE_ACCOUNT_CODE].dr})`);
    assert(Number(byCode['1170'].dr) === 700, `บัญชี 1170 (ภาษีซื้อ) Dr = 700 (7% ของ 10,000) (ได้ ${byCode['1170'] && byCode['1170'].dr})`);
    assert(Number(byCode['2120'].cr) === 300, `บัญชี 2120 (ภาษีหัก ณ ที่จ่ายค้างนำส่ง) Cr = 300 (3% ของ 10,000) (ได้ ${byCode['2120'] && byCode['2120'].cr})`);
    assert(Number(byCode['1100'].cr) === 10400, `บัญชี 1100 (เงินสด) Cr = 10,400 (ยอดจ่ายจริงสุทธิ) (ได้ ${byCode['1100'] && byCode['1100'].cr})`);
    const totalDr = Number(byCode[EXPENSE_ACCOUNT_CODE].dr) + Number(byCode['1170'].dr);
    const totalCr = Number(byCode['2120'].cr) + Number(byCode['1100'].cr);
    assert(totalDr === totalCr, `Journal entry สมดุล Dr รวม (${totalDr}) = Cr รวม (${totalCr})`);

    const certRes = await pool.query(
      `SELECT payee_name, payee_tax_id, wht_amount FROM client_wht_certificates WHERE source_type='payment_voucher' AND source_id=$1`,
      [vTax.id]
    );
    assert(certRes.rows[0].payee_name === 'บริษัท ผู้รับเหมาทดสอบ Regression จำกัด', 'ใบ 50 ทวิ ดึงชื่อผู้รับเงินจาก master data (client_external_payees) ถูกต้อง ไม่ใช่ free text');
    assert(certRes.rows[0].payee_tax_id === '9876543210987', 'ใบ 50 ทวิ ดึงเลขผู้เสียภาษีจาก master data ถูกต้อง');
    assert(Number(certRes.rows[0].wht_amount) === 300, `ใบ 50 ทวิ บันทึกยอดหัก ณ ที่จ่าย = 300 ถูกต้อง (ได้ ${certRes.rows[0].wht_amount})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdVoucherIds.length) {
        await pool.query('DELETE FROM client_wht_certificates WHERE source_type=\'payment_voucher\' AND source_id = ANY($1)', [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'payment_voucher\' AND doc_id = ANY($1)', [createdVoucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      if (payeeId) {
        await pool.query('DELETE FROM client_external_payees WHERE id=$1', [payeeId]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'ext-%'`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
