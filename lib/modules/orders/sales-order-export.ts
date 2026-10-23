// 所有訂單頁的匯出與列印：
//   POST /backend/SalesOrderExport/batchAction（#queryForm：batchAction、query＝列表參數 JSON、salesOrderIds）
//        EXPORT_CSV / EXPORT_ORDER_ITEM / EXPORT_EINVOICE_CSV / EXPORT_ERP…EXPORT_ERP6 → 檔案下載（jquery.fileDownload）
//   GET  /backend/SalesOrderExport/batchAction?batchAction=PRINT_ORDER|PRINT_ORDER_PIECE|PRINT_C2C_ORDER_INFO|PRINT_ORDER_BARCODE&salesOrderId=1,2
//   GET  /backend/SalesOrder/batchAction?batchAction=PRINT_C2C_ORDER_INFO&uuid=a,b（更新超取小白單後列印）
//   GET  /backend/SalesOrder/printOrder|printOrderQuotation|printC2COrderInfo?salesOrderId=
// 原站匯出檔欄位與列印版面未擷取（需有訂單），依訂單欄位推導，記於 docs/modules/orders.md。
import ExcelJS from "exceljs";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { download, html } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { commonVars } from "@/lib/core/render/vars";
import { enumOptions } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import type { Row } from "@/lib/db/mapping";
import { db, parseIds, strParam } from "./common";
import { shippingAddressOf } from "./order-api";
import { buildSearchParams, searchInputFromLegacyJson, searchOrders } from "./order-search";
import { loadPrintSettings } from "./sales-order-actions";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

/* ─────────────────────────── 資料 ─────────────────────────── */

type OrderRow = Row & { order_items: Row[]; group_buys: { title?: string; short_url?: string } | null; sales_order_coupons: Row[] };

async function loadOrdersForExport(session: AdminSession, ids: number[]): Promise<OrderRow[]> {
  const out: OrderRow[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db()
      .from("sales_orders")
      .select("*, group_buys(title,short_url), order_items(*), sales_order_coupons(coupon,discount)")
      .eq("tenant_id", session.tenantId)
      .in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`[orders export] ${error.message}`);
    out.push(...((data ?? []) as unknown as OrderRow[]));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  out.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
  for (const o of out) o.order_items = [...(o.order_items ?? [])].sort((a, b) => num(a.seq) - num(b.seq) || num(a.id) - num(b.id));
  return out;
}

async function labelMaps() {
  const m = async (k: string) => new Map((await enumOptions(k)).map((o) => [String(o.value), o.label]));
  return {
    state: await m("SalesOrder.state"),
    status: await m("SalesOrder.status"),
    paymentMethod: await m("SalesOrder.paymentMethod"),
    shippingType: await m("ShippingType"),
    shippingProvider: await m("SalesOrder.shippingProvider"),
    deliverTime: await m("SalesOrder.deliverTime"),
    receiptType: await m("SalesOrder.receiptType"),
    carrierType: await m("SalesOrder.receiptCarrierType"),
  };
}
type Labels = Awaited<ReturnType<typeof labelMaps>>;

/** 匯出的訂單 id：有勾選訂單就用勾選的，否則依 query（列表參數）＋分頁（單次上限 4000 筆） */
async function exportIds(session: AdminSession, ctx: RequestContext): Promise<number[]> {
  const selected = parseIds(await strParam(ctx, "salesOrderIds"));
  if (selected.length) return selected.slice(0, 4000);
  const raw = await strParam(ctx, "query");
  let q: Record<string, unknown> = {};
  if (raw) {
    try {
      q = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw badRequest("匯出參數錯誤");
    }
  }
  const input = searchInputFromLegacyJson(q);
  input.length = Math.min(Math.max(Number(q.iDisplayLength) || 4000, 1), 4000);
  const p = await buildSearchParams(session, input);
  return (await searchOrders(session, p)).ids;
}

/* ─────────────────────────── 檔案格式 ─────────────────────────── */

function csv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

async function xlsx(sheet: string, rows: (string | number | null | undefined)[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "團購表單";
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? "" : v)));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => {
    let w = 8;
    c.eachCell?.({ includeEmpty: false }, (cell) => {
      w = Math.min(60, Math.max(w, String(cell.value ?? "").length * 1.6 + 2));
    });
    c.width = w;
  });
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

const itemsText = (o: OrderRow) => o.order_items.filter((i) => !i.bundle_child).map((i) => `${i.title}${i.specifications_label ? `(${i.specifications_label})` : ""}x${i.total}${i.back_order ? "(預購)" : ""}`).join("; ");

