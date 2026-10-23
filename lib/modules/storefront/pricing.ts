// storefront 計價（伺服器端唯一可信的金額來源；購物袋顯示與建立訂單都呼叫這裡，絕不採用前端送來的金額）。
// orders 模組可 import（只讀依賴）：priceCart()、型別 PricingInput / PricingResult。
//
// 運費正式版由 shipping 模組提供（lib/modules/shipping/shipping-fee.ts）、優惠正式版由 marketing 模組提供
// （lib/modules/marketing/pricing-rules.ts）。兩者尚未推上 main 前，使用本檔的降級實作（fallback*），
// 介面固定在 ShippingFeeProvider / PricingRulesProvider，正式版推上後只換 provider。
import { getServiceClient } from "@/lib/supabase/server";
import type { SfGroupBuy } from "./site";

// ───────────────────────── 型別 ─────────────────────────

export interface PricingLine {
  /** 購物袋明細 uuid（訂單建立時對應 order_items） */
  uuid: string;
  itemId: number;
  groupBuyItemSetId: number;
  itemSetId: number;
  title: string;
  price: number;
  qty: number;
  /** 預購（可售現貨不足、用可售預購） */
  backOrder: boolean;
  gift?: boolean;
  flatRateShippingTag?: string;
  excludeShippingRule?: boolean;
  weight?: number;
}

export interface ShippingAddressInput {
  country?: string;
  postcode?: string;
  city?: string;
  district?: string;
}

export interface PricingInput {
  tenantId: number;
  groupBuy: SfGroupBuy;
  lines: PricingLine[];
  /** 已兌換的折扣碼（coupon_codes.code） */
  couponCodes: string[];
  customerId: number | null;
  /** 選定的運費規則（flat_rate_shippings.id）；null＝尚未選擇（顯示第一個可用規則的運費） */
  flatRateShippingId: number | null;
  /** 付款方式位元（1 銀行轉帳、4 信用卡、16 貨到付款…）；0＝尚未選擇 */
  paymentMethod: number;
  shippingAddress: ShippingAddressInput;
}

export interface AppliedSalesRule {
  salesRuleId: number;
  title: string;
  discount: number;
  category: string;
}

export interface AppliedCoupon {
  groupBuyCouponId: number;
  couponCodeId: number | null;
  code: string;
  title: string;
  category: string;
  discount: number;
}

export interface FlatRateShippingRow {
  id: number;
  shipping_type: string;
  category: string;
  title: string;
  x: number;
  y: number;
  z: number;
  pay_on_delivery_fee: number;
  island_fee: number;
  island_shipping_rate_type: string;
  oversea_fee: number;
  extended_area_fee: number;
  extended_areas: string[];
  islands: string[];
  payment_methods: string[];
  island_payment_methods: string[];
  flat_rate_shipping_settings: Record<string, unknown>;
  flat_rate_shipping_tag: string | null;
  /** group_buy_flat_rate_shippings.id */
  groupBuyFlatRateShippingId: number;
  seq: number;
}

export interface ShippingQuote {
  flatRateShippingId: number | null;
  shippingAmount: number;
  codFee: number;
  /** 再買多少免運的提示句（沒有就 null） */
  amountToFreeShipping: string | null;
  freeShippingLabel: string;
  island: boolean;
  oversea: boolean;
}

export interface PricingResult {
  subtotal: number;
  lineDiscounts: Map<string, number>;
  salesRules: AppliedSalesRule[];
  coupons: AppliedCoupon[];
  /** 優惠條件＋優惠卷折扣合計 */
  totalDiscount: number;
  couponTotalDiscount: number;
  grandTotalWithoutShipping: number;
  shipping: ShippingQuote;
  tax: number;
  grandTotal: number;
  totalPieces: number;
  /** 優惠卷未成立的原因（例如未達門檻） */
  couponNotes: string[];
  errors: string[];
}

