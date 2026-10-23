// 出貨紀錄：匯出紀錄 /backend/ShippingRecord/export、月份紀錄 /backend/ShippingRecord/shipped
// 合法來源：SPEC「匯出出貨紀錄」「月份紀錄」、runtime/shippingrecord-*.records.txt（欄位、按鈕、options、Editor）、
// ShippingRecord.purpose 列舉（出貨＝匯出後訂單更新為已出貨；回壓訂單＝不更新訂單）、SPEC 7.4。
// 原站列表、還原、重新整理的端點沿用 SPEC 列出的路徑；下載／列印／訂單清單為本站自訂端點（原站對應程式未合法取得）。
//
//   POST /ajax/ShippingRecord/list                 serverSide；monthly=1（月份紀錄）否則匯出紀錄；groupBuyId；
//                                                  excludeStateCompleted（隱藏已完成出貨）；month（0 本月／1 上月／-1 指定）＋dateMonth（YYYY-MM）
//   POST /ajax/ShippingRecord/update?shippingRecordId=  Editor 編輯「標籤」（含行內編輯）
//   POST /ajax/ShippingRecord/delete?shippingRecordId=  Editor 刪除（只刪紀錄，訂單不變）
//   POST /ajax/ShippingRecord/save                 工具列沒有新增 → 不支援（紀錄由「匯出貨運清單」產生）
//   GET  /ajax/ShippingRecord/undo?shippingRecordId=    還原：本批「出貨」匯出設為已出貨、仍處理中的訂單回到匯出前狀態
//   POST /ajax/ShippingRecord/refreshShipped       month／dateMonth → 重算該月月份紀錄（DB 函式 shipping_refresh_shipped）
//   GET|POST /backend/ShippingRecord/downloadFile  action＋shippingRecordId（可多筆 1,2）→ 檔案：
//        downloadShippingCsv 貨運清單、exportItems 出貨商品、exportLabel 地址單、
//        EXPORT_CSV／EXPORT_ERP～EXPORT_ERP6 → 轉給「所有訂單」頁的匯出（orders 模組 /backend/SalesOrderExport/batchAction）
//   GET  /backend/ShippingRecord/printShippingItems?shippingRecordId=   列印出貨商品
//   GET  /backend/ShippingRecord/printShippingOrders?shippingRecordId=  列印訂單 → orders 模組列印
//   GET  /backend/ShippingRecord/orders?shippingRecordId=               出貨紀錄內的訂單
//   GET  /ajax/ShippingRecord/orders?shippingRecordId=
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, download, html, json, redirect } from "@/lib/core/http/responses";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { listEntity } from "@/lib/core/entity/crud";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { renderTemplate } from "@/lib/core/render/template";
import { commonVars } from "@/lib/core/render/vars";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import type { EntityDef } from "@/lib/db/entity-types";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { db, paramIds, str, tenantGroupBuy } from "./common";
import { aggregateItems, itemsFile, labelFile, loadExportOrders, shippingListFile, type ExportFile } from "./shipping-export";

/** 列表檢視（migration 4001／4002） */
const recordList: EntityDef = {
  table: "shipping_records_list_v",
  idKey: "shippingRecordId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shippingRecordId: "id",
    groupBuyId: "group_buy_id",
    groupBuyTitle: "group_buy_title",
    shippingTagId: "shipping_tag_id",
    shippingTag: "shipping_tag",
    shippingTagTitle: "shipping_tag_title",
    tag: "tag",
    purpose: "purpose",
    shippingProvider: "shipping_provider",
    shippingType: "shipping_type",
    backOrder: "back_order",
    sendShippingEmail: "send_shipping_email",
    dateExpectedShippingString: "date_expected_shipping",
    dateExpectedShippingBackOrderString: "date_expected_shipping_back_order",
    fileName: "file_name",
    orderCount: "order_count",
    itemCount: "item_count",
    state: "state",
    category: "category",
    orderTotal: "order_total",
    orderTotalShipped: "order_total_shipped",
    shippingDone: "shipping_done",
    dateExportedString: "date_exported",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};

