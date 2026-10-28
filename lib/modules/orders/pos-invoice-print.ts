// 訂單頁「列印發票」（PARITY #68）：原站 salesOrderList.min.js 在 conf.posEnabled 且訂單有發票號碼時，
// 卡片底部顯示 <a href="{ctx}/{租戶}/ajax/pos/Invoice/print?salesOrderId=">列印發票</a>（target=_blank）。
// 本系統 POS 收據在 /pos/ajax/{租戶}/{短網址}/Invoice/print?salesOrderId=（storefront/pos/pages.ts receipt，
// 以短網址限定團購）；這裡依訂單所屬團購的短網址轉址過去。
//   GET /ajax/pos/Invoice/print?salesOrderId=   （可帶 /{租戶}/ 前綴與 .do）
// conf.posEnabled＝租戶有任一 POS 型團購（render='POS' 且有短網址；同 POS getPosList 的判斷）。
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { redirect } from "@/lib/core/http/responses";
import { getServiceClient } from "@/lib/supabase/server";
import { posInvoicePrintPath } from "./pos-invoice-print-path";

export async function tenantPosEnabled(tenantId: number): Promise<boolean> {
  const { count } = await getServiceClient()
    .from("group_buys")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("render", "POS")
    .not("short_url", "is", null);
  return (count ?? 0) > 0;
}

async function printInvoice(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(ctx.query.get("salesOrderId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  const db = getServiceClient();
  const { data: o } = await db.from("sales_orders").select("id, group_buy_id").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle<{ id: number; group_buy_id: number | null }>();
  if (!o) throw notFound("找不到訂單");
  const { data: gb } = o.group_buy_id
    ? await db.from("group_buys").select("short_url").eq("tenant_id", session.tenantId).eq("id", o.group_buy_id).maybeSingle<{ short_url: string | null }>()
    : { data: null };
  const path = posInvoicePrintPath(session.tenantCode, gb?.short_url ?? null, o.id);
  if (!path) throw notFound("此訂單的團購沒有短網址，無法列印 POS 收據");
  return redirect(path, 302);
}

export const posInvoicePrintRoutes: RouteDef[] = [get("/ajax/pos/Invoice/print", printInvoice)];
