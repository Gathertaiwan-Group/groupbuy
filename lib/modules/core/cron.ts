// 排程端點：GET|POST /api/cron/run（Vercel Cron 每日呼叫；也可手動觸發）。
// 驗證：Authorization: Bearer <CRON_SECRET>（Vercel Cron 在專案設了 CRON_SECRET 時自動帶上）或 x-cron-secret 標頭；
//       未設定 CRON_SECRET → 503、不符 → 401。不需後台登入、不吃 CSRF（無 cookie）。
// 參數：?jobs=schedulers,posts,autoCancel,notifications,delivery,einvoice,housekeeping（預設全部）。每項工作皆冪等、可重跑：
//   schedulers    跨租戶執行到期的上下架／變價排程（items/scheduler.ts runAllDueSchedulers；條件式搶占，不會重複執行）
//   posts         排程發布（status=FUTURE）的文章發佈時間已到 → 改為已發布（PUBLISH、is_published=true）
//   autoCancel    團購勾「自動取消逾期訂單」（autoCancelExpired）時，逾期未付款訂單 → 取消（補回庫存、歷程記 [系統]）
//                 fix18：每張訂單經 DB cron_auto_cancel_order（migration 8101）單一交易：鎖訂單後重新檢查仍未付款／仍逾期／
//                 仍為新訂單或處理中／團購仍勾自動取消，才補回庫存並取消；否則略過（不會誤取消剛付款的單）
//   防重入：整個執行以 cron_locks 租約包住（後到者回 skipped）；通知以 (tenant_id, dedupe_key) 唯一鍵去重
//   notifications 系統設定「通知設定」：
//                 未付款提醒（UNPAID_NOTIFICATION_SETTINGS）→ 未付款的新訂單／處理中訂單，下單後每 hours 小時一封、最多 retry 封，
//                   只寫入 email_messages（template＝UNPAID_REMINDER、status＝NOT_SENT_UNINTEGRATED），🔴不寄出任何信
//                 低庫存通知（LOW_STOCK_NOTIFICATION_SETTINGS）→ 上架中一般商品可售庫存低於門檻 → 後台站內通知（system_notifications，
//                   category＝LOW_STOCK；同商品 24 小時內只通知一次）；有填通知 email 另寫一筆待寄紀錄（由 delivery 工作寄出）
//   delivery      fix20：Email／簡訊待寄紀錄批次寄出（core/delivery.ts runDelivery：QUEUED→SENDING→SENT／FAILED／BLOCKED，
//                 最多嘗試 3 次〔含第一次〕、同一筆不重寄；未設定服務商＝不寄、紀錄維持未串接；回應只含筆數）
//   housekeeping  清除過期的後台／會員 session、90 天前的登入紀錄、1 天前的前台限流計數、過期的登入認證碼
// 原站沒有可擷取的排程器畫面；工作範圍依 repo 內既有排程程式碼與 spec（SPEC.md §「訂單成立」autoCancelExpired 推論）。
// Hobby 方案 Cron 每天最多一次（vercel.json crons，保留當備援）；高頻由 GitHub Actions .github/workflows/cron.yml 每 10 分鐘呼叫。
import { randomUUID } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { runAllDueSchedulers } from "@/lib/modules/items/scheduler";
import { runDelivery } from "./delivery";
import { processDueInvoices } from "@/lib/modules/accounting/invoices";
import { cronAuthorized, isAutoCancelable, parseJobs, type CronJob } from "./cron-logic";
import { readSystemSettingAllTenants, SYS_KEYS } from "./system-settings";
import { isLowStock, lowStockNotificationOf, unpaidNotificationOf, unpaidRemindersDue } from "./system-settings-logic";

const db = () => getServiceClient();
/** 排程防重入租約（migration 8101 cron_locks）；TTL 大於函式上限 60 秒（app/[[...path]]/route.ts maxDuration） */
const CRON_LOCK = "cron-run";
const CRON_LOCK_TTL = 120;
const AUTO_CANCEL_BATCH = 200;
type Row = Record<string, unknown>;

async function jobPosts(): Promise<Row> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("posts")
    .update({ status: "PUBLISH", is_published: true })
    .eq("status", "FUTURE")
    .lte("date_published", now)
    .select("id");
  if (error) throw new Error(`排程發布文章失敗：${error.message}`);
  return { published: (data ?? []).map((r) => Number((r as Row).id)) };
}

