// Regression test for the Tab B (Mapping mode) BOQ import bugs fixed 2026-07-24:
//   bug 1 — a 2-row merged Excel header (e.g. "ราคาค่าวัสดุ" spanning 2 sub-columns via a real
//           mergeCells()) collapsed distinct columns onto the same dropdown label, so
//           "ราคาวัสดุ/หน่วย" and "รวมค่าวัสดุ" could not be mapped to different columns.
//   bug 2 — a downstream symptom of bug 1: every row after a merged header was misaligned by one
//           column. Originally surfaced as a spurious "ขาด: ปริมาณ" error; now that ปริมาณ is no
//           longer a required field (see below), a still-misaligned column would instead show up as
//           a WRONG computed amount, which is what the merged-header assertions below check for.
// Also re-checks Tab A (the standard-template import) is unaffected, since it uses a completely
// separate fixed-header-row-4 code path that this fix deliberately left untouched.
//
// Also covers the relaxed-validation pass (also 2026-07-24): only รายการงาน (description) is a
// required field now — ปริมาณ, ราคาวัสดุ/หน่วย, ราคาแรงงาน/หน่วย, หน่วย all default to 0 (or '' for
// หน่วย) when blank OR unparseable, rather than erroring. "ขาด: ปริมาณ" can no longer be produced by
// any code path; the only remaining per-row error is "ขาด: รายการงาน".
//
// Also covers the "เป็นหัวข้อหมวดงาน" / "เป็นแถวสรุปยอด" 2-checkbox model added the same day, for
// BOTH import modes: every parsed row is exactly one of category-header (isGroup), summary/subtotal
// row (isSummaryRow — auto-detected via boqDetectSummaryRow, e.g. "รวมเงิน"/"รวมทั้งสิ้น" ending a
// category with no ลำดับ/ปริมาณ but a real amount), or a normal line item — all 3 living in ONE
// unified items[] array (never a separate side array) so the confirm route can filter isSummaryRow
// rows out right before insertFreshBoqItems without disturbing anyone else's group_id. Also covers:
//   - the false-positive guard: a row with a real ลำดับ whose name merely contains "รวม" (e.g.
//     "รวมค่าติดตั้งอุปกรณ์") must still import as a normal line item, never a summary row.
//   - computeBoqSummaryRowWarnings: a summary row's recorded amounts are cross-checked against what
//     the system itself computes from the real children since the last group header — mismatches
//     surface as a warning but never block the import (the summary row is never inserted anyway).
//
// Prerequisites: the dev server must already be running on http://localhost:3000
// (cd server && npm start), and server/.env must point at a reachable Postgres instance.
// Run:  cd server && node tests/boq-import.regression.js
//
// This creates a throwaway customer/tender/budget under an EXISTING company (id=13, the same
// fixture company used by earlier BOQ regression passes) and deletes everything it created,
// including the throwaway customer, in a `finally` block — safe to re-run any number of times.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const pool = require('../db');

const BASE = process.env.BOQ_TEST_BASE_URL || 'http://localhost:3000';
const FIXTURE_COMPANY_ID = 13;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'boq-merged-header-sample.xlsx');

let cookie = '';
async function call(method, urlPath, body, isForm) {
  const headers = { Cookie: cookie };
  let fetchBody = body;
  if (!isForm && body !== undefined) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
  const res = await fetch(BASE + urlPath, { method, headers, body: fetchBody });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || res.statusText); e.status = res.status; e.body = json; throw e; }
  return json;
}
let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  passed++;
  console.log('  OK:', msg);
}

