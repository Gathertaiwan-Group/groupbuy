// 官網型前台頁（render=HOME 的團購網站：說明中心首頁、文章列表/內頁、最新公告、403）共用：
// 網址組法、選單樹、首頁區塊、文章查詢、版面模板變數。
// 前台沒有後台 session：所有查詢都以「網址解析出的租戶」tenant_id 過濾（多租戶隔離），團購範圍再以 group_buy_id 限定。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import { feVars, groupBuyPreferences, imageUrl, PLATFORM_TENANT_CODE, type SfGroupBuy, type SfTenant } from "./site";

const db = () => getServiceClient();

// ───────────────────────── 網址 ─────────────────────────

/** Java URLEncoder 風格：encodeURIComponent 之外，! ' ( ) ~ 也編碼（原站網址的「(」是 %28） */
export function javaUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * 原站網址裡的標題段：「/」「-」「.」換成「_」後編碼。
 * 例：運費設定/物流配送 → 運費設定_物流配送；品項/商品上架(第二.三層) → 品項_商品上架%28第二_三層%29（皆由原站擷取網址歸納）。
 * 空白也換成「_」（原站未見含空白的標題，推導）。
 */
export function titleSlug(title: string | null | undefined): string {
  const t = Array.from(String(title ?? "").replace(/[/\\\-.\s]/g, "_")).slice(0, 120).join("");
  return javaUrlEncode(t);
}

export const postHref = (short: string, id: number, title: string | null): string => `/${short}/post/${id}/${titleSlug(title)}`;
export const menuHref = (short: string, id: number, title: string | null): string => `/${short}/menu/${id}/${titleSlug(title)}`;
export const categoryHref = (short: string, id: number, title: string | null): string =>
  `/${short}/postcategory/${id}/${titleSlug(title)}`;
export const tagHref = (short: string, tag: string): string => `/${short}/post/tag/${javaUrlEncode(tag)}`;

/**
 * DB 設定的連結（選單節點 url、首頁項目 link）：只接受站內路徑（/…）、錨點（#…）或 http(s)，其餘（javascript: 等）丟棄。
 * 非 ASCII 與空白做百分比編碼（原站輸出的連結都是編碼過的）。
 */
export function safeHref(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > 1000) return null;
  if (s.startsWith("//")) return null;
  if (!(s.startsWith("/") || s.startsWith("#") || /^https?:\/\//i.test(s))) return null;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp > 0x7e || cp <= 0x20 || ch === '"' || ch === "<" || ch === ">" || ch === "`" ? encodeURIComponent(ch) : ch;
  }
  return out;
}

// ───────────────────────── 輸入驗證 ─────────────────────────

const ID_RE = /^\d{1,15}$/;

/** 網址中的數字 id（選單節點、文章、團購）；格式不對回 null */
export function parseId(v: string | null | undefined): number | null {
  if (!v || !ID_RE.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const PAGE_SIZE_DEFAULT = 10;
export const PAGE_SIZE_MAX = 50;
export const KEYWORD_MAX = 50;

/** ?page=&n=：page ≥ 1（最多 6 位數）、1 ≤ n ≤ 50；格式不對用預設值 */
export function parsePaging(ctx: RequestContext): { page: number; n: number } {
  const p = ctx.query.get("page") ?? "";
  const nn = ctx.query.get("n") ?? "";
  const page = /^\d{1,6}$/.test(p) && Number(p) >= 1 ? Number(p) : 1;
  let n = /^\d{1,3}$/.test(nn) && Number(nn) >= 1 ? Number(nn) : PAGE_SIZE_DEFAULT;
  if (n > PAGE_SIZE_MAX) n = PAGE_SIZE_MAX;
  return { page, n };
}

/** 搜尋關鍵字：去頭尾空白、去控制字元、最多 50 字 */
export function cleanKeyword(v: string | null | undefined): string {
  const s = String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return Array.from(s).slice(0, KEYWORD_MAX).join("").trim();
}

/** LIKE 樣式：跳脫 \ % _，前後加 % */
function likePattern(kw: string): string {
  return `%${kw.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

/** PostgREST or() 內的值：以雙引號包住，跳脫 \ 與 "（避免 , ( ) 等保留字元被當成語法） */
function pgrstQuoted(v: string): string {
  return `"${v.replace(/[\\"]/g, (m) => "\\" + m)}"`;
}