/** 本批出貨匯出設定的狀態（可還原的對象） */
export const EXPORT_SHIPPED_STATUSES = ["SHIPPED", "SHIPPING_EMAIL_SENT"];

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** month（0 本月／1 上月／-1 指定）＋dateMonth → 該月 1 日（台灣時間 YYYY-MM-01）；指定但沒填 → null（全部） */
export function monthOf(month: unknown, dateMonth: unknown): string | null {
  const m = str(month);
  const dm = str(dateMonth);
  if (m === "-1" || (m === "" && dm)) {
    const x = MONTH_RE.exec(dm);
    return x ? `${x[1]}-${x[2]}-01` : null;
  }
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const back = m === "1" ? 1 : 0;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
}

/** 台灣時間月初 → UTC 範圍 */
function monthRange(first: string): { from: string; to: string } {
  const [y, m] = first.split("-").map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000).toISOString(),
    to: new Date(Date.UTC(y, m, 1) - 8 * 3600 * 1000).toISOString(),
  };
}

const truthy = (v: unknown) => ["true", "1", "on"].includes(str(v).toLowerCase());

/** 檢視（migration 4001）不在核心的欄位型別表內，日期字串在這裡自行格式化 */
function recordRow(api: Row, row: Row): Row {
  const shipped = Number(api.orderTotalShipped ?? 0);
  return {
    ...api,
    dateExportedString: taipeiDateTime(row.date_exported),
    dateCreatedString: taipeiDateTime(row.created_at),
    dateModifiedString: taipeiDateTime(row.updated_at),
    dateCreated: row.created_at ? Date.parse(str(row.created_at)) : null,
    dateModified: row.updated_at ? Date.parse(str(row.updated_at)) : null,
    dateExpectedShippingString: taipeiDate(row.date_expected_shipping),
    dateExpectedShippingBackOrderString: taipeiDate(row.date_expected_shipping_back_order),
    tag: str(api.tag),
    shippingTag: str(api.shippingTag),
    groupBuyTitle: str(api.groupBuyTitle),
    backOrder: api.backOrder === null || api.backOrder === undefined ? -1 : Number(api.backOrder),
    shippingType: str(api.shippingType),
    shippingDone: !!api.shippingDone,
    canUndo: api.category === "EXPORT" && api.purpose === "SHIP" && shipped > 0,
  };
}

async function listRecords(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  return listEntity(ctx, recordList, {
    search: ["tag", "groupBuyTitle", "fileName"],
    like: ["tag"],
    where: (q, dt) => {
      const monthly = truthy(dt.extra.monthly);
      let out = q.eq("category", monthly ? "SHIPPED" : "EXPORT");
      const gb = Number(dt.extra.groupBuyId);
      if (Number.isSafeInteger(gb) && gb > 0) out = out.eq("group_buy_id", gb);
      if (!monthly && truthy(dt.extra.excludeStateCompleted)) out = out.eq("shipping_done", false);
      if (monthly) {
        const first = monthOf(dt.extra.month, dt.extra.dateMonth);
        if (first) {
          const r = monthRange(first);
          out = out.gte("date_exported", r.from).lt("date_exported", r.to);
        }
      }
      return out;
    },
    defaultOrder: [{ key: "dateExportedString", ascending: false }],
    mapRow: (api, row) => recordRow(api, row),
    options: () => enumOptionsFor({ backOrder: { key: "ShippingRecord.backOrder", useInt: true }, shippingType: "ShippingType" }),
  });
}

