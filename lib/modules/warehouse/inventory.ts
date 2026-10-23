// 盤點（/backend/Warehouse/inventory）：頁面 JS 為原站自家檔 /scripts/inventory.js（inventoryManager，原樣沿用），本檔實作它呼叫的端點。
// 原站：spec/html/warehouse-inventory.html、p4.groupbuyforms.tw/scripts/inventory.js。
//
// 庫存對應（docs/DATA_MODEL.md）：倉庫實體庫存＝warehouse_stocks(warehouse_id,item_id).quantity；商品可售＝items.stock/stock_available。
// inventory.js 的「倉儲商品列」（.row-warehouseItem，data-id＝itemId）在本系統＝一筆 warehouse_stocks；JSON 的 itemId 放 warehouse_stocks.id。
//   GET  /ajax/wms/WarehouseInventory/lookup                 select2（mDataProp_0=uid|title、sSearch_0=關鍵字），值＝商品代碼
//   GET  /ajax/wms/WarehouseInventory/loadItems?uid=a,b      加入盤點商品；POST（Editor create）＝匯入檔案（uploadFile+uidCol+stockCol+stockBackOrderCol）
//   POST /ajax/wms/WarehouseInventory/uploadFileForLoadItems 上傳 Excel/CSV（回傳欄位選項）
//   GET  /ajax/Item/queryInv?itemId=                          檢視庫存（各倉庫明細）
//   GET  /ajax/Item/addStock?itemId=&stock=&name=             盤點數量確認 → 增減所選倉庫庫存（交易函式 wms_adjust_stock，並建立盤點單紀錄）
//   GET  /ajax/Item/archiveAndSync?itemId=1,2                 盤點所選倉庫（已出貨歸檔＋同步，wms_archive_and_sync）
//   GET  /ajax/wms/WarehouseInventory/queryUnarchivedOrders   未盤點訂單清單
//   POST /ajax/wms/WarehouseInventory/markArchived           設為已盤點（salesOrderId 或 uuid）
//   POST /ajax/wms/WarehouseInventory/download                匯出（uids）
//   POST /ajax/Item/getWarehouseItems                         倉儲商品列表（頁面中已註解的 #invTable）
import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest } from "@/lib/core/http/errors";
import { actionOk, download, json } from "@/lib/core/http/responses";
import { enumLabel } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { parseEditorRequest } from "@/lib/core/editor/protocol";
import {
  type AnyRow,
  db,
  idList,
  rpc,
  select2Json,
  toInt,
  toNum,
  type WarehouseItemRow,
  warehouseItemsByUid,
  type WarehouseRow,
  wmsList,
} from "./shared";

const MAX_ITEMS = 1000;

/* ───────────────────────── 倉庫明細列 ───────────────────────── */

interface StockRow {
  id: number;
  warehouse_id: number;
  item_id: number;
  quantity: number;
  rack_bin: string | null;
}

interface ItemRow {
  id: number;
  uid: string | null;
  title: string | null;
  item_set_id: number;
  stock: number;
  stock_available: number;
  stock_back_order: number;
  stock_back_order_available: number;
}

async function activeWarehouses(session: AdminSession): Promise<WarehouseRow[]> {
  const { data, error } = await db().from("warehouses").select("*").eq("tenant_id", session.tenantId).order("id");
  if (error) throw new Error(`[wms inv] ${error.message}`);
  return (data ?? []) as WarehouseRow[];
}

/** 商品的「主倉」：綁定該商品所屬倉儲型團購的倉庫 → 庫存最多的倉庫 → 第一個啟用中的倉庫 */
async function homeWarehouseId(session: AdminSession, item: ItemRow, whs: WarehouseRow[], stocks: StockRow[]): Promise<number | null> {
  const bound = whs.filter((w) => w.group_buy_id);
  if (bound.length) {
    const { data } = await db()
      .from("group_buy_item_sets")
      .select("group_buy_id")
      .eq("tenant_id", session.tenantId)
      .eq("item_set_id", item.item_set_id);
    const gbIds = new Set(((data ?? []) as AnyRow[]).map((r) => Number(r.group_buy_id)));
    const hit = bound.find((w) => gbIds.has(Number(w.group_buy_id)));
    if (hit) return Number(hit.id);
  }
  const withStock = [...stocks].sort((a, b) => Number(b.quantity) - Number(a.quantity) || Number(a.id) - Number(b.id))[0];
  if (withStock) return Number(withStock.warehouse_id);
  const first = whs.find((w) => w.is_active);
  return first ? Number(first.id) : null;
}

