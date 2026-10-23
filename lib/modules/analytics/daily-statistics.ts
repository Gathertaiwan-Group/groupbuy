// 每日銷售（全部團購 / 單一團購）、商品每日銷售、團購銷售(月)的「即時」表與 ROAS 上傳。
// 原站：groupbuydailystatistics-all/-list、itemdailystatistics-list、groupbuyerpmonthlystatistics-list（gbes.min.js）。
//
//   GET  /backend/GroupBuyDailyStatistics/list[?groupBuyId=]      頁面（無 groupBuyId＝全部團購）
//   POST /ajax/GroupBuyDailyStatistics/list                        列表（fromday/today 必填；全部團購時依團購合併，separateByDate 時依日分開）
//   GET  /ajax/GroupBuyDailyStatistics/getRealtimeStatistics       即時（以訂單即時計算；fromday/today 為台灣時間）
//   POST /ajax/GroupBuyDailyStatistics/uploadRoasData              ROAS 上傳（ExcelUploader JSON）
//   POST /ajax/GroupBuyDailyStatistics/save|update|delete          Editor（原站頁面按鈕已註解，端點保留）
//   GET  /backend/ItemDailyStatistics/list[?uid=]                  頁面
//   POST /ajax/ItemDailyStatistics/list|save|update|delete
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuyDailyStatistics, itemDailyStatistics } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { json, jsonError } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { crudRoutes, type EntityCtx, type WriteSpec } from "@/lib/core/entity/crud";
import {
  type AnyRow,
  boolParam,
  ensureFresh,
  fetchAll,
  groupBuyIdsByKeywords,
  int,
  num,
  parseDate,
  parseKeywords,
  parseTpeDateTime,
  tpeDate,
  tpeDateTimeSec,
  todayTpe,
} from "./util";

/* ───────────── 每日銷售（團購） ───────────── */

const GBDS_COLUMNS: Record<string, string> = {
  dateStatisticsString: "date_statistics",
  groupBuyId: "group_buy_id",
  shortUrl: "short_url",
  title: "title",
  amountSales: "amount_sales",
  countSales: "count_sales",
  amountSalesPaid: "amount_sales_paid",
  countSalesPaid: "count_sales_paid",
  amountSalesUnpaid: "amount_sales_unpaid",
  countSalesUnpaid: "count_sales_unpaid",
};

/** 統計列 → 原站 JSON（鍵與順序同原站 /ajax/GroupBuyDailyStatistics/list） */
export function gbdsToApi(r: AnyRow): AnyRow {
  return {
    groupBuyDailyStatisticsId: int(r.id),
    title: r.title ?? "",
    amountSales: num(r.amount_sales),
    amountSalesPaid: num(r.amount_sales_paid),
    countSales: int(r.count_sales),
    countSalesPaid: int(r.count_sales_paid),
    groupBuyId: int(r.group_buy_id),
    shortUrl: r.short_url ?? "",
    amountSalesUnpaid: num(r.amount_sales_unpaid),
    countSalesUnpaid: int(r.count_sales_unpaid),
    dateStatisticsString: tpeDate(r.date_statistics),
    dateCreatedString: tpeDateTimeSec(r.created_at),
    dateModifiedString: tpeDateTimeSec(r.created_at),
  };
}

/** 依 DataTables 排序欄套用 PostgREST 排序（只接受白名單欄位） */
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

function emptyList(dt: DtRequest, started: number): Response {
  return dtResponse(dt, { rows: [], recordsTotal: 0, recordsFiltered: 0, options: {}, dateModified: 0 }, started);
}

