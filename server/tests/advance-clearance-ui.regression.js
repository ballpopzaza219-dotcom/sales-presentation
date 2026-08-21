// Real-browser E2E coverage for topic 1.3 ROUND A (list/create/edit/submit/reject/cancel) via
// Playwright. approve/settle/journal-preview/WHT-certificate coverage lives in the separate round B
// file (advance-clearance-settle-ui.regression.js) — this file only confirms the approve/reject
// buttons are visible/hidden to the right roles, not their full behavior.
// Not part of `npm run test:client-ledger` (pure HTTP/DB) — run standalone against a live local server.
//
// Prerequisite approved advance vouchers are created via plain HTTP fetch calls (mirroring
// advance-clearance.regression.js's makeApprovedAdvanceVoucher() helper) rather than driving the
// advance-voucher UI again — that flow already has its own dedicated E2E coverage in
// advance-vouchers-ui.regression.js, so re-driving it here through the browser would just be slower
// duplication, not new coverage.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name){ shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `advcl-${String(shotN).padStart(2,'0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg){ if(!cond) throw new Error('ASSERTION FAILED: '+msg); passed++; console.log('  OK:', msg); }

// ---- plain HTTP helpers for prerequisite setup (not the thing under test) ----
const cookies = {};
async function call(username, method, urlPath, body, idempotencyKey){
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch(e){ json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function httpLogin(username, companyCode){ await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD }); }
let idemCounter = 0;
function idemKey(label){ return `${label}-${Date.now()}-${idemCounter++}`; }
async function makeApprovedAdvanceVoucher(companyCode, employeeIdPlaceholderIndex, amount){
  const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'advance', payeeEmployeeId: employeeIdPlaceholderIndex, purpose: 'E2E advance for clearance round A', amount,
  }, idemKey('advcl-ui-voucher-create'));
  await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('advcl-ui-voucher-submit'));
  const approved = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('advcl-ui-voucher-approve'));
  return approved.voucher;
}

