// 加退換商品重算優惠（PARITY #58）：node --experimental-strip-types --test lib/modules/orders/returns-pricing.test.ts
// 以正式引擎 evaluatePricing 驗證：退一件後滿額折扣失效、加購後打折生效。
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./returns-pricing") = await import(new URL("./returns-pricing.ts", import.meta.url).href);
const eng: typeof import("../marketing/pricing-rules") = await import(new URL("../marketing/pricing-rules.ts", import.meta.url).href);

const line = (orderItemId: number, price: number, total: number, discount = 0, o: Partial<import("./returns-pricing").DraftLine> = {}) => ({
  orderItemId, itemId: 100 + Math.abs(orderItemId), groupBuyItemSetId: 1, price, total, discount, status: "UNSHIPPING", bundleChild: false,
  orig: orderItemId > 0 ? { price, total, discount } : null, ...o,
});

test("引擎輸入：排除組合子項、贈品、數量 0、無商品；新增商品 key 為負數", () => {
  const items = [line(1, 100, 2), line(2, 50, 0), line(3, 10, 1, 0, { bundleChild: true }), line(4, 0, 1, 0, { gift: true }), line(-1, 80, 1), line(5, 9, 1, 0, { itemId: null })];
  assert.deepEqual(m.draftCartInputs(items).map((x) => x.key), [1, -1]);
  assert.equal(m.draftCartInputs([line(6, 10, 1, 0, { status: "BACKORDER" })])[0].backOrder, true);
});

test("未套用引擎：沿用列金額差額", () => {
  const items = [line(1, 100, 2, 20)];
  items[0].total = 1; // 退 1 件
  assert.equal(m.draftNewGrandTotal({ oriGrandTotal: 230, items }), 130);
});

const rule = (o: Record<string, unknown>) => ({ salesRuleId: 1, title: "滿千折百", category: "MINIMUM_PRICE_MEET", level: "ORDER", active: true, ...o }) as never;

test("正式引擎：滿 1000 折 100，退一件後未達門檻 → 折扣歸零、訂單金額正確", () => {
  // 原訂單：2×600＝1200，滿千折百 → 1100＋運費 100＝1200
  const items = [line(1, 600, 2)];
  const salesRules = [rule({ minimum: 1000, discount: 100, dollarOrPercentage: "DOLLAR" })];
  const before = eng.evaluatePricing({ lines: [{ key: 1, itemId: 101, title: "A", price: 600, quantity: 2 }], salesRules });
  assert.equal(before.totalDiscount, 100);
  items[0].total = 1;
  const res = eng.evaluatePricing({ lines: m.draftCartInputs(items).map((c) => ({ ...c, title: "A", price: c.price })), salesRules });
  assert.equal(res.totalDiscount, 0);
  m.applyLineDiscounts(items, res.lines);
  const g = m.draftNewGrandTotal({ oriGrandTotal: 1200, oriDiscount: 100, pricing: { totalDiscount: res.totalDiscount, rules: [], messages: [] }, items });
  assert.equal(g, 1200 - 600 + 100); // 少一件 600、折扣少 100 → 700
});

test("引擎各列折扣寫回草稿（含新增商品），未回傳的列歸 0；訂單金額以引擎折扣合計計算", () => {
  const items = [line(1, 100, 1)];
  items.push(line(-1, 100, 1, 0, { itemId: 101 }));
  const changed = m.applyLineDiscounts(items, [{ key: 1, discount: 10 }, { key: -1, discount: 30 }]);
  assert.deepEqual(changed.map((c) => c.orderItemId), [1, -1]);
  assert.deepEqual(items.map((i) => i.discount), [10, 30]);
  // 引擎沒回的列 → 折扣歸 0
  m.applyLineDiscounts(items, [{ key: 1, discount: 10 }]);
  assert.deepEqual(items.map((i) => i.discount), [10, 0]);
  const g = m.draftNewGrandTotal({ oriGrandTotal: 100, oriDiscount: 0, pricing: { totalDiscount: 40, rules: [], messages: [] }, items });
  assert.equal(g, 100 + 100 - 40);
});
