import type { EntityDef } from "../entity-types";

// 盤點商品
// 表：groupbuy.warehouse_inventory_items
export const warehouseInventoryItem: EntityDef = {
  table: "warehouse_inventory_items",
  idKey: "warehouseInventoryItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseInventoryItemId: "id",
    warehouseInventoryId: "warehouse_inventory_id",
    itemId: "item_id",
    uid: "uid",
    title: "title",
    systemQuantity: "system_quantity",
    countedQuantity: "counted_quantity",
    difference: "difference",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
