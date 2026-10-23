// 後台版面殼：把模組的頁面模板套進原站共用的 <head>、頂列、側欄（#slide-out）、頁尾、#myModal。
// 結構與原站 spec/html 一致（見 templates/core/layout/*.html）。
import type { RequestContext } from "@/lib/core/http/types";
import { html } from "@/lib/core/http/responses";
import { renderTemplate } from "./template";
import { commonVars } from "./vars";

export interface GroupBuyMenuInfo {
  groupBuyId: number;
  title: string;
  shortUrl: string;
  /** 銷售報表 /rp/{reportToken} */
  reportToken: string;
}

export interface BackendPageOptions {
  /** <title>（原站＝頁面名稱，如「團購標籤」；首頁「團購表單」） */
  title: string;
  /** 原站 <base href> 的 JSP 路徑；預設由網址推導（/backend/X/y → /backend/X/y.jsp） */
  jsp?: string;
  /** </head> 前的頁面專屬 HTML（原站頁面的 <style>、inline <script> 都在 head 末端） */
  head?: string;
  /** <main> 內、側欄之後的主內容（原站多為 <div class="container-fluid ">…</div>） */
  body: string;
  /** </body> 前、共用 script 之後的 HTML（頁面底部 script） */
  foot?: string;
  /** 是否顯示左側選單（首頁 panel 與登入頁為 false） */
  sidebar?: boolean;
  /** 單一團購選單（帶 groupBuyId 的頁面） */
  groupBuy?: GroupBuyMenuInfo | null;
  /** 指定側欄要展開哪個連結所在群組（預設：與目前網址相同的連結） */
  activeHref?: string | null;
  /** 放進 <div id="message"> 的 HTML（例：無權限 alert） */
  messageHtml?: string;
  /** HTTP 狀態碼（預設 200） */
  status?: number;
}

/** 由網址推導原站 <base href> 的 JSP 路徑 */
export function defaultJsp(ctx: RequestContext): string {
  const p = ctx.path.replace(/\/+$/, "");
  return `${p || "/backend/panel"}.jsp`;
}

export function renderBackendHtml(ctx: RequestContext, opts: BackendPageOptions): string {
  const vars = commonVars(ctx);
  return renderTemplate("core/layout/backend-page.html", {
    ...vars,
    title: opts.title,
    jsp: opts.jsp ?? defaultJsp(ctx),
    pageHead: opts.head ?? "",
    pageBody: opts.body,
    pageFoot: opts.foot ?? "",
    sidebar: opts.sidebar !== false && vars.loggedIn,
    groupBuy: opts.groupBuy ?? null,
    activeHref: opts.activeHref ?? null,
    messageHtml: opts.messageHtml ?? "",
  });
}

export function renderBackendPage(ctx: RequestContext, opts: BackendPageOptions): Response {
  return html(renderBackendHtml(ctx, opts), { status: opts.status ?? 200 });
}

/**
 * 模板分段：一個頁面模板檔可用註解標記分成 head / body / foot 三段：
 *   <!--#head-->  …原站 <title> 之後、</head> 之前的 <style>/<script>…
 *   <!--#body-->  …原站側欄之後、</main> 之前的內容…
 *   <!--#foot-->  …（選用）放在 </body> 前…
 * 沒有標記時整份視為 body。
 */
export function splitSections(rendered: string): { head: string; body: string; foot: string } {
  const re = /<!--#(head|body|foot)-->/g;
  const marks: { name: "head" | "body" | "foot"; index: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) {
    marks.push({ name: m[1] as "head" | "body" | "foot", index: m.index, end: re.lastIndex });
  }
  if (marks.length === 0) return { head: "", body: rendered, foot: "" };
  const out = { head: "", body: "", foot: "" };
  for (let i = 0; i < marks.length; i++) {
    const next = i + 1 < marks.length ? marks[i + 1].index : rendered.length;
    out[marks[i].name] += rendered.slice(marks[i].end, next);
  }
  return out;
}

/** 渲染模組頁面模板（含分段）並套上版面殼 */
export function renderModulePage(
  ctx: RequestContext,
  templateRel: string,
  data: Record<string, unknown>,
  opts: Omit<BackendPageOptions, "head" | "body" | "foot">,
): Response {
  const vars = commonVars(ctx);
  const rendered = renderTemplate(templateRel, { ...vars, groupBuy: opts.groupBuy ?? null, ...data });
  const s = splitSections(rendered);
  return renderBackendPage(ctx, { ...opts, head: s.head, body: s.body, foot: s.foot });
}

/** 原站 error.jsp：黃色 alert「無權限」（有側欄、title ???errors???） */
export function renderNoPermission(ctx: RequestContext, message = "無權限"): Response {
  const esc = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return renderBackendPage(ctx, {
    title: "???errors???",
    jsp: "/backend/error.jsp",
    body: '<div class="container-fluid ">\n</div>\n',
    messageHtml: `<div class="alert alert-warning">\n\t\t<button type="button" class="close" data-dismiss="alert">×</button>\n\t\t${esc}</div>\n`,
  });
}
