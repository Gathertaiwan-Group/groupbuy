// 前台靜態頁：隱私權政策（fe-privacy）、服務條款（fe-terms）、賣家頁 404（fe-seller-page）。
import { get } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { feVars, tenantByCode, PLATFORM_TENANT_CODE, type SfTenant } from "./site";
import { readCustomerSession } from "./customer-session";

async function tenantPage(ctx: RequestContext, template: string): Promise<Response> {
  const tenant: SfTenant | null = (await tenantByCode(ctx.tenantPrefix)) ?? (await tenantByCode(PLATFORM_TENANT_CODE));
  const customer = tenant ? await readCustomerSession(ctx, tenant.id) : null;
  return html(renderTemplate(template, feVars(ctx, { tenant, groupBuy: null, customer })));
}

/** 原站 commons/404.jsp（標題 ???Seller???）：/{租戶}/p/{shortUrl} 與不存在的短網址 */
export function sellerNotFound(ctx: RequestContext): Response {
  return html(renderTemplate("storefront/seller-404.html", feVars(ctx, { tenant: null, groupBuy: null, themeSource: "platform" })), {
    status: 404,
  });
}

export const staticPageRoutes: RouteDef[] = [
  get("/GroupBuy/privacy", (ctx) => tenantPage(ctx, "storefront/privacy.html"), { auth: "public" }),
  get("/GroupBuy/terms", (ctx) => tenantPage(ctx, "storefront/terms.html"), { auth: "public" }),
  // 原站 /guest_ep/p/ak98i 匿名存取回 404 賣家頁
  get("/p/:shortUrl", async (ctx) => sellerNotFound(ctx), { auth: "public" }),
];
