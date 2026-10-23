// 出貨檔案產生（匯出貨運清單、下載出貨商品、下載地址單、列印出貨商品共用）。
//
// 貨運清單格式＝貨運標籤（ShippingTag）的「自定義匯出格式」兩行：第一行欄位標題、第二行欄位代碼（貨運標籤頁的代碼按鈕）。
// 沒有自定義格式時用本站的標準格式（推導；原站各物流商標準格式未合法取得）：宅配類一種、超商取貨（SE／FAMI）一種，
// 標題列的「訂單編號／貨運編號」欄名取自貨運標籤設定，讓匯入貨運單能用同一組標頭對回訂單。
// 代碼集合＝貨運標籤頁的代碼按鈕；「#」＝空白欄；未知代碼輸出空字串。格式含 item.* 代碼時每個訂單商品一列，否則每張訂單一列。
import ExcelJS from "exceljs";
import { enumOptions } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import type { Row } from "@/lib/db/mapping";
import { db, str } from "./common";

export type ExportOrder = Row & {
  order_items: Row[];
  group_buys: Row | null;
  sales_order_coupons: Row[];
  sales_order_sales_rules: Row[];
};

const n = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

/* ─────────────────────────── 讀取 ─────────────────────────── */

/** 依 id 讀訂單（含團購、商品、優惠），保持傳入順序 */
export async function loadExportOrders(tenantId: number, ids: number[]): Promise<ExportOrder[]> {
  const out: ExportOrder[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db()
      .from("sales_orders")
      .select("*, group_buys(id,title,short_title), order_items(*), sales_order_coupons(coupon,discount), sales_order_sales_rules(title,discount)")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`[shipping] 讀取訂單失敗：${error.message}`);
    out.push(...((data ?? []) as unknown as ExportOrder[]));
  }
  const pos = new Map(ids.map((id, i) => [id, i]));
  out.sort((a, b) => (pos.get(Number(a.id)) ?? 0) - (pos.get(Number(b.id)) ?? 0));
  for (const o of out) {
    o.order_items = [...(o.order_items ?? [])].filter((x) => n(x.tenant_id) === tenantId).sort((a, b) => n(a.seq) - n(b.seq) || n(a.id) - n(b.id));
    o.sales_order_coupons = o.sales_order_coupons ?? [];
    o.sales_order_sales_rules = o.sales_order_sales_rules ?? [];
  }
  return out;
}

/** 訂單商品對應的商品主檔（代碼、條碼、成本、分類、重量） */
export async function loadItemsOf(tenantId: number, orders: ExportOrder[]): Promise<Map<number, Row>> {
  const ids = [...new Set(orders.flatMap((o) => o.order_items.map((i) => Number(i.item_id)).filter((x) => x > 0)))];
  const map = new Map<number, Row>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db()
      .from("items")
      .select("id, uid, upc, cprice, cate_tag, shipping_tag, item_settings, retail_price")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`[shipping] 讀取商品失敗：${error.message}`);
    for (const r of (data ?? []) as Row[]) map.set(Number(r.id), r);
  }
  return map;
}

/** 出貨的商品行：組合商品有子項時只算子項（實際出貨品），否則算本身 */
export function shippableItems(o: ExportOrder): Row[] {
  const parents = new Set(o.order_items.filter((i) => i.bundle_child && i.parent_order_item_id).map((i) => Number(i.parent_order_item_id)));
  return o.order_items.filter((i) => !(i.bundle_root && parents.has(Number(i.id))) && !["CANCELED", "RETURNED", "RETURNED_NOSALE", "CANCELLED"].includes(str(i.state)));
}

/* ─────────────────────────── 標籤文字 ─────────────────────────── */

export interface Labels {
  state: Map<string, string>;
  status: Map<string, string>;
  paymentMethod: Map<string, string>;
  paymentMethodCode: Map<string, string>;
  shippingType: Map<string, string>;
  shippingProvider: Map<string, string>;
  deliverTime: Map<string, string>;
  receiptType: Map<string, string>;
  itemState: Map<string, string>;
}

export async function loadLabels(): Promise<Labels> {
  const m = async (k: string, useInt = false) => new Map((await enumOptions(k, useInt)).map((o) => [String(o.value), o.label]));
  return {
    state: await m("SalesOrder.state"),
    status: await m("SalesOrder.status"),
    paymentMethod: await m("SalesOrder.paymentMethod", true),
    paymentMethodCode: await m("PaymentMethodCode", true),
    shippingType: await m("ShippingType"),
    shippingProvider: await m("SalesOrder.shippingProvider"),
    deliverTime: await m("SalesOrder.deliverTime"),
    receiptType: await m("SalesOrder.receiptType"),
    itemState: await m("OrderItem.state"),
  };
}

