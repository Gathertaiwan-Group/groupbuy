// 金流（綠界 AIO）串接：前往付款、付款結果通知（server-to-server）、ATM／超商代碼取號通知、付款完成導回。
//
// 安全：
// - 通知一律驗 CheckMacValue（特店編號也要相符）；驗章失敗回 0|…（綠界會重送）
// - 付款成功時再向綠界 QueryTradeInfo 回查（狀態＝已付款且金額相符才入帳）；回查不到 → 回 0| 讓綠界稍後重送
// - 入帳在 DB 函式 gateway_apply_payment 單一交易內完成：冪等（重送不重複入帳）、金額檢查、
//   遲到的通知不覆蓋已取消／已退款的訂單（只記錄並提示人工退款）
// - 正式模式拒絕綠界「模擬付款」（SimulatePaid=1）
//
// 端點（public）：
//   POST /gateway/ecpay/payment/notify   ReturnURL
//   POST /gateway/ecpay/payment/info     PaymentInfoURL（ATM 虛擬帳號／超商代碼）
//   POST /gateway/ecpay/payment/result   OrderResultURL（瀏覽器導回；同樣驗章入帳後 303 到訂單頁）
import { queuePaymentEmail } from "@/lib/modules/core/delivery";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post } from "@/lib/core/http/route-helpers";
import { redirect } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { newMerchantTradeNo, type PaymentNotify, type PaymentProvider } from "@/lib/integrations/payment";
import { ack, autoPostPage, callbackBase, ecpayPayment, envSuffix, formOf, linePay } from "./gateway";
import { autoIssueInvoiceOnPaid } from "./invoices";

/** 入帳成功後的後續：排入付款成功通知信、依設定開立電子發票（失敗只記 log，不影響入帳） */
export async function afterPaid(tenantId: number, salesOrderId: number, label = "線上付款"): Promise<void> {
  try {
    // 付款成功通知信（core/delivery.ts queuePaymentEmail：依範本、白名單模式、同一訂單只寄一封）
    await queuePaymentEmail(tenantId, salesOrderId, label);
  } catch (e) {
    console.error("[gateway] 排入已付款通知信失敗", salesOrderId, (e as Error).message);
  }
  try {
    await autoIssueInvoiceOnPaid(tenantId, salesOrderId);
  } catch (e) {
    console.error("[gateway] 自動開立發票失敗", salesOrderId, (e as Error).message);
  }
}

export interface PayableOrder {
  id: number;
  tenant_id: number;
  uuid: string;
  group_buy_id: number | null;
  grand_total: number | string;
  payment_method: number;
  date_payment_due: string | null;
}

