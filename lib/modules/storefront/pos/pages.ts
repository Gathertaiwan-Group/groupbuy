// POS 頁面與 HTML 片段（原站 /{shortUrl}/pos 與 openForm 片段；結構推導見 spec/POS_SPEC.md）。
import { randomBytes } from "node:crypto";
import type { RequestContext } from "@/lib/core/http/types";
import { html, json, actionOk } from "@/lib/core/http/responses";
import { badRequest, forbidden, notFound } from "@/lib/core/http/errors";
import { renderTemplate } from "@/lib/core/render/template";
import { csrfCookieIfNeeded, expectedCsrfToken, injectCsrfScript } from "@/lib/core/http/csrf";
import { isSecureRequest } from "@/lib/core/auth/session";
import { commonVars } from "@/lib/core/render/vars";
import { taipeiDateTime } from "@/lib/core/time";
import { groupBuyByShortUrl, imageUrl, tenantById, taipeiYear } from "../site";
import { formatPrice } from "../catalog";
import { posScope, db, q, num, str, catalogFor, type PosScope } from "./core";
import { activeRules } from "./api";

const taipeiToday = () => taipeiDateTime(new Date()).slice(0, 10);
const dayStartIso = (ymd: string) => new Date(`${ymd}T00:00:00+08:00`).toISOString();
const dayEndIso = (ymd: string) => new Date(new Date(`${ymd}T00:00:00+08:00`).getTime() + 86400000).toISOString();

/* ───────────────────────── 主頁 /:shortUrl/pos ───────────────────────── */

async function todayStats(scope: PosScope) {
  const ymd = taipeiToday();
  const orders = await q(
    db().from("sales_orders").select("grand_total").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).gte("created_at", dayStartIso(ymd)).lt("created_at", dayEndIso(ymd)).not("state", "in", "(DRAFT,CANCELED,DELETED)"),
    "讀取今日訂單",
  );
  const { count } = await db().from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", scope.session.tenantId).gte("created_at", dayStartIso(ymd));
  const total = orders.reduce((s, o) => s + num(o.grand_total), 0);
  return { newCustomers: count ?? 0, orders: orders.length, avg: orders.length ? Math.round(total / orders.length) : 0, total: total.toLocaleString("en-US") };
}

export async function posPage(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb) throw notFound("找不到團購");
  const tenant = await tenantById(Number(gb.tenant_id));
  if (!tenant) throw notFound("找不到團購");
  if (!ctx.session) {
    // 未登入：原站 POS 自己的登入頁（標題「管理員」）
    return html(
      renderTemplate("storefront/pos/login.html", {
        ...commonVars(ctx),
        tenantCode: tenant.code,
        loginAction: `/${tenant.code}/ajax/pos/AdminUser/login.do`,
        redirect: ctx.url.pathname,
        year: taipeiYear(),
      }),
    );
  }
  if (Number(gb.tenant_id) !== ctx.session.tenantId) throw forbidden("此團購不屬於目前登入的廠商");
  const scope: PosScope = { session: ctx.session, gb };
  const t = ctx.session.tenantCode;
  // 此路由為 auth:'optional'（未登入要顯示 POS 自己的登入頁），dispatch 只對 admin 路由補 CSRF → 這裡自行補上（同 dispatch withCsrf）
  const expected = expectedCsrfToken(ctx.req);
  if (expected) {
    const c = csrfCookieIfNeeded(ctx.req, expected, isSecureRequest(ctx.req));
    if (c) ctx.cookies.set.push(c);
  }
  const page = renderTemplate("storefront/pos/pos.html", {
      ...commonVars(ctx),
      groupBuy: { id: gb.id, title: gb.title, shortUrl: gb.short_url },
      webCtx: `/${gb.short_url}`,
      ctxPos: `/pos/${t}/${gb.short_url}`,
      ctxPosAjax: `/pos/ajax/${t}/${gb.short_url}`,
      posBaseUrl: `/${t}/p/${gb.short_url}`,
      cartUuid: randomBytes(16).toString("hex"),
      paramSalesOrderUUID: str(ctx.query.get("salesOrderUuid") ?? ctx.query.get("uuid") ?? ""),
      paramMode: str(ctx.query.get("mode") ?? ""),
      adminName: ctx.session.displayName || ctx.session.account,
      stats: await todayStats(scope),
      year: taipeiYear(),
    });
  return html(expected ? injectCsrfScript(page, "1") : page);
}