async function jobAutoCancel(): Promise<Row> {
  const gbs = await db().from("group_buys").select("id, tenant_id").eq("auto_cancel_expired", true);
  if (gbs.error) throw new Error(`讀取團購失敗：${gbs.error.message}`);
  const gbIds = (gbs.data ?? []).map((g) => Number((g as Row).id));
  if (!gbIds.length) return { groupBuys: 0, canceled: 0, skipped: 0 };
  const { data, error } = await db()
    .from("sales_orders")
    .select("id, tenant_id, state, total_paid, date_payment_due")
    .in("group_buy_id", gbIds)
    .in("state", ["NEW", "PROCESSING"])
    .or("total_paid.is.null,total_paid.eq.0")
    .lt("date_payment_due", new Date().toISOString())
    .order("date_payment_due", { ascending: true })
    .limit(AUTO_CANCEL_BATCH);
  if (error) throw new Error(`讀取逾期訂單失敗：${error.message}`);
  let canceled = 0;
  let skipped = 0;
  for (const o of (data ?? []) as Row[]) {
    if (!isAutoCancelable(o as never, Date.now())) {
      skipped++;
      continue;
    }
    // fix18：鎖訂單→重新檢查（仍未付款、仍逾期、仍可取消、團購仍勾自動取消）→補回庫存→取消，全在 DB 單一交易（migration 8101）
    const { data: r, error: rErr } = await db().rpc("cron_auto_cancel_order", { p_tenant_id: Number(o.tenant_id), p_id: Number(o.id) });
    if (rErr || !(r as Row | null)?.canceled) skipped++;
    else canceled++;
  }
  return { groupBuys: gbIds.length, canceled, skipped };
}

const UNPAID_BATCH = 500;
const LOW_STOCK_BATCH = 1000;

