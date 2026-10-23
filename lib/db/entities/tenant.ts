import type { EntityDef } from "../entity-types";

// 租戶（原站 GroupBuyAccount；路徑前綴 /{groupBuyAccount}，如 guest_ep）
export const tenant: EntityDef = {
  table: "tenants",
  idKey: "groupBuyAccountId",
  idColumn: "id",
  tenantScoped: false,
  fields: {
    groupBuyAccountId: "id",
    groupBuyAccount: "code",
    name: "name",
    dateCreated: "created_at",
  },
};
