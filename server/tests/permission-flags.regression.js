// Regression test for the user-permission-flag endpoints added 2026-08-06 (migration
// 0007_manage_permission_flags + updateUserPermissionFlag() in server.js).
//
// Covers the shared function used by 3 endpoints:
//   - PUT /api/customer/users/:id/permission-flags        (new — can_manage_po / can_manage_petty_cash_fund / can_settle_cash)
//   - PUT /api/customer/users/:id/approval-permission      (existing — tightened to super_user-only)
//   - PUT /api/customer/users/:id/budget-approval-permission (existing — tightened to super_user-only)
//
// Root issue being guarded against: the OLD approval-permission/budget-approval-permission endpoints
// let anyone who already HAD the flag (can_approve_applications / can_approve_budget === true) grant
// it to other users too — a self-perpetuating permission chain with no central control. The fix
// restricts grant/revoke to super_user only, blocks self-grant, whitelists which columns are settable
// (mass-assignment guard), enforces company scope (404 not 403 cross-company), rejects suspended
// targets, and always writes an audit log row on real changes.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and server/.env
// must point at a reachable Postgres instance.
// Run: cd server && node tests/permission-flags.regression.js

const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const COMPANY_A_ID = 13; // RIXCFR — same fixture company used by other regression tests
const COMPANY_B_ID = 19; // DIUXPB — a *different* company, for the cross-company 404 check

