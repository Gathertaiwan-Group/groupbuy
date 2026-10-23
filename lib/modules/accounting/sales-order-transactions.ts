// 金流對帳（金流交易紀錄）：/backend/SalesOrderTransaction/list?groupBuyId=
// 原站：spec/html/salesordertransaction-list.html、spec/runtime/salesordertransaction-list.records.txt、SPEC「金流對帳」、7.5。
// 列表本身呼叫 orders 模組的 POST /ajax/SalesOrder/list（groupBuyId＋month=100），本模組只負責頁面與「檢核」：
//   POST /ajax/SalesOrderTransaction/verify   salesOrderId（逐筆）、merp（原站頁面沒有 #merp_select，實際不會送）
// 金流後台一律「未串接」：檢核改為比對本系統 groupbuy.sales_order_transactions 的交易紀錄（成功收款、退款）與訂單已付金額，
// 回傳原站結果欄位（amount、refund、short、payStatus、merchantOrderId、creditCardNumber、totalPaid、error），
// 並把檢核結果寫回交易紀錄（verified、date_verified、verify_result）。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { enumLabel } from "@/lib/core/enums";

type TxRow = {
  id: number;
  category: string;
  status: string;
  amount: string | number;
  merchant_trade_no: string | null;
  trade_no: string | null;
  credit_card_number: string | null;
  date_transaction: string;
};

/** 收款類別（計入金流收款金額） */
const PAYMENT_CATEGORIES = ["PAYMENT", "CAPTURE", "VIRTUAL_ACCOUNT", "CVS_CODE"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface VerifyResult {
  amount?: number;
  refund?: number;
  short?: number;
  totalPaid: number;
  payStatus?: string;
  merchantOrderId?: string;
  creditCardNumber?: string;
  error?: string;
}

/**
 * 依交易紀錄算出檢核結果（純計算，便於測試）：
 *   amount＝成功收款合計；refund＝成功退款合計（負數，原站前端取絕對值）；
 *   short＝訂單已付金額 − 金流收款金額（≠0 時顯示「交易與訂單差額」；
 *   原站前端判斷 totalPaid＝付款−退款 且 |退款|＋short＝0 時為「差額金額正確」）。
 */
export function summarizeTransactions(txs: TxRow[], order: { totalPaid: number }, statusLabel: (code: string) => string): VerifyResult {
  const totalPaid = round2(order.totalPaid);
  if (txs.length === 0) return { totalPaid, error: "查無金流交易紀錄（未串接金流後台，僅比對本系統交易紀錄）" };
  const ok = txs.filter((t) => t.status === "SUCCESS");
  const amount = round2(ok.filter((t) => PAYMENT_CATEGORIES.includes(t.category)).reduce((a, t) => a + Number(t.amount), 0));
  const refund = round2(ok.filter((t) => t.category === "REFUND").reduce((a, t) => a + Math.abs(Number(t.amount)), 0));
  const latest = [...txs].sort((a, b) => String(b.date_transaction).localeCompare(String(a.date_transaction)))[0];
  const pay = [...txs].filter((t) => PAYMENT_CATEGORIES.includes(t.category)).sort((a, b) => String(b.date_transaction).localeCompare(String(a.date_transaction)))[0];
  const out: VerifyResult = { totalPaid };
  if (amount > 0) out.amount = amount;
  if (refund > 0) out.refund = -refund;
  const short = round2(totalPaid - amount);
  if (amount > 0 && short !== 0) out.short = short;
  const merchant = pay?.merchant_trade_no ?? pay?.trade_no ?? null;
  if (merchant) out.merchantOrderId = merchant;
  const card = ok.find((t) => t.credit_card_number)?.credit_card_number;
  if (card) out.creditCardNumber = card;
  out.payStatus = `${statusLabel(latest.status)}（未串接金流後台，依系統交易紀錄）`;
  if (amount <= 0) out.error = latest.status === "SUCCESS" ? "沒有成功的收款紀錄" : `金流交易${statusLabel(latest.status)}`;
  return out;
}

async function verify(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number((await ctx.param("salesOrderId")) ?? "");
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  const db = getServiceClient();
  const { data: order, error: oerr } = await db
    .from("sales_orders")
    .select("id, uuid, total_paid")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<{ id: number; uuid: string; total_paid: string | number }>();
  if (oerr) throw new Error(`[accounting] ${oerr.message}`);
  if (!order) throw notFound("找不到訂單");
  const { data: txs, error } = await db
    .from("sales_order_transactions")
    .select("id, category, status, amount, merchant_trade_no, trade_no, credit_card_number, date_transaction")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", id)
    .order("date_transaction", { ascending: true });
  if (error) throw new Error(`[accounting] ${error.message}`);
  const rows = (txs ?? []) as TxRow[];
  const labels = new Map<string, string>();
  for (const s of ["PENDING", "SUCCESS", "FAILED", "CANCELED"]) labels.set(s, await enumLabel("SalesOrderTransaction.status", s));
  const result = summarizeTransactions(rows, { totalPaid: Number(order.total_paid) }, (c) => labels.get(c) ?? c);
  if (rows.length) {
    const summary = result.error
      ? `檢核失敗：${result.error}`
      : `收款 ${result.amount ?? 0}${result.refund ? `／退款 ${Math.abs(result.refund)}` : ""}${result.short ? `／差額 ${result.short}` : ""}`;
    const { error: uerr } = await db
      .from("sales_order_transactions")
      .update({ verified: true, date_verified: new Date().toISOString(), verify_result: summary })
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", id);
    if (uerr) throw new Error(`[accounting] ${uerr.message}`);
  }
  const ni = notIntegrated("金流後台查詢（金流對帳檢核）");
  return json({ code: 200, data: [{ salesOrderId: order.id, uuid: order.uuid, ...result }], ...ni });
}

export const salesOrderTransactionRoutes: RouteDef[] = [
  page("/backend/SalesOrderTransaction/list", {
    template: "accounting/salesordertransaction-list.html",
    title: (ctx) => `金流交易紀錄 - ${ctx.groupBuy?.title ?? ""}`,
    groupBuy: "required",
  }),
  post("/ajax/SalesOrderTransaction/verify", verify),
];
