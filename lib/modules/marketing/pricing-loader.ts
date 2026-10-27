// 從 DB 組出 pricing-rules 的輸入（優惠條件、購物車明細的綁定/標籤、折扣碼、贈品候選）。
// storefront（結帳）與 orders（重新計算優惠）只讀 import；所有查詢都以 tenantId 過濾。
// 用法（storefront 結帳試算）：
//   const db = getServiceClient();
//   const { rules, couponOnlySalesRuleIds } = await loadSalesRulesForGroupBuy(db, tenantId, groupBuyId);
//   const lines = await loadCartLines(db, tenantId, groupBuyId, cart.map((c) => ({ key: c.id, itemId: c.itemId, quantity: c.total, backOrder: c.backOrder })));
//   const coupon = code ? await findCouponByCode(db, tenantId, groupBuyId, code) : null;
//   const result = evaluatePricing({ lines, salesRules: rules, couponOnlySalesRuleIds, coupon, customer, postcode, groupBuyId });
//   const gifts = resolveGifts(result.gifts, await loadGiftCandidates(db, tenantId, groupBuyId, result.gifts.map((g) => g.giftTag)));
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession } from "@/lib/core/http/types";
import type { PricingCartLine, PricingCoupon, PricingInput, PricingSalesRule, SalesRuleSettings } from "./pricing-rules";

type Db = ReturnType<typeof getServiceClient>;
type Row = Record<string, unknown>;

const num = (v: unknown, d = 0): number => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

async function q<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new Error(`[pricing-loader] ${what}：${error.message}`);
  return (data ?? []) as T[];
}

/** sales_rules 資料列 → 引擎規則 */
export function toPricingRule(row: Row, royaltyProgramIds: number[] = []): PricingSalesRule {
  return {
    salesRuleId: Number(row.id),
    title: String(row.title ?? ""),
    category: String(row.category ?? ""),
    dollarOrPercentage: String(row.dollar_or_percentage ?? "DOLLAR"),
    discount: num(row.discount),
    minimum: num(row.minimum),
    maxApplyTimes: num(row.max_apply_times, -1),
    availableQuota: row.available_quota == null ? null : num(row.available_quota),
    usedQuota: num(row.used_quota),
    priority: num(row.priority, 1),
    tag: (row.tag as string | null) ?? null,
    excludeTag: (row.exclude_tag as string | null) ?? null,
    mainItemType: (row.main_item_type as string | null) ?? "ANY",
    applyToGroupBuy: !!row.apply_to_group_buy,
    hidden: !!row.hidden,
    combinable: !!row.combinable,
    active: row.is_active !== false,
    dateStart: (row.date_start as string | null) ?? null,
    dateEnd: (row.date_end as string | null) ?? null,
    settings: (row.sales_rule_settings as SalesRuleSettings | null) ?? {},
    royaltyProgramIds,
  };
}

