// 訂單明細頁（推導，原站未擷取）＋消費者對訂單的動作：回報匯款後五碼、申請取消。
// 只有「查詢授權 cookie」或「會員本人」可看/操作；所有查詢以租戶 id 過濾。
import { post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, redirect } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { renderTemplate } from "@/lib/core/render/template";
import { enumLabel } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import { getServiceClient } from "@/lib/supabase/server";
import { feVars, gbSetting, groupBuyPreferences, scopeFromTenantPath, type SfGroupBuy, type SfTenant } from "./site";
import { readCustomerSession, type CustomerSession } from "./customer-session";
import { formatPrice } from "./catalog";
import { hasOrderViewGrant } from "./order-grant";
import { clean, ipOf, rateLimit } from "./guard";
import { PM_LABEL } from "./cart-data";
import { linePay, paymentProviderFor } from "@/lib/modules/accounting/gateway";
import { startLinePay, startPayment, startPchomePay } from "@/lib/modules/accounting/payment-gateway";
import { PchomePayPayment } from "@/lib/integrations/pchomepay";
import { validPeriod } from "@/lib/integrations/payment";

const ONLINE_PAYMENTS = new Set([4, 128, 1024, 4096, 8192, 16384]);

/** 付款方式位元 → 中文（enum SalesOrder.paymentMethod；自定義付款名稱另取團購設定） */
export async function paymentMethodLabel(gb: SfGroupBuy, pm: number): Promise<string> {
  if (pm === 256) {
    const custom = String(gbSetting(gb, "customPaymentMethod", "") || "").trim();
    if (custom) return custom;
  }
  return PM_LABEL[pm] || (await enumLabel("SalesOrder.paymentMethod", String(pm))) || "未定義";
}

/** 團購的匯款帳戶（進階設定中帶 account 的設定；推導：原站「匯款轉帳-銀行名稱/代號/戶名/帳號」子編輯器） */
export async function bankAccountInfo(tenantId: number, groupBuyId: number): Promise<{ name: string; code: string; title: string; account: string } | null> {
  const prefs = await groupBuyPreferences(tenantId, groupBuyId);
  for (const k of Object.keys(prefs)) {
    const s = prefs[k].settings ?? {};
    if (typeof s.account === "string" && s.account.trim()) {
      return { name: String(s.name ?? ""), code: String(s.code ?? ""), title: String(s.title ?? ""), account: String(s.account) };
    }
  }
  return null;
}

type OrderFull = Record<string, unknown> & {
  id: number;
  uuid: string;
  state: string;
  status: string;
  payment_method: number;
  grand_total: number | string;
  shipping_amount: number | string;
  cod_fee: number | string;
  discount_amount: number | string;
  points_used: number;
  total_paid: number | string;
  date_paid: string | null;
  date_payment_due: string | null;
  created_at: string;
  customer_id: number | null;
  blacklist_note: string | null;
  flat_rate_shipping_id: number | null;
  shipping_type: string;
};

async function loadOrder(tenantId: number, id: number): Promise<{ order: OrderFull; items: Record<string, unknown>[]; rules: Record<string, unknown>[]; coupons: Record<string, unknown>[] } | null> {
  const db = getServiceClient();
  const { data: o } = await db.from("sales_orders").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!o) return null;
  const [{ data: items }, { data: rules }, { data: coupons }] = await Promise.all([
    db.from("order_items").select("*").eq("tenant_id", tenantId).eq("sales_order_id", id).order("seq").order("id"),
    db.from("sales_order_sales_rules").select("*").eq("tenant_id", tenantId).eq("sales_order_id", id).order("id"),
    db.from("sales_order_coupons").select("*").eq("tenant_id", tenantId).eq("sales_order_id", id).order("id"),
  ]);
  return { order: o as OrderFull, items: (items ?? []) as Record<string, unknown>[], rules: (rules ?? []) as Record<string, unknown>[], coupons: (coupons ?? []) as Record<string, unknown>[] };
}

const n = (v: unknown) => Number(v ?? 0) || 0;

function isPaid(o: OrderFull): boolean {
  return !!o.date_paid || (n(o.total_paid) > 0 && n(o.total_paid) >= n(o.grand_total));
}

