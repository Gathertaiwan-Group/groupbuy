// 匯出貨運清單（彈窗）與匯入貨運單（彈窗）。
// 合法來源：SPEC 7.4（匯出目的「出貨／回壓訂單」、篩選「尚未出貨／所有訂單」、發送出貨信、現貨／預購預計出貨日、物流商格式）、
// ShippingRecord.purpose／backOrder 列舉、SPEC「匯入貨運單」欄位表與 /ajax/ShippingCSV/importShippingCSV.do、
// 群組頁選單的 /backend/ShippingCSV/exportShippingCSV、/backend/ShippingCSV/importShippingCSV。
// 匯出彈窗的版面與內部端點為本站設計（原站彈窗內容未合法取得）。
//
//   GET  /backend/ShippingCSV/exportShippingCSV?groupBuyId=1,2 匯出彈窗（片段；團購列表可多選；priority 50，取代 groupbuy 模組的導向用彈窗）
//   POST /ajax/ShippingCSV/countOrders                        符合條件訂單數＋前 10 筆預覽
//   POST /ajax/ShippingCSV/exportOrders                       建立出貨紀錄（出貨：訂單設為已出貨），回傳紀錄清單供下載
//   GET  /backend/ShippingCSV/importShippingCSV?groupBuyId=   匯入彈窗（片段，需指定團購）
//   POST /ajax/ShippingCSV/importShippingCSV                  上傳物流商回傳檔 → 寫入貨運編號／出貨日／已出貨
//   GET  /ajax/ShippingTag/getByTag?tag=                      貨運標籤設定（帶入匯入檔標頭名稱）
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, json } from "@/lib/core/http/responses";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { deliveryNotice } from "@/lib/modules/core/delivery";
import { enumOptions } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { shippingTag as shippingTagEntity } from "@/lib/db/entities/shippingTag";
import { postRegisteredNumber } from "./carrier-formats";
import { db, str, tenantGroupBuy } from "./common";
import { DEFAULT_SHIPPING_TAG, shippableItems, type ExportOrder } from "./shipping-export";
import { updateOrders } from "./shipping-record";
import { pickFile, readSheet, SheetError } from "./sheet";

const MAX_EXPORT = 2000;
const MAX_DAYS = 31;
const SHIPPED_STATUSES = ["SHIPPED", "SHIPPING_EMAIL_SENT", "SHIPPING_EMAIL_FAILED"];
const INACTIVE_STATES = ["CANCELED", "COMBINED", "SPLITED", "DRAFT"];

const n = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const on = (v: unknown) => ["on", "true", "1", "yes"].includes(str(v).toLowerCase());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 台灣日期 YYYY-MM-DD → 當天 00:00（+08:00）的 ISO */
const dayStart = (d: string) => new Date(`${d}T00:00:00+08:00`).toISOString();
const dayAfter = (d: string) => new Date(new Date(`${d}T00:00:00+08:00`).getTime() + 86400000).toISOString();

async function tenantTags(session: AdminSession): Promise<Row[]> {
  const { data } = await db().from("shipping_tags").select("*").eq("tenant_id", session.tenantId).order("tag");
  return (data ?? []) as Row[];
}

/* ─────────────────────────── 匯出：條件與選單 ─────────────────────────── */

