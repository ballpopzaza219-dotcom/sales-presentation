// Regression test for "จำนวนเงินประกันผลงานเริ่มต้น (บาท)" on the Tender module (2026-07-28, revised
// same day after a spec correction on the calc source). Formula:
//   จำนวนเงินประกันผลงานเริ่มต้น = (linked project's APPROVED PM budget revision's total_amount) ×
//                                    initial_retention_percent / 100
// Deliberately NOT based on the tender's own estimated_value/reference_price (pre-bid estimates, a
// different meaning entirely from an approved execution budget) — this test specifically proves the
// calc ignores estimated_value even when a linked-but-unapproved/no-project state exists.
//
// Covers:
//   - "เปิด Tender ใหม่" form: percent is a normal editable 0-100 input; the (บาท) field is read-only
//     and always shows the "no data yet" placeholder (a new tender can't have an approved project
//     budget before it's even saved).
//   - No linked project at all -> GET .../tenders/:id returns approvedProjectBudgetTotal: null.
//   - Linked project, but its PM budget has no approved revision (draft/pending_approval) -> still null.
//   - Linked project with an approved revision -> correct total, and the Tender Detail page renders
//     the derived amount (not a stale/cached one).
//   - Re-revising and re-approving the PM budget -> the Tender Detail page reflects the NEW total on
//     next load (recomputed fresh every time, never cached/persisted).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/tender-initial-retention.regression.js

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
  let testCustomerId = null, tenderId = null, projectId = null, budgetId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Tender Retention Test','tender-retention-test@example.com','_tender_retention_test_', $2, 'active', true) RETURNING id`,
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
    await page.fill('#f-loginUser', '_tender_retention_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    // ---- Add form: percent is editable, (บาท) is always a static readonly placeholder (a new tender
    // can't possibly have an approved project budget yet — no fallback to estimated_value).
    await page.evaluate(() => { S.module = 'bidding'; S.page = 'fin_tender_add'; S.tenderAddForm = null; render(); });
    await page.waitForTimeout(200);
    await page.fill('#ta-name', 'ทดสอบเงินประกันผลงานเริ่มต้น (v2)');
    await page.check('input[name="ta-sectorType"][value="private"]');
    await page.waitForSelector('#ta-estimatedValue');
    await page.fill('#ta-estimatedValue', '9999999');
    await page.fill('#ta-initialRetentionPercent', '10');
    await page.waitForTimeout(150);
    let amountVal = await page.inputValue('#ta-initialRetentionAmount');
    assert(amountVal === '-', `(บาท) field stays "-" on the add form regardless of estimatedValue/percent typed (got "${amountVal}")`);
    const isReadonly = await page.evaluate(() => document.getElementById('ta-initialRetentionAmount').readOnly);
    assert(isReadonly === true, 'the (บาท) field has the readonly attribute set on the add form');
    await page.evaluate(() => { document.getElementById('ta-initialRetentionAmount').focus(); });
    await page.keyboard.type('999');
    amountVal = await page.inputValue('#ta-initialRetentionAmount');
    assert(amountVal === '-', 'typing directly into the readonly field is rejected by the browser');

    await page.click('[data-act="save-tender-full"]');
    await page.waitForTimeout(1200);
    assert(!consoleErrors.length, `no console/page errors during fill+save (got: ${consoleErrors.join(' | ')})`);
    tenderId = await page.evaluate(() => S.selectedTenderId);
    assert(!!tenderId, 'save succeeded and navigated to the new tender\'s detail page');

    const dbTender = await pool.query('SELECT * FROM client_tenders WHERE id=$1', [tenderId]);
    assert(Number(dbTender.rows[0].initial_retention_percent) === 10, `initial_retention_percent persisted as 10 (got ${dbTender.rows[0].initial_retention_percent})`);

    // ---- Helper: fetch the tender detail JSON straight from the running page's session (shares the
    // login cookie), same-origin so a plain fetch() works without any extra auth plumbing.
    const fetchTenderDetail = (id) => page.evaluate(async (tid) => {
      const res = await fetch(`/api/customer/tenders/${tid}`, { credentials: 'same-origin' });
      return res.json();
    }, id);

    // ---- Scenario A: no linked project at all -> null, not 0, not estimated_value-derived.
    let detail = await fetchTenderDetail(tenderId);
    assert(detail.approvedProjectBudgetTotal === null, `no linked project -> approvedProjectBudgetTotal is null (got ${JSON.stringify(detail.approvedProjectBudgetTotal)})`);

    // ---- Link a project to this tender directly (equivalent to "ผูกเอง" / the won-tender auto-copy).
    const projIns = await pool.query(
      `INSERT INTO client_projects (company_id, code, name, tender_id, created_by)
       VALUES ($1, $2, 'ทดสอบโครงการผูก Tender', $3, $4) RETURNING id`,
      [company.id, 'TEST-RETENTION-' + Date.now(), tenderId, testCustomerId]
    );
    projectId = projIns.rows[0].id;

    const budgetIns = await pool.query(
      `INSERT INTO client_budgets (company_id, budget_scope, project_id, created_by) VALUES ($1,'project',$2,$3) RETURNING id`,
      [company.id, projectId, testCustomerId]
    );
    budgetId = budgetIns.rows[0].id;

    // ---- Scenario B: linked project exists, but its budget revision is only 'pending_approval' —
    // current_revision_id stays NULL until approval (matches the approve-route behavior in server.js),
    // so this must still read as null, not the draft revision's total_amount.
    const rev1 = await pool.query(
      `INSERT INTO client_budget_revisions (company_id, budget_id, revision_no, status, total_amount, submitted_by, submitted_at, created_by)
       VALUES ($1,$2,1,'pending_approval',500000,$3,now(),$3) RETURNING id`,
      [company.id, budgetId, testCustomerId]
    );
    detail = await fetchTenderDetail(tenderId);
    assert(detail.approvedProjectBudgetTotal === null, `linked project with only a pending_approval revision -> still null (got ${JSON.stringify(detail.approvedProjectBudgetTotal)})`);

    // ---- Scenario C: approve it (mirrors POST .../budgets/:id/revisions/:revId/approve: set the
    // revision to 'approved' AND repoint client_budgets.current_revision_id at it).
    await pool.query(`UPDATE client_budget_revisions SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`, [testCustomerId, rev1.rows[0].id]);
    await pool.query(`UPDATE client_budgets SET current_revision_id=$1 WHERE id=$2`, [rev1.rows[0].id, budgetId]);
    detail = await fetchTenderDetail(tenderId);
    assert(Number(detail.approvedProjectBudgetTotal) === 500000, `approved revision -> approvedProjectBudgetTotal = 500,000 (got ${detail.approvedProjectBudgetTotal})`);

    // ---- The Tender Detail page must show the derived amount = 500,000 x 10% = 50,000.00, not
    // anything derived from estimated_value (9,999,999 was typed into that field above).
    await page.evaluate(async (tid) => {
      S.tendersLoaded = false; DB.tenders = []; S.selectedTenderInstallments = undefined; S.selectedTenderBudget = undefined; S.selectedTenderApprovedBudgetTotal = undefined;
      S.page = 'fin_tender_detail'; S.selectedTenderId = tid;
      await loadRealTenders();
      await loadTenderInstallments(tid);
      render();
    }, tenderId);
    await page.waitForTimeout(300);
    let pageText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(pageText.includes('50,000.00'), `Tender Detail shows 50,000.00 (500,000 approved budget x 10%) after an approved revision (page text did not contain it)`);
    assert(!pageText.includes('999,999.90'), 'Tender Detail does NOT show an estimated_value-derived figure (9,999,999 x 10%)');

    // ---- Scenario D: revise the PM budget and approve the new revision -> next load shows the NEW
    // total, proving this is recomputed fresh every time (never cached/persisted).
    const rev2 = await pool.query(
      `INSERT INTO client_budget_revisions (company_id, budget_id, revision_no, status, total_amount, revision_reason, submitted_by, submitted_at, approved_by, approved_at, created_by)
       VALUES ($1,$2,2,'approved',800000,'ปรับปรุงงบตามราคาวัสดุใหม่',$3,now(),$3,now(),$3) RETURNING id`,
      [company.id, budgetId, testCustomerId]
    );
    await pool.query(`UPDATE client_budgets SET current_revision_id=$1 WHERE id=$2`, [rev2.rows[0].id, budgetId]);

    await page.evaluate(async (tid) => {
      S.tendersLoaded = false; DB.tenders = []; S.selectedTenderInstallments = undefined; S.selectedTenderBudget = undefined; S.selectedTenderApprovedBudgetTotal = undefined;
      S.page = 'fin_tender_detail'; S.selectedTenderId = tid;
      await loadRealTenders();
      await loadTenderInstallments(tid);
      render();
    }, tenderId);
    await page.waitForTimeout(300);
    pageText = await page.evaluate(() => document.getElementById('app').innerText);
    assert(pageText.includes('80,000.00'), `after revising the PM budget to 800,000 and approving, Tender Detail shows 80,000.00 (800,000 x 10%) on next load (page text did not contain it)`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (budgetId) {
        // current_revision_id must be cleared first — client_budgets_current_revision_fk otherwise
        // blocks deleting the revision it still points at.
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id=$1', [budgetId]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id=$1', [budgetId]);
        await pool.query('DELETE FROM client_budgets WHERE id=$1', [budgetId]);
      }
      if (projectId) await pool.query('DELETE FROM client_projects WHERE id=$1', [projectId]);
      if (tenderId) {
        await pool.query('DELETE FROM client_tender_installments WHERE tender_id=$1', [tenderId]);
        await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderId]);
      }
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
