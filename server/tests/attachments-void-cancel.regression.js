// Regression suite — deleting attachment files when a document is /void'd or /cancel'd (follow-up to
// migration 0021's void feature). Covers: (1) a real file on disk + its DB row both disappear after
// void, and the serve-file endpoint 404s afterward; (2) same for /cancel on a still-draft document;
// (3) a file already missing from disk (deleted by hand) must not crash the request — the DB row still
// gets deleted, a warning is logged instead of an error; (4) the most important one — if the request is
// forced to fail partway through (after the DB row would have been deleted, before COMMIT), the file on
// disk must still exist afterward, because fs.unlink() is not transactional with Postgres and deleting
// it before a rollback would destroy evidence permanently with no way back.
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/attachments-void-cancel.regression.js
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const PAYMENT_VOUCHER_ATTACHMENTS_DIR = path.join(__dirname, '..', 'uploads', 'payment-voucher-attachments');

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
async function callRawStatus(username, method, urlPath) {
  const res = await fetch(BASE + urlPath, { method, headers: { Cookie: cookies[username] || '' } });
  return res.status;
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }

async function uploadAttachment(username, voucherId) {
  const form = new FormData();
  form.append('photos', new Blob([Buffer.from('fake-image-bytes-for-test')], { type: 'image/png' }), 'test.png');
  const res = await fetch(`${BASE}/api/customer/payment-vouchers/${voucherId}/attachments`, {
    method: 'POST', headers: { Cookie: cookies[username] || '' }, body: form,
  });
  const json = await res.json();
  if (!res.ok) { const e = new Error(json.error); e.status = res.status; throw e; }
  return json.attachments[0];
}

