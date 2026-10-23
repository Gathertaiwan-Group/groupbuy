// 訂單金額重算（編輯訂單「重新計算總額跟運費」「重新計算優惠」、還原取消、搬移商品、優惠卷增刪、更改配送方式）。
// 只讀依賴（不改對方的檔）：
//   - 優惠：marketing 的計算引擎 `evaluatePricing()`＋`loadPricingInputForOrder()`（pricing-rules.ts / pricing-loader.ts）
//   - 運費：shipping 的 `calculateShippingFee()`＋`loadGroupBuyShipping()`／`cartLineFromItem()`（shipping-fee.ts / shipping-data.ts）
//
// 金額慣例（同 storefront order-place）：
//   order_items.amount = price×total − discount（discount＝該列的商品層級折扣）
//   sales_orders.discount_amount＝優惠條件＋優惠卷折扣合計
//   sales_orders.shipping_amount＝運費＋貨到付款手續費（cod_fee 另存一份）
//   sales_orders.grand_total＝Σ(非贈品、非組合子項 price×total) − discount_amount ＋ shipping_amount ＋ 稅（團購 tax_rate%）＋ extra_fee
import type { AdminSession } from "@/lib/core/http/types";
import type { Row } from "@/lib/db/mapping";
import { paymentBitsToCodes } from "@/lib/db/derived";
import { evaluatePricing } from "@/lib/modules/marketing/pricing-rules";
import { loadPricingInputForOrder } from "@/lib/modules/marketing/pricing-loader";
import { calculateShippingFee, type CartLine } from "@/lib/modules/shipping/shipping-fee";
import { cartLineFromItem, loadGroupBuyShipping } from "@/lib/modules/shipping/shipping-data";
import { adminUpdateOrders, db, fetchOrder } from "./common";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const round = (v: number) => Math.round(v);

export interface RecalcOptions {
  /** 依訂單的配送方式（運費規則）重新計算運費（含品項運費、貨到付款手續費） */
  shipping: boolean;
  /** 重新套用優惠條件與優惠卷（marketing 引擎；商品層級折扣寫回訂單商品） */
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
    .select("id,item_id,group_buy_item_set_id,title,price,total,discount,amount,back_order,gift,bundle_child")
    .eq("tenant_id", session.tenantId)
    .eq("sales_order_id", salesOrderId)
    .order("seq")
    .order("id");
  if (itemsErr) throw new Error(`[orders] 讀取訂單商品失敗：${itemsErr.message}`);
  const allItems = (itemsData ?? []) as Row[];
  const priced = allItems.filter((i) => !i.bundle_child);
  const gross = priced.reduce((s, i) => s + (i.gift ? 0 : num(i.price) * num(i.total)), 0);

  let discountAmount = Math.max(0, round(num(order.discount_amount) + num(opt.discountDelta)));
  let shippingAmount = round(num(order.shipping_amount));
  let codFee = round(num(order.cod_fee));
  let couponFreeShipping = false;
  const messages: string[] = [];
  const groupBuyId = Number(order.group_buy_id) || null;

  if ((opt.shipping || opt.salesRules) && !groupBuyId) {
    messages.push("訂單沒有所屬團購，無法依團購設定重新計算，維持原運費與折扣");
  }

  // ── 優惠（marketing 引擎） ──
  if (opt.salesRules && groupBuyId) {
    const input = await loadPricingInputForOrder(session, salesOrderId);
    if (!input) {
      messages.push("無法讀取訂單的優惠計算資料，維持原折扣");
    } else {
      const res = evaluatePricing(input);
      discountAmount = round(num(res.totalDiscount));
      couponFreeShipping = !!res.freeShipping;
      const lineDisc = new Map(res.lines.map((l) => [Number(l.key), round(num(l.discount))]));
      for (const it of priced) {
        const d = lineDisc.get(Number(it.id)) ?? 0;
        const amount = round(num(it.price) * num(it.total) - d);
        if (d !== round(num(it.discount)) || amount !== round(num(it.amount))) {
          await client.from("order_items").update({ discount: d, amount }).eq("tenant_id", session.tenantId).eq("id", it.id);
        }
      }
      await client.from("sales_order_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId);
      const applied = res.appliedRules.filter((r) => num(r.discount) > 0 || num(r.points) > 0);
      if (applied.length) {
        const { error } = await client.from("sales_order_sales_rules").insert(
          applied.map((r) => ({
            tenant_id: session.tenantId,
            sales_order_id: salesOrderId,
            sales_rule_id: r.salesRuleId,
            title: r.title,
            discount: round(num(r.discount)),
            points: num(r.points) ? round(num(r.points)) : null,
          })),
        );
        if (error) throw new Error(`[orders] 寫入訂單優惠條件失敗：${error.message}`);
      }
      if (res.coupon) {
        const c = res.coupon;
        const { data: rows } = await client.from("sales_order_coupons").select("id,coupon,coupon_code_id,discount").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId);
        const row = ((rows ?? []) as Row[]).find((x) => (c.couponCodeId && Number(x.coupon_code_id) === Number(c.couponCodeId)) || String(x.coupon ?? "") === c.code);
        const d = c.applied ? round(num(c.discount)) : 0;
        if (row && round(num(row.discount)) !== d) {
          await client.from("sales_order_coupons").update({ discount: d, points: num(c.points) ? round(num(c.points)) : null }).eq("tenant_id", session.tenantId).eq("id", row.id);
        }
        if (!c.applied && c.message) messages.push(`優惠卷 ${c.code}：${c.message}`);
      }
      messages.push(`已重新計算優惠（折扣合計 $${discountAmount}${applied.length ? `：${applied.map((r) => r.title).join("、")}` : ""}）`);
      if (res.gifts.length) messages.push("贈品資格需自行調整訂單商品（重新計算不會自動增刪贈品）");
    }
  }

