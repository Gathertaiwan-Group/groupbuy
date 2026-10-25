// 排程純邏輯單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/items/scheduler.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type L = typeof import("./scheduler-logic");
const L: L = await import(new URL("./scheduler-logic.ts", import.meta.url).href);
const { parseTaipei, taipeiSec, taipeiTodayStartIso, buildPlans, fieldValuesOf } = L;

const base = { entity: "GroupBuyItemSet", field: "online", fieldValue: "1", batchConfigs: "", entityIds: [], entityTitles: [], dateSchedule: "", syncParentChild: undefined };

describe("時間", () => {
  test("台灣時間 → UTC", () => {
    assert.equal(parseTaipei("2026-10-25 08:00:00"), "2026-10-25T00:00:00.000Z");
    assert.equal(parseTaipei("2026-10-25 08:00"), "2026-10-25T00:00:00.000Z");
    assert.equal(parseTaipei("2026-02-30 08:00"), null);
    assert.equal(parseTaipei("明天"), null);
  });
  test("UTC → 台灣時間字串", () => {
    assert.equal(taipeiSec("2026-10-24T16:30:05Z"), "2026-10-25 00:30:05");
    assert.equal(taipeiSec(null), "");
  });
  test("台灣今天 00:00", () => {
    assert.equal(taipeiTodayStartIso(Date.parse("2026-10-24T17:00:00Z")), "2026-10-24T16:00:00.000Z");
  });
});

describe("buildPlans", () => {
  test("batchConfigs 上架（scheduler.js 統一模式）", () => {
    const bc = JSON.stringify([{ entityId: 5, title: "10.A", field: "online", value: "1", dateSchedule: "2026-10-25 12:00:00" }]);
    const r = buildPlans({ ...base, batchConfigs: bc });
    assert.ok("plans" in r);
    assert.equal(r.plans[0].dbAction, "ONLINE");
    assert.equal(r.plans[0].actionKey, "ITEM_SET_ONLINE");
    assert.equal(r.plans[0].syncParentChild, false);
  });
  test("商品變價＋同步主子商品", () => {
    const bc = JSON.stringify([
      { entityId: 7, title: "X", field: "price", value: "199", dateSchedule: "2026-10-25 12:00:00", syncParentChild: "true" },
      { entityId: 8, title: "Y", field: "price", value: "88.5", dateSchedule: "2026-10-26 12:00:00" },
    ]);
    const r = buildPlans({ ...base, entity: "Item", batchConfigs: bc });
    assert.ok("plans" in r);
    assert.deepEqual(r.plans.map((p) => [p.dbAction, p.actionKey, p.syncParentChild]), [["PRICE", "ITEM_PRICE", true], ["PRICE", "ITEM_PRICE", false]]);
  });
  test("無 batchConfigs 時用 entityIds＋fieldValue", () => {
    const r = buildPlans({ ...base, entity: "Item", fieldValue: "0", entityIds: [3, 4], entityTitles: ["a", "b"], dateSchedule: "2026-10-25 12:00" });
    assert.ok("plans" in r);
    assert.equal(r.plans.length, 2);
    assert.equal(r.plans[1].actionKey, "ITEM_OFFLINE");
  });
  test("錯誤：價格、時間、欄位與對象不符、空清單", () => {
    const mk = (o: Record<string, unknown>, entity = "Item") =>
      buildPlans({ ...base, entity, batchConfigs: JSON.stringify([{ entityId: 1, title: "t", field: "price", value: "10", dateSchedule: "2026-10-25 12:00", ...o }]) });
    assert.ok("error" in mk({ value: "-1" }));
    assert.ok("error" in mk({ value: "abc" }));
    assert.ok("error" in mk({ dateSchedule: "" }));
    assert.ok("error" in mk({}, "GroupBuyItemSet"));
    assert.ok("error" in mk({ entityId: "x" }));
    assert.ok("error" in buildPlans({ ...base }));
    assert.ok("error" in buildPlans({ ...base, entity: "GroupBuy", entityIds: [1], dateSchedule: "2026-10-25 12:00" }));
    assert.ok("error" in buildPlans({ ...base, batchConfigs: "{bad" }));
  });
  test("重複設定只留一筆", () => {
    const one = { entityId: 5, title: "A", field: "online", value: "0", dateSchedule: "2026-10-25 12:00:00" };
    const r = buildPlans({ ...base, batchConfigs: JSON.stringify([one, one]) });
    assert.ok("plans" in r);
    assert.equal(r.plans.length, 1);
  });
});

test("fieldValues 鍵維持代碼（scheduler.js 以 fieldString==='online' 判斷）", () => {
  assert.deepEqual(fieldValuesOf("online", "1"), [{ field: "online", value: "1", fieldString: "online", valueString: "1" }]);
});
