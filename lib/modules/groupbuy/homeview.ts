// 官網（HomeView 頁面/Footer 管理）＋官網暫存端點 — 由 groupbuy 模組的子任務實作。
// 原站：spec/html/homeview-list.html、spec/runtime/homeview-list.records.txt、SPEC.md「官網（HomeView 頁面/Footer 管理）」；
// 頁面腳本缺段已依原站頁面原始碼（唯讀擷取）補齊。原站查不到的行為以「推導：」註記。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/HomeView/list?groupBuyId=                           頁面（團購須屬於本租戶，否則 404）
//   POST /ajax/HomeView/list?groupBuyId=                              列表（serverSide）
//   POST /ajax/HomeView/save?groupBuyId=                              Editor create
//   POST /ajax/HomeView/update?groupBuyId=&homeViewId=1,2             Editor edit（含行內編輯）
//   POST /ajax/HomeView/delete?groupBuyId=&homeViewId=1,2             Editor remove
//   POST /ajax/HomeView/updateSEO?groupBuyId=&homeViewId=             列展開「SEO」的 Editor（只接受 edit）
//   POST /ajax/HomeView/clone?groupBuyId=        body homeViewId      工具列「複製」
//   ANY  /ajax/HomeView/cloneFromV1?groupBuyId=                        #cloneHomeViewV1：由舊版首頁建立（推導）
//   ANY  /ajax/HomeViewCache/cloneFooterV1?groupBuyId=                 #cloneFooterV1：由舊版 Footer（團購「Footer敘述」）建立（推導）
//   ANY  /ajax/HomeViewCache/refresh?groupBuyId=&homeViewId=           更新暫存：產生 HTML 存入 home_views.html / date_cached
//   ANY  /ajax/HomeViewCache/refreshCustomWeb?groupBuyId=&homeViewId=  同上（原站「更新網頁」按鈕已註解，函式仍在）
//   ANY  /ajax/HomeViewCache/queryReleaseFooter?groupBuyId=            團購列表「更新Footer暫存」第一步：回 FOOTER 預設的 homeViewId
//   POST /ajax/GroupBuy/refreshHome              body groupBuyId        團購列表「更新首頁暫存」（gbs_api 的 GBAPI.refreshHome）
//   GET  /ajax/Lookup/homeViewFooter?groupBuyId=                        select2「頁尾設定」
//   GET  /ajax/Lookup/homeViewWebMenu?groupBuyId=                       select2「上方選單／側面選單」
//
// 暫存（推導）：網頁頁面（DRAFT/RELEASE/CUSTOM）＝ <div class="home-view">＋快訊＋搜尋關鍵字＋各內容區塊；
// FOOTER（FOOTER_*）＝ <footer class="page-footer font-small pt-4">…</footer>（同原站 updateDummyEditor 的外框，去掉換行與 tab）。
// 前台依 homeViewConfig.footerId 組合頁尾：-1＝本團購 FOOTER_RELEASE、-2＝不顯示、其他＝該 FOOTER 的 html。
import { getServiceClient } from "@/lib/supabase/server";
import { homeView } from "@/lib/db/entities";
import type { Row } from "@/lib/db/mapping";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { requestOrigin } from "@/lib/core/render/vars";

const PAGE_CATEGORIES = ["DRAFT", "RELEASE", "CUSTOM"];
const FOOTER_CATEGORIES = ["FOOTER_RELEASE", "FOOTER_DRAFT", "FOOTER_CUSTOM"];
const ALL_CATEGORIES = [...PAGE_CATEGORIES, ...FOOTER_CATEGORIES];
/**
 * 推導：「網頁 首頁（唯一）」「FOOTER 預設（唯一）」每個團購只能一筆。原站行為查不到（不能在原站寫入），
 * 採「新存成唯一的那筆生效，原本那筆改成草稿」。複製時也把唯一類別改成對應的草稿。
 */
const UNIQUE_DEMOTE: Record<string, string> = { RELEASE: "DRAFT", FOOTER_RELEASE: "FOOTER_DRAFT" };

const CONFIG_ENUMS: Record<string, string> = {
  "homeViewConfig.navStyle": "HomeView.navStyle",
  "homeViewConfig.navMenuStyle": "HomeView.navMenuStyle",
  "homeViewConfig.customStyle": "HomeView.customStyle",
  "homeViewConfig.colorTheme": "HomeView.colorTheme",
};
const REF_KEYS = ["footerId", "topWebMenuId", "sideWebMenuId"];
const TEXT_KEYS = ["marquee", "searchKeywords", "seoTitle", "seoDescr", "seoImage", "seoImageUrl"];
const SEO_KEYS = ["seoTitle", "seoDescr", "seoImage", "seoImageUrl", "robots"];

