// 匯出／匯入商品 XLS（ItemTemplate）與商品庫存。
// 匯出格式依原站實際下載檔：工作表 ITEMS、36 欄、全部字串；每個品項先列商品、再附 3 列空白（新增商品用）。
// 匯入：前端以原站同版 SheetJS（cdnjs xlsx 0.18.5）在瀏覽器解析 .xls/.xlsx/.csv 成 rowsJson 一併送出；
//       沒有 rowsJson 時伺服器端以 exceljs（.xlsx）/ papaparse（.csv）解析。
import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest } from "@/lib/core/http/errors";
import { download, html, json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { enumOptions } from "@/lib/core/enums";
import { b, db, dbErr, loadGroupBuy, n, nOrNull, parseIds, relImage, s, selectAll, selectIn, type GroupBuyRow, type Row } from "./common";
import { logStock, STOCK_FIELD_LABEL } from "./item";

/** 原站 XLS 表頭（順序與文字照原站） */
export const TEMPLATE_HEADERS = [
  "品項名稱（*系統欄位，請勿修改內容）",
  "品項ID（*系統欄位，請勿修改內容）",
  "商品ID（*系統欄位，請勿修改內容，新增商品請留空白）",
  "排序",
  "商品名稱（*必填）",
  "短名稱（表單顯示）",
  "短名稱（出貨用）",
  "商品代碼",
  "國際條碼",
  "名稱標籤",
  "分類標籤",
  "原價",
  "團購價（*必填）",
  "成本",
  "原始現貨庫存",
  "可售現貨數量",
  "原始預購庫存",
  "剩餘可預購量",
  "最大下單量",
  "分頁1標題",
  "分頁1內容",
  "分頁2標題",
  "分頁2內容",
  "分頁3標題",
  "分頁3內容",
  "短敘述1",
  "圖片",
  "彈出圖片",
  "跑馬燈圖片1",
  "跑馬燈圖片2",
  "跑馬燈圖片3",
  "跑馬燈圖片4",
  "分潤(%)",
  "分潤(元/個)",
  "下架(true/false)",
  "商品種類(唯讀)",
];

/** 表頭 → 內部鍵（比對時去掉括號說明，容許使用者改動說明文字） */
const HEADER_KEYS: [string, string][] = [
  ["品項名稱", "itemSetTitle"],
  ["品項ID", "itemSetId"],
  ["商品ID", "itemId"],
  ["排序", "seq"],
  ["商品名稱", "title"],
  ["短名稱（表單顯示）", "shortNameDisplay"],
  ["短名稱（出貨用）", "shortName"],
  ["商品代碼", "uid"],
  ["國際條碼", "upc"],
  ["名稱標籤", "tag"],
  ["分類標籤", "cateTag"],
  ["原價", "retailPrice"],
  ["團購價", "price"],
  ["成本", "cprice"],
  ["原始現貨庫存", "stock"],
  ["可售現貨數量", "stockAvailable"],
  ["原始預購庫存", "stockBackOrder"],
  ["剩餘可預購量", "stockBackOrderAvailable"],
  ["最大下單量", "maxOrderQuota"],
  ["分頁1標題", "tab1Title"],
  ["分頁1內容", "tab1Descr"],
  ["分頁2標題", "tab2Title"],
  ["分頁2內容", "tab2Descr"],
  ["分頁3標題", "tab3Title"],
  ["分頁3內容", "tab3Descr"],
  ["短敘述1", "shortDescr1"],
  ["圖片", "image"],
  ["彈出圖片", "imagePopup"],
  ["跑馬燈圖片1", "carousel1"],
  ["跑馬燈圖片2", "carousel2"],
  ["跑馬燈圖片3", "carousel3"],
  ["跑馬燈圖片4", "carousel4"],
  ["分潤(%)", "commissionRate"],
  ["分潤(元/個)", "commissionDollar"],
  ["下架", "offline"],
  ["商品種類", "itemTypeLabel"],
];

function headerKey(h: string): string | null {
  const x = s(h).trim();
  if (!x) return null;
  // 先比完整（短名稱兩欄只差括號內容），再比前綴
  for (const [label, key] of HEADER_KEYS) if (x === label) return key;
  for (const [label, key] of HEADER_KEYS) {
    if (label.includes("（")) continue;
    if (x.startsWith(label)) return key;
  }
  return null;
}

const money2 = (v: unknown) => (v === null || v === undefined || v === "" ? "" : n(v).toFixed(2));

async function loadGroupBuyItems(session: AdminSession, gb: GroupBuyRow, gbisIds?: number[]) {
  const t = session.tenantId;
  let gbis = await selectAll<Row>(
    (f, to) =>
      db()
        .from("group_buy_item_sets")
        .select("id, seq, item_set_id, item_sets(title)")
        .eq("tenant_id", t)
        .eq("group_buy_id", gb.id)
        .order("seq")
        .order("id")
        .range(f, to),
    "group_buy_item_sets",
  );
  if (gbisIds && gbisIds.length) gbis = gbis.filter((g) => gbisIds.includes(Number(g.id)));
  const setIds = [...new Set(gbis.map((g) => Number(g.item_set_id)))];
  const items = setIds.length ? await selectIn<Row>("items", "*", "item_set_id", setIds, t) : [];
  items.sort((a, c) => n(a.seq) - n(c.seq) || Number(a.id) - Number(c.id));
  return { gbis, items };
}

function safeFileName(title: string, fallback: string): string {
  const x = s(title).replace(/[\\/:*?"<>|\r\n]+/g, "").trim();
  return x || fallback;
}

/** GET /backend/ItemTemplate/exportItemTemplate?groupBuyId= → {團購名稱}.xlsx */
export async function exportItemTemplate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await loadGroupBuy(session, await ctx.param("groupBuyId"));
  const { gbis, items } = await loadGroupBuyItems(session, gb);
  const typeLabels = new Map((await enumOptions("Item.itemType")).map((o) => [String(o.value), o.label]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ITEMS");
  ws.addRow(TEMPLATE_HEADERS);
  for (const g of gbis) {
    const isTitle = s((g.item_sets as Row | null)?.title);
    const isId = String(g.item_set_id);
    for (const it of items.filter((i) => Number(i.item_set_id) === Number(g.item_set_id))) {
      const st = (it.item_settings as Row) ?? {};
      ws.addRow([
        isTitle,
        isId,
        String(it.id),
        String(n(it.seq)),
        s(it.title),
        s(it.short_name_display),
        s(it.short_name),
        s(it.uid),
        s(it.upc),
        s(it.tag),
        s(it.cate_tag),
        money2(it.retail_price) || "0.00",
        money2(it.price),
        money2(it.cprice),
        String(n(it.stock)),
        String(n(it.stock_available)),
        String(n(it.stock_back_order)),
        String(n(it.stock_back_order_available)),
        String(n(it.max_order_quota, 10)),
        s(it.tab1_title),
        s(it.tab1_descr),
        s(it.tab2_title),
        s(it.tab2_descr),
        s(it.tab3_title),
        s(it.tab3_descr),
        s(st.shortDescr1),
        relImage(it.image),
        relImage(it.image_popup),
        relImage(st.carousel1),
        relImage(st.carousel2),
        relImage(st.carousel3),
        relImage(st.carousel4),
        money2(it.commission_rate),
        money2(it.commission_dollar),
        b(it.offline) ? "true" : "false",
        typeLabels.get(s(it.item_type) || "NORMAL") ?? s(it.item_type),
      ]);
    }
    for (let i = 0; i < 3; i++) {
      ws.addRow([isTitle, isId, "", "0", "", "", "", "", "", "", "", "0", "0", "0", "0", "0", "0", "0", "10", "", "", "", "", "", "", "", "", "", "", "", "", "", "0", "0", "false", "一般商品"]);
    }
  }
  // 全部以文字格式存放（同原站）
  ws.eachRow((row) => row.eachCell((cell) => (cell.numFmt = "@")));
  const buf = await wb.xlsx.writeBuffer();
  return download(new Uint8Array(buf as ArrayBuffer), `${safeFileName(gb.title, "items")}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/** POST /backend/ItemTemplate/exportStock（groupBuyItemSetId=1,2）→ 商品庫存.xlsx（推導格式，供「匯入商品庫存」使用） */
export const STOCK_HEADERS = ["品項名稱", "品項ID", "商品ID（*請勿修改）", "商品名稱", "商品代碼", "原始現貨庫存", "可售現貨數量", "原始預購庫存", "可售預購數量"];

export async function exportStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = parseIds(await ctx.params_all("groupBuyItemSetId"));
  if (!ids.length) return html("<p>請選擇品項</p>", { status: 400 });
  const gbisRows = await selectIn<Row>("group_buy_item_sets", "id, group_buy_id", "id", ids, session.tenantId);
  if (!gbisRows.length) return html("<p>找不到品項</p>", { status: 404 });
  const gb = await loadGroupBuy(session, gbisRows[0].group_buy_id);
  const { gbis, items } = await loadGroupBuyItems(session, gb, ids);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("STOCK");
  ws.addRow(STOCK_HEADERS);
  for (const g of gbis) {
    for (const it of items.filter((i) => Number(i.item_set_id) === Number(g.item_set_id))) {
      ws.addRow([
        s((g.item_sets as Row | null)?.title),
        String(g.item_set_id),
        String(it.id),
        s(it.title),
        s(it.uid),
        String(n(it.stock)),
        String(n(it.stock_available)),
        String(n(it.stock_back_order)),
        String(n(it.stock_back_order_available)),
      ]);
    }
  }
  ws.eachRow((row) => row.eachCell((cell) => (cell.numFmt = "@")));
  const buf = await wb.xlsx.writeBuffer();
  return download(new Uint8Array(buf as ArrayBuffer), `${safeFileName(gb.title, "stock")}-商品庫存.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/* ───────────────────────── 解析上傳檔 ───────────────────────── */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Row;
    if ("text" in o) return s(o.text);
    if ("result" in o) return s(o.result);
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as Row[]).map((r) => s(r.text)).join("");
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

/** 讀取上傳的表格（優先用前端 SheetJS 解析好的 rowsJson） */
export async function readUploadedRows(ctx: RequestContext): Promise<string[][]> {
  const body = await ctx.body();
  const rowsJson = body.flat.get("rowsJson")?.[0];
  if (rowsJson) {
    try {
      const rows = JSON.parse(rowsJson) as unknown[][];
      if (Array.isArray(rows)) return rows.map((r) => (Array.isArray(r) ? r.map((c) => cellText(c)) : []));
    } catch {
      /* 改用伺服器端解析 */
    }
  }
  const file = body.files.get("imageFile")?.[0] ?? [...body.files.values()][0]?.[0];
  if (!file) throw badRequest("請選擇要上傳的檔案");
  if (file.size > 4 * 1024 * 1024) throw badRequest("檔案過大（上限 4MB）");
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
    return (parsed.data as string[][]).map((r) => r.map((c) => s(c)));
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw badRequest("無法讀取檔案：請使用 .xlsx 或 .csv（舊版 .xls 請在瀏覽器重新整理後再上傳）");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest("檔案內沒有工作表");
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const vals = row.values as unknown[];
    const arr: string[] = [];
    for (let i = 1; i < vals.length; i++) arr.push(cellText(vals[i]));
    rows[rowNumber - 1] = arr;
  });
  return Array.from(rows, (r) => r ?? []);
}

/* ───────────────────────── 匯入商品 XLS ───────────────────────── */

const NUM_KEYS = new Set(["retailPrice", "price", "cprice", "commissionRate", "commissionDollar"]);
const INT_KEYS = new Set(["seq", "stock", "stockAvailable", "stockBackOrder", "stockBackOrderAvailable", "maxOrderQuota"]);
const COL: Record<string, string> = {
  seq: "seq",
  title: "title",
  shortNameDisplay: "short_name_display",
  shortName: "short_name",
  uid: "uid",
  upc: "upc",
  tag: "tag",
  cateTag: "cate_tag",
  retailPrice: "retail_price",
  price: "price",
  cprice: "cprice",
  stock: "stock",
  stockAvailable: "stock_available",
  stockBackOrder: "stock_back_order",
  stockBackOrderAvailable: "stock_back_order_available",
  maxOrderQuota: "max_order_quota",
  tab1Title: "tab1_title",
  tab1Descr: "tab1_descr",
  tab2Title: "tab2_title",
  tab2Descr: "tab2_descr",
  tab3Title: "tab3_title",
  tab3Descr: "tab3_descr",
  image: "image",
  imagePopup: "image_popup",
  commissionRate: "commission_rate",
  commissionDollar: "commission_dollar",
  offline: "offline",
};
const STOCK_KEYS = ["stock", "stockAvailable", "stockBackOrder", "stockBackOrderAvailable"];

/** POST /ajax/ItemTemplate/importItemCSV（multipart：imageFile、groupBuyId[、rowsJson]）→ { code:200, error:'匯入結果' } */
export async function importItemCSV(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const gb = await loadGroupBuy(session, await ctx.param("groupBuyId"));
  const rows = await readUploadedRows(ctx);
  const headerIdx = rows.findIndex((r) => r.some((c) => headerKey(c) === "itemId") && r.some((c) => headerKey(c) === "title"));
  if (headerIdx < 0) throw badRequest("檔案格式不符：找不到表頭（請使用「匯出商品XLS」下載的範本）");
  const keys = rows[headerIdx].map((h) => headerKey(h));
  const { gbis, items } = await loadGroupBuyItems(session, gb);
  const setByTitle = new Map<string, number>();
  const setIds = new Set<number>();
  for (const g of gbis) {
    setIds.add(Number(g.item_set_id));
    const tt = s((g.item_sets as Row | null)?.title);
    if (!setByTitle.has(tt)) setByTitle.set(tt, Number(g.item_set_id));
  }
  const itemById = new Map(items.map((i) => [Number(i.id), i]));
  const seqBySet = new Map<number, number>();
  for (const it of items) seqBySet.set(Number(it.item_set_id), Math.max(seqBySet.get(Number(it.item_set_id)) ?? 0, n(it.seq)));
  let gbisSeq = gbis.reduce((m, g) => Math.max(m, n(g.seq)), 0);
  const result = { created: 0, updated: 0, skipped: 0, newItemSets: 0 };
  const errors: string[] = [];
  for (let ri = headerIdx + 1; ri < rows.length; ri++) {
    const r = rows[ri];
    if (!r || r.every((c) => !s(c).trim())) continue;
    const v: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (k) v[k] = s(r[i]).trim();
    });
    const itemId = nOrNull(v.itemId);
    if (!itemId && !v.title) continue; // 範本空白列
    let itemSetId = nOrNull(v.itemSetId);
    if (itemSetId && !setIds.has(itemSetId)) {
      errors.push(`第 ${ri + 1} 列：品項ID ${itemSetId} 不屬於此團購`);
      result.skipped++;
      continue;
    }
    if (!itemSetId) {
      const tt = v.itemSetTitle;
      if (!tt) {
        errors.push(`第 ${ri + 1} 列：缺少品項`);
        result.skipped++;
        continue;
      }
      itemSetId = setByTitle.get(tt) ?? null;
      if (!itemSetId) {
        const ins = await db().from("item_sets").insert({ tenant_id: t, title: tt }).select("id").single();
        dbErr(ins.error, "匯入新增品項");
        itemSetId = Number((ins.data as Row).id);
        gbisSeq++;
        const g2 = await db().from("group_buy_item_sets").insert({ tenant_id: t, group_buy_id: gb.id, item_set_id: itemSetId, seq: gbisSeq });
        dbErr(g2.error, "匯入新增品項");
        setByTitle.set(tt, itemSetId);
        setIds.add(itemSetId);
        result.newItemSets++;
      }
    }
    const patch: Row = {};
    const settingsPatch: Row = {};
    for (const [k, col] of Object.entries(COL)) {
      if (!(k in v)) continue;
      const raw = v[k];
      if (STOCK_KEYS.includes(k) && raw === "") continue; // 清空庫存欄＝以系統庫存為主
      if (k === "offline") patch[col] = b(raw);
      else if (INT_KEYS.has(k)) {
        if (raw === "") continue;
        if (!Number.isFinite(Number(raw.replace(/,/g, "")))) {
          errors.push(`第 ${ri + 1} 列：${k} 不是數字`);
          continue;
        }
        patch[col] = Math.trunc(n(raw));
      } else if (NUM_KEYS.has(k)) {
        if (raw === "") {
          if (k === "retailPrice") patch[col] = null;
          continue;
        }
        if (!Number.isFinite(Number(raw.replace(/,/g, "")))) {
          errors.push(`第 ${ri + 1} 列：${k} 不是數字`);
          continue;
        }
        patch[col] = n(raw);
      } else patch[col] = raw;
    }
    for (const k of ["shortDescr1", "carousel1", "carousel2", "carousel3", "carousel4"]) if (k in v) settingsPatch[k] = v[k];
    if (itemId) {
      const ex = itemById.get(itemId);
      if (!ex) {
        errors.push(`第 ${ri + 1} 列：商品ID ${itemId} 不屬於此團購`);
        result.skipped++;
        continue;
      }
      if (Number(ex.item_set_id) !== itemSetId) patch.item_set_id = itemSetId;
      if (Object.keys(settingsPatch).length) patch.item_settings = { ...((ex.item_settings as Row) ?? {}), ...settingsPatch };
      if (!s(patch.title ?? ex.title)) {
        errors.push(`第 ${ri + 1} 列：商品名稱必填`);
        result.skipped++;
        continue;
      }
      const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", itemId);
      dbErr(u.error, "匯入更新商品");
      for (const k of STOCK_KEYS) {
        const col = COL[k];
        if (col in patch && Number(patch[col]) !== Number(ex[col])) await logStock(session, itemId, "IMPORT", k, ex[col], patch[col]);
      }
      result.updated++;
    } else {
      if (!s(patch.title)) {
        errors.push(`第 ${ri + 1} 列：商品名稱必填`);
        result.skipped++;
        continue;
      }
      if (patch.price === undefined) {
        errors.push(`第 ${ri + 1} 列：團購價必填`);
        result.skipped++;
        continue;
      }
      const seq = patch.seq !== undefined && n(patch.seq) > 0 ? n(patch.seq) : (seqBySet.get(itemSetId) ?? 0) + 1;
      seqBySet.set(itemSetId, Math.max(seqBySet.get(itemSetId) ?? 0, seq));
      const row: Row = {
        cprice: 0,
        stock: 0,
        max_order_quota: 10,
        stock_back_order: 0,
        commission_rate: 0,
        commission_dollar: 0,
        ...patch,
        tenant_id: t,
        item_set_id: itemSetId,
        seq,
        short_name: patch.short_name || patch.title,
        short_name_display: patch.short_name_display || patch.title,
        item_settings: settingsPatch,
      };
      // 新商品可售數量未填或維持範本預設 0 → 等於原始數量（與新增商品編輯器一致，推導）
      if (row.stock_available === undefined || (n(row.stock_available) === 0 && n(row.stock) > 0)) row.stock_available = row.stock;
      if (row.stock_back_order_available === undefined || (n(row.stock_back_order_available) === 0 && n(row.stock_back_order) > 0)) {
        row.stock_back_order_available = row.stock_back_order;
      }
      const ins = await db().from("items").insert(row).select("id").single();
      dbErr(ins.error, "匯入新增商品");
      const newId = Number((ins.data as Row).id);
      if (n(row.stock)) await logStock(session, newId, "IMPORT", "stock", null, row.stock);
      result.created++;
    }
  }
  const msg =
    `匯入完成：新增 ${result.created} 個商品、更新 ${result.updated} 個商品` +
    (result.newItemSets ? `、新增 ${result.newItemSets} 個品項` : "") +
    (result.skipped ? `、略過 ${result.skipped} 列` : "") +
    (errors.length ? `<br>${errors.slice(0, 20).join("<br>")}` : "");
  return json({ code: 200, error: msg, message: msg, data: result });
}

/** POST /ajax/ItemTemplate/importItemStock（multipart：imageFile、groupBuyId）→ { code:200, data:[{title, fieldString, oriValue, newValue}] } */
export async function importItemStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const gb = await loadGroupBuy(session, await ctx.param("groupBuyId"));
  const rows = await readUploadedRows(ctx);
  const headerIdx = rows.findIndex((r) => r.some((c) => s(c).startsWith("商品ID")));
  if (headerIdx < 0) throw badRequest("檔案格式不符：找不到「商品ID」欄（請使用「匯出商品庫存」下載的檔案）");
  const head = rows[headerIdx].map((h) => s(h).trim());
  const idx = (label: string) => head.findIndex((h) => h.startsWith(label));
  const cId = idx("商品ID");
  const cols: [string, number][] = [
    ["stock", idx("原始現貨庫存")],
    ["stockAvailable", idx("可售現貨數量")],
    ["stockBackOrder", idx("原始預購庫存")],
    ["stockBackOrderAvailable", head.findIndex((h) => h.startsWith("可售預購數量") || h.startsWith("剩餘可預購量"))],
  ];
  const map: Record<string, string> = { stock: "stock", stockAvailable: "stock_available", stockBackOrder: "stock_back_order", stockBackOrderAvailable: "stock_back_order_available" };
  const { items } = await loadGroupBuyItems(session, gb);
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const logs: Row[] = [];
  for (let ri = headerIdx + 1; ri < rows.length; ri++) {
    const r = rows[ri] ?? [];
    const id = nOrNull(r[cId]);
    if (!id) continue;
    const ex = byId.get(id);
    if (!ex) continue;
    const patch: Row = {};
    for (const [k, ci] of cols) {
      if (ci < 0) continue;
      const raw = s(r[ci]).trim();
      if (raw === "" || !Number.isFinite(Number(raw))) continue;
      const nv = Math.trunc(Number(raw));
      if (nv !== n(ex[map[k]])) {
        patch[map[k]] = nv;
        logs.push({ title: s(ex.title), field: k, fieldString: STOCK_FIELD_LABEL[k], oriValue: n(ex[map[k]]), newValue: nv });
      }
    }
    if (!Object.keys(patch).length) continue;
    const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", id);
    dbErr(u.error, "匯入商品庫存");
    for (const [k] of cols) if (map[k] in patch) await logStock(session, id, "IMPORT_STOCK", k, ex[map[k]], patch[map[k]]);
  }
  return json({ code: 200, error: `已更新 ${logs.length} 筆庫存`, data: logs });
}
