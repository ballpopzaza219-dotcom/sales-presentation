// Regression test for the แผนงาน table's custom top+bottom horizontal scrollbars
// (wireScheduleScrollSync() in pr-system.html) — #schedule-scroll-top-track/#schedule-scroll-top-thumb
// and #schedule-scroll-bottom-track/#schedule-scroll-bottom-thumb are hand-drawn (not native browser
// scrollbar chrome, which some platforms render as an invisible-until-mid-gesture "overlay" scrollbar),
// kept in sync with #schedule-scroll-main's real scrollLeft in both directions, and draggable.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and Playwright's
// chromium browser must be installed.
// Run: cd server && node tests/project-schedule-scroll-sync.regression.js

const bcrypt = require('bcryptjs');
const path = require('path');
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
    const code = 'PSSS' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Project Schedule Scroll Sync Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Scroll Sync Test','project-schedule-scroll-sync-test@example.com','_psss_test_', $2, 'active', true)`,
      [companyId, hash]
    );

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    // Deliberately narrow viewport so a long day-zoom grid is guaranteed to overflow horizontally.
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', dialog => dialog.accept());

    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', '_psss_test_');
    await page.fill('#f-loginPass', 'TestPass123!');
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(800);

    projectId = await page.evaluate(async () => {
      const data = await apiCall('POST', '/api/customer/projects', {
        code: '', name: 'ทดสอบเลื่อนซ้ายขวา', clientName: '', tenderId: null, siteAddress: '',
        startDate: null, expectedEndDate: null, budgetAmount: 0, defaultRetentionPercent: null,
        projectManagerEmployeeId: null, foremanEmployeeId: null, status: 'in_progress', note: '',
        biddingMethod: '', sectorType: 'private', referencePrice: 0, phoneNumber: '', siteCoordinates: '',
        submissionOpenDate: null, submissionConditions: '', installments: [],
      });
      DB.projects.push(mapRealProject(data.project));
      return data.project.id;
    });

    // Several tasks with a long combined duration -> at 'day' zoom the grid is guaranteed to be much
    // wider than the 1000px viewport (many tasks, each contributing its own duration to the columns).
    const budgetId = await page.evaluate(async (pid) => {
      const data = await apiCall('POST', '/api/customer/budgets', { projectId: pid });
      return data.budget.id;
    }, projectId);
    const itemDefs = Array.from({ length: 6 }, (_, i) => ({
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

    // 6 tasks x 15 days each, sequential -> 90-day project range at 'day' zoom (definitely wider than
    // 1000px at ~28px/column: 90*28 = 2520px of grid alone, plus the left descriptive columns).
    await page.evaluate(async (pid) => {
      const tasks = S.projectTasks;
      let start = new Date('2026-08-01T00:00:00Z');
      for (const t of tasks) {
        const startStr = start.toISOString().slice(0, 10);
        await apiCall('PUT', `/api/customer/projects/${pid}/tasks/${t.id}`, { taskName: t.taskName, durationDays: 15, startDate: startStr });
        start = new Date(start.getTime() + 15 * 86400000);
      }
    }, projectId);
    await page.evaluate(async (pid) => { await loadProjectTasks(pid); }, projectId);
    await page.click('[data-act="set-schedule-zoom"][data-zoom="day"]');
    // Let any toast from the setup actions above (e.g. "pull-all-boq-items"'s "ดึงรายการ BOQ มาเพิ่ม...")
    // fully auto-dismiss before starting the drag assertions below. toast()'s dismiss timer calls
    // render() (see pr-system.html), which replaces the ENTIRE #app DOM — including mid-drag, this
    // orphans window.onmousemove's closure on a now-detached #schedule-scroll-main and silently drops
    // the rest of that drag (the same "full re-render can interrupt an in-progress interaction" class
    // of issue documented in feedback_full_page_form_state, just for a mouse gesture instead of a form
    // field). A real human drag finishes in well under a second and essentially never collides with
    // this; this test deliberately inspects state mid-drag with waitForTimeout()s in between, which is
    // slow enough to actually hit it — so drain any pending toast up front instead.
    await page.waitForTimeout(2800);

    // ---- 1. Both custom scrollbar tracks/thumbs exist, and the day-zoom grid is genuinely wider than
    // its visible container (real overflow, not a theoretical scrollbar).
    assert((await page.locator('#schedule-scroll-top-track').count()) === 1, '#schedule-scroll-top-track exists');
    assert((await page.locator('#schedule-scroll-top-thumb').count()) === 1, '#schedule-scroll-top-thumb exists');
    assert((await page.locator('#schedule-scroll-bottom-track').count()) === 1, '#schedule-scroll-bottom-track exists');
    assert((await page.locator('#schedule-scroll-bottom-thumb').count()) === 1, '#schedule-scroll-bottom-thumb exists');
    const { tableScrollWidth, mainClientWidth } = await page.evaluate(() => {
      const table = document.querySelector('#schedule-scroll-main table');
      const main = document.getElementById('schedule-scroll-main');
      return { tableScrollWidth: table.scrollWidth, mainClientWidth: main.clientWidth };
    });
    assert(tableScrollWidth > mainClientWidth + 50, `the day-zoom grid is genuinely wider than its visible container (scrollWidth=${tableScrollWidth}, visible=${mainClientWidth})`);

    // ---- 2. Both thumbs start at the same width and left position (both mirror the same main.scrollLeft=0).
    const initial = await page.evaluate(() => {
      const t = document.getElementById('schedule-scroll-top-thumb'), b = document.getElementById('schedule-scroll-bottom-thumb');
      return { topLeft: t.style.left, botLeft: b.style.left, topWidth: t.style.width, botWidth: b.style.width };
    });
    assert(initial.topLeft === '0px' && initial.botLeft === '0px', `both thumbs start at left:0px (got top=${initial.topLeft}, bottom=${initial.botLeft})`);
    assert(initial.topWidth === initial.botWidth && parseFloat(initial.topWidth) > 0, `both thumbs start at the same, non-zero width (got top=${initial.topWidth}, bottom=${initial.botWidth})`);

    // ---- 3. Dragging the TOP thumb with the mouse moves the real table content (main.scrollLeft) AND
    // the BOTTOM thumb follows to the same position.
    await page.locator('#schedule-scroll-top-thumb').scrollIntoViewIfNeeded();
    const topThumbBox = await page.locator('#schedule-scroll-top-thumb').boundingBox();
    await page.mouse.move(topThumbBox.x + topThumbBox.width / 2, topThumbBox.y + topThumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(topThumbBox.x + topThumbBox.width / 2 + 200, topThumbBox.y + topThumbBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    let mainScrollLeft = await page.evaluate(() => document.getElementById('schedule-scroll-main').scrollLeft);
    assert(mainScrollLeft > 0, `dragging the TOP thumb 200px to the right moved the real table content (scrollLeft=${mainScrollLeft})`);
    const afterTopDrag = await page.evaluate(() => ({
      top: document.getElementById('schedule-scroll-top-thumb').style.left,
      bot: document.getElementById('schedule-scroll-bottom-thumb').style.left,
    }));
    assert(afterTopDrag.top === afterTopDrag.bot, `after dragging the TOP thumb, the BOTTOM thumb moved to the exact same left position (top=${afterTopDrag.top}, bottom=${afterTopDrag.bot})`);

    // ---- 4. Dragging the BOTTOM thumb also moves the content, and the TOP thumb follows back.
    // scrollIntoViewIfNeeded() first — the bottom bar sits below a tall grid + the S-curve chart card,
    // easily below the viewport fold; Playwright's raw page.mouse API dispatches at absolute viewport
    // coordinates and silently hits nothing if the target's boundingBox() was measured off-screen.
    const scrollBeforeBottomDrag = mainScrollLeft;
    await page.locator('#schedule-scroll-bottom-thumb').scrollIntoViewIfNeeded();
    const botThumbBox = await page.locator('#schedule-scroll-bottom-thumb').boundingBox();
    await page.mouse.move(botThumbBox.x + botThumbBox.width / 2, botThumbBox.y + botThumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(botThumbBox.x + botThumbBox.width / 2 - 150, botThumbBox.y + botThumbBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    mainScrollLeft = await page.evaluate(() => document.getElementById('schedule-scroll-main').scrollLeft);
    assert(mainScrollLeft < scrollBeforeBottomDrag, `dragging the BOTTOM thumb 150px left moved the content back (scrollLeft ${scrollBeforeBottomDrag} -> ${mainScrollLeft})`);
    const afterBotDrag = await page.evaluate(() => ({
      top: document.getElementById('schedule-scroll-top-thumb').style.left,
      bot: document.getElementById('schedule-scroll-bottom-thumb').style.left,
    }));
    assert(afterBotDrag.top === afterBotDrag.bot, `after dragging the BOTTOM thumb, the TOP thumb followed to the same left position (top=${afterBotDrag.top}, bottom=${afterBotDrag.bot})`);

    // ---- 5. Scrolling the table directly (native wheel/trackpad path, bypassing both custom thumbs
    // entirely) still updates both thumbs — proves main.onscroll -> layout() covers every scroll
    // source, not just drags on the custom thumbs.
    await page.evaluate(() => {
      const main = document.getElementById('schedule-scroll-main');
      main.scrollLeft = 50;
      main.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    const afterNativeScroll = await page.evaluate(() => ({
      top: document.getElementById('schedule-scroll-top-thumb').style.left,
      bot: document.getElementById('schedule-scroll-bottom-thumb').style.left,
    }));
    assert(afterNativeScroll.top === afterNativeScroll.bot && parseFloat(afterNativeScroll.top) >= 0, `scrolling the table directly (not via a thumb) still moves both custom thumbs in sync (top=${afterNativeScroll.top}, bottom=${afterNativeScroll.bot})`);

    // ---- 6. Clicking on the track itself (not the thumb) jumps the scroll position.
    await page.locator('#schedule-scroll-top-track').scrollIntoViewIfNeeded();
    const trackBox = await page.locator('#schedule-scroll-top-track').boundingBox();
    await page.mouse.click(trackBox.x + trackBox.width - 20, trackBox.y + trackBox.height / 2);
    await page.waitForTimeout(150);
    const scrollAfterTrackClick = await page.evaluate(() => document.getElementById('schedule-scroll-main').scrollLeft);
    assert(scrollAfterTrackClick > 50, `clicking near the right end of the track jumps the scroll position forward (got ${scrollAfterTrackClick}, was 50)`);

    // ---- 7. Re-render (e.g. switching zoom) doesn't break the wiring — dragging still works afterward.
    await page.click('[data-act="set-schedule-zoom"][data-zoom="week"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById('schedule-scroll-main').scrollLeft = 0; document.getElementById('schedule-scroll-main').dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(100);
    await page.locator('#schedule-scroll-top-thumb').scrollIntoViewIfNeeded();
    const topThumbBox2 = await page.locator('#schedule-scroll-top-thumb').boundingBox();
    await page.mouse.move(topThumbBox2.x + topThumbBox2.width / 2, topThumbBox2.y + topThumbBox2.height / 2);
    await page.mouse.down();
    await page.mouse.move(topThumbBox2.x + topThumbBox2.width / 2 + 80, topThumbBox2.y + topThumbBox2.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    mainScrollLeft = await page.evaluate(() => document.getElementById('schedule-scroll-main').scrollLeft);
    assert(mainScrollLeft > 0, `dragging still works after a re-render (zoom switch) — wireScheduleScrollSync() is re-run every render (got scrollLeft=${mainScrollLeft})`);

    // Screenshot for the visual report — scrolled to a clearly non-zero, non-edge position so both the
    // top and bottom custom thumbs visibly show at the SAME position, provably in sync.
    await page.evaluate(() => {
      const main = document.getElementById('schedule-scroll-main');
      main.scrollLeft = 400;
      main.dispatchEvent(new Event('scroll'));
      document.getElementById('task-table-section').scrollIntoView();
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(__dirname, 'schedule-scroll-sync.png'), fullPage: false });

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
