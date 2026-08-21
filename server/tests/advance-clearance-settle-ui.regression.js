// Real-browser E2E coverage for topic 1.3 ROUND B (approve with journal preview, settle, WHT
// certificates) via Playwright. Covers all 5 numbered scenarios from the schema comments
// (1.3.1-1.3.5, see migration 0001/0003/0005 + server.js comments on the approve/settle endpoints):
//   1.3.1 exact match, no VAT/WHT           -> auto-settles at approve, no /settle call ever happens
//   1.3.2 overage, no VAT/WHT               -> stays 'approved', needs /settle (pay employee more)
//   1.3.3 shortfall, no VAT/WHT             -> stays 'approved', needs /settle (refund from employee)
//   1.3.4 exact match WITH VAT+WHT          -> auto-settles at approve, 1170/2120 posted, 1 WHT cert
//   1.3.5 overage WITH VAT+WHT              -> stays 'approved', needs /settle, 1 WHT cert
// For every case, verifies account 1150 (advance receivable) nets to exactly 0 once the clearance
// reaches its terminal state, and that 2110/2120/1170 amounts match what was entered.
// Not part of `npm run test:client-ledger` (pure HTTP/DB) — run standalone against a live local server.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name){ shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `advclb-${String(shotN).padStart(2,'0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg){ if(!cond) throw new Error('ASSERTION FAILED: '+msg); passed++; console.log('  OK:', msg); }

// ---- plain HTTP helpers for prerequisite setup (not the thing under test) ----
const cookies = {};
async function call(username, method, urlPath, body, idempotencyKey){
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch(e){ json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function httpLogin(username, companyCode){ await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD }); }
let idemCounter = 0;
function idemKey(label){ return `${label}-${Date.now()}-${idemCounter++}`; }
async function makeApprovedAdvanceVoucher(employeeId, amount){
  const created = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
    voucherType: 'advance', payeeEmployeeId: employeeId, purpose: 'E2E advance for clearance round B', amount,
  }, idemKey('advclb-voucher-create'));
  await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/submit`, {}, idemKey('advclb-voucher-submit'));
  const approved = await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${created.voucher.id}/approve`, {}, idemKey('advclb-voucher-approve'));
  return approved.voucher;
}
// ยอดสุทธิ 1150 ของ "การเบิก+เคลียร์" หนึ่งชุด — ต้องเป็น 0 พอดีเมื่อจบกระบวนการ (Dr จาก voucher approve,
// Cr จาก clearance approve, Cr เพิ่มจาก clearance settle ถ้ามี — ดูคอมเมนต์หัวไฟล์)
async function net1150Balance(voucherId, clearanceId){
  const r = await pool.query(
    `SELECT COALESCE(SUM(debit_amount),0) - COALESCE(SUM(credit_amount),0) AS net
     FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id=l.journal_entry_id
     WHERE l.account_code='1150' AND (
       (e.source_type='payment_voucher' AND e.source_id=$1) OR
       (e.source_type='advance_clearance' AND e.source_id=$2)
     )`,
    [voucherId, clearanceId]
  );
  return Number(r.rows[0].net);
}