/** groupBuyId=1,2 → 本租戶的團購（保持順序）；有不屬於本租戶的 id → 404 */
async function ownGroupBuys(session: AdminSession, raw: unknown): Promise<{ id: number; title: string }[]> {
  const ids = [...new Set(str(raw).split(/[,\s]+/).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return [];
  const { data } = await db().from("group_buys").select("id, title").eq("tenant_id", session.tenantId).in("id", ids);
  const rows = (data ?? []) as Row[];
  if (rows.length !== ids.length) throw notFound("找不到團購");
  return ids.map((id) => ({ id, title: str(rows.find((r) => Number(r.id) === id)?.title) }));
}

interface ExportParams {
  groupBuyIds: number[];
  purpose: "SHIP" | "EXPORT_ONLY";
  orderFilter: "UNSHIPPED" | "ALL";
  dateBegin: string;
  dateEnd: string;
  shippingType: string;
  backOrder: number;
  payStatus: "PAID_OR_COD" | "PAID" | "UNPAID" | "ALL";
  shippingTag: string;
  sendShippingEmail: boolean;
  dateExpectedShipping: string;
  dateExpectedShippingBackOrder: string;
  fileFormat: "XLS" | "CSV";
  oneShippingRecord: boolean;
  limit: number;
}

async function readParams(ctx: RequestContext, session: AdminSession): Promise<ExportParams> {
  const p = async (k: string) => str(await ctx.param(k));
  const groupBuyIds = (await ownGroupBuys(session, await p("groupBuyId"))).map((g) => g.id);
  const purpose = (await p("purpose")) === "EXPORT_ONLY" ? "EXPORT_ONLY" : "SHIP";
  const pay = await p("payStatus");
  const bo = Number(await p("backOrder"));
  const limitRaw = Number(await p("limit"));
  return {
    groupBuyIds,
    purpose,
    orderFilter: purpose === "SHIP" ? "UNSHIPPED" : (await p("orderFilter")) === "ALL" ? "ALL" : "UNSHIPPED",
    dateBegin: await p("dateBegin"),
    dateEnd: await p("dateEnd"),
    shippingType: await p("shippingType"),
    backOrder: [0, 1, 2].includes(bo) ? bo : -1,
    payStatus: (["PAID", "UNPAID", "ALL"].includes(pay) ? pay : "PAID_OR_COD") as ExportParams["payStatus"],
    shippingTag: await p("shippingTag"),
    sendShippingEmail: purpose === "SHIP" && on(await p("sendShippingEmail")),
    dateExpectedShipping: await p("dateExpectedShipping"),
    dateExpectedShippingBackOrder: await p("dateExpectedShippingBackOrder"),
    fileFormat: (await p("fileFormat")).toUpperCase() === "CSV" ? "CSV" : "XLS",
    oneShippingRecord: on(await p("oneShippingRecord")),
    limit: Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_EXPORT) : MAX_EXPORT,
  };
}

function validateDates(x: ExportParams): void {
  if (x.dateBegin && !DATE_RE.test(x.dateBegin)) throw badRequest("訂單日期（起）格式錯誤");
  if (x.dateEnd && !DATE_RE.test(x.dateEnd)) throw badRequest("訂單日期（迄）格式錯誤");
  if (!x.groupBuyIds.length) {
    if (!x.dateBegin || !x.dateEnd) throw badRequest(`未指定團購時，需指定訂單日期區間（最多 ${MAX_DAYS} 天）`);
    const days = (Date.parse(x.dateEnd) - Date.parse(x.dateBegin)) / 86400000;
    if (days < 0) throw badRequest("訂單日期（迄）不可早於（起）");
    if (days > MAX_DAYS) throw badRequest(`訂單日期區間最多 ${MAX_DAYS} 天`);
  }
}

type Candidate = Row & { order_items: Row[] };

/** 依條件選訂單（建立時間舊到新）；回傳全部符合者（最多 20000 筆候選） */
async function selectOrders(session: AdminSession, x: ExportParams): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = db()
      .from("sales_orders")
      .select("id, uuid, group_buy_id, state, status, total_paid, payment_method, created_at, order_items(id, title, short_name, specifications_label, total, back_order, bundle_root, bundle_child, parent_order_item_id, state, tenant_id)")
      .eq("tenant_id", session.tenantId)
      .neq("shipping_type", "NOD");
    if (x.groupBuyIds.length) q = q.in("group_buy_id", x.groupBuyIds);
    if (x.orderFilter === "UNSHIPPED") {
      q = q.in("state", ["NEW", "PROCESSING"]).is("date_shipped", null).not("status", "in", `(${SHIPPED_STATUSES.join(",")})`);
    } else {
      q = q.not("state", "in", `(${INACTIVE_STATES.join(",")})`);
    }
    if (x.shippingType) q = q.eq("shipping_type", x.shippingType);
    if (x.shippingTag) q = q.eq("shipping_tag", x.shippingTag);
    if (x.payStatus === "PAID") q = q.gt("total_paid", 0);
    else if (x.payStatus === "UNPAID") q = q.eq("total_paid", 0);
    else if (x.payStatus === "PAID_OR_COD") q = q.or("total_paid.gt.0,payment_method.in.(16,64)");
    if (x.dateBegin && DATE_RE.test(x.dateBegin)) q = q.gte("created_at", dayStart(x.dateBegin));
    if (x.dateEnd && DATE_RE.test(x.dateEnd)) q = q.lt("created_at", dayAfter(x.dateEnd));
    const { data, error } = await q.order("created_at").order("id").range(from, from + 999);
    if (error) throw new Error(`[shipping] 查詢出貨訂單失敗：${error.message}`);
    const rows = (data ?? []) as Candidate[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.filter((o) => {
    if (x.backOrder < 0) return true;
    const items = shippableItems(o as unknown as ExportOrder).filter((i) => n(i.tenant_id) === session.tenantId);
    const back = items.some((i) => i.back_order);
    const normal = items.some((i) => !i.back_order);
    if (x.backOrder === 0) return normal && !back;
    if (x.backOrder === 1) return back && !normal;
    return back && normal;
  });
}

const itemSummary = (o: Candidate) =>
  shippableItems(o as unknown as ExportOrder)
    .map((i) => `${str(i.short_name) || str(i.title)}${str(i.specifications_label) ? ` ${str(i.specifications_label)}` : ""}x${n(i.total)}`)
    .join(", ");

async function exportModalData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const gbs = await ownGroupBuys(ctx.session, ctx.query.get("groupBuyId"));
  const [types, backOrders, tags] = await Promise.all([enumOptions("ShippingType"), enumOptions("ShippingRecord.backOrder", true), tenantTags(ctx.session)]);
  const today = taipeiDate(new Date());
  return {
    groupBuyId: gbs.map((g) => g.id).join(","),
    groupBuyTitle: gbs.map((g) => g.title).join("、"),
    multipleGroupBuys: gbs.length > 1,
    shippingTypes: types,
    backOrders,
    shippingTags: tags.map((t) => ({ tag: str(t.tag), title: str(t.title) || str(t.tag) })),
    today,
    monthAgo: taipeiDate(new Date(Date.now() - 30 * 86400000)),
    maxExport: MAX_EXPORT,
    maxDays: MAX_DAYS,
  };
}

