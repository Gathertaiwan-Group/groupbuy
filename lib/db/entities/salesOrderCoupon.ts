import type { EntityDef } from "../entity-types";

// 訂單使用的優惠卷（salesOrderCoupons[]：coupon/discount）
// 表：groupbuy.sales_order_coupons
export const salesOrderCoupon: EntityDef = {
  table: "sales_order_coupons",
  idKey: "salesOrderCouponId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderCouponId: "id",
    salesOrderId: "sales_order_id",
    groupBuyCouponId: "group_buy_coupon_id",
    couponCodeId: "coupon_code_id",
    coupon: "coupon",
    discount: "discount",
    points: "points",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
