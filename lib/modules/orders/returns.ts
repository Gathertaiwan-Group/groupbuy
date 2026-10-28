// 退換貨訂單（/backend/SalesOrderReturn/list）＋加退換商品精靈（/backend/ReturnRefund/wizard）。（擁有者：orders 模組 orders-returns）
// 原站：spec/html/salesorderreturn-list.html（缺段已由原站重讀補齊）、spec/runtime/salesorderreturn-list.records.txt；
//      精靈與其表單片段由原站實際擷取：/backend/ReturnRefund/wizard、/ajax/ReturnRefund/displayReturn、
//      /ajax/ReturnRefund/displayReshipment、/scripts/rr.js（鏡射於 public/modules/orders/returns-rr.js）。
// 資料：列表讀唯讀檢視 sales_order_returns_v；寫入走 DB 函式（migration 3020，整批原子交易）：
//   orders_rr_create（產生退貨/換貨/補寄訂單；原單商品數量移至新單）、orders_rr_action（列操作/工具列）、
//   orders_rr_new_order（建立新單/重開新單）、orders_rr_apply_edit（原單操作送出；migration 3022）。
//   狀態異動皆經 orders_admin_update（歷程 actor=ADMIN）、庫存經 orders_adjust_item_stock。3021/3023 為 3020 函式修正。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/SalesOrderReturn/list                         頁面
//   POST /ajax/SalesOrderReturn/list                            列表（serverSide；分頁籤 relation/status/state、只顯示進行中、建立日期、表尾搜尋）
//   POST /ajax/SalesOrderReturn/action?salesOrderId=…           列按鈕（Editor remove 協定，body action=pickupReturn…）
//   POST /ajax/SalesOrderReturn/action?action=returned|returned_nosale   工具列（body salesOrderId=1,2）
//   POST /backend/SalesOrderReturn/batchAction                  匯出報表（EXPORT_CSV、EXPORT_ERP…ERP6）、匯出貨運清單（EXPORT_SHIPPING_CSV）
//   GET  /backend/ReturnRefund/wizard?uuid=&salesOrderId=       加退換商品精靈（openFormF）
//   GET  /ajax/ReturnRefund/displayReturn?salesOrderId=         退/換貨表單（showAjax）
//   GET  /ajax/ReturnRefund/displayReshipment?salesOrderId=     補寄表單（showAjax）
//   GET  /ajax/ReturnRefund/get?salesOrderId=                   表單載入訂單商品（rr.js）
//   POST /ajax/ReturnRefund/doReturn                            產生退貨訂單（exchange_mode：none/same/diff → 可同時產生換貨單）
//   POST /ajax/ReturnRefund/doReshipment                        產生補寄訂單
//   POST /ajax/SalesOrder/createNewForReturnRefund              精靈「建立新單」（原站 $.get；本系統寫入端點一律 POST）
//   POST /ajax/SalesOrder/createAndMove                         精靈「重開新單」（原站卡片隱藏；同上）
//   GET  /backend/ReturnRefund/displayReturnAndRefund?salesOrderId=   精靈「原單操作[預設]」／「開始修改訂單」／「編輯換貨單」
//   POST /ajax/ReturnRefund/prepare|updateOrderItem|addOrderItem|applySalesRules   原單操作試算（原站前三者為 GET；寫入草稿改 POST）
//        applySalesRules＝正式優惠引擎 evaluatePricing 重算（returns-pricing.ts；PARITY #58），送出時折扣合計與優惠條件一併寫回
//   GET  /ajax/ReturnRefund/itemTags|itemOptions|isTypeBundleConfigable            原單操作「下拉選擇商品」（取代原站 /ajax/Item/*）
//   POST /ajax/ReturnRefund/returnAndRefund                      原單操作送出（商品/運費/訂單金額寫回、差額新單、訂單更新信【未串接】）
import { evaluatePricing } from "@/lib/modules/marketing/pricing-rules";
import { loadPricingInputForOrder } from "@/lib/modules/marketing/pricing-loader";
import { applyLineDiscounts, draftCartInputs, draftNewGrandTotal, type DraftPricing } from "./returns-pricing";
import ExcelJS from "exceljs";
import { salesOrderReturn } from "@/lib/db/entities";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, intParam, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, download, json } from "@/lib/core/http/responses";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { dtQuery, type AnyQuery } from "@/lib/core/datatables/query";
import type { DtColumn, DtOrder, DtRequest } from "@/lib/core/datatables/request";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { enumLabel, enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import type { Row } from "@/lib/db/mapping";
import {
  adminUpdateOrders,
  boolParam,
  db,
  fetchOrderByUuid,
  fetchOrders,
  idsParam,
  recordEmail,
  strParam,
  taipeiDateStart,
  taipeiStartOfDay,
} from "./common";
import { loadOrdersApi, shippingAddressOf } from "./order-api";

/* ─────────────────────────── 常數 ─────────────────────────── */

const RR_RELATIONS = ["RETURN", "REPLACE", "RESHIPMENT"];
const RR_ACTIONS = [
  "pickupReturn",
  "verifyReturn",
  "returned",
  "returned_nosale",
  "replaced",
  "reshipmented",
  "cancel_return",
  "cancel_replace",
];
/**
 * 分頁 data-status → 實際包含的狀態。推導：原站列按鈕會把退貨單改成「退貨取件中/退貨檢核中」（列 render 也處理這兩個狀態），
 * 它們只可能出現在「退貨申請中」分頁；換貨/補寄單出貨後（已出貨/已出貨通知）在完成前仍歸「準備出貨中」。
 */
const STATUS_GROUPS: Record<string, string[]> = {
  INQUIRED_RETURN: ["INQUIRED_RETURN", "PICKUP_RETURN", "VERIFY_RETURN"],
  PREPARE_SHIPPING: ["PREPARE_SHIPPING", "SHIPPED", "SHIPPING_EMAIL_SENT", "SHIPPING_EMAIL_FAILED"],
};
/** 精靈按鈕出現的訂單階段（原站 salesOrderList.min.js：COMPLETE/PROCESSING/HOLDED/RETURNING/RETURNED） */
const WIZARD_STATES = ["COMPLETE", "PROCESSING", "HOLDED", "RETURNING", "RETURNED"];
/** 「限已出貨」判斷：有出貨日、或階段/狀態表示已出貨過 */
const SHIPPED_STATES = ["COMPLETE", "RETURNING", "RETURNED"];
const SHIPPED_STATUSES = [
  "SHIPPED",
  "SHIPPING_EMAIL_SENT",
  "SHIPPING_EMAIL_FAILED",
  "CVS_PICKUP_DATE_DUED",
  "INQUIRED_RETURN",
  "INQUIRED_REPLACE",
  "INQUIRED_RESHIPMENT",
  "PICKUP_RETURN",
  "VERIFY_RETURN",
  "RETURNED",
  "REPLACED",
  "RESHIPMENTED",
  "RESHIPMENT_CONFIRMED",
  "RETURNED_EMAIL_SENT",
];
const MAX_EXPORT = 4000; // 原站「單次匯出上限為4000筆」
const MAX_SHIPPING_EXPORT = 500; // 原站「一次最多匯出500筆」
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ERP_TITLES: Record<string, string> = {
  EXPORT_ERP: "ERP報表1",
  EXPORT_ERP2: "ERP報表2",
  EXPORT_ERP3: "ERP報表3",
  EXPORT_ERP4: "ERP報表4",
  EXPORT_ERP5: "ERP報表5",
  EXPORT_ERP6: "ERP報表6",
};
const RR_ORDER_SELECT = "id,uuid,state,status,date_shipped,total_paid,grand_total";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const csvList = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Z_]+$/.test(s));

