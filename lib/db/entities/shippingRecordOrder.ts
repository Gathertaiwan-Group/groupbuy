import type { EntityDef } from "../entity-types";

// 出貨批次內的訂單
// 表：groupbuy.shipping_record_orders
export const shippingRecordOrder: EntityDef = {
  table: "shipping_record_orders",
  idKey: "shippingRecordOrderId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shippingRecordOrderId: "id",
    shippingRecordId: "shipping_record_id",
    salesOrderId: "sales_order_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
