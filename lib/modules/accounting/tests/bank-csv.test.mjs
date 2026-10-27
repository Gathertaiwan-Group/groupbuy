// 銀行明細解析單元測試：node --test lib/modules/accounting/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDateTime,
  parseAmount,
  parseManualText,
  parseBankFile,
  decodeBankFile,
  splitCsvRow,
  accountModeOf,
  bankCsvTemplate,
} from "../bank-csv.ts";

test("日期：原站範例民國年 0105/06/22、民國 115、西元、8 碼、7 碼", () => {
  assert.deepEqual(parseDateTime("0105/06/22"), { date: "2016-06-22", time: null });
  assert.deepEqual(parseDateTime("115/10/22"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("2026-10-22"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("2026.10.22"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("20261022"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("01151022"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("1151022"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateTime("2026/10/22 14:30"), { date: "2026-10-22", time: "14:30:00" });
  assert.deepEqual(parseDateTime("2026-10-22T09:05:07"), { date: "2026-10-22", time: "09:05:07" });
});

test("日期：不合法的日期回 null", () => {
  assert.equal(parseDateTime("2026/02/30"), null);
  assert.equal(parseDateTime("abc"), null);
  assert.equal(parseDateTime(""), null);
  assert.equal(parseDateTime("1000"), null);
});

test("金額：逗號、NT$、元、負數、括號負數、小數", () => {
  assert.equal(parseAmount("1,000"), 1000);
  assert.equal(parseAmount("NT$1,200"), 1200);
  assert.equal(parseAmount("300元"), 300);
  assert.equal(parseAmount("-500"), -500);
  assert.equal(parseAmount("(500)"), -500);
  assert.equal(parseAmount("12.50"), 12.5);
  assert.equal(parseAmount("12.555"), null);
  assert.equal(parseAmount("abc"), null);
});

test("文字框：原站說明的兩行範例", () => {
  const r = parseManualText("0105/06/22 1000 10000000001\n0105/06/22 3000 1000000003");
  assert.equal(r.issues.length, 0);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(
    r.lines.map((l) => [l.date, l.amount, l.account]),
    [
      ["2016-06-22", 1000, "10000000001"],
      ["2016-06-22", 3000, "1000000003"],
    ],
  );
});

test("文字框：可選時間欄、第 4 欄指定訂單編號、Tab 分隔、空行與 # 註解略過", () => {
  const r = parseManualText("# 註解\n\n2026/10/22 14:30 900 0000000010035 261022001005\n2026/10/22\t1,000\t12345");
  assert.equal(r.issues.length, 0);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].time, "14:30:00");
  assert.equal(r.lines[0].uuidHint, "261022001005");
  assert.equal(r.lines[0].lineNo, 3);
  assert.equal(r.lines[1].amount, 1000);
  assert.equal(r.lines[1].uuidHint, null);
});

test("文字框：格式錯誤的行列在 issues（含行號）", () => {
  const r = parseManualText("2026/10/22 900 10035\n這不是日期 900 10035\n2026/10/22 abc 10035\n2026/10/22 900");
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.issues.map((i) => i.lineNo), [2, 3, 4]);
  assert.match(r.issues[0].message, /匯款日期/);
  assert.match(r.issues[1].message, /匯款金額/);
  assert.match(r.issues[2].message, /帳號/);
});

test("CSV：有表頭（交易日期/交易時間/支出/存入/轉出帳號/備註），只取存入列", () => {
  const csv = [
    "玉山銀行 存款交易明細",
    "交易日期,交易時間,摘要,支出金額,存入金額,餘額,轉出帳號,備註",
    "2026/10/22,10:01:02,跨行轉入,,900,10900,0000000010035,",
    "2026/10/22,11:00:00,ATM提款,500,,10400,,",
    '2026/10/23,09:00:00,跨行轉入,,"1,000",11400,,匯款帳號 808-0000012345',
    "合計,,,500,1900,,,",
  ].join("\n");
  const r = parseBankFile(csv, "ESUN");
  assert.equal(r.lines.length, 2);
  assert.match(r.format, /^header:/);
  assert.deepEqual([r.lines[0].date, r.lines[0].time, r.lines[0].amount, r.lines[0].account], ["2026-10-22", "10:01:02", 900, "0000000010035"]);
  assert.equal(r.lines[1].amount, 1000);
  assert.equal(r.lines[1].account, "8080000012345"); // 帳號欄空白時從備註取數字
  assert.equal(r.skipped, 2); // 提款列＋合計列
});

test("CSV：備註中的 12 碼訂單編號當作指定訂單", () => {
  const r = parseBankFile("交易日期,存入金額,轉出帳號,備註\n2026/10/22,900,10035,訂單261022001005", "CUSTOM");
  assert.equal(r.lines[0].uuidHint, "261022001005");
});

test("CSV：分號、Tab 分隔與 Excel =\"0012\" 文字格式", () => {
  assert.deepEqual(splitCsvRow('2026/10/22;="0012345";900', ";"), ["2026/10/22", "0012345", "900"]);
  const r = parseBankFile("日期\t金額\t帳號\n2026-10-22\t900\t00010035", "CUSTOM");
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].account, "00010035");
});

test("TXT（無表頭、空白分隔）：逐列找日期、金額、帳號", () => {
  const txt = "1151022 093000 900 0000000010035 跨行轉入\n1151023 101500 1000 0000000010042\n本頁合計 1900";
  const r = parseBankFile(txt, "ESUNTXT");
  assert.equal(r.format, "tokens");
  assert.equal(r.lines.length, 2);
  assert.deepEqual([r.lines[0].date, r.lines[0].amount, r.lines[0].account], ["2026-10-22", 900, "0000000010035"]);
  assert.equal(r.skipped, 1);
});

test("編碼：UTF-8 BOM 與 Big5 都能解碼", () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("交易日期")]);
  assert.deepEqual(decodeBankFile(utf8), { text: "交易日期", encoding: "utf-8" });
  // 「日期」的 Big5 編碼：A4E9 B4C1
  const big5 = new Uint8Array([0xa4, 0xe9, 0xb4, 0xc1]);
  assert.deepEqual(decodeBankFile(big5), { text: "日期", encoding: "big5" });
});

