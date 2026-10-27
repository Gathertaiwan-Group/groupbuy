// Email／簡訊寄送：純邏輯（設定解析、白名單、錯誤分類、重試、服務商回應解析）。不連 DB、不 import 別名路徑，供單元測試直接載入。
// 使用者：lib/modules/core/delivery.ts
//
// 環境變數（全部選填；未設定任何服務商 → 維持現狀：只寫 NOT_SENT_UNINTEGRATED 紀錄、不寄出）：
//   MESSAGE_DELIVERY_MODE     off｜whitelist｜live（未設定＝whitelist：只寄給測試收件白名單，其他一律攔下記錄 BLOCKED）
//   MESSAGE_TEST_WHITELIST    測試收件白名單：Email／手機號碼，以逗號、分號、空白或換行分隔
//   MESSAGE_DELIVERY_TENANTS  只對這些租戶寄送（租戶代碼或 id，逗號分隔；未設定＝全部租戶）
//   Email（擇一，Resend 優先；租戶在系統設定「收/寄信設定」填了自有信箱帳密時，該租戶改用自有信箱）
//     RESEND_API_KEY＋MAIL_FROM（RESEND_API_URL 可改服務端點，測試用）
//     SMTP_HOST＋MAIL_FROM（SMTP_PORT 預設 587、SMTP_SECURE=1 走 TLS〔465 預設 TLS〕、SMTP_USER／SMTP_PASS）
//   簡訊：三竹簡訊 MITAKE_USERNAME＋MITAKE_PASSWORD（MITAKE_API_URL 可改服務端點，預設 https://smsapi.mitake.com.tw/api/mtk/SmSend）

export type DeliveryMode = "off" | "whitelist" | "live";
export type Channel = "EMAIL" | "SMS";

export interface EnvEmailProvider {
  kind: "resend" | "smtp";
  from: string;
  resend?: { apiKey: string; url: string };
  smtp?: { host: string; port: number; secure: boolean; user: string; pass: string };
}
export interface EnvSmsProvider {
  kind: "mitake";
  username: string;
  password: string;
  url: string;
}
export interface DeliveryConfig {
  mode: DeliveryMode;
  whitelist: { emails: Set<string>; phones: Set<string> };
  tenants: string[] | null;
  email: EnvEmailProvider | null;
  sms: EnvSmsProvider | null;
}

type Env = Record<string, string | undefined>;
const t = (v: string | undefined) => (v ?? "").trim();

export const EMAIL_RE = /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/;
export const RESEND_DEFAULT_URL = "https://api.resend.com/emails";
export const MITAKE_DEFAULT_URL = "https://smsapi.mitake.com.tw/api/mtk/SmSend";

/** 手機號碼正規化：去掉空白、-、()；+886／886 開頭改回 0 開頭。非數字 → "" */
export function normalizePhone(raw: string | null | undefined): string {
  let s = String(raw ?? "").replace(/[\s\-()]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d{6,15}$/.test(s)) return "";
  if (s.startsWith("886") && s.length === 12) s = "0" + s.slice(3);
  return s;
}
export const normalizeEmail = (raw: string | null | undefined) => String(raw ?? "").trim().toLowerCase();

export function parseWhitelist(raw: string | undefined): { emails: Set<string>; phones: Set<string> } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const part of t(raw).split(/[,;\s]+/).filter(Boolean)) {
    if (part.includes("@")) {
      if (EMAIL_RE.test(part)) emails.add(normalizeEmail(part));
    } else {
      const p = normalizePhone(part);
      if (p) phones.add(p);
    }
  }
  return { emails, phones };
}