export function isShipped(o: Row): boolean {
  return !!o.date_shipped || SHIPPED_STATES.includes(String(o.state)) || SHIPPED_STATUSES.includes(String(o.status));
}
export function isPaid(o: Row): boolean {
  return num(o.total_paid) > 0;
}

/** DB 函式以 'RR:' 開頭的錯誤 → 400（訊息給前端）；其他 → 500 */
function rrFail(error: { message?: string } | null, where: string): never {
  const m = String(error?.message ?? "");
  if (m.startsWith("RR:")) throw badRequest(m.slice(3));
  throw new Error(`[orders returns] ${where}：${m}`);
}

/* ─────────────────────────── 列表篩選 ─────────────────────────── */

interface RrFilters {
  relation: string;
  status: string;
  state: string;
  hideDone: boolean;
  days: string;
  dateCreatedBegin: string;
  dateCreatedEnd: string;
}

const truthy = (v: unknown) => ["true", "1", "on", "yes"].includes(String(v ?? "").trim().toLowerCase());

function filtersFrom(get: (k: string) => unknown): RrFilters {
  const s = (k: string) => {
    const v = get(k);
    return v === undefined || v === null ? "" : String(v).trim();
  };
  return {
    relation: s("relation"),
    status: s("status"),
    state: s("state"),
    hideDone: truthy(get("hideDone")),
    days: s("days"),
    dateCreatedBegin: s("dateCreatedBegin"),
    dateCreatedEnd: s("dateCreatedEnd"),
  };
}

/** 建立日期：30＝30 日內、0＝今日、1＝昨日、-1＝指定區間（含結束日）；台灣時間 */
function dateRange(f: RrFilters): { from?: Date; to?: Date } {
  const days = f.days === "" ? 30 : Number(f.days);
  if (days === -1) {
    const b = taipeiDateStart(f.dateCreatedBegin);
    const e = taipeiDateStart(f.dateCreatedEnd);
    return { from: b ?? undefined, to: e ? new Date(e.getTime() + 86400_000) : undefined };
  }
  if (days === 0) return { from: taipeiStartOfDay(), to: taipeiStartOfDay(new Date(), 1) };
  if (days === 1) return { from: taipeiStartOfDay(new Date(), -1), to: taipeiStartOfDay() };
  if (Number.isFinite(days) && days > 1) return { from: taipeiStartOfDay(new Date(), -days) };
  return {};
}

function applyFilters(q: AnyQuery, f: RrFilters): AnyQuery {
  const rel = csvList(f.relation).filter((r) => RR_RELATIONS.includes(r));
  if (rel.length) q = q.in("relation", rel);
  const statuses = [...new Set(csvList(f.status).flatMap((s) => STATUS_GROUPS[s] ?? [s]))];
  if (statuses.length) q = q.in("status", statuses);
  const states = csvList(f.state);
  if (states.length) q = q.in("state", states);
  else q = q.not("state", "in", statuses.length ? "(CANCELED,DELETED)" : "(DELETED)");
  if (f.hideDone) q = q.eq("is_done", false);
  const r = dateRange(f);
  if (r.from) q = q.gte("created_at", r.from.toISOString());
  if (r.to) q = q.lt("created_at", r.to.toISOString());
  return q;
}

/** 列表 options：原站 SalesOrderReturn 列舉；status 補上列按鈕會產生的「退貨取件中/退貨檢核中」（否則欄位顯示空白） */
async function rrOptions(): Promise<EditorOptions> {
  const o = await enumOptionsFor({
    state: "SalesOrderReturn.state",
    status: "SalesOrderReturn.status",
    relation: "SalesOrderReturn.relation",
  });
  for (const code of ["PICKUP_RETURN", "VERIFY_RETURN"]) {
    if (!o.status.some((x) => x.value === code)) o.status.push({ label: await enumLabel("SalesOrder.status", code), value: code });
  }
  return o;
}

const listSpec: ListSpec = {
  search: [],
  like: ["firstname"],
  defaultOrder: [{ key: "dateCreated", ascending: false }],
  where: (q, dt) => applyFilters(q, filtersFrom((k) => dt.extra[k])),
  options: () => rrOptions(),
};

/* ─────────────────────────── 列操作／工具列 ─────────────────────────── */

async function rrAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const action = await strParam(ctx, "action"); // 工具列在 query（?action=returned）；列按鈕在 body（Editor remove 的 data.action）
  if (!RR_ACTIONS.includes(action)) throw badRequest("不支援的操作");
  const ids = await idsParam(ctx, "salesOrderId");
  if (!ids.length) throw badRequest("請選擇訂單");
  const { data, error } = await db().rpc("orders_rr_action", {
    p_tenant_id: session.tenantId,
    p_ids: ids,
    p_action: action,
    p_admin_user_id: session.adminUserId,
  });
  if (error) rrFail(error, "操作");
  const res = (data ?? {}) as { done?: number[]; skipped?: { salesOrderId: number; uuid?: string; reason: string }[] };
  const done = res.done ?? [];
  const skipped = res.skipped ?? [];
  if (!done.length) {
    throw badRequest(skipped.map((s) => `${s.uuid ?? s.salesOrderId}：${s.reason}`).join("<br>") || "沒有可執行的訂單");
  }
  // Editor remove 成功格式（不可帶非空 error）；工具列 actionButton 只看 HTTP 成功
  return json({
    data: [],
    done,
    skipped,
    message: `已處理 ${done.length} 筆` + (skipped.length ? `，略過 ${skipped.length} 筆（${skipped.map((s) => `${s.uuid ?? s.salesOrderId}：${s.reason}`).join("、")}）` : ""),
  });
}

/* ─────────────────────────── 匯出 ─────────────────────────── */

type ViewRow = Row;
type DetailRow = Row & { order_items?: Row[]; group_buys?: { title?: string } | null };

