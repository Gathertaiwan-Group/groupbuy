// 訂單進度查詢（fe-order-query）：/{shortUrl}/order、SalesOrder/show（訂單明細）、queryUuid（忘記訂單號碼）
import { get, post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, json, redirect } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { renderTemplate } from "@/lib/core/render/template";
import { getServiceClient } from "@/lib/supabase/server";
import { feVars, scopeFromTenantPath, tenantById, tenantByCode, groupBuyByShortUrl, type SfGroupBuy } from "./site";
import { readCustomerSession } from "./customer-session";
import { clean, ipOf, isEmail, rateAllowed, rateLimit, rateRecord } from "./guard";
import { grantOrderView, hasOrderViewGrant } from "./order-grant";
import { renderOrderDetail } from "./order-detail";

export async function renderOrderQueryPage(
  ctx: RequestContext,
  gb: SfGroupBuy,
  o: { message?: string; prefillUuid?: string; status?: number },
): Promise<Response> {
  const tenant = await tenantById(gb.tenant_id);
  if (!tenant) throw new Error("租戶不存在");
  const customer = await readCustomerSession(ctx, tenant.id);
  return html(
    renderTemplate("storefront/order-query.html", {
      ...feVars(ctx, { tenant, groupBuy: gb, customer }),
      queryMessage: o.message ?? "",
      prefillUuid: o.prefillUuid ?? "",
    }),
    { status: o.status ?? 200 },
  );
}

const UUID_RE = /^[0-9A-Za-z-]{6,40}$/;
const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

type OrderRow = { id: number; tenant_id: number; uuid: string; group_buy_id: number | null; customer_id: number | null; customer_telephone: string | null };

async function findOrder(tenantId: number, uuid: string): Promise<OrderRow | null> {
  const { data, error } = await getServiceClient()
    .from("sales_orders")
    .select("id, tenant_id, uuid, group_buy_id, customer_id, customer_telephone")
    .eq("tenant_id", tenantId)
    .eq("uuid", uuid)
    .not("state", "in", "(DRAFT,DELETED)")
    .maybeSingle();
  if (error) throw new Error(`查詢訂單失敗：${error.message}`);
  return (data as OrderRow | null) ?? null;
}

/** POST /{租戶}/p/{shortUrl}/SalesOrder/show：訂單編號＋電話驗證 → 授權 cookie → 303 到只帶訂單編號的網址 */
async function showPost(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  const gb = groupBuy!;
  const b = await ctx.body();
  const uuid = clean(b.flat.get("uuid")?.[0], 40, "訂單編號");
  const tel = clean(b.flat.get("customerTelephone")?.[0], 30, "顧客電話");
  const ip = ipOf(ctx);
  const failKey = `soshow:fail:${ip}`;
  if (!(await rateAllowed(failKey, 900, 10))) {
    return renderOrderQueryPage(ctx, gb, { message: "查詢失敗次數過多，請 15 分鐘後再試", prefillUuid: uuid, status: 429 });
  }
  const order = uuid && UUID_RE.test(uuid) ? await findOrder(tenant.id, uuid) : null;
  const ok = !!order && digits(tel).length >= 6 && digits(order.customer_telephone) === digits(tel);
  if (!ok) {
    await rateRecord(failKey, 900, 10);
    return renderOrderQueryPage(ctx, gb, { message: "查無訂單資料，請確認訂單編號與顧客電話", prefillUuid: uuid });
  }
  grantOrderView(ctx, tenant.id, order.uuid);
  return redirect(`/${tenant.code}/p/${gb.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`, 303);
}