async function loadItemsById(session: AdminSession, ids: number[]): Promise<Map<number, ItemRow>> {
  const out = new Map<number, ItemRow>();
  if (!ids.length) return out;
  const { data, error } = await db()
    .from("items")
    .select("id, uid, title, item_set_id, stock, stock_available, stock_back_order, stock_back_order_available")
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[wms inv] ${error.message}`);
  for (const r of (data ?? []) as ItemRow[]) out.set(Number(r.id), r);
  return out;
}

interface Detail {
  item: ItemRow;
  homeWsId: number | null;
  rows: AnyRow[];
  sums: { stock: number; stockAvailable: number; stockBackOrder: number; stockBackOrderAvailable: number };
}

/**
 * 商品在各倉庫的明細（inventory.js 的 json 列）。ensure=true 時為所有啟用中倉庫補建 0 數量的庫存列（取得列 id）。
 * 可售數量分配：商品未出貨保留量（stock − stock_available）先由主倉、再由庫存多的倉庫承擔；預購數量只放在主倉列。
 */
async function productDetail(session: AdminSession, item: ItemRow, ensure: boolean): Promise<Detail> {
  const client = db();
  const whs = await activeWarehouses(session);
  const whById = new Map(whs.map((w) => [Number(w.id), w]));
  const fetchStocks = async () => {
    const { data, error } = await client.from("warehouse_stocks").select("id, warehouse_id, item_id, quantity, rack_bin").eq("tenant_id", session.tenantId).eq("item_id", item.id);
    if (error) throw new Error(`[wms inv] ${error.message}`);
    return (data ?? []) as StockRow[];
  };
  let stocks = await fetchStocks();
  const homeWh = await homeWarehouseId(session, item, whs, stocks);
  if (ensure) {
    const have = new Set(stocks.map((s) => Number(s.warehouse_id)));
    const missing = whs.filter((w) => (w.is_active || Number(w.id) === homeWh) && !have.has(Number(w.id)));
    if (missing.length) {
      await client
        .from("warehouse_stocks")
        .upsert(missing.map((w) => ({ tenant_id: session.tenantId, warehouse_id: w.id, item_id: item.id, quantity: 0 })), {
          onConflict: "warehouse_id,item_id",
          ignoreDuplicates: true,
        });
      stocks = await fetchStocks();
    }
  }
  stocks = stocks.filter((s) => whById.has(Number(s.warehouse_id)) && (whById.get(Number(s.warehouse_id))!.is_active || Number(s.quantity) !== 0 || Number(s.warehouse_id) === homeWh));
  const order = (s: StockRow) => (Number(s.warehouse_id) === homeWh ? 0 : 1);
  stocks.sort((a, b) => order(a) - order(b) || Number(a.warehouse_id) - Number(b.warehouse_id));

  // 可售分配
  let reserved = Math.max(0, Number(item.stock) - Number(item.stock_available));
  const alloc = new Map<number, number>();
  const byNeed = [...stocks].sort((a, b) => order(a) - order(b) || Number(b.quantity) - Number(a.quantity));
  for (const s of byNeed) {
    const take = Math.min(Math.max(Number(s.quantity), 0), reserved);
    alloc.set(Number(s.id), take);
    reserved -= take;
  }
  const homeWs = stocks.find((s) => Number(s.warehouse_id) === homeWh) ?? stocks[0];
  const rows = stocks.map((s) => {
    const w = whById.get(Number(s.warehouse_id));
    const isHome = homeWs && Number(s.id) === Number(homeWs.id);
    const quantity = Number(s.quantity);
    return {
      itemId: Number(s.id),
      warehouseStockId: Number(s.id),
      warehouseId: Number(s.warehouse_id),
      warehouseName: w ? w.short_name || w.name : "",
      productItemId: Number(item.id),
      uid: item.uid ?? "",
      title: item.title ?? "",
      rackBin: s.rack_bin ?? "",
      stock: quantity,
      stockAvailable: Math.max(quantity - (alloc.get(Number(s.id)) ?? 0), 0),
      stockBackOrder: isHome ? Number(item.stock_back_order) : 0,
      stockBackOrderAvailable: isHome ? Number(item.stock_back_order_available) : 0,
      home: !!isHome,
    };
  });
  const sums = rows.reduce(
    (acc, r) => ({
      stock: acc.stock + r.stock,
      stockAvailable: acc.stockAvailable + r.stockAvailable,
      stockBackOrder: acc.stockBackOrder + r.stockBackOrder,
      stockBackOrderAvailable: acc.stockBackOrderAvailable + r.stockBackOrderAvailable,
    }),
    { stock: 0, stockAvailable: 0, stockBackOrder: 0, stockBackOrderAvailable: 0 },
  );
  return { item, homeWsId: homeWs ? Number(homeWs.id) : null, rows, sums };
}

async function stockRowById(session: AdminSession, id: number | null): Promise<StockRow> {
  if (!id) throw badRequest("請選擇入庫的倉庫");
  const { data } = await db().from("warehouse_stocks").select("id, warehouse_id, item_id, quantity, rack_bin").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!data) throw badRequest("找不到倉庫庫存資料，請重新檢視庫存");
  return data as StockRow;
}

async function itemOf(session: AdminSession, itemId: number): Promise<ItemRow> {
  const m = await loadItemsById(session, [itemId]);
  const it = m.get(itemId);
  if (!it) throw badRequest("找不到商品");
  return it;
}

/* ───────────────────────── 盤點商品列（#invTableUpload） ───────────────────────── */

async function uploadRows(
  session: AdminSession,
  entries: { uid: string; stockCounting?: number | null; stockBackOrderCounting?: number | null }[],
): Promise<AnyRow[]> {
  const byUid = await warehouseItemsByUid(session, entries.map((e) => e.uid));
  const items = await loadItemsById(session, [...byUid.values()].map((w: WarehouseItemRow) => Number(w.item_id)));
  const cache = new Map<number, Detail>();
  const out: AnyRow[] = [];
  for (const e of entries) {
    const w = byUid.get(e.uid);
    const item = w ? items.get(Number(w.item_id)) : undefined;
    if (!item) {
      out.push({
        itemId: null,
        productItemId: null,
        uid: e.uid,
        title: null,
        stock: 0,
        stockAvailable: 0,
        stockBackOrder: 0,
        stockBackOrderAvailable: 0,
        stockCounting: e.stockCounting ?? 0,
        stockBackOrderCounting: e.stockBackOrderCounting ?? 0,
      });
      continue;
    }
    let d = cache.get(Number(item.id));
    if (!d) {
      d = await productDetail(session, item, true);
      cache.set(Number(item.id), d);
    }
    out.push({
      itemId: d.homeWsId,
      productItemId: Number(item.id),
      uid: item.uid ?? e.uid,
      title: item.title ?? "",
      ...d.sums,
      stockCounting: e.stockCounting ?? d.sums.stock,
      stockBackOrderCounting: e.stockBackOrderCounting ?? d.sums.stockBackOrder,
    });
  }
  return out;
}

/** GET loadItems?uid=a,b（加入）／POST Editor create（匯入檔案） */
async function loadItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  if (body.flat.get("action")?.[0]) {
    const req = await parseEditorRequest(ctx);
    if (req.action !== "create") throw badRequest("不支援的動作");
    const v = req.rows[0]?.values ?? {};
    const errors: { name: string; status: string }[] = [];
    const uploadKey = String(v.uploadFile ?? "");
    const uploadId = toInt(uploadKey.split("/")[0]);
    const uidCol = colIndex(v.uidCol);
    const stockCol = colIndex(v.stockCol);
    const boCol = v.stockBackOrderCol === undefined || v.stockBackOrderCol === "" ? null : colIndex(v.stockBackOrderCol);
    if (!uploadId) errors.push({ name: "uploadFile", status: "請先上傳庫存檔案" });
    if (uidCol === null) errors.push({ name: "uidCol", status: "需要選擇一個欄位" });
    if (stockCol === null) errors.push({ name: "stockCol", status: "需要選擇一個欄位" });
    if (errors.length) throw new FieldErrors(errors);
    const { data: up } = await db().from("wms_inventory_uploads").select("rows").eq("tenant_id", session.tenantId).eq("id", uploadId).maybeSingle();
    if (!up) throw new FieldErrors([{ name: "uploadFile", status: "上傳檔案已失效，請重新上傳" }]);
    const rows = ((up as AnyRow).rows ?? []) as string[][];
    const agg = new Map<string, { s: number; b: number | null }>();
    for (const r of rows) {
      const uid = String(r[uidCol as number] ?? "").trim();
      if (!uid) continue;
      const s = toNum(r[stockCol as number]) ?? 0;
      const b = boCol === null ? null : toNum(r[boCol]) ?? 0;
      const cur = agg.get(uid) ?? { s: 0, b: boCol === null ? null : 0 };
      cur.s += Math.round(s);
      if (b !== null) cur.b = (cur.b ?? 0) + Math.round(b);
      agg.set(uid, cur);
    }
    if (agg.size > MAX_ITEMS) throw new FieldErrors([{ name: "uploadFile", status: `上限${MAX_ITEMS}個商品` }]);
    const data = await uploadRows(session, [...agg.entries()].map(([uid, c]) => ({ uid, stockCounting: c.s, stockBackOrderCounting: c.b })));
    await db().from("wms_inventory_uploads").delete().eq("tenant_id", session.tenantId).eq("id", uploadId);
    return json({ data });
  }
  const uids = String((await ctx.param("uid")) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!uids.length) throw badRequest("請選擇商品");
  if (uids.length > MAX_ITEMS) throw badRequest(`上限${MAX_ITEMS}個商品`);
  return json({ data: await uploadRows(session, uids.map((uid) => ({ uid }))) });
}

/* ───────────────────────── 匯入檔案：上傳 ───────────────────────── */

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 欄位字母（A、B…AA）或 0 起算數字 → 0 起算欄位索引 */
function colIndex(v: unknown): number | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[A-Z]{1,3}$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as AnyRow;
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text ?? "");
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as AnyRow[]).map((t) => t.text).join("");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

async function parseSheet(file: File): Promise<string[][]> {
  const name = (file.name || "").toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("big5").decode(buf);
    text = text.replace(/^﻿/, "");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    return (parsed.data as string[][]).map((r) => r.map((c) => String(c ?? "").trim()));
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = row.values as unknown[];
      const arr: string[] = [];
      for (let c = 1; c < vals.length; c++) arr.push(cellText(vals[c]));
      rows.push(arr);
    });
    return rows;
  }
  throw badRequest("檔案格式不支援，請上傳 .xlsx 或 .csv");
}

async function uploadForLoadItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const file = body.files.get("upload")?.[0] ?? [...body.files.values()][0]?.[0];
  if (!file) return json({ fieldErrors: [{ name: "uploadFile", status: "請選擇檔案" }], data: [] });
  if (file.size > 4 * 1024 * 1024) return json({ fieldErrors: [{ name: "uploadFile", status: "檔案太大（上限 4MB）" }], data: [] });
  let rows: string[][];
  try {
    rows = await parseSheet(file);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ fieldErrors: [{ name: "uploadFile", status: msg.includes("格式") ? msg : "無法讀取檔案內容" }], data: [] });
  }
  if (rows.length < 2) return json({ fieldErrors: [{ name: "uploadFile", status: "EXCEL第一行須為標頭，且至少要有一筆資料" }], data: [] });
  const header = rows[0];
  const data = rows.slice(1, MAX_ITEMS + 1);
  if (rows.length - 1 > MAX_ITEMS) return json({ fieldErrors: [{ name: "uploadFile", status: `上限${MAX_ITEMS}個商品` }], data: [] });
  const client = db();
  // 清掉本帳號一天前的暫存
  await client.from("wms_inventory_uploads").delete().eq("tenant_id", session.tenantId).lt("created_at", new Date(Date.now() - 86400000).toISOString());
  const { data: saved, error } = await client
    .from("wms_inventory_uploads")
    .insert({ tenant_id: session.tenantId, admin_user_id: session.adminUserId, filename: file.name, header, rows: data })
    .select("id")
    .single();
  if (error || !saved) throw new Error(`[wms inv upload] ${error?.message}`);
  const id = `${(saved as AnyRow).id}/${file.name}`;
  const width = Math.max(header.length, ...data.slice(0, 50).map((r) => r.length));
  // 選項值用欄位字母（A、B…）：inventory.js 的 preSubmit 以 !field.val() 檢查必選，值不可為 0
  const options = Array.from({ length: width }, (_, i) => ({ label: `${colName(i)}: ${header[i] ?? ""}`, value: colName(i) }));
  return json({ upload: { id }, files: { files: { [id]: { filename: file.name, id } } }, data: options });
}

/* ───────────────────────── 倉庫明細／盤點動作 ───────────────────────── */

async function queryInv(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ws = await stockRowById(session, toInt(await ctx.param("itemId")));
  const d = await productDetail(session, await itemOf(session, Number(ws.item_id)), true);
  return json({ data: d.rows });
}

async function addStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const wsId = toInt(await ctx.param("itemId"));
  const inc = toInt(await ctx.param("stock"));
  const name = (await ctx.param("name")) === "stockBackOrder" ? "stockBackOrder" : "stock";
  if (inc === null) throw badRequest("請輸入盤點數量");
  const ws = await stockRowById(session, wsId);
  await rpc("wms_adjust_stock", {
    p_tenant_id: session.tenantId,
    p_warehouse_stock_id: Number(ws.id),
    p_change: inc,
    p_name: name,
    p_admin_user_id: session.adminUserId,
    p_actor: session.account,
  });
  const d = await productDetail(session, await itemOf(session, Number(ws.item_id)), false);
  return json({ data: d.rows });
}

async function archiveAndSync(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = idList(await ctx.param("itemId"));
  if (!ids.length) throw badRequest("請選擇要盤點的倉庫");
  await rpc("wms_archive_and_sync", {
    p_tenant_id: session.tenantId,
    p_warehouse_stock_ids: ids,
    p_admin_user_id: session.adminUserId,
    p_actor: session.account,
  });
  const { data } = await db().from("warehouse_stocks").select("item_id").eq("tenant_id", session.tenantId).in("id", ids);
  const itemIds = [...new Set(((data ?? []) as AnyRow[]).map((r) => Number(r.item_id)))];
  const items = await loadItemsById(session, itemIds);
  const out: AnyRow[] = [];
  for (const it of items.values()) {
    const d = await productDetail(session, it, false);
    out.push(...d.rows.filter((r) => ids.includes(Number(r.itemId))));
  }
  return json({ data: out });
}

async function familyIds(session: AdminSession, itemId: number): Promise<number[]> {
  const { data } = await db().from("items").select("id").eq("tenant_id", session.tenantId).or(`id.eq.${itemId},parent_item_id.eq.${itemId}`);
  return ((data ?? []) as AnyRow[]).map((r) => Number(r.id));
}

async function queryUnarchivedOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ws = await stockRowById(session, toInt(await ctx.param("itemId")));
  const backOrder = (await ctx.param("backOrder")) === "true";
  const fam = await familyIds(session, Number(ws.item_id));
  const { data, error } = await db()
    .from("order_items")
    .select("total, state, sales_order_id, sales_orders!inner(uuid, state, customer_firstname)")
    .eq("tenant_id", session.tenantId)
    .in("item_id", fam.length ? fam : [0])
    .in("state", ["UNSHIPPING", "SHIPPING", "SHIPPED"])
    .eq("back_order", backOrder)
    .limit(500);
  if (error) throw new Error(`[wms inv orders] ${error.message}`);
  const byOrder = new Map<string, { id: number; qty: number; states: Set<string>; orderState: string; name: string }>();
  for (const r of (data ?? []) as AnyRow[]) {
    const so = r.sales_orders as AnyRow;
    if (!so || ["DRAFT", "CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(so.state))) continue;
    const cur = byOrder.get(so.uuid) ?? { id: Number(r.sales_order_id), qty: 0, states: new Set<string>(), orderState: String(so.state), name: String(so.customer_firstname ?? "") };
    cur.qty += Number(r.total ?? 0);
    cur.states.add(String(r.state));
    byOrder.set(so.uuid, cur);
  }
  const out: { label: string; value: string }[] = [];
  for (const [uuid, o] of byOrder) {
    const labels: string[] = [];
    for (const s of o.states) labels.push(await enumLabel("OrderItem.state", s));
    const name = o.name ? `｜${o.name}` : "";
    // value＝訂單 id：inventory.js 以它呼叫 orders 模組的 /ajax/SalesOrder/cancelOrder（參數 salesOrderId）與 markArchived
    out.push({ label: `訂單 ${uuid}${name}｜${labels.join("/")}｜數量 ${o.qty}`, value: String(o.id) });
  }
  return json({ code: 200, data: out });
}

async function markArchived(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const salesOrderId = toInt(await ctx.param("salesOrderId"));
  const uuid = String((await ctx.param("uuid")) ?? "").trim();
  if (!salesOrderId && !uuid) throw badRequest("缺少訂單");
  const client = db();
  let soq = client.from("sales_orders").select("id").eq("tenant_id", session.tenantId);
  soq = salesOrderId ? soq.eq("id", salesOrderId) : soq.eq("uuid", uuid);
  const { data: so } = await soq.maybeSingle();
  if (!so) throw badRequest("找不到訂單");
  // 只標註倉儲商品（含共用庫存的子商品）
  const { data: ois } = await client
    .from("order_items")
    .select("id, item_id, items!inner(id, parent_item_id)")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", (so as AnyRow).id)
    .in("state", ["UNSHIPPING", "SHIPPING", "SHIPPED"]);
  const rows = (ois ?? []) as AnyRow[];
  const candidate = [...new Set(rows.flatMap((r) => [Number(r.item_id), Number((r.items as AnyRow)?.parent_item_id ?? 0)]).filter(Boolean))];
  const { data: wi } = await client.from("wms_warehouse_items_v").select("item_id").eq("tenant_id", session.tenantId).in("item_id", candidate.length ? candidate : [0]);
  const whItems = new Set(((wi ?? []) as AnyRow[]).map((r) => Number(r.item_id)));
  const ids = rows
    .filter((r) => whItems.has(Number(r.item_id)) || whItems.has(Number((r.items as AnyRow)?.parent_item_id ?? 0)))
    .map((r) => Number(r.id));
  if (!ids.length) throw badRequest("此訂單沒有可標註的倉儲商品");
  const { error } = await client.from("order_items").update({ state: "ARCHIVED" }).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[wms inv archive] ${error.message}`);
  return actionOk("已設為已盤點", { data: { archived: ids.length } });
}

