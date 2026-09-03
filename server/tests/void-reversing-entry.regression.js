// Regression suite — /void (migration 0021): undo an approved+posted document via a reversing journal
// entry. Covers all 4 supported document types (client_payment_vouchers, client_advance_clearances,
// client_subcontract_billings, client_progress_claims) across 5 categories the accounting team asked for
// explicitly: (1) every accumulated balance actually returns to its original value verified straight
// from the DB, not just a 200 response; (2) the reversing journal entry itself is structurally correct
// (balanced, lines mirrored, reverses_entry_id points at the right row, dated the day of the void — not
// the original entry's date, double-void blocked); (3) the 50-tawi (WHT certificate) lifecycle (voided,
// a fresh cert can still be issued with a non-colliding number, the monthly ภ.ง.ด. summary excludes
// voided certs); (4) the agreed business rules (period lock, strict self-void including super_user,
// no-permission -> 403 not 500, missing reason rejected, cross-company -> 404); (5) atomicity — a
// forced mid-transaction failure (not a mock: a real unique-constraint collision on
// uq_client_journal_entries_reverses_entry_id) must leave absolutely nothing changed.
//
// client_petty_cash_replenishments is intentionally NOT covered — no /void exists for it (see
// known-limitations ข.10, fund balance is computed live so there was nothing to add).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/void-reversing-entry.regression.js
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const EMPLOYEE_ID = 2;
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

function assertJournalBalanced(lines, label) {
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit_amount), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit_amount), 0);
  assert(Math.round(totalDebit * 100) === Math.round(totalCredit * 100), `${label}: SUM(debit)=${totalDebit} เท่ากับ SUM(credit)=${totalCredit} จริง (บัญชีสมดุล)`);
}