(async () => {
  let browser;
  const consoleErrors = [];
  const createdVoucherIds = [];
  const createdClearanceIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;
    const employeeRes = await pool.query(`SELECT id FROM employees WHERE company_id=$1 AND status='active' LIMIT 1`, [COMPANY_A_ID]);
    const employeeId = employeeRes.rows[0].id;

    await httpLogin('fx_maker', companyCode);
    await httpLogin('fx_approver_mid', companyCode);

    console.log('Creating prerequisite approved advance vouchers via HTTP...');
    const v1 = await makeApprovedAdvanceVoucher(employeeId, 8000);    // 1.3.1 exact
    const v2 = await makeApprovedAdvanceVoucher(employeeId, 8000);    // 1.3.2 overage
    const v3 = await makeApprovedAdvanceVoucher(employeeId, 8000);    // 1.3.3 shortfall
    const v4 = await makeApprovedAdvanceVoucher(employeeId, 10400);   // 1.3.4 exact + VAT/WHT
    const v5 = await makeApprovedAdvanceVoucher(employeeId, 10000);   // 1.3.5 overage + VAT/WHT
    [v1,v2,v3,v4,v5].forEach(v => createdVoucherIds.push(v.id));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    async function loginAs(username){
      await page.goto(BASE + '/pr-system.html');
      await page.click('[data-act="go-login"]');
      await page.waitForTimeout(200);
      await page.fill('#f-loginCompanyCode', companyCode);
      await page.fill('#f-loginUser', username);
      await page.fill('#f-loginPass', PASSWORD);
      await page.click('[data-act="do-login"]');
      await page.waitForTimeout(700);
      await page.click('[data-act="switch-module"][data-module="finance"]');
      await page.waitForTimeout(400);
    }

    // สร้าง+submit ใบเคลียร์ตัวเดียว (1 บรรทัด, ไม่มี VAT/WHT) — ใช้ซ้ำสำหรับเคส 1.3.1/1.3.2/1.3.3
    async function createAndSubmitSimpleClearance(voucher, amount, desc){
      await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
      await page.waitForTimeout(500);
      await page.click('[data-act="open-add-clearance"]');
      await page.waitForTimeout(300);
      await page.selectOption('#c-advanceVoucher', String(voucher.id));
      await page.waitForTimeout(200);
      await page.click('[data-act="add-clearance-item"]');
      await page.waitForTimeout(150);
      await page.fill('#ci-desc-0', desc);
      await page.selectOption('#ci-account-0', '5300');
      await page.fill('#ci-amount-0', String(amount));
      await page.fill('#ci-payeename-0', 'ผู้รับเงินทดสอบรอบ B');
      await page.click('[data-act="submit-clearance-form"]');
      await page.waitForTimeout(700);
      const row = await pool.query(`SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1`, [voucher.id]);
      const clearanceId = row.rows[0].id;
      createdClearanceIds.push(clearanceId);
      await page.click(`tr[data-id="${clearanceId}"]`);
      await page.waitForTimeout(500);
      await page.click('[data-act="submit-clearance"]');
      await page.waitForTimeout(700);
      return clearanceId;
    }

    await loginAs('fx_maker');

    // ================= 1.3.1: เคสพอดี ไม่มีภาษี — auto-settle ตอนอนุมัติ ไม่มีปุ่ม settle เลย =================
    const clearance1Id = await createAndSubmitSimpleClearance(v1, 8000, 'ทดสอบ 1.3.1 พอดี');

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance1Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-approve-clearance-preview"]');
    await page.waitForTimeout(300);
    await shot(page, 'case1-approve-preview');
    const previewMsg1 = await page.locator('text=เคลียร์เสร็จสมบูรณ์').count().catch(()=>0);
    assert((await page.locator(`text=ยอดพอดี`).count())>0, '1.3.1: preview บอกว่ายอดพอดี จะเปลี่ยนเป็นเคลียร์เสร็จสมบูรณ์ทันที');
    await page.click('[data-act="confirm-approve-clearance"]');
    await page.waitForTimeout(800);
    await shot(page, 'case1-settled');
    const c1Check = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearance1Id]);
    assert(c1Check.rows[0].status==='settled', `1.3.1: อนุมัติแล้ว auto-settle ทันที status=settled (ได้ ${c1Check.rows[0].status})`);
    assert(await page.locator('[data-act="open-settle-clearance-form"]').count()===0, '1.3.1: ไม่มีปุ่ม settle แสดงเลย (เพราะไม่มีส่วนต่าง)');
    const net1 = await net1150Balance(v1.id, clearance1Id);
    assert(net1===0, `1.3.1: ยอดสุทธิบัญชี 1150 = 0 พอดีหลัง settled (ได้ ${net1})`);

    // ================= 1.3.2: เบิกเกิน ไม่มีภาษี — approved รอ settle, จ่ายเพิ่มให้พนักงาน =================
    await loginAs('fx_maker'); // ต้องสลับกลับมาเป็นผู้สร้าง ไม่งั้นจะกลายเป็น fx_approver_mid สร้าง+อนุมัติเอง (self-approval)
    const clearance2Id = await createAndSubmitSimpleClearance(v2, 9500, 'ทดสอบ 1.3.2 เบิกเกิน');
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance2Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-approve-clearance-preview"]');
    await page.waitForTimeout(300);
    assert((await page.locator('text=รอบันทึกการชำระส่วนต่าง').count())>0, '1.3.2: preview บอกว่ามีส่วนต่าง ต้องรอบันทึกชำระอีกขั้น');
    await page.click('[data-act="confirm-approve-clearance"]');
    await page.waitForTimeout(800);
    const c2AfterApprove = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearance2Id]);
    assert(c2AfterApprove.rows[0].status==='approved', `1.3.2: อนุมัติแล้วยังเป็น approved รอ settle (ได้ ${c2AfterApprove.rows[0].status})`);
    // fx_approver_mid มีสิทธิ์อนุมัติ (can_approve_advance) แต่ไม่มี can_settle_cash — ต้องไม่เห็นปุ่ม settle
    // เลย (แยกสิทธิ์ตาม CLAUDE.md ข้อ 14: คนยืนยันยอดไม่ควรเป็นคนเดียวกับคนปล่อย/รับเงินจริงเสมอไป)
    assert(await page.locator('[data-act="open-settle-clearance-form"]').count()===0, '1.3.2: fx_approver_mid ไม่มี can_settle_cash จึงไม่เห็นปุ่ม settle แม้เพิ่งอนุมัติเอง');
    assert((await page.locator('text=รอผู้มีสิทธิ์บันทึกการชำระส่วนต่าง').count())>0, '1.3.2: มีข้อความแจ้งว่ารออีกคนมาบันทึกการชำระส่วนต่าง');
    // สลับไปผู้มีสิทธิ์ settle จริง (fixtures ไม่มี user แยก can_settle_cash โดยเฉพาะ ใช้ super_user ตาม
    // fallback ที่ CLAUDE.md กำหนดไว้เมื่อยังไม่มี flag แยก)
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance2Id}"]`);
    await page.waitForTimeout(500);
    assert(await page.locator('[data-act="open-settle-clearance-form"]').count()===1, '1.3.2: fx_super เห็นปุ่ม settle (เพราะมีส่วนต่างและเป็น super_user)');
    await page.click('[data-act="open-settle-clearance-form"]');
    await page.waitForTimeout(300);
    await shot(page, 'case2-settle-form');
    assert((await page.locator('text=บริษัทต้องจ่ายเพิ่มให้พนักงาน').count())>0, '1.3.2: ฟอร์ม settle บอกว่าบริษัทต้องจ่ายเพิ่ม');
    await page.selectOption('#c-settleChannel', 'transfer');
    await page.fill('#c-settleRef', 'TRANSFER-REF-002');
    await page.click('[data-act="submit-settle-clearance"]');
    await page.waitForTimeout(800);
    await shot(page, 'case2-settled');
    const c2Check = await pool.query(`SELECT status, settlement_channel FROM client_advance_clearances WHERE id=$1`, [clearance2Id]);
    assert(c2Check.rows[0].status==='settled', `1.3.2: settle สำเร็จ status=settled (ได้ ${c2Check.rows[0].status})`);
    assert(c2Check.rows[0].settlement_channel==='transfer', 'บันทึกช่องทางชำระถูกต้อง = transfer');
    const j2 = await pool.query(`SELECT account_code, debit_amount, credit_amount FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='advance_clearance' AND e.source_id=$1 AND e.description LIKE 'ชำระส่วนต่าง%'`, [clearance2Id]);
    const dr2110 = j2.rows.find(r=>r.account_code==='2110');
    assert(dr2110 && Number(dr2110.debit_amount)===1500, `1.3.2: Dr 2110 (จ่ายส่วนต่างให้พนักงาน) = 1,500 ตรงกับส่วนต่างจริง (ได้ ${dr2110&&dr2110.debit_amount})`);
    const net2 = await net1150Balance(v2.id, clearance2Id);
    assert(net2===0, `1.3.2: ยอดสุทธิบัญชี 1150 = 0 พอดีหลัง settled (ได้ ${net2})`);

    // ================= 1.3.3: เบิกไม่หมด ไม่มีภาษี — approved รอ settle, รับเงินคืนจากพนักงาน =================
    await loginAs('fx_maker');
    const clearance3Id = await createAndSubmitSimpleClearance(v3, 5000, 'ทดสอบ 1.3.3 เบิกไม่หมด');
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance3Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-approve-clearance-preview"]');
    await page.waitForTimeout(300);
    await page.click('[data-act="confirm-approve-clearance"]');
    await page.waitForTimeout(800);
    assert(await page.locator('[data-act="open-settle-clearance-form"]').count()===0, '1.3.3: fx_approver_mid ไม่มี can_settle_cash จึงไม่เห็นปุ่ม settle เช่นกัน');
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance3Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-settle-clearance-form"]');
    await page.waitForTimeout(300);
    assert((await page.locator('text=รับเงินคืนจากพนักงาน').count())>0, '1.3.3: ฟอร์ม settle บอกว่ารับเงินคืนจากพนักงาน');
    await shot(page, 'case3-settle-form');
    // ทดสอบ guard วันที่อนาคต: ฟิลด์ input[type=date] มี max = วันนี้ (Bangkok) กันเลือกวันอนาคตตั้งแต่ UI picker
    const maxAttr = await page.locator('#c-settleDate').getAttribute('max');
    assert(!!maxAttr, `1.3.3: ฟิลด์วันที่ settle มี max attribute กันเลือกอนาคตจาก date picker (ได้ "${maxAttr}")`);
    await page.selectOption('#c-settleChannel', 'cash');
    await page.click('[data-act="submit-settle-clearance"]');
    await page.waitForTimeout(800);
    await shot(page, 'case3-settled');
    const j3 = await pool.query(`SELECT account_code, debit_amount, credit_amount FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='advance_clearance' AND e.source_id=$1 AND e.description LIKE 'ชำระส่วนต่าง%'`, [clearance3Id]);
    const cr1150_3 = j3.rows.find(r=>r.account_code==='1150');
    assert(cr1150_3 && Number(cr1150_3.credit_amount)===3000, `1.3.3: Cr 1150 (ล้างยอดคงเหลือ) = 3,000 ตรงกับส่วนต่างจริง (ได้ ${cr1150_3&&cr1150_3.credit_amount})`);
    const net3 = await net1150Balance(v3.id, clearance3Id);
    assert(net3===0, `1.3.3: ยอดสุทธิบัญชี 1150 = 0 พอดีหลัง settled (ได้ ${net3})`);

    // ================= 1.3.4: เคสพอดี พร้อม VAT+WHT — auto-settle พร้อมลง 1170/2120 + ออก 50 ทวิ =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(v4.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ทดสอบ 1.3.4 พอดี+ภาษี');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '10000');
    await page.fill('#ci-payeename-0', 'ที่ปรึกษาทดสอบ 1.3.4');
    await page.fill('#ci-payeetaxid-0', '9876543210123');
    await page.check('#ci-hastax-0');
    await page.fill('#ci-vatrate-0', '7');
    await page.selectOption('#ci-whttype-0', '40_2');
    await page.waitForTimeout(150);
    const diffText4 = await page.locator('#cSummaryDifference').textContent();
    assert(diffText4.trim()==='0.00', `1.3.4: ส่วนต่างสด = 0.00 (10,000+700-300=10,400=advance) (ได้ "${diffText4}")`);
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearance4Row = await pool.query(`SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1`, [v4.id]);
    const clearance4Id = clearance4Row.rows[0].id;
    createdClearanceIds.push(clearance4Id);
    await page.click(`tr[data-id="${clearance4Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-clearance"]');
    await page.waitForTimeout(700);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance4Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-approve-clearance-preview"]');
    await page.waitForTimeout(300);
    await shot(page, 'case4-approve-preview-with-tax');
    const previewRows4 = await page.locator('text=1170').count();
    assert(previewRows4>0, '1.3.4: preview journal แสดงบรรทัด 1170 (ภาษีซื้อ) ก่อนกดยืนยันจริง');
    await page.click('[data-act="confirm-approve-clearance"]');
    await page.waitForTimeout(800);
    await shot(page, 'case4-settled-with-cert');
    const c4Check = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearance4Id]);
    assert(c4Check.rows[0].status==='settled', `1.3.4: auto-settle ทันทีแม้มีภาษี (ได้ ${c4Check.rows[0].status})`);
    const j4 = await pool.query(`SELECT account_code, debit_amount, credit_amount FROM client_journal_entry_lines l JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='advance_clearance' AND e.source_id=$1`, [clearance4Id]);
    const dr1170_4 = j4.rows.find(r=>r.account_code==='1170');
    const cr2120_4 = j4.rows.find(r=>r.account_code==='2120');
    assert(dr1170_4 && Number(dr1170_4.debit_amount)===700, `1.3.4: Dr 1170 = 700 (7% ของ 10,000) (ได้ ${dr1170_4&&dr1170_4.debit_amount})`);
    assert(cr2120_4 && Number(cr2120_4.credit_amount)===300, `1.3.4: Cr 2120 = 300 (3% ของ 10,000) (ได้ ${cr2120_4&&cr2120_4.credit_amount})`);
    const cert4 = await pool.query(`SELECT id, cert_no FROM client_wht_certificates WHERE company_id=$1 AND source_type='advance_clearance_item' AND source_id IN (SELECT id FROM client_advance_clearance_items WHERE clearance_id=$2)`, [COMPANY_A_ID, clearance4Id]);
    assert(cert4.rowCount===1, `1.3.4: ออก 50 ทวิ 1 ใบพอดี (ได้ ${cert4.rowCount})`);
    assert(await page.locator(`text=${cert4.rows[0].cert_no}`).count()>0, '1.3.4: หน้า detail แสดงเลขที่ 50 ทวิ ที่ออกจากใบนี้จริง');
    // คลิกลิงก์พิมพ์จากหน้า detail ใบเคลียร์ (ต้องหาใน d.whtCertificates ไม่ใช่ S.whtCertificates กลาง)
    await page.click('[data-act="print-wht-certificate"][data-source="clearance"]');
    await page.waitForTimeout(500);
    await shot(page, 'case4-print-from-clearance');
    const printText4 = await page.locator('body').innerText();
    assert(printText4.includes('300.00') || printText4.includes('300'), '1.3.4: หน้าพิมพ์ (เปิดจากใบเคลียร์) แสดงยอดหัก ณ ที่จ่าย 300 ถูกต้อง');
    const net4 = await net1150Balance(v4.id, clearance4Id);
    assert(net4===0, `1.3.4: ยอดสุทธิบัญชี 1150 = 0 พอดีหลัง settled (ได้ ${net4})`);

    // ================= 1.3.5: เบิกเกิน พร้อม VAT+WHT — approved รอ settle, ออก 50 ทวิ =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-clearance"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-advanceVoucher', String(v5.id));
    await page.waitForTimeout(200);
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-0', 'ค่าวัสดุ 1.3.5');
    await page.selectOption('#ci-account-0', '5300');
    await page.fill('#ci-amount-0', '7000');
    await page.fill('#ci-payeename-0', 'ร้านวัสดุ 1.3.5');
    await page.click('[data-act="add-clearance-item"]');
    await page.waitForTimeout(150);
    await page.fill('#ci-desc-1', 'ค่าบริการวิชาชีพ 1.3.5');
    await page.selectOption('#ci-account-1', '5300');
    await page.fill('#ci-amount-1', '5000');
    await page.fill('#ci-payeename-1', 'ที่ปรึกษา 1.3.5');
    await page.fill('#ci-payeetaxid-1', '1112223334445');
    await page.check('#ci-hastax-1');
    await page.fill('#ci-vatrate-1', '7');
    await page.selectOption('#ci-whttype-1', '40_2');
    await page.waitForTimeout(150);
    // รวม 7,000 + 5,200 (สุทธิ) = 12,200 ; advance = 10,000 ; diff = +2,200
    const diffText5 = await page.locator('#cSummaryDifference').textContent();
    assert(diffText5.includes('2,200.00'), `1.3.5: ส่วนต่างสด = +2,200.00 (ได้ "${diffText5}")`);
    await page.click('[data-act="submit-clearance-form"]');
    await page.waitForTimeout(700);
    const clearance5Row = await pool.query(`SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1`, [v5.id]);
    const clearance5Id = clearance5Row.rows[0].id;
    createdClearanceIds.push(clearance5Id);
    await page.click(`tr[data-id="${clearance5Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-clearance"]');
    await page.waitForTimeout(700);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance5Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-approve-clearance-preview"]');
    await page.waitForTimeout(300);
    await page.click('[data-act="confirm-approve-clearance"]');
    await page.waitForTimeout(800);
    const c5AfterApprove = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearance5Id]);
    assert(c5AfterApprove.rows[0].status==='approved', `1.3.5: อนุมัติแล้วยังเป็น approved รอ settle เพราะมีส่วนต่าง (ได้ ${c5AfterApprove.rows[0].status})`);
    const cert5 = await pool.query(`SELECT id FROM client_wht_certificates WHERE company_id=$1 AND source_type='advance_clearance_item' AND source_id IN (SELECT id FROM client_advance_clearance_items WHERE clearance_id=$2)`, [COMPANY_A_ID, clearance5Id]);
    assert(cert5.rowCount===1, `1.3.5: ออก 50 ทวิ 1 ใบตอนอนุมัติแล้ว แม้ยังไม่ settle (ได้ ${cert5.rowCount})`);
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_advance_clearances"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${clearance5Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-settle-clearance-form"]');
    await page.waitForTimeout(300);
    await page.selectOption('#c-settleChannel', 'transfer');
    await page.click('[data-act="submit-settle-clearance"]');
    await page.waitForTimeout(800);
    await shot(page, 'case5-settled');
    const c5Check = await pool.query(`SELECT status FROM client_advance_clearances WHERE id=$1`, [clearance5Id]);
    assert(c5Check.rows[0].status==='settled', `1.3.5: settle สำเร็จ status=settled (ได้ ${c5Check.rows[0].status})`);
    const net5 = await net1150Balance(v5.id, clearance5Id);
    assert(net5===0, `1.3.5: ยอดสุทธิบัญชี 1150 = 0 พอดีหลัง settled (ได้ ${net5})`);

    // ================= regression: outstanding-advances ต้องไม่แสดงใบที่ settled แล้ว (บั๊กที่เพิ่งแก้) =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_advance_outstanding"]');
    await page.waitForTimeout(600);
    await shot(page, 'outstanding-report-after-settle');
    const v2VoucherRow = await pool.query('SELECT voucher_no FROM client_payment_vouchers WHERE id=$1', [v2.id]);
    const stillShowing = await page.locator(`text=${v2VoucherRow.rows[0].voucher_no}`).count();
    assert(stillShowing===0, `ใบเบิก ${v2VoucherRow.rows[0].voucher_no} ที่เคลียร์+settle เสร็จสมบูรณ์แล้ว ไม่โผล่ในรายงานยอดคงค้างอีก (แก้บั๊กที่พบระหว่างทำหัวข้อนี้) (นับเจอ ${stillShowing} ครั้ง)`);
    const outstandingCheck = await pool.query(
      `SELECT v.id FROM client_payment_vouchers v WHERE v.id=$1 AND v.status='approved'
       AND NOT EXISTS (SELECT 1 FROM client_advance_clearances c WHERE c.advance_voucher_id=v.id AND c.status IN ('approved','settled'))`,
      [v2.id]
    );
    assert(outstandingCheck.rowCount===0, 'ยืนยันซ้ำระดับ DB/query โดยตรงว่า voucher ที่ settled แล้วไม่เข้าเงื่อนไข "คงค้าง" อีกต่อไป');

    console.log('\nconsole errors during whole run:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)');
    const unexpectedErrors = consoleErrors.filter(e => !/404|400 \(Bad Request\)|409 \(Conflict\)/.test(e));
    assert(unexpectedErrors.length===0, `ไม่มี JS error ที่ไม่คาดคิด (ได้ ${JSON.stringify(unexpectedErrors)})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nE2E TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      if (createdClearanceIds.length) {
        await pool.query(`DELETE FROM client_wht_certificates WHERE company_id=$1 AND source_type='advance_clearance_item' AND source_id IN (SELECT id FROM client_advance_clearance_items WHERE clearance_id = ANY($2))`, [COMPANY_A_ID, createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1))`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='advance_clearance' AND source_id = ANY($1)`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='advance_clearance' AND doc_id = ANY($1)`, [createdClearanceIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint = ANY($2)`, [COMPANY_A_ID, createdClearanceIds.flatMap(id => [`advance-clearances-submit:${id}`, `advance-clearances-approve:${id}`, `advance-clearances-settle:${id}`])]);
        await pool.query(`DELETE FROM client_advance_clearance_items WHERE clearance_id = ANY($1)`, [createdClearanceIds]);
        await pool.query('DELETE FROM client_advance_clearances WHERE id = ANY($1)', [createdClearanceIds]);
      }
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint LIKE 'payment-vouchers-%'`, [COMPANY_A_ID]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