let cookie = '';
async function call(method, urlPath, body) {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function callExpectError(method, urlPath, body) {
  try {
    await call(method, urlPath, body);
    throw new Error(`expected ${method} ${urlPath} to fail but it succeeded`);
  } catch (e) {
    if (e.status === undefined) throw e; // rethrow assertion failures / network errors as-is
    return e;
  }
}
let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

async function login(companyCode, username) {
  cookie = '';
  await call('POST', '/api/customer-login', { companyCode, username, password: 'TestPass123!' });
}

(async () => {
  const createdCustomerIds = [];
  try {
    const [companyARes, companyBRes] = await Promise.all([
      pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]),
      pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]),
    ]);
    const companyA = companyARes.rows[0];
    const companyB = companyBRes.rows[0];
    if (!companyA) throw new Error(`Fixture company id=${COMPANY_A_ID} not found — adjust COMPANY_A_ID for this database.`);
    if (!companyB) throw new Error(`Fixture company id=${COMPANY_B_ID} not found — adjust COMPANY_B_ID for this database.`);

    const hash = await bcrypt.hash('TestPass123!', 10);
    async function makeUser({ companyId, username, role, status, flags }) {
      const cols = ['company_id', 'name', 'email', 'username', 'password_hash', 'status', 'role', ...Object.keys(flags || {})];
      const vals = [companyId, `Permission Test ${username}`, `${username}@example.com`, username, hash, status || 'active', role, ...Object.values(flags || {})];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      const r = await pool.query(`INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, vals);
      createdCustomerIds.push(r.rows[0].id);
      return r.rows[0].id;
    }

    const superUserAId = await makeUser({ companyId: companyA.id, username: '_perm_super_a_', role: 'super_user' });
    const targetAId = await makeUser({ companyId: companyA.id, username: '_perm_target_a_', role: 'maker' });
    // ผู้ใช้ที่ "มี" can_manage_po อยู่แล้วเอง แต่ไม่ใช่ super_user — ต้องมอบสิทธิ์ให้คนอื่นไม่ได้ (นี่คือช่อง
    // โหว่จริงที่แก้ไป: ของเดิมเช็คแค่ "มี flag เอง" ก็มอบให้คนอื่นได้แล้ว)
    const holderNonSuperAId = await makeUser({ companyId: companyA.id, username: '_perm_holder_a_', role: 'maker', flags: { can_manage_po: true, can_approve_applications: true, can_approve_budget: true } });
    const suspendedTargetAId = await makeUser({ companyId: companyA.id, username: '_perm_suspended_a_', role: 'maker', status: 'suspended' });
    const targetBId = await makeUser({ companyId: companyB.id, username: '_perm_target_b_', role: 'maker' });

    // ---------------- super_user ทำได้ + มี flag ทำได้ ----------------
    await login(companyA.code, '_perm_super_a_');
    const grantRes = await call('PUT', `/api/customer/users/${targetAId}/permission-flags`, { column: 'can_manage_po', value: true });
    assert(grantRes.user.can_manage_po === true, 'super_user มอบสิทธิ์ can_manage_po ให้ผู้ใช้อื่นในบริษัทเดียวกันสำเร็จ (มี flag ทำได้)');

    // ---------------- audit log บันทึกถูก ----------------
    const auditRes = await pool.query(
      `SELECT * FROM client_document_audit_log WHERE company_id=$1 AND doc_type='user_permission' AND doc_id=$2 ORDER BY id DESC LIMIT 1`,
      [companyA.id, targetAId]
    );
    assert(auditRes.rowCount === 1, 'audit log มีแถวใหม่หลังมอบสิทธิ์');
    assert(auditRes.rows[0].action === 'grant', `audit log action = 'grant' (ได้ '${auditRes.rows[0].action}')`);
    assert(auditRes.rows[0].performed_by === superUserAId, 'audit log performed_by ตรงกับ super_user ที่ทำรายการ');
    assert(auditRes.rows[0].to_status === 'true', `audit log to_status บันทึกค่าใหม่ถูกต้อง (ได้ '${auditRes.rows[0].to_status}')`);

    // revoke กลับ เพื่อทดสอบ round-trip + เตรียม state ให้ test อื่นไม่ปนกัน
    const revokeRes = await call('PUT', `/api/customer/users/${targetAId}/permission-flags`, { column: 'can_manage_po', value: false });
    assert(revokeRes.user.can_manage_po === false, 'super_user ถอนสิทธิ์ can_manage_po คืนได้ (revoke round-trip)');

    // ---------------- self-grant block ----------------
    const selfGrantErr = await callExpectError('PUT', `/api/customer/users/${superUserAId}/permission-flags`, { column: 'can_manage_po', value: true });
    assert(selfGrantErr.status === 403, `self-grant ถูกบล็อกด้วย 403 (ได้ ${selfGrantErr.status})`);

    // ---------------- cross-company 404 ----------------
    const crossCompanyErr = await callExpectError('PUT', `/api/customer/users/${targetBId}/permission-flags`, { column: 'can_manage_po', value: true });
    assert(crossCompanyErr.status === 404, `แก้สิทธิ์ผู้ใช้ข้ามบริษัทได้ 404 ไม่ใช่ 403 (ได้ ${crossCompanyErr.status})`);

    // ---------------- mass-assignment ไม่ผ่าน ----------------
    const massAssignErr = await callExpectError('PUT', `/api/customer/users/${targetAId}/permission-flags`, { column: 'role', value: 'super_user' });
    assert(massAssignErr.status === 400, `column นอก whitelist (role) ถูกปฏิเสธด้วย 400 (ได้ ${massAssignErr.status})`);
    const roleCheck = await pool.query('SELECT role FROM customers WHERE id=$1', [targetAId]);
    assert(roleCheck.rows[0].role === 'maker', 'mass-assignment ไม่ได้แก้ role จริงในฐานข้อมูล (ยังเป็น maker เหมือนเดิม)');

    // ---------------- ปฏิเสธ target ที่ไม่ active ----------------
    const suspendedErr = await callExpectError('PUT', `/api/customer/users/${suspendedTargetAId}/permission-flags`, { column: 'can_manage_po', value: true });
    assert(suspendedErr.status === 409, `แก้สิทธิ์ user ที่ status='suspended' ถูกปฏิเสธ (ได้ ${suspendedErr.status})`);

    // ---------------- ไม่มีสิทธิ์ (ไม่ใช่ super_user) → 403 ----------------
    await login(companyA.code, '_perm_holder_a_');
    const notSuperErr = await callExpectError('PUT', `/api/customer/users/${targetAId}/permission-flags`, { column: 'can_manage_po', value: true });
    assert(notSuperErr.status === 403, `ผู้ใช้ role='maker' (ไม่ใช่ super_user) มอบสิทธิ์ไม่ได้ แม้จะมี can_manage_po ของตัวเองอยู่แล้วก็ตาม (ได้ ${notSuperErr.status})`);

    // ---------------- 2 endpoint เดิม: ต้องเข้มเท่ากันแล้ว (เดิมช่องโหว่คือจุดนี้) ----------------
    // holderNonSuperAId มี can_approve_applications=true และ can_approve_budget=true อยู่แล้ว — ของเดิม
    // (canManageApprovalPermissions/canManageBudgetPermissions) จะอนุญาตให้มอบสิทธิ์ต่อได้เลยเพราะ "มี
    // flag เอง" ก็พอ ตอนนี้ต้อง super_user เท่านั้น จุดนี้คือ regression check ตัวจริงของช่องโหว่ที่แก้ไป
    const oldApprovalErr = await callExpectError('PUT', `/api/customer/users/${targetAId}/approval-permission`, { canApprove: true });
    assert(oldApprovalErr.status === 403, `approval-permission: ผู้ใช้ที่มี can_approve_applications=true เองแต่ไม่ใช่ super_user มอบสิทธิ์ต่อไม่ได้แล้ว (ได้ ${oldApprovalErr.status})`);
    const oldBudgetErr = await callExpectError('PUT', `/api/customer/users/${targetAId}/budget-approval-permission`, { canApprove: true });
    assert(oldBudgetErr.status === 403, `budget-approval-permission: ผู้ใช้ที่มี can_approve_budget=true เองแต่ไม่ใช่ super_user มอบสิทธิ์ต่อไม่ได้แล้ว (ได้ ${oldBudgetErr.status})`);

    // super_user ยังใช้ 2 endpoint เดิมได้ปกติผ่านฟังก์ชันร่วมตัวเดียวกัน
    await login(companyA.code, '_perm_super_a_');
    const approvalOkRes = await call('PUT', `/api/customer/users/${targetAId}/approval-permission`, { canApprove: true });
    assert(approvalOkRes.user.can_approve_applications === true, 'approval-permission: super_user ยังมอบสิทธิ์ผ่าน endpoint เดิมได้ปกติ');
    const budgetOkRes = await call('PUT', `/api/customer/users/${targetAId}/budget-approval-permission`, { canApprove: true });
    assert(budgetOkRes.user.can_approve_budget === true, 'budget-approval-permission: super_user ยังมอบสิทธิ์ผ่าน endpoint เดิมได้ปกติ');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body || '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdCustomerIds.length) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='user_permission' AND doc_id = ANY($1)`, [createdCustomerIds]);
        await pool.query('DELETE FROM customers WHERE id = ANY($1)', [createdCustomerIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