async function journalEntriesFor(sourceTypes, sourceId) {
  const types = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes];
  const r = await pool.query(
    `SELECT id, entry_date, reverses_entry_id, source_type, source_id FROM client_journal_entries
     WHERE source_type = ANY($1::text[]) AND source_id=$2 ORDER BY id`,
    [types, sourceId]
  );
  return r.rows;
}
async function linesOf(journalEntryId) {
  const r = await pool.query(
    'SELECT account_code, debit_amount, credit_amount, description FROM client_journal_entry_lines WHERE journal_entry_id=$1 ORDER BY account_code',
    [journalEntryId]
  );
  return r.rows;
}
async function netByAccount(sourceTypes, sourceId) {
  const types = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes];
  const r = await pool.query(
    `SELECT account_code, COALESCE(SUM(l.debit_amount) - SUM(l.credit_amount), 0) AS net
     FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id = l.journal_entry_id
     WHERE e.source_type = ANY($1::text[]) AND e.source_id=$2 GROUP BY account_code`,
    [types, sourceId]
  );
  return Object.fromEntries(r.rows.map(row => [row.account_code, Number(row.net)]));
}
async function currentBangkokYYYYMM() {
  const r = await pool.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS ym`);
  return r.rows[0].ym;
}
// ย้าย entry_date ของ journal entry(s) ของเอกสารหนึ่งไปเป็น "เดือนก่อนหน้า" (สำหรับเทส period-lock) — ใช้
// date_trunc('month', CURRENT_DATE) - 1 day เสมอ ไม่ว่าวันนี้จะเป็นวันที่เท่าไหร่ก็ได้เดือนก่อนหน้าจริง
async function backdateToLastMonth(sourceTypes, sourceId) {
  const types = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes];
  await pool.query(
    `UPDATE client_journal_entries SET entry_date = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date
     WHERE source_type = ANY($1::text[]) AND source_id=$2 AND reverses_entry_id IS NULL`,
    [types, sourceId]
  );
}

(async () => {
  const cleanup = { fundIds: [], voucherIds: [], clearanceIds: [], projectIds: [], subcontractorIds: [], termIds: [], billingIds: [], claimIds: [], budgetIds: [], payeeIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;
    for (const u of ['fx_maker', 'fx_maker2', 'fx_approver_mid', 'fx_super', 'fx_settler', 'fx_certifier', 'fx_procurement']) await login(u, codeA);
    await login('fx_other_co', codeB);

    const currentYYYYMM = await currentBangkokYYYYMM();
    const [curYear, curMonth] = currentYYYYMM.split('-');

    // ============================================================================================
    // (A) client_payment_vouchers (petty_cash) — ยอดกองทุนคำนวณสด ไม่มีคอลัมน์สะสมให้ตรวจ แต่ต้องตรวจว่า
    // "ยอดคงเหลือกลับเท่าเดิม" หลัง void จริง
    // ============================================================================================
    console.log('\n=== (A) payment_voucher (petty_cash) ===');
    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'E2E void fund ' + Date.now(), fundLimit: 60000 }, idemKey('void-fund-create'));
    cleanup.fundIds.push(fund.fund.id);
    const balanceBefore = Number(fund.fund.balance);

    async function makePettyCashVoucher(amount) {
      const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
        voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: EMPLOYEE_ID,
        purpose: 'E2E void test', amount, expenseAccountCode: EXPENSE_ACCOUNT_CODE,
      }, idemKey('void-pcv-create'));
      cleanup.voucherIds.push(created.voucher.id);
      await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('void-pcv-submit'));
      return call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('void-pcv-approve'));
    }

    // ---- ปฏิเสธ: ไม่กรอกเหตุผล ----
    const pcv1 = await makePettyCashVoucher(5000);
    const eNoReason = await callExpectError('fx_settler', 'POST', `/api/customer/payment-vouchers/${pcv1.voucher.id}/void`, {}, idemKey('void-pcv-noreason'));
    assert(eNoReason.status === 400, `ไม่กรอกเหตุผล -> 400 (ได้ ${eNoReason.status})`);

    // ---- ปฏิเสธ: ไม่มีสิทธิ์ (fx_maker2 ไม่ใช่ super_user ไม่มี can_settle_cash) -> 403 ไม่ใช่ 500 ----
    const eNoPerm = await callExpectError('fx_maker2', 'POST', `/api/customer/payment-vouchers/${pcv1.voucher.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pcv-noperm'));
    assert(eNoPerm.status === 403, `ไม่มีสิทธิ์ void -> 403 ไม่ใช่ 500 (ได้ ${eNoPerm.status})`);

    // ---- ปฏิเสธ: cross-company -> 404 ----
    const eCross = await callExpectError('fx_other_co', 'POST', `/api/customer/payment-vouchers/${pcv1.voucher.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pcv-cross'));
    assert(eCross.status === 404, `บริษัทอื่น void ใบนี้ไม่ได้ 404 (ได้ ${eCross.status})`);

    // ---- ปฏิเสธ: self-void (fx_approver_mid เป็นผู้อนุมัติเอง แม้จะมี can_settle_cash ก็ยังไม่มีในเคสนี้ —
    // ใช้ fx_super อนุมัติอีกใบเพื่อพิสูจน์ self-void ครอบคลุมถึง super_user ด้วย) ----
    const pcvSelf = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: EMPLOYEE_ID,
      purpose: 'E2E self-void test', amount: 1000, expenseAccountCode: EXPENSE_ACCOUNT_CODE,
    }, idemKey('void-pcv-self-create'));
    cleanup.voucherIds.push(pcvSelf.voucher.id);
    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${pcvSelf.voucher.id}/submit`, {}, idemKey('void-pcv-self-submit'));
    const pcvSelfApproved = await call('fx_super', 'POST', `/api/customer/payment-vouchers/${pcvSelf.voucher.id}/approve`, {}, idemKey('void-pcv-self-approve'));
    assert(pcvSelfApproved.voucher.status === 'approved', 'สร้าง fixture สำหรับเทส self-void สำเร็จ (fx_super เป็นผู้อนุมัติ)');
    const eSelf = await callExpectError('fx_super', 'POST', `/api/customer/payment-vouchers/${pcvSelf.voucher.id}/void`, { reason: 'ทดสอบ self-void' }, idemKey('void-pcv-self'));
    assert(eSelf.status === 403, `super_user ที่เป็นผู้อนุมัติเอง void ใบนี้ไม่ได้ 403 (self-void เข้มถึง super_user) (ได้ ${eSelf.status})`);

    // ---- ปฏิเสธ: void ข้ามเดือน (entry_date เดือนก่อน) ----
    const pcvOldMonth = await makePettyCashVoucher(2000);
    await backdateToLastMonth('payment_voucher', pcvOldMonth.voucher.id);
    const ePeriod = await callExpectError('fx_settler', 'POST', `/api/customer/payment-vouchers/${pcvOldMonth.voucher.id}/void`, { reason: 'ทดสอบข้ามเดือน' }, idemKey('void-pcv-oldmonth'));
    assert(ePeriod.status === 409, `void เอกสารที่ลงบัญชีเดือนก่อนถูกปฏิเสธ 409 (ได้ ${ePeriod.status})`);
    assert(new RegExp(`เดือน \\d+/${Number(curYear) + 543}`).test(ePeriod.body.error) && new RegExp(`เดือน \\d+/\\d+ แต่ตอนนี้เป็นเดือน ${Number(curMonth)}/${Number(curYear) + 543}`).test(ePeriod.body.error),
      `ข้อความ error บอกทั้งเดือนของเอกสารและเดือนปัจจุบันชัดเจน (ได้ "${ePeriod.body.error}")`);

    // ---- void สำเร็จจริง โดย fx_settler (มี can_settle_cash เท่านั้น ไม่ใช่ super_user ไม่เกี่ยวข้องกับใบนี้เลย) ----
    // ยอดกองทุน ณ จุดนี้ = 60000 - 5000(pcv1) - 1000(pcvSelf ยังไม่ถูก void เพราะ self-void โดนบล็อก) -
    // 2000(pcvOldMonth ยังไม่ถูก void เพราะ period-lock โดนบล็อก) = 52000 — จับยอด "ก่อน void pcv1" ไว้
    // ก่อนเสมอ แทนที่จะเทียบกับยอดเริ่มต้นกองทุนตรงๆ เพราะมีใบอื่นค้าง approved อยู่จริงระหว่างทาง
    const fundBeforeVoidPcv1 = await call('fx_super', 'GET', '/api/customer/petty-cash-funds');
    const balanceBeforeVoidPcv1 = Number(fundBeforeVoidPcv1.funds.find(f => f.id === fund.fund.id).balance);

    const voidResult = await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${pcv1.voucher.id}/void`, { reason: 'ทดสอบยกเลิกใบเบิกเงินสดย่อย' }, idemKey('void-pcv-real'));
    assert(voidResult.voucher.status === 'voided', `void สำเร็จจริง สถานะเปลี่ยนเป็น voided (ได้ ${voidResult.voucher.status})`);
    assert(!!voidResult.voucher.voidedAt, 'บันทึก voidedAt จริง');

    const fundAfter = await call('fx_super', 'GET', '/api/customer/petty-cash-funds');
    const thisFund = fundAfter.funds.find(f => f.id === fund.fund.id);
    assert(Number(thisFund.balance) === balanceBeforeVoidPcv1 + 5000, `ยอดคงเหลือกองทุนเพิ่มขึ้นตรงตามยอดใบที่ void พอดี (+5000 จาก ${balanceBeforeVoidPcv1} เป็น ${balanceBeforeVoidPcv1 + 5000}) หลัง void จริง (ได้ ${thisFund.balance}) — ไม่ต้อง UPDATE ยอดเอง เพราะคำนวณสดจาก status='approved'`);

    // ---- reversing entry ถูกต้องทุกมิติ ----
    const pcv1Entries = await journalEntriesFor('payment_voucher', pcv1.voucher.id);
    assert(pcv1Entries.length === 2, `มี journal entry 2 แถวหลัง void (ต้นฉบับ 1 + reversal 1) (ได้ ${pcv1Entries.length})`);
    const pcv1Original = pcv1Entries.find(e => e.reverses_entry_id === null);
    const pcv1Reversal = pcv1Entries.find(e => e.reverses_entry_id !== null);
    assert(!!pcv1Original && !!pcv1Reversal, 'แยกต้นฉบับ/reversal ได้ชัดเจนจาก reverses_entry_id');
    assert(pcv1Reversal.reverses_entry_id === pcv1Original.id, `reverses_entry_id ของ reversal ชี้ไป entry ต้นฉบับจริง (ได้ ${pcv1Reversal.reverses_entry_id} คาดหวัง ${pcv1Original.id})`);
    const todayStr = (await pool.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS d`)).rows[0].d;
    const reversalDateStr = (await pool.query(`SELECT to_char($1::date,'YYYY-MM-DD') AS d`, [pcv1Reversal.entry_date])).rows[0].d;
    assert(reversalDateStr === todayStr, `reversing entry ลงวันที่วันนี้ (${todayStr}) จริง ไม่ใช่วันเดียวกับ entry เดิม (ได้ ${reversalDateStr})`);

    const origLines = await linesOf(pcv1Original.id);
    const revLines = await linesOf(pcv1Reversal.id);
    assertJournalBalanced(revLines, 'reversing entry (petty cash)');
    assert(origLines.length === revLines.length, 'reversing entry มีจำนวนบรรทัดเท่ากับต้นฉบับ');
    for (const ol of origLines) {
      const rl = revLines.find(l => l.account_code === ol.account_code);
      assert(!!rl && Number(rl.debit_amount) === Number(ol.credit_amount) && Number(rl.credit_amount) === Number(ol.debit_amount),
        `บัญชี ${ol.account_code}: reversing line สลับ Dr/Cr กับต้นฉบับเป๊ะ (เดิม Dr=${ol.debit_amount}/Cr=${ol.credit_amount} -> reversal Dr=${rl && rl.debit_amount}/Cr=${rl && rl.credit_amount})`);
    }
    const net5300 = await netByAccount('payment_voucher', pcv1.voucher.id);
    assert(net5300['5300'] === 0, `สุทธิบัญชี 5300 (ค่าใช้จ่าย) = 0 พอดีหลัง void (ตัดไป 5000 กลับมา -5000) (ได้ ${net5300['5300']})`);
    assert(net5300['1110'] === 0, `สุทธิบัญชี 1110 (เงินสดย่อย) = 0 พอดีหลัง void (ได้ ${net5300['1110']})`);

    // ---- void ซ้ำครั้งที่สองต้องถูกบล็อก ----
    const eDoubleVoid = await callExpectError('fx_settler', 'POST', `/api/customer/payment-vouchers/${pcv1.voucher.id}/void`, { reason: 'ทดสอบ void ซ้ำ' }, idemKey('void-pcv-double'));
    assert(eDoubleVoid.status === 409, `void ซ้ำครั้งที่สอง (สถานะเป็น voided แล้ว) ถูกปฏิเสธ 409 (ได้ ${eDoubleVoid.status})`);
    // เช็ค partial unique index ตรงๆ ระดับ DB — พยายาม INSERT reversal ที่สองชี้ไป entry ต้นฉบับเดิมตรงๆ
    let dbLevelBlocked = null;
    try {
      await pool.query(
        `INSERT INTO client_journal_entries (company_id, entry_date, description, source_type, source_id, reverses_entry_id)
         VALUES ($1, CURRENT_DATE, 'ทดสอบกันซ้ำ', 'manual', 0, $2)`,
        [COMPANY_A_ID, pcv1Original.id]
      );
    } catch (e) { dbLevelBlocked = e; }
    assert(dbLevelBlocked !== null && /uq_client_journal_entries_reverses_entry_id/.test(dbLevelBlocked.message), `partial unique index (uq_client_journal_entries_reverses_entry_id) กันแถวที่สองชี้ reverses_entry_id ซ้ำได้จริงระดับ DB (ได้ error: ${dbLevelBlocked && dbLevelBlocked.message})`);

    // ============================================================================================
    // (B) client_advance_clearances — 1150/2110/2120/1170 ต้องกลับเป็น 0 สุทธิ + 50-ทวิ voided +
    // ออกใบใหม่เลขไม่ซ้ำ + monthly summary กรอง active
    // ============================================================================================
    console.log('\n=== (B) advance_clearance ===');
    async function makeApprovedAdvanceVoucher(amount, approverUsername = 'fx_approver_mid') {
      const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
        voucherType: 'advance', payeeEmployeeId: EMPLOYEE_ID, purpose: 'E2E void advance', amount,
      }, idemKey('void-advv-create'));
      cleanup.voucherIds.push(created.voucher.id);
      await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('void-advv-submit'));
      return (await call(approverUsername, 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('void-advv-approve'))).voucher;
    }
    const payeeTaxId = '1' + String(Date.now()).padStart(12, '0').slice(0, 12);
    const payee = await call('fx_super', 'POST', '/api/customer/external-payees', { name: `E2E void payee ${Date.now()}`, taxpayerType: 'juristic', taxId: payeeTaxId });
    cleanup.payeeIds.push(payee.externalPayee.id);

    // ⚠️ ตั้งใจไม่ใส่ hasTaxInvoice:true ในใบที่จะ void สำเร็จ — เอกสารมี VAT ถูกบล็อกไม่ให้ void โดยเจตนา
    // (ตกลงไว้ก่อนเขียน DDL 0021) ดังนั้น 1170 (ภาษีซื้อ) ไม่มีทางปรากฏในใบที่ void ผ่านได้เลยตามดีไซน์
    // ปัจจุบัน — ทดสอบ 1170 แยกเป็นกรณี "ต้องถูกบล็อก" ด้านล่างแทน (ดู clearance2)
    const advVoucher = await makeApprovedAdvanceVoucher(5000);
    cleanup.voucherIds.push(advVoucher.id);
    const clearanceCreate = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: advVoucher.id,
      items: [
        { description: 'ค่าบริการที่ปรึกษา (ไม่มีใบกำกับภาษี)', expenseAccountCode: '5300', amount: 3000, whtRate: 3, whtIncomeTypeCode: '40_2', payeeExternalId: payee.externalPayee.id },
        { description: 'ค่าวัสดุเบ็ดเตล็ด', expenseAccountCode: '5100', amount: 2500, payeeName: 'ร้านวัสดุทดสอบ void' },
      ],
    }, idemKey('void-advcl-create'));
    const clearance = clearanceCreate.clearance;
    cleanup.clearanceIds.push(clearance.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance.id}/submit`, {}, idemKey('void-advcl-submit'));
    const clearanceApproved = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance.id}/approve`, {}, idemKey('void-advcl-approve'));
    assert(clearanceApproved.clearance.status === 'approved', `เคลียร์แล้ว overage ยังไม่ settled (ได้ ${clearanceApproved.clearance.status})`);
    const issuedCertNo = clearanceApproved.issuedWhtCertificates[0];
    assert(!!issuedCertNo, 'ออก 50 ทวิ จริง');

    const eNoPermAdv = await callExpectError('fx_maker2', 'POST', `/api/customer/advance-clearances/${clearance.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-advcl-noperm'));
    assert(eNoPermAdv.status === 403, `ไม่มีสิทธิ์ void ใบเคลียร์ -> 403 (ได้ ${eNoPermAdv.status})`);
    const eCrossAdv = await callExpectError('fx_other_co', 'POST', `/api/customer/advance-clearances/${clearance.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-advcl-cross'));
    assert(eCrossAdv.status === 404, `บริษัทอื่น void ใบเคลียร์ไม่ได้ 404 (ได้ ${eCrossAdv.status})`);
    const eSelfAdv = await callExpectError('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-advcl-self'));
    assert(eSelfAdv.status === 403, `ผู้อนุมัติ void ใบตัวเองไม่ได้ 403 (ได้ ${eSelfAdv.status})`);

    const advVoidResult = await call('fx_settler', 'POST', `/api/customer/advance-clearances/${clearance.id}/void`, { reason: 'ทดสอบยกเลิกใบเคลียร์' }, idemKey('void-advcl-real'));
    assert(advVoidResult.clearance.status === 'voided', `void ใบเคลียร์สำเร็จจริง (ได้ ${advVoidResult.clearance.status})`);

    const bal1150 = await pool.query(
      `SELECT COALESCE(SUM(l.debit_amount) - SUM(l.credit_amount), 0) AS net FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id = l.journal_entry_id
       WHERE l.account_code = '1150' AND e.source_type IN ('payment_voucher','advance_clearance') AND e.source_id = ANY($1::int[])`,
      [[advVoucher.id, clearance.id]]
    );
    assert(Number(bal1150.rows[0].net) === 5000, `1150 กลับมาค้างเท่ายอดทดรองจ่ายเดิม (5000, เหมือนตอนยังไม่เคลียร์) หลัง void (ได้ ${bal1150.rows[0].net})`);
    const netAdvCl = await netByAccount('advance_clearance', clearance.id);
    assert((netAdvCl['2110'] || 0) === 0, `2110 (เจ้าหนี้พนักงาน overage) สุทธิ = 0 หลัง void (ได้ ${netAdvCl['2110']})`);
    assert((netAdvCl['2120'] || 0) === 0, `2120 (WHT ค้างนำส่ง) สุทธิ = 0 หลัง void (ได้ ${netAdvCl['2120']})`);

    const certAfterVoid = await pool.query(`SELECT status, voided_reason FROM client_wht_certificates WHERE cert_no=$1`, [issuedCertNo]);
    assert(certAfterVoid.rows[0].status === 'voided' && !!certAfterVoid.rows[0].voided_reason, `50 ทวิ ที่ผูกกับใบเคลียร์นี้ถูก set status='voided' พร้อมเหตุผลจริง (ได้ status=${certAfterVoid.rows[0].status})`);

    // ---- ใบที่มี VAT (has_tax_invoice=true, มี 1170) ต้องถูกบล็อกไม่ให้ void เสมอ (ตกลงไว้ก่อนหน้านี้) —
    // และใช้ใบเดียวกันนี้พิสูจน์ว่าออก 50 ทวิ ใบใหม่ได้จริง เลขที่ไม่ซ้ำกับใบที่ voided ไปแล้วข้างบน ----
    const advVoucher2 = await makeApprovedAdvanceVoucher(5000);
    cleanup.voucherIds.push(advVoucher2.id);
    const clearance2Create = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
      advanceVoucherId: advVoucher2.id,
      items: [{ description: 'ค่าบริการที่ปรึกษา มีใบกำกับภาษี', expenseAccountCode: '5300', amount: 3000, hasTaxInvoice: true, vatRate: 7, whtRate: 3, whtIncomeTypeCode: '40_2', payeeExternalId: payee.externalPayee.id }],
    }, idemKey('void-advcl-create2'));
    cleanup.clearanceIds.push(clearance2Create.clearance.id);
    await call('fx_maker', 'POST', `/api/customer/advance-clearances/${clearance2Create.clearance.id}/submit`, {}, idemKey('void-advcl-submit2'));
    const clearance2Approved = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${clearance2Create.clearance.id}/approve`, {}, idemKey('void-advcl-approve2'));
    const newCertNo = clearance2Approved.issuedWhtCertificates[0];
    assert(!!newCertNo && newCertNo !== issuedCertNo, `ออก 50 ทวิ ใบใหม่ได้จริง เลขที่ไม่ซ้ำกับใบที่ voided (เดิม ${issuedCertNo}, ใหม่ ${newCertNo})`);
    const netAdvCl2 = await netByAccount('advance_clearance', clearance2Create.clearance.id);
    assert((netAdvCl2['1170'] || 0) === 210, `ใบนี้มี 1170 (ภาษีซื้อ) จริงจากการมีใบกำกับภาษี = 210 (7% ของ 3000) (ได้ ${netAdvCl2['1170']})`);
    const eVatBlock = await callExpectError('fx_settler', 'POST', `/api/customer/advance-clearances/${clearance2Create.clearance.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-advcl-vatblock'));
    assert(eVatBlock.status === 400 && /ใบกำกับภาษี/.test(eVatBlock.body.error), `ใบที่มีใบกำกับภาษีเต็มรูป (1170>0) ถูกบล็อกไม่ให้ void จริง 400 (ได้ status=${eVatBlock.status}, "${eVatBlock.body.error}")`);

    // ---- monthly ภ.ง.ด. summary กรอง status='active' เท่านั้น ----
    const summaryRes = await call('fx_super', 'GET', `/api/customer/wht-payable-summary?year=${curYear}&month=${curMonth}`);
    const voidedCertRow = await pool.query('SELECT payment_date FROM client_wht_certificates WHERE cert_no=$1', [issuedCertNo]);
    const voidedPeriod = (await pool.query(`SELECT to_char($1::date,'YYYY-MM') AS p`, [voidedCertRow.rows[0].payment_date])).rows[0].p;
    if (voidedPeriod === currentYYYYMM) {
      const totalWhtInSummary = summaryRes.summary.filter(s => s.whtIncomeTypeCode === '40_2').reduce((s, r) => s + r.totalWht, 0);
      const stillCountsVoided = await pool.query(
        `SELECT SUM(wht_amount) AS total FROM client_wht_certificates WHERE company_id=$1 AND wht_income_type_code='40_2' AND status='active' AND to_char(payment_date,'YYYY-MM')=$2`,
        [COMPANY_A_ID, currentYYYYMM]
      );
      assert(Math.abs(totalWhtInSummary - Number(stillCountsVoided.rows[0].total || 0)) < 0.01,
        `wht-payable-summary กรอง status='active' เท่านั้น ไม่รวมยอดของใบที่ voided แล้ว (summary=${totalWhtInSummary}, active-only=${stillCountsVoided.rows[0].total})`);
    }

    // ============================================================================================
    // (C) client_subcontract_billings (progress) — 1160 recovery / 2140 retention / 2120 WHT ต้องกลับ
    // ============================================================================================
    console.log('\n=== (C) subcontract_billing (progress) ===');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E void subcontract โครงการ', sectorType: 'private', status: 'in_progress' });
    cleanup.projectIds.push(proj.project.id);
    const subTaxId = String(1000000000000 + (Date.now() % 1000000000000)).padStart(13, '0').slice(0, 13);
    const sub = await call('fx_procurement', 'POST', '/api/customer/subcontractors', { name: 'E2E void ผู้รับเหมาช่วง ' + Date.now(), taxpayerType: 'individual', taxId: subTaxId });
    cleanup.subcontractorIds.push(sub.subcontractor.id);
    const term = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: sub.subcontractor.id, projectId: proj.project.id, contractValue: 40000, advancePercent: 15, retentionPercent: 5,
    }, idemKey('void-sb-term-create'));
    cleanup.termIds.push(term.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/submit`, {}, idemKey('void-sb-term-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/approve`, {}, idemKey('void-sb-term-approve'));

    const adv = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'advance', grossAmount: 6000, whtRate: 3,
    }, idemKey('void-sb-adv-create'));
    cleanup.billingIds.push(adv.subcontractBilling.id);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${adv.subcontractBilling.id}/submit`, {}, idemKey('void-sb-adv-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${adv.subcontractBilling.id}/approve`, {}, idemKey('void-sb-adv-approve'));

    const prog = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'progress', grossAmount: 20000,
    }, idemKey('void-sb-prog-create'));
    cleanup.billingIds.push(prog.subcontractBilling.id);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/submit`, {}, idemKey('void-sb-prog-submit'));
    const progApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/approve`, {}, idemKey('void-sb-prog-approve'));
    assert(progApproved.subcontractBilling.status === 'approved', 'อนุมัติใบเบิกงวดงานสำเร็จ');
    const sbCertNo = progApproved.issuedWhtCertificate;
    assert(!!sbCertNo, 'ออก 50 ทวิ สำหรับงวดงานจริง');

    const balBeforeVoidSb = await call('fx_maker', 'GET', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/balance`);
    assert(balBeforeVoidSb.advanceOutstanding === 3000 && balBeforeVoidSb.retentionHeld === 1000, 'ก่อน void: เงินล่วงหน้าคงค้าง 3000, เงินประกันผลงาน 1000 (ตามที่คำนวณจากงวดงาน)');

    const eNoPermSb = await callExpectError('fx_maker2', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-sb-noperm'));
    assert(eNoPermSb.status === 403, `ไม่มีสิทธิ์ void ใบเบิกผู้รับเหมาช่วง -> 403 (ได้ ${eNoPermSb.status})`);
    const eCrossSb = await callExpectError('fx_other_co', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-sb-cross'));
    assert(eCrossSb.status === 404, `บริษัทอื่น void ไม่ได้ 404 (ได้ ${eCrossSb.status})`);
    const eSelfSb = await callExpectError('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-sb-self'));
    assert(eSelfSb.status === 403, `ผู้อนุมัติ void ใบตัวเองไม่ได้ 403 (ได้ ${eSelfSb.status})`);

    const sbVoidResult = await call('fx_settler', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/void`, { reason: 'ทดสอบยกเลิกใบเบิกงวดงาน' }, idemKey('void-sb-real'));
    assert(sbVoidResult.subcontractBilling.status === 'voided', `void สำเร็จจริง (ได้ ${sbVoidResult.subcontractBilling.status})`);

    const balAfterVoidSb = await call('fx_maker', 'GET', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/balance`);
    assert(balAfterVoidSb.advanceOutstanding === 6000, `เงินล่วงหน้าคงค้างกลับเป็น 6000 (เท่ากับตอนก่อนเบิกงวดงาน — ยอดหักคืน 3000 จากงวดงานถูกยกเลิกไปด้วย) (ได้ ${balAfterVoidSb.advanceOutstanding})`);
    assert(balAfterVoidSb.retentionHeld === 0, `เงินประกันผลงานที่กันไว้กลับเป็น 0 หลัง void (ได้ ${balAfterVoidSb.retentionHeld})`);

    const netSb = await netByAccount('subcontract_billing', prog.subcontractBilling.id);
    assert((netSb['1160'] || 0) === 0, `1160 (เงินจ่ายล่วงหน้าผู้รับเหมาช่วง) สุทธิ = 0 หลัง void งวดงานนี้ (ได้ ${netSb['1160']})`);
    assert((netSb['2140'] || 0) === 0, `2140 (เงินประกันผลงานค้างจ่าย) สุทธิ = 0 หลัง void (ได้ ${netSb['2140']})`);
    assert((netSb['2120'] || 0) === 0, `2120 (WHT ค้างนำส่ง) สุทธิ = 0 หลัง void (ได้ ${netSb['2120']})`);
    const sbCertAfter = await pool.query('SELECT status FROM client_wht_certificates WHERE cert_no=$1', [sbCertNo]);
    assert(sbCertAfter.rows[0].status === 'voided', '50 ทวิ ของใบเบิกงวดงานนี้ถูก voided ไปด้วย');

    // ============================================================================================
    // (D) client_progress_claims — ซับซ้อนสุด: claimed_percent/applied_amount ต้องคืน + client_revenue
    // เป็น voided + บล็อกถ้าถูกเบิกไปแล้ว/มีลูกค้าชำระเงินแล้ว
    // ============================================================================================
    console.log('\n=== (D) progress_claim ===');
    const projInst = await call('fx_maker', 'POST', '/api/customer/projects', {
      name: 'E2E void progress โครงการ', sectorType: 'private', status: 'in_progress', defaultRetentionPercent: 5,
      installments: [{ description: 'งวดที่ 1', amount: 40000, daysToComplete: 30 }],
    });
    cleanup.projectIds.push(projInst.project.id);
    const projInstDetail = await call('fx_maker', 'GET', `/api/customer/projects/${projInst.project.id}`);
    const installment1 = projInstDetail.installments[0];

    // ---- D1: advance + progress ที่ apply advance offset -> void progress claim -> applied_amount กลับ ----
    const advClaim = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'advance', requestedAmount: 10000,
    }, idemKey('void-pc-adv-create'));
    cleanup.claimIds.push(advClaim.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${advClaim.progressClaim.id}/submit`, {}, idemKey('void-pc-adv-submit'));
    const advClaimApproved = await call('fx_super', 'POST', `/api/customer/progress-claims/${advClaim.progressClaim.id}/approve`, {}, idemKey('void-pc-adv-approve'));
    const advRevenueId = advClaimApproved.progressClaim.revenueId;

    const progClaim = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'progress', claimMode: 'installment', installmentId: installment1.id, requestedAmount: 20000,
    }, idemKey('void-pc-prog-create'));
    cleanup.claimIds.push(progClaim.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/submit`, {}, idemKey('void-pc-prog-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/certify`, { certifiedAmount: 20000, certifyNote: '' }, idemKey('void-pc-prog-certify'));
    const progClaimApproved = await call('fx_super', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/approve`, { applyAdvanceAmount: 6000 }, idemKey('void-pc-prog-approve'));
    assert(progClaimApproved.progressClaim.status === 'approved', 'อนุมัติงวดงาน (installment) พร้อมหักล้างเงินล่วงหน้าสำเร็จ');
    const progRevenueId = progClaimApproved.progressClaim.revenueId;

    // ---- บล็อก void ใบ advance ตอนที่ยังถูกเบิกไปแล้ว (applied_amount=6000>0) ----
    const eBlockedApplied = await callExpectError('fx_settler', 'POST', `/api/customer/progress-claims/${advClaim.progressClaim.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pc-adv-blocked'));
    assert(eBlockedApplied.status === 409, `void ใบ advance ที่ถูกเบิกไปแล้ว (applied_amount>0) ถูกบล็อก 409 (ได้ ${eBlockedApplied.status})`);

    const eNoPermPc = await callExpectError('fx_maker2', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pc-noperm'));
    assert(eNoPermPc.status === 403, `ไม่มีสิทธิ์ void งวดงาน -> 403 (ได้ ${eNoPermPc.status})`);
    const eCrossPc = await callExpectError('fx_other_co', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pc-cross'));
    assert(eCrossPc.status === 404, `บริษัทอื่น void ไม่ได้ 404 (ได้ ${eCrossPc.status})`);
    // self-void ครอบคลุมถึง certified_by (fx_approver_mid certify ใบนี้) แม้จะมี can_settle_cash ก็ตาม — ใช้
    // fx_approver_mid โดยตรงไม่มีสิทธิ์ void อยู่แล้ว (ไม่ใช่ super_user/can_settle_cash) จึงพิสูจน์ self-void
    // ผ่าน fx_super (ผู้อนุมัติ) แทน ซึ่งครอบคลุมทุกกรณีเดียวกัน
    const eSelfPc = await callExpectError('fx_super', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pc-self'));
    assert(eSelfPc.status === 403, `ผู้อนุมัติ (fx_super) void งวดงานที่ตัวเองอนุมัติไม่ได้ 403 (ได้ ${eSelfPc.status})`);

    const pcVoidResult = await call('fx_settler', 'POST', `/api/customer/progress-claims/${progClaim.progressClaim.id}/void`, { reason: 'ทดสอบยกเลิกงวดงาน' }, idemKey('void-pc-real'));
    assert(pcVoidResult.progressClaim.status === 'voided', `void งวดงานสำเร็จจริง (ได้ ${pcVoidResult.progressClaim.status})`);

    const advRevenueAfter = await pool.query('SELECT applied_amount FROM client_revenue WHERE id=$1', [advRevenueId]);
    assert(Number(advRevenueAfter.rows[0].applied_amount) === 0, `applied_amount ของเงินล่วงหน้าที่ถูกเบิกไปกลับเป็น 0 หลัง void งวดที่เบิกมัน (ได้ ${advRevenueAfter.rows[0].applied_amount})`);
    const applicationRowAfter = await pool.query('SELECT count(*)::int AS n FROM client_revenue_advance_applications WHERE progress_claim_id=$1', [progClaim.progressClaim.id]);
    assert(applicationRowAfter.rows[0].n === 0, 'แถวบันทึกการหักล้างเงินล่วงหน้า (client_revenue_advance_applications) ถูกลบไปด้วยหลัง void');
    const progRevenueAfter = await pool.query('SELECT status, voided_by, voided_reason, voided_at FROM client_revenue WHERE id=$1', [progRevenueId]);
    assert(progRevenueAfter.rows[0].status === 'voided' && !!progRevenueAfter.rows[0].voided_by && !!progRevenueAfter.rows[0].voided_reason && !!progRevenueAfter.rows[0].voided_at,
      'client_revenue ของงวดงานที่ void แล้วมี status=voided พร้อม voided_at/by/reason ครบ');
    const netPc = await netByAccount(['revenue', 'retention'], progRevenueId);
    Object.values(netPc).forEach((net, idx) => assert(net === 0, `บัญชีที่เกี่ยวข้องกับงวดงานนี้สุทธิ = 0 หลัง void (index ${idx}, ${JSON.stringify(netPc)})`));

    // ---- ตอนนี้ applied_amount กลับเป็น 0 แล้ว -> void ใบ advance ที่เคยถูกบล็อกไว้ ต้องทำได้แล้ว ----
    const advVoidNowOk = await call('fx_settler', 'POST', `/api/customer/progress-claims/${advClaim.progressClaim.id}/void`, { reason: 'ทดสอบยกเลิกเงินล่วงหน้าหลังหักล้างถูกคืนแล้ว' }, idemKey('void-pc-adv-real'));
    assert(advVoidNowOk.progressClaim.status === 'voided', `void ใบ advance สำเร็จได้แล้วหลัง applied_amount กลับเป็น 0 (พิสูจน์ว่า block ทำงานถูกต้องทั้งสองทิศทาง) (ได้ ${advVoidNowOk.progressClaim.status})`);

    // ---- D2: BOQ mode -> claimed_percent ต้องกลับ ----
    const projBoq = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E void BOQ โครงการ', sectorType: 'private', status: 'in_progress', defaultRetentionPercent: 5 });
    cleanup.projectIds.push(projBoq.project.id);
    const budgetCreated = await call('fx_maker', 'POST', '/api/customer/budgets', { projectId: projBoq.project.id });
    cleanup.budgetIds.push(budgetCreated.budget.id);
    await call('fx_maker', 'PUT', `/api/customer/budgets/${budgetCreated.budget.id}/items`, { items: [{ description: 'งานฐานราก', unit: 'งาน', qty: 1, materialUnitPrice: 30000, laborUnitPrice: 0 }] });
    await call('fx_maker', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/submit`, {});
    await call('fx_super', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/approve`, {});
    const approvedBudget = await call('fx_maker', 'GET', `/api/customer/budgets/${budgetCreated.budget.id}`);
    const boqItem = approvedBudget.budget.currentItems.find(it => !it.isGroup);

    const boqClaim = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projBoq.project.id, claimType: 'progress', claimMode: 'boq', items: [{ budgetItemId: boqItem.id, requestedPercent: 60 }],
    }, idemKey('void-pc-boq-create'));
    cleanup.claimIds.push(boqClaim.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${boqClaim.progressClaim.id}/submit`, {}, idemKey('void-pc-boq-submit'));
    const boqItemIdForClaim = (await pool.query('SELECT id FROM client_progress_claim_items WHERE progress_claim_id=$1', [boqClaim.progressClaim.id])).rows[0].id;
    await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${boqClaim.progressClaim.id}/certify`, { items: [{ itemId: boqItemIdForClaim, certifiedPercent: 60 }], certifyNote: '' }, idemKey('void-pc-boq-certify'));
    const boqApproved = await call('fx_super', 'POST', `/api/customer/progress-claims/${boqClaim.progressClaim.id}/approve`, {}, idemKey('void-pc-boq-approve'));
    assert(boqApproved.progressClaim.status === 'approved', 'อนุมัติ BOQ claim สำเร็จ');
    const claimedBefore = await pool.query('SELECT claimed_percent FROM client_budget_items WHERE id=$1', [boqItem.id]);
    assert(Number(claimedBefore.rows[0].claimed_percent) === 60, 'claimed_percent สะสม = 60 หลังอนุมัติ');

    const boqVoidResult = await call('fx_settler', 'POST', `/api/customer/progress-claims/${boqClaim.progressClaim.id}/void`, { reason: 'ทดสอบยกเลิก BOQ claim' }, idemKey('void-pc-boq-real'));
    assert(boqVoidResult.progressClaim.status === 'voided', `void BOQ claim สำเร็จจริง (ได้ ${boqVoidResult.progressClaim.status})`);
    const claimedAfter = await pool.query('SELECT claimed_percent FROM client_budget_items WHERE id=$1', [boqItem.id]);
    assert(Number(claimedAfter.rows[0].claimed_percent) === 0, `claimed_percent ของบรรทัด BOQ กลับเป็น 0 หลัง void (ได้ ${claimedAfter.rows[0].claimed_percent})`);

    // ---- D3: บล็อก void ถ้าลูกค้าชำระเงินจริงมาแล้ว (client_revenue_payments) ----
    const paidClaim = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'advance', requestedAmount: 4000,
    }, idemKey('void-pc-paid-create'));
    cleanup.claimIds.push(paidClaim.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${paidClaim.progressClaim.id}/submit`, {}, idemKey('void-pc-paid-submit'));
    const paidClaimApproved = await call('fx_super', 'POST', `/api/customer/progress-claims/${paidClaim.progressClaim.id}/approve`, {}, idemKey('void-pc-paid-approve'));
    const paidRevenueId = paidClaimApproved.progressClaim.revenueId;
    const paymentRow = await pool.query(
      `INSERT INTO client_revenue_payments (company_id, revenue_id, amount) VALUES ($1,$2,1000) RETURNING id`,
      [COMPANY_A_ID, paidRevenueId]
    );
    const eBlockedPayment = await callExpectError('fx_settler', 'POST', `/api/customer/progress-claims/${paidClaim.progressClaim.id}/void`, { reason: 'ทดสอบ' }, idemKey('void-pc-paid-blocked'));
    assert(eBlockedPayment.status === 409, `void ใบที่ลูกค้าชำระเงินมาแล้วจริงถูกบล็อก 409 (ได้ ${eBlockedPayment.status})`);
    await pool.query('DELETE FROM client_revenue_payments WHERE id=$1', [paymentRow.rows[0].id]);
    const paidVoidNowOk = await call('fx_settler', 'POST', `/api/customer/progress-claims/${paidClaim.progressClaim.id}/void`, { reason: 'ทดสอบหลังลบรายการชำระเงินแล้ว' }, idemKey('void-pc-paid-real'));
    assert(paidVoidNowOk.progressClaim.status === 'voided', `void สำเร็จได้หลังลบรายการชำระเงินที่บล็อกอยู่ออกแล้ว (ได้ ${paidVoidNowOk.progressClaim.status})`);

    // ============================================================================================
    // (E) Atomicity — บังคับให้พังกลางทางจริง (ไม่ใช่ mock) ด้วยการชน unique constraint ตัวเดียวกับที่ป้องกัน
    // การ reverse ซ้ำ แล้วตรวจว่าไม่มีอะไรค้างเลยสักจุด
    // ============================================================================================
    console.log('\n=== (E) Atomicity: forced mid-transaction failure ===');
    const atomClaim = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'progress', claimMode: 'installment', installmentId: installment1.id, requestedAmount: 8000,
    }, idemKey('void-atom-create'));
    cleanup.claimIds.push(atomClaim.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${atomClaim.progressClaim.id}/submit`, {}, idemKey('void-atom-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${atomClaim.progressClaim.id}/certify`, { certifiedAmount: 8000, certifyNote: '' }, idemKey('void-atom-certify'));
    const atomApproved = await call('fx_super', 'POST', `/api/customer/progress-claims/${atomClaim.progressClaim.id}/approve`, {}, idemKey('void-atom-approve'));
    const atomRevenueId = atomApproved.progressClaim.revenueId;
    const atomEntriesBefore = await journalEntriesFor(['revenue', 'retention'], atomRevenueId);
    assert(atomEntriesBefore.length === 2, `fixture มี journal entry 2 แถวพอดี (revenue + retention เพราะ defaultRetentionPercent=5%) ก่อนทดสอบ atomicity (ได้ ${atomEntriesBefore.length})`);
    const revenueEntry = atomEntriesBefore.find(e => e.source_type === 'revenue');
    const retentionEntry = atomEntriesBefore.find(e => e.source_type === 'retention');
    assert(!!revenueEntry && !!retentionEntry && revenueEntry.id < retentionEntry.id, 'revenue entry ถูกสร้างก่อน retention entry จริง (id น้อยกว่า) -> loop จะ reverse revenue สำเร็จก่อนแล้วค่อยไปพังที่ retention');

    // วางกับดักไว้ล่วงหน้าจากนอกทรานแซกชัน: ปิดใช้งานบัญชี 1250 (ลูกหนี้เงินประกันผลงาน) ชั่วคราว — บัญชีนี้
    // ใช้เฉพาะใน entry ประเภท retention เท่านั้น (revenue ใช้ 1200/4100 ไม่โดนกระทบ) createClientJournalEntry
    // เช็ค is_active=true ของทุกบัญชีก่อน INSERT เสมอ (ดูฟังก์ชันจริง) ดังนั้น reverse revenue (บัญชียัง
    // active ครบ) จะสำเร็จก่อนในทรานแซกชันเดียวกัน แล้วค่อยไปพังจริงตอน reverse retention (ชน 1250 ที่ปิดไว้)
    // — วิธีนี้ไม่ชนกับ logic "กันข้าม reverse ซ้ำ" ของ findReversibleJournalEntries เอง (ต่างจากการลอง
    // insert แถวชน unique index ตรงๆ ที่ทำให้ retention entry ถูกกรองออกจากรายการที่ต้อง reverse ไปเลยตั้งแต่
    // ต้น ไม่ทันได้ลองจริง — พบระหว่างเขียนเทสนี้เอง)
    await pool.query(`UPDATE client_chart_of_accounts SET is_active=false WHERE company_id=$1 AND code='1250'`, [COMPANY_A_ID]);
    try {
      let atomError = null;
      try {
        await call('fx_settler', 'POST', `/api/customer/progress-claims/${atomClaim.progressClaim.id}/void`, { reason: 'ทดสอบ atomicity ตั้งใจให้พัง' }, idemKey('void-atom-real'));
      } catch (e) { atomError = e; }
      assert(atomError !== null, `การ void ที่ถูกบังคับให้พังกลางทางล้มเหลวจริง (ไม่ได้ตอบ 200 มาแบบผิดๆ) (ได้ status=${atomError && atomError.status})`);

      const revenueEntryAfter = await pool.query('SELECT count(*)::int AS n FROM client_journal_entries WHERE reverses_entry_id=$1', [revenueEntry.id]);
      assert(revenueEntryAfter.rows[0].n === 0, `revenue entry ที่ "reverse สำเร็จไปแล้วในทรานแซกชัน" ก่อนจะพังที่ retention ต้องไม่เหลือร่องรอยเลยหลัง ROLLBACK (ได้ ${revenueEntryAfter.rows[0].n} แถว)`);
      const retentionEntryAfter = await pool.query('SELECT count(*)::int AS n FROM client_journal_entries WHERE reverses_entry_id=$1', [retentionEntry.id]);
      assert(retentionEntryAfter.rows[0].n === 0, `retention entry (จุดที่พังจริง) ก็ไม่มี reversal ค้างอยู่บางส่วนเช่นกัน (ได้ ${retentionEntryAfter.rows[0].n} แถว)`);
      const claimAfterAtom = await pool.query('SELECT status, voided_by, voided_reason, voided_at FROM client_progress_claims WHERE id=$1', [atomClaim.progressClaim.id]);
      assert(claimAfterAtom.rows[0].status === 'approved' && claimAfterAtom.rows[0].voided_by === null, `สถานะเอกสารไม่เปลี่ยนเลยหลังพังกลางทาง (ยังเป็น approved, voided_by ยัง NULL) (ได้ status=${claimAfterAtom.rows[0].status})`);
      const revenueAfterAtom = await pool.query('SELECT status, applied_amount FROM client_revenue WHERE id=$1', [atomRevenueId]);
      assert(revenueAfterAtom.rows[0].status === 'active', `client_revenue ไม่ถูก void ค้างไว้บางส่วนเลย ยังเป็น active (ได้ ${revenueAfterAtom.rows[0].status})`);
    } finally {
      // คืนสถานะ 1250 เสมอไม่ว่าผลเทสข้างบนจะเป็นอย่างไร — ตารางนี้เป็น master ร่วมทั้งบริษัท เทสไฟล์อื่น
      // (subcontract-billings, progress-claims-ui ฯลฯ) ต้องใช้บัญชีนี้ได้ตามปกติเสมอ
      await pool.query(`UPDATE client_chart_of_accounts SET is_active=true WHERE company_id=$1 AND code='1250'`, [COMPANY_A_ID]);
    }
    const atomVoidRealNow = await call('fx_settler', 'POST', `/api/customer/progress-claims/${atomClaim.progressClaim.id}/void`, { reason: 'ทดสอบหลังคืนสถานะบัญชี 1250 แล้ว' }, idemKey('void-atom-clean'));
    assert(atomVoidRealNow.progressClaim.status === 'voided', `หลังคืนบัญชี 1250 กลับมา active แล้ว void ทำสำเร็จตามปกติ พิสูจน์ว่าความล้มเหลวก่อนหน้าไม่ได้ทิ้งสถานะแปลกปลอมไว้ (ได้ ${atomVoidRealNow.progressClaim.status})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      // ป้องกัน pollution ข้ามรัน — เอกสาร void/approved ที่สร้างในไฟล์นี้ (โดยเฉพาะ voucherType='advance'
      // ที่ยัง outstanding อยู่จริงหลัง void ใบเคลียร์คืนสถานะ) จะไปกระทบ assertion แบบยอดรวมเป๊ะของไฟล์เทส
      // อื่น (เช่น advance-vouchers-ui.regression.js ที่ query ยอดคงค้างของพนักงานคนเดียวกันข้ามทั้งบริษัท)
      // ถ้าไม่ลบทิ้งให้หมดทุกครั้ง — พบจริงระหว่างพัฒนาไฟล์นี้ (ต้องเขียนสคริปต์ล้าง pollution แยกทำความ
      // สะอาดของเก่าที่ค้างจากการรันมือหลายรอบก่อนจะผ่านทั้งชุดได้)
      const findEntryIds = async (sourceType, ids) => ids.length ? (await pool.query('SELECT id FROM client_journal_entries WHERE source_type=$1 AND source_id = ANY($2)', [sourceType, ids])).rows.map(r => r.id) : [];
      const claimRevenueIds = cleanup.claimIds.length ? (await pool.query('SELECT revenue_id FROM client_progress_claims WHERE id = ANY($1) AND revenue_id IS NOT NULL', [cleanup.claimIds])).rows.map(r => r.revenue_id) : [];
      const advClearanceItemIds = cleanup.clearanceIds.length ? (await pool.query('SELECT id FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [cleanup.clearanceIds])).rows.map(r => r.id) : [];

      let allEntryIds = [];
      allEntryIds.push(...await findEntryIds('payment_voucher', cleanup.voucherIds));
      allEntryIds.push(...await findEntryIds('advance_clearance', cleanup.clearanceIds));
      allEntryIds.push(...await findEntryIds('subcontract_billing', cleanup.billingIds));
      allEntryIds.push(...await findEntryIds('revenue', claimRevenueIds));
      allEntryIds.push(...await findEntryIds('retention', claimRevenueIds));
      if (allEntryIds.length) {
        await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [allEntryIds]);
        await pool.query('DELETE FROM client_journal_entries WHERE reverses_entry_id = ANY($1)', [allEntryIds]); // reversals of ours go first (FK self-ref)
        await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [allEntryIds]);
      }

      await pool.query(`DELETE FROM client_wht_certificates WHERE (source_type='advance_clearance_item' AND source_id = ANY($1)) OR (source_type='subcontractor_payment' AND source_id = ANY($2)) OR (source_type='payment_voucher' AND source_id = ANY($3))`, [advClearanceItemIds, cleanup.billingIds, cleanup.voucherIds]);

      for (const [docType, ids] of [['payment_voucher', cleanup.voucherIds], ['advance_clearance', cleanup.clearanceIds], ['subcontractor_payment', cleanup.billingIds], ['progress_claim', cleanup.claimIds]]) {
        if (ids.length) await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=$1 AND doc_id = ANY($2)', [docType, ids]);
      }

      if (cleanup.claimIds.length) {
        await pool.query('DELETE FROM client_revenue_advance_applications WHERE progress_claim_id = ANY($1)', [cleanup.claimIds]);
        await pool.query('UPDATE client_progress_claims SET revenue_id=NULL WHERE id = ANY($1)', [cleanup.claimIds]);
      }
      if (claimRevenueIds.length) {
        await pool.query('DELETE FROM client_revenue_payments WHERE revenue_id = ANY($1)', [claimRevenueIds]);
        await pool.query('DELETE FROM client_revenue WHERE id = ANY($1)', [claimRevenueIds]);
      }
      if (cleanup.claimIds.length) {
        await pool.query('DELETE FROM client_progress_claim_items WHERE progress_claim_id = ANY($1)', [cleanup.claimIds]);
        await pool.query('DELETE FROM client_progress_claims WHERE id = ANY($1)', [cleanup.claimIds]);
      }
      if (cleanup.clearanceIds.length) {
        await pool.query('DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [cleanup.clearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [cleanup.clearanceIds]);
      }
      if (cleanup.voucherIds.length) await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [cleanup.voucherIds]);
      if (cleanup.billingIds.length) await pool.query('DELETE FROM client_subcontract_billings WHERE id = ANY($1)', [cleanup.billingIds]);
      if (cleanup.termIds.length) await pool.query('DELETE FROM client_subcontract_terms WHERE id = ANY($1)', [cleanup.termIds]);
      if (cleanup.subcontractorIds.length) await pool.query('DELETE FROM client_subcontractors WHERE id = ANY($1)', [cleanup.subcontractorIds]);
      if (cleanup.budgetIds.length) {
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id = ANY($1)', [cleanup.budgetIds]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id = ANY($1)', [cleanup.budgetIds]);
        await pool.query('DELETE FROM client_budgets WHERE id = ANY($1)', [cleanup.budgetIds]);
      }
      if (cleanup.projectIds.length) await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [cleanup.projectIds]);
      if (cleanup.fundIds.length) await pool.query('DELETE FROM client_petty_cash_funds WHERE id = ANY($1)', [cleanup.fundIds]);
      if (cleanup.payeeIds.length) await pool.query('DELETE FROM client_external_payees WHERE id = ANY($1)', [cleanup.payeeIds]);

      await pool.query(`UPDATE client_chart_of_accounts SET is_active=true WHERE company_id=$1 AND code='1250'`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'void-%'`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
