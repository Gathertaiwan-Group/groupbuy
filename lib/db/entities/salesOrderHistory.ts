import type { EntityDef } from "../entity-types";

// 訂單狀態歷程（觸發器自動記錄 state/status/action 變更）
// 表：groupbuy.sales_order_histories
export const salesOrderHistory: EntityDef = {
  table: "sales_order_histories",
  idKey: "salesOrderHistoryId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderHistoryId: "id",
    salesOrderId: "sales_order_id",
    stateFrom: "state_from",
    stateTo: "state_to",
    statusFrom: "status_from",
    statusTo: "status_to",
    action: "action",
    actor: "actor",
    note: "note",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
