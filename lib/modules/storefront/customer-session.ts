// 前台會員 session（與後台 GBSID 完全分開）：隨機 token 放 HttpOnly cookie GBCSID，
// DB（groupbuy.customer_sessions）只存 token 的 sha256。7 天到期、使用中滑動延長。
// 會員屬於租戶：session 只在同租戶的前台有效（換租戶視為未登入）。
import { randomBytes } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { clientIp, hashToken, isSecureRequest, readCookie } from "@/lib/core/auth/session";
import type { RequestContext } from "@/lib/core/http/types";

export const CUSTOMER_COOKIE = "GBCSID";
const TTL_MS = 7 * 24 * 3600 * 1000;
const SLIDE_MS = 24 * 3600 * 1000;

export interface CustomerRow {
  id: number;
  tenant_id: number;
  uuid: string;
  email: string | null;
  telephone: string | null;
  firstname: string | null;
  birthday: string | null;
  is_activated: boolean;
  points: number;
  royalty_program_id: number | null;
  loyalty_card_number: string | null;
}

export interface CustomerSession {
  sessionId: string;
  tenantId: number;
  customer: CustomerRow;
}

export const CUSTOMER_COLUMNS =
  "id, tenant_id, uuid, email, telephone, firstname, birthday, is_activated, points, royalty_program_id, loyalty_card_number";

function cookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [`${CUSTOMER_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function createCustomerSession(ctx: RequestContext, customer: { id: number; tenant_id: number }): Promise<void> {
  const token = `c.${randomBytes(32).toString("base64url")}`;
  const { error } = await getServiceClient()
    .from("customer_sessions")
    .insert({
      id: hashToken(token),
      tenant_id: customer.tenant_id,
      customer_id: customer.id,
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      user_agent: (ctx.req.headers.get("user-agent") || "").slice(0, 500),
      ip: clientIp(ctx.req),
    });
  if (error) throw new Error(`建立會員 session 失敗：${error.message}`);
  await getServiceClient()
    .from("customers")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", customer.id)
    .eq("tenant_id", customer.tenant_id);
  ctx.cookies.set.push(cookie(token, TTL_MS / 1000, isSecureRequest(ctx.req)));
}

/** 讀出目前租戶的會員 session（不同租戶、過期、帳號已刪 → null） */
export async function readCustomerSession(ctx: RequestContext, tenantId: number): Promise<CustomerSession | null> {
  const token = readCookie(ctx.req, CUSTOMER_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = hashToken(token);
  const db = getServiceClient();
  const { data, error } = await db
    .from("customer_sessions")
    .select(`id, tenant_id, customer_id, expires_at, customers(${CUSTOMER_COLUMNS})`)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as { id: string; tenant_id: number; expires_at: string; customers: CustomerRow | null };
  if (!row.customers || row.customers.tenant_id !== tenantId) return null;
  const exp = new Date(row.expires_at).getTime();
  if (!(exp > Date.now())) {
    await db.from("customer_sessions").delete().eq("id", id);
    return null;
  }
  if (exp - Date.now() < TTL_MS - SLIDE_MS) {
    await db.from("customer_sessions").update({ expires_at: new Date(Date.now() + TTL_MS).toISOString() }).eq("id", id);
    ctx.cookies.set.push(cookie(token, TTL_MS / 1000, isSecureRequest(ctx.req)));
  }
  return { sessionId: id, tenantId, customer: row.customers };
}

export async function destroyCustomerSession(ctx: RequestContext): Promise<void> {
  const token = readCookie(ctx.req, CUSTOMER_COOKIE);
  if (token && token.length >= 20 && token.length <= 200) {
    await getServiceClient().from("customer_sessions").delete().eq("id", hashToken(token));
  }
  ctx.cookies.set.push(cookie("", 0, isSecureRequest(ctx.req)));
}

/** 改密碼後踢掉該會員其他 session */
export async function destroyOtherCustomerSessions(customerId: number, tenantId: number, keepSessionId: string): Promise<void> {
  await getServiceClient()
    .from("customer_sessions")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .neq("id", keepSessionId);
}
