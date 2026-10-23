// 前台會員：登入/註冊/忘記密碼/帳號驗證（fe-customer-login-modal）。
// 原站表單以 ias_v5 initAjaxForm 送出：HTTP 200 + {code:"200", error:訊息} 為成功；其餘 code 走錯誤（登入 483＝待 Email 驗證、484＝待簡訊驗證）。
// 密碼只存 bcrypt；登入失敗限流（同帳號 15 分鐘 5 次、同 IP 15 分鐘 30 次）；Email/簡訊未串接（寫 email_messages）。
import { createHash, randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/core/auth/password";
import { HttpError, badRequest, notIntegrated } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { escapeHtml } from "@/lib/core/render/template";
import type { RequestContext } from "@/lib/core/http/types";
import { groupBuyPreferences, scopeFromTenantPath, type SfTenant } from "./site";
import { CUSTOMER_COLUMNS, createCustomerSession, type CustomerRow } from "./customer-session";
import { clean, ipOf, isEmail, isPhone, rateAllowed, rateLimit, rateRecord } from "./guard";

const CODE_TTL_MS = 30 * 60 * 1000;

function codeHash(customerUuid: string, code: string): string {
  return createHash("sha256").update(`${customerUuid}:${code}`).digest("hex");
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function body(ctx: RequestContext) {
  const b = await ctx.body();
  return (k: string) => b.flat.get(k)?.[0];
}

/** 原站登入頁文字（進階設定 LOGIN_MESSAGE_SETTINGS）可覆寫錯誤訊息 */
async function loginMessages(tenantId: number, groupBuyId: number | null) {
  const out = { notFound: "帳號或密碼錯誤", badPassword: "帳號或密碼錯誤" };
  if (!groupBuyId) return out;
  const prefs = await groupBuyPreferences(tenantId, groupBuyId);
  const s = prefs.LOGIN_MESSAGE_SETTINGS?.settings ?? {};
  if (typeof s.accountNotFoundErrorMessage === "string" && s.accountNotFoundErrorMessage.trim()) out.notFound = s.accountNotFoundErrorMessage.trim();
  if (typeof s.incorrectAccountOrPasswordErrorMessage === "string" && s.incorrectAccountOrPasswordErrorMessage.trim())
    out.badPassword = s.incorrectAccountOrPasswordErrorMessage.trim();
  return out;
}

type CustomerAuthRow = CustomerRow & { password_hash: string | null; activation_token: string | null; activate_method: string };

async function findCustomer(tenantId: number, account: string): Promise<CustomerAuthRow | null> {
  const db = getServiceClient();
  const cols = `${CUSTOMER_COLUMNS}, password_hash, activation_token, activate_method`;
  const a = account.trim();
  if (!a) return null;
  if (a.includes("@")) {
    // 不用 ilike（使用者輸入的 * / % 會變成萬用字元）；Email 一律以小寫存，舊資料大小寫不同時再精確比一次
    for (const e of Array.from(new Set([a.toLowerCase(), a]))) {
      const { data } = await db.from("customers").select(cols).eq("tenant_id", tenantId).eq("email", e).limit(1);
      if (data && data[0]) return data[0] as unknown as CustomerAuthRow;
    }
    return null;
  }
  if (/^[0-9a-f]{32}$/i.test(a)) {
    const { data } = await db.from("customers").select(cols).eq("tenant_id", tenantId).eq("uuid", a.toLowerCase()).limit(1);
    if (data && data[0]) return data[0] as unknown as CustomerAuthRow;
  }
  // 電話（同電話多筆時取最早已驗證者）
  const { data } = await db
    .from("customers")
    .select(cols)
    .eq("tenant_id", tenantId)
    .eq("telephone", a)
    .order("is_activated", { ascending: false })
    .order("id", { ascending: true })
    .limit(1);
  if (data && data[0]) return data[0] as unknown as CustomerAuthRow;
  // 會員ID（數字）
  if (/^\d{1,15}$/.test(a)) {
    const { data: d2 } = await db.from("customers").select(cols).eq("tenant_id", tenantId).eq("id", Number(a)).limit(1);
    if (d2 && d2[0]) return d2[0] as unknown as CustomerAuthRow;
  }
  return null;
}

/** 產生並「寄出」6 碼驗證碼：未串接 Email，寫 email_messages；為了讓功能可用，回應中附上測試用驗證碼 */
async function issueActivationCode(tenant: SfTenant, groupBuyId: number | null, c: { id: number; uuid: string; email: string | null }) {
  const code = newCode();
  const token = `${codeHash(c.uuid, code)}|${Date.now() + CODE_TTL_MS}`;
  const db = getServiceClient();
  await db.from("customers").update({ activation_token: token }).eq("id", c.id).eq("tenant_id", tenant.id);
  await db.from("email_messages").insert({
    tenant_id: tenant.id,
    group_buy_id: groupBuyId,
    template: "CUSTOMER_ACTIVATE",
    to_email: c.email,
    subject: "帳號認證信",
    body: `您的帳號驗證碼：${code}（30 分鐘內有效）`,
    status: "NOT_SENT_UNINTEGRATED",
  });
  const ni = notIntegrated("會員帳號認證信");
  return { code, ni };
}

export async function login(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const f = await body(ctx);
  const account = clean(f("email"), 255, "帳號");
  const password = String(f("password") ?? "");
  if (!account || !password) throw badRequest("請輸入帳號與密碼");
  if (password.length > 10 || password.length < 6) throw badRequest("密碼為 6-10 碼");
  const ip = ipOf(ctx);
  const acctKey = `login:acct:${tenant.id}:${account.toLowerCase()}`;
  const ipKey = `login:ip:${ip}`;
  if (!(await rateAllowed(acctKey, 900, 5)) || !(await rateAllowed(ipKey, 900, 30))) {
    throw new HttpError(429, "登入失敗次數過多，請 15 分鐘後再試");
  }
  const msgs = await loginMessages(tenant.id, groupBuy?.id ?? null);
  const c = await findCustomer(tenant.id, account);
  const ok = await verifyPassword(password, c?.password_hash ?? DUMMY_HASH);
  if (!c || !ok) {
    await rateRecord(acctKey, 900, 5);
    await rateRecord(ipKey, 900, 30);
    const m = c ? msgs.badPassword : msgs.notFound;
    return json({ code: 400, error: m, message: m }, { status: 400 });
  }
  if (!c.is_activated) {
    const sms = c.activate_method === "SMS";
    // 先前寄出的驗證碼仍有效就不重發（避免使用者手上的碼失效）；過期才重發
    const exp = Number(String(c.activation_token ?? "").split("|")[1] ?? 0);
    let extra = "若未收到，請按「寄送帳號認證信」重新寄送。";
    if (!(exp > Date.now())) {
      const { code, ni } = await issueActivationCode(tenant, groupBuy?.id ?? null, c);
      extra = `<br>${ni.message}（測試用驗證碼：${code}）`;
    }
    const msg = `帳號尚未完成驗證，${sms ? "驗證碼已發送簡訊" : "認證信已寄送至 " + escapeHtml(c.email ?? "")}，請輸入6碼驗證碼。${extra}`;
    return json({ code: sms ? 484 : 483, error: msg, message: msg, data: c.uuid });
  }
  await createCustomerSession(ctx, c);
  const data = await customerLoginData(tenant.id, c, safeRedirectUrl(f("redirect")));
  return json({ code: 200, error: "登入成功", message: "登入成功", data });
}

export async function signup(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const f = await body(ctx);
  const firstname = clean(f("firstname"), 50, "姓名");
  const email = clean(f("email"), 255, "電子信箱").toLowerCase();
  const telephone = clean(f("telephone"), 20, "電話");
  const birthday = clean(f("birthdayString"), 10, "生日");
  const password = String(f("password") ?? "");
  const confirm = String(f("confirmPassword") ?? "");
  if (!firstname) throw badRequest("請輸入姓名");
  if (!isEmail(email)) throw badRequest("email格式不正確，是否拼錯字，或是沒有帶小老鼠@呢？");
  if (!isPhone(telephone)) throw badRequest("電話格式不正確");
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw badRequest("生日格式不正確");
  if (birthday) {
    const d = new Date(`${birthday}T00:00:00+08:00`);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() || d.getUTCFullYear() < 1900) throw badRequest("生日格式不正確");
  }
  if (password.length < 6 || password.length > 10) throw badRequest("密碼為 6-10 碼");
  if (password !== confirm) throw badRequest("兩次輸入的密碼不一致");
  const ip = ipOf(ctx);
  await rateLimit(`signup:ip:${ip}`, 3600, 10, "註冊太頻繁，請稍後再試");

  const db = getServiceClient();
  const existing = await findCustomer(tenant.id, email);
  const hash = await hashPassword(password);
  let row: { id: number; uuid: string; email: string | null };
  if (existing && existing.is_activated) {
    throw badRequest("此電子信箱已經註冊，請直接登入或使用忘記密碼");
  } else if (existing) {
    // 尚未驗證的帳號可重新註冊（覆寫資料並重發驗證碼），避免被他人以同 Email 佔用
    const { data, error } = await db
      .from("customers")
      .update({ firstname, telephone, birthday: birthday || null, password_hash: hash })
      .eq("id", existing.id)
      .eq("tenant_id", tenant.id)
      .select("id, uuid, email")
      .single();
    if (error || !data) throw new Error(`更新會員失敗：${error?.message}`);
    row = data as typeof row;
  } else {
    const { data, error } = await db
      .from("customers")
      .insert({
        tenant_id: tenant.id,
        email,
        telephone,
        firstname,
        birthday: birthday || null,
        password_hash: hash,
        is_activated: false,
        activate_method: "EMAIL",
      })
      .select("id, uuid, email")
      .single();
    if (error || !data) {
      if (error?.code === "23505") throw badRequest("此電子信箱已經註冊，請直接登入或使用忘記密碼");
      throw new Error(`建立會員失敗：${error?.message}`);
    }
    row = data as typeof row;
  }
  const { code, ni } = await issueActivationCode(tenant, groupBuy?.id ?? null, row);
  const msg = `認證信已寄送至 ${escapeHtml(email)}，請輸入信中的6碼驗證碼完成註冊。<br>${ni.message}（測試用驗證碼：${code}）`;
  return json({ code: 200, error: msg, message: msg, data: row.uuid, notIntegrated: true });
}

export async function activate(ctx: RequestContext): Promise<Response> {
  const { tenant } = await scopeFromTenantPath(ctx);
  const f = await body(ctx);
  const uuid = clean(f("uuid"), 64, "uuid").toLowerCase();
  const token = clean(f("activateToken"), 6, "驗證碼");
  if (!/^[0-9a-f]{32}$/.test(uuid) || !/^\d{6}$/.test(token)) throw badRequest("驗證碼錯誤");
  await rateLimit(`activate:${tenant.id}:${uuid}`, 900, 6, "驗證失敗次數過多，請稍後再試");
  await rateLimit(`activate:ip:${ipOf(ctx)}`, 900, 30, "驗證失敗次數過多，請稍後再試");
  const db = getServiceClient();
  const { data: row } = await db
    .from("customers")
    .select(`${CUSTOMER_COLUMNS}, activation_token`)
    .eq("tenant_id", tenant.id)
    .eq("uuid", uuid)
    .maybeSingle();
  const c = row as (CustomerRow & { activation_token: string | null }) | null;
  if (!c) throw badRequest("驗證碼錯誤");
  if (c.is_activated) {
    // 已驗證的帳號不可只憑 uuid 登入（避免以 uuid 冒用登入）
    throw badRequest("帳號已完成驗證，請直接登入");
  }
  const [h, exp] = String(c.activation_token ?? "").split("|");
  if (!h || !(Number(exp) > Date.now()) || h !== codeHash(c.uuid, token)) throw badRequest("驗證碼錯誤或已過期，請重新寄送帳號認證信");
  await db
    .from("customers")
    .update({ is_activated: true, date_activated: new Date().toISOString(), activation_token: null })
    .eq("id", c.id)
    .eq("tenant_id", tenant.id);
  await createCustomerSession(ctx, c);
  const data = await customerLoginData(tenant.id, c, safeRedirectUrl(f("redirect")));
  return json({ code: 200, error: "帳號驗證成功，已為您登入", message: "帳號驗證成功，已為您登入", data });
}

export async function sendActivateEmail(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const f = await body(ctx);
  const uuid = clean(f("uuid"), 64, "uuid").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(uuid)) throw badRequest("找不到帳號");
  await rateLimit(`resend:${tenant.id}:${uuid}`, 600, 3, "寄送太頻繁，請稍後再試");
  const { data } = await getServiceClient()
    .from("customers")
    .select("id, uuid, email, is_activated")
    .eq("tenant_id", tenant.id)
    .eq("uuid", uuid)
    .maybeSingle();
  const c = data as { id: number; uuid: string; email: string | null; is_activated: boolean } | null;
  if (!c) throw badRequest("找不到帳號");
  if (c.is_activated) return json({ code: 200, error: "帳號已完成驗證，請直接登入", message: "帳號已完成驗證，請直接登入" });
  const { code, ni } = await issueActivationCode(tenant, groupBuy?.id ?? null, c);
  const msg = `已重新寄送帳號認證信至 ${escapeHtml(c.email ?? "")}。${ni.message}（測試用驗證碼：${code}）`;
  return json({ code: 200, error: msg, message: msg, notIntegrated: true });
}

