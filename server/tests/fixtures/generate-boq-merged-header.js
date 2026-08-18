// Regenerates tests/fixtures/boq-merged-header-sample.xlsx — a real-world-shaped BOQ file with a
// 2-row merged header (parent labels "ราคาค่าวัสดุ"/"ค่าแรงงาน" each spanning 2 sub-columns via a
// genuine ExcelJS mergeCells(), plus single-column headers that are vertically merged across both
// header rows, e.g. "รหัสงาน") — modeled on the exact layout reported in the Tab B mapping bug.
// Run: node tests/fixtures/generate-boq-merged-header.js
const path = require('path');
const ExcelJS = require('../../node_modules/exceljs');

async function build() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('BOQ');
  sheet.getCell('A1').value = 'รหัสงาน';       sheet.mergeCells('A1:A2');
  sheet.getCell('B1').value = 'รายการ';        sheet.mergeCells('B1:B2');
  sheet.getCell('C1').value = 'หน่วย';         sheet.mergeCells('C1:C2');
  sheet.getCell('D1').value = 'จำนวน';         sheet.mergeCells('D1:D2');
  sheet.getCell('E1').value = 'ราคาค่าวัสดุ';  sheet.mergeCells('E1:F1');
  sheet.getCell('G1').value = 'ค่าแรงงาน';     sheet.mergeCells('G1:H1');
  sheet.getCell('I1').value = 'หมายเหตุ';      sheet.mergeCells('I1:I2');
  sheet.getCell('E2').value = 'ต่อหน่วย'; sheet.getCell('F2').value = 'เป็นเงิน';
  sheet.getCell('G2').value = 'ต่อหน่วย'; sheet.getCell('H2').value = 'เป็นเงิน';
  sheet.getRow(3).values = ['', 'หมวดงานโครงสร้าง', '', '', '', '', '', '', ''];
  sheet.getRow(4).values = ['W-1', 'เทพื้น', 'ตร.ม.', 20, 150, '', 50, '', ''];
  sheet.getRow(5).values = ['W-2', 'เข้าแบบ', 'ตร.ม.', 10, 80, '', 40, '', ''];
  // Deliberately blank qty — this row is a REAL "ขาด: ปริมาณ" case, not a merged-header artifact.
  // The regression assertion is that exactly ONE such error is ever reported for this fixture.
  sheet.getRow(6).values = ['W-3', 'แถวไม่มีปริมาณ (ตั้งใจ)', 'ตร.ม.', '', 100, '', 30, '', ''];
  return wb;
}

if (require.main === module) {
  build().then(wb => wb.xlsx.writeFile(path.join(__dirname, 'boq-merged-header-sample.xlsx')))
    .then(() => console.log('wrote tests/fixtures/boq-merged-header-sample.xlsx'))
    .catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { build };
