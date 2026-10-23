// 「可預購轉現貨」（b2s）判定（擁有者：orders lead；訂單列表篩選、b2sTotal 徽章、預購轉現貨頁共用同一口徑）。
// 定義：訂單階段 NEW/PROCESSING，且有「預購（back_order=true）、未出貨（state=UNSHIPPING）」的訂單商品，
//       而該商品（共用庫存時取主商品）的保留現貨 stock_cache 或可售現貨 stock_available ≥ 該訂單商品數量
//       （與 migration 3040 orders_preorder_convert 的扣庫存規則一致：保留現貨夠先扣保留現貨，否則扣可售現貨）。
import type { AdminSession } from "@/lib/core/http/types";
import { db } from "./common";

type Oi = {
  sales_order_id: number;
  total: number;
  item_id: number | null;
  sales_orders: { state: string; group_buy_id: number | null } | null;
};

/** 回傳可轉現貨的訂單 id（可限定團購） */
export async function b2sEligibleOrderIds(session: AdminSession, groupBuyId?: number | null): Promise<number[]> {
  const client = db();
  const rows: Oi[] = [];
  for (let from = 0; ; from += 1000) {
    let q = client
      .from("order_items")
      .select("sales_order_id,total,item_id,sales_orders!inner(state,group_buy_id)")
      .eq("tenant_id", session.tenantId)
      .eq("back_order", true)
      .eq("state", "UNSHIPPING")
      .in("sales_orders.state", ["NEW", "PROCESSING"]);
    if (groupBuyId) q = q.eq("sales_orders.group_buy_id", groupBuyId);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(`[orders b2s] ${error.message}`);
    rows.push(...((data ?? []) as unknown as Oi[]));
    if ((data ?? []).length < 1000) break;
  }
  const itemIds = [...new Set(rows.map((r) => r.item_id).filter((x): x is number => !!x))];
  if (!itemIds.length) return [];
  const stock = await availableStock(session, itemIds);
  const ok = new Set<number>();
  for (const r of rows) {
    if (r.item_id && (stock.get(r.item_id) ?? 0) >= Number(r.total || 0)) ok.add(Number(r.sales_order_id));
  }
  return [...ok];
}

/** b2sTotal：可轉現貨訂單數（列表回應與 #b2sBadge） */
export async function countB2sOrders(session: AdminSession, groupBuyId?: number | null): Promise<number> {
  return (await b2sEligibleOrderIds(session, groupBuyId)).length;
}

/** 商品目前可用來轉換的現貨數量＝max(保留現貨 stock_cache, 可售現貨 stock_available)（共用庫存時取主商品） */
export async function availableStock(session: AdminSession, itemIds: number[]): Promise<Map<number, number>> {
  const client = db();
  const out = new Map<number, number>();
  if (!itemIds.length) return out;
  const items: { id: number; stock_available: number; stock_cache: number | null; share_stock: boolean; parent_item_id: number | null }[] = [];
  for (let i = 0; i < itemIds.length; i += 500) {
    const { data, error } = await client
      .from("items")
      .select("id,stock_available,stock_cache,share_stock,parent_item_id")
      .eq("tenant_id", session.tenantId)
      .in("id", itemIds.slice(i, i + 500));
    if (error) throw new Error(`[orders b2s] ${error.message}`);
    items.push(...((data ?? []) as typeof items));
  }
  const parentIds = [...new Set(items.filter((i) => i.share_stock && i.parent_item_id).map((i) => i.parent_item_id as number))];
  const parentStock = new Map<number, number>();
  if (parentIds.length) {
    const { data } = await client.from("items").select("id,stock_available,stock_cache").eq("tenant_id", session.tenantId).in("id", parentIds);
    for (const p of (data ?? []) as { id: number; stock_available: number; stock_cache: number | null }[]) {
      parentStock.set(p.id, Math.max(Number(p.stock_cache) || 0, Number(p.stock_available) || 0));
    }
  }
  for (const i of items) {
    out.set(
      i.id,
      i.share_stock && i.parent_item_id ? parentStock.get(i.parent_item_id) ?? 0 : Math.max(Number(i.stock_cache) || 0, Number(i.stock_available) || 0),
    );
  }
  return out;
}
