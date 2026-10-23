import type { EntityDef } from "../entity-types";

// 團購標籤（GroupBuyTag，＝進階設定範本）— /backend/GroupBuyTag/list
export const groupBuyTag: EntityDef = {
  table: "group_buy_tags",
  idKey: "groupBuyTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyTagId: "id",
    groupBuyAccountId: "tenant_id",
    tag: "tag",
    category: "category",
    groupBuyId: "group_buy_id",
    dateCreated: "created_at",
    dateModified: "updated_at",
  },
};
