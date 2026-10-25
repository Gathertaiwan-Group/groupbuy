// 所有訂單列表的查詢條件：DataTables legacy 參數＋頁面 #queryForm 篩選 → DB 函式 groupbuy.orders_search（migration 3001）。
// 也供匯出報表、批次更新貨運標籤共用（同一組篩選條件）。
import type { AdminSession } from "@/lib/core/http/types";
import type { DtRequest } from "@/lib/core/datatables/request";
import { db, taipeiDateStart, taipeiStartOfDay } from "./common";
import { b2sEligibleOrderIds } from "./b2s";

/** 表尾欄位搜尋：原站欄位 data 鍵 → orders_search 參數 */
const COLUMN_FILTER: Record<string, string> = {
  uuid: "f_uuid",
  dateExpectedShippingString: "f_date_expected_shipping",
  customerFirstname: "f_firstname",
  customerTelephone: "f_telephone",
  customerEmail: "f_email",
  state: "f_state",
  status: "f_status",
  paymentMethod: "f_payment_method",
  grandTotal: "f_grand_total",
  totalPaid: "f_total_paid",
  "salesOrderBillingAddress.bankAccount": "f_bank_account",
  virtualBankAccount: "f_virtual_bank_account",
  creditCardNumber: "f_credit_card_number",
  shippingTag: "f_shipping_tag",
  shippingType: "f_shipping_type",
  shippingProvider: "f_shipping_provider",
  shippingReceiptNumber: "f_shipping_receipt_number",
  invoiceNumber: "f_invoice_number",
  apiUserData: "f_api_user_data",
};

