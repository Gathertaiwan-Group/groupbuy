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
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { post } from "@/lib/core/http/route-helpers";
import { redirect } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { newMerchantTradeNo, type PaymentNotify, type PaymentProvider } from "@/lib/integrations/payment";
import { ack, autoPostPage, callbackBase, ecpayPayment, envSuffix, formOf } from "./gateway";
import { autoIssueInvoiceOnPaid } from "./invoices";

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
  opts: { tenantCode: string; shortUrl: string; gbTitle: string },
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
  if (r.result === "PAID" && r.tenantId && r.salesOrderId) {
    // 付款後依設定開立電子發票（失敗只記錄在發票紀錄，不影響回應綠界）
    try {
      await autoIssueInvoiceOnPaid(r.tenantId, r.salesOrderId);
    } catch (e) {
      console.error("[gateway] 自動開立發票失敗", r.salesOrderId, (e as Error).message);
    }
  }
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

export const paymentGatewayRoutes: RouteDef[] = [
  post("/gateway/ecpay/payment/notify", notify, { auth: "public" }),
  post("/gateway/ecpay/payment/info", paymentInfo, { auth: "public" }),
  post("/gateway/ecpay/payment/result", result, { auth: "public" }),
];
