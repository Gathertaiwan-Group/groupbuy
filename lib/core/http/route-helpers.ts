// 模組登錄路由用的小工具。用法見 docs/MODULE_GUIDE.md。
import type { AdminSession, AuthMode, HttpMethod, RequestContext, RouteDef, RouteHandler } from "./types";
import { badRequest, notFound, unauthorized } from "./errors";
import { renderModulePage, type GroupBuyMenuInfo } from "@/lib/core/render/layout";
import { renderTemplate } from "@/lib/core/render/template";
import { commonVars } from "@/lib/core/render/vars";
import { loadGroupBuyMenu } from "@/lib/core/groupbuy-menu";
import { html } from "./responses";

type RouteOpts = Omit<RouteDef, "path" | "handler" | "method">;

export const get = (path: string, handler: RouteHandler, opts: RouteOpts = {}): RouteDef => ({
  ...opts,
  path,
  method: "GET",
  handler,
});
export const post = (path: string, handler: RouteHandler, opts: RouteOpts = {}): RouteDef => ({
  ...opts,
  path,
  method: "POST",
  handler,
});
/** GET 與 POST 都接受（原站多數 .do 端點兩者皆可） */
export const any = (path: string, handler: RouteHandler, opts: RouteOpts = {}): RouteDef => ({
  ...opts,
  path,
  method: "ANY",
  handler,
});
export const route = (method: HttpMethod | HttpMethod[] | "ANY", path: string, handler: RouteHandler, opts: RouteOpts = {}): RouteDef => ({
  ...opts,
  path,
  method,
  handler,
});

/** 取得登入者（auth='admin' 的路由一定有；保險起見沒有就丟 401） */
export function requireSession(ctx: RequestContext): AdminSession {
  if (!ctx.session) throw unauthorized();
  return ctx.session;
}

/** 讀整數參數（query 優先，再 body）；required 時缺少/格式錯丟 400 */
export async function intParam(ctx: RequestContext, name: string, required: true): Promise<number>;
export async function intParam(ctx: RequestContext, name: string, required?: false): Promise<number | null>;
export async function intParam(ctx: RequestContext, name: string, required = false): Promise<number | null> {
  const v = await ctx.param(name);
  if (v === undefined || v === null || v === "" || v === "null" || v === "undefined") {
    if (required) throw badRequest(`缺少參數 ${name}`);
    return null;
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    if (required) throw badRequest(`參數 ${name} 格式錯誤`);
    return null;
  }
  return n;
}

export async function strParam(ctx: RequestContext, name: string): Promise<string | undefined> {
  return ctx.param(name);
}

export interface PageContext extends RequestContext {
  session: AdminSession;
  /** 網址帶 groupBuyId 且屬於本租戶時的團購基本資料 */
  groupBuy: GroupBuyMenuInfo | null;
}

export interface PageDef {
  /** templates/ 底下的模板路徑，例 'groupbuy/groupbuytag-list.html' */
  template: string;
  /** <title> */
  title: string | ((ctx: PageContext, data: Record<string, unknown>) => string);
  /** 原站 <base href> JSP 路徑（預設 `${path}.jsp`） */
  jsp?: string;
  /** 是否顯示左側選單（預設 true） */
  sidebar?: boolean;
  /**
   * 單一團購選單：
   * - 'auto'（預設）：網址有 groupBuyId 就載入並顯示團購選單
   * - 'required'：必須有 groupBuyId 且屬於本租戶，否則 404
   * - 'none'：不顯示
   */
  groupBuy?: "auto" | "required" | "none";
  /** 權限旗標（無權限顯示原站「無權限」頁） */
  permission?: string;
  auth?: AuthMode;
  /** 模板資料（可 async）；回傳物件會與共用變數合併 */
  data?: (ctx: PageContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** 指定側欄展開哪個連結（預設：與目前網址相同的連結） */
  activeHref?: string | ((ctx: PageContext) => string | null);
}

/**
 * 後台頁面路由（GET）：模板 + 版面殼 + 自動處理 groupBuyId 團購選單。
 *   page('/backend/GroupBuyTag/list', { template: 'groupbuy/groupbuytag-list.html', title: '團購標籤' })
 */
export function page(path: string, def: PageDef): RouteDef {
  return {
    path,
    method: "GET",
    auth: def.auth ?? "admin",
    permission: def.permission,
    handler: async (ctx) => {
      const session = requireSession(ctx);
      let groupBuy: GroupBuyMenuInfo | null = null;
      const mode = def.groupBuy ?? "auto";
      if (mode !== "none") {
        const raw = ctx.query.get("groupBuyId");
        const id = raw ? Number(raw) : NaN;
        if (Number.isSafeInteger(id) && id > 0) groupBuy = await loadGroupBuyMenu(session, id);
        if (mode === "required" && !groupBuy) throw notFound("找不到團購");
      }
      const pctx = Object.assign(ctx, { session, groupBuy }) as PageContext;
      const data = def.data ? await def.data(pctx) : {};
      const title = typeof def.title === "function" ? def.title(pctx, data) : def.title;
      const activeHref = typeof def.activeHref === "function" ? def.activeHref(pctx) : def.activeHref;
      return renderModulePage(ctx, def.template, { groupBuyId: groupBuy?.groupBuyId ?? null, ...data }, {
        title,
        jsp: def.jsp,
        sidebar: def.sidebar,
        groupBuy,
        activeHref: activeHref ?? null,
      });
    },
  };
}

/**
 * HTML 片段路由（openForm/openFormL/openFormF/loadAjax 載入到 #myModalContent 的彈窗內容）。
 * 不套版面殼，直接回傳渲染後的模板。
 */
export function fragment(
  path: string,
  def: {
    template: string;
    permission?: string;
    auth?: AuthMode;
    method?: HttpMethod | HttpMethod[] | "ANY";
    data?: (ctx: RequestContext & { session: AdminSession }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  },
): RouteDef {
  return {
    path,
    method: def.method ?? "ANY",
    auth: def.auth ?? "admin",
    permission: def.permission,
    handler: async (ctx) => {
      const session = requireSession(ctx);
      const data = def.data ? await def.data(Object.assign(ctx, { session })) : {};
      return html(renderTemplate(def.template, { ...commonVars(ctx), ...data }));
    },
  };
}
