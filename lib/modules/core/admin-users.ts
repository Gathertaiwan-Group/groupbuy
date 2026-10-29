// 管理員帳號管理＋登入日誌（推導：原站「系統設定 > 管理員／登入日誌」本帳號無權限、未擷取；spec/SPEC.md §9 #1）。
// 需 permissions.adminUser。資料：groupbuy.admin_users（同租戶）、groupbuy.admin_login_attempts（保存 90 天，cron housekeeping 清理）。
//   GET  /backend/AdminUser/list                         頁面（列表＋新增/編輯/重設密碼）
//   POST /ajax/AdminUser/list                            列表（client-side）
//   POST /ajax/AdminUser/save                            Editor create：account、displayName、password、confirmPassword、active、permissions.*、switchAccounts
//   POST /ajax/AdminUser/update?adminUserId=             Editor edit：displayName、active、permissions.*、switchAccounts（停用 → 立即踢掉該帳號所有 session）
//   POST /ajax/AdminUser/resetPassword?adminUserId=      Editor edit：password、confirmPassword（踢掉該帳號所有 session；不可重設自己，請用修改密碼）
//   GET  /backend/AdminUser/loginLog                     登入日誌頁
//   POST /ajax/AdminUser/loginLog                        登入日誌列表（serverSide；表尾搜尋帳號/IP；結果篩選）
// 防呆：只能變更自己擁有的權限旗標；不能停用自己、不能拿掉自己的 adminUser；帳號全域唯一。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { FieldErrors, HttpError, badRequest, notFound } from "@/lib/core/http/errors";
import { parseEditorRequest, editorIds, editorResponse, flattenDotted } from "@/lib/core/editor/protocol";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtQuery, sanitizeLike } from "@/lib/core/datatables/query";
import { dtResponse } from "@/lib/core/datatables/response";
import { hashPassword } from "@/lib/core/auth/password";
import { destroyAllSessions } from "@/lib/core/auth/session";
import { taipeiDateTime } from "@/lib/core/time";
import {
  PERMISSIONS,
  RESTRICTIONS,
  accountError,
  loginResultLabel,
  mergePermissions,
  parseSwitchAccounts,
  passwordError,
  permOn,
} from "./admin-users-logic";

const PERM = "adminUser";

type AdminRow = {
  id: number;
  tenant_id: number;
  account: string;
  display_name: string | null;
  role: string | null;
  permissions: Record<string, unknown> | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
};

const COLS = "id, tenant_id, account, display_name, role, permissions, is_active, last_login_at, created_at";

function toApi(r: AdminRow, selfId: number): Record<string, unknown> {
  const perms = r.permissions ?? {};
  const permissions: Record<string, number> = {};
  for (const { key } of PERMISSIONS) permissions[key] = permOn(perms[key]) ? 1 : 0;
  for (const { key } of RESTRICTIONS) permissions[key] = permOn(perms[key]) ? 1 : 0;
  const sw = Array.isArray(perms.switchAccounts) ? (perms.switchAccounts as unknown[]).map(String) : [];
  return {
    adminUserId: r.id,
    account: r.account,
    displayName: r.display_name ?? "",
    role: r.role ?? "",
    active: r.is_active ? 1 : 0,
    permissions,
    permissionsString: [...PERMISSIONS, ...RESTRICTIONS].filter((p) => permissions[p.key]).map((p) => p.label).join("、"),
    switchAccounts: sw.join(","),
    dateLastLoginString: taipeiDateTime(r.last_login_at),
    dateCreatedString: taipeiDateTime(r.created_at),
    self: r.id === selfId,
  };
}

async function loadTenantAdmins(tenantId: number): Promise<AdminRow[]> {
  const { data, error } = await getServiceClient()
    .from("admin_users")
    .select(COLS)
    .eq("tenant_id", tenantId)
    .order("id", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`[AdminUser] 讀取失敗：${error.message}`);
  return (data ?? []) as AdminRow[];
}

async function listAdmins(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const s = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const rows = (await loadTenantAdmins(s.tenantId)).map((r) => toApi(r, s.adminUserId));
  return dtResponse(dt, { rows, options: {} }, started);
}

/** 「可切換帳號」只能是同租戶既有帳號 */
async function checkSwitchAccounts(tenantId: number, list: string[]): Promise<string | null> {
  if (list.length === 0) return null;
  if (list.length > 50) return "最多 50 個帳號";
  const { data, error } = await getServiceClient().from("admin_users").select("account").eq("tenant_id", tenantId).in("account", list);
  if (error) throw new Error(`[AdminUser] 讀取失敗：${error.message}`);
  const found = new Set(((data ?? []) as { account: string }[]).map((r) => r.account));
  const missing = list.filter((a) => !found.has(a));
  return missing.length ? `找不到本帳號下的管理員：${missing.join("、")}` : null;
}

