// 匯出團購月報表、匯出銷售商品總表（伺服器產生 .xlsx 下載；工作表/欄位/檔名照原站實測）。
//   GET  /ajax/GroupBuy/exportMonthlyReport          彈窗（所有團購列表的「匯出團購月報表」）
//   POST /ajax/GroupBuy/countMonthlyReport           彈窗內「符合結果:N」
//   POST /backend/GroupBuy/exportMonthlyReport       下載 {租戶}{起MMDD}{迄MMDD}.xlsx，工作表「YYYY-MM月報表」
//   GET  /ajax/GroupBuy/exportItemSalesReport        彈窗（匯出銷售商品總表）
//   POST /backend/Item/exportItemSalesReport         下載 匯出銷售商品總表_{團購}_{匯出依照}_{起}_{迄}.xlsx，工作表「ALL」（ERP 格式「ERP」）
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { download, html, json } from "@/lib/core/http/responses";
import { taipeiDateTime } from "@/lib/core/time";
import { buildXlsx, XLSX_CONTENT_TYPE, type CellInput } from "./xlsx";
import {
  type AnyRow,
  FEATURE_TAG_BITS,
  FEATURE_TAG_LABELS,
  addDays,
  boolParam,
  ensureFresh,
  featureBits,
  fetchAll,
  int,
  num,
  parseDate,
  tpeDayStartIso,
  todayTpe,
} from "./util";

/** 原站錯誤：純文字訊息（例「團購不存在」），不設 fileDownload cookie */
function textError(message: string, status = 200): Response {
  return html(message, { status });
}

/* ───────────── 匯出團購月報表 ───────────── */

export interface MonthlyFilter {
  purpose: "start" | "end";
  from: string;
  to: string;
  featureTag: number;
  excludedFeatureTag: number;
  daysToShipped: number | null;
}

async function readMonthlyFilter(ctx: RequestContext): Promise<MonthlyFilter | string> {
  const p = await ctx.param("purpose");
  const purpose = p === "end" ? "end" : p === "start" ? "start" : null;
  if (!purpose) return "請選擇日期條件";
  let from = parseDate(await ctx.param("dateStartString"));
  let to = parseDate(await ctx.param("dateEndString"));
  if (!from || !to) return "請選擇起訖日期";
  if (from > to) [from, to] = [to, from];
  const bits = async (name: string) =>
    (await ctx.params_all(name))
      .flatMap((v) => String(v).split(","))
      .map((v) => Number(v))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
      .reduce((a, b) => a | b, 0);
  const d = Number(String((await ctx.param("daysToShipped")) ?? "").trim());
  return {
    purpose,
    from,
    to,
    featureTag: await bits("featureTag"),
    excludedFeatureTag: await bits("excludedFeatureTag"),
    daysToShipped: Number.isFinite(d) && d > 0 ? Math.trunc(d) : null,
  };
}

/** 符合條件的團購（依開始或結束時間排序） */
async function monthlyGroupBuys(tenantId: number, f: MonthlyFilter): Promise<AnyRow[]> {
  const db = getServiceClient();
  const col = f.purpose === "start" ? "date_start" : "date_end";
  const rows = await fetchAll<AnyRow>((a, b) =>
    db
      .from("group_buys")
      .select("id, title, date_start, date_end, feature_tags, blogger_share, group_buy_statistics")
      .eq("tenant_id", tenantId)
      .gte(col, tpeDayStartIso(f.from))
      .lt(col, tpeDayStartIso(addDays(f.to, 1)))
      .order(col, { ascending: true })
      .order("id", { ascending: true })
      .range(a, b),
  );
  let out = rows.filter((g) => {
    const bits = featureBits(g.feature_tags);
    if (f.featureTag && (bits & f.featureTag) === 0) return false;
    if (f.excludedFeatureTag && (bits & f.excludedFeatureTag) !== 0) return false;
    return true;
  });
  // 已出貨超過天數：最後一筆有效訂單出貨日早於 N 天前（勾「出完貨」時才顯示此條件）
  if (f.daysToShipped && out.length) {
    const ids = out.map((g) => int(g.id));
    const last = new Map<number, string>();
    const shipped = await fetchAll<AnyRow>((a, b) =>
      db
        .from("analytics_orders_v")
        .select("sales_order_id, group_buy_id, shipped_date")
        .eq("tenant_id", tenantId)
        .in("group_buy_id", ids)
        .not("shipped_date", "is", null)
        .order("sales_order_id")
        .range(a, b),
    );
    for (const s of shipped) {
      const k = int(s.group_buy_id);
      const d = String(s.shipped_date);
      if (!last.has(k) || d > last.get(k)!) last.set(k, d);
    }
    const limit = todayTpe(-f.daysToShipped);
    out = out.filter((g) => {
      const d = last.get(int(g.id));
      return !!d && d < limit;
    });
  }
  return out;
}

