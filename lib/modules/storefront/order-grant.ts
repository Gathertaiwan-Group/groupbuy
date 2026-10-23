// 訂單檢視授權：消費者以「訂單編號＋電話」查詢成功（或剛下單完成）後，發一個短效、HMAC 簽章的 cookie，
// 之後的訂單明細網址只帶訂單編號（個資不放網址）。會員登入者看自己的訂單不需要此 cookie。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isSecureRequest, readCookie } from "@/lib/core/auth/session";
import type { RequestContext } from "@/lib/core/http/types";

const COOKIE = "GBSOV";
const TTL_MS = 2 * 3600 * 1000;
const MAX = 10;

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || "";
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  // 沒有任何金鑰時直接失敗（不可退回固定字串，否則授權 cookie 可被偽造而看到他人訂單個資）
  if (secret.length < 16 && !fallback) throw new Error("訂單檢視授權缺少簽章金鑰（SESSION_SECRET 或 SUPABASE_SERVICE_ROLE_KEY）");
  const base = secret.length >= 16 ? secret : `sf-grant:${fallback}`;
  return createHash("sha256").update(base).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

type Grant = { u: string; t: number; e: number };

function readGrants(ctx: RequestContext): Grant[] {
  const raw = readCookie(ctx.req, COOKIE);
  if (!raw || raw.length > 4000) return [];
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return [];
  const expect = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return [];
  try {
    const list = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Grant[];
    const now = Date.now();
    return Array.isArray(list) ? list.filter((g) => g && typeof g.u === "string" && typeof g.e === "number" && g.e > now) : [];
  } catch {
    return [];
  }
}

/** 授權本瀏覽器在 2 小時內檢視此訂單（tenantId 一併簽入，避免跨租戶） */
export function grantOrderView(ctx: RequestContext, tenantId: number, uuid: string): void {
  const list = readGrants(ctx).filter((g) => !(g.u === uuid && g.t === tenantId));
  list.unshift({ u: uuid, t: tenantId, e: Date.now() + TTL_MS });
  const payload = Buffer.from(JSON.stringify(list.slice(0, MAX))).toString("base64url");
  const parts = [`${COOKIE}=${payload}.${sign(payload)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_MS / 1000}`];
  if (isSecureRequest(ctx.req)) parts.push("Secure");
  ctx.cookies.set.push(parts.join("; "));
}

export function hasOrderViewGrant(ctx: RequestContext, tenantId: number, uuid: string): boolean {
  return readGrants(ctx).some((g) => g.u === uuid && g.t === tenantId);
}
