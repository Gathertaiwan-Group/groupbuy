// 月結單：/backend/BillingTransaction/list
// 原站：spec/html/billingtransaction-list.html、spec/runtime/billingtransaction-list.records.txt、SPEC「月結單」、7.5。
//   POST /ajax/BillingTransaction/list            列表（serverSide，每頁 20；回應另含 billingPlans → 頁面 #billingPlanArea）
//   GET  /backend/BillingTransactionRecord/list?billingTransactionId=   「明細」（原站另開視窗；頁面未擷取 → 推導）
//   POST /ajax/BillingTransactionRecord/list?billingTransactionId=      明細列表（推導）
// 月結單由平台核發（唯讀）：本模組只提供查詢；明細沒有存在 details 時，依計費方式即時由團購／訂單計算（推導）。
import { getServiceClient } from "@/lib/supabase/server";
import { billingTransaction } from "@/lib/db/entities";
import { rowToApi, type Row } from "@/lib/db/mapping";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, page, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { enumLabel, enumOptionsFor } from "@/lib/core/enums";
import { fetchAll, taipeiDay } from "./common";

type PlanRow = {
  id: number;
  title: string;
  billing_type: string;
  rate: string | number;
  fixed_fee: string | number;
  minimum_fee: string | number;
  date_start: string | null;
  date_end: string | null;
  is_active: boolean;
  note: string | null;
};

/** 頁面 renderBillingBlanArea 用的方案資料（monthlyFee、billingPlanSettings.credit/creditUsed/creditRegularlyLimit） */
async function billingPlansOf(session: AdminSession): Promise<Row[]> {
  const { data, error } = await getServiceClient()
    .from("billing_plans")
    .select("id, title, billing_type, rate, fixed_fee, minimum_fee, date_start, date_end, is_active, note")
    .eq("tenant_id", session.tenantId)
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(`[accounting] ${error.message}`);
  return ((data ?? []) as PlanRow[]).map((p) => ({
    billingPlanId: p.id,
    title: p.title,
    billingType: p.billing_type,
    rate: Number(p.rate),
    monthlyFee: Number(p.fixed_fee) || null,
    minimumFee: Number(p.minimum_fee) || null,
    dateStartString: taipeiDay(p.date_start) ?? "",
    dateEndString: taipeiDay(p.date_end) ?? "",
    // 儲值／折抵額度：原站方案設定，本系統方案表沒有對應欄位（推導為 null，頁面不顯示）
    billingPlanSettings: { credit: null, creditUsed: null, creditRegularlyLimit: null },
  }));
}

function mapBill(api: Row, row: Row): Row {
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  api.summary = { ...summary, groupBuyRevenue: summary.groupBuyRevenue ?? 0 };
  api.invoiceNumber = api.invoiceNumber ?? "";
  api.note = api.note ?? "";
  api.descr = String(row.note ?? "");
  return api;
}

async function listBills(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const spec: ListSpec = {
    search: ["billingType", "status", "invoiceNumber", "note"],
    defaultOrder: [{ key: "dateTransactionString", ascending: false }],
    where: (q, dt) => {
      let qq = q;
      if (dt.extra.payable === "true") qq = qq.eq("status", "UNPAID");
      if (dt.extra.newBt === "true") qq = qq.gte("date_transaction", new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString());
      return qq;
    },
    mapRow: (api, row) => mapBill(api, row),
    options: () => enumOptionsFor({ billingType: "BillingTransaction.billingType" }),
    extra: async () => ({ billingPlans: await billingPlansOf(session) }),
  };
  return listEntity(ctx, billingTransaction, spec);
}

/* ───────────────────────── 明細（推導） ───────────────────────── */

type BillRow = Row & {
  id: number;
  billing_type: string;
  period_start: string | null;
  period_end: string | null;
  date_transaction: string;
  summary: Record<string, unknown> | null;
  details: Row[] | null;
  grand_total: string | number;
  status: string;
  billing_plan_id: number | null;
};

async function loadBill(session: AdminSession, idRaw: unknown): Promise<BillRow> {
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 billingTransactionId");
  const { data, error } = await getServiceClient().from("billing_transactions").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle<BillRow>();
  if (error) throw new Error(`[accounting] ${error.message}`);
  if (!data) throw notFound("找不到月結單");
  return data;
}

const INVALID_STATES = ["DRAFT", "CANCELED", "COMBINED", "SPLITED"];

