// pricing-rules 單元測試（node:test，不需任何套件）。
// 執行：node --test lib/modules/marketing/pricing-rules.test.ts   （或 node lib/modules/marketing/tools/test-pricing-rules.mjs）
// Node 以型別剝除直接執行 .ts；實際模組以動態 import 載入（需帶 .ts 副檔名），型別則由 typeof import 取得。
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type PR = typeof import("./pricing-rules");
const PR: PR = await import(new URL("./pricing-rules.ts", import.meta.url).href);
const { evaluatePricing, parseTags, parseRepeatMinimum, parseTieredMinimums, matchPostcode, bindingFlags, computeSmartPriorities, ruleAvailability, validateCoupon, resolveGifts, ruleLevel } = PR;

type Rule = import("./pricing-rules").PricingSalesRule;
type Line = import("./pricing-rules").PricingCartLine;
type Coupon = import("./pricing-rules").PricingCoupon;

const NOW = "2026-10-23 12:00";
let seq = 1;
function rule(p: Partial<Rule> & { category: string }): Rule {
  return {
    salesRuleId: p.salesRuleId ?? seq++,
    title: p.title ?? `rule-${p.category}`,
    dollarOrPercentage: "DOLLAR",
    discount: 0,
    minimum: 0,
    maxApplyTimes: -1,
    priority: 1,
    availableQuota: 100000,
    usedQuota: 0,
    active: true,
    ...p,
  };
}
function line(key: string, price: number, quantity: number, p: Partial<Line> = {}): Line {
  return { key, itemId: p.itemId ?? key.charCodeAt(0) * 100 + key.length, title: key, price, quantity, groupBuyItemSetId: 10, ...p };
}
function coupon(p: Partial<Coupon> & { category: string }): Coupon {
  return { code: "CODE", groupBuyCouponId: 1, dollarOrPercentage: "DOLLAR", discount: 0, minimum: 0, active: true, availableQuota: -1, usedCount: 0, groupBuyId: 1, ...p };
}
const run = (lines: Line[], salesRules: Rule[], extra: Partial<import("./pricing-rules").PricingInput> = {}) =>
  evaluatePricing({ lines, salesRules, now: NOW, groupBuyId: 1, ...extra });

describe("解析與分類工具", () => {
  test("parseTags 去空白/空項/重複並保留順序", () => {
    assert.deepEqual(parseTags(" A|B| |A|贈品 "), ["A", "B", "贈品"]);
    assert.deepEqual(parseTags(null), []);
  });
  test("parseRepeatMinimum 格式 最小單位#折扣", () => {
    assert.deepEqual(parseRepeatMinimum("1000#100"), { minimum: 1000, discount: 100 });
    assert.equal(parseRepeatMinimum("abc"), null);
    assert.equal(parseRepeatMinimum("0#5"), null);
  });
  test("parseTieredMinimums 多行依門檻排序", () => {
    assert.deepEqual(parseTieredMinimums("3000#3\n2000#2\n4000#5"), [
      { minimum: 2000, discount: 2 },
      { minimum: 3000, discount: 3 },
      { minimum: 4000, discount: 5 },
    ]);
  });
  test("matchPostcode 支援 * 與逗點", () => {
    assert.equal(matchPostcode("1*,2*,302", "106"), true);
    assert.equal(matchPostcode("1*,2*,302", "302"), true);
    assert.equal(matchPostcode("1*,2*,302", "303"), false);
    assert.equal(matchPostcode("", "999"), true);
    assert.equal(matchPostcode("1*", ""), false);
  });
  test("ruleLevel 與 bindingFlags", () => {
    assert.equal(ruleLevel("MINIMUM_PRICE_MEET"), "ORDER");
    assert.equal(ruleLevel("MINIMUM_PIECE_MEET"), "ITEM_SET");
    assert.equal(ruleLevel("TAG_MATCH"), "ITEM");
    assert.deepEqual(bindingFlags("MINIMUM_PRICE_MEET"), { levelItemSetItem: false, levelItemSet: false, levelItem: false, categoryAllowExcludeItemTag: true });
    assert.deepEqual(bindingFlags("CREDIT_CARD"), { levelItemSetItem: false, levelItemSet: false, levelItem: false, categoryAllowExcludeItemTag: false });
    assert.equal(bindingFlags("MINIMUM_PIECE_MEET").levelItemSet, true);
    assert.equal(bindingFlags("TAG_MATCH").levelItem, true);
    assert.equal(bindingFlags("GIFT_MINIMUM_PRICE_MEET").levelItemSetItem, true);
    assert.equal(bindingFlags("GIFT_MINIMUM_PRICE_MEET").levelItem, false);
  });
  test("computeSmartPriorities：訂單/同品項門檻高者數字小；商品門檻高者數字大", () => {
    const res = computeSmartPriorities([
      { salesRuleId: 1, category: "MINIMUM_PRICE_MEET", minimum: 1000, priority: 1 },
      { salesRuleId: 2, category: "MINIMUM_PRICE_MEET", minimum: 3000, priority: 1 },
      { salesRuleId: 3, category: "TAG_MATCH", minimum: 100, priority: 1 },
      { salesRuleId: 4, category: "TAG_MATCH", minimum: 500, priority: 1 },
    ]);
    assert.deepEqual(res, [
      { salesRuleId: 1, priority: 2 },
      { salesRuleId: 2, priority: 1 },
      { salesRuleId: 3, priority: 1 },
      { salesRuleId: 4, priority: 2 },
    ]);
  });
});

