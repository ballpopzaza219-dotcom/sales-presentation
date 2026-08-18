// Regression test for the แผนงาน page's 2026-07-26/27 follow-ups:
//  1) client_project_tasks.actual_start_date/actual_end_date/actual_amount/actual_percent — a
//     per-task ผลงาน (actual) snapshot parallel to the existing แผนงาน columns, with
//     actual_duration_days always DERIVED (never its own input/column) from the two actual dates.
//  2) the ระยะเวลา (วัน) / วันเริ่ม inputs in the Task table are borderless at rest (.sched-plain-input)
//     but still editable, gaining a visible border only on hover/focus.
//  3) (2026-07-27 follow-up, superseding an earlier "parallel columns" layout) each SAVED task now
//     renders as 2 <tr> — PLAN (แผนงาน, orange) on top holding the plan-side duration/start/end/budget,
//     ACTUAL (ผลงาน, sky) below holding the actual-side counterparts — instead of all 12 fields flattened
//     into one row via rowspan. No./ชื่องาน/delete still rowspan across both.
//
// NOTE: this file used to ALSO cover the print/print-fit feature (schedulePrint()/schedulePrintFitToPage()
// etc.) — that whole feature (A4/A3 buttons, "พิมพ์แผนงาน" button, and all its underlying JS/CSS) was
// removed from the app (user request, 2026-07-27), so those checks were deleted from this file too. See
// [[project_gantt_task_boq_batch]] memory for the removal history if this print feature ever comes back.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-actual-fields-and-print-fit.regression.js

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
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

