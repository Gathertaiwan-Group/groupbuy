import type { EntityDef } from "../entity-types";

// 退換貨訂單列表（唯讀檢視 sales_order_returns_v；寫入走 salesOrder / salesOrderRelation）
// 表：groupbuy.sales_order_returns_v
// 原站頁面：salesorderreturn-list
export const salesOrderReturn: EntityDef = {
  table: "sales_order_returns_v",
  idKey: "relationId",
  idColumn: "relation_id",
  tenantScoped: true,
  fields: {
    relationId: "relation_id",
    relation: "relation",
    parentSalesOrderId: "parent_sales_order_id",
    parentUuid: "parent_uuid",
    salesOrderId: "sales_order_id",
    uuid: "uuid",
    groupBuyId: "group_buy_id",
    firstname: "firstname",
    telephone: "telephone",
    state: "state",
    status: "status",
    grandTotal: "grand_total",
    totalPaid: "total_paid",
    staffNote: "staff_note",
    done: "is_done",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
