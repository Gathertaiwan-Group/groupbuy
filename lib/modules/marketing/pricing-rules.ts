// 優惠條件（SalesRule）／團購優惠卷（GroupBuyCoupon）計算引擎 —— 純函式，無任何 I/O。
//
// 使用者：storefront（前台結帳試算/送出）、orders（後台編輯訂單「重新計算優惠」）、marketing（測試優惠 simulateResult）。
// 只讀依賴：其他模組 import 本檔即可，不要修改；DB → 輸入的組裝見 ./pricing-loader.ts。
// 介面說明：docs/modules/marketing.md「pricing-rules」。
//
// ⚠️ 本檔會被 `node --test`（Node 型別剝除）直接執行：只能用可被抹除的 TS 語法（不可用 enum / namespace /
//    parameter properties），也不可 import 任何別的檔（含 @/ 別名）。
//
// 語意來源：SPEC 第 3 章 groupbuy-salesrule / modal-salesrule-wizard / groupbuy-coupon 的欄位與說明、第 5 章列舉、
// 第 7.6 節（優先順序：[整張訂單][同品項] 數字小者先套、[商品] 數字大者先套），以及原站精靈各類型的文字說明。
// 原站未明示的細節依名稱推導，逐條記錄於 docs/modules/marketing.md「優惠語意（推導）」。

/* ───────────────────────────── 列舉 ───────────────────────────── */

/** 優惠類別（原站 SalesRule.category，29 種；與原站列表 options 同順序） */
export const SALES_RULE_CATEGORIES = [
  "MINIMUM_PRICE_MEET",
  "GIFT_WITH_PURCHASE",
  "CREDIT_CARD",
  "CHECKOUT_MINIMUM_PRICE",
  "MINIMUM_PIECE_CONSTRAINT",
  "MINIMUM_PIECE_MEET",
  "MINIMUM_PIECE_MEET_MAIN_PIECE",
  "MINIMUM_PRICE_CONSTRAINT",
  "MINIMUM_PRICE_MEET_ITS",
  "ITEMSET_LIMITED_ITEMS",
  "X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT",
  "ITEMSET_BUY_X_GOT_Y_FREE",
  "ITEMSET_BUNDLE_PRICE",
  "ITEM_PRICE_MEET",
  "TAG_MATCH",
  "ADDITIONAL_PURCHASE",
  "ADDITIONAL_PURCHASE_OPTIONAL",
  "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET",
  "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL",
  "GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID",
  "GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID",
  "GIFT_MINIMUM_PRICE_MEET",
  "GIFT_MINIMUM_PRICE_MEET_NO_PICK",
  "GIFT_MINIMUM_PIECE_MEET",
  "GIFT_MINIMUM_PIECE_MEET_NO_PICK",
  "GIFT_LOTTERY",
  "ITEM_BUY_X_GOT_Y_FREE",
  "ITEM_EXCLUDED",
  "ITEM_PACKAGE",
] as const;
export type SalesRuleCategory = (typeof SALES_RULE_CATEGORIES)[number];

/** 折扣方式（SalesRule.dollarOrPercentage／精靈的 dollarOrPercentage） */
export type DollarOrPercentage =
  | "DOLLAR"
  | "PERCENTAGE"
  | "POINT"
  | "SALE_PRICE"
  | "PERCENTAGE_RETAIL_PRICE"
  | "PIECE"
  | "PACK_DOLLAR"
  | "PACK_SALE_PRICE"
  | "DOLLAR_PACK_DISCOUNT"
  | "BUNDLE_PRICE";

/** 團購優惠卷類型（GroupBuyCoupon.category） */
export const COUPON_CATEGORIES = [
  "MINIMUM_PRICE_MEET",
  "MINIMUM_PIECE_MEET",
  "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE",
  "SALES_RULE",
  "FREE_SHIPPING",
  "FREE_SHIPPING_X",
  "POINT",
  "POINT_RANDOM",
] as const;
export type CouponCategory = (typeof COUPON_CATEGORIES)[number];

/** 規則層級：ORDER＝[整張訂單]、ITEM_SET＝[同品項]、ITEM＝[商品] */
export type RuleLevel = "ORDER" | "ITEM_SET" | "ITEM";

const ORDER_CATEGORIES: readonly string[] = [
  "MINIMUM_PRICE_MEET",
  "GIFT_WITH_PURCHASE",
  "CREDIT_CARD",
  "CHECKOUT_MINIMUM_PRICE",
];
const ITEM_SET_CATEGORIES: readonly string[] = [
  "MINIMUM_PIECE_CONSTRAINT",
  "MINIMUM_PIECE_MEET",
  "MINIMUM_PIECE_MEET_MAIN_PIECE",
  "MINIMUM_PRICE_CONSTRAINT",
  "MINIMUM_PRICE_MEET_ITS",
  "ITEMSET_LIMITED_ITEMS",
  "X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT",
  "ITEMSET_BUY_X_GOT_Y_FREE",
  "ITEMSET_BUNDLE_PRICE",
];
/** 限制類（不產生折扣，只影響能否結帳/刷卡） */
const CONSTRAINT_CATEGORIES: readonly string[] = [
  "CREDIT_CARD",
  "CHECKOUT_MINIMUM_PRICE",
  "MINIMUM_PIECE_CONSTRAINT",
  "MINIMUM_PRICE_CONSTRAINT",
  "ITEMSET_LIMITED_ITEMS",
  "ITEM_PACKAGE",
];
const GIFT_CATEGORIES: readonly string[] = [
  "GIFT_WITH_PURCHASE",
  "GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID",
  "GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID",
  "GIFT_MINIMUM_PRICE_MEET",
  "GIFT_MINIMUM_PRICE_MEET_NO_PICK",
  "GIFT_MINIMUM_PIECE_MEET",
  "GIFT_MINIMUM_PIECE_MEET_NO_PICK",
  "GIFT_LOTTERY",
];
const ADDITIONAL_CATEGORIES: readonly string[] = [
  "ADDITIONAL_PURCHASE",
  "ADDITIONAL_PURCHASE_OPTIONAL",
  "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET",
  "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL",
];

/** 類別層級（未知類別視為 ITEM） */
export function ruleLevel(category: string): RuleLevel {
  if (ORDER_CATEGORIES.includes(category)) return "ORDER";
  if (ITEM_SET_CATEGORIES.includes(category)) return "ITEM_SET";
  return "ITEM";
}

export function isConstraintCategory(category: string): boolean {
  return CONSTRAINT_CATEGORIES.includes(category);
}
export function isGiftCategory(category: string): boolean {
  return GIFT_CATEGORIES.includes(category);
}
export function isAdditionalPurchaseCategory(category: string): boolean {
  return ADDITIONAL_CATEGORIES.includes(category);
}

/**
 * 「綁定」欄要顯示的按鈕（原站列表列鍵 levelItemSetItem / levelItem / levelItemSet / categoryAllowExcludeItemTag）。
 * 依精靈各類型可選的對象推導：同時可選品項＋商品 → levelItemSetItem；只選品項 → levelItemSet；只選商品 → levelItem；
 * 整張訂單類可設「不參與活動商品」→ categoryAllowExcludeItemTag；刷卡/結帳門檻 → 都不是。
 */
export function bindingFlags(category: string): {
  levelItemSetItem: boolean;
  levelItem: boolean;
  levelItemSet: boolean;
  categoryAllowExcludeItemTag: boolean;
} {
  const itemSetItem = [
    "ITEM_PRICE_MEET",
    "MINIMUM_PRICE_MEET_ITS",
    "ADDITIONAL_PURCHASE",
    "ADDITIONAL_PURCHASE_OPTIONAL",
    "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET",
    "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL",
    "GIFT_MINIMUM_PRICE_MEET",
    "GIFT_MINIMUM_PRICE_MEET_NO_PICK",
    "GIFT_MINIMUM_PIECE_MEET",
    "GIFT_MINIMUM_PIECE_MEET_NO_PICK",
  ];
  const excludeTag = ["MINIMUM_PRICE_MEET", "GIFT_WITH_PURCHASE"];
  const none = ["CREDIT_CARD", "CHECKOUT_MINIMUM_PRICE"];
  const levelItemSetItem = itemSetItem.includes(category);
  const categoryAllowExcludeItemTag = excludeTag.includes(category);
  const lvl = ruleLevel(category);
  return {
    levelItemSetItem,
    levelItemSet: !levelItemSetItem && lvl === "ITEM_SET",
    levelItem: !levelItemSetItem && lvl === "ITEM" && !none.includes(category),
    categoryAllowExcludeItemTag,
  };
}

