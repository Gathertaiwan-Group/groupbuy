// 所有訂單頁的批次操作與列操作（原站 salesOrderList.min.js / salesOrder.js 呼叫的端點）。
// 回應格式依各呼叫端：
//   DataTableConfig.actionButton（確認框）→ 成功 actionOk(訊息)；失敗 HTTP 4xx {error}（顯示在確認框）
//   initAjaxForm 表單（取消訂單、設為已出貨、拆單…）→ {code:200, error:訊息, data:[…]}
//   Editor（寄信、更新超取小白單、設為準備出貨中）→ {data:[…]}（另帶 message/notIntegrated）
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, post, requireSession } from "@/lib/core/http/route-helpers";
import { HttpError, badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { actionOk, json, jsonError } from "@/lib/core/http/responses";
import { editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import type { Row } from "@/lib/db/mapping";
import { select2Params, select2Response, select2Initial } from "@/lib/core/select2";
import { taipeiDateTime } from "@/lib/core/time";
import {
  addOrderHistory,
  adminUpdateOrders,
  db,
  esc,
  fetchOrder,
  fetchOrderByUuid,
  fetchOrders,
  idsParam,
  parseIds,
  recordEmail,
  strParam,
} from "./common";
import { loadOrdersApi } from "./order-api";
import { buildSearchParams, searchOrders, type SearchInput } from "./order-search";
import {
  consumeOrderStockUndoable,
  emailTemplateContent,
  EMAIL_TEMPLATES,
  nextPaymentDue,
  recomputeShippingTags,
  releaseOrderStock,
} from "./order-ops";
import { recalcOrderAmounts } from "./pricing";
import { couponCodeHasQuota } from "@/lib/modules/marketing/usage-release";
import { joinPlan } from "./join-plan";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const nowIso = () => new Date().toISOString();

/** 選取的訂單 id（actionButton 送 salesOrderId=1,2,3；表單可能送 salesOrderIds） */
async function selectedIds(ctx: RequestContext): Promise<number[]> {
  const ids = await idsParam(ctx, "salesOrderId", "salesOrderIds");
  if (!ids.length) throw badRequest("請先選擇訂單");
  return ids;
}

/* ─────────────────────────── 取消／還原 ─────────────────────────── */

/** POST /ajax/SalesOrder/cancelOrder（取消訂單表單：salesOrderId=1,2、staffNote） */
async function cancelOrder(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const staffNote = await strParam(ctx, "staffNote");
  const rows = await fetchOrders(session, ids, "id,state,staff_note");
  const target = rows.filter((r) => !["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(r.state)));
  if (!target.length) throw badRequest("所選訂單皆無法取消（已取消／已合併／已拆單）");
  await releaseOrderStock(session, target.map((r) => Number(r.id)));
  for (const r of target) {
    const patch: Row = { state: "CANCELED", date_canceled: nowIso() };
    if (staffNote) patch.staff_note = [r.staff_note, staffNote].filter((x) => x && String(x).trim()).join("\n");
    await adminUpdateOrders(session, [Number(r.id)], patch, `取消訂單${staffNote ? `：${staffNote}` : ""}`);
  }
  return json({ code: 200, error: `成功取消 ${target.length} 筆訂單`, message: `成功取消 ${target.length} 筆訂單`, data: target.map((r) => Number(r.id)) });
}

/** POST /ajax/SalesOrder/undoCancelOrder（還原已取消訂單：重新扣庫存、重新計算金額） */
async function undoCancelOrder(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const rows = (await fetchOrders(session, ids, "id,state,status,total_paid")).filter((r) => r.state === "CANCELED");
  if (!rows.length) throw badRequest("所選訂單中沒有「已取消」的訂單");
  const restored: number[] = [];
  const problems: string[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const stock = await consumeOrderStockUndoable(session, [id]);
    if (stock.short.length) {
      problems.push(`${id}：庫存不足 ${stock.short.join("、")}`);
      continue;
    }
    // 客人要求取消的訂單還原時狀態改回付款前/後的一般狀態，其餘維持原狀態
    const patch: Row = { state: "PROCESSING", date_canceled: null };
    if (r.status === "INQUIRED_CANCEL" || r.status === "RESERVATION_CANCELED") patch.status = num(r.total_paid) > 0 ? "PAID_EMAIL_SENT" : "ORDER_EMAIL_SENT";
    try {
      // 名額由 DB 觸發器重新占用；折扣碼／優惠活動已被其他訂單用滿 → 整筆擋下（8004，adminUpdateOrders 轉成 400）
      await adminUpdateOrders(session, [id], patch, "還原已取消訂單");
    } catch (e) {
      await stock.undo();
      if (e instanceof HttpError && e.status === 400) {
        problems.push(`${id}：${e.message}`);
        continue;
      }
      throw e;
    }
    await recalcOrderAmounts(session, id, { shipping: true, salesRules: false });
    restored.push(id);
  }
  if (!restored.length) throw badRequest(`無法還原：${problems.join("；")}`);
  return actionOk(`已還原 ${restored.length} 筆訂單${problems.length ? `；未還原：${problems.join("；")}` : ""}`, { data: restored });
}

/* ─────────────────────────── 付款 ─────────────────────────── */

/** POST /ajax/SalesOrder/markAsPaid：「處理中」訂單設為已付款並寄「已付款通知信」（未串接） */
async function markAsPaid(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const rows = await fetchOrders(session, ids, "id,state,grand_total,total_paid,customer_email,group_buy_id");
  const target = rows.filter((r) => r.state === "PROCESSING");
  if (!target.length) throw badRequest("僅能將「處理中」的訂單設為已付款");
  let mailMsg = "";
  for (const r of target) {
    const id = Number(r.id);
    const paid = num(r.total_paid) > 0 ? num(r.total_paid) : num(r.grand_total);
    const c = await emailTemplateContent(session, id, "PAYMENT_RECEIVED");
    mailMsg = await recordEmail(session, { salesOrderId: id, groupBuyId: (r.group_buy_id as number) ?? null, template: "PAYMENT_RECEIVED", toEmail: String(r.customer_email ?? ""), subject: c.subject, body: c.body });
    await adminUpdateOrders(session, [id], { total_paid: paid, date_paid: nowIso(), status: "PAID_EMAIL_SENT" }, `設為已付款，寄送已付款通知信${mailMsg}`);
  }
  const skipped = rows.length - target.length;
  return actionOk(`已設為已付款 ${target.length} 筆${skipped ? `（略過非處理中 ${skipped} 筆）` : ""}；${mailMsg}`, { notIntegrated: true });
}

/** POST /ajax/SalesOrder/extendPaymentDue：展延繳款期限並寄展延通知信（未串接） */
async function extendPaymentDue(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const rows = await fetchOrders(session, ids, "id,state,total_paid,group_buy_id,customer_email");
  const target = rows.filter((r) => (r.state === "NEW" || r.state === "PROCESSING") && num(r.total_paid) === 0);
  if (!target.length) throw badRequest("所選訂單皆已付款或非處理中，無需展延");
  let mailMsg = "";
  for (const r of target) {
    const id = Number(r.id);
    const due = await nextPaymentDue(session, (r.group_buy_id as number) ?? null);
    await adminUpdateOrders(session, [id], { date_payment_due: due.toISOString() }, `展延繳款日期至 ${taipeiDateTime(due)}`);
    const c = await emailTemplateContent(session, id, "PAYMENT_EXTENSION");
    mailMsg = await recordEmail(session, { salesOrderId: id, groupBuyId: (r.group_buy_id as number) ?? null, template: "PAYMENT_EXTENSION", toEmail: String(r.customer_email ?? ""), subject: c.subject, body: c.body });
    await addOrderHistory(session, id, `寄送繳款期限展延通知信${mailMsg}`);
  }
  return actionOk(`已展延 ${target.length} 筆訂單的繳款期限；${mailMsg}`, { notIntegrated: true });
}

/* ─────────────────────────── 合併訂單 ─────────────────────────── */

/**
 * POST /ajax/SalesOrder/join：合併「處理中」且狀態（不含寄信中）/電話/Email 相同的訂單。
 * 每組以最早建立的訂單為主單：其他訂單的商品移入主單，金額相加（只保留主單運費），其他訂單階段改為「已合併」並記錄關聯 COMBINE。
 */
async function joinOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const rows = await fetchOrders(session, ids, "id,uuid,state,status,customer_telephone,customer_email,created_at");
  // 分組決定母單（最早建立）後，搬商品／合併同品項／搬優惠明細與名額帳本／母單金額／關聯／子單改已合併
  // 全部在 DB 函式 orders_join_orders 的單一交易內完成（8004）；任何一步失敗整筆回滾，不會半搬
  const plan = joinPlan(rows);
  if (plan.length) {
    const { error } = await db().rpc("orders_join_orders", {
      p_tenant_id: session.tenantId,
      p_admin_user_id: session.adminUserId,
      p_groups: plan.map((p) => ({ parentId: p.parentId, childIds: p.childIds })),
    });
    if (error) {
      if (/ORD_JOIN_STATE/.test(error.message)) throw badRequest("訂單階段或狀態已變更（需為「處理中」且非寄信中），請重新整理後再合併");
      if (/MKT_MERGE_PARENT_OFF/.test(error.message)) throw badRequest("主訂單已取消或刪除，無法合併");
      throw new Error(`[orders] 合併訂單失敗：${error.message}`);
    }
  }
  const merged = plan.reduce((n, p) => n + p.childIds.length, 0);
  const primaries = plan.map((p) => p.parentId);
  if (!merged) throw badRequest("沒有可合併的訂單（需為「處理中」且狀態、電話、Email 相同的兩筆以上訂單）");
  return actionOk(`已合併 ${merged} 筆訂單至 ${primaries.length} 筆主訂單`, { data: primaries });
}

/* ─────────────────────────── 綁定顧客 ─────────────────────────── */

/** POST /ajax/SalesOrder/bindCustomer：依 Email（找不到再依電話）綁定已註冊會員 */
async function bindCustomer(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = (await idsParam(ctx, "salesOrderId"))[0];
  const o = await fetchOrder(session, id, "id,customer_id,customer_email,customer_telephone");
  if (o.customer_id) throw badRequest("此訂單已綁定會員");
  const client = db();
  let customer: { id: number; firstname: string | null } | null = null;
  const email = String(o.customer_email ?? "").trim();
  if (email) {
    const { data } = await client.from("customers").select("id,firstname").eq("tenant_id", session.tenantId).ilike("email", email).limit(1);
    customer = ((data ?? []) as { id: number; firstname: string | null }[])[0] ?? null;
  }
  const tel = String(o.customer_telephone ?? "").trim();
  if (!customer && tel) {
    const { data } = await client.from("customers").select("id,firstname").eq("tenant_id", session.tenantId).eq("telephone", tel).limit(1);
    customer = ((data ?? []) as { id: number; firstname: string | null }[])[0] ?? null;
  }
  if (!customer) throw badRequest("找不到相同 Email 或電話號碼的會員");
  await adminUpdateOrders(session, [id], { customer_id: customer.id }, `綁定顧客 #${customer.id}${customer.firstname ? ` ${customer.firstname}` : ""}`);
  return actionOk(`已綁定會員 ${customer.firstname ?? ""}（#${customer.id}）`);
}

/* ─────────────────────────── 貨運標籤 / 超取 ─────────────────────────── */

/** POST /ajax/SalesOrder/updateShippingTag：所選訂單（未選則全部符合目前篩選）依商品重算貨運標籤 */
async function updateShippingTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  let ids = await idsParam(ctx, "salesOrderId");
  if (!ids.length) {
    const body = await ctx.body();
    const extra: Record<string, unknown> = {};
    body.flat.forEach((v, k) => (extra[k] = v[0]));
    ctx.query.forEach((v, k) => (extra[k] = v));
    const input: SearchInput = { extra, columns: [], order: [], start: 0, length: -1 };
    const p = await buildSearchParams(session, input);
    ids = (await searchOrders(session, p)).ids;
  }
  const changed = await recomputeShippingTags(session, ids);
  return actionOk(`已更新 ${changed} 筆訂單的貨運標籤`);
}

/** POST /ajax/SalesOrder/markAsCVSDateDued：「準備出貨中」訂單設為「商品逾期未領」 */
async function markAsCvsDateDued(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const rows = await fetchOrders(session, ids, "id,status");
  const target = rows.filter((r) => r.status === "PREPARE_SHIPPING").map((r) => Number(r.id));
  if (!target.length) throw badRequest("僅能設定狀態為「準備出貨中」的訂單");
  await adminUpdateOrders(session, target, { status: "CVS_PICKUP_DATE_DUED" }, "設為未取貨（商品配達逾期未取）");
  return actionOk(`已將 ${target.length} 筆訂單設為未取貨`);
}

/** POST /ajax/SalesOrder/acquireCvsShippingNumber（綠界取得托運單號）：物流未串接 */
async function acquireCvsShippingNumber(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await selectedIds(ctx);
  const n = notIntegrated("綠界物流取得托運單號");
  for (const id of (await fetchOrders(session, ids, "id")).map((r) => Number(r.id))) await addOrderHistory(session, id, `綠界取得托運單號${n.message}`);
  return jsonError(400, n.message, { notIntegrated: true });
}

/** POST /ajax/SalesOrder/renewCVSPickup（更新超取小白單 Editor：uuids 換行多筆、print）：物流未串接 */
async function renewCvsPickup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const values = (req.rows[0]?.values ?? {}) as Record<string, unknown>;
  const uuids = String(values.uuids ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!uuids.length) throw badRequest("需要至少一筆訂單編號");
  if (uuids.length > 100) throw badRequest("訂單上限為100筆");
  const { data } = await db().from("sales_orders").select("id,uuid").eq("tenant_id", session.tenantId).in("uuid", uuids);
  const found = (data ?? []) as { id: number; uuid: string }[];
  const n = notIntegrated("更新超取小白單（綠界物流）");
  for (const o of found) await addOrderHistory(session, o.id, `更新超取小白單${n.message}`);
  const missing = uuids.filter((u) => !found.some((f) => f.uuid === u));
  return json({ code: 400, error: `${n.message}${missing.length ? `（找不到訂單：${missing.join("、")}）` : ""}`, notIntegrated: true });
}

/** GET /ajax/SalesOrder/reauthPeriod：信用卡定期定額重新授權（原站以 $.ajax GET 呼叫 → 不改資料；金流未串接，前端以 messagebox 顯示 error） */
async function reauthPeriod(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = (await idsParam(ctx, "salesOrderId"))[0];
  await fetchOrder(session, id, "id");
  const n = notIntegrated("信用卡定期定額重新授權（金流）");
  return actionOk(n.message, { notIntegrated: true });
}

/* ─────────────────────────── 寄信 ─────────────────────────── */

/** GET /ajax/SalesOrder/emailTemplate?salesOrderId=&template= → {data:{subject, body}} */
async function emailTemplate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const template = (await strParam(ctx, "template")) || "CUSTOM";
  if (!EMAIL_TEMPLATES[template]) throw badRequest("找不到 Email 樣板");
  const c = await emailTemplateContent(session, id, template);
  return json({ code: 200, data: c });
}

