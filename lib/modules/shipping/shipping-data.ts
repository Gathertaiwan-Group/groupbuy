// 運費計算的資料載入（I/O）。擁有者：shipping 模組；storefront 結帳與後台訂單重算共用。
// 純計算在 ./shipping-fee.ts；介面說明見 docs/modules/shipping.md。
import { getServiceClient } from "@/lib/supabase/server";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { flatRateShipping } from "@/lib/db/entities/flatRateShipping";
import { getAccountSettings } from "@/lib/modules/core/system-settings";
import type { CartLine, FeeRule, GroupBuyShippingContext, ItemSetRuleBinding } from "./shipping-fee";

type Db = ReturnType<typeof getServiceClient>;

export interface GroupBuyShippingData {
  /** 團購層級設定（不寄送外島／海外、貨到付款不可含預購） */
  groupBuy: GroupBuyShippingContext;
  /** 團購的表單運費（配送方式），依綁定 seq、規則 seq、id 排序 */
  rules: FeeRule[];
  /** 品項運費（含原站 item_set_id 方便對照） */
  itemSetRules: (ItemSetRuleBinding & { itemSetId: number | null })[];
  /** item_sets.id → group_buy_item_sets.id（購物車商品 items.item_set_id 轉成計算用的 groupBuyItemSetId） */
  groupBuyItemSetIdByItemSetId: Map<number, number>;
  /** 團購「無有效運費規則時敘述」（groupBuySettings.noFlatRateShipping） */
  noFlatRateShipping: string;
  /** 團購貨運標籤（group_buys.shipping_tag；規則未設定貨運標籤時用） */
  shippingTag: string;
}

/** 運費規則 DB 列 → 計算用 FeeRule（原站 JSON 鍵） */
export function feeRuleFromRow(row: Row): FeeRule {
  return rowToApi(flatRateShipping, row) as unknown as FeeRule;
}