async function countMonthlyReport(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const f = await readMonthlyFilter(ctx);
  if (typeof f === "string") return json({ code: 200, data: 0, error: "", message: f });
  const rows = await monthlyGroupBuys(session.tenantId, f);
  return json({ code: 200, data: rows.length, error: "", message: "" });
}

export const MONTHLY_HEADER = ["團購ID", "團購名稱", "開始時間", "結束時間", "標籤", "訂單數量", "未出貨數量", "銷售金額", "已收匯款金額", "已收匯款金額(扣除運費)", "分潤金額", "分潤（％）"];

export async function buildMonthlyReport(
  tenantId: number,
  tenantCode: string,
  f: MonthlyFilter,
  withCommission: boolean,
): Promise<{ filename: string; sheet: string; buffer: Buffer; rows: AnyRow[] } | null> {
  await ensureFresh(tenantId);
  const gbs = await monthlyGroupBuys(tenantId, f);
  if (!gbs.length) return null;
  const header: CellInput[] = MONTHLY_HEADER.map((v) => ({ v, s: "header" }));
  const body: CellInput[][] = [];
  const total = { orders: 0, revenue: 0, paid: 0, paidWo: 0 };
  for (const g of gbs) {
    const s = (g.group_buy_statistics ?? {}) as AnyRow;
    const codes = Array.isArray(g.feature_tags) ? (g.feature_tags as string[]) : [];
    const tags = codes.map((t) => FEATURE_TAG_LABELS[t] ?? t).join(",");
    const closingOrClosed = codes.some((t) => t === "CLOSING" || t === "CLOSED");
    const orders = int(s.orders);
    const revenue = num(s.revenue);
    const paid = num(s.paidTotal);
    const paidWo = num(s.paidTotalWithoutShipping);
    total.orders += orders;
    total.revenue += revenue;
    total.paid += paid;
    total.paidWo += paidWo;
    const showCommission = withCommission && closingOrClosed;
    body.push([
      { v: String(g.id), t: "s" },
      g.title ?? "",
      taipeiDateTime(g.date_start),
      taipeiDateTime(g.date_end),
      tags,
      orders,
      { v: String(int(s.unshippedOrders)), t: "s" },
      revenue,
      paid,
      paidWo,
      { v: showCommission ? String(num(s.bloggerShareTotal)) : "", t: "s" },
      { v: showCommission ? Number(g.blogger_share ?? 0).toFixed(2) : "", t: "s" },
    ]);
  }
  body.push([
    null, null, null, null, null,
    { v: total.orders, s: "total" }, null,
    { v: num(total.revenue), s: "total" }, { v: num(total.paid), s: "total" }, { v: num(total.paidWo), s: "total" },
    null, null,
  ]);
  const first = String(f.purpose === "start" ? gbs[0].date_start : gbs[0].date_end);
  const sheet = `${taipeiDateTime(first).slice(0, 7)}月報表`;
  const buffer = buildXlsx([{ name: sheet, rows: [header, ...body], widths: [10, 40, 18, 18, 16, 10, 10, 12, 14, 20, 10, 10] }]);
  const code = tenantCode.replace(/[^A-Za-z0-9]/g, "");
  const filename = `${code}${f.from.slice(5, 7)}${f.from.slice(8, 10)}${f.to.slice(5, 7)}${f.to.slice(8, 10)}.xlsx`;
  return { filename, sheet, buffer, rows: gbs };
}

