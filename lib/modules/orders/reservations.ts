// 保留單（/backend/SalesOrderReservation/list）。擁有者：orders 子 agent（orders-resv-helpdesk）。
// 原站：spec/html/salesorderreservation-list.html（⟦未擷取⟧缺段已依原站同頁完整 HTML 補齊）、
//       spec/runtime/salesorderreservation-list.records.txt、SPEC.md「保留單」。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴；所有查詢一律以 session.tenantId 過濾）：
//   GET  /backend/SalesOrderReservation/list                頁面（分頁：保留單／保留商品）
//   POST /ajax/SalesOrderReservation/list                    保留單列表（serverSide；hideDone/days/uid/dateCreatedBegin/End）
//   GET  /ajax/SalesOrderReservation/listItem                保留商品列表（serverSide；uid）
//   POST /ajax/SalesOrderReservation/save                    Editor create：新增保留單；mode=bind 為「轉保留」（既有訂單編號 uuid）
//   POST /ajax/SalesOrderReservation/update?relationId=      Editor edit：業務名稱/保留對象/保留期限/員工備註
//   POST /ajax/SalesOrderReservation/action?relationId=      Editor remove＋action=unbind（轉銷售）｜cancel（釋放保留）
//   ANY  /ajax/SalesOrderReservation/unbind?relationId=1,2   轉銷售（原站已註解的 actionButton 端點，保留相容）
//   POST /backend/SalesOrderReservation/batchAction          匯出 EXPORT_CSV／EXPORT_ERP～ERP6（jquery.fileDownload）
//
// 推導（原站保留單 0 筆，無法觀察寫入結果；依列舉、頁面文字與 SPEC 第 7 章推導）：
//   新增   ：建 sales_orders（state HOLDED、status RESERVATION、date_payment_due＝保留期限、staff_note）
//            ＋ sales_order_relations（relation RESERVATION、sales_name、target_name、date_payment_due、staff_note）。
//   轉保留 ：既有訂單（NEW/PROCESSING、未出貨、非保留中）→ HOLDED/RESERVATION，新增 RESERVATION 關聯（mode=bind）。
//   轉銷售 ：訂單 → PROCESSING/ORDER_EMAIL_SENT（＝一般訂單；同 resetSalesOrder），關聯 is_done=true。
//   釋放保留：訂單 → CANCELED/RESERVATION_CANCELED（date_canceled），關聯 is_done=true，訂單商品可售庫存補回。
//   狀態異動一律走 adminUpdateOrders（觸發器寫歷程 actor=ADMIN）。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, download, html, redirect } from "@/lib/core/http/responses";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtQuery, sanitizeLike, type AnyQuery, type DtQuerySpec } from "@/lib/core/datatables/query";
import { dtResponse, type EditorOptions } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import { parseTaipeiDateTime, rowToApi, type Row } from "@/lib/db/mapping";
import { salesOrderReservation, salesOrderReservationItem } from "@/lib/db/entities";
import {
  SHIPPED_STATUSES,
  adjustItemStock,
  adminUpdateOrders,
  db,
  esc,
  fetchOrderByUuid,
  parseIds,
  taipeiDateStart,
  taipeiStartOfDay,
} from "./common";

const RES_VIEW = "sales_order_reservations_v";
const ITEM_VIEW = "sales_order_reservation_items_v";
const LIST_PAGE = "/backend/SalesOrderReservation/list";

/* ─────────────────────────── 小工具 ─────────────────────────── */

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return str(v[0]);
  const s = String(v).trim();
  return s === "null" || s === "undefined" ? "" : s;
};

type FieldErr = { name: string; status: string };

/** 保留期限（YYYY-MM-DD HH:mm，台灣時間）→ ISO；空字串 → null；格式錯 → 推入欄位錯誤 */
function parseDue(v: unknown, errors: FieldErr[]): string | null {
  const s = str(v);
  if (!s) return null;
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) {
    errors.push({ name: "datePaymentDueString", status: "日期格式錯誤（YYYY-MM-DD HH:mm）" });
    return null;
  }
  const iso = parseTaipeiDateTime(s);
  if (!iso || Number.isNaN(new Date(iso).getTime())) {
    errors.push({ name: "datePaymentDueString", status: "日期格式錯誤（YYYY-MM-DD HH:mm）" });
    return null;
  }
  return iso;
}

