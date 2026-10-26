// 訂單 DB 列 → 原站 JSON（/ajax/SalesOrder/list、get、Editor 回應共用）。
// 列欄位以 salesOrder 實體（lib/db/entities/salesOrder.ts）對映，再補上原站前端 salesOrderList.min.js 會讀的推導鍵：
//   paymentDued、cvspickUp、customerIsGuest、customerFacebook、groupbuyTitle、shortUrl、parentUuid、shippingAddress、
//   sortedOrderItems[]、salesOrderCoupons[]、pointTransactions[]、apidata(物件)、log（原始紀錄＋狀態歷程）、xxx（金流對帳頁操作欄）
import { entities } from "@/lib/db/entities";
import { formatDate, rowToApi, type Row } from "@/lib/db/mapping";
import { taipeiDateTime } from "@/lib/core/time";
import type { AdminSession } from "@/lib/core/http/types";
import { db } from "./common";

/** 列表/明細用的 PostgREST select（含關聯） */
export const ORDER_SELECT = [
  "*",
  "group_buys(title,short_url,render)",
  "order_items(*)",
  "sales_order_coupons(*)",
  "point_transactions(reason,points)",
  "sales_order_histories(*)",
  "rel_as_child:sales_order_relations!sales_order_id(relation,parent_sales_order_id,parent:sales_orders!parent_sales_order_id(uuid))",
].join(",");

type HistoryRow = {
  created_at: string;
  state_from: string | null;
  state_to: string | null;
  status_from: string | null;
  status_to: string | null;
  action: string | null;
  actor: string | null;
  admin_user_id: number | null;
  note: string | null;
};