describe("可用性 ruleAvailability", () => {
  test("停用/未開始/已結束/數量用完", () => {
    assert.equal(ruleAvailability(rule({ category: "MINIMUM_PRICE_MEET", active: false }), { now: NOW }).reason, "停用中");
    assert.equal(ruleAvailability(rule({ category: "MINIMUM_PRICE_MEET", dateStart: "2026-11-01 00:00" }), { now: NOW }).reason, "尚未開始");
    assert.equal(ruleAvailability(rule({ category: "MINIMUM_PRICE_MEET", dateEnd: "2026-10-01 00:00" }), { now: NOW }).reason, "已結束");
    assert.equal(ruleAvailability(rule({ category: "MINIMUM_PRICE_MEET", availableQuota: 10, usedQuota: 10 }), { now: NOW }).available, false);
    assert.equal(ruleAvailability(rule({ category: "MINIMUM_PRICE_MEET", dateStart: "2026-10-01 00:00", dateEnd: "2026-10-31 23:59" }), { now: NOW }).available, true);
  });
  test("會員方案/郵遞區號/需搭配折扣碼", () => {
    const r = rule({ category: "MINIMUM_PRICE_MEET", royaltyProgramIds: [5] });
    assert.equal(ruleAvailability(r, { now: NOW, customer: { royaltyProgramId: 6 } }).available, false);
    assert.equal(ruleAvailability(r, { now: NOW, customer: { royaltyProgramId: 5 } }).available, true);
    const pc = rule({ category: "MINIMUM_PRICE_MEET", settings: { includedPostcodes: "1*" } });
    assert.equal(ruleAvailability(pc, { now: NOW, postcode: "220" }).available, false);
    assert.equal(ruleAvailability(pc, { now: NOW, postcode: "106" }).available, true);
    const co = rule({ category: "MINIMUM_PRICE_MEET", salesRuleId: 777 });
    assert.equal(ruleAvailability(co, { now: NOW, couponOnlySalesRuleIds: [777] }).reason, "需搭配折扣碼");
    assert.equal(ruleAvailability(co, { now: NOW, couponOnlySalesRuleIds: [777], unlockedSalesRuleIds: [777] }).available, true);
  });
});

describe("整張訂單-金額滿多少 MINIMUM_PRICE_MEET", () => {
  const base = () => [line("A", 600, 1), line("B", 500, 1)]; // 1100
  const big = () => [line("A", 600, 2), line("B", 550, 2)]; // 2300
  test("滿1000折100（僅一次）", () => {
    const r = run(base(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1 })]);
    assert.equal(r.subtotal, 1100);
    assert.equal(r.orderDiscount, 100);
    assert.equal(r.grandTotalWithoutShipping, 1000);
    assert.equal(r.appliedRules[0].discount, 100);
  });
  test("不限次數(-1)也只折一次：滿1000折100 在 2300 → 100", () => {
    const r = run(big(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: -1 })]);
    assert.equal(r.orderDiscount, 100);
    assert.equal(r.appliedRules[0].times, 1);
  });
  test("滿300折50：600 → 50、300 → 50、299 → 0", () => {
    const rs = () => [rule({ category: "MINIMUM_PRICE_MEET", minimum: 300, discount: 50 })];
    const r600 = run([line("A", 300, 2)], rs());
    assert.equal(r600.orderDiscount, 50);
    assert.equal(r600.grandTotalWithoutShipping, 550);
    assert.equal(r600.appliedRules[0].times, 1);
    assert.equal(run([line("A", 300, 1)], rs()).orderDiscount, 50);
    const r299 = run([line("A", 299, 1)], rs());
    assert.equal(r299.orderDiscount, 0);
    assert.equal(r299.appliedRules.length, 0);
  });
  test("規律重複＋最多套用次數上限：滿300折50、每再滿300再折50、上限2次 → 1200 折 100", () => {
    const mk = (max: number) => [rule({ category: "MINIMUM_PRICE_MEET", minimum: 300, discount: 50, maxApplyTimes: max, settings: { repeatMinimumString: "300#50" } })];
    assert.equal(run([line("A", 300, 4)], mk(-1)).orderDiscount, 200);
    assert.equal(run([line("A", 300, 4)], mk(2)).orderDiscount, 100);
    assert.equal(run([line("A", 300, 4)], mk(1)).orderDiscount, 50);
    assert.equal(run([line("A", 300, 1)], mk(-1)).orderDiscount, 50);
  });
  test("商品-滿額折扣 ITEM_PRICE_MEET 同樣只折一次", () => {
    const r = run([line("A", 300, 2, { salesRuleIds: [702] })], [rule({ salesRuleId: 702, category: "ITEM_PRICE_MEET", minimum: 300, discount: 50 })]);
    assert.equal(r.itemDiscount, 50);
  });
  test("依折數 10＝九折", () => {
    const r = run(base(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "PERCENTAGE", discount: 10 })]);
    assert.equal(r.orderDiscount, 110);
  });
  test("會員點數累積：只給點數不折金額", () => {
    const r = run(big(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "POINT", discount: 50, maxApplyTimes: -1 })]);
    assert.equal(r.orderDiscount, 0);
    assert.equal(r.points, 50);
  });
  test("規律重複 repeatMinimumString 1000起每再滿500再折30", () => {
    const r = run(big(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, settings: { repeatMinimumString: "500#30" } })]);
    assert.equal(r.orderDiscount, 160);
  });
  test("不規律級距 tieredMinimumsString 取最高一級", () => {
    const r = run(big(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "PERCENTAGE", discount: 5, settings: { tieredMinimumsString: "2000#10\n3000#15" } })]);
    assert.equal(r.orderDiscount, 230);
  });
  test("折扣後訂單最少金額", () => {
    const r = run(base(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 300, maxApplyTimes: 1, settings: { minDiscountTotalPrice: 900 } })]);
    assert.equal(r.orderDiscount, 200);
    assert.equal(r.grandTotalWithoutShipping, 900);
  });
  test("不合併計算標籤 excludeTag 的商品不列入門檻", () => {
    const lines = [line("A", 600, 1), line("B", 500, 1, { tags: ["特價"] })];
    const r = run(lines, [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, excludeTag: "特價" })]);
    assert.equal(r.orderDiscount, 0);
  });
  test("商品-不列入優惠計算 ITEM_EXCLUDED 綁定的商品被排除", () => {
    const lines = [line("A", 600, 1), line("B", 500, 1, { salesRuleIds: [901] })];
    const r = run(lines, [rule({ salesRuleId: 901, category: "ITEM_EXCLUDED" }), rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100 })]);
    assert.equal(r.orderDiscount, 0);
    assert.ok(r.appliedRules.some((a) => a.salesRuleId === 901));
  });
  test("折扣不會讓金額變負數", () => {
    const r = run(base(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 5000, maxApplyTimes: 1 })]);
    assert.equal(r.orderDiscount, 1100);
    assert.equal(r.grandTotalWithoutShipping, 0);
  });
  test("[整張訂單] 優先數字小者先套；依折數以扣掉先前訂單折扣後計算", () => {
    const r = run(base(), [
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "PERCENTAGE", discount: 10, priority: 2 }),
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, priority: 1, maxApplyTimes: 1 }),
    ]);
    assert.equal(r.appliedRules[0].discount, 100);
    assert.equal(r.appliedRules[1].discount, 100);
    assert.equal(r.orderDiscount, 200);
  });
  test("限定郵遞區號與會員方案", () => {
    const pc = [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, settings: { includedPostcodes: "1*" } })];
    assert.equal(run(base(), pc, { postcode: "220" }).orderDiscount, 0);
    assert.equal(run(base(), pc, { postcode: "106" }).orderDiscount, 100);
    const rp = [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, royaltyProgramIds: [7] })];
    assert.equal(run(base(), rp, { customer: { customerId: 1, royaltyProgramId: 7 } }).orderDiscount, 100);
    assert.equal(run(base(), rp).orderDiscount, 0);
  });
});

