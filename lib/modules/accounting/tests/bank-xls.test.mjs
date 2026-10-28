// 匯款對帳上傳 .xls／.xlsx（PARITY #100）：試算表 → CSV 文字 → 既有銀行格式解析
// fixtures/bank.xls 由 Python xlwt 產生：標題列、表頭、日期為 Excel 日期格式、含提款列、備註含引號與逗號。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { readSpreadsheetRows, rowsToCsv, spreadsheetKind, SpreadsheetError } from "../../orders/spreadsheet.ts";
import { parseBankFile } from "../bank-csv.ts";

const bankXls = new Uint8Array(readFileSync(new URL("./fixtures/bank.xls", import.meta.url)));

test(".xls：轉 CSV 後以玉山格式解析（日期、時間、金額、帳號、備註訂單編號）", async () => {
  assert.equal(spreadsheetKind("bank.xls", bankXls), "xls");
  const { kind, rows } = await readSpreadsheetRows("bank.xls", bankXls);
  assert.equal(kind, "xls");
  const csv = rowsToCsv(rows);
  assert.match(csv, /"王""小,明"/);
  const r = parseBankFile(csv, "ESUN");
  assert.equal(r.lines.length, 2);
  assert.deepEqual([r.lines[0].date, r.lines[0].time, r.lines[0].amount, r.lines[0].account], ["2026-10-22", "10:01:02", 900, "0000000010035"]);
  assert.equal(r.lines[0].uuidHint, "261022001005");
  assert.equal(r.lines[1].amount, 1000.5);
  assert.equal(r.skipped, 1); // 提款列
});

test(".xlsx：同內容以 exceljs 產生，結果一致", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("交易明細");
  ws.addRow(["玉山銀行 存款交易明細"]);
  ws.addRow(["交易日期", "交易時間", "提款金額", "存入金額", "轉出帳號", "備註"]);
  ws.addRow(["2026/10/22", "10:01:02", null, 900, "0000000010035", "訂單261022001005"]);
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  const { kind, rows } = await readSpreadsheetRows("bank.xlsx", buf);
  assert.equal(kind, "xlsx");
  const r = parseBankFile(rowsToCsv(rows), "ESUN");
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].account, "0000000010035");
});

test("副檔名為 .xls 但內容損毀 → SpreadsheetError（提示另存）", async () => {
  await assert.rejects(readSpreadsheetRows("bad.xls", bankXls.subarray(0, 600)), (e) => e instanceof SpreadsheetError && /另存/.test(e.message));
});
