// Regression suite — client_external_payees master data (หัวข้อ 1.4, migration 0001 schema +
// migration 0011 audit doc_type). Covers: CRUD, cross-company 404 (via PUT — no GET-by-id endpoint,
// only list), duplicate name blocked (incl. normalize_payee_name collision), duplicate tax_id blocked,
// juristic+NULL tax_id rejected (app-level — DB schema has no CHECK for this, unlike subcontractors),
// invalid default_expense_account_code rejected, permission (can_manage_po / no permission / super_user),
// and audit log content (create/edit/deactivate, old->new).
//
// ⚠️ Requires migration 0011 (external_payee_audit_doctype) to be applied first — the audit log INSERT
// in the create/edit endpoints will fail with a doc_type CHECK violation until then.
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/external-payees.regression.js  (or: npm run test:external-payees)
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {};
async function call(username, method, urlPath, body) {
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function callExpectError(username, method, urlPath, body) {
  try { await call(username, method, urlPath, body); throw new Error(`expected ${method} ${urlPath} (as ${username}) to fail but it succeeded`); }
  catch (e) { if (e.status === undefined) throw e; return e; }
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}

(async () => {
  const createdIds = [];
  try {
    console.log('Ensuring fixtures...');
    const { ids } = await setup();

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;

    await login('fx_super', codeA);
    await login('fx_maker', codeA);
    await login('fx_procurement', codeA);
    await login('fx_other_co', codeB);

    const expenseAccountRes = await pool.query(`SELECT code FROM client_chart_of_accounts WHERE company_id=$1 AND category='expense' AND is_active=true LIMIT 1`, [COMPANY_A_ID]);
    const expenseAccountCode = expenseAccountRes.rows[0].code;

    // ================= 1) Permission: no permission / can_manage_po / super_user =================
    const eNoPerm = await callExpectError('fx_maker', 'POST', '/api/customer/external-payees', {
      name: 'Smoke Payee No Perm ' + Date.now(), taxpayerType: 'juristic', taxId: '1111111111111',
    });
    assert(eNoPerm.status === 403, `role='maker' ไม่มี can_manage_po -> 403 (ได้ ${eNoPerm.status})`);

    const viaProcurement = await call('fx_procurement', 'POST', '/api/customer/external-payees', {
      name: 'Smoke Payee Procurement ' + Date.now(), taxpayerType: 'individual',
    });
    createdIds.push(viaProcurement.externalPayee.id);
    assert(viaProcurement.externalPayee.id > 0, 'role=maker แต่มี can_manage_po=true -> สร้างได้ (ไม่ต้องเป็น super_user)');

    // ================= 2) CRUD พื้นฐาน (super_user) =================
    const uniq = Date.now();
    const created = await call('fx_super', 'POST', '/api/customer/external-payees', {
      name: `Smoke CRUD Payee ${uniq}`, taxpayerType: 'juristic', taxId: '2222222222222',
      address: '123 ถนนทดสอบ', defaultWhtRate: 3, defaultExpenseAccountCode: expenseAccountCode,
    });
    createdIds.push(created.externalPayee.id);
    assert(created.externalPayee.name === `Smoke CRUD Payee ${uniq}`, 'สร้างสำเร็จ ชื่อถูกต้อง');
    assert(created.externalPayee.defaultWhtRate === 3, 'สร้างสำเร็จ อัตราหัก ณ ที่จ่ายเริ่มต้นถูกต้อง');
    assert(created.externalPayee.defaultExpenseAccountCode === expenseAccountCode, 'สร้างสำเร็จ รหัสบัญชีค่าใช้จ่ายเริ่มต้นถูกต้อง');

    const edited = await call('fx_super', 'PUT', `/api/customer/external-payees/${created.externalPayee.id}`, {
      name: `Smoke CRUD Payee ${uniq} Edited`, taxpayerType: 'juristic', taxId: '2222222222222',
      address: '456 ถนนทดสอบ', defaultWhtRate: 5, defaultExpenseAccountCode: expenseAccountCode,
    });
    assert(edited.externalPayee.name === `Smoke CRUD Payee ${uniq} Edited`, 'แก้ไขสำเร็จ ชื่อเปลี่ยนจริง');
    assert(edited.externalPayee.defaultWhtRate === 5, 'แก้ไขสำเร็จ อัตราหัก ณ ที่จ่ายเปลี่ยนจริง');

    // PUT เป็น full-replace เสมอ (ไม่ใช่ partial patch)
    const deactivated = await call('fx_super', 'PUT', `/api/customer/external-payees/${created.externalPayee.id}`, {
      name: `Smoke CRUD Payee ${uniq} Edited`, taxpayerType: 'juristic', taxId: '2222222222222',
      address: '456 ถนนทดสอบ', defaultWhtRate: 5, defaultExpenseAccountCode: expenseAccountCode,
      isActive: false,
    });
    assert(deactivated.externalPayee.isActive === false, 'ปิดใช้งานสำเร็จ');

    // ================= 3) Cross-company 404 (ผ่าน PUT — ไม่มี GET-by-id) =================
    const eCross = await callExpectError('fx_other_co', 'PUT', `/api/customer/external-payees/${created.externalPayee.id}`, {
      name: 'Hacked Name', taxpayerType: 'individual',
    });
    assert(eCross.status === 404, `บริษัทอื่นแก้ผู้รับเงินภายนอกบริษัทเราไม่ได้ 404 (ได้ ${eCross.status})`);

    // ================= 4) ชื่อซ้ำถูกบล็อก (รวม normalize collision) =================
    const fullName = `บริษัท ทดสอบซ้ำผู้รับเงิน ${uniq} จำกัด`;
    const shortName = `ทดสอบซ้ำผู้รับเงิน ${uniq}`;
    const first = await call('fx_super', 'POST', '/api/customer/external-payees', { name: fullName, taxpayerType: 'individual' });
    createdIds.push(first.externalPayee.id);
    const eDupName = await callExpectError('fx_super', 'POST', '/api/customer/external-payees', { name: shortName, taxpayerType: 'individual' });
    assert(eDupName.status === 409, `ชื่อ "${shortName}" ชนกับ "${fullName}" หลัง normalize -> 409 (ได้ ${eDupName.status})`);

    // ================= 5) tax_id ซ้ำถูกบล็อก =================
    const taxIdUniq = '4' + String(uniq).padStart(12, '0').slice(0, 12);
    const firstTax = await call('fx_super', 'POST', '/api/customer/external-payees', { name: `Payee Tax Dup A ${uniq}`, taxpayerType: 'juristic', taxId: taxIdUniq });
    createdIds.push(firstTax.externalPayee.id);
    const eDupTax = await callExpectError('fx_super', 'POST', '/api/customer/external-payees', { name: `Payee Tax Dup B ${uniq}`, taxpayerType: 'juristic', taxId: taxIdUniq });
    assert(eDupTax.status === 409, `เลขผู้เสียภาษี ${taxIdUniq} ซ้ำ -> 409 (ได้ ${eDupTax.status})`);

    // ================= 6) juristic + tax_id NULL ถูกปฏิเสธ (app-level, ไม่มี DB CHECK) =================
    const eNoTaxId = await callExpectError('fx_super', 'POST', '/api/customer/external-payees', { name: `Payee No TaxId Juristic ${uniq}`, taxpayerType: 'juristic' });
    assert(eNoTaxId.status === 400, `นิติบุคคลไม่ระบุเลขผู้เสียภาษี -> 400 (ได้ ${eNoTaxId.status})`);

    // ================= 7) รหัสบัญชีค่าใช้จ่ายเริ่มต้นที่ไม่มีจริง ถูกปฏิเสธ =================
    const eBadAccount = await callExpectError('fx_super', 'POST', '/api/customer/external-payees', {
      name: `Payee Bad Account ${uniq}`, taxpayerType: 'individual', defaultExpenseAccountCode: '9999999-not-real',
    });
    assert(eBadAccount.status === 400, `รหัสบัญชีค่าใช้จ่ายเริ่มต้นที่ไม่มีจริง -> 400 (ได้ ${eBadAccount.status})`);

    // ================= 8) GET ไม่ gate สิทธิ์ (ทุกคนเห็นได้ ไม่มีข้อมูลอ่อนไหวต้องซ่อน) =================
    const listAsMaker = await call('fx_maker', 'GET', '/api/customer/external-payees');
    const seenByMaker = listAsMaker.externalPayees.find(p => p.id === created.externalPayee.id);
    assert(seenByMaker !== undefined, 'fx_maker (ไม่มีสิทธิ์จัดการ) เห็นรายการได้ (GET ไม่ gate สิทธิ์)');
    assert(seenByMaker.name === `Smoke CRUD Payee ${uniq} Edited`, 'เห็นชื่อ/ข้อมูลถูกต้องครบ');

    // ================= 9) Audit log: create/edit/deactivate ครบ + ค่าเก่า->ค่าใหม่ =================
    const auditRows = await pool.query(
      `SELECT action, reason, performed_by FROM client_document_audit_log
       WHERE company_id=$1 AND doc_type='external_payee' AND doc_id=$2 ORDER BY id`,
      [COMPANY_A_ID, created.externalPayee.id]
    );
    const actions = auditRows.rows.map(r => r.action);
    assert(actions.includes('create'), `audit log มี action='create' (ได้ ${JSON.stringify(actions)})`);
    assert(actions.filter(a => a === 'edit').length === 2, `audit log มี action='edit' 2 แถว (แก้ข้อมูล + ปิดใช้งาน) (ได้ ${actions.filter(a => a === 'edit').length})`);

    const rateEditLog = auditRows.rows.find(r => r.action === 'edit' && r.reason.includes('อัตราหัก ณ ที่จ่ายเริ่มต้น'));
    assert(!!rateEditLog, 'มี audit log แถวที่บันทึกการแก้ไขอัตราหัก ณ ที่จ่ายเริ่มต้น');
    // ค่าเก่ามาจาก DB ตรงๆ (NUMERIC(5,2) จึงมี .00 ต่อท้าย) ส่วนค่าใหม่มาจาก string ที่ผู้ใช้กรอกโดยตรง
    // (ไม่ reformat) — รูปแบบทศนิยมต่างกันได้ตามที่มาของค่าแต่ละฝั่ง เช็คแค่ตัวเลขนัยสำคัญตรงกันพอ
    assert(/3(\.00)?%/.test(rateEditLog.reason) && /5(\.00)?%/.test(rateEditLog.reason), `reason มีทั้งอัตราเก่า (3%) และใหม่ (5%) ระบุอยู่จริง (ได้ "${rateEditLog.reason}")`);
    assert(rateEditLog.performed_by === ids['fx_super'], `audit log บันทึกว่า fx_super เป็นคนแก้จริง (ได้ ${rateEditLog.performed_by})`);

    const deactivateLog = auditRows.rows.find(r => r.reason.includes('สถานะ'));
    assert(!!deactivateLog, 'มี audit log แถวที่บันทึกการเปลี่ยนสถานะ (ปิดใช้งาน)');

    // ================= 10) GET /api/customer/wht-income-types =================
    const incomeTypes = await call('fx_maker', 'GET', '/api/customer/wht-income-types');
    assert(Array.isArray(incomeTypes.incomeTypes) && incomeTypes.incomeTypes.length > 0, `มีรายชื่อประเภทเงินได้มาตรา 40 จริง (ได้ ${incomeTypes.incomeTypes.length} รายการ)`);
    const salaryType = incomeTypes.incomeTypes.find(t => t.code === '40_1');
    assert(salaryType && salaryType.defaultRate === null, `40(1) เงินเดือน defaultRate เป็น null จริง (ไม่ fallback เป็น 0) (ได้ ${salaryType && salaryType.defaultRate})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='external_payee' AND doc_id = ANY($1)`, [createdIds]);
        await pool.query('DELETE FROM client_external_payees WHERE id = ANY($1)', [createdIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
