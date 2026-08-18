// Regression test for the "ดึงรายการ BOQ ทั้งหมด" (pull-all) task table on แผนงาน —
// pr-system.html's renderProjectScheduleTable() + pull-all-boq-items action + GET
// .../available-boq-items-for-task + POST .../tasks/batch in server.js.
//
// 2026-07-26, rewritten again for the S-curve-style table (No./รายละเอียดงาน/ระยะเวลา/วันเริ่ม/
// วันเสร็จ/งบประมาณ บาท+%) that replaced the old MS-Project-style WBS/Gantt-chart view outright — no
// WBS column exists in this UI anymore, so this test no longer asserts on it. See
// project_gantt_task_boq_batch.md memory for the earlier history (free-text modal -> BOQ-dropdown
// modal -> inline table with per-row dropdown -> inline table with pull-all -> this S-curve table).
//
// Covers: no modal anywhere, no-approved-BOQ toast+hint (not a hard error), pulling 10 real items
// (group/summary row excluded) in one click, clicking pull again without saving doesn't duplicate rows,
// saving persists all 10 with correct source_boq_item_id links, and a SECOND pull after a new item gets
// approved only adds that one new item (not re-pulling the already-saved 10).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-tasks-boq-batch.regression.js

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
    const code = 'PTBQ' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Tasks BOQ Pull-All Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      // can_approve_budget:true so this same fixture user can also approve its own budget below.
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'BOQ Pull-All Test','project-tasks-boq-pullall-test@example.com','_ptbqpull_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept()); // delete-task uses confirm()

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_ptbqpull_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ BOQ→Task (ดึงทั้งหมด)', clientName: '', tenderId: null, siteAddress: '',
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

    // ---- 0. No modal anywhere on this page.
    assert((await page.locator('[data-act="open-add-task"]').count()) === 0, 'no "+ เพิ่ม Task" modal button exists');
    assert((await page.locator('.modal-overlay').count()) === 0, 'no modal is open by default');
    assert((await page.locator('[data-act="pull-all-boq-items"]').count()) === 1, '"ดึงรายการ BOQ ทั้งหมด" button is present');

    // ---- 1. No budget at all yet -> clicking pull shows a clear toast, not a hard error, and adds
    // nothing.
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    let toastMsg = await page.evaluate(() => S.toast && S.toast.msg);
    assert(toastMsg === 'ไม่มีรายการ BOQ ที่อนุมัติแล้วเหลือให้ดึงเพิ่ม', `clicking pull with no approved budget shows the clear "nothing to pull" toast, not an error (got: ${toastMsg})`);
    assert((await page.evaluate(() => S.taskTableNewRows.length)) === 0, 'no rows added when there is nothing to pull');
    assert(!consoleErrors.length, `no console/page errors from clicking pull with nothing available (got: ${consoleErrors.join(' | ')})`);

    // ---- 2. Create a project budget: 1 group/header row + 10 real line items, approve it.
    budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    const itemDefs = Array.from({ length: 10 }, (_, i) => ({
      workCode: `A-${i + 1}`, description: `งานที่ ${i + 1}`, unit: 'งาน', qty: 1, materialUnitPrice: 1000 * (i + 1), laborUnitPrice: 500,
    }));
    await page.evaluate(async ({ bid, itemDefs }) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [{ description: 'หมวดงานโครงสร้าง', isGroup: true }, ...itemDefs],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, { bid: budgetId, itemDefs });

    const itemsRow = await pool.query(
      `SELECT bi.id, bi.work_code, bi.description, bi.is_group, bi.amount FROM client_budget_items bi
       JOIN client_budget_revisions br ON br.id = bi.revision_id
       WHERE br.budget_id=$1 ORDER BY bi.idx`,
      [budgetId]
    );
    assert(itemsRow.rowCount === 11, `budget has 11 items — 1 group + 10 real (got ${itemsRow.rowCount})`);
    const groupItem = itemsRow.rows.find(r => r.is_group);
    const realItems = itemsRow.rows.filter(r => !r.is_group);
    assert(!!groupItem && realItems.length === 10, 'sanity: 1 group row + 10 real items');

    // ---- 3. Click "ดึงรายการ BOQ ทั้งหมด" -> all 10 real items become new rows immediately, the
    // group row is never among them, Task Name + budgetAmount (snapshot of bi.amount) are pre-filled
    // from the BOQ item (no WBS column in this UI — see the S-curve-table rewrite).
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(400);
    let newRows = await page.evaluate(() => S.taskTableNewRows.map(r => ({ sourceBoqItemId: r.sourceBoqItemId, taskName: r.taskName, budgetAmount: r.budgetAmount })));
    assert(newRows.length === 10, `pulling all adds exactly 10 rows for the 10 real items in one click (got ${newRows.length})`);
    assert(!newRows.some(r => r.sourceBoqItemId === groupItem.id), 'the group/header row is never pulled in as a task row');
    assert(newRows.every(r => realItems.some(it => it.id === r.sourceBoqItemId && it.description === r.taskName && Number(it.amount) === Number(r.budgetAmount))), 'every pulled row has the correct Task Name AND budgetAmount (bi.amount snapshot) copied from its BOQ item');
    const firstItem = realItems.find(it => it.id === newRows[0].sourceBoqItemId);
    const budgetBahtCellText = (await page.locator('#task-table-section table tbody tr').first().locator('td').nth(5).innerText()).trim();
    assert(budgetBahtCellText === Number(firstItem.amount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), `first pulled row's งบประมาณ(บาท) cell shows the BOQ item's amount in the actual DOM, not just in-memory state (got "${budgetBahtCellText}")`);
    assert(await page.locator('[data-act="save-task-table"]').isEnabled(), 'save button is enabled once rows have been pulled');
    assert((await page.locator('#task-table-section .badge:has-text("ยังไม่บันทึก")').count()) === 1, 'unsaved-changes indicator shows after pulling');

    // ---- 4. Click pull again WITHOUT saving -> still exactly 10 rows, no duplicates, and the "none
    // left" toast fires (every available item is already sitting in a pulled row).
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(300);
    newRows = await page.evaluate(() => S.taskTableNewRows.map(r => r.sourceBoqItemId));
    assert(newRows.length === 10, `clicking pull a second time before saving does not duplicate rows (got ${newRows.length})`);
    toastMsg = await page.evaluate(() => S.toast && S.toast.msg);
    assert(toastMsg === 'ไม่มีรายการ BOQ ที่อนุมัติแล้วเหลือให้ดึงเพิ่ม', `repeat-pull with everything already pulled shows the "nothing to pull" toast (got: ${toastMsg})`);

    // ---- 5. Edit one of the pulled rows' Duration before saving, then save all -> 10 tasks
    // persisted, correctly linked, with the edited duration honored.
    //
    // The Duration/save button both live inside the SAME merged left-pane/right-pane Gantt view
    // (2026-07-26 — task table + chart are now one component, re-rendered together on every field
    // edit's onchange). Editing the duration triggers a full render() that replaces the DOM,
    // including the save button itself — Playwright's mouse-coordinate .click() right after a
    // same-tick DOM replacement was found to occasionally miss the new node's live listener, so both
    // the value-set and the save click here go through direct DOM dispatch (native setter + a real
    // 'change' event, then el.click()) instead of page.fill()/page.click(), which is deterministic
    // regardless of how many re-renders happen in between.
    await page.evaluate(() => {
      const el = document.getElementById('new-task-duration-0');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '7');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    assert((await page.evaluate(() => S.taskTableNewRows[0].durationDays)) === '7', 'the Duration edit on the pulled-but-unsaved row actually reached S.taskTableNewRows (sanity check before saving)');
    await page.evaluate(() => document.querySelector('[data-act="save-task-table"]').click());
    await page.waitForTimeout(700);
    let tasksAfter = await pool.query(
      `SELECT id, task_name, duration_days, source_boq_item_id FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 ORDER BY sort_order`,
      [companyId, projectId]
    );
    assert(tasksAfter.rowCount === 10, `all 10 pulled rows persisted from one save (got ${tasksAfter.rowCount})`);
    assert(tasksAfter.rows.every(r => realItems.some(it => it.id === r.source_boq_item_id && it.description === r.task_name)), 'every persisted task has the correct source_boq_item_id and BOQ-derived name');
    assert(tasksAfter.rows.some(r => r.duration_days === 7), 'the duration edited before saving (on the pulled-but-unsaved row) was honored, not overwritten by the default');
    assert((await page.evaluate(() => S.taskTableNewRows.length)) === 0, 'the pulled-rows list clears after a successful save');

    // ---- 6. Approve a NEW 11th BOQ item on a revised budget, click pull again -> only that ONE new
    // row is added, the already-saved 10 are not re-pulled.
    await page.evaluate(async (bid) => {
      await apiCall('POST', `/api/customer/budgets/${bid}/revise`, { reason: 'เพิ่มรายการ A-11' });
    }, budgetId);
    await page.evaluate(async ({ bid, itemDefs }) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [{ description: 'หมวดงานโครงสร้าง', isGroup: true }, ...itemDefs, { workCode: 'A-11', description: 'งานที่ 11', unit: 'งาน', qty: 1, materialUnitPrice: 5000, laborUnitPrice: 500 }],
      });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, { bid: budgetId, itemDefs });

    const item11Row = await pool.query(
      `SELECT bi.id FROM client_budget_items bi JOIN client_budget_revisions br ON br.id=bi.revision_id WHERE br.budget_id=$1 AND bi.work_code='A-11'`,
      [budgetId]
    );
    assert(item11Row.rowCount === 1, 'sanity: A-11 exists on the newly-approved revision');

    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(400);
    newRows = await page.evaluate(() => S.taskTableNewRows.map(r => ({ sourceBoqItemId: r.sourceBoqItemId, taskName: r.taskName })));
    assert(newRows.length === 1, `pulling again after a new item is approved adds exactly 1 new row, not re-pulling the already-saved 10 (got ${newRows.length})`);
    assert(newRows[0].sourceBoqItemId === item11Row.rows[0].id && newRows[0].taskName === 'งานที่ 11', `the one new row is A-11, correctly identified (got ${JSON.stringify(newRows[0])})`);

    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);
    tasksAfter = await pool.query('SELECT COUNT(*)::int AS n FROM client_project_tasks WHERE company_id=$1 AND project_id=$2', [companyId, projectId]);
    assert(tasksAfter.rows[0].n === 11, `after the second pull+save, exactly 11 tasks total exist (10 + the new A-11) (got ${tasksAfter.rows[0].n})`);

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
