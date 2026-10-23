// 單一入口：app/[[...path]]/route.ts 的所有請求都進這裡。
// 1) 正規化路徑（.do、;jsessionid、/backend/ajax）→ 2) 路由比對（含 /{租戶}/ 前綴）→
// 3) 認證（後台 session）與權限 → 4) 呼叫 handler → 5) 統一錯誤格式。
import { Router, normalizePath } from "./router";
import type { AdminSession, AuthMode, HttpMethod, RegisteredRoute, RequestContext } from "./types";
import { parseBody, type ParsedBody } from "./body";
import { FieldErrors, HttpError } from "./errors";
import { errorToJson, html, json, jsonError } from "./responses";
import { readSession } from "@/lib/core/auth/session";
import { allRoutes } from "@/lib/modules";
import { renderLoginPage } from "@/lib/modules/core/auth-pages";
import { renderBackendPage, renderNoPermission } from "@/lib/core/render/layout";

let router: Router | null = null;
export function getRouter(): Router {
  if (!router) router = new Router(allRoutes());
  return router;
}

export function defaultAuth(path: string): AuthMode {
  if (path === "/backend" || path.startsWith("/backend/")) return "admin";
  if (path.startsWith("/ajax/web/")) return "public";
  if (path.startsWith("/ajax/")) return "admin";
  return "public";
}

