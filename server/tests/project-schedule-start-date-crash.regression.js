// Regression test for an urgent production bug: editing วันเริ่ม (start date) on an existing task in
// the แผนงาน table's "รายการ Task" section crashed the ENTIRE app to a white screen, requiring a hard
// refresh to recover. Root cause, confirmed via an actual Playwright repro with real console/pageerror
// capture (not guessed): typing "08152026" into the native <input type="date"> — an entirely ordinary-
// looking keystroke sequence — produced a raw value of "0001-08-01" (year 1), because of how the
// browser's date input handles typed digit segments. That value flowed straight into
// computeScheduleDateRange()/scheduleBuildColumns() (pr-system.html), turning a ~30-day project into a
// 700,000+ day time grid; building that many <td>/<input> elements into one HTML string blew past V8's
// ~1GB max string length, throwing an uncaught "RangeError: Invalid string length" INSIDE render()'s
// `app.innerHTML = renderDashboard()` line — which never completes, so the page is stuck, and every
// subsequent render() attempt (e.g. the 45s notification poll) fails the exact same way again.
//
// Fix: (1) taskTableSetStartDate() validates the year (1970-2200) and the resulting COMBINED project
// range (MAX_SCHEDULE_GRID_DAYS = 7305 days / 20 years) before ever touching S.projectTasks, showing a
// specific toast and leaving the task unchanged if either check fails; (2) scheduleBuildColumns() itself
// refuses to build a grid past that same cap regardless of how a bad date got in (defense in depth);
// (3) pageFinProjectSchedule() wraps its render path in try/catch as a last-resort backstop, falling
// back to a visible error card instead of an uncaught exception.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-start-date-crash.regression.js

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
async function pageIsAlive(page) {
  const len = await page.evaluate(() => document.body.innerText.length).catch(() => -1);
  return len > 50;
}