export interface ShippingFeeProvider {
  quote(args: {
    tenantId: number;
    groupBuy: SfGroupBuy;
    rules: FlatRateShippingRow[];
    flatRateShippingId: number | null;
    lines: PricingLine[];
    /** 折扣後商品金額 */
    amount: number;
    paymentMethod: number;
    address: ShippingAddressInput;
  }): Promise<ShippingQuote> | ShippingQuote;
}

export interface PricingRulesProvider {
  apply(args: {
    tenantId: number;
    groupBuy: SfGroupBuy;
    lines: PricingLine[];
    couponCodes: string[];
    customerId: number | null;
  }): Promise<{ salesRules: AppliedSalesRule[]; coupons: AppliedCoupon[]; lineDiscounts: Map<string, number>; couponNotes: string[] }>;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round = (v: number) => Math.round(v);

// ───────────────────────── 運費規則讀取 ─────────────────────────

export async function loadGroupBuyShippingRules(tenantId: number, groupBuyId: number): Promise<FlatRateShippingRow[]> {
  const { data, error } = await getServiceClient()
    .from("group_buy_flat_rate_shippings")
    .select(
      "id, seq, flat_rate_shippings(id, shipping_type, category, title, x, y, z, pay_on_delivery_fee, island_fee, island_shipping_rate_type, oversea_fee, extended_area_fee, extended_areas, islands, payment_methods, island_payment_methods, flat_rate_shipping_settings, flat_rate_shipping_tag)",
    )
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("seq", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`讀取運費規則失敗：${error.message}`);
  const out: FlatRateShippingRow[] = [];
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const f = r.flat_rate_shippings as Record<string, unknown> | null;
    if (!f) continue;
    out.push({
      id: num(f.id),
      shipping_type: String(f.shipping_type ?? "NORMAL"),
      category: String(f.category ?? "PRICE"),
      title: String(f.title ?? ""),
      x: num(f.x),
      y: num(f.y),
      z: num(f.z),
      pay_on_delivery_fee: num(f.pay_on_delivery_fee),
      island_fee: num(f.island_fee),
      island_shipping_rate_type: String(f.island_shipping_rate_type ?? "REPLACE_BASE_RATE"),
      oversea_fee: num(f.oversea_fee),
      extended_area_fee: num(f.extended_area_fee),
      extended_areas: (f.extended_areas as string[]) ?? [],
      islands: (f.islands as string[]) ?? [],
      payment_methods: (f.payment_methods as string[]) ?? [],
      island_payment_methods: (f.island_payment_methods as string[]) ?? [],
      flat_rate_shipping_settings: (f.flat_rate_shipping_settings as Record<string, unknown>) ?? {},
      flat_rate_shipping_tag: (f.flat_rate_shipping_tag as string) ?? null,
      groupBuyFlatRateShippingId: num(r.id),
      seq: num(r.seq),
    });
  }
  return out;
}

/** 台灣外島郵遞區號（運費規則 islands 未設定時的預設：澎湖、金門、連江、綠島、蘭嶼、琉球） */
export const DEFAULT_ISLAND_POSTCODES = new Set([
  "209", "210", "211", "212", "880", "881", "882", "883", "884", "885", "890", "891", "892", "893", "894", "896", "929", "951", "952",
]);

export function isIslandPostcode(postcode: string | undefined, rule?: FlatRateShippingRow | null): boolean {
  const p = String(postcode ?? "").trim().slice(0, 3);
  if (!/^\d{3}$/.test(p)) return false;
  const list = rule?.islands?.filter((x) => x && x !== "0") ?? [];
  return list.length ? list.includes(p) : DEFAULT_ISLAND_POSTCODES.has(p);
}

// ───────────────────────── 降級實作：運費 ─────────────────────────

