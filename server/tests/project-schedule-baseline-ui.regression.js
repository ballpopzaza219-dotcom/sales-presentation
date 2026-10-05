// Regression test for the restored baseline comparison (Stage B item 4, Phase D) — the "ตั้งไลน์ฐาน"
// toolbar button + confirm modal, POST .../tasks/set-baseline, and the dashed ghost-outline bar in
// #gantt-section. Does not re-test the backend's upsert/overwrite semantics at the SQL level (that's
// server.js's own job, already correct) — this file checks only the UI built on top of it.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-baseline-ui.regression.js

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
    const code = 'PBLU' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Baseline UI Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Baseline UI Test','project-schedule-baseline-ui-test@example.com','_pblu_test_', $2, 'active')`,
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
    await page.fill('#f-loginUser', '_pblu_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ baseline UI', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    const task = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName: 'งานทดสอบ baseline', durationDays: 5, startDate: '2026-08-01', isMilestone: false });
      return data.task;
    }, projectId);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(150);

    // ---- 1. Before any baseline is set, no ghost bar renders.
    assert((await page.locator('#gantt-section .gantt-baseline-ghost').count()) === 0, 'no baseline ghost bar before any baseline has been set');

    // ---- 2. Clicking "ตั้งไลน์ฐาน" opens a confirm modal with real (not raw-key) warning text.
    await page.click('[data-act="open-set-baseline-confirm"]');
    await page.waitForSelector('.modal[data-stop="1"]');
    const modalBody = await page.locator('.modal[data-stop="1"]').innerText();
    assert(!modalBody.includes('fin_project_schedule.'), `modal renders real translated text, not a raw locale key leak (got: ${modalBody.slice(0, 80)}...)`);
    assert(modalBody.includes('ไลน์ฐาน'), 'modal warning text mentions ไลน์ฐาน (baseline)');

    // ---- 3. Confirming calls the backend and reloads — a ghost bar now appears, matching the task's
    // CURRENT dates (baseline == current, since nothing has moved yet).
    await page.click('[data-act="confirm-set-schedule-baseline"]');
    await page.waitForTimeout(500);
    assert((await page.locator('#gantt-section .gantt-baseline-ghost').count()) === 1, 'baseline ghost bar appears after confirming set-baseline');
    const dbBaseline = await pool.query(`SELECT to_char(baseline_start,'YYYY-MM-DD') AS s, to_char(baseline_end,'YYYY-MM-DD') AS e FROM client_project_task_baseline WHERE task_id=$1`, [task.id]);
    assert(dbBaseline.rows[0].s === '2026-08-01' && dbBaseline.rows[0].e === '2026-08-05', `baseline persisted with the task's current dates (got ${JSON.stringify(dbBaseline.rows[0])})`);

    // ---- 4. Move the task's dates (via the real edit API, not the UI), reload — the ghost bar must stay
    // at the OLD (frozen baseline) position while the real bar moves to the NEW position; they must now
    // differ in left-offset (this is the entire point of a baseline comparison).
    await page.evaluate(async ({ pid, taskId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'งานทดสอบ baseline', durationDays: 5, startDate: '2026-08-10', percentComplete: 0, isMilestone: false });
    }, { pid: projectId, taskId: task.id });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const ghostLeft = await page.locator('#gantt-section .gantt-baseline-ghost').evaluate(el => el.style.left);
    const barLeft = await page.locator('#gantt-section [data-gantt-bar]').first().evaluate(el => el.style.left);
    assert(ghostLeft !== barLeft, `after moving the task's dates, the baseline ghost (frozen at the old position) and the real bar (at the new position) no longer coincide (ghost=${ghostLeft}, bar=${barLeft})`);

    // ---- 5. Setting the baseline a second time OVERWRITES it (upsert, not history) — ghost should now
    // match the task's NEW (moved) dates, confirming the backend's documented overwrite-only semantics.
    await page.click('[data-act="open-set-baseline-confirm"]');
    await page.click('[data-act="confirm-set-schedule-baseline"]');
    await page.waitForTimeout(500);
    const dbBaseline2 = await pool.query(`SELECT to_char(baseline_start,'YYYY-MM-DD') AS s FROM client_project_task_baseline WHERE task_id=$1`, [task.id]);
    assert(dbBaseline2.rows[0].s === '2026-08-10', `re-setting the baseline overwrites the old one with the task's new current date (got ${dbBaseline2.rows[0].s})`);

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
        await pool.query(`DELETE FROM client_project_task_baseline WHERE task_id IN (SELECT id FROM client_project_tasks WHERE project_id=$1)`, [projectId]);
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