function requestedPerms(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key } of PERMISSIONS) out[key] = v[`permissions.${key}`];
  return out;
}

async function saveAdmin(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("此端點只接受新增");
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const account = String(v.account ?? "").trim();
  const password = String(v.password ?? "");
  const confirm = String(v.confirmPassword ?? "");
  const errors: { name: string; status: string }[] = [];
  const aErr = accountError(account);
  if (aErr) errors.push({ name: "account", status: aErr });
  const pErr = passwordError(password);
  if (pErr) errors.push({ name: "password", status: pErr });
  else if (confirm !== password) errors.push({ name: "confirmPassword", status: "確認密碼與密碼不一致" });
  const sw = parseSwitchAccounts(v.switchAccounts, account);
  const swErr = await checkSwitchAccounts(s.tenantId, sw);
  if (swErr) errors.push({ name: "switchAccounts", status: swErr });
  if (errors.length) throw new FieldErrors(errors);

  const db = getServiceClient();
  // 帳號全域唯一（登入只輸入帳號，不分租戶）
  const { data: dup } = await db.from("admin_users").select("id").eq("account", account).maybeSingle();
  if (dup) throw new FieldErrors([{ name: "account", status: "此帳號已被使用" }]);

  const permissions = mergePermissions(s.permissions, {}, requestedPerms(v));
  for (const { key } of RESTRICTIONS) if (permOn(v[`permissions.${key}`])) permissions[key] = true;
  if (sw.length) permissions.switchAccounts = sw;
  const { data, error } = await db
    .from("admin_users")
    .insert({
      tenant_id: s.tenantId,
      account,
      password_hash: await hashPassword(password),
      display_name: String(v.displayName ?? "").trim() || account,
      role: "ADMIN",
      permissions,
      is_active: v.active === undefined ? true : permOn(v.active),
    })
    .select(COLS)
    .single();
  if (error) {
    if (error.code === "23505") throw new FieldErrors([{ name: "account", status: "此帳號已被使用" }]);
    throw new Error(`[AdminUser] 新增失敗：${error.message}`);
  }
  return editorResponse([toApi(data as AdminRow, s.adminUserId)]);
}

