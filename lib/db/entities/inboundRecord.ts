import type { EntityDef } from "../entity-types";

// 入庫紀錄（InboundRecord）
// 表：groupbuy.inbound_records
// 原站頁面：inboundrecord-list
export const inboundRecord: EntityDef = {
  table: "inbound_records",
  idKey: "inboundRecordId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    inboundRecordId: "id",
    warehouseId: "warehouse_id",
    inboundId: "inbound_id",
    itemId: "item_id",
    title: "title",
    uid: "uid",
    dateInboundString: "date_inbound",
    unitPrice: "unit_price",
    quantity: "quantity",
    quantityRemaining: "quantity_remaining",
    dateLastSaleString: "date_last_sale",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
