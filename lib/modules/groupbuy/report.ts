// 團購業績報表 /rp/{token}（公開、以報表 token 授權）。原站結構見 spec/GAP_SPEC.md §4（原始 HTML 被擷取過濾擋下，依 id／可見文字重建）。
// 網址格式（gbs_api.min.js GBAPI.showReportUrl）：
//   /rp/{uuid}{password}  報表網址（任何有網址的人可看）；團購沒設報表密碼時＝/rp/{uuid}
//   /rp/{uuid}x           報表網址(需授權)：臉書登入申請授權＝【未串接】，顯示說明
//   /rp/{uuid}            側欄「銷售報表」連結（lib/core/groupbuy-menu.ts groupBuyReportToken）→ 有密碼時輸入報表密碼
// 端點（公開；以 rp token 授權，token 不對一律 403、不洩漏任何資料）：
//   POST /{t}/ajax/SalesOrder/report?rp=           訂單表格（DataTables legacy 參數＋filter-* 篩選＋dateCreatedBegin 銷售月份），回應另含 b2sTotal
//   GET  /{t}/ajax/GroupBuyDailyStatistics/chartData?rp=&today=&fromday=  近 14 天圖表 {data:{labels,chartData},…}
// 以 uuid（32 位 hex，全域唯一）找團購後，其餘查詢一律以該團購的 tenant_id／group_buy_id 過濾。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, route } from "@/lib/core/http/route-helpers";
import { html, json, jsonError, redirect } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { groupBuyDerived } from "@/lib/db/derived";
import { enumOptions } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtQuery, sanitizeLike, type AnyQuery } from "@/lib/core/datatables/query";
import { dtResponse } from "@/lib/core/datatables/response";

type GbRow = {
  id: number;
  tenant_id: number;
  uuid: string;
  title: string;
  short_url: string | null;
  password: string | null;
  date_start: string | null;
  date_end: string | null;
  group_buy_settings: Record<string, unknown> | null;
  group_buy_statistics: Record<string, unknown> | null;
};

/** 報表表格不列出的訂單：草稿（購物車）與已刪除 */
const HIDDEN_STATES = ["DRAFT", "DELETED"];

const money = (v: unknown) => Math.round(Number(v) || 0).toLocaleString("en-US");

function maskName(s: string): string {
  const chars = [...s];
  if (chars.length <= 1) return s;
  if (chars.length === 2) return chars[0] + "*";
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}
function maskEmail(s: string): string {
  const at = s.indexOf("@");
  if (at <= 0) return s ? maskName(s) : s;
  const user = s.slice(0, at);
  return (user.length <= 2 ? user[0] + "*" : user.slice(0, 2) + "*".repeat(Math.min(user.length - 2, 6))) + s.slice(at);
}

async function findByUuid(uuid: string): Promise<GbRow | null> {
  if (!/^[0-9a-f]{32}$/.test(uuid)) return null;
  const { data } = await getServiceClient()
    .from("group_buys")
    .select("id, tenant_id, uuid, title, short_url, password, date_start, date_end, group_buy_settings, group_buy_statistics")
    .eq("uuid", uuid)
    .maybeSingle<GbRow>();
  return data ?? null;
}

/** 報表 token 驗證：uuid＋報表密碼（沒設密碼時＝uuid）。不符回 null（含需授權的 …x 網址） */
async function authorize(token: string | undefined | null): Promise<GbRow | null> {
  const t = String(token ?? "");
  if (t.length < 32 || t.length > 32 + 60) return null;
  const gb = await findByUuid(t.slice(0, 32));
  if (!gb) return null;
  return t.slice(32) === (gb.password ?? "") ? gb : null;
}

function denied(): Response {
  return jsonError(403, "報表網址不正確或報表密碼已更換");
}

// ───────────────────────── 頁面 ─────────────────────────

function gbView(gb: GbRow) {
  const d = groupBuyDerived(gb as unknown as Record<string, unknown>);
  return {
    groupBuyId: gb.id,
    title: gb.title,
    shortUrl: gb.short_url ?? "",
    dateStartString: taipeiDateTime(gb.date_start),
    dateEndString: taipeiDateTime(gb.date_end),
    processing: d.processing,
    notStarted: d.notStarted,
  };
}

function statsOf(gb: GbRow) {
  const st = gb.group_buy_statistics ?? {};
  return {
    orders: Number(st.orders ?? 0),
    paidOrders: Number(st.paidOrders ?? 0),
    revenue: money(st.revenue),
    revenueWithoutShipping: money(st.revenueWithoutShipping),
    paidTotal: money(st.paidTotal),
    paidTotalWithoutShipping: money(st.paidTotalWithoutShipping),
  };
}

