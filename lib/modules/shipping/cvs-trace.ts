// 訂單追蹤三頁（側欄「出貨紀錄」下）：
//   超商未取 /backend/SalesOrderCVSTrace/list           （原站 spec/html/salesordercvstrace-list.html；title「訂單到店未取貨」）
//   自取未取 /backend/SalesOrderCVSTrace/listPickup     （list_pickup.jsp）
//   超時出貨 /backend/SalesOrderCVSTrace/listUnshipped  （list_unshipped.jsp；每頁 100 筆）
//
//   GET  /ajax/SalesOrderCVSTrace/list            serverSide；shippingStatus=ARRIVED（到店未取）|RETURNING（逾期未取退回中）、ignoreNotified=true（排除 24 小時內已通知）
//   GET  /ajax/SalesOrderCVSTrace/listPickup      自取（shipping_type=PICKUP）且處理中的訂單
//   GET  /ajax/SalesOrderCVSTrace/listUnshipped   處理中、未出貨、成立超過 30 天的訂單（舊到新）
//   POST /ajax/SalesOrderCVSTrace/markAsPicked    salesOrderId=1,2（DataTableHelper.ajaxPost）→ 追蹤設為已取貨＋訂單設為已完成
//   POST /ajax/SalesOrderCVSTrace/markAsComplete  salesOrderId=1,2 → 訂單設為已完成（不寄出貨信、不開發票）
//   POST /ajax/SalesOrderCVSTrace/sendSMS         smsManager（/scripts/sms.js）：uuid（換行多筆）、body、confirm、groupBuyId → 簡訊【未串接】
//   POST /ajax/SalesOrderCVSTrace/save|update|action  頁面 Editor 的 create/edit/remove（原站按鈕皆已註解；列按鈕只有「商品」）→ 不支援
//   GET  /ajax/SalesOrderCVSTrace/getCvsReturnStats  {data:{thisMonthRate,lastMonthRate}}（本月／上月 CVS 未取退貨率 %）
//   GET  /x/ajax/SalesOrder/orderItems?uuid=      列展開「商品」：{data:[{title,total,backOrder}]}
//   GET  /ajax/Sms/getBalance                     sms.js 開啟簡訊視窗時查點數 →【未串接】
//
// 推導（原站未擷取到資料，records=0）：各列表的篩選條件、已收貨／已完成對訂單的影響、未取退貨率公式 —— 見 docs/modules/shipping.md。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, json } from "@/lib/core/http/responses";
import { badRequest, FieldErrors, notFound, notIntegrated } from "@/lib/core/http/errors";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { enumOptionsFor } from "@/lib/core/enums";
import { salesOrderCvsTraceList } from "@/lib/db/entities/salesOrderCvsTraceList";
import type { EntityDef } from "@/lib/db/entity-types";
import type { Row } from "@/lib/db/mapping";
import { db, paramIds, str } from "./common";

type AnyQuery = Parameters<NonNullable<ListSpec["where"]>>[0];

/** 到店未取：已到店（含物流回報未取貨 UNPICKED）且尚未取貨 */
const ARRIVED_STATUSES = ["ARRIVED", "UNPICKED"];
/** 逾期未取退回中 */
const RETURNING_STATUSES = ["RETURNING"];
/** 已出貨類訂單狀態（超時出貨排除） */
const SHIPPED_ORDER_STATUSES = ["SHIPPED", "SHIPPING_EMAIL_SENT", "SHIPPING_EMAIL_FAILED"];
const UNSHIPPED_DAYS = 30;
const MAX_SMS = 100;

/** 自取未取／超時出貨的列（訂單）：鍵名與超商未取列表一致（salesOrderId 為 idSrc） */
const orderRowEntity: EntityDef = {
  table: "sales_orders",
  idKey: "salesOrderId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderId: "id",
    uuid: "uuid",
    groupBuyId: "group_buy_id",
    salesOrderStatus: "status",
    salesOrderState: "state",
    paymentMethod: "payment_method",
    shippingType: "shipping_type",
    trackingNumber: "shipping_receipt_number",
    customerFirstname: "customer_firstname",
    customerTelephone: "customer_telephone",
    pickupStoreId: "pickup_store_id",
    dateShippedString: "date_shipped",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};

