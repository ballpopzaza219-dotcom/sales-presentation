// path ต้องอิง __dirname เสมอ ห้ามพึ่ง cwd — เหตุผลเดียวกับ db.js (ดู CLAUDE.md ข้อ 16)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const multer = require('multer');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const pool = require('./db');

// Safety net: an uncaught error in any async route handler must never take down the whole
// server for every other user. Express 4 does not catch throws/rejections inside `async`
// route handlers on its own, so without this a single bad request (e.g. a malformed login
// body) crashes the entire Node process.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set — add it to server/.env before starting the server.');
}

const app = express();

// The comment above about unhandledRejection only stops the whole *process* from dying — it does
// nothing for the one request that actually failed. Express 4 doesn't forward a rejected promise
// from an `async (req,res) => {...}` handler to error-handling middleware on its own, so without
// this, a thrown/rejected error (e.g. a Postgres constraint violation) leaves that one request
// hanging with no response at all — the browser just spins until it eventually gives up, and
// apiCall's `data.error` fallback message ("เกิดข้อผิดพลาด") never even gets a chance to show
// because no response body ever arrives. Wrapping every route here means every async handler,
// present and future, automatically forwards its rejection to the error middleware below instead.
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(h =>
    (typeof h === 'function' && h.constructor.name === 'AsyncFunction')
      ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      : h
  ));
}

// ---------------- Request-timing log ----------------
// Permanent, lightweight per-request log (method, path, status, duration) — added 2026-07-25 after
// a "Tender List takes 3-5 minutes to load, or never loads" report that turned out to be
// unreproducible via live probing (server/DB/tunnel were all fast at the time of checking). The gap
// was having no record of what actually happened *during* the slow window — this closes that gap
// for next time, without re-introducing the old verbose/synchronous debug-logging that previously
// slowed the server down and was ripped out: no request/response bodies or headers are logged, and
// nothing here runs on the response path — the write happens in a res.on('finish') callback, using
// a plain fs.WriteStream (Node queues stream.write() internally and returns immediately; it never
// blocks the event loop the way fs.appendFileSync per request would).
const REQUEST_LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(REQUEST_LOG_DIR, { recursive: true });
const REQUEST_LOG_RETENTION_DAYS = 14; // bounds total disk usage — old daily files are pruned, not kept forever
let requestLogStream = null;
let requestLogStreamDate = null;
function getRequestLogStream() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC) — a machine log, human display locale doesn't matter
  if (requestLogStream && requestLogStreamDate === today) return requestLogStream;
  if (requestLogStream) requestLogStream.end();
  requestLogStreamDate = today;
  requestLogStream = fs.createWriteStream(path.join(REQUEST_LOG_DIR, `requests-${today}.log`), { flags: 'a' });
  pruneOldRequestLogs();
  return requestLogStream;
}
function pruneOldRequestLogs() {
  fs.readdir(REQUEST_LOG_DIR, (err, files) => {
    if (err) return;
    const cutoff = Date.now() - REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const m = /^requests-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
        fs.unlink(path.join(REQUEST_LOG_DIR, f), () => {}); // best-effort — a failed prune isn't worth logging about
      }
    }
  });
}
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `${new Date().toISOString()}\t${req.method}\t${req.path}\t${res.statusCode}\t${ms.toFixed(1)}ms\n`;
    getRequestLogStream().write(line);
  });
  next();
});

// gzip everything eligible (text/html, text/javascript, application/json, ...) — pr-system.html is a
// single ~580KB monolithic file with no build/bundle step, so this is the highest-leverage way to cut
// its actual bytes-over-the-wire without restructuring it. Added 2026-07-24 as part of investigating
// slow page loads.
app.use(compression());

// Default 100kb is too small for job-application submissions, which embed the applicant's
// photo as a base64 data URL directly in the JSON body (see photoDataUrl in job_applications).
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

const ROLE_LABELS = {
  super_user: 'Super User',
  admin_maker: 'Admin Maker',
  admin_approver: 'Admin Approver',
  single_auto: 'Single User (Auto Approved)',
  single_dual: 'Single User (Dual Approved)',
  maker: 'Maker',
  checker: 'Checker',
  approver: 'Approver',
};

function posLabel(user) {
  return user.position || ROLE_LABELS[user.role] || '';
}

function serializeUser(row) {
  return {
    id: row.id, username: row.username, email: row.email,
    role: row.role, position: row.position, name: row.name, active: row.active,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
  next();
}

async function loadUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

function serializeAdmin(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
}

function requireAdminAuth(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
  next();
}

async function requireCustomerAuth(req, res, next) {
  if (!req.session.customerId) return res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
  const r = await pool.query('SELECT * FROM customers WHERE id = $1', [req.session.customerId]);
  const customer = r.rows[0];
  if (!customer || customer.status !== 'active') return res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
  req.customer = customer;
  next();
}

const ROLE_RANK = { staff: 0, admin: 1, owner: 2 };

function requireAdminRole(minRole) {
  return (req, res, next) => {
    if (ROLE_RANK[req.currentAdmin.role] < ROLE_RANK[minRole]) return res.status(403).json({ error: 'ไม่มีสิทธิ์ทำรายการนี้' });
    next();
  };
}

// Enforces the target company's subscription (package) status. Expects a :id route param
// identifying the customer_companies row. Attaches the active subscription row to req.subscription.
async function checkPackageLimit(req, res, next) {
  const companyId = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT * FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [companyId]);
  const sub = r.rows[0];
  const expired = sub && sub.expires_at && new Date(sub.expires_at) < new Date();
  if (!sub || sub.status !== 'active' || expired) {
    return res.status(403).json({ error: 'แพ็กเกจหมดอายุ กรุณาต่ออายุ' });
  }
  req.subscription = sub;
  next();
}

async function loadAdmin(id) {
  const r = await pool.query('SELECT * FROM platform_admins WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// attach req.currentUser / req.currentAdmin for authenticated requests
app.use(async (req, res, next) => {
  if (req.session.userId) {
    req.currentUser = await loadUser(req.session.userId);
  }
  if (req.session.adminId) {
    req.currentAdmin = await loadAdmin(req.session.adminId);
  }
  next();
});

// ---------------- Auth ----------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน' });
  }
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = r.rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'ไม่พบบัญชีผู้ใช้งาน หรือบัญชีถูกปิดใช้งาน' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  req.session.userId = user.id;
  res.json({ user: serializeUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.currentUser) });
});

// ---------------- Company (GET public — login screen needs the name pre-auth) ----------------
app.get('/api/company', async (req, res) => {
  const r = await pool.query('SELECT * FROM company ORDER BY id LIMIT 1');
  res.json({ company: r.rows[0] || null });
});

app.put('/api/company', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const u = req.currentUser;
  if (u.role === 'admin_maker') {
    await pool.query(
      `INSERT INTO admin_requests (type, detail, by_user_id, by_name, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      ['แก้ไขข้อมูลบริษัท', `เปลี่ยนชื่อบริษัทเป็น: ${name.trim()}`, u.id, u.name]
    );
    return res.json({ pending: true });
  }
  const r = await pool.query('UPDATE company SET name = $1 RETURNING *', [name.trim()]);
  res.json({ company: r.rows[0] });
});

// ---------------- Thailand address reference data (cascading province/district/subdistrict dropdowns) ----------------
// public: static geography data, no different from a bundled JSON file — and the job
// application form's "demo" data mode never establishes a server session at all, so an
// auth-gated route here would silently break the dropdowns for every demo-mode user.
app.get('/api/provinces', async (req, res) => {
  const r = await pool.query('SELECT id, name_th FROM provinces ORDER BY name_th');
  res.json({ provinces: r.rows });
});

app.get('/api/districts', async (req, res) => {
  const provinceId = parseInt(req.query.province_id, 10);
  if (!provinceId) return res.status(400).json({ error: 'province_id is required' });
  const r = await pool.query(
    'SELECT id, name_th FROM districts WHERE province_id = $1 ORDER BY name_th',
    [provinceId]
  );
  res.json({ districts: r.rows });
});

app.get('/api/subdistricts', async (req, res) => {
  const districtId = parseInt(req.query.district_id, 10);
  if (!districtId) return res.status(400).json({ error: 'district_id is required' });
  const r = await pool.query(
    'SELECT id, name_th, zipcode FROM subdistricts WHERE district_id = $1 ORDER BY name_th',
    [districtId]
  );
  res.json({ subdistricts: r.rows });
});

// public: minimal demo-account list for the login screen's "click to auto-fill" picker
app.get('/api/demo-users', async (req, res) => {
  const r = await pool.query(
    `SELECT username, name, role, position FROM users WHERE active = true AND email LIKE '%@sitereq.demo' ORDER BY id`
  );
  res.json({ users: r.rows });
});

// ---------------- Users ----------------
app.get('/api/users', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM users ORDER BY id');
  res.json({ users: r.rows.map(serializeUser) });
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { name, username, email, role, position } = req.body || {};
  if (!name || !username || !email || !role) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const u = req.currentUser;
  if (u.role === 'admin_maker') {
    await pool.query(
      `INSERT INTO admin_requests (type, detail, by_user_id, by_name, status, payload)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      ['สร้างผู้ใช้งานใหม่', `สร้างผู้ใช้: ${name} (บทบาท: ${ROLE_LABELS[role] || role})`, u.id, u.name,
        JSON.stringify({ name, username, email, role, position: position || '' })]
    );
    return res.json({ pending: true });
  }
  const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  const hash = await bcrypt.hash('Passw0rd!', 10);
  const r = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, position, name, active)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
    [username, email, hash, role, position || '', name]
  );
  res.json({ user: serializeUser(r.rows[0]) });
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, email, role, position } = req.body || {};
  if (!name || !email || !role) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const u = req.currentUser;
  if (u.role === 'admin_maker') {
    await pool.query(
      `INSERT INTO admin_requests (type, detail, by_user_id, by_name, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      ['แก้ไขผู้ใช้งาน', `แก้ไขผู้ใช้: ${name} (บทบาท: ${ROLE_LABELS[role] || role})`, u.id, u.name]
    );
    return res.json({ pending: true });
  }
  const r = await pool.query(
    'UPDATE users SET name=$1, email=$2, role=$3, position=$4 WHERE id=$5 RETURNING *',
    [name, email, role, position || '', id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
  res.json({ user: serializeUser(r.rows[0]) });
});

app.post('/api/users/:id/toggle-active', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = await loadUser(id);
  if (!target) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
  const u = req.currentUser;
  if (u.role === 'admin_maker') {
    await pool.query(
      `INSERT INTO admin_requests (type, detail, by_user_id, by_name, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      ['เปิด/ปิดการใช้งานบัญชี', `${target.active ? 'ปิด' : 'เปิด'}การใช้งานบัญชี: ${target.name}`, u.id, u.name]
    );
    return res.json({ pending: true });
  }
  const r = await pool.query('UPDATE users SET active = NOT active WHERE id=$1 RETURNING *', [id]);
  res.json({ user: serializeUser(r.rows[0]) });
});

// ---------------- Approval conditions ----------------
app.get('/api/approval-conditions', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM approval_conditions ORDER BY min_amount');
  res.json({ conditions: r.rows });
});

app.post('/api/approval-conditions', requireAuth, async (req, res) => {
  const { min, max, flow } = req.body || {};
  if (!flow || !flow.trim()) return res.status(400).json({ error: 'กรุณากรอกรูปแบบการอนุมัติ' });
  const u = req.currentUser;
  const minAmt = parseFloat(min) || 0;
  const maxAmt = max === '' || max == null ? null : parseFloat(max);
  if (u.role === 'admin_maker') {
    await pool.query(
      `INSERT INTO admin_requests (type, detail, by_user_id, by_name, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      ['แก้ไขเงื่อนไขอนุมัติ', `เพิ่มเงื่อนไข: ${minAmt}${maxAmt ? ' - ' + maxAmt : ' ขึ้นไป'} → ${flow}`, u.id, u.name]
    );
    return res.json({ pending: true });
  }
  const r = await pool.query(
    'INSERT INTO approval_conditions (min_amount, max_amount, flow) VALUES ($1,$2,$3) RETURNING *',
    [minAmt, maxAmt, flow.trim()]
  );
  res.json({ condition: r.rows[0] });
});

app.delete('/api/approval-conditions/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM approval_conditions WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ---------------- Admin requests ----------------
app.get('/api/admin-requests', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM admin_requests ORDER BY at DESC');
  res.json({ requests: r.rows });
});

app.post('/api/admin-requests/:id/approve', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT * FROM admin_requests WHERE id=$1', [id]);
  const reqRow = r.rows[0];
  if (!reqRow) return res.status(404).json({ error: 'ไม่พบคำขอ' });
  if (reqRow.payload && reqRow.type === 'สร้างผู้ใช้งานใหม่') {
    const p = reqRow.payload;
    const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [p.username]);
    if (exists.rowCount === 0) {
      const hash = await bcrypt.hash('Passw0rd!', 10);
      await pool.query(
        `INSERT INTO users (username, email, password_hash, role, position, name, active)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [p.username, p.email, hash, p.role, p.position || '', p.name]
      );
    }
  }
  await pool.query(`UPDATE admin_requests SET status='approved' WHERE id=$1`, [id]);
  res.json({ ok: true });
});

app.post('/api/admin-requests/:id/reject', requireAuth, async (req, res) => {
  await pool.query(`UPDATE admin_requests SET status='rejected' WHERE id=$1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ---------------- PRs ----------------
const PR_SELECT = `
  SELECT id, no, site, sub_code AS "subCode",
    requester_id AS "requesterId", requester_name AS "requester", requester_role AS "requesterRole",
    requester_position AS "requesterPosition",
    to_char(request_date,'YYYY-MM-DD') AS "requestDate", to_char(request_date,'YYYY-MM-DD') AS "date",
    to_char(needed_date,'YYYY-MM-DD') AS "neededDate", remark,
    foreman_user_id AS "foremanUserId", foreman_name AS "foremanName", foreman_position AS "foremanPosition",
    to_char(foreman_date,'YYYY-MM-DD') AS "foremanDate",
    manager_user_id AS "managerUserId", manager_name AS "managerName", manager_position AS "managerPosition",
    to_char(manager_date,'YYYY-MM-DD') AS "managerDate",
    status, step, created_at AS "createdAt"
  FROM prs`;

async function attachItemsAndHistory(pr) {
  const items = await pool.query(
    'SELECT material, area, brand, size, qty, price FROM pr_items WHERE pr_id=$1 ORDER BY idx', [pr.id]
  );
  const history = await pool.query(
    'SELECT who, action, at FROM pr_history WHERE pr_id=$1 ORDER BY at', [pr.id]
  );
  pr.items = items.rows.map(i => ({ ...i, qty: Number(i.qty), price: Number(i.price) }));
  pr.history = history.rows;
  return pr;
}

app.get('/api/prs', requireAuth, async (req, res) => {
  const r = await pool.query(`${PR_SELECT} ORDER BY id DESC`);
  const prs = await Promise.all(r.rows.map(attachItemsAndHistory));
  res.json({ prs });
});

app.get('/api/prs/:id', requireAuth, async (req, res) => {
  const r = await pool.query(`${PR_SELECT} WHERE id=$1`, [parseInt(req.params.id, 10)]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการ PR' });
  res.json({ pr: await attachItemsAndHistory(r.rows[0]) });
});

async function generatePrNumber(client) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await client.query('SELECT COUNT(*)::int AS n FROM prs');
    const no = 'PR-' + String(2600 + Math.floor(Math.random() * 99)) + '-' + String(countRes.rows[0].n + 1 + attempt).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM prs WHERE no=$1', [no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ PR ได้');
}

app.post('/api/prs', requireAuth, async (req, res) => {
  const u = req.currentUser;
  const { site, subCode, requestDate, neededDate, remark, items, foremanUserId, managerUserId } = req.body || {};
  if (!site || !site.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อโครงการ' });
  const cleanItems = (items || []).filter(i => i.material && i.material.trim() && Number(i.qty) > 0);
  if (cleanItems.length === 0) return res.status(400).json({ error: 'กรุณากรอกรายการวัสดุอย่างน้อย 1 รายการ' });

  const date = requestDate || new Date().toISOString().slice(0, 10);
  let status, histAction;
  if (u.role === 'super_user' || u.role === 'single_auto') {
    status = 'approved'; histAction = 'สร้างและอนุมัติอัตโนมัติ';
  } else if (u.role === 'single_dual') {
    status = 'pending_approval'; histAction = 'สร้างรายการ (รออนุมัติคู่)';
  } else {
    status = 'pending_check'; histAction = 'สร้างรายการ (รอตรวจสอบ)';
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const no = await generatePrNumber(client);

    let foremanUser = null, managerUser = null;
    if (foremanUserId) foremanUser = (await client.query('SELECT * FROM users WHERE id=$1', [foremanUserId])).rows[0];
    if (managerUserId) managerUser = (await client.query('SELECT * FROM users WHERE id=$1', [managerUserId])).rows[0];

    const insertPr = await client.query(
      `INSERT INTO prs (no, site, sub_code, requester_id, requester_name, requester_role, requester_position,
        request_date, needed_date, remark,
        foreman_user_id, foreman_name, foreman_position,
        manager_user_id, manager_name, manager_position,
        status, step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0)
       RETURNING id`,
      [no, site.trim(), (subCode || '').trim(), u.id, u.name, u.role, posLabel(u),
        date, neededDate || null, (remark || '').trim(),
        foremanUser ? foremanUser.id : null, foremanUser ? foremanUser.name : '', foremanUser ? foremanUser.position : '',
        managerUser ? managerUser.id : null, managerUser ? managerUser.name : '', managerUser ? managerUser.position : '',
        status]
    );
    const prId = insertPr.rows[0].id;

    for (let i = 0; i < cleanItems.length; i++) {
      const it = cleanItems[i];
      await client.query(
        `INSERT INTO pr_items (pr_id, idx, material, area, brand, size, qty, unit, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [prId, i, it.material.trim(), (it.area || '').trim(), (it.brand || '').trim(), (it.size || '').trim(),
          Number(it.qty) || 0, (it.unit || '').trim() || '-', Number(it.price) || 0]
      );
    }
    await client.query(
      `INSERT INTO pr_history (pr_id, who, action) VALUES ($1,$2,$3)`,
      [prId, u.name, histAction]
    );

    await client.query('COMMIT');
    const r = await pool.query(`${PR_SELECT} WHERE id=$1`, [prId]);
    res.json({ pr: await attachItemsAndHistory(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างรายการ PR ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/prs/:id/approve', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = req.currentUser;
  const r = await pool.query('SELECT * FROM prs WHERE id=$1', [id]);
  const pr = r.rows[0];
  if (!pr) return res.status(404).json({ error: 'ไม่พบรายการ PR' });

  const today = new Date().toISOString().slice(0, 10);
  const sets = [];
  const vals = [];
  let idx = 1;
  if (pr.foreman_user_id === u.id && !pr.foreman_date) { sets.push(`foreman_date=$${idx++}`); vals.push(today); }
  if (pr.manager_user_id === u.id && !pr.manager_date) { sets.push(`manager_date=$${idx++}`); vals.push(today); }

  let nextStatus, action;
  if (pr.status === 'pending_check' && u.role === 'checker') {
    nextStatus = 'pending_approval'; action = 'ตรวจสอบผ่าน ส่งต่อผู้อนุมัติ';
  } else {
    nextStatus = 'approved'; action = 'อนุมัติรายการ';
  }
  sets.push(`status=$${idx++}`); vals.push(nextStatus);
  vals.push(id);
  await pool.query(`UPDATE prs SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
  await pool.query('INSERT INTO pr_history (pr_id, who, action) VALUES ($1,$2,$3)', [id, u.name, action]);

  const updated = await pool.query(`${PR_SELECT} WHERE id=$1`, [id]);
  res.json({ pr: await attachItemsAndHistory(updated.rows[0]) });
});

app.post('/api/prs/:id/reject', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = req.currentUser;
  await pool.query(`UPDATE prs SET status='rejected' WHERE id=$1`, [id]);
  await pool.query('INSERT INTO pr_history (pr_id, who, action) VALUES ($1,$2,$3)', [id, u.name, 'ปฏิเสธรายการ']);
  const updated = await pool.query(`${PR_SELECT} WHERE id=$1`, [id]);
  if (updated.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการ PR' });
  res.json({ pr: await attachItemsAndHistory(updated.rows[0]) });
});

// ---------------- Public: company signup (feeds SiteReq Admin's customer CRM) ----------------
// Mirrors the field set of the "+ เพิ่มบริษัทลูกค้า" form in SiteReq Admin exactly.
app.get('/api/packages', async (req, res) => {
  const r = await pool.query('SELECT id, name, price, billing_cycle, description, max_users FROM packages WHERE active = true ORDER BY price');
  res.json({ packages: r.rows });
});

app.post('/api/company-signup', async (req, res) => {
  const { name, taxId, phone, email, address, packageId, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const passwordHash = password && password.trim() ? await bcrypt.hash(password.trim(), 10) : null;
  const r = await pool.query(
    `INSERT INTO customer_companies (name, tax_id, phone, email, address, package_id, password_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name.trim(), (taxId || '').trim(), (phone || '').trim(), (email || '').trim(), (address || '').trim(), packageId || null, passwordHash]
  );
  await seedDefaultClientChartOfAccounts(r.rows[0].id);
  res.json({ company: serializeCompany(r.rows[0]) });
});

// ---------------- Public: trial signup (feeds SiteReq Admin's leads/prospects list, not an account) ----------------
// Mirrors the field set of "เพิ่มรายชื่อบริษัทที่สนใจ" in SiteReq Admin — this does NOT create a
// working customer_companies/customers account; it only queues a lead for the sales team to follow up.
async function generateUniqueLeadRefCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const exists = await pool.query('SELECT 1 FROM leads WHERE ref_code = $1', [code]);
    if (exists.rowCount === 0) return code;
  }
  throw new Error('ไม่สามารถสร้างรหัสอ้างอิงได้ กรุณาลองใหม่');
}

app.post('/api/leads/trial-signup', async (req, res) => {
  const {
    companyName, taxId, address, companyPhone, companyEmail, website,
    contactName, contactPosition, contactEmail, contactPhone, username,
  } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM leads WHERE username = $1', [trimmedUsername]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const refCode = await generateUniqueLeadRefCode();
  const r = await pool.query(
    `INSERT INTO leads (ref_code, company_name, tax_id, address, company_phone, company_email, website,
       contact_name, contact_position, contact_email, contact_phone, username, status, seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',false) RETURNING *`,
    [refCode, companyName.trim(), (taxId || '').trim(), (address || '').trim(), (companyPhone || '').trim(), (companyEmail || '').trim(), (website || '').trim(),
     (contactName || '').trim(), (contactPosition || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(), trimmedUsername || null]
  );
  res.json({ lead: { refCode: r.rows[0].ref_code } });
});

app.post('/api/customer-login', async (req, res) => {
  const { companyCode, username, password } = req.body || {};
  if (!companyCode || !companyCode.trim() || !username || !username.trim() || !password) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสบริษัท ชื่อผู้ใช้งาน และรหัสผ่าน' });
  }
  const companyRes = await pool.query(
    `SELECT c.*, p.name AS "packageName" FROM customer_companies c
     LEFT JOIN packages p ON p.id = c.package_id WHERE c.code = $1`,
    [companyCode.trim()]
  );
  const company = companyRes.rows[0];
  if (!company || company.status !== 'active') return res.status(401).json({ error: 'ไม่พบรหัสบริษัท หรือบริษัทถูกระงับการใช้งาน' });
  const customerRes = await pool.query('SELECT * FROM customers WHERE company_id = $1 AND username = $2', [company.id, username.trim()]);
  const customer = customerRes.rows[0];
  if (!customer || customer.status !== 'active' || !customer.password_hash) {
    return res.status(401).json({ error: 'ไม่พบบัญชีผู้ใช้งาน หรือบัญชีถูกระงับ' });
  }
  const ok = await bcrypt.compare(password, customer.password_hash);
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  req.session.customerId = customer.id;
  res.json({ customer: serializeCustomer(customer), company: serializeCompany(company) });
});

// ---------------- Customer-facing: company logo upload ----------------
const LOGOS_DIR = path.join(__dirname, 'uploads', 'logos');
fs.mkdirSync(LOGOS_DIR, { recursive: true });
app.use('/company-logo', express.static(LOGOS_DIR, { maxAge: '1d' }));

const ALLOWED_LOGO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGOS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_LOGO_MIME.has(file.mimetype)),
});
function uploadLogoMiddleware(req, res, next) {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 2MB' : 'อัปโหลดไฟล์ไม่สำเร็จ (รองรับ jpg, png, webp, svg)' });
    next();
  });
}

app.post('/api/customer/logo', requireCustomerAuth, uploadLogoMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์โลโก้ (jpg, png, webp, svg ขนาดไม่เกิน 2MB)' });
  const oldRes = await pool.query('SELECT logo_url FROM customer_companies WHERE id = $1', [req.customer.company_id]);
  const oldUrl = oldRes.rows[0] && oldRes.rows[0].logo_url;
  const logoUrl = `/company-logo/${req.file.filename}`;
  const r = await pool.query(
    'UPDATE customer_companies SET logo_url = $1 WHERE id = $2 RETURNING *',
    [logoUrl, req.customer.company_id]
  );
  if (oldUrl && oldUrl.startsWith('/company-logo/')) {
    fs.unlink(path.join(LOGOS_DIR, path.basename(oldUrl)), () => {});
  }
  res.json({ company: serializeCompany(r.rows[0]) });
});

// ---------------- Customer-facing: manage own company's users (ผู้ติดต่อ), quota-enforced by package ----------------
async function getCompanyMaxUsers(companyId) {
  const subRes = await pool.query('SELECT * FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [companyId]);
  const sub = subRes.rows[0];
  const subActive = sub && sub.status === 'active' && (!sub.expires_at || new Date(sub.expires_at) >= new Date());
  if (subActive) return sub.max_users;
  const pkgRes = await pool.query(
    `SELECT p.max_users AS n FROM customer_companies c LEFT JOIN packages p ON p.id = c.package_id WHERE c.id = $1`,
    [companyId]
  );
  return pkgRes.rows[0] && pkgRes.rows[0].n != null ? pkgRes.rows[0].n : 0;
}

app.get('/api/customer/users', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query('SELECT * FROM customers WHERE company_id = $1 ORDER BY id', [companyId]);
  const maxUsers = await getCompanyMaxUsers(companyId);
  res.json({ users: r.rows.map(serializeCustomer), maxUsers, usedCount: r.rowCount });
});

app.post('/api/customer/users', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { name, email, phone, position, username, password, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้งาน' });
  const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE company_id=$1', [companyId]);
  const maxUsers = await getCompanyMaxUsers(companyId);
  if (countRes.rows[0].n >= maxUsers) {
    return res.status(403).json({ error: 'ผู้ใช้งานครบจำนวนแล้วตามแพ็กเกจ' });
  }
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM customers WHERE username = $1', [trimmedUsername]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const passwordHash = password && password.trim() ? await bcrypt.hash(password.trim(), 10) : null;
  const safeRole = CUSTOMER_ROLES.has(role) ? role : 'super_user';
  const trimmedPosition = (position || '').trim();
  const r = await pool.query(
    `INSERT INTO customers (company_id, name, email, phone, position, username, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, name.trim(), (email || '').trim(), (phone || '').trim(), trimmedPosition, trimmedUsername || null, passwordHash, safeRole]
  );
  // Same auto-grant as the employees flow (see maybeAutoGrantApprovalPermission) — this is the
  // route that actually creates most HR logins in practice (via "จัดการผู้ใช้งาน" directly, not
  // "จัดการพนักงาน"), so it needs the same hook or ฝ่ายธุรการ/HR accounts created here never get
  // can_approve_applications set.
  await maybeAutoGrantApprovalPermission(companyId, trimmedPosition, r.rows[0].id);
  const fresh = await pool.query('SELECT * FROM customers WHERE id = $1', [r.rows[0].id]);
  res.json({ user: serializeCustomer(fresh.rows[0]) });
});

app.put('/api/customer/users/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = await pool.query('SELECT 1 FROM customers WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
  const { name, email, phone, position, username, password, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้งาน' });
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM customers WHERE username = $1 AND id <> $2', [trimmedUsername, id]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const safeRole = CUSTOMER_ROLES.has(role) ? role : 'super_user';
  const trimmedPosition = (position || '').trim();
  if (password && password.trim()) {
    const passwordHash = await bcrypt.hash(password.trim(), 10);
    await pool.query(
      `UPDATE customers SET name=$1, email=$2, phone=$3, position=$4, username=$5, password_hash=$6, role=$7 WHERE id=$8`,
      [name.trim(), (email || '').trim(), (phone || '').trim(), trimmedPosition, trimmedUsername || null, passwordHash, safeRole, id]
    );
  } else {
    await pool.query(
      `UPDATE customers SET name=$1, email=$2, phone=$3, position=$4, username=$5, role=$6 WHERE id=$7`,
      [name.trim(), (email || '').trim(), (phone || '').trim(), trimmedPosition, trimmedUsername || null, safeRole, id]
    );
  }
  // Auto-grant applies on edit too — e.g. someone's position gets changed to ฝ่ายธุรการ/HR after
  // their account already existed. Grant-only, same as the employees flow: never auto-revokes if
  // the position changes away, that stays a manual "ถอนสิทธิ์" action.
  await maybeAutoGrantApprovalPermission(req.customer.company_id, trimmedPosition, id);
  const fresh = await pool.query('SELECT * FROM customers WHERE id=$1', [id]);
  res.json({ user: serializeCustomer(fresh.rows[0]) });
});

app.post('/api/customer/users/:id/toggle-active', requireCustomerAuth, async (req, res) => {
  if (req.customer.role !== 'super_user') {
    return res.status(403).json({ error: 'เฉพาะ Super User เท่านั้นที่มีสิทธิ์ปิด/เปิดใช้งานบัญชีผู้ใช้งาน' });
  }
  const id = parseInt(req.params.id, 10);
  const own = await pool.query('SELECT 1 FROM customers WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
  const r = await pool.query(
    `UPDATE customers SET status = CASE WHEN status='active' THEN 'suspended' ELSE 'active' END WHERE id=$1 RETURNING *`,
    [id]
  );
  res.json({ user: serializeCustomer(r.rows[0]) });
});

// ---------------- Customer-facing: approval conditions, scoped per company ----------------
app.get('/api/customer/approval-conditions', requireCustomerAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM customer_approval_conditions WHERE company_id=$1 ORDER BY min_amount',
    [req.customer.company_id]
  );
  res.json({ conditions: r.rows });
});

app.post('/api/customer/approval-conditions', requireCustomerAuth, async (req, res) => {
  const { min, max, flow } = req.body || {};
  if (!flow || !flow.trim()) return res.status(400).json({ error: 'กรุณากรอกรูปแบบการอนุมัติ' });
  const minAmt = parseFloat(min) || 0;
  const maxAmt = max === '' || max == null ? null : parseFloat(max);
  const r = await pool.query(
    'INSERT INTO customer_approval_conditions (company_id, min_amount, max_amount, flow) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.customer.company_id, minAmt, maxAmt, flow.trim()]
  );
  res.json({ condition: r.rows[0] });
});

app.delete('/api/customer/approval-conditions/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    'DELETE FROM customer_approval_conditions WHERE id=$1 AND company_id=$2',
    [id, req.customer.company_id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบเงื่อนไข' });
  res.json({ ok: true });
});

// ---------------- Customer-facing: job positions (จัดการตำแหน่งงาน) ----------------
function serializeJobPosition(row) {
  return { id: row.id, name: row.name, category: row.category, isActive: row.is_active };
}

app.get('/api/customer/job-positions', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM job_positions WHERE company_id=$1 ORDER BY id', [req.customer.company_id]);
  res.json({ positions: r.rows.map(serializeJobPosition) });
});

app.post('/api/customer/job-positions', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { name, category } = req.body || {};
  if (!name || !name.trim() || !category || !category.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const exists = await pool.query('SELECT 1 FROM job_positions WHERE company_id=$1 AND name=$2 AND category=$3', [companyId, name.trim(), category.trim()]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'มีตำแหน่งนี้ในหมวดหมู่นี้อยู่แล้ว' });
  const r = await pool.query(
    `INSERT INTO job_positions (company_id, name, category) VALUES ($1,$2,$3) RETURNING *`,
    [companyId, name.trim(), category.trim()]
  );
  res.json({ position: serializeJobPosition(r.rows[0]) });
});

app.put('/api/customer/job-positions/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT 1 FROM job_positions WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบตำแหน่งงาน' });
  const { name, category } = req.body || {};
  if (!name || !name.trim() || !category || !category.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const dup = await pool.query('SELECT 1 FROM job_positions WHERE company_id=$1 AND name=$2 AND category=$3 AND id<>$4', [companyId, name.trim(), category.trim(), id]);
  if (dup.rowCount > 0) return res.status(409).json({ error: 'มีตำแหน่งนี้ในหมวดหมู่นี้อยู่แล้ว' });
  const r = await pool.query('UPDATE job_positions SET name=$1, category=$2 WHERE id=$3 RETURNING *', [name.trim(), category.trim(), id]);
  res.json({ position: serializeJobPosition(r.rows[0]) });
});

app.post('/api/customer/job-positions/:id/toggle-active', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = await pool.query('SELECT 1 FROM job_positions WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบตำแหน่งงาน' });
  const r = await pool.query('UPDATE job_positions SET is_active = NOT is_active WHERE id=$1 RETURNING *', [id]);
  res.json({ position: serializeJobPosition(r.rows[0]) });
});

// ---------------- Customer-facing: leave types (ประเภทวันลา) ----------------
function serializeLeaveType(row) {
  return {
    id: row.id, name: row.name, defaultDaysPerYear: Number(row.default_days_per_year),
    isPaid: row.is_paid, isCompanyPolicy: row.is_company_policy,
  };
}
app.get('/api/customer/leave-types', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM leave_types WHERE company_id=$1 ORDER BY id', [req.customer.company_id]);
  res.json({ leaveTypes: r.rows.map(serializeLeaveType) });
});

// Fixed set of 6 seeded types (not freely add/delete-able like job_positions) — companies only
// ever adjust the numbers, most relevantly ลาอุปสมบท's default_days_per_year since that one is
// explicitly "ตามนโยบายบริษัท". Gated the same as other company-settings edits: any logged-in
// customer user, no extra role check (matches job_positions/employees today).
app.put('/api/customer/leave-types/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT 1 FROM leave_types WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบประเภทวันลา' });
  const { defaultDaysPerYear, isPaid } = req.body || {};
  if (defaultDaysPerYear === undefined || defaultDaysPerYear === null || Number(defaultDaysPerYear) < 0) {
    return res.status(400).json({ error: 'กรุณากรอกจำนวนวันให้ถูกต้อง' });
  }
  const r = await pool.query(
    'UPDATE leave_types SET default_days_per_year=$1, is_paid=$2 WHERE id=$3 RETURNING *',
    [Number(defaultDaysPerYear), !!isPaid, id]
  );
  res.json({ leaveType: serializeLeaveType(r.rows[0]) });
});

// ---------------- Customer-facing: public holidays (วันหยุดนักขัตฤกษ์) ----------------
// holiday_date always read back as YYYY-MM-DD text (to_char, not the raw DATE value) to sidestep
// node-postgres returning DATE columns as JS Date objects at UTC midnight, which can shift a day
// when the server or client formats it in a non-UTC timezone.
function serializePublicHoliday(row) {
  return { id: row.id, holidayDate: row.holiday_date, name: row.name, year: row.year };
}
app.get('/api/customer/public-holidays', requireCustomerAuth, async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const r = await pool.query(
    `SELECT id, company_id, to_char(holiday_date,'YYYY-MM-DD') AS holiday_date, name, year
     FROM public_holidays WHERE company_id=$1 AND year=$2 ORDER BY holiday_date`,
    [req.customer.company_id, year]
  );
  res.json({ holidays: r.rows.map(serializePublicHoliday) });
});
app.post('/api/customer/public-holidays', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { holidayDate, name } = req.body || {};
  if (!holidayDate || !name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกวันที่และชื่อวันหยุด' });
  const exists = await pool.query('SELECT 1 FROM public_holidays WHERE company_id=$1 AND holiday_date=$2', [companyId, holidayDate]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'มีวันหยุดในวันที่นี้อยู่แล้ว' });
  const r = await pool.query(
    `INSERT INTO public_holidays (company_id, holiday_date, name, year)
     VALUES ($1,$2,$3, EXTRACT(YEAR FROM $2::date))
     RETURNING id, company_id, to_char(holiday_date,'YYYY-MM-DD') AS holiday_date, name, year`,
    [companyId, holidayDate, name.trim()]
  );
  res.json({ holiday: serializePublicHoliday(r.rows[0]) });
});
app.put('/api/customer/public-holidays/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT 1 FROM public_holidays WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบวันหยุด' });
  const { holidayDate, name } = req.body || {};
  if (!holidayDate || !name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกวันที่และชื่อวันหยุด' });
  const dup = await pool.query('SELECT 1 FROM public_holidays WHERE company_id=$1 AND holiday_date=$2 AND id<>$3', [companyId, holidayDate, id]);
  if (dup.rowCount > 0) return res.status(409).json({ error: 'มีวันหยุดในวันที่นี้อยู่แล้ว' });
  const r = await pool.query(
    `UPDATE public_holidays SET holiday_date=$1, name=$2, year=EXTRACT(YEAR FROM $1::date) WHERE id=$3
     RETURNING id, company_id, to_char(holiday_date,'YYYY-MM-DD') AS holiday_date, name, year`,
    [holidayDate, name.trim(), id]
  );
  res.json({ holiday: serializePublicHoliday(r.rows[0]) });
});
app.delete('/api/customer/public-holidays/:id', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('DELETE FROM public_holidays WHERE id=$1 AND company_id=$2', [parseInt(req.params.id, 10), req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบวันหยุด' });
  res.json({ ok: true });
});

// ---------------- Customer-facing: employees (จัดการพนักงาน) ----------------
function serializeEmployee(row) {
  return {
    id: row.id, employeeCode: row.employee_code, fullName: row.full_name, position: row.position,
    employmentType: row.employment_type, wageRate: Number(row.wage_rate), phone: row.phone,
    idCardNumber: row.id_card_number,
    startDate: row.start_date ? new Date(row.start_date).toISOString().slice(0, 10) : '',
    status: row.status, customerId: row.customer_id,
    nationality: row.nationality || '', isForeignWorker: row.is_foreign_worker === true,
  };
}

// Requirement: an employee added with position 'ฝ่ายธุรการ/HR' who is linked to a real login
// account (customerId) gets can_approve_applications=true the moment they're added — not on
// every subsequent edit, so this only runs from the POST (create) handler below.
async function maybeAutoGrantApprovalPermission(companyId, position, customerId) {
  if (position !== 'ฝ่ายธุรการ/HR' || !customerId) return;
  await pool.query(
    'UPDATE customers SET can_approve_applications = true WHERE id = $1 AND company_id = $2',
    [customerId, companyId]
  );
}

// Called from both employee-creation paths (POST /api/customer/employees and the job-application
// "รับเข้าเป็นพนักงาน" convert-to-employee route) — seeds one balance row per this company's
// leave_types for the given year, using each type's CURRENT default_days_per_year as the starting
// total. ON CONFLICT DO NOTHING makes this safe to call again without double-seeding.
async function seedLeaveBalanceForEmployee(companyId, employeeId, year) {
  const types = await pool.query('SELECT id, default_days_per_year FROM leave_types WHERE company_id=$1', [companyId]);
  if (types.rowCount === 0) return;
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const t of types.rows) {
    placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3},0)`);
    values.push(employeeId, t.id, year, t.default_days_per_year);
    i += 4;
  }
  await pool.query(
    `INSERT INTO employee_leave_balance (employee_id, leave_type_id, year, total_days, used_days)
     VALUES ${placeholders.join(',')} ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
    values
  );
}
function serializeLeaveBalance(row) {
  return {
    id: row.id, employeeId: row.employee_id, leaveTypeId: row.leave_type_id, leaveTypeName: row.leave_type_name,
    year: row.year, totalDays: Number(row.total_days), usedDays: Number(row.used_days), remainingDays: Number(row.remaining_days),
  };
}

app.get('/api/customer/employees', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM employees WHERE company_id=$1 ORDER BY id', [req.customer.company_id]);
  res.json({ employees: r.rows.map(serializeEmployee) });
});

// Used by "บันทึกวันลา" to show remaining balance for the selected employee before submitting a
// request — scoped through employees.company_id (not a direct employee_id filter) so one company
// can never read another's leave balances even with a guessed employee id.
app.get('/api/customer/employees/:id/leave-balance', requireCustomerAuth, async (req, res) => {
  const employeeId = parseInt(req.params.id, 10);
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const own = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2', [employeeId, req.customer.company_id]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
  const r = await pool.query(
    `SELECT b.*, lt.name AS leave_type_name FROM employee_leave_balance b
     JOIN leave_types lt ON lt.id = b.leave_type_id
     WHERE b.employee_id=$1 AND b.year=$2 ORDER BY lt.id`,
    [employeeId, year]
  );
  res.json({ balances: r.rows.map(serializeLeaveBalance) });
});

// ---------------- Customer-facing: leave requests (บันทึกวันลา) ----------------
// Counts start..end inclusive, minus Sundays (fixed weekly off day — this app has no per-employee
// work-schedule concept to derive it from, so Sunday is the documented assumption; construction-
// industry 6-day workweeks match the seeded 6-day annual leave default) and minus any day that
// falls on a company public_holidays row. Stored once at creation, not recomputed later.
async function calculateLeaveDaysCount(companyId, startDate, endDate) {
  const holidaysRes = await pool.query(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') AS d FROM public_holidays WHERE company_id=$1 AND holiday_date BETWEEN $2 AND $3`,
    [companyId, startDate, endDate]
  );
  const holidaySet = new Set(holidaysRes.rows.map(r => r.d));
  let count = 0;
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    if (cur.getUTCDay() !== 0 && !holidaySet.has(iso)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}
function serializeLeaveRequest(row) {
  return {
    id: row.id, employeeId: row.employee_id, employeeName: row.employee_name, employeeCode: row.employee_code,
    leaveTypeId: row.leave_type_id, leaveTypeName: row.leave_type_name, isPaid: row.is_paid,
    startDate: row.start_date, endDate: row.end_date, daysCount: Number(row.days_count),
    reason: row.reason, status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}
const LEAVE_REQUEST_SELECT = `
  SELECT lr.*, to_char(lr.start_date,'YYYY-MM-DD') AS start_date, to_char(lr.end_date,'YYYY-MM-DD') AS end_date,
         e.full_name AS employee_name, e.employee_code AS employee_code, lt.name AS leave_type_name, lt.is_paid
  FROM leave_requests lr
  JOIN employees e ON e.id = lr.employee_id
  JOIN leave_types lt ON lt.id = lr.leave_type_id`;

app.get('/api/customer/leave-requests', requireCustomerAuth, async (req, res) => {
  const r = await pool.query(
    `${LEAVE_REQUEST_SELECT} WHERE e.company_id=$1 ORDER BY lr.start_date DESC`,
    [req.customer.company_id]
  );
  res.json({ leaveRequests: r.rows.map(serializeLeaveRequest) });
});

app.post('/api/customer/leave-requests', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeId, leaveTypeId, startDate, endDate, reason } = req.body || {};
  if (!employeeId || !leaveTypeId || !startDate || !endDate) {
    return res.status(400).json({ error: 'กรุณาเลือกพนักงาน ประเภทวันลา และช่วงวันที่ให้ครบถ้วน' });
  }
  if (endDate < startDate) return res.status(400).json({ error: 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น' });
  const empRes = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2', [employeeId, companyId]);
  if (empRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
  const typeRes = await pool.query('SELECT 1 FROM leave_types WHERE id=$1 AND company_id=$2', [leaveTypeId, companyId]);
  if (typeRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบประเภทวันลา' });
  const daysCount = await calculateLeaveDaysCount(companyId, startDate, endDate);
  const ins = await pool.query(
    `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days_count, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [employeeId, leaveTypeId, startDate, endDate, daysCount, (reason || '').trim()]
  );
  const r = await pool.query(`${LEAVE_REQUEST_SELECT} WHERE lr.id=$1`, [ins.rows[0].id]);
  res.json({ leaveRequest: serializeLeaveRequest(r.rows[0]) });
});

// Reuses can_approve_applications rather than a separate can_approve_leave flag — this app is
// small enough that "the HR person who approves job applications" and "who approves leave" are
// the same people in practice; a separate permission can be split out later if that stops holding.
app.put('/api/customer/leave-requests/:id/decision', requireCustomerAuth, requireCanApproveApplications, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { decision } = req.body || {};
  if (decision !== 'approved' && decision !== 'rejected') return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  const own = await pool.query(
    `SELECT lr.* FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.id=$1 AND e.company_id=$2`,
    [id, req.customer.company_id]
  );
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบคำขอลา' });
  if (own.rows[0].status !== 'pending') return res.status(400).json({ error: 'คำขอนี้ถูกพิจารณาไปแล้ว' });
  await pool.query(
    `UPDATE leave_requests SET status=$1, approved_by=$2, approved_at=now() WHERE id=$3`,
    [decision, req.customer.id, id]
  );
  if (decision === 'approved') {
    // Balance is keyed by the request's start_date year — own.rows[0].start_date comes back from
    // pg as a JS Date at UTC midnight, so getUTCFullYear() (not getFullYear()) avoids a possible
    // off-by-one-year shift depending on server timezone. Upsert rather than plain UPDATE: if no
    // balance row exists yet for this employee/type/year (e.g. approved after the leave_types set
    // changed), this still records the usage instead of silently no-op'ing.
    const year = own.rows[0].start_date.getUTCFullYear();
    await pool.query(
      `INSERT INTO employee_leave_balance (employee_id, leave_type_id, year, total_days, used_days)
       VALUES ($1,$2,$3,0,$4)
       ON CONFLICT (employee_id, leave_type_id, year)
       DO UPDATE SET used_days = employee_leave_balance.used_days + EXCLUDED.used_days`,
      [own.rows[0].employee_id, own.rows[0].leave_type_id, year, own.rows[0].days_count]
    );
  }
  const full = await pool.query(`${LEAVE_REQUEST_SELECT} WHERE lr.id=$1`, [id]);
  res.json({ leaveRequest: serializeLeaveRequest(full.rows[0]) });
});

app.post('/api/customer/employees', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeCode, fullName, position, employmentType, wageRate, phone, idCardNumber, startDate, customerId, nationality, isForeignWorker } = req.body || {};
  if (!employeeCode || !fullName || !position || !wageRate) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const exists = await pool.query('SELECT 1 FROM employees WHERE company_id=$1 AND employee_code=$2', [companyId, employeeCode]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสพนักงานนี้มีอยู่แล้ว' });
  const r = await pool.query(
    `INSERT INTO employees (company_id, employee_code, full_name, position, employment_type, wage_rate, phone, id_card_number, start_date, status, customer_id, nationality, is_foreign_worker)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12) RETURNING *`,
    [companyId, employeeCode.trim(), fullName.trim(), position.trim(), employmentType || 'monthly', Number(wageRate) || 0,
     (phone || '').trim(), (idCardNumber || '').trim(), startDate || null, customerId || null,
     (nationality || '').trim(), !!isForeignWorker]
  );
  await maybeAutoGrantApprovalPermission(companyId, position.trim(), customerId || null);
  await seedLeaveBalanceForEmployee(companyId, r.rows[0].id, new Date().getFullYear());
  res.json({ employee: serializeEmployee(r.rows[0]) });
});

app.put('/api/customer/employees/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
  const { employeeCode, fullName, position, employmentType, wageRate, phone, idCardNumber, startDate, customerId, nationality, isForeignWorker } = req.body || {};
  if (!employeeCode || !fullName || !position || !wageRate) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  const dup = await pool.query('SELECT 1 FROM employees WHERE company_id=$1 AND employee_code=$2 AND id<>$3', [companyId, employeeCode, id]);
  if (dup.rowCount > 0) return res.status(409).json({ error: 'รหัสพนักงานนี้มีอยู่แล้ว' });
  const r = await pool.query(
    `UPDATE employees SET employee_code=$1, full_name=$2, position=$3, employment_type=$4, wage_rate=$5, phone=$6, id_card_number=$7, start_date=$8, customer_id=$9, nationality=$10, is_foreign_worker=$11
     WHERE id=$12 RETURNING *`,
    [employeeCode.trim(), fullName.trim(), position.trim(), employmentType || 'monthly', Number(wageRate) || 0,
     (phone || '').trim(), (idCardNumber || '').trim(), startDate || null, customerId || null,
     (nationality || '').trim(), !!isForeignWorker, id]
  );
  res.json({ employee: serializeEmployee(r.rows[0]) });
});

app.post('/api/customer/employees/:id/toggle-active', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
  const r = await pool.query(
    `UPDATE employees SET status = CASE WHEN status='active' THEN 'inactive' ELSE 'active' END WHERE id=$1 RETURNING *`,
    [id]
  );
  res.json({ employee: serializeEmployee(r.rows[0]) });
});

// ---------------- Foreign worker documents (เอกสารแรงงานต่างด้าว) ----------------
const FOREIGN_WORKER_DOC_TYPES = ['passport', 'work_permit', 'visa', 'border_pass', 'health_insurance', 'health_checkup'];
const FOREIGN_WORKER_DOC_TYPE_LABELS_TH = {
  passport: 'หนังสือเดินทาง (Passport)', work_permit: 'ใบอนุญาตทำงาน (Work Permit)', visa: 'วีซ่า (Visa)',
  border_pass: 'บัตรผ่านแดน (Border Pass)', health_insurance: 'ประกันสุขภาพ', health_checkup: 'ผลตรวจสุขภาพ',
};
const FOREIGN_WORKER_DOCS_DIR = path.join(__dirname, 'uploads', 'foreign-worker-docs');
fs.mkdirSync(FOREIGN_WORKER_DOCS_DIR, { recursive: true });
const ALLOWED_FWD_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const fwdUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FOREIGN_WORKER_DOCS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_FWD_MIME.has(file.mimetype)),
});
function uploadFwdMiddleware(req, res, next) {
  fwdUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ (รองรับ jpg, png, webp, pdf)' });
    next();
  });
}
// status is never taken from client input — always derived from expiry_date here so the stored
// value can't drift from what the "หมดอายุแล้ว" badge (and the cron notifier) actually mean.
// "today" as the server's LOCAL calendar date, not new Date().toISOString()'s UTC date — this
// server runs in Asia/Bangkok (UTC+7), so using the UTC date would misclassify a document as still
// active for the first 7 hours of its actual expiry day (or the reverse near local midnight).
function todayLocalStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function computeForeignWorkerDocStatus(expiryDateStr) {
  return expiryDateStr < todayLocalStr() ? 'expired' : 'active';
}
// node-postgres parses a DATE column into a JS Date built from LOCAL year/month/day (i.e. local
// midnight on that calendar date) — not UTC midnight. Reading it back with getUTC*()/toISOString()
// silently shifts the date backward by the server's UTC offset (e.g. one day early on this
// Bangkok/UTC+7 server), which would be a real bug for expiry tracking specifically. Reading the
// LOCAL components back out (as they were written in) round-trips correctly regardless of the
// server's timezone.
function pgDateToStr(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function serializeForeignWorkerDocument(row) {
  return {
    id: row.id, employeeId: row.employee_id, employeeName: row.employee_name, employeeCode: row.employee_code,
    nationality: row.nationality || '',
    documentType: row.document_type, documentNumber: row.document_number,
    issueDate: pgDateToStr(row.issue_date), expiryDate: pgDateToStr(row.expiry_date),
    fileAttachment: row.file_attachment, status: row.status, createdAt: row.created_at,
  };
}
const FWD_SELECT = `
  SELECT fwd.*, e.full_name AS employee_name, e.employee_code AS employee_code, e.nationality AS nationality
  FROM foreign_worker_documents fwd
  JOIN employees e ON e.id = fwd.employee_id`;

app.get('/api/customer/foreign-worker-documents', requireCustomerAuth, async (req, res) => {
  const r = await pool.query(`${FWD_SELECT} WHERE e.company_id=$1 ORDER BY fwd.expiry_date ASC`, [req.customer.company_id]);
  res.json({ documents: r.rows.map(serializeForeignWorkerDocument) });
});

app.post('/api/customer/foreign-worker-documents', requireCustomerAuth, uploadFwdMiddleware, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeId, documentType, documentNumber, issueDate, expiryDate } = req.body || {};
  if (!employeeId || !documentType || !expiryDate) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'กรุณาเลือกพนักงาน ประเภทเอกสาร และวันหมดอายุให้ครบถ้วน' });
  }
  if (!FOREIGN_WORKER_DOC_TYPES.includes(documentType)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ประเภทเอกสารไม่ถูกต้อง' });
  }
  const empRes = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2 AND is_foreign_worker=true', [employeeId, companyId]);
  if (empRes.rowCount === 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'ไม่พบพนักงานแรงงานต่างด้าวรายนี้' });
  }
  const status = computeForeignWorkerDocStatus(expiryDate);
  const ins = await pool.query(
    `INSERT INTO foreign_worker_documents (employee_id, document_type, document_number, issue_date, expiry_date, file_attachment, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [employeeId, documentType, (documentNumber || '').trim(), issueDate || null, expiryDate, req.file ? req.file.filename : null, status]
  );
  const r = await pool.query(`${FWD_SELECT} WHERE fwd.id=$1`, [ins.rows[0].id]);
  res.json({ document: serializeForeignWorkerDocument(r.rows[0]) });
});

app.put('/api/customer/foreign-worker-documents/:id', requireCustomerAuth, uploadFwdMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const existing = await pool.query(
    `SELECT fwd.*, e.company_id AS company_id FROM foreign_worker_documents fwd JOIN employees e ON e.id = fwd.employee_id WHERE fwd.id=$1`,
    [id]
  );
  if (existing.rowCount === 0 || existing.rows[0].company_id !== companyId) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'ไม่พบเอกสาร' });
  }
  const { documentType, documentNumber, issueDate, expiryDate } = req.body || {};
  if (!documentType || !expiryDate) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'กรุณากรอกประเภทเอกสารและวันหมดอายุให้ครบถ้วน' });
  }
  if (!FOREIGN_WORKER_DOC_TYPES.includes(documentType)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ประเภทเอกสารไม่ถูกต้อง' });
  }
  const status = computeForeignWorkerDocStatus(expiryDate);
  const oldExpiry = existing.rows[0].expiry_date ? new Date(existing.rows[0].expiry_date).toISOString().slice(0, 10) : null;
  const expiryChanged = oldExpiry !== expiryDate;
  const oldFile = existing.rows[0].file_attachment;
  const newFile = req.file ? req.file.filename : oldFile;
  const r = await pool.query(
    `UPDATE foreign_worker_documents SET document_type=$1, document_number=$2, issue_date=$3, expiry_date=$4, file_attachment=$5, status=$6
     ${expiryChanged ? ', notified_30d_at=NULL, notified_expired_at=NULL' : ''}
     WHERE id=$7 RETURNING *`,
    [documentType, (documentNumber || '').trim(), issueDate || null, expiryDate, newFile, status, id]
  );
  if (req.file && oldFile) fs.unlink(path.join(FOREIGN_WORKER_DOCS_DIR, oldFile), () => {});
  const rFull = await pool.query(`${FWD_SELECT} WHERE fwd.id=$1`, [id]);
  res.json({ document: serializeForeignWorkerDocument(rFull.rows[0]) });
});

app.get('/api/customer/foreign-worker-documents/:id/file', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    `SELECT fwd.file_attachment, e.company_id AS company_id FROM foreign_worker_documents fwd JOIN employees e ON e.id = fwd.employee_id WHERE fwd.id=$1`,
    [id]
  );
  if (r.rowCount === 0 || r.rows[0].company_id !== req.customer.company_id || !r.rows[0].file_attachment) {
    return res.status(404).json({ error: 'ไม่พบไฟล์เอกสาร' });
  }
  res.sendFile(path.join(FOREIGN_WORKER_DOCS_DIR, r.rows[0].file_attachment));
});

// ---------------- Customer-facing: job applications (ใบสมัครงาน) ----------------
// Two field whitelists, deliberately kept separate: JOB_APP_HR_FIELDS only ever gets written by
// routes gated with requireCanApproveApplications below (PUT .../hr, POST .../decision) — never
// by the general PUT, even for a company-admin role, so the "who touched the HR section" story
// stays simple. The applicant-facing fields (steps 1-9 of the form) are editable by anyone in
// the company with a session, matching the existing app's behavior of any staff filling in an
// application.
const JOB_APP_APPLICANT_FIELDS = {
  employeeCode: 'employee_code', titlePrefix: 'title_prefix', fullName: 'full_name',
  positionWanted1: 'position_wanted1', positionWanted2: 'position_wanted2', expectedSalary: 'expected_salary',
  photoDataUrl: 'photo_data_url',
  addrNo: 'addr_no', addrMoo: 'addr_moo', addrRoad: 'addr_road', addrTambon: 'addr_tambon',
  addrAmphoe: 'addr_amphoe', addrProvince: 'addr_province', addrZipcode: 'addr_zipcode',
  phone: 'phone', mobile: 'mobile', email: 'email',
  livingType: 'living_type', birthDate: 'birth_date', age: 'age', ethnicity: 'ethnicity',
  nationality: 'nationality', religion: 'religion',
  idCardNumber: 'id_card_number', idCardExpiry: 'id_card_expiry', heightCm: 'height_cm', weightKg: 'weight_kg',
  militaryStatus: 'military_status', maritalStatus: 'marital_status', gender: 'gender',
  fatherName: 'father_name', fatherAge: 'father_age', fatherOccupation: 'father_occupation',
  motherName: 'mother_name', motherAge: 'mother_age', motherOccupation: 'mother_occupation',
  spouseName: 'spouse_name', spouseWorkplace: 'spouse_workplace', spousePosition: 'spouse_position',
  childrenCount: 'children_count', siblingsTotal: 'siblings_total', siblingsMale: 'siblings_male',
  siblingsFemale: 'siblings_female', birthOrder: 'birth_order',
  siblings: 'siblings', education: 'education', experience: 'experience', languages: 'languages',
  otherLanguageName: 'other_language_name',
  typingAble: 'typing_able', typingSpeedThai: 'typing_speed_thai', typingSpeedEnglish: 'typing_speed_english',
  computerAble: 'computer_able', computerPrograms: 'computer_programs',
  drivingAble: 'driving_able', drivingLicenseNumber: 'driving_license_number',
  officeEquipmentAbility: 'office_equipment_ability', hobby: 'hobby', sports: 'sports',
  specialKnowledge: 'special_knowledge', otherAbility: 'other_ability',
  upcountryAble: 'upcountry_able', upcountryNote: 'upcountry_note',
  emergencyName: 'emergency_name', emergencyRelation: 'emergency_relation',
  emergencyAddress: 'emergency_address', emergencyPhone: 'emergency_phone',
  referralSource: 'referral_source',
  hadIllness: 'had_illness', illnessDetail: 'illness_detail',
  appliedBefore: 'applied_before', appliedBeforeWhen: 'applied_before_when',
  relativesInCompany: 'relatives_in_company',
  ref1Name: 'ref1_name', ref1Address: 'ref1_address', ref1Phone: 'ref1_phone', ref1Occupation: 'ref1_occupation',
  ref2Name: 'ref2_name', ref2Address: 'ref2_address', ref2Phone: 'ref2_phone', ref2Occupation: 'ref2_occupation',
  selfIntroduction: 'self_introduction',
  certifyChecked: 'certify_checked', signatureName: 'signature_name', signatureDate: 'signature_date',
  submittedAt: 'submitted_at',
};
const JOB_APP_HR_FIELDS = {
  hrPosition: 'hr_position', hrDepartment: 'hr_department', employmentType: 'employment_type',
  hrSalary: 'hr_salary', hrStartDate: 'hr_start_date', hrSpecialExpenses: 'hr_special_expenses',
  hrSignedBy: 'hr_signed_by', hrSignedDate: 'hr_signed_date',
  approverSignedBy: 'approver_signed_by', approverSignedDate: 'approver_signed_date',
};
const JOB_APP_JSON_FIELDS = new Set(['siblings', 'education', 'experience', 'languages']);
const JOB_APP_ALL_FIELDS = { ...JOB_APP_APPLICANT_FIELDS, ...JOB_APP_HR_FIELDS };

function serializeJobApplication(row) {
  const out = {
    id: row.id, status: row.status,
    approvedBy: row.approved_by, approvedAt: row.approved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  for (const [camel, col] of Object.entries(JOB_APP_ALL_FIELDS)) out[camel] = row[col];
  return out;
}

function canApproveApplications(customer) {
  return customer.can_approve_applications === true;
}
// Backend gate for the HR-only section — the frontend hides/read-onlys this UI for everyone
// else, but that's cosmetic only; every route that can touch hr_* fields or the status decision
// re-checks this and 403s regardless of what the client sent or hid.
function requireCanApproveApplications(req, res, next) {
  if (!canApproveApplications(req.customer)) {
    return res.status(403).json({ error: 'เฉพาะฝ่าย HR หรือผู้ที่ได้รับสิทธิ์เท่านั้นที่พิจารณาใบสมัครงานได้' });
  }
  next();
}

// Same permission-flag gate pattern as can_approve_applications, for the Bidding/Budget module's
// Approve Budget step (see client_budgets/client_budget_revisions in schema.sql).
function canApproveBudget(customer) {
  return customer.can_approve_budget === true;
}
function requireCanApproveBudget(req, res, next) {
  if (!canApproveBudget(req.customer)) {
    return res.status(403).json({ error: 'เฉพาะผู้ที่ได้รับสิทธิ์อนุมัติงบประมาณเท่านั้นที่ทำรายการนี้ได้' });
  }
  next();
}

// Lazily built once — createTransport itself doesn't touch the network, so this is cheap to defer
// until the first notification actually needs sending, and it lets the server boot fine even when
// GMAIL_USER/GMAIL_APP_PASSWORD aren't set (email just gets skipped, in-app notifications still work).
let mailTransporter;
function getMailTransporter() {
  if (mailTransporter !== undefined) return mailTransporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('[mail] GMAIL_USER/GMAIL_APP_PASSWORD not set — new-application emails will be skipped.');
    mailTransporter = null;
  } else {
    mailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return mailTransporter;
}

// Applicant-controlled fields (full_name, position_wanted1) end up interpolated straight into
// this HTML email — escape them so a malicious application submission can't inject markup into
// an HR inbox.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function sendNewApplicationEmail(hrRecipients, application, companyName) {
  const transporter = getMailTransporter();
  const to = hrRecipients.map(r => r.email).filter(Boolean);
  if (!transporter || to.length === 0) return;
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/job-applications/${application.id}`;
  const logoUrl = `${baseUrl}/logo-white.svg`;
  const appliedDate = application.created_at
    ? new Date(application.created_at).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';
  const applicantName = application.full_name || '-';
  const positionWanted = application.position_wanted1 || '-';
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: to.join(','),
    subject: `🔔 มีผู้สมัครงานใหม่: ${positionWanted} - ${applicantName}`,
    html: `
    <div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif; max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
      <div style="background:#1a2744; padding:24px 28px; text-align:center;">
        <img src="${logoUrl}" alt="Build-Con" style="height:32px;">
      </div>
      <div style="padding:28px;">
        <h2 style="margin:0 0 18px; font-size:19px; color:#1a2744;">มีผู้สมัครงานใหม่เข้ามาแล้ว</h2>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#333333;">
          <tr><td style="padding:8px 0; color:#68738C; width:150px;">ชื่อผู้สมัคร</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(applicantName)}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ตำแหน่งที่สมัคร</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(positionWanted)}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ชื่อบริษัท</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(companyName || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">วันที่สมัคร</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(appliedDate)}</td></tr>
        </table>
        <div style="text-align:center; margin:28px 0 8px;">
          <a href="${link}" style="display:inline-block; background:#D85A30; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 28px; border-radius:6px;">ดูใบสมัครงานฉบับเต็ม</a>
        </div>
      </div>
      <div style="padding:16px 28px; background:#F7F8FA; border-top:1px solid #e5e7eb; text-align:center;">
        <div style="font-size:11.5px; color:#9AA3B2;">อีเมลนี้ถูกส่งอัตโนมัติจากระบบ SiteReq กรุณาอย่าตอบกลับอีเมลฉบับนี้</div>
      </div>
    </div>
    `,
  });
}

async function getCompanyContact(companyId) {
  const r = await pool.query('SELECT name, phone, email FROM customer_companies WHERE id = $1', [companyId]);
  return r.rows[0] || { name: '', phone: '', email: '' };
}
// Applications only ever get one interview in the current flow (schedule → record result), but
// this always takes the newest row rather than assuming exactly one exists, so a hypothetical
// re-interview doesn't silently operate on a stale record.
async function getLatestInterview(applicationId) {
  const r = await pool.query(
    'SELECT * FROM job_interviews WHERE application_id = $1 ORDER BY id DESC LIMIT 1',
    [applicationId]
  );
  return r.rows[0] || null;
}
function serializeInterview(row) {
  if (!row) return null;
  return {
    id: row.id, scheduledAt: row.scheduled_at, mode: row.mode, location: row.location,
    interviewerName: row.interviewer_name, result: row.result, score: row.score, comment: row.comment,
  };
}
const INTERVIEW_MODE_LABELS_TH = { onsite: 'ออนไซต์ (เข้าพบที่บริษัท)', online: 'ออนไลน์', phone: 'ทางโทรศัพท์' };

// ---------------- Interview panel voting (คณะกรรมการสัมภาษณ์แบบโหวตเสียงข้างมาก) ----------------
async function getInterviewPanel(interviewId) {
  if (!interviewId) return [];
  const r = await pool.query(
    `SELECT ipv.*, c.name AS interviewer_name
     FROM interview_panel_votes ipv
     JOIN customers c ON c.id = ipv.interviewer_id
     WHERE ipv.interview_id = $1
     ORDER BY ipv.is_hr_tiebreaker ASC, ipv.id ASC`,
    [interviewId]
  );
  return r.rows.map(row => ({
    id: row.id, interviewerId: row.interviewer_id, name: row.interviewer_name,
    vote: row.vote, isHrTiebreaker: row.is_hr_tiebreaker, votedAt: row.voted_at,
  }));
}
// Pure tally over an already-fetched panel — no DB access, so the exact same function backs the
// vote route's decision logic and the read-only status routes/list query without duplicating the
// majority/tie rules in two places.
function tallyPanel(panel) {
  const main = panel.filter(p => !p.isHrTiebreaker);
  const hr = panel.find(p => p.isHrTiebreaker) || null;
  const passCount = main.filter(p => p.vote === 'pass').length;
  const failCount = main.filter(p => p.vote === 'fail').length;
  const votedMain = main.filter(p => p.vote !== 'pending').length;
  const totalMain = main.length;
  const allVoted = totalMain > 0 && votedMain === totalMain;
  const isTie = allVoted && passCount === failCount;
  let decisionResult = null;
  if (allVoted) {
    if (passCount > failCount) decisionResult = 'passed';
    else if (failCount > passCount) decisionResult = 'failed';
    else if (hr && hr.vote === 'pass') decisionResult = 'passed';
    else if (hr && hr.vote === 'fail') decisionResult = 'failed';
    // else: tied and HR hasn't voted yet — decisionResult stays null (waiting on HR tiebreak).
  }
  return { main, hr, passCount, failCount, votedMain, totalMain, allVoted, isTie, decisionResult };
}
function serializeTally(tally) {
  return {
    totalMain: tally.totalMain, votedMain: tally.votedMain,
    passCount: tally.passCount, failCount: tally.failCount,
    isTie: tally.isTie, decided: !!tally.decisionResult,
  };
}
// Applies a tally's decision to job_interviews/job_applications exactly once (guarded by
// interview.result still being 'pending' — a decided interview is immutable, same invariant the
// old manual PUT .../interviews/result route used to enforce by requiring status='interview_scheduled').
// Shared by the vote route (the normal path) — kept separate from tallyPanel so the pure tally
// logic stays testable without a live DB/email transport.
async function applyPanelDecisionIfReady(interview, application, companyId, tally) {
  if (!tally.decisionResult || interview.result !== 'pending') {
    return { interview, application };
  }
  const interviewRes = await pool.query(
    `UPDATE job_interviews SET result=$1 WHERE id=$2 RETURNING *`,
    [tally.decisionResult, interview.id]
  );
  const appRes = await pool.query(
    `UPDATE job_applications SET status='interviewed', updated_at=now() WHERE id=$1 RETURNING *`,
    [application.id]
  );
  const updatedApplication = appRes.rows[0];
  if (tally.decisionResult === 'failed') {
    try {
      const company = await getCompanyContact(companyId);
      await sendInterviewFailedEmail(updatedApplication, company);
    } catch (err) {
      console.error('[mail] Failed to send interview-failed email:', err);
    }
  }
  return { interview: interviewRes.rows[0], application: updatedApplication };
}

// The three applicant-facing emails below share the same plain informational layout — no CTA
// button like sendNewApplicationEmail's, since applicants don't have a login/dashboard to link to.
function applicantEmailShell(company, bodyHtml) {
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  return `
  <div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif; max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
    <div style="background:#1a2744; padding:24px 28px; text-align:center;">
      <img src="${baseUrl}/logo-white.svg" alt="${escapeHtml(company.name || 'Build-Con')}" style="height:32px;">
    </div>
    <div style="padding:28px;">${bodyHtml}</div>
    <div style="padding:16px 28px; background:#F7F8FA; border-top:1px solid #e5e7eb; text-align:center;">
      <div style="font-size:11.5px; color:#9AA3B2;">อีเมลนี้ถูกส่งอัตโนมัติจากระบบ SiteReq กรุณาอย่าตอบกลับอีเมลฉบับนี้</div>
    </div>
  </div>`;
}
// panelMainSize: count of "main" (non-HR) committee members — shown to the applicant as a plain
// number (e.g. "คณะกรรมการ 3 ท่าน"), never the panelists' names. Those are internal staff assigned
// to this interview and have no reason to be disclosed to an external applicant.
async function sendInterviewScheduledEmail(application, interview, company, panelMainSize) {
  const transporter = getMailTransporter();
  if (!transporter || !application.email) return;
  const positionWanted = application.position_wanted1 || '-';
  const applicantName = `${application.title_prefix || ''}${application.full_name || ''}`.trim() || '-';
  const scheduledStr = new Date(interview.scheduled_at).toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' });
  const contactLine = [company.phone, company.email].filter(Boolean).join(' หรือ ') || '-';
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: application.email,
    subject: `นัดสัมภาษณ์งานตำแหน่ง ${positionWanted} - ${company.name || ''}`,
    html: applicantEmailShell(company, `
      <h2 style="margin:0 0 18px; font-size:19px; color:#1a2744;">นัดสัมภาษณ์งาน</h2>
      <p style="font-size:14px; color:#333;">เรียนคุณ${escapeHtml(applicantName)}</p>
      <p style="font-size:14px; color:#333;">ทาง ${escapeHtml(company.name || '-')} ขอนัดหมายสัมภาษณ์งานตำแหน่ง <b>${escapeHtml(positionWanted)}</b> ตามรายละเอียดดังนี้</p>
      <table style="width:100%; border-collapse:collapse; font-size:14px; color:#333333; margin-top:10px;">
        <tr><td style="padding:8px 0; color:#68738C; width:150px;">วันที่และเวลา</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(scheduledStr)}</td></tr>
        <tr><td style="padding:8px 0; color:#68738C;">รูปแบบ</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(INTERVIEW_MODE_LABELS_TH[interview.mode] || interview.mode)}</td></tr>
        <tr><td style="padding:8px 0; color:#68738C;">สถานที่ / ลิงก์</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(interview.location || '-')}</td></tr>
        <tr><td style="padding:8px 0; color:#68738C;">คณะกรรมการสัมภาษณ์</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(String(panelMainSize || 1))} ท่าน</td></tr>
      </table>
      <p style="font-size:13px; color:#68738C; margin-top:18px;">หากต้องการเลื่อนนัดหมาย กรุณาติดต่อกลับที่ ${escapeHtml(contactLine)}</p>
    `),
  });
}
async function sendInterviewFailedEmail(application, company) {
  const transporter = getMailTransporter();
  if (!transporter || !application.email) return;
  const applicantName = `${application.title_prefix || ''}${application.full_name || ''}`.trim() || '-';
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: application.email,
    subject: `ผลการสัมภาษณ์งานตำแหน่ง ${application.position_wanted1 || '-'} - ${company.name || ''}`,
    html: applicantEmailShell(company, `
      <h2 style="margin:0 0 18px; font-size:19px; color:#1a2744;">ผลการพิจารณาสัมภาษณ์งาน</h2>
      <p style="font-size:14px; color:#333; line-height:1.7;">เรียนคุณ${escapeHtml(applicantName)}</p>
      <p style="font-size:14px; color:#333; line-height:1.7;">
        ขอขอบคุณที่ให้ความสนใจและสละเวลาเข้าร่วมสัมภาษณ์งานกับ ${escapeHtml(company.name || '-')}
        ทางบริษัทฯ ขอแจ้งว่าท่านไม่ผ่านการคัดเลือกในตำแหน่งนี้ ทางบริษัทฯ ขอเก็บประวัติของท่านไว้พิจารณาสำหรับตำแหน่งงานที่เหมาะสมในโอกาสต่อไป
      </p>
      <p style="font-size:14px; color:#333; line-height:1.7;">ขอบคุณอีกครั้งที่สนใจร่วมงานกับเรา</p>
    `),
  });
}
async function sendHiredEmail(application, company) {
  const transporter = getMailTransporter();
  if (!transporter || !application.email) return;
  const applicantName = `${application.title_prefix || ''}${application.full_name || ''}`.trim() || '-';
  const startDateStr = application.hr_start_date
    ? new Date(application.hr_start_date).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: application.email,
    subject: `ยินดีต้อนรับ! ผลการคัดเลือกตำแหน่ง ${application.hr_position || application.position_wanted1 || '-'} - ${company.name || ''}`,
    html: applicantEmailShell(company, `
      <h2 style="margin:0 0 18px; font-size:19px; color:#1a2744;">ยินดีด้วย! คุณผ่านการคัดเลือก</h2>
      <p style="font-size:14px; color:#333; line-height:1.7;">เรียนคุณ${escapeHtml(applicantName)}</p>
      <p style="font-size:14px; color:#333; line-height:1.7;">${escapeHtml(company.name || '-')} ยินดีต้อนรับท่านเข้าร่วมงานในตำแหน่ง <b>${escapeHtml(application.hr_position || application.position_wanted1 || '-')}</b></p>
      <table style="width:100%; border-collapse:collapse; font-size:14px; color:#333333; margin-top:10px;">
        <tr><td style="padding:8px 0; color:#68738C; width:150px;">วันที่เริ่มงาน</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(startDateStr)}</td></tr>
      </table>
      <p style="font-size:13px; color:#68738C; margin-top:18px;">ฝ่ายทรัพยากรบุคคลจะติดต่อท่านเพื่อแจ้งรายละเอียดเพิ่มเติมต่อไป</p>
    `),
  });
}

// Fan-out on first save of a new application (see POST /api/customer/job-applications below) —
// only to can_approve_applications=true accounts in the SAME company_id as the application, never
// cross-company. In-app notification rows always get written; email is best-effort and never
// allowed to fail the request that created the application.
async function notifyNewJobApplication(companyId, application) {
  const hrRes = await pool.query(
    'SELECT id, name, email FROM customers WHERE company_id = $1 AND can_approve_applications = true',
    [companyId]
  );
  if (hrRes.rowCount === 0) return;
  const title = 'ใบสมัครงานใหม่';
  const message = `มีผู้สมัครงานใหม่: ${application.full_name || '-'} สมัครตำแหน่ง ${application.position_wanted1 || '-'}`;
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const hr of hrRes.rows) {
    placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4})`);
    values.push(hr.id, 'new_job_application', title, message, application.id);
    i += 5;
  }
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES ${placeholders.join(',')}`,
    values
  );
  try {
    const companyRes = await pool.query('SELECT name FROM customer_companies WHERE id = $1', [companyId]);
    await sendNewApplicationEmail(hrRes.rows, application, companyRes.rows[0] && companyRes.rows[0].name);
  } catch (err) {
    console.error('[mail] Failed to send new-application email:', err);
  }
}

async function sendNewLeaveRequestEmail(hrRecipients, leaveRequest, companyName) {
  const transporter = getMailTransporter();
  const to = hrRecipients.map(r => r.email).filter(Boolean);
  if (!transporter || to.length === 0) return;
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/pr-system.html`;
  const logoUrl = `${baseUrl}/logo-white.svg`;
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: to.join(','),
    subject: `🔔 มีคำขอลาใหม่: ${leaveRequest.employeeName || '-'}`,
    html: `
    <div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif; max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
      <div style="background:#1a2744; padding:24px 28px; text-align:center;">
        <img src="${logoUrl}" alt="Build-Con" style="height:32px;">
      </div>
      <div style="padding:28px;">
        <h2 style="margin:0 0 18px; font-size:19px; color:#1a2744;">มีคำขอลาใหม่เข้ามาแล้ว</h2>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#333333;">
          <tr><td style="padding:8px 0; color:#68738C; width:150px;">ชื่อพนักงาน</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(leaveRequest.employeeName || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ประเภทวันลา</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(leaveRequest.leaveTypeName || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ช่วงวันที่</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(leaveRequest.startDate || '-')} – ${escapeHtml(leaveRequest.endDate || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">จำนวนวัน</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(String(leaveRequest.daysCount ?? '-'))}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ชื่อบริษัท</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(companyName || '-')}</td></tr>
        </table>
        <div style="text-align:center; margin:28px 0 8px;">
          <a href="${link}" style="display:inline-block; background:#D85A30; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 28px; border-radius:6px;">เข้าสู่ระบบเพื่อพิจารณา</a>
        </div>
      </div>
      <div style="padding:16px 28px; background:#F7F8FA; border-top:1px solid #e5e7eb; text-align:center;">
        <div style="font-size:11.5px; color:#9AA3B2;">อีเมลนี้ถูกส่งอัตโนมัติจากระบบ SiteReq กรุณาอย่าตอบกลับอีเมลฉบับนี้</div>
      </div>
    </div>`,
  });
}
// Fan-out for a leave request submitted through the public self-service flow (POST
// /api/public/leave-requests) — same shape as notifyNewJobApplication: in-app notification rows
// always get written, email is best-effort. type='new_leave_request' so the notification bell's
// click handler routes to the leave-requests list instead of trying to open a job application
// (see act==='open-notification' in pr-system.html).
async function notifyNewLeaveRequest(companyId, leaveRequest, companyName) {
  const hrRes = await pool.query(
    'SELECT id, name, email FROM customers WHERE company_id = $1 AND can_approve_applications = true',
    [companyId]
  );
  if (hrRes.rowCount === 0) return;
  const title = 'คำขอลาใหม่';
  const message = `${leaveRequest.employeeName || '-'} ขอลา${leaveRequest.leaveTypeName || ''} (${leaveRequest.startDate} - ${leaveRequest.endDate})`;
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const hr of hrRes.rows) {
    placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4})`);
    values.push(hr.id, 'new_leave_request', title, message, leaveRequest.id);
    i += 5;
  }
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES ${placeholders.join(',')}`,
    values
  );
  try {
    await sendNewLeaveRequestEmail(hrRes.rows, leaveRequest, companyName);
  } catch (err) {
    console.error('[mail] Failed to send new-leave-request email:', err);
  }
}

// kind: 'soon' (30-days-out reminder) or 'expired' (still unrenewed on/after the expiry date) —
// see runForeignWorkerDocumentExpiryCheck (the daily cron below) for when each fires.
async function sendDocumentExpiryEmail(hrRecipients, doc, companyName, kind) {
  const transporter = getMailTransporter();
  const to = hrRecipients.map(r => r.email).filter(Boolean);
  if (!transporter || to.length === 0) return;
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/pr-system.html`;
  const logoUrl = `${baseUrl}/logo-white.svg`;
  const docTypeLabel = FOREIGN_WORKER_DOC_TYPE_LABELS_TH[doc.documentType] || doc.documentType;
  const heading = kind === 'expired' ? 'เอกสารแรงงานต่างด้าวหมดอายุแล้ว' : 'เอกสารแรงงานต่างด้าวใกล้หมดอายุ';
  const subject = kind === 'expired'
    ? `⚠️ เอกสารหมดอายุแล้ว: ${doc.employeeName} — ${docTypeLabel}`
    : `🔔 เอกสารใกล้หมดอายุใน 30 วัน: ${doc.employeeName} — ${docTypeLabel}`;
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: to.join(','),
    subject,
    html: `
    <div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif; max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
      <div style="background:#1a2744; padding:24px 28px; text-align:center;">
        <img src="${logoUrl}" alt="Build-Con" style="height:32px;">
      </div>
      <div style="padding:28px;">
        <h2 style="margin:0 0 18px; font-size:19px; color:${kind === 'expired' ? '#B23B2E' : '#A8730E'};">${heading}</h2>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#333333;">
          <tr><td style="padding:8px 0; color:#68738C; width:150px;">ชื่อพนักงาน</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(doc.employeeName || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ประเภทเอกสาร</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(docTypeLabel)}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">เลขที่เอกสาร</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(doc.documentNumber || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">วันหมดอายุ</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(doc.expiryDate || '-')}</td></tr>
          <tr><td style="padding:8px 0; color:#68738C;">ชื่อบริษัท</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(companyName || '-')}</td></tr>
        </table>
        <div style="text-align:center; margin:28px 0 8px;">
          <a href="${link}" style="display:inline-block; background:#D85A30; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 28px; border-radius:6px;">เข้าสู่ระบบเพื่อต่ออายุเอกสาร</a>
        </div>
      </div>
      <div style="padding:16px 28px; background:#F7F8FA; border-top:1px solid #e5e7eb; text-align:center;">
        <div style="font-size:11.5px; color:#9AA3B2;">อีเมลนี้ถูกส่งอัตโนมัติจากระบบ SiteReq กรุณาอย่าตอบกลับอีเมลฉบับนี้</div>
      </div>
    </div>`,
  });
}
// Fan-out to every can_approve_applications HR account in the document's company — same shape as
// notifyNewJobApplication/notifyNewLeaveRequest above (in-app notification always written, email
// best-effort). doc must already carry employeeName/documentType/documentNumber/expiryDate (see
// FWD_SELECT-shaped rows in runForeignWorkerDocumentExpiryCheck).
async function notifyDocumentExpiry(companyId, doc, companyName, kind) {
  const hrRes = await pool.query(
    'SELECT id, name, email FROM customers WHERE company_id = $1 AND can_approve_applications = true',
    [companyId]
  );
  if (hrRes.rowCount === 0) return;
  const docTypeLabel = FOREIGN_WORKER_DOC_TYPE_LABELS_TH[doc.documentType] || doc.documentType;
  const title = kind === 'expired' ? 'เอกสารแรงงานต่างด้าวหมดอายุแล้ว' : 'เอกสารแรงงานต่างด้าวใกล้หมดอายุ';
  const message = kind === 'expired'
    ? `${doc.employeeName}: ${docTypeLabel} หมดอายุแล้วเมื่อ ${doc.expiryDate} กรุณาต่ออายุโดยเร็ว`
    : `${doc.employeeName}: ${docTypeLabel} จะหมดอายุวันที่ ${doc.expiryDate} (ภายใน 30 วัน)`;
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const hr of hrRes.rows) {
    placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3},$${i + 4})`);
    values.push(hr.id, 'foreign_worker_doc_expiry', title, message, doc.id);
    i += 5;
  }
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES ${placeholders.join(',')}`,
    values
  );
  try {
    await sendDocumentExpiryEmail(hrRes.rows, doc, companyName, kind);
  } catch (err) {
    console.error('[mail] Failed to send document-expiry email:', err);
  }
}
// Daily check (see cron.schedule call near the bottom of this file): fires the 30-days-out
// reminder once per document, then — if it's still not renewed — fires a second reminder and
// flips status to 'expired' once the expiry date itself has passed. Both notified_* guards ensure
// each of the two reminders only ever goes out once per expiry cycle (editing expiry_date resets
// them — see the PUT route above — so a renewed document gets its own fresh cycle).
async function runForeignWorkerDocumentExpiryCheck() {
  const soon = await pool.query(
    `SELECT fwd.*, e.full_name AS employee_name, e.employee_code AS employee_code, e.nationality AS nationality,
            e.company_id AS company_id, cc.name AS company_name
     FROM foreign_worker_documents fwd
     JOIN employees e ON e.id = fwd.employee_id
     JOIN customer_companies cc ON cc.id = e.company_id
     WHERE fwd.expiry_date >= CURRENT_DATE AND fwd.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
       AND fwd.notified_30d_at IS NULL`
  );
  for (const row of soon.rows) {
    const doc = serializeForeignWorkerDocument(row);
    try {
      await notifyDocumentExpiry(row.company_id, doc, row.company_name, 'soon');
      await pool.query('UPDATE foreign_worker_documents SET notified_30d_at = now() WHERE id=$1', [doc.id]);
    } catch (err) {
      console.error('[cron] Failed to send 30-day expiry notice for foreign_worker_documents.id=' + doc.id, err);
    }
  }
  const expired = await pool.query(
    `SELECT fwd.*, e.full_name AS employee_name, e.employee_code AS employee_code, e.nationality AS nationality,
            e.company_id AS company_id, cc.name AS company_name
     FROM foreign_worker_documents fwd
     JOIN employees e ON e.id = fwd.employee_id
     JOIN customer_companies cc ON cc.id = e.company_id
     WHERE fwd.expiry_date < CURRENT_DATE AND fwd.notified_expired_at IS NULL`
  );
  for (const row of expired.rows) {
    const doc = serializeForeignWorkerDocument(row);
    try {
      await notifyDocumentExpiry(row.company_id, doc, row.company_name, 'expired');
      await pool.query(`UPDATE foreign_worker_documents SET notified_expired_at = now(), status='expired' WHERE id=$1`, [doc.id]);
    } catch (err) {
      console.error('[cron] Failed to send expired notice for foreign_worker_documents.id=' + doc.id, err);
    }
  }
  return { soonCount: soon.rowCount, expiredCount: expired.rowCount };
}

app.get('/api/customer/notifications', requireCustomerAuth, async (req, res) => {
  const [listRes, countRes] = await Promise.all([
    pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [req.customer.id]),
    pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = false', [req.customer.id]),
  ]);
  res.json({
    notifications: listRes.rows.map(n => ({
      id: n.id, type: n.type, title: n.title, message: n.message,
      relatedId: n.related_id, isRead: n.is_read, createdAt: n.created_at,
    })),
    unreadCount: countRes.rows[0].n,
  });
});

app.post('/api/customer/notifications/:id/mark-read', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, req.customer.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบการแจ้งเตือน' });
  res.json({ ok: true });
});

// "รายได้อื่นๆ"/"รายการหัก" line items — not included on the list route (avoids an N+1 query
// there; the list view never shows them), only on the single-application GET/PUT responses where
// the edit form actually needs them.
async function getJobApplicationPayItems(applicationId) {
  const r = await pool.query(
    'SELECT id, type, name, amount FROM job_application_pay_items WHERE application_id = $1 ORDER BY id',
    [applicationId]
  );
  return {
    allowances: r.rows.filter(x => x.type === 'allowance').map(x => ({ id: x.id, name: x.name, amount: x.amount })),
    deductions: r.rows.filter(x => x.type === 'deduction').map(x => ({ id: x.id, name: x.name, amount: x.amount })),
  };
}
async function withPayItems(row) {
  const [items, interview] = await Promise.all([
    getJobApplicationPayItems(row.id),
    getLatestInterview(row.id),
  ]);
  const panel = interview ? await getInterviewPanel(interview.id) : [];
  return { ...serializeJobApplication(row), ...items, interview: serializeInterview(interview), panel };
}
// Whole-row replace (delete + reinsert) — simplest correct way to reconcile an arbitrary add/edit/
// remove diff from the client without tracking per-row ids on the frontend.
async function replaceJobApplicationPayItems(applicationId, allowances, deductions) {
  await pool.query('DELETE FROM job_application_pay_items WHERE application_id = $1', [applicationId]);
  const rows = [
    ...(Array.isArray(allowances) ? allowances : []).map(r => ({ type: 'allowance', name: r.name || '', amount: Number(r.amount) || 0 })),
    ...(Array.isArray(deductions) ? deductions : []).map(r => ({ type: 'deduction', name: r.name || '', amount: Number(r.amount) || 0 })),
  ];
  if (rows.length === 0) return;
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const row of rows) {
    placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3})`);
    values.push(applicationId, row.type, row.name, row.amount);
    i += 4;
  }
  await pool.query(
    `INSERT INTO job_application_pay_items (application_id, type, name, amount) VALUES ${placeholders.join(',')}`,
    values
  );
}

app.get('/api/customer/job-applications', requireCustomerAuth, async (req, res) => {
  // Only the latest interview's result + main-panel vote counts are pulled in here (not the full
  // panel via withPayItems) — the list only needs enough to show "ไปที่การพิจารณาว่าจ้าง" and the
  // "รอผลโหวต (2/3 คนโหวตแล้ว)" progress line; the full per-panelist breakdown is fetched
  // separately once an application is actually opened (see GET .../interview-panel).
  const r = await pool.query(
    `SELECT ja.*, ji.result AS interview_result,
       COALESCE(pv.total_main, 0) AS panel_total_main,
       COALESCE(pv.voted_main, 0) AS panel_voted_main
     FROM job_applications ja
     LEFT JOIN LATERAL (
       SELECT id, result FROM job_interviews WHERE application_id = ja.id ORDER BY id DESC LIMIT 1
     ) ji ON true
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE is_hr_tiebreaker = false) AS total_main,
         COUNT(*) FILTER (WHERE is_hr_tiebreaker = false AND vote <> 'pending') AS voted_main
       FROM interview_panel_votes WHERE interview_id = ji.id
     ) pv ON true
     WHERE ja.company_id=$1 ORDER BY ja.id DESC`,
    [req.customer.company_id]
  );
  // Shaped as { interview: { result, panelTotalMain, panelVotedMain } } to match the richer
  // { interview: {...} } single-application responses (see withPayItems) — so caching a post-save
  // response over a list row (in DB.jobApplications on the frontend) doesn't flip which field the
  // "ผลสัมภาษณ์ผ่าน" button check or the vote-progress line reads from.
  res.json({
    applications: r.rows.map(row => ({
      ...serializeJobApplication(row),
      interview: row.interview_result ? {
        result: row.interview_result,
        panelTotalMain: Number(row.panel_total_main) || 0,
        panelVotedMain: Number(row.panel_voted_main) || 0,
      } : null,
    })),
  });
});

app.get('/api/customer/job-applications/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT * FROM job_applications WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  res.json({ application: await withPayItems(r.rows[0]) });
});

app.post('/api/customer/job-applications', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const body = req.body || {};
  const cols = ['company_id'];
  const placeholders = ['$1'];
  const values = [companyId];
  let i = 2;
  for (const [camel, col] of Object.entries(JOB_APP_APPLICANT_FIELDS)) {
    if (!(camel in body)) continue;
    cols.push(col);
    placeholders.push(`$${i}`);
    values.push(JOB_APP_JSON_FIELDS.has(camel) ? JSON.stringify(body[camel] ?? (camel === 'siblings' || camel === 'experience' ? [] : {})) : body[camel]);
    i++;
  }
  const r = await pool.query(
    `INSERT INTO job_applications (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
    values
  );
  await notifyNewJobApplication(companyId, r.rows[0]);
  res.json({ application: serializeJobApplication(r.rows[0]) });
});

app.put('/api/customer/job-applications/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT * FROM job_applications WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  const body = req.body || {};
  // HR fields silently dropped for anyone without permission — even if the client sent them
  // (e.g. a tampered request bypassing the hidden/read-only UI), they never reach the database.
  const allowedFields = canApproveApplications(req.customer) ? JOB_APP_ALL_FIELDS : JOB_APP_APPLICANT_FIELDS;
  const sets = [];
  const values = [];
  let i = 1;
  for (const [camel, col] of Object.entries(allowedFields)) {
    if (!(camel in body)) continue;
    sets.push(`${col} = $${i}`);
    // employment_type's CHECK constraint allows NULL (not decided yet) or one of 5 enum values —
    // '' from an unselected <select> is neither, so it fails the constraint. An empty selection
    // means "not decided", i.e. NULL, not the literal string ''.
    const value = (camel === 'employmentType' && body[camel] === '') ? null
      : JOB_APP_JSON_FIELDS.has(camel) ? JSON.stringify(body[camel]) : body[camel];
    values.push(value);
    i++;
  }
  // Allowances/deductions are a child table, not a job_applications column, so they're handled
  // separately from the whitelist loop above — same HR-only gate (canApproveApplications), since
  // they're part of "การพิจารณาว่าจ้าง" just like hr_position/hr_salary/etc.
  if (canApproveApplications(req.customer) && (Array.isArray(body.allowances) || Array.isArray(body.deductions))) {
    await replaceJobApplicationPayItems(id, body.allowances, body.deductions);
  }
  let row = own.rows[0];
  if (sets.length > 0) {
    sets.push('updated_at = now()');
    values.push(id);
    const r = await pool.query(`UPDATE job_applications SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
    row = r.rows[0];
  }
  res.json({ application: await withPayItems(row) });
});

app.delete('/api/customer/job-applications/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM job_applications WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  res.json({ ok: true });
});

// The literal "ปุ่มอนุมัติ" from the spec: hired/rejected only, only by someone with
// can_approve_applications, and always stamps who + when — this is the one place status can
// change (the general PUT above never accepts a status field).
app.post('/api/customer/job-applications/:id/decision', requireCustomerAuth, requireCanApproveApplications, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { decision } = req.body || {};
  if (decision !== 'hired' && decision !== 'rejected') return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  const r = await pool.query(
    `UPDATE job_applications SET status=$1, approved_by=$2, approved_at=now(), updated_at=now()
     WHERE id=$3 AND company_id=$4 RETURNING *`,
    [decision, req.customer.id, id, req.customer.company_id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  if (decision === 'hired') {
    try {
      const company = await getCompanyContact(req.customer.company_id);
      await sendHiredEmail(r.rows[0], company);
    } catch (err) {
      console.error('[mail] Failed to send hired email:', err);
    }
  }
  res.json({ application: await withPayItems(r.rows[0]) });
});

// Step 1 of interview scheduling — only from 'pending' (see requireCanApproveApplications, same
// gate as the decision endpoint above; scheduling an interview is an HR judgment call same as
// hiring/rejecting). Body describes a voting panel instead of a single interviewer name:
// panelistUserIds (the "main" committee, majority-vote members) plus exactly one hrUserId
// (observer/tiebreaker, only counted if the main committee ties). Every id is a customers.id drawn
// from "จัดการผู้ใช้งาน" — every login account can vote by definition, so there's no employee-record
// cross-reference to check — except the HR id specifically, which must belong to someone with
// can_approve_applications, same permission "จัดการสิทธิ์ผู้พิจารณาใบสมัคร" governs.
app.post('/api/customer/job-applications/:id/interviews', requireCustomerAuth, requireCanApproveApplications, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { scheduledAt, mode, location, panelistUserIds, hrUserId } = req.body || {};
  if (!scheduledAt || !mode) return res.status(400).json({ error: 'กรุณากรอกวันที่-เวลา และรูปแบบการสัมภาษณ์' });
  if (!['onsite', 'online', 'phone'].includes(mode)) return res.status(400).json({ error: 'รูปแบบการสัมภาษณ์ไม่ถูกต้อง' });
  const panelIds = Array.isArray(panelistUserIds) ? panelistUserIds.map(x => parseInt(x, 10)).filter(Number.isInteger) : [];
  const hrId = parseInt(hrUserId, 10);
  if (panelIds.length < 1) return res.status(400).json({ error: 'กรุณาเลือกกรรมการหลักอย่างน้อย 1 คน' });
  if (!Number.isInteger(hrId)) return res.status(400).json({ error: 'กรุณาเลือกตัวแทน HR' });
  const allIds = [...panelIds, hrId];
  if (new Set(allIds).size !== allIds.length) return res.status(400).json({ error: 'เลือกกรรมการซ้ำกันไม่ได้' });
  const appRes = await pool.query('SELECT * FROM job_applications WHERE id=$1 AND company_id=$2', [id, companyId]);
  const a = appRes.rows[0];
  if (!a) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  if (a.status !== 'pending') return res.status(400).json({ error: 'นัดสัมภาษณ์ได้เฉพาะใบสมัครที่สถานะ "รอพิจารณา" เท่านั้น' });
  // Every id must be an active login account ("จัดการผู้ใช้งาน") belonging to this company.
  const custRes = await pool.query(
    `SELECT id, can_approve_applications FROM customers WHERE id = ANY($1) AND company_id = $2 AND status = 'active'`,
    [allIds, companyId]
  );
  const byId = new Map(custRes.rows.map(r => [r.id, r]));
  for (const uid of allIds) {
    if (!byId.get(uid)) return res.status(400).json({ error: 'กรรมการทุกคนต้องเป็นผู้ใช้งานที่ยังใช้งานอยู่ในบริษัทนี้' });
  }
  if (!byId.get(hrId).can_approve_applications) {
    return res.status(400).json({ error: 'ตัวแทน HR ต้องเป็นผู้ที่มีสิทธิ์พิจารณาใบสมัครงาน' });
  }
  const interviewRes = await pool.query(
    `INSERT INTO job_interviews (application_id, scheduled_at, mode, location)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, scheduledAt, mode, location || '']
  );
  const interviewId = interviewRes.rows[0].id;
  const voteValues = [];
  const voteRows = [];
  let vi = 1;
  for (const eid of panelIds) {
    voteRows.push(`($${vi},$${vi + 1},false)`); voteValues.push(interviewId, eid); vi += 2;
  }
  voteRows.push(`($${vi},$${vi + 1},true)`); voteValues.push(interviewId, hrId); vi += 2;
  await pool.query(
    `INSERT INTO interview_panel_votes (interview_id, interviewer_id, is_hr_tiebreaker) VALUES ${voteRows.join(',')}`,
    voteValues
  );
  const updated = await pool.query(
    `UPDATE job_applications SET status='interview_scheduled', updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  try {
    const company = await getCompanyContact(companyId);
    await sendInterviewScheduledEmail(updated.rows[0], interviewRes.rows[0], company, panelIds.length);
  } catch (err) {
    console.error('[mail] Failed to send interview-scheduled email:', err);
  }
  res.json({ application: await withPayItems(updated.rows[0]), interview: serializeInterview(interviewRes.rows[0]) });
});

// Read-only panel/vote status for one application's latest interview — backs both the "open the
// vote modal" fetch and a manual refresh. Also tells the requesting user whether THEY are on the
// panel and, if so, whether it's currently their turn to vote (a main panelist can vote any time
// before a decision; the HR tiebreaker only once the main committee has actually tied).
app.get('/api/customer/job-applications/:id/interview-panel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const appRes = await pool.query('SELECT id FROM job_applications WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (appRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  const interview = await getLatestInterview(id);
  if (!interview) return res.json({ interview: null, panel: [], tally: null, myVote: null });
  const panel = await getInterviewPanel(interview.id);
  const tally = tallyPanel(panel);
  const myRow = panel.find(p => p.interviewerId === req.customer.id) || null;
  res.json({
    interview: serializeInterview(interview),
    panel,
    tally: serializeTally(tally),
    myVote: myRow ? {
      isHrTiebreaker: myRow.isHrTiebreaker,
      vote: myRow.vote,
      canVoteNow: myRow.vote === 'pending' && (myRow.isHrTiebreaker ? tally.isTie : true),
    } : null,
  });
});

// Each panelist casts their own vote for the interview tied to :id's latest job_interviews row —
// checked against interview_panel_votes so only someone actually on that panel can vote (requirement:
// "ระบบต้องเช็คว่าคนที่โหวตอยู่ในรายชื่อกรรมการที่ถูกเลือกไว้จริง"), not gated behind
// requireCanApproveApplications since ordinary panelists usually don't have that permission — being
// listed as a panelist on THIS interview is the authorization. Recomputes the majority tally after
// every vote and, once decided (straight majority, or the HR tiebreak once tied), applies it via
// applyPanelDecisionIfReady exactly like the old manual result route used to.
app.post('/api/customer/job-applications/:id/interview-panel/vote', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { vote } = req.body || {};
  if (vote !== 'pass' && vote !== 'fail') return res.status(400).json({ error: 'กรุณาเลือกผล (ผ่าน/ไม่ผ่าน)' });
  const appRes = await pool.query('SELECT * FROM job_applications WHERE id=$1 AND company_id=$2', [id, companyId]);
  const a = appRes.rows[0];
  if (!a) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  if (a.status !== 'interview_scheduled') return res.status(400).json({ error: 'โหวตได้เฉพาะใบสมัครที่สถานะ "นัดสัมภาษณ์แล้ว" เท่านั้น' });
  const interview = await getLatestInterview(id);
  if (!interview) return res.status(404).json({ error: 'ไม่พบข้อมูลนัดสัมภาษณ์' });
  const myRowRes = await pool.query(
    'SELECT * FROM interview_panel_votes WHERE interview_id=$1 AND interviewer_id=$2',
    [interview.id, req.customer.id]
  );
  const myRow = myRowRes.rows[0];
  if (!myRow) return res.status(403).json({ error: 'คุณไม่ได้อยู่ในรายชื่อคณะกรรมการสัมภาษณ์นี้' });
  const panelBefore = await getInterviewPanel(interview.id);
  const tallyBefore = tallyPanel(panelBefore);
  if (myRow.is_hr_tiebreaker && !tallyBefore.isTie) {
    return res.status(400).json({ error: 'ยังไม่ถึงกรณีที่กรรมการหลักโหวตเสมอกัน จึงยังไม่ต้องให้ฝ่าย HR ตัดสิน' });
  }
  if (myRow.vote !== 'pending') return res.status(400).json({ error: 'คุณโหวตไปแล้ว' });
  await pool.query('UPDATE interview_panel_votes SET vote=$1, voted_at=now() WHERE id=$2', [vote, myRow.id]);

  const panel = await getInterviewPanel(interview.id);
  const tally = tallyPanel(panel);
  const { interview: updatedInterview, application: updatedApplication } =
    await applyPanelDecisionIfReady(interview, a, companyId, tally);

  res.json({
    application: await withPayItems(updatedApplication),
    interview: serializeInterview(updatedInterview),
    panel,
    tally: serializeTally(tally),
  });
});

app.post('/api/customer/job-applications/:id/convert-to-employee', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const appRes = await pool.query('SELECT * FROM job_applications WHERE id=$1 AND company_id=$2', [id, companyId]);
  const a = appRes.rows[0];
  if (!a) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  const wageRate = Number(String(a.hr_salary || a.expected_salary || '0').replace(/,/g, '')) || 0;
  const fullName = `${a.title_prefix || ''}${a.full_name || ''}`.trim();
  const position = a.hr_position || a.position_wanted1 || '';
  // Employment type was already decided by HR in "การพิจารณาว่าจ้าง" — carry it straight through
  // instead of asking again; 'monthly' is only a fallback for applications decided before this
  // field existed.
  const employmentType = a.employment_type || 'monthly';
  const finalCode = a.employee_code || ('EMP-' + String(Date.now()).slice(-6));
  const exists = await pool.query('SELECT 1 FROM employees WHERE company_id=$1 AND employee_code=$2', [companyId, finalCode]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสพนักงานนี้มีอยู่แล้ว' });
  const r = await pool.query(
    `INSERT INTO employees (company_id, employee_code, full_name, position, employment_type, wage_rate, phone, id_card_number, start_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') RETURNING *`,
    [companyId, finalCode, fullName, position, employmentType, wageRate, a.mobile || a.phone || '', a.id_card_number || '',
     a.hr_start_date || new Date().toISOString().slice(0, 10)]
  );
  // Carry the allowances/deductions HR set during "การพิจารณาว่าจ้าง" over to the new employee
  // record too — kept for a future payroll calculation, not re-entered.
  const payItems = await pool.query(
    'SELECT type, name, amount FROM job_application_pay_items WHERE application_id = $1',
    [id]
  );
  if (payItems.rowCount > 0) {
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const row of payItems.rows) {
      placeholders.push(`($${i},$${i + 1},$${i + 2},$${i + 3})`);
      values.push(r.rows[0].id, row.type, row.name, row.amount);
      i += 4;
    }
    await pool.query(
      `INSERT INTO employee_pay_items (employee_id, type, name, amount) VALUES ${placeholders.join(',')}`,
      values
    );
  }
  await seedLeaveBalanceForEmployee(companyId, r.rows[0].id, new Date().getFullYear());
  res.json({ employee: serializeEmployee(r.rows[0]) });
});

// ---------------- Public: careers page (company search + job application, no login) ----------------
// External applicants, not system users — reuses the same JOB_APP_APPLICANT_FIELDS whitelist as
// the authenticated routes above (still applicant-only fields; hr_* stays unreachable here), but
// every route is public and every write is scoped to an explicitly-validated, active companyId
// from the request itself rather than a session.
app.get('/api/public/companies/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ companies: [] });
  const like = `%${q}%`;
  const r = await pool.query(
    `SELECT id, name, logo_url FROM customer_companies
     WHERE status = 'active' AND (name ILIKE $1 OR code ILIKE $1)
     ORDER BY name LIMIT 10`,
    [like]
  );
  res.json({ companies: r.rows.map(c => ({ id: c.id, name: c.name, logoUrl: c.logo_url })) });
});

app.get('/api/public/companies/:id/job-positions', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyCheck = await pool.query(`SELECT 1 FROM customer_companies WHERE id=$1 AND status='active'`, [id]);
  if (companyCheck.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัท' });
  const r = await pool.query(
    'SELECT id, name, category FROM job_positions WHERE company_id=$1 AND is_active=true ORDER BY id',
    [id]
  );
  res.json({ positions: r.rows.map(p => ({ id: p.id, name: p.name, category: p.category, isActive: true })) });
});

app.post('/api/public/job-applications', async (req, res) => {
  const body = req.body || {};
  const companyId = parseInt(body.companyId, 10);
  if (!companyId) return res.status(400).json({ error: 'ไม่พบบริษัทที่เลือก' });
  const companyRes = await pool.query(`SELECT id, name FROM customer_companies WHERE id=$1 AND status='active'`, [companyId]);
  const company = companyRes.rows[0];
  if (!company) return res.status(404).json({ error: 'ไม่พบบริษัทที่เลือก หรือบริษัทถูกระงับการใช้งาน' });
  if (!body.fullName || !body.positionWanted1) return res.status(400).json({ error: 'กรุณากรอกชื่อ-นามสกุลและตำแหน่งที่ต้องการสมัคร' });
  const cols = ['company_id'];
  const placeholders = ['$1'];
  const values = [companyId];
  let i = 2;
  for (const [camel, col] of Object.entries(JOB_APP_APPLICANT_FIELDS)) {
    if (!(camel in body)) continue;
    cols.push(col);
    placeholders.push(`$${i}`);
    values.push(JOB_APP_JSON_FIELDS.has(camel) ? JSON.stringify(body[camel] ?? (camel === 'siblings' || camel === 'experience' ? [] : {})) : body[camel]);
    i++;
  }
  const r = await pool.query(
    `INSERT INTO job_applications (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
    values
  );
  res.json({ application: serializeJobApplication(r.rows[0]), company: { id: company.id, name: company.name } });
});

// ---------------- Public: self-service leave requests (บันทึกวันลา, no login) ----------------
// Same no-login pattern as the careers routes above, but the guessable input here (a short
// employee code) is much easier to brute-force than a job application, so wrong-code attempts are
// throttled per (IP, company) below — 5 misses in 10 minutes then a temporary block. In-memory and
// per-process is an accepted tradeoff (this is a single-process app; a restart clears counters).
const leaveVerifyFailures = new Map(); // `${ip}:${companyId}` -> array of failure timestamps (ms)
const LEAVE_VERIFY_MAX_FAILURES = 5;
const LEAVE_VERIFY_WINDOW_MS = 10 * 60 * 1000;
// Cloudflare's own header is authoritative for this tunnel setup (Cloudflare overwrites it at the
// edge, so a client can't spoof it) — falls back to X-Forwarded-For/req.ip for local/dev use where
// that header won't be present.
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
}
function isLeaveVerifyBlocked(key) {
  const cutoff = Date.now() - LEAVE_VERIFY_WINDOW_MS;
  const recent = (leaveVerifyFailures.get(key) || []).filter(t => t > cutoff);
  leaveVerifyFailures.set(key, recent);
  return recent.length >= LEAVE_VERIFY_MAX_FAILURES;
}
function recordLeaveVerifyFailure(key) {
  const recent = leaveVerifyFailures.get(key) || [];
  recent.push(Date.now());
  leaveVerifyFailures.set(key, recent);
}
// Shared by both routes below — the submission route re-verifies from scratch rather than
// trusting a client-held employee id, so guessing codes directly against it is throttled exactly
// like the dedicated verify route (skipping straight to POST /leave-requests must not be a way
// around the limiter).
async function findActiveEmployeeByCode(companyId, employeeCode) {
  const r = await pool.query(
    `SELECT * FROM employees WHERE company_id=$1 AND employee_code ILIKE $2 AND status='active'`,
    [companyId, (employeeCode || '').trim()]
  );
  return r.rows[0] || null;
}

app.post('/api/public/companies/:id/leave-verify', async (req, res) => {
  const companyId = parseInt(req.params.id, 10);
  const companyRes = await pool.query(`SELECT id, name FROM customer_companies WHERE id=$1 AND status='active'`, [companyId]);
  if (companyRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทที่เลือก' });
  const employeeCode = (req.body && req.body.employeeCode || '').trim();
  if (!employeeCode) return res.status(400).json({ error: 'กรุณากรอก ID พนักงาน' });
  const limitKey = `${getClientIp(req)}:${companyId}`;
  if (isLeaveVerifyBlocked(limitKey)) {
    return res.status(429).json({ error: 'คุณลองกรอก ID พนักงานผิดหลายครั้งเกินไป กรุณาลองใหม่อีกครั้งในอีก 10 นาที' });
  }
  const employee = await findActiveEmployeeByCode(companyId, employeeCode);
  if (!employee) {
    recordLeaveVerifyFailure(limitKey);
    return res.status(404).json({ error: 'ไม่พบข้อมูลพนักงาน กรุณาตรวจสอบ ID พนักงานอีกครั้ง' });
  }
  const [typesRes, balanceRes] = await Promise.all([
    pool.query('SELECT id, name FROM leave_types WHERE company_id=$1 ORDER BY id', [companyId]),
    pool.query(
      `SELECT b.*, lt.name AS leave_type_name FROM employee_leave_balance b
       JOIN leave_types lt ON lt.id = b.leave_type_id
       WHERE b.employee_id=$1 AND b.year=$2 ORDER BY lt.id`,
      [employee.id, new Date().getFullYear()]
    ),
  ]);
  res.json({
    employee: { id: employee.id, fullName: employee.full_name },
    leaveTypes: typesRes.rows.map(t => ({ id: t.id, name: t.name })),
    balances: balanceRes.rows.map(serializeLeaveBalance),
  });
});

app.post('/api/public/leave-requests', async (req, res) => {
  const body = req.body || {};
  const companyId = parseInt(body.companyId, 10);
  const { employeeCode, leaveTypeId, startDate, endDate, reason } = body;
  if (!companyId) return res.status(400).json({ error: 'ไม่พบบริษัทที่เลือก' });
  if (!employeeCode || !leaveTypeId || !startDate || !endDate) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }
  if (endDate < startDate) return res.status(400).json({ error: 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น' });
  const companyRes = await pool.query(`SELECT id, name FROM customer_companies WHERE id=$1 AND status='active'`, [companyId]);
  const company = companyRes.rows[0];
  if (!company) return res.status(404).json({ error: 'ไม่พบบริษัทที่เลือก หรือบริษัทถูกระงับการใช้งาน' });
  const limitKey = `${getClientIp(req)}:${companyId}`;
  if (isLeaveVerifyBlocked(limitKey)) {
    return res.status(429).json({ error: 'คุณลองกรอก ID พนักงานผิดหลายครั้งเกินไป กรุณาลองใหม่อีกครั้งในอีก 10 นาที' });
  }
  const employee = await findActiveEmployeeByCode(companyId, employeeCode);
  if (!employee) {
    recordLeaveVerifyFailure(limitKey);
    return res.status(404).json({ error: 'ไม่พบข้อมูลพนักงาน กรุณาตรวจสอบ ID พนักงานอีกครั้ง' });
  }
  const typeRes = await pool.query('SELECT * FROM leave_types WHERE id=$1 AND company_id=$2', [leaveTypeId, companyId]);
  const leaveType = typeRes.rows[0];
  if (!leaveType) return res.status(404).json({ error: 'ไม่พบประเภทวันลา' });
  const daysCount = await calculateLeaveDaysCount(companyId, startDate, endDate);
  const ins = await pool.query(
    `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days_count, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [employee.id, leaveTypeId, startDate, endDate, daysCount, (reason || '').trim()]
  );
  const r = await pool.query(`${LEAVE_REQUEST_SELECT} WHERE lr.id=$1`, [ins.rows[0].id]);
  const leaveRequest = serializeLeaveRequest(r.rows[0]);
  try {
    await notifyNewLeaveRequest(companyId, leaveRequest, company.name);
  } catch (err) {
    console.error('[mail] Failed to notify HR of new self-service leave request:', err);
  }
  res.json({ leaveRequest, company: { id: company.id, name: company.name } });
});

// ---------------- Customer-facing: จัดการสิทธิ์ผู้ใช้ (grant/revoke permission flags) ----------------
// ฟังก์ชันร่วมสำหรับทุก endpoint ที่มอบ/ถอนสิทธิ์ผู้ใช้คนอื่น (approval-permission,
// budget-approval-permission, permission-flags ใหม่ 3 ตัวจาก migration 0007) — รวมกฎไว้จุดเดียว กัน
// แต่ละ endpoint เช็คแยกกันแล้วพลาดข้อใดข้อหนึ่งไม่ตรงกัน:
//   1. super_user เท่านั้นที่มอบ/ถอนสิทธิ์คนอื่นได้ — ยังไม่มี flag แยกสำหรับ "จัดการสิทธิ์คนอื่น" เอง ถ้า
//      ให้คนมีสิทธิ์ X มอบสิทธิ์ X ให้คนอื่นได้ด้วย (แบบเดิม) จะไล่ตั้งสิทธิ์กันเองไม่จำกัดได้ (CLAUDE.md ข้อ 14)
//   2. ห้าม self-grant/self-revoke — กันกรณี super_user ถอนสิทธิ์ตัวเองออกจากระบบโดยไม่ตั้งใจ และกัน
//      audit log ที่สับสนว่า "อนุมัติสิทธิ์ให้ตัวเอง"
//   3. whitelist ชื่อคอลัมน์ที่แก้ได้ผ่านพารามิเตอร์ allowedColumns — กัน mass-assignment ในจุดที่ caller
//      รับชื่อ column มาจาก client โดยตรง (endpoint permission-flags ด้านล่าง)
//   4. company scope: ข้ามบริษัทต้องเป็น 404 เสมอ (ไม่ใช่ 403 — ไม่บอกว่าเอกสารมีอยู่จริงแต่เป็นของบริษัทอื่น)
//   5. target ต้อง status='active' เท่านั้น — แก้สิทธิ์ user ที่ถูกระงับไปแล้วไม่มีประโยชน์จริง
//   6. audit log ทุกครั้งที่ค่าเปลี่ยนจริง (ไม่ log ถ้าค่าเดิม=ค่าใหม่ กันประวัติรก) — doc_type='user_permission'
//      (migration 0007), doc_id = customers.id ของผู้ใช้ที่ถูกแก้ไข (ไม่ใช่เอกสารธุรกรรมเหมือน doc_type อื่น)
// คืนค่า {status, body} เสมอ ไม่ throw สำหรับ validation error ธรรมดา — ให้ caller ตัดสินใจ ROLLBACK/COMMIT
// เอง (route handler เปิด/ปิดทรานแซกชัน ฟังก์ชันนี้ไม่เปิดเอง เพื่อให้ future caller ที่ต้องทำงานอื่นร่วมใน
// ทรานแซกชันเดียวกันทำได้)
async function updateUserPermissionFlag(client, { actor, targetId, companyId, column, value, allowedColumns }) {
  if (!allowedColumns.has(column)) {
    return { status: 400, body: { error: 'ฟิลด์สิทธิ์ที่ระบุไม่ถูกต้อง' } };
  }
  if (actor.role !== 'super_user') {
    return { status: 403, body: { error: 'เฉพาะผู้ดูแลระบบ (super_user) เท่านั้นที่มีสิทธิ์มอบ/ถอนสิทธิ์นี้' } };
  }
  if (targetId === actor.id) {
    return { status: 403, body: { error: 'ไม่สามารถแก้ไขสิทธิ์ของตัวเองได้' } };
  }
  const r = await client.query('SELECT * FROM customers WHERE id=$1 AND company_id=$2 FOR UPDATE', [targetId, companyId]);
  if (r.rowCount === 0) {
    return { status: 404, body: { error: 'ไม่พบผู้ใช้งาน' } };
  }
  const target = r.rows[0];
  if (target.status !== 'active') {
    return { status: 409, body: { error: 'ผู้ใช้งานนี้ถูกระงับการใช้งานอยู่ แก้ไขสิทธิ์ไม่ได้' } };
  }
  const newValue = !!value;
  const oldValue = target[column];
  if (oldValue === newValue) {
    return { status: 200, body: { user: serializeCustomer(target) } }; // ไม่เปลี่ยนแปลงจริง ไม่ log
  }
  // column ผ่านการเช็คกับ allowedColumns (whitelist คงที่ที่ hardcode ไว้ในเซิร์ฟเวอร์) ไปแล้วด้านบน
  // เท่านั้นถึงจะมาถึงจุดนี้ได้ — ปลอดภัยที่จะ interpolate ชื่อคอลัมน์ตรงนี้
  const updated = await client.query(`UPDATE customers SET ${column}=$1 WHERE id=$2 RETURNING *`, [newValue, targetId]);
  await writeAuditLog(client, {
    companyId,
    docType: 'user_permission',
    docId: targetId,
    action: newValue ? 'grant' : 'revoke',
    fromStatus: String(oldValue),
    toStatus: String(newValue),
    performedBy: actor.id,
    reason: `แก้ไขสิทธิ์ ${column}`,
  });
  return { status: 200, body: { user: serializeCustomer(updated.rows[0]) } };
}

const APPROVAL_PERMISSION_COLUMNS = new Set(['can_approve_applications']);
app.put('/api/customer/users/:id/approval-permission', requireCustomerAuth, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { canApprove } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await updateUserPermissionFlag(client, {
      actor: req.customer, targetId, companyId: req.customer.company_id,
      column: 'can_approve_applications', value: canApprove, allowedColumns: APPROVAL_PERMISSION_COLUMNS,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------- Customer-facing: จัดการสิทธิ์อนุมัติงบประมาณ (grant/revoke can_approve_budget) ----------------
const BUDGET_APPROVAL_PERMISSION_COLUMNS = new Set(['can_approve_budget']);
app.put('/api/customer/users/:id/budget-approval-permission', requireCustomerAuth, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { canApprove } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await updateUserPermissionFlag(client, {
      actor: req.customer, targetId, companyId: req.customer.company_id,
      column: 'can_approve_budget', value: canApprove, allowedColumns: BUDGET_APPROVAL_PERMISSION_COLUMNS,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------- Customer-facing: จัดการสิทธิ์อนุมัติ/ดำเนินการที่เหลือทั้งหมดผ่าน endpoint เดียว ----------------
// ครอบคลุม 3 flag "จัดการ/ดำเนินการ" จาก migration 0007 (can_manage_po, can_manage_petty_cash_fund,
// can_settle_cash — ดูเหตุผลแยกแต่ละอันที่คอมเมนต์เหนือ 3 คอลัมน์นี้ใน
// migrations/0007_manage_permission_flags.up.sql, CLAUDE.md ข้อ 14) รวมกับ can_approve_budget และ 4
// flag "อนุมัติเอกสารตามเพดานวงเงิน" (can_approve_pr/petty_cash/advance/other — ใช้คู่กับ
// client_pr_approval_rules เสมอ มี flag อย่างเดียวไม่พอ ต้องมี rule แถว active ด้วยถึงจะอนุมัติได้จริง
// ดู canApprove() ด้านล่าง) — can_approve_applications ไม่รวมในนี้ เพราะมี endpoint
// /approval-permission แยกอยู่แล้วและ frontend เดิมผูกกับ endpoint นั้นตรงๆ ไม่ผ่านทาง column พารามิเตอร์
// column มาจาก client ตรงๆ (ไม่ hardcode เหมือน endpoint บน) จึงต้องพึ่ง allowedColumns whitelist ใน
// updateUserPermissionFlag() กัน mass-assignment จริงจัง
const MANAGE_PERMISSION_FLAG_COLUMNS = new Set([
  'can_manage_po', 'can_manage_petty_cash_fund', 'can_settle_cash',
  'can_approve_budget', 'can_approve_pr', 'can_approve_po_wo', 'can_approve_petty_cash', 'can_approve_advance', 'can_approve_other',
  'can_certify_progress', 'can_approve_progress',
]);
app.put('/api/customer/users/:id/permission-flags', requireCustomerAuth, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { column, value } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await updateUserPermissionFlag(client, {
      actor: req.customer, targetId, companyId: req.customer.company_id,
      column, value, allowedColumns: MANAGE_PERMISSION_FLAG_COLUMNS,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------- Admin panel: auth ----------------
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });
  }
  const r = await pool.query('SELECT * FROM platform_admins WHERE email = $1', [email]);
  const admin = r.rows[0];
  if (!admin || !admin.active) return res.status(401).json({ error: 'ไม่พบบัญชี หรือบัญชีถูกปิดใช้งาน' });
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  req.session.adminId = admin.id;
  res.json({ admin: serializeAdmin(admin) });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  res.json({ admin: serializeAdmin(req.currentAdmin) });
});

// ---------------- Admin panel: dashboard ----------------
app.get('/api/admin/dashboard/stats', requireAdminAuth, async (req, res) => {
  const companies = await pool.query('SELECT COUNT(*)::int AS n FROM customer_companies');
  const customers = await pool.query('SELECT COUNT(*)::int AS n FROM customers');
  const activeMembers = await pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE status = 'active'`);
  const revenue = await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS n FROM invoices WHERE status = 'paid'`);
  const newLeads = await pool.query(`SELECT COUNT(*)::int AS n FROM leads WHERE seen = false`);
  const dueSoonInvoices = await pool.query(
    `SELECT COUNT(*)::int AS n FROM invoices
     WHERE status = 'unpaid' AND due_date IS NOT NULL
       AND due_date >= CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL '7 days'`
  );
  res.json({
    totalCompanies: companies.rows[0].n,
    totalCustomers: customers.rows[0].n,
    totalRevenue: revenue.rows[0].n,
    activeMembers: activeMembers.rows[0].n,
    newLeadsCount: newLeads.rows[0].n,
    dueSoonInvoicesCount: dueSoonInvoices.rows[0].n,
  });
});

// ---------------- Admin panel: customer companies ----------------
function serializeCompany(row) {
  const { password_hash, ...rest } = row;
  return { ...rest, hasPassword: !!password_hash };
}

function serializeCustomer(row) {
  const { password_hash, ...rest } = row;
  return { ...rest, hasPassword: !!password_hash };
}

// Same preset list pr-system.html used to hardcode client-side as DB.jobPositions — seeded per
// company now that job_positions is a real table, so a brand-new company's "จัดการตำแหน่งงาน"
// isn't empty, and so 'ฝ่ายธุรการ/HR' actually exists for the can_approve_applications auto-grant
// hook (see POST /api/customer/employees) to match against.
const DEFAULT_JOB_POSITIONS = [
  ...['ผู้จัดการโครงการ', 'ผู้จัดการทั่วไป', 'ฝ่ายบัญชี-การเงิน', 'ฝ่ายจัดซื้อ', 'ฝ่ายธุรการ/HR'].map(name => ({ name, category: 'บริหาร/สำนักงาน' })),
  ...['วิศวกรโยธา', 'วิศวกรไฟฟ้า/เครื่องกล', 'โฟร์แมน/หัวหน้างานก่อสร้าง', 'ผู้ควบคุมงาน', 'สถาปนิก'].map(name => ({ name, category: 'วิศวกรรม/ควบคุมงาน' })),
  ...['ช่างก่อสร้างทั่วไป', 'ช่างปูน/ช่างก่ออิฐ', 'ช่างไม้/ช่างแบบ', 'ช่างเหล็ก/ช่างเชื่อม', 'ช่างไฟฟ้า', 'ช่างประปา/สุขาภิบาล', 'ช่างสี', 'ช่างกระเบื้อง'].map(name => ({ name, category: 'ช่างเทคนิค/ช่างฝีมือ' })),
  ...['กรรมกร/แรงงานทั่วไป', 'คนขับรถ/พขร.', 'ผู้ควบคุมเครื่องจักร', 'ยาม/รปภ.'].map(name => ({ name, category: 'แรงงาน/ปฏิบัติการ' })),
  ...['คลังพัสดุ/สต๊อกวัสดุ', 'เจ้าหน้าที่ความปลอดภัย (Safety Officer)'].map(name => ({ name, category: 'ฝ่ายสนับสนุน' })),
  ...['โฟร์แมน', 'วิศวกรโครงการ', 'ผจก.โครงการ', 'กรรมการบริษัท'].map(name => ({ name, category: 'ผู้บริหาร/ลงนามเอกสาร' })),
];
async function seedDefaultJobPositions(companyId) {
  await pool.query(
    `INSERT INTO job_positions (company_id, name, category)
     SELECT $1, * FROM UNNEST($2::text[], $3::text[])
     ON CONFLICT (company_id, name, category) DO NOTHING`,
    [companyId, DEFAULT_JOB_POSITIONS.map(p => p.name), DEFAULT_JOB_POSITIONS.map(p => p.category)]
  );
}

// Thai labor-law minimums (พ.ร.บ.คุ้มครองแรงงาน) plus one company-policy type (ลาอุปสมบท, not
// legally mandated — is_company_policy=true, default 0 days, company edits as needed). Note:
// ลาคลอดบุตร is only fully paid for the first 45 of its 98 days under the law — that partial-pay
// nuance isn't separately modeled (is_paid is a single flag per type, matching the schema as
// specified), so payroll integration treats the whole leave as paid; adjust manually if needed.
const DEFAULT_LEAVE_TYPES = [
  { name: 'วันหยุดพักผ่อนประจำปี', defaultDays: 6, isPaid: true, isCompanyPolicy: false },
  { name: 'ลาป่วย', defaultDays: 30, isPaid: true, isCompanyPolicy: false },
  { name: 'ลากิจ', defaultDays: 3, isPaid: true, isCompanyPolicy: false },
  { name: 'ลาคลอดบุตร', defaultDays: 98, isPaid: true, isCompanyPolicy: false },
  { name: 'ลาเพื่อรับราชการทหาร', defaultDays: 60, isPaid: true, isCompanyPolicy: false },
  { name: 'ลาอุปสมบท', defaultDays: 0, isPaid: true, isCompanyPolicy: true },
];
async function seedDefaultLeaveTypes(companyId) {
  await pool.query(
    `INSERT INTO leave_types (company_id, name, default_days_per_year, is_paid, is_company_policy)
     SELECT $1, * FROM UNNEST($2::text[], $3::numeric[], $4::boolean[], $5::boolean[])
     ON CONFLICT (company_id, name) DO NOTHING`,
    [companyId, DEFAULT_LEAVE_TYPES.map(t => t.name), DEFAULT_LEAVE_TYPES.map(t => t.defaultDays),
     DEFAULT_LEAVE_TYPES.map(t => t.isPaid), DEFAULT_LEAVE_TYPES.map(t => t.isCompanyPolicy)]
  );
}

// Starter chart of accounts for the client ledger (see "Client ledger" section in schema.sql) —
// same 1xxx-5xxx category structure as admin-panel's chart_of_accounts, generic construction-project
// account names. Called from both company-creation paths below (company-signup and admin-created
// companies) so "the first time a company starts using the system" is covered either way; every
// migration that adds a new account since (0003/0005/0014 etc.) also has a one-time SQL backfill for
// companies that already existed before it, matching this array so old and new companies stay in sync.
const DEFAULT_CLIENT_CHART_OF_ACCOUNTS = [
  { code: '1100', name: 'เงินสด', category: 'asset' },
  { code: '1110', name: 'เงินสดย่อย', category: 'asset' },
  { code: '1150', name: 'ลูกหนี้เงินทดรองจ่าย', category: 'asset' },
  { code: '1200', name: 'ลูกหนี้การค้า', category: 'asset' },
  { code: '1250', name: 'ลูกหนี้เงินประกันผลงาน', category: 'asset' },
  { code: '1260', name: 'ภาษีหัก ณ ที่จ่ายค้างรับ', category: 'asset' },
  { code: '1170', name: 'ภาษีซื้อ', category: 'asset' },
  { code: '2100', name: 'เจ้าหนี้การค้า', category: 'liability' },
  { code: '2110', name: 'เจ้าหนี้พนักงาน', category: 'liability' },
  { code: '2120', name: 'ภาษีหัก ณ ที่จ่ายค้างนำส่ง', category: 'liability' },
  { code: '2150', name: 'ค่าแรงค้างจ่าย', category: 'liability' },
  { code: '2160', name: 'เงินรับล่วงหน้าจากลูกค้า', category: 'liability' }, // เพิ่มใน migration 0014 (หัวข้อ 3, advance payment)
  { code: '4100', name: 'รายได้ค่าก่อสร้าง', category: 'revenue' },
  { code: '5100', name: 'ต้นทุนวัสดุ', category: 'expense' },
  { code: '5200', name: 'ต้นทุนผู้รับเหมาช่วง', category: 'expense' },
  { code: '5300', name: 'ค่าใช้จ่ายสำนักงาน', category: 'expense' },
  { code: '5400', name: 'ค่าแรง', category: 'expense' },
  { code: '5900', name: 'ค่าใช้จ่ายอื่นๆ', category: 'expense' },
];
async function seedDefaultClientChartOfAccounts(companyId) {
  await pool.query(
    `INSERT INTO client_chart_of_accounts (company_id, code, name, category)
     SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[])
     ON CONFLICT (company_id, code) DO NOTHING`,
    [companyId, DEFAULT_CLIENT_CHART_OF_ACCOUNTS.map(a => a.code),
     DEFAULT_CLIENT_CHART_OF_ACCOUNTS.map(a => a.name), DEFAULT_CLIENT_CHART_OF_ACCOUNTS.map(a => a.category)]
  );
}

// The one function every pr-system.html module posts client-ledger journal entries through — the
// multi-tenant counterpart to createJournalEntry() (admin-panel's SiteReq-only book, see the
// "General journal" section earlier in this file). Same validate-before-INSERT shape: checks
// debit=credit and that every account_code exists+active BEFORE issuing any INSERT, so a bad call
// throws cleanly without poisoning the caller's transaction.
//
// The company_id isolation guarantee is the whole point of this function, so it's enforced twice,
// redundantly, on purpose:
//   1. The chart-of-accounts existence check below is scoped `WHERE company_id=$1` — an account
//      code that's perfectly valid for another company will not be found for this one.
//   2. Every INSERT (both the header and every line) writes `companyId` itself — never trusting a
//      value that could have arrived embedded in `lines` — and client_journal_entry_lines.company_id
//      is additionally pinned to the SAME company as its account_code by a DB-level composite FK
//      (see schema.sql), so even a bug in this function's own logic can't silently cross the wires.
// Callers (see each module's own auto-post helper) are responsible for having already verified that
// `companyId` matches `req.customer.company_id` for the currently-logged-in session — this function
// only guarantees internal consistency of the entry it writes, not who's allowed to call it.
async function createClientJournalEntry(client, { companyId, entryDate, description, sourceType, sourceId, projectId, createdBy, lines }) {
  if (!companyId) throw new Error('ต้องระบุบริษัทเสมอ');
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('รายการบันทึกบัญชีต้องมีอย่างน้อย 2 บรรทัด');
  let totalDebit = 0, totalCredit = 0;
  for (const l of lines) {
    if (!l.accountCode) throw new Error('กรุณาระบุรหัสบัญชีทุกบรรทัด');
    totalDebit += round2(l.debitAmount);
    totalCredit += round2(l.creditAmount);
  }
  totalDebit = round2(totalDebit);
  totalCredit = round2(totalCredit);
  if (totalDebit <= 0 || totalDebit !== totalCredit) {
    throw new Error(`เดบิตรวม (${totalDebit}) ต้องเท่ากับเครดิตรวม (${totalCredit}) และมากกว่า 0`);
  }

  const codes = [...new Set(lines.map(l => l.accountCode))];
  const accRes = await client.query(
    `SELECT code FROM client_chart_of_accounts WHERE company_id=$1 AND code = ANY($2) AND is_active = true`,
    [companyId, codes]
  );
  const activeCodes = new Set(accRes.rows.map(r => r.code));
  const missing = codes.filter(c => !activeCodes.has(c));
  if (missing.length) throw new Error(`ไม่พบบัญชีที่ใช้งานอยู่สำหรับบริษัทนี้: ${missing.join(', ')}`);

  const entry = await client.query(
    `INSERT INTO client_journal_entries (company_id, entry_date, description, source_type, source_id, project_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [companyId, entryDate, description || '', sourceType, sourceId || null, projectId || null, createdBy || null]
  );
  const journalEntryId = entry.rows[0].id;
  for (const l of lines) {
    await client.query(
      `INSERT INTO client_journal_entry_lines (journal_entry_id, company_id, account_code, debit_amount, credit_amount, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [journalEntryId, companyId, l.accountCode, round2(l.debitAmount), round2(l.creditAmount), l.description || '']
    );
  }
  return journalEntryId;
}

app.get('/api/admin/companies', requireAdminAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT c.*, COUNT(cu.id)::int AS "contactCount", p.name AS "packageName"
    FROM customer_companies c
    LEFT JOIN customers cu ON cu.company_id = c.id
    LEFT JOIN packages p ON p.id = c.package_id
    GROUP BY c.id, p.name
    ORDER BY c.id DESC`);
  res.json({ companies: r.rows.map(serializeCompany) });
});

app.get('/api/admin/companies/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await pool.query(`
    SELECT c.*, p.name AS "packageName" FROM customer_companies c
    LEFT JOIN packages p ON p.id = c.package_id WHERE c.id = $1`, [id]);
  if (c.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });
  const contacts = await pool.query('SELECT * FROM customers WHERE company_id = $1 ORDER BY id', [id]);
  const subRes = await pool.query('SELECT * FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  const sub = subRes.rows[0] || null;
  const subscription = sub
    ? { ...sub, active: sub.status === 'active' && (!sub.expires_at || new Date(sub.expires_at) >= new Date()) }
    : null;
  res.json({ company: serializeCompany(c.rows[0]), customers: contacts.rows.map(serializeCustomer), subscription });
});

app.get('/api/admin/companies/by-code/:code', requireAdminAuth, async (req, res) => {
  const code = req.params.code.trim();
  const c = await pool.query('SELECT * FROM customer_companies WHERE code = $1', [code]);
  if (c.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรหัสบริษัทนี้' });
  const contact = await pool.query('SELECT name FROM customers WHERE company_id=$1 ORDER BY id LIMIT 1', [c.rows[0].id]);
  res.json({ company: serializeCompany(c.rows[0]), contactName: contact.rows[0] ? contact.rows[0].name : '' });
});

// months -> {days, discount}: mirrors the duration buttons in admin-panel.html's renew card
// (1/3/6/12 months = 30/90/180/365 days, with a 0/5/10/17% discount on the whole order).
const RENEW_DURATIONS = { 1: { days: 30, discount: 0 }, 3: { days: 90, discount: 0.05 }, 6: { days: 180, discount: 0.10 }, 12: { days: 365, discount: 0.17 } };

app.post('/api/admin/companies/:id/renew', requireAdminAuth, async (req, res) => {
  const companyId = parseInt(req.params.id, 10);
  const { customPrice, customSeatPrice, baseUsers, additionalUsers, months, tier } = req.body || {};
  const price = Number(customPrice);
  const seatPrice = Number(customSeatPrice);
  const base = parseInt(baseUsers, 10);
  const addUsers = parseInt(additionalUsers, 10) || 0;
  const duration = RENEW_DURATIONS[parseInt(months, 10)];
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'กรุณากรอกราคาแพ็กเกจให้ถูกต้อง' });
  if (!Number.isFinite(seatPrice) || seatPrice < 0) return res.status(400).json({ error: 'กรุณากรอกราคาต่อคนให้ถูกต้อง' });
  if (!Number.isInteger(base) || base < 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนผู้ใช้งานให้ถูกต้อง' });
  if (!Number.isInteger(addUsers) || addUsers < 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนผู้ใช้งานที่เพิ่มให้ถูกต้อง' });
  if (!duration) return res.status(400).json({ error: 'กรุณาเลือกระยะเวลาให้ถูกต้อง' });

  const company = await pool.query(
    `SELECT c.id, p.name AS "packageName" FROM customer_companies c
     LEFT JOIN packages p ON p.id = c.package_id WHERE c.id=$1`, [companyId]);
  if (company.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });

  const existing = await pool.query('SELECT * FROM subscriptions WHERE company_id=$1 ORDER BY id DESC LIMIT 1', [companyId]);
  const derivedTier = (company.rows[0].packageName || 'free').toLowerCase();
  const newTier = tier || (existing.rows[0] && existing.rows[0].tier) || derivedTier;
  const newMaxUsers = base + addUsers;

  const monthsNum = parseInt(months, 10);
  const packageCost = price * monthsNum;
  const addUsersCost = addUsers * seatPrice * monthsNum;
  const total = (packageCost + addUsersCost) * (1 - duration.discount);

  let r;
  if (existing.rowCount > 0) {
    r = await pool.query(
      `UPDATE subscriptions SET tier=$1, max_users=$2, expires_at = now() + ($3::int * interval '1 day'),
       custom_price=$4, custom_seat_price=$5, total_amount=$6, period_start=now(), last_additional_users=$7,
       status='active' WHERE id=$8 RETURNING *`,
      [newTier, newMaxUsers, duration.days, price, seatPrice, total, addUsers, existing.rows[0].id]
    );
  } else {
    r = await pool.query(
      `INSERT INTO subscriptions (company_id, tier, max_users, expires_at, custom_price, custom_seat_price, total_amount, period_start, last_additional_users, status)
       VALUES ($1,$2,$3, now() + ($4::int * interval '1 day'), $5,$6,$7, now(), $8, 'active') RETURNING *`,
      [companyId, newTier, newMaxUsers, duration.days, price, seatPrice, total, addUsers]
    );
  }
  res.json({ subscription: r.rows[0], total, packageCost, addUsersCost, discount: duration.discount });
});

app.post('/api/admin/companies', requireAdminAuth, async (req, res) => {
  const { code, name, taxId, phone, email, address, packageId, fax } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const trimmedCode = (code || '').trim();
  if (trimmedCode) {
    const exists = await pool.query('SELECT 1 FROM customer_companies WHERE code = $1', [trimmedCode]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสบริษัทนี้มีอยู่แล้ว' });
  }
  const r = await pool.query(
    `INSERT INTO customer_companies (code, name, tax_id, phone, email, address, package_id, fax)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [trimmedCode || null, name.trim(), (taxId || '').trim(), (phone || '').trim(), (email || '').trim(), (address || '').trim(), packageId || null,
     (fax || '').trim()]
  );
  await seedDefaultJobPositions(r.rows[0].id);
  await seedDefaultLeaveTypes(r.rows[0].id);
  await seedDefaultClientChartOfAccounts(r.rows[0].id);
  res.json({ company: serializeCompany(r.rows[0]) });
});

app.put('/api/admin/companies/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, name, taxId, phone, email, address, packageId, fax } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const trimmedCode = (code || '').trim();
  if (trimmedCode) {
    const exists = await pool.query('SELECT 1 FROM customer_companies WHERE code = $1 AND id <> $2', [trimmedCode, id]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสบริษัทนี้มีอยู่แล้ว' });
  }
  const r = await pool.query(
    `UPDATE customer_companies SET code=$1, name=$2, tax_id=$3, phone=$4, email=$5, address=$6, package_id=$7,
     fax=$8 WHERE id=$9 RETURNING *`,
    [trimmedCode || null, name.trim(), (taxId || '').trim(), (phone || '').trim(), (email || '').trim(), (address || '').trim(), packageId || null,
     (fax || '').trim(), id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });
  res.json({ company: serializeCompany(r.rows[0]) });
});

app.post('/api/admin/companies/:id/suspend', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    `UPDATE customer_companies SET status = CASE WHEN status='active' THEN 'suspended' ELSE 'active' END
     WHERE id=$1 RETURNING *`,
    [id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });
  res.json({ company: serializeCompany(r.rows[0]) });
});

app.delete('/api/admin/companies/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM customer_companies WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ---------------- Admin panel: leads (prospect companies) ----------------
function serializeLead(row) {
  const { password_hash, ...rest } = row;
  return { ...rest, hasPassword: !!password_hash };
}

app.get('/api/admin/leads', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM leads ORDER BY id DESC');
  res.json({ leads: r.rows.map(serializeLead) });
});

app.get('/api/admin/leads/by-code/:code', requireAdminAuth, async (req, res) => {
  const code = req.params.code.trim();
  const r = await pool.query('SELECT * FROM leads WHERE ref_code = $1', [code]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรหัสอ้างอิงนี้' });
  res.json({ lead: serializeLead(r.rows[0]) });
});

app.post('/api/admin/leads', requireAdminAuth, async (req, res) => {
  const {
    refCode, companyName, taxId, address, companyPhone, companyEmail, website,
    contactName, contactPosition, contactEmail, contactPhone, username, password,
    status, note,
  } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const trimmedRefCode = (refCode || '').trim();
  if (trimmedRefCode) {
    const exists = await pool.query('SELECT 1 FROM leads WHERE ref_code = $1', [trimmedRefCode]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสอ้างอิงนี้มีอยู่แล้ว' });
  }
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM leads WHERE username = $1', [trimmedUsername]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const passwordHash = password && password.trim() ? await bcrypt.hash(password.trim(), 10) : null;
  const r = await pool.query(
    `INSERT INTO leads (ref_code, company_name, tax_id, address, company_phone, company_email, website,
       contact_name, contact_position, contact_email, contact_phone, username, password_hash, status, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [trimmedRefCode || null, companyName.trim(), (taxId || '').trim(), (address || '').trim(), (companyPhone || '').trim(), (companyEmail || '').trim(), (website || '').trim(),
     (contactName || '').trim(), (contactPosition || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(),
     trimmedUsername || null, passwordHash, status || 'new', (note || '').trim()]
  );
  res.json({ lead: serializeLead(r.rows[0]) });
});

app.put('/api/admin/leads/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    refCode, companyName, taxId, address, companyPhone, companyEmail, website,
    contactName, contactPosition, contactEmail, contactPhone, username, password,
    status, note,
  } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const trimmedRefCode = (refCode || '').trim();
  if (trimmedRefCode) {
    const exists = await pool.query('SELECT 1 FROM leads WHERE ref_code = $1 AND id <> $2', [trimmedRefCode, id]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสอ้างอิงนี้มีอยู่แล้ว' });
  }
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM leads WHERE username = $1 AND id <> $2', [trimmedUsername, id]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  let r;
  if (password && password.trim()) {
    const passwordHash = await bcrypt.hash(password.trim(), 10);
    r = await pool.query(
      `UPDATE leads SET ref_code=$1, company_name=$2, tax_id=$3, address=$4, company_phone=$5, company_email=$6, website=$7,
         contact_name=$8, contact_position=$9, contact_email=$10, contact_phone=$11, username=$12, password_hash=$13, status=$14, note=$15
       WHERE id=$16 RETURNING *`,
      [trimmedRefCode || null, companyName.trim(), (taxId || '').trim(), (address || '').trim(), (companyPhone || '').trim(), (companyEmail || '').trim(), (website || '').trim(),
       (contactName || '').trim(), (contactPosition || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(),
       trimmedUsername || null, passwordHash, status || 'new', (note || '').trim(), id]
    );
  } else {
    r = await pool.query(
      `UPDATE leads SET ref_code=$1, company_name=$2, tax_id=$3, address=$4, company_phone=$5, company_email=$6, website=$7,
         contact_name=$8, contact_position=$9, contact_email=$10, contact_phone=$11, username=$12, status=$13, note=$14
       WHERE id=$15 RETURNING *`,
      [trimmedRefCode || null, companyName.trim(), (taxId || '').trim(), (address || '').trim(), (companyPhone || '').trim(), (companyEmail || '').trim(), (website || '').trim(),
       (contactName || '').trim(), (contactPosition || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(),
       trimmedUsername || null, status || 'new', (note || '').trim(), id]
    );
  }
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  res.json({ lead: serializeLead(r.rows[0]) });
});

app.delete('/api/admin/leads/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

app.post('/api/admin/leads/:id/mark-seen', requireAdminAuth, async (req, res) => {
  const r = await pool.query('UPDATE leads SET seen = true WHERE id=$1 RETURNING *', [parseInt(req.params.id, 10)]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  res.json({ lead: serializeLead(r.rows[0]) });
});

// ---------------- Admin panel: customer contacts ----------------
const CUSTOMER_ROLES = new Set([
  'super_user', 'admin_maker', 'admin_approver',
  'single_auto', 'single_dual', 'maker', 'checker', 'approver',
]);

app.post('/api/admin/companies/:id/customers', requireAdminAuth, checkPackageLimit, async (req, res) => {
  const companyId = parseInt(req.params.id, 10);
  const { name, email, phone, position, username, password, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ติดต่อ' });
  const company = await pool.query('SELECT 1 FROM customer_companies WHERE id=$1', [companyId]);
  if (company.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });
  const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE company_id=$1', [companyId]);
  if (countRes.rows[0].n >= req.subscription.max_users) {
    return res.status(403).json({ error: 'ผู้ใช้งานครบจำนวนแล้วตามแพ็กเกจ' });
  }
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM customers WHERE username = $1', [trimmedUsername]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const passwordHash = password && password.trim() ? await bcrypt.hash(password.trim(), 10) : null;
  const safeRole = CUSTOMER_ROLES.has(role) ? role : 'super_user';
  const r = await pool.query(
    `INSERT INTO customers (company_id, name, email, phone, position, username, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, name.trim(), (email || '').trim(), (phone || '').trim(), (position || '').trim(), trimmedUsername || null, passwordHash, safeRole]
  );
  res.json({ customer: serializeCustomer(r.rows[0]) });
});

app.put('/api/admin/customers/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, email, phone, position, username, password, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ติดต่อ' });
  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    const exists = await pool.query('SELECT 1 FROM customers WHERE username = $1 AND id <> $2', [trimmedUsername, id]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานนี้มีอยู่แล้ว' });
  }
  const safeRole = CUSTOMER_ROLES.has(role) ? role : 'super_user';
  let r;
  if (password && password.trim()) {
    const passwordHash = await bcrypt.hash(password.trim(), 10);
    r = await pool.query(
      `UPDATE customers SET name=$1, email=$2, phone=$3, position=$4, username=$5, password_hash=$6, role=$7 WHERE id=$8 RETURNING *`,
      [name.trim(), (email || '').trim(), (phone || '').trim(), (position || '').trim(), trimmedUsername || null, passwordHash, safeRole, id]
    );
  } else {
    r = await pool.query(
      `UPDATE customers SET name=$1, email=$2, phone=$3, position=$4, username=$5, role=$6 WHERE id=$7 RETURNING *`,
      [name.trim(), (email || '').trim(), (phone || '').trim(), (position || '').trim(), trimmedUsername || null, safeRole, id]
    );
  }
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบผู้ติดต่อ' });
  res.json({ customer: serializeCustomer(r.rows[0]) });
});

app.post('/api/admin/customers/:id/suspend', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    `UPDATE customers SET status = CASE WHEN status='active' THEN 'suspended' ELSE 'active' END
     WHERE id=$1 RETURNING *`,
    [id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบผู้ติดต่อ' });
  res.json({ customer: serializeCustomer(r.rows[0]) });
});

app.delete('/api/admin/customers/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM customers WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ---------------- Admin panel: platform admin/staff accounts ----------------
app.get('/api/admin/accounts', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM platform_admins ORDER BY id');
  // owner accounts are invisible to everyone except owners themselves
  const visible = req.currentAdmin.role === 'owner' ? r.rows : r.rows.filter(a => a.role !== 'owner');
  res.json({ accounts: visible.map(serializeAdmin) });
});

app.post('/api/admin/accounts', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name || !role) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  if (!ROLE_RANK.hasOwnProperty(role)) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
  if (role === 'owner' && req.currentAdmin.role !== 'owner') return res.status(403).json({ error: 'เฉพาะผู้สร้างเท่านั้นที่กำหนดบทบาทผู้สร้างได้' });
  const exists = await pool.query('SELECT 1 FROM platform_admins WHERE email = $1', [email]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'อีเมลนี้มีอยู่แล้ว' });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO platform_admins (email, password_hash, name, role, active)
     VALUES ($1,$2,$3,$4,true) RETURNING *`,
    [email.trim(), hash, name.trim(), role]
  );
  res.json({ account: serializeAdmin(r.rows[0]) });
});

app.put('/api/admin/accounts/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  if (!ROLE_RANK.hasOwnProperty(role)) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
  if (role === 'owner' && req.currentAdmin.role !== 'owner') return res.status(403).json({ error: 'เฉพาะผู้สร้างเท่านั้นที่กำหนดบทบาทผู้สร้างได้' });
  const target = await loadAdmin(id);
  if (!target) return res.status(404).json({ error: 'ไม่พบบัญชี' });
  if (target.role === 'owner') return res.status(403).json({ error: 'ไม่สามารถแก้ไขบัญชีผู้สร้างได้' });
  const r = await pool.query('UPDATE platform_admins SET name=$1, role=$2 WHERE id=$3 RETURNING *', [name.trim(), role, id]);
  res.json({ account: serializeAdmin(r.rows[0]) });
});

app.post('/api/admin/accounts/:id/toggle-active', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = await loadAdmin(id);
  if (!target) return res.status(404).json({ error: 'ไม่พบบัญชี' });
  if (target.role === 'owner') return res.status(403).json({ error: 'ไม่สามารถปิดใช้งานบัญชีผู้สร้างได้' });
  const r = await pool.query('UPDATE platform_admins SET active = NOT active WHERE id=$1 RETURNING *', [id]);
  res.json({ account: serializeAdmin(r.rows[0]) });
});

// ---------------- Admin panel: own account ----------------
app.put('/api/admin/account', requireAdminAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  const r = await pool.query('UPDATE platform_admins SET name=$1 WHERE id=$2 RETURNING *', [name.trim(), req.currentAdmin.id]);
  res.json({ admin: serializeAdmin(r.rows[0]) });
});

app.post('/api/admin/account/password', requireAdminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสผ่านให้ครบถ้วน' });
  }
  if (newPassword.length < 6) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
  const ok = await bcrypt.compare(currentPassword, req.currentAdmin.password_hash);
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE platform_admins SET password_hash=$1 WHERE id=$2', [hash, req.currentAdmin.id]);
  res.json({ ok: true });
});

// ---------------- Admin panel: products (สินค้า/บริการ) ----------------
app.get('/api/admin/products', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY name');
  res.json({ products: r.rows });
});

app.post('/api/admin/products', requireAdminAuth, async (req, res) => {
  const { name, description, unit, price } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้า/บริการ' });
  const r = await pool.query(
    `INSERT INTO products (name, description, unit, price) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name.trim(), (description || '').trim(), (unit || '').trim(), Number(price) || 0]
  );
  res.json({ product: r.rows[0] });
});

app.put('/api/admin/products/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description, unit, price } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้า/บริการ' });
  const r = await pool.query(
    `UPDATE products SET name=$1, description=$2, unit=$3, price=$4 WHERE id=$5 RETURNING *`,
    [name.trim(), (description || '').trim(), (unit || '').trim(), Number(price) || 0, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบสินค้า/บริการ' });
  res.json({ product: r.rows[0] });
});

app.post('/api/admin/products/:id/toggle-active', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('UPDATE products SET is_active = NOT is_active WHERE id=$1 RETURNING *', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบสินค้า/บริการ' });
  res.json({ product: r.rows[0] });
});

// ---------------- Admin panel: packages ----------------
app.get('/api/admin/packages', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM packages ORDER BY price');
  res.json({ packages: r.rows });
});

app.post('/api/admin/packages', requireAdminAuth, async (req, res) => {
  const { name, price, billingCycle, billingDays, description, maxUsers } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อแพ็กเกจ' });
  const cycle = billingCycle === 'yearly' ? 'yearly' : billingCycle === 'daily' ? 'daily' : 'monthly';
  const days = cycle === 'daily' ? Math.max(1, parseInt(billingDays, 10) || 1) : null;
  const r = await pool.query(
    `INSERT INTO packages (name, price, billing_cycle, billing_days, description, max_users) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), Number(price) || 0, cycle, days, (description || '').trim(), Math.max(1, parseInt(maxUsers, 10) || 1)]
  );
  res.json({ package: r.rows[0] });
});

app.put('/api/admin/packages/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, price, billingCycle, billingDays, description, maxUsers } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อแพ็กเกจ' });
  const cycle = billingCycle === 'yearly' ? 'yearly' : billingCycle === 'daily' ? 'daily' : 'monthly';
  const days = cycle === 'daily' ? Math.max(1, parseInt(billingDays, 10) || 1) : null;
  const r = await pool.query(
    `UPDATE packages SET name=$1, price=$2, billing_cycle=$3, billing_days=$4, description=$5, max_users=$6 WHERE id=$7 RETURNING *`,
    [name.trim(), Number(price) || 0, cycle, days, (description || '').trim(), Math.max(1, parseInt(maxUsers, 10) || 1), id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบแพ็กเกจ' });
  res.json({ package: r.rows[0] });
});

app.post('/api/admin/packages/:id/toggle-active', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('UPDATE packages SET active = NOT active WHERE id=$1 RETURNING *', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบแพ็กเกจ' });
  res.json({ package: r.rows[0] });
});

// ---------------- Admin panel: chart of accounts (ผังบัญชี) ----------------
const COA_CATEGORIES = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);

app.get('/api/admin/chart-of-accounts', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM chart_of_accounts ORDER BY code');
  res.json({ accounts: r.rows });
});

app.post('/api/admin/chart-of-accounts', requireAdminAuth, async (req, res) => {
  const { code, name, category, parentCode } = req.body || {};
  const trimmedCode = (code || '').trim();
  if (!trimmedCode) return res.status(400).json({ error: 'กรุณากรอกรหัสบัญชี' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบัญชี' });
  if (!COA_CATEGORIES.has(category)) return res.status(400).json({ error: 'หมวดบัญชีไม่ถูกต้อง' });
  const exists = await pool.query('SELECT 1 FROM chart_of_accounts WHERE code = $1', [trimmedCode]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสบัญชีนี้มีอยู่แล้ว' });
  const trimmedParent = (parentCode || '').trim();
  if (trimmedParent) {
    const parent = await pool.query('SELECT 1 FROM chart_of_accounts WHERE code = $1', [trimmedParent]);
    if (parent.rowCount === 0) return res.status(400).json({ error: 'ไม่พบรหัสบัญชีแม่' });
  }
  const r = await pool.query(
    `INSERT INTO chart_of_accounts (code, name, category, parent_code) VALUES ($1,$2,$3,$4) RETURNING *`,
    [trimmedCode, name.trim(), category, trimmedParent || null]
  );
  res.json({ account: r.rows[0] });
});

app.put('/api/admin/chart-of-accounts/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, name, category, parentCode } = req.body || {};
  const trimmedCode = (code || '').trim();
  if (!trimmedCode) return res.status(400).json({ error: 'กรุณากรอกรหัสบัญชี' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบัญชี' });
  if (!COA_CATEGORIES.has(category)) return res.status(400).json({ error: 'หมวดบัญชีไม่ถูกต้อง' });
  const exists = await pool.query('SELECT 1 FROM chart_of_accounts WHERE code = $1 AND id <> $2', [trimmedCode, id]);
  if (exists.rowCount > 0) return res.status(409).json({ error: 'รหัสบัญชีนี้มีอยู่แล้ว' });
  const trimmedParent = (parentCode || '').trim();
  if (trimmedParent) {
    if (trimmedParent === trimmedCode) return res.status(400).json({ error: 'บัญชีแม่ต้องไม่ใช่บัญชีเดียวกับตัวเอง' });
    const parent = await pool.query('SELECT 1 FROM chart_of_accounts WHERE code = $1', [trimmedParent]);
    if (parent.rowCount === 0) return res.status(400).json({ error: 'ไม่พบรหัสบัญชีแม่' });
  }
  const r = await pool.query(
    `UPDATE chart_of_accounts SET code=$1, name=$2, category=$3, parent_code=$4 WHERE id=$5 RETURNING *`,
    [trimmedCode, name.trim(), category, trimmedParent || null, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบัญชี' });
  res.json({ account: r.rows[0] });
});

app.post('/api/admin/chart-of-accounts/:id/toggle-active', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('UPDATE chart_of_accounts SET is_active = NOT is_active WHERE id=$1 RETURNING *', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบัญชี' });
  res.json({ account: r.rows[0] });
});

// ---------------- General journal (สมุดรายวัน) — double-entry bookkeeping core ----------------
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// The one function every module posts journal entries through, instead of each writing its own
// debit/credit insert logic. Validates — before issuing a single INSERT — that (a) debit total =
// credit total and (b) every referenced account_code exists and is active. Validating first matters:
// `client` is usually mid-transaction for the caller's own row (an invoice, an expense, ...), and a
// failed INSERT would poison that whole transaction until ROLLBACK, whereas a thrown JS error from a
// failed SELECT-based check lets the caller catch it and continue (see postInvoiceJournalEntry).
async function createJournalEntry(client, { entryDate, description, sourceType, sourceId, createdBy, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('รายการบันทึกบัญชีต้องมีอย่างน้อย 2 บรรทัด');
  let totalDebit = 0, totalCredit = 0;
  for (const l of lines) {
    if (!l.accountCode) throw new Error('กรุณาระบุรหัสบัญชีทุกบรรทัด');
    totalDebit += round2(l.debitAmount);
    totalCredit += round2(l.creditAmount);
  }
  totalDebit = round2(totalDebit);
  totalCredit = round2(totalCredit);
  if (totalDebit <= 0 || totalDebit !== totalCredit) {
    throw new Error(`เดบิตรวม (${totalDebit}) ต้องเท่ากับเครดิตรวม (${totalCredit}) และมากกว่า 0`);
  }

  const codes = [...new Set(lines.map(l => l.accountCode))];
  const accRes = await client.query(`SELECT code FROM chart_of_accounts WHERE code = ANY($1) AND is_active = true`, [codes]);
  const activeCodes = new Set(accRes.rows.map(r => r.code));
  const missing = codes.filter(c => !activeCodes.has(c));
  if (missing.length) throw new Error(`ไม่พบบัญชีที่ใช้งานอยู่: ${missing.join(', ')}`);

  const entry = await client.query(
    `INSERT INTO journal_entries (entry_date, description, source_type, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [entryDate, description || '', sourceType, sourceId || null, createdBy || null]
  );
  const journalEntryId = entry.rows[0].id;
  for (const l of lines) {
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_code, debit_amount, credit_amount, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [journalEntryId, l.accountCode, round2(l.debitAmount), round2(l.creditAmount), l.description || '']
    );
  }
  return journalEntryId;
}

// ---------------- Admin panel: invoices ----------------
async function generateInvoiceNumber(client) {
  const year = new Date().getFullYear() + 543; // Buddhist Era, matches Thai convention used elsewhere in this app
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await client.query('SELECT COUNT(*)::int AS n FROM invoices');
    const no = `INV-${year}-` + String(countRes.rows[0].n + 1 + attempt).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM invoices WHERE invoice_no=$1', [no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบแจ้งหนี้ได้');
}

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_no AS "invoiceNo", i.company_id AS "companyId", c.name AS "companyName",
    c.phone AS "companyPhone", c.fax AS "companyFax", c.tax_id AS "companyTaxId",
    c.address AS "companyAddress", c.email AS "companyEmail",
    c.default_quote_validity_days AS "defaultQuoteValidityDays", c.default_credit_days AS "defaultCreditDays",
    i.package_id AS "packageId", p.name AS "packageName", i.amount,
    to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate", to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",
    i.status, i.note, i.created_at AS "createdAt",
    (SELECT COUNT(*)::int FROM payment_slips ps WHERE ps.invoice_id = i.id) AS "slipCount",
    (SELECT COALESCE(SUM(amount),0) FROM invoice_payments ip WHERE ip.invoice_id = i.id)::float AS "amountReceived",
    sub.tier AS "subTier", to_char(sub.period_start,'YYYY-MM-DD') AS "subPeriodStart",
    to_char(sub.expires_at,'YYYY-MM-DD') AS "subExpiresAt", sub.last_additional_users AS "subAdditionalUsers"
  FROM invoices i
  JOIN customer_companies c ON c.id = i.company_id
  LEFT JOIN packages p ON p.id = i.package_id
  LEFT JOIN LATERAL (
    SELECT tier, period_start, expires_at, last_additional_users
    FROM subscriptions s WHERE s.company_id = c.id ORDER BY s.id DESC LIMIT 1
  ) sub ON true`;

app.get('/api/admin/invoices', requireAdminAuth, async (req, res) => {
  const { companyId, status } = req.query || {};
  const clauses = [];
  const vals = [];
  if (companyId) { vals.push(parseInt(companyId, 10)); clauses.push(`i.company_id = $${vals.length}`); }
  if (status) { vals.push(status); clauses.push(`i.status = $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(`${INVOICE_SELECT} ${where} ORDER BY i.id DESC`, vals);
  res.json({ invoices: r.rows });
});

// Splits an invoice's amount between the two revenue accounts (4100 package / 4200 extra seats)
// by the ratio of the company's current subscription rates. Shared by recordInvoiceRevenueLedger
// (below) and postInvoiceJournalEntry (see "General journal" section) so the simple revenue-ledger
// linkage and the double-entry journal never disagree about how an invoice breaks down.
async function computeInvoiceRevenueSplit(client, companyId, amount) {
  const sub = await client.query(
    `SELECT custom_price, custom_seat_price, last_additional_users FROM subscriptions
     WHERE company_id=$1 ORDER BY id DESC LIMIT 1`, [companyId]
  );
  const packageRate = sub.rows[0] ? Number(sub.rows[0].custom_price) || 0 : 0;
  const extraSeats = sub.rows[0] ? Number(sub.rows[0].last_additional_users) || 0 : 0;
  const seatRate = sub.rows[0] ? Number(sub.rows[0].custom_seat_price) || 0 : 0;
  const extraRate = extraSeats * seatRate;
  const totalRate = packageRate + extraRate;
  const amountNum = Number(amount);
  const packageAmount = totalRate > 0 ? amountNum * (packageRate / totalRate) : amountNum;
  const extraAmount = totalRate > 0 ? amountNum * (extraRate / totalRate) : 0;
  return { packageAmount, extraAmount };
}

// Auto-links an invoice's amount to revenue accounts 4100 (package) / 4200 (extra seats). Not
// double-entry bookkeeping on its own — just enough linkage for a future P&L report to sum revenue
// by account. Shared by both normal invoice creation and quotation→invoice conversion, since both
// paths create an `invoices` row. See postInvoiceJournalEntry for the actual journal posting.
async function recordInvoiceRevenueLedger(client, invoiceId, companyId, amount) {
  const { packageAmount, extraAmount } = await computeInvoiceRevenueSplit(client, companyId, amount);

  const accounts = await client.query(`SELECT code FROM chart_of_accounts WHERE code IN ('4100','4200') AND is_active = true`);
  const accountCodes = new Set(accounts.rows.map(a => a.code));
  if (packageAmount > 0 && accountCodes.has('4100')) {
    await client.query(
      `INSERT INTO invoice_ledger_entries (invoice_id, account_code, amount) VALUES ($1,'4100',$2)`,
      [invoiceId, packageAmount]
    );
  }
  if (extraAmount > 0 && accountCodes.has('4200')) {
    await client.query(
      `INSERT INTO invoice_ledger_entries (invoice_id, account_code, amount) VALUES ($1,'4200',$2)`,
      [invoiceId, extraAmount]
    );
  }
}

// Books the invoice into the general journal: debit ลูกหนี้การค้า (1200) for the full amount,
// credit the same 4100/4200 revenue split recordInvoiceRevenueLedger uses. The package/extra-seat
// pair is rounded with a residual (round the smaller extraAmount, then derive packageAmount as
// amt - extra) rather than rounding both independently, so the two credit lines always sum to
// exactly `amt` — independent per-line rounding can be off by a cent and would make
// createJournalEntry's debit=credit check reject an otherwise-valid invoice.
// Swallows errors (e.g. 1200/4100/4200 missing or deactivated) so invoice creation itself never
// fails because of the journal — matches recordInvoiceRevenueLedger's existing skip-if-missing behavior.
// Wrapped in its own SAVEPOINT — `client` is shared with the invoice INSERT in the same transaction
// (see POST /api/admin/invoices below), so if createJournalEntry's INSERT ever fails at the DB level
// (not just its own clean pre-checks), that failure poisons the whole shared transaction; a plain
// try/catch would NOT actually protect the invoice row, since the eventual COMMIT would silently
// roll everything back. ROLLBACK TO SAVEPOINT undoes only the journal-posting attempt. (This exact
// failure mode was reproduced for real while building the client-ledger equivalent of this function
// — see project_client_ledger memory — which is why this fix was applied here too.)
async function postInvoiceJournalEntry(client, { invoiceId, invoiceNo, companyId, amount, issueDate, createdBy }) {
  await client.query('SAVEPOINT invoice_journal_post');
  try {
    const amt = round2(amount);
    const { extraAmount } = await computeInvoiceRevenueSplit(client, companyId, amt);
    const lines = [{ accountCode: '1200', debitAmount: amt, creditAmount: 0, description: `ลูกหนี้การค้า - ${invoiceNo}` }];
    if (extraAmount > 0) {
      const extra = round2(extraAmount);
      const pkg = round2(amt - extra);
      if (pkg > 0) lines.push({ accountCode: '4100', debitAmount: 0, creditAmount: pkg, description: `รายได้ค่าบริการแพ็กเกจ - ${invoiceNo}` });
      lines.push({ accountCode: '4200', debitAmount: 0, creditAmount: extra, description: `รายได้ค่าผู้ใช้งานเพิ่ม - ${invoiceNo}` });
    } else {
      lines.push({ accountCode: '4100', debitAmount: 0, creditAmount: amt, description: `รายได้ค่าบริการแพ็กเกจ - ${invoiceNo}` });
    }
    await createJournalEntry(client, {
      entryDate: issueDate, description: `ใบแจ้งหนี้ ${invoiceNo}`, sourceType: 'invoice', sourceId: invoiceId, createdBy, lines,
    });
    await client.query('RELEASE SAVEPOINT invoice_journal_post');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT invoice_journal_post');
    console.error(`[journal] Failed to post journal entry for invoice ${invoiceNo}:`, err.message);
  }
}

app.post('/api/admin/invoices', requireAdminAuth, async (req, res) => {
  const { companyId, packageId, amount, issueDate, dueDate, note } = req.body || {};
  if (!companyId || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณาเลือกบริษัทและกรอกจำนวนเงิน' });
  const company = await pool.query('SELECT 1 FROM customer_companies WHERE id=$1', [companyId]);
  if (company.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNo = await generateInvoiceNumber(client);
    const resolvedIssueDate = issueDate || new Date().toISOString().slice(0, 10);
    const insert = await client.query(
      `INSERT INTO invoices (invoice_no, company_id, package_id, amount, issue_date, due_date, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [invoiceNo, companyId, packageId || null, Number(amount), resolvedIssueDate, dueDate || null, (note || '').trim()]
    );
    const invoiceId = insert.rows[0].id;
    await recordInvoiceRevenueLedger(client, invoiceId, companyId, amount);
    await postInvoiceJournalEntry(client, { invoiceId, invoiceNo, companyId, amount, issueDate: resolvedIssueDate, createdBy: req.currentAdmin.id });

    await client.query('COMMIT');
    const r = await pool.query(`${INVOICE_SELECT} WHERE i.id=$1`, [invoiceId]);
    res.json({ invoice: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างใบแจ้งหนี้ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- Admin panel: รับชำระเงิน (receive payment against an invoice) ----------------
// Records one receipt of money against an invoice: inserts invoice_payments, recomputes the
// invoice's status from SUM(invoice_payments.amount) vs. invoices.amount ('paid' once fully
// covered, 'partial' otherwise), and posts the matching journal entry (debit 1100 เงินสด / credit
// 1200 ลูกหนี้การค้า). Shared by the dedicated POST /payments route below and by mark-paid (which
// now records a payment for the full remaining balance instead of just flipping status with no
// ledger entry — a quick-action bypassing the books would defeat the point of this whole system).
// Runs inside the caller's transaction; unlike postInvoiceJournalEntry/postExpenseJournalEntry this
// does NOT swallow journal errors — booking the cash receipt IS the point of calling this function,
// so a journal failure must roll back the whole payment, not leave one "recorded" with no entry.
// Errors carry a `.status` so callers can translate them straight to an HTTP response.
async function recordInvoicePayment(client, { invoiceId, amount, paymentDate, note, createdBy }) {
  const inv = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
  if (inv.rowCount === 0) { const e = new Error('ไม่พบใบแจ้งหนี้'); e.status = 404; throw e; }
  const invoice = inv.rows[0];
  if (invoice.status === 'cancelled') { const e = new Error('ใบแจ้งหนี้นี้ถูกยกเลิกแล้ว ไม่สามารถรับชำระได้'); e.status = 400; throw e; }

  const amt = round2(amount);
  if (amt <= 0) { const e = new Error('กรุณากรอกจำนวนเงินให้ถูกต้อง'); e.status = 400; throw e; }
  const receivedRes = await client.query('SELECT COALESCE(SUM(amount),0) AS total FROM invoice_payments WHERE invoice_id=$1', [invoiceId]);
  const alreadyReceived = round2(receivedRes.rows[0].total);
  const remaining = round2(Number(invoice.amount) - alreadyReceived);
  if (amt > remaining) { const e = new Error(`จำนวนเงินเกินยอดคงเหลือของใบแจ้งหนี้ (คงเหลือ ${remaining})`); e.status = 400; throw e; }

  const payRes = await client.query(
    `INSERT INTO invoice_payments (invoice_id, amount, payment_date, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [invoiceId, amt, paymentDate, (note || '').trim(), createdBy || null]
  );
  const paymentId = payRes.rows[0].id;

  const newStatus = round2(alreadyReceived + amt) >= round2(invoice.amount) ? 'paid' : 'partial';
  await client.query('UPDATE invoices SET status=$1 WHERE id=$2', [newStatus, invoiceId]);

  await createJournalEntry(client, {
    entryDate: paymentDate,
    description: `รับชำระเงิน - ${invoice.invoice_no}`,
    sourceType: 'payment',
    sourceId: paymentId,
    createdBy,
    lines: [
      { accountCode: '1100', debitAmount: amt, creditAmount: 0, description: 'เงินสด' },
      { accountCode: '1200', debitAmount: 0, creditAmount: amt, description: `ลูกหนี้การค้า - ${invoice.invoice_no}` },
    ],
  });

  return { paymentId, newStatus, remaining: round2(remaining - amt) };
}

app.post('/api/admin/invoices/:id/payments', requireAdminAuth, async (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  const { amount, paymentDate, note } = req.body || {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recordInvoicePayment(client, {
      invoiceId, amount: Number(amount), paymentDate: paymentDate || new Date().toISOString().slice(0, 10),
      note, createdBy: req.currentAdmin.id,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'บันทึกรับชำระเงินไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const updated = await pool.query(`${INVOICE_SELECT} WHERE i.id=$1`, [invoiceId]);
  res.json({ invoice: updated.rows[0] });
});

app.get('/api/admin/invoices/:id/payments', requireAdminAuth, async (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  const r = await pool.query(
    `SELECT ip.id, ip.amount, to_char(ip.payment_date,'YYYY-MM-DD') AS "paymentDate", ip.note,
       ip.created_by AS "createdBy", pa.name AS "createdByName", ip.created_at AS "createdAt"
     FROM invoice_payments ip
     LEFT JOIN platform_admins pa ON pa.id = ip.created_by
     WHERE ip.invoice_id=$1 ORDER BY ip.id`, [invoiceId]
  );
  res.json({ payments: r.rows });
});

app.post('/api/admin/invoices/:id/mark-paid', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT amount FROM invoices WHERE id=$1 FOR UPDATE', [id]);
    if (inv.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' }); }
    const receivedRes = await client.query('SELECT COALESCE(SUM(amount),0) AS total FROM invoice_payments WHERE invoice_id=$1', [id]);
    const remaining = round2(Number(inv.rows[0].amount) - round2(receivedRes.rows[0].total));
    if (remaining <= 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ใบแจ้งหนี้นี้ชำระครบแล้ว' }); }
    await recordInvoicePayment(client, {
      invoiceId: id, amount: remaining, paymentDate: new Date().toISOString().slice(0, 10),
      note: 'ชำระแล้ว (บันทึกด่วน)', createdBy: req.currentAdmin.id,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'ทำรายการไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const updated = await pool.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id]);
  res.json({ invoice: updated.rows[0] });
});

app.post('/api/admin/invoices/:id/cancel', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const received = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM invoice_payments WHERE invoice_id=$1', [id]);
  if (Number(received.rows[0].total) > 0) return res.status(409).json({ error: 'ใบแจ้งหนี้นี้มีการรับชำระเงินแล้ว ไม่สามารถยกเลิกได้' });
  const r = await pool.query(`UPDATE invoices SET status='cancelled' WHERE id=$1 RETURNING id`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });
  const updated = await pool.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id]);
  res.json({ invoice: updated.rows[0] });
});

// ---------------- Admin panel: payment slip evidence (หลักฐานการชำระเงิน) ----------------
// Stored under server/uploads/slips, which is only reachable through the authenticated
// /api/admin/slips/:id/file route below — never through express.static (see the /server block above).
const SLIPS_DIR = path.join(__dirname, 'uploads', 'slips');
fs.mkdirSync(SLIPS_DIR, { recursive: true });

const ALLOWED_SLIP_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const slipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SLIPS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_SLIP_MIME.has(file.mimetype)),
});
function uploadSlipMiddleware(req, res, next) {
  slipUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ' });
    next();
  });
}

app.get('/api/admin/invoices/:id/slips', requireAdminAuth, async (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  const r = await pool.query(
    `SELECT id, file_name AS "fileName", mime_type AS "mimeType", uploaded_at AS "uploadedAt"
     FROM payment_slips WHERE invoice_id=$1 ORDER BY id DESC`, [invoiceId]);
  res.json({ slips: r.rows });
});

app.post('/api/admin/invoices/:id/slips', requireAdminAuth, uploadSlipMiddleware, async (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์สลิป (jpg, png, webp, pdf ขนาดไม่เกิน 5MB)' });
  const invoice = await pool.query('SELECT 1 FROM invoices WHERE id=$1', [invoiceId]);
  if (invoice.rowCount === 0) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });
  }
  const r = await pool.query(
    `INSERT INTO payment_slips (invoice_id, file_name, stored_name, mime_type)
     VALUES ($1,$2,$3,$4) RETURNING id, file_name AS "fileName", mime_type AS "mimeType", uploaded_at AS "uploadedAt"`,
    [invoiceId, req.file.originalname, req.file.filename, req.file.mimetype]
  );
  res.json({ slip: r.rows[0] });
});

app.get('/api/admin/slips/:id/file', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT * FROM payment_slips WHERE id=$1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบไฟล์สลิป' });
  const slip = r.rows[0];
  res.setHeader('Content-Type', slip.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(slip.file_name)}"`);
  res.sendFile(path.join(SLIPS_DIR, slip.stored_name));
});

app.delete('/api/admin/slips/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM payment_slips WHERE id=$1 RETURNING stored_name', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบไฟล์สลิป' });
  fs.unlink(path.join(SLIPS_DIR, r.rows[0].stored_name), () => {});
  res.json({ ok: true });
});

// ---------------- Admin panel: quotations (ใบเสนอราคา) ----------------
async function generateQuotationNumber(client) {
  const year = new Date().getFullYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await client.query('SELECT COUNT(*)::int AS n FROM quotations');
    const no = `QT-${year}-` + String(countRes.rows[0].n + 1 + attempt).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM quotations WHERE quotation_no=$1', [no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบเสนอราคาได้');
}

const QUOTATION_SELECT = `
  SELECT q.id, q.quotation_no AS "quotationNo", q.company_id AS "companyId",
    COALESCE(NULLIF(q.company_name,''), c.name) AS "companyName",
    COALESCE(NULLIF(q.phone,''), c.phone) AS "companyPhone",
    COALESCE(NULLIF(q.fax,''), c.fax) AS "companyFax",
    c.tax_id AS "companyTaxId",
    COALESCE(NULLIF(q.address,''), c.address) AS "companyAddress",
    COALESCE(NULLIF(q.email,''), c.email) AS "companyEmail",
    q.contact_name AS "contactName",
    c.default_quote_validity_days AS "defaultQuoteValidityDays",
    to_char(q.issue_date,'YYYY-MM-DD') AS "issueDate", to_char(q.valid_until,'YYYY-MM-DD') AS "validUntil",
    q.status, q.note, q.converted_invoice_id AS "convertedInvoiceId", q.created_at AS "createdAt",
    COALESCE((SELECT SUM(qi.qty * qi.unit_price - qi.discount) FROM quotation_items qi WHERE qi.quotation_id = q.id), 0) AS "totalAmount"
  FROM quotations q
  JOIN customer_companies c ON c.id = q.company_id`;

app.get('/api/admin/quotations', requireAdminAuth, async (req, res) => {
  const { companyId, status } = req.query || {};
  const clauses = [];
  const vals = [];
  if (companyId) { vals.push(parseInt(companyId, 10)); clauses.push(`q.company_id = $${vals.length}`); }
  if (status) { vals.push(status); clauses.push(`q.status = $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(`${QUOTATION_SELECT} ${where} ORDER BY q.id DESC`, vals);
  res.json({ quotations: r.rows });
});

app.get('/api/admin/quotations/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const q = await pool.query(`${QUOTATION_SELECT} WHERE q.id=$1`, [id]);
  if (q.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' });
  const items = await pool.query(
    `SELECT qi.id, qi.product_id AS "productId", p.name AS "productName", qi.description, qi.qty, qi.unit,
       qi.unit_price AS "unitPrice", qi.discount, qi.idx
     FROM quotation_items qi LEFT JOIN products p ON p.id = qi.product_id
     WHERE qi.quotation_id=$1 ORDER BY qi.idx`, [id]
  );
  res.json({ quotation: q.rows[0], items: items.rows });
});

app.post('/api/admin/quotations', requireAdminAuth, async (req, res) => {
  const { companyId, contactName, companyName, address, phone, fax, email, issueDate, validUntil, note, items } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'กรุณาเลือกบริษัท' });
  if (!Array.isArray(items) || items.filter(it => it.description && it.description.trim()).length === 0) {
    return res.status(400).json({ error: 'กรุณาเพิ่มรายการอย่างน้อย 1 รายการ' });
  }
  const company = await pool.query('SELECT 1 FROM customer_companies WHERE id=$1', [companyId]);
  if (company.rowCount === 0) return res.status(404).json({ error: 'ไม่พบบริษัทลูกค้า' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quotationNo = await generateQuotationNumber(client);
    const insert = await client.query(
      `INSERT INTO quotations (quotation_no, company_id, contact_name, company_name, address, phone, fax, email, issue_date, valid_until, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [quotationNo, companyId, (contactName || '').trim(), (companyName || '').trim(), (address || '').trim(),
       (phone || '').trim(), (fax || '').trim(), (email || '').trim(),
       issueDate || new Date().toISOString().slice(0, 10), validUntil || null, (note || '').trim()]
    );
    const quotationId = insert.rows[0].id;
    let idx = 0;
    for (const it of items) {
      if (!it.description || !it.description.trim()) continue;
      await client.query(
        `INSERT INTO quotation_items (quotation_id, product_id, description, qty, unit, unit_price, discount, idx) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [quotationId, it.productId || null, it.description.trim(), Number(it.qty) || 1, (it.unit || '').trim(), Number(it.unitPrice) || 0, Number(it.discount) || 0, idx++]
      );
    }
    await client.query('COMMIT');
    const q = await pool.query(`${QUOTATION_SELECT} WHERE q.id=$1`, [quotationId]);
    res.json({ quotation: q.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างใบเสนอราคาไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.put('/api/admin/quotations/:id', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { companyId, contactName, companyName, address, phone, fax, email, issueDate, validUntil, note, status, items } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'กรุณาเลือกบริษัท' });
  if (!Array.isArray(items) || items.filter(it => it.description && it.description.trim()).length === 0) {
    return res.status(400).json({ error: 'กรุณาเพิ่มรายการอย่างน้อย 1 รายการ' });
  }
  const existing = await pool.query('SELECT converted_invoice_id FROM quotations WHERE id=$1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' });
  if (existing.rows[0].converted_invoice_id) return res.status(409).json({ error: 'ใบเสนอราคานี้ถูกแปลงเป็นใบแจ้งหนี้แล้ว แก้ไขไม่ได้' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE quotations SET company_id=$1, contact_name=$2, company_name=$3, address=$4, phone=$5, fax=$6, email=$7,
         issue_date=$8, valid_until=$9, note=$10, status=$11 WHERE id=$12`,
      [companyId, (contactName || '').trim(), (companyName || '').trim(), (address || '').trim(),
       (phone || '').trim(), (fax || '').trim(), (email || '').trim(),
       issueDate || new Date().toISOString().slice(0, 10), validUntil || null, (note || '').trim(), status || 'draft', id]
    );
    await client.query('DELETE FROM quotation_items WHERE quotation_id=$1', [id]);
    let idx = 0;
    for (const it of items) {
      if (!it.description || !it.description.trim()) continue;
      await client.query(
        `INSERT INTO quotation_items (quotation_id, product_id, description, qty, unit, unit_price, discount, idx) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, it.productId || null, it.description.trim(), Number(it.qty) || 1, (it.unit || '').trim(), Number(it.unitPrice) || 0, Number(it.discount) || 0, idx++]
      );
    }
    await client.query('COMMIT');
    const q = await pool.query(`${QUOTATION_SELECT} WHERE q.id=$1`, [id]);
    res.json({ quotation: q.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกใบเสนอราคาไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/quotations/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM quotations WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

app.post('/api/admin/quotations/:id/convert-to-invoice', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM quotations WHERE id=$1 FOR UPDATE', [id]);
    if (q.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' }); }
    if (q.rows[0].converted_invoice_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ใบเสนอราคานี้ถูกแปลงเป็นใบแจ้งหนี้แล้ว' }); }
    const itemsRes = await client.query('SELECT qty, unit_price, discount FROM quotation_items WHERE quotation_id=$1', [id]);
    const amount = itemsRes.rows.reduce((sum, it) => sum + (Number(it.qty) * Number(it.unit_price) - Number(it.discount)), 0);
    if (amount <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ใบเสนอราคานี้ยังไม่มีรายการ' }); }
    const invoiceNo = await generateInvoiceNumber(client);
    const insert = await client.query(
      `INSERT INTO invoices (invoice_no, company_id, package_id, amount, issue_date, due_date, note)
       VALUES ($1,$2,NULL,$3,CURRENT_DATE,NULL,$4) RETURNING id`,
      [invoiceNo, q.rows[0].company_id, amount, `แปลงจากใบเสนอราคา ${q.rows[0].quotation_no}`]
    );
    const invoiceId = insert.rows[0].id;
    await recordInvoiceRevenueLedger(client, invoiceId, q.rows[0].company_id, amount);
    await postInvoiceJournalEntry(client, {
      invoiceId, invoiceNo, companyId: q.rows[0].company_id, amount,
      issueDate: new Date().toISOString().slice(0, 10), createdBy: req.currentAdmin.id,
    });
    await client.query(`UPDATE quotations SET converted_invoice_id=$1, status='accepted' WHERE id=$2`, [invoiceId, id]);
    await client.query('COMMIT');
    const r = await pool.query(`${INVOICE_SELECT} WHERE i.id=$1`, [invoiceId]);
    res.json({ invoice: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แปลงเป็นใบแจ้งหนี้ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- Admin panel: expenses (รายจ่าย) ----------------
const RECEIPTS_DIR = path.join(__dirname, 'uploads', 'receipts');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

const ALLOWED_RECEIPT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECEIPTS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_RECEIPT_MIME.has(file.mimetype)),
});
function uploadReceiptMiddleware(req, res, next) {
  receiptUpload.single('receipt')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ' });
    next();
  });
}

const EXPENSE_SELECT = `
  SELECT e.id, e.category_code AS "categoryCode", coa.name AS "categoryName",
    e.description, e.amount, to_char(e.expense_date,'YYYY-MM-DD') AS "expenseDate",
    e.receipt_file AS "receiptFile", e.payment_status AS "paymentStatus",
    e.created_by AS "createdBy", pa.name AS "createdByName",
    e.created_at AS "createdAt"
  FROM expenses e
  LEFT JOIN chart_of_accounts coa ON coa.code = e.category_code
  LEFT JOIN platform_admins pa ON pa.id = e.created_by`;

app.get('/api/admin/expenses', requireAdminAuth, async (req, res) => {
  const { from, to } = req.query || {};
  const clauses = [];
  const vals = [];
  if (from) { vals.push(from); clauses.push(`e.expense_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`e.expense_date <= $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(`${EXPENSE_SELECT} ${where} ORDER BY e.expense_date DESC, e.id DESC`, vals);
  res.json({ expenses: r.rows });
});

async function validateExpenseCategory(categoryCode) {
  if (!categoryCode) return null;
  const r = await pool.query('SELECT category FROM chart_of_accounts WHERE code=$1', [categoryCode]);
  if (r.rowCount === 0) throw new Error('ไม่พบรหัสบัญชี');
  if (r.rows[0].category !== 'expense') throw new Error('กรุณาเลือกบัญชีในหมวดค่าใช้จ่ายเท่านั้น');
  return categoryCode;
}

function normalizeExpensePaymentStatus(v) { return v === 'unpaid' ? 'unpaid' : 'paid'; }

// Books an expense into the general journal: debit its category account (5xxx), credit either
// เงินสด (1100, paymentStatus='paid') or เจ้าหนี้การค้า (2100, paymentStatus='unpaid') depending on
// how it was recorded. Runs in its own transaction (the expense insert above it isn't itself
// transactional) and never throws — a missing/deactivated category or credit account just means the
// expense is saved without a journal entry, logged as a warning. See markExpensePaid for how an
// unpaid expense's 2100 balance later gets cleared when it's actually paid.
async function postExpenseJournalEntry({ expenseId, categoryCode, description, amount, expenseDate, createdBy, paymentStatus }) {
  if (!categoryCode) {
    console.warn(`[journal] Expense ${expenseId} has no category account — skipped journal entry.`);
    return;
  }
  const creditAccountCode = paymentStatus === 'unpaid' ? '2100' : '1100';
  const creditDescription = paymentStatus === 'unpaid' ? 'เจ้าหนี้การค้า' : 'เงินสด';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const amt = round2(amount);
    await createJournalEntry(client, {
      entryDate: expenseDate,
      description: `รายจ่าย: ${description}`,
      sourceType: 'expense',
      sourceId: expenseId,
      createdBy,
      lines: [
        { accountCode: categoryCode, debitAmount: amt, creditAmount: 0, description },
        { accountCode: creditAccountCode, debitAmount: 0, creditAmount: amt, description: creditDescription },
      ],
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[journal] Failed to post journal entry for expense ${expenseId}:`, err.message);
  } finally {
    client.release();
  }
}

app.post('/api/admin/expenses', requireAdminAuth, uploadReceiptMiddleware, async (req, res) => {
  const { categoryCode, description, amount, expenseDate, paymentStatus } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียดค่าใช้จ่าย' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  let safeCategoryCode;
  try {
    safeCategoryCode = await validateExpenseCategory(categoryCode);
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: err.message });
  }
  const resolvedExpenseDate = expenseDate || new Date().toISOString().slice(0, 10);
  const safePaymentStatus = normalizeExpensePaymentStatus(paymentStatus);
  const r = await pool.query(
    `INSERT INTO expenses (category_code, description, amount, expense_date, receipt_file, created_by, payment_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [safeCategoryCode, description.trim(), Number(amount), resolvedExpenseDate,
     req.file ? req.file.filename : null, req.currentAdmin.id, safePaymentStatus]
  );
  await postExpenseJournalEntry({
    expenseId: r.rows[0].id, categoryCode: safeCategoryCode, description: description.trim(),
    amount: Number(amount), expenseDate: resolvedExpenseDate, createdBy: req.currentAdmin.id,
    paymentStatus: safePaymentStatus,
  });
  const e = await pool.query(`${EXPENSE_SELECT} WHERE e.id=$1`, [r.rows[0].id]);
  res.json({ expense: e.rows[0] });
});

app.put('/api/admin/expenses/:id', requireAdminAuth, uploadReceiptMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { categoryCode, description, amount, expenseDate, paymentStatus } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียดค่าใช้จ่าย' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  const existing = await pool.query('SELECT receipt_file, payment_status FROM expenses WHERE id=$1', [id]);
  if (existing.rowCount === 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'ไม่พบรายการค่าใช้จ่าย' });
  }
  // payment_status must never change through this general edit route — it's what decides which
  // account (1100/2100) the journal entry credits, so changing it here would silently desync the
  // expense from its already-posted journal entry. Only /api/admin/expenses/:id/mark-paid may
  // flip it, since that route also posts the matching settlement journal entry. A request that
  // doesn't mention paymentStatus at all (the normal edit-form submission, since the field is
  // disabled there) is fine — only an explicit attempt to change it is rejected.
  if (paymentStatus !== undefined && normalizeExpensePaymentStatus(paymentStatus) !== existing.rows[0].payment_status) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ไม่สามารถเปลี่ยนสถานะการจ่ายผ่านฟอร์มแก้ไขทั่วไปได้ กรุณาใช้หน้า "จ่ายชำระเจ้าหนี้" แทน' });
  }
  let safeCategoryCode;
  try {
    safeCategoryCode = await validateExpenseCategory(categoryCode);
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: err.message });
  }
  const newReceiptFile = req.file ? req.file.filename : existing.rows[0].receipt_file;
  // Note: editing does not touch journal_entries (it never did, even before payment_status
  // existed) — amount/category changes here won't retroactively adjust whatever journal entry was
  // posted at creation time. payment_status itself is preserved as-is (see guard above).
  const r = await pool.query(
    `UPDATE expenses SET category_code=$1, description=$2, amount=$3, expense_date=$4, receipt_file=$5 WHERE id=$6 RETURNING id`,
    [safeCategoryCode, description.trim(), Number(amount), expenseDate || new Date().toISOString().slice(0, 10),
     newReceiptFile, id]
  );
  if (req.file && existing.rows[0].receipt_file) {
    fs.unlink(path.join(RECEIPTS_DIR, existing.rows[0].receipt_file), () => {});
  }
  const e = await pool.query(`${EXPENSE_SELECT} WHERE e.id=$1`, [r.rows[0].id]);
  res.json({ expense: e.rows[0] });
});

app.delete('/api/admin/expenses/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING receipt_file', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการค่าใช้จ่าย' });
  if (r.rows[0].receipt_file) fs.unlink(path.join(RECEIPTS_DIR, r.rows[0].receipt_file), () => {});
  res.json({ ok: true });
});

// ---------------- Admin panel: จ่ายชำระเจ้าหนี้ (settle unpaid expenses) ----------------
// Marks an unpaid expense as paid and books the settlement: debit 2100 (เจ้าหนี้การค้า) to clear
// the payable, credit 1100 (เงินสด) for the actual cash outflow happening now. Unlike
// postExpenseJournalEntry (which swallows errors so an expense can always be saved), this route
// lets a journal failure fail the whole request — marking something "paid" without a journal entry
// to back it up would leave the books wrong with no way to tell from the UI, so an admin should see
// the error and retry rather than the payment silently going unrecorded.
app.post('/api/admin/expenses/:id/mark-paid', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exp = await client.query('SELECT * FROM expenses WHERE id=$1 FOR UPDATE', [id]);
    if (exp.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบรายการค่าใช้จ่าย' }); }
    if (exp.rows[0].payment_status !== 'unpaid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'รายการนี้จ่ายชำระแล้ว' });
    }
    await client.query(`UPDATE expenses SET payment_status='paid' WHERE id=$1`, [id]);
    const amt = round2(exp.rows[0].amount);
    await createJournalEntry(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      description: `จ่ายชำระเจ้าหนี้: ${exp.rows[0].description}`,
      sourceType: 'payment',
      sourceId: id,
      createdBy: req.currentAdmin.id,
      lines: [
        { accountCode: '2100', debitAmount: amt, creditAmount: 0, description: `เจ้าหนี้การค้า - ${exp.rows[0].description}` },
        { accountCode: '1100', debitAmount: 0, creditAmount: amt, description: 'เงินสด' },
      ],
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[journal] Failed to settle payable for expense', id, err);
    return res.status(500).json({ error: err.message || 'จ่ายชำระไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const e = await pool.query(`${EXPENSE_SELECT} WHERE e.id=$1`, [id]);
  res.json({ expense: e.rows[0] });
});

app.get('/api/admin/expenses/:id/receipt', requireAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT receipt_file FROM expenses WHERE id=$1', [id]);
  if (r.rowCount === 0 || !r.rows[0].receipt_file) return res.status(404).json({ error: 'ไม่พบไฟล์ใบเสร็จ' });
  res.sendFile(path.join(RECEIPTS_DIR, r.rows[0].receipt_file));
});

// ---------------- Admin panel: general journal (สมุดรายวัน) ----------------
// Read-only listing for the "สมุดรายวัน" page — every journal_entries header with its lines
// nested underneath, filterable by date range and source_type. Entries themselves are only ever
// written by createJournalEntry() (see the "General journal" core section above).
app.get('/api/admin/journal-entries', requireAdminAuth, async (req, res) => {
  const { from, to, sourceType } = req.query || {};
  const clauses = [];
  const vals = [];
  if (from) { vals.push(from); clauses.push(`je.entry_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`je.entry_date <= $${vals.length}`); }
  if (sourceType) { vals.push(sourceType); clauses.push(`je.source_type = $${vals.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const entriesRes = await pool.query(
    `SELECT je.id, to_char(je.entry_date,'YYYY-MM-DD') AS "entryDate", je.description,
       je.source_type AS "sourceType", je.source_id AS "sourceId",
       je.created_by AS "createdBy", pa.name AS "createdByName", je.created_at AS "createdAt"
     FROM journal_entries je
     LEFT JOIN platform_admins pa ON pa.id = je.created_by
     ${where}
     ORDER BY je.entry_date DESC, je.id DESC`, vals
  );
  const ids = entriesRes.rows.map(r => r.id);
  const linesByEntry = {};
  if (ids.length) {
    const linesRes = await pool.query(
      `SELECT jel.journal_entry_id AS "journalEntryId", jel.account_code AS "accountCode",
         coa.name AS "accountName", jel.debit_amount AS "debitAmount", jel.credit_amount AS "creditAmount",
         jel.description
       FROM journal_entry_lines jel
       LEFT JOIN chart_of_accounts coa ON coa.code = jel.account_code
       WHERE jel.journal_entry_id = ANY($1)
       ORDER BY jel.id`, [ids]
    );
    for (const l of linesRes.rows) {
      (linesByEntry[l.journalEntryId] ||= []).push(l);
    }
  }
  const entries = entriesRes.rows.map(e => {
    const lines = linesByEntry[e.id] || [];
    const totalDebit = lines.reduce((sum, l) => sum + Number(l.debitAmount), 0);
    const totalCredit = lines.reduce((sum, l) => sum + Number(l.creditAmount), 0);
    return { ...e, lines, totalDebit, totalCredit };
  });
  res.json({ entries });
});

// ---------------- Admin panel: reports (รายงาน) ----------------
// All three reports are computed on the fly from invoices/expenses/chart_of_accounts —
// no new tables, per the requested scope.

app.get('/api/admin/reports/profit-loss', requireAdminAuth, async (req, res) => {
  const from = req.query.from || `${new Date().getFullYear()}-01-01`;
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const revenueRes = await pool.query(
    `SELECT to_char(date_trunc('month', issue_date), 'YYYY-MM') AS month, SUM(amount)::float AS revenue
     FROM invoices WHERE status <> 'cancelled' AND issue_date BETWEEN $1 AND $2
     GROUP BY 1`, [from, to]
  );
  const expenseRes = await pool.query(
    `SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS month, SUM(amount)::float AS expenses
     FROM expenses WHERE expense_date BETWEEN $1 AND $2
     GROUP BY 1`, [from, to]
  );
  const byMonth = {};
  for (const r of revenueRes.rows) byMonth[r.month] = { month: r.month, revenue: r.revenue, expenses: 0 };
  for (const r of expenseRes.rows) {
    if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, revenue: 0, expenses: 0 };
    byMonth[r.month].expenses = r.expenses;
  }
  const months = Object.values(byMonth)
    .map(m => ({ ...m, net: m.revenue - m.expenses }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const totals = months.reduce((acc, m) => ({
    revenue: acc.revenue + m.revenue, expenses: acc.expenses + m.expenses, net: acc.net + m.net,
  }), { revenue: 0, expenses: 0, net: 0 });
  res.json({ from, to, months, totals });
});

app.get('/api/admin/reports/receivables-aging', requireAdminAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT i.id, i.invoice_no AS "invoiceNo", c.name AS "companyName", i.amount,
      to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate", to_char(i.due_date,'YYYY-MM-DD') AS "dueDate", i.status,
      CASE WHEN i.due_date IS NOT NULL THEN (CURRENT_DATE - i.due_date) ELSE NULL END AS "daysOverdue"
    FROM invoices i JOIN customer_companies c ON c.id = i.company_id
    WHERE i.status IN ('unpaid','overdue')
    ORDER BY "daysOverdue" DESC NULLS LAST`
  );
  const totalOutstanding = r.rows.reduce((sum, row) => sum + Number(row.amount), 0);
  res.json({ invoices: r.rows, totalOutstanding });
});

// Preliminary VAT summary (ภ.พ.30 prep) — no explicit VAT field is stored on invoices, so this
// assumes the standard 7% rate and treats `amount` as VAT-inclusive (netSales = amount / 1.07).
// Flagged as an assumption, not a filed/certified figure — meant as a starting point only.
app.get('/api/admin/reports/vat', requireAdminAuth, async (req, res) => {
  const from = req.query.from || `${new Date().getFullYear()}-01-01`;
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const VAT_RATE = 0.07;
  const r = await pool.query(
    `SELECT to_char(date_trunc('month', issue_date), 'YYYY-MM') AS month, SUM(amount)::float AS "totalSales"
     FROM invoices WHERE status <> 'cancelled' AND issue_date BETWEEN $1 AND $2
     GROUP BY 1 ORDER BY 1`, [from, to]
  );
  const months = r.rows.map(row => {
    const netSales = row.totalSales / (1 + VAT_RATE);
    const vatAmount = row.totalSales - netSales;
    return { month: row.month, totalSales: row.totalSales, netSales, vatAmount };
  });
  const totals = months.reduce((acc, m) => ({
    totalSales: acc.totalSales + m.totalSales, netSales: acc.netSales + m.netSales, vatAmount: acc.vatAmount + m.vatAmount,
  }), { totalSales: 0, netSales: 0, vatAmount: 0 });
  res.json({ from, to, vatRate: VAT_RATE, months, totals });
});

// ---------------- Admin panel: settings ----------------
app.get('/api/admin/settings', requireAdminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM platform_settings ORDER BY id LIMIT 1');
  res.json({ settings: r.rows[0] || null });
});

app.put('/api/admin/settings', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const { companyName, logoUrl, address, contactEmail, contactPhone, taxId, contactFax } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อบริษัท' });
  const existing = await pool.query('SELECT id FROM platform_settings ORDER BY id LIMIT 1');
  let r;
  if (existing.rowCount === 0) {
    r = await pool.query(
      `INSERT INTO platform_settings (company_name, logo_url, address, contact_email, contact_phone, tax_id, contact_fax)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [companyName.trim(), (logoUrl || '').trim(), (address || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(), (taxId || '').trim(), (contactFax || '').trim()]
    );
  } else {
    r = await pool.query(
      `UPDATE platform_settings SET company_name=$1, logo_url=$2, address=$3, contact_email=$4, contact_phone=$5, tax_id=$6, contact_fax=$7 WHERE id=$8 RETURNING *`,
      [companyName.trim(), (logoUrl || '').trim(), (address || '').trim(), (contactEmail || '').trim(), (contactPhone || '').trim(), (taxId || '').trim(), (contactFax || '').trim(), existing.rows[0].id]
    );
  }
  res.json({ settings: r.rows[0] });
});

// ---------------- Admin panel: data export ----------------
function toCsv(columns, rows) {
  const escapeCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(c => escapeCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => escapeCell(row[c.key])).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

app.get('/api/admin/export/companies', requireAdminAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT c.name AS company_name, c.tax_id, c.phone AS company_phone, c.email AS company_email,
      c.address, c.status AS company_status, p.name AS package_name,
      cu.name AS contact_name, cu.email AS contact_email, cu.phone AS contact_phone,
      cu.position AS contact_position, cu.status AS contact_status
    FROM customer_companies c
    LEFT JOIN packages p ON p.id = c.package_id
    LEFT JOIN customers cu ON cu.company_id = c.id
    ORDER BY c.id, cu.id`);
  const csv = toCsv([
    { key: 'company_name', label: 'บริษัท' },
    { key: 'tax_id', label: 'เลขผู้เสียภาษี' },
    { key: 'company_phone', label: 'โทรศัพท์บริษัท' },
    { key: 'company_email', label: 'อีเมลบริษัท' },
    { key: 'address', label: 'ที่อยู่' },
    { key: 'company_status', label: 'สถานะบริษัท' },
    { key: 'package_name', label: 'แพ็กเกจ' },
    { key: 'contact_name', label: 'ชื่อผู้ติดต่อ' },
    { key: 'contact_email', label: 'อีเมลผู้ติดต่อ' },
    { key: 'contact_phone', label: 'โทรศัพท์ผู้ติดต่อ' },
    { key: 'contact_position', label: 'ตำแหน่ง' },
    { key: 'contact_status', label: 'สถานะผู้ติดต่อ' },
  ], r.rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="customer-companies.csv"');
  res.send(csv);
});

app.get('/api/admin/export/invoices', requireAdminAuth, async (req, res) => {
  const r = await pool.query(`${INVOICE_SELECT} ORDER BY i.id DESC`);
  const csv = toCsv([
    { key: 'invoiceNo', label: 'เลขที่ใบแจ้งหนี้' },
    { key: 'companyName', label: 'บริษัท' },
    { key: 'packageName', label: 'แพ็กเกจ' },
    { key: 'amount', label: 'จำนวนเงิน' },
    { key: 'issueDate', label: 'วันที่ออก' },
    { key: 'dueDate', label: 'ครบกำหนด' },
    { key: 'status', label: 'สถานะ' },
    { key: 'note', label: 'หมายเหตุ' },
  ], r.rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
  res.send(csv);
});

// ---------------- Customer: client ledger — รายจ่าย (project costs / office expenses) ----------------
// Real, company-scoped replacement for pr-system.html's client-side-only DB.costs/DB.officeExpenses
// (see project_client_ledger memory). Every route below derives companyId from req.customer.company_id
// (set by requireCustomerAuth from the verified session) and NEVER accepts a company id from the
// request itself — the strongest form of the "always check company_id matches whoever's logged in"
// requirement, since there's simply no company id in the request for a caller to spoof.
//
// Category -> GL account mapping is intentionally coarser than the UI's category list: several
// DB.costs categories (machinery/fuel/transport/rental) and all DB.officeExpenses categories share
// one broader account each rather than getting a dedicated code apiece — the seeded starter chart of
// accounts (see seedDefaultClientChartOfAccounts) is a small starting set, not meant to have a
// 1:1 account per UI category. The specific category is still preserved in each row and journal
// line's description, so no information is lost, just not broken out into separate GL accounts.
const PROJECT_COST_CATEGORY_ACCOUNT = {
  material: '5100', subcontractor: '5200', labor: '5400',
  machinery: '5900', fuel: '5900', transport: '5900', rental: '5900',
};
const OFFICE_EXPENSE_ACCOUNT_CODE = '5300';

function serializeProjectCost(row) {
  return {
    id: row.id, projectId: row.project_id, category: row.category, description: row.description,
    costDate: row.cost_date, amount: Number(row.amount), vendor: row.vendor, workCode: row.work_code,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
function serializeOfficeExpense(row) {
  return {
    id: row.id, category: row.category, description: row.description,
    expenseDate: row.expense_date, amount: Number(row.amount),
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

// Posts a project cost / office expense into the client ledger: debit the mapped expense account,
// credit 1100 เงินสด (always cash-basis for now — no unpaid/accounts-payable tracking for this
// module yet, matching how admin-panel's own expenses module started before payment_status was
// added later as a separate follow-up). Swallows errors (logs + continues) so saving the cost/expense
// record itself never fails because of the ledger — this is a record-creation action, not a
// settlement action, matching the create-vs-settle distinction used throughout this codebase.
//
// Wrapped in its own SAVEPOINT because `client` is shared with the caller's own INSERT (the cost/
// expense row) in the SAME transaction: if createClientJournalEntry's INSERT ever fails at the DB
// level (not just its own clean pre-checks — e.g. a CHECK-constraint mismatch), that failure poisons
// the whole shared transaction, and a plain try/catch here would NOT actually protect the primary
// row — the subsequent COMMIT would silently roll everything back, including the cost/expense insert
// that already "succeeded". ROLLBACK TO SAVEPOINT undoes only the journal-posting attempt, leaving
// the rest of the transaction healthy. (Confirmed this failure mode is real, not theoretical, while
// testing this module — see project_client_ledger memory.)
async function postClientExpenseJournalEntry(client, { companyId, sourceType, sourceId, projectId, accountCode, description, amount, entryDate, createdBy }) {
  await client.query('SAVEPOINT client_journal_post');
  try {
    const amt = round2(amount);
    await createClientJournalEntry(client, {
      companyId, entryDate, description, sourceType, sourceId, projectId, createdBy,
      lines: [
        { accountCode, debitAmount: amt, creditAmount: 0, description },
        { accountCode: '1100', debitAmount: 0, creditAmount: amt, description: 'เงินสด' },
      ],
    });
    await client.query('RELEASE SAVEPOINT client_journal_post');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT client_journal_post');
    console.error(`[client-journal] Failed to post journal entry for company ${companyId} ${sourceType} (source ${sourceId}):`, err.message);
  }
}

app.get('/api/customer/project-costs', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { projectId, from, to } = req.query || {};
  const clauses = ['company_id=$1'];
  const vals = [companyId];
  if (projectId) { vals.push(parseInt(projectId, 10)); clauses.push(`project_id = $${vals.length}`); }
  if (from) { vals.push(from); clauses.push(`cost_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`cost_date <= $${vals.length}`); }
  const r = await pool.query(
    `SELECT id, project_id, category, description, to_char(cost_date,'YYYY-MM-DD') AS cost_date, amount, vendor, work_code, created_by, created_at
     FROM client_project_costs WHERE ${clauses.join(' AND ')} ORDER BY cost_date DESC, id DESC`, vals
  );
  res.json({ costs: r.rows.map(serializeProjectCost) });
});

app.post('/api/customer/project-costs', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { projectId, category, description, costDate, amount, vendor, workCode } = req.body || {};
  if (!category || !PROJECT_COST_CATEGORY_ACCOUNT[category]) return res.status(400).json({ error: 'กรุณาเลือกหมวดต้นทุนให้ถูกต้อง' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียด' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  const resolvedDate = costDate || new Date().toISOString().slice(0, 10);

  // Control-budget check (rule #3) — runs before the transaction so a hard block never even opens
  // one; a thrown err.status=409 here means "over budget on a strict item / over total budget".
  let budgetWarnings = [];
  try {
    const result = await checkBudgetControl(companyId, projectId || null, (workCode || '').trim() || null, Number(amount));
    budgetWarnings = result.warnings;
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO client_project_costs (company_id, project_id, category, description, cost_date, amount, vendor, work_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [companyId, projectId || null, category, description.trim(), resolvedDate, Number(amount), (vendor || '').trim(), (workCode || '').trim() || null, req.customer.id]
    );
    const costId = insert.rows[0].id;
    await postClientExpenseJournalEntry(client, {
      companyId, sourceType: 'project_expense', sourceId: costId, projectId: projectId || null, accountCode: PROJECT_COST_CATEGORY_ACCOUNT[category],
      description: `ต้นทุนโครงการ: ${description.trim()}`, amount: Number(amount), entryDate: resolvedDate, createdBy: req.customer.id,
    });
    await client.query('COMMIT');
    const r = await client.query(
      `SELECT id, project_id, category, description, to_char(cost_date,'YYYY-MM-DD') AS cost_date, amount, vendor, work_code, created_by, created_at
       FROM client_project_costs WHERE id=$1`, [costId]
    );
    res.json({ cost: serializeProjectCost(r.rows[0]), budgetWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกต้นทุนโครงการไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/project-costs/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM client_project_costs WHERE id=$1 AND company_id=$2 RETURNING id', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการต้นทุน' });
  res.json({ ok: true });
});

app.get('/api/customer/office-expenses', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { from, to } = req.query || {};
  const clauses = ['company_id=$1'];
  const vals = [companyId];
  if (from) { vals.push(from); clauses.push(`expense_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`expense_date <= $${vals.length}`); }
  const r = await pool.query(
    `SELECT id, category, description, to_char(expense_date,'YYYY-MM-DD') AS expense_date, amount, created_by, created_at
     FROM client_office_expenses WHERE ${clauses.join(' AND ')} ORDER BY expense_date DESC, id DESC`, vals
  );
  res.json({ expenses: r.rows.map(serializeOfficeExpense) });
});

app.post('/api/customer/office-expenses', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { category, description, expenseDate, amount } = req.body || {};
  if (!category || !['salary','rent','utility','phone','misc'].includes(category)) return res.status(400).json({ error: 'กรุณาเลือกหมวดค่าใช้จ่ายให้ถูกต้อง' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียด' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  const resolvedDate = expenseDate || new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO client_office_expenses (company_id, category, description, expense_date, amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [companyId, category, description.trim(), resolvedDate, Number(amount), req.customer.id]
    );
    const expenseId = insert.rows[0].id;
    await postClientExpenseJournalEntry(client, {
      companyId, sourceType: 'office_expense', sourceId: expenseId, accountCode: OFFICE_EXPENSE_ACCOUNT_CODE,
      description: `ค่าใช้จ่ายสำนักงาน: ${description.trim()}`, amount: Number(amount), entryDate: resolvedDate, createdBy: req.customer.id,
    });
    await client.query('COMMIT');
    const r = await client.query(
      `SELECT id, category, description, to_char(expense_date,'YYYY-MM-DD') AS expense_date, amount, created_by, created_at
       FROM client_office_expenses WHERE id=$1`, [expenseId]
    );
    res.json({ expense: serializeOfficeExpense(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกค่าใช้จ่ายสำนักงานไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/office-expenses/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM client_office_expenses WHERE id=$1 AND company_id=$2 RETURNING id', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการค่าใช้จ่าย' });
  res.json({ ok: true });
});

// ---------------- Customer: client ledger — ใบแจ้งหนี้/รายรับ (revenue) ----------------
// paid_amount is aggregated from client_revenue_payments (SUM(amount+wht_amount), i.e. cash
// received PLUS whatever the client withheld as tax on this row's behalf — both together clear the
// AR, see "รับชำระเงิน" below) — a LEFT JOIN onto a pre-aggregated subquery, not a plain LEFT JOIN
// with any filter in WHERE, so a revenue row with zero payments yet still comes back as 0 rather
// than being silently dropped (same reasoning as computeClientAccountBalances' own pre-aggregation,
// see project_client_ledger memory).
const CLIENT_REVENUE_SELECT = `
  SELECT cr.id, cr.project_id, cr.type, cr.description, to_char(cr.revenue_date,'YYYY-MM-DD') AS revenue_date, cr.amount, cr.ref_doc,
    cr.retention_percent, cr.retention_amount, cr.retention_status,
    to_char(cr.retention_release_date,'YYYY-MM-DD') AS retention_release_date,
    to_char(cr.retention_released_date,'YYYY-MM-DD') AS retention_released_date,
    cr.created_by, cr.created_at, COALESCE(rp.paid_total, 0) AS paid_amount
  FROM client_revenue cr
  LEFT JOIN (SELECT revenue_id, SUM(amount + wht_amount) AS paid_total FROM client_revenue_payments GROUP BY revenue_id) rp ON rp.revenue_id = cr.id`;

function serializeRevenue(row) {
  return {
    id: row.id, projectId: row.project_id, type: row.type, description: row.description,
    revenueDate: row.revenue_date, amount: Number(row.amount), refDoc: row.ref_doc,
    retentionPercent: row.retention_percent !== null ? Number(row.retention_percent) : null,
    retentionAmount: Number(row.retention_amount), retentionStatus: row.retention_status,
    retentionReleaseDate: row.retention_release_date, retentionReleasedDate: row.retention_released_date,
    paidAmount: Number(row.paid_amount || 0),
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

// Posts revenue recognition into the client ledger: debit 1200 ลูกหนี้การค้า, credit 4100
// รายได้ค่าก่อสร้าง, for the FULL billed amount. Deliberately does NOT touch retention here even
// when retentionPercent>0 on the same row — reclassifying the retained portion into 1250 ลูกหนี้
// เงินประกันผลงาน is a separate journal entry (item 4c / "เงินประกันผลงาน"), matching how real
// accounting treats revenue recognition and the retention reclassification as two distinct events.
// SAVEPOINT-wrapped for the same reason as postClientExpenseJournalEntry (see project_client_ledger
// memory) — `client` is shared with the caller's own INSERT in the same transaction, so a plain
// try/catch would not actually protect the primary row if the journal INSERT itself fails at the DB
// level.
async function postClientRevenueJournalEntry(client, { companyId, sourceId, projectId, description, amount, entryDate, createdBy }) {
  await client.query('SAVEPOINT client_revenue_journal_post');
  try {
    const amt = round2(amount);
    await createClientJournalEntry(client, {
      companyId, entryDate, description, sourceType: 'revenue', sourceId, projectId, createdBy,
      lines: [
        { accountCode: '1200', debitAmount: amt, creditAmount: 0, description: `ลูกหนี้การค้า - ${description}` },
        { accountCode: '4100', debitAmount: 0, creditAmount: amt, description },
      ],
    });
    await client.query('RELEASE SAVEPOINT client_revenue_journal_post');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT client_revenue_journal_post');
    console.error(`[client-journal] Failed to post journal entry for company ${companyId} revenue (source ${sourceId}):`, err.message);
  }
}

// Reclassifies the retained portion of a revenue installment out of ordinary AR (1200) into 1250
// ลูกหนี้เงินประกันผลงาน — a SEPARATE journal entry from revenue recognition (postClientRevenueJournalEntry
// above), matching real accounting practice (revenue recognition and the retention reclassification
// are two distinct events, not one combined entry). SAVEPOINT-wrapped for the same reason as its
// sibling helpers — `client` is shared with the caller's own INSERT in the same transaction, so a
// plain try/catch would not actually protect the primary row if this INSERT fails at the DB level.
async function postClientRetentionHoldJournalEntry(client, { companyId, sourceId, projectId, description, amount, entryDate, createdBy }) {
  await client.query('SAVEPOINT client_retention_hold_journal_post');
  try {
    const amt = round2(amount);
    await createClientJournalEntry(client, {
      companyId, entryDate, description, sourceType: 'retention', sourceId, projectId, createdBy,
      lines: [
        { accountCode: '1250', debitAmount: amt, creditAmount: 0, description: `ลูกหนี้เงินประกันผลงาน - ${description}` },
        { accountCode: '1200', debitAmount: 0, creditAmount: amt, description: `ลูกหนี้การค้า - ${description}` },
      ],
    });
    await client.query('RELEASE SAVEPOINT client_retention_hold_journal_post');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT client_retention_hold_journal_post');
    console.error(`[client-journal] Failed to post retention-hold journal entry for company ${companyId} (source ${sourceId}):`, err.message);
  }
}

app.get('/api/customer/revenue', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { projectId, from, to } = req.query || {};
  const clauses = ['cr.company_id=$1'];
  const vals = [companyId];
  if (projectId) { vals.push(parseInt(projectId, 10)); clauses.push(`cr.project_id = $${vals.length}`); }
  if (from) { vals.push(from); clauses.push(`cr.revenue_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`cr.revenue_date <= $${vals.length}`); }
  const r = await pool.query(
    `${CLIENT_REVENUE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY cr.revenue_date DESC, cr.id DESC`, vals
  );
  res.json({ revenue: r.rows.map(serializeRevenue) });
});

app.post('/api/customer/revenue', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { projectId, type, description, revenueDate, amount, refDoc, retentionPercent, retentionReleaseDate } = req.body || {};
  if (!type || !['progress','deposit','variation'].includes(type)) return res.status(400).json({ error: 'กรุณาเลือกประเภทรายรับให้ถูกต้อง' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียด' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });
  const resolvedDate = revenueDate || new Date().toISOString().slice(0, 10);
  const retPct = (retentionPercent !== undefined && retentionPercent !== null && retentionPercent !== '') ? Number(retentionPercent) : null;
  const retAmount = retPct ? round2(Number(amount) * retPct / 100) : 0;
  const retStatus = retAmount > 0 ? 'held' : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO client_revenue (company_id, project_id, type, description, revenue_date, amount, ref_doc, retention_percent, retention_amount, retention_status, retention_release_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, projectId || null, type, description.trim(), resolvedDate, Number(amount), (refDoc || '').trim(), retPct, retAmount, retStatus, retentionReleaseDate || null]
    );
    const revenueId = insert.rows[0].id;
    await postClientRevenueJournalEntry(client, {
      companyId, sourceId: revenueId, projectId: projectId || null, description: `รายรับ: ${description.trim()}`, amount: Number(amount), entryDate: resolvedDate, createdBy: req.customer.id,
    });
    if (retAmount > 0) {
      await postClientRetentionHoldJournalEntry(client, {
        companyId, sourceId: revenueId, projectId: projectId || null, description: `เงินประกันผลงาน: ${description.trim()}`, amount: retAmount, entryDate: resolvedDate, createdBy: req.customer.id,
      });
    }
    await client.query('COMMIT');
    const r = await client.query(`${CLIENT_REVENUE_SELECT} WHERE cr.id=$1`, [revenueId]);
    res.json({ revenue: serializeRevenue(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกรายรับไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/revenue/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM client_revenue WHERE id=$1 AND company_id=$2 RETURNING id', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการรายรับ' });
  res.json({ ok: true });
});

// "รับเงินประกันคืน" — clears the retention balance for a revenue installment: debit 1100 เงินสด /
// credit 1250 ลูกหนี้เงินประกันผลงาน. Unlike postClientRetentionHoldJournalEntry (a secondary action
// swallowed so it never blocks saving the revenue row), this route does NOT swallow journal errors —
// posting the journal entry IS the entire point of this endpoint (same reasoning as admin-panel's
// mark-paid / recordInvoicePayment), so a failure here should roll back and surface an error rather
// than silently flip retention_status with no journal to back it up.
app.post('/api/customer/revenue/:id/release-retention', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rev = await client.query('SELECT * FROM client_revenue WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (rev.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบรายการรายรับ' }); }
    const row = rev.rows[0];
    if (row.retention_status !== 'held') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'รายการนี้ไม่มีเงินประกันที่รอคืน หรือคืนเงินประกันไปแล้ว' });
    }
    const releaseDate = new Date().toISOString().slice(0, 10);
    await client.query(`UPDATE client_revenue SET retention_status='released', retention_released_date=$1 WHERE id=$2`, [releaseDate, id]);
    const amt = round2(row.retention_amount);
    await createClientJournalEntry(client, {
      companyId, entryDate: releaseDate, description: `รับเงินประกันคืน: ${row.description}`,
      sourceType: 'retention', sourceId: id, projectId: row.project_id, createdBy: req.customer.id,
      lines: [
        { accountCode: '1100', debitAmount: amt, creditAmount: 0, description: 'เงินสด' },
        { accountCode: '1250', debitAmount: 0, creditAmount: amt, description: `ลูกหนี้เงินประกันผลงาน - ${row.description}` },
      ],
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[client-journal] Failed to release retention for revenue', id, err);
    return res.status(500).json({ error: err.message || 'คืนเงินประกันไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const r = await pool.query(`${CLIENT_REVENUE_SELECT} WHERE cr.id=$1`, [id]);
  res.json({ revenue: serializeRevenue(r.rows[0]) });
});

// ---------------- Customer: client ledger — รับชำระเงิน (receive payment against client_revenue)
// ---------------- "Group C" of the เอกสารสำคัญ split (ใบเสร็จรับเงิน/หนังสือรับรองหัก ณ ที่จ่าย) —
// see project_client_ledger memory. Clears the ordinary AR (1200) created by revenue recognition —
// NOT the retention receivable (1250), which has its own separate release-retention flow above.
// Partial payments are the normal case: the payable ceiling is
// (client_revenue.amount - client_revenue.retention_amount) minus whatever's already been paid,
// re-checked under a row lock (FOR UPDATE on client_revenue) so two concurrent payment requests for
// the same row can't both succeed past the remaining balance. Does NOT swallow journal errors —
// booking the payment IS the point of this endpoint, same reasoning as release-retention/labor
// mark-paid above.
function serializeRevenuePayment(row) {
  return {
    id: row.id, revenueId: row.revenue_id, paymentDate: row.payment_date,
    amount: Number(row.amount), whtAmount: Number(row.wht_amount), note: row.note,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
const CLIENT_REVENUE_PAYMENT_SELECT = `
  SELECT id, revenue_id, to_char(payment_date,'YYYY-MM-DD') AS payment_date, amount, wht_amount, note, created_by, created_at
  FROM client_revenue_payments`;

app.get('/api/customer/revenue/:id/payments', requireCustomerAuth, async (req, res) => {
  const revenueId = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const rev = await pool.query('SELECT 1 FROM client_revenue WHERE id=$1 AND company_id=$2', [revenueId, companyId]);
  if (rev.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการรายรับ' });
  const r = await pool.query(`${CLIENT_REVENUE_PAYMENT_SELECT} WHERE revenue_id=$1 AND company_id=$2 ORDER BY payment_date DESC, id DESC`, [revenueId, companyId]);
  res.json({ payments: r.rows.map(serializeRevenuePayment) });
});

app.post('/api/customer/revenue/:id/payments', requireCustomerAuth, async (req, res) => {
  const revenueId = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { amount, whtAmount, paymentDate, note } = req.body || {};
  const netAmount = Number(amount) || 0;
  const wht = Number(whtAmount) || 0;
  if (netAmount <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินที่รับชำระให้ถูกต้อง' });
  if (wht < 0) return res.status(400).json({ error: 'ยอดภาษีหัก ณ ที่จ่ายไม่ถูกต้อง' });
  const resolvedDate = paymentDate || new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  let paymentId;
  try {
    await client.query('BEGIN');
    const rev = await client.query('SELECT * FROM client_revenue WHERE id=$1 AND company_id=$2 FOR UPDATE', [revenueId, companyId]);
    if (rev.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบรายการรายรับ' }); }
    const row = rev.rows[0];
    const paidRes = await client.query('SELECT COALESCE(SUM(amount + wht_amount), 0) AS total FROM client_revenue_payments WHERE revenue_id=$1', [revenueId]);
    const alreadyPaid = round2(Number(paidRes.rows[0].total));
    const payableTotal = round2(Number(row.amount) - Number(row.retention_amount));
    const remaining = round2(payableTotal - alreadyPaid);
    const thisPayment = round2(netAmount + wht);
    if (thisPayment > remaining + 0.01) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `ยอดที่รับชำระเกินยอดคงเหลือ (คงเหลือ ${remaining.toFixed(2)} บาท)` });
    }
    const insert = await client.query(
      `INSERT INTO client_revenue_payments (company_id, revenue_id, payment_date, amount, wht_amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, revenueId, resolvedDate, netAmount, wht, (note || '').trim(), req.customer.id]
    );
    paymentId = insert.rows[0].id;
    const lines = [
      { accountCode: '1100', debitAmount: netAmount, creditAmount: 0, description: 'เงินสด' },
    ];
    if (wht > 0) {
      lines.push({ accountCode: '1260', debitAmount: wht, creditAmount: 0, description: `ภาษีหัก ณ ที่จ่ายค้างรับ - ${row.description}` });
    }
    lines.push({ accountCode: '1200', debitAmount: 0, creditAmount: thisPayment, description: `ลูกหนี้การค้า - ${row.description}` });
    await createClientJournalEntry(client, {
      companyId, entryDate: resolvedDate, description: `รับชำระเงิน: ${row.description}`,
      sourceType: 'payment', sourceId: paymentId, projectId: row.project_id, createdBy: req.customer.id,
      lines,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[client-journal] Failed to record payment for revenue', revenueId, err);
    return res.status(500).json({ error: err.message || 'บันทึกการรับชำระเงินไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const revRes = await pool.query(`${CLIENT_REVENUE_SELECT} WHERE cr.id=$1`, [revenueId]);
  const payRes = await pool.query(`${CLIENT_REVENUE_PAYMENT_SELECT} WHERE id=$1`, [paymentId]);
  res.json({ revenue: serializeRevenue(revRes.rows[0]), payment: serializeRevenuePayment(payRes.rows[0]) });
});

// ---------------- Customer: client ledger — ใบวางบิล/ใบกำกับภาษี (attached to client_revenue)
// ---------------- "Group B" — see schema.sql's client_revenue_documents comment. No journal
// posting — these are documents FOR a revenue event that client_revenue already recorded, not a
// second recording of it.
const CLIENT_REVENUE_DOCS_DIR = path.join(__dirname, 'uploads', 'client-revenue-documents');
fs.mkdirSync(CLIENT_REVENUE_DOCS_DIR, { recursive: true });
const ALLOWED_REVENUE_DOC_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const CLIENT_REVENUE_DOC_TYPES = ['billing', 'tax_invoice'];
const revenueDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CLIENT_REVENUE_DOCS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_REVENUE_DOC_MIME.has(file.mimetype)),
});
function uploadRevenueDocMiddleware(req, res, next) {
  revenueDocUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ (รองรับ jpg, png, webp, pdf)' });
    next();
  });
}
function serializeRevenueDocument(row) {
  return {
    id: row.id, revenueId: row.revenue_id, docType: row.doc_type, docNo: row.doc_no, docDate: row.doc_date,
    hasFile: !!row.file_attachment, note: row.note, createdBy: row.created_by, createdAt: row.created_at,
  };
}
const CLIENT_REVENUE_DOC_SELECT = `
  SELECT id, revenue_id, doc_type, doc_no, to_char(doc_date,'YYYY-MM-DD') AS doc_date, file_attachment, note, created_by, created_at
  FROM client_revenue_documents`;

app.get('/api/customer/revenue/:id/documents', requireCustomerAuth, async (req, res) => {
  const revenueId = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const rev = await pool.query('SELECT 1 FROM client_revenue WHERE id=$1 AND company_id=$2', [revenueId, companyId]);
  if (rev.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการรายรับ' });
  const r = await pool.query(`${CLIENT_REVENUE_DOC_SELECT} WHERE revenue_id=$1 AND company_id=$2 ORDER BY id DESC`, [revenueId, companyId]);
  res.json({ documents: r.rows.map(serializeRevenueDocument) });
});

app.post('/api/customer/revenue/:id/documents', requireCustomerAuth, uploadRevenueDocMiddleware, async (req, res) => {
  const revenueId = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { docType, docNo, docDate, note } = req.body || {};
  if (!docType || !CLIENT_REVENUE_DOC_TYPES.includes(docType)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ประเภทเอกสารไม่ถูกต้อง' });
  }
  const rev = await pool.query('SELECT 1 FROM client_revenue WHERE id=$1 AND company_id=$2', [revenueId, companyId]);
  if (rev.rowCount === 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'ไม่พบรายการรายรับ' });
  }
  const ins = await pool.query(
    `INSERT INTO client_revenue_documents (company_id, revenue_id, doc_type, doc_no, doc_date, file_attachment, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, revenueId, docType, (docNo || '').trim(), docDate || new Date().toISOString().slice(0, 10),
     req.file ? req.file.filename : null, (note || '').trim(), req.customer.id]
  );
  const r = await pool.query(`${CLIENT_REVENUE_DOC_SELECT} WHERE id=$1`, [ins.rows[0].id]);
  res.json({ document: serializeRevenueDocument(r.rows[0]) });
});

app.get('/api/customer/revenue-documents/:id/file', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT file_attachment FROM client_revenue_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (r.rowCount === 0 || !r.rows[0].file_attachment) return res.status(404).json({ error: 'ไม่พบไฟล์เอกสาร' });
  res.sendFile(path.join(CLIENT_REVENUE_DOCS_DIR, r.rows[0].file_attachment));
});

app.delete('/api/customer/revenue-documents/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await pool.query('SELECT file_attachment FROM client_revenue_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
  await pool.query('DELETE FROM client_revenue_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (existing.rows[0].file_attachment) fs.unlink(path.join(CLIENT_REVENUE_DOCS_DIR, existing.rows[0].file_attachment), () => {});
  res.json({ ok: true });
});

// ---------------- Customer: client ledger — ใบขอเบิกความคืบหน้าโครงการ (Progress Claim, หัวข้อ 3) ----------------
// migration 0014 — เขียนเป็น "หน้าบ้าน" workflow submit->certify->approve วางไว้หน้า client_revenue เดิม
// (ซึ่งมีอยู่แล้ว ถูกต้อง ใช้ต่อ ไม่แตะ) — พอ approve แล้วค่อยสร้างแถว client_revenue + post journal เอง
// ตรงนี้เลย (ไม่ผ่าน postClientRevenueJournalEntry/postClientRetentionHoldJournalEntry เดิมที่ swallow
// error ภายใน — การ post journal ตอนอนุมัติใบขอเบิก "เป็นจุดประสงค์หลัก" ของ endpoint นี้ ไม่ใช่ secondary
// action แบบตอนสร้างรายรับตรงๆ เหตุผลเดียวกับที่ /revenue/:id/release-retention ไม่ swallow error เช่นกัน)
function hasCertifyProgressPermission(customer) {
  return customer.role === 'super_user' || customer.can_certify_progress === true;
}
function serializeProgressClaimItem(row) {
  return {
    id: row.id,
    budgetItemId: row.budget_item_id,
    workCode: row.work_code,
    itemDescription: row.item_description,
    budgetItemAmount: Number(row.budget_item_amount),
    requestedPercent: Number(row.requested_percent),
    requestedAmount: Number(row.requested_amount),
    certifiedPercent: row.certified_percent !== null ? Number(row.certified_percent) : null,
    certifiedAmount: row.certified_amount !== null ? Number(row.certified_amount) : null,
  };
}
function serializeProgressClaim(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name || null,
    claimType: row.claim_type,
    claimMode: row.claim_mode,
    installmentId: row.installment_id,
    installmentNo: row.installment_no,
    installmentDescription: row.installment_description,
    claimNo: row.claim_no,
    requestedAmount: Number(row.requested_amount),
    certifiedAmount: row.certified_amount !== null ? Number(row.certified_amount) : null,
    retentionPercent: row.retention_percent !== null ? Number(row.retention_percent) : null,
    retentionPercentOverrideReason: row.retention_percent_override_reason,
    retentionAmount: Number(row.retention_amount),
    applyAdvanceAmount: Number(row.apply_advance_amount),
    status: row.status,
    submittedBy: row.submitted_by, submittedAt: row.submitted_at,
    certifiedBy: row.certified_by, certifiedAt: row.certified_at, certifyNote: row.certify_note,
    approvedBy: row.approved_by, approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    revenueId: row.revenue_id,
    note: row.note,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
const CLIENT_PROGRESS_CLAIM_SELECT = `
  SELECT pc.id, pc.project_id, cp.name AS project_name, pc.claim_type, pc.claim_mode, pc.installment_id,
    cpi.installment_no, cpi.description AS installment_description,
    pc.claim_no, pc.requested_amount, pc.certified_amount,
    pc.retention_percent, pc.retention_percent_override_reason, pc.retention_amount, pc.apply_advance_amount,
    pc.status, pc.submitted_by, pc.submitted_at, pc.certified_by, pc.certified_at, pc.certify_note,
    pc.approved_by, pc.approved_at, pc.rejected_reason, pc.revenue_id, pc.note, pc.created_by, pc.created_at
  FROM client_progress_claims pc
  LEFT JOIN client_projects cp ON cp.id = pc.project_id
  LEFT JOIN client_project_installments cpi ON cpi.id = pc.installment_id`;
const CLIENT_PROGRESS_CLAIM_ITEMS_SELECT = `
  SELECT pci.id, pci.budget_item_id, bi.work_code, bi.description AS item_description, bi.amount AS budget_item_amount,
    pci.requested_percent, pci.requested_amount, pci.certified_percent, pci.certified_amount
  FROM client_progress_claim_items pci
  JOIN client_budget_items bi ON bi.id = pci.budget_item_id
  WHERE pci.progress_claim_id=$1 AND pci.company_id=$2 ORDER BY bi.idx`;

async function fetchFullProgressClaim(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_PROGRESS_CLAIM_SELECT} WHERE pc.id=$1 AND pc.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  const claim = serializeProgressClaim(r.rows[0]);
  claim.items = claim.claimMode === 'boq'
    ? (await dbClient.query(CLIENT_PROGRESS_CLAIM_ITEMS_SELECT, [id, companyId])).rows.map(serializeProgressClaimItem)
    : [];
  return claim;
}

async function generateClientClaimNumber(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'progress_claim');
    const no = `PC-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_progress_claims WHERE company_id=$1 AND claim_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบขอเบิกความคืบหน้าได้');
}

// ทั้ง POST (create)/PUT (edit) ใช้ร่วมกัน — excludeClaimId ใช้ตอน PUT กันเช็คซ้ำกับตัวเอง (งวดงานเดียวกัน)
async function validateProgressClaimInput(dbClient, companyId, {
  projectId, claimType, claimMode, installmentId, requestedAmount, items,
  retentionPercent, retentionPercentOverrideReason, note,
}, { excludeClaimId } = {}) {
  if (!projectId) return { error: 'กรุณาเลือกโครงการ' };
  const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
  if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };

  if (!claimType || !['progress', 'advance'].includes(claimType)) return { error: 'กรุณาเลือกประเภทใบขอเบิกให้ถูกต้อง' };

  if (claimType === 'advance') {
    const safeRequestedAmount = parsePositiveNumericValue(requestedAmount);
    if (safeRequestedAmount === null) return { error: 'กรุณาระบุจำนวนเงินที่ขอเบิกล่วงหน้าให้ถูกต้อง (มากกว่า 0)' };
    return {
      safeProjectId: projectId, safeClaimType: 'advance', safeClaimMode: null, safeInstallmentId: null,
      safeRequestedAmount, safeItems: [], safeRetentionPercent: null, safeRetentionPercentOverrideReason: '',
      safeNote: (note || '').trim(),
    };
  }

  // claimType === 'progress'
  if (!claimMode || !['installment', 'boq'].includes(claimMode)) return { error: 'กรุณาเลือกรูปแบบการขอเบิก (งวดงาน หรือ BOQ)' };

  let safeRequestedAmount = null;
  let safeItems = [];
  let safeInstallmentId = null;

  if (claimMode === 'installment') {
    if (!installmentId) return { error: 'กรุณาเลือกงวดงาน' };
    const inst = await dbClient.query('SELECT id FROM client_project_installments WHERE id=$1 AND company_id=$2 AND project_id=$3', [installmentId, companyId, projectId]);
    if (inst.rowCount === 0) return { error: 'ไม่พบงวดงานนี้ในโครงการที่เลือก' };
    // กันงวดงานเดียวกันถูกขอเบิกซ้อนกันหลายใบพร้อมกัน (นับเฉพาะใบที่ "ยังไม่จบ" — ไม่ใช่ rejected/cancelled —
    // ตาม pattern NOT IN กับสถานะจบแบบล้มเหลว, CLAUDE.md ข้อ 23)
    const dupParams = [companyId, installmentId];
    let dupQuery = `SELECT COUNT(*)::int AS n FROM client_progress_claims WHERE company_id=$1 AND installment_id=$2 AND status NOT IN ('rejected','cancelled')`;
    if (excludeClaimId) { dupParams.push(excludeClaimId); dupQuery += ` AND id <> $${dupParams.length}`; }
    const dup = await dbClient.query(dupQuery, dupParams);
    if (dup.rows[0].n > 0) return { error: 'งวดงานนี้มีใบขอเบิกที่ยังไม่จบ (ไม่ถูกปฏิเสธ/ยกเลิก) อยู่แล้ว' };

    safeInstallmentId = installmentId;
    safeRequestedAmount = parsePositiveNumericValue(requestedAmount);
    if (safeRequestedAmount === null) return { error: 'กรุณาระบุจำนวนเงินที่ขอเบิกให้ถูกต้อง (มากกว่า 0)' };
  } else {
    // boq — requestedAmount ต่อบรรทัด/รวม คำนวณฝั่ง server เสมอจาก budget_item.amount x requested_percent
    // (ไม่เชื่อค่าที่ client ส่งมาตรงๆ ตาม CLAUDE.md ข้อ 4) ผ่าน SQL ::numeric ไม่ใช้ JS Number คำนวณ (ข้อ 3)
    if (!Array.isArray(items) || items.length === 0) return { error: 'กรุณาเลือกอย่างน้อย 1 รายการ BOQ' };
    const seenBudgetItemIds = new Set();
    for (const it of items) {
      if (!it.budgetItemId) return { error: 'มีรายการ BOQ ที่ไม่ได้ระบุ' };
      if (seenBudgetItemIds.has(it.budgetItemId)) return { error: 'มีรายการ BOQ ซ้ำกันในใบเดียวกัน' };
      seenBudgetItemIds.add(it.budgetItemId);
      const pct = parsePositiveNumericValue(it.requestedPercent);
      if (pct === null || Number(pct) > 100) return { error: `ระบุ % ความคืบหน้าไม่ถูกต้องสำหรับรายการ BOQ id=${it.budgetItemId} (0-100)` };
      // ต้องเป็นบรรทัดใน BOQ revision ปัจจุบันของโครงการนี้เท่านั้น (current_revision_id)
      const bi = await dbClient.query(
        `SELECT ROUND(bi.amount * $1::numeric / 100, 2) AS amount FROM client_budget_items bi
         JOIN client_budgets b ON b.company_id=bi.company_id AND b.current_revision_id=bi.revision_id
         WHERE bi.id=$2 AND bi.company_id=$3 AND b.project_id=$4`,
        [pct, it.budgetItemId, companyId, projectId]
      );
      if (bi.rowCount === 0) return { error: `ไม่พบรายการ BOQ id=${it.budgetItemId} ใน BOQ ฉบับปัจจุบันของโครงการนี้` };
      safeItems.push({ budgetItemId: it.budgetItemId, requestedPercent: pct, requestedAmount: bi.rows[0].amount });
    }
    const sumRes = await dbClient.query(
      `SELECT SUM(x.amt)::numeric AS total FROM UNNEST($1::numeric[]) AS x(amt)`,
      [safeItems.map(it => it.requestedAmount)]
    );
    safeRequestedAmount = sumRes.rows[0].total;
    if (Number(safeRequestedAmount) <= 0) return { error: 'ยอดรวมที่ขอเบิกต้องมากกว่า 0' };
  }

  // retention_percent: autofill จาก client_projects.default_retention_percent ถ้าไม่ระบุมา ถ้าระบุมาแล้ว
  // ต่างจาก default ต้องบังคับกรอกเหตุผล — เทียบค่าด้วย SQL ::numeric เสมอ (ไม่ใช้ JS string/Number เทียบ
  // เพราะ "5" vs "5.00" ที่ pg คืนมาจะเทียบผิดถ้าเทียบแบบ string ตรงๆ — CLAUDE.md ข้อ 3)
  let retentionPercentRaw = null;
  if (retentionPercent !== undefined && retentionPercent !== null && retentionPercent !== '') {
    const pct = parseNonNegativeNumericValue(retentionPercent);
    if (pct === null || Number(pct) > 100) return { error: 'ระบุเปอร์เซ็นต์เงินประกันผลงานไม่ถูกต้อง (0-100)' };
    retentionPercentRaw = pct;
  }
  const cmp = await dbClient.query(
    `SELECT default_retention_percent, (default_retention_percent IS DISTINCT FROM $1::numeric) AS differs_from_default
     FROM client_projects WHERE id=$2 AND company_id=$3`,
    [retentionPercentRaw, projectId, companyId]
  );
  let safeRetentionPercent, safeRetentionPercentOverrideReason = '';
  if (retentionPercentRaw === null) {
    safeRetentionPercent = cmp.rows[0].default_retention_percent;
  } else {
    safeRetentionPercent = retentionPercentRaw;
    if (cmp.rows[0].differs_from_default) {
      safeRetentionPercentOverrideReason = String(retentionPercentOverrideReason || '').trim();
      if (!safeRetentionPercentOverrideReason) return { error: 'อัตราเงินประกันผลงานที่ใช้ต่างจากค่าเริ่มต้นของโครงการ กรุณาระบุเหตุผล' };
    }
  }

  return {
    safeProjectId: projectId, safeClaimType: 'progress', safeClaimMode: claimMode, safeInstallmentId,
    safeRequestedAmount, safeItems, safeRetentionPercent, safeRetentionPercentOverrideReason,
    safeNote: (note || '').trim(),
  };
}

app.get('/api/customer/progress-claims', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, projectId, claimType } = req.query;
  const conditions = ['pc.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`pc.status=$${params.length}`); }
  if (projectId) { params.push(parseInt(projectId, 10)); conditions.push(`pc.project_id=$${params.length}`); }
  if (claimType) { params.push(claimType); conditions.push(`pc.claim_type=$${params.length}`); }
  const r = await pool.query(`${CLIENT_PROGRESS_CLAIM_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY pc.id DESC`, params);
  res.json({ progressClaims: r.rows.map(serializeProgressClaim) });
});

app.get('/api/customer/progress-claims/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const claim = await fetchFullProgressClaim(pool, id, req.customer.company_id);
  if (!claim) return res.status(404).json({ error: 'ไม่พบใบขอเบิกความคืบหน้า' });
  res.json({ progressClaim: claim });
});

// ยอดเงินรับล่วงหน้าคงเหลือของโครงการ (สำหรับกรอกฟอร์ม progress claim ตอนจะเลือกหักล้าง) — GET แสดงผล
// อย่างเดียว ไม่ใช้ตัดสินใจอะไรที่นี่ (การเช็คจริงเกิดตอน /approve พร้อม FOR UPDATE) จึง Number() ได้ปกติ
app.get('/api/customer/projects/:id/outstanding-advance', requireCustomerAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const proj = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'ไม่พบโครงการนี้' });
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount - applied_amount), 0) AS outstanding FROM client_revenue
     WHERE company_id=$1 AND project_id=$2 AND type='deposit' AND amount > applied_amount`,
    [companyId, projectId]
  );
  res.json({ outstandingAdvance: Number(r.rows[0].outstanding) });
});

app.post('/api/customer/progress-claims', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'progress-claims-create', async (client) => {
    const companyId = req.customer.company_id;
    const { projectId, claimType, claimMode, installmentId, requestedAmount, items, retentionPercent, retentionPercentOverrideReason, note } = req.body || {};
    const v = await validateProgressClaimInput(client, companyId, { projectId, claimType, claimMode, installmentId, requestedAmount, items, retentionPercent, retentionPercentOverrideReason, note });
    if (v.error) return { status: 400, body: { error: v.error } };

    const insert = await client.query(
      `INSERT INTO client_progress_claims
         (company_id, project_id, claim_type, claim_mode, installment_id, requested_amount,
          retention_percent, retention_percent_override_reason, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9,$10) RETURNING id`,
      [companyId, v.safeProjectId, v.safeClaimType, v.safeClaimMode, v.safeInstallmentId, v.safeRequestedAmount,
       v.safeRetentionPercent, v.safeRetentionPercentOverrideReason, v.safeNote, req.customer.id]
    );
    const claimId = insert.rows[0].id;
    for (const it of v.safeItems) {
      await client.query(
        `INSERT INTO client_progress_claim_items (progress_claim_id, company_id, budget_item_id, requested_percent, requested_amount)
         VALUES ($1,$2,$3,$4::numeric,$5::numeric)`,
        [claimId, companyId, it.budgetItemId, it.requestedPercent, it.requestedAmount]
      );
    }
    const claim = await fetchFullProgressClaim(client, claimId, companyId);
    return { status: 200, body: { progressClaim: claim } };
  });
});

// แก้ไขได้เฉพาะ draft เท่านั้น — delete+reinsert items ได้อย่างปลอดภัยเหมือน PO (ยังไม่มี certified_percent
// ผูกอยู่ตอน draft แน่นอน)
app.put('/api/customer/progress-claims/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { projectId, claimType, claimMode, installmentId, requestedAmount, items, retentionPercent, retentionPercentOverrideReason, note } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cRes = await client.query('SELECT status FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (cRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอเบิกความคืบหน้า' }); }
    if (cRes.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'แก้ไขได้เฉพาะสถานะร่างเท่านั้น' }); }

    const v = await validateProgressClaimInput(client, companyId, { projectId, claimType, claimMode, installmentId, requestedAmount, items, retentionPercent, retentionPercentOverrideReason, note }, { excludeClaimId: id });
    if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }

    await client.query(
      `UPDATE client_progress_claims SET
         project_id=$1, claim_type=$2, claim_mode=$3, installment_id=$4, requested_amount=$5::numeric,
         retention_percent=$6::numeric, retention_percent_override_reason=$7, note=$8
       WHERE id=$9`,
      [v.safeProjectId, v.safeClaimType, v.safeClaimMode, v.safeInstallmentId, v.safeRequestedAmount,
       v.safeRetentionPercent, v.safeRetentionPercentOverrideReason, v.safeNote, id]
    );
    await client.query('DELETE FROM client_progress_claim_items WHERE progress_claim_id=$1', [id]);
    for (const it of v.safeItems) {
      await client.query(
        `INSERT INTO client_progress_claim_items (progress_claim_id, company_id, budget_item_id, requested_percent, requested_amount)
         VALUES ($1,$2,$3,$4::numeric,$5::numeric)`,
        [id, companyId, it.budgetItemId, it.requestedPercent, it.requestedAmount]
      );
    }
    await client.query('COMMIT');
    const claim = await fetchFullProgressClaim(pool, id, companyId);
    res.json({ progressClaim: claim });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบขอเบิกความคืบหน้าไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/progress-claims/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `progress-claims-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;

    const r = await client.query('SELECT * FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอเบิกความคืบหน้า' } };
    const claim = r.rows[0];
    if (claim.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะสถานะร่างเท่านั้น' } };

    if (req.customer.id !== claim.created_by) {
      const permCheck = await canApprove(client, req.customer, 'progress', claim.requested_amount, {
        companyId, originators: [claim.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบขอเบิกนี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    // เตือนล่วงหน้าถ้า boq เกิน 100% สะสม (ไม่บังคับจริง — บังคับจริงตอน approve เท่านั้น เพราะ claimed_percent
    // อาจถูกใบอื่นตัดยอดไปหลังจากนี้ได้อีก เหมือน pattern เดียวกับ PO's over-limit guard)
    if (claim.claim_mode === 'boq') {
      const overCheck = await client.query(
        `SELECT bi.work_code, bi.claimed_percent, pci.requested_percent
         FROM client_progress_claim_items pci
         JOIN client_budget_items bi ON bi.id = pci.budget_item_id
         WHERE pci.progress_claim_id=$1 AND (bi.claimed_percent + pci.requested_percent) > 100`,
        [id]
      );
      if (overCheck.rowCount > 0) {
        return { status: 400, body: { error: `ขอเบิกเกิน 100% สะสมของบรรทัด BOQ: ${overCheck.rows.map(l => `${l.work_code} (สะสม ${l.claimed_percent}% + ขอ ${l.requested_percent}%)`).join(', ')}` } };
      }
    }

    const claimNo = await generateClientClaimNumber(client, companyId);
    await client.query(
      `UPDATE client_progress_claims SET claim_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [claimNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'progress_claim', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });
    const full = await fetchFullProgressClaim(client, id, companyId);
    return { status: 200, body: { progressClaim: full } };
  });
});

// เฉพาะ claim_type='progress' — advance ไม่มีขั้นตอนนี้ (ข้ามไป submit->approve ตรงๆ ตามที่ตกลง)
app.post('/api/customer/progress-claims/:id/certify', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `progress-claims-certify:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const { certifiedAmount, certifyNote, items } = req.body || {};

    const r = await client.query('SELECT * FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอเบิกความคืบหน้า' } };
    const claim = r.rows[0];
    if (claim.claim_type !== 'progress') return { status: 400, body: { error: 'ใบขอเบิกเงินล่วงหน้าไม่มีขั้นตอนตรวจสอบผลงาน' } };
    if (claim.status !== 'submitted') return { status: 409, body: { error: 'ตรวจสอบผลงานได้เฉพาะใบที่ยื่นแล้วเท่านั้น' } };
    if (!hasCertifyProgressPermission(req.customer)) return { status: 403, body: { error: 'ไม่มีสิทธิ์ตรวจสอบผลงาน', code: 'no_permission' } };
    if (req.customer.id === claim.created_by) return { status: 403, body: { error: 'ผู้สร้างใบขอเบิกตรวจสอบผลงานใบของตัวเองไม่ได้', code: 'self_certify_blocked' } };

    let safeCertifiedAmount;
    const itemUpdates = [];
    if (claim.claim_mode === 'boq') {
      if (!Array.isArray(items) || items.length === 0) return { status: 400, body: { error: 'กรุณาระบุ % ที่ตรวจสอบแล้วของทุกรายการ BOQ' } };
      const existingItems = await client.query('SELECT id, budget_item_id FROM client_progress_claim_items WHERE progress_claim_id=$1', [id]);
      const byId = new Map(existingItems.rows.map(row => [row.id, row]));
      for (const it of items) {
        const row = byId.get(it.itemId);
        if (!row) return { status: 400, body: { error: `ไม่พบรายการ id=${it.itemId} ในใบนี้` } };
        const pct = parseNonNegativeNumericValue(it.certifiedPercent);
        if (pct === null || Number(pct) > 100) return { status: 400, body: { error: `ระบุ % ที่ตรวจสอบไม่ถูกต้องสำหรับรายการ id=${it.itemId}` } };
        const amt = await client.query('SELECT ROUND(amount * $1::numeric / 100, 2) AS amount FROM client_budget_items WHERE id=$2 AND company_id=$3', [pct, row.budget_item_id, companyId]);
        itemUpdates.push({ itemId: it.itemId, certifiedPercent: pct, certifiedAmount: amt.rows[0].amount });
      }
      const sumRes = await client.query(`SELECT SUM(x.amt)::numeric AS total FROM UNNEST($1::numeric[]) AS x(amt)`, [itemUpdates.map(u => u.certifiedAmount)]);
      safeCertifiedAmount = sumRes.rows[0].total;
    } else {
      safeCertifiedAmount = parseNonNegativeNumericValue(certifiedAmount);
      if (safeCertifiedAmount === null) return { status: 400, body: { error: 'กรุณาระบุยอดที่ตรวจสอบแล้วให้ถูกต้อง' } };
    }

    // เทียบ certified vs requested ด้วย SQL ::numeric เสมอ (ไม่ใช้ JS Number ตัดสินใจ — ข้อ 3)
    const bounds = await client.query(
      `SELECT ($1::numeric > requested_amount) AS exceeds, ($1::numeric <> requested_amount) AS differs
       FROM client_progress_claims WHERE id=$2`,
      [safeCertifiedAmount, id]
    );
    if (bounds.rows[0].exceeds) return { status: 400, body: { error: `ยอดที่ตรวจสอบ (${safeCertifiedAmount}) ต้องไม่เกินยอดที่ขอเบิก (${claim.requested_amount})` } };
    const safeCertifyNote = String(certifyNote || '').trim();
    if (bounds.rows[0].differs && !safeCertifyNote) {
      return { status: 400, body: { error: 'ยอดที่ตรวจสอบไม่เท่ากับยอดที่ขอเบิก กรุณาระบุเหตุผล' } };
    }

    for (const u of itemUpdates) {
      await client.query('UPDATE client_progress_claim_items SET certified_percent=$1::numeric, certified_amount=$2::numeric WHERE id=$3', [u.certifiedPercent, u.certifiedAmount, u.itemId]);
    }
    await client.query(
      `UPDATE client_progress_claims SET certified_amount=$1::numeric, certified_by=$2, certified_at=now(), certify_note=$3, status='certified' WHERE id=$4`,
      [safeCertifiedAmount, req.customer.id, safeCertifyNote, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'progress_claim', docId: id, action: 'certify',
      fromStatus: 'submitted', toStatus: 'certified', performedBy: req.customer.id,
      reason: safeCertifyNote || `รับรองยอดเท่ากับที่ขอ (${safeCertifiedAmount})`,
    });
    const full = await fetchFullProgressClaim(client, id, companyId);
    return { status: 200, body: { progressClaim: full } };
  });
});

app.post('/api/customer/progress-claims/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `progress-claims-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const { applyAdvanceAmount } = req.body || {};

    const r = await client.query('SELECT * FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอเบิกความคืบหน้า' } };
    const claim = r.rows[0];

    if (claim.claim_type === 'advance') {
      if (claim.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะที่ยื่นแล้วเท่านั้น' } };
    } else if (claim.status !== 'certified') {
      return { status: 409, body: { error: 'อนุมัติได้เฉพาะที่ตรวจสอบผลงานแล้วเท่านั้น' } };
    }

    // self-block ครอบคลุมถึงคนที่ certify ไปแล้วด้วย (ไม่ใช่แค่ created_by/submitted_by แบบเอกสารอื่น) —
    // ตกลงไว้ชัดเจนว่าคนคนเดียว certify แล้ว approve เองไม่ได้ ไม่งั้นการแยกขั้นตอนไม่มีความหมาย
    const result = await canApprove(client, req.customer, 'progress',
      claim.claim_type === 'advance' ? claim.requested_amount : claim.certified_amount,
      { companyId, originators: [claim.created_by, claim.submitted_by, claim.certified_by].filter(x => x != null) }
    );
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    const today = getBangkokDateStr();
    let revenueId;

    if (claim.claim_type === 'advance') {
      // ---- 3.1.1.2 รับเงินล่วงหน้า: Dr 1100 เงินสด / Cr 2160 เงินรับล่วงหน้าจากลูกค้า ----
      // ไม่รับรู้เป็นรายได้ทันที (ตัดสินใจไว้ชัดเจนแล้ว — ต่างจาก type='progress' ที่ Dr1200/Cr4100)
      const revIns = await client.query(
        `INSERT INTO client_revenue (company_id, project_id, type, description, revenue_date, amount)
         VALUES ($1,$2,'deposit',$3,$4,$5::numeric) RETURNING id`,
        [companyId, claim.project_id, `เงินล่วงหน้า: ${claim.claim_no}`, today, claim.requested_amount]
      );
      revenueId = revIns.rows[0].id;
      await createClientJournalEntry(client, {
        companyId, entryDate: today, description: `รับเงินล่วงหน้า: ${claim.claim_no}`,
        sourceType: 'revenue', sourceId: revenueId, projectId: claim.project_id, createdBy: req.customer.id,
        lines: [
          { accountCode: '1100', debitAmount: claim.requested_amount, creditAmount: 0, description: 'เงินสด' },
          { accountCode: '2160', debitAmount: 0, creditAmount: claim.requested_amount, description: 'เงินรับล่วงหน้าจากลูกค้า' },
        ],
      });
      await client.query(
        `UPDATE client_progress_claims SET certified_amount=requested_amount, status='approved', approved_by=$1, approved_at=now(), revenue_id=$2 WHERE id=$3`,
        [req.customer.id, revenueId, id]
      );
    } else {
      // ---- 3.1.1.1 Progress ----
      // retention_amount/net_after_retention คำนวณด้วย SQL ::numeric เสมอ ไม่ใช้ JS Number (ข้อ 3) เพราะ
      // ค่านี้ถูกใช้ตัดสินใจต่อ (เทียบกับ apply_advance_amount) ไม่ใช่แค่ format แสดงผล
      const calc = await client.query(
        `SELECT ROUND(certified_amount * COALESCE(retention_percent,0) / 100, 2) AS retention_amount,
                certified_amount - ROUND(certified_amount * COALESCE(retention_percent,0) / 100, 2) AS net_after_retention
         FROM client_progress_claims WHERE id=$1`,
        [id]
      );
      const retentionAmount = calc.rows[0].retention_amount;
      const netAfterRetention = calc.rows[0].net_after_retention;

      // กันเบิกเกิน 100% สะสมต่อบรรทัด BOQ — ล็อกก่อนเสมอ (ข้อ 6) แยก statement จาก aggregate (ข้อ 7)
      if (claim.claim_mode === 'boq') {
        const claimItems = await client.query('SELECT budget_item_id FROM client_progress_claim_items WHERE progress_claim_id=$1', [id]);
        const budgetItemIds = [...new Set(claimItems.rows.map(it => it.budget_item_id))].sort((a, b) => a - b);
        if (budgetItemIds.length > 0) {
          await client.query('SELECT id FROM client_budget_items WHERE id = ANY($1::int[]) FOR UPDATE', [budgetItemIds]);
          const checkRes = await client.query(
            `SELECT bi.work_code, bi.claimed_percent, pci.certified_percent,
               (bi.claimed_percent + pci.certified_percent) > 100 AS over_limit
             FROM client_budget_items bi
             JOIN client_progress_claim_items pci ON pci.budget_item_id = bi.id
             WHERE pci.progress_claim_id=$1`,
            [id]
          );
          const overLines = checkRes.rows.filter(row => row.over_limit);
          if (overLines.length > 0) {
            return { status: 400, body: { error: `อนุมัติไม่ได้ — เกิน 100% สะสมของบรรทัด BOQ: ${overLines.map(l => `${l.work_code} (สะสมเดิม ${l.claimed_percent}% + รับรอง ${l.certified_percent}%)`).join(', ')}` } };
          }
        }
      }

      const safeApplyAdvance = (applyAdvanceAmount !== undefined && applyAdvanceAmount !== null && applyAdvanceAmount !== '')
        ? parseNonNegativeNumericValue(applyAdvanceAmount) : '0';
      if (safeApplyAdvance === null) return { status: 400, body: { error: 'ระบุยอดหักล้างเงินล่วงหน้าไม่ถูกต้อง' } };

      const netCmp = await client.query(`SELECT ($1::numeric > $2::numeric) AS exceeds`, [safeApplyAdvance, netAfterRetention]);
      if (netCmp.rows[0].exceeds) {
        return { status: 400, body: { error: `ยอดหักล้างเงินล่วงหน้า (${safeApplyAdvance}) เกินยอดที่จะเรียกเก็บงวดนี้หลังหักเงินประกันผลงาน (${netAfterRetention})` } };
      }

      const advanceRowsToApply = [];
      if (Number(safeApplyAdvance) > 0) {
        // ล็อกแถว advance (client_revenue) ที่เกี่ยวข้องทั้งหมดก่อนเป็น statement แยก แล้วค่อย query
        // ยอดคงเหลือรวมแยกอีก statement ต่างหาก (ข้อ 6/7 เดียวกับที่ทำกับ budget_items ด้านบน)
        const advRows = await client.query(
          `SELECT id, amount, applied_amount FROM client_revenue
           WHERE company_id=$1 AND project_id=$2 AND type='deposit' AND amount > applied_amount
           ORDER BY id FOR UPDATE`,
          [companyId, claim.project_id]
        );
        const outstandingRes = await client.query(
          `SELECT COALESCE(SUM(amount - applied_amount), 0) AS outstanding FROM client_revenue
           WHERE company_id=$1 AND project_id=$2 AND type='deposit' AND amount > applied_amount`,
          [companyId, claim.project_id]
        );
        const outCmp = await client.query(`SELECT ($1::numeric > $2::numeric) AS exceeds`, [safeApplyAdvance, outstandingRes.rows[0].outstanding]);
        if (outCmp.rows[0].exceeds) {
          return { status: 400, body: { error: `ยอดหักล้างเงินล่วงหน้า (${safeApplyAdvance}) เกินยอดเงินล่วงหน้าคงเหลือจริง (${outstandingRes.rows[0].outstanding})` } };
        }
        // แบ่งยอดข้าม advance หลายก้อนแบบ FIFO (เก่าสุดก่อน) — ยอดรวมผ่านการตรวจสอบด้วย SQL ไว้แล้วข้างบน
        // ลูปนี้แค่ "แบ่งสัดส่วน" ไม่ใช่จุดตัดสินใจผ่าน/ไม่ผ่านอีกต่อไป
        let remaining = round2(Number(safeApplyAdvance));
        for (const row of advRows.rows) {
          if (remaining <= 0) break;
          const rowOutstanding = round2(Number(row.amount) - Number(row.applied_amount));
          const take = Math.min(rowOutstanding, remaining);
          if (take > 0) { advanceRowsToApply.push({ id: row.id, amount: take }); remaining = round2(remaining - take); }
        }
      }

      const revIns = await client.query(
        `INSERT INTO client_revenue (company_id, project_id, type, description, revenue_date, amount, ref_doc, retention_percent, retention_amount, retention_status)
         VALUES ($1,$2,'progress',$3,$4,$5::numeric,$6,$7::numeric,$8::numeric,$9) RETURNING id`,
        [companyId, claim.project_id, `งวดงาน: ${claim.claim_no}`, today, claim.certified_amount, claim.claim_no,
         claim.retention_percent, retentionAmount, Number(retentionAmount) > 0 ? 'held' : null]
      );
      revenueId = revIns.rows[0].id;

      await createClientJournalEntry(client, {
        companyId, entryDate: today, description: `รับรู้รายได้งวดงาน: ${claim.claim_no}`,
        sourceType: 'revenue', sourceId: revenueId, projectId: claim.project_id, createdBy: req.customer.id,
        lines: [
          { accountCode: '1200', debitAmount: claim.certified_amount, creditAmount: 0, description: 'ลูกหนี้การค้า' },
          { accountCode: '4100', debitAmount: 0, creditAmount: claim.certified_amount, description: `งวดงาน: ${claim.claim_no}` },
        ],
      });
      if (Number(retentionAmount) > 0) {
        await createClientJournalEntry(client, {
          companyId, entryDate: today, description: `เงินประกันผลงาน: ${claim.claim_no}`,
          sourceType: 'retention', sourceId: revenueId, projectId: claim.project_id, createdBy: req.customer.id,
          lines: [
            { accountCode: '1250', debitAmount: retentionAmount, creditAmount: 0, description: 'ลูกหนี้เงินประกันผลงาน' },
            { accountCode: '1200', debitAmount: 0, creditAmount: retentionAmount, description: 'ลูกหนี้การค้า' },
          ],
        });
      }
      for (const a of advanceRowsToApply) {
        await createClientJournalEntry(client, {
          companyId, entryDate: today, description: `หักล้างเงินล่วงหน้า: ${claim.claim_no}`,
          sourceType: 'revenue', sourceId: revenueId, projectId: claim.project_id, createdBy: req.customer.id,
          lines: [
            { accountCode: '2160', debitAmount: a.amount, creditAmount: 0, description: 'เงินรับล่วงหน้าจากลูกค้า' },
            { accountCode: '1200', debitAmount: 0, creditAmount: a.amount, description: 'ลูกหนี้การค้า' },
          ],
        });
        await client.query('UPDATE client_revenue SET applied_amount = applied_amount + $1::numeric WHERE id=$2', [a.amount, a.id]);
        await client.query(
          `INSERT INTO client_revenue_advance_applications (company_id, advance_revenue_id, progress_claim_id, amount, applied_date, created_by)
           VALUES ($1,$2,$3,$4::numeric,$5,$6)`,
          [companyId, a.id, id, a.amount, today, req.customer.id]
        );
      }

      if (claim.claim_mode === 'boq') {
        const claimItems2 = await client.query('SELECT budget_item_id, certified_percent FROM client_progress_claim_items WHERE progress_claim_id=$1', [id]);
        for (const it of claimItems2.rows) {
          // += แบบสัมพัทธ์เสมอ ห้ามอ่านมาคำนวณแล้วเขียนค่าสัมบูรณ์กลับ (กัน lost-update, ข้อ 5)
          await client.query('UPDATE client_budget_items SET claimed_percent = claimed_percent + $1::numeric WHERE id=$2', [it.certified_percent, it.budget_item_id]);
        }
      }

      await client.query(
        `UPDATE client_progress_claims SET retention_amount=$1::numeric, apply_advance_amount=$2::numeric, status='approved', approved_by=$3, approved_at=now(), revenue_id=$4 WHERE id=$5`,
        [retentionAmount, safeApplyAdvance, req.customer.id, revenueId, id]
      );
    }

    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'progress_claim', docId: id, action: 'approve',
      fromStatus: claim.status, toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason,
    });

    const full = await fetchFullProgressClaim(client, id, companyId);
    return { status: 200, body: { progressClaim: full } };
  });
});

app.post('/api/customer/progress-claims/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอเบิกความคืบหน้า' }); }
    const claim = r.rows[0];
    const rejectableStatuses = claim.claim_type === 'advance' ? ['submitted'] : ['submitted', 'certified'];
    if (!rejectableStatuses.includes(claim.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะที่ยื่นแล้ว (หรือตรวจสอบผลงานแล้วสำหรับใบ progress) เท่านั้น' });
    }
    const permCheck = await canApprove(client, req.customer, 'progress',
      claim.claim_type === 'advance' ? claim.requested_amount : (claim.certified_amount || claim.requested_amount),
      { companyId, originators: [claim.created_by, claim.submitted_by, claim.certified_by].filter(x => x != null) },
      { enforceAmountLimit: false }
    );
    if (!permCheck.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: permCheck.message, code: permCheck.code }); }

    await client.query(`UPDATE client_progress_claims SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'progress_claim', docId: id, action: 'reject',
      fromStatus: claim.status, toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    const full = await fetchFullProgressClaim(pool, id, companyId);
    res.json({ progressClaim: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบขอเบิกความคืบหน้าไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้ก่อนอนุมัติเท่านั้น (draft/submitted/certified) — ยังไม่มี client_revenue ผูกอยู่จนกว่าจะ approve
// ต่างจาก PO ที่ approved แล้วยัง cancel ได้ เพราะที่นี่ "อนุมัติ" = สร้างรายได้/journal จริงแล้วทันที
app.post('/api/customer/progress-claims/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_progress_claims WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอเบิกความคืบหน้า' }); }
    const claim = r.rows[0];
    const status = claim.status;
    if (!['draft', 'submitted', 'certified'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ยกเลิกได้เฉพาะก่อนอนุมัติเท่านั้น' });
    }
    const isOwner = req.customer.id === claim.created_by || (claim.submitted_by != null && req.customer.id === claim.submitted_by);
    if (!isOwner) {
      const permCheck = await canApprove(client, req.customer, 'progress', claim.certified_amount || claim.requested_amount, {
        companyId, originators: [claim.created_by, claim.submitted_by, claim.certified_by].filter(x => x != null),
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบขอเบิกนี้', code: permCheck.code });
      }
    }
    await client.query(`UPDATE client_progress_claims SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'progress_claim', docId: id, action: 'cancel',
      fromStatus: status, toStatus: 'cancelled', performedBy: req.customer.id,
    });
    await client.query('COMMIT');
    const full = await fetchFullProgressClaim(pool, id, companyId);
    res.json({ progressClaim: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบขอเบิกความคืบหน้าไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- Customer: client ledger — ค่าแรงพนักงาน (labor costs) ----------------
const CLIENT_LABOR_COST_SELECT_COLUMNS = `
  id, employee_id, project_id, to_char(work_date,'YYYY-MM-DD') AS work_date, days_worked, amount,
  payment_status, paid_at, work_code, created_by, created_at`;

function serializeLaborCost(row) {
  return {
    id: row.id, employeeId: row.employee_id, projectId: row.project_id, workDate: row.work_date,
    daysWorked: Number(row.days_worked), amount: Number(row.amount),
    paymentStatus: row.payment_status, paidAt: row.paid_at, workCode: row.work_code,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

// Books the labor cost as an accrual: debit 5400 ค่าแรง / credit 2150 ค่าแรงค้างจ่าย — NOT cash,
// since this records that the wage is OWED, not yet paid (see "จ่ายค่าแรง" below for the actual
// settlement). SAVEPOINT-wrapped like its siblings — `client` is shared with the caller's own
// INSERT in the same transaction.
async function postClientLaborAccrualJournalEntry(client, { companyId, sourceId, projectId, description, amount, entryDate, createdBy }) {
  await client.query('SAVEPOINT client_labor_journal_post');
  try {
    const amt = round2(amount);
    await createClientJournalEntry(client, {
      companyId, entryDate, description, sourceType: 'labor', sourceId, projectId, createdBy,
      lines: [
        { accountCode: '5400', debitAmount: amt, creditAmount: 0, description },
        { accountCode: '2150', debitAmount: 0, creditAmount: amt, description: `ค่าแรงค้างจ่าย - ${description}` },
      ],
    });
    await client.query('RELEASE SAVEPOINT client_labor_journal_post');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT client_labor_journal_post');
    console.error(`[client-journal] Failed to post labor accrual journal entry for company ${companyId} (source ${sourceId}):`, err.message);
  }
}

app.get('/api/customer/labor-costs', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeId, projectId, from, to } = req.query || {};
  const clauses = ['company_id=$1'];
  const vals = [companyId];
  if (employeeId) { vals.push(parseInt(employeeId, 10)); clauses.push(`employee_id = $${vals.length}`); }
  if (projectId) { vals.push(parseInt(projectId, 10)); clauses.push(`project_id = $${vals.length}`); }
  if (from) { vals.push(from); clauses.push(`work_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`work_date <= $${vals.length}`); }
  const r = await pool.query(
    `SELECT ${CLIENT_LABOR_COST_SELECT_COLUMNS} FROM client_labor_costs WHERE ${clauses.join(' AND ')} ORDER BY work_date DESC, id DESC`, vals
  );
  res.json({ laborCosts: r.rows.map(serializeLaborCost) });
});

app.post('/api/customer/labor-costs', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeId, projectId, workDate, daysWorked, amount, workCode } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'กรุณาเลือกพนักงาน' });
  if (!workDate) return res.status(400).json({ error: 'กรุณาระบุวันที่ทำงาน' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกจำนวนเงินให้ถูกต้อง' });

  const emp = await pool.query('SELECT full_name FROM employees WHERE id=$1 AND company_id=$2', [employeeId, companyId]);
  if (emp.rowCount === 0) return res.status(400).json({ error: 'ไม่พบพนักงานนี้ในบริษัทของคุณ' });

  // Control-budget check (rule #3) — see the matching check in POST /api/customer/project-costs.
  let budgetWarnings = [];
  try {
    const result = await checkBudgetControl(companyId, projectId || null, (workCode || '').trim() || null, Number(amount));
    budgetWarnings = result.warnings;
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO client_labor_costs (company_id, employee_id, project_id, work_date, days_worked, amount, work_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [companyId, employeeId, projectId || null, workDate, Number(daysWorked) || 0, Number(amount), (workCode || '').trim() || null, req.customer.id]
    );
    const laborCostId = insert.rows[0].id;
    await postClientLaborAccrualJournalEntry(client, {
      companyId, sourceId: laborCostId, projectId: projectId || null, description: `ค่าแรง: ${emp.rows[0].full_name} (${workDate})`,
      amount: Number(amount), entryDate: workDate, createdBy: req.customer.id,
    });
    await client.query('COMMIT');
    const r = await client.query(`SELECT ${CLIENT_LABOR_COST_SELECT_COLUMNS} FROM client_labor_costs WHERE id=$1`, [laborCostId]);
    res.json({ laborCost: serializeLaborCost(r.rows[0]), budgetWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกค่าแรงไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/labor-costs/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM client_labor_costs WHERE id=$1 AND company_id=$2 RETURNING id', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการค่าแรง' });
  res.json({ ok: true });
});

// "จ่ายค่าแรง" — settles an accrued labor cost: debit 2150 ค่าแรงค้างจ่าย / credit 1100 เงินสด.
// Guards against double payment with the same pattern as admin-panel's "จ่ายชำระเจ้าหนี้"
// (mark-paid) — 409 if payment_status isn't 'unpaid'. Does NOT swallow journal errors (same
// reasoning as release-retention above): booking the payment IS the point of this endpoint.
app.post('/api/customer/labor-costs/:id/mark-paid', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lc = await client.query(
      `SELECT lc.*, to_char(lc.work_date,'YYYY-MM-DD') AS work_date_str, e.full_name
       FROM client_labor_costs lc JOIN employees e ON e.id = lc.employee_id
       WHERE lc.id=$1 AND lc.company_id=$2 FOR UPDATE`, [id, companyId]
    );
    if (lc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบรายการค่าแรง' }); }
    const row = lc.rows[0];
    if (row.payment_status !== 'unpaid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'รายการนี้จ่ายค่าแรงไปแล้ว' });
    }
    const paidAt = new Date();
    await client.query(`UPDATE client_labor_costs SET payment_status='paid', paid_at=$1 WHERE id=$2`, [paidAt, id]);
    const amt = round2(row.amount);
    await createClientJournalEntry(client, {
      companyId, entryDate: paidAt.toISOString().slice(0, 10), description: `จ่ายค่าแรง: ${row.full_name} (${row.work_date_str})`,
      sourceType: 'labor', sourceId: id, projectId: row.project_id, createdBy: req.customer.id,
      lines: [
        { accountCode: '2150', debitAmount: amt, creditAmount: 0, description: `ค่าแรงค้างจ่าย - ${row.full_name}` },
        { accountCode: '1100', debitAmount: 0, creditAmount: amt, description: 'เงินสด' },
      ],
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[client-journal] Failed to mark labor cost paid', id, err);
    return res.status(500).json({ error: err.message || 'จ่ายค่าแรงไม่สำเร็จ' });
  } finally {
    client.release();
  }
  const r = await pool.query(`SELECT ${CLIENT_LABOR_COST_SELECT_COLUMNS} FROM client_labor_costs WHERE id=$1`, [id]);
  res.json({ laborCost: serializeLaborCost(r.rows[0]) });
});

// ---------------- Customer: client ledger — โครงการ (projects) ----------------
function serializeProject(row) {
  return {
    id: row.id, code: row.code, name: row.name, clientName: row.client_name, siteAddress: row.site_address,
    startDate: row.start_date, expectedEndDate: row.expected_end_date,
    budgetAmount: Number(row.budget_amount),
    defaultRetentionPercent: row.default_retention_percent !== null ? Number(row.default_retention_percent) : null,
    projectManagerEmployeeId: row.project_manager_employee_id, projectManagerName: row.pm_name || null,
    foremanEmployeeId: row.foreman_employee_id, foremanName: row.foreman_name || null,
    tenderId: row.tender_id, tenderNo: row.tender_no || null,
    status: row.status, note: row.note, createdBy: row.created_by, createdAt: row.created_at,
    biddingMethod: row.bidding_method, sectorType: row.sector_type, referencePrice: Number(row.reference_price),
    phoneNumber: row.phone_number, siteCoordinates: row.site_coordinates,
    submissionOpenDate: row.submission_open_date, submissionConditions: row.submission_conditions,
    installmentCount: row.installment_count,
  };
}

const CLIENT_PROJECT_SELECT = `
  SELECT cp.id, cp.code, cp.name, cp.client_name, cp.site_address,
    to_char(cp.start_date,'YYYY-MM-DD') AS start_date, to_char(cp.expected_end_date,'YYYY-MM-DD') AS expected_end_date,
    cp.budget_amount, cp.default_retention_percent,
    cp.project_manager_employee_id, pm.full_name AS pm_name,
    cp.foreman_employee_id, fm.full_name AS foreman_name,
    cp.tender_id, ct.tender_no,
    cp.status, cp.note, cp.created_by, cp.created_at,
    cp.bidding_method, cp.sector_type, cp.reference_price, cp.phone_number, cp.site_coordinates,
    to_char(cp.submission_open_date,'YYYY-MM-DD') AS submission_open_date,
    cp.submission_conditions, cp.installment_count
  FROM client_projects cp
  LEFT JOIN employees pm ON pm.id = cp.project_manager_employee_id
  LEFT JOIN employees fm ON fm.id = cp.foreman_employee_id
  LEFT JOIN client_tenders ct ON ct.id = cp.tender_id`;
const PROJECT_SECTOR_TYPES = ['government', 'private'];

// รายการงวดงาน for a project — identical shape/reasoning to serializeTenderInstallment/
// insertTenderInstallments (see those for the "always rewritten as a whole set" comment).
function serializeProjectInstallment(row) {
  return {
    id: row.id, projectId: row.project_id, installmentNo: row.installment_no,
    description: row.description, amount: Number(row.amount), daysToComplete: row.days_to_complete,
  };
}
async function insertProjectInstallments(client, companyId, projectId, installments) {
  const rows = Array.isArray(installments) ? installments : [];
  for (let i = 0; i < rows.length; i++) {
    const inst = rows[i] || {};
    await client.query(
      `INSERT INTO client_project_installments (company_id, project_id, installment_no, description, amount, days_to_complete)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, projectId, i + 1, String(inst.description || '').trim(), Number(inst.amount) || 0, parseInt(inst.daysToComplete, 10) || 0]
    );
  }
  return rows.length;
}

async function generateClientProjectCode(client, companyId) {
  const year = new Date().getFullYear() + 543; // Buddhist Era, matching every other document-number generator in this codebase
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await client.query('SELECT COUNT(*)::int AS n FROM client_projects WHERE company_id=$1', [companyId]);
    const code = `PRJ-${year}-` + String(countRes.rows[0].n + 1 + attempt).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_projects WHERE company_id=$1 AND code=$2', [companyId, code]);
    if (exists.rowCount === 0) return code;
  }
  throw new Error('ไม่สามารถสร้างรหัสโครงการได้');
}

app.get('/api/customer/projects', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query(`${CLIENT_PROJECT_SELECT} WHERE cp.company_id=$1 ORDER BY cp.id DESC`, [companyId]);
  res.json({ projects: r.rows.map(serializeProject) });
});

app.get('/api/customer/projects/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(`${CLIENT_PROJECT_SELECT} WHERE cp.id=$1 AND cp.company_id=$2`, [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const installments = await pool.query(
    `SELECT * FROM client_project_installments WHERE project_id=$1 AND company_id=$2 ORDER BY installment_no`,
    [id, req.customer.company_id]
  );
  res.json({ project: serializeProject(r.rows[0]), installments: installments.rows.map(serializeProjectInstallment) });
});

app.post('/api/customer/projects', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const {
    code, name, clientName, siteAddress, startDate, expectedEndDate, budgetAmount,
    defaultRetentionPercent, projectManagerEmployeeId, foremanEmployeeId, tenderId, status, note,
    biddingMethod, sectorType, referencePrice, phoneNumber, siteCoordinates,
    submissionOpenDate, submissionConditions, installments,
  } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อโครงการ' });
  if (startDate && expectedEndDate && expectedEndDate < startDate) {
    return res.status(400).json({ error: 'วันที่คาดว่าจะแล้วเสร็จต้องไม่มาก่อนวันที่เริ่มโครงการ' });
  }
  // เหมือน client_tenders เป๊ะ: sector_type ตัดสินว่า reference_price มีผลหรือไม่ (budget_amount ใช้
  // เป็นค่าเดียวกันทั้งสองกรณีอยู่แล้ว ไม่ต้องมี field มูลค่างานแยกต่างหากแบบ estimated_value ของ tender)
  if (!PROJECT_SECTOR_TYPES.includes(sectorType)) {
    return res.status(400).json({ error: 'กรุณาเลือกประเภทหน่วยงาน (ภาครัฐ/เอกชน)' });
  }
  const isGov = sectorType === 'government';
  const finalReferencePrice = isGov ? (Number(referencePrice) || 0) : 0;
  const allowedStatus = ['in_progress', 'completed', 'on_hold', 'cancelled'];
  const safeStatus = allowedStatus.includes(status) ? status : 'in_progress';

  // Any employee reference must belong to this company — same guard used for labor-cost creation.
  for (const [label, empId] of [['ผู้จัดการโครงการ', projectManagerEmployeeId], ['โฟร์แมน', foremanEmployeeId]]) {
    if (empId) {
      const emp = await pool.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2', [empId, companyId]);
      if (emp.rowCount === 0) return res.status(400).json({ error: `ไม่พบ${label}นี้ในบริษัทของคุณ` });
    }
  }
  let tender = null;
  if (tenderId) {
    const t = await pool.query('SELECT * FROM client_tenders WHERE id=$1 AND company_id=$2', [tenderId, companyId]);
    if (t.rowCount === 0) return res.status(400).json({ error: 'ไม่พบ Tender นี้ในบริษัทของคุณ' });
    tender = t.rows[0];
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Idempotency backstop, same reasoning/window as POST /api/customer/tenders: a rapid double-submit
    // (before the frontend's own S.projectSaving-disabled-button guard paints) would otherwise create
    // several near-identical projects. Hand back the existing one instead of inserting a duplicate.
    const recentDup = await client.query(
      `SELECT id FROM client_projects
       WHERE company_id=$1 AND created_by=$2 AND name=$3 AND client_name=$4
         AND budget_amount=$5 AND tender_id IS NOT DISTINCT FROM $6 AND note=$7
         AND created_at > now() - interval '10 seconds'
       ORDER BY id ASC LIMIT 1`,
      [companyId, req.customer.id, name.trim(), (clientName || '').trim(),
        Number(budgetAmount) || 0, tenderId || null, (note || '').trim()]
    );
    if (recentDup.rowCount > 0) {
      await client.query('ROLLBACK');
      const r = await pool.query(`${CLIENT_PROJECT_SELECT} WHERE cp.id=$1`, [recentDup.rows[0].id]);
      return res.json({ project: serializeProject(r.rows[0]) });
    }
    const trimmedCode = (code || '').trim();
    const finalCode = trimmedCode || await generateClientProjectCode(client, companyId);
    const dup = await client.query('SELECT 1 FROM client_projects WHERE company_id=$1 AND code=$2', [companyId, finalCode]);
    if (dup.rowCount > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'รหัสโครงการนี้มีอยู่แล้ว' }); }
    const insert = await client.query(
      `INSERT INTO client_projects (company_id, code, name, client_name, site_address, start_date, expected_end_date,
         budget_amount, default_retention_percent, project_manager_employee_id, foreman_employee_id, tender_id, status, note, created_by,
         bidding_method, sector_type, reference_price, phone_number, site_coordinates,
         submission_open_date, submission_conditions, installment_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
      [companyId, finalCode, name.trim(), (clientName || '').trim(), (siteAddress || '').trim(),
       startDate || null, expectedEndDate || null, Number(budgetAmount) || 0,
       (defaultRetentionPercent !== undefined && defaultRetentionPercent !== null && defaultRetentionPercent !== '') ? Number(defaultRetentionPercent) : null,
       projectManagerEmployeeId || null, foremanEmployeeId || null, tenderId || null, safeStatus, (note || '').trim(), req.customer.id,
       (biddingMethod || '').trim(), sectorType, finalReferencePrice, (phoneNumber || '').trim(), (siteCoordinates || '').trim(),
       submissionOpenDate || null, (submissionConditions || '').trim(), Array.isArray(installments) ? installments.length : 0]
    );
    const projectId = insert.rows[0].id;
    await insertProjectInstallments(client, companyId, projectId, installments);
    await client.query('COMMIT');
    // Business rule #1: if this project is linked to a tender that was ALREADY won before the
    // project existed (the reverse order from the usual tender-status-change trigger below), carry
    // the bidding budget forward now instead of never at all.
    if (tender && tender.status === 'won') {
      await copyBiddingBudgetToProjectBudget(companyId, tender.id, projectId, req.customer.id);
    }
    const r = await pool.query(`${CLIENT_PROJECT_SELECT} WHERE cp.id=$1`, [projectId]);
    res.json({ project: serializeProject(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกโครงการไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ================================================================================================
// Customer: แผนงาน (Gantt) — Phase 1: WBS/Task list + dependencies + baseline. See schema.sql's
// "แผนงาน (Gantt) — Phase 1" section for the table design. Accessible for ANY existing project
// regardless of tender origin/status — no gate beyond "this project belongs to my company", per
// explicit confirmation (requireOwnedProject below is the only access check, same as every other
// project-scoped endpoint in this file).
// ================================================================================================
async function requireOwnedProject(companyId, projectId) {
  const r = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
  return r.rowCount > 0;
}
// 'YYYY-MM-DD' + n calendar days -> 'YYYY-MM-DD', done in UTC so it's never off-by-one around a
// local-timezone midnight (Phase 1 uses plain calendar days, not a working-day calendar — see
// schema.sql's Phase-1 decision #5).
function addCalendarDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// actualDurationDays — always derived here from actual_end_date/actual_start_date (never its own
// column, see schema.sql's comment on these fields), same "end - start + 1" day-count convention
// durationDays already uses (addCalendarDays() above). null when either actual date is missing —
// distinct from 0, which would misleadingly read as "started and finished the same non-existent day".
function serializeTask(row) {
  const actualDurationDays = (row.actual_start_date && row.actual_end_date)
    ? Math.round((new Date(row.actual_end_date + 'T00:00:00Z') - new Date(row.actual_start_date + 'T00:00:00Z')) / 86400000) + 1
    : null;
  return {
    id: row.id, projectId: row.project_id, parentTaskId: row.parent_task_id, wbsCode: row.wbs_code,
    taskName: row.task_name, durationDays: row.duration_days,
    startDate: row.start_date, endDate: row.end_date, percentComplete: row.percent_complete,
    isMilestone: row.is_milestone, sortOrder: row.sort_order, isSummary: !!row.is_summary,
    sourceBoqItemId: row.source_boq_item_id, budgetAmount: Number(row.budget_amount),
    actualStartDate: row.actual_start_date, actualEndDate: row.actual_end_date, actualDurationDays,
    actualAmount: Number(row.actual_amount), actualPercent: Number(row.actual_percent),
  };
}
// start_date/end_date as to_char'd strings, not raw DATE values — node-postgres' default DATE type
// parser returns a local-midnight JS Date, which JSON.stringify (via .toISOString()) then serializes
// shifted by the server's UTC offset (e.g. "2026-08-01" became "2026-07-31T17:00:00.000Z" on this
// UTC+7 machine). Every other date-bearing SELECT in this file already does this (see
// CLIENT_TENDER_SELECT) — this one just needs it applied to a join'd is_summary column too.
const CLIENT_PROJECT_TASK_SELECT = `
  SELECT id, project_id, parent_task_id, wbs_code, task_name, duration_days,
    to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
    percent_complete, is_milestone, sort_order, source_boq_item_id, budget_amount,
    to_char(actual_start_date,'YYYY-MM-DD') AS actual_start_date, to_char(actual_end_date,'YYYY-MM-DD') AS actual_end_date,
    actual_amount, actual_percent,
    EXISTS(SELECT 1 FROM client_project_tasks c WHERE c.parent_task_id=t.id) AS is_summary
  FROM client_project_tasks t`;
function serializeTaskDependency(row) {
  return {
    id: row.id, taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id,
    dependencyType: row.dependency_type, lagDays: row.lag_days,
  };
}
function serializeTaskBaseline(row) {
  return { taskId: row.task_id, baselineStart: row.baseline_start, baselineEnd: row.baseline_end, baselineSetAt: row.baseline_set_at };
}
// "วันที่ Update ล่าสุด" on the แผนงาน print header (pr-system.html's renderSchedulePrintHeader()) —
// touched by every endpoint that changes what actually shows up on the printed schedule: task
// create/edit/delete and the periods bulk-save. Deliberately narrower than "any edit to this project" —
// editing the project's name/client/etc. elsewhere does NOT touch this column, only schedule-relevant
// mutations do.
async function touchProjectScheduleUpdatedAt(client, companyId, projectId) {
  await client.query('UPDATE client_projects SET schedule_updated_at=now() WHERE company_id=$1 AND id=$2', [companyId, projectId]);
}
// Recomputes wbs_code ("1", "1.1", "1.2", "2", ...) for every task in the project from scratch,
// walking parent_task_id/sort_order — called after any create/update(reparent)/delete/reorder so
// wbs_code (a cached display column, never client-supplied — see schema.sql) can never drift from
// the actual tree shape. Small per-company/per-project task counts expected (WBS trees, not bulk
// data), so a full recompute each time is simpler and safer than incrementally patching numbers.
async function recomputeProjectTaskWbs(client, companyId, projectId) {
  const r = await client.query(
    'SELECT id, parent_task_id, sort_order FROM client_project_tasks WHERE company_id=$1 AND project_id=$2',
    [companyId, projectId]
  );
  const byParent = new Map(); // parent_task_id (or null) -> [rows], sorted by sort_order
  for (const row of r.rows) {
    const key = row.parent_task_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort_order - b.sort_order);
  const updates = [];
  (function walk(parentId, prefix) {
    const children = byParent.get(parentId) || [];
    children.forEach((row, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      updates.push([row.id, code]);
      walk(row.id, code);
    });
  })(null, '');
  for (const [id, code] of updates) {
    await client.query('UPDATE client_project_tasks SET wbs_code=$1 WHERE id=$2', [code, id]);
  }
}
// True if `candidateId` is `taskId` itself or one of its descendants — used to reject a reparent
// that would create a cycle (a task can never become its own ancestor).
async function isTaskOrDescendant(client, companyId, projectId, taskId, candidateId) {
  if (taskId === candidateId) return true;
  const r = await client.query(
    'SELECT id, parent_task_id FROM client_project_tasks WHERE company_id=$1 AND project_id=$2',
    [companyId, projectId]
  );
  const childrenOf = new Map();
  for (const row of r.rows) {
    if (!childrenOf.has(row.parent_task_id)) childrenOf.set(row.parent_task_id, []);
    childrenOf.get(row.parent_task_id).push(row.id);
  }
  const stack = [...(childrenOf.get(taskId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (id === candidateId) return true;
    stack.push(...(childrenOf.get(id) || []));
  }
  return false;
}

// ---------------- Phase 2: Critical Path Method (CPM) + auto-schedule ----------------
// Everything below works in integer "day numbers" (days since a fixed arbitrary epoch), never raw
// Date objects/strings, specifically to sidestep the local-timezone pg-Date pitfall documented on
// CLIENT_PROJECT_TASK_SELECT above (a Date object's implied timezone has no business anywhere in
// pure calendar-day arithmetic). Date strings only exist at the two edges: parsing start_date in,
// formatting a result out.
const CPM_EPOCH_MS = Date.UTC(2000, 0, 1);
function dateToDayNum(dateStr) {
  return Math.round((new Date(dateStr + 'T00:00:00Z').getTime() - CPM_EPOCH_MS) / 86400000);
}
function dayNumToDate(n) {
  return new Date(CPM_EPOCH_MS + n * 86400000).toISOString().slice(0, 10);
}

// Pure function — no DB access. tasks: [{id, durationDays, isMilestone, startDate}], deps:
// [{taskId, dependsOnTaskId, dependencyType, lagDays}]. Returns Map<taskId, {earlyStart, earlyFinish,
// lateStart, lateFinish, totalFloat, isCritical}> — earlyFinish/lateFinish are already adjusted back
// to the INCLUSIVE "last active day" convention client_project_tasks.end_date uses everywhere else
// (start+duration-1, or start itself for a 0-duration milestone), not the exclusive day-count used
// internally for the S/F constraint math. Any value is null when that task can't be scheduled at all
// (see the Phase-2 plan's "unscheduled task" rule) — never NaN/Infinity, never throws.
//
// task_id/depends_on_task_id here reads as: taskId depends on dependsOnTaskId, i.e. graph edge
// dependsOnTaskId -> taskId (dependsOnTaskId is the predecessor). "successors of X" below always
// means "tasks that have X as a predecessor", the natural forward-scheduling direction.
function computeProjectSchedule(tasks, deps) {
  const durationOf = new Map(tasks.map(t => [t.id, t.isMilestone ? 0 : Math.max(0, t.durationDays || 0)]));
  const anchorOf = new Map(tasks.map(t => [t.id, t.startDate ? dateToDayNum(t.startDate) : null]));
  const predecessorsOf = new Map(), successorsOf = new Map();
  for (const d of deps) {
    if (!predecessorsOf.has(d.taskId)) predecessorsOf.set(d.taskId, []);
    predecessorsOf.get(d.taskId).push(d);
    if (!successorsOf.has(d.dependsOnTaskId)) successorsOf.set(d.dependsOnTaskId, []);
    successorsOf.get(d.dependsOnTaskId).push(d);
  }
  const hasPredecessor = new Set(deps.map(d => d.taskId));

  // Kahn's-algorithm topological order over the (guaranteed-acyclic, per wouldCreateCycle at insert
  // time — but this still degrades gracefully rather than infinite-looping if that guarantee were
  // ever violated) dependency graph.
  const inDegree = new Map(tasks.map(t => [t.id, (predecessorsOf.get(t.id) || []).length]));
  const queue = tasks.filter(t => inDegree.get(t.id) === 0).map(t => t.id);
  const order = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const succDep of (successorsOf.get(id) || [])) {
      const succId = succDep.taskId;
      inDegree.set(succId, inDegree.get(succId) - 1);
      if (inDegree.get(succId) === 0) queue.push(succId);
    }
  }
  // Any task not reached (would only happen if the DAG guarantee were somehow violated) is treated
  // as unscheduled rather than processed — appended at the end so every task still gets an entry.
  for (const t of tasks) if (!seen.has(t.id)) order.push(t.id);

  const ES = new Map(), EF = new Map();
  for (const id of order) {
    const duration = durationOf.get(id) || 0;
    let es;
    if (hasPredecessor.has(id)) {
      let best = null;
      for (const d of predecessorsOf.get(id)) {
        const predEF = EF.get(d.dependsOnTaskId), predES = ES.get(d.dependsOnTaskId);
        if (predEF == null || predES == null) continue; // unscheduled predecessor contributes nothing
        const succDuration = duration;
        let candidate;
        if (d.dependencyType === 'SS') candidate = predES + d.lagDays;
        else if (d.dependencyType === 'FF') candidate = predEF + d.lagDays - succDuration;
        else if (d.dependencyType === 'SF') candidate = predES + d.lagDays - succDuration;
        else candidate = predEF + d.lagDays; // FS (default)
        if (best === null || candidate > best) best = candidate;
      }
      es = best; // null if every predecessor was unscheduled
    } else {
      es = anchorOf.get(id); // root task: its own start_date is the anchor (null = not set yet)
    }
    ES.set(id, es);
    EF.set(id, es == null ? null : es + duration);
  }

  const scheduledEFs = [...EF.values()].filter(v => v != null);
  const projectFinish = scheduledEFs.length ? Math.max(...scheduledEFs) : null;

  const LF = new Map(), LS = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const duration = durationOf.get(id) || 0;
    if (EF.get(id) == null) { LF.set(id, null); LS.set(id, null); continue; } // unscheduled stays unscheduled
    const succs = successorsOf.get(id) || [];
    let lf;
    if (succs.length === 0) {
      lf = projectFinish;
    } else {
      let best = null;
      for (const d of succs) {
        const succLF = LF.get(d.taskId), succLS = LS.get(d.taskId);
        if (succLF == null || succLS == null) continue; // unscheduled successor contributes nothing
        let candidate;
        if (d.dependencyType === 'SS') candidate = (succLS - d.lagDays) + duration;
        else if (d.dependencyType === 'FF') candidate = succLF - d.lagDays;
        else if (d.dependencyType === 'SF') candidate = (succLF - d.lagDays) + duration;
        else candidate = succLS - d.lagDays; // FS (default)
        if (best === null || candidate < best) best = candidate;
      }
      lf = best === null ? projectFinish : best; // no scheduled successors after all -> treat as terminal
    }
    LF.set(id, lf);
    LS.set(id, lf == null ? null : lf - duration);
  }

  const result = new Map();
  for (const t of tasks) {
    const es = ES.get(t.id), ef = EF.get(t.id), ls = LS.get(t.id), lf = LF.get(t.id);
    const duration = durationOf.get(t.id) || 0;
    // Convert exclusive-finish day numbers back to the inclusive "last active day" convention
    // (matches addCalendarDays(start, duration-1) elsewhere) — a 0-duration milestone's finish
    // equals its start either way, so no separate branch is needed for that case.
    const toInclusiveFinish = (finishExclusive) => finishExclusive == null ? null : dayNumToDate(duration > 0 ? finishExclusive - 1 : finishExclusive);
    const totalFloat = (es != null && ls != null) ? (ls - es) : null;
    result.set(t.id, {
      earlyStart: es == null ? null : dayNumToDate(es),
      earlyFinish: toInclusiveFinish(ef),
      lateStart: ls == null ? null : dayNumToDate(ls),
      lateFinish: toInclusiveFinish(lf),
      totalFloat,
      isCritical: totalFloat === 0,
    });
  }
  return result;
}

// Recomputes the CPM schedule and PERSISTS the early (ASAP) start/finish as the real start_date/
// end_date for every task that has ≥1 predecessor — late dates only ever feed totalFloat/isCritical
// (computed fresh on every GET, never persisted — see the Phase-2 plan). Tasks with zero
// predecessors are never touched here; their start_date stays a plain user-editable anchor exactly
// like Phase 1. Called after every task/dependency mutation (create/update/delete/reorder task, add/
// remove dependency) in the same transaction as recomputeProjectTaskWbs.
async function applyAutoSchedule(client, companyId, projectId) {
  const tasksRes = await client.query(
    `SELECT id, duration_days, is_milestone, to_char(start_date,'YYYY-MM-DD') AS start_date
     FROM client_project_tasks WHERE company_id=$1 AND project_id=$2`,
    [companyId, projectId]
  );
  const tasks = tasksRes.rows.map(r => ({ id: r.id, durationDays: r.duration_days, isMilestone: r.is_milestone, startDate: r.start_date }));
  const depsRes = await client.query(
    `SELECT d.task_id, d.depends_on_task_id, d.dependency_type, d.lag_days
     FROM client_project_task_dependencies d
     JOIN client_project_tasks t ON t.id=d.task_id WHERE d.company_id=$1 AND t.project_id=$2`,
    [companyId, projectId]
  );
  const deps = depsRes.rows.map(r => ({ taskId: r.task_id, dependsOnTaskId: r.depends_on_task_id, dependencyType: r.dependency_type, lagDays: r.lag_days }));
  const hasPredecessor = new Set(deps.map(d => d.taskId));
  const schedule = computeProjectSchedule(tasks, deps);
  for (const t of tasks) {
    if (!hasPredecessor.has(t.id)) continue;
    const s = schedule.get(t.id);
    await client.query('UPDATE client_project_tasks SET start_date=$1, end_date=$2 WHERE id=$3', [s.earlyStart, s.earlyFinish, t.id]);
  }
}

// BFS cycle check for a proposed new dependency edge (dependsOnTaskId -> taskId, i.e. taskId would
// depend on dependsOnTaskId). Adding it closes a cycle iff dependsOnTaskId is already reachable FROM
// taskId via existing edges (taskId already, directly or transitively, precedes dependsOnTaskId) —
// see the Phase-2 plan's worked example. Replaces Phase 1's "NOTE: TODO Phase 2" placeholder.
async function wouldCreateCycle(companyId, projectId, taskId, dependsOnTaskId) {
  const r = await pool.query(
    `SELECT d.task_id, d.depends_on_task_id FROM client_project_task_dependencies d
     JOIN client_project_tasks t ON t.id=d.task_id WHERE d.company_id=$1 AND t.project_id=$2`,
    [companyId, projectId]
  );
  const successorsOf = new Map(); // depends_on_task_id -> [task_id, ...] ("things that come after X")
  for (const row of r.rows) {
    if (!successorsOf.has(row.depends_on_task_id)) successorsOf.set(row.depends_on_task_id, []);
    successorsOf.get(row.depends_on_task_id).push(row.task_id);
  }
  const visited = new Set([taskId]);
  const queue = [taskId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === dependsOnTaskId) return true;
    for (const next of (successorsOf.get(cur) || [])) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return false;
}

app.get('/api/customer/projects/:projectId/tasks', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const [tasks, deps, baseline, periods, project] = await Promise.all([
    pool.query(
      `${CLIENT_PROJECT_TASK_SELECT} WHERE t.company_id=$1 AND t.project_id=$2 ORDER BY t.sort_order`,
      [companyId, projectId]
    ),
    pool.query(
      `SELECT d.* FROM client_project_task_dependencies d
       JOIN client_project_tasks t ON t.id=d.task_id WHERE d.company_id=$1 AND t.project_id=$2`,
      [companyId, projectId]
    ),
    pool.query(
      `SELECT b.task_id, to_char(b.baseline_start,'YYYY-MM-DD') AS baseline_start, to_char(b.baseline_end,'YYYY-MM-DD') AS baseline_end, b.baseline_set_at
       FROM client_project_task_baseline b
       JOIN client_project_tasks t ON t.id=b.task_id WHERE b.company_id=$1 AND t.project_id=$2`,
      [companyId, projectId]
    ),
    pool.query(
      `SELECT p.task_id, to_char(p.period_date,'YYYY-MM-DD') AS period_date, p.planned_percent, p.actual_percent
       FROM client_project_task_periods p
       JOIN client_project_tasks t ON t.id=p.task_id WHERE p.company_id=$1 AND t.project_id=$2`,
      [companyId, projectId]
    ),
    pool.query('SELECT schedule_updated_at FROM client_projects WHERE company_id=$1 AND id=$2', [companyId, projectId]),
  ]);
  // CPM fields (earlyStart/earlyFinish/lateStart/lateFinish/totalFloat/isCritical) are computed
  // fresh here every time, never persisted — see the Phase-2 plan on why (start_date/end_date ARE
  // persisted, as the cascade's actual output; these are pure derived analytics on top of that).
  const scheduleInput = tasks.rows.map(r => ({ id: r.id, durationDays: r.duration_days, isMilestone: r.is_milestone, startDate: r.start_date }));
  const depsForSchedule = deps.rows.map(r => ({ taskId: r.task_id, dependsOnTaskId: r.depends_on_task_id, dependencyType: r.dependency_type, lagDays: r.lag_days }));
  const schedule = computeProjectSchedule(scheduleInput, depsForSchedule);
  res.json({
    tasks: tasks.rows.map(r => ({ ...serializeTask(r), ...schedule.get(r.id) })),
    dependencies: deps.rows.map(serializeTaskDependency),
    baselines: baseline.rows.map(serializeTaskBaseline),
    periods: periods.rows.map(r => ({
      taskId: r.task_id, periodDate: r.period_date,
      plannedPercent: Number(r.planned_percent), actualPercent: Number(r.actual_percent),
    })),
    scheduleUpdatedAt: project.rows[0] ? project.rows[0].schedule_updated_at : null,
  });
});

// แผนงาน Phase 2: bulk save every แผนงาน/ผลงาน %-per-day cell for the whole project in one call, same
// full-replace convention as insertFreshBoqItems (delete everything for this project's tasks, then
// reinsert only the nonzero cells) — matches this table's own "edit many cells, one save button"
// pattern (taskTableHasUnsavedChanges()-style) rather than one request per cell. Body:
// { periods: [{ taskId, periodDate:'YYYY-MM-DD', plannedPercent, actualPercent }, ...] } — a day with
// both values 0 can simply be omitted by the client (equivalent either way; omitted here too, to keep
// the table lean).
// Per-task sum validation (แต่ละแถวรวมกันได้ไม่เกิน 100%) happens here, across ALL rows for that task in
// the submitted payload — not per-row — since a single cell is never over 100 on its own (the CHECK
// constraint on the column already guards that), it's the SUM across a task's period row that matters.
app.put('/api/customer/projects/:projectId/tasks/periods', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const rows = Array.isArray((req.body || {}).periods) ? req.body.periods : [];

  const projectTasks = await pool.query('SELECT id, task_name FROM client_project_tasks WHERE company_id=$1 AND project_id=$2', [companyId, projectId]);
  const taskNameById = new Map(projectTasks.rows.map(r => [r.id, r.task_name]));

  const clean = [];
  const plannedSumByTask = new Map(), actualSumByTask = new Map();
  for (const row of rows) {
    const taskId = parseInt(row.taskId, 10);
    if (!taskNameById.has(taskId)) return res.status(400).json({ error: 'พบ Task ที่ไม่ใช่ของโครงการนี้' });
    const periodDate = /^\d{4}-\d{2}-\d{2}$/.test(row.periodDate || '') ? row.periodDate : null;
    if (!periodDate) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
    const planned = Math.min(100, Math.max(0, Number(row.plannedPercent) || 0));
    const actual = Math.min(100, Math.max(0, Number(row.actualPercent) || 0));
    if (planned === 0 && actual === 0) continue;
    clean.push({ taskId, periodDate, planned, actual });
    plannedSumByTask.set(taskId, Math.round(((plannedSumByTask.get(taskId) || 0) + planned) * 100) / 100);
    actualSumByTask.set(taskId, Math.round(((actualSumByTask.get(taskId) || 0) + actual) * 100) / 100);
  }
  for (const [taskId, sum] of plannedSumByTask) {
    if (sum > 100.01) return res.status(400).json({ error: `"${taskNameById.get(taskId)}" มี % แผนงานรวมกันเกิน 100% (รวม ${sum}%)` });
  }
  for (const [taskId, sum] of actualSumByTask) {
    if (sum > 100.01) return res.status(400).json({ error: `"${taskNameById.get(taskId)}" มี % ผลงานรวมกันเกิน 100% (รวม ${sum}%)` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM client_project_task_periods WHERE company_id=$1 AND task_id IN (SELECT id FROM client_project_tasks WHERE company_id=$1 AND project_id=$2)`,
      [companyId, projectId]
    );
    for (const row of clean) {
      await client.query(
        `INSERT INTO client_project_task_periods (company_id, task_id, period_date, planned_percent, actual_percent) VALUES ($1,$2,$3,$4,$5)`,
        [companyId, row.taskId, row.periodDate, row.planned, row.actual]
      );
    }
    await touchProjectScheduleUpdatedAt(client, companyId, projectId);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกแผนงาน/ผลงานไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// Powers the unified task table's "ดึงรายการ BOQ ทั้งหมด" pull-all (pr-system.html): only BOQ line
// items that are (1) on the project's currently-APPROVED budget revision — client_budgets.current_revision_id
// only ever repoints at an approved revision (see the approve-budget endpoint above), so joining
// through it already excludes draft/pending_approval/rejected without needing a separate status filter,
// kept here anyway (br.status='approved') purely as defense-in-depth against that invariant ever
// changing — (2) not a group/header row (is_group=false — real work lines only), and (3) not already
// linked to a task in this project.
//
// "Already linked" checks BOTH the exact row id AND (when work_code is non-blank) any OTHER item row
// in the SAME budget's revision history sharing that work_code. This matters because revising a budget
// (copyBoqItems, or a plain PUT .../items save on a draft) always mints brand-new client_budget_items
// rows — even for lines that didn't change — so a task linked to revision N's item id would otherwise
// look "unlinked" again once revision N+1 gets approved, letting the exact same line get pulled in and
// duplicated as a second task. Matching on work_code within the budget's own revision lineage is a
// pragmatic stand-in for a real persistent per-line identity (this schema has none — every revision
// save is a full delete+reinsert, see insertFreshBoqItems/copyBoqItems); blank work_codes are excluded
// from the cross-revision match (falls back to exact-id-only) since duplicate blanks would otherwise
// cause false-positive exclusions.
app.get('/api/customer/projects/:projectId/available-boq-items-for-task', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const r = await pool.query(
    `SELECT bi.id, bi.work_code, bi.description, bi.unit, bi.qty, bi.amount
     FROM client_budget_items bi
     JOIN client_budget_revisions br ON br.id = bi.revision_id
     JOIN client_budgets b ON b.id = br.budget_id
     WHERE b.company_id=$1 AND b.project_id=$2
       AND b.current_revision_id = bi.revision_id
       AND br.status = 'approved'
       AND bi.is_group = false
       AND NOT EXISTS (
         SELECT 1 FROM client_project_tasks t
         JOIN client_budget_items used ON used.id = t.source_boq_item_id
         WHERE t.company_id=$1 AND t.project_id=$2
           AND used.revision_id IN (SELECT id FROM client_budget_revisions WHERE budget_id = b.id)
           AND (used.id = bi.id OR (bi.work_code <> '' AND used.work_code = bi.work_code))
       )
     ORDER BY bi.idx, bi.id`,
    [companyId, projectId]
  );
  res.json({
    items: r.rows.map(row => ({
      id: row.id, workCode: row.work_code, description: row.description, unit: row.unit, qty: Number(row.qty),
      amount: Number(row.amount),
    })),
  });
});

app.post('/api/customer/projects/:projectId/tasks', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const { parentTaskId, taskName, durationDays, startDate, isMilestone, budgetAmount } = req.body || {};
  if (!taskName || !taskName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่องาน' });
  let parentId = parentTaskId ? parseInt(parentTaskId, 10) : null;
  if (parentId) {
    const p = await pool.query('SELECT 1 FROM client_project_tasks WHERE id=$1 AND company_id=$2 AND project_id=$3', [parentId, companyId, projectId]);
    if (p.rowCount === 0) return res.status(400).json({ error: 'ไม่พบ Parent Task นี้ในโครงการนี้' });
  }
  const milestone = !!isMilestone;
  const duration = milestone ? 0 : Math.max(1, parseInt(durationDays, 10) || 1);
  const start = startDate || null;
  const end = start ? addCalendarDays(start, milestone ? 0 : duration - 1) : null;
  // งบประมาณ (บาท) — optional, only ever sent by the แผนงาน table's manual "+ เพิ่มข้อมูล" entry rows
  // (pr-system.html); every other caller of this endpoint (the old free-text single-task add, this
  // project's own regression tests) omits it and gets the column's normal 0 default. No live link to
  // any BOQ item — this is a plain user-typed number, same snapshot-style column POST .../tasks/batch
  // already writes for BOQ-sourced tasks, just entered by hand instead of copied from a budget line.
  const budget = Math.max(0, Number(budgetAmount) || 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const maxOrder = await client.query(
      'SELECT COALESCE(MAX(sort_order),-1) AS m FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 AND parent_task_id IS NOT DISTINCT FROM $3',
      [companyId, projectId, parentId]
    );
    const sortOrder = maxOrder.rows[0].m + 1;
    const ins = await client.query(
      `INSERT INTO client_project_tasks (company_id, project_id, parent_task_id, task_name, duration_days, start_date, end_date, is_milestone, sort_order, created_by, budget_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, projectId, parentId, taskName.trim(), duration, start, end, milestone, sortOrder, req.customer.id, budget]
    );
    await recomputeProjectTaskWbs(client, companyId, projectId);
    await applyAutoSchedule(client, companyId, projectId);
    await touchProjectScheduleUpdatedAt(client, companyId, projectId);
    await client.query('COMMIT');
    const r = await pool.query(`${CLIENT_PROJECT_TASK_SELECT} WHERE t.id=$1`, [ins.rows[0].id]);
    res.json({ task: serializeTask(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างงานไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// Batch task creation for the "+ เพิ่ม Task" table (pr-system.html's task-batch-add modal) — every row
// must reference an approved, non-group BOQ item (sourceBoqItemId), never a free-text name; taskName
// itself is never trusted from the client, it's always looked up from client_budget_items.description
// server-side so it can't drift from the BOQ item it's supposedly sourced from. Body:
// { tasks: [{ sourceBoqItemId, durationDays }, ...] }. All rows insert as top-level (no parentTaskId —
// the batch table has no parent picker) in one transaction, with wbs_code/CPM schedule recomputed once
// at the end rather than per-row.
app.post('/api/customer/projects/:projectId/tasks/batch', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const rows = Array.isArray((req.body || {}).tasks) ? req.body.tasks : [];
  if (rows.length === 0) return res.status(400).json({ error: 'ไม่มีรายการที่จะเพิ่ม' });

  const boqItemIds = [];
  const durations = [];
  for (const row of rows) {
    const boqItemId = parseInt(row.sourceBoqItemId, 10);
    if (!boqItemId) return res.status(400).json({ error: 'กรุณาเลือกรายการ BOQ ให้ครบทุกแถว' });
    boqItemIds.push(boqItemId);
    durations.push(Math.max(1, parseInt(row.durationDays, 10) || 1));
  }
  if (new Set(boqItemIds).size !== boqItemIds.length) {
    return res.status(400).json({ error: 'เลือกรายการ BOQ ซ้ำกันในตารางเดียวกัน' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-validate against the exact same "available" rules as GET .../available-boq-items-for-task,
    // inside the transaction (FOR UPDATE OF bi) — catches a race where two tabs/requests pick the same
    // item at once, instead of silently double-linking it.
    const avail = await client.query(
      `SELECT bi.id, bi.description, bi.amount
       FROM client_budget_items bi
       JOIN client_budget_revisions br ON br.id = bi.revision_id
       JOIN client_budgets b ON b.id = br.budget_id
       WHERE b.company_id=$1 AND b.project_id=$2
         AND b.current_revision_id = bi.revision_id
         AND br.status = 'approved'
         AND bi.is_group = false
         AND bi.id = ANY($3::int[])
         AND NOT EXISTS (
           SELECT 1 FROM client_project_tasks t
           JOIN client_budget_items used ON used.id = t.source_boq_item_id
           WHERE t.company_id=$1 AND t.project_id=$2
             AND used.revision_id IN (SELECT id FROM client_budget_revisions WHERE budget_id = b.id)
             AND (used.id = bi.id OR (bi.work_code <> '' AND used.work_code = bi.work_code))
         )
       FOR UPDATE OF bi`,
      [companyId, projectId, boqItemIds]
    );
    if (avail.rowCount !== boqItemIds.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'บางรายการ BOQ ถูกเลือกไปแล้วหรือไม่พร้อมใช้งาน กรุณาเปิดตารางเพิ่ม Task ใหม่อีกครั้ง' });
    }
    const descById = new Map(avail.rows.map(r => [r.id, r.description]));
    // budget_amount is a SNAPSHOT taken here, at pull time — not re-synced if the BOQ is revised later
    // (see schema.sql's comment on this column). A task's planned budget staying fixed once scheduling
    // work has started was judged safer than silently reshuffling every task's งบประมาณ(%) mid-project.
    const amountById = new Map(avail.rows.map(r => [r.id, Number(r.amount)]));

    const maxOrder = await client.query(
      'SELECT COALESCE(MAX(sort_order),-1) AS m FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 AND parent_task_id IS NULL',
      [companyId, projectId]
    );
    let nextOrder = maxOrder.rows[0].m + 1;
    const insertedIds = [];
    for (let i = 0; i < boqItemIds.length; i++) {
      const ins = await client.query(
        `INSERT INTO client_project_tasks (company_id, project_id, parent_task_id, task_name, duration_days, start_date, end_date, is_milestone, sort_order, created_by, source_boq_item_id, budget_amount)
         VALUES ($1,$2,NULL,$3,$4,NULL,NULL,false,$5,$6,$7,$8) RETURNING id`,
        [companyId, projectId, descById.get(boqItemIds[i]).trim(), durations[i], nextOrder, req.customer.id, boqItemIds[i], amountById.get(boqItemIds[i])]
      );
      insertedIds.push(ins.rows[0].id);
      nextOrder++;
    }
    await recomputeProjectTaskWbs(client, companyId, projectId);
    await applyAutoSchedule(client, companyId, projectId);
    await touchProjectScheduleUpdatedAt(client, companyId, projectId);
    await client.query('COMMIT');
    const r = await pool.query(`${CLIENT_PROJECT_TASK_SELECT} WHERE t.id = ANY($1::int[]) ORDER BY t.sort_order`, [insertedIds]);
    res.json({ tasks: r.rows.map(serializeTask) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'เพิ่ม Task ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// Sibling-only reorder (see schema.sql Phase-1 decision #2 — cross-level moves go through PUT
// .../:taskId's parentTaskId field instead, not this endpoint). Body: { order: [{id, sortOrder}] }.
// MUST be declared before PUT .../tasks/:taskId below — Express matches routes in declaration
// order, so ":taskId" would otherwise greedily match the literal path segment "reorder" too (this
// was a real bug caught by project-tasks-crud.regression.js: PUT .../tasks/reorder was hitting the
// :taskId handler with taskId="reorder", which then failed parseInt("reorder") as invalid input).
app.put('/api/customer/projects/:projectId/tasks/reorder', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const order = Array.isArray((req.body || {}).order) ? req.body.order : [];
  if (order.length === 0) return res.status(400).json({ error: 'ไม่มีรายการที่จะจัดลำดับ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of order) {
      const id = parseInt(it.id, 10);
      const sortOrder = parseInt(it.sortOrder, 10) || 0;
      await client.query('UPDATE client_project_tasks SET sort_order=$1 WHERE id=$2 AND company_id=$3 AND project_id=$4', [sortOrder, id, companyId, projectId]);
    }
    await recomputeProjectTaskWbs(client, companyId, projectId);
    await applyAutoSchedule(client, companyId, projectId);
    await client.query('COMMIT');
    const r = await pool.query(
      `${CLIENT_PROJECT_TASK_SELECT} WHERE t.company_id=$1 AND t.project_id=$2 ORDER BY t.sort_order`,
      [companyId, projectId]
    );
    res.json({ tasks: r.rows.map(serializeTask) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'จัดลำดับไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.put('/api/customer/projects/:projectId/tasks/:taskId', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  const taskId = parseInt(req.params.taskId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const existing = await pool.query('SELECT * FROM client_project_tasks WHERE id=$1 AND company_id=$2 AND project_id=$3', [taskId, companyId, projectId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงานนี้' });
  const current = existing.rows[0];
  const {
    parentTaskId, taskName, durationDays, startDate, percentComplete, isMilestone,
    actualStartDate, actualEndDate, actualAmount, actualPercent,
  } = req.body || {};
  if (!taskName || !taskName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่องาน' });

  let parentId = parentTaskId !== undefined ? (parentTaskId ? parseInt(parentTaskId, 10) : null) : current.parent_task_id;
  if (parentId) {
    const p = await pool.query('SELECT 1 FROM client_project_tasks WHERE id=$1 AND company_id=$2 AND project_id=$3', [parentId, companyId, projectId]);
    if (p.rowCount === 0) return res.status(400).json({ error: 'ไม่พบ Parent Task นี้ในโครงการนี้' });
    const client0 = await pool.connect();
    let cyclic;
    try { cyclic = await isTaskOrDescendant(client0, companyId, projectId, taskId, parentId); }
    finally { client0.release(); }
    if (cyclic) return res.status(400).json({ error: 'ไม่สามารถตั้ง Parent Task เป็นตัวเองหรืองานย่อยของตัวเองได้ (จะทำให้เกิดวงจร)' });
  }
  const pct = (percentComplete !== undefined && percentComplete !== null) ? Math.min(100, Math.max(0, parseInt(percentComplete, 10) || 0)) : current.percent_complete;
  const milestone = isMilestone !== undefined ? !!isMilestone : current.is_milestone;
  const duration = milestone ? 0 : Math.max(1, parseInt(durationDays, 10) || current.duration_days || 1);
  const start = startDate !== undefined ? (startDate || null) : current.start_date;
  const end = start ? addCalendarDays(start, milestone ? 0 : duration - 1) : null;
  // ผลงาน (actual) fields — plain user-entered values, no derived/cross-field logic like start/end
  // above (actual_end_date is NOT recomputed from a duration; both dates are independently entered,
  // see schema.sql's comment on these columns). "undefined -> keep current value" mirrors every other
  // optional field on this endpoint (pct/milestone/duration/start above).
  const actualStart = actualStartDate !== undefined ? (actualStartDate || null) : current.actual_start_date;
  const actualEnd = actualEndDate !== undefined ? (actualEndDate || null) : current.actual_end_date;
  const actualBaht = actualAmount !== undefined ? Math.max(0, Number(actualAmount) || 0) : current.actual_amount;
  const actualPct = (actualPercent !== undefined && actualPercent !== null) ? Math.min(100, Math.max(0, Number(actualPercent) || 0)) : current.actual_percent;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE client_project_tasks SET parent_task_id=$1, task_name=$2, duration_days=$3, start_date=$4, end_date=$5, percent_complete=$6, is_milestone=$7,
         actual_start_date=$9, actual_end_date=$10, actual_amount=$11, actual_percent=$12 WHERE id=$8`,
      [parentId, taskName.trim(), duration, start, end, pct, milestone, taskId, actualStart, actualEnd, actualBaht, actualPct]
    );
    await recomputeProjectTaskWbs(client, companyId, projectId);
    await applyAutoSchedule(client, companyId, projectId);
    await touchProjectScheduleUpdatedAt(client, companyId, projectId);
    await client.query('COMMIT');
    const r = await pool.query(
      `${CLIENT_PROJECT_TASK_SELECT} WHERE t.id=$1`,
      [taskId]
    );
    res.json({ task: serializeTask(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกงานไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/projects/:projectId/tasks/:taskId', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  const taskId = parseInt(req.params.taskId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const existing = await pool.query('SELECT 1 FROM client_project_tasks WHERE id=$1 AND company_id=$2 AND project_id=$3', [taskId, companyId, projectId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงานนี้' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ON DELETE CASCADE on client_project_tasks_parent_fk (schema.sql) deletes the whole subtree —
    // no recursive application-level delete needed.
    await client.query('DELETE FROM client_project_tasks WHERE id=$1', [taskId]);
    await recomputeProjectTaskWbs(client, companyId, projectId);
    await applyAutoSchedule(client, companyId, projectId);
    await touchProjectScheduleUpdatedAt(client, companyId, projectId);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ลบงานไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/projects/:projectId/tasks/dependencies', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const { taskId, dependsOnTaskId, dependencyType, lagDays } = req.body || {};
  const tId = parseInt(taskId, 10), dId = parseInt(dependsOnTaskId, 10);
  if (!tId || !dId) return res.status(400).json({ error: 'กรุณาเลือกงานทั้งสองฝั่ง' });
  if (tId === dId) return res.status(400).json({ error: 'งานหนึ่งไม่สามารถขึ้นกับตัวเองได้' });
  const type = ['FS', 'SS', 'FF', 'SF'].includes(dependencyType) ? dependencyType : 'FS';
  const lag = parseInt(lagDays, 10) || 0;
  const bothInProject = await pool.query(
    'SELECT COUNT(*)::int AS n FROM client_project_tasks WHERE company_id=$1 AND project_id=$2 AND id IN ($3,$4)',
    [companyId, projectId, tId, dId]
  );
  if (bothInProject.rows[0].n !== 2) return res.status(400).json({ error: 'ไม่พบงานทั้งสองฝั่งในโครงการนี้' });
  // Real graph-wide circular-dependency detection (Phase 2 — replaces Phase 1's placeholder). The
  // trivial self-reference case is still caught above first (cheaper, clearer error message), and
  // the DB's own UNIQUE(task_id,depends_on_task_id) still guards the exact-duplicate-edge case.
  if (await wouldCreateCycle(companyId, projectId, tId, dId)) {
    return res.status(400).json({ error: 'ไม่สามารถเพิ่มความสัมพันธ์นี้ได้ เพราะจะทำให้เกิดวงจร (งานย้อนกลับมาขึ้นกับตัวเองทางอ้อม)' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ins;
    try {
      ins = await client.query(
        `INSERT INTO client_project_task_dependencies (company_id, task_id, depends_on_task_id, dependency_type, lag_days)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [companyId, tId, dId, type, lag]
      );
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'มีความสัมพันธ์นี้อยู่แล้ว' });
      throw err;
    }
    await applyAutoSchedule(client, companyId, projectId);
    await client.query('COMMIT');
    res.json({ dependency: serializeTaskDependency(ins.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'เพิ่มความสัมพันธ์ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.delete('/api/customer/projects/:projectId/tasks/dependencies/:depId', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  const depId = parseInt(req.params.depId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `DELETE FROM client_project_task_dependencies d USING client_project_tasks t
       WHERE d.id=$1 AND d.company_id=$2 AND d.task_id=t.id AND t.project_id=$3
       RETURNING d.task_id`,
      [depId, companyId, projectId]
    );
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบความสัมพันธ์นี้' }); }
    const orphanedTaskId = r.rows[0].task_id;
    // If this was that task's LAST remaining predecessor, its start_date/end_date are stale
    // auto-scheduled output with no anchor behind them anymore (Phase 1 never stored a separate
    // "original anchor" apart from start_date — cascade always overwrites in place) — clear them
    // to null (unscheduled) rather than leaving a frozen, now-meaningless date. applyAutoSchedule
    // below only ever WRITES tasks that currently have a predecessor, so this has to happen first.
    const stillHasPredecessor = await client.query('SELECT 1 FROM client_project_task_dependencies WHERE company_id=$1 AND task_id=$2', [companyId, orphanedTaskId]);
    if (stillHasPredecessor.rowCount === 0) {
      await client.query('UPDATE client_project_tasks SET start_date=NULL, end_date=NULL WHERE id=$1', [orphanedTaskId]);
    }
    // Removing a dependency can also shift other still-connected tasks back to a different
    // predecessor's schedule — always recompute the rest, same as every other mutation here.
    await applyAutoSchedule(client, companyId, projectId);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'ลบความสัมพันธ์ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// UPSERTs baseline_start/baseline_end = current start_date/end_date for every task in the project —
// a later call always overwrites the previous baseline (see schema.sql Phase-1 decision #4), not an
// append-only history.
app.post('/api/customer/projects/:projectId/tasks/set-baseline', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const projectId = parseInt(req.params.projectId, 10);
  if (!(await requireOwnedProject(companyId, projectId))) return res.status(404).json({ error: 'ไม่พบโครงการ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO client_project_task_baseline (company_id, task_id, baseline_start, baseline_end, baseline_set_at, set_by)
       SELECT company_id, id, start_date, end_date, now(), $3 FROM client_project_tasks WHERE company_id=$1 AND project_id=$2
       ON CONFLICT (task_id) DO UPDATE SET baseline_start=EXCLUDED.baseline_start, baseline_end=EXCLUDED.baseline_end,
         baseline_set_at=EXCLUDED.baseline_set_at, set_by=EXCLUDED.set_by`,
      [companyId, projectId, req.customer.id]
    );
    await client.query('COMMIT');
    const r = await pool.query(
      `SELECT b.task_id, to_char(b.baseline_start,'YYYY-MM-DD') AS baseline_start, to_char(b.baseline_end,'YYYY-MM-DD') AS baseline_end, b.baseline_set_at
       FROM client_project_task_baseline b JOIN client_project_tasks t ON t.id=b.task_id
       WHERE b.company_id=$1 AND t.project_id=$2`,
      [companyId, projectId]
    );
    res.json({ baselines: r.rows.map(serializeTaskBaseline) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ตั้ง Baseline ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ================================================================================================
// Customer: Bidding system (BD: Tender + Initial Budget) + Project Budget (PM) — see schema.sql's
// "Bidding system" section for the table design and the business-rule comments there for rules #1-3.
// ================================================================================================

// ---------------- BD: Tender ----------------
function serializeTender(row) {
  return {
    id: row.id, tenderNo: row.tender_no, name: row.name, projectOwner: row.project_owner,
    submissionDeadline: row.submission_deadline, estimatedValue: Number(row.estimated_value),
    status: row.status, note: row.note, createdBy: row.created_by, createdAt: row.created_at,
    projectNo: row.project_no, biddingMethod: row.bidding_method, sectorType: row.sector_type,
    budgetAmount: Number(row.budget_amount), referencePrice: Number(row.reference_price),
    location: row.location, phoneNumber: row.phone_number, siteCoordinates: row.site_coordinates,
    submissionOpenDate: row.submission_open_date, submissionConditions: row.submission_conditions,
    installmentCount: row.installment_count,
    initialRetentionPercent: Number(row.initial_retention_percent),
  };
}
const CLIENT_TENDER_SELECT = `
  SELECT id, tender_no, name, project_owner, to_char(submission_deadline,'YYYY-MM-DD') AS submission_deadline,
    estimated_value, status, note, created_by, created_at,
    project_no, bidding_method, sector_type, budget_amount, reference_price, location, phone_number,
    site_coordinates, to_char(submission_open_date,'YYYY-MM-DD') AS submission_open_date,
    submission_conditions, installment_count, initial_retention_percent
  FROM client_tenders`;
const TENDER_STATUS_VALUES = ['preparing', 'submitted', 'won', 'lost', 'cancelled'];
const TENDER_SECTOR_TYPES = ['government', 'private'];

// รายการงวดงาน — child rows of one tender, always rewritten as a whole set on save (see
// insertTenderInstallments below), same "delete-then-reinsert in one transaction" pattern as
// insertFreshBoqItems for BOQ items, since the form only ever edits the full in-progress list before
// one submit — there's no independent per-row edit/delete route to keep in sync with.
function serializeTenderInstallment(row) {
  return {
    id: row.id, tenderId: row.tender_id, installmentNo: row.installment_no,
    description: row.description, amount: Number(row.amount), daysToComplete: row.days_to_complete,
  };
}
async function insertTenderInstallments(client, companyId, tenderId, installments) {
  const rows = Array.isArray(installments) ? installments : [];
  for (let i = 0; i < rows.length; i++) {
    const inst = rows[i] || {};
    await client.query(
      `INSERT INTO client_tender_installments (company_id, tender_id, installment_no, description, amount, days_to_complete)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, tenderId, i + 1, String(inst.description || '').trim(), Number(inst.amount) || 0, parseInt(inst.daysToComplete, 10) || 0]
    );
  }
  return rows.length;
}

// Atomically returns the next per-company, per-doc_type sequence number from
// company_document_counters (schema.sql) — next_seq only ever increases (a plain UPSERT increment,
// never derived from a COUNT of current rows), so deleting old records can never cause a
// previously-issued number to be reissued. Bug fixed 2026-07-24: generateTenderNo used to compute
// `COUNT(*) FROM client_tenders + 1`, so deleting 10 old tenders (dropping the count from 12 to 2)
// made the very next tender created reissue "TDR-2569-0003" — a number already used (and deleted)
// minutes earlier. `client` must be the same pool client the caller's transaction is using, so this
// increment rolls back together with the rest of the caller's work if anything after it fails.
async function nextDocumentSeq(client, companyId, docType) {
  const r = await client.query(
    `INSERT INTO company_document_counters (company_id, doc_type, next_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (company_id, doc_type) DO UPDATE SET next_seq = company_document_counters.next_seq + 1
     RETURNING next_seq`,
    [companyId, docType]
  );
  return r.rows[0].next_seq;
}

async function generateTenderNo(client, companyId) {
  const year = new Date().getFullYear() + 543; // Buddhist Era, matching every other document-number generator in this codebase
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'tender');
    const no = `TDR-${year}-` + String(seq).padStart(4, '0');
    // Still checked (rather than trusting the counter blindly) — a company that manually types its
    // OWN custom tender_no (the trimmedNo branch in the POST route below) could otherwise collide
    // with a not-yet-reached auto-generated number later; this retry loop is what would catch that.
    const exists = await client.query('SELECT 1 FROM client_tenders WHERE company_id=$1 AND tender_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ Tender ได้');
}

app.get('/api/customer/tenders', requireCustomerAuth, async (req, res) => {
  const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE company_id=$1 ORDER BY id DESC`, [req.customer.company_id]);
  res.json({ tenders: r.rows.map(serializeTender) });
});

app.get('/api/customer/tenders/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE id=$1 AND company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบ Tender' });
  const installments = await pool.query(
    `SELECT * FROM client_tender_installments WHERE tender_id=$1 AND company_id=$2 ORDER BY installment_no`,
    [id, companyId]
  );
  // จำนวนเงินประกันผลงานเริ่มต้น (บาท) is derived from the linked PROJECT's approved PM budget total —
  // deliberately NOT this tender's own estimated_value/reference_price, which are pre-bid ESTIMATES,
  // a different meaning entirely from an actually-approved execution budget (2026-07-28 correction).
  // Only ever non-null once: the tender is won AND a project links back to it (client_projects.tender_id)
  // AND that project's budget has current_revision_id pointing at an approved revision —
  // client_budgets.current_revision_id is only ever repointed at approval time (see the schema.sql
  // comment on client_budget_revisions), so the status='approved' check here is a defensive
  // double-check, not the primary gate. Recomputed fresh on every fetch, never cached/persisted, so a
  // later re-approval of a revised PM budget shows up immediately on next page load.
  const approvedBudget = await pool.query(
    `SELECT br.total_amount
     FROM client_projects p
     JOIN client_budgets b ON b.project_id = p.id AND b.budget_scope='project'
     JOIN client_budget_revisions br ON br.id = b.current_revision_id AND br.status='approved'
     WHERE p.company_id=$1 AND p.tender_id=$2
     ORDER BY p.id ASC LIMIT 1`,
    [companyId, id]
  );
  const approvedProjectBudgetTotal = approvedBudget.rowCount > 0 ? Number(approvedBudget.rows[0].total_amount) : null;
  res.json({
    tender: serializeTender(r.rows[0]),
    installments: installments.rows.map(serializeTenderInstallment),
    approvedProjectBudgetTotal,
  });
});

// ---------------- ภาพรวมประมูลงาน (Tender Overview dashboard, 2026-07-25) ----------------
// One aggregate endpoint for the module's landing page instead of the frontend firing several
// requests and combining them client-side (statusCounts, active total, won-project count, pending
// budgets, upcoming deadlines, recent activity all in one round-trip). Note: there is no persisted
// log of budget over-limit/strict-control block EVENTS anywhere in this codebase (checkBudgetControl
// below only throws a 409 at request time — nothing is written to a table), so this intentionally
// does not attempt an "over-limit budgets" section; that would need a real audit-log table first.
app.get('/api/customer/tender-overview', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;

  const [statusRes, activeValueRes, wonProjectsRes, pendingCountRes, deadlinesRes, pendingBudgetsRes, recentTendersRes, recentBudgetsRes] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS n FROM client_tenders WHERE company_id=$1 GROUP BY status`, [companyId]),
    pool.query(`SELECT COALESCE(SUM(estimated_value),0) AS total FROM client_tenders WHERE company_id=$1 AND status IN ('preparing','submitted','won')`, [companyId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM client_projects WHERE company_id=$1 AND tender_id IS NOT NULL`, [companyId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM client_budget_revisions WHERE company_id=$1 AND status='pending_approval'`, [companyId]),
    pool.query(
      `SELECT id, tender_no, name, to_char(submission_deadline,'YYYY-MM-DD') AS submission_deadline,
         (submission_deadline - CURRENT_DATE) AS days_left
       FROM client_tenders
       WHERE company_id=$1 AND status IN ('preparing','submitted')
         AND submission_deadline BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
       ORDER BY submission_deadline ASC LIMIT 10`,
      [companyId]
    ),
    pool.query(
      `SELECT cb.id AS budget_id, cb.budget_scope, cb.tender_id, cb.project_id, cbr.submitted_at,
         ct.name AS tender_name, ct.tender_no, cp.name AS project_name, cp.code AS project_code
       FROM client_budget_revisions cbr
       JOIN client_budgets cb ON cb.id = cbr.budget_id
       LEFT JOIN client_tenders ct ON ct.id = cb.tender_id AND ct.company_id = cb.company_id
       LEFT JOIN client_projects cp ON cp.id = cb.project_id AND cp.company_id = cb.company_id
       WHERE cbr.company_id=$1 AND cbr.status='pending_approval'
       ORDER BY cbr.submitted_at ASC NULLS LAST LIMIT 10`,
      [companyId]
    ),
    pool.query(`SELECT id, tender_no, name, created_at FROM client_tenders WHERE company_id=$1 ORDER BY created_at DESC LIMIT 8`, [companyId]),
    pool.query(
      `SELECT cbr.id AS revision_id, cbr.status, cbr.submitted_at, cbr.approved_at, cbr.created_at,
         cb.budget_scope, cb.tender_id, cb.project_id,
         ct.name AS tender_name, ct.tender_no, cp.name AS project_name, cp.code AS project_code
       FROM client_budget_revisions cbr
       JOIN client_budgets cb ON cb.id = cbr.budget_id
       LEFT JOIN client_tenders ct ON ct.id = cb.tender_id AND ct.company_id = cb.company_id
       LEFT JOIN client_projects cp ON cp.id = cb.project_id AND cp.company_id = cb.company_id
       WHERE cbr.company_id=$1
       ORDER BY GREATEST(COALESCE(cbr.approved_at,'-infinity'), COALESCE(cbr.submitted_at,'-infinity'), cbr.created_at) DESC
       LIMIT 8`,
      [companyId]
    ),
  ]);

  const statusCounts = { preparing: 0, submitted: 0, won: 0, lost: 0, cancelled: 0 };
  for (const row of statusRes.rows) statusCounts[row.status] = row.n;

  const budgetRefName = (row) => row.budget_scope === 'bidding'
    ? (row.tender_name ? `${row.tender_name} (${row.tender_no})` : row.tender_no || '-')
    : (row.project_name ? `${row.project_name} (${row.project_code})` : row.project_code || '-');
  const budgetRefPage = (row) => row.budget_scope === 'bidding' ? 'fin_tender_detail' : 'fin_project_detail';
  const budgetRefId = (row) => row.budget_scope === 'bidding' ? row.tender_id : row.project_id;

  const pendingBudgets = pendingBudgetsRes.rows.map(row => ({
    budgetId: row.budget_id, scope: row.budget_scope, refPage: budgetRefPage(row), refId: budgetRefId(row),
    refName: budgetRefName(row), submittedAt: row.submitted_at,
  }));

  // Merge tenders (only ever produce a "created" activity — client_tenders has no updated_at column,
  // so a later status change like preparing->won isn't independently timestamped/trackable here) with
  // budget revisions (one entry per revision, labeled by its current status, timestamped by whichever
  // of approved_at/submitted_at/created_at is most relevant to that status) into one recent-activity feed.
  const tenderActivity = recentTendersRes.rows.map(row => ({
    type: 'tender_created', refPage: 'fin_tender_detail', refId: row.id,
    label: `${row.name} (${row.tender_no})`, timestamp: row.created_at,
  }));
  const budgetActivity = recentBudgetsRes.rows.map(row => {
    const type = row.status === 'approved' ? 'budget_approved' : row.status === 'rejected' ? 'budget_rejected'
      : row.status === 'pending_approval' ? 'budget_submitted' : 'budget_created';
    const timestamp = row.approved_at || row.submitted_at || row.created_at;
    return { type, refPage: budgetRefPage(row), refId: budgetRefId(row), label: budgetRefName(row), timestamp };
  });
  const recentActivity = [...tenderActivity, ...budgetActivity]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 8);

  res.json({
    statusCounts,
    activeEstimatedValueTotal: Number(activeValueRes.rows[0].total),
    wonProjectsCount: wonProjectsRes.rows[0].n,
    pendingBudgetsCount: pendingCountRes.rows[0].n,
    upcomingDeadlines: deadlinesRes.rows.map(row => ({
      tenderId: row.id, tenderNo: row.tender_no, name: row.name,
      submissionDeadline: row.submission_deadline, daysLeft: row.days_left,
    })),
    pendingBudgets,
    recentActivity,
  });
});

app.post('/api/customer/tenders', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const {
    tenderNo, name, projectOwner, submissionDeadline, estimatedValue, note,
    projectNo, biddingMethod, sectorType, budgetAmount, referencePrice,
    location, phoneNumber, siteCoordinates, submissionOpenDate, submissionConditions, installments,
    initialRetentionPercent,
  } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อ Tender' });
  // ภาครัฐ/เอกชน decides which of budget_amount/reference_price vs estimated_value actually applies
  // (see the schema.sql comment on why there's no separate contract_value column) — required so the
  // form's conditional fields always have somewhere unambiguous to go.
  if (!TENDER_SECTOR_TYPES.includes(sectorType)) {
    return res.status(400).json({ error: 'กรุณาเลือกประเภทหน่วยงาน (ภาครัฐ/เอกชน)' });
  }
  const isGov = sectorType === 'government';
  const finalBudgetAmount = isGov ? (Number(budgetAmount) || 0) : 0;
  const finalReferencePrice = isGov ? (Number(referencePrice) || 0) : 0;
  // Private sector reuses estimated_value directly as its "มูลค่างาน" — government derives it from
  // budget_amount instead, so every existing reader of estimated_value (the tender list, etc.) keeps
  // showing a sensible headline number regardless of which sector this tender is.
  const finalEstimatedValue = isGov ? finalBudgetAmount : (Number(estimatedValue) || 0);
  const finalInitialRetentionPercent = Math.min(100, Math.max(0, Number(initialRetentionPercent) || 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Idempotency backstop: generateTenderNo below always mints a fresh sequential tender_no per
    // call, so a rapid double/multi-submit (e.g. a double-click before the frontend's own
    // disabled-button guard paints — see save-tender-full in pr-system.html) would otherwise sail
    // straight past the tender_no uniqueness check below and create several near-identical tenders
    // in a row. If this SAME customer already created a tender with the exact same fields in the
    // last 10 seconds, hand back that existing one instead of inserting a duplicate.
    const recentDup = await client.query(
      `SELECT id FROM client_tenders
       WHERE company_id=$1 AND created_by=$2 AND name=$3 AND project_owner=$4
         AND estimated_value=$5 AND submission_deadline IS NOT DISTINCT FROM $6 AND note=$7
         AND created_at > now() - interval '10 seconds'
       ORDER BY id ASC LIMIT 1`,
      [companyId, req.customer.id, name.trim(), (projectOwner || '').trim(),
        finalEstimatedValue, submissionDeadline || null, (note || '').trim()]
    );
    if (recentDup.rowCount > 0) {
      await client.query('ROLLBACK');
      const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE id=$1`, [recentDup.rows[0].id]);
      return res.json({ tender: serializeTender(r.rows[0]) });
    }
    const trimmedNo = (tenderNo || '').trim();
    const finalNo = trimmedNo || await generateTenderNo(client, companyId);
    const dup = await client.query('SELECT 1 FROM client_tenders WHERE company_id=$1 AND tender_no=$2', [companyId, finalNo]);
    if (dup.rowCount > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'เลขที่ Tender นี้มีอยู่แล้ว' }); }
    const insert = await client.query(
      `INSERT INTO client_tenders (company_id, tender_no, name, project_owner, submission_deadline, estimated_value, note, created_by,
         project_no, bidding_method, sector_type, budget_amount, reference_price, location, phone_number, site_coordinates,
         submission_open_date, submission_conditions, installment_count, initial_retention_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [companyId, finalNo, name.trim(), (projectOwner || '').trim(), submissionDeadline || null, finalEstimatedValue, (note || '').trim(), req.customer.id,
        (projectNo || '').trim(), (biddingMethod || '').trim(), sectorType, finalBudgetAmount, finalReferencePrice,
        (location || '').trim(), (phoneNumber || '').trim(), (siteCoordinates || '').trim(),
        submissionOpenDate || null, (submissionConditions || '').trim(), Array.isArray(installments) ? installments.length : 0,
        finalInitialRetentionPercent]
    );
    const tenderId = insert.rows[0].id;
    await insertTenderInstallments(client, companyId, tenderId, installments);
    await client.query('COMMIT');
    const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE id=$1`, [tenderId]);
    res.json({ tender: serializeTender(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึก Tender ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.put('/api/customer/tenders/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const own = await pool.query('SELECT 1 FROM client_tenders WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบ Tender' });
  const { name, projectOwner, submissionDeadline, estimatedValue, note } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อ Tender' });
  await pool.query(
    `UPDATE client_tenders SET name=$1, project_owner=$2, submission_deadline=$3, estimated_value=$4, note=$5 WHERE id=$6`,
    [name.trim(), (projectOwner || '').trim(), submissionDeadline || null, Number(estimatedValue) || 0, (note || '').trim(), id]
  );
  // Re-query ผ่าน CLIENT_TENDER_SELECT แทนการใช้ RETURNING * ตรงๆ — RETURNING * คืนคอลัมน์ DATE ดิบ
  // (submission_deadline) ที่ยังไม่ผ่าน to_char() เหมือนที่ SELECT นี้ทำ ดู CLAUDE.md ข้อ 22
  const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE id=$1`, [id]);
  res.json({ tender: serializeTender(r.rows[0]) });
});

// Status transitions are a dedicated route (not folded into the general PUT above) because 'won'
// specifically triggers business rule #1 — the BD -> PM budget carry-forward — for every project
// already linked to this tender. That side effect belongs with an explicit state-change action,
// not something that could fire from an unrelated field edit.
app.post('/api/customer/tenders/:id/status', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { status } = req.body || {};
  if (!TENDER_STATUS_VALUES.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  const own = await pool.query('SELECT * FROM client_tenders WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (own.rowCount === 0) return res.status(404).json({ error: 'ไม่พบ Tender' });
  const wasWon = own.rows[0].status === 'won';
  await pool.query('UPDATE client_tenders SET status=$1 WHERE id=$2', [status, id]);
  if (!wasWon && status === 'won') {
    const linked = await pool.query('SELECT id FROM client_projects WHERE company_id=$1 AND tender_id=$2', [companyId, id]);
    for (const p of linked.rows) {
      await copyBiddingBudgetToProjectBudget(companyId, id, p.id, req.customer.id);
    }
  }
  // Re-query ผ่าน CLIENT_TENDER_SELECT แทนการใช้ RETURNING * ตรงๆ — เหตุผลเดียวกับ PUT ด้านบน
  const r = await pool.query(`${CLIENT_TENDER_SELECT} WHERE id=$1`, [id]);
  res.json({ tender: serializeTender(r.rows[0]) });
});

// ---------------- BD/PM: Budget (header + revisions + BOQ items) ----------------
function serializeBudget(row) {
  return {
    id: row.id, budgetScope: row.budget_scope, tenderId: row.tender_id, projectId: row.project_id,
    sourceBudgetId: row.source_budget_id, currentRevisionId: row.current_revision_id,
    controlEnabled: row.control_enabled, warningThresholdPercent: Number(row.warning_threshold_percent),
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
function serializeBudgetRevision(row) {
  return {
    id: row.id, budgetId: row.budget_id, revisionNo: row.revision_no, status: row.status,
    totalAmount: Number(row.total_amount), source: row.source, revisionReason: row.revision_reason,
    submittedBy: row.submitted_by, submittedAt: row.submitted_at,
    approvedBy: row.approved_by, approvedAt: row.approved_at, rejectedReason: row.rejected_reason,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
function serializeBudgetItem(row) {
  return {
    id: row.id, idx: row.idx, workCode: row.work_code, description: row.description, unit: row.unit,
    qty: Number(row.qty),
    materialUnitPrice: Number(row.material_unit_price), laborUnitPrice: Number(row.labor_unit_price),
    materialAmount: Number(row.material_amount), laborAmount: Number(row.labor_amount), amount: Number(row.amount),
    strictControl: row.strict_control, isGroup: row.is_group, groupId: row.group_id, note: row.note,
    // claimedPercent (หัวข้อ 3, migration 0014) — % สะสมที่ถูกอนุมัติใน progress claim ไปแล้ว ใช้โชว์
    // "เหลือเบิกได้อีกกี่ %" ในฟอร์มสร้างใบขอเบิกแบบ BOQ — row.claimed_percent เป็น undefined สำหรับแถวที่
    // query ไม่ได้ SELECT คอลัมน์นี้มา (เช่น revision เก่าที่ query ผ่าน endpoint อื่น) จึง Number(undefined)
    // ได้ NaN แทน 0 ถ้าไม่กันไว้ก่อน
    claimedPercent: row.claimed_percent !== undefined ? Number(row.claimed_percent) : 0,
  };
}
// A group row's own material_amount/labor_amount/amount are always stored as 0 (buildBoqRow forces
// this) so they can never go stale — the real subtotal is computed here, at read time, from whichever
// children currently point their group_id at it. Mutates and returns the same array.
function rollupBoqGroupAmounts(items) {
  const byGroupId = new Map();
  for (const it of items) {
    if (it.isGroup || !it.groupId) continue;
    const acc = byGroupId.get(it.groupId) || { materialAmount: 0, laborAmount: 0, amount: 0 };
    acc.materialAmount += it.materialAmount;
    acc.laborAmount += it.laborAmount;
    acc.amount += it.amount;
    byGroupId.set(it.groupId, acc);
  }
  for (const it of items) {
    if (!it.isGroup) continue;
    const acc = byGroupId.get(it.id);
    if (acc) {
      it.materialAmount = round2(acc.materialAmount);
      it.laborAmount = round2(acc.laborAmount);
      it.amount = round2(acc.amount);
    }
  }
  return items;
}

// Full detail for one budget: the header, every revision (history), the currently-APPROVED
// revision's items (what control-budget checks use), and the latest revision's items (what the
// UI edits — may be the same revision as current, or a newer draft/pending_approval one).
async function loadBudgetDetail(runner, companyId, budgetId) {
  const b = await runner.query('SELECT * FROM client_budgets WHERE id=$1 AND company_id=$2', [budgetId, companyId]);
  if (b.rowCount === 0) return null;
  const budget = b.rows[0];
  const revisions = await runner.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no', [budgetId]);
  const latestRevision = revisions.rows.length > 0 ? revisions.rows[revisions.rows.length - 1] : null;
  const currentRevision = budget.current_revision_id
    ? revisions.rows.find(r => r.id === budget.current_revision_id) || null
    : null;

  async function itemsFor(revisionId) {
    if (!revisionId) return [];
    const items = await runner.query('SELECT * FROM client_budget_items WHERE revision_id=$1 ORDER BY idx, id', [revisionId]);
    return rollupBoqGroupAmounts(items.rows.map(serializeBudgetItem));
  }

  // ยอดที่ถูกขอซื้อไปแล้ว (ผ่าน PR) ต่อบรรทัด BOQ — เอาไว้ให้หน้าสร้าง PR แสดง "เหลืองบเท่าไหร่" ก่อน
  // กรอก นับเฉพาะ budget_item_id ของ "revision ปัจจุบัน" (currentRevision) เท่านั้น เพราะ PR อ้างอิง
  // budget_item_id ที่ผูกกับ revision ตอนสร้าง — ถ้า budget ถูก revise ใหม่ทีหลัง (delete+reinsert ทั้ง
  // ก้อนตาม copyBoqItems) รายการ PR เก่าจะชี้ไปที่ budget_item_id ของ revision เก่าที่ไม่อยู่ใน
  // currentItems ชุดนี้แล้ว จึงไม่ถูกนับ (ถูกต้องแล้ว เพราะ "เหลืองบ" ต้องเทียบกับ revision ปัจจุบันเท่านั้น)
  // นับ PR ทุกสถานะยกเว้น rejected/cancelled (รวม draft ด้วย) เพราะเป้าหมายคือเตือนล่วงหน้าไม่ให้ของซ้ำ
  // ซ้อนกันโดยไม่รู้ตัว ไม่ใช่ยอดที่ authoritative — ตรงกับ pattern "NOT IN สถานะจบแบบล้มเหลว" ที่
  // CLAUDE.md ข้อ 23 แนะนำ (ปลอดภัยกว่าเมื่อมีสถานะใหม่เพิ่มมาทีหลัง)
  async function attachPrRequestedTotals(items) {
    const ids = items.filter(it => !it.isGroup).map(it => it.id);
    if (ids.length === 0) return items;
    const r = await runner.query(
      `SELECT pri.budget_item_id, SUM(pri.qty_requested) AS qty, SUM(pri.estimated_amount) AS amount
       FROM client_purchase_request_items pri
       JOIN client_purchase_requests pr ON pr.id = pri.purchase_request_id
       WHERE pri.company_id=$1 AND pri.budget_item_id = ANY($2::int[]) AND pr.status NOT IN ('rejected','cancelled')
       GROUP BY pri.budget_item_id`,
      [companyId, ids]
    );
    const byId = new Map(r.rows.map(row => [row.budget_item_id, { qty: Number(row.qty), amount: Number(row.amount) }]));
    for (const it of items) {
      const agg = byId.get(it.id);
      it.requestedQty = agg ? agg.qty : 0;
      it.requestedAmount = agg ? agg.amount : 0;
    }
    return items;
  }

  // Resolves which TENDER the source bidding budget belongs to, so the frontend's "link back to the
  // originating tender" (on a project budget copied via rule #1) can navigate straight there instead
  // of just showing a bare source_budget_id with nowhere useful to go.
  let sourceTenderId = null;
  if (budget.source_budget_id) {
    const src = await runner.query('SELECT tender_id FROM client_budgets WHERE id=$1', [budget.source_budget_id]);
    if (src.rowCount > 0) sourceTenderId = src.rows[0].tender_id;
  }

  return {
    ...serializeBudget(budget),
    sourceTenderId,
    revisions: revisions.rows.map(serializeBudgetRevision),
    currentRevision: currentRevision ? serializeBudgetRevision(currentRevision) : null,
    currentItems: await attachPrRequestedTotals(await itemsFor(currentRevision ? currentRevision.id : null)),
    latestRevision: latestRevision ? serializeBudgetRevision(latestRevision) : null,
    latestItems: await itemsFor(latestRevision ? latestRevision.id : null),
  };
}

app.get('/api/customer/budgets', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { tenderId, projectId } = req.query || {};
  if (!tenderId && !projectId) return res.status(400).json({ error: 'กรุณาระบุ tenderId หรือ projectId' });
  const clause = tenderId ? 'tender_id=$2' : 'project_id=$2';
  const val = parseInt(tenderId || projectId, 10);
  const b = await pool.query(`SELECT id FROM client_budgets WHERE company_id=$1 AND ${clause}`, [companyId, val]);
  if (b.rowCount === 0) return res.json({ budget: null });
  res.json({ budget: await loadBudgetDetail(pool, companyId, b.rows[0].id) });
});

app.get('/api/customer/budgets/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const detail = await loadBudgetDetail(pool, req.customer.company_id, id);
  if (!detail) return res.status(404).json({ error: 'ไม่พบงบประมาณ' });
  res.json({ budget: detail });
});

// Items for one SPECIFIC past revision — loadBudgetDetail above only ever returns the current and
// latest revisions' items (the two the rest of the UI actually needs live), so viewing an older,
// superseded revision from the history list needs its own on-demand fetch.
app.get('/api/customer/budgets/:id/revisions/:revisionId', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const revisionId = parseInt(req.params.revisionId, 10);
  const companyId = req.customer.company_id;
  const budgetRes = await pool.query('SELECT 1 FROM client_budgets WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (budgetRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงบประมาณ' });
  const revisionRes = await pool.query(
    'SELECT * FROM client_budget_revisions WHERE id=$1 AND budget_id=$2 AND company_id=$3', [revisionId, id, companyId]
  );
  if (revisionRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบ revision นี้' });
  const itemsRes = await pool.query('SELECT * FROM client_budget_items WHERE revision_id=$1 ORDER BY idx, id', [revisionId]);
  res.json({ revision: serializeBudgetRevision(revisionRes.rows[0]), items: rollupBoqGroupAmounts(itemsRes.rows.map(serializeBudgetItem)) });
});

// Creates the header + an empty first draft revision (revision_no=1). Items get added afterward
// via import-boq or the items PUT below, then submitted for approval — matches ข้อ 5 (BD Initial
// Budget) / ข้อ 6 (PM Initial Project Budget) as two separate calls to this same endpoint, keyed by
// whichever of tenderId/projectId is given.
app.post('/api/customer/budgets', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { tenderId, projectId } = req.body || {};
  if (!tenderId && !projectId) return res.status(400).json({ error: 'กรุณาระบุ tenderId หรือ projectId' });
  if (tenderId && projectId) return res.status(400).json({ error: 'ระบุได้เพียง tenderId หรือ projectId อย่างใดอย่างหนึ่ง' });
  const scope = tenderId ? 'bidding' : 'project';
  const refId = parseInt(tenderId || projectId, 10);
  const refTable = tenderId ? 'client_tenders' : 'client_projects';
  const owner = await pool.query(`SELECT 1 FROM ${refTable} WHERE id=$1 AND company_id=$2`, [refId, companyId]);
  if (owner.rowCount === 0) return res.status(404).json({ error: tenderId ? 'ไม่พบ Tender' : 'ไม่พบโครงการ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopeColumn = scope === 'bidding' ? 'tender_id' : 'project_id';
    const dup = await client.query(`SELECT 1 FROM client_budgets WHERE company_id=$1 AND ${scopeColumn}=$2`, [companyId, refId]);
    if (dup.rowCount > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'มีงบประมาณสำหรับรายการนี้อยู่แล้ว' }); }
    const budgetIns = await client.query(
      `INSERT INTO client_budgets (company_id, budget_scope, tender_id, project_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, scope, scope === 'bidding' ? refId : null, scope === 'project' ? refId : null, req.customer.id]
    );
    const budgetId = budgetIns.rows[0].id;
    await client.query(
      `INSERT INTO client_budget_revisions (company_id, budget_id, revision_no, status, source, created_by)
       VALUES ($1,$2,1,'draft','manual',$3)`,
      [companyId, budgetId, req.customer.id]
    );
    await client.query('COMMIT');
    res.json({ budget: await loadBudgetDetail(pool, companyId, budgetId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างงบประมาณไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

const boqUpload = multer({
  storage: multer.memoryStorage(), // parsed immediately and never kept on disk — no reason to retain the original file
  limits: { fileSize: 5 * 1024 * 1024 },
});
function uploadBoqMiddleware(req, res, next) {
  boqUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ' });
    next();
  });
}

// Checks the budget exists (company-scoped) and its latest revision is still 'draft' — shared by
// every preview/inspect/import route below, since none of them should proceed past this point
// otherwise.
async function requireDraftBudgetRevision(companyId, budgetId) {
  const budgetRes = await pool.query('SELECT 1 FROM client_budgets WHERE id=$1 AND company_id=$2', [budgetId, companyId]);
  if (budgetRes.rowCount === 0) { const e = new Error('ไม่พบงบประมาณ'); e.status = 404; throw e; }
  const revisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1', [budgetId]);
  const revision = revisionRes.rows[0];
  if (!revision || revision.status !== 'draft') {
    const e = new Error('ทำรายการนี้ได้เฉพาะ revision ที่ยังเป็นฉบับร่าง (draft) เท่านั้น');
    e.status = 400;
    throw e;
  }
  return revision;
}

function normalizeBoqHeader(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

// ---------------- BOQ import, mode A: standard template (strict, header fixed at row 4) ----------------
const BOQ_TEMPLATE_HEADER_ROW = 4;
const BOQ_TEMPLATE_COLUMNS = [
  { field: 'workCode', label: 'รหัสงาน' },
  { field: 'description', label: 'รายการงาน' },
  { field: 'unit', label: 'หน่วย' },
  { field: 'qty', label: 'ปริมาณ' },
  { field: 'materialUnitPrice', label: 'ราคาวัสดุ/หน่วย' },
  { field: 'laborUnitPrice', label: 'ราคาแรงงาน/หน่วย' },
  { field: 'materialAmount', label: 'รวมค่าวัสดุ' },
  { field: 'laborAmount', label: 'รวมค่าแรงงาน' },
  { field: 'amount', label: 'รวมเงิน' },
  { field: 'isGroupFlag', label: 'เป็นหมวดหมู่? (Y/N)' },
  { field: 'note', label: 'หมายเหตุ' },
];

// Auto-detect helper for "แถวสรุปยอด" (summary/subtotal rows, e.g. "รวมเงิน" ending a category) —
// used by buildBoqRow below for BOTH import modes whenever isSummaryRowExplicit isn't already given.
const BOQ_DEFAULT_SUMMARY_KEYWORDS = ['รวมเงิน', 'รวม', 'รวมทั้งหมด', 'รวมทั้งสิ้น', 'total', 'sum'];
function boqHasRawValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}
// Exact match only (after trim/whitespace-collapse), never substring — so a real work item like
// "10. รวมค่าติดตั้ง" is never mistaken for a summary row just because its name contains "รวม".
// `extraKeywords` (from a saved import profile's column_mapping.summaryRowKeywords, Tab B only) is
// unioned with the built-in list rather than replacing it, so a profile can only ever add
// vendor-specific phrasing.
function boqMatchesSummaryKeyword(descriptionText, extraKeywords) {
  const text = normalizeBoqHeader(descriptionText);
  if (!text) return null;
  const lower = text.toLowerCase();
  const list = (extraKeywords && extraKeywords.length) ? [...BOQ_DEFAULT_SUMMARY_KEYWORDS, ...extraKeywords] : BOQ_DEFAULT_SUMMARY_KEYWORDS;
  return list.some(k => String(k || '').trim().toLowerCase() === lower) ? text : null;
}
// A row qualifies as a summary/subtotal row only when ALL of: no ลำดับ (sequence) value, no ปริมาณ
// (qty) value, description matches a known "total" keyword exactly, AND at least one of the three
// amount columns actually carries a number — that last check is what tells a real subtotal row apart
// from a genuinely blank/malformed row that just happens to have "รวม" typed into its description.
function boqDetectSummaryRow(fields, extraKeywords) {
  if (boqHasRawValue(fields.sequenceRaw)) return null;
  if (boqHasRawValue(fields.qtyRaw)) return null;
  const matchedText = boqMatchesSummaryKeyword(fields.descriptionText, extraKeywords);
  if (!matchedText) return null;
  const hasAnyAmount = [fields.materialAmountRaw, fields.laborAmountRaw, fields.totalAmountRaw]
    .some(v => boqHasRawValue(v) && !Number.isNaN(Number(v)));
  if (!hasAnyAmount) return null;
  return matchedText;
}

// One shared per-row builder+validator used by BOTH import modes (template and mapping), the manual
// items PUT below, and the unified import-confirm route — so "what makes a BOQ row valid" is defined
// exactly once. Returns null for a fully-blank row (skip), the built row otherwise, or throws an
// Error with `.status`/`.rowNumber` set that the caller is expected to catch per-row and accumulate
// (see collectBoqErrors) rather than aborting the whole file on the first bad line.
//
// Every row is exactly one of 3 kinds, mutually exclusive: a category header (isGroup), a
// summary/subtotal row (isSummaryRow — cross-checked but never inserted, see
// computeBoqSummaryRowWarnings/insertFreshBoqItems), or a normal line item. isGroupExplicit/
// isSummaryRowExplicit are real booleans for template mode (from the "เป็นหมวดหมู่?" Y/N column,
// isSummaryRow always auto-detected there since the template has no dedicated column for it) and for
// the confirm routes (the client already resolved/let the user tick both checkboxes in preview).
// They're both `null` for mapping-mode's first parse, which auto-detects both: isGroup from the
// mapped "ลำดับ" column's whole-number vs. decimal numbering (or the description-only heuristic when
// unmapped), and isSummaryRow via boqDetectSummaryRow — checked BEFORE the description-only isGroup
// fallback, since a blank-ลำดับ "รวมเงิน" row would otherwise satisfy that heuristic too (no qty, no
// unit price) and get misclassified as a category header instead.
//
// Only `description` (รายการงาน) is required for a real (non-group, non-summary) row — ปริมาณ,
// ราคาวัสดุ/หน่วย, ราคาแรงงาน/หน่วย all default to 0 (and หน่วย to '') when blank OR unparseable,
// rather than erroring; a summary row skips the same fields for the same reason (it only exists to
// carry the file's own subtotal). qtyDefaulted/materialUnitPriceDefaulted/laborUnitPriceDefaulted on
// the returned row record which of those 3 numeric fields actually fell back, purely so the preview
// UI can flag "this was blank in the source file, not really 0" without re-deriving it from scratch.
// Each amount field independently falls back to a computed value only when its own cell was blank OR
// unparseable (`hasX ? providedValue : computed`), which handles a source file that already has
// totals filled in, one with none, or any partial mix, identically — no separate whole-file
// "already computed?" mode needed.
function buildBoqRow(raw, rowNumber) {
  const description = String(raw.description ?? '').trim();
  const workCode = String(raw.workCode ?? '').trim();
  const unit = String(raw.unit ?? '').trim();
  const note = String(raw.note ?? '').trim();
  const hasQty = raw.qtyRaw !== null && raw.qtyRaw !== undefined && raw.qtyRaw !== '';
  const hasMaterialUnitPrice = raw.materialUnitPriceRaw !== null && raw.materialUnitPriceRaw !== undefined && raw.materialUnitPriceRaw !== '';
  const hasLaborUnitPrice = raw.laborUnitPriceRaw !== null && raw.laborUnitPriceRaw !== undefined && raw.laborUnitPriceRaw !== '';
  // "Defaulted" covers both a blank cell AND a present-but-unparseable one (e.g. "N/A") — either way
  // it must fall back to 0, never surface as a stored NaN.
  const qtyDefaulted = !hasQty || Number.isNaN(Number(raw.qtyRaw));
  const materialUnitPriceDefaulted = !hasMaterialUnitPrice || Number.isNaN(Number(raw.materialUnitPriceRaw));
  const laborUnitPriceDefaulted = !hasLaborUnitPrice || Number.isNaN(Number(raw.laborUnitPriceRaw));
  const qty = qtyDefaulted ? 0 : Number(raw.qtyRaw);
  const materialUnitPrice = materialUnitPriceDefaulted ? 0 : Number(raw.materialUnitPriceRaw);
  const laborUnitPrice = laborUnitPriceDefaulted ? 0 : Number(raw.laborUnitPriceRaw);

  // Same "blank or unparseable falls back to the computed value" rule for the 3 amount columns —
  // an amount cell that's present but garbage must never silently override the qty×price fallback
  // with a stored NaN.
  const hasMaterialAmount = raw.materialAmountRaw !== null && raw.materialAmountRaw !== undefined && raw.materialAmountRaw !== '' && !Number.isNaN(Number(raw.materialAmountRaw));
  const hasLaborAmount = raw.laborAmountRaw !== null && raw.laborAmountRaw !== undefined && raw.laborAmountRaw !== '' && !Number.isNaN(Number(raw.laborAmountRaw));
  const hasTotalAmount = raw.totalAmountRaw !== null && raw.totalAmountRaw !== undefined && raw.totalAmountRaw !== '' && !Number.isNaN(Number(raw.totalAmountRaw));
  const materialAmount = hasMaterialAmount ? Number(raw.materialAmountRaw) : round2(qty * materialUnitPrice);
  const laborAmount = hasLaborAmount ? Number(raw.laborAmountRaw) : round2(qty * laborUnitPrice);
  const amount = hasTotalAmount ? Number(raw.totalAmountRaw) : round2(materialAmount + laborAmount);

  // Fully blank row (no description AND no qty/price/amount data anywhere) — skip silently, not an
  // error; this is what lets a sheet's empty trailing rows pass through without complaint. A row
  // missing ONLY the description, but carrying some other real value, is NOT "fully blank" — it falls
  // through to the required-description check below instead of vanishing silently.
  if (!description && !hasQty && !hasMaterialUnitPrice && !hasLaborUnitPrice && !hasMaterialAmount && !hasLaborAmount && !hasTotalAmount) return null;

  let isGroup, isSummaryRow;
  if (raw.isGroupExplicit !== null && raw.isGroupExplicit !== undefined) {
    isGroup = !!raw.isGroupExplicit;
    isSummaryRow = raw.isSummaryRowExplicit !== null && raw.isSummaryRowExplicit !== undefined
      ? (!!raw.isSummaryRowExplicit && !isGroup)
      : (!isGroup && !!boqDetectSummaryRow({
          descriptionText: description, qtyRaw: raw.qtyRaw, sequenceRaw: raw.sequenceNo,
          materialAmountRaw: raw.materialAmountRaw, laborAmountRaw: raw.laborAmountRaw, totalAmountRaw: raw.totalAmountRaw,
        }, raw.summaryRowKeywords));
  } else {
    // Mapping-mode's first parse only (neither flag given yet) — full auto-detect for both, summary
    // checked first (see the function comment above for why the ordering matters).
    const summaryKeyword = boqDetectSummaryRow({
      descriptionText: description, qtyRaw: raw.qtyRaw, sequenceRaw: raw.sequenceNo,
      materialAmountRaw: raw.materialAmountRaw, laborAmountRaw: raw.laborAmountRaw, totalAmountRaw: raw.totalAmountRaw,
    }, raw.summaryRowKeywords);
    if (summaryKeyword) {
      isSummaryRow = true; isGroup = false;
    } else if (raw.sequenceNo !== null && raw.sequenceNo !== undefined && String(raw.sequenceNo).trim() !== '') {
      // ลำดับ column mapped: a whole number ("1", "2", "2.0") is a category row, a value with a
      // fractional remainder ("1.1", "2.3") is a line item under the nearest preceding whole number.
      const seq = Number(String(raw.sequenceNo).trim());
      isGroup = Number.isFinite(seq) && Number.isInteger(seq);
      isSummaryRow = false;
    } else {
      isGroup = !!description && !hasQty && !hasMaterialUnitPrice && !hasLaborUnitPrice; // legacy auto-detect: description-only row
      isSummaryRow = false;
    }
  }

  if (isGroup) {
    if (!description) {
      const e = new Error(`แถวที่ ${rowNumber}: แถวหมวดหมู่ต้องมีชื่อรายการ`);
      e.status = 400; e.rowNumber = rowNumber;
      throw e;
    }
    return { workCode, description, unit, qty: 0, materialUnitPrice: 0, laborUnitPrice: 0, materialAmount: 0, laborAmount: 0, amount: 0, isGroup: true, isSummaryRow: false, note };
  }
  if (isSummaryRow) {
    if (!description) {
      const e = new Error(`แถวที่ ${rowNumber}: ข้อมูลไม่ครบ (ขาด: รายการงาน)`);
      e.status = 400; e.rowNumber = rowNumber;
      throw e;
    }
    return { workCode, description, unit, qty, materialUnitPrice, laborUnitPrice, materialAmount, laborAmount, amount, isGroup: false, isSummaryRow: true, note, qtyDefaulted, materialUnitPriceDefaulted, laborUnitPriceDefaulted };
  }
  if (!description) {
    const e = new Error(`แถวที่ ${rowNumber}: ข้อมูลไม่ครบ (ขาด: รายการงาน)`);
    e.status = 400; e.rowNumber = rowNumber;
    throw e;
  }
  return { workCode, description, unit, qty, materialUnitPrice, laborUnitPrice, materialAmount, laborAmount, amount, isGroup: false, isSummaryRow: false, note, qtyDefaulted, materialUnitPriceDefaulted, laborUnitPriceDefaulted };
}
// Cross-checks each isSummaryRow row's recorded material/labor/total amounts against the sum of the
// real (non-group, non-summary) rows since the last group-header row — i.e. the same subtotal the
// system itself would compute for that category (see rollupBoqGroupAmounts/computeBoqGroupRollups).
// Returns a warning for any row whose recorded numbers don't match, to help catch bad source data
// early — the summary row itself is never inserted, so this is purely advisory (never blocks import).
function computeBoqSummaryRowWarnings(items) {
  const warnings = [];
  let acc = { materialAmount: 0, laborAmount: 0, amount: 0 };
  for (const it of items) {
    if (it.isGroup) { acc = { materialAmount: 0, laborAmount: 0, amount: 0 }; continue; }
    if (it.isSummaryRow) {
      const mismatch = Math.abs(acc.materialAmount - it.materialAmount) > 0.01
        || Math.abs(acc.laborAmount - it.laborAmount) > 0.01
        || Math.abs(acc.amount - it.amount) > 0.01;
      if (mismatch) {
        warnings.push({
          rowNumber: it.rowNumber, description: it.description,
          expected: { materialAmount: round2(acc.materialAmount), laborAmount: round2(acc.laborAmount), amount: round2(acc.amount) },
          actual: { materialAmount: it.materialAmount, laborAmount: it.laborAmount, amount: it.amount },
        });
      }
      continue;
    }
    acc.materialAmount += it.materialAmount;
    acc.laborAmount += it.laborAmount;
    acc.amount += it.amount;
  }
  return warnings;
}
// Combines every per-row error collected while looping a sheet (or an items[] array) into one
// 400 — lets the caller report EVERY bad row in one pass instead of stopping at the first.
function collectBoqErrors(rowErrors) {
  if (rowErrors.length > 0) {
    const e = new Error(`พบข้อผิดพลาด ${rowErrors.length} รายการ:\n` + rowErrors.join('\n'));
    e.status = 400;
    throw e;
  }
}

async function loadBoqWorkbook(buffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    if (workbook.worksheets.length === 0) { const e = new Error('ไม่พบชีทข้อมูลในไฟล์ Excel'); e.status = 400; throw e; }
    return workbook;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error('ไม่สามารถอ่านไฟล์ Excel นี้ได้ กรุณาตรวจสอบไฟล์');
    e.status = 400;
    throw e;
  }
}

// Strict parse for Tab A (มาตรฐาน template): header must match BOQ_TEMPLATE_COLUMNS position-for-
// position at row 4 exactly, or the whole file is rejected up front naming every mismatched/missing
// column — never silently guesses at a "close enough" header the way the old alias-matching importer
// used to.
async function parseTemplateBoq(buffer) {
  const workbook = await loadBoqWorkbook(buffer);
  const sheet = workbook.worksheets[0];
  const headerRow = sheet.getRow(BOQ_TEMPLATE_HEADER_ROW);
  const headerErrors = [];
  BOQ_TEMPLATE_COLUMNS.forEach((col, i) => {
    const actual = normalizeBoqHeader(headerRow.getCell(i + 1).value);
    if (actual !== col.label) headerErrors.push(`คอลัมน์ที่ ${i + 1}: ควรเป็น "${col.label}" แต่พบ "${actual || '(ว่าง)'}"`);
  });
  if (headerErrors.length > 0) {
    const e = new Error(`หัวตารางในแถวที่ ${BOQ_TEMPLATE_HEADER_ROW} ไม่ตรงกับ Template มาตรฐาน:\n` + headerErrors.join('\n'));
    e.status = 400;
    throw e;
  }

  const items = [];
  const rowErrors = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= BOQ_TEMPLATE_HEADER_ROW) return;
    try {
      const isGroupText = normalizeBoqHeader(row.getCell(10).value).toUpperCase();
      const built = buildBoqRow({
        workCode: row.getCell(1).value, description: row.getCell(2).value, unit: row.getCell(3).value,
        qtyRaw: row.getCell(4).value,
        materialUnitPriceRaw: row.getCell(5).value, laborUnitPriceRaw: row.getCell(6).value,
        materialAmountRaw: row.getCell(7).value, laborAmountRaw: row.getCell(8).value, totalAmountRaw: row.getCell(9).value,
        isGroupExplicit: isGroupText === 'Y', note: row.getCell(11).value,
      }, rowNumber);
      if (built) items.push({ ...built, rowNumber });
    } catch (err) { rowErrors.push(err.message); }
  });
  collectBoqErrors(rowErrors);
  if (items.length === 0) { const e = new Error('ไม่พบรายการ BOQ ในไฟล์'); e.status = 400; throw e; }
  return items;
}

// ---------------- BOQ import, mode B: user's own file (flexible column mapping) ----------------
// "First row with any content" — not always row 1, since a user's own export may have title rows
// above the real header, same reasoning as the standard template having its header at row 4.
// excludedRows lets the caller skip rows the user has deleted in Step 2 (raw sheet edit) when
// deciding which surviving row is the header.
function findBoqHeaderRowIndex(sheet, excludedRows) {
  const excluded = excludedRows || new Set();
  for (let r = 1; r <= sheet.rowCount; r++) {
    if (excluded.has(r)) continue;
    let hasContent = false;
    sheet.getRow(r).eachCell({ includeEmpty: false }, () => { hasContent = true; });
    if (hasContent) return r;
  }
  return null;
}
// Parses ExcelJS's `sheet.model.merges` range strings ("A1:B1") into 1-based {rowStart,rowEnd,
// colStart,colEnd}. Used only to AUTO-DETECT how many header rows to combine (see
// boqAutoHeaderRowCount) — actual label propagation across a merge doesn't need this at all, since
// ExcelJS already returns the master cell's value when reading `.value` on ANY cell inside a merged
// range (verified: merging A1:B1 with a value in A1 makes `sheet.getCell('B1').value` read back the
// same text) — see boqCombinedHeaderLabel below.
function boqParseMergeRange(rangeStr) {
  const parts = String(rangeStr || '').split(':');
  const parseAddr = (addr) => {
    const m = /^([A-Z]+)(\d+)$/.exec(addr || '');
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col, row: parseInt(m[2], 10) };
  };
  const p1 = parseAddr(parts[0]);
  const p2 = parseAddr(parts[1] || parts[0]);
  if (!p1 || !p2) return null;
  return { rowStart: Math.min(p1.row, p2.row), rowEnd: Math.max(p1.row, p2.row), colStart: Math.min(p1.col, p2.col), colEnd: Math.max(p1.col, p2.col) };
}
// True when `rowNum` contains a merge spanning more than one column (a parent label like
// "ราคาค่าวัสดุ" sitting over several sub-columns) — the signal that this row is the first of a
// multi-row merged header block, not a plain single-row header.
function boqRowHasHorizontalMerge(sheet, rowNum) {
  const merges = sheet.model && sheet.model.merges;
  if (!Array.isArray(merges)) return false;
  return merges.some(rangeStr => {
    const r = boqParseMergeRange(rangeStr);
    return r && r.rowStart === rowNum && r.rowEnd === rowNum && r.colEnd > r.colStart;
  });
}
// Default header-row-count: 2 when the first content row has a horizontal merge (so the row right
// below it is a sub-header, not data), 1 otherwise — fully backward compatible with every
// single-row-header file already in use. The frontend lets the user override this per sheet (spec:
// "ให้ผู้ใช้เลือกได้ว่าไฟล์นี้ header กี่แถว"), sent back as an explicit `headerRowCount`.
function boqAutoHeaderRowCount(sheet, firstContentRow) {
  return boqRowHasHorizontalMerge(sheet, firstContentRow) ? 2 : 1;
}
// Combines `headerRowCount` rows starting at `firstRow` into one label for column `colNum`: joins
// each row's (merge-propagated) text with " - ", skipping blanks and collapsing consecutive
// duplicates. The dedup matters for a VERTICALLY-merged header cell (e.g. "รหัสงาน" spanning both
// header rows because that column doesn't need a sub-split) — ExcelJS reads the same text on every
// row the merge covers, so without dedup it would render as "รหัสงาน - รหัสงาน".
function boqCombinedHeaderLabel(sheet, firstRow, headerRowCount, colNum) {
  const parts = [];
  for (let i = 0; i < headerRowCount; i++) {
    const v = normalizeBoqHeader(sheet.getRow(firstRow + i).getCell(colNum).value);
    if (v && parts[parts.length - 1] !== v) parts.push(v);
  }
  return parts.join(' - ');
}
// headerRowCount: explicit override (from the frontend's per-sheet control) or auto-detected via
// boqAutoHeaderRowCount when omitted. Labels are de-duplicated (suffixing the column index on a
// collision) so two differently-positioned columns can never collapse onto the same dropdown option
// the way un-combined merged headers used to (bug: "ราคาวัสดุ/หน่วย" and "รวมค่าวัสดุ" mapping to
// the same column because both merge-propagated cells read as identical text).
function boqSheetHeaders(sheet, excludedRows, excludedCols, headerRowCount) {
  const excRows = excludedRows || new Set();
  const excCols = excludedCols || new Set();
  const headerRowIndex = findBoqHeaderRowIndex(sheet, excRows);
  if (!headerRowIndex) return { headerRowIndex: null, headerRowCount: 1, headers: [] };
  const rowCount = headerRowCount || boqAutoHeaderRowCount(sheet, headerRowIndex);
  const headers = [];
  const seenLabels = new Set();
  for (let c = 1; c <= sheet.columnCount; c++) {
    if (excCols.has(c)) continue;
    let label = boqCombinedHeaderLabel(sheet, headerRowIndex, rowCount, c);
    if (!label) continue;
    if (seenLabels.has(label)) label = `${label} (คอลัมน์ ${c})`;
    seenLabels.add(label);
    headers.push({ index: c, label });
  }
  return { headerRowIndex, headerRowCount: rowCount, headers };
}
// Renders a cell's value as plain display text for the Step 1/2 raw-grid view (formulas show their
// last computed result, rich text is flattened) — this is a read-only preview grid, never re-parsed
// from this text; actual import parsing always re-reads the real cell.value straight from the file.
function boqCellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.result !== undefined) return String(v.result ?? '');
    if (v.text !== undefined) return String(v.text);
    return '';
  }
  return String(v);
}
const BOQ_RAW_PREVIEW_ROW_CAP = 500;
function boqSheetRawRows(sheet, capRows) {
  const rows = [];
  const rowLimit = Math.min(sheet.rowCount, capRows);
  for (let r = 1; r <= rowLimit; r++) {
    const row = sheet.getRow(r);
    const cells = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(boqCellText(row.getCell(c).value));
    rows.push(cells);
  }
  return rows;
}

// Parses a user's own file against an explicit column_mapping (see client_boq_import_profiles in
// schema.sql for its shape). excludedRows/excludedCols (Sets of 1-based row/column numbers) reflect
// whatever the user deleted in Step 2 before mapping — the original file is always re-parsed from
// scratch here (never a client-materialized copy), these just get skipped while iterating. Both
// isGroup and isSummaryRow are auto-detected here (both flags stay null going into buildBoqRow) via
// the optional sequenceNo column and the summary-keyword heuristic respectively — the mapping form
// has no dedicated "is this a group?"/"is this a summary row?" column of its own, unlike the standard
// template. Every row carries its source `rowNumber` for computeBoqSummaryRowWarnings.
async function parseMappedBoq(buffer, sheetName, mapping, excludedRows, excludedCols, headerRowCount) {
  const workbook = await loadBoqWorkbook(buffer);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) { const e = new Error('ไม่พบชีทที่เลือก'); e.status = 400; throw e; }
  const excRows = new Set(excludedRows || []);
  const excCols = new Set(excludedCols || []);
  const { headerRowIndex, headerRowCount: resolvedHeaderRowCount, headers } = boqSheetHeaders(sheet, excRows, excCols, headerRowCount);
  if (!headerRowIndex) { const e = new Error('ไม่พบแถวหัวตารางในชีทนี้'); e.status = 400; throw e; }
  const lastHeaderRow = headerRowIndex + resolvedHeaderRowCount - 1;
  const colIndexByLabel = {};
  headers.forEach(h => { colIndexByLabel[h.label] = h.index; });

  if (!mapping || !mapping.description || !mapping.qty) {
    const e = new Error('กรุณาจับคู่คอลัมน์ "รายการงาน" และ "ปริมาณ" เป็นอย่างน้อย');
    e.status = 400;
    throw e;
  }
  const descIdx = colIndexByLabel[mapping.description];
  const qtyIdx = colIndexByLabel[mapping.qty];
  if (!descIdx || !qtyIdx) { const e = new Error('คอลัมน์ที่จับคู่ไว้ไม่พบในไฟล์ กรุณาตรวจสอบการจับคู่คอลัมน์'); e.status = 400; throw e; }
  const unitIdx = mapping.unit ? colIndexByLabel[mapping.unit] : null;
  const workCodeIdx = mapping.workCode ? colIndexByLabel[mapping.workCode] : null;
  const noteIdx = mapping.note ? colIndexByLabel[mapping.note] : null;
  const sequenceIdx = mapping.sequenceNo ? colIndexByLabel[mapping.sequenceNo] : null;
  const materialUnitPriceIdx = mapping.materialUnitPriceColumn ? colIndexByLabel[mapping.materialUnitPriceColumn] : null;
  const laborUnitPriceIdx = mapping.laborUnitPriceColumn ? colIndexByLabel[mapping.laborUnitPriceColumn] : null;
  const materialAmountIdx = mapping.materialAmountColumn ? colIndexByLabel[mapping.materialAmountColumn] : null;
  const laborAmountIdx = mapping.laborAmountColumn ? colIndexByLabel[mapping.laborAmountColumn] : null;
  const totalAmountIdx = mapping.totalAmountColumn ? colIndexByLabel[mapping.totalAmountColumn] : null;

  const items = [];
  const rowErrors = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= lastHeaderRow) return;
    if (excRows.has(rowNumber)) return;
    try {
      const built = buildBoqRow({
        workCode: workCodeIdx ? row.getCell(workCodeIdx).value : '',
        description: row.getCell(descIdx).value,
        unit: unitIdx ? row.getCell(unitIdx).value : '',
        qtyRaw: row.getCell(qtyIdx).value,
        materialUnitPriceRaw: materialUnitPriceIdx ? row.getCell(materialUnitPriceIdx).value : '',
        laborUnitPriceRaw: laborUnitPriceIdx ? row.getCell(laborUnitPriceIdx).value : '',
        materialAmountRaw: materialAmountIdx ? row.getCell(materialAmountIdx).value : '',
        laborAmountRaw: laborAmountIdx ? row.getCell(laborAmountIdx).value : '',
        totalAmountRaw: totalAmountIdx ? row.getCell(totalAmountIdx).value : '',
        isGroupExplicit: null,
        sequenceNo: sequenceIdx ? row.getCell(sequenceIdx).value : null,
        summaryRowKeywords: mapping.summaryRowKeywords,
        note: noteIdx ? row.getCell(noteIdx).value : '',
      }, rowNumber);
      if (built) items.push({ ...built, rowNumber });
    } catch (err) { rowErrors.push(err.message); }
  });
  collectBoqErrors(rowErrors);
  if (items.length === 0) { const e = new Error('ไม่พบรายการ BOQ ในไฟล์'); e.status = 400; throw e; }
  return items;
}

// Downloadable standard template (Tab A) — generated on the fly rather than a static file on disk,
// so BOQ_TEMPLATE_COLUMNS (the single source of truth parseTemplateBoq validates against) can never
// silently drift out of sync with what the download actually contains.
app.get('/api/customer/boq-template', requireCustomerAuth, async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('BOQ');
  sheet.addRow(['แบบฟอร์มนำเข้า BOQ (Bill of Quantities)']);
  sheet.addRow([`กรอกข้อมูลเริ่มต้นที่แถวที่ ${BOQ_TEMPLATE_HEADER_ROW + 1} เป็นต้นไป ห้ามแก้ไขหัวตารางแถวที่ ${BOQ_TEMPLATE_HEADER_ROW}`]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(BOQ_TEMPLATE_COLUMNS.map(c => c.label));
  headerRow.font = { bold: true };
  sheet.addRow(['', 'หมวดงานตัวอย่าง (แถวหมวดหมู่)', '', '', '', '', '', '', '', 'Y', '']);
  sheet.addRow(['WORK-001', 'รายการตัวอย่าง', 'หน่วย', 10, 80, 20, '', '', '', 'N', '']);
  sheet.columns.forEach(col => { col.width = 22; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="BOQ_Import_Template.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Tab A preview — parses and validates but writes nothing yet (see requireDraftBudgetRevision +
// the unified confirm route below for the actual write).
app.post('/api/customer/budgets/:id/boq-preview', requireCustomerAuth, uploadBoqMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ Excel BOQ (.xlsx ขนาดไม่เกิน 5MB)' });
  try {
    await requireDraftBudgetRevision(companyId, id);
    const items = await parseTemplateBoq(req.file.buffer);
    const total = round2(items.filter(it => !it.isSummaryRow).reduce((s, it) => s + it.amount, 0));
    res.json({ items, summaryRowWarnings: computeBoqSummaryRowWarnings(items), total });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Tab B step 1/2 — lists every sheet's name, detected header row, and up to BOQ_RAW_PREVIEW_ROW_CAP
// raw rows, so the frontend can show a delete-rows/delete-columns/delete-sheets grid per sheet before
// the user ever gets to mapping (Step 2), then populate the column-mapping dropdowns (Step 3) from
// whatever survives.
app.post('/api/customer/budgets/:id/boq-inspect', requireCustomerAuth, uploadBoqMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ Excel BOQ (.xlsx ขนาดไม่เกิน 5MB)' });
  try {
    await requireDraftBudgetRevision(companyId, id);
    const workbook = await loadBoqWorkbook(req.file.buffer);
    const sheets = workbook.worksheets.map(sheet => ({
      name: sheet.name,
      ...boqSheetHeaders(sheet),
      rowCount: sheet.rowCount,
      rows: boqSheetRawRows(sheet, BOQ_RAW_PREVIEW_ROW_CAP),
    }));
    res.json({ sheets });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Tab B step 3 — parses with the user's chosen mapping (against the ORIGINAL file, re-uploaded here —
// see parseMappedBoq — with whatever rows/columns the user deleted in Step 2 passed as index sets) and
// returns a preview (same shape as Tab A's boq-preview: items[] carrying auto-detected isGroup/
// isSummaryRow flags the user can still check/uncheck before confirming, plus summaryRowWarnings —
// see computeBoqSummaryRowWarnings) before confirming.
app.post('/api/customer/budgets/:id/boq-preview-mapped', requireCustomerAuth, uploadBoqMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ Excel BOQ (.xlsx ขนาดไม่เกิน 5MB)' });
  let mapping, excludedRows, excludedCols;
  try { mapping = JSON.parse(req.body.columnMapping || '{}'); }
  catch (err) { return res.status(400).json({ error: 'รูปแบบข้อมูล mapping ไม่ถูกต้อง' }); }
  try { excludedRows = JSON.parse(req.body.excludedRows || '[]'); } catch (err) { excludedRows = []; }
  try { excludedCols = JSON.parse(req.body.excludedCols || '[]'); } catch (err) { excludedCols = []; }
  // Explicit override from the frontend's per-sheet "จำนวนแถว Header" control — falls back to
  // auto-detection (boqAutoHeaderRowCount) inside boqSheetHeaders when not a positive integer, so an
  // un-touched control (or an older cached client) still behaves exactly as before.
  const headerRowCount = Number.isInteger(Number(req.body.headerRowCount)) && Number(req.body.headerRowCount) > 0
    ? Number(req.body.headerRowCount) : null;
  try {
    await requireDraftBudgetRevision(companyId, id);
    const items = await parseMappedBoq(req.file.buffer, req.body.sheetName, mapping, excludedRows, excludedCols, headerRowCount);
    const total = round2(items.filter(it => !it.isSummaryRow).reduce((s, it) => s + it.amount, 0));
    res.json({ items, summaryRowWarnings: computeBoqSummaryRowWarnings(items), total });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Inserts a fresh (non-copied) ordered set of built BOQ rows for one revision, assigning group_id in
// a SINGLE pass: both callers below preserve the array's final order, and a group row always precedes
// the item rows under it in that order, so by the time a child row is inserted its owning group's real
// DB id is already known (no two-phase insert-then-update needed). Returns the rounded total amount.
async function insertFreshBoqItems(client, companyId, revisionId, built, opts) {
  const withStrictControl = !!(opts && opts.withStrictControl);
  let idx = 0;
  let total = 0;
  let currentGroupId = null;
  for (const it of built) {
    idx += 1;
    total += it.amount;
    const groupId = it.isGroup ? null : currentGroupId;
    const cols = withStrictControl
      ? '(company_id, revision_id, idx, work_code, description, unit, qty, material_unit_price, labor_unit_price, material_amount, labor_amount, amount, strict_control, is_group, group_id, note)'
      : '(company_id, revision_id, idx, work_code, description, unit, qty, material_unit_price, labor_unit_price, material_amount, labor_amount, amount, is_group, group_id, note)';
    const values = withStrictControl
      ? [companyId, revisionId, idx, it.workCode, it.description, it.unit, it.qty, it.materialUnitPrice, it.laborUnitPrice, it.materialAmount, it.laborAmount, it.amount, it.strictControl, it.isGroup, groupId, it.note]
      : [companyId, revisionId, idx, it.workCode, it.description, it.unit, it.qty, it.materialUnitPrice, it.laborUnitPrice, it.materialAmount, it.laborAmount, it.amount, it.isGroup, groupId, it.note];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
    const row = await client.query(`INSERT INTO client_budget_items ${cols} VALUES (${placeholders}) RETURNING id`, values);
    if (it.isGroup) currentGroupId = row.rows[0].id;
  }
  return round2(total);
}

// Unified confirm for BOTH import modes. The frontend always arrives here with an already-parsed
// items[] array from whichever preview endpoint it used (and, for mapping mode, whatever is_group
// checkboxes the user adjusted afterward) — never a raw file — so there is exactly one write path
// regardless of which tab the user started from. Still re-validates every row server-side via the
// same buildBoqRow used by both parsers (never trusts the client's numbers/flags at face value).
app.post('/api/customer/budgets/:id/import-boq', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'ไม่พบรายการ BOQ ให้นำเข้า' });

  let revision;
  try { revision = await requireDraftBudgetRevision(companyId, id); }
  catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }

  const built = [];
  const rowErrors = [];
  items.forEach((raw, i) => {
    try {
      const row = buildBoqRow({
        workCode: raw.workCode, description: raw.description, unit: raw.unit,
        qtyRaw: raw.qty,
        materialUnitPriceRaw: raw.materialUnitPrice, laborUnitPriceRaw: raw.laborUnitPrice,
        materialAmountRaw: raw.materialAmount, laborAmountRaw: raw.laborAmount, totalAmountRaw: raw.amount,
        isGroupExplicit: !!raw.isGroup, isSummaryRowExplicit: !!raw.isSummaryRow, note: raw.note,
      }, i + 1);
      if (row) built.push(row);
    } catch (err) { rowErrors.push(err.message); }
  });
  try { collectBoqErrors(rowErrors); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  // A "แถวสรุปยอด" is validated (and can still block on a real error, e.g. a blank description) but
  // never inserted — it only ever existed to cross-check against the group subtotal the system
  // computes for itself from the real children (see computeBoqSummaryRowWarnings).
  const insertable = built.filter(it => !it.isSummaryRow);
  if (insertable.length === 0) return res.status(400).json({ error: 'ไม่พบรายการ BOQ ให้นำเข้า' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM client_budget_items WHERE revision_id=$1', [revision.id]);
    const total = await insertFreshBoqItems(client, companyId, revision.id, insertable, { withStrictControl: false });
    await client.query(`UPDATE client_budget_revisions SET total_amount=$1, source='boq_import' WHERE id=$2`, [total, revision.id]);
    await client.query('COMMIT');
    res.json({ budget: await loadBudgetDetail(pool, companyId, id), importedCount: insertable.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'นำเข้าไฟล์ BOQ ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// Manual add/edit of BOQ items on the latest revision (rule #1's last bullet — copied-over items
// must stay editable before submit, same restriction as import: draft only). Runs every row through
// the same buildBoqRow validator as the two import modes, so a manually-added row is held to the
// same "every row needs a name (รายการงาน); qty/unit price default to 0 when blank" standard.
app.put('/api/customer/budgets/:id/items', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'กรุณาระบุรายการ BOQ อย่างน้อย 1 รายการ' });

  const budgetRes = await pool.query('SELECT 1 FROM client_budgets WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (budgetRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงบประมาณ' });
  const revisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1', [id]);
  const revision = revisionRes.rows[0];
  if (!revision || revision.status !== 'draft') {
    return res.status(400).json({ error: 'แก้ไขรายการได้เฉพาะ revision ที่ยังเป็นฉบับร่าง (draft) เท่านั้น' });
  }

  const built = [];
  const rowErrors = [];
  items.forEach((raw, i) => {
    try {
      const row = buildBoqRow({
        workCode: raw.workCode, description: raw.description, unit: raw.unit,
        qtyRaw: raw.qty,
        materialUnitPriceRaw: raw.materialUnitPrice, laborUnitPriceRaw: raw.laborUnitPrice,
        materialAmountRaw: raw.materialAmount, laborAmountRaw: raw.laborAmount, totalAmountRaw: raw.amount,
        isGroupExplicit: !!raw.isGroup, note: raw.note,
      }, i + 1);
      if (row) built.push({ ...row, strictControl: !!raw.strictControl });
    } catch (err) { rowErrors.push(err.message); }
  });
  try { collectBoqErrors(rowErrors); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  if (built.length === 0) return res.status(400).json({ error: 'กรุณาระบุรายการ BOQ อย่างน้อย 1 รายการ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM client_budget_items WHERE revision_id=$1', [revision.id]);
    const total = await insertFreshBoqItems(client, companyId, revision.id, built, { withStrictControl: true });
    await client.query(`UPDATE client_budget_revisions SET total_amount=$1, source='manual' WHERE id=$2`, [total, revision.id]);
    await client.query('COMMIT');
    res.json({ budget: await loadBudgetDetail(pool, companyId, id) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกรายการ BOQ ไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- BOQ import mapping profiles (Tab B step 4-5) ----------------
function serializeBoqImportProfile(row) {
  return { id: row.id, name: row.name, columnMapping: row.column_mapping, createdAt: row.created_at };
}
app.get('/api/customer/boq-import-profiles', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM client_boq_import_profiles WHERE company_id=$1 ORDER BY name', [req.customer.company_id]);
  res.json({ profiles: r.rows.map(serializeBoqImportProfile) });
});
app.post('/api/customer/boq-import-profiles', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { name, columnMapping } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาตั้งชื่อ Profile' });
  if (!columnMapping || typeof columnMapping !== 'object') return res.status(400).json({ error: 'ข้อมูล mapping ไม่ถูกต้อง' });
  const dup = await pool.query('SELECT 1 FROM client_boq_import_profiles WHERE company_id=$1 AND name=$2', [companyId, name.trim()]);
  if (dup.rowCount > 0) return res.status(409).json({ error: 'มีชื่อ Profile นี้อยู่แล้ว' });
  const r = await pool.query(
    `INSERT INTO client_boq_import_profiles (company_id, name, column_mapping, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [companyId, name.trim(), JSON.stringify(columnMapping), req.customer.id]
  );
  res.json({ profile: serializeBoqImportProfile(r.rows[0]) });
});

// ข้อ 8: draft -> pending_approval. Requires at least one BOQ line so nothing empty ever reaches
// an approver.
app.post('/api/customer/budgets/:id/submit', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const budgetRes = await pool.query('SELECT 1 FROM client_budgets WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (budgetRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงบประมาณ' });
  const revisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1', [id]);
  const revision = revisionRes.rows[0];
  if (!revision || revision.status !== 'draft') {
    return res.status(400).json({ error: 'ส่งอนุมัติได้เฉพาะ revision ที่ยังเป็นฉบับร่าง (draft) เท่านั้น' });
  }
  const itemCount = await pool.query('SELECT COUNT(*)::int AS n FROM client_budget_items WHERE revision_id=$1', [revision.id]);
  if (itemCount.rows[0].n === 0) return res.status(400).json({ error: 'กรุณาเพิ่มรายการ BOQ ก่อนส่งอนุมัติ' });
  const r = await pool.query(
    `UPDATE client_budget_revisions SET status='pending_approval', submitted_by=$1, submitted_at=now() WHERE id=$2 RETURNING *`,
    [req.customer.id, revision.id]
  );
  res.json({ revision: serializeBudgetRevision(r.rows[0]) });
});

// ข้อ 8 + rule #2: current_revision_id only ever repoints at a revision in the SAME transaction as
// that revision's own approval — never before, never as a separate step.
app.post('/api/customer/budgets/:id/approve', requireCustomerAuth, requireCanApproveBudget, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const budgetRes = await client.query('SELECT * FROM client_budgets WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (budgetRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบงบประมาณ' }); }
    const revisionRes = await client.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE', [id]);
    const revision = revisionRes.rows[0];
    if (!revision || revision.status !== 'pending_approval') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ไม่มีรายการรออนุมัติ' });
    }
    await client.query(
      `UPDATE client_budget_revisions SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
      [req.customer.id, revision.id]
    );
    await client.query('UPDATE client_budgets SET current_revision_id=$1 WHERE id=$2', [revision.id, id]);
    await client.query('COMMIT');
    res.json({ budget: await loadBudgetDetail(pool, companyId, id) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'อนุมัติงบประมาณไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// rule #2: current_revision_id stays untouched on rejection — the rejected revision is a dead end,
// not editable further; the user must call /revise (below) to try again.
app.post('/api/customer/budgets/:id/reject', requireCustomerAuth, requireCanApproveBudget, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });
  const budgetRes = await pool.query('SELECT 1 FROM client_budgets WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (budgetRes.rowCount === 0) return res.status(404).json({ error: 'ไม่พบงบประมาณ' });
  const revisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1', [id]);
  const revision = revisionRes.rows[0];
  if (!revision || revision.status !== 'pending_approval') return res.status(400).json({ error: 'ไม่มีรายการรออนุมัติ' });
  const r = await pool.query(
    `UPDATE client_budget_revisions SET status='rejected', approved_by=$1, approved_at=now(), rejected_reason=$2 WHERE id=$3 RETURNING *`,
    [req.customer.id, reason.trim(), revision.id]
  );
  res.json({ revision: serializeBudgetRevision(r.rows[0]) });
});

// Copies an existing revision's items verbatim into a new revision — shared by /revise and the
// tender-won bidding->project auto-copy below — including group_id, translated from the source row's
// id to its corresponding freshly-inserted row's id via a map built as we go. sourceItems must already
// be `ORDER BY idx, id` (both callers already query it that way), so a group row is always copied
// before its children and the map already has the new parent id by the time a child needs it.
async function copyBoqItems(client, companyId, newRevisionId, sourceItems) {
  const oldIdToNewId = new Map();
  for (const it of sourceItems) {
    const newGroupId = it.group_id ? (oldIdToNewId.get(it.group_id) || null) : null;
    const r = await client.query(
      `INSERT INTO client_budget_items (company_id, revision_id, idx, work_code, description, unit, qty, material_unit_price, labor_unit_price, material_amount, labor_amount, amount, strict_control, is_group, group_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [companyId, newRevisionId, it.idx, it.work_code, it.description, it.unit, it.qty, it.material_unit_price, it.labor_unit_price, it.material_amount, it.labor_amount, it.amount, it.strict_control, it.is_group, newGroupId, it.note]
    );
    oldIdToNewId.set(it.id, r.rows[0].id);
  }
}

// ข้อ 9 + rule #2: revising after approval ALWAYS creates a brand-new revision (never mutates the
// approved one) and always requires a reason — no auto-approve regardless of how small the change.
// Branches off client_budgets.current_revision_id (the last APPROVED revision), never off a
// rejected one, matching rule #2's "rejected revisions are a dead end" rule exactly.
app.post('/api/customer/budgets/:id/revise', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการแก้ไขงบประมาณ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const budgetRes = await client.query('SELECT * FROM client_budgets WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (budgetRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบงบประมาณ' }); }
    const budget = budgetRes.rows[0];
    if (!budget.current_revision_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ยังไม่มีงบประมาณที่อนุมัติแล้วให้แก้ไข' });
    }
    const latestRes = await client.query('SELECT * FROM client_budget_revisions WHERE budget_id=$1 ORDER BY revision_no DESC LIMIT 1', [id]);
    const latest = latestRes.rows[0];
    if (latest && (latest.status === 'draft' || latest.status === 'pending_approval')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'มี revision ที่ยังไม่เสร็จสิ้นอยู่แล้ว ไม่สามารถสร้าง revision ใหม่ได้' });
    }
    const sourceRevisionRes = await client.query('SELECT * FROM client_budget_revisions WHERE id=$1', [budget.current_revision_id]);
    const sourceItemsRes = await client.query('SELECT * FROM client_budget_items WHERE revision_id=$1 ORDER BY idx, id', [budget.current_revision_id]);
    const nextRevisionNo = latest.revision_no + 1;
    const newRevisionIns = await client.query(
      `INSERT INTO client_budget_revisions (company_id, budget_id, revision_no, status, total_amount, source, revision_reason, created_by)
       VALUES ($1,$2,$3,'draft',$4,'revision',$5,$6) RETURNING id`,
      [companyId, id, nextRevisionNo, sourceRevisionRes.rows[0].total_amount, reason.trim(), req.customer.id]
    );
    const newRevisionId = newRevisionIns.rows[0].id;
    await copyBoqItems(client, companyId, newRevisionId, sourceItemsRes.rows);
    await client.query('COMMIT');
    res.json({ budget: await loadBudgetDetail(pool, companyId, id) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'สร้างการแก้ไขงบประมาณไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// Rule #1: when a tender is won, copy its (approved) bidding budget forward into a new project
// budget, auto-linked via source_budget_id. Idempotent — a project only ever gets one project-scope
// budget (enforced by uq_client_budgets_project in schema.sql), so a second call for the same
// project is a silent no-op. Silently does nothing if the bidding side has no approved revision yet
// (current_revision_id NULL) — there's nothing real to copy, and the project can still get a budget
// started manually via POST /api/customer/budgets.
async function copyBiddingBudgetToProjectBudget(companyId, tenderId, projectId, actorId) {
  const existing = await pool.query(
    'SELECT 1 FROM client_budgets WHERE company_id=$1 AND project_id=$2', [companyId, projectId]
  );
  if (existing.rowCount > 0) return null;

  const biddingRes = await pool.query(
    `SELECT * FROM client_budgets WHERE company_id=$1 AND tender_id=$2 AND budget_scope='bidding'`, [companyId, tenderId]
  );
  const bidding = biddingRes.rows[0];
  if (!bidding || !bidding.current_revision_id) return null;

  const sourceItemsRes = await pool.query(
    'SELECT * FROM client_budget_items WHERE revision_id=$1 ORDER BY idx, id', [bidding.current_revision_id]
  );
  const sourceRevisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE id=$1', [bidding.current_revision_id]);
  const sourceRevision = sourceRevisionRes.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const budgetIns = await client.query(
      `INSERT INTO client_budgets (company_id, budget_scope, project_id, source_budget_id, control_enabled, warning_threshold_percent, created_by)
       VALUES ($1,'project',$2,$3,$4,$5,$6) RETURNING id`,
      [companyId, projectId, bidding.id, bidding.control_enabled, bidding.warning_threshold_percent, actorId]
    );
    const newBudgetId = budgetIns.rows[0].id;
    // Revision starts at 'draft', never auto-approved — Initial Project Budget still has to go
    // through Approve Budget again (ข้อ 6-8), same as any other budget.
    const revisionIns = await client.query(
      `INSERT INTO client_budget_revisions (company_id, budget_id, revision_no, status, total_amount, source, created_by)
       VALUES ($1,$2,1,'draft',$3,$4,$5) RETURNING id`,
      [companyId, newBudgetId, sourceRevision.total_amount, sourceRevision.source, actorId]
    );
    const newRevisionId = revisionIns.rows[0].id;
    await copyBoqItems(client, companyId, newRevisionId, sourceItemsRes.rows);
    await client.query('COMMIT');
    return newBudgetId;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[bidding-budget] Failed to copy bidding budget for tender ${tenderId} -> project ${projectId}:`, err.message);
    return null;
  } finally {
    client.release();
  }
}

// ---------------- Control budget (rule #3): checked from cost/labor creation below ----------------
// Resolves the project's budget (if any) and checks BOTH levels against `amount` being added:
//   - total: cumulative spend (existing project_costs + labor_costs) vs. the current revision's
//     total_amount, gated by control_enabled; blocks over 100%, warns from warning_threshold_percent.
//   - line item: only when workCode is given AND matches a client_budget_items row on the current
//     revision — cumulative spend against that work_code vs. its own amount; blocks only if that
//     item has strict_control=true, otherwise warns.
// Returns { warnings: string[] } on success, or throws an Error with .status=409 to block the save
// (caller is expected to catch and respond with err.status/err.message).
async function checkBudgetControl(companyId, projectId, workCode, amount) {
  const warnings = [];
  if (!projectId) return { warnings };
  const budgetRes = await pool.query(
    `SELECT * FROM client_budgets WHERE company_id=$1 AND project_id=$2 AND budget_scope='project'`, [companyId, projectId]
  );
  const budget = budgetRes.rows[0];
  if (!budget || !budget.control_enabled || !budget.current_revision_id) return { warnings };

  const revisionRes = await pool.query('SELECT * FROM client_budget_revisions WHERE id=$1', [budget.current_revision_id]);
  const revision = revisionRes.rows[0];

  const spentRes = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM client_project_costs WHERE company_id=$1 AND project_id=$2), 0) +
       COALESCE((SELECT SUM(amount) FROM client_labor_costs WHERE company_id=$1 AND project_id=$2), 0) AS total_spent`,
    [companyId, projectId]
  );
  const totalSpent = Number(spentRes.rows[0].total_spent) + Number(amount);
  const totalBudget = Number(revision.total_amount);
  if (totalBudget > 0) {
    if (totalSpent > totalBudget) {
      const err = new Error(`รายการนี้ทำให้ยอดใช้จ่ายรวมเกินงบประมาณที่อนุมัติ (ใช้ไป ${totalSpent.toFixed(2)} จากงบ ${totalBudget.toFixed(2)})`);
      err.status = 409;
      throw err;
    }
    const warnPercent = Number(budget.warning_threshold_percent);
    if (warnPercent > 0 && totalSpent >= totalBudget * (warnPercent / 100)) {
      warnings.push(`ยอดใช้จ่ายรวมของโครงการใกล้ถึงงบประมาณที่อนุมัติแล้ว (${((totalSpent / totalBudget) * 100).toFixed(1)}%)`);
    }
  }

  if (workCode) {
    const itemRes = await pool.query(
      'SELECT * FROM client_budget_items WHERE revision_id=$1 AND work_code=$2 LIMIT 1', [budget.current_revision_id, workCode]
    );
    const item = itemRes.rows[0];
    if (item && Number(item.amount) > 0) {
      const lineSpentRes = await pool.query(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM client_project_costs WHERE company_id=$1 AND project_id=$2 AND work_code=$3), 0) +
           COALESCE((SELECT SUM(amount) FROM client_labor_costs WHERE company_id=$1 AND project_id=$2 AND work_code=$3), 0) AS line_spent`,
        [companyId, projectId, workCode]
      );
      const lineSpent = Number(lineSpentRes.rows[0].line_spent) + Number(amount);
      const lineBudget = Number(item.amount);
      if (lineSpent > lineBudget) {
        if (item.strict_control) {
          const err = new Error(`รายการ ${workCode} ใช้จ่ายเกินงบประมาณของรายการนี้ (ใช้ไป ${lineSpent.toFixed(2)} จากงบ ${lineBudget.toFixed(2)}) และตั้งเป็น strict control`);
          err.status = 409;
          throw err;
        }
        warnings.push(`รายการ ${workCode} ใช้จ่ายเกินงบประมาณของรายการนี้ (ใช้ไป ${lineSpent.toFixed(2)} จากงบ ${lineBudget.toFixed(2)})`);
      }
    }
  }

  return { warnings };
}

// ---------------- Customer: client ledger — ใบสั่งซื้อ (Purchase Orders, หัวข้อ 5) ----------------
// เขียนใหม่ทั้งหมดตาม migration 0012 — ของเดิม (items เก็บเป็น JSONB, ไม่มี composite FK/approval
// workflow/idempotency/audit log, DELETE เป็น hard delete) ถูก DROP ทิ้งแล้ว ดู migration 0012's
// comment สำหรับเหตุผลเต็ม (0 แถวจริงในระบบตอน migrate, ตรวจยืนยันหลายรอบ)
// ไม่โพสต์ journal เอง (เหตุผลเดียวกับของเดิม — เป็นแค่ commitment ยังไม่ใช่ค่าใช้จ่ายจริงจนกว่าจะจ่ายเงิน
// ผ่าน payment voucher ประเภท other ในหัวข้อ 1.4 ซึ่งเป็นคนละ flow แยกต่างหาก ไม่ผูกกับ PO นี้เลยในเฟสนี้)
function serializePoItem(row) {
  return {
    id: row.id,
    prItemId: row.pr_item_id,
    sourcePrNo: row.source_pr_no || null,
    idx: row.idx,
    material: row.material,
    unit: row.unit,
    qty: Number(row.qty),
    unitPrice: Number(row.unit_price),
    amount: Number(row.amount),
  };
}
function serializePurchaseOrder(row) {
  return {
    id: row.id,
    poNo: row.po_no,
    projectId: row.project_id,
    projectName: row.project_name || null,
    supplierName: row.supplier_name,
    supplierContact: row.supplier_contact,
    issueDate: row.issue_date,
    expectedDeliveryDate: row.expected_delivery_date,
    paymentTerms: row.payment_terms,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    totalAmount: Number(row.total_amount),
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
const CLIENT_PO_SELECT = `
  SELECT po.id, po.po_no, po.project_id, cp.name AS project_name,
    po.supplier_name, po.supplier_contact,
    to_char(po.issue_date,'YYYY-MM-DD') AS issue_date, to_char(po.expected_delivery_date,'YYYY-MM-DD') AS expected_delivery_date,
    po.payment_terms, po.status, po.submitted_by, po.submitted_at, po.approved_by, po.approved_at,
    po.rejected_reason, po.total_amount, po.note, po.created_by, po.created_at
  FROM client_purchase_orders po
  LEFT JOIN client_projects cp ON cp.id = po.project_id`;
const CLIENT_PO_ITEMS_SELECT = `
  SELECT poi.id, poi.pr_item_id, poi.idx, poi.material, poi.unit, poi.qty, poi.unit_price, poi.amount,
    pr.pr_no AS source_pr_no
  FROM client_purchase_order_items poi
  LEFT JOIN client_purchase_request_items pri ON pri.id = poi.pr_item_id
  LEFT JOIN client_purchase_requests pr ON pr.id = pri.purchase_request_id
  WHERE poi.purchase_order_id=$1 AND poi.company_id=$2 ORDER BY poi.idx`;

async function fetchFullPurchaseOrder(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_PO_SELECT} WHERE po.id=$1 AND po.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  const items = await dbClient.query(CLIENT_PO_ITEMS_SELECT, [id, companyId]);
  const po = serializePurchaseOrder(r.rows[0]);
  po.items = items.rows.map(serializePoItem);
  return po;
}

async function generateClientPoNumber(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'purchase_order');
    const no = `PO-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_purchase_orders WHERE company_id=$1 AND po_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ PO ได้');
}

// total_amount เขียนจาก SUM(items.amount) เสมอ ในทรานแซกชันเดียวกับที่แก้ items — ไม่เคยเชื่อค่าที่ client
// ส่งมาตรงๆ (กฎเดียวกับ client_purchase_requests.total_amount)
async function recomputeClientPoTotalAmount(client, companyId, poId) {
  await client.query(
    `UPDATE client_purchase_orders SET total_amount = COALESCE(
       (SELECT SUM(amount) FROM client_purchase_order_items WHERE purchase_order_id=$1), 0)
     WHERE id=$1 AND company_id=$2`,
    [poId, companyId]
  );
}

// ตรวจ input ร่วมของ POST (สร้างใหม่) และ PUT (แก้ไข) — คืน {error} หรือ {safeItems}
// prItemId เป็น optional เสมอ (ซื้อด่วนไม่ผ่าน PR ได้ ตาม migration 0012's comment) — ถ้าระบุมา ต้องมีอยู่
// จริงในบริษัทนี้เท่านั้น ส่วนเช็คว่า PR ต้นทาง approved แล้วหรือยัง/qty เกินไหม เลื่อนไปเช็คตอน
// submit(เตือน)/approve(บังคับจริง) เท่านั้น เพราะ pr_item_id ที่อ้างอิงอาจเปลี่ยนสถานะไปได้ระหว่างที่ PO
// ยังเป็น draft (รอแก้ไขอยู่นาน)
async function validatePoInput(dbClient = pool, companyId, { projectId, supplierName, items }) {
  if (!supplierName || !supplierName.trim()) return { error: 'กรุณากรอกชื่อซัพพลายเออร์' };
  if (projectId) {
    const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };
  }

  const safeItems = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const material = String(it.material || '').trim();
    const qty = parsePositiveNumericValue(it.qty);
    if (!material || qty === null) continue;
    const unitPrice = parseNonNegativeNumericValue(it.unitPrice);
    if (unitPrice === null) return { error: `รายการ "${material}" ระบุราคาต่อหน่วยไม่ถูกต้อง` };
    safeItems.push({ prItemId: it.prItemId || null, material, unit: String(it.unit || '').trim() || '-', qty, unitPrice });
  }
  if (safeItems.length === 0) return { error: 'กรุณากรอกรายการอย่างน้อย 1 รายการ' };

  const prItemIds = [...new Set(safeItems.filter(it => it.prItemId).map(it => it.prItemId))];
  if (prItemIds.length > 0) {
    const check = await dbClient.query(
      'SELECT COUNT(*)::int AS n FROM client_purchase_request_items WHERE id = ANY($1::int[]) AND company_id=$2',
      [prItemIds, companyId]
    );
    if (check.rows[0].n !== prItemIds.length) return { error: 'มีรายการอ้างอิง PR item ที่ไม่พบในบริษัทของคุณ' };
  }

  return { safeItems };
}

app.get('/api/customer/purchase-orders', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, projectId } = req.query;
  const conditions = ['po.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`po.status=$${params.length}`); }
  if (projectId) { params.push(parseInt(projectId, 10)); conditions.push(`po.project_id=$${params.length}`); }
  const r = await pool.query(`${CLIENT_PO_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY po.id DESC`, params);
  res.json({ purchaseOrders: r.rows.map(serializePurchaseOrder) });
});

app.get('/api/customer/purchase-orders/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const po = await fetchFullPurchaseOrder(pool, id, companyId);
  if (!po) return res.status(404).json({ error: 'ไม่พบใบสั่งซื้อ' });
  res.json({ purchaseOrder: po });
});

// ต้องมี Idempotency-Key เสมอ — กันกดสร้างซ้ำ (double-click) ได้ PO ซ้ำสองใบจากคำขอเดียวกัน
app.post('/api/customer/purchase-orders', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'purchase-orders-create', async (client) => {
    const companyId = req.customer.company_id;
    const { projectId, supplierName, supplierContact, issueDate, expectedDeliveryDate, paymentTerms, note, items } = req.body || {};

    const validation = await validatePoInput(client, companyId, { projectId, supplierName, items });
    if (validation.error) return { status: 400, body: { error: validation.error } };
    const { safeItems } = validation;

    const insert = await client.query(
      `INSERT INTO client_purchase_orders (company_id, project_id, supplier_name, supplier_contact, issue_date, expected_delivery_date, payment_terms, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [companyId, projectId || null, supplierName.trim(), (supplierContact || '').trim(),
       issueDate || new Date().toISOString().slice(0, 10), expectedDeliveryDate || null, (paymentTerms || '').trim(),
       (note || '').trim(), req.customer.id]
    );
    const poId = insert.rows[0].id;
    for (let i = 0; i < safeItems.length; i++) {
      const it = safeItems[i];
      await client.query(
        `INSERT INTO client_purchase_order_items (purchase_order_id, company_id, pr_item_id, idx, material, unit, qty, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [poId, companyId, it.prItemId, i, it.material, it.unit, it.qty, it.unitPrice]
      );
    }
    await recomputeClientPoTotalAmount(client, companyId, poId);

    const poResult = await fetchFullPurchaseOrder(client, poId, companyId); // client เดิม (ยังไม่ commit)
    return { status: 200, body: { purchaseOrder: poResult } };
  });
});

// แก้ไขได้เฉพาะ draft เท่านั้น (gate ด้านล่าง) — ไม่มีทางมี qty_ordered/qty_cancelled บนบรรทัดใดเลยตอนนั้น
// (consume เกิดตอน approve เท่านั้น) จึง delete+reinsert ทั้งก้อนได้อย่างปลอดภัย ไม่ต้องทำ diff แบบซับซ้อน
// เหมือน PUT ของ PR (ซึ่งต้องกัน "ลบรายการที่ถูกตัดยอดไปแล้ว" — เคสนั้นเกิดไม่ได้ที่นี่เลย)
app.put('/api/customer/purchase-orders/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { projectId, supplierName, supplierContact, issueDate, expectedDeliveryDate, paymentTerms, note, items } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poRes = await client.query('SELECT status FROM client_purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (poRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบสั่งซื้อ' }); }
    if (poRes.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'แก้ไขได้เฉพาะใบสั่งซื้อสถานะร่างเท่านั้น' });
    }

    const validation = await validatePoInput(client, companyId, { projectId, supplierName, items });
    if (validation.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: validation.error }); }
    const { safeItems } = validation;

    await client.query('DELETE FROM client_purchase_order_items WHERE purchase_order_id=$1', [id]);
    for (let i = 0; i < safeItems.length; i++) {
      const it = safeItems[i];
      await client.query(
        `INSERT INTO client_purchase_order_items (purchase_order_id, company_id, pr_item_id, idx, material, unit, qty, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, companyId, it.prItemId, i, it.material, it.unit, it.qty, it.unitPrice]
      );
    }

    await client.query(
      `UPDATE client_purchase_orders SET project_id=$1, supplier_name=$2, supplier_contact=$3, issue_date=$4, expected_delivery_date=$5, payment_terms=$6, note=$7 WHERE id=$8`,
      [projectId || null, supplierName.trim(), (supplierContact || '').trim(),
       issueDate || new Date().toISOString().slice(0, 10), expectedDeliveryDate || null, (paymentTerms || '').trim(), (note || '').trim(), id]
    );
    await recomputeClientPoTotalAmount(client, companyId, id);
    await client.query('COMMIT');
    res.json({ purchaseOrder: await fetchFullPurchaseOrder(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบสั่งซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// endpoint string ผูก :id ไว้ด้วยเสมอ (เหตุผลเดียวกับ PR — กันข้าม PO คนละใบ)
app.post('/api/customer/purchase-orders/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `purchase-orders-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;

    const r = await client.query('SELECT * FROM client_purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบสั่งซื้อ' } };
    const po = r.rows[0];
    if (po.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะใบสั่งซื้อสถานะร่างเท่านั้น' } };

    if (req.customer.id !== po.created_by) {
      const permCheck = await canApprove(client, req.customer, 'po_wo', po.total_amount, {
        companyId, originators: [po.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบสั่งซื้อนี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    const zeroCheck = await client.query('SELECT (total_amount <= 0) AS is_zero FROM client_purchase_orders WHERE id=$1', [id]);
    if (zeroCheck.rows[0].is_zero) {
      return { status: 400, body: { error: 'ไม่สามารถยื่นใบสั่งซื้อที่มียอดรวมเป็นศูนย์ได้' } };
    }

    const itemCount = await client.query('SELECT COUNT(*)::int AS n FROM client_purchase_order_items WHERE purchase_order_id=$1', [id]);
    if (itemCount.rows[0].n === 0) return { status: 400, body: { error: 'ใบสั่งซื้อต้องมีรายการอย่างน้อย 1 รายการ' } };

    // เตือนล่วงหน้าถ้าเกิน qty_remaining ของ PR item ที่อ้างอิง (ไม่ FOR UPDATE — แค่เตือน ยังไม่บังคับจริง
    // การเช็คบังคับจริงเกิดตอน /approve เท่านั้น เพราะ PR item อาจถูกใบอื่นตัดยอดไปหลังจากนี้ได้อีก)
    // group ด้วย pr_item_id+qty_remaining เท่านั้น (ไม่รวม material) กัน SUM แตกกลุ่มผิดถ้าผู้ใช้พิมพ์ material
    // ไม่เหมือนกันเป๊ะในหลายบรรทัดที่อ้าง pr_item_id เดียวกัน
    const overCheck = await client.query(
      `SELECT poi.pr_item_id, MIN(poi.material) AS material, SUM(poi.qty) AS requested_qty, pri.qty_remaining, pr.status AS pr_status
       FROM client_purchase_order_items poi
       JOIN client_purchase_request_items pri ON pri.id = poi.pr_item_id
       JOIN client_purchase_requests pr ON pr.id = pri.purchase_request_id
       WHERE poi.purchase_order_id=$1 AND poi.pr_item_id IS NOT NULL
       GROUP BY poi.pr_item_id, pri.qty_remaining, pr.status
       HAVING SUM(poi.qty) > pri.qty_remaining OR pr.status <> 'approved'`,
      [id]
    );
    if (overCheck.rowCount > 0) {
      const notApproved = overCheck.rows.filter(l => l.pr_status !== 'approved');
      const overQty = overCheck.rows.filter(l => l.pr_status === 'approved');
      const parts = [];
      if (notApproved.length > 0) parts.push(`PR ต้นทางยังไม่อนุมัติ: ${notApproved.map(l => `"${l.material}"`).join(', ')}`);
      if (overQty.length > 0) parts.push(`ขอเกินยอดคงเหลือ: ${overQty.map(l => `"${l.material}" (คงเหลือ ${l.qty_remaining})`).join(', ')}`);
      return { status: 400, body: { error: parts.join(' / ') } };
    }

    const poNo = await generateClientPoNumber(client, companyId);
    await client.query(
      `UPDATE client_purchase_orders SET po_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [poNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'purchase_order', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });

    const poResult = await fetchFullPurchaseOrder(client, id, companyId);
    return { status: 200, body: { purchaseOrder: poResult } };
  });
});

app.post('/api/customer/purchase-orders/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `purchase-orders-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;

    const r = await client.query('SELECT * FROM client_purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบสั่งซื้อ' } };
    const po = r.rows[0];
    if (po.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะใบสั่งซื้อที่ยื่นแล้วเท่านั้น' } };

    const result = await canApprove(client, req.customer, 'po_wo', po.total_amount, {
      companyId, originators: [po.created_by, po.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    const poItems = await client.query(
      'SELECT id, pr_item_id, material, qty FROM client_purchase_order_items WHERE purchase_order_id=$1 ORDER BY idx',
      [id]
    );
    const prItemIds = [...new Set(poItems.rows.filter(it => it.pr_item_id).map(it => it.pr_item_id))].sort((a, b) => a - b);

    if (prItemIds.length > 0) {
      // ลำดับล็อกคงที่ตาม id (กันเดดล็อกกับ endpoint อื่นที่ล็อก PR items หลายแถวเหมือนกัน) — statement
      // ล็อกอย่างเดียวแยกจาก statement คำนวณ SUM เสมอ ตาม CLAUDE.md ข้อ 7 (ห้ามรวม FOR UPDATE กับ
      // correlated subquery ที่อ่านตารางอื่นไว้ query เดียวกันถ้าผลจะถูกใช้ตัดสินใจ)
      await client.query('SELECT id FROM client_purchase_request_items WHERE id = ANY($1::int[]) FOR UPDATE', [prItemIds]);
      const checkRes = await client.query(
        `SELECT pri.id, pri.qty_remaining, pr.status AS pr_status,
           COALESCE((SELECT SUM(qty) FROM client_purchase_order_items WHERE pr_item_id=pri.id AND purchase_order_id=$2), 0) AS requested_qty
         FROM client_purchase_request_items pri
         JOIN client_purchase_requests pr ON pr.id = pri.purchase_request_id
         WHERE pri.id = ANY($1::int[])`,
        [prItemIds, id]
      );
      const materialById = new Map(poItems.rows.filter(it => it.pr_item_id).map(it => [it.pr_item_id, it.material]));
      const overLines = checkRes.rows.filter(row => Number(row.requested_qty) > Number(row.qty_remaining) || row.pr_status !== 'approved');
      if (overLines.length > 0) {
        const notApproved = overLines.filter(l => l.pr_status !== 'approved');
        const overQty = overLines.filter(l => l.pr_status === 'approved');
        const parts = [];
        if (notApproved.length > 0) parts.push(`PR ต้นทางไม่ใช่สถานะอนุมัติแล้ว: ${notApproved.map(l => `"${materialById.get(l.id)}"`).join(', ')}`);
        if (overQty.length > 0) parts.push(`เกินยอดคงเหลือ (อาจถูกใบอื่นตัดยอดไปก่อนหลังจากยื่นใบนี้): ${overQty.map(l => `"${materialById.get(l.id)}" (คงเหลือ ${l.qty_remaining}, ใบนี้ขอ ${l.requested_qty})`).join(', ')}`);
        return { status: 400, body: { error: `อนุมัติไม่ได้ — ${parts.join(' / ')}` } };
      }

      // auto-consume: 1 บรรทัด PO item = 1 แถว adjustment (ไม่ sum รวมข้ามบรรทัด แม้จะอ้าง pr_item_id
      // เดียวกันหลายบรรทัดก็ตาม — เพื่อให้ประวัติสืบย้อนกลับไปที่บรรทัด PO ต้นทางแต่ละบรรทัดได้ตรงไปตรงมา)
      for (const it of poItems.rows) {
        if (!it.pr_item_id) continue;
        await client.query(
          `INSERT INTO client_purchase_request_item_adjustments (pr_item_id, company_id, adjustment_type, qty, po_id, note, created_by)
           VALUES ($1,$2,'consume',$3,$4,$5,$6)`,
          [it.pr_item_id, companyId, it.qty, id, `ตัดยอดจาก PO ${po.po_no}`, req.customer.id]
        );
        await client.query('UPDATE client_purchase_request_items SET qty_ordered = qty_ordered + $1 WHERE id=$2', [it.qty, it.pr_item_id]);
      }
    }

    await client.query(
      `UPDATE client_purchase_orders SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
      [req.customer.id, id]
    );
    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'purchase_order', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason,
    });

    const poResult = await fetchFullPurchaseOrder(client, id, companyId);
    return { status: 200, body: { purchaseOrder: poResult } };
  });
});

app.post('/api/customer/purchase-orders/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบสั่งซื้อ' }); }
    const po = r.rows[0];
    if (po.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะใบสั่งซื้อที่ยื่นแล้วเท่านั้น' });
    }

    const permCheck = await canApprove(client, req.customer, 'po_wo', po.total_amount, {
      companyId, originators: [po.created_by, po.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: permCheck.message, code: permCheck.code });
    }

    await client.query(`UPDATE client_purchase_orders SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_order', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    res.json({ purchaseOrder: await fetchFullPurchaseOrder(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบสั่งซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้จาก draft/submitted/approved ทั้งหมดในเฟสนี้ — ระบบยังไม่มีกลไก "รับของ" (goods receipt) หรือ
// payment voucher ผูกกับ PO เลยแม้แต่นิดเดียว จึงยังไม่มีอะไรให้เช็คจริงว่า "รับของ/จ่ายเงินไปแล้วบางส่วน"
// ⚠️ เมื่อมีระบบรับของในอนาคต ต้องเพิ่มเงื่อนไขห้าม cancel ถ้ารับของแล้วบางส่วน (mirror PR's qty_ordered>0
// ก่อน cancel) และถ้ามี payment voucher อ้างอิง PO นี้แล้วต้องบล็อกด้วย — ดู pr-module-known-limitations.md
app.post('/api/customer/purchase-orders/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบสั่งซื้อ' }); }
    const po = r.rows[0];
    const status = po.status;
    if (!['draft', 'submitted', 'approved'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกใบสั่งซื้อในสถานะนี้ได้' });
    }

    const isOwner = req.customer.id === po.created_by || (po.submitted_by != null && req.customer.id === po.submitted_by);
    let cancelIsOverride = false;
    if (!isOwner) {
      const permCheck = await canApprove(client, req.customer, 'po_wo', po.total_amount, {
        companyId, originators: [po.created_by, po.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบสั่งซื้อนี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
      cancelIsOverride = permCheck.isOverride;
    }

    if (status === 'approved') {
      // auto-release: คืนยอดทุกบรรทัดที่เคย consume ไปตอน approve — 1 บรรทัด PO item ถูก consume แค่ครั้ง
      // เดียวตอน approve เท่านั้น (ไม่มีทาง consume ซ้ำ) จึง release เท่ากับ qty เดิมของบรรทัดนั้นได้ตรงๆ
      // โดยไม่ต้องเช็ค SUM(release)<=SUM(consume) แบบ endpoint /release แบบ manual (คำนวณ 1:1 อยู่แล้ว)
      const poItems = await client.query(
        'SELECT id, pr_item_id, qty FROM client_purchase_order_items WHERE purchase_order_id=$1 AND pr_item_id IS NOT NULL',
        [id]
      );
      const prItemIds = [...new Set(poItems.rows.map(it => it.pr_item_id))].sort((a, b) => a - b);
      if (prItemIds.length > 0) {
        await client.query('SELECT id FROM client_purchase_request_items WHERE id = ANY($1::int[]) FOR UPDATE', [prItemIds]);
      }
      for (const it of poItems.rows) {
        await client.query(
          `INSERT INTO client_purchase_request_item_adjustments (pr_item_id, company_id, adjustment_type, qty, po_id, note, created_by)
           VALUES ($1,$2,'release',$3,$4,$5,$6)`,
          [it.pr_item_id, companyId, it.qty, id, `คืนยอด — ยกเลิก PO ${po.po_no}`, req.customer.id]
        );
        await client.query('UPDATE client_purchase_request_items SET qty_ordered = qty_ordered - $1 WHERE id=$2', [it.qty, it.pr_item_id]);
      }
    }

    await client.query(`UPDATE client_purchase_orders SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_order', docId: id, action: 'cancel',
      fromStatus: status, toStatus: 'cancelled', performedBy: req.customer.id, isOverride: cancelIsOverride,
    });
    await client.query('COMMIT');
    res.json({ purchaseOrder: await fetchFullPurchaseOrder(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบสั่งซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- Customer: client ledger — PR Module: canApprove() + audit log (ใช้ร่วมข้อ 4 และ
// ---------------- ทุกโมดูลถัดไปที่ต้องอนุมัติ — ดู client_pr_approval_rules ใน schema.sql (migration
// ---------------- 0002)) ----------------
// doc_type -> ตารางต้นทาง + คอลัมน์ที่ผู้เรียกต้องใช้ประกอบ documentMeta.originators (เอกสารแต่ละ
// ประเภทเก็บ "ใครเป็นผู้ริเริ่ม" ไว้คนละชื่อคอลัมน์ ไม่มีคอลัมน์กลางร่วมกัน):
//   'pr'         -> client_purchase_requests  : originators = [requested_by, submitted_by]
//                   (ตารางนี้ไม่มี created_by เลย ใช้ requested_by แทน)
//   'petty_cash' -> client_payment_vouchers   : originators = [created_by, submitted_by]
//   'po_wo'      -> (ยังไม่มีตารางจริง — จะกำหนดคอลัมน์ตอนเขียนโมดูลข้อ 2)
const APPROVAL_DOC_TYPE_FLAG_COLUMN = {
  pr: 'can_approve_pr',
  po_wo: 'can_approve_po_wo',
  petty_cash: 'can_approve_petty_cash',
  advance: 'can_approve_advance',
  other: 'can_approve_other',
  progress: 'can_approve_progress',
};
const APPROVAL_DOC_TYPE_LABEL_TH = {
  pr: 'ใบขอซื้อ (PR)',
  po_wo: 'ใบสั่งซื้อ/หนังสือสั่งจ้าง (PO/WO)',
  petty_cash: 'เงินสดย่อย',
  advance: 'เงินทดรองจ่าย',
  other: 'จ่ายเจ้าหนี้ภายนอก',
  progress: 'ใบขอเบิกความคืบหน้าโครงการ',
};
// docType ของ canApprove จาก voucher_type — ใช้ร่วมกันทุก endpoint ของ payment-vouchers (submit/approve/
// reject/cancel) กันพิมพ์ ternary ซ้ำคนละจุดแล้วพลาดไม่ตรงกัน
function paymentVoucherDocType(voucherType) {
  if (voucherType === 'advance') return 'advance';
  if (voucherType === 'other') return 'other';
  return 'petty_cash';
}

// canApprove(client, approver, docType, amount, documentMeta) — จุดตรวจสิทธิ์อนุมัติแบบรวมศูนย์จุด
// เดียวสำหรับทั้งโมดูล ห้ามกระจาย if-check สิทธิ์ไปตามแต่ละ route
//
// ออกแบบเป็น fail-closed อย่างเข้มงวด: อินพุตที่กำกวม/ไม่ครบ (amount ไม่ใช่ตัวเลข, ไม่ส่ง documentMeta,
// originators ว่างเปล่า, approver ขาดฟิลด์) ทำให้ throw ทันที ไม่ใช่ตกลงไปถึง return {allowed:true}
// โดยไม่ตั้งใจ — เจตนาให้ caller เห็น error ชัดเจนตอนพัฒนา/ทดสอบ ดีกว่าปล่อยให้ผ่านอย่างเงียบๆ ตอนใช้จริง
//
// ⚠️ ข้อบังคับสำหรับผู้เรียก (บางข้อ canApprove ตรวจให้ได้ บางข้อบังคับไม่ได้ ต้องพึ่งวินัยของ caller):
//   1. `client` ต้องเป็น client ที่เปิดทรานแซกชัน (`BEGIN`) ไว้แล้วเท่านั้น ไม่ใช่ `pool` เฉยๆ — และ
//      ต้องเป็น client เดียวกับที่จะ UPDATE สถานะเอกสารเป็น 'approved' ต่อจากนี้ (ตรวจให้ไม่ได้)
//   2. `amount` ต้องเป็นค่าที่เพิ่ง `SELECT total_amount(หรือคอลัมน์ยอดของ doc นั้น) ... FOR UPDATE`
//      มาด้วย client ตัวเดียวกันนี้ ในทรานแซกชันเดียวกันนี้ ห้ามรับมาจาก request body, ห้ามใช้ค่าที่
//      คำนวณ/query ไว้ก่อนหน้านี้คนละ query (ตรวจได้แค่ "เป็นตัวเลขจำกัด ไม่ติดลบ" ไม่ใช่ "มาจาก FOR
//      UPDATE จริงหรือเปล่า" — ข้อนั้นพึ่งวินัย caller) — ต้องเป็น JS number แท้ๆ แล้ว (ไม่ใช่ string จาก
//      pg NUMERIC ที่ยังไม่แปลง) มิฉะนั้น Number.isFinite จะปฏิเสธเป็น throw ตรงนี้เลย
//   3. `documentMeta.companyId` ต้องมาจากแถวเดียวกับที่ FOR UPDATE ไว้ในข้อ 2 (canApprove ตรวจว่าตรงกับ
//      approver.company_id เท่านั้น ตรวจไม่ได้ว่ามาจากแถวที่ถูกต้องจริงหรือเปล่า)
//
// ตรรกะการตรวจ (ตามลำดับ, หยุดที่ข้อแรกที่ปฏิเสธ/throw):
//   -1. ตรวจความครบถ้วนของ approver/amount/documentMeta/originators ก่อนเสมอ — ขาด/ผิดชนิด = throw
//   0. self-approval: approver.id ตรงกับตัวใดตัวหนึ่งใน originators → ปฏิเสธเสมอ **รวมถึง super_user**
//      (เข้มกว่ากรณี certify progress claim ที่ยอมให้ super_user override ได้ — ที่นี่ไม่มีข้อยกเว้นเลย)
//   1. approver.status ต้องเป็น 'active'
//   2. role==='super_user' → อนุมัติได้ทันที (isOverride:true) — ยกเว้นติดข้อ 0/1 ไปแล้ว
//   3. ต้องมี flag ที่ตรงประเภทเอกสาร (can_approve_pr/po_wo/petty_cash)
//   4. ต้องมี client_pr_approval_rules แถวที่ is_active=true ของ approver คนนี้+docType นี้
//   5. amount ต้องอยู่ในช่วง [min_amount, max_amount] ของ rule นั้น — เปรียบเทียบฝั่ง SQL ด้วย ::numeric
//      เสมอ (ไม่แปลงเป็น JS Number ก่อนเทียบ เพราะ pg คืน NUMERIC เป็น string แล้ว Number() มีความเสี่ยง
//      เรื่อง precision กับเลขจำนวนมากๆ) — Number() ใช้แค่ตอน format ข้อความ error หลังผ่านการเทียบแล้ว
//
// company_id ไม่ใช่พารามิเตอร์แยกของฟังก์ชันนี้เลย — ผูกอยู่กับ approver.company_id เสมอ ดังนั้น
// super_user ก็ยังถูกจำกัดอยู่ในบริษัทของตัวเองเสมอโดยธรรมชาติของพารามิเตอร์ — เสริมด้วย
// documentMeta.companyId ที่ต้องตรงกับ approver.company_id ทุกครั้ง (throw ถ้าไม่ตรง)
//
// คืนค่าเป็น object เสมอเมื่อเป็น business-rejection (ไม่ throw) เพื่อให้ route แยกข้อความตรงสาเหตุได้:
//   { allowed:true, isOverride:false, ruleId, maxAmount }  — อนุมัติได้ปกติผ่าน rule จริง
//   { allowed:true, isOverride:true }                      — super_user ข้าม (ต้อง log override)
//   { allowed:false, code:'self_approval', message }
//   { allowed:false, code:'approver_inactive', message }
//   { allowed:false, code:'no_permission', message }
//   { allowed:false, code:'no_rule', message }
//   { allowed:false, code:'over_ceiling', message }
//   { allowed:false, code:'under_floor', message }

// รับค่า qty/amount จาก client ได้ทั้ง JS number และ numeric string (เหตุผลเดียวกับ amount ของ canApprove
// ด้านล่าง) — คืนค่า "ดั้งเดิม" กลับไป (ไม่แปลงผ่าน Number()) ให้ caller ส่งเข้า SQL เป็น $N::numeric
// ตรงๆ เสมอ เพราะ NUMERIC(18,4)/NUMERIC(18,2) มีตัวเลขนัยสำคัญได้ถึง 18 หลัก ซึ่งเกินขอบเขตที่ JS number
// (IEEE754 double, mantissa 53 บิต ≈ 15-16 หลักนัยสำคัญ) รับประกันความแม่นยำได้ — ถ้าแปลงเป็น Number()
// ก่อนแล้วค่อยส่งเข้า query จำนวน/ยอดเงินที่มีเลขจำนวนมากๆ หรือทศนิยมละเอียดอาจเพี้ยนได้ ขัดกับกฎที่บันทึก
// ไว้ใน CLAUDE.md ("ห้ามเทียบ/คำนวณเงินและจำนวนด้วย JS Number") — คืน null ถ้าไม่ใช่จำนวนบวกที่ถูกต้อง
// (caller ต้องปฏิเสธเป็น 400 เอง) ใช้ Number(...) กับค่าที่คืนมาได้เฉพาะตอน format ข้อความแสดงผลเท่านั้น
function parsePositiveNumericValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0) return raw;
  return null;
}

// เหมือน parsePositiveNumericValue ทุกประการ ต่างกันแค่ยอมรับ 0 ด้วย (เช่น unit_price ที่แถวของ
// รายการฟรีถูกต้องตามธุรกิจจริงได้) และค่าที่ไม่ได้ส่งมาเลย (undefined/null/'') ถือเป็น 0 โดยปริยาย —
// ค่าที่ส่งมาแต่ parse ไม่ได้ (เช่น string ที่ไม่ใช่ตัวเลข หรือติดลบ) ยังคงคืน null ให้ caller ปฏิเสธ
// เป็น 400 เอง (ไม่ default เงียบๆ เป็น 0 ในกรณีนั้น เพื่อไม่ให้ input ผิดพลาดกลายเป็นของฟรีโดยไม่ตั้งใจ)
function parseNonNegativeNumericValue(raw) {
  if (raw === undefined || raw === null || raw === '') return '0';
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw)) return raw;
  return null;
}

// options.enforceAmountLimit (default true): approve ต้องเทียบเพดานเต็มรูปแบบ (over_ceiling/
// under_floor) เสมอ แต่ submit/reject/cancel ต้องส่ง { enforceAmountLimit: false } เข้ามาเสมอ —
// เพราะ 3 action นี้เป็นการ "ยืนยันว่ามีสิทธิ์ดำเนินการกับเอกสารประเภทนี้จริง" (มี flag + มี active
// rule อยู่จริง) ไม่ใช่ "อนุมัติวงเงินตามเพดาน" ถ้าไม่แยกโหมดออกจากกัน หัวหน้าที่เพดาน 50,000 จะ reject
// PR ยอด 100,000 ไม่ได้เลย (โดน over_ceiling ปฏิเสธ ทั้งที่ reject ไม่ได้ทำให้เงินเคลื่อนไหว ไม่ควรมี
// เพดานผูกอยู่) — ยังคงต้องมี active rule อยู่จริงแม้ enforceAmountLimit=false เพราะต้องพิสูจน์ว่าเป็น
// ผู้มีสิทธิ์เกี่ยวข้องกับเอกสารประเภทนี้จริง ไม่ใช่ทุกคนที่มี flag=true จะ reject/cancel เอกสารของคนอื่นได้
async function canApprove(client, approver, docType, amount, documentMeta, options = {}) {
  const { enforceAmountLimit = true } = options;
  // --- ตรวจ approver ให้ครบก่อนอื่นใด — ขาดฟิลด์ไหนบอกชื่อฟิลด์นั้นตรงๆ (กัน "ทุกคนโดน
  // approver_inactive อย่างไม่มีสาเหตุ" ที่เกิดจาก object ไม่ครบ ไม่ใช่ธุรกิจจริงที่ควรปฏิเสธ) ---
  if (typeof approver?.id !== 'number') throw new Error('canApprove: approver.id ขาดหายไปหรือไม่ใช่ตัวเลข');
  if (typeof approver?.company_id !== 'number') throw new Error('canApprove: approver.company_id ขาดหายไปหรือไม่ใช่ตัวเลข');
  if (typeof approver?.status !== 'string') throw new Error('canApprove: approver.status ขาดหายไปหรือไม่ใช่ string');
  if (typeof approver?.role !== 'string') throw new Error('canApprove: approver.role ขาดหายไปหรือไม่ใช่ string');
  const flagColumn = APPROVAL_DOC_TYPE_FLAG_COLUMN[docType];
  if (!flagColumn) throw new Error(`canApprove: docType ไม่รู้จัก: ${docType}`);
  if (typeof approver[flagColumn] !== 'boolean') {
    throw new Error(`canApprove: approver.${flagColumn} ขาดหายไปหรือไม่ใช่ boolean`);
  }

  // --- amount: รับได้ทั้ง JS number และ numeric string (pg คืนคอลัมน์ NUMERIC เป็น string เสมอ — ค่าที่
  // มาจาก `SELECT total_amount ... FOR UPDATE` ตามกฎที่บังคับไว้ จะเป็น string ถ้าไม่แปลง จึงต้องรับได้
  // ทั้งสองแบบ ไม่งั้น caller ที่ทำตามกฎ (ไม่แปลงเอง) จะโดน throw ทั้งที่ทำถูกแล้ว) — string ตรวจด้วย
  // regex ตัวเลขล้วน (จุดทศนิยม optional, ไม่มีเครื่องหมายลบ) ไม่ใช้ Number.isFinite กับ string เพราะ
  // Number.isFinite('123') === false เสมอ (เป็น type check ไม่ใช่ value check) ---
  const amountIsValidNumber = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  const amountIsValidNumericString = typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount);
  if (!amountIsValidNumber && !amountIsValidNumericString) {
    throw new Error(`canApprove: amount ต้องเป็นตัวเลขจำกัดไม่ติดลบ (number หรือ numeric string) ได้รับ: ${JSON.stringify(amount)}`);
  }

  // --- documentMeta บังคับต้องส่ง ห้ามใช้ documentMeta || {} เพราะจะข้ามเช็ค self-approval เงียบๆ ---
  if (!documentMeta || typeof documentMeta !== 'object') {
    throw new Error('canApprove: ต้องระบุ documentMeta ({companyId, originators})');
  }
  const { companyId, originators } = documentMeta;
  if (companyId !== approver.company_id) {
    throw new Error(`canApprove: documentMeta.companyId (${companyId}) ไม่ตรงกับ approver.company_id (${approver.company_id})`);
  }
  if (!Array.isArray(originators)) {
    throw new Error('canApprove: documentMeta.originators ต้องเป็น array');
  }
  const nonNullOriginators = originators.filter(v => v != null);
  if (nonNullOriginators.length === 0) {
    throw new Error('canApprove: documentMeta.originators ต้องมีค่าที่ไม่ใช่ null อย่างน้อยหนึ่งตัว (ผู้สร้าง/ผู้ยื่นเอกสาร)');
  }
  // สมาชิกทุกตัวต้องเป็น number จริง ไม่ใช่ string ตัวเลข — '12' !== 12 ตอน .includes() ด้านล่าง (เทียบ
  // แบบเข้มงวด) ถ้าปล่อยผ่านไปเงียบๆ self-approval จะหลุดได้จริง (ผู้สร้างคือ approver.id=12 แต่ถูกส่ง
  // มาเป็น '12' จะไม่ match ทำให้เอกสารของตัวเองอนุมัติผ่านได้)
  const invalidOriginator = nonNullOriginators.find(v => typeof v !== 'number');
  if (invalidOriginator !== undefined) {
    throw new Error(`canApprove: documentMeta.originators มีสมาชิกที่ไม่ใช่ number: ${JSON.stringify(originators)}`);
  }

  if (originators.includes(approver.id)) {
    return {
      allowed: false,
      code: 'self_approval',
      message: 'ผู้สร้างหรือผู้ยื่นเอกสารนี้ไม่สามารถอนุมัติเอกสารของตัวเองได้',
    };
  }

  if (approver.status !== 'active') {
    return {
      allowed: false,
      code: 'approver_inactive',
      message: 'บัญชีผู้อนุมัตินี้ถูกระงับการใช้งานแล้ว ไม่สามารถอนุมัติเอกสารได้',
    };
  }

  // super_user ข้ามทุกเงื่อนไข — ไม่มี ruleId/maxAmount ให้ (ไม่เคย query rule เลย) ผู้เรียกที่จะ
  // writeAuditLog(...) ต่อจากผลลัพธ์นี้ ต้องใช้ reason รูปแบบคงที่ เช่น
  // `'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'` — ห้ามอ้างอิง ruleId/maxAmount
  // ในข้อความ (จะกลายเป็น "rule #undefined" เพราะทั้งสองเป็น undefined ในผลลัพธ์นี้จริงๆ)
  if (approver.role === 'super_user') {
    return { allowed: true, isOverride: true };
  }

  const docLabel = APPROVAL_DOC_TYPE_LABEL_TH[docType] || docType;
  if (!approver[flagColumn]) {
    return {
      allowed: false,
      code: 'no_permission',
      message: `ไม่มีสิทธิ์อนุมัติเอกสารประเภท${docLabel}`,
    };
  }

  // เทียบ amount กับ min_amount/max_amount ฝั่ง SQL โดยตรงด้วย ::numeric — ส่ง amount ตัวดั้งเดิม (number
  // หรือ numeric string ก็ได้ตามที่ตรวจผ่านมาแล้วข้างบน) เข้า $4::numeric ตรงๆ ไม่แปลงเป็น JS Number
  // ก่อนส่ง เพื่อไม่ให้ผ่าน floating-point เลยตลอดเส้นทางนี้ (pg คืนคอลัมน์ NUMERIC เป็น string, Number()
  // มีความเสี่ยง precision กับเลขจำนวนมากๆ) คืนผลเทียบเป็น boolean มาจาก DB ตรงๆ, ใช้ Number() แปลง
  // min_amount/max_amount/amount เฉพาะตอน format ข้อความ error ให้คนอ่านเท่านั้น (ไม่ใช่ตอนตัดสินใจ)
  const r = await client.query(
    `SELECT id, min_amount, max_amount,
            ($4::numeric > max_amount) AS is_over_ceiling,
            ($4::numeric < min_amount) AS is_under_floor
     FROM client_pr_approval_rules
     WHERE company_id=$1 AND approver_customer_id=$2 AND doc_type=$3 AND is_active=true`,
    [approver.company_id, approver.id, docType, amount]
  );

  if (r.rowCount === 0) {
    return {
      allowed: false,
      code: 'no_rule',
      message: `ยังไม่มีการตั้งค่าเพดานวงเงินอนุมัติสำหรับท่านในเอกสารประเภท${docLabel} กรุณาติดต่อผู้ดูแลระบบให้ตั้งกฎอนุมัติเพิ่ม`,
    };
  }

  const row = r.rows[0];
  const amountForDisplay = Number(amount);
  // เทียบเพดานเฉพาะเมื่อ enforceAmountLimit=true เท่านั้น (approve) — submit/reject/cancel ข้าม 2 เช็ค
  // นี้ไปโดยเจตนา (ดูคอมเมนต์ที่ท้ายพารามิเตอร์ฟังก์ชันด้านบน)
  if (enforceAmountLimit && row.is_over_ceiling) {
    return {
      allowed: false,
      code: 'over_ceiling',
      message: `ยอดเอกสาร (${amountForDisplay.toLocaleString('th-TH')} บาท) เกินเพดานอนุมัติของท่าน (ไม่เกิน ${Number(row.max_amount).toLocaleString('th-TH')} บาท)`,
    };
  }
  if (enforceAmountLimit && row.is_under_floor) {
    return {
      allowed: false,
      code: 'under_floor',
      message: `ยอดเอกสาร (${amountForDisplay.toLocaleString('th-TH')} บาท) ต่ำกว่าขั้นต่ำที่ท่านได้รับมอบหมายให้อนุมัติ (ตั้งแต่ ${Number(row.min_amount).toLocaleString('th-TH')} บาทขึ้นไป)`,
    };
  }

  // maxAmount (Number, สะดวกต่อการ format ข้อความ) และ maxAmountRaw (string ดั้งเดิมจาก pg, แม่นยำเป๊ะ
  // ไม่ผ่าน float) คืนไปทั้งคู่ — writeAuditLog ควรใช้ maxAmountRaw ตอนสร้าง reason ของ action='approve'
  // เพื่อบันทึกค่าที่แม่นยำจริง ไม่ใช่ผ่าน Number() ที่เสี่ยง precision กับเลขจำนวนมากๆ
  return { allowed: true, isOverride: false, ruleId: row.id, maxAmount: Number(row.max_amount), maxAmountRaw: row.max_amount };
}

// เขียน audit log กลาง (client_document_audit_log) — ทุก action ที่เปลี่ยนสถานะเอกสาร (submit/approve/
// reject/cancel/consume/release/certify/void ฯลฯ) ต้องเรียกฟังก์ชันนี้เสมอ ไม่กระจาย INSERT เองตามจุด
// ต่างๆ ของแต่ละ route — ต้องอยู่ในทรานแซกชันเดียวกับการเปลี่ยนสถานะจริง (รับ client ไม่ใช่ pool ตรงๆ)
//
// action='approve' บังคับต้องมี reason เสมอ (throw ถ้าว่าง) — ควรเป็นข้อความอ้างอิง ruleId/maxAmount ที่
// canApprove() คืนมา (เช่น `อนุมัติผ่าน rule #${ruleId} (เพดาน ${maxAmount} บาท)`) เพื่อให้ตรวจสอบ
// ย้อนหลังได้ว่าตอนอนุมัติจริงใช้กฎ/เพดานข้อไหนตัดสิน แม้ client_pr_approval_rules แถวนั้นจะถูกแก้ไข/
// ปิดไปแล้วทีหลังก็ตาม (audit log ไม่ได้ FK ไปที่ rule โดยตรง เพราะต้องการค่าที่ "แช่แข็ง" ไว้ ณ เวลานั้น)
async function writeAuditLog(client, { companyId, docType, docId, action, fromStatus, toStatus, performedBy, isOverride, reason }) {
  if (action === 'approve' && !reason) {
    throw new Error('writeAuditLog: action=approve ต้องระบุ reason เสมอ (อ้างอิง rule/เพดานที่ใช้ตัดสิน)');
  }
  await client.query(
    `INSERT INTO client_document_audit_log
       (company_id, doc_type, doc_id, action, from_status, to_status, performed_by, is_override, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, docType, docId, action, fromStatus || null, toStatus || null, performedBy, !!isOverride, reason || '']
  );
}

// ---------------- Customer-facing: เพดานวงเงินอนุมัติต่อผู้ใช้ต่อประเภทเอกสาร (client_pr_approval_rules) ----------------
// คู่กับ flag can_approve_* เสมอ — มี flag อย่างเดียวไม่พอ canApprove() ด้านบนต้องมีแถว rule ที่
// is_active=true ด้วยถึงจะอนุมัติได้จริง (โค้ด flag เขียนเสร็จมาตั้งแต่ migration 0007 แต่ไม่มี endpoint
// ให้ตั้ง rule เลยจนถึงตอนนี้ — จุดนี้เองที่ทำให้โมดูล 1.2/1.4 อนุมัติจริงไม่ได้แม้ flag จะตั้งได้แล้ว)
// doc_type ที่รองรับตรงกับ CHECK ของตาราง (ขยายไปแล้วโดย migration 0004/0006 ให้รองรับ advance/other —
// ตรวจยืนยันจาก DB จริงแล้วว่าไม่ต้องมี migration ใหม่)
const APPROVAL_RULE_DOC_TYPES = new Set(['pr', 'po_wo', 'petty_cash', 'advance', 'other', 'progress']);

// ตั้ง rule ใหม่ทับของเดิมเสมอ (ไม่มี "แก้เพดานในที่เดิม") — ปิด rule เก่าเป็น is_active=false ก่อนเสมอ
// (ไม่ลบ เก็บประวัติไว้ตรวจย้อนหลังได้ตามที่ตกลง) แล้วค่อย INSERT แถวใหม่ — ต้องเรียงลำดับ UPDATE-ก่อน-
// INSERT ในทรานแซกชันเดียวกันเท่านั้น ไม่งั้น uq_client_pr_approval_rules_active (partial unique index บน
// WHERE is_active) จะ conflict เพราะมี 2 แถว active ของ (company,approver,doc_type) เดียวกันพร้อมกันชั่วขณะ
async function upsertApprovalRule(client, { actor, approverCustomerId, companyId, docType, minAmount, maxAmount, description }) {
  if (actor.role !== 'super_user') {
    return { status: 403, body: { error: 'เฉพาะผู้ดูแลระบบ (super_user) เท่านั้นที่มีสิทธิ์ตั้งเพดานวงเงินอนุมัติ' } };
  }
  if (!Number.isInteger(approverCustomerId)) {
    return { status: 400, body: { error: 'ระบุผู้ได้รับสิทธิ์อนุมัติไม่ถูกต้อง' } };
  }
  if (approverCustomerId === actor.id) {
    return { status: 403, body: { error: 'ไม่สามารถตั้งเพดานวงเงินอนุมัติให้ตัวเองได้' } };
  }
  if (!APPROVAL_RULE_DOC_TYPES.has(docType)) {
    return { status: 400, body: { error: 'ประเภทเอกสารไม่ถูกต้อง' } };
  }
  // min_amount ยอมรับ 0 (ตรงกับ default ของ schema), max_amount ต้อง > 0 เสมอ (เพดาน 0 ไม่มีความหมาย
  // ทางธุรกิจ — ไม่มีใครอนุมัติอะไรได้เลยถ้าเพดานสูงสุดเป็น 0)
  const min = parseNonNegativeNumericValue(minAmount);
  const max = parsePositiveNumericValue(maxAmount);
  if (min === null) return { status: 400, body: { error: 'เพดานขั้นต่ำไม่ถูกต้อง (ต้องเป็นตัวเลขไม่ติดลบ)' } };
  if (max === null) return { status: 400, body: { error: 'เพดานสูงสุดไม่ถูกต้อง (ต้องเป็นตัวเลขมากกว่า 0)' } };
  const desc = typeof description === 'string' ? description.trim() : '';

  // ล็อกแถวผู้ใช้เป้าหมายเป็นคำสั่งแรกสุดเสมอ (เหมือน updateUserPermissionFlag) — กันสอง POST พร้อมกัน
  // สำหรับ approver+doc_type เดียวกัน race กันตอน deactivate-ตัวเก่า+insert-ตัวใหม่ (ล็อกที่แถว customers
  // เพราะแถว rule เดิมอาจยังไม่มีอยู่เลยตอนตั้งครั้งแรก ล็อกแถวที่มีอยู่แน่นอนเสมอแทน)
  const targetRes = await client.query('SELECT * FROM customers WHERE id=$1 AND company_id=$2 FOR UPDATE', [approverCustomerId, companyId]);
  if (targetRes.rowCount === 0) {
    return { status: 404, body: { error: 'ไม่พบผู้ใช้งาน' } };
  }
  const target = targetRes.rows[0];
  if (target.status !== 'active') {
    return { status: 409, body: { error: 'ผู้ใช้งานนี้ถูกระงับการใช้งานอยู่ ตั้งเพดานวงเงินไม่ได้' } };
  }

  const cmpRes = await client.query('SELECT ($1::numeric >= $2::numeric) AS ok', [max, min]);
  if (!cmpRes.rows[0].ok) {
    return { status: 400, body: { error: 'เพดานสูงสุดต้องมากกว่าหรือเท่ากับเพดานขั้นต่ำ' } };
  }

  const oldRes = await client.query(
    `SELECT * FROM client_pr_approval_rules WHERE company_id=$1 AND approver_customer_id=$2 AND doc_type=$3 AND is_active=true`,
    [companyId, approverCustomerId, docType]
  );
  const old = oldRes.rows[0] || null;
  if (old) {
    await client.query(`UPDATE client_pr_approval_rules SET is_active=false WHERE id=$1`, [old.id]);
  }
  const insRes = await client.query(
    `INSERT INTO client_pr_approval_rules (company_id, approver_customer_id, doc_type, min_amount, max_amount, description, is_active)
     VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6,true) RETURNING *`,
    [companyId, approverCustomerId, docType, min, max, desc]
  );
  const newRule = insRes.rows[0];

  const docLabel = APPROVAL_DOC_TYPE_LABEL_TH[docType] || docType;
  const reason = old
    ? `ตั้งเพดานวงเงินอนุมัติเอกสารประเภท${docLabel}ใหม่ (rule #${newRule.id}): ${min}-${max} บาท — แทนที่ rule #${old.id} เดิม (${old.min_amount}-${old.max_amount} บาท, ปิดใช้งานแล้ว ไม่ลบ)`
    : `ตั้งเพดานวงเงินอนุมัติเอกสารประเภท${docLabel}ใหม่ (rule #${newRule.id}): ${min}-${max} บาท`;
  await writeAuditLog(client, {
    companyId, docType: 'user_permission', docId: approverCustomerId, action: 'grant',
    fromStatus: old ? `rule#${old.id}:${old.min_amount}-${old.max_amount}` : null,
    toStatus: `rule#${newRule.id}:${min}-${max}`,
    performedBy: actor.id, reason,
  });

  return { status: 200, body: { rule: newRule } };
}

async function editApprovalRuleDescription(client, { actor, ruleId, companyId, description }) {
  if (actor.role !== 'super_user') {
    return { status: 403, body: { error: 'เฉพาะผู้ดูแลระบบ (super_user) เท่านั้นที่มีสิทธิ์แก้ไขเพดานวงเงินอนุมัติ' } };
  }
  if (typeof description !== 'string') {
    return { status: 400, body: { error: 'กรุณาระบุรายละเอียด' } };
  }
  const r = await client.query('SELECT * FROM client_pr_approval_rules WHERE id=$1 AND company_id=$2 FOR UPDATE', [ruleId, companyId]);
  if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบเพดานวงเงินอนุมัตินี้' } };
  const rule = r.rows[0];
  if (rule.approver_customer_id === actor.id) {
    return { status: 403, body: { error: 'ไม่สามารถแก้ไขเพดานวงเงินอนุมัติของตัวเองได้' } };
  }
  // แก้ได้เฉพาะ rule ที่ active — rule ที่ปิดไปแล้วคือประวัติ ห้ามแก้ย้อนหลัง (ดูเหตุผลเดียวกับที่ต้อง
  // deactivate แทนลบ/แก้ทับตอนตั้ง rule ใหม่)
  if (!rule.is_active) {
    return { status: 409, body: { error: 'เพดานวงเงินนี้ถูกปิดใช้งานแล้ว แก้ไขไม่ได้ (เป็นประวัติ)' } };
  }
  const desc = description.trim();
  if (desc === rule.description) {
    return { status: 200, body: { rule } }; // ไม่เปลี่ยนแปลงจริง ไม่ log (เหมือน updateUserPermissionFlag)
  }
  const updated = await client.query('UPDATE client_pr_approval_rules SET description=$1 WHERE id=$2 RETURNING *', [desc, ruleId]);
  await writeAuditLog(client, {
    companyId, docType: 'user_permission', docId: rule.approver_customer_id, action: 'grant',
    fromStatus: rule.description, toStatus: desc, performedBy: actor.id,
    reason: `แก้ไขรายละเอียดเพดานวงเงินอนุมัติ (rule #${ruleId})`,
  });
  return { status: 200, body: { rule: updated.rows[0] } };
}

async function deactivateApprovalRule(client, { actor, ruleId, companyId }) {
  if (actor.role !== 'super_user') {
    return { status: 403, body: { error: 'เฉพาะผู้ดูแลระบบ (super_user) เท่านั้นที่มีสิทธิ์ปิดใช้งานเพดานวงเงินอนุมัติ' } };
  }
  const r = await client.query('SELECT * FROM client_pr_approval_rules WHERE id=$1 AND company_id=$2 FOR UPDATE', [ruleId, companyId]);
  if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบเพดานวงเงินอนุมัตินี้' } };
  const rule = r.rows[0];
  if (rule.approver_customer_id === actor.id) {
    return { status: 403, body: { error: 'ไม่สามารถปิดใช้งานเพดานวงเงินอนุมัติของตัวเองได้' } };
  }
  if (!rule.is_active) {
    return { status: 200, body: { rule } }; // ปิดอยู่แล้ว ไม่เปลี่ยนแปลงจริง ไม่ log
  }
  const updated = await client.query('UPDATE client_pr_approval_rules SET is_active=false WHERE id=$1 RETURNING *', [ruleId]);
  const docLabel = APPROVAL_DOC_TYPE_LABEL_TH[rule.doc_type] || rule.doc_type;
  await writeAuditLog(client, {
    companyId, docType: 'user_permission', docId: rule.approver_customer_id, action: 'revoke',
    fromStatus: `rule#${ruleId} active`, toStatus: `rule#${ruleId} inactive`, performedBy: actor.id,
    reason: `ปิดใช้งานเพดานวงเงินอนุมัติเอกสารประเภท${docLabel} (rule #${ruleId}: ${rule.min_amount}-${rule.max_amount} บาท)`,
  });
  return { status: 200, body: { rule: updated.rows[0] } };
}

app.get('/api/customer/pr-approval-rules', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query(
    `SELECT r.*, c.name AS approver_name
     FROM client_pr_approval_rules r
     JOIN customers c ON c.company_id = r.company_id AND c.id = r.approver_customer_id
     WHERE r.company_id = $1
     ORDER BY c.name, r.doc_type, r.created_at DESC`,
    [companyId]
  );
  res.json({ rules: r.rows });
});

app.post('/api/customer/pr-approval-rules', requireCustomerAuth, async (req, res) => {
  const { approverCustomerId, docType, minAmount, maxAmount, description } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertApprovalRule(client, {
      actor: req.customer, approverCustomerId: parseInt(approverCustomerId, 10), companyId: req.customer.company_id,
      docType, minAmount, maxAmount, description,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.put('/api/customer/pr-approval-rules/:id', requireCustomerAuth, async (req, res) => {
  const ruleId = parseInt(req.params.id, 10);
  const { description } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await editApprovalRuleDescription(client, {
      actor: req.customer, ruleId, companyId: req.customer.company_id, description,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.post('/api/customer/pr-approval-rules/:id/deactivate', requireCustomerAuth, async (req, res) => {
  const ruleId = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await deactivateApprovalRule(client, {
      actor: req.customer, ruleId, companyId: req.customer.company_id,
    });
    if (result.status !== 200) { await client.query('ROLLBACK'); return res.status(result.status).json(result.body); }
    await client.query('COMMIT');
    res.status(200).json(result.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------- Idempotency (ใช้กับ endpoint ที่เคลื่อนไหวเงิน/สถานะสำคัญ เช่น submit/approve) ----
// ดูสคีมา+เหตุผลเต็มใน migrations/0001_pr_batch1_payment_vouchers.up.sql — สรุปเชิงปฏิบัติ:
//   ก้อนที่ 1 "จอง": INSERT ... ON CONFLICT DO NOTHING (หรือ UPDATE reserved_at แบบ compare-and-swap
//   ถ้า stale เกิน 5 นาที) — commit ทันที แยกทรานแซกชันจากก้อนที่ 2 โดยสิ้นเชิง
//   ก้อนที่ 2 "งานธุรกิจ + บันทึกผล": handler(client) กับ UPDATE response_status/body อยู่ทรานแซกชัน
//   เดียวกัน — พังตรงไหน rollback ทั้งก้อน + ลบ reservation ทิ้งทันที (ไม่ต้องรอ stale window)
const IDEMPOTENCY_STALE_MS = 5 * 60 * 1000;
const IDEMPOTENCY_MAX_AGE_DAYS = 7;
const IDEMPOTENCY_PURGE_THROTTLE_MS = 60 * 60 * 1000;
const IDEMPOTENCY_PURGE_BATCH_SIZE = 500;

function canonicalizeForHash(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  const sorted = {};
  for (const k of Object.keys(value).sort()) sorted[k] = canonicalizeForHash(value[k]);
  return sorted;
}
function computeRequestHash(body) {
  const json = JSON.stringify(canonicalizeForHash(body || {}));
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

// handler: async (client) => ({status, body}) — client อยู่ในทรานแซกชันเดียวกับที่จะ UPDATE
// response_status/response_body เสมอ (ก้อนที่ 2 ข้างบน) ฟังก์ชันนี้เป็นเจ้าของ response lifecycle
// ทั้งหมด (เรียก res.status().json() เอง) — route ที่เรียกไม่ต้องทำอะไรต่อจากนี้อีก
async function withIdempotency(req, res, endpoint, handler) {
  const key = req.get('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'ต้องระบุ Idempotency-Key' });
  const companyId = req.customer.company_id;
  const requestHash = computeRequestHash(req.body);

  let reservation;
  const claim = await pool.query(
    `INSERT INTO client_idempotency_keys (company_id, idempotency_key, endpoint, request_hash)
     VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, idempotency_key, endpoint) DO NOTHING
     RETURNING id, reserved_at`,
    [companyId, key, endpoint, requestHash]
  );

  if (claim.rowCount > 0) {
    reservation = claim.rows[0];
  } else {
    const existing = await pool.query(
      `SELECT id, request_hash, response_status, response_body, reserved_at FROM client_idempotency_keys
       WHERE company_id=$1 AND idempotency_key=$2 AND endpoint=$3`,
      [companyId, key, endpoint]
    );
    const row = existing.rows[0];
    if (row.request_hash !== requestHash) {
      return res.status(422).json({ error: 'ใช้ Idempotency-Key นี้ซ้ำกับข้อมูลคำขอที่ต่างจากเดิม' });
    }
    if (row.response_status !== null) {
      return res.status(row.response_status).json(row.response_body);
    }
    const ageMs = Date.now() - new Date(row.reserved_at).getTime();
    if (ageMs < IDEMPOTENCY_STALE_MS) {
      return res.status(409).json({ error: 'คำขอนี้กำลังประมวลผลอยู่ กรุณาลองใหม่อีกครั้ง' });
    }
    const reclaim = await pool.query(
      `UPDATE client_idempotency_keys SET reserved_at = now() WHERE id=$1 AND reserved_at=$2 RETURNING id, reserved_at`,
      [row.id, row.reserved_at]
    );
    if (reclaim.rowCount === 0) {
      return res.status(409).json({ error: 'คำขอนี้กำลังประมวลผลอยู่ กรุณาลองใหม่อีกครั้ง' });
    }
    reservation = reclaim.rows[0];
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { status, body } = await handler(client);
    if (status >= 200 && status < 300) {
      // สำเร็จจริง — cache ไว้ ครั้งถัดไปด้วย key เดิมคืนผลเดิมเป๊ะ ไม่ทำงานซ้ำ
      await client.query(
        'UPDATE client_idempotency_keys SET response_status=$1, response_body=$2 WHERE id=$3',
        [status, JSON.stringify(body), reservation.id]
      );
      await client.query('COMMIT');
      client.release();
      res.status(status).json(body);
    } else {
      // ไม่ใช่ 2xx (400/403/404/409 ฯลฯ) — ต้อง ROLLBACK เสมอ ห้าม COMMIT แล้วค่อยลบ reservation ทีหลัง
      // ⚠️ กฎตายตัวสำหรับ handler ทุกตัวที่ผ่าน withIdempotency (ไม่ใช่แค่ตอนนี้ที่ทุก route คืน 4xx ก่อน
      // ถึงคำสั่ง UPDATE ที่แก้ข้อมูลจริงเสมอ — กฎนี้ต้องคงอยู่แม้ handler ในอนาคตจะมี side-effect เขียน
      // ไปแล้วบางส่วนก่อนเจอเงื่อนไข 4xx ทีหลังในฟังก์ชันเดียวกันก็ตาม): ถ้าใช้ COMMIT แทน ROLLBACK ตรงนี้
      // แม้จะลบ reservation ทิ้งทันทีหลังจากนั้น การเขียนที่เกิดขึ้นจริงในทรานแซกชันนั้นจะ "ติดค้างถาวร"
      // ในตาราง แม้ response ที่ผู้ใช้เห็นจะเป็น error (ไม่ cache) ก็ตาม — ผู้ใช้เห็น 400 แล้วกดใหม่ได้ แต่
      // ข้อมูลที่เขียนไปแล้วรอบแรกจะไม่ถูกล้าง กลายเป็น partial write ที่มองไม่เห็นจาก response เลย —
      // ไม่ cache เป็นเจตนาแยกต่างหาก: ลบ reservation ทิ้งแทน เพื่อให้ผู้ใช้กดซ้ำด้วย Idempotency-Key เดิม
      // ได้อีกครั้งหลังแก้ปัญหาแล้ว (เช่น เอกสารถูกแก้ไขให้ครบถ้วนแล้วค่อย submit ใหม่) แทนที่จะติด error
      // เดิมค้างตลอดไปเพราะแค่บังเอิญใช้ key ซ้ำ
      await client.query('ROLLBACK');
      client.release();
      await pool.query('DELETE FROM client_idempotency_keys WHERE id=$1', [reservation.id]).catch(e => console.error('idempotency cleanup failed:', e.message));
      res.status(status).json(body);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('idempotency rollback failed:', rollbackErr.message); }
    client.release();
    await pool.query('DELETE FROM client_idempotency_keys WHERE id=$1', [reservation.id]).catch(e => console.error('idempotency cleanup failed:', e.message));
    console.error(`[${endpoint}] handler error:`, err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการประมวลผล' });
  }

  maybeLazyPurgeIdempotencyKeys().catch(err => console.error('idempotency purge failed (non-fatal):', err.message));
}

async function maybeLazyPurgeIdempotencyKeys() {
  const state = await pool.query('SELECT last_purged_at FROM client_idempotency_purge_state WHERE id=1');
  const lastPurgedAt = state.rows[0]?.last_purged_at;
  if (lastPurgedAt && (Date.now() - new Date(lastPurgedAt).getTime()) < IDEMPOTENCY_PURGE_THROTTLE_MS) return;
  await pool.query('UPDATE client_idempotency_purge_state SET last_purged_at = now() WHERE id=1');
  const r = await pool.query(
    `DELETE FROM client_idempotency_keys WHERE id IN (
       SELECT id FROM client_idempotency_keys WHERE created_at < now() - interval '${IDEMPOTENCY_MAX_AGE_DAYS} days' LIMIT $1
     )`,
    [IDEMPOTENCY_PURGE_BATCH_SIZE]
  );
  if (r.rowCount > 0) console.log(`idempotency purge: deleted ${r.rowCount} rows`);
}

// ---------------- Customer: client ledger — ใบขอซื้อ (Purchase Requests, ข้อ 4) ----------------
// backend จริงตัวแรกของฟีเจอร์นี้ — DB.prs เดิมใน pr-system.html ไม่มี backend เลย (submit-pr แค่ push
// เข้า array ในหน่วยความจำ) ตารางที่ prs/pr_items/pr_history เดิมในไฟล์นี้ (ต้นไฟล์) เป็นระบบภายในของ
// SiteReq เอง (requester_id -> users, ไม่มี company_id) คนละระบบกันโดยสิ้นเชิง ไม่เกี่ยวข้องกัน
function serializePrItem(row) {
  return {
    id: row.id,
    budgetItemId: row.budget_item_id,
    idx: row.idx,
    material: row.material,
    unit: row.unit,
    qtyRequested: Number(row.qty_requested),
    qtyOrdered: Number(row.qty_ordered),
    qtyCancelled: Number(row.qty_cancelled),
    qtyRemaining: Number(row.qty_remaining),
    unitPrice: Number(row.unit_price),
    estimatedAmount: Number(row.estimated_amount),
  };
}
function serializePurchaseRequest(row) {
  return {
    id: row.id,
    prNo: row.pr_no,
    projectId: row.project_id,
    projectName: row.project_name || null,
    source: row.source,
    budgetRevisionId: row.budget_revision_id,
    requestedBy: row.requested_by,
    requestDate: row.request_date,
    neededDate: row.needed_date,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    totalAmount: Number(row.total_amount),
    approvedAmount: row.approved_amount != null ? Number(row.approved_amount) : null,
    note: row.note,
    createdAt: row.created_at,
  };
}
const CLIENT_PR_SELECT = `
  SELECT pr.id, pr.pr_no, pr.project_id, cp.name AS project_name, pr.source, pr.budget_revision_id,
    pr.requested_by, to_char(pr.request_date,'YYYY-MM-DD') AS request_date,
    to_char(pr.needed_date,'YYYY-MM-DD') AS needed_date, pr.status, pr.submitted_by, pr.submitted_at,
    pr.approved_by, pr.approved_at, pr.rejected_reason, pr.total_amount, pr.approved_amount, pr.note,
    pr.created_at
  FROM client_purchase_requests pr
  LEFT JOIN client_projects cp ON cp.id = pr.project_id`;
// scope ด้วย company_id ตรงๆ ที่ระดับ query เสมอ (ไม่พึ่งว่า caller เช็คมาก่อนแล้วเท่านั้น — เป็นจุด
// เดียวในไฟล์นี้ที่เคยหลุด convention นี้ไป แก้ให้ตรงกับทุกจุดอื่นในไฟล์)
const CLIENT_PR_ITEMS_SELECT = `
  SELECT id, budget_item_id, idx, material, unit, qty_requested, qty_ordered, qty_cancelled,
    qty_remaining, unit_price, estimated_amount
  FROM client_purchase_request_items WHERE purchase_request_id=$1 AND company_id=$2 ORDER BY idx`;

// dbClient เป็น pool หรือ client ที่เปิดทรานแซกชันไว้แล้วก็ได้ (ให้ผู้เรียกที่ยังไม่ commit อ่านข้อมูล
// ของตัวเองที่เพิ่งเขียนไปได้ถูกต้อง) — companyId บังคับเสมอ ไม่มี default ที่ปล่อยให้ลืมส่งได้
async function fetchFullPurchaseRequest(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_PR_SELECT} WHERE pr.id=$1 AND pr.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  const items = await dbClient.query(CLIENT_PR_ITEMS_SELECT, [id, companyId]);
  const pr = serializePurchaseRequest(r.rows[0]);
  pr.items = items.rows.map(serializePrItem);
  return pr;
}

// ปี พ.ศ. ต้องคำนวณจาก timezone Asia/Bangkok เสมอ ไม่ใช่ timezone ของเครื่อง server (ถ้า server รันคนละ
// timezone ช่วงใกล้เที่ยงคืนอาจคำนวณปีผิดได้) — ใช้ Intl.DateTimeFormat แทน .getFullYear() ตรงๆ
function getBangkokYear() {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' });
  return parseInt(formatter.format(new Date()), 10);
}

async function generateClientPrNumber(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'purchase_request');
    const no = `PR-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_purchase_requests WHERE company_id=$1 AND pr_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ PR ได้');
}

// total_amount เขียนจาก SUM(items.estimated_amount) เสมอ ในทรานแซกชันเดียวกับที่แก้ items — ไม่เคยเชื่อ
// ค่าที่ client ส่งมาตรงๆ (กฎเดียวกับ total_expense_amount ของ client_advance_clearances)
async function recomputeClientPrTotalAmount(client, companyId, prId) {
  await client.query(
    `UPDATE client_purchase_requests SET total_amount = COALESCE(
       (SELECT SUM(estimated_amount) FROM client_purchase_request_items WHERE purchase_request_id=$1), 0)
     WHERE id=$1 AND company_id=$2`,
    [prId, companyId]
  );
}

// ตรวจ input ร่วมของ POST (สร้างใหม่) และ PUT (แก้ไข) — คืน {error} ถ้าไม่ผ่าน หรือ {safeItems} ถ้าผ่าน
// dbClient รับ pool (POST — ยังไม่มีทรานแซกชันเปิดตอนเรียก) หรือ client ที่เปิดทรานแซกชันไว้แล้ว
// (PUT — ต้องอ่านด้วย client เดียวกับที่ถือ FOR UPDATE lock ไว้ ไม่ใช่คนละ connection)
async function validatePrInput(dbClient = pool, companyId, { projectId, source, budgetRevisionId, items }) {
  if (!projectId) return { error: 'กรุณาเลือกโครงการ' };
  const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
  if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };

  if (!['boq', 'manual'].includes(source)) return { error: 'กรุณาระบุที่มาของ PR (boq หรือ manual)' };

  if (source === 'boq') {
    if (!budgetRevisionId) return { error: 'PR แบบดึงจาก BOQ ต้องระบุ budget revision' };
    const rev = await dbClient.query('SELECT 1 FROM client_budget_revisions WHERE id=$1 AND company_id=$2', [budgetRevisionId, companyId]);
    if (rev.rowCount === 0) return { error: 'ไม่พบ budget revision นี้ในบริษัทของคุณ' };
  } else if (budgetRevisionId) {
    return { error: 'PR แบบ manual ต้องไม่ระบุ budget revision' };
  }

  // qtyRequested/unitPrice ต้องเป็น string ดั้งเดิมจาก parsePositiveNumericValue/parseNonNegativeNumericValue
  // เสมอ (ห้ามผ่าน Number() ก่อน — qty_requested/unit_price เป็น NUMERIC(18,4)/NUMERIC(18,2) ซึ่งมีเลข
  // นัยสำคัญเกินขอบเขตที่ JS number การันตีความแม่นยำได้) รายการที่กรอก material ว่าง หรือ qty parse
  // ไม่ผ่าน/ไม่บวก จะถูกข้ามไปเงียบๆ (พฤติกรรมเดิม — แถวว่างที่ผู้ใช้ยังกรอกไม่เสร็จ) แต่ unitPrice ที่ระบุ
  // มาแล้ว parse ไม่ผ่าน (เช่น ติดลบ) ต้องปฏิเสธทั้งคำขอเป็น 400 แทนที่จะ default เงียบๆ เป็น 0
  const safeItems = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const material = String(it.material || '').trim();
    const qtyRequested = parsePositiveNumericValue(it.qtyRequested);
    if (!material || qtyRequested === null) continue;
    const unitPrice = parseNonNegativeNumericValue(it.unitPrice);
    if (unitPrice === null) return { error: `รายการ "${material}" ระบุราคาต่อหน่วยไม่ถูกต้อง` };
    safeItems.push({
      id: it.id || null,
      budgetItemId: it.budgetItemId || null,
      material,
      unit: String(it.unit || '').trim() || '-',
      qtyRequested,
      unitPrice,
    });
  }
  if (safeItems.length === 0) return { error: 'กรุณากรอกรายการอย่างน้อย 1 รายการ' };

  if (source === 'boq' && safeItems.some(it => !it.budgetItemId)) {
    return { error: 'PR แบบดึงจาก BOQ ทุกรายการต้องอ้างอิง budget item' };
  }
  if (source === 'manual' && safeItems.some(it => it.budgetItemId)) {
    return { error: 'PR แบบ manual ต้องไม่อ้างอิง budget item' };
  }

  if (source === 'boq') {
    const budgetItemIds = [...new Set(safeItems.map(it => it.budgetItemId))];
    const check = await dbClient.query(
      `SELECT COUNT(*)::int AS n FROM client_budget_items WHERE id = ANY($1::int[]) AND company_id=$2 AND revision_id=$3`,
      [budgetItemIds, companyId, budgetRevisionId]
    );
    if (check.rows[0].n !== budgetItemIds.length) {
      return { error: 'มีรายการ budget item ที่ไม่ตรงกับ revision ที่ระบุ หรือไม่พบในบริษัทของคุณ' };
    }
  }

  return { safeItems };
}

app.get('/api/customer/purchase-requests', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, projectId, source } = req.query;
  const conditions = ['pr.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`pr.status=$${params.length}`); }
  if (projectId) { params.push(parseInt(projectId, 10)); conditions.push(`pr.project_id=$${params.length}`); }
  if (source) { params.push(source); conditions.push(`pr.source=$${params.length}`); }
  const r = await pool.query(`${CLIENT_PR_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY pr.id DESC`, params);
  res.json({ purchaseRequests: r.rows.map(serializePurchaseRequest) });
});

app.get('/api/customer/purchase-requests/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const pr = await fetchFullPurchaseRequest(pool, id, companyId);
  if (!pr) return res.status(404).json({ error: 'ไม่พบใบขอซื้อ' });
  res.json({ purchaseRequest: pr });
});

// ต้องมี Idempotency-Key เสมอ — กันกดสร้างซ้ำ (double-click) ได้ PR ซ้ำสองใบจากคำขอเดียวกัน
app.post('/api/customer/purchase-requests', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'purchase-requests-create', async (client) => {
    const companyId = req.customer.company_id;
    const { projectId, source, budgetRevisionId, neededDate, note, items } = req.body || {};

    const validation = await validatePrInput(client, companyId, { projectId, source, budgetRevisionId, items });
    if (validation.error) return { status: 400, body: { error: validation.error } };
    const { safeItems } = validation;

    const insert = await client.query(
      `INSERT INTO client_purchase_requests (company_id, project_id, source, budget_revision_id, requested_by, needed_date, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, projectId, source, budgetRevisionId || null, req.customer.id, neededDate || null, (note || '').trim()]
    );
    const prId = insert.rows[0].id;
    for (let i = 0; i < safeItems.length; i++) {
      const it = safeItems[i];
      await client.query(
        `INSERT INTO client_purchase_request_items (purchase_request_id, company_id, budget_item_id, idx, material, unit, qty_requested, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [prId, companyId, it.budgetItemId, i, it.material, it.unit, it.qtyRequested, it.unitPrice]
      );
    }
    await recomputeClientPrTotalAmount(client, companyId, prId);

    const prResult = await fetchFullPurchaseRequest(client, prId, companyId); // client เดิม (ยังไม่ commit)
    return { status: 200, body: { purchaseRequest: prResult } };
  });
});

// แก้ไขแบบ diff-based (คง id เดิมของรายการที่ไม่เปลี่ยน) — ห้ามลบ/ลดยอดรายการที่มี qty_ordered หรือ
// qty_cancelled มากกว่า 0 ไปแล้ว (ถูก consume/cancel ไปแล้วจริง) ตามที่ตกลง
app.put('/api/customer/purchase-requests/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { projectId, source, budgetRevisionId, neededDate, note, items } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prRes = await client.query('SELECT status FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (prRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอซื้อ' }); }
    if (prRes.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'แก้ไขได้เฉพาะใบขอซื้อสถานะร่างเท่านั้น' });
    }

    const validation = await validatePrInput(client, companyId, { projectId, source, budgetRevisionId, items });
    if (validation.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: validation.error }); }
    const { safeItems } = validation;

    // is_locked เทียบ qty_ordered/qty_cancelled กับ 0 ฝั่ง SQL ตรงๆ (ไม่ผ่าน Number() ในโค้ดแอป) ตามกฎ
    // เดียวกับ has_enough ของ endpoint consume/release/cancel-qty — แม้ 0 จะเป็นค่าคงที่ที่ Number()
    // แปลงได้แม่นยำเสมอ แต่คงรูปแบบเดียวกันทั้งไฟล์เพื่อไม่ต้องแยกจำว่าจุดไหนปลอดภัยพอที่จะยกเว้นได้
    const existingItems = await client.query(
      'SELECT id, (qty_ordered > 0 OR qty_cancelled > 0) AS is_locked FROM client_purchase_request_items WHERE purchase_request_id=$1',
      [id]
    );
    const existingIds = new Set(existingItems.rows.map(row => row.id));
    const incomingIds = new Set(safeItems.filter(it => it.id).map(it => it.id));

    for (const existing of existingItems.rows) {
      if (incomingIds.has(existing.id)) continue;
      if (existing.is_locked) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `ไม่สามารถลบรายการ id=${existing.id} ได้ เนื่องจากมีการตัด/ลดยอดไปแล้ว` });
      }
      await client.query('DELETE FROM client_purchase_request_items WHERE id=$1', [existing.id]);
    }

    // Phase 1: ตั้ง idx ของรายการเดิมที่ยังอยู่เป็นค่าลบชั่วคราวก่อน (= -id, การันตีไม่ซ้ำกันเองในตัว
    // เพราะ id แต่ละแถวไม่ซ้ำกันอยู่แล้ว) กัน UNIQUE(company_id, purchase_request_id, idx) ชนกันตอน
    // ผู้ใช้สลับลำดับรายการ (เช่น สลับ idx 0 กับ 1 — ถ้า UPDATE ทีละแถวด้วยค่าจริงเลย แถวแรกที่เปลี่ยน
    // เป็น idx=1 จะชนกับแถวที่สองซึ่งยังเป็น idx=1 อยู่ ณ ขณะนั้น)
    for (const it of safeItems) {
      if (it.id) await client.query('UPDATE client_purchase_request_items SET idx = -id WHERE id = $1', [it.id]);
    }

    // Phase 2: ตั้งค่าจริงทั้งหมด (idx ตามตำแหน่งใหม่) — ไม่มีทางชนกันอีกเพราะทุกแถวผ่านค่าลบชั่วคราวแล้ว
    for (let i = 0; i < safeItems.length; i++) {
      const it = safeItems[i];
      if (it.id) {
        if (!existingIds.has(it.id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `ไม่พบรายการ id=${it.id}` }); }
        // เทียบ qtyRequested (ค่าจาก client ผ่าน parsePositiveNumericValue มาแล้ว) กับ qty_ordered+qty_cancelled
        // เดิมของแถวนี้ฝั่ง SQL ด้วย ::numeric เสมอ — ห้ามแปลงทั้งสองฝั่งเป็น JS Number มาเทียบ (กฎเดียวกับ
        // has_enough ของ consume/release/cancel-qty) เพราะ it.qtyRequested อาจมีทศนิยม/หลักเกิน JS number
        // การันตีความแม่นยำได้จริง
        const minCheck = await client.query(
          `SELECT (qty_ordered + qty_cancelled) AS min_qty, ($2::numeric >= (qty_ordered + qty_cancelled)) AS meets_min
           FROM client_purchase_request_items WHERE id=$1`,
          [it.id, it.qtyRequested]
        );
        if (!minCheck.rows[0].meets_min) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `ลดจำนวนรายการ id=${it.id} ต่ำกว่ายอดที่ตัด/ลดไปแล้วไม่ได้ (ขั้นต่ำ ${minCheck.rows[0].min_qty})` });
        }
        await client.query(
          `UPDATE client_purchase_request_items SET budget_item_id=$1, idx=$2, material=$3, unit=$4, qty_requested=$5, unit_price=$6 WHERE id=$7`,
          [it.budgetItemId, i, it.material, it.unit, it.qtyRequested, it.unitPrice, it.id]
        );
      } else {
        await client.query(
          `INSERT INTO client_purchase_request_items (purchase_request_id, company_id, budget_item_id, idx, material, unit, qty_requested, unit_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, companyId, it.budgetItemId, i, it.material, it.unit, it.qtyRequested, it.unitPrice]
        );
      }
    }

    await client.query(
      `UPDATE client_purchase_requests SET project_id=$1, source=$2, budget_revision_id=$3, needed_date=$4, note=$5 WHERE id=$6`,
      [projectId, source, budgetRevisionId || null, neededDate || null, (note || '').trim(), id]
    );
    await recomputeClientPrTotalAmount(client, companyId, id);
    await client.query('COMMIT');
    res.json({ purchaseRequest: await fetchFullPurchaseRequest(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบขอซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ต้องมี Idempotency-Key เสมอ (ต่อกับกลไก withIdempotency ที่ตั้งไว้ใน batch 1) — ก้อนที่ 2 (งานธุรกิจ
// จริง: FOR UPDATE + ออกเลขที่ + UPDATE สถานะ + writeAuditLog) ทั้งหมดอยู่ใน client เดียวกับที่
// withIdempotency เปิดทรานแซกชันไว้ให้ ไม่เปิด connection ของตัวเองแยกต่างหาก
// endpoint string ผูก :id ไว้ด้วยเสมอ (`purchase-requests-submit:${id}`) — ถ้าใช้ endpoint เดียวกันทุก
// PR (ไม่ผูก id) แล้ว client ดันส่ง Idempotency-Key ซ้ำข้าม PR คนละใบ (เช่น บั๊กฝั่ง frontend ไม่สร้าง
// key ใหม่ทุกครั้ง) จะทำให้ PR ใบที่สองได้ response ของใบแรกย้อนกลับไปเฉยๆ โดยไม่ถูกยื่นจริง — พบจริงจาก
// การตรวจโค้ด ไม่ใช่แค่ทฤษฎี
app.post('/api/customer/purchase-requests/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `purchase-requests-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;

    const r = await client.query('SELECT * FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอซื้อ' } };
    const pr = r.rows[0];
    if (pr.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะใบขอซื้อสถานะร่างเท่านั้น' } };

    // สิทธิ์ยื่น: ผู้สร้าง (requested_by) เองเสมอ หรือผู้มีสิทธิ์อนุมัติจริง (flag+rule ผ่าน canApprove,
    // เผื่อกรณีอนุมัติยื่นแทนผู้ขอ) — เช็คผู้สร้างก่อนเพื่อไม่ให้ชนกับ self-approval logic ใน canApprove
    // (ผู้สร้างยื่นใบตัวเองต้องผ่านได้เสมอ แม้จะบังเอิญมีสิทธิ์อนุมัติด้วยก็ตาม)
    if (req.customer.id !== pr.requested_by) {
      // enforceAmountLimit:false — ยื่นแทนผู้ขอไม่ใช่การอนุมัติวงเงิน ไม่ควรมีเพดานผูก
      const permCheck = await canApprove(client, req.customer, 'pr', pr.total_amount, {
        companyId, originators: [pr.requested_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบขอซื้อนี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    // total_amount ต้องมากกว่า 0 — canApprove() เองปล่อยผ่านได้เพราะ min_amount ค่าเริ่มต้นเป็น 0 จึง
    // ต้องกันตรงนี้แทน (บันทึกกฎนี้ไว้ตามที่ตกลง: route ต้องปฏิเสธ PR total_amount=0 ตอน submit) — เทียบ
    // ฝั่ง SQL ด้วย ::numeric เสมอตามกฎ ไม่แปลง pr.total_amount (string จาก pg) เป็น JS Number มาเทียบ
    const zeroCheck = await client.query('SELECT (total_amount <= 0) AS is_zero FROM client_purchase_requests WHERE id=$1', [id]);
    if (zeroCheck.rows[0].is_zero) {
      return { status: 400, body: { error: 'ไม่สามารถยื่นใบขอซื้อที่มียอดรวมเป็นศูนย์ได้' } };
    }

    const items = await client.query('SELECT budget_item_id FROM client_purchase_request_items WHERE purchase_request_id=$1 AND company_id=$2', [id, companyId]);
    if (items.rowCount === 0) return { status: 400, body: { error: 'ใบขอซื้อต้องมีรายการอย่างน้อย 1 รายการ' } };
    if (pr.source === 'boq') {
      // ข้อ 4.1.1: ทุกรายการต้องมี budget_item_id ก่อนยื่น
      if (items.rows.some(it => !it.budget_item_id)) {
        return { status: 400, body: { error: 'PR แบบดึงจาก BOQ ทุกรายการต้องอ้างอิง budget item ก่อนยื่น' } };
      }
      // กฎที่เพิ่มภายหลัง: budget_item_id ทุกตัวต้องอยู่ revision เดียวกับหัวเอกสารนี้เท่านั้น
      const budgetItemIds = [...new Set(items.rows.map(it => it.budget_item_id))];
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM client_budget_items WHERE id = ANY($1::int[]) AND company_id=$2 AND revision_id=$3`,
        [budgetItemIds, companyId, pr.budget_revision_id]
      );
      if (check.rows[0].n !== budgetItemIds.length) {
        return { status: 400, body: { error: 'มีรายการ budget item ที่ไม่อยู่ใน revision เดียวกับหัวเอกสารนี้' } };
      }
    }

    const prNo = await generateClientPrNumber(client, companyId);
    await client.query(
      `UPDATE client_purchase_requests SET pr_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [prNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });

    // อ่านย้อนกลับด้วย client เดียวกัน (ไม่ใช่ pool) เพราะยังอยู่ในทรานแซกชันที่ยังไม่ commit
    const prResult = await fetchFullPurchaseRequest(client, id, companyId);
    return { status: 200, body: { purchaseRequest: prResult } };
  });
});

// endpoint string ผูก :id ไว้ด้วยเสมอ เหตุผลเดียวกับ /submit ข้างบน
app.post('/api/customer/purchase-requests/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `purchase-requests-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;

    // FOR UPDATE ตามกฎที่ canApprove บังคับ — total_amount ที่ส่งเข้า canApprove ต้องมาจากแถวที่ล็อกไว้
    // ในทรานแซกชันเดียวกันนี้เท่านั้น (pr.total_amount เป็น string จาก pg NUMERIC — ส่งตรงๆ ไม่แปลง)
    const r = await client.query('SELECT * FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอซื้อ' } };
    const pr = r.rows[0];
    if (pr.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะใบขอซื้อที่ยื่นแล้วเท่านั้น' } };

    const result = await canApprove(client, req.customer, 'pr', pr.total_amount, {
      companyId,
      originators: [pr.requested_by, pr.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    await client.query(
      `UPDATE client_purchase_requests SET status='approved', approved_by=$1, approved_at=now(), approved_amount=$2 WHERE id=$3`,
      [req.customer.id, pr.total_amount, id]
    );
    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason,
    });

    const prResult = await fetchFullPurchaseRequest(client, id, companyId);
    return { status: 200, body: { purchaseRequest: prResult } };
  });
});

// สิทธิ์ปฏิเสธ (reject) ใช้ canApprove() ตัวเดียวกับ approve เป๊ะ — ปฏิเสธเป็นคู่ตรงข้ามของอนุมัติใน
// กระบวนการเดียวกัน จึงต้องมี flag+rule เหมือนกัน และบล็อก self-approval เหมือนกัน (canApprove เช็คให้
// อยู่แล้วในตัว ไม่ต้องเขียนซ้ำ) — ไม่ได้ผูก idempotency (ไม่ได้ถูกร้องขอ)
app.post('/api/customer/purchase-requests/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอซื้อ' }); }
    const pr = r.rows[0];
    if (pr.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะใบขอซื้อที่ยื่นแล้วเท่านั้น' });
    }

    // enforceAmountLimit:false — reject ไม่ใช่การอนุมัติวงเงิน ผู้มีเพดาน 50,000 ต้องปฏิเสธ PR ยอด
    // 100,000 ได้เหมือนกัน (ยังต้องมี flag+active rule จริงอยู่ดี แค่ไม่เทียบยอด)
    const permCheck = await canApprove(client, req.customer, 'pr', pr.total_amount, {
      companyId, originators: [pr.requested_by, pr.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: permCheck.message, code: permCheck.code });
    }

    await client.query(`UPDATE client_purchase_requests SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    res.json({ purchaseRequest: await fetchFullPurchaseRequest(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบขอซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้จาก draft/submitted/approved — แต่ถ้า approved แล้ว ต้องไม่มีรายการไหนถูกตัดยอด (qty_ordered>0)
// ไปแล้ว (มิเช่นนั้นจะมี PO ที่อ้างอิง PR ที่ถูกยกเลิกไปแล้ว ตามกฎที่บันทึกไว้ในสคีมา)
// สิทธิ์ยกเลิก: ผู้สร้าง/ผู้ยื่นเอกสารนั้นเอง หรือผู้มีสิทธิ์อนุมัติจริง (flag+rule ผ่าน canApprove)
app.post('/api/customer/purchase-requests/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบขอซื้อ' }); }
    const pr = r.rows[0];
    const status = pr.status;
    if (!['draft', 'submitted', 'approved'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกใบขอซื้อในสถานะนี้ได้' });
    }

    const isOwner = req.customer.id === pr.requested_by || (pr.submitted_by != null && req.customer.id === pr.submitted_by);
    let cancelIsOverride = false;
    if (!isOwner) {
      // enforceAmountLimit:false — ยกเลิกไม่ใช่การอนุมัติวงเงิน (เหตุผลเดียวกับ reject ด้านบน)
      const permCheck = await canApprove(client, req.customer, 'pr', pr.total_amount, {
        companyId, originators: [pr.requested_by, pr.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบขอซื้อนี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
      cancelIsOverride = permCheck.isOverride;
    }

    if (status === 'approved') {
      const consumed = await client.query(
        'SELECT COUNT(*)::int AS n FROM client_purchase_request_items WHERE purchase_request_id=$1 AND company_id=$2 AND qty_ordered > 0',
        [id, companyId]
      );
      if (consumed.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'ไม่สามารถยกเลิกได้ เนื่องจากมีรายการที่ถูกตัดยอดไปสร้าง PO แล้ว' });
      }
    }
    await client.query(`UPDATE client_purchase_requests SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'cancel',
      fromStatus: status, toStatus: 'cancelled', performedBy: req.customer.id, isOverride: cancelIsOverride,
    });
    await client.query('COMMIT');
    res.json({ purchaseRequest: await fetchFullPurchaseRequest(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบขอซื้อไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- ใบขอซื้อ: consume/release/cancel-qty รายการ (ข้อ 4.4) ----------------
// can_manage_po (migration 0007) OR super_user เสมอ — ห้ามใช้ can_approve_pr (สิทธิ์ "อนุมัติ PR") ปน
// กับสิทธิ์นี้เด็ดขาด เพราะเป็นคนละหน้าที่กันโดยเจตนา (ผู้อนุมัติ PR ไม่ควรมีสิทธิ์ตัดยอด PO อัตโนมัติ —
// แยก duty ระหว่าง "อนุมัติของบขอซื้อ" กับ "ดำเนินการจัดซื้อจริง")
function hasPrItemActionPermission(customer) {
  return customer.role === 'super_user' || customer.can_manage_po === true;
}

// ---------------- ผู้รับเหมาช่วง (client_subcontractors) — หัวข้อ 2, master data เท่านั้น ----------------
// ไม่มี flag ใหม่แยกเฉพาะ — ใช้ can_manage_po ร่วม (เดิมมีไว้สำหรับ consume/release/cancel-qty ของ PR)
// เพราะจัดหาผู้รับเหมาช่วงเป็นงานฝั่งจัดซื้อ/จัดหาแบบเดียวกัน และตารางนี้เป็นแค่ข้อมูลติดต่อ/ธนาคาร ไม่มี
// เพดานวงเงินหรือผลต่อการอนุมัติใดๆ เลย (ต่างจาก fund_limit ที่ CLAUDE.md ข้อ 14 เตือนไว้ — ที่นี่ไม่มี
// ช่องโหว่ self-approval แบบเดียวกันให้ต้องแยก flag ใหม่) ถ้าวันหน้ามีสิทธิ์อนุมัติงวดงาน/เพดานสัญญา
// (client_subcontract_terms/billings) ต้องแยก flag ใหม่ต่างหากแน่นอน — เตือนไว้ล่วงหน้าตรงนี้
function hasSubcontractorManagePermission(customer) {
  return customer.role === 'super_user' || customer.can_manage_po === true;
}

// includeBank=false ซ่อนข้อมูลบัญชีธนาคารออกจาก response ทั้งหมด (ไม่ใช่แค่ mask บางส่วน) — คนที่ดู
// รายชื่อผู้รับเหมาช่วงทั่วไปได้ (ทุกคนที่ login แล้ว) ไม่ควรเห็นเลขบัญชีธนาคาร มีแต่คนที่มีสิทธิ์จัดการ
// จริง (hasSubcontractorManagePermission) เท่านั้นที่ควรเห็น — เหตุผล: ถ้าใครก็ตามในบริษัทเห็นเลขบัญชีได้
// หมด แล้ว social-engineer ให้เปลี่ยนเลขบัญชีสำเร็จ (หรือแค่จำเลขบัญชีเดิมแล้วเอาไปใช้ผิดที่ทางอื่น)
// ความเสี่ยงจะสูงกว่าจำกัดวงคนเห็นไว้แค่คนที่มีสิทธิ์แก้ไขข้อมูลนี้อยู่แล้วเท่านั้น
function serializeSubcontractor(row, includeBank) {
  return {
    id: row.id,
    name: row.name,
    taxId: row.tax_id,
    branchCode: row.branch_code,
    address: row.address,
    taxpayerType: row.taxpayer_type,
    phone: row.phone,
    contactPerson: row.contact_person,
    email: row.email,
    bankName: includeBank ? row.bank_name : null,
    bankAccountNo: includeBank ? row.bank_account_no : null,
    bankAccountName: includeBank ? row.bank_account_name : null,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

// ทั้ง POST/PUT ใช้ validate ร่วมชุดเดียวกัน — ผ่านการเช็ค constraint ระดับ DB ทั้งหมด (unique tax_id,
// unique normalized name, juristic ต้องมี tax_id) ไว้แล้วที่ migration 0009 แต่ยังเช็คซ้ำที่ชั้น
// application ก่อนเพื่อคืนข้อความ error ที่อ่านเข้าใจง่ายกว่า unique violation ดิบๆ จาก Postgres (ตาม
// pattern เดิมของทั้งไฟล์) — ถ้าหลุดผ่านมาถึง DB จริงแล้วชน constraint (เช่น race ระหว่างสอง request
// พร้อมกัน) catch error code 23505 คืน 409 แทน 500 ด้านล่าง
function validateSubcontractorInput({ name, taxId, branchCode, address, taxpayerType, phone, contactPerson, email, bankName, bankAccountNo, bankAccountName }) {
  const safeName = String(name || '').trim();
  if (!safeName) return { error: 'กรุณาระบุชื่อผู้รับเหมาช่วง' };
  const safeTaxpayerType = ['individual', 'juristic'].includes(taxpayerType) ? taxpayerType : 'juristic';
  const safeTaxId = taxId ? String(taxId).trim() : null;
  if (safeTaxId && !/^\d{13}$/.test(safeTaxId)) return { error: 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' };
  if (safeTaxpayerType === 'juristic' && !safeTaxId) {
    return { error: 'ผู้รับเหมาช่วงประเภทนิติบุคคลต้องระบุเลขผู้เสียภาษี (ใช้ออกหนังสือรับรองหัก ณ ที่จ่ายตอนจ่ายเงินจริง)' };
  }
  return {
    safeName,
    safeTaxId,
    safeBranchCode: String(branchCode || '00000').trim() || '00000',
    safeAddress: String(address || '').trim(),
    safeTaxpayerType,
    safePhone: String(phone || '').trim(),
    safeContactPerson: String(contactPerson || '').trim(),
    safeEmail: String(email || '').trim(),
    safeBankName: String(bankName || '').trim(),
    safeBankAccountNo: String(bankAccountNo || '').trim(),
    safeBankAccountName: String(bankAccountName || '').trim(),
  };
}

app.get('/api/customer/subcontractors', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const canManage = hasSubcontractorManagePermission(req.customer);
  const r = await pool.query('SELECT * FROM client_subcontractors WHERE company_id=$1 ORDER BY name', [companyId]);
  res.json({ subcontractors: r.rows.map(row => serializeSubcontractor(row, canManage)) });
});

app.post('/api/customer/subcontractors', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการผู้รับเหมาช่วง' });
  const companyId = req.customer.company_id;
  const v = validateSubcontractorInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO client_subcontractors
         (company_id, name, tax_id, branch_code, address, taxpayer_type, phone, contact_person, email, bank_name, bank_account_no, bank_account_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, v.safeName, v.safeTaxId, v.safeBranchCode, v.safeAddress, v.safeTaxpayerType, v.safePhone,
       v.safeContactPerson, v.safeEmail, v.safeBankName, v.safeBankAccountNo, v.safeBankAccountName]
    );
    const row = insert.rows[0];
    // doc_type='subcontractor' (คนละค่ากับ 'subcontractor_payment' ที่เตรียมไว้สำหรับเอกสารเบิกจ่าย/
    // งวดงานในอนาคต — ข้อมูล master นี้เป็นคนละประเภทเหตุการณ์กัน ไม่ควรปนกันในรายงาน audit)
    await writeAuditLog(client, {
      companyId, docType: 'subcontractor', docId: row.id, action: 'create', performedBy: req.customer.id,
      reason: `เพิ่มผู้รับเหมาช่วงใหม่ "${row.name}"${row.bank_account_no ? ` (บัญชี ${row.bank_name} ${row.bank_account_no})` : ''}`,
    });
    await client.query('COMMIT');
    res.json({ subcontractor: serializeSubcontractor(row, true) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const isDupTaxId = err.constraint === 'uq_client_subcontractors_taxid';
      return res.status(409).json({ error: isDupTaxId ? 'มีผู้รับเหมาช่วงที่ใช้เลขผู้เสียภาษีนี้อยู่แล้ว' : 'มีผู้รับเหมาช่วงชื่อนี้อยู่แล้ว (เทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่และคำนำหน้านิติบุคคล)' });
    }
    throw err;
  } finally {
    client.release();
  }
});

// ⚠️ full-replace เสมอ ไม่ใช่ partial patch — client ต้องส่งครบทุกฟิลด์ทุกครั้ง (รวมข้อมูลธนาคารเดิมถ้า
// ไม่ได้ตั้งใจแก้) ไม่งั้นฟิลด์ที่ไม่ได้ส่งมาจะถูกเคลียร์เป็นค่าว่างเงียบๆ — ฟอร์มแก้ไขฝั่ง UI (pr-system.html
// open-edit-subcontractor) โหลดค่าปัจจุบันมาเต็มก่อนเสมอจึงปลอดภัยในทางปฏิบัติ แต่ผู้เรียก endpoint นี้
// ตรงๆ (เช่นเทส) ต้องรู้พฤติกรรมนี้ไว้ (พบจริงจากการเขียนเทส deactivate ที่ส่ง body ไม่ครบแล้วข้อมูล
// ธนาคารหายไปโดยไม่ตั้งใจ)
app.put('/api/customer/subcontractors/:id', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการผู้รับเหมาช่วง' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM client_subcontractors WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (existing.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบผู้รับเหมาช่วงนี้' }); }
    const old = existing.rows[0];
    const v = validateSubcontractorInput(req.body || {});
    if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    const isActive = req.body && typeof req.body.isActive === 'boolean' ? req.body.isActive : true;

    // ทำตาม TODO ที่เขียนไว้ล่วงหน้าตอนสร้าง client_subcontractors (หัวข้อ 2) — ตอนนี้ client_subcontract_terms
    // มีจริงแล้ว (migration 0012, หัวข้อ 5 รอบ B) ต้องกันปิดใช้งานผู้รับเหมาที่ยังมีสัญญาค้างอยู่ ใช้ pattern
    // NOT IN กับสถานะ "จบแล้ว" (CLAUDE.md ข้อ 23 — ปลอดภัยต่อสถานะใหม่ในอนาคตมากกว่า IN กับสถานะ active)
    // เอกสารนับว่า "จบแล้ว" เมื่อ status IN ('rejected','cancelled') (ไม่เคยกลายเป็นสัญญาจริง) หรือ
    // contract_status IN ('completed','terminated') (เป็นสัญญาจริงแต่จบงานหรือเลิกสัญญาไปแล้ว) — ที่เหลือ
    // (draft/submitted/approved ที่ contract_status='active') ถือว่ายังค้างอยู่ ปิดใช้งานไม่ได้
    if (old.is_active === true && isActive === false) {
      const activeTermsCheck = await client.query(
        `SELECT COUNT(*)::int AS n FROM client_subcontract_terms
         WHERE company_id=$1 AND subcontractor_id=$2
           AND status NOT IN ('rejected','cancelled')
           AND (contract_status IS NULL OR contract_status NOT IN ('completed','terminated'))`,
        [companyId, id]
      );
      if (activeTermsCheck.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `ปิดใช้งานไม่ได้ — ผู้รับเหมาช่วงนี้ยังมีสัญญา/หนังสือสั่งจ้างที่ยังไม่จบ ${activeTermsCheck.rows[0].n} ฉบับ (ยังไม่ถูกปฏิเสธ/ยกเลิก/จบงาน/เลิกสัญญา)` });
      }
    }

    const update = await client.query(
      `UPDATE client_subcontractors SET
         name=$1, tax_id=$2, branch_code=$3, address=$4, taxpayer_type=$5, phone=$6,
         contact_person=$7, email=$8, bank_name=$9, bank_account_no=$10, bank_account_name=$11, is_active=$12
       WHERE id=$13 RETURNING *`,
      [v.safeName, v.safeTaxId, v.safeBranchCode, v.safeAddress, v.safeTaxpayerType, v.safePhone,
       v.safeContactPerson, v.safeEmail, v.safeBankName, v.safeBankAccountNo, v.safeBankAccountName, isActive, id]
    );
    const row = update.rows[0];

    // บันทึกทุกฟิลด์ที่เปลี่ยนจริงแบบ "ค่าเก่า → ค่าใหม่" ชัดเจน (ไม่ใช่แค่ "แก้ไขข้อมูล" เฉยๆ) — เน้น
    // ข้อมูลธนาคารเป็นพิเศษด้วย ⚠️ เพราะถ้าแก้แล้วไม่มีใครสังเกต เงินงวดถัดไปจะโอนผิดบัญชีจริง (พบจากคำเตือน
    // ของผู้ใช้ตรงๆ ไม่ใช่แค่ทฤษฎี)
    const changes = [];
    if (old.name !== v.safeName) changes.push(`ชื่อ: "${old.name}" → "${v.safeName}"`);
    if ((old.tax_id || '') !== (v.safeTaxId || '')) changes.push(`เลขผู้เสียภาษี: "${old.tax_id || '-'}" → "${v.safeTaxId || '-'}"`);
    if (old.taxpayer_type !== v.safeTaxpayerType) changes.push(`ประเภท: "${old.taxpayer_type}" → "${v.safeTaxpayerType}"`);
    if (old.phone !== v.safePhone) changes.push(`โทรศัพท์: "${old.phone || '-'}" → "${v.safePhone || '-'}"`);
    if (old.contact_person !== v.safeContactPerson) changes.push(`ผู้ติดต่อ: "${old.contact_person || '-'}" → "${v.safeContactPerson || '-'}"`);
    if (old.email !== v.safeEmail) changes.push(`อีเมล: "${old.email || '-'}" → "${v.safeEmail || '-'}"`);
    if (old.bank_name !== v.safeBankName || old.bank_account_no !== v.safeBankAccountNo || old.bank_account_name !== v.safeBankAccountName) {
      changes.push(`⚠️ ข้อมูลธนาคาร: "${old.bank_name || '-'} / ${old.bank_account_no || '-'} / ${old.bank_account_name || '-'}" → "${v.safeBankName || '-'} / ${v.safeBankAccountNo || '-'} / ${v.safeBankAccountName || '-'}"`);
    }
    if (old.is_active !== isActive) changes.push(`สถานะ: ${old.is_active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'} → ${isActive ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}`);

    if (changes.length > 0) {
      await writeAuditLog(client, {
        companyId, docType: 'subcontractor', docId: id, action: 'edit', performedBy: req.customer.id,
        fromStatus: old.is_active !== isActive ? String(old.is_active) : null,
        toStatus: old.is_active !== isActive ? String(isActive) : null,
        reason: changes.join('; '),
      });
    }
    await client.query('COMMIT');
    res.json({ subcontractor: serializeSubcontractor(row, true) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const isDupTaxId = err.constraint === 'uq_client_subcontractors_taxid';
      return res.status(409).json({ error: isDupTaxId ? 'มีผู้รับเหมาช่วงที่ใช้เลขผู้เสียภาษีนี้อยู่แล้ว' : 'มีผู้รับเหมาช่วงชื่อนี้อยู่แล้ว (เทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่และคำนำหน้านิติบุคคล)' });
    }
    throw err;
  } finally {
    client.release();
  }
});

// ---------------- ใบสั่งจ้างผู้รับเหมาช่วง (Work Order / client_subcontract_terms, หัวข้อ 5 รอบ B) ----------------
// เอกสารเดียวกับที่ร่างไว้ตอนวางแผนหัวข้อ 2 (ตอนนั้นชื่อ client_subcontract_terms เตรียมไว้ล่วงหน้า) ดึงมา
// รวมกับหัวข้อ 5 ตามที่ตกลงกันไว้ — ไม่มีตาราง items ย่อยเหมือน PO (เป็นสัญญาก้อนเดียว ไม่ใช่รายการวัสดุ)
// สิทธิ์จัดการ (create/edit) ใช้ can_manage_po ร่วมกับ PO/subcontractor master (เหตุผลเดียวกับที่เขียนไว้ที่
// hasSubcontractorManagePermission ด้านบน) ส่วนสิทธิ์อนุมัติใช้ doc_type='po_wo' ร่วมกับ PO (เพดานวงเงินเดียวกัน
// ตามที่ตกลงตอนวางแผน migration 0012/0013) — ไม่โพสต์ journal เอง (เป็นแค่สัญญาผูกพัน ยังไม่ใช่ค่าใช้จ่ายจริง
// จนกว่าจะมีการเบิกงวดงาน/จ่ายเงินจริงในหัวข้อถัดไป ซึ่งเป็นคนละ flow แยกต่างหาก)
function serializeSubcontractTerm(row) {
  return {
    id: row.id,
    contractNo: row.contract_no,
    subcontractorId: row.subcontractor_id,
    subcontractorName: row.subcontractor_name,
    subcontractorTaxId: row.subcontractor_tax_id,
    projectId: row.project_id,
    projectName: row.project_name,
    contractValue: Number(row.contract_value),
    advancePercent: Number(row.advance_percent),
    retentionPercent: Number(row.retention_percent),
    advanceAmount: Number(row.advance_amount),
    retentionAmount: Number(row.retention_amount),
    whtIncomeTypeCode: row.wht_income_type_code,
    whtIncomeTypeName: row.wht_income_type_name,
    whtRate: row.wht_rate === null ? null : Number(row.wht_rate),
    whtDefaultRate: row.wht_default_rate === null ? null : Number(row.wht_default_rate),
    status: row.status,
    contractStatus: row.contract_status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    startDate: row.start_date,
    endDate: row.end_date,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
// advance_amount/retention_amount คำนวณฝั่ง SQL ด้วย numeric arithmetic เสมอ (ไม่ใช้ JS Number คำนวณ) ตาม
// CLAUDE.md ข้อ 3 — แสดงผลอย่างเดียวในเฟสนี้ ยังไม่ post journal หรือใช้ตัดสินใจอะไรเลย
const CLIENT_WO_SELECT = `
  SELECT wo.id, wo.contract_no, wo.subcontractor_id, sc.name AS subcontractor_name, sc.tax_id AS subcontractor_tax_id,
    wo.project_id, cp.name AS project_name,
    wo.contract_value, wo.advance_percent, wo.retention_percent,
    ROUND(wo.contract_value * wo.advance_percent / 100, 2) AS advance_amount,
    ROUND(wo.contract_value * wo.retention_percent / 100, 2) AS retention_amount,
    wo.wht_income_type_code, wit.name_th AS wht_income_type_name, wo.wht_rate, wit.default_rate AS wht_default_rate,
    wo.status, wo.contract_status,
    wo.submitted_by, wo.submitted_at, wo.approved_by, wo.approved_at, wo.rejected_reason,
    to_char(wo.start_date,'YYYY-MM-DD') AS start_date, to_char(wo.end_date,'YYYY-MM-DD') AS end_date,
    wo.note, wo.created_by, wo.created_at
  FROM client_subcontract_terms wo
  JOIN client_subcontractors sc ON sc.id = wo.subcontractor_id
  JOIN client_projects cp ON cp.id = wo.project_id
  LEFT JOIN client_wht_income_types wit ON wit.code = wo.wht_income_type_code`;

async function generateClientWoNumber(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'subcontract_term');
    const no = `WO-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_subcontract_terms WHERE company_id=$1 AND contract_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่สัญญา/หนังสือสั่งจ้างได้');
}

// ทั้ง POST/PUT ใช้ร่วมกัน — whtRate เป็น optional เสมอ (ไม่ส่งมา = NULL = ใช้ default_rate จาก master ตอน
// แสดงผล) ห้าม fallback เป็น 0 เด็ดขาดตาม CLAUDE.md ข้อ 17 (โดยเฉพาะ 40(1) ที่ default_rate เป็น NULL เอง)
async function validateWoInput(dbClient = pool, companyId, { subcontractorId, projectId, contractValue, advancePercent, retentionPercent, whtIncomeTypeCode, whtRate, startDate, endDate }) {
  if (!subcontractorId) return { error: 'กรุณาเลือกผู้รับเหมาช่วง' };
  const sc = await dbClient.query('SELECT 1 FROM client_subcontractors WHERE id=$1 AND company_id=$2 AND is_active=true', [subcontractorId, companyId]);
  if (sc.rowCount === 0) return { error: 'ไม่พบผู้รับเหมาช่วงนี้ หรือถูกปิดใช้งานแล้ว' };

  if (!projectId) return { error: 'กรุณาเลือกโครงการ' };
  const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
  if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };

  const safeContractValue = parsePositiveNumericValue(contractValue);
  if (safeContractValue === null) return { error: 'กรุณาระบุมูลค่าสัญญาให้ถูกต้อง (ต้องมากกว่า 0)' };

  const safeAdvancePercent = parseNonNegativeNumericValue(advancePercent ?? 0);
  if (safeAdvancePercent === null || Number(safeAdvancePercent) > 100) return { error: 'ระบุเปอร์เซ็นต์เงินล่วงหน้าไม่ถูกต้อง (0-100)' };

  const safeRetentionPercent = parseNonNegativeNumericValue(retentionPercent ?? 5);
  if (safeRetentionPercent === null || Number(safeRetentionPercent) > 100) return { error: 'ระบุเปอร์เซ็นต์เงินประกันผลงานไม่ถูกต้อง (0-100)' };

  const safeWhtIncomeTypeCode = whtIncomeTypeCode ? String(whtIncomeTypeCode).trim() : '40_7';
  const witCheck = await dbClient.query('SELECT 1 FROM client_wht_income_types WHERE code=$1 AND is_active=true', [safeWhtIncomeTypeCode]);
  if (witCheck.rowCount === 0) return { error: 'ระบุประเภทเงินได้ตามมาตรา 40 ไม่ถูกต้อง หรือถูกปิดใช้งานแล้ว' };

  let safeWhtRate = null;
  if (whtRate !== undefined && whtRate !== null && whtRate !== '') {
    safeWhtRate = parseNonNegativeNumericValue(whtRate);
    if (safeWhtRate === null || Number(safeWhtRate) > 100) return { error: 'ระบุอัตราหัก ณ ที่จ่ายไม่ถูกต้อง (0-100)' };
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const safeStartDate = startDate && dateRe.test(startDate) ? startDate : null;
  const safeEndDate = endDate && dateRe.test(endDate) ? endDate : null;
  if (startDate && !safeStartDate) return { error: 'รูปแบบวันที่เริ่มสัญญาไม่ถูกต้อง' };
  if (endDate && !safeEndDate) return { error: 'รูปแบบวันที่สิ้นสุดสัญญาไม่ถูกต้อง' };
  // เทียบแบบ string ตรงๆ (รูปแบบ YYYY-MM-DD เรียงตามตัวอักษร = เรียงตามเวลาจริงพอดี) ไม่ใช้ JS Date เลย
  // กันปัญหา timezone แบบเดียวกับ CLAUDE.md ข้อ 22
  if (safeStartDate && safeEndDate && safeEndDate < safeStartDate) return { error: 'วันที่สิ้นสุดสัญญาต้องไม่ก่อนวันที่เริ่มสัญญา' };

  return {
    safeSubcontractorId: subcontractorId, safeProjectId: projectId, safeContractValue, safeAdvancePercent, safeRetentionPercent,
    safeWhtIncomeTypeCode, safeWhtRate, safeStartDate, safeEndDate,
  };
}

app.get('/api/customer/subcontract-terms', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, projectId, subcontractorId } = req.query;
  const conditions = ['wo.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`wo.status=$${params.length}`); }
  if (projectId) { params.push(parseInt(projectId, 10)); conditions.push(`wo.project_id=$${params.length}`); }
  if (subcontractorId) { params.push(parseInt(subcontractorId, 10)); conditions.push(`wo.subcontractor_id=$${params.length}`); }
  const r = await pool.query(`${CLIENT_WO_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY wo.id DESC`, params);
  res.json({ subcontractTerms: r.rows.map(serializeSubcontractTerm) });
});

app.get('/api/customer/subcontract-terms/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const r = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' });
  res.json({ subcontractTerm: serializeSubcontractTerm(r.rows[0]) });
});

app.post('/api/customer/subcontract-terms', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์สร้างสัญญา/หนังสือสั่งจ้าง' });
  await withIdempotency(req, res, 'subcontract-terms-create', async (client) => {
    const companyId = req.customer.company_id;
    const { subcontractorId, projectId, contractValue, advancePercent, retentionPercent, whtIncomeTypeCode, whtRate, startDate, endDate, note } = req.body || {};
    const v = await validateWoInput(client, companyId, { subcontractorId, projectId, contractValue, advancePercent, retentionPercent, whtIncomeTypeCode, whtRate, startDate, endDate });
    if (v.error) return { status: 400, body: { error: v.error } };

    const insert = await client.query(
      `INSERT INTO client_subcontract_terms
         (company_id, subcontractor_id, project_id, contract_value, advance_percent, retention_percent, wht_income_type_code, wht_rate, start_date, end_date, note, created_by)
       VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,$8::numeric,$9,$10,$11,$12) RETURNING id`,
      [companyId, v.safeSubcontractorId, v.safeProjectId, v.safeContractValue, v.safeAdvancePercent, v.safeRetentionPercent,
       v.safeWhtIncomeTypeCode, v.safeWhtRate, v.safeStartDate, v.safeEndDate, (note || '').trim(), req.customer.id]
    );
    const woId = insert.rows[0].id;
    const r = await client.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [woId, companyId]);
    return { status: 200, body: { subcontractTerm: serializeSubcontractTerm(r.rows[0]) } };
  });
});

// แก้ไขได้เฉพาะ draft เท่านั้น (ไม่มี items ย่อยให้ delete+reinsert เหมือน PO — UPDATE ตรงๆ ทั้งแถว)
app.put('/api/customer/subcontract-terms/:id', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขสัญญา/หนังสือสั่งจ้าง' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { subcontractorId, projectId, contractValue, advancePercent, retentionPercent, whtIncomeTypeCode, whtRate, startDate, endDate, note } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const woRes = await client.query('SELECT status FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (woRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' }); }
    if (woRes.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'แก้ไขได้เฉพาะสถานะร่างเท่านั้น' });
    }
    const v = await validateWoInput(client, companyId, { subcontractorId, projectId, contractValue, advancePercent, retentionPercent, whtIncomeTypeCode, whtRate, startDate, endDate });
    if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }

    await client.query(
      `UPDATE client_subcontract_terms SET
         subcontractor_id=$1, project_id=$2, contract_value=$3::numeric, advance_percent=$4::numeric, retention_percent=$5::numeric,
         wht_income_type_code=$6, wht_rate=$7::numeric, start_date=$8, end_date=$9, note=$10
       WHERE id=$11`,
      [v.safeSubcontractorId, v.safeProjectId, v.safeContractValue, v.safeAdvancePercent, v.safeRetentionPercent,
       v.safeWhtIncomeTypeCode, v.safeWhtRate, v.safeStartDate, v.safeEndDate, (note || '').trim(), id]
    );
    await client.query('COMMIT');
    const r = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    res.json({ subcontractTerm: serializeSubcontractTerm(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขสัญญา/หนังสือสั่งจ้างไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/subcontract-terms/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `subcontract-terms-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' } };
    const wo = r.rows[0];
    if (wo.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะสถานะร่างเท่านั้น' } };

    if (req.customer.id !== wo.created_by) {
      const permCheck = await canApprove(client, req.customer, 'po_wo', wo.contract_value, {
        companyId, originators: [wo.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นสัญญานี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    const contractNo = await generateClientWoNumber(client, companyId);
    await client.query(
      `UPDATE client_subcontract_terms SET contract_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [contractNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });
    const full = await client.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    return { status: 200, body: { subcontractTerm: serializeSubcontractTerm(full.rows[0]) } };
  });
});

app.post('/api/customer/subcontract-terms/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `subcontract-terms-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' } };
    const wo = r.rows[0];
    if (wo.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะที่ยื่นแล้วเท่านั้น' } };

    const result = await canApprove(client, req.customer, 'po_wo', wo.contract_value, {
      companyId, originators: [wo.created_by, wo.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    // อนุมัติแล้ว = สัญญาเริ่มมีผลจริงทันที (contract_status='active') — ตรงกับ CHECK
    // client_subcontract_terms_status_pair_check (status='approved' ต้องคู่กับ contract_status ที่ไม่ใช่ NULL)
    await client.query(
      `UPDATE client_subcontract_terms SET status='approved', contract_status='active', approved_by=$1, approved_at=now() WHERE id=$2`,
      [req.customer.id, id]
    );
    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason,
    });
    const full = await client.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    return { status: 200, body: { subcontractTerm: serializeSubcontractTerm(full.rows[0]) } };
  });
});

app.post('/api/customer/subcontract-terms/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' }); }
    const wo = r.rows[0];
    if (wo.status !== 'submitted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะที่ยื่นแล้วเท่านั้น' }); }

    const permCheck = await canApprove(client, req.customer, 'po_wo', wo.contract_value, {
      companyId, originators: [wo.created_by, wo.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: permCheck.message, code: permCheck.code }); }

    await client.query(`UPDATE client_subcontract_terms SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    const full = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    res.json({ subcontractTerm: serializeSubcontractTerm(full.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธสัญญา/หนังสือสั่งจ้างไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้เฉพาะก่อนอนุมัติเท่านั้น (draft/submitted) — ต่างจาก PO ที่ยกเลิกได้แม้ approved แล้ว เพราะสัญญาที่
// อนุมัติแล้วถือเป็นสัญญาจริงที่มีผลผูกพันทางกฎหมาย ต้องใช้ "เลิกสัญญา" (terminate, ดู endpoint ด้านล่าง) แทน
// ไม่ใช่ "ยกเลิก" เอกสารเฉยๆ — สอง action นี้มีความหมายทางธุรกิจต่างกันชัดเจน แยก endpoint ให้ตรงความหมาย
app.post('/api/customer/subcontract-terms/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' }); }
    const wo = r.rows[0];
    const status = wo.status;
    if (!['draft', 'submitted'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ยกเลิกได้เฉพาะสถานะร่างหรือยื่นแล้วเท่านั้น (สัญญาที่อนุมัติแล้วต้องใช้ "เลิกสัญญา" แทน)' });
    }

    const isOwner = req.customer.id === wo.created_by || (wo.submitted_by != null && req.customer.id === wo.submitted_by);
    if (!isOwner) {
      const permCheck = await canApprove(client, req.customer, 'po_wo', wo.contract_value, {
        companyId, originators: [wo.created_by, wo.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกสัญญานี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
    }

    await client.query(`UPDATE client_subcontract_terms SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'cancel',
      fromStatus: status, toStatus: 'cancelled', performedBy: req.customer.id,
    });
    await client.query('COMMIT');
    const full = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    res.json({ subcontractTerm: serializeSubcontractTerm(full.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกสัญญา/หนังสือสั่งจ้างไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ปิดงาน/เลิกสัญญา — action ระดับ "จัดการสัญญา" ไม่ใช่ "อนุมัติธุรกรรม" จึงใช้ can_manage_po (สิทธิ์เดียวกับที่
// จัดการ master data ผู้รับเหมาช่วง/PO) ไม่ใช่ can_approve_po_wo ตาม CLAUDE.md ข้อ 14 (แยกสิทธิ์ตั้งค่า/จัดการ
// ออกจากสิทธิ์อนุมัติธุรกรรมเสมอ) — งานฝ่ายจัดซื้อ/ไซต์งานที่ปิดงานสัญญาไม่จำเป็นต้องมีสิทธิ์อนุมัติวงเงินเลย
app.post('/api/customer/subcontract-terms/:id/complete', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ปิดงานสัญญานี้' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' }); }
    const wo = r.rows[0];
    if (wo.status !== 'approved' || wo.contract_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ปิดงานได้เฉพาะสัญญาที่อนุมัติแล้วและยังดำเนินอยู่ (active) เท่านั้น' });
    }
    await client.query(`UPDATE client_subcontract_terms SET contract_status='completed' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'complete',
      fromStatus: 'active', toStatus: 'completed', performedBy: req.customer.id,
    });
    await client.query('COMMIT');
    const full = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    res.json({ subcontractTerm: serializeSubcontractTerm(full.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปิดงานสัญญาไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/subcontract-terms/:id/terminate', requireCustomerAuth, async (req, res) => {
  if (!hasSubcontractorManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์เลิกสัญญานี้' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการเลิกสัญญา' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_subcontract_terms WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสัญญา/หนังสือสั่งจ้างนี้' }); }
    const wo = r.rows[0];
    if (wo.status !== 'approved' || wo.contract_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'เลิกสัญญาได้เฉพาะสัญญาที่อนุมัติแล้วและยังดำเนินอยู่ (active) เท่านั้น' });
    }
    await client.query(`UPDATE client_subcontract_terms SET contract_status='terminated' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'subcontract_term', docId: id, action: 'terminate',
      fromStatus: 'active', toStatus: 'terminated', performedBy: req.customer.id, reason: reason.trim(),
    });
    await client.query('COMMIT');
    const full = await pool.query(`${CLIENT_WO_SELECT} WHERE wo.id=$1 AND wo.company_id=$2`, [id, companyId]);
    res.json({ subcontractTerm: serializeSubcontractTerm(full.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'เลิกสัญญาไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/purchase-requests/:id/items/:itemId/consume', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const companyId = req.customer.company_id;
  const { qty, poId, note } = req.body || {};
  if (!hasPrItemActionPermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ตัดยอดรายการขอซื้อ' });
  const safeQty = parsePositiveNumericValue(qty);
  if (safeQty === null) return res.status(400).json({ error: 'กรุณาระบุจำนวนที่ต้องการตัดยอดให้ถูกต้อง' });
  if (!poId) return res.status(400).json({ error: 'การตัดยอดต้องระบุใบสั่งซื้อ (PO) อ้างอิง' });

  await withIdempotency(req, res, `purchase-requests-item-consume:${id}:${itemId}`, async (client) => {
    // ลำดับล็อก: PR/header ก่อนเสมอ แล้วค่อย item (กฎกลางของทั้งไฟล์ — ดู CLAUDE.md) ต้องตรงกับลำดับที่
    // PUT /purchase-requests/:id ใช้ (ล็อก PR ก่อนแล้วค่อย item เหมือนกัน) มิเช่นนั้นสอง endpoint ที่ล็อก
    // สองแถวเดียวกันคนละลำดับจะเกิด deadlock ได้จริง (แม้ทั้งสองจะทำงานกับ PR คนละสถานะกัน — PUT ทำเฉพาะ
    // draft, consume ทำเฉพาะ approved — ก็ตาม เพราะการล็อกเกิดขึ้นก่อนเช็คสถานะเสมอ Postgres ไม่รู้ล่วงหน้า
    // ว่าสองทรานแซกชันนี้ "ไม่มีทางชนกันจริง" มันเห็นแค่ลำดับการขอล็อกที่สวนทางกัน)
    const prRes = await client.query('SELECT status FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (prRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอซื้อ' } };
    if (prRes.rows[0].status !== 'approved') {
      return { status: 409, body: { error: 'ตัดยอดได้เฉพาะใบขอซื้อที่อนุมัติแล้วเท่านั้น' } };
    }

    // เทียบ qty_remaining >= safeQty เป็น boolean ที่ฝั่ง SQL ด้วย ::numeric เสมอ (เหมือนที่แก้ใน
    // canApprove) — ห้ามแปลง qty_remaining เป็น JS Number ก่อนเทียบ เพราะ pg คืน NUMERIC เป็น string
    const itemRes = await client.query(
      `SELECT id, qty_remaining, (qty_remaining >= $4::numeric) AS has_enough
       FROM client_purchase_request_items
       WHERE id=$1 AND purchase_request_id=$2 AND company_id=$3 FOR UPDATE`,
      [itemId, id, companyId, safeQty]
    );
    if (itemRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบรายการนี้ในใบขอซื้อ' } };

    const poRes = await client.query('SELECT status FROM client_purchase_orders WHERE id=$1 AND company_id=$2', [poId, companyId]);
    if (poRes.rowCount === 0) return { status: 400, body: { error: 'ไม่พบใบสั่งซื้อนี้ในบริษัทของคุณ' } };
    if (poRes.rows[0].status === 'cancelled') {
      return { status: 400, body: { error: 'ไม่สามารถตัดยอดกับใบสั่งซื้อที่ถูกยกเลิกแล้ว' } };
    }

    if (!itemRes.rows[0].has_enough) {
      return { status: 400, body: { error: `จำนวนที่ตัดยอด (${safeQty}) เกินยอดคงเหลือ (${itemRes.rows[0].qty_remaining})` } };
    }

    await client.query(
      `INSERT INTO client_purchase_request_item_adjustments (pr_item_id, company_id, adjustment_type, qty, po_id, note, created_by)
       VALUES ($1,$2,'consume',$3,$4,$5,$6)`,
      [itemId, companyId, safeQty, poId, (note || '').trim(), req.customer.id]
    );
    // อัปเดตแบบสัมพัทธ์เท่านั้น (qty_ordered = qty_ordered + $) ตามกฎที่บันทึกไว้ในสคีมา — ห้ามอ่านค่ามา
    // คำนวณในโค้ดแอปแล้วเขียนค่าสัมบูรณ์กลับ (กัน lost-update ตอน concurrent consume สองคำขอพร้อมกัน)
    await client.query('UPDATE client_purchase_request_items SET qty_ordered = qty_ordered + $1 WHERE id=$2', [safeQty, itemId]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'consume',
      performedBy: req.customer.id, reason: `ตัดยอด ${safeQty} หน่วย รายการ id=${itemId} อ้างอิง PO #${poId}`,
    });

    const purchaseRequest = await fetchFullPurchaseRequest(client, id, companyId);
    return { status: 200, body: { purchaseRequest } };
  });
});

app.post('/api/customer/purchase-requests/:id/items/:itemId/release', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const companyId = req.customer.company_id;
  const { qty, poId, note } = req.body || {};
  if (!hasPrItemActionPermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์คืนยอดรายการขอซื้อ' });
  const safeQty = parsePositiveNumericValue(qty);
  if (safeQty === null) return res.status(400).json({ error: 'กรุณาระบุจำนวนที่ต้องการคืนยอดให้ถูกต้อง' });
  if (!poId) return res.status(400).json({ error: 'การคืนยอดต้องระบุใบสั่งซื้อ (PO) อ้างอิงเดียวกับตอนตัดยอด' });

  await withIdempotency(req, res, `purchase-requests-item-release:${id}:${itemId}`, async (client) => {
    // ลำดับล็อก: PR ก่อนเสมอ แล้วค่อย item (เหตุผลเดียวกับ consume ด้านบน — กันชนกับลำดับของ PUT)
    const prRes = await client.query('SELECT status FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (prRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอซื้อ' } };

    const itemRes = await client.query(
      'SELECT id FROM client_purchase_request_items WHERE id=$1 AND purchase_request_id=$2 AND company_id=$3 FOR UPDATE',
      [itemId, id, companyId]
    );
    if (itemRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบรายการนี้ในใบขอซื้อ' } };

    // กฎสำคัญ: SUM(release ของ po_id นี้) ต้องไม่เกิน SUM(consume ของ po_id เดียวกัน) — scope ด้วยทั้ง
    // pr_item_id (itemId) และ po_id เสมอ ไม่ใช่ po_id อย่างเดียว เพราะ PO ใบเดียวตัดยอดได้จากหลายรายการ
    // ใน PR เดียวกัน (คนละ pr_item_id) ถ้า scope แค่ po_id การ release ของรายการหนึ่งจะไปกินโควตา
    // consume ที่จริงๆ เป็นของอีกรายการที่ใช้ po_id เดียวกัน — ตรวจในทรานแซกชันเดียวกับที่จะ insert เสมอ
    // กัน "คืนยอดเกินกว่าที่เคยตัดไปจริง" ซึ่งจะทำให้ PR แสดง qty_remaining เหลือมากกว่าที่ควร แล้วเปิด PO
    // ใบใหม่ตัดยอดซ้ำเกินจำนวนที่ขอซื้อจริงได้ — ไม่เช็คสถานะ PO ที่นี่โดยเจตนา (ต่างจาก consume): PO ที่
    // เพิ่งถูกยกเลิกไปคือเหตุผลทั่วไปที่สุดที่จะต้อง release ยอดที่เคยตัดไปกลับคืน เพื่อให้ PR นำไปเปิด PO
    // ใบใหม่แทนได้ ถ้าบล็อก release ตอน PO cancelled จะทำให้ยอดที่ตัดไปค้างอยู่ถาวร แก้ไขอะไรไม่ได้อีกเลย
    // เทียบ availableToRelease >= safeQty เป็น boolean ที่ฝั่ง SQL ด้วย ::numeric เสมอ (เหตุผลเดียวกับ
    // consume ด้านบน — ห้ามแปลง SUM ที่ได้มาเป็น JS Number ก่อนเทียบ)
    const sums = await client.query(
      `SELECT
         COALESCE(SUM(qty) FILTER (WHERE adjustment_type='consume'), 0) AS consumed,
         COALESCE(SUM(qty) FILTER (WHERE adjustment_type='release'), 0) AS released,
         (COALESCE(SUM(qty) FILTER (WHERE adjustment_type='consume'), 0)
          - COALESCE(SUM(qty) FILTER (WHERE adjustment_type='release'), 0)) >= $4::numeric AS has_enough
       FROM client_purchase_request_item_adjustments
       WHERE pr_item_id=$1 AND company_id=$2 AND po_id=$3`,
      [itemId, companyId, poId, safeQty]
    );
    const availableToRelease = Number(sums.rows[0].consumed) - Number(sums.rows[0].released); // แสดงผลใน error message เท่านั้น ไม่ใช้ตัดสินใจ
    if (!sums.rows[0].has_enough) {
      return { status: 400, body: { error: `จำนวนที่คืนยอด (${safeQty}) เกินยอดที่เคยตัดไปจาก PO นี้ (คืนได้ไม่เกิน ${availableToRelease})` } };
    }

    await client.query(
      `INSERT INTO client_purchase_request_item_adjustments (pr_item_id, company_id, adjustment_type, qty, po_id, note, created_by)
       VALUES ($1,$2,'release',$3,$4,$5,$6)`,
      [itemId, companyId, safeQty, poId, (note || '').trim(), req.customer.id]
    );
    await client.query('UPDATE client_purchase_request_items SET qty_ordered = qty_ordered - $1 WHERE id=$2', [safeQty, itemId]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'release',
      performedBy: req.customer.id, reason: `คืนยอด ${safeQty} หน่วย รายการ id=${itemId} อ้างอิง PO #${poId}`,
    });

    const purchaseRequest = await fetchFullPurchaseRequest(client, id, companyId);
    return { status: 200, body: { purchaseRequest } };
  });
});

app.post('/api/customer/purchase-requests/:id/items/:itemId/cancel-qty', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const companyId = req.customer.company_id;
  const { qty, note } = req.body || {};
  if (!hasPrItemActionPermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ลดยอดรายการขอซื้อ' });
  const safeQty = parsePositiveNumericValue(qty);
  if (safeQty === null) return res.status(400).json({ error: 'กรุณาระบุจำนวนที่ต้องการลดยอดให้ถูกต้อง' });
  // cancel-qty ย้อนกลับไม่ได้ (ไม่มี uncancel — ดู server/docs/pr-module-known-limitations.md) จึงบังคับ
  // ให้ระบุเหตุผลเสมอ ต่างจาก consume/release ที่ note เป็น optional เพราะยังแก้ไข/undo กันเองได้ในตัว
  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุเหตุผลการลดยอด (การลดยอดนี้ย้อนกลับไม่ได้ กรุณาตรวจสอบก่อนยืนยัน)' });
  }

  await withIdempotency(req, res, `purchase-requests-item-cancel-qty:${id}:${itemId}`, async (client) => {
    // ลำดับล็อก: PR ก่อนเสมอ แล้วค่อย item (เหตุผลเดียวกับ consume ด้านบน — กันชนกับลำดับของ PUT) พร้อม
    // เทียบ qty_remaining >= safeQty เป็น boolean ที่ฝั่ง SQL ด้วย ::numeric เสมอ (เหตุผลเดียวกับ
    // consume/release ด้านบน)
    const prRes = await client.query('SELECT status FROM client_purchase_requests WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (prRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบขอซื้อ' } };
    if (prRes.rows[0].status !== 'approved') {
      return { status: 409, body: { error: 'ลดยอดได้เฉพาะใบขอซื้อที่อนุมัติแล้วเท่านั้น' } };
    }

    const itemRes = await client.query(
      `SELECT id, qty_remaining, (qty_remaining >= $4::numeric) AS has_enough
       FROM client_purchase_request_items
       WHERE id=$1 AND purchase_request_id=$2 AND company_id=$3 FOR UPDATE`,
      [itemId, id, companyId, safeQty]
    );
    if (itemRes.rowCount === 0) return { status: 404, body: { error: 'ไม่พบรายการนี้ในใบขอซื้อ' } };

    if (!itemRes.rows[0].has_enough) {
      return { status: 400, body: { error: `จำนวนที่ลดยอด (${safeQty}) เกินยอดคงเหลือ (${itemRes.rows[0].qty_remaining})` } };
    }

    await client.query(
      `INSERT INTO client_purchase_request_item_adjustments (pr_item_id, company_id, adjustment_type, qty, note, created_by)
       VALUES ($1,$2,'cancel',$3,$4,$5)`,
      [itemId, companyId, safeQty, (note || '').trim(), req.customer.id]
    );
    await client.query('UPDATE client_purchase_request_items SET qty_cancelled = qty_cancelled + $1 WHERE id=$2', [safeQty, itemId]);
    await writeAuditLog(client, {
      companyId, docType: 'purchase_request', docId: id, action: 'cancel-qty',
      performedBy: req.customer.id, reason: `ลดยอด ${safeQty} หน่วย รายการ id=${itemId}`,
    });

    const purchaseRequest = await fetchFullPurchaseRequest(client, id, companyId);
    return { status: 200, body: { purchaseRequest } };
  });
});

app.get('/api/customer/purchase-requests/:id/items/:itemId/adjustments', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const companyId = req.customer.company_id;
  const itemCheck = await pool.query(
    'SELECT 1 FROM client_purchase_request_items WHERE id=$1 AND purchase_request_id=$2 AND company_id=$3',
    [itemId, id, companyId]
  );
  if (itemCheck.rowCount === 0) return res.status(404).json({ error: 'ไม่พบรายการนี้ในใบขอซื้อ' });

  const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM client_purchase_request_item_adjustments WHERE pr_item_id=$1 AND company_id=$2',
    [itemId, companyId]
  );
  const r = await pool.query(
    `SELECT a.id, a.adjustment_type, a.qty, a.po_id, po.po_no, a.note, a.created_by, a.created_at
     FROM client_purchase_request_item_adjustments a
     LEFT JOIN client_purchase_orders po ON po.id = a.po_id
     WHERE a.pr_item_id=$1 AND a.company_id=$2 ORDER BY a.id
     LIMIT $3 OFFSET $4`,
    [itemId, companyId, pageSize, offset]
  );
  res.json({
    adjustments: r.rows.map(row => ({
      id: row.id, adjustmentType: row.adjustment_type, qty: Number(row.qty), poId: row.po_id, poNo: row.po_no || null,
      note: row.note, createdBy: row.created_by, createdAt: row.created_at,
    })),
    total: countRes.rows[0].n,
    limit: pageSize,
    offset,
  });
});

// ---------------- Customer: client ledger — เงินสดย่อย (ข้อ 1.1) ----------------
// เฟสนี้ทำเฉพาะ voucher_type='petty_cash' บนตาราง client_payment_vouchers (ตารางรองรับ 'advance'/
// 'other' ด้วยแล้วจากสคีมา แต่ route ยังปฏิเสธสองประเภทนั้นไปก่อน — จะเปิดตอนทำข้อ 1.2/1.4)

// รหัสบัญชีที่ผูกกับความหมายทางธุรกิจตายตัวของโมดูลนี้ (ไม่ใช่รหัสที่ผู้ใช้เลือกเอง เหมือน
// expense_account_code) — ทำเป็นค่าคงที่ตัวเดียว ไม่ฮาร์ดโค้ดสตริงซ้ำในโค้ดโพสต์บัญชีหลายจุด
const ACCOUNT_CODE_PETTY_CASH = '1110';
const ACCOUNT_CODE_CASH = '1100';
const ACCOUNT_CODE_ADVANCE_RECEIVABLE = '1150'; // ลูกหนี้เงินทดรองจ่าย (ข้อ 1.2) — ไม่ใช่ค่าใช้จ่าย จนกว่าจะเคลียร์ในข้อ 1.3

// วันที่ปัจจุบันตาม timezone Asia/Bangkok เสมอ (เหตุผลเดียวกับ getBangkokYear แต่คืนวันที่เต็ม ไม่ใช่
// แค่ปี) ใช้แทน new Date().toISOString().slice(0,10) (UTC) หรือ server-local time ตรงๆ ทุกจุดที่ต้องการ
// "วันนี้" ของโมดูลนี้ — en-CA locale ของ Intl.DateTimeFormat จัดรูปแบบ YYYY-MM-DD ให้ตรงๆ อยู่แล้ว
function getBangkokDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// can_manage_petty_cash_fund (migration 0007) OR super_user เสมอ — ห้ามใช้ can_approve_petty_cash แทน:
// เคยลองใช้ can_approve_petty_cash มาก่อนแล้วพบว่าเป็นช่องโหว่จริง คนที่มีสิทธิ์นั้นจะตั้ง fund_limit
// เองได้ด้วย แล้วขึ้นวงเงินกองทุนก่อนอนุมัติใบเบิกของตัวเองได้ไม่จำกัด ทำให้เพดานใน
// client_pr_approval_rules ไร้ผล (แตกใบเบิกย่อยให้ต่ำกว่าเพดานไปเรื่อยๆ แล้วอนุมัติเองได้ทุกใบเพราะกองทุน
// ไม่มีวันหมด) — can_manage_petty_cash_fund จึงต้องเป็นคนละ flag กับ "อนุมัติใบเบิก" เสมอ
function hasPettyCashAdminPermission(customer) {
  return customer.role === 'super_user' || customer.can_manage_petty_cash_fund === true;
}

function serializePettyCashFund(row) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    projectName: row.project_name || null,
    fundLimit: Number(row.fund_limit),
    balance: Number(row.balance),
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}
// ยอดคงเหลือกองทุน = วงเงินตั้งต้น - SUM(ใบเบิกเงินสดย่อยที่อนุมัติแล้วของกองทุนนี้) + SUM(ใบเติมเงินที่
// อนุมัติแล้วของกองทุนนี้) — คำนวณสดทุกครั้งที่อ่านผ่าน correlated subquery อ้างอิง alias "f" จาก FROM
// ของ query ที่เรียกใช้ ไม่เก็บเป็นคอลัมน์แยก (จำนวนแถวต่อกองทุนน้อย ไม่จำเป็นต้อง denormalize ให้เสี่ยง
// ข้อมูลไม่ตรงกัน)
const CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY = `
    (f.fund_limit
      - COALESCE((SELECT SUM(v.amount) FROM client_payment_vouchers v
                  WHERE v.petty_cash_fund_id = f.id AND v.company_id = f.company_id
                    AND v.voucher_type = 'petty_cash' AND v.status = 'approved'), 0)
      + COALESCE((SELECT SUM(rp.amount) FROM client_petty_cash_replenishments rp
                  WHERE rp.fund_id = f.id AND rp.company_id = f.company_id
                    AND rp.status = 'approved'), 0))`;

async function fetchPettyCashFund(dbClient, id, companyId) {
  const r = await dbClient.query(
    `SELECT f.id, f.name, f.project_id, cp.name AS project_name, f.fund_limit, f.is_active, f.created_at,
       ${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY} AS balance
     FROM client_petty_cash_funds f
     LEFT JOIN client_projects cp ON cp.id = f.project_id
     WHERE f.id=$1 AND f.company_id=$2`,
    [id, companyId]
  );
  if (r.rowCount === 0) return null;
  return serializePettyCashFund(r.rows[0]);
}

// ยังไม่เคยมี endpoint นี้เลยจนถึงตอนนี้ (client_chart_of_accounts มีแต่ seed อัตโนมัติ ไม่มีใครเคย query
// ออกมาแสดงผลตรงๆ) — ต้องใช้เป็น dropdown เลือกรหัสบัญชีค่าใช้จ่ายในฟอร์มใบเบิกเงิน (1.1/1.2/1.4) จึงเพิ่ม
// ให้ตอนนี้ — read-only ไม่ gate สิทธิ์เพิ่มเติมนอกจาก company scope (ตรงกับ pattern ของ GET อื่นในระบบ)
app.get('/api/customer/chart-of-accounts', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query(
    `SELECT code, name, category, parent_code, is_active FROM client_chart_of_accounts
     WHERE company_id=$1 AND is_active=true ORDER BY code`,
    [companyId]
  );
  res.json({ accounts: r.rows.map(a => ({ code: a.code, name: a.name, category: a.category, parentCode: a.parent_code })) });
});

app.get('/api/customer/petty-cash-funds', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query(
    `SELECT f.id, f.name, f.project_id, cp.name AS project_name, f.fund_limit, f.is_active, f.created_at,
       ${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY} AS balance
     FROM client_petty_cash_funds f
     LEFT JOIN client_projects cp ON cp.id = f.project_id
     WHERE f.company_id=$1 ORDER BY f.id DESC`,
    [companyId]
  );
  res.json({ funds: r.rows.map(serializePettyCashFund) });
});

app.post('/api/customer/petty-cash-funds', requireCustomerAuth, async (req, res) => {
  if (!hasPettyCashAdminPermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการกองทุนเงินสดย่อย' });
  const companyId = req.customer.company_id;
  const { name, projectId, fundLimit } = req.body || {};
  const safeName = String(name || '').trim();
  const safeFundLimit = parsePositiveNumericValue(fundLimit);
  if (!safeName) return res.status(400).json({ error: 'กรุณาระบุชื่อกองทุน' });
  if (safeFundLimit === null) return res.status(400).json({ error: 'กรุณาระบุวงเงินกองทุนให้ถูกต้อง' });
  if (projectId) {
    const proj = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return res.status(400).json({ error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' });
  }
  const insert = await pool.query(
    `INSERT INTO client_petty_cash_funds (company_id, name, project_id, fund_limit) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, safeName, projectId || null, safeFundLimit]
  );
  res.json({ fund: await fetchPettyCashFund(pool, insert.rows[0].id, companyId) });
});

app.put('/api/customer/petty-cash-funds/:id', requireCustomerAuth, async (req, res) => {
  if (!hasPettyCashAdminPermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการกองทุนเงินสดย่อย' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { name, projectId, fundLimit, isActive } = req.body || {};
  const safeName = String(name || '').trim();
  const safeFundLimit = parsePositiveNumericValue(fundLimit);
  if (!safeName) return res.status(400).json({ error: 'กรุณาระบุชื่อกองทุน' });
  if (safeFundLimit === null) return res.status(400).json({ error: 'กรุณาระบุวงเงินกองทุนให้ถูกต้อง' });
  if (projectId) {
    const proj = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return res.status(400).json({ error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ล็อกกองทุนก่อนเสมอ เป็น statement แยกต่างหากจากการคำนวณยอดเบิกสุทธิ (เหตุผลเดียวกับที่แก้ใน
    // /payment-vouchers/:id/approve — กัน snapshot เก่าตอน FOR UPDATE ต้องรอคิว)
    const lockRes = await client.query('SELECT id FROM client_petty_cash_funds WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (lockRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบกองทุนนี้' }); }

    // ห้ามลด fund_limit ต่ำกว่ายอดที่เบิกไปแล้วสุทธิ (SUM อนุมัติแล้ว - SUM เติมเงินที่อนุมัติแล้ว) ไม่งั้น
    // balance ที่คำนวณได้จะติดลบทันทีหลังบันทึก ทั้งที่ไม่มีธุรกรรมใหม่เกิดขึ้นเลย — net_disbursed คำนวณจาก
    // fund_limit เดิม (ก่อนแก้) ลบ balance เดิม เท่ากับ SUM(vouchers)-SUM(replenishments) พอดี
    const netRes = await client.query(
      `SELECT
         (f.fund_limit - (${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY})) AS net_disbursed,
         ($3::numeric >= (f.fund_limit - (${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY}))) AS is_sufficient
       FROM client_petty_cash_funds f WHERE f.id=$1 AND f.company_id=$2`,
      [id, companyId, safeFundLimit]
    );
    if (!netRes.rows[0].is_sufficient) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `ไม่สามารถลดวงเงินกองทุนต่ำกว่ายอดที่เบิกไปแล้วสุทธิ (${netRes.rows[0].net_disbursed} บาท) ได้` });
    }

    await client.query(
      `UPDATE client_petty_cash_funds SET name=$1, project_id=$2, fund_limit=$3, is_active=$4 WHERE id=$5 AND company_id=$6`,
      [safeName, projectId || null, safeFundLimit, isActive !== false, id, companyId]
    );
    await client.query('COMMIT');
    res.json({ fund: await fetchPettyCashFund(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขกองทุนไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- ผู้รับเงินภายนอก (client_external_payees) — ข้อ 1.4, master data เท่านั้น ----------------
// ใช้ can_manage_po ร่วมเหมือนผู้รับเหมาช่วง (hasSubcontractorManagePermission ด้านบน) ด้วยเหตุผลเดียวกัน
// เป๊ะๆ: ตารางนี้เป็นแค่ข้อมูลติดต่อ/อัตราหัก ณ ที่จ่ายเริ่มต้น ไม่มีเพดานวงเงินหรือผลต่อการอนุมัติใดๆ
// (CLAUDE.md ข้อ 14 ไม่เข้าเงื่อนไข — ไม่มีช่องโหว่ self-approval แบบ fund_limit) แยกฟังก์ชันเป็นชื่อของ
// ตัวเองแทนที่จะเรียก hasSubcontractorManagePermission ตรงๆ เพราะเป็นสิทธิ์คนละแนวคิดกัน (แค่บังเอิญ
// ใช้ flag เดียวกันวันนี้ — เหมือน canFinance/canBidding ที่แยกกันไว้ทั้งที่ gate เดียวกัน)
function hasExternalPayeeManagePermission(customer) {
  return customer.role === 'super_user' || customer.can_manage_po === true;
}

function serializeExternalPayee(row) {
  return {
    id: row.id,
    name: row.name,
    taxId: row.tax_id,
    branchCode: row.branch_code,
    address: row.address,
    taxpayerType: row.taxpayer_type,
    defaultWhtRate: Number(row.default_wht_rate),
    defaultExpenseAccountCode: row.default_expense_account_code,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

// ต่างจาก validateSubcontractorInput ตรงที่ต้อง await เช็ค default_expense_account_code กับผังบัญชี
// (composite FK ระดับ DB บังคับอยู่แล้วที่ client_external_payees_expense_account_fk แต่เช็คซ้ำชั้น
// application ก่อนเพื่อ error message อ่านง่ายกว่า FK violation ดิบๆ — pattern เดียวกับทั้งไฟล์) จึงเป็น
// async รับ dbClient เข้ามาด้วย (ตาม pattern ของ validate*VoucherInput ด้านล่าง ไม่ใช่ validateSubcontractorInput
// ที่เป็น sync ล้วนเพราะไม่มีฟิลด์ไหนต้อง query เช็คก่อน)
async function validateExternalPayeeInput(dbClient, companyId, { name, taxId, branchCode, address, taxpayerType, defaultWhtRate, defaultExpenseAccountCode }) {
  const safeName = String(name || '').trim();
  if (!safeName) return { error: 'กรุณาระบุชื่อผู้รับเงิน' };
  const safeTaxpayerType = ['individual', 'juristic'].includes(taxpayerType) ? taxpayerType : 'juristic';
  const safeTaxId = taxId ? String(taxId).trim() : null;
  if (safeTaxId && !/^\d{13}$/.test(safeTaxId)) return { error: 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' };
  // ⚠️ DB schema (migration 0001) ไม่มี CHECK บังคับเรื่องนี้ (ต่างจาก client_subcontractors ที่มี) —
  // บังคับที่ชั้น application แทนตามที่ตกลง เหตุผลเดียวกับผู้รับเหมาช่วง: นิติบุคคลไม่มีเลขผู้เสียภาษี
  // จะออกหนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) ตอนจ่ายเงินจริงไม่ได้เลย
  if (safeTaxpayerType === 'juristic' && !safeTaxId) {
    return { error: 'ผู้รับเงินประเภทนิติบุคคลต้องระบุเลขผู้เสียภาษี (ใช้ออกหนังสือรับรองหัก ณ ที่จ่ายตอนจ่ายเงินจริง)' };
  }
  const safeDefaultWhtRate = parseNonNegativeNumericValue(defaultWhtRate ?? 0);
  if (safeDefaultWhtRate === null || Number(safeDefaultWhtRate) > 100) return { error: 'ระบุอัตราหัก ณ ที่จ่ายเริ่มต้นไม่ถูกต้อง (0-100)' };
  const safeDefaultExpenseAccountCode = defaultExpenseAccountCode ? String(defaultExpenseAccountCode).trim() : null;
  if (safeDefaultExpenseAccountCode) {
    const acc = await dbClient.query('SELECT 1 FROM client_chart_of_accounts WHERE code=$1 AND company_id=$2 AND is_active=true', [safeDefaultExpenseAccountCode, companyId]);
    if (acc.rowCount === 0) return { error: 'ไม่พบรหัสบัญชีค่าใช้จ่ายเริ่มต้นนี้ในผังบัญชีของบริษัทคุณ' };
  }
  return {
    safeName, safeTaxId,
    safeBranchCode: String(branchCode || '00000').trim() || '00000',
    safeAddress: String(address || '').trim(),
    safeTaxpayerType,
    safeDefaultWhtRate,
    safeDefaultExpenseAccountCode,
  };
}

// เปิดให้ทุกคนที่ login แล้วดูได้ (ไม่ gate สิทธิ์) เหมือน GET /api/customer/subcontractors — ใครก็ตาม
// ที่สร้างใบจ่ายเจ้าหนี้ภายนอก (voucher_type='other') ต้องเลือกผู้รับเงินจาก list นี้ได้ ไม่ใช่แค่คนมีสิทธิ์
// จัดการ master data — ไม่มีข้อมูลอ่อนไหวแบบเลขบัญชีธนาคารให้ต้องซ่อนแบบผู้รับเหมาช่วงด้วย (ตารางนี้ไม่มี
// คอลัมน์ธนาคารเลย)
app.get('/api/customer/external-payees', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query('SELECT * FROM client_external_payees WHERE company_id=$1 ORDER BY name', [companyId]);
  res.json({ externalPayees: r.rows.map(serializeExternalPayee) });
});

app.post('/api/customer/external-payees', requireCustomerAuth, async (req, res) => {
  if (!hasExternalPayeeManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการผู้รับเงินภายนอก' });
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await validateExternalPayeeInput(client, companyId, req.body || {});
    if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    const insert = await client.query(
      `INSERT INTO client_external_payees
         (company_id, name, tax_id, branch_code, address, taxpayer_type, default_wht_rate, default_expense_account_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8) RETURNING *`,
      [companyId, v.safeName, v.safeTaxId, v.safeBranchCode, v.safeAddress, v.safeTaxpayerType, v.safeDefaultWhtRate, v.safeDefaultExpenseAccountCode]
    );
    const row = insert.rows[0];
    await writeAuditLog(client, {
      companyId, docType: 'external_payee', docId: row.id, action: 'create', performedBy: req.customer.id,
      reason: `เพิ่มผู้รับเงินภายนอกใหม่ "${row.name}"`,
    });
    await client.query('COMMIT');
    res.json({ externalPayee: serializeExternalPayee(row) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const isDupTaxId = err.constraint === 'uq_client_external_payees_taxid';
      return res.status(409).json({ error: isDupTaxId ? 'มีผู้รับเงินที่ใช้เลขผู้เสียภาษีนี้อยู่แล้ว' : 'มีผู้รับเงินชื่อนี้อยู่แล้ว (เทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่และคำนำหน้านิติบุคคล)' });
    }
    throw err;
  } finally {
    client.release();
  }
});

// ⚠️ full-replace เสมอ ไม่ใช่ partial patch — เหตุผลเดียวกับ PUT /api/customer/subcontractors/:id ทุก
// ประการ (ดูคอมเมนต์ที่นั่น) — ฟอร์มแก้ไขฝั่ง UI โหลดค่าปัจจุบันมาเต็มก่อนเสมอ
app.put('/api/customer/external-payees/:id', requireCustomerAuth, async (req, res) => {
  if (!hasExternalPayeeManagePermission(req.customer)) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการผู้รับเงินภายนอก' });
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM client_external_payees WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (existing.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบผู้รับเงินนี้' }); }
    const old = existing.rows[0];
    const v = await validateExternalPayeeInput(client, companyId, req.body || {});
    if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    // ⚠️ TODO เมื่อมี endpoint ที่ล็อกผู้รับเงินไว้กับ voucher ที่ยัง active อยู่ (draft/submitted) ในอนาคต:
    // ต้องบล็อกปิดใช้งานถ้ายังมี voucher ค้างอ้างอิงอยู่ — ตอนนี้ยังไม่มีเช็คนี้ (เหมือน TODO เดียวกันที่
    // client_subcontractors — ดูคอมเมนต์ที่นั่น หลักการเดียวกัน)
    const isActive = req.body && typeof req.body.isActive === 'boolean' ? req.body.isActive : true;

    const update = await client.query(
      `UPDATE client_external_payees SET
         name=$1, tax_id=$2, branch_code=$3, address=$4, taxpayer_type=$5,
         default_wht_rate=$6::numeric, default_expense_account_code=$7, is_active=$8
       WHERE id=$9 RETURNING *`,
      [v.safeName, v.safeTaxId, v.safeBranchCode, v.safeAddress, v.safeTaxpayerType,
       v.safeDefaultWhtRate, v.safeDefaultExpenseAccountCode, isActive, id]
    );
    const row = update.rows[0];

    const changes = [];
    if (old.name !== v.safeName) changes.push(`ชื่อ: "${old.name}" → "${v.safeName}"`);
    if ((old.tax_id || '') !== (v.safeTaxId || '')) changes.push(`เลขผู้เสียภาษี: "${old.tax_id || '-'}" → "${v.safeTaxId || '-'}"`);
    if (old.taxpayer_type !== v.safeTaxpayerType) changes.push(`ประเภท: "${old.taxpayer_type}" → "${v.safeTaxpayerType}"`);
    if (String(old.default_wht_rate) !== String(v.safeDefaultWhtRate)) changes.push(`อัตราหัก ณ ที่จ่ายเริ่มต้น: ${old.default_wht_rate}% → ${v.safeDefaultWhtRate}%`);
    if ((old.default_expense_account_code || '') !== (v.safeDefaultExpenseAccountCode || '')) changes.push(`รหัสบัญชีค่าใช้จ่ายเริ่มต้น: "${old.default_expense_account_code || '-'}" → "${v.safeDefaultExpenseAccountCode || '-'}"`);
    if (old.is_active !== isActive) changes.push(`สถานะ: ${old.is_active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'} → ${isActive ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}`);

    if (changes.length > 0) {
      await writeAuditLog(client, {
        companyId, docType: 'external_payee', docId: id, action: 'edit', performedBy: req.customer.id,
        fromStatus: old.is_active !== isActive ? String(old.is_active) : null,
        toStatus: old.is_active !== isActive ? String(isActive) : null,
        reason: changes.join('; '),
      });
    }
    await client.query('COMMIT');
    res.json({ externalPayee: serializeExternalPayee(row) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const isDupTaxId = err.constraint === 'uq_client_external_payees_taxid';
      return res.status(409).json({ error: isDupTaxId ? 'มีผู้รับเงินที่ใช้เลขผู้เสียภาษีนี้อยู่แล้ว' : 'มีผู้รับเงินชื่อนี้อยู่แล้ว (เทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่และคำนำหน้านิติบุคคล)' });
    }
    throw err;
  } finally {
    client.release();
  }
});

// รายชื่อประเภทเงินได้ตามมาตรา 40 — สำหรับ dropdown ตอนกรอก WHT rate ในฟอร์มใบจ่ายเจ้าหนี้ภายนอก
// (voucher_type='other') อ่านอย่างเดียว ไม่ gate สิทธิ์เพิ่มเติมนอกจาก login (ไม่ใช่ company-scoped —
// ตารางนี้เป็น master ร่วมทั้งระบบ ไม่มี company_id) default_rate เป็น NULL ได้ตามที่ตั้งใจ (เช่น 40(1)
// เงินเดือน คำนวณตามอัตราก้าวหน้า) — ส่ง null ตรงๆ ให้ frontend ปฏิเสธ/บังคับกรอกเอง ห้าม fallback เป็น 0
// ที่นี่ (CLAUDE.md ข้อ 17)
app.get('/api/customer/wht-income-types', requireCustomerAuth, async (req, res) => {
  const r = await pool.query('SELECT code, name_th, default_rate, is_active FROM client_wht_income_types WHERE is_active=true ORDER BY code');
  res.json({ incomeTypes: r.rows.map(row => ({ code: row.code, nameTh: row.name_th, defaultRate: row.default_rate !== null ? Number(row.default_rate) : null })) });
});

// ---------------- ใบเบิกเงิน (payment vouchers) — เฉพาะ voucher_type='petty_cash' เฟสนี้ ----------------
function serializePaymentVoucher(row) {
  return {
    id: row.id,
    voucherNo: row.voucher_no,
    voucherType: row.voucher_type,
    projectId: row.project_id,
    projectName: row.project_name || null,
    pettyCashFundId: row.petty_cash_fund_id,
    pettyCashFundName: row.fund_name || null,
    payeeEmployeeId: row.payee_employee_id,
    payeeEmployeeName: row.payee_employee_name || null,
    payeeExternalId: row.payee_external_id,
    payeeName: row.payee_name,
    purpose: row.purpose,
    amount: Number(row.amount),
    expenseAccountCode: row.expense_account_code,
    // มีความหมายเฉพาะตอน voucherType='other' (ข้อ 1.4) เท่านั้น — petty_cash/advance ปล่อย default 0/false
    hasTaxInvoice: row.has_tax_invoice,
    vatRate: Number(row.vat_rate), vatAmount: Number(row.vat_amount),
    whtRate: Number(row.wht_rate), whtAmount: Number(row.wht_amount), whtIncomeTypeCode: row.wht_income_type_code,
    netAmount: Number(row.net_amount),
    requestDate: row.request_date,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    voidedReason: row.voided_reason,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
const CLIENT_PAYMENT_VOUCHER_SELECT = `
  SELECT v.id, v.voucher_no, v.voucher_type, v.project_id, cp.name AS project_name,
    v.petty_cash_fund_id, f.name AS fund_name, v.payee_employee_id, e.full_name AS payee_employee_name,
    v.payee_external_id, v.payee_name, v.purpose, v.amount, v.expense_account_code,
    v.has_tax_invoice, v.vat_rate, v.vat_amount, v.wht_rate, v.wht_amount, v.wht_income_type_code, v.net_amount,
    to_char(v.request_date,'YYYY-MM-DD') AS request_date, v.status,
    v.submitted_by, v.submitted_at, v.approved_by, v.approved_at, v.rejected_reason,
    v.voided_reason, v.voided_by, v.voided_at, v.note, v.created_by, v.created_at
  FROM client_payment_vouchers v
  LEFT JOIN client_projects cp ON cp.id = v.project_id
  LEFT JOIN client_petty_cash_funds f ON f.id = v.petty_cash_fund_id
  LEFT JOIN employees e ON e.id = v.payee_employee_id`;

async function fetchPaymentVoucher(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_PAYMENT_VOUCHER_SELECT} WHERE v.id=$1 AND v.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  return serializePaymentVoucher(r.rows[0]);
}

// ใช้ร่วมกันระหว่าง POST (สร้าง) กับ PUT (แก้ไข draft) — dbClient รับทั้ง pool (POST) หรือ client ที่เปิด
// ทรานแซกชันไว้แล้ว (PUT ที่ถือ FOR UPDATE lock ของแถว voucher อยู่)
// เงินทดรองจ่าย (ข้อ 1.2) — ไม่มี pettyCashFundId (CHECK เดิม client_payment_vouchers_fund_type_check
// บังคับ petty_cash_fund_id ต้องเป็น NULL เมื่อ voucher_type<>'petty_cash' อยู่แล้ว) และไม่มี
// expenseAccountCode ตอนสร้าง (ยังไม่ใช่ค่าใช้จ่ายจนกว่าจะเคลียร์ในข้อ 1.3 — รหัสบัญชีค่าใช้จ่ายเลือกทีละ
// บรรทัดตอนเคลียร์แทน ผ่าน client_advance_clearance_items.expense_account_code)
async function validateAdvanceVoucherInput(dbClient, companyId, { projectId, payeeEmployeeId, purpose, amount }) {
  const safeAmount = parsePositiveNumericValue(amount);
  if (safeAmount === null) return { error: 'กรุณาระบุจำนวนเงินให้ถูกต้อง' };
  if (!payeeEmployeeId) return { error: 'กรุณาเลือกพนักงานผู้รับเงินทดรองจ่าย' };
  const emp = await dbClient.query(`SELECT full_name FROM employees WHERE id=$1 AND company_id=$2 AND status='active'`, [payeeEmployeeId, companyId]);
  if (emp.rowCount === 0) return { error: 'ไม่พบพนักงานนี้ในบริษัทของคุณ หรือพนักงานถูกปิดใช้งานแล้ว' };
  if (!purpose || !String(purpose).trim()) return { error: 'กรุณาระบุวัตถุประสงค์การเบิกเงินทดรองจ่าย' };
  if (projectId) {
    const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };
  }
  return { safeAmount, payeeName: emp.rows[0].full_name };
}

// จ่ายเจ้าหนี้ภายนอกไม่ผ่าน PO/WO (ข้อ 1.4) — จ่ายครั้งเดียวจบ ไม่มี items แยกตาราง (ต่างจาก 1.3) จึงมี
// VAT/WHT อยู่บนแถว voucher ตรงๆ (เพิ่มจาก migration 0006) — payee_name/payee_tax_id ดึงจาก master data
// (client_external_payees) เสมอเมื่อมี payee_external_id เหตุผลเดียวกับที่แก้ 1.3 ไปแล้ว (กันชื่อ/เลข
// เพี้ยนคนละแบบระหว่างใบที่จ่ายผู้รับเงินรายเดียวกัน ซึ่งจะทำให้สรุปยอดยื่น ภ.ง.ด. แยกเป็นคนละเจ้า)
async function validateExternalPaymentVoucherInput(dbClient, companyId, { projectId, payeeExternalId, purpose, amount, expenseAccountCode, hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode }) {
  const safeAmount = parsePositiveNumericValue(amount);
  if (safeAmount === null) return { error: 'กรุณาระบุจำนวนเงินให้ถูกต้อง' };
  if (!payeeExternalId) return { error: 'กรุณาเลือกผู้รับเงิน' };
  const payee = await dbClient.query('SELECT name, tax_id FROM client_external_payees WHERE id=$1 AND company_id=$2 AND is_active=true', [payeeExternalId, companyId]);
  if (payee.rowCount === 0) return { error: 'ไม่พบผู้รับเงินนี้ในบริษัทของคุณ หรือถูกปิดใช้งานแล้ว' };
  if (!purpose || !String(purpose).trim()) return { error: 'กรุณาระบุวัตถุประสงค์การจ่ายเงิน' };
  const safeExpenseAccountCode = String(expenseAccountCode || '').trim();
  if (!safeExpenseAccountCode) return { error: 'กรุณาระบุรหัสบัญชีค่าใช้จ่าย' };
  const acc = await dbClient.query('SELECT 1 FROM client_chart_of_accounts WHERE code=$1 AND company_id=$2 AND is_active=true', [safeExpenseAccountCode, companyId]);
  if (acc.rowCount === 0) return { error: 'ไม่พบรหัสบัญชีค่าใช้จ่ายนี้ในผังบัญชีของบริษัทคุณ' };

  const safeHasTaxInvoice = hasTaxInvoice === true;
  const safeVatRate = parseNonNegativeNumericValue(vatRate ?? 0);
  if (safeVatRate === null || Number(safeVatRate) > 100) return { error: 'ระบุอัตราภาษีซื้อไม่ถูกต้อง (0-100)' };
  // กฎเดียวกับ client_advance_clearance_items_tax_invoice_check/client_payment_vouchers_tax_invoice_check
  if (!safeHasTaxInvoice && Number(safeVatRate) > 0) {
    return { error: 'ไม่มีใบกำกับภาษีเต็มรูป ไม่สามารถระบุอัตราภาษีซื้อแยกได้ (กรุณารวม VAT เข้าไปในยอดค่าใช้จ่าย แล้วตั้งอัตราภาษีซื้อเป็น 0)' };
  }
  const safeWhtRate = parseNonNegativeNumericValue(whtRate ?? 0);
  if (safeWhtRate === null || Number(safeWhtRate) > 100) return { error: 'ระบุอัตราหัก ณ ที่จ่ายไม่ถูกต้อง (0-100)' };
  let safeWhtIncomeTypeCode = null;
  if (Number(safeWhtRate) > 0) {
    safeWhtIncomeTypeCode = whtIncomeTypeCode ? String(whtIncomeTypeCode).trim() : '';
    if (!safeWhtIncomeTypeCode) return { error: 'มีอัตราหัก ณ ที่จ่าย ต้องระบุประเภทเงินได้ตามมาตรา 40 ด้วย' };
    const typeRes = await dbClient.query('SELECT 1 FROM client_wht_income_types WHERE code=$1 AND is_active=true', [safeWhtIncomeTypeCode]);
    if (typeRes.rowCount === 0) return { error: 'ระบุประเภทเงินได้ไม่ถูกต้อง หรือประเภทนี้ถูกปิดใช้งานแล้ว' };
    if (!payee.rows[0].tax_id) {
      return { error: 'ผู้รับเงินนี้ยังไม่มีเลขผู้เสียภาษีในระบบ ไม่สามารถหัก ณ ที่จ่ายได้ (ใช้ออกหนังสือรับรอง 50 ทวิ) กรุณาเพิ่มเลขผู้เสียภาษีในข้อมูลผู้รับเงินก่อน' };
    }
  }
  if (projectId) {
    const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };
  }

  return {
    safeAmount, expenseAccountCode: safeExpenseAccountCode, payeeName: payee.rows[0].name,
    hasTaxInvoice: safeHasTaxInvoice, vatRate: safeVatRate, whtRate: safeWhtRate, whtIncomeTypeCode: safeWhtIncomeTypeCode,
  };
}

async function validatePettyCashVoucherInput(dbClient, companyId, { projectId, pettyCashFundId, payeeEmployeeId, purpose, amount, expenseAccountCode }) {
  const safeAmount = parsePositiveNumericValue(amount);
  if (safeAmount === null) return { error: 'กรุณาระบุจำนวนเงินให้ถูกต้อง' };
  if (!pettyCashFundId) return { error: 'กรุณาเลือกกองทุนเงินสดย่อย' };
  const fund = await dbClient.query('SELECT 1 FROM client_petty_cash_funds WHERE id=$1 AND company_id=$2 AND is_active=true', [pettyCashFundId, companyId]);
  if (fund.rowCount === 0) return { error: 'ไม่พบกองทุนนี้ในบริษัทของคุณ หรือกองทุนถูกปิดใช้งานแล้ว' };
  if (!payeeEmployeeId) return { error: 'กรุณาเลือกพนักงานผู้เบิก' };
  const emp = await dbClient.query(`SELECT full_name FROM employees WHERE id=$1 AND company_id=$2 AND status='active'`, [payeeEmployeeId, companyId]);
  if (emp.rowCount === 0) return { error: 'ไม่พบพนักงานนี้ในบริษัทของคุณ หรือพนักงานถูกปิดใช้งานแล้ว' };
  if (!purpose || !String(purpose).trim()) return { error: 'กรุณาระบุวัตถุประสงค์การเบิก' };
  if (projectId) {
    const proj = await dbClient.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return { error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' };
  }
  if (expenseAccountCode) {
    const acc = await dbClient.query('SELECT 1 FROM client_chart_of_accounts WHERE code=$1 AND company_id=$2 AND is_active=true', [expenseAccountCode, companyId]);
    if (acc.rowCount === 0) return { error: 'ไม่พบรหัสบัญชีค่าใช้จ่ายนี้ในผังบัญชีของบริษัทคุณ' };
  }
  return { safeAmount, payeeName: emp.rows[0].full_name };
}

app.get('/api/customer/payment-vouchers', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, voucherType, projectId, pettyCashFundId } = req.query;
  const conditions = ['v.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`v.status=$${params.length}`); }
  if (voucherType) { params.push(voucherType); conditions.push(`v.voucher_type=$${params.length}`); }
  if (projectId) { params.push(parseInt(projectId, 10)); conditions.push(`v.project_id=$${params.length}`); }
  if (pettyCashFundId) { params.push(parseInt(pettyCashFundId, 10)); conditions.push(`v.petty_cash_fund_id=$${params.length}`); }
  const r = await pool.query(`${CLIENT_PAYMENT_VOUCHER_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY v.id DESC`, params);
  res.json({ vouchers: r.rows.map(serializePaymentVoucher) });
});

app.get('/api/customer/payment-vouchers/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const voucher = await fetchPaymentVoucher(pool, id, companyId);
  if (!voucher) return res.status(404).json({ error: 'ไม่พบใบเบิกเงิน' });
  res.json({ voucher });
});

// 50 ทวิ ที่ออกจากการจ่ายตรง (voucher_type='other') — เหมือน GET .../advance-clearances/:id/wht-certificates
app.get('/api/customer/payment-vouchers/:id/wht-certificates', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const voucherCheck = await pool.query('SELECT 1 FROM client_payment_vouchers WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (voucherCheck.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเบิกเงิน' });
  const r = await pool.query(
    `SELECT *, to_char(payment_date,'YYYY-MM-DD') AS payment_date FROM client_wht_certificates WHERE company_id=$1 AND source_type='payment_voucher' AND source_id=$2 ORDER BY id`,
    [companyId, id]
  );
  res.json({ whtCertificates: r.rows.map(serializeWhtCertificate) });
});

// ต้องมี Idempotency-Key เสมอ — กันกดสร้างซ้ำ (double-click) ได้ใบเบิกเงินซ้ำสองใบจากคำขอเดียวกัน
app.post('/api/customer/payment-vouchers', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'payment-vouchers-create', async (client) => {
    const companyId = req.customer.company_id;
    const { voucherType, projectId, pettyCashFundId, payeeEmployeeId, payeeExternalId, purpose, amount, expenseAccountCode, note,
      hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode } = req.body || {};
    if (!['petty_cash', 'advance', 'other'].includes(voucherType)) {
      return { status: 400, body: { error: 'รองรับเฉพาะใบเบิกเงินสดย่อย (petty_cash), เงินทดรองจ่าย (advance), หรือจ่ายเจ้าหนี้ภายนอก (other) เท่านั้น' } };
    }
    let validation;
    if (voucherType === 'petty_cash') {
      validation = await validatePettyCashVoucherInput(client, companyId, { projectId, pettyCashFundId, payeeEmployeeId, purpose, amount, expenseAccountCode });
    } else if (voucherType === 'advance') {
      validation = await validateAdvanceVoucherInput(client, companyId, { projectId, payeeEmployeeId, purpose, amount });
    } else {
      validation = await validateExternalPaymentVoucherInput(client, companyId, { projectId, payeeExternalId, purpose, amount, expenseAccountCode, hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode });
    }
    if (validation.error) return { status: 400, body: { error: validation.error } };

    const insert = await client.query(
      `INSERT INTO client_payment_vouchers
         (company_id, voucher_type, project_id, petty_cash_fund_id, payee_employee_id, payee_external_id, payee_name, purpose, amount,
          expense_account_code, note, created_by, has_tax_invoice, vat_rate, vat_amount, wht_rate, wht_amount, wht_income_type_code, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12,$13,
         $14::numeric, ROUND($9::numeric * $14::numeric / 100, 2),
         $15::numeric, ROUND($9::numeric * $15::numeric / 100, 2),
         $16,
         ($9::numeric + ROUND($9::numeric * $14::numeric / 100, 2) - ROUND($9::numeric * $15::numeric / 100, 2)))
       RETURNING id`,
      [
        companyId, voucherType, projectId || null,
        voucherType === 'petty_cash' ? pettyCashFundId : null,
        (voucherType === 'petty_cash' || voucherType === 'advance') ? payeeEmployeeId : null,
        voucherType === 'other' ? payeeExternalId : null,
        validation.payeeName, String(purpose).trim(), validation.safeAmount,
        voucherType === 'other' ? validation.expenseAccountCode : (voucherType === 'petty_cash' ? (expenseAccountCode || null) : null),
        (note || '').trim(), req.customer.id,
        voucherType === 'other' ? validation.hasTaxInvoice : false,
        voucherType === 'other' ? validation.vatRate : '0',
        voucherType === 'other' ? validation.whtRate : '0',
        voucherType === 'other' ? validation.whtIncomeTypeCode : null,
      ]
    );
    const voucher = await fetchPaymentVoucher(client, insert.rows[0].id, companyId);
    return { status: 200, body: { voucher } };
  });
});

app.put('/api/customer/payment-vouchers/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vRes = await client.query('SELECT status, voucher_type FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (vRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเบิกเงิน' }); }
    if (vRes.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'แก้ไขได้เฉพาะใบเบิกเงินสถานะร่างเท่านั้น' }); }
    const voucherType = vRes.rows[0].voucher_type;
    if (!['petty_cash', 'advance', 'other'].includes(voucherType)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'รองรับเฉพาะใบเบิกเงินสดย่อย เงินทดรองจ่าย หรือจ่ายเจ้าหนี้ภายนอกเท่านั้น' }); }

    const { projectId, pettyCashFundId, payeeEmployeeId, payeeExternalId, purpose, amount, expenseAccountCode, note,
      hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode } = req.body || {};
    let validation;
    if (voucherType === 'petty_cash') {
      validation = await validatePettyCashVoucherInput(client, companyId, { projectId, pettyCashFundId, payeeEmployeeId, purpose, amount, expenseAccountCode });
    } else if (voucherType === 'advance') {
      validation = await validateAdvanceVoucherInput(client, companyId, { projectId, payeeEmployeeId, purpose, amount });
    } else {
      validation = await validateExternalPaymentVoucherInput(client, companyId, { projectId, payeeExternalId, purpose, amount, expenseAccountCode, hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode });
    }
    if (validation.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: validation.error }); }

    await client.query(
      `UPDATE client_payment_vouchers SET project_id=$1, petty_cash_fund_id=$2, payee_employee_id=$3, payee_external_id=$4, payee_name=$5,
         purpose=$6, amount=$7::numeric, expense_account_code=$8, note=$9,
         has_tax_invoice=$10, vat_rate=$11::numeric, vat_amount=ROUND($7::numeric * $11::numeric / 100, 2),
         wht_rate=$12::numeric, wht_amount=ROUND($7::numeric * $12::numeric / 100, 2), wht_income_type_code=$13,
         net_amount=($7::numeric + ROUND($7::numeric * $11::numeric / 100, 2) - ROUND($7::numeric * $12::numeric / 100, 2))
       WHERE id=$14`,
      [
        projectId || null,
        voucherType === 'petty_cash' ? pettyCashFundId : null,
        (voucherType === 'petty_cash' || voucherType === 'advance') ? payeeEmployeeId : null,
        voucherType === 'other' ? payeeExternalId : null,
        validation.payeeName, String(purpose).trim(), validation.safeAmount,
        voucherType === 'other' ? validation.expenseAccountCode : (voucherType === 'petty_cash' ? (expenseAccountCode || null) : null),
        (note || '').trim(),
        voucherType === 'other' ? validation.hasTaxInvoice : false,
        voucherType === 'other' ? validation.vatRate : '0',
        voucherType === 'other' ? validation.whtRate : '0',
        voucherType === 'other' ? validation.whtIncomeTypeCode : null,
        id,
      ]
    );
    await client.query('COMMIT');
    res.json({ voucher: await fetchPaymentVoucher(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบเบิกเงินไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

async function generateVoucherNo(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'payment_voucher');
    const no = `PV-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_payment_vouchers WHERE company_id=$1 AND voucher_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบเบิกเงินได้');
}

app.post('/api/customer/payment-vouchers/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `payment-vouchers-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเบิกเงิน' } };
    const v = r.rows[0];
    if (v.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะใบเบิกเงินสถานะร่างเท่านั้น' } };
    // docType ของ canApprove ต้องแยกตาม voucher_type เสมอ (petty_cash ใช้ flag/rule คนละชุดกับ advance
    // ตามที่ตกลง — ดู CLAUDE.md ข้อ 14) ใช้ตัวแปรนี้ร่วมกับ approve/reject/cancel ด้านล่างทั้งหมด
    const docType = paymentVoucherDocType(v.voucher_type);

    // enforceAmountLimit:false — ยื่นแทนผู้สร้างไม่ใช่การอนุมัติวงเงิน (เหตุผลเดียวกับ PR submit)
    if (req.customer.id !== v.created_by) {
      const permCheck = await canApprove(client, req.customer, docType, v.amount, {
        companyId, originators: [v.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบเบิกเงินนี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    // DB CHECK constraint (client_payment_vouchers_payee_type_check/_fund_type_check) บังคับอยู่แล้วว่า
    // พ้น draft ต้องครบคู่ payee/fund ตาม voucher_type — ยืนยันซ้ำที่ชั้น app ก่อน เพื่อคืน error ข้อความ
    // ที่อ่านเข้าใจง่ายกว่า constraint violation ดิบๆ (advance ไม่ต้องมี fund เลยตามกฎเดิม เช็คแค่ payee)
    if (v.voucher_type === 'petty_cash' && (!v.petty_cash_fund_id || !v.payee_employee_id)) {
      return { status: 400, body: { error: 'ใบเบิกเงินสดย่อยต้องระบุกองทุนและพนักงานผู้เบิกให้ครบก่อนยื่น' } };
    }
    if (v.voucher_type === 'advance' && !v.payee_employee_id) {
      return { status: 400, body: { error: 'ใบเบิกเงินทดรองจ่ายต้องระบุพนักงานผู้รับเงินให้ครบก่อนยื่น' } };
    }
    if (v.voucher_type === 'other' && (!v.payee_external_id || !v.expense_account_code)) {
      return { status: 400, body: { error: 'ใบจ่ายเจ้าหนี้ภายนอกต้องระบุผู้รับเงินและรหัสบัญชีค่าใช้จ่ายให้ครบก่อนยื่น' } };
    }

    const voucherNo = await generateVoucherNo(client, companyId);
    await client.query(
      `UPDATE client_payment_vouchers SET voucher_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [voucherNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'payment_voucher', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });

    const voucher = await fetchPaymentVoucher(client, id, companyId);
    return { status: 200, body: { voucher } };
  });
});

app.post('/api/customer/payment-vouchers/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `payment-vouchers-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเบิกเงิน' } };
    const v = r.rows[0];
    if (v.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะใบเบิกเงินที่ยื่นแล้วเท่านั้น' } };
    const docType = paymentVoucherDocType(v.voucher_type);

    const result = await canApprove(client, req.customer, docType, v.amount, {
      companyId, originators: [v.created_by, v.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    if (v.voucher_type === 'petty_cash') {
      if (!v.expense_account_code) {
        return { status: 400, body: { error: 'ใบเบิกเงินนี้ยังไม่ได้ระบุรหัสบัญชีค่าใช้จ่าย ไม่สามารถอนุมัติได้' } };
      }

      // ⚠️ ต้องแยกเป็น 2 statement เสมอ ห้ามรวมล็อก+คำนวณ balance ไว้ query เดียวกัน: PostgreSQL (READ
      // COMMITTED) ให้แต่ละ statement snapshot ของตัวเองตอนเริ่ม statement นั้นๆ — SELECT...FOR UPDATE ที่
      // ต้องรอคิว lock จะได้ "แถวที่ล็อกเอง" เวอร์ชันล่าสุดหลังตื่นจากรอก็จริง แต่ correlated subquery ที่
      // อ่านตารางอื่น (client_payment_vouchers/client_petty_cash_replenishments ใน
      // CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY) จะยังคงถูกประเมินด้วย snapshot เดิมตอน statement เริ่ม
      // ต้น (ก่อนรอคิว) ไม่ถูก re-evaluate ให้อัตโนมัติ — ถ้ารวมไว้ query เดียวกัน สอง approve พร้อมกันจาก
      // กองทุนเดียวกันจะเห็นยอดคงเหลือชุดเดิม (ก่อน approve ใบแรกจริง) ทั้งคู่ แล้วผ่านทั้งคู่ได้ทั้งที่รวม
      // กันเกินกองทุนจริง (พบจริงจากการรีวิว ไม่ใช่แค่ทฤษฎี) — แก้โดยแยกเป็น (1) ล็อกเฉยๆ ก่อน (2) คำนวณ/
      // เทียบ balance เป็น statement ใหม่แยกต่างหาก (ไม่ต้อง FOR UPDATE ซ้ำ เพราะถือ lock จาก (1) อยู่แล้ว)
      // — statement ใหม่นี้จะได้ snapshot สดหลังตื่นจากรอจริง เห็นผลของ approve ใบแรกที่ commit ไปแล้ว
      const fundLockRes = await client.query(
        'SELECT id FROM client_petty_cash_funds WHERE id=$1 AND company_id=$2 FOR UPDATE',
        [v.petty_cash_fund_id, companyId]
      );
      if (fundLockRes.rowCount === 0) return { status: 400, body: { error: 'ไม่พบกองทุนเงินสดย่อยนี้' } };

      const fundRes = await client.query(
        `SELECT f.id, ${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY} AS balance,
           (${CLIENT_PETTY_CASH_FUND_BALANCE_SUBQUERY} >= $3::numeric) AS has_enough
         FROM client_petty_cash_funds f WHERE f.id=$1 AND f.company_id=$2`,
        [v.petty_cash_fund_id, companyId, v.amount]
      );
      if (!fundRes.rows[0].has_enough) {
        return { status: 400, body: { error: `ยอดคงเหลือในกองทุนไม่เพียงพอ (คงเหลือ ${fundRes.rows[0].balance} บาท)` } };
      }
    }
    // advance ไม่ผูกกับกองทุนใดๆ เลยตามที่ตกลง (CHECK เดิมบังคับ petty_cash_fund_id เป็น NULL อยู่แล้ว) —
    // ไม่มีเพดานยอดคงเหลือต้องเช็คตรงนี้ เพดานอนุมัติมีแค่ระดับ per-document ผ่าน canApprove ด้านบนเท่านั้น

    await client.query(
      `UPDATE client_payment_vouchers SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
      [req.customer.id, id]
    );

    let issuedCertNos = [];
    if (v.voucher_type === 'petty_cash') {
      // Dr [expense_account_code] / Cr เงินสดย่อย — จ่ายออกจากกองทุนเงินสดย่อยจริง
      await createClientJournalEntry(client, {
        companyId, entryDate: getBangkokDateStr(), description: `จ่ายเงินสดย่อย ${v.voucher_no}: ${v.purpose}`,
        sourceType: 'payment_voucher', sourceId: id, projectId: v.project_id, createdBy: req.customer.id,
        lines: [
          { accountCode: v.expense_account_code, debitAmount: v.amount, creditAmount: 0, description: v.purpose },
          { accountCode: ACCOUNT_CODE_PETTY_CASH, debitAmount: 0, creditAmount: v.amount, description: 'เงินสดย่อย' },
        ],
      });
    } else if (v.voucher_type === 'advance') {
      // Dr ลูกหนี้เงินทดรองจ่าย (1150) / Cr เงินสด-ธนาคาร (1100) — ยังไม่ใช่ค่าใช้จ่าย เป็นแค่การจ่ายเงิน
      // ล่วงหน้าให้พนักงานไปสำรองจ่ายแทน ค่าใช้จ่ายจริงเกิดตอนเคลียร์ (ข้อ 1.3) ต่างหาก
      await createClientJournalEntry(client, {
        companyId, entryDate: getBangkokDateStr(), description: `จ่ายเงินทดรองจ่าย ${v.voucher_no}: ${v.purpose}`,
        sourceType: 'payment_voucher', sourceId: id, projectId: v.project_id, createdBy: req.customer.id,
        lines: [
          { accountCode: ACCOUNT_CODE_ADVANCE_RECEIVABLE, debitAmount: v.amount, creditAmount: 0, description: v.purpose },
          { accountCode: ACCOUNT_CODE_CASH, debitAmount: 0, creditAmount: v.amount, description: 'เงินสด-ธนาคาร' },
        ],
      });
    } else {
      // จ่ายเจ้าหนี้ภายนอกตรง (ข้อ 1.4) — Dr [expense_account_code] (+ 1170 ถ้าเคลมภาษีซื้อได้จริง) /
      // Cr 2120 (ถ้ามี WHT) / Cr 1100 (net_amount) — รูปทรงเดียวกับเคส 1.3.4 เป๊ะ แต่ Cr ตรงไป 1100 เลย
      // ไม่มี 1150/ส่วนต่างเพราะจ่ายตรง ไม่ผ่านพนักงานสำรองจ่าย — has_vat_claimable เช็คคู่ has_tax_invoice
      // เสมอ (เหตุผลเดียวกับที่แก้ 1.3 ไปแล้ว ไม่พึ่ง CHECK ของ DB เป็นเกราะป้องกันเงียบๆ)
      const detailRes = await client.query(
        `SELECT vat_amount, wht_amount, wht_income_type_code, net_amount,
                (has_tax_invoice AND vat_amount > 0) AS has_vat_claimable, (wht_amount > 0) AS has_wht,
                p.tax_id AS payee_tax_id, p.name AS payee_name_live
         FROM client_payment_vouchers v LEFT JOIN client_external_payees p ON p.id = v.payee_external_id
         WHERE v.id=$1`,
        [id]
      );
      const d = detailRes.rows[0];
      const lines = [{ accountCode: v.expense_account_code, debitAmount: v.amount, creditAmount: 0, description: v.purpose }];
      if (d.has_vat_claimable) {
        lines.push({ accountCode: ACCOUNT_CODE_VAT_INPUT, debitAmount: d.vat_amount, creditAmount: 0, description: `ภาษีซื้อ: ${v.purpose}` });
      }
      if (d.has_wht) {
        lines.push({ accountCode: ACCOUNT_CODE_WHT_PAYABLE, debitAmount: 0, creditAmount: d.wht_amount, description: 'ภาษีหัก ณ ที่จ่ายค้างนำส่ง' });
      }
      lines.push({ accountCode: ACCOUNT_CODE_CASH, debitAmount: 0, creditAmount: d.net_amount, description: `จ่ายเงิน ${v.voucher_no}: ${v.purpose}` });
      await createClientJournalEntry(client, {
        companyId, entryDate: getBangkokDateStr(), description: `จ่ายเจ้าหนี้ภายนอก ${v.voucher_no}: ${v.purpose}`,
        sourceType: 'payment_voucher', sourceId: id, projectId: v.project_id, createdBy: req.customer.id,
        lines,
      });
      if (d.has_wht) {
        const certNo = await generateWhtCertNo(client, companyId);
        const typeNameRes = await client.query('SELECT name_th FROM client_wht_income_types WHERE code=$1', [d.wht_income_type_code]);
        const typeName = typeNameRes.rows[0]?.name_th || '';
        await client.query(
          `INSERT INTO client_wht_certificates
             (company_id, cert_no, source_type, source_id, payee_name, payee_tax_id, payment_date, income_type_desc,
              gross_amount, wht_rate, wht_amount, wht_income_type_code, wht_income_type_name_snapshot, issued_by, issued_at)
           VALUES ($1,$2,'payment_voucher',$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11,$12,$13,now())`,
          [companyId, certNo, id, d.payee_name_live, d.payee_tax_id, getBangkokDateStr(), v.purpose,
           v.amount, v.wht_rate, d.wht_amount, d.wht_income_type_code, typeName, req.customer.id]
        );
        issuedCertNos.push(certNo);
      }
    }

    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'payment_voucher', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason: `${reason}${issuedCertNos.length ? ` (ออก 50 ทวิ: ${issuedCertNos.join(', ')})` : ''}`,
    });

    const voucher = await fetchPaymentVoucher(client, id, companyId);
    return { status: 200, body: { voucher, issuedWhtCertificates: issuedCertNos } };
  });
});

app.post('/api/customer/payment-vouchers/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเบิกเงิน' }); }
    const v = r.rows[0];
    if (v.status !== 'submitted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะใบเบิกเงินที่ยื่นแล้วเท่านั้น' }); }
    const docType = paymentVoucherDocType(v.voucher_type);

    // enforceAmountLimit:false — reject ไม่ใช่การอนุมัติวงเงิน (เหตุผลเดียวกับ PR reject)
    const permCheck = await canApprove(client, req.customer, docType, v.amount, {
      companyId, originators: [v.created_by, v.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: permCheck.message, code: permCheck.code }); }

    await client.query(`UPDATE client_payment_vouchers SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'payment_voucher', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    res.json({ voucher: await fetchPaymentVoucher(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบเบิกเงินไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้เฉพาะ draft/submitted เท่านั้นในเฟสนี้ (approved แล้วโพสต์บัญชีจริง ต้องใช้ /void ที่มี reversing
// journal entry ซึ่งยังไม่ได้ทำในรอบนี้ — ดู server/docs/pr-module-known-limitations.md หัวข้อ 3)
app.post('/api/customer/payment-vouchers/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเบิกเงิน' }); }
    const v = r.rows[0];
    if (!['draft', 'submitted'].includes(v.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกใบเบิกเงินในสถานะนี้ได้ (อนุมัติแล้วต้องใช้ /void)' });
    }
    const isOwner = req.customer.id === v.created_by || (v.submitted_by != null && req.customer.id === v.submitted_by);
    let cancelIsOverride = false;
    if (!isOwner) {
      const docType = paymentVoucherDocType(v.voucher_type);
      const permCheck = await canApprove(client, req.customer, docType, v.amount, {
        companyId, originators: [v.created_by, v.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบเบิกเงินนี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
      cancelIsOverride = permCheck.isOverride;
    }
    await client.query(`UPDATE client_payment_vouchers SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'payment_voucher', docId: id, action: 'cancel',
      fromStatus: v.status, toStatus: 'cancelled', performedBy: req.customer.id, isOverride: cancelIsOverride,
    });
    await client.query('COMMIT');
    res.json({ voucher: await fetchPaymentVoucher(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบเบิกเงินไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- ยอดเงินทดรองจ่ายคงค้างรายพนักงาน (ข้อ 1.2) ----------------
// "คงค้าง" = ใบเบิกเงินทดรองจ่ายที่ approved แล้ว แต่ยังไม่มีใบเคลียร์ (client_advance_clearances) สถานะ
// 'approved' หรือ 'settled' ผูกกับมัน — ใบเดียวเคลียร์ได้ครั้งเดียวเสมอ (unique index
// uq_client_advance_clearances_active_voucher กันมีใบเคลียร์ live ซ้อนกันมากกว่า 1 ใบต่อ advance หนึ่งใบ)
// ⚠️ ต้องเช็คทั้ง 'approved' และ 'settled' (ไม่ใช่แค่ 'approved' เฉยๆ) — หลัง migration 0005 แยกสถานะ
// 'settled' ออกจาก 'approved' แล้ว (เคลียร์ที่มีส่วนต่างจะค้างที่ 'approved' รอ /settle ก่อนค่อยขยับไป
// 'settled' จริง) ถ้าเช็คแค่ 'approved' เฉยๆ พอเคลียร์ไหนถูก /settle จนสถานะเปลี่ยนเป็น 'settled' แล้ว
// เงื่อนไข NOT EXISTS จะกลับมาเป็นจริงอีกครั้ง ทำให้ใบเบิกที่เคลียร์เสร็จสมบูรณ์แล้วโผล่กลับมาเป็น "คงค้าง"
// ผิดๆ ในรายงาน (บั๊กจริงที่พบตอนต่อ UI หัวข้อ 1.3 — endpoint นี้เขียนไว้ตั้งแต่ก่อน 0005 แยกสถานะ เลยไม่เคย
// อัปเดตตาม)
app.get('/api/customer/outstanding-advances', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { employeeId } = req.query;
  const conditions = [
    `v.company_id=$1`, `v.voucher_type='advance'`, `v.status='approved'`,
    `NOT EXISTS (SELECT 1 FROM client_advance_clearances c WHERE c.advance_voucher_id = v.id AND c.status IN ('approved','settled'))`,
  ];
  const params = [companyId];
  if (employeeId) { params.push(parseInt(employeeId, 10)); conditions.push(`v.payee_employee_id=$${params.length}`); }
  const r = await pool.query(
    `SELECT v.payee_employee_id, e.full_name AS payee_employee_name,
       SUM(v.amount) AS outstanding_amount, COUNT(*)::int AS voucher_count,
       json_agg(json_build_object('id', v.id, 'voucherNo', v.voucher_no, 'amount', v.amount, 'approvedAt', v.approved_at) ORDER BY v.id) AS vouchers
     FROM client_payment_vouchers v
     LEFT JOIN employees e ON e.id = v.payee_employee_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY v.payee_employee_id, e.full_name
     ORDER BY v.payee_employee_id`,
    params
  );
  res.json({
    outstandingAdvances: r.rows.map(row => ({
      payeeEmployeeId: row.payee_employee_id,
      payeeEmployeeName: row.payee_employee_name,
      outstandingAmount: Number(row.outstanding_amount), // แสดงผลรวมเท่านั้น ไม่ใช้ตัดสินใจ/คำนวณต่อ
      voucherCount: row.voucher_count,
      vouchers: row.vouchers.map(x => ({ id: x.id, voucherNo: x.voucherNo, amount: Number(x.amount), approvedAt: x.approvedAt })),
    })),
  });
});

// ---------------- ใบเคลียร์เงินทดรองจ่าย (ข้อ 1.3) ----------------
// รหัสบัญชีเฉพาะโมดูลนี้ (ตายตัวตามความหมายทางธุรกิจ เหมือน ACCOUNT_CODE_PETTY_CASH/ACCOUNT_CODE_CASH/
// ACCOUNT_CODE_ADVANCE_RECEIVABLE ด้านบน)
const ACCOUNT_CODE_VAT_INPUT = '1170';        // ภาษีซื้อ — Dr เฉพาะบรรทัดที่ has_tax_invoice=true เท่านั้น
const ACCOUNT_CODE_WHT_PAYABLE = '2120';      // ภาษีหัก ณ ที่จ่ายค้างนำส่ง
const ACCOUNT_CODE_EMPLOYEE_PAYABLE = '2110'; // เจ้าหนี้พนักงาน (ส่วนต่างเบิกเพิ่มที่ยังไม่ได้จ่ายจริง)

function serializeAdvanceClearanceItem(row) {
  return {
    id: row.id, idx: row.idx, description: row.description, expenseAccountCode: row.expense_account_code,
    amount: Number(row.amount), hasTaxInvoice: row.has_tax_invoice,
    vatRate: Number(row.vat_rate), vatAmount: Number(row.vat_amount),
    whtRate: Number(row.wht_rate), whtAmount: Number(row.wht_amount), whtIncomeTypeCode: row.wht_income_type_code,
    netAmount: Number(row.net_amount),
    payeeName: row.payee_name, payeeTaxId: row.payee_tax_id, payeeExternalId: row.payee_external_id,
  };
}
function serializeAdvanceClearance(row) {
  return {
    id: row.id, clearanceNo: row.clearance_no, advanceVoucherId: row.advance_voucher_id,
    advanceVoucherNo: row.advance_voucher_no || null,
    payeeEmployeeId: row.payee_employee_id, payeeEmployeeName: row.payee_employee_name || null,
    clearanceDate: row.clearance_date, advanceAmount: Number(row.advance_amount),
    totalExpenseAmount: Number(row.total_expense_amount), differenceAmount: Number(row.difference_amount),
    status: row.status,
    submittedBy: row.submitted_by, submittedAt: row.submitted_at,
    approvedBy: row.approved_by, approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    voidedReason: row.voided_reason, voidedBy: row.voided_by, voidedAt: row.voided_at,
    settlementDate: row.settlement_date, settlementChannel: row.settlement_channel, settlementRef: row.settlement_ref,
    settlementRecordedBy: row.settlement_recorded_by, settlementRecordedAt: row.settlement_recorded_at,
    note: row.note, createdBy: row.created_by, createdAt: row.created_at,
    items: [],
  };
}
// ac.* เพียงอย่างเดียวจะส่ง clearance_date/settlement_date (DATE columns) ออกไปเป็น JS Date object ที่
// pg แปลงด้วย local timezone ของเครื่อง server (ไม่ใช่ UTC เสมอไป) — เครื่องนี้ local timezone เป็น
// Asia/Bangkok (UTC+7) พอ JSON.stringify กลับเป็น UTC ตอน res.json() เที่ยงคืนวันที่จริงจะกลายเป็น
// 17:00 ของ "วันก่อนหน้า" ใน string ISO ที่ส่งออกไป (เช่น 2026-08-21 กลายเป็น
// "2026-08-20T17:00:00.000Z") ทำให้ frontend ที่ตัดด้วย .slice(0,10) เจอวันที่ผิดเพี้ยนไปวันหนึ่งเสมอ —
// override ด้วย to_char() ทับคอลัมน์ชื่อเดียวกัน (Postgres คืนสองคอลัมน์ชื่อซ้ำได้ ตัวหลังชนะตอน map เป็น
// JS object) ตาม pattern เดิมที่ใช้แล้วกับ client_leave_requests/client_labor_costs (บรรทัด ~1040/4880)
const CLIENT_ADVANCE_CLEARANCE_SELECT = `
  SELECT ac.*, to_char(ac.clearance_date,'YYYY-MM-DD') AS clearance_date,
    to_char(ac.settlement_date,'YYYY-MM-DD') AS settlement_date,
    v.voucher_no AS advance_voucher_no, v.payee_employee_id, e.full_name AS payee_employee_name
  FROM client_advance_clearances ac
  JOIN client_payment_vouchers v ON v.id = ac.advance_voucher_id
  LEFT JOIN employees e ON e.id = v.payee_employee_id`;

async function fetchFullAdvanceClearance(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_ADVANCE_CLEARANCE_SELECT} WHERE ac.id=$1 AND ac.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  const clearance = serializeAdvanceClearance(r.rows[0]);
  const items = await dbClient.query(
    'SELECT * FROM client_advance_clearance_items WHERE clearance_id=$1 AND company_id=$2 ORDER BY idx',
    [id, companyId]
  );
  clearance.items = items.rows.map(serializeAdvanceClearanceItem);
  return clearance;
}

async function recomputeClientAdvanceClearanceTotalAmount(client, companyId, clearanceId) {
  await client.query(
    `UPDATE client_advance_clearances SET total_expense_amount = COALESCE(
       (SELECT SUM(net_amount) FROM client_advance_clearance_items WHERE clearance_id=$1), 0)
     WHERE id=$1 AND company_id=$2`,
    [clearanceId, companyId]
  );
}

// ตรวจ+เตรียม items ร่วมของ POST/PUT — คืน {error} หรือ {safeItems} (ไม่แตะ DB เขียนเลย แค่ validate)
// amount/vatRate/whtRate ทุกตัวคงเป็น string จาก parsePositiveNumericValue/parseNonNegativeNumericValue
// เสมอ (ห้ามผ่าน Number() ก่อนส่งเข้า SQL) — vat_amount/wht_amount/net_amount คำนวณฝั่ง SQL ตอน INSERT
// จริง (ดู insertAdvanceClearanceItems) ไม่คำนวณที่นี่
async function validateAdvanceClearanceItemsInput(dbClient, companyId, items) {
  const rawItems = Array.isArray(items) ? items : [];
  const safeItems = [];
  for (const it of rawItems) {
    const description = String(it.description || '').trim();
    const amount = parsePositiveNumericValue(it.amount);
    if (!description || amount === null) continue; // แถวว่างที่ยังกรอกไม่เสร็จ ข้ามเงียบๆ (พฤติกรรมเดิม เหมือน PR)

    const expenseAccountCode = String(it.expenseAccountCode || '').trim();
    if (!expenseAccountCode) return { error: `รายการ "${description}" ต้องระบุรหัสบัญชีค่าใช้จ่าย` };
    const acc = await dbClient.query('SELECT 1 FROM client_chart_of_accounts WHERE code=$1 AND company_id=$2 AND is_active=true', [expenseAccountCode, companyId]);
    if (acc.rowCount === 0) return { error: `รายการ "${description}" ระบุรหัสบัญชีค่าใช้จ่ายไม่ถูกต้อง` };

    const hasTaxInvoice = it.hasTaxInvoice === true;
    const vatRate = parseNonNegativeNumericValue(it.vatRate ?? 0);
    if (vatRate === null || Number(vatRate) > 100) return { error: `รายการ "${description}" ระบุอัตราภาษีซื้อไม่ถูกต้อง (0-100)` };
    // กฎจาก CHECK client_advance_clearance_items_tax_invoice_check: has_tax_invoice=false ต้องไม่มี VAT
    // แยกบรรทัดเด็ดขาด (ต้องรวมเข้า amount เอง) — เช็คซ้ำที่ชั้นแอปก่อน เพื่อคืนข้อความที่อ่านเข้าใจง่าย
    // กว่า constraint violation ดิบๆ ตาม pattern เดิมของทั้งโมดูล
    if (!hasTaxInvoice && Number(vatRate) > 0) {
      return { error: `รายการ "${description}" ไม่มีใบกำกับภาษีเต็มรูป ไม่สามารถระบุอัตราภาษีซื้อแยกบรรทัดได้ (กรุณารวม VAT เข้าไปในยอดค่าใช้จ่าย แล้วตั้งอัตราภาษีซื้อเป็น 0)` };
    }

    const whtRate = parseNonNegativeNumericValue(it.whtRate ?? 0);
    if (whtRate === null || Number(whtRate) > 100) return { error: `รายการ "${description}" ระบุอัตราหัก ณ ที่จ่ายไม่ถูกต้อง (0-100)` };
    let whtIncomeTypeCode = null;
    if (Number(whtRate) > 0) {
      whtIncomeTypeCode = it.whtIncomeTypeCode ? String(it.whtIncomeTypeCode).trim() : '';
      if (!whtIncomeTypeCode) return { error: `รายการ "${description}" มีอัตราหัก ณ ที่จ่าย ต้องระบุประเภทเงินได้ตามมาตรา 40 ด้วย` };
      const typeRes = await dbClient.query('SELECT 1 FROM client_wht_income_types WHERE code=$1 AND is_active=true', [whtIncomeTypeCode]);
      if (typeRes.rowCount === 0) return { error: `รายการ "${description}" ระบุประเภทเงินได้ไม่ถูกต้อง หรือประเภทนี้ถูกปิดใช้งานแล้ว` };
    }

    let payeeName = String(it.payeeName || '').trim();
    let payeeTaxId = String(it.payeeTaxId || '').trim();
    let payeeExternalId = it.payeeExternalId || null;
    if (payeeExternalId) {
      // ผูก master data จริง (client_external_payees) — ใช้ชื่อ/เลขผู้เสียภาษีจาก master เสมอ ไม่ใช่
      // free text ที่ผู้ใช้พิมพ์เอง (แม้จะส่ง payeeName/payeeTaxId มาด้วยก็ตาม ถูก override ทิ้ง) กัน
      // ชื่อ/เลขเพี้ยนไปคนละแบบระหว่างใบเคลียร์ที่อ้างถึงผู้รับเงินรายเดียวกันจริง ซึ่งจะทำให้ตอนสรุปยอด
      // ยื่น ภ.ง.ด. (GET /wht-payable-summary) แยกกลุ่มเป็นคนละเจ้าโดยไม่ตั้งใจ (พบจริงจากรีวิว)
      const p = await dbClient.query('SELECT name, tax_id FROM client_external_payees WHERE id=$1 AND company_id=$2 AND is_active=true', [payeeExternalId, companyId]);
      if (p.rowCount === 0) return { error: `รายการ "${description}" ไม่พบผู้รับเงิน (master data) นี้ในบริษัทของคุณ หรือถูกปิดใช้งานแล้ว` };
      payeeName = p.rows[0].name;
      payeeTaxId = p.rows[0].tax_id || '';
    }
    if (!payeeName) return { error: `รายการ "${description}" ต้องระบุชื่อผู้รับเงิน` };
    if (Number(whtRate) > 0 && !payeeTaxId) {
      return { error: `รายการ "${description}" มีอัตราหัก ณ ที่จ่าย ต้องระบุเลขผู้เสียภาษีของผู้รับเงินด้วย (ใช้ออกหนังสือรับรอง 50 ทวิ)` };
    }

    safeItems.push({ description, expenseAccountCode, amount, hasTaxInvoice, vatRate, whtRate, whtIncomeTypeCode, payeeName, payeeTaxId, payeeExternalId });
  }
  return { safeItems };
}

// vat_amount/wht_amount/net_amount คำนวณฝั่ง SQL ล้วนๆ ตรงนี้ (ROUND(...,2) ด้วย ::numeric ตลอดสาย) —
// ไม่มี Number() แตะค่าเงิน/จำนวนใดๆ เลยตลอดเส้นทางนี้ ตาม CLAUDE.md ข้อ 3
async function insertAdvanceClearanceItems(client, companyId, clearanceId, safeItems) {
  for (let i = 0; i < safeItems.length; i++) {
    const it = safeItems[i];
    await client.query(
      `INSERT INTO client_advance_clearance_items
         (clearance_id, company_id, idx, description, expense_account_code, amount, vat_rate, vat_amount,
          has_tax_invoice, wht_rate, wht_amount, net_amount, wht_income_type_code, payee_name, payee_tax_id, payee_external_id)
       VALUES ($1,$2,$3,$4,$5,
         $6::numeric, $7::numeric, ROUND($6::numeric * $7::numeric / 100, 2),
         $8,
         $9::numeric, ROUND($6::numeric * $9::numeric / 100, 2),
         ($6::numeric + ROUND($6::numeric * $7::numeric / 100, 2) - ROUND($6::numeric * $9::numeric / 100, 2)),
         $10, $11, $12, $13)`,
      [clearanceId, companyId, i, it.description, it.expenseAccountCode,
       it.amount, it.vatRate, it.hasTaxInvoice, it.whtRate,
       it.whtIncomeTypeCode, it.payeeName, it.payeeTaxId, it.payeeExternalId]
    );
  }
}

async function generateClearanceNo(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'advance_clearance');
    const no = `ADV-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_advance_clearances WHERE company_id=$1 AND clearance_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบเคลียร์เงินทดรองจ่ายได้');
}

async function generateWhtCertNo(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'wht_certificate');
    const no = `WHT-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_wht_certificates WHERE company_id=$1 AND cert_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่หนังสือรับรองหัก ณ ที่จ่ายได้');
}

function serializeWhtCertificate(row) {
  return {
    id: row.id, certNo: row.cert_no, sourceType: row.source_type, sourceId: row.source_id,
    payeeName: row.payee_name, payeeTaxId: row.payee_tax_id, paymentDate: row.payment_date,
    incomeTypeDesc: row.income_type_desc,
    whtIncomeTypeCode: row.wht_income_type_code, whtIncomeTypeNameSnapshot: row.wht_income_type_name_snapshot,
    grossAmount: Number(row.gross_amount), whtRate: Number(row.wht_rate), whtAmount: Number(row.wht_amount),
    issuedBy: row.issued_by, issuedAt: row.issued_at,
  };
}

// รายการ 50 ทวิ ทั้งหมดของบริษัท ข้ามแหล่งที่มา (source_type ทั้ง payment_voucher/advance_clearance_item/
// subcontractor_payment) — สำหรับหน้า list/พิมพ์ซ้ำ (ข้อ 1.4.4) เทียบกับ endpoint เดิม 2 ตัวที่ผูกกับ
// เอกสารใบเดียว (.../payment-vouchers/:id/wht-certificates, .../advance-clearances/:id/wht-certificates)
// ตัวนี้ไม่ผูกกับใบไหนใบหนึ่ง กรองได้ตามเดือน (payment_date) และชื่อผู้รับเงิน
//
// ⚠️ ข้อจำกัดที่รู้ตัว: กรองด้วย payee_name (string match บน snapshot ที่ freeze ไว้ตอนออกใบ) ไม่ใช่ FK
// ไปยัง client_external_payees/client_subcontractors เพราะตารางนี้ตั้งใจไม่มี FK แบบนั้นอยู่แล้ว (ดู
// คอมเมนต์ตอนสร้างตารางที่ migration 0001 — freeze ชื่อไว้ถาวรไม่ให้เปลี่ยนตามชื่อปัจจุบันของ master data)
// ผลคือถ้าผู้รับเงินถูกเปลี่ยนชื่อในภายหลัง ใบเก่าจะกรองด้วยชื่อปัจจุบันไม่เจอ (ต้องกรองด้วยชื่อเดิมตอนออกใบ
// แทน) — ยอมรับข้อจำกัดนี้แทนที่จะเพิ่มคอลัมน์ FK ใหม่ที่ต้องทำ migration เพิ่ม เพราะกรณีเปลี่ยนชื่อผู้รับเงิน
// ที่เคยออก 50 ทวิ ไปแล้วเกิดไม่บ่อย และยังกรองด้วยเดือนอย่างเดียว/ไล่ดูทั้งหมดได้เสมอ
app.get('/api/customer/wht-certificates', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { month, payeeName } = req.query;
  const conditions = ['company_id=$1'];
  const params = [companyId];
  if (month) { params.push(month); conditions.push(`to_char(payment_date,'YYYY-MM')=$${params.length}`); }
  if (payeeName) { params.push(`%${payeeName}%`); conditions.push(`payee_name ILIKE $${params.length}`); }
  const r = await pool.query(
    // ORDER BY payment_date เฉยๆ จะ ambiguous เพราะ SELECT list มีคอลัมน์ชื่อ payment_date ซ้ำ 2 ตัว
    // (ตัวจาก * ดิบ กับตัวที่ to_char ทับ) ต้อง qualify ด้วยชื่อตารางให้ชัดว่าหมายถึงคอลัมน์จริงบนตาราง
    // ไม่ใช่ชื่อ output column ที่ซ้ำกันใน SELECT list
    `SELECT *, to_char(payment_date,'YYYY-MM-DD') AS payment_date FROM client_wht_certificates WHERE ${conditions.join(' AND ')} ORDER BY client_wht_certificates.payment_date DESC, id DESC`,
    params
  );
  res.json({ whtCertificates: r.rows.map(serializeWhtCertificate) });
});

app.get('/api/customer/advance-clearances', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, advanceVoucherId } = req.query;
  const conditions = ['ac.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`ac.status=$${params.length}`); }
  if (advanceVoucherId) { params.push(parseInt(advanceVoucherId, 10)); conditions.push(`ac.advance_voucher_id=$${params.length}`); }
  const r = await pool.query(`${CLIENT_ADVANCE_CLEARANCE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ac.id DESC`, params);
  res.json({ clearances: r.rows.map(serializeAdvanceClearance) });
});

app.get('/api/customer/advance-clearances/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const clearance = await fetchFullAdvanceClearance(pool, id, companyId);
  if (!clearance) return res.status(404).json({ error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' });
  res.json({ clearance });
});

app.get('/api/customer/advance-clearances/:id/wht-certificates', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const clearanceCheck = await pool.query('SELECT 1 FROM client_advance_clearances WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (clearanceCheck.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' });
  const r = await pool.query(
    `SELECT wc.*, to_char(wc.payment_date,'YYYY-MM-DD') AS payment_date FROM client_wht_certificates wc
     JOIN client_advance_clearance_items i ON i.id = wc.source_id AND wc.source_type='advance_clearance_item'
     WHERE wc.company_id=$1 AND i.clearance_id=$2 ORDER BY wc.id`,
    [companyId, id]
  );
  res.json({ whtCertificates: r.rows.map(serializeWhtCertificate) });
});

// สรุปยอดหัก ณ ที่จ่ายรายเดือน ให้ฝ่ายบัญชีเอาไปยื่น ภ.ง.ด.3/53 ด้วยมือ — ไม่ใช่การนำส่งอัตโนมัติ (นอก
// ขอบเขตรอบนี้ ดู known-limitations) filter ปีค.ศ./เดือนได้ ไม่ระบุ = คืนทุกช่วงเวลา
app.get('/api/customer/wht-payable-summary', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { year, month } = req.query;
  const conditions = ['company_id=$1'];
  const params = [companyId];
  if (year && month) {
    const startStr = `${year}-${String(month).padStart(2, '0')}-01`;
    params.push(startStr);
    conditions.push(`payment_date >= $${params.length}::date`);
    params.push(startStr);
    conditions.push(`payment_date < ($${params.length}::date + INTERVAL '1 month')`);
  }
  const r = await pool.query(
    `SELECT to_char(payment_date,'YYYY-MM') AS period, wht_income_type_code, wht_income_type_name_snapshot,
       SUM(gross_amount) AS total_gross, SUM(wht_amount) AS total_wht, COUNT(*)::int AS cert_count
     FROM client_wht_certificates WHERE ${conditions.join(' AND ')}
     GROUP BY period, wht_income_type_code, wht_income_type_name_snapshot
     ORDER BY period, wht_income_type_code`,
    params
  );
  res.json({
    summary: r.rows.map(row => ({
      period: row.period, whtIncomeTypeCode: row.wht_income_type_code, whtIncomeTypeName: row.wht_income_type_name_snapshot,
      totalGross: Number(row.total_gross), totalWht: Number(row.total_wht), certCount: row.cert_count,
    })),
  });
});

// ต้องมี Idempotency-Key เสมอ — กันกดสร้างซ้ำ (double-click) ได้ใบเคลียร์ซ้ำสองใบจากคำขอเดียวกัน
app.post('/api/customer/advance-clearances', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'advance-clearances-create', async (client) => {
    const companyId = req.customer.company_id;
    const { advanceVoucherId, clearanceDate, note, items } = req.body || {};
    if (!advanceVoucherId) return { status: 400, body: { error: 'กรุณาเลือกใบเบิกเงินทดรองจ่ายต้นทาง' } };
    const voucherRes = await client.query(
      `SELECT id, amount, status FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 AND voucher_type='advance'`,
      [advanceVoucherId, companyId]
    );
    if (voucherRes.rowCount === 0) return { status: 400, body: { error: 'ไม่พบใบเบิกเงินทดรองจ่ายนี้ในบริษัทของคุณ' } };
    const voucher = voucherRes.rows[0];
    if (voucher.status !== 'approved') return { status: 400, body: { error: 'เคลียร์ได้เฉพาะใบเบิกเงินทดรองจ่ายที่อนุมัติแล้วเท่านั้น' } };
    // ตรงกับ unique index uq_client_advance_clearances_active_voucher — เช็คซ้ำที่นี่ก่อนเพื่อคืนข้อความ
    // ที่อ่านเข้าใจง่ายกว่า unique violation ดิบๆ
    const liveRes = await client.query(
      `SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1 AND status NOT IN ('rejected','cancelled','voided')`,
      [advanceVoucherId]
    );
    if (liveRes.rowCount > 0) return { status: 409, body: { error: 'ใบเบิกเงินทดรองจ่ายนี้มีใบเคลียร์ที่ยังดำเนินการอยู่แล้ว' } };

    const itemsValidation = await validateAdvanceClearanceItemsInput(client, companyId, items);
    if (itemsValidation.error) return { status: 400, body: { error: itemsValidation.error } };
    const { safeItems } = itemsValidation;
    if (safeItems.length === 0) return { status: 400, body: { error: 'กรุณากรอกรายการค่าใช้จ่ายอย่างน้อย 1 รายการ' } };

    const insert = await client.query(
      `INSERT INTO client_advance_clearances (company_id, advance_voucher_id, clearance_date, advance_amount, note, created_by)
       VALUES ($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
      [companyId, advanceVoucherId, clearanceDate || getBangkokDateStr(), voucher.amount, (note || '').trim(), req.customer.id]
    );
    const clearanceId = insert.rows[0].id;
    await insertAdvanceClearanceItems(client, companyId, clearanceId, safeItems);
    await recomputeClientAdvanceClearanceTotalAmount(client, companyId, clearanceId);

    const clearance = await fetchFullAdvanceClearance(client, clearanceId, companyId);
    return { status: 200, body: { clearance } };
  });
});

// แก้ไขแบบลบทั้งหมดแล้วสร้างใหม่ (ไม่ใช่ diff-based เหมือน PR) — ปลอดภัยกว่าที่นี่เพราะ items ของใบเคลียร์
// ไม่มีตารางลูกใดๆ อ้างอิงกลับมาระหว่างที่ยังเป็น draft (ต่างจาก PR items ที่มี adjustments/po ผูกอยู่ได้
// หลัง approved) — เฉพาะ draft เท่านั้นที่แก้ได้ จึงไม่มีทาง "รายการถูกใช้ไปแล้ว" ให้ต้องกันการลบ
app.put('/api/customer/advance-clearances/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cRes = await client.query('SELECT status FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (cRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' }); }
    if (cRes.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'แก้ไขได้เฉพาะใบเคลียร์สถานะร่างเท่านั้น' }); }

    const { advanceVoucherId, clearanceDate, note, items } = req.body || {};
    if (!advanceVoucherId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'กรุณาเลือกใบเบิกเงินทดรองจ่ายต้นทาง' }); }
    const voucherRes = await client.query(
      `SELECT id, amount, status FROM client_payment_vouchers WHERE id=$1 AND company_id=$2 AND voucher_type='advance'`,
      [advanceVoucherId, companyId]
    );
    if (voucherRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ไม่พบใบเบิกเงินทดรองจ่ายนี้ในบริษัทของคุณ' }); }
    const voucher = voucherRes.rows[0];
    if (voucher.status !== 'approved') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'เคลียร์ได้เฉพาะใบเบิกเงินทดรองจ่ายที่อนุมัติแล้วเท่านั้น' }); }
    const liveRes = await client.query(
      `SELECT id FROM client_advance_clearances WHERE advance_voucher_id=$1 AND status NOT IN ('rejected','cancelled','voided') AND id<>$2`,
      [advanceVoucherId, id]
    );
    if (liveRes.rowCount > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ใบเบิกเงินทดรองจ่ายนี้มีใบเคลียร์ที่ยังดำเนินการอยู่แล้ว' }); }

    const itemsValidation = await validateAdvanceClearanceItemsInput(client, companyId, items);
    if (itemsValidation.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: itemsValidation.error }); }
    const { safeItems } = itemsValidation;
    if (safeItems.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'กรุณากรอกรายการค่าใช้จ่ายอย่างน้อย 1 รายการ' }); }

    await client.query('DELETE FROM client_advance_clearance_items WHERE clearance_id=$1', [id]);
    await insertAdvanceClearanceItems(client, companyId, id, safeItems);
    await client.query(
      `UPDATE client_advance_clearances SET advance_voucher_id=$1, clearance_date=$2, advance_amount=$3::numeric, note=$4 WHERE id=$5`,
      [advanceVoucherId, clearanceDate || getBangkokDateStr(), voucher.amount, (note || '').trim(), id]
    );
    await recomputeClientAdvanceClearanceTotalAmount(client, companyId, id);
    await client.query('COMMIT');
    res.json({ clearance: await fetchFullAdvanceClearance(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบเคลียร์เงินทดรองจ่ายไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/advance-clearances/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `advance-clearances-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' } };
    const c = r.rows[0];
    if (c.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะใบเคลียร์สถานะร่างเท่านั้น' } };

    // enforceAmountLimit:false — ยื่นแทนผู้สร้างไม่ใช่การอนุมัติวงเงิน (เหตุผลเดียวกับ PR/petty_cash/advance
    // submit) — docType='advance' ใช้ร่วมกับใบเบิกเงินทดรองจ่ายต้นทาง (ตกลงกับผู้ใช้แล้วว่าไม่แยก doc_type
    // ใหม่ — คนอนุมัติเบิกเงินทดรองจ่ายได้ ควรอนุมัติการเคลียร์ได้ด้วยเพราะเป็น flow เดียวกัน)
    if (req.customer.id !== c.created_by) {
      const permCheck = await canApprove(client, req.customer, 'advance', c.total_expense_amount, {
        companyId, originators: [c.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบเคลียร์นี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    const itemCount = await client.query('SELECT COUNT(*)::int AS n FROM client_advance_clearance_items WHERE clearance_id=$1', [id]);
    if (itemCount.rows[0].n === 0) return { status: 400, body: { error: 'ใบเคลียร์ต้องมีรายการอย่างน้อย 1 รายการ' } };

    const clearanceNo = await generateClearanceNo(client, companyId);
    await client.query(
      `UPDATE client_advance_clearances SET clearance_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [clearanceNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'advance_clearance', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });

    const clearance = await fetchFullAdvanceClearance(client, id, companyId);
    return { status: 200, body: { clearance } };
  });
});

// จุดที่โพสต์บัญชี+ออก 50 ทวิจริง — สรุปโมเดล (ดูรายละเอียดเต็มในแผนที่ตกลงกับผู้ใช้):
//   Cr 1150 = LEAST(advance_amount, total_expense_amount) เสมอ (ปิดยอดเท่าที่เคลียร์จริงเท่านั้น
//   ไม่ใช่เต็ม advance — ส่วนต่างที่เหลือ (ถ้ามี) ไปอยู่ที่ 2110 หรือค้างเป็น 1150 balance ที่เหลือ
//   รอ /settle) — ถ้า difference_amount=0 ข้ามสถานะไป 'settled' อัตโนมัติทันที (ไม่ต้อง /settle ต่อ)
app.post('/api/customer/advance-clearances/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `advance-clearances-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' } };
    const c = r.rows[0];
    if (c.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะใบเคลียร์ที่ยื่นแล้วเท่านั้น' } };

    const result = await canApprove(client, req.customer, 'advance', c.total_expense_amount, {
      companyId, originators: [c.created_by, c.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    // อ่าน items สดในทรานแซกชันเดียวกัน (ยังไม่มีทางเปลี่ยนไปจากตอน submit เพราะแก้ items ได้แค่ตอน draft
    // เท่านั้น — อ่านตรงนี้เพื่อสร้าง journal lines ไม่ใช่เพื่อ validate ซ้ำ) — has_vat_amount/has_wht เทียบ
    // เป็น boolean ฝั่ง SQL เสมอ (ไม่ใช้ Number() ตัดสินใจว่าจะสร้างบรรทัด journal หรือไม่)
    // ⚠️ has_vat_claimable ต้องเช็คคู่ has_tax_invoice=true เสมอ ไม่ใช่แค่ vat_amount>0 — ตอนนี้ CHECK
    // client_advance_clearance_items_tax_invoice_check ที่ระดับ DB บังคับ vat_amount=0 เมื่อ
    // has_tax_invoice=false อยู่แล้วก็จริง (ทำให้เงื่อนไขนี้ไม่พังในทางปฏิบัติตอนนี้) แต่โค้ดโพสต์บัญชี
    // ไม่ควรพึ่ง constraint ของตารางอื่นเป็นเกราะป้องกันเงียบๆ โดยไม่ประกาศเจตนาให้ชัดในโค้ดเอง — ถ้าวันหน้า
    // ผ่อน CHECK นั้น (เช่น รองรับใบกำกับอย่างย่อที่มี VAT แต่เครดิตไม่ได้) ภาษีซื้อที่เครดิตไม่ได้จะไหลเข้า
    // 1170 ทันทีโดยไม่มีอะไรเตือนถ้าเช็คแค่ vat_amount>0 เฉยๆ
    const itemsRes = await client.query(
      `SELECT id, description, expense_account_code, amount, vat_amount, has_tax_invoice,
              (has_tax_invoice AND vat_amount > 0) AS has_vat_claimable
       FROM client_advance_clearance_items WHERE clearance_id=$1 AND company_id=$2 ORDER BY idx`,
      [id, companyId]
    );
    const sumsRes = await client.query(
      `SELECT COALESCE(SUM(wht_amount),0) AS total_wht, (COALESCE(SUM(wht_amount),0) > 0) AS has_wht
       FROM client_advance_clearance_items WHERE clearance_id=$1 AND company_id=$2`,
      [id, companyId]
    );
    const clearAmountRes = await client.query('SELECT LEAST($1::numeric, $2::numeric) AS clear_amount', [c.advance_amount, c.total_expense_amount]);
    const clearAmount = clearAmountRes.rows[0].clear_amount;
    const diffCheck = await client.query(
      `SELECT (difference_amount > 0) AS is_overage, (difference_amount = 0) AS is_exact, difference_amount
       FROM client_advance_clearances WHERE id=$1`,
      [id]
    );

    const lines = [];
    for (const it of itemsRes.rows) {
      lines.push({ accountCode: it.expense_account_code, debitAmount: it.amount, creditAmount: 0, description: it.description });
      if (it.has_vat_claimable) {
        lines.push({ accountCode: ACCOUNT_CODE_VAT_INPUT, debitAmount: it.vat_amount, creditAmount: 0, description: `ภาษีซื้อ: ${it.description}` });
      }
    }
    if (sumsRes.rows[0].has_wht) {
      lines.push({ accountCode: ACCOUNT_CODE_WHT_PAYABLE, debitAmount: 0, creditAmount: sumsRes.rows[0].total_wht, description: 'ภาษีหัก ณ ที่จ่ายค้างนำส่ง' });
    }
    lines.push({ accountCode: ACCOUNT_CODE_ADVANCE_RECEIVABLE, debitAmount: 0, creditAmount: clearAmount, description: `ล้างยอดลูกหนี้เงินทดรองจ่าย ${c.clearance_no}` });
    if (diffCheck.rows[0].is_overage) {
      lines.push({ accountCode: ACCOUNT_CODE_EMPLOYEE_PAYABLE, debitAmount: 0, creditAmount: diffCheck.rows[0].difference_amount, description: `เจ้าหนี้พนักงาน (ส่วนต่างเบิกเพิ่ม) ${c.clearance_no}` });
    }
    // ไม่ต้องมีบรรทัดพิเศษกรณี shortfall (total_expense_amount < advance_amount) — 1150 ยังเหลือ balance
    // ค้างจากยอด original disbursement ลบ clearAmount ที่เพิ่ง Cr ไป รอ /settle มาล้างส่วนที่เหลือทีหลัง

    const nextStatus = diffCheck.rows[0].is_exact ? 'settled' : 'approved';
    await client.query(
      `UPDATE client_advance_clearances SET status=$1, approved_by=$2, approved_at=now() WHERE id=$3`,
      [nextStatus, req.customer.id, id]
    );

    await createClientJournalEntry(client, {
      companyId, entryDate: getBangkokDateStr(), description: `เคลียร์เงินทดรองจ่าย ${c.clearance_no}`,
      sourceType: 'advance_clearance', sourceId: id, createdBy: req.customer.id,
      lines,
    });

    // ออก 50 ทวิ 1 ใบต่อ 1 บรรทัดที่มี wht_amount>0 (WHERE ใน SQL ตรงๆ ไม่ใช่ filter ด้วย Number() ใน JS)
    // — wht_income_type_name_snapshot freeze ชื่อ ณ ตอนออกจริง ไม่ join สดกับ client_wht_income_types
    // (เหตุผลเดียวกับ payee_name/payee_tax_id ที่ freeze อยู่แล้วในตารางนี้)
    const whtItemsRes = await client.query(
      `SELECT i.id, i.description, i.wht_income_type_code, i.amount, i.wht_rate, i.wht_amount, i.payee_name, i.payee_tax_id, t.name_th AS type_name
       FROM client_advance_clearance_items i
       LEFT JOIN client_wht_income_types t ON t.code = i.wht_income_type_code
       WHERE i.clearance_id=$1 AND i.company_id=$2 AND i.wht_amount > 0
       ORDER BY i.idx`,
      [id, companyId]
    );
    const issuedCertNos = [];
    for (const item of whtItemsRes.rows) {
      const certNo = await generateWhtCertNo(client, companyId);
      // income_type_desc = คำอธิบายรายการที่ผู้ใช้กรอกเอง (item.description) — คนละความหมายกับ
      // wht_income_type_name_snapshot ที่เป็นชื่อประเภทเงินได้ตามกฎหมาย (จาก client_wht_income_types)
      // เดิมสองคอลัมน์นี้ดันเก็บค่าเดียวกัน (item.type_name) ทำให้ข้อมูลซ้ำที่เสี่ยงหลุดจากกันได้ในอนาคต
      // ถ้าแก้ไขคนละจุด — แยกแหล่งที่มาให้ชัดเจนตั้งแต่ตอนออกจริง
      await client.query(
        `INSERT INTO client_wht_certificates
           (company_id, cert_no, source_type, source_id, payee_name, payee_tax_id, payment_date, income_type_desc,
            gross_amount, wht_rate, wht_amount, wht_income_type_code, wht_income_type_name_snapshot, issued_by, issued_at)
         VALUES ($1,$2,'advance_clearance_item',$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11,$12,$13,now())`,
        [companyId, certNo, item.id, item.payee_name, item.payee_tax_id, getBangkokDateStr(), item.description,
         item.amount, item.wht_rate, item.wht_amount, item.wht_income_type_code, item.type_name || '', req.customer.id]
      );
      issuedCertNos.push(certNo);
    }

    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'advance_clearance', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: nextStatus, performedBy: req.customer.id,
      isOverride: result.isOverride, reason: `${reason}${issuedCertNos.length ? ` (ออก 50 ทวิ ${issuedCertNos.length} ใบ: ${issuedCertNos.join(', ')})` : ''}`,
    });

    const clearance = await fetchFullAdvanceClearance(client, id, companyId);
    return { status: 200, body: { clearance, issuedWhtCertificates: issuedCertNos } };
  });
});

// บันทึกการจ่าย/รับเงินส่วนต่างจริง (เฉพาะเคสที่ /approve ไม่ได้ข้ามไป settled อัตโนมัติ คือ difference<>0
// เท่านั้น) — can_settle_cash (migration 0007) OR super_user เสมอ (คนละสิทธิ์กับ approve ตาม CLAUDE.md
// ข้อ 14 — คนยืนยันยอดค่าใช้จ่ายถูกต้อง ไม่ควรเป็นคนเดียวกับคนปล่อย/รับเงินจริงเสมอไป)
app.post('/api/customer/advance-clearances/:id/settle', requireCustomerAuth, async (req, res) => {
  if (req.customer.role !== 'super_user' && req.customer.can_settle_cash !== true) return res.status(403).json({ error: 'ไม่มีสิทธิ์บันทึกการชำระส่วนต่าง' });
  const { settlementDate, settlementChannel, settlementRef } = req.body || {};
  if (!settlementDate || !/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) return res.status(400).json({ error: 'กรุณาระบุวันที่ชำระส่วนต่างให้ถูกต้อง (YYYY-MM-DD)' });
  if (!['cash', 'transfer'].includes(settlementChannel)) return res.status(400).json({ error: 'กรุณาระบุช่องทางชำระให้ถูกต้อง (cash หรือ transfer)' });
  // ปฏิเสธวันที่ในอนาคต — เทียบ "วันนี้" ตาม timezone Asia/Bangkok เสมอ (getBangkokDateStr(), ห้ามใช้
  // เวลาเครื่อง server) เปรียบเทียบ string 'YYYY-MM-DD' ตรงๆ ปลอดภัย (lexicographic = chronological
  // สำหรับ format นี้) ไม่ต้องผ่าน Date object เลย
  if (settlementDate > getBangkokDateStr()) return res.status(400).json({ error: 'วันที่ชำระส่วนต่างเป็นวันที่ในอนาคตไม่ได้' });

  await withIdempotency(req, res, `advance-clearances-settle:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' } };
    const c = r.rows[0];
    // เรียกได้เฉพาะ status='approved' เท่านั้น — เรียกซ้ำ (หลัง settled ไปแล้ว) ต้อง 409 เสมอ นอกเหนือจาก
    // กลไก withIdempotency (ที่คุ้มครองแค่ "คีย์เดิมซ้ำ" ไม่คุ้มครอง "เรียกซ้ำด้วยคีย์ใหม่หลัง state
    // เปลี่ยนไปแล้ว") — ถึงจุดนี้ status='approved' รับประกันแล้วว่า difference_amount<>0 แน่นอน (ไม่งั้น
    // /approve จะข้ามไป settled อัตโนมัติไปแล้ว) ไม่ต้องเช็คซ้ำ
    if (c.status !== 'approved') {
      return { status: 409, body: { error: 'บันทึกชำระส่วนต่างได้เฉพาะใบเคลียร์สถานะอนุมัติแล้วเท่านั้น (ใบที่ไม่มีส่วนต่างจะเป็นสถานะ settled ไปแล้วตั้งแต่ตอนอนุมัติ)' } };
    }
    // ปฏิเสธวันที่ก่อนวันที่อนุมัติใบเคลียร์นี้ — เทียบฝั่ง SQL ด้วยการแปลง approved_at (TIMESTAMPTZ) เป็น
    // วันที่ตาม timezone Asia/Bangkok ก่อนเทียบเสมอ (ไม่ใช่เทียบ Date object ใน JS ตรงๆ ซึ่งเสี่ยงเทียบผิด
    // timezone ถ้า server ไม่ได้ตั้ง TZ=UTC ไว้ชัดเจน)
    const dateCheck = await client.query(
      `SELECT ($1::date < (approved_at AT TIME ZONE 'Asia/Bangkok')::date) AS is_before_approved
       FROM client_advance_clearances WHERE id=$2`,
      [settlementDate, id]
    );
    if (dateCheck.rows[0].is_before_approved) {
      return { status: 400, body: { error: 'วันที่ชำระส่วนต่างต้องไม่ก่อนวันที่อนุมัติใบเคลียร์นี้' } };
    }

    const diffCheck = await client.query(
      `SELECT (difference_amount > 0) AS is_overage, ABS(difference_amount) AS diff_abs
       FROM client_advance_clearances WHERE id=$1`,
      [id]
    );

    await client.query(
      `UPDATE client_advance_clearances SET status='settled', settlement_date=$1, settlement_channel=$2, settlement_ref=$3,
         settlement_recorded_by=$4, settlement_recorded_at=now() WHERE id=$5`,
      [settlementDate, settlementChannel, (settlementRef || '').trim(), req.customer.id, id]
    );

    const lines = diffCheck.rows[0].is_overage
      ? [
          { accountCode: ACCOUNT_CODE_EMPLOYEE_PAYABLE, debitAmount: diffCheck.rows[0].diff_abs, creditAmount: 0, description: 'จ่ายส่วนต่างเบิกเพิ่มให้พนักงาน' },
          { accountCode: ACCOUNT_CODE_CASH, debitAmount: 0, creditAmount: diffCheck.rows[0].diff_abs, description: 'จ่ายส่วนต่างเบิกเพิ่ม' },
        ]
      : [
          { accountCode: ACCOUNT_CODE_CASH, debitAmount: diffCheck.rows[0].diff_abs, creditAmount: 0, description: 'รับคืนเงินทดรองจ่ายส่วนต่าง' },
          { accountCode: ACCOUNT_CODE_ADVANCE_RECEIVABLE, debitAmount: 0, creditAmount: diffCheck.rows[0].diff_abs, description: 'ล้างยอดลูกหนี้เงินทดรองจ่ายส่วนที่เหลือ' },
        ];

    await createClientJournalEntry(client, {
      companyId, entryDate: settlementDate, description: `ชำระส่วนต่างเคลียร์เงินทดรองจ่าย ${c.clearance_no}`,
      sourceType: 'advance_clearance', sourceId: id, createdBy: req.customer.id,
      lines,
    });

    await writeAuditLog(client, {
      companyId, docType: 'advance_clearance', docId: id, action: 'settle',
      fromStatus: 'approved', toStatus: 'settled', performedBy: req.customer.id,
    });

    const clearance = await fetchFullAdvanceClearance(client, id, companyId);
    return { status: 200, body: { clearance } };
  });
});

app.post('/api/customer/advance-clearances/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' }); }
    const c = r.rows[0];
    if (c.status !== 'submitted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะใบเคลียร์ที่ยื่นแล้วเท่านั้น' }); }
    const permCheck = await canApprove(client, req.customer, 'advance', c.total_expense_amount, {
      companyId, originators: [c.created_by, c.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: permCheck.message, code: permCheck.code }); }
    await client.query(`UPDATE client_advance_clearances SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'advance_clearance', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    res.json({ clearance: await fetchFullAdvanceClearance(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบเคลียร์เงินทดรองจ่ายไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ยกเลิกได้เฉพาะ draft/submitted (ก่อนมีเงินเคลื่อนไหวจริง) — approved/settled แล้วยังไม่มี /void ในรอบนี้
// (ดู known-limitations — รอคำตอบเรื่องการยกเลิก 50 ทวิ ที่ออกไปแล้วจากผู้ใช้ก่อน)
app.post('/api/customer/advance-clearances/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_advance_clearances WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเคลียร์เงินทดรองจ่าย' }); }
    const c = r.rows[0];
    if (!['draft', 'submitted'].includes(c.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ไม่สามารถยกเลิกใบเคลียร์ในสถานะนี้ได้' }); }
    const isOwner = req.customer.id === c.created_by || (c.submitted_by != null && req.customer.id === c.submitted_by);
    let cancelIsOverride = false;
    if (!isOwner) {
      const permCheck = await canApprove(client, req.customer, 'advance', c.total_expense_amount, {
        companyId, originators: [c.created_by, c.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบเคลียร์นี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
      cancelIsOverride = permCheck.isOverride;
    }
    await client.query(`UPDATE client_advance_clearances SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'advance_clearance', docId: id, action: 'cancel',
      fromStatus: c.status, toStatus: 'cancelled', performedBy: req.customer.id, isOverride: cancelIsOverride,
    });
    await client.query('COMMIT');
    res.json({ clearance: await fetchFullAdvanceClearance(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบเคลียร์เงินทดรองจ่ายไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- ใบเติมเงินกองทุนเงินสดย่อย (petty cash replenishments) ----------------
function serializeReplenishment(row) {
  return {
    id: row.id,
    replenishNo: row.replenish_no,
    fundId: row.fund_id,
    fundName: row.fund_name || null,
    amount: Number(row.amount),
    replenishDate: row.replenish_date,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
const CLIENT_REPLENISHMENT_SELECT = `
  SELECT r.id, r.replenish_no, r.fund_id, f.name AS fund_name, r.amount,
    to_char(r.replenish_date,'YYYY-MM-DD') AS replenish_date, r.status,
    r.submitted_by, r.submitted_at, r.approved_by, r.approved_at, r.note, r.created_by, r.created_at
  FROM client_petty_cash_replenishments r
  LEFT JOIN client_petty_cash_funds f ON f.id = r.fund_id`;

async function fetchReplenishment(dbClient, id, companyId) {
  const r = await dbClient.query(`${CLIENT_REPLENISHMENT_SELECT} WHERE r.id=$1 AND r.company_id=$2`, [id, companyId]);
  if (r.rowCount === 0) return null;
  return serializeReplenishment(r.rows[0]);
}

app.get('/api/customer/petty-cash-replenishments', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { status, fundId } = req.query;
  const conditions = ['r.company_id=$1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`r.status=$${params.length}`); }
  if (fundId) { params.push(parseInt(fundId, 10)); conditions.push(`r.fund_id=$${params.length}`); }
  const result = await pool.query(`${CLIENT_REPLENISHMENT_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY r.id DESC`, params);
  res.json({ replenishments: result.rows.map(serializeReplenishment) });
});

app.get('/api/customer/petty-cash-replenishments/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const replenishment = await fetchReplenishment(pool, id, companyId);
  if (!replenishment) return res.status(404).json({ error: 'ไม่พบใบเติมเงินกองทุน' });
  res.json({ replenishment });
});

app.post('/api/customer/petty-cash-replenishments', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, 'petty-cash-replenishments-create', async (client) => {
    const companyId = req.customer.company_id;
    const { fundId, amount, note } = req.body || {};
    const safeAmount = parsePositiveNumericValue(amount);
    if (safeAmount === null) return { status: 400, body: { error: 'กรุณาระบุจำนวนเงินให้ถูกต้อง' } };
    if (!fundId) return { status: 400, body: { error: 'กรุณาเลือกกองทุนเงินสดย่อย' } };
    const fund = await client.query('SELECT 1 FROM client_petty_cash_funds WHERE id=$1 AND company_id=$2 AND is_active=true', [fundId, companyId]);
    if (fund.rowCount === 0) return { status: 400, body: { error: 'ไม่พบกองทุนนี้ในบริษัทของคุณ หรือกองทุนถูกปิดใช้งานแล้ว' } };

    const insert = await client.query(
      `INSERT INTO client_petty_cash_replenishments (company_id, fund_id, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, fundId, safeAmount, (note || '').trim(), req.customer.id]
    );
    const replenishment = await fetchReplenishment(client, insert.rows[0].id, companyId);
    return { status: 200, body: { replenishment } };
  });
});

app.put('/api/customer/petty-cash-replenishments/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rRes = await client.query('SELECT status FROM client_petty_cash_replenishments WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (rRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเติมเงินกองทุน' }); }
    if (rRes.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'แก้ไขได้เฉพาะใบเติมเงินสถานะร่างเท่านั้น' }); }

    const { fundId, amount, note } = req.body || {};
    const safeAmount = parsePositiveNumericValue(amount);
    if (safeAmount === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'กรุณาระบุจำนวนเงินให้ถูกต้อง' }); }
    if (!fundId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'กรุณาเลือกกองทุนเงินสดย่อย' }); }
    const fund = await client.query('SELECT 1 FROM client_petty_cash_funds WHERE id=$1 AND company_id=$2 AND is_active=true', [fundId, companyId]);
    if (fund.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ไม่พบกองทุนนี้ในบริษัทของคุณ หรือกองทุนถูกปิดใช้งานแล้ว' }); }

    await client.query(`UPDATE client_petty_cash_replenishments SET fund_id=$1, amount=$2, note=$3 WHERE id=$4`, [fundId, safeAmount, (note || '').trim(), id]);
    await client.query('COMMIT');
    res.json({ replenishment: await fetchReplenishment(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'แก้ไขใบเติมเงินกองทุนไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

async function generateReplenishNo(client, companyId) {
  const year = getBangkokYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextDocumentSeq(client, companyId, 'petty_cash_replenishment');
    const no = `PCR-${year}-` + String(seq).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_petty_cash_replenishments WHERE company_id=$1 AND replenish_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบเติมเงินกองทุนได้');
}

app.post('/api/customer/petty-cash-replenishments/:id/submit', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `petty-cash-replenishments-submit:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_petty_cash_replenishments WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเติมเงินกองทุน' } };
    const rep = r.rows[0];
    if (rep.status !== 'draft') return { status: 409, body: { error: 'ยื่นได้เฉพาะใบเติมเงินสถานะร่างเท่านั้น' } };

    if (req.customer.id !== rep.created_by) {
      const permCheck = await canApprove(client, req.customer, 'petty_cash', rep.amount, {
        companyId, originators: [rep.created_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        return { status: 403, body: { error: 'ไม่มีสิทธิ์ยื่นใบเติมเงินกองทุนนี้ (ต้องเป็นผู้สร้าง หรือมีสิทธิ์อนุมัติ)', code: permCheck.code } };
      }
    }

    const replenishNo = await generateReplenishNo(client, companyId);
    await client.query(
      `UPDATE client_petty_cash_replenishments SET replenish_no=$1, status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$3`,
      [replenishNo, req.customer.id, id]
    );
    await writeAuditLog(client, {
      companyId, docType: 'petty_cash_replenishment', docId: id, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted', performedBy: req.customer.id,
    });

    const replenishment = await fetchReplenishment(client, id, companyId);
    return { status: 200, body: { replenishment } };
  });
});

app.post('/api/customer/petty-cash-replenishments/:id/approve', requireCustomerAuth, async (req, res) => {
  await withIdempotency(req, res, `petty-cash-replenishments-approve:${req.params.id}`, async (client) => {
    const id = parseInt(req.params.id, 10);
    const companyId = req.customer.company_id;
    const r = await client.query('SELECT * FROM client_petty_cash_replenishments WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) return { status: 404, body: { error: 'ไม่พบใบเติมเงินกองทุน' } };
    const rep = r.rows[0];
    if (rep.status !== 'submitted') return { status: 409, body: { error: 'อนุมัติได้เฉพาะใบเติมเงินที่ยื่นแล้วเท่านั้น' } };

    const result = await canApprove(client, req.customer, 'petty_cash', rep.amount, {
      companyId, originators: [rep.created_by, rep.submitted_by],
    });
    if (!result.allowed) return { status: 403, body: { error: result.message, code: result.code } };

    await client.query(
      `UPDATE client_petty_cash_replenishments SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
      [req.customer.id, id]
    );

    // Dr เงินสดย่อย / Cr เงินสด — เติมเงินเข้ากองทุนจากเงินสดบริษัท
    await createClientJournalEntry(client, {
      companyId, entryDate: getBangkokDateStr(), description: `เติมเงินกองทุนเงินสดย่อย ${rep.replenish_no}`,
      sourceType: 'petty_cash_replenishment', sourceId: id, createdBy: req.customer.id,
      lines: [
        { accountCode: ACCOUNT_CODE_PETTY_CASH, debitAmount: rep.amount, creditAmount: 0, description: 'เงินสดย่อย' },
        { accountCode: ACCOUNT_CODE_CASH, debitAmount: 0, creditAmount: rep.amount, description: 'เงินสด' },
      ],
    });

    const reason = result.isOverride
      ? 'อนุมัติโดย super_user (override ข้ามการตรวจสอบ rule/เพดานปกติ)'
      : `อนุมัติผ่าน rule #${result.ruleId} (เพดาน ${result.maxAmountRaw} บาท)`;
    await writeAuditLog(client, {
      companyId, docType: 'petty_cash_replenishment', docId: id, action: 'approve',
      fromStatus: 'submitted', toStatus: 'approved', performedBy: req.customer.id,
      isOverride: result.isOverride, reason,
    });

    const replenishment = await fetchReplenishment(client, id, companyId);
    return { status: 200, body: { replenishment } };
  });
});

// ⚠️ ไม่มีคอลัมน์ rejected_reason บนตารางนี้ (ต่างจาก client_payment_vouchers) — ช่องโหว่ที่พบระหว่างเขียน
// route นี้ ไม่ได้แก้เองเพราะต้องเพิ่มคอลัมน์ผ่าน migration ใหม่ (ต้องผ่านขั้นตอนอนุมัติก่อน) เหตุผลที่ยัง
// ปลอดภัยพอใช้งานได้ตอนนี้: writeAuditLog บันทึก reason ไว้ใน client_document_audit_log อยู่แล้วเสมอ
// (ดูได้ผ่าน audit trail) เพียงแต่ไม่มีคอลัมน์ผูกตรงบนแถวเอกสารเหมือนใบเบิกเงิน — แจ้งผู้ใช้ให้ตัดสินใจว่า
// ต้องการเพิ่มคอลัมน์นี้เป็น migration ใหม่หรือไม่
app.post('/api/customer/petty-cash-replenishments/:id/reject', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการปฏิเสธ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_petty_cash_replenishments WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเติมเงินกองทุน' }); }
    const rep = r.rows[0];
    if (rep.status !== 'submitted') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ปฏิเสธได้เฉพาะใบเติมเงินที่ยื่นแล้วเท่านั้น' }); }

    const permCheck = await canApprove(client, req.customer, 'petty_cash', rep.amount, {
      companyId, originators: [rep.created_by, rep.submitted_by],
    }, { enforceAmountLimit: false });
    if (!permCheck.allowed) { await client.query('ROLLBACK'); return res.status(403).json({ error: permCheck.message, code: permCheck.code }); }

    // เขียน rejected_reason ลงคอลัมน์บนแถวเอกสารเองด้วย (เดิมพึ่ง audit log อย่างเดียว — มีอยู่จริงแต่ไม่
    // สะดวกเท่าคอลัมน์ตรงบนแถวเหมือน client_payment_vouchers.rejected_reason) — column นี้มีอยู่แล้วตั้งแต่
    // migration 0003 (`rejected_reason TEXT NOT NULL DEFAULT ''`) แค่ไม่เคยมี route ไหนเขียนลงไปเลย
    await client.query(`UPDATE client_petty_cash_replenishments SET status='rejected', rejected_reason=$1 WHERE id=$2`, [reason.trim(), id]);
    await writeAuditLog(client, {
      companyId, docType: 'petty_cash_replenishment', docId: id, action: 'reject',
      fromStatus: 'submitted', toStatus: 'rejected', performedBy: req.customer.id,
      isOverride: permCheck.isOverride, reason: reason.trim(),
    });
    await client.query('COMMIT');
    res.json({ replenishment: await fetchReplenishment(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ปฏิเสธใบเติมเงินกองทุนไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.post('/api/customer/petty-cash-replenishments/:id/cancel', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM client_petty_cash_replenishments WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId]);
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบเติมเงินกองทุน' }); }
    const rep = r.rows[0];
    if (!['draft', 'submitted'].includes(rep.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกใบเติมเงินกองทุนในสถานะนี้ได้' });
    }
    const isOwner = req.customer.id === rep.created_by || (rep.submitted_by != null && req.customer.id === rep.submitted_by);
    let cancelIsOverride = false;
    if (!isOwner) {
      const permCheck = await canApprove(client, req.customer, 'petty_cash', rep.amount, {
        companyId, originators: [rep.created_by, rep.submitted_by],
      }, { enforceAmountLimit: false });
      if (!permCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกใบเติมเงินกองทุนนี้ (ต้องเป็นผู้สร้าง/ผู้ยื่น หรือมีสิทธิ์อนุมัติ)', code: permCheck.code });
      }
      cancelIsOverride = permCheck.isOverride;
    }
    await client.query(`UPDATE client_petty_cash_replenishments SET status='cancelled' WHERE id=$1`, [id]);
    await writeAuditLog(client, {
      companyId, docType: 'petty_cash_replenishment', docId: id, action: 'cancel',
      fromStatus: rep.status, toStatus: 'cancelled', performedBy: req.customer.id, isOverride: cancelIsOverride,
    });
    await client.query('COMMIT');
    res.json({ replenishment: await fetchReplenishment(pool, id, companyId) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'ยกเลิกใบเติมเงินกองทุนไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

// ---------------- Customer: client ledger — ใบเสนอราคา (Quotations, customer → their own client)
// ---------------- Not the same system as the top-level /api/admin/quotations routes elsewhere in
// this file (SiteReq → customer company, the opposite direction) — see schema.sql's client_quotations
// comment. No journal entry posted — a quotation isn't revenue until accepted/converted, and there's
// no "convert to revenue" flow yet (same decision made for this exact question in an earlier phase).
function serializeQuotation(row) {
  return {
    id: row.id, quotationNo: row.quotation_no, projectId: row.project_id, projectName: row.project_name || null,
    clientName: row.client_name, issueDate: row.issue_date, validUntil: row.valid_until,
    amount: Number(row.amount), status: row.status, note: row.note,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
const CLIENT_QUOTATION_SELECT = `
  SELECT q.id, q.quotation_no, q.project_id, cp.name AS project_name,
    q.client_name, to_char(q.issue_date,'YYYY-MM-DD') AS issue_date, to_char(q.valid_until,'YYYY-MM-DD') AS valid_until,
    q.amount, q.status, q.note, q.created_by, q.created_at
  FROM client_quotations q
  LEFT JOIN client_projects cp ON cp.id = q.project_id`;

async function generateClientQuotationNo(client, companyId) {
  const year = new Date().getFullYear() + 543;
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await client.query('SELECT COUNT(*)::int AS n FROM client_quotations WHERE company_id=$1', [companyId]);
    const no = `QT-${year}-` + String(countRes.rows[0].n + 1 + attempt).padStart(4, '0');
    const exists = await client.query('SELECT 1 FROM client_quotations WHERE company_id=$1 AND quotation_no=$2', [companyId, no]);
    if (exists.rowCount === 0) return no;
  }
  throw new Error('ไม่สามารถสร้างเลขที่ใบเสนอราคาได้');
}

app.get('/api/customer/quotations', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const r = await pool.query(`${CLIENT_QUOTATION_SELECT} WHERE q.company_id=$1 ORDER BY q.id DESC`, [companyId]);
  res.json({ quotations: r.rows.map(serializeQuotation) });
});

app.get('/api/customer/quotations/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(`${CLIENT_QUOTATION_SELECT} WHERE q.id=$1 AND q.company_id=$2`, [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' });
  res.json({ quotation: serializeQuotation(r.rows[0]) });
});

app.post('/api/customer/quotations', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { quotationNo, projectId, clientName, issueDate, validUntil, amount, status, note } = req.body || {};
  if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อลูกค้า' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'กรุณากรอกยอดเสนอราคา' });
  const allowedStatus = ['draft', 'sent', 'accepted', 'declined'];
  const safeStatus = allowedStatus.includes(status) ? status : 'draft';

  if (projectId) {
    const proj = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) return res.status(400).json({ error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const trimmedNo = (quotationNo || '').trim();
    const finalNo = trimmedNo || await generateClientQuotationNo(client, companyId);
    const dup = await client.query('SELECT 1 FROM client_quotations WHERE company_id=$1 AND quotation_no=$2', [companyId, finalNo]);
    if (dup.rowCount > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'เลขที่ใบเสนอราคานี้มีอยู่แล้ว' }); }
    const insert = await client.query(
      `INSERT INTO client_quotations (company_id, quotation_no, project_id, client_name, issue_date, valid_until, amount, status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [companyId, finalNo, projectId || null, clientName.trim(), issueDate || new Date().toISOString().slice(0, 10),
       validUntil || null, Number(amount), safeStatus, (note || '').trim(), req.customer.id]
    );
    const qId = insert.rows[0].id;
    await client.query('COMMIT');
    const r = await pool.query(`${CLIENT_QUOTATION_SELECT} WHERE q.id=$1`, [qId]);
    res.json({ quotation: serializeQuotation(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'บันทึกใบเสนอราคาไม่สำเร็จ' });
  } finally {
    client.release();
  }
});

app.put('/api/customer/quotations/:id/status', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const companyId = req.customer.company_id;
  const { status } = req.body || {};
  const allowedStatus = ['draft', 'sent', 'accepted', 'declined'];
  if (!allowedStatus.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  const r = await pool.query(
    'UPDATE client_quotations SET status=$1 WHERE id=$2 AND company_id=$3 RETURNING id',
    [status, id, companyId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' });
  const full = await pool.query(`${CLIENT_QUOTATION_SELECT} WHERE q.id=$1`, [id]);
  res.json({ quotation: serializeQuotation(full.rows[0]) });
});

app.delete('/api/customer/quotations/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('DELETE FROM client_quotations WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'ไม่พบใบเสนอราคา' });
  res.json({ ok: true });
});

// ---------------- Customer: client ledger — เอกสารทั่วไป (สัญญา/ใบส่งของ/ใบรับรองผลงาน) ----------------
// "Group A" — see schema.sql's client_documents comment for why only these 3 types live here
// (billing/tax_invoice/receipt/wht deliberately do not — see the client_revenue-attachment and
// รับชำระเงิน routes elsewhere). No journal posting — pure paperwork, no money movement.
const CLIENT_DOCUMENTS_DIR = path.join(__dirname, 'uploads', 'client-documents');
fs.mkdirSync(CLIENT_DOCUMENTS_DIR, { recursive: true });
const ALLOWED_CLIENT_DOC_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const CLIENT_DOC_TYPES = ['contract', 'delivery', 'certification'];
const clientDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CLIENT_DOCUMENTS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_CLIENT_DOC_MIME.has(file.mimetype)),
});
function uploadClientDocMiddleware(req, res, next) {
  clientDocUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ (รองรับ jpg, png, webp, pdf)' });
    next();
  });
}
function serializeClientDocument(row) {
  return {
    id: row.id, docType: row.doc_type, docName: row.doc_name, projectId: row.project_id, projectName: row.project_name || null,
    docDate: row.doc_date, expiryDate: row.expiry_date, hasFile: !!row.file_attachment, note: row.note,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}
const CLIENT_DOCUMENT_SELECT = `
  SELECT cd.id, cd.doc_type, cd.doc_name, cd.project_id, cp.name AS project_name,
    to_char(cd.doc_date,'YYYY-MM-DD') AS doc_date, to_char(cd.expiry_date,'YYYY-MM-DD') AS expiry_date,
    cd.file_attachment, cd.note, cd.created_by, cd.created_at
  FROM client_documents cd
  LEFT JOIN client_projects cp ON cp.id = cd.project_id`;

app.get('/api/customer/documents', requireCustomerAuth, async (req, res) => {
  const r = await pool.query(`${CLIENT_DOCUMENT_SELECT} WHERE cd.company_id=$1 ORDER BY cd.id DESC`, [req.customer.company_id]);
  res.json({ documents: r.rows.map(serializeClientDocument) });
});

app.post('/api/customer/documents', requireCustomerAuth, uploadClientDocMiddleware, async (req, res) => {
  const companyId = req.customer.company_id;
  const { docType, docName, projectId, docDate, expiryDate, note } = req.body || {};
  if (!docType || !CLIENT_DOC_TYPES.includes(docType)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ประเภทเอกสารไม่ถูกต้อง' });
  }
  if (!docName || !docName.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'กรุณากรอกชื่อเอกสาร' });
  }
  if (projectId) {
    const proj = await pool.query('SELECT 1 FROM client_projects WHERE id=$1 AND company_id=$2', [projectId, companyId]);
    if (proj.rowCount === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'ไม่พบโครงการนี้ในบริษัทของคุณ' });
    }
  }
  const ins = await pool.query(
    `INSERT INTO client_documents (company_id, doc_type, doc_name, project_id, doc_date, expiry_date, file_attachment, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [companyId, docType, docName.trim(), projectId || null, docDate || new Date().toISOString().slice(0, 10),
     expiryDate || null, req.file ? req.file.filename : null, (note || '').trim(), req.customer.id]
  );
  const r = await pool.query(`${CLIENT_DOCUMENT_SELECT} WHERE cd.id=$1`, [ins.rows[0].id]);
  res.json({ document: serializeClientDocument(r.rows[0]) });
});

app.get('/api/customer/documents/:id/file', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT file_attachment FROM client_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (r.rowCount === 0 || !r.rows[0].file_attachment) return res.status(404).json({ error: 'ไม่พบไฟล์เอกสาร' });
  res.sendFile(path.join(CLIENT_DOCUMENTS_DIR, r.rows[0].file_attachment));
});

app.delete('/api/customer/documents/:id', requireCustomerAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await pool.query('SELECT file_attachment FROM client_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
  await pool.query('DELETE FROM client_documents WHERE id=$1 AND company_id=$2', [id, req.customer.company_id]);
  if (existing.rows[0].file_attachment) fs.unlink(path.join(CLIENT_DOCUMENTS_DIR, existing.rows[0].file_attachment), () => {});
  res.json({ ok: true });
});

// ---------------- Customer: client ledger — สมุดรายวัน (general journal) ----------------
// Read-only listing across EVERY client-ledger module built so far (project costs, office
// expenses, revenue, retention, labor) — every journal_entries header with its lines nested
// underneath, filterable by date range / source_type / project. Always scoped by
// req.customer.company_id, never a client-supplied value — the same isolation guarantee every
// other route in this section relies on.
app.get('/api/customer/journal-entries', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { from, to, sourceType, sourceId, projectId } = req.query || {};
  const clauses = ['je.company_id=$1'];
  const vals = [companyId];
  if (from) { vals.push(from); clauses.push(`je.entry_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`je.entry_date <= $${vals.length}`); }
  if (sourceType) { vals.push(sourceType); clauses.push(`je.source_type = $${vals.length}`); }
  // sourceId ใช้คู่กับ sourceType เสมอ (ไม่กรองแค่ sourceId เดี่ยวๆ เพราะ id ไม่ unique ข้าม source_type
  // ต่างตาราง — เอกสารคนละประเภทเป็น id ซ้ำกันได้) — ใช้ตอนหน้า detail เอกสารหนึ่งใบต้องการดู journal
  // เฉพาะของใบนั้น ไม่ใช่ทุกใบของ source_type เดียวกัน
  if (sourceId && sourceType) { vals.push(parseInt(sourceId, 10)); clauses.push(`je.source_id = $${vals.length}`); }
  if (projectId) { vals.push(parseInt(projectId, 10)); clauses.push(`je.project_id = $${vals.length}`); }
  const where = clauses.join(' AND ');

  const entriesRes = await pool.query(
    `SELECT je.id, to_char(je.entry_date,'YYYY-MM-DD') AS "entryDate", je.description,
       je.source_type AS "sourceType", je.source_id AS "sourceId", je.project_id AS "projectId",
       je.created_by AS "createdBy", c.name AS "createdByName", je.created_at AS "createdAt"
     FROM client_journal_entries je
     LEFT JOIN customers c ON c.id = je.created_by
     WHERE ${where}
     ORDER BY je.entry_date DESC, je.id DESC`, vals
  );
  const ids = entriesRes.rows.map(r => r.id);
  const linesByEntry = {};
  if (ids.length) {
    const linesRes = await pool.query(
      `SELECT jel.journal_entry_id AS "journalEntryId", jel.account_code AS "accountCode",
         coa.name AS "accountName", jel.debit_amount AS "debitAmount", jel.credit_amount AS "creditAmount",
         jel.description
       FROM client_journal_entry_lines jel
       LEFT JOIN client_chart_of_accounts coa ON coa.company_id = jel.company_id AND coa.code = jel.account_code
       WHERE jel.company_id=$1 AND jel.journal_entry_id = ANY($2)
       ORDER BY jel.id`, [companyId, ids]
    );
    for (const l of linesRes.rows) {
      (linesByEntry[l.journalEntryId] ||= []).push(l);
    }
  }
  const entries = entriesRes.rows.map(e => {
    const lines = linesByEntry[e.id] || [];
    const totalDebit = lines.reduce((sum, l) => sum + Number(l.debitAmount), 0);
    const totalCredit = lines.reduce((sum, l) => sum + Number(l.creditAmount), 0);
    return { ...e, lines, totalDebit, totalCredit };
  });
  res.json({ entries });
});

// ทั่วไปข้ามทุก doc_type — หน้า detail ของเอกสารไหนก็เรียกใช้ endpoint เดียวกันนี้ได้เสมอ (docType+docId
// คู่เดียวกับที่ writeAuditLog() ใช้เขียนตอนแรก) ไม่มี endpoint เฉพาะทางแยกรายเอกสารมาก่อนเลย — ไม่ gate
// สิทธิ์เพิ่มเติมนอกจาก company scope (ดู audit trail ได้ทุกคนที่ login แล้ว เหมือน GET เอกสารเอง)
app.get('/api/customer/audit-log', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const { docType, docId } = req.query || {};
  if (!docType || !docId) return res.status(400).json({ error: 'ต้องระบุ docType และ docId' });
  const r = await pool.query(
    `SELECT l.id, l.action, l.from_status AS "fromStatus", l.to_status AS "toStatus",
       l.performed_by AS "performedBy", c.name AS "performedByName", l.is_override AS "isOverride",
       l.reason, l.created_at AS "createdAt"
     FROM client_document_audit_log l
     LEFT JOIN customers c ON c.id = l.performed_by
     WHERE l.company_id=$1 AND l.doc_type=$2 AND l.doc_id=$3
     ORDER BY l.id`,
    [companyId, docType, parseInt(docId, 10)]
  );
  res.json({ logs: r.rows });
});

// ---------------- Customer: client ledger — financial statements (phase 3) ----------------
// Every report below derives ENTIRELY from client_journal_entry_lines/client_journal_entries —
// no separate query against client_project_costs/client_revenue/client_labor_costs — so there is
// exactly one source of truth for "what does this company's books say" and the three statements
// can never disagree with each other or with สมุดรายวัน (item 5) about a balance.
//
// Sums matching entry lines against the FULL account list via a LEFT JOIN onto a pre-aggregated
// subquery (not a plain LEFT JOIN with the date filter in WHERE) — putting a date filter in WHERE
// on a LEFT JOIN would silently drop accounts that have zero lines *within that range* from the
// result entirely (their only matching row gets filtered out), instead of correctly showing them
// with a zero balance. Pre-aggregating first and then LEFT JOINing the full chart of accounts onto
// it keeps every active account in the result regardless of activity in the requested range.
async function computeClientAccountBalances(companyId, { from, to, categories } = {}) {
  const vals = [companyId];
  const dateClauses = [];
  if (from) { vals.push(from); dateClauses.push(`je.entry_date >= $${vals.length}`); }
  if (to) { vals.push(to); dateClauses.push(`je.entry_date <= $${vals.length}`); }
  const dateWhere = dateClauses.length ? `AND ${dateClauses.join(' AND ')}` : '';

  let catWhere = '';
  if (categories && categories.length) {
    vals.push(categories);
    catWhere = `AND coa.category = ANY($${vals.length})`;
  }

  const r = await pool.query(
    `SELECT coa.code, coa.name, coa.category,
       COALESCE(agg.total_debit, 0)::float AS "totalDebit",
       COALESCE(agg.total_credit, 0)::float AS "totalCredit"
     FROM client_chart_of_accounts coa
     LEFT JOIN (
       SELECT jel.account_code, SUM(jel.debit_amount) AS total_debit, SUM(jel.credit_amount) AS total_credit
       FROM client_journal_entry_lines jel
       JOIN client_journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.company_id = $1 ${dateWhere}
       GROUP BY jel.account_code
     ) agg ON agg.account_code = coa.code
     WHERE coa.company_id = $1 AND coa.is_active = true ${catWhere}
     ORDER BY coa.code`, vals
  );
  return r.rows.map(row => ({
    code: row.code, name: row.name, category: row.category,
    totalDebit: Number(row.totalDebit), totalCredit: Number(row.totalCredit),
  }));
}

// งบทดลอง (Trial Balance): every active account's balance as of a date, in whichever column
// (debit/credit) matches its net direction. totalDebitBalance MUST equal totalCreditBalance — this
// is a mathematical property of a ledger where every entry was validated balanced at write time
// (see createClientJournalEntry), not a coincidence. `balanced:false` in the response means a real
// bug (a corrupted row, a manual DB edit, etc.), which is exactly why the frontend renders it as a
// loud, impossible-to-miss warning rather than silently rendering mismatched totals.
app.get('/api/customer/reports/trial-balance', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const rows = await computeClientAccountBalances(companyId, { to: asOf });
  let totalDebitBalance = 0, totalCreditBalance = 0;
  const accounts = rows.map(r => {
    const net = round2(r.totalDebit - r.totalCredit);
    const debitBalance = net > 0 ? net : 0;
    const creditBalance = net < 0 ? round2(-net) : 0;
    totalDebitBalance = round2(totalDebitBalance + debitBalance);
    totalCreditBalance = round2(totalCreditBalance + creditBalance);
    return { code: r.code, name: r.name, category: r.category, totalDebit: r.totalDebit, totalCredit: r.totalCredit, debitBalance, creditBalance };
  });
  res.json({ asOf, accounts, totalDebitBalance, totalCreditBalance, balanced: totalDebitBalance === totalCreditBalance });
});

// งบกำไรขาดทุน (Income Statement / P&L): revenue (4xxx, net credit) minus expense (5xxx, net
// debit) within [from,to]. `from`/`to` are accepted as plain dates — the "รายเดือน/รายไตรมาส/
// กำหนดเอง" period picker is entirely a frontend concern (it just computes which from/to to send).
app.get('/api/customer/reports/income-statement', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const from = req.query.from || `${new Date().getFullYear()}-01-01`;
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const rows = await computeClientAccountBalances(companyId, { from, to, categories: ['revenue', 'expense'] });
  const revenueAccounts = rows.filter(r => r.category === 'revenue').map(r => ({ code: r.code, name: r.name, amount: round2(r.totalCredit - r.totalDebit) }));
  const expenseAccounts = rows.filter(r => r.category === 'expense').map(r => ({ code: r.code, name: r.name, amount: round2(r.totalDebit - r.totalCredit) }));
  const totalRevenue = round2(revenueAccounts.reduce((s, a) => s + a.amount, 0));
  const totalExpense = round2(expenseAccounts.reduce((s, a) => s + a.amount, 0));
  res.json({ from, to, revenueAccounts, expenseAccounts, totalRevenue, totalExpense, netIncome: round2(totalRevenue - totalExpense) });
});

// งบดุล (Balance Sheet): assets (1xxx) vs liabilities (2xxx) + equity (3xxx, if any exist — none
// are seeded by default) + "กำไรสะสม" (retained earnings). This system has no period-closing step
// that formally sweeps revenue/expense into a stored equity balance, so retained earnings is
// DERIVED here as cumulative (revenue - expense) since inception through `asOf` — computed the
// exact same way the income statement computes net income, just unbounded on the start date.
// This construction is what GUARANTEES Assets = Liabilities + Equity by construction: for any
// ledger where every entry balances (debit total = credit total), summing that identity across
// every account and rearranging by category algebraically gives
// Assets = Liabilities + Equity + (Revenue - Expense) always. If `balanced` ever comes back false,
// that means some entry in the underlying journal wasn't actually balanced — a real bug — not an
// expected occasional discrepancy to shrug off.
app.get('/api/customer/reports/balance-sheet', requireCustomerAuth, async (req, res) => {
  const companyId = req.customer.company_id;
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const bsRows = await computeClientAccountBalances(companyId, { to: asOf, categories: ['asset', 'liability', 'equity'] });
  const assets = bsRows.filter(r => r.category === 'asset').map(r => ({ code: r.code, name: r.name, amount: round2(r.totalDebit - r.totalCredit) }));
  const liabilities = bsRows.filter(r => r.category === 'liability').map(r => ({ code: r.code, name: r.name, amount: round2(r.totalCredit - r.totalDebit) }));
  const equityAccounts = bsRows.filter(r => r.category === 'equity').map(r => ({ code: r.code, name: r.name, amount: round2(r.totalCredit - r.totalDebit) }));

  const plRows = await computeClientAccountBalances(companyId, { to: asOf, categories: ['revenue', 'expense'] });
  const totalRevenueAllTime = round2(plRows.filter(r => r.category === 'revenue').reduce((s, r) => s + (r.totalCredit - r.totalDebit), 0));
  const totalExpenseAllTime = round2(plRows.filter(r => r.category === 'expense').reduce((s, r) => s + (r.totalDebit - r.totalCredit), 0));
  const retainedEarnings = round2(totalRevenueAllTime - totalExpenseAllTime);

  const totalAssets = round2(assets.reduce((s, a) => s + a.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.amount, 0));
  const totalEquity = round2(equityAccounts.reduce((s, a) => s + a.amount, 0) + retainedEarnings);

  res.json({
    asOf, assets, liabilities, equityAccounts, retainedEarnings,
    totalAssets, totalLiabilities, totalEquity,
    balanced: totalAssets === round2(totalLiabilities + totalEquity),
  });
});

// ---------------- Static frontend ----------------
app.get('/', (req, res) => res.redirect('/pr-system.html'));

// Link target for the "new application" email — pr-system.html is a single-file SPA with no
// server-side routing of its own, so this just hands off to it with the id as a query param.
// The SPA itself (see PENDING_JOB_APPLICATION_ID in pr-system.html) shows the login form first
// if there's no session yet, then opens this exact application right after a successful login.
app.get('/job-applications/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect('/pr-system.html');
  res.redirect(`/pr-system.html?jobApplicationId=${id}`);
});

// The static root below is the project root (parent of this server/ folder), which means
// server/ itself — source code, .env, node_modules — sits inside the served tree. Block it
// explicitly; express.static only ignores dotfiles (.env) by default, not server.js itself.
app.use('/server', (req, res) => res.status(404).end());

// `no-store` (previously here) meant every single load re-transferred the full file with zero
// caching, ever — a real, measured contributor to slow page loads (see the 2026-07-24 slow-load
// investigation: ~400-550ms per load on localhost alone, for a ~580KB file with no compression and no
// cache reuse). Switched to `no-cache` + the browser's own conditional-GET support (etag/lastModified
// left at express.static's defaults, i.e. enabled) — this is NOT "cache blindly for N seconds": the
// browser is required to revalidate with the server on every load regardless, so a real deploy is
// always picked up immediately (no stale-cache risk, unlike a long max-age would introduce), but an
// unchanged file gets a cheap 304 Not Modified instead of re-sending the full body every time.
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------------- Cron: expire subscriptions past their expires_at, daily at midnight ----------------
cron.schedule('0 0 * * *', async () => {
  try {
    const r = await pool.query(
      `UPDATE subscriptions SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`
    );
    console.log(`[cron] Expired ${r.rowCount} subscription(s).`);
  } catch (err) {
    console.error('[cron] Failed to expire subscriptions:', err);
  }
});

// ---------------- Cron: foreign worker document expiry reminders, daily shortly after midnight ----------------
cron.schedule('5 0 * * *', async () => {
  try {
    const { soonCount, expiredCount } = await runForeignWorkerDocumentExpiryCheck();
    console.log(`[cron] Foreign worker document expiry check: ${soonCount} 30-day reminder(s), ${expiredCount} expired notice(s).`);
  } catch (err) {
    console.error('[cron] Failed to run foreign worker document expiry check:', err);
  }
});

// Catches whatever the per-route async wrapper above forwards via next(err) — must be registered
// after every route/static middleware (Express matches error handlers by position, not path).
// Postgres constraint violations get a specific, actually-useful Thai message instead of the
// generic apiCall() fallback ("เกิดข้อผิดพลาด") that gave no clue what actually went wrong.
app.use((err, req, res, next) => {
  console.error('[route error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  if (err && err.code === '23514') { // check_violation
    return res.status(400).json({ error: `ข้อมูลไม่ถูกต้อง: ค่าที่ส่งมาไม่อยู่ในตัวเลือกที่อนุญาตสำหรับ "${err.constraint || 'ฟิลด์นี้'}"` });
  }
  if (err && err.code === '23505') { // unique_violation
    return res.status(409).json({ error: 'ข้อมูลนี้มีอยู่แล้วในระบบ (ค่าซ้ำ)' });
  }
  if (err && err.code === '23503') { // foreign_key_violation
    return res.status(400).json({ error: 'ไม่พบข้อมูลที่เกี่ยวข้อง กรุณาลองใหม่อีกครั้ง' });
  }
  res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SiteReq server listening on http://localhost:${PORT}`));
