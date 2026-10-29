// 電子發票：/backend/Invoice/list（可帶 ?groupBuyId=）
// 原站：spec/html/invoice-list.html、spec/runtime/invoice-list.records.txt、SPEC「電子發票」、7.5；
//       前端程式 public/scripts/invoice.js（invoiceManager：showStatus/issueBySalesOrderId/prepareAllowance）、
//       public/public/scripts/invoice_v2.min.js（InvoiceManager：訂單發票彈窗，訂單頁使用）。
// fix21 起串綠界電子發票：團購進階設定 EINVOICE_PROVIDER＝ECPAY／TEST 且金鑰已設定時直接送平台開立／作廢／折讓；
// 未啟用時只寫 groupbuy.invoices 紀錄（預約中／作廢發票／開立折讓）並回【未串接】；勾「只記錄」時直接標成已作廢／折讓已開立。
// 彈窗提示字依啟用狀態動態產生（einvoice-notice.ts）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/Invoice/list                         頁面
//   POST /ajax/Invoice/list?groupBuyId=                列表（serverSide；invoiceStatus 篩選）
//   POST /ajax/Invoice/save|update|delete              Editor（狀態、開立時間）
//   POST /ajax/Invoice/statusSend                      重新排程（發送失敗 → 預約中）
//   POST /ajax/Invoice/statusCancel                    取消預約（預約中／等待發票號碼中 → 已取消發送；本系統自訂路徑）
//   GET  /ajax/Invoice/status                          24 小時內開立／預約／失敗數量
//   POST /ajax/Invoice/issueInvoice                    開立（salesOrderId / salesOrderIds / uuid）
//   POST /ajax/Invoice/issueInvalid                    作廢（uuid / invoiceId）
//   POST /ajax/Invoice/issueAllowance                  折讓
//   GET  /ajax/Invoice/get?invoiceId=                  發票明細（折讓用）
//   GET  /ajax/Invoice/salesOrder?salesOrderId=        訂單的發票（訂單頁 InvoiceManager）
//   GET  /ajax/Invoice/previewInvoice?salesOrderId=    預覽開立明細
//   GET  /ajax/Invoice/displayIssueInvalid|displayIssueInvoice|displaySalesOrderInvoices  彈窗（路徑見 SPEC；內容推導）
//   GET  /ajax/Invoice/displayAllowance?invoiceId=     開立折讓彈窗（本系統自訂路徑）
import { restrictedGroupBuyIds } from "@/lib/modules/groupbuy/restricted-scope";
import { getServiceClient } from "@/lib/supabase/server";
import { invoice } from "@/lib/db/entities";
import { rowToApi, type Row } from "@/lib/db/mapping";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { modalFragment } from "./fragments";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { crudRoutes, listEntity, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumLabel, enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { fetchAll, money, optionalGroupBuyId, parseIdList } from "./common";
import { groupBuyPreferences } from "@/lib/modules/storefront/site";
import { einvoiceProviderFor, envSuffix, isSandbox } from "./gateway";
import { einvoiceNotice, type EinvoiceNoticeKind } from "./einvoice-notice";
import { normalizeInvoiceItems, type EinvoiceProvider } from "@/lib/integrations/einvoice";

const STATUS_ENUM = "Invoice.invoiceStatus";
const SELECT = "*, sales_orders(uuid, group_buy_id)";

/** 已在平台開立過（有發票號碼）的狀態 */
const ISSUED = ["EINVOICE_SENT", "SEND_ALLOWANCE", "ALLOWANCE_SENT", "ALLOWANCE_FAILED", "INVALIDATE_EINVOICE", "EINVOICE_INVALIDATED"];
/** 訂單「目前有效」的發票（開立新發票時視為重複） */
const ACTIVE = ["SEND_EINVOICE", "PENDING_EINVOICE", "EINVOICE_SENT", "SEND_ALLOWANCE", "ALLOWANCE_SENT", "ALLOWANCE_FAILED", "INVALIDATE_EINVOICE"];
/** 可作廢 */
const VOIDABLE = ["EINVOICE_SENT", "ALLOWANCE_SENT", "ALLOWANCE_FAILED"];
/** 尚未開立（作廢＝取消預約） */
const SCHEDULED = ["SEND_EINVOICE", "PENDING_EINVOICE"];
/** 可折讓 */
const ALLOWANCABLE = ["EINVOICE_SENT", "ALLOWANCE_SENT"];

export interface InvoiceItem {
  invoiceItemId: number;
  name: string;
  unitPrice: number;
  total: number;
  totalPrice: number;
  allowances?: { total: number; unitPrice: number; totalPrice: number; date: string; reason: string; allowanceNumber?: string | null; invalidated?: boolean }[];
}

type InvRow = Row & {
  id: number;
  tenant_id: number;
  sales_order_id: number | null;
  group_buy_id: number | null;
  merchant_order_id: string | null;
  invoice_status: string;
  invoice_number: string | null;
  random_number: string | null;
  amount: string | number;
  allowance_amount: string | number | null;
  allowance_reason: string | null;
  invalid_reason: string | null;
  error_message: string | null;
  buyer_vat_id: string | null;
  buyer_title: string | null;
  carrier_type: number | null;
  carrier_num: string | null;
  donation_code: string | null;
  items: InvoiceItem[] | null;
  date_einvoice: string | null;
  date_allowance: string | null;
  sales_orders?: { uuid?: string; group_buy_id?: number } | null;
};

/** 列表／明細回傳鍵：entity 欄位（含 errorMessage）＋ invoiceSettings（receiptVatId/remark 等，invoice_v2.min.js 讀取）＋ invoiceRandomNumber、allowancable、uuid */
function invoiceApi(r: InvRow): Row {
  const api = rowToApi(invoice, r);
  for (const k of ["merchantOrderId", "invoiceNumber", "dateEinvoiceString", "randomNumber", "buyerVatId", "buyerTitle"]) api[k] = api[k] ?? "";
  api.uuid = r.sales_orders?.uuid ?? (r.merchant_order_id ?? "").split("#")[0];
  api.invoiceRandomNumber = r.random_number ?? "";
  api.invoiceSettings = {
    receiptVatId: r.buyer_vat_id ?? null,
    receiptTitle: r.buyer_title ?? null,
    carrierType: r.carrier_type ?? null,
    carrierNum: r.carrier_num ?? null,
    donationCode: r.donation_code ?? null,
    remark: r.invalid_reason ?? r.allowance_reason ?? null,
  };
  api.allowancable = ALLOWANCABLE.includes(r.invoice_status);
  return api;
}

/* ───────────────────────── 列表／Editor ───────────────────────── */

async function listInvoices(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  // 到期的預約發票（付款後 N 日開立）在打開列表時補開立（另由付款通知觸發）
  try {
    await processDueInvoices(session.tenantId, 5);
  } catch (e) {
    console.error("[accounting] 預約發票開立失敗", (e as Error).message);
  }
  const groupBuyId = await optionalGroupBuyId(ctx, session);
  const spec: ListSpec = {
    select: SELECT,
    search: ["merchantOrderId", "invoiceNumber"],
    like: ["merchantOrderId", "invoiceNumber"],
    defaultOrder: [{ key: "dateEinvoiceString", ascending: false }],
    where: (q, dt) => {
      let qq = q;
      const st = String(dt.extra.invoiceStatus ?? "").trim();
      if (st) qq = qq.eq("invoice_status", st);
      if (groupBuyId) qq = qq.eq("group_buy_id", groupBuyId);
      return qq;
    },
    mapRow: (_api, row) => invoiceApi(row as InvRow),
    options: () => enumOptionsFor({ invoiceStatus: STATUS_ENUM }),
    restrictGroupBuy: "group_buy_id", // 團購受限帳戶（PARITY #37，補F）
  };
  return listEntity(ctx, invoice, spec);
}

const invoiceWrite: WriteSpec = {
  select: SELECT,
  mapRow: (_api, row) => invoiceApi(row as InvRow),
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if ("invoiceStatus" in values || action === "create") {
      const allowed = (await enumOptions(STATUS_ENUM)).map((o) => String(o.value));
      if (!allowed.includes(String(values.invoiceStatus ?? ""))) errors.push({ name: "invoiceStatus", status: "請選擇狀態" });
    }
    const d = values.dateEinvoiceString;
    if (d !== undefined && d !== null && String(d).trim() !== "" && !/^\d{4}-\d{1,2}-\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(String(d).trim())) {
      errors.push({ name: "dateEinvoiceString", status: "日期格式錯誤（YYYY-MM-DD）" });
    }
    if (action === "create") {
      const ref = values.salesOrderId ?? values.merchantOrderId ?? ctx.query.get("salesOrderId");
      if (ref == null || String(ref).trim() === "") errors.push({ name: "invoiceStatus", status: "請由訂單開立發票（需要訂單編號）" });
    }
    return errors;
  },
  async beforeWrite(dbRow, values, action, ctx) {
    // 只允許改狀態與開立（預約）時間；其餘發票內容由開立流程產生
    const out: Row = {};
    if ("invoice_status" in dbRow) out.invoice_status = dbRow.invoice_status;
    if ("date_einvoice" in dbRow) out.date_einvoice = dbRow.date_einvoice;
    if (action === "create") {
      const order = await findOrder(ctx.session, values.salesOrderId ?? ctx.query.get("salesOrderId"), values.merchantOrderId);
      const built = await buildInvoiceRow(ctx.session, order);
      return { ...built, ...out, invoice_status: out.invoice_status ?? "SEND_EINVOICE" };
    }
    if (out.invoice_status === "EINVOICE_SENT" || out.invoice_status === "SEND_EINVOICE") out.error_message = null;
    return out;
  },
  async beforeRemove(ids, ctx) {
    const { data } = await getServiceClient().from("invoices").select("id, invoice_status").eq("tenant_id", ctx.session.tenantId).in("id", ids);
    const issued = ((data ?? []) as { id: number; invoice_status: string }[]).filter((r) => ISSUED.includes(r.invoice_status));
    if (issued.length) throw badRequest("已開立的發票不可刪除，請使用「作廢發票」");
  },
  optimisticLock: false,
};