/** POST /ajax/SalesOrder/sendEmail（Editor create：template、email、salesOrderId、subject、body） */
async function sendEmail(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const v = (req.rows[0]?.values ?? {}) as Record<string, unknown>;
  const id = Number(v.salesOrderId);
  const o = await fetchOrder(session, id, "id,group_buy_id,customer_email");
  const email = String(v.email ?? o.customer_email ?? "").trim();
  const errors: { name: string; status: string }[] = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ name: "email", status: "Email 格式錯誤" });
  if (!String(v.subject ?? "").trim()) errors.push({ name: "subject", status: "欄位必填不得為空" });
  if (!String(v.body ?? "").trim()) errors.push({ name: "body", status: "欄位必填不得為空" });
  if (errors.length) return json({ fieldErrors: errors, data: [] });
  const template = String(v.template ?? "") || "CUSTOM";
  const msg = await recordEmail(session, { salesOrderId: id, groupBuyId: (o.group_buy_id as number) ?? null, template, toEmail: email, subject: String(v.subject), body: String(v.body) });
  await addOrderHistory(session, id, `寄信「${String(v.subject)}」至 ${email}${msg}`);
  return editorResponse([{ salesOrderId: id }], { notIntegrated: true, message: msg });
}

/* ─────────────────────────── 設為已出貨 ─────────────────────────── */

