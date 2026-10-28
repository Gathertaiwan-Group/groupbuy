// storefront 計價（伺服器端唯一可信的金額來源；購物袋顯示與建立訂單都呼叫這裡，絕不採用前端送來的金額）。
// orders 模組可 import（只讀依賴）：priceCart()、型別 PricingInput / PricingResult。
//
// 優惠：marketing 模組正式版（pricing-marketing.ts 包裝 marketing 的 pricing-loader + evaluatePricing）。
// 運費：shipping 模組正式版（lib/modules/shipping/shipping-fee.ts 的 calculateShippingFee，
//       資料由 shipping-data.ts 的 loadGroupBuyShipping／cartLineFromItem 載入）。
// fallbackPricingRules 保留作為對照／緊急切回用（setPricingProviders）。
import { getServiceClient } from "@/lib/supabase/server";
import type { Row } from "@/lib/db/mapping";
import { calculateShippingFee, type CartLine as ShipCartLine, type ShippingFeeResult } from "@/lib/modules/shipping/shipping-fee";
import { cartLineFromItem, loadGroupBuyShipping, type GroupBuyShippingData } from "@/lib/modules/shipping/shipping-data";
import { marketingPricingRules } from "./pricing-marketing";
import { PM_CODE_BY_BIT } from "./payment-codes";
import { applyPoints } from "./points";
import type { SfGroupBuy } from "./site";
import { couponCodeHasQuota, type CouponRejection } from "@/lib/modules/marketing/usage-release";
import { rewardPointsOf } from "./points";
import type { AutoGift, PickGift } from "./gift-logic";

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
  /** 會員點數折抵（points.ts）：想使用的點數與會員餘額；團購未開啟 ptEnabled 或非會員時不折抵 */
  points?: { requested: number; balance: number };
}

export interface AppliedSalesRule {
  salesRuleId: number;
  title: string;
  discount: number;
  category: string;
  /** 會員點數累積（dollarOrPercentage=POINT）可獲得的點數 */
  points?: number;
}

export interface AppliedCoupon {
  groupBuyCouponId: number;
  couponCodeId: number | null;
  code: string;
  title: string;
  category: string;
  discount: number;
  /** POINT／POINT_RANDOM 優惠卷可獲得的點數 */
  points?: number;
}

/** 贈品資格（marketing resolveGifts 的結果；購物袋明細與庫存由 cart-data 配置） */
export interface GiftEntitlements {
  auto: AutoGift[];
  pick: PickGift[];
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
  /** 選定配送方式無法成立的原因（shipping 計算結果；未指定配送方式時為空） */
  errors?: string[];
  /** shipping 模組的完整計算結果（運費明細 subs、貨運標籤等） */
  result?: ShippingFeeResult | null;
}

/** 運費計算所需的預載資料（同一次請求重複使用，避免重複查詢） */
export interface ShippingPreload {
  data: GroupBuyShippingData;
  /** items.id → items 列（cartLineFromItem 用） */
  itemRows: Map<number, Row>;
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
  /** 實際使用的會員點數（下單時扣點） */
  pointsUsed: number;
  /** 點數折抵金額（不含在 totalDiscount 內；grandTotalWithoutShipping／grandTotal 已扣除） */
  pointsDiscount: number;
  /** 本筆最多可使用的點數 */
  pointsMax: number;
  /** 本筆訂單完成付款後可獲得的回饋點數（ptEnabled 且會員；#117） */
  rewardPoints: number;
  /** 贈品資格（#116） */
  gifts: GiftEntitlements;
  totalPieces: number;
  /** 優惠卷未成立的原因（例如未達門檻） */
  couponNotes: string[];
  /** 購物袋輸入的優惠碼已失效（停用／刪除／不適用此團購／用滿…）：結帳時擋下（fix10） */
  couponRejection: CouponRejection | null;
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
    couponCodes?: string[];
    preload?: ShippingPreload;
  }): Promise<ShippingQuote> | ShippingQuote;
}

