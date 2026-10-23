import type { EntityDef } from "../entity-types";

// 團購 × 關鍵字標籤 關聯（addTag/removeTag/addBatchTagging/getAssociatedGroupBuys）
// 表：groupbuy.group_buy_sys_tags
export const groupBuySysTag: EntityDef = {
  table: "group_buy_sys_tags",
  idKey: "groupBuySysTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuySysTagId: "id",
    groupBuyId: "group_buy_id",
    groupBuySysTagRefId: "group_buy_sys_tag_ref_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
