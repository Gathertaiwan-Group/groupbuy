// shipping-fee 單元測試（Node 內建 test runner；型別剝除直接載入 .ts）
// 執行：node --test "lib/modules/shipping/tests/*.test.mjs"（Node 22 需加 --experimental-strip-types）
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateShippingFee,
  evaluateRule,
  thresholdFee,
  parseTieredPrices,
  parseShippingTagLines,
  computeMetrics,
  categoryMessage,
  expandAreas,
  isIslandPostcode,
} from "../shipping-fee.ts";

let seq = 1;
const rule = (o = {}) => ({
  flatRateShippingId: o.flatRateShippingId ?? seq++,
  title: o.title ?? "宅配",
  shippingType: "NORMAL",
  category: "PRICE",
  x: 999,
  y: 80,
  z: 0,
  ...o,
  flatRateShippingSettings: { freeShippingLabel: "免運", ...(o.flatRateShippingSettings ?? {}) },
});
const line = (price, quantity = 1, o = {}) => ({ price, quantity, ...o });
const calc = (r, lines, extra = {}) => calculateShippingFee({ rules: [r], lines, selectedRuleId: r.flatRateShippingId, ...extra });

test("PRICE：金額 ≤ x 收 y、> x 收 z（原站模擬：x 元時 y、x+1 元時 z）", () => {
  const r = rule();
  assert.equal(calc(r, [line(999)]).shippingAmount, 80);
  assert.equal(calc(r, [line(1000)]).shippingAmount, 0);
  assert.equal(calc(r, [line(500, 2)]).shippingAmount, 0);
  assert.equal(calc(r, [line(1000)]).rule.freeShipping, true);
  assert.equal(calc(r, [line(1000)]).freeShippingLabel, "免運");
});

test("x ≤ 0 視為無門檻：一律收 y", () => {
  const r = rule({ x: 0, y: 60, z: 0 });
  assert.equal(calc(r, [line(5000)]).shippingAmount, 60);
});

test("額外滿足條件(x#z)：取指標超過的最高級距", () => {
  const r = rule({ x: 999, y: 300, z: 250, flatRateShippingSettings: { main: { tieredPricesString: "1999#200\n2999#150\n3999#0" } } });
  assert.equal(calc(r, [line(800)]).shippingAmount, 300);
  assert.equal(calc(r, [line(1500)]).shippingAmount, 250);
  assert.equal(calc(r, [line(2500)]).shippingAmount, 200);
  assert.equal(calc(r, [line(3500)]).shippingAmount, 150);
  assert.equal(calc(r, [line(4000)]).shippingAmount, 0);
  assert.deepEqual(parseTieredPrices("1999#200\r\n2999#150\nabc\n3999#0#E"), [
    { x: 1999, z: 200, type: "P" },
    { x: 2999, z: 150, type: "P" },
    { x: 3999, z: 0, type: "E" },
  ]);
});

test("PIECE / WEIGHT / PER_PIECE", () => {
  const p = rule({ category: "PIECE", x: 3, y: 100, z: 0 });
  assert.equal(calc(p, [line(100, 3)]).shippingAmount, 100);
  assert.equal(calc(p, [line(100, 4)]).shippingAmount, 0);
  const w = rule({ category: "WEIGHT", x: 5, y: 150, z: 250 });
  assert.equal(calc(w, [line(100, 2, { weight: 2 })]).shippingAmount, 150);
  assert.equal(calc(w, [line(100, 3, { weight: 2 })]).shippingAmount, 250);
  const pp = rule({ category: "PER_PIECE", x: 5, y: 50, z: 40 });
  assert.equal(calc(pp, [line(10, 3)]).shippingAmount, 150);
  assert.equal(calc(pp, [line(10, 6)]).shippingAmount, 240);
});

test("贈品、組合子項、不列入運費計算的商品不計件數/金額", () => {
  const m = computeMetrics([
    line(100, 2),
    line(0, 1, { gift: true }),
    line(50, 3, { bundleChild: true }),
    line(500, 1, { excludeShippingRule: true }),
  ]);
  assert.equal(m.pieces, 2);
  assert.equal(m.amount, 200);
});

test("MIX：3件以內160、4件以上220、滿2800免運（說明中心範例）", () => {
  const r = rule({ category: "MIX", x: 0, y: 160, z: 0, flatRateShippingSettings: { main: { tieredPricesString: "3#220#E\n2799#0#P" } } });
  assert.equal(calc(r, [line(500, 2)]).shippingAmount, 160);
  assert.equal(calc(r, [line(250, 4)]).shippingAmount, 220);
  assert.equal(calc(r, [line(600, 5)]).shippingAmount, 0);
  const perPiece = rule({ category: "MIX", x: 0, y: 100, z: 0, flatRateShippingSettings: { main: { tieredPricesString: "5#30#R" } } });
  assert.equal(calc(perPiece, [line(10, 6)]).shippingAmount, 180);
});

