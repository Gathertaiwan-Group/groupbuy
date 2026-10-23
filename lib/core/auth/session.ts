// 後台登入 session：隨機 token 放 httpOnly cookie，DB（groupbuy.admin_sessions）只存 token 的 sha256 hex。
// - 勾選「讓我保持登入(24小時)」(kmsi)：cookie Max-Age=24h，伺服器端固定 24 小時到期。
// - 未勾選：瀏覽器 session cookie（關閉瀏覽器即失效），伺服器端閒置 12 小時到期（每次請求/keepalive 滑動延長）。
import { createHash, randomBytes } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession } from "@/lib/core/http/types";

export const SESSION_COOKIE = "GBSID";
const PERSISTENT_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 12 * 60 * 60 * 1000;
/** 非保持登入的 session：距上次延長超過這段時間才寫 DB 延長（避免每個請求都寫） */
const SLIDE_EVERY_MS = 10 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(persistent: boolean): string {
  // 前綴標記是否為 24h 保持登入（不需另開欄位；整串都進雜湊）
  return `${persistent ? "p" : "s"}.${randomBytes(32).toString("base64url")}`;
}

function isPersistentToken(token: string): boolean {
  return token.startsWith("p.");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      const v = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

export function buildSessionCookie(token: string, persistent: boolean, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (persistent) parts.push(`Max-Age=${PERSISTENT_MS / 1000}`);
  return parts.join("; ");
}

export function buildClearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

export async function createSession(opts: {
  adminUserId: number;
  tenantId: number;
  persistent: boolean;
  req: Request;
}): Promise<{ token: string; cookie: string }> {
  const token = newToken(opts.persistent);
  const expires = new Date(Date.now() + (opts.persistent ? PERSISTENT_MS : IDLE_MS + SLIDE_EVERY_MS));
  const db = getServiceClient();
  const { error } = await db.from("admin_sessions").insert({
    id: hashToken(token),
    admin_user_id: opts.adminUserId,
    tenant_id: opts.tenantId,
    expires_at: expires.toISOString(),
    user_agent: (opts.req.headers.get("user-agent") || "").slice(0, 500),
    ip: clientIp(opts.req),
  });
  if (error) throw new Error(`建立 session 失敗：${error.message}`);
  // 順手清掉此管理員已過期的 session（避免累積）
  await db.from("admin_sessions").delete().eq("admin_user_id", opts.adminUserId).lt("expires_at", new Date().toISOString());
  return { token, cookie: buildSessionCookie(token, opts.persistent, isSecureRequest(opts.req)) };
}

type SessionRow = {
  id: string;
  expires_at: string;
  admin_user_id: number;
  tenant_id: number;
  login_admin_user_id: number | null;
  admin_users: {
    id: number;
    tenant_id: number;
    account: string;
    display_name: string | null;
    role: string | null;
    permissions: Record<string, unknown> | null;
    is_active: boolean | null;
  } | null;
  tenants: { id: number; code: string; name: string | null } | null;
};

/** 由 cookie 讀出有效 session；過期/停用回 null。非保持登入的 session 會滑動延長。 */
export async function readSession(req: Request): Promise<AdminSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = hashToken(token);
  const db = getServiceClient();
  const { data, error } = await db
    .from("admin_sessions")
    .select(
      "id, expires_at, admin_user_id, tenant_id, login_admin_user_id, admin_users(id, tenant_id, account, display_name, role, permissions, is_active), tenants(id, code, name)",
    )
    .eq("id", id)
    .maybeSingle<SessionRow>();
  if (error) {
    console.error("[session] 查詢失敗", error.message);
    return null;
  }
  if (!data || !data.admin_users || !data.tenants) return null;
  const expiresAt = new Date(data.expires_at);
  const now = Date.now();
  if (expiresAt.getTime() <= now) {
    await db.from("admin_sessions").delete().eq("id", id);
    return null;
  }
  const u = data.admin_users;
  if (u.is_active === false || u.tenant_id !== data.tenant_id) return null;
  // 切換過身分的 session：原登入者被停用（或刪除、換租戶）時一併失效
  const loginId = data.login_admin_user_id;
  if (loginId != null && loginId !== u.id) {
    const { data: orig, error: oErr } = await db
      .from("admin_users")
      .select("id, tenant_id, is_active")
      .eq("id", loginId)
      .maybeSingle<{ id: number; tenant_id: number; is_active: boolean | null }>();
    if (oErr) {
      console.error("[session] 查詢原登入者失敗", oErr.message);
      return null;
    }
    if (!orig || orig.is_active === false || orig.tenant_id !== data.tenant_id) return null;
  }

  const persistent = isPersistentToken(token);
  let effectiveExpiry = expiresAt;
  if (!persistent && expiresAt.getTime() - now < IDLE_MS) {
    // 滑動延長：到期時間設為「現在 + 12 小時 + 10 分鐘」，剩餘不到 12 小時（距上次延長超過 10 分鐘）才寫 DB。
    // 這樣任何一次請求之後，至少還有 12 小時的閒置時間。
    effectiveExpiry = new Date(now + IDLE_MS + SLIDE_EVERY_MS);
    await db.from("admin_sessions").update({ expires_at: effectiveExpiry.toISOString() }).eq("id", id);
  }

  return {
    sessionId: id,
    adminUserId: u.id,
    account: u.account,
    displayName: u.display_name,
    role: u.role,
    permissions: u.permissions ?? {},
    tenantId: data.tenants.id,
    tenantCode: data.tenants.code,
    tenantName: data.tenants.name,
    expiresAt: effectiveExpiry,
    persistent,
    loginAdminUserId: loginId ?? null,
  };
}

export async function destroySession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  const db = getServiceClient();
  const { error } = await db.from("admin_sessions").delete().eq("id", hashToken(token));
  // 刪不掉就不能回「已登出」：token 仍有效
  if (error) throw new Error(`登出失敗：${error.message}`);
}

/**
 * 切換到同租戶另一位管理員（switchAdmin）：沿用同一個 session token，只改 admin_user_id；
 * login_admin_user_id 記住「原本輸入帳密登入的人」（多次切換仍保留最初那位），
 * 原登入者改密碼／被停用時這個 session 會一起失效。
 */
export async function switchSessionUser(sessionId: string, adminUserId: number, loginAdminUserId: number): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("admin_sessions")
    .update({ admin_user_id: adminUserId, login_admin_user_id: loginAdminUserId })
    .eq("id", sessionId);
  if (error) throw new Error(`切換管理員失敗：${error.message}`);
}

/** 清掉某管理員（含以他登入後切換成別人的）全部 session，保留目前這個（改密碼後使用） */
export async function destroyOtherSessions(adminUserId: number, keepSessionId: string): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("admin_sessions")
    .delete()
    .or(`admin_user_id.eq.${Number(adminUserId)},login_admin_user_id.eq.${Number(adminUserId)}`)
    .neq("id", keepSessionId);
  if (error) throw new Error(`清除其他登入失敗：${error.message}`);
}

/** 清掉某管理員（含以他登入後切換成別人的）全部 session：管理者重設他人密碼、停用帳號時使用 */
export async function destroyAllSessions(adminUserId: number): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("admin_sessions")
    .delete()
    .or(`admin_user_id.eq.${Number(adminUserId)},login_admin_user_id.eq.${Number(adminUserId)}`);
  if (error) throw new Error(`清除登入失敗：${error.message}`);
}
