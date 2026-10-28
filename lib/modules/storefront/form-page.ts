// 團購表單下單頁（fe-form-ak98i）：/{shortUrl}
// 伺服器輸出品項/商品卡（與原站 server 端 HTML 相同），購物袋與結帳表單由原站前端 JS（gb_shopping_cart / gbs_v6 / gb_checkout_form）
// 透過 /ajax/web/ShoppingCart/* 動態產生。
import type { RequestContext } from "@/lib/core/http/types";
import { html } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { readSession } from "@/lib/core/auth/session";
import { feVars, gbSetting, groupBuyPreferences, imageUrl, tenantById, type SfGroupBuy } from "./site";
import { readCustomerSession } from "./customer-session";
import { loadCatalog, formatPrice, type CatalogItem, type CatalogItemSet } from "./catalog";
import { cartItems, findCart } from "./cart-store";
import { getServiceClient } from "@/lib/supabase/server";
import { loadGroupBuyShippingRules, pointsEnabled } from "./pricing";
import { uiLang } from "./i18n";
import { eventDateOf, renderStyleOf, TRAVEL_GROUP } from "./render-style";

/** 商品樣式 → 卡片欄寬與樣式 class（STYLE5＝原站擷取值；其餘依樣式名稱推導） */
const STYLE_LAYOUT: Record<string, { col: string; card: string }> = {
  STYLE1: { col: "col-12", card: "card-item-style-1" },
  STYLE2: { col: "col-12", card: "card-item-style-2" },
  STYLE3: { col: "col-6 col-md-3", card: "card-item-style-3" },
  STYLE31: { col: "col-4", card: "card-item-style-3" },
  STYLE32: { col: "col-6", card: "card-item-style-3" },
  STYLE4: { col: "col-6 col-md-3", card: "card-item-style-4" },
  STYLE5: { col: "col-6", card: "card-item-style-4" },
  STYLE6: { col: "col-4", card: "card-item-style-4" },
  STYLE7: { col: "col-6", card: "card-item-style-7" },
  STYLE8: { col: "col-6", card: "card-item-style-8" },
  // 推導：套裝行程類（STYLE9＝套裝行程方案、TRAVEL_*＝飯店／去回程票卷／加購）一律整列顯示，方便比較方案
  STYLE9: { col: "col-12", card: "card-item-style-1" },
  TRAVEL_HOTEL: { col: "col-12", card: "card-item-style-1" },
  TRAVEL_AIR_TICKET_DEPARTURE: { col: "col-12", card: "card-item-style-1" },
  TRAVEL_AIR_TICKET_RETURN: { col: "col-12", card: "card-item-style-1" },
  TRAVEL_ADDITIONAL: { col: "col-12", card: "card-item-style-1" },
};

const n = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "null" : v);

export function itemInfoAvailable(it: CatalogItem): boolean {
  const s = it.itemSettings ?? {};
  return it.tabs.length > 0 || !!String(s.noticeDescr ?? "").trim() || !!String(s.shortDescr1 ?? "").trim();
}

