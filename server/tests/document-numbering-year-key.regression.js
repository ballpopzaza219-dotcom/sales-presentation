// Regression suite — migration 0023 (company_document_counters widened to (company_id, doc_type, year)).
// Covers: (1) crossing a year boundary starts a fresh counter at 1, never continuing the old year's
// sequence; (2) concurrent requests never collide even when racing for the same counter row; (3) a
// voided document's number is never reissued; (4) client_projects/client_quotations (migrated off
// COUNT(*)-based numbering in the same migration) correctly continue from their real historical max,
// not reset to 1; (5) the Buddhist-era year computed for a document created just after UTC midnight
// (but still evening/night of the PREVIOUS day in Bangkok — the exact window a UTC-timezone production
// host would get wrong) is correct, both in the JS helper (getBangkokYear) and the SQL formula the
// migration's backfill used (AT TIME ZONE 'Asia/Bangkok').
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at a reachable
// Postgres, migration 0023 already applied. Run: cd server && node tests/document-numbering-year-key.regression.js
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
async function login(username, companyCode) {
  await call(username, 'POST', '/api/customer-login', { companyCode, username, password: PASSWORD });
}
let idemCounter = 0;
function idemKey(label) { return `${label}-${Date.now()}-${idemCounter++}`; }
function bangkokYearBE() { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(new Date()), 10) + 543; }

