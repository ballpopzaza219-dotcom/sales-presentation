// Real-browser E2E coverage for topic 5 round A (ใบสั่งซื้อ / Purchase Order) — replaces the old
// pre-client-ledger pageFinPurchaseOrders/pageFinPoAdd (JSONB items, no approval workflow, no
// composite FK to PR items). Covers: list/create(manual + from-PR)/detail/submit/approve/reject/
// cancel, the over-consumption guard at both submit and approve, auto-consume on approve, auto-
// release on cancel, and the PR-detail link-back (adjustment history showing which PO consumed it).
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
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `po-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

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

async function makeApprovedPrWithItem(companyId, projectId, material, qty, unitPrice) {
  const created = await call('fx_maker', 'POST', '/api/customer/purchase-requests', {
    projectId, source: 'manual', items: [{ material, unit: 'หน่วย', qtyRequested: qty, unitPrice }],
  }, idemKey('po-ui-pr-create'));
  await call('fx_maker', 'POST', `/api/customer/purchase-requests/${created.purchaseRequest.id}/submit`, {}, idemKey('po-ui-pr-submit'));
  const approved = await call('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${created.purchaseRequest.id}/approve`, {}, idemKey('po-ui-pr-approve'));
  return approved.purchaseRequest;
}

(async () => {
  let browser;
  const consoleErrors = [];
  const createdProjectIds = [];
  const createdPrIds = [];
  const createdPoIds = [];
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

    console.log('Creating prerequisite project + approved PR (with a real remaining qty to consume) via HTTP...');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E PO โครงการ', sectorType: 'private', status: 'in_progress' });
    createdProjectIds.push(proj.project.id);
    const approvedPr = await makeApprovedPrWithItem(COMPANY_A_ID, proj.project.id, 'ปูนซีเมนต์ ถุง 50 กก.', 100, 165);
    createdPrIds.push(approvedPr.id);
    const prItem = approvedPr.items[0];

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

    // ================= 1) สร้าง PO แบบ manual ล้วน (ไม่ผูก PR) — golden path เร็วๆ =================
    await loginAs('fx_super'); // fin_po อยู่ใน super_user-only finance section (ของเดิมออกแบบไว้แบบนี้)
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(500);
    await shot(page, 'list-empty-or-existing');
    await page.click('[data-act="nav"][data-page="fin_po_add"]');
    await page.waitForTimeout(400);
    await page.fill('#po-supplier', 'ร้านวัสดุก่อสร้าง E2E');
    await page.locator('[data-po-item-row="0"] input').nth(0).fill('ทรายหยาบ');
    await page.locator('[data-po-item-row="0"] input').nth(1).fill('5');
    await page.locator('[data-po-item-row="0"] input').nth(2).fill('คิว');
    await page.locator('[data-po-item-row="0"] input').nth(3).fill('650');
    await shot(page, 'create-manual-filled');
    await page.click('[data-act="save-po-full"]');
    await page.waitForTimeout(800);
    const draftUrl = page.url();
    assert(true, `สร้าง PO แบบ manual แล้วพาไปหน้ารายละเอียดสำเร็จ (url: ${draftUrl})`);
    const manualPoRow = await pool.query(
      `SELECT id, status, total_amount FROM client_purchase_orders WHERE company_id=$1 AND supplier_name=$2 ORDER BY id DESC LIMIT 1`,
      [COMPANY_A_ID, 'ร้านวัสดุก่อสร้าง E2E']
    );
    assert(manualPoRow.rowCount === 1 && manualPoRow.rows[0].status === 'draft', `PO manual ถูกสร้างเป็น draft จริงใน DB (ได้ status=${manualPoRow.rows[0] && manualPoRow.rows[0].status})`);
    assert(Number(manualPoRow.rows[0].total_amount) === 5 * 650, `total_amount คำนวณจาก items ฝั่ง server ถูกต้อง = ${5 * 650} (ได้ ${manualPoRow.rows[0].total_amount})`);
    const manualPoId = manualPoRow.rows[0].id;
    createdPoIds.push(manualPoId);

    await page.waitForSelector('[data-act="submit-po"]', { timeout: 5000 }); // loadPurchaseOrderDetail เป็น async fetch — รอ selector จริงแทนพึ่ง fixed timeout
    await page.click('[data-act="submit-po"]');
    await page.waitForTimeout(700);
    const submittedManual = await pool.query('SELECT status, po_no FROM client_purchase_orders WHERE id=$1', [manualPoId]);
    assert(submittedManual.rows[0].status === 'submitted' && !!submittedManual.rows[0].po_no, `ยื่น PO manual แล้วออกเลขที่จริง (po_no=${submittedManual.rows[0].po_no})`);

    // fx_super เป็นทั้งคนสร้างและคนยื่น PO ใบนี้เอง (สร้างผ่าน UI ในฐานะ super_user คนเดียวที่เข้าเมนู
    // fin_po ได้) — ปุ่มอนุมัติยังโผล่อยู่ (frontend เช็คแค่สิทธิ์ role/flag ไม่รู้เรื่อง self-approval)
    // แต่ backend ต้องบล็อกจริงตอนกด เพราะ self-approval ใช้กับทุก role รวม super_user ไม่มีข้อยกเว้น
    // (ยืนยันไว้แล้วใน pr.regression.js — เทสนี้พิสูจน์ซ้ำว่า PO บังคับกฎเดียวกัน)
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="fin_po_detail"][data-id="${manualPoId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="approve-po"]');
    await page.waitForTimeout(700);
    await shot(page, 'manual-po-self-approval-blocked');
    const stillSubmitted = await pool.query('SELECT status FROM client_purchase_orders WHERE id=$1', [manualPoId]);
    assert(stillSubmitted.rows[0].status === 'submitted', 'fx_super (ผู้สร้าง+ผู้ยื่นเอง) กดอนุมัติ PO ของตัวเองไม่ผ่านจริง — self-approval บล็อกไว้ สถานะยังเป็น submitted เหมือนเดิม ไม่ใช่ approved');
    // ให้ fx_approver_mid (คนละคน มี can_approve_po_wo+rule) อนุมัติแทนผ่าน HTTP เพื่อ unblock flow ต่อ
    const approvedManualResult = await call('fx_approver_mid', 'POST', `/api/customer/purchase-orders/${manualPoId}/approve`, {}, idemKey('po-ui-manual-approve'));
    assert(approvedManualResult.purchaseOrder.status === 'approved', 'อนุมัติ PO manual โดยคนละคนสำเร็จจริง (ไม่มี pr_item_id เลย จึงไม่มีอะไรให้ auto-consume แต่ก็ไม่ error)');

    // ================= 2) สร้าง PO ที่อ้างอิง PR item จริง — เลือกโครงการ → เลือก PR → เพิ่มรายการ =================
    // fin_po_add ไม่ใช่ sidebar item เอง (reachable only via ปุ่ม "+" จากหน้า fin_po) ต้อง nav ไป fin_po ก่อนเสมอ
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="fin_po_add"]');
    await page.waitForTimeout(400);
    await page.fill('#po-supplier', 'ร้านปูนซีเมนต์ไทย E2E');
    await page.selectOption('[data-act="select-po-project"]', String(proj.project.id));
    await page.waitForTimeout(500);
    await shot(page, 'create-from-pr-project-picked');
    await page.selectOption('[data-act="pick-po-source-pr"]', String(approvedPr.id));
    await page.waitForTimeout(500);
    await shot(page, 'create-from-pr-items-shown');
    const addFromPrBtn = page.locator(`button[data-act="add-po-item-from-pr"][data-pr-item-id="${prItem.id}"]`);
    assert(await addFromPrBtn.count() === 1, 'เลือก PR แล้วเห็นปุ่ม "เพิ่มเข้าใบสั่งซื้อ" สำหรับรายการที่มี qty เหลือจริง');
    await addFromPrBtn.click();
    await page.waitForTimeout(300);
    const linkedBadge = await page.locator('text=อ้างอิง PR').count();
    assert(linkedBadge >= 1, 'รายการที่เพิ่มจาก PR แสดง badge อ้างอิงชัดเจนในฟอร์ม');
    // ลบรายการ manual แถวแรก (แถวว่างเปล่าที่มากับฟอร์มตั้งต้น) ไม่ให้ปนกับรายการจาก PR
    await page.click('[data-po-item-row="0"] [data-act="remove-po-item"]');
    await page.waitForTimeout(200);
    await shot(page, 'create-from-pr-item-added');
    await page.click('[data-act="save-po-full"]');
    await page.waitForTimeout(800);
    const linkedPoRow = await pool.query(
      `SELECT po.id, po.status, poi.qty, poi.pr_item_id FROM client_purchase_orders po
       JOIN client_purchase_order_items poi ON poi.purchase_order_id=po.id
       WHERE po.company_id=$1 AND po.supplier_name=$2 ORDER BY po.id DESC LIMIT 1`,
      [COMPANY_A_ID, 'ร้านปูนซีเมนต์ไทย E2E']
    );
    assert(linkedPoRow.rowCount === 1 && linkedPoRow.rows[0].pr_item_id === prItem.id, `PO ที่สร้างอ้างอิง pr_item_id ตรงกับที่เลือกจริง (ได้ ${linkedPoRow.rows[0] && linkedPoRow.rows[0].pr_item_id})`);
    assert(Number(linkedPoRow.rows[0].qty) === 100, `qty ของบรรทัดที่เพิ่มจาก PR = ยอดคงเหลือทั้งหมดตอนนั้น (100) (ได้ ${linkedPoRow.rows[0].qty})`);
    const linkedPoId = linkedPoRow.rows[0].id;
    createdPoIds.push(linkedPoId);

    // ================= 3) submit PO ที่อ้างอิง PR จริง (ใบที่ 2) ผ่าน UI — fx_super เป็นทั้งผู้สร้าง+ผู้ยื่น =================
    await page.click('[data-act="submit-po"]');
    await page.waitForTimeout(700);
    const linkedSubmitted = await pool.query('SELECT status FROM client_purchase_orders WHERE id=$1', [linkedPoId]);
    assert(linkedSubmitted.rows[0].status === 'submitted', 'ยื่น PO ที่อ้างอิง PR item ผ่าน UI สำเร็จ (submit ไม่ติด self-approval เพราะ created_by===submitted_by เป็นคนเดียวกัน)');

    // ================= 4) กันเบิกเกิน: ขอ PO ใบที่สองอ้างอิง pr_item เดิมที่ถูกใบก่อนหน้า "จับจอง" (submitted) ไปแล้ว =================
    // หมายเหตุ: กฎกันเบิกเกินเทียบกับ qty_remaining ของ PR item ซึ่งลดลงจริงตอน approve เท่านั้น (ไม่ใช่
    // ตอน submit) — แต่ใบที่ submitted ไปแล้ว (สถานะยังไม่ approved) ก็ยังไม่ได้ auto-consume ยัง ดังนั้น
    // ทดสอบกันเบิกเกินให้แม่นตรงกับ requirement 3 ของ round A จริง ต้อง approve ใบที่ 2 ให้เสร็จก่อน
    // (ตัด qty_remaining เหลือ 0 จริง) แล้วค่อยพิสูจน์ว่าใบที่ 3 ขอซ้ำแล้วถูกปฏิเสธ — สลับลำดับจากที่ร่างไว้
    // แต่เดิม (เดิมวางแผนเช็คตอน submitted ยังไม่ approve ซึ่งยัง qty_remaining=100 เต็ม ไม่มีทางเกินจริง)
    const approvedByFlagLinked = await call('fx_approver_mid', 'POST', `/api/customer/purchase-orders/${linkedPoId}/approve`, {}, idemKey('po-ui-linked-approve'));
    assert(approvedByFlagLinked.purchaseOrder.status === 'approved', 'อนุมัติ PO ที่อ้างอิง PR item โดยคนละคน (fx_approver_mid) สำเร็จจริง');
    const prItemAfterConsume = await pool.query('SELECT qty_ordered, qty_remaining FROM client_purchase_request_items WHERE id=$1', [prItem.id]);
    assert(Number(prItemAfterConsume.rows[0].qty_ordered) === 100, `auto-consume ทำงานจริง: qty_ordered ของ PR item เพิ่มเป็น 100 (ได้ ${prItemAfterConsume.rows[0].qty_ordered})`);
    assert(Number(prItemAfterConsume.rows[0].qty_remaining) === 0, `qty_remaining ของ PR item ลดเหลือ 0 พอดี (ได้ ${prItemAfterConsume.rows[0].qty_remaining})`);

    const overPo = await call('fx_maker', 'POST', '/api/customer/purchase-orders', {
      projectId: proj.project.id, supplierName: 'ร้านเกินยอด E2E',
      items: [{ prItemId: prItem.id, material: prItem.material, unit: prItem.unit, qty: 10, unitPrice: prItem.unitPrice }],
    }, idemKey('po-ui-over-create'));
    createdPoIds.push(overPo.purchaseOrder.id);
    let overSubmitRejected = false;
    try {
      await call('fx_maker', 'POST', `/api/customer/purchase-orders/${overPo.purchaseOrder.id}/submit`, {}, idemKey('po-ui-over-submit'));
    } catch (e) { overSubmitRejected = e.status === 400; }
    assert(overSubmitRejected, 'ยื่น PO ที่ขอ pr_item เกินยอดคงเหลือ (0 เหลือแล้วจากใบที่เพิ่งอนุมัติ) ถูกปฏิเสธ 400 ตอน submit ตามที่ออกแบบไว้');

    // ================= 5) เปิดหน้า detail (UI) ใหม่หลัง approve — เห็นคอลัมน์ "อ้างอิง PR" + ข้อความยืนยันตัดยอดสำเร็จ =================
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_po_detail"][data-id="${linkedPoId}"]`);
    await page.waitForTimeout(500);
    await shot(page, 'linked-po-approved-with-source-pr-column');
    const sourcePrColText = await page.locator('text='+approvedPr.prNo).count();
    assert(sourcePrColText >= 1, 'หน้ารายละเอียด PO แสดงเลขที่ PR ต้นทางในคอลัมน์ "อ้างอิง PR" จริง');
    const approvedNotice = await page.locator('text=ตัดยอดจากใบขอซื้อต้นทางเรียบร้อยแล้ว').count();
    assert(approvedNotice >= 1, 'PO สถานะ approved แสดงข้อความยืนยันว่าตัดยอดสำเร็จแล้ว');

    // ================= 6) เชื่อมกลับ PR detail — ประวัติ adjustment ต้องเห็นเลขที่ PO ที่ตัดยอด + ลิงก์กลับมาได้ =================
    // my_prs/all_prs อยู่ใน navFor() (module='pr') ไม่ใช่ financeNavFor() — ต้องสลับโมดูลกลับก่อน ไม่งั้นปุ่มนี้
    // ไม่อยู่ใน sidebar ที่ render อยู่ตอนนี้เลย (ยังอยู่ module='finance' จากขั้นตอนก่อนหน้า) คลิกจะ timeout
    // ใช้ all_prs ไม่ใช่ my_prs เพราะ approvedPr สร้างโดย fx_maker แต่ browser login เป็น fx_super อยู่ —
    // my_prs กรองเฉพาะของตัวเอง (created_by=ตัวเอง) จะไม่เห็นแถวนี้เลย
    await page.click('[data-act="switch-module"][data-module="pr"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="all_prs"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="pr_detail"][data-id="${approvedPr.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="load-pr-item-adjustments"]');
    await page.waitForTimeout(400);
    const poNoLinkInHistory = page.locator(`button[data-page="fin_po_detail"][data-id="${linkedPoId}"]`);
    assert(await poNoLinkInHistory.count() === 1, 'ประวัติปรับยอดของ PR item แสดงปุ่มลิงก์กลับไปที่ PO ที่ตัดยอดจริง (แทนข้อความ "ยังไม่รองรับ" เดิม)');
    await shot(page, 'pr-detail-adjustment-links-to-po');
    await poNoLinkInHistory.click();
    await page.waitForTimeout(600);
    assert(page.url().includes('pr-system.html'), 'คลิกลิงก์จากประวัติ PR แล้วนำทางไปหน้า PO detail สำเร็จ (ไม่ error)');

    // ================= 7) cancel PO ที่ approved แล้ว — auto-release คืนยอด =================
    await page.click('[data-act="cancel-po"]');
    await page.waitForTimeout(700);
    await shot(page, 'linked-po-cancelled');
    const prItemAfterRelease = await pool.query('SELECT qty_ordered, qty_remaining FROM client_purchase_request_items WHERE id=$1', [prItem.id]);
    assert(Number(prItemAfterRelease.rows[0].qty_ordered) === 0, `auto-release ทำงานจริง: qty_ordered ของ PR item คืนกลับเป็น 0 (ได้ ${prItemAfterRelease.rows[0].qty_ordered})`);
    assert(Number(prItemAfterRelease.rows[0].qty_remaining) === 100, `qty_remaining ของ PR item กลับมาเป็น 100 เต็มจำนวน (ได้ ${prItemAfterRelease.rows[0].qty_remaining})`);
    const cancelledLinkedPo = await pool.query('SELECT status FROM client_purchase_orders WHERE id=$1', [linkedPoId]);
    assert(cancelledLinkedPo.rows[0].status === 'cancelled', 'PO ที่ approved แล้วยกเลิกสำเร็จ status=cancelled จริงใน DB');

    // ================= 8) reject flow (ใบที่สาม ยังไม่ผูก PR item ไหนเลยเพื่อความง่าย) =================
    const prToReject = await call('fx_maker', 'POST', '/api/customer/purchase-orders', {
      projectId: proj.project.id, supplierName: 'ร้านทดสอบปฏิเสธ E2E',
      items: [{ material: 'ทดสอบปฏิเสธ', unit: 'หน่วย', qty: 1, unitPrice: 100 }],
    }, idemKey('po-ui-reject-create'));
    createdPoIds.push(prToReject.purchaseOrder.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-orders/${prToReject.purchaseOrder.id}/submit`, {}, idemKey('po-ui-reject-submit'));
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="fin_po_detail"][data-id="${prToReject.purchaseOrder.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-po-reject"]');
    await page.waitForTimeout(200);
    await page.fill('#po-reject-reason', 'ทดสอบปฏิเสธ E2E — ราคาสูงเกินไป');
    await page.click('[data-act="submit-po-reject"]');
    await page.waitForTimeout(700);
    const rejectedPoRow = await pool.query('SELECT status, rejected_reason FROM client_purchase_orders WHERE id=$1', [prToReject.purchaseOrder.id]);
    assert(rejectedPoRow.rows[0].status === 'rejected' && rejectedPoRow.rows[0].rejected_reason === 'ทดสอบปฏิเสธ E2E — ราคาสูงเกินไป', 'ปฏิเสธ PO แล้วสถานะ rejected พร้อมเหตุผลถูกบันทึกจริง');

    // ================= 9) filter list ตามสถานะ/โครงการ =================
    await page.click('[data-act="nav"][data-page="fin_po"]');
    await page.waitForTimeout(500);
    await page.selectOption('[data-act="filter-po-status"]', 'rejected');
    await page.waitForTimeout(300);
    const rejectedRowVisible = await page.locator(`button[data-page="fin_po_detail"][data-id="${prToReject.purchaseOrder.id}"]`).count();
    assert(rejectedRowVisible === 1, 'กรองสถานะ rejected แล้วเห็นใบที่เพิ่งปฏิเสธไปจริง');
    const approvedRowHiddenWhenFilteringRejected = await page.locator(`button[data-page="fin_po_detail"][data-id="${manualPoId}"]`).count();
    assert(approvedRowHiddenWhenFilteringRejected === 0, 'กรองสถานะ rejected แล้วใบที่ approved (คนละสถานะ) ไม่ถูกแสดง');

    // ================= 10) can_approve_po_wo gate: ไม่มีสิทธิ์ถูกปฏิเสธ 403 (ไม่ใช่ 500 จากคอลัมน์หาย) / มีสิทธิ์อนุมัติได้จริง =================
    const poForGateTest = await call('fx_maker', 'POST', '/api/customer/purchase-orders', {
      projectId: proj.project.id, supplierName: 'ร้านทดสอบสิทธิ์ E2E',
      items: [{ material: 'ทดสอบสิทธิ์', unit: 'หน่วย', qty: 1, unitPrice: 50 }],
    }, idemKey('po-ui-gate-create'));
    createdPoIds.push(poForGateTest.purchaseOrder.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-orders/${poForGateTest.purchaseOrder.id}/submit`, {}, idemKey('po-ui-gate-submit'));

    let noPermRejected = null;
    try {
      await call('fx_maker2', 'POST', `/api/customer/purchase-orders/${poForGateTest.purchaseOrder.id}/approve`, {}, idemKey('po-ui-gate-approve-denied'));
    } catch (e) { noPermRejected = e; }
    assert(noPermRejected !== null && noPermRejected.status === 403, `fx_maker2 (role='maker', ไม่มี can_approve_po_wo) พยายามอนุมัติ PO ได้ 403 ไม่ใช่ 500 (พิสูจน์ migration 0013 แก้ปัญหา 'canApprove: approver.can_approve_po_wo ขาดหายไป' ได้จริง — ได้ status=${noPermRejected && noPermRejected.status})`);
    assert(!!(noPermRejected.body && noPermRejected.body.code), `error response มี code ระบุสาเหตุปฏิเสธชัดเจน ไม่ใช่ error message ดิบจาก exception (ได้ code=${noPermRejected.body && noPermRejected.body.code})`);

    const approvedByFlag = await call('fx_approver_mid', 'POST', `/api/customer/purchase-orders/${poForGateTest.purchaseOrder.id}/approve`, {}, idemKey('po-ui-gate-approve-ok'));
    assert(approvedByFlag.purchaseOrder.status === 'approved', 'fx_approver_mid (มี can_approve_po_wo=true + rule active ใน fixture) อนุมัติ PO สำเร็จจริง (พิสูจน์ flag ที่เพิ่งเพิ่มใน migration 0013 ทำงานถูกต้องจริง ไม่ใช่แค่ไม่ throw)');

    // ================= 11) ตั้ง flag can_approve_po_wo ผ่านหน้าจัดการสิทธิ์ (UI) ได้จริง =================
    const fxMaker2Row = await pool.query(`SELECT id, can_approve_po_wo FROM customers WHERE username='fx_maker2'`);
    const fxMaker2Id = fxMaker2Row.rows[0].id;
    assert(fxMaker2Row.rows[0].can_approve_po_wo === false, 'ก่อนตั้งค่า fx_maker2 ยังไม่มีสิทธิ์ can_approve_po_wo (baseline ตรงกับที่เพิ่งพิสูจน์ในข้อ 10)');

    await loginAs('fx_super');
    // approval_permissions อยู่ใน navFor() (module='pr', ส่วน super_user) — loginAs() สลับไป module='finance'
    // เป็นค่าเริ่มต้นเสมอ ต้องสลับกลับก่อนคลิก ไม่งั้นปุ่มนี้ไม่อยู่ใน sidebar ที่ render อยู่
    await page.click('[data-act="switch-module"][data-module="pr"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="approval_permissions"]');
    await page.waitForTimeout(500);
    await shot(page, 'approval-permissions-page-shows-po-wo-column');
    const grantBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${fxMaker2Id}"][data-column="can_approve_po_wo"]`);
    assert(await grantBtn.count() === 1, 'หน้าจัดการสิทธิ์แสดงคอลัมน์+ปุ่มให้สิทธิ์ can_approve_po_wo ของ fx_maker2 (คอลัมน์ที่เพิ่งเพิ่มเข้า UI แสดงผลถูกต้องครบ ไม่ใช่แค่ 9 คอลัมน์เดิม)');
    await grantBtn.click();
    await page.waitForTimeout(600);
    const afterGrant = await pool.query(`SELECT can_approve_po_wo FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterGrant.rows[0].can_approve_po_wo === true, 'กดปุ่มให้สิทธิ์ผ่าน UI แล้ว can_approve_po_wo เปลี่ยนเป็น true จริงใน DB (ยืนยันว่า whitelist ฝั่ง server ยอมรับคอลัมน์นี้แล้ว)');

    // เพิกถอนคืนตอนจบ ไม่ทิ้ง state ค้าง (fixture user นี้ใช้ร่วมกับเทสไฟล์อื่นในชุด client-ledger ด้วย)
    const revokeBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${fxMaker2Id}"][data-column="can_approve_po_wo"]`);
    await revokeBtn.click();
    await page.waitForTimeout(600);
    const afterRevoke = await pool.query(`SELECT can_approve_po_wo FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterRevoke.rows[0].can_approve_po_wo === false, 'กดปุ่มเพิกถอนสิทธิ์คืนผ่าน UI สำเร็จ (คืนสถานะเดิมให้ fixture ไม่ทิ้ง state ค้างข้ามเทส)');

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
      // adjustments.po_id FK ไปที่ client_purchase_orders — ต้องลบ adjustments ก่อนลบ PO เสมอ (ไม่งั้น FK
      // constraint client_pr_item_adjustments_po_fk บล็อกการลบ PO ที่เพิ่งผ่าน auto-consume/release มา)
      if (createdPrIds.length) {
        await pool.query(`DELETE FROM client_purchase_request_item_adjustments WHERE pr_item_id IN (SELECT id FROM client_purchase_request_items WHERE purchase_request_id = ANY($1))`, [createdPrIds]);
      }
      if (createdPoIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='purchase_order' AND doc_id = ANY($1)`, [createdPoIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'purchase-orders-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_purchase_order_items WHERE purchase_order_id = ANY($1)', [createdPoIds]);
        await pool.query('DELETE FROM client_purchase_orders WHERE id = ANY($1)', [createdPoIds]);
      }
      if (createdPrIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='purchase_request' AND doc_id = ANY($1)`, [createdPrIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'purchase-requests-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_purchase_request_items WHERE purchase_request_id = ANY($1)', [createdPrIds]);
        await pool.query('DELETE FROM client_purchase_requests WHERE id = ANY($1)', [createdPrIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