async function markAsShippedFragment(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const ids = await idsParam(ctx, "salesOrderId");
  const rows = await fetchOrders(session, ids, "id,uuid,customer_firstname,shipping_type,shipping_receipt_number,total_paid,payment_method,state,status");
  const orders = rows.map((r) => {
    const pickup = r.shipping_type === "PICKUP";
    const unpaid = num(r.total_paid) === 0 && ![8, 16, 64].includes(Number(r.payment_method));
    const warn = r.state !== "PROCESSING" ? "非處理中訂單" : unpaid ? "未付款請勿出貨" : "";
    return {
      salesOrderId: r.id,
      uuid: r.uuid,
      customerFirstname: r.customer_firstname ?? "",
      shippingReceiptNumber: pickup ? (r.shipping_receipt_number || "自取") : (r.shipping_receipt_number ?? ""),
      pickup,
      sendEmail: !pickup,
      warning: warn,
    };
  });
  return { salesOrderId: ids.join(","), uuid: rows.map((r) => r.uuid).join(","), orders };
}

/** POST /ajax/SalesOrder/markAsShipped（設為已出貨表單） */
async function markAsShipped(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const dateStr = (await strParam(ctx, "dateShippedString")) || taipeiDateTime(new Date()).slice(0, 10);
  const dateShipped = /^\d{4}-\d{2}-\d{2}/.test(dateStr) ? new Date(`${dateStr.slice(0, 10)}T12:00:00+08:00`) : new Date();
  const list = body.nested.salesOrders;
  const entries: { id: number; srn: string; send: boolean; pickup: boolean }[] = [];
  const items = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, unknown>;
    const id = Number(o.salesOrderId);
    if (!id) continue;
    entries.push({ id, srn: String(o.shippingReceiptNumber ?? "").trim(), send: String(o.status ?? "") === "1", pickup: String(o.pickup ?? "") === "1" });
  }
  if (!entries.length) {
    for (const id of await idsParam(ctx, "salesOrderId")) entries.push({ id, srn: "", send: true, pickup: false });
  }
  if (!entries.length) throw badRequest("請先選擇訂單");
  const rows = await fetchOrders(session, entries.map((e) => e.id), "id,state,customer_email,group_buy_id");
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  let done = 0;
  let mailMsg = "";
  for (const e of entries) {
    const r = byId.get(e.id);
    if (!r || ["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(r.state))) continue;
    const srn = e.pickup ? e.srn || "自取" : e.srn;
    const patch: Row = { date_shipped: dateShipped.toISOString(), status: e.send ? "SHIPPING_EMAIL_SENT" : "SHIPPED" };
    if (srn) patch.shipping_receipt_number = srn;
    let note = `設為已出貨（${dateStr.slice(0, 10)}）${srn ? ` 查貨號碼 ${srn}` : ""}`;
    if (e.send) {
      const c = await emailTemplateContent(session, e.id, "SHIPMENT_NOTICE");
      mailMsg = await recordEmail(session, { salesOrderId: e.id, groupBuyId: (r.group_buy_id as number) ?? null, template: "SHIPMENT_NOTICE", toEmail: String(r.customer_email ?? ""), subject: c.subject, body: c.body });
      note += `，寄送出貨信${mailMsg}`;
    }
    await adminUpdateOrders(session, [e.id], patch, note);
    await db().from("order_items").update({ state: "SHIPPED" }).eq("tenant_id", session.tenantId).eq("sales_order_id", e.id).in("state", ["UNSHIPPING", "SHIPPING"]);
    done++;
  }
  if (!done) throw badRequest("沒有可設為已出貨的訂單");
  return json({ code: 200, error: `成功 ${done} 筆${mailMsg ? `；${mailMsg}` : ""}`, message: `成功 ${done} 筆`, data: entries.map((e) => e.id) });
}

/* ─────────────────────────── 拆單（搬移訂單商品） ─────────────────────────── */

/** POST /ajax/SalesOrder/moveOrderItems（拆單表單：orderItems[i].orderItemId / .total、toUuid、status=INQUIRED_RETURN、uniqueAddress） */
async function moveOrderItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const fromId = Number(await strParam(ctx, "salesOrderId"));
  const from = await fetchOrder(session, fromId);
  const picks: { orderItemId: number; total: number }[] = [];
  const idx = new Map<string, { orderItemId?: number; total?: number }>();
  body.flat.forEach((vals, k) => {
    const m = k.match(/^orderItems\[(\d+)\]\.(orderItemId|total)$/);
    if (!m) return;
    const cur = idx.get(m[1]) ?? {};
    if (m[2] === "orderItemId") cur.orderItemId = Number(vals[0]);
    else cur.total = Number(vals[0]);
    idx.set(m[1], cur);
  });
  for (const v of idx.values()) if (v.orderItemId) picks.push({ orderItemId: v.orderItemId, total: Math.trunc(Number(v.total ?? 0)) });
  if (!picks.length) throw badRequest("請勾選要拆單的商品");
  const client = db();
  const { data: itemRows } = await client.from("order_items").select("*").eq("tenant_id", session.tenantId).eq("sales_order_id", fromId);
  const items = (itemRows ?? []) as Row[];
  for (const p of picks) {
    const it = items.find((i) => Number(i.id) === p.orderItemId);
    if (!it) throw badRequest("訂單商品不存在");
    if (!(p.total > 0) || p.total > num(it.total)) throw badRequest(`「${it.title}」數量需介於 1～${it.total}`);
  }
  const status = await strParam(ctx, "status");
  const toUuid = status ? "" : await strParam(ctx, "toUuid");
  let target: Row;
  let created = false;
  if (toUuid) {
    const t = await fetchOrderByUuid(session, toUuid);
    if (!t) throw notFound("訂單物件不存在");
    if (Number(t.id) === fromId) throw badRequest("不可拆單至同一張訂單");
    target = t;
  } else {
    // 建立新訂單：複製訂購人／收件人／付款等資料
    const copy: Row = { ...from };
    for (const k of ["id", "uuid", "created_at", "updated_at", "log", "invoice_number", "date_einvoice", "shipping_receipt_number", "date_shipped", "virtual_bank_account", "store_payment_code"]) delete copy[k];
    Object.assign(copy, {
      grand_total: 0,
      shipping_amount: 0,
      cod_fee: 0,
      extra_fee: 0,
      discount_amount: 0,
      total_paid: 0,
      action: "NONE",
      state: status ? "RETURNING" : "PROCESSING",
      status: status || from.status,
      staff_note: `拆單自 ${from.uuid}`,
    });
    const { data, error } = await client.from("sales_orders").insert(copy).select("*").single();
    if (error) throw new Error(`[orders] 建立拆單訂單失敗：${error.message}`);
    target = data as Row;
    created = true;
    await client
      .from("sales_order_histories")
      .update({ actor: "ADMIN", admin_user_id: session.adminUserId, note: `拆單自 ${from.uuid}` })
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", target.id);
    await client.from("sales_order_relations").insert({
      tenant_id: session.tenantId,
      parent_sales_order_id: fromId,
      sales_order_id: target.id,
      // 原站說明：新訂單設為「退貨中／退貨申請中」，待收到貨品檢核完整後再取消新訂單釋放庫存 → 仍是拆單關聯（SPLIT）
      relation: "SPLIT",
      staff_note: status ? "拆單：退貨申請中" : null,
    });
  }
  const toId = Number(target.id);
  const { data: maxSeq } = await client.from("order_items").select("seq").eq("tenant_id", session.tenantId).eq("sales_order_id", toId).order("seq", { ascending: false }).limit(1);
  let seq = num((maxSeq?.[0] as { seq?: number } | undefined)?.seq);
  const movedNames: string[] = [];
  let movedDisc = 0;
  for (const p of picks) {
    const it = items.find((i) => Number(i.id) === p.orderItemId)!;
    seq += 1;
    if (p.total >= num(it.total)) {
      await client.from("order_items").update({ sales_order_id: toId, seq }).eq("tenant_id", session.tenantId).eq("id", it.id);
      movedDisc += Math.round(num(it.discount));
    } else {
      const keep = num(it.total) - p.total;
      const movedD = Math.round((num(it.discount) * p.total) / Math.max(1, num(it.total)));
      const keepD = Math.round(num(it.discount)) - movedD;
      await client
        .from("order_items")
        .update({ total: keep, discount: keepD, amount: Math.round(num(it.price) * keep - keepD) })
        .eq("tenant_id", session.tenantId)
        .eq("id", it.id);
      const copy: Row = { ...it };
      delete copy.id;
      delete copy.created_at;
      delete copy.updated_at;
      Object.assign(copy, { sales_order_id: toId, seq, total: p.total, discount: movedD, amount: Math.round(num(it.price) * p.total - movedD), parent_order_item_id: null });
      await client.from("order_items").insert(copy);
      movedDisc += movedD;
    }
    movedNames.push(`${it.title}×${p.total}`);
  }
  if (await strParam(ctx, "uniqueAddress")) {
    await addOrderHistory(session, toId, "訂單地址不共用");
  }
  await addOrderHistory(session, fromId, `拆單：${movedNames.join("、")} → ${target.uuid}`);
  await recalcOrderAmounts(session, fromId, { shipping: false, salesRules: false, discountDelta: -movedDisc });
  await recalcOrderAmounts(session, toId, { shipping: false, salesRules: false, discountDelta: movedDisc });
  void created;
  return json({ code: 200, error: `已拆單至訂單 ${target.uuid}`, message: `已拆單至訂單 ${target.uuid}`, data: [toId] });
}

