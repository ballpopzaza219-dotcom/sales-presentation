// Real-browser E2E coverage for the PR ⇄ Finance dual-module visibility refactor: PO/WO/subcontract
// billing/progress claims must appear in BOTH module sidebars (PR = operational view, Finance =
// accounting view), gated by the SAME permission rule in both places (DOC_GROUP_ACCESS in
// pr-system.html) instead of the old super_user-only cutoff. Also covers the loadDataForPage()
// extraction (single loader dispatch shared by both the 'nav' and 'switch-module' handlers — the
// exact bug class flagged by the user: "loader ไม่ทำงานเมื่อเข้าผ่าน switch-module ต่างจากเข้าผ่าน nav").
// Not part of `npm run test:client-ledger` — run standalone against a live local server.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `dualnav-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); passed++; console.log('  OK:', msg); }

const cookies = {};
async function call(username, method, urlPath, body, idempotencyKey) {
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function httpLogin(username, companyCode) { await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD }); }
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }

// ยืนยันว่า nav item (key ตรง data-page) ปรากฏ/ไม่ปรากฏใน sidebar ปัจจุบันตามที่คาดไว้
async function assertNavItem(page, key, shouldShow, label) {
  const count = await page.locator(`.nav-item[data-act="nav"][data-page="${key}"]`).count();
  if (shouldShow) assert(count === 1, `${label}: เห็นเมนู "${key}" จริง`);
  else assert(count === 0, `${label}: ไม่เห็นเมนู "${key}" (ไม่มีสิทธิ์)`);
}

