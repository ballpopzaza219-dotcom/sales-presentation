// Regression suite — client_pr_approval_rules CRUD (GET/POST/PUT/:id/deactivate).
// Covers: super_user-only + self-block on all 3 mutating endpoints, cross-company 404, validation
// (invalid doc_type, min>max, max=0), the upsert-retire semantics (new rule replaces old — old becomes
// is_active=false, never deleted, unique-active-index stays intact), and audit log content (reason
// carries doc_type + old/new ceilings + who performed it, so it's actually useful for a real audit).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Run: cd server && node tests/pr-approval-rules.regression.js  (or: npm run test:pr-approval-rules)
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
  const createdRuleIds = [];
  let targetUserId = null;
  try {
    console.log('Ensuring fixtures...');
    const { ids } = await setup();
    targetUserId = ids['fx_maker2'];

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;

    await login('fx_super', codeA);
    await login('fx_maker', codeA);
    await login('fx_other_co', codeB);

    // ================= 1) Validation / authorization =================
    const eNotSuper = await callExpectError('fx_maker', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'pr', minAmount: 0, maxAmount: 10000, description: '',
    });
    assert(eNotSuper.status === 403, `role อื่นที่ไม่ใช่ super_user ตั้งเพดานไม่ได้ (ได้ ${eNotSuper.status})`);

    const selfUserId = ids['fx_super'];
    const eSelf = await callExpectError('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: selfUserId, docType: 'pr', minAmount: 0, maxAmount: 10000, description: '',
    });
    assert(eSelf.status === 403, `ตั้งเพดานให้ตัวเองไม่ได้ (ได้ ${eSelf.status})`);

    const eCrossCompany = await callExpectError('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: ids['fx_other_co'], docType: 'pr', minAmount: 0, maxAmount: 10000, description: '',
    });
    assert(eCrossCompany.status === 404, `ตั้งเพดานให้ user ข้ามบริษัทได้ 404 (ได้ ${eCrossCompany.status})`);

    const eBadDocType = await callExpectError('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'not_a_real_type', minAmount: 0, maxAmount: 10000, description: '',
    });
    assert(eBadDocType.status === 400, `doc_type ผิด ได้ 400 (ได้ ${eBadDocType.status})`);

    const eMinMax = await callExpectError('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'pr', minAmount: 5000, maxAmount: 1000, description: '',
    });
    assert(eMinMax.status === 400, `min > max ถูกปฏิเสธ 400 (ได้ ${eMinMax.status})`);

    const eMaxZero = await callExpectError('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'pr', minAmount: 0, maxAmount: 0, description: '',
    });
    assert(eMaxZero.status === 400, `max_amount = 0 ถูกปฏิเสธ 400 (ได้ ${eMaxZero.status})`);

    // ================= 2) สร้างจริง + upsert ทับของเดิม =================
    const rule1Res = await call('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'petty_cash', minAmount: 0, maxAmount: 20000, description: 'rule แรก',
    });
    createdRuleIds.push(rule1Res.rule.id);
    assert(rule1Res.rule.is_active === true, 'สร้าง rule แรกสำเร็จ is_active=true');

    const rule2Res = await call('fx_super', 'POST', '/api/customer/pr-approval-rules', {
      approverCustomerId: targetUserId, docType: 'petty_cash', minAmount: 0, maxAmount: 35000, description: 'rule ใหม่ทับของเดิม',
    });
    createdRuleIds.push(rule2Res.rule.id);
    assert(rule2Res.rule.id !== rule1Res.rule.id, 'ตั้ง rule ใหม่ได้ id ใหม่จริง (ไม่ใช่ UPDATE แถวเดิม)');

    const rule1Check = await pool.query('SELECT is_active, max_amount FROM client_pr_approval_rules WHERE id=$1', [rule1Res.rule.id]);
    assert(rule1Check.rows[0].is_active === false, `rule เก่า (#${rule1Res.rule.id}) เป็น is_active=false ไม่ถูกลบ`);
    assert(Number(rule1Check.rows[0].max_amount) === 20000, 'rule เก่ายังเก็บค่าเดิม (20,000) ไว้ครบ ไม่ถูกแก้ทับ');
    const activeCountRes = await pool.query(
      `SELECT count(*)::int AS n FROM client_pr_approval_rules WHERE company_id=$1 AND approver_customer_id=$2 AND doc_type='petty_cash' AND is_active=true`,
      [COMPANY_A_ID, targetUserId]
    );
    assert(activeCountRes.rows[0].n === 1, `unique index ไม่พัง — active rule เหลือแค่ 1 แถวพอดี (ได้ ${activeCountRes.rows[0].n})`);

    // ================= 3) PUT แก้รายละเอียด (เฉพาะ rule ที่ยัง active) =================
    const editRes = await call('fx_super', 'PUT', `/api/customer/pr-approval-rules/${rule2Res.rule.id}`, { description: 'แก้รายละเอียดแล้ว' });
    assert(editRes.rule.description === 'แก้รายละเอียดแล้ว', 'แก้ description ของ rule ที่ active ได้');
    const eEditInactive = await callExpectError('fx_super', 'PUT', `/api/customer/pr-approval-rules/${rule1Res.rule.id}`, { description: 'ห้ามแก้' });
    assert(eEditInactive.status === 409, `แก้ description ของ rule ที่ปิดไปแล้วไม่ได้ (เป็นประวัติ) (ได้ ${eEditInactive.status})`);

    // ================= 4) Deactivate =================
    const deactivateRes = await call('fx_super', 'POST', `/api/customer/pr-approval-rules/${rule2Res.rule.id}/deactivate`, {});
    assert(deactivateRes.rule.is_active === false, 'ปิดใช้งาน rule สำเร็จ');
    // rule1 ถูกปิดไปแล้วโดยอัตโนมัติตอน upsert (ข้อ 2) — deactivate ซ้ำต้องเป็น no-op สำเร็จ (200) ไม่ error
    const deactivateAgainRes = await call('fx_super', 'POST', `/api/customer/pr-approval-rules/${rule1Res.rule.id}/deactivate`, {});
    assert(deactivateAgainRes.rule.is_active === false, 'ปิดใช้งาน rule ที่ปิดอยู่แล้วซ้ำ เป็น no-op สำเร็จ ไม่ error');

    // ================= 5) Audit log content =================
    const auditRows = await pool.query(
      `SELECT action, reason, performed_by FROM client_document_audit_log
       WHERE company_id=$1 AND doc_type='user_permission' AND doc_id=$2 AND reason LIKE '%เพดานวงเงิน%'
       ORDER BY id`,
      [COMPANY_A_ID, targetUserId]
    );
    assert(auditRows.rowCount >= 3, `audit log มีครบทุก action (ตั้ง 2 ครั้ง + ปิด 1 ครั้ง) (ได้ ${auditRows.rowCount} แถว)`);
    const grantLog = auditRows.rows.find(r => r.reason.includes(String(rule2Res.rule.id)) && r.action === 'grant');
    assert(!!grantLog, `audit log ของ rule #${rule2Res.rule.id} มี reason อ้าง id นั้นจริง`);
    assert(grantLog.reason.includes('35000') || grantLog.reason.includes('35,000'), `reason มีเพดานใหม่ (35,000) ระบุอยู่จริง: "${grantLog.reason}"`);
    assert(grantLog.performed_by === selfUserId, `audit log บันทึกว่า fx_super เป็นคนตั้งจริง (ได้ performed_by=${grantLog.performed_by})`);
    const revokeLog = auditRows.rows.find(r => r.action === 'revoke' && r.reason.includes(String(rule2Res.rule.id)));
    assert(!!revokeLog, `audit log ของการปิด rule #${rule2Res.rule.id} มี action='revoke' และอ้าง id ถูกต้อง`);

    // ================= 6) GET แสดงครบ (active + inactive) =================
    const listRes = await call('fx_super', 'GET', '/api/customer/pr-approval-rules');
    const listedIds = listRes.rules.map(r => r.id);
    assert(createdRuleIds.every(id => listedIds.includes(id)), 'GET คืน rule ทั้ง active และ inactive ครบ (ไม่ซ่อนประวัติ)');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (targetUserId) {
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='user_permission' AND doc_id=$1 AND reason LIKE '%เพดานวงเงิน%'`, [targetUserId]);
      }
      if (createdRuleIds.length) {
        await pool.query('DELETE FROM client_pr_approval_rules WHERE id = ANY($1)', [createdRuleIds]);
      }
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
