// 發布樣式版面判斷單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/render-style.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./render-style");
const M: M = await import(new URL("./render-style.ts", import.meta.url).href);
const { renderStyleOf, eventDateOf, TRAVEL_GROUP } = M;

describe("renderStyleOf", () => {
  test("有專屬版面的樣式", () => {
    for (const r of ["TYPE1", "CALENDAR", "TRAVEL", "SHOWCASE", "LONGTERM"]) assert.equal(renderStyleOf({ render: r }), r);
  });
  test("其餘沿用 TYPE3", () => {
    for (const r of ["TYPE3", "ALIAS", "DISTRIBUTOR", "FB", "", null]) assert.equal(renderStyleOf({ render: r }), "TYPE3");
  });
});

describe("eventDateOf", () => {
  const s = (title: string, itemSetSettings: Record<string, unknown> = {}) => ({ title, itemSetSettings });
  test("品項設定 eventDate 優先", () => {
    assert.equal(eventDateOf(s("11/5 上午場", { eventDate: "2026-12-01" })), "2026-12-01");
  });
  test("名稱中的完整日期", () => {
    assert.equal(eventDateOf(s("2026/11/5 上午場")), "2026-11-05");
    assert.equal(eventDateOf(s("2026年11月05日 導覽")), "2026-11-05");
    assert.equal(eventDateOf(s("場次 2026-1-9")), "2026-01-09");
  });
  test("只有月日時用指定年份", () => {
    assert.equal(eventDateOf(s("11/5 上午場"), 2027), "2027-11-05");
  });
  test("不合法或沒有日期 → 空字串", () => {
    assert.equal(eventDateOf(s("2026/2/30 場次")), "");
    assert.equal(eventDateOf(s("加購商品")), "");
    assert.equal(eventDateOf(s("加購", { eventDate: "abc" })), "");
  });
});

test("套裝行程品項分組", () => {
  assert.equal(TRAVEL_GROUP.STYLE9, "plan");
  assert.equal(TRAVEL_GROUP.TRAVEL_AIR_TICKET_RETURN, "return");
  assert.equal(TRAVEL_GROUP.STYLE5, undefined);
});
