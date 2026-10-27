// 訂單操作的商業邏輯（所有訂單頁的編輯副作用、批次操作共用）。
// 狀態一律經 adminUpdateOrders（觸發器寫歷程）；寄信/簡訊不串接，只寫紀錄＋【未串接】提示；庫存經 adjustItemStock。
import type { AdminSession } from "@/lib/core/http/types";
import { notIntegrated } from "@/lib/core/http/errors";
import type { Row } from "@/lib/db/mapping";
import { taipeiDateTime } from "@/lib/core/time";
import { addOrderHistory, adjustItemStock, adminUpdateOrders, db, fetchOrder, fetchOrders, recordEmail, recordSms } from "./common";
import { recalcOrderAmounts } from "./pricing";
import { stockChangesOf } from "./stock-rules";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const money = (v: unknown) => Math.round(num(v));

/* ─────────────────────────── 庫存 ─────────────────────────── */

type ItemRow = { id: number; sales_order_id: number; item_id: number | null; total: number; back_order: boolean; state: string };

async function orderItemsOf(session: AdminSession, orderIds: number[]): Promise<ItemRow[]> {
  if (!orderIds.length) return [];
  const { data, error } = await db()
    .from("order_items")
    .select("id,sales_order_id,item_id,total,back_order,state")
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", orderIds);
  if (error) throw new Error(`[orders] 讀取訂單商品失敗：${error.message}`);
  return (data ?? []) as ItemRow[];
}

/** 已不占庫存的階段（取消/刪除/已合併/已拆單：商品已移到其他訂單或已釋出） */
const RELEASED_STATES = new Set(["CANCELED", "DELETED", "COMBINED", "SPLITED"]);

/** 釋出訂單占用的庫存（取消、刪除）：未出貨的商品數量補回現貨/預購可售數量 */
export async function releaseOrderStock(session: AdminSession, orderIds: number[]): Promise<void> {
  await releaseOrderStockUndoable(session, orderIds);
}

type StockChange = { itemId: number | null; qty: number; backOrder: boolean };
const reverse = (changes: StockChange[]): StockChange[] => changes.map((c) => ({ ...c, qty: -c.qty }));

/** 同 releaseOrderStock，另回傳 undo（後續步驟失敗時把補回的庫存再扣回） */
export async function releaseOrderStockUndoable(session: AdminSession, orderIds: number[]): Promise<{ undo: () => Promise<void> }> {
  const orders = await fetchOrders(session, orderIds, "id,state");
  const target = orders.filter((o) => !RELEASED_STATES.has(String(o.state))).map((o) => Number(o.id));
  // 補回與扣回（consumeOrderStockUndoable）用同一組明細狀態（stock-rules.ts，fix10）
  const changes: StockChange[] = stockChangesOf(await orderItemsOf(session, target), 1);
  await adjustItemStock(session, changes);
  return { undo: () => adjustItemStock(session, reverse(changes)) };
}

/** 重新占用庫存（還原已取消訂單）；庫存不足時回傳不足的商品名稱（不扣） */
export async function consumeOrderStock(session: AdminSession, orderIds: number[]): Promise<string[]> {
  return (await consumeOrderStockUndoable(session, orderIds)).short;
}

/** 同 consumeOrderStock，另回傳 undo（後續步驟失敗時把扣掉的庫存補回；不足時沒有扣，undo 為空操作） */
export async function consumeOrderStockUndoable(session: AdminSession, orderIds: number[]): Promise<{ short: string[]; undo: () => Promise<void> }> {
  const noop = { short: [] as string[], undo: async () => {} };
  // 與補回（releaseOrderStockUndoable）同一組明細狀態：未出貨＋準備出貨中（stock-rules.ts，fix10）
  const need = new Map(stockChangesOf(await orderItemsOf(session, orderIds), 1).map((c) => [`${c.itemId}:${c.backOrder ? 1 : 0}`, c]));
  if (!need.size) return noop;
  const itemIds = [...new Set([...need.values()].map((n) => n.itemId))];
  const { data } = await db()
    .from("items")
    .select("id,title,stock_available,stock_back_order_available,share_stock,parent_item_id")
    .eq("tenant_id", session.tenantId)
    .in("id", itemIds);
  const rows = (data ?? []) as { id: number; title: string; stock_available: number; stock_back_order_available: number; share_stock: boolean; parent_item_id: number | null }[];
  const parentIds = rows.filter((r) => r.share_stock && r.parent_item_id).map((r) => r.parent_item_id as number);
  const parents = new Map<number, { stock_available: number; stock_back_order_available: number }>();
  if (parentIds.length) {
    const { data: pd } = await db().from("items").select("id,stock_available,stock_back_order_available").eq("tenant_id", session.tenantId).in("id", parentIds);
    for (const p of (pd ?? []) as { id: number; stock_available: number; stock_back_order_available: number }[]) parents.set(p.id, p);
  }
  const short: string[] = [];
  for (const n of need.values()) {
    const r = rows.find((x) => x.id === n.itemId);
    if (!r) continue;
    const src = r.share_stock && r.parent_item_id ? parents.get(r.parent_item_id) ?? r : r;
    const avail = n.backOrder ? num(src.stock_back_order_available) : num(src.stock_available);
    if (avail < n.qty) short.push(`${r.title}（需要 ${n.qty}，${n.backOrder ? "預購" : "現貨"}剩 ${avail}）`);
  }
  if (short.length) return { short, undo: noop.undo };
  const changes: StockChange[] = [...need.values()].map((n) => ({ itemId: n.itemId, qty: -n.qty, backOrder: n.backOrder }));
  await adjustItemStock(session, changes);
  return { short: [], undo: () => adjustItemStock(session, reverse(changes)) };
}

