// POS（門市收銀）共用：範圍檢查、草稿訂單（sales_orders.state='DRAFT'）載入／重算／序列化。
// 原則：
// - 只接受後台登入者（auth:'admin'）；團購必須屬於登入者租戶；/pos/ajax/{租戶}/{短網址} 的租戶段必須等於登入者租戶。
// - 金額一律由伺服器端重算（storefront priceCart → marketing 優惠引擎），前端送來的金額只用來比對。
// - 草稿不扣庫存；結帳時由 DB 函式 groupbuy.pos_checkout 在單一交易內鎖草稿、檢查並扣庫存（migration 6003）。
import { rewardPointsOf } from "../points";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, forbidden, notFound } from "@/lib/core/http/errors";
import { readCookie, isSecureRequest } from "@/lib/core/auth/session";
import { taipeiDateTime } from "@/lib/core/time";
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuyByShortUrl, imageUrl, gbSetting, type SfGroupBuy } from "../site";
import { loadCatalog, type Catalog, type CatalogItem } from "../catalog";
import { priceCart, pointsEnabled, type PricingLine } from "../pricing";
import { PM_LABEL } from "../cart-data";

export type Row = Record<string, unknown>;
export const db = () => getServiceClient();

export const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const str = (v: unknown): string => (v == null ? "" : String(v));

export interface PosScope {
  session: AdminSession;
  gb: SfGroupBuy;
}

/** /pos/ajax/:tenant/:shortUrl/*、/pos/:tenant/:shortUrl/*、/{t}/p/:shortUrl/ajax/*、/:shortUrl/pos */
export async function posScope(ctx: RequestContext): Promise<PosScope> {
  const session = requireSession(ctx);
  const t = ctx.params.tenant;
  if (t != null && t !== session.tenantCode) throw forbidden("無權限存取此租戶");
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb || Number(gb.tenant_id) !== session.tenantId) throw notFound("找不到團購");
  return { session, gb };
}

async function q<T = Row>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}失敗：${error.message}`);
  return (Array.isArray(data) ? data : data ? [data] : []) as T[];
}
export { q };

/* ───────────────────────── 付款方式（getSupportPaymentMethods） ───────────────────────── */

const PM_ORDER = [8, 1, 4, 1024, 4096, 8192, 16384, 16, 2, 32, 64, 128, 512, 2048, 256];

/** 原站回傳 [{label, value:'名稱,代碼'}]；256＝自定義，可多筆（團購設定 customPaymentMethod，以逗號/換行分隔） */
export function supportPaymentMethods(gb: SfGroupBuy): { label: string; value: string }[] {
  const bits = num(gb.payment_methods);
  const out: { label: string; value: string }[] = [];
  for (const b of PM_ORDER) {
    if (!(bits & b)) continue;
    if (b === 256) {
      const names = str(gbSetting(gb, "customPaymentMethod", ""))
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const n of names.length ? names : ["現金"]) out.push({ label: n, value: `${n},256` });
    } else {
      const label = b === 8 ? "自取(現場付款)" : PM_LABEL[b] ?? String(b);
      out.push({ label, value: `${label},${b}` });
    }
  }
  return out;
}

/* ───────────────────────── 目前操作中的草稿（cookie） ───────────────────────── */

const COOKIE = "GBPOSSO";
export function currentSalesOrderId(ctx: RequestContext): number | null {
  const v = readCookie(ctx.req, COOKIE);
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function setCurrentSalesOrder(ctx: RequestContext, id: number | null): void {
  const secure = isSecureRequest(ctx.req) ? "; Secure" : "";
  ctx.cookies.set.push(id ? `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}` : `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

/* ───────────────────────── 草稿讀取 ───────────────────────── */

export interface Draft {
  order: Row;
  items: Row[];
  state: { auto_apply: boolean; coupon_codes: string[]; points_requested: number };
  customer: Row | null;
}

