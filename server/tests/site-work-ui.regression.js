// Real-browser E2E coverage for "งานหน้างาน" (site work): goods receipt against a PO (partial
// receipts, over-receipt guard, PO cancel-block once received) and site expense submission (3
// funding cases, required-attachment guard, accounting queue close/reject, prefill buttons into the
// advance-clearance/payment-voucher creation forms). Not part of `npm run test:client-ledger` — run
// standalone against a live local server. See server/migrations/0017_goods_receipts_batch.up.sql and
// 0018_site_expense_submissions_batch.up.sql for the schema/business-rule rationale.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `sitework-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); passed++; console.log('  OK:', msg); }

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
async function httpLogin(username, companyCode) { await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD }); }
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }
const testFile = (name) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]) });

(async () => {
  let browser;
  const consoleErrors = [];
  const createdProjectIds = [];
  const createdPoIds = [];
  const createdVoucherIds = [];
  const createdGoodsReceiptIds = [];
  const createdSiteExpenseIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_maker2', companyCode);
    await httpLogin('fx_sitework', companyCode);
    await httpLogin('fx_settler', companyCode);
    await httpLogin('fx_super', companyCode);
    await httpLogin('fx_approver_mid', companyCode);

    console.log('Creating prerequisite project + approved PO (qty=20)...');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E งานหน้างาน โครงการ', sectorType: 'private', status: 'in_progress' });
    createdProjectIds.push(proj.project.id);
    const po = await call('fx_maker', 'POST', '/api/customer/purchase-orders', {
      projectId: proj.project.id, supplierName: 'ร้าน E2E งานหน้างาน',
      items: [{ material: 'ปูนซีเมนต์ E2E', unit: 'ถุง', qty: 20, unitPrice: 150 }],
    }, idemKey('sw-po-create'));
    createdPoIds.push(po.purchaseOrder.id);
    const poId = po.purchaseOrder.id;
    const poItemId = po.purchaseOrder.items[0].id;
    await call('fx_maker', 'POST', `/api/customer/purchase-orders/${poId}/submit`, {}, idemKey('sw-po-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/purchase-orders/${poId}/approve`, {}, idemKey('sw-po-approve'));

    console.log('Creating an approved petty-cash voucher (for the advance_offset picker test)...');
    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'กองทุน E2E งานหน้างาน', fundLimit: 20000 });
    const pcVoucher = await call('fx_sitework', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: 2, projectId: proj.project.id,
      amount: 500, expenseAccountCode: '5300', purpose: 'เบิกเงินสดย่อย E2E งานหน้างาน',
    }, idemKey('sw-pc-create'));
    createdVoucherIds.push(pcVoucher.voucher.id);
    await call('fx_sitework', 'POST', `/api/customer/payment-vouchers/${pcVoucher.voucher.id}/submit`, {}, idemKey('sw-pc-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${pcVoucher.voucher.id}/approve`, {}, idemKey('sw-pc-approve'));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', d => d.accept());

    async function loginAs(username) {
      await page.goto(BASE + '/pr-system.html');
      await page.click('[data-act="go-login"]');
      await page.waitForTimeout(200);
      await page.fill('#f-loginCompanyCode', companyCode);
      await page.fill('#f-loginUser', username);
      await page.fill('#f-loginPass', PASSWORD);
      await page.click('[data-act="do-login"]');
      await page.waitForTimeout(700);
    }

    // ================= 1) fx_sitework — ตรวจรับของบางส่วน (partial receipt) จากหน้า PO detail =================
    await loginAs('fx_sitework');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_po_detail"][data-id="${poId}"]`);
    await page.waitForTimeout(500);
    await shot(page, 'po-detail-receipt-summary-before');
    const remainingBefore = await page.locator('td.mono').allTextContents();
    assert(remainingBefore.some(t => t.trim() === '20.00'), 'หน้า PO detail แสดงยอดคงเหลือ = ยอดสั่งเต็ม (20) ก่อนรับของครั้งแรก');

    await page.click('[data-act="open-goods-receipt-add"]');
    await page.waitForTimeout(400);
    await page.fill(`input[oninput*="qtyByItem['${poItemId}']"]`, '8');
    await page.setInputFiles('#gr-photos', [testFile('delivery-note-1.jpg')]);
    await page.click('[data-act="submit-goods-receipt"]');
    await page.waitForTimeout(700);
    await shot(page, 'goods-receipt-1-created');

    const gr1 = await pool.query(`SELECT id, receipt_no FROM client_goods_receipts WHERE po_id=$1 ORDER BY id DESC LIMIT 1`, [poId]);
    assert(gr1.rowCount === 1 && !!gr1.rows[0].receipt_no, `สร้างใบตรวจรับของครั้งที่ 1 สำเร็จจริงใน DB (receipt_no=${gr1.rows[0] && gr1.rows[0].receipt_no})`);
    createdGoodsReceiptIds.push(gr1.rows[0].id);
    const gr1Items = await pool.query('SELECT qty_received FROM client_goods_receipt_items WHERE receipt_id=$1', [gr1.rows[0].id]);
    assert(Number(gr1Items.rows[0].qty_received) === 8, `บันทึกจำนวนที่รับจริง = 8 (ได้ ${gr1Items.rows[0].qty_received})`);
    const attCount1 = await pool.query('SELECT COUNT(*) FROM client_goods_receipt_attachments WHERE receipt_id=$1', [gr1.rows[0].id]);
    assert(Number(attCount1.rows[0].count) === 1, 'บันทึกไฟล์แนบ 1 ไฟล์จริงใน DB');

    // กลับมาหน้า PO detail อัตโนมัติ — ยอดคงเหลือต้องอัปเดตเป็น 12
    await page.waitForTimeout(300);
    const remainingAfterFirst = await page.locator('td.mono').allTextContents();
    assert(remainingAfterFirst.some(t => t.trim() === '12.00'), `ยอดคงเหลือหลังรับครั้งแรกลดลงเหลือ 12 จริง (ได้ ${JSON.stringify(remainingAfterFirst)})`);

    // ================= 2) รับของครั้งที่ 2 (partial receipt สะสม) =================
    await page.click('[data-act="open-goods-receipt-add"]');
    await page.waitForTimeout(400);
    await page.fill(`input[oninput*="qtyByItem['${poItemId}']"]`, '5');
    await page.setInputFiles('#gr-photos', [testFile('delivery-note-2.jpg')]);
    await page.click('[data-act="submit-goods-receipt"]');
    await page.waitForTimeout(700);
    const remainingAfterSecond = await page.locator('td.mono').allTextContents();
    assert(remainingAfterSecond.some(t => t.trim() === '7.00'), `รับของครั้งที่ 2 (5 เพิ่ม) แล้วยอดคงเหลือสะสมถูกต้อง = 7 จริง (ได้ ${JSON.stringify(remainingAfterSecond)})`);
    const gr2 = await pool.query(`SELECT id FROM client_goods_receipts WHERE po_id=$1 ORDER BY id DESC LIMIT 1`, [poId]);
    createdGoodsReceiptIds.push(gr2.rows[0].id);

    // ================= 3) กันรับของเกินยอดสั่ง (เหลือ 7 ขอรับ 100) =================
    await page.click('[data-act="open-goods-receipt-add"]');
    await page.waitForTimeout(400);
    await page.fill(`input[oninput*="qtyByItem['${poItemId}']"]`, '100');
    await page.setInputFiles('#gr-photos', [testFile('delivery-note-over.jpg')]);
    await page.click('[data-act="submit-goods-receipt"]');
    await page.waitForTimeout(500);
    const overReceiptRow = await pool.query(`SELECT COUNT(*) FROM client_goods_receipts WHERE po_id=$1`, [poId]);
    assert(Number(overReceiptRow.rows[0].count) === 2, 'รับของเกินยอดสั่งถูกปฏิเสธจริง (ไม่มีใบตรวจรับของใบที่ 3 ถูกสร้างขึ้น)');
    const overToast = await page.locator('.toast, [class*="toast"]').allTextContents();
    assert(overToast.some(t => t.includes('เกินยอดสั่ง')), `ขึ้นข้อความไทยชัดเจนว่ารับของเกินยอดสั่ง (ได้ ${JSON.stringify(overToast)})`);
    await shot(page, 'over-receipt-blocked');

    // ================= 4) PO cancel ต้องถูกบล็อกเพราะรับของไปแล้ว =================
    let cancelBlocked = null;
    try { await call('fx_maker', 'POST', `/api/customer/purchase-orders/${poId}/cancel`, {}, idemKey('sw-po-cancel-blocked')); }
    catch (e) { cancelBlocked = e; }
    assert(cancelBlocked !== null && cancelBlocked.status === 409, `ยกเลิก PO ที่รับของไปแล้วถูกบล็อก 409 จริง (ได้ status=${cancelBlocked && cancelBlocked.status})`);

    // ================= 5) รายการ + รายละเอียดใบตรวจรับของ =================
    await page.click('[data-act="nav"][data-page="fin_goods_receipts"]');
    await page.waitForTimeout(400);
    const receiptRowCount = await page.locator(`button[data-page="fin_goods_receipt_detail"]`).count();
    assert(receiptRowCount === 2, `หน้ารายการใบตรวจรับของ แสดงครบ 2 ใบจริง (ได้ ${receiptRowCount})`);
    await page.click(`button[data-page="fin_goods_receipt_detail"][data-id="${gr1.rows[0].id}"]`);
    await page.waitForTimeout(400);
    const thumbCount = await page.locator('img[alt="delivery-note-1.jpg"]').count();
    assert(thumbCount === 1, 'หน้ารายละเอียดใบตรวจรับของแสดงรูปแนบจริง (thumbnail)');
    await shot(page, 'goods-receipt-detail-with-attachment');

    // ================= 6) สิทธิ์ — fx_maker2 (ไม่มี flag ใดๆ) ไม่เห็นเมนู/ปุ่มตรวจรับของ =================
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    const grNavForMaker2 = await page.locator('.nav-item[data-page="fin_goods_receipts"]').count();
    assert(grNavForMaker2 === 0, 'fx_maker2 (ไม่มี can_submit_goods_receipt/can_manage_po) ไม่เห็นเมนูตรวจรับของ');
    await page.click(`button[data-page="fin_po_detail"][data-id="${poId}"]`);
    await page.waitForTimeout(400);
    const addReceiptBtnForMaker2 = await page.locator('[data-act="open-goods-receipt-add"]').count();
    assert(addReceiptBtnForMaker2 === 0, 'fx_maker2 ไม่เห็นปุ่ม "ตรวจรับของ" บนหน้า PO detail');

    // ================= 7) fx_sitework ส่งบิลค่าใช้จ่ายหน้างาน — กรณี ค (payable) =================
    await loginAs('fx_sitework');
    await page.click('[data-act="nav"][data-page="fin_site_expense_submissions"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="open-site-expense-add"]');
    await page.waitForTimeout(400);
    await page.selectOption('#se-project', String(proj.project.id));
    await page.fill('#se-vendor', 'ร้านวัสดุก่อสร้าง E2E');
    await page.fill('#se-amount', '850');
    await page.fill('#se-description', 'ซื้อสีทาบ้าน 5 ถัง');
    // ยังไม่แนบไฟล์ — ต้องถูกบล็อกฝั่ง client ก่อนยิง request จริง
    await page.click('[data-act="submit-site-expense"]');
    await page.waitForTimeout(400);
    const beforeAttachToast = await page.locator('.toast, [class*="toast"]').allTextContents();
    assert(beforeAttachToast.some(t => t.includes('แนบ')), `ไม่แนบรูปเลย ถูกบล็อกฝั่ง UI ด้วยข้อความไทยชัดเจน (ได้ ${JSON.stringify(beforeAttachToast)})`);
    const noSubmissionYet = await pool.query(`SELECT COUNT(*) FROM client_site_expense_submissions WHERE vendor_name='ร้านวัสดุก่อสร้าง E2E'`);
    assert(Number(noSubmissionYet.rows[0].count) === 0, 'ใบที่ควรถูกบล็อกไม่ได้ถูกสร้างขึ้นจริงใน DB (UI กันไว้ก่อนยิง API จริง)');

    await page.setInputFiles('#se-photos', [testFile('bill-1.jpg')]);
    await page.click('[data-act="submit-site-expense"]');
    await page.waitForTimeout(700);
    await shot(page, 'site-expense-payable-created');
    const se1 = await pool.query(`SELECT id, submission_no, status, expense_case FROM client_site_expense_submissions WHERE vendor_name='ร้านวัสดุก่อสร้าง E2E'`);
    assert(se1.rowCount === 1 && se1.rows[0].status === 'submitted' && se1.rows[0].expense_case === 'payable', `สร้างใบส่งบิลกรณี ค (payable) สำเร็จจริง สถานะ submitted (ได้ ${JSON.stringify(se1.rows[0])})`);
    createdSiteExpenseIds.push(se1.rows[0].id);
    const se1Att = await pool.query('SELECT COUNT(*) FROM client_site_expense_attachments WHERE submission_id=$1', [se1.rows[0].id]);
    assert(Number(se1Att.rows[0].count) === 1, 'บันทึกไฟล์แนบของใบส่งบิล 1 ไฟล์จริงใน DB');

    // ================= 8) กรณี ก (advance_offset) — ต้องมี dropdown ใบเบิกเงินสดย่อยที่อนุมัติแล้ว =================
    await page.click('[data-act="nav"][data-page="fin_site_expense_submissions"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="open-site-expense-add"]');
    await page.waitForTimeout(400);
    await page.selectOption('#se-project', String(proj.project.id));
    await page.selectOption('select[data-act="select-se-case"]', 'advance_offset');
    // เลือกกรณี ก แล้วมี loadOffsetableVouchers() ยิง HTTP ต่อกัน 2 ครั้ง (petty_cash แล้ว advance) แต่ละ
    // ครั้งจบด้วย render() ของตัวเอง — ต้องรอจนกว่า S.offsetableVouchersLoaded เป็น true จริง ไม่ใช่แค่
    // waitForTimeout คงที่ เพราะ render() ที่มาทีหลังจะล้าง <input type="file"> ที่เพิ่งเลือกไว้ทิ้ง
    // (เจอ flaky จริงตอนเขียนเทส — render() ล้าง #se-photos ถ้ามาแทรกหลังจากเรา setInputFiles ไปแล้ว)
    await page.waitForFunction(() => typeof S !== 'undefined' && S.offsetableVouchersLoaded === true);
    await page.waitForTimeout(200);
    const voucherOptionCount = await page.locator(`option[value="${pcVoucher.voucher.id}"]`).count();
    assert(voucherOptionCount === 1, 'เลือกกรณี ก (advance_offset) แล้ว dropdown แสดงใบเบิกเงินสดย่อยที่อนุมัติแล้วจริง');
    await page.selectOption('#se-linked-voucher', String(pcVoucher.voucher.id));
    await page.fill('#se-vendor', 'ตลาดวัสดุ E2E');
    await page.fill('#se-amount', '300');
    await page.setInputFiles('#se-photos', [testFile('bill-2.jpg')]);
    await page.click('[data-act="submit-site-expense"]');
    await page.waitForTimeout(700);
    const se2 = await pool.query(`SELECT id, expense_case, linked_voucher_id FROM client_site_expense_submissions WHERE vendor_name='ตลาดวัสดุ E2E'`);
    if (se2.rowCount === 0) {
      const debugToasts = await page.locator('.toast, [class*="toast"]').allTextContents();
      console.log('DEBUG toasts at failure point:', JSON.stringify(debugToasts));
      console.log('DEBUG se-project value:', await page.inputValue('#se-project').catch(() => 'N/A'));
      console.log('DEBUG se-linked-voucher value:', await page.inputValue('#se-linked-voucher').catch(() => 'N/A'));
      console.log('DEBUG current page:', await page.locator('h2').first().textContent().catch(() => 'N/A'));
      const anyRecent = await pool.query('SELECT id, vendor_name, expense_case, linked_voucher_id, amount, status FROM client_site_expense_submissions ORDER BY id DESC LIMIT 5');
      console.log('DEBUG most recent submissions in DB:', JSON.stringify(anyRecent.rows));
    }
    assert(se2.rowCount === 1 && se2.rows[0].expense_case === 'advance_offset' && se2.rows[0].linked_voucher_id === pcVoucher.voucher.id, `สร้างใบส่งบิลกรณี ก (advance_offset) ผูกกับใบเบิกเดิมสำเร็จจริง (ได้ ${JSON.stringify(se2.rows[0])})`);
    createdSiteExpenseIds.push(se2.rows[0].id);

    // ================= 9) สิทธิ์ — fx_maker2 ไม่เห็นเมนูคิวหน้างานเลย (ไม่มี flag ใดๆ) =================
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    const seNavForMaker2 = await page.locator('.nav-item[data-page="fin_site_expense_submissions"]').count();
    assert(seNavForMaker2 === 0, 'fx_maker2 ไม่เห็นเมนูส่งบิลค่าใช้จ่ายหน้างานเลย (ไม่มี can_submit_site_expense/can_settle_cash)');

    // ================= 10) fx_settler (มีแค่ can_settle_cash) เห็นคิวได้ แต่ไม่เห็นปุ่ม "+ ส่งบิล" =================
    await loginAs('fx_settler');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    const seNavForSettler = await page.locator('.nav-item[data-page="fin_site_expense_submissions"]').count();
    assert(seNavForSettler === 1, 'fx_settler (can_settle_cash) เห็นเมนูคิวส่งบิลได้ (ไปประมวลผลได้แม้ไม่ได้ส่งเรื่องเอง)');
    await page.click('[data-act="nav"][data-page="fin_site_expense_submissions"]');
    await page.waitForTimeout(400);
    const addBtnForSettler = await page.locator('[data-act="open-site-expense-add"]').count();
    assert(addBtnForSettler === 0, 'fx_settler ไม่เห็นปุ่ม "ส่งบิลค่าใช้จ่าย" (มีแค่ can_settle_cash ไม่มี can_submit_site_expense)');

    // ================= 11) fx_settler ปิดเรื่อง se1 (payable) เป็น payment_voucher — สร้าง voucher จริงก่อนผ่าน prefill =================
    await page.click(`button[data-page="fin_site_expense_submission_detail"][data-id="${se1.rows[0].id}"]`);
    await page.waitForTimeout(400);
    const processSectionVisible = await page.locator('[data-act="prefill-create-voucher"]').count();
    assert(processSectionVisible === 1, 'fx_settler เห็นปุ่ม prefill สร้างเอกสาร (มีสิทธิ์ประมวลผลจริง)');
    await page.click('[data-act="prefill-create-voucher"]');
    await page.waitForTimeout(400);
    const prefillAmount = await page.inputValue('#f-vAmount').catch(() => null);
    assert(prefillAmount === '850', `กดปุ่ม prefill แล้วฟอร์มสร้างใบเบิกจ่ายเจ้าหนี้ภายนอก มียอดเงิน prefill มาให้ถูกต้อง = 850 (ได้ ${prefillAmount})`);
    await page.click('[data-act="cancel-voucher-form"]');
    await page.waitForTimeout(300);

    // สร้าง voucher จริงทาง HTTP (จำลองว่าบัญชีกรอกจนจบแล้ว) เพื่อเอา id มาปิดเรื่อง
    const payee = await call('fx_super', 'POST', '/api/customer/external-payees', { name: 'ร้านวัสดุก่อสร้าง E2E ผู้รับเงิน', taxpayerType: 'individual' });
    const otherVoucher = await call('fx_super', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'other', payeeExternalId: payee.externalPayee.id, projectId: proj.project.id, amount: 850, expenseAccountCode: '5300', purpose: 'จ่ายร้านวัสดุก่อสร้าง E2E (จากคิวหน้างาน)',
    }, idemKey('sw-other-create'));
    createdVoucherIds.push(otherVoucher.voucher.id);

    await page.click('[data-act="nav"][data-page="fin_site_expense_submissions"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_site_expense_submission_detail"][data-id="${se1.rows[0].id}"]`);
    await page.waitForTimeout(400);
    await page.click('[data-act="open-se-close"]');
    await page.waitForTimeout(300);
    await page.fill('input[type="number"]', String(otherVoucher.voucher.id));
    await page.click(`[data-act="submit-se-close"][data-id="${se1.rows[0].id}"]`);
    await page.waitForTimeout(600);
    const se1Closed = await pool.query('SELECT status, result_doc_type, result_doc_id FROM client_site_expense_submissions WHERE id=$1', [se1.rows[0].id]);
    assert(se1Closed.rows[0].status === 'closed' && se1Closed.rows[0].result_doc_type === 'payment_voucher' && se1Closed.rows[0].result_doc_id === otherVoucher.voucher.id, `ปิดเรื่องสำเร็จจริง อ้างอิงเอกสารที่สร้างจริงถูกต้อง (ได้ ${JSON.stringify(se1Closed.rows[0])})`);
    await shot(page, 'site-expense-closed');

    // ================= 12) fx_settler ตีกลับ se2 (advance_offset) พร้อมเหตุผล =================
    await page.click('[data-act="nav"][data-page="fin_site_expense_submissions"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_site_expense_submission_detail"][data-id="${se2.rows[0].id}"]`);
    await page.waitForTimeout(400);
    await page.click('[data-act="open-se-reject"]');
    await page.waitForTimeout(300);
    await page.fill('input[oninput*="siteExpenseRejectForm.reason"]', 'ยอดเงินไม่ตรงกับใบเสร็จจริง');
    await page.click(`[data-act="submit-se-reject"][data-id="${se2.rows[0].id}"]`);
    await page.waitForTimeout(600);
    const se2Rejected = await pool.query('SELECT status, rejected_reason FROM client_site_expense_submissions WHERE id=$1', [se2.rows[0].id]);
    assert(se2Rejected.rows[0].status === 'rejected' && se2Rejected.rows[0].rejected_reason === 'ยอดเงินไม่ตรงกับใบเสร็จจริง', `ตีกลับสำเร็จจริง พร้อมเหตุผลที่บันทึกถูกต้อง (ได้ ${JSON.stringify(se2Rejected.rows[0])})`);

    // ================= 13) สิทธิ์ backend ตรง — fx_maker2 เรียก close/reject ตรงๆ ต้องโดน 403 =================
    let closeBlocked = null;
    try { await call('fx_maker2', 'POST', `/api/customer/site-expense-submissions/${se1.rows[0].id}/reject`, { reason: 'test' }); }
    catch (e) { closeBlocked = e; }
    assert(closeBlocked !== null && closeBlocked.status === 403, `fx_maker2 (ไม่มี can_settle_cash) เรียก reject ตรงๆ ทาง API ได้ 403 ไม่ใช่ 500 (ได้ status=${closeBlocked && closeBlocked.status})`);

    console.log('\nconsole errors during whole run:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)');
    const unexpectedErrors = consoleErrors.filter(e => !/404|400 \(Bad Request\)|403 \(Forbidden\)|409 \(Conflict\)/.test(e));
    assert(unexpectedErrors.length === 0, `ไม่มี JS error ที่ไม่คาดคิด (ได้ ${JSON.stringify(unexpectedErrors)})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nE2E TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (createdSiteExpenseIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='site_expense_submission' AND doc_id = ANY($1)`, [createdSiteExpenseIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint='site-expense-submissions-create'`, [COMPANY_A_ID]);
        const seAttachments = await pool.query('SELECT storage_path FROM client_site_expense_attachments WHERE submission_id = ANY($1)', [createdSiteExpenseIds]);
        for (const a of seAttachments.rows) fs.unlink(path.join(__dirname, '..', 'uploads', 'site-expense-attachments', a.storage_path), () => {});
        await pool.query('DELETE FROM client_site_expense_attachments WHERE submission_id = ANY($1)', [createdSiteExpenseIds]);
        await pool.query('DELETE FROM client_site_expense_submissions WHERE id = ANY($1)', [createdSiteExpenseIds]);
      }
      if (createdGoodsReceiptIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='goods_receipt' AND doc_id = ANY($1)`, [createdGoodsReceiptIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint='goods-receipts-create'`, [COMPANY_A_ID]);
        const grAttachments = await pool.query('SELECT storage_path FROM client_goods_receipt_attachments WHERE receipt_id = ANY($1)', [createdGoodsReceiptIds]);
        for (const a of grAttachments.rows) fs.unlink(path.join(__dirname, '..', 'uploads', 'goods-receipt-attachments', a.storage_path), () => {});
        await pool.query('DELETE FROM client_goods_receipt_attachments WHERE receipt_id = ANY($1)', [createdGoodsReceiptIds]);
        await pool.query('DELETE FROM client_goods_receipt_items WHERE receipt_id = ANY($1)', [createdGoodsReceiptIds]);
        await pool.query('DELETE FROM client_goods_receipts WHERE id = ANY($1)', [createdGoodsReceiptIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'payment-vouchers-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      await pool.query(`DELETE FROM client_external_payees WHERE name='ร้านวัสดุก่อสร้าง E2E ผู้รับเงิน' AND company_id=$1`, [COMPANY_A_ID]);
      await pool.query(`DELETE FROM client_petty_cash_funds WHERE name='กองทุน E2E งานหน้างาน' AND company_id=$1`, [COMPANY_A_ID]);
      if (createdPoIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='purchase_order' AND doc_id = ANY($1)`, [createdPoIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'purchase-orders-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_purchase_order_items WHERE purchase_order_id = ANY($1)', [createdPoIds]);
        await pool.query('DELETE FROM client_purchase_orders WHERE id = ANY($1)', [createdPoIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
