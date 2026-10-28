// 贈品（#116）純函式單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/gift-logic.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type G = typeof import("./gift-logic");
const G: G = await import(new URL("./gift-logic.ts", import.meta.url).href);
const { allocateAutoGifts, checkPickGifts, giftLineUuid, seededRandom } = G;

const used = () => ({ inStock: new Map<number, number>(), backOrder: new Map<number, number>() });

describe("allocateAutoGifts", () => {
  test("有庫存全送；先現貨後預購", () => {
    const u = used();
    const r = allocateAutoGifts([{ salesRuleId: 1, itemId: 10, title: "提袋", quantity: 3 }], new Map([[10, { ownerId: 10, inStock: 2, backOrder: 5, title: "提袋" }]]), u);
    assert.deepEqual(r.gifts, [{ salesRuleId: 1, itemId: 10, qty: 3, inStockQty: 2, backOrderQty: 1 }]);
    assert.equal(u.inStock.get(10), 2);
    assert.equal(u.backOrder.get(10), 1);
  });
  test("扣掉購物袋已占用；不足送部分、送完不送並提示", () => {
    const u = used();
    u.inStock.set(10, 1);
    const r = allocateAutoGifts([{ salesRuleId: 1, itemId: 10, title: "", quantity: 2 }], new Map([[10, { ownerId: 10, inStock: 2, backOrder: 0, title: "提袋" }]]), u);
    assert.equal(r.gifts[0].qty, 1);
    assert.match(r.notes[0], /本次贈送 1 件/);
    const r2 = allocateAutoGifts([{ salesRuleId: 1, itemId: 10, title: "", quantity: 2 }], new Map([[10, { ownerId: 10, inStock: 2, backOrder: 0, title: "提袋" }]]), u);
    assert.equal(r2.gifts.length, 0);
    assert.match(r2.notes[0], /已送完/);
  });
  test("不在目錄（下架）→ 不送", () => {
    const r = allocateAutoGifts([{ salesRuleId: 1, itemId: 11, title: "x", quantity: 1 }], new Map(), used());
    assert.equal(r.gifts.length, 0);
  });
});

describe("checkPickGifts", () => {
  const pick = [{ salesRuleId: 5, giftTag: "贈", quantity: 2, mandatory: false, candidates: [{ itemId: 20, title: "A" }, { itemId: 21, title: "B" }] }];
  test("可選件數內保留並記錄優惠條件", () => {
    const r = checkPickGifts(pick, [{ key: "a", itemId: 20, qty: 1, title: "A" }, { key: "b", itemId: 21, qty: 1, title: "B" }]);
    assert.equal(r.allowed.get("a"), 1);
    assert.equal(r.allowed.get("b"), 1);
    assert.equal(r.ruleOf.get("a"), 5);
    assert.deepEqual(r.issues, []);
  });
  test("超過可選件數 → 調整；不符資格 → 移除", () => {
    const r = checkPickGifts(pick, [{ key: "a", itemId: 20, qty: 3, title: "A" }, { key: "c", itemId: 30, qty: 1, title: "C" }]);
    assert.equal(r.allowed.get("a"), 2);
    assert.equal(r.allowed.get("c"), 0);
    assert.equal(r.issues.length, 2);
  });
  test("沒有任何資格時 0 元贈品一律移除", () => {
    const r = checkPickGifts([], [{ key: "a", itemId: 20, qty: 1, title: "A" }]);
    assert.equal(r.allowed.get("a"), 0);
  });
  test("必選未選 → blockers；非必選 → 提示", () => {
    assert.equal(checkPickGifts([{ ...pick[0], mandatory: true }], []).blockers.length, 1);
    const r = checkPickGifts(pick, []);
    assert.equal(r.blockers.length, 0);
    assert.match(r.notes[0], /可選贈品 2 件/);
  });
});

describe("giftLineUuid／seededRandom", () => {
  test("uuid 為 32 碼且穩定", () => {
    const h = (s: string) => Buffer.from(s).toString("hex").padEnd(64, "0");
    assert.equal(giftLineUuid(1, 2, h).length, 32);
    assert.equal(giftLineUuid(1, 2, h), giftLineUuid(1, 2, h));
  });
  test("同種子同序列、範圍 0..1", () => {
    const a = seededRandom("x");
    const b = seededRandom("x");
    for (let i = 0; i < 5; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
    assert.notEqual(seededRandom("x")(), seededRandom("y")());
  });
});
