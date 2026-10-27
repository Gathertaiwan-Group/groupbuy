// storefront 共用：由網址解析租戶／團購、前台頁面共用模板變數。
// 前台沒有後台 session；資料一律以「網址解析出的租戶／團購」的 tenant_id 過濾（多租戶隔離）。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { commonVars } from "@/lib/core/render/vars";
import { notFound } from "@/lib/core/http/errors";
import { resolveGroupBuyPreferences } from "@/lib/modules/groupbuy/preference";
import { PLATFORM_THEME, TENANT_THEME, resolveTheme, type ThemePalette } from "./theme";
import type { CustomerSession } from "./customer-session";
import { customerMenuHtml } from "./customer-menu";
import { UI_TEXT, uiLang } from "./i18n";

export interface SfTenant {
  id: number;
  code: string;
  name: string | null;
}

/** group_buys 列（select *；只列出 storefront 會用到的欄位型別） */
export interface SfGroupBuy {
  id: number;
  tenant_id: number;
  uuid: string;
  title: string;
  short_title: string | null;
  short_url: string | null;
  render: string;
  image: string | null;
  carousel1: string | null;
  carousel2: string | null;
  carousel3: string | null;
  carousel4: string | null;
  date_start: string | null;
  date_end: string | null;
  descr: string | null;
  descr_billing: string | null;
  descr_footer: string | null;
  descr_close: string | null;
  password: string | null;
  group_buy_password: string | null;
  payment_methods: number;
  tax_rate: number | string;
  payment_valid_days_type: string;
  payment_valid_days: number | string;
  payment_valid_days_cc: number | string;
  allow_join_sales_order: boolean;
  auto_cancel_expired: boolean;
  invoice_disabled: boolean;
  island_disabled: boolean;
  oversea_disabled: boolean;
  disable_einvoice_receipt_title: boolean;
  coupon_enabled: boolean;
  checkoutable: boolean;
  preview_countdown: boolean;
  have_user_agreement: boolean;
  option_section_shipping_address: string;
  option_section_note: string;
  option_fb_nickname: string;
  option_address: string;
  option_email: string;
  option_telephone: string;
  option_payment_method: string;
  option_note: string;
  option_deliver_time: string;
  email_support: string | null;
  price_label: string | null;
  currency: string;
  language_tag: string;
  shipping_tag: string;
  group_buy_settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const PLATFORM_TENANT_CODE = "groupbuyforms";

const tenantCache = new Map<string, { t: SfTenant | null; at: number }>();

export async function tenantByCode(code: string | null | undefined): Promise<SfTenant | null> {
  if (!code || !/^[A-Za-z0-9_-]{2,64}$/.test(code)) return null;
  const hit = tenantCache.get(code);
  if (hit && Date.now() - hit.at < 60_000) return hit.t;
  const { data, error } = await getServiceClient().from("tenants").select("id, code, name").eq("code", code).maybeSingle();
  if (error) throw new Error(`查詢租戶失敗：${error.message}`);
  const t = (data as SfTenant | null) ?? null;
  tenantCache.set(code, { t, at: Date.now() });
  return t;
}

export async function tenantById(id: number): Promise<SfTenant | null> {
  const { data, error } = await getServiceClient().from("tenants").select("id, code, name").eq("id", id).maybeSingle();
  if (error) throw new Error(`查詢租戶失敗：${error.message}`);
  return (data as SfTenant | null) ?? null;
}

const SHORT_URL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 短網址全域唯一（group_buys_short_url_key） */
export async function groupBuyByShortUrl(shortUrl: string | null | undefined): Promise<SfGroupBuy | null> {
  if (!shortUrl || shortUrl === "null" || !SHORT_URL_RE.test(shortUrl)) return null;
  const { data, error } = await getServiceClient().from("group_buys").select("*").eq("short_url", shortUrl).maybeSingle();
  if (error) throw new Error(`查詢團購失敗：${error.message}`);
  return (data as SfGroupBuy | null) ?? null;
}

export async function groupBuyByUuid(tenantId: number, uuid: string | null | undefined): Promise<SfGroupBuy | null> {
  if (!uuid || !/^[A-Za-z0-9]{6,64}$/.test(uuid)) return null;
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("uuid", uuid)
    .maybeSingle();
  if (error) throw new Error(`查詢團購失敗：${error.message}`);
  return (data as SfGroupBuy | null) ?? null;
}

export interface SfScope {
  tenant: SfTenant;
  /** shortUrl 為 'null'（原站租戶層級頁面，例如隱私權頁的導覽列）時為 null */
  groupBuy: SfGroupBuy | null;
}

/**
 * `/{租戶}/p/{shortUrl}/...` 路由：租戶取自網址前綴，團購必須屬於該租戶。
 * shortUrl = 'null' 視為租戶層級（原站隱私權/條款頁的導覽列就是 /{租戶}/p/null/...）。
 */
export async function scopeFromTenantPath(ctx: RequestContext, opts: { requireGroupBuy?: boolean } = {}): Promise<SfScope> {
  const tenant = await tenantByCode(ctx.tenantPrefix);
  if (!tenant) throw notFound("找不到頁面");
  const shortUrl = ctx.params.shortUrl ?? "null";
  let groupBuy: SfGroupBuy | null = null;
  if (shortUrl !== "null") {
    groupBuy = await groupBuyByShortUrl(shortUrl);
    if (!groupBuy || groupBuy.tenant_id !== tenant.id) throw notFound("找不到頁面");
  }
  if (opts.requireGroupBuy && !groupBuy) throw notFound("找不到團購");
  return { tenant, groupBuy };
}

/** 團購進階設定（key → {value, settings}），以 tenant_id + group_buy_id 過濾 */
export async function groupBuyPreferences(
  tenantId: number,
  groupBuyId: number,
): Promise<Record<string, { value: string | null; settings: Record<string, unknown> }>> {
  const { data, error } = await getServiceClient()
    .from("group_buy_preferences")
    .select("name, pref_value, group_buy_preference_settings")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId);
  if (error) throw new Error(`查詢進階設定失敗：${error.message}`);
  const out: Record<string, { value: string | null; settings: Record<string, unknown> }> = {};
  for (const r of (data ?? []) as { name: string; pref_value: string | null; group_buy_preference_settings: Record<string, unknown> }[]) {
    out[r.name] = { value: r.pref_value, settings: r.group_buy_preference_settings ?? {} };
  }
  // 本團未設定的鍵：依進階設定頁同一口徑往上找（綁定標籤 → 系統設定 /backend/SystemPreference/panel 的同名鍵）
  const inherited = await resolveGroupBuyPreferences(tenantId, groupBuyId);
  for (const [name, r] of Object.entries(inherited)) {
    if (name in out || r.source === "GROUP_BUY") continue;
    out[name] = { value: r.prefValue, settings: (r.settings ?? {}) as Record<string, unknown> };
  }
  return out;
}