async function unpaidReminders(): Promise<Row> {
  const settings = await readSystemSettingAllTenants(SYS_KEYS.unpaid);
  const out: Row = { tenants: 0, queued: [] as number[] };
  const now = Date.now();
  for (const [tenantId, raw] of settings) {
    const cfg = unpaidNotificationOf(raw);
    if (!cfg.enabled) continue;
    (out.tenants as number)++;
    const hourMs = cfg.hours * 3600_000;
    // 只看「至少到第 1 封時間」且「最後一封到期後 2 天內」的訂單
    const { data, error } = await db()
      .from("sales_orders")
      .select("id, uuid, group_buy_id, customer_email, grand_total, created_at, date_payment_due")
      .eq("tenant_id", tenantId)
      .in("state", ["NEW", "PROCESSING"])
      .or("total_paid.is.null,total_paid.eq.0")
      .lte("created_at", new Date(now - hourMs).toISOString())
      .gte("created_at", new Date(now - hourMs * cfg.retry - 2 * 86400_000).toISOString())
      .order("created_at", { ascending: true })
      .limit(UNPAID_BATCH);
    if (error) throw new Error(`讀取未付款訂單失敗：${error.message}`);
    const orders = (data ?? []) as Row[];
    if (!orders.length) continue;
    const ids = orders.map((o) => Number(o.id));
    const { data: sent, error: sErr } = await db()
      .from("email_messages")
      .select("sales_order_id")
      .eq("tenant_id", tenantId)
      .eq("template", "UNPAID_REMINDER")
      .in("sales_order_id", ids);
    if (sErr) throw new Error(`讀取提醒紀錄失敗：${sErr.message}`);
    const count = new Map<number, number>();
    for (const r of (sent ?? []) as Row[]) count.set(Number(r.sales_order_id), (count.get(Number(r.sales_order_id)) ?? 0) + 1);
    const rows: Row[] = [];
    for (const o of orders) {
      const due = unpaidRemindersDue(new Date(String(o.created_at)).getTime(), now, cfg);
      const have = count.get(Number(o.id)) ?? 0;
      if (due <= have) continue; // 每次執行每張訂單最多補 1 封
      rows.push({
        tenant_id: tenantId,
        group_buy_id: o.group_buy_id ?? null,
        sales_order_id: o.id,
        template: "UNPAID_REMINDER",
        to_email: o.customer_email ?? null,
        subject: `未付款提醒 ${String(o.uuid ?? "")}（第 ${have + 1} 次）`,
        body: `訂單編號：${String(o.uuid ?? "")}\n訂單金額：${String(o.grand_total ?? "")}\n此訂單尚未付款，請儘速完成付款。`,
        status: "NOT_SENT_UNINTEGRATED",
        // fix18：(tenant_id, dedupe_key) 唯一 → 兩個排程同時跑也只會有一封「第 N 次」
        dedupe_key: `UNPAID_REMINDER:${Number(o.id)}:${have + 1}`,
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { data: ins, error: iErr } = await db()
        .from("email_messages")
        .upsert(rows.slice(i, i + 200), { onConflict: "tenant_id,dedupe_key", ignoreDuplicates: true })
        .select("sales_order_id");
      if (iErr) throw new Error(`寫入未付款提醒失敗：${iErr.message}`);
      (out.queued as number[]).push(...((ins ?? []) as Row[]).map((r) => Number(r.sales_order_id)));
    }
  }
  return out;
}

async function lowStockNotices(): Promise<Row> {
  const settings = await readSystemSettingAllTenants(SYS_KEYS.lowStock);
  const out: Row = { tenants: 0, notified: [] as number[] };
  for (const [tenantId, raw] of settings) {
    const cfg = lowStockNotificationOf(raw);
    if (!cfg.enabled || cfg.stock <= 0) continue;
    (out.tenants as number)++;
    const { data, error } = await db()
      .from("items")
      .select("id, title, stock_available")
      .eq("tenant_id", tenantId)
      .eq("item_type", "NORMAL")
      .or("offline.is.null,offline.eq.false")
      .lt("stock_available", cfg.stock)
      .order("id")
      .limit(LOW_STOCK_BATCH);
    if (error) throw new Error(`讀取低庫存商品失敗：${error.message}`);
    const low = ((data ?? []) as Row[]).filter((i) => isLowStock(i.stock_available as number | null, cfg));
    if (!low.length) continue;
    const urlOf = (id: unknown) => `/backend/GroupBuyItemSet/showFromChildItem?itemId=${Number(id)}`;
    const { data: recent, error: rErr } = await db()
      .from("system_notifications")
      .select("url")
      .eq("tenant_id", tenantId)
      .eq("category", "LOW_STOCK")
      .gte("created_at", new Date(Date.now() - 86400_000).toISOString());
    if (rErr) throw new Error(`讀取站內通知失敗：${rErr.message}`);
    const seen = new Set(((recent ?? []) as Row[]).map((r) => String(r.url)));
    const fresh = low.filter((i) => !seen.has(urlOf(i.id)));
    if (!fresh.length) continue;
    const bucket = Math.floor(Date.now() / 86400_000);
    const notes = fresh.map((i) => ({
      tenant_id: tenantId,
      admin_user_id: null,
      category: "LOW_STOCK",
      title: `低庫存通知：${String(i.title ?? "")}（可售 ${Number(i.stock_available)}，低於 ${cfg.stock}）`,
      descr: "系統設定 → 通知設定-低庫存通知",
      url: urlOf(i.id),
      // fix18：(tenant_id, dedupe_key) 唯一 → 同商品同一 24 小時時段只寫一次（並行排程不重複）
      dedupe_key: `LOW_STOCK:${Number(i.id)}:${bucket}`,
    }));
    const { data: insNotes, error: nErr } = await db()
      .from("system_notifications")
      .upsert(notes, { onConflict: "tenant_id,dedupe_key", ignoreDuplicates: true })
      .select("url");
    if (nErr) throw new Error(`寫入站內通知失敗：${nErr.message}`);
    const insertedUrls = new Set(((insNotes ?? []) as Row[]).map((r) => String(r.url)));
    const written = notes.filter((n) => insertedUrls.has(n.url));
    if (!written.length) continue;
    if (cfg.email) {
      const { error: eErr } = await db().from("email_messages").insert({
        tenant_id: tenantId,
        template: "LOW_STOCK",
        to_email: cfg.email,
        subject: `低庫存通知（${written.length} 項商品）`,
        body: written.map((n) => n.title).join("\n"),
        status: "NOT_SENT_UNINTEGRATED",
      });
      if (eErr) throw new Error(`寫入低庫存待寄紀錄失敗：${eErr.message}`);
    }
    (out.notified as number[]).push(...fresh.filter((i) => insertedUrls.has(urlOf(i.id))).map((i) => Number(i.id)));
  }
  return out;
}

async function jobNotifications(): Promise<Row> {
  return { unpaid: await unpaidReminders(), lowStock: await lowStockNotices() };
}

async function jobHousekeeping(): Promise<Row> {
  const now = new Date();
  const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const out: Row = {};
  const del = async (key: string, table: string, col: string, before: string) => {
    const { count, error } = await db().from(table).delete({ count: "exact" }).lt(col, before);
    out[key] = error ? `失敗：${error.message}` : count ?? 0;
  };
  await del("adminSessions", "admin_sessions", "expires_at", now.toISOString());
  await del("customerSessions", "customer_sessions", "expires_at", now.toISOString());
  await del("loginAttempts", "admin_login_attempts", "created_at", iso(90 * 86400_000));
  await del("rateLimits", "sf_rate_limits", "window_start", iso(86400_000));
  await del("loginTokens", "admin_login_tokens", "expires_at", iso(86400_000));
  return out;
}

/** fix21：到期的預約電子發票（付款後 N 日開立）送綠界開立（accounting/invoices.ts processDueInvoices；服務商未設定的團購略過） */
async function jobEinvoice(): Promise<Row> {
  const { data, error } = await db()
    .from("invoices")
    .select("tenant_id")
    .in("invoice_status", ["SEND_EINVOICE", "PENDING_EINVOICE"])
    .lte("date_einvoice", new Date().toISOString())
    .limit(500);
  if (error) throw new Error(error.message);
  const tenants = [...new Set(((data ?? []) as { tenant_id: number }[]).map((r) => r.tenant_id))];
  let sent = 0;
  for (const t of tenants) {
    if (Date.now() > cronStartedAt + 40_000) break;
    sent += await processDueInvoices(t, 20);
  }
  return { tenants: tenants.length, processed: sent };
}

let cronStartedAt = Date.now();
const JOBS: Record<CronJob, () => Promise<Row>> = {
  schedulers: async () => runAllDueSchedulers() as unknown as Promise<Row>,
  posts: jobPosts,
  autoCancel: jobAutoCancel,
  notifications: jobNotifications,
  // 排程函式上限 60 秒（cronRun 開始後 30 秒起不再開始寄新的一筆）
  delivery: () => runDelivery({ deadlineMs: cronStartedAt + 30_000 }),
  einvoice: jobEinvoice,
  housekeeping: jobHousekeeping,
};

export async function cronRun(ctx: RequestContext): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length < 16) return json({ code: 503, error: "CRON_SECRET 未設定" }, { status: 503 });
  const ok = cronAuthorized({ authorization: ctx.req.headers.get("authorization"), xCronSecret: ctx.req.headers.get("x-cron-secret") }, secret);
  if (!ok) return json({ code: 401, error: "未授權" }, { status: 401 });
  const parsed = parseJobs(ctx.query.get("jobs"));
  if ("error" in parsed) return json({ code: 400, error: parsed.error }, { status: 400 });
  const started = Date.now();
  // fix18：防重入租約（GitHub Actions 與 Vercel Cron／手動觸發同時跑時，後到者直接略過）；逾時自動失效
  const holder = `${started}-${randomUUID()}`;
  const { data: got, error: lockErr } = await db().rpc("cron_lock_acquire", { p_name: CRON_LOCK, p_holder: holder, p_ttl_seconds: CRON_LOCK_TTL });
  if (lockErr) return json({ code: 500, error: `取得排程鎖失敗：${lockErr.message}` }, { status: 500, headers: { "Cache-Control": "no-store" } });
  if (got !== true) {
    return json({ code: 200, skipped: "另一個排程執行中", startedAt: new Date(started).toISOString(), jobs: {} }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  cronStartedAt = started; // 取得租約後才設定（被略過的並行請求不影響執行中的這次）
  const results: Row = {};
  let failed = false;
  try {
    for (const job of parsed.jobs) {
      try {
        results[job] = await JOBS[job]();
      } catch (e) {
        failed = true;
        results[job] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  } finally {
    await db().rpc("cron_lock_release", { p_name: CRON_LOCK, p_holder: holder });
  }
  console.log("[cron]", JSON.stringify(results).slice(0, 2000));
  return json(
    { code: failed ? 500 : 200, startedAt: new Date(started).toISOString(), executionTime: Date.now() - started, jobs: results },
    { status: failed ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
