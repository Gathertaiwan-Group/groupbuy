// 訂單金額重算（編輯訂單「重新計算總額跟運費」「重新計算優惠」、還原取消、搬移商品、優惠卷增刪、更改配送方式）。
// 計價一律走 storefront 的 priceCart()（lib/modules/storefront/pricing.ts，只讀依賴）：與前台結帳同一套運費／優惠計算，
// storefront 換成 shipping / marketing 正式 provider 後，這裡自動一致。
//
// 金額慣例（同 storefront order-place）：
//   order_items.amount = price×total − discount（discount＝該列分攤到的折扣）
//   sales_orders.discount_amount＝優惠條件＋優惠卷折扣合計
//   sales_orders.shipping_amount＝運費＋貨到付款手續費（cod_fee 另存一份）
//   sales_orders.grand_total＝Σ(非贈品、非組合子項 price×total) − discount_amount ＋ shipping_amount ＋ 稅（團購 tax_rate%）＋ extra_fee
import type { AdminSession } from "@/lib/core/http/types";
import type { Row } from "@/lib/db/mapping";
import { loadGroupBuyShippingRules, priceCart, type PricingLine } from "@/lib/modules/storefront/pricing";
import type { SfGroupBuy } from "@/lib/modules/storefront/site";
import { adminUpdateOrders, db, fetchOrder } from "./common";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const round = (v: number) => Math.round(v);

export interface RecalcOptions {
  /** 依訂單綁定的運費規則重新計算運費（含貨到付款手續費） */
  shipping: boolean;
  /** 重新套用優惠條件與優惠卷（折扣重新分攤到訂單商品） */
  salesRules: boolean;
  /** 不重算優惠時，折扣合計的增減（優惠卷增刪、搬移商品帶走/帶來的折扣） */
  discountDelta?: number;
  /** 歷程備註前綴（例「更改配送方式」） */
  note?: string;
}

export interface RecalcResult {
  grandTotal: number;
  shippingAmount: number;
  discountAmount: number;
  message: string;
}

