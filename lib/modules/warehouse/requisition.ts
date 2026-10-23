// 調撥單據（/backend/WarehouseRequisition/list）：建立 → 調整商品 → 送出審核 → 審核(批准/駁回) → 轉移庫存 → 收貨；已收到可逆向調撥。
// 原站：spec/html/warehouserequisition-list.html、spec/runtime/warehouserequisition-list.records.txt。
// 庫存移轉在 DB 端交易函式 groupbuy.wms_transfer_requisition（migration 4500）原子完成並寫入庫存異動帳。
//   POST /ajax/wms/WarehouseRequisition/list|save|update|delete
//   POST /ajax/wms/WarehouseRequisition/{submit|review|approve|reject|cancel|transfer|received|reverse}
//   GET  /backend/WarehouseRequisition/update?warehouseRequisitionId=&action=   調撥商品／審核／轉移／收貨／檢視（openFormF 片段，推導）
//   POST /ajax/wms/WarehouseRequisitionItem/list|save|update|delete              調撥商品（Editor）
//   GET  /ajax/wms/WarehouseStock/lookup?warehouseId=                            來源倉商品 select2
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, fragment, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumLabel, enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";
import {
  type AnyRow,
  dateOnly,
  dateTime,
  db,
  formJson,
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

const ST = "WarehouseRequisition.requisitionStatus";
const TS = "WarehouseRequisition.transferStatus";
const TYPE = "WarehouseRequisition.type";
const LOGI = "WarehouseRequisition.logisticType";

/* ───────────────────────── 讀取／轉換 ───────────────────────── */

interface ReqRow extends AnyRow {
  id: number;
  from_warehouse_id: number | null;
  to_warehouse_id: number | null;
  requisition_status: string;
  transfer_status: string;
}

async function loadReq(session: AdminSession, id: number | null): Promise<ReqRow> {
  if (!id) throw notFound("找不到調撥單");
  const { data, error } = await db()
    .from("warehouse_requisitions")
    .select("*, warehouse_requisition_items(*)")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[wms req] ${error.message}`);
  if (!data) throw notFound("找不到調撥單");
  return data as ReqRow;
}

function itemJson(i: AnyRow): AnyRow {
  const quantity = Number(i.quantity ?? 0);
  const transferred = Number(i.transferred_quantity ?? 0);
  return {
    warehouseRequisitionItemId: Number(i.id),
    warehouseRequisitionId: Number(i.warehouse_requisition_id),
    itemId: i.item_id == null ? null : Number(i.item_id),
    uid: i.uid ?? "",
    title: i.title ?? "",
    quantity,
    transferredQuantity: transferred,
    remainingQuantity: Math.max(quantity - transferred, 0),
    totalRequired: quantity,
    totalTransferred: transferred,
    cost: Number(i.cost ?? 0),
    dateCreatedString: dateTime(i.created_at),
  };
}

function reqJson(r: ReqRow, whs: Map<number, WarehouseRow>): AnyRow {
  const items = ((r.warehouse_requisition_items ?? []) as AnyRow[]).sort((a, b) => Number(a.id) - Number(b.id)).map(itemJson);
  const st = r.requisition_status;
  const ts = r.transfer_status;
  return {
    warehouseRequisitionId: Number(r.id),
    fromWarehouseId: r.from_warehouse_id == null ? null : Number(r.from_warehouse_id),
    toWarehouseId: r.to_warehouse_id == null ? null : Number(r.to_warehouse_id),
    fromWarehouse: warehouseJson(r.from_warehouse_id ? whs.get(Number(r.from_warehouse_id)) : null),
    toWarehouse: warehouseJson(r.to_warehouse_id ? whs.get(Number(r.to_warehouse_id)) : null),
    dateRequiredString: dateOnly(r.date_required),
    dateConfirmedString: dateOnly(r.date_confirmed),
    dateTransferredString: dateOnly(r.date_transferred),
    type: r.type,
    totalAmount: Number(r.total_amount ?? 0),
    totalCost: Number(r.total_cost ?? 0),
    note: r.note ?? "",
    fromName: r.from_name ?? "",
    fromTelephone: r.from_telephone ?? "",
    fromAddress: r.from_address ?? "",
    toName: r.to_name ?? "",
    toTelephone: r.to_telephone ?? "",
    toAddress: r.to_address ?? "",
    logisticType: r.logistic_type,
    requisitionStatus: st,
    transferStatus: ts,
    approver: r.approver ?? "",
    requester: r.requester ?? "",
    adminUserId: r.admin_user_id ?? null,
    warehouseRequisitionItems: items,
    transferable: (st === "APPROVED" || st === "TRANSFERRING") && ts !== "COMPLETED",
    receivable: st === "TRANSFERRING" && ts === "COMPLETED",
    sourceRequisitionId: r.source_requisition_id == null ? null : Number(r.source_requisition_id),
    dateCreated: new Date(String(r.created_at)).getTime(),
    dateModified: new Date(String(r.updated_at)).getTime(),
    dateModifiedString: dateTime(r.updated_at),
  };
}

async function toJsonRows(session: AdminSession, rows: ReqRow[]): Promise<AnyRow[]> {
  const whs = await warehouseMap(session, rows.flatMap((r) => [r.from_warehouse_id, r.to_warehouse_id]));
  return rows.map((r) => reqJson(r, whs));
}

async function listOptions(session: AdminSession) {
  return {
    ...(await enumOptionsFor({ requisitionStatus: ST, transferStatus: TS, type: TYPE, logisticType: LOGI })),
    requester: await requesterOptions(session),
  };
}

/* ───────────────────────── 列表 ───────────────────────── */

async function listReq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  return wmsList(ctx, {
    table: "warehouse_requisitions",
    select: "*, warehouse_requisition_items(*)",
    columns: {
      dateRequiredString: { column: "date_required", kind: "date" },
      warehouseRequisitionId: { column: "id", kind: "int" },
      requisitionStatus: { column: "requisition_status", kind: "eq" },
      transferStatus: { column: "transfer_status", kind: "eq" },
      type: { column: "type", kind: "eq" },
      requester: { column: "requester", kind: "eq" },
      fromWarehouseId: { column: "from_warehouse_id", kind: "int" },
      toWarehouseId: { column: "to_warehouse_id", kind: "int" },
      warehouseRequisitionItem: { column: "total_amount", kind: "int" },
    },
    search: ["note", "requester", "from_name", "to_name"],
    defaultOrder: [{ column: "date_required", ascending: false }],
    async prepare(dt) {
      const uid = (dt.extra.itemUid ?? "").trim();
      if (!uid) return {};
      const { data } = await db()
        .from("warehouse_requisition_items")
        .select("warehouse_requisition_id")
        .eq("tenant_id", session.tenantId)
        .eq("uid", uid)
        .limit(1000);
      return { reqIds: [...new Set(((data ?? []) as AnyRow[]).map((r) => Number(r.warehouse_requisition_id)))] };
    },
    where(q, dt, prep) {
      const from = toInt(dt.extra.filter_fromWarehouseId);
      const to = toInt(dt.extra.filter_toWarehouseId);
      if (from) q = q.eq("from_warehouse_id", from);
      if (to) q = q.eq("to_warehouse_id", to);
      if (prep.reqIds) q = q.in("id", (prep.reqIds as number[]).length ? prep.reqIds : [0]);
      return q;
    },
    mapRows: (rows) => toJsonRows(session, rows as ReqRow[]),
    options: () => listOptions(session),
  });
}

/* ───────────────────────── 新增／編輯／刪除 ───────────────────────── */

const HEADER_FIELDS: Record<string, string> = {
  type: "type",
  note: "note",
  fromName: "from_name",
  fromTelephone: "from_telephone",
  fromAddress: "from_address",
  toName: "to_name",
  toTelephone: "to_telephone",
  toAddress: "to_address",
  logisticType: "logistic_type",
};

async function headerPatch(session: AdminSession, v: AnyRow, action: "create" | "edit", existing?: ReqRow): Promise<AnyRow> {
  const errors: { name: string; status: string }[] = [];
  const row: AnyRow = {};
  for (const [k, col] of Object.entries(HEADER_FIELDS)) {
    if (v[k] === undefined) continue;
    row[col] = v[k] === null ? null : String(v[k]).trim();
  }
  if (action === "create" || v.type !== undefined) {
    const allowed = (await enumOptions(TYPE)).map((o) => String(o.value));
    if (!allowed.includes(String(row.type ?? (action === "create" ? "REPLENISHMENT" : "")))) errors.push({ name: "type", status: "請選擇調撥類型" });
    if (action === "create" && !row.type) row.type = "REPLENISHMENT";
  }
  if (action === "create" || v.logisticType !== undefined) {
    const allowed = (await enumOptions(LOGI)).map((o) => String(o.value));
    if (action === "create" && !row.logistic_type) row.logistic_type = "TRUCKING";
    if (!allowed.includes(String(row.logistic_type))) errors.push({ name: "logisticType", status: "請選擇物流方式" });
  }
  if (action === "create" || v.dateRequiredString !== undefined) {
    const iso = parseTaipei(v.dateRequiredString ?? (action === "create" ? todayTaipei() : ""));
    if (!iso) errors.push({ name: "dateRequiredString", status: "需要填寫內容" });
    else row.date_required = iso;
  }
  for (const [k, col] of [["fromWarehouseId", "from_warehouse_id"], ["toWarehouseId", "to_warehouse_id"]] as const) {
    if (action === "create" || v[k] !== undefined) {
      const id = toInt(v[k]);
      if (!id) {
        errors.push({ name: k, status: "請選擇(必填)" });
        continue;
      }
      try {
        await loadWarehouse(session, id);
        row[col] = id;
      } catch {
        errors.push({ name: k, status: "找不到倉庫" });
      }
    }
  }
  const from = row.from_warehouse_id ?? existing?.from_warehouse_id;
  const to = row.to_warehouse_id ?? existing?.to_warehouse_id;
  if (from && to && Number(from) === Number(to)) errors.push({ name: "toWarehouseId", status: "來源倉與目標倉不可相同" });
  if (errors.length) throw new FieldErrors(errors);
  return row;
}

/** POST /ajax/wms/WarehouseRequisition/save：Editor create 或建立表單（data=<JSON>） */
async function saveReq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const isEditor = !!body.flat.get("action")?.[0];
  let values: AnyRow;
  if (isEditor) {
    const req = await parseEditorRequest(ctx);
    expectAction(req.action, "create");
    values = req.rows[0]?.values ?? {};
  } else values = await formJson(ctx);
  let patch: AnyRow;
  try {
    patch = await headerPatch(session, values, "create");
  } catch (e) {
    if (!isEditor && e instanceof FieldErrors) throw badRequest(e.fieldErrors.map((f) => f.status).join("；"));
    throw e;
  }
  const insert = {
    ...patch,
    tenant_id: session.tenantId,
    requisition_status: "OPEN",
    transfer_status: "NOT_TRANSFERRED",
    requester: session.account,
    admin_user_id: session.adminUserId,
  };
  const { data, error } = await db().from("warehouse_requisitions").insert(insert).select("*, warehouse_requisition_items(*)").single();
  if (error || !data) throw new Error(`[wms req save] ${error?.message}`);
  const [row] = await toJsonRows(session, [data as ReqRow]);
  if (isEditor) return editorResponse([row]);
  return actionOk(`已新增調撥單 ${row.warehouseRequisitionId}`, { data: row });
}

async function updateReq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  expectAction(req.action, "edit");
  const ids = editorIds(req, "warehouseRequisitionId");
  const out: ReqRow[] = [];
  for (const id of ids) {
    const existing = await loadReq(session, id);
    if (!["OPEN", "PENDING", "REJECTED"].includes(existing.requisition_status)) {
      throw badRequest(`調撥單 ${id} 目前狀態不可編輯`);
    }
    const values = req.rows.find((r) => Number(r.id) === id)?.values ?? {};
    const patch = await headerPatch(session, values, "edit", existing);
    if (Object.keys(patch).length) {
      const { error } = await db().from("warehouse_requisitions").update(patch).eq("tenant_id", session.tenantId).eq("id", id);
      if (error) throw new Error(`[wms req update] ${error.message}`);
    }
    out.push(await loadReq(session, id));
  }
  return editorResponse(await toJsonRows(session, out));
}

async function removeReq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  expectAction(req.action, "remove");
  const ids = editorIds(req, "warehouseRequisitionId");
  for (const id of ids) {
    const r = await loadReq(session, id);
    const moved = ((r.warehouse_requisition_items ?? []) as AnyRow[]).some((i) => Number(i.transferred_quantity) > 0);
    if (moved || r.requisition_status === "TRANSFERRING" || r.requisition_status === "RECEIVED") {
      throw badRequest(`調撥單 ${id} 已轉移庫存，不可刪除`);
    }
  }
  // 條件式刪除：檢查後到刪除前若有人完成轉移（狀態已變調撥中/已收到），該筆不會被刪
  const { data: deleted, error } = await db()
    .from("warehouse_requisitions")
    .delete()
    .eq("tenant_id", session.tenantId)
    .in("id", ids)
    .not("requisition_status", "in", "(TRANSFERRING,RECEIVED)")
    .select("id");
  if (error) throw new Error(`[wms req delete] ${error.message}`);
  if ((deleted ?? []).length !== ids.length) throw badRequest("部分調撥單已轉移庫存，未刪除");
  return editorResponse([]);
}

/* ───────────────────────── 流程動作 ───────────────────────── */

async function setStatus(
  session: AdminSession,
  id: number,
  from: string[],
  patch: AnyRow,
  failMsg: string,
  transferStatus?: string,
): Promise<void> {
  let q = db()
    .from("warehouse_requisitions")
    .update(patch)
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .in("requisition_status", from);
  if (transferStatus) q = q.eq("transfer_status", transferStatus);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`[wms req status] ${error.message}`);
  if (!data || data.length === 0) throw badRequest(failMsg);
}

function actionHandler(action: string) {
  return async (ctx: RequestContext): Promise<Response> => {
    const session = requireSession(ctx);
    const id = toInt(await ctx.param("warehouseRequisitionId"));
    const r = await loadReq(session, id);
    const reqId = Number(r.id);
    const items = (r.warehouse_requisition_items ?? []) as AnyRow[];
    switch (action) {
      case "submit": {
        if (!items.length) throw badRequest("請先加入調撥商品");
        if (items.some((i) => Number(i.quantity) <= 0 || !i.item_id)) throw badRequest("調撥商品數量需大於 0");
        if (!r.from_warehouse_id || !r.to_warehouse_id) throw badRequest("請設定來源倉與目標倉");
        await setStatus(session, reqId, ["OPEN", "REJECTED"], { requisition_status: "PENDING" }, "只有新申請的調撥單可以送出審核");
        return actionOk("已送出審核");
      }
      case "approve":
        await setStatus(session, reqId, ["PENDING"], { requisition_status: "APPROVED", approver: session.account, date_confirmed: new Date().toISOString() }, "只有審核中的調撥單可以批准");
        return actionOk("已批准");
      case "reject":
        await setStatus(session, reqId, ["PENDING"], { requisition_status: "REJECTED", approver: session.account, date_confirmed: new Date().toISOString() }, "只有審核中的調撥單可以駁回");
        return actionOk("已駁回");
      case "cancel": {
        if (items.some((i) => Number(i.transferred_quantity) > 0)) throw badRequest("已轉移庫存的調撥單不可取消");
        await setStatus(session, reqId, ["OPEN", "PENDING", "APPROVED", "REJECTED"], { requisition_status: "CANCELLED" }, "此調撥單目前狀態不可取消");
        return actionOk("已取消調撥單");
      }
      case "transfer": {
        const body = await ctx.body();
        // quantities[<明細id>]＝本次轉移數量；expected[<明細id>]＝畫面上的已調撥數量（DB 比對，重送/他人已轉移 → 拒絕）
        const intMap = (v: unknown, label: string): Record<string, number> | null => {
          if (!v || typeof v !== "object" || Array.isArray(v)) return null;
          const out: Record<string, number> = {};
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            const n = toInt(x);
            if (n === null || n < 0) throw badRequest(`${label}需為 0 以上的整數`);
            out[k] = n;
          }
          return out;
        };
        const quantities = intMap(body.nested.quantities, "轉移數量");
        const expected = intMap(body.nested.expected, "已調撥數量");
        const res = await rpc<AnyRow>("wms_transfer_requisition", {
          p_tenant_id: session.tenantId,
          p_requisition_id: reqId,
          p_quantities: quantities,
          p_expected: expected ?? (quantities ? null : Object.fromEntries(items.map((i) => [String(i.id), Number(i.transferred_quantity)]))),
          p_admin_user_id: session.adminUserId,
          p_actor: session.account,
        });
        const label = await enumLabel(TS, String(res?.transferStatus ?? ""));
        return actionOk(`已轉移庫存 ${res?.moved ?? 0} 件（${label}）`, { data: res });
      }
      case "received":
        // 條件式更新（同一敘述）：只有「調撥中＋已完成調撥」可以收貨
        await setStatus(session, reqId, ["TRANSFERRING"], { requisition_status: "RECEIVED" }, "調撥尚未完成，無法收貨", "COMPLETED");
        return actionOk("已收貨");
      default:
        throw badRequest("不支援的動作");
    }
  };
}

/** POST /ajax/wms/WarehouseRequisition/reverse（Editor create：warehouseRequisitionId、dateRequiredString） */
async function reverseReq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  let values: AnyRow = {};
  if (body.flat.get("action")?.[0]) {
    const req = await parseEditorRequest(ctx);
    expectAction(req.action, "create");
    values = req.rows[0]?.values ?? {};
  }
  const id = toInt(values.warehouseRequisitionId ?? (await ctx.param("warehouseRequisitionId")));
  const iso = parseTaipei(values.dateRequiredString ?? (await ctx.param("dateRequiredString")) ?? todayTaipei());
  if (!iso) throw new FieldErrors([{ name: "dateRequiredString", status: "需要填寫內容" }]);
  if (!id) throw badRequest("缺少調撥單");
  const newId = await rpc<number>("wms_reverse_requisition", {
    p_tenant_id: session.tenantId,
    p_requisition_id: id,
    p_date_required: iso,
    p_admin_user_id: session.adminUserId,
    p_actor: session.account,
  });
  const row = await loadReq(session, Number(newId));
  return editorResponse(await toJsonRows(session, [row]));
}

/* ───────────────────────── 調撥商品 ───────────────────────── */

async function stockMap(session: AdminSession, warehouseId: number | null, itemIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!warehouseId || !itemIds.length) return out;
  const { data } = await db()
    .from("warehouse_stocks")
    .select("item_id, quantity")
    .eq("tenant_id", session.tenantId)
    .eq("warehouse_id", warehouseId)
    .in("item_id", itemIds);
  for (const s of (data ?? []) as AnyRow[]) out.set(Number(s.item_id), Number(s.quantity));
  return out;
}

async function itemRows(session: AdminSession, r: ReqRow): Promise<AnyRow[]> {
  const items = ((r.warehouse_requisition_items ?? []) as AnyRow[]).sort((a, b) => Number(a.id) - Number(b.id));
  const ids = items.map((i) => Number(i.item_id)).filter(Boolean);
  const fromStock = await stockMap(session, r.from_warehouse_id, ids);
  const toStock = await stockMap(session, r.to_warehouse_id, ids);
  return items.map((i) => ({
    ...itemJson(i),
    fromStock: fromStock.get(Number(i.item_id)) ?? 0,
    toStock: toStock.get(Number(i.item_id)) ?? 0,
  }));
}

async function listItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const r = await loadReq(session, toInt(await ctx.param("warehouseRequisitionId")));
  const rows = await itemRows(session, r);
  return json({ data: rows, recordsTotal: rows.length, recordsFiltered: rows.length, dateModified: Date.now(), executionTime: 0, options: {} });
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
  const reqId = toInt(req.extra.warehouseRequisitionId ?? (await ctx.param("warehouseRequisitionId")));

  // 寫入一律走 DB 函式（鎖定調撥單、限新申請/駁回、重算總數量與成本），不會寫進已送審/已轉移的單
  if (req.action === "create") {
    const r = await loadReq(session, reqId);
    for (const row of req.rows) {
      const v = row.values;
      const errors: { name: string; status: string }[] = [];
      const itemId = toInt(v.itemId);
      const qty = toInt(v.quantity);
      if (!itemId) errors.push({ name: "itemId", status: "請選擇商品" });
      if (qty === null || qty <= 0) errors.push({ name: "quantity", status: "數量需大於 0" });
      const costIn = v.cost === undefined || v.cost === "" ? null : toNum(v.cost);
      if (v.cost !== undefined && v.cost !== "" && (costIn === null || costIn < 0)) errors.push({ name: "cost", status: "請輸入 0 以上的數字" });
      if (errors.length) throw new FieldErrors(errors);
      await rpc("wms_req_item_add", { p_tenant_id: session.tenantId, p_requisition_id: Number(r.id), p_item_id: itemId, p_quantity: qty, p_cost: costIn });
    }
    return editorResponse(await itemRows(session, await loadReq(session, Number(r.id))));
  }

  const ids = editorIds(req, "warehouseRequisitionItemId");
  const { data: rows } = await client.from("warehouse_requisition_items").select("id, warehouse_requisition_id").eq("tenant_id", session.tenantId).in("id", ids);
  const found = (rows ?? []) as AnyRow[];
  if (found.length !== ids.length) throw notFound("找不到調撥商品");
  const parentIds = [...new Set(found.map((x) => Number(x.warehouse_requisition_id)))];

  if (req.action === "remove") {
    await rpc("wms_req_item_delete", { p_tenant_id: session.tenantId, p_ids: ids });
    return editorResponse([]);
  }

  for (const row of req.rows) {
    const id = Number(row.id);
    const v = row.values;
    const errors: { name: string; status: string }[] = [];
    let quantity: number | null = null;
    let cost: number | null = null;
    if (v.quantity !== undefined) {
      quantity = toInt(v.quantity);
      if (quantity === null || quantity <= 0) errors.push({ name: "quantity", status: "數量需大於 0" });
    }
    if (v.cost !== undefined) {
      cost = toNum(v.cost);
      if (cost === null || cost < 0) errors.push({ name: "cost", status: "請輸入 0 以上的數字" });
    }
    if (errors.length) throw new FieldErrors(errors);
    if (quantity !== null || cost !== null) {
      await rpc("wms_req_item_set", { p_tenant_id: session.tenantId, p_row_id: id, p_quantity: quantity, p_cost: cost });
    }
  }
  const out: AnyRow[] = [];
  for (const pid of parentIds) {
    const all = await itemRows(session, await loadReq(session, pid));
    out.push(...all.filter((x) => ids.includes(Number(x.warehouseRequisitionItemId))));
  }
  return editorResponse(out);
}

/** GET /ajax/wms/WarehouseStock/lookup?warehouseId=：倉庫內有庫存的商品（select2） */
async function lookupStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const warehouseId = toInt(await ctx.param("warehouseId"));
  const p = await select2Params(ctx);
  const client = db();
  if (p.initialValue) {
    const { data } = await client.from("items").select("id, uid, title").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    const rows = ((data ?? []) as AnyRow[]).map((r) => ({ id: r.id, text: `${r.uid ?? ""} ${r.title ?? ""}`.trim() }));
    return json(rows.length === 1 ? rows[0] : rows);
  }
  if (!warehouseId) return json(select2Json([]));
  // 倉庫內有庫存的商品：items × warehouse_stocks（inner join），依頁分頁，不受單次 1000 筆限制
  let q = client
    .from("items")
    .select("id, uid, title, warehouse_stocks!inner(quantity, warehouse_id)")
    .eq("tenant_id", session.tenantId)
    .eq("warehouse_stocks.warehouse_id", warehouseId)
    .gt("warehouse_stocks.quantity", 0);
  const term = sanitizeLike(p.term);
  if (term) q = q.or(`uid.ilike.*${term}*,title.ilike.*${term}*`);
  const from = (p.page - 1) * 30;
  const { data, error } = await q.order("uid").order("id").range(from, from + 30);
  if (error) throw new Error(`[wms stock lookup] ${error.message}`);
  const rows = (data ?? []) as AnyRow[];
  const qtyOf = (r: AnyRow) => Number(((r.warehouse_stocks ?? []) as AnyRow[])[0]?.quantity ?? 0);
  return json(
    select2Json(
      rows.slice(0, 30).map((r) => ({ id: r.id, text: `${r.uid ?? ""} ${r.title ?? ""}（庫存 ${qtyOf(r)}）`.trim() })),
      rows.length > 30,
    ),
  );
}

/* ───────────────────────── 片段（推導） ───────────────────────── */

const ACTION_TITLES: Record<string, string> = {
  item: "調整商品",
  review: "審核",
  transfer: "轉移庫存",
  received: "收貨",
  view: "檢視",
};

async function updateFragmentData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const r = await loadReq(session, toInt(await ctx.param("warehouseRequisitionId")));
  const [row] = await toJsonRows(session, [r]);
  const st = String(row.requisitionStatus);
  let action = (await ctx.param("action")) ?? "view";
  // 依目前狀態決定可做的動作（避免舊畫面按錯）
  if (action === "item" && st !== "OPEN" && st !== "REJECTED") action = "view";
  if (action === "review" && st !== "PENDING") action = "view";
  if (action === "transfer" && !row.transferable) action = "view";
  if (action === "received" && !row.receivable) action = "view";
  if (!ACTION_TITLES[action]) action = "view";
  return {
    req: row,
    action,
    actionTitle: ACTION_TITLES[action],
    isItem: action === "item",
    isReview: action === "review",
    isTransfer: action === "transfer",
    isReceived: action === "received",
    statusLabel: await enumLabel(ST, st),
    transferStatusLabel: await enumLabel(TS, String(row.transferStatus)),
    typeLabel: await enumLabel(TYPE, String(row.type)),
    logisticLabel: await enumLabel(LOGI, String(row.logisticType)),
  };
}

export const requisitionRoutes: RouteDef[] = [
  page("/backend/WarehouseRequisition/list", {
    template: "warehouse/warehouserequisition-list.html",
    title: "調撥單",
    groupBuy: "none",
  }),
  any("/ajax/wms/WarehouseRequisition/list", listReq),
  post("/ajax/wms/WarehouseRequisition/save", saveReq),
  post("/ajax/wms/WarehouseRequisition/update", updateReq),
  post("/ajax/wms/WarehouseRequisition/delete", removeReq),
  post("/ajax/wms/WarehouseRequisition/submit", actionHandler("submit")),
  post("/ajax/wms/WarehouseRequisition/approve", actionHandler("approve")),
  post("/ajax/wms/WarehouseRequisition/reject", actionHandler("reject")),
  post("/ajax/wms/WarehouseRequisition/cancel", actionHandler("cancel")),
  post("/ajax/wms/WarehouseRequisition/transfer", actionHandler("transfer")),
  post("/ajax/wms/WarehouseRequisition/received", actionHandler("received")),
  post("/ajax/wms/WarehouseRequisition/reverse", reverseReq),
  fragment("/backend/WarehouseRequisition/update", {
    template: "warehouse/warehouserequisition-update.html",
    method: "GET",
    data: updateFragmentData,
  }),
  any("/ajax/wms/WarehouseRequisitionItem/list", listItems),
  post("/ajax/wms/WarehouseRequisitionItem/save", writeItemsFor("create")),
  post("/ajax/wms/WarehouseRequisitionItem/update", writeItemsFor("edit")),
  post("/ajax/wms/WarehouseRequisitionItem/delete", writeItemsFor("remove")),
  any("/ajax/wms/WarehouseStock/lookup", lookupStock),
];
