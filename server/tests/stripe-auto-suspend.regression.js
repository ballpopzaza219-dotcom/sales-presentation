// Regression suite — Stripe Billing stage 4 (auto-suspend cron + platform_company_status_log audit
// trail, migration 0028). Covers 3 code paths that all write to the same log table:
//   (a) runAutoSuspendSweep() from server/lib/auto-suspend.js — the SAME function the real cron in
//       server.js calls (imported directly here, not copied, since cron schedules cannot be triggered
//       on-demand over HTTP and there is no manual-trigger endpoint) — this avoids the exact bug class
//       that hit AUDIT_DOC_TYPES_FULL in attachments-void-cancel.regression.js earlier this session,
//       where a hardcoded copy silently drifted from the real logic
//   (b) reactivateCompanyIfSuspended() via real Stripe webhooks (checkout.session.completed /
//       invoice.paid) — auto-reactivation after a payment succeeds
//   (c) the manual POST /api/admin/companies/:id/suspend endpoint (admin-toggled, changed_by set)
//
// Also asserts the negative case explicitly required by the design: a company that was never
// suspended completing a checkout must NOT get a spurious platform_company_status_log row.
//
// Prerequisites: dev server running, server/.env with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set,
// Basic package already synced to Stripe (stage 1), migration 0028 applied.
// Run: cd server && node tests/stripe-auto-suspend.regression.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { runAutoSuspendSweep, AUTO_SUSPEND_GRACE_PERIOD_DAYS } = require('../lib/auto-suspend');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
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

async function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
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
function fakeEventId() { return 'evt_test_autosuspend_' + Date.now() + '_' + (evtCounter++); }

