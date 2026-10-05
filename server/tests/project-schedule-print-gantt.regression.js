// Regression test for the Gantt-section print integration (Stage B item 4, Phase E) —
// scheduleMeasurePrintFrame()'s multi-table width measurement and updateGanttDependencyOverlay()'s own
// beforeprint/afterprint re-invocation. Separate file from the pre-existing
// project-schedule-print.regression.js (which covers the %-grid table's own print-fit math in detail and
// predates this feature — kept untouched) so this file's own setup can focus narrowly on what Phase E
// actually added: a 2nd <table> now genuinely participating in the SAME print frame, plus a dependency +
// baseline so the Gantt section has real content to measure/draw during the print transition.
//
// Same direct-call technique as project-schedule-print.regression.js (scheduleApplyPrintLayout()/
// scheduleResetPrintLayout() called directly rather than via a real OS print dialog, since Playwright
// can't fire that) — see that file's own header comment for why.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-print-gantt.regression.js

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
    const code = 'PPRG' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Print Gantt Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Print Gantt Test','project-schedule-print-gantt-test@example.com','_pprg_test_', $2, 'active', true)`,
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
    await page.fill('#f-loginUser', '_pprg_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบพิมพ์ Gantt', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // ---- Setup: 2 tasks (A -> B, FS dependency) + a baseline set on both, so the Gantt section has a
    // bar, a dependency arrow, AND a baseline ghost to measure/draw during the print transition — not
    // just an empty section.
    async function addTask(taskName, startDate) {
      return page.evaluate(async ({ pid, taskName, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName, durationDays: 5, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, taskName, startDate });
    }
    const today = ymd(new Date());
    const a = await addTask('A', today);
    const b = await addTask('B', addDays(today, 10));
    await page.evaluate(async ({ pid, taskId, dependsOnTaskId }) => {
      await apiCall('POST', `/api/customer/projects/${pid}/tasks/dependencies`, { taskId, dependsOnTaskId, dependencyType: 'FS', lagDays: 0 });
    }, { pid: projectId, taskId: b.id, dependsOnTaskId: a.id });
    await page.evaluate(async (pid) => { await apiCall('POST', `/api/customer/projects/${pid}/tasks/set-baseline`); }, projectId);

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(500);
    await page.waitForSelector('#schedule-print-frame', { timeout: 15000 });

    // ---- 1. Default view_mode='both' -> #gantt-section renders, no .no-print on its own outer card
    // (only its internal toolbar/legend keep it) — it's a real print participant now, not excluded.
    assert((await page.evaluate(() => S.scheduleViewMode)) === 'both', "default view mode is 'both'");
    assert((await page.locator('#gantt-section').count()) === 1, '#gantt-section renders in the default view');
    assert((await page.locator('#gantt-section.no-print').count()) === 0, "#gantt-section's outer card no longer carries .no-print");

    await page.emulateMedia({ media: 'print' });

    // ---- 2. scheduleApplyPrintLayout(): scheduleMeasurePrintFrame() now sees BOTH tables (the %-grid
    // table and the Gantt table) and takes the WIDER one — confirmed by comparing the computed frame
    // width against each table's own real rendered width directly.
    const result = await page.evaluate(async () => {
      S.schedulePrintSettings = { paperSize: 'A4', scaleMode: 'fit-page', margin: 'normal' };
      render();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scheduleApplyPrintLayout();
      const frame = document.getElementById('schedule-print-frame');
      const sized = scheduleMeasurePrintFrame(frame);
      const tables = [...frame.querySelectorAll('table')];
      const overlay = document.getElementById('gantt-dependency-overlay');
      return {
        zoom: parseFloat(frame.style.zoom),
        realW: sized.w, realH: sized.h,
        tableCount: tables.length,
        tableWidths: tables.map(t => t.getBoundingClientRect().width),
        overlayDisplay: overlay ? overlay.style.display : null,
        // Direct-child combinator — see project-schedule-dependency-ui.regression.js's own comment on why
        // a bare descendant selector would also match the arrowhead marker's own internal <path>.
        overlayArrowCount: overlay ? overlay.querySelectorAll(':scope > path').length : -1,
      };
    });
    assert(result.tableCount === 2, `both the %-grid table and the Gantt table are present inside the print frame (got ${result.tableCount})`);
    assert(Math.abs(result.realW - Math.max(...result.tableWidths)) < 1, `scheduleMeasurePrintFrame() returns the WIDER of the two tables' real widths (got realW=${result.realW}, table widths=${JSON.stringify(result.tableWidths)})`);
    assert(result.zoom > 0 && result.zoom <= 1, `fit-page zoom is still a sane fraction with the Gantt section included (got ${result.zoom})`);

    // ---- 3. The dependency-arrow overlay is re-measured/re-drawn at PRINT-TIME (zoomed) geometry, not
    // left showing stale screen-time state — confirmed by it being visible (not display:none, which is
    // what it'd show if updateGanttDependencyOverlay() never ran or found no bars after the zoom reflow)
    // and drawing exactly the 1 real A-depends-on-B arrow.
    assert(result.overlayDisplay === 'block', `dependency overlay is visible after print layout is applied (got display="${result.overlayDisplay}")`);
    assert(result.overlayArrowCount === 1, `dependency overlay draws exactly 1 arrow at print-time geometry (got ${result.overlayArrowCount})`);

    // ---- 4. scheduleResetPrintLayout() restores the on-screen overlay state too (not just the frame's
    // own inline style) — re-measuring once more should reflect normal (unzoomed) screen geometry again.
    await page.evaluate(() => { scheduleResetPrintLayout(); S.schedulePrintSettings = null; });
    const afterReset = await page.evaluate(() => {
      const frame = document.getElementById('schedule-print-frame');
      const overlay = document.getElementById('gantt-dependency-overlay');
      return { zoom: frame.style.zoom, width: frame.style.width, overlayDisplay: overlay ? overlay.style.display : null };
    });
    assert(afterReset.zoom === '' && afterReset.width === '', 'scheduleResetPrintLayout() clears the frame\'s inline print style');
    assert(afterReset.overlayDisplay === 'block', 'dependency overlay still renders correctly after reset (re-measured against normal screen geometry, not left blank)');

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