export async function loadOrder(scope: PosScope, salesOrderId: number, opts: { draftOnly?: boolean } = { draftOnly: true }): Promise<Draft> {
  const { session, gb } = scope;
  const [order] = await q(
    db().from("sales_orders").select("*").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).eq("id", salesOrderId).limit(1),
    "讀取訂單",
  );
  if (!order) throw badRequest("找不到訂單");
  if (opts.draftOnly !== false && order.state !== "DRAFT") throw badRequest("此訂單已結帳或非暫存訂單，無法於 POS 取單");
  const items = await q(
    db().from("order_items").select("*").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId).order("seq").order("id"),
    "讀取訂單商品",
  );
  const [st] = await q(db().from("pos_order_drafts").select("*").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId).limit(1), "讀取 POS 草稿");
  let customer: Row | null = null;
  if (order.customer_id) {
    [customer] = await q(db().from("customers").select("id, firstname, telephone, email, points").eq("tenant_id", session.tenantId).eq("id", num(order.customer_id)).limit(1), "讀取會員");
  }
  return {
    order,
    items,
    state: {
      auto_apply: st ? st.auto_apply !== false : true,
      coupon_codes: Array.isArray(st?.coupon_codes) ? (st!.coupon_codes as string[]) : [],
      points_requested: num(st?.points_requested),
    },
    customer: customer ?? null,
  };
}

export async function saveDraftState(scope: PosScope, salesOrderId: number, patch: Partial<Draft["state"]>): Promise<void> {
  const { error } = await db()
    .from("pos_order_drafts")
    .upsert({ sales_order_id: salesOrderId, tenant_id: scope.session.tenantId, group_buy_id: scope.gb.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "sales_order_id" });
  if (error) throw new Error(`更新 POS 草稿失敗：${error.message}`);
}

/* ───────────────────────── 重算（伺服器端唯一金額來源） ───────────────────────── */

export interface Repriced {
  subtotal: number;
  itemDiscounts: Map<number, number>;
  salesRules: { salesRuleId: number; title: string; discount: number; points?: number }[];
  coupons: { groupBuyCouponId: number; couponCodeId: number | null; code: string; title: string; category: string; discount: number; points?: number }[];
  /** 本筆可獲得的會員點數回饋（#117；ptEnabled 且已綁會員） */
  rewardPoints: number;
  totalDiscount: number;
  pointsUsed: number;
  pointsDiscount: number;
  pointsMax: number;
  tax: number;
  grandTotalWithoutShipping: number;
  grandTotal: number;
  couponNotes: string[];
}

export async function computePricing(scope: PosScope, d: Draft): Promise<Repriced> {
  const { session, gb } = scope;
  const live = d.items.filter((i) => num(i.total) > 0);
  const lines: PricingLine[] = live.map((i) => ({
    uuid: String(i.id),
    itemId: num(i.item_id),
    groupBuyItemSetId: num(i.group_buy_item_set_id),
    itemSetId: num(i.item_set_id),
    title: str(i.title),
    price: num(i.price),
    qty: num(i.total),
    backOrder: !!i.back_order,
  }));
  const balance = num(d.customer?.points);
  const r = await priceCart({
    tenantId: session.tenantId,
    groupBuy: gb,
    lines,
    couponCodes: d.state.coupon_codes,
    customerId: d.customer ? num(d.customer.id) : null,
    flatRateShippingId: null,
    paymentMethod: 0,
    shippingAddress: {},
    points: { requested: d.state.points_requested, balance },
  });
  const itemDiscounts = new Map<number, number>();
  let totalDiscount: number;
  let salesRules: Repriced["salesRules"] = [];
  if (d.state.auto_apply) {
    for (const i of live) itemDiscounts.set(num(i.id), Math.min(num(i.price) * num(i.total), Math.max(0, Math.round(r.lineDiscounts.get(String(i.id)) ?? 0))));
    totalDiscount = r.totalDiscount;
    salesRules = r.salesRules.map((s) => ({ salesRuleId: s.salesRuleId, title: s.title, discount: s.discount, points: s.points ?? 0 }));
  } else {
    // 手動折扣：每項折價由店員輸入（上限＝單價×數量），不套優惠條件；折扣碼仍照引擎計算（整筆折抵）
    let manual = 0;
    for (const i of live) {
      const v = Math.min(num(i.price) * num(i.total), Math.max(0, Math.round(num(i.discount))));
      itemDiscounts.set(num(i.id), v);
      manual += v;
    }
    totalDiscount = Math.min(r.subtotal, manual + r.couponTotalDiscount);
  }
  const afterDiscount = Math.max(0, r.subtotal - totalDiscount);
  let pointsUsed = 0;
  let pointsMax = 0;
  if (pointsEnabled(gb) && d.customer) {
    pointsMax = Math.min(balance, Math.floor(afterDiscount));
    pointsUsed = Math.min(Math.max(0, Math.floor(d.state.points_requested)), pointsMax);
  }
  const gws = afterDiscount - pointsUsed;
  const taxRate = num(gb.tax_rate);
  const tax = taxRate > 0 ? Math.round((gws * taxRate) / 100) : 0;
  return {
    subtotal: r.subtotal,
    itemDiscounts,
    salesRules,
    coupons: r.coupons.map((c) => ({ ...c })),
    totalDiscount,
    pointsUsed,
    pointsDiscount: pointsUsed,
    pointsMax,
    tax,
    grandTotalWithoutShipping: gws,
    grandTotal: gws + tax,
    couponNotes: r.couponNotes,
    rewardPoints: rewardPointsOf({ enabled: pointsEnabled(gb), isMember: !!d.customer, rules: salesRules, coupons: r.coupons }),
  };
}

