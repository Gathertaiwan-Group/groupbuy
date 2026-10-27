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
import { newMerchantTradeNo, paymentDeadline, PM, type PaymentNotify, type PaymentProvider } from "@/lib/integrations/payment";
import { ack, autoPostPage, callbackBase, ecpayPayment, envSuffix, formOf, linePay } from "./gateway";
import { allowanceForRefund, autoIssueInvoiceOnPaid, voidInvoicesForOrders } from "./invoices";

/** 入帳成功後的後續：排入付款成功通知信、依設定開立電子發票（失敗只記 log，不影響入帳） */
export async function afterPaid(tenantId: number, salesOrderId: number, label: string, eventKey: string): Promise<void> {
  try {
    // 付款成功通知信（core/delivery.ts queuePaymentEmail：依範本、白名單模式；同一入帳事件只寄一封）
    await queuePaymentEmail(tenantId, salesOrderId, label, eventKey);
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
  const due = order.date_payment_due ? new Date(order.date_payment_due).getTime() - Date.now() : 0;
  const atmExpireDays = due > 0 ? Math.min(60, Math.max(1, Math.ceil(due / 86400_000))) : 3;
  const cvsExpireMinutes = due > 0 ? Math.min(43200, Math.max(30, Math.ceil(due / 60_000))) : 10080;
  // fix22：預計繳費期限（沒收到取號通知時，排程以此判斷逾期）
  const deadlineAt =
    order.payment_method === PM.VIRTUAL_BANK
      ? new Date(Date.now() + atmExpireDays * 86400_000).toISOString()
      : order.payment_method === PM.CVS_CODE
        ? new Date(Date.now() + cvsExpireMinutes * 60_000).toISOString()
        : null;
  const { error } = await db.from("sales_order_transactions").insert({
    tenant_id: order.tenant_id,
    sales_order_id: order.id,
    provider: provider.code,
    payment_method: order.payment_method,
    category: "PAYMENT",
    merchant_trade_no: mtn,
    amount,
    status: "PENDING",
    raw_response: { sandbox: provider.sandbox, startedAt: new Date().toISOString(), ...(deadlineAt ? { deadlineAt } : {}) },
  });
  if (error) throw new Error(`[accounting] 建立交易紀錄失敗：${error.message}`);
  const base = callbackBase(ctx);
  const orderUrl = `${base}/${opts.tenantCode}/p/${opts.shortUrl}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`;
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
    atmExpireDays,
    cvsExpireMinutes,
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
  if (r.result === "PAID" && r.tenantId && r.salesOrderId) await afterPaid(r.tenantId, r.salesOrderId, "線上付款", `${provider.code}:${n.merchantTradeNo}`);
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
    category: "CAPTURE", // 定期定額第二期起（category 有 check 限制；CAPTURE＝後續授權請款）
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

/* ───────────────────────── fix22：未完成付款的逾期確認（排程 gatewayExpire） ───────────────────────── */

/** LINE Pay 付款請求未在期限內授權＋Confirm → 不會扣款；1 天後標為逾期 */
const LINEPAY_EXPIRE_MS = 86400_000;

/**
 * 「處理中」的線上付款交易超過付款期限（payment.ts paymentDeadline）→ 向綠界 QueryTradeInfo 確認：
 *   已付款 → 照入帳流程補入帳（gateway_apply_payment 冪等＋afterPaid 付款成功信／發票，與付款通知同一路徑）；
 *   未付款／查無交易 → 條件式更新為失敗（只改仍是 PENDING 的列；之後若綠界通知真的付款，gateway_apply_payment 仍會入帳）＋訂單歷程；
 *   查詢失敗 → 略過，下次排程再查。
 * asOf：判斷期限用的時間（測試模式可由 cron 參數指定，正式模式一律現在）。回傳筆數。
 */
export async function expireStalePayments(opt: { asOf?: Date; deadlineMs?: number; limit?: number } = {}): Promise<Record<string, number>> {
  const db = getServiceClient();
  const now = opt.asOf ?? new Date();
  const out = { checked: 0, paid: 0, expired: 0, unknown: 0, notDue: 0 };
  const provider = ecpayPayment();
  // 最早的付款頁期限是 60＋30 分鐘：比這更新的交易不必取出
  const newest = new Date(now.getTime() - 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("sales_order_transactions")
    .select("id, tenant_id, sales_order_id, provider, payment_method, merchant_trade_no, amount, created_at, raw_response")
    .eq("category", "PAYMENT")
    .eq("status", "PENDING")
    .in("provider", ["ECPAY", "LINEPAY"])
    .lt("created_at", newest)
    .order("created_at", { ascending: true })
    .limit(opt.limit ?? 100);
  if (error) throw new Error(`讀取處理中付款失敗：${error.message}`);
  type Tx = { id: number; tenant_id: number; sales_order_id: number; provider: string; payment_method: number; merchant_trade_no: string; amount: number; created_at: string; raw_response: Record<string, unknown> | null };
  const markExpired = async (t: Tx, why: string) => {
    const { data: upd } = await db
      .from("sales_order_transactions")
      .update({ status: "FAILED", verify_result: why.slice(0, 500) })
      .eq("id", t.id)
      .eq("status", "PENDING")
      .select("id");
    if (!upd?.length) return false;
    await db.from("sales_order_histories").insert({ tenant_id: t.tenant_id, sales_order_id: t.sales_order_id, actor: "SYSTEM", note: `[金流] ${why}（${t.merchant_trade_no}）${envSuffix()}`.slice(0, 1000) });
    return true;
  };
  for (const t of (data ?? []) as Tx[]) {
    if (opt.deadlineMs && Date.now() > opt.deadlineMs) break;
    if (t.provider === "LINEPAY") {
      if (now.getTime() - new Date(t.created_at).getTime() < LINEPAY_EXPIRE_MS) {
        out.notDue++;
        continue;
      }
      out.checked++;
      if (await markExpired(t, "付款逾期：LINE Pay 付款請求逾時未完成（未扣款）")) out.expired++;
      continue;
    }
    if (paymentDeadline(t).getTime() > now.getTime()) {
      out.notDue++;
      continue;
    }
    if (!provider) {
      out.unknown++;
      continue;
    }
    out.checked++;
    const q = await provider.queryTrade(t.merchant_trade_no);
    if (q.status === "UNKNOWN") {
      out.unknown++;
      continue;
    }
    if (q.status === "PAID") {
      if (q.amount !== Number(t.amount)) {
        out.unknown++;
        console.warn("[gateway] 逾期確認：綠界已付款但金額不符", t.merchant_trade_no, q.amount, t.amount);
        await db.from("sales_order_transactions").update({ verify_result: `逾期確認：綠界已付款 ${q.amount} 元，與交易金額 ${t.amount} 不符，請人工確認` }).eq("id", t.id).eq("status", "PENDING");
        continue;
      }
      const { data: r, error: aErr } = await db.rpc("gateway_apply_payment", {
        p_provider: provider.code,
        p_merchant_trade_no: t.merchant_trade_no,
        p_success: true,
        p_amount: q.amount,
        p_trade_no: q.tradeNo,
        p_card: null,
        p_auth_code: null,
        p_paid_at: q.paidAt ?? null,
        p_raw: { ...(t.raw_response ?? {}), _source: "gatewayExpire(QueryTradeInfo)", query: q.raw ?? null },
        p_note: `[金流] 付款成功（排程向綠界查詢補入帳${q.paymentType ? `，${q.paymentType}` : ""}）${envSuffix()}`,
      });
      if (aErr) {
        out.unknown++;
        console.error("[gateway] 逾期確認補入帳失敗", t.merchant_trade_no, aErr.message);
        continue;
      }
      const ar = r as ApplyResult;
      if (ar.result === "PAID" && ar.tenantId && ar.salesOrderId) await afterPaid(ar.tenantId, ar.salesOrderId, "線上付款", `${provider.code}:${t.merchant_trade_no}`);
      out.paid++;
      continue;
    }
    if (await markExpired(t, `付款逾期：已超過繳費期限，綠界查詢未付款（${q.message}）`)) out.expired++;
  }
  return out;
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
    if (r?.result === "PAID" && r.tenantId && r.salesOrderId) await afterPaid(r.tenantId, r.salesOrderId, "LINE Pay", `LINEPAY:${mtn}`);
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

/* ───────────────────────── 退款（全額／部分退刷） ───────────────────────── */

export interface RefundOutcome {
  ok: boolean;
  skipped?: boolean;
  message: string;
  /** 本次退款金額 */
  amount?: number;
  /** 退款後訂單已付金額 */
  totalPaid?: number | null;
  /** 這筆付款已全部退完（全額）→ 發票作廢；否則部分 → 發票折讓 */
  fullyRefunded?: boolean;
}

/** 這張訂單最近一筆成功線上付款的可退金額（已付 − 已退成功；有處理中的退款時 pending>0） */
export async function refundableOf(tenantId: number, salesOrderId: number): Promise<{ provider: string; paid: number; refunded: number; pending: number; remain: number } | null> {
  const db = getServiceClient();
  const { data: pays } = await db
    .from("sales_order_transactions")
    .select("id, provider, merchant_trade_no, amount")
    .eq("tenant_id", tenantId)
    .eq("sales_order_id", salesOrderId)
    .eq("category", "PAYMENT")
    .eq("status", "SUCCESS")
    .in("provider", ["ECPAY", "LINEPAY"])
    .not("trade_no", "is", null)
    .order("date_transaction", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  const pay = ((pays ?? []) as { id: number; provider: string; merchant_trade_no: string; amount: number }[])[0];
  if (!pay) return null;
  const { data: refs } = await db
    .from("sales_order_transactions")
    .select("amount, status, parent_transaction_id, merchant_trade_no")
    .eq("tenant_id", tenantId)
    .eq("sales_order_id", salesOrderId)
    .eq("category", "REFUND")
    .eq("provider", pay.provider);
  let refunded = 0;
  let pending = 0;
  for (const r of (refs ?? []) as { amount: number; status: string; parent_transaction_id: number | null; merchant_trade_no: string | null }[]) {
    const mine = r.parent_transaction_id === pay.id || (r.parent_transaction_id == null && String(r.merchant_trade_no ?? "").startsWith(`${pay.merchant_trade_no}R`));
    if (!mine) continue;
    if (r.status === "SUCCESS") refunded += Number(r.amount);
    if (r.status === "PENDING") pending++;
  }
  const paid = Number(pay.amount);
  return { provider: pay.provider, paid, refunded, pending, remain: paid - refunded };
}

type BeginResult = {
  result: "BEGIN" | "NO_PAYMENT" | "PENDING" | "ALREADY_REFUNDED" | "INVALID_AMOUNT" | "EXCEEDS";
  refundId?: number;
  refundMtn?: string;
  provider?: string;
  merchantTradeNo?: string;
  tradeNo?: string;
  paid?: number;
  refunded?: number;
  remain?: number;
  amount?: number;
  firstAndFull?: boolean;
  last?: boolean;
};

/**
 * 退款該訂單最近一筆成功的線上付款（綠界信用卡：DoAction；LINE Pay：Refund API）。
 * amount 未給＝退「已付未退」的全部；給了＝部分退刷（≤ 已付未退）。
 * 金額檢查與退款交易建立在 DB 函式 gateway_refund_begin（鎖原付款交易；多次部分退刷累計不超過已付金額、同時只能有一筆處理中）；
 * 結果寫回在 gateway_refund_finish（同一交易扣回訂單已付金額＋歷程，交易紀錄與訂單一致）。
 * 綠界規則：部分退刷只能對已關帳的交易（R）；未關帳只能全額放棄授權（N）→ 部分退刷失敗時提示改全額或關帳後再退。
 * 退款成功後：全部退完 → 作廢發票；部分 → 依退款金額開折讓（失敗只提示，不影響退款結果）。
 */
export async function refundOrderPayment(
  scope: { tenantId: number; adminUserId?: number | null },
  salesOrderId: number,
  reason: string,
  amount?: number | null,
  opt: { invoice?: boolean } = {},
): Promise<RefundOutcome> {
  const db = getServiceClient();
  const want = amount == null ? null : Number(amount);
  if (want != null && !(Number.isInteger(want) && want > 0)) return { ok: false, message: "退款金額必須是正整數" };
  const { data, error } = await db.rpc("gateway_refund_begin", { p_tenant_id: scope.tenantId, p_sales_order_id: salesOrderId, p_amount: want });
  if (error) throw new Error(`[accounting] ${error.message}`);
  const b = data as BeginResult;
  switch (b.result) {
    case "NO_PAYMENT":
      return { ok: false, skipped: true, message: "此訂單沒有可退款的線上付款" };
    case "PENDING":
      return { ok: false, message: "此訂單有退款處理中，請稍後再試" };
    case "ALREADY_REFUNDED":
      return { ok: true, skipped: true, message: `此筆付款已全額退款（${Number(b.refunded)} 元），未重複退款`, fullyRefunded: true };
    case "INVALID_AMOUNT":
      return { ok: false, message: "退款金額必須是正整數" };
    case "EXCEEDS":
      return { ok: false, message: `退款金額超過可退金額（已付 ${Number(b.paid)} 元、已退 ${Number(b.refunded)} 元，最多可退 ${Number(b.remain)} 元）` };
  }
  const amt = Number(b.amount);
  const partial = !b.firstAndFull;
  let ok = false;
  let message = "";
  let raw: Record<string, unknown> = {};
  try {
    if (b.provider === "ECPAY") {
      const p = ecpayPayment();
      if (!p) throw new Error("綠界金流未設定");
      const r = await p.refund({ merchantTradeNo: String(b.merchantTradeNo), tradeNo: String(b.tradeNo), amount: amt, partial });
      ok = r.ok;
      message = r.message;
      raw = { steps: r.steps, sandbox: p.sandbox, partial, notClosed: r.notClosed ?? false };
    } else {
      const lp = linePay();
      if (!lp) throw new Error("LINE Pay 未設定");
      const r = await lp.refund(String(b.tradeNo), partial ? amt : undefined);
      ok = r.ok;
      message = r.ok ? `LINE Pay 已退款 ${amt} 元` : `${r.returnCode} ${r.message}`;
      raw = r.raw;
    }
  } catch (e) {
    ok = false;
    message = (e as Error).message;
  }
  const actor = `${reason ? `（${reason}）` : ""}${envSuffix()}`;
  const { data: fin, error: fErr } = await db.rpc("gateway_refund_finish", {
    p_tenant_id: scope.tenantId,
    p_refund_id: b.refundId,
    p_ok: ok,
    p_message: message,
    p_raw: raw,
    p_admin_user_id: scope.adminUserId ?? null,
    p_note: `[金流] 線上${partial ? "部分" : "全額"}退款 ${amt} 元：${message}${actor}`,
  });
  if (fErr) throw new Error(`[accounting] 寫回退款結果失敗：${fErr.message}`);
  if (!ok) return { ok: false, message: `退款失敗：${message}`, amount: amt };
  const fully = !!b.last;
  const out: RefundOutcome = {
    ok: true,
    amount: amt,
    totalPaid: (fin as { totalPaid?: number | null } | null)?.totalPaid ?? null,
    fullyRefunded: fully,
    message: `已${partial ? "部分" : "全額"}退款 ${amt} 元（${message}）${envSuffix()}${fully ? "" : `；尚可退 ${Number(b.remain) - amt} 元`}`,
  };
  if (opt.invoice !== false) {
    try {
      const msgs = fully
        ? await voidInvoicesForOrders({ tenantId: scope.tenantId }, [salesOrderId], reason || "線上退款")
        : await allowanceForRefund({ tenantId: scope.tenantId }, salesOrderId, amt, reason || "線上部分退款");
      if (msgs.length) out.message += `<br>${msgs.join("<br>")}`;
    } catch (e) {
      out.message += `<br>電子發票${fully ? "作廢" : "折讓"}失敗：${(e as Error).message}`;
    }
  }
  return out;
}

export const paymentGatewayRoutes: RouteDef[] = [
  post("/gateway/ecpay/payment/period", periodNotify, { auth: "public" }),
  get("/gateway/linepay/confirm", linePayConfirm, { auth: "public" }),
  post("/gateway/ecpay/payment/notify", notify, { auth: "public" }),
  post("/gateway/ecpay/payment/info", paymentInfo, { auth: "public" }),
  post("/gateway/ecpay/payment/result", result, { auth: "public" }),
];
