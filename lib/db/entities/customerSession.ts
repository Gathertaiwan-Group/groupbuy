import type { EntityDef } from "../entity-types";

// 前台會員 session（id = token 的 sha256 hex）
// 表：groupbuy.customer_sessions
export const customerSession: EntityDef = {
  table: "customer_sessions",
  idKey: "customerSessionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    customerSessionId: "id",
    customerId: "customer_id",
    dateExpires: "expires_at",
    userAgent: "user_agent",
    ip: "ip",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