const orderOptions = () =>
  enumOptionsFor({
    salesOrderStatus: "SalesOrderCVSTrace.salesOrderStatus",
    paymentMethod: { key: "SalesOrder.paymentMethod", useInt: true },
  });

/* ─────────────────────────── 列表條件（列表與側欄徽章共用） ─────────────────────────── */

function cvsWhere(q: AnyQuery, shippingStatus: string, ignoreNotified: boolean): AnyQuery {
  let out = q.eq("sales_order_state", "PROCESSING");
  if (shippingStatus === "RETURNING") out = out.in("status", RETURNING_STATUSES);
  else out = out.in("status", ARRIVED_STATUSES).is("date_picked", null);
  if (ignoreNotified) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    out = out.or(`date_notified.is.null,date_notified.lt.${since}`);
  }
  return out;
}

function pickupWhere(q: AnyQuery): AnyQuery {
  return q.eq("shipping_type", "PICKUP").eq("state", "PROCESSING");
}

function unshippedWhere(q: AnyQuery): AnyQuery {
  const before = new Date(Date.now() - UNSHIPPED_DAYS * 24 * 3600 * 1000).toISOString();
  return q
    .eq("state", "PROCESSING")
    .is("date_shipped", null)
    .not("status", "in", `(${SHIPPED_ORDER_STATUSES.join(",")})`)
    .lt("created_at", before);
}

async function countWhere(table: string, session: AdminSession, where: (q: AnyQuery) => AnyQuery): Promise<number> {
  const q = db().from(table).select("*", { count: "exact", head: true }).eq("tenant_id", session.tenantId) as unknown as AnyQuery;
  const { count, error } = (await where(q)) as unknown as { count: number | null; error: { message: string } | null };
  if (error) throw new Error(`[shipping] 計數失敗：${error.message}`);
  return count ?? 0;
}

/** 側欄徽章（data-name：cvsUnpicked／selfUnpicked／unshipped） */
export const trackingBadges: Record<string, (session: AdminSession) => Promise<number>> = {
  cvsUnpicked: (s) => countWhere("sales_order_cvs_traces_v", s, (q) => cvsWhere(q, "ARRIVED", false)),
  selfUnpicked: (s) => countWhere("sales_orders", s, pickupWhere),
  unshipped: (s) => countWhere("sales_orders", s, unshippedWhere),
};

/* ─────────────────────────── 列表 ─────────────────────────── */

const truthy = (v: unknown) => ["true", "1", "on"].includes(str(v).toLowerCase());

function listCvs(ctx: RequestContext): Promise<Response> {
  return listEntity(ctx, salesOrderCvsTraceList, {
    search: ["uuid", "trackingNumber"],
    where: (q, dt) => cvsWhere(q, str(dt.extra.shippingStatus).toUpperCase() || "ARRIVED", truthy(dt.extra.ignoreNotified)),
    defaultOrder: [{ key: "dateArrivedString", ascending: true }],
    options: () => enumOptionsFor({ status: "SalesOrderCVSTrace.status" }),
  });
}

function orderRow(api: Row): Row {
  // 列按鈕 render 判斷 row.state／row.relation／row.status：訂單列不帶 relation（只顯示「商品」）
  return { salesOrderCVSTraceId: null, status: "", ...api, state: api.salesOrderState };
}

function listPickup(ctx: RequestContext): Promise<Response> {
  return listEntity(ctx, orderRowEntity, {
    search: ["uuid", "customerFirstname", "customerTelephone"],
    where: (q) => pickupWhere(q),
    defaultOrder: [{ key: "dateCreatedString", ascending: true }],
    mapRow: (api) => orderRow(api),
    options: orderOptions,
  });
}

