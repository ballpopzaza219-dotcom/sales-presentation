// Regression suite — Contract module (client_contracts, migration 0035/0036) Phase 2: submit (root +
// revision numbering) and create-revision (R). Approving the root (a precondition for creating an R at
// all) goes through the real POST .../approve endpoint from Phase 3 — this file no longer bypasses it
// via direct SQL (it did before Phase 3 existed; see contract-approve-reject-phase3.regression.js for
// approve/reject's own dedicated coverage, including self-block and the amount/date checks on R).
//
// Prerequisites: dev server running, migrations 0035/0036 applied. Run:
// cd server && node tests/contract-submit-revisions-phase2.regression.js

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
  const headers = { Cookie: cookies[who] || '', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey || `ctp2-${Date.now()}-${++idemCounter}` };
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

    const compA = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase2 Test Co A', 'CTP2A' + stamp]);
    companyId = compA.rows[0].id;
    cleanupCompanyIds.push(companyId);
    const custA = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, 'ลูกค้าทดสอบ phase2 A']);
    const projA = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2A','โครงการทดสอบ phase2 A',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const projectId = projA.rows[0].id;

    async function makeUser(username, role, flags) {
      const cols = ['company_id', 'name', 'email', 'username', 'password_hash', 'status', 'role', ...Object.keys(flags)];
      const vals = [companyId, username, `${username}@example.com`, username, hash, 'active', role, ...Object.values(flags)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(`INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders})`, vals);
      await call(username, 'POST', '/api/customer-login', { companyCode: 'CTP2A' + stamp, username, password: PASSWORD });
    }
    await makeUser('ctp2_none_' + stamp, 'maker', {});
    await makeUser('ctp2_manage_' + stamp, 'maker', { can_manage_contracts: true });
    await makeUser('ctp2_approve_' + stamp, 'maker', { can_approve_contracts: true });
    await makeUser('ctp2_super_' + stamp, 'super_user', {});
    const noneUser = 'ctp2_none_' + stamp, manageUser = 'ctp2_manage_' + stamp, approveUser = 'ctp2_approve_' + stamp, superUser = 'ctp2_super_' + stamp;

    const compB = await pool.query(`INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`, ['Contract Phase2 Test Co B', 'CTP2B' + stamp]);
    companyBId = compB.rows[0].id;
    cleanupCompanyIds.push(companyBId);
    const custB = await pool.query(`INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`, [companyBId, 'ลูกค้าทดสอบ phase2 B']);
    const projB = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2B','โครงการทดสอบ phase2 B',$2) RETURNING id`, [companyBId, custB.rows[0].id]);
    const superBUsername = 'ctp2_superb_' + stamp;
    await pool.query(`INSERT INTO customers (company_id, name, email, username, password_hash, status, role) VALUES ($1,'Super B',$2,$3,$4,'active','super_user')`, [companyBId, `${superBUsername}@example.com`, superBUsername, hash]);
    await call(superBUsername, 'POST', '/api/customer-login', { companyCode: 'CTP2B' + stamp, username: superBUsername, password: PASSWORD });

    const basePayload = { contractName: 'สัญญาทดสอบ phase2', contractValue: 1000000, depositPercent: 10, retentionPercent: 5, paymentTerms: 'เครดิต 30 วัน' };

    // ============================================================================================
    // (1) submit the ROOT contract — permission gate, status gate, number format, cross-company 404
    // ============================================================================================
    console.log('\n=== (1) submit root ===');
    const create1 = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    const root1Id = create1.json.contract.id;

    const submitNone = await call(noneUser, 'POST', `/api/customer/contracts/${root1Id}/submit`, {});
    assert(submitNone.status === 403 && submitNone.json.error === MANAGE_DENIED_MSG, `no-flag user submitting -> 403 (got status=${submitNone.status}, body=${JSON.stringify(submitNone.json)})`);
    const submitApprove = await call(approveUser, 'POST', `/api/customer/contracts/${root1Id}/submit`, {});
    assert(submitApprove.status === 403 && submitApprove.json.error === MANAGE_DENIED_MSG, `approve-only user submitting -> 403 (got status=${submitApprove.status}, body=${JSON.stringify(submitApprove.json)})`);

    const submitOk = await call(manageUser, 'POST', `/api/customer/contracts/${root1Id}/submit`, {});
    assert(submitOk.status === 200 && submitOk.json.contract.status === 'submitted', `manage user submits root -> status=submitted (got status=${submitOk.status}, body=${JSON.stringify(submitOk.json)})`);
    const bangkokYear = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(new Date()), 10) + 543;
    const expectedPrefix = `CT-${bangkokYear}-`;
    assert(typeof submitOk.json.contract.contractNo === 'string' && submitOk.json.contract.contractNo.startsWith(expectedPrefix), `contract_no has the expected format "${expectedPrefix}NNNN" (got ${submitOk.json.contract.contractNo})`);

    const submitAgain = await call(manageUser, 'POST', `/api/customer/contracts/${root1Id}/submit`, {});
    assert(submitAgain.status === 409 && submitAgain.json.error === 'ยื่นได้เฉพาะสถานะร่างเท่านั้น', `submitting an already-submitted contract -> 409 (got status=${submitAgain.status}, body=${JSON.stringify(submitAgain.json)})`);

    const submitCross = await call(superBUsername, 'POST', `/api/customer/contracts/${root1Id}/submit`, {});
    assert(submitCross.status === 404 && submitCross.json.error === 'ไม่พบสัญญานี้', `company B submitting company A's contract -> 404 (got status=${submitCross.status}, body=${JSON.stringify(submitCross.json)})`);

    // ============================================================================================
    // (1b) concurrent submit of the SAME draft (two different Idempotency-Keys, fired together) —
    // the row lock in the submit handler must serialize them: exactly one 200, one 409, and the
    // document counter advances by 1, not 2 (no double-issued contract_no from the race)
    // ============================================================================================
    console.log('\n=== (1b) concurrent submit of the same draft -> one 200, one 409, counter +1 ===');
    const projConc = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2ACONC','โครงการทดสอบ concurrent submit',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const createConc = await call(manageUser, 'POST', `/api/customer/projects/${projConc.rows[0].id}/contracts`, basePayload);
    const rootConcId = createConc.json.contract.id;
    const bangkokYearEarly = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(new Date()), 10) + 543;
    const counterBeforeConc = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='contract' AND year=$2`, [companyId, bangkokYearEarly]);
    const [concA, concB] = await Promise.all([
      call(manageUser, 'POST', `/api/customer/contracts/${rootConcId}/submit`, {}, 'ctp2-conc-a-' + stamp),
      call(manageUser, 'POST', `/api/customer/contracts/${rootConcId}/submit`, {}, 'ctp2-conc-b-' + stamp),
    ]);
    const concStatuses = [concA.status, concB.status].sort();
    assert(JSON.stringify(concStatuses) === JSON.stringify([200, 409]), `concurrent submit of the same draft -> exactly one 200 and one 409 (got ${JSON.stringify([concA.status, concB.status])})`);
    const concLoser = concA.status === 409 ? concA : concB;
    assert(concLoser.json.error === 'ยื่นได้เฉพาะสถานะร่างเท่านั้น', `the losing concurrent request gets the expected 409 message (got ${JSON.stringify(concLoser.json)})`);
    const counterAfterConc = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='contract' AND year=$2`, [companyId, bangkokYearEarly]);
    assert(counterAfterConc.rows[0].next_seq - counterBeforeConc.rows[0].next_seq === 1, `document counter advanced by exactly 1 despite 2 concurrent submit attempts (before=${counterBeforeConc.rows[0].next_seq}, after=${counterAfterConc.rows[0].next_seq})`);

    // ============================================================================================
    // (2) submit idempotency — same key replayed must not double-increment the document counter
    // ============================================================================================
    console.log('\n=== (2) submit idempotency: same key -> same contract_no, counter increments once ===');
    // root1 is still 'submitted' (a live root) at this point, so a second root for the same project
    // must still be rejected — confirms uq_client_contracts_root_per_project doesn't only apply to
    // drafts, it covers submitted/approved roots too
    const create2Blocked = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    assert(create2Blocked.status === 409 && create2Blocked.json.error === 'โครงการนี้มีสัญญาหลักที่ยังมีผลอยู่แล้ว ต้องยกเลิก/เลิกสัญญาเดิมก่อนจึงสร้างใหม่ได้', `second root while root1 is still submitted (not just draft) -> 409 (got status=${create2Blocked.status}, body=${JSON.stringify(create2Blocked.json)})`);
    // can't create a second root for the same project while the first is live — cancel it first so
    // only one "live" root exists at a time, matching the DB's own uq_client_contracts_root_per_project
    // (this test only needs a FRESH draft to submit, not two simultaneous roots)
    await call(manageUser, 'POST', `/api/customer/contracts/${root1Id}/cancel`, {});
    const create2b = await call(manageUser, 'POST', `/api/customer/projects/${projectId}/contracts`, basePayload);
    const root2Id = create2b.json.contract.id;
    const counterBefore = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='contract' AND year=$2`, [companyId, bangkokYear]);
    const idemKey = 'ctp2-submit-idem-' + stamp;
    const submitIdem1 = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/submit`, {}, idemKey);
    const submitIdem2 = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/submit`, {}, idemKey);
    assert(submitIdem1.status === 200 && submitIdem2.status === 200 && submitIdem1.json.contract.contractNo === submitIdem2.json.contract.contractNo, `same Idempotency-Key replayed -> identical contract_no returned both times (first=${submitIdem1.json.contract && submitIdem1.json.contract.contractNo}, second=${submitIdem2.json.contract && submitIdem2.json.contract.contractNo})`);
    const counterAfter = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='contract' AND year=$2`, [companyId, bangkokYear]);
    assert(counterAfter.rows[0].next_seq - counterBefore.rows[0].next_seq === 1, `company_document_counters advanced by exactly 1, not 2, despite two submit calls (before=${counterBefore.rows[0].next_seq}, after=${counterAfter.rows[0].next_seq})`);

    // use root2 (now approved via the REAL approve endpoint) as the parent for all revision tests below
    // — approveUser (not manageUser, who created+submitted root2) so this never trips self-block
    const approveRoot2 = await call(approveUser, 'POST', `/api/customer/contracts/${root2Id}/approve`, {});
    assert(approveRoot2.status === 200 && approveRoot2.json.contract.status === 'approved' && approveRoot2.json.contract.contractStatus === 'active', `setup: root2 approved via the real approve endpoint (got status=${approveRoot2.status}, body=${JSON.stringify(approveRoot2.json)})`);
    const root2 = (await pool.query('SELECT contract_no FROM client_contracts WHERE id=$1', [root2Id])).rows[0];

    // ============================================================================================
    // (3) create revision (R) — permission gate, parent-must-be-root guard, parent-must-be-active guard
    // ============================================================================================
    console.log('\n=== (3) create revision (R) ===');
    const revNone = await call(noneUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 50000 });
    assert(revNone.status === 403 && revNone.json.error === MANAGE_DENIED_MSG, `no-flag user creating R -> 403 (got status=${revNone.status}, body=${JSON.stringify(revNone.json)})`);

    // parent not approved/active yet (still draft) -> 409
    const draftParent = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2A2','โครงการทดสอบ phase2 A2',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const draftParentContract = await call(manageUser, 'POST', `/api/customer/projects/${draftParent.rows[0].id}/contracts`, basePayload);
    const PARENT_NOT_ACTIVE_MSG = 'สร้างใบแก้ไขสัญญาได้เฉพาะเมื่อสัญญาหลักอนุมัติแล้วและยังดำเนินอยู่ (active) เท่านั้น';
    const revOnDraftParent = await call(manageUser, 'POST', `/api/customer/contracts/${draftParentContract.json.contract.id}/revisions`, { contractValue: 50000 });
    assert(revOnDraftParent.status === 409 && revOnDraftParent.json.error === PARENT_NOT_ACTIVE_MSG, `creating R on a still-draft parent -> 409 "${PARENT_NOT_ACTIVE_MSG}" (got status=${revOnDraftParent.status}, body=${JSON.stringify(revOnDraftParent.json)})`);

    const rev1 = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 50000, endDate: '2027-12-31' });
    assert(rev1.status === 200 && rev1.json.contract.parentContractId === root2Id, `manage user creates R on an approved+active root -> 200, parentContractId set (got status=${rev1.status}, body=${JSON.stringify(rev1.json)})`);
    assert(rev1.json.contract.revisionNo === null && rev1.json.contract.contractNo === null, `new R has no revisionNo/contractNo yet (issued at submit) (got revisionNo=${rev1.json.contract.revisionNo}, contractNo=${rev1.json.contract.contractNo})`);
    assert(rev1.json.contract.depositPercent === null && rev1.json.contract.retentionPercent === null && rev1.json.contract.paymentTerms === null, `fields not sent in the R payload are normalized to NULL, not inherited/defaulted (got depositPercent=${rev1.json.contract.depositPercent}, retentionPercent=${rev1.json.contract.retentionPercent}, paymentTerms=${rev1.json.contract.paymentTerms})`);
    const rev1Id = rev1.json.contract.id;

    // one-open-revision: a second R while rev1 is still draft -> 409
    const ONE_OPEN_MSG = 'สัญญานี้มีใบแก้ไขที่ยังไม่เสร็จสิ้น (ร่าง/ยื่นแล้ว) อยู่แล้ว ต้องอนุมัติ/ปฏิเสธ/ยกเลิกใบนั้นก่อนจึงเปิดใบใหม่ได้';
    const revDup = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 20000 });
    assert(revDup.status === 409 && revDup.json.error === ONE_OPEN_MSG, `second open R while the first is still draft -> 409 "${ONE_OPEN_MSG}" (got status=${revDup.status}, body=${JSON.stringify(revDup.json)})`);

    // R-of-R guard: can't create a revision whose "parent" is itself a revision
    const revOfRev = await call(manageUser, 'POST', `/api/customer/contracts/${rev1Id}/revisions`, { contractValue: 10000 });
    assert(revOfRev.status === 400 && revOfRev.json.error === 'สร้างใบแก้ไขสัญญาได้เฉพาะจากสัญญาหลักเท่านั้น (ห้ามสร้างใบแก้ไขซ้อนใบแก้ไข)', `creating a "revision of a revision" -> 400 (got status=${revOfRev.status}, body=${JSON.stringify(revOfRev.json)})`);

    // ============================================================================================
    // (4) submit the R — revision_no/contract_no issued correctly
    // ============================================================================================
    console.log('\n=== (4) submit R -> revisionNo=1, contractNo = {root}-R1 ===');
    const revSubmit = await call(manageUser, 'POST', `/api/customer/contracts/${rev1Id}/submit`, {});
    assert(revSubmit.status === 200 && revSubmit.json.contract.revisionNo === 1, `submitting R issues revisionNo=1 (got status=${revSubmit.status}, revisionNo=${revSubmit.json.contract && revSubmit.json.contract.revisionNo})`);
    assert(revSubmit.json.contract.contractNo === `${root2.contract_no}-R1`, `R's contract_no is "{root}-R1" (got ${revSubmit.json.contract.contractNo}, expected ${root2.contract_no}-R1)`);

    // ============================================================================================
    // (5) race check: root terminated between R creation and R submit -> submit must be rejected
    // ============================================================================================
    console.log('\n=== (5) root terminated after an R was created but before it was submitted -> submit rejected ===');
    // rev1 is now 'submitted' — uq_client_contracts_one_open_revision still counts a submitted (not yet
    // approved/rejected/cancelled) R as "open", so it must be closed out via the real cancel endpoint
    // before a second R can be opened (this incidentally also proves cancel works on a submitted R).
    const cancelRev1 = await call(manageUser, 'POST', `/api/customer/contracts/${rev1Id}/cancel`, {});
    assert(cancelRev1.status === 200 && cancelRev1.json.contract.status === 'cancelled', `rev1 (now submitted) cancelled to free the one-open-revision slot (got status=${cancelRev1.status}, contractStatus=${cancelRev1.json.contract && cancelRev1.json.contract.status})`);
    const rev2 = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: -20000 });
    assert(rev2.status === 200, `setup: second R created while root still active (got status=${rev2.status}, body=${JSON.stringify(rev2.json)})`);
    const rev2Id = rev2.json.contract.id;
    await pool.query(`UPDATE client_contracts SET contract_status='terminated' WHERE id=$1`, [root2Id]);
    const PARENT_NOT_ACTIVE_AT_SUBMIT_MSG = 'ยื่นใบแก้ไขสัญญาไม่ได้ เพราะสัญญาหลักไม่ได้อยู่ในสถานะอนุมัติแล้วและดำเนินอยู่ (active) แล้ว ณ ขณะนี้';
    const rev2Submit = await call(manageUser, 'POST', `/api/customer/contracts/${rev2Id}/submit`, {});
    assert(rev2Submit.status === 409 && rev2Submit.json.error === PARENT_NOT_ACTIVE_AT_SUBMIT_MSG, `submitting R after its root was terminated in the meantime -> 409 "${PARENT_NOT_ACTIVE_AT_SUBMIT_MSG}" (got status=${rev2Submit.status}, body=${JSON.stringify(rev2Submit.json)})`);
    // restore root to active so the rest of the test can keep using it
    await pool.query(`UPDATE client_contracts SET contract_status='active' WHERE id=$1`, [root2Id]);

    // (5b) revision_no is NEVER reused — rev1 was revision_no=1 then cancelled; rev2 must get 2, not 1
    // again, proving next_revision_seq only ever moves forward regardless of cancelled revisions
    const rev2SubmitOk = await call(manageUser, 'POST', `/api/customer/contracts/${rev2Id}/submit`, {});
    assert(rev2SubmitOk.status === 200 && rev2SubmitOk.json.contract.revisionNo === 2, `rev2 gets revisionNo=2, not a reused 1, despite rev1 (revision_no=1) being cancelled (got status=${rev2SubmitOk.status}, revisionNo=${rev2SubmitOk.json.contract && rev2SubmitOk.json.contract.revisionNo})`);
    assert(rev2SubmitOk.json.contract.contractNo === `${root2.contract_no}-R2`, `rev2's contract_no is "{root}-R2" (got ${rev2SubmitOk.json.contract.contractNo})`);
    // close rev2 out (now submitted) so the one-open-revision slot is free for section (6) below
    await call(manageUser, 'POST', `/api/customer/contracts/${rev2Id}/cancel`, {});

    // ============================================================================================
    // (6) replay submit of an R with the same Idempotency-Key — same result, next_revision_seq only
    // advances once (the general submit-idempotency already covered the root in section 2; this proves
    // it holds for the R branch of the same endpoint too, which has its own separate counter logic)
    // ============================================================================================
    console.log('\n=== (6) replay submit of an R -> same result, next_revision_seq advances once ===');
    const rev3 = await call(manageUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 5000 });
    assert(rev3.status === 200, `setup: rev3 created on still-active root2 (got status=${rev3.status}, body=${JSON.stringify(rev3.json)})`);
    const rev3Id = rev3.json.contract.id;
    const nextSeqBefore = (await pool.query('SELECT next_revision_seq FROM client_contracts WHERE id=$1', [root2Id])).rows[0].next_revision_seq;
    const rev3Key = 'ctp2-rev3-submit-' + stamp;
    const rev3Submit1 = await call(manageUser, 'POST', `/api/customer/contracts/${rev3Id}/submit`, {}, rev3Key);
    const rev3Submit2 = await call(manageUser, 'POST', `/api/customer/contracts/${rev3Id}/submit`, {}, rev3Key);
    assert(rev3Submit1.status === 200 && rev3Submit2.status === 200 && rev3Submit1.json.contract.revisionNo === rev3Submit2.json.contract.revisionNo && rev3Submit1.json.contract.contractNo === rev3Submit2.json.contract.contractNo, `same Idempotency-Key replayed on R submit -> identical revisionNo/contractNo both times (first=${rev3Submit1.json.contract && rev3Submit1.json.contract.contractNo}, second=${rev3Submit2.json.contract && rev3Submit2.json.contract.contractNo})`);
    const nextSeqAfter = (await pool.query('SELECT next_revision_seq FROM client_contracts WHERE id=$1', [root2Id])).rows[0].next_revision_seq;
    assert(nextSeqAfter - nextSeqBefore === 1, `root's next_revision_seq advanced by exactly 1, not 2, despite two submit calls for the same R (before=${nextSeqBefore}, after=${nextSeqAfter})`);

    // ============================================================================================
    // (7) audit log — exactly one row per real submit, replay does not add a second row
    // ============================================================================================
    console.log('\n=== (7) audit log: one row per submit, replay does not duplicate it ===');
    // root2 also has an 'approve' audit row from section (2) by this point — filter to action='submit'
    // specifically, not just doc_id, so this check is actually about submit's own replay behavior
    const rootAudit = await pool.query(
      `SELECT doc_type, action, from_status, to_status, performed_by FROM client_document_audit_log WHERE company_id=$1 AND doc_type='contract' AND doc_id=$2 AND action='submit'`,
      [companyId, root2Id]
    );
    assert(rootAudit.rowCount === 1, `exactly 1 "submit" audit log row for root2, even though it was replayed with the same Idempotency-Key in section 2 (got ${rootAudit.rowCount})`);
    assert(rootAudit.rows[0].action === 'submit' && rootAudit.rows[0].from_status === 'draft' && rootAudit.rows[0].to_status === 'submitted' && rootAudit.rows[0].performed_by != null, `root2's audit row has the expected action/from_status/to_status/performed_by (got ${JSON.stringify(rootAudit.rows[0])})`);
    const rev3Audit = await pool.query(
      `SELECT doc_type, action, from_status, to_status, performed_by FROM client_document_audit_log WHERE company_id=$1 AND doc_type='contract' AND doc_id=$2 AND action='submit'`,
      [companyId, rev3Id]
    );
    assert(rev3Audit.rowCount === 1, `exactly 1 "submit" audit log row for rev3, even though it was replayed with the same Idempotency-Key just above (got ${rev3Audit.rowCount})`);
    assert(rev3Audit.rows[0].action === 'submit' && rev3Audit.rows[0].from_status === 'draft' && rev3Audit.rows[0].to_status === 'submitted', `rev3's audit row has the expected action/from_status/to_status (got ${JSON.stringify(rev3Audit.rows[0])})`);

    // ============================================================================================
    // (8) create revision (R) — remaining permission/isolation cases not covered in section (3)
    // ============================================================================================
    console.log('\n=== (8) create R: approve-only -> 403, cross-company -> 404 with no row created ===');
    const revApproveOnly = await call(approveUser, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 1000 });
    assert(revApproveOnly.status === 403 && revApproveOnly.json.error === MANAGE_DENIED_MSG, `approve-only user creating R -> 403 (got status=${revApproveOnly.status}, body=${JSON.stringify(revApproveOnly.json)})`);

    const revCountBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM client_contracts WHERE parent_contract_id=$1', [root2Id])).rows[0].n;
    const revCross = await call(superBUsername, 'POST', `/api/customer/contracts/${root2Id}/revisions`, { contractValue: 1000 });
    assert(revCross.status === 404 && revCross.json.error === 'ไม่พบสัญญานี้', `company B creating an R under company A's root -> 404 (got status=${revCross.status}, body=${JSON.stringify(revCross.json)})`);
    const revCountAfter = (await pool.query('SELECT COUNT(*)::int AS n FROM client_contracts WHERE parent_contract_id=$1', [root2Id])).rows[0].n;
    assert(revCountAfter === revCountBefore, `no new revision row was created by the rejected cross-company attempt (before=${revCountBefore}, after=${revCountAfter})`);

    // ============================================================================================
    // (9) R validation error table — every case asserts the exact message, and the "accepted" cases
    // (blank payment terms) assert the stored value, not just a 200
    // ============================================================================================
    console.log('\n=== (9) R validation errors ===');
    // a fresh project+root (approved+active, no open revision) dedicated to this battery of checks
    const projRevErr = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2AREVERR','โครงการทดสอบ R validation',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const rootRevErrCreate = await call(manageUser, 'POST', `/api/customer/projects/${projRevErr.rows[0].id}/contracts`, basePayload);
    const rootRevErrId = rootRevErrCreate.json.contract.id;
    await call(manageUser, 'POST', `/api/customer/contracts/${rootRevErrId}/submit`, {});
    await call(approveUser, 'POST', `/api/customer/contracts/${rootRevErrId}/approve`, {});

    const revErrCases = [
      [{}, 'กรุณาระบุส่วนต่างมูลค่าสัญญา', 'contractValue not sent'],
      [{ contractValue: 0 }, 'กรุณาระบุส่วนต่างมูลค่าสัญญาให้ถูกต้อง (ตัวเลข ไม่เท่ากับ 0)', 'contractValue = 0'],
      [{ contractValue: 'abc' }, 'กรุณาระบุส่วนต่างมูลค่าสัญญาให้ถูกต้อง (ตัวเลข ไม่เท่ากับ 0)', 'contractValue not a number'],
      [{ contractValue: '100.005' }, 'ส่วนต่างมูลค่าสัญญาระบุทศนิยมได้ไม่เกิน 2 ตำแหน่ง', 'contractValue with 3 decimal places'],
      [{ contractValue: '123456789012345670' }, 'ส่วนต่างมูลค่าสัญญาเกินช่วงที่รองรับ (ไม่เกิน 16 หลักก่อนจุดทศนิยม)', 'contractValue with 18 integer digits (exceeds NUMERIC(18,2))'],
      [{ contractValue: 1000, depositPercent: 101 }, 'ระบุเปอร์เซ็นต์เงินมัดจำไม่ถูกต้อง (0-100)', 'depositPercent > 100'],
      [{ contractValue: 1000, retentionPercent: 101 }, 'ระบุเปอร์เซ็นต์เงินประกันผลงานไม่ถูกต้อง (0-100)', 'retentionPercent > 100'],
      [{ contractValue: 1000, startDate: '2026-02-31' }, 'วันที่เริ่มสัญญาไม่ใช่วันที่จริงตามปฏิทิน', 'startDate calendar-invalid (2026-02-31)'],
      [{ contractValue: 1000, startDate: '2027-01-10', endDate: '2027-01-01' }, 'วันที่สิ้นสุดสัญญาต้องไม่ก่อนวันที่เริ่มสัญญา', 'endDate before startDate'],
    ];
    for (const [payload, expectedMsg, label] of revErrCases) {
      const r = await call(manageUser, 'POST', `/api/customer/contracts/${rootRevErrId}/revisions`, payload);
      assert(r.status === 400 && r.json.error === expectedMsg, `R validation: ${label} -> 400 "${expectedMsg}" (got status=${r.status}, body=${JSON.stringify(r.json)})`);
    }
    // blank payment terms is NOT an error — normalized to NULL (not stored as '')
    const revBlankPayment = await call(manageUser, 'POST', `/api/customer/contracts/${rootRevErrId}/revisions`, { contractValue: 1000, paymentTerms: '   ' });
    assert(revBlankPayment.status === 200 && revBlankPayment.json.contract.paymentTerms === null, `R with all-whitespace paymentTerms -> accepted, stored as NULL not '' (got status=${revBlankPayment.status}, paymentTerms=${JSON.stringify(revBlankPayment.json.contract && revBlankPayment.json.contract.paymentTerms)})`);

    // ============================================================================================
    // (10) root contract: contract_value exceeding NUMERIC(18,2) range -> 400, never 500
    // ============================================================================================
    console.log('\n=== (10) root contractValue exceeding NUMERIC(18,2) range -> 400, not 500 ===');
    const projOverflow = await pool.query(`INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTP2AOVERFLOW','โครงการทดสอบ overflow',$2) RETURNING id`, [companyId, custA.rows[0].id]);
    const rootOverflow = await call(manageUser, 'POST', `/api/customer/projects/${projOverflow.rows[0].id}/contracts`, { ...basePayload, contractValue: '123456789012345678' });
    assert(rootOverflow.status === 400 && rootOverflow.json.error === 'มูลค่าสัญญาเกินช่วงที่รองรับ (ไม่เกิน 16 หลักก่อนจุดทศนิยม)', `root contractValue with 18 integer digits -> 400, not 500 (got status=${rootOverflow.status}, body=${JSON.stringify(rootOverflow.json)})`);

    // ============================================================================================
    // (11) PUT edit R draft — success, validation (0 -> 400), permission gate, cross-company 404,
    // and status gate (submitted -> 409) — reuses the draft R created by the blank-payment-terms
    // case in section (9) above, which is still an open draft at this point
    // ============================================================================================
    console.log('\n=== (11) PUT edit R draft ===');
    const putRevId = revBlankPayment.json.contract.id;
    const putRevOk = await call(manageUser, 'PUT', `/api/customer/contracts/${putRevId}`, { contractValue: 2000 });
    assert(putRevOk.status === 200 && Number(putRevOk.json.contract.contractValue) === 2000, `editing an R draft successfully updates its value (got status=${putRevOk.status}, contractValue=${putRevOk.json.contract && putRevOk.json.contract.contractValue})`);

    const putRevZero = await call(manageUser, 'PUT', `/api/customer/contracts/${putRevId}`, { contractValue: 0 });
    assert(putRevZero.status === 400 && putRevZero.json.error === 'กรุณาระบุส่วนต่างมูลค่าสัญญาให้ถูกต้อง (ตัวเลข ไม่เท่ากับ 0)', `editing an R draft with contractValue=0 -> 400 (got status=${putRevZero.status}, body=${JSON.stringify(putRevZero.json)})`);

    const putRevApproveOnly = await call(approveUser, 'PUT', `/api/customer/contracts/${putRevId}`, { contractValue: 3000 });
    assert(putRevApproveOnly.status === 403 && putRevApproveOnly.json.error === MANAGE_DENIED_MSG, `approve-only user editing an R -> 403 (got status=${putRevApproveOnly.status}, body=${JSON.stringify(putRevApproveOnly.json)})`);

    const putRevCross = await call(superBUsername, 'PUT', `/api/customer/contracts/${putRevId}`, { contractValue: 3000 });
    assert(putRevCross.status === 404 && putRevCross.json.error === 'ไม่พบสัญญานี้', `company B editing company A's R -> 404 (got status=${putRevCross.status}, body=${JSON.stringify(putRevCross.json)})`);

    await call(manageUser, 'POST', `/api/customer/contracts/${putRevId}/submit`, {});
    const putRevAfterSubmit = await call(manageUser, 'PUT', `/api/customer/contracts/${putRevId}`, { contractValue: 4000 });
    assert(putRevAfterSubmit.status === 409 && putRevAfterSubmit.json.error === 'แก้ไขได้เฉพาะสถานะร่างเท่านั้น', `editing an R after it has been submitted -> 409 (got status=${putRevAfterSubmit.status}, body=${JSON.stringify(putRevAfterSubmit.json)})`);

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
        // company_document_counters has NO foreign key back to customer_companies at all (confirmed by
        // grepping schema.sql/migrations) — deleting the company does NOT cascade-delete its counter
        // rows, they'd be orphaned forever otherwise (same hygiene class as ข.16, just a different table)
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