/** 月結明細：details 有存就用；沒有時依計費方式（END/START＝團購截止/開始日落在期間；ORDERS＝期間內成立的訂單）即時計算 */
async function billRecords(session: AdminSession, bill: BillRow): Promise<Row[]> {
  if (Array.isArray(bill.details) && bill.details.length) return bill.details;
  const start = bill.period_start;
  const end = bill.period_end;
  if (!start || !end) return [];
  const from = `${start}T00:00:00+08:00`;
  const to = new Date(new Date(`${end}T00:00:00+08:00`).getTime() + 24 * 3600 * 1000).toISOString();
  const rate = Number(bill.summary?.rate ?? 0);
  const db = getServiceClient();
  type Gb = { id: number; title: string; date_start: string | null; date_end: string | null };
  let gbs: Gb[];
  if (bill.billing_type === "ORDERS") {
    const orders = await fetchAll<{ group_buy_id: number | null }>((f, t) =>
      db.from("sales_orders").select("group_buy_id").eq("tenant_id", session.tenantId).gte("created_at", from).lt("created_at", to).range(f, t),
    );
    const ids = [...new Set(orders.map((o) => o.group_buy_id).filter((x): x is number => !!x))];
    gbs = ids.length ? (((await db.from("group_buys").select("id, title, date_start, date_end").eq("tenant_id", session.tenantId).in("id", ids)).data ?? []) as Gb[]) : [];
  } else {
    const col = bill.billing_type === "START" ? "date_start" : "date_end";
    gbs = ((await db.from("group_buys").select("id, title, date_start, date_end").eq("tenant_id", session.tenantId).gte(col, from).lt(col, to).order(col)).data ?? []) as Gb[];
  }
  const out: Row[] = [];
  for (const gb of gbs) {
    let q = db.from("sales_orders").select("grand_total, state").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id);
    if (bill.billing_type === "ORDERS") q = q.gte("created_at", from).lt("created_at", to);
    const orders = ((await q.limit(10000)).data ?? []) as { grand_total: string | number; state: string }[];
    const valid = orders.filter((o) => !INVALID_STATES.includes(o.state));
    const revenue = Math.round(valid.reduce((a, o) => a + Number(o.grand_total), 0));
    out.push({
      groupBuyId: gb.id,
      groupBuyTitle: gb.title,
      dateStartString: taipeiDay(gb.date_start) ?? "",
      dateEndString: taipeiDay(gb.date_end) ?? "",
      orders: valid.length,
      groupBuyRevenue: revenue,
      rate,
      fee: Math.round((revenue * rate) / 100),
    });
  }
  // 期間內找不到可計算的團購（例：示範月結單的摘要是虛構值）→ 以月結單本身的摘要列出一列，避免明細與帳單不一致
  const s = bill.summary ?? {};
  if (out.length === 0 && Number(s.groupBuyRevenue ?? 0) > 0) {
    out.push({
      groupBuyId: null,
      groupBuyTitle: `（月結單摘要）共 ${Number(s.groupBuys ?? 0)} 個團購`,
      dateStartString: bill.period_start ?? "",
      dateEndString: bill.period_end ?? "",
      orders: Number(s.orders ?? 0),
      groupBuyRevenue: Number(s.groupBuyRevenue ?? 0),
      rate,
      fee: Number(s.fee ?? 0) || Number(bill.grand_total ?? 0),
    });
  }
  return out;
}

async function listRecords(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const bill = await loadBill(session, await ctx.param("billingTransactionId"));
  const dt = await parseDtRequest(ctx);
  const rows = await billRecords(session, bill);
  return dtResponse(dt, { rows, options: {} }, started);
}

export const billingTransactionRoutes: RouteDef[] = [
  page("/backend/BillingTransaction/list", {
    template: "accounting/billingtransaction-list.html",
    title: "月結單",
    groupBuy: "none",
  }),
  any("/ajax/BillingTransaction/list", listBills),
  page("/backend/BillingTransactionRecord/list", {
    template: "accounting/billingtransactionrecord-list.html",
    title: "月結單明細",
    groupBuy: "none",
    activeHref: "/backend/BillingTransaction/list",
    async data(ctx) {
      const bill = await loadBill(ctx.session, ctx.query.get("billingTransactionId"));
      const api = mapBill(rowToApi(billingTransaction, bill), bill);
      return {
        bill: api,
        billingTypeLabel: await enumLabel("BillingTransaction.billingType", bill.billing_type),
        statusLabel: await enumLabel("BillingTransaction.status", bill.status),
      };
    },
  }),
  any("/ajax/BillingTransactionRecord/list", listRecords),
];
