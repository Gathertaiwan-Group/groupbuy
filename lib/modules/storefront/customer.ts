// 前台會員路由：登入/註冊彈窗（fe-customer-login-modal）與會員 API。
import { any, post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { feVars, scopeFromTenantPath } from "./site";
import { activate, forgotPassword, login, sendActivateEmail, signup } from "./customer-auth";

/** 只接受站內相對路徑當 redirect（避免開放轉址） */
export function safeRedirect(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  if (!s || s.length > 300) return "";
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\")) return "";
  return s;
}

async function showLoginForm(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  return html(
    renderTemplate("storefront/customer-login-modal.html", {
      ...feVars(ctx, { tenant, groupBuy }),
      redirect: safeRedirect(ctx.query.get("redirect")),
    }),
  );
}

export const customerRoutes: RouteDef[] = [
  any("/p/:shortUrl/ajax/web/Customer/showLoginForm", showLoginForm, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/Customer/login", login, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/Customer/signup", signup, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/Customer/processForgotPassword", forgotPassword, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/Customer/activate", activate, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/Customer/sendActivateEmail", sendActivateEmail, { auth: "public" }),
];
