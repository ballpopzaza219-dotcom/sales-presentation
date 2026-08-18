// Regression test for the แผนงาน S-curve-style task table (2026-07-26 rewrite, Phase 1) —
// pr-system.html's renderProjectScheduleTable() + the client_project_tasks.budget_amount column +
// server.js's POST .../tasks/batch snapshot logic. This is the table that REPLACED the old
// MS-Project-style WBS/Gantt-chart view entirely (see project-tasks-crud/cpm/boq-batch.regression.js
// for the CRUD/CPM/pull-all coverage that still applies unchanged — this file covers only what's new:
// the No./รายละเอียดงาน/ระยะเวลา/วันเริ่ม/วันเสร็จ/งบประมาณ(บาท+%) columns, the budget_amount SNAPSHOT
// (not live-synced to later BOQ revisions — see schema.sql's comment on the column), and that the old
// WBS/milestone/parent/total-float/critical-path/S-curve-chart UI is gone from this page).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-scurve-table.regression.js

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

(async () => {
  let companyId = null, projectId = null, budgetId = null, browser;
  try {
    const code = 'PSCV' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule S-Curve Table Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'S-Curve Table Test','project-schedule-scurve-test@example.com','_pscv_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pscv_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบตาราง S-curve', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // ---- 1. Budget: 3 real items, 300/300/400 amount split (30%/30%/40% of a 1,000 total) — chosen
    // to make the weighted-% math easy to eyeball, and to match the split later phases' S-curve test
    // will reuse (see the phase-3 plan's "สร้าง 3 task งบ 30%/30%/40%").
    budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    await page.evaluate(async (bid) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [
          { workCode: 'A-1', description: 'งานที่ 1', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'A-2', description: 'งานที่ 2', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'A-3', description: 'งานที่ 3', unit: 'งาน', qty: 1, materialUnitPrice: 400, laborUnitPrice: 0 },
        ],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, budgetId);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ---- 2. The old MS-Project-style UI is completely gone from this page: no WBS/Milestone/Parent/
    // Total Float columns, no Gantt bars, no dependency/baseline sections, no zoom buttons.
    const headerText = await page.locator('#task-table-section thead').innerText();
    assert(!/WBS/i.test(headerText), 'no WBS column header (old hierarchy UI removed)');
    assert(!/milestone/i.test(headerText), 'no Milestone column header');
    assert(!/parent/i.test(headerText), 'no Parent Task column header');
    assert(!/total float/i.test(headerText), 'no Total Float column header');
    assert((await page.locator('[data-gantt-bar]').count()) === 0, 'no Gantt bar elements anywhere');
    assert((await page.locator('[data-act="set-gantt-zoom"]').count()) === 0, 'no OLD Gantt-chart zoom buttons (superseded by set-schedule-zoom in Phase 2 — see project-schedule-periods.regression.js)');
    assert((await page.locator('[data-act="add-task-dependency"]').count()) === 0, 'no dependency-add UI');
    assert((await page.locator('[data-act="set-baseline"]').count()) === 0, 'no baseline UI');
    // .innerText reflects CSS text-transform (table headers are upper-cased via CSS in this app — see
    // the same note in project-tasks-cpm.regression.js), so this compares case-insensitively.
    const firstHeaderCell = (await page.locator('#task-table-section thead tr').first().locator('th').first().innerText()).trim();
    assert(firstHeaderCell.toLowerCase() === 'no.', `No. column header present (got "${firstHeaderCell}")`);
    assert(headerText.includes('งบประมาณ'), 'งบประมาณ column header present');

    // ---- 3. Pull all 3 BOQ items -> unsaved rows carry the correct budgetAmount, and the live %
    // preview (computed over just the 3 pulled rows, no saved tasks yet) is 30/30/40.
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(300);
    const pulled = await page.evaluate(() => S.taskTableNewRows.map(r => ({ taskName: r.taskName, budgetAmount: Number(r.budgetAmount) })));
    assert(pulled.length === 3, `all 3 BOQ items pulled (got ${pulled.length})`);
    const totalPulled = pulled.reduce((s, r) => s + r.budgetAmount, 0);
    assert(totalPulled === 1000, `pulled rows' budgetAmount sums to 1,000 (got ${totalPulled})`);
    const pctCells = await page.locator('#task-table-section table tbody tr td:nth-child(7)').allInnerTexts();
    const pcts = pctCells.slice(0, 3).map(t => t.trim());
    assert(JSON.stringify(pcts) === JSON.stringify(['30.0%', '30.0%', '40.0%']), `live งบประมาณ(%) preview shows 30.0%/30.0%/40.0% before saving (got ${JSON.stringify(pcts)})`);

    // ---- 4. Save -> budget_amount persisted exactly as the BOQ item's amount at pull time (snapshot).
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);
    let dbTasks = await pool.query(
      `SELECT task_name, budget_amount, source_boq_item_id FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 ORDER BY sort_order`,
      [companyId, projectId]
    );
    assert(dbTasks.rowCount === 3, `3 tasks persisted (got ${dbTasks.rowCount})`);
    const amountsByName = Object.fromEntries(dbTasks.rows.map(r => [r.task_name, Number(r.budget_amount)]));
    assert(amountsByName['งานที่ 1'] === 300 && amountsByName['งานที่ 2'] === 300 && amountsByName['งานที่ 3'] === 400, `budget_amount snapshot correct for all 3 tasks (got ${JSON.stringify(amountsByName)})`);

    // ---- 5. No./budget(บาท)/budget(%) render correctly for saved rows, and the total row sums to
    // 1,000.00 / 100.0%. Since Phase 2 (แผนงาน/ผลงาน time grid), every SAVED task renders as 2 <tr>
    // (rowspan="2" on the shared No./name/duration/dates/budget cells, on the FIRST of the pair) — so
    // "task i's shared cells" means `tbody tr:nth(i*2)`, not a flat td:nth-child() over every <tr>.
    const bodyRows = page.locator('#task-table-section table tbody tr');
    const noCells = await Promise.all([0, 2, 4].map(i => bodyRows.nth(i).locator('td').first().innerText()));
    assert(JSON.stringify(noCells.map(t => t.trim())) === JSON.stringify(['1', '2', '3']), `No. column is sequential 1/2/3, one per task's แผนงาน row (got ${JSON.stringify(noCells)})`);
    const bahtCells = await Promise.all([0, 2, 4].map(i => bodyRows.nth(i).locator('td').nth(5).innerText()));
    assert(JSON.stringify(bahtCells.map(t => t.trim())) === JSON.stringify(['300.00', '300.00', '400.00']), `งบประมาณ(บาท) renders correctly for all 3 saved rows (got ${JSON.stringify(bahtCells)})`);
    const savedPctCells = await Promise.all([0, 2, 4].map(i => bodyRows.nth(i).locator('td').nth(6).innerText()));
    assert(JSON.stringify(savedPctCells.map(t => t.trim())) === JSON.stringify(['30.0%', '30.0%', '40.0%']), `งบประมาณ(%) still correct after save/reload (got ${JSON.stringify(savedPctCells)})`);
    const totalRowText = await bodyRows.last().innerText();
    assert(totalRowText.includes('1,000.00') && totalRowText.includes('100.0%'), `total row shows 1,000.00 baht / 100.0% (got "${totalRowText.replace(/\s+/g, ' ')}")`);

    // ---- 6. SNAPSHOT decision, not live-sync: revise the BOQ (double item 1's price to 600) and
    // approve the new revision -> the already-saved task's budget_amount is UNCHANGED, and so is its
    // rendered %. This is the explicit design choice from the phase-1 request ("แจ้งแนวทางที่เลือกกลับมา
    // ด้วย") — a task's planned budget share stays fixed once scheduling has started.
    await page.evaluate(async (bid) => { await apiCall('POST', `/api/customer/budgets/${bid}/revise`, { reason: 'ปรับราคา A-1' }); }, budgetId);
    await page.evaluate(async (bid) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [
          { workCode: 'A-1', description: 'งานที่ 1', unit: 'งาน', qty: 1, materialUnitPrice: 600, laborUnitPrice: 0 },
          { workCode: 'A-2', description: 'งานที่ 2', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'A-3', description: 'งานที่ 3', unit: 'งาน', qty: 1, materialUnitPrice: 400, laborUnitPrice: 0 },
        ],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, budgetId);
    dbTasks = await pool.query(
      `SELECT task_name, budget_amount FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 AND task_name='งานที่ 1'`,
      [companyId, projectId]
    );
    assert(Number(dbTasks.rows[0].budget_amount) === 300, `revising the BOQ item's price does NOT retroactively change the already-saved task's budget_amount snapshot (still 300, got ${dbTasks.rows[0].budget_amount})`);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const pctAfterRevision = (await bodyRows.nth(0).locator('td').nth(6).innerText()).trim();
    assert(pctAfterRevision === '30.0%', `rendered % also stays at the snapshot value after a BOQ revision, not recalculated against the new price (got ${pctAfterRevision})`);

    // ---- 7. Delete task 3 -> the % of the remaining 2 tasks recomputes against their own new total
    // (300+300=600), so each becomes 50.0%, not still 30.0%/30.0%.
    const task3Id = (await pool.query(`SELECT id FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 AND task_name='งานที่ 3'`, [companyId, projectId])).rows[0].id;
    await page.evaluate(async ({ pid, taskId }) => { await apiCall('DELETE', `/api/customer/projects/${pid}/tasks/${taskId}`); }, { pid: projectId, taskId: task3Id });
    // A direct apiCall (unlike clicking the delete-task button) doesn't trigger the app's own
    // loadProjectTasks()+render() refresh, so S.projectTasks would otherwise still hold the deleted
    // task in memory — reload explicitly, same as this file's revision-approval step above.
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const pctAfterDelete = await Promise.all([0, 2].map(i => bodyRows.nth(i).locator('td').nth(6).innerText()));
    assert(JSON.stringify(pctAfterDelete.map(t => t.trim())) === JSON.stringify(['50.0%', '50.0%']), `งบประมาณ(%) recomputes against the remaining tasks' own total after a delete (got ${JSON.stringify(pctAfterDelete)})`);

    const realErrors = consoleErrors.filter(e => !e.includes('Failed to load resource'));
    assert(!realErrors.length, `no unexpected console/page errors across the entire test (got: ${realErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (companyId) await pool.query('DELETE FROM customer_companies WHERE id=$1', [companyId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