describe("相同優惠標籤互斥（可合併計算除外）", () => {
  const lines = () => [line("A", 600, 2), line("B", 550, 2)]; // 2300
  test("同標籤只套用優先者", () => {
    const r = run(lines(), [
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 2000, discount: 300, maxApplyTimes: 1, priority: 1, tag: "滿額" }),
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1, priority: 2, tag: "滿額" }),
    ]);
    assert.equal(r.orderDiscount, 300);
    assert.equal(r.appliedRules.length, 1);
  });
  test("沒有標籤則都會套用；都可合併計算也都會套用", () => {
    const noTag = run(lines(), [
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 2000, discount: 300, maxApplyTimes: 1 }),
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1 }),
    ]);
    assert.equal(noTag.orderDiscount, 400);
    const comb = run(lines(), [
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 2000, discount: 300, maxApplyTimes: 1, tag: "滿額", combinable: true }),
      rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1, tag: "滿額", combinable: true }),
    ]);
    assert.equal(comb.orderDiscount, 400);
  });
});

describe("贈品類", () => {
  const big = () => [line("A", 600, 2, { tags: ["主商品"] }), line("B", 550, 2)]; // 2300
  test("整張訂單-滿額禮：依原站「重複滿額次數」0＝僅一次、-1＝不限（每滿送）、N＝最多 N 次", () => {
    const g = (maxApplyTimes: number, settings?: Record<string, unknown>) =>
      run(big(), [rule({ category: "GIFT_WITH_PURCHASE", minimum: 1000, dollarOrPercentage: "PIECE", discount: 1, tag: "贈品", maxApplyTimes, settings })]);
    assert.equal(g(-1).gifts[0].quantity, 2, "2300 元滿1000送1，不限 → 送 2");
    assert.equal(g(0).gifts[0].quantity, 1, "僅一次 → 送 1");
    assert.equal(g(1).gifts[0].quantity, 1, "有上限 1 次 → 送 1");
    assert.equal(g(5).gifts[0].quantity, 2, "有上限 5 次，實際只滿 2 次 → 送 2");
    assert.equal(g(-1, { repeatMinimumString: "500#1" }).gifts[0].quantity, 3, "另設規律重複 500：1+floor(1300/500)=3");
    const r = g(0);
    assert.equal(r.gifts.length, 1);
    assert.equal(r.gifts[0].mode, "AUTO");
    assert.equal(r.gifts[0].giftTag, "贈品");
    assert.equal(r.totalDiscount, 0);
  });
  test("折扣與贈品次數分開計算：600 元同時套滿300折50(不限) 與 滿300送1(不限) → 折 50、送 2", () => {
    const r = run([line("A", 300, 2)], [
      rule({ salesRuleId: 901, category: "MINIMUM_PRICE_MEET", minimum: 300, discount: 50, maxApplyTimes: -1, tag: "折扣" }),
      rule({ salesRuleId: 902, category: "GIFT_WITH_PURCHASE", minimum: 300, dollarOrPercentage: "PIECE", discount: 1, maxApplyTimes: -1, tag: "贈品" }),
    ]);
    assert.equal(r.orderDiscount, 50);
    assert.equal(r.gifts[0].quantity, 2);
  });
  test("滿件贈：滿3件送1，不限 → 7 件送 2", () => {
    const r = run([line("A", 100, 7, { tags: ["主商品"] })], [rule({ category: "GIFT_MINIMUM_PIECE_MEET_NO_PICK", minimum: 3, discount: 1, maxApplyTimes: -1, tag: "主商品|贈品" })]);
    assert.equal(r.gifts[0].quantity, 2);
  });
  test("滿額禮僅一次、擇一贈送", () => {
    const r = run(big(), [rule({ category: "GIFT_WITH_PURCHASE", minimum: 1000, dollarOrPercentage: "PIECE", discount: 1, maxApplyTimes: 1, tag: "贈品", settings: { giftTagRule: "ONE" } })]);
    assert.equal(r.gifts[0].quantity, 1);
    assert.equal(r.gifts[0].giftTagRule, "ONE");
    assert.equal(r.gifts[0].random, true);
  });
  test("同贈品標籤的滿額禮不合併送（高門檻優先）", () => {
    const r = run(big(), [
      rule({ category: "GIFT_WITH_PURCHASE", minimum: 2000, discount: 1, maxApplyTimes: 1, tag: "贈品", priority: 1, title: "滿2000" }),
      rule({ category: "GIFT_WITH_PURCHASE", minimum: 1000, discount: 1, maxApplyTimes: 1, tag: "贈品", priority: 2, title: "滿1000" }),
    ]);
    assert.deepEqual(r.gifts.map((g) => g.title), ["滿2000"]);
  });
  test("主商品滿額+標籤（客人自選 PICK）", () => {
    const r = run(big(), [rule({ category: "GIFT_MINIMUM_PRICE_MEET", minimum: 1000, discount: 1, maxApplyTimes: 1, tag: "主商品|贈品" })]);
    assert.equal(r.gifts.length, 1);
    assert.equal(r.gifts[0].mode, "PICK");
    const r2 = run(big(), [rule({ category: "GIFT_MINIMUM_PRICE_MEET", minimum: 1500, discount: 1, maxApplyTimes: 1, tag: "主商品|贈品" })]);
    assert.equal(r2.gifts.length, 0, "主商品只有1200，未達1500");
  });
  test("主商品滿件數+標籤+不自選（AUTO）與主商品庫存類型", () => {
    const rules = [rule({ category: "GIFT_MINIMUM_PIECE_MEET_NO_PICK", minimum: 3, discount: 1, maxApplyTimes: 1, tag: "主商品|贈品" })];
    assert.equal(run([line("A", 100, 2, { tags: ["主商品"] })], rules).gifts.length, 0);
    const ok = run([line("A", 100, 3, { tags: ["主商品"] })], rules);
    assert.equal(ok.gifts[0].mode, "AUTO");
    const instock = [rule({ category: "GIFT_MINIMUM_PIECE_MEET_NO_PICK", minimum: 3, discount: 1, tag: "主商品|贈品", mainItemType: "INSTOCK" })];
    assert.equal(run([line("A", 100, 3, { tags: ["主商品"], backOrder: true })], instock).gifts.length, 0);
  });
  test("整張訂單滿額+標籤（TOTAL_PAID）客人自選", () => {
    const r = run([line("A", 600, 1), line("B", 500, 1)], [rule({ category: "GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID", minimum: 1000, discount: 1, maxApplyTimes: 1, tag: "贈品", settings: { giftMandatory: true } })]);
    assert.equal(r.gifts[0].mode, "PICK");
    assert.equal(r.gifts[0].mandatory, true);
  });
  test("隨機/福袋 GIFT_LOTTERY", () => {
    const r = run([line("A", 100, 1, { tags: ["主"] })], [rule({ category: "GIFT_LOTTERY", minimum: 1, discount: 1, maxApplyTimes: 1, tag: "主|福袋" })], { random: () => 0.75 });
    assert.equal(r.gifts[0].giftTagRule, "ONE");
    assert.equal(r.gifts[0].random, true);
    assert.equal(r.gifts[0].mode, "AUTO");
  });
  test("resolveGifts：AUTO 全部、擇一、PICK、同商品", () => {
    const res = resolveGifts(
      [
        { salesRuleId: 1, title: "a", category: "GIFT_WITH_PURCHASE", giftTag: "贈品", quantity: 2, mode: "AUTO", giftTagRule: "ALL", mandatory: false, random: false, randomIndexSeed: 0 },
        { salesRuleId: 2, title: "b", category: "GIFT_WITH_PURCHASE", giftTag: "贈品", quantity: 1, mode: "AUTO", giftTagRule: "ONE", mandatory: false, random: true, randomIndexSeed: 0.6 },
        { salesRuleId: 3, title: "c", category: "GIFT_MINIMUM_PRICE_MEET", giftTag: "贈品", quantity: 1, mode: "PICK", giftTagRule: "ALL", mandatory: true, random: false, randomIndexSeed: 0 },
        { salesRuleId: 4, title: "d", category: "ITEM_BUY_X_GOT_Y_FREE", giftTag: null, quantity: 3, mode: "AUTO", giftTagRule: "ALL", mandatory: false, random: false, randomIndexSeed: 0, sameItemId: 99 },
      ],
      { 贈品: [{ itemId: 1, title: "襪子紅" }, { itemId: 2, title: "襪子綠" }] },
    );
    assert.deepEqual(res.auto.filter((a) => a.salesRuleId === 1).map((a) => a.itemId), [1, 2]);
    assert.deepEqual(res.auto.filter((a) => a.salesRuleId === 2).map((a) => a.itemId), [2]);
    assert.equal(res.pick[0].candidates.length, 2);
    assert.deepEqual(res.auto.find((a) => a.salesRuleId === 4), { salesRuleId: 4, itemId: 99, title: "", quantity: 3 });
  });
});