/** home_views.home_view_config 的預設值（與 DB 欄位預設相同） */
const DEFAULT_CONFIG: Row = {
  robots: false,
  marquee: "",
  fluidNav: false,
  footerId: null,
  navStyle: "STYLE_1",
  seoDescr: "",
  seoImage: "",
  seoTitle: "",
  colorTheme: "LIGHT",
  customStyle: "DEFAULT",
  seoImageUrl: "",
  navMenuStyle: "STYLE_1",
  topWebMenuId: null,
  sideWebMenuId: null,
  searchKeywords: "",
};

/** 列表/Editor 回應用的欄位（不含暫存 html，避免列表回應過大） */
const VIEW_SELECT = "id, tenant_id, group_buy_id, category, title, tag, home_view_config, date_cached, created_at, updated_at";

type GroupBuyRow = Row & { id: number; title: string | null; short_url: string | null; render: string | null };
type ViewRow = {
  id: number;
  tenant_id: number;
  group_buy_id: number;
  category: string;
  title: string;
  tag: string | null;
  home_view_config: Row | null;
};
type SectionRow = { id: number; title: string | null; category: string | null; seq: number; settings: Row | null; html: string | null };
type ItemRow = {
  id: number;
  home_view_section_id: number;
  category: string | null;
  tag: string | null;
  title: string | null;
  image: string | null;
  image_url: string | null;
  link: string | null;
  seq: number;
  settings: Row | null;
};

const db = () => getServiceClient();

/* ─────────────────────────── 共用 ─────────────────────────── */

/** 讀取網址/表單參數 groupBuyId 指定的團購（必須屬於登入者租戶，否則 404） */
async function groupBuyOf(ctx: RequestContext, extraCols = ""): Promise<GroupBuyRow> {
  const session = requireSession(ctx);
  const raw = await ctx.param("groupBuyId");
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id <= 0) throw notFound("找不到團購");
  const { data, error } = await db()
    .from("group_buys")
    .select(`id, title, short_url, render${extraCols ? `, ${extraCols}` : ""}`)
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[homeview] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as unknown as GroupBuyRow;
}

async function loadViews(tenantId: number, groupBuyId: number): Promise<ViewRow[]> {
  const { data, error } = await db()
    .from("home_views")
    .select("id, tenant_id, group_buy_id, category, title, tag, home_view_config")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("id");
  if (error) throw new Error(`[homeview] 讀取官網頁面失敗：${error.message}`);
  return (data ?? []) as unknown as ViewRow[];
}

