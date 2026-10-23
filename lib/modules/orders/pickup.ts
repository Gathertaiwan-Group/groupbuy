// 自取訂單（/backend/SalesOrder/pickup，原站 spec/html/salesorder-pickup.html）＋訂單明細（推導）。
//   GET  /backend/SalesOrder/pickup[?uuid=]          輸入訂單編號查詢；找到時於表單下方顯示訂單明細與「確認取貨」（推導）
//   POST /ajax/SalesOrder/pickup                     確認取貨（現場付款者一併設為已付款）→ 已出貨、已完成
//   GET  /backend/SalesOrder/show?salesOrderId=|uuid= 訂單明細彈窗（推導：訂購人、收件人、商品、付款、物流、發票、優惠、歷程）
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { renderModulePage } from "@/lib/core/render/layout";
import { enumOptions } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import type { Row } from "@/lib/db/mapping";
import { adminUpdateOrders, db, fetchOrder, fetchOrderByUuid, strParam } from "./common";
import { loadOrdersApi } from "./order-api";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

/** 訂單明細模板資料（templates/orders/partials/order-detail.html 的 o） */
export async function orderDetailView(session: AdminSession, salesOrderId: number): Promise<Row> {
  const [o] = await loadOrdersApi(session, [salesOrderId]);
  if (!o) throw notFound("訂單物件不存在");
  const m = async (k: string) => new Map((await enumOptions(k)).map((x) => [String(x.value), x.label]));
  const [state, status, pay, ship, prov, deliver, rtype, ctype, inst, action, oiState] = await Promise.all([
    m("SalesOrder.state"),
    m("SalesOrder.status"),
    m("SalesOrder.paymentMethod"),
    m("ShippingType"),
    m("SalesOrder.shippingProvider"),
    m("SalesOrder.deliverTime"),
    m("SalesOrder.receiptType"),
    m("SalesOrder.receiptCarrierType"),
    m("SalesOrder.installment"),
    m("SalesOrder.action"),
    m("OrderItem.state"),
  ]);
  const billing = (o.salesOrderBillingAddress ?? {}) as Row;
  const client = db();
  const [{ data: rules }, { data: rule }, { data: admins }] = await Promise.all([
    client.from("sales_order_sales_rules").select("title,discount,points").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId),
    o.flatRateShippingId
      ? client.from("flat_rate_shippings").select("title").eq("tenant_id", session.tenantId).eq("id", o.flatRateShippingId).maybeSingle()
      : Promise.resolve({ data: null }),
    client.from("admin_users").select("id,account").eq("tenant_id", session.tenantId),
  ]);
  const adminName = new Map(((admins ?? []) as { id: number; account: string }[]).map((a) => [a.id, a.account]));
  const histories = (o.histories ?? []) as Row[];
  return {
    ...o,
    stateLabel: state.get(String(o.state)) ?? o.state,
    statusLabel: status.get(String(o.status)) ?? o.status,
    mismatch: o.status === "PAID_AMOUNT_MISMATCHED",
    paymentMethodLabel: pay.get(String(o.paymentMethod)) ?? "",
    installmentLabel: billing.installment && billing.installment !== "NONE" ? inst.get(String(billing.installment)) ?? "" : "",
    shippingTypeLabel: ship.get(String(o.shippingType)) ?? "",
    shippingProviderLabel: prov.get(String(o.shippingProvider)) ?? "",
    deliverTimeLabel: deliver.get(String(o.deliverTime)) ?? "",
    receiptTypeLabel: rtype.get(String(billing.receiptType)) ?? "",
    carrierTypeLabel: ctype.get(String(billing.receiptCarrierType)) ?? "",
    isPickup: o.shippingType === "PICKUP",
    isCvs: o.shippingType === "CVS",
    ruleTitle: (rule as { title?: string } | null)?.title ?? "",
    salesRules: (rules ?? []) as Row[],
    hasPromotion:
      ((o.salesOrderCoupons as Row[]) ?? []).length > 0 || ((rules ?? []) as Row[]).length > 0 || ((o.pointTransactions as Row[]) ?? []).length > 0,
    sortedOrderItems: ((o.sortedOrderItems ?? []) as Row[]).map((i) => ({ ...i, stateLabel: oiState.get(String(i.state)) ?? i.state })),
    historyRows: histories.map((h) => ({
      time: h.dateCreatedString,
      actor: h.actor === "ADMIN" ? (h.adminUserId ? adminName.get(Number(h.adminUserId)) ?? "管理員" : "管理員") : h.actor === "CUSTOMER" ? "顧客" : "系統",
      state: h.stateTo ? `${h.stateFrom ? `${state.get(String(h.stateFrom)) ?? h.stateFrom}→` : ""}${state.get(String(h.stateTo)) ?? h.stateTo}` : "",
      status: h.statusTo ? `${h.statusFrom ? `${status.get(String(h.statusFrom)) ?? h.statusFrom}→` : ""}${status.get(String(h.statusTo)) ?? h.statusTo}` : "",
      note: [h.action && h.action !== "NONE" ? `進階操作：${action.get(String(h.action)) ?? h.action}` : "", h.note ?? ""].filter(Boolean).join("；"),
    })),
  };
}