async function ensureFixtureAdmin() {
  const existing = await pool.query('SELECT id FROM platform_admins WHERE email=$1', [FIXTURE_ADMIN_EMAIL]);
  if (existing.rowCount > 0) return existing.rows[0].id;
  const hash = await bcrypt.hash(FIXTURE_ADMIN_PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO platform_admins (email, password_hash, name, role, active) VALUES ($1,$2,'E2E Stripe Fixture','owner',true) RETURNING id`,
    [FIXTURE_ADMIN_EMAIL, hash]
  );
  return r.rows[0].id;
}
async function login() {
  const r = await call('POST', '/api/admin/login', { email: FIXTURE_ADMIN_EMAIL, password: FIXTURE_ADMIN_PASSWORD });
  return r.admin.id;
}

// สร้าง Stripe Customer + real active Subscription จริง (ผ่าน pm_card_visa test payment method)
// เหมือน stripe-webhook.regression.js ทุกประการ — ใช้สำหรับทดสอบ webhook path ของสเตจนี้
async function createRealStripeSubscription(cleanup, priceId) {
  const stripeCustomer = await stripe.customers.create({ name: 'E2E Auto-Suspend Test Customer' });
  cleanup.stripeCustomerIds.push(stripeCustomer.id);
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: stripeCustomer.id });
  await stripe.customers.update(stripeCustomer.id, { invoice_settings: { default_payment_method: pm.id } });
  const stripeSubscription = await stripe.subscriptions.create({ customer: stripeCustomer.id, items: [{ price: priceId }] });
  cleanup.stripeSubscriptionIds.push(stripeSubscription.id);
  return { stripeCustomer, stripeSubscription };
}

(async () => {
  const cleanup = { stripeCustomerIds: [], stripeSubscriptionIds: [], companyIds: [] };
  try {
    console.log('Setting up fixtures...');
    const adminId = await ensureFixtureAdmin();
    await login();
    const basicPkg = (await pool.query(`SELECT id, stripe_price_id FROM packages WHERE name='Basic'`)).rows[0];
    assert(!!basicPkg.stripe_price_id, 'sanity check: แพ็กเกจ Basic sync ขึ้น Stripe แล้วจริง (จาก stage 1)');

    // ============================================================================================
    // (1) Cron logic (query เดียวกับใน server.js เป๊ะ — copy มาตรงๆ เพราะ cron schedule เรียกผ่าน HTTP
    // ตรงๆ ไม่ได้): บริษัทที่ payment_failed_at เกิน grace period ต้องถูก suspend, บริษัทที่ยังไม่เกิน
    // ต้องไม่ถูกแตะ
    // ============================================================================================
    console.log('\n=== (1) Cron: auto-suspend บริษัทที่พ้น grace period เท่านั้น ===');
    const uniq = Date.now();
    const overdueCo = (await pool.query(
      `INSERT INTO customer_companies (name, tax_id, phone, email, status, payment_failed_at)
       VALUES ($1,'1111111111111','02-000-0000','e2e-autosuspend-overdue@example.com','active', now() - interval '4 days')
       RETURNING id`,
      [`E2E AutoSuspend Overdue Co ${uniq}`]
    )).rows[0];
    cleanup.companyIds.push(overdueCo.id);
    const withinGraceCo = (await pool.query(
      `INSERT INTO customer_companies (name, tax_id, phone, email, status, payment_failed_at)
       VALUES ($1,'1111111111111','02-000-0000','e2e-autosuspend-within@example.com','active', now() - interval '1 day')
       RETURNING id`,
      [`E2E AutoSuspend WithinGrace Co ${uniq}`]
    )).rows[0];
    cleanup.companyIds.push(withinGraceCo.id);

    // เรียก runAutoSuspendSweep() ตัวเดียวกับที่ cron จริงใน server.js เรียกตรงๆ (import มาจาก
    // ../lib/auto-suspend ไม่ใช่ copy SQL มาเขียนซ้ำ) — ส่ง companyIdsFilter จำกัดเฉพาะ 2 บริษัท fixture
    // นี้เท่านั้น กันไม่ให้เทสไปกวาด/suspend บริษัทจริงอื่นๆ ในฐาน dev โดยไม่ตั้งใจ (พารามิเตอร์นี้มีไว้
    // สำหรับเทสโดยเฉพาะ — cron จริงเรียกโดยไม่ส่งค่านี้เสมอ)
    const client = await pool.connect();
    let suspendedRows;
    try {
      await client.query('BEGIN');
      suspendedRows = await runAutoSuspendSweep(client, [overdueCo.id, withinGraceCo.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    assert(suspendedRows.length === 1 && suspendedRows[0].id === overdueCo.id, `มีแค่บริษัทที่เกิน grace period ถูก suspend เท่านั้น (ได้ ${suspendedRows.length} แถว)`);
    const overdueAfter = (await pool.query('SELECT status FROM customer_companies WHERE id=$1', [overdueCo.id])).rows[0];
    assert(overdueAfter.status === 'suspended', 'บริษัทที่เกิน grace period ถูก suspend จริง');
    const withinAfter = (await pool.query('SELECT status FROM customer_companies WHERE id=$1', [withinGraceCo.id])).rows[0];
    assert(withinAfter.status === 'active', 'บริษัทที่ยังไม่เกิน grace period ยังเป็น active เหมือนเดิม ไม่ถูกแตะ');

    const overdueLog = (await pool.query(`SELECT * FROM platform_company_status_log WHERE company_id=$1`, [overdueCo.id])).rows;
    assert(overdueLog.length === 1, `มี log แถวเดียวสำหรับบริษัทที่ถูก auto-suspend (ได้ ${overdueLog.length})`);
    assert(overdueLog[0].changed_by === null, 'changed_by เป็น NULL (ระบบทำเอง ไม่ใช่ admin กด)');
    assert(overdueLog[0].from_status === 'active' && overdueLog[0].to_status === 'suspended', 'from/to status ถูกต้อง');
    assert(overdueLog[0].reason.includes('auto-suspend:') && overdueLog[0].reason.includes(String(AUTO_SUSPEND_GRACE_PERIOD_DAYS)), `reason มีคำอธิบาย auto-suspend + จำนวนวัน grace period (ได้ "${overdueLog[0].reason}")`);
    const withinLogCount = (await pool.query(`SELECT count(*)::int AS n FROM platform_company_status_log WHERE company_id=$1`, [withinGraceCo.id])).rows[0].n;
    assert(withinLogCount === 0, 'บริษัทที่ยังไม่เกิน grace period ไม่มี log ใดๆ ถูกสร้างขึ้นเลย');

    // ============================================================================================
    // (2) Auto-reactivate ผ่าน webhook invoice.paid จริง — บริษัทที่เพิ่งถูก auto-suspend (จาก (1))
    // จ่ายเงินสำเร็จ (รอบต่ออายุ) -> ต้อง reactivate ทันที + เคลียร์ payment_failed_at + log ถูกต้อง
    // ============================================================================================
    console.log('\n=== (2) Auto-reactivate ผ่าน invoice.paid webhook จริง หลังเคย auto-suspend ===');
    const { stripeSubscription: subForReactivate } = await createRealStripeSubscription(cleanup, basicPkg.stripe_price_id);
    // ผูก subscription เข้ากับบริษัทที่ถูก suspend ไปแล้วตรงๆ (ไม่ผ่าน checkout.session.completed เพราะ
    // จุดสนใจของเทสนี้คือ invoice.paid -> reactivateCompanyIfSuspended เท่านั้น)
    await pool.query(
      `INSERT INTO subscriptions (company_id, tier, max_users, status, stripe_subscription_id, stripe_price_id)
       VALUES ($1,'basic',5,'expired',$2,$3)`,
      [overdueCo.id, subForReactivate.id, basicPkg.stripe_price_id]
    );
    // ต้องใช้ Invoice object จริงจาก Stripe (ไม่ใช่ hand-crafted fake) เพราะ handleInvoicePaid ตอนนี้เรียก
    // getInvoiceChargeId() จริงเพื่อบันทึกลง invoices ledger (สเตจ 5) — fake invoice id ที่ไม่มีจริงบน
    // Stripe จะทำให้ handler พังตอนเรียก API จริง (บั๊ก class เดียวกับที่เพิ่งแก้ใน
    // stripe-webhook.regression.js: invoice.subscription ไม่มี field นี้แล้วในเวอร์ชัน API ปัจจุบัน)
    const realInvoices = await stripe.invoices.list({ subscription: subForReactivate.id, limit: 1 });
    const realInvoice = realInvoices.data[0];
    const paidEvent = { id: fakeEventId(), type: 'invoice.paid', data: { object: realInvoice } };
    const rPaid = await postWebhook(paidEvent);
    assert(rPaid.status === 200 && rPaid.json.received === true, `webhook invoice.paid ประมวลผลสำเร็จ (ได้ status=${rPaid.status})`);

    const overdueAfterReactivate = (await pool.query('SELECT status, payment_failed_at FROM customer_companies WHERE id=$1', [overdueCo.id])).rows[0];
    assert(overdueAfterReactivate.status === 'active', 'บริษัทกลับมา active ทันทีหลังจ่ายเงินสำเร็จ (auto-reactivate ไม่ต้องรอ admin)');
    assert(overdueAfterReactivate.payment_failed_at === null, 'payment_failed_at ถูกเคลียร์กลับเป็น NULL');
    const reactivateLog = (await pool.query(`SELECT * FROM platform_company_status_log WHERE company_id=$1 ORDER BY id`, [overdueCo.id])).rows;
    assert(reactivateLog.length === 2, `มี log รวม 2 แถวแล้ว (auto-suspend เดิม + auto-reactivate ใหม่) (ได้ ${reactivateLog.length})`);
    const reactivateEntry = reactivateLog[1];
    assert(reactivateEntry.from_status === 'suspended' && reactivateEntry.to_status === 'active', 'entry ที่สองคือ suspended->active ถูกต้อง');
    assert(reactivateEntry.changed_by === null, 'changed_by เป็น NULL (reactivate อัตโนมัติจาก webhook ไม่ใช่ admin กด)');

    // ============================================================================================
    // (3) กรณีลบล้าง (negative case) — บริษัทที่ไม่เคยถูก suspend เลย จ่ายเงินสำเร็จผ่าน checkout ใหม่
    // ต้อง "ไม่" มี log ใดๆ ถูกสร้าง (กัน log spam จากเคสปกติทั่วไปที่ไม่มีอะไรผิดปกติ)
    // ============================================================================================
    console.log('\n=== (3) บริษัทที่ไม่เคย suspend มาก่อน + checkout สำเร็จ -> ไม่มี log spam ===');
    const neverSuspendedCo = (await call('POST', '/api/admin/companies', {
      name: `E2E AutoSuspend NeverSuspended Co ${uniq}`, taxId: '1111111111111', phone: '02-000-0000', email: 'e2e-autosuspend-never@example.com',
    })).company;
    cleanup.companyIds.push(neverSuspendedCo.id);
    const { stripeCustomer: custNeverSuspended, stripeSubscription: subNeverSuspended } = await createRealStripeSubscription(cleanup, basicPkg.stripe_price_id);
    const checkoutEvent = {
      id: fakeEventId(), type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_autosuspend_never', mode: 'subscription', subscription: subNeverSuspended.id, customer: custNeverSuspended.id,
        metadata: { company_id: String(neverSuspendedCo.id), package_id: String(basicPkg.id), additional_seats: '0' },
      } },
    };
    const rCheckout = await postWebhook(checkoutEvent);
    assert(rCheckout.status === 200 && rCheckout.json.received === true, `webhook checkout.session.completed ประมวลผลสำเร็จ (ได้ status=${rCheckout.status})`);
    const neverSuspendedLogCount = (await pool.query(`SELECT count(*)::int AS n FROM platform_company_status_log WHERE company_id=$1`, [neverSuspendedCo.id])).rows[0].n;
    assert(neverSuspendedLogCount === 0, 'บริษัทที่ไม่เคย suspend มาก่อน + checkout สำเร็จปกติ -> ไม่มี log ใดๆ ถูกสร้างขึ้นเลย (ไม่ spam)');

    // ============================================================================================
    // (4) Manual suspend/reactivate ผ่าน POST /api/admin/companies/:id/suspend -> log ต้องมี
    // changed_by = admin.id (ทั้งสองทิศทาง)
    // ============================================================================================
    console.log('\n=== (4) Manual suspend/reactivate ผ่าน admin endpoint -> changed_by = admin จริง ===');
    const manualCo = (await call('POST', '/api/admin/companies', {
      name: `E2E AutoSuspend Manual Co ${uniq}`, taxId: '1111111111111', phone: '02-000-0000', email: 'e2e-autosuspend-manual@example.com',
    })).company;
    cleanup.companyIds.push(manualCo.id);
    assert(manualCo.status === 'active', 'sanity check: บริษัทใหม่เริ่มที่ active');

    const suspendResp = await call('POST', `/api/admin/companies/${manualCo.id}/suspend`);
    assert(suspendResp.company.status === 'suspended', `admin กด suspend -> status เปลี่ยนเป็น suspended จริง (ได้ ${suspendResp.company.status})`);
    const manualLog1 = (await pool.query(`SELECT * FROM platform_company_status_log WHERE company_id=$1 ORDER BY id`, [manualCo.id])).rows;
    assert(manualLog1.length === 1, `มี log 1 แถวหลัง suspend ครั้งแรก (ได้ ${manualLog1.length})`);
    assert(manualLog1[0].changed_by === adminId, `changed_by = admin.id จริง (ได้ ${manualLog1[0].changed_by}, คาดหวัง ${adminId})`);
    assert(manualLog1[0].from_status === 'active' && manualLog1[0].to_status === 'suspended', 'from/to ถูกต้อง (active->suspended)');
    assert(manualLog1[0].reason.includes('admin'), `reason ระบุว่า admin เป็นคนกด (ได้ "${manualLog1[0].reason}")`);

    const reactivateResp = await call('POST', `/api/admin/companies/${manualCo.id}/suspend`);
    assert(reactivateResp.company.status === 'active', `admin กดอีกครั้ง (toggle) -> status กลับเป็น active จริง (ได้ ${reactivateResp.company.status})`);
    const manualLog2 = (await pool.query(`SELECT * FROM platform_company_status_log WHERE company_id=$1 ORDER BY id`, [manualCo.id])).rows;
    assert(manualLog2.length === 2, `มี log รวม 2 แถวหลัง toggle กลับ (ได้ ${manualLog2.length})`);
    assert(manualLog2[1].changed_by === adminId, 'changed_by = admin.id จริงในทิศทางกลับด้วยเช่นกัน');
    assert(manualLog2[1].from_status === 'suspended' && manualLog2[1].to_status === 'active', 'from/to ถูกต้อง (suspended->active)');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      for (const subId of cleanup.stripeSubscriptionIds) { await stripe.subscriptions.cancel(subId).catch(() => {}); }
      for (const custId of cleanup.stripeCustomerIds) { await stripe.customers.del(custId).catch(() => {}); }
      if (cleanup.companyIds.length) {
        // journal_entries.source_id ไม่มี FK cascade จาก invoices/customer_companies (polymorphic
        // reference ธรรมดา) — ต้องลบเองก่อน เพราะ test (2) ตอนนี้ trigger recordStripeInvoicePayment
        // จริงผ่าน invoice.paid webhook (สร้างแถว invoices/invoice_payments/journal_entries จริง)
        const staleInvoiceIds = (await pool.query('SELECT id FROM invoices WHERE company_id = ANY($1)', [cleanup.companyIds])).rows.map(r => r.id);
        const stalePaymentIds = staleInvoiceIds.length
          ? (await pool.query('SELECT id FROM invoice_payments WHERE invoice_id = ANY($1)', [staleInvoiceIds])).rows.map(r => r.id)
          : [];
        if (staleInvoiceIds.length) await pool.query(`DELETE FROM journal_entries WHERE source_type='invoice' AND source_id = ANY($1)`, [staleInvoiceIds]);
        if (stalePaymentIds.length) await pool.query(`DELETE FROM journal_entries WHERE source_type='payment' AND source_id = ANY($1)`, [stalePaymentIds]);
        await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [cleanup.companyIds]);
        // platform_company_status_log/invoices/invoice_payments/invoice_ledger_entries มี ON DELETE
        // CASCADE จาก customer_companies อยู่แล้ว ไม่ต้องลบแยก
        await pool.query('DELETE FROM customer_companies WHERE id = ANY($1)', [cleanup.companyIds]);
      }
      await pool.query(`DELETE FROM platform_webhook_events WHERE stripe_event_id LIKE 'evt_test_autosuspend_%'`);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