/** 匯出報表的 query（原站 table.ajax.params() 的 legacy 參數＋appendExtra）→ DtRequest（表尾搜尋、排序、分頁沿用列表） */
function dtFromQuery(q: Record<string, unknown>): DtRequest {
  const g = (k: string) => (q[k] === undefined || q[k] === null ? undefined : String(q[k]));
  const n = Math.min(Number(g("iColumns") ?? 0) || 0, 50);
  const columns: DtColumn[] = [];
  for (let i = 0; i < n; i++) {
    columns.push({ index: i, data: g(`mDataProp_${i}`) ?? "", name: "", searchable: true, orderable: true, search: g(`sSearch_${i}`) ?? "" });
  }
  const order: DtOrder[] = [];
  const sc = Math.min(Number(g("iSortingCols") ?? 0) || 0, 10);
  for (let k = 0; k < sc; k++) {
    const c = Number(g(`iSortCol_${k}`));
    if (!Number.isInteger(c) || c < 0) continue;
    order.push({ column: c, dir: g(`sSortDir_${k}`) === "desc" ? "desc" : "asc", data: columns[c]?.data ?? "" });
  }
  const start = Math.max(0, Number(g("iDisplayStart") ?? 0) || 0);
  let length = Number(g("iDisplayLength") ?? MAX_EXPORT) || MAX_EXPORT;
  if (length <= 0 || length > MAX_EXPORT) length = MAX_EXPORT;
  return { serverSide: true, draw: 0, start, length, search: "", columns, order, extra: {}, extraAll: {} };
}

async function viewRowsByIds(session: AdminSession, ids: number[]): Promise<ViewRow[]> {
  const out: ViewRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db()
      .from("sales_order_returns_v")
      .select("*")
      .eq("tenant_id", session.tenantId)
      .in("sales_order_id", ids.slice(i, i + 500));
    if (error) throw new Error(`[orders returns] 讀取退換貨訂單失敗：${error.message}`);
    out.push(...((data ?? []) as ViewRow[]));
  }
  return out.sort(
    (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime() || num(a.relation_id) - num(b.relation_id),
  );
}

async function viewRowsByQuery(session: AdminSession, f: RrFilters, query: Record<string, unknown>): Promise<ViewRow[]> {
  const dt = dtFromQuery(query);
  const out: ViewRow[] = [];
  const end = dt.start + dt.length;
  for (let start = dt.start; start < end; start += 1000) {
    const page = { ...dt, start, length: Math.min(1000, end - start) };
    const r = await dtQuery<ViewRow>(db(), page, {
      table: "sales_order_returns_v",
      tenantId: session.tenantId,
      columnMap: salesOrderReturn.fields,
      likeColumns: ["firstname"],
      where: (q) => applyFilters(q, f),
      defaultOrder: [{ column: "created_at", ascending: false }],
      tieBreaker: "relation_id",
    });
    out.push(...r.rows);
    if (r.rows.length < page.length) break;
  }
  return out;
}

async function loadDetails(session: AdminSession, ids: number[]): Promise<Map<number, DetailRow>> {
  const map = new Map<number, DetailRow>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db()
      .from("sales_orders")
      .select("*, group_buys(title), order_items(*)")
      .eq("tenant_id", session.tenantId)
      .in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`[orders returns] 讀取訂單明細失敗：${error.message}`);
    for (const r of (data ?? []) as unknown as DetailRow[]) {
      r.order_items = [...(r.order_items ?? [])].sort((a, b) => num(a.seq) - num(b.seq) || num(a.id) - num(b.id));
      map.set(Number(r.id), r);
    }
  }
  return map;
}

async function labelMaps() {
  const m = async (k: string) => new Map((await enumOptions(k)).map((o) => [String(o.value), o.label]));
  const status = await m("SalesOrderReturn.status");
  const soStatus = await m("SalesOrder.status");
  for (const [k, v] of soStatus) if (!status.has(k)) status.set(k, v);
  return {
    relation: await m("SalesOrderReturn.relation"),
    state: await m("SalesOrderReturn.state"),
    status,
    itemState: await m("OrderItem.state"),
    shippingType: await m("ShippingType"),
  };
}
type Labels = Awaited<ReturnType<typeof labelMaps>>;
const lab = (m: Map<string, string>, v: unknown) => (v === null || v === undefined || v === "" ? "" : m.get(String(v)) ?? String(v));

/** CSV（UTF-8 BOM、CRLF）；以 = 或 @ 開頭的儲存格前置 ' 避免試算表當公式執行 */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
function stamp(): string {
  return taipeiDateTime(new Date()).replace(/[-: ]/g, "");
}
const itemsText = (o: DetailRow | undefined) =>
  (o?.order_items ?? [])
    .filter((i) => !i.bundle_child && num(i.total) > 0)
    .map((i) => `${i.title}${i.specifications_label ? `(${i.specifications_label})` : ""}x${i.total}`)
    .join("; ");
const itemsTotal = (o: DetailRow | undefined) =>
  (o?.order_items ?? []).filter((i) => !i.bundle_child).reduce((s, i) => s + num(i.total), 0);
const itemsAmount = (o: DetailRow | undefined) =>
  (o?.order_items ?? []).filter((i) => !i.bundle_child).reduce((s, i) => s + num(i.amount), 0);

function exportCsv(rows: ViewRow[], details: Map<number, DetailRow>, L: Labels): string {
  const header = [
    "建立日期",
    "訂單編號",
    "原訂單編號",
    "退換貨",
    "顧客姓名",
    "顧客電話",
    "階段",
    "狀態",
    "結帳金額",
    "已付金額",
    "商品金額",
    "商品明細",
    "團購",
    "員工備註",
    "進行中",
  ];
  const lines = rows.map((r) => {
    const d = details.get(Number(r.sales_order_id));
    return [
      taipeiDateTime(r.created_at),
      r.uuid,
      r.parent_uuid ?? "",
      lab(L.relation, r.relation),
      r.firstname ?? "",
      r.telephone ?? "",
      lab(L.state, r.state),
      lab(L.status, r.status),
      num(r.grand_total),
      num(r.total_paid),
      itemsAmount(d),
      itemsText(d),
      d?.group_buys?.title ?? "",
      r.staff_note ?? "",
      r.is_done ? "N" : "Y",
    ];
  });
  return toCsv([header, ...lines]);
}

async function exportErp(title: string, rows: ViewRow[], details: Map<number, DetailRow>, L: Labels): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.addRow([
    "單據日期",
    "退換貨單號",
    "原訂單編號",
    "類型",
    "階段",
    "狀態",
    "顧客姓名",
    "顧客電話",
    "團購",
    "商品代碼",
    "商品名稱",
    "規格",
    "數量",
    "單價",
    "折扣",
    "小計",
    "商品狀態",
    "員工備註",
  ]);
  for (const r of rows) {
    const d = details.get(Number(r.sales_order_id));
    const items = (d?.order_items ?? []).filter((i) => !i.bundle_child);
    const base = [
      taipeiDateTime(r.created_at),
      r.uuid,
      r.parent_uuid ?? "",
      lab(L.relation, r.relation),
      lab(L.state, r.state),
      lab(L.status, r.status),
      r.firstname ?? "",
      r.telephone ?? "",
      d?.group_buys?.title ?? "",
    ];
    if (!items.length) ws.addRow([...base, "", "", "", 0, 0, 0, 0, "", r.staff_note ?? ""]);
    for (const i of items) {
      ws.addRow([
        ...base,
        i.uid ?? "",
        i.title ?? "",
        i.specifications_label ?? "",
        num(i.total),
        num(i.price),
        num(i.discount),
        num(i.amount),
        lab(L.itemState, i.state),
        r.staff_note ?? "",
      ]);
    }
  }
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => {
    let w = 8;
    c.eachCell?.({ includeEmpty: false }, (cell) => {
      w = Math.min(60, Math.max(w, String(cell.value ?? "").length * 1.6 + 2));
    });
    c.width = w;
  });
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