/* ─────────────────────────── 格式 ─────────────────────────── */

/** 沒有選貨運標籤時的預設值（本站設計） */
export const DEFAULT_SHIPPING_TAG = {
  salesOrderUuid: "訂單編號",
  salesOrderShippingReceiptNumber: "貨運編號",
  shippingProvider: "",
  shippingExportFormat: "",
  shippingTagSettings: {},
  uniqueShippingProvider: "",
  cvs: false,
  shippingProviderString: "",
};

/** 標準格式（推導） */
function standardFormat(provider: string, uuidHeader: string, receiptHeader: string): string {
  const unique = provider.replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, "");
  if (unique === "SE" || unique === "FAMI") {
    return (
      `${uuidHeader},收件人,收件人電話,取件門市代號,取件門市名稱,商品,代收金額,備註,${receiptHeader}\n` +
      "order.uuid,shipping.name.only,shipping.phone,cvsStoreId,cvsStoreName,order.itemsList,payOnDelivery,note,#"
    );
  }
  return (
    `${uuidHeader},收件人,收件人電話,郵遞區號,收件地址,商品,件數,代收金額,配送時段,備註,${receiptHeader}\n` +
    "order.uuid,shipping.name.only,shipping.phone,shipping.postcode,shipping.address,order.itemsList,order.itemsTotal,payOnDelivery,deliver.time.shortCode,note,#"
  );
}

export interface ExportFormat {
  headers: string[];
  tokens: string[];
  provider: string;
}

const splitCsvLine = (s: string) => s.split(",").map((x) => x.trim());

/** 貨運標籤 → 匯出格式（null＝本站預設標準格式） */
export function resolveFormat(tag: Row | null): ExportFormat {
  const provider = str(tag?.shipping_provider);
  const custom = str(tag?.shipping_export_format);
  const uuidHeader = str(tag?.sales_order_uuid) || DEFAULT_SHIPPING_TAG.salesOrderUuid;
  const receiptHeader = str(tag?.sales_order_shipping_receipt_number) || DEFAULT_SHIPPING_TAG.salesOrderShippingReceiptNumber;
  const text = custom || standardFormat(provider, uuidHeader, receiptHeader);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const headers = splitCsvLine(lines[0]);
    const tokens = splitCsvLine(lines[1]);
    while (headers.length < tokens.length) headers.push("");
    return { headers: headers.slice(0, Math.max(tokens.length, 1)), tokens, provider };
  }
  const tokens = splitCsvLine(lines[0] ?? "order.uuid");
  return { headers: tokens.slice(), tokens, provider };
}

/* ─────────────────────────── 代碼求值 ─────────────────────────── */

const address = (o: Row, p: "billing" | "shipping") => [o[`${p}_city`], o[`${p}_district`], o[`${p}_street`]].map(str).join("");

function shippingAddress(o: Row): string {
  if (str(o.shipping_type) === "CVS") return [str(o.cvs_store_name), str(o.cvs_address)].filter(Boolean).join(" ");
  const a = address(o, "shipping");
  return a || address(o, "billing");
}

const ymd = (v: unknown) => taipeiDate(v).replace(/-/g, "");
const isPaid = (o: Row) => n(o.total_paid) > 0;
const isCollect = (o: Row) => [16, 64].includes(n(o.payment_method));

function itemLabel(i: Row, kind: "short" | "title" | "uid"): string {
  const name = kind === "uid" ? str(i.uid) || str(i.short_name) || str(i.title) : kind === "title" ? str(i.title) : str(i.short_name) || str(i.title);
  const spec = kind === "uid" ? "" : str(i.specifications_label);
  return `${name}${spec ? ` ${spec}` : ""}x${n(i.total)}`;
}