/** 讀取團購的運費設定（一律以 tenantId 過濾） */
export async function loadGroupBuyShipping(tenantId: number, groupBuyId: number, db: Db = getServiceClient()): Promise<GroupBuyShippingData> {
  const [gbRes, bindRes, itemBindRes, gbisRes, account] = await Promise.all([
    db.from("group_buys").select("id, island_disabled, oversea_disabled, shipping_tag, group_buy_settings").eq("tenant_id", tenantId).eq("id", groupBuyId).maybeSingle(),
    db.from("group_buy_flat_rate_shippings").select("id, flat_rate_shipping_id, seq").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId),
    db.from("group_buy_item_set_flat_rate_shippings").select("id, group_buy_item_set_id, flat_rate_shipping_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId),
    db.from("group_buy_item_sets").select("id, item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId),
    getAccountSettings(tenantId),
  ]);
  for (const r of [gbRes, bindRes, itemBindRes, gbisRes]) if (r.error) throw new Error(`[shipping] 讀取運費設定失敗：${r.error.message}`);
  const gb = (gbRes.data ?? null) as Row | null;
  const binds = (bindRes.data ?? []) as Row[];
  const itemBinds = (itemBindRes.data ?? []) as Row[];
  const gbis = (gbisRes.data ?? []) as Row[];

  const ruleIds = [...new Set([...binds, ...itemBinds].map((b) => Number(b.flat_rate_shipping_id)))];
  const ruleById = new Map<number, FeeRule>();
  if (ruleIds.length) {
    const { data, error } = await db.from("flat_rate_shippings").select("*").eq("tenant_id", tenantId).in("id", ruleIds);
    if (error) throw new Error(`[shipping] 讀取運費規則失敗：${error.message}`);
    for (const r of (data ?? []) as Row[]) ruleById.set(Number(r.id), feeRuleFromRow(r));
  }

  const bindSeq = new Map<number, number>();
  for (const b of binds) bindSeq.set(Number(b.flat_rate_shipping_id), Number(b.seq ?? 0));
  const rules = [...bindSeq.keys()]
    .map((id) => ruleById.get(id))
    .filter((r): r is FeeRule => !!r)
    .sort(
      (a, b) =>
        (bindSeq.get(a.flatRateShippingId) ?? 0) - (bindSeq.get(b.flatRateShippingId) ?? 0) ||
        Number(a.seq ?? 0) - Number(b.seq ?? 0) ||
        a.flatRateShippingId - b.flatRateShippingId,
    );

  const itemSetIdByGbis = new Map<number, number>();
  const groupBuyItemSetIdByItemSetId = new Map<number, number>();
  for (const r of gbis) {
    itemSetIdByGbis.set(Number(r.id), Number(r.item_set_id));
    groupBuyItemSetIdByItemSetId.set(Number(r.item_set_id), Number(r.id));
  }
  const itemSetRules = itemBinds
    .map((b) => {
      const rule = ruleById.get(Number(b.flat_rate_shipping_id));
      if (!rule) return null;
      const gbisId = Number(b.group_buy_item_set_id);
      return { groupBuyItemSetId: gbisId, itemSetId: itemSetIdByGbis.get(gbisId) ?? null, rule };
    })
    .filter((x): x is ItemSetRuleBinding & { itemSetId: number | null } => !!x);

  const settings = (gb?.group_buy_settings ?? {}) as Row;
  return {
    groupBuy: {
      islandDisabled: !!gb?.island_disabled,
      overseaDisabled: !!gb?.oversea_disabled,
      backOrderCodDisabled: settings.backOrderCodDisabled === true || settings.backOrderCodDisabled === "true",
      itemInternalShipping: account.itemInternalShippingPrice,
    },
    rules,
    itemSetRules,
    groupBuyItemSetIdByItemSetId,
    noFlatRateShipping: String(settings.noFlatRateShipping ?? ""),
    shippingTag: String(gb?.shipping_tag ?? ""),
  };
}

/** 不出貨的商品種類（運費、貨到付款費、差額、折扣、折價券、點數）：不列入運費計算（推導） */
const NON_SHIPPING_ITEM_TYPES = new Set(["SHIPPING", "COD", "DIFF", "DISCOUNT", "COUPON", "POINT"]);

function optNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface CartLineOptions {
  quantity: number;
  /** 預購（訂單商品 back_order） */
  backOrder?: boolean;
  /** 未提供時用 groupBuyItemSetIdByItemSetId 由 items.item_set_id 轉換 */
  groupBuyItemSetId?: number | null;
  groupBuyItemSetIdByItemSetId?: Map<number, number>;
  /** 單價（預設 items.price；價格標籤/優惠後價格由呼叫端傳入） */
  price?: number;
  /** 小計（預設 price × quantity） */
  amount?: number;
  /** 組合商品的子項（不計件數與金額） */
  bundleChild?: boolean;
}

/** items DB 列（snake_case）→ 計算用 CartLine */
export function cartLineFromItem(item: Row, opts: CartLineOptions): CartLine {
  const s = (item.item_settings ?? {}) as Row;
  const itemType = String(item.item_type ?? "NORMAL");
  const itemSetId = optNumber(item.item_set_id);
  const gbisId =
    opts.groupBuyItemSetId !== undefined
      ? opts.groupBuyItemSetId
      : itemSetId !== null && opts.groupBuyItemSetIdByItemSetId
        ? opts.groupBuyItemSetIdByItemSetId.get(itemSetId) ?? null
        : null;
  const price = opts.price ?? optNumber(item.price) ?? 0;
  return {
    groupBuyItemSetId: gbisId,
    itemId: optNumber(item.id),
    title: String(item.title ?? ""),
    price,
    quantity: opts.quantity,
    amount: opts.amount ?? null,
    backOrder: !!opts.backOrder,
    excludeShippingRule: !!item.exclude_shipping_rule || NON_SHIPPING_ITEM_TYPES.has(itemType),
    shippingPrice: optNumber(item.shipping_price),
    internalShippingPrice: optNumber(item.internal_shipping_price),
    weight: optNumber(s.flatRateShippingWeight) ?? optNumber(s.weight),
    flatRateShippingTag: String(item.flat_rate_shipping_tag ?? "").trim() || null,
    restrictedShippingTag: String(s.restrictedShippingTag ?? "").trim() || null,
    gift: itemType === "GIFT",
    bundleChild: !!opts.bundleChild,
  };
}
