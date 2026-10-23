// 所有訂單（/backend/SalesOrder/list）與單一團購訂單（同頁 ?groupBuyId=）。
// 原站：spec/html/salesorder-list.html、salesorder-list-by-groupbuy.html；前端邏輯原封不動用原站
// public/public/scripts/backend/salesOrderList.min.js（SalesOrderModule）＋ public/scripts/salesOrder.js、salesOrderBulkUuids.js。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/SalesOrder/list[?groupBuyId=]      頁面
//   GET  /ajax/GroupBuy/jsonOptions                  團購下拉 [{value,label}]
//   POST /ajax/SalesOrder/list                       列表（serverSide；回應另含 b2sTotal）
//   GET  /ajax/SalesOrder/get?salesOrderId=|uuid=    單筆（拆單彈窗等用）
//   POST /ajax/SalesOrder/save|update|delete         Editor 新增／修改／刪除（刪除＝階段改為已刪除，列表不再顯示）
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, HttpError, badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { entities } from "@/lib/db/entities";
import { apiToRow, type Row } from "@/lib/db/mapping";
import { enumOptions } from "@/lib/core/enums";
import { adminUpdateOrders, db, fetchOrder, fetchOrderByUuid, fetchOrders, strParam } from "./common";
import { loadOrdersApi } from "./order-api";
import { buildSearchParams, countAllOrders, searchInputFromDt, searchOrders } from "./order-search";
import { orderListOptions } from "./order-options";
import { countB2sOrders } from "./b2s";
import { afterOrderEdit, releaseOrderStock } from "./order-ops";
import { salesOrderActionRoutes } from "./sales-order-actions";
import { salesOrderExportRoutes } from "./sales-order-export";
import { salesOrderImportRoutes } from "./sales-order-import";
import { splitRoutes } from "./split";
import { pickupRoutes } from "./pickup";

/* ─────────────────────────── 頁面 ─────────────────────────── */

function pagePermissions(perms: Record<string, unknown>) {
  // 原站 salesOrderConf.permissions；本帳號全部可用（isPaidDisabled=false）。admin_users.permissions 可個別關閉。
  const flag = (k: string, def: boolean) => (perms[k] === undefined ? def : perms[k] === true);
  return {
    canCreate: flag("salesOrderCreate", true),
    canUpdate: flag("salesOrderUpdate", true),
    canDelete: flag("salesOrderDelete", true),
    canExport: flag("salesOrderExport", true),
    canAction: flag("salesOrderAction", true),
    isFinance: flag("salesOrderFinance", true),
    isAdvanced: flag("salesOrderAdvanced", true),
    isAdvancedMarkAsShipped: flag("salesOrderMarkAsShipped", true),
    isPaidDisabled: flag("salesOrderPaidDisabled", false),
  };
}

/* ─────────────────────────── 列表 ─────────────────────────── */

async function listSalesOrders(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const input = searchInputFromDt(dt);
  if (!dt.serverSide) input.length = -1;
  const p = await buildSearchParams(session, input);
  const groupBuyId = (p.group_buy_id as number | undefined) ?? null;
  const [{ ids, total }, recordsTotal, options, b2sTotal] = await Promise.all([
    searchOrders(session, p),
    countAllOrders(session, groupBuyId),
    orderListOptions(session, groupBuyId),
    countB2sOrders(session, groupBuyId),
  ]);
  const rows = await loadOrdersApi(session, ids);
  return dtResponse(dt, { rows, recordsTotal, recordsFiltered: total, options, extra: { b2sTotal } }, started);
}

/** GET /ajax/GroupBuy/jsonOptions：所有訂單頁的「團購」下拉（value 為數字，原站 indexOf 比對） */
async function groupBuyJsonOptions(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const { data, error } = await db()
    .from("group_buys")
    .select("id,title")
    .eq("tenant_id", session.tenantId)
    .order("id", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`[orders] 讀取團購失敗：${error.message}`);
  return json(((data ?? []) as { id: number; title: string }[]).map((g) => ({ value: g.id, label: g.title })));
}

/** GET /ajax/SalesOrder/get?salesOrderId=|uuid=：{ data: 訂單 } */
async function getSalesOrder(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId")) || null;
  const uuid = await strParam(ctx, "uuid");
  let orderId = id;
  if (!orderId && uuid) {
    const row = await fetchOrderByUuid(session, uuid, "id");
    if (!row) throw notFound("訂單物件不存在");
    orderId = Number(row.id);
  }
  if (!orderId) throw badRequest("訂單物件不存在");
  const [api] = await loadOrdersApi(session, [orderId]);
  if (!api) throw notFound("訂單物件不存在");
  return json({ code: 200, data: api });
}

/* ─────────────────────────── Editor ─────────────────────────── */

