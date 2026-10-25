// Footer 編輯器 — gapfill 子任務 B。
//   V2：/backend/WebEditor/footerV2?groupBuyId=&homeViewId=（HomeView 列表 FOOTER 列的「預覽&編輯」）
//       原站 GAP_SPEC §1.6：頁面專屬 script＝/scripts/gbf_editor.js、web.editor.{cols,deps,template,options,fields}.js、web.editor.js；
//       body 只有 div#footer-editor；定義 initEditor 的 inline script 被擋 → 推導（templates/groupbuy/webeditor-footerv2.html）。
//   V1：/backend/WebEditor/footer?groupBuyId=（團購卡片連結已註解，頁面仍存在；GAP_SPEC §1.7）＋ /scripts/footerEditor.js。
//
// 端點：
//   GET  /backend/WebEditor/footerV2?groupBuyId=&homeViewId=     頁面（只接受 FOOTER_* 類別；團購/頁面須屬於本租戶，否則 404）
//   POST /ajax/HomeViewCache/save   groupBuyId, homeViewId, config(JSON), html
//        推導：編輯器「儲存」— WebEditor 設定（globalCfg/rows/cols）存在該 FOOTER 的 WEB_EDITOR 區塊
//        （home_view_sections.settings），$().getHtml() 產生的 HTML 存在同一區塊的 html；
//        「更新暫存」（既有 /ajax/HomeViewCache/refresh）把它組成 home_views.html，前台頁尾即讀它。
//   GET  /backend/WebEditor/footer?groupBuyId=                    V1 頁面
//   GET  /ajax/WebEditor/list?groupBuyId=                         V1 讀取（footerEditor.js reload() 的鍵）
//   POST /ajax/WebEditor/update                                   V1 儲存（表單原生送出 → 303 回頁面；AJAX → JSON）
//        推導：存在 group_buys.group_buy_settings.footerView（上傳欄位名 groupBuySettings.footerView.logo、標籤
//        ???GroupBuySettings.footerView.*??? 皆指向團購設定）。不改 descr_footer（「Footer敘述」另有用途）。
//   WebEditor「選單」欄位用的 /ajax/WebMenu/listMenu、listMenuNode 由子任務 A（web-content-menu.ts）提供。
import { getServiceClient } from "@/lib/supabase/server";
import type { Row } from "@/lib/db/mapping";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json, redirect } from "@/lib/core/http/responses";
import { homeViewGroupBuyOf, homeViewOf } from "./homeview-section";

const db = () => getServiceClient();
const FOOTER_CATEGORIES = ["FOOTER_RELEASE", "FOOTER_DRAFT", "FOOTER_CUSTOM"];
const MAX_CONFIG = 1_000_000;
const MAX_HTML = 1_000_000;

function str(v: unknown): string {
  if (Array.isArray(v)) v = v[0];
  return v == null ? "" : String(v);
}

/* ─────────────────────────── V2（WebEditor） ─────────────────────────── */

async function footerViewOf(ctx: RequestContext) {
  const session = requireSession(ctx);
  const gb = await homeViewGroupBuyOf(ctx);
  const view = await homeViewOf(session.tenantId, gb, await ctx.param("homeViewId"));
  if (!FOOTER_CATEGORIES.includes(view.category)) throw notFound("找不到 FOOTER");
  return { session, gb, view };
}

