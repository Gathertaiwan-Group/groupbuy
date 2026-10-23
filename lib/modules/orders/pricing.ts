// 訂單金額重算（編輯訂單「重新計算總額跟運費」「重新計算優惠」、還原取消、拆單/合併後）。
// - 優惠：使用 marketing 模組的計算引擎（lib/modules/marketing/pricing-rules.ts 的 evaluatePricing，只讀依賴）；
//   該模組尚未提供時降級為「維持訂單原有優惠金額」並回傳提示。
// - 運費：依訂單綁定的運費規則（flat_rate_shippings：x 滿足條件、y 基本運費、z 滿足條件後運費、外島/國外/貨到付款費）。
//   規則語意依 SPEC「運費規則」欄位標題推導（記於 docs/modules/orders.md）。
import type { AdminSession } from "@/lib/core/http/types";
import type { Row } from "@/lib/db/mapping";
import { adminUpdateOrders, db, fetchOrder } from "./common";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const round = (v: number) => Math.round(v);

type MarketingPricing = {
  evaluatePricing?: (input: Record<string, unknown>) => {
    salesRuleDiscount: number;
    couponDiscount: number;
    appliedRules: { salesRuleId: number; title: string; discount: number; points: number }[];
    lines: { key: string | number; discount: number }[];
  };
};
type PricingLoader = {
  /** marketing 若提供：由 DB 組 evaluatePricing 輸入（訂單 → PricingInput） */
  loadPricingInputForOrder?: (session: AdminSession, salesOrderId: number) => Promise<Record<string, unknown> | null>;
};

/** 選擇性載入 marketing 的計算引擎（檔案不存在時回 null；webpack 對 try 內的 require 視為可選依賴） */
function marketingPricing(): (MarketingPricing & PricingLoader) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rules = require("@/lib/modules/marketing/pricing-rules") as MarketingPricing;
    let loader: PricingLoader = {};
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loader = require("@/lib/modules/marketing/pricing-loader") as PricingLoader;
    } catch {
      loader = {};
    }
    return { ...rules, ...loader };
  } catch {
    return null;
  }
}

/** 運費（不含貨到付款手續費） */
export function shippingFee(rule: Row | null, order: Row, subtotal: number, pieces: number): { shipping: number; codFee: number } {
  if (!rule) return { shipping: num(order.shipping_amount), codFee: num(order.cod_fee) };
  const x = num(rule.x), y = num(rule.y), z = num(rule.z);
  let fee: number;
  switch (String(rule.category ?? "PRICE")) {
    case "PRICE":
    case "PRICE_TAG":
      fee = x > 0 && subtotal >= x ? z : y;
      break;
    case "PIECE":
    case "PIECE_TAG":
      fee = x > 0 && pieces >= x ? z : y;
      break;
    case "PER_PIECE":
      fee = y * Math.max(pieces, 0);
      break;
    case "STANDARD_FREE":
      fee = 0;
      break;
    default:
      fee = y;
  }
  if (order.shipping_island && num(rule.island_fee) > 0) {
    fee = rule.island_shipping_rate_type === "TOP_ON_BASE_RATE" ? fee + num(rule.island_fee) : num(rule.island_fee);
  }
  if (order.shipping_oversea && num(rule.oversea_fee) > 0) fee = num(rule.oversea_fee);
  const codFee = Number(order.payment_method) === 16 ? num(rule.pay_on_delivery_fee) : 0;
  return { shipping: round(fee), codFee: round(codFee) };
}

export interface RecalcResult {
  grandTotal: number;
  shippingAmount: number;
  discountAmount: number;
  message: string;
}