async function exportMonthlyReport(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const f = await readMonthlyFilter(ctx);
  if (typeof f === "string") return textError(f);
  const out = await buildMonthlyReport(session.tenantId, session.tenantCode, f, boolParam(await ctx.param("commission")));
  if (!out) return textError("團購不存在");
  // 將匯出表單標註為「結案中」（加 CLOSING、移除 UNCLOSED）
  if ((await ctx.param("closing")) === "1") {
    const db = getServiceClient();
    for (const g of out.rows) {
      const tags = new Set<string>(Array.isArray(g.feature_tags) ? (g.feature_tags as string[]) : []);
      if (tags.has("CLOSING") && !tags.has("UNCLOSED")) continue;
      tags.delete("UNCLOSED");
      tags.add("CLOSING");
      const ordered = [...Object.keys(FEATURE_TAG_BITS).filter((t) => tags.has(t)), ...[...tags].filter((t) => !(t in FEATURE_TAG_BITS))];
      const { error } = await db.from("group_buys").update({ feature_tags: ordered }).eq("tenant_id", session.tenantId).eq("id", int(g.id));
      if (error) throw new Error(`[analytics] 標註結案中失敗：${error.message}`);
    }
  }
  return download(new Uint8Array(out.buffer), out.filename, XLSX_CONTENT_TYPE);
}

/* ───────────── 匯出銷售商品總表 ───────────── */

export const EXPORT_BY: Record<string, string> = { GROUP_BUY: "團購日期", UUID: "訂單日期", INVOICE: "發票日期", SHIPPED: "出貨回壓日期" };
export const ITEM_HEADER = [
  "商品名稱", "商品編號", "商品單價",
  "已付款[現]", "未付款[現]", "加總[現]",
  "已付款[預]", "未付款[預]", "加總[預]",
  "已付款[現＋預]", "未付款[現＋預]", "加總[現＋預]",
  "原始現貨庫存", "剩餘現貨庫存", "原始預購庫存", "剩餘預購庫存",
  "共用主庫存原始現貨", "共用主庫存剩餘現貨", "共用主庫存原始預購", "共用主庫存剩餘預購",
  "國際條碼", "商品原價",
];
export const ERP_HEADER = ["單據日期", "品號", "品名", "數量", "單價", "金額", "備註"];

export interface ItemReportInput {
  from: string;
  to: string;
  groupBuyIds: number[];
  exportBy: string;
  backOrder: "" | "0" | "1";
  shipped: "" | "0" | "1";
  toErpFormat: boolean;
}