export async function forgotPassword(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const f = await body(ctx);
  const account = clean(f("email"), 255, "電子信箱");
  if (!account) throw badRequest("請輸入電子信箱");
  await rateLimit(`forgot:ip:${ipOf(ctx)}`, 3600, 10, "操作太頻繁，請稍後再試");
  const c = await findCustomer(tenant.id, account);
  if (c && c.email) {
    // 重設連結的 token 只寫進「寄信紀錄」（未串接 Email），絕不放在回應中——否則任何人都能重設他人密碼
    const token = createHash("sha256").update(`${c.uuid}:${Date.now()}:${Math.random()}`).digest("hex");
    const db = getServiceClient();
    await db
      .from("customers")
      .update({ reset_password_token: createHash("sha256").update(token).digest("hex"), date_reset_password_expires: new Date(Date.now() + 3600_000).toISOString() })
      .eq("id", c.id)
      .eq("tenant_id", tenant.id);
    await db.from("email_messages").insert({
      tenant_id: tenant.id,
      group_buy_id: groupBuy?.id ?? null,
      template: "CUSTOMER_RESET_PASSWORD",
      to_email: c.email,
      subject: "重設密碼",
      body: `請於 1 小時內使用重設密碼代碼：${token}`,
      status: "NOT_SENT_UNINTEGRATED",
    });
  }
  const ni = notIntegrated("重設密碼信");
  const msg = `若此帳號存在，重設密碼信已寄出，請至信箱收信。<br>${ni.message}`;
  return json({ code: 200, error: msg, message: msg, notIntegrated: true });
}

