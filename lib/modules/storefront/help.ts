// 官網型前台頁（原站 web/*.jsp）：說明中心首頁（render=HOME，/jranv）、文章列表（/jranv/menu/4411/…）、
// 文章內頁、分類/標籤/搜尋結果、最新公告（/groupbuyforms/News/list.do?gid=34565、/jranv/news）、403 系統提示頁、文章即時搜尋 JSON。
// 原站 HTML：spec/html/fe-help-home-jranv.html、fe-help-menu-4411.html、fe-news-list.html、fe-error-403.html。
// 資料一律以網址解析出的租戶 tenant_id 過濾（短網址 → 團購 → tenant_id；/{租戶}/News/list → 租戶代碼）。
import { randomBytes } from "node:crypto";
import { get } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, json } from "@/lib/core/http/responses";
import { escapeHtml, renderTemplate } from "@/lib/core/render/template";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminNewsItem } from "../types";
import { sellerNotFound } from "./pages-static";
import { readCustomerSession } from "./customer-session";
import { groupBuyByShortUrl, imageUrl, PLATFORM_TENANT_CODE, scopeFromTenantPath, tenantById, tenantByCode, type SfGroupBuy, type SfTenant } from "./site";
import {
  categoryHref,
  cleanKeyword,
  descendantIds,
  findMenuNode,
  findPost,
  latestPosts,
  loadWebSite,
  lookupPosts,
  menuHref,
  nodeTitles,
  paginationView,
  parseId,
  parsePaging,
  parseTags,
  postCard,
  postHref,
  queryPosts,
  queryPostsByTag,
  safeHref,
  siteTags,
  tagHref,
  textExcerpt,
  webVars,
  type PostRow,
  type WebSite,
} from "./web-site";

const db = () => getServiceClient();

// ───────────────────────── 網站解析 ─────────────────────────

/** /{短網址}/… 的網站：短網址存在、團購 render=HOME，否則 null（呼叫端回 404） */
async function siteByShortUrl(shortUrl: string | undefined): Promise<WebSite | null> {
  const gb = await groupBuyByShortUrl(shortUrl);
  if (!gb || gb.render !== "HOME") return null;
  const tenant = await tenantById(gb.tenant_id);
  if (!tenant) return null;
  return loadWebSite(tenant, gb);
}

function page(template: string, vars: Record<string, unknown>, status = 200): Response {
  return html(renderTemplate(template, vars), { status });
}

// ───────────────────────── 首頁（render=HOME） ─────────────────────────

interface HvItemView {
  id: number;
  category: string;
  categoryClass: string;
  style: number;
  title: string;
  hidden: boolean;
  colClass: string;
  isContent: boolean;
  isPost: boolean;
  posts: (ReturnType<typeof postCard> & { excerpt: string })[];
  image: string;
  link: string | null;
}

interface HvSectionView {
  id: number;
  title: string;
  hidden: boolean;
  html: string | null;
  items: HvItemView[];
}

