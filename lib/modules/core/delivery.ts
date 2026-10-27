// Email／簡訊寄送 adapter（fix20）。設定與規則見 ./delivery-logic.ts 檔頭。
//
// 流程：各功能照舊寫入 email_messages／sms_messages（未串接時 status＝NOT_SENT_UNINTEGRATED）。
//   排程 /api/cron/run 的 delivery 工作（runDelivery）：
//     1) 逾時的 SENDING（租約過期）→ FAILED（結果不明，為避免重複寄送不自動重寄）
//     2) 有可用服務商的租戶：最近的 NOT_SENT_UNINTEGRATED → QUEUED（時間窗見 PROMOTE_*；歷史紀錄不會被補寄）
//     3) 取件：QUEUED → SENDING（條件式更新，同一筆只有一個執行者取得）→ 寄送 → SENT／FAILED／BLOCKED，
//        或「確定未送出」的錯誤回 QUEUED 延後重試（上限 3 次）
//   時效性訊息（登入認證碼、寄送測試信）由呼叫端寫入 QUEUED 後立即 deliverNow()；失敗則留給排程重試。
// 安全預設：沒有任何服務商設定 → 什麼都不寄（紀錄維持 NOT_SENT_UNINTEGRATED）；
//   MESSAGE_DELIVERY_MODE 未設定＝whitelist：只寄給 MESSAGE_TEST_WHITELIST，其他收件者一律 BLOCKED（攔下記錄）。
// 租戶自有信箱（系統設定「收/寄信設定」：Gmail 帳號＋應用程式密碼）：密碼以 AES-256-GCM 加密後存於 settings.passwordEnc
//   （金鑰由 SESSION_SECRET 以 HKDF 導出；SESSION_SECRET 更換後需重新輸入密碼）。
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { readSystemSettingAllTenants, readSystemSettings } from "./system-settings";
import type { MessageDelivery } from "./system-settings-logic";
import {
  CODE_TEMPLATES,
  EMAIL_RE,
  LEASE_SECONDS,
  PROMOTE_CODE_WINDOW_MS,
  PROMOTE_WINDOW_MS,
  afterFailure,
  cleanBody,
  deliveryConfigFromEnv,
  httpRetryable,
  looksHtml,
  maskRecipient,
  mitakeClientId,
  mitakeErrorText,
  normalizeEmail,
  normalizePhone,
  parseMitakeResponse,
  recipientAllowed,
  resendIdempotencyKey,
  smtpRetryable,
  tenantInScope,
  type Channel,
  type DeliveryConfig,
  type EnvEmailProvider,
  type EnvSmsProvider,
  type SendOutcome,
} from "./delivery-logic";

type Row = Record<string, unknown>;
const db = () => getServiceClient();
export const EMAIL_SETTINGS = "EMAIL_SETTINGS";
export const deliveryConfig = (): DeliveryConfig => deliveryConfigFromEnv(process.env);

/* ───────────── 租戶自有信箱密碼加解密 ───────────── */

function secretKey(): Buffer | null {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16) return null;
  return Buffer.from(hkdfSync("sha256", s, "groupbuy", "email-settings-password-v1", 32));
}
export function encryptSecret(plain: string): string | null {
  const key = secretKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}
