// 每個後台模板都可用的共用變數。
import type { RequestContext } from "@/lib/core/http/types";

export const ASSET_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

export function requestOrigin(ctx: RequestContext): string {
  const proto = (ctx.req.headers.get("x-forwarded-proto") || ctx.url.protocol.replace(":", "")).split(",")[0].trim();
  const host = ctx.req.headers.get("x-forwarded-host") || ctx.req.headers.get("host") || ctx.url.host;
  return `${proto}://${host}`;
}

/** Accept-Language 第一順位為英文 */
export function prefersEnglish(req: Request): boolean {
  const al = (req.headers.get("accept-language") || "").split(",")[0].trim().toLowerCase();
  return al.startsWith("en");
}

export interface CommonVars {
  loggedIn: boolean;
  session: RequestContext["session"];
  /** 原站 GBF.baseUrl：'/{租戶代碼}'（未登入時 '/demo'，與原站相同） */
  baseUrl: string;
  tenantCode: string;
  account: string;
  /** 前台網址前綴（例 https://groupbuy-delta.vercel.app/），gbs_api 的賣場網址彈窗用 */
  shortUrlBase: string;
  origin: string;
  assetVersion: string;
  /** 網址查詢參數（物件） */
  query: Record<string, string>;
  /** 可切換的同租戶管理員（admin_users.permissions.switchAccounts） */
  switchableAdmins: { account: string }[];
  /** 瀏覽器偏好英文（原站依 Accept-Language 切換登入頁/頁尾少數字串） */
  en: boolean;
  /** 權限旗標（與 dispatch 的 route.permission 同一判斷）：模板用 {{#if can.customer}} 決定是否顯示入口 */
  can: Record<string, boolean>;
  [key: string]: unknown;
}

/** 後台可授權的權限旗標（管理員帳號頁的勾選項；與 admin_users.permissions 同名） */
export const PERMISSION_KEYS = ["systemPreference", "csvEditor", "refundRequisition", "customer", "adminUser"] as const;

export function permissionOn(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function commonVars(ctx: RequestContext): CommonVars {
  const s = ctx.session;
  const origin = requestOrigin(ctx);
  const query: Record<string, string> = {};
  ctx.query.forEach((v, k) => {
    if (!(k in query)) query[k] = v;
  });
  const switchAccounts = s && Array.isArray(s.permissions?.switchAccounts) ? (s.permissions.switchAccounts as unknown[]) : [];
  return {
    loggedIn: !!s,
    session: s,
    baseUrl: s ? `/${s.tenantCode}` : "/demo",
    tenantCode: s?.tenantCode ?? "",
    account: s?.account ?? "",
    shortUrlBase: `${origin}/`,
    origin,
    assetVersion: ASSET_VERSION,
    query,
    en: prefersEnglish(ctx.req),
    can: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, permissionOn(s?.permissions?.[k])])),
    switchableAdmins: switchAccounts.filter((a) => typeof a === "string" && a !== s?.account).map((a) => ({ account: String(a) })),
  };
}