async function webEditorSection(tenantId: number, homeViewId: number): Promise<{ id: number; settings: Row | null } | null> {
  const { data, error } = await db()
    .from("home_view_sections")
    .select("id, settings")
    .eq("tenant_id", tenantId)
    .eq("home_view_id", homeViewId)
    .eq("category", "WEB_EDITOR")
    .order("seq")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[web-editor] 讀取 Footer 設定失敗：${error.message}`);
  return (data as { id: number; settings: Row | null } | null) ?? null;
}

function editorConfig(sectionId: number, settings: Row | null | undefined): Row {
  const s = (settings ?? {}) as Row;
  const globalCfg = s.globalCfg && typeof s.globalCfg === "object" ? s.globalCfg : { bgColor: "" };
  return {
    homeViewCacheId: sectionId,
    globalCfg,
    rows: Array.isArray(s.rows) ? s.rows : null,
    cols: s.cols && typeof s.cols === "object" ? s.cols : null,
  };
}

/** POST /ajax/HomeViewCache/save（推導） */
async function saveFooterV2(ctx: RequestContext): Promise<Response> {
  const { session, view } = await footerViewOf(ctx);
  const rawCfg = str(await ctx.param("config"));
  const html = str(await ctx.param("html"));
  if (!rawCfg) throw badRequest("缺少編輯器設定");
  if (rawCfg.length > MAX_CONFIG || html.length > MAX_HTML) throw badRequest("內容過大，請減少內容後再儲存");
  let cfg: Row;
  try {
    cfg = JSON.parse(rawCfg) as Row;
  } catch {
    throw badRequest("編輯器設定格式錯誤");
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw badRequest("編輯器設定格式錯誤");
  if (cfg.rows != null && !Array.isArray(cfg.rows)) throw badRequest("編輯器設定格式錯誤");
  if (cfg.cols != null && (typeof cfg.cols !== "object" || Array.isArray(cfg.cols))) throw badRequest("編輯器設定格式錯誤");
  const settings: Row = {
    globalCfg: cfg.globalCfg && typeof cfg.globalCfg === "object" ? cfg.globalCfg : { bgColor: "" },
    rows: cfg.rows ?? [],
    cols: cfg.cols ?? {},
  };
  const existing = await webEditorSection(session.tenantId, view.id);
  let id: number;
  if (existing) {
    const { error } = await db()
      .from("home_view_sections")
      .update({ settings, html })
      .eq("tenant_id", session.tenantId)
      .eq("id", existing.id);
    if (error) throw new Error(`[web-editor] 儲存 Footer 失敗：${error.message}`);
    id = existing.id;
  } else {
    const { data, error } = await db()
      .from("home_view_sections")
      .insert({ tenant_id: session.tenantId, home_view_id: view.id, title: "Footer", category: "WEB_EDITOR", seq: 1, settings, html })
      .select("id")
      .single();
    if (error || !data) throw new Error(`[web-editor] 儲存 Footer 失敗：${error?.message}`);
    id = (data as { id: number }).id;
  }
  return actionOk("儲存成功", { data: { homeViewCacheId: id, homeViewId: view.id } });
}

/* ─────────────────────────── V1（footerEditor.js） ─────────────────────────── */

const V1_KEYS = ["footerInfo", "footerMenu", "footerTextColor", "footerBGColor", "footerSysBGColor", "facebookId", "instagramId", "lineId", "footerLogo", "footerLogoURL", "copyright"];

async function groupBuySettings(ctx: RequestContext): Promise<{ tenantId: number; gbId: number; settings: Row }> {
  const session = requireSession(ctx);
  const gb = await homeViewGroupBuyOf(ctx);
  const { data, error } = await db().from("group_buys").select("group_buy_settings").eq("tenant_id", session.tenantId).eq("id", gb.id).maybeSingle();
  if (error) throw new Error(`[web-editor] 讀取團購設定失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return { tenantId: session.tenantId, gbId: gb.id, settings: ((data as { group_buy_settings: Row | null }).group_buy_settings ?? {}) as Row };
}

function footerView(settings: Row): Row {
  const fv = (settings.footerView ?? {}) as Row;
  const out: Row = {};
  for (const k of V1_KEYS) out[k] = str(fv[k]);
  return out;
}

/** GET /ajax/WebEditor/list?groupBuyId= */
async function listV1(ctx: RequestContext): Promise<Response> {
  const { gbId, settings } = await groupBuySettings(ctx);
  return json({ ...footerView(settings), groupBuyId: gbId });
}

const COLOR_RE = /^[a-z0-9 -]{0,60}$/i;