/** GET …/SalesOrder/show?uuid=：已授權（剛查詢/剛下單）或會員本人 → 訂單明細；否則回查詢頁 */
async function showGet(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  const gb = groupBuy!;
  const uuid = clean(ctx.query.get("uuid"), 40, "訂單編號");
  if (ctx.query.get("customerTelephone")) {
    // 原站以 GET 帶電話；本系統不接受個資放網址，請改用表單
    return renderOrderQueryPage(ctx, gb, { message: "請輸入訂單編號與顧客電話查詢", prefillUuid: uuid });
  }
  if (!uuid || !UUID_RE.test(uuid)) return renderOrderQueryPage(ctx, gb, {});
  const order = await findOrder(tenant.id, uuid);
  const customer = await readCustomerSession(ctx, tenant.id);
  const allowed = !!order && (hasOrderViewGrant(ctx, tenant.id, order.uuid) || (!!customer && order.customer_id === customer.customer.id));
  if (!order || !allowed) return renderOrderQueryPage(ctx, gb, { message: order ? "請輸入顧客電話以查看訂單" : "", prefillUuid: uuid });
  // 訂單屬於別的團購：轉到該團購網址下顯示
  if (order.group_buy_id && order.group_buy_id !== gb.id) {
    const { data } = await getServiceClient().from("group_buys").select("short_url").eq("tenant_id", tenant.id).eq("id", order.group_buy_id).maybeSingle();
    const su = (data as { short_url: string | null } | null)?.short_url;
    if (su && su !== gb.short_url) return redirect(`/${tenant.code}/p/${su}/SalesOrder/show.do?uuid=${encodeURIComponent(order.uuid)}`, 302);
  }
  return renderOrderDetail(ctx, tenant, gb, order.id, customer);
}

/** 忘記訂單號碼：姓名＋Email 查近 3 個月訂單（原站回 {data:[訂單編號…]}） */
async function queryUuid(ctx: RequestContext): Promise<Response> {
  const tenant = await tenantByCode(ctx.tenantPrefix);
  if (!tenant) throw badRequest("找不到商店");
  const name = clean(await ctx.param("customerFirstname"), 50, "顧客姓名");
  const email = clean(await ctx.param("customerEmail"), 255, "顧客Email");
  if (!name || !email) throw badRequest("請輸入顧客姓名與顧客Email");
  if (!isEmail(email)) throw badRequest("email格式不正確，是否拼錯字，或是沒有帶小老鼠@呢？");
  await rateLimit(`queryuuid:ip:${ipOf(ctx)}`, 900, 10, "查詢太頻繁，請 15 分鐘後再試");
  const since = new Date(Date.now() - 92 * 24 * 3600 * 1000).toISOString();
  const db = getServiceClient();
  const out = new Set<string>();
  for (const e of Array.from(new Set([email.toLowerCase(), email]))) {
    const { data, error } = await db
      .from("sales_orders")
      .select("uuid, customer_firstname")
      .eq("tenant_id", tenant.id)
      .eq("customer_email", e)
      .gte("created_at", since)
      .not("state", "in", "(DRAFT,DELETED)")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(`查詢訂單失敗：${error.message}`);
    for (const r of (data ?? []) as { uuid: string; customer_firstname: string | null }[]) {
      if ((r.customer_firstname ?? "").trim() === name) out.add(r.uuid);
    }
  }
  return json({ code: 200, error: "", data: [...out] });
}

/** 訂單編號＋電話查詢的 GET 入口相容：/{租戶}/p/{shortUrl}/SalesOrder/show 以外還有短網址版本 */
async function orderPageByShortUrl(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb) return html("", { status: 404 });
  return renderOrderQueryPage(ctx, gb, {});
}

export const orderQueryRoutes: RouteDef[] = [
  post("/p/:shortUrl/SalesOrder/show", showPost, { auth: "public" }),
  get("/p/:shortUrl/SalesOrder/show", showGet, { auth: "public" }),
  post("/ajax/web/SalesOrder/queryUuid", queryUuid, { auth: "public" }),
  get("/ajax/web/SalesOrder/queryUuid", queryUuid, { auth: "public" }),
];
void orderPageByShortUrl;