function page(data: Record<string, unknown>, status = 200): Response {
  return html(renderTemplate("groupbuy/report.html", { year: new Date().getFullYear(), ...data }), {
    status,
    headers: { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" },
  });
}

async function reportPage(ctx: RequestContext): Promise<Response> {
  const token = decodeURIComponent(ctx.params.token ?? "");
  const uuid = token.slice(0, 32);
  const suffix = token.slice(32);
  const gb = await findByUuid(uuid);
  if (!gb) return page({ errorMessage: "找不到此團購報表，請確認報表網址。" }, 404);
  const view = gbView(gb);
  const password = gb.password ?? "";

  if (ctx.method === "POST") {
    const input = String((await ctx.param("password")) ?? "");
    if (password && input === password) return redirect(`/rp/${uuid}${encodeURIComponent(password)}`, 303);
    return page({ groupBuy: view, token: uuid, needPassword: true, errorMessage: "報表密碼錯誤" }, 403);
  }
  if (suffix === "x") return page({ groupBuy: view, needAuth: true });
  if (suffix === "" && password) return page({ groupBuy: view, token: uuid, needPassword: true });
  if (suffix !== password) {
    return page({ groupBuy: view, token: uuid, needPassword: true, errorMessage: "報表密碼錯誤或已更換，請重新輸入" }, 403);
  }
  const [status, state, paymentMethod] = await Promise.all([
    enumOptions("SalesOrder.status"),
    enumOptions("SalesOrder.state"),
    enumOptions("SalesOrder.paymentMethod", true),
  ]);
  return page({
    groupBuy: view,
    report: true,
    rp: uuid + password,
    stats: statsOf(gb),
    filterOptions: { status, state, paymentMethod },
  });
}

// ───────────────────────── 訂單表格 ─────────────────────────

const COLUMN_MAP: Record<string, string> = {
  uuid: "uuid",
  dateCreatedString: "created_at",
  customerFirstname: "customer_firstname",
  "salesOrderBillingAddress.fbNickname": "billing_fb_nickname",
  customerEmail: "customer_email",
  status: "status",
  state: "state",
  paymentMethod: "payment_method",
  grandTotal: "grand_total",
};

/** 「銷售月份」YYYY-MM → 台灣時間該月起訖（UTC ISO） */
function monthRange(v: string): [string, string] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const start = new Date(Date.UTC(y, mo - 1, 1) - 8 * 3600000);
  const end = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - 8 * 3600000);
  return [start.toISOString(), end.toISOString()];
}

function filtersOf(extra: Record<string, string>) {
  const f = (k: string) => String(extra[`filter-${k}`] ?? "").trim();
  return {
    uuid: sanitizeLike(f("uuid")),
    customerFirstname: sanitizeLike(f("customerFirstname")),
    fbNickname: sanitizeLike(f("salesOrderBillingAddress.fbNickname")),
    customerEmail: sanitizeLike(f("customerEmail")),
    status: f("status"),
    state: f("state"),
    paymentMethod: f("paymentMethod"),
    month: monthRange(String(extra.dateCreatedBegin ?? "")),
  };
}

function applyFilters(q: AnyQuery, gb: GbRow, fl: ReturnType<typeof filtersOf> | null): AnyQuery {
  q = q.eq("group_buy_id", gb.id).not("state", "in", `(${HIDDEN_STATES.join(",")})`);
  if (!fl) return q;
  if (fl.uuid) q = q.ilike("uuid", `%${fl.uuid}%`);
  if (fl.customerFirstname) q = q.ilike("customer_firstname", `%${fl.customerFirstname}%`);
  if (fl.fbNickname) q = q.ilike("billing_fb_nickname", `%${fl.fbNickname}%`);
  if (fl.customerEmail) q = q.ilike("customer_email", `%${fl.customerEmail}%`);
  if (fl.status) q = q.eq("status", fl.status);
  if (fl.state) q = q.eq("state", fl.state);
  if (fl.paymentMethod && /^\d{1,4}$/.test(fl.paymentMethod)) q = q.eq("payment_method", Number(fl.paymentMethod));
  if (fl.month) q = q.gte("created_at", fl.month[0]).lt("created_at", fl.month[1]);
  return q;
}

type OrderRow = {
  id: number;
  uuid: string;
  created_at: string;
  customer_firstname: string | null;
  billing_fb_nickname: string | null;
  customer_email: string | null;
  status: string;
  state: string;
  payment_method: number | null;
  grand_total: number;
};