/** 共用：查每日銷售（list 與 銷售一覽/單一團購分析共用同一口徑） */
export async function queryGroupBuyDaily(
  tenantId: number,
  opts: { from: string; to: string; groupBuyId?: number | null; separate?: boolean; groupBuyIds?: number[] | null },
  dt?: DtRequest,
): Promise<{ rows: AnyRow[]; total: number }> {
  const db = getServiceClient();
  const len = dt && dt.serverSide && dt.length > 0 ? Math.min(dt.length, 1000) : 1000;
  const start = dt && dt.serverSide ? dt.start : 0;
  const empty = { rows: [], total: 0 };
  if (opts.groupBuyIds && opts.groupBuyIds.length === 0) return empty;
  if (opts.groupBuyId || opts.separate) {
    let q = db
      .from("group_buy_daily_statistics")
      .select("*", { count: "exact" })
      .eq("tenant_id", tenantId)
      .gte("date_statistics", opts.from)
      .lte("date_statistics", opts.to);
    if (opts.groupBuyId) q = q.eq("group_buy_id", opts.groupBuyId);
    if (opts.groupBuyIds) q = q.in("group_buy_id", opts.groupBuyIds);
    q = applyOrder(q, dt ?? ({ order: [] } as unknown as DtRequest), GBDS_COLUMNS, [
      { col: "date_statistics", asc: false },
      { col: "group_buy_id", asc: true },
    ]);
    const { data, error, count } = await q.range(start, start + len - 1);
    if (error) throw new Error(`[analytics] 每日銷售查詢失敗：${error.message}`);
    return { rows: (data ?? []) as AnyRow[], total: count ?? 0 };
  }
  let q = db.rpc(
    "analytics_gbds_agg",
    { p_tenant_id: tenantId, p_from: opts.from, p_to: opts.to, p_group_buy_ids: opts.groupBuyIds ?? null },
    { count: "exact" },
  );
  q = applyOrder(q, dt ?? ({ order: [] } as unknown as DtRequest), GBDS_COLUMNS, [
    { col: "date_statistics", asc: false },
    { col: "group_buy_id", asc: true },
  ]);
  const { data, error, count } = await q.range(start, start + len - 1);
  if (error) throw new Error(`[analytics] 每日銷售彙總失敗：${error.message}`);
  return { rows: (data ?? []) as AnyRow[], total: count ?? 0 };
}

async function listGroupBuyDaily(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  let from = parseDate(dt.extra.fromday);
  let to = parseDate(dt.extra.today);
  const day = parseDate(dt.extra.day);
  if (!from && !to && day) from = to = day;
  // 原站：未給日期區間時不回資料
  if (!from || !to) return emptyList(dt, started);
  if (from > to) [from, to] = [to, from];
  const gbRaw = Number(dt.extra.groupBuyId);
  const groupBuyId = Number.isSafeInteger(gbRaw) && gbRaw > 0 ? gbRaw : null;
  const groupBuyIds = await groupBuyIdsByKeywords(session.tenantId, parseKeywords(dt.extra.keywords), boolParam(dt.extra.allMatch));
  const refreshed = await ensureFresh(session.tenantId);
  const { rows, total } = await queryGroupBuyDaily(
    session.tenantId,
    { from, to, groupBuyId, separate: boolParam(dt.extra.separateByDate), groupBuyIds },
    dt,
  );
  return dtResponse(
    dt,
    { rows: rows.map(gbdsToApi), recordsTotal: total, recordsFiltered: total, options: {}, dateModified: rows.length ? refreshed.getTime() : 0 },
    started,
  );
}

/* ───────────── 即時統計（團購銷售(月)「實時銷售統計」） ───────────── */