function listUnshipped(ctx: RequestContext): Promise<Response> {
  return listEntity(ctx, orderRowEntity, {
    search: ["uuid", "customerFirstname", "customerTelephone"],
    where: (q) => unshippedWhere(q),
    defaultOrder: [{ key: "dateCreatedString", ascending: true }],
    mapRow: (api) => orderRow(api),
    options: orderOptions,
  });
}

/* ─────────────────────────── 動作 ─────────────────────────── */

async function updateOrders(session: AdminSession, ids: number[], patch: Row, note: string): Promise<number[]> {
  if (!ids.length) return [];
  const { data, error } = await db().rpc("orders_admin_update", {
    p_tenant_id: session.tenantId,
    p_ids: ids,
    p_patch: patch,
    p_admin_user_id: session.adminUserId,
    p_note: note,
    p_actor: "ADMIN",
  });
  if (error) throw new Error(`[shipping] 更新訂單失敗：${error.message}`);
  return ((data ?? []) as unknown[]).map((x) => Number(typeof x === "object" && x !== null ? Object.values(x)[0] : x));
}

async function selectedOrders(ctx: RequestContext, session: AdminSession): Promise<Row[]> {
  const ids = await paramIds(ctx, "salesOrderId", "salesOrderIds", "id");
  if (!ids.length) throw badRequest("請先選擇訂單");
  if (ids.length > 500) throw badRequest("單次最多 500 筆");
  const { data, error } = await db()
    .from("sales_orders")
    .select("id, uuid, state, status, shipping_type, date_shipped")
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[shipping] 讀取訂單失敗：${error.message}`);
  const rows = (data ?? []) as Row[];
  if (!rows.length) throw notFound("找不到訂單");
  return rows;
}

function skippedMessage(skipped: Row[]): string {
  if (!skipped.length) return "";
  const list = skipped.slice(0, 10).map((r) => str(r.uuid)).join("、");
  return `${skipped.length} 筆訂單不是「處理中」，未變更（${list}${skipped.length > 10 ? "…" : ""}）`;
}

/** 設為已收貨：超商追蹤設為已取貨（PICKED）；訂單設為已完成（自取訂單補出貨日＝今日） */
async function markAsPicked(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rows = await selectedOrders(ctx, session);
  const ok = rows.filter((r) => r.state === "PROCESSING");
  const skipped = rows.filter((r) => r.state !== "PROCESSING");
  if (!ok.length) throw badRequest(skippedMessage(skipped));
  const now = new Date().toISOString();
  const ids = ok.map((r) => Number(r.id));
  const { error } = await db()
    .from("sales_order_cvs_traces")
    .update({ status: "PICKED", date_picked: now, updated_at: now })
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", ids)
    .is("date_picked", null);
  if (error) throw new Error(`[shipping] 更新超商追蹤失敗：${error.message}`);
  const noShipDate = ok.filter((r) => !r.date_shipped).map((r) => Number(r.id));
  const shipped = ok.filter((r) => r.date_shipped).map((r) => Number(r.id));
  await updateOrders(session, noShipDate, { state: "COMPLETE", date_completed: now, date_shipped: now }, "設為已收貨");
  await updateOrders(session, shipped, { state: "COMPLETE", date_completed: now }, "設為已收貨");
  return actionOk([`已將 ${ok.length} 筆訂單設為已收貨`, skippedMessage(skipped)].filter(Boolean).join("；"), { count: ok.length });
}

/** 設為已完成：訂單設為已完成（不寄出貨通知信、不開立發票） */
async function markAsComplete(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rows = await selectedOrders(ctx, session);
  const ok = rows.filter((r) => r.state === "PROCESSING");
  const skipped = rows.filter((r) => r.state !== "PROCESSING");
  if (!ok.length) throw badRequest(skippedMessage(skipped));
  await updateOrders(session, ok.map((r) => Number(r.id)), { state: "COMPLETE", date_completed: new Date().toISOString() }, "設為已完成（超時出貨）");
  return actionOk([`已將 ${ok.length} 筆訂單設為已完成`, skippedMessage(skipped)].filter(Boolean).join("；"), { count: ok.length });
}

/** 70 字（含）內 1 點；超過 70 字每 67 字 1 點（同團購發送簡訊） */
function smsPoints(body: string): number {
  const n = [...body].length;
  if (n === 0) return 0;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/** 發送簡訊（smsManager 以 Editor create 送出 data[0]：uuid、body、confirm、groupBuyId） */
async function sendSMS(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const pick = async (k: string) => str((await ctx.param(k)) ?? (await ctx.param(`data[0][${k}]`)));
  const keys = (await pick("uuid"))
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body = await pick("body");
  const confirm = await pick("confirm");
  const errs: { name: string; status: string }[] = [];
  if (!keys.length) errs.push({ name: "uuid", status: "需要至少一個發送對象" });
  else if (keys.length > MAX_SMS) errs.push({ name: "uuid", status: `單次上限為${MAX_SMS}筆` });
  if (!body) errs.push({ name: "body", status: "簡訊內容不可為空白" });
  else if (/LINE|銀行/i.test(body)) errs.push({ name: "body", status: "簡訊訊息請勿包含以下關鍵字以免被電信公司阻擋：LINE、銀行" });
  else if ((body.match(/https?:\/\/[^\s]+/gi) ?? []).some((u) => !/^https:\/\/gbf\.tw(\/|$)/i.test(u))) {
    errs.push({ name: "body", status: "簡訊內容的網址目前只能使用 https://gbf.tw 開頭的網址" });
  }
  if (!["1", "true", "on"].includes(confirm.toLowerCase())) errs.push({ name: "confirm", status: "須先勾選同意" });
  if (errs.length) throw new FieldErrors(errs);
  const { data, error } = await db()
    .from("sales_orders")
    .select("id, uuid, group_buy_id, customer_telephone, shipping_telephone")
    .eq("tenant_id", session.tenantId)
    .in("uuid", [...new Set(keys)]);
  if (error) throw new Error(`[shipping] 讀取訂單失敗：${error.message}`);
  const orders = (data ?? []) as Row[];
  if (!orders.length) throw new FieldErrors([{ name: "uuid", status: "找不到訂單" }]);
  const points = smsPoints(body);
  const rows = orders.map((o) => ({
    tenant_id: session.tenantId,
    group_buy_id: o.group_buy_id ?? null,
    sales_order_id: Number(o.id),
    telephone: str(o.customer_telephone) || str(o.shipping_telephone) || "-",
    content: body,
    points,
    status: "NOT_SENT_UNINTEGRATED",
    error_message: "簡訊服務未串接，僅建立紀錄",
  }));
  const { error: insErr } = await db().from("sms_messages").insert(rows);
  if (insErr) throw new Error(`[shipping] 寫入簡訊紀錄失敗：${insErr.message}`);
  const missing = keys.length - orders.length;
  const ni = notIntegrated("發送簡訊");
  const msg = `${ni.message}已建立 ${rows.length} 則簡訊紀錄（每則 ${points} 點）${missing > 0 ? `；${missing} 筆訂單編號找不到` : ""}。最近通知日期不變更。`;
  return actionOk(msg, { ...ni, data: [] });
}

/** 頁面 Editor 的 create／edit／remove（原站工具列按鈕已註解，列按鈕只有「商品」） */
async function unsupported(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  throw badRequest("此列表不支援該操作");
}

/* ─────────────────────────── 統計、商品、簡訊點數 ─────────────────────────── */

function monthRange(offset: number): { from: string; to: string } {
  // 台灣時間（UTC+8）的月初
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + offset;
  const from = new Date(Date.UTC(y, m, 1) - 8 * 3600 * 1000);
  const to = new Date(Date.UTC(y, m + 1, 1) - 8 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** 未取退貨率（%）＝當月到店的超商包裹中，未取（UNPICKED／RETURNING／RETURNED 或有退回日）的比例；小數一位 */
async function returnRate(session: AdminSession, offset: number): Promise<number> {
  const { from, to } = monthRange(offset);
  const { data, error } = await db()
    .from("sales_order_cvs_traces")
    .select("status, date_returning, date_returned")
    .eq("tenant_id", session.tenantId)
    .gte("date_arrived", from)
    .lt("date_arrived", to)
    .limit(20000);
  if (error) throw new Error(`[shipping] 讀取超商追蹤失敗：${error.message}`);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return 0;
  const unpicked = rows.filter((r) => ["UNPICKED", "RETURNING", "RETURNED"].includes(str(r.status)) || r.date_returning || r.date_returned).length;
  return Math.round((unpicked / rows.length) * 1000) / 10;
}

async function getCvsReturnStats(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const [thisMonthRate, lastMonthRate] = await Promise.all([returnRate(session, 0), returnRate(session, -1)]);
  return json({ code: 200, data: { thisMonthRate, lastMonthRate } });
}

/** 列展開「商品」：訂單商品（不含組合子項）{title,total,backOrder} */
async function orderItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const uuid = str(await ctx.param("uuid"));
  if (!uuid) throw badRequest("缺少訂單編號");
  const { data: order } = await db().from("sales_orders").select("id").eq("tenant_id", session.tenantId).eq("uuid", uuid).maybeSingle();
  if (!order) throw notFound("找不到訂單");
  const { data, error } = await db()
    .from("order_items")
    .select("title, specifications_label, total, back_order, bundle_child, seq, id")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", Number((order as Row).id))
    .order("seq")
    .order("id");
  if (error) throw new Error(`[shipping] 讀取訂單商品失敗：${error.message}`);
  const items = ((data ?? []) as Row[])
    .filter((r) => !r.bundle_child)
    .map((r) => ({
      title: [str(r.title), str(r.specifications_label)].filter(Boolean).join(" "),
      total: Number(r.total ?? 0),
      backOrder: !!r.back_order,
    }));
  return json({ code: 200, data: items });
}

/** sms.js getBalance：簡訊點數屬外部簡訊服務（未串接） */
async function smsBalance(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const ni = notIntegrated("簡訊點數查詢");
  return json({ code: 200, data: "—（未串接）", ...ni });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const cvsTraceRoutes: RouteDef[] = [
  page("/backend/SalesOrderCVSTrace/list", { template: "shipping/salesordercvstrace-list.html", title: "訂單到店未取貨", groupBuy: "none" }),
  page("/backend/SalesOrderCVSTrace/listPickup", {
    template: "shipping/salesordercvstrace-listpickup.html",
    title: "自取未取貨",
    groupBuy: "none",
    jsp: "/backend/SalesOrderCVSTrace/list_pickup.jsp",
  }),
  page("/backend/SalesOrderCVSTrace/listUnshipped", {
    template: "shipping/salesordercvstrace-listunshipped.html",
    title: "超過30天未出貨",
    groupBuy: "none",
    jsp: "/backend/SalesOrderCVSTrace/list_unshipped.jsp",
  }),
  { path: "/ajax/SalesOrderCVSTrace/list", method: ["GET", "POST"], handler: listCvs },
  { path: "/ajax/SalesOrderCVSTrace/listPickup", method: ["GET", "POST"], handler: listPickup },
  { path: "/ajax/SalesOrderCVSTrace/listUnshipped", method: ["GET", "POST"], handler: listUnshipped },
  post("/ajax/SalesOrderCVSTrace/markAsPicked", markAsPicked),
  post("/ajax/SalesOrderCVSTrace/markAsComplete", markAsComplete),
  post("/ajax/SalesOrderCVSTrace/sendSMS", sendSMS),
  post("/ajax/SalesOrderCVSTrace/save", unsupported),
  post("/ajax/SalesOrderCVSTrace/update", unsupported),
  post("/ajax/SalesOrderCVSTrace/action", unsupported),
  get("/ajax/SalesOrderCVSTrace/getCvsReturnStats", getCvsReturnStats),
  // /x/ 不是 /ajax/ 開頭（預設 public）→ 明確要求後台登入
  { path: "/x/ajax/SalesOrder/orderItems", method: "GET", auth: "admin", handler: orderItems },
  get("/ajax/Sms/getBalance", smsBalance),
];
