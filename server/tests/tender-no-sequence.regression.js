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
//
// Fixture hygiene (fixed 2026-10-07, see ข.16 in server/docs/pr-module-known-limitations.md): this file
// used to hardcode FIXTURE_COMPANY_ID=13 (a real, shared company) and a fixed username
// ('_tender_noseq_') instead of creating its own throwaway customer_companies row like every other test
// in this suite. Since 2026-10-02 (commit 10e3577, when customerId became mandatory on tenders and this
// test started calling POST /api/customer/clients) that call wrote a client_document_audit_log row
// (doc_type='customer') against the test user — and the old cleanup deleted `customers` BEFORE deleting
// that audit log row, so every single run failed on the FK and silently left the user row behind
// (caught by a try/catch that only printed a warning, never failing the test). The next run then hit
// `duplicate key value violates unique constraint "customers_username_key"` on the fixed username.
// Fixed by: (1) creating a dedicated company per run, (2) a timestamped username so even a missed
// cleanup can never collide with a future run, (3) deleting audit log rows before the user row, in the
// order audit log -> tender -> client_customers -> user -> company, and (4) a cleanup failure now sets
// process.exitCode=1 instead of being swallowed.

const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';

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
  let companyId = null, testCustomerId = null, clientCustomerId = null;
  const createdTenderIds = [];
  try {
    const code = 'TNOSEQ' + Date.now();
    const username = '_tender_noseq_' + Date.now() + '_';
    const companyIns = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id, code`,
      ['Tender No-Sequence Test Co', code]
    );
    const company = companyIns.rows[0];
    companyId = company.id;
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'Tender No-Sequence Test',$2,$3,$4,'active',true) RETURNING id`,
      [company.id, `tender-no-sequence-${Date.now()}@example.com`, username, hash]
    );
    testCustomerId = custIns.rows[0].id;
    await call('POST', '/api/customer-login', { companyCode: company.code, username, password: 'TestPass123!' });
    // Customer Master (migration 0025/0034) — customerId is mandatory now; one throwaway customer
    // covers every tender this test creates.
    const custForTenders = await call('POST', '/api/customer/clients', { name: 'ลูกค้าทดสอบ no-sequence' });
    const customerId = custForTenders.customer.id;
    clientCustomerId = customerId;

    // Tender A, then Tender B — B's sequence number must be strictly greater than A's.
    const tenderA = await call('POST', '/api/customer/tenders', { name: 'no-sequence test A', customerId, sectorType: 'private' });
    createdTenderIds.push(tenderA.tender.id);
    const tenderB = await call('POST', '/api/customer/tenders', { name: 'no-sequence test B', customerId, sectorType: 'private' });
    createdTenderIds.push(tenderB.tender.id);
    assert(seqOf(tenderB.tender.tenderNo) > seqOf(tenderA.tender.tenderNo), `B (${tenderB.tender.tenderNo}) comes after A (${tenderA.tender.tenderNo})`);

    // Delete A (the bug's exact trigger: shrinking the row count for this company).
    await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderA.tender.id]);
    createdTenderIds.splice(createdTenderIds.indexOf(tenderA.tender.id), 1);

    // Tender C, created after A was deleted — must NOT reuse A's number (the bug) and must still be
    // strictly after B (proving the counter, not the row count, drives the sequence).
    const tenderC = await call('POST', '/api/customer/tenders', { name: 'no-sequence test C', customerId, sectorType: 'private' });
    createdTenderIds.push(tenderC.tender.id);
    assert(tenderC.tender.tenderNo !== tenderA.tender.tenderNo, `C (${tenderC.tender.tenderNo}) does not reuse A's now-deleted number (${tenderA.tender.tenderNo})`);
    assert(seqOf(tenderC.tender.tenderNo) > seqOf(tenderB.tender.tenderNo), `C (${tenderC.tender.tenderNo}) comes after B (${tenderB.tender.tenderNo}), unaffected by A's deletion`);

    // Delete B and C too, then confirm the counter itself (not just observed behavior) never went
    // backwards — this is what actually guarantees no future collision, regardless of row counts.
    // migration 0023 widened the key to (company_id, doc_type, year) — filter by the current Buddhist
    // year explicitly rather than assuming exactly one row exists for this doc_type
    const bangkokYear = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(new Date()), 10) + 543;
    const counterBefore = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='tender' AND year=$2`, [company.id, bangkokYear]);
    await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [createdTenderIds]);
    createdTenderIds.length = 0;
    const tenderD = await call('POST', '/api/customer/tenders', { name: 'no-sequence test D', customerId, sectorType: 'private' });
    createdTenderIds.push(tenderD.tender.id);
    const counterAfter = await pool.query(`SELECT next_seq FROM company_document_counters WHERE company_id=$1 AND doc_type='tender' AND year=$2`, [company.id, bangkokYear]);
    assert(counterAfter.rows[0].next_seq > counterBefore.rows[0].next_seq, `company_document_counters.next_seq strictly increased (${counterBefore.rows[0].next_seq} -> ${counterAfter.rows[0].next_seq}) even after every tender created during this test was deleted`);
    assert(seqOf(tenderD.tender.tenderNo) > seqOf(tenderC.tender.tenderNo), `D (${tenderD.tender.tenderNo}) still comes after C (${tenderC.tender.tenderNo}) despite B/C both being deleted first`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body || '');
    process.exitCode = 1;
  } finally {
    try {
      // Order matters: client_document_audit_log.performed_by has a FK onto customers(id), so it must
      // be deleted BEFORE the customers row itself, not after (this exact ordering bug is what left
      // fixture rows behind on every run since 2026-10-02 — see the comment at the top of this file).
      if (testCustomerId) await pool.query('DELETE FROM client_document_audit_log WHERE performed_by=$1', [testCustomerId]);
      if (createdTenderIds.length) await pool.query('DELETE FROM client_tenders WHERE id = ANY($1)', [createdTenderIds]);
      if (clientCustomerId) await pool.query('DELETE FROM client_customers WHERE id=$1', [clientCustomerId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
      if (companyId) await pool.query('DELETE FROM customer_companies WHERE id=$1', [companyId]);
    } catch (cleanupErr) {
      // A swallowed cleanup failure is exactly how this file polluted the database silently for days —
      // a failed cleanup must fail the test run, not just print a warning nobody reads in a 34-script log.
      console.error('CLEANUP FAILED (leftover fixture rows may remain):', cleanupErr.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})();
