// Real-browser E2E coverage for the petty-cash voucher UI (topic 1.1) via Playwright.
// Not part of `npm run test:client-ledger` (that chain is pure HTTP/DB, no browser) — run this one
// on its own with `npm run test:petty-cash-vouchers-ui` against a live local server (npm start).
// Screenshots are written to server/tests/screenshots/ (gitignored) for manual review, not committed.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name){ shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `pcv-${String(shotN).padStart(2,'0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg){ if(!cond) throw new Error('ASSERTION FAILED: '+msg); passed++; console.log('  OK:', msg); }

(async () => {
  let browser;
  const consoleErrors = [];
  const createdFundIds = [];
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

    // ================= 1) สร้างกองทุน (super_user) =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_petty_cash_funds"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-fund"]');
    await page.waitForTimeout(200);
    const fundName = 'E2E Fund ' + Date.now();
    await page.fill('#f-fundName', fundName);
    await page.fill('#f-fundLimit', '20000');
    await page.click('[data-act="submit-fund"]');
    await page.waitForTimeout(600);
    await shot(page, 'fund-created');
    const fundRow = await pool.query('SELECT id, fund_limit FROM client_petty_cash_funds WHERE company_id=$1 AND name=$2', [COMPANY_A_ID, fundName]);
    assert(fundRow.rowCount===1, `กองทุน "${fundName}" ถูกสร้างจริงใน DB`);
    const fundId = fundRow.rows[0].id;
    createdFundIds.push(fundId);

    // ================= 2) สร้างใบเบิก draft -> แก้ไข -> submit (fx_maker, ไม่ใช่ super_user) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vFund', String(fundId));
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '3000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบใบเบิก A');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-a-draft');

    const voucherARow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE petty_cash_fund_id=$1 AND purpose LIKE 'E2E ทดสอบใบเบิก A%' ORDER BY id DESC LIMIT 1`, [fundId]);
    assert(voucherARow.rowCount===1, 'ใบเบิก A ถูกสร้างเป็น draft จริงใน DB');
    const voucherAId = voucherARow.rows[0].id;
    createdVoucherIds.push(voucherAId);

    // สร้างเสร็จแล้วอยู่หน้ารายการ ต้องคลิกแถวเพื่อเข้าหน้า detail ก่อนถึงจะแก้ไขได้
    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(500);

    // แก้ไข draft
    await page.click('[data-act="open-edit-voucher"]');
    await page.waitForTimeout(300);
    await page.fill('#f-vAmount', '3500');
    await page.fill('#f-vPurpose', 'E2E ทดสอบใบเบิก A (แก้ไขแล้ว)');
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-a-edited');
    const editCheck = await pool.query('SELECT amount, purpose, expense_account_code FROM client_payment_vouchers WHERE id=$1', [voucherAId]);
    assert(Number(editCheck.rows[0].amount)===3500, `แก้ไขจำนวนเงินสำเร็จจริง = 3500 (ได้ ${editCheck.rows[0].amount})`);
    assert(editCheck.rows[0].purpose.includes('แก้ไขแล้ว'), 'แก้ไขวัตถุประสงค์สำเร็จจริง');
    assert(editCheck.rows[0].expense_account_code==='5300', 'ตั้งรหัสบัญชีค่าใช้จ่ายสำเร็จจริง');

    // submit — ยิงปุ่ม 3 ครั้งรัวๆ ต้องได้เอกสารเดียว ไม่ใช่สาม (Idempotency-Key ต้องคงที่ต่อการกดหนึ่งครั้ง
    // และปุ่มต้อง disabled ระหว่างรอ response — ดู CLAUDE.md client-ledger rule 8 / voucherActionKey())
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
    assert(Number(idemCheck.rows[0].n)===1, `กดปุ่ม submit รัว 3 ครั้ง แต่เกิด idempotency reservation แค่ 1 รายการจริง (ได้ ${idemCheck.rows[0].n}) — ไม่ได้สร้างคำขอซ้ำ`);

    // ================= 6) user ที่ไม่มีสิทธิ์อนุมัติเลย (fx_maker2, flags ว่างเปล่า) — ปุ่มต้องไม่แสดง =================
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(600);
    await shot(page, 'voucher-a-no-approve-button');
    const approveBtnCount = await page.locator('[data-act="approve-voucher"]').count();
    assert(approveBtnCount===0, `fx_maker2 (ไม่มี can_approve_petty_cash) ไม่เห็นปุ่มอนุมัติเลย (นับได้ ${approveBtnCount} ปุ่ม)`);

    // ================= 3) approve ด้วย fx_approver_mid (มีสิทธิ์+active rule, ไม่ใช่คนสร้าง) — กดรัว 3 ครั้ง =================
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherAId}"]`);
    await page.waitForTimeout(600);
    const approveBtnVisible = await page.locator('[data-act="approve-voucher"]').count();
    assert(approveBtnVisible===1, `fx_approver_mid เห็นปุ่มอนุมัติ (นับได้ ${approveBtnVisible})`);
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
    assert(journalCheck.rowCount===2, `เกิด journal line พอดี 2 บรรทัด (Dr/Cr) ไม่ใช่ 2 ใบซ้ำจากการกดรัว (ได้ ${journalCheck.rowCount})`);
    const dr = journalCheck.rows.find(r=>Number(r.debit_amount)>0);
    const cr = journalCheck.rows.find(r=>Number(r.credit_amount)>0);
    assert(dr && dr.account_code==='5300' && Number(dr.debit_amount)===3500, `Journal Dr 5300 = 3,500 จริง (ได้ ${dr&&dr.account_code}/${dr&&dr.debit_amount})`);
    assert(cr && cr.account_code==='1110' && Number(cr.credit_amount)===3500, `Journal Cr 1110 (เงินสดย่อย) = 3,500 จริง (ได้ ${cr&&cr.account_code}/${cr&&cr.credit_amount})`);

    const fundAfterA = await pool.query(
      `SELECT (f.fund_limit - COALESCE((SELECT SUM(v.amount) FROM client_payment_vouchers v WHERE v.petty_cash_fund_id=f.id AND v.status='approved'),0)) AS balance
       FROM client_petty_cash_funds f WHERE f.id=$1`, [fundId]
    );
    assert(Number(fundAfterA.rows[0].balance)===16500, `ยอดคงเหลือกองทุนหลังอนุมัติ = 16,500 จริง (20,000-3,500, ไม่ใช่หักซ้ำจากการกดรัว) (ได้ ${fundAfterA.rows[0].balance})`);

    // ตรวจ audit log + journal บนหน้าจอ (ไม่ใช่แค่ DB) — ต้องมีแค่ 1 แถว submit + 1 แถว approve ไม่ใช่ 3+3
    const auditLogDbCheck = await pool.query(`SELECT action FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id=$1 ORDER BY id`, [voucherAId]);
    assert(auditLogDbCheck.rows.filter(r=>r.action==='submit').length===1, `audit log มี action=submit แค่ 1 แถว ไม่ใช่ซ้ำจากการกดรัว (ได้ ${auditLogDbCheck.rows.filter(r=>r.action==='submit').length})`);
    assert(auditLogDbCheck.rows.filter(r=>r.action==='approve').length===1, `audit log มี action=approve แค่ 1 แถว ไม่ใช่ซ้ำจากการกดรัว (ได้ ${auditLogDbCheck.rows.filter(r=>r.action==='approve').length})`);
    const journalTextVisible = await page.locator('text=5300').count();
    assert(journalTextVisible>0, 'หน้า detail แสดงเลขบัญชี 5300 ในตาราง journal จริงบนหน้าจอ');

    // ================= 7) เบิกเกินยอดกองทุน (เหลือ 16,500 แต่ขอ 18,000) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vFund', String(fundId));
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '18000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบเบิกเกินกองทุน B');
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    const voucherBRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE petty_cash_fund_id=$1 AND purpose LIKE 'E2E ทดสอบเบิกเกินกองทุน B%' ORDER BY id DESC LIMIT 1`, [fundId]);
    const voucherBId = voucherBRow.rows[0].id;
    createdVoucherIds.push(voucherBId);
    await page.click(`tr[data-id="${voucherBId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(600);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherBId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="approve-voucher"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-b-over-fund-error');
    const toastText = await page.locator('.toast, [class*="toast"]').last().textContent().catch(()=>null);
    assert(toastText && /ไม่เพียงพอ|เกิน/.test(toastText), `ขึ้นข้อความไทยที่อ่านรู้เรื่องตอนเบิกเกินกองทุน (ได้ "${toastText}")`);
    assert(toastText && !/undefined|\[object|SyntaxError|Unexpected token/.test(toastText), `ข้อความไม่ใช่ raw error/JSON dump (ได้ "${toastText}")`);
    const voucherBStillSubmitted = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucherBId]);
    assert(voucherBStillSubmitted.rows[0].status==='submitted', 'ใบ B ยังเป็น submitted อยู่ (ไม่ได้ผ่านการอนุมัติที่ไม่ควรผ่าน)');

    // ================= 4) reject พร้อมเหตุผล =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vFund', String(fundId));
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '1000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบปฏิเสธ C');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(600);
    const voucherCRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE petty_cash_fund_id=$1 AND purpose LIKE 'E2E ทดสอบปฏิเสธ C%' ORDER BY id DESC LIMIT 1`, [fundId]);
    const voucherCId = voucherCRow.rows[0].id;
    createdVoucherIds.push(voucherCId);
    await page.click(`tr[data-id="${voucherCId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(600);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherCId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-reject-voucher"]');
    await page.waitForTimeout(200);
    await page.fill('#f-vRejectReason', 'E2E เหตุผลทดสอบการปฏิเสธ');
    await page.click('[data-act="submit-reject-voucher"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-c-rejected');
    const rejectedReasonVisible = await page.locator('text=E2E เหตุผลทดสอบการปฏิเสธ').count();
    assert(rejectedReasonVisible>0, 'เหตุผลที่ปฏิเสธแสดงบนหน้า detail จริง');
    const voucherCCheck = await pool.query('SELECT status, rejected_reason FROM client_payment_vouchers WHERE id=$1', [voucherCId]);
    assert(voucherCCheck.rows[0].status==='rejected', 'สถานะเป็น rejected จริงใน DB');
    assert(voucherCCheck.rows[0].rejected_reason==='E2E เหตุผลทดสอบการปฏิเสธ', 'บันทึกเหตุผลลง DB ตรงกับที่กรอกจริง');

    // ================= 5) cancel ใบ draft =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_petty_cash"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vFund', String(fundId));
    await page.selectOption('#f-vEmployee', { index: 1 });
    await page.fill('#f-vAmount', '500');
    await page.fill('#f-vPurpose', 'E2E ทดสอบยกเลิก D');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(600);
    const voucherDRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE petty_cash_fund_id=$1 AND purpose LIKE 'E2E ทดสอบยกเลิก D%' ORDER BY id DESC LIMIT 1`, [fundId]);
    const voucherDId = voucherDRow.rows[0].id;
    createdVoucherIds.push(voucherDId);
    await page.click(`tr[data-id="${voucherDId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="cancel-voucher"]');
    await page.waitForTimeout(700);
    await shot(page, 'voucher-d-cancelled');
    const voucherDCheck = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucherDId]);
    assert(voucherDCheck.rows[0].status==='cancelled', `ยกเลิกใบ draft สำเร็จ status=cancelled (ได้ ${voucherDCheck.rows[0].status})`);

    console.log('\nconsole errors during whole run:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)');
    // 400/409 "Failed to load resource" lines are the browser's own network log for the deliberate
    // over-fund-balance rejection (scenario 7) and the intentionally-raced duplicate submit/approve
    // clicks (409 duplicate-idempotency-key attempts that lose the race) — already asserted above.
    const unexpectedErrors = consoleErrors.filter(e => !/404|400 \(Bad Request\)|409 \(Conflict\)/.test(e));
    assert(unexpectedErrors.length===0, `ไม่มี JS error ที่ไม่คาดคิดนอกเหนือจากการทดสอบ error ตั้งใจ (ได้ ${JSON.stringify(unexpectedErrors)})`);

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
      if (createdFundIds.length) {
        await pool.query('DELETE FROM client_petty_cash_funds WHERE id = ANY($1)', [createdFundIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'pcv-%'`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
