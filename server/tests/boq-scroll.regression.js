// Regression test for the "checkbox toggle in the BOQ import preview table jumps the modal back to
// the top" bug fixed 2026-07-24. Root cause: every render() fully replaces #app's innerHTML,
// including the `.modal` div (see the CSS: `.modal{max-height:88vh; overflow-y:auto}` — the modal
// itself scrolls, not the page), and a freshly-recreated DOM node always starts at scrollTop 0. Fix:
// render() now saves `.modal`'s scrollTop before the innerHTML swap and restores it after (see the
// comment on that in render(), pr-system.html).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed (npx playwright install chromium — already done once in this
// project; `playwright` itself is a devDependency, no @playwright/test runner needed since this
// drives the browser directly rather than using that framework).
// Run: cd server && node tests/boq-scroll.regression.js

const path = require('path');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_COMPANY_ID = 13;

(async () => {
  let testCustomerId = null, tenderId = null, budgetId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'BOQ Scroll Test','boq-scroll@example.com','_boq_scroll_', $2, 'active', true) RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;
    const tenderIns = await pool.query(
      `INSERT INTO client_tenders (company_id, tender_no, name, status, created_by) VALUES ($1,'BOQ-SCROLL-001','BOQ scroll regression tender','preparing',$2) RETURNING id`,
      [company.id, testCustomerId]
    );
    tenderId = tenderIns.rows[0].id;

    // A long BOQ file (well beyond one screen) so the preview table actually overflows the modal.
    // boq-template requires an authenticated session — log in via a plain node-side fetch first
    // (independent of the browser session used for the actual interactive test below) just to
    // download it.
    const loginRes = await fetch(BASE + '/api/customer-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyCode: company.code, username: '_boq_scroll_', password: 'TestPass123!' }),
    });
    const nodeCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    const templateRes = await fetch(BASE + '/api/customer/boq-template', { headers: { Cookie: nodeCookie } });
    const templateBuf = Buffer.from(await templateRes.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBuf);
    const sheet = wb.worksheets[0];
    for (let i = 0; i < 30; i++) {
      sheet.getRow(5 + i).values = [`W-${i + 1}`, `รายการทดสอบที่ ${i + 1}`, 'ชิ้น', 1, 10, 5, '', '', '', 'N', ''];
    }
    const testFilePath = path.join(__dirname, 'fixtures', '_tmp-scroll-test.xlsx');
    await wb.xlsx.writeFile(testFilePath);

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', company.code);
    await page.fill('#f-loginUser', '_boq_scroll_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    const budgetData = await page.evaluate(async (tid) => {
      const r = await fetch('/api/customer/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenderId: tid }) });
      return r.json();
    }, tenderId);
    budgetId = budgetData.budget.id;

    await page.evaluate(async (bid) => {
      const r = await fetch(`/api/customer/budgets/${bid}`);
      const d = await r.json();
      S.selectedBudgetDetail = d.budget;
      S.page = 'fin_budget_detail';
      render();
    }, budgetId);
    await page.waitForTimeout(300);
    await page.click('[data-act="open-boq-import"]');
    await page.waitForTimeout(200);
    await page.setInputFiles('#boq-import-file-template', testFilePath);
    await page.click('[data-act="preview-boq-import"]');
    await page.waitForTimeout(500);

    // Scroll to (and measure scrollTop at) a checkbox well past the fold BEFORE clicking — Playwright's
    // own click() auto-scrolls its target into view as part of its actionability checks, so the
    // "before" measurement has to be taken after that natural scroll settles, not at some arbitrary
    // earlier position, or the test would be measuring Playwright's own scroll-into-view instead of
    // the app's render()-caused reset.
    // 2 checkboxes per row (isGroup + isSummaryRow, added by a later feature) — index into the END of
    // the list rather than a fixed absolute index, so this keeps targeting a row deep enough to
    // actually require scrolling regardless of how many checkbox columns a row has.
    const checkboxes = await page.$$('.modal tbody input[type="checkbox"]');
    if (checkboxes.length < 30) throw new Error(`test setup problem: expected 30+ preview rows worth of checkboxes, found ${checkboxes.length}`);
    const targetIdx = checkboxes.length - 5;
    await checkboxes[targetIdx].scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => document.querySelector('.modal').scrollTop);
    if (scrollBefore < 50) throw new Error(`test setup problem: modal did not actually scroll (scrollTop=${scrollBefore}) — is the preview table long enough to overflow?`);

    // Toggle the is_group checkbox on that row (already in view — click() shouldn't need to re-scroll).
    await checkboxes[targetIdx].click();
    await page.waitForTimeout(300);

    const scrollAfter = await page.evaluate(() => document.querySelector('.modal').scrollTop);
    console.log(`  modal scrollTop before checkbox toggle: ${scrollBefore}, after: ${scrollAfter}`);
    if (Math.abs(scrollAfter - scrollBefore) > 5) {
      throw new Error(`ASSERTION FAILED: modal scroll position jumped from ${scrollBefore} to ${scrollAfter} after toggling a checkbox (the bug is back)`);
    }
    console.log('  OK: modal scroll position preserved after toggling a checkbox mid-table');

    if (consoleErrors.length) throw new Error('Console errors during the interaction: ' + consoleErrors.join(' | '));
    console.log('  OK: no console errors');

    console.log('\nALL SCROLL-REGRESSION CHECKS PASSED');
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try { require('fs').unlinkSync(path.join(__dirname, 'fixtures', '_tmp-scroll-test.xlsx')); } catch (e) {}
    try {
      if (budgetId) {
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id=$1', [budgetId]);
        const revIds = (await pool.query('SELECT id FROM client_budget_revisions WHERE budget_id=$1', [budgetId])).rows.map(r => r.id);
        for (const rid of revIds) await pool.query('DELETE FROM client_budget_items WHERE revision_id=$1', [rid]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id=$1', [budgetId]);
        await pool.query('DELETE FROM client_budgets WHERE id=$1', [budgetId]);
      }
      if (tenderId) await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