/** 前往付款：建立「處理中」交易紀錄 → 自動送出到綠界付款頁 */
export async function startPayment(
  ctx: RequestContext,
  provider: PaymentProvider,
  order: PayableOrder,
  opts: { tenantCode: string; shortUrl: string; gbTitle: string; period?: { type: "D" | "M" | "Y"; frequency: number; execTimes: number } },
): Promise<Response> {
  const amount = Number(order.grand_total);
  if (!(amount > 0) || !Number.isInteger(amount)) throw badRequest("訂單金額無法線上付款");
  const db = getServiceClient();
  const { data: items } = await db
    .from("order_items")
    .select("title, total, bundle_child")
    .eq("tenant_id", order.tenant_id)
    .eq("sales_order_id", order.id)
    .order("seq")
    .order("id");
  const names = ((items ?? []) as { title: string; total: number; bundle_child: boolean }[]).filter((i) => !i.bundle_child).map((i) => `${i.title} x${i.total}`);
  const mtn = newMerchantTradeNo(order.id);
  const { error } = await db.from("sales_order_transactions").insert({
    tenant_id: order.tenant_id,
    sales_order_id: order.id,
    provider: provider.code,
    payment_method: order.payment_method,
    category: "PAYMENT",
    merchant_trade_no: mtn,
    amount,
    status: "PENDING",
    raw_response: { sandbox: provider.sandbox, startedAt: new Date().toISOString() },
  });
  if (error) throw new Error(`[accounting] 建立交易紀錄失敗：${error.message}`);
  const base = callbackBase(ctx);
  const orderUrl = `${base}/${opts.tenantCode}/p/${opts.shortUrl}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`;
  const due = order.date_payment_due ? new Date(order.date_payment_due).getTime() - Date.now() : 0;
  const form = provider.checkoutForm({
    merchantTradeNo: mtn,
    amount,
    paymentMethod: order.payment_method,
    itemNames: names.length ? names : ["團購商品"],
    tradeDesc: `${opts.gbTitle} 訂單 ${order.uuid}`,
    returnUrl: `${base}/gateway/ecpay/payment/notify`,
    orderResultUrl: `${base}/gateway/ecpay/payment/result`,
    clientBackUrl: orderUrl,
    paymentInfoUrl: `${base}/gateway/ecpay/payment/info`,
    atmExpireDays: due > 0 ? Math.max(1, Math.ceil(due / 86400_000)) : 3,
    cvsExpireMinutes: due > 0 ? Math.max(30, Math.ceil(due / 60_000)) : 10080,
    period: opts.period,
    periodReturnUrl: `${base}/gateway/ecpay/payment/period`,
  });
  return autoPostPage("前往付款", form.action, form.fields, "正在前往綠界付款頁，請稍候…");
}

type ApplyResult = { result: string; tenantId?: number; salesOrderId?: number; groupBuyId?: number; reason?: string };

/** 驗章後的付款結果 → 回查 → 入帳；回傳要回給綠界的字串（1|OK 或 0|原因） */
export async function applyNotify(provider: PaymentProvider, n: PaymentNotify, source: string): Promise<{ reply: string; applied: ApplyResult | null }> {
  const db = getServiceClient();
  let success = n.success;
  let note: string;
  if (success && n.simulated && !provider.sandbox) {
    success = false;
    note = "[金流] 正式環境收到模擬付款通知，不入帳";
  } else if (success) {
    const q = await provider.queryTrade(n.merchantTradeNo);
    if (q.status === "UNKNOWN") return { reply: `0|${q.message}`, applied: null };
    if (q.status !== "PAID" || q.amount !== n.amount) {
      console.warn("[gateway] 付款通知與回查結果不符", n.merchantTradeNo, q.status, q.amount, n.amount);
      return { reply: "0|QueryTradeInfo mismatch", applied: null };
    }
    note = `[金流] 付款成功${n.paymentType ? `（${n.paymentType}）` : ""}${envSuffix()}`;
  } else {
    note = `[金流] 付款失敗：${n.message || n.rtnCode}`;
  }
  const { data, error } = await db.rpc("gateway_apply_payment", {
    p_provider: provider.code,
    p_merchant_trade_no: n.merchantTradeNo,
    p_success: success,
    p_amount: n.amount,
    p_trade_no: n.tradeNo || null,
    p_card: n.cardNumber,
    p_auth_code: n.authCode,
    p_paid_at: n.paidAt,
    p_raw: { ...n.raw, _source: source },
    p_note: note,
  });
  if (error) {
    console.error("[gateway] 入帳失敗", n.merchantTradeNo, error.message);
    return { reply: "0|apply failed", applied: null };
  }
  const r = data as ApplyResult;
  if (r.result === "NOT_FOUND") return { reply: "0|order not found", applied: r };
  if (r.result === "PAID" && r.tenantId && r.salesOrderId) await afterPaid(r.tenantId, r.salesOrderId);
  return { reply: provider.ackOk, applied: r };
}

async function notify(ctx: RequestContext): Promise<Response> {
  const provider = ecpayPayment();
  if (!provider) return ack("0|gateway disabled", 503);
  const form = await formOf(ctx);
  const n = provider.parseNotify(form);
  if (!n) {
    console.warn("[gateway] 付款通知驗章失敗", form.MerchantTradeNo ?? "");
    return ack("0|CheckMacValue Error");
  }
  const { reply } = await applyNotify(provider, n, "ReturnURL");
  return ack(reply);
}