(async () => {
  let browser;
  const consoleErrors = [];
  const createdProjectIds = [];
  const createdPoIds = [];
  const createdFundIds = [];
  const createdVoucherIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_procurement', companyCode);
    await httpLogin('fx_super', companyCode);
    await httpLogin('fx_approver_mid', companyCode);

    console.log('Creating prerequisite project + approved PO (for the cross-module same-page check)...');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E dual-module nav โครงการ', sectorType: 'private', status: 'in_progress' });
    createdProjectIds.push(proj.project.id);
    const po = await call('fx_maker', 'POST', '/api/customer/purchase-orders', {
      projectId: proj.project.id, supplierName: 'ร้าน dual-module nav E2E',
      items: [{ material: 'เหล็กเส้น', unit: 'เส้น', qty: 20, unitPrice: 300 }],
    }, idemKey('dualnav-po-create'));
    createdPoIds.push(po.purchaseOrder.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-orders/${po.purchaseOrder.id}/submit`, {}, idemKey('dualnav-po-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/purchase-orders/${po.purchaseOrder.id}/approve`, {}, idemKey('dualnav-po-approve'));
    const poId = po.purchaseOrder.id;

    console.log('Creating a petty cash fund via HTTP (for the switch-module loader-parity check)...');
    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'กองทุน E2E dual-module nav', fundLimit: 20000 });
    createdFundIds.push(fund.fund.id);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', d => d.accept());

    // ไม่ auto-switch module เหมือน test อื่น — งานนี้ต้องคุมโมดูลเองทีละสถานการณ์
    async function loginAs(username) {
      await page.goto(BASE + '/pr-system.html');
      await page.click('[data-act="go-login"]');
      await page.waitForTimeout(200);
      await page.fill('#f-loginCompanyCode', companyCode);
      await page.fill('#f-loginUser', username);
      await page.fill('#f-loginPass', PASSWORD);
      await page.click('[data-act="do-login"]');
      await page.waitForTimeout(700);
    }

    // ================= 1) fx_super — เห็นกลุ่มเอกสารปฏิบัติการทั้งใน PR และ Finance =================
    await loginAs('fx_super');
    await shot(page, 'super-pr-module');
    await assertNavItem(page, 'fin_po', true, 'fx_super/PR');
    await assertNavItem(page, 'fin_wo', true, 'fx_super/PR');
    await assertNavItem(page, 'subcontractors', true, 'fx_super/PR');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_super/PR');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_super/PR');
    // หัวข้อ 1 (เงินสดย่อย/เงินทดรองจ่าย/เคลียร์/เจ้าหนี้ภายนอก) ต้องเห็นในโมดูล PR ด้วยเช่นกัน (ตามโจทย์
    // ตั้งต้นที่ระบุว่าโมดูล PR ต้องมีครบทั้ง 5 หัวข้อ — พลาดไปรอบแรก แก้เพิ่มแล้ว)
    await assertNavItem(page, 'fin_petty_cash_funds', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_vouchers_petty_cash', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_vouchers_advance', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_advance_clearances', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_external_payees', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_vouchers_other', true, 'fx_super/PR (หัวข้อ 1)');
    await assertNavItem(page, 'fin_wht_certificates', true, 'fx_super/PR (หัวข้อ 1)');
    // หน้าบัญชี/ปิดงวดล้วนๆ ต้องไม่หลุดเข้ามาในโมดูล PR เด็ดขาด
    await assertNavItem(page, 'fin_overview', false, 'fx_super/PR (บัญชีล้วนๆ ต้องไม่อยู่ใน PR)');
    await assertNavItem(page, 'fin_journal', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_trial_balance', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_income_statement', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_balance_sheet', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_yearend', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_revenue', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_costs', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_stock', false, 'fx_super/PR');
    await assertNavItem(page, 'fin_cashbank', false, 'fx_super/PR');

    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(400);
    await shot(page, 'super-finance-module');
    await assertNavItem(page, 'fin_po', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_wo', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_vouchers_petty_cash', true, 'fx_super/Finance (หัวข้อ 1 ยังอยู่เหมือนเดิม)');
    // ของเดิม (บัญชี/ปิดงวดล้วนๆ) ต้องยังอยู่ครบเหมือนเดิม ไม่ได้หายไปตอน refactor
    await assertNavItem(page, 'fin_overview', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_journal', true, 'fx_super/Finance');
    await assertNavItem(page, 'fin_trial_balance', true, 'fx_super/Finance');

    // ================= 2) fx_procurement (can_manage_po=true, role=maker) — เห็นกลุ่มปฏิบัติการทั้ง 2 โมดูล แต่ไม่เห็นหน้าบัญชีล้วนๆ =================
    await loginAs('fx_procurement');
    await shot(page, 'procurement-pr-module');
    await assertNavItem(page, 'fin_po', true, 'fx_procurement/PR');
    await assertNavItem(page, 'fin_wo', true, 'fx_procurement/PR');
    await assertNavItem(page, 'subcontractors', true, 'fx_procurement/PR');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_procurement/PR');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_procurement/PR');
    await assertNavItem(page, 'fin_vouchers_petty_cash', true, 'fx_procurement/PR (หัวข้อ 1 เปิดทุกคน)');
    await assertNavItem(page, 'fin_advance_clearances', true, 'fx_procurement/PR (หัวข้อ 1 เปิดทุกคน)');

    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(400);
    await shot(page, 'procurement-finance-module');
    await assertNavItem(page, 'fin_po', true, 'fx_procurement/Finance (can_manage_po เปิดให้เห็นทั้ง 2 โมดูล)');
    await assertNavItem(page, 'fin_wo', true, 'fx_procurement/Finance');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_procurement/Finance');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_procurement/Finance');
    // บัญชี/ปิดงวดล้วนๆ ยังคง super_user-only เหมือนเดิม ไม่ได้เปิดตามไปด้วย
    await assertNavItem(page, 'fin_overview', false, 'fx_procurement/Finance (บัญชีล้วนๆ ยังปิดสำหรับ non-super_user)');
    await assertNavItem(page, 'fin_journal', false, 'fx_procurement/Finance');
    await assertNavItem(page, 'fin_stock', false, 'fx_procurement/Finance');
    // เห็นหมวดเงินสดย่อยของเดิมด้วย (ไม่ได้ถูกแทนที่)
    await assertNavItem(page, 'fin_vouchers_petty_cash', true, 'fx_procurement/Finance');

    // ================= 3) fx_maker (ไม่มี flag พิเศษ) — เห็นเฉพาะเอกสารที่ create เปิดทุกคน ไม่เห็น WO/subcontractors
    // (create WO ผูก can_manage_po ตาม hasSubcontractorManagePermission ที่ server.js — แต่ PO ไม่ผูก
    // เลยสักจุด เหมือน PR จึงต้องเห็น fin_po ด้วยแม้ไม่มี flag) =================
    await loginAs('fx_maker');
    await shot(page, 'maker-pr-module');
    await assertNavItem(page, 'fin_po', true, 'fx_maker/PR (create PO เปิดทุกคนเหมือน PR ไม่ผูก can_manage_po)');
    await assertNavItem(page, 'fin_wo', false, 'fx_maker/PR (ไม่มี can_manage_po)');
    await assertNavItem(page, 'subcontractors', false, 'fx_maker/PR');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_maker/PR (เปิดทุกคน)');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_maker/PR (เปิดทุกคน)');

    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(400);
    await shot(page, 'maker-finance-module');
    await assertNavItem(page, 'fin_po', true, 'fx_maker/Finance (เหมือนกับ PR module)');
    await assertNavItem(page, 'fin_wo', false, 'fx_maker/Finance');
    await assertNavItem(page, 'fin_subcontract_billings', true, 'fx_maker/Finance');
    await assertNavItem(page, 'fin_progress_claims', true, 'fx_maker/Finance');
    await assertNavItem(page, 'fin_vouchers_petty_cash', true, 'fx_maker/Finance (ของเดิมเปิดทุกคนอยู่แล้ว)');
    await assertNavItem(page, 'fin_overview', false, 'fx_maker/Finance');

    // ================= 4) หน้าเดียวกันจากคนละโมดูล ต้องโหลดข้อมูลเหมือนกัน (ใช้ fx_super ดู PO ใบเดียวกัน) =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_po"]'); // เข้าจากโมดูล PR (S.module ยังเป็น 'pr' อยู่)
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_po_detail"][data-id="${poId}"]`);
    await page.waitForTimeout(500);
    const poNoFromPr = (await page.locator('h2, h1').allTextContents()).join(' ');
    const supplierVisibleFromPr = await page.locator('text=ร้าน dual-module nav E2E').count();
    assert(supplierVisibleFromPr >= 1, 'เข้า fin_po_detail จากโมดูล PR แล้วเห็นข้อมูล PO จริง (ชื่อผู้ขาย)');
    assert(await page.locator('[data-act="switch-module"][data-module="pr"].active').count() === 1, 'เข้า fin_po_detail จากโมดูล PR แล้วยังอยู่โมดูล PR (ไม่ถูกสลับไป Finance)');
    await shot(page, 'po-detail-from-pr-module');

    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_po_detail"][data-id="${poId}"]`);
    await page.waitForTimeout(500);
    const supplierVisibleFromFinance = await page.locator('text=ร้าน dual-module nav E2E').count();
    assert(supplierVisibleFromFinance >= 1, 'เข้า fin_po_detail จากโมดูล Finance (PO ใบเดียวกัน) แล้วเห็นข้อมูลตรงกันทุกประการ (หน้าเดียวกัน ไม่ใช่ก๊อปคนละชุด)');
    await shot(page, 'po-detail-from-finance-module');

    // ================= 5) switch-module ต้อง trigger loader เดียวกับ nav (ไม่ใช่แค่กระโดดหน้าเปล่าๆ) =================
    // fx_maker เป็น non-super_user -> switch-module ไป finance กระโดดตรงไป fin_vouchers_petty_cash ทันที
    // โดยไม่ผ่าน act==='nav' เลย — ถ้า loadDataForPage() ไม่ถูกเรียก กองทุนที่เพิ่งสร้างจะไม่โผล่ใน dropdown
    await loginAs('fx_maker');
    await page.click('[data-act="switch-module"][data-module="finance"]');
    await page.waitForTimeout(500);
    assert(await page.locator('[data-act="switch-module"][data-module="finance"].active').count() === 1, 'switch-module ไป finance สำเร็จ (non-super_user ลงที่ fin_vouchers_petty_cash ตามที่ออกแบบไว้)');
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(300);
    const fundOptionCount = await page.locator(`#f-vFund option[value="${fund.fund.id}"]`).count();
    assert(fundOptionCount === 1, 'เข้า fin_vouchers_petty_cash ผ่านปุ่ม switch-module ตรงๆ (ไม่ผ่าน nav เลย) แล้ว dropdown กองทุนยังโหลดข้อมูลจริงมาได้ (พิสูจน์ loadDataForPage() ทำงานจาก switch-module เหมือนกับ nav)');
    await shot(page, 'switch-module-loader-parity');

    console.log('\nconsole errors during whole run:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)');
    const unexpectedErrors = consoleErrors.filter(e => !/404|400 \(Bad Request\)|403 \(Forbidden\)|409 \(Conflict\)/.test(e));
    assert(unexpectedErrors.length === 0, `ไม่มี JS error ที่ไม่คาดคิด (ได้ ${JSON.stringify(unexpectedErrors)})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nE2E TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (createdPoIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='purchase_order' AND doc_id = ANY($1)`, [createdPoIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'purchase-orders-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_purchase_order_items WHERE purchase_order_id = ANY($1)', [createdPoIds]);
        await pool.query('DELETE FROM client_purchase_orders WHERE id = ANY($1)', [createdPoIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      if (createdFundIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='petty_cash_fund' AND doc_id = ANY($1)`, [createdFundIds]).catch(() => {});
        await pool.query('DELETE FROM client_petty_cash_funds WHERE id = ANY($1)', [createdFundIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
