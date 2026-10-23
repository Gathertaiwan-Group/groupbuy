// 銷售一覽（panel）、商品銷售（依商品代碼查詢）、單一團購銷售分析（Chart.js 圖表＋近期摘要）。
//   GET  /backend/SalesAnalysis/panel                      頁面「銷售」（Chart.js 4.4.1 + /scripts/ana.js + /scripts/sa.js）
//   GET  /ajax/SalesAnalysis/statistics                    今日/昨日銷售、商品、月份摘要（sa.js）
//   GET  /backend/SalesAnalysis/show                       頁面「商品銷售」
//   POST /ajax/SalesAnalysis/queryOrderItemAnalysis        依商品代碼彙總（extraSort：month/groupBuy/state）
//   GET  /backend/GroupBuy/analytics?groupBuyId=           頁面「銷售分析」（Chart.js 2.7.2）
//   GET  /ajax/GroupBuy/analytics?all=1&groupBuyId=&dateCreatedBegin=&dateCreatedEnd=   圖表資料（ana.js 也用：全部團購每日訂單數）
//   GET  /ajax/GroupBuy/getDailyReport?groupBuyId=&dateCreatedBegin=&dateCreatedEnd=     近期摘要
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, requireSession, route } from "@/lib/core/http/route-helpers";
import { json } from "@/lib/core/http/responses";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { enumOptionsFor } from "@/lib/core/enums";
import { gbdsToApi, idsToApi, queryGroupBuyDaily, queryItemDaily } from "./daily-statistics";
import {
  type AnyRow,
  addMonths,
  ensureFresh,
  fetchAll,
  int,
  num,
  pageRows,
  parseDate,
  sortRows,
  tpeDateTimeSec,
  todayTpe,
  yyyymm,
} from "./util";

const envelope = (data: unknown, started: number, dateModified = 0) => ({
  data,
  recordsTotal: 0,
  recordsFiltered: 0,
  dateModified,
  executionTime: Math.max(0, Date.now() - started),
  options: {},
});

/* ───────────── 銷售一覽 ───────────── */

