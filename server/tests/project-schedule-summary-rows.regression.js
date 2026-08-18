// Regression test for the แผนงาน page's project summary rows (8 rows: 4 แผนงาน + 4 ผลงาน, aggregating
// every task into one project-wide view — see computeProjectSummaryRows()/scheduleMonthSpans() in
// pr-system.html) and the "วันนี้" (today) column highlight shared across the task grid, the summary
// rows, and the S-curve chart's own today marker.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-summary-rows.regression.js

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
    const code = 'PSRW' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Summary Rows Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Summary Rows Test','project-schedule-summary-rows-test@example.com','_psrw_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_psrw_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบแถวสรุป+วันนี้', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // Budget 300/300/400 (30%/30%/40%) — same well-known split used by the phase-3 S-curve test, so
    // hand-computed expectations carry over directly. Tasks run sequentially and DELIBERATELY straddle
    // the real current date (task 2 starts 3 days before "today"), so the today-highlight is testable.
    const budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    await page.evaluate(async (bid) => {
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, {
        items: [
          { workCode: 'A', description: 'งาน A', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'B', description: 'งาน B', unit: 'งาน', qty: 1, materialUnitPrice: 300, laborUnitPrice: 0 },
          { workCode: 'C', description: 'งาน C', unit: 'งาน', qty: 1, materialUnitPrice: 400, laborUnitPrice: 0 },
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
    await page.waitForTimeout(500);

    const today = ymd(new Date());
    const aStart = addDays(today, -13); // A: today-13 .. today-4 (10 days, fully in the past)
    const bStart = addDays(today, -3);  // B: today-3 .. today+6 (straddles today)
    const cStart = addDays(today, 7);   // C: today+7 .. today+16 (fully in the future)
    const taskIds = await page.evaluate(() => S.projectTasks.map(t => ({ id: t.id, name: t.taskName })));
    const aId = taskIds.find(t => t.name === 'งาน A').id, bId = taskIds.find(t => t.name === 'งาน B').id, cId = taskIds.find(t => t.name === 'งาน C').id;
    await page.evaluate(async ({ pid, aId, bId, cId, aStart, bStart, cStart }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${aId}`, { taskName: 'งาน A', durationDays: 10, startDate: aStart });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${bId}`, { taskName: 'งาน B', durationDays: 10, startDate: bStart });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${cId}`, { taskName: 'งาน C', durationDays: 10, startDate: cStart });
    }, { pid: projectId, aId, bId, cId, aStart, bStart, cStart });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(2800); // drain setup toasts before timing-sensitive checks

    // Give งาน A (fully in the past) some real ผลงาน too, so the ผลงาน summary rows aren't all zero.
    await page.evaluate((id) => {
      const t = S.projectTasks.find(x => x.id === id);
      for (let i = 0; i < 10; i++) {
        const d = new Date(t.startDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
        scheduleSetCellValue(id, d.toISOString().slice(0, 10), d.toISOString().slice(0, 10), 'actualPercent', 10);
      }
    }, aId);
    await page.waitForTimeout(200);

    // ---- 1. Hand-computed check via the real functions (day zoom: 1 col/day, 30 columns total,
    // A/B/C each contribute exactly their own 30%/30%/40% weight to แผนงาน คืบหน้าสะสม, reaching 100%
    // at the very last column since all 3 tasks are auto-distributed evenly with no gaps).
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(300);
    const summary = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return computeProjectSummaryRows(ctx.tasks, ctx.columns, ctx.totalBudget);
    });
    const lastPlanned = summary.cumulative[summary.cumulative.length - 1].planned;
    assert(Math.abs(lastPlanned - 100) < 0.1, `แผนงาน คืบหน้าสะสม reaches 100% at the last column (3 sequential, non-overlapping, fully-planned tasks) (got ${lastPlanned})`);
    const periodSum = summary.periodPlanned.reduce((s, v) => s + v, 0);
    assert(Math.abs(periodSum - 100) < 0.5, `SUM of all per-period แผนงาน คืบหน้า values equals the final cumulative (100%) (got ${periodSum})`);
    // งาน A got 100% ผลงาน entered (10 days x 10%) -> its own 30% budget weight is fully earned ->
    // ผลงาน คืบหน้าสะสม should plateau at 30% from A's last day onward (B/C have 0% actual entered).
    const lastActual = summary.cumulative[summary.cumulative.length - 1].actual;
    assert(Math.abs(lastActual - 30) < 0.1, `ผลงาน คืบหน้าสะสม plateaus at exactly งาน A's 30% budget weight (only A has actual progress entered) (got ${lastActual})`);

    // ---- 2. ค่าใช้จ่าย/เดือน (บาท) rows: SUM across all months must equal the task's total budget
    // earned so far — sanity-check against the same underlying numbers a different way (total baht
    // planned across every month-span must equal totalBudget × (lastPlanned/100)).
    const totalMonthlyPlanned = summary.monthlyPlanned.reduce((s, v) => s + v, 0);
    const expectedTotalBaht = 1000 * (lastPlanned / 100); // totalBudget = 300+300+400 = 1000
    assert(Math.abs(totalMonthlyPlanned - expectedTotalBaht) < 1, `SUM of ค่าใช้จ่าย/เดือน across every month equals total budget × คืบหน้าสะสม% (got ${totalMonthlyPlanned}, expected ~${expectedTotalBaht})`);
    assert(Math.abs(summary.cumMonthlyPlanned[summary.cumMonthlyPlanned.length - 1] - totalMonthlyPlanned) < 1, 'ค่าใช้จ่ายสะสม/เดือน\'s last value equals the sum of every monthly value');

    // ---- 3. Monthly merge — at 'day' zoom (many 1-day columns), each ค่าใช้จ่าย/เดือน <td> must have
    // colspan summing to exactly the number of day-columns in that calendar month (no gaps, no overlap).
    const dayZoomMergeInfo = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      const summary = computeProjectSummaryRows(ctx.tasks, ctx.columns, ctx.totalBudget);
      return { totalColumns: ctx.columns.length, spans: summary.monthSpans.map(s => s.span) };
    });
    const spanSum = dayZoomMergeInfo.spans.reduce((s, v) => s + v, 0);
    assert(spanSum === dayZoomMergeInfo.totalColumns, `at 'day' zoom, every month-span's colspan sums to exactly the total column count (no gaps/overlaps) (got ${spanSum} vs ${dayZoomMergeInfo.totalColumns})`);
    assert(dayZoomMergeInfo.spans.length >= 2, `project spans multiple calendar months, so there's actually something to merge (got ${dayZoomMergeInfo.spans.length} months)`);
    // Confirm the DOM itself actually has a <td> with that colspan for the ค่าใช้จ่าย/เดือน row (not
    // just the underlying data model) — find the row by its label text.
    const monthlyBahtRowColspans = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#task-table-section table tbody tr')];
      const row = rows.find(r => r.innerText.includes('ค่าใช้จ่าย / เดือน') && r.innerText.includes('แผนงาน') === false && r.querySelector('td[style*="amber"]'));
      return row ? [...row.querySelectorAll('td[colspan]')].map(td => parseInt(td.getAttribute('colspan'), 10)).filter(n => n > 1 && n < 100) : null;
    });
    assert(Array.isArray(monthlyBahtRowColspans) && monthlyBahtRowColspans.some(c => c > 1), `the actual DOM <td> for ค่าใช้จ่าย/เดือน has colspan > 1 merging multiple day-columns (got ${JSON.stringify(monthlyBahtRowColspans)})`);

    // ---- 4. Switch to 'month' zoom — spans must now always be exactly 4 (the ว1-4 sub-buckets), since
    // scheduleMonthSpans() groups by calendar-month prefix regardless of zoom.
    await page.click('[data-act="set-schedule-zoom"][data-zoom="month"]');
    await page.waitForTimeout(300);
    const monthZoomSpans = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return computeProjectSummaryRows(ctx.tasks, ctx.columns, ctx.totalBudget).monthSpans.map(s => s.span);
    });
    assert(monthZoomSpans.every(s => s === 4), `at 'month' zoom, every month-span merges exactly the 4 ว1-4 sub-columns per month (got ${JSON.stringify(monthZoomSpans)})`);

    // ---- 5. "วันนี้" highlight alignment: the today-column index computed by the shared helper must
    // be non-negative (today falls inside งาน B's window, which is inside the displayed range), and
    // the SAME index must produce a highlighted cell in BOTH the task grid and the summary rows.
    const todayCheck = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return { todayColIdx: ctx.todayColIdx, columnsLength: ctx.columns.length };
    });
    assert(todayCheck.todayColIdx >= 0 && todayCheck.todayColIdx < todayCheck.columnsLength, `today falls within the displayed range at month zoom (got index ${todayCheck.todayColIdx} of ${todayCheck.columnsLength})`);
    const highlightedCellCount = await page.evaluate(() => {
      return [...document.querySelectorAll('#task-table-section td[style*="216,27,96"], #task-table-section th[style*="216,27,96"]')].length;
    });
    assert(highlightedCellCount > 0, `at least one cell in the DOM actually carries the "วันนี้" pink highlight style (got ${highlightedCellCount} cells)`);
    // The S-curve overlay's own today marker must exist too, confirming table+overlay agree today is
    // in-range. 2026-07-27 overlay rewrite: the marker is now a dashed <line> drawn on
    // #schedule-chart-overlay (no more text label — see project-schedule-scurve-chart.regression.js).
    const chartTodayMarker = await page.locator('#schedule-chart-overlay line[stroke-dasharray]').count();
    assert(chartTodayMarker === 1, 'the S-curve overlay also renders exactly one today marker line (table and overlay agree today is in range)');

    // ---- 6. A project whose ENTIRE date range (not just individual tasks) is safely in the future —
    // move ALL THREE tasks past today, not just one, since the grid's columns cover the whole
    // continuous [min start, max end] range: moving only one task while another still straddles today
    // leaves today inside that continuous range even with a scheduling "gap" around it (confirmed:
    // that's the correct, intentional behavior, not a bug — this step must actually clear ALL tasks
    // away from today to test the true negative case).
    await page.evaluate(async ({ pid, aId, bId, cId, farA, farB, farC }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${aId}`, { taskName: 'งาน A', durationDays: 10, startDate: farA });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${bId}`, { taskName: 'งาน B', durationDays: 10, startDate: farB });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${cId}`, { taskName: 'งาน C', durationDays: 10, startDate: farC });
    }, { pid: projectId, aId, bId, cId, farA: addDays(today, 200), farB: addDays(today, 211), farC: addDays(today, 222) });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    const noHighlightCount = await page.evaluate(() => {
      return [...document.querySelectorAll('#task-table-section td[style*="216,27,96"], #task-table-section th[style*="216,27,96"]')].length;
    });
    assert(noHighlightCount === 0, `no "วันนี้" highlight anywhere once every task is safely in the past or far future (got ${noHighlightCount} highlighted cells)`);

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