function orderHeader(): string[] {
  return [
    "訂單編號", "訂單日期", "團購ID", "團購", "階段", "狀態", "付款方式", "結帳金額", "運費(含貨付)", "折扣", "已付金額", "付款日期", "繳款期限",
    "顧客姓名", "顧客電話", "顧客Email", "收件人", "收件人電話", "收件地址", "配送方式", "貨運標籤", "出貨貨運", "查貨號碼", "已出貨日期",
    "期望配達日", "收件時間", "發票號碼", "發票類型", "發票統編", "發票抬頭", "銀行帳號後五碼", "虛擬帳戶", "優惠卷", "備註", "員工備註", "商品明細",
  ];
}

function orderLine(o: OrderRow, L: Labels): (string | number | null)[] {
  return [
    String(o.uuid), taipeiDateTime(o.created_at), o.group_buy_id as number, o.group_buys?.title ?? "", L.state.get(String(o.state)) ?? String(o.state),
    L.status.get(String(o.status)) ?? String(o.status), L.paymentMethod.get(String(o.payment_method)) ?? String(o.payment_method), num(o.grand_total),
    num(o.shipping_amount), num(o.discount_amount), num(o.total_paid), taipeiDateTime(o.date_paid), taipeiDateTime(o.date_payment_due),
    String(o.customer_firstname ?? ""), String(o.customer_telephone ?? ""), String(o.customer_email ?? ""), String(o.shipping_firstname ?? ""),
    String(o.shipping_telephone ?? ""), shippingAddressOf(o), L.shippingType.get(String(o.shipping_type)) ?? String(o.shipping_type),
    String(o.shipping_tag ?? ""), L.shippingProvider.get(String(o.shipping_provider)) ?? String(o.shipping_provider), String(o.shipping_receipt_number ?? ""),
    taipeiDate(o.date_shipped), taipeiDate(o.date_expected_shipping), L.deliverTime.get(String(o.deliver_time)) ?? "", String(o.invoice_number ?? ""),
    L.receiptType.get(String(o.billing_receipt_type)) ?? "", String(o.billing_receipt_vat_id ?? ""), String(o.billing_receipt_title ?? ""),
    String(o.billing_bank_account ?? ""), String(o.virtual_bank_account ?? ""), (o.sales_order_coupons ?? []).map((c) => c.coupon).filter(Boolean).join(";"),
    String(o.note ?? ""), String(o.staff_note ?? ""), itemsText(o),
  ];
}

