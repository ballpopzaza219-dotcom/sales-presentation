// Report-only (dry-run) — never INSERTs. Lists distinct client_payment_vouchers.payee_name values
// (voucher_type='other') per company, flags near-duplicates (case/whitespace-insensitive match), so a
// human can review before any client_external_payees rows get created from them.
// Run again any time as real ข้อ 1.4 data accumulates — safe to re-run, read-only.
const pool = require('../db');

function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main() {
  const r = await pool.query(
    `SELECT company_id, payee_name, COUNT(*) AS voucher_count, SUM(amount) AS total_amount
     FROM client_payment_vouchers
     WHERE voucher_type = 'other' AND payee_name <> ''
     GROUP BY company_id, payee_name
     ORDER BY company_id, payee_name`
  );

  if (r.rowCount === 0) {
    console.log('ไม่พบข้อมูล payee_name แบบ free text ใน client_payment_vouchers เลย (ตารางนี้เพิ่งสร้างใหม่');
    console.log('ในรอบนี้ — ฟีเจอร์ข้อ 1.4 ยังไม่เคยมี backend มาก่อน ระบบเดิม (DB.* ใน pr-system.html)');
    console.log('เป็น client-side mock ล้วนๆ ไม่เคยเขียนลง Postgres จึงไม่มีอะไรให้ migrate ในตอนนี้');
    console.log('สคริปต์นี้เก็บไว้ใช้ตรวจซ้ำซ้อนในอนาคต เมื่อมีการบันทึกข้อมูลจริงผ่านฟีเจอร์ใหม่แล้ว');
    await pool.end();
    return;
  }

  const byCompany = new Map();
  for (const row of r.rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }

  for (const [companyId, rows] of byCompany) {
    console.log(`\n=== บริษัท company_id=${companyId} — ${rows.length} ชื่อที่แตกต่างกัน ===`);
    const groups = new Map();
    for (const row of rows) {
      const key = normalize(row.payee_name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [key, variants] of groups) {
      if (variants.length > 1) {
        console.log(`  ⚠ อาจซ้ำซ้อน (${variants.length} ชื่อ):`);
        variants.forEach(v => console.log(`      "${v.payee_name}" — ${v.voucher_count} ใบ, รวม ${v.total_amount} บาท`));
      } else {
        console.log(`  "${variants[0].payee_name}" — ${variants[0].voucher_count} ใบ, รวม ${variants[0].total_amount} บาท`);
      }
    }
  }

  console.log('\n(dry-run เท่านั้น — ยังไม่ได้ INSERT อะไรลง client_external_payees)');
  await pool.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
