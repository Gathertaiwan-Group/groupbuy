// 前台會員：登出、登入狀態、官網選單、修改密碼、更新個人資料、常用地址、會員中心（訂單列表）。
// 協定見 scratchpad/sf/proto-common.md §2.3.11、§3、§4。會員資料一律以「網址租戶」＋「session 會員 id」過濾。
import { any, get, post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, json, redirect } from "@/lib/core/http/responses";
import { badRequest, HttpError } from "@/lib/core/http/errors";
import { renderTemplate } from "@/lib/core/render/template";
import { enumLabel } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import { hashPassword, verifyPassword } from "@/lib/core/auth/password";
import { getServiceClient } from "@/lib/supabase/server";
import { feVars, scopeFromTenantPath } from "./site";
import { destroyCustomerSession, destroyOtherCustomerSessions, readCustomerSession } from "./customer-session";
import { userMenuItems } from "./customer-menu";
import { customerLoginData } from "./customer-auth";
import { clean, isPhone, rateAllowed, rateLimit, rateRecord } from "./guard";
import { formatPrice } from "./catalog";

async function logoutPage(ctx: RequestContext): Promise<Response> {
  const { groupBuy } = await scopeFromTenantPath(ctx);
  await destroyCustomerSession(ctx);
  return redirect(groupBuy?.short_url ? `/${groupBuy.short_url}` : "/", 302);
}

async function logoutAjax(ctx: RequestContext): Promise<Response> {
  await scopeFromTenantPath(ctx);
  await destroyCustomerSession(ctx);
  return json({ code: 200, error: "已登出" });
}

async function isLogin(ctx: RequestContext): Promise<Response> {
  const { tenant } = await scopeFromTenantPath(ctx);
  const c = await readCustomerSession(ctx, tenant.id);
  return c ? json({ code: 200 }) : json({ code: 401, error: "尚未登入" }, { status: 401 });
}

async function getUserMenu(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const c = await readCustomerSession(ctx, tenant.id);
  const base = `/${tenant.code}/p/${groupBuy?.short_url || "null"}`;
  const items = userMenuItems(base, c);
  const nav5 = ctx.query.get("navStyle") === "5";
  return json({ menuItems: nav5 && c ? [items.join(""), items.join("")] : nav5 ? [items[0]] : items, uuid: c?.customer.uuid ?? null });
}

async function fragmentPage(ctx: RequestContext, template: string): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const customer = await readCustomerSession(ctx, tenant.id);
  return html(renderTemplate(template, { ...feVars(ctx, { tenant, groupBuy, customer }) }));
}

async function changePassword(ctx: RequestContext): Promise<Response> {
  if (ctx.method === "GET" || ctx.method === "HEAD") return fragmentPage(ctx, "storefront/customer-change-password.html");
  const { tenant } = await scopeFromTenantPath(ctx);
  const s = await readCustomerSession(ctx, tenant.id);
  if (!s) throw new HttpError(401, "請先登入會員");
  const b = await ctx.body();
  const oldPw = String(b.flat.get("oldPassword")?.[0] ?? "");
  const pw = String(b.flat.get("password")?.[0] ?? "");
  const confirm = String(b.flat.get("confirmPassword")?.[0] ?? "");
  const key = `chpw:${tenant.id}:${s.customer.id}`;
  if (!(await rateAllowed(key, 900, 5))) throw new HttpError(429, "嘗試次數過多，請 15 分鐘後再試");
  if (pw.length < 6 || pw.length > 10) throw badRequest("密碼為 6-10 碼");
  if (pw !== confirm) throw badRequest("兩次輸入的密碼不一致");
  const { data } = await getServiceClient().from("customers").select("password_hash").eq("tenant_id", tenant.id).eq("id", s.customer.id).maybeSingle();
  if (!(await verifyPassword(oldPw, (data as { password_hash: string | null } | null)?.password_hash))) {
    await rateRecord(key, 900, 5);
    throw badRequest("目前密碼錯誤");
  }
  await getServiceClient().from("customers").update({ password_hash: await hashPassword(pw) }).eq("tenant_id", tenant.id).eq("id", s.customer.id);
  await destroyOtherCustomerSessions(s.customer.id, tenant.id, s.sessionId);
  return json({ code: 200, error: "密碼已更新" });
}