/* ───────────────────────── 訂單 → 發票資料 ───────────────────────── */

type TenantScope = { tenantId: number; adminUserId?: number | null };

type OrderForInvoice = {
  id: number;
  uuid: string;
  tenant_id: number;
  group_buy_id: number | null;
  state: string;
  status: string;
  total_paid: string | number;
  customer_firstname: string | null;
  customer_email: string | null;
  customer_telephone: string | null;
  billing_city: string | null;
  billing_district: string | null;
  billing_street: string | null;
  cvs_address: string | null;
  grand_total: string | number;
  shipping_amount: string | number;
  discount_amount: string | number;
  extra_fee: string | number;
  cod_fee: string | number;
  billing_receipt_type: number;
  billing_receipt_title: string | null;
  billing_receipt_vat_id: string | null;
  billing_receipt_paper: boolean;
  billing_receipt_donate: boolean;
  billing_receipt_donation_code: string | null;
  billing_receipt_carrier_type: number;
  billing_receipt_carrier_num: string | null;
};

const ORDER_COLS =
  "id, uuid, tenant_id, group_buy_id, state, status, total_paid, customer_firstname, customer_email, customer_telephone, billing_city, billing_district, billing_street, cvs_address, grand_total, shipping_amount, discount_amount, extra_fee, cod_fee, billing_receipt_type, billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper, billing_receipt_donate, billing_receipt_donation_code, billing_receipt_carrier_type, billing_receipt_carrier_num";

async function findOrder(session: TenantScope, salesOrderId: unknown, uuid?: unknown): Promise<OrderForInvoice> {
  const db = getServiceClient();
  let q = db.from("sales_orders").select(ORDER_COLS).eq("tenant_id", session.tenantId);
  const id = Number(salesOrderId);
  if (Number.isSafeInteger(id) && id > 0) q = q.eq("id", id);
  else if (uuid != null && String(uuid).trim() !== "") q = q.eq("uuid", String(uuid).split("#")[0].trim());
  else throw badRequest("缺少訂單");
  const { data, error } = await q.maybeSingle<OrderForInvoice>();
  if (error) throw new Error(`[accounting] ${error.message}`);
  if (!data) throw notFound("找不到訂單");
  return data;
}

async function orderInvoiceItems(session: TenantScope, o: OrderForInvoice): Promise<InvoiceItem[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("order_items")
    .select("id, title, specifications_label, price, total, amount, bundle_child, seq")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", o.id)
    .order("seq")
    .order("id");
  if (error) throw new Error(`[accounting] ${error.message}`);
  const items: InvoiceItem[] = [];
  for (const it of (data ?? []) as { title: string; specifications_label: string | null; price: number | string; total: number; amount: number | string; bundle_child: boolean }[]) {
    if (it.bundle_child) continue; // 組合子項不另列
    const total = Number(it.total) || 0;
    const totalPrice = Number(it.amount) || Number(it.price) * total;
    if (total <= 0) continue;
    items.push({
      invoiceItemId: items.length + 1,
      name: [it.title, it.specifications_label].filter(Boolean).join(" "),
      unitPrice: Math.round((totalPrice / total) * 100) / 100,
      total,
      totalPrice,
    });
  }
  const extra: [string, number][] = [
    ["運費", Number(o.shipping_amount) || 0],
    ["手續費", (Number(o.extra_fee) || 0) + (Number(o.cod_fee) || 0)],
    ["折扣", -(Number(o.discount_amount) || 0)],
  ];
  for (const [name, v] of extra) {
    if (v !== 0) items.push({ invoiceItemId: items.length + 1, name, unitPrice: v, total: 1, totalPrice: v });
  }
  // 與訂單總額對齊（點數、優惠卷等差額）
  const sum = items.reduce((a, b) => a + b.totalPrice, 0);
  const diff = Math.round((Number(o.grand_total) - sum) * 100) / 100;
  if (diff !== 0) items.push({ invoiceItemId: items.length + 1, name: diff < 0 ? "其他折抵" : "其他", unitPrice: diff, total: 1, totalPrice: diff });
  return items;
}

/** 電子發票服務商：進階設定 EINVOICE_PROVIDER（本團 → 綁定標籤 → 系統設定） */
async function providerOf(session: TenantScope, groupBuyId: number | null): Promise<string> {
  if (!groupBuyId) return "NONE";
  return (await groupBuyPreferences(session.tenantId, groupBuyId)).EINVOICE_PROVIDER?.value || "NONE";
}

