import type { EntityDef } from "../entity-types";

// 團購品項的優惠標籤（groupBuyItemSetSalesRuleTags[]）
// 表：groupbuy.group_buy_item_set_sales_rule_tags
export const groupBuyItemSetSalesRuleTag: EntityDef = {
  table: "group_buy_item_set_sales_rule_tags",
  idKey: "groupBuyItemSetSalesRuleTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemSetSalesRuleTagId: "id",
    groupBuyItemSetId: "group_buy_item_set_id",
    tag: "tag",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
