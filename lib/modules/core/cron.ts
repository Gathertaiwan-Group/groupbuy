// 排程端點：GET|POST /api/cron/run（Vercel Cron 每日呼叫；也可手動觸發）。
// 驗證：Authorization: Bearer <CRON_SECRET>（Vercel Cron 在專案設了 CRON_SECRET 時自動帶上）或 x-cron-secret 標頭；
//       未設定 CRON_SECRET → 503、不符 → 401。不需後台登入、不吃 CSRF（無 cookie）。
// 參數：?jobs=schedulers,posts,autoCancel,housekeeping（預設全部）。每項工作皆冪等、可重跑：
//   schedulers    跨租戶執行到期的上下架／變價排程（items/scheduler.ts runAllDueSchedulers；條件式搶占，不會重複執行）
//   posts         排程發布（status=FUTURE）的文章發佈時間已到 → 改為已發布（PUBLISH、is_published=true）
//   autoCancel    團購勾「自動取消逾期訂單」（autoCancelExpired）時，逾期未付款訂單 → 取消（補回庫存、歷程記 [系統]）
//   notifications 系統設定「通知設定」：
//                 未付款提醒（UNPAID_NOTIFICATION_SETTINGS）→ 未付款的新訂單／處理中訂單，下單後每 hours 小時一封、最多 retry 封，
//                   只寫入 email_messages（template＝UNPAID_REMINDER、status＝NOT_SENT_UNINTEGRATED），🔴不寄出任何信
//                 低庫存通知（LOW_STOCK_NOTIFICATION_SETTINGS）→ 上架中一般商品可售庫存低於門檻 → 後台站內通知（system_notifications，
//                   category＝LOW_STOCK；同商品 24 小時內只通知一次）；有填通知 email 另寫一筆待寄紀錄（不寄出）
//   housekeeping  清除過期的後台／會員 session、90 天前的登入紀錄、1 天前的前台限流計數、過期的登入認證碼
// 原站沒有可擷取的排程器畫面；工作範圍依 repo 內既有排程程式碼與 spec（SPEC.md §「訂單成立」autoCancelExpired 推論）。
// Hobby 方案 Cron 每天最多一次（vercel.json crons，保留當備援）；高頻由 GitHub Actions .github/workflows/cron.yml 每 10 分鐘呼叫。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { runAllDueSchedulers } from "@/lib/modules/items/scheduler";
import { releaseOrderStockUndoable } from "@/lib/modules/orders/order-ops";
import { cronAuthorized, isAutoCancelable, parseJobs, type CronJob } from "./cron-logic";
import { readSystemSettingAllTenants, SYS_KEYS } from "./system-settings";
import { isLowStock, lowStockNotificationOf, unpaidNotificationOf, unpaidRemindersDue } from "./system-settings-logic";

const db = () => getServiceClient();
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

/** 只用 tenantId 的系統身分（orders 的庫存工具只讀 session.tenantId） */
function systemSession(tenantId: number): AdminSession {
  return { tenantId, adminUserId: 0, sessionId: "cron", account: "[系統]", displayName: null, role: null, permissions: {}, tenantCode: "", tenantName: null, expiresAt: new Date(), persistent: false };
}

async function jobAutoCancel(): Promise<Row> {
  const gbs = await db().from("group_buys").select("id, tenant_id").eq("auto_cancel_expired", true);
  if (gbs.error) throw new Error(`讀取團購失敗：${gbs.error.message}`);
  const gbIds = (gbs.data ?? []).map((g) => Number((g as Row).id));
  if (!gbIds.length) return { groupBuys: 0, canceled: [], skipped: [] };
  const now = Date.now();
  const { data, error } = await db()
    .from("sales_orders")
    .select("id, tenant_id, group_buy_id, state, total_paid, date_payment_due")
    .in("group_buy_id", gbIds)
    .in("state", ["NEW", "PROCESSING"])
    .or("total_paid.is.null,total_paid.eq.0")
    .lt("date_payment_due", new Date(now).toISOString())
    .order("date_payment_due", { ascending: true })
    .limit(AUTO_CANCEL_BATCH);
  if (error) throw new Error(`讀取逾期訂單失敗：${error.message}`);
  const canceled: number[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const o of (data ?? []) as Row[]) {
    const id = Number(o.id);
    const tenantId = Number(o.tenant_id);
    // 執行前再讀一次（顧客可能剛付款）
    const cur = await db().from("sales_orders").select("state, total_paid, date_payment_due").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (cur.error || !cur.data || !isAutoCancelable(cur.data as never, Date.now())) {
      skipped.push({ id, reason: cur.error ? cur.error.message : "狀態已變更" });
      continue;
    }
    const stock = await releaseOrderStockUndoable(systemSession(tenantId), [id]);
    const { error: upErr } = await db().rpc("orders_admin_update", {
      p_tenant_id: tenantId,
      p_ids: [id],
      p_patch: { state: "CANCELED", date_canceled: new Date().toISOString() },
      p_admin_user_id: null,
      p_note: "逾期未付款，系統自動取消（團購設定：自動取消逾期訂單）",
      p_actor: "SYSTEM",
    });
    if (upErr) {
      await stock.undo();
      skipped.push({ id, reason: upErr.message });
      continue;
    }
    canceled.push(id);
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
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error: iErr } = await db().from("email_messages").insert(rows.slice(i, i + 200));
      if (iErr) throw new Error(`寫入未付款提醒失敗：${iErr.message}`);
    }
    (out.queued as number[]).push(...rows.map((r) => Number(r.sales_order_id)));
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
    const notes = fresh.map((i) => ({
      tenant_id: tenantId,
      admin_user_id: null,
      category: "LOW_STOCK",
      title: `低庫存通知：${String(i.title ?? "")}（可售 ${Number(i.stock_available)}，低於 ${cfg.stock}）`,
      descr: "系統設定 → 通知設定-低庫存通知",
      url: urlOf(i.id),
    }));
    const { error: nErr } = await db().from("system_notifications").insert(notes);
    if (nErr) throw new Error(`寫入站內通知失敗：${nErr.message}`);
    if (cfg.email) {
      const { error: eErr } = await db().from("email_messages").insert({
        tenant_id: tenantId,
        template: "LOW_STOCK",
        to_email: cfg.email,
        subject: `低庫存通知（${fresh.length} 項商品）`,
        body: notes.map((n) => n.title).join("\n"),
        status: "NOT_SENT_UNINTEGRATED",
      });
      if (eErr) throw new Error(`寫入低庫存待寄紀錄失敗：${eErr.message}`);
    }
    (out.notified as number[]).push(...fresh.map((i) => Number(i.id)));
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

const JOBS: Record<CronJob, () => Promise<Row>> = {
  schedulers: async () => runAllDueSchedulers() as unknown as Promise<Row>,
  posts: jobPosts,
  autoCancel: jobAutoCancel,
  notifications: jobNotifications,
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
  const results: Row = {};
  let failed = false;
  for (const job of parsed.jobs) {
    try {
      results[job] = await JOBS[job]();
    } catch (e) {
      failed = true;
      results[job] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  console.log("[cron]", JSON.stringify(results).slice(0, 2000));
  return json(
    { code: failed ? 500 : 200, startedAt: new Date(started).toISOString(), executionTime: Date.now() - started, jobs: results },
    { status: failed ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
