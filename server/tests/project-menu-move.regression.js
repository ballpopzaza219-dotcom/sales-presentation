// Regression test for moving "โครงการ" (Project List + Detail) out of the Finance sidebar and into
// the Bidding (ประมูลงาน/Tender) sidebar, 2026-07-25.
//
// The move itself is a one-line change (relocate the {key:'fin_projects',...} entry from
// financeNavFor() to biddingNavFor()) — the real risk is everywhere S.page gets set to
// fin_projects/fin_project_add/fin_project_detail WITHOUT also updating S.module: renderDashboard()
// picks which nav array to validate S.page against based on S.module, so a stale S.module='finance'
// would make it think fin_projects no longer belongs anywhere and silently bounce the user back to
// fin_overview instead of showing the page they just navigated to. The fix threads a new optional
// data-module attribute through every nav link that targets these 3 pages (see the 'nav' act handler
// and biddingNavFor()'s comment in pr-system.html) — this test exercises every one of those call
// sites, plus the 2 cross-module cross-references found during the move: the "เพิ่มโครงการใหม่"
// shortcut from the PR creation form's project-autocomplete, and the "view source tender" link on a
// project's budget summary (shown when that project's budget was copied from a won tender).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-menu-move.regression.js

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
  let testCustomerId = null, projectId = null, tenderId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Project Menu Move Test','project-menu-move-test@example.com','_project_menu_move_test_', $2, 'active') RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', company.code);
    await page.fill('#f-loginUser', '_project_menu_move_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    // ---- 1. Finance sidebar no longer lists Projects.
    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(150);
    const financeHasProjects = await page.locator('.nav-item[data-page="fin_projects"]').count();
    assert(financeHasProjects === 0, 'Finance sidebar no longer has a "fin_projects" nav item');
    const financeItemCount = await page.locator('.nav .nav-item').count();
    assert(financeItemCount >= 15, `Finance sidebar still has substantial content left (${financeItemCount} items, not emptied out)`);

    // ---- 2. Bidding sidebar now lists Projects, ABOVE Tender List (2026-07-25 reorder), with the new
    // "ภาพรวมประมูลงาน" (Tender Overview) dashboard added above BOTH of them (2026-07-25, second
    // change) — and switching into the module now lands on THAT dashboard by default (changed from
    // 'fin_projects', which itself had only just replaced 'fin_tenders' minutes earlier). That default
    // is hardcoded independently of biddingNavFor()'s array order, in BOTH renderDashboard's
    // fallback-redirect check and the switch-module handler, so this also guards against either one
    // drifting out of sync with the other.
    await page.click('[data-act="switch-module"][data-module="bidding"]');
    await page.waitForTimeout(150);
    const biddingHasOverview = await page.locator('.nav-item[data-page="fin_tender_overview"]').count();
    assert(biddingHasOverview === 1, 'Bidding sidebar now has exactly 1 "fin_tender_overview" nav item');
    const biddingHasProjects = await page.locator('.nav-item[data-page="fin_projects"]').count();
    assert(biddingHasProjects === 1, 'Bidding sidebar now has exactly 1 "fin_projects" nav item');
    const biddingNavOrder = await page.locator('.nav .nav-item').evaluateAll(els => els.map(el => el.dataset.page));
    assert(
      biddingNavOrder[0] === 'fin_tender_overview' && biddingNavOrder[1] === 'fin_projects' && biddingNavOrder[2] === 'fin_tenders',
      `Bidding sidebar order is [ภาพรวมประมูลงาน, โครงการ, ประมูลงาน (Tender)] (got ${JSON.stringify(biddingNavOrder)})`
    );
    let s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_tender_overview' && s.module === 'bidding', `switching into the Bidding module now defaults to fin_tender_overview (got ${JSON.stringify(s)})`);
    const addProjectBtnCount = await page.locator('[data-act="nav"][data-page="fin_project_add"]').count();
    assert(addProjectBtnCount === 1, '"เพิ่มโครงการ" quick-action button is present on the (correctly rendered) Tender Overview page');

    // ---- 3. Clicking "โครงการ" and "ประมูลงาน (Tender)" in the sidebar still navigate normally —
    // the dashboard default only applies at module-entry (switch-module / fallback-redirect), not to
    // plain in-module nav clicks.
    await page.click('.nav-item[data-page="fin_projects"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_projects' && s.module === 'bidding', `clicking "โครงการ" navigates to fin_projects normally (got ${JSON.stringify(s)})`);
    await page.click('.nav-item[data-page="fin_tenders"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_tenders' && s.module === 'bidding', `clicking "ประมูลงาน (Tender)" still navigates to fin_tenders normally, not auto-redirected to the dashboard (got ${JSON.stringify(s)})`);
    await page.click('.nav-item[data-page="fin_projects"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_projects' && s.module === 'bidding', `landed on fin_projects with S.module='bidding' (got ${JSON.stringify(s)})`);

    // ---- 4. "เพิ่มโครงการ" -> fin_project_add, module still 'bidding'.
    await page.click('[data-act="nav"][data-page="fin_project_add"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_project_add' && s.module === 'bidding', `landed on fin_project_add with S.module='bidding' (got ${JSON.stringify(s)})`);

    // ---- 5. Save a real project via the actual form + save-project-full handler. sectorType is now
    // required (2026-07-25 Project-form expansion — see project-detail-fields.regression.js for full
    // coverage of that feature); this test only needs to pick one so the save succeeds.
    await page.fill('#pa-name', 'ทดสอบย้ายเมนูโครงการ');
    await page.check('input[name="pa-sectorType"][value="private"]');
    await page.waitForSelector('#pa-budget');
    await page.fill('#pa-budget', '1000000');
    await page.click('[data-act="save-project-full"]');
    await page.waitForTimeout(600);
    s = await page.evaluate(() => ({ page: S.page, module: S.module, id: S.selectedProjectId }));
    assert(s.page === 'fin_project_detail' && s.module === 'bidding', `save navigates to fin_project_detail with S.module='bidding' (got ${JSON.stringify(s)})`);
    assert(!!s.id, 'a real project id was assigned');
    projectId = s.id;
    const detailText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(detailText.includes('ทดสอบย้ายเมนูโครงการ'), 'Project Detail page actually renders the new project (not a blank/wrong page)');

    // ---- 6. THE critical regression: "back" from Project Detail must return to the list, not get
    // silently bounced to fin_overview by renderDashboard's stale-S.module fallback check.
    await page.click('[data-act="nav"][data-page="fin_projects"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_projects' && s.module === 'bidding', `"back" from Project Detail returns to fin_projects, NOT bounced to fin_overview (got ${JSON.stringify(s)})`);
    const listText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(listText.includes('ทดสอบย้ายเมนูโครงการ'), 'the just-created project is visible back on the list page');

    // ---- 7. Cross-reference #1: "เพิ่มโครงการใหม่" shortcut from the PR creation form's project
    // autocomplete (act='goto-add-project-from-pr') must also land in the Bidding module now.
    await page.evaluate(() => { S.module = 'pr'; S.page = 'create_pr'; S.prForm = S.prForm || { projectId: null, projectSearchText: '', projectResultsOpen: false, items: [] }; render(); });
    await page.waitForTimeout(150);
    await page.click('#pr-project-search');
    await page.waitForTimeout(150);
    await page.click('[data-act="goto-add-project-from-pr"]');
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_project_add' && s.module === 'bidding', `"เพิ่มโครงการใหม่" shortcut from PR form lands with S.module='bidding' (got ${JSON.stringify(s)})`);

    // ---- 8. Cross-reference #2: "view source tender" link on a project's budget summary. Create a
    // real tender via the API, then simulate (client-side only) the budget-summary state a won-tender
    // budget-copy would have produced — this tests the FRONTEND link/module fix made during the menu
    // move, not the (already-covered-elsewhere) won-tender budget-copy business logic itself.
    tenderId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/tenders', {
        tenderNo: '', name: 'ทดสอบ source tender link', projectOwner: '', submissionDeadline: null,
        estimatedValue: 1000000, note: '', projectNo: '', biddingMethod: '', sectorType: 'private',
        budgetAmount: 0, referencePrice: 0, location: '', phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.tenders.push(mapRealTender(data.tender));
      return data.tender.id;
    });
    await page.evaluate((args) => {
      S.module = 'finance'; // deliberately wrong/stale, to prove the link's own data-module fixes it
      S.page = 'fin_project_detail'; S.selectedProjectId = args.pid;
      S.selectedProjectBudget = { id: 9999999, sourceBudgetId: 8888888, sourceTenderId: args.tid, currentRevision: null, latestRevision: null };
      render();
    }, { pid: projectId, tid: tenderId });
    await page.waitForTimeout(150);
    const sourceLinkCount = await page.locator('[data-act="nav"][data-page="fin_tender_detail"][data-module="bidding"]').count();
    assert(sourceLinkCount >= 1, '"view source tender" link is rendered with data-module="bidding"');
    await page.click('[data-act="nav"][data-page="fin_tender_detail"][data-module="bidding"]');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ page: S.page, module: S.module, tenderId: S.selectedTenderId }));
    assert(s.page === 'fin_tender_detail' && s.module === 'bidding' && s.tenderId === tenderId, `"view source tender" navigates correctly despite starting from a stale S.module (got ${JSON.stringify(s)})`);

    assert(!consoleErrors.length, `no console/page errors during the whole flow (got: ${consoleErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (projectId) await pool.query('DELETE FROM client_projects WHERE id=$1', [projectId]);
      if (tenderId) await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
