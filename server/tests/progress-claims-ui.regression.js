// Real-browser E2E coverage for topic 3 (บันทึกความคืบหน้าโครงการ / Progress Claim — client_progress_claims,
// migration 0014). Mirrors po-ui.regression.js / wo-ui.regression.js's structure. Covers: create(advance +
// progress/installment + progress/boq)/list/detail/submit/certify/approve/reject/cancel, the 3-step
// submit->certify->approve workflow with self-block covering certified_by (not just created_by/submitted_by),
// the "certified != requested requires certify_note" rule, the BOQ claimed_percent cumulative guard, the
// advance-received (Dr1100/Cr2160) vs progress-recognized (Dr1200/Cr4100) journal split, and the
// advance-offset-against-a-later-progress-claim flow (Dr2160/Cr1200 + client_revenue.applied_amount).
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
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `pc-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

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
  const createdBudgetIds = [];
  const createdClaimIds = [];

  try {
    console.log('Ensuring fixtures...');
    await setup();
    await pool.query(`UPDATE customers SET can_approve_budget=true WHERE username='fx_super'`); // ต้องใช้อนุมัติ BOQ ก่อนอ้างอิงได้
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_maker2', companyCode);
    await httpLogin('fx_certifier', companyCode);
    await httpLogin('fx_approver_mid', companyCode);
    await httpLogin('fx_super', companyCode);

    console.log('Creating prerequisite project (installment mode) + project with approved BOQ (boq mode)...');
    // installments ระบุตอนสร้างโครงการได้เลย (POST เดียว — ไม่มี PUT endpoint สำหรับ project แยกต่างหาก)
    const projInst = await call('fx_maker', 'POST', '/api/customer/projects', {
      name: 'E2E ความคืบหน้า โครงการงวดงาน', sectorType: 'private', status: 'in_progress', defaultRetentionPercent: 5,
      // งวดที่ 2 เตรียมไว้ให้เทส gate test (ข้อ 9) ใช้แยกต่างหาก — งวดที่ 1 จะถูกใบขอเบิกที่อนุมัติแล้ว
      // "จับจอง" ไปเต็มๆ ในข้อ 2-5 (guard กันขอเบิกซ้อนอ้างอิงงวดเดียวกันขณะยังไม่จบ จะบล็อกถ้าใช้ซ้ำ)
      installments: [{ description: 'งวดที่ 1', amount: 40000, daysToComplete: 30 }, { description: 'งวดที่ 2', amount: 15000, daysToComplete: 60 }],
    });
    createdProjectIds.push(projInst.project.id);
    const projInstDetail = await call('fx_maker', 'GET', `/api/customer/projects/${projInst.project.id}`);
    const installment1 = projInstDetail.installments[0];
    const installment2 = projInstDetail.installments[1];

    const projBoq = await call('fx_maker', 'POST', '/api/customer/projects', {
      name: 'E2E ความคืบหน้า โครงการ BOQ', sectorType: 'private', status: 'in_progress', defaultRetentionPercent: 5,
    });
    createdProjectIds.push(projBoq.project.id);
    const budgetCreated = await call('fx_maker', 'POST', '/api/customer/budgets', { projectId: projBoq.project.id });
    createdBudgetIds.push(budgetCreated.budget.id);
    await call('fx_maker', 'PUT', `/api/customer/budgets/${budgetCreated.budget.id}/items`, {
      items: [{ description: 'งานฐานราก', unit: 'งาน', qty: 1, materialUnitPrice: 30000, laborUnitPrice: 0 }],
    });
    await call('fx_maker', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/submit`, {});
    await call('fx_super', 'POST', `/api/customer/budgets/${budgetCreated.budget.id}/approve`, {});
    const approvedBudget = await call('fx_maker', 'GET', `/api/customer/budgets/${budgetCreated.budget.id}`);
    const boqItem = approvedBudget.budget.currentItems.find(it => !it.isGroup);

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

    // ================= 1) สร้างใบขอเบิกเงินล่วงหน้า (advance) ผ่าน UI + ยื่น + อนุมัติ (ไม่มีขั้นตรวจสอบผลงาน) =================
    // fin_progress_claims อยู่ใน super_user-only finance section (เหมือน fin_po/fin_wo เดิม) — ต้องใช้
    // fx_super สร้างผ่าน UI เท่านั้น fx_maker เข้าเมนูนี้ไม่ได้เลย
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_progress_claims"]');
    await page.waitForTimeout(500);
    await shot(page, 'list-empty-or-existing');
    await page.click('[data-act="nav"][data-page="fin_progress_claim_add"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-progress-claim-type"]', 'advance');
    await page.waitForTimeout(200);
    await page.selectOption('[data-act="select-progress-project"]', String(projInst.project.id));
    await page.fill('#pc-requested-amount-adv', '10000');
    await shot(page, 'create-advance-filled');
    await page.click('[data-act="save-progress-claim-full"]');
    await page.waitForTimeout(800);
    const advClaimRow = await pool.query(
      `SELECT id, status, claim_type, requested_amount FROM client_progress_claims WHERE company_id=$1 AND project_id=$2 AND claim_type='advance' ORDER BY id DESC LIMIT 1`,
      [COMPANY_A_ID, projInst.project.id]
    );
    assert(advClaimRow.rowCount === 1 && advClaimRow.rows[0].status === 'draft', `สร้างใบขอเบิกเงินล่วงหน้าเป็น draft จริงใน DB (ได้ status=${advClaimRow.rows[0] && advClaimRow.rows[0].status})`);
    const advClaimId = advClaimRow.rows[0].id;
    createdClaimIds.push(advClaimId);

    await page.waitForSelector('[data-act="submit-progress-claim"]', { timeout: 5000 });
    await page.click('[data-act="submit-progress-claim"]');
    await page.waitForTimeout(700);
    const advSubmitted = await pool.query('SELECT status, claim_no FROM client_progress_claims WHERE id=$1', [advClaimId]);
    assert(advSubmitted.rows[0].status === 'submitted' && !!advSubmitted.rows[0].claim_no, `ยื่นใบขอเบิกเงินล่วงหน้าแล้วออกเลขที่จริง (claim_no=${advSubmitted.rows[0].claim_no})`);

    const advApproved = await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${advClaimId}/approve`, {}, idemKey('pc-adv-approve'));
    assert(advApproved.progressClaim.status === 'approved' && advApproved.progressClaim.certifiedAmount === 10000, `อนุมัติใบขอเบิกเงินล่วงหน้าสำเร็จจริง (ไม่มีขั้นตรวจสอบผลงาน certifiedAmount ก็อบปี้จาก requestedAmount อัตโนมัติ ได้ ${advApproved.progressClaim.certifiedAmount})`);
    const advRevenueRow = await pool.query('SELECT type, amount, applied_amount FROM client_revenue WHERE id=$1', [advApproved.progressClaim.revenueId]);
    assert(advRevenueRow.rows[0].type === 'deposit' && Number(advRevenueRow.rows[0].amount) === 10000, 'อนุมัติแล้วสร้างแถว client_revenue type=deposit จริง ยอดตรงกับที่ขอเบิก');
    const advJournalLines = await pool.query(
      `SELECT jl.account_code, jl.debit_amount, jl.credit_amount FROM client_journal_entry_lines jl
       JOIN client_journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.source_type='revenue' AND je.source_id=$1 ORDER BY jl.account_code`,
      [advApproved.progressClaim.revenueId]
    );
    const advDr1100 = advJournalLines.rows.find(l => l.account_code === '1100');
    const advCr2160 = advJournalLines.rows.find(l => l.account_code === '2160');
    assert(!!advDr1100 && Number(advDr1100.debit_amount) === 10000, 'journal: Dr 1100 เงินสด 10000 บาทจริง');
    assert(!!advCr2160 && Number(advCr2160.credit_amount) === 10000, 'journal: Cr 2160 เงินรับล่วงหน้าจากลูกค้า 10000 บาทจริง (ไม่ใช่ Cr 4100 รายได้ทันที)');

    // ================= 2) self-block: ผู้สร้างตรวจสอบผลงานใบของตัวเองไม่ได้ =================
    // ผู้สร้างต้องมีสิทธิ์ certify อยู่แล้วด้วย (fx_certifier) ถึงจะพิสูจน์ "self-block" แยกจาก "ไม่มีสิทธิ์"
    // ได้จริง — ถ้าผู้สร้างไม่มีสิทธิ์เลยตั้งแต่แรก (เช่น fx_maker) จะโดน no_permission ก่อนถึงจะเจอ
    // self-block เสมอ ไม่ใช่การพิสูจน์ที่ตั้งใจในสถานการณ์นี้
    const pcInstCreate = await call('fx_certifier', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'progress', claimMode: 'installment',
      installmentId: installment1.id, requestedAmount: 40000,
    }, idemKey('pc-inst-create'));
    createdClaimIds.push(pcInstCreate.progressClaim.id);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/submit`, {}, idemKey('pc-inst-submit'));
    let selfCertifyBlocked = null;
    try {
      await call('fx_certifier', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/certify`, { certifiedAmount: 40000, certifyNote: '' }, idemKey('pc-inst-selfcertify'));
    } catch (e) { selfCertifyBlocked = e; }
    assert(selfCertifyBlocked !== null && selfCertifyBlocked.status === 403 && selfCertifyBlocked.body.code === 'self_certify_blocked', `ผู้สร้าง (fx_certifier มีสิทธิ์ certify อยู่แล้ว) ตรวจสอบผลงานใบของตัวเองไม่ได้ 403 code=self_certify_blocked (ได้ status=${selfCertifyBlocked && selfCertifyBlocked.status})`);

    // ================= 3) ตรวจสอบผลงานโดยคนละคน (fx_approver_mid มี can_certify_progress ด้วย) — ยอดไม่เท่าที่ขอ ต้องบังคับ certify_note =================
    let certifyNoNoteRejected = null;
    try {
      await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/certify`, { certifiedAmount: 35000, certifyNote: '' }, idemKey('pc-inst-certify-nonote'));
    } catch (e) { certifyNoNoteRejected = e; }
    assert(certifyNoNoteRejected !== null && certifyNoNoteRejected.status === 400, `ตรวจสอบผลงานยอดไม่เท่าที่ขอ (35000 vs 40000) โดยไม่กรอกเหตุผลถูกปฏิเสธ 400 (ได้ ${certifyNoNoteRejected && certifyNoNoteRejected.status})`);

    const certified = await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/certify`,
      { certifiedAmount: 35000, certifyNote: 'ผลงานจริงยังไม่ครบตามที่ขอ ขาดงานทาสีบางส่วน' }, idemKey('pc-inst-certify'));
    assert(certified.progressClaim.status === 'certified' && certified.progressClaim.certifiedAmount === 35000, `ตรวจสอบผลงานสำเร็จจริง สถานะเป็น certified ยอดที่รับรอง 35000 (ได้ ${certified.progressClaim.certifiedAmount})`);

    // ================= 4) self-block: ผู้ตรวจสอบผลงานอนุมัติใบเดียวกันเองไม่ได้ (ครอบคลุมถึง certified_by) =================
    // fx_approver_mid มีสิทธิ์ can_approve_progress โดยทั่วไปจริง แต่ต้องโดนบล็อกเพราะเป็นคนที่ certify ใบนี้
    // เอง — พิสูจน์ว่า self-block ทำงานแยกจากการเช็คสิทธิ์ทั่วไป ไม่ใช่ไปโดน no_permission เฉยๆ
    let selfApproveBlocked = null;
    try {
      await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/approve`, {}, idemKey('pc-inst-selfapprove'));
    } catch (e) { selfApproveBlocked = e; }
    assert(selfApproveBlocked !== null && selfApproveBlocked.status === 403, `ผู้ตรวจสอบผลงาน (fx_approver_mid, มีสิทธิ์ approve โดยทั่วไป) อนุมัติใบเดียวกันเองไม่ได้ 403 (self-block ครอบคลุมถึง certified_by ไม่ใช่แค่ created_by/submitted_by) (ได้ status=${selfApproveBlocked && selfApproveBlocked.status})`);

    // ================= 5) อนุมัติโดยคนที่ 3 (fx_super) พร้อมหักล้างเงินล่วงหน้าที่มีอยู่ (10000 จากข้อ 1) =================
    const outstandingBefore = await call('fx_certifier', 'GET', `/api/customer/projects/${projInst.project.id}/outstanding-advance`);
    assert(outstandingBefore.outstandingAdvance === 10000, `ยอดเงินล่วงหน้าคงเหลือของโครงการก่อนหักล้าง = 10000 ตรงกับที่อนุมัติไปในข้อ 1 (ได้ ${outstandingBefore.outstandingAdvance})`);

    const approvedInst = await call('fx_super', 'POST', `/api/customer/progress-claims/${pcInstCreate.progressClaim.id}/approve`,
      { applyAdvanceAmount: 6000 }, idemKey('pc-inst-approve'));
    assert(approvedInst.progressClaim.status === 'approved', 'อนุมัติใบขอเบิกความคืบหน้า (installment) โดยคนที่ 3 (fx_super) สำเร็จจริง');
    assert(Number(approvedInst.progressClaim.retentionAmount) === 1750, `retention_amount คำนวณถูกต้อง = 35000*5% = 1750 (ได้ ${approvedInst.progressClaim.retentionAmount})`);

    const advAfterOffset = await pool.query('SELECT applied_amount FROM client_revenue WHERE id=$1', [advApproved.progressClaim.revenueId]);
    assert(Number(advAfterOffset.rows[0].applied_amount) === 6000, `เงินล่วงหน้าที่ถูกหักล้างไปแล้ว (applied_amount) = 6000 จริงใน DB (ได้ ${advAfterOffset.rows[0].applied_amount})`);
    const applicationRow = await pool.query('SELECT amount FROM client_revenue_advance_applications WHERE progress_claim_id=$1', [pcInstCreate.progressClaim.id]);
    assert(applicationRow.rowCount === 1 && Number(applicationRow.rows[0].amount) === 6000, 'มีแถวประวัติการหักล้างเงินล่วงหน้า (client_revenue_advance_applications) บันทึกไว้ถูกต้อง');

    const instJournalLines = await pool.query(
      `SELECT jl.account_code, jl.debit_amount, jl.credit_amount, je.source_type FROM client_journal_entry_lines jl
       JOIN client_journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.source_id=$1 AND je.source_type IN ('revenue','retention') ORDER BY je.id, jl.account_code`,
      [approvedInst.progressClaim.revenueId]
    );
    const dr1200Revenue = instJournalLines.rows.find(l => l.account_code === '1200' && Number(l.debit_amount) === 35000);
    const cr4100 = instJournalLines.rows.find(l => l.account_code === '4100' && Number(l.credit_amount) === 35000);
    const dr1250 = instJournalLines.rows.find(l => l.account_code === '1250' && Number(l.debit_amount) === 1750);
    const dr2160Offset = instJournalLines.rows.find(l => l.account_code === '2160' && Number(l.debit_amount) === 6000);
    assert(!!dr1200Revenue && !!cr4100, 'journal รับรู้รายได้: Dr 1200 / Cr 4100 เต็มยอด certified (35000) จริง');
    assert(!!dr1250, 'journal เงินประกันผลงาน: Dr 1250 ลูกหนี้เงินประกันผลงาน 1750 จริง');
    assert(!!dr2160Offset, 'journal หักล้างเงินล่วงหน้า: Dr 2160 เงินรับล่วงหน้าจากลูกค้า 6000 จริง (แยกจาก entry รับรู้รายได้)');

    // ================= 6) claim_mode='boq' — เต็มรูปแบบ + ทดสอบกันเบิกเกิน 100% สะสม =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_progress_claims"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="fin_progress_claim_add"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-progress-project"]', String(projBoq.project.id));
    await page.waitForTimeout(200);
    await page.selectOption('[data-act="select-progress-claim-mode"]', 'boq');
    await page.waitForTimeout(600);
    await shot(page, 'create-boq-items-loaded');
    await page.fill(`input[oninput*="boqPercents['${boqItem.id}']"]`, '60');
    await shot(page, 'create-boq-percent-filled');
    await page.click('[data-act="save-progress-claim-full"]');
    await page.waitForTimeout(800);
    const boqClaimRow = await pool.query(
      `SELECT pc.id, pc.requested_amount, pci.requested_percent, pci.requested_amount AS item_amount
       FROM client_progress_claims pc JOIN client_progress_claim_items pci ON pci.progress_claim_id=pc.id
       WHERE pc.company_id=$1 AND pc.project_id=$2 ORDER BY pc.id DESC LIMIT 1`,
      [COMPANY_A_ID, projBoq.project.id]
    );
    assert(boqClaimRow.rowCount === 1 && Number(boqClaimRow.rows[0].requested_percent) === 60 && Number(boqClaimRow.rows[0].item_amount) === 18000,
      `สร้างใบขอเบิกแบบ BOQ สำเร็จ 60% ของ 30000 = 18000 คำนวณฝั่ง server ถูกต้อง (ได้ ${boqClaimRow.rows[0].item_amount})`);
    const boqClaimId = boqClaimRow.rows[0].id;
    createdClaimIds.push(boqClaimId);

    await page.waitForSelector('[data-act="submit-progress-claim"]', { timeout: 5000 });
    await page.click('[data-act="submit-progress-claim"]');
    await page.waitForTimeout(700);
    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${boqClaimId}/certify`,
      { items: [{ itemId: (await pool.query('SELECT id FROM client_progress_claim_items WHERE progress_claim_id=$1', [boqClaimId])).rows[0].id, certifiedPercent: 60 }], certifyNote: '' },
      idemKey('pc-boq-certify'));
    const boqApproved = await call('fx_approver_mid', 'POST', `/api/customer/progress-claims/${boqClaimId}/approve`, {}, idemKey('pc-boq-approve'));
    assert(boqApproved.progressClaim.status === 'approved', 'อนุมัติใบขอเบิกแบบ BOQ สำเร็จจริง');
    const budgetItemAfter = await pool.query('SELECT claimed_percent FROM client_budget_items WHERE id=$1', [boqItem.id]);
    assert(Number(budgetItemAfter.rows[0].claimed_percent) === 60, `claimed_percent ของบรรทัด BOQ สะสมเป็น 60% หลังอนุมัติจริง (ได้ ${budgetItemAfter.rows[0].claimed_percent})`);

    // ขอเบิกซ้ำอีก 50% (60+50=110 > 100) — บรรทัด BOQ นี้ claimed_percent=60 ถูก "อนุมัติจริง" ไปแล้วก่อนใบนี้
    // จะสร้างด้วยซ้ำ (ไม่ใช่แค่ pending) ดังนั้นเช็คตอน submit (ที่เทียบกับ claimed_percent ปัจจุบัน) ก็เจอ
    // ทันทีอยู่แล้ว ไม่ต้องรอถึง approve — ต่างจากเคส PO/WO ที่เช็คตอน submit เป็นแค่ "เตือน" เพราะ PR item
    // อาจถูกใบอื่นตัดยอดเพิ่มได้อีกหลัง submit (ที่นี่ก็มีดีไซน์เดียวกัน แค่ในสถานการณ์นี้ยอดสะสมคงที่ไปแล้ว
    // ตั้งแต่ก่อน submit จึงเจอความผิดพลาดตั้งแต่ต้นทาง)
    const boqOverClaim = await call('fx_maker', 'POST', '/api/customer/progress-claims', {
      projectId: projBoq.project.id, claimType: 'progress', claimMode: 'boq',
      items: [{ budgetItemId: boqItem.id, requestedPercent: 50 }],
    }, idemKey('pc-boq-over-create'));
    createdClaimIds.push(boqOverClaim.progressClaim.id);
    let overSubmitBlocked = null;
    try {
      await call('fx_maker', 'POST', `/api/customer/progress-claims/${boqOverClaim.progressClaim.id}/submit`, {}, idemKey('pc-boq-over-submit'));
    } catch (e) { overSubmitBlocked = e; }
    assert(overSubmitBlocked !== null && overSubmitBlocked.status === 400, `ขอเบิก BOQ เกิน 100% สะสม (60%+50%=110%) ถูกปฏิเสธตอน submit จริง (ได้ status=${overSubmitBlocked && overSubmitBlocked.status})`);
    await call('fx_maker', 'POST', `/api/customer/progress-claims/${boqOverClaim.progressClaim.id}/cancel`, {});

    // ================= 7) reject flow =================
    const pcReject = await call('fx_maker', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'advance', requestedAmount: 5000,
    }, idemKey('pc-reject-create'));
    createdClaimIds.push(pcReject.progressClaim.id);
    await call('fx_maker', 'POST', `/api/customer/progress-claims/${pcReject.progressClaim.id}/submit`, {}, idemKey('pc-reject-submit'));
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_progress_claims"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="fin_progress_claim_detail"][data-id="${pcReject.progressClaim.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-progress-claim-reject"]');
    await page.waitForTimeout(200);
    await page.fill('#pc-reject-reason', 'ทดสอบปฏิเสธ E2E — ยังไม่ถึงเงื่อนไขเบิกเงินล่วงหน้าตามสัญญา');
    await page.click('[data-act="submit-progress-claim-reject"]');
    await page.waitForTimeout(700);
    const rejectedRow = await pool.query('SELECT status, rejected_reason FROM client_progress_claims WHERE id=$1', [pcReject.progressClaim.id]);
    assert(rejectedRow.rows[0].status === 'rejected' && rejectedRow.rows[0].rejected_reason.includes('ยังไม่ถึงเงื่อนไข'), 'ปฏิเสธใบขอเบิกแล้วสถานะ rejected พร้อมเหตุผลถูกบันทึกจริง');

    // ================= 8) cancel flow (draft) =================
    const pcCancel = await call('fx_maker', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'advance', requestedAmount: 3000,
    }, idemKey('pc-cancel-create'));
    createdClaimIds.push(pcCancel.progressClaim.id);
    await page.click('[data-act="nav"][data-page="fin_progress_claims"]');
    await page.waitForTimeout(400);
    await page.click(`button[data-page="fin_progress_claim_detail"][data-id="${pcCancel.progressClaim.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="cancel-progress-claim"]');
    await page.waitForTimeout(700);
    const cancelledRow = await pool.query('SELECT status FROM client_progress_claims WHERE id=$1', [pcCancel.progressClaim.id]);
    assert(cancelledRow.rows[0].status === 'cancelled', 'ยกเลิกใบขอเบิก draft สำเร็จ status=cancelled จริงใน DB');

    // ================= 9) can_certify_progress / can_approve_progress gate: ไม่มีสิทธิ์ -> 403 no_permission =================
    const pcGate = await call('fx_maker', 'POST', '/api/customer/progress-claims', {
      projectId: projInst.project.id, claimType: 'progress', claimMode: 'installment', installmentId: installment2.id, requestedAmount: 1000,
    }, idemKey('pc-gate-create'));
    createdClaimIds.push(pcGate.progressClaim.id);
    await call('fx_maker', 'POST', `/api/customer/progress-claims/${pcGate.progressClaim.id}/submit`, {}, idemKey('pc-gate-submit'));
    let certifyNoPermRejected = null;
    try {
      await call('fx_maker2', 'POST', `/api/customer/progress-claims/${pcGate.progressClaim.id}/certify`, { certifiedAmount: 1000, certifyNote: '' }, idemKey('pc-gate-certify-denied'));
    } catch (e) { certifyNoPermRejected = e; }
    assert(certifyNoPermRejected !== null && certifyNoPermRejected.status === 403 && certifyNoPermRejected.body.code === 'no_permission',
      `fx_maker2 (ไม่มี can_certify_progress) ตรวจสอบผลงานได้ 403 code=no_permission ไม่ใช่ 500 (ได้ status=${certifyNoPermRejected && certifyNoPermRejected.status})`);

    await call('fx_certifier', 'POST', `/api/customer/progress-claims/${pcGate.progressClaim.id}/certify`, { certifiedAmount: 1000, certifyNote: '' }, idemKey('pc-gate-certify'));
    let approveNoPermRejected = null;
    try {
      await call('fx_maker2', 'POST', `/api/customer/progress-claims/${pcGate.progressClaim.id}/approve`, {}, idemKey('pc-gate-approve-denied'));
    } catch (e) { approveNoPermRejected = e; }
    assert(approveNoPermRejected !== null && approveNoPermRejected.status === 403 && !!approveNoPermRejected.body.code,
      `fx_maker2 (ไม่มี can_approve_progress) อนุมัติได้ 403 ไม่ใช่ 500 (ได้ status=${approveNoPermRejected && approveNoPermRejected.status})`);

    // ================= 10) ตั้ง flag can_certify_progress/can_approve_progress ผ่านหน้าจัดการสิทธิ์ (UI) ได้จริง =================
    const fxMaker2Row = await pool.query(`SELECT id FROM customers WHERE username='fx_maker2'`);
    const fxMaker2Id = fxMaker2Row.rows[0].id;
    await loginAs('fx_super');
    await page.click('[data-act="switch-module"][data-module="pr"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="approval_permissions"]');
    await page.waitForTimeout(500);
    await shot(page, 'approval-permissions-page-shows-progress-columns');
    const certifyBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${fxMaker2Id}"][data-column="can_certify_progress"]`);
    const approveBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${fxMaker2Id}"][data-column="can_approve_progress"]`);
    assert(await certifyBtn.count() === 1 && await approveBtn.count() === 1, 'หน้าจัดการสิทธิ์แสดงคอลัมน์+ปุ่มให้สิทธิ์ can_certify_progress/can_approve_progress ของ fx_maker2 ครบทั้งคู่');
    await certifyBtn.click();
    await page.waitForTimeout(500);
    const afterGrant = await pool.query(`SELECT can_certify_progress FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterGrant.rows[0].can_certify_progress === true, 'กดปุ่มให้สิทธิ์ can_certify_progress ผ่าน UI แล้วเปลี่ยนเป็น true จริงใน DB');
    await certifyBtn.click();
    await page.waitForTimeout(500);
    const afterRevoke = await pool.query(`SELECT can_certify_progress FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterRevoke.rows[0].can_certify_progress === false, 'กดปุ่มเพิกถอนสิทธิ์คืนผ่าน UI สำเร็จ (คืนสถานะเดิมให้ fixture)');

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
      if (createdClaimIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='progress_claim' AND doc_id = ANY($1)`, [createdClaimIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'progress-claims-%'`, [COMPANY_A_ID]);
        await pool.query(`DELETE FROM client_revenue_advance_applications WHERE progress_claim_id = ANY($1)`, [createdClaimIds]);
        const revIds = (await pool.query('SELECT revenue_id FROM client_progress_claims WHERE id = ANY($1) AND revenue_id IS NOT NULL', [createdClaimIds])).rows.map(r => r.revenue_id);
        await pool.query('DELETE FROM client_progress_claim_items WHERE progress_claim_id = ANY($1)', [createdClaimIds]);
        await pool.query('DELETE FROM client_progress_claims WHERE id = ANY($1)', [createdClaimIds]);
        if (revIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type IN (\'revenue\',\'retention\') AND source_id = ANY($1))', [revIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE source_type IN (\'revenue\',\'retention\') AND source_id = ANY($1)', [revIds]);
          await pool.query('DELETE FROM client_revenue_payments WHERE revenue_id = ANY($1)', [revIds]);
          await pool.query('DELETE FROM client_revenue WHERE id = ANY($1)', [revIds]);
        }
      }
      if (createdBudgetIds.length) {
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id = ANY($1)', [createdBudgetIds]);
        await pool.query('DELETE FROM client_budget_items WHERE revision_id IN (SELECT id FROM client_budget_revisions WHERE budget_id = ANY($1))', [createdBudgetIds]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id = ANY($1)', [createdBudgetIds]);
        await pool.query('DELETE FROM client_budgets WHERE id = ANY($1)', [createdBudgetIds]);
      }
      if (createdProjectIds.length) {
        await pool.query('DELETE FROM client_project_installments WHERE project_id = ANY($1)', [createdProjectIds]);
        await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [createdProjectIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