async function editProfile(ctx: RequestContext): Promise<Response> {
  if (ctx.method === "GET" || ctx.method === "HEAD") return fragmentPage(ctx, "storefront/customer-edit-profile.html");
  const { tenant } = await scopeFromTenantPath(ctx);
  const s = await readCustomerSession(ctx, tenant.id);
  if (!s) throw new HttpError(401, "請先登入會員");
  await rateLimit(`profile:${tenant.id}:${s.customer.id}`, 600, 20);
  const b = await ctx.body();
  const firstname = clean(b.flat.get("firstname")?.[0], 20, "姓名").replace(/[<>"']/g, "");
  const telephone = clean(b.flat.get("telephone")?.[0], 20, "電話");
  const birthday = clean(b.flat.get("birthdayString")?.[0], 10, "生日");
  if (!firstname) throw badRequest("請輸入姓名");
  if (!isPhone(telephone)) throw badRequest("電話格式不正確");
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw badRequest("生日格式不正確");
  const { data, error } = await getServiceClient()
    .from("customers")
    .update({ firstname, telephone, birthday: birthday || null })
    .eq("tenant_id", tenant.id)
    .eq("id", s.customer.id)
    .select("id, tenant_id, uuid, email, telephone, firstname, birthday, is_activated, points, royalty_program_id, loyalty_card_number")
    .single();
  if (error || !data) throw new Error(`更新會員資料失敗：${error?.message}`);
  return json({ code: 200, error: "個人資料已更新", data: await customerLoginData(tenant.id, data as never) });
}

// ───────────── 常用地址（ep.widget.address.js；JSON body；成功判定 code===200） ─────────────
const MAX_ADDRESSES = 4;
const ADDR_BAD = /[<>"']/;

function addrBody(j: Record<string, unknown>) {
  const g = (k: string, max: number) => clean(j[k], max, k);
  const v = {
    firstname: g("firstname", 50),
    telephone: g("telephone", 30),
    country: (g("country", 2) || "TW").toUpperCase(),
    city: g("city", 50),
    district: g("district", 50),
    postcode: g("postcode", 10) === "NA" ? "" : g("postcode", 10),
    street: g("street", 200),
  };
  for (const [k, x] of Object.entries(v)) if (ADDR_BAD.test(x)) throw new HttpError(400, `${k} 含有不允許的字元`);
  if (!v.firstname || !v.telephone || !v.city || !v.street) throw new HttpError(400, "請填寫姓名、電話、城市與地址");
  if (!/^[A-Z]{2}$/.test(v.country)) throw new HttpError(400, "國家/地區格式錯誤");
  return v;
}

async function addressSession(ctx: RequestContext) {
  const { tenant } = await scopeFromTenantPath(ctx);
  const s = await readCustomerSession(ctx, tenant.id);
  return { tenant, s };
}

async function addressList(ctx: RequestContext): Promise<Response> {
  const { tenant, s } = await addressSession(ctx);
  if (!s) return json({ code: 403, error: "尚未登入" });
  const { data } = await getServiceClient()
    .from("customer_addresses")
    .select("uuid, firstname, telephone, country, city, district, postcode, street")
    .eq("tenant_id", tenant.id)
    .eq("customer_id", s.customer.id)
    .order("is_default", { ascending: false })
    .order("id");
  return json({ code: 200, data: data ?? [], maxAddresses: MAX_ADDRESSES });
}

async function addressCreate(ctx: RequestContext): Promise<Response> {
  const { tenant, s } = await addressSession(ctx);
  if (!s) return json({ code: 403, error: "尚未登入" }, { status: 403 });
  await rateLimit(`addr:${tenant.id}:${s.customer.id}`, 600, 30);
  const v = addrBody(((await ctx.body()).json ?? {}) as Record<string, unknown>);
  const db = getServiceClient();
  const { count } = await db.from("customer_addresses").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("customer_id", s.customer.id);
  if ((count ?? 0) >= MAX_ADDRESSES) return json({ code: 400, error: "已達到地址上限" });
  const { error } = await db.from("customer_addresses").insert({ ...v, tenant_id: tenant.id, customer_id: s.customer.id, is_default: (count ?? 0) === 0 });
  if (error) throw new Error(`新增地址失敗：${error.message}`);
  return json({ code: 200 });
}

async function addressUpdate(ctx: RequestContext): Promise<Response> {
  const { tenant, s } = await addressSession(ctx);
  if (!s) return json({ code: 403, error: "尚未登入" }, { status: 403 });
  await rateLimit(`addr:${tenant.id}:${s.customer.id}`, 600, 30);
  const uuid = clean(ctx.query.get("uuid"), 40, "uuid");
  const v = addrBody(((await ctx.body()).json ?? {}) as Record<string, unknown>);
  const { country: _country, ...rest } = v; // 編輯時不能改國家（同原站）
  void _country;
  const { data, error } = await getServiceClient()
    .from("customer_addresses")
    .update(rest)
    .eq("tenant_id", tenant.id)
    .eq("customer_id", s.customer.id)
    .eq("uuid", uuid)
    .select("id");
  if (error) throw new Error(`更新地址失敗：${error.message}`);
  if (!data || data.length === 0) return json({ code: 404, error: "找不到地址" });
  return json({ code: 200 });
}

async function addressDelete(ctx: RequestContext): Promise<Response> {
  const { tenant, s } = await addressSession(ctx);
  if (!s) return json({ code: 403, error: "尚未登入" }, { status: 403 });
  const uuid = clean(ctx.query.get("uuid"), 40, "uuid");
  const { data } = await getServiceClient()
    .from("customer_addresses")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("customer_id", s.customer.id)
    .eq("uuid", uuid)
    .select("id");
  if (!data || data.length === 0) return json({ code: 404, error: "找不到地址" });
  return json({ code: 200 });
}

// ───────────── 會員中心（推導） ─────────────
const STATE_BADGE: Record<string, string> = {
  PROCESSING: "badge-primary",
  NEW: "badge-info",
  COMPLETE: "badge-success",
  CANCELED: "badge-danger",
  HOLDED: "badge-warning",
};

async function memberCenter(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const customer = await readCustomerSession(ctx, tenant.id);
  let orders: Record<string, unknown>[] = [];
  if (customer) {
    const since = new Date(Date.now() - 366 * 86400_000).toISOString();
    const { data } = await getServiceClient()
      .from("sales_orders")
      .select("uuid, state, status, grand_total, created_at, group_buys(title, short_url, currency)")
      .eq("tenant_id", tenant.id)
      .eq("customer_id", customer.customer.id)
      .not("state", "in", "(DRAFT,DELETED)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    orders = await Promise.all(
      ((data ?? []) as Record<string, unknown>[]).map(async (o) => {
        const g = (o.group_buys ?? {}) as { title?: string; short_url?: string; currency?: string };
        return {
          uuid: o.uuid,
          url: `/${tenant.code}/p/${g.short_url || groupBuy?.short_url || "null"}/SalesOrder/show.do?uuid=${encodeURIComponent(String(o.uuid))}`,
          groupBuyTitle: g.title ?? "",
          date: taipeiDateTime(o.created_at),
          stateLabel: (await enumLabel("SalesOrder.state", String(o.state))) || String(o.state),
          statusLabel: (await enumLabel("SalesOrder.status", String(o.status))) || String(o.status),
          badgeClass: STATE_BADGE[String(o.state)] ?? "badge-secondary",
          totalText: formatPrice(Number(o.grand_total) || 0, g.currency || "TWD"),
        };
      }),
    );
  }
  return html(
    renderTemplate("storefront/member-center.html", {
      ...feVars(ctx, { tenant, groupBuy, customer }),
      orders,
      points: customer ? Number(customer.customer.points) || 0 : 0,
    }),
  );
}

export const customerExtraRoutes: RouteDef[] = [
  get("/p/:shortUrl/Customer/logout", logoutPage, { auth: "public" }),
  any("/p/:shortUrl/ajax/web/Customer/logout", logoutAjax, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/Customer/isLogin", isLogin, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/ShoppingCart/getUserMenu", getUserMenu, { auth: "public" }),
  any("/p/:shortUrl/ajax/web/Customer/changePassword", changePassword, { auth: "public" }),
  any("/p/:shortUrl/ajax/web/Customer/editProfile", editProfile, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/CustomerAddress/list", addressList, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/CustomerAddress/create", addressCreate, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/CustomerAddress/update", addressUpdate, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/CustomerAddress/delete", addressDelete, { auth: "public" }),
  get("/p/:shortUrl/Customer/show", memberCenter, { auth: "public" }),
];
