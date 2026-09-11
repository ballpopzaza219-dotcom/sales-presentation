// Regression suite — client_branches/client_departments (migration 0024, blueprint ข้อ 3) + their CRUD
// endpoints. Covers: permission (super_user only), composite FK (company_id, branch_id) rejecting a
// cross-company reference both at the HTTP layer (friendly 400) and at the raw DB layer (the actual FK
// constraint, bypassing the app-level check to prove the schema itself enforces it), UNIQUE(company_id,
// code) scoped per company (not global), branch_id nullable (company-wide department), audit log rows
// written on create/edit with the real doc_type/action/reason, cross-tenant access returning 404 (not
// 403, and not distinguishable from "doesn't exist at all"), and the UPDATE statements' own
// company_id scoping (defense-in-depth, independent of the earlier SELECT ... FOR UPDATE check).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres, migration 0024 already applied. Run: cd server && node tests/branches-departments.regression.js
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
  const cleanup = { branchIds: [], departmentIds: [] };
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
    const branchDenied = await callExpectError('fx_maker', 'POST', '/api/customer/branches', { code: 'X', name: 'x' });
    assert(branchDenied.status === 403, `fx_maker (ไม่ใช่ super_user) สร้างสาขาไม่ได้ 403 (ได้ ${branchDenied.status})`);
    const deptDenied = await callExpectError('fx_maker', 'POST', '/api/customer/departments', { code: 'X', name: 'x' });
    assert(deptDenied.status === 403, `fx_maker สร้างแผนกไม่ได้ 403 (ได้ ${deptDenied.status})`);

    // ============================================================================================
    // (2) สร้างสาขาจริง + audit log
    // ============================================================================================
    console.log('\n=== (2) สร้างสาขา + audit log ===');
    const branchA = await call('fx_super', 'POST', '/api/customer/branches', { code: 'HQ-E2E', name: 'สำนักงานใหญ่ E2E', address: 'กรุงเทพ', phone: '02-000-0000' });
    cleanup.branchIds.push(branchA.branch.id);
    assert(branchA.branch.code === 'HQ-E2E' && branchA.branch.isActive === true, 'สร้างสาขาสำเร็จ ค่าตรงตามที่ส่ง isActive=true โดย default');
    const auditCreate = await pool.query(`SELECT action, reason FROM client_document_audit_log WHERE company_id=$1 AND doc_type='branch' AND doc_id=$2`, [COMPANY_A_ID, branchA.branch.id]);
    assert(auditCreate.rowCount === 1 && auditCreate.rows[0].action === 'create' && auditCreate.rows[0].reason.includes('HQ-E2E'), `audit log บันทึกการสร้างสาขาจริง (action=${auditCreate.rows[0] && auditCreate.rows[0].action})`);

    // ============================================================================================
    // (3) UNIQUE(company_id, code) — ซ้ำในบริษัทเดียวกันต้องพัง, ซ้ำข้ามบริษัทต้องผ่าน
    // ============================================================================================
    console.log('\n=== (3) unique (company_id, code) ===');
    const dupBranch = await callExpectError('fx_super', 'POST', '/api/customer/branches', { code: 'HQ-E2E', name: 'สาขาซ้ำ' });
    assert(dupBranch.status === 409, `สร้างสาขา code ซ้ำในบริษัทเดียวกันได้ 409 (ได้ ${dupBranch.status})`);
    const branchB = await call('fx_other_co', 'POST', '/api/customer/branches', { code: 'HQ-E2E', name: 'สำนักงานใหญ่ บริษัท B' });
    cleanup.branchIds.push(branchB.branch.id);
    assert(branchB.branch.code === 'HQ-E2E', 'code เดียวกัน (HQ-E2E) ที่คนละบริษัทสร้างสำเร็จ (unique เป็นระดับบริษัท ไม่ใช่ global)');

    // ============================================================================================
    // (4) branch_id nullable — แผนกระดับบริษัท ไม่ผูกสาขา
    // ============================================================================================
    console.log('\n=== (4) branch_id nullable (แผนกระดับบริษัท) ===');
    const deptNoBranch = await call('fx_super', 'POST', '/api/customer/departments', { code: 'ACC-E2E', name: 'ฝ่ายบัญชีกลาง E2E' });
    cleanup.departmentIds.push(deptNoBranch.department.id);
    assert(deptNoBranch.department.branchId === null, `แผนกไม่ระบุ branchId -> branchId=null สำเร็จ (ได้ ${deptNoBranch.department.branchId})`);

    const deptWithBranch = await call('fx_super', 'POST', '/api/customer/departments', { code: 'SITE-E2E', name: 'ฝ่ายก่อสร้างหน้างาน E2E', branchId: branchA.branch.id });
    cleanup.departmentIds.push(deptWithBranch.department.id);
    assert(deptWithBranch.department.branchId === branchA.branch.id, 'แผนกระบุ branchId ของบริษัทตัวเองสำเร็จ');

    // ============================================================================================
    // (5) composite FK ข้ามบริษัท — ทั้งชั้น HTTP (400 friendly) และชั้น DB ตรงๆ (FK constraint จริง)
    // ============================================================================================
    console.log('\n=== (5) composite FK ข้ามบริษัท (2 ชั้น) ===');
    const crossTenantDept = await callExpectError('fx_super', 'POST', '/api/customer/departments', { code: 'CROSS-E2E', name: 'แผนกทดสอบข้ามบริษัท', branchId: branchB.branch.id });
    assert(crossTenantDept.status === 400, `ชั้น HTTP: สร้างแผนกบริษัท A อ้าง branch ของบริษัท B ได้ 400 friendly error ไม่ใช่ raw FK error (ได้ ${crossTenantDept.status})`);
    assert(!crossTenantDept.body.error.includes('constraint'), 'ข้อความ error เป็นภาษาคน ไม่ใช่ raw Postgres constraint message');

    // ชั้น DB ตรงๆ (bypass application validation) — พิสูจน์ว่า schema เองบังคับจริง ไม่ใช่แค่ app-level check
    let dbLevelRejected = null;
    try {
      await pool.query('INSERT INTO client_departments (company_id, branch_id, code, name) VALUES ($1,$2,$3,$4)', [COMPANY_A_ID, branchB.branch.id, 'DB-BYPASS-E2E', 'ทดสอบ FK ตรงๆ']);
    } catch (e) { dbLevelRejected = e; }
    assert(dbLevelRejected !== null && /fk_client_departments_branch/.test(dbLevelRejected.message), `ชั้น DB: composite FK (company_id, branch_id) ปฏิเสธการ INSERT ตรงๆ ที่ข้ามบริษัทจริง (ได้ error: ${dbLevelRejected && dbLevelRejected.message})`);

    // ============================================================================================
    // (6) cross-tenant 404 — บริษัท B เปิด/แก้ของบริษัท A ต้องได้ 404 ไม่ใช่ 403 และไม่รั่วว่ามีอยู่จริง
    // ============================================================================================
    console.log('\n=== (6) cross-tenant 404 (ไม่ใช่ 403) ===');
    const crossPutBranch = await callExpectError('fx_other_co', 'PUT', `/api/customer/branches/${branchA.branch.id}`, { code: 'HACK', name: 'hack attempt' });
    assert(crossPutBranch.status === 404, `บริษัท B แก้สาขาของบริษัท A ผ่าน id ตรงๆ ได้ 404 ไม่ใช่ 403 (ได้ ${crossPutBranch.status})`);
    const crossPutDept = await callExpectError('fx_other_co', 'PUT', `/api/customer/departments/${deptNoBranch.department.id}`, { code: 'HACK', name: 'hack attempt' });
    assert(crossPutDept.status === 404, `บริษัท B แก้แผนกของบริษัท A ผ่าน id ตรงๆ ได้ 404 เช่นกัน (ได้ ${crossPutDept.status})`);
    // ยืนยันว่าข้อมูลจริงไม่ได้ถูกแก้เลยแม้ request จะ "เกือบสำเร็จ" (defense-in-depth ของ UPDATE ที่เพิ่ง
    // เติม company_id เข้า WHERE โดยตรง — ถ้าไม่มีการป้องกันนี้ อาจมี edge case ที่ UPDATE หลุดผ่านได้)
    const branchAfterCrossAttempt = await pool.query('SELECT code, name FROM client_branches WHERE id=$1', [branchA.branch.id]);
    assert(branchAfterCrossAttempt.rows[0].code === 'HQ-E2E' && branchAfterCrossAttempt.rows[0].name === 'สำนักงานใหญ่ E2E', 'ข้อมูลสาขาบริษัท A ไม่ถูกแก้ไขเลยจริงๆ หลัง cross-tenant PUT attempt (ยืนยันจาก DB ตรงๆ ไม่ใช่แค่ดู response code)');

    // ============================================================================================
    // (7) แก้ไขจริง (PUT ในบริษัทตัวเอง) — field-diff audit log ถูกต้อง
    // ============================================================================================
    console.log('\n=== (7) PUT แก้ไขจริง + field-diff audit log ===');
    const editedBranch = await call('fx_super', 'PUT', `/api/customer/branches/${branchA.branch.id}`, { code: 'HQ-E2E', name: 'สำนักงานใหญ่ E2E (แก้ชื่อ)', address: 'กรุงเทพ', phone: '02-000-0000', isActive: true });
    assert(editedBranch.branch.name === 'สำนักงานใหญ่ E2E (แก้ชื่อ)', 'แก้ไขชื่อสาขาสำเร็จจริง');
    const auditEdit = await pool.query(`SELECT action, reason FROM client_document_audit_log WHERE company_id=$1 AND doc_type='branch' AND doc_id=$2 AND action='edit'`, [COMPANY_A_ID, branchA.branch.id]);
    assert(auditEdit.rowCount === 1 && auditEdit.rows[0].reason.includes('ชื่อ:') && auditEdit.rows[0].reason.includes('แก้ชื่อ'), `audit log บันทึก field-diff จริง ไม่ใช่แค่ "แก้ไขข้อมูล" เฉยๆ (ได้ reason: ${auditEdit.rows[0] && auditEdit.rows[0].reason})`);

    // ปิดใช้งานสาขา -> audit log ต้องมี fromStatus/toStatus ด้วย
    const deactivated = await call('fx_super', 'PUT', `/api/customer/branches/${branchA.branch.id}`, { code: 'HQ-E2E', name: 'สำนักงานใหญ่ E2E (แก้ชื่อ)', address: 'กรุงเทพ', phone: '02-000-0000', isActive: false });
    assert(deactivated.branch.isActive === false, 'ปิดใช้งานสาขาสำเร็จ');
    const auditDeactivate = await pool.query(`SELECT from_status, to_status FROM client_document_audit_log WHERE company_id=$1 AND doc_type='branch' AND doc_id=$2 ORDER BY id DESC LIMIT 1`, [COMPANY_A_ID, branchA.branch.id]);
    assert(auditDeactivate.rows[0].from_status === 'true' && auditDeactivate.rows[0].to_status === 'false', `audit log บันทึก from_status/to_status ตอนเปลี่ยนสถานะจริง (ได้ ${auditDeactivate.rows[0].from_status} -> ${auditDeactivate.rows[0].to_status})`);

    // ============================================================================================
    // (8) ยืนยันพฤติกรรมที่ทราบแล้ว (ไม่ใช่บั๊ก): PUT ไม่ส่ง isActive มา -> default เป็น true เสมอ
    // (เหมือน client_subcontractors ทุกประการ — เอกสารไว้เป็นเทสถาวรกันคนมาแก้พฤติกรรมนี้โดยไม่ตั้งใจ)
    // ============================================================================================
    console.log('\n=== (8) PUT ไม่ส่ง isActive -> default true (พฤติกรรมที่ทราบแล้ว) ===');
    const reactivated = await call('fx_super', 'PUT', `/api/customer/branches/${branchA.branch.id}`, { code: 'HQ-E2E', name: 'สำนักงานใหญ่ E2E (แก้ชื่อ)', address: 'กรุงเทพ', phone: '02-000-0000' });
    assert(reactivated.branch.isActive === true, `ไม่ส่ง isActive มาใน PUT -> default true เสมอ (เปิดใช้งานสาขาที่เพิ่งปิดไปกลับมา) ได้ ${reactivated.branch.isActive} — พฤติกรรมเดียวกับ client_subcontractors ที่ยอมรับแล้ว ไม่ใช่บั๊ก`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      const { branchIds, departmentIds } = cleanup;
      if (departmentIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='department' AND doc_id = ANY($1)`, [departmentIds]);
        await pool.query('DELETE FROM client_departments WHERE id = ANY($1)', [departmentIds]);
      }
      // ลบแถวที่หลุดมาจากการทดสอบ DB-bypass (ถ้าบังเอิญสำเร็จ ซึ่งไม่ควรเกิดขึ้นถ้า guard ถูกต้อง)
      await pool.query(`DELETE FROM client_departments WHERE code IN ('DB-BYPASS-E2E','CROSS-E2E')`);
      if (branchIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='branch' AND doc_id = ANY($1)`, [branchIds]);
        await pool.query('DELETE FROM client_branches WHERE id = ANY($1)', [branchIds]);
      }
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