async function salesStatistics(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const refreshed = await ensureFresh(session.tenantId);
  const today = todayTpe();
  const yesterday = todayTpe(-1);
  const [gbT, gbY, itT, itY] = await Promise.all([
    queryGroupBuyDaily(session.tenantId, { from: today, to: today }),
    queryGroupBuyDaily(session.tenantId, { from: yesterday, to: yesterday }),
    queryItemDaily(session.tenantId, { from: today, to: today }),
    queryItemDaily(session.tenantId, { from: yesterday, to: yesterday }),
  ]);
  const byAmount = (a: AnyRow, b: AnyRow) => b.amountSales - a.amountSales || a.groupBuyId - b.groupBuyId;
  const gbds = gbT.rows.map(gbdsToApi).sort(byAmount);
  const gbdsY = gbY.rows.map(gbdsToApi).sort(byAmount);
  // 銷售一覽的商品卡：無商品代碼歸為空字串（sa.js 顯示「其他<無商品代碼>」）
  const itemApi = (r: AnyRow) => {
    const a = idsToApi(r);
    if (a.uid === "###") a.uid = "";
    return a;
  };
  const idss = itT.rows.map(itemApi).sort((a, b) => b.amountSales - a.amountSales);
  const idssY = itY.rows.map(itemApi).sort((a, b) => b.amountSales - a.amountSales);

  // 月份摘要（依收款月，最近 12 個月；與團購銷售(月)同一張統計表）
  const since = addMonths(today.slice(0, 7) + "-01", -11);
  const { data: em, error } = await getServiceClient()
    .from("group_buy_erp_monthly_statistics")
    .select("date_statistics, amount_total, amount_sales, amount_advance, amount_shipping, count_total, count_sales, count_advance, created_at")
    .eq("tenant_id", session.tenantId)
    .gte("date_statistics", since);
  if (error) throw new Error(`[analytics] 月份摘要查詢失敗：${error.message}`);
  const months = new Map<string, AnyRow>();
  for (const r of (em ?? []) as AnyRow[]) {
    const ym = yyyymm(String(r.date_statistics));
    let m = months.get(ym);
    if (!m) {
      m = { amountTotal: 0, amountSales: 0, amountAdvance: 0, amountShipping: 0, countTotal: 0, countSales: 0, countAdvance: 0, datePaidString: ym, created: r.created_at };
      months.set(ym, m);
    }
    m.amountTotal += num(r.amount_total);
    m.amountSales += num(r.amount_sales);
    m.amountAdvance += num(r.amount_advance);
    m.amountShipping += num(r.amount_shipping);
    m.countTotal += int(r.count_total);
    m.countSales += int(r.count_sales);
    m.countAdvance += int(r.count_advance);
  }
  const emss = [...months.values()]
    .sort((a, b) => b.datePaidString.localeCompare(a.datePaidString))
    .map((m) => ({
      amountAdvance: num(m.amountAdvance),
      amountSales: num(m.amountSales),
      amountTotal: num(m.amountTotal),
      countAdvance: m.countAdvance,
      countSales: m.countSales,
      countTotal: m.countTotal,
      dateModifiedString: tpeDateTimeSec(refreshed),
      datePaidString: m.datePaidString,
    }));
  const sum = (rows: AnyRow[], k: string) => num(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
  return json(
    envelope(
      {
        amount: sum(gbds, "amountSales"),
        total: sum(gbds, "countSales"),
        amountY: sum(gbdsY, "amountSales"),
        totalY: sum(gbdsY, "countSales"),
        gbds,
        gbdsY,
        idss,
        idssY,
        emss,
      },
      started,
    ),
  );
}

/* ───────────── 商品銷售（queryOrderItemAnalysis） ───────────── */

async function queryOrderItemAnalysis(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const options = await enumOptionsFor({ state: "OrderItem.state" });
  const uids = [
    ...new Set(
      String(dt.extra.uids ?? "")
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 300);
  if (!uids.length) return dtResponse(dt, { rows: [], recordsTotal: 0, recordsFiltered: 0, options, dateModified: 0 }, started);
  const from = parseDate(dt.extra.dateBeginString);
  const to = parseDate(dt.extra.dateEndString);
  const extra = String(dt.extra.extraSort ?? "");
  const db = getServiceClient();

  type ItemRow = { group_buy_id: number | null; title: string; uid: string; state: string; total: number; price: number; amount: number; created_date: string; sales_order_id: number; has_shipping_amount: boolean };
  let items: ItemRow[];
  if (extra === "state") {
    // 依商品銷售狀態分類：列出有效訂單內所有狀態的商品（含取消/退貨，分列顯示）
    const rows = await fetchAll<AnyRow>((f, t) => {
      let q = db
        .from("order_item_analysis_v")
        .select("order_item_id, group_buy_id, title, uid, state, total, price, amount, date_created, sales_order_id, has_shipping_amount")
        .eq("tenant_id", session.tenantId)
        .in("uid", uids);
      if (from) q = q.gte("date_created", new Date(Date.parse(from + "T00:00:00+08:00")).toISOString());
      if (to) q = q.lt("date_created", new Date(Date.parse(to + "T00:00:00+08:00") + 86400000).toISOString());
      return q.order("order_item_id").range(f, t);
    });
    items = rows.map((r) => ({
      group_buy_id: r.group_buy_id,
      title: r.title,
      uid: r.uid,
      state: r.state,
      total: int(r.total),
      price: num(r.price),
      amount: num(r.amount),
      created_date: new Date(new Date(r.date_created).getTime() + 8 * 3600000).toISOString().slice(0, 10),
      sales_order_id: int(r.sales_order_id),
      has_shipping_amount: !!r.has_shipping_amount,
    }));
  } else {
    const rows = await fetchAll<AnyRow>((f, t) => {
      let q = db
        .from("analytics_order_items_v")
        .select("order_item_id, group_buy_id, title, uid, state, total, price, amount, created_date, sales_order_id, has_shipping_amount")
        .eq("tenant_id", session.tenantId)
        .in("uid", uids);
      if (from) q = q.gte("created_date", from);
      if (to) q = q.lte("created_date", to);
      return q.order("order_item_id").range(f, t);
    });
    items = rows as unknown as ItemRow[];
  }

  const gbIds = [...new Set(items.map((i) => i.group_buy_id).filter((x): x is number => !!x))];
  const titles = new Map<number, string>();
  if (gbIds.length) {
    const { data } = await db.from("group_buys").select("id, title").eq("tenant_id", session.tenantId).in("id", gbIds);
    for (const g of (data ?? []) as AnyRow[]) titles.set(int(g.id), g.title ?? "");
  }
  const groups = new Map<string, AnyRow>();
  for (const it of items) {
    const month = String(it.created_date).slice(0, 7);
    const key = [
      extra === "month" ? month : "",
      extra === "groupBuy" ? it.group_buy_id ?? "" : "",
      extra === "state" ? it.state : "",
      it.uid,
      num(it.price),
    ].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        month: extra === "month" ? month : "",
        groupBuyTitle: extra === "groupBuy" ? titles.get(int(it.group_buy_id)) ?? "" : "",
        groupBuyId: extra === "groupBuy" ? int(it.group_buy_id) : null,
        title: it.title ?? "",
        uid: it.uid ?? "",
        state: extra === "state" ? it.state : "",
        total: 0,
        price: num(it.price),
        amount: 0,
        orders: new Set<number>(),
      };
      groups.set(key, g);
    }
    g.total += int(it.total);
    g.amount += num(it.amount);
    if (it.has_shipping_amount) (g.orders as Set<number>).add(int(it.sales_order_id));
  }
  let rows = [...groups.values()].map((g) => ({
    month: g.month,
    groupBuyTitle: g.groupBuyTitle,
    groupBuyId: g.groupBuyId,
    title: g.title,
    uid: g.uid,
    state: g.state,
    total: g.total,
    price: g.price,
    amount: num(g.amount),
    unitPrice: g.total > 0 ? num(g.amount / g.total) : 0,
    shippingAmountCount: (g.orders as Set<number>).size,
  }));
  rows = sortRows(rows, { ...dt, order: [] }, [
    { key: "uid", dir: "asc" },
    { key: "month", dir: "asc" },
    { key: "groupBuyId", dir: "asc" },
    { key: "state", dir: "asc" },
    { key: "price", dir: "desc" },
  ]) as typeof rows;
  return dtResponse(dt, { rows: pageRows(rows, dt), recordsTotal: rows.length, recordsFiltered: rows.length, options, dateModified: rows.length ? Date.now() : 0 }, started);
}

