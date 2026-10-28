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