/** 依運費規則計算基本運費（PRICE/PRICE_TAG：金額未滿 x 收 y、滿 x 收 z；PIECE/PIECE_TAG：件數；PER_PIECE：每件；STANDARD_FREE：0） */
export function baseShippingFee(rule: FlatRateShippingRow, amount: number, pieces: number, weight: number): number {
  switch (rule.category) {
    case "STANDARD_FREE":
      return 0;
    case "PIECE":
    case "PIECE_TAG":
      return pieces <= 0 ? 0 : pieces <= rule.x ? rule.y : rule.z;
    case "PER_PIECE":
      return pieces <= 0 ? 0 : pieces <= rule.x ? rule.y * pieces : rule.z * pieces;
    case "WEIGHT":
      return weight <= rule.x ? rule.y : rule.z;
    case "PRICE":
    case "PRICE_TAG":
    case "MIX":
    default:
      return amount < rule.x ? rule.y : rule.z;
  }
}

export const fallbackShippingFee: ShippingFeeProvider = {
  quote({ rules, flatRateShippingId, lines, amount, paymentMethod, address, groupBuy }) {
    const rule = rules.find((r) => r.id === flatRateShippingId) ?? null;
    const freeLabel = String(rule?.flat_rate_shipping_settings?.freeShippingLabel ?? "") || "免運";
    const oversea = !!address.country && address.country !== "TW";
    if (!rule || lines.length === 0) {
      return { flatRateShippingId: rule?.id ?? null, shippingAmount: 0, codFee: 0, amountToFreeShipping: null, freeShippingLabel: freeLabel, island: false, oversea };
    }
    const shippable = lines.filter((l) => !l.excludeShippingRule && !l.gift);
    const pieces = shippable.reduce((s, l) => s + l.qty, 0);
    const weight = shippable.reduce((s, l) => s + (l.weight ?? 0) * l.qty, 0);
    let fee = shippable.length ? baseShippingFee(rule, amount, pieces, weight) : 0;
    const island = rule.shipping_type === "NORMAL" && !oversea && isIslandPostcode(address.postcode, rule);
    if (island && rule.island_fee > 0) fee = rule.island_shipping_rate_type === "TOP_ON_BASE_RATE" ? fee + rule.island_fee : rule.island_fee;
    if (oversea && rule.oversea_fee > 0) fee += rule.oversea_fee;
    if (rule.extended_area_fee > 0 && rule.extended_areas.includes(String(address.postcode ?? "").slice(0, 3))) fee += rule.extended_area_fee;
    // 貨到付款手續費（付款方式位元 16）
    const codFee = paymentMethod === 16 ? rule.pay_on_delivery_fee : 0;
    let hint: string | null = null;
    if ((rule.category === "PRICE" || rule.category === "PRICE_TAG") && rule.z < rule.y && amount > 0 && amount < rule.x && !island) {
      hint = `再買 ${groupBuy.currency === "TWD" ? "NT$" : ""}${round(rule.x - amount)} 即可享${rule.z === 0 ? freeLabel : "運費優惠"}`;
    }
    return { flatRateShippingId: rule.id, shippingAmount: round(fee), codFee: round(codFee), amountToFreeShipping: hint, freeShippingLabel: freeLabel, island, oversea };
  },
};

// ───────────────────────── 降級實作：優惠條件＋優惠卷 ─────────────────────────

type SalesRuleRow = {
  id: number;
  title: string;
  category: string;
  dollar_or_percentage: string;
  discount: number;
  minimum: number;
  priority: number;
  is_active: boolean;
  date_start: string | null;
  date_end: string | null;
  available_quota: number;
  used_quota: number;
  hidden: boolean;
};

function activeNow(r: { date_start: string | null; date_end: string | null }, now = Date.now()): boolean {
  if (r.date_start && new Date(r.date_start).getTime() > now) return false;
  if (r.date_end && new Date(r.date_end).getTime() < now) return false;
  return true;
}