async function realtimeStatistics(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const fromIso = parseTpeDateTime(dt.extra.fromday);
  const toIso = parseTpeDateTime(dt.extra.today);
  if (!fromIso || !toIso) return emptyList(dt, started);
  const [a, b] = fromIso <= toIso ? [fromIso, toIso] : [toIso, fromIso];
  if (new Date(b).getTime() - new Date(a).getTime() > 31 * 86400000) throw badRequest("時間範圍不能超過31天");
  const separate = boolParam(dt.extra.separateByDate);
  const groupBuyIds = await groupBuyIdsByKeywords(session.tenantId, parseKeywords(dt.extra.keywords), boolParam(dt.extra.allMatch));
  if (groupBuyIds && groupBuyIds.length === 0) return emptyList(dt, started);
  const db = getServiceClient();
  const orders = await fetchAll<AnyRow>((f, t) => {
    let q = db
      .from("analytics_orders_v")
      .select("sales_order_id, group_buy_id, grand_total, is_paid, created_date")
      .eq("tenant_id", session.tenantId)
      .gte("created_at", a)
      .lte("created_at", b)
      .not("group_buy_id", "is", null);
    if (groupBuyIds) q = q.in("group_buy_id", groupBuyIds);
    return q.order("sales_order_id").range(f, t);
  });
  const agg = new Map<string, AnyRow>();
  for (const o of orders) {
    const key = separate ? `${o.group_buy_id}|${o.created_date}` : String(o.group_buy_id);
    let r = agg.get(key);
    if (!r) {
      r = { groupBuyId: int(o.group_buy_id), date: String(o.created_date), amountSales: 0, countSales: 0, amountSalesPaid: 0, countSalesPaid: 0, amountSalesUnpaid: 0, countSalesUnpaid: 0 };
      agg.set(key, r);
    }
    const amt = num(o.grand_total);
    r.amountSales += amt;
    r.countSales += 1;
    if (o.is_paid) {
      r.amountSalesPaid += amt;
      r.countSalesPaid += 1;
    } else {
      r.amountSalesUnpaid += amt;
      r.countSalesUnpaid += 1;
    }
  }
  const gbIds = [...new Set([...agg.values()].map((r) => r.groupBuyId))];
  const gbs = new Map<number, AnyRow>();
  const roas = new Map<number, AnyRow>();
  if (gbIds.length) {
    const { data } = await db.from("group_buys").select("id, title, short_url").eq("tenant_id", session.tenantId).in("id", gbIds);
    for (const g of (data ?? []) as AnyRow[]) gbs.set(int(g.id), g);
    const { data: rd } = await db
      .from("roas_data_items")
      .select("*")
      .eq("tenant_id", session.tenantId)
      .in("group_buy_id", gbIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    for (const r of (rd ?? []) as AnyRow[]) if (!roas.has(int(r.group_buy_id))) roas.set(int(r.group_buy_id), r);
  }
  const rows = [...agg.values()]
    .map((r) => {
      const g = gbs.get(r.groupBuyId);
      const out: AnyRow = {
        groupBuyId: r.groupBuyId,
        shortUrl: g?.short_url ?? "",
        title: g?.title ?? "",
        amountSales: num(r.amountSales),
        countSales: r.countSales,
        amountSalesPaid: num(r.amountSalesPaid),
        countSalesPaid: r.countSalesPaid,
        amountSalesUnpaid: num(r.amountSalesUnpaid),
        countSalesUnpaid: r.countSalesUnpaid,
      };
      if (separate) out.dateStatisticsString = r.date;
      const rd = roas.get(r.groupBuyId);
      if (rd) {
        const converted = num(rd.converted_cost);
        out.roasDataItem = {
          roasDataItemId: int(rd.id),
          groupBuyId: int(rd.group_buy_id),
          shortUrl: rd.short_url ?? "",
          cost: num(rd.cost),
          exchangeRate: Number(rd.exchange_rate ?? 1),
          convertedCost: converted,
          // ROAS＝本區間銷售總金額 ÷ 廣告金額（台幣）
          roas: converted > 0 ? Math.round((num(r.amountSales) / converted) * 100) / 100 : null,
          result: rd.result ?? "",
          dateStatisticsString: tpeDate(rd.date_statistics),
          dateCreatedString: tpeDateTimeSec(rd.created_at),
        };
      }
      return out;
    })
    .sort((x, y) => y.amountSales - x.amountSales || x.groupBuyId - y.groupBuyId || String(y.dateStatisticsString ?? "").localeCompare(String(x.dateStatisticsString ?? "")));
  return dtResponse(dt, { rows, recordsTotal: rows.length, recordsFiltered: rows.length, options: {}, dateModified: rows.length ? Date.now() : 0 }, started);
}

/* ───────────── ROAS 上傳（ExcelUploader uploadMode=json） ───────────── */

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,$\s]/g, "").replace(/^NT\$?/i, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function uploadRoasData(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const payload = (body.json ?? {}) as AnyRow;
  const list = Array.isArray(payload.data) ? (payload.data as AnyRow[]) : [];
  if (!list.length) return jsonError(400, "沒有可上傳的數據");
  if (list.length > 5000) return jsonError(400, "一次最多上傳 5000 筆");
  const rate = toNumber(payload.exchangeRate) ?? 1;
  if (!(rate > 0)) return jsonError(400, "匯率必須大於 0");
  const db = getServiceClient();
  const { data: gbData } = await db.from("group_buys").select("id, short_url").eq("tenant_id", session.tenantId);
  const byId = new Map<number, AnyRow>();
  const byShort = new Map<string, AnyRow>();
  for (const g of (gbData ?? []) as AnyRow[]) {
    byId.set(int(g.id), g);
    if (g.short_url) byShort.set(String(g.short_url).toLowerCase(), g);
  }
  const today = todayTpe();
  const inserts: AnyRow[] = [];
  const skipped: number[] = [];
  list.forEach((row, i) => {
    const idRaw = String(row.groupBuyId ?? "").trim();
    const shortRaw = String(row.shortUrl ?? "").trim().toLowerCase();
    const g = (idRaw && byId.get(Number(idRaw))) || (shortRaw && byShort.get(shortRaw)) || null;
    const cost = toNumber(row.cost);
    if (!g || cost === null) {
      skipped.push(i + 2);
      return;
    }
    inserts.push({
      tenant_id: session.tenantId,
      group_buy_id: int(g.id),
      short_url: g.short_url ?? null,
      date_statistics: today,
      cost,
      exchange_rate: rate,
      converted_cost: Math.round(cost * rate * 100) / 100,
      result: row.result === undefined || row.result === null ? null : String(row.result).slice(0, 200),
    });
  });
  if (!inserts.length) return jsonError(400, "找不到對應的團購（請確認團購ID或團購短五碼）");
  const { data, error } = await db.from("roas_data_items").insert(inserts).select("*");
  if (error) throw new Error(`[analytics] ROAS 上傳失敗：${error.message}`);
  const saved = ((data ?? []) as AnyRow[]).map((r) => ({
    roasDataItemId: int(r.id),
    groupBuyId: int(r.group_buy_id),
    shortUrl: r.short_url ?? "",
    cost: num(r.cost),
    exchangeRate: Number(r.exchange_rate),
    convertedCost: num(r.converted_cost),
    result: r.result ?? "",
    dateStatisticsString: tpeDate(r.date_statistics),
  }));
  const message = skipped.length ? `上傳成功 ${saved.length} 筆；略過 ${skipped.length} 筆（第 ${skipped.slice(0, 20).join("、")} 列）` : `上傳成功 ${saved.length} 筆`;
  return json({ code: 200, success: true, error: message, message, data: saved });
}

/* ───────────── 商品每日銷售 ───────────── */

const IDS_COLUMNS: Record<string, string> = {
  dateStatisticsString: "date_statistics",
  title: "title",
  uid: "uid",
  amountSales: "amount_sales",
  countSales: "count_sales",
  amountSalesPaid: "amount_sales_paid",
  countSalesPaid: "count_sales_paid",
};

export function idsToApi(r: AnyRow): AnyRow {
  return {
    itemDailyStatisticsId: int(r.id),
    title: r.title ?? "",
    uid: r.uid ?? "",
    amountSales: num(r.amount_sales),
    amountSalesPaid: num(r.amount_sales_paid),
    countSales: int(r.count_sales),
    countSalesPaid: int(r.count_sales_paid),
    dateStatisticsString: tpeDate(r.date_statistics),
    dateCreatedString: tpeDateTimeSec(r.created_at),
    dateModifiedString: tpeDateTimeSec(r.created_at),
    key: int(r.id),
  };
}

/** 共用：商品銷售依代碼合併（無代碼＝'###'）；銷售一覽的商品卡也用這個 */
export async function queryItemDaily(
  tenantId: number,
  opts: { from: string; to: string; separate?: boolean; uidExact?: string | null; uidLike?: string | null; uidSuffix?: string | null },
  dt?: DtRequest,
): Promise<{ rows: AnyRow[]; total: number }> {
  const db = getServiceClient();
  const len = dt && dt.serverSide && dt.length > 0 ? Math.min(dt.length, 1000) : 1000;
  const start = dt && dt.serverSide ? dt.start : 0;
  let q = db.rpc("analytics_items_agg", { p_tenant_id: tenantId, p_from: opts.from, p_to: opts.to, p_separate: !!opts.separate }, { count: "exact" });
  if (opts.uidExact) q = q.eq("uid", opts.uidExact);
  if (opts.uidLike) q = q.ilike("uid", `%${opts.uidLike}%`);
  if (opts.uidSuffix) q = q.ilike("uid", `%${opts.uidSuffix}`);
  q = applyOrder(q, dt ?? ({ order: [] } as unknown as DtRequest), IDS_COLUMNS, [
    { col: "date_statistics", asc: false },
    { col: "amount_sales", asc: false },
  ]);
  const { data, error, count } = await q.range(start, start + len - 1);
  if (error) throw new Error(`[analytics] 商品每日銷售查詢失敗：${error.message}`);
  return { rows: (data ?? []) as AnyRow[], total: count ?? 0 };
}

async function listItemDaily(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  let from = parseDate(dt.extra.fromday);
  let to = parseDate(dt.extra.today);
  const day = parseDate(dt.extra.day);
  if (!from && !to && day) from = to = day;
  if (!from || !to) return emptyList(dt, started);
  if (from > to) [from, to] = [to, from];
  const uid = String(dt.extra.uid ?? "").trim();
  const colSearch = dt.columns.find((c) => c.data === "uid")?.search ?? "";
  const s = colSearch.trim();
  const suffix = s.startsWith("?") ? sanitizeLike(s.slice(1)) : "";
  const like = !s.startsWith("?") ? sanitizeLike(s) : "";
  const refreshed = await ensureFresh(session.tenantId);
  const { rows, total } = await queryItemDaily(
    session.tenantId,
    { from, to, separate: boolParam(dt.extra.separateByDate), uidExact: uid || null, uidLike: like || null, uidSuffix: suffix || null },
    dt,
  );
  return dtResponse(
    dt,
    { rows: rows.map(idsToApi), recordsTotal: total, recordsFiltered: total, options: {}, dateModified: rows.length ? refreshed.getTime() : 0 },
    started,
  );
}

/* ───────────── Editor（原站頁面的新增/編輯/刪除按鈕已註解；端點照原站保留） ───────────── */

async function groupBuyBelongs(ctx: EntityCtx, id: unknown): Promise<boolean> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  const { data } = await getServiceClient().from("group_buys").select("id").eq("tenant_id", ctx.session.tenantId).eq("id", n).maybeSingle();
  return !!data;
}

