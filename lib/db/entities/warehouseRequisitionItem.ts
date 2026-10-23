import type { EntityDef } from "../entity-types";

// 調撥商品
// 表：groupbuy.warehouse_requisition_items
export const warehouseRequisitionItem: EntityDef = {
  table: "warehouse_requisition_items",
  idKey: "warehouseRequisitionItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseRequisitionItemId: "id",
    warehouseRequisitionId: "warehouse_requisition_id",
    itemId: "item_id",
    uid: "uid",
    title: "title",
    quantity: "quantity",
    transferredQuantity: "transferred_quantity",
    cost: "cost",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
