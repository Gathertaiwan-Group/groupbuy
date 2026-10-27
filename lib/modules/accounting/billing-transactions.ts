// 月結單：/backend/BillingTransaction/list
// 依據：spec/html/billingtransaction-list.html（表格欄位、「明細」子列以 textarea 顯示 descr、方案區的儲值／折抵文字）、
//       spec/runtime/billingtransaction-list.records.txt（回傳鍵含 billingPlans、options.billingType）、SPEC「月結單」、7.5。
//   POST /ajax/BillingTransaction/list                              列表（serverSide，每頁 20；每列含 descr 文字摘要；回應另含 billingPlans）
//   GET  /ajax/BillingTransaction/details?billingTransactionId=     明細子列的「團購別計費」（本系統自訂端點）
// 月結單由平台核發（唯讀）：本模組只提供查詢。
//
// 本系統自訂的資料格式：
//   billingPlans[]：{ billingPlanId, title, billingType, billingTypeLabel, rate, fixedFee, minimumFee,
//                     dateStartString, dateEndString, note, credit, creditUsed, creditRegularlyLimit }
//                   （儲值／折抵額度：本系統方案表沒有對應欄位 → null，頁面不顯示）
//   details 回應：{ code: 200, data: { billingTransactionId, billingTypeLabel, periodStartString, periodEndString,
//                   computed, records: [{ groupBuyId, groupBuyTitle, dateStartString, dateEndString, orders, groupBuyRevenue, rate, fee }],
//                   total: { orders, groupBuyRevenue, fee } } }
//   computed：true＝月結單沒有存明細，依計費方式即時由團購／訂單計算；false＝月結單存的明細。
import { getServiceClient } from "@/lib/supabase/server";
import { billingTransaction } from "@/lib/db/entities";
import type { Row } from "@/lib/db/mapping";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { enumLabel, enumOptionsFor } from "@/lib/core/enums";
import { fetchAll, money, taipeiDay } from "./common";
import { getAccountSettings } from "@/lib/modules/core/system-settings";

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

/** 啟用中的計費方案（頁面方案區） */
async function billingPlansOf(session: AdminSession): Promise<Row[]> {
  const { data, error } = await getServiceClient()
    .from("billing_plans")
    .select("id, title, billing_type, rate, fixed_fee, minimum_fee, date_start, date_end, is_active, note")
    .eq("tenant_id", session.tenantId)
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(`[accounting] ${error.message}`);
  const out: Row[] = [];
  for (const p of (data ?? []) as PlanRow[]) {
    out.push({
      billingPlanId: p.id,
      title: p.title,
      billingType: p.billing_type,
      billingTypeLabel: await enumLabel("BillingTransaction.billingType", p.billing_type),
      rate: Number(p.rate),
      fixedFee: Number(p.fixed_fee),
      minimumFee: Number(p.minimum_fee),
      dateStartString: taipeiDay(p.date_start) ?? "",
      dateEndString: taipeiDay(p.date_end) ?? "",
      note: p.note ?? "",
      credit: null,
      creditUsed: null,
      creditRegularlyLimit: null,
    });
  }
  return out;
}

type BillRow = Row & {
  id: number;
  billing_type: string;
  period_start: string | null;
  period_end: string | null;
  date_transaction: string;
  date_paid: string | null;
  summary: Record<string, unknown> | null;
  details: Row[] | null;
  grand_total: string | number;
  tax_fee: string | number | null;
  status: string;
  invoice_number: string | null;
  note: string | null;
  billing_plan_id: number | null;
};

/** 明細子列 textarea 的文字摘要（只用月結單本身的欄位，不另查詢） */
async function describeBill(row: BillRow): Promise<string> {
  const s = row.summary ?? {};
  const typeLabel = await enumLabel("BillingTransaction.billingType", row.billing_type);
  const statusLabel = await enumLabel("BillingTransaction.status", row.status);
  const paid = taipeiDay(row.date_paid);
  const lines = [
    `計費方式：${typeLabel}`,
    `計費期間：${row.period_start ?? ""} ~ ${row.period_end ?? ""}`,
    `核發日期：${taipeiDay(row.date_transaction) ?? ""}`,
    `團購數：${Number(s.groupBuys ?? 0)}　訂單數：${Number(s.orders ?? 0)}`,
    `總營收：${money(s.groupBuyRevenue)}`,
    `費率：${Number(s.rate ?? 0)}%　服務費：${money(s.fee)}`,
    `稅額：${money(row.tax_fee)}　帳單金額：${money(row.grand_total)}`,
    `狀態：${statusLabel}${paid ? `（${paid} 繳款）` : ""}`,
  ];
  if (row.invoice_number) lines.push(`發票號碼：${row.invoice_number}`);
  if (row.note) lines.push(`備註：${row.note}`);
  if (Array.isArray(row.details) && row.details.length) {
    lines.push("", "團購別計費：");
    for (const d of row.details) {
      lines.push(`${String(d.groupBuyTitle ?? "")}　訂單 ${Number(d.orders ?? 0)}　營收 ${money(d.groupBuyRevenue)}　服務費 ${money(d.fee)}`);
    }
  }
  return lines.join("\n");
}

