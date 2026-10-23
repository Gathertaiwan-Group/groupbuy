// 入庫紀錄（/backend/InboundRecord/list）：確認入庫時寫入（wms_receive_inbound），出貨時 FIFO 扣減剩餘數量（觸發器 wms_consume_inbound_records）。
// 原站：spec/html/inboundrecord-list.html、spec/runtime/inboundrecord-list.records.txt。
//   POST /ajax/InboundRecord/list                    列表（篩選：daysSinceLastSaleGreater 入庫天數超過、quantityRemainingGreater 剩餘庫存超過）
//   POST /ajax/InboundRecord/save|update|delete      原站頁面有 Editor 設定但按鈕皆停用；保留端點（只允許修正剩餘數量／最後銷售日期）
//   POST /backend/InboundRecord/download             匯出 Excel（#queryForm）
import ExcelJS from "exceljs";
import { inboundRecord as inboundRecordEntity } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { download } from "@/lib/core/http/responses";
import { editorEntity, type WriteSpec } from "@/lib/core/entity/crud";
import type { DtRequest } from "@/lib/core/datatables/request";
import { type AnyRow, dateTime, db, expectAction, fetchAll, toInt, warehouseMap, wmsList } from "./shared";

const DAY = 86400000;

function daysSince(v: unknown): number | null {
  if (!v) return null;
  const t = new Date(String(v)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

function recordJson(r: AnyRow, whName: string): AnyRow {
  const quantity = Number(r.quantity ?? 0);
  const remaining = Number(r.quantity_remaining ?? 0);
  return {
    inboundRecordId: Number(r.id),
    warehouseId: r.warehouse_id == null ? null : Number(r.warehouse_id),
    warehouseName: whName,
    inboundId: r.inbound_id == null ? null : Number(r.inbound_id),
    itemId: r.item_id == null ? null : Number(r.item_id),
    title: r.title ?? "",
    uid: r.uid ?? "",
    dateInboundString: dateTime(r.date_inbound),
    unitPrice: Number(r.unit_price ?? 0),
    quantity,
    quantityRemaining: remaining,
    dateLastSaleString: dateTime(r.date_last_sale),
    // 上次銷售至今天數：從未銷售（剩餘＝入庫數量）時以入庫日起算（前端顯示 NA）
    daysSinceLastSale: daysSince(r.date_last_sale ?? r.date_inbound),
    dateCreated: new Date(String(r.created_at)).getTime(),
    dateModified: new Date(String(r.updated_at)).getTime(),
  };
}

function applyFilters(q: AnyRow, extra: Record<string, string>): AnyRow {
  const days = toInt(extra.daysSinceLastSaleGreater);
  if (days !== null && days >= 0) {
    const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 19) + "Z";
    q = q.or(`date_last_sale.lt.${cutoff},and(date_last_sale.is.null,date_inbound.lt.${cutoff})`);
  }
  const rem = toInt(extra.quantityRemainingGreater);
  if (rem !== null) q = q.gt("quantity_remaining", rem);
  return q;
}

async function listRecords(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  return wmsList(ctx, {
    table: "inbound_records",
    columns: {
      title: { column: "title", kind: "text", sortable: false },
      uid: { column: "uid", kind: "text", sortable: false },
      dateInboundString: { column: "date_inbound", kind: "date" },
      // 「最後銷售日期」欄（data=daysSinceLastSale）：天數小＝最後銷售日期新
      daysSinceLastSale: { column: "date_last_sale", kind: "int", invertSort: true },
      quantity: { column: "quantity", kind: "int", sortable: false },
      quantityRemaining: { column: "quantity_remaining", kind: "int" },
    },
    search: ["title", "uid"],
    defaultOrder: [{ column: "date_last_sale", ascending: false }],
    where: (q, dt: DtRequest) => applyFilters(q, dt.extra),
    async mapRows(rows) {
      const whs = await warehouseMap(session, rows.map((r) => r.warehouse_id));
      return rows.map((r) => recordJson(r, whs.get(Number(r.warehouse_id))?.name ?? ""));
    },
  });
}

const writeSpec: WriteSpec = {
  validate(values, action) {
    if (action === "create") return [{ name: "title", status: "入庫紀錄由確認入庫自動產生" }];
    const errors: { name: string; status: string }[] = [];
    if (values.quantityRemaining !== undefined) {
      const n = toInt(values.quantityRemaining);
      if (n === null || n < 0) errors.push({ name: "quantityRemaining", status: "請輸入 0 以上的整數" });
    }
    return errors;
  },
  beforeWrite(dbRow) {
    // 只允許修正剩餘數量與最後銷售日期（其餘由系統維護）
    const allowed: AnyRow = {};
    if ("quantity_remaining" in dbRow) allowed.quantity_remaining = dbRow.quantity_remaining;
    if ("date_last_sale" in dbRow) allowed.date_last_sale = dbRow.date_last_sale;
    return allowed;
  },
  beforeRemove() {
    throw badRequest("入庫紀錄不可刪除");
  },
  mapRow: (api, row) => recordJson(row, ""),
};

function recordWrite(expected: "create" | "edit" | "remove") {
  return async (ctx: RequestContext): Promise<Response> => {
    const body = await ctx.body();
    expectAction(body.flat.get("action")?.[0] ?? "", expected);
    return editorEntity(ctx, inboundRecordEntity, writeSpec);
  };
}

/** POST /backend/InboundRecord/download：依目前篩選匯出 Excel */
async function downloadRecords(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const extra: Record<string, string> = {};
  for (const k of ["daysSinceLastSaleGreater", "quantityRemainingGreater"]) {
    const v = await ctx.param(k);
    if (v) extra[k] = v;
  }
  // 分頁取完（PostgREST 單次上限 1000 筆）
  const rows = await fetchAll<AnyRow>(() =>
    applyFilters(db().from("inbound_records").select("*").eq("tenant_id", session.tenantId), extra)
      .order("date_inbound", { ascending: true })
      .order("id"),
  );
  const whs = await warehouseMap(session, rows.map((r) => r.warehouse_id));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("入庫紀錄");
  ws.columns = [
    { header: "名稱", key: "title", width: 30 },
    { header: "商品代碼", key: "uid", width: 16 },
    { header: "入庫倉", key: "warehouseName", width: 18 },
    { header: "入庫單號", key: "inboundId", width: 10 },
    { header: "入庫日期", key: "dateInboundString", width: 18 },
    { header: "最後銷售日期", key: "dateLastSaleString", width: 18 },
    { header: "上次銷售至今天數", key: "days", width: 10 },
    { header: "單價", key: "unitPrice", width: 10 },
    { header: "入庫數量", key: "quantity", width: 10 },
    { header: "剩餘數量", key: "quantityRemaining", width: 10 },
  ];
  for (const r of rows) {
    const j = recordJson(r, whs.get(Number(r.warehouse_id))?.name ?? "");
    ws.addRow({ ...j, days: j.quantity === j.quantityRemaining ? "NA" : j.daysSinceLastSale });
  }
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return download(new Uint8Array(buf as ArrayBuffer), `入庫紀錄_${stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export const inboundRecordRoutes: RouteDef[] = [
  page("/backend/InboundRecord/list", {
    template: "warehouse/inboundrecord-list.html",
    title: "入庫紀錄",
    groupBuy: "none",
  }),
  any("/ajax/InboundRecord/list", listRecords),
  post("/ajax/InboundRecord/save", recordWrite("create")),
  post("/ajax/InboundRecord/update", recordWrite("edit")),
  post("/ajax/InboundRecord/delete", recordWrite("remove")),
  post("/backend/InboundRecord/download", downloadRecords),
];