(async () => {
  let browser;
  const consoleErrors = [];
  const createdVoucherIds = [];
  const createdClearanceIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;
    const employeeRes = await pool.query(`SELECT id FROM employees WHERE company_id=$1 AND status='active' LIMIT 1`, [COMPANY_A_ID]);
    const employeeId = employeeRes.rows[0].id;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_approver_mid', companyCode);

    console.log('Creating prerequisite approved advance vouchers via HTTP...');
    const voucherExact = await makeApprovedAdvanceVoucher(companyCode, employeeId, 10000);
    const voucherOverage = await makeApprovedAdvanceVoucher(companyCode, employeeId, 10000);
    const voucherShortfall = await makeApprovedAdvanceVoucher(companyCode, employeeId, 10000);
    const voucherReject = await makeApprovedAdvanceVoucher(companyCode, employeeId, 5000);
    const voucherCancel = await makeApprovedAdvanceVoucher(companyCode, employeeId, 5000);
    [voucherExact, voucherOverage, voucherShortfall, voucherReject, voucherCancel].forEach(v => createdVoucherIds.push(v.id));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    async function loginAs(username){
      await page.goto(BASE + '/pr-system.html');
      await page.click('[data-act="go-login"]');
      await page.waitForTimeout(200);
      await page.fill('#f-loginCompanyCode', companyCode);
      await page.fill('#f-loginUser', username);
      await page.fill('#f-loginPass', PASSWORD);
      await page.click('[data-act="do-login"]');
      await page.waitForTimeout(700);
      await page.click('[data-act="switch-module"][data-module="finance"]');
      await page.waitForTimeout(400);
    }

    // ================= 1) หน้า list + สร้างใบเคลียร์เคสพอดี (exact match) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(600);
    await shot(page, 'list-empty-or-existing');
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(voucherExact.id));
    await page.waitForTimeout(200);
    const bannerText = await page.locator('text=ยอดเงินทดรองจ่ายที่เบิกไว้').textContent();
    assert(bannerText.includes('10,000.00'), `แบนเนอร์ยอด advance แสดง 10,000.00 ตลอดเวลาตามที่ขอ (ได้ "${bannerText}")`);

    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ค่าที่พักเดินทางไปหน้างาน');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '10000');
    await page.fill('#ci-payeename-0', 'โรงแรมทดสอบ E2E');
    await page.waitForTimeout(150);
    await shot(page, 'exact-match-summary');
    const diffTextExact = await page.locator('#cSummaryDifference').textContent();
    const msgTextExact = await page.locator('#cSummaryMessage').textContent();
    assert(diffTextExact.trim()==='0.00', `เคสพอดี (1.3.1): ส่วนต่างสด = 0.00 คำนวณถูกต้องขณะกรอก (ได้ "${diffTextExact}")`);
    assert(msgTextExact.includes('พอดี') || msgTextExact.includes('ไม่มีส่วนต่าง'), `ข้อความภาษาคนบอก "พอดี ไม่มีส่วนต่าง" ถูกต้อง (ได้ "${msgTextExact}")`);
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearanceExactRow = await pool.query(`SELECT id, status FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucherExact.id]);
    assert(clearanceExactRow.rowCount===1 && clearanceExactRow.rows[0].status==='draft', `ใบเคลียร์เคสพอดีถูกสร้างเป็น draft จริงใน DB (ได้ status=${clearanceExactRow.rows[0]&&clearanceExactRow.rows[0].status})`);
    createdClearanceIds.push(clearanceExactRow.rows[0].id);

    // ================= 2) เคสเบิกเกิน (overage) พร้อม VAT+WHT — ทดสอบหลายรายการ + ลบรายการ =================
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(voucherOverage.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ค่าวัสดุก่อสร้าง');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '7000');
    await page.fill('#ci-payeename-0', 'ร้านวัสดุก่อสร้าง E2E');
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-1', 'ค่าที่จะลบทิ้ง (ทดสอบลบรายการ)');
    await page.selectOption('#ci-account-1', '5300');
    await page.fill('#ci-amount-1', '9999');
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-2', 'ค่าบริการวิชาชีพ (มี VAT+WHT)');
    await page.selectOption('#ci-account-2', '5300');
    await page.fill('#ci-amount-2', '5000');
    await page.fill('#ci-payeename-2', 'ที่ปรึกษาอิสระ E2E');
    await page.fill('#ci-payeetaxid-2', '1234567890123');
    await page.check('#ci-hastax-2');
    await page.fill('#ci-vatrate-2', '7');
    await page.selectOption('#ci-whttype-2', '40_2');
    await page.waitForTimeout(150);
    const autoFilledWht = await page.locator('#ci-whtrate-2').inputValue();
    assert(autoFilledWht==='3', `เลือกประเภทเงินได้ 40(2) แล้ว auto-fill อัตรา WHT บรรทัดนี้ = 3 จริง (ได้ "${autoFilledWht}")`);
    const netLine2Before = await page.locator('#ci-net-2').textContent();
    assert(netLine2Before.replace(/[^0-9.]/g,'')==='5200.00', `ยอดสุทธิรายการ VAT+WHT คำนวณสดถูกต้อง = 5,200.00 (5,000 + VAT 350 - WHT 150) (ได้ "${netLine2Before}")`);

    // ลบรายการที่ 2 (index 1, "ค่าที่จะลบทิ้ง") — เหลือ 2 รายการ ผลรวมต้องไม่รวมรายการที่ลบไปแล้ว
    await page.click('[data-act="remove-clearance-item"][data-idx="1"]');
    await page.waitForTimeout(200);
    await shot(page, 'overage-after-remove-item');
    const expenseTextOverage = await page.locator('#cSummaryExpense').textContent();
    // เหลือ 7,000 (ไม่มีภาษี) + 5,200 (สุทธิหลัง VAT 350 - WHT 150) = 12,200
    assert(expenseTextOverage.replace(/[^0-9.]/g,'')==='12200.00', `ลบรายการกลางแล้ว ยอดรวมค่าใช้จ่ายสดคำนวณใหม่ถูกต้อง = 12,200.00 ไม่รวมรายการที่ลบไปแล้ว (ได้ "${expenseTextOverage}")`);
    const diffTextOverage = await page.locator('#cSummaryDifference').textContent();
    assert(diffTextOverage.includes('2,200.00') || diffTextOverage.includes('+2200'), `ส่วนต่างสด = +2,200.00 (12,200-10,000) (ได้ "${diffTextOverage}")`);
    const msgTextOverage = await page.locator('#cSummaryMessage').textContent();
    assert(msgTextOverage.includes('บริษัทต้องจ่ายเพิ่ม') && msgTextOverage.includes('2,200.00'), `ข้อความภาษาคนบอก "บริษัทต้องจ่ายเพิ่ม 2,200.00 บาท" ถูกต้อง (ได้ "${msgTextOverage}")`);

    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearanceOverageRow = await pool.query(`SELECT id, total_expense_amount, difference_amount FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucherOverage.id]);
    assert(clearanceOverageRow.rowCount===1, 'ใบเคลียร์เคสเบิกเกินถูกสร้างจริงใน DB');
    createdClearanceIds.push(clearanceOverageRow.rows[0].id);
    assert(Number(clearanceOverageRow.rows[0].total_expense_amount)===12200, `บันทึกจริงใน DB: total_expense_amount = 12,200 ตรงกับยอดสดที่คำนวณไว้ (ได้ ${clearanceOverageRow.rows[0].total_expense_amount})`);
    assert(Number(clearanceOverageRow.rows[0].difference_amount)===2200, `บันทึกจริงใน DB: difference_amount = 2,200 (ได้ ${clearanceOverageRow.rows[0].difference_amount})`);
    const itemCountOverage = await pool.query(`SELECT COUNT(*)::int AS n FROM client_advance_clearance_items WHERE clearance_id=$1`, [clearanceOverageRow.rows[0].id]);
    assert(itemCountOverage.rows[0].n===2, `บันทึกจริงใน DB: เหลือ 2 รายการพอดี (รายการที่ลบไปไม่ถูกบันทึก) (ได้ ${itemCountOverage.rows[0].n})`);

    // ================= 3) เคสเบิกไม่หมด (shortfall) — ผู้รับเงินแบบ manual (ไม่ผูก master data) =================
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(voucherShortfall.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ค่าเดินทาง');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '6000');
    await page.fill('#ci-payeename-0', 'ร้านค้าทั่วไป (ไม่มี tax id)');
    await page.waitForTimeout(150);
    const diffTextShortfall = await page.locator('#cSummaryDifference').textContent();
    assert(diffTextShortfall.includes('4,000.00') || diffTextShortfall.includes('-4000'), `ส่วนต่างสด = -4,000.00 (6,000-10,000) (ได้ "${diffTextShortfall}")`);
    const msgTextShortfall = await page.locator('#cSummaryMessage').textContent();
    assert(msgTextShortfall.includes('พนักงานต้องคืนเงิน') && msgTextShortfall.includes('4,000.00'), `ข้อความภาษาคนบอก "พนักงานต้องคืนเงินให้บริษัท 4,000.00 บาท" ถูกต้อง (ได้ "${msgTextShortfall}")`);
    await shot(page, 'shortfall-summary');
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearanceShortfallRow = await pool.query(`SELECT id, difference_amount FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucherShortfall.id]);
    createdClearanceIds.push(clearanceShortfallRow.rows[0].id);
    assert(Number(clearanceShortfallRow.rows[0].difference_amount)===-4000, `บันทึกจริงใน DB: difference_amount = -4,000 (เคสคืนเงิน) (ได้ ${clearanceShortfallRow.rows[0].difference_amount})`);
    const manualPayeeCheck = await pool.query(`SELECT payee_name, payee_external_id FROM client_advance_clearance_items WHERE clearance_id=$1`, [clearanceShortfallRow.rows[0].id]);
    assert(manualPayeeCheck.rows[0].payee_external_id===null && manualPayeeCheck.rows[0].payee_name==='ร้านค้าทั่วไป (ไม่มี tax id)', `บันทึกผู้รับเงินแบบ manual (ไม่ผูก master data) ถูกต้องจริงใน DB (ได้ ${JSON.stringify(manualPayeeCheck.rows[0])})`);

    // ================= 4) แก้ไข draft (เคสพอดีที่สร้างไว้ข้อ 1) แล้ว submit =================
    await page.click(`tr[data-id="${clearanceExactRow.rows[0].id}"]`);
    await page.waitForTimeout(500);
    await page.click(`[data-act="open-edit-clearance"][data-id="${clearanceExactRow.rows[0].id}"]`);
    await page.waitForTimeout(300);
    await page.fill('#ci-amount-0', '10500'); // แก้เป็นเบิกเกินแทน
    await page.waitForTimeout(150);
    const diffAfterEdit = await page.locator('#cSummaryDifference').textContent();
    assert(diffAfterEdit.includes('500.00') && !diffAfterEdit.includes('-'), `แก้ไขจำนวนเงินแล้วยอดสรุปสดอัปเดตทันที = +500.00 (ได้ "${diffAfterEdit}")`);
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const editedCheck = await pool.query(`SELECT total_expense_amount, difference_amount FROM client_advance_clearances WHERE id=$1`, [clearanceExactRow.rows[0].id]);
    assert(Number(editedCheck.rows[0].total_expense_amount)===10500, `แก้ไขสำเร็จจริงใน DB: total_expense_amount = 10,500 (ได้ ${editedCheck.rows[0].total_expense_amount})`);

    // submit ใบที่เพิ่งแก้ (กดรัว 3 ครั้ง ต้องได้ครั้งเดียว) — บันทึกแก้ไขเสร็จแล้วอยู่หน้า detail อยู่แล้ว
    // (ไม่ได้เด้งกลับหน้า list) ไม่ต้องคลิกแถวซ้ำ
    await Promise.all([
      page.click('[data-act="submit-clearance"]').catch(()=>{}),
      page.click('[data-act="submit-clearance"]').catch(()=>{}),
      page.click('[data-act="submit-clearance"]').catch(()=>{}),
    ]);
    await page.waitForTimeout(800);
    await shot(page, 'edited-then-submitted');
    const submittedCheck = await pool.query(`SELECT status, clearance_no FROM client_advance_clearances WHERE id=$1`, [clearanceExactRow.rows[0].id]);
    assert(submittedCheck.rows[0].status==='submitted', `ยื่นขออนุมัติสำเร็จจริง status=submitted (ได้ ${submittedCheck.rows[0].status})`);
    assert(!!submittedCheck.rows[0].clearance_no, `ได้เลขที่ใบเคลียร์จริง (${submittedCheck.rows[0].clearance_no})`);
    const idemSubmitCheck = await pool.query(`SELECT count(*) AS n FROM client_idempotency_keys WHERE company_id=$1 AND endpoint=$2`, [COMPANY_A_ID, `advance-clearances-submit:${clearanceExactRow.rows[0].id}`]);
    assert(Number(idemSubmitCheck.rows[0].n)===1, `กดปุ่ม submit รัว 3 ครั้ง แต่เกิด idempotency reservation แค่ 1 รายการจริง (ได้ ${idemSubmitCheck.rows[0].n})`);

    // ================= 5) permission: fx_maker2 ไม่มี can_approve_advance -> ไม่เห็นปุ่มปฏิเสธ =================
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearanceExactRow.rows[0].id}"]`);
    await page.waitForTimeout(600);
    assert(await page.locator('[data-act="open-reject-clearance"]').count()===0, 'fx_maker2 (ไม่มี can_approve_advance) ไม่เห็นปุ่มปฏิเสธเลย');
    assert(await page.locator('[data-act="open-approve-clearance-preview"]').count()===0, 'fx_maker2 ไม่เห็นปุ่มอนุมัติเลย');

    // ปุ่มอนุมัติจริง (พร้อม journal preview) ถูกเพิ่มเข้ามาแล้วในรอบ B — ดูเทสละเอียดเต็มที่
    // advance-clearance-settle-ui.regression.js ไฟล์นี้ยังคงแค่ยืนยันว่า fx_approver_mid เห็นปุ่มทั้งคู่
    // (ขอบเขตของไฟล์นี้คือ CRUD/submit/reject/cancel ไม่ลงรายละเอียด approve/settle ซ้ำ)
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearanceExactRow.rows[0].id}"]`);
    await page.waitForTimeout(600);
    assert(await page.locator('[data-act="open-reject-clearance"]').count()===1, 'fx_approver_mid เห็นปุ่มปฏิเสธ');
    assert(await page.locator('[data-act="open-approve-clearance-preview"]').count()===1, 'fx_approver_mid เห็นปุ่มอนุมัติจริง (รอบ B เพิ่มเข้ามาแล้ว)');
    await shot(page, 'approver-view-with-approve-button');

    // ================= 6) reject พร้อมเหตุผล (ใบใหม่จาก voucherReject) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(voucherReject.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ทดสอบปฏิเสธ');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '5000');
    await page.fill('#ci-payeename-0', 'ผู้รับเงินทดสอบปฏิเสธ');
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearanceRejectRow = await pool.query(`SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucherReject.id]);
    createdClearanceIds.push(clearanceRejectRow.rows[0].id);
    await page.click(`tr[data-id="${clearanceRejectRow.rows[0].id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-clearance"]');
    await page.waitForTimeout(700);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearanceRejectRow.rows[0].id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-reject-clearance"]');
    await page.waitForTimeout(200);
    await page.fill('#c-vRejectReason', 'E2E เหตุผลทดสอบการปฏิเสธใบเคลียร์');
    await page.click('[data-act="submit-reject-clearance"]');
    await page.waitForTimeout(700);
    await shot(page, 'clearance-rejected');
    assert(await page.locator('text=E2E เหตุผลทดสอบการปฏิเสธใบเคลียร์').count()>0, 'เหตุผลที่ปฏิเสธแสดงบนหน้า detail จริง');
    const rejectedCheck = await pool.query(`SELECT status, rejected_reason FROM client_advance_clearances WHERE id=$1`, [clearanceRejectRow.rows[0].id]);
    assert(rejectedCheck.rows[0].status==='rejected', 'สถานะเป็น rejected จริงใน DB');

    // ================= 7) cancel ใบ draft (ใบใหม่จาก voucherCancel) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(voucherCancel.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ทดสอบยกเลิก');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '5000');
    await page.fill('#ci-payeename-0', 'ผู้รับเงินทดสอบยกเลิก');
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearanceCancelRow = await pool.query(`SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucherCancel.id]);
    createdClearanceIds.push(clearanceCancelRow.rows[0].id);
    await page.click(`tr[data-id="${clearanceCancelRow.rows[0].id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="cancel-clearance"]');
    await page.waitForTimeout(700);
    await shot(page, 'clearance-cancelled');
    const cancelledCheck = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearanceCancelRow.rows[0].id]);
    assert(cancelledCheck.rows[0].status==='cancelled', `ยกเลิกใบ draft สำเร็จ status=cancelled (ได้ ${cancelledCheck.rows[0].status})`);

    console.log('\nconsole errors during whole run:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)');
    const unexpectedErrors = consoleErrors.filter(e => !/404|400 \(Bad Request\)|409 \(Conflict\)/.test(e));
    assert(unexpectedErrors.length===0, `ไม่มี JS error ที่ไม่คาดคิด (ได้ ${JSON.stringify(unexpectedErrors)})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nE2E TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (createdClearanceIds.length) {
        await pool.query(`DELETE FROM client_wht_certificates WHERE company_id=$1 AND source_type='advance_clearance_item' AND source_id IN (SELECT id FROM client_advance_clearance_items WHERE clearance_id = ANY($2))`, [COMPANY_A_ID, createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1))`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1)`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='advance_clearance' AND doc_id = ANY($1)`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint = ANY($2)`, [COMPANY_A_ID, createdClearanceIds.flatMap(id => [`advance-clearances-submit:${id}`, `advance-clearances-approve:${id}`, `advance-clearances-settle:${id}`])]);
        await pool.query(`DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)`, [createdClearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [createdClearanceIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'payment-vouchers-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