function steps(o: OrderFull) {
  const shipped = ["SHIPPED", "SHIPPING_EMAIL_SENT", "SHIPPING_EMAIL_FAILED", "CVS_PICKUP_DATE_DUED"].includes(o.status) || !!o.date_shipped;
  const done = o.state === "COMPLETE";
  const paid = isPaid(o);
  const at = done ? 4 : shipped ? 3 : paid ? 2 : 1;
  return [
    { icon: "fa-file-lines", label: "訂單成立", active: at >= 1 },
    { icon: "fa-credit-card", label: "已付款", active: at >= 2 },
    { icon: "fa-truck", label: "已出貨", active: at >= 3 },
    { icon: "fa-circle-check", label: "已完成", active: at >= 4 },
  ];
}

const STATE_BADGE: Record<string, string> = {
  PROCESSING: "badge-primary",
  NEW: "badge-info",
  COMPLETE: "badge-success",
  CANCELED: "badge-danger",
  HOLDED: "badge-warning",
  RETURNING: "badge-warning",
  RETURNED: "badge-secondary",
};

export async function renderOrderDetail(
  ctx: RequestContext,
  tenant: SfTenant,
  gb: SfGroupBuy,
  orderId: number,
  customer: CustomerSession | null,
  flash = "",
): Promise<Response> {
  const loaded = await loadOrder(tenant.id, orderId);
  if (!loaded) return html("", { status: 404 });
  const { order: o, items, rules, coupons } = loaded;
  const cur = gb.currency;
  const pm = n(o.payment_method);
  const paid = isPaid(o);
  const blocked = !!o.blacklist_note;
  const paymentRows: { label: string; value: string; valueClass: string }[] = [];
  let paymentNotice = "";
  let canReportBankAccount = false;
  const open = ["NEW", "PROCESSING"].includes(o.state);
  // 線上付款（PChomePay 支付連／綠界）：信用卡、ATM 虛擬帳號、超商代碼（綠界另有定期定額等）
  const provider = !blocked && !paid && open ? await paymentProviderFor(tenant.id, gb, pm) : null;
  const gt = n(o.grand_total);
  const lp = pm === 1024 && !blocked && !paid && open ? linePay() : null;
  const canPayOnline = ((!!provider && provider.supports(pm)) || !!lp) && gt > 0 && Number.isInteger(gt);
  const vAccount = String(o.virtual_bank_account ?? "");
  const storeCode = String(o.store_payment_code ?? "");
  let payOnline: { label: string; sandbox: boolean; auto: boolean; providerName: string } | null = null;
  if (canPayOnline) {
    const hasCode = (pm === 2 && !!vAccount) || (pm === 32 && !!storeCode);
    payOnline = {
      label: pm === 2 ? (vAccount ? "重新取得 ATM 虛擬帳號" : "取得 ATM 虛擬帳號") : pm === 32 ? (storeCode ? "重新取得超商繳費代碼" : "取得超商繳費代碼") : "前往付款",
      sandbox: (provider ?? lp)!.sandbox,
      providerName: lp ? "LINE Pay " : provider instanceof PchomePayPayment ? " PChomePay 支付連" : "綠界",
      auto: ctx.query.get("placed") === "1" && !hasCode,
    };
  }
  if (!paid && ctx.query.get("paid") === "1" && !flash) flash = "付款結果確認中，請稍後重新整理此頁。";
  if (blocked) {
    paymentNotice = "此訂單目前無法付款，請聯絡賣家。";
  } else if (paid) {
    paymentNotice = "已收到您的付款，謝謝！";
  } else if (pm === 1) {
    const bank = await bankAccountInfo(tenant.id, gb.id);
    if (bank) {
      if (bank.name || bank.code) paymentRows.push({ label: "銀行", value: `${bank.name}${bank.code ? `（${bank.code}）` : ""}`, valueClass: "" });
      if (bank.title) paymentRows.push({ label: "戶名", value: bank.title, valueClass: "" });
      paymentRows.push({ label: "帳號", value: bank.account, valueClass: "bank-account-copy" });
      paymentRows.push({ label: "應付金額", value: formatPrice(n(o.grand_total), cur), valueClass: "" });
      paymentNotice = "請於付款期限前完成匯款，並回報匯款帳號後五碼以便對帳。";
    } else {
      paymentNotice = "賣家尚未設定匯款帳戶，請透過「我想問問題」聯絡賣家取得匯款資訊。";
    }
    canReportBankAccount = open;
  } else if (pm === 2 && (vAccount || canPayOnline)) {
    if (vAccount) {
      const [bankCode, account] = vAccount.includes("-") ? vAccount.split("-", 2) : ["", vAccount];
      if (bankCode) paymentRows.push({ label: "銀行代碼", value: bankCode, valueClass: "" });
      paymentRows.push({ label: "虛擬帳號", value: account, valueClass: "bank-account-copy" });
      paymentRows.push({ label: "應付金額", value: formatPrice(gt, cur), valueClass: "" });
      paymentNotice = "請於繳費期限前以 ATM／網路銀行轉帳至上方虛擬帳號，入帳後系統會自動更新付款狀態。";
    } else paymentNotice = "請按下方按鈕取得 ATM 虛擬帳號。";
  } else if (pm === 2) {
    paymentNotice = "【未串接】虛擬帳號金流尚未開通，請透過「我想問問題」聯絡賣家確認付款方式。";
  } else if (ONLINE_PAYMENTS.has(pm) && canPayOnline) {
    paymentNotice = "請按下方按鈕前往付款，付款完成後系統會自動更新付款狀態。";
  } else if (ONLINE_PAYMENTS.has(pm)) {
    paymentNotice = "線上付款尚未開通，訂單將維持「待付款」，請透過「我想問問題」聯絡賣家確認付款方式。【未串接金流】";
  } else if (pm === 32 && (storeCode || canPayOnline)) {
    if (storeCode) {
      paymentRows.push({ label: "超商繳費代碼", value: storeCode, valueClass: "bank-account-copy" });
      paymentRows.push({ label: "應付金額", value: formatPrice(gt, cur), valueClass: "" });
      paymentNotice = "請於繳費期限前至 7-11／全家／萊爾富／OK 超商機台輸入繳費代碼列印繳費單付款。";
    } else paymentNotice = "請按下方按鈕取得超商繳費代碼。";
  } else if (pm === 32) {
    paymentNotice = "【未串接】超商繳款代碼尚未開通，請聯絡賣家確認付款方式。";
  } else if (pm === 64) {
    paymentNotice = "請於超商取貨時付款。";
  } else if (pm === 16) {
    paymentNotice = "請於商品送達時付款給物流人員。";
  } else if (pm === 8) {
    paymentNotice = "請於自取時現場付款。";
  }
  if (o.billing_bank_account) paymentRows.push({ label: "已回報後五碼", value: String(o.billing_bank_account), valueClass: "" });

  let shippingLabel = "";
  if (o.flat_rate_shipping_id) {
    const { data: fr } = await getServiceClient().from("flat_rate_shippings").select("title").eq("tenant_id", tenant.id).eq("id", o.flat_rate_shipping_id).maybeSingle();
    shippingLabel = (fr as { title: string } | null)?.title ?? "";
  }
  if (!shippingLabel) shippingLabel = (await enumLabel("ShippingType", o.shipping_type)) || "";

  const vis = items.filter((i) => !i.bundle_child);
  const subtotal = vis.reduce((s, i) => s + n(i.price) * n(i.total), 0);
  const discounts = [
    ...rules.map((r) => ({ label: String(r.title ?? "優惠"), amountText: formatPrice(n(r.discount), cur) })),
    ...coupons.map((c) => ({ label: `優惠卷 ${String(c.coupon ?? "")}`, amountText: formatPrice(n(c.discount), cur) })),
  ].filter((d) => d.amountText !== formatPrice(0, cur));
  const receiptType = n(o.billing_receipt_type) || 1;
  const invoice: { label: string; value: string }[] = [];
  if (!gb.invoice_disabled) {
    invoice.push({ label: "發票類型", value: (await enumLabel("SalesOrder.receiptType", String(receiptType))) || "一般發票" });
    if (receiptType === 2) {
      invoice.push({ label: "統一編號", value: String(o.billing_receipt_vat_id ?? "") });
      invoice.push({ label: "發票抬頭", value: String(o.billing_receipt_title ?? "") });
    } else if (receiptType === 3) {
      invoice.push({ label: "捐贈碼", value: String(o.billing_receipt_donation_code ?? "") });
    } else {
      const ct = n(o.billing_receipt_carrier_type);
      invoice.push({ label: "載具", value: (await enumLabel("SalesOrder.receiptCarrierType", String(ct))) || "" });
      if (o.billing_receipt_carrier_num) invoice.push({ label: "載具號碼", value: String(o.billing_receipt_carrier_num) });
    }
    if (o.invoice_number) invoice.push({ label: "發票號碼", value: String(o.invoice_number) });
  }
  const addr = (p: string) =>
    [o[`${p}_postcode`], o[`${p}_city`], o[`${p}_district`], o[`${p}_street`]].filter((x) => x && x !== "NA").join("");
  const settings = gb.group_buy_settings ?? {};
  const canCancel =
    open &&
    !blocked &&
    o.status !== "INQUIRED_CANCEL" &&
    ((paid && settings.cancelPaidEnabled === true) || (!paid && settings.cancelUnpaidEnabled === true));
  const deliver = n(o.deliver_time);
  const vars = {
    ...feVars(ctx, { tenant, groupBuy: gb, customer }),
    order: o,
    justPlaced: ctx.query.get("placed") === "1",
    flash,
    steps: steps(o),
    stateLabel: (await enumLabel("SalesOrder.state", o.state)) || o.state,
    stateBadgeClass: STATE_BADGE[o.state] ?? "badge-secondary",
    statusLabel: (await enumLabel("SalesOrder.status", o.status)) || o.status,
    orderDate: taipeiDateTime(o.created_at),
    paymentMethodLabel: await paymentMethodLabel(gb, pm),
    paymentDue: !paid && o.date_payment_due ? taipeiDateTime(o.date_payment_due) : "",
    paidLabel: paid ? "已付款" : blocked ? "無法付款" : "未付款",
    shippingLabel,
    paymentRows,
    paymentNotice,
    payOnline,
    canReportBankAccount,
    items: vis.map((i) => ({
      title: String(i.title ?? ""),
      backOrder: !!i.back_order,
      gift: !!i.gift,
      priceText: formatPrice(n(i.price), cur),
      total: n(i.total),
      subtotalText: formatPrice(n(i.price) * n(i.total), cur),
      amountText: formatPrice(n(i.amount), cur),
    })),
    subtotalText: formatPrice(subtotal, cur),
    discounts,
    shippingText: n(o.shipping_amount) === 0 ? "免運" : formatPrice(n(o.shipping_amount), cur),
    codFeeText: n(o.cod_fee) > 0 ? formatPrice(n(o.cod_fee), cur) : "",
    pointsText: n(o.points_used) > 0 ? String(n(o.points_used)) : "",
    grandTotalText: formatPrice(n(o.grand_total), cur),
    billing: { name: String(o.customer_firstname ?? ""), telephone: String(o.customer_telephone ?? ""), email: String(o.customer_email ?? "") },
    shipping: {
      name: String(o.shipping_firstname ?? o.customer_firstname ?? ""),
      telephone: String(o.shipping_telephone ?? o.customer_telephone ?? ""),
      address: addr("shipping"),
      cvsStoreName: String(o.cvs_store_name ?? ""),
      cvsStoreId: String(o.cvs_store_id ?? ""),
      cvsAddress: String(o.cvs_address ?? ""),
    },
    deliverTimeLabel: deliver > 0 ? (await enumLabel("SalesOrder.deliverTime", String(deliver))) || "" : "",
    invoice: invoice.length ? invoice : null,
    canCancel,
  };
  return html(renderTemplate("storefront/order-show.html", vars));
}

