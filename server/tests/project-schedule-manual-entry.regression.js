// Regression test for the แผนงาน task table's "+ เพิ่มข้อมูล" manual-entry button — adds a task row with
// NO source_boq_item_id (taskName/durationDays/startDate/budgetAmount all typed by hand), sitting in
// the same S.taskTableNewRows array and the same table as "ดึงรายการ BOQ ทั้งหมด" pulls (see
// newRowHtml()'s r.isManual branch and the save-task-table handler's manualNewRows split, both in
// pr-system.html).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-manual-entry.regression.js

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
    const code = 'PMAN' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Manual Entry Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Manual Entry Test','project-schedule-manual-entry-test@example.com','_pman_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pman_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบเพิ่มข้อมูลเอง', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });
    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ---- 1. Button exists; on an empty schedule there's no BOQ at all yet, so the manual-entry
    // button is the ONLY way to add a task — confirm it works standalone, without any budget/BOQ setup.
    assert((await page.locator('[data-act="add-manual-task-row"]').count()) === 1, '"+ เพิ่มข้อมูล" button exists');
    assert((await page.locator('[data-act="pull-all-boq-items"]').count()) === 1, '"+ ดึงรายการ BOQ ทั้งหมด" button still exists alongside it');

    // ---- 2. Clicking adds a blank, fully-editable row (name/duration/start/budget all inputs, no
    // sourceBoqItemId at all).
    await page.click('[data-act="add-manual-task-row"]');
    await page.waitForTimeout(150);
    const freshRow = await page.evaluate(() => S.taskTableNewRows[0]);
    assert(freshRow.isManual === true && freshRow.sourceBoqItemId === undefined, 'a fresh manual row has isManual:true and no sourceBoqItemId at all');
    assert((await page.locator('#new-task-name-0').count()) === 1, 'รายละเอียดงาน is an editable <input> (not read-only text like a BOQ row)');
    assert((await page.locator('#new-task-start-0').count()) === 1, 'วันเริ่ม is an editable <input type=date> pre-save (unlike a BOQ-pulled row, which shows "-")');
    assert((await page.locator('#new-task-budget-0').count()) === 1, 'งบประมาณ (บาท) is an editable <input> pre-save (unlike a BOQ-pulled row, which is read-only)');

    // ---- 3. Clicking again adds a SECOND independent blank row (continuous adding, same pattern as
    // pull-all-boq-items).
    await page.click('[data-act="add-manual-task-row"]');
    await page.waitForTimeout(150);
    assert((await page.evaluate(() => S.taskTableNewRows.length)) === 2, 'clicking again adds a second independent row (got ' + (await page.evaluate(() => S.taskTableNewRows.length)) + ')');
    assert((await page.locator('#new-task-name-1').count()) === 1, 'the second row also has its own independent name input');

    // ---- 4. Trying to save with a blank name is rejected client-side with a specific toast — no API
    // call happens (DB stays empty).
    await page.fill('#new-task-duration-0', '5');
    await page.locator('#new-task-duration-0').dispatchEvent('change');
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(300);
    const blockedToast = await page.evaluate(() => S.toast && S.toast.msg);
    assert(!!blockedToast && /รายละเอียดงาน/.test(blockedToast), `saving with a blank รายละเอียดงาน is blocked with a specific toast (got: ${blockedToast})`);
    let dbCount = await pool.query('SELECT COUNT(*)::int AS n FROM client_project_tasks WHERE project_id=$1', [projectId]);
    assert(dbCount.rows[0].n === 0, 'no task was actually created while the blank-name row was still pending (both rows still local)');

    // Remove the second (still-blank) row, keep working with the first.
    await page.click('[data-act="remove-task-table-row"][data-idx="1"]');
    await page.waitForTimeout(150);
    assert((await page.evaluate(() => S.taskTableNewRows.length)) === 1, 'remove-task-table-row works on a manual row exactly like it does on a BOQ-pulled row');

    // ---- 5. Fill in every field and save -> a real task is created with no source_boq_item_id, exact
    // values persisted, and end_date computed server-side from start+duration (matches the normal
    // task-creation contract, not something special about manual entry).
    await page.fill('#new-task-name-0', 'งานเพิ่มเอง A');
    await page.locator('#new-task-name-0').dispatchEvent('input');
    await page.fill('#new-task-duration-0', '9');
    await page.locator('#new-task-duration-0').dispatchEvent('change');
    await page.fill('#new-task-start-0', '2026-08-01');
    await page.locator('#new-task-start-0').dispatchEvent('change');
    await page.fill('#new-task-budget-0', '150000');
    await page.locator('#new-task-budget-0').dispatchEvent('change');
    await page.waitForTimeout(150);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);

    let dbTask = await pool.query('SELECT task_name, duration_days, start_date, end_date, budget_amount, source_boq_item_id FROM client_project_tasks WHERE project_id=$1', [projectId]);
    assert(dbTask.rowCount === 1, `exactly 1 task persisted (got ${dbTask.rowCount})`);
    const row = dbTask.rows[0];
    assert(row.task_name === 'งานเพิ่มเอง A', `task_name persisted exactly as typed (got "${row.task_name}")`);
    assert(row.duration_days === 9, `duration_days = 9 (got ${row.duration_days})`);
    assert(Number(row.budget_amount) === 150000, `budget_amount = 150,000 persisted (got ${row.budget_amount})`);
    assert(row.source_boq_item_id === null, 'source_boq_item_id is NULL — this task is genuinely not linked to any BOQ item');
    assert(ymdEq(row.end_date, '2026-08-09'), `end_date computed server-side as start+duration-1 = 2026-08-09 (got ${row.end_date})`);

    // ---- 6. Mix a manual task with a BOQ-pulled task in the SAME project — both contribute correctly
    // to งบประมาณ(%) and the weighted S-curve, exactly like any other pair of tasks would.
    const budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    await page.evaluate(async (bid) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [{ workCode: 'B', description: 'งานจาก BOQ', unit: 'งาน', qty: 1, materialUnitPrice: 100000, laborUnitPrice: 0 }],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, budgetId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);

    const mixedCheck = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return {
        taskCount: ctx.tasks.length,
        totalBudget: ctx.totalBudget,
        manualTask: ctx.tasks.find(t => t.taskName === 'งานเพิ่มเอง A'),
        boqTask: ctx.tasks.find(t => t.taskName === 'งานจาก BOQ'),
      };
    });
    assert(mixedCheck.taskCount === 2, `both the manual and BOQ-pulled task exist side by side in the same table (got ${mixedCheck.taskCount})`);
    assert(mixedCheck.totalBudget === 250000, `total budget correctly sums both types (150,000 manual + 100,000 BOQ = 250,000, got ${mixedCheck.totalBudget})`);
    assert(!!mixedCheck.manualTask && !mixedCheck.manualTask.sourceBoqItemId, 'the manual task has no sourceBoqItemId even after being mixed in with a BOQ task');
    assert(!!mixedCheck.boqTask && !!mixedCheck.boqTask.sourceBoqItemId, 'the BOQ-pulled task DOES carry its sourceBoqItemId, unaffected by the manual task existing alongside it');
    const manualPct = await page.evaluate(() => projectScheduleBudgetPercent(150000, 250000));
    assert(Math.abs(manualPct - 60) < 0.05, `the manual task's งบประมาณ(%) computes correctly against the combined total (150,000/250,000 = 60%, got ${manualPct})`);

    // Give the BOQ task a date too, so the S-curve has 2 real weighted tasks to combine.
    await page.evaluate(async (pid) => {
      const boq = S.projectTasks.find(t => t.taskName === 'งานจาก BOQ');
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${boq.id}`, { taskName: 'งานจาก BOQ', durationDays: 9, startDate: '2026-08-10' });
    }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const curveCheck = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      const curve = computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget);
      return curve[curve.length - 1];
    });
    assert(Math.abs(curveCheck.planned - 100) < 0.1, `weighted S-curve reaches 100% at the end with both a manual AND a BOQ task fully auto-distributed and back-to-back (got ${curveCheck.planned})`);

    // ---- 7. Deleting the manual task works like any other delete — no special "return to BOQ"
    // behavior needed since it was never linked to one.
    const manualTaskId = await page.evaluate(() => S.projectTasks.find(t => t.taskName === 'งานเพิ่มเอง A').id);
    await page.evaluate(async ({ pid, id }) => { await apiCall('DELETE', `/api/customer/projects/${pid}/tasks/${id}`); }, { pid: projectId, id: manualTaskId });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    dbCount = await pool.query('SELECT COUNT(*)::int AS n FROM client_project_tasks WHERE project_id=$1', [projectId]);
    assert(dbCount.rows[0].n === 1, `deleting the manual task removes it cleanly, leaving only the BOQ task (got ${dbCount.rows[0].n} remaining)`);
    const remaining = await pool.query('SELECT task_name FROM client_project_tasks WHERE project_id=$1', [projectId]);
    assert(remaining.rows[0].task_name === 'งานจาก BOQ', 'the remaining task is the BOQ one, untouched by the manual task\'s deletion');

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

// node-postgres returns DATE columns as local-midnight JS Date objects (see server.js's own comment on
// CLIENT_PROJECT_TASK_SELECT using to_char for exactly this reason) — this test queries the raw column
// directly (not through that SELECT), so compare by formatted date string instead of by Date identity.
function ymdEq(dateVal, expectedYmd) {
  if (!dateVal) return false;
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  const ymd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return ymd === expectedYmd;
}