/** GET /backend/SalesOrder/pickup[?uuid=] */
async function pickupPage(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const uuid = (ctx.query.get("uuid") ?? "").trim();
  let order: Row | null = null;
  let messageHtml = "";
  if (uuid) {
    const row = await fetchOrderByUuid(session, uuid, "id");
    if (row) order = await orderDetailView(session, Number(row.id));
    else messageHtml = '<div class="alert alert-warning">\n\t\t<button type="button" class="close" data-dismiss="alert">×</button>\n\t\t訂單物件不存在</div>\n';
  }
  const canPickup = !!order && ["PROCESSING", "HOLDED", "NEW"].includes(String(order.state)) && !["SHIPPED", "SHIPPING_EMAIL_SENT"].includes(String(order.status));
  return renderModulePage(
    ctx,
    "orders/salesorder-pickup.html",
    { uuid, order, o: order, canPickup, needPay: !!order && num(order.totalPaid) === 0 },
    { title: "訂單", jsp: order ? "/backend/SalesOrder/pickup.jsp" : "/backend/SalesOrder/pickupNoUuid.jsp", messageHtml, activeHref: "/backend/SalesOrder/pickup" },
  );
}

/** POST /ajax/SalesOrder/pickup（確認取貨） */
async function confirmPickup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const o = await fetchOrder(session, id);
  if (!["PROCESSING", "HOLDED", "NEW"].includes(String(o.state))) throw badRequest("此訂單階段無法取貨");
  if (["SHIPPED", "SHIPPING_EMAIL_SENT"].includes(String(o.status))) throw badRequest("此訂單已取貨／已出貨");
  const now = new Date().toISOString();
  const patch: Row = { state: "COMPLETE", status: "SHIPPED", date_shipped: now, date_completed: now, shipping_receipt_number: o.shipping_receipt_number || "自取" };
  let note = "自取訂單：確認取貨";
  if (num(o.total_paid) === 0 && (await strParam(ctx, "paid")) === "1") {
    patch.total_paid = num(o.grand_total);
    patch.date_paid = now;
    note += `，現場收款 $${num(o.grand_total)}`;
  }
  await adminUpdateOrders(session, [id], patch, note);
  await db().from("order_items").update({ state: "SHIPPED" }).eq("tenant_id", session.tenantId).eq("sales_order_id", id).in("state", ["UNSHIPPING", "SHIPPING"]);
  return json({ code: 200, error: `訂單 ${o.uuid} 已完成取貨`, message: `訂單 ${o.uuid} 已完成取貨` });
}

export const pickupRoutes: RouteDef[] = [
  { path: "/backend/SalesOrder/pickup", method: "GET", handler: pickupPage },
  post("/ajax/SalesOrder/pickup", confirmPickup),
  fragment("/backend/SalesOrder/show", {
    template: "orders/salesorder-show.html",
    method: ["GET", "POST"],
    data: async (ctx) => {
      let id = Number(await strParam(ctx, "salesOrderId"));
      const uuid = await strParam(ctx, "uuid");
      if (!id && uuid) id = Number((await fetchOrderByUuid(ctx.session, uuid, "id"))?.id ?? 0);
      const o = await orderDetailView(ctx.session, id);
      return { o, printedAt: taipeiDateTime(new Date()) };
    },
  }),
];