const gbdsWrite: WriteSpec = {
  mapRow: (_api, row) => gbdsToApi(row),
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "dateStatisticsString" in values) {
      if (!parseDate(values.dateStatisticsString)) errors.push({ name: "dateStatisticsString", status: "日期格式錯誤" });
    }
    if (action === "create" || "groupBuyId" in values) {
      if (!(await groupBuyBelongs(ctx, values.groupBuyId))) errors.push({ name: "groupBuyId", status: "找不到此團購" });
    }
    return errors;
  },
  beforeWrite(dbRow, values) {
    delete dbRow.tenant_id;
    if ("dateStatisticsString" in values) dbRow.date_statistics = parseDate(values.dateStatisticsString);
    return dbRow;
  },
  optimisticLock: false,
};

const idsWrite: WriteSpec = {
  mapRow: (_api, row) => idsToApi(row),
  async validate(values, action) {
    if (action === "create") return [{ name: "dateStatisticsString", status: "商品每日銷售由系統依訂單自動產生，無法手動新增" }];
    if ("dateStatisticsString" in values && !parseDate(values.dateStatisticsString)) return [{ name: "dateStatisticsString", status: "日期格式錯誤" }];
    return [];
  },
  beforeWrite(dbRow, values) {
    delete dbRow.tenant_id;
    delete dbRow.item_id;
    delete dbRow.group_buy_id;
    if ("dateStatisticsString" in values) dbRow.date_statistics = parseDate(values.dateStatisticsString);
    return dbRow;
  },
  optimisticLock: false,
};

