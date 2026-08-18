// Regression test for the แผนงาน S-curve table's Phase 2 — the day/week/month time grid + แผนงาน
// (planned, amber)/ผลงาน (actual, sky) %-per-day rows, the % สะสม cumulative column, and the
// client_project_task_periods DAY-granularity storage (see the long comment above PUT
// .../tasks/periods in server.js and above renderProjectScheduleTable()/scheduleBuildColumns() etc.
// in pr-system.html). Phase 1's own table/budget-snapshot coverage lives in
// project-schedule-scurve-table.regression.js — this file covers only what Phase 2 added.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-periods.regression.js

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
  let companyId = null, projectId = null, browser;
  try {
    const code = 'PPER' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Periods Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Periods Test','project-schedule-periods-test@example.com','_pper_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pper_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ แผนงาน/ผลงาน', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    const budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    await page.evaluate(async (bid) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [
          { workCode: 'A', description: 'งาน A', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'B', description: 'งาน B', unit: 'งาน', qty: 1, materialUnitPrice: 700, laborUnitPrice: 0 },
        ],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, budgetId);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);

    // ---- 1. No dates yet -> empty grid, no periods, save-task-periods disabled, hint shown.
    assert((await page.locator('[data-act="save-task-periods"]').isDisabled()), 'save-task-periods starts disabled (no periods, nothing scheduled)');
    assert((await page.locator('#task-table-section').innerText()).includes('ยังไม่มี Task ที่มีวันเริ่ม'), 'no-dates hint shown before any task has both start/end dates');
    assert((await page.evaluate(() => S.taskPeriods.length)) === 0, 'S.taskPeriods empty with no scheduled tasks');

    // ---- 2. Set dates: A = 10 days (2026-08-01..10), B = 20 days (2026-08-11..30) -> reload triggers
    // auto-distribute for แผนงาน only (never ผลงาน).
    const taskIds = await page.evaluate(() => S.projectTasks.map(t => ({ id: t.id, name: t.taskName })));
    const aId = taskIds.find(t => t.name === 'งาน A').id, bId = taskIds.find(t => t.name === 'งาน B').id;
    await page.evaluate(async ({ pid, aId, bId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${aId}`, { taskName: 'งาน A', durationDays: 10, startDate: '2026-08-01' });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${bId}`, { taskName: 'งาน B', durationDays: 20, startDate: '2026-08-11' });
    }, { pid: projectId, aId, bId });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    assert((await page.evaluate(() => taskPeriodsHasUnsavedChanges())) === true, 'auto-distributed แผนงาน defaults correctly show as unsaved (not in DB yet)');
    const aPlannedSum = await page.evaluate((id) => S.taskPeriods.filter(p => p.taskId === id).reduce((s, p) => s + p.plannedPercent, 0), aId);
    const bPlannedSum = await page.evaluate((id) => S.taskPeriods.filter(p => p.taskId === id).reduce((s, p) => s + p.plannedPercent, 0), bId);
    assert(Math.abs(aPlannedSum - 100) < 0.05 && Math.abs(bPlannedSum - 100) < 0.05, `auto-distributed แผนงาน sums to exactly 100% per task (got A=${aPlannedSum}, B=${bPlannedSum})`);
    const actualSum = await page.evaluate(() => S.taskPeriods.reduce((s, p) => s + p.actualPercent, 0));
    assert(actualSum === 0, 'ผลงาน (actual) gets NO auto-default — only แผนงาน does');

    // ---- 3. 'day'/'week' zoom: exactly 1 editable cell per (task, in-range day, field) — A: 10 days x
    // 2 fields = 20, B: 20 days x 2 fields = 40, total 60. 'week' zoom is the same columns, just
    // different header grouping, so the count must be identical.
    // Selector uses .sched-period-cell (not type="number"[step="0.1"]) because the 2026-07-26 ผลงาน
    // task-level fields follow-up added a same-shaped %(ผลงาน) input elsewhere in the row — the class
    // is what actually distinguishes a period-grid cell now.
    for (const zoom of ['day', 'week']) {
      await page.click(`[data-act="set-schedule-zoom"][data-zoom="${zoom}"]`);
      await page.waitForTimeout(150);
      const n = await page.locator('#task-table-section td input.sched-period-cell').count();
      assert(n === 60, `zoom=${zoom}: exactly 60 editable period cells (10+20 days x 2 rows each) (got ${n})`);
    }

    // ---- 4. 'month' zoom: 7-day buckets anchored per calendar month (ว1:1-7, ว2:8-14, ว3:15-21,
    // ว4:22-31) — verify the AGGREGATED cell values match the even daily split exactly.
    await page.click('[data-act="set-schedule-zoom"][data-zoom="month"]');
    await page.waitForTimeout(150);
    const monthHeaderText = await page.locator('#task-table-section thead').innerText();
    assert(/ว1/.test(monthHeaderText) && /ว4/.test(monthHeaderText), 'month zoom shows ว1..ว4 bucket sub-headers');
    // Row order in the DOM: A-planned, A-actual, B-planned, B-actual (tasks in sort_order, 2 <tr> each).
    const rows = page.locator('#task-table-section table tbody tr');
    const aPlannedCells = (await rows.nth(0).locator('td input.sched-period-cell').evaluateAll(els => els.map(el => el.value)));
    assert(JSON.stringify(aPlannedCells) === JSON.stringify(['70', '30']), `งาน A แผนงาน month-zoom cells: 7 days in ว1 (70%) + 3 days in ว2 (30%) (got ${JSON.stringify(aPlannedCells)})`);
    const bPlannedCells = (await rows.nth(2).locator('td input.sched-period-cell').evaluateAll(els => els.map(el => el.value)));
    assert(JSON.stringify(bPlannedCells) === JSON.stringify(['20', '35', '45']), `งาน B แผนงาน month-zoom cells: 4d(ว2)=20%, 7d(ว3)=35%, 9d(ว4)=45% (got ${JSON.stringify(bPlannedCells)})`);

    // ---- 5. Cumulative column (% สะสม) shows 100.0% for both tasks' แผนงาน rows, 0.0% for ผลงาน.
    const cumCells = await page.locator('#task-table-section table tbody tr td.num-cell').allInnerTexts();
    // (mixed in with budget% cells too — just check the specific known-good values appear somewhere in each row's last num-cell instead)
    const aPlannedCum = (await rows.nth(0).locator('td.num-cell').last().innerText()).trim();
    const aActualCum = (await rows.nth(1).locator('td.num-cell').last().innerText()).trim();
    assert(aPlannedCum === '100.0%' && aActualCum === '0.0%', `% สะสม correct for งาน A before saving (planned=${aPlannedCum}, actual=${aActualCum})`);

    // ---- 6. Save -> persisted at DAY granularity regardless of the zoom the save was made from
    // (month zoom was active) — 30 day-rows total (10 for A, 20 for B), values match the even split.
    await page.click('[data-act="save-task-periods"]');
    await page.waitForTimeout(600);
    const dbRows = await pool.query(
      `SELECT t.task_name, p.period_date, p.planned_percent, p.actual_percent
       FROM client_project_task_periods p JOIN client_project_tasks t ON t.id=p.task_id
       WHERE t.project_id=$1 ORDER BY t.task_name, p.period_date`,
      [projectId]
    );
    assert(dbRows.rowCount === 30, `30 day-rows persisted (10 for A + 20 for B), even though the save happened at month zoom (got ${dbRows.rowCount})`);
    const aRows = dbRows.rows.filter(r => r.task_name === 'งาน A');
    assert(aRows.length === 10 && aRows.every(r => Math.abs(Number(r.planned_percent) - 10) < 0.05), `งาน A persisted as 10 individual day-rows at ~10% each, not as 2 bucket rows (got ${JSON.stringify(aRows.map(r=>r.planned_percent))})`);
    assert((await page.evaluate(() => taskPeriodsHasUnsavedChanges())) === false, 'no unsaved changes right after a successful save');

    // ---- 7. Edit ผลงาน (actual) manually — day zoom, งาน A's first day — then save, confirm it
    // persists and the cumulative column updates.
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(150);
    // .sched-period-cell (not a bare type="number" selector) — since the 2026-07-26/27 PLAN/ACTUAL
    // 2-row layout follow-up, the ACTUAL row's own actualAmount/actualPercent inputs (also type=number)
    // now sit BEFORE the period-grid cells in DOM order, so an unscoped "first number input" selector
    // would grab the wrong field entirely.
    const aActualFirstInput = rows.nth(1).locator('td input.sched-period-cell').first();
    await aActualFirstInput.fill('50');
    await aActualFirstInput.dispatchEvent('change');
    await page.waitForTimeout(200);
    const aActualCumAfterEdit = (await rows.nth(1).locator('td.num-cell').last().innerText()).trim();
    assert(aActualCumAfterEdit === '50.0%', `% สะสม (ผลงาน) updates live to 50.0% right after typing, before saving (got ${aActualCumAfterEdit})`);
    await page.click('[data-act="save-task-periods"]');
    await page.waitForTimeout(500);
    const actualPersisted = await pool.query(
      `SELECT p.actual_percent FROM client_project_task_periods p JOIN client_project_tasks t ON t.id=p.task_id
       WHERE t.project_id=$1 AND t.task_name='งาน A' AND p.period_date='2026-08-01'`,
      [projectId]
    );
    assert(Number(actualPersisted.rows[0].actual_percent) === 50, `manually-edited ผลงาน value (50%) persisted to the correct day row (got ${actualPersisted.rows[0].actual_percent})`);

    // ---- 8. Validation: pushing a task's ผลงาน total over 100% is rejected — both client-side
    // (toast, no API call) and server-side directly (PUT with a >100% sum returns 400 naming the task).
    const validationErrOnClient = await page.evaluate((id) => {
      const before = S.taskPeriods.map(p => ({ ...p }));
      for (const d of ['2026-08-02', '2026-08-03']) {
        let p = S.taskPeriods.find(x => x.taskId === id && x.periodDate === d);
        if (!p) { p = { taskId: id, periodDate: d, plannedPercent: 0, actualPercent: 0 }; S.taskPeriods.push(p); }
        p.actualPercent = 30;
      }
      const errors = taskPeriodsValidationErrors();
      S.taskPeriods = before; // revert — this check is pure logic, not meant to leave dirty state behind
      return errors;
    }, aId);
    assert(validationErrOnClient.length === 1 && /งาน A/.test(validationErrOnClient[0]) && /ผลงาน/.test(validationErrOnClient[0]), `client-side validation flags งาน A's ผลงาน total exceeding 100% (got ${JSON.stringify(validationErrOnClient)})`);

    const serverValidationErr = await page.evaluate(async ({ pid, id }) => {
      try {
        await apiCall('PUT', `/api/customer/projects/${pid}/tasks/periods`, {
          periods: [
            { taskId: id, periodDate: '2026-08-01', plannedPercent: 0, actualPercent: 60 },
            { taskId: id, periodDate: '2026-08-02', plannedPercent: 0, actualPercent: 60 },
          ],
        });
        return null;
      } catch (e) { return e.message; }
    }, { pid: projectId, id: aId });
    assert(!!serverValidationErr && /งาน A/.test(serverValidationErr) && /ผลงาน/.test(serverValidationErr), `server-side PUT .../tasks/periods also rejects a >100% ผลงาน sum with a clear error naming the task (got: ${serverValidationErr})`);
    const unchangedAfterRejectedSave = await pool.query(
      `SELECT p.actual_percent FROM client_project_task_periods p JOIN client_project_tasks t ON t.id=p.task_id
       WHERE t.project_id=$1 AND t.task_name='งาน A' AND p.period_date='2026-08-01'`,
      [projectId]
    );
    assert(Number(unchangedAfterRejectedSave.rows[0].actual_percent) === 50, 'the rejected over-100% save did not partially write anything (still 50%, the earlier legit save)');

    // ---- 9. Phase-2 UI sanity: zoom buttons + legend exist, and the old removed Gantt/S-curve chart
    // UI still hasn't come back (Phase 1's own regression file covers this more thoroughly).
    assert((await page.locator('[data-act="set-schedule-zoom"]').count()) === 3, 'exactly 3 zoom buttons (day/week/month)');
    assert((await page.locator('[data-gantt-bar]').count()) === 0, 'still no Gantt bar elements');

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
