// Regression suite — Advance Clearance module (หัวข้อ 1.3: เคลียร์เงินทดรองจ่าย).
// Covers: cross-company 404, self-approval block, no_rule/over_ceiling/approve-success, balance
// verification (1150 clears to exactly 0 on an exact-match clearance; 2110/2120/1170 match SUM of
// items on an overage+VAT+WHT clearance), and the 50-tawi (WHT certificate) snapshot-freeze guarantee
// — changing client_wht_income_types.name_th AFTER a cert is issued must NOT change the already-issued
// cert's frozen name (client_wht_certificates is a shared, cross-company master-adjacent table for
// income types, so this test restores the original name in its own try/finally regardless of outcome).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/advance-clearance.regression.js  (or: npm run test:advance-clearance)
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

async function makeApprovedAdvanceVoucher(amount, approverUsername = 'fx_approver_mid') {
  const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'advance', payeeEmployeeId: EMPLOYEE_ID, purpose: 'regression advance for clearance', amount,
  }, idemKey('advcl-voucher-create'));
  await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('advcl-voucher-submit'));
  const approved = await call(approverUsername, 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('advcl-voucher-approve'));
  return approved.voucher;
}

(async () => {
  const createdVoucherIds = [];
  const createdClearanceIds = [];
  let whtTypeOriginalName = null;
  let whtTypeCode = null;
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
    await login('fx_super', codeA);

    // ================= 1) no_rule / cross-company / self-approval (ใบเคลียร์ยอดเล็ก ไม่มี WHT) =================
    const voucher1 = await makeApprovedAdvanceVoucher(10000);
    createdVoucherIds.push(voucher1.id);
    const clearance1Create = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: voucher1.id,
      items: [
        { description: 'ค่าวัสดุ A', expenseAccountCode: '5100', amount: 6000, payeeName: 'ร้านวัสดุทดสอบ A' },
        { description: 'ค่าวัสดุ B', expenseAccountCode: '5300', amount: 4000, payeeName: 'ร้านวัสดุทดสอบ B' },
      ],
    }, idemKey('advcl-create'));
    const clearance1 = clearance1Create.clearance;
    createdClearanceIds.push(clearance1.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance1.id}/submit`, {}, idemKey('advcl-submit'));

    const eNoRule = await callExpectError('fx_approver_norule', 'POST', `/api/customer/advance-clearances/${clearance1.id}/approve`, {}, idemKey('advcl-approve'));
    assert(eNoRule.status === 403 && eNoRule.body.code === 'no_rule', `มี flag can_approve_advance แต่ไม่มี rule -> no_rule (ได้ code ${eNoRule.body.code})`);

    const eCross = await callExpectError('fx_other_co', 'POST', `/api/customer/advance-clearances/${clearance1.id}/approve`, {}, idemKey('advcl-approve-cross'));
    assert(eCross.status === 404, `บริษัทอื่นแตะใบเคลียร์เงินทดรองจ่ายไม่ได้ 404 (ได้ ${eCross.status})`);

    const eSelf = await callExpectError('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance1.id}/approve`, {}, idemKey('advcl-approve-self'));
    assert(eSelf.status === 403, `ผู้สร้างใบเคลียร์ไม่มีสิทธิ์อนุมัติเอง (ได้ ${eSelf.status})`);

    // ================= 2) อนุมัติจริง (พอดี 10,000=10,000 -> settled, 1150 เคลียร์เต็มจำนวน) =================
    const approve1 = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance1.id}/approve`, {}, idemKey('advcl-approve'));
    assert(approve1.clearance.status === 'settled', `ยอดค่าใช้จ่ายพอดีกับยอดทดรองจ่าย (10,000=10,000) -> settled ทันทีไม่ต้อง /settle เพิ่ม (ได้ ${approve1.clearance.status})`);

    const bal1150Res = await pool.query(
      `SELECT COALESCE(SUM(l.debit_amount) - SUM(l.credit_amount), 0) AS net
       FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE l.account_code = '1150' AND e.source_type IN ('payment_voucher','advance_clearance')
         AND e.source_id = ANY($1::int[])`,
      [[voucher1.id, clearance1.id]]
    );
    assert(Number(bal1150Res.rows[0].net) === 0, `บัญชี 1150 (ลูกหนี้เงินทดรองจ่าย) สุทธิ = 0 พอดีหลังเคลียร์ครบ (Dr ตอนจ่าย 10,000 - Cr ตอนเคลียร์ 10,000) ได้ ${bal1150Res.rows[0].net}`);

    // ================= 3) over_ceiling =================
    const voucher2 = await makeApprovedAdvanceVoucher(60000, 'fx_approver_floor');
    createdVoucherIds.push(voucher2.id);
    const clearance2Create = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: voucher2.id,
      items: [{ description: 'ค่าวัสดุใหญ่', expenseAccountCode: '5100', amount: 60000, payeeName: 'ร้านวัสดุทดสอบใหญ่' }],
    }, idemKey('advcl-create'));
    createdClearanceIds.push(clearance2Create.clearance.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance2Create.clearance.id}/submit`, {}, idemKey('advcl-submit'));
    const eOverCeiling = await callExpectError('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance2Create.clearance.id}/approve`, {}, idemKey('advcl-approve'));
    assert(eOverCeiling.status === 403 && eOverCeiling.body.code === 'over_ceiling', `ยอด 60,000 เกินเพดาน fx_approver_mid (50,000) -> over_ceiling (ได้ code ${eOverCeiling.body.code})`);

    // ================= 4) VAT + WHT + overage (2120/1170/2110) + 50-tawi snapshot freeze =================
    // มี WHT>0 ต้องผูก payeeExternalId (master data) เสมอตั้งแต่ migration 0020 — ต้องรู้ taxpayer_type
    // เพื่อคำนวณ wht_form (ภ.ง.ด.3/53) ตอนออก 50 ทวิ ฟรีเทกซ์ล้วนๆ ใช้ไม่ได้อีกต่อไป
    const voucher3 = await makeApprovedAdvanceVoucher(5000);
    createdVoucherIds.push(voucher3.id);
    const payeeTaxId = '1' + String(Date.now()).padStart(12, '0').slice(0, 12);
    const payeeName = `ผู้รับเหมาทดสอบ Regression ${Date.now()}`;
    const payeeCreate = await call('fx_super', 'POST', '/api/customer/external-payees', {
      name: payeeName, taxpayerType: 'juristic', taxId: payeeTaxId,
    });
    const payeeExternalId = payeeCreate.externalPayee.id;

    // มี WHT>0 แต่ระบุผู้รับเงินแบบฟรีเทกซ์ (ไม่ผูก payeeExternalId) ต้องถูกปฏิเสธ 400 ทันที
    const eNoPayeeExternalId = await callExpectError('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: voucher3.id,
      items: [{
        description: 'ค่าบริการที่ปรึกษา (ฟรีเทกซ์)', expenseAccountCode: '5300', amount: 3000,
        hasTaxInvoice: true, vatRate: 7, whtRate: 3, whtIncomeTypeCode: '40_2',
        payeeName: 'ผู้รับเหมาฟรีเทกซ์ไม่มี master data', payeeTaxId: '9999999999999',
      }],
    }, idemKey('advcl-create-reject-freetext-wht'));
    assert(eNoPayeeExternalId.status === 400 && /master data/.test(eNoPayeeExternalId.body.error), `รายการมี WHT>0 แต่ไม่ผูก payeeExternalId ถูกปฏิเสธ 400 จริง (migration 0020, ได้ status=${eNoPayeeExternalId.status})`);

    const clearance3Create = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: voucher3.id,
      items: [
        {
          description: 'ค่าบริการที่ปรึกษา', expenseAccountCode: '5300', amount: 3000,
          hasTaxInvoice: true, vatRate: 7, whtRate: 3, whtIncomeTypeCode: '40_2',
          payeeExternalId,
        },
        { description: 'ค่าวัสดุเบ็ดเตล็ด', expenseAccountCode: '5100', amount: 2500, payeeName: 'ร้านวัสดุทดสอบเบ็ดเตล็ด' },
      ],
    }, idemKey('advcl-create'));
    const clearance3 = clearance3Create.clearance;
    createdClearanceIds.push(clearance3.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance3.id}/submit`, {}, idemKey('advcl-submit'));
    const approve3 = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance3.id}/approve`, {}, idemKey('advcl-approve'));
    // net_amount ต่อบรรทัด: item1 = 3000+210(vat)-90(wht)=3120, item2=2500 -> total_expense_amount=5620
    // advance_amount=5000 -> difference=620 (overage) -> ยังไม่ settled ต้องรอ /settle
    assert(approve3.clearance.status === 'approved', `มี overage (620) -> status ยังเป็น approved ไม่ auto-settle (ได้ ${approve3.clearance.status})`);
    assert(approve3.issuedWhtCertificates.length === 1, `ออก 50 ทวิ 1 ใบตามจำนวนบรรทัดที่มี wht_amount>0 (ได้ ${approve3.issuedWhtCertificates.length})`);

    const linesRes = await pool.query(
      `SELECT account_code, SUM(debit_amount) AS dr, SUM(credit_amount) AS cr FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.source_type='advance_clearance' AND e.source_id=$1 GROUP BY account_code ORDER BY account_code`,
      [clearance3.id]
    );
    const byCode = Object.fromEntries(linesRes.rows.map(r => [r.account_code, r]));
    assert(Number(byCode['1170'].dr) === 210, `บัญชี 1170 (ภาษีซื้อ) = 210 ตรงกับ VAT ของบรรทัดที่มีใบกำกับภาษี (7% ของ 3,000) (ได้ ${byCode['1170'] && byCode['1170'].dr})`);
    assert(Number(byCode['2120'].cr) === 90, `บัญชี 2120 (ภาษีหัก ณ ที่จ่ายค้างนำส่ง) = 90 ตรงกับ WHT (3% ของ 3,000) (ได้ ${byCode['2120'] && byCode['2120'].cr})`);
    assert(Number(byCode['2110'].cr) === 620, `บัญชี 2110 (เจ้าหนี้พนักงาน ส่วนต่างเบิกเพิ่ม) = 620 ตรงกับ overage (5,620-5,000) (ได้ ${byCode['2110'] && byCode['2110'].cr})`);

    // ---- 50-tawi snapshot freeze ----
    const certRes = await pool.query(
      `SELECT id, cert_no, wht_income_type_code, wht_income_type_name_snapshot, payee_name, payee_tax_id, wht_rate, wht_amount, wht_form
       FROM client_wht_certificates WHERE source_type='advance_clearance_item' AND cert_no=$1`,
      [approve3.issuedWhtCertificates[0]]
    );
    const cert = certRes.rows[0];
    assert(cert.payee_name === payeeName && cert.payee_tax_id === payeeTaxId, 'ใบ 50 ทวิ บันทึกชื่อ/เลขผู้เสียภาษีผู้รับเงินถูกต้อง');
    assert(cert.wht_form === 'pnd53', `ใบ 50 ทวิ คำนวณ wht_form ถูกต้องตาม taxpayer_type='juristic' ของผู้รับเงิน (ได้ ${cert.wht_form})`);
    assert(Number(cert.wht_amount) === 90, `ใบ 50 ทวิ บันทึกยอดหัก ณ ที่จ่าย = 90 ถูกต้อง (ได้ ${cert.wht_amount})`);

    whtTypeCode = cert.wht_income_type_code;
    const origRes = await pool.query('SELECT name_th FROM client_wht_income_types WHERE code=$1', [whtTypeCode]);
    whtTypeOriginalName = origRes.rows[0].name_th;
    assert(cert.wht_income_type_name_snapshot === whtTypeOriginalName, `ตอนออกใบ 50 ทวิ ชื่อ snapshot ตรงกับชื่อ master data ณ ตอนนั้น (ได้ "${cert.wht_income_type_name_snapshot}")`);

    // แก้ชื่อ master data หลังออกใบไปแล้ว (จำลองมีคนแก้ไขประเภทเงินได้ทีหลัง) — ต้อง restore กลับเสมอ
    await pool.query('UPDATE client_wht_income_types SET name_th=$1 WHERE code=$2', ['[TEST] ชื่อที่ถูกแก้ทีหลัง ไม่ควรกระทบใบที่ออกไปแล้ว', cert.wht_income_type_code]);
    const certAfterRes = await pool.query('SELECT wht_income_type_name_snapshot FROM client_wht_certificates WHERE id=$1', [cert.id]);
    assert(certAfterRes.rows[0].wht_income_type_name_snapshot === whtTypeOriginalName, `แก้ชื่อ master data หลังออกใบแล้ว -> ใบ 50 ทวิ ที่ออกไปแล้วยังคงชื่อเดิม ไม่เปลี่ยนตาม (ได้ "${certAfterRes.rows[0].wht_income_type_name_snapshot}" คาดหวัง "${whtTypeOriginalName}")`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (whtTypeOriginalName !== null && whtTypeCode !== null) {
        await pool.query('UPDATE client_wht_income_types SET name_th=$1 WHERE code=$2', [whtTypeOriginalName, whtTypeCode]);
      }
      if (createdClearanceIds.length) {
        await pool.query('DELETE FROM client_wht_certificates WHERE source_type=\'advance_clearance_item\' AND source_id IN (SELECT id FROM client_advance_clearance_items WHERE clearance_id = ANY($1))', [createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1))`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1)`, [createdClearanceIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'advance_clearance\' AND doc_id = ANY($1)', [createdClearanceIds]);
        await pool.query('DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [createdClearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [createdClearanceIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'payment_voucher\' AND doc_id = ANY($1)', [createdVoucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'advcl-%'`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
