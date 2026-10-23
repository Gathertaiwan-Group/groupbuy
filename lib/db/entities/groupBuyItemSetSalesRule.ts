import type { EntityDef } from "../entity-types";

// 團購品項 × 優惠條件（groupBuyItemSetSalesRules[].salesRuleId）
// 表：groupbuy.group_buy_item_set_sales_rules
export const groupBuyItemSetSalesRule: EntityDef = {
  table: "group_buy_item_set_sales_rules",
  idKey: "groupBuyItemSetSalesRuleId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemSetSalesRuleId: "id",
    groupBuyItemSetId: "group_buy_item_set_id",
    salesRuleId: "sales_rule_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