export interface OrderApiContext {
  /** 代碼 → 中文（state/status/action），用來把歷程寫成可讀文字 */
  labels?: { state: Map<string, string>; status: Map<string, string>; action: Map<string, string> };
  /** customer_id → facebook {name, pictureUrl} */
  facebook?: Map<number, { name: string | null; pictureUrl: string | null }>;
  /** admin_user_id → 帳號 */
  admins?: Map<number, string>;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** 收件地址組字串：郵遞區號＋城市＋區＋地址（超商取貨時為門市） */
export function shippingAddressOf(row: Row): string {
  if (row.shipping_type === "CVS" && (row.cvs_store_name || row.cvs_address)) {
    return [row.cvs_store_name ? `[${row.cvs_store_name}]` : "", row.cvs_address ?? ""].filter(Boolean).join(" ");
  }
  return [row.shipping_postcode, row.shipping_city, row.shipping_district, row.shipping_street]
    .map((x) => (x == null ? "" : String(x).trim()))
    .join("")
    .trim();
}

export function isPaymentDued(row: Row, now = Date.now()): boolean {
  return (
    (row.state === "NEW" || row.state === "PROCESSING") &&
    num(row.total_paid) === 0 &&
    !!row.date_payment_due &&
    new Date(String(row.date_payment_due)).getTime() < now
  );
}

/** 歷程 → 「YYYY-MM-DD HH:mm:ss [操作者] 階段 A→B，狀態 C→D：備註」 */
export function formatHistoryLine(h: HistoryRow, ctx: OrderApiContext): string {
  const L = ctx.labels;
  const lab = (m: Map<string, string> | undefined, c: string | null) => (c ? m?.get(c) ?? c : "");
  const who =
    h.actor === "ADMIN"
      ? `[${h.admin_user_id ? ctx.admins?.get(h.admin_user_id) ?? `管理員#${h.admin_user_id}` : "管理員"}]`
      : h.actor === "CUSTOMER"
        ? "[顧客]"
        : "[系統]";
  const parts: string[] = [];
  if (h.state_to && h.state_from !== h.state_to) {
    parts.push(h.state_from ? `階段 ${lab(L?.state, h.state_from)}→${lab(L?.state, h.state_to)}` : `階段 ${lab(L?.state, h.state_to)}`);
  }
  if (h.status_to && h.status_from !== h.status_to) {
    parts.push(h.status_from ? `狀態 ${lab(L?.status, h.status_from)}→${lab(L?.status, h.status_to)}` : `狀態 ${lab(L?.status, h.status_to)}`);
  }
  if (h.action && h.action !== "NONE") parts.push(`進階操作 ${lab(L?.action, h.action)}`);
  const text = [parts.join("，"), h.note ?? ""].filter(Boolean).join("：");
  return `${taipeiDateTime(h.created_at, true)} ${who} ${text}`.trim();
}

/** 訂單商品（已依 seq、id 排序）→ 原站 sortedOrderItems[] */
export function orderItemsApi(items: Row[] | null | undefined): Row[] {
  const list = [...(items ?? [])].sort((a, b) => num(a.seq) - num(b.seq) || num(a.id) - num(b.id));
  return list.map((it) => {
    const api = rowToApi(entities.orderItem, it);
    api.note = it.attribute_note ?? null; // 原站列明細卡讀 orderItem.note（使用備註）
    return api;
  });
}

/** DB 列（ORDER_SELECT）→ 原站訂單 JSON */
export function toOrderApi(row: Row, ctx: OrderApiContext = {}): Row {
  const api = rowToApi(entities.salesOrder, row);
  const gb = (row.group_buys ?? null) as { title?: string; short_url?: string; render?: string } | null;

  // 推導鍵
  api.paymentDued = isPaymentDued(row);
  api.cvspickUp = row.shipping_type === "CVS" && Number(row.payment_method) === 64;
  api.customerIsGuest = row.customer_id == null;
  api.customerFacebook = row.customer_id != null ? ctx.facebook?.get(Number(row.customer_id)) ?? null : null;
  api.groupbuyTitle = gb?.title ?? "";
  api.shortUrl = gb?.short_url ?? "";
  // 本系統補充（fix3）：POS 團購的訂單（後台「刪除」時提示改用「POS 作廢」）
  api.posOrder = gb?.render === "POS";
  api.shippingAddress = shippingAddressOf(row);
  const rels = (row.rel_as_child ?? []) as { relation: string; parent?: { uuid?: string } | null }[];
  const parentRel = rels.find((r) => r.relation === "PARENT" || r.relation === "SPLIT");
  api.parentUuid = parentRel?.parent?.uuid ?? "";
  api.xxx = "";

  // 訂購人/收件人補鍵（前端列明細卡讀取）
  const billing = (api.salesOrderBillingAddress ?? {}) as Row;
  billing.firstname = row.customer_firstname ?? "";
  billing.email = row.customer_email ?? "";
  billing.telephone = row.customer_telephone ?? "";
  billing.birthdayString = row.billing_birthday ? formatDate(row.billing_birthday) : "";
  api.salesOrderBillingAddress = billing;
  const shipping = (api.salesOrderShippingAddress ?? {}) as Row;
  shipping.dateExpectedShipping = row.date_expected_shipping ? formatDate(row.date_expected_shipping) : "";
  api.salesOrderShippingAddress = shipping;
  api.dateExpectedShippingString = row.date_expected_shipping ? formatDate(row.date_expected_shipping) : "";

  // 關聯
  api.sortedOrderItems = orderItemsApi(row.order_items as Row[] | undefined);
  api.salesOrderCoupons = ((row.sales_order_coupons ?? []) as Row[]).map((c) => rowToApi(entities.salesOrderCoupon, c));
  api.pointTransactions = ((row.point_transactions ?? []) as Row[]).map((p) => ({ reason: p.reason, points: p.points }));

  // 第三方原始資料：JSON 字串轉物件（列明細卡讀 apidata.password / ecpayCvsMap）
  if (typeof row.apidata === "string" && row.apidata.trim().startsWith("{")) {
    try {
      api.apidata = JSON.parse(row.apidata);
    } catch {
      api.apidata = row.apidata;
    }
  }

  // 訂單操作紀錄：原始 log ＋ 狀態歷程（觸發器 sales_order_histories）
  const hist = [...((row.sales_order_histories ?? []) as HistoryRow[])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const lines = hist.map((h) => formatHistoryLine(h, ctx));
  const baseLog = row.log ? String(row.log).trim() : "";
  api.log = [baseLog, ...lines].filter(Boolean).join("\n");
  api.histories = hist.map((h) => ({
    dateCreatedString: taipeiDateTime(h.created_at, true),
    stateFrom: h.state_from,
    stateTo: h.state_to,
    statusFrom: h.status_from,
    statusTo: h.status_to,
    action: h.action,
    actor: h.actor,
    adminUserId: h.admin_user_id,
    note: h.note,
  }));

  // DataTables 欄位不可為 undefined
  for (const k of ["dateLastSms", "shippingReceiptNumber", "invoiceNumber", "apiUserData", "virtualBankAccount", "creditCardNumber", "note", "staffNote", "blacklistNote", "customerIp"]) {
    if (api[k] === undefined) api[k] = null;
  }
  return api;
}

/** 一批訂單的對映輔助資料（facebook、管理員帳號、列舉標籤） */
export async function loadOrderApiContext(session: AdminSession, rows: Row[]): Promise<OrderApiContext> {
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((x) => x != null).map(Number))];
  const adminIds = [
    ...new Set(
      rows.flatMap((r) => ((r.sales_order_histories ?? []) as HistoryRow[]).map((h) => h.admin_user_id)).filter((x): x is number => x != null),
    ),
  ];
  const facebook = new Map<number, { name: string | null; pictureUrl: string | null }>();
  const admins = new Map<number, string>();
  const client = db();
  if (customerIds.length) {
    const { data } = await client
      .from("facebook_auths")
      .select("customer_id,name,picture_url")
      .eq("tenant_id", session.tenantId)
      .in("customer_id", customerIds);
    for (const f of (data ?? []) as { customer_id: number; name: string | null; picture_url: string | null }[]) {
      if (!facebook.has(f.customer_id)) facebook.set(f.customer_id, { name: f.name, pictureUrl: f.picture_url });
    }
  }
  if (adminIds.length) {
    const { data } = await client.from("admin_users").select("id,account").eq("tenant_id", session.tenantId).in("id", adminIds);
    for (const a of (data ?? []) as { id: number; account: string }[]) admins.set(a.id, a.account);
  }
  const { enumOptions } = await import("@/lib/core/enums");
  const toMap = (opts: { label: string; value: string | number }[]) => new Map(opts.map((o) => [String(o.value), o.label]));
  const labels = {
    state: toMap(await enumOptions("SalesOrder.state")),
    status: toMap(await enumOptions("SalesOrder.status")),
    action: toMap(await enumOptions("SalesOrder.action")),
  };
  return { facebook, admins, labels };
}

/** 依 id 讀取訂單並轉成原站 JSON（保持 ids 順序） */
export async function loadOrdersApi(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await db().from("sales_orders").select(ORDER_SELECT).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[orders] 讀取訂單失敗：${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  const ctx = await loadOrderApiContext(session, rows);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.filter((id) => byId.has(id)).map((id) => toOrderApi(byId.get(id)!, ctx));
}
