// Regression test for แผนงาน (Gantt) Phase 2 — Critical Path Method (CPM) + auto-schedule cascade
// + real circular-dependency detection (see computeProjectSchedule/applyAutoSchedule/
// wouldCreateCycle in server.js, and the "แผนงาน (Gantt) — เฟส 2" plan for the exact forward/
// backward-pass formulas this test's expected dates are derived from). Phase 2 only: no Gantt
// chart visual yet (Phase 3).
//
// Brand new company/customer fixture, same pattern as project-tasks-crud.regression.js (Phase 1).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-tasks-cpm.regression.js

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
    const code = 'PCPM' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Tasks CPM Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Project Tasks CPM Test','project-tasks-cpm-test@example.com','_project_tasks_cpm_test_', $2, 'active')`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_project_tasks_cpm_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ CPM', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    async function addTask(taskName, durationDays, startDate) {
      return page.evaluate(async ({ pid, taskName, durationDays, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName, durationDays, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, taskName, durationDays, startDate });
    }
    async function addDep(taskId, dependsOnTaskId, dependencyType, lagDays) {
      return page.evaluate(async ({ pid, taskId, dependsOnTaskId, dependencyType, lagDays }) => {
        try { await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId, dependencyType, lagDays }); return null; }
        catch (e) { return e.message; }
      }, { pid: projectId, taskId, dependsOnTaskId, dependencyType, lagDays });
    }
    async function getTasks() {
      return page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks, projectId);
    }
    async function byName(name) {
      const tasks = await getTasks();
      return tasks.find(t => t.taskName === name);
    }

    // ---- 1. Simple FS chain: A(5d, anchored 2026-08-01) -> B(3d) -> C(4d), no lag.
    // A: 2026-08-01 .. 2026-08-05 (5 days). Exclusive finish = dayNum(08-01)+5 = dayNum(08-06).
    // B.ES = A's exclusive finish = 2026-08-06 -> B: 2026-08-06 .. 2026-08-08 (3 days).
    // C.ES = B's exclusive finish (dayNum(08-06)+3 = dayNum(08-09)) -> C: 2026-08-09 .. 2026-08-12 (4 days).
    const a = await addTask('A', 5, '2026-08-01');
    const b = await addTask('B', 3, null);
    const c = await addTask('C', 4, null);
    assert((await addDep(b.id, a.id, 'FS', 0)) === null, 'B depends on A (FS, lag 0) created');
    assert((await addDep(c.id, b.id, 'FS', 0)) === null, 'C depends on B (FS, lag 0) created');

    let bAfter = await byName('B'), cAfter = await byName('C');
    assert(bAfter.startDate === '2026-08-06' && bAfter.endDate === '2026-08-08', `B auto-scheduled right after A (got ${bAfter.startDate}..${bAfter.endDate})`);
    assert(cAfter.startDate === '2026-08-09' && cAfter.endDate === '2026-08-12', `C auto-scheduled right after B (got ${cAfter.startDate}..${cAfter.endDate})`);

    // ---- 2. Parallel shorter task D (also depends on A, FS lag 0, but only 1 day and no successor
    // of its own) -> critical path is still A->B->C (the longer chain); D has slack, isn't critical.
    const d = await addTask('D', 1, null);
    assert((await addDep(d.id, a.id, 'FS', 0)) === null, 'D depends on A too (parallel branch)');
    let [aAfter, dAfter] = [await byName('A'), await byName('D')];
    assert(dAfter.startDate === '2026-08-06', `D starts right after A, same as B (got ${dAfter.startDate})`);
    assert(aAfter.isCritical === true, 'A is on the critical path (float 0)');
    bAfter = await byName('B'); cAfter = await byName('C');
    assert(bAfter.isCritical === true && cAfter.isCritical === true, 'B and C are still on the critical path');
    assert(dAfter.isCritical === false && dAfter.totalFloat > 0, `D (the short parallel branch) is NOT critical and has positive float (got isCritical=${dAfter.isCritical}, totalFloat=${dAfter.totalFloat})`);

    // ---- 3. Lag: E depends on A (FS, lag=3) -> E.ES = A's exclusive finish (08-06) + 3 = 2026-08-09.
    const e = await addTask('E', 2, null);
    assert((await addDep(e.id, a.id, 'FS', 3)) === null, 'E depends on A with lag=3');
    const eAfter = await byName('E');
    assert(eAfter.startDate === '2026-08-09', `lag_days shifts the successor's start correctly (got ${eAfter.startDate}, expected 2026-08-09)`);

    // ---- 4. SS: F depends on A (SS, lag=1) -> F.ES = A.ES + 1 = 2026-08-02.
    const f = await addTask('F', 2, null);
    assert((await addDep(f.id, a.id, 'SS', 1)) === null, 'F depends on A via SS lag=1');
    const fAfter = await byName('F');
    assert(fAfter.startDate === '2026-08-02', `SS: successor starts lag days after predecessor STARTS, not finishes (got ${fAfter.startDate}, expected 2026-08-02)`);

    // ---- 5. FF: G (2d) depends on A (FF, lag=0) -> G.EF = A.EF -> G.ES = A's excl. finish(08-06) - 2 = 2026-08-04.
    const g = await addTask('G', 2, null);
    assert((await addDep(g.id, a.id, 'FF', 0)) === null, 'G depends on A via FF lag=0');
    const gAfter = await byName('G');
    assert(gAfter.startDate === '2026-08-04', `FF: successor finishes together with predecessor (got start ${gAfter.startDate}, expected 2026-08-04 so a 2-day task ends 08-05, same day A ends)`);

    // ---- 6. SF: H (3d) depends on A (SF, lag=0) -> H.EF = A.ES -> H.ES = dayNum(08-01) - 3 = 2026-07-29.
    const h = await addTask('H', 3, null);
    assert((await addDep(h.id, a.id, 'SF', 0)) === null, 'H depends on A via SF lag=0');
    const hAfter = await byName('H');
    assert(hAfter.startDate === '2026-07-29', `SF: successor finishes when predecessor STARTS (got ${hAfter.startDate}, expected 2026-07-29)`);

    // ---- 7. Cascade: editing A's duration shifts the whole dependent chain automatically.
    await page.evaluate(async ({ pid, taskId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'A', parentTaskId: null, durationDays: 7, startDate: '2026-08-01', percentComplete: 0, isMilestone: false });
    }, { pid: projectId, taskId: a.id });
    // A now 2026-08-01..08-07 (7 days), excl finish = dayNum(08-01)+7 = dayNum(08-08).
    bAfter = await byName('B');
    assert(bAfter.startDate === '2026-08-08', `editing A's duration cascades B's start automatically (got ${bAfter.startDate}, expected 2026-08-08)`);

    // ---- 8. Circular dependency rejected: A currently (transitively) precedes C (A->B->C). Trying
    // to make A depend on C would close the loop A->C->...->A.
    const cyclicErr = await addDep(a.id, c.id, 'FS', 0);
    assert(!!cyclicErr, `A depends_on C is rejected as circular (A already transitively precedes C) — got: ${cyclicErr}`);
    const depsAfterCyclicAttempt = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).dependencies, projectId);
    assert(!depsAfterCyclicAttempt.some(dep => dep.taskId === a.id && dep.dependsOnTaskId === c.id), 'the rejected cyclic dependency was never written to the DB');

    // ---- 9. Removing B's only predecessor (A) un-schedules B — no stale frozen date left behind —
    // which in turn un-schedules C too, since C's only predecessor (B) is now itself unscheduled.
    const depsNow = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).dependencies, projectId);
    const bDependsOnA = depsNow.find(dep => dep.taskId === b.id && dep.dependsOnTaskId === a.id);
    await page.evaluate(async ({ pid, depId }) => { await apiCall('DELETE', `/api/customer/projects/${pid}/tasks/dependencies/${depId}`); }, { pid: projectId, depId: bDependsOnA.id });
    bAfter = await byName('B'); cAfter = await byName('C');
    assert(bAfter.startDate === null && bAfter.endDate === null, `B (lost its only predecessor) is un-scheduled, not left with a stale frozen date (got start=${bAfter.startDate}, end=${bAfter.endDate})`);
    assert(bAfter.earlyStart === null && bAfter.totalFloat === null && bAfter.isCritical === false, 'B has no CPM data (null ES/float, not critical) once unscheduled');
    assert(cAfter.startDate === null, `C (whose only predecessor B just became unscheduled) also becomes unscheduled, propagating forward (got ${cAfter.startDate})`);

    // ---- 10. A totally independent task with no predecessor and no start_date ever set: fully
    // unscheduled, no error, not critical.
    const i = await addTask('I (ไม่มีวันเริ่ม ไม่มี predecessor)', 5, null);
    const iAfter = await byName('I (ไม่มีวันเริ่ม ไม่มี predecessor)');
    assert(iAfter.startDate === null && iAfter.earlyStart === null && iAfter.totalFloat === null && iAfter.isCritical === false, `a root task with no start_date is fully unscheduled, no crash (got ${JSON.stringify(iAfter)})`);
    assert(i.id === iAfter.id, 'sanity: fetched the right task');

    // ---- 11. UI smoke test: reload the schedule page for real, confirm it renders without error.
    // The CPM fields asserted above (earlyStart/totalFloat/isCritical) are still computed and returned
    // by GET .../tasks — applyAutoSchedule/computeProjectSchedule are untouched — but as of the
    // S-curve-style table rewrite (2026-07-26) this page no longer displays a Total Float column or
    // "Critical" badge anywhere; CPM stays a backend-only capability for now (reachable directly via
    // the API this whole test already exercises above), not a one-way door if it's wanted back in the
    // UI later.
    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(400);
    assert((await page.locator('#task-table-section').count()) === 1, 'task table section renders after reload with real CPM-scheduled data');
    // Task names here are free-text (no source_boq_item_id), so they render as <input value="..."> —
    // .innerText never sees an input's value, only real text nodes (see
    // feedback_playwright_textcontent_inputs memory) — inputValue() is the correct check.
    assert((await page.locator(`#task-name-${a.id}`).inputValue()) === 'A', 'task A\'s name still renders correctly in the table after reload');
    const realErrors = consoleErrors.filter(err => !err.includes('Failed to load resource'));
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