function shippingCsv(rows: ViewRow[], details: Map<number, DetailRow>, L: Labels): string {
  const header = [
    "訂單編號",
    "原訂單編號",
    "退換貨",
    "收件人",
    "收件人電話",
    "收件人Email",
    "郵遞區號",
    "收件地址",
    "配送方式",
    "超商門市代號",
    "超商門市名稱",
    "商品明細",
    "商品總數量",
    "員工備註",
    "訂單備註",
  ];
  const lines = rows.map((r) => {
    const d = details.get(Number(r.sales_order_id)) ?? ({} as DetailRow);
    return [
      r.uuid,
      r.parent_uuid ?? "",
      lab(L.relation, r.relation),
      d.shipping_firstname || d.customer_firstname || r.firstname || "",
      d.shipping_telephone || d.customer_telephone || r.telephone || "",
      d.shipping_email || d.customer_email || "",
      d.shipping_postcode ?? "",
      shippingAddressOf(d),
      lab(L.shippingType, d.shipping_type),
      d.cvs_store_id ?? "",
      d.cvs_store_name ?? "",
      itemsText(d),
      itemsTotal(d),
      r.staff_note ?? "",
      d.note ?? "",
    ];
  });
  return toCsv([header, ...lines]);
}

async function batchAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const action = await strParam(ctx, "batchAction");
  let query: Record<string, unknown> = {};
  const raw = await strParam(ctx, "query");
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) query = v as Record<string, unknown>;
    } catch {
      throw badRequest("匯出參數格式錯誤");
    }
  }
  const ids = await idsParam(ctx, "salesOrderIds");
  // 表單欄位（分頁籤 relation/status/state、只顯示進行中、建立日期）優先，其次 query JSON（appendExtra）
  const formVals: Record<string, string> = {};
  for (const k of ["relation", "status", "state", "hideDone", "days", "dateCreatedBegin", "dateCreatedEnd"]) {
    const v = await ctx.param(k);
    if (v !== undefined) formVals[k] = v;
  }
  const f = filtersFrom((k) => (k in formVals ? formVals[k] : query[k]));
  if (!("hideDone" in formVals) && truthy(query.hideDone)) f.hideDone = true;
  const L = await labelMaps();

  if (action === "EXPORT_SHIPPING_CSV") {
    // 補換貨申請中的換貨/補寄單（不含準備出貨中）；匯出後狀態改「準備出貨中」；一次最多 500 筆
    let q = db()
      .from("sales_order_returns_v")
      .select("*")
      .eq("tenant_id", session.tenantId)
      .in("relation", ["REPLACE", "RESHIPMENT"])
      .in("status", ["INQUIRED_REPLACE", "INQUIRED_RESHIPMENT"])
      .not("state", "in", "(CANCELED,COMPLETE,DELETED)");
    if (ids.length) q = q.in("sales_order_id", ids.slice(0, 2000));
    else {
      if (f.hideDone) q = q.eq("is_done", false);
      const r = dateRange(f);
      if (r.from) q = q.gte("created_at", r.from.toISOString());
      if (r.to) q = q.lt("created_at", r.to.toISOString());
    }
    const { data, error } = await q.order("created_at", { ascending: true }).order("relation_id", { ascending: true }).limit(MAX_SHIPPING_EXPORT);
    if (error) throw new Error(`[orders returns] 匯出貨運清單失敗：${error.message}`);
    const rows = (data ?? []) as ViewRow[];
    const details = await loadDetails(session, rows.map((r) => Number(r.sales_order_id)));
    const body = shippingCsv(rows, details, L);
    if (rows.length) {
      await adminUpdateOrders(
        session,
        rows.map((r) => Number(r.sales_order_id)),
        { status: "PREPARE_SHIPPING" },
        "匯出貨運清單，狀態改為準備出貨中",
      );
    }
    return download(body, `退換貨貨運清單_${stamp()}.csv`, "text/csv;charset=UTF-8");
  }

  if (action !== "EXPORT_CSV" && !(action in ERP_TITLES)) throw badRequest("不支援的匯出項目");
  const rows = ids.length ? await viewRowsByIds(session, ids.slice(0, MAX_EXPORT)) : await viewRowsByQuery(session, f, query);
  const details = await loadDetails(session, rows.map((r) => Number(r.sales_order_id)));
  if (action === "EXPORT_CSV") {
    return download(exportCsv(rows, details, L), `退換貨訂單_${stamp()}.csv`, "text/csv;charset=UTF-8");
  }
  const title = ERP_TITLES[action];
  return download(await exportErp(title, rows, details, L), `退換貨訂單_${title}_${stamp()}.xlsx`, XLSX);
}

/* ─────────────────────────── 加退換商品精靈 ─────────────────────────── */

/** 精靈/表單片段的訂單（salesOrderId 優先，其次 uuid；以租戶過濾） */
async function wizardOrder(ctx: RequestContext): Promise<Row> {
  const session = requireSession(ctx);
  const id = Number(ctx.query.get("salesOrderId") ?? "");
  let row: Row | null = null;
  if (Number.isSafeInteger(id) && id > 0) row = (await fetchOrders(session, [id], RR_ORDER_SELECT))[0] ?? null;
  if (!row) {
    const uuid = (ctx.query.get("uuid") ?? "").trim();
    if (uuid) row = await fetchOrderByUuid(session, uuid, RR_ORDER_SELECT);
  }
  if (!row) throw notFound("訂單物件不存在");
  return row;
}

/** 產生退貨/補寄訂單前的檢查（原站：精靈按鈕只在 COMPLETE/PROCESSING/HOLDED/RETURNING/RETURNED 出現；退換貨/補寄「限已出貨」） */
async function checkRrOrder(session: AdminSession, id: number, kind: string): Promise<Row> {
  const [o] = await fetchOrders(session, [id], RR_ORDER_SELECT);
  if (!o) throw notFound("訂單物件不存在");
  if (!WIZARD_STATES.includes(String(o.state))) {
    throw badRequest(`訂單階段為「${await enumLabel("SalesOrder.state", String(o.state))}」，不可產生${kind}訂單`);
  }
  if (!isShipped(o)) throw badRequest(`${kind}限已出貨訂單使用：訂單 ${o.uuid} 尚未出貨`);
  return o;
}