function discountOf(kind: string, discount: number, base: number): number {
  if (base <= 0) return 0;
  if (kind === "PERCENTAGE") return round((base * discount) / 100);
  return Math.min(base, round(discount));
}

/**
 * 降級版優惠計算（只實作最常用的類別，完整 34 類由 marketing 的 pricing-rules 負責）：
 * - 同品項/商品類（綁 item_sales_rules）：MINIMUM_PIECE_MEET（件數滿 minimum）、MINIMUM_PRICE_MEET_ITS / ITEM_PRICE_MEET（金額滿 minimum）
 * - 整張訂單類（綁 group_buy_item_set_sales_rules 或 apply_to_group_buy）：MINIMUM_PRICE_MEET（金額滿 minimum）
 * - 優惠卷（coupon_codes → group_buy_coupons）：MINIMUM_PRICE_MEET / MINIMUM_PIECE_MEET / DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE
 * 折扣型態：DOLLAR＝折抵金額；PERCENTAGE＝折 discount%（10＝九折）。
 */
export const fallbackPricingRules: PricingRulesProvider = {
  async apply({ tenantId, groupBuy, lines, couponCodes }) {
    const db = getServiceClient();
    const lineDiscounts = new Map<string, number>();
    const salesRules: AppliedSalesRule[] = [];
    const coupons: AppliedCoupon[] = [];
    const couponNotes: string[] = [];
    const paid = lines.filter((l) => !l.gift && l.qty > 0);
    if (paid.length === 0) return { salesRules, coupons, lineDiscounts, couponNotes };

    const itemIds = [...new Set(paid.map((l) => l.itemId))];
    const gbisIds = [...new Set(paid.map((l) => l.groupBuyItemSetId))];
    const [{ data: itemLinks }, { data: setLinks }, { data: gbRules }] = await Promise.all([
      db.from("item_sales_rules").select("item_id, sales_rule_id").eq("tenant_id", tenantId).in("item_id", itemIds),
      db.from("group_buy_item_set_sales_rules").select("group_buy_item_set_id, sales_rule_id").eq("tenant_id", tenantId).in("group_buy_item_set_id", gbisIds),
      db.from("sales_rules").select("id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuy.id).eq("apply_to_group_buy", true),
    ]);
    const ruleIds = new Set<number>();
    for (const r of (itemLinks ?? []) as { sales_rule_id: number }[]) ruleIds.add(num(r.sales_rule_id));
    for (const r of (setLinks ?? []) as { sales_rule_id: number }[]) ruleIds.add(num(r.sales_rule_id));
    for (const r of (gbRules ?? []) as { id: number }[]) ruleIds.add(num(r.id));
    let rules: SalesRuleRow[] = [];
    if (ruleIds.size) {
      const { data } = await db
        .from("sales_rules")
        .select("id, title, category, dollar_or_percentage, discount, minimum, priority, is_active, date_start, date_end, available_quota, used_quota, hidden")
        .eq("tenant_id", tenantId)
        .in("id", [...ruleIds]);
      rules = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: num(r.id),
        title: String(r.title ?? ""),
        category: String(r.category ?? ""),
        dollar_or_percentage: String(r.dollar_or_percentage ?? "DOLLAR"),
        discount: num(r.discount),
        minimum: num(r.minimum),
        priority: num(r.priority, 1),
        is_active: !!r.is_active,
        date_start: (r.date_start as string) ?? null,
        date_end: (r.date_end as string) ?? null,
        available_quota: num(r.available_quota, -1),
        used_quota: num(r.used_quota),
        hidden: !!r.hidden,
      }));
    }
    rules = rules.filter((r) => r.is_active && activeNow(r) && (r.available_quota < 0 || r.used_quota < r.available_quota));
    const linesOfRule = (ruleId: number): PricingLine[] => {
      const items = new Set(((itemLinks ?? []) as { item_id: number; sales_rule_id: number }[]).filter((x) => num(x.sales_rule_id) === ruleId).map((x) => num(x.item_id)));
      const sets = new Set(
        ((setLinks ?? []) as { group_buy_item_set_id: number; sales_rule_id: number }[]).filter((x) => num(x.sales_rule_id) === ruleId).map((x) => num(x.group_buy_item_set_id)),
      );
      const all = ((gbRules ?? []) as { id: number }[]).some((x) => num(x.id) === ruleId);
      return paid.filter((l) => all || items.has(l.itemId) || sets.has(l.groupBuyItemSetId));
    };
    const lineAmount = (l: PricingLine) => l.price * l.qty - (lineDiscounts.get(l.uuid) ?? 0);
    const spread = (ls: PricingLine[], total: number) => {
      // 折扣依金額比例分攤到各明細（尾差給最後一筆）
      const base = ls.reduce((s, l) => s + lineAmount(l), 0);
      let left = total;
      ls.forEach((l, i) => {
        const d = i === ls.length - 1 ? left : Math.min(left, round((total * lineAmount(l)) / (base || 1)));
        left -= d;
        lineDiscounts.set(l.uuid, (lineDiscounts.get(l.uuid) ?? 0) + d);
      });
    };
    const ITEM_LEVEL = new Set(["MINIMUM_PIECE_MEET", "MINIMUM_PRICE_MEET_ITS", "ITEM_PRICE_MEET"]);
    // 同品項/商品類先套（priority 小者先），整張訂單類後套
    const ordered = [...rules].sort((a, b) => Number(ITEM_LEVEL.has(b.category)) - Number(ITEM_LEVEL.has(a.category)) || a.priority - b.priority || a.id - b.id);
    for (const r of ordered) {
      const ls = linesOfRule(r.id);
      if (!ls.length) continue;
      const pieces = ls.reduce((s, l) => s + l.qty, 0);
      const amount = ls.reduce((s, l) => s + lineAmount(l), 0);
      let d = 0;
      if (r.category === "MINIMUM_PIECE_MEET") {
        if (pieces >= r.minimum) d = discountOf(r.dollar_or_percentage, r.discount, amount);
      } else if (r.category === "MINIMUM_PRICE_MEET_ITS" || r.category === "ITEM_PRICE_MEET") {
        if (amount >= r.minimum) d = discountOf(r.dollar_or_percentage, r.discount, amount);
      } else if (r.category === "MINIMUM_PRICE_MEET") {
        const orderAmount = paid.reduce((s, l) => s + lineAmount(l), 0);
        if (orderAmount >= r.minimum) d = discountOf(r.dollar_or_percentage, r.discount, amount);
      }
      d = Math.min(d, amount);
      if (d > 0) {
        spread(ls, d);
        salesRules.push({ salesRuleId: r.id, title: r.title, discount: d, category: r.category });
      }
    }

    // 優惠卷
    for (const raw of couponCodes) {
      const code = String(raw ?? "").trim();
      if (!code) continue;
      const { data: cc } = await db
        .from("coupon_codes")
        .select("id, code, max_uses, used_count, is_active, customer_id, group_buy_coupons(id, group_buy_id, title, category, dollar_or_percentage, discount, minimum, available_quota, coupon_used_total, is_active, apply_to_all_group_buy, coupon_settings)")
        .eq("tenant_id", tenantId)
        .eq("code", code)
        .maybeSingle();
      const row = cc as Record<string, unknown> | null;
      const gc = (row?.group_buy_coupons ?? null) as Record<string, unknown> | null;
      if (!row || !gc || !row.is_active || !gc.is_active) continue;
      const amount = paid.reduce((s, l) => s + lineAmount(l), 0);
      const pieces = paid.reduce((s, l) => s + l.qty, 0);
      const kind = String(gc.dollar_or_percentage ?? "DOLLAR");
      const min = num(gc.minimum);
      let d = 0;
      switch (String(gc.category)) {
        case "MINIMUM_PIECE_MEET":
          if (pieces >= min) d = discountOf(kind, num(gc.discount), amount);
          break;
        case "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE":
          if (min > 0) d = Math.floor(amount / min) * round(num(gc.discount));
          break;
        case "MINIMUM_PRICE_MEET":
        default:
          if (amount >= min) d = discountOf(kind, num(gc.discount), amount);
      }
      const maxDiscount = num((gc.coupon_settings as Record<string, unknown> | null)?.maxDiscount, 0);
      if (maxDiscount > 0) d = Math.min(d, maxDiscount);
      d = Math.min(d, amount);
      if (d > 0) spread(paid, d);
      else couponNotes.push(`${code}：未達使用條件`);
      coupons.push({
        groupBuyCouponId: num(gc.id),
        couponCodeId: num(row.id),
        code: String(row.code),
        title: String(gc.title ?? ""),
        category: String(gc.category ?? ""),
        discount: d,
      });
    }
    return { salesRules, coupons, lineDiscounts, couponNotes };
  },
};