function limitText(name: string, v: unknown, max: number, errors: FieldErr[]): string | null {
  const s = str(v);
  if (s.length > max) errors.push({ name, status: `最多 ${max} 個字` });
  return s || null;
}

/** 列表回應的 options：state（含 CLOSED/DELETED 的 12 項）、status（保留單頁 45 項）、relation（同原站 runtime） */
async function reservationOptions(): Promise<EditorOptions> {
  return enumOptionsFor({
    state: "SalesOrderReturn.state",
    status: "SalesOrderReservation.status",
    relation: "SalesOrderRelation.relation",
  });
}

/* ─────────────────────────── 列表 ─────────────────────────── */

interface ResFilters {
  hideDone?: string;
  days?: string;
  uid?: string;
  dateCreatedBegin?: string;
  dateCreatedEnd?: string;
}

/** 商品代碼 → 含該商品的訂單 id（本租戶）；未篩選回傳 null */
async function orderIdsByUid(session: AdminSession, uid: string | undefined): Promise<number[] | null> {
  const t = sanitizeLike(str(uid));
  if (!t) return null;
  const { data, error } = await db()
    .from("order_items")
    .select("sales_order_id")
    .eq("tenant_id", session.tenantId)
    .ilike("uid", `%${t}%`)
    .limit(1000);
  if (error) throw new Error(`[reservation] 商品代碼篩選失敗：${error.message}`);
  return [...new Set(((data ?? []) as { sales_order_id: number }[]).map((r) => Number(r.sales_order_id)))];
}

function applyResFilters(q: AnyQuery, f: ResFilters, uidOrderIds: number[] | null, salesOrderIds: number[] = []): AnyQuery {
  // 只顯示進行中訂單（checkbox → "true"/"false"）
  const hideDone = str(f.hideDone).toLowerCase();
  if (hideDone === "true" || hideDone === "1" || hideDone === "on") q = q.eq("is_done", false);
  // 建立日期：30＝30日內、0＝今日、1＝昨日、-1＝指定日期區間（台灣時間）
  const days = str(f.days);
  const iso = (d: Date) => d.toISOString();
  if (days === "30") q = q.gte("created_at", iso(taipeiStartOfDay(new Date(), -30)));
  else if (days === "0") q = q.gte("created_at", iso(taipeiStartOfDay()));
  else if (days === "1") q = q.gte("created_at", iso(taipeiStartOfDay(new Date(), -1))).lt("created_at", iso(taipeiStartOfDay()));
  else if (days === "-1") {
    const b = taipeiDateStart(str(f.dateCreatedBegin));
    const e = taipeiDateStart(str(f.dateCreatedEnd));
    if (b) q = q.gte("created_at", iso(b));
    if (e) q = q.lt("created_at", iso(new Date(e.getTime() + 86_400_000)));
  }
  if (uidOrderIds) q = q.in("sales_order_id", uidOrderIds.length ? uidOrderIds : [0]);
  if (salesOrderIds.length) q = q.in("sales_order_id", salesOrderIds);
  return q;
}

function resQuerySpec(session: AdminSession, f: ResFilters, uidOrderIds: number[] | null, salesOrderIds: number[] = []): DtQuerySpec {
  return {
    table: RES_VIEW,
    select: "*",
    tenantId: session.tenantId,
    columnMap: salesOrderReservation.fields,
    likeColumns: ["uuid", "sales_name", "target_name"],
    where: (q) => applyResFilters(q, f, uidOrderIds, salesOrderIds),
    defaultOrder: [{ column: "created_at", ascending: false }],
  };
}

