// 系統信範本（進階設定／系統設定 EMAIL_*_SUBJECT／EMAIL_*_BODY）渲染：純函式，供單元測試直接載入。
// 使用者：core/delivery.ts（寄送時套用）、orders/order-ops.ts emailTemplateContent（後台寄信編輯器預填）
//
// 變數寫法：{{變數}}（前後可有空白），中英文名稱皆可；不認得的變數原樣保留。
//   {{訂單編號}} {{orderNo}}         {{顧客姓名}} {{customerName}}    {{訂單金額}} {{grandTotal}}
//   {{已付金額}} {{totalPaid}}       {{繳款期限}} {{paymentDue}}      {{團購名稱}} {{groupBuyTitle}}
//   {{訂單網址}} {{orderUrl}}        {{查貨號碼}} {{trackingNo}}      {{取貨門市}} {{cvsStore}}
//   {{商店名稱}} {{storeName}}       {{原內容}} {{content}}（系統原本產生的內文）
// 內文範本是 HTML（ckeditor）→ 變數值 HTML escape；主旨為純文字（去掉換行）。

/** 信件樣板代碼 → 設定鍵前綴（EMAIL_<X>_SUBJECT／EMAIL_<X>_BODY） */
export const TEMPLATE_PREF: Record<string, string> = {
  ORDER_CREATED: "EMAIL_SALES_ORDER",
  ORDER_CONFIRMED: "EMAIL_SALES_ORDER",
  SHIPMENT_NOTICE: "EMAIL_SHIPPING",
  PAID: "EMAIL_PAID",
  PAYMENT_RECEIVED: "EMAIL_PAID",
  PAYMENT_EXTENSION: "EMAIL_PAYMENT_DUE_EXTENSION",
  UNPAID_REMINDER: "EMAIL_UNPAID",
  PAYMENT_REMINDER: "EMAIL_UNPAID",
  ORDER_UPDATED: "EMAIL_ORDER_UPDATED",
  SEND_ORDER_UPDATED_EMAIL: "EMAIL_ORDER_UPDATED",
  ORDER_CANCELLED: "EMAIL_CANCELED",
  REFUND_NOTICE: "EMAIL_REFUND",
  PICKUP_AVAILABLE: "EMAIL_READY_PICKUP",
  CVS_SHIPMENT_NOTICE: "EMAIL_CVS_SHIPPING",
  CVS_DELIVERY_ARRIVED: "EMAIL_CVS_ARRIVE",
  PROMO_CODE_SENT: "EMAIL_COUPON",
  CUSTOM: "EMAIL_CUSTOM",
};
export const templatePrefNames = (template: string | null | undefined): [string, string] | null => {
  const p = TEMPLATE_PREF[String(template ?? "")];
  return p ? [`${p}_SUBJECT`, `${p}_BODY`] : null;
};

export interface TemplateVars {
  orderNo: string;
  customerName: string;
  grandTotal: string;
  totalPaid: string;
  paymentDue: string;
  groupBuyTitle: string;
  orderUrl: string;
  trackingNo: string;
  cvsStore: string;
  storeName: string;
  content: string;
}
const ALIAS: Record<string, keyof TemplateVars> = {
  訂單編號: "orderNo",
  顧客姓名: "customerName",
  訂單金額: "grandTotal",
  已付金額: "totalPaid",
  繳款期限: "paymentDue",
  團購名稱: "groupBuyTitle",
  訂單網址: "orderUrl",
  查貨號碼: "trackingNo",
  取貨門市: "cvsStore",
  商店名稱: "storeName",
  原內容: "content",
};

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** 原內容：系統產生的 HTML（含 p/br/div… 標籤）原樣放入；其他一律當純文字 escape、換行轉 <br> */
const textToHtml = (s: string) => (/<\s*(p|br|div|table|a|span|strong|b|h\d)\b[^>]*>/i.test(s) ? s : escHtml(s).replace(/\r?\n/g, "<br>"));

/** 套變數。html=true：值 escape（原內容若是純文字轉成 <br> 換行；本來就是 HTML 則原樣放入） */
export function renderTemplate(tpl: string, vars: TemplateVars, opt: { html: boolean }): string {
  return String(tpl ?? "").replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, rawKey: string) => {
    const key = (ALIAS[rawKey] ?? rawKey) as keyof TemplateVars;
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
    const v = String(vars[key] ?? "");
    if (!opt.html) return v.replace(/[\r\n]+/g, " ");
    return key === "content" ? textToHtml(v) : escHtml(v);
  });
}

/** 範本設定值是否有內容（HTML 去標籤後非空白） */
export const hasTemplate = (v: string | null | undefined) => !!String(v ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

/** 主旨／內文：有設定範本就渲染，沒有就用原本的 */
export function applyTemplate(
  tpl: { subject: string | null | undefined; body: string | null | undefined },
  current: { subject: string; body: string },
  vars: Omit<TemplateVars, "content">,
): { subject: string; body: string; applied: boolean } {
  const full: TemplateVars = { ...vars, content: current.body };
  const s = hasTemplate(tpl.subject) ? renderTemplate(String(tpl.subject), full, { html: false }).trim() : null;
  const b = hasTemplate(tpl.body) ? renderTemplate(String(tpl.body), full, { html: true }) : null;
  return { subject: s || current.subject, body: b ?? current.body, applied: s !== null || b !== null };
}

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "";
};
/** 台北時間 YYYY-MM-DD HH:mm */
export function taipeiDateTime(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (!Number.isFinite(d.getTime())) return "";
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}

/** 訂單列（sales_orders＋group_buys(title, short_url)）→ 變數 */
export function orderVars(
  o: Record<string, unknown>,
  ctx: { tenantCode: string; tenantName: string; baseUrl: string },
): Omit<TemplateVars, "content"> {
  const gb = (o.group_buys ?? {}) as { title?: string; short_url?: string };
  const uuid = String(o.uuid ?? "");
  const name = String(o.customer_firstname ?? "").trim();
  const url =
    ctx.baseUrl && gb.short_url && uuid
      ? `${ctx.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ctx.tenantCode)}/p/${encodeURIComponent(gb.short_url)}/SalesOrder/show.do?uuid=${encodeURIComponent(uuid)}`
      : "";
  return {
    orderNo: uuid,
    customerName: name,
    grandTotal: money(o.grand_total),
    totalPaid: money(o.total_paid),
    paymentDue: taipeiDateTime(o.date_payment_due),
    groupBuyTitle: String(gb.title ?? ""),
    orderUrl: url,
    trackingNo: String(o.shipping_receipt_number ?? ""),
    cvsStore: String(o.cvs_store_name ?? ""),
    storeName: ctx.tenantName,
  };
}

/** 簡訊點數：70 字內 1 點，超過每 67 字 1 點（與 orders/common.ts recordSms 同口徑） */
export const smsPoints = (content: string) => {
  const len = [...String(content ?? "")].length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
};