test("STANDARD_FREE 免收基本運費", () => {
  const r = rule({ category: "STANDARD_FREE", y: 999 });
  assert.equal(calc(r, [line(10)]).shippingAmount, 0);
});

test("外島：依郵遞區號判斷，外島 x/y/z 取代基本運費；TOP_ON 為外加；舊外島費用加收", () => {
  assert.equal(isIslandPostcode("880"), true);
  assert.equal(isIslandPostcode("10048"), false);
  const r = rule({ islandFeeX: 1999, islandFeeY: 150, islandFeeZ: 0 });
  const island = { address: { postcode: "880" } };
  assert.equal(calc(r, [line(1500)], island).shippingAmount, 150);
  assert.equal(calc(r, [line(2500)], island).shippingAmount, 0);
  assert.equal(calc(r, [line(1500)], island).island, true);
  const top = rule({ islandFeeX: 1999, islandFeeY: 150, islandFeeZ: 0, islandShippingRateType: "TOP_ON_BASE_RATE" });
  assert.equal(calc(top, [line(500)], island).shippingAmount, 230);
  const legacy = rule({ islandFee: 100 });
  assert.equal(calc(legacy, [line(500)], island).shippingAmount, 180);
  assert.equal(calc(legacy, [line(500)], { address: { postcode: "100" } }).shippingAmount, 80);
  // 外島 x/y/z 皆為 0（列表回傳數字 0）＝未設定 → 沿用本島運費
  const zeros = rule({ islandFeeX: 0, islandFeeY: 0, islandFeeZ: 0 });
  assert.equal(calc(zeros, [line(500)], island).shippingAmount, 80);
  // 只設外島費用 y（無門檻）→ 一律收 y
  const flat = rule({ islandFeeX: 0, islandFeeY: 150, islandFeeZ: 0 });
  assert.equal(calc(flat, [line(5000)], island).shippingAmount, 150);
});

test("不寄送外島、配送外島清單", () => {
  const r = rule();
  const res = calc(r, [line(500)], { address: { postcode: "890" }, groupBuy: { islandDisabled: true } });
  assert.equal(res.availableRules.length, 0);
  assert.equal(res.unavailableRules[0].disabledReason, "此團購不寄送外島");
  assert.match(res.errors[0], /無法使用/);
  const only = rule({ islands: ["880", "881"] });
  assert.equal(evaluateRule(only, { lines: [line(1)], address: { postcode: "890" } }).available, false);
  assert.equal(evaluateRule(only, { lines: [line(1)], address: { postcode: "880" } }).available, true);
  const all = rule({ islands: ["0"] });
  assert.equal(evaluateRule(all, { lines: [line(1)], address: { postcode: "890" } }).available, true);
});

test("偏遠地區：REPLACE 收固定費用、TOP_ON 外加", () => {
  const r = rule({ extendedAreaFee: 200, extendedAreas: ["901", "902"] });
  assert.equal(calc(r, [line(500)], { address: { postcode: "901" } }).shippingAmount, 200);
  assert.equal(calc(r, [line(500)], { address: { postcode: "901" } }).extendedArea, true);
  assert.equal(calc(r, [line(500)], { address: { postcode: "100" } }).shippingAmount, 80);
  const top = rule({ extendedAreaFee: 50, islandShippingRateType: "TOP_ON_BASE_RATE", flatRateShippingSettings: { extendedAreas: ["264"] } });
  assert.equal(calc(top, [line(500)], { address: { postcode: "264" } }).shippingAmount, 130);
});

test("海外：宅配收國外運費、不寄送海外、國際配送國家限制", () => {
  const r = rule({ overseaFee: 600 });
  assert.equal(calc(r, [line(5000)], { address: { country: "US" } }).shippingAmount, 600);
  const blocked = calc(r, [line(5000)], { address: { country: "US" }, groupBuy: { overseaDisabled: true } });
  assert.equal(blocked.availableRules.length, 0);
  const intl = rule({ shippingType: "INTL", x: 0, y: 900, flatRateShippingSettings: { shippingCountry: ["JP", "KR"] } });
  assert.equal(evaluateRule(intl, { lines: [line(1)], address: { country: "JP" } }).available, true);
  assert.equal(evaluateRule(intl, { lines: [line(1)], address: { country: "US" } }).available, false);
  const exc = rule({ shippingType: "INTL", flatRateShippingSettings: { shippingCountryExcluded: ["CN"] } });
  assert.equal(evaluateRule(exc, { lines: [line(1)], address: { country: "CN" } }).available, false);
});