describe("限制類", () => {
  const lines = () => [line("A", 600, 1), line("B", 500, 1)];
  test("結帳門檻 CHECKOUT_MINIMUM_PRICE", () => {
    const r = run(lines(), [rule({ category: "CHECKOUT_MINIMUM_PRICE", minimum: 2000 })]);
    assert.equal(r.checkoutAllowed, false);
    assert.equal(r.creditCardAllowed, true);
    assert.ok(r.messages.includes("結帳訂單金額(不含運)需滿2000"));
    assert.equal(run(lines(), [rule({ category: "CHECKOUT_MINIMUM_PRICE", minimum: 1000 })]).checkoutAllowed, true);
  });
  test("刷卡門檻 CREDIT_CARD 只限制信用卡", () => {
    const r = run(lines(), [rule({ category: "CREDIT_CARD", minimum: 2000 })]);
    assert.equal(r.creditCardAllowed, false);
    assert.equal(r.checkoutAllowed, true);
  });
  test("同品項-訂購數量限制 最少/最多", () => {
    const rules = [rule({ salesRuleId: 501, category: "MINIMUM_PIECE_CONSTRAINT", minimum: 2, maxApplyTimes: 5 })];
    assert.equal(run([line("A", 100, 1, { salesRuleIds: [501] })], rules).checkoutAllowed, false);
    assert.equal(run([line("A", 100, 6, { salesRuleIds: [501] })], rules).checkoutAllowed, false);
    assert.equal(run([line("A", 100, 3, { salesRuleIds: [501] })], rules).checkoutAllowed, true);
    assert.equal(run([line("A", 100, 1)], rules).checkoutAllowed, true, "未綁定的品項不受限制");
  });
  test("同品項-最少訂購金額限制、商品種類限購", () => {
    assert.equal(run([line("A", 600, 1, { salesRuleIds: [502] })], [rule({ salesRuleId: 502, category: "MINIMUM_PRICE_CONSTRAINT", minimum: 1000 })]).checkoutAllowed, false);
    const kinds = [rule({ salesRuleId: 503, category: "ITEMSET_LIMITED_ITEMS", minimum: 2, maxApplyTimes: 3 })];
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [503] })], kinds).checkoutAllowed, false);
    assert.equal(run([line("A", 100, 1, { salesRuleIds: [503] }), line("B", 100, 1, { salesRuleIds: [503] })], kinds).checkoutAllowed, true);
  });
  test("組合包 SUM_TAG 子商品數量", () => {
    const rules = [rule({ category: "ITEM_PACKAGE", tag: "主|子", settings: { packRule: { rule: "SUM_TAG", subItemTotal: 3 } } })];
    assert.equal(run([line("M", 1000, 1, { tags: ["主"] }), line("S", 0, 2, { tags: ["子"] })], rules).checkoutAllowed, false);
    assert.equal(run([line("M", 1000, 1, { tags: ["主"] }), line("S", 0, 3, { tags: ["子"] })], rules).checkoutAllowed, true);
  });
});