(async () => {
  const cleanup = { voucherIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    for (const u of ['fx_maker', 'fx_approver_mid', 'fx_settler', 'fx_super']) await login(u, codeA);

    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'E2E attachment-cleanup fund ' + Date.now(), fundLimit: 60000 });

    async function makeDraftPettyCashVoucher() {
      const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
        voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: 2, purpose: 'E2E attachment-cleanup test', amount: 1000, expenseAccountCode: '5300',
      }, idemKey('att-pcv-create'));
      cleanup.voucherIds.push(created.voucher.id);
      return created.voucher;
    }

    // ============================================================================================
    // (1) void: ไฟล์บนดิสก์ + แถว DB หายจริงหลัง void, endpoint เสิร์ฟไฟล์คืน 404
    // ============================================================================================
    console.log('\n=== (1) /void ลบไฟล์แนบจริง ===');
    const v1 = await makeDraftPettyCashVoucher();
    const att1 = await uploadAttachment('fx_maker', v1.id);
    const filePath1 = path.join(PAYMENT_VOUCHER_ATTACHMENTS_DIR, att1.storage_path || '');
    // storage_path ไม่ได้ส่งกลับมาใน response (เฉพาะ file_name/mime_type/file_size) — ดึงจาก DB ตรงๆ แทน
    const att1Row = (await pool.query('SELECT storage_path FROM client_payment_voucher_attachments WHERE id=$1', [att1.id])).rows[0];
    const realFilePath1 = path.join(PAYMENT_VOUCHER_ATTACHMENTS_DIR, att1Row.storage_path);
    assert(fs.existsSync(realFilePath1), 'ไฟล์ถูกเขียนลงดิสก์จริงหลังอัปโหลด (fixture ก่อนเริ่มเทส)');

    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v1.id}/submit`, {}, idemKey('att-pcv-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v1.id}/approve`, {}, idemKey('att-pcv-approve'));
    await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${v1.id}/void`, { reason: 'ทดสอบลบไฟล์แนบตอน void' }, idemKey('att-pcv-void'));

    // fs.unlink เป็น async fire-and-forget — รอสักครู่ให้ event loop ประมวลผลก่อนเช็ค
    await new Promise(r => setTimeout(r, 300));
    assert(!fs.existsSync(realFilePath1), `ไฟล์บนดิสก์หายไปจริงหลัง void (fs.existsSync=${fs.existsSync(realFilePath1)})`);
    const dbRow1After = await pool.query('SELECT count(*)::int AS n FROM client_payment_voucher_attachments WHERE id=$1', [att1.id]);
    assert(dbRow1After.rows[0].n === 0, 'แถว DB ของไฟล์แนบหายไปจริงหลัง void');
    const fileEndpointStatus = await callRawStatus('fx_maker', 'GET', `/api/customer/payment-vouchers/${v1.id}/attachments/${att1.id}/file`);
    assert(fileEndpointStatus === 404, `เปิด URL ไฟล์เดิมของเอกสารที่ voided แล้วได้ 404 จริง (ได้ ${fileEndpointStatus})`);

    // ============================================================================================
    // (2) cancel (draft): เหมือนกัน
    // ============================================================================================
    console.log('\n=== (2) /cancel (draft) ลบไฟล์แนบจริง ===');
    const v2 = await makeDraftPettyCashVoucher();
    const att2 = await uploadAttachment('fx_maker', v2.id);
    const att2Row = (await pool.query('SELECT storage_path FROM client_payment_voucher_attachments WHERE id=$1', [att2.id])).rows[0];
    const realFilePath2 = path.join(PAYMENT_VOUCHER_ATTACHMENTS_DIR, att2Row.storage_path);
    assert(fs.existsSync(realFilePath2), 'fixture ที่ 2: ไฟล์ถูกเขียนลงดิสก์จริง');

    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v2.id}/cancel`, {});
    await new Promise(r => setTimeout(r, 300));
    assert(!fs.existsSync(realFilePath2), `ไฟล์บนดิสก์หายไปจริงหลัง cancel ใบ draft (ได้ ${fs.existsSync(realFilePath2)})`);
    const dbRow2After = await pool.query('SELECT count(*)::int AS n FROM client_payment_voucher_attachments WHERE id=$1', [att2.id]);
    assert(dbRow2After.rows[0].n === 0, 'แถว DB ของไฟล์แนบหายไปจริงหลัง cancel');

    // ============================================================================================
    // (3) ไฟล์บนดิสก์หายไปก่อนแล้ว (ถูกลบมือ) — void ต้องไม่พัง ลบแถว DB ต่อได้
    // ============================================================================================
    console.log('\n=== (3) ไฟล์หายไปก่อนแล้ว (ลบมือ) ===');
    const v3 = await makeDraftPettyCashVoucher();
    const att3 = await uploadAttachment('fx_maker', v3.id);
    const att3Row = (await pool.query('SELECT storage_path FROM client_payment_voucher_attachments WHERE id=$1', [att3.id])).rows[0];
    const realFilePath3 = path.join(PAYMENT_VOUCHER_ATTACHMENTS_DIR, att3Row.storage_path);
    fs.unlinkSync(realFilePath3); // จำลอง "มีคนลบไฟล์ทิ้งด้วยมือ" ก่อน void จะทำอะไรเลย
    assert(!fs.existsSync(realFilePath3), 'fixture ที่ 3: ลบไฟล์ด้วยมือไปแล้วจริงก่อนเริ่มเทส');

    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v3.id}/submit`, {}, idemKey('att-pcv3-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v3.id}/approve`, {}, idemKey('att-pcv3-approve'));
    const voidResult3 = await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${v3.id}/void`, { reason: 'ทดสอบไฟล์หายไปก่อนแล้ว' }, idemKey('att-pcv3-void'));
    assert(voidResult3.voucher.status === 'voided', `void ไม่พังแม้ไฟล์บนดิสก์หายไปก่อนแล้ว (ได้ status=${voidResult3.voucher.status})`);
    const dbRow3After = await pool.query('SELECT count(*)::int AS n FROM client_payment_voucher_attachments WHERE id=$1', [att3.id]);
    assert(dbRow3After.rows[0].n === 0, 'แถว DB ของไฟล์แนบยังถูกลบตามปกติแม้ไฟล์จริงหายไปก่อนแล้ว');

    // ============================================================================================
    // (4) ที่สำคัญที่สุด: บังคับให้พังกลางทาง (หลัง commit ควรจะยังไม่เกิด) -> ไฟล์ต้องยังอยู่ + แถว DB
    // ต้องยังอยู่ (ROLLBACK คืนทุกอย่างกลับ ไม่มีการ unlink เกิดขึ้นเลยเพราะ res.statusCode ไม่ใช่ 2xx)
    // ============================================================================================
    console.log('\n=== (4) พังกลางทางก่อน commit -> ไฟล์ต้องไม่หาย ===');
    const v4 = await makeDraftPettyCashVoucher();
    const att4 = await uploadAttachment('fx_maker', v4.id);
    const att4Row = (await pool.query('SELECT storage_path FROM client_payment_voucher_attachments WHERE id=$1', [att4.id])).rows[0];
    const realFilePath4 = path.join(PAYMENT_VOUCHER_ATTACHMENTS_DIR, att4Row.storage_path);
    assert(fs.existsSync(realFilePath4), 'fixture ที่ 4: ไฟล์ถูกเขียนลงดิสก์จริง');

    await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v4.id}/submit`, {}, idemKey('att-pcv4-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v4.id}/approve`, {}, idemKey('att-pcv4-approve'));

    // บังคับให้ reversing journal entry พังกลางทางจริง (ไม่ mock) — ปิดใช้งานบัญชี 5300 ชั่วคราว
    // (petty_cash journal ใช้ Dr 5300 / Cr 1110 — createClientJournalEntry เช็ค is_active ของทุกบัญชีก่อน
    // INSERT เสมอ ปิด 5300 แล้ว reverse จะ throw ก่อนถึงขั้นตอน UPDATE status/COMMIT ใดๆ ทั้งสิ้น)
    await pool.query(`UPDATE client_chart_of_accounts SET is_active=false WHERE company_id=$1 AND code='5300'`, [COMPANY_A_ID]);
    try {
      let voidError = null;
      try {
        await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${v4.id}/void`, { reason: 'ทดสอบพังกลางทาง' }, idemKey('att-pcv4-void'));
      } catch (e) { voidError = e; }
      assert(voidError !== null, `การ void ที่ถูกบังคับให้พังกลางทางล้มเหลวจริง (ได้ status=${voidError && voidError.status})`);

      assert(fs.existsSync(realFilePath4), `ไฟล์บนดิสก์ยังอยู่ครบหลังพังกลางทาง (ไม่มีการ unlink เกิดขึ้นเลยเพราะ response ไม่ใช่ 2xx) (fs.existsSync=${fs.existsSync(realFilePath4)})`);
      const dbRow4Mid = await pool.query('SELECT count(*)::int AS n FROM client_payment_voucher_attachments WHERE id=$1', [att4.id]);
      assert(dbRow4Mid.rows[0].n === 1, `แถว DB ของไฟล์แนบยังอยู่ครบหลังพังกลางทาง (ROLLBACK คืน DELETE กลับด้วย) (ได้ ${dbRow4Mid.rows[0].n} แถว)`);
      const voucher4Status = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [v4.id]);
      assert(voucher4Status.rows[0].status === 'approved', `สถานะเอกสารไม่เปลี่ยนเลยหลังพังกลางทาง (ยังเป็น approved ไม่ใช่ voided) (ได้ ${voucher4Status.rows[0].status})`);
    } finally {
      await pool.query(`UPDATE client_chart_of_accounts SET is_active=true WHERE company_id=$1 AND code='5300'`, [COMPANY_A_ID]);
    }

    // หลังคืนบัญชี 5300 กลับมาแล้ว void ต้องทำสำเร็จตามปกติ พิสูจน์ว่าความล้มเหลวก่อนหน้าไม่ได้ทิ้งอะไรค้าง
    const voidResult4 = await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${v4.id}/void`, { reason: 'ทดสอบหลังคืนบัญชี 5300 แล้ว' }, idemKey('att-pcv4-void-clean'));
    assert(voidResult4.voucher.status === 'voided', `หลังคืนบัญชี 5300 แล้ว void สำเร็จตามปกติ (ได้ ${voidResult4.voucher.status})`);
    await new Promise(r => setTimeout(r, 300));
    assert(!fs.existsSync(realFilePath4), 'รอบนี้ void สำเร็จจริง ไฟล์จึงถูกลบไปจริงแล้ว (ยืนยันว่าไฟล์ไม่ได้หายไปเองระหว่างทาง)');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      const { voucherIds } = cleanup;
      if (voucherIds.length) {
        const journalIds = (await pool.query(`SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [voucherIds])).rows.map(r => r.id);
        if (journalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [journalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE reverses_entry_id = ANY($1)', [journalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [journalIds]);
        }
        await pool.query(`DELETE FROM client_payment_voucher_attachments WHERE voucher_id = ANY($1)`, [voucherIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [voucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [voucherIds]);
      }
      await pool.query(`UPDATE client_chart_of_accounts SET is_active=true WHERE company_id=$1 AND code='5300'`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'att-%'`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
