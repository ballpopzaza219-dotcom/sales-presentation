// Regression test for the restored reorder (drag, sibling-only) and reparent (explicit modal, Stage B
// item 4, Phase C) UI — pr-system.html's scheduleWbsDragStart()/scheduleWbsDrop() and the "task-reparent"
// modal. Does not re-test wbs_code renumbering/cycle-rejection correctness at the API level —
// project-tasks-crud.regression.js already covers reorder/reparent/cycle-rejection exhaustively via the
// real PUT .../tasks/reorder and PUT .../tasks/:taskId endpoints (see its own header comment). This file
// tests only the UI built on top of that already-correct backend.
//
// Native HTML5 drag-and-drop is a known general flakiness risk under Playwright's synthetic
// dragstart/dragover/drop event dispatch — per the plan this feature was built against, this test
// invokes the same handler functions scheduleWbsDragStart()/scheduleWbsDrop() directly via page.evaluate
// with a constructed DataTransfer-like object, rather than simulating real mouse drag gestures, which
// exercises the exact same code path without that flakiness.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-reorder-reparent.regression.js

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
    const code = 'PRRP' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Reorder Reparent Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Reorder Reparent Test','project-schedule-reorder-reparent-test@example.com','_prrp_test_', $2, 'active')`,
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
    await page.fill('#f-loginUser', '_prrp_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ reorder/reparent UI', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    async function addTask(parentTaskId, taskName, startDate) {
      return page.evaluate(async ({ pid, parentTaskId, taskName, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId, taskName, durationDays: 2, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, parentTaskId, taskName, startDate });
    }
    // Two top-level siblings (t1, t2) + one unrelated 3rd top-level task (t3, parked aside as a
    // different-parent drop target for the rejection check).
    const t1 = await addTask(null, 'พี่น้องที่ 1', '2026-08-01');
    const t2 = await addTask(null, 'พี่น้องที่ 2', '2026-08-03');
    const parent3 = await addTask(null, 'งานหลักอื่น', '2026-08-05');
    const t3 = await addTask(parent3.id, 'ลูกของงานหลักอื่น', '2026-08-05');

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ---- 1. Drag-reorder t2 before t1 (both top-level siblings) -> sort_order swaps via PUT .../reorder.
    await page.evaluate(({ sourceId, targetId }) => {
      const dt = { data: {}, setData(k,v){ this.data[k]=v; }, getData(k){ return this.data[k]; }, effectAllowed:'' };
      scheduleWbsDragStart({ dataTransfer: dt }, sourceId);
      scheduleWbsDrop({ dataTransfer: dt, preventDefault(){} }, targetId);
    }, { sourceId: t2.id, targetId: t1.id });
    await page.waitForTimeout(400);
    const afterReorder = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks, projectId);
    const t1After = afterReorder.find(t=>t.id===t1.id), t2After = afterReorder.find(t=>t.id===t2.id);
    assert(t2After.sortOrder < t1After.sortOrder, `dragging t2 before t1 reordered them via PUT .../reorder (got t2.sortOrder=${t2After.sortOrder}, t1.sortOrder=${t1After.sortOrder})`);
    assert(t1After.wbsCode === '2' && t2After.wbsCode === '1', `wbs_code recomputed to match the new order (got t1="${t1After.wbsCode}", t2="${t2After.wbsCode}")`);

    // ---- 2. Dragging onto a task under a DIFFERENT parent is rejected client-side with a hint toast,
    // and does NOT call the reorder endpoint at all (t3's parent stays parent3, sort_order untouched).
    const t3Before = afterReorder.find(t=>t.id===t3.id);
    await page.evaluate(({ sourceId, targetId }) => {
      const dt = { data: {}, setData(k,v){ this.data[k]=v; }, getData(k){ return this.data[k]; }, effectAllowed:'' };
      scheduleWbsDragStart({ dataTransfer: dt }, sourceId);
      scheduleWbsDrop({ dataTransfer: dt, preventDefault(){} }, targetId);
    }, { sourceId: t1.id, targetId: t3.id });
    await page.waitForTimeout(300);
    const toastType = await page.evaluate(() => S.toast && S.toast.type);
    assert(toastType === 'err', `dragging across different parents shows an error hint instead of silently doing something (got toast type "${toastType}")`);
    const t3AfterRejected = await page.evaluate(async ({ pid, taskId }) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks.find(t=>t.id===taskId), { pid: projectId, taskId: t3Before.id });
    assert(t3AfterRejected.sortOrder === t3Before.sortOrder && t3AfterRejected.parentTaskId === parent3.id, 't3 is completely untouched by the rejected cross-parent drag attempt');

    // ---- 3. Reparent t1 under parent3 via the explicit "ย้าย" modal (not drag) -> parentTaskId changes,
    // wbs_code moves under parent3's branch. confirm-task-reparent resends taskName/durationDays/
    // startDate/percentComplete/isMilestone/actual_* alongside the new parentTaskId (see its own
    // comment: PUT .../tasks/:taskId has no "keep current" fallback for taskName) — it deliberately does
    // NOT send endDate at all, because the server NEVER reads endDate from the request body (confirmed
    // by reading server.js directly: end_date is always recomputed server-side as
    // addCalendarDays(start, duration-1), there is no `endDate` destructured from req.body anywhere on
    // this route). Snapshot every one of those fields in the DB directly BEFORE the reparent and assert
    // byte-identical values AFTER, to prove resending them this way is a true no-op for everything except
    // parent_task_id/wbs_code.
    const t1DbBefore = await pool.query(
      `SELECT to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
              percent_complete, to_char(actual_start_date,'YYYY-MM-DD') AS actual_start_date,
              to_char(actual_end_date,'YYYY-MM-DD') AS actual_end_date, actual_amount, actual_percent
       FROM client_project_tasks WHERE id=$1`, [t1.id]
    );
    await page.click(`[data-act="open-task-reparent"][data-id="${t1.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.selectOption('.modal select', String(parent3.id));
    await page.click('[data-act="confirm-task-reparent"]');
    await page.waitForTimeout(400);
    let allTasks = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks, projectId);
    const t1AfterReparent = allTasks.find(t=>t.id===t1.id);
    assert(t1AfterReparent.parentTaskId === parent3.id, `t1 reparented under parent3 via the modal (got parentTaskId=${t1AfterReparent.parentTaskId})`);
    const parent3AfterReparent = allTasks.find(t=>t.id===parent3.id);
    assert(t1AfterReparent.wbsCode.startsWith(parent3AfterReparent.wbsCode + '.'), `t1's wbs_code now sits under parent3's branch (parent3="${parent3AfterReparent.wbsCode}", t1="${t1AfterReparent.wbsCode}")`);
    const t1DbAfter = await pool.query(
      `SELECT to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
              percent_complete, to_char(actual_start_date,'YYYY-MM-DD') AS actual_start_date,
              to_char(actual_end_date,'YYYY-MM-DD') AS actual_end_date, actual_amount, actual_percent
       FROM client_project_tasks WHERE id=$1`, [t1.id]
    );
    assert(JSON.stringify(t1DbBefore.rows[0]) === JSON.stringify(t1DbAfter.rows[0]), `reparenting t1 left start_date/end_date/percent_complete/actual_* completely unchanged in the DB (before=${JSON.stringify(t1DbBefore.rows[0])}, after=${JSON.stringify(t1DbAfter.rows[0])})`);
    // Modal closes itself on success (unlike the dependencies modal, which stays open) — matches a
    // single-field, single-outcome action rather than a list the user might keep editing.
    assert((await page.evaluate(() => S.modal)) === null, 'reparent modal closes itself after a successful move');

    // ---- 4. Reparenting a task under its own descendant is rejected by the server (isTaskOrDescendant),
    // surfaced as an error, modal stays open (not silently treated as success).
    await page.click(`[data-act="open-task-reparent"][data-id="${parent3.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.selectOption('.modal select', String(t1AfterReparent.id));
    await page.click('[data-act="confirm-task-reparent"]');
    await page.waitForTimeout(400);
    assert((await page.evaluate(() => S.modal && S.modal.type)) === 'task-reparent', 'modal stays open after a rejected cyclic reparent attempt (not treated as success)');
    allTasks = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks, projectId);
    const parent3AfterRejected = allTasks.find(t=>t.id===parent3.id);
    assert(parent3AfterRejected.parentTaskId === null, "parent3's own parent is untouched — the cyclic reparent (making it a child of its own child) was rejected");
    await page.evaluate(() => { S.modal = null; render(); });

    const realErrors = consoleErrors.filter(e => !e.includes('Failed to load resource'));
    assert(!realErrors.length, `no unexpected console/page errors across the entire test (got: ${realErrors.join(' | ')})`);
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