async function buildExport(action: string, orders: OrderRow[], L: Labels): Promise<{ body: BodyInit; filename: string; type: string }> {
  const stamp = taipeiDateTime(new Date()).replace(/[-: ]/g, "").slice(0, 12);
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  switch (action) {
    case "EXPORT_CSV":
      return { body: csv([orderHeader(), ...orders.map((o) => orderLine(o, L))]), filename: `訂單_${stamp}.csv`, type: "text/csv;charset=UTF-8" };
    case "EXPORT_ORDER_ITEM": {
      const agg = new Map<string, { title: string; uid: string; spec: string; normal: number; back: number; amount: number }>();
      for (const o of orders) {
        if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(o.state))) continue;
        for (const i of o.order_items) {
          const k = `${i.item_id ?? i.title}|${i.specifications_label ?? ""}`;
          const a = agg.get(k) ?? { title: String(i.title), uid: String(i.uid ?? ""), spec: String(i.specifications_label ?? ""), normal: 0, back: 0, amount: 0 };
          if (i.back_order) a.back += num(i.total);
          else a.normal += num(i.total);
          a.amount += num(i.amount);
          agg.set(k, a);
        }
      }
      const rows = [["商品名稱", "商品代碼", "規格", "現貨數量", "預購數量", "總數量", "小計"], ...[...agg.values()].map((a) => [a.title, a.uid, a.spec, a.normal, a.back, a.normal + a.back, a.amount])];
      return { body: await xlsx("訂單商品數量", rows), filename: `訂單商品數量_${stamp}.xlsx`, type: XLSX };
    }
    case "EXPORT_EINVOICE_CSV": {
      const rows: (string | number | null)[][] = [["訂單編號", "發票類型", "買方統編", "買方名稱", "載具類別", "載具編號", "捐贈碼", "Email", "電話", "品名", "數量", "單價", "金額", "訂單金額"]];
      for (const o of orders) {
        for (const i of o.order_items.filter((x) => !x.bundle_child)) {
          rows.push([String(o.uuid), L.receiptType.get(String(o.billing_receipt_type)) ?? "", String(o.billing_receipt_vat_id ?? ""), String(o.billing_receipt_title ?? o.customer_firstname ?? ""),
            L.carrierType.get(String(o.billing_receipt_carrier_type)) ?? "", String(o.billing_receipt_carrier_num ?? ""), String(o.billing_receipt_donation_code ?? ""),
            String(o.customer_email ?? ""), String(o.customer_telephone ?? ""), String(i.title), num(i.total), num(i.price), num(i.amount), num(o.grand_total)]);
        }
        if (num(o.shipping_amount)) rows.push([String(o.uuid), "", "", "", "", "", "", "", "", "運費", 1, num(o.shipping_amount), num(o.shipping_amount), num(o.grand_total)]);
      }
      return { body: csv(rows), filename: `電子發票_${stamp}.csv`, type: "text/csv;charset=UTF-8" };
    }
    case "EXPORT_ERP":
      return { body: await xlsx("ERP報表1", [orderHeader(), ...orders.map((o) => orderLine(o, L))]), filename: `ERP報表1_${stamp}.xlsx`, type: XLSX };
    case "EXPORT_ERP2": {
      const rows: (string | number | null)[][] = [["訂單編號", "訂單日期", "顧客姓名", "顧客電話", "收件人", "收件地址", "商品名稱", "商品代碼", "規格", "數量", "單價", "折扣", "小計", "預購", "贈品", "階段", "狀態"]];
      for (const o of orders)
        for (const i of o.order_items)
          rows.push([String(o.uuid), taipeiDateTime(o.created_at), String(o.customer_firstname ?? ""), String(o.customer_telephone ?? ""), String(o.shipping_firstname ?? ""), shippingAddressOf(o),
            String(i.title), String(i.uid ?? ""), String(i.specifications_label ?? ""), num(i.total), num(i.price), num(i.discount), num(i.amount), i.back_order ? "Y" : "", i.gift ? "Y" : "",
            L.state.get(String(o.state)) ?? "", L.status.get(String(o.status)) ?? ""]);
      return { body: await xlsx("ERP報表2", rows), filename: `ERP報表2_${stamp}.xlsx`, type: XLSX };
    }
    case "EXPORT_ERP3": {
      const rows: (string | number | null)[][] = [["訂單編號", "收件人", "收件人電話", "郵遞區號", "收件地址", "配送方式", "超商門市", "貨運標籤", "出貨貨運", "查貨號碼", "期望配達日", "收件時間", "商品", "代收金額", "備註"]];
      for (const o of orders) {
        const collect = num(o.total_paid) > 0 ? 0 : num(o.grand_total);
        rows.push([String(o.uuid), String(o.shipping_firstname ?? o.customer_firstname ?? ""), String(o.shipping_telephone ?? o.customer_telephone ?? ""), String(o.shipping_postcode ?? ""), shippingAddressOf(o),
          L.shippingType.get(String(o.shipping_type)) ?? "", String(o.cvs_store_name ?? ""), String(o.shipping_tag ?? ""), L.shippingProvider.get(String(o.shipping_provider)) ?? "", String(o.shipping_receipt_number ?? ""),
          taipeiDate(o.date_expected_shipping), L.deliverTime.get(String(o.deliver_time)) ?? "", itemsText(o), [16, 64].includes(Number(o.payment_method)) ? collect : 0, String(o.note ?? "")]);
      }
      return { body: await xlsx("ERP報表3", rows), filename: `ERP報表3_${stamp}.xlsx`, type: XLSX };
    }
    case "EXPORT_ERP4": {
      const rows: (string | number | null)[][] = [["訂單編號", "付款方式", "結帳金額", "已付金額", "付款日期", "繳款期限", "銀行名稱", "銀行帳號後五碼", "虛擬帳戶", "信用卡號", "狀態"]];
      for (const o of orders)
        rows.push([String(o.uuid), L.paymentMethod.get(String(o.payment_method)) ?? "", num(o.grand_total), num(o.total_paid), taipeiDateTime(o.date_paid), taipeiDateTime(o.date_payment_due),
          String(o.billing_bank_name ?? ""), String(o.billing_bank_account ?? ""), String(o.virtual_bank_account ?? ""), String(o.credit_card_number ?? ""), L.status.get(String(o.status)) ?? ""]);
      return { body: await xlsx("ERP報表4", rows), filename: `ERP報表4_${stamp}.xlsx`, type: XLSX };
    }
    case "EXPORT_ERP5": {
      const agg = new Map<string, { gb: string; title: string; uid: string; qty: number; amount: number }>();
      for (const o of orders) {
        if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(String(o.state))) continue;
        for (const i of o.order_items) {
          const k = `${o.group_buy_id}|${i.item_id ?? i.title}`;
          const a = agg.get(k) ?? { gb: o.group_buys?.title ?? "", title: String(i.title), uid: String(i.uid ?? ""), qty: 0, amount: 0 };
          a.qty += num(i.total);
          a.amount += num(i.amount);
          agg.set(k, a);
        }
      }
      return { body: await xlsx("ERP報表5", [["團購", "商品名稱", "商品代碼", "數量", "金額"], ...[...agg.values()].map((a) => [a.gb, a.title, a.uid, a.qty, a.amount])]), filename: `ERP報表5_${stamp}.xlsx`, type: XLSX };
    }
    case "EXPORT_ERP6": {
      const head = [...orderHeader().slice(0, -1), "商品名稱", "商品代碼", "數量", "單價", "小計"];
      const rows: (string | number | null)[][] = [head];
      for (const o of orders) {
        const base = orderLine(o, L).slice(0, -1);
        if (!o.order_items.length) rows.push(base);
        for (const i of o.order_items) rows.push([...base, String(i.title), String(i.uid ?? ""), num(i.total), num(i.price), num(i.amount)]);
      }
      return { body: await xlsx("ERP報表6", rows), filename: `ERP報表6_${stamp}.xlsx`, type: XLSX };
    }
  }
  throw badRequest("不支援的匯出格式");
}

