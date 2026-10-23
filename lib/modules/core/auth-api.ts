// 後台認證 API：登入、登出、keepalive、切換管理員、修改密碼。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { FieldErrors, HttpError, forbidden } from "@/lib/core/http/errors";
import { json, redirect } from "@/lib/core/http/responses";
import {
  buildClearCookie,
  clientIp,
  createSession,
  destroyOtherSessions,
  destroySession,
  isSecureRequest,
  readSession,
  switchSessionUser,
} from "@/lib/core/auth/session";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/core/auth/password";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseEditorRequest, editorResponse } from "@/lib/core/editor/protocol";

const MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

type AdminRow = {
  id: number;
  tenant_id: number;
  account: string;
  password_hash: string;
  is_active: boolean | null;
};

async function recordAttempt(ctx: RequestContext, account: string, success: boolean, reason: string | null, user?: AdminRow | null) {
  const db = getServiceClient();
  const { error } = await db.from("admin_login_attempts").insert({
    account: account.slice(0, 100),
    admin_user_id: user?.id ?? null,
    tenant_id: user?.tenant_id ?? null,
    ip: clientIp(ctx.req),
    user_agent: (ctx.req.headers.get("user-agent") || "").slice(0, 500),
    success,
    reason,
  });
  if (error) console.error("[login] 寫入登入紀錄失敗", error.message);
}

/** 15 分鐘內同帳號失敗 ≥5 次 → 鎖定，回傳剩餘秒數 */
async function lockedSeconds(account: string): Promise<number> {
  const db = getServiceClient();
  const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("admin_login_attempts")
    .select("success, created_at")
    .eq("account", account)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_FAILURES + 1);
  if (error || !data) return 0;
  let failures = 0;
  let oldestFailure: string | null = null;
  for (const r of data as { success: boolean; created_at: string }[]) {
    if (r.success) break; // 最近一次成功之後才算
    failures++;
    oldestFailure = r.created_at;
  }
  if (failures < MAX_FAILURES || !oldestFailure) return 0;
  const unlockAt = new Date(oldestFailure).getTime() + LOCK_WINDOW_MS;
  return Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000));
}

/** POST /ajax/AdminUser/login（原站表單 AdminUserForm：username、password、kmsi、wtoken、g-recaptcha-response-v3） */
export async function login(ctx: RequestContext): Promise<Response> {
  const username = ((await ctx.param("username")) ?? "").trim();
  const password = (await ctx.param("password")) ?? "";
  const kmsi = (await ctx.param("kmsi")) === "1";
  if (!username || !password) {
    return json({ code: 401, error: "請輸入帳號及密碼" }, { status: 401 });
  }
  const wait = await lockedSeconds(username);
  if (wait > 0) {
    await recordAttempt(ctx, username, false, "LOCKED");
    return json({ code: 429, error: `登入失敗次數過多，請於 ${wait} 秒後再試`, data: wait }, { status: 429 });
  }

  const db = getServiceClient();
  const { data: user, error } = await db
    .from("admin_users")
    .select("id, tenant_id, account, password_hash, is_active")
    .eq("account", username)
    .maybeSingle<AdminRow>();
  if (error) throw new Error(`查詢管理員失敗：${error.message}`);

  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    await recordAttempt(ctx, username, false, user ? "BAD_PASSWORD" : "NO_ACCOUNT", user);
    return json({ code: 401, error: "帳號或密碼錯誤" }, { status: 401 });
  }
  if (user.is_active === false) {
    await recordAttempt(ctx, username, false, "INACTIVE", user);
    return json({ code: 403, error: "此帳號已停用" }, { status: 403 });
  }

  const { cookie } = await createSession({ adminUserId: user.id, tenantId: user.tenant_id, persistent: kmsi, req: ctx.req });
  ctx.cookies.set.push(cookie);
  await db.from("admin_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
  await recordAttempt(ctx, username, true, null, user);

  // 在 /backend/AdminUser/login 頁登入 → 導回首頁；其他網址 → 前端 reload 回到原頁
  const referer = ctx.req.headers.get("referer") || "";
  const redirectUrl = /\/backend\/AdminUser\/login/.test(referer) ? "/backend/panel.do" : null;
  return json(redirectUrl ? { redirectUrl } : {});
}

