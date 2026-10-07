// Regression suite — Contract module (client_contracts, migration 0035/0036) Phase 3: approve + reject,
// for both the root contract and its revisions (R). Uses the real create/submit/approve/reject/cancel
// endpoints throughout (no SQL stand-ins — Phase 2's forceApprove() is retired now that this file and
// the real approve endpoint exist).
//
// Prerequisites: dev server running, migrations 0035/0036 applied. Run:
// cd server && node tests/contract-approve-reject-phase3.regression.js

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
  const headers = { Cookie: cookies[who] || '', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey || `ctp3-${Date.now()}-${++idemCounter}` };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[who] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, json };
}

const MANAGE_DENIED_MSG = 'เฉพาะผู้ที่ได้รับสิทธิ์จัดการสัญญาเท่านั้นที่ทำรายการนี้ได้';
const APPROVE_DENIED_MSG = 'เฉพาะผู้ที่ได้รับสิทธิ์อนุมัติสัญญาเท่านั้นที่ทำรายการนี้ได้';

(async () => {
  let companyId = null, companyBId = null;
  const cleanupCompanyIds = [];
  try {
    const stamp = Date.now();
    const hash = await bcrypt.hash(PASSWORD, 10);

    const compA = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase3 Test Co A', 'CTP3A' + stamp]);
    companyId = compA.rows[0].id;
    cleanupCompanyIds.push(companyId);
    const custA = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, 'ลูกค้าทดสอบ phase3 A']);
    const projA = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP3A','โครงการทดสอบ phase3 A',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const projectId = projA.rows[0].id;

    async function makeUser(username, role, flags) {
      const cols = ['company_id', 'name', 'email', 'username', 'password_hash', 'status', 'role', ...Object.keys(flags)];
      const vals = [companyId, username, `${username}@example.com`, username, hash, 'active', role, ...Object.values(flags)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(`INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders})`, vals);
      await call(username, 'POST', '/api/customer-login', { companyCode: 'CTP3A' + stamp, username, password: PASSWORD });
    }
    await makeUser('ctp3_none_' + stamp, 'maker', {});
    await makeUser('ctp3_manage_' + stamp, 'maker', { can_manage_contracts: true });
    await makeUser('ctp3_approve_' + stamp, 'maker', { can_approve_contracts: true });
    await makeUser('ctp3_super_' + stamp, 'super_user', {});
    await makeUser('ctp3_dual_' + stamp, 'maker', { can_manage_contracts: true, can_approve_contracts: true });
    await makeUser('ctp3_manage2_' + stamp, 'maker', { can_manage_contracts: true });
    const noneUser = 'ctp3_none_' + stamp, manageUser = 'ctp3_manage_' + stamp, approveUser = 'ctp3_approve_' + stamp,
      superUser = 'ctp3_super_' + stamp, dualUser = 'ctp3_dual_' + stamp, manage2User = 'ctp3_manage2_' + stamp;

    const compB = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase3 Test Co B', 'CTP3B' + stamp]);
    companyBId = compB.rows[0].id;
    cleanupCompanyIds.push(companyBId);
    const custB = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyBId, 'ลูกค้าทดสอบ phase3 B']);
    const superBUsername = 'ctp3_superb_' + stamp;
    await pool.query(`INSERT INTO customers (company_id, name, email, username, password_hash, status, role) VALUES ($1,'Super B',$2,$3,$4,'active','super_user')`, [companyBId, `${superBUsername}@example.com`, superBUsername, hash]);
    await call(superBUsername, 'POST', '/api/customer-login', { companyCode: 'CTP3B' + stamp, username: superBUsername, password: PASSWORD });

    const basePayload = { contractName: 'สัญญาทดสอบ phase3', contractValue: 1000000, depositPercent: 10, retentionPercent: 5, paymentTerms: 'เครดิต 30 วัน' };

    async function freshProject(code) {
      const p = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, code, 'โครงการทดสอบ ' + code, custA.rows[0].id]);
      return p.rows[0].id;
    }
    async function createSubmittedRoot(creator, submitter, code, payload) {
      const c = await call(creator, 'POST', `/api/customer/projects/${await freshProject(code)}/contracts`, payload || basePayload);
      await call(submitter, 'POST', `/api/customer/contracts/${c.json.contract.id}/submit`, {});
      return c.json.contract.id;
    }

    // ============================================================================================
    // (1) approve root — permission gate, status gate, cross-company 404
    // ============================================================================================
    console.log('\n=== (1) approve root: permission/status/cross-company ===');
    const root1Id = await createSubmittedRoot(manageUser, manageUser, 'CTP3R1');

    const apNone = await call(noneUser, 'POST', `/api/customer/contracts/${root1Id}/approve`, {});
    assert(apNone.status === 403 && apNone.json.error === APPROVE_DENIED_MSG, `no-flag user approving -> 403 (got status=${apNone.status}, body=${JSON.stringify(apNone.json)})`);
    const apManageOnly = await call(manageUser, 'POST', `/api/customer/contracts/${root1Id}/approve`, {});
    assert(apManageOnly.status === 403 && apManageOnly.json.error === APPROVE_DENIED_MSG, `manage-only user (no approve flag) approving -> 403 (got status=${apManageOnly.status}, body=${JSON.stringify(apManageOnly.json)})`);

    const draftProjId = await freshProject('CTP3DRAFT');
    const draftContract = await call(manageUser, 'POST', `/api/customer/projects/${draftProjId}/contracts`, basePayload);
    const apDraft = await call(approveUser, 'POST', `/api/customer/contracts/${draftContract.json.contract.id}/approve`, {});
    assert(apDraft.status === 409 && apDraft.json.error === 'อนุมัติได้เฉพาะสถานะยื่นแล้วเท่านั้น', `approving a draft (not submitted) -> 409 (got status=${apDraft.status}, body=${JSON.stringify(apDraft.json)})`);

    const apOk = await call(approveUser, 'POST', `/api/customer/contracts/${root1Id}/approve`, {});
    assert(apOk.status === 200 && apOk.json.contract.status === 'approved' && apOk.json.contract.contractStatus === 'active', `approve-flag user approves root -> status=approved, contractStatus=active (got status=${apOk.status}, body=${JSON.stringify(apOk.json)})`);

    const root2Id = await createSubmittedRoot(manageUser, manageUser, 'CTP3R2');
    const apCross = await call(superBUsername, 'POST', `/api/customer/contracts/${root2Id}/approve`, {});
    assert(apCross.status === 404 && apCross.json.error === 'ไม่พบสัญญานี้', `company B approving company A's contract -> 404 (got status=${apCross.status}, body=${JSON.stringify(apCross.json)})`);

    // ============================================================================================
    // (2) self-block — including created_by != submitted_by, and super_user's exemption
    // ============================================================================================
    console.log('\n=== (2) self-approval block ===');
    // dualUser creates, manage2User (a different person) submits, dualUser (who has approve rights,
    // and IS the creator) must still be blocked — self-block checks the full originators set
    // [created_by, submitted_by], not just "did you personally submit it"
    const selfBlockProjId = await freshProject('CTP3SELFBLOCK');
    const selfBlockCreate = await call(dualUser, 'POST', `/api/customer/projects/${selfBlockProjId}/contracts`, basePayload);
    const selfBlockId = selfBlockCreate.json.contract.id;
    await call(manage2User, 'POST', `/api/customer/contracts/${selfBlockId}/submit`, {});
    const selfBlockAttempt = await call(dualUser, 'POST', `/api/customer/contracts/${selfBlockId}/approve`, {});
    assert(selfBlockAttempt.status === 403 && selfBlockAttempt.json.code === 'self_approval_blocked', `creator (not the submitter) with approve rights still blocked from approving -> 403 code=self_approval_blocked (got status=${selfBlockAttempt.status}, body=${JSON.stringify(selfBlockAttempt.json)})`);
    const selfBlockRealApprove = await call(approveUser, 'POST', `/api/customer/contracts/${selfBlockId}/approve`, {});
    assert(selfBlockRealApprove.status === 200, `a genuinely uninvolved approver can approve it fine (got status=${selfBlockRealApprove.status}, body=${JSON.stringify(selfBlockRealApprove.json)})`);

    // super_user is exempt from self-block entirely — can create, submit, AND approve its own document
    const superSelfProjId = await freshProject('CTP3SUPERSELF');
    const superSelfCreate = await call(superUser, 'POST', `/api/customer/projects/${superSelfProjId}/contracts`, basePayload);
    await call(superUser, 'POST', `/api/customer/contracts/${superSelfCreate.json.contract.id}/submit`, {});
    const superSelfApprove = await call(superUser, 'POST', `/api/customer/contracts/${superSelfCreate.json.contract.id}/approve`, {});
    assert(superSelfApprove.status === 200, `super_user approves its own created+submitted contract (got status=${superSelfApprove.status}, body=${JSON.stringify(superSelfApprove.json)})`);

    // ============================================================================================
    // (3) reject root — reason required, status/audit, and the project frees up for a new root after
    // ============================================================================================
    console.log('\n=== (3) reject root ===');
    const rejRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3REJ');
    const rejNoReason = await call(approveUser, 'POST', `/api/customer/contracts/${rejRootId}/reject`, {});
    assert(rejNoReason.status === 400 && rejNoReason.json.error === 'กรุณาระบุเหตุผลการปฏิเสธ', `reject with no reason -> 400 (got status=${rejNoReason.status}, body=${JSON.stringify(rejNoReason.json)})`);
    const rejOk = await call(approveUser, 'POST', `/api/customer/contracts/${rejRootId}/reject`, { reason: 'ราคาสูงเกินงบ' });
    assert(rejOk.status === 200 && rejOk.json.contract.status === 'rejected' && rejOk.json.contract.rejectedReason === 'ราคาสูงเกินงบ', `reject with a reason -> status=rejected, rejectedReason stored (got status=${rejOk.status}, body=${JSON.stringify(rejOk.json)})`);
    const rejProjIdRow = await pool.query('SELECT project_id FROM client_contracts WHERE id=$1', [rejRootId]);
    const newRootAfterReject = await call(manageUser, 'POST', `/api/customer/projects/${rejProjIdRow.rows[0].project_id}/contracts`, basePayload);
    assert(newRootAfterReject.status === 200, `a new root can be opened for the same project after the old one was rejected (uq_client_contracts_root_per_project excludes rejected) (got status=${newRootAfterReject.status}, body=${JSON.stringify(newRootAfterReject.json)})`);

    // ============================================================================================
    // (4) approve R: amount check (<=0 rejected), date conflict check, and the success path updating
    // client_contract_current_value / client_contract_effective_terms correctly
    // ============================================================================================
    console.log('\n=== (4) approve R: amount check, date conflict, current_value/effective_terms correctness ===');
    const amountRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3AMOUNT', { ...basePayload, contractValue: 1000000 });
    await call(approveUser, 'POST', `/api/customer/contracts/${amountRootId}/approve`, {});
    const negRev = await call(manageUser, 'POST', `/api/customer/contracts/${amountRootId}/revisions`, { contractValue: -1000000 });
    await call(manageUser, 'POST', `/api/customer/contracts/${negRev.json.contract.id}/submit`, {});
    const negApprove = await call(approveUser, 'POST', `/api/customer/contracts/${negRev.json.contract.id}/approve`, {});
    assert(negApprove.status === 409 && /ยอดสัญญารวมหลังอนุมัติจะเหลือไม่เกินศูนย์/.test(negApprove.json.error), `approving an R that would bring the total to exactly 0 -> 409 (got status=${negApprove.status}, body=${JSON.stringify(negApprove.json)})`);
    const negRevRowAfter = await pool.query('SELECT status FROM client_contracts WHERE id=$1', [negRev.json.contract.id]);
    assert(negRevRowAfter.rows[0].status === 'submitted', `the rejected-amount R's own row is unchanged (still submitted, not approved) (got ${negRevRowAfter.rows[0].status})`);

    const dateRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3DATE', { ...basePayload, startDate: '2027-01-01', endDate: '2027-12-31' });
    await call(approveUser, 'POST', `/api/customer/contracts/${dateRootId}/approve`, {});
    const badDateRev = await call(manageUser, 'POST', `/api/customer/contracts/${dateRootId}/revisions`, { contractValue: 1000, endDate: '2026-06-01' });
    await call(manageUser, 'POST', `/api/customer/contracts/${badDateRev.json.contract.id}/submit`, {});
    const badDateApprove = await call(approveUser, 'POST', `/api/customer/contracts/${badDateRev.json.contract.id}/approve`, {});
    assert(badDateApprove.status === 409 && /วันที่สิ้นสุดสัญญาที่จะมีผลหลังอนุมัติใบนี้ ก่อนวันที่เริ่มสัญญาที่จะมีผล/.test(badDateApprove.json.error), `approving an R whose new effective end_date (2026-06-01) precedes the effective start_date (2027-01-01) -> 409 (got status=${badDateApprove.status}, body=${JSON.stringify(badDateApprove.json)})`);

    // success path: base 1,000,000 + R1(+100,000, approved) + R2(+50,000, approved) = 1,150,000 exactly
    const curValRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3CURVAL', { ...basePayload, contractValue: 1000000, startDate: '2028-01-01' });
    await call(approveUser, 'POST', `/api/customer/contracts/${curValRootId}/approve`, {});
    const cvR1 = await call(manageUser, 'POST', `/api/customer/contracts/${curValRootId}/revisions`, { contractValue: 100000, endDate: '2028-12-31' });
    await call(manageUser, 'POST', `/api/customer/contracts/${cvR1.json.contract.id}/submit`, {});
    const cvR1Approve = await call(approveUser, 'POST', `/api/customer/contracts/${cvR1.json.contract.id}/approve`, {});
    assert(cvR1Approve.status === 200, `R1 (+100,000) approved cleanly (got status=${cvR1Approve.status}, body=${JSON.stringify(cvR1Approve.json)})`);
    const cvR2 = await call(manageUser, 'POST', `/api/customer/contracts/${curValRootId}/revisions`, { contractValue: 50000, endDate: '2029-06-30' });
    await call(manageUser, 'POST', `/api/customer/contracts/${cvR2.json.contract.id}/submit`, {});
    const cvR2Approve = await call(approveUser, 'POST', `/api/customer/contracts/${cvR2.json.contract.id}/approve`, {});
    assert(cvR2Approve.status === 200, `R2 (+50,000) approved cleanly (got status=${cvR2Approve.status}, body=${JSON.stringify(cvR2Approve.json)})`);

    const curVal = await pool.query('SELECT base_value, revision_total, current_value FROM client_contract_current_value WHERE company_id=$1 AND contract_id=$2', [companyId, curValRootId]);
    assert(curVal.rows[0].base_value === '1000000.00', `current_value view: base_value is 1,000,000.00 (got ${curVal.rows[0].base_value})`);
    assert(curVal.rows[0].revision_total === '150000.00', `current_value view: revision_total is R1+R2 = 150,000.00 (got ${curVal.rows[0].revision_total})`);
    assert(curVal.rows[0].current_value === '1150000.00', `current_value view: current_value is base + revision_total = 1,150,000.00 (got ${curVal.rows[0].current_value})`);

    const effTerms = await pool.query(
      `SELECT to_char(effective_end_date,'YYYY-MM-DD') AS effective_end_date FROM client_contract_effective_terms WHERE company_id=$1 AND contract_id=$2`,
      [companyId, curValRootId]
    );
    assert(effTerms.rows[0].effective_end_date === '2029-06-30', `effective_terms view reflects R2's (the latest approved) end_date, not R1's or the root's (got ${effTerms.rows[0].effective_end_date})`);

    // ============================================================================================
    // (5) replay approve with the same Idempotency-Key — same result, audit log not duplicated
    // ============================================================================================
    console.log('\n=== (5) replay approve -> same result, audit log not duplicated ===');
    const replayRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3REPLAY');
    const replayKey = 'ctp3-approve-replay-' + stamp;
    const replay1 = await call(approveUser, 'POST', `/api/customer/contracts/${replayRootId}/approve`, {}, replayKey);
    const replay2 = await call(approveUser, 'POST', `/api/customer/contracts/${replayRootId}/approve`, {}, replayKey);
    assert(replay1.status === 200 && replay2.status === 200 && replay1.json.contract.approvedAt === replay2.json.contract.approvedAt, `same Idempotency-Key replayed on approve -> identical approvedAt both times (not re-approved with a new timestamp) (first=${replay1.json.contract && replay1.json.contract.approvedAt}, second=${replay2.json.contract && replay2.json.contract.approvedAt})`);
    const replayAudit = await pool.query(`SELECT COUNT(*)::int AS n FROM client_document_audit_log WHERE company_id=$1 AND doc_type='contract' AND doc_id=$2 AND action='approve'`, [companyId, replayRootId]);
    assert(replayAudit.rows[0].n === 1, `exactly 1 "approve" audit row despite the replayed call (got ${replayAudit.rows[0].n})`);

    // ============================================================================================
    // (6) concurrent approve — two simultaneous requests, only one must actually succeed
    // ============================================================================================
    console.log('\n=== (6) concurrent approve -> exactly one success ===');
    const concRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3CONC');
    const [concA, concB] = await Promise.all([
      call(approveUser, 'POST', `/api/customer/contracts/${concRootId}/approve`, {}, 'ctp3-conc-a-' + stamp),
      call(approveUser, 'POST', `/api/customer/contracts/${concRootId}/approve`, {}, 'ctp3-conc-b-' + stamp),
    ]);
    const concStatuses = [concA.status, concB.status].sort();
    assert(JSON.stringify(concStatuses) === JSON.stringify([200, 409]), `concurrent approve -> exactly one 200 and one 409 (got ${JSON.stringify([concA.status, concB.status])})`);

    // ============================================================================================
    // (7) reject R then open a new R — one-open-revision index excludes rejected, and the next
    // revision number still advances forward (not reused)
    // ============================================================================================
    console.log('\n=== (7) reject R -> can open a new one, revision number still advances ===');
    const rejRevRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3REJREV');
    await call(approveUser, 'POST', `/api/customer/contracts/${rejRevRootId}/approve`, {});
    const rejR1 = await call(manageUser, 'POST', `/api/customer/contracts/${rejRevRootId}/revisions`, { contractValue: 1000 });
    await call(manageUser, 'POST', `/api/customer/contracts/${rejR1.json.contract.id}/submit`, {});
    const rejR1Reject = await call(approveUser, 'POST', `/api/customer/contracts/${rejR1.json.contract.id}/reject`, { reason: 'ไม่เหมาะสม' });
    assert(rejR1Reject.status === 200 && rejR1Reject.json.contract.status === 'rejected', `R1 rejected successfully (got status=${rejR1Reject.status}, contractStatus=${rejR1Reject.json.contract && rejR1Reject.json.contract.status})`);
    const rootAfterRejectR1 = await pool.query('SELECT status, contract_status FROM client_contracts WHERE id=$1', [rejRevRootId]);
    assert(rootAfterRejectR1.rows[0].status === 'approved' && rootAfterRejectR1.rows[0].contract_status === 'active', `rejecting R1 does NOT affect the root's own status/contract_status (got ${JSON.stringify(rootAfterRejectR1.rows[0])})`);
    const rejR2 = await call(manageUser, 'POST', `/api/customer/contracts/${rejRevRootId}/revisions`, { contractValue: 2000 });
    assert(rejR2.status === 200, `a new R can be opened after R1 was rejected (got status=${rejR2.status}, body=${JSON.stringify(rejR2.json)})`);
    const rejR2Submit = await call(manageUser, 'POST', `/api/customer/contracts/${rejR2.json.contract.id}/submit`, {});
    assert(rejR2Submit.status === 200 && rejR2Submit.json.contract.revisionNo === 2, `R2 gets revisionNo=2, not a reused 1, despite R1 (revision_no=1) being rejected (got revisionNo=${rejR2Submit.json.contract && rejR2Submit.json.contract.revisionNo})`);

    // ============================================================================================
    // (8) approve R — permission gate (none/manage-only denied, approve-flag allowed)
    // ============================================================================================
    console.log('\n=== (8) approve R: permission gate ===');
    const permRRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3PERMR');
    await call(approveUser, 'POST', `/api/customer/contracts/${permRRootId}/approve`, {});
    const permRRev = await call(manageUser, 'POST', `/api/customer/contracts/${permRRootId}/revisions`, { contractValue: 1000 });
    await call(manageUser, 'POST', `/api/customer/contracts/${permRRev.json.contract.id}/submit`, {});
    const permRNone = await call(noneUser, 'POST', `/api/customer/contracts/${permRRev.json.contract.id}/approve`, {});
    assert(permRNone.status === 403 && permRNone.json.error === APPROVE_DENIED_MSG, `no-flag user approving an R -> 403 (got status=${permRNone.status}, body=${JSON.stringify(permRNone.json)})`);
    const permRManage = await call(manageUser, 'POST', `/api/customer/contracts/${permRRev.json.contract.id}/approve`, {});
    assert(permRManage.status === 403 && permRManage.json.error === APPROVE_DENIED_MSG, `manage-only user (no approve flag) approving an R -> 403 (got status=${permRManage.status}, body=${JSON.stringify(permRManage.json)})`);
    const permRApprove = await call(approveUser, 'POST', `/api/customer/contracts/${permRRev.json.contract.id}/approve`, {});
    assert(permRApprove.status === 200 && permRApprove.json.contract.status === 'approved', `approve-flag user approving an R -> 200 (got status=${permRApprove.status}, body=${JSON.stringify(permRApprove.json)})`);

    // ============================================================================================
    // (9) reject root — permission gate (none/manage-only denied) + super_user success
    // ============================================================================================
    console.log('\n=== (9) reject root: permission gate + super_user ===');
    const permRejRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3PERMREJROOT');
    const permRejNone = await call(noneUser, 'POST', `/api/customer/contracts/${permRejRootId}/reject`, { reason: 'ทดสอบ' });
    assert(permRejNone.status === 403 && permRejNone.json.error === APPROVE_DENIED_MSG, `no-flag user rejecting root -> 403 (got status=${permRejNone.status}, body=${JSON.stringify(permRejNone.json)})`);
    const permRejManage = await call(manageUser, 'POST', `/api/customer/contracts/${permRejRootId}/reject`, { reason: 'ทดสอบ' });
    assert(permRejManage.status === 403 && permRejManage.json.error === APPROVE_DENIED_MSG, `manage-only user rejecting root -> 403 (got status=${permRejManage.status}, body=${JSON.stringify(permRejManage.json)})`);
    const permRejSuper = await call(superUser, 'POST', `/api/customer/contracts/${permRejRootId}/reject`, { reason: 'super_user ปฏิเสธ' });
    assert(permRejSuper.status === 200 && permRejSuper.json.contract.status === 'rejected', `super_user rejects root -> 200 (got status=${permRejSuper.status}, body=${JSON.stringify(permRejSuper.json)})`);

    // ============================================================================================
    // (10) reject R — permission gate (none/manage-only denied) + super_user success
    // ============================================================================================
    console.log('\n=== (10) reject R: permission gate + super_user ===');
    const permRejRRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3PERMREJR');
    await call(approveUser, 'POST', `/api/customer/contracts/${permRejRRootId}/approve`, {});
    const permRejRRev = await call(manageUser, 'POST', `/api/customer/contracts/${permRejRRootId}/revisions`, { contractValue: 1000 });
    await call(manageUser, 'POST', `/api/customer/contracts/${permRejRRev.json.contract.id}/submit`, {});
    const permRejRNone = await call(noneUser, 'POST', `/api/customer/contracts/${permRejRRev.json.contract.id}/reject`, { reason: 'ทดสอบ' });
    assert(permRejRNone.status === 403 && permRejRNone.json.error === APPROVE_DENIED_MSG, `no-flag user rejecting an R -> 403 (got status=${permRejRNone.status}, body=${JSON.stringify(permRejRNone.json)})`);
    const permRejRManage = await call(manageUser, 'POST', `/api/customer/contracts/${permRejRRev.json.contract.id}/reject`, { reason: 'ทดสอบ' });
    assert(permRejRManage.status === 403 && permRejRManage.json.error === APPROVE_DENIED_MSG, `manage-only user rejecting an R -> 403 (got status=${permRejRManage.status}, body=${JSON.stringify(permRejRManage.json)})`);
    const permRejRSuper = await call(superUser, 'POST', `/api/customer/contracts/${permRejRRev.json.contract.id}/reject`, { reason: 'super_user ปฏิเสธใบแก้ไข' });
    assert(permRejRSuper.status === 200 && permRejRSuper.json.contract.status === 'rejected', `super_user rejects an R -> 200 (got status=${permRejRSuper.status}, body=${JSON.stringify(permRejRSuper.json)})`);
    const permRejRRootAfter = await pool.query('SELECT status, contract_status FROM client_contracts WHERE id=$1', [permRejRRootId]);
    assert(permRejRRootAfter.rows[0].status === 'approved' && permRejRRootAfter.rows[0].contract_status === 'active', `rejecting the R does not affect its root's own status/contract_status (got ${JSON.stringify(permRejRRootAfter.rows[0])})`);

    // ============================================================================================
    // (11) self-approval block on reject — same originators rule as approve ([created_by,
    // submitted_by] of the row being decided), code asserted on both
    // ============================================================================================
    console.log('\n=== (11) self-approval block on reject ===');
    const selfRejProjId = await freshProject('CTP3SELFREJ');
    const selfRejCreate = await call(dualUser, 'POST', `/api/customer/projects/${selfRejProjId}/contracts`, basePayload);
    const selfRejId = selfRejCreate.json.contract.id;
    await call(manage2User, 'POST', `/api/customer/contracts/${selfRejId}/submit`, {});
    const selfRejAttempt = await call(dualUser, 'POST', `/api/customer/contracts/${selfRejId}/reject`, { reason: 'ทดสอบ self-block' });
    assert(selfRejAttempt.status === 403 && selfRejAttempt.json.code === 'self_approval_blocked', `creator (not the submitter) with approve rights still blocked from rejecting -> 403 code=self_approval_blocked (got status=${selfRejAttempt.status}, body=${JSON.stringify(selfRejAttempt.json)})`);
    const selfRejReal = await call(approveUser, 'POST', `/api/customer/contracts/${selfRejId}/reject`, { reason: 'เหตุผลจริง' });
    assert(selfRejReal.status === 200, `a genuinely uninvolved approver can reject it fine (got status=${selfRejReal.status}, body=${JSON.stringify(selfRejReal.json)})`);

    // ============================================================================================
    // (12) approve an R after its root has already been terminated (direct SQL — no /terminate
    // endpoint yet, that lands in Phase 4) -> 409, same root-status guard as create-revision/submit
    // ============================================================================================
    console.log('\n=== (12) approve R when root already terminated -> 409 ===');
    const termRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3TERM');
    await call(approveUser, 'POST', `/api/customer/contracts/${termRootId}/approve`, {});
    const termRev = await call(manageUser, 'POST', `/api/customer/contracts/${termRootId}/revisions`, { contractValue: 1000 });
    await call(manageUser, 'POST', `/api/customer/contracts/${termRev.json.contract.id}/submit`, {});
    await pool.query(`UPDATE client_contracts SET contract_status='terminated' WHERE id=$1`, [termRootId]);
    const PARENT_NOT_ACTIVE_AT_APPROVE_MSG = 'อนุมัติใบแก้ไขสัญญาไม่ได้ เพราะสัญญาหลักไม่ได้อยู่ในสถานะอนุมัติแล้วและดำเนินอยู่ (active) แล้ว ณ ขณะนี้';
    const termApprove = await call(approveUser, 'POST', `/api/customer/contracts/${termRev.json.contract.id}/approve`, {});
    assert(termApprove.status === 409 && termApprove.json.error === PARENT_NOT_ACTIVE_AT_APPROVE_MSG, `approving an R after its root was terminated -> 409 "${PARENT_NOT_ACTIVE_AT_APPROVE_MSG}" (got status=${termApprove.status}, body=${JSON.stringify(termApprove.json)})`);

    // ============================================================================================
    // (13) reject: audit log has exactly 1 row, replay does not duplicate it
    // ============================================================================================
    console.log('\n=== (13) reject audit log: 1 row, no duplicate on replay ===');
    const rejAuditRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3REJAUDIT');
    const rejAuditKey = 'ctp3-reject-replay-' + stamp;
    const rejAudit1 = await call(approveUser, 'POST', `/api/customer/contracts/${rejAuditRootId}/reject`, { reason: 'เหตุผลทดสอบ audit' }, rejAuditKey);
    const rejAudit2 = await call(approveUser, 'POST', `/api/customer/contracts/${rejAuditRootId}/reject`, { reason: 'เหตุผลทดสอบ audit' }, rejAuditKey);
    assert(rejAudit1.status === 200 && rejAudit2.status === 200 && rejAudit1.json.contract.rejectedReason === rejAudit2.json.contract.rejectedReason, `same Idempotency-Key replayed on reject -> identical result both times (first=${rejAudit1.json.contract && rejAudit1.json.contract.rejectedReason}, second=${rejAudit2.json.contract && rejAudit2.json.contract.rejectedReason})`);
    const rejAuditCount = await pool.query(`SELECT COUNT(*)::int AS n FROM client_document_audit_log WHERE company_id=$1 AND doc_type='contract' AND doc_id=$2 AND action='reject'`, [companyId, rejAuditRootId]);
    assert(rejAuditCount.rows[0].n === 1, `exactly 1 "reject" audit row despite the replayed call (got ${rejAuditCount.rows[0].n})`);

    // ============================================================================================
    // (14) date conflict check pulls the effective end_date from a PREVIOUSLY APPROVED R, not just
    // the root's own dates — root's own range is wide and would never conflict with anything by
    // itself, proving the COALESCE really falls through to client_contract_effective_terms
    // ============================================================================================
    console.log('\n=== (14) date conflict sourced from a previously-approved R, not the root itself ===');
    const chainRootId = await createSubmittedRoot(manageUser, manageUser, 'CTP3DATECHAIN', { ...basePayload, startDate: '2030-01-01', endDate: '2031-12-31' });
    await call(approveUser, 'POST', `/api/customer/contracts/${chainRootId}/approve`, {});
    const chainRA = await call(manageUser, 'POST', `/api/customer/contracts/${chainRootId}/revisions`, { contractValue: 1000, endDate: '2030-06-30' });
    await call(manageUser, 'POST', `/api/customer/contracts/${chainRA.json.contract.id}/submit`, {});
    const chainRAApprove = await call(approveUser, 'POST', `/api/customer/contracts/${chainRA.json.contract.id}/approve`, {});
    assert(chainRAApprove.status === 200, `setup: R_A (shrinks effective_end_date to 2030-06-30, root's own end_date stays 2031-12-31) approved cleanly (got status=${chainRAApprove.status}, body=${JSON.stringify(chainRAApprove.json)})`);
    const chainRB = await call(manageUser, 'POST', `/api/customer/contracts/${chainRootId}/revisions`, { contractValue: 2000, startDate: '2030-07-01' });
    await call(manageUser, 'POST', `/api/customer/contracts/${chainRB.json.contract.id}/submit`, {});
    const chainRBApprove = await call(approveUser, 'POST', `/api/customer/contracts/${chainRB.json.contract.id}/approve`, {});
    assert(chainRBApprove.status === 409 && /วันที่สิ้นสุดสัญญาที่จะมีผลหลังอนุมัติใบนี้ ก่อนวันที่เริ่มสัญญาที่จะมีผล/.test(chainRBApprove.json.error), `R_B's new start_date (2030-07-01) conflicts with R_A's APPROVED effective end_date (2030-06-30), not the root's own end_date (2031-12-31) -> 409 (got status=${chainRBApprove.status}, body=${JSON.stringify(chainRBApprove.json)})`);

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
        await pool.query(`DELETE FROM company_document_counters WHERE company_id=$1`, [cid]);
        await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [cid]);
      }
    } catch (cleanupErr) {
      console.error('CLEANUP FAILED (leftover fixture rows may remain):', cleanupErr.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})();