async function loadView(tenantId: number, groupBuyId: number, homeViewId: unknown): Promise<ViewRow> {
  const id = Number(homeViewId);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound("找不到官網頁面");
  const { data, error } = await db()
    .from("home_views")
    .select("id, tenant_id, group_buy_id, category, title, tag, home_view_config")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[homeview] 讀取官網頁面失敗：${error.message}`);
  if (!data) throw notFound("找不到官網頁面");
  return data as unknown as ViewRow;
}

function toBool(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && toBool(v[0]);
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  return ["1", "true", "on", "yes", "y", "t"].includes(String(v).trim().toLowerCase());
}

/** select2 參照值：'' / null → null；-1、-2、id → 數字 */
function toRefId(v: unknown): number | null {
  if (Array.isArray(v)) v = v[0];
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "null" || s === "undefined") return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function normalizeConfig(cfg: Row): Row {
  const out: Row = { ...DEFAULT_CONFIG, ...cfg };
  out.fluidNav = toBool(out.fluidNav);
  out.robots = toBool(out.robots);
  for (const k of REF_KEYS) out[k] = toRefId(out[k]);
  for (const k of TEXT_KEYS) out[k] = out[k] == null ? "" : String(out[k]);
  return out;
}

/** 推導：CUSTOM 頁面的「發布網址」＝ 前台網址/{短網址}?homeViewId={id}（原站列資料鍵 publishUrl） */
function publishUrlOf(ctx: RequestContext, gb: GroupBuyRow, row: Row): string {
  if (row.category !== "CUSTOM" || !gb.short_url) return "";
  return `${requestOrigin(ctx)}/${gb.short_url}?homeViewId=${row.id}`;
}

function mapViewRow(api: Row, row: Row, gb: GroupBuyRow, ctx: RequestContext): Row {
  const out: Row = { ...api };
  delete out.html;
  out.homeViewConfig = normalizeConfig((row.home_view_config as Row | null) ?? {});
  out.publishUrl = publishUrlOf(ctx, gb, row);
  return out;
}

/* ─────────────────────────── 列表 ─────────────────────────── */

function listSpecFor(gb: GroupBuyRow): ListSpec {
  return {
    select: VIEW_SELECT,
    where: (q) => q.eq("group_buy_id", gb.id),
    search: ["title", "tag"],
    like: ["title", "tag"],
    defaultOrder: [{ key: "homeViewId", ascending: false }],
    mapRow: (api, row, ctx) => mapViewRow(api, row, gb, ctx),
    // 原站 options 的鍵與順序：navStyle、customStyle、category、navMenuStyle、colorTheme
    options: () =>
      enumOptionsFor({
        "homeViewConfig.navStyle": "HomeView.navStyle",
        "homeViewConfig.customStyle": "HomeView.customStyle",
        category: "HomeView.category",
        "homeViewConfig.navMenuStyle": "HomeView.navMenuStyle",
        "homeViewConfig.colorTheme": "HomeView.colorTheme",
      }),
  };
}

/* ─────────────────────────── 寫入（Editor） ─────────────────────────── */

async function footerExists(tenantId: number, groupBuyId: number, id: number): Promise<boolean> {
  const { data } = await db()
    .from("home_views")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .in("category", FOOTER_CATEGORIES)
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

async function webMenuExists(tenantId: number, groupBuyId: number, id: number): Promise<boolean> {
  const { data } = await db()
    .from("web_menus")
    .select("id")
    .eq("tenant_id", tenantId)
    .or(`group_buy_id.eq.${groupBuyId},group_buy_id.is.null`)
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

async function validateMain(values: Row, action: "create" | "edit", tenantId: number, gb: GroupBuyRow) {
  const errors: { name: string; status: string }[] = [];
  if (action === "create" || "category" in values) {
    if (!ALL_CATEGORIES.includes(String(values.category ?? ""))) errors.push({ name: "category", status: "請選擇類別" });
  }
  if ("title" in values && String(values.title ?? "").trim().length > 200) errors.push({ name: "title", status: "最多 200 個字" });
  if ("tag" in values && String(values.tag ?? "").trim().length > 100) errors.push({ name: "tag", status: "最多 100 個字" });
  for (const [name, enumKey] of Object.entries(CONFIG_ENUMS)) {
    if (!(name in values) || values[name] == null || values[name] === "") continue;
    const allowed = (await enumOptions(enumKey)).map((o) => String(o.value));
    if (!allowed.includes(String(values[name]))) errors.push({ name, status: "請選擇正確的選項" });
  }
  if ("homeViewConfig.footerId" in values) {
    const id = toRefId(values["homeViewConfig.footerId"]);
    if (id !== null && id !== -1 && id !== -2 && (id <= 0 || !(await footerExists(tenantId, gb.id, id)))) {
      errors.push({ name: "homeViewConfig.footerId", status: "找不到此頁尾" });
    }
  }
  for (const name of ["homeViewConfig.topWebMenuId", "homeViewConfig.sideWebMenuId"]) {
    if (!(name in values)) continue;
    const id = toRefId(values[name]);
    if (id !== null && id !== -1 && (id <= 0 || !(await webMenuExists(tenantId, gb.id, id)))) {
      errors.push({ name, status: "找不到此選單" });
    }
  }
  return errors;
}

function writeSpecFor(gb: GroupBuyRow, mode: "main" | "seo"): WriteSpec {
  return {
    select: VIEW_SELECT,
    mapRow: (api, row, ctx) => mapViewRow(api, row, gb, ctx),
    async validate(values, action, ctx, existing) {
      if (existing && Number(existing.group_buy_id) !== gb.id) throw notFound("找不到資料（可能已被刪除）");
      if (mode === "seo") {
        const errors: { name: string; status: string }[] = [];
        if (String(values["homeViewConfig.seoTitle"] ?? "").length > 200) errors.push({ name: "homeViewConfig.seoTitle", status: "最多 200 個字" });
        if (String(values["homeViewConfig.seoDescr"] ?? "").length > 1000) errors.push({ name: "homeViewConfig.seoDescr", status: "最多 1000 個字" });
        return errors;
      }
      return validateMain(values, action, ctx.session.tenantId, gb);
    },
    beforeWrite(dbRow, values, action, ctx, existing) {
      const existingCfg = ((existing?.home_view_config as Row | null) ?? {}) as Row;
      if (mode === "seo") {
        // SEO Editor 只改 SEO 相關設定，其他欄位一律忽略
        const cfg: Row = { ...existingCfg };
        for (const k of SEO_KEYS) {
          const v = values[`homeViewConfig.${k}`];
          if (v !== undefined) cfg[k] = v;
        }
        return { home_view_config: normalizeConfig(cfg) };
      }
      const out: Row = { ...dbRow };
      delete out.html;
      delete out.date_cached;
      delete out.group_buy_id;
      if (action === "create") out.group_buy_id = gb.id;
      if (action === "create" || out.home_view_config !== undefined) {
        const submitted = (out.home_view_config as Row | undefined) ?? {};
        out.home_view_config = normalizeConfig(action === "create" ? submitted : { ...existingCfg, ...submitted });
      }
      if (out.title === null || (action === "create" && out.title === undefined)) out.title = "";
      if (typeof out.title === "string") out.title = out.title.trim();
      if (typeof out.tag === "string") out.tag = out.tag.trim() || null;
      return out;
    },
    async beforeRemove(ids, ctx) {
      const tenantId = ctx.session.tenantId;
      const views = await loadViews(tenantId, gb.id);
      const mine = new Set(views.map((v) => v.id));
      if (!ids.every((id) => mine.has(id))) throw notFound("找不到資料（可能已被刪除）");
      // 推導：被刪除的 FOOTER 若仍被網頁頁面指定，改回「顯示預設頁尾」(-1)
      const removed = new Set(ids);
      for (const v of views) {
        if (removed.has(v.id)) continue;
        const cfg = v.home_view_config ?? {};
        const ref = toRefId(cfg.footerId);
        if (ref === null || !removed.has(ref)) continue;
        const { error } = await db()
          .from("home_views")
          .update({ home_view_config: { ...cfg, footerId: -1 } })
          .eq("tenant_id", tenantId)
          .eq("id", v.id);
        if (error) throw new Error(`[homeview] 更新頁尾設定失敗：${error.message}`);
      }
    },
    async afterWrite(rows, action, ctx) {
      if (action === "remove" || mode === "seo") return;
      await enforceUnique(ctx.session.tenantId, gb.id, rows as unknown as ViewRow[]);
    },
  };
}

/** 唯一類別：同團購其他「網頁 首頁」「FOOTER 預設」改成草稿（推導，見 UNIQUE_DEMOTE） */
async function enforceUnique(tenantId: number, groupBuyId: number, written: Pick<ViewRow, "id" | "category">[]) {
  for (const [unique, demoted] of Object.entries(UNIQUE_DEMOTE)) {
    const winners = written.filter((r) => r.category === unique);
    if (winners.length === 0) continue;
    const keep = Number(winners[winners.length - 1].id);
    const { error } = await db()
      .from("home_views")
      .update({ category: demoted })
      .eq("tenant_id", tenantId)
      .eq("group_buy_id", groupBuyId)
      .eq("category", unique)
      .neq("id", keep);
    if (error) throw new Error(`[homeview] 更新類別失敗：${error.message}`);
  }
}

function writeHandler(mode: "main" | "seo") {
  return async (ctx: RequestContext): Promise<Response> => {
    const gb = await groupBuyOf(ctx);
    if (mode === "seo") {
      const req = await parseEditorRequest(ctx);
      if (req.action !== "edit") throw badRequest("不支援的操作");
    }
    return editorEntity(ctx, homeView, writeSpecFor(gb, mode));
  };
}

/* ─────────────────────────── 複製 ─────────────────────────── */

/** 複製一筆官網頁面（含內容區塊與區塊項目） */
async function copyView(tenantId: number, src: ViewRow, overrides: Partial<ViewRow>): Promise<ViewRow> {
  const client = db();
  const { data: created, error } = await client
    .from("home_views")
    .insert({
      tenant_id: tenantId,
      group_buy_id: src.group_buy_id,
      category: overrides.category ?? src.category,
      title: overrides.title ?? src.title,
      tag: overrides.tag !== undefined ? overrides.tag : src.tag,
      home_view_config: normalizeConfig(src.home_view_config ?? {}),
    })
    .select("id, tenant_id, group_buy_id, category, title, tag, home_view_config")
    .single();
  if (error || !created) throw new Error(`[homeview] 複製失敗：${error?.message}`);
  const view = created as unknown as ViewRow;
  const { data: secs, error: e2 } = await client
    .from("home_view_sections")
    .select("id, title, category, seq, settings, html")
    .eq("tenant_id", tenantId)
    .eq("home_view_id", src.id)
    .order("seq")
    .order("id");
  if (e2) throw new Error(`[homeview] 讀取內容區塊失敗：${e2.message}`);
  for (const s of (secs ?? []) as unknown as SectionRow[]) {
    const { data: ns, error: e3 } = await client
      .from("home_view_sections")
      .insert({ tenant_id: tenantId, home_view_id: view.id, title: s.title, category: s.category, seq: s.seq, settings: s.settings ?? {}, html: s.html })
      .select("id")
      .single();
    if (e3 || !ns) throw new Error(`[homeview] 複製內容區塊失敗：${e3?.message}`);
    const { data: items, error: e4 } = await client
      .from("home_view_items")
      .select("category, tag, title, image, image_url, link, seq, settings")
      .eq("tenant_id", tenantId)
      .eq("home_view_section_id", s.id)
      .order("seq")
      .order("id");
    if (e4) throw new Error(`[homeview] 讀取區塊項目失敗：${e4.message}`);
    const rows = ((items ?? []) as unknown as Row[]).map((it) => ({ ...it, tenant_id: tenantId, home_view_section_id: (ns as { id: number }).id }));
    if (rows.length) {
      const { error: e5 } = await client.from("home_view_items").insert(rows);
      if (e5) throw new Error(`[homeview] 複製區塊項目失敗：${e5.message}`);
    }
  }
  return view;
}

/** POST /ajax/HomeView/clone?groupBuyId=  body homeViewId=1（DataTableConfig.actionButton 的 joinIds） */
async function cloneHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const ids = ((await ctx.param("homeViewId")) ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) throw badRequest("請選擇要複製的資料");
  for (const id of ids) {
    const src = await loadView(session.tenantId, gb.id, id);
    // 推導：複本標題加「(複製)」，唯一類別改成草稿
    await copyView(session.tenantId, src, { category: UNIQUE_DEMOTE[src.category] ?? src.category, title: `${src.title}(複製)` });
  }
  return actionOk("成功複製");
}

async function insertView(tenantId: number, groupBuyId: number, category: string, title: string, tag: string | null): Promise<ViewRow> {
  const { data, error } = await db()
    .from("home_views")
    .insert({
      tenant_id: tenantId,
      group_buy_id: groupBuyId,
      category,
      title,
      tag,
      home_view_config: normalizeConfig({ footerId: -1, topWebMenuId: -1, sideWebMenuId: -1 }),
    })
    .select("id, tenant_id, group_buy_id, category, title, tag, home_view_config")
    .single();
  if (error || !data) throw new Error(`[homeview] 新增官網頁面失敗：${error?.message}`);
  return data as unknown as ViewRow;
}

async function insertSection(tenantId: number, homeViewId: number, section: Partial<SectionRow>): Promise<number> {
  const { data, error } = await db()
    .from("home_view_sections")
    .insert({ tenant_id: tenantId, home_view_id: homeViewId, settings: {}, ...section })
    .select("id")
    .single();
  if (error || !data) throw new Error(`[homeview] 新增內容區塊失敗：${error?.message}`);
  return (data as { id: number }).id;
}

/**
 * ANY /ajax/HomeView/cloneFromV1?groupBuyId=
 * 推導：舊版（V1）官網首頁＝團購的跑馬燈圖片（carousel1-4，沒有時用置頂橫幅 image）＋團購敘述（descr）。
 * 建成一筆網頁頁面（沒有「網頁 首頁」時為 RELEASE，否則 DRAFT），含 BANNER 區塊與 HTML 區塊，並產生暫存。
 */
async function cloneFromV1(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx, "descr, image, carousel1, carousel2, carousel3, carousel4");
  let images = [gb.carousel1, gb.carousel2, gb.carousel3, gb.carousel4].map((x) => String(x ?? "").trim()).filter(Boolean);
  if (images.length === 0 && String(gb.image ?? "").trim()) images = [String(gb.image).trim()];
  const descr = String(gb.descr ?? "").trim();
  if (images.length === 0 && !descr) throw badRequest("沒有舊版首頁內容可以複製");
  const views = await loadViews(session.tenantId, gb.id);
  const category = views.some((v) => v.category === "RELEASE") ? "DRAFT" : "RELEASE";
  const view = await insertView(session.tenantId, gb.id, category, gb.title || "首頁", "home");
  let seq = 1;
  if (images.length) {
    const sectionId = await insertSection(session.tenantId, view.id, { title: "", category: "BANNER", seq: seq++ });
    const { error } = await db()
      .from("home_view_items")
      .insert(images.map((image, i) => ({ tenant_id: session.tenantId, home_view_section_id: sectionId, category: "BANNER", title: "", image, seq: i + 1, settings: {} })));
    if (error) throw new Error(`[homeview] 新增區塊項目失敗：${error.message}`);
  }
  if (descr) await insertSection(session.tenantId, view.id, { title: "", category: "HTML", seq: seq++, html: descr });
  await rebuildCache(session.tenantId, view);
  return actionOk("成功複製");
}

/**
 * ANY /ajax/HomeViewCache/cloneFooterV1?groupBuyId=
 * 推導：舊版（V1）Footer＝團購的「Footer敘述」（descr_footer，原站 /backend/WebEditor/footer.do 編輯）。
 * 建成一筆 FOOTER（沒有「FOOTER 預設」時為 FOOTER_RELEASE，否則 FOOTER_DRAFT），內容放在一個 HTML 區塊，並產生暫存。
 */
async function cloneFooterV1(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx, "descr_footer");
  const html = String(gb.descr_footer ?? "").trim();
  if (!html) throw badRequest("沒有舊版 Footer 內容可以複製");
  const views = await loadViews(session.tenantId, gb.id);
  const category = views.some((v) => v.category === "FOOTER_RELEASE") ? "FOOTER_DRAFT" : "FOOTER_RELEASE";
  const view = await insertView(session.tenantId, gb.id, category, "Footer", "footer");
  await insertSection(session.tenantId, view.id, { title: "", category: "HTML", seq: 1, html });
  await rebuildCache(session.tenantId, view);
  return actionOk("成功複製");
}

/* ─────────────────────────── 暫存（產生 HTML） ─────────────────────────── */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** 只允許 http(s)、站內路徑、錨點、mailto/tel，其他（javascript: 等）改成 # */
function safeHref(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("/") || s.startsWith("#") || s.startsWith("?") || /^(mailto|tel):/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "#";
  return s;
}

/** 圖片路徑：完整網址原樣；其他視為上傳檔（/upload/images/…，同原站 field_upload 的顯示規則） */
function imageSrc(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("/")) return safeHref(s);
  return `/upload/images/${s}`;
}

/** 「內容#連結」格式（快訊、搜尋關鍵字） */
function linkEntries(text: unknown, separators: RegExp): { label: string; href: string }[] {
  return String(text ?? "")
    .split(separators)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf("#");
      return i > 0 ? { label: x.slice(0, i).trim(), href: safeHref(x.slice(i + 1)) } : { label: x, href: "" };
    });
}

function renderLinks(cls: string, entries: { label: string; href: string }[]): string {
  if (!entries.length) return "";
  const inner = entries
    .map((e) => (e.href ? `<a class="${cls}-item" href="${esc(e.href)}">${esc(e.label)}</a>` : `<span class="${cls}-item">${esc(e.label)}</span>`))
    .join("");
  return `<div class="${cls}">${inner}</div>`;
}

function renderItem(it: ItemRow): string {
  const src = it.image ? imageSrc(it.image) : imageSrc(it.image_url);
  const img = src ? `<img class="home-view-item-image" src="${esc(src)}" alt="${esc(it.title)}">` : "";
  const title = it.title ? `<div class="home-view-item-title">${esc(it.title)}</div>` : "";
  const href = safeHref(it.link);
  const body = href ? `<a href="${esc(href)}">${img}${title}</a>` : `${img}${title}`;
  return `<div class="home-view-item" data-category="${esc(it.category)}"${it.tag ? ` data-tag="${esc(it.tag)}"` : ""}>${body}</div>`;
}

function renderSection(s: SectionRow, items: ItemRow[]): string {
  const title = s.title ? `<h2 class="home-view-section-title">${esc(s.title)}</h2>` : "";
  const list = items.length ? `<div class="home-view-items">${items.map(renderItem).join("")}</div>` : "";
  // 區塊 html 為後台管理者編輯的內容（同原站 CKEditor 內容），原樣輸出
  return `<section class="home-view-section" data-section-id="${s.id}" data-category="${esc(s.category)}">${title}${s.html ?? ""}${list}</section>`;
}

function renderHomeView(view: ViewRow, sections: SectionRow[], items: ItemRow[]): string {
  const bySection = new Map<number, ItemRow[]>();
  for (const it of items) {
    const arr = bySection.get(it.home_view_section_id);
    if (arr) arr.push(it);
    else bySection.set(it.home_view_section_id, [it]);
  }
  const body = sections.map((s) => renderSection(s, bySection.get(s.id) ?? [])).join("");
  if (FOOTER_CATEGORIES.includes(view.category)) {
    // 同原站 updateDummyEditor：<footer class="page-footer font-small pt-4">…</footer>，去掉所有換行與 tab
    return `<footer class="page-footer font-small pt-4">${body}</footer>`.replace(/(\n|\t)/gm, "");
  }
  const cfg = normalizeConfig(view.home_view_config ?? {});
  const attrs = [
    `data-home-view-id="${view.id}"`,
    `data-category="${esc(view.category)}"`,
    `data-nav-style="${esc(cfg.navStyle)}"`,
    `data-nav-menu-style="${esc(cfg.navMenuStyle)}"`,
    `data-fluid-nav="${cfg.fluidNav ? "true" : "false"}"`,
    `data-custom-style="${esc(cfg.customStyle)}"`,
    `data-color-theme="${esc(cfg.colorTheme)}"`,
  ].join(" ");
  const marquee = renderLinks("home-view-marquee", linkEntries(cfg.marquee, /\r?\n/));
  const keywords = renderLinks("home-view-search-keywords", linkEntries(cfg.searchKeywords, /[,，\r\n]+/));
  return `<div class="home-view" ${attrs}>${marquee}${keywords}${body}</div>`;
}

/** 產生暫存 HTML 並寫回 home_views.html / date_cached */
async function rebuildCache(tenantId: number, view: ViewRow): Promise<string> {
  const client = db();
  const { data: secs, error } = await client
    .from("home_view_sections")
    .select("id, title, category, seq, settings, html")
    .eq("tenant_id", tenantId)
    .eq("home_view_id", view.id)
    .order("seq")
    .order("id");
  if (error) throw new Error(`[homeview] 讀取內容區塊失敗：${error.message}`);
  const sections = (secs ?? []) as unknown as SectionRow[];
  let items: ItemRow[] = [];
  if (sections.length) {
    const { data, error: e2 } = await client
      .from("home_view_items")
      .select("id, home_view_section_id, category, tag, title, image, image_url, link, seq, settings")
      .eq("tenant_id", tenantId)
      .in(
        "home_view_section_id",
        sections.map((s) => s.id),
      )
      .order("seq")
      .order("id");
    if (e2) throw new Error(`[homeview] 讀取區塊項目失敗：${e2.message}`);
    items = (data ?? []) as unknown as ItemRow[];
  }
  const html = renderHomeView(view, sections, items);
  const { error: e3 } = await client
    .from("home_views")
    .update({ html, date_cached: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", view.id);
  if (e3) throw new Error(`[homeview] 寫入暫存失敗：${e3.message}`);
  return html;
}

/** ANY /ajax/HomeViewCache/refresh?groupBuyId=&homeViewId=（列展開「更新暫存」；團購列表「更新Footer暫存」第二步） */
async function refreshHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const view = await loadView(session.tenantId, gb.id, await ctx.param("homeViewId"));
  await rebuildCache(session.tenantId, view);
  return actionOk("更新網頁成功");
}

/**
 * ANY /ajax/HomeViewCache/queryReleaseFooter?groupBuyId=
 * 原站團購列表 refreshFooter() 讀回應頂層的 homeViewId（$.post 成功時 data.homeViewId）；
 * 與 groupbuy 列表頁約定另附 data.homeViewId。沒有 FOOTER 預設時回 404（前端顯示「FOOTER 更新失敗」）。
 */
async function queryReleaseFooter(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const { data, error } = await db()
    .from("home_views")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .eq("category", "FOOTER_RELEASE")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[homeview] 查詢 FOOTER 預設失敗：${error.message}`);
  if (!data) throw notFound("找不到 FOOTER 預設");
  const homeViewId = (data as { id: number }).id;
  return json({ code: 200, error: "", homeViewId, groupBuyId: gb.id, data: { homeViewId, groupBuyId: gb.id } });
}