/* ───────────────────────── 片段 ───────────────────────── */

function frag(template: string, data: Record<string, unknown>, ctx: RequestContext): Response {
  return html(renderTemplate(template, { ...commonVars(ctx), ...data }));
}

export async function itemShow(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const itemId = Number(ctx.query.get("itemId") ?? (await ctx.param("itemId")));
  const cat = await catalogFor(scope);
  const it = cat.byId.get(itemId);
  if (!it) throw notFound("找不到商品");
  const images = [it.image, it.imagePopup].filter((x): x is string => !!x).map((x) => imageUrl(x));
  if (!images.length) images.push("/upload/images/unsort/logo512.png");
  const maxQ = Math.max(1, Math.min(it.maxOrderQuota, it.stockAvailable + it.stockBackOrderAvailable) || 1);
  return frag(
    "storefront/pos/item-show.html",
    {
      item: it,
      images,
      multiImages: images.length > 1,
      priceText: it.price.toFixed(2),
      retailPriceText: it.retailPrice ? formatPrice(it.retailPrice, scope.gb.currency) : "",
      qtyOptions: Array.from({ length: Math.min(maxQ, 99) }, (_, i) => i + 1),
      hasStock: it.stockAvailable > 0,
      hasBackOrder: it.stockBackOrderAvailable > 0,
      backOrderOnly: it.stockAvailable <= 0 && it.stockBackOrderAvailable > 0,
      soldOut: it.stockAvailable + it.stockBackOrderAvailable <= 0,
    },
    ctx,
  );
}

const CAT_LABEL: Record<string, string> = {
  MINIMUM_PRICE_MEET: "滿額",
  MINIMUM_PIECE_MEET: "滿件",
  DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE: "每滿",
};

export async function salesRules(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const rows = await activeRules(scope);
  const rules = rows.map((r) => {
    const pct = str(r.dollar_or_percentage) === "PERCENTAGE";
    const disc = pct ? `${num(r.discount)}% 折扣` : `折 ${num(r.discount)} 元`;
    const head = CAT_LABEL[str(r.category)] ?? "";
    return { title: str(r.title), descr: `${head}${num(r.minimum) ? ` ${num(r.minimum)}` : ""}　${disc}`.trim() };
  });
  return frag("storefront/pos/sales-rules.html", { rules }, ctx);
}

export async function discountTags(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  const maxDiscount = Math.max(0, Math.floor(Number(ctx.query.get("maxDiscount") ?? 0)));
  const tags = [
    { label: "95折", operator: "*", factor: 0.05 },
    { label: "9折", operator: "*", factor: 0.1 },
    { label: "85折", operator: "*", factor: 0.15 },
    { label: "8折", operator: "*", factor: 0.2 },
    { label: "7折", operator: "*", factor: 0.3 },
    { label: "折 10 元", operator: "-", factor: 10 },
    { label: "折 50 元", operator: "-", factor: 50 },
    { label: "折 100 元", operator: "-", factor: 100 },
  ].filter((t) => t.operator === "*" || t.factor <= maxDiscount);
  return frag("storefront/pos/discount-tags.html", { tags, maxDiscount }, ctx);
}

export async function displayCoupon(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return frag("storefront/pos/display-coupon.html", {}, ctx);
}

const STATE_LABEL: Record<string, string> = { DRAFT: "草稿", NEW: "新訂單", PROCESSING: "處理中", COMPLETE: "已完成", HOLDED: "保留", CANCELED: "已取消", RETURNED: "已退換貨", RETURNING: "退換貨中" };

