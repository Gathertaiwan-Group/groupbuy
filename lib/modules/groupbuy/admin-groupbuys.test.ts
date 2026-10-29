// 團購管理員授權（PARITY #37）：node --experimental-strip-types --test lib/modules/groupbuy/admin-groupbuys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./admin-groupbuys-logic") = await import(new URL("./admin-groupbuys-logic.ts", import.meta.url).href);

test("Editor 值的各種形狀", () => {
  assert.deepEqual(m.adminUserIdsFrom({ adminUserGroupBuys: [{ adminUserId: "3" }, { adminUserId: "5" }], "adminUserGroupBuys-many-count": "2" }), [3, 5]);
  assert.deepEqual(m.adminUserIdsFrom({ adminUserGroupBuys: { 0: { adminUserId: "7" }, 1: { adminUserId: "7" } } }), [7]);
  assert.deepEqual(m.adminUserIdsFrom({ "adminUserGroupBuys[].adminUserId": ["1", "2"] }), [1, 2]);
  assert.deepEqual(m.adminUserIdsFrom({ "adminUserGroupBuys-many-count": "0" }), []);
  assert.equal(m.adminUserIdsFrom({ title: "x" }), undefined);
  assert.deepEqual(m.adminUserIdsFrom({ adminUserGroupBuys: [{ adminUserId: "x" }, { adminUserId: "-1" }] }), []);
});

test("受限旗標與差異", () => {
  assert.equal(m.isGroupBuyRestricted({ groupBuyRestricted: true }), true);
  assert.equal(m.isGroupBuyRestricted({ groupBuyRestricted: "false" }), false);
  assert.equal(m.isGroupBuyRestricted(null), false);
  assert.deepEqual(m.diffAdminIds([1, 2, 3], [2, 4]), { add: [4], remove: [1, 3] });
});

test("restrictedGroupBuyDenied：受限帳戶只能帶授權的 groupBuyId（補E）", () => {
  assert.equal(m.restrictedGroupBuyDenied("405167", [405167, 405169]), false);
  assert.equal(m.restrictedGroupBuyDenied("405163", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied("405163", []), true);
  assert.equal(m.restrictedGroupBuyDenied(undefined, [405167]), false);
  assert.equal(m.restrictedGroupBuyDenied("", [405167]), false);
  assert.equal(m.restrictedGroupBuyDenied("abc", [405167]), false);
  assert.equal(m.restrictedGroupBuyDenied("undefined", [405167]), false);
  // 端點以 Number()／nOrNull 解析的其他寫法不能繞過
  assert.equal(m.restrictedGroupBuyDenied("12.0", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied("0xc", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied("1e1", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied("405,163", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied("405,167", [405167]), false);
  assert.equal(m.restrictedGroupBuyDenied("0", [405167]), true);
  assert.equal(m.restrictedGroupBuyDenied(" 405167 ", [405167]), false);
});

test("受限帳戶：要檢查的團購 id 含 groupBuyIds、Editor 欄位與團購 Editor 列 id", () => {
  const flat = (o: Record<string, string[]>) => new Map(Object.entries(o));
  // 團購 Editor：只帶 data[405163][…]（不帶網址 groupBuyId）也要檢查列 id
  assert.deepEqual(m.restrictedGroupBuyRefs("/ajax/GroupBuy/update", [], [], flat({ action: ["edit"], "data[405163][adminUserGroupBuys][0][adminUserId]": ["1"] })), ["405163"]);
  assert.deepEqual(m.restrictedGroupBuyRefs("/ajax/GroupBuy/delete", ["7"], [], flat({ "data[8][title]": ["x"] })), ["7", "8"]);
  // 其他 Editor：列 id 不是團購 id，只看 groupBuyId 欄位
  assert.deepEqual(m.restrictedGroupBuyRefs("/ajax/Item/update", [], [], flat({ "data[55][title]": ["x"], "data[55][groupBuyId]": ["9"] })), ["9"]);
  // markAsClosed：data[0][groupBuyIds] 換行分隔、參數 groupBuyIds 逗點分隔
  assert.deepEqual(m.restrictedGroupBuyRefs("/ajax/GroupBuy/markAsClosed", [], ["3,4"], flat({ "data[0][groupBuyIds]": ["5\n6"] })), ["3", "4", "5", "6"]);
  assert.deepEqual(m.restrictedGroupBuyRefs("/ajax/X", [" "], [""], flat({})), []);
  // 搭配 restrictedGroupBuyDenied：未授權的列 id 被拒
  assert.equal(m.restrictedGroupBuyRefs("/ajax/GroupBuy/update", [], [], flat({ "data[405163][title]": ["x"] })).some((v) => m.restrictedGroupBuyDenied(v, [1])), true);
});