async function countOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const x = await readParams(ctx, session);
  try {
    validateDates(x);
  } catch (e) {
    return json({ code: 400, error: e instanceof Error ? e.message : String(e), recordsTotal: 0, data: [] });
  }
  const orders = await selectOrders(session, x);
  const groups = new Set(orders.map((o) => o.group_buy_id ?? 0)).size;
  return json({
    code: 200,
    recordsTotal: orders.length,
    exportTotal: Math.min(orders.length, x.limit),
    groups,
    data: orders.slice(0, 10).map((o) => ({ uuid: str(o.uuid), items: itemSummary(o) })),
  });
}

/* ─────────────────────────── 匯出：建立出貨紀錄 ─────────────────────────── */

async function recordEmails(session: AdminSession, orders: Row[]): Promise<void> {
  if (!orders.length) return;
  const rows = orders.map((o) => ({
    tenant_id: session.tenantId,
    group_buy_id: o.group_buy_id ?? null,
    sales_order_id: Number(o.id),
    template: "SHIPMENT_NOTICE",
    to_email: str(o.customer_email) || null,
    subject: "出貨通知",
    body: null,
    status: "NOT_SENT_UNINTEGRATED",
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db().from("email_messages").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`[shipping] 寫入出貨信紀錄失敗：${error.message}`);
  }
}

/** 已出貨：訂單狀態＋出貨日（+貨運公司），商品設為已出貨（倉儲的入庫扣量觸發器隨之執行） */
async function markShipped(session: AdminSession, ids: number[], opts: { send: boolean; provider: string; dateShipped: string; note: string; receipt?: Map<number, string> }): Promise<void> {
  const base: Row = { status: opts.send ? "SHIPPING_EMAIL_SENT" : "SHIPPED", date_shipped: opts.dateShipped };
  if (opts.provider) base.shipping_provider = opts.provider;
  if (opts.receipt && opts.receipt.size) {
    for (const id of ids) {
      const r = opts.receipt.get(id);
      await updateOrders(session, [id], r ? { ...base, shipping_receipt_number: r } : base, opts.note + (r ? ` 貨運編號 ${r}` : ""));
    }
  } else {
    await updateOrders(session, ids, base, opts.note);
  }
  for (let i = 0; i < ids.length; i += 300) {
    const { error } = await db()
      .from("order_items")
      .update({ state: "SHIPPED" })
      .eq("tenant_id", session.tenantId)
      .in("sales_order_id", ids.slice(i, i + 300))
      .in("state", ["UNSHIPPING", "SHIPPING"]);
    if (error) throw new Error(`[shipping] 更新訂單商品出貨狀態失敗：${error.message}`);
  }
}

async function exportOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const x = await readParams(ctx, session);
  validateDates(x);
  const all = await selectOrders(session, x);
  if (!all.length) throw badRequest("沒有符合條件的訂單");
  const orders = all.slice(0, x.limit);
  const tag = x.shippingTag ? (await tenantTags(session)).find((t) => str(t.tag) === x.shippingTag) ?? null : null;
  const providerCode = tag ? str(tag.shipping_provider).replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, "") : "";
  // 分批：指定團購或勾「多團彙整」→ 一筆；否則一團一筆
  const batches = new Map<string, Candidate[]>();
  for (const o of orders) {
    const k = x.groupBuyIds.length === 1 || x.oneShippingRecord ? "all" : String(o.group_buy_id ?? 0);
    batches.set(k, [...(batches.get(k) ?? []), o]);
  }
  const now = new Date().toISOString();
  const stamp = taipeiDateTime(new Date()).replace(/[-: ]/g, "").slice(0, 12);
  const created: Row[] = [];
  for (const [, list] of batches) {
    const gbIds = [...new Set(list.map((o) => o.group_buy_id).filter(Boolean))];
    const itemCount = list.reduce((s, o) => s + shippableItems(o as unknown as ExportOrder).reduce((a, i) => a + n(i.total), 0), 0);
    const { data, error } = await db()
      .from("shipping_records")
      .insert({
        tenant_id: session.tenantId,
        group_buy_id: gbIds.length === 1 ? gbIds[0] : null,
        shipping_tag_id: tag ? Number(tag.id) : null,
        purpose: x.purpose,
        shipping_provider: providerCode || null,
        shipping_type: x.shippingType || null,
        back_order: x.backOrder,
        send_shipping_email: x.sendShippingEmail,
        date_expected_shipping: DATE_RE.test(x.dateExpectedShipping) ? x.dateExpectedShipping : null,
        date_expected_shipping_back_order: DATE_RE.test(x.dateExpectedShippingBackOrder) ? x.dateExpectedShippingBackOrder : null,
        filter: { ...x },
        file_name: `貨運清單_${stamp}.${x.fileFormat === "CSV" ? "csv" : "xlsx"}`,
        order_count: list.length,
        item_count: itemCount,
        state: "EXPORTED",
        admin_user_id: session.adminUserId,
        date_exported: now,
        category: "EXPORT",
      })
      .select("id")
      .single();
    if (error) throw new Error(`[shipping] 建立出貨紀錄失敗：${error.message}`);
    const recordId = Number((data as Row).id);
    const links = list.map((o) => ({ tenant_id: session.tenantId, shipping_record_id: recordId, sales_order_id: Number(o.id) }));
    for (let i = 0; i < links.length; i += 500) {
      const { error: e2 } = await db().from("shipping_record_orders").insert(links.slice(i, i + 500));
      if (e2) throw new Error(`[shipping] 寫入出貨紀錄訂單失敗：${e2.message}`);
    }
    if (x.purpose === "SHIP") {
      const ids = list.map((o) => Number(o.id));
      await markShipped(session, ids, { send: x.sendShippingEmail, provider: providerCode, dateShipped: now, note: `匯出貨運清單設為已出貨（出貨紀錄 #${recordId}）` });
    }
    const gbTitle = gbIds.length === 1 ? (await tenantGroupBuy(session, gbIds[0]))?.title ?? "" : "多團彙整";
    created.push({ shippingRecordId: recordId, groupBuyTitle: gbTitle, orderCount: list.length });
  }
  const lines = [`已建立 ${created.length} 筆出貨紀錄，共 ${orders.length} 筆訂單${all.length > orders.length ? `（符合 ${all.length} 筆，超過本次上限 ${x.limit} 筆的部分未匯出）` : ""}。`];
  if (x.purpose === "SHIP") {
    lines.push(`訂單已設為「${x.sendShippingEmail ? "已出貨通知" : "已出貨"}」。`);
    if (x.sendShippingEmail) {
      const { data: emails } = await db().from("sales_orders").select("id, group_buy_id, customer_email").eq("tenant_id", session.tenantId).in("id", orders.map((o) => Number(o.id)));
      await recordEmails(session, (emails ?? []) as Row[]);
      const n = (await deliveryNotice(session.tenantId, "EMAIL", "出貨通知信（Email）")).message;
      if (n) lines.push(n);
    }
  } else {
    lines.push("回壓訂單：系統不會更新既有訂單。");
  }
  return json({ code: 200, error: lines.join("<br>"), message: lines.join(" "), data: { records: created, fileFormat: x.fileFormat } });
}

