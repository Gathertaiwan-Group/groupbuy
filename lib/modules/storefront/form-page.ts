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
import { findCart } from "./cart-store";
import { loadGroupBuyShippingRules } from "./pricing";

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

export async function renderFormPage(ctx: RequestContext, gb: SfGroupBuy): Promise<Response> {
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

  let idx = 0;
  const itemSets = catalog.itemSets.map((s: CatalogItemSet) => {
    const layout = STYLE_LAYOUT[s.style] ?? STYLE_LAYOUT.STYLE5;
    const items =
      s.style === "DESCR"
        ? []
        : catalog.items
            .filter((it) => it.itemSetId === s.itemSetId)
            .filter((it) => {
              const soldOut = it.calculatedMaxOrderQuota <= 0;
              if (!soldOut) return true;
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
                options: Array.from({ length: it.calculatedMaxOrderQuota }, (_, i) => i + 1),
                soldOut,
                soldOutLabel: outStock === "BLANK" ? "" : "已售完",
                selectClass: it.stockAvailable <= 0 && it.stockBackOrderAvailable > 0 ? "backorder" : "normal",
                cardExtraClass: "null null null",
                discountLabelHtml: "",
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
  const cart = await findCart(ctx, tenant.id, gb.id);
  let flashMessage = cart?.checkout.flashErrors?.[0] ?? "";
  let flashType = "warning";
  if (ctx.query.get("ordered") === "1") {
    flashMessage = "訂單已送出，感謝您的訂購！";
    flashType = "success";
  }
  const vars = {
    ...feVars(ctx, { tenant, groupBuy: gb, customer }),
    ogImage: imageUrl(String(gbSetting(gb, "logo", "") || ""), "/upload/images/unsort/logo.png"),
    descrHtml: gb.descr ?? "",
    descrFooterHtml: gb.descr_footer ?? "",
    itemSets,
    closedHtml,
    countryCode: String(gbSetting(gb, "country", "TW")),
    languageCode: gb.language_tag === "en" || gb.language_tag === "en_US" ? "en" : "zh-TW",
    itemRoom: null,
    timeRemainToEnd: Math.max(0, end - Date.now()),
    countdownDays: Number(gbSetting(gb, "countdownDays", 7)) || 7,
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

function taipei(v: string | null): string {
  if (!v) return "";
  return new Date(new Date(v).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