  // ── 運費（shipping 計算） ──
  if (opt.shipping && groupBuyId) {
    const ruleId = Number(order.flat_rate_shipping_id) || null;
    if (!ruleId) {
      messages.push("訂單未設定運費規則，維持原運費");
    } else {
      const ship = await loadGroupBuyShipping(session.tenantId, groupBuyId, client);
      if (!ship.rules.some((r) => Number(r.flatRateShippingId) === ruleId)) {
        messages.push("訂單的運費規則不在此團購的運費設定中，維持原運費");
      } else {
        const itemIds = [...new Set(allItems.map((i) => Number(i.item_id)).filter((x) => x > 0))];
        const itemRows = new Map<number, Row>();
        if (itemIds.length) {
          const { data } = await client.from("items").select("*").eq("tenant_id", session.tenantId).in("id", itemIds);
          for (const r of (data ?? []) as Row[]) itemRows.set(Number(r.id), r);
        }
        const lines: CartLine[] = allItems
          .filter((i) => num(i.total) > 0)
          .map((i) => {
            const item = itemRows.get(Number(i.item_id));
            const base: CartLine = item
              ? cartLineFromItem(item, {
                  quantity: num(i.total),
                  backOrder: !!i.back_order,
                  groupBuyItemSetId: i.group_buy_item_set_id ? Number(i.group_buy_item_set_id) : undefined,
                  groupBuyItemSetIdByItemSetId: ship.groupBuyItemSetIdByItemSetId,
                  price: num(i.price),
                  bundleChild: !!i.bundle_child,
                })
              : { title: String(i.title ?? ""), price: num(i.price), quantity: num(i.total), backOrder: !!i.back_order, bundleChild: !!i.bundle_child };
            return { ...base, gift: !!i.gift || !!base.gift };
          });
        const { data: cps } = await client.from("sales_order_coupons").select("coupon").eq("tenant_id", session.tenantId).eq("sales_order_id", salesOrderId);
        const couponCodes = ((cps ?? []) as { coupon: string | null }[]).map((c) => String(c.coupon ?? "").trim()).filter(Boolean);
        const r = calculateShippingFee({
          groupBuy: ship.groupBuy,
          rules: ship.rules,
          itemSetRules: ship.itemSetRules,
          lines,
          selectedRuleId: ruleId,
          address: { country: (order.shipping_country as string) || "TW", postcode: (order.shipping_postcode as string) || null, island: order.shipping_island ? true : null },
          paymentMethod: paymentBitsToCodes(Number(order.payment_method) || 0)[0] ?? null,
          couponCodes,
          discountAmount,
        });
        if (!r.rule || r.rule.flatRateShippingId !== ruleId) {
          messages.push(`無法依運費規則計算（${r.errors.join("；") || "配送方式不可用"}），維持原運費`);
        } else {
          codFee = round(num(r.codFee));
          const fee = couponFreeShipping ? 0 : round(num(r.shippingAmount));
          shippingAmount = fee + codFee;
          messages.push(
            `已依運費規則「${r.rule.title}」重新計算運費 $${shippingAmount}${codFee ? `（含貨到付款手續費 $${codFee}）` : ""}${couponFreeShipping ? "（優惠卷免運）" : ""}`,
          );
          if (r.errors.length) messages.push(r.errors.join("；"));
        }
      }
    }
  }

  let taxRate = 0;
  if (groupBuyId) {
    const { data: gb } = await client.from("group_buys").select("tax_rate").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle();
    taxRate = num((gb as Row | null)?.tax_rate);
  }
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