export const dailyStatisticsRoutes: RouteDef[] = [
  page("/backend/GroupBuyDailyStatistics/list", {
    template: "analytics/groupbuydailystatistics-list.html",
    title: "每日銷售",
    groupBuy: "auto",
  }),
  route(["GET", "POST"], "/ajax/GroupBuyDailyStatistics/list", listGroupBuyDaily),
  route(["GET", "POST"], "/ajax/GroupBuyDailyStatistics/getRealtimeStatistics", realtimeStatistics),
  post("/ajax/GroupBuyDailyStatistics/uploadRoasData", uploadRoasData),
  ...crudRoutes(groupBuyDailyStatistics, {
    save: "/ajax/GroupBuyDailyStatistics/save",
    update: "/ajax/GroupBuyDailyStatistics/update",
    delete: "/ajax/GroupBuyDailyStatistics/delete",
    writeSpec: gbdsWrite,
  }),

  page("/backend/ItemDailyStatistics/list", {
    template: "analytics/itemdailystatistics-list.html",
    title: "每日銷售",
    groupBuy: "none",
    activeHref: "/backend/SalesAnalysis/panel",
    data: (ctx) => ({ uid: String(ctx.query.get("uid") ?? "").slice(0, 100) }),
  }),
  route(["GET", "POST"], "/ajax/ItemDailyStatistics/list", listItemDaily),
  ...crudRoutes(itemDailyStatistics, {
    save: "/ajax/ItemDailyStatistics/save",
    update: "/ajax/ItemDailyStatistics/update",
    delete: "/ajax/ItemDailyStatistics/delete",
    writeSpec: idsWrite,
  }),
];

