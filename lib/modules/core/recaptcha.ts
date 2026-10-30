// Google reCAPTCHA 伺服器端（PARITY #125；邏輯在 lib/integrations/recaptcha.ts）。
// 未設定任何金鑰 → 全部直接通過（維持相容樁行為）；設定後：
//   後台登入：/ajax/GoogleRecaptcha/verify 驗 v3（分數門檻）→ 發短效憑證 cookie；登入時需憑證或 v2 勾選結果（驗過也發憑證）。
//   前台：訂單查詢（訂單編號＋電話、忘記訂單號碼）、我想問問題 → 需 v2 勾選結果（g-recaptcha-response）。
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { clientIp, isSecureRequest, readCookie } from "@/lib/core/auth/session";
import {
  RECAPTCHA_PASS_COOKIE,
  RECAPTCHA_PASS_TTL_SEC,
  checkRecaptchaPass,
  issueRecaptchaPass,
  readRecaptchaConfig,
  recaptchaEnabled,
  siteverify,
  type RecaptchaConfig,
} from "@/lib/integrations/recaptcha";

export const RECAPTCHA_REQUIRED_MESSAGE = "請先勾選「我不是機器人」完成驗證";

export function recaptchaConfig(): RecaptchaConfig {
  return readRecaptchaConfig(process.env);
}

/** 模板變數：有設定才輸出 site key（模板據此載入 Google api.js，否則用相容樁） */
export function recaptchaVars(): { recaptchaV2SiteKey: string; recaptchaV3SiteKey: string } {
  const c = recaptchaConfig();
  return { recaptchaV2SiteKey: c.v2?.siteKey ?? "", recaptchaV3SiteKey: c.v3?.siteKey ?? "" };
}

function passSecret(): string {
  return process.env.SESSION_SECRET || "";
}

function setPassCookie(ctx: RequestContext, purpose: string) {
  const parts = [`${RECAPTCHA_PASS_COOKIE}=${issueRecaptchaPass(passSecret(), purpose)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${RECAPTCHA_PASS_TTL_SEC}`];
  if (isSecureRequest(ctx.req)) parts.push("Secure");
  ctx.cookies.set.push(parts.join("; "));
}

/** 前台表單：v2 勾選結果（未設定 v2 金鑰 → 通過） */
export async function storefrontRecaptchaOk(ctx: RequestContext, token: string | null | undefined): Promise<boolean> {
  const c = recaptchaConfig();
  if (!c.v2) return true;
  const r = await siteverify({ secret: c.v2.secret, token: String(token ?? ""), remoteIp: clientIp(ctx.req) });
  if (!r.ok) console.warn(`[recaptcha] 前台驗證未通過：${r.reason}`);
  return r.ok;
}

/** 後台登入：未設定 → 通過；已有短效憑證 → 通過；帶 v2 勾選結果且驗過 → 發憑證並通過 */
export async function adminLoginRecaptchaOk(ctx: RequestContext): Promise<boolean> {
  const c = recaptchaConfig();
  if (!recaptchaEnabled(c)) return true;
  if (checkRecaptchaPass(passSecret(), "admin-login", readCookie(ctx.req, RECAPTCHA_PASS_COOKIE))) return true;
  if (!c.v2) return false;
  const token = (await ctx.param("g-recaptcha-response")) ?? "";
  if (!token) return false;
  const r = await siteverify({ secret: c.v2.secret, token, remoteIp: clientIp(ctx.req) });
  if (!r.ok) {
    console.warn(`[recaptcha] 後台登入 v2 未通過：${r.reason}`);
    return false;
  }
  setPassCookie(ctx, "admin-login");
  return true;
}

/**
 * POST /ajax/GoogleRecaptcha/verify（token）：後台登入頁「環境檢測」。
 * 未設定 → 200 通過（相容樁）；未設定 v3 但有 v2 → 400（登入頁改顯示 v2 勾選框）；v3 分數達門檻 → 200 並發憑證，否則 400。
 */
export async function recaptchaVerifyHandler(ctx: RequestContext): Promise<Response> {
  const c = recaptchaConfig();
  if (!recaptchaEnabled(c)) return json({ success: true, notIntegrated: true });
  if (!c.v3) return json({ code: 400, success: false, error: RECAPTCHA_REQUIRED_MESSAGE }, { status: 400 });
  const token = (await ctx.param("token")) ?? "";
  const r = await siteverify({ secret: c.v3.secret, token, remoteIp: clientIp(ctx.req), minScore: c.v3.minScore, action: "login" });
  if (!r.ok) {
    console.warn(`[recaptcha] v3 未通過：${r.reason}（score ${r.score ?? "-"}）`);
    return json({ code: 400, success: false, error: RECAPTCHA_REQUIRED_MESSAGE }, { status: 400 });
  }
  setPassCookie(ctx, "admin-login");
  return json({ success: true });
}
