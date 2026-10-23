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

const MAX_FAILURES = 5; // 同帳號 15 分鐘內失敗上限
const IP_MAX_FAILURES = 30; // 同 IP 15 分鐘內失敗上限（跨帳號猜密碼）
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const RETENTION_DAYS = 90; // 登入紀錄保存天數

type AdminRow = {
  id: number;
  tenant_id: number;
  account: string;
  password_hash: string;
  is_active: boolean | null;
};

type AttemptRow = { id: number; success: boolean; reason: string | null; created_at: string };

const busy = () => new HttpError(503, "系統忙碌，請稍後再試");

/** 依「最近 limit 筆失敗」算出還要等幾秒；未達上限回 0 */
function waitSeconds(failures: AttemptRow[], limit: number): number {
  if (failures.length < limit) return 0;
  const unlockAt = new Date(failures[limit - 1].created_at).getTime() + LOCK_WINDOW_MS;
  return Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000));
}

/**
 * 登入（與改密碼的舊密碼驗證）限流閘門。
 * 先寫一筆 PENDING 紀錄、再計數（把自己算進去）：同時送 N 個請求，也只有前 MAX_FAILURES 個能進到密碼比對。
 * - 同帳號：最近一次成功之後、15 分鐘內的失敗（含驗證中）達 5 次 → 鎖定，倒數以第 5 新的失敗 + 15 分鐘計
 * - 同 IP：15 分鐘內失敗達 30 次 → 鎖定
 * - 被鎖定的請求刪掉自己那筆（不累積、不延長鎖定）；查詢失敗一律拒絕（fail-closed）
 * 回傳 attemptId（之後用 finishAttempt 寫結果）或 wait 秒數。
 */
async function openAttempt(ctx: RequestContext, account: string): Promise<{ attemptId: number; wait: 0 } | { attemptId: null; wait: number }> {
  const db = getServiceClient();
  const ip = clientIp(ctx.req);
  const { data: ins, error: insErr } = await db
    .from("admin_login_attempts")
    .insert({
      account: account.slice(0, 100),
      ip,
      user_agent: (ctx.req.headers.get("user-agent") || "").slice(0, 500),
      success: false,
      reason: "PENDING",
    })
    .select("id")
    .single<{ id: number }>();
  if (insErr || !ins) {
    console.error("[login] 寫入登入紀錄失敗", insErr?.message);
    throw busy();
  }
  const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();

  const { data: acc, error: accErr } = await db
    .from("admin_login_attempts")
    .select("id, success, reason, created_at")
    .eq("account", account.slice(0, 100))
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (accErr || !acc) {
    await db.from("admin_login_attempts").delete().eq("id", ins.id);
    throw busy();
  }
  const accFailures: AttemptRow[] = [];
  for (const r of acc as AttemptRow[]) {
    if (r.success) break; // 最近一次成功之前的失敗不算
    if (r.reason === "LOCKED") continue; // 舊版寫入的鎖定紀錄不算失敗
    accFailures.push(r);
  }
  let wait = accFailures.length > MAX_FAILURES ? waitSeconds(accFailures.filter((r) => r.id !== ins.id), MAX_FAILURES) : 0;

  if (!wait && ip) {
    const { data: byIp, error: ipErr } = await db
      .from("admin_login_attempts")
      .select("id, success, reason, created_at")
      .eq("ip", ip)
      .eq("success", false)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(IP_MAX_FAILURES + 1);
    if (ipErr || !byIp) {
      await db.from("admin_login_attempts").delete().eq("id", ins.id);
      throw busy();
    }
    const ipFailures = (byIp as AttemptRow[]).filter((r) => r.reason !== "LOCKED");
    if (ipFailures.length > IP_MAX_FAILURES) wait = waitSeconds(ipFailures.filter((r) => r.id !== ins.id), IP_MAX_FAILURES);
  }

  if (wait > 0) {
    await db.from("admin_login_attempts").delete().eq("id", ins.id);
    return { attemptId: null, wait };
  }
  // 偶爾清掉過期的登入紀錄（約每 50 次一次）
  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
    await db.from("admin_login_attempts").delete().lt("created_at", cutoff);
  }
  return { attemptId: ins.id, wait: 0 };
}