/** POST /ajax/GroupBuy/refreshHome  body groupBuyId（「更新首頁暫存」：重建「網頁 首頁」的暫存；沒有首頁也回成功） */
async function refreshHome(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const views = (await loadViews(session.tenantId, gb.id)).filter((v) => v.category === "RELEASE");
  for (const v of views) await rebuildCache(session.tenantId, v);
  return actionOk("成功更新");
}

/* ─────────────────────────── select2 ─────────────────────────── */
// 原站回應只有 {results:[…]}（沒有 pagination），固定選項在前；查詢字串與 initialValue 都回同一份清單（實測原站行為）。

async function lookupFooter(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const results: { id: number; text: string }[] = [
    { id: -1, text: "顯示預設頁尾" },
    { id: -2, text: "不顯示頁尾" },
  ];
  const gbId = Number(await ctx.param("groupBuyId"));
  if (Number.isSafeInteger(gbId) && gbId > 0) {
    const { data, error } = await db()
      .from("home_views")
      .select("id, title, category")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", gbId)
      .in("category", FOOTER_CATEGORIES)
      .order("id");
    if (error) throw new Error(`[lookup homeViewFooter] ${error.message}`);
    for (const r of (data ?? []) as { id: number; title: string | null }[]) results.push({ id: r.id, text: r.title || `#${r.id}` });
  }
  return json({ results });
}

