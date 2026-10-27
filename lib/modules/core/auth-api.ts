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
import { getAdminSecurity } from "./system-settings";
import { needsWtoken } from "./system-settings-logic";
import { addIpWhitelist, ipWhitelisted, issueWtoken, verifyWtoken } from "./login-wtoken";

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

const PENDING_STALE_MS = 60 * 1000; // 超過 1 分鐘仍是 PENDING（請求中途中斷）→ 視同已完成的失敗
const CONCURRENT_WAIT_S = 5; // 只因「同時進行中」的請求而被擋時的提示秒數

/**
 * rows＝窗口內的失敗（含驗證中的 PENDING 與自己這筆）。超過 limit 筆（其他人已有 limit 筆）→ 鎖定。
 * 提示秒數只用已完成（或逾時）的失敗計算：鎖定若只是因為並行中的請求，回短秒數，不誤報 15 分鐘。
 */
function lockWait(rows: AttemptRow[], ownId: number, limit: number): number {
  if (rows.length <= limit) return 0;
  const staleBefore = Date.now() - PENDING_STALE_MS;
  const settled = rows.filter((r) => r.id !== ownId && (r.reason !== "PENDING" || new Date(r.created_at).getTime() < staleBefore));
  return settled.length >= limit ? waitSeconds(settled, limit) : CONCURRENT_WAIT_S;
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
    if (r.reason === "LOCKED" || r.reason === "WTOKEN_REQUIRED") continue; // 舊版鎖定紀錄、密碼正確但待輸入認證碼 → 不算失敗
    accFailures.push(r);
  }
  let wait = lockWait(accFailures, ins.id, MAX_FAILURES);

  if (!wait && ip) {
    const { data: byIp, error: ipErr } = await db
      .from("admin_login_attempts")
      .select("id, success, reason, created_at")
      .eq("ip", ip)
      .eq("success", false)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(IP_MAX_FAILURES + 50);
    if (ipErr || !byIp) {
      await db.from("admin_login_attempts").delete().eq("id", ins.id);
      throw busy();
    }
    const ipFailures = (byIp as AttemptRow[]).filter((r) => r.reason !== "LOCKED" && r.reason !== "WTOKEN_REQUIRED");
    wait = lockWait(ipFailures, ins.id, IP_MAX_FAILURES);
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
  // 原站核取方塊送 true／on／1（依瀏覽器與表單序列化方式）；任一種都視為勾選「讓我保持登入(24小時)」
  const kmsi = ["1", "true", "on"].includes(String((await ctx.param("kmsi")) ?? "").trim().toLowerCase());
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

  // 系統設定「管理員登入安全性設定」：需認證碼時，未帶或帶錯 wtoken → 485（登入頁顯示驗證碼欄）
  const sec = await getAdminSecurity(user.tenant_id);
  const ip = clientIp(ctx.req);
  if (sec.rule !== "NONE" && needsWtoken(sec, sec.rule === "IP" ? await ipWhitelisted(user.id, ip) : false)) {
    const wtoken = ((await ctx.param("wtoken")) ?? "").trim();
    if (!wtoken) {
      const r = await issueWtoken(user, sec, ip);
      await finishAttempt(attemptId, false, "WTOKEN_REQUIRED", user);
      return json(
        { code: 485, error: r.issued ? WTOKEN_ISSUED_MSG : `已產生認證碼，請於 ${r.wait} 秒後再重送`, data: r.wait },
        { status: 485 },
      );
    }
    if (!(await verifyWtoken(user.id, wtoken))) {
      await finishAttempt(attemptId, false, "BAD_WTOKEN", user);
      return json({ code: 485, error: "認證碼錯誤或已失效" }, { status: 485 });
    }
    if (sec.rule === "IP") await addIpWhitelist(user.tenant_id, user.id, ip);
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

const WTOKEN_ISSUED_MSG = "需要登入認證碼：已產生 6 碼認證碼並記入通知待寄紀錄（【未串接】Email／簡訊寄送，不會實際寄出）";

/**
 * POST /ajax/AdminUser/resendWtoken（username）：重送登入認證碼。
 * 只在該帳號「剛通過密碼驗證、尚待輸入認證碼」（10 分鐘內有 WTOKEN_REQUIRED 紀錄）時才重發，避免未驗證密碼就能洗待寄紀錄。
 * 寄送未串接：只寫入待寄紀錄。
 */
export async function resendWtoken(ctx: RequestContext): Promise<Response> {
  const username = ((await ctx.param("username")) ?? "").trim();
  const db = getServiceClient();
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: att } = username
    ? await db
        .from("admin_login_attempts")
        .select("admin_user_id")
        .eq("account", username.slice(0, 100))
        .eq("reason", "WTOKEN_REQUIRED")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
    : { data: null };
  const adminUserId = Number((att ?? [])[0]?.admin_user_id ?? 0);
  if (!adminUserId) return json({ code: 400, error: "請先輸入帳號密碼登入" }, { status: 400 });
  const { data: user } = await db.from("admin_users").select("id, tenant_id, account, is_active").eq("id", adminUserId).maybeSingle<AdminRow>();
  if (!user || user.is_active === false) return json({ code: 400, error: "請先輸入帳號密碼登入" }, { status: 400 });
  const sec = await getAdminSecurity(user.tenant_id);
  if (sec.rule === "NONE") return json({ code: 400, error: "目前不需要認證碼，請直接登入" }, { status: 400 });
  const r = await issueWtoken(user, sec, clientIp(ctx.req));
  return json({ code: 485, error: r.issued ? WTOKEN_ISSUED_MSG : `已產生認證碼，請於 ${r.wait} 秒後再重送`, data: r.wait }, { status: 485 });
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
