// Regression test for the Client Contract table (Stage B item 5 of the blueprint, ข้อ 11 Contract) —
// migration 0035_client_contracts. This is a schema-level test: it talks to Postgres directly via raw
// INSERT/UPDATE statements (no HTTP server, no Playwright) because at this point only the DDL exists —
// server.js has no /api/customer/contracts endpoints yet. Every assertion checks a real constraint
// violation (or real success) by inspecting Postgres's own `error.constraint` name, never just "did it
// throw" — a wrong-shaped INSERT can fail for the WRONG reason (e.g. tripping
// client_contracts_revision_no_check instead of the unique index it was meant to exercise) and still
// look like a pass if you only check "did it throw".
//
// Prerequisites: server/.env must point at a reachable Postgres instance with migration
// 0035_client_contracts already applied (`node migrations/migrate.js up`). No dev server needed.
// Run: cd server && node tests/client-contracts-schema.regression.js

const pool = require('../db');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

async function expectConstraintViolation(label, expectedConstraint, sql, params) {
  try {
    await pool.query(sql, params);
    throw new Error(`ASSERTION FAILED: ${label} -- INSERT succeeded but should have violated "${expectedConstraint}"`);
  } catch (e) {
    if (e.message && e.message.startsWith('ASSERTION FAILED')) throw e;
    assert(
      e.constraint === expectedConstraint,
      `${label} -- rejected by "${e.constraint}" (expected "${expectedConstraint}")${e.constraint !== expectedConstraint ? ` | full message: ${e.message}` : ''}`
    );
  }
}

async function mustSucceed(label, sql, params) {
  const r = await pool.query(sql, params);
  assert(true, `${label} -- accepted (rowCount=${r.rowCount})`);
  return r;
}