// ───────────────────────── 文字工具 ─────────────────────────

const ENTITY: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8}|#39);/g, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITY[g] ?? m;
  });
}

/** 文章內文 → 純文字摘要（原站首頁「最新文章」取內文前 180 字，段落直接相接） */
export function textExcerpt(html: string | null | undefined, max = 180): string {
  const text = decodeEntities(
    String(html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, max).join("");
}

/** posts.tags 文字欄 → 標籤陣列（以逗號／頓號／# 分隔，推導） */
export function parseTags(v: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of String(v ?? "").split(/[,，、#;；\n]+/)) {
    const s = t.trim();
    if (s && s.length <= 50 && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 自訂 CSS：去掉 <（避免跳出 <style>） */
function cleanCss(v: unknown): string {
  return typeof v === "string" ? v.replace(/</g, "").slice(0, 20000) : "";
}

// ───────────────────────── 選單 ─────────────────────────

interface WebMenuRow {
  id: number;
  group_buy_id: number | null;
  category: string;
}

export interface MenuNodeRow {
  id: number;
  web_menu_id: number | null;
  parent_id: number | null;
  title: string;
  url: string | null;
  seq: number;
}

export interface MenuNodeView {
  id: number;
  title: string;
  href: string;
  root: boolean;
  children: MenuNodeView[];
}

export interface TopMenuItemView {
  id: number;
  title: string;
  href: string;
  links: { title: string; href: string }[];
}

async function loadWebMenus(tenantId: number, groupBuyId: number): Promise<WebMenuRow[]> {
  const { data, error } = await db()
    .from("web_menus")
    .select("id, group_buy_id, category")
    .eq("tenant_id", tenantId)
    .or(`group_buy_id.eq.${groupBuyId},group_buy_id.is.null`)
    .order("id")
    .limit(200);
  if (error) throw new Error(`查詢網站選單失敗：${error.message}`);
  return (data ?? []) as WebMenuRow[];
}

async function loadMenuNodes(tenantId: number, webMenuId: number): Promise<MenuNodeRow[]> {
  const { data, error } = await db()
    .from("web_menu_nodes")
    .select("id, web_menu_id, parent_id, title, url, seq")
    .eq("tenant_id", tenantId)
    .eq("web_menu_id", webMenuId)
    .order("seq")
    .order("id")
    .limit(1000);
  if (error) throw new Error(`查詢選單節點失敗：${error.message}`);
  return (data ?? []) as MenuNodeRow[];
}

/**
 * 節點連結：節點有設定 url 就用它；沒有就連到該節點的文章列表 /{短網址}/menu/{id}/{標題}（推導：原站葉節點連到文章分類）。
 * 有子節點的節點在原站是可收合群組、沒有連結（模板處理）。
 */
function nodeHref(short: string, n: MenuNodeRow): string {
  return safeHref(n.url) ?? menuHref(short, n.id, n.title);
}

/** 由節點列組樹（依 seq；防循環、最多 6 層） */
export function buildMenuTree(rows: MenuNodeRow[], short: string): MenuNodeView[] {
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<number | null, MenuNodeRow[]>();
  for (const r of rows) {
    const p = r.parent_id !== null && r.parent_id !== r.id && ids.has(r.parent_id) ? r.parent_id : null;
    const list = byParent.get(p) ?? [];
    list.push(r);
    byParent.set(p, list);
  }
  const seen = new Set<number>();
  const build = (parent: number | null, depth: number): MenuNodeView[] => {
    const out: MenuNodeView[] = [];
    for (const r of byParent.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, title: r.title, href: nodeHref(short, r), root: depth === 0, children: depth < 5 ? build(r.id, depth + 1) : [] });
    }
    return out;
  };
  return build(null, 0);
}

/** 上方選單（Mega）：第一層＝導覽列項目；有子節點時子孫的葉節點攤平成 mega menu 連結（原站只見兩層，推導） */
export function topMenuFrom(tree: MenuNodeView[]): TopMenuItemView[] {
  const leaves = (nodes: MenuNodeView[]): { title: string; href: string }[] =>
    nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [{ title: n.title, href: n.href }]));
  return tree.map((n) => ({ id: n.id, title: n.title, href: n.href, links: n.children.length ? leaves(n.children) : [] }));
}

/** 取一個節點與其所有子孫的 id（文章列表「含子分類」） */
export function descendantIds(rows: MenuNodeRow[], rootId: number): number[] {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id !== null && out.has(r.parent_id) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return [...out];
}

// ───────────────────────── 官網設定（HomeView） ─────────────────────────

export interface HomeViewRow {
  id: number;
  group_buy_id: number;
  category: string;
  title: string;
  tag: string | null;
  home_view_config: Record<string, unknown> | null;
  html: string | null;
}

async function loadHomeViews(tenantId: number, groupBuyId: number): Promise<HomeViewRow[]> {
  const { data, error } = await db()
    .from("home_views")
    .select("id, group_buy_id, category, title, tag, home_view_config, html")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("id")
    .limit(200);
  if (error) throw new Error(`查詢官網頁面失敗：${error.message}`);
  return (data ?? []) as HomeViewRow[];
}

/** 一個網站（render=HOME 的團購）的版面資料：設定、選單、頁尾 */
export interface WebSite {
  tenant: SfTenant;
  groupBuy: SfGroupBuy;
  short: string;
  /** 網頁 首頁（唯一）＝category RELEASE；沒有時 null（用預設區塊） */
  homeView: HomeViewRow | null;
  config: Record<string, unknown>;
  sideMenu: MenuNodeView[];
  topMenu: TopMenuItemView[];
  /** 所有載入的選單節點（文章分類名稱、子分類展開用） */
  menuRows: MenuNodeRow[];
  footerHtml: string | null;
  themeOverrides: Record<string, unknown> | null;
}

export async function loadWebSite(tenant: SfTenant, gb: SfGroupBuy): Promise<WebSite> {
  const short = gb.short_url || "null";
  const [views, menus, prefs] = await Promise.all([
    loadHomeViews(tenant.id, gb.id),
    loadWebMenus(tenant.id, gb.id),
    groupBuyPreferences(tenant.id, gb.id),
  ]);
  const homeView = views.find((v) => v.category === "RELEASE") ?? null;
  const config = (homeView?.home_view_config ?? {}) as Record<string, unknown>;

  // 選單：HomeView 設定的 sideWebMenuId / topWebMenuId；沒有設定時用此團購 SIDE / TOP 類別的選單；
  // 只有其中一種時兩處共用（推導：原站 /jranv 上方選單與側欄是同一份樹）
  const byId = new Map(menus.map((m) => [m.id, m]));
  const pick = (cfg: unknown, cat: string): WebMenuRow | null => {
    const id = Number(cfg);
    if (Number.isSafeInteger(id) && byId.has(id)) return byId.get(id) ?? null;
    return menus.find((m) => m.category === cat && m.group_buy_id === gb.id) ?? menus.find((m) => m.category === cat) ?? null;
  };
  const sideM = pick(config.sideWebMenuId, "SIDE");
  const topM = pick(config.topWebMenuId, "TOP");
  const side = sideM ?? topM;
  const top = topM ?? sideM;
  const menuIds = [...new Set([side?.id, top?.id].filter((x): x is number => typeof x === "number"))];
  const nodeLists = await Promise.all(menuIds.map((id) => loadMenuNodes(tenant.id, id)));
  const rowsByMenu = new Map(menuIds.map((id, i) => [id, nodeLists[i]]));
  const sideMenu = side ? buildMenuTree(rowsByMenu.get(side.id) ?? [], short) : [];
  const topTree = top ? (top.id === side?.id ? sideMenu : buildMenuTree(rowsByMenu.get(top.id) ?? [], short)) : [];

  // 頁尾：HomeView 設定的 footerId，否則此團購的「FOOTER 預設」
  const footerId = Number(config.footerId);
  const footer =
    views.find((v) => v.id === footerId && v.category.startsWith("FOOTER")) ?? views.find((v) => v.category === "FOOTER_RELEASE") ?? null;
  const footerHtml = footer?.html && footer.html.trim() ? footer.html : null;

  const theme = prefs.THEME_SETTINGS;
  return {
    tenant,
    groupBuy: gb,
    short,
    homeView,
    config,
    sideMenu,
    topMenu: topMenuFrom(topTree),
    menuRows: nodeLists.flat(),
    footerHtml,
    themeOverrides: theme ? theme.settings : null,
  };
}

// ───────────────────────── 文章 ─────────────────────────

export interface PostRow {
  id: number;
  group_buy_id: number | null;
  web_menu_node_id: number | null;
  title: string;
  summary: string | null;
  body?: string | null;
  image: string | null;
  tags: string | null;
  date_published: string;
  /** 只填「文章圖片網址」時的圖（image 為空才用） */
  image_url?: string | null;
  /** NORMAL／PREMIUM（限閱文章） */
  post_type?: string | null;
  /** 限閱會員等級（逗號分隔的會員方案 id 或名稱；空＝登入會員即可） */
  access_level?: string | null;
}

const POST_COLS = "id, group_buy_id, web_menu_node_id, title, summary, image, tags, date_published, image_url, post_type, access_level";

/** 網站的文章範圍：同租戶、已發布、屬於此團購（或租戶共用 group_buy_id 為空） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postScope(q: any, site: { tenant: SfTenant; groupBuy: SfGroupBuy }): any {
  // 已發布，或「排程發布」(status=FUTURE) 且發佈時間已到（後台 Post 編輯器的排程發布：到時間自動上架，不需排程器）
  const now = new Date().toISOString();
  return q
    .eq("tenant_id", site.tenant.id)
    .or(`is_published.eq.true,and(status.eq.FUTURE,date_published.lte.${now})`)
    .or(`group_buy_id.eq.${site.groupBuy.id},group_buy_id.is.null`);
}

export interface PostQuery {
  /** 限定選單節點（分類）id */
  nodeIds?: number[];
  /** 標題/摘要/內文含關鍵字 */
  keyword?: string;
  page: number;
  n: number;
}

