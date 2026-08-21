// Real-browser E2E coverage for the advance voucher UI (topic 1.2) via Playwright.
// Not part of `npm run test:client-ledger` (that chain is pure HTTP/DB, no browser) — run this one
// on its own with `npm run test:advance-vouchers-ui` against a live local server (npm start).
// Mirrors petty-cash-vouchers-ui.regression.js with the differences specific to advance vouchers:
// no fund, no expense-account field, journal is Dr 1150 (advance receivable) / Cr 1100 (cash-bank),
// and an extra check that the outstanding-advances report matches what was actually approved.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name){ shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `adv-${String(shotN).padStart(2,'0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg){ if(!cond) throw new Error('ASSERTION FAILED: '+msg); passed++; console.log('  OK:', msg); }

(async () => {
  let browser;
  const consoleErrors = [];
  const createdVoucherIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
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

    // ================= 1) สร้าง draft -> แก้ไข -> submit (fx_maker, ไม่ใช่ super_user, ไม่มีกองทุน) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await shot(page, 'list-empty-or-existing');
    // ฟอร์มเงินทดรองจ่ายต้องไม่มี select กองทุน/รหัสบัญชี (needsFund/needsExpenseAccount=false)
    assert(await page.locator('#f-vFund').count()===0, 'ฟอร์มไม่มี dropdown กองทุน (advance ไม่มีกองทุน)');
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    assert(await page.locator('#f-vFund').count()===0, 'ฟอร์มที่เปิดแล้วก็ยังไม่มี dropdown กองทุน');
    assert(await page.locator('#f-vExpenseAccount').count()===0, 'ฟอร์มไม่มี dropdown รหัสบัญชีค่าใช้จ่าย (advance ไม่ลงค่าใช้จ่ายทันที)');
    const purposeLabelText = await page.locator('label').filter({ hasText: 'วัตถุประสงค์การเบิก' }).count();
    assert(purposeLabelText>0, 'label วัตถุประสงค์ใช้คำว่า "วัตถุประสงค์การเบิก" ตามที่ระบุ ไม่ใช่คำทั่วไป');
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '8000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบเงินทดรองจ่าย A');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-a-draft');

    const voucherARow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='advance' AND purpose LIKE 'E2E ทดสอบเงินทดรองจ่าย A%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    assert(voucherARow.rowCount===1, 'ใบเบิกเงินทดรองจ่าย A ถูกสร้างเป็น draft จริงใน DB');
    const voucherAId = voucherARow.rows[0].id;
    createdVoucherIds.push(voucherAId);
    const dbCheckFund = await pool.query('SELECT petty_cash_fund_id, payee_employee_id FROM client_payment_vouchers WHERE id=$1', [voucherAId]);
    assert(dbCheckFund.rows[0].petty_cash_fund_id===null, 'petty_cash_fund_id เป็น NULL จริงใน DB (บังคับโดย DB CHECK constraint ด้วย)');
    assert(!!dbCheckFund.rows[0].payee_employee_id, 'payee_employee_id ถูกตั้งค่าไว้จริง (ผู้ขอเบิกเป็นพนักงาน)');

    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(500);

    // แก้ไข draft
    await page.click('[data-act="open-edit-voucher"]');
    await page.waitForTimeout(300);
    await page.fill('#f-vAmount', '8500');
    await page.fill('#f-vPurpose', 'E2E ทดสอบเงินทดรองจ่าย A (แก้ไขแล้ว)');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-a-edited');
    const editCheck = await pool.query('SELECT amount, purpose FROM client_payment_vouchers WHERE id=$1', [voucherAId]);
    assert(Number(editCheck.rows[0].amount)===8500, `แก้ไขจำนวนเงินสำเร็จจริง = 8500 (ได้ ${editCheck.rows[0].amount})`);
    assert(editCheck.rows[0].purpose.includes('แก้ไขแล้ว'), 'แก้ไขวัตถุประสงค์สำเร็จจริง');

    // submit — กดรัว 3 ครั้ง ต้องได้ครั้งเดียว (เหมือนที่แก้ไปแล้วในขั้น 1)
    await Promise.all([
      page.click('[data-act="submit-voucher"]').catch(()=>{}),
      page.click('[data-act="submit-voucher"]').catch(()=>{}),
      page.click('[data-act="submit-voucher"]').catch(()=>{}),
    ]);
    await page.waitForTimeout(800);
    await shot(page, 'voucher-a-submitted');
    const submitCheck = await pool.query('SELECT status, voucher_no FROM client_payment_vouchers WHERE id=$1', [voucherAId]);
    assert(submitCheck.rows[0].status==='submitted', `ยื่นขออนุมัติสำเร็จ status=submitted (ได้ ${submitCheck.rows[0].status})`);
    assert(!!submitCheck.rows[0].voucher_no, `ได้เลขที่ใบเบิกจริง (${submitCheck.rows[0].voucher_no})`);
    const idemCheck = await pool.query(`SELECT count(*) AS n FROM client_idempotency_keys WHERE company_id=$1 AND endpoint=$2`, [COMPANY_A_ID, `payment-vouchers-submit:${voucherAId}`]);
    assert(Number(idemCheck.rows[0].n)===1, `กดปุ่ม submit รัว 3 ครั้ง แต่เกิด idempotency reservation แค่ 1 รายการจริง (ได้ ${idemCheck.rows[0].n})`);

    // ================= ปุ่มซ่อนเมื่อไม่มีสิทธิ์อนุมัติ (fx_maker2, ไม่มี can_approve_advance) =================
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(600);
    await shot(page, 'voucher-a-no-approve-button');
    assert(await page.locator('[data-act="approve-voucher"]').count()===0, 'fx_maker2 (ไม่มี can_approve_advance) ไม่เห็นปุ่มอนุมัติเลย');

    // ================= approve ด้วย fx_approver_mid (มีสิทธิ์+active rule, ไม่ใช่คนสร้าง) — กดรัว 3 ครั้ง =================
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(600);
    assert(await page.locator('[data-act="approve-voucher"]').count()===1, 'fx_approver_mid เห็นปุ่มอนุมัติ');
    await Promise.all([
      page.click('[data-act="approve-voucher"]').catch(()=>{}),
      page.click('[data-act="approve-voucher"]').catch(()=>{}),
      page.click('[data-act="approve-voucher"]').catch(()=>{}),
    ]);
    await page.waitForTimeout(900);
    await shot(page, 'voucher-a-approved');

    const approveCheck = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucherAId]);
    assert(approveCheck.rows[0].status==='approved', `อนุมัติสำเร็จจริง status=approved (ได้ ${approveCheck.rows[0].status})`);
    const idemApproveCheck = await pool.query(`SELECT count(*) AS n FROM client_idempotency_keys WHERE company_id=$1 AND endpoint=$2`, [COMPANY_A_ID, `payment-vouchers-approve:${voucherAId}`]);
    assert(Number(idemApproveCheck.rows[0].n)===1, `กดปุ่ม approve รัว 3 ครั้ง แต่เกิด idempotency reservation แค่ 1 รายการจริง (ได้ ${idemApproveCheck.rows[0].n})`);

    const journalCheck = await pool.query(
      `SELECT l.account_code, l.debit_amount, l.credit_amount FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='payment_voucher' AND e.source_id=$1 ORDER BY l.id`,
      [voucherAId]
    );
    assert(journalCheck.rowCount===2, `เกิด journal line พอดี 2 บรรทัด (Dr/Cr) ไม่ใช่ซ้ำจากการกดรัว (ได้ ${journalCheck.rowCount})`);
    const dr = journalCheck.rows.find(r=>Number(r.debit_amount)>0);
    const cr = journalCheck.rows.find(r=>Number(r.credit_amount)>0);
    assert(dr && dr.account_code==='1150' && Number(dr.debit_amount)===8500, `Journal Dr 1150 (ลูกหนี้เงินทดรองจ่าย) = 8,500 จริง (ได้ ${dr&&dr.account_code}/${dr&&dr.debit_amount})`);
    assert(cr && cr.account_code==='1100' && Number(cr.credit_amount)===8500, `Journal Cr 1100 (เงินสด-ธนาคาร) = 8,500 จริง (ได้ ${cr&&cr.account_code}/${cr&&cr.credit_amount})`);
    const journalTextVisible = await page.locator('text=1150').count();
    assert(journalTextVisible>0, 'หน้า detail แสดงเลขบัญชี 1150 ในตาราง journal จริงบนหน้าจอ');

    // ================= reject พร้อมเหตุผล (ใบ B) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '2000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบปฏิเสธเงินทดรองจ่าย B');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(600);
    const voucherBRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='advance' AND purpose LIKE 'E2E ทดสอบปฏิเสธเงินทดรองจ่าย B%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    const voucherBId = voucherBRow.rows[0].id;
    createdVoucherIds.push(voucherBId);
    await page.click(`tr[data-id="${voucherBId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(600);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherBId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-reject-voucher"]');
    await page.waitForTimeout(200);
    await page.fill('#f-vRejectReason', 'E2E เหตุผลทดสอบการปฏิเสธเงินทดรองจ่าย');
    await page.click('[data-act="submit-reject-voucher"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-b-rejected');
    assert(await page.locator('text=E2E เหตุผลทดสอบการปฏิเสธเงินทดรองจ่าย').count()>0, 'เหตุผลที่ปฏิเสธแสดงบนหน้า detail จริง');
    const voucherBCheck = await pool.query('SELECT status, rejected_reason FROM client_payment_vouchers WHERE id=$1', [voucherBId]);
    assert(voucherBCheck.rows[0].status==='rejected', 'สถานะเป็น rejected จริงใน DB');
    assert(voucherBCheck.rows[0].rejected_reason==='E2E เหตุผลทดสอบการปฏิเสธเงินทดรองจ่าย', 'บันทึกเหตุผลลง DB ตรงกับที่กรอกจริง');

    // ================= cancel ใบ draft (ใบ C) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_advance"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '1500');
    await page.fill('#f-vPurpose', 'E2E ทดสอบยกเลิกเงินทดรองจ่าย C');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(600);
    const voucherCRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='advance' AND purpose LIKE 'E2E ทดสอบยกเลิกเงินทดรองจ่าย C%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    const voucherCId = voucherCRow.rows[0].id;
    createdVoucherIds.push(voucherCId);
    await page.click(`tr[data-id="${voucherCId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="cancel-voucher"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-c-cancelled');
    const voucherCCheck = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucherCId]);
    assert(voucherCCheck.rows[0].status==='cancelled', `ยกเลิกใบ draft สำเร็จ status=cancelled (ได้ ${voucherCCheck.rows[0].status})`);

    // ================= ยอดคงค้างในรายงานตรงกับที่อนุมัติไป (voucher A = 8,500, B/C ไม่นับเพราะไม่ approved) =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_advance_outstanding"]');
    await page.waitForTimeout(600);
    await shot(page, 'outstanding-report');
    const payeeRow = await pool.query('SELECT full_name FROM employees WHERE id=(SELECT payee_employee_id FROM client_payment_vouchers WHERE id=$1)', [voucherAId]);
    const payeeName = payeeRow.rows[0].full_name;
    const reportTextVisible = await page.locator(`text=${payeeName}`).count();
    assert(reportTextVisible>0, `รายงานแสดงชื่อพนักงานที่มียอดคงค้างจริง (${payeeName})`);
    const amountTextVisible = await page.locator('text=8,500.00').count();
    assert(amountTextVisible>0, 'รายงานแสดงยอด 8,500.00 (เฉพาะใบ A ที่ approved) ตรงกับที่อนุมัติจริง ไม่รวมใบ B (rejected) หรือใบ C (cancelled)');
    const outstandingApiCheck = await pool.query(
      `SELECT SUM(amount) AS total FROM client_payment_vouchers
       WHERE voucher_type='advance' AND status='approved' AND payee_employee_id=(SELECT payee_employee_id FROM client_payment_vouchers WHERE id=$1)
       AND NOT EXISTS (SELECT 1 FROM client_advance_clearances c WHERE c.advance_voucher_id=client_payment_vouchers.id AND c.status='approved')`,
      [voucherAId]
    );
    assert(Number(outstandingApiCheck.rows[0].total)===8500, `ยอดคงค้างจริงใน DB ตรงกับที่อนุมัติ = 8,500 (ได้ ${outstandingApiCheck.rows[0].total})`);
    // คลิกลิงก์ใบเบิกในรายงาน ต้องไปหน้า detail ของใบนั้นได้จริง
    await page.click(`text=${submitCheck.rows[0].voucher_no}`);
    await page.waitForTimeout(500);
    assert((await page.locator('h2').first().textContent()||'').includes(submitCheck.rows[0].voucher_no), 'คลิกจากรายงานไปหน้า detail ของใบเบิกได้จริง');

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
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint = ANY($2)`, [COMPANY_A_ID, createdVoucherIds.flatMap(id => [`payment-vouchers-submit:${id}`, `payment-vouchers-approve:${id}`])]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
