// path ต้องอิง __dirname เสมอ ห้ามพึ่ง cwd — เหตุผลเดียวกับ db.js (ดู CLAUDE.md ข้อ 16)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const bcrypt = require('bcryptjs');
const pool = require('./db');

const users = [
  ['sa', 'dev@sitereq.local', '9985', 'super_user', '', 'System Admin'],
  ['suriya.super', 'suriya@sitereq.demo', 'Passw0rd!', 'super_user', '', 'สุริยา ก่อสร้างมั่นคง'],
  ['napat.admin', 'napat@sitereq.demo', 'Passw0rd!', 'admin_maker', '', 'ณภัทร บริหารข้อมูล'],
  ['ploy.approve', 'ploy@sitereq.demo', 'Passw0rd!', 'admin_approver', '', 'พลอย อนุมัติกลาง'],
  ['kritt.auto', 'kritt@sitereq.demo', 'Passw0rd!', 'single_auto', 'วิศวกรโครงการ', 'กฤต หน้างานเดี่ยว'],
  ['araya.dual', 'araya@sitereq.demo', 'Passw0rd!', 'single_dual', '', 'อารยา คู่อนุมัติ'],
  ['somjai.dual2', 'somjai@sitereq.demo', 'Passw0rd!', 'single_dual', 'กรรมการบริษัท', 'สมใจ คู่อนุมัติ2'],
  ['tan.maker', 'tan@sitereq.demo', 'Passw0rd!', 'maker', '', 'ธัน ผู้จัดทำ'],
  ['mint.checker', 'mint@sitereq.demo', 'Passw0rd!', 'checker', 'โฟร์แมน', 'มิ้นท์ ผู้ตรวจสอบ'],
  ['boss.approver', 'boss@sitereq.demo', 'Passw0rd!', 'approver', 'ผจก.โครงการ', 'บอส ผู้อนุมัติ'],
];

const approvalConditions = [
  [0, 50000, 'Maker → Approver (2 ระดับ)'],
  [50001, 300000, 'Maker → Checker → Approver (3 ระดับ)'],
  [300001, null, 'Maker → Checker → Approver + Super User รับทราบ'],
];

const platformAdmins = [
  ['sorranan@sitereq.local', 'Owner@Sitereq2026!', 'Sorranan Sudsaard', 'owner'],
  ['admin@sitereq.local', 'Admin@2026', 'ผู้ดูแลระบบ', 'admin'],
  ['staff@sitereq.local', 'Staff@2026', 'พนักงานฝ่ายลูกค้า', 'staff'],
];

const customerCompanies = [
  {
    company: ['บริษัท ไทยพัฒนาก่อสร้าง จำกัด', '0105561234567', '02-123-4567', 'contact@thaipatana.example', '99 ถ.พระราม 9 กรุงเทพฯ'],
    package: 'Enterprise',
    contacts: [
      ['สมชาย ไทยพัฒนา', 'somchai@thaipatana.example', '081-111-2222', 'กรรมการผู้จัดการ'],
      ['วิภา ใจดี', 'wipa@thaipatana.example', '081-222-3333', 'ฝ่ายจัดซื้อ'],
    ],
  },
  {
    company: ['ห้างหุ้นส่วนจำกัด รุ่งเรืองวิศวกรรม', '0103561239876', '02-234-5678', 'info@rungruang.example', '55 ถ.สุขุมวิท กรุงเทพฯ'],
    package: 'Basic',
    contacts: [
      ['ประยุทธ รุ่งเรือง', 'prayut@rungruang.example', '082-333-4444', 'หุ้นส่วนผู้จัดการ'],
    ],
  },
  {
    company: ['บริษัท เอเชีย บิลดิ้ง ซัพพลาย จำกัด', '0107561245678', '02-345-6789', 'sales@asiabuilding.example', '12 ถ.บางนา-ตราด กรุงเทพฯ'],
    package: 'Pro',
    contacts: [
      ['กนกวรรณ เอเชีย', 'kanokwan@asiabuilding.example', '083-444-5555', 'ผู้จัดการฝ่ายขาย'],
      ['ธีระ บิลดิ้ง', 'teera@asiabuilding.example', '083-555-6666', 'ฝ่ายบัญชี'],
    ],
  },
];

const packages = [
  ['Basic', 990, 'monthly', 'เหมาะสำหรับทีมขนาดเล็ก ผู้ใช้งานได้สูงสุด 5 คน', 5],
  ['Pro', 2990, 'monthly', 'เหมาะสำหรับบริษัทขนาดกลาง ผู้ใช้งานได้สูงสุด 20 คน พร้อมรายงานขั้นสูง', 20],
  ['Enterprise', 29900, 'yearly', 'สำหรับองค์กรขนาดใหญ่ รองรับหลายโครงการ พร้อมทีมซัพพอร์ตเฉพาะ', 100],
];

