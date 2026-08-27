// Idempotent setup for the fx_* test accounts + client_pr_approval_rules shared by every
// server/tests/*.regression.js file for the client ledger / PR module. Safe to re-run any time
// (upsert by username, not insert-only) — required by each regression file at startup so a lost/wiped
// database (as happened 2026-08-17) can never again silently break every test in this suite.
// See server/tests/README.md for the full fixture reference table and rationale.
const bcrypt = require('bcryptjs');
const pool = require('../../db');

const COMPANY_A_ID = 13; // RIXCFR
const COMPANY_B_ID = 19; // DIUXPB
const PASSWORD = 'TestPass123!';

const USERS = [
  { username: 'fx_maker', companyId: COMPANY_A_ID, role: 'maker', flags: {} },
  { username: 'fx_maker2', companyId: COMPANY_A_ID, role: 'maker', flags: {} },
  // มีทั้ง certify และ approve เพื่อเทสจงใจ self-block ของ /approve ที่ต้องครอบคลุมถึง certified_by ด้วย
  // (คนที่ certify ไปแล้ว approve ใบเดียวกันเองไม่ได้ แม้จะมีสิทธิ์ approve โดยทั่วไปก็ตาม — ต้องให้คนที่ 3
  // อนุมัติแทนเสมอในเทสจริง เช่น fx_super)
  { username: 'fx_approver_mid', companyId: COMPANY_A_ID, role: 'approver', flags: { can_approve_pr: true, can_approve_po_wo: true, can_approve_petty_cash: true, can_approve_advance: true, can_approve_other: true, can_approve_progress: true, can_certify_progress: true, can_approve_subcontract_billing: true } },
  { username: 'fx_certifier', companyId: COMPANY_A_ID, role: 'maker', flags: { can_certify_progress: true, can_approve_progress: true } },
  { username: 'fx_approver_floor', companyId: COMPANY_A_ID, role: 'approver', flags: { can_approve_pr: true, can_approve_petty_cash: true, can_approve_advance: true, can_approve_other: true } },
  { username: 'fx_approver_norule', companyId: COMPANY_A_ID, role: 'approver', flags: { can_approve_pr: true, can_approve_petty_cash: true, can_approve_advance: true, can_approve_other: true } },
  { username: 'fx_super', companyId: COMPANY_A_ID, role: 'super_user', flags: {} },
  { username: 'fx_other_co', companyId: COMPANY_B_ID, role: 'super_user', flags: {} },
  // role='maker' + can_manage_po=true — ฝ่ายจัดซื้อ/จัดหา: ทดสอบเส้นทาง "OR can_manage_po" ของ
  // hasPrItemActionPermission/hasSubcontractorManagePermission แยกจาก super_user (ต้องพิสูจน์ว่า flag
  // เพียงอย่างเดียวพอ ไม่ต้องพึ่ง role)
  { username: 'fx_procurement', companyId: COMPANY_A_ID, role: 'maker', flags: { can_manage_po: true } },
  // งานหน้างาน — role='maker' ล้วนๆ (ไม่มี can_manage_po/can_settle_cash) มีแค่ 2 flag ส่งเรื่องหน้างาน
  // แยกกัน เพื่อพิสูจน์ว่าทั้งสอง flag เป็นอิสระจากกันจริง (มีอันหนึ่งไม่ได้แปลว่ามีอีกอันด้วย)
  { username: 'fx_sitework', companyId: COMPANY_A_ID, role: 'maker', flags: { can_submit_goods_receipt: true, can_submit_site_expense: true } },
  // มีแค่ can_settle_cash เท่านั้น (ไม่ใช่ super_user ไม่มี flag อื่นเลย) — พิสูจน์ว่า flag เดียวนี้พอสำหรับ
  // ปิดเรื่อง/ตีกลับคิวส่งบิลหน้างาน ตามที่ผู้ใช้ยืนยัน (hasSiteExpenseProcessPermission)
  { username: 'fx_settler', companyId: COMPANY_A_ID, role: 'maker', flags: { can_settle_cash: true } },
];

// [username, docType, minAmount, maxAmount] — fx_approver_norule ตั้งใจไม่มี rule เลย (เทส no_rule)
const RULES = [
  ['fx_approver_mid', 'pr', 0, 50000],
  ['fx_approver_mid', 'po_wo', 0, 50000],
  ['fx_approver_mid', 'petty_cash', 0, 50000],
  ['fx_approver_mid', 'advance', 0, 50000],
  ['fx_approver_mid', 'other', 0, 50000],
  ['fx_approver_mid', 'progress', 0, 50000],
  ['fx_approver_mid', 'subcontractor_billing', 0, 50000],
  ['fx_approver_floor', 'pr', 10000, 200000],
  ['fx_approver_floor', 'petty_cash', 10000, 200000],
  ['fx_approver_floor', 'advance', 10000, 200000],
  ['fx_approver_floor', 'other', 10000, 200000],
];

async function setup(log = false) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ids = {};
  for (const u of USERS) {
    const cols = ['company_id', 'name', 'email', 'username', 'password_hash', 'status', 'role', ...Object.keys(u.flags)];
    const vals = [u.companyId, `Fixture ${u.username}`, `${u.username}@fixture.local`, u.username, hash, 'active', u.role, ...Object.values(u.flags)];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    const updateSet = cols.filter(c => c !== 'username').map(c => `${c}=EXCLUDED.${c}`).join(',');
    const r = await pool.query(
      `INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders})
       ON CONFLICT (username) DO UPDATE SET ${updateSet}
       RETURNING id`,
      vals
    );
    ids[u.username] = r.rows[0].id;
    if (log) console.log(`  ${u.username} -> id ${r.rows[0].id}`);
  }

  for (const [username, docType, minAmount, maxAmount] of RULES) {
    const approverId = ids[username];
    const existing = await pool.query(
      `SELECT id FROM client_pr_approval_rules WHERE company_id=$1 AND approver_customer_id=$2 AND doc_type=$3 AND is_active=true`,
      [COMPANY_A_ID, approverId, docType]
    );
    if (existing.rowCount > 0) continue; // มีอยู่แล้ว (จากรันครั้งก่อน) ไม่ต้องสร้างซ้ำ
    const r = await pool.query(
      `INSERT INTO client_pr_approval_rules (company_id, approver_customer_id, doc_type, min_amount, max_amount, description, is_active)
       VALUES ($1,$2,$3,$4,$5,'fixture (setup-approval-fixtures.js)',true) RETURNING id`,
      [COMPANY_A_ID, approverId, docType, minAmount, maxAmount]
    );
    if (log) console.log(`  rule ${username}/${docType} created (#${r.rows[0].id})`);
  }
  return { ids, companyAId: COMPANY_A_ID, companyBId: COMPANY_B_ID, password: PASSWORD };
}

module.exports = { setup, COMPANY_A_ID, COMPANY_B_ID, PASSWORD };

if (require.main === module) {
  setup(true)
    .then(({ ids }) => { console.log('Fixture setup complete.'); return pool.end(); })
    .catch(err => { console.error('Fixture setup FAILED:', err.message); pool.end(); process.exitCode = 1; });
}