async function recordsOf(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await db().from("shipping_records").select("*").eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[shipping] 讀取出貨紀錄失敗：${error.message}`);
  return (data ?? []) as Row[];
}

async function apiRows(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data } = await db().from("shipping_records_list_v").select("*").eq("tenant_id", session.tenantId).in("id", ids);
  return ((data ?? []) as Row[]).map((r) => recordRow(rowToApi(recordList, r), r));
}

/** Editor 編輯：只有「標籤」 */
async function updateRecord(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const targets = editorIds(req, "shippingRecordId");
  const own = await recordsOf(session, targets);
  if (!own.length) throw notFound("找不到出貨紀錄");
  for (const r of req.rows) {
    const id = Number(r.id) || (targets.length === 1 ? targets[0] : 0);
    if (!own.some((x) => Number(x.id) === id) || !("tag" in r.values)) continue;
    const tag = str(r.values.tag);
    if (tag.length > 100) return json({ fieldErrors: [{ name: "tag", status: "標籤最多 100 字" }], data: [] });
    const { error } = await db().from("shipping_records").update({ tag: tag || null, updated_at: new Date().toISOString() }).eq("tenant_id", session.tenantId).eq("id", id);
    if (error) throw new Error(`[shipping] 更新出貨紀錄失敗：${error.message}`);
  }
  return editorResponse(await apiRows(session, own.map((r) => Number(r.id))));
}

async function deleteRecord(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const own = await recordsOf(session, editorIds(req, "shippingRecordId"));
  if (!own.length) throw notFound("找不到出貨紀錄");
  const { error } = await db().from("shipping_records").delete().eq("tenant_id", session.tenantId).in("id", own.map((r) => Number(r.id)));
  if (error) throw new Error(`[shipping] 刪除出貨紀錄失敗：${error.message}`);
  return editorResponse([]);
}

async function saveRecord(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  throw badRequest("出貨紀錄請由「匯出貨運清單」產生");
}

/* ─────────────────────────── 還原 ─────────────────────────── */

export async function recordOrderIds(session: AdminSession, recordIds: number[]): Promise<number[]> {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < recordIds.length; i += 100) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db()
        .from("shipping_record_orders")
        .select("sales_order_id")
        .eq("tenant_id", session.tenantId)
        .in("shipping_record_id", recordIds.slice(i, i + 100))
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(`[shipping] 讀取出貨紀錄訂單失敗：${error.message}`);
      const rows = (data ?? []) as Row[];
      for (const r of rows) {
        const id = Number(r.sales_order_id);
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      if (rows.length < 1000) break;
    }
  }
  return out;
}

export async function updateOrders(session: AdminSession, ids: number[], patch: Row, note: string): Promise<void> {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await db().rpc("orders_admin_update", {
      p_tenant_id: session.tenantId,
      p_ids: ids.slice(i, i + 500),
      p_patch: patch,
      p_admin_user_id: session.adminUserId,
      p_note: note,
      p_actor: "ADMIN",
    });
    if (error) throw new Error(`[shipping] 更新訂單失敗：${error.message}`);
  }
}

async function undo(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const [id] = await paramIds(ctx, "shippingRecordId");
  const [rec] = await recordsOf(session, id ? [id] : []);
  if (!rec) throw notFound("找不到出貨紀錄");
  if (rec.category !== "EXPORT" || rec.purpose !== "SHIP") throw badRequest("只有「出貨」匯出的紀錄可以還原");
  const ids = await recordOrderIds(session, [id]);
  const { data: orders } = ids.length
    ? await db().from("sales_orders").select("id, state, status").eq("tenant_id", session.tenantId).in("id", ids)
    : { data: [] };
  const target = ((orders ?? []) as Row[]).filter((o) => o.state === "PROCESSING" && EXPORT_SHIPPED_STATUSES.includes(str(o.status)));
  if (!target.length) throw badRequest("此紀錄沒有可還原的訂單（訂單已完成、已取消或狀態已變更）");
  const tids = target.map((o) => Number(o.id));
  // 匯出前狀態：最近一筆「轉為已出貨」歷程的 status_from
  const { data: hist } = await db()
    .from("sales_order_histories")
    .select("sales_order_id, status_from, status_to, id")
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", tids)
    .in("status_to", EXPORT_SHIPPED_STATUSES)
    .order("id", { ascending: false });
  const prev = new Map<number, string>();
  for (const h of (hist ?? []) as Row[]) {
    const oid = Number(h.sales_order_id);
    const from = str(h.status_from);
    if (!prev.has(oid) && from && !EXPORT_SHIPPED_STATUSES.includes(from)) prev.set(oid, from);
  }
  const groups = new Map<string, number[]>();
  for (const oid of tids) {
    const s = prev.get(oid) ?? "PAID";
    groups.set(s, [...(groups.get(s) ?? []), oid]);
  }
  for (const [status, list] of groups) await updateOrders(session, list, { status, date_shipped: null }, `還原訂單狀態（出貨紀錄 #${id}）`);
  await db().from("order_items").update({ state: "UNSHIPPING" }).eq("tenant_id", session.tenantId).in("sales_order_id", tids).eq("state", "SHIPPED");
  await db().from("shipping_record_orders").delete().eq("tenant_id", session.tenantId).eq("shipping_record_id", id).in("sales_order_id", tids);
  const left = ids.length - tids.length;
  let msg = `已將 ${tids.length} 筆訂單還原為匯出前的狀態`;
  if (left <= 0) {
    await db().from("shipping_records").delete().eq("tenant_id", session.tenantId).eq("id", id);
    msg += "；此紀錄已沒有訂單，已一併刪除";
  } else {
    await db().from("shipping_records").update({ order_count: left, updated_at: new Date().toISOString() }).eq("tenant_id", session.tenantId).eq("id", id);
    msg += `；其餘 ${left} 筆訂單（已完成或狀態已變更）保留在此紀錄`;
  }
  return actionOk(msg);
}

