// Regression suite — can_manage_bidding (migration 0033). Covers the security gap found while
// designing this flag: every write endpoint (POST/PUT/DELETE) under /api/customer/projects/*,
// /api/customer/tenders/*, /api/customer/budgets/*, /api/customer/quotations/* had ONLY
// requireCustomerAuth before this — no role/permission check at all server-side (the super_user-only
// restriction was purely a frontend nav-hiding trick). This suite proves all 24 identified endpoints
// now reject a plain 'maker' with 403, that granting/revoking the flag via the existing generic
// permission-flags mechanism actually takes effect (full round-trip), that super_user always bypasses
// it, that GET/read endpoints stay open to everyone (unchanged), and that can_approve_budget stays
// completely independent (granting can_manage_bidding does NOT also grant budget-approval power).
//
// Prerequisites: dev server running, migration 0033 applied. Run:
// cd server && node tests/bidding-manage-permission.regression.js
const pool = require('../db');
const { setup, COMPANY_A_ID, PASSWORD } = require('./fixtures/setup-approval-fixtures');

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
  return { status: res.status, json };
}
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}

// ทั้ง 24 endpoint ที่สำรวจพบว่าไม่เคยเช็คสิทธิ์ฝั่งเซิร์ฟเวอร์เลยมาก่อน — ใช้ id ปลอม (1) ได้ เพราะ
// requireCanManageBidding อยู่ก่อนตัว handler เสมอ จะ 403 ก่อนที่จะมีการ query หาแถวจริงด้วยซ้ำ
const PROTECTED_ENDPOINTS = [
  ['POST', '/api/customer/projects'],
  ['PUT', '/api/customer/projects/1/tasks/periods'],
  ['POST', '/api/customer/projects/1/tasks'],
  ['POST', '/api/customer/projects/1/tasks/batch'],
  ['PUT', '/api/customer/projects/1/tasks/reorder'],
  ['PUT', '/api/customer/projects/1/tasks/1'],
  ['DELETE', '/api/customer/projects/1/tasks/1'],
  ['POST', '/api/customer/projects/1/tasks/dependencies'],
  ['DELETE', '/api/customer/projects/1/tasks/dependencies/1'],
  ['POST', '/api/customer/projects/1/tasks/set-baseline'],
  ['POST', '/api/customer/tenders'],
  ['PUT', '/api/customer/tenders/1'],
  ['POST', '/api/customer/tenders/1/status'],
  ['POST', '/api/customer/budgets'],
  ['POST', '/api/customer/budgets/1/boq-preview'],
  ['POST', '/api/customer/budgets/1/boq-inspect'],
  ['POST', '/api/customer/budgets/1/boq-preview-mapped'],
  ['POST', '/api/customer/budgets/1/import-boq'],
  ['PUT', '/api/customer/budgets/1/items'],
  ['POST', '/api/customer/budgets/1/submit'],
  ['POST', '/api/customer/budgets/1/revise'],
  ['POST', '/api/customer/quotations'],
  ['PUT', '/api/customer/quotations/1/status'],
  ['DELETE', '/api/customer/quotations/1'],
];