async function lookupWebMenu(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const results: { id: number; text: string }[] = [{ id: -1, text: "使用預設選單" }];
  const gbId = Number(await ctx.param("groupBuyId"));
  if (Number.isSafeInteger(gbId) && gbId > 0) {
    const { data, error } = await db()
      .from("web_menus")
      .select("id, title")
      .eq("tenant_id", session.tenantId)
      .or(`group_buy_id.eq.${gbId},group_buy_id.is.null`)
      .order("id");
    if (error) throw new Error(`[lookup homeViewWebMenu] ${error.message}`);
    for (const r of (data ?? []) as { id: number; title: string | null }[]) results.push({ id: r.id, text: r.title || `#${r.id}` });
  }
  return json({ results });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const homeViewRoutes: RouteDef[] = [
  page("/backend/HomeView/list", {
    template: "groupbuy/homeview-list.html",
    title: "官網",
    groupBuy: "required",
    async data(ctx) {
      const gb = await groupBuyOf(ctx, "descr, descr_footer, image, carousel1, carousel2, carousel3, carousel4");
      const views = await loadViews(ctx.session.tenantId, gb.id);
      const isHome = gb.render === "HOME";
      const hasV1Home = [gb.descr, gb.image, gb.carousel1, gb.carousel2, gb.carousel3, gb.carousel4].some((x) => String(x ?? "").trim() !== "");
      return {
        // 推導：舊版內容複製鈕只在官網型團購、尚無對應頁面且有舊版內容時出現（見模板註解）
        showCloneHomeViewV1: isHome && hasV1Home && !views.some((v) => PAGE_CATEGORIES.includes(v.category)),
        showCloneFooterV1: isHome && String(gb.descr_footer ?? "").trim() !== "" && !views.some((v) => FOOTER_CATEGORIES.includes(v.category)),
      };
    },
  }),
  {
    path: "/ajax/HomeView/list",
    method: ["GET", "POST"],
    handler: async (ctx) => listEntity(ctx, homeView, listSpecFor(await groupBuyOf(ctx))),
  },
  post("/ajax/HomeView/save", writeHandler("main")),
  post("/ajax/HomeView/update", writeHandler("main")),
  post("/ajax/HomeView/delete", writeHandler("main")),
  post("/ajax/HomeView/updateSEO", writeHandler("seo")),
  post("/ajax/HomeView/clone", cloneHandler),
  any("/ajax/HomeView/cloneFromV1", cloneFromV1),
  any("/ajax/HomeViewCache/cloneFooterV1", cloneFooterV1),
  any("/ajax/HomeViewCache/refresh", refreshHandler),
  any("/ajax/HomeViewCache/refreshCustomWeb", refreshHandler),
  any("/ajax/HomeViewCache/queryReleaseFooter", queryReleaseFooter),
  post("/ajax/GroupBuy/refreshHome", refreshHome),
  get("/ajax/Lookup/homeViewFooter", lookupFooter),
  get("/ajax/Lookup/homeViewWebMenu", lookupWebMenu),
];
