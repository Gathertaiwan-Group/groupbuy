// 後台 CSRF token（縱深防禦；第一層仍是 dispatch 的 Sec-Fetch-Site 跨站判斷＋SameSite=Lax cookie）。
// - token ＝ HMAC-SHA256(SESSION_SECRET, "csrf|" + 後台 session cookie 值)，與 session 綁定、不必存 DB。
// - 伺服器在每個已登入的後台回應帶一個「可被 JS 讀取」的 cookie GBXSRF（不是 HttpOnly；SameSite=Strict）。
//   其他網站讀不到本站 cookie，所以拿不到 token。
// - 前端 /compat/csrf.js（後台頁面自動載入）以 jQuery 全域 ajax 設定（ajaxPrefilter，只對同源請求）帶 X-CSRF-Token 標頭，
//   並補上非 jQuery 的 XMLHttpRequest／fetch 與原生表單送出（隱藏欄位 _csrf）；原站前端 JS 不需修改。
// - 驗證：後台（auth=admin）所有非 GET/HEAD 請求必須帶正確 token（標頭 X-CSRF-Token 或表單欄位 _csrf）。
import { createHmac, timingSafeEqual } from "node:crypto";
import { readCookie, SESSION_COOKIE } from "@/lib/core/auth/session";

export const CSRF_COOKIE = "GBXSRF";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_FIELD = "_csrf";

function secret(): string {
  const s = process.env.SESSION_SECRET || "";
  if (s.length >= 16) return s;
  const fb = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (fb.length >= 16) return fb;
  throw new Error("CSRF token 缺少簽章金鑰（SESSION_SECRET）");
}

export function csrfTokenFor(sessionCookie: string): string {
  return createHmac("sha256", secret()).update(`csrf|${sessionCookie}`).digest("base64url");
}

/** 目前請求的後台 session 對應的 token（未登入回 null） */
export function expectedCsrfToken(req: Request): string | null {
  const sid = readCookie(req, SESSION_COOKIE);
  return sid ? csrfTokenFor(sid) : null;
}

export function csrfTokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 回應需要補（或更新）GBXSRF cookie 時回傳 Set-Cookie 值 */
export function csrfCookieIfNeeded(req: Request, expected: string, secure: boolean): string | null {
  if (readCookie(req, CSRF_COOKIE) === expected) return null;
  const parts = [`${CSRF_COOKIE}=${expected}`, "Path=/", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 後台 HTML 頁面在 </head> 前插入 csrf.js（含模組自行輸出的獨立頁面，例如列印頁） */
export function injectCsrfScript(html: string, assetVersion: string): string {
  const tag = `<script src="/compat/csrf.js?v=${assetVersion}"></script>`;
  if (html.includes("/compat/csrf.js")) return html;
  const i = html.search(/<\/head>/i);
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html;
}
