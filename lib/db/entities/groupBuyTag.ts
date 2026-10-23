import type { EntityDef } from "../entity-types";

// 團購標籤（GroupBuyTag ＝ 進階設定範本；/backend/GroupBuyTag/list）
// 表：groupbuy.group_buy_tags
// 原站頁面：groupbuytag-list
export const groupBuyTag: EntityDef = {
  table: "group_buy_tags",
  idKey: "groupBuyTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyTagId: "id",
    tag: "tag",
    category: "category",
    groupBuyId: "group_buy_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
