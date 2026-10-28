// 團購商品目錄：讀取團購的品項（group_buy_item_sets × item_sets）與商品（items），計算可售數量。
// 一律以團購的 tenant_id 過濾。下單頁顯示、購物袋、結帳計價都從這裡取「伺服器端的真實價格與庫存」。
import { getServiceClient } from "@/lib/supabase/server";
import { runDueSchedulersSafe } from "@/lib/modules/items/scheduler";

export interface CatalogItemSet {
  groupBuyItemSetId: number;
  itemSetId: number;
  seq: number;
  style: string;
  itemSetTopStyle: string;
  css: string | null;
  cssTitle: string | null;
  cssNormalSelect: string | null;
  cssBackorderSelect: string | null;
  combinable: boolean;
  optionOfflineWhenSoldOut: boolean;
  title: string;
  descr: string | null;
  tabs: { n: number; title: string; descr: string }[];
  itemSetSettings: Record<string, unknown>;
  image: string | null;
}

export interface CatalogItem {
  itemId: number;
  itemSetId: number;
  groupBuyItemSetId: number;
  parentItemId: number | null;
  shareStock: boolean;
  seq: number;
  uid: string | null;
  title: string;
  shortName: string | null;
  shortNameDisplay: string | null;
  tag: string | null;
  price: number;
  retailPrice: number | null;
  cprice: number;
  maxOrderQuota: number;
  /** 庫存擁有者（共用庫存時為主商品） */
  stockOwnerId: number;
  stockAvailable: number;
  stockBackOrderAvailable: number;
  /** min(最大下單量, 可售現貨+可售預購)；≤0 顯示缺貨 */
  calculatedMaxOrderQuota: number;
  offline: boolean;
  optionOfflineWhenSoldOut: boolean;
  itemType: string;
  image: string | null;
  imagePopup: string | null;
  tabs: { n: number; title: string; descr: string }[];
  itemSettings: Record<string, unknown>;
  theme: Record<string, unknown>;
  shippingTag: string;
  flatRateShippingTag: string;
  excludeShippingRule: boolean;
  shippingPrice: number | null;
  commissionRate: number;
  commissionDollar: number;
  attributeNote: boolean;
  attributeNoteDefault: string | null;
}