/* ───────────── 單一團購銷售分析 / 銷售一覽「近日訂單數」 ───────────── */

function rangeOf(begin: unknown, end: unknown): { from: string; to: string } | null {
  let from = parseDate(begin);
  let to = parseDate(end);
  if (!from || !to) return null;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

const DIST_STEPS = [0, 500, 1000, 1500, 2000, 3000, 5000, 10000];

/** 圖表資料（原站鍵：dailyCounts/distributions/cateTagPortions/itemSetPortions/areaSalesOrderCountPortions/areaSalesOrderAmountPortions） */
export async function analyticsData(tenantId: number, groupBuyId: number | null, from: string, to: string): Promise<AnyRow> {
  await ensureFresh(tenantId);
  const db = getServiceClient();
  // 每日訂單數：與「每日銷售」同一張統計表
  const daily = await fetchAll<AnyRow>((f, t) => {
    let q = db
      .from("group_buy_daily_statistics")
      .select("date_statistics, count_sales, amount_sales")
      .eq("tenant_id", tenantId)
      .gte("date_statistics", from)
      .lte("date_statistics", to);
    if (groupBuyId) q = q.eq("group_buy_id", groupBuyId);
    return q.order("date_statistics").order("id").range(f, t);
  });
  const byDay = new Map<string, { c: number; a: number }>();
  for (const r of daily) {
    const d = String(r.date_statistics);
    const v = byDay.get(d) ?? { c: 0, a: 0 };
    v.c += int(r.count_sales);
    v.a += num(r.amount_sales);
    byDay.set(d, v);
  }
  const dailyCounts = [...byDay.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([d, v]) => ({ data: String(v.c), data2: num(v.a).toFixed(2), label: d.slice(5, 7) + d.slice(8, 10) }));

  // 其他分佈：有效訂單／商品（同口徑檢視）
  const orders = await fetchAll<AnyRow>((f, t) => {
    let q = db
      .from("analytics_orders_v")
      .select("sales_order_id, grand_total, city")
      .eq("tenant_id", tenantId)
      .gte("created_date", from)
      .lte("created_date", to)
      .not("group_buy_id", "is", null);
    if (groupBuyId) q = q.eq("group_buy_id", groupBuyId);
    return q.order("sales_order_id").range(f, t);
  });
  const dist = new Map<number, number>();
  const areaCount = new Map<string, number>();
  const areaAmount = new Map<string, number>();
  for (const o of orders) {
    const amt = num(o.grand_total);
    let step = DIST_STEPS[0];
    for (const s of DIST_STEPS) if (amt >= s) step = s;
    dist.set(step, (dist.get(step) ?? 0) + 1);
    const city = String(o.city ?? "").trim().slice(0, 3) || "未填寫";
    areaCount.set(city, (areaCount.get(city) ?? 0) + 1);
    areaAmount.set(city, (areaAmount.get(city) ?? 0) + amt);
  }
  const distributions = DIST_STEPS.filter((s) => dist.has(s)).map((s, i, arr) => ({
    label: i === arr.length - 1 && s === DIST_STEPS[DIST_STEPS.length - 1] ? `${s}+` : String(s),
    data: dist.get(s) ?? 0,
  }));
  const areaSalesOrderCountPortions = [...areaCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([label, data]) => ({ label, data }));
  const areaSalesOrderAmountPortions = areaSalesOrderCountPortions.map((r) => ({
    label: r.label,
    data: num((areaAmount.get(r.label) ?? 0) / Math.max(1, r.data)),
  }));

  const items = await fetchAll<AnyRow>((f, t) => {
    let q = db
      .from("analytics_order_items_v")
      .select("order_item_id, item_id, item_set_id, amount")
      .eq("tenant_id", tenantId)
      .gte("created_date", from)
      .lte("created_date", to);
    if (groupBuyId) q = q.eq("group_buy_id", groupBuyId);
    return q.order("order_item_id").range(f, t);
  });
  const itemIds = [...new Set(items.map((i) => int(i.item_id)).filter(Boolean))];
  const setIds = [...new Set(items.map((i) => int(i.item_set_id)).filter(Boolean))];
  const itemCate = new Map<number, { cate: string; setId: number }>();
  const setInfo = new Map<number, { title: string; cate: string }>();
  for (let i = 0; i < itemIds.length; i += 500) {
    const { data } = await db.from("items").select("id, cate_tag, item_set_id").eq("tenant_id", tenantId).in("id", itemIds.slice(i, i + 500));
    for (const r of (data ?? []) as AnyRow[]) itemCate.set(int(r.id), { cate: String(r.cate_tag ?? "").trim(), setId: int(r.item_set_id) });
  }
  const allSetIds = [...new Set([...setIds, ...[...itemCate.values()].map((v) => v.setId).filter(Boolean)])];
  for (let i = 0; i < allSetIds.length; i += 500) {
    const { data } = await db.from("item_sets").select("id, title, cate_tag").eq("tenant_id", tenantId).in("id", allSetIds.slice(i, i + 500));
    for (const r of (data ?? []) as AnyRow[]) setInfo.set(int(r.id), { title: String(r.title ?? ""), cate: String(r.cate_tag ?? "").trim() });
  }
  const cate = new Map<string, number>();
  const sets = new Map<string, number>();
  for (const it of items) {
    const ic = itemCate.get(int(it.item_id));
    const setId = int(it.item_set_id) || ic?.setId || 0;
    const si = setInfo.get(setId);
    const tag = ic?.cate || si?.cate || "未分類";
    const amt = num(it.amount);
    cate.set(tag, (cate.get(tag) ?? 0) + amt);
    const st = si?.title || "其他";
    sets.set(st, (sets.get(st) ?? 0) + amt);
  }
  const portion = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([label, data]) => ({ label, data: num(data) }));
  return {
    areaSalesOrderAmountPortions,
    areaSalesOrderCountPortions,
    cateTagPortions: portion(cate),
    dailyCounts,
    distributions,
    itemSetPortions: portion(sets),
  };
}