async function authorizedOrder(ctx: RequestContext): Promise<{ tenant: SfTenant; gb: SfGroupBuy; order: { id: number; uuid: string; state: string; status: string; customer_id: number | null; total_paid: unknown; grand_total: unknown; date_paid: unknown; blacklist_note: unknown }; customer: CustomerSession | null }> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  const b = await ctx.body();
  const uuid = clean(b.flat.get("uuid")?.[0], 40, "訂單編號");
  if (!/^[0-9A-Za-z-]{6,40}$/.test(uuid)) throw badRequest("找不到訂單");
  const { data } = await getServiceClient()
    .from("sales_orders")
    .select("id, uuid, state, status, customer_id, total_paid, grand_total, date_paid, blacklist_note")
    .eq("tenant_id", tenant.id)
    .eq("uuid", uuid)
    .maybeSingle();
  const order = data as { id: number; uuid: string; state: string; status: string; customer_id: number | null; total_paid: unknown; grand_total: unknown; date_paid: unknown; blacklist_note: unknown } | null;
  const customer = await readCustomerSession(ctx, tenant.id);
  if (!order || !(hasOrderViewGrant(ctx, tenant.id, order.uuid) || (customer && order.customer_id === customer.customer.id))) {
    throw badRequest("請先以訂單編號與電話查詢訂單");
  }
  return { tenant, gb: groupBuy!, order, customer };
}