/** 讀團購的優惠條件（含已停用者由引擎判斷）、會員方案限定、需搭配折扣碼的規則 */
export async function loadSalesRulesForGroupBuy(
  db: Db,
  tenantId: number,
  groupBuyId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<{ rules: PricingSalesRule[]; couponOnlySalesRuleIds: number[] }> {
  let rq = db.from("sales_rules").select("*").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  if (!opts.includeInactive) rq = rq.eq("is_active", true);
  const rows = await q<Row>(rq.order("priority").order("id"), "讀取優惠條件");
  const ids = rows.map((r) => Number(r.id));
  const rp = ids.length
    ? await q<{ sales_rule_id: number; royalty_program_id: number }>(
        db.from("sales_rule_royalty_programs").select("sales_rule_id, royalty_program_id").eq("tenant_id", tenantId).in("sales_rule_id", ids),
        "讀取會員方案限定",
      )
    : [];
  const coupons = ids.length
    ? await q<{ sales_rule_id: number }>(
        db.from("group_buy_coupons").select("sales_rule_id").eq("tenant_id", tenantId).eq("category", "SALES_RULE").eq("is_active", true).in("sales_rule_id", ids),
        "讀取綁定優惠條件的優惠卷",
      )
    : [];
  const rules = rows.map((r) =>
    toPricingRule(
      r,
      rp.filter((x) => Number(x.sales_rule_id) === Number(r.id)).map((x) => Number(x.royalty_program_id)),
    ),
  );
  const couponOnly = [...new Set(coupons.map((c) => Number(c.sales_rule_id)).filter((x) => Number.isSafeInteger(x)))];
  return { rules, couponOnlySalesRuleIds: couponOnly };
}

export interface CartItemInput {
  key: string | number;
  itemId: number;
  quantity: number;
  backOrder?: boolean | null;
  /** 已知時可帶（購物車明細有 group_buy_item_set_id） */
  groupBuyItemSetId?: number | null;
  /** 覆寫單價（後台改價時用）；不帶用 items.price */
  price?: number | null;
}

/** 依購物車商品組出引擎需要的明細（單價、原價、商品種類、綁定的優惠條件與優惠標籤） */
export async function loadCartLines(db: Db, tenantId: number, groupBuyId: number, items: CartItemInput[]): Promise<PricingCartLine[]> {
  const itemIds = [...new Set(items.map((i) => i.itemId))];
  if (itemIds.length === 0) return [];
  const rows = await q<Row>(
    db.from("items").select("id, item_set_id, title, short_name, price, retail_price, item_type").eq("tenant_id", tenantId).in("id", itemIds),
    "讀取商品",
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const setIds = [...new Set(rows.map((r) => Number(r.item_set_id)).filter((x) => Number.isSafeInteger(x)))];
  const gbis = setIds.length
    ? await q<{ id: number; item_set_id: number }>(
        db.from("group_buy_item_sets").select("id, item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).in("item_set_id", setIds),
        "讀取團購品項",
      )
    : [];
  const gbisBySet = new Map(gbis.map((g) => [Number(g.item_set_id), Number(g.id)]));
  const gbisIds = [...new Set([...gbis.map((g) => Number(g.id)), ...items.map((i) => Number(i.groupBuyItemSetId)).filter((x) => Number.isSafeInteger(x) && x > 0)])];
  const [itemRules, itemTags, setRules, setTags] = await Promise.all([
    q<{ item_id: number; sales_rule_id: number }>(db.from("item_sales_rules").select("item_id, sales_rule_id").eq("tenant_id", tenantId).in("item_id", itemIds), "讀取商品綁定"),
    q<{ item_id: number; tag: string }>(db.from("item_sales_rule_tags").select("item_id, tag").eq("tenant_id", tenantId).in("item_id", itemIds), "讀取商品優惠標籤"),
    gbisIds.length
      ? q<{ group_buy_item_set_id: number; sales_rule_id: number }>(
          db.from("group_buy_item_set_sales_rules").select("group_buy_item_set_id, sales_rule_id").eq("tenant_id", tenantId).in("group_buy_item_set_id", gbisIds),
          "讀取品項綁定",
        )
      : Promise.resolve([]),
    gbisIds.length
      ? q<{ group_buy_item_set_id: number; tag: string }>(
          db.from("group_buy_item_set_sales_rule_tags").select("group_buy_item_set_id, tag").eq("tenant_id", tenantId).in("group_buy_item_set_id", gbisIds),
          "讀取品項優惠標籤",
        )
      : Promise.resolve([]),
  ]);
  const out: PricingCartLine[] = [];
  for (const it of items) {
    const r = byId.get(it.itemId);
    if (!r) continue;
    const gbisId = it.groupBuyItemSetId ?? gbisBySet.get(Number(r.item_set_id)) ?? null;
    const ruleIds = [
      ...itemRules.filter((x) => Number(x.item_id) === it.itemId).map((x) => Number(x.sales_rule_id)),
      ...(gbisId ? setRules.filter((x) => Number(x.group_buy_item_set_id) === gbisId).map((x) => Number(x.sales_rule_id)) : []),
    ];
    const tags = [
      ...itemTags.filter((x) => Number(x.item_id) === it.itemId).map((x) => x.tag),
      ...(gbisId ? setTags.filter((x) => Number(x.group_buy_item_set_id) === gbisId).map((x) => x.tag) : []),
    ];
    out.push({
      key: it.key,
      itemId: it.itemId,
      groupBuyItemSetId: gbisId,
      title: String(r.title ?? r.short_name ?? ""),
      price: it.price ?? num(r.price),
      retailPrice: num(r.retail_price) || null,
      quantity: it.quantity,
      backOrder: !!it.backOrder,
      itemType: (r.item_type as string | null) ?? "NORMAL",
      salesRuleIds: [...new Set(ruleIds)],
      tags: [...new Set(tags)],
    });
  }
  return out;
}

/** 依消費者輸入的折扣碼找優惠卷（同租戶；跨團判斷交給 validateCoupon） */
export async function findCouponByCode(db: Db, tenantId: number, groupBuyId: number, code: string): Promise<PricingCoupon | null> {
  const c = String(code ?? "").trim();
  if (!c) return null;
  const codes = await q<Row>(
    db.from("coupon_codes").select("id, group_buy_coupon_id, code, max_uses, used_count, is_active, customer_id").eq("tenant_id", tenantId).ilike("code", c.replace(/[%_\\]/g, "")).limit(1),
    "讀取折扣碼",
  );
  const cc = codes[0];
  if (!cc) return null;
  const gbcs = await q<Row>(db.from("group_buy_coupons").select("*").eq("tenant_id", tenantId).eq("id", Number(cc.group_buy_coupon_id)).limit(1), "讀取團購優惠卷");
  const g = gbcs[0];
  if (!g) return null;
  const settings = (g.coupon_settings ?? {}) as Record<string, unknown>;
  const rp = Array.isArray(settings.royaltyProgramId) ? (settings.royaltyProgramId as unknown[]).map(Number).filter(Number.isSafeInteger) : [];
  void groupBuyId;
  return {
    code: String(cc.code),
    groupBuyCouponId: Number(g.id),
    couponCodeId: Number(cc.id),
    title: String(g.title ?? ""),
    category: String(g.category),
    dollarOrPercentage: String(g.dollar_or_percentage ?? "DOLLAR"),
    discount: num(g.discount),
    minimum: num(g.minimum),
    maxDiscount: num(settings.maxDiscount, 0) || null,
    combinable: !!g.combinable,
    salesRuleId: g.sales_rule_id == null ? null : Number(g.sales_rule_id),
    customerOnly: !!settings.customerOnly,
    royaltyProgramIds: rp,
    active: g.is_active !== false && cc.is_active !== false,
    availableQuota: g.available_quota == null ? -1 : num(g.available_quota, -1),
    usedCount: num(cc.used_count),
    maxUses: cc.max_uses == null ? -1 : num(cc.max_uses, -1),
    applyToAllGroupBuy: !!g.apply_to_all_group_buy,
    groupBuyId: g.group_buy_id == null ? null : Number(g.group_buy_id),
  };
}

/** 贈品候選：團購內帶指定優惠標籤（商品或所屬品項）的商品；優先取 item_type=GIFT 者 */
export async function loadGiftCandidates(
  db: Db,
  tenantId: number,
  groupBuyId: number,
  tags: (string | null)[],
): Promise<Record<string, { itemId: number; title: string }[]>> {
  const want = [...new Set(tags.filter((t): t is string => !!t))];
  const out: Record<string, { itemId: number; title: string }[]> = {};
  if (want.length === 0) return out;
  const gbis = await q<{ id: number; item_set_id: number }>(
    db.from("group_buy_item_sets").select("id, item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId),
    "讀取團購品項",
  );
  const setIds = gbis.map((g) => Number(g.item_set_id));
  if (setIds.length === 0) return out;
  const items = await q<Row>(
    db.from("items").select("id, item_set_id, title, item_type, offline").eq("tenant_id", tenantId).in("item_set_id", setIds),
    "讀取商品",
  );
  const itemIds = items.map((i) => Number(i.id));
  const [itemTags, setTags] = await Promise.all([
    itemIds.length ? q<{ item_id: number; tag: string }>(db.from("item_sales_rule_tags").select("item_id, tag").eq("tenant_id", tenantId).in("item_id", itemIds).in("tag", want), "讀取商品優惠標籤") : Promise.resolve([]),
    q<{ group_buy_item_set_id: number; tag: string }>(
      db.from("group_buy_item_set_sales_rule_tags").select("group_buy_item_set_id, tag").eq("tenant_id", tenantId).in("group_buy_item_set_id", gbis.map((g) => Number(g.id))).in("tag", want),
      "讀取品項優惠標籤",
    ),
  ]);
  const setOfGbis = new Map(gbis.map((g) => [Number(g.id), Number(g.item_set_id)]));
  for (const t of want) {
    const viaItem = new Set(itemTags.filter((x) => x.tag === t).map((x) => Number(x.item_id)));
    const viaSet = new Set(setTags.filter((x) => x.tag === t).map((x) => setOfGbis.get(Number(x.group_buy_item_set_id))));
    const cands = items.filter((i) => !i.offline && (viaItem.has(Number(i.id)) || viaSet.has(Number(i.item_set_id))));
    cands.sort((a, b) => Number(String(b.item_type) === "GIFT") - Number(String(a.item_type) === "GIFT") || Number(a.id) - Number(b.id));
    out[t] = cands.map((i) => ({ itemId: Number(i.id), title: String(i.title ?? "") }));
  }
  return out;
}

/** 結帳成功後記錄折扣碼使用（coupon_codes.used_count +1、date_used；group_buy_coupons 統計同步） */
export async function recordCouponUse(db: Db, tenantId: number, couponCodeId: number): Promise<void> {
  const rows = await q<Row>(db.from("coupon_codes").select("id, used_count, group_buy_coupon_id").eq("tenant_id", tenantId).eq("id", couponCodeId).limit(1), "讀取折扣碼");
  const r = rows[0];
  if (!r) return;
  const { error } = await db
    .from("coupon_codes")
    .update({ used_count: num(r.used_count) + 1, date_used: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", couponCodeId);
  if (error) throw new Error(`[pricing-loader] 更新折扣碼使用次數：${error.message}`);
  await syncCouponTotals(db, tenantId, Number(r.group_buy_coupon_id));
}

/**
 * 依 coupon_codes 重算 group_buy_coupons.coupon_used_total / coupon_available_total。
 * 公式只存在 DB（migration 8002 marketing_sync_coupon_totals：已使用＝used_count > 0 的折扣碼數）；
 * 下單／POS 結帳／作廢／取消／還原／後台使用與移除優惠卷都在各自交易內呼叫同一支函式。
 */
export async function syncCouponTotals(db: Db, tenantId: number, groupBuyCouponId: number): Promise<{ total: number; used: number; available: number }> {
  const { data, error } = await db.rpc("marketing_sync_coupon_totals", { p_tenant_id: tenantId, p_group_buy_coupon_id: groupBuyCouponId });
  if (error) throw new Error(`[pricing-loader] 更新優惠卷統計：${error.message}`);
  const r = (data ?? {}) as { total?: number; used?: number; available?: number };
  return { total: num(r.total), used: num(r.used), available: num(r.available) };
}

/**
 * orders 模組「重新計算優惠」用（lib/modules/orders/pricing.ts 以 require 選擇性載入）：由訂單組出 evaluatePricing 的輸入。
 * - 明細：order_items（排除贈品、組合子商品、已取消），key＝order_items.id，單價用訂單上的 price（後台可能改過價）
 * - 優惠條件：訂單所屬團購目前啟用中的優惠；期限／剩餘數量以「下單時間」判斷（now＝訂單建立時間）
 * - 優惠卷：sales_order_coupons 的折扣碼；已使用次數扣掉本單（避免把自己算成已用完）
 * - 會員方案：customers.royalty_program_id；郵遞區號：shipping_postcode
 * - 隨機類（POINT_RANDOM、GIFT_LOTTERY）固定 random()=0，重算結果穩定
 * 找不到訂單或訂單沒有團購時回 null。
 */
export async function loadPricingInputForOrder(session: AdminSession, salesOrderId: number): Promise<PricingInput | null> {
  const db = getServiceClient();
  const tenantId = session.tenantId;
  const { data: order, error } = await db
    .from("sales_orders")
    .select("id, group_buy_id, customer_id, shipping_postcode, created_at")
    .eq("tenant_id", tenantId)
    .eq("id", salesOrderId)
    .maybeSingle();
  if (error) throw new Error(`[pricing-loader] 讀取訂單：${error.message}`);
  const o = order as { id: number; group_buy_id: number | null; customer_id: number | null; shipping_postcode: string | null; created_at: string } | null;
  if (!o || !o.group_buy_id) return null;
  const groupBuyId = Number(o.group_buy_id);
  const items = await q<Row>(
    db
      .from("order_items")
      .select("id, item_id, group_buy_item_set_id, price, total, back_order, gift, bundle_child, state")
      .eq("tenant_id", tenantId)
      .eq("sales_order_id", salesOrderId)
      .order("seq"),
    "讀取訂單商品",
  );
  const cart: CartItemInput[] = items
    .filter((r) => r.item_id && !r.gift && !r.bundle_child && r.state !== "CANCELLED" && num(r.total) > 0)
    .map((r) => ({
      key: Number(r.id),
      itemId: Number(r.item_id),
      quantity: num(r.total),
      backOrder: !!r.back_order,
      groupBuyItemSetId: r.group_buy_item_set_id ? Number(r.group_buy_item_set_id) : null,
      price: num(r.price),
    }));
  const [lines, rules, couponRows, customerRow] = await Promise.all([
    loadCartLines(db, tenantId, groupBuyId, cart),
    loadSalesRulesForGroupBuy(db, tenantId, groupBuyId),
    q<{ coupon: string | null }>(db.from("sales_order_coupons").select("coupon").eq("tenant_id", tenantId).eq("sales_order_id", salesOrderId).limit(1), "讀取訂單優惠卷"),
    o.customer_id
      ? q<{ id: number; royalty_program_id: number | null }>(db.from("customers").select("id, royalty_program_id").eq("tenant_id", tenantId).eq("id", o.customer_id).limit(1), "讀取會員")
      : Promise.resolve([] as { id: number; royalty_program_id: number | null }[]),
  ]);
  let coupon: PricingCoupon | null = null;
  const code = couponRows[0]?.coupon;
  if (code) {
    coupon = await findCouponByCode(db, tenantId, groupBuyId, code);
    if (coupon && coupon.usedCount) coupon = { ...coupon, usedCount: Math.max(0, num(coupon.usedCount) - 1) };
  }
  const c = customerRow[0];
  return {
    lines,
    salesRules: rules.rules,
    couponOnlySalesRuleIds: rules.couponOnlySalesRuleIds,
    coupon,
    customer: c ? { customerId: Number(c.id), royaltyProgramId: c.royalty_program_id == null ? null : Number(c.royalty_program_id) } : null,
    postcode: o.shipping_postcode,
    groupBuyId,
    now: o.created_at,
    random: () => 0,
  };
}
