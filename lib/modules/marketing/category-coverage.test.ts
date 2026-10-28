// 29 種優惠條件逐類對照（PARITY #48）：每類至少一個「達標／未達標」案例，斷言依原站精靈欄位語意
// （spec/html/modal-salesrule-wizard.html 各 sr('<類別>') 的 minimum／dollarOrPercentage／discount／repeatable(maxApplyTimes)／tag1/tag2 標籤與 fieldInfo；
//  類別中文名見 spec/SPEC.md 優惠類別選單）。執行：node --experimental-strip-types --test lib/modules/marketing/category-coverage.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type PR = typeof import("./pricing-rules");
const PR: PR = await import(new URL("./pricing-rules.ts", import.meta.url).href);
const { evaluatePricing, SALES_RULE_CATEGORIES } = PR;
type Rule = import("./pricing-rules").PricingSalesRule;
type Line = import("./pricing-rules").PricingCartLine;

let seq = 1000;
const rule = (p: Partial<Rule> & { category: string }): Rule => ({
  salesRuleId: p.salesRuleId ?? seq++,
  title: p.title ?? p.category,
  dollarOrPercentage: "DOLLAR",
  discount: 0,
  minimum: 0,
  maxApplyTimes: -1,
  priority: 1,
  availableQuota: 100000,
  usedQuota: 0,
  active: true,
  ...p,
});
let itemSeq = 1;
const line = (key: string, price: number, quantity: number, p: Partial<Line> = {}): Line => ({ key, itemId: p.itemId ?? itemSeq++, title: key, price, quantity, groupBuyItemSetId: 10, ...p });
const run = (lines: Line[], rules: Rule[]) => evaluatePricing({ lines, salesRules: rules, now: "2026-10-23 12:00", groupBuyId: 1, random: () => 0 });
const covered = new Set<string>();
const cat = (c: string) => (covered.add(c), c);

describe("整張訂單", () => {
  test("MINIMUM_PRICE_MEET 整張訂單-金額滿多少：折金額／折數／重複滿額次數", () => {
    const c = cat("MINIMUM_PRICE_MEET");
    assert.equal(run([line("A", 600, 2)], [rule({ category: c, minimum: 1000, discount: 100, maxApplyTimes: 0 })]).totalDiscount, 100);
    assert.equal(run([line("A", 600, 2)], [rule({ category: c, minimum: 1000, discount: 10, dollarOrPercentage: "PERCENTAGE" })]).totalDiscount, 120); // 10＝九折
    assert.equal(run([line("A", 500, 5)], [rule({ category: c, minimum: 1000, discount: 100, maxApplyTimes: -1 })]).totalDiscount, 200); // 不限：每滿 1000
    assert.equal(run([line("A", 500, 5)], [rule({ category: c, minimum: 1000, discount: 100, maxApplyTimes: 0 })]).totalDiscount, 100); // 僅一次
    assert.equal(run([line("A", 900, 1)], [rule({ category: c, minimum: 1000, discount: 100 })]).totalDiscount, 0);
    assert.equal(run([line("A", 600, 2)], [rule({ category: c, minimum: 1000, discount: 50, dollarOrPercentage: "POINT", maxApplyTimes: 0 })]).points, 50);
  });
  test("GIFT_WITH_PURCHASE 整張訂單-滿額禮：滿額自動送贈品標籤商品 N 件", () => {
    const c = cat("GIFT_WITH_PURCHASE");
    const r = run([line("A", 1500, 1)], [rule({ category: c, minimum: 1000, discount: 1, tag: "贈品", maxApplyTimes: 0 })]);
    assert.deepEqual([r.gifts.length, r.gifts[0].quantity, r.gifts[0].mode, r.gifts[0].giftTag], [1, 1, "AUTO", "贈品"]);
    assert.equal(run([line("A", 999, 1)], [rule({ category: c, minimum: 1000, discount: 1, tag: "贈品" })]).gifts.length, 0);
    // 贈品本身（itemType=GIFT）不列入門檻
    assert.equal(run([line("A", 600, 1), line("G", 600, 1, { itemType: "GIFT" })], [rule({ category: c, minimum: 1000, discount: 1, tag: "贈品" })]).gifts.length, 0);
  });
  test("CREDIT_CARD 整張訂單-刷卡門檻：未滿只限制信用卡、可結帳", () => {
    const c = cat("CREDIT_CARD");
    const r = run([line("A", 400, 1)], [rule({ category: c, minimum: 500 })]);
    assert.deepEqual([r.creditCardAllowed, r.checkoutAllowed], [false, true]);
    assert.equal(run([line("A", 500, 1)], [rule({ category: c, minimum: 500 })]).creditCardAllowed, true);
  });
  test("CHECKOUT_MINIMUM_PRICE 結帳門檻(金額)：未滿不可結帳（以折扣後金額判斷）", () => {
    const c = cat("CHECKOUT_MINIMUM_PRICE");
    assert.equal(run([line("A", 400, 1)], [rule({ category: c, minimum: 500 })]).checkoutAllowed, false);
    assert.equal(run([line("A", 600, 1)], [rule({ category: c, minimum: 500 }), rule({ category: "MINIMUM_PRICE_MEET", minimum: 600, discount: 200 })]).checkoutAllowed, false);
    assert.equal(run([line("A", 500, 1)], [rule({ category: c, minimum: 500 })]).checkoutAllowed, true);
  });
});

