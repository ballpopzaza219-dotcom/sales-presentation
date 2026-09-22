// Regression suite — packages <-> Stripe Product/Price sync (Stripe Billing migration 0027, stage 1).
// Hits the REAL Stripe test-mode API (same no-mocks philosophy as every other regression test in this
// repo hitting a real dev Postgres) — requires STRIPE_SECRET_KEY in server/.env to be a sk_test_ key.
// Covers: create wires stripe_product_id/stripe_price_id/stripe_seat_price_id correctly; editing
// without changing the price returns the SAME Stripe Price id (no duplicate object created); editing
// WITH a price change creates a NEW Price and archives (active:false) the old one, leaving existing
// subscriptions on the old price undisturbed by Stripe's own design; clearing seatPrice to null
// archives the seat Price and nulls the local column (never falls back to 0 - CLAUDE.md ข้อ 17);
// toggle-active archives/reactivates the package's Stripe Price(s) in lockstep with the local flag.
//
// Prerequisites: dev server running on http://localhost:3000, server/.env pointing at both a reachable
// Postgres AND a valid Stripe test-mode secret key. Run: cd server && node tests/stripe-package-sync.regression.js
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

// Idempotent fixture admin (mirrors setup-approval-fixtures.js's pattern for the client-ledger side,
// adapted for platform_admins since no shared fixture file exists for the admin panel yet).
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
  const cleanup = { packageIds: [], stripePriceIds: [], stripeProductIds: [] };
  try {
    console.log('Ensuring fixtures...');
    await ensureFixtureAdmin();
    await login();

    // ============================================================================================
    // (1) สร้างแพ็กเกจใหม่ (ราคาหลัก + ราคาที่นั่งเพิ่ม) -> ต้องได้ Stripe Product/Price จริง
    // ============================================================================================
    console.log('\n=== (1) สร้างแพ็กเกจใหม่ + sync ขึ้น Stripe ===');
    const uniq = Date.now();
    const created = await call('POST', '/api/admin/packages', {
      name: `E2E Stripe Sync Test ${uniq}`, price: 999, billingCycle: 'monthly', maxUsers: 3, seatPrice: 199,
    });
    const pkg = created.package;
    cleanup.packageIds.push(pkg.id);
    assert(!!pkg.stripe_product_id && !!pkg.stripe_price_id && !!pkg.stripe_seat_price_id, 'สร้างสำเร็จ ได้ stripe_product_id/stripe_price_id/stripe_seat_price_id ครบ');

    const stripeProduct = await stripe.products.retrieve(pkg.stripe_product_id);
    assert(stripeProduct.name === `E2E Stripe Sync Test ${uniq}`, 'Stripe Product ชื่อตรงกับที่ส่งมาจริง');
    const stripeBasePrice = await stripe.prices.retrieve(pkg.stripe_price_id);
    assert(stripeBasePrice.unit_amount === 99900 && stripeBasePrice.active, `Stripe Price หลัก = 99900 สตางค์ (999 บาท) และ active จริง (ได้ ${stripeBasePrice.unit_amount})`);
    const stripeSeatPrice = await stripe.prices.retrieve(pkg.stripe_seat_price_id);
    assert(stripeSeatPrice.unit_amount === 19900 && stripeSeatPrice.active, `Stripe Price ที่นั่งเพิ่ม = 19900 สตางค์ (199 บาท) และ active จริง (ได้ ${stripeSeatPrice.unit_amount})`);

    // ============================================================================================
    // (2) แก้ไขโดยไม่เปลี่ยนราคา -> ต้องได้ stripe_price_id เดิม ไม่สร้างซ้ำ
    // ============================================================================================
    console.log('\n=== (2) แก้ไขไม่เปลี่ยนราคา -> idempotent ===');
    const noChange = await call('PUT', `/api/admin/packages/${pkg.id}`, {
      name: `E2E Stripe Sync Test ${uniq} Edited`, price: 999, billingCycle: 'monthly', maxUsers: 5, seatPrice: 199,
    });
    assert(noChange.package.stripe_price_id === pkg.stripe_price_id, 'ราคาหลักไม่เปลี่ยน -> stripe_price_id เดิม ไม่สร้าง Price ซ้ำ');
    assert(noChange.package.stripe_seat_price_id === pkg.stripe_seat_price_id, 'ราคาที่นั่งเพิ่มไม่เปลี่ยน -> stripe_seat_price_id เดิม');
    const productAfterNameChange = await stripe.products.retrieve(pkg.stripe_product_id);
    assert(productAfterNameChange.name === `E2E Stripe Sync Test ${uniq} Edited`, 'ชื่อ Stripe Product อัปเดตตามชื่อแพ็กเกจใหม่จริง (Product แก้ในตัวได้ ต่างจาก Price)');

    // ============================================================================================
    // (3) แก้ไขเปลี่ยนราคาจริง -> ต้องได้ stripe_price_id ใหม่ + ของเก่าถูก archive (active=false)
    // ============================================================================================
    console.log('\n=== (3) เปลี่ยนราคาจริง -> Price ใหม่ + archive ของเก่า ===');
    const oldPriceId = pkg.stripe_price_id;
    const priceChanged = await call('PUT', `/api/admin/packages/${pkg.id}`, {
      name: `E2E Stripe Sync Test ${uniq} Edited`, price: 1299, billingCycle: 'monthly', maxUsers: 5, seatPrice: 199,
    });
    const newPriceId = priceChanged.package.stripe_price_id;
    assert(newPriceId !== oldPriceId, `เปลี่ยนราคา 999->1299 ได้ stripe_price_id ใหม่จริง (เดิม ${oldPriceId} ใหม่ ${newPriceId})`);
    const oldPriceAfter = await stripe.prices.retrieve(oldPriceId);
    assert(oldPriceAfter.active === false, 'Price เดิมถูก archive (active=false) แล้วจริง ไม่ถูกลบทิ้ง (subscription เดิมที่ผูกอยู่ยังใช้งานต่อได้)');
    const newPriceAfter = await stripe.prices.retrieve(newPriceId);
    assert(newPriceAfter.active === true && newPriceAfter.unit_amount === 129900, `Price ใหม่ active จริงและมีค่า 129900 สตางค์ (1299 บาท) (ได้ ${newPriceAfter.unit_amount})`);
    cleanup.stripePriceIds.push(oldPriceId, newPriceId);

    // ============================================================================================
    // (4) เคลียร์ seatPrice เป็น null -> ต้อง archive stripe_seat_price_id เดิม + เซ็ต null ในระบบเรา
    // (ไม่ fallback เป็น 0 — CLAUDE.md ข้อ 17)
    // ============================================================================================
    console.log('\n=== (4) เคลียร์ seatPrice เป็น null -> archive Price เดิม ไม่ fallback เป็น 0 ===');
    const oldSeatPriceId = pkg.stripe_seat_price_id;
    const seatRemoved = await call('PUT', `/api/admin/packages/${pkg.id}`, {
      name: `E2E Stripe Sync Test ${uniq} Edited`, price: 1299, billingCycle: 'monthly', maxUsers: 5, seatPrice: null,
    });
    assert(seatRemoved.package.seat_price === null, 'seat_price ในระบบเราเป็น null จริง ไม่ใช่ 0');
    assert(seatRemoved.package.stripe_seat_price_id === null, 'stripe_seat_price_id ถูกเคลียร์เป็น null ในระบบเราด้วย');
    const oldSeatPriceAfter = await stripe.prices.retrieve(oldSeatPriceId);
    assert(oldSeatPriceAfter.active === false, 'Price ที่นั่งเพิ่มเดิมบน Stripe ถูก archive (active=false) แล้วจริง');
    cleanup.stripePriceIds.push(oldSeatPriceId);

    // ============================================================================================
    // (5) toggle-active ปิด -> archive Price หลักบน Stripe ด้วย, เปิดกลับ -> reactivate
    // ============================================================================================
    console.log('\n=== (5) toggle-active ผูกกับสถานะ Stripe Price จริง ===');
    const toggledOff = await call('POST', `/api/admin/packages/${pkg.id}/toggle-active`, {});
    assert(toggledOff.package.active === false, 'ปิดใช้งานแพ็กเกจสำเร็จในระบบเรา');
    const priceAfterToggleOff = await stripe.prices.retrieve(newPriceId);
    assert(priceAfterToggleOff.active === false, 'Price หลักบน Stripe ถูก archive ตามไปด้วยจริง (ซื้อผ่าน Stripe ไม่ได้แล้ว)');

    const toggledOn = await call('POST', `/api/admin/packages/${pkg.id}/toggle-active`, {});
    assert(toggledOn.package.active === true, 'เปิดใช้งานแพ็กเกจกลับสำเร็จ');
    const priceAfterToggleOn = await stripe.prices.retrieve(newPriceId);
    assert(priceAfterToggleOn.active === true, 'Price หลักบน Stripe reactivate กลับเป็น active จริง (ไม่ใช่ object ใหม่ — Stripe อนุญาตตั้ง active กลับได้)');
    cleanup.stripeProductIds.push(pkg.stripe_product_id);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body ? JSON.stringify(err.body) : '');
    process.exitCode = 1;
  } finally {
    try {
      // เก็บกวาด Stripe test-mode objects ที่สร้างระหว่างเทส (archive เท่านั้น ลบจริงไม่ได้เพราะเคยมี Price
      // ผูกอยู่) + ลบแถว packages ทดสอบออกจาก DB เรา — คง fixture admin ไว้ใช้ซ้ำรอบหน้า (idempotent)
      for (const priceId of cleanup.stripePriceIds) {
        await stripe.prices.update(priceId, { active: false }).catch(() => {});
      }
      for (const productId of cleanup.stripeProductIds) {
        await stripe.products.update(productId, { active: false }).catch(() => {});
      }
      if (cleanup.packageIds.length) {
        await pool.query('DELETE FROM packages WHERE id = ANY($1)', [cleanup.packageIds]);
      }
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
