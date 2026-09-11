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
const crypto = require('crypto');
const pool = require('../db');

function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const PAYMENT_VOUCHER_ATTACHMENTS_DIR = path.join(__dirname, '..', 'uploads', 'payment-voucher-attachments');
const SITE_EXPENSE_ATTACHMENTS_DIR = path.join(__dirname, '..', 'uploads', 'site-expense-attachments');
// เดิมสองค่านี้ hardcode รายการ doc_type ไว้ตรงๆ — พอ migration ใหม่ (เช่น 0024 เพิ่ม 'branch'/'department')
// ขยาย CHECK จริงใน DB แล้ว แต่ค่า hardcode ในไฟล์นี้ไม่ได้ตามไปด้วย ทำให้ finally-block ที่ "คืนค่า" CHECK
// กลับไปใช้ AUDIT_DOC_TYPES_FULL ที่เก่ากว่า จริงๆ แล้วกลับไปแคบกว่าที่ migration ล่าสุดตั้งไว้ — ทำลาย
// CHECK ที่เพิ่งขยายไปแบบเงียบๆ ทุกครั้งที่รันไฟล์นี้ (พบจริงจากการไล่ debug: หลัง apply migration 0024 แล้ว
// verify constraint ถูกต้องเอง แต่รันเทสทั้งชุด (test:regression-all) แล้ว constraint แคบกลับไปอีกครั้ง เพราะ
// ไฟล์นี้รันก่อน branches-departments ในลำดับ chain) — แก้โดยอ่านค่าจริงจาก DB ตอนเริ่มเทสแทน hardcode
// (ดู AUDIT_DOC_TYPES_FULL/AUDIT_DOC_TYPES_WITHOUT_SITE_EXPENSE ที่ประกาศเป็น let ด้านล่าง แล้วเติมค่าใน IIFE)
let AUDIT_DOC_TYPES_FULL, AUDIT_DOC_TYPES_WITHOUT_SITE_EXPENSE;

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

async function createSiteExpenseSubmission(username, projectId, vendorName) {
  const form = new FormData();
  form.append('photos', new Blob([Buffer.from('fake-receipt-bytes-for-test')], { type: 'image/png' }), 'receipt.png');
  form.append('projectId', String(projectId));
  form.append('expenseCase', 'payable');
  form.append('vendorName', vendorName);
  form.append('expenseDate', '2026-09-08');
  form.append('amount', '500');
  form.append('description', 'E2E attachment-cleanup site-expense test');
  const res = await fetch(`${BASE}/api/customer/site-expense-submissions`, {
    method: 'POST', headers: { Cookie: cookies[username] || '', 'Idempotency-Key': idemKey('se-create') }, body: form,
  });
  const json = await res.json();
  if (!res.ok) { const e = new Error(json.error); e.status = res.status; throw e; }
  return json.siteExpenseSubmission;
}

