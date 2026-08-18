// Regression suite — client_subcontractors master data (หัวข้อ 2, migration 0009+0010).
// Covers: CRUD, cross-company 404 (via PUT — there's no GET-by-id endpoint, only list), duplicate name
// blocked (including normalize_payee_name collision), duplicate tax_id blocked, juristic+NULL tax_id
// rejected, permission (can_manage_po / no permission / super_user), bank field visibility on GET for
// non-managers, and audit log content (create/edit/deactivate, with old->new + warning marker on bank
// field changes).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/subcontractors.regression.js  (or: npm run test:subcontractors)
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

    // ================= 1) Permission: no permission / can_manage_po / super_user =================
    const eNoPerm = await callExpectError('fx_maker', 'POST', '/api/customer/subcontractors', {
      name: 'Smoke Sub No Perm ' + Date.now(), taxpayerType: 'juristic', taxId: '1111111111111',
    });
    assert(eNoPerm.status === 403, `role='maker' ไม่มี can_manage_po -> 403 (ได้ ${eNoPerm.status})`);

    const viaProcurement = await call('fx_procurement', 'POST', '/api/customer/subcontractors', {
      name: 'Smoke Sub Procurement ' + Date.now(), taxpayerType: 'individual',
    });
    createdIds.push(viaProcurement.subcontractor.id);
    assert(viaProcurement.subcontractor.id > 0, 'role=maker แต่มี can_manage_po=true -> สร้างได้ (ไม่ต้องเป็น super_user)');

    // ================= 2) CRUD พื้นฐาน (super_user) =================
    const uniq = Date.now();
    const created = await call('fx_super', 'POST', '/api/customer/subcontractors', {
      name: `Smoke CRUD Sub ${uniq}`, taxpayerType: 'juristic', taxId: '2222222222222',
      phone: '021234567', contactPerson: 'Somchai', email: 'somchai@example.com',
      bankName: 'SCB', bankAccountNo: '1112223334', bankAccountName: 'Smoke CRUD Sub Co',
    });
    createdIds.push(created.subcontractor.id);
    assert(created.subcontractor.name === `Smoke CRUD Sub ${uniq}`, 'สร้างสำเร็จ ชื่อถูกต้อง');
    assert(created.subcontractor.bankAccountNo === '1112223334', 'สร้างสำเร็จ ข้อมูลธนาคารถูกต้อง (ผู้สร้างเองเห็นได้เพราะมีสิทธิ์)');

    const edited = await call('fx_super', 'PUT', `/api/customer/subcontractors/${created.subcontractor.id}`, {
      name: `Smoke CRUD Sub ${uniq} Edited`, taxpayerType: 'juristic', taxId: '2222222222222',
      phone: '029999999', contactPerson: 'Somchai V2', email: 'somchai@example.com',
      bankName: 'SCB', bankAccountNo: '9998887776', bankAccountName: 'Smoke CRUD Sub Co',
    });
    assert(edited.subcontractor.name === `Smoke CRUD Sub ${uniq} Edited`, 'แก้ไขสำเร็จ ชื่อเปลี่ยนจริง');
    assert(edited.subcontractor.bankAccountNo === '9998887776', 'แก้ไขสำเร็จ เลขบัญชีเปลี่ยนจริง');

    // PUT เป็น full-replace เสมอ (ไม่ใช่ partial patch) — ต้องส่งครบทุกฟิลด์รวมข้อมูลธนาคารเดิมด้วย
    // ไม่งั้นจะถูกเคลียร์เป็นค่าว่างไปโดยไม่ตั้งใจ (ตรงกับที่ UI จริงทำ: ฟอร์มแก้ไขโหลดค่าปัจจุบันมาเต็ม
    // ก่อนเสมอ ไม่เคยส่งแบบ partial)
    const deactivated = await call('fx_super', 'PUT', `/api/customer/subcontractors/${created.subcontractor.id}`, {
      name: `Smoke CRUD Sub ${uniq} Edited`, taxpayerType: 'juristic', taxId: '2222222222222',
      phone: '029999999', contactPerson: 'Somchai V2', email: 'somchai@example.com',
      bankName: 'SCB', bankAccountNo: '9998887776', bankAccountName: 'Smoke CRUD Sub Co',
      isActive: false,
    });
    assert(deactivated.subcontractor.isActive === false, 'ปิดใช้งานสำเร็จ');

    // ================= 3) Cross-company 404 (ผ่าน PUT — ไม่มี GET-by-id) =================
    const eCross = await callExpectError('fx_other_co', 'PUT', `/api/customer/subcontractors/${created.subcontractor.id}`, {
      name: 'Hacked Name', taxpayerType: 'individual',
    });
    assert(eCross.status === 404, `บริษัทอื่นแก้ผู้รับเหมาช่วงบริษัทเราไม่ได้ 404 (ได้ ${eCross.status})`);

    // ================= 4) ชื่อซ้ำถูกบล็อก (รวม normalize collision) =================
    const fullName = `บริษัท ทดสอบซ้ำ ${uniq} จำกัด`;
    const shortName = `ทดสอบซ้ำ ${uniq}`; // normalize_payee_name() ตัดคำนำหน้า/ต่อท้ายออก ต้องชนกัน
    const first = await call('fx_super', 'POST', '/api/customer/subcontractors', { name: fullName, taxpayerType: 'individual' });
    createdIds.push(first.subcontractor.id);
    const eDupName = await callExpectError('fx_super', 'POST', '/api/customer/subcontractors', { name: shortName, taxpayerType: 'individual' });
    assert(eDupName.status === 409, `ชื่อ "${shortName}" ชนกับ "${fullName}" หลัง normalize (ตัดคำว่า "บริษัท"/"จำกัด" ออก) -> 409 (ได้ ${eDupName.status})`);

    // ================= 5) tax_id ซ้ำถูกบล็อก =================
    const taxIdUniq = '3' + String(uniq).padStart(12, '0').slice(0, 12);
    const firstTax = await call('fx_super', 'POST', '/api/customer/subcontractors', { name: `Tax Dup A ${uniq}`, taxpayerType: 'juristic', taxId: taxIdUniq });
    createdIds.push(firstTax.subcontractor.id);
    const eDupTax = await callExpectError('fx_super', 'POST', '/api/customer/subcontractors', { name: `Tax Dup B ${uniq}`, taxpayerType: 'juristic', taxId: taxIdUniq });
    assert(eDupTax.status === 409, `เลขผู้เสียภาษี ${taxIdUniq} ซ้ำ -> 409 (ได้ ${eDupTax.status})`);

    // ================= 6) juristic + tax_id NULL ถูกปฏิเสธ =================
    const eNoTaxId = await callExpectError('fx_super', 'POST', '/api/customer/subcontractors', { name: `No TaxId Juristic ${uniq}`, taxpayerType: 'juristic' });
    assert(eNoTaxId.status === 400, `นิติบุคคลไม่ระบุเลขผู้เสียภาษี -> 400 (ได้ ${eNoTaxId.status})`);

    // ================= 7) GET จากคนไม่มีสิทธิ์ -> bank fields เป็น null จริงใน response =================
    const listAsMaker = await call('fx_maker', 'GET', '/api/customer/subcontractors');
    const seenByMaker = listAsMaker.subcontractors.find(s => s.id === created.subcontractor.id);
    assert(seenByMaker !== undefined, 'fx_maker (ไม่มีสิทธิ์จัดการ) เห็นรายการได้ (GET ไม่ gate สิทธิ์)');
    assert(seenByMaker.bankName === null && seenByMaker.bankAccountNo === null && seenByMaker.bankAccountName === null,
      `fx_maker ไม่เห็นข้อมูลธนาคารเลย (ได้ bankName=${JSON.stringify(seenByMaker.bankName)}, bankAccountNo=${JSON.stringify(seenByMaker.bankAccountNo)})`);
    assert(seenByMaker.name === `Smoke CRUD Sub ${uniq} Edited`, 'แต่ยังเห็นชื่อ/ข้อมูลทั่วไปปกติ (ซ่อนแค่ธนาคาร ไม่ใช่ทั้งแถว)');

    const listAsSuper = await call('fx_super', 'GET', '/api/customer/subcontractors');
    const seenBySuper = listAsSuper.subcontractors.find(s => s.id === created.subcontractor.id);
    assert(seenBySuper.bankAccountNo === '9998887776', 'super_user เห็นข้อมูลธนาคารเต็มตามปกติ');

    // ================= 8) Audit log: create/edit/deactivate ครบ + ค่าเก่า->ค่าใหม่ + ⚠️ ธนาคาร =================
    const auditRows = await pool.query(
      `SELECT action, reason, performed_by FROM client_document_audit_log
       WHERE company_id=$1 AND doc_type='subcontractor' AND doc_id=$2 ORDER BY id`,
      [COMPANY_A_ID, created.subcontractor.id]
    );
    const actions = auditRows.rows.map(r => r.action);
    assert(actions.includes('create'), `audit log มี action='create' (ได้ ${JSON.stringify(actions)})`);
    assert(actions.filter(a => a === 'edit').length === 2, `audit log มี action='edit' 2 แถว (แก้ข้อมูล + ปิดใช้งาน) (ได้ ${actions.filter(a => a === 'edit').length})`);

    const bankEditLog = auditRows.rows.find(r => r.action === 'edit' && r.reason.includes('ข้อมูลธนาคาร'));
    assert(!!bankEditLog, 'มี audit log แถวที่บันทึกการแก้ไขข้อมูลธนาคารโดยเฉพาะ');
    assert(bankEditLog.reason.includes('⚠️'), `reason มี ⚠️ นำหน้าเวลาแก้ข้อมูลธนาคาร (ได้ "${bankEditLog.reason}")`);
    assert(bankEditLog.reason.includes('1112223334') && bankEditLog.reason.includes('9998887776'),
      `reason มีทั้งเลขบัญชีเก่า (1112223334) และใหม่ (9998887776) ระบุอยู่จริง (ได้ "${bankEditLog.reason}")`);
    assert(bankEditLog.performed_by === ids['fx_super'], `audit log บันทึกว่า fx_super เป็นคนแก้จริง (ได้ ${bankEditLog.performed_by})`);

    const deactivateLog = auditRows.rows.find(r => r.reason.includes('สถานะ'));
    assert(!!deactivateLog, 'มี audit log แถวที่บันทึกการเปลี่ยนสถานะ (ปิดใช้งาน)');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='subcontractor' AND doc_id = ANY($1)`, [createdIds]);
        await pool.query('DELETE FROM client_subcontractors WHERE id = ANY($1)', [createdIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
