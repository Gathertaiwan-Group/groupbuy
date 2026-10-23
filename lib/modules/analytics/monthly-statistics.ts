// 團購銷售(月)（銷售數據分析：即時／每日／完整銷售統計三分頁，gbes.min.js 驅動）、月份摘要明細、訂單統計（每月消費統計）。
//   GET  /backend/GroupBuyErpMonthlyStatistics/list                 頁面「銷售數據」
//   GET  /ajax/GroupBuyErpMonthlyStatistics/list                    完整銷售統計（依收款月；fromday/today＝YYYY-MM）
//   GET  /ajax/GroupBuyErpMonthlyStatistics/statistics?month=YYYYMM 銷售一覽「月份摘要」展開：各團購
//   GET  /ajax/ErpMonthlyPaymentStatistics/statistics?month=YYYYMM  銷售一覽「月份摘要」展開：各付款方式
//   GET  /backend/SalesOrderMonthlyStatistics/list                  頁面「每月消費統計」
//   POST /ajax/SalesOrderMonthlyStatistics/list|save|update|delete
import { getServiceClient } from "@/lib/supabase/server";
import { salesOrderMonthlyStatistics } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, requireSession, route } from "@/lib/core/http/route-helpers";
import { json } from "@/lib/core/http/responses";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { crudRoutes, type WriteSpec } from "@/lib/core/entity/crud";
import {
  type AnyRow,
  boolParam,
  ensureFresh,
  fetchAll,
  groupBuyIdsByKeywords,
  int,
  monthEnd,
  num,
  parseKeywords,
  parseMonth,
  paymentMethodOf,
  tpeDateTimeSec,
  yyyymm,
} from "./util";

/* ───────────── 團購銷售(月) ───────────── */

const GBEMS_COLUMNS: Record<string, string> = {
  dateStatisticsString: "date_statistics",
  groupBuyId: "group_buy_id",
  shortUrl: "short_url",
  title: "title",
  amountTotal: "amount_total",
  countTotal: "count_total",
  amountSales: "amount_sales",
  countSales: "count_sales",
  amountAdvance: "amount_advance",
  countAdvance: "count_advance",
};

