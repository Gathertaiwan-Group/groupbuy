// 每月消費統計下載：xlsx 產生器可輸出本報表的表頭與列（純函式，不連 DB）
// 執行：node --experimental-strip-types --test lib/modules/analytics/tests/customer-point-summary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

const X = await import(new URL("../xlsx.ts", import.meta.url).href);

function entries(buf) {
  const out = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const xlen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString();
    const data = buf.subarray(i + 30 + nlen + xlen, i + 30 + nlen + xlen + csize);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    i += 30 + nlen + xlen + csize;
  }
  return out;
}

test("每月消費統計 xlsx：工作表名稱、中文表頭、數字與文字儲存格", () => {
  const rows = [
    ["月份", "姓名", "電話", "消費總金額", "會員ID", "目前點數"].map((v) => ({ v, s: "header" })),
    [{ v: "2026-10", t: "s" }, "王小明", { v: "0912345678", t: "s" }, 1234.5, { v: "cus700001", t: "s" }, 100],
  ];
  const buf = X.buildXlsx([{ name: "每月消費統計", rows }]);
  const e = entries(buf);
  assert.ok(e["xl/workbook.xml"].includes("每月消費統計"));
  const sheet = Object.entries(e).find(([k]) => k.startsWith("xl/worksheets/"))[1];
  assert.ok(sheet.includes("消費總金額") && sheet.includes("王小明"));
  assert.ok(sheet.includes("0912345678"), "電話以文字保存（不掉前導 0）");
  assert.ok(sheet.includes("1234.5"));
});
