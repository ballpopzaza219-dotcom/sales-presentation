// Real-browser E2E coverage for topic 2.1-2.3 (การเบิกเงินตามใบสั่งจ้าง — client_subcontract_billings,
// migration 0015). Mirrors progress-claims-ui.regression.js's structure. Covers: create(advance/progress/
// retention_release)/list/detail/submit/approve/reject/cancel, the Dr/Cr journal shape per billing_type
// (1160 advance paid / 5200+2130 progress cost / 2140 retention held+released), WHT certificate issuance
// (advance+progress only, not retention_release), the 3 over-limit guards (contract value cumulative,
// advance recovery cumulative, retention release cumulative), and the new permission gate.
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
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `sb-${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }); }

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

function assertJournalBalanced(lines, label) {
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit_amount), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit_amount), 0);
  assert(Math.round(totalDebit * 100) === Math.round(totalCredit * 100), `${label}: SUM(debit)=${totalDebit} เท่ากับ SUM(credit)=${totalCredit} จริง (บัญชีสมดุล)`);
}

async function journalLinesFor(sourceId) {
  const r = await pool.query(
    `SELECT jl.account_code, jl.debit_amount, jl.credit_amount FROM client_journal_entry_lines jl
     JOIN client_journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.source_type='subcontract_billing' AND je.source_id=$1 ORDER BY jl.account_code`,
    [sourceId]
  );
  return r.rows;
}

(async () => {
  let browser;
  const consoleErrors = [];
  const createdProjectIds = [];
  const createdSubcontractorIds = [];
  const createdTermIds = [];
  const createdBillingIds = [];

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

    console.log('Creating prerequisite project + subcontractor + approved contract (contract_value=1,000,000, advance 15%, retention 5%)...');
    const proj = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E เบิกเงินผู้รับเหมาช่วง โครงการ', sectorType: 'private', status: 'in_progress' });
    createdProjectIds.push(proj.project.id);
    const subTaxId = String(1000000000000 + (Date.now() % 1000000000000)).padStart(13, '0').slice(0, 13);
    const sub = await call('fx_procurement', 'POST', '/api/customer/subcontractors', { name: 'ผู้รับเหมาช่วง E2E เบิกเงิน ' + Date.now(), taxpayerType: 'individual', taxId: subTaxId });
    createdSubcontractorIds.push(sub.subcontractor.id);
    const term = await call('fx_procurement', 'POST', '/api/customer/subcontract-terms', {
      subcontractorId: sub.subcontractor.id, projectId: proj.project.id, contractValue: 40000, advancePercent: 15, retentionPercent: 5,
    }, idemKey('sb-term-create'));
    createdTermIds.push(term.subcontractTerm.id);
    await call('fx_procurement', 'POST', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/submit`, {}, idemKey('sb-term-submit'));
    await call('fx_approver_mid', 'POST', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/approve`, {}, idemKey('sb-term-approve'));

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

    // ================= 1) เงินล่วงหน้า (advance) ผ่าน UI — มี WHT (default 40_7 3% เพราะระบุ whtRate เอง) =================
    await loginAs('fx_super'); // fin_subcontract_billings อยู่ใน super_user-only finance section
    await page.click('[data-act="nav"][data-page="fin_subcontract_billings"]');
    await page.waitForTimeout(500);
    await shot(page, 'list-empty-or-existing');
    await page.click('[data-act="nav"][data-page="fin_subcontract_billing_add"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-sbill-term"]', String(term.subcontractTerm.id));
    await page.waitForTimeout(400);
    await shot(page, 'create-advance-balance-loaded');
    await page.fill('#sbill-gross', '6000'); // เงินล่วงหน้า 15% ของ 40000 = 6000 (ตัวอย่างในแผน แต่ scale ลงให้อยู่ในเพดานอนุมัติ)
    await page.fill('#sbill-wht-rate', '3');
    await page.click('[data-act="save-sbill-full"]');
    await page.waitForTimeout(800);
    const advRow = await pool.query(
      `SELECT id, status, billing_type, gross_amount, wht_amount, net_payable_amount FROM client_subcontract_billings WHERE company_id=$1 AND subcontract_term_id=$2 AND billing_type='advance' ORDER BY id DESC LIMIT 1`,
      [COMPANY_A_ID, term.subcontractTerm.id]
    );
    assert(advRow.rowCount === 1 && advRow.rows[0].status === 'draft', `สร้างใบเบิกเงินล่วงหน้าเป็น draft จริงใน DB (ได้ status=${advRow.rows[0] && advRow.rows[0].status})`);
    assert(Number(advRow.rows[0].wht_amount) === 180, `WHT คำนวณถูกต้อง = 6000*3% = 180 (ได้ ${advRow.rows[0].wht_amount})`);
    assert(Number(advRow.rows[0].net_payable_amount) === 5820, `net_payable_amount = 6000-180 = 5820 (ได้ ${advRow.rows[0].net_payable_amount})`);
    const advId = advRow.rows[0].id;
    createdBillingIds.push(advId);

    await page.waitForSelector('[data-act="submit-sbill"]', { timeout: 5000 });
    await page.click('[data-act="submit-sbill"]');
    await page.waitForTimeout(700);
    const advSubmitted = await pool.query('SELECT status, billing_no FROM client_subcontract_billings WHERE id=$1', [advId]);
    assert(advSubmitted.rows[0].status === 'submitted' && !!advSubmitted.rows[0].billing_no, `ยื่นใบเบิกเงินล่วงหน้าแล้วออกเลขที่จริง (billing_no=${advSubmitted.rows[0].billing_no})`);

    // self-block: fx_super สร้าง+ยื่นเอง อนุมัติเองไม่ได้
    let selfApproveBlocked = null;
    try { await call('fx_super', 'POST', `/api/customer/subcontract-billings/${advId}/approve`, {}, idemKey('sb-adv-selfapprove')); }
    catch (e) { selfApproveBlocked = e; }
    assert(selfApproveBlocked !== null && selfApproveBlocked.status === 403, `fx_super (ผู้สร้าง+ผู้ยื่นเอง) อนุมัติใบเบิกเงินล่วงหน้าของตัวเองไม่ได้ 403 (ได้ status=${selfApproveBlocked && selfApproveBlocked.status})`);

    const advApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${advId}/approve`, {}, idemKey('sb-adv-approve'));
    assert(advApproved.subcontractBilling.status === 'approved', 'อนุมัติใบเบิกเงินล่วงหน้าโดยคนละคนสำเร็จจริง');
    assert(!!advApproved.issuedWhtCertificate, `ออกหนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) จริงสำหรับเงินล่วงหน้าที่มี WHT (ได้ cert=${advApproved.issuedWhtCertificate})`);
    const advCert = await pool.query(`SELECT gross_amount, wht_amount, source_type, wht_form FROM client_wht_certificates WHERE cert_no=$1`, [advApproved.issuedWhtCertificate]);
    assert(advCert.rowCount === 1 && advCert.rows[0].source_type === 'subcontractor_payment' && Number(advCert.rows[0].wht_amount) === 180, '50 ทวิ บันทึก source_type=subcontractor_payment และยอด WHT ถูกต้องจริง');
    assert(advCert.rows[0].wht_form === 'pnd3', `50 ทวิ คำนวณ wht_form ถูกต้องตาม taxpayer_type='individual' ของผู้รับเหมาช่วง (migration 0020) (ได้ ${advCert.rows[0].wht_form})`);

    const advLines = await journalLinesFor(advId);
    const dr1160 = advLines.find(l => l.account_code === '1160' && Number(l.debit_amount) === 6000);
    const cr2120adv = advLines.find(l => l.account_code === '2120' && Number(l.credit_amount) === 180);
    const cr1100adv = advLines.find(l => l.account_code === '1100' && Number(l.credit_amount) === 5820);
    assert(!!dr1160, 'journal เงินล่วงหน้า: Dr 1160 เงินจ่ายล่วงหน้าผู้รับเหมาช่วง 6000 จริง');
    assert(!!cr2120adv, 'journal เงินล่วงหน้า: Cr 2120 ภาษีหัก ณ ที่จ่ายค้างนำส่ง 180 จริง');
    assert(!!cr1100adv, 'journal เงินล่วงหน้า: Cr 1100 เงินสด (สุทธิ) 5820 จริง');
    assert(advLines.length === 3, `journal เงินล่วงหน้า: มีทั้งหมด 3 บรรทัดพอดี ไม่มีบรรทัดเกิน (ได้ ${advLines.length})`);
    assertJournalBalanced(advLines, 'journal เงินล่วงหน้า');

    const balAfterAdv = await call('fx_maker', 'GET', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/balance`);
    assert(balAfterAdv.advanceOutstanding === 6000, `ยอดเงินล่วงหน้าคงค้างหลังอนุมัติ = 6000 จริง (ได้ ${balAfterAdv.advanceOutstanding})`);

    // ================= 2) งวดงาน (progress) — หักคืนล่วงหน้า + กันเงินประกันผลงาน + WHT auto-default จากสัญญา =================
    const prog = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'progress', grossAmount: 20000,
    }, idemKey('sb-prog-create'));
    createdBillingIds.push(prog.subcontractBilling.id);
    assert(Number(prog.subcontractBilling.advanceRecoveryAmount) === 3000, `advance_recovery_amount คำนวณอัตโนมัติ = 20000*15% = 3000 (ได้ ${prog.subcontractBilling.advanceRecoveryAmount})`);
    assert(Number(prog.subcontractBilling.retentionAmount) === 1000, `retention_amount คำนวณอัตโนมัติ = 20000*5% = 1000 (ได้ ${prog.subcontractBilling.retentionAmount})`);
    assert(Number(prog.subcontractBilling.whtAmount) === 600, `WHT auto-default จากอัตราของสัญญา (40_7 3%) = 20000*3% = 600 โดยไม่ต้องระบุเอง (ได้ ${prog.subcontractBilling.whtAmount})`);
    assert(Number(prog.subcontractBilling.netPayableAmount) === 15400, `net_payable = 20000 - 3000 - 1000 - 600 = 15400 (ได้ ${prog.subcontractBilling.netPayableAmount})`);

    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/submit`, {}, idemKey('sb-prog-submit'));
    const progApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${prog.subcontractBilling.id}/approve`, {}, idemKey('sb-prog-approve'));
    assert(progApproved.subcontractBilling.status === 'approved', 'อนุมัติใบเบิกงวดงานสำเร็จจริง');
    assert(!!progApproved.issuedWhtCertificate, 'ออก 50 ทวิ สำหรับงวดงานที่มี WHT จริง');

    const progLines = await journalLinesFor(prog.subcontractBilling.id);
    const dr5200 = progLines.find(l => l.account_code === '5200' && Number(l.debit_amount) === 20000);
    const cr1160rec = progLines.find(l => l.account_code === '1160' && Number(l.credit_amount) === 3000);
    const cr2140 = progLines.find(l => l.account_code === '2140' && Number(l.credit_amount) === 1000);
    const cr2120prog = progLines.find(l => l.account_code === '2120' && Number(l.credit_amount) === 600);
    const cr2130 = progLines.find(l => l.account_code === '2130' && Number(l.credit_amount) === 15400);
    assert(!!dr5200, 'journal งวดงาน: Dr 5200 ต้นทุนผู้รับเหมาช่วง 20000 เต็มจำนวน (ฐาน WHT/retention ก็ใช้ยอดนี้เต็มจำนวนเช่นกัน) จริง');
    assert(!!cr1160rec, 'journal งวดงาน: Cr 1160 หักคืนเงินล่วงหน้า 3000 จริง');
    assert(!!cr2140, 'journal งวดงาน: Cr 2140 เงินประกันผลงานค้างจ่าย 1000 จริง');
    assert(!!cr2120prog, 'journal งวดงาน: Cr 2120 ภาษีหัก ณ ที่จ่ายค้างนำส่ง 600 จริง');
    assert(!!cr2130, 'journal งวดงาน: Cr 2130 เจ้าหนี้ผู้รับเหมาช่วง (สุทธิ) 15400 จริง');
    assert(progLines.length === 5, `journal งวดงาน: มีทั้งหมด 5 บรรทัดพอดี (Dr5200 + Cr1160 + Cr2140 + Cr2120 + Cr2130) ไม่มีบรรทัดเกิน (ได้ ${progLines.length})`);
    assertJournalBalanced(progLines, 'journal งวดงาน');

    const balAfterProg = await call('fx_maker', 'GET', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/balance`);
    assert(balAfterProg.advanceOutstanding === 3000, `เงินล่วงหน้าคงค้างลดลงเหลือ 3000 หลังหักคืน (ได้ ${balAfterProg.advanceOutstanding})`);
    assert(balAfterProg.retentionHeld === 1000, `เงินประกันผลงานที่กันไว้ = 1000 (ได้ ${balAfterProg.retentionHeld})`);
    assert(balAfterProg.progressBilledTotal === 20000, `ยอดเบิกสะสม = 20000 (ได้ ${balAfterProg.progressBilledTotal})`);

    // ================= 3) กันเบิกเกินมูลค่าสัญญา (40000 - 20000 = 20000 เหลือ ขอ 25000 ต้องถูกปฏิเสธ) =================
    const overContract = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'progress', grossAmount: 25000,
    }, idemKey('sb-over-contract-create'));
    createdBillingIds.push(overContract.subcontractBilling.id);
    let overContractBlocked = null;
    try { await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${overContract.subcontractBilling.id}/submit`, {}, idemKey('sb-over-contract-submit')); }
    catch (e) { overContractBlocked = e; }
    assert(overContractBlocked !== null && overContractBlocked.status === 400, `ขอเบิกเกินมูลค่าสัญญา (20000+25000=45000 > 40000) ถูกปฏิเสธตอน submit จริง (ได้ status=${overContractBlocked && overContractBlocked.status})`);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${overContract.subcontractBilling.id}/cancel`, {}, idemKey('sb-over-contract-cancel'));

    // ================= 4) คืนเงินประกันผลงาน (retention_release) ผ่าน UI — ไม่มี WHT =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_subcontract_billings"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="fin_subcontract_billing_add"]');
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-sbill-term"]', String(term.subcontractTerm.id));
    await page.waitForTimeout(400);
    await page.selectOption('[data-act="select-sbill-type"]', 'retention_release');
    await page.waitForTimeout(600);
    await shot(page, 'create-retention-release-picker-loaded');
    await page.fill(`input[oninput*="retentionItems['${prog.subcontractBilling.id}']"]`, '1000');
    await page.click('[data-act="save-sbill-full"]');
    await page.waitForTimeout(800);
    const relRow = await pool.query(
      `SELECT sb.id, sb.status, sb.gross_amount, sb.wht_amount, ri.amount FROM client_subcontract_billings sb
       JOIN client_subcontract_retention_release_items ri ON ri.retention_release_billing_id=sb.id
       WHERE sb.company_id=$1 AND sb.subcontract_term_id=$2 AND sb.billing_type='retention_release' ORDER BY sb.id DESC LIMIT 1`,
      [COMPANY_A_ID, term.subcontractTerm.id]
    );
    assert(relRow.rowCount === 1 && Number(relRow.rows[0].gross_amount) === 1000 && Number(relRow.rows[0].wht_amount) === 0,
      `สร้างใบคืนเงินประกันผลงานสำเร็จ gross_amount=1000 (รวมจาก items) และ wht_amount=0 จริง (ได้ gross=${relRow.rows[0].gross_amount}, wht=${relRow.rows[0].wht_amount})`);
    const relId = relRow.rows[0].id;
    createdBillingIds.push(relId);

    await page.waitForSelector('[data-act="submit-sbill"]', { timeout: 5000 });
    await page.click('[data-act="submit-sbill"]');
    await page.waitForTimeout(700);
    const relApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${relId}/approve`, {}, idemKey('sb-rel-approve'));
    assert(relApproved.subcontractBilling.status === 'approved', 'อนุมัติใบคืนเงินประกันผลงานสำเร็จจริง');
    assert(!relApproved.issuedWhtCertificate, 'ไม่ออก 50 ทวิ สำหรับการคืนเงินประกันผลงาน จริงตามที่ยืนยันไว้ (WHT หักครบไปแล้วตอนงวดงาน)');

    const relLines = await journalLinesFor(relId);
    const dr2140rel = relLines.find(l => l.account_code === '2140' && Number(l.debit_amount) === 1000);
    const cr1100rel = relLines.find(l => l.account_code === '1100' && Number(l.credit_amount) === 1000);
    assert(!!dr2140rel && !!cr1100rel, 'journal คืนเงินประกันผลงาน: Dr 2140 / Cr 1100 = 1000 ตรงกันจริง (ไม่มีบรรทัด WHT/VAT อื่นปน)');
    assert(relLines.length === 2, `journal คืนเงินประกันผลงาน: มีทั้งหมด 2 บรรทัดพอดี ไม่มีบรรทัดเกิน (ได้ ${relLines.length})`);
    assertJournalBalanced(relLines, 'journal คืนเงินประกันผลงาน');

    const balAfterRelease = await call('fx_maker', 'GET', `/api/customer/subcontract-terms/${term.subcontractTerm.id}/balance`);
    assert(balAfterRelease.retentionHeld === 0, `เงินประกันผลงานที่กันไว้ลดเหลือ 0 หลังคืนครบจริง (ได้ ${balAfterRelease.retentionHeld})`);

    // ================= 5) กันคืนเงินประกันผลงานเกิน (งวดนี้คืนไปครบ 1000 แล้ว ขอคืนซ้ำอีกต้องถูกปฏิเสธ) =================
    const overRelease = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'retention_release',
      items: [{ sourceProgressBillingId: prog.subcontractBilling.id, amount: 500 }],
    }, idemKey('sb-over-release-create'));
    createdBillingIds.push(overRelease.subcontractBilling.id);
    let overReleaseBlocked = null;
    try { await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${overRelease.subcontractBilling.id}/submit`, {}, idemKey('sb-over-release-submit')); }
    catch (e) { overReleaseBlocked = e; }
    assert(overReleaseBlocked !== null && overReleaseBlocked.status === 400, `คืนเงินประกันผลงานเกินยอดที่กันไว้ (คืนไปครบ 1000 แล้ว ขอคืนอีก 500) ถูกปฏิเสธตอน submit จริง (ได้ status=${overReleaseBlocked && overReleaseBlocked.status})`);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${overRelease.subcontractBilling.id}/cancel`, {}, idemKey('sb-over-release-cancel'));

    // ================= 6) reject flow =================
    const rejBill = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'advance', grossAmount: 500,
    }, idemKey('sb-reject-create'));
    createdBillingIds.push(rejBill.subcontractBilling.id);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${rejBill.subcontractBilling.id}/submit`, {}, idemKey('sb-reject-submit'));
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_subcontract_billings"]');
    await page.waitForTimeout(500);
    await page.click(`button[data-page="fin_subcontract_billing_detail"][data-id="${rejBill.subcontractBilling.id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-sbill-reject"]');
    await page.waitForTimeout(200);
    await page.fill('#sbill-reject-reason', 'ทดสอบปฏิเสธ E2E — เอกสารประกอบไม่ครบ');
    await page.click('[data-act="submit-sbill-reject"]');
    await page.waitForTimeout(700);
    const rejRow = await pool.query('SELECT status, rejected_reason FROM client_subcontract_billings WHERE id=$1', [rejBill.subcontractBilling.id]);
    assert(rejRow.rows[0].status === 'rejected' && rejRow.rows[0].rejected_reason.includes('เอกสารประกอบ'), 'ปฏิเสธใบเบิกเงินแล้วสถานะ rejected พร้อมเหตุผลถูกบันทึกจริง');

    // ================= 7) can_approve_subcontract_billing gate: ไม่มีสิทธิ์ -> 403 no_permission =================
    const gateBill = await call('fx_maker', 'POST', '/api/customer/subcontract-billings', {
      subcontractTermId: term.subcontractTerm.id, billingType: 'advance', grossAmount: 400,
    }, idemKey('sb-gate-create'));
    createdBillingIds.push(gateBill.subcontractBilling.id);
    await call('fx_maker', 'POST', `/api/customer/subcontract-billings/${gateBill.subcontractBilling.id}/submit`, {}, idemKey('sb-gate-submit'));
    let gateNoPermRejected = null;
    try { await call('fx_maker2', 'POST', `/api/customer/subcontract-billings/${gateBill.subcontractBilling.id}/approve`, {}, idemKey('sb-gate-approve-denied')); }
    catch (e) { gateNoPermRejected = e; }
    assert(gateNoPermRejected !== null && gateNoPermRejected.status === 403 && gateNoPermRejected.body.code === 'no_permission',
      `fx_maker2 (ไม่มี can_approve_subcontract_billing) อนุมัติได้ 403 code=no_permission ไม่ใช่ 500 (ได้ status=${gateNoPermRejected && gateNoPermRejected.status})`);
    const gateApproved = await call('fx_approver_mid', 'POST', `/api/customer/subcontract-billings/${gateBill.subcontractBilling.id}/approve`, {}, idemKey('sb-gate-approve-ok'));
    assert(gateApproved.subcontractBilling.status === 'approved', 'fx_approver_mid (มี can_approve_subcontract_billing) อนุมัติสำเร็จจริง');

    // ================= 8) ตั้ง flag can_approve_subcontract_billing ผ่านหน้าจัดการสิทธิ์ (UI) ได้จริง =================
    const fxMaker2Row = await pool.query(`SELECT id FROM customers WHERE username='fx_maker2'`);
    const fxMaker2Id = fxMaker2Row.rows[0].id;
    await loginAs('fx_super');
    await page.click('[data-act="switch-module"][data-module="pr"]');
    await page.waitForTimeout(400);
    await page.click('[data-act="nav"][data-page="approval_permissions"]');
    await page.waitForTimeout(500);
    await shot(page, 'approval-permissions-page-shows-sbill-column');
    const grantBtn = page.locator(`button[data-act="toggle-permission-flag"][data-id="${fxMaker2Id}"][data-column="can_approve_subcontract_billing"]`);
    assert(await grantBtn.count() === 1, 'หน้าจัดการสิทธิ์แสดงคอลัมน์+ปุ่มให้สิทธิ์ can_approve_subcontract_billing ของ fx_maker2');
    await grantBtn.click();
    await page.waitForTimeout(500);
    const afterGrant = await pool.query(`SELECT can_approve_subcontract_billing FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterGrant.rows[0].can_approve_subcontract_billing === true, 'กดปุ่มให้สิทธิ์ผ่าน UI แล้วเปลี่ยนเป็น true จริงใน DB');
    await grantBtn.click();
    await page.waitForTimeout(500);
    const afterRevoke = await pool.query(`SELECT can_approve_subcontract_billing FROM customers WHERE id=$1`, [fxMaker2Id]);
    assert(afterRevoke.rows[0].can_approve_subcontract_billing === false, 'กดปุ่มเพิกถอนสิทธิ์คืนผ่าน UI สำเร็จ (คืนสถานะเดิมให้ fixture)');

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
      if (createdBillingIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='subcontractor_payment' AND doc_id = ANY($1)`, [createdBillingIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'subcontract-billings-%'`, [COMPANY_A_ID]);
        await pool.query(`DELETE FROM client_wht_certificates WHERE source_type='subcontractor_payment' AND source_id = ANY($1)`, [createdBillingIds]);
        const journalIds = (await pool.query(
          `SELECT id FROM client_journal_entries WHERE source_type='subcontract_billing' AND source_id = ANY($1)`, [createdBillingIds]
        )).rows.map(r => r.id);
        if (journalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [journalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [journalIds]);
        }
        await pool.query('DELETE FROM client_subcontract_retention_release_items WHERE retention_release_billing_id = ANY($1)', [createdBillingIds]);
        await pool.query('DELETE FROM client_subcontract_billings WHERE id = ANY($1)', [createdBillingIds]);
      }
      if (createdTermIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='subcontract_term' AND doc_id = ANY($1)`, [createdTermIds]);
        await pool.query('DELETE FROM client_subcontract_terms WHERE id = ANY($1)', [createdTermIds]);
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