export async function queryPosts(site: WebSite, q: PostQuery): Promise<{ rows: PostRow[]; total: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (qb: any): any => {
    let x = postScope(qb, site);
    if (q.nodeIds) x = x.in("web_menu_node_id", q.nodeIds.length ? q.nodeIds : [-1]);
    if (q.keyword) {
      const v = pgrstQuoted(likePattern(q.keyword));
      x = x.or(`title.ilike.${v},summary.ilike.${v},body.ilike.${v}`);
    }
    return x;
  };
  const from = (q.page - 1) * q.n;
  const { data, error, count } = await filtered(db().from("posts").select(POST_COLS, { count: "exact" }))
    .order("date_published", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + q.n - 1);
  // PGRST103＝頁碼超出範圍（Requested range not satisfiable）
  if (error && error.code !== "PGRST103") throw new Error(`查詢文章失敗：${error.message}`);
  const rows = error ? [] : ((data ?? []) as PostRow[]);
  if (!error && (rows.length > 0 || q.page === 1) && typeof count === "number") return { rows, total: count };
  // 超出最後一頁：另查總數，列表顯示空白但仍有分頁可以回到前面
  const { count: total, error: e2 } = await filtered(db().from("posts").select("id", { count: "exact", head: true }));
  if (e2) throw new Error(`查詢文章失敗：${e2.message}`);
  return { rows, total: total ?? 0 };
}