test("帳號欄只保留數字／*／-：文字框貼入 HTML 不會原樣存入", () => {
  const r = parseManualText("2026/10/22 900 1<img/src=x/onerror=alert(1)>");
  assert.equal(r.issues.length, 0);
  assert.match(r.lines[0].accountRaw, /^[0-9*\- ]+$/);
  assert.ok(!r.lines[0].accountRaw.includes("<"));
  const f = parseBankFile('交易日期,存入金額,轉出帳號\n2026/10/22,900,"<b>0000000010035</b>"', "ESUN");
  assert.equal(f.lines[0].accountRaw, "0000000010035");
});

test("一般格式同時有「轉出帳號」與「收款帳號」→ 取轉出帳號（付款人）", () => {
  const csv = "交易日期,存入金額,收款帳號,轉出帳號\n2026/10/22,900,1234567890123,0000000010035\n2026/10/22,900,1234567890123,0000000010042";
  const r = parseBankFile(csv, "ESUN");
  assert.deepEqual(r.lines.map((l) => l.account), ["0000000010035", "0000000010042"]);
});

test("對帳格式的帳號模式與範本", () => {
  assert.equal(accountModeOf("CATHAYECC"), "card");
  assert.equal(accountModeOf("ESUNV"), "virtual");
  assert.equal(accountModeOf("ESUN"), "account");
  const tpl = bankCsvTemplate();
  const r = parseBankFile(tpl, "CUSTOM");
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].uuidHint, "261022001005");
  assert.equal(r.lines[1].date, "2026-10-22");
});

test("fix15 自定義對帳格式（系統設定 bankFormat）：欄位序號、日期格式、訂單號碼格式", async () => {
  const { parseBankFile, parseDateByFormat, uuidByFormat } = await import("../bank-csv.ts");
  const fmt = { date: 1, debit: 3, note: 4, dateFmt: "dd-MM-yyyy", uuidFmt: "GG([\\d]{5})", locale: "zh_TW" };
  const text = "序,日期,摘要,存入,備註\n1,22-10-2026,轉帳,\"1,200\",GG01005 王小明 0001234567890\n2,23-10-2026,提款,0,x";
  const r = parseBankFile(text, "CUSTOM", fmt);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].date, "2026-10-22");
  assert.equal(r.lines[0].amount, 1200);
  assert.equal(r.lines[0].uuidHint, "01005");
  assert.equal(r.lines[0].account, "0001234567890");
  assert.match(r.format, /^custom:/);
  // 非 CUSTOM 或未設定格式 → 原本的通用解析
  assert.notEqual(parseBankFile(text, "ESUN", fmt).format.slice(0, 7), "custom:");
  assert.notEqual(parseBankFile(text, "CUSTOM", null).format.slice(0, 7), "custom:");
  assert.deepEqual(parseDateByFormat("115/10/22", "yyy/MM/dd"), { date: "2026-10-22", time: null });
  assert.deepEqual(parseDateByFormat("Oct 22, 2026 14:05:09", "MMM dd, yyyy HH:mm:ss"), { date: "2026-10-22", time: "14:05:09" });
  assert.equal(uuidByFormat("xx", "("), null);
});