(async () => {
  const cleanup = { projectIds: [], tenderIds: [], budgetIds: [], quotationIds: [] };
  try {
    console.log('Ensuring fixtures...');
    const { clientCustomerId } = await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    await login('fx_super', codeA);
    await login('fx_maker2', codeA);
    const fxMaker2Row = (await pool.query(`SELECT id FROM customers WHERE username='fx_maker2' AND company_id=$1`, [COMPANY_A_ID])).rows[0];

    // ============================================================================================
    // (1) ทั้ง 24 endpoint ปฏิเสธ fx_maker2 (ไม่มี can_manage_bidding) ด้วย 403
    // ============================================================================================
    console.log(`\n=== (1) fx_maker2 (ไม่มี can_manage_bidding) โดนบล็อกทั้ง ${PROTECTED_ENDPOINTS.length} endpoint ===`);
    for (const [method, urlPath] of PROTECTED_ENDPOINTS) {
      const r = await call('fx_maker2', method, urlPath, {});
      assert(r.status === 403, `${method} ${urlPath} -> 403 สำหรับ fx_maker2 (ได้ ${r.status}, body=${JSON.stringify(r.json)})`);
    }

    // ============================================================================================
    // (2) GET/read endpoints ยังเปิดให้ fx_maker2 เข้าถึงได้ปกติ (ไม่ถูกแตะโดยงานนี้)
    // ============================================================================================
    console.log('\n=== (2) GET endpoints ยังเปิดให้ fx_maker2 เหมือนเดิม ===');
    const getProjects = await call('fx_maker2', 'GET', '/api/customer/projects');
    assert(getProjects.status === 200, `GET /api/customer/projects ยังเปิดให้ fx_maker2 (ได้ ${getProjects.status})`);
    const getTenders = await call('fx_maker2', 'GET', '/api/customer/tenders');
    assert(getTenders.status === 200, `GET /api/customer/tenders ยังเปิดให้ fx_maker2 (ได้ ${getTenders.status})`);
    const getQuotations = await call('fx_maker2', 'GET', '/api/customer/quotations');
    assert(getQuotations.status === 200, `GET /api/customer/quotations ยังเปิดให้ fx_maker2 (ได้ ${getQuotations.status})`);

    // ============================================================================================
    // (3) มอบสิทธิ์ can_manage_bidding ให้ fx_maker2 -> ทำงานจริงได้ทั้ง Project/Tender/Budget/Quotation
    // ============================================================================================
    console.log('\n=== (3) มอบสิทธิ์ can_manage_bidding -> fx_maker2 ทำงานจริงได้ ===');
    await call('fx_super', 'PUT', `/api/customer/users/${fxMaker2Row.id}/permission-flags`, { column: 'can_manage_bidding', value: true });

    const project = await call('fx_maker2', 'POST', '/api/customer/projects', {
      name: `โครงการทดสอบ can_manage_bidding ${Date.now()}`, customerId: clientCustomerId, sectorType: 'private', budget: 100000,
    });
    assert(project.status === 200 && project.json.project && project.json.project.id, `fx_maker2 สร้างโครงการได้จริงหลังได้รับสิทธิ์ (ได้ status=${project.status}, body=${JSON.stringify(project.json)})`);
    cleanup.projectIds.push(project.json.project.id);

    const tender = await call('fx_maker2', 'POST', '/api/customer/tenders', {
      name: `ประมูลทดสอบ can_manage_bidding ${Date.now()}`, customerId: clientCustomerId, sectorType: 'private', estimatedValue: 50000,
    });
    assert(tender.status === 200 && tender.json.tender && tender.json.tender.id, `fx_maker2 สร้างประมูลงานได้จริง (ได้ status=${tender.status}, body=${JSON.stringify(tender.json)})`);
    cleanup.tenderIds.push(tender.json.tender.id);

    const tenderStatus = await call('fx_maker2', 'POST', `/api/customer/tenders/${tender.json.tender.id}/status`, { status: 'submitted' });
    assert(tenderStatus.status === 200, `fx_maker2 เปลี่ยนสถานะประมูลงานได้จริง (ได้ status=${tenderStatus.status}, body=${JSON.stringify(tenderStatus.json)})`);

    const budget = await call('fx_maker2', 'POST', '/api/customer/budgets', { tenderId: tender.json.tender.id });
    if (budget.status === 200 && budget.json.budget) {
      cleanup.budgetIds.push(budget.json.budget.id);
      assert(true, `fx_maker2 สร้างงบประมาณได้จริง (ได้ id=${budget.json.budget.id})`);
    } else {
      // ไม่ assert fail ตรงนี้ถ้า business-logic validation อื่น (ไม่เกี่ยวกับสิทธิ์) ปฏิเสธ — จุดสำคัญคือ
      // ไม่ใช่ 403 (พิสูจน์ว่าผ่านด่านสิทธิ์ไปแล้วจริง)
      assert(budget.status !== 403, `fx_maker2 ไม่โดนบล็อกด้วยเหตุผลด้านสิทธิ์ตอนสร้างงบประมาณ (ได้ status=${budget.status}, body=${JSON.stringify(budget.json)})`);
    }

    const quotation = await call('fx_maker2', 'POST', '/api/customer/quotations', {
      customerId: null, amount: 1000, status: 'draft',
    });
    // ยอมรับทั้ง 200 (ถ้า validation อื่นผ่านพอดี) และ 400 (ถ้าขาด field ที่ไม่เกี่ยวกับสิทธิ์ เช่น customerId
    // บังคับ) — จุดสำคัญคือต้องไม่ใช่ 403
    assert(quotation.status !== 403, `fx_maker2 ไม่โดนบล็อกด้วยเหตุผลด้านสิทธิ์ตอนสร้างใบเสนอราคา (ได้ status=${quotation.status}, body=${JSON.stringify(quotation.json)})`);
    if (quotation.status === 200 && quotation.json.quotation) cleanup.quotationIds.push(quotation.json.quotation.id);

    // ============================================================================================
    // (4) can_approve_budget เป็นอิสระจาก can_manage_bidding โดยสิ้นเชิง — มี can_manage_bidding อย่างเดียว
    // อนุมัติงบประมาณไม่ได้ (ต้องมี can_approve_budget แยกต่างหากเท่านั้น ตาม CLAUDE.md ข้อ 14)
    // ============================================================================================
    console.log('\n=== (4) can_manage_bidding ไม่ได้แปลว่าอนุมัติงบประมาณได้ (คนละสิทธิ์กัน) ===');
    if (cleanup.budgetIds.length) {
      const approveAttempt = await call('fx_maker2', 'POST', `/api/customer/budgets/${cleanup.budgetIds[0]}/approve`, {});
      assert(approveAttempt.status === 403, `fx_maker2 มี can_manage_bidding แต่ไม่มี can_approve_budget -> อนุมัติงบประมาณไม่ได้ 403 (ได้ ${approveAttempt.status})`);
    } else {
      console.log('  (ข้าม — ไม่มีงบประมาณที่สร้างสำเร็จจากขั้นตอนก่อนหน้าให้ทดสอบ)');
    }

    // ============================================================================================
    // (5) ถอนสิทธิ์คืน -> กลับไปโดนบล็อก 403 เหมือนเดิม (round-trip เต็มรูปแบบ)
    // ============================================================================================
    console.log('\n=== (5) ถอนสิทธิ์ can_manage_bidding คืน -> กลับไป 403 ===');
    await call('fx_super', 'PUT', `/api/customer/users/${fxMaker2Row.id}/permission-flags`, { column: 'can_manage_bidding', value: false });
    const deniedAfterRevoke = await call('fx_maker2', 'POST', '/api/customer/projects', { name: 'x' });
    assert(deniedAfterRevoke.status === 403, `ถอนสิทธิ์คืนแล้ว fx_maker2 สร้างโครงการไม่ได้อีก 403 เหมือนเดิม (ได้ ${deniedAfterRevoke.status})`);

    // ============================================================================================
    // (6) super_user (fx_super) ทำได้เสมอไม่ว่า flag จะเป็นอะไร — ไม่ต้องมี can_manage_bidding เลย
    // ============================================================================================
    console.log('\n=== (6) super_user ทำได้เสมอโดยไม่ต้องมี flag ===');
    const superProject = await call('fx_super', 'POST', '/api/customer/projects', {
      name: `โครงการทดสอบ super_user ${Date.now()}`, customerId: clientCustomerId, sectorType: 'private', budget: 100000,
    });
    assert(superProject.status === 200, `fx_super (super_user) สร้างโครงการได้โดยไม่ต้องมี can_manage_bidding (ได้ status=${superProject.status})`);
    if (superProject.status === 200) cleanup.projectIds.push(superProject.json.project.id);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      if (cleanup.quotationIds.length) await pool.query('DELETE FROM client_quotations WHERE id = ANY($1)', [cleanup.quotationIds]);
      if (cleanup.budgetIds.length) {
        await pool.query('DELETE FROM client_budget_items WHERE budget_id = ANY($1)', [cleanup.budgetIds]).catch(()=>{});
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id = ANY($1)', [cleanup.budgetIds]).catch(()=>{});
        await pool.query('DELETE FROM client_budgets WHERE id = ANY($1)', [cleanup.budgetIds]).catch(()=>{});
      }
      if (cleanup.tenderIds.length) await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [cleanup.tenderIds]).catch(()=>{});
      if (cleanup.projectIds.length) await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [cleanup.projectIds]).catch(()=>{});
      await pool.query(`UPDATE customers SET can_manage_bidding=false WHERE username='fx_maker2' AND company_id=$1`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