/** ATM 虛擬帳號／超商代碼：寫回訂單（訂單頁顯示），交易紀錄留存原始資料 */
async function paymentInfo(ctx: RequestContext): Promise<Response> {
  const provider = ecpayPayment();
  if (!provider) return ack("0|gateway disabled", 503);
  const info = provider.parsePaymentInfo(await formOf(ctx));
  if (!info) return ack("0|CheckMacValue Error");
  const db = getServiceClient();
  const { data: tx } = await db
    .from("sales_order_transactions")
    .select("id, tenant_id, sales_order_id, amount, status, raw_response")
    .eq("provider", provider.code)
    .eq("merchant_trade_no", info.merchantTradeNo)
    .maybeSingle<{ id: number; tenant_id: number; sales_order_id: number; amount: number; status: string; raw_response: Record<string, unknown> | null }>();
  if (!tx) return ack("0|order not found");
  await db
    .from("sales_order_transactions")
    .update({ trade_no: info.tradeNo || null, raw_response: { ...(tx.raw_response ?? {}), paymentInfo: info.raw } })
    .eq("id", tx.id);
  if (info.ok && tx.status === "PENDING" && Number(info.amount) === Number(tx.amount)) {
    const patch: Record<string, unknown> = {};
    let label = "";
    if (info.kind === "ATM" && info.account) {
      patch.virtual_bank_account = `${info.bankCode ?? ""}-${info.account}`;
      label = `取得虛擬帳號 ${info.bankCode ?? ""}-${info.account}`;
    } else if (info.paymentNo) {
      patch.store_payment_code = info.paymentNo;
      label = `取得超商繳費代碼 ${info.paymentNo}`;
    }
    if (info.expireAt) patch.date_payment_due = info.expireAt;
    const { data: o } = await db.from("sales_orders").select("status").eq("tenant_id", tx.tenant_id).eq("id", tx.sales_order_id).maybeSingle<{ status: string }>();
    if (o && ["PENDING_VIRTUAL_BANK_ACCOUNT", "PENDING_STORE_PAYMENT_CODE"].includes(o.status)) patch.status = "ORDER_EMAIL_SENT";
    if (Object.keys(patch).length) {
      const { error } = await db.rpc("orders_admin_update", {
        p_tenant_id: tx.tenant_id,
        p_ids: [tx.sales_order_id],
        p_patch: patch,
        p_admin_user_id: null,
        p_note: `[金流] ${label}${envSuffix()}`,
        p_actor: "SYSTEM",
      });
      if (error) console.error("[gateway] 寫入繳費資訊失敗", error.message);
    }
  }
  return ack(provider.ackOk);
}

/** 付款完成導回（瀏覽器 POST）：同樣驗章入帳（冪等），再導回訂單頁 */
async function result(ctx: RequestContext): Promise<Response> {
  const provider = ecpayPayment();
  const form = await formOf(ctx);
  const mtn = String(form.MerchantTradeNo ?? "");
  if (provider) {
    const n = provider.parseNotify(form);
    if (n) await applyNotify(provider, n, "OrderResultURL");
  }
  const db = getServiceClient();
  const { data: tx } = await db
    .from("sales_order_transactions")
    .select("tenant_id, sales_order_id")
    .eq("provider", "ECPAY")
    .eq("merchant_trade_no", mtn)
    .maybeSingle<{ tenant_id: number; sales_order_id: number }>();
  if (!tx) return redirect("/", 303);
  const { data: o } = await db
    .from("sales_orders")
    .select("uuid, group_buys(short_url), tenants(code)")
    .eq("tenant_id", tx.tenant_id)
    .eq("id", tx.sales_order_id)
    .maybeSingle<{ uuid: string; group_buys: { short_url: string } | null; tenants: { code: string } | null }>();
  if (!o?.group_buys?.short_url || !o.tenants?.code) return redirect("/", 303);
  return redirect(`/${o.tenants.code}/p/${o.group_buys.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(o.uuid)}&paid=1`, 303);
}