(async () => {
  let companyId, projectId, customerId, rootId;
  try {
    const code = 'CTSCHEMA' + Date.now();
    const comp = await pool.query(
      `INSERT INTO customer_companies (name, code, status) VALUES ($1,$2,'active') RETURNING id`,
      ['Contract Schema Test Co', code]
    );
    companyId = comp.rows[0].id;

    const cust = await pool.query(
      `INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`,
      [companyId, 'ลูกค้าทดสอบ contract-schema']
    );
    customerId = cust.rows[0].id;

    const proj = await pool.query(
      `INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTS01','โครงการทดสอบ contract-schema',$2) RETURNING id`,
      [companyId, customerId]
    );
    projectId = proj.rows[0].id;

    // Root contract carries a real start_date (not NULL) specifically so (k) below can prove
    // client_contract_effective_terms actually falls back to the ROOT's value, not just happen to
    // return NULL for a field nobody set anywhere.
    const rootIns = await mustSucceed(
      'setup: valid root contract (approved, active, start_date=2026-01-01) inserts cleanly',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_no,
         contract_value, deposit_percent, retention_percent, payment_terms, start_date, status, contract_status)
       VALUES ($1,$2,$3,NULL,0,'CT-2569-0001',1000000,0,5,'เครดิต 30 วัน','2026-01-01','approved','active')
       RETURNING id`,
      [companyId, projectId, customerId]
    );
    rootId = rootIns.rows[0].id;

    // (a) R submitted but revision_no NULL -> client_contracts_revision_no_check
    await expectConstraintViolation(
      '(a) R submitted with revision_no NULL',
      'client_contracts_revision_no_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,50000,'submitted')`,
      [companyId, projectId, customerId, rootId]
    );

    // (b) root contract with revision_no NULL -> client_contracts_revision_no_check
    await expectConstraintViolation(
      '(b) root contract with revision_no NULL',
      'client_contracts_revision_no_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,NULL,999999,0,5,'เครดิต 30 วัน','draft')`,
      [companyId, projectId, customerId]
    );

    // (c) R with project_id/customer_id different from parent -> client_contracts_parent_fk
    const otherCust = await pool.query(
      `INSERT INTO client_customers (company_id, name) VALUES ($1,$2) RETURNING id`,
      [companyId, 'ลูกค้าอื่น contract-schema']
    );
    await expectConstraintViolation(
      '(c) R with customer_id different from parent',
      'client_contracts_parent_fk',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,10000,'draft')`,
      [companyId, projectId, otherCust.rows[0].id, rootId]
    );
    const otherProj = await pool.query(
      `INSERT INTO client_projects (company_id, code, name, customer_id) VALUES ($1,'CTS01B','โครงการอื่น contract-schema',$2) RETURNING id`,
      [companyId, customerId]
    );
    await expectConstraintViolation(
      '(c) R with project_id different from parent',
      'client_contracts_parent_fk',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,10000,'draft')`,
      [companyId, otherProj.rows[0].id, customerId, rootId]
    );

    // (d) "open R at a time" must be enforced by uq_client_contracts_one_open_revision specifically —
    // not by some other CHECK tripping first on a malformed INSERT. Three steps:
    //   d1: first open R (draft) under root -> succeeds
    //   d2: second open R, IDENTICAL shape to d1 (still draft, revision_no NULL) -> must fail, and the
    //       failure must be the unique index, not client_contracts_revision_no_check (that CHECK
    //       explicitly allows revision_no IS NULL while status NOT IN ('submitted','approved'), so a
    //       second draft R with NULL revision_no is perfectly legal AS FAR AS THAT CHECK IS CONCERNED —
    //       only the unique index should be the one objecting).
    //   d3: cancel the first R, then a third open R (same shape again) -> must succeed, proving the
    //       index only counts R's that are still open (not cancelled/rejected/approved).
    const rD1 = await mustSucceed(
      '(d1) first open R (draft, revision_no NULL) under root inserts cleanly',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,20000,'draft') RETURNING id`,
      [companyId, projectId, customerId, rootId]
    );
    await expectConstraintViolation(
      '(d2) second open R (identical shape to d1) under the same root',
      'uq_client_contracts_one_open_revision',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,25000,'draft')`,
      [companyId, projectId, customerId, rootId]
    );
    await pool.query(`UPDATE client_contracts SET status='cancelled' WHERE id=$1`, [rD1.rows[0].id]);
    const rD3 = await mustSucceed(
      '(d3) third open R (same shape) allowed after d1 was cancelled',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,25000,'draft') RETURNING id`,
      [companyId, projectId, customerId, rootId]
    );
    // clean up this throwaway open draft so it doesn't collide with the (i)/(k)/(l) R's inserted below.
    await pool.query(`DELETE FROM client_contracts WHERE id=$1`, [rD3.rows[0].id]);

    // (e) second root contract for same project while first still active -> uq_client_contracts_root_per_project;
    //     after terminating the first, a second root must be allowed.
    await expectConstraintViolation(
      '(e) second root contract for same project while first still active',
      'uq_client_contracts_root_per_project',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status, contract_status)
       VALUES ($1,$2,$3,NULL,0,500000,0,5,'เครดิต 30 วัน','approved','active')`,
      [companyId, projectId, customerId]
    );
    await pool.query(`UPDATE client_contracts SET contract_status='terminated' WHERE id=$1`, [rootId]);
    const root2 = await mustSucceed(
      '(e) second root contract allowed after first root terminated',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status, contract_status)
       VALUES ($1,$2,$3,NULL,0,500000,0,5,'เครดิต 30 วัน','approved','active') RETURNING id`,
      [companyId, projectId, customerId]
    );
    // revert: terminate the second root too and restore the first back to active, so the remaining
    // tests (which key off rootId) keep operating against a single clean active root.
    await pool.query(`UPDATE client_contracts SET contract_status='terminated' WHERE id=$1`, [root2.rows[0].id]);
    await pool.query(`UPDATE client_contracts SET contract_status='active' WHERE id=$1`, [rootId]);

    // (f) R that is approved AND carries a contract_status -> client_contracts_status_pair_check
    await expectConstraintViolation(
      '(f) R approved with non-null contract_status',
      'client_contracts_status_pair_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status, contract_status)
       VALUES ($1,$2,$3,$4,1,40000,'approved','active')`,
      [companyId, projectId, customerId, rootId]
    );

    // (g) contract_value = 0 (R) / <= 0 (root) -> client_contracts_value_check
    await expectConstraintViolation(
      '(g) R with contract_value = 0',
      'client_contracts_value_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, status)
       VALUES ($1,$2,$3,$4,NULL,0,'draft')`,
      [companyId, projectId, customerId, rootId]
    );
    await expectConstraintViolation(
      '(g) root with contract_value = 0',
      'client_contracts_value_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,0,0,0,5,'เครดิต 30 วัน','draft')`,
      [companyId, projectId, customerId]
    );
    await expectConstraintViolation(
      '(g) root with contract_value negative',
      'client_contracts_value_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,0,-100,0,5,'เครดิต 30 วัน','draft')`,
      [companyId, projectId, customerId]
    );

    // (h) root with retention_percent / deposit_percent / payment_terms NULL -> client_contracts_root_required_fields_check
    await expectConstraintViolation(
      '(h) root with retention_percent NULL',
      'client_contracts_root_required_fields_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,0,999999,0,NULL,'เครดิต 30 วัน','draft')`,
      [companyId, projectId, customerId]
    );
    await expectConstraintViolation(
      '(h) root with deposit_percent NULL',
      'client_contracts_root_required_fields_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,0,999999,NULL,5,'เครดิต 30 วัน','draft')`,
      [companyId, projectId, customerId]
    );
    await expectConstraintViolation(
      '(h) root with payment_terms NULL',
      'client_contracts_root_required_fields_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no,
         contract_value, deposit_percent, retention_percent, payment_terms, status)
       VALUES ($1,$2,$3,NULL,0,999999,0,5,NULL,'draft')`,
      [companyId, projectId, customerId]
    );

    // (j) R with payment_terms = '' (blank, not NULL) -> client_contracts_payment_terms_not_blank_check
    await expectConstraintViolation(
      "(j) R with payment_terms = '' (blank string)",
      'client_contracts_payment_terms_not_blank_check',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value, payment_terms, status)
       VALUES ($1,$2,$3,$4,NULL,40000,'','draft')`,
      [companyId, projectId, customerId, rootId]
    );

    // (i)/(k) R that sets ONLY end_date (every other override field NULL) must succeed, and
    // client_contract_effective_terms must return R's end_date but fall back to the ROOT's
    // retention/deposit/payment_terms/start_date (root.start_date='2026-01-01', set at setup above —
    // proves the fallback is real, not just "both happen to be NULL").
    const rK = await mustSucceed(
      '(i)/(k) R setting only end_date (others NULL) inserts cleanly, approved, revision_no=1',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value,
         end_date, status, contract_no)
       VALUES ($1,$2,$3,$4,1,100000,'2027-12-31','approved','CT-2569-0001-R1') RETURNING id`,
      [companyId, projectId, customerId, rootId]
    );
    const effAfterR1 = await pool.query(
      `SELECT to_char(effective_start_date,'YYYY-MM-DD') AS effective_start_date,
              to_char(effective_end_date,'YYYY-MM-DD') AS effective_end_date,
              effective_retention_percent, effective_deposit_percent, effective_payment_terms
       FROM client_contract_effective_terms WHERE company_id=$1 AND contract_id=$2`,
      [companyId, rootId]
    );
    const row1 = effAfterR1.rows[0];
    assert(row1.effective_start_date === '2026-01-01',
      `(k) effective_start_date falls back to ROOT's start_date 2026-01-01 (got ${row1.effective_start_date}) -- R1 never set start_date itself`);
    assert(row1.effective_end_date === '2027-12-31',
      `(i)/(k) effective_end_date comes from R1 (2027-12-31, got ${row1.effective_end_date}) -- root.end_date is NULL`);
    assert(row1.effective_retention_percent === '5.00',
      `(k) effective_retention_percent falls back to ROOT's 5.00 (got ${row1.effective_retention_percent}) -- R1 never set it`);
    assert(row1.effective_deposit_percent === '0.00',
      `(k) effective_deposit_percent falls back to ROOT's 0.00 (got ${row1.effective_deposit_percent}) -- R1 never set it`);
    assert(row1.effective_payment_terms === 'เครดิต 30 วัน',
      `(k) effective_payment_terms falls back to ROOT's 'เครดิต 30 วัน' (got ${row1.effective_payment_terms}) -- R1 never set it`);

    // (l) two approved R's with different end_date -> view must return the HIGHER revision_no's value.
    const rL = await mustSucceed(
      '(l) second approved R (revision_no=2) with a different end_date inserts cleanly',
      `INSERT INTO client_contracts
        (company_id, project_id, customer_id, parent_contract_id, revision_no, contract_value,
         end_date, status, contract_no)
       VALUES ($1,$2,$3,$4,2,50000,'2028-06-30','approved','CT-2569-0001-R2') RETURNING id`,
      [companyId, projectId, customerId, rootId]
    );
    const effAfterR2 = await pool.query(
      `SELECT to_char(effective_end_date,'YYYY-MM-DD') AS effective_end_date
       FROM client_contract_effective_terms WHERE company_id=$1 AND contract_id=$2`,
      [companyId, rootId]
    );
    assert(effAfterR2.rows[0].effective_end_date === '2028-06-30',
      `(l) effective_end_date returns R2's 2028-06-30 (the HIGHER revision_no), not R1's 2027-12-31 (got ${effAfterR2.rows[0].effective_end_date})`);

    // bonus: client_contract_current_value must equal base(1,000,000.00) + R1(100,000.00, approved) +
    // R2(50,000.00, approved) = 1,150,000.00 -- assert each component explicitly so the final number is
    // traceable to what produced it, not just a bare "does it equal 1150000.00".
    const curVal = await pool.query(
      `SELECT base_value, revision_total, current_value
       FROM client_contract_current_value WHERE company_id=$1 AND contract_id=$2`,
      [companyId, rootId]
    );
    const cv = curVal.rows[0];
    assert(cv.base_value === '1000000.00', `bonus: base_value is root's own contract_value 1000000.00 (got ${cv.base_value})`);
    assert(cv.revision_total === '150000.00', `bonus: revision_total is R1(100000.00) + R2(50000.00) = 150000.00 (got ${cv.revision_total})`);
    assert(cv.current_value === '1150000.00', `bonus: current_value is base_value + revision_total = 1000000.00 + 150000.00 = 1150000.00 (got ${cv.current_value})`);

    // (m) cleanup: delete all test rows, verify client_contracts count back to 0 for this company.
    await pool.query(`DELETE FROM client_contracts WHERE company_id=$1`, [companyId]);
    const countAfter = await pool.query(`SELECT COUNT(*)::int AS n FROM client_contracts WHERE company_id=$1`, [companyId]);
    assert(countAfter.rows[0].n === 0, `(m) cleanup: client_contracts count for test company is 0 after delete (got ${countAfter.rows[0].n})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    if (companyId) {
      await pool.query(`DELETE FROM client_contracts WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM client_projects WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM client_customers WHERE company_id=$1`, [companyId]);
      await pool.query(`DELETE FROM customer_companies WHERE id=$1`, [companyId]);
    }
    await pool.end();
  }
})();