/* ─────────────────────────── 列印 ─────────────────────────── */

const mask = (s: unknown, keepStart = 1, keepEnd = 0) => {
  const t = String(s ?? "");
  if (t.length <= keepStart + keepEnd) return t.replace(/./g, "*");
  return t.slice(0, keepStart) + "*".repeat(Math.max(1, t.length - keepStart - keepEnd)) + (keepEnd ? t.slice(-keepEnd) : "");
};

async function printData(ctx: RequestContext, session: AdminSession, ids: number[], kind: "ORDER" | "PIECE" | "C2C" | "BARCODE" | "QUOTATION") {
  const orders = await loadOrdersForExport(session, ids);
  const L = await labelMaps();
  const settings = await loadPrintSettings(session);
  const { data: tenant } = await db().from("billings").select("*").eq("tenant_id", session.tenantId).maybeSingle();
  const company = (tenant ?? {}) as Row;
  const view = orders.map((o, idx) => {
    const items = o.order_items.map((i, n) => ({
      seq: n + 1,
      title: i.title,
      spec: i.specifications_label ?? "",
      uid: i.uid ?? "",
      total: num(i.total),
      price: num(i.price),
      amount: num(i.amount),
      backOrder: !!i.back_order,
      gift: !!i.gift,
      child: !!i.bundle_child,
      note: i.attribute_note && !String(i.attribute_note).trim().startsWith("{") ? i.attribute_note : "",
    }));
    const subtotal = items.filter((i) => !i.child).reduce((s, i) => s + i.amount, 0);
    const pieces = [];
    for (const it of items.filter((i) => !i.child)) for (let k = 0; k < it.total && pieces.length < 500; k++) pieces.push({ ...it, pieceNo: k + 1 });
    return {
      index: idx + 1,
      salesOrderId: o.id,
      uuid: o.uuid,
      groupBuyTitle: o.group_buys?.title ?? "",
      dateCreatedString: taipeiDateTime(o.created_at),
      state: L.state.get(String(o.state)) ?? o.state,
      status: L.status.get(String(o.status)) ?? o.status,
      paymentMethod: L.paymentMethod.get(String(o.payment_method)) ?? "",
      shippingType: L.shippingType.get(String(o.shipping_type)) ?? "",
      deliverTime: L.deliverTime.get(String(o.deliver_time)) ?? "",
      customerFirstname: o.customer_firstname ?? "",
      customerTelephone: o.customer_telephone ?? "",
      customerEmail: o.customer_email ?? "",
      customerFirstnameMask: mask(o.customer_firstname, 1),
      customerTelephoneMask: mask(o.customer_telephone, 4, 3),
      shippingFirstname: o.shipping_firstname || o.customer_firstname || "",
      shippingTelephone: o.shipping_telephone || o.customer_telephone || "",
      shippingFirstnameMask: mask(o.shipping_firstname || o.customer_firstname, 1),
      shippingTelephoneMask: mask(o.shipping_telephone || o.customer_telephone, 4, 3),
      shippingAddress: shippingAddressOf(o),
      shippingAddressMask: mask(shippingAddressOf(o), 6),
      cvsStoreName: o.cvs_store_name ?? "",
      cvsStoreId: o.cvs_store_id ?? "",
      cvsAddress: o.cvs_address ?? "",
      receiptVatId: o.billing_receipt_vat_id ?? "",
      receiptTitle: o.billing_receipt_title ?? "",
      note: o.note ?? "",
      staffNote: o.staff_note ?? "",
      shippingTag: o.shipping_tag ?? "",
      shippingReceiptNumber: o.shipping_receipt_number ?? "",
      subtotal,
      discount: num(o.discount_amount),
      shippingAmount: num(o.shipping_amount),
      codFee: num(o.cod_fee),
      grandTotal: num(o.grand_total),
      totalPaid: num(o.total_paid),
      collect: num(o.total_paid) > 0 ? 0 : num(o.grand_total),
      tax: Math.round(num(o.grand_total) - num(o.grand_total) / 1.05),
      untaxed: Math.round(num(o.grand_total) / 1.05),
      unpaid: num(o.total_paid) === 0,
      items,
      pieces,
    };
  });
  return {
    ...commonVars(ctx),
    kind,
    isOrder: kind === "ORDER",
    isPiece: kind === "PIECE",
    isC2C: kind === "C2C",
    isBarcode: kind === "BARCODE",
    isQuotation: kind === "QUOTATION",
    title: { ORDER: "訂單", PIECE: "商品標籤", C2C: "超付取單", BARCODE: "訂單barcode", QUOTATION: "報價單" }[kind],
    orders: view,
    settings,
    company: {
      name: company.receipt_title ?? session.tenantName ?? "",
      vatId: company.receipt_vat_id ?? "",
      telephone: company.telephone ?? "",
      email: company.email ?? "",
      address: [company.postcode, company.city, company.district, company.street].filter(Boolean).join(""),
    },
    today: taipeiDate(new Date()),
    c2cNotice: kind === "C2C" ? "【未串接】超商付款取貨（綠界 C2C）托運單需由物流平台產生；本頁僅列印訂單取件資訊。" : "",
  };
}

