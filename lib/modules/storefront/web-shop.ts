// 官網型商城頁（render=HOME 的團購網站；推導）：商品頁、商品列表（全部／指定品項／系統標籤／搜尋）、客製化網頁、會員、購物袋，
// 以及官網共用 script（templates/storefront/partials/web-foot-scripts.html，原站 gbfshopping.js）呼叫的
// `/ajax/web/Item/getItem`（切換規格）、`/ajax/web/Item/show`（商品彈窗）。
//
// 推導依據：原站帳號沒有官網型團購（spec/GAP_SPEC.md §5、spec/SPEC.md §9 #7），商城頁 HTML 未擷取。
// 只能依原站官網共用 script 反推頁面需要的 DOM 與 JSON：
//   - 商品區 section#productDetail-{itemId}，內含 orderItems[0].itemId／groupBuyItemSetId／total／tagN 欄位，.item-title／.item-price…，
//     .btn-addShoppingCart／.btn-buynow（$.ShoppingItem）；
//   - getItem 回 { data: 商品（itemSettings.carousels、formattedPrice、calculatedMaxOrderQuota、tab1Title…、publishUrl）, tagOptions, imageOptions }；
//   - 「立即購買」與購物袋「Check Out」連到 /{短網址}/bag（goCheckoutPage）。
// 購物袋／結帳沿用團購表單同一套後端（cart-api.ts、order-place.ts、gb_checkout_form.js），價格與庫存一律伺服器端重算。
// 所有查詢以短網址解析出的團購 tenant_id／group_buy_id 過濾。
import { get, any } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, json, redirect } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { getServiceClient } from "@/lib/supabase/server";
import { sellerNotFound } from "./pages-static";
import { groupBuyByShortUrl, imageUrl, scopeFromTenantPath, tenantById, type SfGroupBuy } from "./site";
import { loadCatalog, formatPrice, type Catalog, type CatalogItem } from "./catalog";
import { renderFormPage } from "./form-page";
import {
  cleanKeyword,
  itemHref,
  itemSetHref,
  loadWebSite,
  parseId,
  webVars,
  type WebSite,
} from "./web-site";
import { renderCustomWebPage } from "./help";
import { oosTagsOf, pickVariant, segs, tagName, tagOptionsOf, variantsOf } from "./shop-variants";
import { clean } from "./guard";

const db = () => getServiceClient();
const MAX_QTY = 200;
const LIST_MAX = 200;

// ───────────────────────── 網站解析 ─────────────────────────

async function homeSite(shortUrl: string | undefined): Promise<WebSite | null> {
  const gb = await groupBuyByShortUrl(shortUrl);
  if (!gb || gb.render !== "HOME") return null;
  const tenant = await tenantById(gb.tenant_id);
  if (!tenant) return null;
  return loadWebSite(tenant, gb);
}

function page(template: string, vars: Record<string, unknown>, status = 200): Response {
  return html(renderTemplate(template, vars), { status });
}

// ───────────────────────── 商品資料 ─────────────────────────

function carouselsOf(it: CatalogItem): string[] {
  const raw = it.itemSettings?.carousels;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((x) => imageUrl(String(x ?? ""))).filter(Boolean).slice(0, 10);
}

function tabsOf(it: CatalogItem): { n: number; title: string; descr: string }[] {
  const tabs = it.tabs.filter((t) => t.descr && t.descr.trim());
  if (tabs.length) return tabs;
  const notice = String(it.itemSettings?.noticeDescr ?? "").trim();
  return notice ? [{ n: 1, title: "商品說明", descr: notice }] : [];
}

