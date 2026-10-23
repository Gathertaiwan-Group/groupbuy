import type { EntityDef } from "../entity-types";

// 訂單套用的優惠條件
// 表：groupbuy.sales_order_sales_rules
export const salesOrderSalesRule: EntityDef = {
  table: "sales_order_sales_rules",
  idKey: "salesOrderSalesRuleId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderSalesRuleId: "id",
    salesOrderId: "sales_order_id",
    salesRuleId: "sales_rule_id",
    title: "title",
    discount: "discount",
    points: "points",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