export interface PricingRulesProvider {
  apply(args: {
    tenantId: number;
    groupBuy: SfGroupBuy;
    lines: PricingLine[];
    couponCodes: string[];
    customerId: number | null;
    /** 收件郵遞區號（限定郵遞區號類優惠用） */
    postcode?: string;
  }): Promise<{
    salesRules: AppliedSalesRule[];
    coupons: AppliedCoupon[];
    lineDiscounts: Map<string, number>;
    couponNotes: string[];
    /** 購物袋輸入的優惠碼已失效（結帳時擋下） */
    couponRejection?: CouponRejection | null;
    /** 優惠條件／優惠卷達成免運 */
    freeShipping?: boolean;
    /** 限制類優惠（例如未達最低購買條件）不允許結帳時的原因 */
    blockers?: string[];
    /** 符合的贈品（自動贈品／自選贈品；購物袋與訂單明細由 cart-data／order-place 處理） */
    gifts?: GiftEntitlements;
  }>;
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

// ───────────────────────── 運費：shipping 模組正式版 ─────────────────────────

const ITEM_SHIPPING_COLUMNS =
  "id, title, price, item_type, item_set_id, item_settings, exclude_shipping_rule, shipping_price, internal_shipping_price, flat_rate_shipping_tag";

/** 載入運費計算所需資料（團購運費設定＋購物袋商品列）；一律以 tenantId 過濾 */
export async function loadShippingPreload(tenantId: number, groupBuyId: number, itemIds: number[]): Promise<ShippingPreload> {
  const ids = [...new Set(itemIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const db = getServiceClient();
  const [data, itemsRes] = await Promise.all([
    loadGroupBuyShipping(tenantId, groupBuyId, db),
    ids.length ? db.from("items").select(ITEM_SHIPPING_COLUMNS).eq("tenant_id", tenantId).in("id", ids) : Promise.resolve({ data: [], error: null }),
  ]);
  if (itemsRes.error) throw new Error(`讀取商品運費設定失敗：${itemsRes.error.message}`);
  const itemRows = new Map<number, Row>();
  for (const r of (itemsRes.data ?? []) as Row[]) itemRows.set(Number(r.id), r);
  return { data, itemRows };
}

/** 購物袋明細 → shipping 計算用 CartLine（商品運費欄位取自 items 列；單價取伺服器計價的 price） */
export function shippingCartLines(lines: PricingLine[], itemRows: Map<number, Row>): ShipCartLine[] {
  return lines
    .filter((l) => l.qty > 0)
    .map((l) => {
      const row: Row = itemRows.get(l.itemId) ?? { id: l.itemId, title: l.title, price: l.price, item_type: l.gift ? "GIFT" : "NORMAL", exclude_shipping_rule: !!l.excludeShippingRule };
      return cartLineFromItem(row, { quantity: l.qty, backOrder: l.backOrder, groupBuyItemSetId: l.groupBuyItemSetId || null, price: l.price });
    });
}

/** 各配送方式在目前購物袋＋收件地址下是否可用（未選付款方式；前台 gbfrss 的 disabled/disabledReason 用） */
export function shippingAvailability(
  preload: ShippingPreload,
  lines: PricingLine[],
  address: ShippingAddressInput,
  couponCodes: string[] = [],
): Map<number, { available: boolean; reason: string | null }> {
  const res = calculateShippingFee({
    groupBuy: preload.data.groupBuy,
    rules: preload.data.rules,
    itemSetRules: preload.data.itemSetRules,
    lines: shippingCartLines(lines, preload.itemRows),
    selectedRuleId: null,
    address: { country: address.country || "TW", postcode: address.postcode ?? "" },
    paymentMethod: null,
    couponCodes,
  });
  const out = new Map<number, { available: boolean; reason: string | null }>();
  for (const e of [...res.availableRules, ...res.unavailablePaymentRules]) out.set(e.flatRateShippingId, { available: true, reason: null });
  for (const e of res.unavailableRules) out.set(e.flatRateShippingId, { available: false, reason: e.disabledReason });
  return out;
}

export const shippingModuleFee: ShippingFeeProvider = {
  async quote({ tenantId, groupBuy, flatRateShippingId, lines, amount, paymentMethod, address, couponCodes, preload }) {
    const oversea = !!address.country && address.country !== "TW";
    const pre = preload ?? (await loadShippingPreload(tenantId, groupBuy.id, lines.map((l) => l.itemId)));
    const shipLines = shippingCartLines(lines, pre.itemRows);
    if (shipLines.length === 0) {
      return { flatRateShippingId, shippingAmount: 0, codFee: 0, amountToFreeShipping: null, freeShippingLabel: "免運", island: false, oversea, errors: [], result: null };
    }
    const gross = lines.reduce((s, l) => s + (l.gift ? 0 : l.price * l.qty), 0);
    const res = calculateShippingFee({
      groupBuy: pre.data.groupBuy,
      rules: pre.data.rules,
      itemSetRules: pre.data.itemSetRules,
      lines: shipLines,
      selectedRuleId: flatRateShippingId,
      address: { country: address.country || "TW", postcode: address.postcode ?? "" },
      paymentMethod: PM_CODE_BY_BIT[paymentMethod] ?? null,
      couponCodes: couponCodes ?? [],
      discountAmount: Math.max(0, gross - amount),
    });
    return {
      flatRateShippingId: res.rule?.flatRateShippingId ?? flatRateShippingId,
      shippingAmount: res.shippingAmount,
      codFee: res.codFee,
      amountToFreeShipping: res.amountToFreeShipping,
      freeShippingLabel: res.freeShippingLabel,
      island: res.island,
      oversea: res.oversea,
      errors: flatRateShippingId != null ? res.errors : [],
      result: res,
    };
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
    let couponRejection: CouponRejection | null = null;
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
      if (!row || !gc) {
        couponRejection ??= { code, kind: "INVALID", reason: "不存在或已被刪除" };
        continue;
      }
      if (!row.is_active || !gc.is_active) {
        couponRejection ??= { code, kind: "INVALID", reason: "已停用" };
        continue;
      }
      if (!couponCodeHasQuota({ usedCount: num(row.used_count), maxUses: num(row.max_uses, -1), availableQuota: num(gc.available_quota, -1) })) {
        couponNotes.push(`${code}：已達使用上限`);
        couponRejection ??= { code, kind: "QUOTA", reason: "已達使用上限" };
        continue;
      }
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
    return { salesRules, coupons, lineDiscounts, couponNotes, couponRejection };
  },
};

// ───────────────────────── provider 切換點 ─────────────────────────
let shippingProvider: ShippingFeeProvider = shippingModuleFee;
let rulesProvider: PricingRulesProvider = marketingPricingRules;
/** 團購是否開啟會員點數功能（group_buy_settings.ptEnabled） */
export function pointsEnabled(gb: SfGroupBuy): boolean {
  const v = gb.group_buy_settings?.ptEnabled;
  return v === true || v === "true" || v === 1 || v === "1";
}

export function setPricingProviders(p: { shipping?: ShippingFeeProvider; rules?: PricingRulesProvider }): void {
  if (p.shipping) shippingProvider = p.shipping;
  if (p.rules) rulesProvider = p.rules;
}

/** 伺服器端計價主流程 */
export async function priceCart(input: PricingInput, preloaded?: { rules?: FlatRateShippingRow[]; shipping?: ShippingPreload }): Promise<PricingResult> {
  const lines = input.lines.filter((l) => l.qty > 0);
  const subtotal = lines.reduce((s, l) => s + (l.gift ? 0 : l.price * l.qty), 0);
  const totalPieces = lines.reduce((s, l) => s + l.qty, 0);
  const applied = await rulesProvider.apply({
    tenantId: input.tenantId,
    groupBuy: input.groupBuy,
    lines,
    couponCodes: input.couponCodes,
    customerId: input.customerId,
    postcode: input.shippingAddress.postcode,
  });
  const ruleDiscount = applied.salesRules.reduce((s, r) => s + r.discount, 0);
  const couponDiscount = applied.coupons.reduce((s, c) => s + c.discount, 0);
  const totalDiscount = Math.min(subtotal, ruleDiscount + couponDiscount);
  // 優惠引擎（marketing）先算；運費門檻以點數折抵「前」的商品金額判斷
  const amountAfterDiscount = Math.max(0, subtotal - totalDiscount);
  // 會員點數最後折抵（只折商品金額，不折運費／手續費）
  const pts = applyPoints({
    enabled: pointsEnabled(input.groupBuy),
    isMember: input.customerId != null,
    requested: input.points?.requested ?? 0,
    balance: input.points?.balance ?? 0,
    amountAfterDiscount,
  });
  const grandTotalWithoutShipping = amountAfterDiscount - pts.discount;
  const rules = preloaded?.rules ?? [];
  const quoted = await shippingProvider.quote({
    tenantId: input.tenantId,
    groupBuy: input.groupBuy,
    rules,
    flatRateShippingId: input.flatRateShippingId,
    lines,
    amount: amountAfterDiscount,
    paymentMethod: input.paymentMethod,
    address: input.shippingAddress,
    couponCodes: input.couponCodes,
    preload: preloaded?.shipping,
  });
  const shipping: ShippingQuote = applied.freeShipping ? { ...quoted, shippingAmount: 0, amountToFreeShipping: null } : quoted;
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
    pointsUsed: pts.points,
    pointsDiscount: pts.discount,
    pointsMax: pts.max,
    rewardPoints: rewardPointsOf({ enabled: pointsEnabled(input.groupBuy), isMember: input.customerId != null, rules: applied.salesRules, coupons: applied.coupons }),
    gifts: applied.gifts ?? { auto: [], pick: [] },
    totalPieces,
    couponNotes: [...applied.couponNotes],
    couponRejection: applied.couponRejection ?? null,
    errors: [...(applied.blockers ?? []), ...(shipping.errors ?? [])],
  };
}