/* ─────────────────────────── 訂單優惠卷 ─────────────────────────── */

/** GET /ajax/SalesOrderCoupon/list?salesOrderId= → {data:[{groupBuyFlatRateShippingId(=id), coupon:{title,code,discount}, discount}]} */
async function couponList(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  await fetchOrder(session, id, "id");
  const { data } = await db()
    .from("sales_order_coupons")
    .select("id,coupon,discount,points,group_buy_coupons(title,discount,dollar_or_percentage),coupon_codes(code)")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", id)
    .order("id");
  const rows = ((data ?? []) as unknown as Row[]).map((r) => {
    const gbc = (r.group_buy_coupons ?? {}) as Row;
    const cc = (r.coupon_codes ?? {}) as Row;
    return {
      salesOrderCouponId: r.id,
      groupBuyFlatRateShippingId: r.id,
      discount: num(r.discount),
      coupon: { title: gbc.title ?? r.coupon ?? "", code: cc.code ?? r.coupon ?? "", discount: num(gbc.discount) },
    };
  });
  return json({ code: 200, data: rows });
}

/** 後台使用／移除優惠卷的名額調整（migration 8002 marketing_order_coupon_adjust：used_count＋帳本＋優惠卷統計，單一交易） */
async function adjustOrderCouponUsage(tenantId: number, salesOrderId: number, couponCodeId: number, delta: 1 | -1): Promise<void> {
  const { error } = await db().rpc("marketing_order_coupon_adjust", { p_tenant_id: tenantId, p_sales_order_id: salesOrderId, p_coupon_code_id: couponCodeId, p_delta: delta });
  if (error) {
    // 8004：+1 時在 DB 鎖住折扣碼後原子檢查上限（JS 的 couponCodeHasQuota 只是預檢，並行時以 DB 為準）
    if (/MKT_COUPON_USED_UP/.test(error.message)) throw badRequest("優惠碼已達使用上限");
    if (/MKT_ORDER_OFF/.test(error.message)) throw badRequest("此訂單階段無法使用優惠卷");
    throw new Error(`[orders] 調整優惠卷使用次數失敗：${error.message}`);
  }
}

