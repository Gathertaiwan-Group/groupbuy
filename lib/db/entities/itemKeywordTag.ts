import type { EntityDef } from "../entity-types";

// 商品關鍵字標籤（ItemKeywordTag）
// 表：groupbuy.item_keyword_tags
export const itemKeywordTag: EntityDef = {
  table: "item_keyword_tags",
  idKey: "itemKeywordTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemKeywordTagId: "id",
    groupBuyId: "group_buy_id",
    itemId: "item_id",
    tag: "tag",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