async function createRr(ctx: RequestContext, relation: "RETURN" | "RESHIPMENT"): Promise<Response> {
  const session = requireSession(ctx);
  const kind = relation === "RETURN" ? "退貨" : "補寄";
  const id = Number(await strParam(ctx, "salesOrderId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少訂單");
  await checkRrOrder(session, id, kind);
  // rr.js 送出 data[<orderItemId>][orderItemId]、data[<orderItemId>][total]
  const body = await ctx.body();
  const data = body.nested.data;
  const items: { orderItemId: number; total: number }[] = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, v] of Object.entries(data)) {
      const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      const orderItemId = Number(o.orderItemId ?? key);
      const totalRaw = String(o.total ?? "0").trim() || "0";
      if (!/^\d+$/.test(totalRaw)) throw badRequest(`${kind}數量格式錯誤`);
      if (!Number.isSafeInteger(orderItemId) || orderItemId <= 0) continue;
      items.push({ orderItemId, total: Number(totalRaw) });
    }
  }
  if (!items.some((i) => i.total > 0)) throw badRequest(`請選擇${kind}商品`);
  const modeRaw = relation === "RETURN" ? (await strParam(ctx, "exchange_mode")) || "none" : "none";
  if (!["none", "same", "diff"].includes(modeRaw)) throw badRequest("換貨方式錯誤");
  const staffNote = (await strParam(ctx, "staffNote")).slice(0, 500);
  const { data: res, error } = await db().rpc("orders_rr_create", {
    p_tenant_id: session.tenantId,
    p_parent_id: id,
    p_relation: relation,
    p_items: items,
    p_staff_note: staffNote || null,
    p_exchange_mode: modeRaw,
    p_admin_user_id: session.adminUserId,
  });
  if (error) rrFail(error, `產生${kind}訂單`);
  const list = (res ?? []) as { salesOrderId: number; uuid: string; relation: string }[];
  const msg =
    `成功產生${kind}單:${list[0]?.uuid ?? ""}` + (list[1] ? `、換貨單:${list[1].uuid}` : "");
  // initAjaxForm：code=200 → success(json)，頁面以 json.data[0]/[1] 組訊息
  return actionOk(msg, { data: list });
}

async function newOrder(ctx: RequestContext, mode: "new-add" | "move"): Promise<Response> {
  const session = requireSession(ctx);
  const id = await intParam(ctx, "salesOrderId", true);
  const [o] = await fetchOrders(session, [id], RR_ORDER_SELECT);
  if (!o) throw notFound("訂單物件不存在");
  if (mode === "new-add" && !isPaid(o)) throw badRequest(`建立新單限已付款訂單使用：訂單 ${o.uuid} 尚未付款`);
  if (["CANCELED", "DELETED"].includes(String(o.state))) throw badRequest("訂單已取消，不可建立新單");
  if (mode === "move") {
    const { count, error } = await db()
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", id)
      .gt("total", 0);
    if (error) throw new Error(`[orders returns] ${error.message}`);
    if (!count) throw badRequest("訂單沒有可轉移的商品");
  }
  const { data, error } = await db().rpc("orders_rr_new_order", {
    p_tenant_id: session.tenantId,
    p_parent_id: id,
    p_mode: mode,
    p_mark_holded: mode === "new-add" ? await boolParam(ctx, "markAsHolded") : false,
    p_admin_user_id: session.adminUserId,
  });
  if (error) rrFail(error, mode === "move" ? "重開新單" : "建立新單");
  const r = (data ?? {}) as { salesOrderId: number; uuid: string };
  return actionOk(`已產生訂單 ${r.uuid}`, { data: r });
}

/** rr.js 載入訂單商品：原站回應 { data: 訂單 JSON, recordsTotal, recordsFiltered, dateModified, executionTime, options } */
async function rrGet(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const id = await intParam(ctx, "salesOrderId", true);
  const [api] = await loadOrdersApi(session, [id]);
  if (!api) throw notFound("訂單物件不存在");
  return json({ data: api, recordsTotal: 0, recordsFiltered: 0, dateModified: Date.now(), executionTime: Date.now() - started, options: {} });
}

async function fragmentData(ctx: RequestContext) {
  const o = await wizardOrder(ctx);
  return { salesOrderId: Number(o.id), uuid: String(o.uuid), shipped: isShipped(o), paid: isPaid(o) };
}

/* ─────────────────────────── 原單操作（displayReturnAndRefund） ─────────────────────────── */
// 原站以 HttpSession 暫存編輯中的訂單：prepare 載入、updateOrderItem/addOrderItem 只帶單一商品（不帶訂單 id）回傳試算結果，
// 送出 returnAndRefund.do 時以表單內容（orderItems[i].*、運費、訂單金額、額外操作）寫回。本系統以 orders_rr_drafts（每個後台
// 登入 session 一筆）保存草稿，只供畫面試算；寫回走 DB 函式 orders_rr_apply_edit（migration 3022，原子交易、庫存同步）。

interface RrItem {
  orderItemId: number; // > 0 既有；< 0 新增
  groupBuyItemSetId: number | null;
  itemId: number | null;
  title: string;
  price: number;
  total: number;
  discount: number;
  status: "UNSHIPPING" | "BACKORDER";
  note: string | null;
  bundleRoot: boolean;
  bundleChild: boolean;
  parentOrderItemId: number | null;
  qtyPerBundle: number | null;
  orig: { price: number; total: number; discount: number } | null;
  /** 贈品列（不列入優惠引擎） */
  gift?: boolean;
}
interface RrDraft {
  salesOrderId: number;
  uuid: string;
  groupBuyId: number | null;
  oriGrandTotal: number;
  shippingAmount: number;
  paid: boolean;
  paymentMethod: number;
  items: RrItem[];
  nextNewId: number;
  /** 原訂單折扣合計（sales_orders.discount_amount） */
  oriDiscount?: number;
  /** 按過「重新計算優惠條件」後的引擎結果（PARITY #58）；手動改列折價即取消 */
  pricing?: DraftPricing | null;
}


function rrItemApi(i: RrItem): Row {
  return {
    orderItemId: i.orderItemId,
    groupBuyItemSetId: i.groupBuyItemSetId,
    itemId: i.itemId,
    title: i.title,
    priceTags: [],
    note: i.note,
    total: i.total,
    price: i.price,
    discount: i.discount,
    status: i.status,
    bundleRoot: i.bundleRoot,
    bundleChild: i.bundleChild,
    parentOrderItemId: i.parentOrderItemId,
  };
}

