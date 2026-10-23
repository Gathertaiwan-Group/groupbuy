import type { EntityDef } from "../entity-types";

// 商品的優惠標籤（itemSalesRuleTags[]）
// 表：groupbuy.item_sales_rule_tags
export const itemSalesRuleTag: EntityDef = {
  table: "item_sales_rule_tags",
  idKey: "itemSalesRuleTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemSalesRuleTagId: "id",
    itemId: "item_id",
    tag: "tag",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
