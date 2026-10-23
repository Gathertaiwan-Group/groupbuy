// 團購列表頁與列展開卡片的匯出（原站未擷取報表格式，欄位依原站名稱與資料推導）：
//   GET|POST /backend/SalesReturnRecord/exportDaily[?groupBuyId=]   匯出昨日銷退報表（昨日售出＋昨日退貨，台灣時間）
//   GET|POST /backend/GroupBuy/exportPaidOrderItems  groupBuyId、separateItem   匯出商品報表 → 已付款訂單商品
//   GET|POST /backend/GroupBuy/exportERPItems        groupBuyId                 匯出商品報表 → ERP 商品資料
//   （匯出商品報表 → 上月出貨商品統計 /backend/Item/exportItemSalesReport 由 analytics 模組處理：它是原站端點參數的超集）
//   （工具列「匯出貨運清單」彈窗 /backend/ShippingCSV/exportShippingCSV 由 shipping 模組提供）
// 下載回應走 download()（Set-Cookie fileDownload=true，jquery.fileDownload 判斷成功用）。
import ExcelJS from "exceljs";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, fragment, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { download } from "@/lib/core/http/responses";
import { enumLabel } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import { paymentBitsToCodes } from "@/lib/db/derived";
import { loadGroupBuyMenu } from "@/lib/core/groupbuy-menu";
import { ownGroupBuyIds, parseIdList } from "./common";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const VALID_STATES = ["NEW", "PROCESSING", "COMPLETE", "HOLDED", "RETURNING", "RETURNED"];

async function workbook(sheetName: string, headers: string[], rows: (string | number | null)[][], filename: string): Promise<Response> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => {
    c.width = 14;
  });
  const buf = await wb.xlsx.writeBuffer();
  return download(new Uint8Array(buf as ArrayBuffer), filename, XLSX);
}

async function requireGroupBuy(ctx: RequestContext, session: AdminSession) {
  const id = Number(await ctx.param("groupBuyId"));
  const gb = await loadGroupBuyMenu(session, Number.isSafeInteger(id) ? id : -1);
  if (!gb) throw notFound("找不到團購");
  return gb;
}

function stamp(): string {
  return taipeiDateTime(new Date()).replace(/[-: ]/g, "").slice(0, 12);
}

/* 匯出昨日銷退報表 */
async function exportDaily(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const today = taipeiDate(new Date());
  const startIso = new Date(new Date(`${today}T00:00:00+08:00`).getTime() - 86400000).toISOString();
  const endIso = new Date(`${today}T00:00:00+08:00`).toISOString();
  const gbIds = parseIdList(await ctx.param("groupBuyId"));
  const own = gbIds.length ? await ownGroupBuyIds(session, gbIds) : null;
  if (gbIds.length && own!.length === 0) throw notFound("找不到團購");

  let so = db
    .from("sales_orders")
    .select("id, group_buy_id, created_at, state")
    .eq("tenant_id", session.tenantId)
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .in("state", VALID_STATES);
  if (own) so = so.in("group_buy_id", own);
  const { data: orders, error } = await so.limit(5000);
  if (error) throw new Error(`[exportDaily] ${error.message}`);
  const orderIds = ((orders ?? []) as { id: number }[]).map((o) => o.id);
  const titles = new Map<number, string>();
  const { data: gbs } = await db.from("group_buys").select("id, title").eq("tenant_id", session.tenantId);
  for (const g of (gbs ?? []) as { id: number; title: string }[]) titles.set(Number(g.id), g.title);

  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < orderIds.length; i += 500) {
    const { data: items } = await db
      .from("order_items")
      .select("sales_order_id, group_buy_id, title, specifications_label, uid, total, amount, created_at")
      .eq("tenant_id", session.tenantId)
      .in("sales_order_id", orderIds.slice(i, i + 500));
    for (const it of (items ?? []) as { sales_order_id: number; group_buy_id: number; title: string; specifications_label: string | null; uid: string | null; total: number; amount: number; created_at: string }[]) {
      rows.push(["銷售", taipeiDateTime(it.created_at), it.sales_order_id, titles.get(Number(it.group_buy_id)) ?? "", it.title, it.specifications_label ?? "", it.uid ?? "", Number(it.total), Number(it.amount)]);
    }
  }
  let rr = db
    .from("sales_return_records")
    .select("sales_order_id, group_buy_id, title, uid, total, amount, date_returned")
    .eq("tenant_id", session.tenantId)
    .gte("date_returned", startIso)
    .lt("date_returned", endIso);
  if (own) rr = rr.in("group_buy_id", own);
  const { data: returns } = await rr.limit(5000);
  for (const r of (returns ?? []) as { sales_order_id: number; group_buy_id: number; title: string; uid: string | null; total: number; amount: number; date_returned: string }[]) {
    rows.push(["退貨", taipeiDateTime(r.date_returned), r.sales_order_id, titles.get(Number(r.group_buy_id)) ?? "", r.title, "", r.uid ?? "", -Number(r.total), -Number(r.amount)]);
  }
  const yesterday = taipeiDate(new Date(Date.now() - 86400000));
  return workbook("銷退報表", ["類型", "時間", "訂單編號", "團購", "商品名稱", "規格", "商品代碼", "數量", "金額"], rows, `銷退報表_${yesterday}.xlsx`);
}