/* ─────────────────────────── 貨運標籤 ─────────────────────────── */

/** 依訂單商品的貨運標籤重算訂單 shipping_tag（多個標籤以 # 串接，例「冷凍#常溫」） */
export async function recomputeShippingTags(session: AdminSession, orderIds: number[]): Promise<number> {
  if (!orderIds.length) return 0;
  const client = db();
  const { data } = await client
    .from("order_items")
    .select("sales_order_id,item_id,shipping_tag")
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", orderIds);
  const items = (data ?? []) as { sales_order_id: number; item_id: number | null; shipping_tag: string | null }[];
  const itemIds = [...new Set(items.map((i) => i.item_id).filter((x): x is number => !!x))];
  const itemTags = new Map<number, string>();
  if (itemIds.length) {
    const { data: rows } = await client.from("items").select("id,shipping_tag").eq("tenant_id", session.tenantId).in("id", itemIds);
    for (const r of (rows ?? []) as { id: number; shipping_tag: string | null }[]) itemTags.set(r.id, (r.shipping_tag ?? "").trim());
  }
  const byOrder = new Map<number, Set<string>>();
  for (const i of items) {
    const tag = (i.item_id ? itemTags.get(i.item_id) : undefined) ?? (i.shipping_tag ?? "").trim();
    const set = byOrder.get(i.sales_order_id) ?? new Set<string>();
    if (tag) set.add(tag);
    byOrder.set(i.sales_order_id, set);
  }
  const orders = await fetchOrders(session, orderIds, "id,shipping_tag");
  let changed = 0;
  for (const o of orders) {
    const tag = [...(byOrder.get(Number(o.id)) ?? new Set<string>())].join("#");
    if ((o.shipping_tag ?? "") !== tag) {
      await adminUpdateOrders(session, [Number(o.id)], { shipping_tag: tag });
      changed++;
    }
  }
  return changed;
}

/* ─────────────────────────── Email 樣板 ─────────────────────────── */

export const EMAIL_TEMPLATES: Record<string, string> = {
  CUSTOM: "其他自訂義",
  ORDER_CONFIRMED: "訂單確認",
  ORDER_UPDATED: "訂單更新",
  ORDER_CANCELLED: "訂單取消",
  PAYMENT_RECEIVED: "已付款通知",
  PAYMENT_REMINDER: "未付款提醒",
  PAYMENT_EXTENSION: "繳款展延",
  REFUND_NOTICE: "退款通知",
  SHIPMENT_NOTICE: "已出貨通知",
  PICKUP_AVAILABLE: "可自取通知",
  CVS_SHIPMENT_NOTICE: "超取已出貨通知",
  CVS_DELIVERY_ARRIVED: "超取已配達通知",
  PROMO_CODE_SENT: "優惠碼發送通知",
};

