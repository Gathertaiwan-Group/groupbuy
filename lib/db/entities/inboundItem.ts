import type { EntityDef } from "../entity-types";

// 入庫商品（InboundItem）
// 表：groupbuy.inbound_items
export const inboundItem: EntityDef = {
  table: "inbound_items",
  idKey: "inboundItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    inboundItemId: "id",
    inboundId: "inbound_id",
    itemId: "item_id",
    salesOrderId: "sales_order_id",
    uid: "uid",
    title: "title",
    quantity: "quantity",
    unitPrice: "unit_price",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
