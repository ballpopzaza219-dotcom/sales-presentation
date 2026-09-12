// Regression suite — client_customers (migration 0025, blueprint ข้อ 9: CRM/Sales) + CRUD endpoints.
// Covers: permission (super_user only), partial unique index on tax_id (company-scoped, only enforced
// when tax_id is set), normalize_payee_name()-based unique index on name (catches whitespace/case/
// corporate-suffix variants of the same name, reused from client_subcontractors/client_external_payees),
// cross-tenant access returning 404 (not 403, verified untouched at the DB layer too), audit log rows
// on create/edit with real field-diff reasons, and the known isActive-defaults-to-true-on-omit PUT
// behavior (same as client_subcontractors/client_branches/client_departments).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres, migration 0025 already applied. Run: cd server && node tests/client-customers.regression.js
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
  const cleanup = { customerIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;
    await login('fx_super', codeA);
    await login('fx_maker', codeA);
    await login('fx_other_co', codeB);

    // ============================================================================================
    // (1) สิทธิ์ — เฉพาะ super_user เท่านั้น
    // ============================================================================================
    console.log('\n=== (1) สิทธิ์: super_user เท่านั้น ===');
    const denied = await callExpectError('fx_maker', 'POST', '/api/customer/clients', { name: 'x' });
    assert(denied.status === 403, `fx_maker (ไม่ใช่ super_user) สร้างลูกค้าไม่ได้ 403 (ได้ ${denied.status})`);

    // ============================================================================================
    // (2) สร้างลูกค้าจริง + audit log
    // ============================================================================================
    console.log('\n=== (2) สร้างลูกค้า + audit log ===');
    const custA = await call('fx_super', 'POST', '/api/customer/clients', {
      name: 'บริษัท ทดสอบ E2E จำกัด', taxId: '1234567890123', phone: '02-111-1111', contactPerson: 'คุณเอ',
    });
    cleanup.customerIds.push(custA.customer.id);
    assert(custA.customer.name === 'บริษัท ทดสอบ E2E จำกัด' && custA.customer.isActive === true && custA.customer.taxpayerType === 'juristic', 'สร้างลูกค้าสำเร็จ ค่าตรงตามที่ส่ง isActive=true/taxpayerType=juristic โดย default');
    const auditCreate = await pool.query(`SELECT action, reason FROM client_document_audit_log WHERE company_id=$1 AND doc_type='customer' AND doc_id=$2`, [COMPANY_A_ID, custA.customer.id]);
    assert(auditCreate.rowCount === 1 && auditCreate.rows[0].action === 'create' && auditCreate.rows[0].reason.includes('ทดสอบ E2E'), `audit log บันทึกการสร้างลูกค้าจริง (action=${auditCreate.rows[0] && auditCreate.rows[0].action})`);

    // ============================================================================================
    // (3) ไม่บังคับ tax_id แม้ taxpayerType='juristic' (ตัดสินใจเองตอนออกแบบ migration 0025)
    // ============================================================================================
    console.log('\n=== (3) ไม่บังคับ tax_id แม้เป็นนิติบุคคล (ต่างจาก subcontractor/external_payee) ===');
    const custNoTax = await call('fx_super', 'POST', '/api/customer/clients', { name: 'ลูกค้า E2E ไม่มีเลขภาษี', taxpayerType: 'juristic' });
    cleanup.customerIds.push(custNoTax.customer.id);
    assert(custNoTax.customer.taxId === null, 'สร้างลูกค้านิติบุคคลโดยไม่ระบุ tax_id สำเร็จ (ไม่ถูกบังคับเหมือน subcontractor/external_payee)');

    // ============================================================================================
    // (4) partial unique index บน tax_id — ซ้ำในบริษัทเดียวกันต้องพัง, ซ้ำข้ามบริษัทต้องผ่าน,
    // ไม่มี tax_id (NULL) สร้างซ้ำได้เรื่อยๆ ไม่ติด unique เลย
    // ============================================================================================
    console.log('\n=== (4) unique (company_id, tax_id) แบบ partial ===');
    const dupTaxId = await callExpectError('fx_super', 'POST', '/api/customer/clients', { name: 'ลูกค้าอื่น เลขภาษีซ้ำ', taxId: '1234567890123' });
    assert(dupTaxId.status === 409, `สร้างลูกค้า tax_id ซ้ำในบริษัทเดียวกันได้ 409 (ได้ ${dupTaxId.status})`);
    const custB = await call('fx_other_co', 'POST', '/api/customer/clients', { name: 'ลูกค้าบริษัท B เลขภาษีเดียวกัน', taxId: '1234567890123' });
    cleanup.customerIds.push(custB.customer.id);
    assert(custB.customer.taxId === '1234567890123', 'tax_id เดียวกันที่คนละบริษัทสร้างสำเร็จ (unique เป็นระดับบริษัท ไม่ใช่ global)');
    const anotherNoTax = await call('fx_super', 'POST', '/api/customer/clients', { name: 'ลูกค้า E2E ไม่มีเลขภาษี รายที่ 2' });
    cleanup.customerIds.push(anotherNoTax.customer.id);
    assert(anotherNoTax.customer.taxId === null, 'สร้างลูกค้าไม่มี tax_id ได้อีกรายโดยไม่ชน unique (partial index ไม่ครอบ NULL)');

    // ============================================================================================
    // (5) normalize_payee_name()-based unique — ชื่อที่ต่างกันแค่ช่องว่าง/ตัวพิมพ์/คำนำหน้า-ต่อท้าย
    // นิติบุคคล ต้องถือว่าเป็นชื่อเดียวกัน (reuse ฟังก์ชันเดิมจาก client_subcontractors/
    // client_external_payees ไม่ใช่ raw string เทียบตรงๆ)
    // ============================================================================================
    console.log('\n=== (5) unique ชื่อหลัง normalize (กันช่องว่าง/ตัวพิมพ์/คำนำหน้า-ต่อท้ายนิติบุคคล) ===');
    const dupNormalizedName = await callExpectError('fx_super', 'POST', '/api/customer/clients', { name: '  ทดสอบ   e2e  ' });
    assert(dupNormalizedName.status === 409, `ชื่อ "  ทดสอบ   e2e  " ชนกับ "บริษัท ทดสอบ E2E จำกัด" หลัง normalize ได้ 409 (ได้ ${dupNormalizedName.status})`);
    const distinctName = await call('fx_other_co', 'POST', '/api/customer/clients', { name: 'บริษัท ทดสอบ E2E จำกัด' });
    cleanup.customerIds.push(distinctName.customer.id);
    assert(distinctName.customer.name === 'บริษัท ทดสอบ E2E จำกัด', 'ชื่อ normalize แล้วตรงกันแต่คนละบริษัท สร้างสำเร็จ (unique เป็นระดับบริษัท)');

    // ============================================================================================
    // (6) cross-tenant 404 — บริษัท B แก้ของบริษัท A ต้องได้ 404 ไม่ใช่ 403 และไม่รั่วว่ามีอยู่จริง
    // ============================================================================================
    console.log('\n=== (6) cross-tenant 404 (ไม่ใช่ 403) ===');
    const crossPut = await callExpectError('fx_other_co', 'PUT', `/api/customer/clients/${custA.customer.id}`, { name: 'hack attempt' });
    assert(crossPut.status === 404, `บริษัท B แก้ลูกค้าของบริษัท A ผ่าน id ตรงๆ ได้ 404 ไม่ใช่ 403 (ได้ ${crossPut.status})`);
    const custAfterCrossAttempt = await pool.query('SELECT name, tax_id FROM client_customers WHERE id=$1', [custA.customer.id]);
    assert(custAfterCrossAttempt.rows[0].name === 'บริษัท ทดสอบ E2E จำกัด' && custAfterCrossAttempt.rows[0].tax_id === '1234567890123', 'ข้อมูลลูกค้าบริษัท A ไม่ถูกแก้ไขเลยจริงๆ หลัง cross-tenant PUT attempt (ยืนยันจาก DB ตรงๆ ไม่ใช่แค่ดู response code)');

    // ============================================================================================
    // (7) แก้ไขจริง (PUT ในบริษัทตัวเอง) — field-diff audit log ถูกต้อง
    // ============================================================================================
    console.log('\n=== (7) PUT แก้ไขจริง + field-diff audit log ===');
    const edited = await call('fx_super', 'PUT', `/api/customer/clients/${custA.customer.id}`, {
      name: 'บริษัท ทดสอบ E2E จำกัด (แก้ชื่อ)', taxId: '1234567890123', phone: '02-222-2222', contactPerson: 'คุณเอ', isActive: true,
    });
    assert(edited.customer.name === 'บริษัท ทดสอบ E2E จำกัด (แก้ชื่อ)' && edited.customer.phone === '02-222-2222', 'แก้ไขชื่อ/เบอร์โทรลูกค้าสำเร็จจริง');
    const auditEdit = await pool.query(`SELECT action, reason FROM client_document_audit_log WHERE company_id=$1 AND doc_type='customer' AND doc_id=$2 AND action='edit'`, [COMPANY_A_ID, custA.customer.id]);
    assert(auditEdit.rowCount === 1 && auditEdit.rows[0].reason.includes('ชื่อ:') && auditEdit.rows[0].reason.includes('โทรศัพท์:'), `audit log บันทึก field-diff จริง ไม่ใช่แค่ "แก้ไขข้อมูล" เฉยๆ (ได้ reason: ${auditEdit.rows[0] && auditEdit.rows[0].reason})`);

    // ปิดใช้งานลูกค้า -> audit log ต้องมี fromStatus/toStatus ด้วย
    const deactivated = await call('fx_super', 'PUT', `/api/customer/clients/${custA.customer.id}`, {
      name: 'บริษัท ทดสอบ E2E จำกัด (แก้ชื่อ)', taxId: '1234567890123', phone: '02-222-2222', contactPerson: 'คุณเอ', isActive: false,
    });
    assert(deactivated.customer.isActive === false, 'ปิดใช้งานลูกค้าสำเร็จ');
    const auditDeactivate = await pool.query(`SELECT from_status, to_status FROM client_document_audit_log WHERE company_id=$1 AND doc_type='customer' AND doc_id=$2 ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID, custA.customer.id]);
    assert(auditDeactivate.rows[0].from_status === 'true' && auditDeactivate.rows[0].to_status === 'false', `audit log บันทึก from_status/to_status ตอนเปลี่ยนสถานะจริง (ได้ ${auditDeactivate.rows[0].from_status} -> ${auditDeactivate.rows[0].to_status})`);

    // ============================================================================================
    // (8) ยืนยันพฤติกรรมที่ทราบแล้ว (ไม่ใช่บั๊ก): PUT ไม่ส่ง isActive มา -> default เป็น true เสมอ
    // ============================================================================================
    console.log('\n=== (8) PUT ไม่ส่ง isActive -> default true (พฤติกรรมที่ทราบแล้ว) ===');
    const reactivated = await call('fx_super', 'PUT', `/api/customer/clients/${custA.customer.id}`, {
      name: 'บริษัท ทดสอบ E2E จำกัด (แก้ชื่อ)', taxId: '1234567890123', phone: '02-222-2222', contactPerson: 'คุณเอ',
    });
    assert(reactivated.customer.isActive === true, `ไม่ส่ง isActive มาใน PUT -> default true เสมอ (เปิดใช้งานลูกค้าที่เพิ่งปิดไปกลับมา) ได้ ${reactivated.customer.isActive} — พฤติกรรมเดียวกับ client_subcontractors/client_branches/client_departments ที่ยอมรับแล้ว ไม่ใช่บั๊ก`);

    // ============================================================================================
    // (9) GET scope ด้วย company_id — บริษัท B ไม่เห็นลูกค้าของบริษัท A ปนอยู่ในรายการ
    // ============================================================================================
    console.log('\n=== (9) GET scope ด้วย company_id ===');
    const listB = await call('fx_other_co', 'GET', '/api/customer/clients');
    assert(!listB.customers.some(c => c.id === custA.customer.id), 'บริษัท B ไม่เห็นลูกค้าของบริษัท A ปนในรายการ GET');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      const { customerIds } = cleanup;
      if (customerIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='customer' AND doc_id = ANY($1)`, [customerIds]);
        await pool.query('DELETE FROM client_customers WHERE id = ANY($1)', [customerIds]);
      }
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
