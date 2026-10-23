import type { EntityDef } from "../entity-types";

// 商品系統標籤（GroupBuyItemSysTag）
// 表：groupbuy.group_buy_item_sys_tags
// 原站頁面：groupbuyitemsystag-list
export const groupBuyItemSysTag: EntityDef = {
  table: "group_buy_item_sys_tags",
  idKey: "groupBuyItemSysTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemSysTagId: "id",
    groupBuyId: "group_buy_id",
    category: "category",
    tag: "tag",
    displayName: "display_name",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