async function updateBankAccount(ctx: RequestContext): Promise<Response> {
  const { tenant, gb, order, customer } = await authorizedOrder(ctx);
  await rateLimit(`bankacct:${ipOf(ctx)}`, 600, 10);
  const b = await ctx.body();
  const v = clean(b.flat.get("bankAccount")?.[0], 5, "匯款帳號後五碼");
  if (!/^\d{5}$/.test(v)) throw badRequest("請輸入匯款帳號後五碼（5 位數字）");
  if (!["NEW", "PROCESSING"].includes(order.state)) throw badRequest("此訂單狀態無法回報匯款");
  await getServiceClient().from("sales_orders").update({ billing_bank_account: v }).eq("tenant_id", tenant.id).eq("id", order.id);
  return renderOrderDetail(ctx, tenant, gb, order.id, customer, "已收到您的匯款資訊，賣家對帳後會更新付款狀態。");
}

/** 定期定額設定：團購設定 periodType（D/M/Y）、periodFrequency、periodExecTimes；未設定＝每月 1 次、共 12 期 */
function periodOf(gb: SfGroupBuy): { type: "D" | "M" | "Y"; frequency: number; execTimes: number } {
  const t = String(gbSetting(gb, "periodType", "M")).toUpperCase();
  const p = { type: (["D", "M", "Y"].includes(t) ? t : "M") as "D" | "M" | "Y", frequency: Number(gbSetting(gb, "periodFrequency", 1)) || 1, execTimes: Number(gbSetting(gb, "periodExecTimes", 12)) || 12 };
  return validPeriod(p) ? p : { type: "M", frequency: 1, execTimes: 12 };
}