export interface Catalog {
  itemSets: CatalogItemSet[];
  items: CatalogItem[];
  byId: Map<number, CatalogItem>;
  /** item_sets.id → 本團購的 group_buy_item_sets.id */
  gbisByItemSet: Map<number, number>;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function tabsOf(r: Record<string, unknown>): { n: number; title: string; descr: string }[] {
  const out: { n: number; title: string; descr: string }[] = [];
  for (const n of [1, 2, 3]) {
    const t = r[`tab${n}_title`];
    if (typeof t === "string" && t.trim()) out.push({ n, title: t, descr: String(r[`tab${n}_descr`] ?? "") });
  }
  return out;
}

const ITEM_COLUMNS =
  "id, item_set_id, parent_item_id, share_stock, seq, uid, title, short_name, short_name_display, tag, price, retail_price, cprice, stock_available, stock_back_order_available, max_order_quota, offline, option_offline_when_sold_out, item_type, image, image_popup, tab1_title, tab1_descr, tab2_title, tab2_descr, tab3_title, tab3_descr, item_settings, theme, shipping_tag, flat_rate_shipping_tag, exclude_shipping_rule, shipping_price, commission_rate, commission_dollar, attribute_note, attribute_note_default";

/** 共用庫存：讀主商品的庫存（庫存以主商品為準） */
async function loadStockParents(tenantId: number, list: Record<string, unknown>[]): Promise<Map<number, { a: number; b: number }>> {
  const parentIds = [...new Set(list.filter((r) => r.share_stock && r.parent_item_id).map((r) => num(r.parent_item_id)))];
  const parents = new Map<number, { a: number; b: number }>();
  if (parentIds.length) {
    const { data: ps, error: e3 } = await getServiceClient()
      .from("items")
      .select("id, stock_available, stock_back_order_available")
      .eq("tenant_id", tenantId)
      .in("id", parentIds);
    if (e3) throw new Error(`讀取主商品庫存失敗：${e3.message}`);
    for (const p of (ps ?? []) as Record<string, unknown>[]) parents.set(num(p.id), { a: num(p.stock_available), b: num(p.stock_back_order_available) });
  }
  return parents;
}

function toCatalogItem(r: Record<string, unknown>, parents: Map<number, { a: number; b: number }>, groupBuyItemSetId: number): CatalogItem {
  const shared = !!r.share_stock && r.parent_item_id != null && parents.has(num(r.parent_item_id));
  const owner = shared ? num(r.parent_item_id) : num(r.id);
  const st = shared ? parents.get(owner)! : { a: num(r.stock_available), b: num(r.stock_back_order_available) };
  const maxQ = num(r.max_order_quota, 10);
  return {
    itemId: num(r.id),
    itemSetId: num(r.item_set_id),
    groupBuyItemSetId,
    parentItemId: r.parent_item_id == null ? null : num(r.parent_item_id),
    shareStock: !!r.share_stock,
    seq: num(r.seq),
    uid: (r.uid as string) ?? null,
    title: String(r.title ?? ""),
    shortName: (r.short_name as string) ?? null,
    shortNameDisplay: (r.short_name_display as string) ?? null,
    tag: (r.tag as string) ?? null,
    price: num(r.price),
    retailPrice: r.retail_price == null ? null : num(r.retail_price),
    cprice: num(r.cprice),
    maxOrderQuota: maxQ,
    stockOwnerId: owner,
    stockAvailable: Math.max(0, st.a),
    stockBackOrderAvailable: Math.max(0, st.b),
    calculatedMaxOrderQuota: Math.max(0, Math.min(maxQ, Math.max(0, st.a) + Math.max(0, st.b))),
    offline: !!r.offline,
    optionOfflineWhenSoldOut: !!r.option_offline_when_sold_out,
    itemType: String(r.item_type ?? "NORMAL"),
    image: (r.image as string) ?? null,
    imagePopup: (r.image_popup as string) ?? null,
    tabs: tabsOf(r),
    itemSettings: (r.item_settings as Record<string, unknown>) ?? {},
    theme: (r.theme as Record<string, unknown>) ?? {},
    shippingTag: String(r.shipping_tag ?? ""),
    flatRateShippingTag: String(r.flat_rate_shipping_tag ?? ""),
    excludeShippingRule: !!r.exclude_shipping_rule,
    shippingPrice: r.shipping_price == null ? null : num(r.shipping_price),
    commissionRate: num(r.commission_rate),
    commissionDollar: num(r.commission_dollar),
    attributeNote: !!r.attribute_note,
    attributeNoteDefault: (r.attribute_note_default as string) ?? null,
  };
}

/**
 * 依商品 id 讀商品（組合商品的子商品可能不在本團購的品項內）；含下架商品（offline 欄位由呼叫端判斷）。
 * groupBuyItemSetId：子商品所屬品項若在本團購內，帶本團購的團購品項 id，否則 0。
 */
export async function loadItemsByIds(tenantId: number, ids: number[], gbisByItemSet: Map<number, number> = new Map()): Promise<Map<number, CatalogItem>> {
  const want = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out = new Map<number, CatalogItem>();
  if (!want.length) return out;
  const { data, error } = await getServiceClient().from("items").select(ITEM_COLUMNS).eq("tenant_id", tenantId).in("id", want);
  if (error) throw new Error(`讀取商品失敗：${error.message}`);
  const list = (data ?? []) as Record<string, unknown>[];
  const parents = await loadStockParents(tenantId, list);
  for (const r of list) out.set(num(r.id), toCatalogItem(r, parents, gbisByItemSet.get(num(r.item_set_id)) ?? 0));
  return out;
}

/** 讀團購的上架品項與商品（不含下架品項/商品） */
export async function loadCatalog(tenantId: number, groupBuyId: number, opts: { includeOffline?: boolean } = {}): Promise<Catalog> {
  await runDueSchedulersSafe(tenantId); // items 排程：前台讀品項前先惰性執行到期的上下架／變價排程
  const db = getServiceClient();
  let q = db
    .from("group_buy_item_sets")
    .select(
      "id, item_set_id, seq, style, item_set_top_style, css, css_title, css_normal_select, css_backorder_select, combinable, option_offline, option_offline_when_sold_out, ready_for_sale, item_sets(id, title, descr, image, tab1_title, tab1_descr, tab2_title, tab2_descr, tab3_title, tab3_descr, item_set_settings)",
    )
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("seq", { ascending: true })
    .order("id", { ascending: true });
  if (!opts.includeOffline) q = q.eq("option_offline", false).eq("ready_for_sale", true);
  const { data: sets, error } = await q;
  if (error) throw new Error(`讀取品項失敗：${error.message}`);
  const itemSets: CatalogItemSet[] = [];
  const gbisByItemSet = new Map<number, number>();
  for (const r of (sets ?? []) as Record<string, unknown>[]) {
    const s = (r.item_sets ?? {}) as Record<string, unknown>;
    const itemSetId = num(r.item_set_id);
    if (!gbisByItemSet.has(itemSetId)) gbisByItemSet.set(itemSetId, num(r.id));
    itemSets.push({
      groupBuyItemSetId: num(r.id),
      itemSetId,
      seq: num(r.seq),
      style: String(r.style ?? "STYLE1"),
      itemSetTopStyle: String(r.item_set_top_style ?? "STYLE1"),
      css: (r.css as string) ?? null,
      cssTitle: (r.css_title as string) ?? null,
      cssNormalSelect: (r.css_normal_select as string) ?? null,
      cssBackorderSelect: (r.css_backorder_select as string) ?? null,
      combinable: !!r.combinable,
      optionOfflineWhenSoldOut: !!r.option_offline_when_sold_out,
      title: String(s.title ?? ""),
      descr: (s.descr as string) ?? null,
      tabs: tabsOf(s),
      itemSetSettings: (s.item_set_settings as Record<string, unknown>) ?? {},
      image: (s.image as string) ?? null,
    });
  }
  const itemSetIds = [...gbisByItemSet.keys()];
  const items: CatalogItem[] = [];
  const byId = new Map<number, CatalogItem>();
  if (itemSetIds.length === 0) return { itemSets, items, byId, gbisByItemSet };

  const { data: rows, error: e2 } = await db
    .from("items")
    .select(ITEM_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("item_set_id", itemSetIds)
    .order("seq", { ascending: true })
    .order("id", { ascending: true });
  if (e2) throw new Error(`讀取商品失敗：${e2.message}`);
  const list = (rows ?? []) as Record<string, unknown>[];
  const parents = await loadStockParents(tenantId, list);
  for (const r of list) {
    if (r.offline && !opts.includeOffline) continue;
    const it = toCatalogItem(r, parents, gbisByItemSet.get(num(r.item_set_id)) ?? 0);
    items.push(it);
    byId.set(it.itemId, it);
  }
  return { itemSets, items, byId, gbisByItemSet };
}

/** 價格顯示：NT$1,200（原站 formattedPrice） */
export function formatPrice(v: number, currency = "TWD"): string {
  const sym = currency === "TWD" || !currency ? "NT$" : currency === "USD" ? "US$" : `${currency} `;
  const n = Math.round(v * 100) / 100;
  const s = Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${sym}${s}`;
}
