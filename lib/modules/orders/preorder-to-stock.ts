// 預購商品轉現貨（/backend/PreorderToStock/list）＋訂單列的「預購轉現貨」彈窗與批次轉換（擁有者：orders 模組 orders-b2s）。
// 原站：spec/html/preordertostock-list.html（缺段已依原站 GET 補齊）、public/scripts/preorderToStock.js（本頁 PreorderToStockManager）、
//       public/public/scripts/b2s.min.js（彈窗用 PreorderToStockManager）、salesOrderList.min.js（工具列 bToS、列卡片 displayPrepareToStock）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/PreorderToStock/list?groupBuyId=                         頁面（單一團購頁；團購不屬於本租戶 → 404）
//   GET  /ajax/PreorderToStock/fetchPreorderInfo?groupBuyId=               預購商品 {data:[{itemId,title,preorderTotal,stockAvailable,stockCache}],…}
//   GET  /ajax/PreorderToStock/fetchSingleItemPreorderInfo?groupBuyId&itemId&orderBy
//                                                                          商品訂單明細 {data:[{orderItemId,uuid,datePaid,amount,preorderTotal}],…}
//   POST /ajax/PreorderToStock/convertSingleItem       groupBuyId,itemId,total,orderBy   依優先順序轉換至多 total 件
//   POST /ajax/PreorderToStock/convertSingleOrderItem  groupBuyId,orderItemId            單筆訂單商品轉現貨
//   POST /ajax/PreorderToStock/addStock                groupBuyId,itemId,stock           增加庫存
//   POST /ajax/PreorderToStock/stockToCache            groupBuyId,itemId,cacheTotal      現貨轉暫存（原站頁面按鈕已註解，端點保留）
//   GET  /ajax/PreorderToStock/displayPrepareToStock?salesOrderId=         訂單列卡片「預購轉現貨」彈窗片段（openForm）
//   GET  /ajax/PreorderToStock/fetchOrder?salesOrderId=                    彈窗清單 {data:[{orderItemId,uid,name,total,stockAvailable,stockCache}],…}
//   POST /ajax/PreorderToStock/convert   JSON {salesOrderId, sortedOrderItems:[{orderItemId,uid}]}  彈窗確認轉換（全有或全無）
//   POST /ajax/SalesOrder/bToS           groupBuyId, salesOrderId=1,2,3   訂單列表工具列批次轉換 → {code:200, b2sTotal}
//
// 回應格式（原站實測）：讀取端點一律 DataTables 列表格式 {data, recordsTotal, recordsFiltered, dateModified, executionTime, options}；
// 團購缺少或不屬於本租戶 → HTTP 400 {code:401, error:'無權限'}；動作成功 → actionOk('訊息')（前端讀 response.error 顯示）。
// 轉換的資料面在 DB 函式 groupbuy.orders_preorder_convert（migration 3040，原子處理：鎖列→檢查庫存→back_order=false→扣庫存→補回預購可售→寫 log），
// 訂單歷程由 addOrderHistory() 寫入；sales_orders.contain_back_orders 由觸發器維護。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, fragment, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, json } from "@/lib/core/http/responses";
import { HttpError, badRequest } from "@/lib/core/http/errors";
import { taipeiDateTime } from "@/lib/core/time";
import { OPEN_STATES, addOrderHistory, db, esc, fetchOrders, idsParam } from "./common";
import { countB2sOrders } from "./b2s";

/* ─────────────────────────── 共用 ─────────────────────────── */

type OrderBy = "DATE_PAID" | "ORDER_ITEM_TOTAL" | "ORDER_AMOUNT";
const ORDER_BYS: OrderBy[] = ["DATE_PAID", "ORDER_ITEM_TOTAL", "ORDER_AMOUNT"];

/** 原站：團購缺少／不屬於本租戶 → HTTP 400 {code:401, error:'無權限'} */
const noPermission = () => new HttpError(400, "無權限", { code: 401 });

