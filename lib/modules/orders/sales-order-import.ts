// 匯入外部訂單（所有訂單頁工具列「匯入外部訂單」，原站 Editor：#importSalesOrdersForm／#importSalesOrdersTable）。
//   GET  /ajax/SalesOrder/getImportSalesOrderPreference?groupBuyId=   上次的欄位對應 {data:{colFirstname:'姓名',…, countryColMapping, paymentMethodColMapping}}
//   POST /ajax/SalesOrder/uploadSalesOrders                           Editor upload（xlsx/csv）→ {upload:{id}, data:[{label,value}]（檔案標頭）}
//   POST /ajax/SalesOrder/importSalesOrders?groupBuyId=               Editor create（preview=1 預覽／0 實際匯入）→ {data:[每列結果], options}
// 檔案解析結果暫存在 order_module_settings（name='importUpload'，匯入後刪除）。
// 每列＝一個商品；「來源平台訂單號碼」相同的列合併為同一張訂單（未指定則每列一張）。商品以「商品貨號」對應本團購的商品代碼（uid）。
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { randomUUID } from "node:crypto";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions } from "@/lib/core/enums";
import type { Row } from "@/lib/db/mapping";
import { addOrderHistory, adjustItemStock, db, strParam } from "./common";

const MAX_ROWS = 5000;
const COLS = [
  "merchantOrderId", "firstname", "telephone", "email", "country", "postcode", "city", "district", "street", "paymentMethod", "totalPaid",
  "shippingAmount", "creditCardNumber", "shippingReceiptNumber", "note", "invoiceNumber", "receiptTitle", "receiptVatId", "itemTitle", "itemUid",
  "itemPrice", "itemTotal", "itemPartBegin", "itemPartEnd",
] as const;
type Col = (typeof COLS)[number];

/* ─────────────────────────── 檔案解析 ─────────────────────────── */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text);
    if ("hyperlink" in o) return String(o.hyperlink);
    return JSON.stringify(v);
  }
  return String(v).trim();
}

async function parseFile(file: File): Promise<string[][]> {
  const buf = Buffer.from(await file.arrayBuffer());
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || buf.subarray(0, 2).toString("binary") === "PK") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest("檔案沒有工作表");
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map(cellText);
      rows.push(vals);
    });
    return rows;
  }
  if (name.endsWith(".xls")) throw badRequest("不支援舊版 .xls 格式，請另存為 .xlsx 或 .csv 後再上傳");
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.includes("�")) text = new TextDecoder("big5").decode(buf);
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true });
  return (parsed.data as string[][]).map((r) => r.map((c) => String(c ?? "").trim()));
}

/* ─────────────────────────── 端點 ─────────────────────────── */

async function getPreference(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = Number(await strParam(ctx, "groupBuyId")) || null;
  let q = db().from("order_module_settings").select("settings").eq("tenant_id", session.tenantId).eq("name", "importSalesOrderPreference");
  q = groupBuyId ? q.eq("group_buy_id", groupBuyId) : q.is("group_buy_id", null);
  const { data } = await q.maybeSingle();
  let settings = (data as Row | null)?.settings as Row | undefined;
  if (!settings) {
    const { data: any } = await db().from("order_module_settings").select("settings").eq("tenant_id", session.tenantId).eq("name", "importSalesOrderPreference").order("updated_at", { ascending: false }).limit(1);
    settings = ((any ?? []) as Row[])[0]?.settings as Row | undefined;
  }
  return json({ code: 200, data: settings ?? null });
}

/** Editor upload：解析檔案 → 暫存 → 回傳標頭選項 */
async function uploadSalesOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const file = body.files.get("upload")?.[0];
  if (!file) return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: "請選擇檔案" }] });
  let rows: string[][];
  try {
    rows = await parseFile(file);
  } catch (e) {
    return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: e instanceof Error ? e.message : "檔案格式錯誤" }] });
  }
  if (rows.length < 2) return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: "檔案沒有資料（第一列需為標頭）" }] });
  if (rows.length - 1 > MAX_ROWS) return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: `一次上限 ${MAX_ROWS} 行` }] });
  const headers = rows[0].map((h, i) => h || `第${i + 1}欄`);
  const id = randomUUID();
  const { error } = await db().from("order_module_settings").insert({
    tenant_id: session.tenantId,
    name: `importUpload:${id}`,
    settings: { fileName: file.name, headers, rows: rows.slice(1) },
  });
  if (error) throw new Error(`[orders import] 暫存檔案失敗：${error.message}`);
  const options = headers.map((h) => ({ label: h, value: h }));
  return json({ upload: { id }, files: { importSalesOrders: { [id]: { id, filename: file.name, rows: rows.length - 1 } } }, data: options });
}