async function buildInvoiceRow(session: TenantScope, o: OrderForInvoice): Promise<Row> {
  const amount = Number(o.grand_total) || 0;
  const sales = Math.round(amount / 1.05);
  const b2b = Number(o.billing_receipt_type) === 2;
  const donate = Number(o.billing_receipt_type) === 3 || !!o.billing_receipt_donate;
  const { count } = await getServiceClient()
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", o.id);
  return {
    tenant_id: session.tenantId,
    sales_order_id: o.id,
    group_buy_id: o.group_buy_id,
    merchant_order_id: (count ?? 0) > 0 ? `${o.uuid}#${(count ?? 0) + 1}` : o.uuid,
    invoice_status: "SEND_EINVOICE",
    provider: await providerOf(session, o.group_buy_id),
    amount,
    sales_amount: sales,
    tax_amount: amount - sales,
    tax_type: "TAXABLE",
    buyer_vat_id: b2b ? o.billing_receipt_vat_id : null,
    buyer_title: b2b ? o.billing_receipt_title : null,
    carrier_type: !b2b && !donate ? Number(o.billing_receipt_carrier_type) || 0 : null,
    carrier_num: !b2b && !donate ? o.billing_receipt_carrier_num : null,
    donation_code: donate ? o.billing_receipt_donation_code : null,
    print_flag: b2b || !!o.billing_receipt_paper,
    items: await orderInvoiceItems(session, o),
    date_einvoice: new Date().toISOString(),
    error_message: null,
  };
}

/* ───────────────────────── 送電子發票平台（綠界） ───────────────────────── */

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
  invoiceNumber?: string | null;
}

/** 綠界自訂發票編號：訂單編號＋發票 id（英數，同一張發票重送時相同 → 綠界擋重複開立） */
export function relateNumberOf(inv: { id: number; merchant_order_id: string | null }): string {
  const base = String(inv.merchant_order_id ?? "").split("#")[0].replace(/[^A-Za-z0-9]/g, "");
  return `${base}I${inv.id}`.slice(-50);
}

/** 綠界回傳時間（yyyy-MM-dd HH:mm:ss，台灣時間）→ ISO */
function ecpayTime(s: string | null | undefined): string {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(String(s ?? ""));
  if (!m) return new Date().toISOString();
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0) - 8, +(m[5] ?? 0), +(m[6] ?? 0))).toISOString();
}

