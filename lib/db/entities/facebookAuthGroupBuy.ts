import type { EntityDef } from "../entity-types";

// 報表授權（FacebookAuthGroupBuy）
// 表：groupbuy.facebook_auth_group_buys
// 原站頁面：facebookauthgroupbuy-list
export const facebookAuthGroupBuy: EntityDef = {
  table: "facebook_auth_group_buys",
  idKey: "facebookAuthGroupBuyId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    facebookAuthGroupBuyId: "id",
    groupBuyId: "group_buy_id",
    facebookAuthId: "facebook_auth_id",
    role: "role",
    status: "status",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
