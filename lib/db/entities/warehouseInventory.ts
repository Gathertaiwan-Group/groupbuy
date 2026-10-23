import type { EntityDef } from "../entity-types";

// 盤點單（/backend/Warehouse/inventory）
// 表：groupbuy.warehouse_inventories
// 原站頁面：warehouse-inventory
export const warehouseInventory: EntityDef = {
  table: "warehouse_inventories",
  idKey: "warehouseInventoryId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseInventoryId: "id",
    warehouseId: "warehouse_id",
    groupBuyId: "group_buy_id",
    title: "title",
    status: "status",
    note: "note",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
