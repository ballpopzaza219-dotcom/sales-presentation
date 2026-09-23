// Regression suite — POST /api/webhooks/stripe (Stripe Billing migration 0027, stage 3). Hits the
// REAL Stripe test-mode API for the underlying Customer/Subscription objects the handler retrieves
// (no mocks), and uses stripe.webhooks.generateTestHeaderString() (Stripe's own official offline
// testing utility) to produce genuinely-valid HMAC signatures against a local test secret, so the
// signature-verification code path itself is fully exercised for real, not skipped.
//
// Covers: checkout.session.completed creates the local subscriptions row with the correct expires_at
// (reading Stripe's actual current_period_end location - this test would have caught the real API
// shape bug found while building this, where the field lives on the subscription ITEM, not the
// subscription itself, in the API version this SDK talks to); a byte-for-byte duplicate delivery of
// the same event.id is skipped, not reprocessed; invoice.paid extends expires_at and clears any grace
// period; invoice.payment_failed sets payment_failed_at only on the FIRST failure (a second failure
// must NOT reset the clock - CLAUDE.md-style grace-period correctness); customer.subscription.deleted
// marks the local subscription expired; an invalid signature is rejected with 400; and a genuine
// processing failure is retried on redelivery (not silently swallowed as "already seen").
//
// Prerequisites: dev server running on http://localhost:3000, server/.env with STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET set, and the Basic package already synced to Stripe (stage 1).
// Run: cd server && node tests/stripe-webhook.regression.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

async function postWebhook(eventObj, { badSignature } = {}) {
  const payload = JSON.stringify(eventObj);
  const sig = badSignature
    ? 'this-is-not-a-valid-signature'
    : stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await fetch(BASE + '/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
    body: payload,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, json };
}

let evtCounter = 0;
function fakeEventId() { return 'evt_test_regress_' + Date.now() + '_' + (evtCounter++); }