test("運送區域：INCLUSIVE/EXCLUSIVE，縣市索引展開為郵遞區號", () => {
  assert.equal(expandAreas([1]).has("106"), true);
  assert.equal(expandAreas(["20"]).has("600"), true);
  const inc = rule({ flatRateShippingSettings: { shippingType: "INCLUSIVE", shippingAreas: [1, "220"] } });
  assert.equal(evaluateRule(inc, { lines: [line(1)], address: { postcode: "106" } }).available, true);
  assert.equal(evaluateRule(inc, { lines: [line(1)], address: { postcode: "220" } }).available, true);
  assert.equal(evaluateRule(inc, { lines: [line(1)], address: { postcode: "300" } }).available, false);
  const exc = rule({ flatRateShippingSettings: { shippingType: "EXCLUSIVE", shippingAreas: [16] } });
  assert.equal(evaluateRule(exc, { lines: [line(1)], address: { postcode: "970" } }).available, false);
  assert.equal(evaluateRule(exc, { lines: [line(1)], address: { postcode: "100" } }).available, true);
  // 尚未填地址時不阻擋
  assert.equal(evaluateRule(inc, { lines: [line(1)], address: {} }).available, true);
});

test("訂單現貨預購限制、重量上限、金額上限（達上限以上不可用）", () => {
  const instock = rule({ flatRateShippingSettings: { orderStockType: "INSTOCK" } });
  assert.equal(evaluateRule(instock, { lines: [line(1, 1, { backOrder: true })] }).available, false);
  const bo = rule({ flatRateShippingSettings: { orderStockType: "BACKORDER" } });
  assert.equal(evaluateRule(bo, { lines: [line(1), line(1, 1, { backOrder: true })] }).available, false);
  assert.equal(evaluateRule(bo, { lines: [line(1, 1, { backOrder: true })] }).available, true);
  const wl = rule({ flatRateShippingSettings: { weightLimit: "10" } });
  assert.equal(evaluateRule(wl, { lines: [line(1, 5, { weight: 2 })] }).available, true);
  assert.equal(evaluateRule(wl, { lines: [line(1, 6, { weight: 2 })] }).available, false);
  const al = rule({ shippingType: "CVS", flatRateShippingSettings: { amountLimit: "2000" } });
  assert.equal(evaluateRule(al, { lines: [line(1999)] }).available, true);
  assert.equal(evaluateRule(al, { lines: [line(2000)] }).available, false);
});

test("限制性運費標籤：買到標籤商品只能用該規則；沒買到時該規則不出現", () => {
  const home = rule({ title: "宅配", flatRateShippingSettings: { restrictedShippingTag: "甲乙只送宅配" } });
  const cvs = rule({ title: "超取", shippingType: "CVS" });
  const withTag = calculateShippingFee({ rules: [home, cvs], lines: [line(100, 1, { restrictedShippingTag: "甲乙只送宅配" }), line(50)] });
  assert.deepEqual(withTag.availableRules.map((r) => r.title), ["宅配"]);
  const without = calculateShippingFee({ rules: [home, cvs], lines: [line(50)] });
  assert.deepEqual(without.availableRules.map((r) => r.title), ["超取"]);
});

