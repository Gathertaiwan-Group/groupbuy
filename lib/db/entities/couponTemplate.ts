import type { EntityDef } from "../entity-types";

// 優惠卷樣板（/backend/CouponTemplate/list）
// 表：groupbuy.coupon_templates
// 原站頁面：coupontemplate-list
export const couponTemplate: EntityDef = {
  table: "coupon_templates",
  idKey: "couponTemplateId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    couponTemplateId: "id",
    title: "title",
    category: "category",
    dollarOrPercentage: "dollar_or_percentage",
    discount: "discount",
    minimum: "minimum",
    priority: "priority",
    maxApplyTimes: "max_apply_times",
    availableQuota: "available_quota",
    combinable: "combinable",
    couponSettings: "coupon_settings",
    "couponSettings.maxDiscount": "coupon_settings.maxDiscount",
    "couponSettings.customerOnly": "coupon_settings.customerOnly",
    "couponSettings.royaltyProgramId": "coupon_settings.royaltyProgramId",
    "couponSettings.redeemNumber": "coupon_settings.redeemNumber",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