function orderToken(token: string, o: ExportOrder, L: Labels): string | number {
  const items = shippableItems(o);
  const gb = o.group_buys ?? {};
  const uuid = str(o.uuid);
  switch (token) {
    case "#":
    case "":
      return "";
    case "groupbuy.id": return str(o.group_buy_id);
    case "groupbuy.title": return str(gb.title);
    case "groupbuy.title.short": return str(gb.short_title) || str(gb.title);
    case "order.uuid":
    case "apiOrderNo":
      return uuid;
    case "order.seq": return n(uuid.slice(-6));
    case "order.seq.groupbuy": return `${str(gb.short_title)}${n(uuid.slice(-6))}`;
    case "order.dateCreatedYYMMDD": return ymd(o.created_at);
    case "order.dateCreatedYMDHMS": return taipeiDateTime(o.created_at, true).replace(/[-: ]/g, "");
    case "order.dateCreatedYYMMDDSlash": return taipeiDate(o.created_at).replace(/-/g, "/");
    case "order.state": return L.state.get(str(o.state)) ?? str(o.state);
    case "order.status": return L.status.get(str(o.status)) ?? str(o.status);
    case "paymentMethod": return L.paymentMethod.get(str(o.payment_method)) ?? "";
    case "paymentMethodCode": return L.paymentMethodCode.get(str(o.payment_method)) ?? str(o.payment_method);
    case "payStatus": return isPaid(o) ? "已付款" : isCollect(o) ? "貨到付款" : "未付款";
    case "order.datePaymentDue": return taipeiDateTime(o.date_payment_due);
    case "order.datePaid": return taipeiDateTime(o.date_paid);
    case "order.grandTotal": return n(o.grand_total);
    case "order.discount": return n(o.discount_amount);
    case "order.itemTotalPriceWithoutDiscount": return items.reduce((s, i) => s + n(i.price) * n(i.total), 0);
    case "order.itemTotalCostPriceWithoutDiscount": return items.reduce((s, i) => s + n(i.cprice) * n(i.total), 0);
    case "order.totalPaid":
    case "order.totalPaidBeforeSplit":
      return n(o.total_paid);
    case "order.shippingAmount": return n(o.shipping_amount);
    case "order.shippingFee": return n(o.shipping_amount) - n(o.cod_fee);
    case "order.codFee": return n(o.cod_fee);
    case "payOnDelivery": return isCollect(o) && !isPaid(o) ? n(o.grand_total) : 0;
    case "order.coupon": return o.sales_order_coupons.map((c) => str(c.coupon)).filter(Boolean).join(",");
    case "order.coupon.title":
    case "order.coupon.code":
      return o.sales_order_coupons.map((c) => str(c.coupon)).filter(Boolean).join(",");
    case "order.salesRules": return o.sales_order_sales_rules.map((r) => str(r.title)).filter(Boolean).join(",");
    case "cvsStoreId": return str(o.cvs_store_id);
    case "cvsStoreName": return str(o.cvs_store_name);
    case "billing.name":
    case "customer.firstname":
      return str(o.customer_firstname);
    case "billing.fbNickname": return str(o.billing_fb_nickname);
    case "billing.postcode": return str(o.billing_postcode);
    case "billing.address": return address(o, "billing");
    case "billing.email": return str(o.customer_email);
    case "billing.phone": return str(o.customer_telephone);
    case "billing.birthday": return taipeiDate(o.billing_birthday);
    case "shipping.name.only": return str(o.shipping_firstname) || str(o.customer_firstname);
    case "shipping.name": return str(o.shipping_firstname) && str(o.shipping_firstname) !== str(o.customer_firstname) ? str(o.shipping_firstname) : "";
    case "shipping.postcode": return str(o.shipping_postcode) || str(o.billing_postcode);
    case "shipping.address": return shippingAddress(o);
    case "shipping.email": return str(o.shipping_email) || str(o.customer_email);
    case "shipping.phone": return str(o.shipping_telephone) || str(o.customer_telephone);
    case "note": return str(o.note);
    case "staff.note": return str(o.staff_note);
    case "billing.bank.name": return str(o.billing_bank_name);
    case "billing.bank.account": return str(o.virtual_bank_account) || str(o.billing_bank_account);
    case "order.pointAmount":
    case "order.point.use":
      return n(o.points_used);
    case "receiptType": return L.receiptType.get(str(o.billing_receipt_type)) ?? str(o.billing_receipt_type);
    case "receiptCategory": return o.billing_receipt_donate ? "捐贈" : o.billing_receipt_paper ? "紙本" : "電子";
    case "receiptTitle": return str(o.billing_receipt_title);
    case "receiptTitleOrFirstname": return str(o.billing_receipt_title) || str(o.customer_firstname);
    case "receiptVatId": return str(o.billing_receipt_vat_id);
    case "invoiceNumber": return str(o.invoice_number);
    case "dateEinvoice": return taipeiDate(o.date_einvoice);
    case "invoice.barcode": return str(o.billing_receipt_carrier_num);
    case "invoice.taxType": return "應稅";
    case "invoice.amount.beforeTax": return Math.round(n(o.grand_total) / 1.05);
    case "invoice.taxAmount": return n(o.grand_total) - Math.round(n(o.grand_total) / 1.05);
    case "order.shippingProvider": return L.shippingProvider.get(str(o.shipping_provider)) ?? str(o.shipping_provider);
    case "order.shippingTag": return str(o.shipping_tag);
    case "shippingReceiptNumber": return str(o.shipping_receipt_number);
    case "deliver.time": return str(o.deliver_time);
    case "deliver.time.shortCode":
    case "deliver.time.custom":
      return L.deliverTime.get(str(o.deliver_time)) ?? str(o.deliver_time);
    case "shipping.shippingType": return L.shippingType.get(str(o.shipping_type)) ?? str(o.shipping_type);
    case "order.preferredDeliveryDates": return Array.isArray(o.preferred_delivery_dates) ? (o.preferred_delivery_dates as unknown[]).join(",") : str(o.preferred_delivery_dates);
    case "order.dateShipped": return taipeiDate(o.date_shipped);
    case "order.itemsList": return items.map((i) => itemLabel(i, "short")).join(", ");
    case "order.itemsList.br": return items.map((i) => itemLabel(i, "short")).join("\n");
    case "order.itemsListAndNote": return [items.map((i) => itemLabel(i, "short")).join(", "), str(o.note)].filter(Boolean).join(" ");
    case "order.itemsUidList": return items.map((i) => itemLabel(i, "uid")).join(", ");
    case "order.itemsTitleList": return items.map((i) => itemLabel(i, "title")).join(", ");
    case "order.itemsTotal": return items.reduce((s, i) => s + n(i.total), 0);
    case "order.itemKinds": return new Set(items.map((i) => `${i.item_id ?? i.title}|${i.specifications_label ?? ""}`)).size;
  }
  return "";
}