/* ─────────────────────────── 匯入貨運單 ─────────────────────────── */

async function importModalData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const gb = await tenantGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
  if (!gb) throw badRequest("請先選擇團購");
  const tags = await tenantTags(ctx.session);
  return { groupBuyId: String(gb.id), shippingTags: tags.map((t) => str(t.tag)).filter(Boolean) };
}

/** 檔案日期：2019-09-11、2019/09/11、20190911（Excel 日期已轉為 YYYY-MM-DD） */
function parseFileDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
}

const headerIndex = (header: string[], name: string) => {
  const want = name.trim().toLowerCase();
  if (!want) return -1;
  return header.findIndex((h) => h.trim().toLowerCase() === want);
};

async function importShippingCsv(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = async (k: string) => str(await ctx.param(k));
  const gb = await tenantGroupBuy(session, await p("groupBuyId"));
  if (!gb) throw badRequest("請先選擇團購");
  const body = await ctx.body();
  const file = pickFile(body.files, "imageFile", "upload", "file");
  if (!file) throw badRequest("請選擇 CSV/XLS 檔案");
  if (file.size > 8 * 1024 * 1024) throw badRequest("檔案過大（上限 8MB）");
  let rows: string[][];
  try {
    rows = await readSheet(file);
  } catch (e) {
    if (e instanceof SheetError) throw badRequest(e.message);
    throw e;
  }
  if (rows.length < 2) throw badRequest("檔案沒有資料列");
  const header = rows[0];
  const colUuid = headerIndex(header, await p("columnUuid"));
  const colReceipt = headerIndex(header, await p("columnShippingReceiptNumber"));
  const colDate = headerIndex(header, await p("columnDateShipped"));
  const colProvider = headerIndex(header, await p("columnShippingProvider"));
  if (colUuid < 0) throw badRequest(`找不到訂單編號標頭「${await p("columnUuid")}」，檔案標頭：${header.filter(Boolean).join("、")}`);
  if (colReceipt < 0) throw badRequest(`找不到貨運編號標頭「${await p("columnShippingReceiptNumber")}」，檔案標頭：${header.filter(Boolean).join("、")}`);
  const includeOthers = on(await p("includeOthers"));
  const send = on(await p("sendShippingEmail"));
  const markGroupBuyShipped = on(await p("markGroupBuyShipped"));
  const actionWhenExists = ["OVERWRITE", "RESEND"].includes(await p("actionWhenExists")) ? await p("actionWhenExists") : "NONE";
  const selectedProvider = (await p("shippingProvider")).toUpperCase();
  // 郵局掛號號碼（PARITY #74）：選郵局且有填「掛號號碼後8碼」→ 檔案的貨運編號視為前6碼，組成 14 碼
  const postLast8 = (await p("serialNumberLast8")).trim();
  const fallbackDate = parseFileDate(await p("dateShipped")) ?? taipeiDate(new Date());
  const providers = new Set((await enumOptions("SalesOrder.shippingProvider")).map((o) => String(o.value)));

  // 檔案列 → {uuid, receipt, date, provider}
  const lines: { uuid: string; receipt: string; date: string; provider: string; row: number }[] = [];
  let invalid = 0;
  const postErrors: string[] = [];
  rows.slice(1).forEach((r, i) => {
    const uuid = str(r[colUuid]);
    const receipt = str(r[colReceipt]);
    if (!uuid && !receipt) return;
    if (!uuid || !receipt) {
      invalid++;
      return;
    }
    const d = colDate >= 0 ? parseFileDate(str(r[colDate])) : null;
    const prov = colProvider >= 0 ? str(r[colProvider]).toUpperCase() : "";
    let rc = receipt;
    if (postLast8 && (prov || selectedProvider) === "POST") {
      const pr = postRegisteredNumber(receipt, postLast8);
      if (!pr.value) {
        postErrors.push(`第 ${i + 2} 列：${pr.error}`);
        return;
      }
      rc = pr.value;
    }
    lines.push({ uuid, receipt: rc, date: d ?? fallbackDate, provider: prov, row: i + 2 });
  });
  if (postErrors.length && /8 位數字/.test(postErrors[0])) throw badRequest(postErrors[0].replace(/^第 \d+ 列：/, ""));
  if (!lines.length) throw badRequest("檔案沒有可匯入的資料（需同時有訂單編號與貨運編號）");

  const uuids = [...new Set(lines.map((l) => l.uuid))];
  const found = new Map<string, Row>();
  for (let i = 0; i < uuids.length; i += 300) {
    const { data, error } = await db()
      .from("sales_orders")
      .select("id, uuid, group_buy_id, state, status, shipping_receipt_number, customer_email")
      .eq("tenant_id", session.tenantId)
      .in("uuid", uuids.slice(i, i + 300));
    if (error) throw new Error(`[shipping] 讀取訂單失敗：${error.message}`);
    for (const o of (data ?? []) as Row[]) found.set(str(o.uuid), o);
  }
  const notFoundList: string[] = [];
  const others: string[] = [];
  const skippedExists: string[] = [];
  const inactive: string[] = [];
  const done: { order: Row; line: (typeof lines)[number]; send: boolean }[] = [];
  const handled = new Set<number>();
  for (const l of lines) {
    const o = found.get(l.uuid);
    if (!o) {
      notFoundList.push(l.uuid);
      continue;
    }
    if (handled.has(Number(o.id))) continue;
    if (!includeOthers && Number(o.group_buy_id) !== gb.id) {
      others.push(l.uuid);
      continue;
    }
    if (INACTIVE_STATES.includes(str(o.state))) {
      inactive.push(l.uuid);
      continue;
    }
    const hasReceipt = !!str(o.shipping_receipt_number);
    if (hasReceipt && actionWhenExists === "NONE") {
      skippedExists.push(l.uuid);
      continue;
    }
    handled.add(Number(o.id));
    done.push({ order: o, line: l, send: hasReceipt ? actionWhenExists === "RESEND" : send });
  }

  // 依「出貨日＋發信＋貨運公司」分組寫入
  const groups = new Map<string, { ids: number[]; send: boolean; provider: string; date: string; receipt: Map<number, string> }>();
  for (const d of done) {
    const prov = d.line.provider && providers.has(d.line.provider) ? d.line.provider : selectedProvider && selectedProvider !== "NONE" && providers.has(selectedProvider) ? selectedProvider : "";
    const k = `${d.line.date}|${d.send ? 1 : 0}|${prov}`;
    const g = groups.get(k) ?? { ids: [] as number[], send: d.send, provider: prov, date: d.line.date, receipt: new Map<number, string>() };
    g.ids.push(Number(d.order.id));
    g.receipt.set(Number(d.order.id), d.line.receipt);
    groups.set(k, g);
  }
  let mailed = 0;
  for (const g of groups.values()) {
    await markShipped(session, g.ids, {
      send: g.send,
      provider: g.provider,
      dateShipped: new Date(`${g.date}T12:00:00+08:00`).toISOString(),
      note: `匯入貨運單（${g.date}）`,
      receipt: g.receipt,
    });
    if (g.send) {
      await recordEmails(session, done.filter((d) => g.ids.includes(Number(d.order.id))).map((d) => d.order));
      mailed += g.ids.length;
    }
  }

  // 已結團且沒有可出貨訂單 → 團購標為「出完貨」
  let markedGroup = false;
  if (markGroupBuyShipped && done.length) {
    const { data: g } = await db().from("group_buys").select("id, date_end, feature_tags").eq("tenant_id", session.tenantId).eq("id", gb.id).maybeSingle();
    const ended = g && (g as Row).date_end && Date.parse(str((g as Row).date_end)) < Date.now();
    if (ended) {
      const { count } = await db()
        .from("sales_orders")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", session.tenantId)
        .eq("group_buy_id", gb.id)
        .in("state", ["NEW", "PROCESSING"])
        .is("date_shipped", null)
        .neq("shipping_type", "NOD")
        .not("status", "in", `(${SHIPPED_STATUSES.join(",")})`);
      if (!count) {
        const tags = new Set(((g as Row).feature_tags as string[] | null) ?? []);
        tags.delete("UNSHIPPING");
        tags.delete("SHIPPING");
        tags.add("SHIPPED");
        await db().from("group_buys").update({ feature_tags: [...tags] }).eq("tenant_id", session.tenantId).eq("id", gb.id);
        markedGroup = true;
      }
    }
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const list = (arr: string[]) => esc(arr.slice(0, 20).join("、")) + (arr.length > 20 ? "…" : "");
  const msg: string[] = [`成功匯入 <b>${done.length}</b> 筆訂單的貨運編號（狀態設為已出貨）`];
  if (notFoundList.length) msg.push(`找不到訂單 ${notFoundList.length} 筆：${list(notFoundList)}`);
  if (others.length) msg.push(`他團訂單略過 ${others.length} 筆（未勾「包含他團清單」）：${list(others)}`);
  if (skippedExists.length) msg.push(`已有貨運編號略過 ${skippedExists.length} 筆：${list(skippedExists)}`);
  if (inactive.length) msg.push(`已取消／合併／拆單的訂單略過 ${inactive.length} 筆：${list(inactive)}`);
  if (invalid) msg.push(`缺少訂單編號或貨運編號的資料列 ${invalid} 列`);
  if (postErrors.length) msg.push(`郵局掛號號碼格式錯誤 ${postErrors.length} 列：${esc(postErrors.slice(0, 10).join("；"))}`);
  else if (postLast8 && (selectedProvider === "POST" || lines.some((l) => l.provider === "POST"))) msg.push(`郵局掛號號碼已組成 14 碼（前6碼＋${esc(postLast8)}）`);
  if (mailed) {
    const n = (await deliveryNotice(session.tenantId, "EMAIL", "出貨通知信（Email）")).message;
    msg.push(n ? `${n}（${mailed} 筆）` : `已排入出貨通知信 ${mailed} 筆`);
  }
  if (markedGroup) msg.push("此團已結團且已無可出貨訂單，已標示為「出完貨」");
  return actionOk(msg.join("<br>"), { count: done.length });
}

/* ─────────────────────────── 貨運標籤設定 ─────────────────────────── */

async function getByTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const tag = str(await ctx.param("tag"));
  const row = tag ? (await tenantTags(session)).find((t) => str(t.tag) === tag) ?? null : null;
  let data: Row = { ...DEFAULT_SHIPPING_TAG };
  if (row) {
    const api = rowToApi(shippingTagEntity, row);
    const provider = str(row.shipping_provider);
    const providers = await enumOptions("ShippingTag.shippingProvider");
    data = {
      ...api,
      salesOrderUuid: str(row.sales_order_uuid),
      salesOrderShippingReceiptNumber: str(row.sales_order_shipping_receipt_number),
      shippingProvider: provider,
      shippingExportFormat: str(row.shipping_export_format),
      shippingTagSettings: (row.shipping_tag_settings ?? {}) as Row,
      uniqueShippingProvider: provider.replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, ""),
      cvs: ["SE", "FAMI"].includes(provider.replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, "")),
      shippingProviderString: providers.find((p) => p.value === provider)?.label ?? provider,
    };
  }
  return json({ data, recordsTotal: 0, recordsFiltered: 0, dateModified: 0, executionTime: 0, options: {} });
}

export const shippingCsvRoutes: RouteDef[] = [
  { ...fragment("/backend/ShippingCSV/exportShippingCSV", { template: "shipping/modal-shippingcsv-export.html", method: "GET", data: exportModalData }), priority: 50 },
  post("/ajax/ShippingCSV/countOrders", countOrders),
  post("/ajax/ShippingCSV/exportOrders", exportOrders),
  fragment("/backend/ShippingCSV/importShippingCSV", { template: "shipping/modal-shippingcsv-import.html", method: "GET", data: importModalData }),
  post("/ajax/ShippingCSV/importShippingCSV", importShippingCsv),
  get("/ajax/ShippingTag/getByTag", getByTag),
];
