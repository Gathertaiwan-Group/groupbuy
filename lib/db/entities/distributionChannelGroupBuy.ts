import type { EntityDef } from "../entity-types";

// 通路 × 團購（結案階段）
// 表：groupbuy.distribution_channel_group_buys
// 原站頁面：distributionchannelgroupbuy-list
export const distributionChannelGroupBuy: EntityDef = {
  table: "distribution_channel_group_buys",
  idKey: "distributionChannelGroupBuyId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    distributionChannelGroupBuyId: "id",
    distributionChannelId: "distribution_channel_id",
    groupBuyId: "group_buy_id",
    state: "state",
    revenue: "revenue",
    note: "note",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