describe("同品項類", () => {
  const two = () => [line("A", 100, 2, { salesRuleIds: [601] }), line("B", 300, 1, { salesRuleIds: [601] })];
  test("件數滿多少：每件折20", () => {
    const r = run(two(), [rule({ salesRuleId: 601, category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 20 })]);
    assert.equal(r.itemDiscount, 60);
  });
  test("最多幾件享優惠＋商品折扣順序", () => {
    const asc = run(two(), [rule({ salesRuleId: 601, category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 20, maxApplyTimes: 2 })]);
    assert.equal(asc.lines[0].discount, 40);
    assert.equal(asc.lines[1].discount, 0);
    const desc = run(two(), [rule({ salesRuleId: 601, category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 20, maxApplyTimes: 2, settings: { priceSortOrder: "DESC" } })]);
    assert.equal(desc.lines[0].discount, 20);
    assert.equal(desc.lines[1].discount, 20);
  });
  test("總折扣金額 DOLLAR_PACK_DISCOUNT 依金額比例分攤", () => {
    const r = run(two(), [rule({ salesRuleId: 601, category: "MINIMUM_PIECE_MEET", minimum: 3, dollarOrPercentage: "DOLLAR_PACK_DISCOUNT", discount: 50 })]);
    assert.equal(r.itemDiscount, 50);
    assert.equal(r.lines[0].discount, 20);
    assert.equal(r.lines[1].discount, 30);
  });
  test("依折數", () => {
    const r = run(two(), [rule({ salesRuleId: 601, category: "MINIMUM_PIECE_MEET", minimum: 3, dollarOrPercentage: "PERCENTAGE", discount: 10 })]);
    assert.equal(r.itemDiscount, 50);
  });
  test("不可跨品項合併時依品項分組；可跨品項合併則合併計算", () => {
    const lines = () => [line("A", 100, 2, { salesRuleIds: [602], groupBuyItemSetId: 10 }), line("B", 300, 1, { salesRuleIds: [602], groupBuyItemSetId: 11 })];
    assert.equal(run(lines(), [rule({ salesRuleId: 602, category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 20, applyToGroupBuy: false })]).itemDiscount, 0);
    assert.equal(run(lines(), [rule({ salesRuleId: 602, category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 20, applyToGroupBuy: true })]).itemDiscount, 60);
  });
  test("依原價折數 PERCENTAGE_RETAIL_PRICE", () => {
    const r = run([line("A", 80, 1, { retailPrice: 100, salesRuleIds: [603] })], [rule({ salesRuleId: 603, category: "MINIMUM_PIECE_MEET", minimum: 1, dollarOrPercentage: "PERCENTAGE_RETAIL_PRICE", discount: 30 })]);
    assert.equal(r.itemDiscount, 10);
  });
  test("件數滿多少+搭配主商品(標籤)滿件", () => {
    const rules = [rule({ salesRuleId: 604, category: "MINIMUM_PIECE_MEET_MAIN_PIECE", minimum: 2, discount: 10, tag: "主商品", settings: { mainTagMinimum: 1 } })];
    const withMain = run([line("M", 1000, 1, { tags: ["主商品"] }), line("A", 100, 2, { salesRuleIds: [604] })], rules);
    assert.equal(withMain.itemDiscount, 20);
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [604] })], rules).itemDiscount, 0);
  });
  test("同品項-金額滿多少：新售價", () => {
    const r = run([line("A", 100, 3, { salesRuleIds: [605] }), line("B", 150, 2, { salesRuleIds: [605] })], [rule({ salesRuleId: 605, category: "MINIMUM_PRICE_MEET_ITS", minimum: 500, dollarOrPercentage: "SALE_PRICE", discount: 80 })]);
    assert.equal(r.itemDiscount, 200);
  });
  test("同品項滿額標籤商品折扣（品項標籤|商品標籤）", () => {
    const r = run([line("C", 400, 2, { tags: ["品項標籤"] }), line("D", 200, 1, { tags: ["商品標籤"] })], [rule({ category: "MINIMUM_PRICE_MEET_ITS", minimum: 500, discount: 30, tag: "品項標籤|商品標籤" })]);
    assert.equal(r.itemDiscount, 30);
    assert.equal(r.lines[1].discount, 30);
  });
  test("X件商品原價，超過每件折扣Y", () => {
    const lines = () => [line("A", 100, 2, { salesRuleIds: [606] }), line("B", 300, 2, { salesRuleIds: [606] })];
    const asc = run(lines(), [rule({ salesRuleId: 606, category: "X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT", minimum: 2, discount: 50 })]);
    assert.equal(asc.lines[0].discount, 100);
    assert.equal(asc.lines[1].discount, 0);
    const desc = run(lines(), [rule({ salesRuleId: 606, category: "X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT", minimum: 2, discount: 50, settings: { priceSortOrder: "DESC" } })]);
    assert.equal(desc.lines[1].discount, 100);
  });
  test("同品項內商品買X件送Y件：送最便宜的", () => {
    const r = run([line("A", 100, 2, { salesRuleIds: [607] }), line("B", 200, 1, { salesRuleIds: [607] })], [rule({ salesRuleId: 607, category: "ITEMSET_BUY_X_GOT_Y_FREE", minimum: 2, dollarOrPercentage: "PIECE", discount: 1 })]);
    assert.equal(r.itemDiscount, 100);
    assert.equal(r.lines[0].discount, 100);
  });
  test("同品項-組合價", () => {
    const rules = (max: number) => [rule({ salesRuleId: 608, category: "ITEMSET_BUNDLE_PRICE", minimum: 3, dollarOrPercentage: "BUNDLE_PRICE", discount: 500, maxApplyTimes: max })];
    assert.equal(run([line("A", 200, 3, { salesRuleIds: [608] })], rules(-1)).itemDiscount, 100);
    assert.equal(run([line("A", 200, 6, { salesRuleIds: [608] })], rules(-1)).itemDiscount, 200);
    assert.equal(run([line("A", 200, 6, { salesRuleIds: [608] })], rules(1)).itemDiscount, 100);
  });
});

