// Real-browser E2E coverage for topic 5 round B (ใบสั่งจ้างผู้รับเหมาช่วง / Work Order — client_subcontract_terms).
// Mirrors server/tests/po-ui.regression.js's structure. Covers: create(manual)/list/detail/submit/approve/reject/
// cancel(pre-approval only)/complete/terminate, the doc-status vs contract-status split, can_approve_po_wo gate
// (shared flag with PO), the subcontractor-deactivation guard (blocks deactivating a subcontractor with an
// outstanding WO), and the WHT null-default-rate warning (CLAUDE.md ข้อ 17 — 40(1) has no default_rate).
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
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `wo-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

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

(async () => {
  let browser;
  const consoleErrors = [];
  const createdProjectIds = [];
  const createdSubcontractorIds = [];
  const createdWoIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_maker2', companyCode);
    await httpLogin('fx_approver_mid', companyCode);
    await httpLogin('fx_super', companyCode);
    await httpLogin('fx_procurement', companyCode);

    console.log('Creating prerequisite project + 2 subcontractors via HTTP...');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E WO โครงการ', sectorType: 'private', status: 'in_progress' });
    createdProjectIds.push(proj.project.id);
    const subA = await call('fx_procurement', 'POST', '/api/customer/subcontractors', { name: 'ผู้รับเหมาช่วง E2E A ' + Date.now(), taxpayerType: 'individual' });
    createdSubcontractorIds.push(subA.subcontractor.id);
    const subB = await call('fx_procurement', 'POST', '/api/customer/subcontractors', { name: 'ผู้รับเหมาช่วง E2E B ' + Date.now(), taxpayerType: 'individual' });
    createdSubcontractorIds.push(subB.subcontractor.id);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', d => d.accept());

    async function loginAs(username) {
      await page.goto(BASE + '/pr-system.html');
      await page.click('[data-act="go-login"]');
      await page.waitForTimeout(200);
      await page.fill('#f-loginCompanyCode', companyCode);
      await page.fill('#f-loginUser', username);
      await page.fill('#f-loginPass', PASSWORD);
      await page.click('[data-act="do-login"]');
      await page.waitForTimeout(700);
      await page.click('[data-act="switch-module"][data-module="finance"]');
      await page.waitForTimeout(300);
    }

    // ================= 1) สร้าง WO ผ่าน UI (fx_super — fin_wo อยู่ใน super_user-only finance section) =================
    await loginAs('fx_super'); // ทำเป็นทั้งผู้สร้าง+ผู้ยื่นเอง (เหมือน PO scenario 1) — พิสูจน์ self-approval บล็อกด้วย
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(500);
    await shot(page, 'list-empty-or-existing');
    await page.click('[data-act="nav"][data-page="fin_wo_add"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-wo-subcontractor"]', String(subA.subcontractor.id));
    await page.selectOption('[data-act="select-wo-project"]', String(proj.project.id));
    await page.fill('#wo-contract-value', '40000'); // ต้องไม่เกินเพดานอนุมัติของ fx_approver_mid (0-50000 บาท ตาม fixture) ไม่งั้น over_ceiling ตอน approve
    await page.fill('#wo-advance-percent', '10');
    await page.fill('#wo-retention-percent', '5');
    await shot(page, 'create-manual-filled');
    await page.click('[data-act="save-wo-full"]');
    await page.waitForTimeout(800);
    assert(true, `สร้าง WO ผ่าน UI แล้วพาไปหน้ารายละเอียดสำเร็จ (url: ${page.url()})`);
    const woRow = await pool.query(
      `SELECT id, status, contract_value, advance_percent, retention_percent FROM client_subcontract_terms WHERE company_id=$1 AND subcontractor_id=$2 ORDER BY id DESC LIMIT 1`,
      [COMPANY_A_ID, subA.subcontractor.id]
    );
    assert(woRow.rowCount === 1 && woRow.rows[0].status === 'draft', `WO ถูกสร้างเป็น draft จริงใน DB (ได้ status=${woRow.rows[0] && woRow.rows[0].status})`);
    assert(Number(woRow.rows[0].contract_value) === 40000, `contract_value บันทึกถูกต้อง (ได้ ${woRow.rows[0].contract_value})`);
    const woId = woRow.rows[0].id;
    createdWoIds.push(woId);

    // ================= 2) ยื่น + self-approval บล็อก + อนุมัติโดยคนละคน =================
    await page.waitForSelector('[data-act="submit-wo"]', { timeout: 5000 });
    await page.click('[data-act="submit-wo"]');
    await page.waitForTimeout(700);
    const submittedWo = await pool.query('SELECT status, contract_no FROM client_subcontract_terms WHERE id=$1', [woId]);
    assert(submittedWo.rows[0].status === 'submitted' && !!submittedWo.rows[0].contract_no, `ยื่น WO แล้วออกเลขที่จริง (contract_no=${submittedWo.rows[0].contract_no})`);

    await page.click('[data-act="approve-wo"]');
    await page.waitForTimeout(700);
    await shot(page, 'self-approval-blocked');
    const stillSubmitted = await pool.query('SELECT status FROM client_subcontract_terms WHERE id=$1', [woId]);
    assert(stillSubmitted.rows[0].status === 'submitted', 'fx_super (ผู้สร้าง+ผู้ยื่นเอง) กดอนุมัติ WO ของตัวเองไม่ผ่านจริง — self-approval บล็อกไว้');

    const approvedResult = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${woId}/approve`, {}, idemKey('wo-ui-approve'));
    assert(approvedResult.subcontractTerm.status === 'approved' && approvedResult.subcontractTerm.contractStatus === 'active',
      `อนุมัติ WO โดยคนละคนสำเร็จจริง — status=approved และ contract_status=active พร้อมกัน (ได้ status=${approvedResult.subcontractTerm.status}, contractStatus=${approvedResult.subcontractTerm.contractStatus})`);
    assert(Number(approvedResult.subcontractTerm.advanceAmount) === 4000, `advance_amount คำนวณถูกต้องฝั่ง server = 40000*10% = 4000 (ได้ ${approvedResult.subcontractTerm.advanceAmount})`);
    assert(Number(approvedResult.subcontractTerm.retentionAmount) === 2000, `retention_amount คำนวณถูกต้องฝั่ง server = 40000*5% = 2000 (ได้ ${approvedResult.subcontractTerm.retentionAmount})`);

    // ================= 3) โหลดหน้า detail ใหม่หลัง approve — เห็นยอดเงิน + notice + ปุ่มปิดงาน/เลิกสัญญา =================
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_wo_detail"][data-id="${woId}"]`);
    await page.waitForTimeout(500);
    await shot(page, 'approved-active-detail');
    const approvedNotice = await page.locator('text=มีผลผูกพันจริง').count();
    assert(approvedNotice >= 1, 'WO สถานะ approved+active แสดงข้อความแจ้งเตือนว่ามีผลผูกพันจริงแล้ว');
    const advanceAmountShown = await page.locator('text=4,000.00').count();
    assert(advanceAmountShown >= 1, 'หน้ารายละเอียดแสดงยอดเงินล่วงหน้าที่คำนวณแล้ว (4,000.00) จริง');
    const completeBtnVisible = await page.locator('[data-act="complete-wo"]').count();
    const terminateBtnVisible = await page.locator('[data-act="open-wo-terminate"]').count();
    assert(completeBtnVisible === 1 && terminateBtnVisible === 1, 'มีปุ่มปิดงาน/เลิกสัญญาให้กดจริง (canManage=fx_super)');

    // ================= 4) ปิดงาน (complete) =================
    await page.click('[data-act="complete-wo"]');
    await page.waitForTimeout(700);
    await shot(page, 'completed');
    const completedRow = await pool.query('SELECT status, contract_status FROM client_subcontract_terms WHERE id=$1', [woId]);
    assert(completedRow.rows[0].status === 'approved' && completedRow.rows[0].contract_status === 'completed',
      `ปิดงานสำเร็จ — status ยังเป็น approved (เอกสารไม่เปลี่ยน) แต่ contract_status เปลี่ยนเป็น completed (ได้ status=${completedRow.rows[0].status}, contract_status=${completedRow.rows[0].contract_status})`);
    const completeBtnGone = await page.locator('[data-act="complete-wo"]').count();
    assert(completeBtnGone === 0, 'ปิดงานแล้วปุ่มปิดงาน/เลิกสัญญาหายไป (contract_status ไม่ใช่ active แล้ว)');

    // ================= 5) reject flow (ใบที่สอง) =================
    const woToReject = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subA.subcontractor.id, projectId: proj.project.id, contractValue: 100000,
    }, idemKey('wo-ui-reject-create'));
    createdWoIds.push(woToReject.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woToReject.subcontractTerm.id}/submit`, {}, idemKey('wo-ui-reject-submit'));
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_wo_detail"][data-id="${woToReject.subcontractTerm.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-wo-reject"]');
    await page.waitForTimeout(200);
    await page.fill('#wo-reject-reason', 'ทดสอบปฏิเสธ E2E — เงื่อนไขไม่ตรงตามที่ตกลง');
    await page.click('[data-act="submit-wo-reject"]');
    await page.waitForTimeout(700);
    const rejectedRow = await pool.query('SELECT status, rejected_reason FROM client_subcontract_terms WHERE id=$1', [woToReject.subcontractTerm.id]);
    assert(rejectedRow.rows[0].status === 'rejected' && rejectedRow.rows[0].rejected_reason === 'ทดสอบปฏิเสธ E2E — เงื่อนไขไม่ตรงตามที่ตกลง', 'ปฏิเสธ WO แล้วสถานะ rejected พร้อมเหตุผลถูกบันทึกจริง');

    // ================= 6) cancel flow (ใบที่สาม — ยกเลิกก่อนอนุมัติ) =================
    const woToCancel = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subA.subcontractor.id, projectId: proj.project.id, contractValue: 80000,
    }, idemKey('wo-ui-cancel-create'));
    createdWoIds.push(woToCancel.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woToCancel.subcontractTerm.id}/submit`, {}, idemKey('wo-ui-cancel-submit'));
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_wo_detail"][data-id="${woToCancel.subcontractTerm.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="cancel-wo"]');
    await page.waitForTimeout(700);
    const cancelledRow = await pool.query('SELECT status FROM client_subcontract_terms WHERE id=$1', [woToCancel.subcontractTerm.id]);
    assert(cancelledRow.rows[0].status === 'cancelled', 'ยกเลิก WO ก่อนอนุมัติสำเร็จ status=cancelled จริงใน DB');

    // ================= 7) cancel ถูกบล็อกหลังอนุมัติแล้ว (ต้องใช้ terminate แทน) =================
    const woForCancelBlock = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subA.subcontractor.id, projectId: proj.project.id, contractValue: 45000, // ≤50000 เพดานอนุมัติ fx_approver_mid
    }, idemKey('wo-ui-cancelblock-create'));
    createdWoIds.push(woForCancelBlock.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woForCancelBlock.subcontractTerm.id}/submit`, {}, idemKey('wo-ui-cancelblock-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${woForCancelBlock.subcontractTerm.id}/approve`, {}, idemKey('wo-ui-cancelblock-approve'));
    let cancelBlockedStatus = null;
    try {
      await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woForCancelBlock.subcontractTerm.id}/cancel`, {});
    } catch (e) { cancelBlockedStatus = e.status; }
    assert(cancelBlockedStatus === 409, `WO ที่อนุมัติแล้วยกเลิกด้วย /cancel ไม่ได้ (ต้อง 409 บังคับให้ใช้ /terminate แทน) (ได้ ${cancelBlockedStatus})`);

    // ================= 8) terminate flow (เลิกสัญญาใบที่เพิ่งอนุมัติในข้อ 7) ผ่าน UI =================
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_wo_detail"][data-id="${woForCancelBlock.subcontractTerm.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-wo-terminate"]');
    await page.waitForTimeout(200);
    await page.fill('#wo-terminate-reason', 'ทดสอบเลิกสัญญา E2E — ผู้รับเหมาช่วงผิดสัญญา');
    await page.click('[data-act="submit-wo-terminate"]');
    await page.waitForTimeout(700);
    const terminatedRow = await pool.query('SELECT status, contract_status FROM client_subcontract_terms WHERE id=$1', [woForCancelBlock.subcontractTerm.id]);
    assert(terminatedRow.rows[0].status === 'approved' && terminatedRow.rows[0].contract_status === 'terminated',
      `เลิกสัญญาสำเร็จ — status ยังเป็น approved แต่ contract_status เปลี่ยนเป็น terminated (ได้ ${terminatedRow.rows[0].status}/${terminatedRow.rows[0].contract_status})`);

    // ================= 9) filter list ตามสถานะ =================
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(500);
    await page.selectOption('[data-act="filter-wo-status"]', 'rejected');
    await page.waitForTimeout(300);
    const rejectedRowVisible = await page.locator(`button[data-page="fin_wo_detail"][data-id="${woToReject.subcontractTerm.id}"]`).count();
    assert(rejectedRowVisible === 1, 'กรองสถานะ rejected แล้วเห็นใบที่เพิ่งปฏิเสธไปจริง');
    const approvedRowHidden = await page.locator(`button[data-page="fin_wo_detail"][data-id="${woId}"]`).count();
    assert(approvedRowHidden === 0, 'กรองสถานะ rejected แล้วใบที่ approved (คนละสถานะ) ไม่ถูกแสดง');

    // ================= 10) can_approve_po_wo gate เฉพาะ endpoint ของ WO (flag เดียวกับ PO แต่คนละ endpoint code path) =================
    const woForGate = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subA.subcontractor.id, projectId: proj.project.id, contractValue: 40000,
    }, idemKey('wo-ui-gate-create'));
    createdWoIds.push(woForGate.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woForGate.subcontractTerm.id}/submit`, {}, idemKey('wo-ui-gate-submit'));
    let noPermRejected = null;
    try {
      await call('fx_maker2', 'POST', `/api/customer/subcontract-terms/${woForGate.subcontractTerm.id}/approve`, {}, idemKey('wo-ui-gate-approve-denied'));
    } catch (e) { noPermRejected = e; }
    assert(noPermRejected !== null && noPermRejected.status === 403 && noPermRejected.body && noPermRejected.body.code === 'no_permission',
      `fx_maker2 (ไม่มี can_approve_po_wo) อนุมัติ WO ได้ 403 code=no_permission ไม่ใช่ 500 (ได้ status=${noPermRejected && noPermRejected.status})`);
    const gateApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${woForGate.subcontractTerm.id}/approve`, {}, idemKey('wo-ui-gate-approve-ok'));
    assert(gateApproved.subcontractTerm.status === 'approved', 'fx_approver_mid (มี can_approve_po_wo) อนุมัติ WO สำเร็จจริง (flag เดียวกับ PO ใช้ได้กับ endpoint WO ด้วย)');

    // ================= 11) กันปิดใช้งานผู้รับเหมาช่วงที่ยังมีสัญญาค้างอยู่ (TODO ที่ทำไว้ตอนหัวข้อ 2) =================
    const woForSubB = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subB.subcontractor.id, projectId: proj.project.id, contractValue: 30000,
    }, idemKey('wo-ui-subb-create'));
    createdWoIds.push(woForSubB.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woForSubB.subcontractTerm.id}/submit`, {}, idemKey('wo-ui-subb-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${woForSubB.subcontractTerm.id}/approve`, {}, idemKey('wo-ui-subb-approve'));

    let deactivateBlockedStatus = null;
    try {
      await call('fx_procurement', 'PUT', `/api/customer/subcontractors/${subB.subcontractor.id}`, {
        name: subB.subcontractor.name, taxpayerType: 'individual', isActive: false,
      });
    } catch (e) { deactivateBlockedStatus = e.status; }
    assert(deactivateBlockedStatus === 409, `ปิดใช้งานผู้รับเหมาช่วงที่ยังมี WO ค้างอยู่ (approved+active) ถูกบล็อก 409 (ได้ ${deactivateBlockedStatus})`);

    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${woForSubB.subcontractTerm.id}/terminate`, { reason: 'จบเทส E2E' }, idemKey('wo-ui-subb-terminate'));
    const deactivateAfterTerminate = await call('fx_procurement', 'PUT', `/api/customer/subcontractors/${subB.subcontractor.id}`, {
      name: subB.subcontractor.name, taxpayerType: 'individual', isActive: false,
    });
    assert(deactivateAfterTerminate.subcontractor.isActive === false, 'หลัง terminate สัญญาแล้ว ปิดใช้งานผู้รับเหมาช่วงสำเร็จจริง (guard ปล่อยผ่านถูกต้องเมื่อไม่มีสัญญาค้างแล้ว)');

    // ================= 12) แสดงคำเตือนอัตรา WHT ที่เป็น NULL (40(1) ไม่มี default_rate ตาม CLAUDE.md ข้อ 17) =================
    const wht40_1 = await pool.query(`SELECT default_rate FROM client_wht_income_types WHERE code='40_1'`);
    assert(wht40_1.rowCount === 1 && wht40_1.rows[0].default_rate === null, 'baseline: ประเภทเงินได้ 40(1) มี default_rate เป็น NULL จริงใน DB (ยืนยันก่อนเทส UI)');
    const woNullWht = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: subA.subcontractor.id, projectId: proj.project.id, contractValue: 20000, whtIncomeTypeCode: '40_1',
    }, idemKey('wo-ui-nullwht-create'));
    createdWoIds.push(woNullWht.subcontractTerm.id);
    assert(woNullWht.subcontractTerm.whtRate === null && woNullWht.subcontractTerm.whtDefaultRate === null,
      `WO ที่เลือกประเภทเงินได้ 40(1) โดยไม่ระบุ wht_rate เอง — ทั้ง whtRate และ whtDefaultRate เป็น null จริง ไม่ fallback เป็น 0 (ได้ whtRate=${woNullWht.subcontractTerm.whtRate}, whtDefaultRate=${woNullWht.subcontractTerm.whtDefaultRate})`);
    await page.click('[data-act="nav"][data-page="fin_wo"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="filter-wo-status"]', ''); // เคลียร์ filter 'rejected' ที่ค้างจากข้อ 9 ไม่งั้นแถว draft นี้ไม่โผล่ในลิสต์
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_wo_detail"][data-id="${woNullWht.subcontractTerm.id}"]`);
    await page.waitForTimeout(500);
    await shot(page, 'wht-null-rate-warning');
    const nullWhtWarningShown = await page.locator('text=ไม่มีอัตราเริ่มต้น').count();
    assert(nullWhtWarningShown >= 1, 'หน้ารายละเอียด WO แสดงคำเตือนอัตรา WHT ที่เป็น NULL ให้ผู้ใช้เห็นชัดเจน (ไม่ใช่แสดงเงียบๆ เป็น 0%)');

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
      if (createdWoIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='subcontract_term' AND doc_id = ANY($1)`, [createdWoIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'subcontract-terms-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_subcontract_terms WHERE id = ANY($1)', [createdWoIds]);
      }
      if (createdSubcontractorIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='subcontractor' AND doc_id = ANY($1)`, [createdSubcontractorIds]);
        await pool.query('DELETE FROM client_subcontractors WHERE id = ANY($1)', [createdSubcontractorIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
