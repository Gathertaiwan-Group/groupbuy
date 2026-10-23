// 優惠計算正式版：包裝 marketing 模組的 pricing-loader（讀 DB）＋ pricing-rules（純函式引擎）成 storefront 的 PricingRulesProvider。
// 只讀 import marketing，不改 marketing 的檔。金額一律在伺服器端重算（購物袋顯示與建立訂單都經 priceCart）。
import { getServiceClient } from "@/lib/supabase/server";
import { evaluatePricing, resolveGifts, type PricingCoupon, type PricingCustomer } from "@/lib/modules/marketing/pricing-rules";
import { findCouponByCode, loadCartLines, loadGiftCandidates, loadSalesRulesForGroupBuy } from "@/lib/modules/marketing/pricing-loader";
import type { AppliedCoupon, AppliedSalesRule, PricingRulesProvider } from "./pricing";

async function loadCustomer(tenantId: number, customerId: number | null): Promise<PricingCustomer | null> {
  if (!customerId) return null;
  const { data } = await getServiceClient()
    .from("customers")
    .select("id, royalty_program_id")
    .eq("tenant_id", tenantId)
    .eq("id", customerId)
    .maybeSingle();
  const row = data as { id: number; royalty_program_id: number | null } | null;
  return row ? { customerId: row.id, royaltyProgramId: row.royalty_program_id ?? null } : null;
}

export const marketingPricingRules: PricingRulesProvider = {
  async apply({ tenantId, groupBuy, lines, couponCodes, customerId, postcode }) {
    const lineDiscounts = new Map<string, number>();
    const salesRules: AppliedSalesRule[] = [];
    const coupons: AppliedCoupon[] = [];
    const couponNotes: string[] = [];
    const paid = lines.filter((l) => !l.gift && l.qty > 0);
    if (paid.length === 0) return { salesRules, coupons, lineDiscounts, couponNotes };

    const db = getServiceClient();
    const [{ rules, couponOnlySalesRuleIds }, cartLines, customer] = await Promise.all([
      loadSalesRulesForGroupBuy(db, tenantId, groupBuy.id),
      loadCartLines(
        db,
        tenantId,
        groupBuy.id,
        paid.map((l) => ({ key: l.uuid, itemId: l.itemId, quantity: l.qty, backOrder: l.backOrder, groupBuyItemSetId: l.groupBuyItemSetId, price: l.price })),
      ),
      loadCustomer(tenantId, customerId),
    ]);

    // 原站一張訂單只用一組折扣碼：取最後兌換的那組
    const code = couponCodes.length ? couponCodes[couponCodes.length - 1] : "";
    let coupon: PricingCoupon | null = null;
    if (code) {
      coupon = await findCouponByCode(db, tenantId, groupBuy.id, code);
      if (!coupon) couponNotes.push(`優惠碼「${code}」不存在或已失效`);
    }

    const r = evaluatePricing({
      lines: cartLines,
      salesRules: rules,
      couponOnlySalesRuleIds,
      coupon,
      customer,
      postcode: postcode || null,
      groupBuyId: groupBuy.id,
    });

    for (const l of r.lines) if (l.discount > 0) lineDiscounts.set(String(l.key), l.discount);
    for (const a of r.appliedRules) {
      salesRules.push({ salesRuleId: a.salesRuleId, title: a.title, discount: a.discount, category: a.category });
    }
    if (r.coupon && coupon) {
      if (r.coupon.applied) {
        coupons.push({
          groupBuyCouponId: r.coupon.groupBuyCouponId,
          couponCodeId: r.coupon.couponCodeId,
          code: r.coupon.code,
          title: coupon.title ?? r.coupon.code,
          category: coupon.category,
          discount: r.coupon.discount,
        });
      } else if (r.coupon.message) {
        couponNotes.push(r.coupon.message);
      }
    }

    // 贈品：解析出自動贈品／可選贈品；購物袋尚未支援把贈品加成明細，先以提示呈現（記入已知缺口）
    const giftNotes: string[] = [];
    if (r.gifts.length) {
      const g = resolveGifts(r.gifts, await loadGiftCandidates(db, tenantId, groupBuy.id, r.gifts.map((x) => x.giftTag)));
      for (const a of g.auto) giftNotes.push(`符合贈品：${a.title} x ${a.quantity}`);
      for (const p of g.pick) giftNotes.push(`可選贈品 ${p.quantity} 件（${p.giftTag ?? ""}）`);
    }

    return {
      salesRules,
      coupons,
      lineDiscounts,
      couponNotes,
      freeShipping: r.freeShipping,
      blockers: r.checkoutAllowed ? [] : r.messages.length ? r.messages : ["未符合本團購的購買條件，暫時無法結帳"],
      giftNotes,
    };
  },
};