/** Editor 送來但不可直接寫入的鍵（推導/唯讀/動作參數） */
const NON_WRITABLE = new Set([
  "salesOrderId",
  "uuid",
  "log",
  "dateModified",
  "dateModifiedString",
  "dateCreated",
  "dateCreatedString",
  "groupBuyAccountId",
  "shouldRegenVirtualBankAccount",
  "shouldResetCVS",
  "shouldUpdateGrandTotalAndShipping",
  "shouldUpdateSalesRules",
  "shouldUpdateShippingTag",
  "dateLastSms",
]);

async function validateOrderValues(values: Row, action: "create" | "edit"): Promise<{ name: string; status: string }[]> {
  const errs: { name: string; status: string }[] = [];
  const inEnum = async (key: string, enumKey: string, name: string) => {
    if (!(name in values)) return;
    const v = String(values[name] ?? "");
    if (v === "" && action === "edit") return;
    if (v === "") return;
    const ok = (await enumOptions(enumKey)).some((o) => String(o.value) === v);
    if (!ok) errs.push({ name, status: "選項錯誤" });
    void key;
  };
  await inEnum("state", "SalesOrder.state", "state");
  await inEnum("status", "SalesOrder.status", "status");
  await inEnum("action", "SalesOrder.action", "action");
  for (const k of ["grandTotal", "shippingAmount", "totalPaid", "codFee", "extraFee"]) {
    if (!(k in values)) continue;
    const s = String(values[k] ?? "").trim().replace(/,/g, "");
    if (s !== "" && !Number.isFinite(Number(s))) errs.push({ name: k, status: "請輸入數字" });
  }
  for (const k of ["customerEmail", "salesOrderShippingAddress.email"]) {
    const s = String(values[k] ?? "").trim();
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errs.push({ name: k, status: "Email 格式錯誤" });
  }
  if (action === "create") {
    if (!String(values.customerFirstname ?? "").trim()) errs.push({ name: "customerFirstname", status: "需要填寫內容" });
  }
  return errs;
}

/** Editor 值 → DB 列（只含可寫入欄位） */
function toDbPatch(values: Row, existing?: Row): Row {
  const v: Row = {};
  for (const [k, val] of Object.entries(values)) if (!NON_WRITABLE.has(k)) v[k] = val;
  // 空字串的數值/日期欄位轉 null 或 0
  const patch = apiToRow(entities.salesOrder, v, existing ?? null);
  for (const k of ["grand_total", "shipping_amount", "total_paid", "cod_fee", "extra_fee"]) {
    if (k in patch && (patch[k] === null || patch[k] === undefined)) patch[k] = 0;
  }
  if ("flat_rate_shipping_id" in patch && !patch.flat_rate_shipping_id) patch.flat_rate_shipping_id = null;
  if ("customer_id" in patch && !patch.customer_id) patch.customer_id = null;
  if ("billing_country" in patch && !patch.billing_country) patch.billing_country = "TW";
  if ("shipping_country" in patch && !patch.shipping_country) patch.shipping_country = "TW";
  if ("billing_receipt_type" in patch && !patch.billing_receipt_type) patch.billing_receipt_type = 1;
  if ("billing_receipt_carrier_type" in patch && (patch.billing_receipt_carrier_type === null || patch.billing_receipt_carrier_type === undefined)) {
    patch.billing_receipt_carrier_type = 0;
  }
  if ("billing_installment" in patch && !patch.billing_installment) patch.billing_installment = "NONE";
  if ("deliver_time" in patch && (patch.deliver_time === null || patch.deliver_time === undefined)) patch.deliver_time = 0;
  if ("payment_method" in patch && (patch.payment_method === null || patch.payment_method === undefined)) patch.payment_method = 0;
  if ("shipping_provider" in patch && !patch.shipping_provider) patch.shipping_provider = "NONE";
  if ("shipping_type" in patch && !patch.shipping_type) patch.shipping_type = "NORMAL";
  if ("action" in patch && !patch.action) patch.action = "NONE";
  if ("state" in patch && !patch.state) delete patch.state;
  if ("status" in patch && !patch.status) delete patch.status;
  if ("shipping_tag" in patch && patch.shipping_tag == null) patch.shipping_tag = "";
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  return patch;
}

