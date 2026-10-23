import type { EntityDef } from "../entity-types";

// 倉庫 × 商品 庫存
// 表：groupbuy.warehouse_stocks
export const warehouseStock: EntityDef = {
  table: "warehouse_stocks",
  idKey: "warehouseStockId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseStockId: "id",
    warehouseId: "warehouse_id",
    itemId: "item_id",
    quantity: "quantity",
    rackBin: "rack_bin",
    dateModified: "updated_at",
    groupBuyAccountId: "tenant_id",
    dateModifiedString: "updated_at",
  },
};