test("運費標籤（PRICE_TAG）：標籤#y#z#E#件數、標籤#本島y,外島y#本島z,外島z、-1 不可用、越前面越優先", () => {
  assert.deepEqual(parseShippingTagLines("襪子#90#40#E#2\n水瓶組合#0,100#0,50"), [
    { tag: "襪子", y: [90, 90], z: [40, 40], type: "E", threshold: 2 },
    { tag: "水瓶組合", y: [0, 100], z: [0, 50], type: null, threshold: 0 },
  ]);
  const r = rule({ category: "PRICE_TAG", flatRateShippingTag: "襪子#90#40#E#2\n水瓶組合#0,100#0,50\n棉被#-1#-1" });
  // E#2：標籤商品滿 2 件以上改收 z（與訂單總額無關）
  assert.equal(calc(r, [line(300, 1, { flatRateShippingTag: "襪子" }), line(1200)]).shippingAmount, 90);
  assert.equal(calc(r, [line(300, 2, { flatRateShippingTag: "襪子" })]).shippingAmount, 40);
  // 沒有標籤商品 → 一般 x/y/z
  assert.equal(calc(r, [line(300)]).shippingAmount, 80);
  // 無 E/R 的行以規則 x 判斷；外島取逗號後的值
  assert.equal(calc(r, [line(300, 1, { flatRateShippingTag: "水瓶組合" })]).shippingAmount, 0);
  assert.equal(calc(r, [line(300, 1, { flatRateShippingTag: "水瓶組合" })], { address: { postcode: "880" } }).shippingAmount, 100);
  assert.equal(calc(r, [line(1300, 1, { flatRateShippingTag: "水瓶組合" })], { address: { postcode: "880" } }).shippingAmount, 50);
  // 第一個符合的行優先
  assert.equal(calc(r, [line(300, 2, { flatRateShippingTag: "襪子" }), line(300, 1, { flatRateShippingTag: "水瓶組合" })]).shippingAmount, 40);
  // -1：不可用
  const blocked = calc(r, [line(300, 1, { flatRateShippingTag: "棉被" })]);
  assert.equal(blocked.availableRules.length, 0);
  assert.equal(blocked.unavailableRules[0].disabledReason, "購物車商品不適用此配送方式");
  // R#500：標籤商品金額滿 500 以上改收 z
  const amountTag = rule({ category: "PRICE_TAG", flatRateShippingTag: "襪子#90#40#R#500" });
  assert.equal(calc(amountTag, [line(300, 1, { flatRateShippingTag: "襪子" })]).shippingAmount, 90);
  assert.equal(calc(amountTag, [line(250, 2, { flatRateShippingTag: "襪子" })]).shippingAmount, 40);
});

test("滿足條件x需搭配折扣碼", () => {
  const r = rule({ couponX: true });
  assert.equal(calc(r, [line(2000)]).shippingAmount, 80);
  assert.equal(calc(r, [line(2000)], { couponCodes: ["VIP"] }).shippingAmount, 0);
});

test("支援付款方式與貨到付款費（含級距、-1 不配送、貨到付款不可含預購）", () => {
  const r = rule({
    paymentMethods: ["BANK_ACCOUNT", "PAY_ON_DELIVERY"],
    payOnDeliveryFee: 30,
    flatRateShippingSettings: { payOnDeliveryFee: { tieredPricesString: "999#60\n2999#90\n9999#-1" } },
  });
  const ok = calc(r, [line(500)], { paymentMethod: "PAY_ON_DELIVERY" });
  assert.equal(ok.codFee, 30);
  assert.equal(calc(r, [line(1500)], { paymentMethod: "PAY_ON_DELIVERY" }).codFee, 60);
  const over = calc(r, [line(10000)], { paymentMethod: "PAY_ON_DELIVERY" });
  assert.equal(over.availableRules.length, 0);
  const card = calc(r, [line(500)], { paymentMethod: "ALLPAY_CREDITCARD" });
  assert.equal(card.unavailablePaymentRules.length, 1);
  assert.deepEqual(card.allowedPaymentMethods, ["BANK_ACCOUNT", "PAY_ON_DELIVERY"]);
  const noBo = calc(r, [line(500, 1, { backOrder: true })], { paymentMethod: "PAY_ON_DELIVERY", groupBuy: { backOrderCodDisabled: true } });
  assert.equal(noBo.availableRules.length, 0);
  const island = rule({ paymentMethods: ["BANK_ACCOUNT"], islandPaymentMethods: ["ALLPAY_CREDITCARD"] });
  assert.deepEqual(calc(island, [line(1)], { address: { postcode: "880" } }).allowedPaymentMethods, ["ALLPAY_CREDITCARD"]);
});

test("品項運費：表單運費只算未綁品項的商品；同規則品項合併；不同規則累加", () => {
  const main = rule({ flatRateShippingId: 101, title: "黑貓宅配", x: 999, y: 80, z: 0 });
  const cold = rule({ flatRateShippingId: 201, title: "冷藏", x: 2999, y: 250, z: 0 });
  const lines = [line(800, 1, { groupBuyItemSetId: 1 }), line(1000, 1, { groupBuyItemSetId: 2 }), line(1500, 1, { groupBuyItemSetId: 3 })];
  const res = calculateShippingFee({
    rules: [main],
    itemSetRules: [
      { groupBuyItemSetId: 2, rule: cold },
      { groupBuyItemSetId: 3, rule: cold },
    ],
    lines,
    selectedRuleId: 101,
  });
  // 常溫 800 → 80；冷藏(2+3)合併 2500 → 250
  assert.equal(res.shippingAmount, 330);
  assert.deepEqual(res.subs.map((s) => [s.title, s.shippingAmount]), [["黑貓宅配", 80], ["冷藏", 250]]);
  // 品項運費規則計算以整張訂單計算
  const full = rule({ flatRateShippingId: 202, title: "冷藏全單", x: 2999, y: 250, z: 0, subsetApplyFullAmount: true });
  const res2 = calculateShippingFee({ rules: [main], itemSetRules: [{ groupBuyItemSetId: 2, rule: full }], lines: [line(2500, 1, { groupBuyItemSetId: 1 }), line(1000, 1, { groupBuyItemSetId: 2 })], selectedRuleId: 101 });
  assert.equal(res2.shippingAmount, 0);
});