export async function customerOrders(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const customerId = Number(ctx.query.get("customerId"));
  if (!Number.isSafeInteger(customerId) || customerId <= 0) throw badRequest("請先登入會員");
  const state = str(ctx.query.get("stateString"));
  let qb = db()
    .from("sales_orders")
    .select("id, uuid, state, grand_total, created_at")
    .eq("tenant_id", scope.session.tenantId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(100);
  qb = state === "DRAFT" ? qb.eq("state", "DRAFT").eq("group_buy_id", scope.gb.id) : qb.not("state", "in", "(DRAFT,DELETED)");
  const rows = await q(qb, "讀取會員訂單");
  return frag(
    "storefront/pos/customer-orders.html",
    {
      title: state === "DRAFT" ? "未完成訂單" : "消費記錄",
      customerFirstname: str(ctx.query.get("customerFirstname")),
      customerTelephone: str(ctx.query.get("customerTelephone")),
      orders: rows.map((o) => ({
        salesOrderId: num(o.id),
        uuid: str(o.uuid),
        isDraft: o.state === "DRAFT",
        stateLabel: STATE_LABEL[str(o.state)] ?? str(o.state),
        grandTotal: num(o.grand_total),
        dateCreatedString: taipeiDateTime(o.created_at),
      })),
    },
    ctx,
  );
}

export async function customerRegisterForm(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return frag("storefront/pos/customer-register.html", {}, ctx);
}

export async function dailyBalanceFragment(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return frag("storefront/pos/daily-balance.html", { today: taipeiToday() }, ctx);
}

export async function requisitionListFragment(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return frag("storefront/pos/requisition-list.html", {}, ctx);
}

export async function requisitionCreateFragment(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const whs = await q(db().from("warehouses").select("id, name, short_name").eq("tenant_id", scope.session.tenantId).order("id"), "讀取倉庫");
  const cat = await catalogFor(scope);
  return frag(
    "storefront/pos/requisition-create.html",
    { warehouses: whs.map((w) => ({ id: num(w.id), title: str(w.name) || str(w.short_name) })), items: cat.items.map((i) => ({ itemId: i.itemId, title: i.title, uid: str(i.uid) })) },
    ctx,
  );
}

/* ───────────────────────── 收據 ───────────────────────── */

const RECEIPT_LABEL = (o: Record<string, unknown>): string => {
  if (o.invoice_number) return "通路代開";
  if (num(o.billing_receipt_type) === 2) return "三聯式";
  if (num(o.billing_receipt_carrier_type) === 3) return "手機載具";
  return "二聯式";
};

export async function receipt(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = Number(ctx.query.get("salesOrderId"));
  const [o] = await q(db().from("sales_orders").select("*").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("id", id).limit(1), "讀取訂單");
  if (!o) throw notFound("找不到訂單");
  const items = await q(db().from("order_items").select("title, price, total, discount, back_order").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", id).order("seq").order("id"), "讀取訂單商品");
  const rules = await q(db().from("sales_order_sales_rules").select("title, discount").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", id), "讀取優惠條件");
  const coupons = await q(db().from("sales_order_coupons").select("coupon, discount").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", id), "讀取優惠卷");
  const pays = await q(db().from("pos_payments").select("payment_method_tag, amount, cash_received, change_amount, admin_user_id, kind, created_at").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", id).order("id"), "讀取付款明細");
  const tenant = await tenantById(scope.session.tenantId);
  const lines = items.map((i) => ({ title: str(i.title), price: num(i.price), total: num(i.total), subtotal: num(i.price) * num(i.total), discount: num(i.discount) && !rules.length ? num(i.discount) : 0, backOrder: !!i.back_order }));
  return html(
    renderTemplate("storefront/pos/receipt.html", {
      tenantName: tenant?.name ?? scope.session.tenantName ?? "",
      groupBuy: { title: scope.gb.title },
      cashier: scope.session.displayName || scope.session.account,
      order: {
        uuid: str(o.uuid),
        dateString: taipeiDateTime(o.date_paid ?? o.updated_at, true),
        customerFirstname: str(o.customer_firstname),
        customerTelephone: str(o.customer_telephone),
        grandTotal: num(o.grand_total),
        pointsUsed: num(o.points_used),
        vatId: str(o.billing_receipt_vat_id),
        carrierNum: str(o.billing_receipt_carrier_num),
      },
      items: lines,
      subtotal: lines.reduce((s, l) => s + l.subtotal, 0),
      rules: rules.map((r) => ({ title: str(r.title), discount: num(r.discount) })),
      coupons: coupons.map((c) => ({ coupon: str(c.coupon), discount: num(c.discount) })),
      payments: pays.map((p) => ({
        tag: str(p.payment_method_tag),
        amount: num(p.amount),
        cashReceived: p.cash_received == null ? null : num(p.cash_received),
        change: num(p.change_amount),
        // fix4：POS 作廢寫的負數沖銷列（6005 kind=VOID）要標示清楚，不能看起來像第二筆付款
        isVoid: str(p.kind) === "VOID",
        dateString: str(p.kind) === "VOID" ? taipeiDateTime(p.created_at, true) : "",
      })),
      voided: str(o.state) === "CANCELED" || pays.some((p) => str(p.kind) === "VOID"),
      voidDateString: o.date_canceled ? taipeiDateTime(o.date_canceled, true) : "",
      hasVoidPayments: pays.some((p) => str(p.kind) === "VOID"),
      netPaid: pays.reduce((s, p) => s + num(p.amount), 0),
      receiptLabel: RECEIPT_LABEL(o),
    }),
  );
}

/* ───────────────────────── 日結 ───────────────────────── */

async function dailyData(scope: PosScope, ymd: string) {
  const pays = await q(
    db().from("pos_payments").select("payment_method, payment_method_tag, amount").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).gte("created_at", dayStartIso(ymd)).lt("created_at", dayEndIso(ymd)),
    "讀取今日收款",
  );
  const byTag = new Map<string, { paymentMethod: number; tag: string; expected: number }>();
  for (const p of pays) {
    const k = `${str(p.payment_method_tag)},${num(p.payment_method)}`;
    const cur = byTag.get(k) ?? { paymentMethod: num(p.payment_method), tag: str(p.payment_method_tag), expected: 0 };
    cur.expected += num(p.amount);
    byTag.set(k, cur);
  }
  const [saved] = await q(
    db().from("pos_daily_balances").select("*").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("business_date", ymd).limit(1),
    "讀取日結",
  );
  const savedReceipts = (Array.isArray(saved?.receipts) ? saved!.receipts : []) as { tag: string; paymentMethod: number; actual: number }[];
  const receipts = [...byTag.values()].map((r) => {
    const s = savedReceipts.find((x) => x.tag === r.tag && Number(x.paymentMethod) === r.paymentMethod);
    return { ...r, actual: s ? num(s.actual) : r.expected };
  });
  return { receipts, expenses: (Array.isArray(saved?.expenses) ? saved!.expenses : []) as { category: string; title: string; amount: number }[], completed: !!saved?.completed_at };
}

export async function dailyPreview(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const ymd = taipeiToday();
  const d = await dailyData(scope, ymd);
  return json({ data: { businessDate: ymd, ...d } });
}

export async function dailySave(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const ymd = taipeiToday();
  const base = await dailyData(scope, ymd);
  let receiptsIn: { tag?: string; paymentMethod?: number; actual?: number }[] = [];
  let expensesIn: { category?: string; title?: string; amount?: number }[] = [];
  try {
    receiptsIn = JSON.parse(str(await ctx.param("receipts")) || "[]");
    expensesIn = JSON.parse(str(await ctx.param("expenses")) || "[]");
  } catch {
    throw badRequest("資料格式錯誤");
  }
  if (!Array.isArray(receiptsIn) || !Array.isArray(expensesIn) || expensesIn.length > 200) throw badRequest("資料格式錯誤");
  const CATS = ["文具用品", "雜費", "電信費", "餐費", "其他"];
  // 帳面應收一律以伺服器端的收款紀錄為準；前端只提供實收與支出
  const receipts = base.receipts.map((r) => {
    const s = receiptsIn.find((x) => x && x.tag === r.tag && Number(x.paymentMethod) === r.paymentMethod);
    const actual = s && Number.isFinite(Number(s.actual)) ? Math.max(0, Math.round(Number(s.actual))) : r.actual;
    return { paymentMethod: r.paymentMethod, tag: r.tag, expected: r.expected, actual };
  });
  const expenses = expensesIn.map((e) => {
    const amount = Math.round(Number(e?.amount));
    if (!CATS.includes(str(e?.category)) || !Number.isFinite(amount) || amount < 0) throw badRequest("支出資料錯誤");
    return { category: str(e.category), title: str(e.title).slice(0, 60), amount };
  });
  const complete = ["true", "1"].includes(str(await ctx.param("complete")));
  const row = {
    tenant_id: scope.session.tenantId,
    group_buy_id: scope.gb.id,
    business_date: ymd,
    receipts,
    expenses,
    total_expected: receipts.reduce((s, r) => s + r.expected, 0),
    total_actual: receipts.reduce((s, r) => s + r.actual, 0),
    total_expense: expenses.reduce((s, e) => s + e.amount, 0),
    admin_user_id: scope.session.adminUserId,
    updated_at: new Date().toISOString(),
    ...(complete ? { completed_at: new Date().toISOString() } : {}),
  };
  const { error } = await db().from("pos_daily_balances").upsert(row, { onConflict: "tenant_id,group_buy_id,business_date" });
  if (error) throw new Error(`儲存日結失敗：${error.message}`);
  return actionOk(complete ? "已完成日結" : "已套用");
}