/** 原站 getItem 的 data（$.ShoppingItem.render 讀的鍵） */
export function itemJson(gb: SfGroupBuy, short: string, it: CatalogItem, oosTags: string[]): Record<string, unknown> {
  const tab = (n: number) => tabsOf(it).find((t) => t.n === n);
  const quota = Math.max(0, it.calculatedMaxOrderQuota);
  return {
    itemId: it.itemId,
    groupBuyItemSetId: it.groupBuyItemSetId,
    title: it.shortNameDisplay?.trim() || it.title,
    tag: it.tag ?? null,
    uid: it.uid ?? "",
    itemSettings: {
      subtitle: String(it.itemSettings?.subtitle ?? ""),
      shortDescr1: String(it.itemSettings?.shortDescr1 ?? ""),
      carousels: carouselsOf(it),
    },
    imageUrl: imageUrl(it.image, "/upload/images/unsort/logo.png"),
    price: it.price,
    formattedPrice: formatPrice(it.price, gb.currency),
    retailPrice: it.retailPrice ?? 0,
    formattedRetailPrice: it.retailPrice ? formatPrice(it.retailPrice, gb.currency) : "",
    priceTagForDisplay: String(it.itemSettings?.priceTagForDisplay ?? ""),
    oosTags,
    gift: it.itemType === "GIFT",
    giftPickable: false,
    calculatedMaxOrderQuota: quota,
    maxOrderQuota: Math.min(quota, MAX_QTY),
    stockAvailable: Math.max(0, it.stockAvailable),
    stockBackOrderAvailable: Math.max(0, it.stockBackOrderAvailable),
    theme: it.theme ?? {},
    tab1Title: tab(1)?.title ?? "",
    tab1Descr: tab(1)?.descr ?? "",
    tab2Title: tab(2)?.title ?? "",
    tab2Descr: tab(2)?.descr ?? "",
    tab3Title: tab(3)?.title ?? "",
    tab3Descr: tab(3)?.descr ?? "",
    publishUrl: itemHref(short, it.itemId, it.shortNameDisplay?.trim() || it.title),
  };
}

/** 商品頁／彈窗的模板資料 */
function productView(site: WebSite, catalog: Catalog, it: CatalogItem) {
  const gb = site.groupBuy;
  const variants = variantsOf(catalog, it);
  const options = tagOptionsOf(variants);
  const cur = segs(it.tag);
  const oos = oosTagsOf(variants, it);
  const images = carouselsOf(it);
  if (!images.length) images.push(imageUrl(it.image, "/upload/images/unsort/logo.png"));
  const quota = Math.min(Math.max(0, it.calculatedMaxOrderQuota), MAX_QTY);
  const tabs = tabsOf(it);
  const set = catalog.itemSets.find((s) => s.groupBuyItemSetId === it.groupBuyItemSetId);
  const j = itemJson(gb, site.short, it, oos);
  return {
    itemId: it.itemId,
    groupBuyItemSetId: it.groupBuyItemSetId,
    title: j.title,
    subtitle: (j.itemSettings as { subtitle: string }).subtitle,
    shortDescr1: (j.itemSettings as { shortDescr1: string }).shortDescr1,
    uid: it.uid ?? "",
    priceText: j.formattedPrice,
    retailPriceText: j.formattedRetailPrice,
    priceTagForDisplay: j.priceTagForDisplay,
    price: it.price,
    images: images.map((url, i) => ({ url, idx: i, active: i === 0 })),
    multiImage: images.length > 1,
    tagGroups: options.map((opts, k) => ({
      name: `orderItems[0].tag${k}`,
      label: `規格${options.length > 1 ? k + 1 : ""}`,
      options: opts.map((raw) => ({
        value: raw,
        name: tagName(raw) + (oos.includes(raw) ? "(已售完)" : ""),
        selected: cur[k] === raw,
        disabled: oos.includes(raw),
      })),
    })),
    soldOut: quota <= 0,
    backOrder: it.stockAvailable <= 0 && it.stockBackOrderAvailable > 0,
    qtyOptions: Array.from({ length: quota }, (_, i) => i + 1),
    tabs: tabs.map((t, i) => ({ id: `tab-${it.itemId}-${t.n}`, title: t.title, descr: t.descr, active: i === 0 })),
    itemSet: set ? { title: set.title, href: itemSetHref(site.short, set.groupBuyItemSetId, set.title) } : null,
    checkoutable: gb.checkoutable !== false,
  };
}