function parseMapping(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(/[,，\n]/)) {
    const [k, v] = part.split("#").map((x) => (x ?? "").trim());
    if (k && v) m.set(k, v);
  }
  return m;
}

interface ParsedLine {
  rowNo: number;
  key: string;
  values: Record<Col, string>;
  parts: { header: string; qty: number }[];
}

async function importSalesOrders(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const v = (req.rows[0]?.values ?? {}) as Record<string, unknown>;
  const groupBuyId = Number(ctx.query.get("groupBuyId") ?? req.extra.groupBuyId) || 0;
  if (!groupBuyId) throw badRequest("請先在「團購」選擇要匯入的團購");
  const client = db();
  const { data: gb } = await client.from("group_buys").select("id,title").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
  if (!gb) throw badRequest("找不到此團購");
  const fileId = String(v.importSalesOrdersFile ?? "").trim();
  if (!fileId) return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: "請先上傳檔案" }], data: [] });
  const { data: up } = await client.from("order_module_settings").select("id,settings").eq("tenant_id", session.tenantId).eq("name", `importUpload:${fileId}`).maybeSingle();
  if (!up) return json({ fieldErrors: [{ name: "importSalesOrdersFile", status: "上傳的檔案已失效，請重新上傳" }], data: [] });
  const stash = (up as Row).settings as { headers: string[]; rows: string[][] };
  const colOf: Partial<Record<Col, number>> = {};
  const fieldErrors: { name: string; status: string }[] = [];
  for (const c of COLS) {
    const h = String(v[`${c}Col`] ?? "").trim();
    if (!h) continue;
    const idx = stash.headers.indexOf(h);
    if (idx < 0) fieldErrors.push({ name: `${c}Col`, status: "檔案中沒有此欄位" });
    else colOf[c] = idx;
  }
  for (const req of ["firstname", "telephone", "itemUid", "totalPaid"] as const) {
    if (colOf[req] === undefined && !fieldErrors.some((f) => f.name === `${req}Col`)) fieldErrors.push({ name: `${req}Col`, status: "需要選擇一個欄位" });
  }
  if (fieldErrors.length) return json({ fieldErrors, data: [] });
  const countryMap = parseMapping(String(v.countryColMapping ?? ""));
  const payMap = parseMapping(String(v.paymentMethodColMapping ?? ""));
  const preview = String(v.preview ?? "") === "1";

  // 商品：本團購綁定品項的商品，以 uid 對應
  const { data: gbis } = await client.from("group_buy_item_sets").select("id,item_set_id").eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId);
  const setIds = ((gbis ?? []) as { id: number; item_set_id: number }[]).map((g) => g.item_set_id);
  const gbisBySet = new Map(((gbis ?? []) as { id: number; item_set_id: number }[]).map((g) => [g.item_set_id, g.id]));
  const { data: itemRows } = setIds.length
    ? await client
        .from("items")
        .select("id,item_set_id,uid,title,price,stock_available,stock_back_order_available,share_stock,parent_item_id,shipping_tag")
        .eq("tenant_id", session.tenantId)
        .in("item_set_id", setIds)
    : { data: [] };
  const items = (itemRows ?? []) as Row[];
  const byUid = new Map(items.filter((i) => i.uid).map((i) => [String(i.uid).trim(), i]));
  // 庫存分配（同 storefront：可售現貨先用，不足的數量為預購）；共用庫存以主商品計
  const ownerOf = (it: Row) => (it.share_stock && it.parent_item_id ? Number(it.parent_item_id) : Number(it.id));
  const stockLeft = new Map<number, { inStock: number; back: number }>();
  for (const it of items) if (!it.share_stock || !it.parent_item_id) stockLeft.set(Number(it.id), { inStock: Number(it.stock_available) || 0, back: Number(it.stock_back_order_available) || 0 });
  const parentIds = [...new Set(items.filter((i) => i.share_stock && i.parent_item_id).map((i) => Number(i.parent_item_id)))].filter((id) => !stockLeft.has(id));
  if (parentIds.length) {
    const { data: ps } = await client.from("items").select("id,stock_available,stock_back_order_available").eq("tenant_id", session.tenantId).in("id", parentIds);
    for (const p of (ps ?? []) as Row[]) stockLeft.set(Number(p.id), { inStock: Number(p.stock_available) || 0, back: Number(p.stock_back_order_available) || 0 });
  }
  const allocate = (it: Row, qty: number) => {
    const left = stockLeft.get(ownerOf(it)) ?? { inStock: 0, back: 0 };
    const inQ = Math.min(qty, Math.max(0, left.inStock));
    const boQ = qty - inQ;
    left.inStock -= inQ;
    left.back -= boQ;
    stockLeft.set(ownerOf(it), left);
    return { inQ, boQ, backShort: boQ > 0 && left.back < 0 };
  };

  // 解析每一列
  const lines: ParsedLine[] = stash.rows.map((r, i) => {
    const values = {} as Record<Col, string>;
    for (const c of COLS) values[c] = colOf[c] !== undefined ? String(r[colOf[c]!] ?? "").trim() : "";
    const parts: { header: string; qty: number }[] = [];
    if (colOf.itemPartBegin !== undefined && colOf.itemPartEnd !== undefined) {
      for (let k = Math.min(colOf.itemPartBegin, colOf.itemPartEnd); k <= Math.max(colOf.itemPartBegin, colOf.itemPartEnd); k++) {
        const qty = Number(String(r[k] ?? "").replace(/,/g, ""));
        if (qty > 0) parts.push({ header: stash.headers[k], qty: Math.trunc(qty) });
      }
    }
    return { rowNo: i + 2, key: values.merchantOrderId || `#row${i + 2}`, values, parts };
  });
  const groups = new Map<string, ParsedLine[]>();
  for (const l of lines) {
    const g = groups.get(l.key) ?? [];
    g.push(l);
    groups.set(l.key, g);
  }
  const payOptions = (await enumOptions("SalesOrder.paymentMethod")).map((o) => ({ label: o.label, value: Number(o.value) }));
  const payByLabel = new Map(payOptions.map((o) => [o.label, o.value]));
  const resultRows: Row[] = [];
  let createdOrders = 0;

  for (const [key, g] of groups) {
    const head = g[0].values;
    const errors: string[] = [];
    if (!head.firstname) errors.push("缺少姓名");
    if (!head.telephone) errors.push("缺少電話");
    const orderLines: { item: Row | null; title: string; uid: string; price: number; qty: number }[] = [];
    for (const l of g) {
      const uid = l.values.itemUid;
      if (uid) {
        const item = byUid.get(uid) ?? null;
        if (!item) errors.push(`第${l.rowNo}列商品貨號 ${uid} 不存在於本團購`);
        const qty = Math.trunc(Number(l.values.itemTotal || 1)) || 1;
        const price = l.values.itemPrice !== "" && Number.isFinite(Number(l.values.itemPrice)) ? Number(l.values.itemPrice) : Number(item?.price ?? 0);
        orderLines.push({ item, title: l.values.itemTitle || String(item?.title ?? uid), uid, price, qty });
      }
      for (const p of l.parts) {
        const item = byUid.get(p.header) ?? items.find((i) => i.title === p.header) ?? null;
        if (!item) errors.push(`第${l.rowNo}列規格商品「${p.header}」不存在於本團購`);
        orderLines.push({ item, title: String(item?.title ?? p.header), uid: String(item?.uid ?? ""), price: Number(item?.price ?? 0), qty: p.qty });
      }
    }
    if (!orderLines.length) errors.push("缺少商品");
    let payment = 0;
    const payRaw = head.paymentMethod;
    if (payRaw) {
      const mapped = payMap.get(payRaw) ?? payRaw;
      payment = /^\d+$/.test(mapped) ? Number(mapped) : payByLabel.get(mapped) ?? 0;
      if (!payOptions.some((o) => o.value === payment)) errors.push(`付款方式「${payRaw}」無法對應`);
    }
    const country = head.country ? countryMap.get(head.country) ?? head.country : "TW";
    const totalPaid = Number(String(head.totalPaid).replace(/,/g, "")) || 0;
    const shippingAmount = Number(String(head.shippingAmount).replace(/,/g, "")) || 0;
    const subtotal = orderLines.reduce((s, l) => s + l.price * l.qty, 0);
    const grandTotal = subtotal + shippingAmount;
    let uuid = "";
    // 每列商品拆成現貨／預購兩部分
    const parts: { line: (typeof orderLines)[number]; qty: number; backOrder: boolean }[] = [];
    const notes: string[] = [];
    if (!errors.length) {
      for (const l of orderLines) {
        if (!l.item) {
          parts.push({ line: l, qty: l.qty, backOrder: false });
          continue;
        }
        const a = allocate(l.item, l.qty);
        if (a.inQ > 0) parts.push({ line: l, qty: a.inQ, backOrder: false });
        if (a.boQ > 0) {
          parts.push({ line: l, qty: a.boQ, backOrder: true });
          notes.push(`${l.title} 預購 ${a.boQ} 件${a.backShort ? "（預購可售不足）" : ""}`);
        }
      }
    }
    let log = errors.length ? errors.join("；") : preview ? `預覽：可匯入${notes.length ? `（${notes.join("、")}）` : ""}` : "";
    if (!errors.length && !preview) {
      const { data: so, error } = await client
        .from("sales_orders")
        .insert({
          tenant_id: session.tenantId,
          group_buy_id: groupBuyId,
          state: "PROCESSING",
          status: totalPaid >= grandTotal && grandTotal > 0 ? "PAID_EMAIL_SENT" : "ORDER_EMAIL_SENT",
          grand_total: grandTotal,
          shipping_amount: shippingAmount,
          total_paid: totalPaid,
          date_paid: totalPaid > 0 ? new Date().toISOString() : null,
          payment_method: payment,
          customer_firstname: head.firstname,
          customer_telephone: head.telephone,
          customer_email: head.email || null,
          billing_country: country.slice(0, 2).toUpperCase() || "TW",
          shipping_firstname: head.firstname,
          shipping_telephone: head.telephone,
          shipping_email: head.email || null,
          shipping_country: country.slice(0, 2).toUpperCase() || "TW",
          shipping_postcode: head.postcode || null,
          shipping_city: head.city || null,
          shipping_district: head.district || null,
          shipping_street: head.street || null,
          billing_postcode: head.postcode || null,
          billing_city: head.city || null,
          billing_district: head.district || null,
          billing_street: head.street || null,
          credit_card_number: head.creditCardNumber || null,
          shipping_receipt_number: head.shippingReceiptNumber || null,
          invoice_number: head.invoiceNumber || null,
          billing_receipt_title: head.receiptTitle || null,
          billing_receipt_vat_id: head.receiptVatId || null,
          billing_receipt_type: head.receiptVatId ? 2 : 1,
          note: head.note || null,
          api_user_data: key.startsWith("#row") ? null : key,
          shipping_tag: [...new Set(orderLines.map((l) => String(l.item?.shipping_tag ?? "")).filter(Boolean))].join("#"),
        })
        .select("id,uuid")
        .single();
      if (error) {
        log = `匯入失敗：${error.message}`;
      } else {
        const o = so as { id: number; uuid: string };
        uuid = o.uuid;
        const { error: itemErr } = await client.from("order_items").insert(
          parts.map(({ line: l, qty, backOrder }, n) => ({
            tenant_id: session.tenantId,
            sales_order_id: o.id,
            group_buy_id: groupBuyId,
            group_buy_item_set_id: l.item ? gbisBySet.get(Number(l.item.item_set_id)) ?? null : null,
            item_set_id: l.item?.item_set_id ?? null,
            item_id: l.item?.id ?? null,
            seq: n + 1,
            title: l.title,
            uid: l.uid || null,
            price: l.price,
            total: qty,
            amount: Math.round(l.price * qty),
            discount: 0,
            back_order: backOrder,
            gift: false,
            bundle_root: false,
            bundle_child: false,
            shipping_tag: String(l.item?.shipping_tag ?? ""),
            state: "UNSHIPPING",
          })),
        );
        if (itemErr) throw new Error(`[orders import] 寫入訂單商品失敗：${itemErr.message}`);
        await adjustItemStock(
          session,
          parts.filter((x) => x.line.item).map((x) => ({ itemId: Number(x.line.item!.id), qty: -x.qty, backOrder: x.backOrder })),
        );
        await client.from("sales_order_histories").update({ actor: "ADMIN", admin_user_id: session.adminUserId, note: "匯入外部訂單" }).eq("tenant_id", session.tenantId).eq("sales_order_id", o.id);
        log = `匯入成功${notes.length ? `（${notes.join("、")}）` : ""}`;
        createdOrders++;
      }
    }
    for (const l of g) {
      resultRows.push({
        uuid,
        merchantOrderId: l.values.merchantOrderId,
        firstname: l.values.firstname,
        telephone: l.values.telephone,
        email: l.values.email,
        country: l.values.country,
        postcode: l.values.postcode,
        city: l.values.city,
        district: l.values.district,
        street: l.values.street,
        paymentMethod: payment,
        totalPaid: l.values.totalPaid,
        shippingAmount: l.values.shippingAmount,
        creditCardNumber: l.values.creditCardNumber,
        shippingReceiptNumber: l.values.shippingReceiptNumber,
        invoiceNumber: l.values.invoiceNumber,
        receiptTitle: l.values.receiptTitle,
        receiptVatId: l.values.receiptVatId,
        itemTitle: l.values.itemTitle,
        itemUid: l.values.itemUid,
        itemPrice: l.values.itemPrice,
        itemTotal: l.values.itemTotal,
        log,
      });
    }
  }

  // 記住欄位對應（下次自動帶入；鍵名 col＋欄位，同原站 getImportSalesOrderPreference）
  const pref: Record<string, unknown> = {};
  for (const c of COLS) pref[`col${c.charAt(0).toUpperCase()}${c.slice(1)}`] = String(v[`${c}Col`] ?? "") || -1;
  pref.countryColMapping = String(v.countryColMapping ?? "");
  pref.paymentMethodColMapping = String(v.paymentMethodColMapping ?? "");
  const { data: existing } = await client.from("order_module_settings").select("id").eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId).eq("name", "importSalesOrderPreference").maybeSingle();
  if (existing) await client.from("order_module_settings").update({ settings: pref }).eq("tenant_id", session.tenantId).eq("id", (existing as Row).id);
  else await client.from("order_module_settings").insert({ tenant_id: session.tenantId, group_buy_id: groupBuyId, name: "importSalesOrderPreference", settings: pref });
  if (!preview) {
    await client.from("order_module_settings").delete().eq("tenant_id", session.tenantId).eq("name", `importUpload:${fileId}`);
    const created = resultRows.filter((r) => String(r.log).startsWith("匯入成功")).map((r) => String(r.uuid));
    if (created.length) {
      const { data: ids } = await client.from("sales_orders").select("id").eq("tenant_id", session.tenantId).in("uuid", [...new Set(created)]);
      for (const r of (ids ?? []) as { id: number }[]) await addOrderHistory(session, r.id, `匯入外部訂單（${(gb as Row).title}）`);
    }
  }
  return json({ data: resultRows, options: { paymentMethod: payOptions }, recordsTotal: resultRows.length, createdOrders });
}

/** 清掉超過一天的暫存上傳 */
export async function purgeImportUploads(session: AdminSession): Promise<void> {
  await db()
    .from("order_module_settings")
    .delete()
    .eq("tenant_id", session.tenantId)
    .like("name", "importUpload:%")
    .lt("created_at", new Date(Date.now() - 86400_000).toISOString());
}

export const salesOrderImportRoutes: RouteDef[] = [
  get("/ajax/SalesOrder/getImportSalesOrderPreference", getPreference),
  post("/ajax/SalesOrder/uploadSalesOrders", async (ctx) => {
    const session = requireSession(ctx);
    await purgeImportUploads(session);
    return uploadSalesOrders(ctx);
  }),
  post("/ajax/SalesOrder/importSalesOrders", importSalesOrders),
];