/** POST /ajax/WebEditor/update */
async function updateV1(ctx: RequestContext): Promise<Response> {
  const { tenantId, gbId, settings } = await groupBuySettings(ctx);
  const p = async (k: string) => str(await ctx.param(k)).trim();
  const fv: Row = {};
  fv.footerInfo = str(await ctx.param("footerInfo")).replace(/\r\n/g, "\n").slice(0, 5000);
  for (const k of ["footerTextColor", "footerBGColor", "footerSysBGColor"]) {
    const v = await p(k);
    if (!COLOR_RE.test(v)) throw badRequest("顏色格式錯誤");
    fv[k] = v;
  }
  // 選單 1–6：「標題#連結」一行一個（footerEditor.js reload() 以 \n 與 # 拆）；標題/連結需成對（同前端驗證）
  const lines: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const title = (await p(`webFooterItem${i}Title`)).replace(/[#\n]/g, " ");
    const link = (await p(`webFooterItem${i}Link`)).replace(/\n/g, "");
    if (!title && !link) {
      lines.push("");
      continue;
    }
    if (!title || !link) throw badRequest(`選單${i}的名稱與連結需同時填寫`);
    if (/^\s*javascript:/i.test(link)) throw badRequest(`選單${i}的連結格式錯誤`);
    lines.push(`${title}#${link}`);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  fv.footerMenu = lines.join("\n");
  for (const k of ["facebookId", "instagramId", "lineId", "copyright"]) fv[k] = (await p(k)).slice(0, 300);
  const logoUrl = await p("footerLogoURL");
  const logo = await p("footerLogo");
  for (const v of [logoUrl, logo]) if (/^\s*javascript:/i.test(v) || v.length > 1000) throw badRequest("Logo 網址格式錯誤");
  fv.footerLogoURL = logoUrl;
  fv.footerLogo = logo;
  const { error } = await db()
    .from("group_buys")
    .update({ group_buy_settings: { ...settings, footerView: fv } })
    .eq("tenant_id", tenantId)
    .eq("id", gbId);
  if (error) throw new Error(`[web-editor] 儲存 Footer 失敗：${error.message}`);
  // 原生表單送出（無 X-Requested-With、接受 HTML）→ 回到編輯頁；AJAX → JSON（/ajax/* 路徑的 ctx.isAjax 一律為 true，不能用它判斷）
  const xrw = (ctx.req.headers.get("x-requested-with") || "").toLowerCase() === "xmlhttprequest";
  const wantsHtml = (ctx.req.headers.get("accept") || "").includes("text/html");
  if (!xrw && wantsHtml) return redirect(`/backend/WebEditor/footer?groupBuyId=${gbId}&updated=1`, 303);
  return actionOk("更新成功", { data: { ...fv, groupBuyId: gbId } });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const webEditorRoutes: RouteDef[] = [
  page("/backend/WebEditor/footerV2", {
    template: "groupbuy/webeditor-footerv2.html",
    title: "Footer Editor",
    // 推導：頁面只有 div#footer-editor（WebEditor 佔滿主區）；不顯示單一團購選單，但團購／頁面需屬於本租戶
    groupBuy: "none",
    activeHref: "/backend/GroupBuy/list",
    async data(ctx) {
      const { session, gb, view } = await footerViewOf(ctx);
      const sec = await webEditorSection(session.tenantId, view.id);
      return { groupBuyId: gb.id, homeViewId: view.id, homeViewTitle: view.title, editorCfg: editorConfig(sec?.id ?? 0, sec?.settings) };
    },
  }),
  post("/ajax/HomeViewCache/save", saveFooterV2),
  page("/backend/WebEditor/footer", {
    template: "groupbuy/webeditor-footer.html",
    title: "Footer Editor",
    groupBuy: "required",
    data: (ctx) => ({ updated: ctx.query.get("updated") === "1" }),
  }),
  get("/ajax/WebEditor/list", listV1),
  post("/ajax/WebEditor/update", updateV1),
];