/** 原站 rr 物件：{salesOrder, oriGrandTotal, newGrandTotal, aliasId(團購 id), updatedOrderItems, salesReturnRecords} */
function rrJson(d: RrDraft, updated: RrItem[] | null): Row {
  return {
    salesOrder: {
      salesOrderId: d.salesOrderId,
      uuid: d.uuid,
      shippingAmount: d.shippingAmount,
      paid: d.paid,
      payByVirtualBank: (d.paymentMethod & 2) !== 0,
      paymentMethodCVSPickup: d.paymentMethod === 64,
      sortedOrderItems: d.items.map(rrItemApi),
    },
    oriGrandTotal: d.oriGrandTotal,
    newGrandTotal: updated === null ? null : draftNewGrandTotal(d),
    salesRules: d.pricing ? d.pricing.rules : null,
    pricingMessages: d.pricing ? d.pricing.messages : [],
    aliasId: d.groupBuyId,
    updatedOrderItems: (updated ?? []).map(rrItemApi),
    salesReturnRecords: d.items
      .filter((i) => (i.orig?.total ?? 0) !== i.total)
      .map((i) => ({
        title: i.title,
        returnTotal: Math.max((i.orig?.total ?? 0) - i.total, 0),
        salesTotal: Math.max(i.total - (i.orig?.total ?? 0), 0),
      })),
  };
}

