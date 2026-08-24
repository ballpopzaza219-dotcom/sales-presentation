// Regression suite — Purchase Request module (หัวข้อ 4: ใบขอซื้อ).
// Covers: cross-company 404, self-approval block, no_permission/no_rule/over_ceiling/approve-success,
// idempotency retry (submit), and a real concurrent-request race on item consume (qty_remaining).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres. Fixtures (fx_* accounts + client_pr_approval_rules) are created/verified automatically at
// the top of the run via tests/fixtures/setup-approval-fixtures.js — safe to run cold on a fresh DB.
// Run: cd server && node tests/pr.regression.js  (or: npm run test:pr)
const pool = require('../db');
const { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const PROJECT_ID = 7; // PRJ-2569-0001 — see tests/README.md

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {}; // username -> cookie string, one session per fixture user (avoid re-login churn)
async function call(username, method, urlPath, body, idempotencyKey) {
  const headers = { Cookie: cookies[username] || '', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[username] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function callExpectError(username, method, urlPath, body, idempotencyKey) {
  try { await call(username, method, urlPath, body, idempotencyKey); throw new Error(`expected ${method} ${urlPath} (as ${username}) to fail but it succeeded`); }
  catch (e) { if (e.status === undefined) throw e; return e; }
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}
function idemKey(label) { return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function makeDraftPr(username, itemsQty = [{ material: 'ปูนซีเมนต์', unit: 'ถุง', qtyRequested: 10, unitPrice: 150 }]) {
  const data = await call(username, 'POST', '/api/customer/purchase-requests', {
    projectId: PROJECT_ID, source: 'manual', neededDate: null, note: 'regression test',
    items: itemsQty,
  }, idemKey('pr-create'));
  return data.purchaseRequest;
}

(async () => {
  const createdPrIds = [];
  const createdPoIds = [];
  try {
    console.log('Ensuring fixtures...');
    await setup();

    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const companyBRes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_B_ID]);
    const codeA = companyARes.rows[0].code;
    const codeB = companyBRes.rows[0].code;

    await login('fx_maker', codeA);
    await login('fx_maker2', codeA);
    await login('fx_approver_mid', codeA);
    await login('fx_approver_floor', codeA);
    await login('fx_approver_norule', codeA);
    await login('fx_super', codeA);
    await login('fx_other_co', codeB);

    // ================= 1) สร้าง + ยื่น PR ปกติ =================
    let pr = await makeDraftPr('fx_maker');
    createdPrIds.push(pr.id);
    assert(pr.status === 'draft', 'สร้าง PR draft สำเร็จ');

    const submitKey = idemKey('pr-submit');
    const submitted1 = await call('fx_maker', 'POST', `/api/customer/purchase-requests/${pr.id}/submit`, {}, submitKey);
    assert(submitted1.purchaseRequest.status === 'submitted', 'ยื่น PR สำเร็จ (draft -> submitted)');
    assert(!!submitted1.purchaseRequest.prNo || !!submitted1.purchaseRequest.pr_no, 'ได้เลขที่เอกสารตอน submit');

    // ================= 2) Idempotency retry: ยิง submit ซ้ำด้วย key เดิม =================
    const submitted2 = await call('fx_maker', 'POST', `/api/customer/purchase-requests/${pr.id}/submit`, {}, submitKey);
    const prNo1 = submitted1.purchaseRequest.prNo || submitted1.purchaseRequest.pr_no;
    const prNo2 = submitted2.purchaseRequest.prNo || submitted2.purchaseRequest.pr_no;
    assert(prNo2 === prNo1, `retry submit ด้วย Idempotency-Key เดิม ได้เลขที่เอกสารเดิมเป๊ะ ไม่ออกเลขใหม่ซ้ำ (ได้ ${prNo1} / ${prNo2})`);
    const auditCountRes = await pool.query(
      `SELECT count(*)::int AS n FROM client_document_audit_log WHERE doc_type='purchase_request' AND doc_id=$1 AND action='submit'`,
      [pr.id]
    );
    assert(auditCountRes.rows[0].n === 1, `retry ไม่สร้าง audit log ซ้ำ (ยังมีแค่ 1 แถว action='submit' ได้ ${auditCountRes.rows[0].n})`);

    // ================= 3) Cross-company 404 =================
    const eCrossView = await callExpectError('fx_other_co', 'GET', `/api/customer/purchase-requests/${pr.id}`);
    assert(eCrossView.status === 404, `บริษัทอื่นดู PR ไม่ได้ 404 (ได้ ${eCrossView.status})`);
    const eCrossApprove = await callExpectError('fx_other_co', 'POST', `/api/customer/purchase-requests/${pr.id}/approve`, {}, idemKey('pr-approve-cross'));
    assert(eCrossApprove.status === 404, `บริษัทอื่นอนุมัติ PR ไม่ได้ 404 (ได้ ${eCrossApprove.status})`);

    // ================= 4) no_permission / no_rule / over_ceiling / approve success =================
    const eNoPerm = await callExpectError('fx_maker2', 'POST', `/api/customer/purchase-requests/${pr.id}/approve`, {}, idemKey('pr-approve'));
    assert(eNoPerm.status === 403 && eNoPerm.body.code === 'no_permission', `ไม่มี flag can_approve_pr เลย -> no_permission (ได้ code ${eNoPerm.body.code})`);

    const eNoRule = await callExpectError('fx_approver_norule', 'POST', `/api/customer/purchase-requests/${pr.id}/approve`, {}, idemKey('pr-approve'));
    assert(eNoRule.status === 403 && eNoRule.body.code === 'no_rule', `มี flag แต่ไม่มี rule -> no_rule (ได้ code ${eNoRule.body.code})`);

    // PR ยอด 1500 (10 x 150) อยู่ในเพดาน fx_approver_mid (0-50000) -> approve ผ่าน
    const approveOk = await call('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${pr.id}/approve`, {}, idemKey('pr-approve'));
    assert(approveOk.purchaseRequest.status === 'approved', 'อนุมัติสำเร็จภายในเพดาน (1,500 บาท อยู่ในช่วง 0-50,000)');

    // over_ceiling: PR ยอดเกิน 50,000 (100 x 600 = 60,000)
    let prBig = await makeDraftPr('fx_maker', [{ material: 'เหล็กเส้น', unit: 'เส้น', qtyRequested: 100, unitPrice: 600 }]);
    createdPrIds.push(prBig.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-requests/${prBig.id}/submit`, {}, idemKey('pr-submit'));
    const eOverCeiling = await callExpectError('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${prBig.id}/approve`, {}, idemKey('pr-approve'));
    assert(eOverCeiling.status === 403 && eOverCeiling.body.code === 'over_ceiling', `ยอด 60,000 เกินเพดาน 50,000 -> over_ceiling (ได้ code ${eOverCeiling.body.code})`);
    // fx_approver_floor มีเพดาน 10,000-200,000 -> ผ่าน
    const approveFloorOk = await call('fx_approver_floor', 'POST', `/api/customer/purchase-requests/${prBig.id}/approve`, {}, idemKey('pr-approve'));
    assert(approveFloorOk.purchaseRequest.status === 'approved', 'ผู้อนุมัติอีกคนที่เพดานสูงกว่าอนุมัติยอดเดียวกันได้');

    // under_floor: fx_approver_floor เพดานขั้นต่ำ 10,000 — PR ยอด 1,500 ต่ำกว่าขั้นต่ำ
    let prSmall = await makeDraftPr('fx_maker', [{ material: 'ตะปู', unit: 'กล่อง', qtyRequested: 3, unitPrice: 100 }]);
    createdPrIds.push(prSmall.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-requests/${prSmall.id}/submit`, {}, idemKey('pr-submit'));
    const eUnderFloor = await callExpectError('fx_approver_floor', 'POST', `/api/customer/purchase-requests/${prSmall.id}/approve`, {}, idemKey('pr-approve'));
    assert(eUnderFloor.status === 403 && eUnderFloor.body.code === 'under_floor', `ยอด 300 ต่ำกว่าขั้นต่ำ 10,000 ของ fx_approver_floor -> under_floor (ได้ code ${eUnderFloor.body.code})`);

    // ================= 5) Self-approval block (ผู้สร้าง = ผู้มีสิทธิ์อนุมัติ) =================
    let prSelf = await makeDraftPr('fx_approver_mid', [{ material: 'สี', unit: 'ถัง', qtyRequested: 2, unitPrice: 500 }]);
    createdPrIds.push(prSelf.id);
    await call('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${prSelf.id}/submit`, {}, idemKey('pr-submit'));
    const eSelfApprove = await callExpectError('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${prSelf.id}/approve`, {}, idemKey('pr-approve'));
    assert(eSelfApprove.status === 403 && eSelfApprove.body.code === 'self_approval', `ผู้สร้างอนุมัติเอกสารตัวเองไม่ได้ แม้จะมีสิทธิ์อนุมัติเต็มก็ตาม (ได้ code ${eSelfApprove.body.code})`);
    // super_user ก็ต้องโดนบล็อกด้วยเหมือนกัน (ไม่มีข้อยกเว้น ตามที่ระบุใน canApprove ข้อ 0)
    let prSelfSuper = await makeDraftPr('fx_super', [{ material: 'ไม้แบบ', unit: 'แผ่น', qtyRequested: 5, unitPrice: 200 }]);
    createdPrIds.push(prSelfSuper.id);
    await call('fx_super', 'POST', `/api/customer/purchase-requests/${prSelfSuper.id}/submit`, {}, idemKey('pr-submit'));
    const eSelfApproveSuper = await callExpectError('fx_super', 'POST', `/api/customer/purchase-requests/${prSelfSuper.id}/approve`, {}, idemKey('pr-approve'));
    assert(eSelfApproveSuper.status === 403 && eSelfApproveSuper.body.code === 'self_approval', `super_user ก็อนุมัติเอกสารตัวเองไม่ได้เช่นกัน ไม่มีข้อยกเว้น (ได้ code ${eSelfApproveSuper.body.code})`);

    // ================= 6) Concurrent race: consume item เกินยอดคงเหลือพร้อมกัน 2 คำขอ =================
    let prConcurrent = await makeDraftPr('fx_maker', [{ material: 'อิฐมอญ', unit: 'ก้อน', qtyRequested: 100, unitPrice: 5 }]);
    createdPrIds.push(prConcurrent.id);
    await call('fx_maker', 'POST', `/api/customer/purchase-requests/${prConcurrent.id}/submit`, {}, idemKey('pr-submit'));
    const approvedConcurrent = await call('fx_approver_mid', 'POST', `/api/customer/purchase-requests/${prConcurrent.id}/approve`, {}, idemKey('pr-approve'));
    const itemId = approvedConcurrent.purchaseRequest.items[0].id;

    const poNo = 'PO-SMOKE-' + Date.now();
    const poIns = await pool.query(
      `INSERT INTO client_purchase_orders (company_id, po_no, supplier_name, status) VALUES ($1,$2,'Smoke Supplier','approved') RETURNING id`,
      [COMPANY_A_ID, poNo]
    );
    const poId = poIns.rows[0].id;
    createdPoIds.push(poId);

    // ยิง 2 คำขอ consume qty=60 พร้อมกันจริง (Promise.all) บนยอดคงเหลือ 100 — รวมกัน 120 > 100 ต้องมีแค่
    // ฝั่งเดียวผ่าน (has_enough เช็คด้วย SELECT...FOR UPDATE ก่อนเสมอ ไม่ใช่แค่ทฤษฎี ต้องพิสูจน์จริง)
    const results = await Promise.allSettled([
      call('fx_super', 'POST', `/api/customer/purchase-requests/${prConcurrent.id}/items/${itemId}/consume`, { qty: 60, poId }, idemKey('consume-a')),
      call('fx_super', 'POST', `/api/customer/purchase-requests/${prConcurrent.id}/items/${itemId}/consume`, { qty: 60, poId }, idemKey('consume-b')),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert(fulfilled.length === 1, `consume พร้อมกัน 2 คำขอ (60+60 เกินยอด 100) — สำเร็จแค่ 1 คำขอจริง (ได้ ${fulfilled.length})`);
    assert(rejected.length === 1, `อีกคำขอถูกปฏิเสธจริง (เกินยอดคงเหลือ) (ได้ ${rejected.length} rejected)`);

    const itemAfter = await pool.query('SELECT qty_ordered, qty_remaining FROM client_purchase_request_items WHERE id=$1', [itemId]);
    assert(Number(itemAfter.rows[0].qty_ordered) === 60, `qty_ordered หลัง race มีค่า 60 พอดี (ไม่ใช่ 120 หรือ lost-update) ได้ ${itemAfter.rows[0].qty_ordered}`);
    assert(Number(itemAfter.rows[0].qty_remaining) === 40, `qty_remaining เหลือ 40 ถูกต้อง (100-60) ได้ ${itemAfter.rows[0].qty_remaining}`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdPrIds.length) {
        await pool.query(`DELETE FROM client_purchase_request_item_adjustments WHERE pr_item_id IN (SELECT id FROM client_purchase_request_items WHERE purchase_request_id = ANY($1))`, [createdPrIds]);
        await pool.query('DELETE FROM client_purchase_request_items WHERE purchase_request_id = ANY($1)', [createdPrIds]);
        await pool.query('DELETE FROM client_document_audit_log WHERE doc_type=\'purchase_request\' AND doc_id = ANY($1)', [createdPrIds]);
        await pool.query('DELETE FROM client_purchase_requests WHERE id = ANY($1)', [createdPrIds]);
      }
      if (createdPoIds.length) {
        await pool.query('DELETE FROM client_purchase_orders WHERE id = ANY($1)', [createdPoIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'pr-%' OR idempotency_key LIKE 'consume-%'`, [COMPANY_A_ID]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