(async () => {
  let companyId = null, projectId = null, browser;
  try {
    const code = 'PSDC' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Start-Date Crash Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Start-Date Crash Test','project-schedule-start-date-crash-test@example.com','_psdc_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_psdc_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบวันเริ่มพังหน้า', clientName: '', tenderId: null, siteAddress: '',
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
    const itemDefs = Array.from({ length: 3 }, (_, i) => ({
      workCode: `A-${i + 1}`, description: `งานที่ ${i + 1}`, unit: 'งาน', qty: 1, materialUnitPrice: 1000, laborUnitPrice: 0,
    }));
    await page.evaluate(async ({ bid, itemDefs }) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, { items: itemDefs });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, { bid: budgetId, itemDefs });
    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);
    await page.evaluate(async (pid) => {
      const tasks = S.projectTasks;
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${tasks[0].id}`, { taskName: tasks[0].taskName, durationDays: 10, startDate: '2026-08-01' });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${tasks[1].id}`, { taskName: tasks[1].taskName, durationDays: 10, startDate: '2026-08-11' });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${tasks[2].id}`, { taskName: tasks[2].taskName, durationDays: 10, startDate: '2026-08-21' });
    }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(2800); // drain setup-action toasts before timing-sensitive checks below
    const taskId = await page.evaluate(() => S.projectTasks[0].id);

    // ---- 1. THE EXACT ORIGINAL CRASH: typing "08152026" (a normal-looking keystroke sequence) into
    // the native วันเริ่ม input via real keyboard events, not page.fill(). Must not crash, must show a
    // clear toast, and the task's startDate must be left unchanged (invalid year rejected).
    const originalStartDate = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).startDate, taskId);
    const input = page.locator(`#task-start-${taskId}`);
    await input.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('08152026');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    assert(await pageIsAlive(page), 'page is still alive (not blank) after the exact original crash-triggering keystroke sequence');
    assert(pageErrors.length === 0, `no uncaught page errors from the crash-triggering sequence (got: ${pageErrors.join(' | ')})`);
    const toastAfterTyping = await page.evaluate(() => S.toast && S.toast.msg);
    assert(!!toastAfterTyping && /1970-2200|ปี.*ผิดปกติ/.test(toastAfterTyping), `a clear "year looks wrong" toast was shown (got: ${toastAfterTyping})`);

    // ---- 2. Direct year-out-of-range rejection (both a tiny year and a huge one), via the real
    // validating function, each independently confirmed non-crashing.
    for (const badYear of ['0001-08-01', '9999-08-01']) {
      await page.evaluate((v) => { taskTableSetStartDate(S.projectTasks[0].id, v); }, badYear);
      await page.waitForTimeout(200);
      assert(await pageIsAlive(page), `page still alive after rejecting startDate="${badYear}"`);
      const rejected = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).startDate !== undefined, taskId);
      assert(rejected, `task object still intact after rejecting startDate="${badYear}"`);
    }
    assert(pageErrors.length === 0, `still no uncaught page errors after direct out-of-range attempts (got: ${pageErrors.join(' | ')})`);

    // ---- 3. A per-task "reasonable" year (within 1970-2200) that would still blow up the COMBINED
    // project range relative to the other 2 tasks (still in 2026) — must ALSO be rejected, with a
    // DIFFERENT, more specific toast than the plain year-range one.
    await page.evaluate((id) => { taskTableSetStartDate(id, '2200-01-01'); }, taskId);
    await page.waitForTimeout(200);
    assert(await pageIsAlive(page), 'page still alive after a per-task-valid but combined-range-exploding date');
    const wideToast = await page.evaluate(() => S.toast && S.toast.msg);
    assert(!!wideToast && /กว้างเกินไป|too wide/i.test(wideToast), `a specific "range too wide" toast was shown, distinct from the year-range one (got: ${wideToast})`);
    const stillOriginal = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).startDate, taskId);
    assert(stillOriginal !== '2200-01-01', 'the combined-range-exploding date was NOT applied to the task');

    // ---- 4. Date OUTSIDE the current grid's range but entirely reasonable (extends the project by a
    // couple of months) — this must SUCCEED, not be rejected, and the grid must re-render correctly
    // with the wider (but still sane) range.
    await page.evaluate((id) => { taskTableSetStartDate(id, '2026-11-01'); }, taskId);
    await page.waitForTimeout(200);
    assert(await pageIsAlive(page), 'page alive after a reasonable out-of-current-range date extension');
    const extendedDate = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).startDate, taskId);
    assert(extendedDate === '2026-11-01', `the reasonable date extension was actually applied (got ${extendedDate})`);
    const rangeAfterExtend = await page.evaluate(() => computeScheduleDateRange(S.projectTasks));
    assert(rangeAfterExtend && rangeAfterExtend.end >= '2026-11-01', `the schedule's computed range correctly grew to include the new date (got ${JSON.stringify(rangeAfterExtend)})`);
    // Grid actually re-rendered (not stuck on the old range) — 'day' zoom groups columns by calendar
    // month name, so switch to it to check the header reflects November (week zoom's "สัปดาห์ N"
    // labels don't carry month names to check against).
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(200);
    const headerText = await page.locator('#task-table-section thead').innerText();
    assert(/พ\.ย\.|Nov/i.test(headerText), `the time-grid header actually shows the extended November range (got: "${headerText.slice(0,80).replace(/\s+/g,' ')}")`);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="week"]');
    await page.waitForTimeout(200);

    // ---- 5. Clearing the date field entirely must not crash.
    await page.evaluate((id) => { taskTableSetStartDate(id, ''); }, taskId);
    await page.waitForTimeout(200);
    assert(await pageIsAlive(page), 'page alive after clearing the date field');
    const clearedDate = await page.evaluate((id) => S.projectTasks.find(t => t.id === id).startDate, taskId);
    assert(clearedDate === '', `date field cleared correctly (got ${JSON.stringify(clearedDate)})`);

    // ---- 6. Backstop: even if a bad value somehow bypassed taskTableSetStartDate entirely (e.g. a
    // future bug elsewhere touching S.projectTasks directly) and reached render() with an absurd range,
    // scheduleBuildColumns()'s own cap must still prevent the crash — and pageFinProjectSchedule()'s
    // try/catch must show a recoverable error card instead of an uncaught exception, for anything that
    // cap doesn't cover.
    await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      t.startDate = '0001-01-01'; // bypasses taskTableSetStartDate's validation on purpose
      render();
    }, taskId);
    await page.waitForTimeout(200);
    assert(await pageIsAlive(page), 'page alive even when S.projectTasks is corrupted directly (bypassing the input-level validation) and render() is called');
    assert(pageErrors.length === 0, `scheduleBuildColumns()'s own cap absorbed the corrupted data with no uncaught error (got: ${pageErrors.join(' | ')})`);
    const hintText = await page.evaluate(() => document.getElementById('task-table-section') ? document.getElementById('task-table-section').innerText : '');
    assert(/กว้างผิดปกติ|too wide/i.test(hintText), 'the "date range looks wrong" hint is shown instead of a blank/broken grid');

    // Restore a sane state and confirm the page fully recovers and functions normally afterward.
    await page.evaluate((id) => { taskTableSetStartDate(id, '2026-08-01'); }, taskId);
    await page.waitForTimeout(200);
    assert(await pageIsAlive(page), 'page fully recovers once the date is corrected back to something sane');
    assert((await page.locator('#task-table-section').innerText()).includes('งบประมาณ'), 'the normal table content (not an error card) is showing again after recovery');

    const realErrors = pageErrors.filter(e => !e.includes('Failed to load resource'));
    assert(!realErrors.length, `no uncaught page errors across the entire test (got: ${realErrors.join(' | ')})`);

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