describe("同品項", () => {
  test("MINIMUM_PIECE_CONSTRAINT 同品項-訂購數量限制：最少挑選 N 件", () => {
    const c = cat("MINIMUM_PIECE_CONSTRAINT");
    const r = rule({ category: c, minimum: 3 });
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] })], [r]).checkoutAllowed, false);
    assert.equal(run([line("A", 100, 3, { salesRuleIds: [r.salesRuleId] })], [r]).checkoutAllowed, true);
  });
  test("MINIMUM_PIECE_MEET 同品項-件數滿多少：滿 N 件每件折（可享每件商品）", () => {
    const c = cat("MINIMUM_PIECE_MEET");
    const r = rule({ category: c, minimum: 3, discount: 10 });
    assert.equal(run([line("A", 100, 3, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 30);
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 0);
    // 不同品項分開計算（未勾可跨品項合併）
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] }), line("B", 100, 2, { salesRuleIds: [r.salesRuleId], groupBuyItemSetId: 11 })], [r]).totalDiscount, 0);
    assert.equal(
      run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] }), line("B", 100, 2, { salesRuleIds: [r.salesRuleId], groupBuyItemSetId: 11 })], [{ ...r, applyToGroupBuy: true }]).totalDiscount,
      40,
    );
  });
  test("MINIMUM_PIECE_MEET_MAIN_PIECE 同品項-件數滿多少＋搭配主商品(標籤)滿件：主商品未達件數不折；折扣只給非主商品", () => {
    const c = cat("MINIMUM_PIECE_MEET_MAIN_PIECE");
    const r = rule({ category: c, minimum: 2, discount: 10, tag: "主", settings: { mainTagMinimum: 1 } });
    const b = line("B", 100, 2, { salesRuleIds: [r.salesRuleId] });
    assert.equal(run([line("M", 500, 1, { tags: ["主"] }), b], [r]).totalDiscount, 20);
    assert.equal(run([{ ...b }], [r]).totalDiscount, 0);
  });
  test("MINIMUM_PRICE_CONSTRAINT 同品項-最少訂購金額限制", () => {
    const c = cat("MINIMUM_PRICE_CONSTRAINT");
    const r = rule({ category: c, minimum: 1000 });
    assert.equal(run([line("A", 400, 2, { salesRuleIds: [r.salesRuleId] })], [r]).checkoutAllowed, false);
    assert.equal(run([line("A", 500, 2, { salesRuleIds: [r.salesRuleId] })], [r]).checkoutAllowed, true);
  });
  test("MINIMUM_PRICE_MEET_ITS 同品項-金額滿多少：滿額後每件折（最多幾件商品享優惠）", () => {
    const c = cat("MINIMUM_PRICE_MEET_ITS");
    const r = rule({ category: c, minimum: 1000, discount: 10, dollarOrPercentage: "PERCENTAGE", maxApplyTimes: 2 });
    assert.equal(run([line("A", 400, 3, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 80); // 2 件 × 9 折
    assert.equal(run([line("A", 400, 2, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 0);
    // 品項標籤＋商品標籤：門檻看品項標籤商品，折扣只給商品標籤
    const r2 = rule({ category: c, minimum: 1000, discount: 50, tag: "品項|折扣品" });
    const res = run([line("A", 1000, 1, { tags: ["品項"] }), line("D", 200, 2, { tags: ["折扣品"] })], [r2]);
    assert.equal(res.totalDiscount, 100);
    assert.equal(res.lines.find((l) => l.key === "A")!.discount, 0);
  });
  test("ITEMSET_LIMITED_ITEMS 同品項-商品種類限購：超過種類數不可結帳", () => {
    const c = cat("ITEMSET_LIMITED_ITEMS");
    const r = rule({ category: c, maxApplyTimes: 2 });
    const ls = ["A", "B", "C"].map((k) => line(k, 100, 1, { salesRuleIds: [r.salesRuleId] }));
    assert.equal(run(ls, [r]).checkoutAllowed, false);
    assert.equal(run(ls.slice(0, 2), [r]).checkoutAllowed, true);
  });
  test("X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT 同品項-X件商品原價，超過每件折扣Y（預設便宜的先折）", () => {
    const c = cat("X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT");
    const r = rule({ category: c, minimum: 2, discount: 50 });
    const ls = [line("A", 100, 1, { salesRuleIds: [r.salesRuleId] }), line("B", 200, 1, { salesRuleIds: [r.salesRuleId] }), line("C", 300, 1, { salesRuleIds: [r.salesRuleId] })];
    const res = run(ls, [r]);
    assert.equal(res.totalDiscount, 50);
    assert.equal(res.lines.find((l) => l.key === "A")!.discount, 50);
    assert.equal(run(ls.slice(0, 2), [r]).totalDiscount, 0);
  });
  test("ITEMSET_BUY_X_GOT_Y_FREE 同品項-同品項內商品買X件送Y件：每 X＋Y 件最便宜的 Y 件免費", () => {
    const c = cat("ITEMSET_BUY_X_GOT_Y_FREE");
    const r = rule({ category: c, minimum: 2, discount: 1 });
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] }), line("B", 80, 1, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 80);
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 0);
  });
  test("ITEMSET_BUNDLE_PRICE 同品項-組合價：任選 N 件組合價（最多幾組）", () => {
    const c = cat("ITEMSET_BUNDLE_PRICE");
    const r = rule({ category: c, minimum: 3, discount: 250, dollarOrPercentage: "BUNDLE_PRICE", maxApplyTimes: 1 });
    assert.equal(run([line("A", 100, 6, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 50); // 只 1 組
    assert.equal(run([line("A", 100, 6, { salesRuleIds: [r.salesRuleId] })], [{ ...r, maxApplyTimes: -1 }]).totalDiscount, 100);
    assert.equal(run([line("A", 100, 2, { salesRuleIds: [r.salesRuleId] })], [r]).totalDiscount, 0);
  });
});

describe("商品", () => {
  test("ITEM_PRICE_MEET 商品-滿額折扣：標籤商品任選滿額折總額（最多享幾次）", () => {
    const c = cat("ITEM_PRICE_MEET");
    const r = rule({ category: c, tag: "滿額商品", minimum: 1000, discount: 100, dollarOrPercentage: "DOLLAR_PACK_DISCOUNT", maxApplyTimes: -1 });
    assert.equal(run([line("A", 700, 3, { tags: ["滿額商品"] }), line("X", 5000, 1)], [r]).totalDiscount, 200);
    assert.equal(run([line("A", 700, 3, { tags: ["滿額商品"] })], [{ ...r, maxApplyTimes: 1 }]).totalDiscount, 100);
    assert.equal(run([line("A", 900, 1, { tags: ["滿額商品"] }), line("X", 5000, 1)], [r]).totalDiscount, 0);
  });
  test("TAG_MATCH 商品-標籤符合：任選滿 N 件每件折（最多幾個商品）", () => {
    const c = cat("TAG_MATCH");
    const r = rule({ category: c, tag: "紅標", minimum: 3, discount: 100 });
    assert.equal(run([line("A", 500, 3, { tags: ["紅標"] })], [r]).totalDiscount, 300);
    assert.equal(run([line("A", 500, 2, { tags: ["紅標"] })], [r]).totalDiscount, 0);
    assert.equal(run([line("A", 500, 3, { tags: ["紅標"] })], [{ ...r, maxApplyTimes: 2 }]).totalDiscount, 200);
  });
  test("ADDITIONAL_PURCHASE 加購價[標籤+件數](需搭配主商品)：主商品滿件後加購品享新售價；加購次數僅一次；超量或未搭配不可結帳", () => {
    const c = cat("ADDITIONAL_PURCHASE");
    const r = rule({ category: c, tag: "主|加購", minimum: 2, discount: 50, dollarOrPercentage: "SALE_PRICE", maxApplyTimes: 0 });
    const ok = run([line("M", 300, 2, { tags: ["主"] }), line("P", 100, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([ok.totalDiscount, ok.checkoutAllowed, ok.additionalPurchases[0].allowedUnits], [50, true, 1]);
    const over = run([line("M", 300, 2, { tags: ["主"] }), line("P", 100, 2, { tags: ["加購"] })], [r]);
    assert.deepEqual([over.totalDiscount, over.checkoutAllowed], [50, false]);
    const noMain = run([line("M", 300, 1, { tags: ["主"] }), line("P", 100, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([noMain.totalDiscount, noMain.checkoutAllowed], [0, false]);
    // 不限：每滿 2 件可加購 1 件
    assert.equal(run([line("M", 300, 4, { tags: ["主"] }), line("P", 100, 2, { tags: ["加購"] })], [{ ...r, maxApplyTimes: -1 }]).totalDiscount, 100);
  });
  test("ADDITIONAL_PURCHASE_OPTIONAL 加購價[標籤+件數]：未達標只是不給加購價、仍可結帳", () => {
    const c = cat("ADDITIONAL_PURCHASE_OPTIONAL");
    const r = rule({ category: c, tag: "主|加購", minimum: 2, discount: 50, dollarOrPercentage: "SALE_PRICE", maxApplyTimes: 0 });
    const res = run([line("M", 300, 1, { tags: ["主"] }), line("P", 100, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([res.totalDiscount, res.checkoutAllowed, res.additionalPurchases[0].optional], [0, true, true]);
    assert.equal(run([line("M", 300, 2, { tags: ["主"] }), line("P", 100, 2, { tags: ["加購"] })], [r]).checkoutAllowed, true);
  });
  test("ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET 加購價[標籤-金額滿](需搭配主商品)：訂單（加購品以外）滿額", () => {
    const c = cat("ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET");
    const r = rule({ category: c, tag: "加購", minimum: 1000, discount: 10, dollarOrPercentage: "PERCENTAGE", maxApplyTimes: 0 });
    const ok = run([line("A", 1000, 1), line("P", 200, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([ok.totalDiscount, ok.checkoutAllowed], [20, true]);
    const no = run([line("A", 999, 1), line("P", 200, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([no.totalDiscount, no.checkoutAllowed], [0, false]);
  });
  test("ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL 加購價[標籤-金額滿]：未達標仍可結帳", () => {
    const c = cat("ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL");
    const r = rule({ category: c, tag: "加購", minimum: 1000, discount: 10, dollarOrPercentage: "PERCENTAGE", maxApplyTimes: 0 });
    const no = run([line("A", 999, 1), line("P", 200, 1, { tags: ["加購"] })], [r]);
    assert.deepEqual([no.totalDiscount, no.checkoutAllowed], [0, true]);
    assert.equal(run([line("A", 1000, 1), line("P", 200, 1, { tags: ["加購"] })], [r]).totalDiscount, 20);
  });
  const giftCase = (c: string, byPiece: boolean, pick: boolean, wholeOrder: boolean) => {
    cat(c);
    const tag = wholeOrder ? "贈品" : "主商品|贈品";
    const r = rule({ category: c, tag, minimum: byPiece ? 3 : 1000, discount: 1, maxApplyTimes: -1 });
    const main = (price: number, qty: number) => line("M", price, qty, wholeOrder ? {} : { tags: ["主商品"] });
    const hit = run([main(byPiece ? 100 : 1000, byPiece ? 6 : 2)], [r]);
    assert.equal(hit.gifts.length, 1, c);
    assert.deepEqual([hit.gifts[0].quantity, hit.gifts[0].mode, hit.gifts[0].giftTag], [2, pick ? "PICK" : "AUTO", "贈品"], c);
    const miss = run([main(byPiece ? 100 : 900, byPiece ? 2 : 1)], [r]);
    assert.equal(miss.gifts.length, 0, c);
    if (!wholeOrder) {
      // 非主商品不列入門檻
      assert.equal(run([line("X", 5000, 5)], [r]).gifts.length, 0, c);
    }
    assert.equal(run([main(byPiece ? 100 : 1000, byPiece ? 6 : 2)], [{ ...r, maxApplyTimes: 0 }]).gifts[0].quantity, 1, c);
  };
  test("GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID 禮物(整張訂單滿額+標籤)：客人自選", () => giftCase("GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID", false, true, true));
  test("GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID 禮物(整張訂單滿額+標籤+不自選)：自動獲得", () => giftCase("GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID", false, false, true));
  test("GIFT_MINIMUM_PRICE_MEET 禮物(主商品滿額+標籤)：客人自選", () => giftCase("GIFT_MINIMUM_PRICE_MEET", false, true, false));
  test("GIFT_MINIMUM_PRICE_MEET_NO_PICK 禮物(主商品滿額+標籤+不自選)：自動獲得", () => giftCase("GIFT_MINIMUM_PRICE_MEET_NO_PICK", false, false, false));
  test("GIFT_MINIMUM_PIECE_MEET 禮物(主商品滿件數+標籤)：客人自選", () => giftCase("GIFT_MINIMUM_PIECE_MEET", true, true, false));
  test("GIFT_MINIMUM_PIECE_MEET_NO_PICK 禮物(主商品滿件數+標籤+不自選)：自動獲得", () => giftCase("GIFT_MINIMUM_PIECE_MEET_NO_PICK", true, false, false));
  test("GIFT_LOTTERY 禮物(隨機/福袋)：隨機挑一件", () => {
    const c = cat("GIFT_LOTTERY");
    const r = rule({ category: c, tag: "福袋", minimum: 1, discount: 1, maxApplyTimes: 0 });
    const res = run([line("A", 100, 1, { salesRuleIds: [r.salesRuleId] })], [r]);
    assert.deepEqual([res.gifts.length, res.gifts[0].random, res.gifts[0].giftTagRule, res.gifts[0].mode], [1, true, "ONE", "AUTO"]);
  });
  test("ITEM_BUY_X_GOT_Y_FREE 同商品買X件送Y件：同一商品每買 X 件送 Y 件同商品", () => {
    const c = cat("ITEM_BUY_X_GOT_Y_FREE");
    const r = rule({ category: c, minimum: 2, discount: 1 });
    const res = run([line("A", 100, 5, { salesRuleIds: [r.salesRuleId], itemId: 77 })], [r]);
    assert.deepEqual([res.gifts[0].quantity, res.gifts[0].sameItemId, res.totalDiscount], [2, 77, 0]);
    assert.equal(run([line("A", 100, 1, { salesRuleIds: [r.salesRuleId] })], [r]).gifts.length, 0);
  });
  test("ITEM_EXCLUDED 商品-不列入優惠計算：綁定商品不計入其他優惠門檻", () => {
    const c = cat("ITEM_EXCLUDED");
    const ex = rule({ category: c });
    const meet = rule({ category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100 });
    assert.equal(run([line("A", 600, 1), line("B", 600, 1, { salesRuleIds: [ex.salesRuleId] })], [ex, meet]).totalDiscount, 0);
    assert.equal(run([line("A", 600, 1), line("B", 600, 1)], [ex, meet]).totalDiscount, 100);
  });
  test("ITEM_PACKAGE 商品-組合包(標籤)：加總數量／依標籤個別計算", () => {
    const c = cat("ITEM_PACKAGE");
    const sum = rule({ category: c, tag: "盒|口味", settings: { packRule: { rule: "SUM_TAG", subItemTotal: 6 } } });
    assert.equal(run([line("B", 300, 1, { tags: ["盒"] }), line("F", 0, 5, { tags: ["口味"] })], [sum]).checkoutAllowed, false);
    assert.equal(run([line("B", 300, 1, { tags: ["盒"] }), line("F", 0, 6, { tags: ["口味"] })], [sum]).checkoutAllowed, true);
    const byTag = rule({ category: c, tag: "盒|甜|鹹", settings: { packRule: { rule: "BY_TAG" } } });
    assert.equal(run([line("B", 300, 2, { tags: ["盒"] }), line("S", 0, 2, { tags: ["甜"] }), line("Y", 0, 2, { tags: ["鹹"] })], [byTag]).checkoutAllowed, true);
    const bad = run([line("B", 300, 2, { tags: ["盒"] }), line("S", 0, 3, { tags: ["甜"] }), line("Y", 0, 1, { tags: ["鹹"] })], [byTag]);
    assert.equal(bad.checkoutAllowed, false);
    assert.match(bad.constraints[0].message, /「甜」需選擇2件（目前3件）/);
  });
});

test("29 類全部有案例", () => {
  assert.deepEqual([...SALES_RULE_CATEGORIES].filter((c) => !covered.has(c)), []);
  assert.equal(SALES_RULE_CATEGORIES.length, 29);
});