/** 重算訂單金額並寫回（歷程備註「重新計算金額：結帳金額 A→B」） */
export async function recalcOrderAmounts(session: AdminSession, salesOrderId: number, opt: RecalcOptions): Promise<RecalcResult> {
  const client = db();
  const order = await fetchOrder(session, salesOrderId);
  const { data: itemsData, error: itemsErr } = await client
    .from("order_items")
    .select("id,item_id,group_buy_item_set_id,item_set_id,title,price,total,discount,amount,back_order,gift,bundle_child")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", salesOrderId)
    .order("seq")
    .order("id");
  if (itemsErr) throw new Error(`[orders] 讀取訂單商品失敗：${itemsErr.message}`);
  const priced = ((itemsData ?? []) as Row[]).filter((i) => !i.bundle_child);
  const gross = priced.reduce((s, i) => s + (i.gift ? 0 : num(i.price) * num(i.total)), 0);

  let discountAmount = Math.max(0, round(num(order.discount_amount) + num(opt.discountDelta)));
  let shippingAmount = round(num(order.shipping_amount));
  let codFee = round(num(order.cod_fee));
  const messages: string[] = [];

  let gb: SfGroupBuy | null = null;
  if (order.group_buy_id) {
    const { data } = await client.from("group_buys").select("*").eq("tenant_id", session.tenantId).eq("id", order.group_buy_id).maybeSingle();
    gb = (data as SfGroupBuy | null) ?? null;
  }

  if ((opt.shipping || opt.salesRules) && !gb) {
    messages.push("訂單沒有所屬團購，無法依團購設定重新計算，維持原運費與折扣");
  } else if ((opt.shipping || opt.salesRules) && gb) {
    // 商品的運費屬性（材積/不計運費/運費標籤），同 storefront cart-data
    const itemIds = [...new Set(priced.map((i) => Number(i.item_id)).filter((x) => x > 0))];
    const meta = new Map<number, Row>();
    if (itemIds.length) {
      const { data } = await client
        .from("items")
        .select("id,item_settings,flat_rate_shipping_tag,exclude_shipping_rule")
        .eq("tenant_id", session.tenantId)
        .in("id", itemIds);
      for (const r of (data ?? []) as Row[]) meta.set(Number(r.id), r);
    }
    const lines: PricingLine[] = priced
      .filter((i) => Number(i.item_id) > 0 && num(i.total) > 0)
      .map((i) => {
        const m = meta.get(Number(i.item_id));
        return {
          uuid: String(i.id),
          itemId: Number(i.item_id),
          groupBuyItemSetId: Number(i.group_buy_item_set_id ?? 0),
          itemSetId: Number(i.item_set_id ?? 0),
          title: String(i.title ?? ""),
          price: num(i.price),
          qty: num(i.total),
          backOrder: !!i.back_order,
          gift: !!i.gift,
          flatRateShippingTag: String(m?.flat_rate_shipping_tag ?? ""),
          excludeShippingRule: !!m?.exclude_shipping_rule,
          weight: Number(((m?.item_settings ?? {}) as Row).weight) || 0,
        };
      });
    const { data: cps } = await client
      .from("sales_order_coupons")
      .select("id,coupon,discount,coupon_code_id,coupon_codes(code)")
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", salesOrderId);
    const couponRows = (cps ?? []) as unknown as (Row & { coupon_codes: { code?: string } | null })[];
    const codes = [...new Set(couponRows.map((c) => String(c.coupon_codes?.code ?? c.coupon ?? "").trim()).filter(Boolean))];
    const rules = await loadGroupBuyShippingRules(session.tenantId, gb.id);
    const ruleId = Number(order.flat_rate_shipping_id) || null;
    const rule = ruleId ? rules.find((r) => r.id === ruleId) ?? null : null;
    const result = await priceCart(
      {
        tenantId: session.tenantId,
        groupBuy: gb,
        lines,
        couponCodes: codes,
        customerId: order.customer_id ? Number(order.customer_id) : null,
        flatRateShippingId: ruleId,
        paymentMethod: Number(order.payment_method) || 0,
        shippingAddress: {
          country: (order.shipping_country as string) || undefined,
          postcode: (order.shipping_postcode as string) || undefined,
          city: (order.shipping_city as string) || undefined,
          district: (order.shipping_district as string) || undefined,
        },
      },
      { rules },
    );

    if (opt.salesRules) {
      discountAmount = round(result.totalDiscount);
      for (const it of priced) {
        const d = round(result.lineDiscounts.get(String(it.id)) ?? 0);
        const amount = round(num(it.price) * num(it.total) - d);
        if (d !== round(num(it.discount)) || amount !== round(num(it.amount))) {
          await client.from("order_items").update({ discount: d, amount }).eq("tenant_id", session.tenantId).eq("id", it.id);
        }
      }
      await client.from("sales_order_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId);
      const applied = result.salesRules.filter((r) => num(r.discount) > 0);
      if (applied.length) {
        const { error } = await client.from("sales_order_sales_rules").insert(
          applied.map((r) => ({ tenant_id: session.tenantId, sales_order_id: salesOrderId, sales_rule_id: r.salesRuleId, title: r.title, discount: round(r.discount) })),
        );
        if (error) throw new Error(`[orders] 寫入訂單優惠條件失敗：${error.message}`);
      }
      for (const c of result.coupons) {
        const row = couponRows.find((x) => (c.couponCodeId && Number(x.coupon_code_id) === c.couponCodeId) || String(x.coupon_codes?.code ?? x.coupon ?? "") === c.code);
        if (row && round(num(row.discount)) !== round(c.discount)) {
          await client.from("sales_order_coupons").update({ discount: round(c.discount) }).eq("tenant_id", session.tenantId).eq("id", row.id);
        }
      }
      messages.push(`已重新計算優惠（折扣合計 $${discountAmount}${applied.length ? `：${applied.map((r) => r.title).join("、")}` : ""}）`);
      if (result.couponNotes.length) messages.push(result.couponNotes.join("；"));
    }
    if (opt.shipping) {
      if (!ruleId) {
        messages.push("訂單未設定運費規則，維持原運費");
      } else if (!rule) {
        messages.push("訂單的運費規則不在此團購的運費設定中，維持原運費");
      } else {
        codFee = round(result.shipping.codFee);
        shippingAmount = round(result.shipping.shippingAmount) + codFee;
        messages.push(`已依運費規則「${rule.title}」重新計算運費 $${shippingAmount}${codFee ? `（含貨到付款手續費 $${codFee}）` : ""}`);
      }
    }
  }

  const taxRate = num(gb?.tax_rate);
  const tax = taxRate > 0 ? round(((gross - discountAmount) * taxRate) / 100) : 0;
  const grandTotal = Math.max(0, round(gross - discountAmount + shippingAmount + tax + num(order.extra_fee)));
  const before = round(num(order.grand_total));
  await adminUpdateOrders(
    session,
    [salesOrderId],
    { grand_total: grandTotal, shipping_amount: shippingAmount, cod_fee: codFee, discount_amount: discountAmount },
    `${opt.note ? `${opt.note}；` : ""}重新計算金額：結帳金額 ${before}→${grandTotal}`,
  );
  return { grandTotal, shippingAmount, discountAmount, message: messages.join("；") || `已重新計算結帳金額 $${grandTotal}` };
}