/** 標籤頁：先以 ilike 縮小範圍，再精確比對標籤（tags 是文字欄） */
export async function queryPostsByTag(site: WebSite, tag: string, page: number, n: number): Promise<{ rows: PostRow[]; total: number }> {
  const { data, error } = await postScope(db().from("posts").select(POST_COLS), site)
    .ilike("tags", likePattern(tag))
    .order("date_published", { ascending: false })
    .order("id", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`查詢文章失敗：${error.message}`);
  const all = ((data ?? []) as PostRow[]).filter((r) => parseTags(r.tags).includes(tag));
  const from = (page - 1) * n;
  return { rows: all.slice(from, from + n), total: all.length };
}

export async function latestPosts(site: WebSite, limit: number): Promise<PostRow[]> {
  const { data, error } = await postScope(db().from("posts").select(`${POST_COLS}, body`), site)
    .order("date_published", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`查詢文章失敗：${error.message}`);
  return (data ?? []) as PostRow[];
}

export async function findPost(site: WebSite, postId: number): Promise<PostRow | null> {
  const { data, error } = await postScope(db().from("posts").select(`${POST_COLS}, body`), site).eq("id", postId).maybeSingle();
  if (error) throw new Error(`查詢文章失敗：${error.message}`);
  return (data as PostRow | null) ?? null;
}