(async () => {
  const cleanup = { voucherIds: [], siteExpenseSubmissionIds: [], projectIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();

    // อ่านรายการ doc_type ที่ CHECK อนุญาตจริงตอนนี้จาก DB โดยตรง (ไม่ hardcode) กัน constraint ที่เพิ่งถูก
    // migration ล่าสุดขยายไว้ถูกไฟล์นี้ทำให้แคบกลับไปโดยไม่ตั้งใจตอน "คืนค่า" หลังเทสจบ
    const liveCheckDef = (await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid='client_document_audit_log'::regclass AND conname='client_document_audit_log_doc_type_check'`
    )).rows[0].def;
    const liveDocTypes = [...liveCheckDef.matchAll(/'([^']+)'::text/g)].map(m => m[1]);
    AUDIT_DOC_TYPES_FULL = liveDocTypes.map(t => `'${t}'`).join(',');
    AUDIT_DOC_TYPES_WITHOUT_SITE_EXPENSE = liveDocTypes.filter(t => t !== 'site_expense_submission').map(t => `'${t}'`).join(',');

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    for (const u of ['fx_maker', 'fx_approver_mid', 'fx_settler', 'fx_super', 'fx_sitework']) await login(u, codeA);

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
    const checksum4Before = sha256(realFilePath4);

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
      assert(sha256(realFilePath4) === checksum4Before, 'เนื้อหาไฟล์เหมือนเดิมเป๊ะหลังพังกลางทาง (เช็ค checksum ไม่ใช่แค่ว่าไฟล์ยังอยู่ — พิสูจน์ว่าไม่ถูกเขียนทับ/เสียหาย)');
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

    // ============================================================================================
    // (5) site-expense-submissions: /reject ลบไฟล์แนบจริง เหมือน void/cancel — /close ต้องไม่แตะไฟล์เลย
    // (ปิดเรื่องแล้วแปลว่ามีเอกสารการเงินจริงอ้างอิงรูปนี้อยู่ ต้องเก็บไว้เป็นหลักฐาน ไม่ใช่ทิ้งเอกสาร)
    // ============================================================================================
    console.log('\n=== (5) site-expense-submissions /reject ลบไฟล์แนบจริง ===');
    const proj5 = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E attachment-cleanup site-expense project ' + Date.now(), sectorType: 'private', status: 'in_progress' });
    cleanup.projectIds.push(proj5.project.id);

    const se1 = await createSiteExpenseSubmission('fx_sitework', proj5.project.id, 'ร้าน E2E เทสลบไฟล์แนบ 1');
    cleanup.siteExpenseSubmissionIds.push(se1.id);
    const se1AttRow = (await pool.query('SELECT id, storage_path FROM client_site_expense_attachments WHERE submission_id=$1', [se1.id])).rows[0];
    const se1FilePath = path.join(SITE_EXPENSE_ATTACHMENTS_DIR, se1AttRow.storage_path);
    assert(fs.existsSync(se1FilePath), 'ไฟล์แนบใบส่งบิลถูกเขียนลงดิสก์จริงตอนสร้าง (multipart create)');

    await call('fx_settler', 'POST', `/api/customer/site-expense-submissions/${se1.id}/reject`, { reason: 'ทดสอบลบไฟล์แนบตอนตีกลับ' });
    await new Promise(r => setTimeout(r, 300));
    assert(!fs.existsSync(se1FilePath), `ไฟล์บนดิสก์หายไปจริงหลัง reject (fs.existsSync=${fs.existsSync(se1FilePath)})`);
    const se1DbAfter = await pool.query('SELECT count(*)::int AS n FROM client_site_expense_attachments WHERE submission_id=$1', [se1.id]);
    assert(se1DbAfter.rows[0].n === 0, 'แถว DB ของไฟล์แนบหายไปจริงหลัง reject');
    const se1FileStatus = await callRawStatus('fx_sitework', 'GET', `/api/customer/site-expense-submissions/${se1.id}/attachments/${se1AttRow.id}/file`);
    assert(se1FileStatus === 404, `เปิด URL ไฟล์เดิมของใบที่ถูกตีกลับแล้วได้ 404 จริง (ได้ ${se1FileStatus})`);

    // (5b) ไฟล์หายไปก่อนแล้ว (ลบมือ) — reject ต้องไม่พัง ลบแถว DB ต่อได้
    const se2 = await createSiteExpenseSubmission('fx_sitework', proj5.project.id, 'ร้าน E2E เทสลบไฟล์แนบ 2');
    cleanup.siteExpenseSubmissionIds.push(se2.id);
    const se2AttRow = (await pool.query('SELECT storage_path FROM client_site_expense_attachments WHERE submission_id=$1', [se2.id])).rows[0];
    const se2FilePath = path.join(SITE_EXPENSE_ATTACHMENTS_DIR, se2AttRow.storage_path);
    fs.unlinkSync(se2FilePath);
    const se2RejectResult = await call('fx_settler', 'POST', `/api/customer/site-expense-submissions/${se2.id}/reject`, { reason: 'ทดสอบไฟล์หายไปก่อนแล้ว' });
    assert(se2RejectResult.siteExpenseSubmission.status === 'rejected', `reject ไม่พังแม้ไฟล์บนดิสก์หายไปก่อนแล้ว (ได้ status=${se2RejectResult.siteExpenseSubmission.status})`);
    const se2DbAfter = await pool.query('SELECT count(*)::int AS n FROM client_site_expense_attachments WHERE submission_id=$1', [se2.id]);
    assert(se2DbAfter.rows[0].n === 0, 'แถว DB ของไฟล์แนบยังถูกลบตามปกติแม้ไฟล์จริงหายไปก่อนแล้ว (site-expense)');

    // (5c) พังกลางทางก่อน commit -> ไฟล์ต้องไม่หาย (บังคับพังจริงด้วยการทำให้ writeAuditLog throw:
    // ปิดค่า 'site_expense_submission' ออกจาก CHECK ของ client_document_audit_log.doc_type ชั่วคราว —
    // DELETE ไฟล์แนบ + UPDATE status เกิดไปแล้วในทรานแซกชันเดียวกันก่อนถึง INSERT audit log ที่จะพัง)
    const se3 = await createSiteExpenseSubmission('fx_sitework', proj5.project.id, 'ร้าน E2E เทสลบไฟล์แนบ 3');
    cleanup.siteExpenseSubmissionIds.push(se3.id);
    const se3AttRow = (await pool.query('SELECT storage_path FROM client_site_expense_attachments WHERE submission_id=$1', [se3.id])).rows[0];
    const se3FilePath = path.join(SITE_EXPENSE_ATTACHMENTS_DIR, se3AttRow.storage_path);
    const se3ChecksumBefore = sha256(se3FilePath);

    // NOT VALID: ข้ามการตรวจแถวเก่าที่มีอยู่แล้ว (มีแถว doc_type='site_expense_submission' จริงจาก
    // se1/se2 ข้างบนแล้ว — ADD CONSTRAINT แบบปกติจะพังทันทีตรงนี้เพราะ validate ข้อมูลเก่าด้วยเสมอ) แต่ยัง
    // บังคับกับ INSERT ใหม่ทุกแถวเหมือนเดิม ตรงตามที่ต้องการทดสอบ (บังคับ INSERT audit log ใหม่ให้พัง)
    await pool.query(`ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check`);
    await pool.query(`ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check CHECK (doc_type IN (${AUDIT_DOC_TYPES_WITHOUT_SITE_EXPENSE})) NOT VALID`);
    try {
      let se3RejectError = null;
      try {
        await call('fx_settler', 'POST', `/api/customer/site-expense-submissions/${se3.id}/reject`, { reason: 'ทดสอบพังกลางทาง' });
      } catch (e) { se3RejectError = e; }
      assert(se3RejectError !== null, `reject ที่ถูกบังคับให้พังกลางทางล้มเหลวจริง (ได้ status=${se3RejectError && se3RejectError.status})`);
      assert(fs.existsSync(se3FilePath), `ไฟล์บนดิสก์ยังอยู่ครบหลังพังกลางทาง (site-expense) (fs.existsSync=${fs.existsSync(se3FilePath)})`);
      assert(sha256(se3FilePath) === se3ChecksumBefore, 'เนื้อหาไฟล์ (site-expense) เหมือนเดิมเป๊ะหลังพังกลางทาง');
      const se3DbMid = await pool.query('SELECT count(*)::int AS n FROM client_site_expense_attachments WHERE submission_id=$1', [se3.id]);
      assert(se3DbMid.rows[0].n === 1, `แถว DB ของไฟล์แนบ (site-expense) ยังอยู่ครบหลังพังกลางทาง (ได้ ${se3DbMid.rows[0].n} แถว)`);
      const se3StatusMid = await pool.query('SELECT status FROM client_site_expense_submissions WHERE id=$1', [se3.id]);
      assert(se3StatusMid.rows[0].status === 'submitted', `สถานะใบส่งบิลไม่เปลี่ยนเลยหลังพังกลางทาง (ยังเป็น submitted) (ได้ ${se3StatusMid.rows[0].status})`);
    } finally {
      await pool.query(`ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check`);
      await pool.query(`ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check CHECK (doc_type IN (${AUDIT_DOC_TYPES_FULL}))`);
    }
    const se3RejectClean = await call('fx_settler', 'POST', `/api/customer/site-expense-submissions/${se3.id}/reject`, { reason: 'ทดสอบหลังคืน constraint แล้ว' });
    assert(se3RejectClean.siteExpenseSubmission.status === 'rejected', `หลังคืน constraint แล้ว reject สำเร็จตามปกติ (ได้ ${se3RejectClean.siteExpenseSubmission.status})`);
    await new Promise(r => setTimeout(r, 300));
    assert(!fs.existsSync(se3FilePath), 'รอบนี้ reject สำเร็จจริง ไฟล์ (site-expense) จึงถูกลบไปจริงแล้ว');

    // (5d) /close ต้องไม่ลบไฟล์แนบเลย (หลักฐานต้องอยู่ต่อเพราะมีเอกสารการเงินจริงอ้างอิงแล้ว)
    const se4 = await createSiteExpenseSubmission('fx_sitework', proj5.project.id, 'ร้าน E2E เทสลบไฟล์แนบ 4');
    cleanup.siteExpenseSubmissionIds.push(se4.id);
    const se4AttRow = (await pool.query('SELECT storage_path FROM client_site_expense_attachments WHERE submission_id=$1', [se4.id])).rows[0];
    const se4FilePath = path.join(SITE_EXPENSE_ATTACHMENTS_DIR, se4AttRow.storage_path);
    const payeeForClose = await call('fx_super', 'POST', '/api/customer/external-payees', { name: 'ร้าน E2E ปิดเรื่อง site-expense ' + Date.now(), taxpayerType: 'individual' });
    const voucherForClose = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'other', payeeExternalId: payeeForClose.externalPayee.id, projectId: proj5.project.id, amount: 500, expenseAccountCode: '5300', purpose: 'E2E voucher สำหรับปิดเรื่อง site-expense (attachment test)',
    }, idemKey('att-se-close-voucher'));
    cleanup.voucherIds.push(voucherForClose.voucher.id);
    await call('fx_settler', 'POST', `/api/customer/site-expense-submissions/${se4.id}/close`, { resultDocType: 'payment_voucher', resultDocId: voucherForClose.voucher.id, closingNote: 'ทดสอบว่า close ไม่ลบไฟล์แนบ' });
    await new Promise(r => setTimeout(r, 300));
    assert(fs.existsSync(se4FilePath), 'ไฟล์แนบยังอยู่ครบหลัง /close (ไม่ลบ เพราะมีเอกสารการเงินจริงอ้างอิงแล้ว)');
    const se4DbAfter = await pool.query('SELECT count(*)::int AS n FROM client_site_expense_attachments WHERE submission_id=$1', [se4.id]);
    assert(se4DbAfter.rows[0].n === 1, 'แถว DB ของไฟล์แนบยังอยู่ครบหลัง /close เช่นกัน');

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
      const { siteExpenseSubmissionIds, projectIds } = cleanup;
      if (siteExpenseSubmissionIds.length) {
        await pool.query('DELETE FROM client_site_expense_attachments WHERE submission_id = ANY($1)', [siteExpenseSubmissionIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='site_expense_submission' AND doc_id = ANY($1)`, [siteExpenseSubmissionIds]);
        await pool.query('DELETE FROM client_site_expense_submissions WHERE id = ANY($1)', [siteExpenseSubmissionIds]);
      }
      await pool.query(`DELETE FROM client_external_payees WHERE name LIKE 'ร้าน E2E ปิดเรื่อง site-expense%' AND company_id=$1`, [COMPANY_A_ID]);
      if (projectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [projectIds]);
      }
      // เผื่อ constraint ยังค้างอยู่ในสถานะแคบ (ถ้าเทสพังกลางทางในขั้น 5c ก่อนถึง finally ของ try ชั้นในเอง)
      await pool.query(`ALTER TABLE client_document_audit_log DROP CONSTRAINT IF EXISTS client_document_audit_log_doc_type_check`);
      await pool.query(`ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check CHECK (doc_type IN (${AUDIT_DOC_TYPES_FULL}))`);
      await pool.query(`UPDATE client_chart_of_accounts SET is_active=true WHERE company_id=$1 AND code='5300'`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'att-%'`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint='site-expense-submissions-create'`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint='payment-vouchers-create' AND idempotency_key LIKE 'att-se-close-voucher-%'`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
