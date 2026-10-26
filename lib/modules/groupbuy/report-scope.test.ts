// /rp 業績報表訂單口徑單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/groupbuy/report-scope.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./report-scope");
const M: M = await import(new URL("./report-scope.ts", import.meta.url).href);
const { reportStateScope, reportStateOptions, countsInReportStats, REPORT_EXCLUDED_STATES } = M;

const ALL = ["DRAFT", "NEW", "PROCESSING", "COMPLETE", "HOLDED", "COMBINED", "SPLITED", "CLOSED", "RETURNING", "RETURNED", "CANCELED", "DELETED"];

/** 模擬 PostgREST 查詢：not in exclude 且（only 時）eq only */
function listed(states: string[], stateFilter: string) {
  const sc = reportStateScope(stateFilter);
  return states.filter((s) => !sc.exclude.includes(s) && (sc.only == null || s === sc.only));
}

describe("reportStateScope", () => {
  test("未選階段：表格筆數＝卡片統計筆數（同 is_valid_order_state）", () => {
    const orders = ["COMPLETE", "PROCESSING", "PROCESSING", "CANCELED", "DELETED", "DRAFT", "COMBINED", "SPLITED", "NEW"];
    assert.equal(listed(orders, "").length, orders.filter(countsInReportStats).length);
    assert.deepEqual(listed(orders, ""), ["COMPLETE", "PROCESSING", "PROCESSING", "NEW"]);
  });
  test("選「已取消」仍可看到取消單", () => {
    assert.deepEqual(listed(["COMPLETE", "CANCELED", "CANCELED"], "CANCELED"), ["CANCELED", "CANCELED"]);
  });
  test("已合併／已拆單可用階段篩選查看", () => {
    assert.deepEqual(listed(["COMBINED", "SPLITED", "NEW"], "COMBINED"), ["COMBINED"]);
  });
  test("草稿與已刪除永遠不列出（即使篩選該階段）", () => {
    assert.deepEqual(listed(["DRAFT", "DELETED"], "DRAFT"), []);
    assert.deepEqual(listed(["DRAFT", "DELETED"], "DELETED"), []);
  });
  test("排除清單與 DB is_valid_order_state 相同", () => {
    assert.deepEqual([...REPORT_EXCLUDED_STATES].sort(), ["CANCELED", "COMBINED", "DELETED", "DRAFT", "SPLITED"]);
    for (const s of ALL) assert.equal(countsInReportStats(s), !["DRAFT", "CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(s));
  });
});

describe("reportStateOptions", () => {
  test("下拉不含草稿與已刪除", () => {
    const opts = reportStateOptions(ALL.map((value) => ({ value, label: value })));
    assert.deepEqual(opts.map((o) => o.value), ALL.filter((s) => s !== "DRAFT" && s !== "DELETED"));
  });
});