/** 文章即時搜尋（Post/lookup）：標題或摘要含關鍵字，最多 10 筆 */
export async function lookupPosts(site: WebSite, keyword: string): Promise<PostRow[]> {
  const v = pgrstQuoted(likePattern(keyword));
  const { data, error } = await postScope(db().from("posts").select(POST_COLS), site)
    .or(`title.ilike.${v},summary.ilike.${v}`)
    .order("date_published", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);
  if (error) throw new Error(`查詢文章失敗：${error.message}`);
  return (data ?? []) as PostRow[];
}

/** 網站所有文章用到的標籤（文章列表上方的標籤列；依文章新到舊、最多 30 個，推導） */
export async function siteTags(site: WebSite): Promise<{ name: string; href: string }[]> {
  const { data, error } = await postScope(db().from("posts").select("tags"), site)
    .not("tags", "is", null)
    .order("date_published", { ascending: false })
    .limit(500);
  if (error) throw new Error(`查詢文章標籤失敗：${error.message}`);
  const names: string[] = [];
  for (const r of (data ?? []) as { tags: string | null }[]) {
    for (const t of parseTags(r.tags)) if (!names.includes(t) && names.length < 30) names.push(t);
  }
  return names.map((name) => ({ name, href: tagHref(site.short, name) }));
}

/** 文章的分類（＝所屬選單節點）名稱；不在已載入的選單內時另查 */
export async function nodeTitles(site: WebSite, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const r of site.menuRows) out.set(r.id, r.title);
  const missing = [...new Set(ids)].filter((id) => !out.has(id));
  if (missing.length) {
    const { data, error } = await db().from("web_menu_nodes").select("id, title").eq("tenant_id", site.tenant.id).in("id", missing);
    if (error) throw new Error(`查詢選單節點失敗：${error.message}`);
    for (const r of (data ?? []) as { id: number; title: string }[]) out.set(r.id, r.title);
  }
  return out;
}

/** 選單節點（文章分類）：必須是同租戶、屬於此團購（或租戶共用）選單的節點 */
export async function findMenuNode(
  site: WebSite,
  nodeId: number,
): Promise<{ node: MenuNodeRow; rows: MenuNodeRow[] } | null> {
  const { data, error } = await db()
    .from("web_menu_nodes")
    .select("id, web_menu_id, parent_id, title, url, seq")
    .eq("tenant_id", site.tenant.id)
    .eq("id", nodeId)
    .maybeSingle();
  if (error) throw new Error(`查詢選單節點失敗：${error.message}`);
  const node = (data as MenuNodeRow | null) ?? null;
  if (!node || node.web_menu_id === null) return null;
  const { data: menu, error: e2 } = await db()
    .from("web_menus")
    .select("id, group_buy_id")
    .eq("tenant_id", site.tenant.id)
    .eq("id", node.web_menu_id)
    .maybeSingle();
  if (e2) throw new Error(`查詢網站選單失敗：${e2.message}`);
  const m = menu as { id: number; group_buy_id: number | null } | null;
  if (!m || (m.group_buy_id !== null && m.group_buy_id !== site.groupBuy.id)) return null;
  const loaded = site.menuRows.filter((r) => r.web_menu_id === node.web_menu_id);
  const rows = loaded.length ? loaded : await loadMenuNodes(site.tenant.id, node.web_menu_id);
  return { node, rows };
}

export interface PostCardView {
  id: number;
  title: string;
  href: string;
  date: string;
  summary: string;
  image: string;
  category: { title: string; href: string } | null;
}