/** 重算訂單商品小計、優惠、運費與結帳金額並寫回（歷程備註「重新計算…」） */
export async function recalcOrderAmounts(
  session: AdminSession,
  salesOrderId: number,
  opt: { shipping: boolean; salesRules: boolean },
): Promise<RecalcResult> {
  const client = db();
  const order = await fetchOrder(session, salesOrderId);
  const { data: itemsData } = await client
    .from("order_items")
    .select("id,item_id,group_buy_item_set_id,title,price,retail_price,total,discount,amount,back_order,gift,bundle_child")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", salesOrderId);
  const items = (itemsData ?? []) as Row[];
  const messages: string[] = [];

  // 優惠
  let ruleDiscount = 0;
  let couponDiscount = 0;
  const [{ data: sr }, { data: cp }] = await Promise.all([
    client.from("sales_order_sales_rules").select("discount").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId),
    client.from("sales_order_coupons").select("discount").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId),
  ]);
  ruleDiscount = ((sr ?? []) as { discount: number }[]).reduce((s, r) => s + num(r.discount), 0);
  couponDiscount = ((cp ?? []) as { discount: number }[]).reduce((s, r) => s + num(r.discount), 0);
  const lineDiscount = new Map<number, number>();
  if (opt.salesRules) {
    const mk = marketingPricing();
    const input = mk?.loadPricingInputForOrder ? await mk.loadPricingInputForOrder(session, salesOrderId) : null;
    if (mk?.evaluatePricing && input) {
      const res = mk.evaluatePricing(input);
      ruleDiscount = num(res.salesRuleDiscount);
      couponDiscount = num(res.couponDiscount);
      for (const l of res.lines ?? []) lineDiscount.set(Number(l.key), num(l.discount));
      await client.from("sales_order_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId);
      const applied = (res.appliedRules ?? []).filter((a) => num(a.discount) || num(a.points));
      if (applied.length) {
        await client.from("sales_order_sales_rules").insert(
          applied.map((a) => ({
            tenant_id: session.tenantId,
            sales_order_id: salesOrderId,
            sales_rule_id: a.salesRuleId,
            title: a.title,
            discount: num(a.discount),
            points: num(a.points) || null,
          })),
        );
      }
      messages.push("已重新計算優惠");
    } else {
      messages.push("已重新計算優惠（優惠計算模組未提供，維持訂單原有優惠金額）");
    }
  }

  // 商品小計
  let subtotal = 0;
  let pieces = 0;
  for (const it of items) {
    const disc = lineDiscount.has(Number(it.id)) ? lineDiscount.get(Number(it.id))! : num(it.discount);
    const amount = round(num(it.price) * num(it.total) - disc);
    subtotal += amount;
    if (!it.bundle_child) pieces += num(it.total);
    if (amount !== num(it.amount) || disc !== num(it.discount)) {
      await client.from("order_items").update({ amount, discount: disc }).eq("tenant_id", session.tenantId).eq("id", it.id);
    }
  }

  let shippingAmount = num(order.shipping_amount);
  let codFee = num(order.cod_fee);
  if (opt.shipping) {
    let rule: Row | null = null;
    if (order.flat_rate_shipping_id) {
      const { data } = await client.from("flat_rate_shippings").select("*").eq("tenant_id", session.tenantId).eq("id", order.flat_rate_shipping_id).maybeSingle();
      rule = (data as Row) ?? null;
    }
    const f = shippingFee(rule, order, subtotal - ruleDiscount, pieces);
    shippingAmount = f.shipping;
    codFee = f.codFee;
    messages.push(rule ? `已依運費規則「${rule.title}」重新計算運費` : "訂單未綁定運費規則，維持原運費");
  }
  const discountAmount = round(ruleDiscount + couponDiscount);
  const grandTotal = Math.max(0, round(subtotal - discountAmount + shippingAmount + codFee + num(order.extra_fee)));
  await adminUpdateOrders(
    session,
    [salesOrderId],
    { grand_total: grandTotal, shipping_amount: shippingAmount, cod_fee: codFee, discount_amount: discountAmount },
    `重新計算金額：結帳金額 ${round(num(order.grand_total))}→${grandTotal}`,
  );
  return { grandTotal, shippingAmount, discountAmount, message: messages.join("；") || `已重新計算結帳金額 $${grandTotal}` };
}
