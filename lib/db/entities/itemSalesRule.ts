import type { EntityDef } from "../entity-types";

// 商品 × 優惠條件（itemSalesRules[].salesRuleId）
// 表：groupbuy.item_sales_rules
export const itemSalesRule: EntityDef = {
  table: "item_sales_rules",
  idKey: "itemSalesRuleId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemSalesRuleId: "id",
    itemId: "item_id",
    salesRuleId: "sales_rule_id",
    groupBuyId: "group_buy_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