/** 此類別是否必須綁定品項/商品才會生效（列表「尚未套用到商品或是品項」徽章用） */
export function categoryNeedsBinding(category: string): boolean {
  return !["MINIMUM_PRICE_MEET", "GIFT_WITH_PURCHASE", "CREDIT_CARD", "CHECKOUT_MINIMUM_PRICE", "GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID", "GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID"].includes(category);
}

/* ───────────────────────────── 輸入／輸出型別 ───────────────────────────── */

export interface SalesRuleSettings {
  seq?: number | string | null;
  /** 「滿足最小單位後，每滿多少單位重複折扣」格式 "1000#100"（每再滿 1000 再折 100） */
  repeatMinimumString?: string | null;
  /** 「額外滿足單位（不規律）」每行 "最小單位#折扣"，取符合的最高一級 */
  tieredMinimumsString?: string | null;
  giftTagRule?: "ALL" | "ONE" | string | null;
  tagMatchRule?: "ALL" | "ANY" | string | null;
  /** 該優惠最多累積折扣金額上限（>0 才生效） */
  maxDiscountAmount?: number | string | null;
  /** 折扣後訂單最少金額（>0 才生效） */
  minDiscountTotalPrice?: number | string | null;
  /** 限定郵遞區號（逗點分隔，可用 * ，如 1*,2*,302） */
  includedPostcodes?: string | null;
  /** 商品折扣順序：''＝價格低至高（預設）、'DESC'＝價格高至低 */
  priceSortOrder?: "" | "DESC" | string | null;
  /** 組合包：子商品數量規則 BY_TAG/SUM_TAG、子商品加總數量 */
  packRule?: { rule?: string | null; subItemTotal?: number | string | null } | null;
  /** 自選贈品必須挑選 */
  giftMandatory?: boolean | null;
  /** 推導：精靈 TAG_MATCH 組合價各標籤最少件數（與 tag 依序對應，"3|2"） */
  tagMinimums?: string | null;
  /** 推導：精靈「必須先購買特定商品」的主商品最少件數（tag 第一個為主商品標籤） */
  mainTagMinimum?: number | string | null;
  [key: string]: unknown;
}

export interface PricingSalesRule {
  salesRuleId: number;
  title: string;
  category: string;
  dollarOrPercentage: string;
  /** 折扣值：金額／折數（10=九折）／新售價／數量（PIECE）／組合價（BUNDLE_PRICE）／點數（POINT） */
  discount: number;
  /** 最小單位：金額或件數（依類別） */
  minimum: number;
  /** 最多套用次數，-1＝不限（各類別含義見 docs） */
  maxApplyTimes: number;
  /** 可供優惠數量（總量）；與 usedQuota 相減為剩餘 */
  availableQuota?: number | null;
  usedQuota?: number | null;
  priority: number;
  /** 優惠標籤（| 區隔；最後一個為「贈品/優惠對象」標籤，其餘為主商品標籤） */
  tag?: string | null;
  /** 不合併計算標籤（| 區隔）：帶這些標籤的商品不列入本優惠計算 */
  excludeTag?: string | null;
  mainItemType?: "ANY" | "INSTOCK" | "BACKORDER" | string | null;
  /** 可跨品項合併（同品項類：不同品項商品合併計算） */
  applyToGroupBuy?: boolean | null;
  hidden?: boolean | null;
  /** 可合併計算（相同標籤的優惠可同時套用；滿額贈可合併送） */
  combinable?: boolean | null;
  active?: boolean | null;
  dateStart?: string | Date | null;
  dateEnd?: string | Date | null;
  settings?: SalesRuleSettings | null;
  /** 限定會員方案（salesRuleRoyaltyPrograms）；空＝不限 */
  royaltyProgramIds?: number[] | null;
}

export interface PricingCartLine {
  /** 呼叫端自訂識別（購物車明細 id、訂單商品 id…），結果原樣帶回 */
  key: string | number;
  itemId: number;
  groupBuyItemSetId?: number | null;
  title: string;
  /** 團購單價 */
  price: number;
  /** 原價（依原價折數用；沒有就用 price） */
  retailPrice?: number | null;
  quantity: number;
  /** 預購（主商品庫存類型 INSTOCK/BACKORDER 判斷用） */
  backOrder?: boolean | null;
  /** 商品種類（GIFT＝贈品，不列入門檻計算） */
  itemType?: string | null;
  /** 綁定到此商品的優惠條件 id（item_sales_rules ∪ 所屬品項的 group_buy_item_set_sales_rules） */
  salesRuleIds?: number[] | null;
  /** 此商品的優惠標籤（item_sales_rule_tags ∪ 所屬品項的 group_buy_item_set_sales_rule_tags） */
  tags?: string[] | null;
}

export interface PricingCustomer {
  customerId?: number | null;
  royaltyProgramId?: number | null;
}

export interface PricingCoupon {
  /** 消費者輸入的折扣碼 */
  code: string;
  groupBuyCouponId: number;
  couponCodeId?: number | null;
  title?: string | null;
  category: string;
  dollarOrPercentage: string;
  discount: number;
  minimum: number;
  /** 折抵金額上限（>0 才生效） */
  maxDiscount?: number | null;
  /** 可合併計算：false 時，若已有其他優惠條件折扣則不套用 */
  combinable?: boolean | null;
  /** SALES_RULE：此折扣碼解鎖的優惠條件 */
  salesRuleId?: number | null;
  customerOnly?: boolean | null;
  royaltyProgramIds?: number[] | null;
  active?: boolean | null;
  /** 相同折扣碼可被重複使用結帳次數（-1＝無限制） */
  availableQuota?: number | null;
  /** 此折扣碼已被使用次數（coupon_codes.used_count） */
  usedCount?: number | null;
  /** 此折扣碼本身的使用上限（coupon_codes.max_uses，-1＝不限） */
  maxUses?: number | null;
  applyToAllGroupBuy?: boolean | null;
  /** 優惠卷所屬團購 */
  groupBuyId?: number | null;
}

export interface PricingInput {
  lines: PricingCartLine[];
  salesRules: PricingSalesRule[];
  coupon?: PricingCoupon | null;
  customer?: PricingCustomer | null;
  /** 收件郵遞區號（限定郵遞區號用） */
  postcode?: string | null;
  /** 購物車所屬團購（優惠卷跨團判斷） */
  groupBuyId?: number | null;
  /** 需搭配折扣碼（SALES_RULE 優惠卷）才生效的優惠條件 id */
  couponOnlySalesRuleIds?: number[] | null;
  now?: Date | string | null;
  /** 0 ≤ x < 1 的亂數（POINT_RANDOM、GIFT_LOTTERY）；預設 Math.random */
  random?: () => number;
  /** 金額小數位（預設 0：新台幣取整數，四捨五入） */
  moneyDecimals?: number;
}

export interface PricingLineResult {
  key: string | number;
  itemId: number;
  title: string;
  price: number;
  quantity: number;
  amount: number;
  discount: number;
  totalPriceAfterDiscount: number;
  appliedSalesRuleIds: number[];
}

export interface AppliedSalesRule {
  salesRuleId: number;
  title: string;
  category: string;
  level: RuleLevel;
  /** 本次折抵金額（原站 sessionDiscount） */
  discount: number;
  points: number;
  /** 套用次數／件數 */
  times: number;
  lineKeys: (string | number)[];
  description: string;
}

export interface GiftEntitlement {
  salesRuleId: number;
  title: string;
  category: string;
  /** 贈品標籤（候選贈品＝帶此標籤的商品） */
  giftTag: string | null;
  /** 可得贈品數量 */
  quantity: number;
  mode: "AUTO" | "PICK";
  giftTagRule: "ALL" | "ONE";
  mandatory: boolean;
  /** 隨機（福袋）：呼叫端用 randomIndex 從候選中挑 */
  random: boolean;
  randomIndexSeed: number;
  /** 同商品買X送Y：贈送同一商品 */
  sameItemId?: number | null;
}

export interface AdditionalPurchaseEntitlement {
  salesRuleId: number;
  title: string;
  category: string;
  addonTag: string | null;
  /** 可用加購價購買的件數（-1＝不限） */
  allowedUnits: number;
  /** 購物車中已用加購價的件數 */
  usedUnits: number;
  optional: boolean;
  satisfied: boolean;
}

