// Regenerates tests/fixtures/boq-summary-rows-sample.xlsx — modeled on the layout reported from
// บริษัท เอส.เอ.ด้ เอ็นจิเนียริ่งฯ's BOQ file: a plain single-row header, ลำดับ-numbered rows (whole
// number = category, decimal = line item under it), and a "รวมเงิน"/"รวมทั้งสิ้น" row ending each
// category with material/labor/total amounts filled in but no ลำดับ and no ปริมาณ. Used to verify
// Tab B's summary-row auto-detection (see boqDetectSummaryRow in server.js) never reports these as a
// missing-qty error, and that a row with a real ลำดับ (e.g. "10. รวมค่าติดตั้ง") is never mistaken
// for one even though its name also contains "รวม".
// Run: node tests/fixtures/generate-boq-summary-rows.js
const path = require('path');
const ExcelJS = require('../../node_modules/exceljs');

async function build() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('BOQ');
  sheet.addRow(['ลำดับ', 'รายการงาน', 'หน่วย', 'ปริมาณ', 'ราคาวัสดุ/หน่วย', 'ราคาแรงงาน/หน่วย', 'รวมค่าวัสดุ', 'รวมค่าแรงงาน', 'รวมเงิน']);
  sheet.addRow([1, 'หมวดงานที่ 1: งานฐานราก', '', '', '', '', '', '', '']);
  sheet.addRow(['1.1', 'เทคอนกรีตฐานราก', 'ลบ.ม.', 10, 1500, 300, '', '', '']);
  sheet.addRow(['1.2', 'ผูกเหล็กเสริม', 'กก.', 200, 25, 5, '', '', '']);
  // Summary/subtotal row: no ลำดับ, no ปริมาณ, description matches a known keyword, amounts filled —
  // must be auto-detected and skipped, never reported as "ขาด: ปริมาณ".
  sheet.addRow(['', 'รวมเงิน', '', '', '', '', 20000, 4000, 24000]);
  sheet.addRow([2, 'หมวดงานที่ 2: งานโครงสร้าง', '', '', '', '', '', '', '']);
  sheet.addRow(['2.1', 'เทคอนกรีตเสาเข็ม', 'ต้น', 5, 2000, 400, '', '', '']);
  sheet.addRow(['', 'รวมทั้งสิ้น', '', '', '', '', 10000, 2000, 12000]);
  // False-positive guard: has a real ลำดับ AND the word "รวม" in its name — must import as a normal
  // line item, never be swept up as a summary row (see boqDetectSummaryRow's sequenceRaw check).
  sheet.addRow(['3.1', 'รวมค่าติดตั้งอุปกรณ์', 'งาน', 1, 5000, 1000, '', '', '']);
  return wb;
}

if (require.main === module) {
  build().then(wb => wb.xlsx.writeFile(path.join(__dirname, 'boq-summary-rows-sample.xlsx')))
    .then(() => console.log('wrote tests/fixtures/boq-summary-rows-sample.xlsx'))
    .catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { build };