async function renderPrint(ctx: RequestContext, ids: number[], kind: "ORDER" | "PIECE" | "C2C" | "BARCODE" | "QUOTATION"): Promise<Response> {
  const session = requireSession(ctx);
  const data = await printData(ctx, session, ids, kind);
  return html(renderTemplate("orders/salesorder-print.html", data));
}

/* ─────────────────────────── 端點 ─────────────────────────── */

const PRINT_ACTIONS: Record<string, "ORDER" | "PIECE" | "C2C" | "BARCODE"> = {
  PRINT_ORDER: "ORDER",
  PRINT_ORDER_PIECE: "PIECE",
  PRINT_C2C_ORDER_INFO: "C2C",
  PRINT_ORDER_BARCODE: "BARCODE",
};

async function exportBatchAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const action = await strParam(ctx, "batchAction");
  if (PRINT_ACTIONS[action]) {
    let ids = parseIds(await ctx.params_all("salesOrderId"));
    const uuids = (await strParam(ctx, "uuid")).split(/[,\s]+/).filter(Boolean);
    if (!ids.length && uuids.length) {
      const { data } = await db().from("sales_orders").select("id").eq("tenant_id", session.tenantId).in("uuid", uuids);
      ids = ((data ?? []) as { id: number }[]).map((r) => r.id);
    }
    return renderPrint(ctx, ids, PRINT_ACTIONS[action]);
  }
  try {
    const ids = await exportIds(session, ctx);
    const orders = await loadOrdersForExport(session, ids);
    const file = await buildExport(action, orders, await labelMaps());
    return download(file.body, file.filename, file.type);
  } catch (e) {
    // jquery.fileDownload 失敗時讀 HTML 內容（不設 fileDownload cookie）
    const msg = e instanceof Error ? e.message : String(e);
    return html(`<html><body><p>${msg.replace(/</g, "&lt;")}</p></body></html>`, { status: 400 });
  }
}

export const salesOrderExportRoutes: RouteDef[] = [
  { path: "/backend/SalesOrderExport/batchAction", method: ["GET", "POST"], handler: exportBatchAction },
  { path: "/backend/SalesOrder/batchAction", method: ["GET", "POST"], handler: exportBatchAction },
  { path: "/backend/SalesOrder/printOrder", method: ["GET"], handler: async (ctx) => renderPrint(ctx, parseIds(await ctx.params_all("salesOrderId")), "ORDER") },
  { path: "/backend/SalesOrder/printOrderQuotation", method: ["GET"], handler: async (ctx) => renderPrint(ctx, parseIds(await ctx.params_all("salesOrderId")), "QUOTATION") },
  { path: "/backend/SalesOrder/printC2COrderInfo", method: ["GET"], handler: async (ctx) => renderPrint(ctx, parseIds(await ctx.params_all("salesOrderId")), "C2C") },
];