export interface ConstraintResult {
  salesRuleId: number;
  title: string;
  category: string;
  satisfied: boolean;
  /** CREDIT_CARD 只限制信用卡付款；其他限制結帳 */
  scope: "CHECKOUT" | "CREDIT_CARD";
  message: string;
}

export interface CouponResult {
  code: string;
  groupBuyCouponId: number;
  couponCodeId: number | null;
  valid: boolean;
  applied: boolean;
  discount: number;
  points: number;
  freeShipping: boolean;
  shippingConditionX: boolean;
  unlockedSalesRuleId: number | null;
  message: string;
}

export interface PricingResult {
  subtotal: number;
  lines: PricingLineResult[];
  appliedRules: AppliedSalesRule[];
  gifts: GiftEntitlement[];
  additionalPurchases: AdditionalPurchaseEntitlement[];
  constraints: ConstraintResult[];
  coupon: CouponResult | null;
  itemDiscount: number;
  orderDiscount: number;
  couponDiscount: number;
  /** 優惠條件折扣小計（不含優惠卷） */
  salesRuleDiscount: number;
  totalDiscount: number;
  points: number;
  freeShipping: boolean;
  shippingConditionX: boolean;
  checkoutAllowed: boolean;
  creditCardAllowed: boolean;
  grandTotalWithoutShipping: number;
  messages: string[];
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

export function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

/** "A|B| 贈品" → ['A','B','贈品']（去空白、去空項、去重複，保留順序） */
export function parseTags(tag: string | null | undefined): string[] {
  if (!tag) return [];
  const out: string[] = [];
  for (const t of String(tag).split("|")) {
    const s = t.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** "1000#100" → { minimum: 1000, discount: 100 }；格式不符回 null */
export function parseRepeatMinimum(s: string | null | undefined): { minimum: number; discount: number } | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(-?[\d.]+)\s*#\s*(-?[\d.]+)$/);
  if (!m) return null;
  const minimum = Number(m[1]);
  const discount = Number(m[2]);
  if (!(minimum > 0) || !Number.isFinite(discount)) return null;
  return { minimum, discount };
}

/** "2000#2\n3000#3" → 依最小單位遞增排序的級距 */
export function parseTieredMinimums(s: string | null | undefined): { minimum: number; discount: number }[] {
  if (!s) return [];
  const out: { minimum: number; discount: number }[] = [];
  for (const line of String(s).split(/[\r\n,;]+/)) {
    const r = parseRepeatMinimum(line);
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.minimum - b.minimum);
}

/** 限定郵遞區號比對："1*,2*,302" ；patterns 空＝不限 */
export function matchPostcode(patterns: string | null | undefined, postcode: string | null | undefined): boolean {
  const list = String(patterns ?? "")
    .split(/[,，\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  const pc = String(postcode ?? "").trim();
  if (!pc) return false;
  return list.some((p) => (p.endsWith("*") ? pc.startsWith(p.slice(0, -1)) : pc === p));
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  // "YYYY-MM-DD HH:mm"（台灣時間）
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const p = (x: string | undefined, d = "0") => (x ?? d).padStart(2, "0");
    const d = new Date(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:${p(m[6])}+08:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function makeRound(decimals: number): (n: number) => number {
  const f = Math.pow(10, Math.max(0, Math.min(4, decimals)));
  return (n: number) => Math.round((n + Number.EPSILON) * f) / f;
}

/* ───────────────────────────── 可用性 ───────────────────────────── */

export interface RuleAvailabilityContext {
  now?: Date | string | null;
  customer?: PricingCustomer | null;
  postcode?: string | null;
  couponOnlySalesRuleIds?: number[] | null;
  unlockedSalesRuleIds?: number[] | null;
}

/**
 * 優惠條件是否可用（啟用、期限內、剩餘數量、會員方案、郵遞區號、需搭配折扣碼）。
 * reason 為中文說明（給「測試優惠」/除錯）。
 */
export function ruleAvailability(rule: PricingSalesRule, ctx: RuleAvailabilityContext = {}): { available: boolean; reason: string } {
  const now = toDate(ctx.now ?? null) ?? new Date();
  if (rule.active === false) return { available: false, reason: "停用中" };
  const ds = toDate(rule.dateStart ?? null);
  const de = toDate(rule.dateEnd ?? null);
  if (ds && now < ds) return { available: false, reason: "尚未開始" };
  if (de && now > de) return { available: false, reason: "已結束" };
  const quota = rule.availableQuota;
  if (quota !== null && quota !== undefined && quota >= 0 && toNumber(rule.usedQuota) >= quota) {
    return { available: false, reason: "可供優惠數量已用完" };
  }
  const programs = (rule.royaltyProgramIds ?? []).filter((x) => Number.isFinite(x));
  if (programs.length > 0) {
    const rp = ctx.customer?.royaltyProgramId ?? null;
    if (rp === null || !programs.includes(rp)) return { available: false, reason: "限定會員身份" };
  }
  if (!matchPostcode(rule.settings?.includedPostcodes ?? null, ctx.postcode ?? null)) {
    return { available: false, reason: "不符合限定郵遞區號" };
  }
  if ((ctx.couponOnlySalesRuleIds ?? []).includes(rule.salesRuleId) && !(ctx.unlockedSalesRuleIds ?? []).includes(rule.salesRuleId)) {
    return { available: false, reason: "需搭配折扣碼" };
  }
  return { available: true, reason: "" };
}

/* ───────────────────────────── 系統自動調整優先順序 ───────────────────────────── */

/**
 * 「系統自動調整優先順序」：只調整 smartPriority 勾選的規則（未給 smartFlags 時全部調整）。
 * [整張訂單][同品項]：數字小者先套 → 門檻（minimum）高者給較小數字；
 * [商品]：數字大者先套 → 門檻高者給較大數字。同層級內依 1,2,3… 編號。
 */
export function computeSmartPriorities(
  rules: Pick<PricingSalesRule, "salesRuleId" | "category" | "minimum" | "priority">[],
  smartFlags?: Record<number, boolean>,
): { salesRuleId: number; priority: number }[] {
  const pick = rules.filter((r) => !smartFlags || smartFlags[r.salesRuleId]);
  const out: { salesRuleId: number; priority: number }[] = [];
  const byLevel = new Map<RuleLevel, typeof pick>();
  for (const r of pick) {
    const l = ruleLevel(r.category);
    const arr = byLevel.get(l) ?? [];
    arr.push(r);
    byLevel.set(l, arr);
  }
  for (const [level, arr] of byLevel) {
    const sorted = [...arr].sort((a, b) => toNumber(b.minimum) - toNumber(a.minimum) || a.salesRuleId - b.salesRuleId);
    sorted.forEach((r, i) => {
      // ITEM：數字大者先套 → 最高門檻拿最大數字
      const priority = level === "ITEM" ? sorted.length - i : i + 1;
      out.push({ salesRuleId: r.salesRuleId, priority });
    });
  }
  return out.sort((a, b) => a.salesRuleId - b.salesRuleId);
}

/* ───────────────────────────── 優惠卷驗證 ───────────────────────────── */

export function validateCoupon(
  coupon: PricingCoupon,
  ctx: { groupBuyId?: number | null; customer?: PricingCustomer | null } = {},
): { valid: boolean; reason: string } {
  if (coupon.active === false) return { valid: false, reason: "此折扣碼已停用" };
  if (!coupon.applyToAllGroupBuy && coupon.groupBuyId && ctx.groupBuyId && coupon.groupBuyId !== ctx.groupBuyId) {
    return { valid: false, reason: "此折扣碼不適用於此團購" };
  }
  const used = toNumber(coupon.usedCount);
  const quota = coupon.availableQuota;
  if (quota !== null && quota !== undefined && quota >= 0 && used >= quota) return { valid: false, reason: "此折扣碼已達使用次數上限" };
  const maxUses = coupon.maxUses;
  if (maxUses !== null && maxUses !== undefined && maxUses >= 0 && used >= maxUses) return { valid: false, reason: "此折扣碼已達使用次數上限" };
  if (coupon.customerOnly && !ctx.customer?.customerId) return { valid: false, reason: "此折扣碼限會員使用，請先登入" };
  const programs = coupon.royaltyProgramIds ?? [];
  if (programs.length > 0) {
    const rp = ctx.customer?.royaltyProgramId ?? null;
    if (rp === null || !programs.includes(rp)) return { valid: false, reason: "此折扣碼限特定會員身份使用" };
  }
  return { valid: true, reason: "" };
}

/* ───────────────────────────── 引擎內部狀態 ───────────────────────────── */

interface LineState {
  src: PricingCartLine;
  index: number;
  price: number;
  retail: number;
  qty: number;
  amount: number;
  discount: number;
  tags: string[];
  ruleIds: number[];
  gift: boolean;
  excluded: boolean;
  applied: number[];
}

interface Unit {
  line: LineState;
  /** 目前單位淨價（扣除已套用折扣後） */
  net: number;
  retail: number;
}

function netOf(l: LineState): number {
  return Math.max(0, l.amount - l.discount);
}

function hasAnyTag(l: LineState, tags: string[]): boolean {
  return tags.length > 0 && l.tags.some((t) => tags.includes(t));
}

/** 依折扣方式算單件折扣（不超過單價） */
function unitDiscount(dop: string, d: number, unitNet: number, unitRetail: number): number {
  let x = 0;
  switch (dop) {
    case "DOLLAR":
    case "PACK_DOLLAR":
      x = d;
      break;
    case "PERCENTAGE":
      x = (unitNet * d) / 100;
      break;
    case "PERCENTAGE_RETAIL_PRICE":
      x = unitNet - (unitRetail * (100 - d)) / 100;
      break;
    case "SALE_PRICE":
    case "PACK_SALE_PRICE":
      x = unitNet - d;
      break;
    default:
      x = 0;
  }
  return Math.max(0, Math.min(unitNet, x));
}

function unitsOf(lines: LineState[], sortDesc: boolean): Unit[] {
  const units: Unit[] = [];
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const netPer = netOf(l) / l.qty;
    for (let i = 0; i < l.qty; i++) units.push({ line: l, net: netPer, retail: l.retail });
  }
  units.sort((a, b) => (sortDesc ? b.net - a.net : a.net - b.net) || a.line.index - b.line.index);
  return units;
}

/** 依金額比例把總折扣分攤到各行（尾差給最後一行；不超過各行淨額） */
function spread(total: number, lines: LineState[], round: (n: number) => number): Map<LineState, number> {
  const out = new Map<LineState, number>();
  const pool = lines.filter((l) => netOf(l) > 0);
  const base = pool.reduce((s, l) => s + netOf(l), 0);
  if (total <= 0 || base <= 0) return out;
  let remaining = Math.min(total, base);
  pool.forEach((l, i) => {
    const share = i === pool.length - 1 ? remaining : Math.min(remaining, round((total * netOf(l)) / base));
    const v = Math.min(share, netOf(l));
    out.set(l, v);
    remaining = round(remaining - v);
  });
  return out;
}

/* ───────────────────────────── 主引擎 ───────────────────────────── */

/**
 * 計算購物車套用優惠條件與優惠卷後的結果。
 * 順序：[商品]（優先數字大者先）→ [同品項]（小者先）→ [整張訂單]（小者先）→ 限制檢查 → 優惠卷。
 */
export function evaluatePricing(input: PricingInput): PricingResult {
  const round = makeRound(input.moneyDecimals ?? 0);
  const random = input.random ?? Math.random;
  const now = toDate(input.now ?? null) ?? new Date();
  const messages: string[] = [];

  const lines: LineState[] = input.lines.map((src, index) => {
    const price = Math.max(0, toNumber(src.price));
    const qty = Math.max(0, Math.floor(toNumber(src.quantity)));
    const retailRaw = toNumber(src.retailPrice, NaN);
    return {
      src,
      index,
      price,
      retail: Number.isFinite(retailRaw) && retailRaw > 0 ? retailRaw : price,
      qty,
      amount: round(price * qty),
      discount: 0,
      tags: parseTags((src.tags ?? []).join("|")),
      ruleIds: (src.salesRuleIds ?? []).filter((x) => Number.isFinite(x)),
      gift: String(src.itemType ?? "").toUpperCase() === "GIFT",
      excluded: false,
      applied: [],
    };
  });

  // 優惠卷先驗證（SALES_RULE 類會解鎖對應優惠條件）
  let coupon: CouponResult | null = null;
  const unlocked: number[] = [];
  if (input.coupon) {
    const v = validateCoupon(input.coupon, { groupBuyId: input.groupBuyId, customer: input.customer });
    coupon = {
      code: input.coupon.code,
      groupBuyCouponId: input.coupon.groupBuyCouponId,
      couponCodeId: input.coupon.couponCodeId ?? null,
      valid: v.valid,
      applied: false,
      discount: 0,
      points: 0,
      freeShipping: false,
      shippingConditionX: false,
      unlockedSalesRuleId: null,
      message: v.reason,
    };
    if (v.valid && input.coupon.category === "SALES_RULE" && input.coupon.salesRuleId) {
      unlocked.push(input.coupon.salesRuleId);
      coupon.unlockedSalesRuleId = input.coupon.salesRuleId;
    }
  }

  const availCtx: RuleAvailabilityContext = {
    now,
    customer: input.customer,
    postcode: input.postcode,
    couponOnlySalesRuleIds: input.couponOnlySalesRuleIds,
    unlockedSalesRuleIds: unlocked,
  };
  const rules = input.salesRules.filter((r) => ruleAvailability(r, availCtx).available);

  // 商品-不列入優惠計算：綁定/帶標籤的商品不參與任何其他優惠
  for (const r of rules) {
    if (r.category !== "ITEM_EXCLUDED") continue;
    const tags = parseTags(r.tag);
    for (const l of lines) if (l.ruleIds.includes(r.salesRuleId) || hasAnyTag(l, tags)) l.excluded = true;
  }

  const appliedRules: AppliedSalesRule[] = [];
  const gifts: GiftEntitlement[] = [];
  const additional: AdditionalPurchaseEntitlement[] = [];
  const constraints: ConstraintResult[] = [];
  let orderDiscount = 0;
  let points = 0;
  /** 已套用的「標籤組」：相同標籤的優惠條件互斥（可合併計算者除外） */
  const usedTagKeys = new Map<string, boolean>();

  const levelOrder = (r: PricingSalesRule) => {
    const l = ruleLevel(r.category);
    return l === "ITEM" ? 0 : l === "ITEM_SET" ? 1 : 2;
  };
  const sorted = [...rules].sort((a, b) => {
    const la = levelOrder(a);
    const lb = levelOrder(b);
    if (la !== lb) return la - lb;
    const pa = toNumber(a.priority, 1);
    const pb = toNumber(b.priority, 1);
    if (pa !== pb) return la === 0 ? pb - pa : pa - pb;
    return a.salesRuleId - b.salesRuleId;
  });

  const baseLines = (r: PricingSalesRule): LineState[] => {
    const ex = parseTags(r.excludeTag);
    return lines.filter((l) => !l.gift && !l.excluded && l.qty > 0 && !hasAnyTag(l, ex));
  };
  /** 規則的對象商品：ORDER 類＝全部（扣除排除）；其他＝綁定或帶規則標籤的商品 */
  const targetLines = (r: PricingSalesRule): LineState[] => {
    const base = baseLines(r);
    if (ruleLevel(r.category) === "ORDER") return base;
    const tags = parseTags(r.tag);
    return base.filter((l) => l.ruleIds.includes(r.salesRuleId) || hasAnyTag(l, tags));
  };
  const groupsOf = (r: PricingSalesRule, ls: LineState[]): LineState[][] => {
    if (r.applyToGroupBuy || ruleLevel(r.category) !== "ITEM_SET") return ls.length ? [ls] : [];
    const m = new Map<string, LineState[]>();
    for (const l of ls) {
      const k = l.src.groupBuyItemSetId != null ? `s${l.src.groupBuyItemSetId}` : `i${l.src.itemId}`;
      const arr = m.get(k) ?? [];
      arr.push(l);
      m.set(k, arr);
    }
    return [...m.values()];
  };
  const qtyOf = (ls: LineState[]) => ls.reduce((s, l) => s + l.qty, 0);
  const netSum = (ls: LineState[]) => round(ls.reduce((s, l) => s + netOf(l), 0));
  const capTimes = (times: number, maxApply: number) => (maxApply > 0 ? Math.min(times, maxApply) : times);
  const sortDesc = (r: PricingSalesRule) => String(r.settings?.priceSortOrder ?? "").toUpperCase() === "DESC";
  const maxDiscountCap = (r: PricingSalesRule) => {
    const m = toNumber(r.settings?.maxDiscountAmount, 0);
    return m > 0 ? m : Infinity;
  };

  /**
   * 門檻次數（滿額/滿件「折扣」類：MINIMUM_PRICE_MEET、ITEM_PRICE_MEET、同品項 DOLLAR_PACK_DISCOUNT）。贈品用 giftTimes、優惠卷在下方各自計算，不共用此函式。
   * 照原站精靈「重複滿額次數」（fieldInfo：重複滿額時，重複享有優惠次數；ITEM_PRICE_MEET／PACK_DISCOUNT 為「最多享幾次優惠」）
   * 存成 maxApplyTimes：0/1＝僅一次、-1＝不限（每滿 minimum 折一次）、N（有上限）＝最多 N 次。
   * 有「規律重複」repeatMinimumString（"R#D"：滿 minimum 後每再滿 R 再折 D）時依其間隔：次數＝1＋floor((value−minimum)/R)，同樣受上限限制。
   */
  const thresholdTimes = (r: PricingSalesRule, value: number): number => {
    const minimum = toNumber(r.minimum);
    if (value <= 0 || value < minimum) return 0;
    const maxApply = Math.trunc(toNumber(r.maxApplyTimes, -1));
    if (maxApply === 1 || maxApply === 0) return 1;
    const rep = parseRepeatMinimum(r.settings?.repeatMinimumString ?? null);
    const times = rep ? 1 + Math.floor((value - minimum) / rep.minimum) : minimum > 0 ? Math.floor(value / minimum) : 1;
    return capTimes(Math.max(1, times), maxApply);
  };
  /**
   * 贈品次數（GIFT_* 類；規則與 thresholdTimes 相同，但獨立保留，兩者各自可調）。
   * 原站精靈贈品欄位「重複滿額次數」（fieldInfo：重複滿額時，重複享有優惠次數）存成 maxApplyTimes：
   *   0＝僅一次、-1＝不限（每滿 minimum 送一次）、N（有上限）＝最多 N 次。
   * 贈品精靈沒有「規律重複」欄位；若後台編輯器另設了 repeatMinimumString（"R#…"），則滿 minimum 後每再滿 R 送一次。
   * 以件數判斷的類別（滿件贈）value 為件數。
   */
  const giftTimes = (r: PricingSalesRule, value: number): number => {
    const minimum = toNumber(r.minimum);
    if (value <= 0 || value < minimum) return 0;
    const maxApply = Math.trunc(toNumber(r.maxApplyTimes, -1));
    if (maxApply === 0 || maxApply === 1) return 1;
    const rep = parseRepeatMinimum(r.settings?.repeatMinimumString ?? null);
    const times = rep ? 1 + Math.floor((value - minimum) / rep.minimum) : minimum > 0 ? Math.floor(value / minimum) : 1;
    return capTimes(Math.max(1, times), maxApply);
  };
  /** 依級距決定折扣值（不規律）：取 value 已達到的最高級 */
  const tieredDiscount = (r: PricingSalesRule, value: number): number => {
    let d = toNumber(r.discount);
    for (const t of parseTieredMinimums(r.settings?.tieredMinimumsString ?? null)) if (value >= t.minimum) d = t.discount;
    return d;
  };
  /** 一般門檻折扣（金額）：DOLLAR／DOLLAR_PACK_DISCOUNT 次數×Y（有規律重複時 Y＋(次數−1)×D），PERCENTAGE 依比例一次 */
  const thresholdAmount = (r: PricingSalesRule, value: number, base: number): { amount: number; points: number; times: number } => {
    const times = thresholdTimes(r, value);
    if (times <= 0) return { amount: 0, points: 0, times: 0 };
    const d = tieredDiscount(r, value);
    const rep = parseRepeatMinimum(r.settings?.repeatMinimumString ?? null);
    switch (r.dollarOrPercentage) {
      case "PERCENTAGE":
        return { amount: round((base * d) / 100), points: 0, times: 1 };
      case "POINT":
        return { amount: 0, points: Math.round(rep ? d + (times - 1) * rep.discount : d * times), times };
      default: {
        const amt = rep ? d + (times - 1) * rep.discount : d * times;
        return { amount: round(amt), points: 0, times };
      }
    }
  };

  const tagKeyOf = (r: PricingSalesRule): string | null => {
    const tags = parseTags(r.tag);
    return tags.length ? tags.join("|") : null;
  };
  const exclusiveBlocked = (r: PricingSalesRule): boolean => {
    const k = tagKeyOf(r);
    if (!k) return false;
    const prevCombinable = usedTagKeys.get(k);
    if (prevCombinable === undefined) return false;
    return !(prevCombinable && r.combinable);
  };
  const markTag = (r: PricingSalesRule) => {
    const k = tagKeyOf(r);
    if (k && !usedTagKeys.has(k)) usedTagKeys.set(k, !!r.combinable);
  };

  const record = (r: PricingSalesRule, discount: number, pts: number, times: number, ls: LineState[], description: string) => {
    for (const l of ls) if (!l.applied.includes(r.salesRuleId)) l.applied.push(r.salesRuleId);
    appliedRules.push({
      salesRuleId: r.salesRuleId,
      title: r.title,
      category: r.category,
      level: ruleLevel(r.category),
      discount: round(discount),
      points: pts,
      times,
      lineKeys: ls.map((l) => l.src.key),
      description,
    });
    points += pts;
    markTag(r);
  };

  /** 套用單件折扣到 units（前 maxUnits 件），回傳總折扣與受影響的行 */
  const applyUnitDiscount = (r: PricingSalesRule, units: Unit[], maxUnits: number, d: number, cap: number): { total: number; lines: LineState[] } => {
    const per = new Map<LineState, number>();
    let total = 0;
    const take = maxUnits >= 0 ? units.slice(0, maxUnits) : units;
    for (const u of take) {
      let x = unitDiscount(r.dollarOrPercentage, d, u.net, u.retail);
      if (total + x > cap) x = Math.max(0, cap - total);
      if (x <= 0) continue;
      total += x;
      per.set(u.line, (per.get(u.line) ?? 0) + x);
    }
    let applied = 0;
    for (const [l, x] of per) {
      const v = Math.min(round(x), netOf(l));
      l.discount = round(l.discount + v);
      applied += v;
    }
    return { total: round(applied), lines: [...per.keys()] };
  };
  const applySpread = (total: number, ls: LineState[]): { total: number; lines: LineState[] } => {
    const m = spread(total, ls, round);
    let applied = 0;
    for (const [l, v] of m) {
      l.discount = round(l.discount + v);
      applied += v;
    }
    return { total: round(applied), lines: [...m.keys()] };
  };

  for (const r of sorted) {
    const cat = r.category;
    if (isConstraintCategory(cat)) continue;
    if (exclusiveBlocked(r)) continue;
    const minimum = toNumber(r.minimum);
    const d = toNumber(r.discount);
    const maxApply = Math.trunc(toNumber(r.maxApplyTimes, -1));
    const tags = parseTags(r.tag);
    const cap = maxDiscountCap(r);

    // ── 整張訂單 ──
    if (cat === "MINIMUM_PRICE_MEET") {
      const ls = targetLines(r);
      const base = netSum(ls);
      // 門檻以商品淨額（已扣[商品][同品項]折扣）判斷；依折數時以再扣掉先套用的[整張訂單]折扣後的金額計算
      const res = thresholdAmount(r, base, Math.max(0, base - orderDiscount));
      if (res.times <= 0) continue;
      let amount = Math.min(res.amount, cap);
      const minAfter = toNumber(r.settings?.minDiscountTotalPrice, 0);
      if (minAfter > 0) amount = Math.max(0, Math.min(amount, base - orderDiscount - minAfter));
      amount = Math.max(0, Math.min(amount, base - orderDiscount));
      if (amount <= 0 && res.points <= 0) continue;
      orderDiscount = round(orderDiscount + amount);
      record(r, amount, res.points, res.times, ls, res.points > 0 ? `訂單滿${minimum}獲得點數${res.points}` : `訂單滿${minimum}折抵${amount}`);
      continue;
    }

    if (isGiftCategory(cat)) {
      const giftTag = tags.length ? tags[tags.length - 1] : null;
      const mainTags = tags.slice(0, -1);
      const notGiftTag = (l: LineState) => !(giftTag && l.tags.includes(giftTag));
      let ls: LineState[];
      if (cat === "GIFT_WITH_PURCHASE" || cat.endsWith("_TOTAL_PAID")) {
        // 整張訂單滿額（排除不合併計算標籤/不列入優惠的商品）
        ls = baseLines(r).filter(notGiftTag);
      } else if (mainTags.length) {
        // 主商品＝帶主商品標籤者
        ls = baseLines(r).filter((l) => hasAnyTag(l, mainTags));
      } else {
        // 未設主商品標籤：有綁定商品/品項時＝綁定者；否則所有商品均為主商品（原站欄位說明）
        const bound = baseLines(r).filter((l) => l.ruleIds.includes(r.salesRuleId) && notGiftTag(l));
        ls = bound.length ? bound : baseLines(r).filter(notGiftTag);
      }
      const mit = String(r.mainItemType ?? "ANY");
      if (mit === "INSTOCK") ls = ls.filter((l) => !l.src.backOrder);
      if (mit === "BACKORDER") ls = ls.filter((l) => !!l.src.backOrder);
      const byPiece = cat.includes("PIECE") || cat === "GIFT_LOTTERY";
      const value = byPiece ? qtyOf(ls) : netSum(ls);
      const times = giftTimes(r, value);
      if (times <= 0) continue;
      const qty = Math.max(1, Math.round(d || 1)) * times;
      const pick = !cat.includes("NO_PICK") && cat !== "GIFT_WITH_PURCHASE" && cat !== "GIFT_LOTTERY";
      gifts.push({
        salesRuleId: r.salesRuleId,
        title: r.title,
        category: cat,
        giftTag,
        quantity: qty,
        mode: pick ? "PICK" : "AUTO",
        giftTagRule: cat === "GIFT_LOTTERY" ? "ONE" : String(r.settings?.giftTagRule ?? "ALL").toUpperCase() === "ONE" ? "ONE" : "ALL",
        mandatory: !!r.settings?.giftMandatory,
        random: cat === "GIFT_LOTTERY" || String(r.settings?.giftTagRule ?? "").toUpperCase() === "ONE",
        randomIndexSeed: random(),
      });
      record(r, 0, 0, times, ls, `${byPiece ? "滿" + minimum + "件" : "滿" + minimum + "元"}贈品${qty}件`);
      continue;
    }

    if (isAdditionalPurchaseCategory(cat)) {
      const addonTag = tags.length ? tags[tags.length - 1] : null;
      const mainTags = tags.slice(0, -1);
      const optional = cat.endsWith("_OPTIONAL");
      const all = baseLines(r);
      const addonLines = addonTag ? all.filter((l) => l.tags.includes(addonTag)) : all.filter((l) => l.ruleIds.includes(r.salesRuleId));
      const mainLines = mainTags.length
        ? all.filter((l) => hasAnyTag(l, mainTags) && !addonLines.includes(l))
        : all.filter((l) => !addonLines.includes(l));
      const byPrice = cat.includes("PRICE_MEET");
      const value = byPrice ? netSum(mainLines) : qtyOf(mainLines);
      const satisfied = value >= minimum && value > 0;
      let allowed = 0;
      if (satisfied) {
        const t = minimum > 0 ? Math.floor(value / minimum) : 1;
        allowed = maxApply > 0 ? Math.min(t, maxApply) : maxApply === -1 ? t : 1;
        if (maxApply === -1 && minimum <= 0) allowed = -1;
      }
      const units = unitsOf(addonLines, sortDesc(r));
      const res = satisfied ? applyUnitDiscount(r, units, allowed, d, cap) : { total: 0, lines: [] as LineState[] };
      const addonQty = qtyOf(addonLines);
      const used = allowed === -1 ? addonQty : Math.min(addonQty, allowed);
      additional.push({ salesRuleId: r.salesRuleId, title: r.title, category: cat, addonTag, allowedUnits: allowed, usedUnits: used, optional, satisfied });
      if (!optional && addonQty > 0 && (!satisfied || (allowed >= 0 && addonQty > allowed))) {
        constraints.push({
          salesRuleId: r.salesRuleId,
          title: r.title,
          category: cat,
          satisfied: false,
          scope: "CHECKOUT",
          message: satisfied ? `加購商品「${r.title}」最多可加購${allowed}件` : `加購商品「${r.title}」需搭配主商品購買`,
        });
      }
      if (res.total > 0) record(r, res.total, 0, used, res.lines, `加購價折抵${res.total}`);
      continue;
    }

    if (cat === "ITEM_BUY_X_GOT_Y_FREE") {
      const x = Math.max(1, Math.round(minimum));
      const y = Math.max(0, Math.round(d));
      let total = 0;
      const ls: LineState[] = [];
      for (const l of targetLines(r)) {
        const times = capTimes(Math.floor(l.qty / x), maxApply);
        if (times <= 0 || y <= 0) continue;
        total += times;
        ls.push(l);
        gifts.push({
          salesRuleId: r.salesRuleId,
          title: r.title,
          category: cat,
          giftTag: null,
          quantity: times * y,
          mode: "AUTO",
          giftTagRule: "ALL",
          mandatory: false,
          random: false,
          randomIndexSeed: random(),
          sameItemId: l.src.itemId,
        });
      }
      if (total > 0) record(r, 0, 0, total, ls, `買${x}送${y}`);
      continue;
    }

    if (cat === "ITEM_EXCLUDED") {
      // 已於前面標記排除；這裡只記錄
      const ls = lines.filter((l) => l.excluded && (l.ruleIds.includes(r.salesRuleId) || hasAnyTag(l, tags)));
      if (ls.length) record(r, 0, 0, 0, ls, "不列入優惠計算");
      continue;
    }

    // ── [商品] ──
    if (cat === "ITEM_PRICE_MEET") {
      const ls = targetLines(r);
      const base = netSum(ls);
      const res = thresholdAmount(r, base, base);
      if (res.times <= 0) continue;
      const amount = Math.min(res.amount, cap, base);
      const applied = applySpread(amount, ls);
      if (applied.total > 0 || res.points > 0) record(r, applied.total, res.points, res.times, applied.lines, `商品滿${minimum}折抵${applied.total}`);
      continue;
    }

    if (cat === "TAG_MATCH") {
      const ls = tags.length ? baseLines(r).filter((l) => hasAnyTag(l, tags) || l.ruleIds.includes(r.salesRuleId)) : targetLines(r);
      const matchRule = String(r.settings?.tagMatchRule ?? "ALL").toUpperCase() === "ANY" ? "ANY" : "ALL";
      const tagMins = String(r.settings?.tagMinimums ?? "")
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Math.max(1, Math.round(toNumber(x, 1))));
      const perTag = tags.map((t, i) => ({ tag: t, min: tagMins[i] ?? 1, lines: ls.filter((l) => l.tags.includes(t)) }));
      const okTag = (p: { min: number; lines: LineState[] }) => qtyOf(p.lines) >= p.min;
      const tagOk = tags.length === 0 || (matchRule === "ALL" ? perTag.every(okTag) : perTag.some(okTag));
      if (!tagOk || qtyOf(ls) < minimum || qtyOf(ls) <= 0) continue;
      let res: { total: number; lines: LineState[] };
      let times = 0;
      if (tagMins.length && tags.length) {
        // 組合價（標籤符合）：每組＝各標籤各 min 件，組數＝各標籤可湊組數的最小值
        const counted = matchRule === "ALL" ? perTag : perTag.filter(okTag);
        times = capTimes(Math.min(...counted.map((p) => Math.floor(qtyOf(p.lines) / p.min))), maxApply);
        const units: Unit[] = [];
        const taken = new Map<LineState, number>(); // 同一件商品帶多個標籤時不重複計件
        for (const p of counted) {
          let need = times * p.min;
          for (const u of unitsOf(p.lines, sortDesc(r))) {
            if (need <= 0) break;
            const t = taken.get(u.line) ?? 0;
            if (t >= u.line.qty) continue;
            taken.set(u.line, t + 1);
            units.push(u);
            need--;
          }
        }
        res = applyUnitDiscount(r, units, -1, d, cap);
      } else {
        const units = unitsOf(ls, sortDesc(r));
        times = maxApply > 0 ? Math.min(units.length, maxApply) : units.length;
        res = applyUnitDiscount(r, units, maxApply > 0 ? maxApply : -1, d, cap);
      }
      if (res.total > 0) record(r, res.total, 0, times, res.lines, `標籤符合折抵${res.total}`);
      continue;
    }

    if (cat === "ITEM_PACKAGE") continue; // 限制類，於後面檢查

    // ── [同品項] ──
    if (cat === "MINIMUM_PRICE_MEET_ITS" && tags.length >= 2) {
      // 同品項滿額標籤商品折扣：門檻＝帶品項標籤（前面幾個）或綁定的商品；折扣只給帶商品標籤（最後一個）的商品
      const condTags = tags.slice(0, -1);
      const discTag = tags[tags.length - 1];
      const cond = baseLines(r).filter((l) => hasAnyTag(l, condTags) || l.ruleIds.includes(r.salesRuleId));
      const value = netSum(cond);
      if (value <= 0 || value < minimum) continue;
      const units = unitsOf(baseLines(r).filter((l) => l.tags.includes(discTag)), sortDesc(r));
      const res = applyUnitDiscount(r, units, maxApply > 0 ? maxApply : -1, tieredDiscount(r, value), cap);
      if (res.total > 0) record(r, res.total, 0, Math.min(units.length, maxApply > 0 ? maxApply : units.length), res.lines, `同品項滿${minimum}元折抵${res.total}`);
      continue;
    }
    const target = targetLines(r);
    for (const g of groupsOf(r, target)) {
      if (cat === "MINIMUM_PIECE_MEET" || cat === "MINIMUM_PRICE_MEET_ITS" || cat === "MINIMUM_PIECE_MEET_MAIN_PIECE") {
        let group = g;
        if (cat === "MINIMUM_PIECE_MEET_MAIN_PIECE" && tags.length) {
          // 主商品標籤（第一個）需先滿足最少件數；折扣只給非主商品
          const mainTag = tags[0];
          const mainMin = Math.max(1, Math.round(toNumber(r.settings?.mainTagMinimum, 1)));
          const mainQty = qtyOf(baseLines(r).filter((l) => l.tags.includes(mainTag)));
          if (mainQty < mainMin) continue;
          group = g.filter((l) => !l.tags.includes(mainTag));
        }
        const byPrice = cat === "MINIMUM_PRICE_MEET_ITS";
        const value = byPrice ? netSum(group) : qtyOf(group);
        if (value < minimum || value <= 0) continue;
        if (r.dollarOrPercentage === "DOLLAR_PACK_DISCOUNT") {
          const res0 = thresholdAmount({ ...r, dollarOrPercentage: "DOLLAR" }, value, netSum(group));
          const res = applySpread(Math.min(res0.amount, cap, netSum(group)), group);
          if (res.total > 0) record(r, res.total, 0, res0.times, res.lines, `同品項滿${minimum}${byPrice ? "元" : "件"}折抵${res.total}`);
        } else {
          const units = unitsOf(group, sortDesc(r));
          const dd = tieredDiscount(r, value);
          const res = applyUnitDiscount(r, units, maxApply > 0 ? maxApply : -1, dd, cap);
          if (res.total > 0) record(r, res.total, 0, Math.min(units.length, maxApply > 0 ? maxApply : units.length), res.lines, `同品項滿${minimum}${byPrice ? "元" : "件"}折抵${res.total}`);
        }
        continue;
      }
      if (cat === "X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT") {
        const x = Math.max(0, Math.round(minimum));
        const units = unitsOf(g, sortDesc(r));
        if (units.length <= x) continue;
        // X 件原價，超過的每件折扣 Y：依「商品折扣順序」排在前面的件數先折（預設價格低至高 → 便宜的先折）
        const rest = units.slice(0, units.length - x);
        const res = applyUnitDiscount(r, rest, maxApply > 0 ? maxApply : -1, d, cap);
        if (res.total > 0) record(r, res.total, 0, rest.length, res.lines, `${x}件原價，超過每件折${d}`);
        continue;
      }
      if (cat === "ITEMSET_BUY_X_GOT_Y_FREE") {
        const x = Math.max(1, Math.round(minimum));
        const y = Math.max(0, Math.round(d));
        const units = unitsOf(g, false); // 送最便宜的
        const times = capTimes(Math.floor(units.length / (x + y)), maxApply);
        if (times <= 0 || y <= 0) continue;
        const free = units.slice(0, times * y);
        const res = applyUnitDiscount({ ...r, dollarOrPercentage: "PERCENTAGE" }, free, -1, 100, cap);
        if (res.total > 0) record(r, res.total, 0, times, res.lines, `同品項買${x}送${y}`);
        continue;
      }
      if (cat === "ITEMSET_BUNDLE_PRICE") {
        const n = Math.max(1, Math.round(minimum));
        const units = unitsOf(g, sortDesc(r));
        const times = capTimes(Math.floor(units.length / n), maxApply);
        if (times <= 0) continue;
        let total = 0;
        const per = new Map<LineState, number>();
        for (let t = 0; t < times; t++) {
          const bundle = units.slice(t * n, t * n + n);
          const sum = bundle.reduce((s, u) => s + u.net, 0);
          const save = Math.max(0, sum - d);
          if (save <= 0 || sum <= 0) continue;
          // 依單價比例分攤到組內各件
          bundle.forEach((u) => per.set(u.line, (per.get(u.line) ?? 0) + (save * u.net) / sum));
          total += save;
        }
        const scale = total > cap ? cap / total : 1;
        let applied = 0;
        for (const [l, v] of per) {
          const x = Math.min(round(v * scale), netOf(l));
          l.discount = round(l.discount + x);
          applied += x;
        }
        if (applied > 0) record(r, applied, 0, times, [...per.keys()], `${n}件組合價${d}`);
        continue;
      }
    }
  }

  // ── 限制類 ──
  const afterRules = (ls: LineState[]) => round(netSum(ls));
  for (const r of sorted) {
    const cat = r.category;
    if (!isConstraintCategory(cat)) continue;
    const minimum = toNumber(r.minimum);
    const maxApply = Math.trunc(toNumber(r.maxApplyTimes, -1));
    if (cat === "CHECKOUT_MINIMUM_PRICE" || cat === "CREDIT_CARD") {
      const value = Math.max(0, afterRules(baseLines(r)) - orderDiscount);
      const ok = value >= minimum;
      constraints.push({
        salesRuleId: r.salesRuleId,
        title: r.title,
        category: cat,
        satisfied: ok,
        scope: cat === "CREDIT_CARD" ? "CREDIT_CARD" : "CHECKOUT",
        message: ok ? "" : cat === "CREDIT_CARD" ? `訂單金額需滿${minimum}才能使用信用卡付款` : `結帳訂單金額(不含運)需滿${minimum}`,
      });
      continue;
    }
    if (cat === "ITEM_PACKAGE") {
      const tags = parseTags(r.tag);
      const rule = String(r.settings?.packRule?.rule ?? "").toUpperCase();
      const subTotal = Math.round(toNumber(r.settings?.packRule?.subItemTotal, 0));
      if (tags.length < 2) continue;
      const all = baseLines(r);
      const mainQty = qtyOf(all.filter((l) => l.tags.includes(tags[0])));
      if (mainQty <= 0) continue;
      if (rule === "SUM_TAG" && subTotal > 0) {
        // 加總數量：所有子商品標籤合計＝組合包數×子商品加總數量
        const subQty = qtyOf(all.filter((l) => hasAnyTag(l, tags.slice(1))));
        const ok = subQty === mainQty * subTotal;
        constraints.push({
          salesRuleId: r.salesRuleId,
          title: r.title,
          category: cat,
          satisfied: ok,
          scope: "CHECKOUT",
          message: ok ? "" : `「${r.title}」子商品需選擇${mainQty * subTotal}件（目前${subQty}件）`,
        });
      } else if (rule === "BY_TAG") {
        // 依標籤個別計算（推導，PARITY #48）：每個子商品標籤各需＝組合包數（每包每個標籤一件）
        const bad = tags.slice(1).map((t) => ({ t, q: qtyOf(all.filter((l) => l.tags.includes(t))) })).filter((x) => x.q !== mainQty);
        constraints.push({
          salesRuleId: r.salesRuleId,
          title: r.title,
          category: cat,
          satisfied: bad.length === 0,
          scope: "CHECKOUT",
          message: bad.length ? `「${r.title}」${bad.map((x) => `「${x.t}」需選擇${mainQty}件（目前${x.q}件）`).join("、")}` : "",
        });
      }
      continue;
    }
    for (const g of groupsOf(r, targetLines(r))) {
      const qty = qtyOf(g);
      if (qty <= 0) continue;
      let value = 0;
      let unit = "件";
      if (cat === "MINIMUM_PIECE_CONSTRAINT") value = qty;
      if (cat === "MINIMUM_PRICE_CONSTRAINT") {
        value = netSum(g);
        unit = "元";
      }
      if (cat === "ITEMSET_LIMITED_ITEMS") {
        value = new Set(g.map((l) => l.src.itemId)).size;
        unit = "種";
      }
      const tooFew = minimum > 0 && value < minimum;
      const tooMany = maxApply > 0 && value > maxApply;
      const ok = !tooFew && !tooMany;
      constraints.push({
        salesRuleId: r.salesRuleId,
        title: r.title,
        category: cat,
        satisfied: ok,
        scope: "CHECKOUT",
        message: ok ? "" : tooFew ? `「${r.title}」最少需選購${minimum}${unit}（目前${value}${unit}）` : `「${r.title}」最多只能選購${maxApply}${unit}（目前${value}${unit}）`,
      });
    }
  }

  // ── 優惠卷 ──
  const itemDiscount = round(lines.reduce((s, l) => s + l.discount, 0));
  const salesRuleDiscount = round(itemDiscount + orderDiscount);
  let couponDiscount = 0;
  let freeShipping = false;
  let shippingConditionX = false;
  if (coupon && input.coupon && coupon.valid) {
    const c = input.coupon;
    const cls = lines.filter((l) => !l.gift && !l.excluded && l.qty > 0);
    const base = Math.max(0, netSum(cls) - orderDiscount);
    const qty = qtyOf(cls);
    const minimum = toNumber(c.minimum);
    const d = toNumber(c.discount);
    const maxD = toNumber(c.maxDiscount, 0);
    const value = (amount: number): number => {
      switch (c.dollarOrPercentage) {
        case "PERCENTAGE":
          return round((amount * d) / 100);
        case "BUNDLE_PRICE":
          return Math.max(0, round(amount - d));
        case "POINT":
          return 0;
        default:
          return d;
      }
    };
    let amount = 0;
    let pts = 0;
    let ok = true;
    let msg = "";
    switch (c.category) {
      case "MINIMUM_PRICE_MEET":
        ok = base >= minimum && base > 0;
        if (ok) {
          amount = value(base);
          if (c.dollarOrPercentage === "POINT") pts = Math.round(d);
        } else msg = `訂單金額需滿${minimum}才能使用此折扣碼`;
        break;
      case "MINIMUM_PIECE_MEET":
        ok = qty >= minimum && qty > 0;
        if (ok) {
          amount = value(base);
          if (c.dollarOrPercentage === "POINT") pts = Math.round(d);
        } else msg = `訂單件數需滿${minimum}件才能使用此折扣碼`;
        break;
      case "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE": {
        const times = minimum > 0 ? Math.floor(base / minimum) : base > 0 ? 1 : 0;
        ok = times > 0;
        if (ok) amount = c.dollarOrPercentage === "PERCENTAGE" ? value(base) : round(d * times);
        else msg = `訂單金額需滿${minimum}才能使用此折扣碼`;
        break;
      }
      case "SALES_RULE": {
        const r = appliedRules.find((a) => a.salesRuleId === c.salesRuleId);
        ok = !!r;
        msg = ok ? "" : "未符合此折扣碼綁定的優惠條件";
        break;
      }
      case "FREE_SHIPPING":
        ok = base >= minimum;
        if (ok) freeShipping = true;
        else msg = `訂單金額需滿${minimum}才能免運費`;
        break;
      case "FREE_SHIPPING_X":
        shippingConditionX = true;
        break;
      case "POINT":
        pts = Math.round(d);
        break;
      case "POINT_RANDOM": {
        const lo = Math.min(minimum, d);
        const hi = Math.max(minimum, d);
        pts = Math.round(lo + Math.floor(random() * (hi - lo + 1)));
        break;
      }
      default:
        ok = false;
        msg = "不支援的優惠卷類型";
    }
    if (ok && c.combinable === false && salesRuleDiscount > 0 && amount > 0) {
      ok = false;
      amount = 0;
      msg = "此折扣碼無法與其他優惠合併使用";
    }
    if (ok) {
      if (maxD > 0) amount = Math.min(amount, maxD);
      amount = Math.max(0, Math.min(amount, base));
      couponDiscount = round(amount);
      points += pts;
    }
    coupon.applied = ok;
    coupon.discount = couponDiscount;
    coupon.points = ok ? pts : 0;
    coupon.freeShipping = freeShipping;
    coupon.shippingConditionX = shippingConditionX;
    coupon.message = msg;
    if (!ok && msg) messages.push(msg);
  } else if (coupon && !coupon.valid && coupon.message) {
    messages.push(coupon.message);
  }

  for (const c of constraints) if (!c.satisfied && c.message) messages.push(c.message);

  const subtotal = round(lines.reduce((s, l) => s + l.amount, 0));
  const totalDiscount = round(salesRuleDiscount + couponDiscount);
  return {
    subtotal,
    lines: lines.map((l) => ({
      key: l.src.key,
      itemId: l.src.itemId,
      title: l.src.title,
      price: l.price,
      quantity: l.qty,
      amount: l.amount,
      discount: l.discount,
      totalPriceAfterDiscount: round(l.amount - l.discount),
      appliedSalesRuleIds: l.applied,
    })),
    appliedRules,
    gifts,
    additionalPurchases: additional,
    constraints,
    coupon,
    itemDiscount,
    orderDiscount,
    couponDiscount,
    salesRuleDiscount,
    totalDiscount,
    points,
    freeShipping,
    shippingConditionX,
    checkoutAllowed: constraints.every((c) => c.satisfied || c.scope !== "CHECKOUT"),
    creditCardAllowed: constraints.every((c) => c.satisfied || c.scope !== "CREDIT_CARD"),
    grandTotalWithoutShipping: Math.max(0, round(subtotal - totalDiscount)),
    messages,
  };
}

/**
 * 把贈品權益展開成具體贈品（給呼叫端已查好的候選贈品清單）。
 * candidatesByTag：贈品標籤 → 候選商品（通常是 itemType=GIFT 且帶該標籤的商品）。
 * AUTO＋ALL：每個候選都送 quantity 件；AUTO＋ONE：依 randomIndexSeed 挑一個送 quantity 件；
 * PICK：不展開（由消費者挑選，回傳 pick 清單）。
 */
export function resolveGifts(
  gifts: GiftEntitlement[],
  candidatesByTag: Record<string, { itemId: number; title: string }[]>,
): { auto: { salesRuleId: number; itemId: number; title: string; quantity: number }[]; pick: { salesRuleId: number; giftTag: string | null; quantity: number; mandatory: boolean; candidates: { itemId: number; title: string }[] }[] } {
  const auto: { salesRuleId: number; itemId: number; title: string; quantity: number }[] = [];
  const pick: { salesRuleId: number; giftTag: string | null; quantity: number; mandatory: boolean; candidates: { itemId: number; title: string }[] }[] = [];
  for (const g of gifts) {
    if (g.sameItemId) {
      auto.push({ salesRuleId: g.salesRuleId, itemId: g.sameItemId, title: "", quantity: g.quantity });
      continue;
    }
    const cands = g.giftTag ? candidatesByTag[g.giftTag] ?? [] : [];
    if (g.mode === "PICK") {
      pick.push({ salesRuleId: g.salesRuleId, giftTag: g.giftTag, quantity: g.quantity, mandatory: g.mandatory, candidates: cands });
      continue;
    }
    if (cands.length === 0) continue;
    if (g.giftTagRule === "ONE") {
      const i = Math.min(cands.length - 1, Math.floor(g.randomIndexSeed * cands.length));
      auto.push({ salesRuleId: g.salesRuleId, itemId: cands[i].itemId, title: cands[i].title, quantity: g.quantity });
    } else {
      for (const c of cands) auto.push({ salesRuleId: g.salesRuleId, itemId: c.itemId, title: c.title, quantity: g.quantity });
    }
  }
  return { auto, pick };
}