export function deliveryConfigFromEnv(env: Env): DeliveryConfig {
  const m = t(env.MESSAGE_DELIVERY_MODE).toLowerCase();
  const mode: DeliveryMode = m === "off" || m === "live" ? m : "whitelist";
  const from = t(env.MAIL_FROM);
  let email: EnvEmailProvider | null = null;
  if (from && t(env.RESEND_API_KEY)) {
    email = { kind: "resend", from, resend: { apiKey: t(env.RESEND_API_KEY), url: t(env.RESEND_API_URL) || RESEND_DEFAULT_URL } };
  } else if (from && t(env.SMTP_HOST)) {
    const port = Number(t(env.SMTP_PORT) || 587);
    const sec = t(env.SMTP_SECURE).toLowerCase();
    email = {
      kind: "smtp",
      from,
      smtp: {
        host: t(env.SMTP_HOST),
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 587,
        secure: sec ? sec === "1" || sec === "true" : port === 465,
        user: t(env.SMTP_USER),
        pass: env.SMTP_PASS ?? "",
      },
    };
  }
  const sms: EnvSmsProvider | null =
    t(env.MITAKE_USERNAME) && t(env.MITAKE_PASSWORD)
      ? { kind: "mitake", username: t(env.MITAKE_USERNAME), password: env.MITAKE_PASSWORD ?? "", url: t(env.MITAKE_API_URL) || MITAKE_DEFAULT_URL }
      : null;
  const tenants = t(env.MESSAGE_DELIVERY_TENANTS)
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return { mode, whitelist: parseWhitelist(env.MESSAGE_TEST_WHITELIST), tenants: tenants.length ? tenants : null, email, sms };
}

/** 租戶是否在寄送範圍（MESSAGE_DELIVERY_TENANTS 未設定＝全部） */
export function tenantInScope(cfg: Pick<DeliveryConfig, "tenants">, tenant: { id: number; code?: string | null }): boolean {
  if (!cfg.tenants) return true;
  return cfg.tenants.some((x) => x === String(tenant.id) || (!!tenant.code && x.toLowerCase() === String(tenant.code).toLowerCase()));
}

/** 收件者是否可寄（live：格式正確即可；whitelist：須在白名單；off：一律不可） */
export function recipientAllowed(cfg: Pick<DeliveryConfig, "mode" | "whitelist">, channel: Channel, to: string | null | undefined): boolean {
  if (cfg.mode === "off") return false;
  if (channel === "EMAIL") {
    const e = normalizeEmail(to);
    if (!EMAIL_RE.test(e)) return false;
    return cfg.mode === "live" || cfg.whitelist.emails.has(e);
  }
  const p = normalizePhone(to);
  if (!p) return false;
  return cfg.mode === "live" || cfg.whitelist.phones.has(p);
}

/** 遮蔽收件者（回應／紀錄用）：ab***@example.com、0912***678 */
export function maskRecipient(to: string): string {
  const s = String(to ?? "");
  const at = s.indexOf("@");
  if (at > 0) return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
  if (s.length >= 7) return `${s.slice(0, 4)}***${s.slice(-3)}`;
  return "***";
}

/** 寄出前去掉系統在「未串接」時期附在內文的【未串接】提示行 */
export function cleanBody(body: string | null | undefined): string {
  return String(body ?? "")
    .split(/\r?\n/)
    .filter((l) => !l.includes("【未串接】"))
    .join("\n")
    .trim();
}
export const looksHtml = (s: string) => /<\s*(p|br|div|table|a|span|strong|b|h\d)\b[^>]*>/i.test(s);

/* ── 重試 ── */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];

export type SendOutcome =
  | { ok: true; provider: string; messageId: string | null }
  | { ok: false; provider: string; retryable: boolean; error: string };

/** 寄送失敗後的下一個狀態：可重試且未達上限 → QUEUED（延後）；否則 FAILED */
export function afterFailure(attempts: number, retryable: boolean, nowMs: number): { status: "QUEUED" | "FAILED"; nextAttemptAt: string | null } {
  if (retryable && attempts < MAX_ATTEMPTS) {
    const i = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
    return { status: "QUEUED", nextAttemptAt: new Date(nowMs + BACKOFF_MS[i]).toISOString() };
  }
  return { status: "FAILED", nextAttemptAt: null };
}

/**
 * SMTP 錯誤分類（nodemailer error：code、command、responseCode）。
 * 只有「確定還沒交出信件」的錯誤可重試：連線／DNS 失敗、連線階段逾時、MAIL FROM／RCPT TO／EHLO／AUTH 階段的 4xx 暫時性錯誤。
 * DATA 之後或不明階段的錯誤 → 不重試（避免同一封信寄兩次）。
 */