export async function buildItemSalesReport(tenantId: number, p: ItemReportInput): Promise<{ filename: string; sheet: string; buffer: Buffer; rowCount: number }> {
  await ensureFresh(tenantId);
  const db = getServiceClient();
  // 團購日期＝團購開始時間落在區間內的團購
  let gbFilter: number[] | null = p.groupBuyIds.length ? p.groupBuyIds : null;
  if (p.exportBy === "GROUP_BUY") {
    const gbs = await fetchAll<AnyRow>((a, b) => {
      let q = db
        .from("group_buys")
        .select("id")
        .eq("tenant_id", tenantId)
        .gte("date_start", tpeDayStartIso(p.from))
        .lt("date_start", tpeDayStartIso(addDays(p.to, 1)));
      if (gbFilter) q = q.in("id", gbFilter);
      return q.order("id").range(a, b);
    });
    gbFilter = gbs.map((g) => int(g.id));
  }
  const dateCol = p.exportBy === "SHIPPED" ? "shipped_date" : p.exportBy === "INVOICE" ? "einvoice_date" : p.exportBy === "UUID" ? "created_date" : null;
  const items =
    gbFilter && gbFilter.length === 0
      ? []
      : await fetchAll<AnyRow>((a, b) => {
          let q = db
            .from("analytics_order_items_v")
            .select("order_item_id, item_id, title, uid, price, total, amount, is_paid, back_order, is_shipped, group_buy_id")
            .eq("tenant_id", tenantId);
          if (gbFilter) q = q.in("group_buy_id", gbFilter);
          if (dateCol) q = q.gte(dateCol, p.from).lte(dateCol, p.to);
          if (p.backOrder === "0") q = q.eq("back_order", false);
          if (p.backOrder === "1") q = q.eq("back_order", true);
          if (p.shipped === "0") q = q.eq("is_shipped", false);
          if (p.shipped === "1") q = q.eq("is_shipped", true);
          return q.order("order_item_id").range(a, b);
        });

  type Agg = { itemId: number; title: string; uid: string; price: number; q: number[]; amountPaid: number };
  const by = new Map<string, Agg>();
  for (const it of items) {
    const key = it.item_id ? `i${it.item_id}` : `u${it.uid ?? ""}|${it.title}`;
    let a = by.get(key);
    if (!a) {
      a = { itemId: int(it.item_id), title: it.title ?? "", uid: it.uid ?? "", price: num(it.price), q: [0, 0, 0, 0], amountPaid: 0 };
      by.set(key, a);
    }
    // q: [已付款現, 未付款現, 已付款預, 未付款預]
    const idx = (it.back_order ? 2 : 0) + (it.is_paid ? 0 : 1);
    a.q[idx] += int(it.total);
    if (it.is_paid) a.amountPaid = num(a.amountPaid + num(it.amount));
  }
  const aggs = [...by.values()].sort((x, y) => x.uid.localeCompare(y.uid) || x.title.localeCompare(y.title, "zh-Hant"));

  const exportByLabel = EXPORT_BY[p.exportBy] ?? EXPORT_BY.UUID;
  const gbName = p.groupBuyIds.length ? p.groupBuyIds.join(",") : "null";
  const filename = `匯出銷售商品總表_${gbName}_${exportByLabel}_${p.from}_${p.to}.xlsx`;

  if (p.toErpFormat) {
    const rows: CellInput[][] = [ERP_HEADER.map((v) => ({ v, s: "header" as const }))];
    for (const a of aggs) {
      const qty = a.q[0] + a.q[2];
      if (!qty) continue;
      rows.push([p.to, a.uid, a.title, qty, a.price, a.amountPaid, `${exportByLabel} ${p.from}~${p.to}`]);
    }
    return { filename, sheet: "ERP", buffer: buildXlsx([{ name: "ERP", rows, widths: [12, 16, 40, 8, 10, 12, 30] }]), rowCount: rows.length - 1 };
  }

  const ids = aggs.map((a) => a.itemId).filter(Boolean);
  const stock = new Map<number, AnyRow>();
  const loadItems = async (list: number[]) => {
    for (let i = 0; i < list.length; i += 500) {
      const { data } = await db
        .from("items")
        .select("id, parent_item_id, stock, stock_available, stock_back_order, stock_back_order_available, upc, retail_price")
        .eq("tenant_id", tenantId)
        .in("id", list.slice(i, i + 500));
      for (const r of (data ?? []) as AnyRow[]) if (!stock.has(int(r.id))) stock.set(int(r.id), r);
    }
  };
  await loadItems(ids);
  await loadItems([...new Set([...stock.values()].map((r) => int(r.parent_item_id)).filter(Boolean))]);
  const header: CellInput[] = ITEM_HEADER.map((v, i) => ({
    v,
    s: i >= 3 && i <= 5 ? "groupA" : i >= 6 && i <= 8 ? "groupB" : i >= 9 && i <= 11 ? "groupC" : "header",
  }));
  const rows: CellInput[][] = [header];
  for (const a of aggs) {
    const s = stock.get(a.itemId);
    const parent = s && s.parent_item_id ? stock.get(int(s.parent_item_id)) : null;
    const [pn, un, pb, ub] = a.q;
    rows.push([
      a.title,
      a.uid,
      a.price,
      { v: pn, s: "groupA" }, { v: un, s: "groupA" }, { v: pn + un, s: "groupA" },
      { v: pb, s: "groupB" }, { v: ub, s: "groupB" }, { v: pb + ub, s: "groupB" },
      { v: pn + pb, s: "groupC" }, { v: un + ub, s: "groupC" }, { v: pn + un + pb + ub, s: "groupC" },
      s ? int(s.stock) : null,
      s ? int(s.stock_available) : null,
      s ? int(s.stock_back_order) : null,
      s ? int(s.stock_back_order_available) : null,
      parent ? int(parent.stock) : null,
      parent ? int(parent.stock_available) : null,
      parent ? int(parent.stock_back_order) : null,
      parent ? int(parent.stock_back_order_available) : null,
      s?.upc ?? "",
      s && s.retail_price !== null && s.retail_price !== undefined ? num(s.retail_price) : null,
    ]);
  }
  const widths = [40, 16, 10, ...Array(9).fill(11), ...Array(8).fill(12), 16, 10];
  return { filename, sheet: "ALL", buffer: buildXlsx([{ name: "ALL", rows, widths }]), rowCount: rows.length - 1 };
}