/** 列表卡片：同一品項的多規格商品只出一張卡（取第一個） */
function productCards(site: WebSite, items: CatalogItem[]) {
  const seen = new Set<string>();
  const cards = [];
  for (const it of items) {
    if (it.itemType === "GIFT") continue;
    if (it.tag) {
      const key = `${it.groupBuyItemSetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const title = it.shortNameDisplay?.trim() || it.title;
    cards.push({
      itemId: it.itemId,
      groupBuyItemSetId: it.groupBuyItemSetId,
      title,
      href: itemHref(site.short, it.itemId, title),
      image: imageUrl(it.image, "/upload/images/unsort/logo.png"),
      priceText: formatPrice(it.price, site.groupBuy.currency),
      retailPriceText: it.retailPrice && it.retailPrice > it.price ? formatPrice(it.retailPrice, site.groupBuy.currency) : "",
      soldOut: it.calculatedMaxOrderQuota <= 0,
      hasVariants: !!it.tag,
    });
    if (cards.length >= LIST_MAX) break;
  }
  return cards;
}

// ───────────────────────── 頁面 ─────────────────────────

/** /{短網址}/item/{商品id}/{標題}：商品頁 */
async function itemPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const itemId = parseId(ctx.params.itemId);
  if (itemId === null) return sellerNotFound(ctx);
  const catalog = await loadCatalog(site.tenant.id, site.groupBuy.id);
  const it = catalog.byId.get(itemId);
  if (!it || it.offline) return sellerNotFound(ctx);
  const product = productView(site, catalog, it);
  const related = productCards(
    site,
    catalog.items.filter((x) => x.groupBuyItemSetId === it.groupBuyItemSetId && x.itemId !== it.itemId && !(it.tag && x.tag)),
  ).slice(0, 8);
  return page("storefront/web/item.html", {
    ...webVars(ctx, { tenant: site.tenant, site }),
    pageTitle: product.title,
    seoDescr: product.shortDescr1 || product.subtitle || "",
    seoImage: product.images[0]?.url ?? "",
    product,
    related,
  });
}

interface ListOpts {
  title: string;
  items: CatalogItem[];
  keyword?: string;
  emptyText?: string;
}

function renderItemList(ctx: RequestContext, site: WebSite, o: ListOpts): Response {
  return page("storefront/web/item-list.html", {
    ...webVars(ctx, { tenant: site.tenant, site }),
    pageTitle: o.title,
    listTitle: o.title,
    searchKeyword: o.keyword ?? "",
    cards: productCards(site, o.items),
    emptyText: o.emptyText ?? "目前沒有商品",
  });
}

/** /{短網址}/items：全部商品 */
async function allItemsPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const catalog = await loadCatalog(site.tenant.id, site.groupBuy.id);
  return renderItemList(ctx, site, { title: "全部商品", items: catalog.items.filter((x) => !x.offline) });
}

/** /{短網址}/itemset/{團購品項id}/{標題}：連結類別「品項(指定)」ITEM_SET */
async function itemSetPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const gbisId = parseId(ctx.params.id);
  if (gbisId === null) return sellerNotFound(ctx);
  const catalog = await loadCatalog(site.tenant.id, site.groupBuy.id);
  const set = catalog.itemSets.find((s) => s.groupBuyItemSetId === gbisId);
  if (!set) return sellerNotFound(ctx);
  return renderItemList(ctx, site, { title: set.title || "商品", items: catalog.items.filter((x) => x.groupBuyItemSetId === gbisId && !x.offline) });
}

/**
 * /{短網址}/systag/{系統標籤id}/{標題}：連結類別「指定系統標籤」ITEM_SYS。
 * 系統標籤（group_buy_item_sys_tags，本團購）的 category＝商品 items.sys_tags 陣列內的代碼（HOT／NEW／SALE…）。
 */
async function sysTagPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) return sellerNotFound(ctx);
  const { data, error } = await db()
    .from("group_buy_item_sys_tags")
    .select("id, category, tag, display_name")
    .eq("tenant_id", site.tenant.id)
    .eq("group_buy_id", site.groupBuy.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`查詢系統標籤失敗：${error.message}`);
  const row = data as { category: string | null; tag: string | null; display_name: string | null } | null;
  if (!row) return sellerNotFound(ctx);
  const catalog = await loadCatalog(site.tenant.id, site.groupBuy.id);
  const ids = catalog.items.map((x) => x.itemId);
  const codes = [row.category, row.tag].filter((x): x is string => !!x);
  let hit = new Set<number>();
  if (ids.length && codes.length) {
    const { data: rows, error: e2 } = await db().from("items").select("id, sys_tags").eq("tenant_id", site.tenant.id).in("id", ids);
    if (e2) throw new Error(`查詢商品標籤失敗：${e2.message}`);
    hit = new Set(
      ((rows ?? []) as { id: number; sys_tags: unknown }[])
        .filter((r) => Array.isArray(r.sys_tags) && (r.sys_tags as unknown[]).some((t) => codes.includes(String(t))))
        .map((r) => r.id),
    );
  }
  return renderItemList(ctx, site, {
    title: row.display_name || row.tag || "商品",
    items: catalog.items.filter((x) => hit.has(x.itemId) && !x.offline),
  });
}

/** /{短網址}/search?t=：導覽列搜尋（商品名稱；網站沒有商品時轉文章搜尋） */
async function searchPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const keyword = cleanKeyword(ctx.query.get("t") ?? ctx.query.get("keyword"));
  const catalog = await loadCatalog(site.tenant.id, site.groupBuy.id);
  if (!catalog.items.length) return redirect(`/${site.short}/posts${keyword ? `?t=${encodeURIComponent(keyword)}` : ""}`, 302);
  const kw = keyword.toLowerCase();
  const items = kw
    ? catalog.items.filter((x) => !x.offline && `${x.title} ${x.shortNameDisplay ?? ""} ${x.itemSettings?.subtitle ?? ""}`.toLowerCase().includes(kw))
    : catalog.items.filter((x) => !x.offline);
  return renderItemList(ctx, site, {
    title: keyword ? `「${keyword}」的搜尋結果` : "全部商品",
    items,
    keyword,
    emptyText: "查無符合的商品",
  });
}

/** /{短網址}/page/{官網頁面id}/{標題}：連結類別「客製化網頁」CUSTOM_WEB（HomeView 類別 CUSTOM） */
async function customWebPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) return sellerNotFound(ctx);
  return renderCustomWebPage(ctx, site, id);
}

/** /{短網址}/member：連結類別「會員」MEMBER → 會員中心（未登入時會員中心顯示登入提示） */
async function memberPage(ctx: RequestContext): Promise<Response> {
  const site = await homeSite(ctx.params.shortUrl);
  if (!site) return sellerNotFound(ctx);
  return redirect(`/${site.tenant.code}/p/${site.short}/Customer/show.do`, 302);
}

/**
 * /{短網址}/bag：購物袋／結帳頁。官網型＝團購表單同一套結帳表單（只列購物袋內商品）；
 * 其他發布樣式的購物袋就是下單頁本身 → 轉回 /{短網址}；倉儲／POS 沒有購物袋 → 404。
 */
async function bagPage(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb || gb.render === "WH" || gb.render === "POS") return sellerNotFound(ctx);
  if (gb.render !== "HOME") return redirect(`/${gb.short_url}`, 302);
  return renderFormPage(ctx, gb, { bag: true });
}

// ───────────────────────── AJAX ─────────────────────────

async function homeScope(ctx: RequestContext): Promise<{ site: WebSite; catalog: Catalog } | null> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  if (!groupBuy || groupBuy.render !== "HOME") return null;
  const site = await loadWebSite(tenant, groupBuy);
  return { site, catalog: await loadCatalog(tenant.id, groupBuy.id) };
}

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
};

/**
 * POST {baseUrl}/ajax/web/Item/getItem.do：data[0]={name, selectedTag, idx, itemId, groupBuyItemSetId, tag0…tag9}
 * → { data: 商品, tagOptions, imageOptions }（$.ShoppingItem.onItemFetched）。
 */
async function getItem(ctx: RequestContext): Promise<Response> {
  const sc = await homeScope(ctx);
  if (!sc) return json({ data: null, tagOptions: [], imageOptions: {} }, { status: 404 });
  const b = await ctx.body();
  const d0 = (b.nested.data as Record<string, unknown> | undefined)?.["0"];
  const d = (d0 && typeof d0 === "object" ? d0 : {}) as Record<string, unknown>;
  const cur = sc.catalog.byId.get(int(d.itemId));
  if (!cur || cur.offline) return json({ data: null, tagOptions: [], imageOptions: {} }, { status: 404 });
  const variants = variantsOf(sc.catalog, cur);
  const chosen: string[] = [];
  for (let k = 0; k < 10; k++) {
    const v = d[`tag${k}`];
    if (v === undefined) break;
    chosen.push(clean(String(v ?? ""), 100, "規格"));
  }
  const idx = Math.min(Math.max(int(d.idx), 0), 9);
  const pick = pickVariant(variants, chosen, idx, cur);
  return json({
    data: itemJson(sc.site.groupBuy, sc.site.short, pick, oosTagsOf(variants, pick)),
    tagOptions: tagOptionsOf(variants),
    imageOptions: {},
  });
}

/** GET {baseUrl}/ajax/web/Item/show.do?itemId=：商品彈窗（openShoppingItemModal → openForm(..., 'no-header')） */
async function showItem(ctx: RequestContext): Promise<Response> {
  const sc = await homeScope(ctx);
  if (!sc) return html("", { status: 404 });
  const it = sc.catalog.byId.get(int(ctx.query.get("itemId")));
  if (!it || it.offline) return html('<div class="modal-body text-center py-5">找不到商品或商品已下架</div>', { status: 404 });
  return html(
    renderTemplate("storefront/web/item-modal.html", {
      ...webVars(ctx, { tenant: sc.site.tenant, site: sc.site }),
      product: productView(sc.site, sc.catalog, it),
      productHref: itemHref(sc.site.short, it.itemId, it.shortNameDisplay?.trim() || it.title),
    }),
  );
}

// ───────────────────────── 路由 ─────────────────────────

const SITE = { auth: "public" as const, priority: 1000 };

export const webShopRoutes: RouteDef[] = [
  get("/:shortUrl/item/:itemId/:title", itemPage, SITE),
  get("/:shortUrl/item/:itemId", itemPage, SITE),
  get("/:shortUrl/items", allItemsPage, SITE),
  get("/:shortUrl/itemset/:id/:title", itemSetPage, SITE),
  get("/:shortUrl/itemset/:id", itemSetPage, SITE),
  get("/:shortUrl/systag/:id/:title", sysTagPage, SITE),
  get("/:shortUrl/systag/:id", sysTagPage, SITE),
  get("/:shortUrl/page/:id/:title", customWebPage, SITE),
  get("/:shortUrl/page/:id", customWebPage, SITE),
  get("/:shortUrl/search", searchPage, SITE),
  get("/:shortUrl/member", memberPage, SITE),
  get("/:shortUrl/bag", bagPage, SITE),
  any("/p/:shortUrl/ajax/web/Item/getItem", getItem, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/Item/show", showItem, { auth: "public" }),
];