/** 依樣板產生信件標題／內容（HTML）。原站樣板內容未擷取，依樣板名稱與訂單欄位推導。 */
export async function emailTemplateContent(session: AdminSession, salesOrderId: number, template: string): Promise<{ subject: string; body: string }> {
  const o = await fetchOrder(session, salesOrderId, "*, group_buys(title,short_url)");
  const gb = (o.group_buys ?? {}) as { title?: string; short_url?: string };
  const name = String(o.customer_firstname ?? "");
  const title = gb.title ?? "";
  const uuid = String(o.uuid ?? "");
  const total = money(o.grand_total);
  const due = o.date_payment_due ? taipeiDateTime(o.date_payment_due) : "";
  const greet = `<p>${escHtml(name)} 您好：</p>`;
  const sign = `<p>${escHtml(title)} 敬上</p>`;
  const info = `<p>訂單編號：${escHtml(uuid)}<br>訂單金額：$${total}</p>`;
  const map: Record<string, { subject: string; body: string }> = {
    CUSTOM: { subject: `【${title}】訂單 ${uuid} 通知`, body: `${greet}<p></p>${info}${sign}` },
    ORDER_CONFIRMED: { subject: `【${title}】訂單確認 ${uuid}`, body: `${greet}<p>感謝您的訂購，我們已收到您的訂單。</p>${info}${sign}` },
    ORDER_UPDATED: { subject: `【${title}】訂單內容更新 ${uuid}`, body: `${greet}<p>您的訂單內容已更新，請至訂單頁面確認。</p>${info}${sign}` },
    ORDER_CANCELLED: { subject: `【${title}】訂單取消通知 ${uuid}`, body: `${greet}<p>您的訂單已取消。</p>${info}${sign}` },
    PAYMENT_RECEIVED: { subject: `【${title}】已收到您的付款 ${uuid}`, body: `${greet}<p>我們已收到您的付款 $${money(o.total_paid)}，將儘快為您安排出貨。</p>${info}${sign}` },
    PAYMENT_REMINDER: { subject: `【${title}】未付款提醒 ${uuid}`, body: `${greet}<p>您的訂單尚未完成付款${due ? `，繳款期限為 ${due}` : ""}，請儘快完成付款。</p>${info}${sign}` },
    PAYMENT_EXTENSION: { subject: `【${title}】繳款期限展延通知 ${uuid}`, body: `${greet}<p>您的訂單繳款期限已展延${due ? `至 ${due}` : ""}，請於期限內完成付款。</p>${info}${sign}` },
    REFUND_NOTICE: { subject: `【${title}】退款通知 ${uuid}`, body: `${greet}<p>您的訂單退款已處理，款項將依原付款方式退回。</p>${info}${sign}` },
    SHIPMENT_NOTICE: { subject: `【${title}】已出貨通知 ${uuid}`, body: `${greet}<p>您的訂單已出貨${o.shipping_receipt_number ? `，查貨號碼：${escHtml(o.shipping_receipt_number)}` : ""}。</p>${info}${sign}` },
    PICKUP_AVAILABLE: { subject: `【${title}】商品可自取通知 ${uuid}`, body: `${greet}<p>您的商品已可自取，請於營業時間前往取貨。</p>${info}${sign}` },
    CVS_SHIPMENT_NOTICE: { subject: `【${title}】超商取貨已出貨 ${uuid}`, body: `${greet}<p>您的訂單已寄出至超商門市${o.cvs_store_name ? `「${escHtml(o.cvs_store_name)}」` : ""}，到店後將另行通知。</p>${info}${sign}` },
    CVS_DELIVERY_ARRIVED: { subject: `【${title}】超商取貨已配達 ${uuid}`, body: `${greet}<p>您的商品已送達超商門市${o.cvs_store_name ? `「${escHtml(o.cvs_store_name)}」` : ""}，請於 7 天內取貨。</p>${info}${sign}` },
    PROMO_CODE_SENT: { subject: `【${title}】優惠碼通知`, body: `${greet}<p>感謝您的支持，送上專屬優惠碼：<strong></strong></p>${sign}` },
  };
  return map[template] ?? map.CUSTOM;
}

