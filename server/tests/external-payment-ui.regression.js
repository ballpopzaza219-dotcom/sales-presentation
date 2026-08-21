// Real-browser E2E coverage for topic 1.4 (external payment / "other" vouchers) via Playwright:
// external payee master CRUD (3.2), voucher_type='other' create/edit/submit/approve/reject/cancel with
// VAT+WHT (3.3), and the WHT certificate list/print pages (3.4).
// Not part of `npm run test:client-ledger` (pure HTTP/DB) — run standalone against a live local server.
// Two illustrative scenarios per the spec: case 4.1 (utility bill, VAT but no WHT) and case 4.2
// (professional service fee, VAT+WHT) — mirrors the numbers already covered by the HTTP-level
// external-payment.regression.js (amount 10,000 / VAT 7% / WHT 3%) so the two suites cross-check.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name){ shotN++; await page.screenshot({ path: path.join(SHOT_DIR, `oth-${String(shotN).padStart(2,'0')}-${name}.png`), fullPage: true }); }

let passed = 0;
function assert(cond, msg){ if(!cond) throw new Error('ASSERTION FAILED: '+msg); passed++; console.log('  OK:', msg); }

(async () => {
  let browser;
  const consoleErrors = [];
  const createdPayeeIds = [];
  const createdVoucherIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyCode = companyRes.rows[0].code;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
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

    // ================= 3.2: สร้าง/แก้ไขผู้รับเงินภายนอก (super_user) =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_external_payees"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-payee"]');
    await page.waitForTimeout(200);
    const payeeName = 'E2E การไฟฟ้า ' + Date.now();
    await page.fill('#f-payeeName', payeeName);
    await page.selectOption('#f-payeeTaxpayerType', 'juristic');
    await page.fill('#f-payeeTaxId', '1234567890123');
    await page.fill('#f-payeeDefaultWhtRate', '0');
    await page.click('[data-act="submit-payee"]');
    await page.waitForTimeout(600);
    await shot(page, 'payee-created');
    const payeeRow = await pool.query('SELECT id FROM client_external_payees WHERE company_id=$1 AND name=$2', [COMPANY_A_ID, payeeName]);
    assert(payeeRow.rowCount===1, `ผู้รับเงิน "${payeeName}" ถูกสร้างจริงใน DB`);
    const payeeId = payeeRow.rows[0].id;
    createdPayeeIds.push(payeeId);

    await page.click(`[data-act="open-edit-payee"][data-id="${payeeId}"]`);
    await page.waitForTimeout(300);
    await page.fill('#f-payeeDefaultWhtRate', '3');
    await page.click('[data-act="submit-payee"]');
    await page.waitForTimeout(600);
    const payeeEdited = await pool.query('SELECT default_wht_rate FROM client_external_payees WHERE id=$1', [payeeId]);
    assert(Number(payeeEdited.rows[0].default_wht_rate)===3, `แก้ไขอัตราหัก ณ ที่จ่ายเริ่มต้นสำเร็จจริง = 3 (ได้ ${payeeEdited.rows[0].default_wht_rate})`);

    // ผู้รับเงินอีกรายแบบไม่มีเลขผู้เสียภาษี (บุคคลธรรมดา) — ใช้ทดสอบ guard ข้อ "WHT>0 ต้องมีเลขภาษี" ด้านล่าง
    await page.click('[data-act="open-add-payee"]');
    await page.waitForTimeout(200);
    const noTaxIdPayeeName = 'E2E ผู้รับเงินไม่มีเลขภาษี ' + Date.now();
    await page.fill('#f-payeeName', noTaxIdPayeeName);
    await page.selectOption('#f-payeeTaxpayerType', 'individual');
    await page.click('[data-act="submit-payee"]');
    await page.waitForTimeout(600);
    const noTaxIdPayeeRow = await pool.query('SELECT id FROM client_external_payees WHERE company_id=$1 AND name=$2', [COMPANY_A_ID, noTaxIdPayeeName]);
    const noTaxIdPayeeId = noTaxIdPayeeRow.rows[0].id;
    createdPayeeIds.push(noTaxIdPayeeId);

    // ================= 3.3 เคส 4.1: ค่าไฟ มี VAT แต่ไม่มี WHT (fx_maker, ไม่ใช่ super_user) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    assert(await page.locator('#f-vFund').count()===0, 'ฟอร์มไม่มี dropdown กองทุน (other ไม่มีกองทุน)');
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    assert(await page.locator('#f-vExternalPayee').count()===1, 'ฟอร์มมี dropdown ผู้รับเงินภายนอก (ไม่ใช่ dropdown พนักงาน)');
    assert(await page.locator('#f-vEmployee').count()===0, 'ฟอร์มไม่มี dropdown พนักงาน');
    await page.selectOption('#f-vExternalPayee', String(payeeId));
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.fill('#f-vAmount', '5000');
    await page.fill('#f-vPurpose', 'E2E เคส 4.1 ค่าไฟฟ้า');
    // มีใบกำกับภาษีเต็มรูป + VAT 7% แต่ไม่ระบุประเภทเงินได้/ไม่มี WHT
    await page.check('#f-vHasTaxInvoice');
    await page.fill('#f-vVatRate', '7');
    await page.waitForTimeout(150);
    await shot(page, 'case41-form-live-summary');
    // ตรวจยอดสรุปสดที่คำนวณขณะกรอก (ก่อนกด save) ตรงตามสูตร amount+vat (ไม่มี WHT)
    const summaryVat = await page.locator('#vSummaryVat').textContent();
    const summaryTotal = await page.locator('#vSummaryTotal').textContent();
    assert(summaryVat.replace(/[^0-9.]/g,'')==='350.00', `ยอดสรุปสด VAT = 350.00 (7% ของ 5,000) คำนวณถูกต้องขณะกรอก ก่อน submit (ได้ "${summaryVat}")`);
    assert(summaryTotal.replace(/[^0-9.]/g,'')==='5350.00', `ยอดสรุปสด รวม = 5,350.00 คำนวณถูกต้องขณะกรอก (ได้ "${summaryTotal}")`);
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    await shot(page, 'case41-draft');
    const voucher41Row = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='other' AND purpose LIKE 'E2E เคส 4.1%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    assert(voucher41Row.rowCount===1, 'เคส 4.1 ถูกสร้างเป็น draft จริงใน DB');
    const voucher41Id = voucher41Row.rows[0].id;
    createdVoucherIds.push(voucher41Id);
    const v41Check = await pool.query('SELECT vat_rate, vat_amount, wht_rate, wht_amount, net_amount FROM client_payment_vouchers WHERE id=$1', [voucher41Id]);
    assert(Number(v41Check.rows[0].vat_amount)===350, `บันทึกจริงใน DB: VAT amount = 350 (ได้ ${v41Check.rows[0].vat_amount})`);
    assert(Number(v41Check.rows[0].wht_amount)===0, `บันทึกจริงใน DB: ไม่มี WHT (ได้ ${v41Check.rows[0].wht_amount})`);
    assert(Number(v41Check.rows[0].net_amount)===5350, `บันทึกจริงใน DB: จ่ายจริง = 5,350 (ได้ ${v41Check.rows[0].net_amount})`);

    await page.click(`tr[data-id="${voucher41Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(700);

    // fx_maker2 ไม่มี can_approve_other -> ไม่เห็นปุ่มอนุมัติ
    await loginAs('fx_maker2');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucher41Id}"]`);
    await page.waitForTimeout(500);
    assert(await page.locator('[data-act="approve-voucher"]').count()===0, 'fx_maker2 (ไม่มี can_approve_other) ไม่เห็นปุ่มอนุมัติเลย');

    // approve ด้วย fx_approver_mid (มีสิทธิ์+rule 0-50000)
    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucher41Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="approve-voucher"]');
    await page.waitForTimeout(800);
    await shot(page, 'case41-approved');
    const v41Approved = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucher41Id]);
    assert(v41Approved.rows[0].status==='approved', `เคส 4.1 อนุมัติสำเร็จจริง (ได้ ${v41Approved.rows[0].status})`);

    const j41 = await pool.query(
      `SELECT account_code, debit_amount, credit_amount FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='payment_voucher' AND e.source_id=$1 ORDER BY l.id`,
      [voucher41Id]
    );
    assert(j41.rowCount===3, `เคส 4.1 มี journal 3 บรรทัด (Dr ค่าใช้จ่าย + Dr VAT / Cr เงินสด) ไม่มีบรรทัด WHT (ได้ ${j41.rowCount})`);
    const dr41Expense = j41.rows.find(r=>r.account_code==='5300');
    const dr41Vat = j41.rows.find(r=>r.account_code==='1170');
    const cr41Cash = j41.rows.find(r=>r.account_code==='1100');
    assert(dr41Expense && Number(dr41Expense.debit_amount)===5000, `Dr 5300 (ค่าใช้จ่าย) = 5,000 (ได้ ${dr41Expense&&dr41Expense.debit_amount})`);
    assert(dr41Vat && Number(dr41Vat.debit_amount)===350, `Dr 1170 (ภาษีซื้อ) = 350 (ได้ ${dr41Vat&&dr41Vat.debit_amount})`);
    assert(cr41Cash && Number(cr41Cash.credit_amount)===5350, `Cr 1100 (เงินสด-ธนาคาร) = 5,350 (ได้ ${cr41Cash&&cr41Cash.credit_amount})`);
    assert(!j41.rows.find(r=>r.account_code==='2120'), 'เคส 4.1 ไม่มีบรรทัด Cr 2120 (ภาษีหัก ณ ที่จ่าย) เพราะไม่มี WHT');

    const cert41 = await pool.query(`SELECT id FROM client_wht_certificates WHERE company_id=$1 AND source_type='payment_voucher' AND source_id=$2`, [COMPANY_A_ID, voucher41Id]);
    assert(cert41.rowCount===0, 'เคส 4.1 ไม่ออก 50 ทวิ เพราะไม่มี WHT จริง (ได้ ' + cert41.rowCount + ' ใบ)');

    // ================= 3.3 เคส 4.2: ค่าวิชาชีพอิสระ มี VAT+WHT (fx_maker) =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vExternalPayee', String(payeeId));
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.fill('#f-vAmount', '10000');
    await page.fill('#f-vPurpose', 'E2E เคส 4.2 ค่าวิชาชีพอิสระ');
    await page.check('#f-vHasTaxInvoice');
    await page.fill('#f-vVatRate', '7');
    // เลือกประเภทเงินได้ 40(2) — ต้อง auto-fill อัตรา WHT = 3% จาก default_rate
    await page.selectOption('#f-vWhtIncomeType', '40_2');
    await page.waitForTimeout(150);
    const autoFilledWhtRate = await page.locator('#f-vWhtRate').inputValue();
    assert(autoFilledWhtRate==='3', `เลือกประเภทเงินได้ 40(2) แล้ว auto-fill อัตรา WHT = 3 จริง (ได้ "${autoFilledWhtRate}")`);
    assert(await page.locator('#vWhtNullRateWarning').isHidden(), 'ไม่มีคำเตือนอัตราว่าง เพราะ 40(2) มี default_rate จริง');
    await shot(page, 'case42-form-autofill');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(700);
    const voucher42Row = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='other' AND purpose LIKE 'E2E เคส 4.2%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    const voucher42Id = voucher42Row.rows[0].id;
    createdVoucherIds.push(voucher42Id);
    const v42Check = await pool.query('SELECT vat_amount, wht_rate, wht_amount, net_amount FROM client_payment_vouchers WHERE id=$1', [voucher42Id]);
    assert(Number(v42Check.rows[0].vat_amount)===700, `บันทึกจริงใน DB: VAT = 700 (7% ของ 10,000) (ได้ ${v42Check.rows[0].vat_amount})`);
    assert(Number(v42Check.rows[0].wht_amount)===300, `บันทึกจริงใน DB: WHT = 300 (3% ของ 10,000) (ได้ ${v42Check.rows[0].wht_amount})`);
    assert(Number(v42Check.rows[0].net_amount)===10400, `บันทึกจริงใน DB: จ่ายจริง = 10,400 (10,000+700-300) (ได้ ${v42Check.rows[0].net_amount})`);

    await page.click(`tr[data-id="${voucher42Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(700);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucher42Id}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="approve-voucher"]');
    await page.waitForTimeout(800);
    await shot(page, 'case42-approved');

    const j42 = await pool.query(
      `SELECT account_code, debit_amount, credit_amount FROM client_journal_entry_lines l
       JOIN client_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_type='payment_voucher' AND e.source_id=$1 ORDER BY l.id`,
      [voucher42Id]
    );
    assert(j42.rowCount===4, `เคส 4.2 มี journal 4 บรรทัด (Dr ค่าใช้จ่าย + Dr VAT / Cr WHT + Cr เงินสด) (ได้ ${j42.rowCount})`);
    const totalDebit42 = j42.rows.reduce((s,r)=>s+Number(r.debit_amount),0);
    const totalCredit42 = j42.rows.reduce((s,r)=>s+Number(r.credit_amount),0);
    assert(totalDebit42===totalCredit42, `เคส 4.2 journal สมดุล Dr รวม (${totalDebit42}) = Cr รวม (${totalCredit42})`);
    const cr42Wht = j42.rows.find(r=>r.account_code==='2120');
    assert(cr42Wht && Number(cr42Wht.credit_amount)===300, `Cr 2120 (ภาษีหัก ณ ที่จ่ายค้างนำส่ง) = 300 (ได้ ${cr42Wht&&cr42Wht.credit_amount})`);

    const cert42 = await pool.query(
      `SELECT cert_no, wht_income_type_code, wht_income_type_name_snapshot, wht_amount, payee_tax_id
       FROM client_wht_certificates WHERE company_id=$1 AND source_type='payment_voucher' AND source_id=$2`,
      [COMPANY_A_ID, voucher42Id]
    );
    assert(cert42.rowCount===1, `เคส 4.2 ออก 50 ทวิ 1 ใบพอดี (ได้ ${cert42.rowCount})`);
    assert(!!cert42.rows[0].cert_no, `เลขที่ 50 ทวิ ไม่ซ้ำ/ถูกออกจริง (ได้ "${cert42.rows[0].cert_no}")`);
    assert(cert42.rows[0].wht_income_type_name_snapshot.includes('40(2)') || cert42.rows[0].wht_income_type_name_snapshot.includes('ค่านายหน้า'), `ชื่อประเภทเงินได้ถูก freeze ไว้ในใบจริง (ได้ "${cert42.rows[0].wht_income_type_name_snapshot}")`);
    assert(Number(cert42.rows[0].wht_amount)===300, `ยอดหัก ณ ที่จ่ายใน 50 ทวิ = 300 ตรงกับที่คำนวณ (ได้ ${cert42.rows[0].wht_amount})`);

    // snapshot ต้อง freeze จริง — แก้ชื่อผู้รับเงินหลังออกใบแล้ว ใบเก่าต้องไม่เปลี่ยนตาม
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_external_payees"]');
    await page.waitForTimeout(500);
    await page.click(`[data-act="open-edit-payee"][data-id="${payeeId}"]`);
    await page.waitForTimeout(200);
    const renamedPayeeName = payeeName + ' (เปลี่ยนชื่อแล้ว)';
    await page.fill('#f-payeeName', renamedPayeeName);
    await page.click('[data-act="submit-payee"]');
    await page.waitForTimeout(600);
    const certAfterRename = await pool.query('SELECT payee_name FROM client_wht_certificates WHERE cert_no=$1', [cert42.rows[0].cert_no]);
    assert(certAfterRename.rows[0].payee_name===payeeName && certAfterRename.rows[0].payee_name!==renamedPayeeName,
      `เปลี่ยนชื่อผู้รับเงินใน master data แล้ว ใบ 50 ทวิ ที่ออกไปแล้วยัง freeze ชื่อเดิมไว้จริง ไม่เปลี่ยนตาม (ได้ "${certAfterRename.rows[0].payee_name}")`);

    // ================= UI guard: has_tax_invoice=false บังคับ vat=0 =================
    await loginAs('fx_maker');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    assert(await page.locator('#f-vVatRate').isDisabled(), 'ฟิลด์อัตราภาษีซื้อ disabled ตั้งแต่เริ่ม (ไม่ติ๊ก "มีใบกำกับภาษี")');
    await page.check('#f-vHasTaxInvoice');
    assert(!(await page.locator('#f-vVatRate').isDisabled()), 'ติ๊ก "มีใบกำกับภาษี" แล้วฟิลด์ VAT เปิดใช้งานได้');
    await page.fill('#f-vVatRate', '7');
    await page.uncheck('#f-vHasTaxInvoice');
    const vatAfterUncheck = await page.locator('#f-vVatRate').inputValue();
    assert(vatAfterUncheck==='0', `เอาติ๊ก "มีใบกำกับภาษี" ออกแล้ว VAT rate ถูกล้างเป็น 0 ทันที (กันกรอกแล้วโดน DB ปฏิเสธทีหลัง) (ได้ "${vatAfterUncheck}")`);
    assert(await page.locator('#f-vVatRate').isDisabled(), 'ฟิลด์ VAT กลับมา disabled หลังเอาติ๊กออก');

    // ================= UI guard: WHT>0 แต่ผู้รับเงินไม่มีเลขผู้เสียภาษี ต้องบล็อกก่อน submit =================
    await page.selectOption('#f-vExternalPayee', String(noTaxIdPayeeId));
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.fill('#f-vAmount', '1000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบ guard ไม่มีเลขภาษี');
    await page.selectOption('#f-vWhtIncomeType', '40_2');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(500);
    await shot(page, 'guard-no-taxid-blocked');
    const toastNoTaxId = await page.locator('.toast, [class*="toast"]').last().textContent().catch(()=>null);
    assert(toastNoTaxId && toastNoTaxId.includes('เลขผู้เสียภาษี'), `บล็อกตั้งแต่ฝั่ง UI ด้วยข้อความไทยชัดเจน (ได้ "${toastNoTaxId}")`);
    const blockedRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND purpose='E2E ทดสอบ guard ไม่มีเลขภาษี'`, [COMPANY_A_ID]);
    assert(blockedRow.rowCount===0, 'ใบที่ควรถูกบล็อกไม่ได้ถูกสร้างขึ้นจริงใน DB (UI กันไว้ก่อนยิง API จริง)');
    // toast() เรียก render() ทันที ซึ่ง regenerate ฟอร์มจาก S.voucherForm.values ใหม่ทั้งก้อน — ถ้าไม่ sync
    // ค่าที่เพิ่งอ่านจาก DOM กลับเข้า state ก่อน validate ฟอร์มจะรีเซ็ตว่างเปล่าทันทีที่เจอ validation แรก
    // (พบเป็นบั๊กจริงตอนเขียนเทสนี้ — แก้แล้วที่ submit-voucher-create handler, เช็คซ้ำตรงนี้กันไม่ให้กลับมา)
    const purposeAfterBlock = await page.locator('#f-vPurpose').inputValue();
    const amountAfterBlock = await page.locator('#f-vAmount').inputValue();
    assert(purposeAfterBlock==='E2E ทดสอบ guard ไม่มีเลขภาษี', `ฟอร์มไม่รีเซ็ตหลัง toast แจ้ง error — วัตถุประสงค์ที่กรอกไว้ยังอยู่ครบ (ได้ "${purposeAfterBlock}")`);
    assert(amountAfterBlock==='1000', `ฟอร์มไม่รีเซ็ตหลัง toast แจ้ง error — จำนวนเงินที่กรอกไว้ยังอยู่ครบ (ได้ "${amountAfterBlock}")`);
    await page.click('[data-act="cancel-voucher-form"]');

    // ================= reject + cancel (เหมือนขั้นก่อนหน้า) =================
    await page.click('[data-act="open-add-voucher"]');
    await page.waitForTimeout(200);
    await page.selectOption('#f-vExternalPayee', String(payeeId));
    await page.selectOption('#f-vExpenseAccount', '5300');
    await page.fill('#f-vAmount', '2000');
    await page.fill('#f-vPurpose', 'E2E ทดสอบปฏิเสธ C');
    await page.click('[data-act="submit-voucher-create"]');
    await page.waitForTimeout(600);
    const voucherCRow = await pool.query(`SELECT id FROM client_payment_vouchers WHERE company_id=$1 AND voucher_type='other' AND purpose LIKE 'E2E ทดสอบปฏิเสธ C%' ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID]);
    const voucherCId = voucherCRow.rows[0].id;
    createdVoucherIds.push(voucherCId);
    await page.click(`tr[data-id="${voucherCId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="submit-voucher"]');
    await page.waitForTimeout(600);

    await loginAs('fx_approver_mid');
    await page.click('[data-act="nav"][data-page="fin_vouchers_other"]');
    await page.waitForTimeout(500);
    await page.click(`tr[data-id="${voucherCId}"]`);
    await page.waitForTimeout(500);
    await page.click('[data-act="open-reject-voucher"]');
    await page.waitForTimeout(200);
    await page.fill('#f-vRejectReason', 'E2E เหตุผลทดสอบการปฏิเสธ');
    await page.click('[data-act="submit-reject-voucher"]');
    await page.waitForTimeout(700);
    const voucherCCheck = await pool.query('SELECT status FROM client_payment_vouchers WHERE id=$1', [voucherCId]);
    assert(voucherCCheck.rows[0].status==='rejected', 'ปฏิเสธสำเร็จจริงใน DB');

    // ================= 3.4: หน้ารายการ + พิมพ์ 50 ทวิ =================
    await loginAs('fx_super');
    await page.click('[data-act="nav"][data-page="fin_wht_certificates"]');
    await page.waitForTimeout(600);
    await shot(page, 'wht-cert-list');
    const certRowVisible = await page.locator(`text=${cert42.rows[0].cert_no}`).count();
    assert(certRowVisible>0, `หน้ารายการ 50 ทวิ แสดงใบที่ออกจากเคส 4.2 จริง (เลขที่ ${cert42.rows[0].cert_no})`);
    await page.click(`[data-act="print-wht-certificate"]`);
    await page.waitForTimeout(600);
    await shot(page, 'wht-cert-print');
    const printPageText = await page.locator('body').innerText();
    assert(printPageText.includes('300.00') || printPageText.includes('300'), 'หน้าพิมพ์แสดงยอดหัก ณ ที่จ่าย 300 จริง');
    assert(printPageText.includes('50 ทวิ') || printPageText.includes('มาตรา 50'), 'หน้าพิมพ์มีหัวเรื่องอ้างอิงมาตรา 50 ทวิ ตามแบบฟอร์มจริง');

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
      if (createdVoucherIds.length) {
        await pool.query(`DELETE FROM client_wht_certificates WHERE company_id=$1 AND source_type='payment_voucher' AND source_id = ANY($2)`, [COMPANY_A_ID, createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1))`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [createdVoucherIds]);
        await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND endpoint = ANY($2)`, [COMPANY_A_ID, createdVoucherIds.flatMap(id => [`payment-vouchers-submit:${id}`, `payment-vouchers-approve:${id}`])]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [createdVoucherIds]);
      }
      if (createdPayeeIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='external_payee' AND doc_id = ANY($1)`, [createdPayeeIds]);
        await pool.query('DELETE FROM client_external_payees WHERE id = ANY($1)', [createdPayeeIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
