// Regression test for the restored critical-path styling (Stage B item 4, Phase D) — the "วิกฤต" badge +
// red left-border accent on #task-table-section's name cell, and the red bar fill in #gantt-section.
// Reuses the EXACT A->B->C (critical) / D (parallel, non-critical) fixture shape from
// project-tasks-cpm.regression.js (see its own comments for the full CPM date-math derivation) — that
// file already proves isCritical/totalFloat are computed correctly at the API level; this file only
// checks that the already-correct isCritical flag is rendered correctly in the UI.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-critical-path-ui.regression.js

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
    const code = 'PCPU' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Critical Path UI Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Critical Path UI Test','project-schedule-critical-path-ui-test@example.com','_pcpu_test_', $2, 'active')`,
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
    await page.fill('#f-loginUser', '_pcpu_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ critical path UI', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // ---- Setup: A(5d,2026-08-01) -> B(3d) -> C(4d) critical chain; D(1d) parallel branch off A, not
    // critical (same shape as project-tasks-cpm.regression.js's steps 1-2).
    async function addTask(taskName, durationDays, startDate) {
      return page.evaluate(async ({ pid, taskName, durationDays, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName, durationDays, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, taskName, durationDays, startDate });
    }
    async function addDep(taskId, dependsOnTaskId) {
      return page.evaluate(async ({ pid, taskId, dependsOnTaskId }) => {
        await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId, dependencyType: 'FS', lagDays: 0 });
      }, { pid: projectId, taskId, dependsOnTaskId });
    }
    const a = await addTask('A', 5, '2026-08-01');
    const b = await addTask('B', 3, null);
    const c = await addTask('C', 4, null);
    const d = await addTask('D', 1, null);
    await addDep(b.id, a.id);
    await addDep(c.id, b.id);
    await addDep(d.id, a.id);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(150);

    // ---- 1. %-grid table: A/B/C get the "วิกฤต" badge + red left-border accent on the name cell; D does not.
    async function nameTdFor(taskId) {
      return page.locator(`#task-name-${taskId}`).locator('xpath=ancestor::td[contains(@class,"sched-col-name")]');
    }
    for (const t of [a, b, c]) {
      const td = await nameTdFor(t.id);
      assert((await td.locator('.badge-rejected').count()) === 1, `task ${t.id} (on critical path) shows the วิกฤต badge in the %-grid table`);
      const borderLeft = await td.evaluate(el => getComputedStyle(el).borderLeftColor);
      assert(borderLeft !== 'rgba(0, 0, 0, 0)' && borderLeft !== 'transparent', `task ${t.id}'s name cell has a non-transparent left border accent (got "${borderLeft}")`);
    }
    const dTd = await nameTdFor(d.id);
    assert((await dTd.locator('.badge-rejected').count()) === 0, 'task D (NOT on critical path) shows no วิกฤต badge');

    // ---- 2. Gantt section: A/B/C bars carry the .critical class (red fill); D's bar does not. Each
    // task's Gantt row is found via its name's title attribute (plain read-only text there, not an input).
    async function ganttBarClassFor(taskName) {
      return page.locator(`#gantt-section tr.gantt-row:has(span[title="${taskName}"]) [data-gantt-bar]`).first().getAttribute('class');
    }
    assert((await ganttBarClassFor('A')).includes('critical'), 'Gantt bar for A (critical) has the .critical class');
    assert((await ganttBarClassFor('B')).includes('critical'), 'Gantt bar for B (critical) has the .critical class');
    assert((await ganttBarClassFor('C')).includes('critical'), 'Gantt bar for C (critical) has the .critical class');
    assert(!(await ganttBarClassFor('D')).includes('critical'), 'Gantt bar for D (NOT critical) does not have the .critical class');

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