async function salesOrderReport(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const dt = await parseDtRequest(ctx);
  const gb = await authorize(dt.extra.rp ?? (await ctx.param("rp")));
  if (!gb) return denied();
  const db = getServiceClient();
  const fl = filtersOf(dt.extra);
  const privacy = gb.group_buy_settings?.reportPrivacyEnabled === true;

  const result = await dtQuery<OrderRow>(db, { ...dt, search: "", columns: dt.columns.map((c) => ({ ...c, search: "" })) }, {
    table: "sales_orders",
    select: "id, uuid, created_at, customer_firstname, billing_fb_nickname, customer_email, status, state, payment_method, grand_total",
    tenantId: gb.tenant_id,
    columnMap: { ...COLUMN_MAP, id: "id" },
    where: (q) => applyFilters(q, gb, fl),
    defaultOrder: [{ column: "created_at", ascending: false }],
  });

  // recordsTotal：未套篩選的筆數；b2sTotal（推導）：符合篩選的訂單結帳金額合計
  const { count: total } = await applyFilters(
    db.from("sales_orders").select("id", { count: "exact", head: true }).eq("tenant_id", gb.tenant_id),
    gb,
    null,
  );
  let b2sTotal = 0;
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await applyFilters(
      db.from("sales_orders").select("grand_total").eq("tenant_id", gb.tenant_id),
      gb,
      fl,
    )
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`[report] 合計失敗：${error.message}`);
    const rows = (data ?? []) as { grand_total: number }[];
    for (const r of rows) b2sTotal += Number(r.grand_total) || 0;
    if (rows.length < 1000) break;
  }

  const rows = result.rows.map((o) => ({
    salesOrderId: o.id,
    uuid: o.uuid,
    dateCreatedString: taipeiDateTime(o.created_at),
    customerFirstname: privacy ? maskName(o.customer_firstname ?? "") : o.customer_firstname ?? "",
    salesOrderBillingAddress: { fbNickname: privacy ? maskName(o.billing_fb_nickname ?? "") : o.billing_fb_nickname ?? "" },
    customerEmail: privacy ? maskEmail(o.customer_email ?? "") : o.customer_email ?? "",
    status: o.status,
    state: o.state,
    paymentMethod: o.payment_method ?? 0,
    grandTotal: Number(o.grand_total) || 0,
  }));
  return dtResponse(
    dt,
    { rows, recordsTotal: total ?? result.recordsFiltered, recordsFiltered: result.recordsFiltered, extra: { b2sTotal } },
    startedAt,
  );
}

// ───────────────────────── 每日圖表 ─────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86400000;

async function chartData(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const gb = await authorize(await ctx.param("rp"));
  if (!gb) return denied();
  const todayTw = taipeiDate(new Date());
  let today = String((await ctx.param("today")) ?? "");
  let fromday = String((await ctx.param("fromday")) ?? "");
  if (!ISO.test(today) || Number.isNaN(Date.parse(today))) today = todayTw;
  if (!ISO.test(fromday) || Number.isNaN(Date.parse(fromday))) fromday = new Date(Date.parse(today) - 14 * dayMs).toISOString().slice(0, 10);
  if (fromday > today) [fromday, today] = [today, fromday];
  // 最多 92 天，避免任意大範圍
  if ((Date.parse(today) - Date.parse(fromday)) / dayMs > 92) fromday = new Date(Date.parse(today) - 92 * dayMs).toISOString().slice(0, 10);

  const { data, error } = await getServiceClient()
    .from("group_buy_daily_statistics")
    .select("date_statistics, amount_sales, count_sales")
    .eq("tenant_id", gb.tenant_id)
    .eq("group_buy_id", gb.id)
    .gte("date_statistics", fromday)
    .lte("date_statistics", today)
    .order("date_statistics");
  if (error) throw new Error(`[report] 讀取每日統計失敗：${error.message}`);
  const byDay = new Map<string, { amount: number; count: number }>();
  for (const r of (data ?? []) as { date_statistics: string; amount_sales: number; count_sales: number }[]) {
    const k = String(r.date_statistics).slice(0, 10);
    const cur = byDay.get(k) ?? { amount: 0, count: 0 };
    cur.amount += Number(r.amount_sales) || 0;
    cur.count += Number(r.count_sales) || 0;
    byDay.set(k, cur);
  }
  const labels: string[] = [];
  const chart: number[] = [];
  const counts: number[] = [];
  for (let t = Date.parse(fromday); t <= Date.parse(today); t += dayMs) {
    const k = new Date(t).toISOString().slice(0, 10);
    labels.push(k);
    chart.push(byDay.get(k)?.amount ?? 0);
    counts.push(byDay.get(k)?.count ?? 0);
  }
  return json({
    // countData：推導（「近期銷售分析」表的訂單數；原站回應只確認 labels/chartData）
    data: { labels, chartData: chart, countData: counts },
    recordsTotal: labels.length,
    recordsFiltered: labels.length,
    dateModified: Date.now(),
    executionTime: Math.max(0, Date.now() - startedAt),
    options: {},
  });
}

export const reportRoutes: RouteDef[] = [
  route(["GET", "POST"], "/rp/:token", reportPage, { auth: "public", tenantPrefix: "deny" }),
  post("/ajax/SalesOrder/report", salesOrderReport, { auth: "public" }),
  get("/ajax/GroupBuyDailyStatistics/chartData", chartData, { auth: "public" }),
];