async function loadTarget(tenantId: number, id: number): Promise<AdminRow> {
  const { data, error } = await getServiceClient().from("admin_users").select(COLS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[AdminUser] 讀取失敗：${error.message}`);
  if (!data) throw notFound("找不到管理員");
  return data as AdminRow;
}

async function updateAdmin(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("此端點只接受修改");
  const ids = editorIds(req, "adminUserId");
  const out: unknown[] = [];
  const db = getServiceClient();
  for (const id of ids) {
    const row = req.rows.find((r) => Number(r.id) === id) ?? req.rows[0];
    const v = flattenDotted(row?.values ?? {});
    const target = await loadTarget(s.tenantId, id);
    const isSelf = target.id === s.adminUserId;
    const patch: Record<string, unknown> = {};
    const errors: { name: string; status: string }[] = [];
    if (v.displayName !== undefined) patch.display_name = String(v.displayName).trim() || target.account;
    if (v.active !== undefined) {
      const active = permOn(v.active);
      if (isSelf && !active) errors.push({ name: "active", status: "不能停用自己的帳號" });
      patch.is_active = active;
    }
    if ([...PERMISSIONS, ...RESTRICTIONS].some((p) => v[`permissions.${p.key}`] !== undefined) || v.switchAccounts !== undefined) {
      const perms = mergePermissions(s.permissions, target.permissions, requestedPerms(v));
      for (const { key, label } of RESTRICTIONS) {
        const raw = v[`permissions.${key}`];
        if (raw === undefined) continue;
        const on = permOn(raw);
        if (on === permOn(target.permissions?.[key])) continue;
        if (isSelf) errors.push({ name: `permissions.${key}`, status: `不能變更自己的「${label}」` });
        else if (on) perms[key] = true;
        else delete perms[key];
      }
      if (isSelf && !permOn(perms.adminUser)) errors.push({ name: "permissions.adminUser", status: "不能拿掉自己的管理員帳號權限" });
      if (v.switchAccounts !== undefined) {
        const sw = parseSwitchAccounts(v.switchAccounts, target.account);
        const swErr = await checkSwitchAccounts(s.tenantId, sw);
        if (swErr) errors.push({ name: "switchAccounts", status: swErr });
        if (sw.length) perms.switchAccounts = sw;
        else delete perms.switchAccounts;
      }
      patch.permissions = perms;
    }
    if (errors.length) throw new FieldErrors(errors);
    let saved = target;
    if (Object.keys(patch).length) {
      const { data, error } = await db.from("admin_users").update(patch).eq("tenant_id", s.tenantId).eq("id", id).select(COLS).single();
      if (error) throw new Error(`[AdminUser] 更新失敗：${error.message}`);
      saved = data as AdminRow;
    }
    // 停用 → 立即失效（含以此帳號登入後切換成別人的 session）
    if (target.is_active && !saved.is_active) await destroyAllSessions(id);
    out.push(toApi(saved, s.adminUserId));
  }
  return editorResponse(out);
}

async function resetPassword(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("此端點只接受修改");
  const ids = editorIds(req, "adminUserId");
  if (ids.length !== 1) throw badRequest("一次只能重設一個帳號的密碼");
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const password = String(v.password ?? "");
  const confirm = String(v.confirmPassword ?? "");
  const pErr = passwordError(password);
  if (pErr) throw new FieldErrors([{ name: "password", status: pErr }]);
  if (confirm !== password) throw new FieldErrors([{ name: "confirmPassword", status: "確認密碼與密碼不一致" }]);
  const target = await loadTarget(s.tenantId, ids[0]);
  if (target.id === s.adminUserId) throw new HttpError(400, "請使用頂列「修改密碼」變更自己的密碼");
  const { error } = await getServiceClient()
    .from("admin_users")
    .update({ password_hash: await hashPassword(password) })
    .eq("tenant_id", s.tenantId)
    .eq("id", target.id);
  if (error) throw new Error(`[AdminUser] 重設密碼失敗：${error.message}`);
  await destroyAllSessions(target.id);
  return editorResponse([toApi(target, s.adminUserId)]);
}

/* ───────────── 登入日誌 ───────────── */

const LOG_COLUMNS: Record<string, string> = {
  dateCreatedString: "created_at",
  account: "account",
  ip: "ip",
  resultString: "success",
  userAgent: "user_agent",
};

async function loginLog(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const s = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const result = String(dt.extra.result ?? "");
  const r = await dtQuery<Record<string, unknown>>(getServiceClient(), dt, {
    table: "admin_login_attempts",
    select: "id, account, ip, user_agent, success, reason, created_at",
    tenantId: s.tenantId,
    columnMap: { ...LOG_COLUMNS, id: "id" },
    searchColumns: ["account", "ip"],
    likeColumns: ["account", "ip", "user_agent"],
    defaultOrder: [{ column: "created_at", ascending: false }],
    where: (q) => {
      if (result === "success") q = q.eq("success", true);
      else if (result === "fail") q = q.eq("success", false).neq("reason", "PENDING");
      const acc = sanitizeLike(String(dt.extra.account ?? ""));
      if (acc) q = q.ilike("account", `%${acc}%`);
      return q;
    },
  });
  const rows = r.rows.map((x) => ({
    adminLoginAttemptId: Number(x.id),
    dateCreatedString: taipeiDateTime(x.created_at, true),
    account: String(x.account ?? ""),
    ip: String(x.ip ?? ""),
    userAgent: String(x.user_agent ?? ""),
    success: x.success === true,
    reason: String(x.reason ?? ""),
    resultString: loginResultLabel(x.success === true, x.reason as string | null),
  }));
  return dtResponse(dt, { rows, recordsTotal: r.recordsTotal, recordsFiltered: r.recordsFiltered }, started);
}

export const adminUserRoutes: RouteDef[] = [
  page("/backend/AdminUser/list", {
    template: "core/adminuser-list.html",
    title: "管理員帳號",
    permission: PERM,
    groupBuy: "none",
    activeHref: "/backend/SystemPreference/panel",
    data: (ctx) => ({
      permissionFields: [...PERMISSIONS.filter((p) => permOn(ctx.session.permissions?.[p.key])), ...RESTRICTIONS],
      selfAdminUserId: ctx.session.adminUserId,
    }),
  }),
  route(["GET", "POST"], "/ajax/AdminUser/list", listAdmins, { permission: PERM }),
  post("/ajax/AdminUser/save", saveAdmin, { permission: PERM }),
  post("/ajax/AdminUser/update", updateAdmin, { permission: PERM }),
  post("/ajax/AdminUser/resetPassword", resetPassword, { permission: PERM }),
  page("/backend/AdminUser/loginLog", {
    template: "core/adminloginlog-list.html",
    title: "登入日誌",
    permission: PERM,
    groupBuy: "none",
    activeHref: "/backend/SystemPreference/panel",
  }),
  route(["GET", "POST"], "/ajax/AdminUser/loginLog", loginLog, { permission: PERM }),
];
