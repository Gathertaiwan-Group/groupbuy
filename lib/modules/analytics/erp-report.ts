// 近期月報表（銷售報表／ERP 銷貨與預收）。
//   GET  /backend/GroupBuy/erpSalesReport                             頁面（TableExport 5.2.0 + xlsx 0.15.4 + FileSaver 1.3.8 匯出 EXCEL）
//   POST /ajax/GroupBuy/getErpSalesReport?paymentMethod=2&paymentMethod=4   body: yymm, featureTagMain
// 口徑（推導，原站資料不足以實測）：報表月份 M（yymm）
//   銷貨＝M 月出貨（date_shipped 在 M）的已付款有效訂單，依其收款月分組
//   預收＝M 月收款、但到 M 月底仍未出貨的有效訂單（收款月＝M）
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, requireSession, route } from "@/lib/core/http/route-helpers";
import { json, jsonError } from "@/lib/core/http/responses";
import { type AnyRow, boolParam, ensureFresh, fetchAll, int, monthEnd, num, parseMonth, paymentMethodOf, todayTpe } from "./util";

const yymm = (date: string | null | undefined) => (date ? date.slice(2, 4) + date.slice(5, 7) : "");

interface Bucket {
  salesAmount: number;
  advanceAmount: number;
  salesTotal: number;
  advanceTotal: number;
}
const bucket = (): Bucket => ({ salesAmount: 0, advanceAmount: 0, salesTotal: 0, advanceTotal: 0 });

export async function erpSalesReport(tenantId: number, month01: string, paymentBits: number[], excludeMain: boolean): Promise<AnyRow> {
  await ensureFresh(tenantId);
  const db = getServiceClient();
  const start = month01;
  const end = monthEnd(month01);
  const cols = "sales_order_id, group_buy_id, payment_method, grand_total, paid_date, shipped_date, is_shipped";
  const base = () => {
    let q = db.from("analytics_orders_v").select(cols).eq("tenant_id", tenantId).eq("is_paid", true).not("group_buy_id", "is", null);
    if (paymentBits.length) q = q.in("payment_method", paymentBits);
    return q;
  };
  const shipped = await fetchAll<AnyRow>((f, t) => base().gte("shipped_date", start).lte("shipped_date", end).order("sales_order_id").range(f, t));
  const paid = await fetchAll<AnyRow>((f, t) => base().gte("paid_date", start).lte("paid_date", end).order("sales_order_id").range(f, t));
  const advance = paid.filter((o) => !o.shipped_date || String(o.shipped_date) > end);

  const gbIds = [...new Set([...shipped, ...advance].map((o) => int(o.group_buy_id)))];
  const gbInfo = new Map<number, AnyRow>();
  for (let i = 0; i < gbIds.length; i += 500) {
    const { data } = await db.from("group_buys").select("id, title, feature_tags").eq("tenant_id", tenantId).in("id", gbIds.slice(i, i + 500));
    for (const g of (data ?? []) as AnyRow[]) gbInfo.set(int(g.id), g);
  }
  const excluded = (gbId: number) => excludeMain && Array.isArray(gbInfo.get(gbId)?.feature_tags) && (gbInfo.get(gbId)!.feature_tags as string[]).includes("MAIN");

  type Month = Bucket & { datePaid: string; pmAmounts: Record<string, Bucket>; groupBuys: Record<string, AnyRow> };
  const months = new Map<string, Month>();
  const add = (o: AnyRow, isSales: boolean) => {
    const gbId = int(o.group_buy_id);
    if (excluded(gbId)) return;
    const dp = yymm(String(o.paid_date ?? ""));
    let m = months.get(dp);
    if (!m) {
      m = { datePaid: dp, ...bucket(), pmAmounts: {}, groupBuys: {} };
      months.set(dp, m);
    }
    const amt = num(o.grand_total);
    const pm = paymentMethodOf(o.payment_method).label;
    const pb = (m.pmAmounts[pm] ??= bucket());
    let gb = m.groupBuys[String(gbId)];
    if (!gb) {
      gb = { groupBuyId: gbId, title: gbInfo.get(gbId)?.title ?? "", ...bucket(), details: {} as Record<string, AnyRow> };
      m.groupBuys[String(gbId)] = gb;
    }
    const ds = isSales ? yymm(String(o.shipped_date ?? "")) : "";
    const state = isSales ? "已出貨" : "未出貨";
    const dkey = `${pm}|${state}|${ds}`;
    const details = gb.details as Record<string, AnyRow>;
    const det = (details[dkey] ??= { title: gb.title, datePaid: dp, dateShipped: ds, paymentMethod: pm, shippingState: state, amount: 0, orderTotal: 0 });
    det.amount = num(det.amount + amt);
    det.orderTotal += 1;
    for (const b of [m as Bucket, pb, gb as unknown as Bucket]) {
      if (isSales) {
        b.salesAmount = num(b.salesAmount + amt);
        b.salesTotal += 1;
      } else {
        b.advanceAmount = num(b.advanceAmount + amt);
        b.advanceTotal += 1;
      }
    }
  };
  for (const o of shipped) add(o, true);
  for (const o of advance) add(o, false);
  const salesMonths = [...months.values()].sort((a, b) => a.datePaid.localeCompare(b.datePaid));
  return { dateShipped: yymm(month01), salesMonths };
}

async function getErpSalesReport(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const ym = (await ctx.param("yymm")) ?? "";
  const month = parseMonth(ym) ?? (ym ? null : todayTpe().slice(0, 7) + "-01");
  if (!month) return jsonError(400, "月份格式錯誤（YYMM）", { code: -1 });
  const bits = (await ctx.params_all("paymentMethod"))
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!bits.length) return json({ code: -1, error: "請至少選擇一種付款方式", message: "請至少選擇一種付款方式" });
  const data = await erpSalesReport(session.tenantId, month, bits, boolParam(await ctx.param("featureTagMain")));
  return json({ data, recordsTotal: 0, recordsFiltered: 0, dateModified: 0, executionTime: Date.now() - started, options: {} });
}

export const erpReportRoutes: RouteDef[] = [
  page("/backend/GroupBuy/erpSalesReport", {
    template: "analytics/groupbuy-erpsalesreport.html",
    title: "銷售分析",
    groupBuy: "none",
    activeHref: "/backend/GroupBuy/list",
  }),
  route(["GET", "POST"], "/ajax/GroupBuy/getErpSalesReport", getErpSalesReport),
];
