import type { EntityDef } from "../entity-types";

// 折扣碼（/backend/GroupBuyCoupon/generate）
// 表：groupbuy.coupon_codes
export const couponCode: EntityDef = {
  table: "coupon_codes",
  idKey: "couponCodeId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    couponCodeId: "id",
    groupBuyCouponId: "group_buy_coupon_id",
    code: "code",
    customerId: "customer_id",
    maxUses: "max_uses",
    usedCount: "used_count",
    active: "is_active",
    dateUsedString: "date_used",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
