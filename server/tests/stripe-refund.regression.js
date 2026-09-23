// Regression suite — POST /api/admin/invoices/:id/refund (Stripe Billing stage 5, migrations 0027/
// 0029/0030/0031). Hits the REAL Stripe test-mode API (refunds.create, no mocks) against a real
// Stripe-collected invoice (created end-to-end via the same checkout.session.completed + invoice.paid
// webhook flow stripe-webhook.regression.js uses).
//
// Covers: happy path (invoice -> refunded, platform_refunds row correct, journal entry Dr1200/Cr1100
// posted with reverses_entry_id pointing at the original payment journal entry); role=owner required
// (staff/admin blocked 403); Idempotency-Key required (400 without it); resending the same
// Idempotency-Key + body returns the cached response without creating a second Stripe refund or a
// second platform_refunds row; a manually-created (non-Stripe) invoice is rejected; an
// already-refunded invoice cannot be refunded again; a missing reason is rejected; and — the core
// property this design exists for — a retry after "Stripe's refund succeeded but our DB transaction
// never committed" (simulated by manually undoing the local DB side effects while leaving the real
// Stripe refund in place) completes cleanly without creating a duplicate Stripe refund or duplicate
// local rows, proving ON CONFLICT (stripe_refund_id) DO NOTHING + the existing-journal check work
// together the same way the stage-3 checkout.session.completed fix did.
//
// Prerequisites: dev server running, server/.env with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set,
// Basic package already synced to Stripe (stage 1), migrations 0027/0029/0030/0031 applied.
// Run: cd server && node tests/stripe-refund.regression.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const OWNER_EMAIL = 'e2e-stripe-fixture@sitereq.local';
const OWNER_PASSWORD = 'E2EStripeFixture123!';
const STAFF_EMAIL = 'e2e-stripe-refund-staff@sitereq.local';
const STAFF_PASSWORD = 'E2EStripeRefundStaff123!';

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