describe("商品類", () => {
  test("商品-滿額折扣：總折扣金額與折數", () => {
    const lines = () => [line("A", 600, 1, { salesRuleIds: [701] }), line("B", 500, 1, { salesRuleIds: [701] })];
    const pack = run(lines(), [rule({ salesRuleId: 701, category: "ITEM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "DOLLAR_PACK_DISCOUNT", discount: 99 })]);
    assert.equal(pack.itemDiscount, 99);
    assert.equal(pack.lines[0].discount + pack.lines[1].discount, 99);
    const pct = run(lines(), [rule({ salesRuleId: 701, category: "ITEM_PRICE_MEET", minimum: 1000, dollarOrPercentage: "PERCENTAGE", discount: 15 })]);
    assert.equal(pct.itemDiscount, 165);
  });
  test("商品-標籤符合：需全部符合 / 任一符合", () => {
    const both = [line("R", 100, 1, { tags: ["紅"] }), line("G", 100, 1, { tags: ["綠"] })];
    assert.equal(run(both, [rule({ category: "TAG_MATCH", tag: "紅|綠", minimum: 2, discount: 10, settings: { tagMatchRule: "ALL" } })]).itemDiscount, 20);
    const onlyRed = [line("R", 100, 1, { tags: ["紅"] })];
    assert.equal(run(onlyRed, [rule({ category: "TAG_MATCH", tag: "紅|綠", minimum: 1, discount: 10, settings: { tagMatchRule: "ALL" } })]).itemDiscount, 0);
    assert.equal(run(onlyRed, [rule({ category: "TAG_MATCH", tag: "紅|綠", minimum: 1, discount: 10, settings: { tagMatchRule: "ANY" } })]).itemDiscount, 10);
  });
  test("組合價（標籤符合）：紅標任選2＋綠標任選1為一組", () => {
    const r = run([line("R", 100, 4, { tags: ["紅"] }), line("G", 100, 1, { tags: ["綠"] })], [rule({ category: "TAG_MATCH", tag: "紅|綠", minimum: 0, discount: 30, settings: { tagMinimums: "2|1" } })]);
    assert.equal(r.itemDiscount, 90);
    assert.equal(r.appliedRules[0].times, 1);
  });
  test("[商品] 優先數字大者先套", () => {
    const mk = (pP: number, pQ: number) =>
      run([line("A", 100, 1, { tags: ["甲", "乙"] })], [
        rule({ category: "TAG_MATCH", tag: "甲", minimum: 1, dollarOrPercentage: "SALE_PRICE", discount: 50, priority: pP }),
        rule({ category: "TAG_MATCH", tag: "乙", minimum: 1, discount: 10, priority: pQ }),
      ]);
    assert.equal(mk(1, 5).lines[0].totalPriceAfterDiscount, 50);
    assert.equal(mk(5, 1).lines[0].totalPriceAfterDiscount, 40);
  });
  test("加購價[標籤+件數](需搭配主商品)", () => {
    const rules = (cat: string) => [rule({ category: cat, tag: "主商品|加購", minimum: 1, dollarOrPercentage: "SALE_PRICE", discount: 50, maxApplyTimes: 1 })];
    const ok = run([line("M", 500, 1, { tags: ["主商品"] }), line("X", 200, 1, { tags: ["加購"] })], rules("ADDITIONAL_PURCHASE"));
    assert.equal(ok.lines[1].discount, 150);
    assert.equal(ok.checkoutAllowed, true);
    assert.equal(ok.additionalPurchases[0].allowedUnits, 1);
    const noMain = run([line("X", 200, 1, { tags: ["加購"] })], rules("ADDITIONAL_PURCHASE"));
    assert.equal(noMain.checkoutAllowed, false);
    const optional = run([line("X", 200, 1, { tags: ["加購"] })], rules("ADDITIONAL_PURCHASE_OPTIONAL"));
    assert.equal(optional.checkoutAllowed, true);
    assert.equal(optional.itemDiscount, 0);
    const tooMany = run([line("M", 500, 1, { tags: ["主商品"] }), line("X", 200, 2, { tags: ["加購"] })], rules("ADDITIONAL_PURCHASE"));
    assert.equal(tooMany.checkoutAllowed, false);
    assert.equal(tooMany.lines[1].discount, 150);
  });
  test("加購價[標籤-金額滿]：訂單滿額後指定商品加購價", () => {
    const r = run([line("A", 1200, 1), line("X", 300, 1, { tags: ["加購"] })], [rule({ category: "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET", tag: "加購", minimum: 1000, dollarOrPercentage: "SALE_PRICE", discount: 99, maxApplyTimes: 1 })]);
    assert.equal(r.lines[1].discount, 201);
  });
  test("商品-同商品買X件送Y件：額外贈送同商品", () => {
    const r = run([line("A", 100, 5, { salesRuleIds: [702], itemId: 55 })], [rule({ salesRuleId: 702, category: "ITEM_BUY_X_GOT_Y_FREE", minimum: 2, dollarOrPercentage: "PIECE", discount: 1 })]);
    assert.equal(r.gifts[0].sameItemId, 55);
    assert.equal(r.gifts[0].quantity, 2);
    assert.equal(r.itemDiscount, 0);
  });
  test("依折數四捨五入到整數", () => {
    const r = run([line("A", 999, 1, { salesRuleIds: [703] })], [rule({ salesRuleId: 703, category: "ITEM_PRICE_MEET", minimum: 1, dollarOrPercentage: "PERCENTAGE", discount: 15 })]);
    assert.equal(r.itemDiscount, 150);
  });
});

describe("團購優惠卷", () => {
  const lines = () => [line("A", 600, 1), line("B", 500, 1)]; // 1100, 2件
  test("整張訂單-金額滿足最小單位：折扣金額", () => {
    const r = run(lines(), [], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 300 }) });
    assert.equal(r.couponDiscount, 300);
    assert.equal(r.grandTotalWithoutShipping, 800);
    assert.equal(r.coupon?.applied, true);
  });
  test("依折數＋折抵金額上限", () => {
    const r = run(lines(), [], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", minimum: 0, dollarOrPercentage: "PERCENTAGE", discount: 20, maxDiscount: 150 }) });
    assert.equal(r.couponDiscount, 150);
  });
  test("整張訂單-件數未達", () => {
    const r = run(lines(), [], { coupon: coupon({ category: "MINIMUM_PIECE_MEET", minimum: 3, discount: 100 }) });
    assert.equal(r.couponDiscount, 0);
    assert.equal(r.coupon?.applied, false);
    assert.ok(r.messages.includes("訂單件數需滿3件才能使用此折扣碼"));
  });
  test("每滿最小單位金額折多少（會累算）", () => {
    const r = run(lines(), [], { coupon: coupon({ category: "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE", minimum: 500, discount: 50 }) });
    assert.equal(r.couponDiscount, 100);
  });
  test("不累算 vs 會累算：同為 2300 元滿1000折100", () => {
    const big = () => [line("A", 600, 2), line("B", 550, 2)]; // 2300
    const once = run(big(), [], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100 }) });
    assert.equal(once.couponDiscount, 100, "整張訂單-金額滿足最小單位：只折一次");
    const every = run(big(), [], { coupon: coupon({ category: "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE", minimum: 1000, discount: 100 }) });
    assert.equal(every.couponDiscount, 200, "滿最小單位金額折多少金額(會累算)：每滿 1000 折一次");
  });
  test("綁定優惠條件 SALES_RULE：解鎖需搭配折扣碼的優惠條件", () => {
    const rules = [rule({ salesRuleId: 801, category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1 })];
    assert.equal(run(lines(), rules, { couponOnlySalesRuleIds: [801] }).totalDiscount, 0);
    const r = run(lines(), rules, { couponOnlySalesRuleIds: [801], coupon: coupon({ category: "SALES_RULE", salesRuleId: 801 }) });
    assert.equal(r.totalDiscount, 100);
    assert.equal(r.coupon?.applied, true);
    assert.equal(r.coupon?.unlockedSalesRuleId, 801);
  });
  test("免運費、運費條件x、會員獲點、隨機點數", () => {
    assert.equal(run(lines(), [], { coupon: coupon({ category: "FREE_SHIPPING", minimum: 1000 }) }).freeShipping, true);
    const notYet = run(lines(), [], { coupon: coupon({ category: "FREE_SHIPPING", minimum: 2000 }) });
    assert.equal(notYet.freeShipping, false);
    assert.ok(notYet.messages.includes("訂單金額需滿2000才能免運費"));
    assert.equal(run(lines(), [], { coupon: coupon({ category: "FREE_SHIPPING_X" }) }).shippingConditionX, true);
    assert.equal(run(lines(), [], { coupon: coupon({ category: "POINT", discount: 50 }) }).points, 50);
    assert.equal(run(lines(), [], { coupon: coupon({ category: "POINT_RANDOM", minimum: 10, discount: 20 }), random: () => 0.5 }).points, 15);
  });
  test("驗證：停用/他團/次數/會員限定/會員身份", () => {
    assert.equal(validateCoupon(coupon({ category: "POINT", active: false })).reason, "此折扣碼已停用");
    assert.equal(validateCoupon(coupon({ category: "POINT", groupBuyId: 1 }), { groupBuyId: 2 }).valid, false);
    assert.equal(validateCoupon(coupon({ category: "POINT", groupBuyId: 1, applyToAllGroupBuy: true }), { groupBuyId: 2 }).valid, true);
    assert.equal(validateCoupon(coupon({ category: "POINT", availableQuota: 2, usedCount: 2 })).valid, false);
    assert.equal(validateCoupon(coupon({ category: "POINT", maxUses: 1, usedCount: 1 })).valid, false);
    assert.equal(validateCoupon(coupon({ category: "POINT", customerOnly: true })).reason, "此折扣碼限會員使用，請先登入");
    assert.equal(validateCoupon(coupon({ category: "POINT", royaltyProgramIds: [3] }), { customer: { customerId: 1, royaltyProgramId: 4 } }).valid, false);
    const invalid = run(lines(), [], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", discount: 100, active: false }) });
    assert.equal(invalid.couponDiscount, 0);
    assert.equal(invalid.coupon?.valid, false);
  });
  test("不可合併計算的優惠卷遇到其他優惠時不套用", () => {
    const r = run(lines(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1 })], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", discount: 300, combinable: false }) });
    assert.equal(r.couponDiscount, 0);
    assert.equal(r.totalDiscount, 100);
    assert.ok(r.messages.includes("此折扣碼無法與其他優惠合併使用"));
    const ok = run(lines(), [rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, maxApplyTimes: 1 })], { coupon: coupon({ category: "MINIMUM_PRICE_MEET", discount: 300, combinable: true }) });
    assert.equal(ok.totalDiscount, 400);
  });
});