test("多商品運費不累加（僅收最高者）、滿足優惠時運費不累加（僅收最低者）", () => {
  const main = rule({ flatRateShippingId: 301, x: 0, y: 100, z: 0 });
  const hi = rule({ flatRateShippingId: 302, title: "B", x: 0, y: 200, z: 0, flatRateShippingSettings: { subsetApplyHighestAmount: true } });
  const res = calculateShippingFee({ rules: [main], itemSetRules: [{ groupBuyItemSetId: 2, rule: hi }], lines: [line(10, 1, { groupBuyItemSetId: 1 }), line(10, 1, { groupBuyItemSetId: 2 })], selectedRuleId: 301 });
  assert.equal(res.shippingAmount, 200);
  const lo = rule({ flatRateShippingId: 303, title: "C", x: 999, y: 120, z: 0, flatRateShippingSettings: { subsetApplyLowestAmount: true } });
  const res2 = calculateShippingFee({ rules: [main], itemSetRules: [{ groupBuyItemSetId: 2, rule: lo }], lines: [line(10, 1, { groupBuyItemSetId: 1 }), line(1000, 1, { groupBuyItemSetId: 2 })], selectedRuleId: 301 });
  assert.equal(res2.shippingAmount, 0);
  const res3 = calculateShippingFee({ rules: [main], itemSetRules: [{ groupBuyItemSetId: 2, rule: lo }], lines: [line(10, 1, { groupBuyItemSetId: 1 }), line(100, 1, { groupBuyItemSetId: 2 })], selectedRuleId: 301 });
  assert.equal(res3.shippingAmount, 220);
});

test("單件商品運費依件數累加、免運成本", () => {
  const r = rule({ flatRateShippingSettings: { freeShippingAsInternalShipping: true } });
  const res = calc(r, [line(1200, 1), line(100, 2, { shippingPrice: 15, internalShippingPrice: 10 })]);
  assert.equal(res.shippingAmount, 30);
  assert.equal(res.perItemShippingAmount, 30);
  assert.equal(res.internalShippingAmount, 100);
});

test("未選配送方式時取排序第一個可用規則；找不到所選規則回報錯誤", () => {
  const a = rule({ flatRateShippingId: 401, seq: 2, title: "A" });
  const b = rule({ flatRateShippingId: 402, seq: 1, title: "B", y: 60 });
  const res = calculateShippingFee({ rules: [a, b], lines: [line(100)] });
  assert.equal(res.rule.title, "B");
  assert.equal(res.shippingAmount, 60);
  const bad = calculateShippingFee({ rules: [a], lines: [line(100)], selectedRuleId: 999 });
  assert.match(bad.errors[0], /找不到/);
  const none = calculateShippingFee({ rules: [], lines: [line(100)] });
  assert.match(none.errors[0], /尚未設定運費規則/);
});

test("再買多少免運提示、訂單折扣自門檻扣除、貨運標籤", () => {
  const r = rule({ flatRateShippingSettings: { shippingTag: "宅配", freeShippingLabel: "免運費" } });
  const res = calc(r, [line(700)]);
  assert.equal(res.amountToFreeShipping, "再買 $300 即享免運費");
  assert.equal(res.shippingTag, "宅配");
  assert.equal(calc(r, [line(1100)], { discountAmount: 200 }).shippingAmount, 80);
  assert.equal(calc(r, [line(1000)]).amountToFreeShipping, null);
});

test("categoryMessage 代入 x/y/z", () => {
  assert.equal(categoryMessage({ category: "PRICE", x: 999, y: 80, z: 0 }), "總金額 999 元內收取 80 元基本運費，超過後改收 0 元基本運費");
  assert.equal(categoryMessage({ category: "STANDARD_FREE", x: 0, y: 0, z: 0 }), "免收基本運費");
  assert.deepEqual(thresholdFee(5, 5, 1, 2), { fee: 1, reached: false });
  assert.deepEqual(thresholdFee(6, 5, 1, 2), { fee: 2, reached: true });
});