(async () => {
  let testCustomerId = null, tenderId = null, budgetId = null;
  try {
    const companyRes = await pool.query('SELECT id, code FROM customer_companies WHERE id=$1', [FIXTURE_COMPANY_ID]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`Fixture company id=${FIXTURE_COMPANY_ID} not found — adjust FIXTURE_COMPANY_ID for this database.`);
    const hash = await bcrypt.hash('TestPass123!', 10);
    const custIns = await pool.query(
      `INSERT INTO customers (company_id, name, email, username, password_hash, status, can_approve_budget)
       VALUES ($1,'BOQ Regression Test','boq-regression@example.com','_boq_regression_', $2, 'active', true) RETURNING id`,
      [company.id, hash]
    );
    testCustomerId = custIns.rows[0].id;
    await call('POST', '/api/customer-login', { companyCode: company.code, username: '_boq_regression_', password: 'TestPass123!' });

    const tenderIns = await pool.query(
      `INSERT INTO client_tenders (company_id, tender_no, name, status, created_by) VALUES ($1,'BOQ-REGRESSION-001','BOQ regression test tender','preparing',$2) RETURNING id`,
      [company.id, testCustomerId]
    );
    tenderId = tenderIns.rows[0].id;
    const budgetData = await call('POST', '/api/customer/budgets', { tenderId });
    budgetId = budgetData.budget.id;

    // ================= Bug 1 + 2: Tab B merged-header import =================
    console.log('\n--- Tab B: merged 2-row header ---');
    const buf = fs.readFileSync(FIXTURE_PATH);

    const fd1 = new FormData();
    fd1.append('file', new Blob([buf]), 'merged.xlsx');
    const inspect = await call('POST', `/api/customer/budgets/${budgetId}/boq-inspect`, fd1, true);
    const sheetInfo = inspect.sheets[0];
    assert(sheetInfo.headerRowCount === 2, 'auto-detected 2-row header from the horizontal merge');
    const labels = sheetInfo.headers.map(h => h.label);
    assert(labels.includes('รหัสงาน'), 'vertically-merged single-row header "รหัสงาน" has no spurious duplication/suffix');
    assert(labels.includes('ราคาค่าวัสดุ - ต่อหน่วย') && labels.includes('ราคาค่าวัสดุ - เป็นเงิน'), 'ราคาค่าวัสดุ parent combined with both sub-headers into 2 distinct labels');
    assert(labels.includes('ค่าแรงงาน - ต่อหน่วย') && labels.includes('ค่าแรงงาน - เป็นเงิน'), 'ค่าแรงงาน parent combined with both sub-headers into 2 distinct labels');
    assert(new Set(labels).size === labels.length, 'bug 1: no duplicate/colliding column labels in the mapping dropdown');

    const mapping = {
      description: 'รายการ', qty: 'จำนวน', unit: 'หน่วย', workCode: 'รหัสงาน', note: 'หมายเหตุ',
      materialUnitPriceColumn: 'ราคาค่าวัสดุ - ต่อหน่วย', laborUnitPriceColumn: 'ค่าแรงงาน - ต่อหน่วย',
    };

    // Single pass (no exclusions): with ปริมาณ no longer required, the fixture's row 6 (intentionally
    // blank qty, but a real material/labor unit price) must import cleanly with qty defaulted to 0 —
    // never an error — while the amounts on the OTHER rows still prove bug 2 stays fixed: a
    // still-misaligned column would show up here as a wrong number, not a missing-qty error anymore.
    const fd2 = new FormData();
    fd2.append('file', new Blob([buf]), 'merged.xlsx');
    fd2.append('sheetName', 'BOQ');
    fd2.append('columnMapping', JSON.stringify(mapping));
    fd2.append('excludedRows', '[]');
    fd2.append('excludedCols', '[]');
    fd2.append('headerRowCount', '2');
    const preview = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview-mapped`, fd2, true);
    assert(preview.items.length === 4, `4 rows parsed (1 group + 3 items) — the intentionally-blank-qty row no longer errors or needs excluding (got ${preview.items.length})`);
    const [g, i1, i2, i3] = preview.items;
    assert(g.isGroup, 'group row detected');
    assert(i1.materialAmount === 3000 && i1.laborAmount === 1000, 'เทพื้น: material 20×150=3000, labor 20×50=1000 (correct columns, not swapped/shifted)');
    assert(i2.materialAmount === 800 && i2.laborAmount === 400, 'เข้าแบบ: material 10×80=800, labor 10×40=400');
    assert(i3.qty === 0 && i3.qtyDefaulted === true, 'แถวไม่มีปริมาณ: blank ปริมาณ defaults to 0 and is flagged qtyDefaulted — not an error');
    assert(i3.materialUnitPrice === 100 && i3.laborUnitPrice === 30 && !i3.materialUnitPriceDefaulted && !i3.laborUnitPriceDefaulted, 'แถวไม่มีปริมาณ: its own unit prices ARE present in the file, so only qty (not price) is flagged as defaulted');
    assert(i3.materialAmount === 0 && i3.laborAmount === 0, 'แถวไม่มีปริมาณ: material/labor amount both compute to qty(0)×price = 0');

    // ================= Relaxed validation: only "รายการงาน" is required =================
    console.log('\n--- Tab B: relaxed validation (only รายการงาน required) ---');
    const relaxedWb = new ExcelJS.Workbook();
    const relaxedSheet = relaxedWb.addWorksheet('BOQ');
    relaxedSheet.addRow(['ลำดับ', 'รายการงาน', 'หน่วย', 'ปริมาณ', 'ราคาวัสดุ/หน่วย', 'ราคาแรงงาน/หน่วย']);
    relaxedSheet.addRow(['1.1', 'ปริมาณว่างแต่ราคามีค่า', 'ชิ้น', '', 50, 20]); // qty blank, price present
    relaxedSheet.addRow(['1.2', 'ราคาว่างแต่ปริมาณมีค่า', 'ชิ้น', 8, '', '']); // price blank, qty present
    relaxedSheet.addRow(['1.3', 'ทุกช่องว่างหมด', '', '', '', '']); // everything blank; ลำดับ="1.3" (decimal) forces a real item, not a category header
    relaxedSheet.addRow(['1.4', '', 'ชิ้น', 5, 10, 5]); // description BLANK — must still error, the only field left that's required
    const relaxedBuf = await relaxedWb.xlsx.writeBuffer();
    const relaxedMapping = {
      description: 'รายการงาน', qty: 'ปริมาณ', unit: 'หน่วย', sequenceNo: 'ลำดับ',
      materialUnitPriceColumn: 'ราคาวัสดุ/หน่วย', laborUnitPriceColumn: 'ราคาแรงงาน/หน่วย',
    };

    // First: with the description-less row present, the WHOLE file must reject with exactly 1 error,
    // naming only "ขาด: รายการงาน" — "ขาด: ปริมาณ" must never appear again, from any row.
    const fd6 = new FormData();
    fd6.append('file', new Blob([relaxedBuf]), 'relaxed.xlsx');
    fd6.append('sheetName', 'BOQ');
    fd6.append('columnMapping', JSON.stringify(relaxedMapping));
    fd6.append('excludedRows', '[]');
    fd6.append('excludedCols', '[]');
    fd6.append('headerRowCount', '1');
    let relaxedErr = null;
    try { await call('POST', `/api/customer/budgets/${budgetId}/boq-preview-mapped`, fd6, true); }
    catch (e) { relaxedErr = e; }
    assert(!!relaxedErr, 'the description-less row (1.4) is still reported as an error');
    assert((relaxedErr.message.match(/ขาด: รายการงาน/g) || []).length === 1, `exactly 1 "ขาด: รายการงาน" error (got: ${relaxedErr.message})`);
    assert(!/ขาด: ปริมาณ/.test(relaxedErr.message), 'ปริมาณ is never reported as missing anymore, from any row');

    // Second: excluding just the description-less row, the rest of the file — including a row with
    // EVERY numeric field blank — must import with zero errors, all blanks defaulted to 0.
    const fd7 = new FormData();
    fd7.append('file', new Blob([relaxedBuf]), 'relaxed.xlsx');
    fd7.append('sheetName', 'BOQ');
    fd7.append('columnMapping', JSON.stringify(relaxedMapping));
    fd7.append('excludedRows', '[5]'); // row 5 = "1.4" (header is row 1, so 1.1/1.2/1.3/1.4 are rows 2-5)
    fd7.append('excludedCols', '[]');
    fd7.append('headerRowCount', '1');
    const relaxedPreview = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview-mapped`, fd7, true);
    assert(relaxedPreview.items.length === 3, `all 3 remaining rows import with zero errors (got ${relaxedPreview.items.length})`);
    const [rr1, rr2, rr3] = relaxedPreview.items;
    assert(!rr1.isGroup && rr1.qty === 0 && rr1.qtyDefaulted === true && rr1.materialAmount === 0 && rr1.laborAmount === 0, '1.1: blank ปริมาณ defaults to 0 — a real item, not a category header, since its unit prices are present');
    assert(!rr2.isGroup && rr2.qty === 8 && !rr2.qtyDefaulted && rr2.materialUnitPrice === 0 && rr2.materialUnitPriceDefaulted === true && rr2.laborUnitPriceDefaulted === true && rr2.materialAmount === 0, '1.2: blank prices default to 0 — a real item with a real qty, amounts compute to qty×0=0');
    assert(!rr3.isGroup && rr3.qty === 0 && rr3.qtyDefaulted && rr3.materialUnitPriceDefaulted && rr3.laborUnitPriceDefaulted && rr3.amount === 0, '1.3: every numeric field blank still imports as a real item (forced by the decimal ลำดับ), not mistaken for a category header, all defaulting to 0');

    // ================= Tab B: auto-detected "เป็นแถวสรุปยอด" rows (unified items[] model) =================
    console.log('\n--- Tab B: summary-row auto-detection ---');
    const summaryBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'boq-summary-rows-sample.xlsx'));
    const summaryMapping = {
      description: 'รายการงาน', qty: 'ปริมาณ', unit: 'หน่วย', sequenceNo: 'ลำดับ',
      materialUnitPriceColumn: 'ราคาวัสดุ/หน่วย', laborUnitPriceColumn: 'ราคาแรงงาน/หน่วย',
      materialAmountColumn: 'รวมค่าวัสดุ', laborAmountColumn: 'รวมค่าแรงงาน', totalAmountColumn: 'รวมเงิน',
    };
    const fd4 = new FormData();
    fd4.append('file', new Blob([summaryBuf]), 'summary.xlsx');
    fd4.append('sheetName', 'BOQ');
    fd4.append('columnMapping', JSON.stringify(summaryMapping));
    fd4.append('excludedRows', '[]');
    fd4.append('excludedCols', '[]');
    fd4.append('headerRowCount', '1');
    const summaryPreview = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview-mapped`, fd4, true);
    assert(!summaryPreview.error, 'no error thrown — summary rows never reach the "ขาด: ปริมาณ" validator');
    assert(summaryPreview.items.length === 8, `8 rows in ONE unified array: 2 groups + 4 items + 2 summary rows (got ${summaryPreview.items.length})`);
    const groupRows = summaryPreview.items.filter(it => it.isGroup);
    const summaryRows = summaryPreview.items.filter(it => it.isSummaryRow);
    const normalRows = summaryPreview.items.filter(it => !it.isGroup && !it.isSummaryRow);
    assert(groupRows.length === 2 && summaryRows.length === 2 && normalRows.length === 4, `mutually-exclusive counts: 2 groups, 2 summary rows, 4 normal items (got ${groupRows.length}/${summaryRows.length}/${normalRows.length})`);
    const [sr1, sr2] = summaryRows;
    assert(sr1.description === 'รวมเงิน' && sr2.description === 'รวมทั้งสิ้น', `summary rows detected in file order (got ${sr1.description}, ${sr2.description})`);
    assert(sr1.materialAmount === 20000 && sr1.laborAmount === 4000 && sr1.amount === 24000, 'first summary row carries the correct material/labor/total amounts');
    assert(sr2.materialAmount === 10000 && sr2.laborAmount === 2000 && sr2.amount === 12000, 'second summary row carries the correct material/labor/total amounts');
    const falsePositiveGuardItem = normalRows.find(it => it.description === 'รวมค่าติดตั้งอุปกรณ์');
    assert(!!falsePositiveGuardItem, 'false-positive guard: a row with a real ลำดับ whose name contains "รวม" is a normal item — neither isGroup nor isSummaryRow');
    assert(falsePositiveGuardItem.materialAmount === 5000 && falsePositiveGuardItem.laborAmount === 1000, 'false-positive guard item: material 1×5000=5000, labor 1×1000=1000');
    assert(summaryPreview.total === 42000, `total excludes both summary rows' own amounts (2 groups=0 + 18000 + 6000 + 12000 + 6000 = 42000, got ${summaryPreview.total})`);
    assert((summaryPreview.summaryRowWarnings || []).length === 0, `no cross-check warnings — both summary rows correctly match their real children's sum (got ${(summaryPreview.summaryRowWarnings || []).length})`);

    // ---- Cross-check warning: bump "รวมทั้งสิ้น"'s recorded total so it disagrees with what the
    // system computes from its real child (2.1 alone = 12000) — must surface as a warning, never
    // block the preview (the row is still auto-detected and still never gets inserted either way).
    const mismatchWb = new ExcelJS.Workbook();
    await mismatchWb.xlsx.load(summaryBuf);
    mismatchWb.worksheets[0].getRow(8).getCell(9).value = 99999; // "รวมเงิน" column of the "รวมทั้งสิ้น" row
    const mismatchBuf = await mismatchWb.xlsx.writeBuffer();
    const fd5 = new FormData();
    fd5.append('file', new Blob([mismatchBuf]), 'summary-mismatch.xlsx');
    fd5.append('sheetName', 'BOQ');
    fd5.append('columnMapping', JSON.stringify(summaryMapping));
    fd5.append('excludedRows', '[]');
    fd5.append('excludedCols', '[]');
    fd5.append('headerRowCount', '1');
    const mismatchPreview = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview-mapped`, fd5, true);
    assert((mismatchPreview.summaryRowWarnings || []).length === 1, `bumping the recorded total surfaces exactly 1 mismatch warning (got ${(mismatchPreview.summaryRowWarnings || []).length})`);
    const mw = mismatchPreview.summaryRowWarnings[0];
    assert(mw.description === 'รวมทั้งสิ้น' && mw.expected.amount === 12000 && mw.actual.amount === 99999, `warning reports the row, the system's computed amount (12000), and the file's own (wrong) amount (99999) — got description=${mw.description}, expected=${mw.expected.amount}, actual=${mw.actual.amount}`);

    // ---- Confirm: summary rows are validated (no qty required) but never inserted, and never
    // double-counted into the group they used to describe — since they're simply absent from the
    // array insertFreshBoqItems iterates, there's no group_id contamination risk at all.
    const importResult = await call('POST', `/api/customer/budgets/${budgetId}/import-boq`, { items: summaryPreview.items });
    assert(importResult.importedCount === 6, `only the 2 groups + 4 real items are inserted, both summary rows excluded (got ${importResult.importedCount})`);
    assert(!importResult.budget.latestItems.some(it => it.description === 'รวมเงิน' || it.description === 'รวมทั้งสิ้น'), 'neither summary row appears in the saved item list');
    // หมวดงานที่ 2's real positional children are 2.1 (mat 10000/labor 2000) AND 3.1 "รวมค่าติดตั้ง
    // อุปกรณ์" (mat 5000/labor 1000 — it has no group header of its own in this fixture, so it falls
    // under หมวดงานที่ 2 too) = 15000/3000. If the excluded "รวมทั้งสิ้น" row had somehow still been
    // inserted/attributed to this group, this would instead read 25000/5000.
    const savedGroup2 = importResult.budget.latestItems.find(it => it.isGroup && it.description === 'หมวดงานที่ 2: งานโครงสร้าง');
    assert(!!savedGroup2 && savedGroup2.materialAmount === 15000 && savedGroup2.laborAmount === 3000 && savedGroup2.amount === 18000, `หมวดงานที่ 2's rolled-up subtotal reflects only its real children (15000/3000/18000), not the excluded "รวมทั้งสิ้น" row (got mat=${savedGroup2 && savedGroup2.materialAmount}, labor=${savedGroup2 && savedGroup2.laborAmount}, amount=${savedGroup2 && savedGroup2.amount})`);

    // ================= Tab A: category header + summary row (same unified model) =================
    console.log('\n--- Tab A: group + summary row auto-detection ---');
    const templateRes = await fetch(BASE + '/api/customer/boq-template', { headers: { Cookie: cookie } });
    const templateBuf = Buffer.from(await templateRes.arrayBuffer());
    const twb = new ExcelJS.Workbook();
    await twb.xlsx.load(templateBuf);
    const tsheet = twb.worksheets[0];
    tsheet.getRow(5).values = ['', 'หมวดทดสอบ', '', '', '', '', '', '', '', 'Y', ''];
    tsheet.getRow(6).values = ['T-1', 'รายการทดสอบ', 'ชิ้น', 4, 25, 10, '', '', '', 'N', ''];
    // "N" in the เป็นหมวดหมู่? column (isGroupExplicit=false) — isSummaryRow is still auto-detected
    // via the same keyword/no-qty/has-amount heuristic Tab B uses, since Tab A has no dedicated column
    // of its own for it (per spec: the 2-checkbox split lives in the Preview step, not a new template column).
    tsheet.getRow(7).values = ['', 'รวมเงิน', '', '', '', '', 100, 40, 140, 'N', ''];
    const filledBuf = await twb.xlsx.writeBuffer();
    const fdA = new FormData();
    fdA.append('file', new Blob([filledBuf]), 'template.xlsx');
    const previewA = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview`, fdA, true);
    assert(previewA.items.length === 3, 'Tab A: 1 group + 1 item + 1 auto-detected summary row, all in the same unified items array');
    const groupA = previewA.items.find(it => it.isGroup);
    const itemA = previewA.items.find(it => !it.isGroup && !it.isSummaryRow);
    const summaryA = previewA.items.find(it => it.isSummaryRow);
    assert(!!groupA, 'Tab A: category header detected from the Y/N column, unaffected by the new logic');
    assert(!!itemA && itemA.materialAmount === 100 && itemA.laborAmount === 40, 'Tab A: material 4×25=100, labor 4×10=40');
    assert(!!summaryA && summaryA.materialAmount === 100 && summaryA.laborAmount === 40 && summaryA.amount === 140, 'Tab A: "รวมเงิน" row (Y/N column left at "N") auto-detected as a summary row, not an error');
    assert((previewA.summaryRowWarnings || []).length === 0, 'Tab A: no mismatch warning — the summary row correctly matches its one real child');
    assert(previewA.total === 140, `Tab A: total excludes the summary row's own amount (100+40 from the real item only, got ${previewA.total})`);

    // Mismatch: bump the summary row's total so it disagrees with the real item under it.
    tsheet.getRow(7).values = ['', 'รวมเงิน', '', '', '', '', 100, 40, 999, 'N', ''];
    const mismatchBufA = await twb.xlsx.writeBuffer();
    const fdA2 = new FormData();
    fdA2.append('file', new Blob([mismatchBufA]), 'template-mismatch.xlsx');
    const previewAMismatch = await call('POST', `/api/customer/budgets/${budgetId}/boq-preview`, fdA2, true);
    assert((previewAMismatch.summaryRowWarnings || []).length === 1, 'Tab A: mismatched summary row surfaces exactly 1 warning');
    assert(previewAMismatch.summaryRowWarnings[0].expected.amount === 140 && previewAMismatch.summaryRowWarnings[0].actual.amount === 999, 'Tab A: warning reports the computed (140) vs the file\'s own (999) amount');

    // Confirm: the summary row is excluded and never double-counted into the group's subtotal.
    const importA = await call('POST', `/api/customer/budgets/${budgetId}/import-boq`, { items: previewA.items });
    assert(importA.importedCount === 2, 'Tab A: only the group + real item are inserted, the summary row excluded');
    assert(!importA.budget.latestItems.some(it => it.description === 'รวมเงิน'), 'Tab A: the summary row never appears in the saved item list');
    const savedGroupA = importA.budget.latestItems.find(it => it.isGroup);
    assert(!!savedGroupA && savedGroupA.materialAmount === 100 && savedGroupA.laborAmount === 40, 'Tab A: group subtotal reflects only the real item, not doubled by the excluded summary row');

    console.log(`\nALL ${passed} CHECKS PASSED`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message, err.body || '');
    process.exitCode = 1;
  } finally {
    try {
      if (budgetId) {
        await pool.query('UPDATE client_budgets SET current_revision_id=NULL WHERE id=$1', [budgetId]);
        const revIds = (await pool.query('SELECT id FROM client_budget_revisions WHERE budget_id=$1', [budgetId])).rows.map(r => r.id);
        for (const rid of revIds) await pool.query('DELETE FROM client_budget_items WHERE revision_id=$1', [rid]);
        await pool.query('DELETE FROM client_budget_revisions WHERE budget_id=$1', [budgetId]);
        await pool.query('DELETE FROM client_budgets WHERE id=$1', [budgetId]);
      }
      if (tenderId) await pool.query('DELETE FROM client_tenders WHERE id=$1', [tenderId]);
      if (testCustomerId) await pool.query('DELETE FROM customers WHERE id=$1', [testCustomerId]);
    } catch (cleanupErr) { console.error('CLEANUP FAILED (manual cleanup needed):', cleanupErr.message); }
    await pool.end();
  }
})();