// ───────────────────────── provider 切換點 ─────────────────────────
// TODO(storefront)：shipping / marketing 推上正式版後，改成：
//   import { ... } from "@/lib/modules/shipping/shipping-fee";
//   import { ... } from "@/lib/modules/marketing/pricing-rules";
// 並在這裡包成 ShippingFeeProvider / PricingRulesProvider。
let shippingProvider: ShippingFeeProvider = fallbackShippingFee;
let rulesProvider: PricingRulesProvider = fallbackPricingRules;
export function setPricingProviders(p: { shipping?: ShippingFeeProvider; rules?: PricingRulesProvider }): void {
  if (p.shipping) shippingProvider = p.shipping;
  if (p.rules) rulesProvider = p.rules;
}

/** 伺服器端計價主流程 */
export async function priceCart(input: PricingInput, preloaded?: { rules?: FlatRateShippingRow[] }): Promise<PricingResult> {
  const lines = input.lines.filter((l) => l.qty > 0);
  const subtotal = lines.reduce((s, l) => s + (l.gift ? 0 : l.price * l.qty), 0);
  const totalPieces = lines.reduce((s, l) => s + l.qty, 0);
  const applied = await rulesProvider.apply({
    tenantId: input.tenantId,
    groupBuy: input.groupBuy,
    lines,
    couponCodes: input.couponCodes,
    customerId: input.customerId,
  });
  const ruleDiscount = applied.salesRules.reduce((s, r) => s + r.discount, 0);
  const couponDiscount = applied.coupons.reduce((s, c) => s + c.discount, 0);
  const totalDiscount = Math.min(subtotal, ruleDiscount + couponDiscount);
  const grandTotalWithoutShipping = Math.max(0, subtotal - totalDiscount);
  const rules = preloaded?.rules ?? (await loadGroupBuyShippingRules(input.tenantId, input.groupBuy.id));
  const shipping = await shippingProvider.quote({
    tenantId: input.tenantId,
    groupBuy: input.groupBuy,
    rules,
    flatRateShippingId: input.flatRateShippingId,
    lines,
    amount: grandTotalWithoutShipping,
    paymentMethod: input.paymentMethod,
    address: input.shippingAddress,
  });
  const taxRate = num(input.groupBuy.tax_rate);
  const tax = taxRate > 0 ? round((grandTotalWithoutShipping * taxRate) / 100) : 0;
  const grandTotal = grandTotalWithoutShipping + shipping.shippingAmount + shipping.codFee + tax;
  return {
    subtotal,
    lineDiscounts: applied.lineDiscounts,
    salesRules: applied.salesRules,
    coupons: applied.coupons,
    totalDiscount,
    couponTotalDiscount: couponDiscount,
    grandTotalWithoutShipping,
    shipping,
    tax,
    grandTotal,
    totalPieces,
    couponNotes: applied.couponNotes,
    errors: [],
  };
}
