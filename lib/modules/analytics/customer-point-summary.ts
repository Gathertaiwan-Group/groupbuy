// 每月消費統計下載 POST /backend/CustomerPointSummary/download（推導）。
// 原站：訂單統計頁（每月消費統計）表單 #queryForm action="/backend/CustomerPointSummary/download"，觸發按鈕的程式碼被擷取過濾
// （spec/html/salesordermonthlystatistics-list.html:661 缺段）；下載內容未擷取（SPEC §9 #6）。
// 推導內容：依頁面同一組篩選（月份、消費總金額／單筆最高金額／訂單數量的超過／少於、query＝搜尋字）輸出每月消費統計，
// 依路徑名稱 CustomerPointSummary 另附會員點數：會員ID、目前點數、當月獲得點數、當月使用點數（point_transactions，台灣時間月份）。
// format=xlsx（預設）｜csv（UTF-8 BOM）。單次最多 50000 列。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { post, requireSession } from "@/lib/core/http/route-helpers";
import { download } from "@/lib/core/http/responses";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { buildXlsx, csvCell, XLSX_CONTENT_TYPE, type CellInput } from "./xlsx";
import { type AnyRow, ensureFresh, fetchAll, int, num, parseMonth, yyyymm } from "./util";

const HEADERS = ["月份", "姓名", "電子信箱", "電話", "消費總金額", "單筆最高金額", "訂單數量", "會員ID", "目前點數", "當月獲得點數", "當月使用點數"];

function numParam(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 台灣時間的 YYYY-MM-01 */
function tpeMonthOf(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 7)}-01`;
}


export async function customerPointSummaryRows(tenantId: number, p: Record<string, unknown>): Promise<CellInput[][]> {
  await ensureFresh(tenantId);
  const db = getServiceClient();
  const month = parseMonth(p.month);
  const g = (k: string) => numParam(p[k]);
  const term = sanitizeLike(String(p.query ?? ""));
  const stats = await fetchAll<AnyRow>((from, to) => {
    let q = db
      .from("sales_order_monthly_statistics")
      .select("id, month, customer_id, name, email, telephone, amount_total, amount_max, count_order_valid")
      .eq("tenant_id", tenantId);
    if (month) q = q.eq("month", month);
    if (g("amountTotalGreater") !== null) q = q.gt("amount_total", g("amountTotalGreater"));
    if (g("amountTotalLess") !== null) q = q.lt("amount_total", g("amountTotalLess"));
    if (g("amountMaxGreater") !== null) q = q.gt("amount_max", g("amountMaxGreater"));
    if (g("amountMaxLess") !== null) q = q.lt("amount_max", g("amountMaxLess"));
    if (g("countOrderValidGreater") !== null) q = q.gt("count_order_valid", g("countOrderValidGreater"));
    if (g("countOrderValidLess") !== null) q = q.lt("count_order_valid", g("countOrderValidLess"));
    if (term) q = q.or(`name.ilike.*${term}*,email.ilike.*${term}*,telephone.ilike.*${term}*`);
    return q.order("month", { ascending: false }).order("amount_total", { ascending: false }).order("id", { ascending: true }).range(from, to);
  });

  const customerIds = [...new Set(stats.map((r) => Number(r.customer_id)).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const customers = new Map<number, AnyRow>();
  // 會員點數（月份 → 會員 → 獲得／使用）
  const pts = new Map<string, { earned: number; used: number }>();
  for (let i = 0; i < customerIds.length; i += 200) {
    const ids = customerIds.slice(i, i + 200);
    const cs = await fetchAll<AnyRow>((from, to) =>
      db.from("customers").select("id, uuid, points").eq("tenant_id", tenantId).in("id", ids).order("id").range(from, to),
    );
    for (const c of cs) customers.set(Number(c.id), c);
    const txs = await fetchAll<AnyRow>((from, to) => {
      let q = db.from("point_transactions").select("id, customer_id, points, created_at").eq("tenant_id", tenantId).in("customer_id", ids);
      if (month) {
        // 台灣時間當月（UTC 前一天 16:00 起）
        const start = new Date(`${month}T00:00:00+08:00`);
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        q = q.gte("created_at", start.toISOString()).lt("created_at", end.toISOString());
      }
      return q.order("id").range(from, to);
    }, 200000);
    for (const t of txs) {
      const key = `${tpeMonthOf(t.created_at)}|${Number(t.customer_id)}`;
      const cur = pts.get(key) ?? { earned: 0, used: 0 };
      const n = int(t.points);
      if (n >= 0) cur.earned += n;
      else cur.used += -n;
      pts.set(key, cur);
    }
  }

  const rows: CellInput[][] = [HEADERS.map((h) => ({ v: h, s: "header" as const }))];
  for (const r of stats) {
    const m = String(r.month ?? "").slice(0, 10);
    const cid = Number(r.customer_id);
    const c = customers.get(cid);
    const pt = pts.get(`${m}|${cid}`);
    rows.push([
      { v: yyyymm(m).replace(/^(\d{4})(\d{2})$/, "$1-$2"), t: "s" },
      String(r.name ?? ""),
      String(r.email ?? ""),
      { v: String(r.telephone ?? ""), t: "s" },
      num(r.amount_total),
      num(r.amount_max),
      int(r.count_order_valid),
      c ? { v: String(c.uuid ?? ""), t: "s" } : "",
      c ? int(c.points) : "",
      c ? (pt?.earned ?? 0) : "",
      c ? (pt?.used ?? 0) : "",
    ]);
  }
  return rows;
}

async function downloadSummary(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const keys = ["month", "query", "amountTotalGreater", "amountTotalLess", "amountMaxGreater", "amountMaxLess", "countOrderValidGreater", "countOrderValidLess", "format"];
  const p: Record<string, unknown> = {};
  for (const k of keys) p[k] = await ctx.param(k);
  const rows = await customerPointSummaryRows(s.tenantId, p);
  const month = parseMonth(p.month);
  const base = `每月消費統計_${month ? month.slice(0, 7) : "全部"}`;
  if (String(p.format ?? "").toLowerCase() === "csv") {
    const text = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    return download(text, `${base}.csv`, "text/csv; charset=utf-8");
  }
  const buf = buildXlsx([{ name: "每月消費統計", rows, widths: [10, 14, 26, 14, 12, 12, 10, 20, 10, 12, 12] }]);
  return download(new Uint8Array(buf), `${base}.xlsx`, XLSX_CONTENT_TYPE);
}

// 補F：含會員個資與點數 → 需「會員」權限（與後台會員管理 /backend/Customer/list 相同旗標 permissions.customer）
export const customerPointSummaryRoutes: RouteDef[] = [post("/backend/CustomerPointSummary/download", downloadSummary, { permission: "customer" })];
