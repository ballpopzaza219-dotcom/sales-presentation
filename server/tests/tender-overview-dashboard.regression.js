// Regression test for the "ภาพรวมประมูลงาน" (Tender Overview) dashboard added 2026-07-25 as the new
// default landing page of the Bidding module (see pageFinTenderOverview() in pr-system.html and
// GET /api/customer/tender-overview in server.js).
//
// Uses a BRAND NEW company/customer fixture (not the usual FIXTURE_COMPANY_ID=13, which by now has
// a lot of tenders/budgets left over from other regression runs) so the empty-state assertions below
// are testing a genuinely empty company, not "empty because we filtered it down."
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/tender-overview-dashboard.regression.js

const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

(async () => {
  let companyId = null, browser;
  try {
    const code = 'TOVD' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Tender Overview Dashboard Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Tender Overview Test','tender-overview-test@example.com','_tender_overview_test_', $2, 'active')`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_tender_overview_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    // ---- 1. Entering the Bidding module for the first time lands directly on the dashboard.
    await page.click('[data-act="switch-module"][data-module="bidding"]');
    await page.waitForTimeout(300);
    let s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_tender_overview' && s.module === 'bidding', `entering Bidding module lands on fin_tender_overview (got ${JSON.stringify(s)})`);

    // ---- 2. Empty-state: brand new company, zero tenders/budgets/projects — every section should
    // degrade gracefully, nothing should error.
    let bodyText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(bodyText.includes('0.00'), 'active tender value shows 0.00, not an error, for an empty company');
    const statCardCount = await page.locator('.stat-card').count();
    assert(statCardCount === 8, `8 summary stat cards render (5 status + value + won-projects + pending-budgets) (got ${statCardCount})`);
    assert(bodyText.includes('ไม่มี Tender ที่ใกล้ปิดยื่นซอง'), 'empty upcoming-deadlines message shown');
    assert(bodyText.includes('ไม่มี Budget ที่รออนุมัติ'), 'empty pending-budgets message shown');
    assert(bodyText.includes('ยังไม่มีกิจกรรม'), 'empty recent-activity state shown');
    const statusBarCount = await page.locator('#tov-status-breakdown').count();
    assert(statusBarCount === 0, 'status-breakdown card is omitted entirely when there are zero tenders (not shown empty)');
    assert(!consoleErrors.length, `no console/page errors on the empty-state dashboard (got: ${consoleErrors.join(' | ')})`);

    // ---- 3. Quick actions navigate correctly and back.
    await page.click('[data-act="nav"][data-page="fin_tender_add"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_tender_add' && s.module === 'bidding', `"เปิด Tender ใหม่" quick action navigates correctly (got ${JSON.stringify(s)})`);
    await page.click('[data-act="nav"][data-page="fin_tenders"]');
    await page.click('.nav-item[data-page="fin_tender_overview"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="nav"][data-page="fin_project_add"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_project_add' && s.module === 'bidding', `"เพิ่มโครงการ" quick action navigates correctly (got ${JSON.stringify(s)})`);

    // ---- 4. Create real data via the actual API (not raw SQL) — 2 tenders (one closing in 3 days,
    // one in 10 — outside the 7-day window), then a budget on the near-deadline tender, submitted for
    // approval.
    const tenderNear = await page.evaluate(async (deadline) => {
      const data = await apiCall('POST', '/api/customer/tenders', {
        tenderNo: '', name: 'ทดสอบ dashboard ใกล้ปิดซอง', projectOwner: '', submissionDeadline: deadline,
        estimatedValue: 1000000, note: '', projectNo: '', biddingMethod: '', sectorType: 'private',
        budgetAmount: 0, referencePrice: 0, location: '', phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      return data.tender;
    }, daysFromNow(3));
    const tenderFar = await page.evaluate(async (deadline) => {
      const data = await apiCall('POST', '/api/customer/tenders', {
        tenderNo: '', name: 'ทดสอบ dashboard ไกลเกิน 7 วัน', projectOwner: '', submissionDeadline: deadline,
        estimatedValue: 500000, note: '', projectNo: '', biddingMethod: '', sectorType: 'private',
        budgetAmount: 0, referencePrice: 0, location: '', phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      return data.tender;
    }, daysFromNow(10));
    const budgetId = await page.evaluate(async (tenderId) => {
      const created = await apiCall('POST', '/api/customer/budgets', { tenderId });
      await apiCall('PUT', `/api/customer/budgets/${created.budget.id}/items`, {
        items: [{ workCode: '', description: 'งานทดสอบ dashboard', unit: 'ชิ้น', qty: 1, materialUnitPrice: 100, laborUnitPrice: 0, strictControl: false, isGroup: false, note: '' }],
      });
      await apiCall('POST', `/api/customer/budgets/${created.budget.id}/submit`);
      return created.budget.id;
    }, tenderNear.id);

    // ---- 5. Reload the dashboard fresh (S.tenderOverviewLoaded is still true client-side from step
    // 2's empty load, so force a refetch the same way the retry button does) and verify every number
    // and list reflects the data just created.
    await page.evaluate(() => { S.tenderOverviewLoaded = false; });
    await page.click('.nav-item[data-page="fin_tender_overview"]');
    await page.waitForTimeout(400);
    bodyText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(bodyText.includes('1,500,000.00'), 'active tender value total reflects both new tenders (1,000,000 + 500,000)');

    const deadlineRows = await page.locator('#tov-deadlines [data-act="nav"]').all();
    assert(deadlineRows.length === 1, `exactly 1 tender shown in the upcoming-deadlines list — only the 3-day one, not the 10-day one (got ${deadlineRows.length})`);
    const deadlinesText = await page.locator('#tov-deadlines').innerText();
    assert(deadlinesText.includes('ทดสอบ dashboard ใกล้ปิดซอง'), 'the near-deadline tender name is shown in upcoming deadlines');
    assert(!deadlinesText.includes('ทดสอบ dashboard ไกลเกิน 7 วัน'), 'the far-deadline tender is correctly excluded from the upcoming-deadlines list (it may still legitimately appear elsewhere, e.g. recent activity)');

    assert(bodyText.includes('ทดสอบ dashboard ใกล้ปิดซอง (TDR'), 'pending-budget row shows the linked tender name+number');
    const statusBarNowCount = await page.locator('#tov-status-breakdown').count();
    assert(statusBarNowCount === 1, 'status-breakdown card now renders once there is at least 1 tender');
    assert(bodyText.includes('เตรียมยื่นซอง (2)'), 'status breakdown legend shows 2 tenders in เตรียมยื่นซอง');

    // ---- 6. Navigation: click the upcoming-deadline row -> correct tender detail page.
    await page.click(`#tov-deadlines [data-act="nav"][data-id="${tenderNear.id}"]`);
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module, id: S.selectedTenderId }));
    assert(s.page === 'fin_tender_detail' && s.module === 'bidding' && s.id === tenderNear.id, `clicking the upcoming-deadline row navigates to the correct tender (got ${JSON.stringify(s)})`);

    // ---- 7. Navigation: pending-budget row -> same tender detail page (scope='bidding').
    await page.evaluate(() => { S.tenderOverviewLoaded = false; });
    await page.click('.nav-item[data-page="fin_tender_overview"]');
    await page.waitForTimeout(400);
    await page.click(`#tov-pending-budgets [data-act="nav"][data-id="${tenderNear.id}"]`);
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module, id: S.selectedTenderId }));
    assert(s.page === 'fin_tender_detail' && s.id === tenderNear.id, `clicking the pending-budget row navigates to the linked tender (got ${JSON.stringify(s)})`);

    // ---- 8. Navigation: a recent-activity row (the tender we just created) -> correct detail page.
    await page.evaluate(() => { S.tenderOverviewLoaded = false; });
    await page.click('.nav-item[data-page="fin_tender_overview"]');
    await page.waitForTimeout(400);
    const activityRefIds = await page.locator('#tov-recent-activity [data-act="nav"]').evaluateAll(els => els.map(el => el.dataset.id));
    assert(activityRefIds.includes(String(tenderNear.id)), 'recent activity includes a row for the newly created near-deadline tender');
    await page.click(`#tov-recent-activity [data-act="nav"][data-id="${tenderNear.id}"] >> nth=0`);
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_tender_detail' && s.module === 'bidding', `clicking a recent-activity row navigates to a detail page (got ${JSON.stringify(s)})`);

    assert(!consoleErrors.length, `no console/page errors across the entire test (got: ${consoleErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      // customer_companies cascades (ON DELETE CASCADE) to customers/client_tenders/client_budgets/
      // client_budget_revisions/client_budget_items for this company — one delete cleans everything.
      if (companyId) await pool.query('DELETE FROM customer_companies WHERE id=$1', [companyId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