const cookies = {};
async function call(method, urlPath, body, { asRole, headers: extraHeaders } = {}) {
  const headers = { Cookie: cookies[asRole || 'owner'] || '', 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  const res = await fetch(BASE + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookies[asRole || 'owner'] = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, json };
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
function fakeEventId() { return 'evt_test_refund_' + Date.now() + '_' + (evtCounter++); }
let idemCounter = 0;
function fakeIdemKey() { return 'idem_test_refund_' + Date.now() + '_' + (idemCounter++); }

async function ensureAdmin(email, password, role) {
  const existing = await pool.query('SELECT id FROM platform_admins WHERE email=$1', [email]);
  if (existing.rowCount > 0) return existing.rows[0].id;
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO platform_admins (email, password_hash, name, role, active) VALUES ($1,$2,'E2E Refund Fixture',$3,true) RETURNING id`,
    [email, hash, role]
  );
  return r.rows[0].id;
}
async function login(email, password, asRole) {
  const r = await call('POST', '/api/admin/login', { email, password }, { asRole });
  return r.json.admin.id;
}

// สร้างใบแจ้งหนี้ที่ชำระผ่าน Stripe จริงครบวงจร (checkout.session.completed + invoice.paid webhook)
// เหมือน stripe-webhook.regression.js ทุกประการ — ได้แถว invoices ที่มี stripe_charge_id จริงพร้อม refund
async function createPaidStripeInvoice(cleanup) {
  const basicPkg = (await pool.query(`SELECT id, stripe_price_id FROM packages WHERE name='Basic'`)).rows[0];
  const stripeCustomer = await stripe.customers.create({ name: 'E2E Refund Test Customer' });
  cleanup.stripeCustomerIds.push(stripeCustomer.id);
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: stripeCustomer.id });
  await stripe.customers.update(stripeCustomer.id, { invoice_settings: { default_payment_method: pm.id } });
  const stripeSubscription = await stripe.subscriptions.create({ customer: stripeCustomer.id, items: [{ price: basicPkg.stripe_price_id }] });
  cleanup.stripeSubscriptionIds.push(stripeSubscription.id);

  const companyRes = await pool.query(
    `INSERT INTO customer_companies (name, tax_id, phone, email) VALUES ($1,'1111111111111','02-000-0000','e2e-refund@example.com') RETURNING id`,
    [`E2E Refund Test Co ${Date.now()}`]
  );
  const companyId = companyRes.rows[0].id;
  cleanup.companyIds.push(companyId);

  const checkoutEvent = {
    id: fakeEventId(), type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_test_refund_' + Date.now(), mode: 'subscription', subscription: stripeSubscription.id, customer: stripeCustomer.id,
      metadata: { company_id: String(companyId), package_id: String(basicPkg.id), additional_seats: '0' },
    } },
  };
  const rCheckout = await postWebhook(checkoutEvent);
  if (rCheckout.status !== 200) throw new Error('setup: checkout.session.completed webhook failed: ' + JSON.stringify(rCheckout.json));

  const realInvoices = await stripe.invoices.list({ subscription: stripeSubscription.id, limit: 1 });
  const realInvoice = realInvoices.data[0];
  const paidEvent = { id: fakeEventId(), type: 'invoice.paid', data: { object: realInvoice } };
  const rPaid = await postWebhook(paidEvent);
  if (rPaid.status !== 200) throw new Error('setup: invoice.paid webhook failed: ' + JSON.stringify(rPaid.json));

  const invoiceRow = (await pool.query('SELECT * FROM invoices WHERE stripe_invoice_id=$1', [realInvoice.id])).rows[0];
  return { companyId, stripeCustomer, stripeSubscription, invoiceRow };
}

(async () => {
  const cleanup = { stripeCustomerIds: [], stripeSubscriptionIds: [], companyIds: [] };
  try {
    console.log('Setting up fixtures...');
    await ensureAdmin(OWNER_EMAIL, OWNER_PASSWORD, 'owner');
    const staffId = await ensureAdmin(STAFF_EMAIL, STAFF_PASSWORD, 'staff');
    await login(OWNER_EMAIL, OWNER_PASSWORD, 'owner');
    await login(STAFF_EMAIL, STAFF_PASSWORD, 'staff');
    console.log('staff fixture admin id:', staffId);

    // ============================================================================================
    // (1) Happy path — คืนเงินเต็มจำนวนสำเร็จ: invoice->refunded, platform_refunds ถูกต้อง, journal
    // Dr1200/Cr1100 ผูก reverses_entry_id กลับไปยัง journal การรับชำระเดิม
    // ============================================================================================
    console.log('\n=== (1) คืนเงินเต็มจำนวนสำเร็จ ===');
    const { invoiceRow } = await createPaidStripeInvoice(cleanup);
    assert(invoiceRow.status === 'paid', 'sanity check: ใบแจ้งหนี้ทดสอบเป็น paid จริงก่อนคืนเงิน');
    const originalPaymentJournal = (await pool.query(
      `SELECT je.id FROM invoice_payments ip JOIN journal_entries je ON je.source_type='payment' AND je.source_id=ip.id WHERE ip.invoice_id=$1`,
      [invoiceRow.id]
    )).rows[0];
    assert(!!originalPaymentJournal, 'sanity check: มี journal entry การรับชำระเดิมอยู่จริงก่อนคืนเงิน');

    const idemKey1 = fakeIdemKey();
    const r1 = await call('POST', `/api/admin/invoices/${invoiceRow.id}/refund`, { reason: 'ลูกค้าขอยกเลิกสัญญา (เทส)' }, { headers: { 'Idempotency-Key': idemKey1 } });
    assert(r1.status === 200, `refund สำเร็จ (ได้ status=${r1.status}, body=${JSON.stringify(r1.json)})`);
    assert(r1.json.invoice.status === 'refunded', `invoice.status เปลี่ยนเป็น refunded จริง (ได้ ${r1.json.invoice.status})`);
    assert(r1.json.refund.stripeRefundId.startsWith('re_'), `ได้ stripe refund id จริง (ได้ ${r1.json.refund.stripeRefundId})`);

    const stripeRefundObj = await stripe.refunds.retrieve(r1.json.refund.stripeRefundId);
    assert(stripeRefundObj.status === 'succeeded', `Stripe refund object สถานะ succeeded จริง (ได้ ${stripeRefundObj.status})`);
    assert(stripeRefundObj.charge === invoiceRow.stripe_charge_id, 'Stripe refund ผูกกับ charge เดิมของใบแจ้งหนี้นี้จริง');

    const refundRow = (await pool.query('SELECT * FROM platform_refunds WHERE stripe_refund_id=$1', [r1.json.refund.stripeRefundId])).rows[0];
    assert(!!refundRow, 'มีแถว platform_refunds จริง');
    assert(Number(refundRow.amount) === Number(invoiceRow.amount), 'ยอดคืนเงินตรงกับยอดใบแจ้งหนี้เต็มจำนวน');
    assert(refundRow.requested_by !== null, `requested_by บันทึกไว้จริง (ได้ ${refundRow.requested_by})`);

    const refundJournal = (await pool.query(`SELECT * FROM journal_entries WHERE source_type='refund' AND source_id=$1`, [refundRow.id])).rows[0];
    assert(!!refundJournal, 'มี journal entry การคืนเงินจริง');
    assert(refundJournal.reverses_entry_id === originalPaymentJournal.id, `journal การคืนเงินผูก reverses_entry_id กลับไปยัง journal การรับชำระเดิมถูกต้อง (ได้ ${refundJournal.reverses_entry_id}, คาดหวัง ${originalPaymentJournal.id})`);
    const refundLines = (await pool.query('SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY account_code', [refundJournal.id])).rows;
    assert(refundLines.length === 2, `journal การคืนเงินมี 2 บรรทัดถูกต้อง (ได้ ${refundLines.length})`);
    const line1200 = refundLines.find(l => l.account_code === '1200');
    const line1100 = refundLines.find(l => l.account_code === '1100');
    assert(!!line1200 && Number(line1200.debit_amount) === Number(invoiceRow.amount) && Number(line1200.credit_amount) === 0, `บัญชี 1200 (ลูกหนี้การค้า) Dr = ยอดเต็มจำนวนถูกต้อง (ได้ ${line1200 && line1200.debit_amount})`);
    assert(!!line1100 && Number(line1100.credit_amount) === Number(invoiceRow.amount) && Number(line1100.debit_amount) === 0, `บัญชี 1100 (เงินสด) Cr = ยอดเต็มจำนวนถูกต้อง (ได้ ${line1100 && line1100.credit_amount})`);

    // ============================================================================================
    // (2) resend คำขอเดิมด้วย Idempotency-Key เดิม -> คืน response ที่ cache ไว้ ไม่คืนเงินซ้ำ
    // ============================================================================================
    console.log('\n=== (2) resend ด้วย Idempotency-Key เดิม -> ไม่คืนเงินซ้ำ ===');
    const r2 = await call('POST', `/api/admin/invoices/${invoiceRow.id}/refund`, { reason: 'ลูกค้าขอยกเลิกสัญญา (เทส)' }, { headers: { 'Idempotency-Key': idemKey1 } });
    assert(r2.status === 200 && r2.json.refund.stripeRefundId === r1.json.refund.stripeRefundId, `resend คืน response เดิมเป๊ะ ไม่สร้าง refund ใหม่ (ได้ ${r2.json.refund && r2.json.refund.stripeRefundId})`);
    const refundCountAfterResend = (await pool.query('SELECT count(*)::int AS n FROM platform_refunds WHERE invoice_id=$1', [invoiceRow.id])).rows[0].n;
    assert(refundCountAfterResend === 1, `ยังมีแถว platform_refunds แค่ 1 แถวหลัง resend (ได้ ${refundCountAfterResend})`);
    const stripeRefundsForCharge = await stripe.refunds.list({ charge: invoiceRow.stripe_charge_id });
    assert(stripeRefundsForCharge.data.length === 1, `Stripe มี refund object แค่ 1 รายการสำหรับ charge นี้ ไม่ถูกคืนเงินซ้ำจริงบน Stripe (ได้ ${stripeRefundsForCharge.data.length})`);

    // ============================================================================================
    // (3) retry จำลอง "Stripe คืนเงินสำเร็จจริงแล้ว แต่ DB งานยังไม่เสร็จ" — undo ผลข้าง DB ทั้งหมดยกเว้น
    // Stripe refund เอง แล้ว reset idempotency cache กลับเป็น pending แล้วยิงคำขอเดิมซ้ำ
    // ============================================================================================
    console.log('\n=== (3) retry หลัง "Stripe สำเร็จแต่ DB ไม่เสร็จ" -> กู้กลับมาสมบูรณ์ ไม่คืนเงินซ้ำ ===');
    await pool.query(`UPDATE invoices SET status='paid' WHERE id=$1`, [invoiceRow.id]);
    // ต้องลบ platform_refunds (ที่ชี้ไปยัง journal_entry_id นี้) ก่อนลบ journal_entries เอง ไม่งั้นชน FK
    await pool.query(`DELETE FROM platform_refunds WHERE id=$1`, [refundRow.id]);
    await pool.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id=$1`, [refundJournal.id]);
    await pool.query(`DELETE FROM journal_entries WHERE id=$1`, [refundJournal.id]);
    // reserved_at ต้องเก่ากว่า IDEMPOTENCY_STALE_MS (5 นาที) ด้วย ไม่งั้น withPlatformIdempotency จะเห็นว่า
    // reservation ยังใหม่อยู่ (อาจกำลังประมวลผลจริงในอีก request หนึ่งพร้อมกัน) แล้วตอบ 409 กันไว้ก่อนแทน —
    // นี่คือพฤติกรรมที่ถูกต้องของกลไกจริง (กันสอง request ชนกันตอนนี้พร้อมกัน) เทสนี้จำลอง "เวลาผ่านไปแล้ว
    // จริง" (เช่น admin กลับมากดใหม่หลัง server ล่มไปหลายนาที) ไม่ใช่ retry ทันทีภายในไม่กี่วินาที
    await pool.query(
      `UPDATE platform_idempotency_keys SET response_status=NULL, response_body=NULL, reserved_at = now() - interval '10 minutes' WHERE idempotency_key=$1 AND endpoint=$2`,
      [idemKey1, `invoices-refund:${invoiceRow.id}`]
    );

    const r3 = await call('POST', `/api/admin/invoices/${invoiceRow.id}/refund`, { reason: 'ลูกค้าขอยกเลิกสัญญา (เทส)' }, { headers: { 'Idempotency-Key': idemKey1 } });
    assert(r3.status === 200, `retry หลัง partial-success ประมวลผลสำเร็จใหม่ (ได้ status=${r3.status}, body=${JSON.stringify(r3.json)})`);
    assert(r3.json.refund.stripeRefundId === r1.json.refund.stripeRefundId, `Stripe คืน refund object เดิมกลับมา (idempotencyKey เดียวกัน) ไม่สร้างใหม่ (ได้ ${r3.json.refund.stripeRefundId})`);
    const refundCountAfterRecovery = (await pool.query('SELECT count(*)::int AS n FROM platform_refunds WHERE invoice_id=$1', [invoiceRow.id])).rows[0].n;
    assert(refundCountAfterRecovery === 1, `กู้ข้อมูล DB กลับมาสมบูรณ์ — มี platform_refunds แค่ 1 แถว (ได้ ${refundCountAfterRecovery})`);
    const journalCountAfterRecovery = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE source_type='refund' AND source_id=(SELECT id FROM platform_refunds WHERE invoice_id=$1)`, [invoiceRow.id])).rows[0].n;
    assert(journalCountAfterRecovery === 1, `มี journal entry การคืนเงินแค่ 1 รายการหลังกู้ข้อมูล (ได้ ${journalCountAfterRecovery})`);
    const stripeRefundsAfterRecovery = await stripe.refunds.list({ charge: invoiceRow.stripe_charge_id });
    assert(stripeRefundsAfterRecovery.data.length === 1, `Stripe ยังมี refund object แค่ 1 รายการเท่านั้น (ได้ ${stripeRefundsAfterRecovery.data.length})`);
    const invoiceAfterRecovery = (await pool.query('SELECT status FROM invoices WHERE id=$1', [invoiceRow.id])).rows[0];
    assert(invoiceAfterRecovery.status === 'refunded', 'invoice.status กลับมาเป็น refunded ถูกต้องหลังกู้ข้อมูล');

    // ============================================================================================
    // (4) ใบที่ refunded ไปแล้ว -> คืนเงินซ้ำอีกครั้ง (idempotency key ใหม่ จำลอง admin กดใหม่จริง) -> 400
    // ============================================================================================
    console.log('\n=== (4) ใบที่ refunded แล้ว -> คืนเงินซ้ำไม่ได้ ===');
    const r4 = await call('POST', `/api/admin/invoices/${invoiceRow.id}/refund`, { reason: 'พยายามคืนซ้ำ' }, { headers: { 'Idempotency-Key': fakeIdemKey() } });
    assert(r4.status === 400, `ใบที่ refunded แล้ว คืนเงินซ้ำไม่ได้ (ได้ status=${r4.status})`);

    // ============================================================================================
    // (5) บริษัท/ใบแจ้งหนี้ใหม่ — ยังไม่จ่าย (unpaid) -> คืนเงินไม่ได้
    // ============================================================================================
    console.log('\n=== (5) ใบแจ้งหนี้ unpaid -> คืนเงินไม่ได้ ===');
    const manualCompanyRes = await call('POST', '/api/admin/companies', {
      name: `E2E Refund Manual Co ${Date.now()}`, taxId: '1111111111111', phone: '02-000-0000', email: 'e2e-refund-manual@example.com',
    });
    const manualCompanyId = manualCompanyRes.json.company.id;
    cleanup.companyIds.push(manualCompanyId);
    const unpaidInvoiceRes = await call('POST', '/api/admin/invoices', { companyId: manualCompanyId, amount: 1000 });
    const unpaidInvoiceId = unpaidInvoiceRes.json.invoice.id;
    const r5 = await call('POST', `/api/admin/invoices/${unpaidInvoiceId}/refund`, { reason: 'ทดสอบใบ unpaid' }, { headers: { 'Idempotency-Key': fakeIdemKey() } });
    assert(r5.status === 400, `ใบแจ้งหนี้ unpaid คืนเงินไม่ได้ (ได้ status=${r5.status})`);

    // ============================================================================================
    // (6) ใบแจ้งหนี้ที่สร้างด้วยมือ (ไม่มี stripe_charge_id) แต่รับชำระเต็มแล้ว -> คืนเงินผ่านระบบนี้ไม่ได้
    // ============================================================================================
    console.log('\n=== (6) ใบแจ้งหนี้แบบมือ (ไม่มี stripe_charge_id) -> คืนเงินผ่าน Stripe ไม่ได้ ===');
    await call('POST', `/api/admin/invoices/${unpaidInvoiceId}/mark-paid`, {});
    const r6 = await call('POST', `/api/admin/invoices/${unpaidInvoiceId}/refund`, { reason: 'ทดสอบใบมือ' }, { headers: { 'Idempotency-Key': fakeIdemKey() } });
    assert(r6.status === 400, `ใบแจ้งหนี้ที่ไม่มี stripe_charge_id คืนเงินผ่าน endpoint นี้ไม่ได้ (ได้ status=${r6.status})`);

    // ============================================================================================
    // (7) ไม่ระบุเหตุผล -> 400
    // ============================================================================================
    console.log('\n=== (7) ไม่ระบุเหตุผล -> 400 ===');
    const { invoiceRow: invoiceRow2 } = await createPaidStripeInvoice(cleanup);
    const r7 = await call('POST', `/api/admin/invoices/${invoiceRow2.id}/refund`, { reason: '' }, { headers: { 'Idempotency-Key': fakeIdemKey() } });
    assert(r7.status === 400, `ไม่ระบุเหตุผล -> 400 (ได้ status=${r7.status})`);

    // ============================================================================================
    // (8) ไม่ส่ง Idempotency-Key header เลย -> 400
    // ============================================================================================
    console.log('\n=== (8) ไม่ส่ง Idempotency-Key -> 400 ===');
    const r8 = await call('POST', `/api/admin/invoices/${invoiceRow2.id}/refund`, { reason: 'ลืมใส่ header' });
    assert(r8.status === 400, `ไม่ส่ง Idempotency-Key -> 400 (ได้ status=${r8.status})`);

    // ============================================================================================
    // (9) staff role คืนเงินไม่ได้ (จำกัดเฉพาะ owner) -> 403
    // ============================================================================================
    console.log('\n=== (9) role staff คืนเงินไม่ได้ (จำกัดเฉพาะ owner) ===');
    const r9 = await call('POST', `/api/admin/invoices/${invoiceRow2.id}/refund`, { reason: 'staff พยายามคืนเงิน' }, { asRole: 'staff', headers: { 'Idempotency-Key': fakeIdemKey() } });
    assert(r9.status === 403, `role staff ถูกบล็อก ไม่ให้คืนเงินได้ (ได้ status=${r9.status})`);
    // ยืนยันว่า invoice2 ยังไม่ถูกแตะเลยจาก staff attempt ที่โดนบล็อก
    const invoice2AfterBlockedAttempt = (await pool.query('SELECT status FROM invoices WHERE id=$1', [invoiceRow2.id])).rows[0];
    assert(invoice2AfterBlockedAttempt.status === 'paid', 'invoice2 ยังคง paid เหมือนเดิม ไม่ถูกแตะจาก request ที่ถูกบล็อก');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      for (const subId of cleanup.stripeSubscriptionIds) { await stripe.subscriptions.cancel(subId).catch(() => {}); }
      for (const custId of cleanup.stripeCustomerIds) { await stripe.customers.del(custId).catch(() => {}); }
      if (cleanup.companyIds.length) {
        const staleInvoiceIds = (await pool.query('SELECT id FROM invoices WHERE company_id = ANY($1)', [cleanup.companyIds])).rows.map(r => r.id);
        const stalePaymentIds = staleInvoiceIds.length
          ? (await pool.query('SELECT id FROM invoice_payments WHERE invoice_id = ANY($1)', [staleInvoiceIds])).rows.map(r => r.id)
          : [];
        const staleRefundIds = staleInvoiceIds.length
          ? (await pool.query('SELECT id FROM platform_refunds WHERE invoice_id = ANY($1)', [staleInvoiceIds])).rows.map(r => r.id)
          : [];
        // ลำดับสำคัญ: platform_refunds ก่อน (ไม่มี ON DELETE CASCADE จาก invoices — ถ้าไม่ลบก่อนจะลบ
        // invoices ไม่ได้) แล้วค่อยลบ journal_entries โดยเริ่มจาก source_type='refund' ก่อนเสมอ (แถวนี้มี
        // reverses_entry_id ชี้กลับไปยัง journal ของ 'payment'/'invoice' — ถ้าลบ payment/invoice ก่อนจะชน
        // FK journal_entries_reverses_entry_id_fkey)
        if (staleRefundIds.length) await pool.query('DELETE FROM platform_refunds WHERE id = ANY($1)', [staleRefundIds]);
        if (staleRefundIds.length) await pool.query(`DELETE FROM journal_entries WHERE source_type='refund' AND source_id = ANY($1)`, [staleRefundIds]);
        if (stalePaymentIds.length) await pool.query(`DELETE FROM journal_entries WHERE source_type='payment' AND source_id = ANY($1)`, [stalePaymentIds]);
        if (staleInvoiceIds.length) await pool.query(`DELETE FROM journal_entries WHERE source_type='invoice' AND source_id = ANY($1)`, [staleInvoiceIds]);
        await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [cleanup.companyIds]);
        await pool.query('DELETE FROM customer_companies WHERE id = ANY($1)', [cleanup.companyIds]);
      }
      await pool.query(`DELETE FROM platform_webhook_events WHERE stripe_event_id LIKE 'evt_test_refund_%'`);
      await pool.query(`DELETE FROM platform_idempotency_keys WHERE idempotency_key LIKE 'idem_test_refund_%'`);
    } catch (e) { console.error('cleanup warning (manual cleanup may be needed):', e.message); }
    await pool.end();
  }
})();