function settingNum(settings: Record<string, unknown> | null | undefined, key: string, def: number, min: number, max: number): number {
  const n = Number(settings?.[key]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

async function homePostCards(site: WebSite, limit: number): Promise<HvItemView["posts"]> {
  const rows = await latestPosts(site, limit);
  const titles = await nodeTitles(
    site,
    rows.map((r) => r.web_menu_node_id).filter((x): x is number => x !== null),
  );
  // 限閱文章不在列表露出內文，只用摘要
  return rows.map((r) => ({ ...postCard(site, r, titles, "date"), excerpt: r.post_type === "PREMIUM" ? r.summary ?? "" : textExcerpt(r.body) }));
}

/** HomeView 區塊（home_view_sections → home_view_items）。隱藏（settings.hidden）的區塊/項目不輸出 */
async function homeSections(site: WebSite, homeViewId: number): Promise<HvSectionView[]> {
  const { data: secs, error } = await db()
    .from("home_view_sections")
    .select("id, title, category, seq, settings, html")
    .eq("tenant_id", site.tenant.id)
    .eq("home_view_id", homeViewId)
    .order("seq")
    .order("id")
    .limit(100);
  if (error) throw new Error(`查詢官網區塊失敗：${error.message}`);
  type SecRow = { id: number; title: string | null; category: string | null; settings: Record<string, unknown> | null; html: string | null };
  const sections = ((secs ?? []) as SecRow[]).filter((s) => !s.settings?.hidden);
  const ids = sections.map((s) => s.id);
  type ItemRow = {
    id: number;
    home_view_section_id: number;
    category: string | null;
    title: string | null;
    image: string | null;
    image_url: string | null;
    link: string | null;
    settings: Record<string, unknown> | null;
  };
  let items: ItemRow[] = [];
  if (ids.length) {
    const { data, error: e2 } = await db()
      .from("home_view_items")
      .select("id, home_view_section_id, category, title, image, image_url, link, seq, settings")
      .eq("tenant_id", site.tenant.id)
      .in("home_view_section_id", ids)
      .order("seq")
      .order("id")
      .limit(1000);
    if (e2) throw new Error(`查詢官網區塊項目失敗：${e2.message}`);
    items = ((data ?? []) as ItemRow[]).filter((i) => !i.settings?.hidden);
  }
  let postCards: HvItemView["posts"] | null = null;
  const out: HvSectionView[] = [];
  for (const s of sections) {
    const views: HvItemView[] = [];
    for (const it of items.filter((i) => i.home_view_section_id === s.id)) {
      const category = String(it.category || s.category || "CONTENT").toUpperCase();
      const isPost = category === "POST";
      if (isPost && !postCards) postCards = await homePostCards(site, 12);
      views.push({
        id: it.id,
        category,
        categoryClass: category.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
        style: settingNum(it.settings, "style", 1, 1, 20),
        title: it.title ?? "",
        hidden: false,
        colClass: `col-md-${settingNum(it.settings, "col", category === "CATEGORY" ? 3 : 12, 1, 12)}`,
        isContent: category === "CONTENT",
        isPost,
        posts: isPost ? (postCards ?? []).slice(0, settingNum(it.settings, "count", 4, 1, 12)) : [],
        image: imageUrl(it.image) || (safeHref(it.image_url) ?? ""),
        link: safeHref(it.link),
      });
    }
    out.push({ id: s.id, title: s.title ?? "", hidden: false, html: s.html && s.html.trim() ? s.html : null, items: views });
  }
  return out;
}

/**
 * 推導：網站沒有 home_views（目前 /jranv 就是 0 筆）時的預設首頁＝原站 /jranv 擷取的區塊：
 * 「區塊1」內有 CONTENT「近期文章」＋ POST「最新文章」（最新 4 篇，日期＋標題＋內文前 180 字＋閱讀更多）。
 */
async function defaultSections(site: WebSite): Promise<HvSectionView[]> {
  const base = { hidden: false, colClass: "col-md-12", style: 1, image: "", link: null };
  return [
    {
      id: 0,
      title: "區塊1",
      hidden: false,
      html: null,
      items: [
        { ...base, id: 0, category: "CONTENT", categoryClass: "content", title: "近期文章", isContent: true, isPost: false, posts: [] },
        {
          ...base,
          id: 0,
          category: "POST",
          categoryClass: "post",
          title: "最新文章",
          isContent: false,
          isPost: true,
          posts: await homePostCards(site, 4),
        },
      ],
    },
  ];
}

/** /{短網址}（render=HOME）：官網首頁。由 pages-form.ts 的 /:shortUrl 路由呼叫。 */
export async function renderHomePage(ctx: RequestContext, groupBuy: SfGroupBuy): Promise<Response> {
  if (groupBuy.render !== "HOME") return sellerNotFound(ctx);
  const tenant = await tenantById(groupBuy.tenant_id);
  if (!tenant) return sellerNotFound(ctx);
  const site = await loadWebSite(tenant, groupBuy);
  const hv = site.homeView;
  const cfg = site.config;
  const sections = hv ? (hv.html ? [] : await homeSections(site, hv.id)) : await defaultSections(site);
  const seoTitle = typeof cfg.seoTitle === "string" && cfg.seoTitle.trim() ? cfg.seoTitle.trim() : "";
  return page("storefront/web/home.html", {
    ...webVars(ctx, { tenant, site }),
    pageTitle: seoTitle || hv?.title || groupBuy.short_title || groupBuy.title,
    seoDescr: typeof cfg.seoDescr === "string" ? cfg.seoDescr : "",
    seoImage: imageUrl(typeof cfg.seoImage === "string" ? cfg.seoImage : "") || (safeHref(String(cfg.seoImageUrl ?? "")) ?? ""),
    noIndex: cfg.robots === true,
    home: { id: hv?.id ?? 0, html: hv?.html && hv.html.trim() ? hv.html : null, sections },
  });
}

// ───────────────────────── 文章列表（選單／分類／標籤／搜尋） ─────────────────────────

interface ListOpts {
  title: string;
  /** 分頁連結的基底網址 */
  baseHref: string;
  rows: PostRow[];
  total: number;
  page: number;
  n: number;
  keyword?: string;
  emptyText: string;
}

async function renderPostList(ctx: RequestContext, site: WebSite, o: ListOpts): Promise<Response> {
  const [titles, tags] = await Promise.all([
    nodeTitles(
      site,
      o.rows.map((r) => r.web_menu_node_id).filter((x): x is number => x !== null),
    ),
    siteTags(site),
  ]);
  const totalPages = Math.ceil(o.total / o.n);
  return page("storefront/web/post-list.html", {
    ...webVars(ctx, { tenant: site.tenant, site }),
    slideOutHideMd: true,
    pageTitle: o.title,
    listTitle: o.title,
    searchKeyword: o.keyword ?? "",
    tags,
    posts: o.rows.map((r) => postCard(site, r, titles, "datetime")),
    emptyText: o.emptyText,
    pagination: o.total > 0 ? paginationView(o.baseHref, o.page, totalPages, o.n) : [],
  });
}

/** /{短網址}/menu/{節點id}/{標題}：該選單節點（含子節點）的文章，例 /jranv/menu/4411/所有教學 */
async function menuPage(ctx: RequestContext, kind: "menu" | "category"): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const nodeId = parseId(kind === "menu" ? ctx.params.menuId : ctx.params.id);
  if (nodeId === null) return sellerNotFound(ctx);
  const found = await findMenuNode(site, nodeId);
  if (!found) return sellerNotFound(ctx);
  const { page: p, n } = parsePaging(ctx);
  const { rows, total } = await queryPosts(site, { nodeIds: descendantIds(found.rows, nodeId), page: p, n });
  const baseHref = kind === "menu" ? menuHref(site.short, nodeId, found.node.title) : categoryHref(site.short, nodeId, found.node.title);
  return renderPostList(ctx, site, { title: found.node.title, baseHref, rows, total, page: p, n, emptyText: "目前沒有文章" });
}

/** /{短網址}/post/tag/{標籤} */
async function tagPage(ctx: RequestContext): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const tag = cleanKeyword(ctx.params.tag);
  if (!tag || tag !== String(ctx.params.tag ?? "").trim()) return sellerNotFound(ctx);
  const { page: p, n } = parsePaging(ctx);
  const { rows, total } = await queryPostsByTag(site, tag, p, n);
  return renderPostList(ctx, site, { title: tag, baseHref: tagHref(site.short, tag), rows, total, page: p, n, emptyText: "目前沒有文章" });
}

