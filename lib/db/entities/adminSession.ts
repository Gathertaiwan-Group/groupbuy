import type { EntityDef } from "../entity-types";

// 後台登入 session（新系統自有；id = token 的 sha256 hex，原站以 jsessionid cookie 維持）
export const adminSession: EntityDef = {
  table: "admin_sessions",
  idKey: "adminSessionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    adminSessionId: "id",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateExpires: "expires_at",
    userAgent: "user_agent",
    ip: "ip",
    dateCreated: "created_at",
  },
};
