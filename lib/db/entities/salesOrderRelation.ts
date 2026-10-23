import type { EntityDef } from "../entity-types";

// 訂單關聯（SalesOrderRelation：保留單 Editor idSrc=relationId、退換補、拆單、合併、補款、訂閱）
// 表：groupbuy.sales_order_relations
// 原站頁面：salesorderreservation-list
export const salesOrderRelation: EntityDef = {
  table: "sales_order_relations",
  idKey: "relationId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    relationId: "id",
    parentSalesOrderId: "parent_sales_order_id",
    salesOrderId: "sales_order_id",
    relation: "relation",
    salesName: "sales_name",
    targetName: "target_name",
    datePaymentDueString: "date_payment_due",
    staffNote: "staff_note",
    mode: "mode",
    done: "is_done",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