const truthy = (v: unknown) => {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "on";
};
const text = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s === "" || s === "null" || s === "undefined" ? null : s;
};
const intOrNull = (v: unknown) => {
  const s = text(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const numOrNull = (v: unknown) => {
  const s = text(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export interface SearchInput {
  /** 頁面額外參數（DataTables dt.extra，或匯出時 query JSON 物件） */
  extra: Record<string, unknown>;
  /** 表尾欄位搜尋：data 鍵 → 值 */
  columns: { data: string; search: string }[];
  /** 排序 */
  order: { data: string; dir: "asc" | "desc" }[];
  start: number;
  /** -1＝全部 */
  length: number;
  /** DataTables 全域搜尋（sSearch／search[value]）：訂單號碼、姓名、電話、Email 部分符合 */
  search?: string;
}

export function searchInputFromDt(dt: DtRequest): SearchInput {
  return {
    extra: dt.extra,
    columns: dt.columns.map((c) => ({ data: c.data, search: c.search })),
    order: dt.order.map((o) => ({ data: o.data, dir: o.dir })),
    start: dt.start,
    length: dt.length,
    search: dt.search,
  };
}

/** 匯出時 #queryForm 的 query（JSON 字串，內容為 DataTables legacy 參數＋篩選）→ SearchInput */
export function searchInputFromLegacyJson(q: Record<string, unknown>): SearchInput {
  const n = Number(q.iColumns ?? 0) || 0;
  const columns: { data: string; search: string }[] = [];
  for (let i = 0; i < n; i++) columns.push({ data: String(q[`mDataProp_${i}`] ?? ""), search: String(q[`sSearch_${i}`] ?? "") });
  const order: { data: string; dir: "asc" | "desc" }[] = [];
  const sortCount = Number(q.iSortingCols ?? 0) || 0;
  for (let k = 0; k < sortCount; k++) {
    const col = Number(q[`iSortCol_${k}`]);
    if (Number.isInteger(col) && columns[col]) order.push({ data: columns[col].data, dir: q[`sSortDir_${k}`] === "asc" ? "asc" : "desc" });
  }
  return { extra: q, columns, order, start: Number(q.iDisplayStart ?? 0) || 0, length: Number(q.iDisplayLength ?? -1), search: String(q.sSearch ?? "") };
}

/** SearchInput → orders_search 的 p（jsonb） */
export async function buildSearchParams(session: AdminSession, input: SearchInput): Promise<Record<string, unknown>> {
  const x = input.extra;
  const p: Record<string, unknown> = {};
  const groupBuyId = intOrNull(x.groupBuyId);
  if (groupBuyId && groupBuyId > 0) p.group_buy_id = groupBuyId;
  const customerId = intOrNull(x.customerId);
  if (customerId && customerId > 0) p.customer_id = customerId;
  const salesOrderId = intOrNull(x.salesOrderId);
  if (salesOrderId && salesOrderId > 0) p.sales_order_id = salesOrderId;

  for (const [param, key] of [
    ["checkOversea", "check_oversea"],
    ["checkIsland", "check_island"],
    ["checkNote", "check_note"],
    ["checkStaffNote", "check_staff_note"],
    ["checkDuplicate", "check_duplicate"],
    ["checkPaymentDued", "check_payment_dued"],
    ["unprocessed", "unprocessed"],
    ["unshipped", "unshipped"],
    ["checkReceiptVatId", "check_receipt_vat_id"],
    ["checkPaymentIncorrect", "check_payment_incorrect"],
  ] as const) {
    if (truthy(x[param])) p[key] = true;
  }
  const daysBefore = intOrNull(x.daysBeforePaymentDue);
  if (daysBefore !== null && daysBefore >= 0) p.days_before_payment_due = daysBefore;
  const backOrder = intOrNull(x.backOrder);
  if (backOrder !== null && backOrder !== -1) p.back_order = backOrder;
  const payStatus = intOrNull(x.payStatus);
  if (payStatus) p.pay_status = payStatus;
  const gtGreater = numOrNull(x.grandTotalGreater);
  if (gtGreater !== null) p.grand_total_greater = gtGreater;
  const gtLess = numOrNull(x.grandTotalLess);
  if (gtLess !== null) p.grand_total_less = gtLess;
  for (const [param, key] of [
    ["itemTitle", "item_title"],
    ["excludedItemTitle", "excluded_item_title"],
    ["itemUid", "item_uid"],
    ["excludedItemUid", "excluded_item_uid"],
    ["couponCode", "coupon_code"],
  ] as const) {
    const v = text(x[param]);
    if (v) p[key] = v;
  }
  const exmatch = truthy(x.exmatch);
  if (exmatch) p.exmatch = true;

  // 批量訂單號（逗號／換行）
  const uuids = String(x.uuids ?? "")
    .split(/[\s,，、]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (uuids.length) p.uuids = uuids;

  // 全域搜尋（sSearch）：先以 PostgREST 找出本租戶符合的訂單號碼，再交給 orders_search 的 uuids 條件（與其他篩選取交集）。
  // 只保留安全字元（避免 or() 篩選語法注入）；最多取 1000 筆，沒有符合時給不存在的號碼讓結果為空。
  const keyword = String(input.search ?? "").replace(/[^\p{L}\p{N}@._+\- ]/gu, "").trim().slice(0, 50);
  if (keyword) {
    const like = `*${keyword}*`;
    let q = db()
      .from("sales_orders")
      .select("uuid")
      .eq("tenant_id", session.tenantId)
      .or(`uuid.ilike.${like},customer_firstname.ilike.${like},customer_telephone.ilike.${like},customer_email.ilike.${like}`)
      .limit(1000);
    if (p.group_buy_id) q = q.eq("group_buy_id", p.group_buy_id as number);
    const { data, error } = await q;
    if (error) throw new Error(`[orders] 全域搜尋失敗：${error.message}`);
    let found = ((data ?? []) as { uuid: string }[]).map((r) => r.uuid);
    if (Array.isArray(p.uuids)) found = found.filter((u) => (p.uuids as string[]).includes(u));
    p.uuids = found.length ? found : ["__no_match__"];
  }

  // 表尾欄位搜尋
  let identityFilter = false;
  for (const c of input.columns) {
    const key = COLUMN_FILTER[c.data];
    const v = text(c.search);
    if (!key || v === null) continue;
    if (key === "f_payment_method") p[key] = intOrNull(v);
    else if (key === "f_grand_total" || key === "f_total_paid") p[key] = numOrNull(v);
    else p[key] = v;
    if (["f_uuid", "f_firstname", "f_telephone", "f_email"].includes(key)) identityFilter = true;
  }

  // 其他頁共用本端點時的額外條件（例：金流對帳頁）
  const csv = (v: unknown) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (text(x.stateIn)) p.state_in = csv(x.stateIn);
  if (text(x.statusIn)) p.status_in = csv(x.statusIn);
  if (text(x.paymentMethodIn)) p.payment_method_in = csv(x.paymentMethodIn).map(Number).filter((n) => Number.isFinite(n));

  // 建立日期：完整符合（訂單號碼/姓名/電話/email）、批量訂單號、指定顧客/訂單時不限時間
  const anyTime = (exmatch && identityFilter) || uuids.length > 0 || !!p.customer_id || !!p.sales_order_id;
  if (!anyTime) {
    const month = intOrNull(x.month);
    if (month === -1) {
      const b = taipeiDateStart(String(x.dateCreatedBegin ?? ""));
      const e = taipeiDateStart(String(x.dateCreatedEnd ?? ""));
      if (b) p.created_from = b.toISOString();
      if (e) p.created_to = new Date(e.getTime() + 86400_000).toISOString();
    } else if (month && month > 0) {
      const d = new Date();
      d.setMonth(d.getMonth() - month);
      p.created_from = d.toISOString();
    }
  }
  // 修改日期
  const mr = intOrNull(x.dateModifiedRange);
  if (mr === 0) p.modified_from = taipeiStartOfDay().toISOString();
  else if (mr === 7 || mr === 30) p.modified_from = new Date(Date.now() - mr * 86400_000).toISOString();
  else if (mr === -1) {
    const b = taipeiDateStart(String(x.dateModifiedBegin ?? ""));
    const e = taipeiDateStart(String(x.dateModifiedEnd ?? ""));
    if (b) p.modified_from = b.toISOString();
    if (e) p.modified_to = new Date(e.getTime() + 86400_000).toISOString();
  }
  // 出貨日期
  const sr = intOrNull(x.dateShippedRange);
  if (sr === 0) p.shipped_from = taipeiStartOfDay().toISOString();
  else if (sr === 1) {
    p.shipped_from = taipeiStartOfDay(new Date(), -1).toISOString();
    p.shipped_to = taipeiStartOfDay().toISOString();
  } else if (sr === -1) {
    const b = taipeiDateStart(String(x.dateShippedBegin ?? ""));
    const e = taipeiDateStart(String(x.dateShippedEnd ?? ""));
    if (b) p.shipped_from = b.toISOString();
    if (e) p.shipped_to = new Date(e.getTime() + 86400_000).toISOString();
  }

  // 可預購轉現貨
  if (truthy(x.b2s)) p.b2s_ids = await b2sEligibleOrderIds(session, (p.group_buy_id as number) ?? null);

  // 排序／分頁
  const o = input.order[0];
  p.sort = o?.data || "uuid";
  p.dir = o?.dir ?? "desc";
  p.offset = Math.max(0, input.start || 0);
  p.limit = input.length === -1 ? -1 : Math.min(Math.max(input.length || 10, 1), 4000);
  return p;
}

/** 執行查詢：回傳該頁訂單 id（依排序）與符合筆數 */
export async function searchOrders(session: AdminSession, p: Record<string, unknown>): Promise<{ ids: number[]; total: number }> {
  const { data, error } = await db().rpc("orders_search", { p_tenant_id: session.tenantId, p });
  if (error) throw new Error(`[orders] 查詢訂單失敗：${error.message}`);
  const rows = (data ?? []) as { rn: number; id: number | null; filtered_count: number | null }[];
  const head = rows.find((r) => Number(r.rn) === 0);
  const ids = rows
    .filter((r) => Number(r.rn) > 0 && r.id != null)
    .sort((a, b) => Number(a.rn) - Number(b.rn))
    .map((r) => Number(r.id));
  return { ids, total: Number(head?.filtered_count ?? 0) };
}

/** 本租戶（可限定團購）的訂單總數（DataTables recordsTotal） */
export async function countAllOrders(session: AdminSession, groupBuyId?: number | null): Promise<number> {
  const p: Record<string, unknown> = { limit: 0 };
  if (groupBuyId) p.group_buy_id = groupBuyId;
  return (await searchOrders(session, p)).total;
}
