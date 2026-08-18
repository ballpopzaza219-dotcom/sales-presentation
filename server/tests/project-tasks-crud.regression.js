// Regression test for แผนงาน (Gantt) Phase 1 — WBS/Task list CRUD, dependencies, and baseline
// (see client_project_tasks/client_project_task_dependencies/client_project_task_baseline in
// schema.sql, and pageFinProjectSchedule() in pr-system.html). Phase 1 only: no CPM/auto-schedule,
// no Gantt chart visual — those are Phase 2/3, covered by their own future regression files.
//
// Uses a brand new company/customer fixture (same pattern as tender-overview-dashboard.regression.js)
// so it doesn't collide with the large amount of data the other regression suites leave behind on
// FIXTURE_COMPANY_ID=13.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-tasks-crud.regression.js

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
    const code = 'PTSK' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Tasks CRUD Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Project Tasks Test','project-tasks-test@example.com','_project_tasks_test_', $2, 'active')`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_project_tasks_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    // ---- Setup: create a real project via the API, then navigate to its schedule page.
    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบแผนงาน', clientName: '', tenderId: null, siteAddress: '',
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
    let s = await page.evaluate(() => ({ page: S.page, module: S.module }));
    assert(s.page === 'fin_project_schedule' && s.module === 'bidding', `navigated to fin_project_schedule (got ${JSON.stringify(s)})`);

    // ---- 1. Empty state: no tasks yet. 2026-07-26: the old separate empty-state CTA (with its own
    // "+ เพิ่ม Task" button) is gone — the unified task table itself renders unconditionally, even
    // with zero existing tasks, showing just the "ดึงรายการ BOQ ทั้งหมด" pull-all affordance.
    assert((await page.locator('#task-table-section').count()) === 1, 'unified task table section renders even with zero tasks');
    assert((await page.locator('#task-table-section [data-act="pull-all-boq-items"]').count()) === 1, '"ดึงรายการ BOQ ทั้งหมด" is present on an empty schedule');
    assert((await page.locator('#task-table-section [data-act="delete-task"]').count()) === 0, 'no existing-task rows (and so no delete icons) on a genuinely empty schedule');
    assert(!consoleErrors.length, `no console/page errors on the empty schedule (got: ${consoleErrors.join(' | ')})`);

    // ---- 2. Create 2 top-level tasks, each with 2 children -> verify wbs_code 1,1.1,1.2,2,2.1,2.2.
    async function addTask(parentTaskId, taskName, durationDays, startDate) {
      return page.evaluate(async ({ pid, parentTaskId, taskName, durationDays, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId, taskName, durationDays, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, parentTaskId, taskName, durationDays, startDate });
    }
    const t1 = await addTask(null, 'งานฐานราก', 10, '2026-08-01');
    const t2 = await addTask(null, 'งานโครงสร้าง', 20, '2026-08-11');
    const t11 = await addTask(t1.id, 'ขุดดิน', 3, '2026-08-01');
    const t12 = await addTask(t1.id, 'เทคอนกรีต', 5, '2026-08-04');
    const t21 = await addTask(t2.id, 'เสา', 8, '2026-08-11');
    const t22 = await addTask(t2.id, 'คาน', 10, '2026-08-19');

    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    const wbsByName = await page.evaluate(() => Object.fromEntries(S.projectTasks.map(t => [t.taskName, t.wbsCode])));
    assert(wbsByName['งานฐานราก'] === '1', `top-level task 1 has wbs_code "1" (got "${wbsByName['งานฐานราก']}")`);
    assert(wbsByName['งานโครงสร้าง'] === '2', `top-level task 2 has wbs_code "2" (got "${wbsByName['งานโครงสร้าง']}")`);
    assert(wbsByName['ขุดดิน'] === '1.1', `child 1.1 wbs_code correct (got "${wbsByName['ขุดดิน']}")`);
    assert(wbsByName['เทคอนกรีต'] === '1.2', `child 1.2 wbs_code correct (got "${wbsByName['เทคอนกรีต']}")`);
    assert(wbsByName['เสา'] === '2.1', `child 2.1 wbs_code correct (got "${wbsByName['เสา']}")`);
    assert(wbsByName['คาน'] === '2.2', `child 2.2 wbs_code correct (got "${wbsByName['คาน']}")`);

    // to_char (not a plain SELECT + .toISOString()) — node-postgres' default DATE type parser
    // returns a local-midnight JS Date, and .toISOString() would shift it back a day in any
    // UTC+ timezone (this machine is UTC+7), which isn't a real bug, just a JS/pg date-parsing trap.
    const dbRow = await pool.query(`SELECT is_milestone, duration_days, to_char(end_date,'YYYY-MM-DD') AS end_date FROM client_project_tasks WHERE id=$1`, [t11.id]);
    assert(dbRow.rows[0].duration_days === 3, 'duration_days persisted correctly (3)');
    assert(dbRow.rows[0].end_date === '2026-08-03', `end_date computed as start+duration-1 calendar days (got ${dbRow.rows[0].end_date}, expected 2026-08-03)`);

    // ---- 3. Edit a task (name/duration/percent_complete) via the real API -> verify persisted.
    await page.evaluate(async ({ pid, taskId, parentTaskId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, {
        taskName: 'ขุดดิน (แก้ไข)', parentTaskId, durationDays: 4, startDate: '2026-08-01', percentComplete: 50, isMilestone: false,
      });
    }, { pid: projectId, taskId: t11.id, parentTaskId: t1.id });
    const editedRow = await pool.query('SELECT task_name, duration_days, percent_complete FROM client_project_tasks WHERE id=$1', [t11.id]);
    assert(editedRow.rows[0].task_name === 'ขุดดิน (แก้ไข)', 'edited task_name persisted');
    assert(editedRow.rows[0].duration_days === 4, 'edited duration_days persisted');
    assert(editedRow.rows[0].percent_complete === 50, 'edited percent_complete persisted');

    // ---- 4. Reorder siblings (t21, t22 under t2) via the reorder endpoint -> sort_order + wbs_code swap.
    await page.evaluate(async ({ pid, order }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/reorder`, { order });
    }, { pid: projectId, order: [{ id: t22.id, sortOrder: 0 }, { id: t21.id, sortOrder: 1 }] });
    const reordered = await pool.query('SELECT id, wbs_code, sort_order FROM client_project_tasks WHERE id IN ($1,$2) ORDER BY sort_order', [t21.id, t22.id]);
    assert(reordered.rows[0].id === t22.id && reordered.rows[0].wbs_code === '2.1', `after reorder, คาน (t22) is now sort_order 0 / wbs_code 2.1 (got id=${reordered.rows[0].id}, wbs=${reordered.rows[0].wbs_code})`);
    assert(reordered.rows[1].id === t21.id && reordered.rows[1].wbs_code === '2.2', `after reorder, เสา (t21) is now sort_order 1 / wbs_code 2.2 (got id=${reordered.rows[1].id}, wbs=${reordered.rows[1].wbs_code})`);

    // ---- 5. Reparent: move t22 (คาน) from under t2 to under t1 -> wbs_code of the whole subtree updates.
    await page.evaluate(async ({ pid, taskId, parentTaskId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'คาน', parentTaskId, durationDays: 10, startDate: '2026-08-19', percentComplete: 0, isMilestone: false });
    }, { pid: projectId, taskId: t22.id, parentTaskId: t1.id });
    const reparented = await pool.query('SELECT parent_task_id, wbs_code FROM client_project_tasks WHERE id=$1', [t22.id]);
    assert(reparented.rows[0].parent_task_id === t1.id, 'คาน (t22) parent_task_id now points at t1');
    assert(reparented.rows[0].wbs_code.startsWith('1.'), `คาน (t22) wbs_code now under the "1." branch (got "${reparented.rows[0].wbs_code}")`);

    // ---- 6. Reject a cyclic reparent (t1 depends-on-itself-as-child-of-its-own-descendant): set t1's
    // parent to t11, which is t1's own child — server must reject with a clear error, not crash.
    const cyclicErr = await page.evaluate(async ({ pid, taskId, parentTaskId }) => {
      try {
        await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'งานฐานราก', parentTaskId, durationDays: 10, startDate: '2026-08-01', percentComplete: 0, isMilestone: false });
        return null;
      } catch (e) { return e.message; }
    }, { pid: projectId, taskId: t1.id, parentTaskId: t11.id });
    assert(!!cyclicErr, `cyclic reparent (t1 -> child of its own descendant t11) is rejected with an error (got: ${cyclicErr})`);

    // ---- 7. Milestone: duration forced to 0, end_date = start_date.
    const milestoneId = await page.evaluate(async ({ pid }) => {
      const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName: 'ส่งมอบงานเฟส 1', durationDays: 5, startDate: '2026-09-01', isMilestone: true });
      return data.task.id;
    }, { pid: projectId });
    const milestoneRow = await pool.query('SELECT duration_days, start_date, end_date FROM client_project_tasks WHERE id=$1', [milestoneId]);
    assert(milestoneRow.rows[0].duration_days === 0, `milestone duration_days forced to 0 (got ${milestoneRow.rows[0].duration_days})`);
    assert(
      milestoneRow.rows[0].start_date.toISOString().slice(0, 10) === milestoneRow.rows[0].end_date.toISOString().slice(0, 10),
      'milestone end_date equals start_date'
    );

    // ---- 8. Dependencies: add, list, self-reference rejected, duplicate rejected, delete.
    const depId = await page.evaluate(async ({ pid, taskId, dependsOnTaskId }) => {
      const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId, dependencyType: 'FS', lagDays: 2 });
      return data.dependency.id;
    }, { pid: projectId, taskId: t2.id, dependsOnTaskId: t1.id });
    assert(!!depId, 'dependency created (งานโครงสร้าง depends on งานฐานราก)');
    const depsList = await page.evaluate(async ({ pid }) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).dependencies, { pid: projectId });
    assert(depsList.some(d => d.id === depId && d.lagDays === 2), 'dependency appears in GET .../tasks with correct lagDays');

    const selfRefErr = await page.evaluate(async ({ pid, taskId }) => {
      try { await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId: taskId, dependencyType: 'FS', lagDays: 0 }); return null; }
      catch (e) { return e.message; }
    }, { pid: projectId, taskId: t1.id });
    assert(!!selfRefErr, `self-reference dependency rejected with a clear error (got: ${selfRefErr})`);

    const dupErr = await page.evaluate(async ({ pid, taskId, dependsOnTaskId }) => {
      try { await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId, dependencyType: 'FS', lagDays: 0 }); return null; }
      catch (e) { return e.message; }
    }, { pid: projectId, taskId: t2.id, dependsOnTaskId: t1.id });
    assert(!!dupErr, `duplicate dependency rejected with a clear error, not a crash (got: ${dupErr})`);

    await page.evaluate(async ({ pid, depId }) => { await apiCall('DELETE', `/api/customer/projects/${pid}/tasks/dependencies/${depId}`); }, { pid: projectId, depId });
    const depsAfterDelete = await page.evaluate(async ({ pid }) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).dependencies, { pid: projectId });
    assert(!depsAfterDelete.some(d => d.id === depId), 'dependency removed after delete');

    // ---- 9. Baseline: set once, verify persisted; set again, verify UPSERT (still 1 row per task).
    await page.evaluate(async ({ pid }) => { await apiCall('POST', `/api/customer/projects/${pid}/tasks/set-baseline`); }, { pid: projectId });
    const baselineCountRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM client_project_task_baseline b JOIN client_project_tasks t ON t.id=b.task_id WHERE t.project_id=$1`,
      [projectId]
    );
    const taskCountRes = await pool.query('SELECT COUNT(*)::int AS n FROM client_project_tasks WHERE project_id=$1', [projectId]);
    assert(baselineCountRes.rows[0].n === taskCountRes.rows[0].n, `baseline set for every task (${baselineCountRes.rows[0].n} baselines == ${taskCountRes.rows[0].n} tasks)`);
    await page.evaluate(async ({ pid }) => { await apiCall('POST', `/api/customer/projects/${pid}/tasks/set-baseline`); }, { pid: projectId });
    const baselineCountRes2 = await pool.query(
      `SELECT COUNT(*)::int AS n FROM client_project_task_baseline b JOIN client_project_tasks t ON t.id=b.task_id WHERE t.project_id=$1`,
      [projectId]
    );
    assert(baselineCountRes2.rows[0].n === taskCountRes.rows[0].n, 'setting baseline a second time UPSERTs (row count unchanged, not doubled)');

    // ---- 10. Delete a summary task (t1, which has children) -> cascade deletes the whole subtree.
    const childIdsBeforeDelete = await pool.query('SELECT id FROM client_project_tasks WHERE parent_task_id=$1', [t1.id]);
    assert(childIdsBeforeDelete.rowCount > 0, 'sanity: t1 has children before delete');
    await page.evaluate(async ({ pid, taskId }) => { await apiCall('DELETE', `/api/customer/projects/${pid}/tasks/${taskId}`); }, { pid: projectId, taskId: t1.id });
    const t1After = await pool.query('SELECT 1 FROM client_project_tasks WHERE id=$1', [t1.id]);
    assert(t1After.rowCount === 0, 'summary task t1 itself deleted');
    const childrenAfter = await pool.query('SELECT 1 FROM client_project_tasks WHERE id = ANY($1::int[])', [childIdsBeforeDelete.rows.map(r => r.id)]);
    assert(childrenAfter.rowCount === 0, 'cascade delete removed all of t1\'s former children too');

    // ---- 11. UI smoke test: reload the schedule page in the browser, confirm it renders the
    // remaining tasks with no console errors (covers the actual pageFinProjectSchedule() render path,
    // not just the API).
    await page.evaluate(() => { S.projectTasksLoaded = false; });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    // t2 ("งานโครงสร้าง") has no source_boq_item_id (created via direct POST, not the BOQ table), so
    // its Name cell renders as an editable <input> — .innerText wouldn't see an input's value (see
    // feedback_playwright_textcontent_inputs memory), so this checks inputValue() instead.
    const remainingTaskName = await page.locator(`#task-name-${t2.id}`).inputValue();
    assert(remainingTaskName === 'งานโครงสร้าง', `schedule page UI renders the remaining top-level task after all the mutations above (got "${remainingTaskName}")`);
    // Chrome logs "Failed to load resource: ... 400/409" as a console error for every non-2xx fetch
    // response, INCLUDING the 3 we deliberately triggered above (cyclic reparent, self-reference,
    // duplicate dependency) and already asserted were caught correctly — that network-status noise
    // isn't a real bug, so it's filtered out here; only genuine JS errors/exceptions fail this check.
    const realErrors = consoleErrors.filter(e => !e.includes('Failed to load resource'));
    assert(!realErrors.length, `no unexpected console/page errors across the entire test (got: ${realErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      // customer_companies cascades to everything else (customers, client_projects,
      // client_project_tasks, client_project_task_dependencies, client_project_task_baseline).
      if (companyId) await pool.query('DELETE FROM customer_companies WHERE id=$1', [companyId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
