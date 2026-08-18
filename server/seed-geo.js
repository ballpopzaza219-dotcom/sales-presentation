// path ต้องอิง __dirname เสมอ ห้ามพึ่ง cwd — เหตุผลเดียวกับ db.js (ดู CLAUDE.md ข้อ 16)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const pool = require('./db');

// Source: kongvut/thai-province-data (MIT), api/latest/{province,district,sub_district}.json.
// Static reference data — re-running is safe (ON CONFLICT DO NOTHING keyed on each table's id).

async function main() {
  const dataDir = path.join(__dirname, 'data', 'thailand-geo');
  const provinces = JSON.parse(fs.readFileSync(path.join(dataDir, 'province.json'), 'utf8'));
  const districts = JSON.parse(fs.readFileSync(path.join(dataDir, 'district.json'), 'utf8'));
  const subdistricts = JSON.parse(fs.readFileSync(path.join(dataDir, 'sub_district.json'), 'utf8'));

  await pool.query(
    `INSERT INTO provinces (id, name_th)
     SELECT * FROM UNNEST($1::int[], $2::text[])
     ON CONFLICT (id) DO NOTHING`,
    [provinces.map(p => p.id), provinces.map(p => p.name_th)]
  );
  console.log(`Seeded ${provinces.length} provinces`);

  await pool.query(
    `INSERT INTO districts (id, province_id, name_th)
     SELECT * FROM UNNEST($1::int[], $2::int[], $3::text[])
     ON CONFLICT (id) DO NOTHING`,
    [districts.map(d => d.id), districts.map(d => d.province_id), districts.map(d => d.name_th)]
  );
  console.log(`Seeded ${districts.length} districts`);

  await pool.query(
    `INSERT INTO subdistricts (id, district_id, name_th, zipcode)
     SELECT * FROM UNNEST($1::int[], $2::int[], $3::text[], $4::text[])
     ON CONFLICT (id) DO NOTHING`,
    [
      subdistricts.map(s => s.id),
      subdistricts.map(s => s.district_id),
      subdistricts.map(s => s.name_th),
      subdistricts.map(s => String(s.zip_code)),
    ]
  );
  console.log(`Seeded ${subdistricts.length} subdistricts`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
