// 團購受限帳戶（PARITY #37，補F）：node --experimental-strip-types --test lib/modules/groupbuy/restricted-scope.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./restricted-scope-logic") = await import(new URL("./restricted-scope-logic.ts", import.meta.url).href);

const flat = (o: Record<string, string | string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
const refsOf = (path: string, query: string, body: Record<string, string | string[]> = {}, json?: unknown) => {
  const r = m.extractRestrictedRefs(path, new URLSearchParams(query), flat(body), json);
  const out: Record<string, string[]> = {};
  for (const [k, v] of r.refs) out[k] = [...v].sort();
  return { refs: out, unverifiable: r.unverifiable };
};

test("團購參照：各種參數名、陣列、Editor 欄位、拆數字（不能用千分位／空白／指數繞過）", () => {
  assert.deepEqual(refsOf("/ajax/X/list", "groupBuyId=405167").refs, { groupBuy: ["405167"] });
  assert.deepEqual(refsOf("/ajax/X/list", "groupBuyId[]=1&groupBuyId[]=2").refs, { groupBuy: ["1", "2"] });
  assert.deepEqual(refsOf("/ajax/X/list", "", { "data[0][toGroupBuyId]": "7", fromGroupBuyId: "8", bGroupBuyId: "9", excludedGroupBuyId: "10" }).refs, {
    groupBuy: ["10", "7", "8", "9"],
  });
  assert.deepEqual(refsOf("/ajax/X/list", "groupBuyId=4,05").refs, { groupBuy: ["4", "5"] });
  assert.deepEqual(refsOf("/ajax/X/list", "groupBuyId=12%2034").refs, { groupBuy: ["12", "34"] });
  assert.deepEqual(refsOf("/ajax/X/list", "groupBuyIds=1e1").refs, { groupBuy: ["1"] });
  // 0＝所有訂單頁（不算參照）
  assert.deepEqual(refsOf("/backend/SalesOrder/list", "groupBuyId=0").refs, {});
  // 排程的 foreignId＝團購 id（只在 Scheduler 路由）
  assert.deepEqual(refsOf("/ajax/Scheduler/list", "foreignId=33").refs, { groupBuy: ["33"] });
  assert.deepEqual(refsOf("/ajax/Other/list", "foreignId=33").refs, {});
});

test("JSON 字串內的參照（json／query／targets／rows）", () => {
  assert.deepEqual(refsOf("/ajax/ItemBundleV2/saveBundle", "", { json: JSON.stringify({ groupBuyId: 5, items: [{ itemId: 6 }] }) }).refs, {
    groupBuy: ["5"],
    item: ["6"],
  });
  assert.deepEqual(refsOf("/backend/SalesOrderExport/batchAction", "", { query: '{"extra":{"groupBuyId":"9"}}' }).refs, { groupBuy: ["9"] });
  assert.deepEqual(refsOf("/ajax/Item/copyToGroupBuy", "", {}, { targets: [{ groupBuyId: 11 }], items: [{ itemId: 12 }] }).refs, {
    groupBuy: ["11"],
    item: ["12"],
  });
  assert.deepEqual(refsOf("/ajax/X", "", { note: "{not json" }).refs, {});
});

test("資源參照：訂單、uuid、商品、短網址、出貨紀錄、客服對話 uuid", () => {
  assert.deepEqual(refsOf("/ajax/SalesOrder/get", "salesOrderId=900001").refs, { order: ["900001"] });
  assert.deepEqual(refsOf("/backend/SalesOrder/printOrder", "salesOrderId=1&salesOrderId=2").refs, { order: ["1", "2"] });
  assert.deepEqual(refsOf("/backend/SalesOrder/show", "uuid=ABC123").refs, { orderUuid: ["ABC123"] });
  assert.deepEqual(refsOf("/ajax/SalesOrder/renewCVSPickup", "", { "data[0][uuids]": "A1,A2" }).refs, { orderUuid: ["A1", "A2"] });
  assert.deepEqual(refsOf("/ajax/GroupBuy/switchShortUrl", "", { shortUrl1: "ak98i", shortUrl2: "zz" }).refs, { shortUrl: ["ak98i", "zz"] });
  assert.deepEqual(refsOf("/backend/ShippingRecord/downloadFile", "shippingRecordId=5").refs, { shippingRecord: ["5"] });
  assert.deepEqual(refsOf("/ajax/Item/get", "itemId=3").refs, { item: ["3"] });
  assert.deepEqual(refsOf("/backend/helpdesk/Conversation/toUrl", "uuid=77").refs, { conversation: ["77"] });
});

test("Editor 列 id 依路由前綴對應資料表；create 不算；對不到資料表 → unverifiable", () => {
  assert.deepEqual(refsOf("/ajax/SalesOrder/update", "", { action: "edit", "data[900001][staffNote]": "x" }).refs, { order: ["900001"] });
  assert.deepEqual(refsOf("/ajax/GroupBuy/update", "", { action: "edit", "data[405167][title]": "x" }).refs, { groupBuy: ["405167"] });
  assert.deepEqual(refsOf("/ajax/GroupBuyItemSet/update", "groupBuyId=1", { action: "edit", "data[55][title]": "x" }).refs, {
    gbis: ["55"],
    groupBuy: ["1"],
  });
  assert.deepEqual(refsOf("/ajax/HomeViewSection/update", "", { action: "edit", "data[8][title]": "x" }).refs, { homeViewSection: ["8"] });
  assert.deepEqual(refsOf("/ajax/SalesOrder/save", "groupBuyId=1", { action: "create", "data[0][staffNote]": "x" }).refs, { groupBuy: ["1"] });
  assert.deepEqual(refsOf("/ajax/Unknown/update", "groupBuyId=1", { action: "edit", "data[99][x]": "y" }).unverifiable, ["99"]);
});

test("路由政策", () => {
  assert.equal(m.routePolicy("/ajax/SalesOrder/list"), "filtered");
  assert.equal(m.routePolicy("/backend/SalesOrder/list"), "filtered");
  assert.equal(m.routePolicy("/backend/SalesOrderExport/batchAction"), "filtered");
  assert.equal(m.routePolicy("/ajax/ShippingRecord/list"), "filtered");
  assert.equal(m.routePolicy("/ajax/SalesOrderCVSTrace/listPickup"), "filtered");
  assert.equal(m.routePolicy("/ajax/Customer/list"), "deny");
  assert.equal(m.routePolicy("/backend/CustomerPointSummary/download"), "deny");
  assert.equal(m.routePolicy("/ajax/wms/Warehouse/list"), "deny");
  assert.equal(m.routePolicy("/ajax/SalesAnalysis/statistics"), "deny");
  assert.equal(m.routePolicy("/ajax/GroupBuySysTagRef/removeTag"), "scoped");
  assert.equal(m.routePolicy("/ajax/GroupBuySysTagRef/list"), "deny");
  assert.equal(m.routePolicy("/ajax/AdminUser/changePassword"), "neutral");
  assert.equal(m.routePolicy("/ajax/Lookup/flatRateShipping"), "neutral");
  assert.equal(m.routePolicy("/ajax/SalesOrder/get"), "scoped");
  assert.equal(m.routePolicy("/ajax/GroupBuy/switchShortUrl"), "scoped");
  assert.equal(m.restrictedParamDenied("/ajax/Item/list", new URLSearchParams("groupBuyId=1&uidAll=true"), new Map()), true);
  assert.equal(m.restrictedParamDenied("/ajax/Item/list", new URLSearchParams("groupBuyId=1"), new Map()), false);
});

test("判定", () => {
  const ok = { ok: true };
  // scoped：至少一個參照、全部授權
  assert.deepEqual(m.restrictedDecision("scoped", [1], true, 0, 0, [1, 2]), ok);
  assert.equal(m.restrictedDecision("scoped", [1, 3], true, 0, 0, [1, 2]).ok, false);
  assert.equal(m.restrictedDecision("scoped", [], false, 0, 0, [1]).ok, false, "沒有參照的跨團購請求");
  assert.equal(m.restrictedDecision("scoped", [], true, 1, 0, [1]).ok, false, "參照找不到資料");
  assert.equal(m.restrictedDecision("scoped", [1], true, 0, 1, [1]).ok, false, "Editor 列 id 對不到資料表");
  // 授權 0 團的受限帳戶：任何帶參照的請求都拒絕
  assert.equal(m.restrictedDecision("scoped", [405167], true, 0, 0, []).ok, false);
  // filtered／neutral：沒有參照可放行，有參照仍須授權
  assert.deepEqual(m.restrictedDecision("filtered", [], false, 0, 0, []), ok);
  assert.equal(m.restrictedDecision("filtered", [9], true, 0, 0, [1]).ok, false);
  assert.deepEqual(m.restrictedDecision("neutral", [], false, 0, 0, []), ok);
  assert.equal(m.restrictedDecision("deny", [1], true, 0, 0, [1]).ok, false);
});