/** 定期定額第二期起的授權結果：記一筆交易紀錄（冪等：同一次數只記一次）＋訂單歷程；不另建訂單 */
async function periodNotify(ctx: RequestContext): Promise<Response> {
  const provider = ecpayPayment();
  if (!provider) return ack("0|gateway disabled", 503);
  const n = provider.parsePeriodNotify(await formOf(ctx));
  if (!n) return ack("0|CheckMacValue Error");
  const db = getServiceClient();
  const { data: first } = await db
    .from("sales_order_transactions")
    .select("tenant_id, sales_order_id, payment_method")
    .eq("provider", provider.code)
    .eq("merchant_trade_no", n.merchantTradeNo)
    .maybeSingle<{ tenant_id: number; sales_order_id: number; payment_method: number }>();
  if (!first) return ack("0|order not found");
  const mtn = `${n.merchantTradeNo}P${n.times || "X"}`;
  const { error } = await db.from("sales_order_transactions").insert({
    tenant_id: first.tenant_id,
    sales_order_id: first.sales_order_id,
    provider: provider.code,
    payment_method: first.payment_method,
    category: "PERIOD",
    merchant_trade_no: mtn,
    amount: Number.isFinite(n.amount) ? n.amount : 0,
    status: n.success ? "SUCCESS" : "FAILED",
    auth_code: n.authCode,
    raw_response: n.raw,
    date_transaction: n.processDate ?? new Date().toISOString(),
  });
  if (error && !/duplicate|unique/i.test(error.message)) return ack("0|apply failed");
  if (!error) {
    await db.from("sales_order_histories").insert({
      tenant_id: first.tenant_id,
      sales_order_id: first.sales_order_id,
      actor: "SYSTEM",
      note: `[金流] 定期定額第 ${n.times} 次授權${n.success ? "成功" : `失敗：${n.message}`}（${n.amount} 元）${envSuffix()}`,
    });
  }
  return ack(provider.ackOk);
}

/* ───────────────────────── LINE Pay ───────────────────────── */

/** 前往 LINE Pay：Request API → 導向 LINE Pay 授權頁 */
export async function startLinePay(ctx: RequestContext, order: PayableOrder, opts: { tenantCode: string; shortUrl: string; gbTitle: string }): Promise<Response> {
  const lp = linePay();
  if (!lp) throw badRequest("LINE Pay 尚未設定");
  const amount = Number(order.grand_total);
  if (!(amount > 0) || !Number.isInteger(amount)) throw badRequest("訂單金額無法線上付款");
  const mtn = newMerchantTradeNo(order.id);
  const db = getServiceClient();
  const { error } = await db.from("sales_order_transactions").insert({
    tenant_id: order.tenant_id,
    sales_order_id: order.id,
    provider: lp.code,
    payment_method: order.payment_method,
    category: "PAYMENT",
    merchant_trade_no: mtn,
    amount,
    status: "PENDING",
    raw_response: { sandbox: lp.sandbox },
  });
  if (error) throw new Error(`[accounting] 建立交易紀錄失敗：${error.message}`);
  const base = callbackBase(ctx);
  const back = `${base}/${opts.tenantCode}/p/${opts.shortUrl}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`;
  const r = await lp.request({ orderId: mtn, amount, productName: `${opts.gbTitle} 訂單 ${order.uuid}`, confirmUrl: `${base}/gateway/linepay/confirm`, cancelUrl: back });
  if (!r.ok || !r.paymentUrl || !r.transactionId) {
    await db.from("sales_order_transactions").update({ status: "FAILED", verify_result: `${r.returnCode} ${r.message}`.slice(0, 500) }).eq("provider", lp.code).eq("merchant_trade_no", mtn);
    throw badRequest(`LINE Pay 付款請求失敗：${r.message || r.returnCode}`);
  }
  await db.from("sales_order_transactions").update({ trade_no: r.transactionId }).eq("provider", lp.code).eq("merchant_trade_no", mtn);
  return redirect(r.paymentUrl, 303);
}

