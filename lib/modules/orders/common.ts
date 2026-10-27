// orders 模組共用工具（擁有者：orders agent）。
// 所有查詢都以 session.tenantId 過濾；寫入訂單狀態一律走 adminUpdateOrders()，讓 DB 觸發器把歷程記成「ADMIN＋操作者」。
// 對外服務（Email / 簡訊 / 金流 / 物流 / 電子發票）一律不串接：只寫紀錄並回傳【未串接】提示。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { reclaimQuotaMessage } from "@/lib/modules/marketing/usage-release";
import { deliveryNotice } from "@/lib/modules/core/delivery";
import type { Row } from "@/lib/db/mapping";

export type Db = ReturnType<typeof getServiceClient>;
export const db = (): Db => getServiceClient();

/* ─────────────────────────── 參數 ─────────────────────────── */

/** "1,2,3" / ["1","2"] / "salesOrderId=1&salesOrderId=2" → [1,2,3]（去重、只留正整數、保留順序） */
export function parseIds(raw: unknown): number[] {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(push);
    String(v)
      .split(/[,&\s]+/)
      .map((x) => x.replace(/^[A-Za-z_]+=/, "").trim())
      .filter(Boolean)
      .forEach((x) => parts.push(x));
  };
  push(raw);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 讀多個可能的參數名（query＋body，含同名多值與 name[]）合併成 id 陣列 */
export async function idsParam(ctx: RequestContext, ...names: string[]): Promise<number[]> {
  const vals: string[] = [];
  for (const n of names) {
    vals.push(...(await ctx.params_all(n)));
    vals.push(...(await ctx.params_all(`${n}[]`)));
  }
  return parseIds(vals);
}

/** 讀字串參數（trim；空字串、"null"、"undefined" → ''） */
export async function strParam(ctx: RequestContext, name: string): Promise<string> {
  const v = (await ctx.param(name)) ?? "";
  const s = String(v).trim();
  return s === "null" || s === "undefined" ? "" : s;
}

