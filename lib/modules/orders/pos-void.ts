// POS 作廢（fix3）：POS 結帳的訂單（明細已取貨）回補庫存、沖銷付款、訂單改為已取消。
// 原子操作在 DB 函式 groupbuy.pos_void_order（supabase/migrations/6005_storefront_pos_void.sql），一張訂單一個交易。
// 端點：
//   POST /ajax/SalesOrder/posVoid           後台訂單列表工具列「POS 作廢」（salesOrderId=1,2、reason）
//   POST /pos/ajax/{租戶}/{短網址}/SalesOrder/void   POS「查詢訂單」分頁（storefront/pos/api.ts 呼叫 posVoidOrders）
//   GET  /ajax/SalesOrder/posVoidPreview    確認框用摘要（salesOrderId=1,2）：可否作廢、回補件數、沖銷金額
// 後台一般「刪除」維持原規則（只釋放未出貨明細）；選到 POS 訂單時前端提示改用作廢（templates/orders/salesorder-list.html）。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { db, idsParam, strParam } from "./common";
import { posVoidBlockReason, posVoidErrorMessage, posVoidSummary } from "./pos-void-rules";

export interface PosVoidResult {
  done: { salesOrderId: number; uuid: string; restoredQty: number; reversedAmount: number }[];
  failed: { salesOrderId: number; error: string }[];
}

/** 逐張呼叫 pos_void_order（每張各自一個交易；失敗的不影響其他張） */
export async function posVoidOrders(session: AdminSession, ids: number[], reason: string): Promise<PosVoidResult> {
  const out: PosVoidResult = { done: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    const { data, error } = await db().rpc("pos_void_order", {
      p_tenant_id: session.tenantId,
      p_sales_order_id: id,
      p_admin_user_id: session.adminUserId ?? null,
      p_reason: reason.slice(0, 200) || null,
    });
    if (error) {
      const msg = posVoidErrorMessage(error.message);
      if (!msg) throw new Error(`[orders] POS 作廢失敗：${error.message}`);
      out.failed.push({ salesOrderId: id, error: msg });
      continue;
    }
    const r = data as { salesOrderId: number; uuid: string; restoredQty: number; reversedAmount: number };
    out.done.push({ salesOrderId: Number(r.salesOrderId), uuid: String(r.uuid), restoredQty: Number(r.restoredQty) || 0, reversedAmount: Number(r.reversedAmount) || 0 });
  }
  return out;
}

/** 結果 → 回應（全部失敗 400；部分成功 200 並列出未作廢原因） */
export function posVoidResponse(r: PosVoidResult): Response {
  const fails = r.failed.map((f) => `${f.salesOrderId}：${f.error}`).join("；");
  if (!r.done.length) throw badRequest(fails || "沒有可作廢的訂單");
  const qty = r.done.reduce((s, d) => s + d.restoredQty, 0);
  const amt = r.done.reduce((s, d) => s + d.reversedAmount, 0);
  const msg = `已作廢 ${r.done.length} 筆 POS 訂單（回補庫存 ${qty} 件、沖銷付款 $${amt}）${fails ? `；未作廢：${fails}` : ""}`;
  return actionOk(msg, { data: r.done, failed: r.failed });
}

/** 確認框摘要：讀訂單、明細、付款明細，以與 DB 函式相同的規則計算 */
export async function posVoidPreview(session: AdminSession, ids: number[]) {
  if (!ids.length) return [];
  const client = db();
  const { data: orders, error } = await client
    .from("sales_orders")
    .select("id, uuid, state, group_buys(render), order_items(item_id,total,back_order,state)")
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[orders] 讀取訂單失敗：${error.message}`);
  const { data: pays, error: e2 } = await client
    .from("pos_payments")
    .select("sales_order_id, payment_method, payment_method_tag, amount")
    .eq("tenant_id", session.tenantId)
    .in("sales_order_id", ids);
  if (e2) throw new Error(`[orders] 讀取付款明細失敗：${e2.message}`);
  type O = { id: number; uuid: string; state: string; group_buys: { render: string | null } | null; order_items: { item_id: number | null; total: number; back_order: boolean; state: string }[] };
  type P = { sales_order_id: number; payment_method: number; payment_method_tag: string; amount: number };
  const payRows = (pays ?? []) as P[];
  return ((orders ?? []) as unknown as O[]).map((o) => {
    const ps = payRows.filter((p) => Number(p.sales_order_id) === Number(o.id)).map((p) => ({ paymentMethod: Number(p.payment_method), paymentMethodTag: String(p.payment_method_tag ?? ""), amount: Number(p.amount) || 0 }));
    const items = (o.order_items ?? []).map((i) => ({ itemId: i.item_id == null ? null : Number(i.item_id), total: Number(i.total) || 0, backOrder: !!i.back_order, state: String(i.state) }));
    const block = posVoidBlockReason({ state: String(o.state), groupBuyRender: o.group_buys?.render ?? null, hasPosPayments: ps.length > 0 });
    return {
      salesOrderId: Number(o.id),
      uuid: String(o.uuid),
      posOrder: block !== "POS_VOID_NOT_POS",
      canVoid: block === null,
      error: block ? posVoidErrorMessage(block) : null,
      ...posVoidSummary(items, ps),
    };
  });
}

async function posVoidHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await idsParam(ctx, "salesOrderId", "salesOrderIds");
  if (!ids.length) throw badRequest("請先選擇訂單");
  if (ids.length > 100) throw badRequest("一次最多作廢 100 筆");
  return posVoidResponse(await posVoidOrders(session, ids, await strParam(ctx, "reason")));
}

async function posVoidPreviewHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = (await idsParam(ctx, "salesOrderId", "salesOrderIds")).slice(0, 100);
  return json({ code: 200, error: "", data: await posVoidPreview(session, ids) });
}

export const posVoidRoutes: RouteDef[] = [
  post("/ajax/SalesOrder/posVoid", posVoidHandler),
  get("/ajax/SalesOrder/posVoidPreview", posVoidPreviewHandler),
];