async function saveDraft(session: AdminSession, d: RrDraft): Promise<void> {
  const { error } = await db()
    .from("orders_rr_drafts")
    .upsert(
      {
        tenant_id: session.tenantId,
        session_key: session.sessionId,
        admin_user_id: session.adminUserId,
        sales_order_id: d.salesOrderId,
        payload: d,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,session_key" },
    );
  if (error) throw new Error(`[orders returns] 儲存編輯草稿失敗：${error.message}`);
}

async function loadDraft(session: AdminSession): Promise<RrDraft> {
  const { data, error } = await db()
    .from("orders_rr_drafts")
    .select("payload")
    .eq("tenant_id", session.tenantId)
    .eq("session_key", session.sessionId)
    .maybeSingle();
  if (error) throw new Error(`[orders returns] 讀取編輯草稿失敗：${error.message}`);
  const d = (data as { payload?: RrDraft } | null)?.payload;
  if (!d || !Array.isArray(d.items)) throw badRequest("編輯資料已失效，請重新開啟「加退換商品」");
  return d;
}

const numText = (v: unknown, name: string, allowDecimal = true): number => {
  const s = String(v ?? "").trim();
  if (s === "") return 0;
  if (!(allowDecimal ? /^-?\d+(\.\d+)?$/ : /^-?\d+$/).test(s)) throw badRequest(`${name}格式錯誤`);
  return Number(s);
};

async function rrPrepare(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = await intParam(ctx, "salesOrderId", true);
  const { data, error } = await db()
    .from("sales_orders")
    .select("id,uuid,state,group_buy_id,grand_total,shipping_amount,discount_amount,total_paid,payment_method,order_items(*)")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[orders returns] ${error.message}`);
  const o = data as unknown as (Row & { order_items: Row[] }) | null;
  if (!o) throw notFound("訂單物件不存在");
  if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(o.state))) {
    throw badRequest(`訂單階段為「${await enumLabel("SalesOrder.state", String(o.state))}」，不可修改商品`);
  }
  const items = [...(o.order_items ?? [])].sort((a, b) => num(a.seq) - num(b.seq) || num(a.id) - num(b.id));
  const d: RrDraft = {
    salesOrderId: Number(o.id),
    uuid: String(o.uuid),
    groupBuyId: o.group_buy_id == null ? null : Number(o.group_buy_id),
    oriGrandTotal: num(o.grand_total),
    shippingAmount: num(o.shipping_amount),
    paid: num(o.total_paid) > 0,
    paymentMethod: num(o.payment_method),
    oriDiscount: num(o.discount_amount),
    pricing: null,
    nextNewId: -1,
    items: items.map((r) => ({
      orderItemId: Number(r.id),
      groupBuyItemSetId: r.group_buy_item_set_id == null ? null : Number(r.group_buy_item_set_id),
      itemId: r.item_id == null ? null : Number(r.item_id),
      title: String(r.title ?? ""),
      price: num(r.price),
      total: num(r.total),
      discount: num(r.discount),
      status: r.back_order ? "BACKORDER" : "UNSHIPPING",
      note: r.attribute_note == null ? null : String(r.attribute_note),
      bundleRoot: !!r.bundle_root,
      bundleChild: !!r.bundle_child,
      parentOrderItemId: r.parent_order_item_id == null ? null : Number(r.parent_order_item_id),
      qtyPerBundle: r.qty_per_bundle == null ? null : Number(r.qty_per_bundle),
      orig: { price: num(r.price), total: num(r.total), discount: num(r.discount) },
      gift: !!r.gift,
    })),
  };
  // 清掉一天以前的舊草稿
  await db().from("orders_rr_drafts").delete().eq("tenant_id", session.tenantId).lt("updated_at", new Date(Date.now() - 86400_000).toISOString());
  await saveDraft(session, d);
  return json({ data: rrJson(d, null) });
}

async function rrUpdateItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const d = await loadDraft(session);
  const id = Number(await strParam(ctx, "orderItemId"));
  const item = d.items.find((i) => i.orderItemId === id);
  if (!item) throw badRequest("找不到訂單商品");
  const total = numText(await strParam(ctx, "total"), "數量", false);
  const price = numText(await strParam(ctx, "price"), "單價");
  const discount = numText(await strParam(ctx, "discount"), "折價");
  if (total < 0) throw badRequest("數量不可小於 0");
  if (price < 0) throw badRequest("單價不可小於 0");
  const statusRaw = await strParam(ctx, "status");
  const updated: RrItem[] = [item];
  // 組合母項數量變動 → 子項依比例（每組數量）一起調整
  if (item.bundleRoot && total !== item.total) {
    for (const c of d.items.filter((x) => x.parentOrderItemId === item.orderItemId)) {
      const per = c.qtyPerBundle ?? (item.total > 0 ? c.total / item.total : 1);
      c.total = Math.max(0, Math.round(per * total));
      updated.push(c);
    }
  }
  const manualDiscount = discount !== item.discount;
  item.total = total;
  item.price = price;
  item.discount = total === 0 ? 0 : discount;
  if (statusRaw === "BACKORDER" || statusRaw === "UNSHIPPING") item.status = statusRaw;
  // 已套用優惠引擎：改數量／單價 → 自動重算；手動改折價 → 改回手動模式（以列折價計算）
  if (d.pricing) {
    if (manualDiscount) d.pricing = null;
    else updated.push(...(await runDraftPricing(session, d)).changed.filter((c) => !updated.includes(c)));
  }
  await saveDraft(session, d);
  return json({ data: rrJson(d, updated) });
}

async function rrAddItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const d = await loadDraft(session);
  const itemId = Number(await strParam(ctx, "itemId"));
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw badRequest("請選擇商品");
  const { data: it, error } = await db()
    .from("items")
    .select("id,title,price,item_set_id,stock_available,stock_back_order_available")
    .eq("tenant_id", session.tenantId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new Error(`[orders returns] ${error.message}`);
  if (!it) throw badRequest("找不到商品");
  const item = it as Row;
  let gbisId = Number(await strParam(ctx, "groupBuyItemSetId")) || null;
  if (gbisId) {
    const { data: g } = await db().from("group_buy_item_sets").select("id").eq("tenant_id", session.tenantId).eq("id", gbisId).maybeSingle();
    if (!g) gbisId = null;
  }
  if (!gbisId && d.groupBuyId) {
    const { data: g } = await db()
      .from("group_buy_item_sets")
      .select("id")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", d.groupBuyId)
      .eq("item_set_id", Number(item.item_set_id))
      .limit(1)
      .maybeSingle();
    gbisId = g ? Number((g as Row).id) : null;
  }
  const add: RrItem = {
    orderItemId: d.nextNewId,
    groupBuyItemSetId: gbisId,
    itemId,
    title: String(item.title ?? ""),
    price: num(item.price),
    total: 1,
    discount: 0,
    status: num(item.stock_available) <= 0 && num(item.stock_back_order_available) > 0 ? "BACKORDER" : "UNSHIPPING",
    note: null,
    bundleRoot: false,
    bundleChild: false,
    parentOrderItemId: null,
    qtyPerBundle: null,
    orig: null,
  };
  d.nextNewId -= 1;
  d.items.push(add);
  const updatedAdd: RrItem[] = [add];
  if (d.pricing) updatedAdd.push(...(await runDraftPricing(session, d)).changed.filter((c) => c !== add));
  await saveDraft(session, d);
  return json({ data: rrJson(d, updatedAdd) });
}

/** 以正式優惠引擎（marketing evaluatePricing，同前台結帳）重算草稿：列折扣寫回、記下折扣合計與套用的優惠條件 */
async function runDraftPricing(session: AdminSession, d: RrDraft): Promise<{ changed: RrItem[]; ok: boolean; message: string }> {
  if (!d.groupBuyId) return { changed: [], ok: false, message: "訂單沒有所屬團購，無法套用優惠條件" };
  const input = await loadPricingInputForOrder(session, d.salesOrderId, draftCartInputs(d.items));
  if (!input) return { changed: [], ok: false, message: "無法讀取訂單的優惠計算資料" };
  const res = evaluatePricing(input);
  const changed = applyLineDiscounts(d.items, res.lines) as RrItem[];
  const rules = res.appliedRules
    .filter((r) => num(r.discount) > 0 || num(r.points) > 0)
    .map((r) => ({ salesRuleId: r.salesRuleId, title: r.title, discount: Math.round(num(r.discount)), points: Math.round(num(r.points)) }));
  const messages: string[] = [];
  if (res.coupon && !res.coupon.applied && res.coupon.message) messages.push(`優惠卷 ${res.coupon.code}：${res.coupon.message}`);
  if (res.gifts.length) messages.push("贈品資格需自行調整訂單商品（重新計算不會自動增刪贈品）");
  d.pricing = { totalDiscount: Math.round(num(res.totalDiscount)), rules, messages };
  const msg = `已重新計算優惠（折扣合計 $${d.pricing.totalDiscount}${rules.length ? `：${rules.map((r) => r.title).join("、")}` : ""}）`;
  return { changed, ok: true, message: [msg, ...messages].join("；") };
}

/** 重新計算優惠條件（PARITY #58）：正式引擎重算後整頁重繪 */
async function rrApplySalesRules(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const d = await loadDraft(session);
  const r = await runDraftPricing(session, d);
  if (!r.ok) throw badRequest(r.message);
  await saveDraft(session, d);
  return json({ data: rrJson(d, []), message: r.message });
}

/** 下拉選擇商品：團購品項內商品的第一層名稱標籤（原站 /ajax/Item/getFirstTags 的回傳格式 [{value,label}]） */
async function rrItemTags(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const items = await gbisItems(session, Number(ctx.query.get("groupBuyItemSetId")));
  const tags = [...new Set(items.map((i) => String(i.tag ?? "").split("#").map((x) => x.trim()).filter(Boolean)[0] ?? "").filter(Boolean))];
  return json([{ value: "", label: "全部" }, ...tags.map((t) => ({ value: t, label: t }))]);
}

/** 下拉選擇商品：團購品項內商品（可依第一層標籤篩選），[{value: itemId, label}] */
async function rrItemOptions(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const tag = (ctx.query.get("tag") ?? "").trim();
  const items = (await gbisItems(session, Number(ctx.query.get("groupBuyItemSetId")))).filter(
    (i) => !tag || (String(i.tag ?? "").split("#").map((x) => x.trim()).filter(Boolean)[0] ?? "") === tag,
  );
  return json(items.map((i) => ({ value: Number(i.id), label: `${i.title}${i.uid ? ` [${i.uid}]` : ""} $${num(i.price)}` })));
}

async function gbisItems(session: AdminSession, gbisId: number): Promise<Row[]> {
  if (!Number.isSafeInteger(gbisId) || gbisId <= 0) return [];
  const { data: g } = await db().from("group_buy_item_sets").select("item_set_id").eq("tenant_id", session.tenantId).eq("id", gbisId).maybeSingle();
  if (!g) return [];
  const { data, error } = await db()
    .from("items")
    .select("id,title,uid,price,tag,seq")
    .eq("tenant_id", session.tenantId)
    .eq("item_set_id", Number((g as Row).item_set_id))
    .order("seq")
    .order("id")
    .limit(1000);
  if (error) throw new Error(`[orders returns] ${error.message}`);
  return (data ?? []) as Row[];
}

async function rrSubmit(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await strParam(ctx, "salesOrderId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少訂單");
  const [o] = await fetchOrders(session, [id], "id,uuid,state,group_buy_id,total_paid,customer_email");
  if (!o) throw notFound("訂單物件不存在");
  const body = await ctx.body();
  const rows = new Map<number, Record<string, string>>();
  for (const [k, vals] of body.flat) {
    const m = k.match(/^orderItems\[(\d+)\]\.(\w+)$/);
    if (!m) continue;
    const r = rows.get(Number(m[1])) ?? {};
    r[m[2]] = vals[0] ?? "";
    rows.set(Number(m[1]), r);
  }
  const items = [...rows.values()]
    .filter((r) => r.orderItemId)
    .map((r) => {
      const total = numText(r.total, "數量", false);
      const price = numText(r.price, "單價");
      const discount = numText(r.discount, "折價");
      if (total < 0) throw badRequest("數量不可小於 0");
      if (price < 0) throw badRequest("單價不可小於 0");
      return {
        orderItemId: Number(r.orderItemId),
        itemId: r.itemId && r.itemId !== "null" ? Number(r.itemId) : null,
        groupBuyItemSetId: r.groupBuyItemSetId && r.groupBuyItemSetId !== "null" ? Number(r.groupBuyItemSetId) : null,
        price,
        total,
        discount,
        status: r.status === "BACKORDER" ? "BACKORDER" : "UNSHIPPING",
      };
    });
  const shippingRaw = await strParam(ctx, "shippingAmount");
  const grandRaw = await strParam(ctx, "grandTotal");
  const shipping = shippingRaw === "" ? null : numText(shippingRaw, "運費");
  const grand = grandRaw === "" ? null : numText(grandRaw, "退換後訂單金額");
  if ((shipping ?? 0) < 0 || (grand ?? 0) < 0) throw badRequest("金額不可小於 0");
  const addedCount = items.filter((i) => i.orderItemId < 0 && i.total > 0).length;
  const { data, error } = await db().rpc("orders_rr_apply_edit", {
    p_tenant_id: session.tenantId,
    p_order_id: id,
    p_items: items,
    p_shipping_amount: shipping,
    p_grand_total: grand,
    p_delete_empty: await boolParam(ctx, "optionDeleteEmptyOrderItem"),
    p_admin_user_id: session.adminUserId,
    p_note: `加退換商品（原單操作）${grand !== null ? `：訂單金額 ${grand}` : ""}${addedCount ? `，新增 ${addedCount} 項商品` : ""}`,
  });
  if (error) rrFail(error, "原單操作");
  const res = (data ?? {}) as { changed?: number; added?: number; removed?: number };
  const notes: string[] = [`已更新訂單 ${o.uuid}（異動 ${res.changed ?? 0}、新增 ${res.added ?? 0}、刪除 ${res.removed ?? 0} 項商品）`];
  // 有按「重新計算優惠條件」（引擎結果）→ 訂單折扣合計與套用的優惠條件一併寫回（同訂單「重新計算優惠」）
  const draft = await loadDraft(session).catch(() => null);
  if (draft?.pricing && draft.salesOrderId === id) {
    await adminUpdateOrders(session, [id], { discount_amount: draft.pricing.totalDiscount }, `加退換商品：重新計算優惠，折扣合計 ${draft.oriDiscount ?? 0}→${draft.pricing.totalDiscount}`);
    const { error: de } = await db().from("sales_order_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_order_id", id);
    if (de) throw new Error(`[orders returns] ${de.message}`);
    if (draft.pricing.rules.length) {
      const { error: ie } = await db()
        .from("sales_order_sales_rules")
        .insert(draft.pricing.rules.map((r) => ({ tenant_id: session.tenantId, sales_order_id: id, sales_rule_id: r.salesRuleId, title: r.title, discount: r.discount, points: r.points || null })));
      if (ie) throw new Error(`[orders returns] ${ie.message}`);
    }
    notes.push(`已寫回優惠條件（折扣合計 $${draft.pricing.totalDiscount}）`);
  }

  if (await boolParam(ctx, "optionCreateSalesOrder")) {
    const toPay = numText(await strParam(ctx, "grandTotalToPay"), "新訂單支付差額金額");
    if (toPay > 0) {
      const { data: nd, error: ne } = await db().rpc("orders_rr_new_order", {
        p_tenant_id: session.tenantId,
        p_parent_id: id,
        p_mode: "new-add",
        p_mark_holded: true,
        p_admin_user_id: session.adminUserId,
      });
      if (ne) rrFail(ne, "產生差額訂單");
      const n = (nd ?? {}) as { salesOrderId: number; uuid: string };
      await adminUpdateOrders(session, [n.salesOrderId], { grand_total: toPay }, `須支付差額 ${toPay}（原訂單 ${o.uuid}）`);
      notes.push(`已產生須支付差額之新訂單 ${n.uuid}（${toPay} 元），原訂單改為保留`);
      notes.push(
        await recordEmail(session, {
          salesOrderId: n.salesOrderId,
          groupBuyId: o.group_buy_id == null ? null : Number(o.group_buy_id),
          template: "SEND_ORDER_UPDATED_EMAIL",
          toEmail: o.customer_email == null ? null : String(o.customer_email),
          subject: `訂單 ${n.uuid} 付款通知`,
        }),
      );
      notes.push(notIntegrated("付款完成後自動合併訂單").message);
    }
  }
  if (await boolParam(ctx, "optionSendSalesOrderUpdateEmail")) {
    notes.push(
      await recordEmail(session, {
        salesOrderId: id,
        groupBuyId: o.group_buy_id == null ? null : Number(o.group_buy_id),
        template: "SEND_ORDER_UPDATED_EMAIL",
        toEmail: o.customer_email == null ? null : String(o.customer_email),
        subject: `訂單 ${o.uuid} 內容更新通知`,
      }),
    );
  }
  if (await boolParam(ctx, "optionRegenVirtualAccount")) notes.push(notIntegrated("重新產生虛擬帳號").message);
  if (await boolParam(ctx, "optionRenewCVSPickup")) notes.push(notIntegrated("重新產生超商取貨付款單號").message);
  await db().from("orders_rr_drafts").delete().eq("tenant_id", session.tenantId).eq("session_key", session.sessionId);
  return actionOk(notes.filter(Boolean).join("<br>"));
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const returnRoutes: RouteDef[] = [
  page("/backend/SalesOrderReturn/list", {
    template: "orders/salesorderreturn-list.html",
    title: "退換貨",
    groupBuy: "none",
  }),
  post("/ajax/SalesOrderReturn/list", (ctx) => listEntity(ctx, salesOrderReturn, listSpec)),
  post("/ajax/SalesOrderReturn/action", rrAction),
  post("/backend/SalesOrderReturn/batchAction", batchAction),

  fragment("/backend/ReturnRefund/wizard", { template: "orders/returnrefund-wizard.html", method: "GET", data: fragmentData }),
  fragment("/ajax/ReturnRefund/displayReturn", { template: "orders/returnrefund-displayreturn.html", method: "GET", data: fragmentData }),
  fragment("/ajax/ReturnRefund/displayReshipment", { template: "orders/returnrefund-displayreshipment.html", method: "GET", data: fragmentData }),
  get("/ajax/ReturnRefund/get", rrGet),
  post("/ajax/ReturnRefund/doReturn", (ctx) => createRr(ctx, "RETURN")),
  post("/ajax/ReturnRefund/doReshipment", (ctx) => createRr(ctx, "RESHIPMENT")),
  post("/ajax/SalesOrder/createNewForReturnRefund", (ctx) => newOrder(ctx, "new-add")),
  post("/ajax/SalesOrder/createAndMove", (ctx) => newOrder(ctx, "move")),

  // 原單操作
  fragment("/backend/ReturnRefund/displayReturnAndRefund", {
    template: "orders/returnrefund-displayreturnandrefund.html",
    method: "GET",
    data: async (ctx) => {
      const o = await wizardOrder(ctx);
      return { salesOrderId: Number(o.id), salesOrderIdText: String(o.id) };
    },
  }),
  post("/ajax/ReturnRefund/prepare", rrPrepare),
  post("/ajax/ReturnRefund/updateOrderItem", rrUpdateItem),
  post("/ajax/ReturnRefund/addOrderItem", rrAddItem),
  post("/ajax/ReturnRefund/applySalesRules", rrApplySalesRules),
  get("/ajax/ReturnRefund/itemTags", rrItemTags),
  get("/ajax/ReturnRefund/itemOptions", rrItemOptions),
  get("/ajax/ReturnRefund/isTypeBundleConfigable", () => json({ data: { isConfigurable: false } })),
  post("/ajax/ReturnRefund/returnAndRefund", rrSubmit),
];