/** 重算並寫回草稿（明細折扣/小計、訂單總額、套用中的優惠條件與優惠卷） */
export async function reprice(scope: PosScope, salesOrderId: number): Promise<{ draft: Draft; pricing: Repriced }> {
  const tenantId = scope.session.tenantId;
  let d = await loadOrder(scope, salesOrderId);
  const p = await computePricing(scope, d);
  for (const i of d.items) {
    const disc = p.itemDiscounts.get(num(i.id)) ?? 0;
    const amount = num(i.price) * num(i.total) - disc;
    if (num(i.discount) !== disc || num(i.amount) !== amount) {
      const { error } = await db().from("order_items").update({ discount: disc, amount }).eq("tenant_id", tenantId).eq("id", num(i.id));
      if (error) throw new Error(`更新訂單商品失敗：${error.message}`);
    }
  }
  const { error } = await db()
    .from("sales_orders")
    .update({ grand_total: p.grandTotal, discount_amount: p.totalDiscount, points_used: p.pointsUsed, coupon_code: d.state.coupon_codes.join(",") || null })
    .eq("tenant_id", tenantId)
    .eq("id", salesOrderId)
    .eq("state", "DRAFT");
  if (error) throw new Error(`更新訂單失敗：${error.message}`);
  await db().from("sales_order_sales_rules").delete().eq("tenant_id", tenantId).eq("sales_order_id", salesOrderId);
  await db().from("sales_order_coupons").delete().eq("tenant_id", tenantId).eq("sales_order_id", salesOrderId);
  if (p.salesRules.length) {
    await db().from("sales_order_sales_rules").insert(p.salesRules.map((s) => ({ tenant_id: tenantId, sales_order_id: salesOrderId, sales_rule_id: s.salesRuleId, title: s.title, discount: s.discount })));
  }
  if (p.coupons.length) {
    await db().from("sales_order_coupons").insert(
      p.coupons.map((c) => ({ tenant_id: tenantId, sales_order_id: salesOrderId, group_buy_coupon_id: c.groupBuyCouponId, coupon_code_id: c.couponCodeId, coupon: c.code, discount: c.discount })),
    );
  }
  d = await loadOrder(scope, salesOrderId);
  return { draft: d, pricing: p };
}

/* ───────────────────────── 序列化（原站 salesOrder JSON 鍵，見 spec/POS_SPEC.md §6） ───────────────────────── */

export async function catalogFor(scope: PosScope): Promise<Catalog> {
  return loadCatalog(scope.session.tenantId, scope.gb.id, { includeOffline: true });
}

function couponJson(c: { code: string; title: string; groupBuyCouponId: number; category: string; discount: number }, extra?: Row) {
  return {
    code: c.code,
    title: c.title,
    couponId: c.groupBuyCouponId,
    category: c.category,
    discount: num(extra?.discount ?? c.discount),
    dollarOrPercentage: str(extra?.dollar_or_percentage ?? "DOLLAR"),
    dateEndString: "",
    expired: false,
  };
}

