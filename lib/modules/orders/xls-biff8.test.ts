// .xls（BIFF8）讀取器單元測試：node --experimental-strip-types --test lib/modules/orders/xls-biff8.test.ts
// fixtures/*.xls 由 Python xlwt 1.3.0 產生（獨立的 BIFF8 寫入器），內容見各測試。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const m: typeof import("./xls-biff8") = await import(new URL("./xls-biff8.ts", import.meta.url).href);
const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

test("sample.xls：中文、整數、小數、日期、日期時間、布林、空列與工作表", () => {
  const wb = m.readXls(fx("sample.xls"));
  assert.deepEqual(wb.sheets.map((s) => s.name), ["訂單", "Sheet2"]);
  const rows = wb.sheets[0].rows;
  assert.deepEqual(rows[0], ["訂單編號", "姓名", "數量", "單價", "日期", "日期時間", "公式", "布林"]);
  assert.deepEqual(rows[1].slice(0, 6), ["A001", "王小明", "3", "12.5", "2026/10/22", "2026/10/22 13:45:30"]);
  assert.equal(rows[1][7], "TRUE");
  assert.deepEqual(rows[2].slice(0, 4), ["A002", "Bob", "1000000", "-3.25"]);
  assert.equal(rows[2][7], "FALSE");
  assert.deepEqual(rows[3], []);
  assert.equal(rows[4][1], "長字串" + "測".repeat(300));
  assert.equal(rows[4][3], "0.1");
  assert.equal(wb.sheets[1].rows[0][0], "second");
});

test("sample.xls：SST 跨 CONTINUE 的中文字串完整", () => {
  const rows = m.readXlsRows(fx("sample.xls"));
  // 去掉空列後：表頭＋A001＋A002＋A003＋500 列
  assert.equal(rows.length, 504);
  for (let i = 0; i < 500; i++) {
    assert.equal(rows[4 + i][0], `R${i}`);
    assert.equal(rows[4 + i][1], `第${i}筆中文內容資料`);
    assert.equal(rows[4 + i][2], String(i));
  }
});

test("tiny.xls（小檔，mini stream）與前導零字串", () => {
  assert.deepEqual(m.readXlsRows(fx("tiny.xls")), [["帳號", "金額"], ["0012345", "1500"]]);
});

test("非 .xls／截斷檔 → XlsError", () => {
  assert.equal(m.isXls(new Uint8Array([0x50, 0x4b, 3, 4])), false);
  assert.throws(() => m.readXls(new TextEncoder().encode("a,b\n1,2")), m.XlsError);
  const cut = fx("sample.xls").subarray(0, 1024);
  assert.throws(() => m.readXls(cut), m.XlsError);
});

test("日期格式判斷與序號換算", () => {
  assert.equal(m.isDateFormat("yyyy/mm/dd"), true);
  assert.equal(m.isDateFormat('[$-404]e"年"m"月"d"日"'), true);
  assert.equal(m.isDateFormat("#,##0.00"), false);
  assert.equal(m.isDateFormat("0.00%"), false);
  assert.equal(m.isDateFormat("General"), false);
  assert.equal(m.excelDateText(1), "1900/01/01");
  assert.equal(m.excelDateText(61), "1900/03/01");
  assert.equal(m.excelDateText(46317), "2026/10/22");
  assert.equal(m.excelDateText(46317.5), "2026/10/22 12:00:00");
  assert.equal(m.excelDateText(0, true), "1904/01/01");
  assert.equal(m.numberText(0.1 + 0.2), "0.3");
});