/** LINE Pay 授權後導回：以本系統交易紀錄的金額呼叫 Confirm，成功才入帳（gateway_apply_payment，冪等） */
async function linePayConfirm(ctx: RequestContext): Promise<Response> {
  const lp = linePay();
  const tid = String(ctx.query.get("transactionId") ?? "");
  const mtn = String(ctx.query.get("orderId") ?? "");
  const db = getServiceClient();
  const { data: tx } = await db
    .from("sales_order_transactions")
    .select("tenant_id, sales_order_id, amount, trade_no, status")
    .eq("provider", "LINEPAY")
    .eq("merchant_trade_no", mtn)
    .maybeSingle<{ tenant_id: number; sales_order_id: number; amount: number; trade_no: string | null; status: string }>();
  if (!lp || !tx || tx.trade_no !== tid) return redirect("/", 303);
  if (tx.status !== "SUCCESS") {
    const c = await lp.confirm(tid, Number(tx.amount));
    const { data } = await db.rpc("gateway_apply_payment", {
      p_provider: "LINEPAY",
      p_merchant_trade_no: mtn,
      p_success: c.ok,
      p_amount: Number(tx.amount),
      p_trade_no: tid,
      p_card: null,
      p_auth_code: null,
      p_paid_at: new Date().toISOString(),
      p_raw: c.raw,
      p_note: c.ok ? `[金流] LINE Pay 付款成功${envSuffix()}` : `[金流] LINE Pay 付款失敗：${c.message}`,
    });
    const r = data as ApplyResult | null;
    if (r?.result === "PAID" && r.tenantId && r.salesOrderId) await afterPaid(r.tenantId, r.salesOrderId);
  }
  const { data: o } = await db
    .from("sales_orders")
    .select("uuid, group_buys(short_url), tenants(code)")
    .eq("tenant_id", tx.tenant_id)
    .eq("id", tx.sales_order_id)
    .maybeSingle<{ uuid: string; group_buys: { short_url: string } | null; tenants: { code: string } | null }>();
  if (!o?.group_buys?.short_url || !o.tenants?.code) return redirect("/", 303);
  return redirect(`/${o.tenants.code}/p/${o.group_buys.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(o.uuid)}&paid=1`, 303);
}

/* ───────────────────────── 退款（取消已線上付款的訂單） ───────────────────────── */

export interface RefundOutcome {
  ok: boolean;
  skipped?: boolean;
  message: string;
}

/**
 * 全額退款該訂單最近一筆成功的線上付款（綠界信用卡：DoAction；LINE Pay：Refund API）。
 * 冪等：以「原商店訂單編號＋R」建立退款交易紀錄（唯一索引），已成功的不重做；失敗的可重試。
 * 成功後訂單已付金額扣回、寫歷程。
 */
