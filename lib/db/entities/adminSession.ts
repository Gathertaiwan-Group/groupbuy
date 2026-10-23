import type { EntityDef } from "../entity-types";

// 後台登入 session（id = token 的 sha256 hex）
// 表：groupbuy.admin_sessions
export const adminSession: EntityDef = {
  table: "admin_sessions",
  idKey: "adminSessionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    adminSessionId: "id",
    adminUserId: "admin_user_id",
    dateExpires: "expires_at",
    userAgent: "user_agent",
    ip: "ip",
    dateCreated: "created_at",
    groupBuyAccountId: "tenant_id",
    dateCreatedString: "created_at",
  },
};
