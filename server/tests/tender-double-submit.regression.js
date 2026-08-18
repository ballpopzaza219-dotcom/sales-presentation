// Regression test for the "clicking 'เปิด Tender ใหม่' once creates several duplicate tenders" bug
// fixed 2026-07-24. Root cause: save-tender-full's click handler had no submit guard at all — nothing
// stopped a second (or third, or tenth) invocation of the handler from firing its own independent
// POST /api/customer/tenders while an earlier one was still in flight, and each call succeeds
// independently since generateTenderNo() (server.js) mints a fresh sequential tender_no every time,
// so nothing there collides either. Fix, two layers:
//   1. Frontend (pr-system.html, save-tender-full): S.tenderSaving is set true + render() called
//      BEFORE the await, both disabling the real button (so a genuine repeat mouse click can't even
//      fire a new click event) and short-circuiting any handler re-invocation that manages to fire
//      anyway (`if(S.tenderSaving) return;`) — this test dispatches many native .click() calls in a
//      tight synchronous loop specifically to exercise that second guard, not just button-disabled.
//   2. Backend (server.js, POST /api/customer/tenders): an idempotency backstop — if this same
//      customer already created a tender with the exact same fields in the last 10 seconds, the
//      existing one is returned instead of inserting a duplicate.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/tender-double-submit.regression.js

const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_COMPANY_ID = 13;
const TENDER_NAME = 'ทดสอบกันสร้างซ้ำ (double-submit regression)';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

(async () => {
  let testCustomerId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Tender Double-Submit Test','tender-double-submit@example.com','_tender_dblsubmit_', $2, 'active', true) RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', company.code);
    await page.fill('#f-loginUser', '_tender_dblsubmit_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    await page.evaluate(() => { S.page = 'fin_tender_add'; S.tenderAddForm = null; S.tenderSaving = false; render(); });
    await page.waitForTimeout(200);
    await page.fill('#ta-name', TENDER_NAME);
    // sectorType is required as of the 2026-07-24 "เปิด Tender ใหม่" form expansion — unrelated to
    // what this test is actually checking (double-submit guarding), just a mandatory field now.
    await page.check('input[name="ta-sectorType"][value="private"]');

    // Fire many native clicks on the save button in a tight synchronous loop — the adversarial case:
    // all of them dispatch before the first click's own render() has a chance to actually disable the
    // button in a way a REAL subsequent mouse click would respect, so this specifically exercises the
    // `if(S.tenderSaving) return;` guard inside the handler itself, not just the disabled attribute.
    const rapidClickCount = 10;
    await page.evaluate((n) => {
      const btn = document.querySelector('[data-act="save-tender-full"]');
      for (let i = 0; i < n; i++) btn.click();
    }, rapidClickCount);

    // Let all in-flight requests (the one real POST, plus however many got short-circuited) settle.
    await page.waitForTimeout(1500);

    const dbRows = await pool.query(
      `SELECT id, tender_no, created_at FROM client_tenders WHERE company_id=$1 AND created_by=$2 AND name=$3 ORDER BY id`,
      [company.id, testCustomerId, TENDER_NAME]
    );
    assert(dbRows.rowCount === 1, `exactly 1 tender created in the database despite ${rapidClickCount} rapid clicks (got ${dbRows.rowCount}: ${JSON.stringify(dbRows.rows)})`);

    const finalSavingFlag = await page.evaluate(() => S.tenderSaving);
    assert(finalSavingFlag === false, 'S.tenderSaving is reset back to false once the (single) real request settles, so a later legitimate save is never left permanently disabled');

    if (consoleErrors.length) throw new Error('Console errors during the interaction: ' + consoleErrors.join(' | '));
    assert(true, 'no console errors during the rapid-click sequence');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      await pool.query('DELETE FROM client_tenders WHERE created_by=$1', [testCustomerId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
