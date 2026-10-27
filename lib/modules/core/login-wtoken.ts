// 管理員登入認證碼（系統設定「管理員登入安全性設定」ADMIN_SECURITY_SETTINGS）。
// rule：NONE＝不需認證碼（預設，與先前相同）；IP＝IP 不在白名單時需認證碼，認證後 IP 自動加入白名單；ALWAYS＝每次登入都需要。
// send：認證碼通知方式（USER_EMAIL／USER_SMS／SYS_EMAIL／SYS_SMS；原站 dataTable.api.min.js adminSecuritySettings）。
// 寄送（fix20）：認證碼寫入 email_messages／sms_messages。對應管道可寄（core/delivery.ts deliveryStatus）→ 寫 QUEUED 並立即寄出
//    （失敗留給排程重試）；不可寄 → 寫 NOT_SENT_UNINTEGRATED（不寄出；登入流程的防呆本來就不會在送不到時要求認證碼）。
//    管理員沒有個人 email／電話欄位 → USER_* 通知方式的收件者為空白（紀錄仍寫入）。
// 原站登入頁：回應 code 485 → 顯示「請輸入6碼驗證碼」欄與「重送驗證碼」鈕（templates/core/login.html）。
import { createHash, randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSecurity, MessageDelivery } from "./system-settings-logic";
import { wtokenDeliverable } from "./system-settings-logic";
import { queueAndSend } from "./delivery";

export const WTOKEN_TTL_MS = 10 * 60 * 1000; // 認證碼有效 10 分鐘
export const WTOKEN_RESEND_S = 120; // 重送間隔（登入頁倒數 120 秒）
const WTOKEN_MAX_ATTEMPTS = 5; // 單一認證碼最多試 5 次

const hashCode = (tokenSalt: string, code: string) => createHash("sha256").update(`${tokenSalt}:${code}`).digest("hex");

export async function ipWhitelisted(adminUserId: number, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const { data, error } = await getServiceClient().from("admin_ip_whitelists").select("id").eq("admin_user_id", adminUserId).eq("ip", ip).limit(1);
  if (error) throw new Error(`[login] 讀取 IP 白名單失敗：${error.message}`);
  return (data ?? []).length > 0;
}

export async function addIpWhitelist(tenantId: number, adminUserId: number, ip: string | null): Promise<void> {
  if (!ip) return;
  const { error } = await getServiceClient()
    .from("admin_ip_whitelists")
    .upsert({ tenant_id: tenantId, admin_user_id: adminUserId, ip: ip.slice(0, 100) }, { onConflict: "admin_user_id,ip", ignoreDuplicates: true });
  if (error) console.error("[login] 寫入 IP 白名單失敗", error.message);
}

type TokenRow = { id: number; code_hash: string; attempts: number; expires_at: string; created_at: string };

async function latestToken(adminUserId: number): Promise<TokenRow | null> {
  const { data, error } = await getServiceClient()
    .from("admin_login_tokens")
    .select("id, code_hash, attempts, expires_at, created_at")
    .eq("admin_user_id", adminUserId)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<TokenRow>();
  if (error) throw new Error(`[login] 讀取認證碼失敗：${error.message}`);
  return data ?? null;
}

/**
 * 產生認證碼並寫入待寄紀錄。距上一組有效認證碼未滿 120 秒 → 不重發，回剩餘秒數。
 * 回傳 { issued, wait }。
 */
export async function issueWtoken(
  user: { id: number; tenant_id: number; account: string },
  sec: AdminSecurity,
  ip: string | null,
  delivery: MessageDelivery,
): Promise<{ issued: boolean; wait: number; sent?: boolean; failed?: boolean }> {
  const db = getServiceClient();
  const prev = await latestToken(user.id);
  if (prev) {
    const age = (Date.now() - new Date(prev.created_at).getTime()) / 1000;
    if (age < WTOKEN_RESEND_S) return { issued: false, wait: Math.ceil(WTOKEN_RESEND_S - age) };
    await db.from("admin_login_tokens").update({ expires_at: new Date().toISOString() }).eq("id", prev.id); // 舊碼作廢
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { data: ins, error } = await db
    .from("admin_login_tokens")
    .insert({ tenant_id: user.tenant_id, admin_user_id: user.id, code_hash: "-", ip, channel: sec.send, expires_at: new Date(Date.now() + WTOKEN_TTL_MS).toISOString() })
    .select("id")
    .single<{ id: number }>();
  if (error || !ins) throw new Error(`[login] 建立認證碼失敗：${error?.message}`);
  const { error: hErr } = await db.from("admin_login_tokens").update({ code_hash: hashCode(String(ins.id), code) }).eq("id", ins.id);
  if (hErr) throw new Error(`[login] 建立認證碼失敗：${hErr.message}`);
  const text = `管理員 ${user.account} 登入認證碼：${code}（10 分鐘內有效）`;
  const sms = sec.send === "USER_SMS" || sec.send === "SYS_SMS";
  const available = wtokenDeliverable(sec, delivery);
  let sent = false;
  let failed = false;
  try {
    const r = sms
      ? await queueAndSend("SMS", { tenant_id: user.tenant_id, telephone: sec.send === "SYS_SMS" ? sec.phone || "-" : "-", content: text }, { available })
      : await queueAndSend(
          "EMAIL",
          { tenant_id: user.tenant_id, template: "ADMIN_WTOKEN", to_email: sec.send === "SYS_EMAIL" ? sec.email || null : null, subject: "管理員登入認證碼", body: text },
          { available },
        );
    sent = r.status === "SENT";
    // 確定送不出去（服務商拒絕、帳密錯誤、收件者被攔）→ 作廢這組碼；登入流程改為本次不要求認證碼（避免管理員被鎖在門外）
    failed = available && (r.status === "FAILED" || r.status === "BLOCKED");
    if (available && !sent) console.error(`[login] 認證碼未能立即寄出（${r.status}）`);
  } catch (e) {
    console.error("[login] 寫入認證碼待寄紀錄失敗", e instanceof Error ? e.message : String(e));
  }
  if (failed) await db.from("admin_login_tokens").update({ expires_at: new Date().toISOString() }).eq("id", ins.id);
  return { issued: true, wait: WTOKEN_RESEND_S, sent, failed };
}

/** 驗證認證碼：成功即作廢該碼；錯誤累計次數，超過上限作廢 */
export async function verifyWtoken(adminUserId: number, code: string): Promise<boolean> {
  const c = String(code ?? "").trim();
  if (!/^\d{6}$/.test(c)) return false;
  const tok = await latestToken(adminUserId);
  if (!tok) return false;
  const db = getServiceClient();
  if (hashCode(String(tok.id), c) === tok.code_hash) {
    const { data } = await db.from("admin_login_tokens").update({ used_at: new Date().toISOString() }).eq("id", tok.id).is("used_at", null).select("id");
    return (data ?? []).length === 1;
  }
  const attempts = tok.attempts + 1;
  await db
    .from("admin_login_tokens")
    .update(attempts >= WTOKEN_MAX_ATTEMPTS ? { attempts, expires_at: new Date().toISOString() } : { attempts })
    .eq("id", tok.id);
  return false;
}