export function decryptSecret(enc: unknown): string | null {
  const key = secretKey();
  if (!key || typeof enc !== "string" || !enc.startsWith("v1:")) return null;
  try {
    const buf = Buffer.from(enc.slice(3), "base64url");
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ───────────── 服務商解析 ───────────── */

export type EmailTransport =
  | { kind: "gmail"; user: string; pass: string; fromName: string; replyTo: string | null }
  | { kind: "env"; provider: EnvEmailProvider; fromName: string; replyTo: string | null };

const safeName = (s: unknown) => String(s ?? "").replace(/[\r\n"<>]/g, " ").trim().slice(0, 80);

interface TenantMail {
  account: string;
  password: string | null;
  name: string;
  address: string;
}
function tenantMailOf(s: Row | null | undefined): TenantMail {
  return {
    account: String(s?.account ?? "").trim(),
    password: decryptSecret(s?.passwordEnc),
    name: safeName(s?.name),
    address: String(s?.address ?? "").trim(),
  };
}

const tenantCache = new Map<number, { id: number; code: string | null }>();
async function tenantOf(id: number): Promise<{ id: number; code: string | null }> {
  const hit = tenantCache.get(id);
  if (hit) return hit;
  const { data } = await db().from("tenants").select("id, code").eq("id", id).maybeSingle<{ id: number; code: string | null }>();
  const t = { id, code: data?.code ?? null };
  tenantCache.set(id, t);
  return t;
}

function gmailTransportOf(m: TenantMail): EmailTransport | null {
  if (!m.account || !m.password || !EMAIL_RE.test(m.account)) return null;
  return { kind: "gmail", user: m.account, pass: m.password, fromName: m.name, replyTo: EMAIL_RE.test(m.address) ? m.address : null };
}

/** 租戶的寄信方式：自有信箱（已存密碼）→ 環境變數服務商（Resend／SMTP）→ null（未串接） */
export async function emailTransportFor(tenantId: number, cfg = deliveryConfig()): Promise<EmailTransport | null> {
  if (cfg.mode === "off" || !tenantInScope(cfg, await tenantOf(tenantId))) return null;
  const m = tenantMailOf((await readSystemSettings(tenantId, [EMAIL_SETTINGS])).get(EMAIL_SETTINGS));
  const own = gmailTransportOf(m);
  if (own) return own;
  if (cfg.email) return { kind: "env", provider: cfg.email, fromName: m.name, replyTo: EMAIL_RE.test(m.address) ? m.address : null };
  return null;
}
export async function smsProviderFor(tenantId: number, cfg = deliveryConfig()): Promise<EnvSmsProvider | null> {
  if (cfg.mode === "off" || !cfg.sms || !tenantInScope(cfg, await tenantOf(tenantId))) return null;
  return cfg.sms;
}

/** 系統設定／登入防呆用：該租戶 Email／簡訊是否實際可寄，以及收件者是否在可寄範圍（白名單模式） */
export async function deliveryStatus(tenantId: number): Promise<MessageDelivery> {
  const cfg = deliveryConfig();
  const [email, sms] = await Promise.all([emailTransportFor(tenantId, cfg), smsProviderFor(tenantId, cfg)]);
  return {
    email: !!email,
    sms: !!sms,
    allowEmail: (to: string) => recipientAllowed(cfg, "EMAIL", to),
    allowSms: (to: string) => recipientAllowed(cfg, "SMS", to),
  };
}

/* ───────────── 寄送（各服務商）───────────── */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

function fromAddress(t: EmailTransport): { name: string; address: string } {
  if (t.kind === "gmail") return { name: t.fromName, address: t.user };
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(t.provider.from);
  const address = m ? m[1] : t.provider.from.trim();
  const name = t.fromName || safeName(m ? t.provider.from.slice(0, m.index) : "");
  return { name, address };
}

interface EmailMsg {
  id: number;
  to: string;
  subject: string;
  body: string;
}

async function sendViaSmtp(
  opt: { host: string; port: number; secure: boolean; user: string; pass: string },
  provider: string,
  t: EmailTransport,
  msg: EmailMsg,
): Promise<SendOutcome> {
  let tr: import("nodemailer").Transporter;
  try {
    const mod = (await import("nodemailer")) as unknown as { default?: typeof import("nodemailer"); createTransport?: typeof import("nodemailer").createTransport };
    const createTransport = (mod.createTransport ?? mod.default?.createTransport)!;
    tr = createTransport({
      host: opt.host,
      port: opt.port,
      secure: opt.secure,
      auth: opt.user ? { user: opt.user, pass: opt.pass } : undefined,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
    });
  } catch (e) {
    return { ok: false, provider, retryable: true, error: `SMTP 初始化失敗：${errText(e)}` };
  }
  try {
    const html = looksHtml(msg.body);
    const info = await tr.sendMail({
      from: fromAddress(t),
      to: msg.to,
      replyTo: t.replyTo ?? undefined,
      subject: msg.subject,
      text: html ? msg.body.replace(/<[^>]+>/g, "") : msg.body,
      html: html ? msg.body : undefined,
      headers: { "X-GB-Message-Id": resendIdempotencyKey(msg.id) },
    });
    return { ok: true, provider, messageId: String(info?.messageId ?? "") || null };
  } catch (e) {
    const x = e as { code?: string; command?: string; responseCode?: number };
    return { ok: false, provider, retryable: smtpRetryable(x), error: `SMTP 寄送失敗：${errText(e)}` };
  } finally {
    tr.close();
  }
}

async function sendViaResend(p: { apiKey: string; url: string }, t: EmailTransport, msg: EmailMsg): Promise<SendOutcome> {
  const from = fromAddress(t);
  const html = looksHtml(msg.body);
  let res: Response;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": resendIdempotencyKey(msg.id) },
      body: JSON.stringify({
        from: from.name ? `${from.name} <${from.address}>` : from.address,
        to: [msg.to],
        subject: msg.subject,
        ...(html ? { html: msg.body } : { text: msg.body }),
        ...(t.replyTo ? { reply_to: t.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, provider: "resend", retryable: true, error: `Resend 連線失敗：${errText(e)}` };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) {
    let id: string | null = null;
    try {
      id = String((JSON.parse(text) as Row).id ?? "") || null;
    } catch {
      /* 非 JSON：視為成功但無編號 */
    }
    return { ok: true, provider: "resend", messageId: id };
  }
  return { ok: false, provider: "resend", retryable: httpRetryable(res.status), error: `Resend 回應 HTTP ${res.status}：${text.replace(/\s+/g, " ").slice(0, 200)}` };
}

export async function sendEmail(t: EmailTransport, msg: EmailMsg): Promise<SendOutcome> {
  if (t.kind === "gmail") {
    const host = (process.env.GMAIL_SMTP_HOST ?? "").trim() || "smtp.gmail.com";
    const port = Number(process.env.GMAIL_SMTP_PORT || 465);
    const secure = process.env.GMAIL_SMTP_SECURE ? process.env.GMAIL_SMTP_SECURE === "1" : port === 465;
    return sendViaSmtp({ host, port, secure, user: t.user, pass: t.pass }, "gmail", t, msg);
  }
  if (t.provider.kind === "resend" && t.provider.resend) return sendViaResend(t.provider.resend, t, msg);
  if (t.provider.kind === "smtp" && t.provider.smtp) return sendViaSmtp(t.provider.smtp, "smtp", t, msg);
  return { ok: false, provider: "none", retryable: false, error: "寄信服務未設定" };
}

export async function sendSms(p: EnvSmsProvider, msg: { id: number; to: string; content: string }): Promise<SendOutcome> {
  const form = new URLSearchParams({
    username: p.username,
    password: p.password,
    dstaddr: normalizePhone(msg.to),
    smbody: msg.content,
    clientid: mitakeClientId(msg.id),
  });
  const url = p.url + (p.url.includes("?") ? "&" : "?") + "CharsetURL=UTF-8";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, provider: "mitake", retryable: true, error: `三竹簡訊連線失敗：${errText(e)}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, provider: "mitake", retryable: httpRetryable(res.status), error: `三竹簡訊回應 HTTP ${res.status}` };
  const r = parseMitakeResponse(text);
  if (r.ok) return { ok: true, provider: "mitake", messageId: r.msgid };
  return { ok: false, provider: "mitake", retryable: r.retryable, error: mitakeErrorText(r.statuscode) };
}

/* ───────────── 佇列 ───────────── */

const TBL: Record<Channel, { table: string; to: string; cols: string }> = {
  EMAIL: { table: "email_messages", to: "to_email", cols: "id, tenant_id, template, to_email, subject, body, attempts" },
  SMS: { table: "sms_messages", to: "telephone", cols: "id, tenant_id, telephone, content, attempts" },
};

/** 逾時的 SENDING → FAILED（不重寄） */
async function reapStale(ch: Channel): Promise<number> {
  const { data, error } = await db()
    .from(TBL[ch].table)
    .update({ status: "FAILED", error_message: "寄送結果不明（處理逾時）；為避免重複寄送，不自動重寄", lease_holder: null, lease_until: null, updated_at: new Date().toISOString() })
    .eq("status", "SENDING")
    .lt("lease_until", new Date().toISOString())
    .select("id");
  if (error) throw new Error(`回收逾時寄送失敗：${error.message}`);
  return (data ?? []).length;
}

/** 有可用服務商的租戶：最近的未串接紀錄 → QUEUED */
async function promote(ch: Channel, tenantIds: number[], nowMs: number): Promise<number> {
  if (!tenantIds.length) return 0;
  const patch = { status: "QUEUED", updated_at: new Date(nowMs).toISOString() };
  const base = () =>
    db().from(TBL[ch].table).update(patch).eq("status", "NOT_SENT_UNINTEGRATED").eq("attempts", 0).in("tenant_id", tenantIds);
  let n = 0;
  if (ch === "EMAIL") {
    const codes = `(${CODE_TEMPLATES.join(",")})`;
    const a = await base().in("template", CODE_TEMPLATES).gte("created_at", new Date(nowMs - PROMOTE_CODE_WINDOW_MS).toISOString()).select("id");
    if (a.error) throw new Error(`轉入待寄失敗：${a.error.message}`);
    const b = await base().or(`template.is.null,template.not.in.${codes}`).gte("created_at", new Date(nowMs - PROMOTE_WINDOW_MS).toISOString()).select("id");
    if (b.error) throw new Error(`轉入待寄失敗：${b.error.message}`);
    n = (a.data ?? []).length + (b.data ?? []).length;
  } else {
    const r = await base().gte("created_at", new Date(nowMs - PROMOTE_WINDOW_MS).toISOString()).select("id");
    if (r.error) throw new Error(`轉入待寄失敗：${r.error.message}`);
    n = (r.data ?? []).length;
  }
  return n;
}

/** 取件：QUEUED → SENDING（條件式更新；同一筆只有一個執行者會拿到） */
async function claim(ch: Channel, holder: string, opt: { ids?: number[]; tenantIds?: number[]; limit: number }): Promise<Row[]> {
  const now = new Date();
  let q = db()
    .from(TBL[ch].table)
    .select("id")
    .eq("status", "QUEUED")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`);
  if (opt.ids) q = q.in("id", opt.ids.length ? opt.ids : [-1]);
  if (opt.tenantIds) q = q.in("tenant_id", opt.tenantIds.length ? opt.tenantIds : [-1]);
  const { data: cand, error } = await q.order("id").limit(opt.limit);
  if (error) throw new Error(`讀取待寄紀錄失敗：${error.message}`);
  const ids = ((cand ?? []) as Row[]).map((r) => Number(r.id));
  if (!ids.length) return [];
  const { data, error: uErr } = await db()
    .from(TBL[ch].table)
    .update({ status: "SENDING", lease_holder: holder, lease_until: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(), updated_at: now.toISOString() })
    .in("id", ids)
    .eq("status", "QUEUED")
    .select(TBL[ch].cols);
  if (uErr) throw new Error(`取件失敗：${uErr.message}`);
  return ((data ?? []) as unknown as Row[]).sort((a, b) => Number(a.id) - Number(b.id));
}

async function finish(ch: Channel, id: number, holder: string, patch: Row): Promise<void> {
  const { error } = await db()
    .from(TBL[ch].table)
    .update({ ...patch, lease_holder: null, lease_until: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "SENDING")
    .eq("lease_holder", holder);
  if (error) console.error(`[delivery] 寫回寄送結果失敗（${ch} #${id}）`, error.message);
}

export type FinalStatus = "SENT" | "FAILED" | "BLOCKED" | "QUEUED";
interface RunCtx {
  cfg: DeliveryConfig;
  holder: string;
  emailOverride?: EmailTransport;
  /** 失敗不重試（寄送測試信：用的是尚未儲存的帳密，排程重試會改用其他寄信方式） */
  noRetry?: boolean;
  emailT: Map<number, EmailTransport | null>;
  smsP: Map<number, EnvSmsProvider | null>;
}

async function processRow(ch: Channel, row: Row, rc: RunCtx): Promise<{ status: FinalStatus; error?: string }> {
  const id = Number(row.id);
  const tenantId = Number(row.tenant_id);
  const attempts = Number(row.attempts ?? 0) + 1;
  const to = String(row[TBL[ch].to] ?? "").trim();
  const done = async (status: FinalStatus, p: Row) => {
    await finish(ch, id, rc.holder, { status, attempts, ...p });
    return { status, error: typeof p.error_message === "string" ? p.error_message : undefined };
  };
  let outcome: SendOutcome;
  if (ch === "EMAIL") {
    if (!rc.emailT.has(tenantId)) rc.emailT.set(tenantId, await emailTransportFor(tenantId, rc.cfg));
    const t = rc.emailOverride ?? rc.emailT.get(tenantId) ?? null;
    if (!t) return done("FAILED", { error_message: "寄信服務未設定（未串接）" });
    if (!EMAIL_RE.test(normalizeEmail(to))) return done("FAILED", { error_message: "收件 Email 空白或格式錯誤" });
    if (!recipientAllowed(rc.cfg, "EMAIL", to)) return done("BLOCKED", { error_message: "測試收件白名單模式：收件者不在白名單，未寄出" });
    const subject = String(row.subject ?? "").replace(/[\r\n]+/g, " ").trim() || "(無主旨)";
    outcome = await sendEmail(t, { id, to, subject, body: cleanBody(row.body as string) });
  } else {
    if (!rc.smsP.has(tenantId)) rc.smsP.set(tenantId, await smsProviderFor(tenantId, rc.cfg));
    const p = rc.smsP.get(tenantId) ?? null;
    if (!p) return done("FAILED", { error_message: "簡訊服務未設定（未串接）" });
    if (!normalizePhone(to)) return done("FAILED", { error_message: "手機號碼空白或格式錯誤" });
    if (!recipientAllowed(rc.cfg, "SMS", to)) return done("BLOCKED", { error_message: "測試收件白名單模式：收件者不在白名單，未寄出" });
    outcome = await sendSms(p, { id, to, content: cleanBody(row.content as string) });
  }
  if (outcome.ok) return done("SENT", { sent_at: new Date().toISOString(), provider: outcome.provider, provider_message_id: outcome.messageId, error_message: null, next_attempt_at: null });
  const next = afterFailure(attempts, outcome.retryable && !rc.noRetry, Date.now());
  return done(next.status, { provider: outcome.provider, error_message: outcome.error, next_attempt_at: next.nextAttemptAt });
}

const newCtx = (cfg = deliveryConfig()): RunCtx => ({ cfg, holder: `${Date.now()}-${randomUUID()}`, emailT: new Map(), smsP: new Map() });

/** 立即寄出一筆（已是 QUEUED 的紀錄）；別的執行者已取走 → null */
export async function deliverNow(ch: Channel, id: number, opt: { emailOverride?: EmailTransport; noRetry?: boolean } = {}): Promise<{ status: FinalStatus; error?: string } | null> {
  const rc = newCtx();
  rc.emailOverride = opt.emailOverride;
  rc.noRetry = opt.noRetry;
  const rows = await claim(ch, rc.holder, { ids: [id], limit: 1 });
  if (!rows.length) return null;
  return processRow(ch, rows[0], rc);
}

/** 寫入一筆待寄紀錄並（可寄時）立即寄出。回傳寫入的 id 與最終狀態 */
export async function queueAndSend(
  ch: Channel,
  row: Row,
  opt: { available: boolean; emailOverride?: EmailTransport; noRetry?: boolean },
): Promise<{ id: number | null; status: FinalStatus | "NOT_SENT_UNINTEGRATED" | "SENDING"; error?: string }> {
  const { data, error } = await db()
    .from(TBL[ch].table)
    .insert({ ...row, status: opt.available ? "QUEUED" : "NOT_SENT_UNINTEGRATED" })
    .select("id")
    .single<{ id: number }>();
  if (error || !data) throw new Error(`寫入待寄紀錄失敗：${error?.message}`);
  if (!opt.available) return { id: data.id, status: "NOT_SENT_UNINTEGRATED" };
  try {
    const r = await deliverNow(ch, data.id, { emailOverride: opt.emailOverride, noRetry: opt.noRetry });
    return r ? { id: data.id, ...r } : { id: data.id, status: "SENDING" };
  } catch (e) {
    if (opt.noRetry) {
      await db().from(TBL[ch].table).update({ status: "FAILED", error_message: `寄送前發生錯誤：${errText(e)}`, lease_holder: null, lease_until: null }).eq("id", data.id).in("status", ["QUEUED", "SENDING"]);
      return { id: data.id, status: "FAILED", error: errText(e) };
    }
    console.error(`[delivery] 立即寄送失敗（${ch} #${data.id}），留給排程`, errText(e));
    // 若已取件（SENDING）但在寄出前失敗 → 退回 QUEUED 讓排程重寄
    await db().from(TBL[ch].table).update({ status: "QUEUED", lease_holder: null, lease_until: null }).eq("id", data.id).eq("status", "SENDING");
    return { id: data.id, status: "QUEUED", error: errText(e) };
  }
}

/** 已取件但沒有送出（超過時間、寄送前例外）→ 退回 QUEUED（不計次數）；delayMs>0 時延後 */
async function release(ch: Channel, id: number, holder: string, delayMs = 0): Promise<void> {
  await db()
    .from(TBL[ch].table)
    .update({ status: "QUEUED", lease_holder: null, lease_until: null, ...(delayMs ? { next_attempt_at: new Date(Date.now() + delayMs).toISOString() } : {}) })
    .eq("id", id)
    .eq("status", "SENDING")
    .eq("lease_holder", holder);
}

/**
 * 排程工作：回傳只含筆數（cron log 不露內容）。
 * deadlineMs：之後不再開始寄新的一筆（排程函式上限 60 秒；單筆最長約 28 秒逾時）。Email／簡訊每輪各取一小批輪流寄，避免一邊積壓餓死另一邊。
 */
export async function runDelivery(opt: { deadlineMs?: number; batch?: number } = {}): Promise<Row> {
  const cfg = deliveryConfig();
  const started = Date.now();
  const deadline = opt.deadlineMs ?? started + 20_000;
  const batch = opt.batch ?? 5;
  const out: Row = { mode: cfg.mode };
  const rc = newCtx(cfg);
  const chans: Channel[] = ["SMS", "EMAIL"];
  const avail = new Map<Channel, number[]>();
  const stat = (ch: Channel) => out[ch.toLowerCase()] as Row;
  const { data: tenants, error } = await db().from("tenants").select("id, code");
  if (error) throw new Error(`讀取租戶失敗：${error.message}`);
  const inScope = ((tenants ?? []) as { id: number; code: string | null }[]).filter((t) => tenantInScope(cfg, t));
  for (const ch of chans) {
    out[ch.toLowerCase()] = { reaped: await reapStale(ch), promoted: 0, sent: 0, failed: 0, blocked: 0, retry: 0, available: 0 };
    if (cfg.mode === "off") continue;
    // 可寄的租戶：環境變數服務商 → 範圍內全部租戶；Email 另含已設定自有信箱的租戶
    let ids: number[] = [];
    if (ch === "EMAIL") {
      if (cfg.email) ids = inScope.map((t) => Number(t.id));
      else {
        const own = await readSystemSettingAllTenants(EMAIL_SETTINGS);
        ids = inScope.filter((t) => gmailTransportOf(tenantMailOf(own.get(Number(t.id))))).map((t) => Number(t.id));
      }
    } else if (cfg.sms) ids = inScope.map((t) => Number(t.id));
    stat(ch).available = ids.length;
    if (!ids.length) continue;
    stat(ch).promoted = await promote(ch, ids, Date.now());
    avail.set(ch, ids);
  }
  const active = new Set(avail.keys());
  while (active.size && Date.now() < deadline) {
    for (const ch of chans) {
      if (!active.has(ch)) continue;
      const rows = await claim(ch, rc.holder, { tenantIds: avail.get(ch)!, limit: batch });
      if (!rows.length) {
        active.delete(ch);
        continue;
      }
      for (const row of rows) {
        const id = Number(row.id);
        if (Date.now() >= deadline) {
          await release(ch, id, rc.holder); // 超出時間：未送出，下次排程再寄
          continue;
        }
        try {
          const res = await processRow(ch, row, rc);
          const k = res.status === "SENT" ? "sent" : res.status === "BLOCKED" ? "blocked" : res.status === "QUEUED" ? "retry" : "failed";
          stat(ch)[k] = Number(stat(ch)[k]) + 1;
        } catch (e) {
          // processRow 只會在寄出前丟例外（讀設定失敗等；寄送本身不丟例外）→ 退回 QUEUED、延後 2 分鐘
          console.error(`[delivery] 寄送前發生錯誤（${ch} #${id}），退回待寄`, errText(e));
          await release(ch, id, rc.holder, 2 * 60_000);
          stat(ch).retry = Number(stat(ch).retry) + 1;
        }
      }
    }
  }
  out.ms = Date.now() - started;
  return out;
}

/* ───────────── 寄送測試信（系統設定「收/寄信設定」）───────────── */

export async function sendTestEmail(
  tenantId: number,
  input: { emailAddress: string; emailPassword: string },
): Promise<{ ok: boolean; message: string }> {
  const cfg = deliveryConfig();
  if (cfg.mode === "off") return { ok: false, message: "【未串接】Email 寄送已關閉（MESSAGE_DELIVERY_MODE=off），無法寄送測試信" };
  if (!tenantInScope(cfg, await tenantOf(tenantId))) return { ok: false, message: "【未串接】本租戶未開放 Email 寄送，無法寄送測試信" };
  const { count, error: cErr } = await db()
    .from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("template", "SYSTEM_TEST")
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if (cErr) throw new Error(`讀取測試信紀錄失敗：${cErr.message}`);
  if ((count ?? 0) >= 5) return { ok: false, message: "測試信寄送太頻繁，請 10 分鐘後再試" };
  const saved = tenantMailOf((await readSystemSettings(tenantId, [EMAIL_SETTINGS])).get(EMAIL_SETTINGS));
  const account = input.emailAddress.trim();
  let transport: EmailTransport | null;
  if (account) {
    if (!EMAIL_RE.test(account)) return { ok: false, message: "帳號（Email）格式錯誤" };
    const pass = input.emailPassword || (normalizeEmail(account) === normalizeEmail(saved.account) ? saved.password ?? "" : "");
    if (!pass) return { ok: false, message: "請輸入密碼" };
    transport = gmailTransportOf({ ...saved, account, password: pass });
  } else {
    transport = await emailTransportFor(tenantId, cfg);
  }
  if (!transport) {
    return { ok: false, message: "【未串接】尚未設定寄信服務（自有信箱帳號密碼，或系統 Email 服務 RESEND_API_KEY／SMTP_HOST＋MAIL_FROM），無法寄送測試信" };
  }
  // 收件者：白名單模式 → 白名單第一個 Email；正式模式 → 客服信箱或寄件帳號本身
  const to =
    cfg.mode === "whitelist"
      ? [...cfg.whitelist.emails][0] ?? ""
      : EMAIL_RE.test(saved.address) ? saved.address : transport.kind === "gmail" ? transport.user : "";
  if (!to) {
    return {
      ok: false,
      message: cfg.mode === "whitelist" ? "測試收件白名單未設定（MESSAGE_TEST_WHITELIST），為避免寄給真實收件者，不寄出測試信" : "請先填寫客服信箱[收件]",
    };
  }
  const r = await queueAndSend(
    "EMAIL",
    {
      tenant_id: tenantId,
      template: "SYSTEM_TEST",
      to_email: to,
      subject: "團購表單寄信測試",
      body: `這是一封測試信（${new Date().toISOString()}），收到代表寄信設定正常。`,
    },
    { available: true, emailOverride: transport, noRetry: true },
  );
  if (r.status === "SENT") return { ok: true, message: `測試信已寄出至 ${maskRecipient(to)}` };
  if (r.status === "BLOCKED") return { ok: false, message: "測試收件者不在白名單，未寄出" };
  if (r.status === "QUEUED" || r.status === "SENDING") return { ok: false, message: `測試信暫時無法寄出：${r.error ?? "請稍後再試"}` };
  return { ok: false, message: `測試信寄送失敗：${r.error ?? "未知錯誤"}` };
}
