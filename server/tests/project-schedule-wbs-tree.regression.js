// Regression test for the restored WBS tree decoration on the แผนงาน %-grid table (Stage B item 4,
// Phase A) — pr-system.html's scheduleBuildWbsRows()/savedRowHtml() indent+WBS-code+collapse/expand
// chevron added to #task-table-section's existing rows. Does NOT re-test wbs_code numbering/reparent/
// reorder/cycle-rejection correctness at the API level — project-tasks-crud.regression.js already covers
// all of that exhaustively and correctly (see its own header comment). This file tests only the UI built
// on top of that already-correct backend: indentation, inline WBS-code display, and collapse/expand.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-wbs-tree.regression.js

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
  let companyId = null, projectId = null, projectId2 = null, browser;
  try {
    const code = 'PWBS' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule WBS Tree Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'WBS Tree Test','project-schedule-wbs-tree-test@example.com','_pwbs_test_', $2, 'active')`,
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
    await page.fill('#f-loginUser', '_pwbs_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ WBS tree', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // ---- Setup: 1 top-level summary task (งานฐานราก) with 2 children (ขุดดิน/เทคอนกรีต), plus 1
    // unrelated top-level leaf task (งานโครงสร้าง) with no children — same tree shape style as
    // project-tasks-crud.regression.js, via the real API (not the UI) so this file's own setup stays
    // fast and focused only on verifying what renders from it.
    async function addTask(parentTaskId, taskName, durationDays, startDate) {
      return page.evaluate(async ({ pid, parentTaskId, taskName, durationDays, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId, taskName, durationDays, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, parentTaskId, taskName, durationDays, startDate });
    }
    const t1 = await addTask(null, 'งานฐานราก', 10, '2026-08-01');
    const t2 = await addTask(null, 'งานโครงสร้าง', 5, '2026-08-11');
    const t11 = await addTask(t1.id, 'ขุดดิน', 3, '2026-08-01');
    const t12 = await addTask(t1.id, 'เทคอนกรีต', 5, '2026-08-04');

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ---- 1. First load defaults every summary task to EXPANDED — all 4 tasks' rows visible (2 <tr>
    // each: PLAN+ACTUAL), so 8 .sched-task-row elements total.
    assert((await page.locator('#task-table-section tr.sched-task-row').count()) === 8, 'all 4 tasks visible by default (8 PLAN+ACTUAL rows) — summary task starts expanded');

    // ---- 2. WBS code renders inline in the name cell for every task, matching the server-computed value.
    // Task names render as <input value="..."> (not from BOQ, see savedRowHtml()'s nameInner), so the
    // input's VALUE is not part of the cell's innerText — read the WBS-code span scoped to each task's
    // own row (found via its #task-name-{id} input) instead of searching combined cell text.
    async function wbsCodeFor(taskId) {
      return page.locator(`#task-name-${taskId}`).locator('xpath=ancestor::td[contains(@class,"sched-col-name")]').locator('span.mono').first().innerText();
    }
    assert((await wbsCodeFor(t1.id)).trim() === '1', `top-level task งานฐานราก shows WBS code "1" (got "${(await wbsCodeFor(t1.id)).trim()}")`);
    assert((await wbsCodeFor(t2.id)).trim() === '2', `top-level task งานโครงสร้าง shows WBS code "2" (got "${(await wbsCodeFor(t2.id)).trim()}")`);
    assert((await wbsCodeFor(t11.id)).trim() === '1.1', `child task ขุดดิน shows WBS code "1.1" (got "${(await wbsCodeFor(t11.id)).trim()}")`);
    assert((await wbsCodeFor(t12.id)).trim() === '1.2', `child task เทคอนกรีต shows WBS code "1.2" (got "${(await wbsCodeFor(t12.id)).trim()}")`);

    // ---- 3. The summary task (งานฐานราก, has children) gets a collapse/expand chevron button; the leaf
    // tasks (children + งานโครงสร้าง) do not.
    assert((await page.locator(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t1.id}"]`).count()) === 1, 'summary task (has children) has an expand/collapse chevron');
    assert((await page.locator(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t11.id}"]`).count()) === 0, 'leaf child task has no chevron');
    assert((await page.locator(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t2.id}"]`).count()) === 0, 'leaf top-level task (no children) has no chevron');

    // ---- 4. Indentation: child rows' name-cell inner wrapper has a non-zero padding-left; top-level
    // rows' wrapper has padding-left:0.
    const t1Indent = await page.evaluate((id) => {
      const btn = document.querySelector(`[data-act="toggle-schedule-task-expand"][data-id="${id}"]`);
      return btn ? btn.closest('div').style.paddingLeft : null;
    }, t1.id);
    assert(t1Indent === '0px', `top-level task's name wrapper has zero indent (got "${t1Indent}")`);
    const t11Indent = await page.locator(`#task-name-${t11.id}`).locator('xpath=ancestor::div[1]').evaluate(el => el.style.paddingLeft);
    assert(t11Indent === '16px', `depth-1 child task's name wrapper is indented by 16px (got "${t11Indent}")`);

    // ---- 5. Collapsing the summary task hides its 2 children's rows (4 <tr>, 2 each) but keeps the
    // summary task itself and the unrelated top-level task visible.
    await page.click(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t1.id}"]`);
    await page.waitForTimeout(150);
    assert((await page.locator('#task-table-section tr.sched-task-row').count()) === 4, 'collapsing the summary task hides its 2 children (4 rows left: t1 + t2, PLAN+ACTUAL each)');
    assert((await page.locator(`#task-name-${t1.id}`).count()) === 1, 'collapsed summary task itself is still visible');
    assert((await page.locator(`#task-name-${t11.id}`).count()) === 0, 'collapsed child task (ขุดดิน) is no longer in the DOM');

    // ---- 6. Expanding again restores the children.
    await page.click(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t1.id}"]`);
    await page.waitForTimeout(150);
    assert((await page.locator('#task-table-section tr.sched-task-row').count()) === 8, 'expanding again restores all 8 rows');

    // ---- 7. Collapse state survives an UNRELATED save (editing a sibling task's duration and saving the
    // table) — loadProjectTasks()'s reconciliation must not blanket-reset S.scheduleExpandedTaskIds.
    await page.click(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${t1.id}"]`);
    await page.waitForTimeout(150);
    await page.fill(`#task-duration-${t2.id}`, '7');
    await page.locator(`#task-duration-${t2.id}`).dispatchEvent('change');
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);
    assert((await page.locator('#task-table-section tr.sched-task-row').count()) === 4, 'collapsed state for t1 survives saving an unrelated edit to a sibling task');

    // ---- 8. Switching to a DIFFERENT project's schedule page (without a full page reload) must re-default
    // to all-expanded for the new project, not reconcile its summary tasks against project 1's leftover
    // collapsed-id Set (none of project 2's task ids would ever match project 1's, so a naive reconcile
    // would silently drop them all and leave project 2 looking fully collapsed on first view).
    projectId2 = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ 2' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ WBS tree โครงการที่ 2', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });
    const p2Parent = await page.evaluate(async ({ pid }) => {
      const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName: 'งานหลักโครงการ 2', durationDays: 5, startDate: '2026-09-01', isMilestone: false });
      return data.task;
    }, { pid: projectId2 });
    const p2Child = await page.evaluate(async ({ pid, parentTaskId }) => {
      const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId, taskName: 'งานย่อยโครงการ 2', durationDays: 2, startDate: '2026-09-01', isMilestone: false });
      return data.task;
    }, { pid: projectId2, parentTaskId: p2Parent.id });
    // Navigate the same way the app's own "ดูแผนงาน"/breadcrumb links do: set S.selectedProjectId and
    // re-run the page's own loader, WITHOUT a page.goto() reload — this is the exact scenario the bug
    // required (switching projects within the same page-load, not starting a fresh browser session).
    await page.evaluate((pid) => { S.selectedProjectId = pid; render(); }, projectId2);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId2);
    await page.waitForTimeout(300);
    assert((await page.locator(`#task-name-${p2Child.id}`).count()) === 1, `project 2's summary task auto-expands on first view even though project 1's Set was non-null and project-1-scoped (its child task is visible)`);
    assert((await page.locator(`#task-table-section [data-act="toggle-schedule-task-expand"][data-id="${p2Parent.id}"]`).count()) === 1, `project 2's summary task still gets its own chevron`);

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
      if (projectId2) {
        await pool.query(`DELETE FROM client_project_tasks WHERE project_id=$1`, [projectId2]);
        await pool.query(`DELETE FROM client_projects WHERE id=$1`, [projectId2]);
      }
      await pool.query(`DELETE FROM customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM client_customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [companyId]);
    }
    await pool.end();
  }
})();