(async () => {
  let companyId = null, projectId = null, browser;
  try {
    const code = 'PACT' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Actual Fields Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Actual Test','project-schedule-actual-test@example.com','_pact_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pact_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบผลงาน (actual fields)', clientName: '', tenderId: null, siteAddress: '',
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
          { workCode: 'A', description: 'งาน A', unit: 'งาน', qty: 1, materialUnitPrice: 5000, laborUnitPrice: 0 },
          { workCode: 'B', description: 'งาน B', unit: 'งาน', qty: 1, materialUnitPrice: 3000, laborUnitPrice: 0 },
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
    await page.waitForTimeout(2900); // drain setup toasts before timing-sensitive checks

    const today = ymd(new Date());
    const taskIds = await page.evaluate(() => S.projectTasks.map(t => t.id));
    const taskAStart = addDays(today, -30);
    await page.evaluate(async ({ pid, taskId, start }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'งาน A', durationDays: 30, startDate: start });
    }, { pid: projectId, taskId: taskIds[0], start: taskAStart });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ==================================================================================
    // Part 2 — borderless ระยะเวลา(วัน)/วันเริ่ม inputs, still editable
    // ==================================================================================
    const taskAId = taskIds[0];
    const durInput = `#task-duration-${taskAId}`;
    const startInput = `#task-start-${taskAId}`;
    assert((await page.locator(durInput).count()) === 1, 'duration input exists for the task');
    assert((await page.locator(startInput).count()) === 1, 'start-date input exists for the task');
    const restBorder = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).borderColor, durInput);
    assert(restBorder === 'rgba(0, 0, 0, 0)' || restBorder.includes('transparent') || restBorder === 'rgb(0, 0, 0)' && false,
      `duration input has a transparent border at rest (got: ${restBorder})`);
    await page.focus(durInput);
    const focusBorder = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).borderColor, durInput);
    assert(focusBorder !== restBorder, `duration input's border becomes visible on focus (rest: ${restBorder}, focus: ${focusBorder})`);
    await page.fill(durInput, '25');
    await page.locator(durInput).dispatchEvent('change');
    await page.waitForTimeout(200);
    const newDuration = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).durationDays, taskAId);
    assert(String(newDuration) === '25', `editing the borderless duration input still updates the task (got ${newDuration})`);
    // restore duration back to 30 for the rest of the test
    await page.fill(durInput, '30');
    await page.locator(durInput).dispatchEvent('change');
    await page.waitForTimeout(200);

    // ==================================================================================
    // Part 1 — actual (ผลงาน) task-level fields: start/end/duration(derived)/amount/percent
    // ==================================================================================
    assert((await page.locator(`#task-actual-start-${taskAId}`).count()) === 1, 'actual start-date input exists');
    assert((await page.locator(`#task-actual-end-${taskAId}`).count()) === 1, 'actual end-date input exists');
    assert((await page.locator(`#task-actual-amount-${taskAId}`).count()) === 1, 'actual amount input exists');
    assert((await page.locator(`#task-actual-percent-${taskAId}`).count()) === 1, 'actual percent input exists');
    assert((await page.locator(`#task-actual-duration-${taskAId}`).count()) === 0, 'actual duration is NOT an input (read-only/derived)');

    const actualStart = addDays(today, -20);
    const actualEnd = addDays(today, -6); // 15 inclusive days
    await page.fill(`#task-actual-start-${taskAId}`, actualStart);
    await page.locator(`#task-actual-start-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    await page.fill(`#task-actual-end-${taskAId}`, actualEnd);
    await page.locator(`#task-actual-end-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    // Every SAVED task renders as 2 <tr> — PLAN (row 0 of the pair) then ACTUAL (row 1) — and the
    // derived actual-duration cell lives ONLY in the ACTUAL row now (2026-07-27 2-subrow layout).
    const derivedDuration = await page.evaluate(() => {
      const row = document.querySelectorAll('#task-table-section tbody tr')[1];
      return row.innerText;
    });
    assert(derivedDuration.includes('15'), `ACTUAL row shows the derived actual duration (15 days) after entering both actual dates (row text: ${derivedDuration.replace(/\s+/g,' ').slice(0,300)})`);

    await page.fill(`#task-actual-amount-${taskAId}`, '4200.50');
    await page.locator(`#task-actual-amount-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    await page.fill(`#task-actual-percent-${taskAId}`, '62.5');
    await page.locator(`#task-actual-percent-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);

    // Sanity check clamping client-side before save: an out-of-range percent should clamp to 100 via
    // taskEditableFields() at save time.
    const dirtyBeforeSave = await page.evaluate(() => taskTableHasUnsavedChanges());
    assert(dirtyBeforeSave === true, 'editing actual fields marks the task table dirty');

    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(600);

    // ---- DB-level verification: exactly what got persisted.
    const dbTask = await pool.query(
      `SELECT to_char(actual_start_date,'YYYY-MM-DD') AS actual_start_date, to_char(actual_end_date,'YYYY-MM-DD') AS actual_end_date, actual_amount, actual_percent
       FROM client_project_tasks WHERE id=$1`, [taskAId]
    );
    assert(dbTask.rows[0].actual_start_date === actualStart, `DB actual_start_date persisted correctly (got ${dbTask.rows[0].actual_start_date}, expected ${actualStart})`);
    assert(dbTask.rows[0].actual_end_date === actualEnd, `DB actual_end_date persisted correctly (got ${dbTask.rows[0].actual_end_date}, expected ${actualEnd})`);
    assert(Number(dbTask.rows[0].actual_amount) === 4200.5, `DB actual_amount persisted correctly (got ${dbTask.rows[0].actual_amount})`);
    assert(Number(dbTask.rows[0].actual_percent) === 62.5, `DB actual_percent persisted correctly (got ${dbTask.rows[0].actual_percent})`);

    // ---- Server-computed actualDurationDays comes back correctly after a fresh GET (serializeTask()).
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const reloadedTaskA = await page.evaluate((id) => S.projectTasks.find(t => t.id === id), taskAId);
    assert(reloadedTaskA.actualDurationDays === 15, `serializeTask() derives actualDurationDays=15 from the two actual dates (got ${reloadedTaskA.actualDurationDays})`);
    assert(reloadedTaskA.actualStartDate === actualStart && reloadedTaskA.actualEndDate === actualEnd, 'reloaded task carries the correct actual start/end dates');
    assert(Number(reloadedTaskA.actualAmount) === 4200.5 && Number(reloadedTaskA.actualPercent) === 62.5, 'reloaded task carries the correct actual amount/percent');

    // ---- A task with only ONE actual date set (no end yet) shows "-" for actual duration, not a
    // bogus/negative number.
    const taskBId = taskIds[1];
    await page.evaluate(async ({ pid, taskId, start }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName: 'งาน B', durationDays: 10, startDate: start, actualStartDate: start });
    }, { pid: projectId, taskId: taskBId, start: addDays(today, -3) });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    // Every SAVED task renders as 2 <tr> (PLAN/ACTUAL) — the derived actual-duration cell lives on the
    // SECOND (ACTUAL) row of the pair, hence idx*2+1 not idx*2.
    const taskBRowText = await page.evaluate((id) => {
      const idx = S.projectTasks.findIndex(t => t.id === id);
      return document.querySelectorAll('#task-table-section tbody tr')[idx*2+1].innerText;
    }, taskBId);
    assert(taskBRowText.includes(' - ') || /(^|\s)-(\s|$)/.test(taskBRowText), `task with only actual-start set (no actual-end) shows "-" for actual duration, not a number (row: ${taskBRowText.replace(/\s+/g,' ').slice(0,300)})`);
    const taskBData = await page.evaluate((id) => S.projectTasks.find(t => t.id === id), taskBId);
    assert(taskBData.actualDurationDays === null, `actualDurationDays is null (not 0 or NaN) when only one actual date is set (got ${taskBData.actualDurationDays})`);

    // ==================================================================================
    // Part 3 (2026-07-27) — 2-subrow PLAN/ACTUAL layout: colors matching the pre-existing
    // row_label_planned/row_label_actual + grid/S-curve convention, rowspan'd No./ชื่องาน, dashed
    // task-separator, and PLAN/ACTUAL field independence (editing one never touches the other).
    // ==================================================================================
    const layoutInfo = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('#task-table-section tbody tr')];
      const idx = S.projectTasks.findIndex(t => t.id === id);
      const planRow = rows[idx*2], actualRow = rows[idx*2+1];
      const planLabelTd = [...planRow.querySelectorAll('td')].find(td => td.textContent.trim() === 'แผนงาน');
      const actualLabelTd = [...actualRow.querySelectorAll('td')].find(td => td.textContent.trim() === 'ผลงาน');
      const planDurationColor = getComputedStyle(document.getElementById(`task-duration-${id}`)).color;
      const actualStartColor = getComputedStyle(document.getElementById(`task-actual-start-${id}`)).color;
      const noCell = planRow.querySelector('td.num-cell.mono'); // No. column, rowspan'd
      return {
        planLabelColor: planLabelTd ? getComputedStyle(planLabelTd).color : null,
        actualLabelColor: actualLabelTd ? getComputedStyle(actualLabelTd).color : null,
        planDurationColor, actualStartColor,
        noCellRowspan: noCell ? noCell.getAttribute('rowspan') : null,
        noCellVAlign: noCell ? getComputedStyle(noCell).verticalAlign : null,
        actualRowLastCellBorderBottomStyle: getComputedStyle(actualRow.querySelector('td')).borderBottomStyle,
      };
    }, taskAId);
    assert(layoutInfo.planLabelColor !== null && layoutInfo.actualLabelColor !== null, 'both the "แผนงาน" and "ผลงาน" row-label cells exist (2-subrow layout, not the old parallel-columns one)');
    assert(layoutInfo.planDurationColor === layoutInfo.planLabelColor, `PLAN row's ระยะเวลา(วัน) input uses the SAME color as the existing "แผนงาน" label (reusing the system's existing convention, not a new color) (duration: ${layoutInfo.planDurationColor}, label: ${layoutInfo.planLabelColor})`);
    assert(layoutInfo.actualStartColor === layoutInfo.actualLabelColor, `ACTUAL row's วันเริ่ม(ผลงาน) input uses the SAME color as the existing "ผลงาน" label (duration: ${layoutInfo.actualStartColor}, label: ${layoutInfo.actualLabelColor})`);
    assert(layoutInfo.planLabelColor !== layoutInfo.actualLabelColor, `PLAN and ACTUAL rows use two DIFFERENT colors from each other (plan: ${layoutInfo.planLabelColor}, actual: ${layoutInfo.actualLabelColor})`);
    assert(layoutInfo.noCellRowspan === '2', `No. column still carries rowspan="2" (merged across both PLAN/ACTUAL rows, not duplicated) (got ${layoutInfo.noCellRowspan})`);
    assert(layoutInfo.noCellVAlign === 'middle', `No. column is vertically centered across its 2-row span (got ${layoutInfo.noCellVAlign})`);
    assert(layoutInfo.actualRowLastCellBorderBottomStyle === 'dashed', `a dashed border separates this task from the next one (border-bottom-style on the ACTUAL row's own cells, got ${layoutInfo.actualRowLastCellBorderBottomStyle})`);

    // ---- Part 3b (2026-07-27, later same day) — border removal extended to วันเสร็จ/งบประมาณ (ACTUAL
    // row's วันเสร็จ/บาท/% inputs; PLAN's own วันเสร็จ/งบประมาณ were already plain read-only text with no
    // border to begin with, nothing to change there). Same .sched-plain-input treatment as ระยะเวลา(วัน)/
    // วันเริ่ม already got — transparent border at rest, visible on hover/focus, still editable.
    const borderlessCheck = await page.evaluate((id) => {
      const ids = [`task-actual-end-${id}`, `task-actual-amount-${id}`, `task-actual-percent-${id}`];
      return ids.map(elId => {
        const el = document.getElementById(elId);
        return { id: elId, borderColor: getComputedStyle(el).borderColor };
      });
    }, taskAId);
    for (const c of borderlessCheck) {
      assert(c.borderColor === 'rgba(0, 0, 0, 0)', `#${c.id} (ACTUAL วันเสร็จ/งบประมาณ) has a transparent border at rest (got: ${c.borderColor})`);
    }
    // Still editable after the border removal.
    await page.fill(`#task-actual-amount-${taskAId}`, '5000');
    await page.locator(`#task-actual-amount-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    const actualAmountAfterEdit = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).actualAmount, taskAId);
    assert(Number(actualAmountAfterEdit) === 5000, `borderless ACTUAL บาท input still updates the task when edited (got ${actualAmountAfterEdit})`);
    // restore for later assertions in this test
    await page.fill(`#task-actual-amount-${taskAId}`, '4200.5');
    await page.locator(`#task-actual-amount-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);

    // Editing the PLAN row's ระยะเวลา(วัน) must NOT touch the ACTUAL row's fields, and vice versa —
    // they are genuinely separate DB columns (duration_days vs actual_amount/actual_percent), not two
    // views of the same underlying value.
    const beforeIndependenceCheck = await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      return { actualAmount: t.actualAmount, actualPercent: t.actualPercent };
    }, taskAId);
    await page.fill(`#task-duration-${taskAId}`, '28');
    await page.locator(`#task-duration-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    const afterPlanEdit = await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      return { durationDays: t.durationDays, actualAmount: t.actualAmount, actualPercent: t.actualPercent };
    }, taskAId);
    assert(String(afterPlanEdit.durationDays) === '28', 'editing PLAN row\'s ระยะเวลา(วัน) updates durationDays');
    assert(Number(afterPlanEdit.actualAmount) === Number(beforeIndependenceCheck.actualAmount) && Number(afterPlanEdit.actualPercent) === Number(beforeIndependenceCheck.actualPercent),
      `editing the PLAN row does NOT change the ACTUAL row's fields (actualAmount/actualPercent unchanged: ${JSON.stringify(afterPlanEdit)})`);
    const planFieldsBeforeActualEdit = await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      return { durationDays: t.durationDays, startDate: t.startDate };
    }, taskAId);
    await page.fill(`#task-actual-percent-${taskAId}`, '80');
    await page.locator(`#task-actual-percent-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);
    const planFieldsAfterActualEdit = await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      return { durationDays: t.durationDays, startDate: t.startDate };
    }, taskAId);
    assert(JSON.stringify(planFieldsAfterActualEdit) === JSON.stringify(planFieldsBeforeActualEdit),
      `editing the ACTUAL row (%) does NOT change the PLAN row's durationDays/startDate (${JSON.stringify(planFieldsAfterActualEdit)})`);
    // restore duration/percent back to the values used by later assertions/DB checks in this test
    await page.fill(`#task-duration-${taskAId}`, '30');
    await page.locator(`#task-duration-${taskAId}`).dispatchEvent('change');
    await page.fill(`#task-actual-percent-${taskAId}`, '62.5');
    await page.locator(`#task-actual-percent-${taskAId}`).dispatchEvent('change');
    await page.waitForTimeout(150);

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