const EMPTY_ANALYTICS = {
  areaSalesOrderAmountPortions: [],
  areaSalesOrderCountPortions: [],
  cateTagPortions: [],
  dailyCounts: [],
  distributions: [],
  itemSetPortions: [],
};

async function analyticsAjax(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const range = rangeOf(await ctx.param("dateCreatedBegin"), await ctx.param("dateCreatedEnd"));
  if (!range) return json(envelope(EMPTY_ANALYTICS, started));
  const gbRaw = Number(await ctx.param("groupBuyId"));
  const groupBuyId = Number.isSafeInteger(gbRaw) && gbRaw > 0 ? gbRaw : null;
  if (groupBuyId) {
    const { data } = await getServiceClient().from("group_buys").select("id").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
    if (!data) return json(envelope(EMPTY_ANALYTICS, started));
  }
  const data = await analyticsData(session.tenantId, groupBuyId, range.from, range.to);
  return json(envelope(data, started));
}

/** 近期摘要：以日期為鍵（推導；空時為 {}） */
async function dailyReport(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const range = rangeOf(await ctx.param("dateCreatedBegin"), await ctx.param("dateCreatedEnd"));
  const gbRaw = Number(await ctx.param("groupBuyId"));
  const groupBuyId = Number.isSafeInteger(gbRaw) && gbRaw > 0 ? gbRaw : null;
  if (!range || !groupBuyId) return json(envelope({}, started));
  const db = getServiceClient();
  const orders = await fetchAll<AnyRow>((f, t) =>
    db
      .from("analytics_orders_v")
      .select("sales_order_id, created_date, grand_total, total_paid")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", groupBuyId)
      .gte("created_date", range.from)
      .lte("created_date", range.to)
      .order("sales_order_id")
      .range(f, t),
  );
  const by = new Map<string, AnyRow>();
  for (const o of orders) {
    const d = String(o.created_date);
    const r = by.get(d) ?? { date: d, count: 0, grandTotal: 0, totalPaid: 0 };
    r.count += 1;
    r.grandTotal = num(r.grandTotal + num(o.grand_total));
    r.totalPaid = num(r.totalPaid + num(o.total_paid));
    by.set(d, r);
  }
  const out: Record<string, AnyRow> = {};
  [...by.keys()].sort((a, b) => b.localeCompare(a)).forEach((k) => (out[k] = by.get(k)!));
  return json(envelope(out, started));
}

export const salesAnalysisRoutes: RouteDef[] = [
  page("/backend/SalesAnalysis/panel", {
    template: "analytics/salesanalysis-panel.html",
    title: "銷售",
    groupBuy: "none",
  }),
  route(["GET", "POST"], "/ajax/SalesAnalysis/statistics", salesStatistics),
  page("/backend/SalesAnalysis/show", {
    template: "analytics/salesanalysis-show.html",
    title: "商品銷售",
    groupBuy: "none",
  }),
  route(["GET", "POST"], "/ajax/SalesAnalysis/queryOrderItemAnalysis", queryOrderItemAnalysis),
  page("/backend/GroupBuy/analytics", {
    template: "analytics/groupbuy-analytics.html",
    title: "銷售分析",
    groupBuy: "required",
    data: (ctx) => ({ groupBuyTitle: ctx.groupBuy?.title ?? "" }),
  }),
  route(["GET", "POST"], "/ajax/GroupBuy/analytics", analyticsAjax),
  route(["GET", "POST"], "/ajax/GroupBuy/getDailyReport", dailyReport),
];
