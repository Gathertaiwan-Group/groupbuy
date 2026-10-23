// 入庫單（/backend/Inbound/list）：建立入庫單 → 調整商品（含由訂單匯入）→ 確認入庫（倉庫庫存＋商品庫存增加、寫入庫紀錄）。
// 原站：spec/html/inbound-list.html、spec/runtime/inbound-list.records.txt。
// 確認入庫在 DB 端交易函式 groupbuy.wms_receive_inbound（migration 4500）原子完成。
//   POST /ajax/wms/Inbound/list|save|update|delete
//   POST /ajax/wms/Inbound/received                               確認入庫
//   GET  /backend/Inbound/update?inboundId=&action=item|view      入庫商品（openFormF 片段，推導）
//   POST /ajax/wms/InboundItem/list|save|update|delete            入庫商品（Editor）
//   POST /ajax/wms/InboundItem/importItemsFromSalesOrder?inboundId= 由訂單匯入商品（Editor：salesOrderUUID）
//   GET  /ajax/wms/WarehouseItem/lookup                           倉儲商品 select2
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, fragment, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumLabel, enumOptionsFor } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";
import {
  type AnyRow,
  dateOnly,
  dateTime,
  db,
  formJson,
  loadItem,
  loadWarehouse,
  parseTaipei,
  requesterOptions,
  rpc,
  expectAction,
  select2Json,
  toInt,
  toNum,
  todayTaipei,
  warehouseJson,
  warehouseMap,
  type WarehouseRow,
  wmsList,
} from "./shared";

const STATUS = "Inbound.status";

interface InboundRow extends AnyRow {
  id: number;
  warehouse_id: number | null;
  status: string;
}

