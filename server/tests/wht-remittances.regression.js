// Regression suite — WHT remittance batches (migration 0022): record a receipt_no/paid_date for a whole
// (wht_form, period) at once, post the Dr 2120 / Cr 1100 journal entry, and link every active cert of
// that period to the batch. Covers: pending-summary math excludes voided certs and separates pnd3/pnd53
// correctly, successful creation + journal correctness (2120 nets to 0 for the period, Dr=Cr balanced),
// duplicate-period rejection, permission gating, PUT correction of receiptNo/paidDate only, export
// produces a real readable .xlsx whose rows match the certificate actually remitted, and the /void block
// (with receipt_no + paid_date in the message) once a cert has been remitted.
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/wht-remittances.regression.js
const ExcelJS = require('exceljs');
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
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('spreadsheet')) {
    if (!res.ok) { const e = new Error('export failed'); e.status = res.status; throw e; }
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType, buffer: buf };
  }
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

async function makeApprovedAdvanceVoucher(amount) {
  const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'advance', payeeEmployeeId: 2, purpose: 'E2E remit advance', amount,
  }, idemKey('remit-advv-create'));
  await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('remit-advv-submit'));
  return (await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('remit-advv-approve'))).voucher;
}
// สร้างใบเคลียร์เงินทดรองจ่าย 1 บรรทัดที่มี WHT ผูกกับ payeeExternalId ที่ระบุ -> คืน {clearanceId, certNo}
async function makeApprovedClearanceWithWht(payeeExternalId, amount, whtRate) {
  const voucher = await makeApprovedAdvanceVoucher(amount);
  const created = await call('fx_maker', 'POST', '/api/customer/advance-clearances', {
    advanceVoucherId: voucher.id,
    items: [{ description: 'E2E remit ค่าบริการ', expenseAccountCode: '5300', amount, whtRate, whtIncomeTypeCode: '40_2', payeeExternalId }],
  }, idemKey('remit-advcl-create'));
  await call('fx_maker', 'POST', `/api/customer/advance-clearances/${created.clearance.id}/submit`, {}, idemKey('remit-advcl-submit'));
  const approved = await call('fx_approver_mid', 'POST', `/api/customer/advance-clearances/${created.clearance.id}/approve`, {}, idemKey('remit-advcl-approve'));
  return { clearanceId: created.clearance.id, certNo: approved.issuedWhtCertificates[0], voucherId: voucher.id };
}