function escHtml(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ─────────────────────────── 進階操作 action ─────────────────────────── */

const ACTION_EMAIL: Record<string, string> = {
  SEND_PAYMENT_DUE_EXTENSION_EMAIL: "PAYMENT_EXTENSION",
  SEND_UNPAID_EMAIL: "PAYMENT_REMINDER",
  SEND_ORDER_UPDATED_EMAIL: "ORDER_UPDATED",
  SEND_CUSTOM_EMAIL: "CUSTOM",
};
const ACTION_SMS: Record<string, (o: Row) => string> = {
  SEND_UNPAID_SMS: (o) => `您的訂單${o.uuid}尚未付款，請儘速完成付款。`,
  SEND_SHIPPED_SMS: (o) => `您的訂單${o.uuid}已出貨${o.shipping_receipt_number ? `，查貨號碼${o.shipping_receipt_number}` : ""}。`,
  SEND_PREPARE_SHIPPING_SMS: (o) => `您的訂單${o.uuid}準備出貨中。`,
  SEND_READY_PICKUP_SMS: (o) => `您的訂單${o.uuid}商品已可自取。`,
};
const ACTION_LABEL: Record<string, string> = {
  SEND_PAYMENT_DUE_EXTENSION_EMAIL: "寄送繳款期限展延通知信",
  SEND_UNPAID_EMAIL: "寄送未付款提醒信",
  SEND_ORDER_UPDATED_EMAIL: "寄送訂單內容更新通知信",
  SEND_CUSTOM_EMAIL: "寄送自定義信",
  SEND_UNPAID_SMS: "寄送未付款簡訊",
  SEND_SHIPPED_SMS: "寄送出貨簡訊",
  SEND_PREPARE_SHIPPING_SMS: "寄送準備出貨中簡訊",
  SEND_READY_PICKUP_SMS: "寄送可自取通知簡訊",
};

/** 執行「進階操作」：寫寄信/簡訊紀錄（未串接），歷程記 action，完成後 action 回到 NONE。回傳提示訊息。 */
export async function performOrderAction(session: AdminSession, salesOrderId: number, action: string): Promise<string | null> {
  if (!action || action === "NONE") return null;
  const o = await fetchOrder(session, salesOrderId);
  let msg: string;
  if (ACTION_EMAIL[action]) {
    const tpl = ACTION_EMAIL[action];
    const c = await emailTemplateContent(session, salesOrderId, tpl);
    msg = await recordEmail(session, {
      salesOrderId,
      groupBuyId: (o.group_buy_id as number) ?? null,
      template: tpl,
      toEmail: String(o.customer_email ?? ""),
      subject: c.subject,
      body: c.body,
    });
  } else if (ACTION_SMS[action]) {
    msg = await recordSms(session, {
      salesOrderId,
      groupBuyId: (o.group_buy_id as number) ?? null,
      telephone: String(o.customer_telephone ?? ""),
      content: ACTION_SMS[action](o),
    });
  } else {
    return null;
  }
  const patch: Row = { action };
  if (ACTION_SMS[action]) patch.date_last_sms = new Date().toISOString();
  await adminUpdateOrders(session, [salesOrderId], patch, msg);
  await adminUpdateOrders(session, [salesOrderId], { action: "NONE" });
  return `${ACTION_LABEL[action] ?? action}：${msg}`;
}

/* ─────────────────────────── 編輯訂單的副作用 ─────────────────────────── */

export interface EditOptions {
  action: string;
  regenVirtualBankAccount: boolean;
  resetCvs: boolean;
  updateGrandTotalAndShipping: boolean;
  updateSalesRules: boolean;
  updateShippingTag: boolean;
}

/** Editor 更新訂單後依勾選執行：重新產生虛擬帳戶／重置超取／重算總額運費／重算優惠／更新貨運標籤／進階操作 */
export async function afterOrderEdit(session: AdminSession, salesOrderId: number, opt: EditOptions): Promise<string[]> {
  const notices: string[] = [];
  if (opt.updateGrandTotalAndShipping || opt.updateSalesRules) {
    const r = await recalcOrderAmounts(session, salesOrderId, { shipping: opt.updateGrandTotalAndShipping, salesRules: opt.updateSalesRules });
    notices.push(r.message);
  }
  if (opt.updateShippingTag) {
    await recomputeShippingTags(session, [salesOrderId]);
    notices.push("已更新貨運標籤");
  }
  if (opt.regenVirtualBankAccount) {
    const n = notIntegrated("重新產生虛擬帳戶（金流）");
    await addOrderHistory(session, salesOrderId, `重新產生虛擬帳戶${n.message}`);
    notices.push(n.message);
  }
  if (opt.resetCvs) {
    await adminUpdateOrders(session, [salesOrderId], { store_payment_code: null }, "重置超取資訊");
    const n = notIntegrated("重新取得超商條碼（金流/物流）");
    notices.push(`已重置超取資訊，客戶需到訂單畫面重取條碼 ${n.message}`);
  }
  if (opt.action && opt.action !== "NONE") {
    const m = await performOrderAction(session, salesOrderId, opt.action);
    if (m) notices.push(m);
  }
  return notices;
}

/* ─────────────────────────── 付款期限 ─────────────────────────── */

/** 依團購付款期限天數計算新的繳款期限（自現在起算；台灣時間當天 23:59） */
export async function nextPaymentDue(session: AdminSession, groupBuyId: number | null): Promise<Date> {
  let days = 7;
  if (groupBuyId) {
    const { data } = await db().from("group_buys").select("payment_valid_days").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
    const d = num((data as { payment_valid_days?: number } | null)?.payment_valid_days);
    if (d > 0) days = Math.ceil(d);
  }
  const t = new Date(Date.now() + 8 * 3600_000 + days * 86400_000);
  t.setUTCHours(23, 59, 0, 0);
  return new Date(t.getTime() - 8 * 3600_000);
}