export function gbSetting<T = unknown>(gb: SfGroupBuy | null | undefined, key: string, def: T): T {
  const v = gb?.group_buy_settings?.[key];
  return (v === undefined || v === null || v === "" ? def : v) as T;
}

/** 原站自家 CDN 上傳圖 → 本站 /upload/images/（core 會轉回原站 CDN 或 Supabase Storage） */
export function imageUrl(v: string | null | undefined, fallback = ""): string {
  if (!v) return fallback;
  const s = String(v).trim();
  if (!s) return fallback;
  const m = s.match(/^(?:https?:)?\/\/cdn\.groupbuyforms\.(?:com|tw)\/upload\/images\/(.+)$/);
  if (m) return `/upload/images/${m[1]}`;
  if (/^https?:\/\//.test(s) || s.startsWith("/")) return s;
  return `/upload/images/${s.replace(/^\/+/, "")}`;
}

export function taipeiYear(d = new Date()): number {
  return new Date(d.getTime() + 8 * 3600 * 1000).getUTCFullYear();
}

const PIXEL_RE = /^\d{5,20}$/;
const GA_RE = /^(G|UA|AW|GT)-[A-Z0-9-]{4,20}$/;

export function trackingFor(gb: SfGroupBuy | null) {
  const px = String(gbSetting(gb, "facebookPixel", "")).trim();
  const ga = String(gbSetting(gb, "gaCode", "")).trim();
  return { facebookPixel: PIXEL_RE.test(px) ? px : "", gaCode: GA_RE.test(ga) ? ga : "" };
}

export interface FeVarsOpts {
  tenant: SfTenant | null;
  groupBuy: SfGroupBuy | null;
  customer?: CustomerSession | null;
  /** 主題來源：tenant＝租戶色票（預設）；platform＝無租戶情境（404 賣家頁） */
  themeSource?: "tenant" | "platform";
  themeOverrides?: Record<string, unknown> | null;
}

/** 前台簡單版面（下單頁、訂單查詢、隱私權、條款、404）的共用模板變數 */
export function feVars(ctx: RequestContext, o: FeVarsOpts): Record<string, unknown> {
  const base = commonVars(ctx);
  const tenantCode = o.tenant?.code ?? PLATFORM_TENANT_CODE;
  const short = o.groupBuy?.short_url || "null";
  const gbfBaseUrl = `/${tenantCode}/p/${short}`;
  const theme: ThemePalette = resolveTheme(o.themeSource === "platform" ? PLATFORM_THEME : TENANT_THEME, o.themeOverrides);
  const logo = String(gbSetting(o.groupBuy, "logo", "") || "");
  const lang = uiLang(ctx, o.groupBuy?.language_tag);
  return {
    assetVersion: base.assetVersion,
    origin: base.origin,
    query: base.query,
    tenantCode,
    tenant: o.tenant,
    groupBuy: o.groupBuy,
    theme,
    themeColorLine: !!o.groupBuy,
    tracking: trackingFor(o.groupBuy),
    logoUrl: imageUrl(logo, "/upload/images/unsort/logo.png"),
    faviconUrl: "/upload/images/unsort/favicon.png",
    navShortUrl: short,
    gbfBaseUrl,
    gbfShortUrl: o.groupBuy?.short_url ?? "",
    onlineHelpUuid: o.groupBuy?.uuid ?? "",
    footerTenantCode: tenantCode,
    footerPmLogo: !!o.groupBuy,
    year: taipeiYear(),
    customer: o.customer ?? null,
    customerMenuHtml: o.customer ? customerMenuHtml(gbfBaseUrl, o.customer) : "",
    uiLang: lang,
    ui: UI_TEXT[lang],
  };
}