/** 只接受站內相對路徑 */
function safeRedirectUrl(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > 300 || !s.startsWith("/") || s.startsWith("//") || s.includes("\\")) return null;
  return s;
}

/**
 * 登入/驗證成功回應的 data（前端 onDidLogin 讀取；每個鍵會回填同名的訂購人欄位）：
 * firstname（導覽列）、email、telephone，以及預設常用地址的 country/city/district/postcode/street。
 * 不帶 redirectUrl/nextUrl/refresh → 留在原頁、購物袋與已填資料保留（下單頁建議做法）。
 */
export async function customerLoginData(tenantId: number, c: CustomerRow, redirectUrl: string | null = null): Promise<Record<string, unknown>> {
  const { data: addr } = await getServiceClient()
    .from("customer_addresses")
    .select("country, city, district, postcode, street")
    .eq("tenant_id", tenantId)
    .eq("customer_id", c.id)
    .order("is_default", { ascending: false })
    .order("id", { ascending: true })
    .limit(1);
  const a = ((addr ?? [])[0] ?? {}) as Record<string, string | null>;
  const out: Record<string, unknown> = {
    firstname: c.firstname ?? "",
    email: c.email ?? "",
    telephone: c.telephone ?? "",
  };
  if (a.street) {
    out.country = a.country || "TW";
    out.city = a.city ?? "";
    out.district = a.district ?? "";
    out.postcode = a.postcode ?? "";
    out.street = a.street ?? "";
  }
  if (redirectUrl) out.redirectUrl = redirectUrl;
  return out;
}
