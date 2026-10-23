import type { EntityDef } from "../entity-types";

// 黑名單（/backend/Blacklist/list）
// 表：groupbuy.blacklists
// 原站頁面：blacklist-list
export const blacklist: EntityDef = {
  table: "blacklists",
  idKey: "blacklistId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    blacklistId: "id",
    type: "type",
    firstname: "firstname",
    email: "email",
    telephone: "telephone",
    ip: "ip",
    note: "note",
    log: "log",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