/** checkbox/布林參數："true"/"1"/"on" → true */
export async function boolParam(ctx: RequestContext, name: string): Promise<boolean> {
  const v = (await strParam(ctx, name)).toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

/* ─────────────────────────── 讀取訂單 ─────────────────────────── */

export async function fetchOrders(session: AdminSession, ids: number[], select = "*"): Promise<Row[]> {
  if (!ids.length) return [];
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db()
      .from("sales_orders")
      .select(select)
      .eq("tenant_id", session.tenantId)
      .in("id", ids.slice(i, i + 500));
    if (error) throw new Error(`[orders] 讀取訂單失敗：${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
}

export async function fetchOrder(session: AdminSession, id: number | null | undefined, select = "*"): Promise<Row> {
  if (!id) throw notFound("訂單物件不存在");
  const [row] = await fetchOrders(session, [id], select);
  if (!row) throw notFound("訂單物件不存在");
  return row;
}

export async function fetchOrderByUuid(session: AdminSession, uuid: string, select = "*"): Promise<Row | null> {
  const u = uuid.trim();
  if (!u) return null;
  const { data, error } = await db()
    .from("sales_orders")
    .select(select)
    .eq("tenant_id", session.tenantId)
    .eq("uuid", u)
    .maybeSingle();
  if (error) throw new Error(`[orders] 讀取訂單失敗：${error.message}`);
  return (data as unknown as Row) ?? null;
}

/* ─────────────────────────── 寫入訂單 ─────────────────────────── */

/**
 * 以管理員身分更新訂單（DB 函式 groupbuy.orders_admin_update，見 migration 3000）。
 * - patch 用 **DB 欄位名**（state、status、total_paid、date_paid…），只更新出現的鍵。
 * - state/status/action 變動由觸發器寫入 sales_order_histories（actor=ADMIN、admin_user_id），note 會補在本次歷程上。
 * 回傳實際更新到的訂單 id。
 */
export async function adminUpdateOrders(session: AdminSession, ids: number[], patch: Row, note?: string | null): Promise<number[]> {
  if (!ids.length || !Object.keys(patch).length) return [];
  const { data, error } = await db().rpc("orders_admin_update", {
    p_tenant_id: session.tenantId,
    p_ids: ids,
    p_patch: patch,
    p_admin_user_id: session.adminUserId,
    p_note: note ?? null,
    p_actor: "ADMIN",
  });
  if (error) {
    // 還原（重新占用名額）時折扣碼／優惠活動已被其他訂單用滿：DB 觸發器擋下整筆（8004），回 400 給操作者
    const quota = reclaimQuotaMessage(error.message);
    if (quota) throw badRequest(quota);
    throw new Error(`[orders] 更新訂單失敗：${error.message}`);
  }
  return ((data ?? []) as unknown[]).map((x) => Number(typeof x === "object" && x !== null ? Object.values(x)[0] : x));
}

/** 新增一筆不改變狀態的歷程（寄信、列印、匯出、轉換…）；fromTo 可帶入狀態前後值 */
export async function addOrderHistory(
  session: AdminSession,
  salesOrderIds: number | number[],
  note: string,
  fromTo: { stateFrom?: string | null; stateTo?: string | null; statusFrom?: string | null; statusTo?: string | null; action?: string | null } = {},
): Promise<void> {
  const ids = Array.isArray(salesOrderIds) ? salesOrderIds : [salesOrderIds];
  if (!ids.length) return;
  const rows = ids.map((id) => ({
    tenant_id: session.tenantId,
    sales_order_id: id,
    state_from: fromTo.stateFrom ?? null,
    state_to: fromTo.stateTo ?? null,
    status_from: fromTo.statusFrom ?? null,
    status_to: fromTo.statusTo ?? null,
    action: fromTo.action ?? null,
    actor: "ADMIN",
    admin_user_id: session.adminUserId,
    note,
  }));
  const { error } = await db().from("sales_order_histories").insert(rows);
  if (error) throw new Error(`[orders] 寫入訂單歷程失敗：${error.message}`);
}

/**
 * 調整商品可售庫存（DB 函式 groupbuy.orders_adjust_item_stock）。qty 正數＝補回、負數＝扣除；
 * backOrder=true 調整預購可售數量（stock_back_order_available），否則調整現貨（stock_available）。
 */
export async function adjustItemStock(
  session: AdminSession,
  changes: { itemId: number | null | undefined; qty: number; backOrder: boolean }[],
): Promise<void> {
  const list = changes.filter((c) => c.itemId && c.qty).map((c) => ({ itemId: c.itemId, qty: Math.trunc(c.qty), backOrder: !!c.backOrder }));
  if (!list.length) return;
  const { error } = await db().rpc("orders_adjust_item_stock", { p_tenant_id: session.tenantId, p_changes: list });
  if (error) throw new Error(`[orders] 調整庫存失敗：${error.message}`);
}

/* ─────────────────────────── 對外服務（未串接）─────────────────────────── */

/**
 * 寫入寄信紀錄（email_messages，status=NOT_SENT_UNINTEGRATED；可寄時由排程 delivery 寄出，core/delivery.ts）。
 * 回傳提示：Email 未串接 →【未串接】文字；可寄 → 空字串。
 * contentFinal：內容已定稿（後台寄信編輯器送出、或已依系統信範本產生）→ 寄送時不再套範本。
 */
export async function recordEmail(
  session: AdminSession,
  input: { salesOrderId?: number | null; groupBuyId?: number | null; template?: string | null; toEmail?: string | null; subject?: string | null; body?: string | null; contentFinal?: boolean },
): Promise<string> {
  const { error } = await db().from("email_messages").insert({
    tenant_id: session.tenantId,
    group_buy_id: input.groupBuyId ?? null,
    sales_order_id: input.salesOrderId ?? null,
    template: input.template ?? null,
    to_email: input.toEmail ?? null,
    subject: input.subject ?? null,
    body: input.body ?? null,
    content_final: !!input.contentFinal,
    status: "NOT_SENT_UNINTEGRATED",
  });
  if (error) throw new Error(`[orders] 寫入寄信紀錄失敗：${error.message}`);
  return (await deliveryNotice(session.tenantId, "EMAIL", "Email 寄送")).message;
}

/** 寫入簡訊紀錄（sms_messages，status=NOT_SENT_UNINTEGRATED；可寄時由排程寄出），回傳提示（未串接 →【未串接】；可寄 → 空字串） */
export async function recordSms(
  session: AdminSession,
  input: { salesOrderId?: number | null; groupBuyId?: number | null; telephone: string; content: string },
): Promise<string> {
  const len = input.content.length;
  const points = len <= 70 ? 1 : Math.ceil(len / 67);
  const { error } = await db().from("sms_messages").insert({
    tenant_id: session.tenantId,
    group_buy_id: input.groupBuyId ?? null,
    sales_order_id: input.salesOrderId ?? null,
    telephone: input.telephone || "-",
    content: input.content,
    points,
    status: "NOT_SENT_UNINTEGRATED",
  });
  if (error) throw new Error(`[orders] 寫入簡訊紀錄失敗：${error.message}`);
  return (await deliveryNotice(session.tenantId, "SMS", "簡訊發送")).message;
}

/* ─────────────────────────── 狀態常數 ─────────────────────────── */

/** 進行中（可付款/出貨）的訂單階段 */
export const OPEN_STATES = ["NEW", "PROCESSING"] as const;
/** 統計/列表視為無效的階段（同 DB is_valid_order_state） */
export const INVALID_STATES = ["DRAFT", "CANCELED", "DELETED", "COMBINED", "SPLITED"] as const;
/** 已出貨相關狀態 */
export const SHIPPED_STATUSES = ["SHIPPED", "SHIPPING_EMAIL_SENT", "SHIPPING_EMAIL_FAILED"] as const;
/** 付款方式：不需先付款即可出貨（自取現場付款 8、貨到付款 16、超商付款取貨 64） */
export const PAY_ON_RECEIVE_METHODS = [8, 16, 64] as const;

/** 台灣時間今天 00:00 的 Date */
export function taipeiStartOfDay(d: Date = new Date(), addDays = 0): Date {
  const t = new Date(d.getTime() + 8 * 3600_000);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - 8 * 3600_000 + addDays * 86400_000);
}

/** "YYYY-MM-DD"（台灣日期）→ 該日 00:00（Date） */
export function taipeiDateStart(s: string): Date | null {
  const m = String(s || "").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** HTML escape（伺服器端組 HTML 片段用） */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
