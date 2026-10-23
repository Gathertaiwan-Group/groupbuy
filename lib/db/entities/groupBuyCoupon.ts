import type { EntityDef } from "../entity-types";

// 團購優惠卷（GroupBuyCoupon；可套樣板、綁定優惠條件、跨團）
// 表：groupbuy.group_buy_coupons
// 原站頁面：groupbuy-coupon
export const groupBuyCoupon: EntityDef = {
  table: "group_buy_coupons",
  idKey: "groupBuyCouponId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyCouponId: "id",
    groupBuyId: "group_buy_id",
    couponTemplateId: "coupon_template_id",
    salesRuleId: "sales_rule_id",
    useTemplate: "use_template",
    title: "title",
    category: "category",
    dollarOrPercentage: "dollar_or_percentage",
    discount: "discount",
    minimum: "minimum",
    priority: "priority",
    combinable: "combinable",
    availableQuota: "available_quota",
    applyToAllGroupBuy: "apply_to_all_group_buy",
    couponUsedTotal: "coupon_used_total",
    couponAvailableTotal: "coupon_available_total",
    active: "is_active",
    couponSettings: "coupon_settings",
    "couponSettings.maxDiscount": "coupon_settings.maxDiscount",
    "couponSettings.customerOnly": "coupon_settings.customerOnly",
    "couponSettings.royaltyProgramId": "coupon_settings.royaltyProgramId",
    "couponSettings.redeemNumber": "coupon_settings.redeemNumber",
    "couponSettings.royaltyProgramId[]": "coupon_settings.royaltyProgramId",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