/** 檢視列 → 原站 JSON（補 datePaymentDue 毫秒、shortUrl；DataTables 欄位不可為 undefined/null 字串） */
async function toReservationApi(session: AdminSession, rows: Row[]): Promise<Row[]> {
  const gbIds = [...new Set(rows.map((r) => r.group_buy_id).filter((x) => x != null).map(Number))];
  const shortUrls = new Map<number, string>();
  if (gbIds.length) {
    const { data, error } = await db().from("group_buys").select("id, short_url").eq("tenant_id", session.tenantId).in("id", gbIds);
    if (error) throw new Error(`[reservation] 讀取團購失敗：${error.message}`);
    for (const g of (data ?? []) as { id: number; short_url: string | null }[]) shortUrls.set(Number(g.id), g.short_url ?? "");
  }
  return rows.map((r) => {
    const api = rowToApi(salesOrderReservation, r);
    api.datePaymentDue = r.date_payment_due ? new Date(String(r.date_payment_due)).getTime() : null;
    for (const k of ["datePaymentDueString", "groupBuyTitle", "salesName", "targetName", "staffNote", "mode", "uuid"]) {
      if (api[k] === undefined || api[k] === null) api[k] = "";
    }
    api.shortUrl = r.group_buy_id != null ? shortUrls.get(Number(r.group_buy_id)) ?? "" : "";
    return api;
  });
}

async function loadReservationRows(session: AdminSession, relationIds: number[]): Promise<Row[]> {
  if (!relationIds.length) return [];
  const { data, error } = await db().from(RES_VIEW).select("*").eq("tenant_id", session.tenantId).in("relation_id", relationIds);
  if (error) throw new Error(`[reservation] 讀取保留單失敗：${error.message}`);
  const order = new Map(relationIds.map((id, i) => [id, i]));
  const rows = ((data ?? []) as Row[]).sort((a, b) => (order.get(Number(a.relation_id)) ?? 0) - (order.get(Number(b.relation_id)) ?? 0));
  return toReservationApi(session, rows);
}

/** POST /ajax/SalesOrderReservation/list */
async function listReservations(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const uidIds = await orderIdsByUid(session, dt.extra.uid);
  const result = await dtQuery<Row>(db(), dt, resQuerySpec(session, dt.extra, uidIds));
  const rows = await toReservationApi(session, result.rows);
  return dtResponse(
    dt,
    { rows, recordsTotal: result.recordsTotal, recordsFiltered: result.recordsFiltered, options: await reservationOptions() },
    started,
  );
}

/** GET /ajax/SalesOrderReservation/listItem（保留中的訂單商品；檢視已排除 is_done 的保留單） */
async function listReservationItems(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const uid = sanitizeLike(str(dt.extra.uid));
  const result = await dtQuery<Row>(db(), dt, {
    table: ITEM_VIEW,
    select: "*",
    tenantId: session.tenantId,
    columnMap: salesOrderReservationItem.fields,
    likeColumns: ["title", "uid", "sales_name"],
    where: (q) => (uid ? q.ilike("uid", `%${uid}%`) : q),
    defaultOrder: [{ column: "sales_name", ascending: false }],
  });
  const rows = result.rows.map((r) => {
    const api = rowToApi(salesOrderReservationItem, r);
    for (const k of ["title", "uid", "salesName", "targetName", "uuid"]) if (api[k] === undefined || api[k] === null) api[k] = "";
    if (api.daysReserved === undefined || api.daysReserved === null) api.daysReserved = 0;
    return api;
  });
  return dtResponse(dt, { rows, recordsTotal: result.recordsTotal, recordsFiltered: result.recordsFiltered, options: {} }, started);
}

/* ─────────────────────────── 新增／轉保留／編輯 ─────────────────────────── */

type RelationRow = {
  id: number;
  sales_order_id: number;
  relation: string;
  is_done: boolean;
  sales_orders: { id: number; uuid: string; state: string; status: string } | null;
};

