// Regression test for the แผนงาน S-curve table's Phase 3 cumulative S-curve (แผนงาน orange line / ผลงาน
// sky line), weighted by each task's งบประมาณ(%) from Phase 1 and each task's own cumulative % from
// Phase 2's client_project_task_periods. See the long comment above computeProjectSCurve() in
// pr-system.html — this is a hand-rolled inline SVG, not recharts (recharts is a React library; this app
// has no React anywhere, so the phase-3 request's "use recharts, already in the system" didn't actually
// apply — flagged back to the user rather than silently pulled in a whole new framework for one chart).
//
// 2026-07-27 (later same day) rewrite: the S-curve moved from a separate card/section below the task
// table into an SVG OVERLAY drawn directly on top of the table's own day/week/month grid — see
// buildScheduleChartOverlaySvgContent()/updateScheduleChartOverlay() in pr-system.html. This test was
// updated to match: DOM checks now target #schedule-chart-overlay (absolutely positioned inside
// #schedule-scroll-main) instead of the old standalone #schedule-print-chart-wrap card, and per an
// explicit follow-up decision, per-point %-labels and the "วันนี้" text label were dropped (the cell text
// already shown in the grid covers the %s, and the today marker is just a line now, matching the
// existing per-cell pink "วันนี้" highlight already in the grid).
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-scurve-chart.regression.js

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
    const code = 'PSCC' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule S-Curve Chart Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'S-Curve Chart Test','project-schedule-scurve-chart-test@example.com','_pscc_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    // No recharts/React <script> TAG anywhere in the page (see file header — the phase-3 request
    // assumed recharts was already available; it never was, this app has no React/bundler at all).
    const pageSource = await (await page.goto(BASE + '/pr-system.html')).text();
    const scriptSrcs = [...pageSource.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map(m => m[1]);
    assert(!scriptSrcs.some(src => /recharts|react(?:-dom)?[./]/i.test(src)), `no recharts/React <script src> tag was added to pr-system.html (got script srcs: ${JSON.stringify(scriptSrcs)})`);

    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_pscc_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ S-Curve รวมโครงการ', clientName: '', tenderId: null, siteAddress: '',
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

    // ---- 1. No tasks at all -> the overlay <svg> exists (rendered unconditionally by
    // renderProjectScheduleTable()) but stays hidden (display:none) and empty — updateScheduleChartOverlay()
    // guards on ctx.columns.length===0/totalBudget<=0/no .sched-task-row elements.
    assert((await page.locator('#schedule-chart-overlay').count()) === 1, '#schedule-chart-overlay <svg> element exists in the DOM');
    assert((await page.evaluate(() => getComputedStyle(document.getElementById('schedule-chart-overlay')).display)) === 'none', 'overlay is hidden with no tasks yet');
    assert((await page.locator('#schedule-chart-overlay [data-scurve="planned"]').count()) === 0, 'no chart polyline rendered yet');

    // ---- 2. Budget 300/300/400 (30%/30%/40%), 3 sequential 10-day tasks, back to back.
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
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(500);

    const taskIds = await page.evaluate(() => S.projectTasks.map(t => ({ id: t.id, name: t.taskName })));
    const aId = taskIds.find(t => t.name === 'งาน A').id, bId = taskIds.find(t => t.name === 'งาน B').id, cId = taskIds.find(t => t.name === 'งาน C').id;
    await page.evaluate(async ({ pid, aId, bId, cId }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${aId}`, { taskName: 'งาน A', durationDays: 10, startDate: '2026-08-01' });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${bId}`, { taskName: 'งาน B', durationDays: 10, startDate: '2026-08-11' });
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${cId}`, { taskName: 'งาน C', durationDays: 10, startDate: '2026-08-21' });
    }, { pid: projectId, aId, bId, cId });
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);

    // ---- 3. Weighted cumulative แผนงาน (each task auto-distributed evenly, no ผลงาน entered yet) at
    // 'month' zoom (4 buckets: ว1 1-7, ว2 8-14, ว3 15-21, ว4 22-31):
    //  ว1(end 8/7):  A=70%*.3=21                                          -> 21
    //  ว2(end 8/14): A=100%*.3=30, B=40%*.3=12                            -> 42
    //  ว3(end 8/21): A=30, B=100%*.3=30, C=10%*.4=4                       -> 64
    //  ว4(end 8/31): A=30, B=30, C=100%*.4=40                             -> 100
    await page.click('[data-act="set-schedule-zoom"][data-zoom="month"]');
    await page.waitForTimeout(200);
    const curveMonth = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget);
    });
    assert(curveMonth.length === 4, `month zoom produces 4 S-curve points, one per ว1-4 bucket (got ${curveMonth.length})`);
    assert(JSON.stringify(curveMonth.map(p => p.planned)) === JSON.stringify([21, 42, 64, 100]), `weighted cumulative แผนงาน matches the 30%/30%/40% formula exactly across all 4 buckets (got ${JSON.stringify(curveMonth.map(p => p.planned))})`);
    assert(curveMonth.every(p => p.actual === 0), 'ผลงาน (actual) line is flat at 0 — nothing entered yet');

    // ---- 4. The overlay <svg> is now visible, correctly positioned/sized against the grid, and its
    // polylines/dots reflect the computed curve.
    const overlay = page.locator('#schedule-chart-overlay');
    assert((await page.evaluate(() => getComputedStyle(document.getElementById('schedule-chart-overlay')).display)) !== 'none', 'overlay becomes visible once there is real task/budget data');
    assert((await overlay.locator('polyline[data-scurve="planned"]').count()) === 1, 'แผนงาน polyline rendered');
    assert((await overlay.locator('polyline[data-scurve="actual"]').count()) === 1, 'ผลงาน polyline rendered');
    assert((await overlay.locator('svg text').count()) === 0, 'no per-point %/text labels are drawn (removed — the grid cells beneath already show their own %values)');
    assert((await overlay.locator('svg circle').count()) === 0, '2026-07-28 spec: no per-point circle markers either — plain lines only');
    const strokeWidths = await page.evaluate(() => Array.from(document.querySelectorAll('#schedule-chart-overlay polyline[data-scurve]')).map(p => getComputedStyle(p).strokeWidth));
    assert(strokeWidths.every(w => w === '1.5px'), `both S-curve lines use the fixed 1.5px stroke-width (2026-07-28 spec — same constant on screen and print) (got ${JSON.stringify(strokeWidths)})`);
    const dims = await page.evaluate(() => {
      const svg = document.getElementById('schedule-chart-overlay');
      const main = document.getElementById('schedule-scroll-main');
      const gridTds = main.querySelectorAll('.sched-grid-td');
      const firstGridTd = gridTds[0], lastGridTd = gridTds[gridTds.length-1];
      const rows = main.querySelectorAll('.sched-task-row');
      return {
        svgLeft: parseFloat(svg.style.left), svgTop: parseFloat(svg.style.top),
        svgW: parseFloat(svg.style.width), svgH: parseFloat(svg.style.height),
        gridLeft: firstGridTd.offsetLeft,
        realGridWidth: (lastGridTd.offsetLeft + lastGridTd.offsetWidth) - firstGridTd.offsetLeft,
        rowsTop: rows[0].offsetTop,
        rowsBottom: rows[rows.length-1].offsetTop + rows[rows.length-1].offsetHeight,
        colWidth: computeScheduleRenderContext().colWidth,
        colCount: computeScheduleRenderContext().columns.length,
      };
    });
    assert(dims.svgLeft === dims.gridLeft, `overlay's left offset exactly matches the grid's own first-column offset (svg left=${dims.svgLeft}, grid left=${dims.gridLeft})`);
    assert(dims.svgTop === dims.rowsTop, `overlay's top offset exactly matches the first task row's top (svg top=${dims.svgTop}, rows top=${dims.rowsTop})`);
    assert(Math.abs(dims.svgH - (dims.rowsBottom - dims.rowsTop)) < 1, `overlay's height matches the full task-rows band (both PLAN+ACTUAL rows), not just one sub-row (svg h=${dims.svgH}, rows band=${dims.rowsBottom-dims.rowsTop})`);
    // NOT dims.colWidth*dims.colCount — that JS constant is only the INTENDED per-column px; table-
    // layout:auto can (and, per the 2026-07-27 3rd bug report, DOES) render columns wider than that when
    // other cells sharing the column have no explicit width. The overlay's width must match the REAL
    // measured grid span instead, whatever that happens to be.
    assert(Math.abs(dims.svgW - dims.realGridWidth) < 1, `overlay's width matches the REAL measured grid span (first-to-last .sched-grid-td), not just the colWidth×colCount formula (svg w=${dims.svgW}, real measured=${dims.realGridWidth})`);

    // 2026-07-28 spec: y(0%) must land EXACTLY at the overlay's own bottom edge (height), no inset. ผลงาน
    // is still flat at 0% everywhere at this point (check #3 above) — every point on that polyline must
    // sit at y===svgH exactly.
    const actualYs = await page.evaluate(() => {
      const poly = document.querySelector('#schedule-chart-overlay polyline[data-scurve="actual"]');
      return poly.getAttribute('points').trim().split(' ').map(p => Number(p.split(',')[1]));
    });
    assert(actualYs.every(y => y === dims.svgH), `every ผลงาน point (flat 0%) sits EXACTLY at the overlay's bottom edge, y=svgH=${dims.svgH}, no inset (got ${JSON.stringify(actualYs)})`);

    // The LAST point of the orange polyline (planned=100, the final ว4 bucket) should sit EXACTLY at the
    // overlay's own top edge (y===0, no inset — 2026-07-28 spec: toY() maps 100% to y=0 exactly, no padY
    // margin; the old padY inset only existed to keep now-removed circle markers from half-clipping at
    // the edge) and at its right edge (x near svgW).
    const lastPointXY = await page.evaluate(() => {
      const poly = document.querySelector('#schedule-chart-overlay polyline[data-scurve="planned"]');
      const pts = poly.getAttribute('points').trim().split(' ').map(p => p.split(',').map(Number));
      return pts[pts.length - 1];
    });
    assert(lastPointXY[1] === 0, `last แผนงาน point (100%) sits EXACTLY at the overlay's top edge, y=0, no inset (got y=${lastPointXY[1]})`);
    assert(Math.abs(lastPointXY[0] - dims.svgW) < 0.5, `last แผนงาน point's x lands exactly at the overlay's right edge, i.e. the LAST grid column (x=${lastPointXY[0]}, expected ${dims.svgW})`);

    // ---- 5. Zoom-independence: switching to 'day' zoom re-buckets into far more points, but the LAST
    // point (project fully planned by its own end date) must still land on the same ~100%, and an
    // early point (end of งาน A's own 10-day span) must equal 30 (only A's full 30% weight counted).
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(200);
    const curveDay = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return { curve: computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget), columns: ctx.columns };
    });
    assert(curveDay.columns.length === 30, `day zoom produces 1 column per day across the full 30-day project range (got ${curveDay.columns.length})`);
    assert(curveDay.curve[curveDay.curve.length - 1].planned === 100, `day zoom's LAST point also reaches 100% (same project total, just finer granularity) (got ${curveDay.curve[curveDay.curve.length - 1].planned})`);
    const day10Idx = curveDay.columns.findIndex(c => c.dayEnd === '2026-08-10');
    assert(day10Idx >= 0 && curveDay.curve[day10Idx].planned === 30, `day zoom's point at งาน A's own end date (8/10) = 30 (only A's 30% weight fully earned so far) (got ${day10Idx >= 0 ? curveDay.curve[day10Idx].planned : 'not found'})`);
    assert((await overlay.locator('polyline[data-scurve="planned"]').count()) === 1, 'overlay still renders correctly after switching zoom (re-measured/repositioned by updateScheduleChartOverlay() on every render)');

    // ---- 6. Enter real ผลงาน progress on งาน A (50% of A, i.e. half its own scope) and confirm the
    // weighted project-wide actual line picks it up correctly: 50% * 30% weight = 15.
    await page.evaluate((id) => {
      scheduleSetCellValue(id, '2026-08-01', '2026-08-05', 'actualPercent', 50);
    }, aId);
    await page.waitForTimeout(200);
    const curveAfterActual = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget);
    });
    const lastActual = curveAfterActual[curveAfterActual.length - 1].actual;
    assert(lastActual === 15, `weighted project-wide ผลงาน line reflects the entered progress: 50% of งาน A's own scope × 30% budget weight = 15% (got ${lastActual})`);

    // ---- 6b. งาน B/C have ZERO ผลงาน periods entered at all, and งาน A only has ผลงาน entered for its
    // first 5 of 30 total project days — i.e. every trailing column (day 6 through day 30) has no new
    // data anywhere. Confirm BOTH polylines' LAST point still renders exactly at the overlay's right
    // edge (forward-filled flat, not stopped mid-grid where the real data ends) — the core ask: the line
    // must always reach the last grid column regardless of how sparse the entered %-data is.
    const edgeCheck = await page.evaluate(() => {
      const svg = document.getElementById('schedule-chart-overlay');
      const svgW = parseFloat(svg.style.width);
      const lastXY = (field) => {
        const poly = svg.querySelector(`polyline[data-scurve="${field}"]`);
        const pts = poly.getAttribute('points').trim().split(' ').map(p => p.split(',').map(Number));
        return pts[pts.length - 1][0];
      };
      return { svgW, plannedX: lastXY('planned'), actualX: lastXY('actual') };
    });
    assert(Math.abs(edgeCheck.plannedX - edgeCheck.svgW) < 0.5, `at day zoom, with sparse ผลงาน data (only 5 of 30 days entered, 2 of 3 tasks untouched), the แผนงาน line's last point still touches the overlay's right edge (x=${edgeCheck.plannedX}, expected ${edgeCheck.svgW})`);
    assert(Math.abs(edgeCheck.actualX - edgeCheck.svgW) < 0.5, `same sparse-data scenario: the ผลงาน line's last point ALSO touches the right edge, i.e. forward-filled flat at 15% through every empty trailing column instead of stopping where real data ends (x=${edgeCheck.actualX}, expected ${edgeCheck.svgW})`);

    // ---- 6c. Same right-edge guarantee must hold after switching zoom level (fewer/wider columns at
    // 'month' zoom) — re-bucketing must not reintroduce the old "stops short of the edge" gap.
    await page.click('[data-act="set-schedule-zoom"][data-zoom="month"]');
    await page.waitForTimeout(200);
    const edgeCheckMonth = await page.evaluate(() => {
      const svg = document.getElementById('schedule-chart-overlay');
      const svgW = parseFloat(svg.style.width);
      const poly = svg.querySelector('polyline[data-scurve="planned"]');
      const pts = poly.getAttribute('points').trim().split(' ').map(p => p.split(',').map(Number));
      return { svgW, x: pts[pts.length - 1][0] };
    });
    assert(Math.abs(edgeCheckMonth.x - edgeCheckMonth.svgW) < 0.5, `right-edge guarantee holds at 'month' zoom too (fewer, wider columns) (x=${edgeCheckMonth.x}, expected ${edgeCheckMonth.svgW})`);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(200);

    // ---- 6d. A project with NO %-data anywhere (totalBudget<=0, i.e. before any budget is assigned to
    // tasks) must produce a flat 0% line for every column, not an error or a missing/partial line —
    // computeProjectSCurve's own weight=0 short-circuit already guarantees this; confirmed directly here
    // since toX() no longer depends on the data values at all (pure index->pixel mapping), so this same
    // edge-reaching guarantee holds unconditionally regardless of what the values are.
    const zeroBudgetCurve = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      return computeProjectSCurve(ctx.tasks, ctx.columns, 0);
    });
    assert(zeroBudgetCurve.every(p => p.planned === 0 && p.actual === 0), 'with totalBudget<=0 (nothing assigned yet), every column\'s planned AND actual is exactly 0 — a flat 0% line from the first point to the last, never a gap or NaN');

    // ---- 6e. Point-count guard, requested explicitly after a 3rd bug report of "the line stops mid-
    // grid": the earlier fix (6b/6c above) only proved the LAST point's x-position, which a prior version
    // of this same test already asserted incorrectly (center-of-column, not edge) and still passed —
    // asserting an exact count is a stronger guard that can't pass by coincidence the way a single-point
    // position check can.
    const pointCountCheck = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      const svg = document.getElementById('schedule-chart-overlay');
      const countPts = (field) => svg.querySelector(`polyline[data-scurve="${field}"]`).getAttribute('points').trim().split(' ').length;
      return { columnsLength: ctx.columns.length, plannedCount: countPts('planned'), actualCount: countPts('actual') };
    });
    assert(pointCountCheck.plannedCount === pointCountCheck.columnsLength, `แผนงาน polyline has EXACTLY one point per grid column, no fewer (points=${pointCountCheck.plannedCount}, columns=${pointCountCheck.columnsLength})`);
    assert(pointCountCheck.actualCount === pointCountCheck.columnsLength, `ผลงาน polyline has EXACTLY one point per grid column, no fewer (points=${pointCountCheck.actualCount}, columns=${pointCountCheck.columnsLength})`);

    // ---- 6f. THE REAL ROOT CAUSE of the 3rd bug report: the overlay's width/toX() math used to trust the
    // ctx.colWidth JS CONSTANT (28/44px) as if it exactly matched the real rendered column width — it
    // doesn't. table-layout:auto lets OTHER cells sharing the same column (the project summary rows'
    // per-column %-cells, which had no explicit width at all until this fix) force the whole column
    // wider than colWidth, and this table's own global `table{width:100%}` rule can stretch things
    // further still. A real project measured 65px/column actual vs. the 28px constant — the overlay was
    // built assuming a much narrower table than the one actually on screen, so for a long grid the line
    // fell thousands of pixels short of the table's true scrollable width, which reads as "the line just
    // vanishes" once you scroll past where the (too-narrow) overlay actually ends. Guard: the overlay's
    // rendered width must equal the REAL measured span between the first and last .sched-grid-td, not
    // columns.length*colWidth.
    const widthGuard = await page.evaluate(() => {
      const svg = document.getElementById('schedule-chart-overlay');
      const gridTds = document.querySelectorAll('#schedule-scroll-main .sched-grid-td');
      const first = gridTds[0], last = gridTds[gridTds.length - 1];
      const realWidth = (last.offsetLeft + last.offsetWidth) - first.offsetLeft;
      return { svgWidth: parseFloat(svg.style.width), realWidth };
    });
    assert(Math.abs(widthGuard.svgWidth - widthGuard.realWidth) < 1, `overlay's rendered width matches the REAL measured grid span (first-to-last .sched-grid-td), not the columns.length*colWidth formula that drifts from reality once other cells in the same column force it wider (svg width=${widthGuard.svgWidth}, real measured=${widthGuard.realWidth})`);

    // ---- 6g. The exact reported shape at scale: extend งาน C to a MUCH longer duration (216 days from
    // its own start, i.e. the grid now spans ~236 days total) with NO new period data added for the
    // extension — reproducing "a long project where data was only entered for the early portion, and the
    // grid extends far beyond it" at the scale where the colWidth-vs-real-width gap (now fixed above)
    // used to become large enough to visibly matter (accumulates per column).
    await page.evaluate(async ({ pid, id }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${id}`, { taskName: 'งาน C', durationDays: 216, startDate: '2026-08-21' });
      await loadProjectTasks(pid);
    }, { pid: projectId, id: cId });
    await page.waitForTimeout(300);
    const scaleCheck = await page.evaluate(() => {
      const ctx = computeScheduleRenderContext();
      const svg = document.getElementById('schedule-chart-overlay');
      const gridTds = document.querySelectorAll('#schedule-scroll-main .sched-grid-td');
      const first = gridTds[0], last = gridTds[gridTds.length - 1];
      const realWidth = (last.offsetLeft + last.offsetWidth) - first.offsetLeft;
      const countPts = (field) => svg.querySelector(`polyline[data-scurve="${field}"]`).getAttribute('points').trim().split(' ').length;
      const lastXY = (field) => {
        const pts = svg.querySelector(`polyline[data-scurve="${field}"]`).getAttribute('points').trim().split(' ');
        return parseFloat(pts[pts.length - 1].split(',')[0]);
      };
      return {
        columnsLength: ctx.columns.length, plannedCount: countPts('planned'), actualCount: countPts('actual'),
        svgWidth: parseFloat(svg.style.width), realWidth, plannedLastX: lastXY('planned'), actualLastX: lastXY('actual'),
      };
    });
    assert(scaleCheck.columnsLength > 200, `the extended project now has a genuinely large grid (${scaleCheck.columnsLength} columns), matching the scale of the real bug report`);
    assert(scaleCheck.plannedCount === scaleCheck.columnsLength && scaleCheck.actualCount === scaleCheck.columnsLength, `at ${scaleCheck.columnsLength} columns, BOTH polylines still have exactly one point per column (planned=${scaleCheck.plannedCount}, actual=${scaleCheck.actualCount})`);
    assert(Math.abs(scaleCheck.svgWidth - scaleCheck.realWidth) < 1, `at ${scaleCheck.columnsLength} columns, overlay width still matches the real measured grid span exactly (svg=${scaleCheck.svgWidth}, real=${scaleCheck.realWidth}) — this is the exact case where colWidth*columns.length used to drift by thousands of px`);
    assert(Math.abs(scaleCheck.plannedLastX - scaleCheck.realWidth) < 1, `at ${scaleCheck.columnsLength} columns, แผนงาน line's last point reaches the REAL right edge, not just the (potentially wrong) svg width (x=${scaleCheck.plannedLastX}, real edge=${scaleCheck.realWidth})`);
    assert(Math.abs(scaleCheck.actualLastX - scaleCheck.realWidth) < 1, `at ${scaleCheck.columnsLength} columns, ผลงาน line's last point ALSO reaches the REAL right edge (x=${scaleCheck.actualLastX}, real edge=${scaleCheck.realWidth})`);

    // ---- 7. "วันนี้" divider — set a task's window to straddle the real current date, confirm the
    // overlay draws a today line (no text label anymore, per the overlay rewrite — matches the existing
    // per-cell pink "วันนี้" highlight already in the grid instead of duplicating it); a project entirely
    // in the past/future should NOT draw one.
    const today = new Date().toISOString().slice(0, 10);
    const todayMinus3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    await page.evaluate(async ({ pid, id, start }) => {
      await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${id}`, { taskName: 'งาน A', durationDays: 10, startDate: start });
      await loadProjectTasks(pid);
    }, { pid: projectId, id: aId, start: todayMinus3 });
    await page.waitForTimeout(300);
    assert((await page.locator('#schedule-chart-overlay line[stroke-dasharray]').count()) === 1, `today marker line renders when a task's window straddles the real current date (${today})`);

    // ---- 8. Scroll sync — the overlay is inside #schedule-scroll-main (the horizontally-scrolling
    // .table-wrap), so scrolling it must move the overlay's rendered position on-screen together with the
    // grid, with NO extra JS wiring needed beyond it being a normal DOM child of that scrolled container
    // (position:absolute against a position:relative ancestor scrolls with that ancestor's content).
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(200);
    const beforeScrollRect = await page.evaluate(() => document.getElementById('schedule-chart-overlay').getBoundingClientRect().left);
    await page.evaluate(() => { document.getElementById('schedule-scroll-main').scrollLeft = 300; });
    await page.waitForTimeout(150);
    const afterScrollRect = await page.evaluate(() => document.getElementById('schedule-chart-overlay').getBoundingClientRect().left);
    assert(Math.abs((beforeScrollRect - afterScrollRect) - 300) < 1, `scrolling #schedule-scroll-main by 300px moves the overlay's on-screen position by the same 300px (before=${beforeScrollRect}, after=${afterScrollRect})`);
    await page.evaluate(() => { document.getElementById('schedule-scroll-main').scrollLeft = 0; });

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