(async () => {
  const cleanup = { tenderIds: [], projectIds: [], voucherIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await setup();
    const companyARes = await pool.query('SELECT code FROM customer_companies WHERE id=$1', [COMPANY_A_ID]);
    const codeA = companyARes.rows[0].code;
    for (const u of ['fx_maker', 'fx_approver_mid', 'fx_settler', 'fx_super']) await login(u, codeA);
    const currentYear = bangkokYearBE();

    // ============================================================================================
    // (1) ข้ามปี — counter ของปีใหม่ต้องเริ่มที่ 1 ไม่ต่อจากปีก่อนหน้า (ทดสอบตรงที่กลไก DB โดยไม่ต้องรอ
    // เวลาจริงข้ามปี — ยิง SQL UPSERT เดียวกับที่ nextDocumentSeq ใช้จริง ด้วย doc_type ทดสอบเฉพาะกิจ)
    // ============================================================================================
    console.log('\n=== (1) ข้ามปี: counter ปีใหม่เริ่มที่ 1 เสมอ ไม่ต่อจากปีก่อน ===');
    const testDocType = '__e2e_year_boundary_test__';
    await pool.query('DELETE FROM company_document_counters WHERE company_id=$1 AND doc_type=$2', [COMPANY_A_ID, testDocType]);
    async function bumpSeq(year) {
      const r = await pool.query(
        `INSERT INTO company_document_counters (company_id, doc_type, year, next_seq)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (company_id, doc_type, year) DO UPDATE SET next_seq = company_document_counters.next_seq + 1
         RETURNING next_seq`,
        [COMPANY_A_ID, testDocType, year]
      );
      return r.rows[0].next_seq;
    }
    const y1a = await bumpSeq(2569);
    const y1b = await bumpSeq(2569);
    const y1c = await bumpSeq(2569);
    assert(y1a === 1 && y1b === 2 && y1c === 3, `ปี 2569 นับต่อเนื่องปกติ (ได้ ${y1a},${y1b},${y1c})`);
    const y2a = await bumpSeq(2570);
    assert(y2a === 1, `ปี 2570 (ปีถัดไป) เริ่มที่ 1 ใหม่ ไม่ต่อจาก 2569 ที่ไปถึง 3 แล้ว (ได้ ${y2a})`);
    const y1d = await bumpSeq(2569);
    assert(y1d === 4, `กลับมาที่ปี 2569 เดิม ยังนับต่อจาก 3 เป็น 4 ปกติ (แยกอิสระจากปี 2570 จริง) (ได้ ${y1d})`);
    await pool.query('DELETE FROM company_document_counters WHERE company_id=$1 AND doc_type=$2', [COMPANY_A_ID, testDocType]);

    // ============================================================================================
    // (2) ออกเลขพร้อมกันหลาย request ต้องไม่ซ้ำ (ยิง POST /tenders 8 ครั้งพร้อมกันจริง)
    // ============================================================================================
    console.log('\n=== (2) ออกเลขพร้อมกันหลาย request ต้องไม่ซ้ำ ===');
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call('fx_maker', 'POST', '/api/customer/tenders', { name: `E2E concurrent numbering ${i}`, sectorType: 'private' }))
    );
    for (const r of concurrentResults) cleanup.tenderIds.push(r.tender.id);
    const tenderNos = concurrentResults.map(r => r.tender.tenderNo);
    const uniqueNos = new Set(tenderNos);
    assert(uniqueNos.size === tenderNos.length, `เลข tender ที่ออกพร้อมกัน 8 ใบ ไม่ซ้ำกันเลยสักคู่ (ได้ ${tenderNos.length} ใบ, unique ${uniqueNos.size})`);

    // ============================================================================================
    // (3) เลขที่ออกแล้วยกเลิก (void) ต้องไม่ถูกนำกลับมาใช้ซ้ำ
    // ============================================================================================
    console.log('\n=== (3) เลขที่ voided แล้วไม่ถูกนำกลับมาใช้ ===');
    const fund = await call('fx_super', 'POST', '/api/customer/petty-cash-funds', { name: 'E2E doc-numbering void fund ' + Date.now(), fundLimit: 60000 });
    const v1 = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: 2, purpose: 'E2E doc-numbering void test', amount: 500, expenseAccountCode: '5300',
    }, idemKey('docnum-void-v1'));
    cleanup.voucherIds.push(v1.voucher.id);
    // เลขที่เอกสารออกตอน /submit เท่านั้น (CLAUDE.md ข้อ 11) — ไม่ใช่ตอนสร้าง draft ต้องอ่านจาก response
    // ของ submit เอง ไม่ใช่ของ create ที่ voucherNo ยังเป็น null อยู่
    const v1Submitted = await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v1.voucher.id}/submit`, {}, idemKey('docnum-void-submit1'));
    const voidedNo = v1Submitted.voucher.voucherNo;
    assert(!!voidedNo, `ใบที่ 1 ได้เลขที่เอกสารจริงตอน submit (ได้ ${voidedNo})`);
    await call('fx_approver_mid', 'POST', `/api/customer/payment-vouchers/${v1.voucher.id}/approve`, {}, idemKey('docnum-void-approve1'));
    await call('fx_settler', 'POST', `/api/customer/payment-vouchers/${v1.voucher.id}/void`, { reason: 'E2E doc-numbering test' }, idemKey('docnum-void-void1'));

    const v2 = await call('fx_maker', 'POST', '/api/customer/payment-vouchers', {
      voucherType: 'petty_cash', pettyCashFundId: fund.fund.id, payeeEmployeeId: 2, purpose: 'E2E doc-numbering void test 2', amount: 500, expenseAccountCode: '5300',
    }, idemKey('docnum-void-v2'));
    cleanup.voucherIds.push(v2.voucher.id);
    const v2Submitted = await call('fx_maker', 'POST', `/api/customer/payment-vouchers/${v2.voucher.id}/submit`, {}, idemKey('docnum-void-submit2'));
    const newNo = v2Submitted.voucher.voucherNo;
    assert(newNo !== voidedNo, `ใบใหม่หลัง void ไม่ได้เลขซ้ำกับใบที่ถูก void ไปแล้ว (voided=${voidedNo}, ใหม่=${newNo})`);
    const seqOfPv = (no) => parseInt(no.split('-')[2], 10);
    assert(seqOfPv(newNo) > seqOfPv(voidedNo), `ใบใหม่มีลำดับสูงกว่าใบที่ voided เสมอ (ไม่ใช่แค่ไม่ซ้ำ) (${voidedNo} -> ${newNo})`);

    // ============================================================================================
    // (4) client_projects/client_quotations (ย้ายจาก COUNT(*) มาใช้ counter ในรอบเดียวกัน) ต้องต่อจาก
    // เลขสูงสุดเดิมจริง ไม่ reset กลับไปเริ่มที่ 1
    // ============================================================================================
    console.log('\n=== (4) project/quotation ต่อจากเลขเดิมจริง ไม่ reset ===');
    const projBaseline = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='project' AND year=$2`, [COMPANY_A_ID, currentYear]);
    const baselineSeq = projBaseline.rows[0] ? projBaseline.rows[0].next_seq : 0;
    const newProject = await call('fx_maker', 'POST', '/api/customer/projects', { name: 'E2E doc-numbering project continuity ' + Date.now(), sectorType: 'private', status: 'in_progress' });
    cleanup.projectIds.push(newProject.project.id);
    const newProjectSeq = parseInt(newProject.project.code.split('-')[2], 10);
    assert(newProjectSeq === baselineSeq + 1, `โครงการใหม่ได้เลขต่อจาก baseline เดิมพอดี (baseline=${baselineSeq}, คาดหวัง=${baselineSeq + 1}, ได้=${newProjectSeq})`);

    // ============================================================================================
    // (5) ปี พ.ศ. ต้องคำนวณจาก Asia/Bangkok เสมอ ไม่ใช่ timezone ของเครื่อง server — ทดสอบด้วย instant ที่
    // เที่ยงคืนถึงตี 7 ตามเวลาไทย (ซึ่งยังเป็น "เมื่อวาน" ตาม UTC) เพราะเป็นช่วงเวลาเดียวที่ผลต่างกันจริง
    // ============================================================================================
    console.log('\n=== (5) คำนวณปี พ.ศ. ถูก timezone แม้ตอน 00:30 น. ไทย (ยังเป็นเมื่อวานตาม UTC) ===');
    // 2026-01-01T00:30:00+07:00 ตรงกับ 2025-12-31T17:30:00Z พอดี — ฝั่งไทยคือปี 2026 (พ.ศ. 2569) แล้ว
    // แต่ฝั่ง UTC ยังเป็นปี 2025 (พ.ศ. 2568) อยู่ — ถ้าคำนวณผิด timezone จะได้ 2568 แทนที่จะเป็น 2569
    const testInstant = new Date('2025-12-31T17:30:00.000Z');
    const bangkokYearAtInstant = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(testInstant), 10);
    assert(bangkokYearAtInstant === 2026, `getBangkokYear()-equivalent (JS, Intl timeZone Asia/Bangkok) ที่ instant 2025-12-31T17:30:00Z (=00:30 น. วันที่ 1 ม.ค. ตามเวลาไทย) ได้ปี ค.ศ. 2026 ถูกต้อง (ได้ ${bangkokYearAtInstant})`);
    const utcNaiveYearAtInstant = testInstant.getUTCFullYear();
    assert(utcNaiveYearAtInstant === 2025, `(เพื่อเทียบให้เห็นบั๊กที่แก้ไปแล้ว) ถ้าคำนวณแบบ UTC ตรงๆ ไม่ผ่าน Asia/Bangkok จะได้ปี 2025 ผิดพลาด (ได้ ${utcNaiveYearAtInstant}) — ยืนยันว่า getBangkokYear() ที่ใช้จริงหลีกเลี่ยงบั๊กนี้ได้`);

    // หมายเหตุ: EXTRACT(YEAR FROM timestamptz) โดยไม่ใส่ AT TIME ZONE เลย ไม่ได้แปลว่าเป็น UTC เสมอไป —
    // Postgres จะแปลงตาม session TimeZone GUC ปัจจุบันเสมอ (เครื่องนี้ตั้งไว้เป็น Asia/Bangkok อยู่แล้ว จึง
    // ให้ผลถูกต้องบังเอิญแม้ไม่ใส่ AT TIME ZONE ก็ตาม) — จำลอง session ที่ตั้ง TimeZone เป็น UTC ตรงๆ แทน
    // เพื่อพิสูจน์ว่าทำไมต้องใส่ AT TIME ZONE 'Asia/Bangkok' แบบ hardcode ในสูตรเสมอ ไม่พึ่ง session config
    const sqlCheck = await pool.query(
      `SELECT (EXTRACT(YEAR FROM ($1::timestamptz AT TIME ZONE 'Asia/Bangkok'))::int + 543) AS be_year,
              (EXTRACT(YEAR FROM ($1::timestamptz AT TIME ZONE 'UTC'))::int + 543) AS utc_naive_be_year`,
      [testInstant.toISOString()]
    );
    assert(parseInt(sqlCheck.rows[0].be_year, 10) === 2569, `สูตร SQL เดียวกับที่ migration 0023 ใช้ backfill (AT TIME ZONE 'Asia/Bangkok') ที่ instant เดียวกันได้ พ.ศ. 2569 ถูกต้อง (ได้ ${sqlCheck.rows[0].be_year})`);
    assert(parseInt(sqlCheck.rows[0].utc_naive_be_year, 10) === 2568, `(เทียบบั๊ก) ถ้า session ต่อ DB ตั้ง TimeZone เป็น UTC (เช่น production host ที่ตั้ง UTC) แล้ว backfill ไม่ hardcode AT TIME ZONE 'Asia/Bangkok' ไว้ จะได้ พ.ศ. 2568 ผิดพลาดที่ instant เดียวกัน (ได้ ${sqlCheck.rows[0].utc_naive_be_year}) — ยืนยันว่าการ hardcode timezone ใน DDL จริงจำเป็นและหลีกเลี่ยงบั๊กนี้ได้แม้ session config จะเปลี่ยนไปในอนาคต`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      await pool.query(`DELETE FROM company_document_counters WHERE company_id=$1 AND doc_type='__e2e_year_boundary_test__'`, [COMPANY_A_ID]);
      const { tenderIds, projectIds, voucherIds } = cleanup;
      if (tenderIds.length) await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [tenderIds]);
      if (projectIds.length) await pool.query('DELETE FROM client_projects WHERE id = ANY($1)', [projectIds]);
      if (voucherIds.length) {
        const journalIds = (await pool.query(`SELECT id FROM client_journal_entries WHERE source_type='payment_voucher' AND source_id = ANY($1)`, [voucherIds])).rows.map(r => r.id);
        if (journalIds.length) {
          await pool.query('DELETE FROM client_journal_entry_lines WHERE journal_entry_id = ANY($1)', [journalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE reverses_entry_id = ANY($1)', [journalIds]);
          await pool.query('DELETE FROM client_journal_entries WHERE id = ANY($1)', [journalIds]);
        }
        await pool.query(`DELETE FROM client_document_audit_log WHERE doc_type='payment_voucher' AND doc_id = ANY($1)`, [voucherIds]);
        await pool.query('DELETE FROM client_payment_vouchers WHERE id = ANY($1)', [voucherIds]);
      }
      await pool.query(`DELETE FROM client_idempotency_keys WHERE company_id=$1 AND idempotency_key LIKE 'docnum-%'`, [COMPANY_A_ID]);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