function itemToken(token: string, i: Row, master: Row | undefined, L: Labels): string | number {
  const total = n(i.total);
  const cost = n(i.cprice) || n(master?.cprice);
  const amount = n(i.amount);
  switch (token) {
    case "item.uid": return str(i.uid) || str(master?.uid);
    case "item.upc": return str(master?.upc);
    case "item.title": return [str(i.title), str(i.specifications_label)].filter(Boolean).join(" ");
    case "item.shortName": return str(i.short_name) || str(i.title);
    case "item.cateTag": return str(master?.cate_tag);
    case "item.total": return total;
    case "item.retailPrice": return n(i.retail_price) || n(master?.retail_price);
    case "item.price": return n(i.price);
    case "item.costPrice": return cost;
    case "item.discount.price": return total ? Math.round((amount / total) * 100) / 100 : 0;
    case "item.discount": return n(i.discount);
    case "item.totalPrice": return amount;
    case "item.totalPriceNoneDiscount": return n(i.price) * total;
    case "item.totalCostPrice": return cost * total;
    case "item.grossMargin": return amount ? Math.round(((amount - cost * total) / amount) * 10000) / 100 : 0;
    case "item.grossMargin.amount": return amount - cost * total;
    case "item.shipping.status": return L.itemState.get(str(i.state)) ?? str(i.state);
    case "item.backOrderStatus": return i.back_order ? "預購" : "現貨";
    case "item.virtualCode": return str(i.virtual_codes);
    case "item.shippingTag": return str(i.shipping_tag) || str(master?.shipping_tag);
    case "item.taxType": return "應稅";
    case "item.commission": return n(i.commission_dollar) ? n(i.commission_dollar) * total : Math.round((amount * n(i.commission_rate)) / 100);
    case "item.commissionRate": return n(i.commission_rate);
    case "item.commissionDollar": return n(i.commission_dollar);
    case "item.weight": {
      const s = (master?.item_settings ?? {}) as Row;
      return n(s.flatRateShippingWeight ?? s.weight);
    }
    case "item.note": return str(i.attribute_note);
    case "item.dateExpired": return "";
  }
  return "";
}