export async function refundOrderPayment(scope: { tenantId: number; adminUserId?: number | null }, salesOrderId: number, reason: string): Promise<RefundOutcome> {
  const db = getServiceClient();
  const { data: pays } = await db
    .from("sales_order_transactions")
    .select("id, provider, payment_method, merchant_trade_no, trade_no, amount")
    .eq("tenant_id", scope.tenantId)
    .eq("sales_order_id", salesOrderId)
    .eq("category", "PAYMENT")
    .eq("status", "SUCCESS")
    .in("provider", ["ECPAY", "LINEPAY"])
    .order("date_transaction", { ascending: false })
    .limit(1);
  const pay = ((pays ?? []) as { id: number; provider: string; payment_method: number; merchant_trade_no: string; trade_no: string | null; amount: number }[])[0];
  if (!pay || !pay.trade_no) return { ok: false, skipped: true, message: "此訂單沒有可退款的線上付款" };
  const refundMtn = `${pay.merchant_trade_no}R`.slice(0, 30);
  const amount = Number(pay.amount);
  const { error: insErr } = await db.from("sales_order_transactions").insert({
    tenant_id: scope.tenantId,
    sales_order_id: salesOrderId,
    provider: pay.provider,
    payment_method: pay.payment_method,
    category: "REFUND",
    merchant_trade_no: refundMtn,
    trade_no: pay.trade_no,
    amount,
    status: "PENDING",
  });
  if (insErr) {
    if (!/duplicate|unique/i.test(insErr.message)) throw new Error(`[accounting] ${insErr.message}`);
    // 已有退款紀錄：成功 → 不重做；失敗 → 取得處理權後重試；處理中 → 略過
    const { data: claimed } = await db
      .from("sales_order_transactions")
      .update({ status: "PENDING" })
      .eq("provider", pay.provider)
      .eq("merchant_trade_no", refundMtn)
      .eq("status", "FAILED")
      .select("id");
    if (!claimed?.length) {
      const { data: ex } = await db.from("sales_order_transactions").select("status").eq("provider", pay.provider).eq("merchant_trade_no", refundMtn).maybeSingle<{ status: string }>();
      return ex?.status === "SUCCESS" ? { ok: true, message: "此筆付款已退款（未重複退款）" } : { ok: false, message: "退款處理中，請稍後再試" };
    }
  }
  let ok = false;
  let message = "";
  let raw: Record<string, unknown> = {};
  if (pay.provider === "ECPAY") {
    const p = ecpayPayment();
    if (!p) return { ok: false, message: "綠界金流未設定" };
    const r = await p.refund({ merchantTradeNo: pay.merchant_trade_no, tradeNo: pay.trade_no, amount });
    ok = r.ok;
    message = r.message;
    raw = { steps: r.steps, sandbox: p.sandbox };
  } else {
    const lp = linePay();
    if (!lp) return { ok: false, message: "LINE Pay 未設定" };
    const r = await lp.refund(pay.trade_no);
    ok = r.ok;
    message = r.ok ? "LINE Pay 已退款" : `${r.returnCode} ${r.message}`;
    raw = r.raw;
  }
  await db
    .from("sales_order_transactions")
    .update({ status: ok ? "SUCCESS" : "FAILED", raw_response: raw, verify_result: ok ? null : message.slice(0, 500), date_transaction: new Date().toISOString() })
    .eq("provider", pay.provider)
    .eq("merchant_trade_no", refundMtn);
  if (ok) {
    const { data: o } = await db.from("sales_orders").select("total_paid").eq("tenant_id", scope.tenantId).eq("id", salesOrderId).maybeSingle<{ total_paid: number }>();
    await db.rpc("orders_admin_update", {
      p_tenant_id: scope.tenantId,
      p_ids: [salesOrderId],
      p_patch: { total_paid: Math.max(0, Number(o?.total_paid ?? 0) - amount) },
      p_admin_user_id: scope.adminUserId ?? null,
      p_note: `[金流] 線上退款 ${amount} 元：${message}（${reason}）${envSuffix()}`,
      p_actor: scope.adminUserId ? "ADMIN" : "SYSTEM",
    });
  } else {
    await db.from("sales_order_histories").insert({ tenant_id: scope.tenantId, sales_order_id: salesOrderId, actor: scope.adminUserId ? "ADMIN" : "SYSTEM", admin_user_id: scope.adminUserId ?? null, note: `[金流] 線上退款失敗：${message}`.slice(0, 1000) });
  }
  return { ok, message: ok ? `已退款 ${amount} 元（${message}）${envSuffix()}` : `退款失敗：${message}` };
}

export const paymentGatewayRoutes: RouteDef[] = [
  post("/gateway/ecpay/payment/period", periodNotify, { auth: "public" }),
  get("/gateway/linepay/confirm", linePayConfirm, { auth: "public" }),
  post("/gateway/ecpay/payment/notify", notify, { auth: "public" }),
  post("/gateway/ecpay/payment/info", paymentInfo, { auth: "public" }),
  post("/gateway/ecpay/payment/result", result, { auth: "public" }),
];