export async function salesOrderJson(scope: PosScope, d: Draft, p?: Repriced | null, cat?: Catalog | null): Promise<Row> {
  const catalog = cat ?? (await catalogFor(scope));
  const o = d.order;
  const items = d.items.map((i) => {
    const it: CatalogItem | undefined = catalog.byId.get(num(i.item_id));
    const back = !!i.back_order;
    return {
      orderItemId: num(i.id),
      itemId: num(i.item_id),
      groupBuyItemSetId: num(i.group_buy_item_set_id),
      title: str(i.title),
      total: num(i.total),
      price: num(i.price),
      discount: num(i.discount),
      amount: num(i.amount),
      image: imageUrl(it?.image, "/upload/images/unsort/logo512.png"),
      status: back ? "BACKORDER" : "UNSHIPPING",
      state: str(i.state),
      stateString: back ? "預購" : "現貨",
      backOrder: back,
      maxOrderQuota: it ? it.maxOrderQuota : num(i.total),
      stockAvailable: it ? it.stockAvailable : 0,
      stockBackOrderAvailable: it ? it.stockBackOrderAvailable : 0,
    };
  });
  // 優惠卷顯示需要 dollarOrPercentage
  const couponRows = await q(
    db().from("sales_order_coupons").select("group_buy_coupon_id, coupon_code_id, coupon, discount").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", num(o.id)),
    "讀取訂單優惠卷",
  );
  const gbcIds = [...new Set(couponRows.map((c) => num(c.group_buy_coupon_id)).filter(Boolean))];
  const gbcs = gbcIds.length
    ? await q(db().from("group_buy_coupons").select("id, title, category, dollar_or_percentage, discount").eq("tenant_id", scope.session.tenantId).in("id", gbcIds), "讀取優惠卷")
    : [];
  const gbcById = new Map(gbcs.map((g) => [num(g.id), g]));
  const rules = await q(
    db().from("sales_order_sales_rules").select("sales_rule_id, title, discount").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", num(o.id)),
    "讀取訂單優惠條件",
  );
  const subtotal = items.reduce((s, i) => s + i.price * i.total, 0);
  const totalDiscount = num(o.discount_amount);
  const pointsUsed = num(o.points_used);
  const gws = p ? p.grandTotalWithoutShipping : Math.max(0, subtotal - totalDiscount - pointsUsed);
  return {
    salesOrderId: num(o.id),
    uuid: str(o.uuid),
    state: str(o.state),
    customerId: o.customer_id == null ? null : num(o.customer_id),
    customerIsGuest: o.customer_id == null,
    customerFirstname: str(o.customer_firstname),
    customerTelephone: str(o.customer_telephone),
    customerEmail: str(o.customer_email),
    dateCreatedString: taipeiDateTime(o.created_at),
    grandTotal: num(o.grand_total),
    grandTotalWithoutShipping: gws,
    totalDiscount,
    subtotal,
    shippingAmount: 0,
    pointsUsed,
    note: str(o.note),
    staffNote: str(o.staff_note),
    sortedOrderItems: items,
    salesOrderSalesRules: rules.map((r) => ({ salesRuleId: num(r.sales_rule_id), title: str(r.title), discount: num(r.discount) })),
    salesOrderCoupons: couponRows.map((c) => {
      const g = gbcById.get(num(c.group_buy_coupon_id));
      return {
        groupBuyFlatRateShippingId: null,
        discount: num(c.discount),
        coupon: couponJson({ code: str(c.coupon), title: str(g?.title), groupBuyCouponId: num(c.group_buy_coupon_id), category: str(g?.category), discount: num(g?.discount) }, g),
      };
    }),
    pointTransactions: pointsUsed > 0 ? [{ reason: "USE_POINT", points: -pointsUsed, amount: pointsUsed }] : [],
  };
}

export async function salesOrderResponse(scope: PosScope, salesOrderId: number): Promise<Row> {
  const { draft, pricing } = await reprice(scope, salesOrderId);
  return { data: { salesOrder: await salesOrderJson(scope, draft, pricing) } };
}

/* ───────────────────────── 會員 ───────────────────────── */

export function customerJson(gb: SfGroupBuy, c: Row) {
  return {
    customerId: num(c.id),
    firstname: str(c.firstname),
    telephone: str(c.telephone),
    email: str(c.email),
    customerRoyaltyProgram: pointsEnabled(gb) ? { pointsName: "點數", points: num(c.points) } : null,
  };
}

export function normPhone(v: unknown): string {
  return str(v).replace(/[^\d+]/g, "").slice(0, 20);
}
