// 排程端點：GET|POST /api/cron/run（Vercel Cron 每日呼叫；也可手動觸發）。
// 驗證：Authorization: Bearer <CRON_SECRET>（Vercel Cron 在專案設了 CRON_SECRET 時自動帶上）或 x-cron-secret 標頭；
//       未設定 CRON_SECRET → 503、不符 → 401。不需後台登入、不吃 CSRF（無 cookie）。
// 參數：?jobs=schedulers,posts,autoCancel,housekeeping（預設全部）。每項工作皆冪等、可重跑：
//   schedulers    跨租戶執行到期的上下架／變價排程（items/scheduler.ts runAllDueSchedulers；條件式搶占，不會重複執行）
//   posts         排程發布（status=FUTURE）的文章發佈時間已到 → 改為已發布（PUBLISH、is_published=true）
//   autoCancel    團購勾「自動取消逾期訂單」（autoCancelExpired）時，逾期未付款訂單 → 取消（補回庫存、歷程記 [系統]）
//   housekeeping  清除過期的後台／會員 session、90 天前的登入紀錄、1 天前的前台限流計數
// 原站沒有可擷取的排程器畫面；工作範圍依 repo 內既有排程程式碼與 spec（SPEC.md §「訂單成立」autoCancelExpired 推論）。
// Hobby 方案 Cron 每天最多一次（vercel.json crons），其餘時間仍由各頁「惰性執行」補上（排程頁／品項列表／前台讀取前）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { runAllDueSchedulers } from "@/lib/modules/items/scheduler";
import { releaseOrderStockUndoable } from "@/lib/modules/orders/order-ops";
import { cronAuthorized, isAutoCancelable, parseJobs, type CronJob } from "./cron-logic";

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
  return out;
}

const JOBS: Record<CronJob, () => Promise<Row>> = {
  schedulers: async () => runAllDueSchedulers() as unknown as Promise<Row>,
  posts: jobPosts,
  autoCancel: jobAutoCancel,
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
