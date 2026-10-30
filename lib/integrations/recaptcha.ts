// Google reCAPTCHA（PARITY #125）：純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入（以 mock fetch 測試）。
// 原站：後台登入先以 v3「環境檢測」（/ajax/GoogleRecaptcha/verify），不通過才顯示 v2「我不是機器人」；
//       前台訂單查詢（兩個表單）與「我想問問題」用 v2 勾選框。原站 sitekey 綁原站網域，本系統改用自己的金鑰（環境變數）：
//   RECAPTCHA_SITE_KEY／RECAPTCHA_SECRET_KEY        v2 勾選框（後台登入備援、前台表單）
//   RECAPTCHA_V3_SITE_KEY／RECAPTCHA_V3_SECRET_KEY  v3（後台登入環境檢測；未設定＝直接改用 v2）
//   RECAPTCHA_V3_MIN_SCORE                         v3 通過分數（預設 0.5）
// 都未設定 → 維持相容樁（不檢查，防濫用靠伺服器端限流），與補E 之前行為相同。
// 驗證一律由伺服器呼叫 https://www.google.com/recaptcha/api/siteverify（secret 只在伺服器端）。
import { createHmac, timingSafeEqual } from "node:crypto";

export type RecaptchaConfig = {
  v2: { siteKey: string; secret: string } | null;
  v3: { siteKey: string; secret: string; minScore: number } | null;
};

type Env = Record<string, string | undefined>;

export function readRecaptchaConfig(env: Env): RecaptchaConfig {
  const s = (k: string) => String(env[k] ?? "").trim();
  const v2 = s("RECAPTCHA_SITE_KEY") && s("RECAPTCHA_SECRET_KEY") ? { siteKey: s("RECAPTCHA_SITE_KEY"), secret: s("RECAPTCHA_SECRET_KEY") } : null;
  let minScore = Number(s("RECAPTCHA_V3_MIN_SCORE") || "0.5");
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) minScore = 0.5;
  const v3 = s("RECAPTCHA_V3_SITE_KEY") && s("RECAPTCHA_V3_SECRET_KEY")
    ? { siteKey: s("RECAPTCHA_V3_SITE_KEY"), secret: s("RECAPTCHA_V3_SECRET_KEY"), minScore }
    : null;
  return { v2, v3 };
}

export function recaptchaEnabled(cfg: RecaptchaConfig): boolean {
  return !!(cfg.v2 || cfg.v3);
}

export type SiteverifyResult = { ok: boolean; reason: string; score: number | null };

const SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify";

/**
 * 向 Google 驗證 token。v3 另檢查 score ≥ minScore 與 action（有給才比對）。
 * 連線失敗／非 200 → 不通過（fail closed：已設定金鑰代表要擋機器人）。
 */
export async function siteverify(
  opts: { secret: string; token: string; remoteIp?: string | null; minScore?: number; action?: string },
  fetcher: typeof fetch = fetch,
): Promise<SiteverifyResult> {
  const token = String(opts.token ?? "").trim();
  if (!token || token.length > 4000) return { ok: false, reason: "NO_TOKEN", score: null };
  const body = new URLSearchParams({ secret: opts.secret, response: token });
  if (opts.remoteIp) body.set("remoteip", opts.remoteIp);
  let j: Record<string, unknown>;
  try {
    const r = await fetcher(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, reason: `HTTP_${r.status}`, score: null };
    j = (await r.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "NETWORK", score: null };
  }
  const score = typeof j.score === "number" ? j.score : null;
  if (j.success !== true) {
    const codes = Array.isArray(j["error-codes"]) ? (j["error-codes"] as unknown[]).join(",") : "";
    return { ok: false, reason: codes || "FAILED", score };
  }
  if (opts.minScore !== undefined) {
    if (score === null || score < opts.minScore) return { ok: false, reason: "LOW_SCORE", score };
    if (opts.action && typeof j.action === "string" && j.action !== opts.action) return { ok: false, reason: "ACTION_MISMATCH", score };
  }
  return { ok: true, reason: "OK", score };
}

// 後台登入「已通過檢測」短效憑證（cookie）：v3 token 只能驗一次，/verify 驗過後發憑證，登入時檢查憑證；
// v2 驗過也發同一個憑證（需要認證碼 485 重新送出時不必再勾一次）。HMAC(SESSION_SECRET)，綁用途與到期時間。
export const RECAPTCHA_PASS_COOKIE = "gb_rcpass";
export const RECAPTCHA_PASS_TTL_SEC = 600;

function passSig(secret: string, purpose: string, exp: number): string {
  return createHmac("sha256", secret).update(`recaptcha-pass|${purpose}|${exp}`).digest("base64url").slice(0, 43);
}

export function issueRecaptchaPass(secret: string, purpose: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + RECAPTCHA_PASS_TTL_SEC;
  return `${exp}.${passSig(secret, purpose, exp)}`;
}

export function checkRecaptchaPass(secret: string, purpose: string, value: string | null | undefined, nowMs = Date.now()): boolean {
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ""));
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(nowMs / 1000) || exp > Math.floor(nowMs / 1000) + RECAPTCHA_PASS_TTL_SEC) return false;
  const want = Buffer.from(passSig(secret, purpose, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
