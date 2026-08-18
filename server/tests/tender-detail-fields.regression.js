// Regression test for the "เปิด Tender ใหม่" form expansion (2026-07-24): new client_tenders columns
// (project_no, bidding_method, sector_type, budget_amount, reference_price, location, phone_number,
// site_coordinates, submission_open_date, submission_conditions, installment_count) plus the new
// client_tender_installments child table, and the form's conditional/dynamic UI behavior:
//   - sector_type radio (ภาครัฐ/เอกชน) toggles which of budget_amount+reference_price vs
//     estimated_value is shown, WITHOUT clearing the hidden side's value if toggled back.
//   - the "จำนวนงวดงาน" number input auto-generates that many installment rows immediately, and
//     resizing it later (5→3) keeps the surviving rows' data instead of wiping the whole table.
//   - saving and reloading the Tender Detail page shows every field, including the installment table.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/tender-detail-fields.regression.js

const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_COMPANY_ID = 13;

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

(async () => {
  let testCustomerId = null, tenderId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Tender Fields Test','tender-fields-test@example.com','_tender_fields_test_', $2, 'active', true) RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', company.code);
    await page.fill('#f-loginUser', '_tender_fields_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    await page.evaluate(() => { S.module = 'bidding'; S.page = 'fin_tender_add'; S.tenderAddForm = null; render(); });
    await page.waitForTimeout(200);

    await page.fill('#ta-name', 'ทดสอบฟอร์ม Tender ขยาย');
    await page.fill('#ta-projectNo', 'PRJ-2026-999');
    await page.fill('#ta-biddingMethod', 'e-bidding');
    await page.fill('#ta-location', '123 ถ.ทดสอบ กรุงเทพฯ');
    await page.fill('#ta-phoneNumber', '02-123-4567');
    await page.fill('#ta-siteCoordinates', '13.7563,100.5018');

    // ---- Sector toggle: fill government fields, switch to private, back to government — values
    // must survive the round trip (per spec: "ไม่ล้างค่าที่กรอกไปแล้วของอีกฝั่ง").
    await page.check('input[name="ta-sectorType"][value="government"]');
    await page.waitForSelector('#ta-budgetAmount');
    await page.fill('#ta-budgetAmount', '5000000');
    await page.fill('#ta-referencePrice', '4800000');
    await page.check('input[name="ta-sectorType"][value="private"]');
    await page.waitForSelector('#ta-estimatedValue');
    const govFieldsHiddenWhilePrivate = await page.evaluate(() => !document.getElementById('ta-budgetAmount'));
    assert(govFieldsHiddenWhilePrivate, 'switching to เอกชน hides the ภาครัฐ-only fields (budgetAmount/referencePrice)');
    await page.check('input[name="ta-sectorType"][value="government"]');
    await page.waitForSelector('#ta-budgetAmount');
    const preservedBudgetAmount = await page.inputValue('#ta-budgetAmount');
    const preservedReferencePrice = await page.inputValue('#ta-referencePrice');
    assert(preservedBudgetAmount === '5000000' && preservedReferencePrice === '4800000', `toggling back to ภาครัฐ preserves the previously-typed values (got budgetAmount=${preservedBudgetAmount}, referencePrice=${preservedReferencePrice})`);

    // ---- Installments: type 5 → 5 rows appear immediately (no extra button click).
    await page.fill('#ta-installmentCount', '5');
    await page.waitForTimeout(150);
    let rowCount = await page.evaluate(() => (S.tenderAddForm.installments || []).length);
    assert(rowCount === 5, `typing 5 into installment count generates 5 rows immediately (got ${rowCount})`);

    // Fill all 5 rows via direct state access (equivalent to typing into each generated input, and
    // avoids 15 separate fragile selector lookups for dynamically-numbered rows).
    await page.evaluate(() => {
      const insts = [
        { description: 'งวดที่ 1 - วางฐานราก', amount: 1000000, daysToComplete: 30 },
        { description: 'งวดที่ 2 - งานโครงสร้าง', amount: 1500000, daysToComplete: 45 },
        { description: 'งวดที่ 3 - งานสถาปัตย์', amount: 1200000, daysToComplete: 40 },
        { description: 'งวดที่ 4 - งานระบบ', amount: 800000, daysToComplete: 30 },
        { description: 'งวดที่ 5 - ส่งมอบงาน', amount: 500000, daysToComplete: 15 },
      ];
      S.tenderAddForm.installments = insts;
      render();
    });
    await page.waitForTimeout(150);

    // Resize 5 -> 3: the first 3 rows' data must survive untouched.
    await page.fill('#ta-installmentCount', '3');
    await page.waitForTimeout(150);
    const afterResize = await page.evaluate(() => S.tenderAddForm.installments);
    assert(afterResize.length === 3, `resizing installment count from 5 to 3 leaves exactly 3 rows (got ${afterResize.length})`);
    assert(
      afterResize[0].description === 'งวดที่ 1 - วางฐานราก' && Number(afterResize[0].amount) === 1000000 &&
      afterResize[1].description === 'งวดที่ 2 - งานโครงสร้าง' &&
      afterResize[2].description === 'งวดที่ 3 - งานสถาปัตย์',
      'the first 3 rows kept their originally-typed data after the 5→3 resize, not cleared'
    );

    await page.fill('#ta-submissionConditions', 'ต้องยื่นซองภายในเวลาที่กำหนด ห้ามแก้ไขเอกสารหลังยื่น');

    // ---- Save (no manual role/session workaround needed — this is a plain create action).
    await page.click('[data-act="save-tender-full"]');
    await page.waitForTimeout(1200);
    assert(!consoleErrors.length, `no console/page errors during fill+save (got: ${consoleErrors.join(' | ')})`);

    const savedTenderId = await page.evaluate(() => S.selectedTenderId);
    tenderId = savedTenderId;
    assert(!!savedTenderId, 'save succeeded and navigated to the new tender\'s detail page');

    // ---- Direct DB verification: every new column persisted correctly.
    const dbRow = await pool.query('SELECT * FROM client_tenders WHERE id=$1', [savedTenderId]);
    const t = dbRow.rows[0];
    assert(t.project_no === 'PRJ-2026-999', `project_no persisted (got "${t.project_no}")`);
    assert(t.bidding_method === 'e-bidding', `bidding_method persisted (got "${t.bidding_method}")`);
    assert(t.location === '123 ถ.ทดสอบ กรุงเทพฯ', 'location persisted');
    assert(t.phone_number === '02-123-4567', 'phone_number persisted');
    assert(t.site_coordinates === '13.7563,100.5018', 'site_coordinates persisted');
    assert(t.sector_type === 'government', `sector_type persisted as "government" (got "${t.sector_type}")`);
    assert(Number(t.budget_amount) === 5000000, `budget_amount persisted (got ${t.budget_amount})`);
    assert(Number(t.reference_price) === 4800000, `reference_price persisted (got ${t.reference_price})`);
    // No separate contract_value column — estimated_value must be DERIVED from budget_amount for a
    // government tender (see the schema.sql/server.js comments on why there's only one column).
    assert(Number(t.estimated_value) === 5000000, `estimated_value auto-set to budget_amount for a government tender (got ${t.estimated_value})`);
    assert(t.submission_conditions.includes('ห้ามแก้ไขเอกสารหลังยื่น'), 'submission_conditions persisted');
    assert(t.installment_count === 3, `installment_count derived from the actual submitted array length, not the (already-resized) input field (got ${t.installment_count})`);

    const instRows = await pool.query('SELECT * FROM client_tender_installments WHERE tender_id=$1 ORDER BY installment_no', [savedTenderId]);
    assert(instRows.rowCount === 3, `exactly 3 installment rows saved (got ${instRows.rowCount})`);
    assert(instRows.rows[0].description === 'งวดที่ 1 - วางฐานราก' && Number(instRows.rows[0].amount) === 1000000 && instRows.rows[0].days_to_complete === 30, 'installment row 1 data correct');
    assert(instRows.rows[2].description === 'งวดที่ 3 - งานสถาปัตย์' && Number(instRows.rows[2].amount) === 1200000, 'installment row 3 data correct');

    // ---- Reload the detail page fresh (simulates navigating away and back) and confirm the UI shows
    // everything, including the installments table fetched via GET /api/customer/tenders/:id.
    await page.evaluate(async (tid) => {
      S.tendersLoaded = false; DB.tenders = []; S.selectedTenderInstallments = undefined; S.selectedTenderBudget = undefined;
      S.page = 'fin_tender_detail'; S.selectedTenderId = tid;
      await loadRealTenders();
      await loadTenderInstallments(tid);
      render();
    }, savedTenderId);
    await page.waitForTimeout(300);

    const pageText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(pageText.includes('PRJ-2026-999'), 'reloaded detail page shows project_no');
    assert(pageText.includes('e-bidding'), 'reloaded detail page shows bidding_method');
    assert(pageText.includes('งวดที่ 2 - งานโครงสร้าง'), 'reloaded detail page shows an installment row');
    const rowsInDom = await page.locator('.card table tbody tr').count();
    assert(rowsInDom >= 3, `reloaded detail page renders at least the 3 installment rows in a table (found ${rowsInDom} total table rows across the page)`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (tenderId) {
        await pool.query('DELETE FROM client_tender_installments WHERE tender_id=$1', [tenderId]);
        await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderId]);
      }
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
