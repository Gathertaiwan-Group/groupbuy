// 所有訂單列表回應的 options（Editor 下拉、表尾 select、renderOption 顯示文字）。
// 鍵與順序同原站 runtime：shippingTag, country, deliverTime, shippingType, installment, receiptType, shippingProvider,
// receiptCarrierType, action, paymentMethod, state, status；另加 flatRateShippingId（Editor「運費規則」）。
import type { AdminSession } from "@/lib/core/http/types";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { enumOptions } from "@/lib/core/enums";
import { db } from "./common";

export async function orderListOptions(session: AdminSession, groupBuyId?: number | null): Promise<EditorOptions> {
  const client = db();
  const [tags, rules] = await Promise.all([
    client.from("shipping_tags").select("tag").eq("tenant_id", session.tenantId).order("id"),
    groupBuyId
      ? client
          .from("group_buy_flat_rate_shippings")
          .select("seq, flat_rate_shippings(id,title)")
          .eq("tenant_id", session.tenantId)
          .eq("group_buy_id", groupBuyId)
          .order("seq")
      : client.from("flat_rate_shippings").select("id,title").eq("tenant_id", session.tenantId).order("id"),
  ]);
  const tagRows = (tags.data ?? []) as { tag: string | null }[];
  const shippingTag = [{ label: "無", value: "" }, ...tagRows.filter((t) => t.tag).map((t) => ({ label: String(t.tag), value: String(t.tag) }))];
  const ruleRows = groupBuyId
    ? ((rules.data ?? []) as unknown as { flat_rate_shippings: { id: number; title: string } | null }[]).map((r) => r.flat_rate_shippings).filter(Boolean)
    : ((rules.data ?? []) as { id: number; title: string }[]);
  const flatRateShippingId = [{ label: "選擇", value: "" }, ...(ruleRows as { id: number; title: string }[]).map((r) => ({ label: r.title, value: r.id }))];

  return {
    shippingTag,
    country: await enumOptions("Country"),
    deliverTime: (await enumOptions("SalesOrder.deliverTime", true)).map((o) => ({ ...o, value: Number(o.value) })),
    shippingType: await enumOptions("ShippingType"),
    "salesOrderBillingAddress.installment": await enumOptions("SalesOrder.installment"),
    "salesOrderBillingAddress.receiptType": (await enumOptions("SalesOrder.receiptType")).map((o) => ({ ...o, value: Number(o.value) })),
    shippingProvider: await enumOptions("SalesOrder.shippingProvider"),
    "salesOrderBillingAddress.receiptCarrierType": (await enumOptions("SalesOrder.receiptCarrierType")).map((o) => ({ ...o, value: Number(o.value) })),
    action: await enumOptions("SalesOrder.action"),
    paymentMethod: (await enumOptions("SalesOrder.paymentMethod")).map((o) => ({ ...o, value: Number(o.value) })),
    state: await enumOptions("SalesOrder.state"),
    status: await enumOptions("SalesOrder.status"),
    flatRateShippingId,
  };
}