/** /{短網址}/posts?t=關鍵字（文章搜尋框按 Enter／搜尋鈕；原站 JS 用參數 t，另接受 keyword） */
async function searchPage(ctx: RequestContext): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const keyword = cleanKeyword(ctx.query.get("t") ?? ctx.query.get("keyword"));
  const { page: p, n } = parsePaging(ctx);
  const { rows, total } = await queryPosts(site, { keyword: keyword || undefined, page: p, n });
  const qs = keyword ? `?t=${encodeURIComponent(keyword)}` : "";
  return renderPostList(ctx, site, {
    title: keyword ? `「${keyword}」的搜尋結果` : "所有文章",
    baseHref: `/${site.short}/posts${qs}`,
    rows,
    total,
    page: p,
    n,
    keyword,
    emptyText: "查無符合的文章",
  });
}

// ───────────────────────── 文章內頁 ─────────────────────────

/** /{短網址}/post/{id}/{標題}：原站未擷取，依同版面推導（標題、日期、分類、內文、標籤） */
/**
 * 限閱文章（後台 Post「文章類型」＝PREMIUM）：需登入會員；有填「限閱會員等級」時，會員所屬方案（royalty_program_id 或方案名稱）
 * 須在逗號分隔清單內。推導：原站前台限閱畫面未擷取，未通過時只顯示摘要＋登入提示。
 */
