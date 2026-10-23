// 金流對帳（金流交易紀錄）：/backend/SalesOrderTransaction/list?groupBuyId=
// 依據：SPEC「金流對帳」與 7.5（「檢核」逐筆呼叫 /ajax/SalesOrderTransaction/verify）、spec/runtime/salesordertransaction-list.records.txt。
// 列表呼叫 orders 模組的 POST /ajax/SalesOrder/list；本模組負責頁面與「檢核」。
//
// POST /ajax/SalesOrderTransaction/verify   參數 salesOrderId（一次一筆）
// 金流後台未串接：改以本系統 groupbuy.sales_order_transactions（成功收款、成功退款）對照訂單已付金額，
// 並把檢核結果寫回該訂單的交易紀錄（verified、date_verified、verify_result）。
//
// 回應（本系統自訂格式；計算見 transaction-verify.ts）：
//   { code: 200, notIntegrated: true, message,
//     data: [{ salesOrderId, uuid, found, received, refunded, net, orderPaid, difference,
//              lastStatus, merchantOrderId, cardNumber, error }] }
//   found：有無交易紀錄；received：成功收款合計；refunded：成功退款合計（正數）；net＝received−refunded；
//   orderPaid：訂單已付金額；difference＝orderPaid−net（0＝相符）；error：無法檢核的原因（沒有紀錄／沒有成功收款），可檢核時為 null。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { enumLabel } from "@/lib/core/enums";
import { verifyResultText, verifySummary, type VerifyTx } from "./transaction-verify";

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
    .select("category, status, amount, merchant_trade_no, trade_no, credit_card_number, date_transaction")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", id)
    .order("date_transaction", { ascending: true });
  if (error) throw new Error(`[accounting] ${error.message}`);
  const rows = (txs ?? []) as VerifyTx[];
  const labels = new Map<string, string>();
  for (const s of new Set(rows.map((r) => r.status))) labels.set(s, await enumLabel("SalesOrderTransaction.status", s));
  const summary = verifySummary(rows, Number(order.total_paid), (c) => labels.get(c) ?? c);
  if (rows.length) {
    const { error: uerr } = await db
      .from("sales_order_transactions")
      .update({ verified: true, date_verified: new Date().toISOString(), verify_result: verifyResultText(summary) })
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", id);
    if (uerr) throw new Error(`[accounting] ${uerr.message}`);
  }
  const ni = notIntegrated("金流後台查詢（金流對帳檢核）");
  return json({ code: 200, data: [{ salesOrderId: order.id, uuid: order.uuid, ...summary }], ...ni });
}

export const salesOrderTransactionRoutes: RouteDef[] = [
  page("/backend/SalesOrderTransaction/list", {
    template: "accounting/salesordertransaction-list.html",
    title: (ctx) => `金流交易紀錄 - ${ctx.groupBuy?.title ?? ""}`,
    groupBuy: "required",
  }),
  post("/ajax/SalesOrderTransaction/verify", verify),
];