/* ───────────────────────── select2／匯出／倉儲商品列表 ───────────────────────── */

async function lookup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const field = (await ctx.param("mDataProp_0")) === "title" ? "title" : "uid";
  const term = sanitizeLike(String((await ctx.param("sSearch_0")) ?? (await ctx.param("q")) ?? ""));
  let q = db().from("wms_warehouse_items_v").select("uid, title").eq("tenant_id", session.tenantId).not("uid", "is", null);
  if (term) q = q.or(`uid.ilike.*${term}*,title.ilike.*${term}*`);
  const { data, error } = await q.order(field).limit(200);
  if (error) throw new Error(`[wms inv lookup] ${error.message}`);
  const seen = new Set<string>();
  const results: { id: string; text: string }[] = [];
  for (const r of (data ?? []) as AnyRow[]) {
    const uid = String(r.uid ?? "");
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    results.push({ id: uid, text: field === "uid" ? `${uid} ${r.title ?? ""}`.trim() : `${r.title ?? ""}（${uid}）` });
    if (results.length >= 50) break;
  }
  return json(select2Json(results));
}

async function downloadInventory(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const uids = String((await ctx.param("uids")) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!uids.length) throw badRequest("沒有可匯出的商品");
  const rows = await uploadRows(session, uids.map((uid) => ({ uid })));
  const whs = await activeWarehouses(session);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("盤點");
  const headers = ["商品代碼", "名稱", "庫存數量", "預購庫存數量", "可售現貨", "可售預購", ...whs.map((w) => `倉庫:${w.short_name || w.name}`)];
  ws.addRow(headers);
  for (const r of rows) {
    const per = new Map<number, number>();
    if (r.productItemId) {
      const d = await productDetail(session, await itemOf(session, Number(r.productItemId)), false);
      for (const x of d.rows) per.set(Number(x.warehouseId), Number(x.stock));
    }
    ws.addRow([r.uid, r.title ?? "商品不存在", r.stock, r.stockBackOrder, r.stockAvailable, r.stockBackOrderAvailable, ...whs.map((w) => per.get(Number(w.id)) ?? 0)]);
  }
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = i === 1 ? 30 : 14));
  const buf = await wb.xlsx.writeBuffer();
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return download(new Uint8Array(buf as ArrayBuffer), `盤點_${stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function getWarehouseItems(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  return wmsList(ctx, {
    table: "wms_warehouse_items_v",
    columns: {
      title: { column: "title", kind: "text" },
      uid: { column: "uid", kind: "text" },
      stock: { column: "stock", kind: "int" },
      stockAvailable: { column: "stock_available", kind: "int" },
    },
    search: ["uid", "title"],
    defaultOrder: [{ column: "uid", ascending: true }],
    where(q, dt) {
      const itemId = toInt(dt.extra.itemId);
      const uid = (dt.extra.uid ?? "").trim();
      if (itemId) q = q.eq("item_id", itemId);
      if (uid) q = q.eq("uid", uid);
      return q;
    },
    mapRows: (rows) =>
      rows.map((r) => ({
        itemId: Number(r.item_id),
        uid: r.uid ?? "",
        title: r.title ?? "",
        stock: Number(r.stock),
        stockAvailable: Number(r.stock_available),
        stockBackOrder: Number(r.stock_back_order),
        stockBackOrderAvailable: Number(r.stock_back_order_available),
      })),
  });
}

export const inventoryRoutes: RouteDef[] = [
  page("/backend/Warehouse/inventory", {
    template: "warehouse/warehouse-inventory.html",
    title: "盤點",
    groupBuy: "none",
  }),
  get("/ajax/wms/WarehouseInventory/lookup", lookup),
  // 原站 inventory.js 以 $.get 呼叫的會改資料端點，已改為 $.post（public/scripts/inventory.js 修補，見 docs/modules/warehouse.md）
  post("/ajax/wms/WarehouseInventory/loadItems", loadItems),
  post("/ajax/wms/WarehouseInventory/uploadFileForLoadItems", uploadForLoadItems),
  get("/ajax/wms/WarehouseInventory/queryUnarchivedOrders", queryUnarchivedOrders),
  post("/ajax/wms/WarehouseInventory/markArchived", markArchived),
  post("/ajax/wms/WarehouseInventory/download", downloadInventory),
  post("/ajax/Item/queryInv", queryInv),
  post("/ajax/Item/addStock", addStock),
  post("/ajax/Item/archiveAndSync", archiveAndSync),
  any("/ajax/Item/getWarehouseItems", getWarehouseItems),
];