/** POST /ajax/SalesOrderCoupon/delete（groupBuyFlatRateShippingId＝訂單優惠卷 id） */
async function couponDelete(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "groupBuyFlatRateShippingId")) || Number(await strParam(ctx, "salesOrderCouponId"));
  const { data } = await db().from("sales_order_coupons").select("id,sales_order_id,coupon,coupon_code_id,discount").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!data) throw notFound("找不到優惠卷");
  const c = data as Row;
  await db().from("sales_order_coupons").delete().eq("tenant_id", session.tenantId).eq("id", id);
  // 名額：used_count、帳本、優惠卷統計在同一交易調整（8002；已取消訂單的名額早已退回，不會重複扣）
  if (c.coupon_code_id) await adjustOrderCouponUsage(session.tenantId, Number(c.sales_order_id), Number(c.coupon_code_id), -1);
  await addOrderHistory(session, Number(c.sales_order_id), `移除優惠卷 ${c.coupon ?? ""}`);
  await recalcOrderAmounts(session, Number(c.sales_order_id), { shipping: false, salesRules: false, discountDelta: -num(c.discount) });
  return actionOk("已移除優惠卷");
}

/** POST /ajax/SalesOrderCoupon/redeem（salesOrderId、code）：驗證折扣碼並套用到訂單 */
async function couponRedeem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const code = (await strParam(ctx, "code")).trim();
  if (!code) throw badRequest("請輸入優惠碼");
  const o = await fetchOrder(session, id, "id,group_buy_id,customer_id,grand_total,shipping_amount,cod_fee,extra_fee,discount_amount,state");
  if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(o.state))) throw badRequest("此訂單階段無法使用優惠卷");
  const client = db();
  const { data: ccRows } = await client
    .from("coupon_codes")
    .select("id,code,customer_id,max_uses,used_count,is_active,group_buy_coupon_id,group_buy_coupons(id,group_buy_id,title,category,dollar_or_percentage,discount,minimum,available_quota,apply_to_all_group_buy,is_active)")
    .eq("tenant_id", session.tenantId)
    .eq("code", code)
    .limit(1);
  const cc = ((ccRows ?? []) as unknown as Row[])[0];
  const gbc = (cc?.group_buy_coupons ?? null) as Row | null;
  if (!cc || !gbc) throw badRequest("優惠碼不存在");
  if (cc.is_active === false || gbc.is_active === false) throw badRequest("優惠碼已停用");
  if (!gbc.apply_to_all_group_buy && gbc.group_buy_id && Number(gbc.group_buy_id) !== Number(o.group_buy_id)) throw badRequest("此優惠碼不適用於本團購");
  if (cc.customer_id && Number(cc.customer_id) !== Number(o.customer_id)) throw badRequest("此優惠碼僅限指定會員使用");
  if (!couponCodeHasQuota({ usedCount: num(cc.used_count), maxUses: num(cc.max_uses), availableQuota: num(gbc.available_quota) })) throw badRequest("優惠碼已達使用上限");
  const { data: dup } = await client.from("sales_order_coupons").select("id").eq("tenant_id", session.tenantId).eq("sales_order_id", id).eq("coupon_code_id", cc.id).limit(1);
  if ((dup ?? []).length) throw badRequest("此訂單已使用過此優惠碼");
  const { data: its } = await client.from("order_items").select("amount").eq("tenant_id", session.tenantId).eq("sales_order_id", id);
  const subtotal = ((its ?? []) as { amount: number }[]).reduce((s, r) => s + num(r.amount), 0);
  if (num(gbc.minimum) > 0 && subtotal < num(gbc.minimum)) throw badRequest(`訂單金額未達優惠卷使用門檻 $${num(gbc.minimum)}`);
  const pct = String(gbc.dollar_or_percentage ?? "").toUpperCase().includes("PERCENT");
  const discount = Math.round(pct ? (subtotal * num(gbc.discount)) / 100 : num(gbc.discount));
  // 先占名額（DB 原子檢查上限，用滿 → 400 不寫明細），再寫訂單優惠明細；明細寫入失敗時把名額退回
  await adjustOrderCouponUsage(session.tenantId, id, Number(cc.id), 1);
  const { error: insErr } = await client.from("sales_order_coupons").insert({
    tenant_id: session.tenantId,
    sales_order_id: id,
    group_buy_coupon_id: gbc.id,
    coupon_code_id: cc.id,
    coupon: code,
    discount,
  });
  if (insErr) {
    await adjustOrderCouponUsage(session.tenantId, id, Number(cc.id), -1);
    throw new Error(`[orders] 寫入訂單優惠卷失敗：${insErr.message}`);
  }
  await addOrderHistory(session, id, `使用優惠卷 ${code}（折抵 $${discount}）`);
  await recalcOrderAmounts(session, id, { shipping: false, salesRules: false, discountDelta: discount });
  return actionOk(`已套用優惠碼 ${code}`);
}

/* ─────────────────────────── 超商取貨資訊 ─────────────────────────── */

const CVS_TYPE_SUB: Record<string, string> = { UNIMART: "UNIMART", FAMI: "FAMI", FAMI_FROZEN: "FAMI", PICKUP: "PICKUP" };

/** GET /ajax/SalesOrderCvs/getInfo?salesOrderId= → {data:{CVSStoreID,CVSStoreName,CVSAddress,LogisticsSubType,AllPayLogisticsID,ShipmentNo,defaultCvsType}} */
async function cvsGetInfo(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const o = await fetchOrder(session, id, "id,cvs_type,cvs_store_id,cvs_store_name,cvs_address,cvsmap_response,shipping_receipt_number");
  const map = (o.cvsmap_response ?? {}) as Row;
  const cvsType = String(o.cvs_type ?? map.LogisticsSubType ?? "");
  return json({
    code: 200,
    data: {
      CVSStoreID: o.cvs_store_id ?? map.CVSStoreID ?? null,
      CVSStoreName: o.cvs_store_name ?? map.CVSStoreName ?? null,
      CVSAddress: o.cvs_address ?? map.CVSAddress ?? null,
      LogisticsSubType: CVS_TYPE_SUB[cvsType] ?? (cvsType || null),
      AllPayLogisticsID: map.AllPayLogisticsID ?? null,
      ShipmentNo: map.ShipmentNo ?? null,
      defaultCvsType: cvsType || "UNIMART",
    },
  });
}