async function insertRelation(session: AdminSession, row: Row): Promise<number> {
  const { data, error } = await db()
    .from("sales_order_relations")
    .insert({ ...row, tenant_id: session.tenantId, relation: "RESERVATION" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`[reservation] 建立保留單關聯失敗：${error?.message}`);
  return Number((data as { id: number }).id);
}

/** 新增保留單：建立 HOLDED/RESERVATION 訂單＋ RESERVATION 關聯 */
async function createReservation(session: AdminSession, v: Row): Promise<number> {
  const errors: FieldErr[] = [];
  const groupBuyId = Number(str(v.groupBuyId));
  if (!Number.isSafeInteger(groupBuyId) || groupBuyId <= 0) {
    errors.push({ name: "groupBuyId", status: "請選擇團購" });
  } else {
    const { data } = await db().from("group_buys").select("id").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
    if (!data) errors.push({ name: "groupBuyId", status: "找不到此團購" });
  }
  const salesName = limitText("salesName", v.salesName, 100, errors);
  const targetName = limitText("targetName", v.targetName, 100, errors);
  const staffNote = limitText("staffNote", v.staffNote, 2000, errors);
  const due = parseDue(v.datePaymentDueString, errors);
  if (errors.length) throw new FieldErrors(errors);

  const client = db();
  const { data: order, error } = await client
    .from("sales_orders")
    .insert({
      tenant_id: session.tenantId,
      group_buy_id: groupBuyId,
      state: "HOLDED",
      status: "RESERVATION",
      date_payment_due: due,
      staff_note: staffNote,
    })
    .select("id, uuid")
    .single();
  if (error || !order) throw new Error(`[reservation] 建立保留單訂單失敗：${error?.message}`);
  const orderId = Number((order as { id: number }).id);
  // 觸發器以 SYSTEM 記錄「建立訂單」：改記成本次操作的管理員
  await client
    .from("sales_order_histories")
    .update({ actor: "ADMIN", admin_user_id: session.adminUserId, note: "新增保留單" })
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", orderId);
  try {
    return await insertRelation(session, {
      sales_order_id: orderId,
      sales_name: salesName,
      target_name: targetName,
      date_payment_due: due,
      staff_note: staffNote,
      mode: null,
    });
  } catch (e) {
    await client.from("sales_orders").delete().eq("tenant_id", session.tenantId).eq("id", orderId);
    throw e;
  }
}

/** 轉保留：既有訂單編號 → 保留單 */
async function bindReservation(session: AdminSession, v: Row): Promise<number> {
  const uuid = str(v.uuid);
  if (!uuid) throw new FieldErrors([{ name: "uuid", status: "請輸入訂單編號" }]);
  const order = await fetchOrderByUuid(session, uuid, "id, uuid, state, status, date_payment_due, staff_note");
  if (!order) throw new FieldErrors([{ name: "uuid", status: "找不到此訂單編號" }]);
  const orderId = Number(order.id);
  const { data: active } = await db()
    .from("sales_order_relations")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", orderId)
    .eq("relation", "RESERVATION")
    .eq("is_done", false)
    .limit(1);
  if ((active ?? []).length || order.state === "HOLDED" || order.status === "RESERVATION") {
    throw new FieldErrors([{ name: "uuid", status: "此訂單已是保留單" }]);
  }
  if (order.state !== "NEW" && order.state !== "PROCESSING") {
    throw new FieldErrors([{ name: "uuid", status: "只有新訂單或處理中的訂單可以轉成保留單" }]);
  }
  if ((SHIPPED_STATUSES as readonly string[]).includes(String(order.status))) {
    throw new FieldErrors([{ name: "uuid", status: "已出貨的訂單無法轉成保留單" }]);
  }
  const errors: FieldErr[] = [];
  const salesName = limitText("salesName", v.salesName, 100, errors);
  const targetName = limitText("targetName", v.targetName, 100, errors);
  const staffNote = limitText("staffNote", v.staffNote, 2000, errors);
  const due = parseDue(v.datePaymentDueString, errors);
  if (errors.length) throw new FieldErrors(errors);

  const patch: Row = { state: "HOLDED", status: "RESERVATION" };
  if (due) patch.date_payment_due = due;
  await adminUpdateOrders(session, [orderId], patch, "轉保留（既有訂單轉成保留單）");
  try {
    return await insertRelation(session, {
      sales_order_id: orderId,
      sales_name: salesName,
      target_name: targetName,
      date_payment_due: due ?? order.date_payment_due ?? null,
      staff_note: staffNote,
      mode: "bind",
    });
  } catch (e) {
    await adminUpdateOrders(session, [orderId], { state: order.state, status: order.status }, "轉保留失敗，還原狀態");
    throw e;
  }
}

/** POST /ajax/SalesOrderReservation/save（Editor create） */
async function saveReservation(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("不支援的動作");
  const ids: number[] = [];
  for (const r of req.rows) {
    const v = flattenDotted(r.values);
    ids.push(str(v.mode) === "bind" ? await bindReservation(session, v) : await createReservation(session, v));
  }
  return editorResponse(await loadReservationRows(session, ids));
}

async function loadRelations(session: AdminSession, ids: number[]): Promise<Map<number, RelationRow>> {
  if (!ids.length) return new Map();
  const { data, error } = await db()
    .from("sales_order_relations")
    .select("id, sales_order_id, relation, is_done, sales_orders!sales_order_id(id, uuid, state, status)")
    .eq("tenant_id", session.tenantId)
    .eq("relation", "RESERVATION")
    .in("id", ids);
  if (error) throw new Error(`[reservation] 讀取保留單失敗：${error.message}`);
  return new Map(((data ?? []) as unknown as RelationRow[]).map((r) => [Number(r.id), r]));
}

/** POST /ajax/SalesOrderReservation/update?relationId=（Editor edit） */
async function updateReservation(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("不支援的動作");
  const ids = editorIds(req, "relationId");
  const rels = await loadRelations(session, ids);
  const rows = req.rows.length ? req.rows : ids.map((id) => ({ id: String(id), values: {} }));
  for (const row of rows) {
    const id = Number(row.id);
    const rel = rels.get(id);
    if (!rel) throw notFound("找不到保留單（可能已被刪除）");
    const v = flattenDotted(row.values);
    const errors: FieldErr[] = [];
    const patch: Row = {};
    if ("salesName" in v) patch.sales_name = limitText("salesName", v.salesName, 100, errors);
    if ("targetName" in v) patch.target_name = limitText("targetName", v.targetName, 100, errors);
    if ("datePaymentDueString" in v) patch.date_payment_due = parseDue(v.datePaymentDueString, errors);
    if ("staffNote" in v) patch.staff_note = limitText("staffNote", v.staffNote, 2000, errors);
    if (errors.length) throw new FieldErrors(errors);
    if (!Object.keys(patch).length) continue;
    const { error } = await db().from("sales_order_relations").update(patch).eq("tenant_id", session.tenantId).eq("id", id);
    if (error) throw new Error(`[reservation] 更新保留單失敗：${error.message}`);
    // 進行中的保留單：同步訂單的保留期限（付款期限）與員工備註
    if (!rel.is_done) {
      const op: Row = {};
      if ("date_payment_due" in patch) op.date_payment_due = patch.date_payment_due;
      if ("staff_note" in patch) op.staff_note = patch.staff_note;
      if (Object.keys(op).length) await adminUpdateOrders(session, [Number(rel.sales_order_id)], op);
    }
  }
  return editorResponse(await loadReservationRows(session, ids));
}

/* ─────────────────────────── 轉銷售／釋放保留 ─────────────────────────── */

async function activeReservations(session: AdminSession, ids: number[], verb: string): Promise<RelationRow[]> {
  if (!ids.length) throw badRequest("缺少資料 id");
  const rels = await loadRelations(session, ids);
  const out: RelationRow[] = [];
  for (const id of ids) {
    const rel = rels.get(id);
    if (!rel || !rel.sales_orders) throw notFound("找不到保留單（可能已被刪除）");
    const o = rel.sales_orders;
    if (rel.is_done || o.state !== "HOLDED" || o.status !== "RESERVATION") {
      throw badRequest(`保留單 ${o.uuid} 已轉銷售或已釋放，無法${verb}`);
    }
    out.push(rel);
  }
  return out;
}

async function markDone(session: AdminSession, rels: RelationRow[]): Promise<void> {
  const { error } = await db()
    .from("sales_order_relations")
    .update({ is_done: true })
    .eq("tenant_id", session.tenantId)
    .in("id", rels.map((r) => r.id));
  if (error) throw new Error(`[reservation] 更新保留單失敗：${error.message}`);
}

/** 轉銷售：保留單 → 一般訂單（PROCESSING／ORDER_EMAIL_SENT） */
async function unbindReservations(session: AdminSession, ids: number[]): Promise<number> {
  const rels = await activeReservations(session, ids, "轉銷售");
  await adminUpdateOrders(session, rels.map((r) => Number(r.sales_order_id)), { state: "PROCESSING", status: "ORDER_EMAIL_SENT" }, "保留單轉銷售");
  await markDone(session, rels);
  return rels.length;
}

/** 釋放保留：訂單取消（RESERVATION_CANCELED）、商品庫存補回 */
async function releaseReservations(session: AdminSession, ids: number[]): Promise<number> {
  const rels = await activeReservations(session, ids, "釋放保留");
  const orderIds = rels.map((r) => Number(r.sales_order_id));
  const { data: items, error } = await db()
    .from("order_items")
    .select("item_id, total, back_order, bundle_root, state")
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", orderIds);
  if (error) throw new Error(`[reservation] 讀取訂單商品失敗：${error.message}`);
  await adminUpdateOrders(
    session,
    orderIds,
    { state: "CANCELED", status: "RESERVATION_CANCELED", date_canceled: new Date().toISOString() },
    "釋放保留（訂單取消）",
  );
  await markDone(session, rels);
  const changes = ((items ?? []) as { item_id: number | null; total: number; back_order: boolean; bundle_root: boolean; state: string }[])
    .filter((it) => it.item_id && !it.bundle_root && it.state !== "CANCELLED")
    .map((it) => ({ itemId: it.item_id, qty: Number(it.total) || 0, backOrder: !!it.back_order }));
  await adjustItemStock(session, changes);
  return rels.length;
}

/** 從 Editor remove 請求取保留單 id：data[<relationId>] 的鍵，或網址 ?relationId=1,2 */
async function relationIdsFrom(ctx: RequestContext): Promise<number[]> {
  const body = await ctx.body();
  const data = body.nested.data;
  const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
  const fromData = parseIds(keys);
  if (fromData.length) return fromData;
  return parseIds([...(await ctx.params_all("relationId")), ...(await ctx.params_all("relationIds"))]);
}

/** POST /ajax/SalesOrderReservation/action?relationId=（Editor remove；頁面把 action 換成 unbind/cancel） */
async function reservationAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const action = str(body.flat.get("action")?.[0] ?? ctx.query.get("action"));
  const ids = await relationIdsFrom(ctx);
  if (action === "unbind") await unbindReservations(session, ids);
  else if (action === "cancel") await releaseReservations(session, ids);
  else throw badRequest("不支援的動作");
  return editorResponse([]);
}