export function smtpRetryable(e: { code?: string; command?: string; responseCode?: number }): boolean {
  const code = String(e.code ?? "");
  const cmd = String(e.command ?? "").toUpperCase();
  if (code === "EDNS") return true;
  if (code === "ECONNECTION") return cmd === "CONN"; // DATA 之後斷線也會是 ECONNECTION → 可能已寄出，不重試
  if (code === "ETIMEDOUT") return cmd === "CONN";
  const rc = Number(e.responseCode ?? 0);
  const early = cmd === "CONN" || cmd === "EHLO" || cmd === "HELO" || cmd === "STARTTLS" || cmd.startsWith("AUTH") || cmd === "MAIL FROM" || cmd === "RCPT TO";
  return early && rc >= 400 && rc < 500;
}

/** HTTP 服務商（Resend 帶 Idempotency-Key、三竹帶 clientid → 重送不會重複寄）：網路錯誤、429、5xx 可重試 */
export const httpRetryable = (status: number | null) => status === null || status === 429 || status >= 500;

/**
 * 三竹簡訊 SmSend 回應（text/plain，多行 key=value）：
 *   [1]\r\nmsgid=…\r\nstatuscode=1\r\nAccountPoint=…（Duplicate=Y：clientid 重複＝先前已送出）
 * statuscode 0/1/2/4 成功；*、a、b（系統／暫時錯誤）可重試；其他（帳密錯誤 e、號碼錯誤 k…）失敗。
 */
export function parseMitakeResponse(body: string): { ok: boolean; retryable: boolean; msgid: string | null; statuscode: string; duplicate: boolean } {
  const kv = new Map<string, string>();
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const statuscode = kv.get("statuscode") ?? "";
  const duplicate = (kv.get("duplicate") ?? "").toUpperCase() === "Y";
  const ok = ["0", "1", "2", "4"].includes(statuscode) || (duplicate && !!kv.get("msgid"));
  return { ok, retryable: !ok && ["*", "a", "b"].includes(statuscode), msgid: kv.get("msgid") || null, statuscode, duplicate };
}

const MITAKE_ERRORS: Record<string, string> = {
  "*": "系統發生錯誤",
  a: "簡訊發送功能暫時停止服務",
  b: "簡訊發送功能暫時停止服務",
  c: "請輸入帳號",
  d: "請輸入密碼",
  e: "帳號、密碼錯誤",
  f: "帳號已過期",
  h: "帳號已被停用",
  k: "無效的連線位址",
  m: "必須變更密碼",
  n: "密碼已逾期",
  p: "沒有權限使用外部Http程式",
  r: "系統暫停服務",
  s: "帳務處理失敗",
  t: "簡訊已過期",
  u: "簡訊內容不得為空白",
  v: "無效的手機號碼",
  w: "查詢筆數超過上限",
  x: "發送檔案過大",
  y: "參數錯誤",
  z: "查無資料",
};
export const mitakeErrorText = (code: string) => `三竹簡訊錯誤 ${code || "?"}：${MITAKE_ERRORS[code] ?? "未知錯誤"}`;

/** 三竹 clientid（避免重複發送，最長 36 字） */
export const mitakeClientId = (id: number) => `gb-sms-${id}`;
/** Resend Idempotency-Key */
export const resendIdempotencyKey = (id: number) => `gb-email-${id}`;

/**
 * 「未串接」時期寫入的待寄紀錄（NOT_SENT_UNINTEGRATED）轉成 QUEUED 的時間窗：只轉最近的，避免一開通就把歷史紀錄全寄出。
 * 驗證碼類（時效 10～30 分鐘）只轉 25 分鐘內的；其他 6 小時內。
 */
export const PROMOTE_WINDOW_MS = 6 * 3600_000;
export const PROMOTE_CODE_WINDOW_MS = 25 * 60_000;
export const CODE_TEMPLATES = ["CUSTOMER_ACTIVATE", "CUSTOMER_RESET_PASSWORD", "ADMIN_WTOKEN"];
/** SENDING 租約：超過即視為結果不明（不重寄） */
export const LEASE_SECONDS = 120;
