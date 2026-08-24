// Real-browser E2E coverage for topic 4 (ใบขอซื้อ / Purchase Request) — replaces the old demo-only
// pagePRList/pageCreatePR. Covers: list/create(manual)/detail/submit/approve/reject/cancel, the
// BOQ-sourced create flow (budget "remaining" display + the over-budget non-blocking warning), the
// item progress bar + cancel-qty (irreversible, reason required) + adjustment history, and the
// PO-not-supported notice. Not part of `npm run test:client-ledger` — run standalone against a live
// local server.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `pr-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); passed++; console.log('  OK:', msg); }

// ---- plain HTTP helpers for prerequisite setup (not the thing under test) ----
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
  const createdBudgetIds = [];
  const createdPrIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    // budget approval ต้องใช้ can_approve_budget (คนละ flag จาก can_approve_pr) — fixture กลางไม่มีใครตั้งไว้
    // ตั้งตรงนี้เฉพาะ fx_super (idempotent, SET ค่าเดิมซ้ำได้ปลอดภัย)
    await pool.query(`UPDATE customers SET can_approve_budget=true WHERE username='fx_super'`);
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_approver_mid', companyCode);
    await httpLogin('fx_super', companyCode);
    await httpLogin('fx_procurement', companyCode);

    console.log('Creating prerequisite project (manual-source PR target) via HTTP...');
    const projManual = await call('fx_maker', 'POST', '/api/customer/projects', {
      name: 'E2E PR โครงการ manual', sectorType: 'private', status: 'in_progress',
    });
    createdProjectIds.push(projManual.project.id);

    console.log('Creating prerequisite project + approved budget (BOQ-source PR target) via HTTP...');
    const projBoq = await call('fx_maker', 'POST', '/api/customer/projects', {
      name: 'E2E PR โครงการ BOQ', sectorType: 'private', status: 'in_progress',
    });
    createdProjectIds.push(projBoq.project.id);
    const budgetCreated = await call('fx_maker', 'POST', '/api/customer/budgets', { projectId: projBoq.project.id });
    createdBudgetIds.push(budgetCreated.budget.id);
    await call('fx_maker', 'PUT', `/api/customer/budgets/${budgetCreated.budget.id}/items`, {
      items: [
        { description: 'ปูนซีเมนต์ปอร์ตแลนด์', unit: 'ถุง', qty: 1000, materialUnitPrice: 180, laborUnitPrice: 0 },
      ],
    });
    await call('fx_maker', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/submit`, {});
    await call('fx_super', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/approve`, {});
    const approvedBudget = await call('fx_maker', 'GET', `/api/customer/budgets/${budgetCreated.budget.id}`);
    const boqItem = approvedBudget.budget.currentItems.find(it => !it.isGroup);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
    page.on('dialog', d => d.accept()); // confirm() ก่อน cancel-qty/cancel PR — ยอมรับเสมอในเทสนี้

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
    async function pickProject(projectName) {
      await page.fill('#pr-project-search', projectName);
      await page.waitForTimeout(250);
      await page.click(`.pr-proj-result:has-text("${projectName}")`);
      await page.waitForTimeout(150);
    }

    // ================= 0) โหมด demo ต้องไม่เห็นเมนู PR เลย (ต่อ API จริง ไม่มี demo dataset แล้ว) =================
    await page.goto(BASE + '/pr-system.html');
    await page.click('[data-act="try-demo"]');
    await page.waitForTimeout(300);
    await page.click('[data-act="do-login"]');
    await page.waitForTimeout(500);
    const createPrNavCount = await page.locator('[data-act="nav"][data-page="create_pr"]').count();
    assert(createPrNavCount === 0, 'โหมด demo ไม่แสดงเมนู "สร้างใบขอสั่งวัสดุ (PR)" เลย (ปิดไปแล้วเพราะไม่มี demo dataset ของ PR)');
    await shot(page, 'demo-mode-no-pr-nav');

    // ================= 1) สร้าง PR แบบ manual, เห็นใน my_prs เป็น draft =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="create_pr"]');
    await page.waitForTimeout(400);
    await shot(page, 'create-pr-manual-empty');
    await pickProject('E2E PR โครงการ manual');
    await page.locator('[data-item-row="0"] input').nth(0).fill('ปูนซีเมนต์ ถุง 50 กก.');
    await page.locator('[data-item-row="0"] input').nth(1).fill('50');
    await page.locator('[data-item-row="0"] input').nth(2).fill('ถุง');
    await page.locator('[data-item-row="0"] input').nth(3).fill('165');
    await page.click('[data-act="add-item"]');
    await page.waitForTimeout(150);
    await page.locator('[data-item-row="1"] input').nth(0).fill('เหล็กเส้น RB9 มม.');
    await page.locator('[data-item-row="1"] input').nth(1).fill('100');
    await page.locator('[data-item-row="1"] input').nth(2).fill('เส้น');
    await page.locator('[data-item-row="1"] input').nth(3).fill('78');
    await shot(page, 'create-pr-manual-filled');
    await page.click('[data-act="submit-pr"]');
    await page.waitForTimeout(800);
    await shot(page, 'pr-detail-after-create-draft');
    // เช็คว่าหน้า detail โหลดข้อมูลจริงทันทีหลัง redirect มา (ไม่ค้างที่ "กำลังโหลด...") — สร้าง handler
    // ตั้ง S.page ตรงๆ ไม่ผ่าน act==='nav' จึงไม่ trigger hook loadPurchaseRequestDetail อัตโนมัติ ต้อง
    // เรียกเองในตัว handler เอง (บั๊กจริงที่เจอตอนเขียน po-ui.regression.js แล้วย้อนมาแก้ที่นี่ด้วย)
    const editableFieldVisible = await page.locator('[data-act="pr-submit"]').count();
    assert(editableFieldVisible === 1, 'หน้ารายละเอียดโหลดข้อมูลจริงทันทีหลังสร้าง ไม่ค้างที่ "กำลังโหลด..." (เห็นปุ่มยื่นขออนุมัติทันทีโดยไม่ต้อง nav ออกไปที่อื่นก่อน)');
    const draftRow = await pool.query(
      `SELECT id, status, total_amount FROM client_purchase_requests WHERE company_id=$1 AND project_id=$2 ORDER BY id DESC LIMIT 1`,
      [COMPANY_A_ID, projManual.project.id]
    );
    assert(draftRow.rowCount === 1 && draftRow.rows[0].status === 'draft', `PR ถูกสร้างเป็น draft จริงใน DB (ได้ status=${draftRow.rows[0] && draftRow.rows[0].status})`);
    assert(Number(draftRow.rows[0].total_amount) === (50 * 165 + 100 * 78), `total_amount คำนวณจาก items ฝั่ง server ถูกต้อง = ${50 * 165 + 100 * 78} (ได้ ${draftRow.rows[0].total_amount})`);
    const prManualId = draftRow.rows[0].id;
    createdPrIds.push(prManualId);

    await page.click('[data-act="nav"][data-page="my_prs"]');
    await page.waitForTimeout(500);
    const draftBadge = await page.locator('.badge:has-text("ฉบับร่าง")').count();
    assert(draftBadge >= 1, 'หน้ารายการ "PR ของฉัน" เห็นใบที่เพิ่งสร้างเป็นสถานะฉบับร่าง');
    await shot(page, 'my-prs-list-with-draft');

    // ================= 2) เปิดรายละเอียด → ยื่นขออนุมัติ → login เป็นผู้อนุมัติ → อนุมัติ =================
    await page.click(`button[data-page="pr_detail"][data-id="${prManualId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="pr-submit"]');
    await page.waitForTimeout(700);
    await shot(page, 'pr-manual-submitted');
    const submittedRow = await pool.query(`SELECT status, pr_no FROM client_purchase_requests WHERE id=$1`, [prManualId]);
    assert(submittedRow.rows[0].status === 'submitted' && !!submittedRow.rows[0].pr_no, `ยื่นขออนุมัติแล้วสถานะเป็น submitted และออกเลขที่ PR แล้ว (pr_no=${submittedRow.rows[0].pr_no})`);
    const submitBtnGone = await page.locator('[data-act="pr-submit"]').count();
    assert(submitBtnGone === 0, 'หลังยื่นแล้ว ปุ่มยื่นขออนุมัติหายไป (กันยื่นซ้ำ)');

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="all_prs"]');
    await page.waitForTimeout(500);
    await page.selectOption('[data-act="filter-pr-status"]', 'submitted');
    await page.waitForTimeout(300);
    const submittedRowVisible = await page.locator(`button[data-page="pr_detail"][data-id="${prManualId}"]`).count();
    assert(submittedRowVisible === 1, 'ผู้มีสิทธิ์อนุมัติ (fx_approver_mid) เห็นใบที่รออนุมัติในหน้า "รายการ PR ทั้งหมด" กรองสถานะ submitted ได้ (ทดแทน check_queue/approve_queue เดิม)');
    await page.click(`button[data-page="pr_detail"][data-id="${prManualId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="pr-approve"]');
    await page.waitForTimeout(700);
    await shot(page, 'pr-manual-approved');
    const approvedRow = await pool.query(`SELECT status, approved_amount FROM client_purchase_requests WHERE id=$1`, [prManualId]);
    assert(approvedRow.rows[0].status === 'approved', 'อนุมัติแล้วสถานะเป็น approved จริงใน DB');
    assert(Number(approvedRow.rows[0].approved_amount) === (50 * 165 + 100 * 78), 'approved_amount ถูก snapshot ไว้ตรงกับ total_amount ตอนอนุมัติ');
    // หมายเหตุ: เดิมมี assertion ตรงนี้ตรวจข้อความ "ตัดยอดจาก PO ยังไม่รองรับ" (requirement 4 ของหัวข้อ 4)
    // — ลบไปแล้วตอนหัวข้อ 5 (PO) เขียนเสร็จจริง เพราะ consume ใช้งานได้จริงแล้ว ไม่ใช่ "ยังไม่รองรับ" อีก
    // ต่อไป (ดู po-ui.regression.js สำหรับการตรวจ auto-consume/release แบบเต็ม)
    const progressText = await page.locator('text=คงเหลือ').first().textContent();
    assert(progressText.includes('50.0000') || progressText.includes('50'), `แถบความคืบหน้าของรายการแรกแสดง "คงเหลือ" = จำนวนที่ขอทั้งหมด (ยังไม่มีการตัดยอด PO เลย) (ได้ "${progressText}")`);

    // ================= 3) ลดยอดคงเหลือ (cancel-qty) — บังคับเหตุผล + เตือนย้อนกลับไม่ได้ + ประวัติ =================
    await loginAs('fx_procurement'); // can_manage_po=true — ไม่ใช่ super_user แต่มีสิทธิ์ผ่าน flag เท่านั้น (พิสูจน์ hasPrItemActionPermission's OR-branch)
    await page.click(`[data-act="nav"][data-page="all_prs"]`);
    await page.waitForTimeout(500);
    await page.click(`button[data-page="pr_detail"][data-id="${prManualId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-pr-cancel-qty"]');
    await page.waitForTimeout(300);
    await shot(page, 'cancel-qty-form-open');
    const irreversibleWarnVisible = await page.locator('text=ย้อนกลับไม่ได้').count();
    assert(irreversibleWarnVisible >= 1, 'ฟอร์มลดยอดคงเหลือแสดงคำเตือน "ย้อนกลับไม่ได้" ก่อนยืนยัน (requirement 3)');
    await page.click('[data-act="submit-pr-cancel-qty"]');
    await page.waitForTimeout(300);
    // ยังไม่กรอกอะไรเลย — ต้องเจอ toast error บังคับกรอกเหตุผล ไม่ใช่ยอมให้ผ่าน
    const stillOpenAfterEmptySubmit = await page.locator('[data-act="submit-pr-cancel-qty"]').count();
    assert(stillOpenAfterEmptySubmit === 1, 'กดยืนยันโดยไม่กรอกจำนวน/เหตุผล ฟอร์มยังไม่ปิด (ถูกปฏิเสธที่ฝั่ง client ก่อนยิง request)');
    await page.fill('#pr-cq-qty', '10');
    await page.fill('#pr-cq-note', 'ทดสอบลดยอด E2E — วัสดุเสียหายระหว่างขนส่ง');
    await page.click('[data-act="submit-pr-cancel-qty"]');
    await page.waitForTimeout(700);
    const itemAfterCancel = await pool.query(
      `SELECT qty_cancelled, qty_remaining FROM client_purchase_request_items WHERE purchase_request_id=$1 ORDER BY idx LIMIT 1`,
      [prManualId]
    );
    assert(Number(itemAfterCancel.rows[0].qty_cancelled) === 10, `qty_cancelled อัปเดตเป็น 10 จริงใน DB (ได้ ${itemAfterCancel.rows[0].qty_cancelled})`);
    assert(Number(itemAfterCancel.rows[0].qty_remaining) === 40, `qty_remaining ลดลงเหลือ 40 ถูกต้อง (ได้ ${itemAfterCancel.rows[0].qty_remaining})`);
    await shot(page, 'cancel-qty-done-with-history');
    const historyRowVisible = await page.locator('text=ทดสอบลดยอด E2E').count();
    assert(historyRowVisible >= 1, 'ประวัติการปรับยอดแสดงเหตุผลที่กรอกไว้ (requirement 3: เห็นว่าใครทำอะไรเมื่อไหร่)');

    // ================= 4) BOQ-sourced PR — เห็นงบ/ยอดที่เคยขอ/เตือนเกินงบแบบไม่บล็อก =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="create_pr"]');
    await page.waitForTimeout(400);
    await page.click('input[name="pr-source"][value="boq"]');
    await page.waitForTimeout(200);
    await pickProject('E2E PR โครงการ BOQ');
    await page.waitForTimeout(500);
    await shot(page, 'create-pr-boq-budget-loaded');
    const remainingQtyCellFirst = await page.locator(`#pr-boq-qty-${boqItem.id}`).count();
    assert(remainingQtyCellFirst === 1, 'เลือกโครงการที่มีงบ BOQ อนุมัติแล้ว → แสดงตารางบรรทัด BOQ พร้อมช่องกรอกจำนวนที่จะขอ (requirement 1)');
    const boqRow = page.locator(`tr:has(#pr-boq-qty-${boqItem.id})`);
    const requestedSoFarText = await boqRow.locator('td.mono').nth(2).textContent(); // mono cells in this row: 0=workCode,1=budget qty,2=ขอซื้อไปแล้ว,3=เหลือ(จำนวน),4=เหลือ(มูลค่า)
    assert(requestedSoFarText.trim() === '0.00', `ยอดที่เคยขอซื้อไปแล้วของบรรทัดนี้ = 0 ก่อนสร้าง PR ใบแรก (ได้ "${requestedSoFarText}")`);
    // กรอกเกินงบ (งบมี 1000 ถุง) เพื่อเช็คคำเตือนแบบไม่บล็อก
    await page.fill(`#pr-boq-qty-${boqItem.id}`, '1100');
    await page.waitForTimeout(200);
    const overWarnVisible = await page.locator(`#pr-boq-warn-${boqItem.id}`).isVisible();
    assert(overWarnVisible, 'กรอกจำนวนเกินงบบรรทัดนั้น → เห็นคำเตือน "เกินงบบรรทัดนี้" ทันที (requirement 1: เตือนไม่บล็อก)');
    await page.fill(`#pr-boq-qty-${boqItem.id}`, '200'); // ลดกลับมาในงบ ให้ submit ผ่านจริง
    await page.waitForTimeout(150);
    const overWarnGoneAfterFix = await page.locator(`#pr-boq-warn-${boqItem.id}`).isVisible();
    assert(!overWarnGoneAfterFix, 'แก้จำนวนกลับมาไม่เกินงบแล้ว คำเตือนหายไป');
    await shot(page, 'create-pr-boq-filled-in-budget');
    await page.click('[data-act="submit-pr"]');
    await page.waitForTimeout(800);
    const boqPrRow = await pool.query(
      `SELECT pr.id, pri.qty_requested, pri.budget_item_id FROM client_purchase_requests pr
       JOIN client_purchase_request_items pri ON pri.purchase_request_id=pr.id
       WHERE pr.company_id=$1 AND pr.project_id=$2 ORDER BY pr.id DESC LIMIT 1`,
      [COMPANY_A_ID, projBoq.project.id]
    );
    assert(boqPrRow.rowCount === 1 && Number(boqPrRow.rows[0].qty_requested) === 200, `PR แบบ BOQ ถูกสร้างจริง อ้างอิง budget_item_id=${boqPrRow.rows[0].budget_item_id} จำนวน 200 (ตรงกับที่กรอก)`);
    createdPrIds.push(boqPrRow.rows[0].id);

    // สร้าง PR ใบที่สองอ้างอิงบรรทัดเดียวกัน — ต้องเห็นยอด "ขอซื้อไปแล้ว" ของใบแรกสะท้อนกลับมาแล้ว (requirement 1)
    await page.click('[data-act="nav"][data-page="create_pr"]');
    await page.waitForTimeout(400);
    await page.click('input[name="pr-source"][value="boq"]');
    await page.waitForTimeout(200);
    await pickProject('E2E PR โครงการ BOQ');
    await page.waitForTimeout(500);
    const boqRow2 = page.locator(`tr:has(#pr-boq-qty-${boqItem.id})`);
    const requestedSoFarAfterFirstPr = await boqRow2.locator('td.mono').nth(2).textContent();
    assert(requestedSoFarAfterFirstPr.trim() === '200.00', `หลังสร้าง PR ใบแรกแล้ว ยอด "ขอซื้อไปแล้ว" ของบรรทัดเดิมอัปเดตเป็น 200 ให้เห็นก่อนกรอกใบถัดไปจริง (ได้ "${requestedSoFarAfterFirstPr}") — พิสูจน์ attachPrRequestedTotals ทำงานถูกต้อง`);
    await shot(page, 'create-pr-boq-second-pr-shows-requested-so-far');

    // ================= 5) ปฏิเสธ (reject) ต้องบังคับเหตุผล =================
    const prToReject = await call('fx_maker', 'POST', '/api/customer/purchase-requests', {
      projectId: projManual.project.id, source: 'manual', neededDate: null, note: '',
      items: [{ material: 'ทดสอบปฏิเสธ', unit: 'หน่วย', qtyRequested: 5, unitPrice: 100 }],
    }, idemKey('pr-ui-reject-create'));
    createdPrIds.push(prToReject.purchaseRequest.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-requests/${prToReject.purchaseRequest.id}/submit`, {}, idemKey('pr-ui-reject-submit'));
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="all_prs"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="pr_detail"][data-id="${prToReject.purchaseRequest.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-pr-reject"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="submit-pr-reject"]');
    await page.waitForTimeout(300);
    const stillOpenAfterEmptyReject = await page.locator('[data-act="submit-pr-reject"]').count();
    assert(stillOpenAfterEmptyReject === 1, 'ปฏิเสธโดยไม่กรอกเหตุผล ฟอร์มยังไม่ปิด (บังคับเหตุผลฝั่ง client)');
    await page.fill('#pr-reject-reason', 'ทดสอบปฏิเสธ E2E — งบไม่เพียงพอ');
    await page.click('[data-act="submit-pr-reject"]');
    await page.waitForTimeout(700);
    await shot(page, 'pr-rejected');
    const rejectedRow = await pool.query(`SELECT status, rejected_reason FROM client_purchase_requests WHERE id=$1`, [prToReject.purchaseRequest.id]);
    assert(rejectedRow.rows[0].status === 'rejected' && rejectedRow.rows[0].rejected_reason === 'ทดสอบปฏิเสธ E2E — งบไม่เพียงพอ', 'ปฏิเสธแล้วสถานะ rejected พร้อมเหตุผลถูกบันทึกจริงใน DB');

    // ================= 6) ยกเลิก PR draft (จาก fx_maker เอง) =================
    const prToCancel = await call('fx_maker', 'POST', '/api/customer/purchase-requests', {
      projectId: projManual.project.id, source: 'manual', neededDate: null, note: '',
      items: [{ material: 'ทดสอบยกเลิก', unit: 'หน่วย', qtyRequested: 1, unitPrice: 50 }],
    }, idemKey('pr-ui-cancel-create'));
    createdPrIds.push(prToCancel.purchaseRequest.id);
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="my_prs"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="pr_detail"][data-id="${prToCancel.purchaseRequest.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="pr-cancel"]');
    await page.waitForTimeout(700);
    await shot(page, 'pr-cancelled');
    const cancelledRow = await pool.query(`SELECT status FROM client_purchase_requests WHERE id=$1`, [prToCancel.purchaseRequest.id]);
    assert(cancelledRow.rows[0].status === 'cancelled', 'ยกเลิกใบ draft สำเร็จ status=cancelled จริงใน DB');

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
      if (createdPrIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='purchase_request' AND doc_id = ANY($1)`, [createdPrIds]);
        await pool.query(
          `DELETE FROM client_purchase_request_item_adjustments WHERE pr_item_id IN
           (SELECT id FROM client_purchase_request_items WHERE purchase_request_id = ANY($1))`,
          [createdPrIds]
        );
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'purchase-requests-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_purchase_request_items WHERE purchase_request_id = ANY($1)', [createdPrIds]);
        await pool.query('DELETE FROM client_purchase_requests WHERE id = ANY($1)', [createdPrIds]);
      }
      if (createdBudgetIds.length) {
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id = ANY($1)', [createdBudgetIds]); // budgets.current_revision_id -> revisions ต้องเคลียร์ก่อน ไม่งั้นลบ revision ไม่ได้ (FK)
        await pool.query('DELETE FROM client_budget_items WHERE revision_id IN (SELECT id FROM client_budget_revisions WHERE budget_id = ANY($1))', [createdBudgetIds]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id = ANY($1)', [createdBudgetIds]);
        await pool.query('DELETE FROM client_budgets WHERE id = ANY($1)', [createdBudgetIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
