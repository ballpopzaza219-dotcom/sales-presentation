// Regression suite — Contract module (client_contracts, migration 0035/0036) Phase 1: list/get, create
// root draft, edit draft, cancel. No submit/approve/reject/terminate/complete yet (phase 2-4), and no R
// (amendment) endpoints yet (phase 2) — this file only exercises what phase 1 actually implements.
//
// Every rejection case asserts the EXACT status code and error message/code the route is documented to
// return, not just "is it non-2xx" — a wrong-reason rejection (e.g. a 403 that actually fired because of
// a bug elsewhere, not the permission check being tested) would otherwise look like a pass.
//
// Prerequisites: dev server running, migrations 0035/0036 applied. Run:
// cd server && node tests/contract-crud-phase1.regression.js

const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const PASSWORD = 'TestPass123!';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {};
let idemCounter = 0;
async function call(who, method, urlPath, body, idempotencyKey) {
  // create/cancel go through withIdempotency server-side, which requires this header — generate a
  // fresh one per call by default (each call in this file is a logically distinct action) unless the
  // caller explicitly passes one (e.g. to test retrying with the SAME key).
  const headers = { Cookie: cookies[who] || '', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey || `ctp1-${Date.now()}-${++idemCounter}` };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[who] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, json };
}

const MANAGE_DENIED_MSG = 'เฉพาะผู้ที่ได้รับสิทธิ์จัดการสัญญาเท่านั้นที่ทำรายการนี้ได้';