async function loadInbound(session: AdminSession, id: number | null): Promise<InboundRow> {
  if (!id) throw notFound("找不到入庫單");
  const { data, error } = await db()
    .from("inbounds")
    .select("*, inbound_items(*)")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[wms inbound] ${error.message}`);
  if (!data) throw notFound("找不到入庫單");
  return data as InboundRow;
}

function itemJson(i: AnyRow): AnyRow {
  const quantity = Number(i.quantity ?? 0);
  const unitPrice = Number(i.unit_price ?? 0);
  return {
    inboundItemId: Number(i.id),
    inboundId: Number(i.inbound_id),
    itemId: i.item_id == null ? null : Number(i.item_id),
    salesOrderId: i.sales_order_id == null ? null : Number(i.sales_order_id),
    uid: i.uid ?? "",
    title: i.title ?? "",
    quantity,
    unitPrice,
    subtotal: Math.round(quantity * unitPrice * 100) / 100,
    dateCreatedString: dateTime(i.created_at),
  };
}

function inboundJson(r: InboundRow, whs: Map<number, WarehouseRow>): AnyRow {
  const items = ((r.inbound_items ?? []) as AnyRow[]).sort((a, b) => Number(a.id) - Number(b.id)).map(itemJson);
  return {
    inboundId: Number(r.id),
    warehouseId: r.warehouse_id == null ? null : Number(r.warehouse_id),
    warehouse: warehouseJson(r.warehouse_id ? whs.get(Number(r.warehouse_id)) : null),
    dateRequiredString: dateOnly(r.date_required),
    status: r.status,
    requester: r.requester ?? "",
    note: r.note ?? "",
    dateReceivedString: dateTime(r.date_received),
    inboundItems: items,
    totalQuantity: items.reduce((s, i) => s + Number(i.quantity), 0),
    dateCreated: new Date(String(r.created_at)).getTime(),
    dateModified: new Date(String(r.updated_at)).getTime(),
    dateModifiedString: dateTime(r.updated_at),
  };
}

async function toJsonRows(session: AdminSession, rows: InboundRow[]): Promise<AnyRow[]> {
  const whs = await warehouseMap(session, rows.map((r) => r.warehouse_id));
  return rows.map((r) => inboundJson(r, whs));
}

/* ───────────────────────── 列表／CRUD ───────────────────────── */

async function listInbound(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  return wmsList(ctx, {
    table: "inbounds",
    select: "*, inbound_items(*)",
    columns: {
      dateRequiredString: { column: "date_required", kind: "date" },
      inboundId: { column: "id", kind: "int" },
      status: { column: "status", kind: "eq" },
      requester: { column: "requester", kind: "eq" },
      warehouseId: { column: "warehouse_id", kind: "int" },
    },
    search: ["note", "requester"],
    defaultOrder: [{ column: "date_required", ascending: false }],
    mapRows: (rows) => toJsonRows(session, rows as InboundRow[]),
    options: async () => ({ ...(await enumOptionsFor({ status: STATUS })), requester: await requesterOptions(session) }),
  });
}

/** POST /ajax/wms/Inbound/save：建立表單（data=<JSON>：dateRequiredString、warehouseId）或 Editor create */
async function saveInbound(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const isEditor = !!body.flat.get("action")?.[0];
  let v: AnyRow;
  if (isEditor) {
    const req = await parseEditorRequest(ctx);
    expectAction(req.action, "create");
    v = req.rows[0]?.values ?? {};
  } else v = await formJson(ctx);
  const errors: { name: string; status: string }[] = [];
  const iso = parseTaipei(v.dateRequiredString ?? todayTaipei());
  if (!iso) errors.push({ name: "dateRequiredString", status: "需要填寫內容" });
  const warehouseId = toInt(v.warehouseId);
  if (!warehouseId) errors.push({ name: "warehouseId", status: "請選擇入庫倉" });
  else {
    try {
      await loadWarehouse(session, warehouseId);
    } catch {
      errors.push({ name: "warehouseId", status: "找不到倉庫" });
    }
  }
  if (errors.length) {
    if (isEditor) throw new FieldErrors(errors);
    throw badRequest(errors.map((e) => e.status).join("；"));
  }
  const { data, error } = await db()
    .from("inbounds")
    .insert({
      tenant_id: session.tenantId,
      warehouse_id: warehouseId,
      date_required: iso,
      status: "OPEN",
      requester: session.account,
      note: v.note ? String(v.note).trim() : null,
    })
    .select("*, inbound_items(*)")
    .single();
  if (error || !data) throw new Error(`[wms inbound save] ${error?.message}`);
  const [row] = await toJsonRows(session, [data as InboundRow]);
  if (isEditor) return editorResponse([row]);
  return actionOk(`已建立入庫單 ${row.inboundId}`, { data: row });
}

async function updateInbound(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  expectAction(req.action, "edit");
  const ids = editorIds(req, "inboundId");
  const out: InboundRow[] = [];
  for (const id of ids) {
    const existing = await loadInbound(session, id);
    if (existing.status !== "OPEN") throw badRequest(`入庫單 ${id} 已入庫，不可編輯`);
    const v = req.rows.find((r) => Number(r.id) === id)?.values ?? {};
    const patch: AnyRow = {};
    if (v.dateRequiredString !== undefined) {
      const iso = parseTaipei(v.dateRequiredString);
      if (!iso) throw new FieldErrors([{ name: "dateRequiredString", status: "需要填寫內容" }]);
      patch.date_required = iso;
    }
    if (v.note !== undefined) patch.note = v.note === null ? null : String(v.note).trim();
    if (v.warehouseId !== undefined) {
      const w = toInt(v.warehouseId);
      if (!w) throw new FieldErrors([{ name: "warehouseId", status: "請選擇入庫倉" }]);
      await loadWarehouse(session, w);
      patch.warehouse_id = w;
    }
    if (Object.keys(patch).length) {
      const { error } = await db().from("inbounds").update(patch).eq("tenant_id", session.tenantId).eq("id", id).eq("status", "OPEN");
      if (error) throw new Error(`[wms inbound update] ${error.message}`);
    }
    out.push(await loadInbound(session, id));
  }
  return editorResponse(await toJsonRows(session, out));
}

async function removeInbound(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  expectAction(req.action, "remove");
  const ids = editorIds(req, "inboundId");
  for (const id of ids) {
    const r = await loadInbound(session, id);
    if (r.status !== "OPEN") throw badRequest(`入庫單 ${id} 已入庫，不可刪除（庫存已增加，請以盤點或調撥調整）`);
  }
  const { error } = await db().from("inbounds").delete().eq("tenant_id", session.tenantId).in("id", ids).eq("status", "OPEN");
  if (error) throw new Error(`[wms inbound delete] ${error.message}`);
  return editorResponse([]);
}

/** POST /ajax/wms/Inbound/received：確認入庫（交易函式） */
async function receiveInbound(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = toInt(await ctx.param("inboundId"));
  if (!id) throw badRequest("缺少入庫單");
  const res = await rpc<AnyRow>("wms_receive_inbound", {
    p_tenant_id: session.tenantId,
    p_inbound_id: id,
    p_admin_user_id: session.adminUserId,
    p_actor: session.account,
  });
  return actionOk(`已確認入庫：${res?.items ?? 0} 項商品，共 ${res?.quantity ?? 0} 件`, { data: res });
}

/* ───────────────────────── 入庫商品 ───────────────────────── */

async function itemRows(session: AdminSession, inboundId: number): Promise<AnyRow[]> {
  const { data, error } = await db()
    .from("inbound_items")
    .select("*")
    .eq("tenant_id", session.tenantId)
    .eq("inbound_id", inboundId)
    .order("id");
  if (error) throw new Error(`[wms inbound items] ${error.message}`);
  return ((data ?? []) as AnyRow[]).map(itemJson);
}

async function listItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const r = await loadInbound(session, toInt(await ctx.param("inboundId")));
  const rows = await itemRows(session, Number(r.id));
  return json({ data: rows, recordsTotal: rows.length, recordsFiltered: rows.length, dateModified: Date.now(), executionTime: 0, options: {} });
}

async function assertOpen(session: AdminSession, id: number | null): Promise<InboundRow> {
  const r = await loadInbound(session, id);
  if (r.status !== "OPEN") throw badRequest("入庫單已入庫，不可調整商品");
  return r;
}

async function addItem(session: AdminSession, r: InboundRow, itemId: number, qty: number, unitPrice: number | null, salesOrderId: number | null) {
  const item = await loadItem(session, itemId);
  const existing = ((r.inbound_items ?? []) as AnyRow[]).find(
    (i) => Number(i.item_id) === Number(item.id) && (i.sales_order_id ?? null) === (salesOrderId ?? null),
  );
  const client = db();
  if (existing) {
    const patch: AnyRow = { quantity: Number(existing.quantity) + qty };
    if (unitPrice !== null) patch.unit_price = unitPrice;
    const { error } = await client.from("inbound_items").update(patch).eq("tenant_id", session.tenantId).eq("id", existing.id);
    if (error) throw new Error(`[wms inbound item] ${error.message}`);
    existing.quantity = patch.quantity;
  } else {
    const { data, error } = await client
      .from("inbound_items")
      .insert({
        tenant_id: session.tenantId,
        inbound_id: r.id,
        item_id: item.id,
        sales_order_id: salesOrderId,
        uid: item.uid,
        title: item.title,
        quantity: qty,
        unit_price: unitPrice ?? Number(item.cprice ?? 0),
      })
      .select("*")
      .single();
    if (error) throw new Error(`[wms inbound item] ${error.message}`);
    (r.inbound_items as AnyRow[] | undefined)?.push(data as AnyRow);
  }
}

function writeItemsFor(expected: "create" | "edit" | "remove") {
  return async (ctx: RequestContext): Promise<Response> => {
    const req = await parseEditorRequest(ctx);
    expectAction(req.action, expected);
    return writeItems(ctx);
  };
}

async function writeItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const client = db();
  if (req.action === "create") {
    const r = await assertOpen(session, toInt(req.extra.inboundId ?? (await ctx.param("inboundId"))));
    r.inbound_items = r.inbound_items ?? [];
    for (const row of req.rows) {
      const v = row.values;
      const errors: { name: string; status: string }[] = [];
      const itemId = toInt(v.itemId);
      const qty = toInt(v.quantity);
      const price = v.unitPrice === undefined || v.unitPrice === "" ? null : toNum(v.unitPrice);
      if (!itemId) errors.push({ name: "itemId", status: "請選擇商品" });
      if (qty === null || qty <= 0) errors.push({ name: "quantity", status: "數量需大於 0" });
      if (v.unitPrice !== undefined && v.unitPrice !== "" && (price === null || price < 0)) errors.push({ name: "unitPrice", status: "請輸入 0 以上的數字" });
      if (errors.length) throw new FieldErrors(errors);
      await addItem(session, r, itemId as number, qty as number, price, null);
    }
    return editorResponse(await itemRows(session, Number(r.id)));
  }
  const ids = editorIds(req, "inboundItemId");
  const { data: found } = await client.from("inbound_items").select("*").eq("tenant_id", session.tenantId).in("id", ids);
  const rows = (found ?? []) as AnyRow[];
  if (rows.length !== ids.length) throw notFound("找不到入庫商品");
  const parents = [...new Set(rows.map((x) => Number(x.inbound_id)))];
  for (const p of parents) await assertOpen(session, p);
  if (req.action === "remove") {
    const { error } = await client.from("inbound_items").delete().eq("tenant_id", session.tenantId).in("id", ids);
    if (error) throw new Error(`[wms inbound item delete] ${error.message}`);
    return editorResponse([]);
  }
  for (const row of req.rows) {
    const v = row.values;
    const patch: AnyRow = {};
    const errors: { name: string; status: string }[] = [];
    if (v.quantity !== undefined) {
      const q = toInt(v.quantity);
      if (q === null || q <= 0) errors.push({ name: "quantity", status: "數量需大於 0" });
      else patch.quantity = q;
    }
    if (v.unitPrice !== undefined) {
      const p = toNum(v.unitPrice);
      if (p === null || p < 0) errors.push({ name: "unitPrice", status: "請輸入 0 以上的數字" });
      else patch.unit_price = p;
    }
    if (errors.length) throw new FieldErrors(errors);
    if (Object.keys(patch).length) {
      const { error } = await client.from("inbound_items").update(patch).eq("tenant_id", session.tenantId).eq("id", Number(row.id));
      if (error) throw new Error(`[wms inbound item update] ${error.message}`);
    }
  }
  const out: AnyRow[] = [];
  for (const p of parents) out.push(...(await itemRows(session, p)).filter((x) => ids.includes(Number(x.inboundItemId))));
  return editorResponse(out);
}

/** 由訂單匯入商品：Editor create（salesOrderUUID＝訂單編號）；訂單商品依商品合併數量加入本入庫單 */
async function importFromSalesOrder(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  expectAction(req.action, "create");
  const inboundId = toInt(req.extra.inboundId ?? (await ctx.param("inboundId")));
  const r = await assertOpen(session, inboundId);
  r.inbound_items = r.inbound_items ?? [];
  const uuid = String(req.rows[0]?.values.salesOrderUUID ?? "").trim();
  if (!uuid) throw new FieldErrors([{ name: "salesOrderUUID", status: "需要填寫內容" }]);
  const client = db();
  const { data: so } = await client.from("sales_orders").select("id, uuid").eq("tenant_id", session.tenantId).eq("uuid", uuid).maybeSingle();
  if (!so) throw new FieldErrors([{ name: "salesOrderUUID", status: "找不到此訂單" }]);
  const { data: ois } = await client
    .from("order_items")
    .select("item_id, total, cprice, bundle_root")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", (so as AnyRow).id)
    .not("item_id", "is", null);
  const qty = new Map<number, { q: number; cost: number }>();
  for (const oi of (ois ?? []) as AnyRow[]) {
    if (oi.bundle_root) continue;
    const k = Number(oi.item_id);
    const cur = qty.get(k) ?? { q: 0, cost: Number(oi.cprice ?? 0) };
    cur.q += Number(oi.total ?? 0);
    qty.set(k, cur);
  }
  if (!qty.size) throw new FieldErrors([{ name: "salesOrderUUID", status: "此訂單沒有可匯入的商品" }]);
  for (const [itemId, { q, cost }] of qty) {
    if (q > 0) await addItem(session, r, itemId, q, cost, Number((so as AnyRow).id));
  }
  return editorResponse(await itemRows(session, Number(r.id)));
}

/** GET /ajax/wms/WarehouseItem/lookup：倉儲商品 select2（id=itemId） */
async function lookupWarehouseItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const client = db();
  if (p.initialValue) {
    const { data } = await client.from("items").select("id, uid, title").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    const rows = ((data ?? []) as AnyRow[]).map((r) => ({ id: r.id, text: `${r.uid ?? ""} ${r.title ?? ""}`.trim() }));
    return json(rows.length === 1 ? rows[0] : rows);
  }
  let q = client.from("wms_warehouse_items_v").select("item_id, uid, title, stock").eq("tenant_id", session.tenantId);
  const term = sanitizeLike(p.term);
  if (term) q = q.or(`uid.ilike.*${term}*,title.ilike.*${term}*`);
  const from = (p.page - 1) * 30;
  const { data, error } = await q.order("uid").range(from, from + 30);
  if (error) throw new Error(`[wms item lookup] ${error.message}`);
  const rows = (data ?? []) as AnyRow[];
  return json(select2Json(rows.slice(0, 30).map((r) => ({ id: r.item_id, text: `${r.uid ?? ""} ${r.title ?? ""}`.trim() })), rows.length > 30));
}

async function updateFragmentData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const r = await loadInbound(session, toInt(await ctx.param("inboundId")));
  const [row] = await toJsonRows(session, [r]);
  let action = (await ctx.param("action")) ?? "view";
  if (action !== "item" || row.status !== "OPEN") action = "view";
  return {
    inbound: row,
    action,
    isItem: action === "item",
    actionTitle: action === "item" ? "調整商品" : "檢視",
    statusLabel: await enumLabel(STATUS, String(row.status)),
  };
}

export const inboundRoutes: RouteDef[] = [
  page("/backend/Inbound/list", {
    template: "warehouse/inbound-list.html",
    title: "入庫單",
    groupBuy: "none",
  }),
  any("/ajax/wms/Inbound/list", listInbound),
  post("/ajax/wms/Inbound/save", saveInbound),
  post("/ajax/wms/Inbound/update", updateInbound),
  post("/ajax/wms/Inbound/delete", removeInbound),
  post("/ajax/wms/Inbound/received", receiveInbound),
  fragment("/backend/Inbound/update", {
    template: "warehouse/inbound-update.html",
    method: "GET",
    data: updateFragmentData,
  }),
  any("/ajax/wms/InboundItem/list", listItems),
  post("/ajax/wms/InboundItem/save", writeItemsFor("create")),
  post("/ajax/wms/InboundItem/update", writeItemsFor("edit")),
  post("/ajax/wms/InboundItem/delete", writeItemsFor("remove")),
  post("/ajax/wms/InboundItem/importItemsFromSalesOrder", importFromSalesOrder),
  any("/ajax/wms/WarehouseItem/lookup", lookupWarehouseItem),
];