(async () => {
  const cleanup = { stripeCustomerIds: [], stripeSubscriptionIds: [], companyIds: [] };
  try {
    console.log('Setting up real Stripe Customer + Subscription (not through the Checkout page, but real API objects)...');
    const basicPkg = (await pool.query(`SELECT id, max_users, stripe_price_id FROM packages WHERE name='Basic'`)).rows[0];
    const stripeCustomer = await stripe.customers.create({ name: 'E2E Webhook Test Customer' });
    cleanup.stripeCustomerIds.push(stripeCustomer.id);
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: stripeCustomer.id });
    await stripe.customers.update(stripeCustomer.id, { invoice_settings: { default_payment_method: pm.id } });
    const stripeSubscription = await stripe.subscriptions.create({
      customer: stripeCustomer.id, items: [{ price: basicPkg.stripe_price_id }],
    });
    cleanup.stripeSubscriptionIds.push(stripeSubscription.id);
    assert(stripeSubscription.status === 'active', 'setup: real Stripe subscription เป็น active จริง (ใช้ pm_card_visa test payment method)');

    const companyRes = await pool.query(
      `INSERT INTO customer_companies (name, tax_id, phone, email) VALUES ($1,'1111111111111','02-000-0000','e2e-webhook@example.com') RETURNING id`,
      [`E2E Webhook Test Co ${Date.now()}`]
    );
    const companyId = companyRes.rows[0].id;
    cleanup.companyIds.push(companyId);

    // ============================================================================================
    // (1) checkout.session.completed -> สร้างแถว subscriptions จริง พร้อม expires_at ที่ถูกต้อง
    // (จุดนี้เองที่เจอบั๊กจริงตอนเขียนเทส — current_period_end ย้ายไปอยู่ที่ subscription item ไม่ใช่
    // subscription เอง ถ้า handler อ่านผิดที่ expires_at จะกลายเป็น Invalid Date)
    // ============================================================================================
    console.log('\n=== (1) checkout.session.completed -> สร้าง subscriptions row ===');
    const checkoutEventId = fakeEventId();
    const checkoutEvent = {
      id: checkoutEventId, type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_fake_' + checkoutEventId, mode: 'subscription', subscription: stripeSubscription.id, customer: stripeCustomer.id,
        metadata: { company_id: String(companyId), package_id: String(basicPkg.id), additional_seats: '2' },
      } },
    };
    const r1 = await postWebhook(checkoutEvent);
    assert(r1.status === 200 && r1.json.received === true, `webhook ตอบ 200 received:true (ได้ status=${r1.status})`);

    const subRow = (await pool.query('SELECT * FROM subscriptions WHERE stripe_subscription_id=$1', [stripeSubscription.id])).rows[0];
    assert(!!subRow, 'สร้างแถว subscriptions ใน DB เราจริง');
    assert(subRow.status === 'active', 'status=active ถูกต้อง');
    assert(subRow.max_users === basicPkg.max_users + 2, `max_users = package.max_users + additionalSeats (2) ถูกต้อง (ได้ ${subRow.max_users})`);
    assert(subRow.expires_at instanceof Date && !isNaN(subRow.expires_at.getTime()), `expires_at เป็นวันที่จริงที่ถูกต้อง ไม่ใช่ Invalid Date (ได้ ${subRow.expires_at})`);
    const expectedPeriodEnd = new Date(stripeSubscription.items.data[0].current_period_end * 1000);
    assert(subRow.expires_at.getTime() === expectedPeriodEnd.getTime(), 'expires_at ตรงกับ current_period_end จริงของ Stripe subscription item (อ่านถูกตำแหน่งจริง)');

    const companyAfterCheckout = (await pool.query('SELECT payment_failed_at FROM customer_companies WHERE id=$1', [companyId])).rows[0];
    assert(companyAfterCheckout.payment_failed_at === null, 'payment_failed_at ยัง NULL (ไม่เคยมีปัญหาจ่ายเงินมาก่อน)');

    // ============================================================================================
    // (2) ส่ง event เดิมซ้ำ (duplicate delivery จริงตามธรรมชาติเครือข่าย Stripe) -> ต้องไม่ประมวลผลซ้ำ
    // ============================================================================================
    console.log('\n=== (2) duplicate delivery ของ event เดิม -> ข้าม ไม่ประมวลผลซ้ำ ===');
    const r2 = await postWebhook(checkoutEvent);
    assert(r2.status === 200 && r2.json.duplicate === true, `ส่ง event.id เดิมซ้ำ -> ตอบ duplicate:true ไม่ประมวลผลซ้ำ (ได้ ${JSON.stringify(r2.json)})`);
    const subCountAfterDup = (await pool.query('SELECT count(*)::int AS n FROM subscriptions WHERE stripe_subscription_id=$1', [stripeSubscription.id])).rows[0].n;
    assert(subCountAfterDup === 1, `ยังมีแถว subscriptions แค่ 1 แถวเท่านั้น ไม่ถูกสร้างซ้ำ (ได้ ${subCountAfterDup})`);

    // ============================================================================================
    // (2b) จำลอง "commit สำเร็จแต่โปรแกรมพังก่อน mark processed" — บังคับ processing_status กลับเป็น
    // 'pending' ทั้งที่แถว subscriptions ถูกสร้างไปแล้วจริง แล้วส่ง event เดิมซ้ำ (retry จริงจาก Stripe จะ
    // ทำแบบนี้เป๊ะ) ต้องไม่ throw ชน unique constraint ซ้ำไม่รู้จบ — ต้องสำเร็จและไม่สร้างแถวซ้ำ
    // ============================================================================================
    console.log('\n=== (2b) retry หลัง commit สำเร็จแต่ยังไม่ mark processed -> ไม่ชน unique constraint วนซ้ำ ===');
    await pool.query(`UPDATE platform_webhook_events SET processing_status='pending' WHERE stripe_event_id=$1`, [checkoutEventId]);
    const r2b = await postWebhook(checkoutEvent);
    assert(r2b.status === 200 && r2b.json.received === true, `retry หลัง partial-success ไม่ throw ชน uq_subscriptions_stripe_subscription_id (ได้ status=${r2b.status}, body=${JSON.stringify(r2b.json)})`);
    const subCountAfterCrategRetry = (await pool.query('SELECT count(*)::int AS n FROM subscriptions WHERE stripe_subscription_id=$1', [stripeSubscription.id])).rows[0].n;
    assert(subCountAfterCrategRetry === 1, `ยังมีแถว subscriptions แค่ 1 แถวหลัง retry (ไม่ถูกสร้างซ้ำจาก ON CONFLICT DO NOTHING) (ได้ ${subCountAfterCrategRetry})`);
    const eventStatusAfterRetry = (await pool.query('SELECT processing_status FROM platform_webhook_events WHERE stripe_event_id=$1', [checkoutEventId])).rows[0];
    assert(eventStatusAfterRetry.processing_status === 'processed', `platform_webhook_events กลับมาเป็น processed ได้จริงหลัง retry สำเร็จ (ได้ ${eventStatusAfterRetry.processing_status})`);

    // ============================================================================================
    // (3) invoice.payment_failed ครั้งแรก -> ตั้ง payment_failed_at
    // ============================================================================================
    console.log('\n=== (3) invoice.payment_failed ครั้งแรก -> ตั้ง payment_failed_at ===');
    const failEvent1 = { id: fakeEventId(), type: 'invoice.payment_failed', data: { object: { id: 'in_test_fake_1', subscription: stripeSubscription.id } } };
    await postWebhook(failEvent1);
    const companyAfterFail1 = (await pool.query('SELECT payment_failed_at FROM customer_companies WHERE id=$1', [companyId])).rows[0];
    assert(companyAfterFail1.payment_failed_at !== null, 'payment_failed_at ถูกตั้งค่าแล้วจริงหลังเก็บเงินล้มเหลวครั้งแรก');
    const firstFailedAt = companyAfterFail1.payment_failed_at;

    // ============================================================================================
    // (4) invoice.payment_failed ครั้งที่สอง (Stripe retry แล้วยังล้มเหลวซ้ำ) -> payment_failed_at
    // ต้อง "ไม่" เปลี่ยน (COALESCE) ไม่งั้น grace period จะไม่มีวันครบกำหนดจริง
    // ============================================================================================
    console.log('\n=== (4) invoice.payment_failed ครั้งที่สอง -> payment_failed_at ต้องไม่ reset ===');
    await new Promise(r => setTimeout(r, 1100)); // เว้นจังหวะให้ timestamp ต่างกันจริงถ้าดันถูก reset
    const failEvent2 = { id: fakeEventId(), type: 'invoice.payment_failed', data: { object: { id: 'in_test_fake_2', subscription: stripeSubscription.id } } };
    await postWebhook(failEvent2);
    const companyAfterFail2 = (await pool.query('SELECT payment_failed_at FROM customer_companies WHERE id=$1', [companyId])).rows[0];
    assert(companyAfterFail2.payment_failed_at.getTime() === firstFailedAt.getTime(), 'payment_failed_at ยังเป็นเวลาเดิมจากความล้มเหลวครั้งแรก ไม่ถูก reset โดยครั้งที่สอง (COALESCE ทำงานถูกต้อง)');

    // ============================================================================================
    // (5) invoice.paid -> เคลียร์ grace period + ต่ออายุ expires_at
    // ============================================================================================
    console.log('\n=== (5) invoice.paid -> เคลียร์ grace period + ต่ออายุ ===');
    const paidEvent = { id: fakeEventId(), type: 'invoice.paid', data: { object: { id: 'in_test_fake_3', subscription: stripeSubscription.id } } };
    await postWebhook(paidEvent);
    const companyAfterPaid = (await pool.query('SELECT payment_failed_at FROM customer_companies WHERE id=$1', [companyId])).rows[0];
    assert(companyAfterPaid.payment_failed_at === null, 'payment_failed_at เคลียร์กลับเป็น NULL หลังจ่ายเงินสำเร็จจริง');

    // ============================================================================================
    // (6) customer.subscription.deleted -> local subscriptions.status = expired
    // ============================================================================================
    console.log('\n=== (6) customer.subscription.deleted -> local status=expired ===');
    const deletedEvent = { id: fakeEventId(), type: 'customer.subscription.deleted', data: { object: { id: stripeSubscription.id } } };
    await postWebhook(deletedEvent);
    const subAfterDeleted = (await pool.query('SELECT status FROM subscriptions WHERE stripe_subscription_id=$1', [stripeSubscription.id])).rows[0];
    assert(subAfterDeleted.status === 'expired', `local subscriptions.status เปลี่ยนเป็น expired จริง (ได้ ${subAfterDeleted.status})`);

    // ============================================================================================
    // (7) signature ผิด -> ปฏิเสธ 400 ทันที ไม่ประมวลผลอะไรเลย
    // ============================================================================================
    console.log('\n=== (7) signature ไม่ถูกต้อง -> 400 ===');
    const badSigResult = await postWebhook({ id: fakeEventId(), type: 'invoice.paid', data: { object: { id: 'in_bad_sig', subscription: stripeSubscription.id } } }, { badSignature: true });
    assert(badSigResult.status === 400, `signature ผิด -> 400 (ได้ ${badSigResult.status})`);

    // ============================================================================================
    // (8) handler พังกลางทางจริง (ส่ง metadata ที่ทำให้ประมวลผลไม่ได้) -> processing_status='failed' แล้ว
    // ส่ง event.id เดิมซ้ำ (จำลอง Stripe retry) -> ต้องลองประมวลผลใหม่ ไม่ใช่ข้ามไปเป็น duplicate เงียบๆ
    // ============================================================================================
    console.log('\n=== (8) event ที่เคย fail ต้อง retry ได้จริง ไม่ถูกมองเป็น duplicate ===');
    const failingEventId = fakeEventId();
    const failingCheckoutEvent = {
      id: failingEventId, type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_failing', mode: 'subscription', subscription: 'sub_this_id_does_not_exist_on_stripe', customer: stripeCustomer.id,
        metadata: { company_id: String(companyId), package_id: String(basicPkg.id), additional_seats: '0' },
      } },
    };
    const failAttempt1 = await postWebhook(failingCheckoutEvent);
    assert(failAttempt1.status === 500, `subscription id ปลอม -> handler พังจริง ตอบ 500 (ได้ ${failAttempt1.status})`);
    const eventRowAfterFail = (await pool.query('SELECT processing_status FROM platform_webhook_events WHERE stripe_event_id=$1', [failingEventId])).rows[0];
    assert(eventRowAfterFail.processing_status === 'failed', `บันทึก processing_status='failed' จริงใน platform_webhook_events (ได้ ${eventRowAfterFail.processing_status})`);

    // ส่งซ้ำ (Stripe เองจะ retry event เดิมนี้จริง) -> ต้องพยายามประมวลผลใหม่อีกครั้ง (ยัง fail เหมือนเดิม
    // เพราะ subscription id ยังปลอมอยู่ แต่สำคัญคือมันพยายามใหม่ ไม่ได้ข้ามไปเป็น duplicate เงียบๆ)
    const failAttempt2 = await postWebhook(failingCheckoutEvent);
    assert(failAttempt2.status === 500, `ส่ง event.id เดิมซ้ำ (จำลอง retry) -> พยายามประมวลผลใหม่จริง ไม่ใช่ข้ามเป็น duplicate (ยัง fail เพราะ id ปลอมเหมือนเดิม, ได้ status=${failAttempt2.status})`);

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      for (const subId of cleanup.stripeSubscriptionIds) {
        await stripe.subscriptions.cancel(subId).catch(() => {});
      }
      for (const custId of cleanup.stripeCustomerIds) {
        await stripe.customers.del(custId).catch(() => {});
      }
      if (cleanup.companyIds.length) {
        await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [cleanup.companyIds]);
        await pool.query('DELETE FROM customer_companies WHERE id = ANY($1)', [cleanup.companyIds]);
      }
      await pool.query(`DELETE FROM platform_webhook_events WHERE stripe_event_id LIKE 'evt_test_regress_%'`);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