(async () => {
  let companyId = null, companyBId = null;
  const cleanupCompanyIds = [];
  try {
    const stamp = Date.now();
    const hash = await bcrypt.hash(PASSWORD, 10);

    // ---- Company A: 4 users (none / manage / approve / super) + 2 projects ----
    const compA = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase1 Test Co A', 'CTP1A' + stamp]);
    companyId = compA.rows[0].id;
    cleanupCompanyIds.push(companyId);
    const custA = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, 'ลูกค้าทดสอบ phase1 A']);
    const projA = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP1A','โครงการทดสอบ phase1 A',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const projectId = projA.rows[0].id;
    const realCustomerId = custA.rows[0].id;

    async function makeUser(username, role, flags) {
      const cols = ['company_id', 'name', 'email', 'username', 'password_hash', 'status', 'role', ...Object.keys(flags)];
      const vals = [companyId, username, `${username}@example.com`, username, hash, 'active', role, ...Object.values(flags)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      const r = await pool.query(`INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, vals);
      await call(username, 'POST', '/api/customer-login', { companyCode: 'CTP1A' + stamp, username, password: PASSWORD });
      return r.rows[0].id;
    }
    await makeUser('ctp1_none_' + stamp, 'maker', {});
    await makeUser('ctp1_manage_' + stamp, 'maker', { can_manage_contracts: true });
    await makeUser('ctp1_approve_' + stamp, 'maker', { can_approve_contracts: true });
    await makeUser('ctp1_super_' + stamp, 'super_user', {});
    const noneUser = 'ctp1_none_' + stamp, manageUser = 'ctp1_manage_' + stamp, approveUser = 'ctp1_approve_' + stamp, superUser = 'ctp1_super_' + stamp;

    // ---- Company B: 1 project, for cross-company isolation checks ----
    const compB = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase1 Test Co B', 'CTP1B' + stamp]);
    companyBId = compB.rows[0].id;
    cleanupCompanyIds.push(companyBId);
    const custB = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyBId, 'ลูกค้าทดสอบ phase1 B']);
    const projB = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP1B','โครงการทดสอบ phase1 B',$2) RETURNING id`, [companyBId, custB.rows[0].id]);
    const projectBId = projB.rows[0].id;
    const superBUsername = 'ctp1_superb_' + stamp;
    await pool.query(`INSERT INTO customers (company_id, name, email, username, password_hash, status, role) VALUES ($1,'Super B',$2,$3,$4,'active','super_user')`, [companyBId, `${superBUsername}@example.com`, superBUsername, hash]);
    await call(superBUsername, 'POST', '/api/customer-login', { companyCode: 'CTP1B' + stamp, username: superBUsername, password: PASSWORD });

    // ============================================================================================
    // (1) create root draft — permission gate
    // ============================================================================================
    console.log('\n=== (1) POST create — permission gate ===');
    const basePayload = { contractName: 'สัญญาทดสอบ phase1', contractValue: 1000000, depositPercent: 10, retentionPercent: 5, paymentTerms: 'เครดิต 30 วัน' };

    const rNone = await call(noneUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    assert(rNone.status === 403 && rNone.json.error === MANAGE_DENIED_MSG, `user with no flags -> 403 "${MANAGE_DENIED_MSG}" (got status=${rNone.status}, body=${JSON.stringify(rNone.json)})`);

    const rApprove = await call(approveUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    assert(rApprove.status === 403 && rApprove.json.error === MANAGE_DENIED_MSG, `user with only can_approve_contracts -> still 403 (approve != manage) (got status=${rApprove.status}, body=${JSON.stringify(rApprove.json)})`);

    // customerId in the body is a deliberate attack attempt — must be ignored, derived from the project instead.
    const bogusCustomerId = 999999;
    const rManage = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, { ...basePayload, customerId: bogusCustomerId });
    assert(rManage.status === 200 && rManage.json.contract && rManage.json.contract.id, `user with can_manage_contracts -> 200, contract created (got status=${rManage.status}, body=${JSON.stringify(rManage.json)})`);
    const c1Id = rManage.json.contract.id;
    assert(rManage.json.contract.customerId === realCustomerId, `customerId is derived from the project (${realCustomerId}), NOT the bogus value sent by the client (${bogusCustomerId}) (got ${rManage.json.contract.customerId})`);
    assert(rManage.json.contract.status === 'draft', `new contract starts as draft (got ${rManage.json.contract.status})`);
    assert(rManage.json.contract.parentContractId === null, `new contract is a root (parentContractId null) (got ${rManage.json.contract.parentContractId})`);
    assert(rManage.json.contract.contractNo === null, `contract_no not issued yet (draft) (got ${rManage.json.contract.contractNo})`);

    // ============================================================================================
    // (2) duplicate root per project -> 409
    // ============================================================================================
    console.log('\n=== (2) second root contract for the same project while the first is still draft -> 409 ===');
    const rDup = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    const DUP_MSG = 'โครงการนี้มีสัญญาหลักที่ยังมีผลอยู่แล้ว ต้องยกเลิก/เลิกสัญญาเดิมก่อนจึงสร้างใหม่ได้';
    assert(rDup.status === 409 && rDup.json.error === DUP_MSG, `second root for same project -> 409 "${DUP_MSG}" (got status=${rDup.status}, body=${JSON.stringify(rDup.json)})`);

    // ============================================================================================
    // (2b) replay the SAME Idempotency-Key after a 409 -> same 409 again, not a 500 (withIdempotency
    // does not cache non-2xx responses, so this re-runs the handler and must hit the same constraint
    // violation cleanly a second time, not leak an aborted-transaction error)
    // ============================================================================================
    console.log('\n=== (2b) replaying the same Idempotency-Key after a 409 -> same 409, not 500 ===');
    const dupKey = 'ctp1-dup-replay-' + stamp;
    const rDup2a = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload, dupKey);
    assert(rDup2a.status === 409 && rDup2a.json.error === DUP_MSG, `first call with the replay key -> 409 (got status=${rDup2a.status}, body=${JSON.stringify(rDup2a.json)})`);
    const rDup2b = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload, dupKey);
    assert(rDup2b.status === 409 && rDup2b.json.error === DUP_MSG, `SAME Idempotency-Key replayed -> same 409 again, not 500 (got status=${rDup2b.status}, body=${JSON.stringify(rDup2b.json)})`);

    // ============================================================================================
    // (2a) the SAME Idempotency-Key on a SUCCESSFUL create -> cached response (same contract id),
    // and only one row actually exists in the DB (no silent double-insert)
    // ============================================================================================
    console.log('\n=== (2a) idempotent retry of a successful create -> same contract id, single DB row ===');
    const projIdem = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP1AIDEM','โครงการทดสอบ idempotency',$2) RETURNING id`, [companyId, realCustomerId]);
    const projectIdemId = projIdem.rows[0].id;
    const idemKey = 'ctp1-idem-' + stamp;
    const rIdem1 = await call(manageUser, 'POST', `/api/customer/projects/${projectIdemId}/contracts`, basePayload, idemKey);
    assert(rIdem1.status === 200 && rIdem1.json.contract && rIdem1.json.contract.id, `first call creates the contract (got status=${rIdem1.status})`);
    const idemContractId = rIdem1.json.contract.id;
    const rIdem2 = await call(manageUser, 'POST', `/api/customer/projects/${projectIdemId}/contracts`, basePayload, idemKey);
    assert(rIdem2.status === 200 && rIdem2.json.contract.id === idemContractId, `SAME Idempotency-Key replayed on success -> same contract id returned (got ${rIdem2.json.contract && rIdem2.json.contract.id}, expected ${idemContractId})`);
    const idemRowCount = await pool.query('SELECT COUNT(*)::int AS n FROM client_contracts WHERE project_id=$1', [projectIdemId]);
    assert(idemRowCount.rows[0].n === 1, `exactly ONE row exists in client_contracts for this project despite two create calls (got ${idemRowCount.rows[0].n})`);

    // ============================================================================================
    // (3) validation errors -> 400 with exact messages
    // ============================================================================================
    console.log('\n=== (3) validation errors ===');
    const projB2 = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP1A2','โครงการทดสอบ phase1 A2',$2) RETURNING id`, [companyId, realCustomerId]);
    const project2Id = projB2.rows[0].id;

    const rNoRetention = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, retentionPercent: undefined });
    const NO_RETENTION_MSG = 'กรุณาระบุเปอร์เซ็นต์เงินประกันผลงาน (ไม่มีค่าเริ่มต้น ต้องกรอกเอง)';
    assert(rNoRetention.status === 400 && rNoRetention.json.error === NO_RETENTION_MSG, `missing retentionPercent -> 400 "${NO_RETENTION_MSG}" (got status=${rNoRetention.status}, body=${JSON.stringify(rNoRetention.json)})`);

    const rZeroValue = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, contractValue: 0 });
    const ZERO_VALUE_MSG = 'กรุณาระบุมูลค่าสัญญาให้ถูกต้อง (ต้องมากกว่า 0)';
    assert(rZeroValue.status === 400 && rZeroValue.json.error === ZERO_VALUE_MSG, `contractValue=0 -> 400 "${ZERO_VALUE_MSG}" (got status=${rZeroValue.status}, body=${JSON.stringify(rZeroValue.json)})`);

    const rNoPaymentTerms = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, paymentTerms: '   ' });
    const NO_PAYMENT_TERMS_MSG = 'กรุณาระบุเงื่อนไขการชำระเงิน';
    assert(rNoPaymentTerms.status === 400 && rNoPaymentTerms.json.error === NO_PAYMENT_TERMS_MSG, `blank paymentTerms -> 400 "${NO_PAYMENT_TERMS_MSG}" (got status=${rNoPaymentTerms.status}, body=${JSON.stringify(rNoPaymentTerms.json)})`);

    // ---- (3c) money precision: parsePositiveNumericValue passes a STRING through completely
    // unmodified (never reconstructs it via Number()), so sending contractValue as a JSON STRING (not
    // a bare JS number, which would already have been through JSON.parse()'s float parsing before our
    // code ever sees it) is what actually proves full NUMERIC(18,2) precision survives end to end.
    console.log('\n=== (3c) money precision ===');
    const bigValueStr = '123456789012.34';
    const rBigValue = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, contractValue: bigValueStr });
    assert(rBigValue.status === 200, `contractValue as an exact numeric STRING -> accepted (got status=${rBigValue.status}, body=${JSON.stringify(rBigValue.json)})`);
    const bigValueRow = await pool.query('SELECT contract_value::text AS v FROM client_contracts WHERE id=$1', [rBigValue.json.contract.id]);
    assert(bigValueRow.rows[0].v === bigValueStr, `stored value round-trips EXACTLY as text (got ${bigValueRow.rows[0].v}, expected ${bigValueStr})`);
    await pool.query('DELETE FROM client_contracts WHERE id=$1', [rBigValue.json.contract.id]);

    // 100.005 has 3 decimal places — client_contracts.contract_value is NUMERIC(18,2) (scale 2).
    // Letting Postgres silently round this at INSERT time would violate "never round silently" — the
    // route must reject it at the validation layer with a 400 instead.
    const rTooManyDecimals = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, contractValue: '100.005' });
    const TOO_MANY_DECIMALS_MSG = 'มูลค่าสัญญาระบุทศนิยมได้ไม่เกิน 2 ตำแหน่ง';
    assert(rTooManyDecimals.status === 400 && rTooManyDecimals.json.error === TOO_MANY_DECIMALS_MSG, `contractValue with 3 decimal places -> 400 "${TOO_MANY_DECIMALS_MSG}" (not silently rounded) (got status=${rTooManyDecimals.status}, body=${JSON.stringify(rTooManyDecimals.json)})`);

    // ---- (3d) calendar-invalid date: 2026-02-31 matches the YYYY-MM-DD shape regex but is not a real
    // date (2026 is not a leap year and February never has 31 days regardless) — must be a clean 400
    // via the ::date cast check, never a raw 500 from an uncaught INSERT failure.
    console.log('\n=== (3d) calendar-invalid date -> 400, not 500 ===');
    const rBadDate = await call(manageUser, 'POST', `/api/customer/projects/${project2Id}/contracts`, { ...basePayload, startDate: '2026-02-31' });
    assert(rBadDate.status === 400 && rBadDate.json.error === 'วันที่เริ่มสัญญาไม่ใช่วันที่จริงตามปฏิทิน', `startDate=2026-02-31 (shape OK, calendar invalid) -> 400 (got status=${rBadDate.status}, body=${JSON.stringify(rBadDate.json)})`);

    // ============================================================================================
    // (4) not-found / cross-company isolation -> 404 (never 400, never 403 — a URL-path resource
    // either exists in YOUR company or it doesn't exist at all, as far as you're concerned)
    // ============================================================================================
    console.log('\n=== (4) not-found / cross-company access -> 404 ===');
    const rNoProject = await call(manageUser, 'POST', `/api/customer/projects/999999999/contracts`, basePayload);
    assert(rNoProject.status === 404 && rNoProject.json.error === 'ไม่พบโครงการนี้', `nonexistent projectId -> 404 "ไม่พบโครงการนี้" (got status=${rNoProject.status}, body=${JSON.stringify(rNoProject.json)})`);

    const countBeforeCrossCreate = (await pool.query('SELECT COUNT(*)::int AS n FROM client_contracts WHERE project_id=$1', [projectBId])).rows[0].n;
    const rCrossCreate = await call(superUser, 'POST', `/api/customer/projects/${projectBId}/contracts`, basePayload);
    assert(rCrossCreate.status === 404 && rCrossCreate.json.error === 'ไม่พบโครงการนี้', `company A super_user creating a contract under company B's project -> 404 (got status=${rCrossCreate.status}, body=${JSON.stringify(rCrossCreate.json)})`);
    const countAfterCrossCreate = (await pool.query('SELECT COUNT(*)::int AS n FROM client_contracts WHERE project_id=$1', [projectBId])).rows[0].n;
    assert(countAfterCrossCreate === countBeforeCrossCreate, `no contract row was created in company B's project as a result of the rejected cross-company attempt (before=${countBeforeCrossCreate}, after=${countAfterCrossCreate})`);

    const cB = await call(superBUsername, 'POST', `/api/customer/projects/${projectBId}/contracts`, basePayload);
    assert(cB.status === 200, `setup: company B can create its own contract (got status=${cB.status})`);
    const cBId = cB.json.contract.id;

    const crossGet = await call(superUser, 'GET', `/api/customer/contracts/${cBId}`);
    assert(crossGet.status === 404 && crossGet.json.error === 'ไม่พบสัญญานี้', `company A super_user reading company B's contract -> 404 "ไม่พบสัญญานี้" (got status=${crossGet.status}, body=${JSON.stringify(crossGet.json)})`);

    const crossList = await call(superUser, 'GET', `/api/customer/projects/${projectBId}/contracts`);
    assert(crossList.status === 404 && crossList.json.error === 'ไม่พบโครงการนี้', `company A listing company B's project contracts -> 404 "ไม่พบโครงการนี้" (got status=${crossList.status}, body=${JSON.stringify(crossList.json)})`);

    const crossEdit = await call(superUser, 'PUT', `/api/customer/contracts/${cBId}`, basePayload);
    assert(crossEdit.status === 404 && crossEdit.json.error === 'ไม่พบสัญญานี้', `company A editing company B's contract -> 404 (got status=${crossEdit.status}, body=${JSON.stringify(crossEdit.json)})`);

    const crossCancel = await call(superUser, 'POST', `/api/customer/contracts/${cBId}/cancel`, {});
    assert(crossCancel.status === 404 && crossCancel.json.error === 'ไม่พบสัญญานี้', `company A cancelling company B's contract -> 404 (got status=${crossCancel.status}, body=${JSON.stringify(crossCancel.json)})`);

    // ============================================================================================
    // (5) GET is open to everyone (no permission flag needed to read)
    // ============================================================================================
    console.log('\n=== (5) GET stays open regardless of flags ===');
    const getNone = await call(noneUser, 'GET', `/api/customer/contracts/${c1Id}`);
    assert(getNone.status === 200 && getNone.json.contract.id === c1Id, `user with no flags can still GET a contract (got status=${getNone.status})`);
    const listNone = await call(noneUser, 'GET', `/api/customer/projects/${projectId}/contracts`);
    assert(listNone.status === 200 && listNone.json.contracts.some(c => c.id === c1Id), `user with no flags can still list a project's contracts (got status=${listNone.status})`);

    // ============================================================================================
    // (6) edit draft — permission gate + field updates + validation + customer_id re-derivation
    // ============================================================================================
    console.log('\n=== (6) PUT edit draft ===');
    const editNone = await call(noneUser, 'PUT', `/api/customer/contracts/${c1Id}`, basePayload);
    assert(editNone.status === 403 && editNone.json.error === MANAGE_DENIED_MSG, `user with no flags editing -> 403 (got status=${editNone.status}, body=${JSON.stringify(editNone.json)})`);
    const editApprove = await call(approveUser, 'PUT', `/api/customer/contracts/${c1Id}`, basePayload);
    assert(editApprove.status === 403 && editApprove.json.error === MANAGE_DENIED_MSG, `user with only can_approve_contracts editing -> 403 (got status=${editApprove.status}, body=${JSON.stringify(editApprove.json)})`);

    const editManage = await call(manageUser, 'PUT', `/api/customer/contracts/${c1Id}`, { ...basePayload, contractValue: 2000000, retentionPercent: 7 });
    assert(editManage.status === 200 && Number(editManage.json.contract.contractValue) === 2000000, `can_manage_contracts user edits draft successfully, new value reflected (got status=${editManage.status}, contractValue=${editManage.json.contract && editManage.json.contract.contractValue})`);
    assert(Number(editManage.json.contract.retentionPercent) === 7, `retentionPercent updated to 7 (got ${editManage.json.contract.retentionPercent})`);

    // (6e) PUT validation errors match the same messages as create
    const editZeroValue = await call(manageUser, 'PUT', `/api/customer/contracts/${c1Id}`, { ...basePayload, contractValue: 0 });
    assert(editZeroValue.status === 400 && editZeroValue.json.error === ZERO_VALUE_MSG, `PUT with contractValue=0 -> 400 "${ZERO_VALUE_MSG}" same as create (got status=${editZeroValue.status}, body=${JSON.stringify(editZeroValue.json)})`);
    const editNoRetention = await call(manageUser, 'PUT', `/api/customer/contracts/${c1Id}`, { ...basePayload, retentionPercent: undefined });
    assert(editNoRetention.status === 400 && editNoRetention.json.error === NO_RETENTION_MSG, `PUT with missing retentionPercent -> 400 "${NO_RETENTION_MSG}" same as create (got status=${editNoRetention.status}, body=${JSON.stringify(editNoRetention.json)})`);

    // (6-customer) the project's customer changed AFTER the draft was created — PUT must pick up the
    // NEW customer, not keep serving the stale one captured at creation time.
    console.log('\n=== (6-customer) PUT re-derives customer_id from the project if it changed ===');
    const newCust = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, 'ลูกค้าใหม่ phase1 (เปลี่ยนหลังสร้าง draft)']);
    const newCustomerId = newCust.rows[0].id;
    await pool.query('UPDATE client_projects SET customer_id=$1 WHERE id=$2', [newCustomerId, projectId]);
    const editAfterCustomerChange = await call(manageUser, 'PUT', `/api/customer/contracts/${c1Id}`, basePayload);
    assert(editAfterCustomerChange.status === 200 && editAfterCustomerChange.json.contract.customerId === newCustomerId, `PUT picks up the project's NEW customer_id (got ${editAfterCustomerChange.json.contract && editAfterCustomerChange.json.contract.customerId}, expected ${newCustomerId})`);
    // restore for the rest of the test, so later assertions about realCustomerId stay valid
    await pool.query('UPDATE client_projects SET customer_id=$1 WHERE id=$2', [realCustomerId, projectId]);

    // ============================================================================================
    // (7) cancel — permission gate, status transition, re-cancel rejected, edit-after-cancel rejected
    // ============================================================================================
    console.log('\n=== (7) cancel ===');
    const cancelApprove = await call(approveUser, 'POST', `/api/customer/contracts/${c1Id}/cancel`, {});
    assert(cancelApprove.status === 403 && cancelApprove.json.error === MANAGE_DENIED_MSG, `user with only can_approve_contracts cancelling -> 403 (got status=${cancelApprove.status}, body=${JSON.stringify(cancelApprove.json)})`);

    const cancelManage = await call(manageUser, 'POST', `/api/customer/contracts/${c1Id}/cancel`, {});
    assert(cancelManage.status === 200 && cancelManage.json.contract.status === 'cancelled', `can_manage_contracts user cancels draft -> status becomes cancelled (got status=${cancelManage.status}, contractStatus=${cancelManage.json.contract && cancelManage.json.contract.status})`);

    const editAfterCancel = await call(manageUser, 'PUT', `/api/customer/contracts/${c1Id}`, basePayload);
    const DRAFT_ONLY_MSG = 'แก้ไขได้เฉพาะสถานะร่างเท่านั้น';
    assert(editAfterCancel.status === 409 && editAfterCancel.json.error === DRAFT_ONLY_MSG, `editing a cancelled contract -> 409 "${DRAFT_ONLY_MSG}" (got status=${editAfterCancel.status}, body=${JSON.stringify(editAfterCancel.json)})`);

    const cancelAgain = await call(manageUser, 'POST', `/api/customer/contracts/${c1Id}/cancel`, {});
    const CANCEL_STATUS_MSG = 'ยกเลิกได้เฉพาะสถานะร่างหรือยื่นแล้วเท่านั้น (สัญญาที่อนุมัติแล้วต้องใช้ "เลิกสัญญา" แทน)';
    assert(cancelAgain.status === 409 && cancelAgain.json.error === CANCEL_STATUS_MSG, `cancelling an already-cancelled contract -> 409 "${CANCEL_STATUS_MSG}" (got status=${cancelAgain.status}, body=${JSON.stringify(cancelAgain.json)})`);

    // ============================================================================================
    // (8) a NEW root is allowed for the same project now that the old one is cancelled
    // ============================================================================================
    console.log('\n=== (8) new root allowed after the previous one was cancelled ===');
    const c2 = await call(superUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    assert(c2.status === 200, `super_user creates a fresh root contract after the old one is cancelled (got status=${c2.status}, body=${JSON.stringify(c2.json)})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    try {
      for (const cid of cleanupCompanyIds) {
        await pool.query(`DELETE FROM client_contracts WHERE company_id=$1`, [cid]);
        await pool.query(`DELETE FROM client_document_audit_log WHERE performed_by IN (SELECT id FROM customers WHERE company_id=$1)`, [cid]);
        await pool.query(`DELETE FROM client_projects WHERE company_id=$1`, [cid]);
        await pool.query(`DELETE FROM client_customers WHERE company_id=$1`, [cid]);
        await pool.query(`DELETE FROM customers WHERE company_id=$1`, [cid]);
        await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [cid]);
      }
    } catch (cleanupErr) {
      console.error('CLEANUP FAILED (leftover fixture rows may remain):', cleanupErr.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})();