async function editorSalesOrder(ctx: RequestContext, expected: "create" | "edit" | "remove"): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== expected) throw badRequest("不支援的操作");
  const client = db();

  if (req.action === "create") {
    const groupBuyId = Number(req.extra.groupBuyId ?? 0) || null;
    if (!groupBuyId) throw badRequest("請先在「團購」選擇要新增訂單的團購");
    const { data: gb } = await client.from("group_buys").select("id").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
    if (!gb) throw badRequest("找不到此團購");
    const createdIds: number[] = [];
    for (const row of req.rows) {
      const values = flattenDotted(row.values);
      const errs = await validateOrderValues(values, "create");
      if (errs.length) throw new FieldErrors(errs);
      const patch = toDbPatch(values);
      const insert: Row = {
        state: "PROCESSING",
        status: "ORDER_EMAIL_SENT",
        ...patch,
        action: "NONE",
        tenant_id: session.tenantId,
        group_buy_id: groupBuyId,
      };
      const { data, error } = await client.from("sales_orders").insert(insert).select("id").single();
      if (error) throw new Error(`[orders] 新增訂單失敗：${error.message}`);
      const id = Number((data as { id: number }).id);
      createdIds.push(id);
      // 觸發器寫的「建立訂單」歷程補上操作者
      await client
        .from("sales_order_histories")
        .update({ actor: "ADMIN", admin_user_id: session.adminUserId, note: "後台新增訂單" })
        .eq("tenant_id", session.tenantId)
        .eq("sales_order_id", id);
    }
    return editorResponse(await loadOrdersApi(session, createdIds));
  }

  const ids = editorIds(req, "salesOrderId");
  if (req.action === "remove") {
    const rows = await fetchOrders(session, ids, "id,state");
    if (rows.length !== ids.length) throw notFound("找不到資料（可能已被刪除）");
    await releaseOrderStock(session, rows.map((r) => Number(r.id)));
    await adminUpdateOrders(session, ids, { state: "DELETED" }, "刪除訂單");
    return editorResponse([]);
  }

  // edit
  const existingRows = await fetchOrders(session, ids);
  const byId = new Map(existingRows.map((r) => [Number(r.id), r]));
  const notices: string[] = [];
  for (const row of req.rows.length ? req.rows : ids.map((id) => ({ id: String(id), values: {} }))) {
    const id = Number(row.id);
    const existing = byId.get(id);
    if (!existing) throw notFound("找不到資料（可能已被刪除）");
    const values = flattenDotted(row.values);
    // 樂觀鎖：列資料的 dateModified（毫秒）早於 DB updated_at → 已被他人修改
    const lockMs = Number(values.dateModified ?? req.extra.dateModified);
    if (Number.isFinite(lockMs) && lockMs > 0 && existing.updated_at) {
      if (new Date(String(existing.updated_at)).getTime() > lockMs + 1000) {
        throw new HttpError(409, "此訂單已被其他人修改，請重新整理頁面後再編輯");
      }
    }
    const errs = await validateOrderValues(values, "edit");
    if (errs.length) throw new FieldErrors(errs);
    const patch = toDbPatch(values, existing);
    const requestedAction = String(patch.action ?? "NONE");
    delete patch.action;
    if (Object.keys(patch).length) await adminUpdateOrders(session, [id], patch, "後台編輯訂單");
    notices.push(
      ...(await afterOrderEdit(session, id, {
        action: requestedAction,
        regenVirtualBankAccount: isChecked(values.shouldRegenVirtualBankAccount),
        resetCvs: isChecked(values.shouldResetCVS),
        updateGrandTotalAndShipping: isChecked(values.shouldUpdateGrandTotalAndShipping),
        updateSalesRules: isChecked(values.shouldUpdateSalesRules),
        updateShippingTag: isChecked(values.shouldUpdateShippingTag),
      })),
    );
  }
  const rows = await loadOrdersApi(session, ids);
  const extra: Record<string, unknown> = {};
  if (notices.length) extra.message = notices.join("\n");
  if (notices.some((n) => n.includes("【未串接】"))) extra.notIntegrated = true;
  return editorResponse(rows, extra);
}

function isChecked(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => isChecked(x));
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on";
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const salesOrderListRoutes: RouteDef[] = [
  page("/backend/SalesOrder/list", {
    template: "orders/salesorder-list.html",
    title: "訂單",
    groupBuy: "auto",
    async data(ctx) {
      const raw = ctx.query.get("groupBuyId");
      if (raw && raw !== "0" && !ctx.groupBuy) throw notFound("找不到團購");
      const conf = {
        groupBuyId: ctx.groupBuy?.groupBuyId ?? 0,
        customerId: /^\d+$/.test(ctx.query.get("customerId") ?? "") ? ctx.query.get("customerId") : "",
        salesOrderId: /^\d+$/.test(ctx.query.get("salesOrderId") ?? "") ? ctx.query.get("salesOrderId") : "",
        itemUid: (ctx.query.get("itemUid") ?? "").replace(/['"\\<>]/g, ""),
        permissions: pagePermissions(ctx.session.permissions ?? {}),
      };
      return { conf };
    },
  }),
  get("/ajax/GroupBuy/jsonOptions", groupBuyJsonOptions),
  { path: "/ajax/SalesOrder/list", method: ["GET", "POST"], handler: listSalesOrders },
  get("/ajax/SalesOrder/get", getSalesOrder),
  { path: "/ajax/SalesOrder/save", method: "POST", handler: (ctx) => editorSalesOrder(ctx, "create") },
  { path: "/ajax/SalesOrder/update", method: "POST", handler: (ctx) => editorSalesOrder(ctx, "edit") },
  { path: "/ajax/SalesOrder/delete", method: "POST", handler: (ctx) => editorSalesOrder(ctx, "remove") },
  ...salesOrderActionRoutes,
  ...salesOrderExportRoutes,
  ...salesOrderImportRoutes,
  ...splitRoutes,
  ...pickupRoutes,
];

// 供其他檔使用
export { fetchOrder };
