import type { EntityDef } from "../entity-types";

// 銷售通路（DistributionChannel）
// 表：groupbuy.distribution_channels
// 原站頁面：distributionchannel-list
export const distributionChannel: EntityDef = {
  table: "distribution_channels",
  idKey: "distributionChannelId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    distributionChannelId: "id",
    channelType: "channel_type",
    name: "name",
    nameAlias: "name_alias",
    nameShort: "name_short",
    companyName: "company_name",
    companyNameAlias: "company_name_alias",
    companyVatId: "company_vat_id",
    tag: "tag",
    note: "note",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