/** 寫入驗證結果（成功、或失敗原因） */
async function finishAttempt(attemptId: number, success: boolean, reason: string | null, user?: { id: number; tenant_id: number } | null) {
  const db = getServiceClient();
  const { error } = await db
    .from("admin_login_attempts")
    .update({ success, reason, admin_user_id: user?.id ?? null, tenant_id: user?.tenant_id ?? null })
    .eq("id", attemptId);
  if (error) console.error("[login] 更新登入紀錄失敗", error.message);
}

/** POST /ajax/AdminUser/login（原站表單 AdminUserForm：username、password、kmsi、wtoken、g-recaptcha-response-v3） */
export async function login(ctx: RequestContext): Promise<Response> {
  const username = ((await ctx.param("username")) ?? "").trim();
  const password = (await ctx.param("password")) ?? "";
  const kmsi = (await ctx.param("kmsi")) === "1";
  if (!username || !password) {
    return json({ code: 401, error: "請輸入帳號及密碼" }, { status: 401 });
  }
  const gate = await openAttempt(ctx, username);
  if (gate.attemptId === null) {
    return json({ code: 429, error: `登入失敗次數過多，請於 ${gate.wait} 秒後再試`, data: gate.wait }, { status: 429 });
  }
  const attemptId = gate.attemptId;

  const db = getServiceClient();
  const { data: user, error } = await db
    .from("admin_users")
    .select("id, tenant_id, account, password_hash, is_active")
    .eq("account", username)
    .maybeSingle<AdminRow>();
  if (error) {
    await finishAttempt(attemptId, false, "ERROR");
    throw new Error(`查詢管理員失敗：${error.message}`);
  }

  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    await finishAttempt(attemptId, false, user ? "BAD_PASSWORD" : "NO_ACCOUNT", user);
    return json({ code: 401, error: "帳號或密碼錯誤" }, { status: 401 });
  }
  if (user.is_active === false) {
    await finishAttempt(attemptId, false, "INACTIVE", user);
    return json({ code: 403, error: "此帳號已停用" }, { status: 403 });
  }

  const { cookie } = await createSession({ adminUserId: user.id, tenantId: user.tenant_id, persistent: kmsi, req: ctx.req });
  ctx.cookies.set.push(cookie);
  await db.from("admin_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
  await finishAttempt(attemptId, true, null, user);

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
 * POST /ajax/AdminUser/switchAdmin（username=X）
 * 只能切換到「目前管理員 permissions.switchAccounts 清單內」且同租戶、啟用中的帳號。
 * 只收 POST：GET 會被跨站連結（頂層導覽會帶 SameSite=Lax cookie）靜默觸發。
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
  await switchSessionUser(session.sessionId, target.id, session.loginAdminUserId ?? session.adminUserId);
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
    .select("id, tenant_id, password_hash")
    .eq("id", session.adminUserId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ id: number; tenant_id: number; password_hash: string }>();
  if (error || !user) throw new HttpError(404, "找不到管理員");
  // 舊密碼驗證與登入共用同一個失敗次數上限（同帳號 15 分鐘 5 次），避免拿到 session 的人無限次猜密碼
  const gate = await openAttempt(ctx, session.account);
  if (gate.attemptId === null) {
    throw new FieldErrors([{ name: "oldPassword", status: `嘗試次數過多，請於 ${gate.wait} 秒後再試` }]);
  }
  if (!(await verifyPassword(oldPassword, user.password_hash))) {
    await finishAttempt(gate.attemptId, false, "BAD_OLD_PASSWORD", user);
    throw new FieldErrors([{ name: "oldPassword", status: "舊密碼錯誤" }]);
  }
  await finishAttempt(gate.attemptId, true, "CHANGE_PASSWORD", user);
  const hash = await hashPassword(password);
  const { error: upErr } = await db.from("admin_users").update({ password_hash: hash }).eq("id", user.id).eq("tenant_id", session.tenantId);
  if (upErr) throw new Error(`更新密碼失敗：${upErr.message}`);
  await destroyOtherSessions(user.id, session.sessionId);
  return editorResponse([{ adminUserId: user.id }]);
}
