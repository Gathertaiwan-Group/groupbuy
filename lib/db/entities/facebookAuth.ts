import type { EntityDef } from "../entity-types";

// Facebook 身分（訂單 customerFacebook、報表授權 facebookAuth、FB 快速登入）
// 表：groupbuy.facebook_auths
export const facebookAuth: EntityDef = {
  table: "facebook_auths",
  idKey: "facebookAuthId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    facebookAuthId: "id",
    customerId: "customer_id",
    facebookId: "facebook_id",
    name: "name",
    email: "email",
    pictureUrl: "picture_url",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
