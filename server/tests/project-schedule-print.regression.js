// Regression test for the แผนงาน page's 2026-07-27 print-settings modal rebuild — an entirely custom
// in-app print flow (paper size A4/A3, scale 100%/fit-width/fit-height/fit-page, margin normal/narrow/
// wide, always-landscape) that computes its own layout in JS instead of relying on the browser's print
// dialog defaults. See [[project_gantt_task_boq_batch]] memory for the 4-round print-fit debugging
// history this rebuild is designed to avoid repeating, and for why this file replaces the OLD
// project-schedule-print.regression.js that was deleted when the previous print feature was removed.
//
// Key architecture points this test checks:
//  - #schedule-print-frame wraps pageHead+table; @page is ALWAYS margin:0, the visible margin is real
//    CSS padding on the frame (sized from the same mm->px constant as @page's own size).
//  - scheduleApplyPrintLayout()/scheduleResetPrintLayout() only ever run between 'beforeprint'/
//    'afterprint' — this test calls them directly (same technique the removed feature's own tests used)
//    since Playwright can't fire real OS print-dialog events, but page.pdf() DOES exercise Chromium's
//    real print pipeline (which does fire beforeprint/afterprint) for the page-count assertions.
//  - Measurement uses getBoundingClientRect(), NOT scrollWidth/scrollHeight — confirmed via direct
//    testing during this rebuild that scrollWidth/scrollHeight read on an element that itself has CSS
//    `zoom` applied report LOCAL (pre-zoom, inverted) coordinates, not the real visual size.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-print.regression.js

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
    const code = 'PPRT' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Print Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Print Test','project-schedule-print-test@example.com','_pprt_test_', $2, 'active', true)`,
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
    await page.fill('#f-loginUser', '_pprt_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบพิมพ์เอกสาร', clientName: '', tenderId: null, siteAddress: '',
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
      const items = [];
      for (let i = 0; i < 8; i++) items.push({ workCode: 'W'+i, description: `งานทดสอบพิมพ์ที่ ${i+1}`, unit: 'งาน', qty: 1, materialUnitPrice: 10000 + i*500, laborUnitPrice: 0 });
      await apiCall('PUT', `/api/customer/budgets/${bid}/items`, { items });
      await apiCall('POST', `/api/customer/budgets/${bid}/submit`);
      await apiCall('POST', `/api/customer/budgets/${bid}/approve`);
    }, budgetId);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="pull-all-boq-items"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="save-task-table"]');
    await page.waitForTimeout(1500);

    const today = ymd(new Date());
    const tasks = await page.evaluate(() => S.projectTasks.map(t => ({ id: t.id, taskName: t.taskName })));
    for (let i = 0; i < tasks.length; i++) {
      const start = addDays(today, i * 6);
      await page.evaluate(async ({ pid, taskId, taskName, start }) => {
        await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${taskId}`, { taskName, durationDays: 12, startDate: start });
      }, { pid: projectId, taskId: tasks[i].id, taskName: tasks[i].taskName, start });
    }
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(500);
    await page.waitForSelector('#schedule-print-frame', { timeout: 15000 });

    // ---- 1) Print button present, opens modal with correct defaults ----
    assert(await page.locator('[data-act="open-schedule-print-modal"]').count() === 1, 'print button present in pageHead');
    await page.click('[data-act="open-schedule-print-modal"]');
    await page.waitForSelector('.modal[data-stop="1"]');
    const defaults = await page.evaluate(() => ({ paperSize: S.modal.paperSize, scaleMode: S.modal.scaleMode, margin: S.modal.margin }));
    assert(defaults.paperSize === 'A4' && defaults.scaleMode === 'fit-page' && defaults.margin === 'normal',
      'modal opens with A4 / fit-page / normal defaults — ' + JSON.stringify(defaults));

    // ---- 2) Option buttons update S.modal ----
    await page.click(`button[onclick="S.modal.paperSize='A3'; render();"]`);
    await page.click(`button[onclick="S.modal.scaleMode='normal'; render();"]`);
    await page.click(`button[onclick="S.modal.margin='wide'; render();"]`);
    const afterClicks = await page.evaluate(() => ({ paperSize: S.modal.paperSize, scaleMode: S.modal.scaleMode, margin: S.modal.margin }));
    assert(afterClicks.paperSize === 'A3' && afterClicks.scaleMode === 'normal' && afterClicks.margin === 'wide',
      'clicking options updates S.modal — ' + JSON.stringify(afterClicks));

    // ---- 3) close-modal works (the Cancel BUTTON, not the overlay backdrop div — both share
    // data-act="close-modal", but the overlay's own click target is geometrically covered by the modal
    // card on top of it, so clicking a bare attribute selector lands on the (non-propagating) card
    // instead — tag-qualify to hit the actual <button> ) ----
    await page.click('button[data-act="close-modal"]');
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => S.modal === null), 'close-modal clears S.modal');

    // From here on, every check calls scheduleApplyPrintLayout() directly rather than going through a
    // real print/page.pdf() — but scheduleApplyPrintLayout() (and the .sched-col-*/table font-size print
    // CSS it depends on) only takes effect once @media print is actually active. Without this, the
    // browser silently falls back to on-screen CSS (larger font, no min-width rules), giving numbers that
    // don't correspond to anything a real print/page.pdf() run would produce — found the hard way when a
    // width-fill regression check failed with numbers that made no sense until this was traced back.
    await page.emulateMedia({ media: 'print' });

    // ---- 4) scheduleApplyPrintLayout(): @page rule + frame width/padding/zoom for A4/fit-page/normal ----
    const a4Fit = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const frame = document.getElementById('schedule-print-frame');
      const pageStyle = document.getElementById('schedule-print-page-style');
      const sized = scheduleMeasurePrintFrame(frame);
      return {
        pageStyleText: pageStyle.textContent,
        width: frame.style.width, padding: frame.style.padding, zoom: parseFloat(frame.style.zoom),
        realW: sized.w, realH: sized.h,
      };
    });
    assert(a4Fit.pageStyleText.includes('297mm 210mm') && a4Fit.pageStyleText.includes('margin:0'),
      '@page rule for A4 landscape has margin:0 and correct mm size — ' + a4Fit.pageStyleText);
    assert(Math.abs(parseFloat(a4Fit.width) - (297 * 96/25.4)) < 1, 'frame width matches A4 landscape px — ' + a4Fit.width);
    assert(Math.abs(parseFloat(a4Fit.padding) - (15 * 96/25.4)) < 1, 'frame padding matches "normal" 15mm margin — ' + a4Fit.padding);
    const targetW = 297*96/25.4 - 2*15*96/25.4, targetH = 210*96/25.4 - 2*15*96/25.4;
    // Height must stay within budget (that's the hard page-break constraint); width is DELIBERATELY
    // allowed to reach (and even slightly exceed, by design of the width-fill feature below) the target —
    // "fit page" now fills leftover width via wider grid columns rather than leaving it blank, so a
    // width <= target assertion here would be testing the OLD, since-replaced behavior.
    assert(a4Fit.realH <= targetH * 1.02,
      `fit-page result's height fits within the printable box (target ${targetH.toFixed(0)}, got ${a4Fit.realH.toFixed(0)})`);
    assert(a4Fit.zoom > 0 && a4Fit.zoom <= 1, 'fit-page zoom is a sane fraction — ' + a4Fit.zoom);

    // ---- 5) A3 + narrow margin: @page/padding change accordingly ----
    const a3Narrow = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A3', scaleMode: 'normal', margin: 'narrow' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const frame = document.getElementById('schedule-print-frame');
      const pageStyle = document.getElementById('schedule-print-page-style');
      return { pageStyleText: pageStyle.textContent, width: frame.style.width, padding: frame.style.padding, zoom: frame.style.zoom };
    });
    assert(a3Narrow.pageStyleText.includes('420mm 297mm'), '@page rule updates to A3 landscape — ' + a3Narrow.pageStyleText);
    assert(Math.abs(parseFloat(a3Narrow.padding) - (6 * 96/25.4)) < 1, 'frame padding matches "narrow" 6mm margin — ' + a3Narrow.padding);
    assert(a3Narrow.zoom === '1', '"normal" scale mode leaves zoom at 1 (no shrinking) — ' + a3Narrow.zoom);

    // ---- 6) scheduleResetPrintLayout() clears everything ----
    await page.evaluate(() => { scheduleResetPrintLayout(); S.schedulePrintSettings = null; });
    const afterReset = await page.evaluate(() => {
      const frame = document.getElementById('schedule-print-frame');
      const pageStyle = document.getElementById('schedule-print-page-style');
      return { zoom: frame.style.zoom, width: frame.style.width, padding: frame.style.padding, pageStyleText: pageStyle.textContent };
    });
    assert(afterReset.zoom === '' && afterReset.width === '' && afterReset.padding === '' && afterReset.pageStyleText === '',
      'scheduleResetPrintLayout() clears all inline style and the @page rule — ' + JSON.stringify(afterReset));

    // ---- 7) Default fallback: beforeprint applies A4/fit-page/normal even if the modal was never opened ----
    const fallback = await page.evaluate(async () => {
      S.schedulePrintSettings = null;
      scheduleApplyPrintLayout();
      const frame = document.getElementById('schedule-print-frame');
      const r = { width: frame.style.width };
      scheduleResetPrintLayout();
      return r;
    });
    assert(Math.abs(parseFloat(fallback.width) - (297 * 96/25.4)) < 1, 'no-settings fallback still defaults to A4 — ' + fallback.width);

    // ---- 8) Overshoot warning toast fires after a genuine >10% residual miss ----
    const overshootToast = await page.evaluate(async () => {
      S.schedulePrintLastOvershoot = 1.3; // simulate what scheduleApplyPrintLayout() would have set
      scheduleResetPrintLayout();
      return S.toast ? S.toast.msg : null;
    });
    assert(!!overshootToast && overshootToast === (await page.evaluate(() => tr('fin_project_schedule.print_overshoot_warning'))),
      'a genuine residual overshoot shows the warning toast after print — ' + overshootToast);
    await page.evaluate(() => { S.toast = null; });

    // ---- 9) Real print pipeline: page.pdf() page counts for the two must-pass default cases ----
    async function realPageCount(paperSize, scaleMode, margin) {
      await page.evaluate(async ({ paperSize, scaleMode, margin }) => {
        S.schedulePrintSettings = { paperSize, scaleMode, margin };
        render();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (document.fonts && document.fonts.status !== 'loaded') { try { await document.fonts.ready; } catch(e){} }
      }, { paperSize, scaleMode, margin });
      const buf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      await page.evaluate(() => { S.schedulePrintSettings = null; });
      return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    }
    const a4Pages = await realPageCount('A4', 'fit-page', 'normal');
    assert(a4Pages === 1, `real page.pdf() page count for A4+fit-page+normal (typical 8-task project) is 1 — got ${a4Pages}`);
    const a3Pages = await realPageCount('A3', 'fit-page', 'normal');
    assert(a3Pages === 1, `real page.pdf() page count for A3+fit-page+normal (typical 8-task project) is 1 — got ${a3Pages}`);

    // ---- 10) REGRESSION GUARD: the S-curve overlay must be re-measured for print, not left stale.
    // (Reported right after this feature first shipped: the line "stopped mid-grid" + a spurious blank
    // page appeared ONLY when printing, never on screen — because updateScheduleChartOverlay() was only
    // ever wired into the normal on-screen render()/attachHandlers() path, never into
    // scheduleApplyPrintLayout(). Print's own zoom + @media print's `table{font-size:12px}` genuinely
    // reflow the table to different real geometry than whatever was on screen when the overlay was last
    // computed, so its stale absolutely-positioned left/top/width/height no longer matched — this is
    // exactly why the fix reuses updateScheduleChartOverlay() itself rather than adding a second,
    // print-only measurement path that could drift out of sync with the screen version again.)
    // Checked across all 3 zoom levels — the original report was specifically about a symptom that did
    // NOT reproduce on screen, only under print, so this must assert against real print-time geometry.
    for (const zoomLevel of ['day', 'week', 'month']) {
      await page.evaluate((z) => { S.scheduleZoom = z; render(); }, zoomLevel);
      await page.waitForTimeout(200);
      const overlayCheck = await page.evaluate(async (z) => {
        S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
        render();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        scheduleApplyPrintLayout();
        const main = document.getElementById('schedule-scroll-main');
        const svg = document.getElementById('schedule-chart-overlay');
        const gridTds = main.querySelectorAll('.sched-grid-td');
        const rows = main.querySelectorAll('.sched-task-row');
        const lastTd = gridTds[gridTds.length - 1];
        const realRightEdge = lastTd.offsetLeft + lastTd.offsetWidth;
        const realBottomEdge = rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight;
        const svgRightEdge = parseFloat(svg.style.left) + parseFloat(svg.style.width);
        const svgBottomEdge = parseFloat(svg.style.top) + parseFloat(svg.style.height);
        const result = {
          zoom: z, widthMismatch: Math.abs(svgRightEdge - realRightEdge), heightMismatch: Math.abs(svgBottomEdge - realBottomEdge),
        };
        scheduleResetPrintLayout();
        S.schedulePrintSettings = null;
        return result;
      }, zoomLevel);
      assert(overlayCheck.widthMismatch < 2, `[zoom=${zoomLevel}] S-curve overlay right edge matches the real print-time grid edge (mismatch ${overlayCheck.widthMismatch.toFixed(1)}px)`);
      assert(overlayCheck.heightMismatch < 2, `[zoom=${zoomLevel}] S-curve overlay bottom edge matches the real print-time grid edge (mismatch ${overlayCheck.heightMismatch.toFixed(1)}px)`);
    }
    await page.evaluate(() => { S.scheduleZoom = 'week'; render(); });

    // ---- 11) REGRESSION GUARD: print must read the REAL actual_percent field, not accidentally fall
    // back to planned_percent or some other value. (Reported after the fix above: user saw the ผลงาน
    // line "shoot up nearly to the แผนงาน line" in print for tasks with zero real actual data — asked
    // for a check using actual values DELIBERATELY DIFFERENT from planned, since a field-swap bug would
    // be invisible in a test where actual happens to equal planned.) Sets 2 of this file's 8 tasks to a
    // known actual% distinct from their planned%, hand-computes the expected weighted project-wide
    // actual, and checks it 3 ways: the raw computeProjectSCurve() output, AND the value read back
    // directly off the rendered SVG polyline's own pixels (converting Y back to % via the same
    // padY/usableH formula buildScheduleChartOverlaySvgContent uses) — both on screen AND after
    // scheduleApplyPrintLayout() runs.
    const distinctCheck = await page.evaluate(async () => {
      const ctxBefore = computeScheduleRenderContext();
      const totalBudget = ctxBefore.totalBudget;
      const t0 = S.projectTasks[0], t1 = S.projectTasks[1];
      const w0 = (Number(t0.budgetAmount)||0) / totalBudget, w1 = (Number(t1.budgetAmount)||0) / totalBudget;
      const p0 = S.taskPeriods.filter(p => p.taskId === t0.id).sort((a,b)=>a.periodDate.localeCompare(b.periodDate));
      const p1 = S.taskPeriods.filter(p => p.taskId === t1.id).sort((a,b)=>a.periodDate.localeCompare(b.periodDate));
      // Distinct, known actual% (task 0 -> 20%, task 1 -> 65%), set on the LAST period of each so the
      // cumulative value is exactly that number (not a running sum of several edits).
      scheduleSetCellValue(t0.id, p0[p0.length-1].periodDate, p0[p0.length-1].periodDate, 'actualPercent', '20');
      scheduleSetCellValue(t1.id, p1[p1.length-1].periodDate, p1[p1.length-1].periodDate, 'actualPercent', '65');
      render();
      // Hand-computed expected weighted actual at the very last column (both tasks' full window has
      // passed by then, and every OTHER task in this file's fixture has 0% actual, per the earlier
      // ground-truth checks in this same file):
      const expected = w0*20 + w1*65;

      function readCurveLast() {
        const ctx = computeScheduleRenderContext();
        const curve = computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget);
        return curve[curve.length-1].actual;
      }
      function readSvgLast() {
        // 2026-07-28 spec: toY() has no padY inset anymore (pct=0 -> y=height exactly, pct=100 -> y=0
        // exactly) — decode using that same exact mapping, not the old padY-adjusted formula (which used
        // to still pass here only because this check's <1 tolerance happened to absorb the ~6px drift).
        const svg = document.getElementById('schedule-chart-overlay');
        const pts = svg.querySelector('polyline[data-scurve="actual"]').getAttribute('points').trim().split(' ');
        const height = parseFloat(svg.style.height);
        const lastY = parseFloat(pts[pts.length-1].split(',')[1]);
        return (1 - lastY/height) * 100;
      }

      const onScreenData = readCurveLast();
      const onScreenSvg = readSvgLast();

      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const printData = readCurveLast();
      const printSvg = readSvgLast();
      scheduleResetPrintLayout();
      S.schedulePrintSettings = null;

      return { expected, onScreenData, onScreenSvg, printData, printSvg };
    });
    console.log('distinct actual-vs-planned check:', JSON.stringify(distinctCheck));
    assert(Math.abs(distinctCheck.onScreenData - distinctCheck.expected) < 0.01,
      `on-screen computeProjectSCurve matches hand-computed weighted actual% (expected ${distinctCheck.expected.toFixed(3)}, got ${distinctCheck.onScreenData})`);
    assert(Math.abs(distinctCheck.printData - distinctCheck.expected) < 0.01,
      `print-time computeProjectSCurve matches hand-computed weighted actual% (expected ${distinctCheck.expected.toFixed(3)}, got ${distinctCheck.printData})`);
    assert(Math.abs(distinctCheck.onScreenSvg - distinctCheck.expected) < 1,
      `on-screen rendered SVG pixels decode back to the expected actual% (expected ${distinctCheck.expected.toFixed(3)}, got ${distinctCheck.onScreenSvg.toFixed(2)})`);
    assert(Math.abs(distinctCheck.printSvg - distinctCheck.expected) < 1,
      `print-time rendered SVG pixels decode back to the expected actual% — NOT the planned% (expected ${distinctCheck.expected.toFixed(3)}, got ${distinctCheck.printSvg.toFixed(2)})`);

    // ---- 12) REGRESSION GUARD: left label columns (No./รายละเอียดงาน/ระยะเวลา/วันที่/งบประมาณ) must get
    // a legible minimum width in print, not collapse to a few px while the grid eats the rest of the
    // page (reported after the fixes above shipped — real screenshot showed "รายละเอียดงาน" crammed
    // illegibly narrow with visible blank space on the grid side). Root cause: .sched-grid-td (and every
    // left-column <td>/<th>) carried NO explicit width of their own — only their INNER <input>s did —
    // so table-layout:auto's column-width algorithm was free to squeeze them toward a near-zero minimum
    // for a project with enough time-grid columns. Fix: .sched-col-* print-only min-width classes on
    // every left-column cell (including the day-grid's own .sched-grid-td). Checked on THIS file's own
    // typical 8-task fixture, across all 3 zoom levels — must stay legible AND still fit 1 page.
    for (const zoomLevel of ['day', 'week', 'month']) {
      await page.evaluate((z) => { S.scheduleZoom = z; render(); }, zoomLevel);
      await page.waitForTimeout(200);
      const propCheck = await page.evaluate(async (z) => {
        S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
        render();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        scheduleApplyPrintLayout();
        const main = document.getElementById('schedule-scroll-main');
        const firstTaskRow = main.querySelector('.sched-task-row');
        const leftCells = Array.from(firstTaskRow.children).filter(td => !td.classList.contains('sched-grid-td'));
        const leftTotalWidth = leftCells.reduce((s,td)=>s+td.getBoundingClientRect().width, 0);
        const tableWidth = document.querySelector('table').getBoundingClientRect().width;
        const nameCell = firstTaskRow.querySelector('.sched-col-name');
        const zoom = parseFloat(document.getElementById('schedule-print-frame').style.zoom) || 1;
        const result = { leftPct: leftTotalWidth/tableWidth*100, nameCellWidth: nameCell.getBoundingClientRect().width, zoom };
        scheduleResetPrintLayout();
        S.schedulePrintSettings = null;
        return result;
      }, zoomLevel);
      const pdfBuf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      const pages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      await page.evaluate(() => { S.schedulePrintSettings = null; });
      // Absolute legibility floor, not a relative-share check — the width-fill feature (added after this
      // check was first written) can legitimately widen the GRID side too, shrinking the left share's
      // PERCENTAGE even though its absolute px (driven by the .sched-col-name min-width:170px print rule)
      // never shrank. min-width is a floor, not an exact value, so real width should be AT LEAST ~170*zoom.
      assert(propCheck.nameCellWidth >= 170*propCheck.zoom*0.95, `[zoom=${zoomLevel}] "รายละเอียดงาน" column stays at least at its 170px (unzoomed) min-width floor (zoom=${propCheck.zoom.toFixed(3)}, expected >= ${(170*propCheck.zoom*0.95).toFixed(1)}, got ${propCheck.nameCellWidth.toFixed(1)})`);
      assert(pages === 1, `[zoom=${zoomLevel}] A4+fit-page+normal still fits exactly 1 page after the column-width fix (got ${pages})`);
    }
    await page.evaluate(() => { S.scheduleZoom = 'week'; render(); });

    // ---- 13) REGRESSION GUARD: "fit page" must FILL the page, not just fit within it (reported: a real
    // screenshot showed a large blank strip on the right — zoom = min(zoomForWidth, zoomForHeight) means
    // whichever dimension isn't the binding constraint is left with unused slack by design, unless
    // something consumes it). Fix widens the day-grid's own cells (.sched-period-cell/.sched-grid-td/the
    // .sched-period-cell-spacer used by empty placeholder cells — an EMPTY <td>'s own explicit width is
    // NOT reliably honored by table-layout:auto, confirmed live, hence the spacer) to consume real
    // leftover width. Checked at 'month' zoom on this file's own 8-task fixture, where width is NOT the
    // binding constraint (few grid columns relative to 64 task rows) — real width should end up close to
    // (not far under) the printable target, and height must stay in budget.
    await page.evaluate(() => { S.scheduleZoom = 'month'; render(); });
    await page.waitForTimeout(200);
    const fillCheck = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const frame = document.getElementById('schedule-print-frame');
      const sized = scheduleMeasurePrintFrame(frame);
      const targetW = 297*96/25.4 - 2*15*96/25.4, targetH = 210*96/25.4 - 2*15*96/25.4;
      const result = { fillRatio: sized.w/targetW, realH: sized.h, targetH };
      scheduleResetPrintLayout();
      S.schedulePrintSettings = null;
      return result;
    });
    const pagesAfterFill = (await page.pdf({ printBackground: true, preferCSSPageSize: true })).toString('latin1').match(/\/Type\s*\/Page[^s]/g).length;
    assert(fillCheck.fillRatio > 0.9, `[month zoom, width not binding] fit-page real width reaches at least 90% of the printable target instead of leaving it blank (got ${(fillCheck.fillRatio*100).toFixed(1)}%)`);
    assert(fillCheck.realH <= fillCheck.targetH*1.02, `width-fill did not push height over budget (target ${fillCheck.targetH.toFixed(0)}, got ${fillCheck.realH.toFixed(0)})`);
    assert(pagesAfterFill === 1, `still exactly 1 page after width-fill (got ${pagesAfterFill})`);
    await page.evaluate(() => { S.scheduleZoom = 'week'; render(); });

    // ---- 14) REGRESSION GUARD: table lines print BLACK, S-curve line colors stay orange/sky (reported:
    // the table's normal --border/--border-strong light gray was too faint to read in print). Fix
    // redefines the --border/--border-strong CSS custom properties on #schedule-print-frame itself under
    // @media print — every border-left/border-bottom inline style in this table reads var(--border...),
    // so overriding the PROPERTY (not each declaration) cascades to all of them at once, print-only.
    await page.evaluate(() => { S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' }; render(); });
    await page.waitForTimeout(150);
    // NOTE: this whole file runs under emulateMedia('print') from check 4 onward (see the comment there) —
    // switch to 'screen' explicitly to get a genuine on-screen reading, then back to 'print' for the real check.
    await page.emulateMedia({ media: 'screen' });
    const onScreenBorder = await page.evaluate(() => getComputedStyle(document.querySelector('.sched-grid-td')).borderLeftColor);
    await page.emulateMedia({ media: 'print' });
    const lineColors = await page.evaluate(async () => {
      scheduleApplyPrintLayout();
      const gridBorder = getComputedStyle(document.querySelector('.sched-grid-td')).borderLeftColor;
      const svg = document.getElementById('schedule-chart-overlay');
      const plannedColor = getComputedStyle(svg.querySelector('polyline[data-scurve="planned"]')).stroke;
      const actualColor = getComputedStyle(svg.querySelector('polyline[data-scurve="actual"]')).stroke;
      scheduleResetPrintLayout();
      return { gridBorder, plannedColor, actualColor };
    });
    await page.evaluate(() => { S.schedulePrintSettings = null; });
    assert(onScreenBorder !== 'rgb(0, 0, 0)', `on-screen grid border stays the normal light color, untouched (got ${onScreenBorder})`);
    assert(lineColors.gridBorder === 'rgb(0, 0, 0)', `print-time grid cell border is black (got ${lineColors.gridBorder})`);
    assert(lineColors.plannedColor === 'rgb(194, 90, 40)', `S-curve แผนงาน line stays orange, not overridden to black (got ${lineColors.plannedColor})`);
    assert(lineColors.actualColor === 'rgb(46, 111, 163)', `S-curve ผลงาน line stays sky blue, not overridden to black (got ${lineColors.actualColor})`);

    // ---- 15) REGRESSION GUARD (2026-07-28 follow-up): the legend (แผนงาน/ผลงาน swatches + เส้นสะสม
    // line legend) and the "รายการ Task" heading/zoom-buttons row must be hidden in print — but, UNLIKE
    // the SEVENTH-round attempt this follow-up explicitly reverted, the underlying task DATA rows, the
    // S-curve overlay, and the surrounding card's data must all stay fully intact and print-visible. Also
    // checks the card's own decorative border is dropped (the "กรอบที่ครอบอยู่รอบตาราง" ask).
    await page.evaluate(() => { S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' }; render(); });
    await page.waitForTimeout(150);
    const chromeCheck = await page.evaluate(async () => {
      scheduleApplyPrintLayout();
      const legend = document.querySelectorAll('#task-table-section .no-print')[0];
      const sectionTitle = document.querySelector('#task-table-section .section-title');
      const taskRow = document.querySelector('.sched-task-row');
      const overlay = document.getElementById('schedule-chart-overlay');
      const cardBorder = getComputedStyle(document.getElementById('task-table-section')).borderStyle;
      const result = {
        legendDisplay: legend ? getComputedStyle(legend).display : null,
        sectionTitleDisplay: sectionTitle ? getComputedStyle(sectionTitle).display : null,
        taskRowDisplay: taskRow ? getComputedStyle(taskRow).display : null,
        overlayDisplay: getComputedStyle(overlay).display,
        cardBorder,
      };
      scheduleResetPrintLayout();
      S.schedulePrintSettings = null;
      return result;
    });
    assert(chromeCheck.legendDisplay === 'none', `legend (แผนงาน/ผลงาน + เส้นสะสม swatches) is hidden in print (got ${chromeCheck.legendDisplay})`);
    assert(chromeCheck.sectionTitleDisplay === 'none', `"รายการ Task" heading/zoom-buttons row is hidden in print (got ${chromeCheck.sectionTitleDisplay})`);
    assert(chromeCheck.taskRowDisplay !== 'none', `per-task DATA rows stay VISIBLE in print — only the header chrome around them was dropped, not the data itself (got ${chromeCheck.taskRowDisplay})`);
    assert(chromeCheck.overlayDisplay !== 'none', `the S-curve overlay stays VISIBLE in print (got ${chromeCheck.overlayDisplay})`);
    assert(chromeCheck.cardBorder === 'none', `the decorative card border/frame around the table is removed in print (got ${chromeCheck.cardBorder})`);

    // ---- 16) REGRESSION GUARD (2026-07-28, spec rewrite — supersedes the prior zoom-compensated version
    // of this check): the S-curve overlay's stroke-width is now a single FIXED SOURCE value (1.5px, set in
    // buildScheduleChartOverlaySvgContent(), shared identically by screen AND print — no print-only
    // compensation/override anywhere anymore, per explicit spec: "stroke-width: 1.5px คงที่ ... ไม่ scale
    // ตาม zoom level"). Checked across all 3 zoom levels to confirm the SOURCE value truly never changes
    // regardless of which zoom this particular print pass needs — the FINAL rendered size is a separate
    // concern this spec explicitly accepted riding the same `zoom` as everything else on the page (fonts,
    // borders), not something faked to stay pixel-identical across every paper size/zoom.
    for (const zoomLevel of ['day', 'week', 'month']) {
      await page.evaluate((z) => { S.scheduleZoom = z; render(); }, zoomLevel);
      await page.waitForTimeout(150);
      const strokeCheck = await page.evaluate(async (z) => {
        S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
        render();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        scheduleApplyPrintLayout();
        const svg = document.getElementById('schedule-chart-overlay');
        const strokeWidths = Array.from(svg.querySelectorAll('polyline[data-scurve]')).map(p => getComputedStyle(p).strokeWidth);
        const noOverrideStyleExists = !document.getElementById('schedule-print-stroke-style');
        scheduleResetPrintLayout();
        S.schedulePrintSettings = null;
        return { strokeWidths, noOverrideStyleExists };
      }, zoomLevel);
      assert(strokeCheck.strokeWidths.every(w => w === '1.5px'), `[zoom=${zoomLevel}] both S-curve lines use the fixed 1.5px source stroke-width in print, unchanged regardless of zoom (got ${JSON.stringify(strokeCheck.strokeWidths)})`);
      assert(strokeCheck.noOverrideStyleExists, `[zoom=${zoomLevel}] no print-only stroke-width override stylesheet exists anymore (the old zoom-compensation mechanism was removed entirely)`);
    }
    await page.evaluate(() => { S.scheduleZoom = 'week'; render(); });

    // ---- 17) REGRESSION GUARD: the font-size legibility compensation must NEVER make print worse than
    // before it existed — specifically, it must never increase the real page count (a bounded, self-
    // limiting bisection backs off to the safe flat 12px default whenever a bigger font would overflow;
    // an earlier, unbounded version of this fix pushed a typical project from 1 page to 2 purely from this
    // ordering bug). Also confirms the compensation is a genuine FLOOR, never SHRINKING an already-legible
    // effective size below the flat-12px default.
    for (const zoomLevel of ['day', 'week', 'month']) {
      await page.evaluate((z) => { S.scheduleZoom = z; render(); }, zoomLevel);
      await page.waitForTimeout(150);
      const fontCheck = await page.evaluate(async (z) => {
        S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
        render();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        scheduleApplyPrintLayout();
        const frame = document.getElementById('schedule-print-frame');
        const zoom = parseFloat(frame.style.zoom) || 1;
        const fontStyle = document.getElementById('schedule-print-font-style');
        const fontMatch = (fontStyle.textContent.match(/font-size:([\d.]+)px/) || [])[1];
        const sourceFontPx = fontMatch ? parseFloat(fontMatch) : 12;
        const result = { zoom, effectiveFontPx: sourceFontPx * zoom, defaultEffectiveFontPx: 12 * zoom };
        scheduleResetPrintLayout();
        S.schedulePrintSettings = null;
        return result;
      }, zoomLevel);
      const pdfBuf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      const pages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      await page.evaluate(() => { S.schedulePrintSettings = null; });
      assert(fontCheck.effectiveFontPx >= fontCheck.defaultEffectiveFontPx - 0.01, `[zoom=${zoomLevel}] legibility compensation never SHRINKS the effective font below the flat-12px default (default=${fontCheck.defaultEffectiveFontPx.toFixed(2)}px, got ${fontCheck.effectiveFontPx.toFixed(2)}px)`);
      assert(pages === 1, `[zoom=${zoomLevel}] A4+fit-page+normal still fits exactly 1 page after the legibility compensation (got ${pages})`);
    }
    await page.evaluate(() => { S.scheduleZoom = 'week'; render(); });

    // ---- 18) REGRESSION GUARD (2026-07-28, spec rewrite — exact edge-mapping, no inset): S-curve
    // coordinate mapping, checked with real hand-calculable coordinates (not just eyeballed) — the line
    // must start at the LAST task row's bottom edge (referenceBottom), at the START date column, and rise
    // to the FIRST task row's top edge (referenceTop, y=0 exactly), at the LAST date column (right edge,
    // x=w exactly). toY() now maps pct=0->height EXACTLY and pct=100->0 EXACTLY (the old padY inset was
    // removed — it only ever existed to keep now-deleted circle markers from half-clipping at the edges).
    await page.waitForTimeout(150);
    const mappingCheck = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const svg = document.getElementById('schedule-chart-overlay');
      const h = parseFloat(svg.style.height), w = parseFloat(svg.style.width);
      const poly = svg.querySelector('polyline[data-scurve="planned"]');
      const pts = poly.getAttribute('points').trim().split(' ').map(p => p.split(',').map(Number));
      const ctx = computeScheduleRenderContext();
      const curve = computeProjectSCurve(ctx.tasks, ctx.columns, ctx.totalBudget);
      const expectedFirstY = h * (1 - curve[0].planned / 100);
      const result = { h, w, firstPt: pts[0], lastPt: pts[pts.length - 1], firstPct: curve[0].planned, expectedFirstY };
      scheduleResetPrintLayout();
      S.schedulePrintSettings = null;
      return result;
    });
    // The first COLUMN's own planned% isn't necessarily exactly 0 (some progress may already be
    // auto-distributed by the end of the very first period) — checked against the hand-computed y for
    // whatever that real % actually is, not assumed to be the bottom edge.
    assert(Math.abs(mappingCheck.firstPt[1] - mappingCheck.expectedFirstY) < 0.5, `first point's y exactly matches toY(${mappingCheck.firstPct}%) — h*(1-pct/100) — no inset (expected y=${mappingCheck.expectedFirstY.toFixed(1)}, got y=${mappingCheck.firstPt[1].toFixed(1)})`);
    assert(mappingCheck.lastPt[1] === 0, `last (end-date) point sits EXACTLY at the overlay's top edge — the FIRST task row, y=0 (got y=${mappingCheck.lastPt[1].toFixed(1)})`);
    assert(Math.abs(mappingCheck.lastPt[0] - mappingCheck.w) < 1, `last point's x lands exactly at the overlay's right edge — the LAST date column (x=${mappingCheck.lastPt[0].toFixed(1)}, width=${mappingCheck.w.toFixed(1)})`);

    // ---- 19) REGRESSION GUARD (2026-07-28, reported against a real 32-task project): the overlay's
    // BOTTOM anchor must reach the true last row of the WHOLE task list, including any NOT-YET-SAVED rows
    // (pulled-but-unsaved BOQ items, or manual rows — newRowHtml()'s <tr class="sched-newrow">, always
    // rendered AFTER every .sched-task-row). Querying ONLY `.sched-task-row` for the bottom anchor (the
    // original implementation) stops short whenever such rows exist — reported as the line visually
    // "starting too high" (row ~28-29 instead of the true last row 32 on the user's own real project).
    // Reproduced here by adding manual unsaved rows via S.taskTableNewRows directly (same technique
    // "add-manual-task-row" itself uses) and checking the overlay's bottom edge against the REAL last
    // <tr> in the tbody (task rows + unsaved rows, excluding the total/summary rows below them).
    await page.evaluate(() => {
      S.taskTableNewRows = S.taskTableNewRows || [];
      for (let i = 0; i < 3; i++) {
        S.taskTableNewRows.push({ isManual: true, taskName: `งานใหม่ยังไม่บันทึก ${i+1}`, durationDays: 5, startDate: '', budgetAmount: 0 });
      }
      render();
    });
    await page.waitForTimeout(150);
    const unsavedRowCheck = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const main = document.getElementById('schedule-scroll-main');
      const svg = document.getElementById('schedule-chart-overlay');
      const newRows = main.querySelectorAll('.sched-newrow');
      const lastNewRow = newRows[newRows.length - 1];
      const trueLastRowBottom = lastNewRow.offsetTop + lastNewRow.offsetHeight;
      const svgBottom = parseFloat(svg.style.top) + parseFloat(svg.style.height);
      const result = { newRowCount: newRows.length, trueLastRowBottom, svgBottom, mismatch: Math.abs(svgBottom - trueLastRowBottom) };
      scheduleResetPrintLayout();
      S.schedulePrintSettings = null;
      return result;
    });
    assert(unsavedRowCheck.newRowCount === 3, `3 unsaved manual rows are present in the DOM (got ${unsavedRowCheck.newRowCount})`);
    assert(unsavedRowCheck.mismatch < 2, `overlay's bottom edge reaches the TRUE last row of the task list, including unsaved trailing rows, not just the last SAVED .sched-task-row (mismatch ${unsavedRowCheck.mismatch.toFixed(1)}px)`);
    // Clean up the unsaved rows so they don't leak into any later check in this file.
    await page.evaluate(() => { S.taskTableNewRows = (S.taskTableNewRows || []).filter(r => !r.isManual); render(); });

    assert(consoleErrors.length === 0, 'no console/page errors during the whole print flow — ' + JSON.stringify(consoleErrors));

    console.log(`\n${passed} checks passed.`);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (companyId) await pool.query('DELETE FROM customer_companies WHERE id=$1', [companyId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
