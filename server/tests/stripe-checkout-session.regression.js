// Regression suite — POST /api/admin/companies/:id/checkout-session (Stripe Billing migration 0027,
// stage 2). Hits the REAL Stripe test-mode API (no mocks, same philosophy as the rest of this repo's
// tests). Covers: a real Checkout Session is created with the correct mode/line items/metadata; a
// Stripe Customer is created once and reused (saved to customer_companies.stripe_customer_id) rather
// than re-created on every call; additional seats become a second subscription line item at the
// package's seat price; a package with no seat_price rejects any additionalSeats > 0 (never silently
// ignores it); a company that already has an active Stripe subscription is blocked from getting a
// second checkout session (would otherwise risk double-charging via two parallel subscriptions).
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at both a reachable
// Postgres AND a valid Stripe test-mode secret key, and the 4 real packages already synced to Stripe
// (stage 1). Run: cd server && node tests/stripe-checkout-session.regression.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_ADMIN_EMAIL = 'e2e-stripe-fixture@sitereq.local';
const FIXTURE_ADMIN_PASSWORD = 'E2EStripeFixture123!';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {};
async function call(method, urlPath, body) {
  const headers = { Cookie: cookies.admin || '', 'Content-Type': 'application/json' };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies.admin = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
async function callExpectError(method, urlPath, body) {
  try { await call(method, urlPath, body); throw new Error(`expected ${method} ${urlPath} to fail but it succeeded`); }
  catch (e) { if (e.status === undefined) throw e; return e; }
}

// เหมือน stripe-package-sync.regression.js — reuse fixture admin เดียวกัน (idempotent, สร้างครั้งเดียว)
async function ensureFixtureAdmin() {
  const existing = await pool.query('SELECT id FROM platform_admins WHERE email=$1', [FIXTURE_ADMIN_EMAIL]);
  if (existing.rowCount > 0) return;
  const hash = await bcrypt.hash(FIXTURE_ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO platform_admins (email, password_hash, name, role, active) VALUES ($1,$2,'E2E Stripe Fixture','owner',true)`,
    [FIXTURE_ADMIN_EMAIL, hash]
  );
}
async function login() {
  await call('POST', '/api/admin/login', { email: FIXTURE_ADMIN_EMAIL, password: FIXTURE_ADMIN_PASSWORD });
}

(async () => {
  const cleanup = { companyIds: [], stripeCustomerIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await ensureFixtureAdmin();
    await login();

    // ============================================================================================
    // (1) สร้าง Checkout Session จริง (แพ็กเกจหลัก + ที่นั่งเพิ่ม) -> ตรวจกับ Stripe API ตรงๆ
    // ============================================================================================
    console.log('\n=== (1) สร้าง Checkout Session (Basic + 3 ที่นั่งเพิ่ม) ===');
    const uniq = Date.now();
    const companyRes = await call('POST', '/api/admin/companies', {
      name: `E2E Checkout Test Co ${uniq}`, taxId: '1111111111111', phone: '02-000-0000', email: 'e2e-checkout-test@example.com',
    });
    const companyId = companyRes.company.id;
    cleanup.companyIds.push(companyId);

    const packagesRes = await pool.query(`SELECT id, stripe_price_id, stripe_seat_price_id FROM packages WHERE name='Basic'`);
    const basicPkg = packagesRes.rows[0];
    assert(!!basicPkg.stripe_price_id, 'sanity check: แพ็กเกจ Basic sync ขึ้น Stripe แล้วจริง (จาก stage 1)');

    const checkout = await call('POST', `/api/admin/companies/${companyId}/checkout-session`, { packageId: basicPkg.id, additionalSeats: 3 });
    assert(checkout.checkoutUrl.startsWith('https://checkout.stripe.com/'), 'ได้ checkoutUrl จริงจาก Stripe');

    const session = await stripe.checkout.sessions.retrieve(checkout.sessionId, { expand: ['line_items'] });
    assert(session.mode === 'subscription', 'Checkout Session mode=subscription ถูกต้อง');
    assert(session.metadata.company_id === String(companyId), 'metadata.company_id ตรงกับบริษัทจริง');
    assert(session.metadata.additional_seats === '3', 'metadata.additional_seats บันทึกไว้ถูกต้องสำหรับ webhook สเตจถัดไปอ่าน');
    assert(session.line_items.data.length === 2, `มี line item 2 รายการ (หลัก + ที่นั่งเพิ่ม) จริง (ได้ ${session.line_items.data.length})`);
    const mainItem = session.line_items.data.find(li => li.price.id === basicPkg.stripe_price_id);
    assert(mainItem && mainItem.quantity === 1, 'line item หลัก quantity=1 ถูกต้อง');
    const seatItem = session.line_items.data.find(li => li.price.id === basicPkg.stripe_seat_price_id);
    assert(seatItem && seatItem.quantity === 3, `line item ที่นั่งเพิ่ม quantity=3 ถูกต้อง (ได้ ${seatItem && seatItem.quantity})`);

    const companyAfter = await pool.query('SELECT stripe_customer_id FROM customer_companies WHERE id=$1', [companyId]);
    const stripeCustomerId = companyAfter.rows[0].stripe_customer_id;
    assert(!!stripeCustomerId, 'stripe_customer_id ถูกบันทึกลง customer_companies จริง');
    cleanup.stripeCustomerIds.push(stripeCustomerId);
    assert(session.customer === stripeCustomerId, 'Checkout Session ผูกกับ Stripe Customer เดียวกับที่บันทึกในระบบเรา');

    // ============================================================================================
    // (2) สร้าง Checkout Session รอบสอง -> ต้องใช้ stripe_customer_id เดิม ไม่สร้าง Customer ซ้ำ
    // ============================================================================================
    console.log('\n=== (2) สร้าง Checkout Session รอบสอง -> reuse Stripe Customer เดิม ===');
    const checkout2 = await call('POST', `/api/admin/companies/${companyId}/checkout-session`, { packageId: basicPkg.id, additionalSeats: 0 });
    const session2 = await stripe.checkout.sessions.retrieve(checkout2.sessionId);
    assert(session2.customer === stripeCustomerId, 'Checkout Session รอบสองใช้ Stripe Customer เดิม ไม่สร้างซ้ำ');

    // ============================================================================================
    // (3) ซื้อที่นั่งเพิ่มบนแพ็กเกจที่ไม่รองรับ (seat_price=NULL) -> ต้องถูกปฏิเสธ 400 ไม่ใช่เงียบๆ ข้ามไป
    // ============================================================================================
    console.log('\n=== (3) แพ็กเกจไม่รองรับที่นั่งเพิ่ม (Free) -> ปฏิเสธ ===');
    const freePkgRes = await pool.query(`SELECT id FROM packages WHERE name='Free'`);
    const freePkgId = freePkgRes.rows[0].id;
    const rejectedSeats = await callExpectError('POST', `/api/admin/companies/${companyId}/checkout-session`, { packageId: freePkgId, additionalSeats: 2 });
    assert(rejectedSeats.status === 400, `แพ็กเกจ Free ไม่มี seat_price -> ซื้อที่นั่งเพิ่มไม่ได้ 400 (ได้ ${rejectedSeats.status})`);

    // ============================================================================================
    // (4) บริษัทที่มี Stripe subscription active อยู่แล้วจริง -> กันสร้าง checkout ซ้อนทับ (409)
    // ============================================================================================
    console.log('\n=== (4) กันสร้าง checkout ซ้อนถ้ามี subscription active อยู่แล้วจริง ===');
    await pool.query(
      `INSERT INTO subscriptions (company_id, tier, max_users, status, stripe_subscription_id, expires_at)
       VALUES ($1, 'basic', 4, 'active', 'sub_fake_test_regression', now() + interval '30 days')`,
      [companyId]
    );
    const blockedDup = await callExpectError('POST', `/api/admin/companies/${companyId}/checkout-session`, { packageId: basicPkg.id, additionalSeats: 0 });
    assert(blockedDup.status === 409, `บริษัทมี subscription active อยู่แล้ว -> สร้าง checkout ใหม่ซ้อนไม่ได้ 409 (ได้ ${blockedDup.status})`);

    // ============================================================================================
    // (5) บริษัทอยู่ระหว่าง grace period (payment_failed_at ไม่ใช่ NULL) -> กันสร้าง checkout ซ้อนด้วย
    // แยกต่างหากจาก subscriptions.status (schema จริงยังไม่มีค่า past_due/unpaid เลย ต้องเช็คคู่กันเสมอ)
    // ============================================================================================
    console.log('\n=== (5) กันสร้าง checkout ซ้อนถ้าอยู่ระหว่าง grace period (payment_failed_at) ===');
    await pool.query(`DELETE FROM subscriptions WHERE company_id=$1`, [companyId]); // ลบ fixture ข้อ (4) ก่อน แยกทดสอบให้ชัด
    await pool.query(`UPDATE customer_companies SET payment_failed_at=now() WHERE id=$1`, [companyId]);
    const blockedGrace = await callExpectError('POST', `/api/admin/companies/${companyId}/checkout-session`, { packageId: basicPkg.id, additionalSeats: 0 });
    assert(blockedGrace.status === 409, `บริษัทอยู่ระหว่าง grace period (payment_failed_at ตั้งค่าไว้) -> สร้าง checkout ใหม่ซ้อนไม่ได้ 409 แม้ subscriptions.status จะไม่ใช่ 'active' เลยก็ตาม (ได้ ${blockedGrace.status})`);
    await pool.query(`UPDATE customer_companies SET payment_failed_at=NULL WHERE id=$1`, [companyId]);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      for (const custId of cleanup.stripeCustomerIds) {
        await stripe.customers.del(custId).catch(() => {});
      }
      if (cleanup.companyIds.length) {
        await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [cleanup.companyIds]);
        await pool.query('DELETE FROM customer_companies WHERE id = ANY($1)', [cleanup.companyIds]);
      }
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
