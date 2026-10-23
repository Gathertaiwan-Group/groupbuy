import type { EntityDef } from "../entity-types";

// 入庫單（Inbound）
// 表：groupbuy.inbounds
// 原站頁面：inbound-list
export const inbound: EntityDef = {
  table: "inbounds",
  idKey: "inboundId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    inboundId: "id",
    warehouseId: "warehouse_id",
    dateRequiredString: "date_required",
    status: "status",
    requester: "requester",
    note: "note",
    dateReceivedString: "date_received",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