/* ─────────────────────────── 月份紀錄重算 ─────────────────────────── */

async function refreshShipped(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const first = monthOf(await ctx.param("month"), await ctx.param("dateMonth")) ?? monthOf("0", "");
  const { data, error } = await db().rpc("shipping_refresh_shipped", { p_tenant_id: session.tenantId, p_month: first });
  if (error) throw new Error(`[shipping] 重算月份紀錄失敗：${error.message}`);
  return actionOk(`已重新整理 ${String(first).slice(0, 7)} 月份紀錄（${Number(data ?? 0)} 個團購）`, { count: Number(data ?? 0) });
}

/* ─────────────────────────── 下載／列印 ─────────────────────────── */

const ERP_ACTIONS = new Set(["EXPORT_CSV", "EXPORT_ERP", "EXPORT_ERP2", "EXPORT_ERP3", "EXPORT_ERP4", "EXPORT_ERP5", "EXPORT_ERP6"]);

/** 表單送出型下載失敗：提示後回上一頁（避免整頁變成錯誤頁） */
export function downloadError(message: string): Response {
  const m = JSON.stringify(message).replace(/</g, "\\u003c");
  return html(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>下載失敗</title></head><body><p>${message.replace(/</g, "&lt;")}</p><script>alert(${m});history.back();</script></body></html>`,
    { status: 400 },
  );
}

export async function shippingTagById(session: AdminSession, id: unknown): Promise<Row | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data } = await db().from("shipping_tags").select("*").eq("tenant_id", session.tenantId).eq("id", n).maybeSingle();
  return (data as Row | null) ?? null;
}

export async function recordDownload(session: AdminSession, action: string, recordIds: number[], method: string): Promise<Response> {
  const records = await recordsOf(session, recordIds);
  if (!records.length) return downloadError("找不到出貨紀錄");
  const ids = await recordOrderIds(session, records.map((r) => Number(r.id)));
  if (!ids.length) return downloadError("此出貨紀錄沒有訂單");
  if (ERP_ACTIONS.has(action)) {
    // 與「所有訂單」頁同一套匯出（orders 模組）；POST 用 307 讓瀏覽器以原方法轉送
    const url = `/backend/SalesOrderExport/batchAction?batchAction=${encodeURIComponent(action)}&salesOrderIds=${ids.slice(0, 4000).join(",")}`;
    return redirect(url, method === "POST" ? 307 : 302);
  }
  const orders = await loadExportOrders(session.tenantId, ids);
  let file: ExportFile;
  if (action === "exportItems") file = await itemsFile(orders);
  else if (action === "exportLabel") file = await labelFile(orders);
  else if (action === "downloadShippingCsv") {
    const rec = records[0];
    const filter = (rec.filter ?? {}) as Row;
    file = await shippingListFile(session.tenantId, orders, await shippingTagById(session, rec.shipping_tag_id), str(filter.fileFormat) || "XLS");
  } else return downloadError("不支援的匯出項目");
  return download(file.body, file.filename, file.type);
}

async function downloadHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const action = str(await ctx.param("action"));
  const ids = await paramIds(ctx, "shippingRecordId");
  if (!ids.length) return downloadError("請先選擇出貨紀錄");
  try {
    return await recordDownload(session, action, ids, ctx.method);
  } catch (e) {
    return downloadError(e instanceof Error ? e.message : String(e));
  }
}

async function printItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const records = await recordsOf(session, await paramIds(ctx, "shippingRecordId"));
  if (!records.length) throw notFound("找不到出貨紀錄");
  const orders = await loadExportOrders(session.tenantId, await recordOrderIds(session, records.map((r) => Number(r.id))));
  const items = aggregateItems(orders);
  const gbIds = [...new Set(records.map((r) => Number(r.group_buy_id)).filter((x) => x > 0))];
  const { data: gbs } = gbIds.length ? await db().from("group_buys").select("id, title").eq("tenant_id", session.tenantId).in("id", gbIds) : { data: [] };
  return html(
    renderTemplate("shipping/shippingrecord-printitems.html", {
      ...commonVars(ctx),
      title: "列印出貨商品",
      records: records.map((r) => ({
        shippingRecordId: Number(r.id),
        tag: str(r.tag),
        dateExportedString: taipeiDateTime(r.date_exported),
        groupBuyTitle: str(((gbs ?? []) as Row[]).find((g) => Number(g.id) === Number(r.group_buy_id))?.title),
      })),
      items: items.map((a, i) => ({ ...a, no: i + 1 })),
      orderCount: orders.length,
      totalNormal: items.reduce((s, a) => s + a.normal, 0),
      totalBack: items.reduce((s, a) => s + a.back, 0),
      total: items.reduce((s, a) => s + a.total, 0),
      today: taipeiDate(new Date()),
    }),
  );
}

async function printOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const records = await recordsOf(session, await paramIds(ctx, "shippingRecordId"));
  if (!records.length) throw notFound("找不到出貨紀錄");
  const orderIds = await recordOrderIds(session, records.map((r) => Number(r.id)));
  if (!orderIds.length) throw badRequest("此出貨紀錄沒有訂單");
  return redirect(`/backend/SalesOrderExport/batchAction?batchAction=PRINT_ORDER&salesOrderId=${orderIds.slice(0, 2000).join(",")}`);
}

/* ─────────────────────────── 出貨紀錄內的訂單 ─────────────────────────── */

async function recordOrdersPageData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const [id] = await paramIds(ctx, "shippingRecordId");
  const [rec] = await recordsOf(ctx.session, id ? [id] : []);
  if (!rec) throw notFound("找不到出貨紀錄");
  const gb = rec.group_buy_id ? await tenantGroupBuy(ctx.session, rec.group_buy_id) : null;
  return {
    shippingRecordId: Number(rec.id),
    recordTag: str(rec.tag),
    recordDate: taipeiDateTime(rec.date_exported),
    recordGroupBuyTitle: gb?.title ?? "",
  };
}

async function listRecordOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const [id] = await paramIds(ctx, "shippingRecordId");
  const [rec] = await recordsOf(session, id ? [id] : []);
  if (!rec) throw notFound("找不到出貨紀錄");
  const ids = await recordOrderIds(session, [id]);
  const [status, state, shippingType] = await Promise.all([enumOptions("SalesOrder.status"), enumOptions("SalesOrder.state"), enumOptions("ShippingType")]);
  const label = (list: { label: string; value: string | number }[], v: unknown) => list.find((x) => String(x.value) === str(v))?.label ?? str(v);
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db()
      .from("sales_orders")
      .select("id, uuid, state, status, customer_firstname, customer_telephone, shipping_firstname, shipping_type, shipping_receipt_number, grand_total, date_shipped, created_at")
      .eq("tenant_id", session.tenantId)
      .in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`[shipping] 讀取訂單失敗：${error.message}`);
    for (const o of (data ?? []) as Row[]) {
      rows.push({
        salesOrderId: Number(o.id),
        uuid: str(o.uuid),
        dateCreatedString: taipeiDateTime(o.created_at),
        shippingFirstname: str(o.shipping_firstname) || str(o.customer_firstname),
        customerTelephone: str(o.customer_telephone),
        stateString: label(state, o.state),
        statusString: label(status, o.status),
        shippingTypeString: label(shippingType, o.shipping_type),
        shippingReceiptNumber: str(o.shipping_receipt_number),
        grandTotal: Number(o.grand_total ?? 0),
        dateShippedString: taipeiDateTime(o.date_shipped),
      });
    }
  }
  rows.sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
  return json({ data: rows, recordsTotal: rows.length, recordsFiltered: rows.length, dateModified: Date.now(), executionTime: 0, options: {} });
}

/* ─────────────────────────── 頁面 ─────────────────────────── */

async function exportPageData(ctx: RequestContext & { session: AdminSession; groupBuy?: { groupBuyId: number; title: string } | null }): Promise<Record<string, unknown>> {
  const gb = ctx.groupBuy ?? null;
  return { gbParam: gb ? String(gb.groupBuyId) : "" };
}

export const shippingRecordRoutes: RouteDef[] = [
  page("/backend/ShippingRecord/export", {
    template: "shipping/shippingrecord-export.html",
    title: (ctx) => `匯出出貨紀錄 - ${ctx.groupBuy?.title ?? ""}`,
    jsp: "/backend/ShippingRecord/list.jsp",
    data: exportPageData,
  }),
  page("/backend/ShippingRecord/shipped", {
    template: "shipping/shippingrecord-shipped.html",
    title: "月份紀錄",
    data: exportPageData,
  }),
  page("/backend/ShippingRecord/orders", {
    template: "shipping/shippingrecordsalesorder-list.html",
    title: "出貨紀錄訂單",
    groupBuy: "none",
    data: recordOrdersPageData,
  }),
  { path: "/ajax/ShippingRecord/list", method: ["GET", "POST"], handler: listRecords },
  post("/ajax/ShippingRecord/update", updateRecord),
  post("/ajax/ShippingRecord/delete", deleteRecord),
  post("/ajax/ShippingRecord/save", saveRecord),
  { path: "/ajax/ShippingRecord/undo", method: ["GET", "POST"], handler: undo },
  post("/ajax/ShippingRecord/refreshShipped", refreshShipped),
  { path: "/backend/ShippingRecord/downloadFile", method: ["GET", "POST"], handler: downloadHandler },
  get("/backend/ShippingRecord/printShippingItems", printItems),
  get("/backend/ShippingRecord/printShippingOrders", printOrders),
  get("/ajax/ShippingRecord/orders", listRecordOrders),
];