async function premiumAllowed(ctx: RequestContext, tenantId: number, row: { post_type?: string | null; access_level?: string | null }): Promise<boolean> {
  if (row.post_type !== "PREMIUM") return true;
  const cs = await readCustomerSession(ctx, tenantId);
  if (!cs) return false;
  const levels = String(row.access_level ?? "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!levels.length) return true;
  const rpId = cs.customer.royalty_program_id;
  if (rpId === null) return false;
  if (levels.includes(String(rpId))) return true;
  const { data } = await getServiceClient().from("royalty_programs").select("title").eq("tenant_id", tenantId).eq("id", rpId).maybeSingle();
  const title = String((data as { title?: string } | null)?.title ?? "");
  return !!title && levels.includes(title);
}

function premiumLockedHtml(row: { summary: string | null }): string {
  const summary = row.summary ? `<p>${escapeHtml(row.summary)}</p>` : "";
  return `${summary}<div class="alert alert-warning text-center my-4"><i class="fa-solid fa-lock mr-2"></i>此為限閱文章，請先登入符合資格的會員後再閱讀。</div>`;
}

async function postPage(ctx: RequestContext): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const postId = parseId(ctx.params.postId);
  if (postId === null) return sellerNotFound(ctx);
  const row = await findPost(site, postId);
  if (!row) return sellerNotFound(ctx);
  const titles = await nodeTitles(site, row.web_menu_node_id !== null ? [row.web_menu_node_id] : []);
  const card = postCard(site, row, titles, "datetime");
  return page("storefront/web/post.html", {
    ...webVars(ctx, { tenant: site.tenant, site }),
    slideOutHideMd: true,
    pageTitle: row.title,
    seoDescr: row.summary ?? "",
    searchKeyword: "",
    post: {
      ...card,
      // 內文是網站管理員以編輯器撰寫的 HTML，與原站一樣原樣輸出
      body: (await premiumAllowed(ctx, site.tenant.id, row)) ? row.body ?? "" : premiumLockedHtml(row),
      tags: parseTags(row.tags).map((name) => ({ name, href: tagHref(site.short, name) })),
    },
  });
}

// ───────────────────────── 文章即時搜尋 JSON ─────────────────────────

/**
 * GET {GBF.baseUrl}/ajax/web/Post/lookup.do?keyword=…（/groupbuyforms/p/jranv/ajax/web/Post/lookup.do）
 * 回應 `{ data: [{ id, text, url }] }`：原站 fe-help-menu-4411 內嵌 script 讀 data.data[].text / .url，並把 text 當 HTML 串進選單 → text 先做 HTML escape。
 */
async function postLookup(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  if (!groupBuy || groupBuy.render !== "HOME") return json({ data: [] });
  const keyword = cleanKeyword(await ctx.param("keyword"));
  if (!keyword) return json({ data: [] });
  const site = await loadWebSite(tenant, groupBuy);
  const rows = await lookupPosts(site, keyword);
  return json({ data: rows.map((r) => ({ id: r.id, text: escapeHtml(r.title), url: postHref(site.short, r.id, r.title) })) });
}

// ───────────────────────── 最新公告 ─────────────────────────

interface NewsRow {
  id: number;
  title: string;
  body: string | null;
  is_pinned: boolean;
  date_published: string;
}

async function queryNews(tenantId: number, groupBuyId: number | null, limit: number, pinnedFirst: boolean): Promise<NewsRow[]> {
  let q = db().from("news").select("id, title, body, is_pinned, date_published").eq("tenant_id", tenantId);
  // news 同表也存官網「常見問題」（tag=FAQ，groupbuy 模組 News/list?tag=FAQ）；最新公告只取 NEWS 或未標記
  q = q.or("tag.is.null,tag.eq.NEWS,tag.eq.");
  if (groupBuyId !== null) q = q.or(`group_buy_id.eq.${groupBuyId},group_buy_id.is.null`);
  if (pinnedFirst) q = q.order("is_pinned", { ascending: false });
  const { data, error } = await q.order("date_published", { ascending: false }).order("id", { ascending: false }).limit(limit);
  if (error) throw new Error(`查詢最新公告失敗：${error.message}`);
  return (data ?? []) as NewsRow[];
}

function newsView(rows: NewsRow[]) {
  // 內文是平台／網站管理員撰寫的 HTML，與原站一樣原樣輸出
  return rows.map((r) => ({ id: r.id, title: r.title, date: taipeiDate(r.date_published).replace(/-/g, "/"), body: r.body ?? "" }));
}

/**
 * /{租戶}/News/list.do?gid={團購id}：系統最新公告（原站沒有網站導覽列與頁尾）。
 * 租戶取自網址前綴（沒有前綴時＝平台租戶）；gid 必須是該租戶的團購，公告範圍＝該租戶（gid 有給時限該團購＋租戶共用）。
 */