function posInt(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function intArg(ctx: RequestContext, name: string): Promise<number | null> {
  return posInt(await ctx.param(name));
}

function orderByArg(v: unknown): OrderBy {
  const s = String(v ?? "").trim() as OrderBy;
  return ORDER_BYS.includes(s) ? s : "DATE_PAID";
}

/** 團購必須屬於本租戶（原站錯誤格式） */
async function requireGroupBuy(session: AdminSession, raw: unknown): Promise<number> {
  const id = posInt(raw);
  if (!id) throw noPermission();
  const { data, error } = await db().from("group_buys").select("id").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[preorder-to-stock] 讀取團購失敗：${error.message}`);
  if (!data) throw noPermission();
  return id;
}

/** 原站讀取端點的 DataTables 列表格式 */
function listJson(rows: unknown[], startedAt: number): Response {
  return json({
    data: rows,
    recordsTotal: rows.length,
    recordsFiltered: rows.length,
    dateModified: Date.now(),
    executionTime: Math.max(0, Date.now() - startedAt),
    options: {},
  });
}

/* ─────────────────────────── 待轉換的預購訂單商品 ─────────────────────────── */

type PendingRow = {
  id: number;
  sales_order_id: number;
  item_id: number | null;
  title: string;
  specifications_label: string | null;
  uid: string | null;
  total: number;
  seq: number;
  sales_orders: { uuid: string; state: string; group_buy_id: number | null; date_paid: string | null; grand_total: number | string | null } | null;
};

/**
 * 待轉換＝訂單 NEW/PROCESSING（同 b2s.ts 口徑）中，back_order=true 且 state=UNSHIPPING 的訂單商品。
 * 可依團購（sales_orders.group_buy_id）、商品、訂單限定。
 */
async function pendingOrderItems(
  session: AdminSession,
  f: { groupBuyId?: number | null; itemId?: number | null; salesOrderIds?: number[] },
): Promise<PendingRow[]> {
  const out: PendingRow[] = [];
  const orderChunks = f.salesOrderIds ? chunk(f.salesOrderIds, 300) : [null];
  for (const ids of orderChunks) {
    if (ids && !ids.length) continue;
    for (let from = 0; ; from += 1000) {
      let q = db()
        .from("order_items")
        .select("id,sales_order_id,item_id,title,specifications_label,uid,total,seq,sales_orders!inner(uuid,state,group_buy_id,date_paid,grand_total)")
        .eq("tenant_id", session.tenantId)
        .eq("back_order", true)
        .eq("state", "UNSHIPPING")
        .in("sales_orders.state", [...OPEN_STATES]);
      if (f.groupBuyId) q = q.eq("sales_orders.group_buy_id", f.groupBuyId);
      if (f.itemId) q = q.eq("item_id", f.itemId);
      if (ids) q = q.in("sales_order_id", ids);
      const { data, error } = await q.order("id").range(from, from + 999);
      if (error) throw new Error(`[preorder-to-stock] 讀取預購訂單商品失敗：${error.message}`);
      out.push(...((data ?? []) as unknown as PendingRow[]));
      if ((data ?? []).length < 1000) break;
    }
  }
  return out;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const paidTime = (r: PendingRow) => (r.sales_orders?.date_paid ? Date.parse(r.sales_orders.date_paid) : Number.POSITIVE_INFINITY);
const byPaid = (a: PendingRow, b: PendingRow) => paidTime(a) - paidTime(b) || a.sales_order_id - b.sales_order_id || a.seq - b.seq || a.id - b.id;

/**
 * 訂單優先順序（推導；原站排序方向未知）：
 *   DATE_PAID 付款日期早的優先（未付款排最後）；ORDER_ITEM_TOTAL 訂單商品數量多的優先；ORDER_AMOUNT 訂單金額高的優先。
 *   同值再依付款日期、訂單編號。
 */
function sortByPriority(rows: PendingRow[], orderBy: OrderBy): PendingRow[] {
  const amount = (r: PendingRow) => Number(r.sales_orders?.grand_total ?? 0) || 0;
  return [...rows].sort((a, b) => {
    if (orderBy === "ORDER_ITEM_TOTAL") return Number(b.total) - Number(a.total) || byPaid(a, b);
    if (orderBy === "ORDER_AMOUNT") return amount(b) - amount(a) || byPaid(a, b);
    return byPaid(a, b);
  });
}

/* ─────────────────────────── 商品庫存（共用庫存取主商品） ─────────────────────────── */

type ItemStock = { title: string; seq: number; itemSetId: number | null; stockAvailable: number; stockCache: number };

async function loadItemStocks(session: AdminSession, itemIds: number[]): Promise<Map<number, ItemStock>> {
  const out = new Map<number, ItemStock>();
  if (!itemIds.length) return out;
  type ItemRow = {
    id: number;
    title: string;
    seq: number;
    item_set_id: number | null;
    share_stock: boolean;
    parent_item_id: number | null;
    stock_available: number;
    stock_cache: number;
  };
  const rows: ItemRow[] = [];
  for (const ids of chunk(itemIds, 300)) {
    const { data, error } = await db()
      .from("items")
      .select("id,title,seq,item_set_id,share_stock,parent_item_id,stock_available,stock_cache")
      .eq("tenant_id", session.tenantId)
      .in("id", ids);
    if (error) throw new Error(`[preorder-to-stock] 讀取商品失敗：${error.message}`);
    rows.push(...((data ?? []) as ItemRow[]));
  }
  const parentIds = [...new Set(rows.filter((r) => r.share_stock && r.parent_item_id).map((r) => r.parent_item_id as number))];
  const parents = new Map<number, { stock_available: number; stock_cache: number }>();
  for (const ids of chunk(parentIds, 300)) {
    const { data, error } = await db().from("items").select("id,stock_available,stock_cache").eq("tenant_id", session.tenantId).in("id", ids);
    if (error) throw new Error(`[preorder-to-stock] 讀取主商品失敗：${error.message}`);
    for (const p of (data ?? []) as { id: number; stock_available: number; stock_cache: number }[]) parents.set(p.id, p);
  }
  for (const r of rows) {
    const src = r.share_stock && r.parent_item_id ? parents.get(r.parent_item_id) : r;
    out.set(r.id, {
      title: r.title ?? "",
      seq: Number(r.seq) || 0,
      itemSetId: r.item_set_id,
      stockAvailable: Number(src?.stock_available) || 0,
      stockCache: Number(src?.stock_cache) || 0,
    });
  }
  return out;
}

/** 商品必須屬於本租戶且在此團購中（團購的品項，或此團購有此商品的訂單） */
async function requireItemInGroupBuy(session: AdminSession, groupBuyId: number, itemId: number | null): Promise<number> {
  if (!itemId) throw badRequest("找不到商品");
  const { data: item, error } = await db()
    .from("items")
    .select("id,item_set_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", itemId)
    .maybeSingle<{ id: number; item_set_id: number | null }>();
  if (error) throw new Error(`[preorder-to-stock] 讀取商品失敗：${error.message}`);
  if (!item) throw badRequest("找不到商品");
  if (item.item_set_id) {
    const { data } = await db()
      .from("group_buy_item_sets")
      .select("id")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", groupBuyId)
      .eq("item_set_id", item.item_set_id)
      .limit(1);
    if ((data ?? []).length) return item.id;
  }
  const { data: used } = await db()
    .from("order_items")
    .select("id,sales_orders!inner(group_buy_id)")
    .eq("tenant_id", session.tenantId)
    .eq("item_id", item.id)
    .eq("sales_orders.group_buy_id", groupBuyId)
    .limit(1);
  if ((used ?? []).length) return item.id;
  throw badRequest("此商品不屬於此團購");
}

/* ─────────────────────────── 轉換（DB 函式）與歷程 ─────────────────────────── */

type ConvertResult = {
  orderItemId: number;
  salesOrderId?: number;
  itemId?: number | null;
  title?: string;
  specificationsLabel?: string | null;
  qty?: number;
  result: "CONVERTED" | "ALREADY" | "INVALID" | "NOT_FOUND" | "SKIPPED" | "INSUFFICIENT";
  error?: string;
  pool?: "CACHE" | "AVAILABLE";
};

/**
 * 依傳入順序（＝優先順序）把訂單商品轉為現貨。budget：轉換數量上限（跨批次累計）；allOrNothing：任一筆失敗整批不轉（回 400）。
 */
async function convertOrderItems(
  session: AdminSession,
  orderItemIds: number[],
  opts: { groupBuyId?: number | null; salesOrderId?: number | null; orderBy?: OrderBy | null; budget?: number | null; allOrNothing?: boolean } = {},
): Promise<ConvertResult[]> {
  const out: ConvertResult[] = [];
  let remaining = opts.budget ?? null;
  // 全有或全無必須同一交易 → 不分批（彈窗為單一訂單的商品，數量少）
  const batches = opts.allOrNothing ? [orderItemIds] : chunk(orderItemIds, 200);
  for (const ids of batches) {
    if (!ids.length) continue;
    if (remaining !== null && remaining <= 0) {
      out.push(...ids.map((id) => ({ orderItemId: id, result: "SKIPPED" as const, error: "超過轉換數量" })));
      continue;
    }
    const { data, error } = await db().rpc("orders_preorder_convert", {
      p_tenant_id: session.tenantId,
      p_order_item_ids: ids,
      p_admin_user_id: session.adminUserId,
      p_group_buy_id: opts.groupBuyId ?? null,
      p_sales_order_id: opts.salesOrderId ?? null,
      p_order_by: opts.orderBy ?? null,
      p_budget: remaining,
      p_all_or_nothing: !!opts.allOrNothing,
    });
    if (error) {
      if (error.code === "P0001") throw badRequest(error.message);
      throw new Error(`[preorder-to-stock] 轉換失敗：${error.message}`);
    }
    const rows = (data ?? []) as ConvertResult[];
    out.push(...rows);
    if (remaining !== null) {
      remaining -= rows.filter((r) => r.result === "CONVERTED").reduce((s, r) => s + Number(r.qty || 0), 0);
    }
  }
  return out;
}

/** 每張被轉換的訂單寫一筆歷程：「預購轉現貨：商品A(規格) ×2、商品B ×1」 */
async function writeConvertHistories(session: AdminSession, results: ConvertResult[]): Promise<void> {
  const byOrder = new Map<number, string[]>();
  for (const r of results) {
    if (r.result !== "CONVERTED" || !r.salesOrderId) continue;
    const name = `${r.title ?? ""}${r.specificationsLabel ? `(${r.specificationsLabel})` : ""}`;
    const list = byOrder.get(r.salesOrderId) ?? [];
    list.push(`${name} ×${r.qty ?? 0}`);
    byOrder.set(r.salesOrderId, list);
  }
  const entries = [...byOrder.entries()];
  for (const part of chunk(entries, 10)) {
    await Promise.all(part.map(([orderId, names]) => addOrderHistory(session, orderId, `預購轉現貨：${names.join("、")}`)));
  }
}

function summarize(results: ConvertResult[]): { orders: number; qty: number; converted: number; insufficient: number } {
  const done = results.filter((r) => r.result === "CONVERTED");
  return {
    orders: new Set(done.map((r) => r.salesOrderId)).size,
    qty: done.reduce((s, r) => s + Number(r.qty || 0), 0),
    converted: done.length,
    insufficient: results.filter((r) => r.result === "INSUFFICIENT").length,
  };
}

/* ─────────────────────────── 本頁端點（preorderToStock.js） ─────────────────────────── */

/** GET fetchPreorderInfo：此團購有待轉換預購的商品（依品項順序） */
async function fetchPreorderInfo(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const rows = await pendingOrderItems(session, { groupBuyId });
  const totals = new Map<number, number>();
  for (const r of rows) if (r.item_id) totals.set(r.item_id, (totals.get(r.item_id) ?? 0) + (Number(r.total) || 0));
  const stocks = await loadItemStocks(session, [...totals.keys()]);
  const { data: sets } = await db()
    .from("group_buy_item_sets")
    .select("item_set_id,seq")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId);
  const setSeq = new Map(((sets ?? []) as { item_set_id: number; seq: number }[]).map((s) => [s.item_set_id, Number(s.seq) || 0]));
  const data = [...totals.entries()]
    .filter(([id]) => stocks.has(id))
    .map(([id, preorderTotal]) => ({ id, preorderTotal, s: stocks.get(id)! }))
    .sort(
      (a, b) =>
        (setSeq.get(a.s.itemSetId ?? 0) ?? 1e9) - (setSeq.get(b.s.itemSetId ?? 0) ?? 1e9) || a.s.seq - b.s.seq || a.id - b.id,
    )
    .map(({ id, preorderTotal, s }) => ({
      itemId: id,
      title: esc(s.title), // 前端直接插入 HTML／data 屬性
      preorderTotal,
      stockAvailable: s.stockAvailable,
      stockCache: s.stockCache,
    }));
  return listJson(data, started);
}

/** GET fetchSingleItemPreorderInfo：單一商品的待轉換訂單（依 orderBy 排序） */
async function fetchSingleItemPreorderInfo(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const itemId = await intArg(ctx, "itemId");
  if (!itemId) return listJson([], started);
  const orderBy = orderByArg(await ctx.param("orderBy"));
  const rows = sortByPriority(await pendingOrderItems(session, { groupBuyId, itemId }), orderBy);
  const data = rows.map((r) => ({
    orderItemId: r.id,
    uuid: esc(r.sales_orders?.uuid ?? ""),
    datePaid: taipeiDateTime(r.sales_orders?.date_paid),
    amount: Number(r.sales_orders?.grand_total ?? 0) || 0,
    preorderTotal: Number(r.total) || 0,
  }));
  return listJson(data, started);
}

/** POST convertSingleItem：依優先順序轉換此商品至多 total 件（超過剩餘數量的訂單略過、庫存不足的略過） */
async function convertSingleItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const itemId = await requireItemInGroupBuy(session, groupBuyId, await intArg(ctx, "itemId"));
  const total = await intArg(ctx, "total");
  if (!total) throw badRequest("請輸入有效的轉換數量");
  const orderBy = orderByArg(await ctx.param("orderBy"));
  const rows = sortByPriority(await pendingOrderItems(session, { groupBuyId, itemId }), orderBy);
  if (!rows.length) throw badRequest("此商品目前沒有待轉現貨的預購訂單");
  const results = await convertOrderItems(
    session,
    rows.map((r) => r.id),
    { groupBuyId, orderBy, budget: total },
  );
  await writeConvertHistories(session, results);
  const s = summarize(results);
  if (!s.converted) {
    throw badRequest(s.insufficient ? "庫存不足，沒有可轉換的訂單" : "沒有可轉換的訂單（訂單商品數量超過轉換數量）");
  }
  const left = rows.length - s.converted;
  return actionOk(`已轉換 ${s.orders} 筆訂單，共 ${s.qty} 件商品為現貨${left > 0 ? `（尚有 ${left} 筆預購訂單未轉換）` : ""}`, {
    converted: s.converted,
    quantity: s.qty,
  });
}

/** POST convertSingleOrderItem：單筆訂單商品轉現貨（已轉換過視為成功） */
async function convertSingleOrderItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const orderItemId = await intArg(ctx, "orderItemId");
  if (!orderItemId) throw badRequest("找不到訂單商品");
  const [r] = await convertOrderItems(session, [orderItemId], { groupBuyId });
  if (r?.result === "CONVERTED") {
    await writeConvertHistories(session, [r]);
    return actionOk("轉換成功", { quantity: r.qty ?? 0 });
  }
  if (r?.result === "ALREADY") return actionOk(r.error ?? "此商品已轉換為現貨");
  throw badRequest(r?.error ?? "訂單項目轉換失敗");
}

/** POST addStock：增加庫存（stock 與 stock_available 同加；共用庫存時加在主商品） */
async function addStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const itemId = await requireItemInGroupBuy(session, groupBuyId, await intArg(ctx, "itemId"));
  const qty = await intArg(ctx, "stock");
  if (!qty) throw badRequest("請輸入有效的數量（大於0的整數）");
  const r = await itemStockOp(session, itemId, "ADD_STOCK", qty, groupBuyId);
  return actionOk(`成功增加 ${qty} 件庫存`, r);
}

/** POST stockToCache：可售現貨移到暫存（保留現貨 stock_cache） */
async function stockToCache(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuy(session, await ctx.param("groupBuyId"));
  const itemId = await requireItemInGroupBuy(session, groupBuyId, await intArg(ctx, "itemId"));
  const qty = await intArg(ctx, "cacheTotal");
  if (!qty) throw badRequest("請輸入有效的數量");
  const r = await itemStockOp(session, itemId, "TO_CACHE", qty, groupBuyId);
  return actionOk(`成功將 ${qty} 件庫存轉移到暫存`, r);
}

async function itemStockOp(
  session: AdminSession,
  itemId: number,
  op: "ADD_STOCK" | "TO_CACHE",
  qty: number,
  groupBuyId: number,
): Promise<Record<string, unknown>> {
  const { data, error } = await db().rpc("orders_preorder_item_stock", {
    p_tenant_id: session.tenantId,
    p_item_id: itemId,
    p_op: op,
    p_qty: qty,
    p_admin_user_id: session.adminUserId,
    p_group_buy_id: groupBuyId,
  });
  if (error) {
    if (error.code === "P0001") throw badRequest(error.message);
    throw new Error(`[preorder-to-stock] 庫存調整失敗：${error.message}`);
  }
  return (data ?? {}) as Record<string, unknown>;
}

/* ─────────────────────────── 訂單列彈窗（b2s.min.js） ─────────────────────────── */

/** GET fetchOrder：此訂單待轉換的預購商品（找不到訂單／無預購 → 空清單，同原站） */
async function fetchOrder(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const salesOrderId = await intArg(ctx, "salesOrderId");
  if (!salesOrderId) return listJson([], started);
  const rows = (await pendingOrderItems(session, { salesOrderIds: [salesOrderId] }))
    .filter((r) => r.item_id)
    .sort((a, b) => a.seq - b.seq || a.id - b.id);
  const stocks = await loadItemStocks(session, [...new Set(rows.map((r) => r.item_id as number))]);
  const data = rows
    .filter((r) => stocks.has(r.item_id as number))
    .map((r) => {
      const s = stocks.get(r.item_id as number)!;
      return {
        orderItemId: r.id,
        uid: esc(r.uid ?? ""),
        name: esc(`${r.title ?? ""}${r.specifications_label ? ` (${r.specifications_label})` : ""}`),
        total: Number(r.total) || 0,
        stockAvailable: s.stockAvailable,
        stockCache: s.stockCache,
      };
    });
  return listJson(data, started);
}

/** POST convert（JSON）：彈窗勾選的訂單商品轉為現貨；任一筆庫存不足 → 全部不轉並回錯誤 */
async function convertSelected(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const j = (body.json ?? {}) as { salesOrderId?: unknown; sortedOrderItems?: { orderItemId?: unknown }[] };
  const salesOrderId = posInt(j.salesOrderId ?? (await ctx.param("salesOrderId")));
  if (!salesOrderId) throw badRequest("缺少訂單編號");
  const [order] = await fetchOrders(session, [salesOrderId], "id");
  if (!order) throw badRequest("訂單物件不存在");
  const list = Array.isArray(j.sortedOrderItems) ? j.sortedOrderItems : [];
  const ids = [...new Set(list.map((x) => posInt(x?.orderItemId)).filter((x): x is number => !!x))];
  if (!ids.length) throw badRequest("請選擇至少一個可轉現貨的項目");
  const results = await convertOrderItems(session, ids, { salesOrderId, allOrNothing: true });
  await writeConvertHistories(session, results);
  const s = summarize(results);
  return actionOk("預購商品成功轉換為現貨", { success: true, converted: s.converted, quantity: s.qty });
}

/* ─────────────────────────── 訂單列表工具列「預購轉現貨」 ─────────────────────────── */

/**
 * POST /ajax/SalesOrder/bToS：把勾選訂單的預購商品轉為現貨（依付款日期先後處理；庫存不足的商品略過），回 b2sTotal。
 * 推導：工具列按鈕為 extend:'selected'，前端一定帶勾選的 salesOrderId；若未帶（空字串）則不轉換任何訂單、只回最新 b2sTotal。
 */
async function bToS(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rawGb = await ctx.param("groupBuyId");
  const groupBuyId = posInt(rawGb) ? await requireGroupBuy(session, rawGb) : null;
  const ids = await idsParam(ctx, "salesOrderId");
  let message = "未選擇訂單";
  let s = { orders: 0, qty: 0, converted: 0, insufficient: 0 };
  if (ids.length) {
    const rows = (await pendingOrderItems(session, { salesOrderIds: ids, groupBuyId })).sort(byPaid);
    const results = await convertOrderItems(
      session,
      rows.map((r) => r.id),
      { groupBuyId },
    );
    await writeConvertHistories(session, results);
    s = summarize(results);
    message = s.converted
      ? `已將 ${s.orders} 筆訂單的預購商品轉為現貨（共 ${s.qty} 件）${s.insufficient ? `，${s.insufficient} 項商品庫存不足未轉換` : ""}`
      : s.insufficient
        ? `庫存不足，${s.insufficient} 項預購商品未轉換`
        : "所選訂單沒有可轉現貨的預購商品";
  }
  const b2sTotal = await countB2sOrders(session, groupBuyId);
  return actionOk(message, { b2sTotal, converted: s.converted, quantity: s.qty });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const preorderToStockRoutes: RouteDef[] = [
  page("/backend/PreorderToStock/list", {
    template: "orders/preordertostock-list.html",
    title: "預購商品轉現貨管理",
    groupBuy: "required",
  }),
  any("/ajax/PreorderToStock/fetchPreorderInfo", fetchPreorderInfo),
  any("/ajax/PreorderToStock/fetchSingleItemPreorderInfo", fetchSingleItemPreorderInfo),
  post("/ajax/PreorderToStock/convertSingleItem", convertSingleItem),
  post("/ajax/PreorderToStock/convertSingleOrderItem", convertSingleOrderItem),
  post("/ajax/PreorderToStock/addStock", addStock),
  post("/ajax/PreorderToStock/stockToCache", stockToCache),
  fragment("/ajax/PreorderToStock/displayPrepareToStock", {
    template: "orders/preordertostock-prepare.html",
    // 原站把參數原樣放進 `const orderId = '…'`；這裡只保留數字，模板以 {{json salesOrderId}} 輸出（避免注入）
    data: async (ctx) => ({ salesOrderId: String((await ctx.param("salesOrderId")) ?? "").replace(/[^0-9]/g, "") }),
  }),
  any("/ajax/PreorderToStock/fetchOrder", fetchOrder),
  post("/ajax/PreorderToStock/convert", convertSelected),
  post("/ajax/SalesOrder/bToS", bToS),
];