async function exportItemSalesReport(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  let from = parseDate(await ctx.param("dateStart"));
  let to = parseDate(await ctx.param("dateEnd"));
  if (!from || !to) return textError("請選擇開始與結束時間");
  if (from > to) [from, to] = [to, from];
  // 最多匯出跨越兩個月資料
  if (Date.parse(to) - Date.parse(from) > 62 * 86400000) return textError("最多匯出跨越兩個月資料");
  const groupBuyIds = [
    ...new Set(
      (await ctx.params_all("groupBuyId"))
        .flatMap((v) => String(v).split(","))
        .map((v) => Number(v))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ];
  if (groupBuyIds.length) {
    const { data } = await getServiceClient().from("group_buys").select("id").eq("tenant_id", session.tenantId).in("id", groupBuyIds);
    if ((data ?? []).length !== groupBuyIds.length) return textError("團購不存在");
  }
  const exportBy = String((await ctx.param("exportBy")) ?? "UUID");
  const bo = String((await ctx.param("backOrder")) ?? "");
  const sh = String((await ctx.param("shipped")) ?? "");
  const out = await buildItemSalesReport(session.tenantId, {
    from,
    to,
    groupBuyIds,
    exportBy: EXPORT_BY[exportBy] ? exportBy : "UUID",
    backOrder: bo === "0" || bo === "1" ? bo : "",
    shipped: sh === "1" || sh === "true" ? "1" : sh === "0" || sh === "false" ? "0" : "",
    toErpFormat: boolParam(await ctx.param("toErpFormat")),
  });
  return download(new Uint8Array(out.buffer), out.filename, XLSX_CONTENT_TYPE);
}

export const exportRoutes: RouteDef[] = [
  fragment("/ajax/GroupBuy/exportMonthlyReport", {
    template: "analytics/modal-export-monthlyreport.html",
    method: "GET",
  }),
  post("/ajax/GroupBuy/countMonthlyReport", countMonthlyReport),
  post("/backend/GroupBuy/exportMonthlyReport", exportMonthlyReport),
  fragment("/ajax/GroupBuy/exportItemSalesReport", {
    template: "analytics/modal-export-itemsalesreport.html",
    method: "GET",
  }),
  post("/backend/Item/exportItemSalesReport", exportItemSalesReport),
];