/** 發票開立日（台灣日期 yyyy-MM-dd；作廢／折讓 API 用） */
function invoiceDateOf(inv: { date_einvoice: string | null }): string {
  const d = inv.date_einvoice ? new Date(inv.date_einvoice) : new Date();
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

async function syncOrderInvoice(scope: TenantScope, orderId: number | null, invoiceNumber: string | null, dateIso: string | null, note: string): Promise<void> {
  if (!orderId) return;
  const { error } = await getServiceClient().rpc("orders_admin_update", {
    p_tenant_id: scope.tenantId,
    p_ids: [orderId],
    p_patch: { invoice_number: invoiceNumber, date_einvoice: dateIso },
    p_admin_user_id: scope.adminUserId ?? null,
    p_note: note,
    p_actor: scope.adminUserId ? "ADMIN" : "SYSTEM",
  });
  if (error) console.error("[accounting] 回寫訂單發票號碼失敗", orderId, error.message);
}

function toProviderItems(items: InvoiceItem[], amount: number) {
  return normalizeInvoiceItems(
    items.map((it) => ({ name: it.name, count: it.total, unitPrice: it.unitPrice, amount: it.totalPrice })),
    amount,
  );
}

/**
 * 開立一張發票到平台：只處理「預約中／發送失敗」（或卡在「等待發票號碼中」超過 10 分鐘的），
 * 先以條件式更新取得處理權（並行只有一個成功），平台回「編號重複」時以自訂編號查回已開立的發票。
 */
export async function sendInvoice(scope: TenantScope, invoiceId: number, provider?: EinvoiceProvider | null): Promise<SendResult> {
  const db = getServiceClient();
  const { data: cur } = await db.from("invoices").select(SELECT).eq("tenant_id", scope.tenantId).eq("id", invoiceId).maybeSingle<InvRow & { updated_at: string }>();
  if (!cur) return { ok: false, message: "找不到發票" };
  const p = provider === undefined ? await einvoiceProviderFor(scope.tenantId, cur.group_buy_id) : provider;
  if (!p) return { ok: false, skipped: true, message: "電子發票服務商未設定（進階設定「電子發票服務提供商」需為綠界）【未串接】" };
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  let claim = db
    .from("invoices")
    .update({ invoice_status: "PENDING_EINVOICE", provider: p.code, error_message: null })
    .eq("tenant_id", scope.tenantId)
    .eq("id", invoiceId);
  claim = cur.invoice_status === "PENDING_EINVOICE" ? claim.eq("invoice_status", "PENDING_EINVOICE").lt("updated_at", stale) : claim.in("invoice_status", ["SEND_EINVOICE", "EINVOICE_FAILED"]);
  const { data: claimed, error: cerr } = await claim.select("id");
  if (cerr) throw new Error(`[accounting] ${cerr.message}`);
  if (!claimed?.length) return { ok: false, skipped: true, message: "發票正在開立或狀態已變更" };

  const relate = relateNumberOf(cur);
  let order: OrderForInvoice | null = null;
  if (cur.sales_order_id) order = await findOrder(scope, cur.sales_order_id).catch(() => null);
  const amount = Number(cur.amount);
  const items = Array.isArray(cur.items) && cur.items.length ? cur.items : order ? await orderInvoiceItems(scope, order) : [];
  const address = order ? [order.billing_city, order.billing_district, order.billing_street].filter(Boolean).join("") || order.cvs_address || "" : "";
  let res = await p.issue({
    relateNumber: relate,
    amount,
    items: toProviderItems(items, amount),
    buyerVatId: cur.buyer_vat_id,
    buyerTitle: cur.buyer_title,
    buyerName: order?.customer_firstname ?? null,
    email: order?.customer_email ?? null,
    phone: order?.customer_telephone ?? null,
    address,
    carrierType: cur.carrier_type,
    carrierNum: cur.carrier_num,
    loveCode: cur.donation_code,
    print: !!cur.buyer_vat_id,
  });
  if (!res.ok && (res.duplicate || /逾時|timeout|連線/i.test(res.message))) {
    const q = await p.queryByRelateNumber(relate);
    if (q.ok) res = q;
  }
  if (!res.ok || !res.invoiceNumber) {
    await db
      .from("invoices")
      .update({ invoice_status: "EINVOICE_FAILED", error_message: `${res.message || "開立失敗"}${envSuffix()}`.slice(0, 500) })
      .eq("tenant_id", scope.tenantId)
      .eq("id", invoiceId);
    return { ok: false, message: res.message || "開立失敗" };
  }
  const dateIso = ecpayTime(res.invoiceDate);
  await db
    .from("invoices")
    .update({ invoice_status: "EINVOICE_SENT", invoice_number: res.invoiceNumber, random_number: res.randomNumber, date_einvoice: dateIso, error_message: null, items })
    .eq("tenant_id", scope.tenantId)
    .eq("id", invoiceId);
  await syncOrderInvoice(scope, cur.sales_order_id, res.invoiceNumber, dateIso, `[電子發票] 開立 ${res.invoiceNumber}${envSuffix()}`);
  return { ok: true, message: `已開立 ${res.invoiceNumber}${envSuffix()}`, invoiceNumber: res.invoiceNumber };
}

/** 作廢平台上的發票（有折讓單時先作廢折讓單）；成功 → 發票已作廢 */
async function voidAtProvider(scope: TenantScope, inv: InvRow, reason: string, p: EinvoiceProvider): Promise<SendResult> {
  const db = getServiceClient();
  if (!inv.invoice_number) return { ok: false, message: "沒有發票號碼" };
  const items = (inv.items ?? []).map((it) => ({ ...it, allowances: [...(it.allowances ?? [])] }));
  for (const it of items) {
    for (const a of it.allowances ?? []) {
      if (!a.allowanceNumber || a.invalidated) continue;
      const r = await p.allowanceInvalid({ invoiceNumber: inv.invoice_number, allowanceNumber: a.allowanceNumber, reason });
      if (!r.ok && !/已作廢/.test(r.message)) {
        await db.from("invoices").update({ items, error_message: `作廢折讓單失敗：${r.message}`.slice(0, 500) }).eq("tenant_id", scope.tenantId).eq("id", inv.id);
        return { ok: false, message: `作廢折讓單 ${a.allowanceNumber} 失敗：${r.message}` };
      }
      a.invalidated = true;
    }
  }
  const r = await p.invalid({ invoiceNumber: inv.invoice_number, invoiceDate: invoiceDateOf(inv), reason });
  if (!r.ok && !/已作廢/.test(r.message)) {
    await db.from("invoices").update({ items, error_message: `作廢失敗：${r.message}`.slice(0, 500) }).eq("tenant_id", scope.tenantId).eq("id", inv.id);
    return { ok: false, message: r.message || "作廢失敗" };
  }
  const now = new Date().toISOString();
  await db
    .from("invoices")
    .update({ items, invoice_status: "EINVOICE_INVALIDATED", invalid_reason: reason, date_invalidated: now, error_message: null })
    .eq("tenant_id", scope.tenantId)
    .eq("id", inv.id);
  await syncOrderInvoice(scope, inv.sales_order_id, null, null, `[電子發票] 作廢 ${inv.invoice_number}（${reason}）${envSuffix()}`);
  return { ok: true, message: `已作廢 ${inv.invoice_number}${envSuffix()}` };
}

/**
 * 付款成功後依設定開立：發票未關閉、服務商為綠界、發送階段＝付款後（未設定視同付款後）、
 * 三聯式且勾「三聯式不自動開立」者略過；EINVOICE_DAYS_TO_SEND＞0 時只建立預約（到期由 processDueInvoices 開立）。
 */
export async function autoIssueInvoiceOnPaid(tenantId: number, orderId: number): Promise<SendResult> {
  const scope: TenantScope = { tenantId };
  const o = await findOrder(scope, orderId);
  if (!o.group_buy_id) return { ok: false, skipped: true, message: "無團購" };
  const db = getServiceClient();
  const { data: gb } = await db.from("group_buys").select("invoice_disabled, group_buy_settings").eq("tenant_id", tenantId).eq("id", o.group_buy_id).maybeSingle<{ invoice_disabled: boolean; group_buy_settings: Record<string, unknown> | null }>();
  if (!gb || gb.invoice_disabled) return { ok: false, skipped: true, message: "團購已關閉發票" };
  const p = await einvoiceProviderFor(tenantId, o.group_buy_id);
  if (!p) return { ok: false, skipped: true, message: "未設定電子發票服務商" };
  const prefs = await groupBuyPreferences(tenantId, o.group_buy_id);
  const stage = String(prefs.EINVOICE_TO_SEND_STATE?.value ?? "PAID").toUpperCase() || "PAID";
  if (stage !== "PAID") return { ok: false, skipped: true, message: "發送階段為出貨後" };
  if (Number(o.billing_receipt_type) === 2 && (gb.group_buy_settings ?? {}).einvoice3CopiesDisabled === true) return { ok: false, skipped: true, message: "三聯式不自動開立" };
  const { data: existing } = await db.from("invoices").select("id, invoice_status").eq("tenant_id", tenantId).eq("sales_order_id", o.id);
  if (((existing ?? []) as { invoice_status: string }[]).some((r) => ACTIVE.includes(r.invoice_status))) return { ok: false, skipped: true, message: "已有發票" };
  const days = Math.max(0, Math.min(60, Number(prefs.EINVOICE_DAYS_TO_SEND?.value ?? 0) || 0));
  const row = await buildInvoiceRow(scope, o);
  row.provider = p.code;
  if (days > 0) row.date_einvoice = new Date(Date.now() + days * 86400_000).toISOString();
  const { data: ins, error } = await db.from("invoices").insert(row).select("id").single<{ id: number }>();
  if (error) throw new Error(`[accounting] ${error.message}`);
  if (days > 0) return { ok: true, skipped: true, message: `已預約 ${days} 日後開立` };
  return sendInvoice(scope, ins.id, p);
}

/** 到期的預約發票（預約中且開立時間已到；或卡在等待發票號碼中）→ 開立。回傳處理筆數 */
export async function processDueInvoices(tenantId: number, limit = 20): Promise<number> {
  const db = getServiceClient();
  const now = new Date().toISOString();
  const { data } = await db
    .from("invoices")
    .select("id, group_buy_id")
    .eq("tenant_id", tenantId)
    .in("invoice_status", ["SEND_EINVOICE", "PENDING_EINVOICE"])
    .lte("date_einvoice", now)
    .order("id")
    .limit(limit);
  let n = 0;
  for (const r of (data ?? []) as { id: number; group_buy_id: number | null }[]) {
    const p = await einvoiceProviderFor(tenantId, r.group_buy_id);
    if (!p) continue;
    const res = await sendInvoice({ tenantId }, r.id, p);
    if (!res.skipped) n++;
  }
  return n;
}

/** 訂單取消時作廢該訂單的發票（已開立 → 平台作廢；預約中 → 取消預約） */
export async function voidInvoicesForOrders(scope: TenantScope, orderIds: number[], reason: string): Promise<string[]> {
  if (!orderIds.length) return [];
  const db = getServiceClient();
  const { data } = await db.from("invoices").select(SELECT).eq("tenant_id", scope.tenantId).in("sales_order_id", orderIds).in("invoice_status", [...VOIDABLE, ...SCHEDULED]);
  const msgs: string[] = [];
  for (const inv of (data ?? []) as InvRow[]) {
    if (SCHEDULED.includes(inv.invoice_status)) {
      await db.from("invoices").update({ invoice_status: "SEND_CANCELED", invalid_reason: reason }).eq("tenant_id", scope.tenantId).eq("id", inv.id).in("invoice_status", SCHEDULED);
      msgs.push(`發票預約已取消`);
      continue;
    }
    const p = await einvoiceProviderFor(scope.tenantId, inv.group_buy_id);
    if (!p) {
      await db.from("invoices").update({ invoice_status: "INVALIDATE_EINVOICE", invalid_reason: reason }).eq("tenant_id", scope.tenantId).eq("id", inv.id);
      msgs.push(`發票 ${inv.invoice_number ?? ""} 已標示作廢（服務商未串接）`);
      continue;
    }
    const r = await voidAtProvider(scope, inv, reason, p);
    msgs.push(r.ok ? r.message : `發票 ${inv.invoice_number ?? ""} 作廢失敗：${r.message}`);
  }
  return msgs;
}

/**
 * fix22：線上部分退款後依退款金額開立折讓（單一品項「退款折讓」）。
 * 只處理已開立（可折讓）的發票；預約中／未串接 → 回提示請人工處理。回傳給管理員看的訊息。
 */
export async function allowanceForRefund(scope: TenantScope, orderId: number, amount: number, reason: string): Promise<string[]> {
  const db = getServiceClient();
  const { data } = await db.from("invoices").select(SELECT).eq("tenant_id", scope.tenantId).eq("sales_order_id", orderId).in("invoice_status", [...ALLOWANCABLE, ...SCHEDULED]).order("id", { ascending: false });
  const rows = (data ?? []) as InvRow[];
  const inv = rows.find((r) => ALLOWANCABLE.includes(r.invoice_status) && r.invoice_number);
  if (!inv) {
    return rows.some((r) => SCHEDULED.includes(r.invoice_status)) ? ["電子發票尚未開立（預約中）：開立時仍為原金額，請人工調整或開立後折讓"] : [];
  }
  const prev = Number(inv.allowance_amount ?? 0);
  if (prev + amount > Number(inv.amount) + 0.001) return [`發票 ${inv.invoice_number} 折讓總額會超過發票金額，未自動折讓，請人工處理`];
  const p = await einvoiceProviderFor(scope.tenantId, inv.group_buy_id);
  if (!p) return [`發票 ${inv.invoice_number} 服務商未串接，請人工開立折讓 ${money(amount)} 元`];
  const { data: od } = await db.from("sales_orders").select("customer_firstname, customer_email").eq("tenant_id", scope.tenantId).eq("id", orderId).maybeSingle<{ customer_firstname: string | null; customer_email: string | null }>();
  const r = await p.allowance({
    invoiceNumber: String(inv.invoice_number),
    invoiceDate: invoiceDateOf(inv),
    amount,
    items: [{ name: "退款折讓", count: 1, unitPrice: amount, amount }],
    reason,
    customerName: od?.customer_firstname ?? null,
    email: od?.customer_email ?? null,
  });
  if (!r.ok) {
    await db.from("invoices").update({ error_message: `折讓失敗：${r.message}`.slice(0, 500) }).eq("tenant_id", scope.tenantId).eq("id", inv.id);
    return [`發票 ${inv.invoice_number} 折讓失敗：${r.message}`];
  }
  const now = new Date().toISOString();
  const items = (inv.items ?? []).map((it) => ({ ...it, allowances: [...(it.allowances ?? [])] }));
  const entry = { total: 0, unitPrice: amount, totalPrice: amount, date: now, reason, allowanceNumber: r.allowanceNumber };
  if (items.length) items[0].allowances!.push(entry);
  else items.push({ invoiceItemId: 0, name: "退款折讓", unitPrice: amount, total: 0, totalPrice: 0, allowances: [entry] });
  await db
    .from("invoices")
    .update({ items, allowance_amount: prev + amount, allowance_reason: reason, date_allowance: now, invoice_status: "ALLOWANCE_SENT", allowance_number: r.allowanceNumber, error_message: null })
    .eq("tenant_id", scope.tenantId)
    .eq("id", inv.id);
  await db.from("sales_order_histories").insert({ tenant_id: scope.tenantId, sales_order_id: orderId, actor: "SYSTEM", note: `[電子發票] 發票 ${inv.invoice_number} 折讓 ${money(amount)} 元 ${r.allowanceNumber ?? ""}（${reason}）${envSuffix()}`.slice(0, 1000) });
  return [`發票 ${inv.invoice_number} 已折讓 ${money(amount)} 元${r.allowanceNumber ? `（折讓單 ${r.allowanceNumber}）` : ""}${envSuffix()}`];
}

/* ───────────────────────── 動作 ───────────────────────── */

async function idsParam(ctx: RequestContext): Promise<number[]> {
  const ids = parseIdList((await ctx.param("invoiceId")) ?? (await ctx.param("invoiceIds")));
  if (!ids.length) throw badRequest("請先勾選發票");
  return ids;
}

async function loadInvoices(session: AdminSession, ids: number[]): Promise<InvRow[]> {
  const { data, error } = await getServiceClient().from("invoices").select(SELECT).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[accounting] ${error.message}`);
  const rows = (data ?? []) as InvRow[];
  if (rows.length !== ids.length) throw badRequest("找不到部分發票（可能已被刪除）");
  return rows;
}

/** 重新排程：只處理「電子發票發送失敗」→「發送電子發票[預約中]」 */
async function statusSend(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rows = await loadInvoices(session, await idsParam(ctx));
  const ok = rows.filter((r) => r.invoice_status === "EINVOICE_FAILED");
  const skip = rows.filter((r) => r.invoice_status !== "EINVOICE_FAILED");
  if (ok.length) {
    const { error } = await getServiceClient()
      .from("invoices")
      .update({ invoice_status: "SEND_EINVOICE", error_message: null, date_einvoice: new Date().toISOString() })
      .eq("tenant_id", session.tenantId)
      .in("id", ok.map((r) => r.id));
    if (error) throw new Error(`[accounting] ${error.message}`);
  }
  const msg = [`已重新排程 ${ok.length} 筆` + (skip.length ? `，略過 ${skip.length} 筆（僅能重新排程開立失敗的發票）` : "")];
  if (!ok.length) throw badRequest(msg[0]);
  let unintegrated = false;
  for (const r of ok) {
    const res = await sendInvoice(session, r.id);
    if (res.skipped) unintegrated = true;
    else msg.push(`${r.merchant_order_id ?? r.id}：${res.ok ? res.message : `開立失敗：${res.message}`}`);
  }
  if (unintegrated) msg.push(notIntegrated("電子發票開立").message);
  return actionOk(msg.join("<br>"), { notIntegrated: unintegrated });
}

/** 取消預約：「預約中／等待發票號碼中」→「已取消發送電子發票」 */
async function statusCancel(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rows = await loadInvoices(session, await idsParam(ctx));
  const ok = rows.filter((r) => SCHEDULED.includes(r.invoice_status));
  const skip = rows.length - ok.length;
  if (!ok.length) throw badRequest("只能取消「發送電子發票[預約中]」或「等待發票號碼中」的發票");
  const { error } = await getServiceClient()
    .from("invoices")
    .update({ invoice_status: "SEND_CANCELED" })
    .eq("tenant_id", session.tenantId)
    .in("id", ok.map((r) => r.id));
  if (error) throw new Error(`[accounting] ${error.message}`);
  return actionOk(`已取消預約 ${ok.length} 筆` + (skip ? `，略過 ${skip} 筆` : ""));
}

/** 24 小時內開立／預約中／失敗 數量（invoiceManager.showStatus） */
async function invoiceStatusSummary(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const allowed = await restrictedGroupBuyIds(session); // 團購受限帳戶：只算授權團購
  const base = () => {
    const q = db.from("invoices").select("id", { count: "exact", head: true }).eq("tenant_id", session.tenantId);
    return allowed ? q.in("group_buy_id", allowed.length ? allowed : [-1]) : q;
  };
  const count = async (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count: c, error } = await build(base());
    if (error) throw new Error(`[accounting] ${error.message}`);
    return c ?? 0;
  };
  const [sentIn24Hours, willSend, failed] = await Promise.all([
    count((q) => q.eq("invoice_status", "EINVOICE_SENT").gte("date_einvoice", since)),
    count((q) => q.in("invoice_status", SCHEDULED)),
    count((q) => q.eq("invoice_status", "EINVOICE_FAILED")),
  ]);
  return json({ code: 200, data: { sentIn24Hours, willSend, failed } });
}

/** 開立：salesOrderId（單筆）、salesOrderIds（多筆）或 uuid（逗號串）；回傳原站格式「訂單:原因<br>」 */
async function issueInvoice(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = parseIdList((await ctx.param("salesOrderIds")) ?? (await ctx.param("salesOrderId")));
  const uuids = String((await ctx.param("uuid")) ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length && !uuids.length) throw badRequest("請先選擇訂單");
  const force = ["true", "1", "on"].includes(String((await ctx.param("forceDuplicate")) ?? ""));
  const db = getServiceClient();
  const orders: OrderForInvoice[] = [];
  for (const id of ids) orders.push(await findOrder(session, id));
  for (const u of uuids) orders.push(await findOrder(session, null, u));

  const lines: string[] = [];
  let unintegrated = false;
  const data: { salesOrderId: number; uuid: string; result: string; invoiceId?: number }[] = [];
  for (const o of orders) {
    if (["DRAFT", "CANCELED", "COMBINED"].includes(o.state)) {
      lines.push(`${o.uuid}:訂單階段為${await enumLabel("SalesOrder.state", o.state)}，不可開立發票`);
      data.push({ salesOrderId: o.id, uuid: o.uuid, result: "STATE" });
      continue;
    }
    const { data: existing } = await db
      .from("invoices")
      .select("id, invoice_status")
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", o.id)
      .order("id", { ascending: false });
    const list = (existing ?? []) as { id: number; invoice_status: string }[];
    const active = list.find((r) => ACTIVE.includes(r.invoice_status));
    if (active && !force) {
      lines.push(`${o.uuid}:此訂單已有發票紀錄（${await enumLabel(STATUS_ENUM, active.invoice_status)}）`);
      data.push({ salesOrderId: o.id, uuid: o.uuid, result: "DUPLICATE", invoiceId: active.id });
      continue;
    }
    const failed = list.find((r) => r.invoice_status === "EINVOICE_FAILED");
    const row = await buildInvoiceRow(session, o);
    let invoiceId: number;
    if (failed) {
      const { merchant_order_id: _m, tenant_id: _t, ...patch } = row;
      void _m;
      void _t;
      const { error } = await db.from("invoices").update(patch).eq("tenant_id", session.tenantId).eq("id", failed.id);
      if (error) throw new Error(`[accounting] ${error.message}`);
      invoiceId = failed.id;
    } else {
      const { data: ins, error } = await db.from("invoices").insert(row).select("id").single<{ id: number }>();
      if (error) throw new Error(`[accounting] ${error.message}`);
      invoiceId = ins.id;
    }
    const p = await einvoiceProviderFor(session.tenantId, o.group_buy_id);
    if (p) {
      const res = await sendInvoice(session, invoiceId, p);
      lines.push(`${o.uuid}:${res.ok ? res.message : `開立失敗：${res.message}`}`);
      data.push({ salesOrderId: o.id, uuid: o.uuid, result: res.ok ? "SENT" : "FAILED", invoiceId });
      continue;
    }
    unintegrated = true;
    lines.push(`${o.uuid}:【未串接】電子發票服務商未設定為綠界，已建立預約開立紀錄（未實際開立、尚無發票號碼）`);
    data.push({ salesOrderId: o.id, uuid: o.uuid, result: "SCHEDULED", invoiceId });
  }
  if (unintegrated) notIntegrated("電子發票開立");
  const message = lines.join("<br>") + "<br>";
  return actionOk(message, { data, notIntegrated: unintegrated });
}

/** 作廢：uuid（逗號串）或 invoiceId；reason 必填；recordOnly＝只在系統記錄已作廢 */
async function issueInvalid(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const reason = String((await ctx.param("reason")) ?? "").trim();
  if (!reason) throw badRequest("請輸入作廢原因");
  if (reason.length > 100) throw badRequest("作廢原因最多 100 字");
  const recordOnly = ["true", "1", "on"].includes(String((await ctx.param("recordOnly")) ?? ""));
  const invoiceIds = parseIdList(await ctx.param("invoiceId"));
  const uuids = String((await ctx.param("uuid")) ?? "")
    .split(/[,\s]+/)
    .map((s) => s.split("#")[0].trim())
    .filter(Boolean);
  if (!invoiceIds.length && !uuids.length) throw badRequest("請先選擇發票");
  const db = getServiceClient();
  let targets: InvRow[] = [];
  if (invoiceIds.length) targets = await loadInvoices(session, invoiceIds);
  else {
    const { data: orders } = await db.from("sales_orders").select("id, uuid").eq("tenant_id", session.tenantId).in("uuid", uuids);
    const orderIds = ((orders ?? []) as { id: number }[]).map((o) => o.id);
    if (orderIds.length) {
      const { data } = await db
        .from("invoices")
        .select(SELECT)
        .eq("tenant_id", session.tenantId)
        .in("sales_order_id", orderIds)
        .in("invoice_status", [...VOIDABLE, ...SCHEDULED]);
      targets = (data ?? []) as InvRow[];
    }
  }
  const results: { uuid: string | null; invoiceId: number | null; result: string }[] = [];
  const done = new Set<string>();
  const now = new Date().toISOString();
  let unintegrated = false;
  for (const inv of targets) {
    const uuid = inv.sales_orders?.uuid ?? (inv.merchant_order_id ?? "").split("#")[0];
    // 已在平台開立（或先前標示待作廢）且服務商為綠界：直接送平台作廢
    if (!recordOnly && [...VOIDABLE, "INVALIDATE_EINVOICE"].includes(inv.invoice_status) && inv.invoice_number) {
      const p = await einvoiceProviderFor(session.tenantId, inv.group_buy_id);
      if (p) {
        const r = await voidAtProvider(session, inv, reason, p);
        results.push({ uuid, invoiceId: inv.id, result: r.ok ? "OK" : `作廢失敗：${r.message}` });
        if (r.ok) done.add(uuid);
        continue;
      }
    }
    let patch: Row | null = null;
    if (SCHEDULED.includes(inv.invoice_status)) patch = { invoice_status: "SEND_CANCELED", invalid_reason: reason };
    else if (VOIDABLE.includes(inv.invoice_status)) {
      patch = recordOnly
        ? { invoice_status: "EINVOICE_INVALIDATED", invalid_reason: reason, date_invalidated: now }
        : { invoice_status: "INVALIDATE_EINVOICE", invalid_reason: reason };
      if (!recordOnly) unintegrated = true;
    }
    if (!patch) {
      results.push({ uuid, invoiceId: inv.id, result: `發票狀態為${await enumLabel(STATUS_ENUM, inv.invoice_status)}，無法作廢` });
      continue;
    }
    const { error } = await db.from("invoices").update(patch).eq("tenant_id", session.tenantId).eq("id", inv.id);
    if (error) throw new Error(`[accounting] ${error.message}`);
    results.push({ uuid, invoiceId: inv.id, result: "OK" });
    done.add(uuid);
  }
  for (const u of uuids) if (!targets.some((t) => (t.sales_orders?.uuid ?? "") === u)) results.push({ uuid: u, invoiceId: null, result: "查無可作廢的發票" });
  const okN = results.filter((r) => r.result === "OK").length;
  const lines = [`作廢 ${okN} 筆` + (results.length - okN ? `，未處理 ${results.length - okN} 筆` : "")];
  for (const r of results.filter((x) => x.result !== "OK")) lines.push(`${r.uuid ?? ""}：${r.result}`);
  if (okN && unintegrated) lines.push(notIntegrated("電子發票作廢").message + "（已標示為「作廢發票」，待串接後送出）");
  else if (okN && !recordOnly) lines.push(`已送電子發票平台作廢${envSuffix()}`);
  if (!okN) throw badRequest(lines.join("<br>"));
  return actionOk(lines.join("<br>"), { data: results, notIntegrated: unintegrated });
}

/** 發票品項（含已折讓）；舊資料沒有品項時由訂單商品推導 */
async function invoiceItemsOf(session: AdminSession, inv: InvRow): Promise<InvoiceItem[]> {
  if (Array.isArray(inv.items) && inv.items.length) return inv.items;
  if (!inv.sales_order_id) return [];
  try {
    const o = await findOrder(session, inv.sales_order_id);
    return await orderInvoiceItems(session, o);
  } catch {
    return [];
  }
}

function remainingQty(it: InvoiceItem): number {
  return it.total - (it.allowances ?? []).reduce((a, b) => a + b.total, 0);
}

async function getInvoice(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number((await ctx.param("invoiceId")) ?? "");
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 invoiceId");
  const [inv] = await loadInvoices(session, [id]);
  const items = await invoiceItemsOf(session, inv);
  const prepared = items
    .filter((it) => it.totalPrice > 0 && remainingQty(it) > 0)
    .map((it) => ({ invoiceItemId: it.invoiceItemId, name: it.name, unitPrice: it.unitPrice, total: remainingQty(it), totalPrice: Math.round(it.unitPrice * remainingQty(it) * 100) / 100 }));
  const allowanced = items.flatMap((it) => (it.allowances ?? []).map((a) => ({ invoiceItemId: it.invoiceItemId, name: it.name, unitPrice: a.unitPrice, total: a.total, totalPrice: a.totalPrice })));
  // 原站 invoice.js：options.allowancedItems 有值才顯示「已折讓項目」區塊（空陣列也會顯示），沒有折讓時不回傳此鍵
  const options: Record<string, unknown> = allowanced.length ? { allowancedItems: allowanced } : {};
  return json({ code: 200, data: { ...invoiceApi(inv), preparedInvoiceItems: ALLOWANCABLE.includes(inv.invoice_status) ? prepared : [] }, options });
}

/** 折讓：data[invoiceItemId][total|unitPrice|totalPrice]、reason、recordOnly */
async function issueAllowance(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number((await ctx.param("invoiceId")) ?? "");
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 invoiceId");
  const reason = String((await ctx.param("reason")) ?? "").trim();
  if (!reason) throw badRequest("請填寫折讓原因");
  const recordOnly = ["true", "1", "on"].includes(String((await ctx.param("recordOnly")) ?? ""));
  const [inv] = await loadInvoices(session, [id]);
  if (!ALLOWANCABLE.includes(inv.invoice_status)) throw badRequest(`發票狀態為${await enumLabel(STATUS_ENUM, inv.invoice_status)}，無法折讓`);
  const items = (await invoiceItemsOf(session, inv)).map((it) => ({ ...it, allowances: [...(it.allowances ?? [])] }));
  const body = await ctx.body();
  const dataNode = body.nested.data;
  const lines: { it: InvoiceItem; total: number; unitPrice: number; totalPrice: number }[] = [];
  if (dataNode && typeof dataNode === "object" && !Array.isArray(dataNode)) {
    for (const [k, v] of Object.entries(dataNode)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const rec = v as Record<string, unknown>;
      const itemId = Number(rec.invoiceItemId ?? k);
      const it = items.find((x) => x.invoiceItemId === itemId);
      const total = Number(rec.total ?? 0);
      const totalPrice = Math.round(Number(rec.totalPrice ?? 0) * 100) / 100;
      const unitPrice = Math.round(Number(rec.unitPrice ?? 0) * 100) / 100;
      if (!it || !(total > 0) || !(totalPrice > 0)) continue;
      if (total > remainingQty(it)) throw badRequest(`「${it.name}」折讓數量超過可折讓數量 ${remainingQty(it)}`);
      if (totalPrice > Math.round(it.unitPrice * total * 100) / 100 + 0.001) throw badRequest(`「${it.name}」折讓金額超過原始金額`);
      lines.push({ it, total, unitPrice: unitPrice || Math.round((totalPrice / total) * 100) / 100, totalPrice });
    }
  }
  if (!lines.length) throw badRequest("請選擇至少一個折讓項目，且折讓金額必須大於零");
  const sum = Math.round(lines.reduce((a, b) => a + b.totalPrice, 0) * 100) / 100;
  const prev = Number(inv.allowance_amount ?? 0);
  if (prev + sum > Number(inv.amount) + 0.001) throw badRequest("折讓總額不可超過發票金額");
  const now = new Date().toISOString();
  const p = recordOnly ? null : await einvoiceProviderFor(session.tenantId, inv.group_buy_id);
  let allowanceNumber: string | null = null;
  if (p) {
    if (!inv.invoice_number) throw badRequest("發票尚未開立（沒有發票號碼），無法折讓");
    const { data: od } = inv.sales_order_id
      ? await getServiceClient().from("sales_orders").select("customer_firstname, customer_email").eq("tenant_id", session.tenantId).eq("id", inv.sales_order_id).maybeSingle<{ customer_firstname: string | null; customer_email: string | null }>()
      : { data: null };
    const r = await p.allowance({
      invoiceNumber: inv.invoice_number,
      invoiceDate: invoiceDateOf(inv),
      amount: sum,
      items: lines.map((l) => ({ name: l.it.name, count: l.total, unitPrice: l.unitPrice, amount: l.totalPrice })),
      reason,
      customerName: od?.customer_firstname ?? null,
      email: od?.customer_email ?? null,
    });
    if (!r.ok) {
      await getServiceClient().from("invoices").update({ error_message: `折讓失敗：${r.message}`.slice(0, 500) }).eq("tenant_id", session.tenantId).eq("id", inv.id);
      throw badRequest(`折讓失敗：${r.message}`);
    }
    allowanceNumber = r.allowanceNumber;
  }
  for (const l of lines) l.it.allowances!.push({ total: l.total, unitPrice: l.unitPrice, totalPrice: l.totalPrice, date: now, reason, allowanceNumber });
  const { error } = await getServiceClient()
    .from("invoices")
    .update({
      items,
      allowance_amount: prev + sum,
      allowance_reason: reason,
      date_allowance: now,
      invoice_status: recordOnly || allowanceNumber ? "ALLOWANCE_SENT" : "SEND_ALLOWANCE",
      ...(allowanceNumber ? { allowance_number: allowanceNumber, error_message: null } : {}),
    })
    .eq("tenant_id", session.tenantId)
    .eq("id", inv.id);
  if (error) throw new Error(`[accounting] ${error.message}`);
  const msg = recordOnly
    ? `折讓已記錄（NT$${money(sum)}，只記錄）`
    : allowanceNumber
      ? `折讓已開立 ${allowanceNumber}（NT$${money(sum)}）${envSuffix()}`
      : `已建立折讓紀錄 NT$${money(sum)}（狀態：開立折讓）<br>${notIntegrated("電子發票折讓").message}`;
  return actionOk(msg, { notIntegrated: !recordOnly && !allowanceNumber });
}

/** 訂單的發票（InvoiceManager getList） */
async function salesOrderInvoices(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number((await ctx.param("salesOrderId")) ?? "");
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  await findOrder(session, id);
  const rows = await fetchAll<InvRow>((from, to) =>
    getServiceClient().from("invoices").select(SELECT).eq("tenant_id", session.tenantId).eq("sales_order_id", id).order("id").range(from, to),
  );
  const data = rows.map((r) => {
    const api = invoiceApi(r);
    const allowances = (r.items ?? []).flatMap((it) => it.allowances ?? []);
    if (allowances.length) {
      api.allowances = allowances.map((a) => ({ amount: a.totalPrice, dateEinvoiceString: a.date.slice(0, 16).replace("T", " "), invoiceSettings: { remark: a.reason } }));
    } else if (Number(r.allowance_amount ?? 0) > 0) {
      api.allowances = [{ amount: Number(r.allowance_amount), dateEinvoiceString: api.dateAllowanceString ?? "", invoiceSettings: { remark: r.allowance_reason ?? "" } }];
    }
    return api;
  });
  return json({ code: 200, data });
}

async function previewInvoice(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const o = await findOrder(session, await ctx.param("salesOrderId"));
  const items = await orderInvoiceItems(session, o);
  return json({ code: 200, data: { items, totalAmount: Number(o.grand_total) } });
}

/* ───────────────────────── 彈窗（推導） ───────────────────────── */

/** 彈窗提示字：依各筆所屬團購是否啟用綠界電子發票（PARITY #99；取代寫死的「平台尚未串接」） */
async function noticeFor(tenantId: number, kind: EinvoiceNoticeKind, groupBuyIds: (number | null)[]) {
  const cache = new Map<number | null, boolean>();
  let enabled = 0;
  let disabled = 0;
  for (const g of groupBuyIds) {
    if (!cache.has(g)) cache.set(g, !!(await einvoiceProviderFor(tenantId, g)));
    if (cache.get(g)) enabled++;
    else disabled++;
  }
  return einvoiceNotice(kind, { enabled, disabled, sandbox: isSandbox() });
}

async function invalidFragmentData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const uuidParam = String(ctx.query.get("uuid") ?? "");
  const invoiceIds = parseIdList(ctx.query.get("invoiceId"));
  const uuids = uuidParam.split(/[,\s]+/).map((s) => s.split("#")[0].trim()).filter(Boolean);
  const db = getServiceClient();
  let rows: InvRow[] = [];
  if (invoiceIds.length) rows = await loadInvoices(session, invoiceIds);
  else if (uuids.length) {
    const { data: orders } = await db.from("sales_orders").select("id").eq("tenant_id", session.tenantId).in("uuid", uuids);
    const ids = ((orders ?? []) as { id: number }[]).map((o) => o.id);
    if (ids.length) {
      const { data } = await db.from("invoices").select(SELECT).eq("tenant_id", session.tenantId).in("sales_order_id", ids).order("id");
      rows = (data ?? []) as InvRow[];
    }
  }
  const labels = new Map((await enumOptions(STATUS_ENUM)).map((o) => [String(o.value), o.label]));
  const list = rows.map((r) => ({
    invoiceId: r.id,
    uuid: r.sales_orders?.uuid ?? r.merchant_order_id ?? "",
    merchantOrderId: r.merchant_order_id ?? "",
    invoiceNumber: r.invoice_number ?? "",
    amount: money(r.amount),
    statusLabel: labels.get(r.invoice_status) ?? r.invoice_status,
    voidable: VOIDABLE.includes(r.invoice_status) || SCHEDULED.includes(r.invoice_status),
  }));
  return {
    uuid: uuids.join(","),
    invoiceIdParam: invoiceIds.join(","),
    invoices: list,
    hasVoidable: list.some((x) => x.voidable),
    einvoiceNotice: await noticeFor(session.tenantId, "invalid", rows.map((r) => r.group_buy_id)),
  };
}

async function issueInvoiceFragmentData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const ids = parseIdList(ctx.query.get("salesOrderIds") ?? ctx.query.get("salesOrderId"));
  const db = getServiceClient();
  const orders = ids.length
    ? (((await db.from("sales_orders").select("id, uuid, group_buy_id, state, grand_total, billing_receipt_type, billing_receipt_vat_id").eq("tenant_id", session.tenantId).in("id", ids)).data ?? []) as {
        id: number;
        group_buy_id: number | null;
        uuid: string;
        state: string;
        grand_total: number;
        billing_receipt_type: number;
        billing_receipt_vat_id: string | null;
      }[])
    : [];
  const receipt: Record<number, string> = { 1: "一般發票", 2: "營業人發票", 3: "捐贈" };
  return {
    salesOrderIds: orders.map((o) => o.id).join(","),
    orders: orders.map((o) => ({ uuid: o.uuid, amount: money(o.grand_total), receipt: receipt[o.billing_receipt_type] ?? "", vat: o.billing_receipt_vat_id ?? "" })),
    einvoiceNotice: await noticeFor(session.tenantId, "issue", orders.map((o) => o.group_buy_id)),
  };
}

export const invoiceRoutes: RouteDef[] = [
  page("/backend/Invoice/list", {
    template: "accounting/invoice-list.html",
    title: "電子發票",
  }),
  any("/ajax/Invoice/list", listInvoices),
  ...crudRoutes(invoice, {
    save: "/ajax/Invoice/save",
    update: "/ajax/Invoice/update",
    delete: "/ajax/Invoice/delete",
    writeSpec: invoiceWrite,
  }),
  post("/ajax/Invoice/statusSend", statusSend),
  post("/ajax/Invoice/statusCancel", statusCancel),
  get("/ajax/Invoice/status", invoiceStatusSummary),
  post("/ajax/Invoice/issueInvoice", issueInvoice),
  post("/ajax/Invoice/issueInvalid", issueInvalid),
  post("/ajax/Invoice/issueAllowance", issueAllowance),
  get("/ajax/Invoice/get", getInvoice),
  get("/ajax/Invoice/salesOrder", salesOrderInvoices),
  get("/ajax/Invoice/previewInvoice", previewInvoice),
  modalFragment("/ajax/Invoice/displayIssueInvalid", { template: "accounting/modal-invoice-issueinvalid.html", method: "GET", data: invalidFragmentData }),
  modalFragment("/ajax/Invoice/displayAllowance", {
    template: "accounting/modal-invoice-issueallowance.html",
    method: "GET",
    data: async (ctx) => {
      const id = Number(ctx.query.get("invoiceId"));
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 invoiceId");
      const [inv] = await loadInvoices(ctx.session, [id]);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number ?? "",
        merchantOrderId: inv.merchant_order_id ?? "",
        amount: money(inv.amount),
        einvoiceNotice: await noticeFor(ctx.session.tenantId, "allowance", [inv.group_buy_id]),
      };
    },
  }),
  modalFragment("/ajax/Invoice/displayIssueInvoice", { template: "accounting/modal-invoice-issueinvoice.html", method: "GET", data: issueInvoiceFragmentData }),
  modalFragment("/ajax/Invoice/displaySalesOrderInvoices", {
    template: "accounting/modal-invoice-salesorder.html",
    method: "GET",
    data: async (ctx) => {
      const o = await findOrder(ctx.session, ctx.query.get("salesOrderId"));
      return { salesOrderId: o.id, uuid: o.uuid, einvoiceNotice: await noticeFor(ctx.session.tenantId, "salesOrder", [o.group_buy_id]) };
    },
  }),
];

/** 側欄「電子發票」紅色數字：發送失敗筆數 */
export async function failedInvoiceCount(session: AdminSession): Promise<number> {
  let q = getServiceClient()
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("invoice_status", "EINVOICE_FAILED");
  const allowed = await restrictedGroupBuyIds(session); // 團購受限帳戶：只算授權團購
  if (allowed) q = q.in("group_buy_id", allowed.length ? allowed : [-1]);
  const { count } = await q;
  return count ?? 0;
}

