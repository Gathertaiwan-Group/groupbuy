// 組合商品（ItemBundleV2）前台資料讀取與庫存計算（購物袋 reconcile、config／addBundle 端點共用）。
import { getServiceClient } from "@/lib/supabase/server";
import { loadItemsByIds, type CatalogItem } from "./catalog";
import { normalizeBundle, parseStoredSelection, type ChildStock, type NormalizedBundle } from "./bundle-logic";
import type { CartContext } from "./cart-data";

export interface LoadedBundle {
  id: number;
  status: string;
  groupBuyId: number | null;
  norm: NormalizedBundle;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function toLoaded(r: Record<string, unknown>): LoadedBundle {
  return { id: num(r.id), status: String(r.status ?? "DRAFT"), groupBuyId: r.group_buy_id == null ? null : num(r.group_buy_id), norm: normalizeBundle(r as Parameters<typeof normalizeBundle>[0]) };
}

const BUNDLE_COLS = "id, tenant_id, group_buy_id, item_id, title, price, status, bundle_type, bundle_config";

/** 依組合 id 讀取（一律 tenant 過濾） */
export async function loadBundlesByIds(tenantId: number, ids: number[]): Promise<Map<number, LoadedBundle>> {
  const want = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out = new Map<number, LoadedBundle>();
  if (!want.length) return out;
  const { data, error } = await getServiceClient().from("item_bundles").select(BUNDLE_COLS).eq("tenant_id", tenantId).in("id", want);
  if (error) throw new Error(`讀取組合商品失敗：${error.message}`);
  for (const r of (data ?? []) as Record<string, unknown>[]) out.set(num(r.id), toLoaded(r));
  return out;
}

/** 依組合主商品（BUNDLE_V2 item）讀取 */
export async function loadBundleByItem(tenantId: number, itemId: number): Promise<LoadedBundle | null> {
  const { data, error } = await getServiceClient().from("item_bundles").select(BUNDLE_COLS).eq("tenant_id", tenantId).eq("item_id", itemId).order("id", { ascending: true }).limit(1);
  if (error) throw new Error(`讀取組合商品失敗：${error.message}`);
  const r = (data ?? [])[0] as Record<string, unknown> | undefined;
  return r ? toLoaded(r) : null;
}

export function candidateIds(b: NormalizedBundle): number[] {
  return b.groups.flatMap((g) => g.candidates.map((c) => c.itemId));
}

/** 組合可在本團購前台選購：上架（ACTIVE）、主商品在本團購上架品項內、屬於本團購 */
export function bundleSellable(b: LoadedBundle | null | undefined, root: CatalogItem | undefined, groupBuyId: number): b is LoadedBundle {
  return !!b && !!root && b.status === "ACTIVE" && root.itemType === "BUNDLE_V2" && b.norm.itemId === root.itemId && (b.groupBuyId == null || b.groupBuyId === groupBuyId);
}

/** 購物袋其他明細已占用的數量（依庫存擁有者；組合明細展開成子商品） */
export function cartUsage(cc: CartContext, excludeUuid: string | null): Map<number, number> {
  const used = new Map<number, number>();
  const addUse = (owner: number, q: number) => used.set(owner, (used.get(owner) ?? 0) + q);
  for (const ci of cc.items) {
    if (excludeUuid && ci.uuid === excludeUuid) continue;
    if (ci.item_bundle_id) {
      for (const ch of parseStoredSelection(ci.bundle_selection)) {
        const it = cc.bundleItems.get(ch.itemId) ?? cc.catalog.byId.get(ch.itemId);
        if (it) addUse(it.stockOwnerId, ch.qty * ci.total);
      }
      continue;
    }
    const it = cc.catalog.byId.get(ci.item_id);
    if (it) addUse(it.stockOwnerId, ci.total);
  }
  return used;
}

/** 子商品可售量（扣安全庫存與 used 已占用；現貨／預購分開） */
export function childStockMap(
  b: NormalizedBundle,
  items: Map<number, CatalogItem>,
  usedInStock: Map<number, number>,
  usedBackOrder: Map<number, number> = new Map(),
): Map<number, ChildStock> {
  const out = new Map<number, ChildStock>();
  const safety = new Map<number, number>();
  for (const g of b.groups) for (const c of g.candidates) safety.set(c.itemId, Math.max(safety.get(c.itemId) ?? 0, c.safetyStock));
  for (const id of candidateIds(b)) {
    const it = items.get(id);
    if (!it) continue;
    const a = Math.max(0, it.stockAvailable - (usedInStock.get(it.stockOwnerId) ?? 0));
    const bo = Math.max(0, it.stockBackOrderAvailable - (usedBackOrder.get(it.stockOwnerId) ?? 0));
    out.set(id, { available: Math.max(0, a + bo - (safety.get(id) ?? 0)), inStock: a, offline: it.offline, title: it.shortNameDisplay || it.title });
  }
  return out;
}

/** 購物袋明細展開（給 reconcile 用）：讀購物袋內組合與子商品 */
export async function loadCartBundles(
  tenantId: number,
  bundleIds: number[],
  gbisByItemSet: Map<number, number>,
): Promise<{ bundles: Map<number, LoadedBundle>; items: Map<number, CatalogItem> }> {
  const bundles = await loadBundlesByIds(tenantId, bundleIds);
  const ids = [...bundles.values()].flatMap((b) => candidateIds(b.norm));
  const items = await loadItemsByIds(tenantId, ids, gbisByItemSet);
  return { bundles, items };
}

