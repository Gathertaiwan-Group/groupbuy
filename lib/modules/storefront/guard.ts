// 前台防濫用與輸入檢查：DB 計數器限流（sf_rate_hit）、字串長度/格式驗證、HTML 跳脫。
import { getServiceClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/core/auth/session";
import { HttpError } from "@/lib/core/http/errors";
import type { RequestContext } from "@/lib/core/http/types";

export function ipOf(ctx: RequestContext): string {
  return (clientIp(ctx.req) || "unknown").slice(0, 64);
}

/** 記一次；超過上限丟 429（原站慣例回 {code, error}） */
export async function rateLimit(key: string, windowSeconds: number, max: number, message = "操作太頻繁，請稍後再試"): Promise<void> {
  const { data, error } = await getServiceClient().rpc("sf_rate_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    // 限流失效不應擋住正常下單：記 log 後放行
    console.error("[storefront] rate limit 失敗", error.message);
    return;
  }
  if (data === false) throw new HttpError(429, message);
}

/** 只檢查、不記次（例如登入只在失敗時記） */
export async function rateAllowed(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const { data, error } = await getServiceClient().rpc("sf_rate_peek", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    console.error("[storefront] rate peek 失敗", error.message);
    return true;
  }
  return data !== false;
}

export async function rateRecord(key: string, windowSeconds: number, max: number): Promise<void> {
  await getServiceClient().rpc("sf_rate_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
}

/** 取參數：trim、去控制字元、長度上限（超過丟 400） */
export async function str(ctx: RequestContext, name: string, max = 255, label?: string): Promise<string> {
  const v = await ctx.param(name);
  return clean(v, max, label ?? name);
}

export function clean(v: unknown, max = 255, label = "欄位"): string {
  if (v === undefined || v === null) return "";
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (s.length > max) throw new HttpError(400, `${label}最多不超過 ${max} 個字`);
  return s;
}

export const EMAIL_RE = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

export function isEmail(s: string): boolean {
  return s.length <= 255 && EMAIL_RE.test(s);
}

/** 原站前端電話規則：09 開頭須 10 碼；其餘 +?[0-9#]{6,15}（國際/市話） */
export function isPhone(s: string, mobileOnly = false): boolean {
  const t = s.trim();
  if (t.startsWith("09")) return /^\d{10}$/.test(t);
  return !mobileOnly && /^\+?[0-9#]{6,15}$/.test(t);
}

export function intOr(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : def;
}
