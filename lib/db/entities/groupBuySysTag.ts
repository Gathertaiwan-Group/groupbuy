import type { EntityDef } from "../entity-types";

// 團購 × 關鍵字標籤 關聯（GroupBuySysTag：addTag/removeTag/addBatchTagging/getAssociatedGroupBuys）
export const groupBuySysTag: EntityDef = {
  table: "group_buy_sys_tags",
  idKey: "groupBuySysTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuySysTagId: "id",
    groupBuyAccountId: "tenant_id",
    groupBuyId: "group_buy_id",
    groupBuySysTagRefId: "group_buy_sys_tag_ref_id",
    dateCreated: "created_at",
  },
};