async function listBills(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const spec: ListSpec = {
    search: ["billingType", "status", "invoiceNumber", "note"],
    defaultOrder: [{ key: "dateTransactionString", ascending: false }],
    mapRow: async (api, row) => {
      const summary = (row.summary ?? {}) as Record<string, unknown>;
      api.summary = { ...summary, groupBuyRevenue: Number(summary.groupBuyRevenue ?? 0) };
      api.invoiceNumber = api.invoiceNumber ?? "";
      api.note = api.note ?? "";
      api.descr = await describeBill(row as BillRow);
      return api;
    },
    options: () => enumOptionsFor({ billingType: "BillingTransaction.billingType" }),
    // accountCredits：系統設定「GBA帳務設定」的 Email／簡訊餘額（未設定為 null，頁面不顯示）
    extra: async () => {
      const [plans, acc] = await Promise.all([billingPlansOf(session), getAccountSettings(session.tenantId)]);
      return { billingPlans: plans, accountCredits: { creditEmail: acc.creditEmail, creditSms: acc.creditSms } };
    },
  };
  return listEntity(ctx, billingTransaction, spec);
}

/* ───────────────────────── 明細：團購別計費（本系統自訂） ───────────────────────── */

async function loadBill(session: AdminSession, idRaw: unknown): Promise<BillRow> {
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 billingTransactionId");
  const { data, error } = await getServiceClient().from("billing_transactions").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle<BillRow>();
  if (error) throw new Error(`[accounting] ${error.message}`);
  if (!data) throw notFound("找不到月結單");
  return data;
}

/** 不計入營收的訂單階段 */
const INVALID_STATES = ["DRAFT", "CANCELED", "COMBINED", "SPLITED"];

/** 團購別計費：月結單有存 details 就用；沒有時依計費方式（END/START＝團購截止／開始日落在期間；ORDERS＝期間內成立的訂單）即時計算 */
async function billRecords(session: AdminSession, bill: BillRow): Promise<{ computed: boolean; records: Row[] }> {
  if (Array.isArray(bill.details) && bill.details.length) return { computed: false, records: bill.details };
  const start = bill.period_start;
  const end = bill.period_end;
  if (!start || !end) return { computed: true, records: [] };
  const from = `${start}T00:00:00+08:00`;
  const to = new Date(new Date(`${end}T00:00:00+08:00`).getTime() + 24 * 3600 * 1000).toISOString();
  const rate = Number(bill.summary?.rate ?? 0);
  const db = getServiceClient();
  type Gb = { id: number; title: string; date_start: string | null; date_end: string | null };
  let gbs: Gb[];
  if (bill.billing_type === "ORDERS") {
    const orders = await fetchAll<{ group_buy_id: number | null }>((f, t) =>
      db.from("sales_orders").select("group_buy_id").eq("tenant_id", session.tenantId).gte("created_at", from).lt("created_at", to).order("id").range(f, t),
    200000);
    const ids = [...new Set(orders.map((o) => o.group_buy_id).filter((x): x is number => !!x))];
    gbs = ids.length ? (((await db.from("group_buys").select("id, title, date_start, date_end").eq("tenant_id", session.tenantId).in("id", ids)).data ?? []) as Gb[]) : [];
  } else {
    const col = bill.billing_type === "START" ? "date_start" : "date_end";
    gbs = ((await db.from("group_buys").select("id, title, date_start, date_end").eq("tenant_id", session.tenantId).gte(col, from).lt(col, to).order(col)).data ?? []) as Gb[];
  }
  // 分頁讀出這些團購的訂單（PostgREST 單次上限 1000 筆），再依團購彙總
  const gbIds = gbs.map((g) => g.id);
  const orders = gbIds.length
    ? await fetchAll<{ group_buy_id: number; grand_total: string | number; state: string }>((f, t) => {
        let q = db.from("sales_orders").select("group_buy_id, grand_total, state").eq("tenant_id", session.tenantId).in("group_buy_id", gbIds);
        if (bill.billing_type === "ORDERS") q = q.gte("created_at", from).lt("created_at", to);
        return q.order("id").range(f, t);
      }, 200000)
    : [];
  const agg = new Map<number, { orders: number; revenue: number }>();
  for (const o of orders) {
    if (INVALID_STATES.includes(o.state)) continue;
    const a = agg.get(o.group_buy_id) ?? { orders: 0, revenue: 0 };
    a.orders++;
    a.revenue += Number(o.grand_total);
    agg.set(o.group_buy_id, a);
  }
  const records: Row[] = gbs.map((gb) => {
    const a = agg.get(gb.id) ?? { orders: 0, revenue: 0 };
    const revenue = Math.round(a.revenue);
    return {
      groupBuyId: gb.id,
      groupBuyTitle: gb.title,
      dateStartString: taipeiDay(gb.date_start) ?? "",
      dateEndString: taipeiDay(gb.date_end) ?? "",
      orders: a.orders,
      groupBuyRevenue: revenue,
      rate,
      fee: Math.round((revenue * rate) / 100),
    };
  });
  return { computed: true, records };
}

async function billDetails(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const bill = await loadBill(session, await ctx.param("billingTransactionId"));
  const { computed, records } = await billRecords(session, bill);
  const total = records.reduce<{ orders: number; groupBuyRevenue: number; fee: number }>(
    (a, r) => ({ orders: a.orders + Number(r.orders ?? 0), groupBuyRevenue: a.groupBuyRevenue + Number(r.groupBuyRevenue ?? 0), fee: a.fee + Number(r.fee ?? 0) }),
    { orders: 0, groupBuyRevenue: 0, fee: 0 },
  );
  return json({
    code: 200,
    data: {
      billingTransactionId: bill.id,
      billingTypeLabel: await enumLabel("BillingTransaction.billingType", bill.billing_type),
      periodStartString: bill.period_start ?? "",
      periodEndString: bill.period_end ?? "",
      computed,
      records,
      total,
    },
  });
}

export const billingTransactionRoutes: RouteDef[] = [
  page("/backend/BillingTransaction/list", {
    template: "accounting/billingtransaction-list.html",
    title: "月結單",
    groupBuy: "none",
  }),
  any("/ajax/BillingTransaction/list", listBills),
  get("/ajax/BillingTransaction/details", billDetails),
];