(async () => {
  const cleanup = { voucherIds: [], clearanceIds: [], payeeIds: [], remittanceIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    for (const u of ['fx_maker', 'fx_approver_mid', 'fx_super', 'fx_settler', 'fx_maker2']) await login(u, codeA);

    const timestamp = Date.now();
    const juristicTaxId = '1' + String(timestamp).padStart(12, '0').slice(0, 12);
    const individualTaxId = '2' + String(timestamp).padStart(12, '0').slice(0, 12);
    const juristicPayee = await call('fx_super', 'POST', '/api/customer/external-payees', { name: `E2E remit juristic ${timestamp}`, taxpayerType: 'juristic', taxId: juristicTaxId });
    const individualPayee = await call('fx_super', 'POST', '/api/customer/external-payees', { name: `E2E remit individual ${timestamp}`, taxpayerType: 'individual', taxId: individualTaxId });
    cleanup.payeeIds.push(juristicPayee.externalPayee.id, individualPayee.externalPayee.id);

    // cert1: pnd53 (juristic) — จะถูกนำส่งจริงในเทสนี้
    const cert1 = await makeApprovedClearanceWithWht(juristicPayee.externalPayee.id, 3000, 3);
    // cert2: pnd3 (individual) — ปล่อยไว้เป็น active/pending ต่อไป พิสูจน์แยก bucket และยอดรวมถูกต้อง
    const cert2 = await makeApprovedClearanceWithWht(individualPayee.externalPayee.id, 4000, 3);
    // cert3: pnd3 (individual) เหมือนกัน — จะถูก void ทิ้งก่อนนำส่ง พิสูจน์ pending sum ไม่นับใบที่ voided
    const cert3 = await makeApprovedClearanceWithWht(individualPayee.externalPayee.id, 1000, 3);
    for (const c of [cert1, cert2, cert3]) { cleanup.voucherIds.push(c.voucherId); cleanup.clearanceIds.push(c.clearanceId); }

    const cert1Row = (await pool.query('SELECT id, wht_form, wht_amount, to_char(payment_date,\'YYYY\') AS yr, to_char(payment_date,\'MM\') AS mo FROM client_wht_certificates WHERE cert_no=$1', [cert1.certNo])).rows[0];
    const cert2Row = (await pool.query('SELECT id, wht_form, wht_amount FROM client_wht_certificates WHERE cert_no=$1', [cert2.certNo])).rows[0];
    const cert3Row = (await pool.query('SELECT id, wht_form, wht_amount FROM client_wht_certificates WHERE cert_no=$1', [cert3.certNo])).rows[0];
    assert(cert1Row.wht_form === 'pnd53', `cert1 (juristic) เป็น pnd53 จริง (ได้ ${cert1Row.wht_form})`);
    assert(cert2Row.wht_form === 'pnd3' && cert3Row.wht_form === 'pnd3', `cert2/cert3 (individual) เป็น pnd3 จริง (ได้ ${cert2Row.wht_form}/${cert3Row.wht_form})`);
    const periodYear = parseInt(cert1Row.yr, 10);
    const periodMonth = parseInt(cert1Row.mo, 10);

    // void cert3's ต้นทาง ก่อน (ไม่มี VAT อยู่แล้ว ไม่ถูก VAT-block) — self-void ไม่เกี่ยวเพราะใช้ fx_settler
    // ซึ่งไม่ใช่ผู้สร้าง/ยื่น/อนุมัติของใบนี้เลย
    await call('fx_settler', 'POST', `/api/customer/advance-clearances/${cert3.clearanceId}/void`, { reason: 'ทดสอบ pending sum ไม่นับใบ voided' }, idemKey('remit-void-cert3'));
    const cert3After = await pool.query('SELECT status FROM client_wht_certificates WHERE cert_no=$1', [cert3.certNo]);
    assert(cert3After.rows[0].status === 'voided', 'cert3 ถูก void ไปด้วยจริงหลัง void เอกสารต้นทาง');

    // ---- pending summary: แยก bucket pnd3/pnd53 ถูกต้อง + ยอด pnd3 นับเฉพาะ cert2 (active) ไม่นับ cert3 (voided) ----
    const pendingBefore = await call('fx_super', 'GET', '/api/customer/wht-remittances/pending');
    const bucket53 = pendingBefore.pending.find(p => p.whtForm === 'pnd53' && p.periodYear === periodYear && p.periodMonth === periodMonth);
    const bucket3 = pendingBefore.pending.find(p => p.whtForm === 'pnd3' && p.periodYear === periodYear && p.periodMonth === periodMonth);
    assert(!!bucket53 && !!bucket3, 'pending summary แยก bucket pnd53 และ pnd3 ออกจากกันจริงตาม wht_form');
    // ยอด pnd3 อาจมีใบอื่นจากรอบทดสอบก่อนหน้าปนอยู่ได้ (ตาราง fixture ใช้ร่วมกันข้ามรอบรัน) — เช็คว่า cert2
    // อยู่ในยอดจริง (ยอด >= cert2 amount) และ cert3 (voided) ไม่ถูกนับซ้ำสองเท่าของตัวเอง แทนที่จะเทียบ "="
    // ตรงๆ ซึ่งจะเปราะกับข้อมูลเก่าที่ค้างอยู่ (บทเรียนจากการเทส /void ก่อนหน้านี้)
    const directSumPnd3 = await pool.query(
      `SELECT COALESCE(SUM(wht_amount),0) AS total FROM client_wht_certificates
       WHERE company_id=$1 AND wht_form='pnd3' AND status='active' AND remittance_id IS NULL
         AND to_char(payment_date,'YYYY')=$2 AND to_char(payment_date,'MM')=$3`,
      [COMPANY_A_ID, cert1Row.yr, cert1Row.mo]
    );
    assert(Math.abs(bucket3.totalWht - Number(directSumPnd3.rows[0].total)) < 0.01,
      `ยอดรวม pending ของ pnd3 ตรงกับ SUM(wht_amount) ที่ status='active' AND remittance_id IS NULL ตรงๆ จาก DB เป๊ะ (API=${bucket3.totalWht}, DB=${directSumPnd3.rows[0].total}) — พิสูจน์ว่าไม่นับ cert3 ที่ voided ไปแล้ว`);
    assert(typeof bucket53.daysUntilOnlineDeadline === 'number' && !!bucket53.onlineDeadline && !!bucket53.paperDeadline,
      `bucket มี deadline ครบ (paper=${bucket53.paperDeadline}, online=${bucket53.onlineDeadline}, daysLeft=${bucket53.daysUntilOnlineDeadline})`);

    // ---- ไม่มีสิทธิ์ -> 403 ----
    const eNoPerm = await callExpectError('fx_maker2', 'POST', '/api/customer/wht-remittances', {
      whtForm: 'pnd53', periodYear, periodMonth, receiptNo: 'RCPT-TEST', paidDate: '2026-01-01',
    }, idemKey('remit-noperm'));
    assert(eNoPerm.status === 403, `ไม่มีสิทธิ์บันทึกการนำส่ง -> 403 (ได้ ${eNoPerm.status})`);

    // ---- บันทึกนำส่งจริง (เฉพาะ pnd53 — cert1) ----
    const remitResult = await call('fx_settler', 'POST', '/api/customer/wht-remittances', {
      whtForm: 'pnd53', periodYear, periodMonth, receiptNo: 'RCPT-E2E-0001', paidDate: '2026-01-05',
    }, idemKey('remit-create'));
    assert(!!remitResult.remittanceId, 'บันทึกการนำส่งสำเร็จจริง ได้ remittanceId กลับมา');
    cleanup.remittanceIds.push(remitResult.remittanceId);
    assert(Number(remitResult.totalWht) === Number(cert1Row.wht_amount), `totalWht ของชุดนี้ตรงกับ wht_amount ของ cert1 พอดี (ไม่มีใบ pnd53 อื่นปนมา ได้ ${remitResult.totalWht} คาดหวัง ${cert1Row.wht_amount})`);

    const certAfter = await pool.query('SELECT remittance_id FROM client_wht_certificates WHERE cert_no=$1', [cert1.certNo]);
    assert(certAfter.rows[0].remittance_id === remitResult.remittanceId, 'cert1 ถูกผูกเข้าชุดนำส่งนี้จริงใน DB');
    const cert2Untouched = await pool.query('SELECT remittance_id, status FROM client_wht_certificates WHERE cert_no=$1', [cert2.certNo]);
    assert(cert2Untouched.rows[0].remittance_id === null && cert2Untouched.rows[0].status === 'active', 'cert2 (คนละ wht_form) ไม่ถูกแตะต้องเลยจากการนำส่ง pnd53 ครั้งนี้');

    // ---- journal ของชุดนำส่ง: สมดุล Dr=Cr และถูกบัญชี ----
    const journalRes = await pool.query(
      `SELECT jl.account_code, jl.debit_amount, jl.credit_amount FROM client_journal_entry_lines jl
       JOIN client_journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.source_type='manual' AND je.source_id=$1 ORDER BY jl.account_code`,
      [remitResult.remittanceId]
    );
    const totalDebit = journalRes.rows.reduce((s, l) => s + Number(l.debit_amount), 0);
    const totalCredit = journalRes.rows.reduce((s, l) => s + Number(l.credit_amount), 0);
    assert(totalDebit === totalCredit && totalDebit === remitResult.totalWht, `journal ของชุดนำส่งสมดุล SUM(debit)=SUM(credit)=${totalDebit} เท่ากับยอดนำส่งจริง`);
    const dr2120 = journalRes.rows.find(l => l.account_code === '2120');
    const cr1100 = journalRes.rows.find(l => l.account_code === '1100');
    assert(!!dr2120 && Number(dr2120.debit_amount) === remitResult.totalWht, `journal: Dr 2120 = ${remitResult.totalWht} ตรงตามยอดนำส่ง (ได้ ${dr2120 && dr2120.debit_amount})`);
    assert(!!cr1100 && Number(cr1100.credit_amount) === remitResult.totalWht, `journal: Cr 1100 = ${remitResult.totalWht} เท่ากัน (ได้ ${cr1100 && cr1100.credit_amount})`);

    // ---- 2120 ของธุรกรรมนี้ (การหัก ณ ที่จ่ายตอน approve clearance + การนำส่งตอนนี้) net = 0 พอดี ----
    const net2120 = await pool.query(
      `SELECT COALESCE(SUM(l.debit_amount) - SUM(l.credit_amount), 0) AS net FROM client_journal_entry_lines l
       JOIN client_journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_code='2120' AND (
         (je.source_type='advance_clearance' AND je.source_id=$1) OR
         (je.source_type='manual' AND je.source_id=$2)
       )`,
      [cert1.clearanceId, remitResult.remittanceId]
    );
    assert(Number(net2120.rows[0].net) === 0, `บัญชี 2120 ของธุรกรรมนี้ (หัก ณ ที่จ่ายตอนอนุมัติ + นำส่งตอนนี้) net = 0 พอดี (ได้ ${net2120.rows[0].net})`);

    // ---- pending summary ต้องไม่เห็น bucket pnd53 นี้อีกแล้ว (ผูกครบแล้ว) แต่ยัง เห็น pnd3 อยู่เหมือนเดิม ----
    const pendingAfter = await call('fx_super', 'GET', '/api/customer/wht-remittances/pending');
    const bucket53After = pendingAfter.pending.find(p => p.whtForm === 'pnd53' && p.periodYear === periodYear && p.periodMonth === periodMonth);
    const bucket3After = pendingAfter.pending.find(p => p.whtForm === 'pnd3' && p.periodYear === periodYear && p.periodMonth === periodMonth);
    assert(!bucket53After, 'pending summary ไม่เห็น bucket pnd53 งวดนี้อีกแล้วหลังนำส่งครบ');
    assert(!!bucket3After, 'pending summary ยังเห็น bucket pnd3 อยู่เหมือนเดิม (คนละ wht_form ไม่ถูกกระทบ)');

    // ---- ยื่นซ้ำงวด+ฟอร์มเดิม -> 409 ----
    const eDup = await callExpectError('fx_settler', 'POST', '/api/customer/wht-remittances', {
      whtForm: 'pnd53', periodYear, periodMonth, receiptNo: 'RCPT-DUP', paidDate: '2026-01-06',
    }, idemKey('remit-dup'));
    assert(eDup.status === 409, `ยื่นซ้ำงวด+ฟอร์มเดิม -> 409 (ได้ ${eDup.status})`);

    // ---- แก้ไข receiptNo/paidDate (แก้ typo) ----
    const putResult = await call('fx_settler', 'PUT', `/api/customer/wht-remittances/${remitResult.remittanceId}`, {
      receiptNo: 'RCPT-E2E-0001-FIXED', paidDate: '2026-01-06',
    });
    assert(putResult.ok === true, 'แก้ไขเลขที่ใบเสร็จ/วันที่ชำระสำเร็จจริง');
    const remitRow = await pool.query('SELECT receipt_no, to_char(paid_date,\'YYYY-MM-DD\') AS pd FROM client_wht_remittances WHERE id=$1', [remitResult.remittanceId]);
    assert(remitRow.rows[0].receipt_no === 'RCPT-E2E-0001-FIXED' && remitRow.rows[0].pd === '2026-01-06', 'ค่าที่แก้ไขบันทึกลง DB ถูกต้องจริง');

    // ---- export Excel: ได้ไฟล์จริงที่เปิดได้ และข้อมูลตรงกับที่อยู่ใน DB (= ที่แสดงบนหน้าจอ) ----
    const exportResult = await call('fx_super', 'GET', `/api/customer/wht-remittances/export?whtForm=pnd53&year=${periodYear}&month=${periodMonth}`);
    assert(exportResult.contentType.includes('spreadsheet'), `export คืน content-type เป็น Excel จริง (ได้ ${exportResult.contentType})`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportResult.buffer);
    const sheet = workbook.worksheets[0];
    assert(!!sheet, 'ไฟล์ .xlsx ที่ได้เปิดอ่านได้จริงด้วย ExcelJS ไม่เสียหาย');
    let foundCert1Row = null;
    sheet.eachRow((row) => { if (row.getCell(1).value === cert1.certNo) foundCert1Row = row; });
    assert(!!foundCert1Row, `พบแถวของ cert1 (${cert1.certNo}) อยู่จริงในไฟล์ export`);
    assert(Number(foundCert1Row.getCell(8).value) === Number(cert1Row.wht_amount), `ยอดภาษีหัก ณ ที่จ่ายในไฟล์ export ตรงกับ DB จริง (ได้ ${foundCert1Row.getCell(8).value} คาดหวัง ${cert1Row.wht_amount})`);
    assert(foundCert1Row.getCell(9).value === 'ใช้งานอยู่', 'คอลัมน์สถานะในไฟล์ export ระบุ "ใช้งานอยู่" ถูกต้อง (ไม่ใช่ยกเลิก)');

    // ---- /void เอกสารต้นทางที่ 50-ทวิถูกนำส่งไปแล้ว ต้องถูกปฏิเสธ พร้อมบอกวันที่+เลขที่ใบเสร็จ ----
    const eVoidBlocked = await callExpectError('fx_settler', 'POST', `/api/customer/advance-clearances/${cert1.clearanceId}/void`, { reason: 'ทดสอบ' }, idemKey('remit-void-blocked'));
    assert(eVoidBlocked.status === 400, `void เอกสารที่ 50-ทวิถูกนำส่งไปแล้วถูกปฏิเสธ 400 (ได้ ${eVoidBlocked.status})`);
    assert(/2026-01-06/.test(eVoidBlocked.body.error) && /RCPT-E2E-0001-FIXED/.test(eVoidBlocked.body.error),
      `ข้อความ error บอกทั้งวันที่นำส่งจริง (2026-01-06) และเลขที่ใบเสร็จ (RCPT-E2E-0001-FIXED) ที่แก้ไขล่าสุดชัดเจน (ได้ "${eVoidBlocked.body.error}")`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      const { voucherIds, clearanceIds, payeeIds, remittanceIds } = cleanup;
      const itemIds = clearanceIds.length ? (await pool.query('SELECT id FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [clearanceIds])).rows.map(r => r.id) : [];
      if (itemIds.length) {
        await pool.query(`UPDATE client_wht_certificates SET remittance_id=NULL WHERE source_type='advance_clearance_item' AND source_id = ANY($1)`, [itemIds]);
        await pool.query(`DELETE FROM client_wht_certificates WHERE source_type='advance_clearance_item' AND source_id = ANY($1)`, [itemIds]);
      }
      let journalIds = [];
      for (const [sourceType, ids] of [['manual', remittanceIds], ['advance_clearance', clearanceIds], ['payment_voucher', voucherIds]]) {
        if (!ids.length) continue;
        const found = await pool.query('SELECT id FROM client_journal_entries WHERE source_type=$1 AND source_id = ANY($2)', [sourceType, ids]);
        journalIds.push(...found.rows.map(r => r.id));
      }
      if (journalIds.length) {
        await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [journalIds]);
        await pool.query('DELETE FROM client_journal_entries WHERE reverses_entry_id = ANY($1)', [journalIds]);
        await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [journalIds]);
      }
      if (remittanceIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='wht_remittance' AND doc_id = ANY($1)`, [remittanceIds]);
        await pool.query('DELETE FROM client_wht_remittances WHERE id = ANY($1)', [remittanceIds]);
      }
      if (clearanceIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='advance_clearance' AND doc_id = ANY($1)`, [clearanceIds]);
        await pool.query('DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)', [clearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [clearanceIds]);
      }
      if (voucherIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [voucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [voucherIds]);
      }
      if (payeeIds.length) await pool.query('DELETE FROM client_external_payees WHERE id = ANY($1)', [payeeIds]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND (endpoint LIKE 'remit-%' OR endpoint = 'wht-remittances-create')`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