async function cvsNotIntegrated(ctx: RequestContext, feature: string): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  await fetchOrder(session, id, "id");
  const n = notIntegrated(feature);
  await addOrderHistory(session, id, `${feature}${n.message}`);
  return jsonError(400, n.message, { notIntegrated: true });
}

/** POST /ajax/SalesOrderCvs/clearCvs：移除訂單的超商門市 */
async function cvsClear(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const o = await fetchOrder(session, id, "id,cvs_store_name");
  await adminUpdateOrders(session, [id], { cvs_store_id: null, cvs_store_name: null, cvs_address: null, cvsmap_response: null }, `移除超商門市 ${o.cvs_store_name ?? ""}`);
  return actionOk("已移除超商");
}

/** POST /ajax/SalesOrderCvs/updateCvsStore?salesOrderId=（CvsLookup 選擇門市，JSON：cvsType/storeCode/storeName/postalCode/address） */
async function cvsUpdateStore(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(ctx.query.get("salesOrderId") ?? (await strParam(ctx, "salesOrderId")));
  const o = await fetchOrder(session, id, "id,cvsmap_response");
  const body = await ctx.body();
  const s = (body.json ?? {}) as Row;
  const storeCode = String(s.storeCode ?? (await strParam(ctx, "storeCode")) ?? "").trim();
  if (!storeCode) throw badRequest("請選擇門市");
  const cvsType = String(s.cvsType ?? "").toUpperCase();
  const map = { ...((o.cvsmap_response ?? {}) as Row), CVSStoreID: storeCode, CVSStoreName: s.storeName ?? null, CVSAddress: s.address ?? null, LogisticsSubType: CVS_TYPE_SUB[cvsType] ?? (cvsType || null) };
  await adminUpdateOrders(
    session,
    [id],
    { cvs_store_id: storeCode, cvs_store_name: s.storeName ?? null, cvs_address: s.address ?? null, cvs_type: ["UNIMART", "FAMI", "FAMI_FROZEN", "PICKUP"].includes(cvsType) ? cvsType : null, cvsmap_response: map },
    `變更超商門市：${s.storeName ?? storeCode}`,
  );
  return actionOk("已變更超商門市");
}

/* ─────────────────────────── 設為準備出貨中（salesOrder.js → ShippingRecord） ─────────────────────────── */