/* 已付款訂單商品 */
async function exportPaidOrderItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await requireGroupBuy(ctx, session);
  const separate = ["true", "1", "on"].includes(String((await ctx.param("separateItem")) ?? ""));
  const db = getServiceClient();
  const { data: orders, error } = await db
    .from("sales_orders")
    .select("id, date_paid, created_at, customer_firstname, customer_telephone, customer_email, shipping_firstname, shipping_telephone, shipping_postcode, shipping_city, shipping_district, shipping_street, cvs_store_name, grand_total, shipping_amount, total_paid, payment_method, note, status")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.groupBuyId)
    .in("state", VALID_STATES)
    .gt("total_paid", 0)
    .order("id")
    .limit(5000);
  if (error) throw new Error(`[exportPaidOrderItems] ${error.message}`);
  type O = { id: number; date_paid: string | null; created_at: string; customer_firstname: string | null; customer_telephone: string | null; customer_email: string | null; shipping_firstname: string | null; shipping_telephone: string | null; shipping_postcode: string | null; shipping_city: string | null; shipping_district: string | null; shipping_street: string | null; cvs_store_name: string | null; grand_total: number; shipping_amount: number; total_paid: number; payment_method: number; note: string | null; status: string };
  const os = (orders ?? []) as O[];
  const items = new Map<number, { title: string; spec: string; uid: string; price: number; total: number; amount: number }[]>();
  for (let i = 0; i < os.length; i += 500) {
    const { data } = await db
      .from("order_items")
      .select("sales_order_id, title, specifications_label, uid, price, total, amount")
      .eq("tenant_id", session.tenantId)
      .in("sales_order_id", os.slice(i, i + 500).map((o) => o.id))
      .order("seq");
    for (const it of (data ?? []) as { sales_order_id: number; title: string; specifications_label: string | null; uid: string | null; price: number; total: number; amount: number }[]) {
      const arr = items.get(it.sales_order_id) ?? [];
      arr.push({ title: it.title, spec: it.specifications_label ?? "", uid: it.uid ?? "", price: Number(it.price), total: Number(it.total), amount: Number(it.amount) });
      items.set(it.sales_order_id, arr);
    }
  }
  const pmLabel = async (bits: number) => {
    const codes = paymentBitsToCodes(bits);
    return (await Promise.all(codes.map((c) => enumLabel("PaymentMethodCode", c)))).join("/");
  };
  const rows: (string | number | null)[][] = [];
  for (const o of os) {
    const addr = o.cvs_store_name ? `${o.cvs_store_name}` : [o.shipping_postcode, o.shipping_city, o.shipping_district, o.shipping_street].filter(Boolean).join("");
    const base = [o.id, taipeiDateTime(o.date_paid ?? o.created_at), o.customer_firstname ?? "", o.customer_telephone ?? "", o.customer_email ?? "", o.shipping_firstname ?? "", o.shipping_telephone ?? "", addr];
    const tail = [Number(o.grand_total), Number(o.shipping_amount), Number(o.total_paid), await pmLabel(Number(o.payment_method)), o.note ?? ""];
    const list = items.get(o.id) ?? [];
    if (separate) {
      for (const it of list) rows.push([...base, it.title, it.spec, it.uid, it.price, it.total, it.amount, ...tail]);
      if (list.length === 0) rows.push([...base, "", "", "", null, null, null, ...tail]);
    } else {
      rows.push([...base, list.map((it) => `${it.title}${it.spec ? `(${it.spec})` : ""} x${it.total}`).join("\n"), "", "", null, list.reduce((s, it) => s + it.total, 0), list.reduce((s, it) => s + it.amount, 0), ...tail]);
    }
  }
  return workbook(
    "已付款訂單商品",
    ["訂單編號", "付款時間", "訂購人", "訂購人電話", "Email", "收件人", "收件人電話", "收件地址/門市", "商品名稱", "規格", "商品代碼", "單價", "數量", "小計", "訂單金額", "運費", "已付金額", "付款方式", "備註"],
    rows,
    `已付款訂單商品_${gb.groupBuyId}_${stamp()}.xlsx`,
  );
}

/* ERP 商品資料 */
async function exportERPItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await requireGroupBuy(ctx, session);
  const db = getServiceClient();
  const { data: links } = await db.from("group_buy_item_sets").select("item_set_id, seq, option_offline, item_sets(title)").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.groupBuyId).order("seq");
  const sets = (links ?? []) as unknown as { item_set_id: number; option_offline: boolean; item_sets: { title: string } | null }[];
  const rows: (string | number | null)[][] = [];
  for (const s of sets) {
    const { data: items } = await db
      .from("items")
      .select("id, title, uid, upc, price, retail_price, cprice, stock, stock_available, stock_back_order, stock_back_order_available, offline, shipping_tag")
      .eq("tenant_id", session.tenantId)
      .eq("item_set_id", s.item_set_id)
      .order("seq");
    for (const it of (items ?? []) as { id: number; title: string; uid: string | null; upc: string | null; price: number; retail_price: number | null; cprice: number; stock: number; stock_available: number; stock_back_order: number; stock_back_order_available: number; offline: boolean; shipping_tag: string }[]) {
      rows.push([s.item_sets?.title ?? "", it.id, it.title, it.uid ?? "", it.upc ?? "", Number(it.price), it.retail_price == null ? null : Number(it.retail_price), Number(it.cprice), it.stock, it.stock_available, it.stock_back_order, it.stock_back_order_available, it.shipping_tag ?? "", it.offline || s.option_offline ? "下架" : "上架"]);
    }
  }
  return workbook(
    "商品",
    ["品項", "商品ID", "商品名稱", "商品代碼", "條碼", "售價", "原價", "成本", "原始庫存", "可售庫存", "預購數量", "可售預購", "貨運標籤", "狀態"],
    rows,
    `ERP商品_${gb.groupBuyId}_${stamp()}.xlsx`,
  );
}

export const exportRoutes: RouteDef[] = [
  any("/backend/SalesReturnRecord/exportDaily", exportDaily),
  any("/backend/GroupBuy/exportPaidOrderItems", exportPaidOrderItems),
  any("/backend/GroupBuy/exportERPItems", exportERPItems),
];
