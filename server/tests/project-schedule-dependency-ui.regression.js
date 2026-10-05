// Regression test for the restored dependency add/remove UI + arrow overlay (Stage B item 4, Phase C) —
// pr-system.html's "task-dependencies" modal, the #gantt-dependency-overlay SVG, and
// updateGanttDependencyOverlay()/buildGanttDependencyArrowsSvgContent(). Does NOT re-test cycle-rejection
// or orphan-clearing correctness at the API level — project-tasks-cpm.regression.js already covers that
// exhaustively and correctly (see its own header comment). This file tests only the UI built on top of
// that already-correct backend.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-dependency-ui.regression.js

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
    const code = 'PDEP' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Dependency UI Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status)
       VALUES ($1,'Dependency UI Test','project-schedule-dependency-ui-test@example.com','_pdep_test_', $2, 'active')`,
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
    await page.fill('#f-loginUser', '_pdep_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const cust = await apiCall('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ' });
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบ dependency UI', customerId: cust.customer.id, tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    async function addTask(taskName, startDate) {
      return page.evaluate(async ({ pid, taskName, startDate }) => {
        const data = await apiCall('POST', `/api/customer/projects/${pid}/tasks`, { parentTaskId: null, taskName, durationDays: 3, startDate, isMilestone: false });
        return data.task;
      }, { pid: projectId, taskName, startDate });
    }
    const a = await addTask('A', '2026-08-01');
    const b = await addTask('B', '2026-08-01');
    const c = await addTask('C', '2026-08-01');

    await page.evaluate((pid) => { S.module = 'bidding'; S.page = 'fin_project_schedule'; S.selectedProjectId = pid; render(); }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.waitForTimeout(300);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    await page.waitForTimeout(150);

    // ---- 1. No dependencies yet -> no arrow paths in the overlay.
    assert((await page.locator('#gantt-dependency-overlay > path').count()) === 0, 'no dependency arrows before any dependency exists');

    // ---- 2. Open B's dependency modal, add B depends-on A (FS, lag 0) via the UI.
    await page.click(`[data-act="open-task-dependencies"][data-id="${b.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.selectOption('.modal select >> nth=0', String(a.id));
    await page.click('[data-act="confirm-add-task-dependency"]');
    await page.waitForTimeout(400);
    assert((await page.locator('.modal [data-act="remove-task-dependency"]').count()) === 1, 'B now lists exactly 1 predecessor (A) in the modal, still open after adding');
    const depId = await page.locator('.modal [data-act="remove-task-dependency"]').getAttribute('data-dep-id');
    assert(!!depId, 'the newly-added dependency row carries a real dep id for removal');
    // data-act="close-modal" has no handler yet (ข.14, a pre-existing known limitation unrelated to this
    // feature) — close the modal directly via S.modal=null instead of relying on the broken button.
    await page.evaluate(() => { S.modal = null; render(); });

    // ---- 3. The overlay now draws exactly 1 arrow (B depends on A). Direct-child combinator (not a bare
    // descendant selector) deliberately excludes the <path> INSIDE <defs><marker> (the arrowhead triangle
    // shape itself is also a <path> element, nested two levels deep — a bare "svg path" selector would
    // over-count by 1 the moment any dependency exists at all).
    await page.waitForTimeout(400);
    assert((await page.locator('#gantt-dependency-overlay > path').count()) === 1, 'exactly 1 dependency arrow renders after adding B-depends-on-A');

    // ---- 4. Add C depends-on B too (2nd arrow).
    await page.click(`[data-act="open-task-dependencies"][data-id="${c.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.selectOption('.modal select >> nth=0', String(b.id));
    await page.click('[data-act="confirm-add-task-dependency"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => { S.modal = null; render(); });
    await page.waitForTimeout(200);
    assert((await page.locator('#gantt-dependency-overlay > path').count()) === 2, 'exactly 2 dependency arrows render after adding C-depends-on-B too');

    // ---- 5. Attempting a cyclic dependency (A depends on C, closing A->B->C->A) is rejected by the
    // server, surfaced via toast, and does NOT add a 3rd arrow.
    await page.click(`[data-act="open-task-dependencies"][data-id="${a.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.selectOption('.modal select >> nth=0', String(c.id));
    await page.click('[data-act="confirm-add-task-dependency"]');
    await page.waitForTimeout(400);
    const toastType = await page.evaluate(() => S.toast && S.toast.type);
    assert(toastType === 'err', `server's cycle-rejection is surfaced as an error toast (got toast type "${toastType}")`);
    assert((await page.locator('.modal [data-act="remove-task-dependency"]').count()) === 0, "A's dependency list is still empty — the cyclic add was rejected, not silently accepted");
    await page.evaluate(() => { S.modal = null; render(); });
    await page.waitForTimeout(200);
    assert((await page.locator('#gantt-dependency-overlay > path').count()) === 2, 'still exactly 2 arrows — the rejected cyclic attempt did not get drawn');

    // ---- 6. Remove the B-depends-on-A dependency via the UI -> back down to 1 arrow.
    await page.click(`[data-act="open-task-dependencies"][data-id="${b.id}"]`);
    await page.waitForSelector('.modal[data-stop="1"]');
    await page.click(`[data-act="remove-task-dependency"][data-dep-id="${depId}"]`);
    await page.waitForTimeout(400);
    assert((await page.locator('.modal [data-act="remove-task-dependency"]').count()) === 0, "B's dependency list is empty again after removing it");
    await page.evaluate(() => { S.modal = null; render(); });
    await page.waitForTimeout(200);
    // 0, not 1 — removing B's only predecessor triggers the orphan-clearing rule (DELETE
    // .../tasks/dependencies/:depId nulls B's now-anchorless start/end dates), which CASCADES forward
    // through applyAutoSchedule: C still depends on B, but B has no dates anymore, so C becomes
    // unscheduled too (see project-tasks-cpm.regression.js's own orphan-clearing-cascade coverage for the
    // exact same B->C chain at the API level). Neither B nor C has a bar to anchor an arrow to anymore,
    // so the still-existing C-depends-on-B dependency row can't be drawn at all — correctly reflecting
    // "this relationship exists but neither side is scheduled right now," not a UI bug.
    assert((await page.locator('#gantt-dependency-overlay > path').count()) === 0, 'no arrows left — removing B-depends-on-A cascades to unschedule C too, so the remaining C-depends-on-B edge has no bar to draw itself against');
    const bTask = await page.evaluate(async (pid) => (await apiCall('GET', `/api/customer/projects/${pid}/tasks`)).tasks.find(t=>t.taskName==='B'), projectId);
    assert(bTask.startDate === null, 'confirms via the API that B really did become unscheduled (not a stale UI read)');

    // "Failed to load resource... 400" is the browser's own benign console entry for the deliberately-
    // rejected cyclic dependency POST in step 5 (same filter convention as project-schedule-periods.
    // regression.js's own intentional-400 scenario) — not a real unexpected error.
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