export function postCard(site: WebSite, r: PostRow, titles: Map<number, string>, dateStyle: "date" | "datetime"): PostCardView {
  const catTitle = r.web_menu_node_id !== null ? titles.get(r.web_menu_node_id) : undefined;
  return {
    id: r.id,
    title: r.title,
    href: postHref(site.short, r.id, r.title),
    date: dateStyle === "date" ? taipeiDate(r.date_published) : taipeiDateTime(r.date_published),
    summary: r.summary ?? "",
    image: imageUrl(r.image) || (/^https?:\/\//i.test(String(r.image_url ?? "").trim()) ? String(r.image_url).trim() : ""),
    category:
      catTitle !== undefined && r.web_menu_node_id !== null
        ? { title: catTitle, href: categoryHref(site.short, r.web_menu_node_id, catTitle) }
        : null,
  };
}

// ───────────────────────── 分頁 ─────────────────────────

export interface PageLinkView {
  cls: string;
  label: string;
  href: string | null;
}

/**
 * 原站分頁：« 1 2 3 4 … 27 »（第 1 頁時，擷取自 /jranv/menu/4411）。
 * 頁碼視窗＝目前頁 ±3，視窗外顯示第 1 頁／最後一頁與「...」（其他頁的樣子原站未擷取，推導）。
 */
export function paginationView(baseHref: string, page: number, totalPages: number, n: number): PageLinkView[] {
  if (totalPages < 1) return [];
  const sep = baseHref.includes("?") ? "&" : "?";
  const link = (p: number) => `${baseHref}${sep}page=${p}&n=${n}`;
  const items: PageLinkView[] = [];
  items.push(page <= 1 ? { cls: "disabled", label: "&laquo;", href: null } : { cls: "", label: "&laquo;", href: link(Math.min(page - 1, totalPages)) });
  const center = Math.min(page, totalPages);
  const start = Math.max(1, center - 3);
  const end = Math.min(totalPages, center + 3);
  if (start > 1) {
    items.push({ cls: "", label: "1", href: link(1) });
    if (start > 2) items.push({ cls: "", label: "...", href: null });
  }
  for (let p = start; p <= end; p++) {
    items.push(p === page ? { cls: "active", label: String(p), href: null } : { cls: "", label: String(p), href: link(p) });
  }
  if (end < totalPages) {
    if (end < totalPages - 1) items.push({ cls: "", label: "...", href: null });
    items.push({ cls: "", label: String(totalPages), href: link(totalPages) });
  }
  items.push(page >= totalPages ? { cls: "disabled", label: "&raquo;", href: null } : { cls: "", label: "&raquo;", href: link(page + 1) });
  return items;
}

// ───────────────────────── 版面變數 ─────────────────────────

export interface WebVarsOpts {
  tenant: SfTenant;
  /** 網站（有團購情境）；null＝系統公告 /News/list、403 這類沒有網站導覽列的頁 */
  site: WebSite | null;
}

/** 官網型頁面共用模板變數（web-head / web-header / web-footer / web-foot-scripts） */
export function webVars(ctx: RequestContext, o: WebVarsOpts): Record<string, unknown> {
  const gb = o.site?.groupBuy ?? null;
  const base = feVars(ctx, {
    tenant: o.tenant,
    groupBuy: gb,
    // 平台租戶（groupbuyforms）的頁面是珊瑚色票（擷取自 /groupbuyforms/News/list、/jranv）；其他租戶用租戶色票＋THEME_SETTINGS
    themeSource: o.tenant.code === PLATFORM_TENANT_CODE ? "platform" : "tenant",
    themeOverrides: o.site?.themeOverrides ?? null,
  });
  const cfg = o.site?.config ?? {};
  const navStyle = /^STYLE_([1-8])$/.exec(String(cfg.navStyle ?? "STYLE_1"));
  return {
    ...base,
    webNav: !!o.site,
    slideOutHideMd: false,
    navStyleClass: `nav-${navStyle ? navStyle[1] : "1"}`,
    sideMenu: o.site?.sideMenu ?? [],
    topMenu: o.site?.topMenu ?? [],
    customCss: cleanCss(gb?.group_buy_settings?.customCss),
    footerHtml: o.site?.footerHtml ?? null,
    footerDefault: !!o.site,
    contactFab: false,
    shoppingCartUuid: gb?.uuid ?? "",
    bodyClass: cfg.customStyle === "EDM" ? "gb-theme-edm" : "",
    newsBeautifyPath: `/${o.site?.short ?? "null"}/news`,
  };
}