async function newsListPage(ctx: RequestContext): Promise<Response> {
  const tenant = ctx.tenantPrefix ? await tenantByCode(ctx.tenantPrefix) : await tenantByCode(PLATFORM_TENANT_CODE);
  if (!tenant) return sellerNotFound(ctx);
  const gidRaw = ctx.query.get("gid");
  let gid: number | null = null;
  if (gidRaw !== null && gidRaw !== "") {
    gid = parseId(gidRaw);
    if (gid === null) return sellerNotFound(ctx);
    const { data, error } = await db().from("group_buys").select("id").eq("tenant_id", tenant.id).eq("id", gid).maybeSingle();
    if (error) throw new Error(`查詢團購失敗：${error.message}`);
    if (!data) return sellerNotFound(ctx);
  }
  const rows = await queryNews(tenant.id, gid, 200, true);
  return page("storefront/web/news-list.html", { ...webVars(ctx, { tenant, site: null }), news: newsView(rows) });
}

/** /{短網址}/news：網站側欄「最新公告」連結（原站未擷取，推導＝同公告列表、套網站導覽列與頁尾） */
/**
 * /{短網址}/faq：官網「常見問題」（後台 News/list?tag=FAQ 管理；推導：原站前台 FAQ 頁網址與版面未擷取，沿用最新消息的手風琴版面）。
 * 依排序（seq）小到大，再依標題前綴分類。
 */
async function siteFaqPage(ctx: RequestContext): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const { data, error } = await db()
    .from("news")
    .select("id, title, body, is_pinned, date_published, seq, categories")
    .eq("tenant_id", site.tenant.id)
    .eq("tag", "FAQ")
    .or(`group_buy_id.eq.${site.groupBuy.id},group_buy_id.is.null`)
    .order("seq", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) throw new Error(`查詢常見問題失敗：${error.message}`);
  const rows = (data ?? []) as (NewsRow & { categories?: string[] | null })[];
  const news = rows.map((r) => {
    const cats = Array.isArray(r.categories) ? r.categories.filter(Boolean) : [];
    return { id: r.id, title: cats.length ? `【${cats.join("／")}】${r.title}` : r.title, date: "", body: r.body ?? "" };
  });
  return page("storefront/web/news-list.html", { ...webVars(ctx, { tenant: site.tenant, site }), news, listTitle: "常見問題" });
}

async function siteNewsPage(ctx: RequestContext): Promise<Response> {
  const site = await siteByShortUrl(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const rows = await queryNews(site.tenant.id, site.groupBuy.id, 200, true);
  return page("storefront/web/news-list.html", { ...webVars(ctx, { tenant: site.tenant, site }), news: newsView(rows) });
}

/** 後台頂列「系統公告」（ModuleDef.news）：平台租戶的公告，依發布日新到舊，最多 10 則 */
export async function adminNews(): Promise<AdminNewsItem[]> {
  const platform = await tenantByCode(PLATFORM_TENANT_CODE);
  if (!platform) return [];
  const rows = await queryNews(platform.id, null, 10, false);
  return rows.map((r) => ({ datePublishedString: taipeiDateTime(r.date_published), title: r.title, descr: r.body ?? "" }));
}

// ───────────────────────── 403 ─────────────────────────

/** 錯誤追蹤代碼：ERR- + 8 碼大寫十六進位（每次隨機） */
export function newErrorCode(): string {
  return `ERR-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** 原站 /ak98i?preview=true 未具預覽權限時的「系統提示」頁（HTTP 403）。由 form-page.ts 的預覽檢查呼叫。 */
export async function renderError403(ctx: RequestContext, tenant: SfTenant): Promise<Response> {
  return page(
    "storefront/web/error-403.html",
    { ...webVars(ctx, { tenant, site: null }), contactFab: true, errorCode: newErrorCode() },
    403,
  );
}

// ───────────────────────── 路由 ─────────────────────────

const SITE = { auth: "public" as const, priority: 1000 };

export const helpRoutes: RouteDef[] = [
  get("/:shortUrl/menu/:menuId/:title", (ctx) => menuPage(ctx, "menu"), SITE),
  get("/:shortUrl/menu/:menuId", (ctx) => menuPage(ctx, "menu"), SITE),
  get("/:shortUrl/postcategory/:id/:title", (ctx) => menuPage(ctx, "category"), SITE),
  get("/:shortUrl/postcategory/:id", (ctx) => menuPage(ctx, "category"), SITE),
  get("/:shortUrl/post/tag/:tag", tagPage, SITE),
  get("/:shortUrl/post/:postId/:title", postPage, SITE),
  get("/:shortUrl/post/:postId", postPage, SITE),
  get("/:shortUrl/news", siteNewsPage, SITE),
  get("/:shortUrl/faq", siteFaqPage, SITE),
  get("/:shortUrl/posts", searchPage, SITE),
  get("/News/list", newsListPage, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/Post/lookup", postLookup, { auth: "public" }),
];