/** POST /ajax/ShippingRecord/markAsPrepareShipping（Editor create：shippingRecord=none|exists|new、salesOrderIds、shippingRecordId） */
async function markAsPrepareShipping(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const v = (req.rows[0]?.values ?? {}) as Record<string, unknown>;
  const ids = parseIds(v.salesOrderIds ?? req.extra.salesOrderIds ?? req.extra.salesOrderId);
  if (!ids.length) throw badRequest("請先選擇訂單");
  const rows = await fetchOrders(session, ids, "id,state,status,group_buy_id");
  const bad = rows.filter((r) => r.state !== "PROCESSING" || r.status === "PREPARE_SHIPPING");
  if (bad.length) throw badRequest("僅能篩選階段為「處理中」且狀態不為「準備出貨中」之訂單");
  const mode = String(v.shippingRecord ?? "none");
  const client = db();
  let recordId: number | null = null;
  if (mode === "exists") {
    recordId = Number(v.shippingRecordId) || null;
    if (!recordId) return json({ fieldErrors: [{ name: "shippingRecordId", status: "請選擇出貨紀錄" }], data: [] });
    const { data } = await client.from("shipping_records").select("id").eq("tenant_id", session.tenantId).eq("id", recordId).maybeSingle();
    if (!data) return json({ fieldErrors: [{ name: "shippingRecordId", status: "找不到出貨紀錄" }], data: [] });
  } else if (mode === "new") {
    const gbIds = [...new Set(rows.map((r) => r.group_buy_id).filter(Boolean))];
    const { data, error } = await client
      .from("shipping_records")
      .insert({ tenant_id: session.tenantId, group_buy_id: gbIds.length === 1 ? gbIds[0] : null, purpose: "SHIP", admin_user_id: session.adminUserId, order_count: ids.length, file_name: `準備出貨中 ${taipeiDateTime(new Date())}` })
      .select("id")
      .single();
    if (error) throw new Error(`[orders] 建立出貨紀錄失敗：${error.message}`);
    recordId = Number((data as { id: number }).id);
  }
  await adminUpdateOrders(session, ids, { status: "PREPARE_SHIPPING" }, `設為準備出貨中${recordId ? `（出貨紀錄 #${recordId}）` : ""}`);
  await client.from("order_items").update({ state: "SHIPPING" }).eq("tenant_id", session.tenantId).in("sales_order_id", ids).eq("state", "UNSHIPPING");
  if (recordId) {
    const { data: exist } = await client.from("shipping_record_orders").select("sales_order_id").eq("tenant_id", session.tenantId).eq("shipping_record_id", recordId);
    const have = new Set(((exist ?? []) as { sales_order_id: number }[]).map((e) => Number(e.sales_order_id)));
    const add = ids.filter((id) => !have.has(id));
    if (add.length) await client.from("shipping_record_orders").insert(add.map((id) => ({ tenant_id: session.tenantId, shipping_record_id: recordId, sales_order_id: id })));
    const { count } = await client.from("shipping_record_orders").select("id", { count: "exact", head: true }).eq("tenant_id", session.tenantId).eq("shipping_record_id", recordId);
    await client.from("shipping_records").update({ order_count: count ?? add.length }).eq("tenant_id", session.tenantId).eq("id", recordId);
  }
  return editorResponse(ids.map((id) => ({ salesOrderId: id })), { code: 200 });
}

/** GET /ajax/ShippingRecord/lookup（select2：出貨紀錄） */
async function shippingRecordLookup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const client = db();
  const label = (r: { id: number; file_name: string | null; created_at: string; order_count: number }) =>
    `#${r.id} ${r.file_name ?? ""} ${taipeiDateTime(r.created_at)}（${r.order_count ?? 0} 筆）`.replace(/\s+/g, " ").trim();
  if (p.initialValue) {
    const { data } = await client.from("shipping_records").select("id,file_name,created_at,order_count").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    return select2Initial(((data ?? []) as { id: number; file_name: string | null; created_at: string; order_count: number }[]).map((r) => ({ id: r.id, text: label(r) })));
  }
  let q = client.from("shipping_records").select("id,file_name,created_at,order_count").eq("tenant_id", session.tenantId);
  const term = p.term.replace(/[,()"\\*%]/g, " ").trim();
  if (term) q = /^\d+$/.test(term) ? q.eq("id", Number(term)) : q.ilike("file_name", `%${term}%`);
  const { data } = await q.order("id", { ascending: false }).range((p.page - 1) * 30, p.page * 30);
  return select2Response(((data ?? []) as { id: number; file_name: string | null; created_at: string; order_count: number }[]).map((r) => ({ id: r.id, text: label(r) })));
}

/* ─────────────────────────── 更改配送方式（推導） ─────────────────────────── */

async function editShippingRuleData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const id = Number(await strParam(ctx, "salesOrderId"));
  const o = await fetchOrder(session, id);
  const client = db();
  const { data } = await client
    .from("group_buy_flat_rate_shippings")
    .select("seq, flat_rate_shippings(id,title,shipping_type,y,z,x,category)")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", o.group_buy_id ?? 0)
    .order("seq");
  let rules = ((data ?? []) as unknown as { flat_rate_shippings: Row | null }[]).map((r) => r.flat_rate_shippings).filter(Boolean) as Row[];
  if (!rules.length) {
    const { data: all } = await client.from("flat_rate_shippings").select("id,title,shipping_type,y,z,x,category").eq("tenant_id", session.tenantId).order("seq");
    rules = (all ?? []) as Row[];
  }
  const typeLabel: Record<string, string> = { NORMAL: "宅配", PICKUP: "自取", CVS: "超商取貨", INTL: "國際配送", NOD: "不需配送", HK_SF: "順豐站(香港)" };
  return {
    salesOrderId: id,
    uuid: o.uuid,
    order: {
      shippingFirstname: o.shipping_firstname ?? "",
      shippingTelephone: o.shipping_telephone ?? "",
      shippingPostcode: o.shipping_postcode ?? "",
      shippingCity: o.shipping_city ?? "",
      shippingDistrict: o.shipping_district ?? "",
      shippingStreet: o.shipping_street ?? "",
      shippingAmount: num(o.shipping_amount),
    },
    rules: rules.map((r) => ({
      id: r.id,
      title: r.title,
      typeLabel: typeLabel[String(r.shipping_type)] ?? r.shipping_type,
      fee: num(r.y),
      selected: Number(r.id) === Number(o.flat_rate_shipping_id),
    })),
  };
}

/** POST /ajax/SalesOrder/updateShippingRule（更改配送方式表單） */
async function updateShippingRule(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  const ruleId = Number(await strParam(ctx, "flatRateShippingId"));
  const o = await fetchOrder(session, id, "id,state");
  if (!["PROCESSING", "HOLDED"].includes(String(o.state))) throw badRequest("僅能更改「處理中／保留」訂單的配送方式");
  const { data: rule } = await db().from("flat_rate_shippings").select("id,title,shipping_type").eq("tenant_id", session.tenantId).eq("id", ruleId).maybeSingle();
  if (!rule) throw badRequest("請選擇配送方式");
  const r = rule as Row;
  const patch: Row = { flat_rate_shipping_id: ruleId, shipping_type: r.shipping_type };
  for (const [param, col] of [
    ["shippingFirstname", "shipping_firstname"],
    ["shippingTelephone", "shipping_telephone"],
    ["shippingPostcode", "shipping_postcode"],
    ["shippingCity", "shipping_city"],
    ["shippingDistrict", "shipping_district"],
    ["shippingStreet", "shipping_street"],
  ] as const) {
    const v = await ctx.param(param);
    if (v !== undefined) patch[col] = String(v).trim() || null;
  }
  await adminUpdateOrders(session, [id], patch, `更改配送方式：${r.title}`);
  let msg = `已更改配送方式為「${r.title}」`;
  let shippingAmount: number | null = null;
  if ((await strParam(ctx, "recalculate")) === "1") {
    const rr = await recalcOrderAmounts(session, id, { shipping: true, salesRules: false });
    msg += `，結帳金額 $${rr.grandTotal}（運費 $${rr.shippingAmount}）`;
    shippingAmount = Number(rr.shippingAmount);
  }
  return json({ code: 200, error: msg, message: msg, data: { shippingAmount } });
}

/* ─────────────────────────── 顧客資訊（推導） ─────────────────────────── */

async function customerInfoData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const customerId = Number(await strParam(ctx, "customerId"));
  if (!customerId) throw badRequest("缺少參數 customerId");
  const client = db();
  const { data: c } = await client
    .from("customers")
    .select("id,uuid,firstname,email,telephone,birthday,is_activated,points,tags,note,loyalty_card_number,created_at,last_login_at,royalty_program_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", customerId)
    .maybeSingle();
  if (!c) throw notFound("找不到顧客");
  const cu = c as Row;
  const { data: orders } = await client
    .from("sales_orders")
    .select("id,uuid,state,grand_total,total_paid,created_at,group_buys(title)")
    .eq("tenant_id", session.tenantId)
    .eq("customer_id", customerId)
    .neq("state", "DELETED")
    .order("created_at", { ascending: false })
    .limit(20);
  const { enumOptions } = await import("@/lib/core/enums");
  const stateLabel = new Map((await enumOptions("SalesOrder.state")).map((o) => [String(o.value), o.label]));
  const list = (orders ?? []) as unknown as Row[];
  const { data: fb } = await client.from("facebook_auths").select("name,picture_url").eq("tenant_id", session.tenantId).eq("customer_id", customerId).limit(1);
  return {
    customer: {
      id: cu.id,
      firstname: cu.firstname ?? "",
      email: cu.email ?? "",
      telephone: cu.telephone ?? "",
      birthday: cu.birthday ?? "",
      activated: !!cu.is_activated,
      points: num(cu.points),
      tags: cu.tags ?? "",
      note: cu.note ?? "",
      loyaltyCardNumber: cu.loyalty_card_number ?? "",
      dateCreatedString: taipeiDateTime(cu.created_at),
      lastLoginString: taipeiDateTime(cu.last_login_at),
    },
    facebook: ((fb ?? []) as Row[])[0] ?? null,
    orderCount: list.length,
    orderTotal: list.filter((o) => !["CANCELED", "DELETED"].includes(String(o.state))).reduce((s, o) => s + num(o.grand_total), 0),
    orders: list.map((o) => ({
      salesOrderId: o.id,
      uuid: o.uuid,
      state: stateLabel.get(String(o.state)) ?? o.state,
      grandTotal: num(o.grand_total),
      totalPaid: num(o.total_paid),
      dateCreatedString: taipeiDateTime(o.created_at),
      groupBuyTitle: ((o.group_buys ?? {}) as Row).title ?? "",
    })),
  };
}

