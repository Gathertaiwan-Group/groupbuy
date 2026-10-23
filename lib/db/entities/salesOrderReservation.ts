import type { EntityDef } from "../entity-types";

// 保留單列表（唯讀檢視 sales_order_reservations_v；寫入走 salesOrderRelation）
// 表：groupbuy.sales_order_reservations_v
export const salesOrderReservation: EntityDef = {
  table: "sales_order_reservations_v",
  idKey: "relationId",
  idColumn: "relation_id",
  tenantScoped: true,
  fields: {
    relationId: "relation_id",
    relation: "relation",
    salesOrderId: "sales_order_id",
    uuid: "uuid",
    groupBuyId: "group_buy_id",
    groupBuyTitle: "group_buy_title",
    salesName: "sales_name",
    targetName: "target_name",
    datePaymentDueString: "date_payment_due",
    staffNote: "staff_note",
    mode: "mode",
    done: "is_done",
    state: "state",
    status: "status",
    grandTotal: "grand_total",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