/** ANY /ajax/SalesOrderReservation/unbind?relationId=1,2（原站 actionButton「轉銷售」，頁面上已註解） */
async function unbindAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = parseIds([...(await ctx.params_all("relationId")), ...(await ctx.params_all("relationIds"))]);
  const n = await unbindReservations(session, ids);
  return actionOk(`已轉銷售 ${n} 筆保留單`);
}

/* ─────────────────────────── 匯出（batchAction） ─────────────────────────── */

const ERP_TITLES: Record<string, string> = {
  EXPORT_ERP: "ERP報表1",
  EXPORT_ERP2: "ERP報表2",
  EXPORT_ERP3: "ERP報表3",
  EXPORT_ERP4: "ERP報表4",
  EXPORT_ERP5: "ERP報表5",
  EXPORT_ERP6: "ERP報表6",
};

/** 頁面 query（DataTables legacy 參數＋篩選的 JSON 字串）→ DtRequest */
async function dtFromQueryJson(raw: string): Promise<DtRequest> {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    throw badRequest("匯出參數格式錯誤");
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || typeof v === "object") {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      continue;
    }
    qs.append(k, String(v));
  }
  const fake = { query: qs, body: async () => ({ flat: new Map(), nested: {}, files: new Map() }) } as unknown as RequestContext;
  return parseDtRequest(fake);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp(): string {
  return taipeiDateTime(new Date()).replace(/[-: ]/g, "");
}