/** GET /backend/AdminUser/logout */
export async function logout(ctx: RequestContext): Promise<Response> {
  await destroySession(ctx.req);
  const res = redirect("/backend/panel.do");
  res.headers.append("set-cookie", buildClearCookie(isSecureRequest(ctx.req)));
  return res;
}

/** GET /backend/AdminUser/login：已登入 → 首頁；未登入 → 登入頁（由 dispatch 的 optional 模式處理） */
export async function loginPage(ctx: RequestContext): Promise<Response> {
  const s = ctx.session ?? (await readSession(ctx.req));
  if (s) return redirect("/backend/panel.do");
  const { renderLoginPage } = await import("./auth-pages");
  return renderLoginPage(ctx);
}

/** POST /ajax/AdminUser/keepalive（gbs_api GBFAPI.keepalive 每 120 秒；未登入時 dispatch 回 401 {code:401}） */
export async function keepalive(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  return json({ code: 200 });
}

/** POST /ajax/AdminUser/auth（「繼續登入為 X」：本系統不保存可免密碼登入的記憶 token） */
export async function authRemembered(): Promise<Response> {
  return json({ code: 401, error: "請重新輸入帳號密碼登入" }, { status: 401 });
}

/** POST /ajax/AdminUser/resendWtoken（簡訊/Email 二階段驗證碼：未串接） */
export async function resendWtoken(): Promise<Response> {
  return json({ code: 400, error: "【未串接】二階段驗證碼發送：本系統未串接簡訊/Email 服務。" }, { status: 400 });
}

/** POST /ajax/GoogleRecaptcha/verify（未串接 Google reCAPTCHA：直接通過） */
export async function recaptchaVerify(): Promise<Response> {
  return json({ success: true, notIntegrated: true });
}

/**
 * GET /ajax/AdminUser/switchAdmin?username=X
 * 只能切換到「目前管理員 permissions.switchAccounts 清單內」且同租戶、啟用中的帳號。
 */
export async function switchAdmin(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const username = ((await ctx.param("username")) ?? "").trim();
  const allowed = Array.isArray(session.permissions?.switchAccounts) ? (session.permissions.switchAccounts as unknown[]).map(String) : [];
  if (!username || !allowed.includes(username)) throw forbidden("無權限切換至此帳號");
  const db = getServiceClient();
  const { data: target } = await db
    .from("admin_users")
    .select("id, tenant_id, is_active")
    .eq("account", username)
    .maybeSingle<{ id: number; tenant_id: number; is_active: boolean | null }>();
  if (!target || target.tenant_id !== session.tenantId || target.is_active === false) throw forbidden("無權限切換至此帳號");
  await switchSessionUser(session.sessionId, target.id);
  return json({ code: 200 });
}

/** POST /ajax/AdminUser/changePassword（Editor：data[0][oldPassword|password|confirmPassword]） */
export async function changePassword(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const v = req.rows[0]?.values ?? {};
  const oldPassword = String(v.oldPassword ?? "");
  const password = String(v.password ?? "");
  const confirmPassword = String(v.confirmPassword ?? "");
  const errors: { name: string; status: string }[] = [];
  if (!oldPassword) errors.push({ name: "oldPassword", status: "必填" });
  if (!password) errors.push({ name: "password", status: "必填" });
  else if (password.length < 6 || password.length > 20) errors.push({ name: "password", status: "密碼長度需為 6～20 個字元" });
  if (!confirmPassword) errors.push({ name: "confirmPassword", status: "必填" });
  else if (password && confirmPassword !== password) errors.push({ name: "confirmPassword", status: "確認密碼與密碼不一致" });
  if (errors.length) throw new FieldErrors(errors);

  const db = getServiceClient();
  const { data: user, error } = await db
    .from("admin_users")
    .select("id, password_hash")
    .eq("id", session.adminUserId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ id: number; password_hash: string }>();
  if (error || !user) throw new HttpError(404, "找不到管理員");
  if (!(await verifyPassword(oldPassword, user.password_hash))) {
    throw new FieldErrors([{ name: "oldPassword", status: "舊密碼錯誤" }]);
  }
  const hash = await hashPassword(password);
  const { error: upErr } = await db.from("admin_users").update({ password_hash: hash }).eq("id", user.id).eq("tenant_id", session.tenantId);
  if (upErr) throw new Error(`更新密碼失敗：${upErr.message}`);
  await destroyOtherSessions(user.id, session.sessionId);
  return editorResponse([{ adminUserId: user.id }]);
}
