// Stripe Billing stage 4 — grace-period auto-suspend sweep. แยกออกมาเป็นโมดูลของตัวเอง (ไม่ฝังอยู่ใน
// cron.schedule() ตรงๆ ใน server.js) เพื่อให้เทสถาวรเรียกตรรกะจริงตัวเดียวกันได้โดยตรง แทนที่จะ copy SQL
// มาซ้ำในไฟล์เทส — ป้องกัน bug class เดียวกับที่เคยเกิดกับ AUDIT_DOC_TYPES_FULL ใน
// attachments-void-cancel.regression.js (hardcoded copy หลุดจาก source of truth เงียบๆ เมื่อโค้ดจริงถูก
// แก้ทีหลังแต่ไม่มีใครแก้สำเนาในเทสตาม ทำให้เทสยัง "ผ่าน" อยู่ทั้งที่โค้ดจริงพังไปแล้ว)
const AUTO_SUSPEND_GRACE_PERIOD_DAYS = 3;

// client ต้องเป็น client ของทรานแซกชันที่เปิด BEGIN ไว้แล้วจากผู้เรียก (cron หรือเทส) — ฟังก์ชันนี้ไม่เปิด/
// ปิดทรานแซกชันเอง เพื่อให้ผู้เรียกควบคุม commit/rollback ได้เต็มที่
// companyIdsFilter (optional, ใช้เฉพาะตอนเทส): จำกัดเฉพาะ company id ที่ระบุ กันไม่ให้เทสไปกวาดบริษัทจริง
// อื่นๆ ในฐาน dev โดยไม่ตั้งใจ — cron จริงเรียกโดยไม่ส่งค่านี้เสมอ (ต้องกวาดทุกบริษัทจริง)
async function runAutoSuspendSweep(client, companyIdsFilter) {
  const params = [AUTO_SUSPEND_GRACE_PERIOD_DAYS];
  let filterClause = '';
  if (companyIdsFilter) {
    filterClause = 'AND id = ANY($2)';
    params.push(companyIdsFilter);
  }
  const suspended = await client.query(
    `UPDATE customer_companies SET status='suspended'
     WHERE status='active' AND payment_failed_at IS NOT NULL
       AND payment_failed_at < now() - ($1::int * interval '1 day')
       ${filterClause}
     RETURNING id, payment_failed_at`,
    params
  );
  for (const row of suspended.rows) {
    const failedAtStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.payment_failed_at);
    await client.query(
      `INSERT INTO platform_company_status_log (company_id, from_status, to_status, reason, changed_by)
       VALUES ($1,'active','suspended',$2,NULL)`,
      [row.id, `auto-suspend: ค้างชำระตั้งแต่ ${failedAtStr} (เกิน ${AUTO_SUSPEND_GRACE_PERIOD_DAYS} วัน)`]
    );
  }
  return suspended.rows;
}

module.exports = { runAutoSuspendSweep, AUTO_SUSPEND_GRACE_PERIOD_DAYS };
