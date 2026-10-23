import type { EntityDef } from "../entity-types";

// 商品 × 銷售標籤
// 表：groupbuy.item_crm_tags
export const itemCrmTag: EntityDef = {
  table: "item_crm_tags",
  idKey: "itemCrmTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemCrmTagId: "id",
    groupBuyItemCrmTagId: "group_buy_item_crm_tag_id",
    itemId: "item_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
