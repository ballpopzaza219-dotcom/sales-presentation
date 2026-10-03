// Regression test for the restored Gantt bar view (Stage B item 4, Phase B) — pr-system.html's
// renderGanttSection()/scheduleGanttBarGeometry() + the S.scheduleViewMode toggle. Does NOT re-test CPM/
// dependency/cycle-rejection correctness — project-tasks-cpm.regression.js already covers that at the API
// level. This file tests only the restored UI: the #gantt-section itself, bar positioning, the
// unscheduled-task placeholder, and the table/gantt/both view-mode toggle.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-gantt-bars.regression.js

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
    const code = 'PGNT' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Gantt Bars Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Gantt Bars Test','project-schedule-gantt-bars-test@example.com','_pgnt_test_', $2, 'active')`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pgnt_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ Gantt bars', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // ---- Setup: 1 scheduled task (10 days from 2026-08-01) + 1 UNSCHEDULED task (no startDate).
    async function addTask(parentTaskId, taskName, durationDays, startDate) {
      return page.evaluate(async ({ pid, parentTaskId, taskName, durationDays, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId, taskName, durationDays, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, parentTaskId, taskName, durationDays, startDate });
    }
    const tScheduled = await addTask(null, 'งานมีกำหนดการ', 10, '2026-08-01');
    const tUnscheduled = await addTask(null, 'งานยังไม่กำหนดวัน', 5, null);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(150);

    // ---- 1. Default view mode is 'both' — both sections render together.
    assert((await page.locator('#task-table-section').count()) === 1, `view mode defaults to 'both': %-grid table renders`);
    assert((await page.locator('#gantt-section').count()) === 1, `view mode defaults to 'both': Gantt section renders too`);

    // ---- 2. Exactly 1 bar (the scheduled task) and 1 "no dates" placeholder (the unscheduled task).
    assert((await page.locator('#gantt-section [data-gantt-bar]').count()) === 1, 'exactly 1 Gantt bar renders (only the scheduled task has dates)');
    assert((await page.locator('#gantt-section .gantt-row-noDates').count()) === 1, 'exactly 1 "no dates" placeholder renders (the unscheduled task)');

    // ---- 3. Bar geometry: at zoom='day' (colWidth=28), the scheduled task starts on the very first
    // column of the displayed range (its own earliest date) -> leftPx should be 2 (0*28+2), and its width
    // should span all 10 days minus the 4px gutter (10*28-4=276).
    const barStyle = await page.locator('#gantt-section [data-gantt-bar]').first().evaluate(el => ({ left: el.style.left, width: el.style.width }));
    assert(barStyle.left === '2px', `bar starts at the leftmost column (leftPx=2, got "${barStyle.left}")`);
    assert(barStyle.width === '276px', `bar spans all 10 days at colWidth=28 (10*28-4=276, got "${barStyle.width}")`);

    // ---- 4. Row order/content: the Gantt section's own name cells list both tasks (read via the task's
    // title attribute on the row's name span, since names there are plain read-only text, not an input).
    const ganttRowNames = await page.locator('#gantt-section tr.gantt-row td.sched-col-name span[title]').allInnerTexts();
    assert(ganttRowNames.includes('งานมีกำหนดการ') && ganttRowNames.includes('งานยังไม่กำหนดวัน'), `both tasks' names render in the Gantt pane (got ${JSON.stringify(ganttRowNames)})`);

    // ---- 5. View-mode toggle: switching to 'table' removes #gantt-section entirely (not just hides it);
    // switching to 'gantt' removes #task-table-section entirely.
    await page.click('[data-act="set-schedule-view-mode"][data-mode="table"]');
    await page.waitForTimeout(150);
    assert((await page.locator('#task-table-section').count()) === 1, `view_mode='table': %-grid table still renders`);
    assert((await page.locator('#gantt-section').count()) === 0, `view_mode='table': Gantt section is removed from the DOM entirely`);

    await page.click('[data-act="set-schedule-view-mode"][data-mode="gantt"]');
    await page.waitForTimeout(150);
    assert((await page.locator('#gantt-section').count()) === 1, `view_mode='gantt': Gantt section renders`);
    assert((await page.locator('#task-table-section').count()) === 0, `view_mode='gantt': %-grid table is removed from the DOM entirely`);

    await page.click('[data-act="set-schedule-view-mode"][data-mode="both"]');
    await page.waitForTimeout(150);
    assert((await page.locator('#task-table-section').count()) === 1 && (await page.locator('#gantt-section').count()) === 1, `view_mode='both': both sections render again`);

    // ---- 6. #gantt-section is excluded from print (deliberately deferred to Phase E — see its own
    // header comment in pr-system.html) — it must carry the .no-print class.
    assert((await page.locator('#gantt-section.no-print').count()) === 1, '#gantt-section carries .no-print (print-engine integration deferred to Phase E)');

    assert(!consoleErrors.length, `no unexpected console/page errors across the entire test (got: ${consoleErrors.join(' | ')})`);
    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (companyId) {
      await pool.query(`DELETE FROM client_document_audit_log WHERE performed_by IN (SELECT id FROM customers WHERE company_id=$1)`, [companyId]);
      if (projectId) {
        await pool.query(`DELETE FROM client_project_tasks WHERE project_id=$1`, [projectId]);
        await pool.query(`DELETE FROM client_projects WHERE id=$1`, [projectId]);
      }
      await pool.query(`DELETE FROM customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM client_customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [companyId]);
    }
    await pool.end();
  }
})();
