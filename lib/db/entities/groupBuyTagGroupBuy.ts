import type { EntityDef } from "../entity-types";

// 團購 × 團購標籤（套用設定範本；/ajax/GroupBuyTagGroupBuy/save|delete）
// 表：groupbuy.group_buy_tag_group_buys
export const groupBuyTagGroupBuy: EntityDef = {
  table: "group_buy_tag_group_buys",
  idKey: "groupBuyTagGroupBuyId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyTagGroupBuyId: "id",
    groupBuyTagId: "group_buy_tag_id",
    groupBuyId: "group_buy_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
