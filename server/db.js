// path ต้องอิง __dirname เสมอ ห้ามพึ่ง cwd (dotenv default resolve จาก process.cwd() ไม่ใช่ตำแหน่งไฟล์
// นี้) — ไม่งั้นสคริปต์ที่ require('./db') จากคนละ working directory (เช่น รันจากนอกโฟลเดอร์ server/)
// จะหา .env ไม่เจอเงียบๆ แล้วตกไปใช้ค่า default ที่ผิด/ไม่มีรหัสผ่านแทน (พบจริงจากการดีบัก connection
// ที่ใช้ได้บ้างไม่ได้บ้างขึ้นอยู่กับว่ารันจากที่ไหน)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

// PGDATABASE ห้ามมี default แบบเงียบๆ — ต้อง throw ทันทีถ้าไม่ได้ตั้งค่า แทนที่จะ fallback ไปต่อกับ
// database ที่ไม่ตั้งใจ (เดิม fallback เป็น 'sitereq' ซึ่งไม่ตรงกับ database จริงที่ตั้งไว้ใน .env
// คือ 'sitereq_db' — ถ้า .env โหลดไม่ขึ้นด้วยเหตุผลใดก็ตาม แอปจะเงียบๆ ต่อกับ database ผิดตัวแทนที่จะ
// error ให้เห็นชัดเจนตั้งแต่ต้น) — ค่าที่เหลือ (host/port/user) ยังคงมี default ที่สมเหตุสมผลสำหรับ
// local dev ไว้ตามเดิม เพราะ "ต่อ localhost:5432 ผิด" ไม่อันตรายเท่า "ต่อ database ผิดชื่อ"
if (!process.env.PGDATABASE) {
  throw new Error('PGDATABASE ไม่ได้ถูกตั้งค่า (ตรวจสอบว่ามีไฟล์ server/.env และมีบรรทัด PGDATABASE=... อยู่จริง) — ปฏิเสธที่จะ fallback ไปต่อกับ database เริ่มต้นแบบเงียบๆ');
}

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER || 'sitereq_app',
  password: process.env.PGPASSWORD,
});

module.exports = pool;