/** 前往線上付款（PChomePay／綠界）：只有查詢授權或會員本人、訂單處理中且未付款、付款方式支援時 */
async function payOnline(ctx: RequestContext): Promise<Response> {
  const { tenant, gb, order } = await authorizedOrder(ctx);
  await rateLimit(`payonline:${ipOf(ctx)}`, 600, 20);
  const { data } = await getServiceClient()
    .from("sales_orders")
    .select("id, tenant_id, uuid, group_buy_id, grand_total, payment_method, date_payment_due, state, total_paid, date_paid, blacklist_note")
    .eq("tenant_id", tenant.id)
    .eq("id", order.id)
    .maybeSingle();
  const o = data as (OrderFull & { tenant_id: number; group_buy_id: number | null }) | null;
  if (!o) throw badRequest("找不到訂單");
  if (!["NEW", "PROCESSING"].includes(o.state) || o.blacklist_note || isPaid(o)) throw badRequest("此訂單目前無法線上付款");
  const pm = n(o.payment_method);
  const opts = { tenantCode: tenant.code, shortUrl: gb.short_url ?? "", gbTitle: gb.title };
  if (pm === 1024 && linePay()) return startLinePay(ctx, o, opts);
  const provider = await paymentProviderFor(tenant.id, gb, pm);
  if (!provider || !provider.supports(pm)) throw badRequest("此訂單的付款方式不支援線上付款");
  if (provider instanceof PchomePayPayment) return startPchomePay(ctx, provider, o, opts);
  return startPayment(ctx, provider, o, { ...opts, period: pm === 128 ? periodOf(gb) : undefined });
}

async function inquireCancel(ctx: RequestContext): Promise<Response> {
  const { tenant, gb, order, customer } = await authorizedOrder(ctx);
  await rateLimit(`cancel:${ipOf(ctx)}`, 600, 10);
  const s = gb.group_buy_settings ?? {};
  const paid = !!order.date_paid || (n(order.total_paid) > 0 && n(order.total_paid) >= n(order.grand_total));
  const allowed = ["NEW", "PROCESSING"].includes(order.state) && !order.blacklist_note && ((paid && s.cancelPaidEnabled === true) || (!paid && s.cancelUnpaidEnabled === true));
  if (!allowed) throw badRequest("此訂單無法線上申請取消，請聯絡賣家");
  await getServiceClient().from("sales_orders").update({ status: "INQUIRED_CANCEL" }).eq("tenant_id", tenant.id).eq("id", order.id);
  return redirect(`/${tenant.code}/p/${gb.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`, 303);
}

export const orderDetailRoutes: RouteDef[] = [
  post("/p/:shortUrl/SalesOrder/updateBankAccount", updateBankAccount, { auth: "public" }),
  post("/p/:shortUrl/SalesOrder/inquireCancel", inquireCancel, { auth: "public" }),
  post("/p/:shortUrl/SalesOrder/payOnline", payOnline, { auth: "public" }),
];
