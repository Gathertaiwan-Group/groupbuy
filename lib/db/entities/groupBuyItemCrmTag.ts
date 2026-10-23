import type { EntityDef } from "../entity-types";

// 商品銷售標籤（GroupBuyItemCrmTag）
// 表：groupbuy.group_buy_item_crm_tags
// 原站頁面：groupbuyitemcrmtag-list
export const groupBuyItemCrmTag: EntityDef = {
  table: "group_buy_item_crm_tags",
  idKey: "groupBuyItemCrmTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemCrmTagId: "id",
    groupBuyId: "group_buy_id",
    tag: "tag",
    weight: "weight",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
