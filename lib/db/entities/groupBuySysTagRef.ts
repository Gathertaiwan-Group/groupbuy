import type { EntityDef } from "../entity-types";

// 團購關鍵字標籤字典（GroupBuySysTagRef；所有團購列表「新增標籤」亦用此字典）
// 表：groupbuy.group_buy_sys_tag_refs
// 原站頁面：groupbuysystagref-list
export const groupBuySysTagRef: EntityDef = {
  table: "group_buy_sys_tag_refs",
  idKey: "groupBuySysTagRefId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuySysTagRefId: "id",
    tag: "tag",
    groupBuyCount: "group_buy_count",
    usageCount: "usage_count",
    filterUsageCount: "filter_usage_count",
    dateLastUsedString: "last_used_at",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