function isAjaxRequest(req: Request, path: string): boolean {
  if (path.startsWith("/ajax/")) return true;
  if ((req.headers.get("x-requested-with") || "").toLowerCase() === "xmlhttprequest") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

/** 瀏覽器標示為「其他網站發起」的請求（Sec-Fetch-Site: cross-site；舊瀏覽器沒有此標頭 → 不判定） */
function isCrossSite(req: Request): boolean {
  return (req.headers.get("sec-fetch-site") || "").toLowerCase() === "cross-site";
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function hasPermission(session: AdminSession, key: string): boolean {
  const v = session.permissions?.[key];
  return v === true || v === 1 || v === "1" || v === "true";
}

function buildContext(req: Request, url: URL, path: string, rawPath: string): RequestContext {
  let bodyPromise: Promise<ParsedBody> | null = null;
  const body = () => {
    if (!bodyPromise) bodyPromise = parseBody(req);
    return bodyPromise;
  };
  const ctx: RequestContext = {
    req,
    method: req.method.toUpperCase() as HttpMethod,
    url,
    path,
    rawPath,
    params: {},
    query: url.searchParams,
    tenantPrefix: null,
    session: null,
    isAjax: isAjaxRequest(req, path),
    body,
    async param(name: string) {
      const q = url.searchParams.get(name);
      if (q !== null) return q;
      const b = await body();
      const v = b.flat.get(name);
      return v && v.length > 0 ? v[0] : undefined;
    },
    async params_all(name: string) {
      const out = url.searchParams.getAll(name);
      const b = await body();
      const v = b.flat.get(name);
      if (v) out.push(...v);
      return out;
    },
    cookies: { set: [] },
  };
  return ctx;
}

function withCookies(res: Response, ctx: RequestContext): Response {
  if (ctx.cookies.set.length === 0) return res;
  const headers = new Headers(res.headers);
  for (const c of ctx.cookies.set) headers.append("set-cookie", c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function notFoundResponse(ctx: RequestContext): Response {
  if (ctx.isAjax) return jsonError(404, "找不到頁面");
  if (ctx.session && (ctx.path === "/backend" || ctx.path.startsWith("/backend/"))) {
    return renderBackendPage(ctx, {
      title: "???errors???",
      jsp: "/backend/error.jsp",
      body: '<div class="container-fluid ">\n</div>\n',
      messageHtml:
        '<div class="alert alert-warning">\n\t\t<button type="button" class="close" data-dismiss="alert">×</button>\n\t\t找不到頁面</div>\n',
      status: 404,
    });
  }
  return html(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head><body><h1>404</h1><p>找不到頁面</p></body></html>',
    { status: 404 },
  );
}

async function runHandler(route: RegisteredRoute, ctx: RequestContext): Promise<Response> {
  try {
    return await route.handler(ctx);
  } catch (e) {
    if (e instanceof FieldErrors) {
      // DataTables Editor 協定：200 + fieldErrors，前端在欄位下方顯示
      return json({ fieldErrors: e.fieldErrors, data: [] });
    }
    if (e instanceof HttpError) {
      if (ctx.isAjax || ctx.method !== "GET") return errorToJson(e);
      if (e.status === 403) return renderNoPermission(ctx, e.message);
      if (e.status === 401) return renderLoginPage(ctx);
      if (ctx.session) {
        return renderBackendPage(ctx, {
          title: "???errors???",
          jsp: "/backend/error.jsp",
          body: '<div class="container-fluid ">\n</div>\n',
          messageHtml: `<div class="alert alert-warning">\n\t\t<button type="button" class="close" data-dismiss="alert">×</button>\n\t\t${e.message.replace(/</g, "&lt;")}</div>\n`,
          status: e.status,
        });
      }
      return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${e.message.replace(/</g, "&lt;")}</body></html>`, {
        status: e.status,
      });
    }
    console.error(`[dispatch] ${ctx.method} ${ctx.rawPath} 例外`, e);
    if (ctx.isAjax || ctx.method !== "GET") return jsonError(500, "系統發生錯誤，請稍後再試");
    return html(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>500</title></head><body><h1>500</h1><p>系統發生錯誤，請稍後再試</p></body></html>',
      { status: 500 },
    );
  }
}

export async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawPath = safeDecode(url.pathname);
  const path = normalizePath(url.pathname);
  const method = req.method.toUpperCase() as HttpMethod;
  const ctx = buildContext(req, url, path, rawPath);

  const outcome = getRouter().match(path, method === "HEAD" ? "GET" : method);

  if (outcome.kind === "method-not-allowed") {
    return jsonError(405, "Method Not Allowed", { allowed: outcome.allowed });
  }

  if (outcome.kind === "not-found") {
    // 未登入時 /backend/* 一律顯示登入頁（與原站相同）
    if (path === "/backend" || path.startsWith("/backend/")) {
      ctx.session = await readSession(req);
      if (!ctx.session) return renderLoginPage(ctx);
    }
    return notFoundResponse(ctx);
  }

  const { route, params, tenantPrefix, matchedPath } = outcome.result;
  ctx.params = params;
  ctx.tenantPrefix = tenantPrefix;
  ctx.path = matchedPath;
  ctx.isAjax = isAjaxRequest(req, matchedPath);

  const auth = route.auth ?? defaultAuth(route.path);
  if (auth === "admin" || auth === "optional") {
    ctx.session = await readSession(req);
  }
  if (auth === "admin") {
    if (!ctx.session) {
      if (ctx.isAjax || method !== "GET") return jsonError(401, "系統偵測到已登出，請重新登入");
      return renderLoginPage(ctx);
    }
    // 跨站請求防護（CSRF）：後台 AJAX 與寫入請求不接受其他網站發起的。
    // SameSite=Lax 已讓跨站 POST 不帶 cookie，但跨站「頂層 GET 導覽」仍會帶 → 以 GET 做事的 AJAX 端點也擋。
    // 後台頁面本身（GET、非 AJAX）仍可從外部連結（Email、書籤）開啟。
    if (isCrossSite(req) && (ctx.isAjax || method !== "GET")) return jsonError(403, "不接受跨站請求");
    // 網址帶的租戶前綴必須與登入者相同（資料一律以 session.tenantId 為準）
    if (tenantPrefix && tenantPrefix !== ctx.session.tenantCode && tenantPrefix !== "demo") {
      return ctx.isAjax ? jsonError(403, "無權限") : renderNoPermission(ctx);
    }
    if (route.permission && !hasPermission(ctx.session, route.permission)) {
      return ctx.isAjax || method !== "GET" ? jsonError(403, "無權限") : renderNoPermission(ctx);
    }
  }

  let res = await runHandler(route, ctx);
  res = withCookies(res, ctx);
  if (method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}