/** POST /backend/SalesOrderReservation/batchAction */
async function batchAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const action = str(await ctx.param("batchAction"));
  // 「保留商品」分頁的商品代碼欄按 Enter 會以原生表單送出（沒有 batchAction）→ 回列表
  if (!action) return redirect(LIST_PAGE, 303);
  if (action !== "EXPORT_CSV" && !ERP_TITLES[action]) {
    return html(`<p>不支援的匯出格式：${esc(action)}</p>`, { status: 400 });
  }
  const dt = await dtFromQueryJson(str(await ctx.param("query")));
  const selected = parseIds(str(await ctx.param("salesOrderIds")));
  const uidIds = await orderIdsByUid(session, dt.extra.uid);
  const spec = resQuerySpec(session, dt.extra, uidIds, selected);
  const want = Math.min(4000, dt.length > 0 ? dt.length : 4000);
  const rows: Row[] = [];
  for (let off = 0; off < want; off += 1000) {
    const len = Math.min(1000, want - off);
    const r = await dtQuery<Row>(db(), { ...dt, serverSide: true, start: dt.start + off, length: len }, spec);
    rows.push(...r.rows);
    if (r.rows.length < len) break;
  }
  const api = await toReservationApi(session, rows);

  // 訂單商品
  const orderIds = [...new Set(api.map((r) => Number(r.salesOrderId)).filter((n) => n > 0))];
  const itemsByOrder = new Map<number, Row[]>();
  for (let i = 0; i < orderIds.length; i += 500) {
    const { data, error } = await db()
      .from("order_items")
      .select("sales_order_id, title, uid, specifications_label, price, total, amount, seq, id")
      .eq("tenant_id", session.tenantId)
      .in("sales_order_id", orderIds.slice(i, i + 500))
      .order("seq")
      .order("id");
    if (error) throw new Error(`[reservation] 讀取訂單商品失敗：${error.message}`);
    for (const it of (data ?? []) as Row[]) {
      const k = Number(it.sales_order_id);
      if (!itemsByOrder.has(k)) itemsByOrder.set(k, []);
      itemsByOrder.get(k)!.push(it);
    }
  }
  const labels = async (key: string) => new Map((await enumOptions(key)).map((o) => [String(o.value), o.label]));
  const stateL = await labels("SalesOrderReturn.state");
  const statusL = await labels("SalesOrderReservation.status");

  const lines: string[] = [];
  let filename: string;
  if (action === "EXPORT_CSV") {
    lines.push(["訂單編號", "訂單日期", "保留期限", "業務名稱/ID", "保留對象", "團購ID", "團購名稱", "階段", "狀態", "結帳金額", "員工備註", "保留商品"].map(csvCell).join(","));
    for (const r of api) {
      const items = (itemsByOrder.get(Number(r.salesOrderId)) ?? []).map((it) => `${it.title ?? ""}${it.uid ? `(${it.uid})` : ""} x${it.total}`).join("；");
      lines.push(
        [
          r.uuid,
          r.dateCreatedString,
          r.datePaymentDueString,
          r.salesName,
          r.targetName,
          r.groupBuyId,
          r.groupBuyTitle,
          stateL.get(String(r.state)) ?? r.state,
          statusL.get(String(r.status)) ?? r.status,
          r.grandTotal,
          r.staffNote,
          items,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    filename = `保留單_${stamp()}.csv`;
  } else {
    // ERP 報表（推導：原站各租戶自訂格式未擷取 → 匯出商品明細）
    lines.push(["訂單編號", "訂單日期", "保留期限", "業務名稱/ID", "保留對象", "團購ID", "商品名稱", "商品代碼", "規格", "數量", "單價", "小計"].map(csvCell).join(","));
    for (const r of api) {
      for (const it of itemsByOrder.get(Number(r.salesOrderId)) ?? []) {
        lines.push(
          [r.uuid, r.dateCreatedString, r.datePaymentDueString, r.salesName, r.targetName, r.groupBuyId, it.title, it.uid, it.specifications_label, it.total, Number(it.price), Number(it.amount)]
            .map(csvCell)
            .join(","),
        );
      }
    }
    filename = `${ERP_TITLES[action]}_${stamp()}.csv`;
  }
  return download("﻿" + lines.join("\r\n") + "\r\n", filename, "text/csv;charset=UTF-8");
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const reservationRoutes: RouteDef[] = [
  page(LIST_PAGE, {
    template: "orders/salesorderreservation-list.html",
    title: "保留單",
    groupBuy: "none",
  }),
  any("/ajax/SalesOrderReservation/list", listReservations),
  any("/ajax/SalesOrderReservation/listItem", listReservationItems),
  post("/ajax/SalesOrderReservation/save", saveReservation),
  post("/ajax/SalesOrderReservation/update", updateReservation),
  post("/ajax/SalesOrderReservation/action", reservationAction),
  any("/ajax/SalesOrderReservation/unbind", unbindAction),
  post("/backend/SalesOrderReservation/batchAction", batchAction),
  get("/backend/SalesOrderReservation/batchAction", async () => redirect(LIST_PAGE, 303)),
];