const TIER_MAX_USERS = { free: 1, basic: 2, pro: 10, enterprise: 100 };

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO company (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
      ['CNS-2026', 'บริษัท สยามคอนสตรัคชั่น จำกัด']
    );

    for (const [username, email, password, role, position, name] of users) {
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO users (username, email, password_hash, role, position, name, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (username) DO NOTHING`,
        [username, email, hash, role, position, name]
      );
    }

    for (const [min, max, flow] of approvalConditions) {
      const exists = await client.query('SELECT 1 FROM approval_conditions WHERE flow = $1', [flow]);
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO approval_conditions (min_amount, max_amount, flow) VALUES ($1, $2, $3)`,
          [min, max, flow]
        );
      }
    }

    for (const [email, password, name, role] of platformAdmins) {
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO platform_admins (email, password_hash, name, role, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO NOTHING`,
        [email, hash, name, role]
      );
    }

    const packageIdByName = {};
    for (const [name, price, billingCycle, description, maxUsers] of packages) {
      const exists = await client.query('SELECT id FROM packages WHERE name = $1', [name]);
      if (exists.rowCount > 0) {
        packageIdByName[name] = exists.rows[0].id;
      } else {
        const inserted = await client.query(
          `INSERT INTO packages (name, price, billing_cycle, description, max_users) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [name, price, billingCycle, description, maxUsers]
        );
        packageIdByName[name] = inserted.rows[0].id;
      }
    }

    const companyIdByName = {};
    for (const { company, package: packageName, contacts } of customerCompanies) {
      const [name, taxId, phone, email, address] = company;
      const packageId = packageIdByName[packageName] || null;
      const exists = await client.query('SELECT id FROM customer_companies WHERE name = $1', [name]);
      let companyId = exists.rows[0] && exists.rows[0].id;
      if (!companyId) {
        const inserted = await client.query(
          `INSERT INTO customer_companies (name, tax_id, phone, email, address, package_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [name, taxId, phone, email, address, packageId]
        );
        companyId = inserted.rows[0].id;
      } else {
        await client.query('UPDATE customer_companies SET package_id = $1 WHERE id = $2 AND package_id IS NULL', [packageId, companyId]);
      }
      companyIdByName[name] = companyId;

      const subExists = await client.query('SELECT 1 FROM subscriptions WHERE company_id = $1', [companyId]);
      if (subExists.rowCount === 0) {
        const tier = (packageName || 'free').toLowerCase();
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        await client.query(
          `INSERT INTO subscriptions (company_id, tier, max_users, expires_at, status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [companyId, tier, TIER_MAX_USERS[tier] || 1, expiresAt]
        );
      }
      for (const [cName, cEmail, cPhone, cPosition] of contacts) {
        const contactExists = await client.query(
          'SELECT 1 FROM customers WHERE company_id = $1 AND name = $2', [companyId, cName]
        );
        if (contactExists.rowCount === 0) {
          await client.query(
            `INSERT INTO customers (company_id, name, email, phone, position)
             VALUES ($1, $2, $3, $4, $5)`,
            [companyId, cName, cEmail, cPhone, cPosition]
          );
        }
      }
    }

    const invoices = [
      { company: 'บริษัท ไทยพัฒนาก่อสร้าง จำกัด', package: 'Enterprise', amount: 29900, status: 'paid', issueDate: '2026-06-01', dueDate: '2026-06-15' },
      { company: 'ห้างหุ้นส่วนจำกัด รุ่งเรืองวิศวกรรม', package: 'Basic', amount: 990, status: 'unpaid', issueDate: '2026-07-01', dueDate: '2026-07-15' },
      { company: 'บริษัท เอเชีย บิลดิ้ง ซัพพลาย จำกัด', package: 'Pro', amount: 2990, status: 'overdue', issueDate: '2026-05-01', dueDate: '2026-05-15' },
    ];
    const invoiceCountRes = await client.query('SELECT COUNT(*)::int AS n FROM invoices');
    if (invoiceCountRes.rows[0].n === 0) {
      const year = new Date().getFullYear() + 543;
      let seq = 1;
      for (const inv of invoices) {
        const invoiceNo = `INV-${year}-` + String(seq++).padStart(4, '0');
        await client.query(
          `INSERT INTO invoices (invoice_no, company_id, package_id, amount, issue_date, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [invoiceNo, companyIdByName[inv.company], packageIdByName[inv.package], inv.amount, inv.issueDate, inv.dueDate, inv.status]
        );
      }
    }

    const settingsExists = await client.query('SELECT 1 FROM platform_settings LIMIT 1');
    if (settingsExists.rowCount === 0) {
      await client.query(
        `INSERT INTO platform_settings (company_name, logo_url, address, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5)`,
        ['SiteReq', '', '99 อาคาร SiteReq ถ.สาทร กรุงเทพฯ', 'support@sitereq.local', '02-000-0000']
      );
    }

    await client.query('COMMIT');
    console.log('Seed complete. Demo accounts use password "Passw0rd!" (System Admin "sa" uses "9985").');
    console.log('Admin panel: admin@sitereq.local / Admin@2026 (role: admin), staff@sitereq.local / Staff@2026 (role: staff).');
    console.log('Admin panel owner: sorranan@sitereq.local / Owner@Sitereq2026! (role: owner, Sorranan Sudsaard).');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
