import type { EntityDef } from "../entity-types";

// 預購轉現貨 / 增加庫存 紀錄（PreorderToStock）
// 表：groupbuy.preorder_to_stock_logs
// 原站頁面：preordertostock-list
export const preorderToStockLog: EntityDef = {
  table: "preorder_to_stock_logs",
  idKey: "preorderToStockLogId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    preorderToStockLogId: "id",
    groupBuyId: "group_buy_id",
    itemId: "item_id",
    salesOrderId: "sales_order_id",
    orderItemId: "order_item_id",
    type: "type",
    quantity: "quantity",
    orderBy: "order_by",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