/* ─────────────────────────── 列印設定 ─────────────────────────── */

const PRINT_SETTINGS_DEFAULT = {
  hideBillingInfo: false,
  maskBillingInfo: false,
  maskShippingInfo: false,
  hidePrice: false,
  showLogo: false,
  colorPrint: true,
  showReferralStaff: false,
  showUpc: false,
  showUid: true,
  fontSize: "normal",
};

export async function loadPrintSettings(session: AdminSession): Promise<Record<string, unknown>> {
  const { data } = await db()
    .from("order_module_settings")
    .select("settings")
    .eq("tenant_id", session.tenantId)
    .is("group_buy_id", null)
    .eq("name", "salesOrderPrintSettings")
    .maybeSingle();
  return { ...PRINT_SETTINGS_DEFAULT, ...(((data as Row | null)?.settings ?? {}) as Row) };
}

/** GET/POST /ajax/SystemPreference/salesOrderPrintSettings（列印頁設定；POST data[0][欄位]） */
async function printSettings(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  if (ctx.method === "POST") {
    const body = await ctx.body();
    const d = (((body.nested.data as Record<string, unknown> | undefined) ?? {})["0"] ?? {}) as Record<string, unknown>;
    const settings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      if (!(k in PRINT_SETTINGS_DEFAULT)) continue;
      settings[k] = typeof (PRINT_SETTINGS_DEFAULT as Record<string, unknown>)[k] === "boolean" ? String(v) === "true" || String(v) === "1" : String(v);
    }
    const client = db();
    const { data: existing } = await client.from("order_module_settings").select("id").eq("tenant_id", session.tenantId).is("group_buy_id", null).eq("name", "salesOrderPrintSettings").maybeSingle();
    if (existing) await client.from("order_module_settings").update({ settings }).eq("tenant_id", session.tenantId).eq("id", (existing as Row).id);
    else await client.from("order_module_settings").insert({ tenant_id: session.tenantId, name: "salesOrderPrintSettings", settings });
    return json({ code: 200, data: [settings] });
  }
  return json({ code: 200, data: await loadPrintSettings(session) });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const salesOrderActionRoutes: RouteDef[] = [
  // 取消／還原
  fragment("/backend/SalesOrder/displayCancelOrder", {
    template: "orders/salesorder-cancel.html",
    method: ["GET", "POST"],
    data: async (ctx) => ({ salesOrderId: (await idsParam(ctx, "salesOrderId")).join(",") }),
  }),
  post("/ajax/SalesOrder/cancelOrder", cancelOrder),
  post("/ajax/SalesOrder/undoCancelOrder", undoCancelOrder),
  // 付款／展延
  post("/ajax/SalesOrder/markAsPaid", markAsPaid),
  post("/ajax/SalesOrder/extendPaymentDue", extendPaymentDue),
  // 合併訂單（工具列 actionButton；Editor join 也指向同一端點）
  post("/ajax/SalesOrder/join", joinOrders),
  // 綁定顧客
  post("/ajax/SalesOrder/bindCustomer", bindCustomer),
  // 出貨
  fragment("/backend/SalesOrder/markAsShipped", { template: "orders/salesorder-markasshipped.html", method: ["GET", "POST"], data: markAsShippedFragment }),
  post("/ajax/SalesOrder/markAsShipped", markAsShipped),
  post("/ajax/SalesOrder/updateShippingTag", updateShippingTag),
  post("/ajax/ShippingRecord/markAsPrepareShipping", markAsPrepareShipping, { priority: 900 }),
  get("/ajax/ShippingRecord/lookup", shippingRecordLookup, { priority: 900 }),
  // 超取
  post("/ajax/SalesOrder/markAsCVSDateDued", markAsCvsDateDued),
  post("/ajax/SalesOrder/acquireCvsShippingNumber", acquireCvsShippingNumber),
  post("/ajax/SalesOrder/renewCVSPickup", renewCvsPickup),
  fragment("/ajax/SalesOrderCvs/displayInfo", {
    template: "orders/salesordercvs-info.html",
    method: ["GET", "POST"],
    data: async (ctx) => {
      const id = Number(await strParam(ctx, "salesOrderId"));
      await fetchOrder(ctx.session, id, "id");
      return { salesOrderId: id };
    },
  }),
  get("/ajax/SalesOrderCvs/getInfo", cvsGetInfo),
  post("/ajax/SalesOrderCvs/cancelCvsPaymentNo", (ctx) => cvsNotIntegrated(ctx, "取消超商取貨條（綠界物流）")),
  post("/ajax/SalesOrderCvs/acquireCvsNumber", (ctx) => cvsNotIntegrated(ctx, "更新/取得超商取貨條（綠界物流）")),
  post("/ajax/SalesOrderCvs/clearCvs", cvsClear),
  post("/ajax/SalesOrderCvs/updateCvsStore", cvsUpdateStore),
  // 寄信／授權
  get("/ajax/SalesOrder/emailTemplate", emailTemplate),
  post("/ajax/SalesOrder/sendEmail", sendEmail),
  { path: "/ajax/SalesOrder/reauthPeriod", method: ["GET", "POST"], handler: reauthPeriod },
  // 拆單（搬移商品）
  fragment("/backend/SalesOrder/displayMoveOrderItems", {
    template: "orders/salesorder-moveorderitems.html",
    method: ["GET", "POST"],
    data: async (ctx) => {
      const id = Number(await strParam(ctx, "salesOrderId"));
      await fetchOrder(ctx.session, id, "id");
      return { salesOrderId: id };
    },
  }),
  post("/ajax/SalesOrder/moveOrderItems", moveOrderItems),
  // 優惠卷
  fragment("/backend/SalesOrder/displayCoupon", {
    template: "orders/salesorder-coupon.html",
    method: ["GET", "POST"],
    data: async (ctx) => {
      const id = Number(await strParam(ctx, "salesOrderId"));
      await fetchOrder(ctx.session, id, "id");
      return { salesOrderId: id };
    },
  }),
  get("/ajax/SalesOrderCoupon/list", couponList),
  post("/ajax/SalesOrderCoupon/delete", couponDelete),
  post("/ajax/SalesOrderCoupon/redeem", couponRedeem),
  // 更改配送方式（推導）
  fragment("/backend/SalesOrder/editShippingRule", { template: "orders/salesorder-editshippingrule.html", method: ["GET", "POST"], data: editShippingRuleData }),
  post("/ajax/SalesOrder/updateShippingRule", updateShippingRule),
  // 顧客資訊（推導）
  fragment("/ajax/Customer/displaySimpleInfo", { template: "orders/customer-simpleinfo.html", method: ["GET", "POST"], data: customerInfoData }),
  // 列印設定
  { path: "/ajax/SystemPreference/salesOrderPrintSettings", method: ["GET", "POST"], handler: printSettings, priority: 900 },
];

export { esc };