function lightboxPath(url: string): string {
  // /upload/images/vcf/ee/576/x.jpg → vcf/ee/ori/x.jpg（原站燈箱用原圖）
  const rel = url.replace(/^\/upload\/images\//, "");
  return rel.replace(/\/576\//, "/ori/");
}

/** 預覽權限不足的 403 頁（說明中心版面，由 help.ts 提供；接上前先回簡單 403） */
let previewForbidden: (ctx: RequestContext, tenant: { id: number; code: string; name: string | null }) => Promise<Response> | Response = () =>
  html("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>403 - 系統提示</title></head><body>403</body></html>", { status: 403 });
export function setPreviewForbiddenRenderer(fn: typeof previewForbidden): void {
  previewForbidden = fn;
}

export interface FormPageState {
  started: boolean;
  ended: boolean;
  preview: boolean;
}

export function groupBuyState(gb: SfGroupBuy, now = Date.now()): { started: boolean; ended: boolean } {
  const s = gb.date_start ? new Date(gb.date_start).getTime() : 0;
  const e = gb.date_end ? new Date(gb.date_end).getTime() : Number.MAX_SAFE_INTEGER;
  return { started: now >= s, ended: now > e };
}

export interface FormPageOpts {
  /** 官網型（render=HOME）的購物袋／結帳頁 /{短網址}/bag：品項區只列購物袋內的商品（web-shop.ts） */
  bag?: boolean;
}

export async function renderFormPage(ctx: RequestContext, gb: SfGroupBuy, opts: FormPageOpts = {}): Promise<Response> {
  const tenant = await tenantById(gb.tenant_id);
  if (!tenant) throw new Error("租戶不存在");
  const preview = ctx.query.get("preview") === "true";
  let adminPreview = false;
  if (preview) {
    const admin = await readSession(ctx.req);
    adminPreview = !!admin && admin.tenantId === gb.tenant_id;
    if (!adminPreview) return previewForbidden(ctx, tenant);
  }
  const customer = await readCustomerSession(ctx, tenant.id);
  const prefs = await groupBuyPreferences(tenant.id, gb.id);
  const outStock = prefs.THEME_OUTSTOCK_STYLE_OPTION?.value ?? "OUT_OF_STOCK";
  const catalog = await loadCatalog(tenant.id, gb.id);
  const priceLabel = gb.price_label?.trim() || "團購價";

  const style = renderStyleOf(gb);
  const cart = await findCart(ctx, tenant.id, gb.id);
  // 購物袋頁：購物袋內的商品數量（商品 id → 數量；組合商品明細由結帳摘要顯示）
  const inBag = new Map<number, number>();
  if (opts.bag && cart) for (const ci of await cartItems(tenant.id, cart.id)) if (!ci.item_bundle_id && ci.total > 0) inBag.set(ci.item_id, (inBag.get(ci.item_id) ?? 0) + ci.total);
  const sourceSets = opts.bag ? bagItemSets(catalog) : catalog.itemSets;

  let idx = 0;
  const itemSets = sourceSets.map((s: CatalogItemSet) => {
    const layout = style === "TYPE1" ? STYLE_LAYOUT.STYLE1 : (STYLE_LAYOUT[s.style] ?? STYLE_LAYOUT.STYLE5);
    const items =
      s.style === "DESCR"
        ? []
        : catalog.items
            .filter((it) => (opts.bag ? inBag.has(it.itemId) : it.itemSetId === s.itemSetId))
            .filter((it) => {
              // 組合商品（BUNDLE_V2）的庫存由子商品決定，選購視窗內顯示是否售完（#107）
              const soldOut = it.calculatedMaxOrderQuota <= 0 && it.itemType !== "BUNDLE_V2";
              if (!soldOut || opts.bag) return true;
              return !(outStock === "HIDDEN" || it.optionOfflineWhenSoldOut || s.optionOfflineWhenSoldOut);
            })
            .map((it) => {
              const img = imageUrl(it.image, "/upload/images/unsort/logo.png");
              const soldOut = it.calculatedMaxOrderQuota <= 0;
              const vm = {
                idx: idx++,
                itemId: it.itemId,
                itemSetId: it.itemSetId,
                groupBuyItemSetId: s.groupBuyItemSetId,
                title: it.shortNameDisplay?.trim() || it.title,
                subtitle: String(it.itemSettings?.subtitle ?? ""),
                infoAvailable: itemInfoAvailable(it),
                imageUrl: img,
                lightboxImg: lightboxPath(img),
                priceLabel,
                priceText: formatPrice(it.price, gb.currency),
                retailLabel: "原價",
                retailPriceText: it.retailPrice && it.retailPrice > 0 ? formatPrice(it.retailPrice, gb.currency) : "",
                options: Array.from({ length: Math.max(it.calculatedMaxOrderQuota, inBag.get(it.itemId) ?? 0) }, (_, i) => i + 1),
                selectedTotal: inBag.get(it.itemId) ?? null,
                soldOut: soldOut && !inBag.has(it.itemId),
                soldOutLabel: outStock === "BLANK" ? "" : "已售完",
                selectClass: it.stockAvailable <= 0 && it.stockBackOrderAvailable > 0 ? "backorder" : "normal",
                cardExtraClass: "null null null",
                discountLabelHtml: "",
                isBundle: it.itemType === "BUNDLE_V2",
              };
              return vm;
            });
    return {
      itemSetId: s.itemSetId,
      title: s.title,
      hideTitle: s.itemSetSettings?.hideTitle === true,
      quickGuideClass: `brown lighten-4 ${n(s.cssTitle)}`,
      sectionClass: n(s.css),
      cardClass: "null",
      titleClass: `brown lighten-4 ${n(s.cssTitle)} null`,
      bodyClass: "null",
      tabContentClass: "null",
      hasTabs: s.tabs.length > 0,
      tabs: s.tabs.map((t, i) => ({ ...t, active: i === 0 })),
      descr: s.descr ?? "",
      items,
      colClass: layout.col,
      cardStyleClass: layout.card,
      style: s.style,
      // 日曆樣式：品項的日期（場次＝品項內商品）；套裝行程：品項分組（render-styles.js）
      eventDate: style === "CALENDAR" ? eventDateOf(s) : "",
      travelGroup: style === "TRAVEL" ? (TRAVEL_GROUP[s.style] ?? "other") : "",
    };
  });

  const { started, ended } = groupBuyState(gb);
  let closedHtml = "";
  if (!adminPreview) {
    if (!started) closedHtml = `<h5 class="my-3">團購尚未開始</h5><p>開始時間：${escapeText(taipei(gb.date_start))}</p>`;
    else if (ended) closedHtml = gb.descr_close?.trim() || "<h5 class=\"my-3\">本團購已結束，感謝您的支持！</h5>";
    else if (!gb.checkoutable) closedHtml = "<h5 class=\"my-3\">本團購目前暫停結帳</h5>";
  }
  const end = gb.date_end ? new Date(gb.date_end).getTime() : Date.now();
  // 送單失敗回到本頁時的訊息（原站 #message 區塊）；靜默封鎖的假下單顯示已送出
  let flashMessage = cart?.checkout.flashErrors?.[0] ?? "";
  let flashType = "warning";
  if (ctx.query.get("ordered") === "1") {
    flashMessage = "訂單已送出，感謝您的訂購！";
    flashType = "success";
  }
  const vars = {
    ...feVars(ctx, { tenant, groupBuy: gb, customer }),
    // 進階設定「SEO描述」「自定義-CSS」（推導：原站示範團未設定，無法觀察輸出位置；放在 <head>）。
    // CSS 去掉 < 字元，避免以 </style> 跳出樣式區塊。
    seoDescr: (prefs.SEO_DESCR?.value ?? "").trim() || null,
    customCss: (prefs.CSS?.value ?? "").replace(/</g, "").trim() || null,
    ogImage: imageUrl(String(gbSetting(gb, "logo", "") || ""), "/upload/images/unsort/logo.png"),
    descrHtml: opts.bag ? "" : gb.descr ?? "",
    descrFooterHtml: gb.descr_footer ?? "",
    itemSets,
    closedHtml,
    countryCode: String(gbSetting(gb, "country", "TW")),
    languageCode: uiLang(ctx, gb.language_tag),
    // 推導：會員點數折抵卡片（團購開啟 ptEnabled 且會員已登入）
    pointsCard:
      customer && pointsEnabled(gb)
        ? { balance: Number(customer.customer.points) || 0, used: Number(cart?.checkout.points) || 0 }
        : null,
    itemRoom: null,
    timeRemainToEnd: Math.max(0, end - Date.now()),
    renderClass: style === "TYPE3" ? "" : `gb-render-${style.toLowerCase()}`,
    renderScript: style === "CALENDAR" || style === "TRAVEL",
    renderCss: style !== "TYPE3" || !!opts.bag,
    renderStyle: style,
    bagMode: !!opts.bag,
    bagEmpty: !!opts.bag && itemSets.every((x) => !x.items.length),
    homeHref: `/${gb.short_url}`,
    showcase: style === "SHOWCASE" && !opts.bag ? await showcaseCards(gb) : null,
    // 長期團與購物袋頁不顯示倒數（推導）：原站 gbs_v6 initCountdown 在 countdownDays＝0 時不啟動倒數（也不會到時重新整理）
    countdownDays: style === "LONGTERM" || opts.bag ? 0 : Number(gbSetting(gb, "countdownDays", 7)) || 7,
    adminUser: adminPreview,
    paymentMethodLayout: "card",
    flashMessage,
    flashType,
    needCvsLookup: (await loadGroupBuyShippingRules(tenant.id, gb.id)).some(
      (r) => r.shipping_type === "CVS" || r.shipping_type === "PICKUP" || !!r.flat_rate_shipping_settings?.cvsType,
    ),
  };
  return html(renderTemplate("storefront/form.html", vars));
}

// ───────────── 其他發布樣式（推導：原站帳號沒有這些樣式的團購，spec/SPEC.md §9 #7） ─────────────

/** 購物袋頁的品項區：一個「購物袋」區塊（商品取自購物袋，依目錄排序） */
function bagItemSets(catalog: { itemSets: CatalogItemSet[] }): CatalogItemSet[] {
  const first = catalog.itemSets[0];
  return first ? [{ ...first, itemSetId: 0, title: "購物袋", tabs: [], descr: null, style: "STYLE1", css: null, cssTitle: null, itemSetSettings: {} }] : [];
}

/** 開團清單（SHOWCASE）：同租戶進行中與即將開始的團購（不含官網／倉儲／POS／開團清單本身），依開始時間新到舊 */
async function showcaseCards(gb: SfGroupBuy) {
  const now = new Date().toISOString();
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id, short_url, title, short_title, render, image, date_start, date_end, group_buy_settings")
    .eq("tenant_id", gb.tenant_id)
    .neq("id", gb.id)
    .not("render", "in", "(HOME,WH,POS,SHOWCASE)")
    .not("short_url", "is", null)
    .or(`date_end.is.null,date_end.gte.${now}`)
    .order("date_start", { ascending: false, nullsFirst: false })
    .limit(60);
  if (error) throw new Error(`查詢開團清單失敗：${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const settings = (r.group_buy_settings ?? {}) as Record<string, unknown>;
    const started = !r.date_start || String(r.date_start) <= now;
    return {
      href: `/${String(r.short_url)}`,
      title: String(r.title ?? ""),
      image: imageUrl(String(r.image ?? "") || String(settings.logo ?? ""), "/upload/images/unsort/logo.png"),
      period: [taipei((r.date_start as string) ?? null), taipei((r.date_end as string) ?? null)].filter(Boolean).join(" ～ "),
      badge: started ? "進行中" : "即將開始",
      badgeClass: started ? "badge-success" : "badge-info",
    };
  });
}

function taipei(v: string | null): string {
  if (!v) return "";
  return new Date(new Date(v).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