/** 依格式產生二維表（含標題列） */
export function buildShippingRows(orders: ExportOrder[], items: Map<number, Row>, fmt: ExportFormat, L: Labels): (string | number)[][] {
  // itemset.cols：展開為「各商品數量」多欄（只列有出貨的商品）
  const colsIdx = fmt.tokens.indexOf("itemset.cols");
  const itemCols: string[] = [];
  if (colsIdx >= 0) {
    for (const o of orders) for (const i of shippableItems(o)) {
      const k = str(i.short_name) || str(i.title);
      if (!itemCols.includes(k)) itemCols.push(k);
    }
  }
  const headers: string[] = [];
  fmt.tokens.forEach((t, idx) => {
    if (t === "itemset.cols") headers.push(...itemCols);
    else headers.push(fmt.headers[idx] ?? "");
  });
  const perItem = fmt.tokens.some((t) => t.startsWith("item."));
  const rows: (string | number)[][] = [headers];
  for (const o of orders) {
    const lines = perItem ? shippableItems(o) : [null];
    for (const it of lines) {
      const row: (string | number)[] = [];
      for (const t of fmt.tokens) {
        if (t === "itemset.cols") {
          const qty = new Map<string, number>();
          for (const i of shippableItems(o)) {
            const k = str(i.short_name) || str(i.title);
            qty.set(k, (qty.get(k) ?? 0) + n(i.total));
          }
          for (const k of itemCols) row.push(qty.get(k) ?? "");
        } else if (t.startsWith("item.")) {
          row.push(it ? itemToken(t, it, items.get(Number(it.item_id)), L) : "");
        } else {
          row.push(orderToken(t, o, L));
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

/* ─────────────────────────── 檔案 ─────────────────────────── */

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export async function toXlsx(sheet: string, rows: (string | number | null | undefined)[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.slice(0, 31) || "Sheet1");
  for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? "" : v)));
  if (rows.length) ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

export const stamp = () => taipeiDateTime(new Date()).replace(/[-: ]/g, "").slice(0, 12);

export interface ExportFile {
  body: BodyInit;
  filename: string;
  type: string;
}

/** 貨運清單 */
export async function shippingListFile(tenantId: number, orders: ExportOrder[], tag: Row | null, fileFormat: string, prefix = "貨運清單"): Promise<ExportFile> {
  const [items, L] = await Promise.all([loadItemsOf(tenantId, orders), loadLabels()]);
  const rows = buildShippingRows(orders, items, resolveFormat(tag), L);
  const name = `${prefix}${tag ? `_${str(tag.title) || str(tag.tag)}` : ""}_${stamp()}`;
  if (str(fileFormat).toUpperCase() === "CSV") return { body: toCsv(rows), filename: `${name}.csv`, type: "text/csv;charset=UTF-8" };
  return { body: await toXlsx("貨運清單", rows), filename: `${name}.xlsx`, type: XLSX_TYPE };
}

export interface ItemAgg {
  title: string;
  shortName: string;
  spec: string;
  uid: string;
  normal: number;
  back: number;
  total: number;
}

/** 出貨商品彙總（商品＋規格） */
export function aggregateItems(orders: ExportOrder[]): ItemAgg[] {
  const agg = new Map<string, ItemAgg>();
  for (const o of orders) {
    for (const i of shippableItems(o)) {
      const k = `${i.item_id ?? i.title}|${i.specifications_label ?? ""}`;
      const a = agg.get(k) ?? { title: str(i.title), shortName: str(i.short_name) || str(i.title), spec: str(i.specifications_label), uid: str(i.uid), normal: 0, back: 0, total: 0 };
      if (i.back_order) a.back += n(i.total);
      else a.normal += n(i.total);
      a.total += n(i.total);
      agg.set(k, a);
    }
  }
  return [...agg.values()].sort((a, b) => a.shortName.localeCompare(b.shortName, "zh-Hant"));
}

export async function itemsFile(orders: ExportOrder[]): Promise<ExportFile> {
  const rows: (string | number)[][] = [["商品名稱", "出貨短名稱", "規格", "商品代碼", "現貨數量", "預購數量", "總數量"]];
  for (const a of aggregateItems(orders)) rows.push([a.title, a.shortName, a.spec, a.uid, a.normal, a.back, a.total]);
  return { body: await toXlsx("出貨商品", rows), filename: `出貨商品_${stamp()}.xlsx`, type: XLSX_TYPE };
}

export async function labelFile(orders: ExportOrder[]): Promise<ExportFile> {
  const rows: (string | number)[][] = [["訂單編號", "收件人", "收件人電話", "郵遞區號", "收件地址", "配送方式", "商品", "備註"]];
  const L = await loadLabels();
  for (const o of orders) {
    rows.push([
      str(o.uuid),
      str(o.shipping_firstname) || str(o.customer_firstname),
      str(o.shipping_telephone) || str(o.customer_telephone),
      str(o.shipping_postcode) || str(o.billing_postcode),
      shippingAddress(o),
      L.shippingType.get(str(o.shipping_type)) ?? str(o.shipping_type),
      shippableItems(o).map((i) => itemLabel(i, "short")).join(", "),
      str(o.note),
    ]);
  }
  return { body: await toXlsx("地址單", rows), filename: `地址單_${stamp()}.xlsx`, type: XLSX_TYPE };
}
