import type { EntityDef } from "../entity-types";

// 團購關鍵字標籤字典（GroupBuySysTagRef）— /backend/GroupBuySysTagRef/list；所有團購列表的「新增標籤」也用此字典
export const groupBuySysTagRef: EntityDef = {
  table: "group_buy_sys_tag_refs",
  idKey: "groupBuySysTagRefId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuySysTagRefId: "id",
    groupBuyAccountId: "tenant_id",
    tag: "tag",
    groupBuyCount: "group_buy_count",
    usageCount: "usage_count",
    filterUsageCount: "filter_usage_count",
    dateLastUsedString: "last_used_at",
    dateCreated: "created_at",
    dateModified: "updated_at",
  },
};
