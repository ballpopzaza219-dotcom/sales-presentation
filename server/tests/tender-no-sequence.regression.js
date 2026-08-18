// Regression test for the "tender_no reissued after deleting an old tender" bug fixed 2026-07-24.
// Root cause: generateTenderNo (server.js) derived the next number from
// `COUNT(*) FROM client_tenders WHERE company_id=$1` — the count of CURRENTLY-EXISTING rows, not how
// many have ever been issued. Deleting old tenders shrinks that count, so the next tender created
// could reissue a tender_no that had already been used (and deleted) minutes/days earlier —
// reproduced for real: deleting TDR-2569-0001..0010 for company 13 made the next tender created
// issue "TDR-2569-0003" again.
// Fix: a dedicated company_document_counters table (schema.sql) holding a monotonically-increasing
// next_seq per (company_id, doc_type), incremented via an atomic UPSERT (nextDocumentSeq, server.js) —
// deleting client_tenders rows never touches this counter, so numbers are never reissued.
//
// Prerequisites: the dev server must already be running on http://localhost:3000, and server/.env
// must point at a reachable Postgres instance.
// Run: cd server && node tests/tender-no-sequence.regression.js

const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_COMPANY_ID = 13;

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
let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}
function seqOf(tenderNo) { return parseInt(tenderNo.match(/(\d+)$/)[1], 10); }

(async () => {
  let testCustomerId = null;
  const createdTenderIds = [];
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Tender No-Sequence Test','tender-no-sequence@example.com','_tender_noseq_', $2, 'active', true) RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;
    await call('POST', '/api/customer-login', { companyCode: company.code, username: '_tender_noseq_', password: 'TestPass123!' });

    // Tender A, then Tender B — B's sequence number must be strictly greater than A's.
    const tenderA = await call('POST', '/api/customer/tenders', { name: 'no-sequence test A', sectorType: 'private' });
    createdTenderIds.push(tenderA.tender.id);
    const tenderB = await call('POST', '/api/customer/tenders', { name: 'no-sequence test B', sectorType: 'private' });
    createdTenderIds.push(tenderB.tender.id);
    assert(seqOf(tenderB.tender.tenderNo) > seqOf(tenderA.tender.tenderNo), `B (${tenderB.tender.tenderNo}) comes after A (${tenderA.tender.tenderNo})`);

    // Delete A (the bug's exact trigger: shrinking the row count for this company).
    await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderA.tender.id]);
    createdTenderIds.splice(createdTenderIds.indexOf(tenderA.tender.id), 1);

    // Tender C, created after A was deleted — must NOT reuse A's number (the bug) and must still be
    // strictly after B (proving the counter, not the row count, drives the sequence).
    const tenderC = await call('POST', '/api/customer/tenders', { name: 'no-sequence test C', sectorType: 'private' });
    createdTenderIds.push(tenderC.tender.id);
    assert(tenderC.tender.tenderNo !== tenderA.tender.tenderNo, `C (${tenderC.tender.tenderNo}) does not reuse A's now-deleted number (${tenderA.tender.tenderNo})`);
    assert(seqOf(tenderC.tender.tenderNo) > seqOf(tenderB.tender.tenderNo), `C (${tenderC.tender.tenderNo}) comes after B (${tenderB.tender.tenderNo}), unaffected by A's deletion`);

    // Delete B and C too, then confirm the counter itself (not just observed behavior) never went
    // backwards — this is what actually guarantees no future collision, regardless of row counts.
    const counterBefore = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='tender'`, [company.id]);
    await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [createdTenderIds]);
    createdTenderIds.length = 0;
    const tenderD = await call('POST', '/api/customer/tenders', { name: 'no-sequence test D', sectorType: 'private' });
    createdTenderIds.push(tenderD.tender.id);
    const counterAfter = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='tender'`, [company.id]);
    assert(counterAfter.rows[0].next_seq > counterBefore.rows[0].next_seq, `company_document_counters.next_seq strictly increased (${counterBefore.rows[0].next_seq} -> ${counterAfter.rows[0].next_seq}) even after every tender created during this test was deleted`);
    assert(seqOf(tenderD.tender.tenderNo) > seqOf(tenderC.tender.tenderNo), `D (${tenderD.tender.tenderNo}) still comes after C (${tenderC.tender.tenderNo}) despite B/C both being deleted first`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body || '');
    process.exitCode = 1;
  } finally {
    try {
      if (createdTenderIds.length) await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [createdTenderIds]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