/** 統計列 → JSON（鍵依合法資產 gbes.min.js、sa.js 的使用；日期為 YYYYMM） */
export function gbemsToApi(r: AnyRow): AnyRow {
  const ym = yyyymm(String(r.date_statistics ?? ""));
  return {
    title: r.title ?? "",
    amountSales: num(r.amount_sales),
    amountAdvance: num(r.amount_advance),
    countSales: int(r.count_sales),
    countAdvance: int(r.count_advance),
    groupBuyId: int(r.group_buy_id),
    shortUrl: r.short_url ?? "",
    countTotal: int(r.count_total),
    amountTotal: num(r.amount_total),
    dateStatisticsString: ym,
    datePaidString: ym,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOrder(q: any, dt: DtRequest, map: Record<string, string>, fallback: { col: string; asc: boolean }[]): any {
  let ordered = false;
  for (const o of dt.order) {
    const col = map[o.data];
    if (!col) continue;
    q = q.order(col, { ascending: o.dir === "asc" });
    ordered = true;
  }
  if (!ordered) for (const f of fallback) q = q.order(f.col, { ascending: f.asc });
  return q;
}

async function listGroupBuyMonthly(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  let from = parseMonth(dt.extra.fromday);
  let to = parseMonth(dt.extra.today);
  if (!from || !to) return dtResponse(dt, { rows: [], recordsTotal: 0, recordsFiltered: 0, options: {}, dateModified: 0 }, started);
  if (from > to) [from, to] = [to, from];
  const groupBuyIds = await groupBuyIdsByKeywords(session.tenantId, parseKeywords(dt.extra.keywords), boolParam(dt.extra.allMatch));
  if (groupBuyIds && !groupBuyIds.length) return dtResponse(dt, { rows: [], recordsTotal: 0, recordsFiltered: 0, options: {}, dateModified: 0 }, started);
  const refreshed = await ensureFresh(session.tenantId);
  const len = dt.serverSide && dt.length > 0 ? Math.min(dt.length, 1000) : 1000;
  let q = getServiceClient()
    .from("group_buy_erp_monthly_statistics")
    .select("*", { count: "exact" })
    .eq("tenant_id", session.tenantId)
    .gte("date_statistics", from)
    .lte("date_statistics", to);
  const gb = Number(dt.extra.groupBuyId);
  if (Number.isSafeInteger(gb) && gb > 0) q = q.eq("group_buy_id", gb);
  if (groupBuyIds) q = q.in("group_buy_id", groupBuyIds);
  q = applyOrder(q, dt, GBEMS_COLUMNS, [
    { col: "date_statistics", asc: false },
    { col: "amount_total", asc: false },
  ]);
  const { data, error, count } = await q.range(dt.start, dt.start + len - 1);
  if (error) throw new Error(`[analytics] 團購銷售(月)查詢失敗：${error.message}`);
  const rows = ((data ?? []) as AnyRow[]).map(gbemsToApi);
  return dtResponse(dt, { rows, recordsTotal: count ?? 0, recordsFiltered: count ?? 0, options: {}, dateModified: rows.length ? refreshed.getTime() : 0 }, started);
}

/** 月份摘要展開：該收款月各團購（銷貨/預收） */
async function groupBuyMonthlyByMonth(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const month = parseMonth(await ctx.param("month"));
  if (!month) return json({ data: [], recordsTotal: 0, recordsFiltered: 0, dateModified: 0, executionTime: 0, options: {} });
  const refreshed = await ensureFresh(session.tenantId);
  const { data, error } = await getServiceClient()
    .from("group_buy_erp_monthly_statistics")
    .select("*")
    .eq("tenant_id", session.tenantId)
    .eq("date_statistics", month)
    .order("amount_total", { ascending: false })
    .order("group_buy_id", { ascending: true });
  if (error) throw new Error(`[analytics] 月份摘要團購查詢失敗：${error.message}`);
  const rows = ((data ?? []) as AnyRow[]).map((r) => {
    const ym = yyyymm(String(r.date_statistics));
    return {
      groupBuyId: int(r.group_buy_id),
      title: r.title ?? "",
      amountTotal: num(r.amount_total),
      amountSales: num(r.amount_sales),
      amountAdvance: num(r.amount_advance),
      countTotal: int(r.count_total),
      countSales: int(r.count_sales),
      countAdvance: int(r.count_advance),
      datePaidString: ym,
    };
  });
  return json({ data: rows, recordsTotal: rows.length, recordsFiltered: rows.length, dateModified: refreshed.getTime(), executionTime: Date.now() - started, options: {} });
}

/** 收款月 × 付款方式（即時由有效訂單計算，與團購銷售(月)同口徑） */
export async function paymentMonthly(tenantId: number, month01: string): Promise<AnyRow[]> {
  const db = getServiceClient();
  const orders = await fetchAll<AnyRow>((f, t) =>
    db
      .from("analytics_orders_v")
      .select("sales_order_id, payment_method, grand_total, shipping_amount, is_shipped")
      .eq("tenant_id", tenantId)
      .eq("is_paid", true)
      .not("group_buy_id", "is", null)
      .gte("paid_date", month01)
      .lte("paid_date", monthEnd(month01))
      .order("sales_order_id")
      .range(f, t),
  );
  const ym = yyyymm(month01);
  const by = new Map<number, AnyRow>();
  for (const o of orders) {
    const bit = int(o.payment_method);
    let r = by.get(bit);
    if (!r) {
      const pm = paymentMethodOf(bit);
      r = {
        paymentMethodName: pm.label,
        datePaidString: ym,
        amountTotal: 0,
        amountSales: 0,
        amountAdvance: 0,
        countTotal: 0,
        countSales: 0,
        countAdvance: 0,
      };
      by.set(bit, r);
    }
    const amt = num(o.grand_total);
    r.amountTotal += amt;
    r.countTotal += 1;
    if (o.is_shipped) {
      r.amountSales += amt;
      r.countSales += 1;
    } else {
      r.amountAdvance += amt;
      r.countAdvance += 1;
    }
  }
  return [...by.values()]
    .map((r) => ({ ...r, amountTotal: num(r.amountTotal), amountSales: num(r.amountSales), amountAdvance: num(r.amountAdvance) }))
    .sort((a, b) => b.amountTotal - a.amountTotal);
}

async function paymentMonthlyByMonth(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const month = parseMonth(await ctx.param("month"));
  if (!month) return json({ data: [], recordsTotal: 0, recordsFiltered: 0, dateModified: 0, executionTime: 0, options: {} });
  const rows = await paymentMonthly(session.tenantId, month);
  return json({ data: rows, recordsTotal: rows.length, recordsFiltered: rows.length, dateModified: Date.now(), executionTime: Date.now() - started, options: {} });
}

/* ───────────── 訂單統計（每月消費統計） ───────────── */

const SOMS_COLUMNS: Record<string, string> = {
  name: "name",
  email: "email",
  telephone: "telephone",
  amountTotal: "amount_total",
  amountMax: "amount_max",
  countOrderValid: "count_order_valid",
  month: "month",
};

function somsToApi(r: AnyRow): AnyRow {
  return {
    salesOrderMonthlyStatisticsId: int(r.id),
    name: r.name ?? "",
    email: r.email ?? "",
    telephone: r.telephone ?? "",
    amountTotal: num(r.amount_total),
    amountMax: num(r.amount_max),
    countOrderValid: int(r.count_order_valid),
  };
}

function numParam(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function listSalesOrderMonthly(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const refreshed = await ensureFresh(session.tenantId);
  const len = dt.serverSide && dt.length > 0 ? Math.min(dt.length, 1000) : 1000;
  const db = getServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filters = (q: any, withSearch: boolean) => {
    q = q.eq("tenant_id", session.tenantId);
    if (!withSearch) return q;
    const month = parseMonth(dt.extra.month);
    if (month) q = q.eq("month", month);
    const g = (k: string) => numParam(dt.extra[k]);
    if (g("amountTotalGreater") !== null) q = q.gt("amount_total", g("amountTotalGreater"));
    if (g("amountTotalLess") !== null) q = q.lt("amount_total", g("amountTotalLess"));
    if (g("amountMaxGreater") !== null) q = q.gt("amount_max", g("amountMaxGreater"));
    if (g("amountMaxLess") !== null) q = q.lt("amount_max", g("amountMaxLess"));
    if (g("countOrderValidGreater") !== null) q = q.gt("count_order_valid", g("countOrderValidGreater"));
    if (g("countOrderValidLess") !== null) q = q.lt("count_order_valid", g("countOrderValidLess"));
    const term = sanitizeLike(dt.search);
    if (term) q = q.or(`name.ilike.*${term}*,email.ilike.*${term}*,telephone.ilike.*${term}*`);
    // 表尾搜尋（姓名／電子信箱／電話）
    for (const c of dt.columns) {
      const v = sanitizeLike(c.search ?? "");
      if (v && (c.data === "name" || c.data === "email" || c.data === "telephone")) q = q.ilike(c.data, `%${v}%`);
    }
    return q;
  };
  let q = filters(db.from("sales_order_monthly_statistics").select("*", { count: "exact" }), true);
  q = applyOrder(q, dt, SOMS_COLUMNS, [
    { col: "amount_total", asc: false },
    { col: "id", asc: true },
  ]);
  const { data, error, count } = await q.range(dt.start, dt.start + len - 1);
  if (error) throw new Error(`[analytics] 訂單統計查詢失敗：${error.message}`);
  const { count: total } = await filters(db.from("sales_order_monthly_statistics").select("id", { count: "exact", head: true }), false);
  const rows = ((data ?? []) as AnyRow[]).map(somsToApi);
  return dtResponse(dt, { rows, recordsTotal: total ?? count ?? 0, recordsFiltered: count ?? 0, options: {}, dateModified: refreshed.getTime() }, started);
}

const somsWrite: WriteSpec = {
  mapRow: (_api, row) => somsToApi(row),
  validate(_values, action) {
    if (action === "create") return [{ name: "name", status: "訂單統計由系統依訂單自動產生，無法手動新增" }];
    return [];
  },
  beforeWrite(dbRow) {
    delete dbRow.tenant_id;
    delete dbRow.month;
    return dbRow;
  },
  optimisticLock: false,
};

export const monthlyStatisticsRoutes: RouteDef[] = [
  page("/backend/GroupBuyErpMonthlyStatistics/list", {
    template: "analytics/groupbuyerpmonthlystatistics-list.html",
    title: "銷售數據",
    groupBuy: "none",
  }),
  route(["GET", "POST"], "/ajax/GroupBuyErpMonthlyStatistics/list", listGroupBuyMonthly),
  route(["GET", "POST"], "/ajax/GroupBuyErpMonthlyStatistics/statistics", groupBuyMonthlyByMonth),
  route(["GET", "POST"], "/ajax/ErpMonthlyPaymentStatistics/statistics", paymentMonthlyByMonth),

  page("/backend/SalesOrderMonthlyStatistics/list", {
    template: "analytics/salesordermonthlystatistics-list.html",
    title: "每月消費統計",
    groupBuy: "none",
  }),
  route(["GET", "POST"], "/ajax/SalesOrderMonthlyStatistics/list", listSalesOrderMonthly),
  ...crudRoutes(salesOrderMonthlyStatistics, {
    save: "/ajax/SalesOrderMonthlyStatistics/save",
    update: "/ajax/SalesOrderMonthlyStatistics/update",
    delete: "/ajax/SalesOrderMonthlyStatistics/delete",
    writeSpec: somsWrite,
  }),
];
