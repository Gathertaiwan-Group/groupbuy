import type { EntityDef } from "../entity-types";

// 保留單商品列表（唯讀檢視 sales_order_reservation_items_v；/ajax/SalesOrderReservation/listItem）
// 表：groupbuy.sales_order_reservation_items_v
export const salesOrderReservationItem: EntityDef = {
  table: "sales_order_reservation_items_v",
  idKey: "orderItemId",
  idColumn: "order_item_id",
  tenantScoped: true,
  fields: {
    orderItemId: "order_item_id",
    relationId: "relation_id",
    salesOrderId: "sales_order_id",
    uuid: "uuid",
    groupBuyId: "group_buy_id",
    itemId: "item_id",
    title: "title",
    uid: "uid",
    total: "total",
    salesName: "sales_name",
    targetName: "target_name",
    daysReserved: "days_reserved",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
