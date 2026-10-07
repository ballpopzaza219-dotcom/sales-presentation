// Regression suite — can_manage_contracts / can_approve_contracts (migration 0036). This covers only
// the PERMISSION PIPE itself (grant/revoke round-trip, the UI columns in pageApprovalPermissions(), and
// the S.currentUser mapping at login) — NOT the Contract business endpoints, which do not exist yet
// (client_contracts has schema only so far, migration 0035). A separate test will exercise
// /api/customer/contracts/* once that code lands.
//
// Everything here goes through a real login (the actual login form, real HTTP session) — never
// page.evaluate() to inject a value directly into S.currentUser or elsewhere. The whole point of check
// (c) below is to catch exactly the class of bug where the server.js column exists and the DB value is
// correctly granted, but the frontend forgets to map it into S.currentUser at login (the flag then has
// zero effect anywhere in the UI even though granting it "worked" at the API level) — injecting the
// value directly would never catch that.
//
// Prerequisites: the dev server must already be running, migration 0036 applied, and Playwright's
// chromium browser installed.
// Run: cd server && node tests/contract-permission-flags-ui.regression.js

const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const PASSWORD = 'TestPass123!';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

(async () => {
  let companyId = null, superId = null, makerId = null, browser;
  try {
    const code = 'CTPERM' + Date.now();
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Contract Permission Flags Test Co', code]
    );
    companyId = companyIns.rows[0].id;
    const hash = await bcrypt.hash(PASSWORD, 10);
    const superUsername = 'ct_perm_super_' + Date.now() + '_';
    const makerUsername = 'ct_perm_maker_' + Date.now() + '_';
    const superIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, role)
       VALUES ($1,'Contract Perm Super',$2,$3,$4,'active','super_user') RETURNING id`,
      [companyId, `ctperm-super-${Date.now()}@example.com`, superUsername, hash]
    );
    superId = superIns.rows[0].id;
    const makerIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, role)
       VALUES ($1,'Contract Perm Maker',$2,$3,$4,'active','maker') RETURNING id`,
      [companyId, `ctperm-maker-${Date.now()}@example.com`, makerUsername, hash]
    );
    makerId = makerIns.rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    // ---- login as super_user through the REAL login form ----
    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="go-login"]');
    await page.waitForSelector('#f-loginCompanyCode');
    await page.fill('#f-loginCompanyCode', code);
    await page.fill('#f-loginUser', superUsername);
    await page.fill('#f-loginPass', PASSWORD);
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(500);

    // ============================================================================================
    // (a) grant/revoke round-trip via PUT /api/customer/users/:id/permission-flags for BOTH flags —
    // through the browser's own authenticated session (apiCall() already defined by the app, not a
    // bypass), matching the project-schedule UI tests' established pattern this session.
    // ============================================================================================
    console.log('\n=== (a) grant/revoke round-trip for both flags ===');
    await page.evaluate(async (id) => {
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_manage_contracts', value: true });
    }, makerId);
    let row = (await pool.query('SELECT can_manage_contracts, can_approve_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_manage_contracts === true, `can_manage_contracts granted -> true in DB (got ${row.can_manage_contracts})`);
    assert(row.can_approve_contracts === false, `can_approve_contracts untouched, still false (got ${row.can_approve_contracts})`);

    await page.evaluate(async (id) => {
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_approve_contracts', value: true });
    }, makerId);
    row = (await pool.query('SELECT can_manage_contracts, can_approve_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_approve_contracts === true, `can_approve_contracts granted -> true in DB (got ${row.can_approve_contracts})`);

    await page.evaluate(async (id) => {
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_manage_contracts', value: false });
    }, makerId);
    row = (await pool.query('SELECT can_manage_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_manage_contracts === false, `can_manage_contracts revoked -> false in DB (got ${row.can_manage_contracts})`);

    await page.evaluate(async (id) => {
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_approve_contracts', value: false });
    }, makerId);
    row = (await pool.query('SELECT can_approve_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_approve_contracts === false, `can_approve_contracts revoked -> false in DB (got ${row.can_approve_contracts})`);

    // ============================================================================================
    // (b) the UI columns exist in pageApprovalPermissions() and real clicks on the grant/revoke
    // buttons actually change the DB value — not just the API round-trip above.
    // ============================================================================================
    console.log('\n=== (b) UI columns render + real click grants/revokes, verified in DB ===');
    await page.evaluate(async () => { await goToPage('approval_permissions'); });
    await page.waitForTimeout(400);
    assert(await page.locator('th', { hasText: 'สิทธิ์จัดการสัญญา' }).count() > 0, 'column header "สิทธิ์จัดการสัญญา" (can_manage_contracts) is rendered');
    assert(await page.locator('th', { hasText: 'สิทธิ์อนุมัติสัญญา' }).count() > 0, 'column header "สิทธิ์อนุมัติสัญญา" (can_approve_contracts) is rendered');

    const manageBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${makerId}"][data-column="can_manage_contracts"]`);
    await manageBtn.waitFor({ state: 'visible' });
    assert((await manageBtn.textContent()).trim() === 'มอบสิทธิ์', `grant button shows "มอบสิทธิ์" before granting (got "${(await manageBtn.textContent()).trim()}")`);
    await manageBtn.click();
    await page.waitForTimeout(400);
    row = (await pool.query('SELECT can_manage_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_manage_contracts === true, `clicking the grant button for can_manage_contracts actually set it true in DB (got ${row.can_manage_contracts})`);

    const approveBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${makerId}"][data-column="can_approve_contracts"]`);
    await approveBtn.click();
    await page.waitForTimeout(400);
    row = (await pool.query('SELECT can_approve_contracts FROM customers WHERE id=$1', [makerId])).rows[0];
    assert(row.can_approve_contracts === true, `clicking the grant button for can_approve_contracts actually set it true in DB (got ${row.can_approve_contracts})`);

    // ============================================================================================
    // (c) a FRESH, REAL login (new browser context, real form, no injected state) as the maker user
    // who now has both flags -- S.currentUser.canManageContracts/canApproveContracts must be true.
    // This is the check that would have caught a missing mapping line in the login handler.
    // ============================================================================================
    console.log('\n=== (c) fresh real login as the granted user -> S.currentUser mapping is correct ===');
    const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page2.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page2.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    await page2.goto(BASE + '/pr-system.html');
    await page2.click('[data-act="go-login"]');
    await page2.waitForSelector('#f-loginCompanyCode');
    await page2.fill('#f-loginCompanyCode', code);
    await page2.fill('#f-loginUser', makerUsername);
    await page2.fill('#f-loginPass', PASSWORD);
    await page2.click('[data-act="do-login"]');
    await page2.waitForTimeout(500);
    const currentUser = await page2.evaluate(() => S.currentUser);
    assert(currentUser && currentUser.canManageContracts === true, `S.currentUser.canManageContracts is true after real login (got ${JSON.stringify(currentUser && currentUser.canManageContracts)})`);
    assert(currentUser && currentUser.canApproveContracts === true, `S.currentUser.canApproveContracts is true after real login (got ${JSON.stringify(currentUser && currentUser.canApproveContracts)})`);
    await page2.close();

    // ---- revert both flags so repeated runs of this file don't drift fixture state, then re-verify ----
    await page.evaluate(async (id) => {
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_manage_contracts', value: false });
      await apiCall('PUT', `/api/customer/users/${id}/permission-flags`, { column: 'can_approve_contracts', value: false });
    }, makerId);

    // ============================================================================================
    // (d) no unexpected console/page errors across the entire run
    // ============================================================================================
    assert(consoleErrors.length === 0, `no unexpected console/page errors across the entire test (got: ${consoleErrors.join(' | ')})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (companyId) {
      await pool.query(`DELETE FROM client_document_audit_log WHERE performed_by IN (SELECT id FROM customers WHERE company_id=$1)`, [companyId]);
      await pool.query(`DELETE FROM customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [companyId]);
    }
    await pool.end();
  }
})();
