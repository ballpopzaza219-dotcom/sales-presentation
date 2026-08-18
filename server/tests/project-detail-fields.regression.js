// Regression test for the "เพิ่มโครงการ" form expansion (2026-07-25): new client_projects columns
// (bidding_method, sector_type, reference_price, phone_number, site_coordinates, submission_open_date,
// submission_conditions, installment_count) plus the new client_project_installments child table, the
// shared sector-toggle/installment-table components generalized out of the Tender form (see
// renderSectorTypeSection/renderInstallmentRows/installmentSetCount/renderInstallmentTotals in
// pr-system.html), the tender-linked auto-fill behavior (#pa-tender's onchange), and the
// double-submit guard added to save-project-full to match save-tender-full.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-detail-fields.regression.js

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
  let testCustomerId = null, manualProjectId = null, linkedProjectId = null, sourceTenderId = null, doubleSubmitProjectId = null, browser;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Project Detail Fields Test','project-detail-fields-test@example.com','_project_detail_fields_test_', $2, 'active') RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', d => d.accept()); // the auto-fill confirm(), when it fires, should just be accepted throughout

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', company.code);
    await page.fill('#f-loginUser', '_project_detail_fields_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    // ================= Scenario A: manual project (no tender link) =================
    console.log('\n--- Scenario A: manual project ---');
    await page.evaluate(() => { S.module = 'bidding'; S.page = 'fin_project_add'; S.projectAddForm = null; render(); });
    await page.waitForTimeout(200);

    await page.fill('#pa-name', 'ทดสอบโครงการด้วยตนเอง');
    await page.fill('#pa-client', 'บริษัท ทดสอบ จำกัด');
    await page.fill('#pa-biddingMethod', 'e-bidding');
    await page.fill('#pa-address', '123 ถ.ทดสอบ กรุงเทพฯ');
    await page.fill('#pa-phoneNumber', '02-123-4567');
    await page.fill('#pa-siteCoordinates', '13.7563,100.5018');
    await page.check('input[name="pa-sectorType"][value="private"]');
    await page.waitForSelector('#pa-budget');
    await page.fill('#pa-budget', '2000000');
    await page.fill('#pa-submissionConditions', 'เงื่อนไขสัญญาแบบทดสอบ');

    await page.fill('#pa-installmentCount', '4');
    await page.waitForTimeout(150);
    let rowCount = await page.evaluate(() => (S.projectAddForm.installments || []).length);
    assert(rowCount === 4, `typing 4 into installment count generates 4 rows immediately (got ${rowCount})`);
    await page.evaluate(() => {
      S.projectAddForm.installments = [
        { description: 'งวดที่ 1', amount: 500000, daysToComplete: 30 },
        { description: 'งวดที่ 2', amount: 500000, daysToComplete: 60 },
        { description: 'งวดที่ 3', amount: 500000, daysToComplete: 90 },
        { description: 'งวดที่ 4', amount: 500000, daysToComplete: 120 },
      ];
      render();
    });
    await page.waitForTimeout(150);
    await page.fill('#pa-installmentCount', '2');
    await page.waitForTimeout(150);
    const afterResize = await page.evaluate(() => S.projectAddForm.installments);
    assert(afterResize.length === 2, `resizing installment count from 4 to 2 leaves exactly 2 rows (got ${afterResize.length})`);
    assert(afterResize[0].description === 'งวดที่ 1' && Number(afterResize[0].amount) === 500000 && afterResize[1].description === 'งวดที่ 2', 'the first 2 rows kept their originally-typed data after the 4→2 resize, not cleared');

    await page.click('[data-act="save-project-full"]');
    await page.waitForTimeout(700);
    assert(!consoleErrors.length, `no console/page errors through Scenario A (got: ${consoleErrors.join(' | ')})`);
    manualProjectId = await page.evaluate(() => S.selectedProjectId);
    assert(!!manualProjectId, 'Scenario A save succeeded and navigated to the new project\'s detail page');

    const manualDbRow = (await pool.query('SELECT * FROM client_projects WHERE id=$1', [manualProjectId])).rows[0];
    assert(manualDbRow.bidding_method === 'e-bidding', 'bidding_method persisted');
    assert(manualDbRow.sector_type === 'private', `sector_type persisted as "private" (got "${manualDbRow.sector_type}")`);
    assert(Number(manualDbRow.budget_amount) === 2000000, `budget_amount persisted from the private-sector field (got ${manualDbRow.budget_amount})`);
    assert(manualDbRow.phone_number === '02-123-4567', 'phone_number persisted');
    assert(manualDbRow.site_coordinates === '13.7563,100.5018', 'site_coordinates persisted');
    assert(manualDbRow.submission_conditions === 'เงื่อนไขสัญญาแบบทดสอบ', 'submission_conditions persisted');
    assert(manualDbRow.installment_count === 2, `installment_count derived from the actual submitted array length (got ${manualDbRow.installment_count})`);
    const manualInstRows = await pool.query('SELECT * FROM client_project_installments WHERE project_id=$1 ORDER BY installment_no', [manualProjectId]);
    assert(manualInstRows.rowCount === 2, `exactly 2 installment rows saved (got ${manualInstRows.rowCount})`);
    assert(manualInstRows.rows[0].description === 'งวดที่ 1' && Number(manualInstRows.rows[0].amount) === 500000 && manualInstRows.rows[0].days_to_complete === 30, 'installment row 1 data correct');

    // ================= Scenario B: sector toggle preserve-on-switch-back =================
    console.log('\n--- Scenario B: sector toggle preserve-on-switch-back ---');
    await page.evaluate(() => { S.page = 'fin_project_add'; S.projectAddForm = null; render(); });
    await page.waitForTimeout(150);
    await page.fill('#pa-name', 'ทดสอบสลับภาครัฐ-เอกชน');
    await page.check('input[name="pa-sectorType"][value="government"]');
    await page.waitForSelector('#pa-budgetAmount');
    await page.fill('#pa-budgetAmount', '3000000');
    await page.fill('#pa-referencePrice', '2900000');
    await page.check('input[name="pa-sectorType"][value="private"]');
    await page.waitForSelector('#pa-budget');
    const govFieldsHiddenWhilePrivate = await page.evaluate(() => !document.getElementById('pa-budgetAmount'));
    assert(govFieldsHiddenWhilePrivate, 'switching to เอกชน hides the ภาครัฐ-only fields (budgetAmount/referencePrice)');
    await page.check('input[name="pa-sectorType"][value="government"]');
    await page.waitForSelector('#pa-budgetAmount');
    const preservedBudgetAmount = await page.inputValue('#pa-budgetAmount');
    const preservedReferencePrice = await page.inputValue('#pa-referencePrice');
    assert(preservedBudgetAmount === '3000000' && preservedReferencePrice === '2900000', `toggling back to ภาครัฐ preserves the previously-typed values (got budgetAmount=${preservedBudgetAmount}, referencePrice=${preservedReferencePrice})`);

    // ================= Scenario C: tender-linked auto-fill =================
    console.log('\n--- Scenario C: tender-linked auto-fill ---');
    sourceTenderId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/tenders', {
        tenderNo: '', name: 'ทดสอบ auto-fill source tender', projectOwner: 'หน่วยงานทดสอบ',
        submissionDeadline: '2026-09-01', estimatedValue: 0, note: '', projectNo: 'PRJ-SRC-001', biddingMethod: 'ประกวดราคาอิเล็กทรอนิกส์',
        sectorType: 'government', budgetAmount: 5000000, referencePrice: 4900000,
        location: '99 ถ.ต้นทาง กรุงเทพฯ', phoneNumber: '02-999-8888', siteCoordinates: '13.75,100.50',
        submissionOpenDate: '2026-08-01', submissionConditions: 'เงื่อนไขจาก Tender ต้นทาง',
        installments: [
          { description: 'งวด T1', amount: 2000000, daysToComplete: 30 },
          { description: 'งวด T2', amount: 2000000, daysToComplete: 60 },
          { description: 'งวด T3', amount: 1000000, daysToComplete: 90 },
        ],
      });
      DB.tenders.push(mapRealTender(data.tender));
      return data.tender.id;
    });
    const sourceTenderNo = await page.evaluate((id) => DB.tenders.find(t=>t.id===id).tenderNo, sourceTenderId);

    await page.evaluate(() => { S.page = 'fin_project_add'; S.projectAddForm = null; render(); });
    await page.waitForTimeout(150);

    // Sub-test: searching by partial NAME shows a matching suggestion.
    await page.click('#pa-name');
    await page.fill('#pa-name', 'auto-fill source tender');
    await page.waitForTimeout(150);
    let suggestionCount = await page.locator(`[data-act="select-project-tender"][data-id="${sourceTenderId}"]`).count();
    assert(suggestionCount === 1, 'typing a partial TENDER NAME shows a matching suggestion for the source tender');

    // Sub-test: clearing and searching by partial TENDER NO (just the trailing digits) also matches.
    await page.fill('#pa-name', sourceTenderNo.slice(-4));
    await page.waitForTimeout(150);
    suggestionCount = await page.locator(`[data-act="select-project-tender"][data-id="${sourceTenderId}"]`).count();
    assert(suggestionCount === 1, `typing a partial TENDER NO ("${sourceTenderNo.slice(-4)}") shows a matching suggestion for the source tender`);

    // Sub-test: a name with no matching tender shows no suggestion (manual-project path).
    await page.fill('#pa-name', 'ไม่มี tender แบบนี้ในระบบแน่นอน xyz123');
    await page.waitForTimeout(150);
    const noMatchCount = await page.locator('[data-act="select-project-tender"]').count();
    assert(noMatchCount === 0, 'typing text matching no tender shows zero suggestions (falls back to a plain manual project name)');

    // Now actually select it (via the tender-no search) and let auto-fill run.
    await page.fill('#pa-name', sourceTenderNo.slice(-4));
    await page.waitForTimeout(150);
    await page.click(`[data-act="select-project-tender"][data-id="${sourceTenderId}"]`);
    await page.waitForTimeout(400); // installments fetch is async

    const nameAfterSelect = await page.inputValue('#pa-name');
    assert(nameAfterSelect === 'ทดสอบ auto-fill source tender', `selecting a suggestion replaces the search text with the tender's real name (got "${nameAfterSelect}")`);

    const afterAutofill = await page.evaluate(() => ({
      sectorType: S.projectAddForm.sectorType, biddingMethod: S.projectAddForm.biddingMethod,
      budgetAmount: S.projectAddForm.budgetAmount, referencePrice: S.projectAddForm.referencePrice,
      address: S.projectAddForm.address, phoneNumber: S.projectAddForm.phoneNumber, siteCoordinates: S.projectAddForm.siteCoordinates,
      submissionOpenDate: S.projectAddForm.submissionOpenDate, submissionConditions: S.projectAddForm.submissionConditions,
      installments: S.projectAddForm.installments,
    }));
    assert(afterAutofill.sectorType === 'government', `auto-fill copied sectorType (got "${afterAutofill.sectorType}")`);
    assert(afterAutofill.biddingMethod === 'ประกวดราคาอิเล็กทรอนิกส์', 'auto-fill copied biddingMethod');
    assert(Number(afterAutofill.budgetAmount) === 5000000, `auto-fill copied budgetAmount (got ${afterAutofill.budgetAmount})`);
    assert(Number(afterAutofill.referencePrice) === 4900000, 'auto-fill copied referencePrice');
    assert(afterAutofill.address === '99 ถ.ต้นทาง กรุงเทพฯ', 'auto-fill copied tender location into the project\'s address field (no duplicate location column)');
    assert(afterAutofill.phoneNumber === '02-999-8888', 'auto-fill copied phoneNumber');
    assert(afterAutofill.siteCoordinates === '13.75,100.50', 'auto-fill copied siteCoordinates');
    assert(afterAutofill.submissionOpenDate === '2026-08-01', 'auto-fill copied submissionOpenDate');
    assert(afterAutofill.submissionConditions === 'เงื่อนไขจาก Tender ต้นทาง', 'auto-fill copied submissionConditions');
    assert(Array.isArray(afterAutofill.installments) && afterAutofill.installments.length === 3, `auto-fill copied all 3 installments from the tender (got ${(afterAutofill.installments||[]).length})`);
    assert(afterAutofill.installments[0].description === 'งวด T1' && Number(afterAutofill.installments[0].amount) === 2000000, 'installment row 1 correctly copied');

    // Prove nothing is locked: edit one auto-filled field before saving.
    await page.waitForSelector('#pa-budgetAmount');
    await page.fill('#pa-budgetAmount', '5500000');

    await page.click('[data-act="save-project-full"]');
    await page.waitForTimeout(700);
    linkedProjectId = await page.evaluate(() => S.selectedProjectId);
    assert(!!linkedProjectId, 'Scenario C save succeeded');
    const linkedDbRow = (await pool.query('SELECT * FROM client_projects WHERE id=$1', [linkedProjectId])).rows[0];
    assert(Number(linkedDbRow.budget_amount) === 5500000, `saved DB row has the EDITED budgetAmount (5500000), not the tender's original (5000000) — proves auto-filled fields aren't locked (got ${linkedDbRow.budget_amount})`);
    assert(linkedDbRow.tender_id === sourceTenderId, 'saved project is correctly linked to the source tender_id');
    const linkedInstRows = await pool.query('SELECT * FROM client_project_installments WHERE project_id=$1 ORDER BY installment_no', [linkedProjectId]);
    assert(linkedInstRows.rowCount === 3, `all 3 auto-filled installments were saved (got ${linkedInstRows.rowCount})`);

    // ================= Scenario D: editing the name after auto-fill unlinks the tender, but leaves
    // every other already-auto-filled field untouched (no separate "deselect" control anymore — typing
    // over the search box IS the deselect action, same as create_pr's project-search precedent). =================
    console.log('\n--- Scenario D: editing name after auto-fill ---');
    await page.evaluate(() => { S.page = 'fin_project_add'; S.projectAddForm = null; render(); });
    await page.waitForTimeout(150);
    await page.click('#pa-name');
    await page.fill('#pa-name', sourceTenderNo.slice(-4));
    await page.waitForTimeout(150);
    await page.click(`[data-act="select-project-tender"][data-id="${sourceTenderId}"]`);
    await page.waitForTimeout(400);
    const linkedAfterSelect = await page.evaluate(() => S.projectAddForm.tenderId);
    assert(String(linkedAfterSelect) === String(sourceTenderId), 'tenderId is set after selecting a suggestion');
    await page.fill('#pa-name', 'ทดสอบโครงการจาก Tender ที่ชนะ (แก้ชื่อ)');
    await page.waitForTimeout(150);
    const afterEdit = await page.evaluate(() => ({ biddingMethod: S.projectAddForm.biddingMethod, budgetAmount: S.projectAddForm.budgetAmount, tenderId: S.projectAddForm.tenderId }));
    assert(afterEdit.tenderId === '', `editing the name field after a selection clears tenderId back to unlinked (got "${afterEdit.tenderId}")`);
    assert(afterEdit.biddingMethod === 'ประกวดราคาอิเล็กทรอนิกส์' && Number(afterEdit.budgetAmount) === 5000000, 'editing the name does NOT clear the already-auto-filled fields (biddingMethod/budgetAmount survive)');

    // ================= Scenario E: reload verification (GET /api/customer/projects/:id end-to-end) =================
    console.log('\n--- Scenario E: reload verification ---');
    await page.evaluate(async (id) => {
      S.projectsLoaded = false; DB.projects = []; S.selectedProjectInstallments = undefined;
      S.page = 'fin_project_detail'; S.selectedProjectId = id;
      await loadRealProjects();
      await loadRealProjectDetail(id);
      render();
    }, linkedProjectId);
    await page.waitForTimeout(300);
    const reloadedText = await page.evaluate(() => document.getElementById('app').innerText);
    // Scenario C's save happened right after selecting a suggestion, which overwrites f.name with the
    // tender's own name (see onProjectAddTenderChange) — so the saved project's name IS the tender's
    // name, not whatever partial search text was typed along the way.
    assert(reloadedText.includes('ทดสอบ auto-fill source tender'), 'reloaded detail page shows the project name');
    assert(reloadedText.includes('ประกวดราคาอิเล็กทรอนิกส์'), 'reloaded detail page shows bidding_method');
    assert(reloadedText.includes('งวด T2'), 'reloaded detail page shows an installment row');
    const instRowsInDom = await page.locator('.card table tbody tr').count();
    assert(instRowsInDom >= 3, `reloaded detail page renders at least the 3 installment rows in a table (found ${instRowsInDom} total table rows across the page)`);

    // ================= Scenario F: double-submit guard =================
    console.log('\n--- Scenario F: double-submit guard ---');
    await page.evaluate(() => { S.page = 'fin_project_add'; S.projectAddForm = null; render(); });
    await page.waitForTimeout(150);
    await page.fill('#pa-name', 'ทดสอบ double-submit โครงการ');
    await page.check('input[name="pa-sectorType"][value="private"]');
    await page.waitForSelector('#pa-budget');
    await page.fill('#pa-budget', '1000000');
    const saveBtn = page.locator('[data-act="save-project-full"]');
    for (let i = 0; i < 10; i++) { await saveBtn.click({ force: true }).catch(() => {}); }
    await page.waitForTimeout(1000);
    doubleSubmitProjectId = await page.evaluate(() => S.selectedProjectId);
    const dupCount = await pool.query('SELECT id FROM client_projects WHERE name=$1', ['ทดสอบ double-submit โครงการ']);
    assert(dupCount.rowCount === 1, `exactly 1 project created in the database despite 10 rapid clicks (got ${dupCount.rowCount}: ${JSON.stringify(dupCount.rows)})`);
    const projectSavingAfter = await page.evaluate(() => S.projectSaving);
    assert(projectSavingAfter === false, 'S.projectSaving is reset back to false once the (single) real request settles');

    assert(!consoleErrors.length, `no console/page errors across the entire test (got: ${consoleErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      for (const id of [manualProjectId, linkedProjectId, doubleSubmitProjectId]) {
        if (id) await pool.query('DELETE FROM client_projects WHERE id=$1', [id]);
      }
      if (sourceTenderId) await pool.query('DELETE FROM client_tenders WHERE id=$1', [sourceTenderId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
